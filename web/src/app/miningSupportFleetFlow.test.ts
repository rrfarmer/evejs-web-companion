import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { decodeFleetCenter } from "../bridge/fleetCenter.ts";
import type { JsonValue } from "../bridge/wire.ts";

function fixture() {
  const store = createClientStore();
  const flow = createAppFlow(store, { livePush: false, fetch: () => { throw new Error("Unexpected request"); } });
  store.apply({ type: "character/online", character: { characterID: 1, characterName: "Support", stationID: null,
    structureID: null, solarSystemID: 30000142, corporationID: null }, station: null });
  function load(fleetID = 700, refreshedAtMs = Date.now()) {
    const keyVal = (entries: JsonValue[][]) => ({ type: "object", args: { type: "dict", entries } });
    const snapshot = decodeFleetCenter({ characterID: 1, fleetID: 999,
      reads: { GetInitState: { result: keyVal([["fleetID", fleetID], ["members", { type: "dict", entries: [[1, keyVal([["charID", 1]])]] }]]) } } });
    store.apply({ type: "fleet/loaded", ...snapshot, readError: null, refreshedAtMs });
  }
  return { store, flow, load };
}

test("normal loaded fleet seam uses own identity, receipt time, supplied scope and fresh join facts", () => {
  const f = fixture();
  assert.equal(f.flow.readMiningSupportFleet("run-A"), null);
  f.load(700, 123);
  const first = f.flow.readMiningSupportFleet("run-A")!;
  assert.equal(first.scope.characterID, 1);
  assert.equal(first.scope.sessionEpoch, "run-A");
  assert.equal(first.receivedAtMs, 123);
  assert.equal(first.snapshot.fleet.initState.value.fleetID, 700);
  assert.deepEqual(first.join, { inviteKnown: false, invite: null, ads: null });
  const join = { inviteKnown: true, invite: null, ads: [] };
  assert.equal(f.flow.readMiningSupportFleet("run-B", join)?.join, join);
  assert.equal(f.flow.readMiningSupportFleet("") , null);
  f.store.apply({ type: "character/offline" });
  assert.equal(f.flow.readMiningSupportFleet("run-A"), null);
});
