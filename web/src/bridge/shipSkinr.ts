export const SHIP_SKINR_GATEWAY = "eve_public.cosmetic.ship.skin.thirdparty.";

export interface ShipSkinrEntry {
  readonly id: string;
  readonly skin: string;
  readonly quantity: number;
  readonly finishesAt: number;
}

export interface ShipSkinrStudio {
  readonly designs: readonly ShipSkinrEntry[];
  readonly capacity: number;
  readonly jobs: readonly ShipSkinrEntry[];
}

export interface ShipSkinrDesign {
  readonly name: string;
  readonly lineName: string;
  readonly shipTypeID: number;
  readonly tier: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown): number {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export function decodeShipSkinrEntries(payload: unknown, field: "drafts" | "jobs"): ShipSkinrEntry[] {
  const rows = record(payload)[field];
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(value => {
    const row = record(value);
    const id = record(row.id).uuid;
    const attributes = record(row.attributes);
    const skin = record(attributes.skin).hex;
    if (typeof id !== "string" || !id || typeof skin !== "string" || !skin) return [];
    return [{
      id, skin, quantity: integer(attributes.quantity),
      finishesAt: integer(record(attributes.planned_completion).seconds) * 1000,
    }];
  });
}

export function decodeShipSkinrCapacity(payload: unknown): number {
  return integer(record(payload).capacity);
}

export function decodeShipSkinrDesign(payload: unknown): ShipSkinrDesign | null {
  const skin = record(record(payload).skin);
  const shipTypeID = integer(record(record(skin.layout).ship_type).sequential);
  return shipTypeID ? {
    shipTypeID,
    name: typeof skin.name === "string" ? skin.name : "",
    lineName: typeof skin.line_name === "string" ? skin.line_name : "",
    tier: integer(record(skin.tier).level),
  } : null;
}
