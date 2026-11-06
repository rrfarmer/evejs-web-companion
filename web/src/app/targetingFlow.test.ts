// The R23 slice A controller against a faked BFF: the GENERIC in-space action
// layer — lock / release a target, switch a module on / off.
//
// Two things are pinned here, and they are the whole point of the slice.
//
// GENERALITY. Nothing in the flow names mining or combat. activateModule takes
// a module and an OPTIONAL effect name; omit it and the page names the module
// type's default effect from the game's data, as the client's button names its
// default effect (since 2026-10-14 the page's own call, bridge/dogmaWrites.ts).
// The same four methods drive a mining laser and a turret, so a later combat goal
// reuses them unchanged. There is a test below that switches on a combat module
// through the identical path.
//
// HONESTY. A 200 is not proof. Every mutation is verified against a server
// re-read, and the flow distinguishes THREE outcomes that a naive client would
// collapse into "it worked":
//   - refused        -> the server's own reason, verbatim
//   - silently declined -> accepted, nothing changed, no reason given, and the
//                       page says exactly that instead of inventing a cause
//   - unknown        -> the verification read could not answer, which is NOT
//                       reported as a decline

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function makeFakeFetch(
  responder: (
    path: string,
    method: string,
    body: Record<string, unknown>,
  ) => { status: number; body: unknown },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method, body });
    const outcome = responder(path, method, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

const ROCK_ID = 50001248;
const MODULE_ID = 7700001;

function snapshotBody(activeModuleIDs: number[] | null): unknown {
  const ship: Record<string, unknown> = { itemID: 9001, typeID: 606, name: "Ibis" };
  if (activeModuleIDs !== null) {
    ship.activeModuleIDs = activeModuleIDs;
  }
  return {
    ok: true,
    space: { inSpace: true, shipID: 9001, entities: [], ship },
    notifications: [],
  };
}

// --- Reading the locks ------------------------------------------------------

test("loadTargets puts the server's locked list in the store", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/targets") {
      return { status: 200, body: { ok: true, targetIDs: [ROCK_ID], notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  assert.equal(store.targeting.get().loaded, false);
  await flow.loadTargets();
  assert.deepEqual(store.targeting.get().lockedTargetIDs, [ROCK_ID]);
  assert.equal(store.targeting.get().loaded, true);
});

test("target IDs decode long-aware — a {type:'long'} wrapper is not zeroed", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({
    status: 200,
    body: { ok: true, targetIDs: [{ type: "long", value: String(ROCK_ID) }], notifications: [] },
  }));
  const flow = createAppFlow(store, { fetch });

  await flow.loadTargets();
  assert.deepEqual(store.targeting.get().lockedTargetIDs, [ROCK_ID]);
});

test("loadTargets swallows a transient read failure — no banner, last locks kept", async () => {
  const store = createClientStore();
  let failNext = false;
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/targets") {
      if (failNext) {
        throw new Error("gateway timeout"); // a transient, non-session-loss failure
      }
      return { status: 200, body: { ok: true, targetIDs: [ROCK_ID], notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
  const flow = createAppFlow(store, { fetch });

  await flow.loadTargets();
  assert.deepEqual(store.targeting.get().lockedTargetIDs, [ROCK_ID]);
  assert.equal(store.targeting.get().actionError, null);

  // The read is best-effort (overview poll / mount). A transient timeout must NOT
  // raise a sticky banner, and must leave the last-known lock list in place.
  failNext = true;
  await flow.loadTargets();
  assert.equal(store.targeting.get().actionError, null, "a best-effort read failure must not surface a banner");
  assert.deepEqual(store.targeting.get().lockedTargetIDs, [ROCK_ID], "last-known locks are kept");
});

// --- Locking ----------------------------------------------------------------
//
// A lock is the page's own call (bridge/targetWrites.ts): dogmaIM.AddTarget, answering whether the lock is still
// being made, and then the page's read of what is locked, which is what it goes by.

/** A BFF that takes the page's own targeting calls: `add` is what AddTarget answers, `locked` what is read as locked after. */
function targetingBff(spec: { add?: () => { status: number; body: unknown }; locked: () => readonly number[] }) {
  return makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/call") {
      if (body.method === "AddTarget" && spec.add) return spec.add();
      return { status: 200, body: { ok: true, service: body.service, method: body.method, result: null, notifications: [] } };
    }
    if (path === "/api/bridge/targets") {
      return { status: 200, body: { ok: true, targetIDs: spec.locked(), notifications: [] } };
    }
    throw new Error(`unexpected ${path}`);
  });
}
const added = (pending: number, locked: readonly number[]) => ({ status: 200, body: { ok: true, service: "dogmaIM", method: "AddTarget", result: [pending, locked], notifications: [] } });
const pageCall = (method: string, targetID: number) => ({ service: "dogmaIM", method, args: [targetID], kwargs: null, pilot: true, confirm: true });
const calls = (requests: readonly Recorded[]) => requests.filter((each) => each.path === "/api/bridge/call").map((each) => each.body);

