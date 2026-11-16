// The flow.ts DISPATCH layer for lootWreck / lootContainer, against a faked
// BFF — the layer scriptMacros.test.ts cannot see, because it only pins the
// DECIDER (which action gets chosen), not what that action does once
// `makeScriptRunnerDeps().issue` picks it up and calls the real API.
//
// Drives a real `startCustomBot` script (the general MacroID/BotScript
// runner, NOT the fixed mining ladder `startMiningBot` drives — that one
// never issues lootWreck/lootContainer at all) over a fake fetch, and asserts
// on the actual `openContainer`/`transferItems` request bodies that come out
// the other side.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { planLootTransfers } from "../bridge/bayRouting.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript } from "../bots/botScript.ts";
import { fittingBody, flightBody, holdsBody, namesBody } from "./botFixtures.ts";
import { isNoRoomAboard } from "../nav/refusalLedger.ts";
import { SCRIPT_MACROS } from "../nav/scriptMacros.ts";

const CHARACTER_ID = 140000005;
const STATION_ID = 60000358;
const SOLAR_SYSTEM_ID = 30000144;
const SHIP_ID = 9988400023309;

function packedRow(fields: Record<string, unknown>): unknown {
  return { type: "packedrow", fields };
}

function keyVal(entries: [string, unknown][]): unknown {
  return { type: "object", name: "util.KeyVal", args: { type: "dict", entries } };
}

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function transferWithoutClaim(body: Record<string, unknown>): Record<string, unknown> {
  const { claimRunID: _claimRunID, ...transfer } = body;
  return transfer;
}

function makeFakeFetch(
  responder: (path: string, method: string, body: Record<string, unknown>) => { status: number; body: unknown },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method, body });
    // Every scripted container action now needs the BFF's authenticated
    // five-minute lease. These dispatch tests fake that authority; claim
    // contention/expiry are exercised in containerClaims.test.ts.
    const outcome = path.startsWith("/api/bots/loot-memory/claims?")
      ? { status: 200, body: { ok: true, itemIDs: [] } }
      : path === "/api/bots/loot-memory/claim"
        ? { status: 200, body: { ok: true, claimed: true } }
        : responder(path, method, body);
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

/** A space snapshot with the ship at the origin and ONE lootable entity in range. */
function spaceBodyWith(entity: Record<string, unknown>): unknown {
  return {
    ok: true,
    // The observation carries the drone bay and drones in space with the scene.
    inSpace: [],
    bay: [],
    space: {
      inSpace: true,
      solarSystemID: SOLAR_SYSTEM_ID,
      shipID: SHIP_ID,
      sampledAtMs: 0,
      ship: {
        itemID: SHIP_ID,
        typeID: 17480,
        name: "Ship",
        mode: "STOP",
        radius: 60,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        capacitorRatio: 1,
        activeModuleIDs: [],
      },
      entities: [entity],
    },
    notifications: [],
  };
}

/**
 * The BFF's `/bays` answer, shaped exactly as the route builds it: EVERY
 * candidate bay is reported, absent ones with `present:false` and `items:null`.
 * Naming a bay here is what makes the router willing to address it — a hull
 * whose bays were never read routes everything to cargo instead.
 */
function baysBody(
  shipID: number,
  present: readonly string[],
  used: Readonly<Record<string, number>> = {},
): unknown {
  const keys = ["cargo", "ore", "gas", "ice", "asteroid", "mineral", "salvage", "planetary", "drone", "ammo", "fuel"];
  return {
    ok: true,
    shipID,
    activeShipID: shipID,
    bays: keys.map((key) => {
      const has = present.includes(key);
      return {
        key,
        label: key,
        present: has,
        capacity: has ? { capacity: 16000, used: used[key] ?? 0 } : { capacity: 0, used: 0 },
        items: has ? [] : null,
        error: null,
      };
    }),
  };
}

function containerReads(containerID: number, items: unknown[], volumes: Record<string, number> = {}): unknown {
  return {
    ok: true,
    containerID,
    list: { type: "list", items },
    capacity: keyVal([["capacity", 120], ["used", 4]]),
    volumes,
  };
}

function script(step: BotScript["program"][number]): BotScript {
  return {
    format: "evejs-bot-script",
    version: 1,
    name: "t",
    notes: "",
    home: { entity: "station", id: STATION_ID, name: "Home", systemName: null },
    interrupts: [],
    program: [step],
  };
}

