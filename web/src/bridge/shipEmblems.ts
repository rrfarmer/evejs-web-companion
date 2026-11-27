import { readDictPairs, unwrapLong, type JsonValue } from "./wire.ts";

export const SHIP_EMBLEM_GATEWAY = "eve_public.cosmetic.ship.logo.";
export const SHIP_ENTITLEMENT_GATEWAY = "eve_public.entitlement.character.";
export const SHIP_EMBLEM_TYPES = { alliance: 2, corporation: 1 } as const;
export type ShipEmblemKind = keyof typeof SHIP_EMBLEM_TYPES;
export type ShipEmblemImages = Readonly<Partial<Record<ShipEmblemKind, string | null>>>;
export type ReleasedShipEmblem = readonly [shipTypeID: number, kind: number, slot: number];

interface EmblemEntitlement {
  readonly character?: { readonly sequential?: string | number };
  readonly ship_type?: { readonly sequential?: string | number };
}

export interface ShipEmblemState {
  readonly owned: ReadonlySet<ShipEmblemKind>;
  readonly enabled: ReadonlyMap<ShipEmblemKind, number>;
}

export function decodeEnabledShipEmblems(cosmetics: unknown): ReadonlyMap<ShipEmblemKind, number> {
  const enabled = new Map<ShipEmblemKind, number>();
  for (const [key, value] of readDictPairs(cosmetics)) {
    const slot = Number(unwrapLong(key) ?? -1n);
    const kind = Number(unwrapLong(value) ?? 0n);
    if (!Number.isSafeInteger(slot) || slot < 0) continue;
    if (kind === SHIP_EMBLEM_TYPES.corporation) enabled.set("corporation", slot);
    if (kind === SHIP_EMBLEM_TYPES.alliance) enabled.set("alliance", slot);
  }
  return enabled;
}

export function decodeShipEmblems(entitlements: JsonValue | null, cosmetics: unknown, pilot: number, hull: number): ShipEmblemState {
  const rows = (entitlements as { entitlements?: readonly {
    corporation_logo?: EmblemEntitlement; alliance_logo?: EmblemEntitlement;
  }[] } | null)?.entitlements ?? [];
  const owned = new Set<ShipEmblemKind>();
  for (const row of rows) {
    const kind = row.corporation_logo ? "corporation" : "alliance";
    const license = row.corporation_logo ?? row.alliance_logo;
    if (Number(license?.character?.sequential) === pilot && Number(license?.ship_type?.sequential) === hull) owned.add(kind);
  }
  return { owned, enabled: decodeEnabledShipEmblems(cosmetics) };
}

let catalog: Promise<readonly ReleasedShipEmblem[]> | undefined;
export function loadShipEmblemCatalog(): Promise<readonly ReleasedShipEmblem[]> {
  return catalog ??= fetch("/client-assets/shipEmblemLicenses.json").then(response => {
    if (!response.ok) throw new Error("The ship emblem catalog could not be loaded.");
    return response.json() as Promise<ReleasedShipEmblem[]>;
  }).catch(error => {
    catalog = undefined;
    throw error;
  });
}
