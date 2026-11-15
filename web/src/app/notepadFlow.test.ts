import assert from "node:assert/strict";
import test from "node:test";
import { createAppFlow } from "./flow.ts";
import type { BridgeCallRequestBody } from "../bridge/wire.ts";
import { createClientStore } from "../store/clientStore.ts";

test("character-linked Notepad notes use the held pilot's GetNote and SetNote calls", async () => {
  const calls: BridgeCallRequestBody[] = [];
  const markup = "Rendez-vous à Jita<br>探査";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "/api/bridge/call");
    const body = JSON.parse(String(init?.body)) as BridgeCallRequestBody;
    calls.push(body);
    const result = body.method === "GetNote" ? { type: "wstring", value: markup } : null;
    return new Response(JSON.stringify({ ok: true, service: body.service, method: body.method, result }),
      { headers: { "content-type": "application/json" } });
  };
  const flow = createAppFlow(createClientStore(), { fetch });
  const target = 140_000_002;
  assert.equal(await flow.notepadCharacterNote(target), markup);
  await flow.notepadSetCharacterNote(target, markup);
  await flow.notepadSetCharacterNote(target, "");
  assert.deepEqual(calls.map(({ service, method, args, pilot, confirm }) => [service, method, args, pilot, confirm === true]), [
    ["charMgr", "GetNote", [target], true, false],
    ["charMgr", "SetNote", [target, { type: "wstring", value: markup }], true, true],
    ["charMgr", "SetNote", [target, ""], true, true],
  ]);
});
