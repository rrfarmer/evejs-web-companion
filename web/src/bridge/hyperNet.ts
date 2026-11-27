import { filetimeToUnixMs } from "./activity.ts";
import { isListValue, readDictEntry, readKeyVal, unwrapLong } from "./wire.ts";

export const hyperNetPriceBounds = [1_000_000, 10_000_000, 100_000_000] as const;
export const hyperNetCountBounds = [8, 16, 48, 512] as const;
export type HyperNetNodeCount = typeof hyperNetCountBounds[number];
export const hyperNetCoreType = 52568;
export const hyperNetMinimumPrice = 1000;
export const hyperNetMaximumPrice = 10_000_000_000_000;
export const hyperNetTaxRate = 0.05;

export function hyperNetCreationQuote(price: number, count: HyperNetNodeCount, plexPrice: number) {
  const bounded = Math.min(hyperNetMaximumPrice, Math.max(hyperNetMinimumPrice, price));
  const nodePrice = Math.min(Math.ceil(bounded / count), Math.floor(hyperNetMaximumPrice / count));
  const total = nodePrice * count;
  const tax = total * hyperNetTaxRate;
  const corePrice = Math.max(1, Math.trunc(plexPrice / 10));
  return { nodePrice, total, tax, proceeds: total - tax, cores: Math.max(1, Math.trunc(total / corePrice * hyperNetTaxRate)) };
}

export interface HyperNetCreationDraft {
  readonly stationID: number;
  readonly itemID: number;
  readonly typeID: number;
  readonly tokenID: number;
  readonly count: HyperNetNodeCount;
  readonly nodePrice: number;
  readonly privateOffer: boolean;
}

export interface HyperNetPriceSummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly average: number;
}

export function decodeHyperNetTypeStatistics(payload: unknown) {
  const read = (scope: "historic" | "active"): HyperNetPriceSummary => {
    const field = (key: keyof HyperNetPriceSummary) => {
      const raw = readDictEntry(payload, `${scope}_${key}`);
      const amount = raw === null ? 0 : Number(unwrapLong(raw) ?? NaN);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("HyperNet offer statistics are unavailable.");
      return amount;
    };
    return { count: field("count"), min: field("min"), max: field("max"), average: field("average") };
  };
  return { historic: read("historic"), active: read("active") };
}

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
  readonly joined: boolean;
  readonly owned: number;
  readonly private: boolean;
  readonly copy: boolean;
  readonly groupID: number | null;
  readonly categoryID: number | null;
  readonly metaGroupID: number | null;
  readonly locationID: number;
  readonly systemID: number;
  readonly winnerID: number | null;
  readonly status: number;
  readonly ended: number | null;
}

export interface HyperNetOfferDetails extends HyperNetOffer {
  readonly ownerID: number;
  readonly itemID: number | null;
  readonly locationID: number;
  readonly systemID: number;
  readonly status: number;
  readonly copy: boolean;
  readonly private: boolean;
  readonly ticketOwners: ReadonlyMap<number, number>;
  readonly winnerID: number | null;
  readonly winningNumber: number | null;
  readonly ended: number | null;
}

