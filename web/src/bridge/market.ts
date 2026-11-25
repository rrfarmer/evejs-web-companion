// Market reads decoded to named order books, and the CLIENT-LOCAL half of the
// market that retail calls `marketQuote` (goal R16).
//
// ⚠ THREE THINGS THIS MODULE EXISTS TO GET RIGHT, each of which fails silently
// if you get it wrong:
//
// 1. THE SERVICE IS `marketProxy`, NOT `market`. EveJS registers two market
//    services. `market` is a DEAD STUB — every method answers an empty rowset.
//    `marketProxy` is the real one. Nothing in the browser names a service
//    (the BFF does), but the trap is recorded here because a "silently empty
//    market page" is the symptom and this is the file you would come to first.
//
// 2. `marketQuote` IS CLIENT-LOCAL AND HAS NO SERVER HANDLER. In retail,
//    sorting an order book, filtering it by jump distance, deciding which bid
//    is the best one, and knowing how many orders a character may keep open all
//    live in the CLIENT. There is nothing to call. Everything under
//    "marketQuote, client-side" below is that logic, reimplemented here.
//
// 3. THE ORDER BOOK ARRIVES INSIDE A CACHED ENVELOPE. GetOrders / GetCharOrders
//    / GetMarketOrderHistory answer a retail `CachedMethodCallResult`; the real
//    payload rides `args[1]` as `{type:"substream", value:…}`. Reading the
//    envelope as a rowset finds nothing. (Unlike map.GetStationInfo in R2,
//    whose payload is a cached-OBJECT reference that genuinely cannot be
//    decoded — this one can, once unwrapped.)
//
// THE ID BOUNDARY (R7d). Every identifier the market speaks in — the typeID of
// the item, the stationID an order sits at, the solarSystemID, the orderID
// itself — is a number on the wire and a NAME (or a hidden handle) past this
// module. An orderID is never rendered: an order is identified to the player by
// what it is for, where it is, and at what price.
//
// MONEY (R7d). Prices are decimal strings end to end. ISK amounts in EveJS
// routinely exceed 2^53, so a balance is never a JS number in rendered text;
// the panel formats the decimal string itself.

import { isListValue, readKeyVal, unwrapLong, type JsonValue } from "./wire.ts";
import type { NameKind, NameRef } from "../store/names.ts";
import type {
  MarketEscrow,
  MarketOrderRow,
  MarketOwnFillState,
  MarketOwnOrderRow,
  MarketPriceHistoryRow,
  MarketSide,
  MarketTransactionRow,
} from "../store/types.ts";

// --- Envelope + rowset plumbing --------------------------------------------

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenText(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.value === "string") {
    return value.value;
  }
  return "";
}

/**
 * Unwrap the retail cached envelope, if that is what arrived.
 *
 * ⚠ TRAP 3. `args[1]` is the payload. A caller that treats the envelope itself
 * as a rowset reads zero rows and shows an empty market.
 */
export function unwrapCachedResult(result: JsonValue): JsonValue {
  if (!isRecord(result) || result.type !== "object") {
    return result;
  }
  if (!tokenText(result.name).endsWith("objectCaching.CachedMethodCallResult")) {
    return result;
  }
  const args = result.args;
  if (!Array.isArray(args) || args.length < 2) {
    return null;
  }
  const carrier = args[1];
  if (isRecord(carrier) && carrier.type === "substream") {
    return carrier.value ?? null;
  }
  // A cached-OBJECT reference: the payload lives in the retail object cache and
  // the browser genuinely cannot decode it. Answer null rather than pretending.
  return null;
}

function rowsetEntries(rowset: JsonValue): Map<string, JsonValue> {
  const map = new Map<string, JsonValue>();
  if (!isRecord(rowset) || rowset.type !== "object") {
    return map;
  }
  const args = rowset.args;
  if (!isRecord(args) || !Array.isArray(args.entries)) {
    return map;
  }
  for (const entry of args.entries as readonly JsonValue[]) {
    if (Array.isArray(entry) && entry.length >= 2) {
      map.set(tokenText(entry[0]), entry[1] ?? null);
    }
  }
  return map;
}

function rowsetColumns(rowset: JsonValue): readonly string[] {
  const columns = rowsetEntries(rowset).get("columns");
  if (!isListValue(columns)) {
    return [];
  }
  return columns.items.map((column) => tokenText(column));
}

function rowsetLines(rowset: JsonValue): readonly JsonValue[] {
  const lines = rowsetEntries(rowset).get("lines");
  return isListValue(lines) ? lines.items : [];
}

/**
 * One rowset line as a {column: value} record.
 *
 * ⚠ The two market rowsets use DIFFERENT row classes: the order book is
 * `blue.DBRow` (a line is a bare JSON array) and the owner-orders rowset is
 * `util.Row` (a line is a `{type:"list"}` wrapper). Both are handled, because a
 * decoder that assumes one shape silently reads zero rows of the other.
 */
