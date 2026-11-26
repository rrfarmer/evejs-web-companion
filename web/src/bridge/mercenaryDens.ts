import { uuidFromBytes } from "./skillPlans.ts";

export interface MercenaryDenProgress {
  readonly stage: number;
  readonly level: number;
  readonly lowerLevel: number;
  readonly upperLevel: number;
}

export interface MercenaryDenActivity {
  readonly id: string;
  readonly nameID: number;
  readonly descriptionID: number;
  readonly started: boolean;
  readonly expiresAt: number;
  readonly developmentImpact: number;
  readonly anarchyImpact: number;
  readonly infomorphBonus: number;
}

export interface MercenaryDenActivities {
  readonly rows: readonly MercenaryDenActivity[];
  readonly nextAt: number;
  readonly capacity: number | null;
}

export interface MercenaryDenRow {
  readonly id: number;
  readonly typeID: number;
  readonly solarSystemID: number;
  readonly planetID: number;
  readonly ownerCharacterID: number;
  readonly skyhookOwnerCorporationID: number;
  readonly enabled: boolean;
  readonly infomorphs: number;
  readonly activities: number | null;
  readonly infomorphsPerHour: readonly [lower: number, upper: number];
  readonly workforceCost: number;
  readonly workforcePercent: number | null;
  readonly development: MercenaryDenProgress;
  readonly anarchy: MercenaryDenProgress;
}

export interface MercenaryDensRead {
  readonly owned: readonly number[];
  readonly rows: readonly MercenaryDenRow[];
  readonly maximum: number;
  readonly absoluteMaximum: number;
}

export function mercenaryDenRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function mercenaryDenInteger(value: unknown): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function mercenaryDenID(value: unknown): number {
  return mercenaryDenInteger(mercenaryDenRecord(value).sequential);
}

function evolutionStage(value: unknown): number {
  const named = typeof value === "string" ? /^(?:DEVELOPMENT|ANARCHY)_STAGE_([1-5])$/.exec(value) : null;
  return mercenaryDenInteger(named?.[1] ?? value);
}

function stageEntry(entries: unknown, simulation: unknown): Record<string, unknown> {
  const stage = evolutionStage(mercenaryDenRecord(simulation).stage);
  return mercenaryDenRecord(stage > 0 && Array.isArray(entries)
    ? entries.find(entry => evolutionStage(mercenaryDenRecord(entry).stage) === stage)
    : undefined);
}

function progress(simulation: unknown, stages: unknown): MercenaryDenProgress {
  const state = mercenaryDenRecord(simulation);
  const band = stageEntry(stages, simulation);
  const lowerLevel = mercenaryDenInteger(band.level_lower_bound);
  const upperLevel = mercenaryDenInteger(band.level_upper_bound);
  return {
    stage: Math.max(0, evolutionStage(state.stage) - 1),
    level: mercenaryDenInteger(state.level),
    lowerLevel,
    upperLevel: upperLevel > lowerLevel ? upperLevel + 1 : upperLevel,
  };
}

function activityTimestamp(value: unknown): number {
  const time = mercenaryDenRecord(value);
  return mercenaryDenInteger(time.seconds) * 1000 + mercenaryDenInteger(time.nanos) / 1_000_000;
}

export function decodeMercenaryDenActivities(payload: unknown, capacity: number | null): MercenaryDenActivities {
  const result = mercenaryDenRecord(payload);
  const rows = (Array.isArray(result.activities) ? result.activities : []).flatMap(value => {
    const entry = mercenaryDenRecord(value);
    const uuid = mercenaryDenRecord(entry.id).uuid;
    const id = typeof uuid === "string" ? uuidFromBytes(uuid) : null;
    if (id === null) return [];
    const attributes = mercenaryDenRecord(entry.attributes);
    const template = mercenaryDenRecord(attributes.activitytemplate);
    const developmentImpact = Number(template.development_impact ?? 0);
    const anarchyImpact = Number(template.anarchy_impact ?? 0);
    return [{
      id, nameID: mercenaryDenID(template.name), descriptionID: mercenaryDenID(template.description),
      started: attributes.started === true, expiresAt: activityTimestamp(attributes.expiry),
      developmentImpact: Number.isSafeInteger(developmentImpact) ? developmentImpact : 0,
      anarchyImpact: Number.isSafeInteger(anarchyImpact) ? anarchyImpact : 0,
      infomorphBonus: mercenaryDenInteger(template.infomorph_bonus),
    }];
  });
  return { rows, nextAt: activityTimestamp(result.next_generation_at), capacity };
}

export function decodeMercenaryDen(id: number, payload: unknown, activities: number | null,
  planets: ReadonlyMap<number, { readonly workforce: number }> | undefined): MercenaryDenRow | null {
  const row = mercenaryDenRecord(payload);
  const attributes = mercenaryDenRecord(row.attributes);
  const typeID = mercenaryDenID(attributes.type);
  const solarSystemID = mercenaryDenID(attributes.solar_system);
  const planetID = mercenaryDenID(attributes.planet);
  if (!typeID || !solarSystemID || !planetID) return null;
  const infomorphs = mercenaryDenRecord(row.infomorphs);
  const contents = mercenaryDenRecord(infomorphs.contents);
  const generation = mercenaryDenRecord(infomorphs.definition);
  const evolution = mercenaryDenRecord(row.evolution);
  const definition = mercenaryDenRecord(evolution.definition);
  const simulation = mercenaryDenRecord(evolution.simulation);
  const band = stageEntry(generation.generation_bands, simulation.development);
  const tickSeconds = mercenaryDenInteger(generation.generation_tick_seconds);
  const hourly = (count: unknown) => tickSeconds > 0 ? Math.trunc(mercenaryDenInteger(count) / tickSeconds * 3600) : 0;
  const anarchyStages = mercenaryDenRecord(definition.anarchy).stages;
  const developmentStages = mercenaryDenRecord(definition.development).stages;
  const anarchy = stageEntry(anarchyStages, simulation.anarchy);
  const workforceCost = mercenaryDenInteger(anarchy.workforce_consumption);
  const planetWorkforce = planets?.get(planetID)?.workforce ?? 0;
  return {
    id, typeID, solarSystemID, planetID, enabled: row.enabled === true,
    ownerCharacterID: mercenaryDenID(attributes.owner),
    skyhookOwnerCorporationID: mercenaryDenID(row.skyhook_owner),
    infomorphs: mercenaryDenInteger(contents.infomorphs_count), activities,
    infomorphsPerHour: [hourly(band.lower_band), hourly(band.upper_band)],
    workforceCost,
    workforcePercent: workforceCost === 0 ? 0 : planetWorkforce > 0 ? workforceCost / planetWorkforce * 100 : null,
    development: progress(simulation.development, developmentStages),
    anarchy: progress(simulation.anarchy, anarchyStages),
  };
}
