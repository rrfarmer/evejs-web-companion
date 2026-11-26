// A market order taken down by the page itself (the plan's Phase 6b).
//
// Until 2026-10-13 it was one route of the BFF (POST /api/bridge/market/cancel), which read the pilot's orders and
// wallet, made the call, read both again, and answered whether an order had gone and what the wallet had moved by.
//
// THE CALL, as the client makes it, from an order's own menu in the orders window and in the market's own lists
// ("Cancel Order": orders.py 277 and 304 to 306, entries.py 126 and 152 to 153):
//
//   marketutils.CancelOffer(order)                     quote.py 298 to 303
//     sm.GetService('marketQuote').CancelOrder(order.orderID, order.regionID)
//       self.GetMarketProxy().CancelCharOrder(orderID, regionID)      marketsvc.py 281 to 283
//
// the order's number and the region it is in, both off the order's own row in the pilot's orders. The client asks
// its pilot first (CancelMarketOrder, a yes or no, quote.py 300 to 301), and does nothing after: the server tells
// that the pilot's orders changed (OnOwnOrdersChanged), and the client's market service reads them again. No
// Tranquility recording has an order cancelled.
//
// THE PAGE'S WINDOW ASKS ITS PILOT FIRST, as it did, and says that the broker's fee is not returned.
//
// WHAT THE SERVER TAKES FROM THE CALLER: the order's number. It loads the order, which must be the session's own
// character's, and takes the region from the order itself: the region the call names is not read. It answers
// nothing, whether an order was taken down or was closed already.
//
// ⚠ THE ANSWER IS NOTHING, SO THE VERDICT IS READ: the pilot's orders and its wallet, before the call and after.
// An order that was among the pilot's and is no more was taken down; the wallet's difference is what it returned.
// A read that fails leaves its half of the verdict unknown, and is not made up.

import { failsTheReading, type Ask } from "./ask.ts";
import { decodeOwnOrders, iskDelta, RANGE_STATION, roundPrice, toAmountString } from "./market.ts";
import { readKeyVal, type JsonValue } from "./wire.ts";

/** One of the orders a list of the server's order KeyVals holds: its number, its type and what was left of it. */
export interface ListedOrder {
  readonly orderID: string;
  readonly typeID: number | null;
  readonly volRemaining: number | null;
}

/**
 * The orders a list of the server's order KeyVals holds, as the client reads them: BuyMultipleItems' answer
 * (marketsvc.BuyMulti: order.orderID, order.typeID) and OnOwnOrdersChanged's orders (order.orderID,
 * order.volRemaining, order.typeID). A row with no number is passed over.
 */
export function ordersListed(value: unknown): readonly ListedOrder[] {
  const items = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : [];
  const orders: ListedOrder[] = [];
  for (const item of items) {
    const orderID = toAmountString(readKeyVal(item, "orderID"));
    if (orderID === null) continue;
    const typeID = Number(readKeyVal(item, "typeID"));
    const remaining = Number(toAmountString(readKeyVal(item, "volRemaining")) ?? NaN);
    orders.push({ orderID, typeID: Number.isSafeInteger(typeID) && typeID > 0 ? typeID : null, volRemaining: Number.isFinite(remaining) ? remaining : null });
  }
  return orders;
}

/** What an order's taking down came to, as the pilot's orders and wallet say. */
export interface MarketOrderChange {
  /** The order was among the pilot's before and is not after. */
  readonly applied: boolean;
  /** The server answered, and the order is still there (or the orders could not be read to say). */
  readonly declinedSilently: boolean;
  /** ISK taken (positive) or returned (negative), exact, as a decimal string; null where a balance was not read. */
  readonly charged: string | null;
  readonly balanceAfter: string | null;
}

/** A read that may fail by itself: null then, unless the whole reading failed (no session, no BFF). */
async function quietly<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (reason) {
    if (failsTheReading(reason)) throw reason;
    return null;
  }
}

/**
 * The wallet's balance as an exact decimal string. The server sends it as a real, rounded to cents: where a
 * transport hands the real on in its wrapper, the cents are kept as the route kept them.
 */
function walletAmount(value: JsonValue): string | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && (value as { type?: JsonValue }).type === "real") {
    const real = (value as { value?: JsonValue }).value;
    return typeof real === "number" && Number.isFinite(real) ? real.toFixed(2) : null;
  }
  return toAmountString(value);
}

/**
 * Takes down one of the pilot's own orders, named by its number as the pilot's orders have it. `act` makes the
 * write and `ask` the reads. Fails as the call fails.
 */
