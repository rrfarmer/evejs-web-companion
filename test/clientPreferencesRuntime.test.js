"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { Module } = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { getHeapSpaceStatistics, setFlagsFromString } = require("node:v8");
const { runInNewContext } = require("node:vm");

// `node --test` does not pass --expose-gc to its test processes, so turn it on
// here; a context created after the flag is set carries a gc() function.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc");

// Exercise the real JS owner without preparing an installed client or exposing
// its private factory as part of the runtime API.
const filename = require.resolve("../src/gamePort/clientPreferences");
const privateModule = new Module(filename, module);
privateModule.filename = filename;
privateModule._compile(`${readFileSync(filename, "utf8")}\nmodule.exports.valueRuntime = valueRuntime;`, filename);
const { valueRuntime } = privateModule.exports;

function fakeBinding() {
  let identity = 0n;
  return {
    value(kind, scalar) {
      return { object: { identity: ++identity, kind, value: kind === "long" ? BigInt(scalar) : scalar } };
    },
    identity(handle) { return handle.object.identity; },
    describe(handle) { return handle.object; },
    dispose(handle) { handle.object = null; },
  };
}

test("native value handles preserve identity, disposal, and numeric classes", () => {
  const binding = fakeBinding();
  const values = valueRuntime(binding);
  const payload = binding.value("long", "9007199254740993");
  const original = payload.object;
  const value = values.wrap(payload);
  const duplicate = { object: original };
  assert.equal(values.wrap(duplicate), value);
  assert.equal(duplicate.object, null);
  assert.equal(values.convert(value), value);
  assert.throws(() => valueRuntime(binding).convert(value), TypeError);
  assert.equal(value.scalar, 9007199254740993n);
  assert.equal(value.kind, "long");
  assert.equal(values.int(25).kind, "int");
  assert.equal(values.float(25).kind, "float");
  assert.notEqual(values.long(25n), values.long(25n));

  value.dispose();
  assert.equal(value.disposed, true);
  assert.throws(() => values.convert(value), /A live value/);
  const replacement = values.wrap({ object: original });
  assert.notEqual(replacement, value);
  assert.equal(replacement.identity, value.identity);
});

test("the bootstrap admits archived future packages and supplies their raise_ without a client install", () => {
  execFileSync(process.env.EVEJS_PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-I", "-S", path.join(__dirname, "fixtures", "clientPreferencesArchive.py")], { windowsHide: true });
});

const installedClient = process.env.EVEJS_TEST_CLIENT_ROOT || process.env.EVEJS_TEST_V2402_CLIENT_ROOT;
test("the installed client's CoreService methods share the archive's future.utils.raise_", {
  skip: !installedClient && "Set EVEJS_TEST_CLIENT_ROOT to an installed V24.01 or V24.02 client",
}, () => {
  const { nativePreferencesShipped } = require("../scripts/build-native-preferences");
  const binary = nativePreferencesShipped();
  assert.ok(binary, "The test requires the shipped Windows x64 preferences binding");
  const binding = require(binary);
  const tq = path.resolve(installedClient, "tq");
  const archive = path.join(tq, "code.ccp").replaceAll("\\", "/");
  const bootstrap = readFileSync(path.join(__dirname, "../scripts/native-prefs/bootstrap.py"), "utf8");
  binding.dispose(binding.initialize(path.join(tq, "bin64", "python27.dll"), Buffer.from(archive), bootstrap));
  binding.dispose(binding.run(`
probe_types = _create_static_service_types(None, None, None, 0, 0, 0, 0)
import future.utils
assert future.__file__.replace('\\\\', '/').startswith(_archive + '/')
assert future.utils.__file__.replace('\\\\', '/').startswith(_archive + '/')
for method in ('__init__', 'InitService', '__getattr__', '__setattr__'):
    probe_raise = getattr(probe_types.CoreService, method).im_func.func_globals['raise_']
    assert probe_raise is future.utils.raise_
try:
    probe_raise(ValueError, 'archive probe')
except ValueError as exc:
    assert str(exc) == 'archive probe'
else:
    raise AssertionError('The installed raise_ did not raise')
`));
});

function largeObjectBytes() {
  return getHeapSpaceStatistics().find(space => space.space_name === "large_object_space").space_used_size;
}

async function collect() {
  for (let turn = 0; turn < 5; turn++) {
    await nextTurn();
    gc();
  }
  await nextTurn();
}

test("a fixed native runtime releases handle storage after a peak of short-lived values", async () => {
  const binding = fakeBinding();
  const values = valueRuntime(binding);
  const handle = binding.value("long", "9007199254740993");
  const held = values.wrap(handle);
  await collect();
  const before = largeObjectBytes();
  const witnesses = [];
  for (let index = 0; index < 100000; index++) {
    const value = values.long(9007199254740993n);
    if (index % 10000 === 0) witnesses.push(new WeakRef(value));
  }
  await collect();
  assert(witnesses.every(ref => ref.deref() === undefined));
  assert.equal(values.wrap({ object: handle.object }), held);
  // Allow unrelated V8 allocations while detecting a retained handle table.
  const retained = largeObjectBytes() - before;
  assert(retained < 2 * 1024 * 1024, `${retained} bytes of large object storage remain after GC`);
});
