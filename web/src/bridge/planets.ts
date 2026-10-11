// The character's planetary colonies, as pure functions (goal R41).
//
// ---------------------------------------------------------------------------
// NOTHING HERE SIMULATES A COLONY.
//
// Extraction yield curves, cycle scheduling, routing throughput and storage
// capacity are ALL the emulator's. It runs the colony forward in
// planetRuntimeStore and stores the result; the BFF copies those numbers across
// and names the types. This module only ARRANGES them: it counts pins by what
// they do, orders them so the interesting ones come first, and turns two
// instants into "running" or "finished".
//
// ---------------------------------------------------------------------------
// TIME IS THE SERVER'S.
//
// `expiresAtMs` arrives as epoch milliseconds next to `serverNowMs` sampled in
// the SAME read, so `clockOffsetMs` corrects a browser clock that is wrong.
// Deciding whether a program has run out is the ONLY judgement this module
// makes about time, and it makes it against the server's clock.
//
// ---------------------------------------------------------------------------
// AN ABSENCE IS NOT A FACT.
//
// `coloniesReadable` distinguishes "the snapshot carried a colony table and
// none of it is yours" from "this gateway reported no colony table at all".
// Only the first justifies telling a player they have no colonies.

import type { JsonValue } from "./wire.ts";
import type {
  Colony,
  ColonyExtractionProgram,
  ColonyLink,
  ColonyPin,
  ColonyPinKind,
  ColonyReport,
  ColonyRoute,
  ColonyStoredItem,
  PlanetResource,
} from "../store/types.ts";

const PIN_KINDS: readonly ColonyPinKind[] = Object.freeze([
  "command",
  "extractor-control",
  "extractor",
  "factory",
  "storage",
  "launchpad",
  "other",
]);

