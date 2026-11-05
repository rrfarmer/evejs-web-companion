// Expansion: where the roster's free colony slots should go, so the basics
// (P1) come out as evenly as the balanced aim asks (bridge/piCoverage.ts).
//
// ---------------------------------------------------------------------------
// ONE SLOT AT A TIME, TO THE BASIC FURTHEST BEHIND.
//
// Each free slot goes to the basic whose output, counting what is already
// proposed, sits lowest against its balanced weight; then to the best planet
// in range that carries its raw resource; then to a pilot with a free slot who
// is not already on that planet. Repeating that fills the basics up level, like
// water, instead of piling every slot onto the biggest gap. A proposed colony
// is counted at the roster's typical colony output, because a planet nobody
// has drilled has no rate of its own yet.
//
// ---------------------------------------------------------------------------
// THE BEST PLANET, AND WHAT "BEST" MAY NOT SKIP.
//
// Richer beats poorer. Nullsec beats lowsec and highsec unless it is poorer by
// more than the player's tolerance: at 0.2, a nullsec planet of 104 loses to a
// lowsec one of 135 (104 < 0.8 x 135) and beats one of 125. A planet whose
// richness was never read ranks below every planet that was, and among those
// unknowns nullsec and nearness decide. Never proposed: a resource someone on
// the roster already drills on that planet (the drills would share one field),
// and a second colony for one pilot on one planet (the game allows one).

import type { Colony } from "../../../web/src/plugin-api/index.ts";
import type { Coverage } from "./piCoverage.ts";
import { commodityName, tierOf, type PiRecipeBook } from "../../../web/src/plugin-api/index.ts";
import type { PilotColonyReading } from "./piRoster.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";

/** A planet within reach, as the static map describes it. */
export interface PlanetNear {
  readonly planetID: number;
  readonly planetName: string | null;
  readonly planetTypeID: number;
  readonly planetTypeName: string | null;
  readonly solarSystemID: number;
  readonly solarSystemName: string | null;
  readonly security: number | null;
  readonly jumps: number;
  readonly resourceTypeIDs: readonly number[];
}

/** Decode GET /api/pi/planets-near. A row missing its id, type or system is dropped. */
export function decodePlanetsNear(value: JsonValue): { readonly originName: string | null; readonly planets: readonly PlanetNear[] } {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
  const origin = record.origin && typeof record.origin === "object" && !Array.isArray(record.origin)
    ? record.origin as Record<string, JsonValue>
    : {};
  const text = (raw: JsonValue | undefined): string | null => (typeof raw === "string" && raw.length > 0 ? raw : null);
  const id = (raw: JsonValue | undefined): number | null =>
    typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  const planets: PlanetNear[] = [];
  for (const entry of Array.isArray(record.planets) ? record.planets : []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const o = entry as Record<string, JsonValue>;
    const planetID = id(o.planetID);
    const planetTypeID = id(o.planetTypeID);
    const solarSystemID = id(o.solarSystemID);
    if (planetID === null || planetTypeID === null || solarSystemID === null) continue;
    planets.push({
      planetID,
      planetName: text(o.planetName),
      planetTypeID,
      planetTypeName: text(o.planetTypeName),
      solarSystemID,
      solarSystemName: text(o.solarSystemName),
      security: typeof o.security === "number" && Number.isFinite(o.security) ? o.security : null,
      jumps: typeof o.jumps === "number" && Number.isInteger(o.jumps) && o.jumps >= 0 ? o.jumps : 0,
      resourceTypeIDs: Array.isArray(o.resourceTypeIDs) ? o.resourceTypeIDs.map(id).filter((typeID): typeID is number => typeID !== null) : [],
    });
  }
  return { originName: text(origin.solarSystemName), planets };
}

/** A pilot who may take colonies, with the skills that bound them. */
export interface ExpansionPilot {
  readonly characterID: number;
  readonly name: string;
  /** Colonies it may still found: 1 + Interplanetary Consolidation, less what it has. */
  readonly freeSlots: number;
  /** Command Center Upgrades: the highest level its command centres can reach. */
  readonly commandCenterLevel: number;
}

