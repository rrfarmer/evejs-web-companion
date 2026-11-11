// Fleet request paths below ignore only the menu view selector. Native fleetSvc
// GetMembers/GetWings/GetOptions do not open composition/join-request windows;
// that read scope is checked against real game-port frames, not these HTTP fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript } from "../bots/botScript.ts";
import { fittingBody, flightBody, namesBody, SHIP_ID, STRIP_MINER_ITEM_IDS } from "./botFixtures.ts";
import { bridgeLane, MAX_IN_FLIGHT } from "./transport.ts";
import { hostedSupportMotionSettled, retireHostedSelfLock } from "./hostedRecoveryCustody.ts";
import { freshSupportSelfMiningMemory } from "../nav/miningSupportSelfMining.ts";

const doc: BotScript = { format: "evejs-bot-script", version: 1, name: "Patient run", notes: "", home: { entity: "station", id: 60000358, name: "Home", systemName: null },
  interrupts: [], program: [{ id: "wait", kind: "macro", macro: "wait", args: { seconds: { kind: "count", value: 500 } } }] };
function fixture(inSpace = false, withSupport = false) {
  let badFleet = false, refit = false;
  const paths: string[] = [];
  const keyVal = (entries: unknown[][]) => ({ type: "object", args: { type: "dict", entries } });
  const store = createClientStore();
  const flow = createAppFlow(store, { livePush: false, ...(withSupport ? { miningOperationID: "recovery-operation" } : {}), fetch: async (input, init) => {
    const path = String(input).replace(/\?view=menu$/, ""); paths.push(path);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    let result: unknown = { ok: true };
    if (path === "/api/bridge/select") result = { ok: true, character: { characterID: 42, characterName: "Test", stationID: 60000358 }, station: null, droneRecoveryCheckID: "current-check" };
    if (path === "/api/bridge/flight/status") result = flightBody(!inSpace);
    if (path === "/api/bridge/drones") result = { ok: true, inSpace: [], bay: [] };
    if (path === "/api/bridge/space/snapshot") result = { ok: true, space: { inSpace, shipID: SHIP_ID, sampledAtMs: 400,
      ship: { itemID: SHIP_ID, characterID: 42, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, radius: 50, geometryAvailable: true } } };
    if (path === "/api/bridge/fitting") result = fittingBody(refit ? { offline: STRIP_MINER_ITEM_IDS } : {});
    if (path === "/api/bridge/bound-dogma") result = { ok: true, reads: { GetAllInfo: { result: keyVal([["activeShipID", SHIP_ID]]) } } };
    if (path === "/api/names") result = namesBody(body);
    if (path === "/api/bridge/bound-fleet") result = badFleet ? { ok: true, characterID: 42, reads: {} }
      : { ok: true, characterID: 42, reads: { GetInitState: { result: keyVal([["fleetID", 700], ["members", { type: "dict", entries: [[42, keyVal([["charID", 42]])]] }]]) } } };
    if (withSupport && path === "/api/mining-operations/assignment/current") result = { ok: true,
      assignment: { operationID: "recovery-operation", role: "COMMAND", stopRequested: false,
        currentTarget: { targetKey: "belt", state: "ACTIVE", claimedByOperationID: "recovery-operation" } } };
    return new Response(JSON.stringify(result));
  } });
  return { store, flow, paths, failFleet: () => { badFleet = true; }, refit: () => { refit = true; } };
}

test("hosted reselection enables the existing drone gate and resumes the same patient script only after fresh authority", async () => {
  const f = fixture(); await f.flow.selectCharacter(42); await f.flow.startCustomBot(doc);
  await f.flow.suspendHostedSession(); assert.equal(f.store.customBot.get().status, "paused");
  assert.throws(() => f.flow.resumeHostedSession(), /not been verified/);
  await f.flow.selectCharacter(42); await f.flow.verifyHostedSessionRecovery(SHIP_ID);
  assert.ok(f.paths.includes("/api/bridge/drone-recovery/ready"));
  f.flow.resumeHostedSession(); assert.equal(f.store.customBot.get().status, "running"); f.flow.stopCustomBot();
});

for (const withSupport of [false, true]) {
  for (const missing of ["randomUUID", "crypto"] as const) {
    test(`${withSupport ? "support" : "script"} recovery resets run epochs without ${missing}`, async t => {
      const f = fixture(false, withSupport);
      t.after(() => f.flow.stopCustomBot());
      await f.flow.selectCharacter(42);
      const program: BotScript = withSupport ? { ...doc, program: [...doc.program,
        { id: "support", kind: "macro", macro: "mining-support", args: {} }] } : doc;
      await f.flow.startCustomBot(program);
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
      const crypto = missing === "crypto" ? undefined
        : { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: crypto });
      t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
      // Both recovery branches create new identities: support work is rebased,
      // then the script's cached fleet membership epoch is invalidated.
      for (let cycle = 0; cycle < 2; cycle++) {
        await f.flow.suspendHostedSession();
        assert.equal(f.store.customBot.get().status, "paused");
        assert.throws(() => f.flow.resumeHostedSession(), /not been verified/);
        await f.flow.selectCharacter(42);
        await f.flow.verifyHostedSessionRecovery(SHIP_ID);
        f.flow.resumeHostedSession();
        assert.equal(f.store.customBot.get().status, "running");
        assert.equal(f.store.customBot.get().name, doc.name);
      }
      assert.ok(f.paths.includes("/api/bridge/drone-recovery/ready"));
      if (withSupport) assert.ok(f.paths.includes("/api/mining-operations/assignment/current"));
    });
  }
}

