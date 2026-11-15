// R24 slices C, D and E — the in-space cockpit, driven through the REAL live
// channel (a fake EventSource feeding the flow's own SSE handler, exactly as
// liveFlow.test.ts does), not through a back door.
//
// Three things are proved here that nothing else covers:
//
//   C  a module's cycle length reaches the panel, and the page can always say
//      WHICH figure it is holding — the pilot's real one (a server cycle event)
//      or the equipment's base one (attribute 73). The two are never conflated,
//      and the base one never displaces the real one.
//   D  the LIVE hold: an `OnItemsChanged` frame off the R10 push channel makes
//      the browser RE-READ the ship's holds. The notification is the trigger;
//      the ship stays the authority on what is in it.
//   E  the mining loop, step by step, with each step's OBSERVABILITY stated —
//      including the one that is not observable to a client at all.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow, type ActionMessage } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { EventSourceLike } from "./api.ts";

const SHIP_ID = 9001;
const LASER_ID = 7700001;
const PASSIVE_ID = 7700002;
const LASER_TYPE = 483; // Miner II
const ROCK_ID = 50001248;
const ORE_TYPE = 1230; // Veldspar
const RAT_ID = 980000000130; // a Guristas Invader, as R29 actually fought
const RAT_WEAPON_TYPE = 2383;
const OUR_WEAPON_TYPE = 490; // 220mm Vulcan AutoCannon I
const CHARACTER_ID = 7;

const IN_SPACE = {
  inSpace: true,
  docked: false,
  solarSystemID: 30000142,
  stationID: null,
  structureID: null,
  shipID: SHIP_ID,
  shipMode: "STOP",
  shipSpeedFraction: 0,
};

interface FakeSource extends EventSourceLike {
  readonly url: string;
  closed: boolean;
  emit(frame: unknown): void;
  open(): void;
}

function makeFakeEventSource(): {
  factory: (url: string) => EventSourceLike;
  sources: FakeSource[];
} {
  const sources: FakeSource[] = [];
  const factory = (url: string): EventSourceLike => {
    const source: FakeSource = {
      url,
      closed: false,
      onmessage: null,
      onopen: null,
      onerror: null,
      emit(frame: unknown) {
        source.onmessage?.({ data: JSON.stringify(frame) });
      },
      open() {
        source.onopen?.();
      },
      close() {
        source.closed = true;
      },
    };
    sources.push(source);
    return source;
  };
  return { factory, sources };
}

/** One gateway frame, in the shape the BFF republishes over SSE. */
function notificationFrame(method: string, args: readonly unknown[], sequence: number) {
  return {
    source: "evejs-web-gateway",
    apiVersion: 1,
    type: "event",
    cursor: { epoch: "epoch-1", sequence },
    event: {
      kind: "notification",
      notification: { kind: "client", service: null, method, args, kwargs: null },
    },
  };
}

