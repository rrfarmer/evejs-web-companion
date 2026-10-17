// The R11 space-snapshot decoder: long-aware IDs, clamped health fractions, and
// a stable shape for a partial or malformed payload (the panel must never blow
// up on a snapshot arriving mid-transition).

import test from "node:test";
import assert from "node:assert/strict";

import { decodeSpaceSnapshot, decodeTargetIDs, egoPosition, isSceneBlind } from "./space.ts";
import type { JsonValue } from "./wire.ts";

test("a full snapshot decodes into overview rows and a ship readout", () => {
  const snapshot = decodeSpaceSnapshot({
    inSpace: true,
    solarSystemID: 30000142,
    shipID: 9001,
    sampledAtMs: 1_700_000_000_000,
    entities: [
      {
        kind: "ship",
        itemID: 9001,
        typeID: 670,
        groupID: 29,
        categoryID: 6,
        name: "My Capsule",
        ownerID: 7,
        radius: 25,
        position: { x: 1, y: 2, z: 3 },
        velocity: { x: 4, y: 5, z: 6 },
        isSelf: true,
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio: 1,
        characterID: 7,
        corporationID: 98000000,
        allianceID: 99000000,
        securityStatus: -1.5,
        maxVelocity: 300,
        mode: "STOP",
        capacitorRatio: 0.5,
      },
      {
        kind: "celestial",
        itemID: 50001248,
        typeID: 16,
        groupID: 10,
        categoryID: 2,
        name: "Stargate (Maurasi)",
        radius: 1500,
        position: { x: 1_000_000, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        isSelf: false,
        shieldRatio: null,
        armorRatio: null,
        hullRatio: null,
      },
    ],
    ship: {
      itemID: 9001,
      typeID: 670,
      name: "My Capsule",
      mode: "STOP",
      maxVelocity: 300,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 4, y: 5, z: 6 },
      shieldRatio: 0.5,
      armorRatio: 0.75,
      hullRatio: 1,
      capacitorRatio: 0.25,
      shieldCapacity: 400,
      armorCapacity: 300,
      hullCapacity: 600,
    },
  } as unknown as JsonValue);

  assert.equal(snapshot.inSpace, true);
  assert.equal(snapshot.solarSystemID, 30000142);
  assert.equal(snapshot.entities.length, 2);

  const self = snapshot.entities[0];
  assert.equal(self?.isSelf, true);
  assert.equal(self?.name, "My Capsule");
  // Security status is signed and must survive as-is (it is not an ID decode).
  assert.equal(self?.securityStatus, -1.5);
  assert.deepEqual(self?.position, { x: 1, y: 2, z: 3 });

  const gate = snapshot.entities[1];
  assert.equal(gate?.isSelf, false);
  assert.equal(gate?.shieldRatio, null, "an object with no health reports no bars");

  assert.equal(snapshot.ship?.shieldRatio, 0.5);
  assert.equal(snapshot.ship?.hullCapacity, 600);
});

test("long-wrapped IDs decode like every other bridge payload", () => {
  const snapshot = decodeSpaceSnapshot({
    inSpace: true,
    solarSystemID: { type: "long", value: "30000142" },
    shipID: { type: "long", value: "9988400022009" },
    entities: [
      {
        itemID: { type: "long", value: "9988400022009" },
        typeID: { type: "long", value: "670" },
        position: { x: 0, y: 0, z: 0 },
      },
    ],
    ship: { itemID: { type: "long", value: "9988400022009" } },
  } as unknown as JsonValue);

  assert.equal(snapshot.solarSystemID, 30000142);
  assert.equal(snapshot.shipID, 9988400022009);
  assert.equal(snapshot.entities[0]?.itemID, 9988400022009);
  assert.equal(snapshot.entities[0]?.typeID, 670);
  assert.equal(snapshot.ship?.itemID, 9988400022009);
});

