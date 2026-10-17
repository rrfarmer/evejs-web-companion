// Space snapshot decoder (goal R11). The BFF returns the gateway's read-only
// projection of what the ship can see; this module turns it into plain
// SpaceEntity / SpaceShipStatus rows for the store.
//
// Decoder rule (docs/bridge-wire-contract.md): numeric IDs decode with
// unwrapLong — never the `typeof === "number" ? … : 0` pattern, which silently
// zeroes a {type:"long"} wrapper. Item/type/group/category IDs all fit in 2^53
// and are kept as `number`.
//
// Everything geometric stays raw here: distance, sorting and filtering are the
// browser's job (that is how the retail client works too), so this module only
// normalizes — it computes nothing.

import { unwrapLong, type JsonValue } from "./wire.ts";
import { decodeMiningBurstServices, decodeCompressionService } from "./miningSupportServices.ts";
import { decodeCoreMobilityFuel } from "./miningSupportCore.ts";
import { decodeModuleReach } from "./moduleReach.ts";
import type {
  CompressionFacility,
  SpaceEntity,
  ShipAlignTarget,
  ShipWarp,
  SpaceShipStatus,
  SpaceSnapshot,
  SpaceVector,
} from "../store/types.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

/** A game ID as a plain number (long-aware), or null. */
function idOrNull(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const long = unwrapLong(value);
  if (long === null) {
    return null;
  }
  const numeric = Number(long);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/** A finite float, or null. */
function floatOrNull(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A finite float, or `fallback`. */
function floatOr(value: JsonValue | undefined, fallback: number): number {
  const numeric = floatOrNull(value);
  return numeric === null ? fallback : numeric;
}

/** A 0-1 remaining fraction, or null when the object has no such layer. */
function ratioOrNull(value: JsonValue | undefined): number | null {
  const numeric = floatOrNull(value);
  if (numeric === null) {
    return null;
  }
  return Math.min(1, Math.max(0, numeric));
}

/** What was last aligned to: a thing by its id, or a bookmark; null when it says neither. */
function decodeAlignTarget(value: JsonValue | undefined): ShipAlignTarget | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, JsonValue>;
  const itemID = idOrNull(raw.itemID);
  const bookmark = raw.bookmark === true;
  return itemID === null && !bookmark ? null : { itemID: bookmark ? null : itemID, bookmark };
}

/** The ship's warp: null unless it is an object that says whether the ship is still lining up. */
function decodeWarp(value: JsonValue | undefined): ShipWarp | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, JsonValue>;
  if (typeof raw.preparing !== "boolean") {
    return null;
  }
  const effectStamp = typeof raw.effectStamp === "number" && Number.isSafeInteger(raw.effectStamp) ? { effectStamp: raw.effectStamp } : {};
  return {
    preparing: raw.preparing,
    point: pointOrNull(raw.point),
    destinationID: idOrNull(raw.destinationID),
    destinationName: typeof raw.destinationName === "string" ? raw.destinationName : null,
    actualPoint: pointOrNull(raw.actualPoint),
    ...effectStamp,
  };
}

/** A point whose three coordinates are all real numbers, or null. */
function pointOrNull(value: JsonValue | undefined): SpaceVector | null {
  const raw = asObject(value);
  const [x, y, z] = [floatOrNull(raw.x), floatOrNull(raw.y), floatOrNull(raw.z)];
  return x === null || y === null || z === null ? null : { x, y, z };
}

/** A distance in metres that is a real number and not less than nothing, or null. */
function rangeOrNull(value: JsonValue | undefined): number | null {
  const numeric = floatOrNull(value);
  return numeric === null || numeric < 0 ? null : numeric;
}

function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodeVector(value: JsonValue | undefined): SpaceVector {
  const raw = asObject(value);
  return {
    x: floatOr(raw.x, 0),
    y: floatOr(raw.y, 0),
    z: floatOr(raw.z, 0),
  };
}

function geometryAvailable(raw: Record<string, JsonValue>): boolean {
  const position = asObject(raw.position);
  return [position.x, position.y, position.z, raw.radius].every(value => typeof value === "number" && Number.isFinite(value))
    && (raw.radius as number) >= 0;
}