test("Open Cargo reports the native refusal and keeps the current inventory until the can opens", async () => {
  const previousID = 80000;
  const containerID = 80001;
  const store = createClientStore();
  const notify = "Hack this container successfully before accessing its contents.";
  const values = { type: "dict", entries: [["notify", notify]] };
  let unlocked = false;
  const { fetch } = makeFakeFetch((path) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if (path === "/api/bridge/space/snapshot") return { status: 200, body: spaceBodyWith({
      itemID: containerID, typeID: 85231, kind: "container", name: "Drifter Collection", radius: 5,
      position: { x: 1000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    }) };
    if (path === `/api/bridge/inventory/container/${previousID}`) {
      return { status: 200, body: containerReads(previousID, []) };
    }
    if (path === `/api/bridge/inventory/container/${containerID}?typeID=85231`) {
      return unlocked
        ? { status: 200, body: containerReads(containerID, [packedRow({ itemID: 90001, typeID: 25601, quantity: 1 })]) }
        : { status: 403, body: { ok: false, error: "CALL_REFUSED", message: notify, refusal: { key: "CustomNotify", values } } };
    }
    return { status: 200, body: { ok: true } };
  });
  const flow = createAppFlow(store, { fetch });
  await flow.openContainer(previousID);
  const previous = store.inventory.get().container;
  assert.equal(previous?.itemID, previousID);
  await flow.loadSpaceSnapshot();

  await flow.openCargo(containerID);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.inventory.get().container, previous);
  assert.equal(flow.cargoShown.get(), null);
  assert.equal(flow.dialogsSaid.get().length, 1);
  assert.equal(flow.dialogsSaid.get()[0]?.dialog, "CustomNotify");
  assert.deepEqual(flow.dialogsSaid.get()[0]?.values, values);

  unlocked = true;
  await flow.openCargo(containerID);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.inventory.get().container?.itemID, containerID);
  assert.deepEqual(store.inventory.get().container?.rows.map((row) => row.itemID), [90001]);
  assert.deepEqual(flow.cargoShown.get(), { n: 1, itemID: containerID });
});

