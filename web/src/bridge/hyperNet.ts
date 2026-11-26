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

export interface HyperNetConstraints {
  readonly min_ticket_price?: number;
  readonly max_ticket_price?: number;
  readonly min_ticket_count?: number;
  readonly max_ticket_count?: number;
}

export function decodeHyperNetOffers(payload: unknown): readonly HyperNetOffer[] {
  if (!isListValue(payload)) throw new Error("HyperNet offers are unavailable.");
  return payload.items.map(row => {
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
  });
}