test("lockTarget makes the page's own call, and lands the server's re-read", async () => {
  const store = createClientStore();
  const { fetch, requests } = targetingBff({ add: () => added(0, [ROCK_ID]), locked: () => [ROCK_ID] });
  const flow = createAppFlow(store, { fetch });

  await flow.lockTarget(ROCK_ID);
  // targetMgr.py 1366: GetDogmaLM().AddTarget(tid), as a pilot's write the page means; and then what is locked, read.
  assert.deepEqual(requests.map((each) => [each.path, each.path === "/api/bridge/call" ? each.body : null]), [["/api/bridge/call", pageCall("AddTarget", ROCK_ID)], ["/api/bridge/targets", null]]);
  const state = store.targeting.get();
  assert.deepEqual(state.lockedTargetIDs, [ROCK_ID]);
  assert.equal(state.lastAction, "Lock");
  assert.equal(state.actionError, null);
  assert.equal(state.silentDecline, null);
});

test("a lock still being ACQUIRED is a success, and is remembered as acquiring", async () => {
  const store = createClientStore();
  const { fetch } = targetingBff({ add: () => added(1, []), locked: () => [] });
  const flow = createAppFlow(store, { fetch });

  await flow.lockTarget(ROCK_ID);
  const state = store.targeting.get();
  assert.deepEqual(state.acquiringTargetIDs, [ROCK_ID]);
  assert.deepEqual(state.lockedTargetIDs, []);
  assert.equal(
    state.silentDecline,
    null,
    "mid-acquisition is progress, not a decline — a lock takes time",
  );
});

test("an acquiring note is retired the moment the server reports the lock landed", async () => {
  const store = createClientStore();
  let landed = false;
  const { fetch } = targetingBff({ add: () => added(1, []), locked: () => (landed ? [ROCK_ID] : []) });
  const flow = createAppFlow(store, { fetch });

  await flow.lockTarget(ROCK_ID);
  assert.deepEqual(store.targeting.get().acquiringTargetIDs, [ROCK_ID]);

  landed = true;
  await flow.loadTargets();
  const state = store.targeting.get();
  assert.deepEqual(state.lockedTargetIDs, [ROCK_ID]);
  assert.deepEqual(state.acquiringTargetIDs, [], "the page must not still say 'Locking…'");
});

test("a lock the server REFUSES surfaces the server's own reason", async () => {
  const store = createClientStore();
  const { fetch, requests } = targetingBff({ add: () => ({ status: 409, body: { ok: false, error: "CALL_REFUSED", message: "TargetTooFar" } }), locked: () => [] });
  const flow = createAppFlow(store, { fetch });

  await flow.lockTarget(ROCK_ID);
  const state = store.targeting.get();
  // R31 — the server's reason still reaches the player, now as its meaning
  // rather than its name. `TargetTooFar` is dogma's TARGET_OUT_OF_RANGE arm.
  assert.equal(state.actionError, "Lock refused: That is too far away. Get closer and try again.");
  assert.equal(state.silentDecline, null, "a refusal is not a silent decline");
  assert.deepEqual(state.lockedTargetIDs, []);
  // Nothing is read after a refusal: there is nothing new to read.
  assert.deepEqual(requests.map((each) => each.path), ["/api/bridge/call"]);
});

