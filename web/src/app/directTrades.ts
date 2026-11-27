// pvptradesvc26-121 / pvptradewnd37-178: each received session owns a window.
// Inventory and offers follow notifications; opening reads follow the native
// service/window/two inventory consumers (the concurrent inventory List coalesces).
import type { Ask } from "../bridge/ask.ts";
import { abortDirectTrade, initiateDirectTrade, listDirectTrade, makeDirectTradeOffer,
  offerDirectTradeMoney, addDirectTradeItem, addDirectTradeItems, tradeMonikerOf, type DirectTradeState, type TradeMoniker } from "../bridge/directTrade.ts";
import { isListValue, readRowField, type JsonValue } from "../bridge/wire.ts";
import { createSignal, readonlySignal } from "../store/signals.ts";
import type { InventoryItemRow, InventoryPlace } from "../store/types.ts";
import { intSetOf } from "../bridge/py27DictOrder.ts";
import { decodeBlueprint } from "../bridge/industry.ts";

export interface DirectTradeWindow {
  readonly moniker: TradeMoniker;
  readonly state: DirectTradeState;
  readonly acceptEnabled: boolean;
  readonly abortOnClose: boolean;
  readonly raised: number;
}
export type FittedTradeSource =
  | { readonly kind: "fittedModule"; readonly itemID: number; readonly typeID: number }
  | { readonly kind: "fittedCharge"; readonly moduleID: number; readonly flagID: number; readonly typeID: number };
interface Dependencies {
  readonly ask: Ask;
  readonly act: Ask;
  characterID(): number | null;
  name(id: number): string;
  requestNames(ids: readonly number[]): void;
  primeItems(ids: readonly number[]): void;
  manifestMismatch(): string;
  wealth(): Promise<number>;
  quantity(min: number, max: number): Promise<number | null>;
  itemQuantity(max: number): Promise<number | null>;
  source(itemID: number, place: InventoryPlace): Promise<{ rows: readonly InventoryItemRow[]; sourceID: number }>;
  fittedType(source: FittedTradeSource): number;
  unloadFitted(containerID: number, source: FittedTradeSource, current: () => boolean): Promise<void>;
  activeShipID(): number | null;
  restrictions(types: readonly number[]): Promise<Readonly<Record<number, readonly number[] | null>>>;
  volumes(types: readonly number[]): Promise<Readonly<Record<number, number | null>>>;
  confirm(key: string): Promise<boolean>;
  say(key: string, values: JsonValue | null, fallback: string): void;
  report(error: unknown): void;
}
const pair = (value: unknown): readonly JsonValue[] | null => {
  const items = isListValue(value) ? value.items : Array.isArray(value) ? value as JsonValue[] : null;
  return items?.length === 2 ? items : null;
};
// These native offer slots contain KeyVal manifests or None, not numeric flags.
export const tradeAccepted = (value: JsonValue): boolean => value !== null && value !== false && value !== 0;