export interface ExpansionInput {
  readonly book: PiRecipeBook;
  readonly coverage: Coverage;
  readonly demand: ReadonlyMap<number, number>;
  readonly pilots: readonly ExpansionPilot[];
  readonly planets: readonly PlanetNear[];
  /** planetID -> resourceTypeID -> quality, for every planet whose richness is known. */
  readonly richness: ReadonlyMap<number, ReadonlyMap<number, number>>;
  readonly readings: ReadonlyMap<number, PilotColonyReading>;
  /** 0 to 1: how much poorer a nullsec planet may be and still be preferred. */
  readonly nullsecTolerance: number;
}

export interface ExpansionRow {
  readonly characterID: number;
  readonly ownerName: string;
  readonly planet: PlanetNear;
  readonly resourceTypeID: number;
  readonly resourceName: string;
  readonly productTypeID: number;
  readonly productName: string;
  readonly quality: number | null;
  readonly commandCenterLevel: number;
}

export interface ExpansionProposal {
  readonly rows: readonly ExpansionRow[];
  /** Free slots no basic could use: nothing in range was left to drill for them. */
  readonly unusedSlots: number;
}

/** The raw resource each basic is refined from, by the recipes. */
export function basicSources(book: PiRecipeBook): ReadonlyMap<number, number> {
  const out = new Map<number, number>();
  for (const recipe of book.schematics) {
    const only = recipe.inputs.length === 1 ? recipe.inputs[0] : undefined;
    if (only && tierOf(book, recipe.output.typeID) === 1 && tierOf(book, only.typeID) === 0) {
      out.set(recipe.output.typeID, only.typeID);
    }
  }
  return out;
}

function isNullsec(planet: PlanetNear): boolean {
  return planet.security !== null && planet.security <= 0;
}

/** Higher is better; see the header. Unknown richness sorts below any known. */
function planetScore(planet: PlanetNear, quality: number | null, tolerance: number): number {
  if (quality === null) return -1000 + (isNullsec(planet) ? 100 : 0) - planet.jumps;
  return (isNullsec(planet) ? quality : quality * (1 - tolerance)) - planet.jumps * 1e-3;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2;
}

/** Which raw resources are drilled on which planet, by anyone on the roster. */
function drilled(readings: ReadonlyMap<number, PilotColonyReading>): Set<string> {
  const out = new Set<string>();
  for (const reading of readings.values()) {
    for (const colony of reading.report.colonies) {
      for (const pin of colony.pins) {
        if (pin.program) out.add(`${colony.planetID}:${pin.program.resourceTypeID}`);
      }
    }
  }
  return out;
}