/** One overview row. Returns null for a row with no usable identity. */
function decodeEntity(value: JsonValue): SpaceEntity | null {
  const raw = asObject(value);
  const itemID = idOrNull(raw.itemID);
  if (itemID === null) {
    return null;
  }
  return {
    kind: stringOrNull(raw.kind),
    itemID,
    typeID: idOrNull(raw.typeID),
    groupID: idOrNull(raw.groupID),
    categoryID: idOrNull(raw.categoryID),
    name: stringOrNull(raw.name),
    ownerID: idOrNull(raw.ownerID),
    radius: floatOr(raw.radius, 0),
    geometryAvailable: geometryAvailable(raw),
    motionAvailable: [asObject(raw.velocity).x, asObject(raw.velocity).y, asObject(raw.velocity).z]
      .every(value => typeof value === "number" && Number.isFinite(value)),
    position: decodeVector(raw.position),
    velocity: decodeVector(raw.velocity),
    isSelf: raw.isSelf === true,
    shieldRatio: ratioOrNull(raw.shieldRatio),
    armorRatio: ratioOrNull(raw.armorRatio),
    hullRatio: ratioOrNull(raw.hullRatio),
    characterID: idOrNull(raw.characterID),
    corporationID: idOrNull(raw.corporationID),
    allianceID: idOrNull(raw.allianceID),
    // Security status is signed (-10..10), so it is NOT an id decode.
    securityStatus: floatOrNull(raw.securityStatus),
    maxVelocity: floatOrNull(raw.maxVelocity),
    mode: stringOrNull(raw.mode),
    capacitorRatio: ratioOrNull(raw.capacitorRatio),
    // R23 slice B — present on asteroid rows only. An ABSENT remainingQuantity
    // decodes to null ("unknown"), never 0: a zero reads as a mined-out rock
    // and would send a player straight past a full belt.
    remainingQuantity: countOrNull(raw.remainingQuantity),
    miningYieldTypeID: idOrNull(raw.miningYieldTypeID),
    // A customs office's planet, where the BFF says it.
    planetID: idOrNull(raw.planetID),
    // An acceleration gate's own object in its dungeon, where the BFF says it.
    dunObjectID: idOrNull(raw.dunObjectID),
    // An Abyssal trace's filament, game mode and whether it is open, where the BFF says them.
    ...(raw.abyssFilamentTypeID !== undefined ? {
      abyssFilamentTypeID: idOrNull(raw.abyssFilamentTypeID),
      gameModeID: typeof raw.gameModeID === "number" ? raw.gameModeID : null,
      isAbyssGateOpen: raw.isAbyssGateOpen === true,
    } : {}),
    beltID: idOrNull(raw.beltID),
    // The rock's ORE GRADE (dogma 2699), stamped by the BFF from static data.
    // An ABSENT oreGrade decodes to null ("unknown"), never 0: 0-Grade ore is a
    // real, meaningful grade and must not collide with "we don't know".
    oreGrade: countOrNull(raw.oreGrade),
    miningResourceFamily: raw.miningResourceFamily === "ice" || raw.miningResourceFamily === "ore" ? raw.miningResourceFamily : null,
    // ISK per m³ for the rock's ore, stamped by the BFF from static data. A
    // FLOAT read (it is a price, not a count) and absent decodes to null: an
    // unpriceable ore is unknown, never worthless.
    oreValuePerM3: floatOrNull(raw.oreValuePerM3),
    // R25 slice B — ship rows only. An ABSENT isNpc decodes to FALSE, which is
    // the safe direction: a row we cannot classify is treated as a person, so
    // the panel never invents a threat. npcEntityType stays null.
    isNpc: raw.isNpc === true,
    npcEntityType: stringOrNull(raw.npcEntityType),
    // R25 slice A — drone rows only.
    controllerID: idOrNull(raw.controllerID),
    droneActivity: stringOrNull(raw.droneActivity),
    targetEntityID: idOrNull(raw.targetEntityID),
    // IS THIS SHIP AN ORE-COMPRESSION FACILITY RIGHT NOW? Ship rows only, and
    // only while the hull really is running an Industrial Core plus a compression
    // module — the gateway projects it from the same state the retail client gets
    // in the slim item. An ABSENT field decodes to null ("not a facility"), which
    // is the safe direction: a bot must not treat a reading it did not get as an
    // invitation to try compressing.
    compressionFacility: decodeCompressionFacility(raw.compressionFacility),
    compressionService: decodeCompressionService(raw.compressionService),
  };
}

/**
 * A ship's live compression-facility state, or null when it is not one. The RANGE
 * is what a caller needs (the server refuses past it), so a facility whose range
 * cannot be read decodes to null rather than to a facility at 0 metres — an
 * unusable reading must not look like a usable one.
 */
function decodeCompressionFacility(value: JsonValue | undefined): CompressionFacility | null {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, JsonValue>;
  const rangeMeters = floatOrNull(raw.rangeMeters);
  if (rangeMeters === null || !(rangeMeters > 0)) {
    return null;
  }
  return {
    rangeMeters,
    typeListIDs: Array.isArray(raw.typeListIDs)
      ? raw.typeListIDs.map((entry) => idOrNull(entry)).filter((id): id is number => id !== null)
      : [],
  };
}

