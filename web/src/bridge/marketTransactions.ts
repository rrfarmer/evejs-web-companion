// The wallet's Market Transactions, as the client has them.
//
// THE READ (marketSvc.GetPersonalMarketTransactions, 20 to 26): marketProxy.CharGetTransactions(None), every one of
// the pilot's trades. The market service keeps what it read until the pilot's own orders change (OnOwnOrdersChanged,
// 33 to 35) or the session resets (37 to 39), and the panel asks it each time its tab is chosen
// (baseTransactionsPanel.py OnTabSelect, 195 to 200).
//
// EACH TRANSACTION (_GetPersonalTransactionKeyVal, 51 to 63): bought where the pilot is its buyer; made for the
// corporation where the account it went through is not the pilot's own side's (accountID against buyerAccountID or
// sellerAccountID); the pilot's side and the client, the other party; its total, the price times the quantity, less
// for one bought.
//
// THE PANEL (marketTransactionsPanel.py; baseTransactionsPanel.py): a row's date, quantity, type, unit price, total
// (red for one bought, green for one sold), client and place; the date in the corporation's blue for one made for it,
// with its hint (GetScrollEntryData). Its filters (IsTransactionVisible, 167 to 185): buy, sell or both; at least so
// many; a total of at least so much; one type, from the types its trades are of (UpdateItemTypeCombo: "Any Item"
// first, then by name). A header sorts by its column (BaseTransactionsList._Cmp: the date by the transaction's
// number), and the rows go a hundred to a page (NUM_TRANSACTIONS_PER_PAGE) with "Showing first-last of all".

import type { Ask } from "./ask.ts";
import { isListValue, readKeyVal, unwrapLong, type JsonValue } from "./wire.ts";

/** The pilot's trades as the flow keeps them for the window: not read yet, read, or a read that failed. */
export interface MarketTransactionsRead {
  readonly loaded: boolean;
  readonly transactions: readonly MarketTransaction[];
  readonly error: string | null;
}

/**
 * GetPersonalMarketTransactions' call: CharGetTransactions(None), of the market proxy by its name. Fails as the call
 * fails, and where the server answered with nothing, which is no list at all.
 */
export async function readMarketTransactions(ask: Ask, sessionCharacterID: number): Promise<readonly MarketTransaction[]> {
  const answered = await ask("marketProxy", "CharGetTransactions", [null]);
  if (answered === null || answered === undefined || !isListValue(answered)) {
    throw new Error("Your market transactions could not be read (the server answered with no list).");
  }
  return decodeMarketTransactions(answered, sessionCharacterID);
}

/** walletUtil.AmAccountantOrTrader, independent of the division read gate. */
export function canViewCorporateMarketTransactions(role: string | null | undefined): boolean {
  try { return (BigInt(role ?? "0") & (256n | 18014398509481984n)) !== 0n; }
  catch { return false; }
}

export async function readCorporateMarketTransactions(ask: Ask, corporationID: number, accountKey: number | null): Promise<readonly MarketTransaction[]> {
  const answer = await ask("marketProxy", "CorpGetTransactions", [null, accountKey]);
  if (!isListValue(answer)) throw new Error("The corporation market transactions did not contain a list.");
  return decodeMarketTransactions(answer, 0, corporationID);
}

/** One of the pilot's trades, as the client's market service keeps it. */
export interface MarketTransaction {
  readonly transactionID: bigint;
  readonly transactionDate: bigint | null;
  readonly typeID: number;
  readonly quantity: number;
  /** ISK a unit. */
  readonly price: number;
  /** The station or structure it was made at. */
  readonly stationID: number;
  readonly isBuyTransaction: boolean;
  readonly isForCorp: boolean;
  /** The pilot's side: the buyer of one bought, the seller of one sold. */
  readonly characterID: number;
  readonly accountKey?: number;
  /** The other party. */
  readonly clientID: number;
  /** The price times the quantity, less for one bought. */
  readonly totalPrice: number;
}

function numberOf(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const long = unwrapLong(value);
  if (long !== null) return Number(long);
  return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : 0;
}

function bigOf(value: JsonValue | undefined): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  return unwrapLong(value);
}