test("health fractions are clamped and absent layers stay null", () => {
  const snapshot = decodeSpaceSnapshot({
    inSpace: true,
    entities: [],
    ship: {
      itemID: 1,
      shieldRatio: 1.9,
      armorRatio: -0.4,
      hullRatio: "half",
      capacitorRatio: 0.33,
    },
  } as unknown as JsonValue);

  assert.equal(snapshot.ship?.shieldRatio, 1);
  assert.equal(snapshot.ship?.armorRatio, 0);
  assert.equal(snapshot.ship?.hullRatio, null, "a non-numeric ratio is no bar, not zero");
  assert.equal(snapshot.ship?.capacitorRatio, 0.33);
});

test("a partial or malformed snapshot still decodes to a usable shape", () => {
  const empty = decodeSpaceSnapshot(undefined);
  assert.equal(empty.inSpace, false);
  assert.deepEqual(empty.entities, []);
  assert.equal(empty.ship, null);

  // A docked read: in space false, nothing around, no ship readout.
  const docked = decodeSpaceSnapshot({
    inSpace: false,
    solarSystemID: 30000142,
    entities: [],
    ship: null,
  } as unknown as JsonValue);
  assert.equal(docked.inSpace, false);
  assert.equal(docked.ship, null);

  // Rows with no usable identity are dropped rather than rendered as blanks.
  const junk = decodeSpaceSnapshot({
    inSpace: true,
    entities: [{ itemID: 0 }, "nonsense", null, { itemID: 42 }],
  } as unknown as JsonValue);
  assert.deepEqual(junk.entities.map((row) => row.itemID), [42]);
  // A row with no position still gets a usable origin vector.
  assert.deepEqual(junk.entities[0]?.position, { x: 0, y: 0, z: 0 });
});

test("distances are measured from the ship, falling back to the self row", () => {
  const withShip = decodeSpaceSnapshot({
    inSpace: true,
    entities: [{ itemID: 1, isSelf: true, position: { x: 9, y: 9, z: 9 } }],
    ship: { itemID: 1, position: { x: 5, y: 0, z: 0 } },
  } as unknown as JsonValue);
  assert.deepEqual(egoPosition(withShip), { x: 5, y: 0, z: 0 });

  // No ship readout: the self row in the visible set is the next best origin.
  const withoutShip = decodeSpaceSnapshot({
    inSpace: true,
    entities: [
      { itemID: 2, position: { x: 100, y: 0, z: 0 } },
      { itemID: 1, isSelf: true, position: { x: 9, y: 9, z: 9 } },
    ],
  } as unknown as JsonValue);
  assert.deepEqual(egoPosition(withoutShip), { x: 9, y: 9, z: 9 });

  // Nothing at all: the origin, so distances are still finite numbers.
  assert.deepEqual(egoPosition(null), { x: 0, y: 0, z: 0 });
});

// --- R23: the generic action layer's two decoded fields ---------------------

test("R23: activeModuleIDs decodes to a list, long-aware", () => {
  const snapshot = decodeSpaceSnapshot({
    inSpace: true,
    entities: [],
    ship: {
      itemID: 9001,
      activeModuleIDs: [7700001, { type: "long", value: "7700002" }],
    },
  } as unknown as JsonValue);
  assert.deepEqual(snapshot.ship?.activeModuleIDs, [7700001, 7700002]);
});

test("R23: an ABSENT activeModuleIDs decodes to null — 'unknown', not 'nothing running'", () => {
  // This distinction is load-bearing. A gateway that could not answer must not
  // be reported to the player as "no modules are running": that reads as Idle
  // and invites a double activation.
  const snapshot = decodeSpaceSnapshot({
    inSpace: true,
    entities: [],
    ship: { itemID: 9001 },
  } as unknown as JsonValue);
  assert.equal(snapshot.ship?.activeModuleIDs, null);

  // An explicitly EMPTY list is a real answer and stays an empty list.
  const idle = decodeSpaceSnapshot({
    inSpace: true,
    entities: [],
    ship: { itemID: 9001, activeModuleIDs: [] },
  } as unknown as JsonValue);
  assert.deepEqual(idle.ship?.activeModuleIDs, []);
});

