import { uuidFromBytes } from "./skillPlans.ts";

type InfomorphRate = readonly [lower: number, upper: number];

export type MercenaryDenStageImpact =
  | { readonly infomorphsPerHour: InfomorphRate | null }
  | { readonly workforcePercent: number | null };

export interface MercenaryDenStage {
  readonly stage: number;
  readonly points: number;
  readonly maximum: number;
  readonly active: boolean;
  readonly nextImpact: MercenaryDenStageImpact;
}

export interface MercenaryDenProgress {
  readonly stage: number;
  readonly stages: readonly MercenaryDenStage[];
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
  readonly infomorphsPerHour: InfomorphRate;
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

function stageEntry(entries: unknown, stage: number): Record<string, unknown> | undefined {
  const found = stage > 0 && Array.isArray(entries)
    ? entries.find(entry => evolutionStage(mercenaryDenRecord(entry).stage) === stage)
    : undefined;
  return found === undefined ? undefined : mercenaryDenRecord(found);
}

function progress(simulation: unknown, stages: unknown, nextImpact: (stage: number) => MercenaryDenStageImpact): MercenaryDenProgress {
  const state = mercenaryDenRecord(simulation);
  const level = mercenaryDenInteger(state.level);
  const levels = (Array.isArray(stages) ? stages : []).flatMap(entry => {
    const band = mercenaryDenRecord(entry);
    const stage = evolutionStage(band.stage);
    const lower = mercenaryDenInteger(band.level_lower_bound);
    const upper = mercenaryDenInteger(band.level_upper_bound);
    if (!stage || upper <= lower) return [];
    const maximum = upper + 1 - lower;
    return [{
      stage, maximum, points: Math.max(0, Math.min(maximum, level - lower)),
      active: level >= lower && level <= upper,
      nextImpact: nextImpact(stage + 1),
    }];
  });
  return {
    stage: Math.max(0, evolutionStage(state.stage) - 1),
    stages: levels.sort((left, right) => left.stage - right.stage),
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
  const tickSeconds = mercenaryDenInteger(generation.generation_tick_seconds);
  const hourly = (count: unknown) => tickSeconds > 0 ? Math.trunc(mercenaryDenInteger(count) / tickSeconds * 3600) : 0;
  const rateAt = (stage: number): InfomorphRate | null => {
    const band = stageEntry(generation.generation_bands, stage);
    return band ? [hourly(band.lower_band), hourly(band.upper_band)] : null;
  };
  const anarchyStages = mercenaryDenRecord(definition.anarchy).stages;
  const developmentStages = mercenaryDenRecord(definition.development).stages;
  const currentDevelopment = evolutionStage(mercenaryDenRecord(simulation.development).stage);
  const currentAnarchy = evolutionStage(mercenaryDenRecord(simulation.anarchy).stage);
  const anarchy = stageEntry(anarchyStages, currentAnarchy);
  const workforceCost = mercenaryDenInteger(anarchy?.workforce_consumption);
  const planetWorkforce = planets?.get(planetID)?.workforce ?? 0;
  const workforcePercent = (cost: number) => cost === 0 ? 0 : planetWorkforce > 0 ? cost / planetWorkforce * 100 : null;
  return {
    id, typeID, solarSystemID, planetID, enabled: row.enabled === true,
    ownerCharacterID: mercenaryDenID(attributes.owner),
    skyhookOwnerCorporationID: mercenaryDenID(row.skyhook_owner),
    infomorphs: mercenaryDenInteger(contents.infomorphs_count), activities,
    infomorphsPerHour: rateAt(currentDevelopment) ?? [0, 0],
    workforceCost,
    workforcePercent: workforcePercent(workforceCost),
    development: progress(simulation.development, developmentStages, stage => ({ infomorphsPerHour: rateAt(stage) })),
    anarchy: progress(simulation.anarchy, anarchyStages, stage => {
      const band = stageEntry(anarchyStages, stage);
      return { workforcePercent: band ? workforcePercent(mercenaryDenInteger(band.workforce_consumption)) : null };
    }),
  };
}