/** CharGetTransactions' list, each as _GetPersonalTransactionKeyVal keeps it for the session's pilot. */
export function decodeMarketTransactions(result: JsonValue | null | undefined, sessionCharacterID: number, corporationID?: number): readonly MarketTransaction[] {
  if (result === null || result === undefined || !isListValue(result)) return [];
  const rows: MarketTransaction[] = [];
  for (const entry of result.items) {
    const typeID = numberOf(readKeyVal(entry, "typeID"));
    if (typeID <= 0) continue;
    const buyerID = numberOf(readKeyVal(entry, "buyerID"));
    const sellerID = numberOf(readKeyVal(entry, "sellerID"));
    const accountID = numberOf(readKeyVal(entry, "accountID"));
    const buyerAccount = numberOf(readKeyVal(entry, "buyerAccountID"));
    const sellerAccount = numberOf(readKeyVal(entry, "sellerAccountID"));
    const isBuyTransaction = corporationID === undefined ? buyerID === sessionCharacterID
      // Older emulator journal rows used the same account on both sides and stored the corporation as the wallet owner.
      : buyerAccount === sellerAccount && (buyerID === corporationID) !== (sellerID === corporationID)
        ? buyerID === corporationID : accountID === buyerAccount;
    const quantity = numberOf(readKeyVal(entry, "quantity"));
    const price = numberOf(readKeyVal(entry, "price"));
    const total = price * quantity;
    const date = bigOf(readKeyVal(entry, "transactionDate"));
    rows.push({
      transactionID: bigOf(readKeyVal(entry, "transactionID")) ?? 0n,
      transactionDate: date !== null && date > 0n ? date : null,
      typeID,
      quantity,
      price,
      stationID: numberOf(readKeyVal(entry, "stationID")),
      isBuyTransaction,
      isForCorp: corporationID === undefined && accountID !== (isBuyTransaction ? buyerAccount : sellerAccount),
      characterID: isBuyTransaction ? buyerID : sellerID,
      ...(corporationID === undefined ? {} : { accountKey: numberOf(readKeyVal(entry, "keyID")) || accountID }),
      clientID: isBuyTransaction ? sellerID : buyerID,
      totalPrice: isBuyTransaction ? -total : total,
    });
  }
  return rows;
}

/** The panel's filters (IsTransactionVisible): null where a filter is not set. */
export interface TransactionFilters {
  /** True for buys alone, false for sells alone. */
  readonly buy: boolean | null;
  readonly typeID: number | null;
  readonly minQuantity: number | null;
  readonly minValue: number | null;
}

export function transactionVisible(transaction: MarketTransaction, filters: TransactionFilters): boolean {
  if (filters.buy !== null && filters.buy !== transaction.isBuyTransaction) return false;
  if (filters.typeID && filters.typeID !== transaction.typeID) return false;
  if (filters.minQuantity && filters.minQuantity > transaction.quantity) return false;
  if (filters.minValue && filters.minValue > Math.abs(transaction.totalPrice)) return false;
  return true;
}

/** The columns a header sorts by (GetScrollHeaders and GetScrollEntryData's sort values). */
export type TransactionColumn = "date" | "quantity" | "type" | "price" | "total" | "client" | "where" | "member" | "division";

/**
 * The rows sorted by a column, as BaseTransactionsList._Cmp compares them: the date by the transaction's number, the
 * numbers as numbers, the words (`wordOf`: the type's, the client's and the place's as shown) as words. Equal rows keep
 * their order.
 */
export function sortedTransactions(
  rows: readonly MarketTransaction[],
  column: TransactionColumn,
  reverse: boolean,
  wordOf: (row: MarketTransaction, column: "type" | "client" | "where" | "member" | "division") => string,
): readonly MarketTransaction[] {
  const value = (row: MarketTransaction): bigint | number | string => {
    switch (column) {
      case "date": return row.transactionID;
      case "quantity": return row.quantity;
      case "price": return row.price;
      case "total": return row.totalPrice;
      default: return wordOf(row, column);
    }
  };
  const order = rows.map((row, index) => ({ row, index, key: value(row) }));
  order.sort((a, b) => {
    const compared = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    return (reverse ? -compared : compared) || a.index - b.index;
  });
  return order.map((entry) => entry.row);
}

/** NUM_TRANSACTIONS_PER_PAGE (walletConst.py 103). */
export const TRANSACTIONS_PER_PAGE = 100;

/** The type filter's choices (UpdateItemTypeCombo): each type the trades are of, by name. */
export function transactionTypes(rows: readonly MarketTransaction[], nameOf: (typeID: number) => string): readonly { readonly typeID: number; readonly name: string }[] {
  const seen = new Map<number, string>();
  for (const row of rows) if (!seen.has(row.typeID)) seen.set(row.typeID, nameOf(row.typeID));
  return [...seen].map(([typeID, name]) => ({ typeID, name })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.typeID - b.typeID));
}
