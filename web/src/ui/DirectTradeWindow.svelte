<script module lang="ts">
  let topZ = $state(40);
</script>
<script lang="ts">
  // pvptradewnd37-178: two 64px portraits, own/other inventory and money,
  // offer indicators, and the native Accept / Cancel / Offer Money actions.
  import { onMount, untrack } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import { loadTypeListsHolding } from "../app/api.ts";
  import { tradeAccepted, type DirectTradeWindow } from "../app/directTrades.ts";
  import { readRowField, type JsonValue } from "../bridge/wire.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { formatNumeric } from "../bridge/pyNumbers.ts";
  import { resolvedName } from "../store/names.ts";
  import { showOwnerInfo } from "./ownerInfo.ts";
  import { capturePointer, releasePointer } from "./pointerCapture.ts";
  import { portraitUrl, portraitDefaultPath } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { notify } from "./notices.ts";
  import DesktopWindow from "./DesktopWindow.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { DRAG_MIME, decodeDrag, carriesOurPayload } from "./dragDrop.ts";
  import { isNamedItem } from "./inventoryModel.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { showInfo } from "./showInfo.ts";
  import { buyMarketType, showMarketDetails } from "./marketDetails.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { addType } from "../bridge/marketQuickbar.ts";
  import { changeQuickbar } from "./marketQuickbar.ts";
  import { isComparable } from "../bridge/typeComparison.ts";
  import { ROLE_GML, ROLE_WORLDMOD, sessionHasRole } from "../bridge/gmWrites.ts";
  import { typeCompareTarget } from "./typeCompare.ts";
  let { session, trade, inFront, onOpenIndustry }: {
    session: Session; trade: DirectTradeWindow; inFront: boolean; onOpenIndustry: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = session.store.words, names = session.store.names, station = session.store.station, images = session.flow.imageServer;
  // svelte-ignore state_referenced_locally
  let geometry = $state({ x: (session.store.station.get().online?.characterID ?? 0) % 2 ? 40 : 540,
    y: 100, w: 460, h: 500, z: ++topZ, minimized: false });
  let busy = $state(false), split = $state(50);
  const myID = $derived($station.online?.characterID ?? 0), otherID = $derived(trade.state.traders.find(id => id !== myID)!);
  const indexes = $derived([trade.state.traders.indexOf(myID), trade.state.traders.indexOf(otherID)]);
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  const name = (id: number) => resolvedName($names.resolved, "owner", id, "Unknown pilot");
  const caption = $derived(plainText(formatTemplate($words.templates["UI/PVPTrade/TradeWith"] ?? "Trade with {[character]otherParty.name}", { otherParty: otherID }, { nameOf: (_kind, id) => name(id) })));
  let lastRaised = 0;
  $effect(() => { const raised = trade.raised; if (raised !== lastRaised) { lastRaised = raised; untrack(() => geometry = { ...geometry, minimized: false, z: ++topZ }); } });
  $effect(() => { session.flow.requestNames(trade.state.items.map(row => ({ kind: "type" as const, id: Number(readRowField(row, "typeID")) }))); });
  function itemName(row: JsonValue): string {
    const item = Number(readRowField(row, "itemID")), type = Number(readRowField(row, "typeID"));
    const typeName = resolvedName($names.resolved, "type", type, "Unknown item");
    const named = isNamedItem({ singleton: readRowField(row, "singleton") === true || Number(readRowField(row, "singleton")) === 1 || Number(readRowField(row, "quantity")) < 0,
      categoryID: Number(readRowField(row, "categoryID")), groupID: Number(readRowField(row, "groupID")) });
    const own = named ? resolvedName($names.resolved, "evelocation", item, typeName) : typeName;
    return own === typeName ? typeName : plainText(formatTemplate($words.templates["UI/PVPTrade/TypeNameAndItemName"] ?? "{typeName} ({itemName})", { typeName, itemName: own }, { nameOf: () => "" }));
  }
  function quantity(row: JsonValue): number { const quantity = Number(readRowField(row, "quantity")); return quantity < 0 ? 1 : quantity; }
  const itemMenu = new ContextMenu();
  let menuRequest = 0;
  interface TradeSelection {
    readonly ids: ReadonlySet<number>;
    readonly anchor: number | null;
  }
  let selections = $state.raw<Readonly<Record<number, TradeSelection>>>({});
  const itemIDOf = (row: JsonValue) => Number(readRowField(row, "itemID"));
  const typeIDOf = (row: JsonValue) => Number(readRowField(row, "typeID"));
  const sideRows = (owner: number) => trade.state.items.filter(row => Number(readRowField(row, "ownerID")) === owner);
  function setSelection(owner: number, ids: ReadonlySet<number>, anchor: number | null): void {
    menuRequest++;
    itemMenu.close();
    selections = { ...selections, [owner]: { ids, anchor } };
  }
  function selectRow(event: MouseEvent | KeyboardEvent, owner: number, row: JsonValue): void {
    const id = itemIDOf(row);
    const previous = selections[owner];
    const ids = sideRows(owner).map(itemIDOf);
    const toggle = event.ctrlKey || event.metaKey;
    const anchor = ids.indexOf(previous?.anchor ?? -1);
    const index = ids.indexOf(id);
    if (event.shiftKey && anchor !== -1 && index !== -1 && anchor !== index) {
      const range = ids.slice(Math.min(anchor, index), Math.max(anchor, index) + 1);
      setSelection(owner, new Set(toggle ? [...previous.ids, ...range] : range), previous.anchor);
      return;
    }
    if (toggle && !event.shiftKey) {
      const next = new Set(previous?.ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelection(owner, next, id);
      return;
    }
    setSelection(owner, new Set([id]), id);
  }
  function selectInPane(owner: number, invert = false): void {
    const ids = sideRows(owner).map(itemIDOf);
    const selected = selections[owner];
    setSelection(owner, new Set(invert ? ids.filter(id => !selected?.ids.has(id)) : ids), selected?.anchor ?? null);
  }
  const itemWords = {
    market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
    buy: ["UI/Inventory/ItemActions/BuyThisType", "Buy This Type"],
    buyAll: ["UI/Market/MarketQuote/BuyAll", "Buy All"],
    contracts: ["UI/Inventory/ItemActions/FindInContracts", "Find in Contracts"],
    assets: ["UI/Inventory/ItemActions/FindPersonalAssets", "Find in Personal Assets"],
    quickbar: ["UI/Inventory/ItemActions/AddTypeToMarketQuickbar", "Add to Market Quickbar"],
    info: ["UI/Commands/ShowInfo", "Show Info"],
    compare: ["UI/Compare/CompareButton", "Compare"],
    useBlueprint: ["UI/Industry/UseBlueprint", "Use Blueprint"],
    selectAll: ["UI/Common/SelectAll", "Select All"],
    invert: ["UI/Inventory/InvertSelection", "Invert Selection"],
    refresh: ["UI/Commands/Refresh", "Refresh"],
  } as const;
  function itemEntry(key: keyof typeof itemWords, run: () => void, count?: number): ContextEntry {
    const [path, fallback] = itemWords[key];
    const label = word(path, fallback);
    return { label: count === undefined ? label : `${label} (${count})`, path, run, info: key === "info" };
  }
  function paneEntries(owner: number): (ContextEntry | null)[] {
    const entries: (ContextEntry | null)[] = [];
    const role = $station.online?.role;
    if (sessionHasRole(role, ROLE_GML) || sessionHasRole(role, ROLE_WORLDMOD)) {
      entries.push(itemEntry("refresh", () => void run(async () => {
        if (await session.flow.directTrades.refreshPane(trade.state.containerID, owner)) {
          setSelection(owner, new Set(), null);
        }
      })), null);
    }
    entries.push(itemEntry("selectAll", () => selectInPane(owner)), itemEntry("invert", () => selectInPane(owner, true)));
    return entries;
  }
  function openPaneMenu(event: MouseEvent, owner: number): void {
    event.preventDefault();
    if (inFront && trade.abortOnClose) {
      menuRequest++;
      itemMenu.open(event.clientX, event.clientY, paneEntries(owner));
    }
  }
  async function openItemMenu(event: MouseEvent | KeyboardEvent, row: JsonValue, owner: number): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!inFront || !trade.abortOnClose) return;
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const x = "clientX" in event && event.clientX ? event.clientX : rect.left;
    const y = "clientY" in event && event.clientY ? event.clientY : rect.bottom;
    const typeID = typeIDOf(row);
    const itemID = itemIDOf(row);
    if (!Number.isSafeInteger(typeID) || typeID <= 0 || !Number.isSafeInteger(itemID) || itemID <= 0) return;
    if (!selections[owner]?.ids.has(itemID)) {
      if ("clientX" in event) selectRow(event, owner, row);
      else setSelection(owner, new Set([itemID]), itemID);
    }
    const selected = selections[owner]?.ids;
    const subjects = sideRows(owner).filter(item => selected?.has(itemIDOf(item)))
      .map(item => ({ typeID: typeIDOf(item), itemID: itemIDOf(item) }));
    if (subjects.length === 0) return;
    const typeIDs = [...new Set(subjects.map(subject => subject.typeID))];
    const request = ++menuRequest;
    itemMenu.close();
    const flow = session.flow;
    // inventoryrestrictions identifies non-tradable, soulbound and non-contractable types.
    const [types, restrictions, comparison] = await Promise.all([
      flow.typeFacts(typeIDs).catch(() => null),
      Promise.all(Array.from({ length: Math.ceil(typeIDs.length / 32) }, (_, batch) =>
        loadTypeListsHolding(typeIDs.slice(batch * 32, batch * 32 + 32), [36, 142, 337], flow.requestOptions())
      )).then(lists => Object.assign({}, ...lists) as Readonly<Record<number, readonly number[] | null>>).catch(() => null),
      flow.comparisonTypes(typeIDs).catch(() => null),
    ]);
    if (request !== menuRequest || !inFront || !target.isConnected || !trade.abortOnClose) return;
    const availableIDs = new Set(sideRows(owner).map(itemIDOf));
    if (subjects.some(subject => !availableIDs.has(subject.itemID))) return;
    const marketable = typeIDs.filter(id => {
      const held = restrictions?.[id];
      return (types?.get(id)?.marketGroupID ?? 0) > 0 && held && !held.includes(36) && !held.includes(142);
    });
    const infoEntries: ContextEntry[] = [], marketEntries: ContextEntry[] = [], otherEntries: ContextEntry[] = [];
    if (subjects.length === 1) {
      infoEntries.push(itemEntry("info", () => showInfo({ kind: "type", typeID, itemID })));
      if (marketable.length) {
        marketEntries.push(itemEntry("market", () => showMarketDetails(typeID)), itemEntry("buy", () => buyMarketType(typeID)));
      }
      const type = types?.get(typeID);
      const held = restrictions?.[typeID];
      const contractable = held && !held.includes(337) && !held.includes(142);
      if (type?.published) {
        if (contractable) marketEntries.push(itemEntry("contracts", () => findInContracts(typeID)));
        marketEntries.push(itemEntry("assets", () => findInPersonalAssets(resolvedName($names.resolved, "type", typeID, itemName(row)))));
      }
      if (marketable.length && contractable && type?.groupID !== 29) {
        marketEntries.push(itemEntry("quickbar", () => { changeQuickbar(bar => addType(bar, typeID)); }));
      }
      const category = type?.categoryID;
      if (category === 9 || category === 34) {
        otherEntries.push(itemEntry("useBlueprint", () => {
          flow.requestTradeBlueprintPreview(trade.state.containerID, itemID, typeID);
          onOpenIndustry();
        }));
      }
    } else if (marketable.length) {
      marketEntries.push(itemEntry("market", () => showMarketDetails(marketable[0])),
        itemEntry("buyAll", () => void run(() => flow.openMultiBuy(new Map(typeIDs.map(id => [id, 1])))), subjects.length));
    }
    if (typeIDs.some(id => isComparable(comparison?.types.get(id) ?? null))) {
      otherEntries.push(itemEntry("compare", () => typeCompareTarget.ask(subjects), subjects.length > 1 ? subjects.length : undefined));
    }
    itemMenu.open(x, y, [infoEntries, marketEntries, otherEntries, paneEntries(owner)]
      .filter(group => group.length).flatMap((group, i) => i ? [null, ...group] : group));
  }
  $effect(() => {
    if (!inFront || !trade.abortOnClose || geometry.minimized) {
      menuRequest++;
      itemMenu.close();
    }
  });
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return; busy = true;
    try { await action(); }
    catch (cause) { session.flow.directTrades.report(cause); }
    finally { busy = false; }
  }
  function info(id: number): void { void showOwnerInfo(session.flow, id).catch(cause => notify({ kind: "danger", title: "Show Info", detail: String(cause) })); }
  function over(event: DragEvent): void {
    if (!trade.abortOnClose || !carriesOurPayload(event.dataTransfer?.types as string[] | undefined)) return;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }
  function drop(event: DragEvent): void {
    event.preventDefault();
    const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME));
    if (!payload) return;
    // pvptradewnd60: a drop onto the other side uses the offering pilot's
    // controller too; it never changes the ownership of the offered row.
    void run(() => payload.kind === "inventoryItem"
      ? session.flow.directTrades.offerItems(trade.state.containerID, payload.itemID, payload.from, event.shiftKey)
      : session.flow.directTrades.offerFitted(trade.state.containerID, payload));
  }
  function resizeSplit(event: PointerEvent): void {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement, parent = handle.parentElement!;
    capturePointer(handle, event.pointerId);
    const move = (ev: PointerEvent) => { const rect = parent.getBoundingClientRect(); split = Math.max(35, Math.min(65, (ev.clientY - rect.top) / rect.height * 100)); };
    const end = () => { releasePointer(handle, event.pointerId); handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", end);
  }
  onMount(() => {
    session.flow.loadImageServer();
    session.flow.requestWords(Object.values(itemWords).map(([path]) => path));
    return () => { menuRequest++; itemMenu.close(); };
  });
</script>
<DesktopWindow win={{ ...geometry, id: trade.state.containerID }} title={caption} focused={geometry.z === topZ}
  onFocus={() => geometry = { ...geometry, z: ++topZ }} onClose={() => void run(() => session.flow.directTrades.cancel(trade.state.containerID))}
  onToggleMinimize={() => geometry = { ...geometry, minimized: !geometry.minimized }}
  onMove={(x, y) => geometry = { ...geometry, x, y }} onResize={(w, h) => geometry = { ...geometry, w: Math.max(300, w), h: Math.max(410, h) }}>
  <div class="trade-content" data-trade-container={trade.state.containerID}>
    {#if !inFront}<p class="for-pilot">For {name(myID)}</p>{/if}
    <div class="sides">
      {#each [myID, otherID] as ownerID, side}
        {@const index = indexes[side]!}
        {@const amount = trade.state.money[index]!}
        <section aria-label={name(ownerID)} style:flex-basis={side === 0 ? `${split}%` : undefined} ondragover={over} ondrop={drop}>
          <div class="owner">
            <button class="portrait" type="button" title={name(ownerID)} onclick={() => info(ownerID)}><OwnerPicture name={name(ownerID)} urls={[portraitUrl($images, ownerID, 64), clientTexture(portraitDefaultPath(64))].filter((url): url is string => url !== null)} size={64} /></button>
            <div class="offer"><button type="button" class="owner-name" onclick={() => info(ownerID)}>{name(ownerID)}</button>
              <span class="accepted" aria-label={plainText(formatTemplate($words.templates["UI/PVPTrade/AcceptedHint"] ?? "Accepted by {name}", { name: name(ownerID) }, { nameOf: () => "" }))} style:visibility={tradeAccepted(trade.state.offers[index]!) ? "visible" : "hidden"}>✓</span>
              <span class:paying={side === 0 && amount > 0} class:receiving={side === 1 && amount > 0}>{plainText(formatTemplate($words.templates[side === 0 ? "UI/PVPTrade/MyCharacterOffers" : "UI/PVPTrade/OtherCharacterOffers"] ?? "Offers {formattedAmount}", { formattedAmount: `${formatNumeric(amount, { useGrouping: true, decimalPlaces: 0 })} ${word("UI/Common/ISK", "ISK")}` }, { nameOf: () => "" }))}</span>
            </div>
            {#if side === 0}<button class="money" type="button" disabled={busy || !trade.abortOnClose} onclick={() => void run(() => session.flow.directTrades.offerMoney(trade.state.containerID))}>{word("UI/PVPTrade/OfferMoney", "Offer Money")}</button>{/if}
          </div>
          <div class="inventory" data-trade-owner={ownerID} role="group" aria-label={name(ownerID)}
            oncontextmenu={event => openPaneMenu(event, ownerID)}><table><thead><tr><th>{word("UI/Common/Name", "Name")}</th><th>{word("UI/Common/Quantity", "Quantity")}</th></tr></thead><tbody>
            {#each sideRows(ownerID) as row (itemIDOf(row))}
              <tr data-trade-item={itemIDOf(row)}
                oncontextmenu={event => void openItemMenu(event, row, ownerID)}>
                <td><button class="item-name" type="button" aria-haspopup="menu"
                  aria-pressed={selections[ownerID]?.ids.has(itemIDOf(row)) ?? false}
                  onclick={event => selectRow(event, ownerID, row)}
                  onkeydown={event => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
                      event.preventDefault();
                      event.stopPropagation();
                      selectInPane(ownerID);
                    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                      void openItemMenu(event, row, ownerID);
                    }
                  }}>{itemName(row)}</button></td>
                <td>{quantity(row).toLocaleString()}</td>
              </tr>
            {/each}
          </tbody></table></div>
        </section>
        {#if side === 0}<div class="splitter" role="separator" aria-label="Trade panel divider" aria-orientation="horizontal" onpointerdown={resizeSplit}></div>{/if}
      {/each}
    </div>
    <div class="answers"><button type="button" disabled={busy || !trade.acceptEnabled || !trade.abortOnClose} onclick={() => void run(() => session.flow.directTrades.accept(trade.state.containerID))}>{word("UI/PVPTrade/Accept", "Accept")}</button><button type="button" disabled={busy || !trade.abortOnClose} onclick={() => void run(() => session.flow.directTrades.cancel(trade.state.containerID))}>{word("UI/Common/Buttons/Cancel", "Cancel")}</button></div>
  </div>
</DesktopWindow>
{#if geometry.minimized}<button class="restore-trade" type="button" onclick={() => geometry = { ...geometry, minimized: false, z: ++topZ }}>{caption}</button>{/if}
<style>
  .trade-content { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 8px; }
  .for-pilot { margin: 0; color: var(--color-accent); }
  .sides { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  section { display: flex; flex-direction: column; min-height: 0; } section:last-child { flex: 1; }
  .owner { display: flex; gap: 8px; height: 64px; flex-shrink: 0; margin-bottom: 8px; }
  .portrait { padding: 0; border: 0; background: transparent; } .offer { display: flex; flex-direction: column; align-items: flex-start; flex: 1; min-width: 0; }
  .owner-name { border: 0; padding: 0; min-height: 0; height: 22px; flex-shrink: 0; line-height: 22px; font-size: 1rem; background: transparent; } .accepted { color: #6ed9a1; height: 22px; flex-shrink: 0; line-height: 22px; }
  .offer > span:last-child { white-space: nowrap; font-size: .8rem; line-height: 20px; } .paying { color: #ef7474; } .receiving { color: #6ed9a1; }
  .money { align-self: flex-start; font-size: .75rem; } .inventory { overflow: auto; flex: 1; min-height: 0; border: 1px solid var(--color-border); }
  table { width: 100%; font-size: .8rem; border-collapse: collapse; } th, td { text-align: left; padding: 4px 6px; } th:last-child, td:last-child { text-align: right; }
  .item-name { width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: default; }
  tr:has(.item-name[aria-pressed="true"]) { background: rgba(105, 179, 220, 0.22); }
  thead { position: sticky; top: 0; background: var(--color-bg); }
  .splitter { height: 8px; flex-shrink: 0; cursor: row-resize; touch-action: none; border-top: 1px solid var(--color-border); margin-top: 4px; }
  .answers { display: flex; gap: 8px; padding-top: 8px; } .answers button { flex: 1; }
  .restore-trade { position: fixed; left: 1rem; bottom: 3rem; pointer-events: auto; }
</style>