/**
 * A non-negative COUNT (long-aware), or null when the field is absent.
 *
 * Deliberately separate from idOrNull: a quantity of 0 is a real and meaningful
 * answer ("this rock is mined out"), whereas an ID of 0 is no ID at all.
 */
export function countOrNull(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const long = unwrapLong(value);
  if (long === null) {
    return null;
  }
  const numeric = Number(long);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : null;
}

function decodeShip(value: JsonValue | undefined): SpaceShipStatus | null {
  if (value === undefined || value === null) {
    return null;
  }
  const raw = asObject(value);
  return {
    motionAvailable: [asObject(raw.velocity).x, asObject(raw.velocity).y, asObject(raw.velocity).z]
      .every(value => typeof value === "number" && Number.isFinite(value)),
    itemID: idOrNull(raw.itemID),
    typeID: idOrNull(raw.typeID),
    name: stringOrNull(raw.name),
    mode: stringOrNull(raw.mode),
    maxVelocity: floatOrNull(raw.maxVelocity),
    radius: floatOr(raw.radius, 0),
    geometryAvailable: geometryAvailable(raw),
    position: decodeVector(raw.position),
    velocity: decodeVector(raw.velocity),
    shieldRatio: ratioOrNull(raw.shieldRatio),
    armorRatio: ratioOrNull(raw.armorRatio),
    hullRatio: ratioOrNull(raw.hullRatio),
    capacitorRatio: ratioOrNull(raw.capacitorRatio),
    shieldCapacity: floatOrNull(raw.shieldCapacity),
    armorCapacity: floatOrNull(raw.armorCapacity),
    hullCapacity: floatOrNull(raw.hullCapacity),
    // R23: which modules the SERVER says are cycling. An ABSENT field decodes
    // to null ("unknown"), not [] — a gateway that could not answer must never
    // be reported to the player as "nothing is running".
    activeModuleIDs: decodeIDList(raw.activeModuleIDs),
    // Which modules the SERVER says are OVERLOADED. Same contract as the line
    // above: an ABSENT field is null ("unknown"), never [] — and here that
    // distinction earns its keep, because "no heat" and "we could not tell" are
    // the difference between a rack that shows a cool ship and one that hides a
    // module quietly burning itself out.
    overloadedModuleIDs: decodeIDList(raw.overloadedModuleIDs),
    moduleDamage: decodeModuleDamage(raw.moduleDamage),
    weaponBanks: decodeWeaponBanks(raw.weaponBanks),
    rackHeat: decodeRackHeat(raw.rackHeat),
    followRange: rangeOrNull(raw.followRange),
    speedFraction: ratioOrNull(raw.speedFraction),
    gotoPoint: pointOrNull(raw.gotoPoint),
    warp: decodeWarp(raw.warp),
    alignTarget: decodeAlignTarget(raw.alignTarget),
    miningBurstServices: decodeMiningBurstServices(raw.miningBurstServices),
    coreMobilityFuel: decodeCoreMobilityFuel(raw.coreMobilityFuel),
    moduleReach: decodeModuleReach(raw.moduleReach),
    compressionService: decodeCompressionService(raw.compressionService),
    characterID: idOrNull(raw.characterID),
    ownerID: idOrNull(raw.ownerID),
  };
}

/**
 * How hot each rack is, { high, mid, low } as fractions. An absent field, or
 * one that is not an object, is null: not known. A rack the answer leaves out,
 * or gives as something that is no number, is left out here too, and reads as
 * not known for that rack alone.
 */
function decodeRackHeat(value: JsonValue | undefined): Readonly<Partial<Record<"high" | "mid" | "low", number>>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, JsonValue>;
  const out: Partial<Record<"high" | "mid" | "low", number>> = {};
  for (const family of ["high", "mid", "low"] as const) {
    const heat = ratioOrNull(record[family]);
    if (heat !== null) {
      out[family] = heat;
    }
  }
  return out;
}

/**
 * `{masterID: [slaveID, …]}` — which weapons are banked to which master.
 *
 * `null` when absent, and the distinction matters: `{}` is "nothing is banked",
 * `null` is "we could not read the banks". Activating a banked slave fires the
 * whole group through its MASTER, so a rack that assumed "nothing is banked"
 * would mis-report every banked fit.
 */
function decodeWeaponBanks(
  value: JsonValue | undefined,
): Readonly<Record<number, readonly number[]>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const banks: Record<number, readonly number[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const masterID = Number(key);
    if (!Number.isSafeInteger(masterID) || masterID <= 0 || !Array.isArray(raw)) {
      continue;
    }
    banks[masterID] = raw
      .map((entry) => (typeof entry === "number" && Number.isSafeInteger(entry) ? entry : 0))
      .filter((entry) => entry > 0);
  }
  return banks;
}

