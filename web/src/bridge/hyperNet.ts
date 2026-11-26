import { filetimeToUnixMs } from "./activity.ts";
import { isListValue, readKeyVal, unwrapLong } from "./wire.ts";

export interface HyperNetOffer {
  readonly id: number;
  readonly typeID: number;
  readonly price: bigint;
  readonly tickets: number;
  readonly remaining: number;
  readonly expires: number;
}

export interface HyperNetHistoryOffer extends HyperNetOffer {
  readonly runningID: number;
  readonly ownerID: number;
  readonly locationID: number;
  readonly systemID: number;
  readonly winnerID: number | null;
  readonly status: number;
  readonly ended: number | null;
}

export interface HyperNetConstraints {
  readonly min_ticket_price?: number;
  readonly max_ticket_price?: number;
  readonly min_ticket_count?: number;
  readonly max_ticket_count?: number;
}

export interface HyperNetBrowseScope {
  readonly solar_system_id?: number;
  readonly meta_group_id?: number;
  readonly blueprint_type?: 1 | 2;
}

export interface HyperNetItem {
  readonly key: "type_id" | "group_id" | "category_id";
  readonly id: number;
  readonly name: string;
  readonly categoryID?: number;
}

export function isHyperNetItem(value: unknown): value is HyperNetItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<HyperNetItem>;
  return (item.key === "type_id" || item.key === "group_id" || item.key === "category_id") &&
    typeof item.id === "number" && Number.isSafeInteger(item.id) && item.id > 0 &&
    typeof item.name === "string" && item.name.length > 0 &&
    (item.categoryID === undefined || Number.isSafeInteger(item.categoryID) && item.categoryID > 0);
}

export function decodeHyperNetOffers(payload: unknown): readonly HyperNetOffer[] {
  if (!isListValue(payload)) throw new Error("HyperNet offers are unavailable.");
  return payload.items.map(decodeHyperNetOffer);
}

function decodeHyperNetOffer(row: unknown): HyperNetOffer {
    const id = Number(unwrapLong(readKeyVal(row, "raffle_id")));
    const typeID = Number(unwrapLong(readKeyVal(row, "type_id")));
    const price = unwrapLong(readKeyVal(row, "ticket_price"));
    const tickets = Number(unwrapLong(readKeyVal(row, "ticket_count")));
    const sold = unwrapLong(readKeyVal(row, "sold_ticket_count"));
    const expires = filetimeToUnixMs(unwrapLong(readKeyVal(row, "expiration_time")));
    if (![id, typeID, tickets].every(value => Number.isSafeInteger(value) && value > 0) ||
        price === null || price < 0n || sold === null || sold < 0n || sold > BigInt(tickets) || expires === null) {
      throw new Error("HyperNet returned an unreadable offer.");
    }
    return { id, typeID, price, tickets, remaining: tickets - Number(sold), expires };
}

export function decodeHyperNetHistoryPage(payload: unknown): { rows: readonly HyperNetHistoryOffer[]; size: number } {
  if (!Array.isArray(payload) || payload.length !== 2 || !isListValue(payload[0])) {
    throw new Error("HyperNet history is unavailable.");
  }
  const size = Number(unwrapLong(payload[1]));
  if (!Number.isSafeInteger(size) || size < 1 || payload[0].items.length > size) {
    throw new Error("HyperNet returned an unreadable history page.");
  }
  const rows = payload[0].items.map(row => {
    const offer = decodeHyperNetOffer(row);
    const runningID = Number(unwrapLong(readKeyVal(row, "running_id")));
    const ownerID = Number(unwrapLong(readKeyVal(row, "owner_id")));
    const locationID = Number(unwrapLong(readKeyVal(row, "location_id")));
    const systemID = Number(unwrapLong(readKeyVal(row, "solar_system_id")));
    const status = Number(unwrapLong(readKeyVal(row, "raffle_status")));
    const winner = Number(unwrapLong(readKeyVal(readKeyVal(row, "winning_ticket"), "owner_id")));
    const ended = filetimeToUnixMs(unwrapLong(readKeyVal(row, "end_date")));
    if (![runningID, ownerID, locationID, systemID, status].every(value => Number.isSafeInteger(value) && value > 0) ||
        status > 9) {
      throw new Error("HyperNet returned an unreadable history offer.");
    }
    return { ...offer, runningID, ownerID, locationID, systemID, status, winnerID: winner > 0 ? winner : null, ended };
  });
  return { rows, size };
}