export function createDirectTrades(deps: Dependencies) {
  const windows = createSignal<readonly DirectTradeWindow[]>([]);
  let generation = 0, raised = 0;
  const opening = new Map<string, { task: Promise<void>; notices: [string, readonly unknown[]][] }>();
  const get = (id: number) => windows.get().find(w => w.state.containerID === id);
  function amend(id: number, update: (w: DirectTradeWindow) => DirectTradeWindow): void {
    windows.update(all => all.map(w => w.state.containerID === id ? update(w) : w));
  }
  function close(w: DirectTradeWindow): void {
    windows.update(all => all.filter(other => other.state.containerID !== w.state.containerID));
    // _OnClose also calls Abort after completion. OnCancel/Cancel clear the
    // native reference first, so those paths must not send a second Abort.
    if (w.abortOnClose) void abortDirectTrade(deps.act, w.moniker).catch(deps.report);
  }
  function resetOffers(id: number): void {
    amend(id, w => ({ ...w, acceptEnabled: true, state: { ...w.state, offers: [null, null] } }));
  }
  function itemChanged(row: JsonValue): void {
    const itemID = Number(readRowField(row, "itemID")), locationID = Number(readRowField(row, "locationID"));
    for (const w of windows.get()) {
      const present = w.state.items.some(item => Number(readRowField(item, "itemID")) === itemID);
      const here = locationID === w.state.containerID && w.state.traders.includes(Number(readRowField(row, "ownerID")))
        && Number(readRowField(row, "quantity")) !== 0;
      if (!present && !here) continue;
      const items = w.state.items.filter(item => Number(readRowField(item, "itemID")) !== itemID);
      if (here) items.push(row);
      amend(w.state.containerID, current => ({ ...current, state: { ...current.state, items } }));
      // PlayerTrade.AddItem219-223 resets only when a new entry is added.
      if (!present && here) resetOffers(w.state.containerID);
    }
  }
  function apply(method: string, args: readonly unknown[]): void {
    if (method === "OnItemChange") { itemChanged(args[0] as JsonValue); return; }
    if (method === "OnItemsChanged") {
      const rows = isListValue(args[0]) ? args[0].items : Array.isArray(args[0]) ? args[0] : [];
      for (const row of rows) itemChanged(row as JsonValue);
      return;
    }
    const id = Number(args[0]), w = get(id);
    if (!w) return;
    if (method === "OnTradeOffer") {
      const states = pair(args[1]); if (!states) return;
      const offers: readonly [JsonValue, JsonValue] = [states[0]!, states[1]!];
      const myIndex = w.state.traders.indexOf(deps.characterID() ?? 0);
      amend(id, current => ({ ...current, acceptEnabled: !tradeAccepted(offers[myIndex]!), state: { ...current.state, offers } }));
      if (offers.every(tradeAccepted)) close(get(id)!);
    } else if (method === "OnTradeMoneyOffer") {
      const values = pair(args[1]);
      if (values?.every(value => typeof value === "number")) {
        amend(id, current => ({ ...current, state: { ...current.state, money: [values[0] as number, values[1] as number] } }));
        resetOffers(id);
      }
    } else if (method === "OnTradeOfferReset") {
      resetOffers(id);
      if (args[1]) deps.say("CustomNotify", { type: "dict", entries: [["notify", deps.manifestMismatch()]] }, "The trade contents changed.");
      else deps.say("ItemExchangeFailed", null, "The item exchange failed.");
    } else if (method === "OnTradeCancel" || method === "OnTradeComplete") {
      const other = w.state.traders.find(id => id !== deps.characterID())!;
      deps.say(method === "OnTradeCancel" ? "TradeCancel" : "TradeComplete",
        { type: "dict", entries: [["name", deps.name(other)]] }, method === "OnTradeCancel" ? "Trade canceled." : "Trade completed.");
      close(method === "OnTradeCancel" ? { ...w, abortOnClose: false } : w);
    }
  }
  async function open(moniker: TradeMoniker): Promise<void> {
    const pending = opening.get(moniker.reference); if (pending) return pending.task;
    const captured = generation, notices: [string, readonly unknown[]][] = [];
    const task = (async () => {
      const service = await listDirectTrade(deps.ask, moniker);
      if (captured !== generation) return;
      const existing = get(service.containerID);
      if (existing) return;
      const window = await listDirectTrade(deps.ask, moniker);
      // Each native PlayerTrade inventory calls _GetItems. The simultaneous
      // requests share one GenericCall result in TQ In station trade220-226.
      const inventory = await listDirectTrade(deps.ask, moniker);
      if (captured !== generation) return;
      const characterID = deps.characterID();
      if (characterID === null || !window.traders.includes(characterID)) return;
      deps.requestNames(window.traders);
      windows.update(all => [...all, { moniker, state: { ...window, items: inventory.items, money: [0, 0], offers: [null, null] },
        acceptEnabled: true, abortOnClose: true, raised: ++raised }]);
      for (const [method, args] of notices) apply(method, args);
    })();
    opening.set(moniker.reference, { task, notices });
    try { await task; } finally { opening.delete(moniker.reference); }
  }
  async function start(characterID: number): Promise<void> {
    const captured = generation, moniker = await initiateDirectTrade(deps.act, characterID);
    if (captured !== generation) return;
    // _ShowTradeSessionWindow performs its own List before OnTradeInitiate.
    const state = await listDirectTrade(deps.ask, moniker);
    if (captured !== generation) return;
    if (get(state.containerID)) { amend(state.containerID, w => ({ ...w, raised: ++raised })); return; }
    await open(moniker);
  }
  function receive(method: string | null, args: readonly unknown[]): void {
    if (!method) return;
    if (method === "OnPrimingNeededForTradeItems") {
      const ids = isListValue(args[0]) ? args[0].items : Array.isArray(args[0]) ? args[0] : [];
      deps.primeItems(ids.map(Number));
    }
    for (const pending of opening.values()) pending.notices.push([method, args]);
    if (method === "OnTradeInitiate") {
      const moniker = tradeMonikerOf(args[1] as JsonValue);
      if (moniker) void open(moniker).catch(deps.report);
    } else apply(method, args);
  }
  async function cancel(id: number): Promise<void> {
    const w = get(id); if (!w || !w.abortOnClose || !await deps.confirm("ConfirmCancelTrade")) return;
    if (!get(id)?.abortOnClose) return;
    amend(id, current => ({ ...current, abortOnClose: false }));
    await abortDirectTrade(deps.act, w.moniker);
  }
  async function accept(id: number): Promise<void> {
    const w = get(id); if (!w?.acceptEnabled) return;
    amend(id, current => ({ ...current, acceptEnabled: false }));
    const foreignShip = w.state.items.some(row => Number(readRowField(row, "categoryID")) === 6
      && Number(readRowField(row, "ownerID")) !== deps.characterID());
    if (foreignShip && !await deps.confirm("TradeShipWarning")) { resetOffers(id); return; }
    if (!get(id)) return;
    try { await makeDirectTradeOffer(deps.act, w.moniker, w.state); }
    catch (error) { resetOffers(id); throw error; }
  }
  async function offerMoney(id: number): Promise<void> {
    const w = get(id); if (!w) return;
    const index = w.state.traders.indexOf(deps.characterID() ?? 0);
    const amount = await deps.quantity(w.state.money[index]!, await deps.wealth());
    if (amount !== null && get(id)) await offerDirectTradeMoney(deps.act, w.moniker, amount);
  }
  async function refreshPane(id: number, ownerID: number): Promise<boolean> {
    const w = get(id);
    if (!w?.abortOnClose || !w.state.traders.includes(ownerID)) return false;
    const captured = generation;
    const owns = (row: JsonValue) => Number(readRowField(row, "ownerID")) === ownerID;
    const before = w.state.items.filter(owns);
    const listed = await listDirectTrade(deps.ask, w.moniker);
    const current = get(id);
    if (captured !== generation || !current?.abortOnClose || current.moniker !== w.moniker ||
        listed.containerID !== id || !listed.traders.includes(ownerID)) return false;
    // An inventory notice for this side may be newer than the completed List.
    const live = current.state.items.filter(owns);
    if (live.length !== before.length || live.some((row, index) => row !== before[index])) return false;
    amend(id, trade => ({ ...trade, state: {
      ...trade.state, items: [...trade.state.items.filter(row => !owns(row)), ...listed.items.filter(owns)],
    } }));
    return true;
  }
  async function readBlueprint(containerID: number, itemID: number, typeID: number) {
    const captured = generation;
    const isOffered = () => {
      const trade = get(containerID);
      return generation === captured && trade?.abortOnClose && trade.state.items.some(row =>
        Number(readRowField(row, "itemID")) === itemID && Number(readRowField(row, "typeID")) === typeID);
    };
    if (!isOffered()) return null;
    const blueprint = decodeBlueprint(await deps.ask("blueprintManager", "GetBlueprintData", [itemID]));
    if (!isOffered() || blueprint?.itemID !== itemID || blueprint.typeID !== typeID ||
        blueprint.locationID !== containerID) return null;
    return blueprint;
  }
  async function offerItems(id: number, itemID: number, place: InventoryPlace, shift: boolean): Promise<void> {
    const w = get(id); if (!w?.abortOnClose) return;
    const { rows, sourceID } = await deps.source(itemID, place);
    // PlayerTrade.AddItems1672-1687: all local prechecks precede Add/MultiAdd.
    for (const row of rows) {
      if (row.itemID === deps.activeShipID()) { deps.say("PeopleAboardShip", null, "That ship is currently being piloted."); return; }
      if (row.typeID === 60) { deps.say("CannotTradeAssetSafety", null, "Asset safety wraps cannot be traded."); return; }
    }
    const types = [...new Set(rows.map(row => row.typeID))];
    if (!await checkTradable(types)) return;
    if (rows.length === 1) {
      const row = rows[0]!, quantity = shift && row.quantity > 1 ? await deps.itemQuantity(row.quantity) : row.quantity;
      if (!quantity || !get(id)?.abortOnClose) return;
      await addDirectTradeItem(deps.act, w.moniker, row.itemID, sourceID, quantity);
    } else if (rows.length > 1) {
      const volumes = await deps.volumes(types);
      const items = rows.map(row => {
        const volume = volumes[row.typeID];
        if (typeof volume !== "number") throw new Error("The installed client has no volume for this item type.");
        return { itemID: row.itemID, stacksize: row.quantity, unitVolume: volume };
      });
      if (get(id)?.abortOnClose) await addDirectTradeItems(deps.act, w.moniker, items, sourceID);
    }
  }
  async function checkTradable(types: readonly number[], fitted = false): Promise<boolean> {
    const lists = await deps.restrictions(types);
    // BaseInvContainer.OnDropData/_ValidateMove438-479 runs before PlayerTrade
    // AddItems: installed TYPE_LIST_CANNOT_BE_UNFITTED338, not a rig guess.
    const cannotUnfit = fitted ? types.filter(typeID => lists[typeID]?.includes(338)) : [];
    if (cannotUnfit.length) {
      deps.say("CannotUnfitItem", { type: "dict", entries: [["itemList", [29, { type: "list", items: intSetOf(cannotUnfit).keys() }]]] }, "These fitted items cannot be removed.");
      return false;
    }
    const restricted = types.filter(typeID => {
      const holding = lists[typeID];
      if (!holding) throw new Error("The installed client has no trade restriction data for this item type.");
      return holding.includes(36) || holding.includes(142);
    });
    if (restricted.length) {
      // The native local error takes a Python set. Keep its iteration order
      // when supplying the browser's type-list formatter with those entries.
      deps.say("CannotTradeNonTradable", { type: "dict", entries: [["itemList", [29, { type: "list", items: intSetOf(restricted).keys() }]]] }, "These items cannot be traded.");
      return false;
    }
    return true;
  }
  async function offerFitted(id: number, source: FittedTradeSource): Promise<void> {
    const captured = generation;
    const current = () => generation === captured && get(id)?.abortOnClose === true;
    if (!current() || !await checkTradable([deps.fittedType(source)], true) || !current()) return;
    // BaseInvContainer.AddItems505-517 precedes _AddItem and its Shift quantity
    // popup. A fitted charge therefore unloads the whole slot, even with Shift.
    await deps.unloadFitted(id, source, current);
  }
  function reset(abort = false): void {
    const old = windows.get(); generation++; windows.set([]); opening.clear();
    if (abort) for (const w of old) if (w.abortOnClose) void abortDirectTrade(deps.act, w.moniker).catch(deps.report);
  }
  return { windows: readonlySignal(windows), start, receive, cancel, accept, offerMoney, refreshPane, readBlueprint, offerItems, offerFitted, reset, report: deps.report };
}
export type DirectTrades = ReturnType<typeof createDirectTrades>;
