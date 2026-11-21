"use strict";

// The game-port codec in src/gameProtocol/ is a copy of the server's. These
// tests are about the COPY: that it is still the stock one, and that it carries
// the wire behaviour the game client depends on.
//
// The byte strings in the wire tests come from eve.js
// server/tests/marshalBlueWireParity.test.js, where they were checked against
// real Python 2.7 and CCP's blue source. They are a sample, not the full set:
// the full set runs upstream against the file this one is copied from.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { marshalDecodeExact, marshalEncode } = require("../src/gameProtocol/marshal");
const { VENDORED_FILES, findDrift, vendoredBody, writeVendored } = require("../scripts/vendor-marshal");

const stream = (hexBody) => Buffer.from(`7e00000000${hexBody}`, "hex");

// cPickle.dumps(datetime.date(2026, 10, 6), 2) in Python 2.7.
const PYTHON27_DATE_PICKLE = "8002636461746574696d650a646174650a7101550407ea0a06855271022e";

test("the vendored codec matches clean stock eve.js", { skip: !process.env.STOCK_EVEJS_ROOT }, () => {
  assert.deepEqual(findDrift({ root: process.env.STOCK_EVEJS_ROOT }), []);
});

test("a pickle is read up to its own STOP, and the value after it still decodes", () => {
  const [pickle, after] = marshalDecodeExact(stream(`2c21${PYTHON27_DATE_PICKLE}0605`));
  assert.equal(pickle.type, "cpicked");
  assert.equal(pickle.data.toString("hex"), PYTHON27_DATE_PICKLE);
  assert.equal(after, 5);
});

test("a pickle is written straight after its opcode, with no length", () => {
  const encoded = marshalEncode({ type: "cpicked", data: Buffer.from(PYTHON27_DATE_PICKLE, "hex") });
  assert.equal(encoded.toString("hex"), `7e0000000021${PYTHON27_DATE_PICKLE}`);
});

test("a negative Python long from the server decodes as negative", () => {
  for (const [hex, expected] of [
    ["2f01fb", -5],
    ["2f0600f05a2b17ff", -1_000_000_000_000],
    ["2f080000000000000080", -(2n ** 63n)],
    ["2f060010a5d4e800", 1_000_000_000_000],
  ]) {
    assert.equal(marshalDecodeExact(stream(hex)), expected, hex);
  }
});

test("a NULL bool column in a packed row comes back as null, not false", () => {
  const columns = [["count", 0x03], ["flag", 0x0b]];
  const decoded = marshalDecodeExact(marshalEncode({
    type: "packedrow",
    header: {
      type: "objectex1",
      header: [{ type: "token", value: "blue.DBRowDescriptor" }, [columns]],
      list: [],
      dict: [],
    },
    columns,
    values: [7, null],
  }));
  assert.deepEqual(decoded.values, [7, null]);
});

// ── the vendoring script itself ──────────────────────────────────────────────

const CRLF = "\r\n";

function fakeRepos(context, codecLines, eol = "\n") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "wc-vendor-"));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const header = (commit) => [`// VENDORED at ${commit}.`];
  const codec = {
    source: "server/codec.js",
    target: "src/gameProtocol/codec.js",
    rewrites: [['require("../far/table")', 'require("./table")']],
    header,
  };
  const table = { source: "far/table.js", target: "src/gameProtocol/table.js", rewrites: [], header };
  const root = path.join(base, "eve");
  const webRoot = path.join(base, "web");
  const writeSource = (file, lines) => {
    fs.mkdirSync(path.dirname(path.join(root, file.source)), { recursive: true });
    fs.writeFileSync(path.join(root, file.source), lines.map((line) => line + eol).join(""));
  };
  writeSource(codec, codecLines);
  writeSource(table, ["module.exports = [];"]);
  return {
    root, webRoot, files: [codec, table], codec, table, writeSource,
    targetPath: path.join(webRoot, codec.target),
  };
}

test("a fresh copy is in step, and stays in step across a line-ending change", (context) => {
  const repos = fakeRepos(context, ['"use strict";', 'const t = require("../far/table");'], CRLF);
  assert.deepEqual(findDrift(repos), [repos.codec.target, repos.table.target], "a missing copy is drift");
  writeVendored(repos);
  assert.deepEqual(findDrift(repos), []);
  const copy = fs.readFileSync(repos.targetPath, "utf8");
  const lines = copy.split(CRLF);
  assert.match(lines[0], /^\/\/ VENDORED at .+\.$/);
  assert.deepEqual(lines.slice(1), ['"use strict";', 'const t = require("./table");', ""]);
  fs.writeFileSync(repos.targetPath, lines.join("\n"));
  assert.deepEqual(findDrift(repos), []);
});

test("an upstream change or a local edit to the copy is reported as drift", (context) => {
  const repos = fakeRepos(context, ['const t = require("../far/table");', "const a = 1;"]);
  writeVendored(repos);
  const copy = fs.readFileSync(repos.targetPath, "utf8");

  fs.writeFileSync(repos.targetPath, copy.replace("a = 1", "a = 2"));
  assert.deepEqual(findDrift(repos), [repos.codec.target], "an edited copy");

  fs.writeFileSync(repos.targetPath, `const sneaked = 1;\n${copy}`);
  assert.deepEqual(findDrift(repos), [repos.codec.target], "code above the header");

  fs.writeFileSync(repos.targetPath, copy);
  assert.deepEqual(findDrift(repos), []);
  repos.writeSource(repos.codec, ['const t = require("../far/table");', "const a = 3;"]);
  assert.deepEqual(findDrift(repos), [repos.codec.target], "a changed source");
});

test("an upstream file the script no longer understands is refused, not copied broken", () => {
  const [marshal] = VENDORED_FILES;
  assert.throws(
    () => vendoredBody(marshal, '"use strict";\n'),
    /expected exactly one .*marshalStringTable.* found 0/,
  );
  const rewritable = 'require(path.join(__dirname, "../../../common/marshalStringTable"));\nmodule.exports = {\n  getDecodedNumberKind,\n};\n';
  assert.equal(
    vendoredBody(marshal, rewritable),
    'require(path.join(__dirname, "marshalStringTable"));\nmodule.exports = {\n  getDecodedNumberKind,\n  setDecodedNumberKind,\n};\n',
  );
  assert.throws(
    () => vendoredBody(marshal, `${rewritable}require("../logger");\n`),
    /now requires "\.\.\/logger", which is not vendored/,
  );
  assert.throws(
    () => vendoredBody(marshal, `${rewritable}require(path.join(__dirname, "../../utils/logger"));\n`),
    /now requires "\.\.\/\.\.\/utils\/logger", which is not vendored/,
  );
});
