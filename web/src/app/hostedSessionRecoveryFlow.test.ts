import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { bridgeLane, MAX_IN_FLIGHT } from "./transport.ts";

test("a queued fleet invitation checks ownership before dispatch", async () => {
  const store = createClientStore();
  const paths: string[] = [];
  const flow = createAppFlow(store, { livePush: false, fetch: async (input) => {
    paths.push(String(input));
    return Response.json({ ok: true });
  } });
  store.apply({ type: "character/online", character: { characterID: 42, characterName: "Test", stationID: 60000358,
    structureID: null, solarSystemID: 30000142, corporationID: null }, station: null });
  let release!: () => void, current = true, checks = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const occupying = Array.from({ length: MAX_IN_FLIGHT }, () => bridgeLane.run("read", "/occupied", () => gate));
  // (The invitee is a pilot's number: the page asks nothing for what the client takes for no pilot.)
  const invite = flow.inviteFleetMember(140000043, () => { checks++; if (!current) throw new Error("The inviter generation retired."); });
  assert.equal(bridgeLane.queued(), 1); current = false; release();
  await Promise.all(occupying); await invite;
  // The invitation is the page's own call (bridge/fleetWrites.ts): it was not sent, and nor was its old route.
  assert.deepEqual(paths.filter((path) => path === "/api/bridge/call" || path === "/api/bridge/fleet/invite"), []);
  assert.equal(checks, 1); assert.ok(store.fleet.get().actionError);
});

test("HTTP fleet and scene drains deliver invitations without a live stream", async () => {
  for (const read of ["fleet", "scene"] as const) {
    const store = createClientStore();
    let drained = false;
    const flow = createAppFlow(store, { livePush: false, fetch: async () => {
      const notifications = drained ? [] : [{ method: "OnFleetInvite", args: [700, 43, "AskJoinFleet", {}] }];
      drained = true;
      return new Response(JSON.stringify({ ok: true, characterID: 42, reads: {}, space: { inSpace: false }, notifications }));
    } });
    store.apply({ type: "character/online", character: { characterID: 42, characterName: "Test", stationID: 60000358,
      structureID: null, solarSystemID: 30000142, corporationID: null }, station: null });
    await (read === "fleet" ? flow.loadFleet() : flow.loadSpaceSnapshot());
    assert.equal(store.fleet.get().pendingInvite?.fleetID, 700);
    assert.equal(store.fleet.get().pendingInvite?.inviterID, 43);
  }
});