export function proposeExpansion(input: ExpansionInput): ExpansionProposal {
  const { book, coverage, demand, readings, nullsecTolerance } = input;
  const tolerance = Math.min(1, Math.max(0, nullsecTolerance));
  const sources = basicSources(book);
  const basics = coverage.lines.filter((line) => line.tier === 1 && sources.has(line.typeID) && (demand.get(line.typeID) ?? 0) > 0);
  const typical = median(basics.flatMap((line) => line.sources.map((source) => source.perHour)).filter((rate) => rate > 0)) || 1;

  const output = new Map(basics.map((line) => [line.typeID, line.perHour]));
  const taken = drilled(readings);
  const onPlanet = new Map<number, Set<number>>();
  for (const [characterID, reading] of readings) {
    onPlanet.set(characterID, new Set(reading.report.colonies.map((colony) => colony.planetID)));
  }
  const slots = new Map(input.pilots.map((pilot) => [pilot.characterID, Math.max(0, pilot.freeSlots)]));
  const pilotSystems = new Map<number, Set<number>>();
  const systemOf = new Map(input.planets.map((planet) => [planet.planetID, planet.solarSystemID]));
  for (const [characterID, reading] of readings) {
    pilotSystems.set(characterID, new Set(reading.report.colonies.map((colony) => colony.solarSystemID)));
  }

  const qualityOf = (planetID: number, resourceTypeID: number): number | null =>
    input.richness.get(planetID)?.get(resourceTypeID) ?? null;
  const pilotFor = (planetID: number): typeof input.pilots[number] | null => {
    const systemID = systemOf.get(planetID);
    const free = input.pilots.filter((pilot) =>
      (slots.get(pilot.characterID) ?? 0) > 0 && !(onPlanet.get(pilot.characterID)?.has(planetID) ?? false));
    free.sort((left, right) => {
      const leftHere = systemID !== undefined && (pilotSystems.get(left.characterID)?.has(systemID) ?? false) ? 1 : 0;
      const rightHere = systemID !== undefined && (pilotSystems.get(right.characterID)?.has(systemID) ?? false) ? 1 : 0;
      return rightHere - leftHere
        || (slots.get(right.characterID) ?? 0) - (slots.get(left.characterID) ?? 0)
        || left.characterID - right.characterID;
    });
    return free[0] ?? null;
  };
  /** The best open planet for a resource, with a pilot to take it, or null. */
  const bestFor = (resourceTypeID: number) => {
    let best: { planet: PlanetNear; pilot: ExpansionPilot; score: number } | null = null;
    for (const planet of input.planets) {
      if (!planet.resourceTypeIDs.includes(resourceTypeID) || taken.has(`${planet.planetID}:${resourceTypeID}`)) continue;
      const score = planetScore(planet, qualityOf(planet.planetID, resourceTypeID), tolerance);
      if (best !== null && score <= best.score) continue;
      const pilot = pilotFor(planet.planetID);
      if (pilot !== null) best = { planet, pilot, score };
    }
    return best;
  };

  const rows: ExpansionRow[] = [];
  const stuck = new Set<number>();
  let remaining = [...slots.values()].reduce((total, count) => total + count, 0);
  while (remaining > 0) {
    const open = basics.filter((line) => !stuck.has(line.typeID));
    if (open.length === 0) break;
    open.sort((left, right) =>
      (output.get(left.typeID) ?? 0) / (demand.get(left.typeID) ?? 1) - (output.get(right.typeID) ?? 0) / (demand.get(right.typeID) ?? 1)
      || left.typeID - right.typeID);
    const basic = open[0]!;
    const resourceTypeID = sources.get(basic.typeID)!;
    const pick = bestFor(resourceTypeID);
    if (pick === null) {
      stuck.add(basic.typeID);
      continue;
    }
    rows.push({
      characterID: pick.pilot.characterID,
      ownerName: pick.pilot.name,
      planet: pick.planet,
      resourceTypeID,
      resourceName: commodityName(book, resourceTypeID) ?? "A resource this table does not name",
      productTypeID: basic.typeID,
      productName: basic.typeName,
      quality: qualityOf(pick.planet.planetID, resourceTypeID),
      commandCenterLevel: pick.pilot.commandCenterLevel,
    });
    output.set(basic.typeID, (output.get(basic.typeID) ?? 0) + typical);
    taken.add(`${pick.planet.planetID}:${resourceTypeID}`);
    const planets = onPlanet.get(pick.pilot.characterID) ?? new Set<number>();
    planets.add(pick.planet.planetID);
    onPlanet.set(pick.pilot.characterID, planets);
    const systems = pilotSystems.get(pick.pilot.characterID) ?? new Set<number>();
    systems.add(pick.planet.solarSystemID);
    pilotSystems.set(pick.pilot.characterID, systems);
    slots.set(pick.pilot.characterID, (slots.get(pick.pilot.characterID) ?? 1) - 1);
    remaining -= 1;
  }
  return { rows, unusedSlots: remaining };
}

// --- a saved plan against the live colonies ---------------------------------