export async function cancelOrder(act: Ask, ask: Ask, orderID: string): Promise<MarketOrderChange> {
  if (!/^\d+$/.test(orderID)) throw new Error("That order could not be identified.");
  const orders = () => quietly(async () => decodeOwnOrders(await ask("marketProxy", "GetCharOrders", [])));
  const balance = () => quietly(async () => walletAmount(await ask("account", "GetCashBalance", [0])));
  const before = await orders();
  const balanceBefore = await balance();
  // The region off the order's own row, as the client names it (quote.py 302). Where the page's read has not the
  // order, nought goes, as the route sent: the server takes the region from the order it loads.
  const row = before === null ? undefined : before.find((order) => order.orderID === orderID);
  await act("marketProxy", "CancelCharOrder", [orderID, row?.regionID ?? 0]);
  const balanceAfter = await balance();
  const after = await orders();
  const applied = row !== undefined && after !== null && !after.some((order) => order.orderID === orderID);
  return { applied, declinedSilently: !applied, charged: iskDelta(balanceBefore, balanceAfter), balanceAfter };
}

// ORDERS PLACED AND REPRICED, by the page itself since 2026-10-14. Until then three routes of the BFF
// (POST /api/bridge/market/buy, /sell and /modify), which read the wallet, made the call, and read the wallet and the
// orders again, as these do.
//
// THE CALLS, as the client's market service makes them (marketsvc.py):
//
//   BuyStuff (256 to 268)    PlaceBuyOrder(stationID, typeID, round(price, 2), quantity, orderRange, minVolume,
//                            duration, useCorp, expectedBrokersFee), the price a float; from the buy window
//                            (buyThisTypeWindow.py 647 to 701): the range the station's where the window has no range
//                            of its own, the least a fill takes 1, the duration nought for a buy at once, not for the
//                            corporation, and the broker's fee rate the window showed
//   SellMulti (275 to 276)   PlaceMultiSellOrder(itemList, useCorp, duration, expectedBrokersFee), each item a
//                            util.KeyVal of the stack, its station and type, the price and the number (sellMulti.py
//                            462, 483 on)
//   ModifyOrder (285 to 289) ModifyCharOrder(order.orderID, newPrice, order.bid, order.stationID,
//                            order.solarSystemID, order.price, order.range, order.volRemaining, order.issueDate), all
//                            but the new price off the order's own row (quote.py 285 to 290, buyThisTypeWindow.py
//                            603 to 622)
//
// THE BROKER'S FEE RATE is the client's working-out from the pilot's skills and standings and the station's owner
// (marketutil/brokerFee.py, skilllimits.py), and its window names the rate it showed. The page names the rate the
// market read gave where it was made at the same place (the game port works it out: pilots.js brokersFeeAt), and
// None where it has none (through the gateway, nothing works it out); the game port names its own rate where None
// comes, and how far a sale's price is from the type's average, which the page has not (src/gamePort/retailCalls.js).
// The server holds an order to a rate named and checks none where None is named (marketProxyService.js,
// validateExpectedBrokerFeePercentage). A sale names the rate for an order that stands and None for a sale at once,
// each item carrying its own (sellMulti.py 443 to 446).
//
// ⚠ THE ANSWERS SAY LITTLE, SO THE VERDICT IS READ, as the routes read it: a buy answers None whether it bought,
// set an order up, or neither, and is judged by the wallet; a sale answers whether it traded or set an order up; a
// reprice answers None, and is judged by the order's price in the pilot's orders after.

/** What an order placed or repriced came to, as the pilot's wallet and orders say. */
export type MarketWriteChange = MarketOrderChange;

/** A buy at the station the pilot is docked in, as the client's buy window places it. */
export interface BuyOrder {
  readonly stationID: number;
  readonly typeID: number;
  readonly price: number;
  readonly quantity: number;
  readonly durationDays: number;
  /** The broker's fee rate the page showed for that station, as a fraction; null where it has none. */
  readonly brokersFeeRate: number | null;
}

/** One stack sold at the station it lies in. */
export interface SaleOfAStack {
  readonly stationID: number;
  readonly itemID: number;
  readonly typeID: number;
  readonly price: number;
  readonly quantity: number;
  readonly durationDays: number;
  /** The broker's fee rate the page showed for that station, as a fraction; null where it has none. */
  readonly brokersFeeRate: number | null;
}

/** Places a buy order (or buys at once, for a duration of nought). Fails as the call fails. */
export async function placeBuyOrder(act: Ask, ask: Ask, order: BuyOrder): Promise<MarketWriteChange> {
  const balance = () => quietly(async () => walletAmount(await ask("account", "GetCashBalance", [0])));
  const balanceBefore = await balance();
  await act("marketProxy", "PlaceBuyOrder", [
    order.stationID, order.typeID, roundPrice(order.price), order.quantity, RANGE_STATION, 1, order.durationDays, false, order.brokersFeeRate,
  ]);
  const balanceAfter = await balance();
  const charged = iskDelta(balanceBefore, balanceAfter);
  // A buy takes ISK whatever it did, the escrow or the goods' price and the fee; nought taken is nothing done.
  const applied = charged !== null && charged !== "0.00";
  return { applied, declinedSilently: !applied, charged, balanceAfter };
}

/** Sells one stack, at once or by an order that stands. Fails as the call fails. */
export async function placeSellOrder(act: Ask, ask: Ask, sale: SaleOfAStack): Promise<MarketWriteChange> {
  return placeSellOrders(act, ask, [sale], sale.durationDays, sale.brokersFeeRate);
}