test("a lock the server SILENTLY declines is reported as such, with no invented cause", async () => {
  const store = createClientStore();
  // The call says the lock is made, and the read after it has no such lock.
  const { fetch } = targetingBff({ add: () => added(0, []), locked: () => [] });
  const flow = createAppFlow(store, { fetch });

  await flow.lockTarget(ROCK_ID);
  const state = store.targeting.get();
  assert.equal(state.actionError, null, "nothing was refused, so there is no refusal to show");
  assert.match(state.silentDecline ?? "", /gave no reason/i);
  // The message must not speculate about WHY.
  assert.doesNotMatch(state.silentDecline ?? "", /range|capacitor|too many|scrambl/i);
});

test("no lock is asked of a thing the page has locked or is locking, as the client asks none: the read alone is made", async () => {
  const store = createClientStore();
  let landed = false;
  const { fetch, requests } = targetingBff({ add: () => added(1, []), locked: () => (landed ? [ROCK_ID] : []) });
  const flow = createAppFlow(store, { fetch });

  await flow.lockTarget(ROCK_ID);
  assert.deepEqual(store.targeting.get().acquiringTargetIDs, [ROCK_ID]);
  // targetMgr.TryLockTarget (1307): being locked already, nothing is asked. It is being locked still, and says so.
  await flow.lockTarget(ROCK_ID);
  assert.deepEqual(calls(requests), [pageCall("AddTarget", ROCK_ID)]);
  assert.deepEqual([store.targeting.get().acquiringTargetIDs, store.targeting.get().silentDecline], [[ROCK_ID], null]);
  // And locked: nothing is asked either.
  landed = true;
  await flow.loadTargets();
  await flow.lockTarget(ROCK_ID);
  assert.deepEqual(calls(requests), [pageCall("AddTarget", ROCK_ID)]);
  assert.deepEqual([store.targeting.get().lockedTargetIDs, store.targeting.get().silentDecline, store.targeting.get().actionError], [[ROCK_ID], null, null]);
});

// --- Unlocking --------------------------------------------------------------
//
// The client lets go of a target it has locked by RemoveTarget (targetMgr.py 1385), and calls off a lock still
// being made by CancelAddTarget (1303). The page asks the one its own word for the target says, and reads after.

test("unlockTarget lets go of a target the page has locked by RemoveTarget, lands the re-read, and an ignored unlock is called out", async () => {
  const store = createClientStore();
  let locked: readonly number[] = [ROCK_ID];
  const { fetch, requests } = targetingBff({ locked: () => locked });
  const flow = createAppFlow(store, { fetch });
  await flow.loadTargets();
  requests.length = 0;

  locked = [];
  await flow.unlockTarget(ROCK_ID);
  assert.deepEqual(requests.map((each) => [each.path, each.path === "/api/bridge/call" ? each.body : null]), [["/api/bridge/call", pageCall("RemoveTarget", ROCK_ID)], ["/api/bridge/targets", null]]);
  assert.deepEqual(store.targeting.get().lockedTargetIDs, []);
  assert.equal(store.targeting.get().silentDecline, null);
  assert.equal(store.targeting.get().lastAction, "Unlock");

  // The server lets go of nothing, and says nothing of why.
  locked = [ROCK_ID];
  await flow.loadTargets();
  requests.length = 0;
  await flow.unlockTarget(ROCK_ID);
  const state = store.targeting.get();
  assert.deepEqual(calls(requests), [pageCall("RemoveTarget", ROCK_ID)]);
  assert.deepEqual(state.lockedTargetIDs, [ROCK_ID], "it is still locked, so show it still locked");
  assert.match(state.silentDecline ?? "", /did not release/i);
});