/** What a saved row asked for: who, where, and which resource. */
export interface ExpansionRowRef {
  readonly characterID: number;
  readonly planetID: number;
  readonly resourceTypeID: number;
}

export type ExpansionRowState = "built" | "other-resource" | "not-built";

/**
 * Whether a row stands built: that pilot has a colony on that planet drilling
 * that resource. A colony there drilling something else is said as such.
 */
export function rowState(row: ExpansionRowRef, readings: ReadonlyMap<number, PilotColonyReading>): ExpansionRowState {
  const colony = readings.get(row.characterID)?.report.colonies.find((entry) => entry.planetID === row.planetID);
  if (!colony) return "not-built";
  return colony.pins.some((pin) => pin.program?.resourceTypeID === row.resourceTypeID) ? "built" : "other-resource";
}

/** Command centres still to buy for the rows not built yet, by planet type, most first. */
export function commandCentresToBuy(
  rows: readonly { readonly planetTypeName: string | null; readonly state: ExpansionRowState }[],
): readonly { readonly planetTypeName: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.state !== "not-built") continue;
    const name = (row.planetTypeName ?? "Unknown planet").replace(/^Planet \((.*)\)$/, "$1");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .map(([planetTypeName, count]) => ({ planetTypeName, count }))
    .sort((left, right) => right.count - left.count || left.planetTypeName.localeCompare(right.planetTypeName));
}

/**
 * The roster's own best single-basic colony at this command-centre level, to
 * copy: the one drilling the most. Null when the roster has none at that level.
 */
export function layoutToCopy(
  level: number,
  readings: ReadonlyMap<number, PilotColonyReading>,
  names: ReadonlyMap<number, string>,
): { readonly words: string } | null {
  let best: { colony: Colony; ownerName: string; perHour: number } | null = null;
  for (const [characterID, reading] of readings) {
    for (const colony of reading.report.colonies) {
      if (colony.commandCenterLevel !== level) continue;
      const recipes = new Set(colony.pins.filter((pin) => pin.kind === "factory").map((pin) => pin.schematicID));
      if (recipes.size !== 1) continue;
      const perHour = colony.pins.reduce((total, pin) =>
        pin.program && pin.program.cycleTimeSeconds > 0 ? total + (pin.program.quantityPerCycle * 3600) / pin.program.cycleTimeSeconds : total, 0);
      if (best === null || perHour > best.perHour) {
        best = { colony, ownerName: names.get(characterID) ?? "a roster pilot", perHour };
      }
    }
  }
  if (best === null) return null;
  const extractors = best.colony.pins.filter((pin) => pin.program);
  const heads = extractors.map((pin) => pin.program!.headCount).join(" + ");
  const factories = best.colony.pins.filter((pin) => pin.kind === "factory").length;
  const where = best.colony.planetName ?? "a planet this map does not name";
  return {
    words: `Layout like ${best.ownerName}'s ${where}: ${extractors.length} extractor${extractors.length === 1 ? "" : "s"} (${heads} heads), ${factories} factor${factories === 1 ? "y" : "ies"}`,
  };
}

// --- shaping for the window ---------------------------------------------------

/**
 * The roster pilots who may take colonies, with their free slots. A pilot
 * whose skill sheet was not read is listed apart: its slots are unknown, so it
 * is never planned for and never counted as full.
 */
export function expansionPilots(
  members: readonly number[],
  readings: ReadonlyMap<number, PilotColonyReading>,
  names: ReadonlyMap<number, string>,
): { readonly pilots: readonly ExpansionPilot[]; readonly unknown: readonly number[] } {
  const pilots: ExpansionPilot[] = [];
  const unknown: number[] = [];
  for (const characterID of members) {
    const reading = readings.get(characterID);
    const skills = reading?.planetSkills ?? null;
    if (!reading || skills === null) {
      unknown.push(characterID);
      continue;
    }
    pilots.push({
      characterID,
      name: names.get(characterID) ?? "A pilot this browser does not name",
      freeSlots: Math.max(0, 1 + skills.consolidation - reading.report.colonies.length),
      commandCenterLevel: skills.commandCenterUpgrades,
    });
  }
  return { pilots, unknown };
}