/** A whole fake world whose ore hold fills as the fake server grants ore. */
function makeWorld() {
  const state = { holdUsed: 0, holdReads: 0, snapshotReads: 0, ratShield: 1 };
  const fetchImpl = (async (input: unknown) => {
    const path = String(input);
    let status = 200;
    let body: unknown = { ok: true };

    if (path === "/api/bridge/select") {
      body = {
        ok: true,
        character: {
          characterID: CHARACTER_ID,
          characterName: "Test Pilot",
          stationID: null,
          structureID: null,
          solarSystemID: 30000142,
          corporationID: 98000000,
        },
        station: null,
        notifications: [],
      };
    } else if (path === "/api/bridge/flight/status") {
      body = { ok: true, flight: IN_SPACE, notifications: [] };
    } else if (path === "/api/bridge/ship/ore-hold") {
      state.holdReads += 1;
      body = {
        ok: true,
        activeShipID: SHIP_ID,
        stationID: null,
        holds: [
          {
            key: "ore",
            label: "Ore hold",
            items:
              state.holdUsed > 0
                ? [{ itemID: 77000001, typeID: ORE_TYPE, quantity: state.holdUsed }]
                : [],
            capacity: { capacity: 5000, used: state.holdUsed },
            present: true,
            error: null,
          },
          // A hold this hull does NOT have: its capacity attribute is
          // unpopulated, so the BFF reports it absent and the panel leaves it
          // out. Data, not special-casing.
          {
            key: "ice",
            label: "Ice hold",
            items: [],
            capacity: null,
            present: false,
            error: null,
          },
        ],
      };
    } else if (path === "/api/bridge/space/snapshot") {
      // R29: the AUTHORITATIVE health read. A shot arriving on the push channel
      // schedules one of these; the bars come from here, never from the shot.
      state.snapshotReads += 1;
      body = {
        ok: true,
        space: {
          inSpace: true,
          solarSystemID: 30000142,
          shipID: SHIP_ID,
          sampledAtMs: Date.now(),
          entities: [
            {
              kind: "ship",
              itemID: RAT_ID,
              typeID: 3841,
              groupID: 562,
              categoryID: 11,
              name: "Guristas Invader",
              ownerID: 1000127,
              radius: 30,
              position: { x: 0, y: 0, z: 0 },
              velocity: { x: 0, y: 0, z: 0 },
              isSelf: false,
              shieldRatio: state.ratShield,
              armorRatio: 1,
              hullRatio: 1,
            },
          ],
          ship: { itemID: SHIP_ID, typeID: 629, activeModuleIDs: [] },
        },
        notifications: [],
      };
    } else if (path.startsWith("/api/types/cycle-times")) {
      // Attribute 73 for a Miner II is 15000 ms. Static reference data.
      body = { ok: true, source: "static-data", baseCycleMs: { [LASER_TYPE]: 15000 } };
    } else if (path === "/api/names") {
      body = { ok: true, names: {} };
    } else if (path.startsWith("/api/")) {
      body = { ok: true, result: null, flight: IN_SPACE, notifications: [] };
    } else {
      status = 404;
      body = { ok: false, error: "NOT_FOUND", message: path };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
    };
  }) as unknown as typeof fetch;
  return { state, fetch: fetchImpl };
}

async function onlineFlow() {
  const store = createClientStore();
  const world = makeWorld();
  const { factory, sources } = makeFakeEventSource();
  const flow = createAppFlow(store, { fetch: world.fetch, eventSource: factory });
  await flow.selectCharacter(CHARACTER_ID);
  const source = sources[0];
  assert.ok(source, "coming online must open the live event channel");
  source.open();
  return { store, flow, source, state: world.state };
}