test("unlockTarget calls off a lock the page is still making; and lets go of it as a lock where it turns out to be made", async () => {
  // Being locked, by the page's own word: called off, and nothing more where the read after has no such lock.
  const making = createClientStore();
  const calledOff = targetingBff({ add: () => added(1, []), locked: () => [] });
  const first = createAppFlow(making, { fetch: calledOff.fetch });
  await first.lockTarget(ROCK_ID);
  calledOff.requests.length = 0;
  await first.unlockTarget(ROCK_ID);
  assert.deepEqual(calledOff.requests.map((each) => [each.path, each.path === "/api/bridge/call" ? each.body : null]), [["/api/bridge/call", pageCall("CancelAddTarget", ROCK_ID)], ["/api/bridge/targets", null]]);
  assert.equal(making.targeting.get().silentDecline, null);
  // The client's own mark of a thing being locked goes when it calls the lock off (1299): so does the page's.
  assert.deepEqual(making.targeting.get().acquiringTargetIDs, []);

  // The lock was made since the page last read: the calling off did nothing, the read shows it locked, and it is
  // let go of as the lock it is. One press of the one button, in either state.
  const made = createClientStore();
  let locked: readonly number[] = [ROCK_ID];
  const landed = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/call") {
      if (body.method === "RemoveTarget") locked = [];
      return { status: 200, body: { ok: true, service: body.service, method: body.method, result: null, notifications: [] } };
    }
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: locked, notifications: [] } };
    throw new Error(`unexpected ${path}`);
  });
  const second = createAppFlow(made, { fetch: landed.fetch });
  await second.unlockTarget(ROCK_ID);
  assert.deepEqual(calls(landed.requests), [pageCall("CancelAddTarget", ROCK_ID), pageCall("RemoveTarget", ROCK_ID)]);
  assert.deepEqual(landed.requests.map((each) => each.path), ["/api/bridge/call", "/api/bridge/targets", "/api/bridge/call", "/api/bridge/targets"]);
  assert.deepEqual([made.targeting.get().lockedTargetIDs, made.targeting.get().silentDecline, made.targeting.get().actionError], [[], null, null]);
});

// --- Module activation ------------------------------------------------------
//
// The page's own module calls since 2026-10-14 (bridge/dogmaWrites.ts): the flight read first (a module is switched
// in space only), the module type's default effect from the game's data where the type is given and no effect is,
// the call itself (godma.py 2062, Activate(itemID, effectName, target, repeat); 2101, Deactivate(itemID, effectName);
// the effect names its own name, godma.py 985 and 996), and then the module's own state read, its cycle with the
// first read after a stop.

const SHIP_ID = 9001;
const moduleCall = (method: string, args: readonly unknown[]) => ({ service: "dogmaIM", method, args, kwargs: null, pilot: true, confirm: true });
const refused = (message: string) => ({ status: 409, body: { ok: false, error: "CALL_REFUSED", message } });

function moduleBff(spec: {
  readonly call?: (body: Record<string, unknown>) => { status: number; body: unknown };
  readonly state: (cycle: boolean) => Record<string, unknown>;
  readonly effects?: Readonly<Record<number, string | null>>;
  readonly activeModuleIDs?: number[] | null;
}) {
  return makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") {
      return { status: 200, body: { ok: true, flight: { inSpace: true, shipID: SHIP_ID, solarSystemID: 30000142 }, notifications: [] } };
    }
    if (path.startsWith("/api/types/default-effects?typeIDs=")) {
      return { status: 200, body: { ok: true, defaultEffect: spec.effects ?? {} } };
    }
    if (path === "/api/bridge/call") {
      return spec.call ? spec.call(body) : { status: 200, body: { ok: true, service: body.service, method: body.method, result: null, notifications: [] } };
    }
    if (path.startsWith(`/api/bridge/modules/${MODULE_ID}/state?shipID=${SHIP_ID}`)) {
      return { status: 200, body: { ok: true, itemID: MODULE_ID, shipID: SHIP_ID, ...spec.state(path.endsWith("&cycle=1")), notifications: [] } };
    }
    if (path === "/api/bridge/space/snapshot") {
      return { status: 200, body: snapshotBody(spec.activeModuleIDs === undefined ? [] : spec.activeModuleIDs) };
    }
    throw new Error(`unexpected ${path}`);
  });
}

test("activateModule names the module type's default effect, from the game's data, as the client's button does", async () => {
  const store = createClientStore();
  const { fetch, requests } = moduleBff({
    effects: { 483: "miningLaser" },
    state: () => ({ stopped: false, activeModuleIDs: [MODULE_ID] }),
    activeModuleIDs: [MODULE_ID],
  });
  const flow = createAppFlow(store, { fetch });

  await flow.activateModule(MODULE_ID, { typeID: 483, targetID: ROCK_ID });
  // shipmodulebutton.py 1348: the default effect's Activate(targetID, repeats), godma.py 985 then 2062.
  // Until stopped goes as -1, which the game port makes the client's 1000 or 0 by the effect (retailCalls.js, activation).
  assert.deepEqual(calls(requests), [moduleCall("Activate", [MODULE_ID, "miningLaser", ROCK_ID, -1])]);
  assert.ok(requests.some((each) => each.path === "/api/types/default-effects?typeIDs=483"));
  assert.equal(store.targeting.get().lastAction, "Switch on");
  assert.equal(store.targeting.get().silentDecline, null);
});