function lineCells(line: JsonValue): readonly JsonValue[] {
  if (Array.isArray(line)) {
    return line;
  }
  return isListValue(line) ? line.items : [];
}

function rowRecords(rowset: JsonValue): readonly Readonly<Record<string, JsonValue>>[] {
  const columns = rowsetColumns(rowset);
  if (columns.length === 0) {
    return [];
  }
  return rowsetLines(rowset).map((line) => {
    const cells = lineCells(line);
    const record: Record<string, JsonValue> = {};
    columns.forEach((column, index) => {
      record[column] = cells[index] ?? null;
    });
    return record;
  });
}

const ORDER_EXPORT_NAMES: Readonly<Record<string, { heading: string; kind: NameKind }>> = {
  charID: { heading: "charName", kind: "owner" },
  regionID: { heading: "regionName", kind: "evelocation" },
  stationID: { heading: "stationName", kind: "evelocation" },
  solarSystemID: { heading: "solarSystemName", kind: "evelocation" },
};

export function readMarketOrdersExport(result: JsonValue) {
  const rowset = unwrapCachedResult(result);
  const columns = rowsetColumns(rowset);
  const records = rowRecords(rowset);
  const names: NameRef[] = [];
  for (const row of records) {
    for (const [column, { kind }] of Object.entries(ORDER_EXPORT_NAMES)) {
      const id = toNumber(row[column]);
      if (id > 0) names.push({ kind, id });
    }
  }
  return { columns, records, names };
}

function exportOrderValue(column: string, value: JsonValue): string {
  if (column === "issueDate") {
    const filetime = toFiletime(value);
    if (filetime !== null) {
      const date = new Date(Number(filetime / 10000n - 11644473600000n));
      if (Number.isFinite(date.getTime())) {
        const iso = date.toISOString();
        return filetime % 864000000000n === 0n ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ") + ".000";
      }
    }
  }
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return toAmountString(value) ?? (typeof value === "string" ? value : "");
}

export function formatMarketOrdersExport(
  data: ReturnType<typeof readMarketOrdersExport>,
  nameOf: (kind: NameKind, id: number) => string,
): string {
  const headings = data.columns.flatMap(column => {
    const name = ORDER_EXPORT_NAMES[column];
    return name ? [column, name.heading] : [column];
  });
  return orderExportLine(headings) + data.records.map(row => orderExportLine(data.columns.flatMap(column => {
    const name = ORDER_EXPORT_NAMES[column];
    const value = exportOrderValue(column, row[column] ?? null);
    return name ? [value, nameOf(name.kind, toNumber(row[column]))] : [value];
  }))).join("");
}

