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

function stageEntry(entries: unknown, simulation: unknown): Record<string, unknown> {
  const stage = mercenaryDenInteger(mercenaryDenRecord(simulation).stage);
  return mercenaryDenRecord(Array.isArray(entries)
    ? entries.find(entry => mercenaryDenInteger(mercenaryDenRecord(entry).stage) === stage)
    : undefined);
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
  const anarchy = stageEntry(mercenaryDenRecord(definition.anarchy).stages, simulation.anarchy);
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
  };
}
