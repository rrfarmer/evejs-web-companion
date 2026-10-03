// The DEFENSE MODULE CLASSIFIER in `resolveDefenseModuleIDs` (flow.ts), driven
// through the REAL custom-bot script runner over a faked BFF.
//
// The bug this suite pins: the three self-repair regexes in
// `resolveDefenseModuleIDs` (`/shield boost/i`, `/armor repair/i`,
// `/hull repair/i`) were UNANCHORED, so every REMOTE repair group's SDE name
// also matched its self branch — "Remote Armor Repairer" reads as
// `/armor repair/i`, "Remote Shield Booster" (and "Ancillary Remote Shield
// Booster") read as `/shield boost/i`, "Remote Hull Repairer" reads as
// `/hull repair/i`. `resolveRemoteRepModuleIDs` already classifies every one
// of those correctly, so a fitted remote repairer landed in BOTH lists — and
// the `repair` interrupt (nav/scriptDecide.ts) activates a self-list module
// SELF-TARGETED (targetID: 0). A logi ship fitted with a Remote Armor Repairer
// and carrying an armor-below watch would switch it on aimed at itself:
// repairs nothing, burns capacitor, on the one hull whose job is repairing
// someone else. "Shield Boost Amplifier" (a PASSIVE stat module, no cycle of
// its own) rode the same unanchored `/shield boost/i` test into the
// activation list.
//
// Every group name below is the real SDE string (`groups.jsonl`), because the
// whole bug is about those exact strings, not about invented ones matching
// only the old or the new regex by coincidence.
//
// This does not re-test the interrupt/repair MECHANISM itself (scriptDecide's
// own suite owns that); it tests that flow.ts hands that mechanism the RIGHT
// item ids in the first place — which is exactly the seam the bug lived in.

import test from "node:test";
import assert from "node:assert/strict";

import { createAppFlow } from "./flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import type { BotScript, InterruptRow } from "../bots/botScript.ts";

const CHARACTER_ID = 90000001; // ESI's own documented example CharacterID — synthetic, not a real pilot.
const STATION_ID = 60003760; // Jita IV - Moon 4 (static SDE data).
const SOLAR_SYSTEM_ID = 30000142; // Jita (static SDE data).
const SHIP_ID = 90000010;

interface TestModule {
  readonly itemID: number;
  readonly typeID: number;
  readonly flagID: number;
  /** The real SDE typeGroup NAME — what `resolved[nameKey("typeGroup", ...)]` answers. */
  readonly groupName: string;
}

// One representative fitted module per group this bug touches, verified
// against `_local/sde/.../groups.jsonl` on 2026-09-11.
const REMOTE_ARMOR_REPAIRER: TestModule = { itemID: 61001, typeID: 12501, flagID: 19, groupName: "Remote Armor Repairer" };
const ARMOR_REPAIR_UNIT: TestModule = { itemID: 61002, typeID: 12502, flagID: 20, groupName: "Armor Repair Unit" };
const REMOTE_SHIELD_BOOSTER: TestModule = { itemID: 61003, typeID: 12503, flagID: 19, groupName: "Remote Shield Booster" };
const SHIELD_BOOST_AMPLIFIER: TestModule = { itemID: 61004, typeID: 12504, flagID: 11, groupName: "Shield Boost Amplifier" };
const SHIELD_BOOSTER: TestModule = { itemID: 61005, typeID: 12505, flagID: 20, groupName: "Shield Booster" };
const REMOTE_HULL_REPAIRER: TestModule = { itemID: 61006, typeID: 12506, flagID: 19, groupName: "Remote Hull Repairer" };
const HULL_REPAIR_UNIT: TestModule = { itemID: 61007, typeID: 12507, flagID: 20, groupName: "Hull Repair Unit" };