test("a custom bot's loot-containers step leases and dispatches a container regardless of EVE item owner", async () => {
  const CONTAINER_ID = 80001;
  let containerReadsCount = 0;
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          // Not owned by us, not owned by anyone knowable — loot-containers
          // does not care, unlike loot-wrecks.
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      containerReadsCount += 1;
      return {
        status: 200,
        body: containerReads(CONTAINER_ID, containerReadsCount === 1 ? [
          packedRow({ itemID: 90001, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 100, singleton: 0 }),
        ] : []),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [90001], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const opened = requests.find((r) => r.path === `/api/bridge/inventory/container/${CONTAINER_ID}`);
  assert.ok(opened, "it read the container's contents");
  assert.equal(opened.method, "GET");
  assert.ok(containerReadsCount >= 2, "claimed loot re-reads the container after transfer before releasing the claim");

  const transfer = requests.find((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfer, "it moved the loot into cargo");
  assert.deepEqual({ ...transfer.body, claimRunID: undefined }, {
    itemIDs: [90001],
    from: { kind: "container", itemID: CONTAINER_ID },
    to: { kind: "cargo" },
    claimRunID: undefined,
  });
  assert.equal(typeof transfer.body.claimRunID, "string");
});

test("a custom bot's loot-containers step splits ore-category loot into the ore hold, everything else into cargo", async () => {
  const CONTAINER_ID = 80002;
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    // The hull HAS an ore hold. That is now a precondition for addressing it:
    // the router only names a bay the ship was observed to have.
    if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) return { status: 200, body: baysBody(SHIP_ID, ["cargo", "ore"]) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(CONTAINER_ID, [
          // Veldspar — category 25 (Asteroid), group 462 — belongs in the ore
          // hold. (This row used to claim group 18, which is Tritanium's; the
          // old router read categoryID only, so the wrong number never showed.)
          packedRow({ itemID: 90010, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 500, singleton: 0 }),
          // Tritanium — a refined mineral. This hull has no mineral hold, so it
          // still goes to cargo, same as before.
          packedRow({ itemID: 90011, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 100, singleton: 0 }),
        ]),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const transfers = requests.filter((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(
    transfers.some((r) => JSON.stringify(transferWithoutClaim(r.body)) === JSON.stringify({
      itemIDs: [90010],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "shipBay", bay: "ore" },
    })),
    "the ore stack went to the ore hold, not cargo",
  );
  assert.ok(
    transfers.some((r) => JSON.stringify(transferWithoutClaim(r.body)) === JSON.stringify({
      itemIDs: [90011],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    })),
    "the non-ore stack still went to cargo",
  );
});

// ── The twelve-hour bug, pinned ─────────────────────────────────────────────
//
// A live bot answered 227 consecutive NotEnoughCargoSpace refusals on
// /api/bridge/inventory/transfer over twelve hours. Two defects produced it and
// both are pinned below, because neither was covered before: the ore hold was
// addressed on hulls that do not have one, and a refusal on the ore half
// cancelled the cargo half that would have succeeded.

test("a hull with NO ore hold gets its ore in cargo — the bay is never addressed blind", async () => {
  const CONTAINER_ID = 80003;
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    // A combat hull: cargo only. `resolvePlace` would happily resolve
    // {shipBay:"ore"} here anyway — it reads a static table and never checks the
    // hull — and the server would answer NotEnoughCargoSpace against a
    // 0-capacity flag, forever.
    if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) return { status: 200, body: baysBody(SHIP_ID, ["cargo"]) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(CONTAINER_ID, [
          packedRow({ itemID: 90020, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 500, singleton: 0 }),
        ]),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [90020], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const transfers = requests.filter((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfers.length > 0, "it tried to move the loot");
  assert.equal(
    transfers.some((r) => JSON.stringify(r.body.to) === JSON.stringify({ kind: "shipBay", bay: "ore" })),
    false,
    "no transfer addressed an ore hold this hull does not have",
  );
  assert.ok(
    transfers.some((r) => JSON.stringify(transferWithoutClaim(r.body)) === JSON.stringify({
      itemIDs: [90020],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    })),
    "the ore went to cargo instead",
  );
});

test("a FULL ore hold keeps its ore in the can, and the rest of the loot still lands", () => {
  // ⚠ CARGO IS NOT A BACKSTOP FOR A FULL ORE HOLD. The operator's rule: "if the
  // ore bay exists, no ore in ship cargo." It is also the safe reading —
  // deliver-ore empties the specialised holds, so ore pushed into a barge's
  // cargo is ore nothing will ever unload. This test used to assert the
  // opposite; the spill it pinned was wrong.
  //
  // Kept as a unit check on the planner rather than a whole-bot run: the rule is
  // about which transfers are PLANNED, and the dispatch layer's job is only to
  // issue them.
  const rows = [
    { itemID: 90030, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 500, singleton: false, volume: 1 },
    { itemID: 90031, typeID: 578, groupID: 60, categoryID: 7, flagID: null, quantity: 1, singleton: true, volume: 5 },
  ];
  const bays = [
    { key: "ore", label: "Ore hold", present: true, capacity: null, items: null, error: null },
    { key: "cargo", label: "Cargo hold", present: true, capacity: null, items: null, error: null },
  ];
  const planned = planLootTransfers(rows, bays, (bay) => (bay === null ? 5_000 : 0));
  assert.deepEqual(
    planned,
    [{ bay: null, itemIDs: [90031], qty: null }],
    "the module went to cargo; the ore stayed in the can",
  );
});

test("a can holding MORE than the hold can take is drained, not refused", async () => {
  // THE SCENARIO THIS EXISTS FOR. 10,000 units of ore at 1 m³ each sitting in a
  // can, and an ore hold with 1,000 m³ free. A transfer is all-or-nothing per
  // stack, so asking for the stack whole is refused outright and NOTHING moves
  // — every tick, for ever. Taking what fits and coming back is the answer.
  const CONTAINER_ID = 80005;
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    // Ore hold: 16,000 capacity, 15,000 used -> 1,000 m³ free.
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(15_000, []) };
    // 16,000 capacity with 15,000 used -> 1,000 m³ free in the ore hold.
    if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) {
      return { status: 200, body: baysBody(SHIP_ID, ["cargo", "ore"], { ore: 15_000 }) };
    }
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(
          CONTAINER_ID,
          [packedRow({ itemID: 90040, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 10_000, singleton: 0 })],
          { "1230": 1 },
        ),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [90040], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const transfers = requests.filter((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfers.length > 0, "it moved something rather than being refused");
  const split = transfers.find((r) => typeof r.body.qty === "number");
  assert.ok(split, "the oversized stack was SPLIT rather than offered whole");
  assert.deepEqual(split.body.itemIDs, [90040]);
  assert.equal(split.body.qty, 1_000, "exactly what the 1,000 m³ of free space holds");
  assert.deepEqual(split.body.to, { kind: "shipBay", bay: "ore" });
});

test("a hold with no room at all provokes no transfer whatsoever", async () => {
  // Nothing fits, so nothing is asked for — the refusal never happens.
  const CONTAINER_ID = 80006;
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(16_000, []) };
    // The ore hold is FULL. Cargo has room, and must still not be offered the
    // ore — "if the ore bay exists, no ore in ship cargo".
    if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) {
      return { status: 200, body: baysBody(SHIP_ID, ["cargo", "ore"], { ore: 16_000 }) };
    }
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(
          CONTAINER_ID,
          [packedRow({ itemID: 90050, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 10_000, singleton: 0 })],
          { "1230": 1 },
        ),
      };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  assert.equal(
    requests.some((r) => r.path === "/api/bridge/inventory/transfer"),
    false,
    "a full ship asks for nothing, so there is no refusal to loop on",
  );
  assert.equal(
    requests.some((r) => r.path === "/api/bridge/inventory/transfer"),
    false,
    "and the ore was NOT pushed into the cargo hold that had room",
  );
});