test("rack heat decodes rack by rack, and what is not said is not known", () => {
  const ship = (rackHeat: unknown) =>
    decodeSpaceSnapshot({
      inSpace: true,
      solarSystemID: 30000142,
      shipID: 9001,
      entities: [],
      ship: { itemID: 9001, typeID: 606, ...(rackHeat === undefined ? {} : { rackHeat }) },
    } as unknown as JsonValue).ship!;
  assert.deepEqual(ship({ high: 0.42, mid: 0, low: 1 }).rackHeat, { high: 0.42, mid: 0, low: 1 });
  // Absent (the gateway's snapshot), null, or not an object at all: not known, which is not cold.
  assert.equal(ship(undefined).rackHeat, null);
  assert.equal(ship(null).rackHeat, null);
  assert.equal(ship([0.1, 0.2, 0.3]).rackHeat, null);
  assert.equal(ship(0.5).rackHeat, null);
  // A rack left out, or given as something that is no number, is not known for that rack alone.
  assert.deepEqual(ship({ high: 0.25, mid: "hot", low: null }).rackHeat, { high: 0.25 });
  assert.deepEqual(ship({}).rackHeat, {});
  // A fraction is held to 0 to 1, and a name that is no rack is dropped.
  assert.deepEqual(ship({ high: 1.4, mid: -0.2, rig: 0.5 }).rackHeat, { high: 1, mid: 0 });
});

test("the range the ship was told to keep decodes as a distance, and is not known when it is not said", () => {
  const ship = (followRange: unknown) =>
    decodeSpaceSnapshot({
      inSpace: true,
      solarSystemID: 30000142,
      shipID: 9001,
      entities: [],
      ship: { itemID: 9001, typeID: 606, ...(followRange === undefined ? {} : { followRange }) },
    } as unknown as JsonValue).ship!;
  assert.equal(ship(7500).followRange, 7500);
  assert.equal(ship(0).followRange, 0);
  assert.equal(ship(50.5).followRange, 50.5);
  // Absent (the gateway's snapshot), null, less than nothing, or no number at all: not known.
  assert.equal(ship(undefined).followRange, null);
  assert.equal(ship(null).followRange, null);
  assert.equal(ship(-1).followRange, null);
  assert.equal(ship("far").followRange, null);
});

test("the point the ship is flying to decodes whole or not at all", () => {
  const ship = (gotoPoint: unknown) =>
    decodeSpaceSnapshot({
      inSpace: true,
      solarSystemID: 30000142,
      shipID: 9001,
      entities: [],
      ship: { itemID: 9001, typeID: 606, ...(gotoPoint === undefined ? {} : { gotoPoint }) },
    } as unknown as JsonValue).ship!;
  assert.deepEqual(ship({ x: 1e17, y: -2.5, z: 0 }).gotoPoint, { x: 1e17, y: -2.5, z: 0 });
  // Absent (the gateway's snapshot), null, or missing a coordinate: not known. Never a point at the origin.
  assert.equal(ship(undefined).gotoPoint, null);
  assert.equal(ship(null).gotoPoint, null);
  assert.equal(ship({ x: 1, y: 2 }).gotoPoint, null);
  assert.equal(ship({ x: 1, y: "2", z: 3 }).gotoPoint, null);
  assert.equal(ship([1, 2, 3]).gotoPoint, null);
});