/**
 * `{itemID: 0..1}` damage per module — only the damaged ones appear.
 *
 * `null` when the field is absent or unreadable, and that distinction is the
 * point: `{}` means every module is intact, `null` means we could not look. A
 * page that showed "all fine" for a reading it never got would hide exactly the
 * damage overloading causes.
 */
function decodeModuleDamage(
  value: JsonValue | undefined,
): Readonly<Record<number, number>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const damage: Record<number, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const itemID = Number(key);
    const ratio = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    if (Number.isSafeInteger(itemID) && itemID > 0 && ratio !== null && ratio > 0) {
      damage[itemID] = Math.max(0, Math.min(1, ratio));
    }
  }
  return damage;
}

/** A list of game IDs (long-aware) — or null when the field is absent. */
function decodeIDList(value: JsonValue | undefined): readonly number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return (value as JsonValue[])
    .map((entry) => idOrNull(entry))
    .filter((entry): entry is number => entry !== null);
}

/**
 * An itemID is what identifies a ROW on screen, so a list of them that repeats
 * one is not a longer list — it is the same object twice, and Svelte's keyed
 * `{#each}` refuses to render it AT ALL (`each_key_duplicate`). That throw
 * aborts the render flush, and because these lists are re-read by the poll it
 * throws again every tick: the page freezes while the loops keep running.
 *
 * The wire is the right place to stop it. Nothing downstream can tell a
 * repeated id apart from a real second object, and there is no reading of "the
 * same ball twice on one grid" that is more true than "once". Order is kept and
 * the first sighting wins.
 */
function distinctIDs(ids: readonly number[]): readonly number[] {
  const seen = new Set<number>();
  return ids.filter((id) => (seen.has(id) ? false : (seen.add(id), true)));
}

/**
 * The itemIDs the server says are locked, from the targets read (goal R23).
 * Shared by the poll and by every lock/unlock re-read, because both answer the
 * same `targetIDs` array — the ONLY authority on what is locked.
 */
export function decodeTargetIDs(raw: JsonValue | undefined): readonly number[] {
  return distinctIDs(decodeIDList(raw) ?? []);
}

/** The pace of the pilot's clock: a number above nothing and no more than one, or not known. */
function paceOrNull(value: JsonValue | undefined): number | null {
  const pace = floatOrNull(value);
  return pace !== null && pace > 0 && pace <= 1 ? pace : null;
}

export function decodeSpaceSnapshot(raw: JsonValue | undefined): SpaceSnapshot {
  const space = asObject(raw);
  const seen = new Set<number>();
  const entities = Array.isArray(space.entities)
    ? (space.entities as JsonValue[])
        .map(decodeEntity)
        .filter((row): row is SpaceEntity => row !== null)
        // Same rule as distinctIDs, applied to the rows themselves: every
        // overview list keys off entity.itemID.
        .filter((row) => (seen.has(row.itemID) ? false : (seen.add(row.itemID), true)))
    : [];
  return {
    inSpace: space.inSpace === true,
    solarSystemID: idOrNull(space.solarSystemID),
    shipID: idOrNull(space.shipID),
    sampledAtMs: floatOrNull(space.sampledAtMs),
    entities,
    ship: decodeShip(space.ship),
    timeDilation: paceOrNull(space.timeDilation),
    ...(typeof space.stateValid === "boolean" ? { stateValid: space.stateValid } : {}),
  };
}

/**
 * ⚠ A BLIND SCENE IS UNKNOWN, NOT EMPTY (seen live 2026-10-14 12:00:11 UTC). A fleet
 * companion's ballpark on the BFF went invalid and the space read then answered
 * `{inSpace:true, entities:[], ship:null}` with a 200 for ten minutes. Decoded, that
 * is a snapshot like any other, so "no hostile on grid", "no drones out" and "the
 * grid is clear" were all read off a scene nobody could see: the clear-grid reload
 * fired mid-fight and the rejoin stood by for ever.
 *
 * A pilot that is in space always has a ship in its own scene, so no ship there
 * (or the BFF saying `stateValid: false`) means the read failed, whatever the
 * entity list says. Callers make every fact they would derive from the entities
 * `null` -- cannot tell -- rather than false.
 */
export function isSceneBlind(inSpace: boolean | null | undefined, snapshot: SpaceSnapshot | null): boolean {
  if (inSpace !== true || snapshot === null) {
    return false;
  }
  return snapshot.ship === null || snapshot.stateValid === false;
}

/** The origin the browser measures distances from (the ship's own position). */
export function egoPosition(snapshot: SpaceSnapshot | null): SpaceVector {
  if (!snapshot) {
    return ORIGIN;
  }
  if (snapshot.ship) {
    return snapshot.ship.position;
  }
  const self = snapshot.entities.find((entity) => entity.isSelf);
  return self ? self.position : ORIGIN;
}