test("the SAME method drives a mining module and a combat module — no new surface", async () => {
  const store = createClientStore();
  const { fetch, requests } = moduleBff({ state: () => ({ stopped: false, activeModuleIDs: [MODULE_ID] }) });
  const flow = createAppFlow(store, { fetch });

  await flow.activateModule(MODULE_ID, { effect: "miningLaser", targetID: ROCK_ID, repeat: -1 });
  await flow.activateModule(MODULE_ID, { effect: "useMissiles", targetID: ROCK_ID });

  assert.deepEqual(calls(requests), [
    moduleCall("Activate", [MODULE_ID, "miningLaser", ROCK_ID, -1]),
    moduleCall("Activate", [MODULE_ID, "useMissiles", ROCK_ID, -1]),
  ]);
  // An effect the caller names is the one named: the game's data is not asked.
  assert.equal(requests.some((each) => each.path.startsWith("/api/types/default-effects")), false);
});

test("repeat: 0 (a single cycle) is sent as 0, and a module with no target goes out with None", async () => {
  const store = createClientStore();
  const { fetch, requests } = moduleBff({ state: () => ({ stopped: false, activeModuleIDs: [MODULE_ID] }) });
  const flow = createAppFlow(store, { fetch });

  await flow.activateModule(MODULE_ID, { effect: "moduleBonusAfterburner", repeat: 0 });
  assert.deepEqual(calls(requests), [moduleCall("Activate", [MODULE_ID, "moduleBonusAfterburner", null, 0])]);
});

test("a module accepted and then NOT run is a silent decline", async () => {
  const store = createClientStore();
  // The module's own state read after the call: not among the ship's running modules.
  const { fetch } = moduleBff({ state: () => ({ stopped: true, activeModuleIDs: [] }) });
  const flow = createAppFlow(store, { fetch });

  await flow.activateModule(MODULE_ID, { effect: "miningLaser", targetID: ROCK_ID });
  const state = store.targeting.get();
  assert.equal(state.actionError, null);
  assert.match(state.silentDecline ?? "", /did not run it, and gave no reason/i);
});

test("UNKNOWN is not a decline: a verification read that cannot answer says nothing", async () => {
  const store = createClientStore();
  // stopped: null — the state read had no running list to check against.
  const { fetch } = moduleBff({ state: () => ({ stopped: null, activeModuleIDs: null }), activeModuleIDs: null });
  const flow = createAppFlow(store, { fetch });

  await flow.activateModule(MODULE_ID, { effect: "miningLaser", targetID: ROCK_ID });
  const state = store.targeting.get();
  assert.equal(state.silentDecline, null, "we do not know, so we must not claim it declined");
  assert.equal(state.actionError, null);
  // And the snapshot slice keeps "unknown" as null rather than an empty list.
  assert.equal(store.space.get().snapshot?.ship?.activeModuleIDs, null);
});

test("a module refusal surfaces the server's own reason", async () => {
  const store = createClientStore();
  const { fetch, requests } = moduleBff({
    call: () => refused("You must be targeting something to activate that module."),
    state: () => { throw new Error("no state read after a refusal"); },
  });
  const flow = createAppFlow(store, { fetch });

  await flow.activateModule(MODULE_ID, { effect: "miningLaser" });
  assert.match(store.targeting.get().actionError ?? "", /targeting something/i);
  assert.equal(store.targeting.get().silentDecline, null);
  assert.equal(requests.some((each) => each.path.includes("/state?")), false);
});

