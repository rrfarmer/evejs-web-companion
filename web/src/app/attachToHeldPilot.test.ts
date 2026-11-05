// A flow that takes over a pilot another flow selected: the same pilot online, and no select.
//
// A select takes a pilot out of its fleet, so a plugin's flow coming back after its process restarted must not make one.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow, type HeldPilot } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

const CHARACTER = {
  characterID: 90000001, characterName: "Test", stationID: null,
  structureID: null, solarSystemID: 30000142, corporationID: 98000000,
};

function makeFlow(answer: (path: string) => unknown = () => ({ ok: true })) {
  const asked: { readonly method: string; readonly path: string }[] = [];
  const store = createClientStore();
  const flow = createAppFlow(store, {
    livePush: false,
    perSessionToken: true,
    initialSessionToken: "pilot",
    fetch: async (input, init) => {
      const path = String(input);
      asked.push({ method: String(init?.method ?? "GET"), path });
      return Response.json(answer(path));
    },
  });
  return { asked, store, flow };
}

test("attaching brings the pilot online with no select", async () => {
  const { asked, store, flow } = makeFlow();
  const held = { characterID: CHARACTER.characterID, character: CHARACTER, station: null } as unknown as HeldPilot;
  assert.equal(flow.heldPilot(), null);
  await flow.attachToHeldPilot(held);
  assert.equal(store.station.get().online?.characterID, CHARACTER.characterID);
  assert.deepEqual(flow.heldPilot(), held);
  assert.equal(asked.some((request) => request.path === "/api/bridge/select"), false);
});

test("a select leaves what another flow attaches with", async () => {
  const { flow } = makeFlow((path) => (path === "/api/bridge/select" ? { ok: true, character: CHARACTER, station: null, notifications: [] } : { ok: true }));
  await flow.selectCharacter(CHARACTER.characterID);
  assert.equal(flow.heldPilot()?.characterID, CHARACTER.characterID);
});
