"use strict";

// Keep WC's copy of the game-port codec identical to the stock one.
//
// src/gameProtocol/ is a copy of the marshal codec the eve.js server itself
// uses. Its wire behavior is copied so that what src/gameClient.js writes and
// reads is exactly what the game port does. A copy drifts silently: it missed
// three upstream wire fixes before this script existed.
//
//   node scripts/vendor-marshal.js            report drift, exit 1 if any
//   node scripts/vendor-marshal.js --write    re-copy from the eve.js source
//
// The eve.js source is read only. Like build-bridge-contract, it is found at
// EVEJS_REPO, or beside this repository.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const WEB_ROOT = path.resolve(__dirname, "..");

const VENDORED_FILES = [
  {
    source: "server/src/network/tcp/utils/marshal.js",
    target: "src/gameProtocol/marshal.js",
    rewrites: [
      [
        'path.join(__dirname, "../../../common/marshalStringTable")',
        'path.join(__dirname, "marshalStringTable")',
      ],
      // Native row descriptors restore their saved numeric slot metadata.
      ["  getDecodedNumberKind,", "  getDecodedNumberKind,\n  setDecodedNumberKind,"],
    ],
    header: (commit) => [
      `// VENDORED from the eve.js server (server/src/network/tcp/utils/marshal.js at`,
      `// eve.js ${commit}, AGPL-3.0-only, same developers), with the local string-table`,
      `// path and decoded-number export. It is the codec the game port itself speaks;`,
      `// src/gameClient.js uses it to talk to the server the way the retail client`,
      `// does. Do not edit it: re-copy with \`npm run vendor:marshal -- --write\`.`,
    ],
  },
  {
    source: "server/src/common/marshalStringTable.js",
    target: "src/gameProtocol/marshalStringTable.js",
    rewrites: [],
    header: (commit) => [
      `// VENDORED from the eve.js server (server/src/common/marshalStringTable.js at`,
      `// eve.js ${commit}, AGPL-3.0-only, same developers), unchanged. Do not edit`,
      `// it: re-copy with \`npm run vendor:marshal -- --write\`.`,
    ],
  },
];

function eveRoot(env = process.env) {
  return path.resolve(env.EVEJS_REPO || path.join(WEB_ROOT, "..", "eve.js"));
}

const withoutCarriageReturns = (text) => text.replace(/\r\n/g, "\n");

/** The body WC's copy must carry: the source with its rewrites applied. */
function vendoredBody(file, sourceText, files = VENDORED_FILES) {
  let body = sourceText;
  for (const [from, to] of file.rewrites) {
    const parts = body.split(from);
    if (parts.length !== 2) {
      throw new Error(
        `${file.source}: expected exactly one "${from}" to rewrite, found ${parts.length - 1}. ` +
          "The upstream file changed shape; update scripts/vendor-marshal.js.",
      );
    }
    body = parts.join(to);
  }
  // A new upstream dependency would be copied as a broken require. Refuse it
  // here, where the message can say what happened. Upstream requires local
  // files both ways: require("./x") and require(path.join(__dirname, "x")).
  const copied = new Set(files.map((entry) => path.basename(entry.target, ".js")));
  const local = [
    ...[...body.matchAll(/require\(\s*["'](\.[^"']*)["']\s*\)/g)].map((match) => match[1]),
    ...[...body.matchAll(/path\.join\(\s*__dirname\s*,\s*["']([^"']+)["']/g)].map((match) => match[1]),
  ];
  for (const specifier of local) {
    if (!copied.has(specifier.replace(/^\.\//, "").replace(/\.js$/, ""))) {
      throw new Error(`${file.source} now requires "${specifier}", which is not vendored.`);
    }
  }
  return body;
}

/**
 * True when `targetText` is `body` under a comment-only header. Line endings
 * are ignored: the same commit checks out as CRLF or LF.
 */
function isCurrent(targetText, body) {
  const target = withoutCarriageReturns(targetText);
  const expected = withoutCarriageReturns(body);
  if (!target.endsWith(expected)) return false;
  const header = target.slice(0, target.length - expected.length);
  return header.split("\n").every((line) => line === "" || line.startsWith("//"));
}

function git(root, args) {
  return childProcess.execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** The commit that last changed `source`, or a refusal if it has local edits. */
function sourceCommit(root, source) {
  let commit;
  try {
    if (git(root, ["status", "--porcelain", "--", source]) !== "") {
      throw new Error(`${source} has uncommitted changes in ${root}; vendor from a committed source.`);
    }
    commit = git(root, ["log", "-1", "--format=%h", "--", source]);
  } catch (error) {
    if (/uncommitted changes/.test(error.message)) throw error;
    commit = "";
  }
  return commit || "an unrecorded commit";
}

function readSource(root, file) {
  const sourcePath = path.join(root, file.source);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`The eve.js source was not found at ${sourcePath}`);
  }
  return fs.readFileSync(sourcePath, "utf8");
}

/** The vendored files that no longer match `root`. Empty means in step. */
function findDrift({ root = eveRoot(), webRoot = WEB_ROOT, files = VENDORED_FILES } = {}) {
  const drifted = [];
  for (const file of files) {
    const body = vendoredBody(file, readSource(root, file), files);
    const targetPath = path.join(webRoot, file.target);
    const target = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
    if (!isCurrent(target, body)) drifted.push(file.target);
  }
  return drifted;
}

function writeVendored({ root = eveRoot(), webRoot = WEB_ROOT, files = VENDORED_FILES } = {}) {
  const written = [];
  for (const file of files) {
    const body = vendoredBody(file, readSource(root, file), files);
    const eol = body.includes("\r\n") ? "\r\n" : "\n";
    const header = file.header(sourceCommit(root, file.source)).join(eol);
    const targetPath = path.join(webRoot, file.target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${header}${eol}${body}`, "utf8");
    written.push(file.target);
  }
  return written;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--write")) {
    for (const target of writeVendored()) console.log(`Wrote ${target}`);
    return;
  }
  const drifted = findDrift();
  if (drifted.length === 0) {
    console.log(`The vendored game-port codec matches ${eveRoot()}.`);
    return;
  }
  for (const target of drifted) console.error(`${target} differs from the eve.js source.`);
  console.error("Re-copy with: npm run vendor:marshal -- --write");
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { VENDORED_FILES, eveRoot, findDrift, isCurrent, vendoredBody, writeVendored };