test("deactivateModule reports a module that stopped outright", async () => {
  const store = createClientStore();
  const { fetch, requests } = moduleBff({ effects: { 483: "miningLaser" }, state: () => ({ stopped: true, activeModuleIDs: [], cycleMs: 60000 }) });
  const flow = createAppFlow(store, { fetch });

  await flow.deactivateModule(MODULE_ID, { typeID: 483 });
  // godma.py 996 then 2101: the effect stopping names itself.
  assert.deepEqual(calls(requests), [moduleCall("Deactivate", [MODULE_ID, "miningLaser"])]);
  // Stopped at the first read, its cycle with it: nothing more to watch.
  assert.deepEqual(requests.filter((each) => each.path.includes("/state?")).map((each) => each.path), [`/api/bridge/modules/${MODULE_ID}/state?shipID=${SHIP_ID}&cycle=1`]);
  assert.equal(store.targeting.get().silentDecline, null);
  assert.equal(store.targeting.get().lastAction, "Switch off");
});

// (The test that a module told to stop and still cycling is said to be "finishing its cycle", never a silent decline,
// went on 2026-10-14: the module is watched to its cycle's end by the page now (bridge/dogmaWrites.ts,
// deactivateModule), and the fake has no clock to give it, so the test would wait out a real cycle. The watching's
// own tests are bridge/moduleShutdown.test.ts's; the flow still says "Switch off — finishing its cycle" where the
// watching ends with the module running.)

test("a genuine refusal to deactivate still surfaces the server's reason", async () => {
  const store = createClientStore();
  const { fetch } = moduleBff({
    call: () => refused("That module is not active."),
    state: () => { throw new Error("no state read after a refusal"); },
  });
  const flow = createAppFlow(store, { fetch });

  await flow.deactivateModule(MODULE_ID, { effect: "miningLaser" });
  assert.match(store.targeting.get().actionError ?? "", /not active/i);
  assert.equal(store.targeting.get().silentDecline, null);
});

test("deactivateModule names a prop mod's effect from its type, the game's data asked for it", async () => {
  const store = createClientStore();
  const { fetch, requests } = moduleBff({ effects: { 21857: "moduleBonusAfterburner" }, state: () => ({ stopped: true, activeModuleIDs: [] }) });
  const flow = createAppFlow(store, { fetch });

  await flow.deactivateModule(MODULE_ID, { typeID: 21857 });
  assert.ok(requests.some((each) => each.path === "/api/types/default-effects?typeIDs=21857"));
  assert.deepEqual(calls(requests), [moduleCall("Deactivate", [MODULE_ID, "moduleBonusAfterburner"])]);
});

// --- A successful action clears the previous failure -------------------------

test("a later success clears both the stale refusal AND the stale silent decline", async () => {
  const store = createClientStore();
  let fail = true;
  // (The lock is the page's own call, refused and then taken; what is locked is read after the one that is taken.)
  const { fetch } = targetingBff({
    add: () => (fail ? { status: 409, body: { ok: false, error: "CALL_REFUSED", message: "TargetTooFar" } } : added(0, [ROCK_ID])),
    locked: () => [ROCK_ID],
  });
  const flow = createAppFlow(store, { fetch });

  await flow.lockTarget(ROCK_ID);
  assert.ok(store.targeting.get().actionError);

  fail = false;
  await flow.lockTarget(ROCK_ID);
  const state = store.targeting.get();
  assert.equal(state.actionError, null, "the refusal described the PREVIOUS action");
  assert.equal(state.silentDecline, null);
});

test("a thing that has left the grid is no longer being locked", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({ status: 200, body: snapshotBody(null) }));
  const flow = createAppFlow(store, { fetch });
  store.apply({ type: "targeting/acquiring", targetID: ROCK_ID });
  await flow.loadSpaceSnapshot();
  assert.deepEqual(store.targeting.get().acquiringTargetIDs, []);
});

test("a blind scene (in space, no ship) does not end a lock note: it is unknown, not empty", async () => {
  const store = createClientStore();
  const { fetch } = makeFakeFetch(() => ({ status: 200, body: { ok: true, space: { inSpace: true, entities: [], ship: null }, notifications: [] } }));
  const flow = createAppFlow(store, { fetch });
  store.apply({ type: "targeting/acquiring", targetID: ROCK_ID });
  await flow.loadSpaceSnapshot();
  assert.deepEqual(store.targeting.get().acquiringTargetIDs, [ROCK_ID]);
});