/**
 * Let the flow's OnItemsChanged coalescing window close (it is deliberately
 * longer than one frame, so a burst of ore grants costs one read).
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

// --- Slice C: cycle times ----------------------------------------------------

test("C: the BASE cycle length is attribute 73, and it is labelled as base", () => {
  const store = createClientStore();
  store.apply({ type: "targeting/base-cycles", cycles: { [LASER_ID]: 15000 } });

  const cycle = store.get().targeting.moduleCycles[LASER_ID]!;
  assert.equal(cycle.durationMs, 15000, "a Miner II runs a 15 s cycle at base");
  assert.equal(cycle.source, "base", "and the page is told that is the BASE figure");
  assert.equal(cycle.startedAtMs, null, "knowing the length is not knowing it is running");
});

test("C: a SERVER cycle event carries the effective duration, and it WINS over the base one", async () => {
  const { store, source } = await onlineFlow();

  // A trained pilot's Miner II cycles faster than its type says. Only the
  // server can know that — there is still no allowlisted read for effective
  // per-module attributes — so an OnGodmaShipEffect duration is the better
  // figure and must displace the base one.
  store.apply({ type: "targeting/base-cycles", cycles: { [LASER_ID]: 15000 } });
  source.emit(
    notificationFrame(
      "OnGodmaShipEffect",
      [LASER_ID, 67, 1, 1, 1, null, 1, 12750, true, null],
      1,
    ),
  );

  const cycle = store.get().targeting.moduleCycles[LASER_ID]!;
  assert.equal(cycle.durationMs, 12750);
  assert.equal(cycle.source, "server");
  assert.equal(cycle.startedAtMs !== null, true, "and now we know when the cycle began");
  assert.equal(cycle.repeating, true, "a laser left running repeats");
});

test("C: the base figure never DOWNGRADES a server one", async () => {
  const { store, source } = await onlineFlow();
  source.emit(
    notificationFrame(
      "OnGodmaShipEffect",
      [LASER_ID, 67, 1, 1, 1, null, 1, 12750, true, null],
      1,
    ),
  );
  // A fitting reload re-seeds base times; it must not overwrite what the ship
  // actually reported.
  store.apply({ type: "targeting/base-cycles", cycles: { [LASER_ID]: 15000 } });

  assert.equal(store.get().targeting.moduleCycles[LASER_ID]!.durationMs, 12750);
  assert.equal(store.get().targeting.moduleCycles[LASER_ID]!.source, "server");
});

test("C: a stop event ends the running cycle but KEEPS the length we learned", async () => {
  const { store, source } = await onlineFlow();
  source.emit(
    notificationFrame("OnGodmaShipEffect", [LASER_ID, 67, 1, 1, 1, null, 1, 12750, true, null], 1),
  );
  source.emit(
    notificationFrame("OnGodmaShipEffect", [LASER_ID, 67, 1, 0, 0, null, 1, -1, false, null], 2),
  );

  const cycle = store.get().targeting.moduleCycles[LASER_ID]!;
  assert.equal(cycle.durationMs, 12750, "how long a cycle takes did not change");
  assert.equal(cycle.source, "server", "and it is still the server's figure");
  assert.equal(cycle.startedAtMs, null, "but nothing is running");
});

test("C: a module with no duration has NO cycle — never a zero one", async () => {
  const { store, source } = await onlineFlow();

  // -1 is the server's "this effect has no duration" (godmaMultiEvent.js:49).
  // A passive or instant effect must not acquire a fabricated cycle: a 0 ms
  // cycle would render as an instant one, which is a different claim entirely.
  source.emit(
    notificationFrame("OnGodmaShipEffect", [PASSIVE_ID, 16, 1, 1, 1, null, 1, -1, false, null], 1),
  );
  assert.equal(store.get().targeting.moduleCycles[PASSIVE_ID], undefined);

  // And the same when static data has no attribute 73 for the type.
  store.apply({ type: "targeting/base-cycles", cycles: { [PASSIVE_ID]: null } });
  assert.equal(store.get().targeting.moduleCycles[PASSIVE_ID], undefined);
});

test("C: a marshalled real duration is read as a number", async () => {
  const { store, source } = await onlineFlow();
  // The wire form of a duration can be a marshalled real rather than a bare
  // number (marshalModuleDurationWireValue, runtime.js:1225).
  source.emit(
    notificationFrame(
      "OnGodmaShipEffect",
      [LASER_ID, 67, 1, 1, 1, null, 1, { type: "real", value: 9000 }, false, null],
      1,
    ),
  );
  assert.equal(store.get().targeting.moduleCycles[LASER_ID]!.durationMs, 9000);
});

// --- Slice D: the LIVE hold --------------------------------------------------

test("D: an OnItemsChanged push makes the browser RE-READ the hold", async () => {
  const { store, flow, source, state } = await onlineFlow();

  await flow.loadMiningHolds();
  assert.equal(store.get().mining.holds[0]!.capacity?.used, 0);
  const before = state.holdReads;

  // The ore is granted server-side and OnItemsChanged is emitted
  // (miningRuntime.js:994-999 -> syncMinedOreChangesToSession). The frame
  // arrives; the browser does NOT trust the delta, it goes and asks the ship.
  state.holdUsed = 350;
  source.emit(
    notificationFrame(
      "OnItemsChanged",
      [{ type: "list", items: [] }, { type: "dict", entries: [] }, ["Ship", SHIP_ID, "ShipCargo"]],
      1,
    ),
  );
  await settle();

  assert.ok(state.holdReads > before, "the push triggered a fresh read of the hold");
  assert.equal(
    store.get().mining.holds[0]!.capacity?.used,
    350,
    "and the hold shows what the SHIP says, not what the notification claimed",
  );
});

test("D: a burst of OnItemsChanged frames coalesces into ONE re-read", async () => {
  const { flow, source, state } = await onlineFlow();
  await flow.loadMiningHolds();
  const before = state.holdReads;

  // Mining grants ore stack by stack, so one cycle can push several frames.
  for (let i = 0; i < 6; i += 1) {
    source.emit(notificationFrame("OnItemsChanged", [], i + 1));
  }
  await settle();

  assert.equal(state.holdReads - before, 1, "six frames, one read");
});

test("D: a hold the hull does not have is reported absent, so the panel leaves it out", async () => {
  const { store, flow } = await onlineFlow();
  await flow.loadMiningHolds();

  const holds = store.get().mining.holds;
  const ore = holds.find((hold) => hold.label === "Ore hold");
  const ice = holds.find((hold) => hold.label === "Ice hold");
  // Presence is decided by whether the capacity ATTRIBUTE is populated, which
  // is why a Venture and a Mammoth differ by DATA and neither is special-cased.
  assert.equal(ore?.present, true);
  assert.equal(ice?.present, false);
  assert.equal(ice?.capacity, null, "an absent hold has no reading, not a zero one");
});

test("D: a cycle event does not drag a hold read along with it", async () => {
  const { flow, source, state } = await onlineFlow();
  await flow.loadMiningHolds();
  const before = state.holdReads;

  source.emit(
    notificationFrame("OnGodmaShipEffect", [LASER_ID, 67, 1, 1, 1, null, 1, 12750, true, null], 1),
  );
  await settle();

  assert.equal(state.holdReads, before, "each notification drives only what it is about");
});

// --- Slice E: the mining loop, and what is observable at each step ------------

test("E: the mining loop, step by step, with each step's observability", async () => {
  const { store, flow, source, state } = await onlineFlow();
  await flow.loadMiningHolds();

  // 1. LOCK THE ROCK. OBSERVABLE — but only through a RE-READ: `AddTarget`
  //    answers 200 while the lock is still being acquired, so R23 made
  //    `GetTargets` the authority and the page shows "Locking…" in between.
  store.apply({ type: "targeting/acquiring", targetID: ROCK_ID });
  assert.deepEqual(store.get().targeting.acquiringTargetIDs, [ROCK_ID]);
  store.apply({ type: "targeting/targets", targetIDs: [ROCK_ID] });
  assert.deepEqual(store.get().targeting.lockedTargetIDs, [ROCK_ID]);
  assert.deepEqual(store.get().targeting.acquiringTargetIDs, [], "the lock landed");

  // 2. SWITCH THE LASER ON. OBSERVABLE two ways, and both matter: the space
  //    snapshot's `ship.activeModuleIDs` is the SERVER's list of what is
  //    cycling (R23), and the OnGodmaShipEffect start event says how long one
  //    cycle takes and when this one began (R24).
  source.emit(
    notificationFrame("OnGodmaShipEffect", [LASER_ID, 67, 1, 1, 1, null, 1, 15000, true, null], 1),
  );
  const started = store.get().targeting.moduleCycles[LASER_ID]!;
  assert.equal(started.startedAtMs !== null, true);
  assert.equal(started.repeating, true, "a laser left running repeats");

  // 3. ORE ACCRUES IN THE CORRECT HOLD. OBSERVABLE — the ore grant emits
  //    OnItemsChanged and the hold re-read shows it, in the hold the SERVER
  //    chose. The browser never picks a destination flag for mined ore.
  state.holdUsed = 700;
  source.emit(notificationFrame("OnItemsChanged", [], 2));
  await settle();
  assert.equal(store.get().mining.holds[0]!.capacity?.used, 700);

  // 4. THE ROCK'S REMAINING QUANTITY DROPS. OBSERVABLE, but NOT always: the
  //    snapshot carries `remainingQuantity` only when the scene's mining state
  //    has it, and a survey scan is what fills it in otherwise. When neither
  //    knows, the panel shows a dash — never a 0, which would read as a
  //    mined-out rock and send a player away from a full belt.
  store.apply({
    type: "mining/survey",
    survey: [{ itemID: ROCK_ID, yieldTypeID: ORE_TYPE, remainingQuantity: 4000 }],
    atMs: 1,
  });
  assert.equal(store.get().mining.survey[0]!.remainingQuantity, 4000);

  // 5. DEPLETION CLEARS THE LOCK AND REMOVES THE ROCK. OBSERVABLE — as an
  //    ABSENCE, which is the honest way to see it: the rock stops appearing in
  //    the snapshot and stops appearing in GetTargets. There is no "the rock
  //    you were mining is gone" event for a client to receive.
  store.apply({ type: "targeting/targets", targetIDs: [] });
  assert.deepEqual(store.get().targeting.lockedTargetIDs, []);

  // 6. A FULL HOLD STOPS THE CYCLE. ⚠ **NOT OBSERVABLE as a REASON.** The
  //    mining runtime returns `stopReason: "cargo"` INTERNALLY
  //    (miningRuntime.js:990) — it is a return value inside the server, not a
  //    notification. What a client sees is a stop event and a hold at capacity,
  //    and it must not claim to know that one caused the other.
  state.holdUsed = 5000;
  source.emit(notificationFrame("OnItemsChanged", [], 3));
  source.emit(
    notificationFrame("OnGodmaShipEffect", [LASER_ID, 67, 1, 0, 0, null, 1, -1, false, null], 4),
  );
  await settle();
  assert.equal(store.get().mining.holds[0]!.capacity?.used, 5000, "the hold is full");
  const stopped = store.get().targeting.moduleCycles[LASER_ID]!;
  assert.equal(
    stopped.startedAtMs,
    null,
    "and the laser stopped — but nothing on the wire says the fullness is WHY",
  );
  assert.equal(stopped.durationMs, 15000, "the cycle length we learned survives the stop");

  // 7. DEACTIVATE. OBSERVABLE — the same two surfaces as activation, and R23
  //    already verifies it against the snapshot's cycling list rather than
  //    against the Deactivate call's 200.
});

// --- R29: the damage log ----------------------------------------------------
//
// A feasibility survey concluded that no NPC emits damage and that an "under
// attack" indicator was therefore impossible. That was WRONG, and these tests
// encode what the live wire actually did: sitting in a Perimeter asteroid belt
// with a rat shooting and NOTHING of ours firing, 16 `OnDamageMessage` frames
// arrived naming the rat as source and our ship as target. The payloads below
// are the real captured shapes, ids and all.
//
// The payload is a BARE marshaled dict, not a util.KeyVal, and `attackType` is
// the direction signal — "me" for our own shots, "otherPlayerWeapons" for shots
// at us. The direction is READ, never inferred from which id looks like a ship.

/** One shot, in the exact shape captured off the live SSE stream. */
function damageFrame(
  fields: {
    attackType: string;
    source: number;
    target: number;
    weapon: number;
    damage: number;
    hitQuality: number;
    attackerID: number | null;
  },
  sequence: number,
) {
  return notificationFrame(
    "OnDamageMessage",
    [
      {
        type: "dict",
        entries: [
          ["attackType", fields.attackType],
          ["source", fields.source],
          ["target", fields.target],
          ["weapon", fields.weapon],
          ["damage", fields.damage],
          ["splash", ""],
          ["hitQuality", fields.hitQuality],
          ["isBanked", false],
          ["attackerID", fields.attackerID],
        ],
      },
    ],
    sequence,
  );
}