test("a can that fits nowhere is SAID so, rather than retried in silence", async () => {
  // The spin this closes: a barge with a full ore hold and a half-empty cargo
  // bay reads as "has room" to the block's own check, while a can of pure ore
  // still fits nowhere. Planning nothing and staying quiet would re-target that
  // can for ever with no call, no refusal and no progress.
  const CONTAINER_ID = 80007;
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "container",
          name: "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    // The ore hold is FULL; the block's own "am I full?" check still sees the
    // cargo hold's room and carries on, which is exactly the trap.
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(16_000, []) };
    if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) {
      return { status: 200, body: baysBody(SHIP_ID, ["cargo", "ore"], { ore: 16_000 }) };
    }
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(
          CONTAINER_ID,
          [packedRow({ itemID: 90060, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 5_000, singleton: 0 })],
          { "1230": 1 },
        ),
      };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  flow.stopCustomBot();

  assert.equal(
    requests.some((r) => r.path === "/api/bridge/inventory/transfer"),
    false,
    "nothing was asked for, because nothing fits",
  );
  const refusals = store.customBot.get().refusals;
  assert.ok(refusals.length > 0, "but the run SAYS it could not place the loot");
  assert.match(refusals[0]!.words, /no room aboard/i);
});

test("a wreck holding nothing but an ASSEMBLED module is looted, not refused as full", async () => {
  // ⚠ THE REGRESSION. A dropped module crosses the wire as `quantity: -1` —
  // retail's marker for "one object", not a count — and `decodeRowFields` used
  // to keep it. `planLootTransfers` starts at `left = row.quantity`, saw
  // -1 <= 0, and placed the row nowhere; with no other row in the can that is
  // nothing planned, which `transferLootedRows` reports as NO_ROOM_ABOARD.
  //
  // So a bot flying an empty hull past a wreck full of salvageable modules
  // looted none of them and told the player, once per can, that there was no
  // room aboard for it. The hold in this test is 16,000 m3 and untouched.
  const CONTAINER_ID = 80005;
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: CONTAINER_ID,
          kind: "wreck",
          name: "Wreck",
          ownerID: CHARACTER_ID,
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) {
      return { status: 200, body: baysBody(SHIP_ID, ["cargo", "ore"]) };
    }
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(
          CONTAINER_ID,
          // An assembled module, exactly as the wire sends one.
          [packedRow({ itemID: 90070, typeID: 485, groupID: 55, categoryID: 7, flagID: null, quantity: -1, stacksize: 1, singleton: 1 })],
          { "485": 5 },
        ),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [90070], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-wrecks", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  flow.stopCustomBot();

  const transfer = requests.find((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfer, "the module was moved into the cargo hold");
  assert.deepEqual(transfer.body, {
    itemIDs: [90070],
    from: { kind: "container", itemID: CONTAINER_ID },
    to: { kind: "cargo" },
  });
  const refusals = store.customBot.get().refusals;
  assert.equal(
    refusals.some((entry) => /no room aboard/i.test(entry.words)),
    false,
    "and nothing claimed the empty ship was full",
  );
});

