// pvptradesvc26-51; TQ In station trade41-48: a server-returned Moniker,
// followed by a lazy carried List and a carbon Row. EveJS sends the same fields as util.Row.
import type { Ask } from "./ask.ts";
import { isListValue, readDictEntry, unwrapLong, type JsonValue } from "./wire.ts";

export interface TradeMoniker {
  readonly params: JsonValue;
  readonly traders: readonly [number, number];
  /** Companion carriage reference for this received Moniker; never sent to EveJS. */
  readonly reference: string;
}
export interface DirectTradeState {
  readonly containerID: number;
  readonly traders: readonly [number, number];
  /** Native offers are manifests or None, not numeric acceptance flags. */
  readonly offers: readonly [JsonValue, JsonValue];
  readonly money: readonly [number, number];
  readonly items: readonly JsonValue[];
}
const positive = (value: unknown): number | null => {
  const integer = unwrapLong(value);
  return integer !== null && integer > 0n && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : null;
};
const objectOf = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, JsonValue>> : null;
const pairOf = (value: unknown): readonly [number, number] | null => {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = positive(value[0]), b = positive(value[1]);
  return a !== null && b !== null ? [a, b] : null;
};
export function tradeMonikerOf(value: JsonValue): TradeMoniker | null {
  const moniker = objectOf(value);
  if (moniker === null || moniker.type !== "object" || moniker.name !== "carbon.common.script.net.moniker.Moniker"
      || !Array.isArray(moniker.args) || moniker.args[0] !== "trademgr"
      || typeof moniker.tradeReference !== "string") return null;
  const params = moniker.args[2];
  if (!Array.isArray(params) || params.length !== 4) return null;
  const traders = pairOf(params[2]);
  return traders === null ? null : { params, traders, reference: moniker.tradeReference };
}
function rowField(row: JsonValue, name: string): JsonValue | undefined {
  const record = objectOf(row);
  if (record?.type !== "object" || (record.name !== "carbon.common.script.sys.row.Row" && record.name !== "util.Row")) return undefined;
  const header = readDictEntry(record.args, "header"), line = readDictEntry(record.args, "line");
  if (!isListValue(header) || !isListValue(line)) return undefined;
  const at = header.items.indexOf(name);
  return at < 0 ? undefined : line.items[at];
}
export function directTradeStateOf(row: JsonValue): DirectTradeState | null {
  const containerID = positive(rowField(row, "tradeContainerID")), traders = pairOf(rowField(row, "traders"));
  const offers = rowField(row, "state"), money = rowField(row, "money"), items = objectOf(rowField(row, "items"));
  if (containerID === null || traders === null || !isListValue(offers) || offers.items.length !== 2
      || !isListValue(money) || money.items.length !== 2 || money.items.some(v => typeof v !== "number")
      || items === null || items.type !== "objectex1"
      || !Array.isArray(items.header)) return null;
  const [rawConstructor, args] = items.header, constructor = objectOf(rawConstructor);
  if (constructor === null
      || constructor.type !== "token" || constructor.value !== "__builtin__.set" || !Array.isArray(args)
      || !isListValue(args[0])) return null;
  return { containerID, traders, offers: [offers.items[0]!, offers.items[1]!],
    money: [money.items[0] as number, money.items[1] as number], items: args[0].items };
}
export async function initiateDirectTrade(act: Ask, characterID: number): Promise<TradeMoniker> {
  const moniker = tradeMonikerOf(await act("trademgr", "InitiateTrade", [characterID]));
  if (moniker === null) throw new Error("The server did not return a direct-trade moniker.");
  return moniker;
}
export async function listDirectTrade(ask: Ask, moniker: TradeMoniker): Promise<DirectTradeState> {
  const state = directTradeStateOf(await ask("trademgr", "List", [], null, moniker.reference));
  if (state === null) throw new Error("The server did not return a direct-trade Row.");
  return state;
}
export async function abortDirectTrade(act: Ask, moniker: TradeMoniker): Promise<void> {
  await act("trademgr", "Abort", [], null, moniker.reference);
}

/** BaseInvContainer.__AddItem193-226: PlayerTrade.locationFlag is inherited None. */
export async function addDirectTradeItem(act: Ask, moniker: TradeMoniker, itemID: number, sourceLocationID: number, quantity: number): Promise<void> {
  await act("trademgr", "Add", [itemID, sourceLocationID], { qty: quantity, flag: null }, moniker.reference);
}
/** AddItems489 onward sorts the selected stacks by total type volume before MultiAdd. */
export async function addDirectTradeItems(act: Ask, moniker: TradeMoniker,
  items: readonly { readonly itemID: number; readonly stacksize: number; readonly unitVolume: number }[], sourceLocationID: number): Promise<void> {
  const ids = [...items].sort((a, b) => a.unitVolume * a.stacksize - b.unitVolume * b.stacksize).map(item => item.itemID);
  await act("trademgr", "MultiAdd", [ids, sourceLocationID], { flag: 0 }, moniker.reference);
}
export async function offerDirectTradeMoney(act: Ask, moniker: TradeMoniker, amount: number): Promise<void> {
  await act("trademgr", "OfferMoney", [amount], null, moniker.reference);
}
/** OnClickAccept92-115: the native UI's ship-warning gate precedes this write. */
export async function makeDirectTradeOffer(act: Ask, moniker: TradeMoniker, state: DirectTradeState): Promise<void> {
  const items: JsonValue = { type: "objectex1", header: [{ type: "token", value: "__builtin__.set" }, [{ type: "list", items: state.items }]], list: [], dict: [] };
  await act("trademgr", "MakeOffer", [{ tradeContainerID: state.containerID, money: state.money, tradeItems: items }], null, moniker.reference);
}
