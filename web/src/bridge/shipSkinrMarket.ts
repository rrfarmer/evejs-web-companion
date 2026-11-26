import { shipSkinrRecord as object } from "./shipSkinrCoatings.ts";
import { skillLevelsOf } from "./skillSheet.ts";
import type { JsonValue } from "./wire.ts";

export const SHIP_SKINR_MARKET = "eve_public.cosmetic.market.";
export type ShipSkinrCurrency = "ISK" | "PLEX";
export type ShipSkinrListingTarget = { kind: "public" } | { kind: "character" | "corporation" | "alliance"; id: number };
export interface ShipSkinrListingInput {
  readonly hex: string;
  readonly quantity: number;
  readonly currency: ShipSkinrCurrency;
  readonly amount: number;
  readonly seconds: number;
  readonly target: ShipSkinrListingTarget;
}

export interface ShipSkinrBrowseQuery {
  readonly target: "public" | "my_corporation" | "my_alliance" | "my_character";
  readonly hull?: number;
  readonly membership?: 1 | 2;
  readonly ascending: boolean;
  readonly token?: string;
}

export function encodeShipSkinrBrowse(query: ShipSkinrBrowseQuery): Record<string, JsonValue> {
  return {
    page: { size: 12, ...(query.token ? { token: query.token } : {}) },
    order: { field: 1, ascending: query.ascending },
    listing_target: { [query.target]: query.membership ? { required_membership: query.membership } : {} },
    ...(query.hull ? { filter: { ship_type_filter: { ship_types: [{ sequential: query.hull }] } } } : {}),
  };
}

export function encodeShipSkinrListingTarget(target: ShipSkinrListingTarget): Record<string, JsonValue> {
  return target.kind === "public" ? { public: true } : { [target.kind]: { sequential: target.id } };
}

function fixed(value: JsonValue | undefined): number {
  const row = object(value);
  return Number(row?.units ?? 0) + Number(row?.nanos ?? 0) / 1e9;
}

export function shipSkinrListingQuote(broker: JsonValue | null, tax: JsonValue | null, buyer: JsonValue | null) {
  const rows = object(broker ?? undefined)?.broker_fees_per_duration;
  const durations = (Array.isArray(rows) ? rows : []).flatMap(value => {
    const row = object(value);
    const seconds = Number(object(row?.duration)?.seconds);
    const fee = fixed(object(row?.broker_fee)?.fee);
    return Number.isSafeInteger(seconds) && seconds > 0 && Number.isFinite(fee) && fee >= 0 ? [{ seconds, fee }] : [];
  });
  const buyerFee = Number(object(object(object(buyer ?? undefined)?.buyer_fee)?.loyalty_points)?.amount ?? 0);
  const taxPercent = fixed(object(tax ?? undefined)?.tax_rate) * 100;
  if (!durations.length || !Number.isFinite(taxPercent) || !Number.isFinite(buyerFee)) throw new Error("Listing terms unavailable.");
  return { durations, taxPercent, buyerFee };
}

export function shipSkinrListingLimit(skills: unknown): number {
  const levels = skillLevelsOf(skills);
  const level = (id: number) => Math.max(0, Math.min(5, levels.get(id)?.trainedSkillLevel ?? 0));
  const advanced = level(81369);
  return 1 + level(81368) + (advanced > 0 ? 4 + (advanced - 1) * 5 : 0);
}

export function decodeOwnedShipSkinrListings(payload: JsonValue | null) {
  const rows = object(payload ?? undefined)?.listings;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(value => {
    const row = object(value);
    const id = object(row?.id)?.uuid;
    const attributes = object(row?.attributes);
    const hex = object(object(attributes?.skin)?.skin)?.hex;
    if (typeof id !== "string" || typeof hex !== "string") return [];
    const currency: ShipSkinrCurrency = attributes?.plex ? "PLEX" : "ISK";
    return [{ id, hex, quantity: Number(attributes?.quantity), currency,
      amount: currency === "PLEX" ? Number(object(attributes?.plex)?.total_in_cents) / 100 : fixed(attributes?.isk),
      seller: Number(object(attributes?.seller)?.sequential ?? object(object(attributes?.skin)?.character)?.sequential ?? 0),
      branded: attributes?.branded === true, target: object(attributes?.target) ?? {}, expires: Number(object(attributes?.expires)?.seconds) * 1000,
      created: Number(object(attributes?.created)?.seconds) * 1000 }];
  });
}

export function decodeShipSkinrBrowse(payload: JsonValue | null) {
  const token = object(object(payload ?? undefined)?.next_page)?.token;
  return { listings: decodeOwnedShipSkinrListings(payload), token: typeof token === "string" && token ? token : undefined };
}

export function decodeShipSkinrBuyerTerms(payload: JsonValue | null, tier: number, branded: boolean) {
  const root = object(payload ?? undefined);
  const version = root?.buyer_fees_version;
  const rows = root?.buyer_fees;
  const row = Array.isArray(rows) ? rows.map(object).find(value => Number(object(value?.skin_tier)?.level) === tier) : undefined;
  const fee = object(object(row?.[branded ? "branded_fee" : "default_fee"])?.loyalty_points);
  const issuer = Number(object(fee?.associated_corporation)?.sequential);
  const evermarks = Number(fee?.amount ?? 0);
  if (typeof version !== "string" || !version || !Number.isSafeInteger(issuer) || issuer <= 0 ||
      !Number.isSafeInteger(evermarks) || evermarks < 0) throw new Error("Buyer terms unavailable.");
  return { version, issuer, evermarks };
}

export interface ShipSkinrComponentOffer {
  readonly id: string;
  readonly typeID: number;
  readonly currency: ShipSkinrCurrency;
  readonly amount: number;
  readonly bundle: number;
  readonly expires: number;
  readonly discount: number;
}

export function decodeShipSkinrComponentOffers(payload: JsonValue | null): ShipSkinrComponentOffer[] {
  const rows = object(payload ?? undefined)?.listings;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(value => {
    const row = object(value);
    const id = object(row?.id)?.uuid;
    const attributes = object(row?.attributes);
    const typeID = Number(object(attributes?.component_item)?.sequential);
    const bundle = Number(attributes?.bundle_size);
    const expires = Number(object(attributes?.sale_end)?.seconds) * 1000;
    const currency: ShipSkinrCurrency = attributes?.plex ? "PLEX" : "ISK";
    const amount = currency === "PLEX" ? Number(object(attributes?.plex)?.total_in_cents ?? 0) / 100 : fixed(attributes?.isk);
    if (typeof id !== "string" || !id || !Number.isSafeInteger(typeID) || typeID < 1 ||
        !Number.isSafeInteger(bundle) || bundle < 1 || !Number.isFinite(expires) || expires <= 0 ||
        !(attributes?.plex || attributes?.isk) || !Number.isFinite(amount) || amount < 0) return [];
    return [{ id, typeID, bundle, expires, currency, amount, discount: Number(attributes?.discount_percent ?? 0) }];
  });
}