const ARMOR_WATCH: InterruptRow = { id: "armor-watch", when: { kind: "armor-below", fraction: 0.5 }, respond: "repair" };
const SHIELD_WATCH: InterruptRow = { id: "shield-watch", when: { kind: "shield-below", fraction: 0.5 }, respond: "repair" };
const HULL_WATCH: InterruptRow = { id: "hull-watch", when: { kind: "hull-below", fraction: 0.5 }, respond: "repair" };

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

function packedRow(fields: Record<string, unknown>): unknown {
  return { type: "packedrow", fields };
}

function fittingBody(modules: readonly TestModule[]): unknown {
  return {
    ok: true,
    activeShipID: SHIP_ID,
    stationID: STATION_ID,
    slots: {
      type: "list",
      items: modules.map((m) =>
        packedRow({
          itemID: m.itemID,
          typeID: m.typeID,
          ownerID: CHARACTER_ID,
          locationID: SHIP_ID,
          flagID: m.flagID,
          quantity: -1,
          groupID: 0, // unused by resolveDefenseModuleIDs — it judges the resolved GROUP NAME, not this id
          categoryID: 7,
          customInfo: "",
        }),
      ),
    },
    // Slot COUNTS are irrelevant here: buildSlots draws at least as many slots
    // as the highest OCCUPIED flag in each family, so an empty attribute map
    // still yields every slot these fixtures actually fit into.
    shipInfo: {
      type: "dict",
      entries: [
        [
          SHIP_ID,
          {
            type: "object",
            name: "util.KeyVal",
            args: {
              type: "dict",
              entries: [
                ["itemID", SHIP_ID],
                ["attributes", { type: "dict", entries: [] }],
              ],
            },
          },
        ],
      ],
    },
    online: { type: "list", items: modules.map((m) => m.itemID) },
    errors: { slots: null, shipInfo: null, online: null },
  };
}

function namesBody(request: Record<string, unknown>, modules: readonly TestModule[]): unknown {
  const groupByType = new Map(modules.map((m) => [m.typeID, m.groupName]));
  const items = Array.isArray(request.items) ? (request.items as { kind?: string; id?: number }[]) : [];
  const names: Record<string, string> = {};
  for (const item of items) {
    if (typeof item.id !== "number" || !groupByType.has(item.id)) {
      continue;
    }
    if (item.kind === "typeGroup") {
      names[`typeGroup:${item.id}`] = groupByType.get(item.id)!;
    } else if (item.kind === "type") {
      // The display name never reaches this classifier — only the group does.
      names[`type:${item.id}`] = "Test Module";
    }
  }
  return { ok: true, source: "static-data", count: Object.keys(names).length, names, unresolved: [] };
}

function spaceBody(ratios: { shield?: number; armor?: number; hull?: number; cap?: number }): unknown {
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
        typeID: 1,
        name: "Test Ship",
        mode: "STOP",
        radius: 60,
        position: { x: 0, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        shieldRatio: ratios.shield ?? 1,
        armorRatio: ratios.armor ?? 1,
        hullRatio: ratios.hull ?? 1,
        capacitorRatio: ratios.cap ?? 1,
        activeModuleIDs: [],
      },
      entities: [],
    },
    notifications: [],
  };
}

function flightBody(): unknown {
  return {
    ok: true,
    flight: {
      inSpace: true,
      docked: false,
      solarSystemID: SOLAR_SYSTEM_ID,
      stationID: null,
      structureID: null,
      shipID: SHIP_ID,
      shipTypeID: 1,
      shipIsCapsule: false,
      shipMode: "STOP",
      shipSpeedFraction: 0,
    },
    notifications: [],
  };
}

function onlineStore(): ReturnType<typeof createClientStore> {
  const store = createClientStore();
  store.apply({
    type: "character/online",
    character: {
      characterID: CHARACTER_ID,
      characterName: "Test Pilot",
      stationID: null,
      structureID: null,
      solarSystemID: SOLAR_SYSTEM_ID,
      corporationID: 98000000,
    },
    station: null,
  });
  return store;
}