test("the ship's warp decodes when it says whether the ship is lining up, and is nothing otherwise", () => {
  const ship = (warp: unknown) =>
    decodeSpaceSnapshot({
      inSpace: true,
      solarSystemID: 30000142,
      shipID: 9001,
      entities: [],
      ship: { itemID: 9001, typeID: 606, ...(warp === undefined ? {} : { warp }) },
    } as unknown as JsonValue).ship!;
  assert.deepEqual(ship({ preparing: true, point: { x: 1, y: 2, z: 3 }, destinationID: 40009089 }).warp, { preparing: true, point: { x: 1, y: 2, z: 3 }, destinationID: 40009089 });
  assert.deepEqual(ship({ preparing: false, point: null, destinationID: null }).warp, { preparing: false, point: null, destinationID: null });
  // A point missing a coordinate is no point; a destination that is no id is none.
  assert.deepEqual(ship({ preparing: false, point: { x: 1, y: 2 }, destinationID: "moon" }).warp, { preparing: false, point: null, destinationID: null });
  // Absent (the gateway's snapshot), null, or not saying whether it is lining up: nothing.
  assert.equal(ship(undefined).warp, null);
  assert.equal(ship(null).warp, null);
  assert.equal(ship([true]).warp, null);
  assert.equal(ship({ point: { x: 1, y: 2, z: 3 } }).warp, null);
  assert.equal(ship({ preparing: 1, point: { x: 1, y: 2, z: 3 } }).warp, null);
});

test("what the ship was aligned to decodes as a thing or a bookmark, and is nothing otherwise", () => {
  const ship = (alignTarget: unknown) =>
    decodeSpaceSnapshot({
      inSpace: true,
      solarSystemID: 30000142,
      shipID: 9001,
      entities: [],
      ship: { itemID: 9001, typeID: 606, ...(alignTarget === undefined ? {} : { alignTarget }) },
    } as unknown as JsonValue).ship!;
  assert.deepEqual(ship({ itemID: 40009089, bookmark: false }).alignTarget, { itemID: 40009089, bookmark: false });
  assert.deepEqual(ship({ itemID: null, bookmark: true }).alignTarget, { itemID: null, bookmark: true });
  // A bookmark has no thing behind it.
  assert.deepEqual(ship({ itemID: 5, bookmark: true }).alignTarget, { itemID: null, bookmark: true });
  // Absent (the gateway's snapshot), null, or naming neither: nothing.
  assert.equal(ship(undefined).alignTarget, null);
  assert.equal(ship(null).alignTarget, null);
  assert.equal(ship({ itemID: null, bookmark: false }).alignTarget, null);
  assert.equal(ship({ itemID: "moon" }).alignTarget, null);
  assert.equal(ship({ bookmark: "yes" }).alignTarget, null);
});

test("R23: the locked-target list decodes long-aware, and empties safely", () => {
  assert.deepEqual(
    decodeTargetIDs([50001248, { type: "long", value: "50001249" }] as unknown as JsonValue),
    [50001248, 50001249],
  );
  // A malformed or absent payload is an empty list, never a crash.
  assert.deepEqual(decodeTargetIDs(undefined), []);
  assert.deepEqual(decodeTargetIDs(null as unknown as JsonValue), []);
  assert.deepEqual(decodeTargetIDs({ nope: true } as unknown as JsonValue), []);
  // Junk entries are dropped rather than decoded to zero.
  assert.deepEqual(decodeTargetIDs([0, "x", 42] as unknown as JsonValue), [42]);
});

// ── The compression-facility field ───────────────────────────────────────────
//
// A ship row says whether that hull is a live ore-compression facility. The
// decoding rule that matters: anything unusable reads as NOT a facility, because
// a bot uses this field to decide whether compressing against that ship is even
// worth asking for.

