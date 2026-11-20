// The station repair shop's quote — repairSvc.GetRepairQuotes, decoded.
//
// WHAT THE SHOP ANSWERS
//
// The quote is a dict keyed by the item id we asked about; the value carries an
// `items` list of the damaged parts the shop found on that item. An item the
// shop lists with NO parts is undamaged — that is how "nothing to repair" is
// said on this wire, so an empty list is dropped here rather than rendered as a
// zero-cost repair.
//
// ⚠ THE PRICE IS THE SHOP'S, PRICED THE CLIENT'S WAY. A part row carries no
// total: it carries `damage` (HP) and `costToRepairOneUnitOfDamage`, and the
// retail repair window (repairshop/base_repairshop.py DisplayRepairQuote) prices
// a part as ceil(damage) * that unit cost — the same product the server's
// RepairItems charges (repairRuntime buildRepairExecutionTargets `fullCost`).
// A row that carries neither a `cost` nor both of those has no price, `cost`
// stays null, and the UI says the price is unknown instead of inventing 0 ISK
// next to a button that debits a real wallet. The client also skips a part
// whose ceil(damage) is 0; so do we.

import {
  isListValue,
  readDictPairs,
  readKeyVal,
  readPlainJsonField,
  readRowField,
} from "./wire.ts";

/** One damaged part the shop listed: a hull, a fitted module or a bay drone. */
export interface RepairQuotePart {
  /** The part's own item id — what RepairItems is handed for it. */
  readonly itemID: number;
  /** The part's type, when the row carries one (the name the panel shows). */
  readonly typeID: number | null;
  /** The service supplies this alongside the type on EveOffline. */
  readonly categoryID?: number;
  /** HP of damage the shop found, or null when the row does not say. */
  readonly damage: number | null;
  /** The part's full HP (shield + armor + structure), or null. */
  readonly maxHealth: number | null;
  /** What repairing it costs, or null when the row carries no price. */
  readonly cost: number | null;
}

/** One damaged item in the shop's quote: what it is and what it would cost. */
export interface RepairQuoteRow {
  /** The item the shop found damage on — the ship hull, or a fitted module. */
  readonly itemID: number;
  /**
   * What to hand RepairItems to fix it: each damaged part's OWN item id.
   *
   * ⚠ NOT `itemID`. Quoting a hull lists its modules and every drone in its bay
   * under the HULL's key, one part row each carrying that part's own itemID,
   * and RepairItems repairs exactly the ids it is given. Repairing by the key
   * repaired the hull alone: a clean hull with a chewed drone in its bay was
   * "repaired" for nothing, answered OK, and quoted damaged again, forever.
   * A part whose id cannot be read falls back to the key.
   */
  readonly repairItemIDs: readonly number[];
  /** How many damaged parts the shop listed under it (never zero here). */
  readonly damagedParts: number;
  /** Those parts, in wire order. */
  readonly parts: readonly RepairQuotePart[];
  /** Summed price of those parts, or null unless every part carried one. */
  readonly cost: number | null;
}

/** The damaged-parts list under one quoted item, whichever shape it arrived in. */
function quotedParts(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (isListValue(value)) {
    return value.items;
  }
  const nested = readKeyVal(value, "items") ?? readPlainJsonField(value, "items");
  if (Array.isArray(nested)) {
    return nested;
  }
  return isListValue(nested) ? nested.items : [];
}