function incoming(damage: number, sequence: number, hitQuality = 3) {
  return damageFrame(
    {
      attackType: "otherPlayerWeapons",
      source: RAT_ID,
      target: SHIP_ID,
      weapon: RAT_WEAPON_TYPE,
      damage,
      hitQuality,
      attackerID: RAT_ID,
    },
    sequence,
  );
}

function outgoing(damage: number, sequence: number) {
  return damageFrame(
    {
      attackType: "me",
      source: SHIP_ID,
      target: RAT_ID,
      weapon: OUR_WEAPON_TYPE,
      damage,
      hitQuality: 4,
      attackerID: null,
    },
    sequence,
  );
}

test("R29: a shot TAKEN lands in the log, named by who fired it", async () => {
  const { store, source } = await onlineFlow();

  source.emit(incoming(19.8, 1));
  await settle();

  const log = store.targeting.get().damageLog;
  assert.equal(log.length, 1, "the pushed shot reached the store");
  assert.equal(log[0]!.direction, "taken", "attackType said it was fired AT us");
  assert.equal(log[0]!.otherPartyID, RAT_ID, "and the other party is the shooter");
  assert.equal(log[0]!.weaponTypeID, RAT_WEAPON_TYPE);
  assert.equal(log[0]!.amount, 19.8);
});