function makeFakeFetch(
  modules: readonly TestModule[],
  ratios: { shield?: number; armor?: number; hull?: number; cap?: number },
): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fakeFetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const path = String(input);
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : {};
    requests.push({ path, method, body });
    const outcome = respond(path, body);
    return {
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      async json() {
        return outcome.body;
      },
    };
  }) as unknown as typeof fetch;

  function respond(path: string, body: Record<string, unknown>): { status: number; body: unknown } {
    if (path === "/api/bridge/flight/status") return { status: 200, body: flightBody() };
    if ((path === "/api/bridge/space/snapshot" || path === "/api/bridge/script/observation")) return { status: 200, body: spaceBody(ratios) };
    if (path === "/api/bridge/fitting") return { status: 200, body: fittingBody(modules) };
    if (path === "/api/bridge/bound-dogma") return { status: 200, body: { ok: true, reads: { GetAllInfo: { error: null,
      result: { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
        ["activeShipID", SHIP_ID], ["shipInfo", { type: "dict", entries: modules.map(module => [module.itemID,
          { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
            ["itemID", module.itemID], ["attributes", { type: "dict", entries:
              /amplifier/i.test(module.groupName) ? [] : [[73, 5000]] }],
          ] } }]) }],
      ] } } } } } };
    if (path === "/api/bridge/modules/activate") return { status: 200,
      body: { ok: true, itemID: body.itemID, active: true, stopped: null } };
    if (path === "/api/names") return { status: 200, body: namesBody(body, modules) };
    if (path === "/api/bridge/targets") return { status: 200, body: { ok: true, targetIDs: [], notifications: [] } };
    if (path === "/api/bridge/drones") return { status: 200, body: { ok: true, activeShipID: SHIP_ID, inSpace: [], bay: [], notifications: [] } };
    if (path === "/api/bridge/ship/ore-hold") {
      return { status: 200, body: { ok: true, activeShipID: SHIP_ID, stationID: STATION_ID, holds: [] } };
    }
    return { status: 200, body: { ok: true } };
  }

  return { fetch: fakeFetch, requests };
}

function script(interrupt: InterruptRow): BotScript {
  return {
    format: "evejs-bot-script",
    version: 1,
    name: "defense classifier probe",
    notes: "",
    home: { entity: "station", id: STATION_ID, name: "Home", systemName: "Jita" },
    interrupts: [interrupt],
    program: [{ id: "wait", kind: "macro", macro: "wait", args: {} }],
  };
}

/** Start the real custom-bot runner, let its first tick land, stop it, and
 * return every `activate` call it issued — the observable proof of which
 * item id `resolveDefenseModuleIDs` handed the `repair` interrupt. */
async function activateCalls(
  modules: readonly TestModule[],
  ratios: { shield?: number; armor?: number; hull?: number; cap?: number },
  interrupt: InterruptRow,
): Promise<readonly Recorded[]> {
  const store = onlineStore();
  const { fetch, requests } = makeFakeFetch(modules, ratios);
  const flow = createAppFlow(store, { fetch });
  await flow.startCustomBot(script(interrupt));
  await new Promise((resolve) => setTimeout(resolve, 150));
  flow.stopCustomBot();
  return requests.filter((r) => r.path === "/api/bridge/modules/activate");
}

// ── armor ────────────────────────────────────────────────────────────────────

test("mobile combat reads weapon inventory against the observed ship before Undock advances", async () => {
  const store = onlineStore();
  const fake = makeFakeFetch([], {});
  const flow = createAppFlow(store, { fetch: fake.fetch });
  const doc: BotScript = { ...script(ARMOR_WATCH), interrupts: [], program: [
    { id: "undock", kind: "macro", macro: "undock", args: {} },
    { id: "mobile", kind: "macro", macro: "fight-with-drones", args: {} },
  ] };
  await flow.startCustomBot(doc);
  await new Promise(resolve => setTimeout(resolve, 150));
  flow.stopCustomBot();
  assert.ok(fake.requests.some(request => request.path === "/api/bridge/inventory"),
    "fresh weapon observation must use the observed ship, even before the mobile macro becomes current");
});