/** The systems the roster already works, busiest first: where an expansion is looked for from. */
export function homeSystems(
  readings: ReadonlyMap<number, PilotColonyReading>,
): readonly { readonly solarSystemID: number; readonly name: string; readonly colonies: number }[] {
  const out = new Map<number, { solarSystemID: number; name: string; colonies: number }>();
  for (const reading of readings.values()) {
    for (const colony of reading.report.colonies) {
      const known = out.get(colony.solarSystemID);
      out.set(colony.solarSystemID, {
        solarSystemID: colony.solarSystemID,
        name: colony.solarSystemName ?? "A system this map does not name",
        colonies: (known?.colonies ?? 0) + 1,
      });
    }
  }
  return [...out.values()].sort((left, right) => right.colonies - left.colonies || left.name.localeCompare(right.name));
}

/** One row of a plan as the window shows it. */
export interface ExpansionRowView {
  readonly key: string;
  readonly ref: ExpansionRowRef & { readonly productTypeID: number };
  readonly planetName: string;
  readonly planetTypeName: string | null;
  readonly placeWords: string;
  readonly resourceName: string;
  readonly productName: string;
  readonly quality: number | null;
  readonly state: ExpansionRowState;
}

export interface ExpansionGroupView {
  readonly characterID: number;
  readonly pilotName: string;
  readonly commandCenterLevel: number | null;
  readonly rows: readonly ExpansionRowView[];
}

/** "Alpha VIII", the type words "Temperate", and "2 jumps, 0.33" for one planet. */
function planetWords(planet: PlanetNear | undefined): { name: string; type: string | null; place: string } {
  if (!planet) return { name: "A planet out of reach of this plan's map", type: null, place: "" };
  const security = planet.security === null ? null : planet.security.toFixed(2);
  const jumps = planet.jumps === 1 ? "1 jump" : `${planet.jumps} jumps`;
  return {
    name: planet.planetName ?? "A planet this map does not name",
    type: planet.planetTypeName ? planet.planetTypeName.replace(/^Planet \((.*)\)$/, "$1") : null,
    place: security === null ? jumps : `${jumps}, ${security}`,
  };
}

/** A plan's rows, by pilot in the order they first appear, each with its live state. */
export function expansionGroups(
  rows: readonly (ExpansionRowRef & { readonly productTypeID: number })[],
  planets: ReadonlyMap<number, PlanetNear>,
  richness: ReadonlyMap<number, ReadonlyMap<number, number>>,
  readings: ReadonlyMap<number, PilotColonyReading>,
  names: ReadonlyMap<number, string>,
  book: PiRecipeBook,
): readonly ExpansionGroupView[] {
  const groups = new Map<number, { characterID: number; pilotName: string; commandCenterLevel: number | null; rows: ExpansionRowView[] }>();
  for (const ref of rows) {
    const planet = planets.get(ref.planetID);
    const words = planetWords(planet);
    const group = groups.get(ref.characterID) ?? {
      characterID: ref.characterID,
      pilotName: names.get(ref.characterID) ?? "A pilot this browser does not name",
      commandCenterLevel: readings.get(ref.characterID)?.planetSkills?.commandCenterUpgrades ?? null,
      rows: [],
    };
    group.rows.push({
      key: `${ref.characterID}:${ref.planetID}`,
      ref,
      planetName: words.name,
      planetTypeName: words.type,
      placeWords: words.place,
      resourceName: commodityName(book, ref.resourceTypeID) ?? "A resource this table does not name",
      productName: commodityName(book, ref.productTypeID) ?? "A commodity this table does not name",
      quality: richness.get(ref.planetID)?.get(ref.resourceTypeID) ?? null,
      state: rowState(ref, readings),
    });
    groups.set(ref.characterID, group);
  }
  return [...groups.values()];
}