test("R29: a shot DEALT is distinguished by attackType, not by guessing", async () => {
  const { store, source } = await onlineFlow();

  source.emit(outgoing(101.3, 1));
  await settle();

  const log = store.targeting.get().damageLog;
  assert.equal(log[0]!.direction, "dealt");
  assert.equal(
    log[0]!.otherPartyID,
    RAT_ID,
    "for a shot we fired, the other party is the TARGET",
  );
  assert.equal(log[0]!.weaponTypeID, OUR_WEAPON_TYPE);
});

test("R29: a MISS is kept, because zero damage is a real thing that happened", async () => {
  const { store, source } = await onlineFlow();

  // Two of the 16 live frames were misses: damage 0, hitQuality 0. Dropping
  // them would make a rat that is shooting and missing look like a rat that is
  // not shooting at all.
  source.emit(incoming(0, 1, 0));
  await settle();

  const log = store.targeting.get().damageLog;
  assert.equal(log.length, 1, "the miss was recorded");
  assert.equal(log[0]!.amount, 0);
  assert.equal(log[0]!.quality, 0);
});

test("R29: the log is a BOUNDED tail, never an unbounded ledger", async () => {
  const { store, source } = await onlineFlow();

  for (let i = 0; i < 60; i += 1) {
    source.emit(incoming(1 + i, i + 1));
  }
  await settle();

  const log = store.targeting.get().damageLog;
  assert.ok(log.length <= 40, `the tail is capped; saw ${log.length}`);
  assert.equal(
    log[log.length - 1]!.amount,
    60,
    "and it keeps the NEWEST shots — the oldest are the ones dropped",
  );
});