export function decodeHyperNetOfferDetails(payload: unknown): HyperNetOfferDetails {
  const offer = decodeHyperNetOffer(payload);
  const number = (key: string, source = payload) => {
    const value = unwrapLong(readKeyVal(source, key));
    return value === null ? NaN : Number(value);
  };
  const valid = (id: number) => Number.isSafeInteger(id) && id > 0;
  const ownerID = number("owner_id");
  const itemID = number("item_id");
  const locationID = number("location_id");
  const systemID = number("solar_system_id");
  const status = number("raffle_status");
  const sold = readKeyVal(payload, "sold_tickets");
  if (![ownerID, locationID, systemID, status].every(valid) || status > 9 ||
      offer.tickets > hyperNetCountBounds[3] || !isListValue(sold)) {
    throw new Error("HyperNet returned unreadable offer details.");
  }
  const ticketNumber = (ticket: unknown) => {
    const index = number("number", ticket);
    return Number.isInteger(index) && index >= 0 && index < offer.tickets ? index : null;
  };
  const ticketOwners = new Map<number, number>();
  for (const ticket of sold.items) {
    const index = ticketNumber(ticket);
    const owner = number("owner_id", ticket);
    if (index === null || !valid(owner) || ticketOwners.has(index)) {
      throw new Error("HyperNet returned an unreadable HyperNode.");
    }
    ticketOwners.set(index, owner);
  }
  if (ticketOwners.size !== offer.tickets - offer.remaining) {
    throw new Error("HyperNet returned an incomplete HyperNode list.");
  }
  const winner = readKeyVal(payload, "winning_ticket") ?? null;
  const winnerID = number("owner_id", winner);
  const copy = readDictEntry(readKeyVal(payload, "meta_data"), "is_copy");
  return { ...offer, ownerID, itemID: valid(itemID) ? itemID : null, locationID, systemID, status,
    copy: copy === true || unwrapLong(copy) === 1n, private: number("restriction_id") === 1, ticketOwners, winnerID: valid(winnerID) ? winnerID : null,
    winningNumber: ticketNumber(winner), ended: filetimeToUnixMs(unwrapLong(readKeyVal(payload, "end_date"))) };
}

/** The storage notices address an offer directly or carry a dict of offer IDs to sold counts. */
export function hyperNetDetailNoticeIDs(method: string, args: readonly unknown[]): readonly number[] {
  const idOf = (value: unknown): number[] => {
    const id = Number(unwrapLong(value));
    return Number.isSafeInteger(id) && id > 0 ? [id] : [];
  };
  if (method === "OnRaffleUpdatedServer" || method === "OnRaffleFinishedServer") return idOf(args[0]);
  if (method !== "OnTicketsUpdatedServer" || args[0] === null || typeof args[0] !== "object") return [];
  const updates = args[0] as { type?: unknown; entries?: unknown };
  return updates.type === "dict" && Array.isArray(updates.entries)
    ? updates.entries.flatMap(entry => Array.isArray(entry) ? idOf(entry[0]) : [])
    : [];
}

export interface HyperNetParticipation {
  readonly created: number;
  readonly completed: number;
  readonly joined: number;
  readonly won: number;
}

export function decodeHyperNetParticipation(payload: unknown): HyperNetParticipation {
  const count = (key: string) => {
    const value = unwrapLong(readKeyVal(payload, key));
    if (value === null || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("HyperNet returned unreadable participation statistics.");
    }
    return Number(value);
  };
  const completed = count("finished_delivered") + count("finished_undelivered");
  return {
    created: completed + count("finished_expired") + count("created_running"),
    completed,
    joined: count("raffles_participated"),
    won: count("raffles_won"),
  };
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

export function decodeHyperNetActiveTickets(payload: unknown): ReadonlyMap<number, number> {
  if (!isListValue(payload)) throw new Error("HyperNet active nodes are unavailable.");
  const owned = new Map<number, number>();
  for (const ticket of payload.items) {
    const id = Number(unwrapLong(readKeyVal(ticket, "raffle_id")));
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("HyperNet returned an unreadable active node.");
    owned.set(id, (owned.get(id) ?? 0) + 1);
  }
  return owned;
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

export function decodeHyperNetHistoryPage(payload: unknown, pilot: number): { rows: readonly HyperNetHistoryOffer[]; size: number } {
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
    const sold = readKeyVal(row, "sold_tickets");
    const owned = isListValue(sold) ? sold.items.filter(ticket => Number(unwrapLong(readKeyVal(ticket, "owner_id"))) === pilot).length : 0;
    const restricted = unwrapLong(readKeyVal(row, "restriction_id")) === 1n;
    const copyFlag = readDictEntry(readKeyVal(row, "meta_data"), "is_copy");
    return { ...offer, runningID, ownerID, locationID, systemID, status, winnerID: winner > 0 ? winner : null,
      ended, joined: owned > 0, owned, private: restricted, copy: copyFlag === true || unwrapLong(copyFlag) === 1n,
      groupID: null, categoryID: null, metaGroupID: null };
  });
  return { rows, size };
}