/** A numeric field of a part row, from whichever row shape the handler chose. */
function partNumber(row: unknown, field: string): number | null {
  const raw = readRowField(row, field) ?? readPlainJsonField(row, field);
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** A positive integer id field of a part row; null when absent or unusable. */
function partID(row: unknown, field: string): number | null {
  const id = Number(readRowField(row, field) ?? readPlainJsonField(row, field));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A part's price: a quoted `cost` if the row has one, else ceil(damage) * unit cost. */
function partCost(row: unknown, damage: number | null): number | null {
  const quoted = partNumber(row, "cost");
  if (quoted !== null) {
    return quoted;
  }
  const unitCost = partNumber(row, "costToRepairOneUnitOfDamage");
  return damage === null || unitCost === null ? null : Math.ceil(damage) * unitCost;
}

/**
 * The DAMAGED items in a `repairSvc.GetRepairQuotes` result, in wire order.
 * Items the shop reports no damage on are left out; a result that is not a dict
 * decodes as no damage, which is the same answer an empty dict gives.
 */
export function decodeRepairQuotes(raw: unknown): readonly RepairQuoteRow[] {
  const quotes: RepairQuoteRow[] = [];
  for (const [key, value] of readDictPairs(raw)) {
    const itemID = Number(key);
    if (!Number.isSafeInteger(itemID) || itemID <= 0) {
      continue;
    }
    const parts: RepairQuotePart[] = [];
    for (const row of quotedParts(value)) {
      const damage = partNumber(row, "damage");
      if (damage !== null && Math.ceil(damage) <= 0) {
        continue;
      }
      const categoryID = partID(row, "categoryID");
      parts.push({
        itemID: partID(row, "itemID") ?? itemID,
        typeID: partID(row, "typeID"),
        ...(categoryID === null ? {} : { categoryID }),
        damage,
        maxHealth: partNumber(row, "maxHealth"),
        cost: partCost(row, damage),
      });
    }
    if (parts.length === 0) {
      continue;
    }
    const repairItemIDs: number[] = [];
    for (const part of parts) {
      if (!repairItemIDs.includes(part.itemID)) {
        repairItemIDs.push(part.itemID);
      }
    }
    const cost = parts.some((part) => part.cost === null)
      ? null
      : parts.reduce((sum, part) => sum + (part.cost ?? 0), 0);
    quotes.push({ itemID, repairItemIDs, damagedParts: parts.length, parts, cost });
  }
  return quotes;
}

/**
 * Every item id a quote says to repair, once each, in quote order — what
 * RepairItems is called with. A row without `repairItemIDs` stands for itself.
 */
export function repairTargets(
  quotes: readonly (Pick<RepairQuoteRow, "itemID"> & { readonly repairItemIDs?: readonly number[] })[],
): readonly number[] {
  const ids: number[] = [];
  for (const quote of quotes) {
    for (const id of quote.repairItemIDs ?? [quote.itemID]) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
}

/**
 * What the whole quote would cost, or null unless EVERY quoted item carried a
 * price. A total summed over only the rows we could read would understate the
 * charge the wallet is about to take, so a partial reading is reported as no
 * reading at all.
 */
export function repairQuoteTotal(quotes: readonly RepairQuoteRow[]): number | null {
  if (quotes.length === 0 || quotes.some((quote) => quote.cost === null)) {
    return null;
  }
  return quotes.reduce((sum, quote) => sum + (quote.cost ?? 0), 0);
}

/**
 * What the panel says a quote will cost. The game's own client asks its pilot nothing before a repair that costs
 * nothing, and makes it at once (base_repairshop.py 310 to 321): a structure's repair is such a one on this
 * server, where every part is quoted at nought. So where nothing is charged that is what is said.
 * `isk` writes an amount of two places as the page writes ISK.
 */
export function repairChargeWords(total: number | null, isk: (amount: string) => string): string {
  if (total === null) {
    return "The repair service did not quote a price. In a station nothing is paid that was not quoted.";
  }
  return total > 0 ? `The repair service will charge ${isk(total.toFixed(2))}.` : "The repair service charges nothing for this.";
}

/** What the button that makes the repair reads, for so many damaged parts: it speaks of paying unless the quote is of nothing. */
export function repairButtonWords(parts: number, total: number | null): string {
  const what = parts === 1 ? "it" : `all ${parts}`;
  return total === 0 ? `Repair ${what}` : `Repair ${what} and pay`;
}