test("a live facility decodes its range and typelists", () => {
  const snapshot = decodeSpaceSnapshot({
    inSpace: true,
    solarSystemID: 30000142,
    shipID: 9001,
    entities: [
      {
        kind: "ship",
        itemID: 7001,
        radius: 3000,
        position: { x: 1, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        compressionFacility: { rangeMeters: 60000, typeListIDs: [1, 2] },
      },
    ],
  } as unknown as JsonValue);
  const row = snapshot?.entities[0];
  assert.ok(row);
  assert.equal(row.compressionFacility?.rangeMeters, 60000);
  assert.deepEqual(row.compressionFacility?.typeListIDs, [1, 2]);
});

test("an absent, null, malformed or zero-range facility all decode as NOT a facility", () => {
  const rowFor = (facility: unknown): JsonValue => ({
    kind: "ship",
    itemID: 7001,
    radius: 3000,
    position: { x: 1, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    ...(facility === undefined ? {} : { compressionFacility: facility }),
  }) as unknown as JsonValue;

  for (const [label, facility] of [
    ["absent", undefined],
    ["null", null],
    ["not an object", 42],
    ["an array", []],
    ["no range", { typeListIDs: [1] }],
    ["zero range", { rangeMeters: 0, typeListIDs: [1] }],
    ["negative range", { rangeMeters: -5, typeListIDs: [1] }],
    ["unreadable range", { rangeMeters: "lots", typeListIDs: [1] }],
  ] as const) {
    const snapshot = decodeSpaceSnapshot({
      inSpace: true,
      solarSystemID: 30000142,
      shipID: 9001,
      entities: [rowFor(facility)],
    } as unknown as JsonValue);
    assert.equal(
      snapshot?.entities[0]?.compressionFacility ?? null,
      null,
      `${label} must not read as a usable facility`,
    );
  }
});

test("a facility with junk in its typelists keeps only the real ids", () => {
  const snapshot = decodeSpaceSnapshot({
    inSpace: true,
    solarSystemID: 30000142,
    shipID: 9001,
    entities: [
      {
        kind: "ship",
        itemID: 7001,
        radius: 3000,
        position: { x: 1, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        compressionFacility: { rangeMeters: 25000, typeListIDs: [1, 0, "two", null, 3] },
      },
    ],
  } as unknown as JsonValue);
  assert.deepEqual(snapshot?.entities[0]?.compressionFacility?.typeListIDs, [1, 3]);
});

// --- the rock's ore grade -----------------------------------------------------

test("oreGrade decodes present values, including a real zero, and absent stays null", () => {
  const rowFor = (extra: Record<string, unknown>): JsonValue =>
    ({
      kind: "asteroid",
      itemID: 7001,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      ...extra,
    }) as unknown as JsonValue;

  const graded = decodeSpaceSnapshot({
    inSpace: true,
    entities: [rowFor({ oreGrade: 3 })],
  } as unknown as JsonValue);
  assert.equal(graded.entities[0]?.oreGrade, 3);

  // 0-Grade is a real, meaningful grade — it must survive as 0, not become null.
  const zeroGrade = decodeSpaceSnapshot({
    inSpace: true,
    entities: [rowFor({ oreGrade: 0 })],
  } as unknown as JsonValue);
  assert.equal(zeroGrade.entities[0]?.oreGrade, 0);

  // Absent — a row that is not a rock, or one the BFF had no dogma for — is
  // "unknown", never 0.
  const absent = decodeSpaceSnapshot({
    inSpace: true,
    entities: [rowFor({})],
  } as unknown as JsonValue);
  assert.equal(absent.entities[0]?.oreGrade, null);
});

// --- the same object twice on the wire ---------------------------------------
//
// A repeated id is not a longer list, and a keyed `{#each}` handed the same key
// twice throws instead of rendering — which aborts the render flush and, because
// the poll re-reads these every tick, freezes the page for good. The wire is
// where it has to stop.

test("a locked-target list that repeats an id locks that target ONCE", () => {
  assert.deepEqual(decodeTargetIDs([9001, 9002, 9001, 9003, 9002]), [9001, 9002, 9003]);
});

test("a snapshot that carries the same ball twice draws one row for it", () => {
  const entity = (itemID: number, name: string): JsonValue =>
    ({
      kind: "ship",
      itemID,
      typeID: 670,
      name,
      radius: 25,
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 0, y: 0, z: 0 },
    }) as unknown as JsonValue;
  const snapshot = decodeSpaceSnapshot({
    inSpace: true,
    solarSystemID: 30000142,
    shipID: 9001,
    // The SECOND 7001 is the same object, not a second one.
    entities: [entity(7001, "Rifter"), entity(7002, "Punisher"), entity(7001, "Rifter")],
  } as unknown as JsonValue);
  assert.deepEqual(
    snapshot.entities.map((row) => row.itemID),
    [7001, 7002],
  );
  // First sighting wins, and the order of the rest is untouched.
  assert.equal(snapshot.entities[0]?.name, "Rifter");
});

test("the pace of the pilot's clock decodes as a number above nothing and no more than one, and is unknown otherwise", () => {
  const pace = (timeDilation: unknown) =>
    decodeSpaceSnapshot({
      inSpace: true,
      solarSystemID: 30000142,
      shipID: 9001,
      entities: [],
      ship: null,
      ...(timeDilation === undefined ? {} : { timeDilation }),
    } as unknown as JsonValue).timeDilation;
  assert.deepEqual([pace(1), pace(0.5), pace(0.1)], [1, 0.5, 0.1]);
  // Absent (the gateway's snapshot), null, not a number, or no pace a clock can hold.
  assert.deepEqual([pace(undefined), pace(null), pace("half"), pace(0), pace(-0.5), pace(1.5), pace([0.5])], [null, null, null, null, null, null, null]);
});

// importExportUI.py 94: the client knows which planet a customs office is from the office's slim item.
test("a customs office's row carries its planet where the BFF says it, and null where it does not", () => {
  const row = (more: { [key: string]: JsonValue }): JsonValue => ({
    kind: "orbital", itemID: 1200040176368, typeID: 2233, groupID: 1025, categoryID: 46, name: "Customs Office",
    radius: 1000, position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 0 }, ...more,
  });
  const snapshot = decodeSpaceSnapshot({ inSpace: true, solarSystemID: 30002780, shipID: 9001, sampledAtMs: 1, entities: [
    row({ planetID: 40176368 }), row({ itemID: 1200040176369 }), row({ itemID: 1200040176370, planetID: "x" }), row({ itemID: 1200040176371, planetID: 0 }),
  ] });
  assert.deepEqual(snapshot.entities.map((entity) => entity.planetID), [40176368, null, null, null]);
});

test("a scene with no ship in space is blind, not empty (seen live 2026-10-14)", () => {
  const dead = decodeSpaceSnapshot({ inSpace: true, entities: [], ship: null });
  assert.equal(dead.ship, null);
  assert.equal(isSceneBlind(true, dead), true);
  // Not in space (docked) there is no scene to be blind to.
  assert.equal(isSceneBlind(false, dead), false);
  assert.equal(isSceneBlind(null, dead), false);
  assert.equal(isSceneBlind(true, null), false);
});

test("a scene with the ship in it is never blind, however empty the grid", () => {
  const quiet = decodeSpaceSnapshot({
    inSpace: true,
    entities: [],
    ship: { itemID: 1200090000001, typeID: 17480, position: { x: 0, y: 0, z: 0 } },
  });
  assert.notEqual(quiet.ship, null);
  assert.equal(isSceneBlind(true, quiet), false);
});

test("the BFF's own stateValid: false makes a scene blind even with a ship in it", () => {
  const withShip = {
    inSpace: true,
    entities: [],
    ship: { itemID: 1200090000001, typeID: 17480, position: { x: 0, y: 0, z: 0 } },
  };
  const invalid = decodeSpaceSnapshot({ ...withShip, stateValid: false });
  assert.equal(invalid.stateValid, false);
  assert.equal(isSceneBlind(true, invalid), true);
  assert.equal(decodeSpaceSnapshot({ ...withShip, stateValid: true }).stateValid, true);
  assert.equal(decodeSpaceSnapshot(withShip).stateValid, undefined);
});
