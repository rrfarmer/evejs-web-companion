"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createClientRowDescriptor } = require("../src/gamePort/clientRowDescriptor");
const { parsePacket } = require("../src/gamePort/packets");
const { readNotification } = require("../src/gamePort/session");
const { getDecodedNumberKind, marshalDecode } = require("../src/gameProtocol/marshal");
const { frames } = require("./fixtures/dogmaFlight.json");

// A native descriptor can stay alive after the JS wrapper disappears.
function standInRuntime() {
  const natives = new WeakMap();
  const callable = call => ({ call });
  const namespace = members => ({ getAttr: name => members[name] });
  const ignore = callable(() => {});
  function wrap(native) {
    const wrapper = {
      getAttr: name => name === "__setstate__" ? ignore : { scalar: native.get(name) },
      setAttr: (name, value) => native.set(name, value),
    };
    natives.set(wrapper, native);
    return wrapper;
  }
  const builtins = namespace({
    list: callable(() => namespace({ append: ignore })),
    tuple: callable(list => list),
    object: callable(() => ({})),
    getattr: callable((wrapper, key, fallback) => natives.get(wrapper).get(String(key)) ?? fallback),
  });
  const descriptorModule = callable(() => namespace({
    Descriptor: callable(() => wrap(new Map())),
    Singleton: ignore,
    StackSize: ignore,
  }));
  const globals = { __builtin__: builtins, _client_prefs_io: namespace({}), _create_row_descriptor_protocol: descriptorModule };
  const values = { global: name => globals[name], bytes: Buffer.from, int: Number, long: BigInt, float: Number, bool: Boolean };
  return { provider: { ready: async () => ({ values }) }, nativeOf: wrapper => natives.get(wrapper), wrap };
}

function decodeHeader() {
  const { hex } = frames[49];
  const payload = Buffer.alloc(hex.length / 2);
  payload.write(hex, "hex");
  const notice = readNotification(parsePacket(marshalDecode(payload, { preserveNumberKinds: true })));
  assert.equal(notice.method, "OnItemsChanged");
  const row = (notice.args[0].items ?? notice.args[0]).find(value => value.type === "packedrow");
  assert(row.header.header[1][0].some(([name]) => Buffer.isBuffer(name) && name.buffer === payload.buffer));
  return { wire: row.header, backing: payload.buffer };
}

test("inventory descriptor provenance follows native lifetime and survives rewrapping", { skip: !global.gc }, async () => {
  const { provider, nativeOf, wrap } = standInRuntime();
  const descriptors = await createClientRowDescriptor({ provider });
  const witnesses = [];
  function materializeOne() {
    const { wire, backing } = decodeHeader();
    const wrapper = descriptors.materialize(wire);
    witnesses.push([new WeakRef(wrapper), new WeakRef(wire), new WeakRef(backing)]);
    return nativeOf(wrapper);
  }
  let live;
  for (let index = 0; index < 256; index++) live = materializeOne();
  for (let turn = 0; turn < 5; turn++) {
    await new Promise(setImmediate);
    global.gc();
  }
  const alive = [0, 1, 2].map(index => witnesses.filter(refs => refs[index].deref() !== undefined).length);
  assert.deepEqual(alive, [0, 0, 0], "descriptor wrappers, input headers, or backing buffers still retained");

  const wrapper = wrap(live);
  const projected = descriptors.provenance(wrapper);
  const { wire: expected } = decodeHeader();
  assert.deepEqual(projected.wire, expected);
  assert.equal(descriptors.provenance(wrapper), projected);
  const expectedColumns = expected.header[1][0];
  for (const [index, column] of projected.wire.header[1][0].entries()) {
    const kind = getDecodedNumberKind(expectedColumns[index], 1);
    assert(kind);
    assert.deepEqual(getDecodedNumberKind(column, 1), kind);
  }
});