test("a custom bot's loot-wrecks step dispatches openContainer + transferItems for an owned wreck (closes the pre-existing dispatch-test gap)", async () => {
  const WRECK_ID = 70001;
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });

  const { fetch, requests } = makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: WRECK_ID,
          kind: "wreck",
          name: "Wreck",
          ownerID: CHARACTER_ID, // must be OURS — loot-wrecks refuses anything else
          radius: 5,
          position: { x: 1000, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return {
        status: 200,
        body: containerReads(WRECK_ID, [
          packedRow({ itemID: 90002, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 50, singleton: 0 }),
        ]),
      };
    }
    if (path === "/api/bridge/inventory/transfer") {
      return { status: 200, body: { ok: true, applied: true, moved: [90002], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });

  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-wrecks", args: {} }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();

  const opened = requests.find((r) => r.path === `/api/bridge/inventory/container/${WRECK_ID}`);
  assert.ok(opened, "it read the wreck's contents");
  assert.equal(opened.method, "GET");

  const transfer = requests.find((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(transfer, "it moved the loot into cargo");
  assert.deepEqual(transfer.body, {
    itemIDs: [90002],
    from: { kind: "container", itemID: WRECK_ID },
    to: { kind: "cargo" },
  });
});

// ── THE SAME PATH, PRESSED BY HAND ──────────────────────────────────────────
//
// `flow.lootContainer` is what the overview's "Take everything" calls, and it is
// the same `lootIntoShip` the two blocks above dispatch through. That sharing is
// the whole point: a second implementation for the hand-flown case would not
// diverge loudly, it would diverge in the BAY ROUTING — a player's Retriever
// putting ore in cargo while the bot put it in the ore hold, where `deliver-ore`
// would never find it. These tests drive the manual entry point over the same
// fake BFF and assert on the same request bodies.

/** Everything the manual verb needs answered, with ONE container on the grid. */
function manualLootFetch(options: {
  containerID: number;
  kind: string;
  bays: readonly string[];
  used?: Readonly<Record<string, number>>;
  rows: unknown[];
  volumes?: Record<string, number>;
  cargoCapacity?: number;
}) {
  let remaining = [...options.rows];
  return makeFakeFetch((path, _method, body) => {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody(false) };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) {
      return {
        status: 200,
        body: spaceBodyWith({
          itemID: options.containerID,
          kind: options.kind,
          name: options.kind === "wreck" ? "A wreck" : "Jetcan",
          ownerID: 555,
          radius: 5,
          position: { x: 400, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: 0 },
        }),
      };
    }
    if (path === "/api/names") return { status: 200, body: namesBody(body) };
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody() };
    if (path === "/api/bridge/ship/ore-hold") return { status: 200, body: holdsBody(0, []) };
    if (path.startsWith(`/api/bridge/ship/${SHIP_ID}/bays`)) {
      const bays = baysBody(SHIP_ID, options.bays, options.used ?? {}) as { bays: { key: string; capacity: { capacity: number; used: number } }[] };
      const cargo = bays.bays.find((bay) => bay.key === "cargo");
      if (cargo && options.bays.includes("cargo")) cargo.capacity.capacity = options.cargoCapacity ?? 350;
      return { status: 200, body: bays };
    }
    if (path.startsWith("/api/bridge/inventory/container/")) {
      return { status: 200, body: containerReads(options.containerID, remaining, options.volumes ?? {}) };
    }
    if (path === "/api/bridge/inventory/transfer") {
      const itemIDs = body.itemIDs as number[];
      remaining = remaining.flatMap((row) => {
        const packed = row as { fields: { itemID: number; quantity: number; singleton?: number | boolean } };
        if (!itemIDs.includes(packed.fields.itemID)) return [row];
        const quantity = packed.fields.singleton ? 1 : packed.fields.quantity;
        const taken = typeof body.qty === "number" ? body.qty : quantity;
        return taken < quantity ? [{ ...packed, fields: { ...packed.fields, quantity: quantity - taken } }] : [];
      });
      return { status: 200, body: { ok: true, applied: true, moved: [], declined: [], declinedSilently: false, notFound: [] } };
    }
    return { status: 200, body: { ok: true } };
  });
}

function onlineStore() {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });
  return store;
}

test("the overview's Take everything routes a wreck's rows through the SAME bays the bot uses", async () => {
  const CONTAINER_ID = 80010;
  const store = onlineStore();
  const { fetch, requests } = manualLootFetch({
    containerID: CONTAINER_ID,
    kind: "wreck",
    bays: ["cargo", "ore"],
    rows: [
      // Veldspar — category 25 (Asteroid): the ore hold, on a hull that has one.
      packedRow({ itemID: 90020, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 500, singleton: 0 }),
      // A refined mineral, with no mineral hold on this hull: cargo.
      packedRow({ itemID: 90021, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 100, singleton: 0 }),
    ],
  });

  const flow = createAppFlow(store, { fetch });
  await flow.loadSpaceSnapshot();
  const outcome = await flow.lootContainer(CONTAINER_ID);

  const opened = requests.find((r) => r.path === `/api/bridge/inventory/container/${CONTAINER_ID}`);
  assert.ok(opened, "it read the wreck's contents");

  const transfers = requests.filter((r) => r.path === "/api/bridge/inventory/transfer");
  assert.ok(
    transfers.some((r) => JSON.stringify(r.body) === JSON.stringify({
      itemIDs: [90020],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "shipBay", bay: "ore" },
    })),
    "the ore went to the ore hold, exactly as the bot routes it",
  );
  assert.ok(
    transfers.some((r) => JSON.stringify(r.body) === JSON.stringify({
      itemIDs: [90021],
      from: { kind: "container", itemID: CONTAINER_ID },
      to: { kind: "cargo" },
    })),
    "and the rest went to cargo",
  );
  // What the panel reports is read from these counts, so they are part of the
  // contract rather than a debugging aid.
  assert.deepEqual(outcome, { stacks: 2, planned: 2, moved: 2 });
});