function orderExportLine(cells: readonly string[]): string {
  return cells.map(cell => /[",\r\n]/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell).join(",") + ",\r\n";
}

/** DumpOrdersForType writes the entire regional response, sells before buys. */
export function formatMarketBookExport(result: JsonValue): { text: string; regionID: number } | null {
  const payload = unwrapCachedResult(result);
  if (!Array.isArray(payload)) return null;
  const [sellRowset = null, buyRowset = null] = payload;
  const sells = rowRecords(sellRowset);
  const buys = rowRecords(buyRowset);
  const rows = [...sells, ...buys];
  if (!rows.length) return null;
  const columns = rowsetColumns(sells.length ? sellRowset : buyRowset);
  const text = orderExportLine(columns) + rows.map(row => orderExportLine(
    columns.map(column => exportOrderValue(column, row[column] ?? null)),
  )).join("");
  return { text, regionID: toNumber(rows[0]?.regionID) };
}

function toNumber(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const long = unwrapLong(value);
  if (long !== null) {
    return Number(long);
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return 0;
}

/**
 * An amount as a bigint-safe DECIMAL STRING. ISK in EveJS exceeds 2^53 in
 * ordinary play, so a balance never becomes a JS number on its way to the
 * screen (R7d: "ISK as decimal strings, never raw longs").
 */
export function toAmountString(value: JsonValue | undefined): string | null {
  const long = unwrapLong(value);
  if (long !== null) {
    return long.toString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return value;
  }
  return null;
}

/** A FILETIME instant, kept as a bigint (it exceeds 2^53); null when absent. */
function toFiletime(value: JsonValue | undefined): bigint | null {
  const long = unwrapLong(value);
  if (long !== null && long > 0n) {
    return long;
  }
  return null;
}

// --- Order book (marketProxy.GetOrders) -------------------------------------

/**
 * Decode `GetOrders(typeID)` — the 2-TUPLE `[sellsRowset, buysRowset]`.
 *
 * ⚠ ORDER MATTERS AND IS NOT SYMMETRIC. `[0]` is sells (what you can BUY from),
 * `[1]` is buys (what you can SELL to). Transposing them is not a cosmetic bug:
 * it shows a player the wrong prices for the direction they are trading in.
 * Every row already carries `bid`, so the tuple position is cross-checked
 * against it rather than trusted.
 */
/**
 * marketsvc.GetAveragePrice(typeID, days=7) (368 to 386): over the joined history's rows of the last `days` days, the
 * sum of each day's average times its quantity over the sum of the quantities; with nothing traded, the type's base
 * price over its portion size, or 1.0 where that is nothing; rounded to the hundredth. `now` is the clock in 100 ns
 * ticks.
 */
export function averagePriceOf(
  history: readonly MarketPriceHistoryRow[],
  now: bigint,
  fallback: { readonly basePrice: number | null; readonly portionSize: number | null },
  days = 7,
): number {
  let volume = 0;
  let priceVolume = 0.0;
  for (const entry of history) {
    if (entry.day === null || entry.day < now - BigInt(days) * DAY_OF_FILETIME) continue;
    priceVolume += Number(entry.average) * entry.volume;
    volume += entry.volume;
  }
  let average: number;
  if (volume > 0) {
    average = priceVolume / volume;
  } else {
    average = (fallback.basePrice ?? 0) / (fallback.portionSize || 1);
    if (!(average > 0.0)) average = 1.0;
  }
  return Number(average.toFixed(2));
}

/** buySellItemContainerBase.GetDelta (57 to 63): how far a price is from the average, a fraction of it; nought with no price. */
export function priceDelta(price: number | null, average: number): number {
  return price === null ? 0 : (price - average) / average;
}

/**
 * MultiBuy.GetOrderDelta (489 to 498): over the rows with a price, each row's distance from its average weighted by
 * its share of the whole.
 */
export function orderDelta(rows: readonly { readonly total: number; readonly quantity: number; readonly average: number }[]): number {
  const totalPrice = rows.reduce((sum, row) => sum + row.total, 0);
  let change = 0;
  for (const row of rows) {
    const atAverage = row.quantity * row.average;
    change += ((row.total - atAverage) / atAverage) * row.total / totalPrice;
  }
  return change;
}

/**
 * marketQuote.GetBestAskPriceInStationAndNumberOrders (marketsvc.py 603 to 616): the sell orders at the station,
 * cheapest first, taken until they hold the amount; the price of the last one taken, and how many were taken. Nulls
 * where the station's orders do not hold it.
 */
export function bestAskInStation(
  sells: readonly MarketOrderRow[],
  stationID: number,
  amount: number,
): { readonly price: number | null; readonly numOrders: number | null } {
  const atStation = sells.filter((order) => order.stationID === stationID).sort((left, right) => Number(left.price) - Number(right.price));
  let held = 0;
  let taken = 0;
  for (const order of atStation) {
    held += order.volumeRemaining;
    taken += 1;
    if (held >= amount) return { price: Number(order.price), numOrders: taken };
  }
  return { price: null, numOrders: null };
}

/**
 * marketQuote.GetBestAskInRange (marketsvc.py 585 to 601): the first sell order, in the order the server answered
 * them, within the range of the station with at least `amount` left; null where none is. An order at the station
 * itself is nearer than its system (-1), one elsewhere in the system none (0), one further off as many jumps away
 * as the server counted from the pilot's system (the order's `jumps`; the client counts them from the station's own
 * system, which is the pilot's where it is docked there).
 */
export function bestAskInRange(
  sells: readonly MarketOrderRow[],
  stationID: number,
  solarSystemID: number | null,
  range: number,
  amount = 1,
): MarketOrderRow | null {
  for (const order of sells) {
    const jumps = order.stationID === stationID ? RANGE_STATION : solarSystemID !== null && order.solarSystemID === solarSystemID ? 0 : Math.max(1, order.jumps);
    if (jumps <= range && order.volumeRemaining >= amount) return order;
  }
  return null;
}

export function decodeOrderBook(result: JsonValue): {
  readonly sells: readonly MarketOrderRow[];
  readonly buys: readonly MarketOrderRow[];
} {
  const payload = unwrapCachedResult(result);
  const tuple = Array.isArray(payload) ? (payload as readonly JsonValue[]) : [];
  return {
    sells: decodeOrderRows(tuple[0] ?? null, "sell"),
    buys: decodeOrderRows(tuple[1] ?? null, "buy"),
  };
}

function decodeOrderRows(rowset: JsonValue, expected: MarketSide): readonly MarketOrderRow[] {
  const rows: MarketOrderRow[] = [];
  for (const record of rowRecords(rowset)) {
    const orderID = toAmountString(record.orderID);
    if (orderID === null || orderID === "0") {
      continue;
    }
    // The row's own `bid` flag is authoritative; the tuple position is only a
    // hint. A row that disagrees with its half is dropped rather than rendered
    // on the wrong side of the book.
    const side: MarketSide = toNumber(record.bid) === 1 ? "buy" : "sell";
    if (side !== expected) {
      continue;
    }
    rows.push({
      orderID,
      side,
      typeID: toNumber(record.typeID),
      stationID: toNumber(record.stationID),
      solarSystemID: toNumber(record.solarSystemID),
      regionID: toNumber(record.regionID),
      price: toAmountString(record.price) ?? "0",
      volumeRemaining: toNumber(record.volRemaining),
      volumeEntered: toNumber(record.volEntered),
      minimumVolume: toNumber(record.minVolume),
      // How far this order REACHES, in jumps. -1 means "this station only",
      // 32767 means "anywhere in the region" — decoded to words, never shown
      // as either number.
      range: toNumber(record.range),
      // How far AWAY the order is from where the player is standing. The
      // SERVER computed this from the session's own position; the browser
      // never works out a distance itself.
      jumps: toNumber(record.jumps),
      durationDays: toNumber(record.duration),
      issuedAt: toFiletime(record.issueDate),
    });
  }
  return rows;
}

// --- The player's own orders (marketProxy.GetCharOrders / …OrderHistory) ----

/** orderState code -> what actually became of the order. */
const FILL_STATE_BY_CODE: Readonly<Record<number, MarketOwnFillState>> = {
  0: "open",
  1: "filled",
  2: "expired",
  3: "cancelled",
};

/** Player-facing wording for an order's fate (R9a: plain, not a code). */
export const FILL_STATE_LABELS: Readonly<Record<MarketOwnFillState, string>> = {
  open: "Still open",
  filled: "Completed",
  expired: "Ran out of time",
  cancelled: "You cancelled it",
};

export function decodeOwnOrders(result: JsonValue): readonly MarketOwnOrderRow[] {
  const rows: MarketOwnOrderRow[] = [];
  for (const record of rowRecords(unwrapCachedResult(result))) {
    const orderID = toAmountString(record.orderID);
    if (orderID === null || orderID === "0") {
      continue;
    }
    const stateCode = toNumber(record.orderState);
    rows.push({
      orderID,
      side: toNumber(record.bid) === 1 ? "buy" : "sell",
      typeID: toNumber(record.typeID),
      stationID: toNumber(record.stationID),
      solarSystemID: toNumber(record.solarSystemID),
      regionID: toNumber(record.regionID),
      price: toAmountString(record.price) ?? "0",
      volumeRemaining: toNumber(record.volRemaining),
      volumeEntered: toNumber(record.volEntered),
      minimumVolume: toNumber(record.minVolume),
      range: toNumber(record.range),
      durationDays: toNumber(record.duration),
      // ISK locked behind a buy order. The SERVER computed it; the panel never
      // multiplies price by volume to guess at it.
      escrow: toAmountString(record.escrow) ?? "0",
      state: FILL_STATE_BY_CODE[stateCode] ?? "open",
      issuedAt: toFiletime(record.issueDate),
      // Corp orders are out of scope; a row flagged corp is kept and labelled
      // rather than hidden, so a player is never shown a partial picture.
      isCorp: toNumber(record.isCorp) === 1,
    });
  }
  return rows;
}

// --- Transactions (marketProxy.CharGetTransactions) -------------------------

/**
 * Decode the transaction list — a plain `list<util.KeyVal>`, NOT a rowset and
 * NOT cached.
 *
 * ⚠ WHICH SIDE A TRADE WAS. There is no "isBuy" column. A transaction names a
 * buyerID and a sellerID, and the character is one of them; the direction is
 * derived by comparing against the character's own id, which is why
 * `decodeTransactions` takes it. Guessing from the sign of anything would be
 * wrong.
 */
export function decodeTransactions(
  result: JsonValue,
  characterID: number,
): readonly MarketTransactionRow[] {
  if (!isListValue(result)) {
    return [];
  }
  const rows: MarketTransactionRow[] = [];
  for (const entry of result.items) {
    const typeID = toNumber(readKeyVal(entry, "typeID"));
    if (typeID <= 0) {
      continue;
    }
    const buyerID = toNumber(readKeyVal(entry, "buyerID"));
    const sellerID = toNumber(readKeyVal(entry, "sellerID"));
    rows.push({
      transactionID: toAmountString(readKeyVal(entry, "transactionID")) ?? "0",
      typeID,
      quantity: toNumber(readKeyVal(entry, "quantity")),
      price: toAmountString(readKeyVal(entry, "price")) ?? "0",
      stationID: toNumber(readKeyVal(entry, "stationID")),
      // "bought" when the character was the BUYER. A row where the character is
      // neither party should not exist, and decodes as null rather than a
      // default that would mislabel it.
      side: buyerID === characterID ? "bought" : sellerID === characterID ? "sold" : null,
      transactedAt: toFiletime(readKeyVal(entry, "transactionDate")),
    });
  }
  return rows;
}

// --- Escrow (marketProxy.GetCharEscrow) -------------------------------------

export function decodeEscrow(result: JsonValue): MarketEscrow {
  return {
    isk: toAmountString(readKeyVal(result, "iskEscrow")) ?? "0",
    items: toNumber(readKeyVal(result, "itemsEscrow")),
  };
}

// --- Price history ----------------------------------------------------------

export function decodePriceHistory(result: JsonValue): readonly MarketPriceHistoryRow[] {
  const rows: MarketPriceHistoryRow[] = [];
  for (const record of rowRecords(unwrapCachedResult(result))) {
    rows.push({
      day: toFiletime(record.historyDate),
      low: toAmountString(record.lowPrice) ?? "0",
      high: toAmountString(record.highPrice) ?? "0",
      average: toAmountString(record.avgPrice) ?? "0",
      volume: toNumber(record.volume),
      orders: toNumber(record.orders),
    });
  }
  return rows;
}

/** A day of the clock's 100 ns ticks. */
const DAY_OF_FILETIME = 864000000000n;

/**
 * A day of a price history as a date. The day begins at midnight by the game's clock, which is UTC, and is named
 * by that calendar: by the reader's own, west of it, that midnight is the evening before.
 */
export function historyDayText(day: bigint | null): string {
  if (day === null) return "—";
  const unixMs = Number(day / 10000n - 11644473600000n);
  return Number.isFinite(unixMs) && unixMs > 0 ? new Date(unixMs).toLocaleDateString(undefined, { timeZone: "UTC" }) : "—";
}

/**
 * marketsvc.GetHistoryRowList (344): a type's price history from the two halves the game asks it in.
 *
 * The old half's days in order, and for each day with no trade between two of them a row at the average of the
 * day before, which the client gives 2 for the quantity and 2 for the orders. Then the same from the last of the
 * old half up to yesterday. Then the new half as it came, or, where there is none, one row for now at the last
 * price with nothing traded. `now` is the clock in 100 ns ticks.
 *
 * As the client has it, and so with its two oddities: nothing is filled in before the first day of the old half
 * (it starts counting from now), and the new half goes last whatever its days are.
 */
export function joinPriceHistory(
  old: readonly MarketPriceHistoryRow[],
  fresh: readonly MarketPriceHistoryRow[],
  now: bigint,
): readonly MarketPriceHistoryRow[] {
  const history: MarketPriceHistoryRow[] = [];
  const carried = (day: bigint, price: string, tradedAndOrders: number): MarketPriceHistoryRow =>
    ({ day, low: price, high: price, average: price, volume: tradedAndOrders, orders: tradedAndOrders });
  const midnightToday = (now / DAY_OF_FILETIME) * DAY_OF_FILETIME;
  let lastTime = now;
  let lastPrice = "0";
  for (const entry of old) {
    if (entry.day === null) {
      history.push(entry);
      continue;
    }
    while (lastTime + DAY_OF_FILETIME < entry.day) {
      lastTime += DAY_OF_FILETIME;
      history.push(carried(lastTime, lastPrice, 2));
    }
    history.push(entry);
    lastTime = entry.day;
    lastPrice = entry.average;
  }
  while (lastTime < midnightToday - DAY_OF_FILETIME) {
    lastTime += DAY_OF_FILETIME;
    history.push(carried(lastTime, lastPrice, 2));
  }
  if (fresh.length > 0) {
    history.push(...fresh);
  } else {
    history.push(carried(now, lastPrice, 0));
  }
  return history;
}

// =============================================================================
// marketQuote, client-side
// =============================================================================
// Everything below is the half of the market retail implements in the CLIENT.
// There is no server call for any of it — see trap 2 at the top of this file.

/** The range sentinels the server speaks in. Never rendered as numbers. */
export const RANGE_STATION = -1;
export const RANGE_SOLAR_SYSTEM = 0;
export const RANGE_REGION = 32767;

/**
 * How far an order reaches, in words (R7d/R9a). `range` is a jump count with
 * two sentinel values at the ends, and printing either of them raw ("-1
 * jumps", "32767 jumps") would be nonsense.
 */
export function rangeLabel(range: number): string {
  if (range === RANGE_STATION) {
    return "This station only";
  }
  if (range === RANGE_SOLAR_SYSTEM) {
    return "This system only";
  }
  if (range === RANGE_REGION) {
    return "Anywhere in the region";
  }
  if (range === 1) {
    return "Up to 1 jump away";
  }
  return `Up to ${range} jumps away`;
}

/** quote.py GetJumps: the jump count the client says as unreachable rather than as a number. */
const UNREACHABLE_JUMPS = 1000000;

/**
 * How far away an order is, in words, as the client's Jumps column says it (quote.py GetJumps, 426 to 439): an order
 * in the system is in the pilot's own station or structure, or elsewhere in the system; else unreachable, or its
 * jumps. `inPilotsStation` is the client's check of the order's station against session.stationid / structureid.
 * (EveJS sends -1 for the pilot's own station, as marketsvc.GetStationDistance does; the client's rows carry the
 * system's 0 there, RefreshJumps. Either is in the system.)
 */
export function distanceLabel(jumps: number, inPilotsStation = false): string {
  if (jumps <= 0) {
    return inPilotsStation ? "In this station" : "In this system";
  }
  if (jumps === UNREACHABLE_JUMPS) {
    return "Unreachable";
  }
  return jumps === 1 ? "1 jump away" : `${jumps} jumps away`;
}

/** The order durations the server accepts, as the player picks them. */
export const DURATION_CHOICES: readonly { readonly days: number; readonly label: string }[] = [
  { days: 0, label: "Fill it right now or not at all" },
  { days: 1, label: "1 day" },
  { days: 3, label: "3 days" },
  { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" },
  { days: 30, label: "1 month" },
  { days: 90, label: "3 months" },
];

/**
 * Compare two prices held as decimal STRINGS, without going through a JS
 * number. ISK exceeds 2^53, so `Number(a) - Number(b)` can compare two
 * different prices as equal. Returns <0, 0 or >0 like a comparator.
 */
export function comparePrice(left: string, right: string): number {
  const parse = (text: string): { neg: boolean; whole: string; frac: string } => {
    const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
    if (!match) {
      return { neg: false, whole: "0", frac: "" };
    }
    return { neg: match[1] === "-", whole: match[2] || "0", frac: match[3] ?? "" };
  };
  const a = parse(left);
  const b = parse(right);
  if (a.neg !== b.neg) {
    return a.neg ? -1 : 1;
  }
  const sign = a.neg ? -1 : 1;
  const aWhole = a.whole.replace(/^0+(?=\d)/, "");
  const bWhole = b.whole.replace(/^0+(?=\d)/, "");
  if (aWhole.length !== bWhole.length) {
    return aWhole.length < bWhole.length ? -sign : sign;
  }
  if (aWhole !== bWhole) {
    return aWhole < bWhole ? -sign : sign;
  }
  const width = Math.max(a.frac.length, b.frac.length);
  const aFrac = a.frac.padEnd(width, "0");
  const bFrac = b.frac.padEnd(width, "0");
  if (aFrac === bFrac) {
    return 0;
  }
  return aFrac < bFrac ? -sign : sign;
}

/**
 * Sort an order book the way a market window does: SELLS cheapest first (the
 * best thing to buy is at the top), BUYS highest first (the best thing to sell
 * into is at the top). Ties break on distance, so of two equally-priced orders
 * the nearer one is preferred — which is what a player would pick.
 *
 * Pure and non-mutating: the caller's array is never reordered in place.
 */
export function sortOrderBook(
  rows: readonly MarketOrderRow[],
  side: MarketSide,
): readonly MarketOrderRow[] {
  return [...rows].sort((left, right) => {
    const byPrice = comparePrice(left.price, right.price);
    if (byPrice !== 0) {
      return side === "sell" ? byPrice : -byPrice;
    }
    return left.jumps - right.jumps;
  });
}

/**
 * Keep only the orders within `maxJumps` of where the player is.
 *
 * A negative or non-finite limit means "no limit" — a filter that silently
 * hid every order would look exactly like an empty market.
 */
export function filterByJumps(
  rows: readonly MarketOrderRow[],
  maxJumps: number,
): readonly MarketOrderRow[] {
  if (!Number.isFinite(maxJumps) || maxJumps < 0) {
    return rows;
  }
  return rows.filter((row) => row.jumps <= maxJumps);
}

/**
 * The best price on each side: the cheapest sell and the highest buy.
 *
 * ⚠ THIS IS A READING OF THE BOOK, NOT A QUOTE. It says what is on offer right
 * now, in this region, as of the last read. It is not a promise about what a
 * trade will cost — the server matches orders itself, and it is authoritative.
 */
export function bestPrices(book: {
  readonly sells: readonly MarketOrderRow[];
  readonly buys: readonly MarketOrderRow[];
}): { readonly bestSell: string | null; readonly bestBuy: string | null } {
  const sells = sortOrderBook(book.sells, "sell");
  const buys = sortOrderBook(book.buys, "buy");
  return {
    bestSell: sells[0]?.price ?? null,
    bestBuy: buys[0]?.price ?? null,
  };
}

// --- Client-side guards the retail client enforces BEFORE dispatch ----------

/**
 * The server's own ceiling on an order price (marketRules.MARKET_MAX_ORDER_PRICE
 * = 9_223_372_036_854.0 — the ISK value at which the underlying signed 64-bit
 * scaled representation overflows). Retail rejects a price above it in the
 * client rather than sending it, and so do we: a rejection here is a clear
 * message, where a rejection there is an opaque refusal.
 */
export const MAX_ORDER_PRICE = 9_223_372_036_854;

/**
 * Round a price to 2 decimal places, exactly as the server's `roundIsk` does
 * (`Math.round(value * 100) / 100`).
 *
 * ⚠ WHY THE CLIENT ROUNDS TOO. The server rounds whatever it is sent, so an
 * unrounded price is not rejected — it is silently CHANGED. Rounding here means
 * the number in the confirm dialog is the number that gets used, instead of the
 * player agreeing to 5.555 and getting 5.56.
 */
export function roundPrice(price: number): number {
  if (!Number.isFinite(price)) {
    return 0;
  }
  return Math.round(price * 100) / 100;
}

export interface PriceCheck {
  readonly ok: boolean;
  /** The rounded price actually to be sent; 0 when the check failed. */
  readonly price: number;
  /** Plain-language reason, when the check failed. */
  readonly message: string | null;
}

/** The guards retail applies before it will even send an order. */
export function checkPrice(raw: number): PriceCheck {
  if (!Number.isFinite(raw) || raw <= 0) {
    return { ok: false, price: 0, message: "Enter a price above zero." };
  }
  const price = roundPrice(raw);
  if (price > MAX_ORDER_PRICE) {
    return {
      ok: false,
      price: 0,
      message: "That price is higher than the market allows. Try a smaller number.",
    };
  }
  if (price <= 0) {
    return {
      ok: false,
      price: 0,
      message: "That price rounds down to nothing. Enter at least 0.01 ISK.",
    };
  }
  return { ok: true, price, message: null };
}

export function checkQuantity(raw: number): { readonly ok: boolean; readonly message: string | null } {
  if (!Number.isSafeInteger(raw) || raw <= 0) {
    return { ok: false, message: "Enter how many you want, as a whole number above zero." };
  }
  return { ok: true, message: null };
}

// --- The broker's fee: an ESTIMATE, and labelled as one ---------------------

/**
 * The standard broker's commission before any of the things that change it.
 * (marketRules.MARKET_BROKER_COMMISSION_PERCENT = 3.0.)
 */
export const STANDARD_BROKER_RATE = 0.03;
/** The server's floor on a broker fee (marketRules.MARKET_MINIMUM_BROKER_FEE). */
export const MINIMUM_BROKER_FEE = 100;

export interface BrokerFeeEstimate {
  /** The fee in ISK, as a decimal string. */
  readonly amount: string;
  /** True when the fee is the server's floor rather than a percentage. */
  readonly atMinimum: boolean;
  /** The rate the fee was worked out at, as a fraction. */
  readonly rate: number;
  /**
   * True at the standard rate, which is a guess; false at the pilot's own rate, which the BFF worked out as the
   * game works it out and the server holds an order to.
   */
  readonly estimated: boolean;
}

/**
 * ⚠ AN ESTIMATE. NOT THE COST. Read this before using the number.
 *
 * The broker's fee the server actually charges is
 *   3% - (Broker Relations level x 0.3%) - (faction standing x 0.03%)
 *        - (corporation standing x 0.02%)
 * with a floor of 100 ISK, and at a player-owned structure it is whatever that
 * structure's owner set instead. NONE of those inputs is reachable from the
 * browser: no allowlisted read answers the character's Broker Relations level
 * or their standings toward this station's owner. So this function computes the
 * fee at the STANDARD 3% rate and nothing more.
 *
 * What that means in practice, and what the panel must say:
 *  - trained skills and good standings make the real fee LOWER than this;
 *  - poor standings can make it slightly HIGHER (up to about 3.5%);
 *  - a player-owned structure can set it anywhere.
 *
 * So at the standard rate this is never presented as the cost. It is labelled
 * an estimate, and the ACTUAL charge is reported afterwards by re-reading the
 * wallet.
 *
 * WITH `rate` it is not an estimate. On the game port the BFF works the
 * pilot's own rate out as the game client does, from the pilot's Broker
 * Relations and the standings the station's owner and its faction have to it
 * (the Market read's `brokersFeeRate`), and the server holds an order to that
 * rate. The fee is then the order's value at that rate, with the same floor
 * (BrokerFeeProvider.GetBrokerFeeInfo). What was charged is still reported
 * afterwards from the wallet.
 */
export function estimateBrokerFee(price: number, quantity: number, rate: number | null = null): BrokerFeeEstimate {
  const known = typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
  const applied = known ? rate : STANDARD_BROKER_RATE;
  const value = roundPrice(price) * Math.max(0, Math.trunc(quantity));
  const raw = roundPrice(value * applied);
  const atMinimum = raw <= MINIMUM_BROKER_FEE;
  return {
    amount: formatIskNumber(atMinimum ? MINIMUM_BROKER_FEE : raw),
    atMinimum,
    rate: applied,
    estimated: !known,
  };
}

/** The words that go beside a fee: its heading, what stands before the amount, and its rate as a percentage. */
export function brokerFeeWords(fee: BrokerFeeEstimate | null): { heading: string; before: string; percent: string | null } {
  const known = fee !== null && !fee.estimated;
  return {
    heading: known ? "Broker's fee" : "Broker's fee (estimate)",
    before: known ? "" : "about ",
    percent: fee === null ? null : (fee.rate * 100).toFixed(2),
  };
}

/**
 * What a known rate is made of, for the sentence under the fee. In a station it is the pilot's own, from its
 * Broker Relations and the standings the station's owner and its faction have to it. In a structure it is the
 * structure's own market tax (marketsvc.py 229 to 242: no skill is taken off there; 745: no standing counts for an
 * owner that is no NPC), and a structure's market takes the SCC's surcharge on an order as well (marketsvc.py
 * 182), which the page does not show.
 */
export function brokerFeeBasisWords(inStructure: boolean): { rate: string; madeOf: string; also: string } {
  return inStructure
    ? {
        rate: "this structure's own rate",
        madeOf: "which its owner sets; your skills and standings change nothing here",
        also: " A structure's market also takes the SCC's surcharge on an order, which is not shown here.",
      }
    : { rate: "your own rate", madeOf: "from your Broker Relations skill and how this station's owner regards you", also: "" };
}

// --- Money formatting -------------------------------------------------------

/**
 * Format an ISK amount held as a DECIMAL STRING, with thousands separators and
 * exactly two decimal places — never via a JS number, so a balance beyond 2^53
 * is not rounded on its way to the screen (R7d).
 */
export function formatIsk(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === "") {
    return "—";
  }
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(amount).trim());
  if (!match) {
    return "—";
  }
  const sign = match[1];
  const whole = (match[2] || "0").replace(/^0+(?=\d)/, "");
  const frac = (match[3] ?? "").padEnd(2, "0").slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}.${frac} ISK`;
}

/** A JS number as the decimal string the rest of this module works in. */
export function formatIskNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return value.toFixed(2);
}

/**
 * The difference between two ISK balances held as decimal strings, as a decimal
 * string. This is how the ACTUAL cost of an order is worked out: wallet before
 * minus wallet after. Exact — it goes through BigInt hundredths, not floats.
 */
export function iskDelta(before: string | null, after: string | null): string | null {
  if (before === null || after === null) {
    return null;
  }
  const toHundredths = (text: string): bigint | null => {
    const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
    if (!match) {
      return null;
    }
    const frac = (match[3] ?? "").padEnd(2, "0").slice(0, 2);
    const value = BigInt(`${match[2] || "0"}${frac}`);
    return match[1] === "-" ? -value : value;
  };
  const left = toHundredths(before);
  const right = toHundredths(after);
  if (left === null || right === null) {
    return null;
  }
  const diff = left - right;
  const negative = diff < 0n;
  const magnitude = negative ? -diff : diff;
  const whole = magnitude / 100n;
  const frac = (magnitude % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

// --- Refusals ---------------------------------------------------------------

/**
 * Plain-language sentences for the refusals the market raises.
 *
 * These are NOT invented causes. Every key is an error name the SERVER chose;
 * turning it into a sentence is presentation, exactly as the industry panel
 * does. A refusal with no entry here is passed through as the server worded it,
 * and a refusal with no wording at all is reported as exactly that — no reason
 * is ever invented.
 */
const REFUSAL_SENTENCES: Readonly<Record<string, string>> = {
  MktBrokersFeeUnexpected2:
    "The broker's fee here is not what you were shown, so the order was not placed. Open the order again to see the current fee.",
  MktOrderDidNotMatch: "Nothing on the market matched that order at that price.",
  MktNotEnoughMoney: "You do not have enough ISK for that order and its fees.",
  MktInvalidPrice: "That price is not one the market will accept.",
  MktInvalidQuantity: "That quantity is not one the market will accept.",
  MktOrderLimitReached: "You already have as many orders open as your trade skills allow.",
  MktOrderDoesNotExist: "That order no longer exists.",
  MktNotYourOrder: "That order does not belong to you.",
  MarketUnavailable:
    "The market is not answering right now, so nothing was changed. Try again in a moment.",
};

/** Turn a bridge refusal into something a player can read. */
export function marketRefusalMessage(error: unknown): string {
  const raw =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  if (!raw) {
    return "The server did not apply that change, and gave no reason.";
  }
  for (const [name, sentence] of Object.entries(REFUSAL_SENTENCES)) {
    if (raw.includes(name)) {
      return sentence;
    }
  }
  // The handler's OWN sentence ("No matching sell orders were available at the
  // requested price."). Never reworded.
  return raw;
}