/** Reading order: what you decide about first comes first. */
const PIN_KIND_ORDER: Readonly<Record<ColonyPinKind, number>> = Object.freeze({
  "extractor-control": 0,
  extractor: 1,
  factory: 2,
  launchpad: 3,
  storage: 4,
  command: 5,
  other: 6,
});

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: JsonValue | undefined, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** An instant, or null when the server had none. Never coerced to 0 (= 1601). */
function asInstant(value: JsonValue | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/** A name, or null. Never a stringified id — R7d. */
function asName(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A volume in m³, or null when the BFF could not say.
 *
 * ⚠ NULL IS NOT 0, AND THIS ONE DIVIDES. A pin's fill is usedM3 / capacityM3;
 * an unknown capacity coerced to 0 divides by zero, and an unknown used volume
 * coerced to 0 reports an overflowing launchpad as empty. 0 itself is a real
 * answer (an empty pin) and is kept — only a missing or nonsense field is null.
 */
function asVolume(value: JsonValue | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

/** A positive id, or null. */
function asIdentifier(value: JsonValue | undefined): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * A three-state flag: true, false, or "the server said nothing".
 *
 * The emulator carries the two processor flags on process pins ONLY, so an
 * absent flag means this pin has no such state — never that it is starved.
 */
function asFlag(value: JsonValue | undefined): boolean | null {
  return value === true ? true : value === false ? false : null;
}

function decodePinKind(value: JsonValue | undefined): ColonyPinKind {
  const text = typeof value === "string" ? value : "";
  return (PIN_KINDS as readonly string[]).includes(text)
    ? (text as ColonyPinKind)
    : "other";
}

function decodeStoredItem(value: JsonValue): ColonyStoredItem | null {
  const record = asRecord(value);
  const typeID = asNumber(record.typeID);
  const quantity = asNumber(record.quantity);
  if (!Number.isSafeInteger(typeID) || typeID <= 0 || quantity <= 0) {
    return null;
  }
  return {
    typeID,
    typeName: asName(record.typeName) ?? "",
    quantity,
  };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const whole = (value: unknown): value is number => Number.isInteger(value);

/** A unit's heads, each (head, latitude, longitude), or null where what was read is not that throughout. */
function decodeHeads(value: JsonValue | undefined): readonly (readonly [number, number, number])[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const heads: (readonly [number, number, number])[] = [];
  for (const each of value) {
    if (!Array.isArray(each) || each.length !== 3) {
      return null;
    }
    const [head, latitude, longitude] = each;
    if (!whole(head) || head < 0 || !finite(latitude) || !finite(longitude)) {
      return null;
    }
    heads.push([head, latitude, longitude]);
  }
  return heads;
}

function decodeProgram(value: JsonValue | undefined): ColonyExtractionProgram | null {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  return {
    resourceTypeID: asNumber(record.resourceTypeID),
    resourceTypeName: asName(record.resourceTypeName),
    cycleTimeSeconds: asNumber(record.cycleTimeSeconds),
    quantityPerCycle: asNumber(record.quantityPerCycle),
    installedAtMs: asInstant(record.installedAtMs),
    expiresAtMs: asInstant(record.expiresAtMs),
    headCount: asNumber(record.headCount),
    maxOutputPerCycle:
      typeof record.maxOutputPerCycle === "number" && Number.isFinite(record.maxOutputPerCycle)
        && record.maxOutputPerCycle > 0
        ? record.maxOutputPerCycle
        : null,
    headRadius:
      typeof record.headRadius === "number" && Number.isFinite(record.headRadius) && record.headRadius > 0
        ? record.headRadius
        : null,
    heads: decodeHeads(record.heads),
    noiseFactor: finite(record.noiseFactor) && record.noiseFactor >= 0 ? record.noiseFactor : null,
  };
}

function decodePin(value: JsonValue): ColonyPin | null {
  const record = asRecord(value);
  const pinID = asNumber(record.pinID);
  if (!Number.isSafeInteger(pinID) || pinID <= 0) {
    return null;
  }
  return {
    pinID,
    typeID: asNumber(record.typeID),
    typeName: asName(record.typeName) ?? "",
    kind: decodePinKind(record.kind),
    contents: asArray(record.contents)
      .map(decodeStoredItem)
      .filter((item): item is ColonyStoredItem => item !== null),
    usedM3: asVolume(record.usedM3),
    capacityM3: asVolume(record.capacityM3),
    schematicID: asIdentifier(record.schematicID),
    schematicName: asName(record.schematicName),
    hasReceivedInputs: asFlag(record.hasReceivedInputs),
    receivedInputsLastCycle: asFlag(record.receivedInputsLastCycle),
    active: asFlag(record.active),
    lastRunAtMs: asInstant(record.lastRunAtMs),
    lastLaunchAtMs: asInstant(record.lastLaunchAtMs),
    program: decodeProgram(record.program),
  };
}

function decodeLink(value: JsonValue): ColonyLink | null {
  const record = asRecord(value);
  const endpoint1 = asNumber(record.endpoint1);
  const endpoint2 = asNumber(record.endpoint2);
  if (endpoint1 <= 0 || endpoint2 <= 0) {
    return null;
  }
  return { endpoint1, endpoint2, level: asNumber(record.level) };
}

function decodeRoute(value: JsonValue): ColonyRoute | null {
  const record = asRecord(value);
  const routeID = asNumber(record.routeID);
  if (!Number.isSafeInteger(routeID) || routeID <= 0) {
    return null;
  }
  return {
    routeID,
    path: asArray(record.path).map((entry) => asNumber(entry)),
    commodityTypeID: asNumber(record.commodityTypeID),
    commodityTypeName: asName(record.commodityTypeName),
    commodityQuantity: asNumber(record.commodityQuantity),
  };
}

function decodeColony(value: JsonValue): Colony | null {
  const record = asRecord(value);
  const planetID = asNumber(record.planetID);
  if (!Number.isSafeInteger(planetID) || planetID <= 0) {
    return null;
  }
  const pins = asArray(record.pins)
    .map(decodePin)
    .filter((pin): pin is ColonyPin => pin !== null)
    .slice()
    .sort((left, right) => (
      PIN_KIND_ORDER[left.kind] - PIN_KIND_ORDER[right.kind]
      || left.pinID - right.pinID
    ));
  return {
    planetID,
    planetName: asName(record.planetName),
    solarSystemID: asNumber(record.solarSystemID),
    solarSystemName: asName(record.solarSystemName),
    planetTypeID: asNumber(record.planetTypeID),
    planetTypeName: asName(record.planetTypeName),
    commandCenterLevel: asNumber(record.commandCenterLevel),
    lastSimulatedAtMs: asInstant(record.lastSimulatedAtMs),
    pins,
    linkCount: asNumber(record.linkCount),
    links: asArray(record.links)
      .map(decodeLink)
      .filter((link): link is ColonyLink => link !== null),
    routes: asArray(record.routes)
      .map(decodeRoute)
      .filter((route): route is ColonyRoute => route !== null),
    resources: decodeResources(record.resources),
  };
}

/** A planet's resources, or null when the read carried none (unknown, not empty). */
function decodeResources(value: JsonValue | undefined): readonly PlanetResource[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const resources: PlanetResource[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const typeID = asIdentifier(record.typeID);
    if (typeID === null) {
      continue;
    }
    const quality = record.quality === null || record.quality === undefined ? NaN : Number(record.quality);
    resources.push({
      typeID,
      typeName: asName(record.typeName),
      quality: Number.isFinite(quality) ? quality : null,
    });
  }
  return resources;
}

/**
 * Decode GET /api/bridge/planets.
 *
 * `readAtMs` is the browser's clock at the moment the read landed; the
 * difference from the server's own `serverNowMs` is kept so every later
 * "has this expired?" is answered on the server's clock.
 */
export function decodeColonyReport(value: JsonValue, readAtMs: number): ColonyReport {
  const record = asRecord(value);
  const serverNowMs = asInstant(record.serverNowMs);
  return {
    colonies: asArray(record.colonies)
      .map(decodeColony)
      .filter((colony): colony is Colony => colony !== null),
    coloniesReadable: record.coloniesReadable === true,
    clockOffsetMs: serverNowMs === null ? 0 : serverNowMs - readAtMs,
  };
}

/** What the SERVER would call now, on a browser whose clock is wrong. */
export function serverNow(clockOffsetMs: number, browserNowMs: number): number {
  return browserNowMs + clockOffsetMs;
}

/** How a colony reads at a glance, without opening it. */
export interface ColonySummary {
  readonly extractorCount: number;
  readonly factoryCount: number;
  readonly storageCount: number;
  /** Extractor programs whose expiry has PASSED on the server's clock. */
  readonly expiredProgramCount: number;
  /** Extractor programs still running. */
  readonly runningProgramCount: number;
  /** The soonest program expiry still in the future, or null when none is. */
  readonly nextExpiryMs: number | null;
}

export function summarizeColony(colony: Colony, serverNowMs: number): ColonySummary {
  let extractorCount = 0;
  let factoryCount = 0;
  let storageCount = 0;
  let expiredProgramCount = 0;
  let runningProgramCount = 0;
  let nextExpiryMs: number | null = null;

  for (const pin of colony.pins) {
    if (pin.kind === "extractor-control" || pin.kind === "extractor") {
      extractorCount += 1;
    } else if (pin.kind === "factory") {
      factoryCount += 1;
    } else if (pin.kind === "storage" || pin.kind === "launchpad") {
      storageCount += 1;
    }
    const expiresAtMs = pin.program?.expiresAtMs ?? null;
    if (expiresAtMs === null) {
      continue;
    }
    if (expiresAtMs <= serverNowMs) {
      expiredProgramCount += 1;
      continue;
    }
    runningProgramCount += 1;
    if (nextExpiryMs === null || expiresAtMs < nextExpiryMs) {
      nextExpiryMs = expiresAtMs;
    }
  }

  return {
    extractorCount,
    factoryCount,
    storageCount,
    expiredProgramCount,
    runningProgramCount,
    nextExpiryMs,
  };
}

/**
 * How far through its installed run a program is, from 0 to 1.
 *
 * Clamped at both ends: a program cannot be less than started, and it cannot
 * appear to run past its own expiry while we wait for the next read. Null when
 * the server did not give both instants — an unknown is shown as unknown, not
 * as zero progress.
 */
export function programProgress(
  program: ColonyExtractionProgram,
  serverNowMs: number,
): number | null {
  const { installedAtMs, expiresAtMs } = program;
  if (installedAtMs === null || expiresAtMs === null || expiresAtMs <= installedAtMs) {
    return null;
  }
  const elapsed = serverNowMs - installedAtMs;
  const span = expiresAtMs - installedAtMs;
  return Math.min(1, Math.max(0, elapsed / span));
}

/** True only when the server gave an expiry AND it has passed. */
export function programHasExpired(
  program: ColonyExtractionProgram,
  serverNowMs: number,
): boolean {
  return program.expiresAtMs !== null && program.expiresAtMs <= serverNowMs;
}

/** Every commodity on the planet, pooled across pins, biggest pile first. */
export function pooledContents(colony: Colony): readonly ColonyStoredItem[] {
  const byTypeID = new Map<number, ColonyStoredItem>();
  for (const pin of colony.pins) {
    for (const item of pin.contents) {
      const existing = byTypeID.get(item.typeID);
      byTypeID.set(item.typeID, existing
        ? { ...existing, quantity: existing.quantity + item.quantity }
        : item);
    }
  }
  return [...byTypeID.values()].sort((left, right) => right.quantity - left.quantity);
}

/** "2 days", "7 hours", "in a moment" — never a bare number of milliseconds. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return "under a minute";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const spareMinutes = minutes % 60;
    return spareMinutes
      ? `${hours}h ${spareMinutes}m`
      : `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.floor(hours / 24);
  const spareHours = hours % 24;
  return spareHours
    ? `${days}d ${spareHours}h`
    : `${days} day${days === 1 ? "" : "s"}`;
}

/** A place, in the words a player uses for it. Never an id (R7d). */
export function colonyPlaceWords(colony: Colony): string {
  if (colony.planetName) {
    return colony.planetName;
  }
  if (colony.solarSystemName) {
    return `a planet in ${colony.solarSystemName}`;
  }
  return "a planet this map does not name";
}