test("an EMPTY wreck is an outcome, not a failure and not a silence", async () => {
  // The panel says "There was nothing in it." A throw here would land in the
  // error line as though something had gone wrong, and returning nothing at all
  // would leave the player looking at an unchanged screen wondering whether the
  // button worked.
  const CONTAINER_ID = 80011;
  const store = onlineStore();
  const { fetch, requests } = manualLootFetch({
    containerID: CONTAINER_ID,
    kind: "wreck",
    bays: ["cargo"],
    rows: [],
  });

  const flow = createAppFlow(store, { fetch });
  await flow.loadSpaceSnapshot();
  const outcome = await flow.lootContainer(CONTAINER_ID);

  assert.deepEqual(outcome, { stacks: 0, planned: 0, moved: 0 });
  assert.equal(
    requests.filter((r) => r.path === "/api/bridge/inventory/transfer").length,
    0,
    "nothing was offered to the server",
  );
});

test("a hull with no room refuses with the sentinel the panel translates, not with a code on screen", async () => {
  // ⚠ THE MARKER TRAVELS IN THE MESSAGE, so the ledger can classify it — which
  // means `panelErrorWords` would print NO_ROOM_ABOARD verbatim (it has no code
  // table for an error this client minted). `isNoRoomAboard` is how the panel
  // tells this case apart and writes its own sentence instead.
  const CONTAINER_ID = 80012;
  const store = onlineStore();
  const { fetch, requests } = manualLootFetch({
    containerID: CONTAINER_ID,
    kind: "container",
    bays: ["cargo"],
    used: { cargo: 16000 }, // full to the brim
    rows: [
      packedRow({ itemID: 90030, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 500, singleton: 0 }),
    ],
    volumes: { "1230": 0.1 }, // measurable, so "no room" is a fact and not a guess
  });

  const flow = createAppFlow(store, { fetch });
  await flow.loadSpaceSnapshot();
  await assert.rejects(
    () => flow.lootContainer(CONTAINER_ID),
    (error: unknown) => {
      assert.ok(isNoRoomAboard(error), "the panel can recognise it");
      return true;
    },
  );
  assert.equal(
    requests.filter((r) => r.path === "/api/bridge/inventory/transfer").length,
    0,
    "nothing was offered: there was nowhere for it to go",
  );
});

// ── WHAT THE TRIP FOUND OUT, SAID OUT LOUD ──────────────────────────────────
//
// A wreck's contents cannot be read from across the grid: the server refuses to
// list one past 2,500 m, and the slim item's `isEmpty` -- the field the retail
// client draws its hollow-wreck bracket from -- rides DoDestinyUpdate, the one
// notification the web gateway suppresses. So "is there anything in that wreck"
// costs whoever asks it the flight there. These pin the only fix available:
// whoever pays it tells the BFF's shared loot memory, and the next pilot reads
// the answer instead of flying for it.

