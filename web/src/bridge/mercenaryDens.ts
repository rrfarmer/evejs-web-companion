export interface MercenaryDenRow {
  readonly id: number;
  readonly typeID: number;
  readonly solarSystemID: number;
  readonly planetID: number;
  readonly enabled: boolean;
  readonly infomorphs: number;
  readonly activities: number | null;
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

export function decodeMercenaryDen(id: number, payload: unknown, activities: number | null): MercenaryDenRow | null {
  const row = mercenaryDenRecord(payload);
  const attributes = mercenaryDenRecord(row.attributes);
  const typeID = mercenaryDenID(attributes.type);
  const solarSystemID = mercenaryDenID(attributes.solar_system);
  const planetID = mercenaryDenID(attributes.planet);
  if (!typeID || !solarSystemID || !planetID) return null;
  const infomorphs = mercenaryDenRecord(mercenaryDenRecord(row.infomorphs).contents);
  return { id, typeID, solarSystemID, planetID, enabled: row.enabled === true,
    infomorphs: mercenaryDenInteger(infomorphs.infomorphs_count), activities };
}