test("ordinary fleet read errors and a changed fit cannot validate hosted recovery", async () => {
  for (const failure of ["fleet", "fit"] as const) {
    const f = fixture(); await f.flow.selectCharacter(42); await f.flow.startCustomBot(doc);
    await f.flow.suspendHostedSession(); await f.flow.selectCharacter(42);
    if (failure === "fleet") f.failFleet(); else f.refit();
    await assert.rejects(f.flow.verifyHostedSessionRecovery(SHIP_ID), failure === "fleet" ? /membership is unavailable/ : /fitting.*changed/);
    assert.throws(() => f.flow.resumeHostedSession(), /not been verified/);
    assert.equal(f.store.customBot.get().status, "paused"); f.flow.stopCustomBot();
  }
});

test("fresh recovery geometry uses receipt freshness rather than a wall-clock comparison to simulation time", async () => {
  const f = fixture(true); await f.flow.selectCharacter(42); await f.flow.startCustomBot(doc);
  await f.flow.suspendHostedSession(); await f.flow.selectCharacter(42);
  await f.flow.verifyHostedSessionRecovery(SHIP_ID);
  assert.equal(f.store.space.get().snapshot?.sampledAtMs, 400);
  f.flow.resumeHostedSession(); assert.equal(f.store.customBot.get().status, "running"); f.flow.stopCustomBot();
});

test("a queued surviving-member invite checks ownership at HTTP dispatch, after retirement", async () => {
  const f = fixture(); await f.flow.selectCharacter(42);
  let release!: () => void, current = true, checks = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const occupying = Array.from({ length: MAX_IN_FLIGHT }, () => bridgeLane.run("read", "/occupied", () => gate));
  const before = f.paths.length;
  // (The invitee is a pilot's number: the page asks nothing for what the client takes for no pilot.)
  const invite = f.flow.inviteFleetMember(140000043, () => { checks++; if (!current) throw new Error("The inviter generation retired."); });
  assert.equal(bridgeLane.queued(), 1); current = false; release();
  await Promise.all(occupying); await invite;
  // The invitation is the page's own call (bridge/fleetWrites.ts): it was not sent, and nor was its old route.
  assert.deepEqual(f.paths.slice(before).filter((path) => path === "/api/bridge/call" || path === "/api/bridge/fleet/invite"), []);
  assert.equal(checks, 1); assert.ok(f.store.fleet.get().actionError);
});

test("retiring a recovered movement requires physical STOP and both actual mobility permissions", async () => {
  const f = fixture(true); await f.flow.selectCharacter(42); await f.flow.loadSpaceSnapshot();
  const raw = f.store.space.get().snapshot!;
  const scene = { ...raw, ship: { ...raw.ship!, mode: "STOP", motionAvailable: true, velocity: { x: 0, y: 0, z: 0 } } };
  const permission = { verdict: "unrestricted" as const, reasonCode: null, sources: [] };
  const observed = f.flow.readMiningSupportServices();
  const services = { ...observed, sampledAtMs: scene.sampledAtMs, capabilities: { ...observed.capabilities,
    scope: { ...observed.capabilities.scope, shipID: scene.shipID } },
    mobility: { scope: "runtime-action-restrictions" as const, movement: permission, warp: permission } };
  assert.equal(hostedSupportMotionSettled(scene, services), true);
  for (const ship of [{ ...scene.ship, mode: "GOTO" }, { ...scene.ship, motionAvailable: false },
    { ...scene.ship, velocity: { x: 0.6, y: 0, z: 0 } }, { ...scene.ship, velocity: { x: NaN, y: 0, z: 0 } }])
    assert.equal(hostedSupportMotionSettled({ ...scene, ship }, services), false);
  for (const field of ["movement", "warp"] as const)
    assert.equal(hostedSupportMotionSettled(scene, { ...services, mobility: { ...services.mobility,
      [field]: { ...permission, verdict: "restricted" as const } } }), false);
  assert.equal(hostedSupportMotionSettled(scene, { ...services, sampledAtMs: services.sampledAtMs! + 1 }), false);
});

test("quiesced recovery rebases only target-lock intent from readable own targets", () => {
  const memory = { ...freshSupportSelfMiningMemory(), order: { actionID: 1, observations: 2,
    action: { kind: "lock" as const, targetID: 501 } } };
  // A pending old lock may still be absent. This rebases intent, not completion.
  for (const targets of [[], [501], [502, { type: "long", value: "503" }]])
    assert.equal(retireHostedSelfLock(memory, targets).order, null);
  for (const targets of [null, undefined, {}, [0], [501, null], [501, "bad"], [1.5], [Number.MAX_SAFE_INTEGER + 1]])
    assert.equal(retireHostedSelfLock(memory, targets), memory);
  const faulted = { ...memory, fault: "action-unconfirmed" };
  assert.equal(retireHostedSelfLock(faulted, []), faulted);
  for (const kind of ["activate", "deactivate"] as const) {
    const pending = { ...memory, order: { ...memory.order, action: { kind, moduleID: 10, typeID: 20, targetID: 501 } } };
    assert.equal(retireHostedSelfLock(pending, []), pending);
  }
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

test("an old HTTP invitation drain cannot cross hosted recovery even for the same pilot", async () => {
  const store = createClientStore();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const flow = createAppFlow(store, { livePush: false, fetch: async () => {
    await gate;
    return new Response(JSON.stringify({ ok: true, characterID: 42, reads: {},
      notifications: [{ method: "OnFleetInvite", args: [700, 43, "AskJoinFleet", {}] }] }));
  } });
  store.apply({ type: "character/online", character: { characterID: 42, characterName: "Test", stationID: 60000358,
    structureID: null, solarSystemID: 30000142, corporationID: null }, station: null });
  const read = flow.loadFleet();
  await flow.suspendHostedSession(); release(); await read;
  assert.equal(store.fleet.get().pendingInvite, null);
});