/** Let the fire-and-forget report leave the flow before looking for it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("a wreck that held NOTHING is reported to the shared loot memory", async () => {
  const CONTAINER_ID = 80013;
  const store = onlineStore();
  const { fetch, requests } = manualLootFetch({
    containerID: CONTAINER_ID,
    kind: "wreck",
    bays: ["cargo"],
    rows: [],
  });

  const flow = createAppFlow(store, { fetch });
  await flow.loadSpaceSnapshot();
  await flow.lootContainer(CONTAINER_ID);
  await settle();

  const reported = requests.filter((r) => r.path === "/api/bots/loot-memory" && r.method === "POST");
  assert.equal(reported.length, 1, "the one fact nobody else could have had");
  assert.deepEqual(reported[0]?.body, { system: SOLAR_SYSTEM_ID, itemID: CONTAINER_ID });
});

test("a wreck this ship EMPTIED is reported too — empty now is empty for everybody", async () => {
  const CONTAINER_ID = 80014;
  const store = onlineStore();
  const { fetch, requests } = manualLootFetch({
    containerID: CONTAINER_ID,
    kind: "wreck",
    bays: ["cargo"],
    rows: [
      packedRow({ itemID: 90040, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 100, singleton: 0 }),
    ],
    volumes: { "34": 0.01 },
  });

  const flow = createAppFlow(store, { fetch });
  await flow.loadSpaceSnapshot();
  const outcome = await flow.lootContainer(CONTAINER_ID);
  await settle();

  assert.deepEqual(outcome, { stacks: 1, planned: 1, moved: 1 });
  const reported = requests.filter((r) => r.path === "/api/bots/loot-memory" && r.method === "POST");
  assert.deepEqual(reported[0]?.body, { system: SOLAR_SYSTEM_ID, itemID: CONTAINER_ID });
});

test("a PARTIAL loot says NOTHING: what did not fit is a fact about this hull", async () => {
  // ⚠ THE WHOLE DISCIPLINE OF THE SHARED BOARD. This can still has ore in it --
  // this ship simply had no room for it. Reporting that would send a hauler with
  // an empty hold straight past a full can.
  const CONTAINER_ID = 80015;
  const store = onlineStore();
  const { fetch, requests } = manualLootFetch({
    containerID: CONTAINER_ID,
    kind: "container",
    bays: ["cargo"],
    used: { cargo: 349 }, // 1 m³ left of a 350 m³ hold
    rows: [
      // 50 m³ of ore: some of it moves, the rest stays in the can.
      packedRow({ itemID: 90050, typeID: 1230, groupID: 462, categoryID: 25, flagID: null, quantity: 500, singleton: 0 }),
      // And a second stack that has nowhere to go at all.
      packedRow({ itemID: 90051, typeID: 34, groupID: 18, categoryID: 4, flagID: null, quantity: 10000, singleton: 0 }),
    ],
    volumes: { "1230": 0.1, "34": 0.01 },
  });

  const flow = createAppFlow(store, { fetch });
  await flow.loadSpaceSnapshot();
  const outcome = await flow.lootContainer(CONTAINER_ID);
  await settle();

  assert.ok(outcome.moved < outcome.stacks, "it did not clear the can");
  assert.equal(
    requests.filter((r) => r.path === "/api/bots/loot-memory").length,
    0,
    "nothing was said about a can that still has loot in it",
  );
});

const oversizeRow = () => packedRow({ itemID: 90080, typeID: 500, groupID: 25, categoryID: 6, quantity: 1, singleton: 0 });
const smallLootRow = () => packedRow({ itemID: 90081, typeID: 34, groupID: 18, categoryID: 4, quantity: 1, singleton: 0 });

test("oversized loot completes locally without telling a larger ship the container is empty", async () => {
  const CONTAINER_ID = 80016;
  const store = onlineStore();
  const { fetch, requests } = manualLootFetch({ containerID: CONTAINER_ID, kind: "container", bays: ["cargo"],
    rows: [oversizeRow()], volumes: { "500": 4000 } });
  const flow = createAppFlow(store, { fetch });
  await flow.loadSpaceSnapshot();
  assert.deepEqual(await flow.lootContainer(CONTAINER_ID), { stacks: 1, planned: 0, moved: 0 });
  await settle();
  assert.equal(requests.some((request) => request.path === "/api/bots/loot-memory"), false);
  assert.equal(requests.some((request) => request.path === "/api/bridge/inventory/transfer"), false);

  // The salvager commits a successful attempt in its own site memory. The can
  // remains on the scene; that local completion must still finish the site.
  const salvager = SCRIPT_MACROS["salvage-bookmarked-sites"]!;
  const step = { id: "salvager", kind: "macro", macro: "salvage-bookmarked-sites", args: {
    fromFolder: { kind: "bookmarkFolder", folderID: 7000001, name: "To Salvage" },
    doneFolder: { kind: "bookmarkFolder", folderID: 7000002, name: "Salvaged" },
    station: { kind: "station", ref: { entity: "station", id: STATION_ID, name: "Home", systemName: null } },
  } } as const;
  const observation = { inSpace: true, docked: false, inWarp: false, shieldRatio: 1, armorRatio: 1, hullRatio: 1,
    health: 1, oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    myCharacterID: 555, salvageModuleIDs: [], tractorModuleIDs: [],
    flightStatus: { inSpace: true, docked: false, solarSystemID: SOLAR_SYSTEM_ID },
    bookmarks: [{ bookmarkID: 9000011, name: "Site", folderID: 7000001, solarSystemID: SOLAR_SYSTEM_ID }],
    snapshot: store.space.get().snapshot,
  } as never;
  const ready = { foldersReady: true, fromID: 7000001, doneID: 7000002, unloadChecked: true, site: 9000011, stage: "site" };
  const attempted = salvager(step, observation, ready, {});
  assert.deepEqual(attempted.action, { kind: "lootWreck", wreckID: CONTAINER_ID });
  const finished = salvager(step, observation, attempted.nextMem, {});
  assert.equal(finished.action.kind, "moveBookmarks", "success sets aside this hull's uncarryable cargo without an unload trip");
});

test("moving the carryable part of a mixed container does not publish the oversized remainder as empty", async () => {
  const CONTAINER_ID = 80017;
  const store = onlineStore();
  const { fetch, requests } = manualLootFetch({ containerID: CONTAINER_ID, kind: "container", bays: ["cargo"],
    rows: [oversizeRow(), smallLootRow()], volumes: { "500": 4000, "34": 1 } });
  const flow = createAppFlow(store, { fetch });
  await flow.loadSpaceSnapshot();
  assert.deepEqual(await flow.lootContainer(CONTAINER_ID), { stacks: 2, planned: 1, moved: 1 });
  await settle();
  assert.equal(requests.filter((request) => request.path === "/api/bridge/inventory/transfer").length, 1);
  assert.equal(requests.some((request) => request.path === "/api/bots/loot-memory"), false);
});

test("a claimed mixed container finishes its transfer without advertising the oversized remainder as empty", async () => {
  const CONTAINER_ID = 80018;
  const store = onlineStore();
  const { fetch, requests } = manualLootFetch({ containerID: CONTAINER_ID, kind: "container", bays: ["cargo"],
    rows: [oversizeRow(), smallLootRow()], volumes: { "500": 4000, "34": 1 } });
  const flow = createAppFlow(store, { fetch });
  try {
    await flow.startCustomBot(script({ id: "loot", kind: "macro", macro: "loot-containers", args: {} }));
    const until = Date.now() + 2000;
    while (requests.filter((request) => request.path === `/api/bridge/inventory/container/${CONTAINER_ID}`).length < 2 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(requests.some((request) => request.path === "/api/bridge/inventory/transfer" && typeof request.body.claimRunID === "string"), true);
    await settle();
    assert.equal(requests.some((request) => request.path === "/api/bots/loot-memory"), false);
    assert.deepEqual(store.customBot.get().refusals, [], "an oversized remainder does not become a full-ship refusal");
  } finally {
    flow.stopCustomBot();
  }
});

test("one accepted partial-stack transfer is not proof that its container is empty", async () => {
  const CONTAINER_ID = 80019;
  const { fetch, requests } = manualLootFetch({ containerID: CONTAINER_ID, kind: "container", bays: ["cargo"],
    rows: [packedRow({ itemID: 90082, typeID: 34, groupID: 18, categoryID: 4, quantity: 500, singleton: 0 })], volumes: { "34": 1 } });
  const flow = createAppFlow(onlineStore(), { fetch });
  await flow.loadSpaceSnapshot();
  assert.deepEqual(await flow.lootContainer(CONTAINER_ID), { stacks: 1, planned: 1, moved: 1 });
  await settle();
  assert.equal(requests.find((request) => request.path === "/api/bridge/inventory/transfer")?.body.qty, 350);
  assert.equal(requests.some((request) => request.path === "/api/bots/loot-memory"), false, "150 units remain for another ship");
});

for (const unavailable of ["failed", "malformed"] as const) {
  test(`a ${unavailable} post-transfer read never publishes a global empty record`, async () => {
    const CONTAINER_ID = 80020;
    const { fetch, requests } = manualLootFetch({ containerID: CONTAINER_ID, kind: "container", bays: ["cargo"],
      rows: [smallLootRow()], volumes: { "34": 1 } });
    let reads = 0;
    const uncertainFetch: typeof fetch = async (input, init) => {
      if (String(input).startsWith(`/api/bridge/inventory/container/${CONTAINER_ID}`) && ++reads > 1) {
        if (unavailable === "failed") throw new Error("post-transfer read unavailable");
        return { ok: true, status: 200, async json() { return { ok: true, list: null }; } } as Response;
      }
      return fetch(input, init);
    };
    const flow = createAppFlow(onlineStore(), { fetch: uncertainFetch });
    await flow.loadSpaceSnapshot();
    assert.deepEqual(await flow.lootContainer(CONTAINER_ID), { stacks: 1, planned: 1, moved: 1 }, "the confirmed transfer stays successful");
    await settle();
    assert.equal(reads, 2);
    assert.equal(requests.some((request) => request.path === "/api/bots/loot-memory"), false);
  });
}
