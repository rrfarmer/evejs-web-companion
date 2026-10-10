import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeContractWriteAck,
  decodeCreateContractAck,
  acceptContract,
  decodeDeleteMultipleContractsAck,
} from "./contractWrites.ts";
import type { Ask } from "./ask.ts";
import type { JsonValue } from "./wire.ts";

// --- R91 contract write acks (Phase-3 WRITES) -------------------------------

/** The ordinary JSON object emitted by the BFF's Express response. */
function plainAck(fields: Record<string, JsonValue>): JsonValue {
  return { ...fields };
}

function contractRow(contractID: number): JsonValue {
  return {
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries: [["contractID", contractID]] },
  } as unknown as JsonValue;
}

test("decodeContractWriteAck reads ok/applied off the BFF envelope", () => {
  const ack = decodeContractWriteAck(plainAck({ ok: true, applied: true, result: null }));
  assert.deepEqual(ack, { ok: true, applied: true });
});

test("decodeContractWriteAck is false for a non-object / unsuccessful response (never throws)", () => {
  assert.deepEqual(decodeContractWriteAck(null as unknown as JsonValue), { ok: false, applied: false });
  assert.deepEqual(decodeContractWriteAck(plainAck({ ok: false, applied: false })), {
    ok: false,
    applied: false,
  });
});

test("decodeCreateContractAck surfaces the new contract id list", () => {
  const result: JsonValue = { type: "list", items: [8100, 8101] } as unknown as JsonValue;
  const ack = decodeCreateContractAck(plainAck({ ok: true, applied: true, result }));
  assert.equal(ack.applied, true);
  assert.deepEqual(ack.contractIDs, [8100, 8101]);
});

test("decodeCreateContractAck yields an empty list when nothing was created", () => {
  const ack = decodeCreateContractAck(plainAck({ ok: true, applied: true, result: null }));
  assert.deepEqual(ack.contractIDs, []);
});

test("a contract is taken on by the contract proxy's own call, with its ID and for whom; the row it answers says which was accepted", async () => {
  const asked: unknown[] = [];
  const act: Ask = async (service, method, args, kwargs) => {
    asked.push([service, method, args, kwargs]);
    return contractRow(8100);
  };
  // contracts.py 422: GetContractProxySvc().AcceptContract(contractID, forCorp), from each of the window's two buttons.
  assert.equal(await acceptContract(act, 8100, false), 8100);
  assert.equal(await acceptContract(act, 8100, true), 8100);
  assert.deepEqual(asked, [["contractProxy", "AcceptContract", [8100, false], undefined], ["contractProxy", "AcceptContract", [8100, true], undefined]]);
  // The row as a packed row, which is how a DBRow comes, reads the same.
  const packed = { type: "packedrow", fields: { contractID: 8101, status: 1 } } as unknown as JsonValue;
  assert.equal(await acceptContract(async () => packed, 8101, false), 8101);
  // Which contract was accepted is the server's word, whatever was asked.
  assert.equal(await acceptContract(async () => contractRow(9000), 8100, false), 9000);
});

test("an answer with no contract in it is a decline, and a refusal is the call's own failure", async () => {
  const noStatus = { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [["status", 1]] } } as unknown as JsonValue;
  for (const none of [null, false, 0, [], { type: "list", items: [] }, contractRow(0), contractRow(-4), noStatus] as JsonValue[]) {
    assert.equal(await acceptContract(async () => none, 8100, false), 0, JSON.stringify(none));
  }
  for (const code of ["CALL_REFUSED", "CUSTOM_INFO", "CALL_NOT_ALLOWED", "NO_LIVE_SESSION", "SESSION_NOT_FOUND"]) {
    const failure = Object.assign(new Error("This contract is not available to accept."), { code });
    await assert.rejects(acceptContract(async () => { throw failure; }, 8100, false), (error) => error === failure, code);
  }
});

test("decodeDeleteMultipleContractsAck splits deleted vs failed", () => {
  const result: JsonValue = {
    type: "list",
    items: [
      { type: "list", items: [8100, 8101] },
      { type: "list", items: [8102] },
    ],
  } as unknown as JsonValue;
  const ack = decodeDeleteMultipleContractsAck(plainAck({ ok: true, applied: true, result }));
  assert.deepEqual(ack.deleted, [8100, 8101]);
  assert.deepEqual(ack.failed, [8102]);
});