test("R29: a burst of shots coalesces into ONE authoritative health read", async () => {
  const { source, state } = await onlineFlow();
  const before = state.snapshotReads;

  // One frigate produced 16 frames in a single engagement. The bars must not be
  // re-read once per bullet, and must NOT be derived from the shots at all.
  for (let i = 0; i < 16; i += 1) {
    source.emit(incoming(19.8, i + 1));
  }
  // The health window is deliberately WIDER than the hold's, so this waits past
  // it rather than reusing settle().
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(
    state.snapshotReads - before,
    1,
    "sixteen shots, one read of what the ship and target actually say",
  );
});

test("the live bounty notification delivers the payout amount and modified flag", async () => {
  const { flow, source } = await onlineFlow();
  const messages: ActionMessage[] = [];
  const stop = flow.onActionMessage((message) => messages.push(message));
  try {
    for (const [sequence, amount, isModified] of [[1, 3000, false], [2, 4250, true]] as const) {
      source.emit(notificationFrame("OnBountyAddedToPayout", [{
        type: "object",
        name: "util.KeyVal",
        args: {
          type: "dict",
          entries: [
            ["enemyTypeID", 16877],
            ["amount", amount],
            ["payoutTime", { type: "long", value: "134444192000000000" }],
            ["isModified", isModified],
          ],
        },
      }], sequence));
    }
    await settle();

    assert.deepEqual(messages, [
      { kind: "bounty", amount: 3000, isModified: false },
      { kind: "bounty", amount: 4250, isModified: true },
    ]);
  } finally {
    stop();
  }
});