test("a Remote Armor Repairer never self-activates on the armor-below watch — the fix", async () => {
  const activated = await activateCalls([REMOTE_ARMOR_REPAIRER], { armor: 0.3 }, ARMOR_WATCH);
  assert.equal(
    activated.length,
    0,
    "pre-fix this fired: the Remote Armor Repairer's group name reads as /armor repair/i and landed in armorRepairerIDs",
  );
});

test("a genuine Armor Repair Unit still self-activates on the armor-below watch (no regression)", async () => {
  const activated = await activateCalls([ARMOR_REPAIR_UNIT], { armor: 0.3 }, ARMOR_WATCH);
  assert.equal(activated.length, 1, "the watch has exactly one idle repairer to switch on");
  assert.equal(activated[0]?.body.itemID, ARMOR_REPAIR_UNIT.itemID);
  // targetID: 0 is self/no-target — api.activateModule drops a falsy targetID
  // from the wire body entirely rather than sending a literal 0.
  assert.equal("targetID" in (activated[0]?.body ?? {}), false, "a self repairer carries no targetID at all");
});

test("a Remote Armor Repairer fitted alongside a genuine one is never the one chosen", async () => {
  const activated = await activateCalls(
    [REMOTE_ARMOR_REPAIRER, ARMOR_REPAIR_UNIT],
    { armor: 0.3 },
    ARMOR_WATCH,
  );
  assert.equal(activated.length, 1);
  assert.equal(
    activated[0]?.body.itemID,
    ARMOR_REPAIR_UNIT.itemID,
    "the genuine repairer runs — never the remote one competing for the same watch",
  );
});

// ── shield ───────────────────────────────────────────────────────────────────

test("a Remote Shield Booster never self-activates on the shield-below watch — the fix", async () => {
  const activated = await activateCalls([REMOTE_SHIELD_BOOSTER], { shield: 0.3 }, SHIELD_WATCH);
  assert.equal(
    activated.length,
    0,
    "pre-fix this fired: \"Remote Shield Booster\" also reads as the old /shield boost/i test",
  );
});

test("a Shield Boost Amplifier — a passive module — never self-activates on the shield-below watch", async () => {
  const activated = await activateCalls([SHIELD_BOOST_AMPLIFIER], { shield: 0.3 }, SHIELD_WATCH);
  assert.equal(
    activated.length,
    0,
    "the amplifier has no cycle of its own; it only raises what an ACTIVE Shield Booster elsewhere repairs",
  );
});

test("a genuine Shield Booster still self-activates on the shield-below watch (no regression)", async () => {
  const activated = await activateCalls([SHIELD_BOOSTER], { shield: 0.3 }, SHIELD_WATCH);
  assert.equal(activated.length, 1);
  assert.equal(activated[0]?.body.itemID, SHIELD_BOOSTER.itemID);
  assert.equal("targetID" in (activated[0]?.body ?? {}), false, "a self repairer carries no targetID at all");
});

// ── hull ─────────────────────────────────────────────────────────────────────

test("a Remote Hull Repairer never self-activates on the hull-below watch — the fix", async () => {
  const activated = await activateCalls([REMOTE_HULL_REPAIRER], { hull: 0.3 }, HULL_WATCH);
  assert.equal(
    activated.length,
    0,
    "pre-fix this fired: \"Remote Hull Repairer\" also reads as the old /hull repair/i test",
  );
});

test("a genuine Hull Repair Unit still self-activates on the hull-below watch (no regression)", async () => {
  const activated = await activateCalls([HULL_REPAIR_UNIT], { hull: 0.3 }, HULL_WATCH);
  assert.equal(activated.length, 1);
  assert.equal(activated[0]?.body.itemID, HULL_REPAIR_UNIT.itemID);
  assert.equal("targetID" in (activated[0]?.body ?? {}), false, "a self repairer carries no targetID at all");
});