/** The single-stack PLEX sale uses the market's PLEX-specific entry point. */
export async function placePlexSellOrder(act: Ask, ask: Ask, sale: SaleOfAStack): Promise<MarketWriteChange> {
  const { stationID, itemID, typeID, price, quantity, durationDays, brokersFeeRate } = sale;
  const balance = () => quietly(async () => walletAmount(await ask("account", "GetCashBalance", [0])));
  const balanceBefore = await balance();
  const entry = { stationID, itemID, typeID, price: roundPrice(price), quantity,
    ...(brokersFeeRate === null ? {} : { rawBrokerFeePercentage: brokersFeeRate }) };
  const applied = await act("marketProxy", "PlacePlexSellOrder", [entry, false, durationDays, durationDays === 0 ? null : brokersFeeRate]) === true;
  const balanceAfter = await balance();
  return { applied, declinedSilently: !applied, charged: iskDelta(balanceBefore, balanceAfter), balanceAfter };
}

/** Sell Items sends all confirmed stacks in a single PlaceMultiSellOrder call. */
export async function placeSellOrders(
  act: Ask, ask: Ask, sales: readonly Omit<SaleOfAStack, "durationDays" | "brokersFeeRate">[],
  durationDays: number, brokersFeeRate: number | null,
): Promise<MarketWriteChange> {
  const balance = () => quietly(async () => walletAmount(await ask("account", "GetCashBalance", [0])));
  const balanceBefore = await balance();
  const items = sales.map(({ stationID, typeID, itemID, price, quantity }): Record<string, JsonValue> => ({
    stationID, typeID, itemID, price: roundPrice(price), quantity,
    ...(brokersFeeRate === null ? {} : { rawBrokerFeePercentage: brokersFeeRate }),
  }));
  const answered = await act("marketProxy", "PlaceMultiSellOrder", [items, false, durationDays, durationDays === 0 ? null : brokersFeeRate]);
  const balanceAfter = await balance();
  const applied = answered === true;
  return { applied, declinedSilently: !applied, charged: iskDelta(balanceBefore, balanceAfter), balanceAfter };
}

/** One item of the multibuy window's Buy: its type, the price its row found, and how many in all. */
export interface MultiBuyItem {
  readonly typeID: number;
  readonly price: number;
  readonly quantity: number;
}

/**
 * The multibuy window's Buy (marketsvc.BuyMulti, buyMultiFromBase.py 296 to 311): BuyMultipleItems(stationID,
 * itemList, useCorp), each item a util.KeyVal of the station, type, price rounded to cents, quantity, the least fill
 * (1) and how far the price is from the type's average, which the game port works out as the client's row does
 * (src/gamePort/retailCalls.js); not for the corporation. Answers how many orders the server made. Fails as the call
 * fails.
 */
export async function buyMultipleItems(act: Ask, stationID: number, items: readonly MultiBuyItem[], useCorp = false): Promise<readonly ListedOrder[]> {
  // marketsvc.BuyMulti(stationID, itemList, useCorp): the corporation's wallet where the window's box is ticked
  // (buySellMultiBase.TradingForCorp).
  const answered = await act("marketProxy", "BuyMultipleItems", [
    stationID,
    items.map((item) => ({ stationID, typeID: item.typeID, price: roundPrice(item.price), quantity: item.quantity, minVolume: 1 })),
    useCorp,
  ]);
  // marketsvc.BuyMulti: the orders made, which the window keeps the numbers of (_PerformTrade, 307 to 308).
  return ordersListed(answered);
}

/** Gives one of the pilot's own orders a new price, the order named by its number as the pilot's orders have it. */
export async function modifyOrder(act: Ask, ask: Ask, orderID: string, price: number): Promise<MarketWriteChange> {
  if (!/^\d+$/.test(orderID)) throw new Error("That order could not be identified.");
  const orders = () => quietly(async () => decodeOwnOrders(await ask("marketProxy", "GetCharOrders", [])));
  const balance = () => quietly(async () => walletAmount(await ask("account", "GetCashBalance", [0])));
  const before = await orders();
  const row = before?.find((order) => order.orderID === orderID);
  if (!row) throw new Error("That order is not among your orders any more.");
  const balanceBefore = await balance();
  const newPrice = roundPrice(price);
  const issued: JsonValue = row.issuedAt === null ? null : { type: "long", value: row.issuedAt.toString() };
  await act("marketProxy", "ModifyCharOrder", [
    orderID, newPrice, row.side === "buy", row.stationID, row.solarSystemID, Number(row.price), row.range, row.volumeRemaining, issued,
  ]);
  const balanceAfter = await balance();
  const after = await orders();
  const now = after?.find((order) => order.orderID === orderID);
  const applied = now !== undefined && roundPrice(Number(now.price)) === newPrice;
  return { applied, declinedSilently: !applied, charged: iskDelta(balanceBefore, balanceAfter), balanceAfter };
}
