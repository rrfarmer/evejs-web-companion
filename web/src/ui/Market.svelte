<script lang="ts">
  // Market page (goal R16): an item's order book by station name, the player's
  // own orders, their trades, what they have locked in escrow, and their ISK.
  //
  // A pure reader of the store's market slice. Every call lives on the BFF and
  // in app/flow.ts; every identifier is translated to a name in
  // bridge/market.ts or resolved through the shared name cache before it
  // reaches this file. Nothing here shows a typeID, a stationID, a systemID or
  // an orderID (R7d) — an order is identified by what it is for, where it is
  // and at what price. Prices are decimal strings formatted by `formatIsk`,
  // never JS numbers, because ISK exceeds 2^53 in ordinary play.
  //
  // THE SORTING AND FILTERING HERE IS THE POINT. Retail implements it in a
  // client-local service called `marketQuote`; there is no server call for it.
  // So it is implemented client-side here too, which is also why re-sorting the
  // book costs no round-trip.
  import { getContext, onMount, tick } from "svelte";
  import { portal } from "./portal.ts";
  import { marketDetailsTarget } from "./marketDetails.ts";
  import {
    DURATION_CHOICES,
    FILL_STATE_LABELS,
    bestPrices,
    checkPrice,
    checkQuantity,
    distanceLabel,
    brokerFeeBasisWords,
    brokerFeeWords,
    estimateBrokerFee,
    historyDayText,
    filterByJumps,
    formatIsk,
    iskDelta,
    rangeLabel,
    sortOrderBook,
  } from "../bridge/market.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { MarketTypeMatch } from "../app/api.ts";
  import type { MarketOrderRow, MarketOwnOrderRow, MarketSide } from "../store/types.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  // R27 — the shared item icon: one cached picture per thing, falling back
  // to a name-derived tile whenever the icon cache has no entry (or no cache).
  import TypeIcon from "./TypeIcon.svelte";
  import MarketPriceHistory from "./MarketPriceHistory.svelte";
  import NamePopup from "./NamePopup.svelte";
  import { marketQuickbar, changeQuickbar } from "./marketQuickbar.ts";
  import {
    addFolder,
    addType,
    childrenOf,
    deleteFolder,
    isFolder,
    isType,
    removeType,
    renameFolder,
    setExtraText,
    typesUnderFolder,
    type QuickbarEntry,
  } from "../bridge/marketQuickbar.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { COMPARE_CATEGORIES } from "../bridge/dogmaAttributeGroups.ts";
  import { assetSearchTextForType } from "../bridge/assetSearch.ts";
  import type { JsonValue } from "../bridge/wire.ts";
  import type { TypeMetaFacts } from "../app/api.ts";
  import { showInfo } from "./showInfo.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { compareType } from "./typeCompare.ts";
  import PlaceRouteMenu from "./PlaceRouteMenu.svelte";
  import type { MarketGroupNode } from "../app/api.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const market = store.market;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const quickbar = marketQuickbar;

  // --- The Quickbar (the market window's left tabs, marketbase.py 378 to 381: Browse and Quickbar) ---------------
  //
  // The market's quickbar (bridge/marketQuickbar.ts, kept by ui/marketQuickbar.ts): its folders, each a group that
  // opens (QuickbarGroup), and its types (QuickbarItem), each list sorted by name (LoadQuickBarItems and
  // GetGroupSubContent, 1641 to 1817: folders first, then types). A type is written with its extra text where it has
  // one (QuickbarTypeNameWithExtraText); one the market does not sell is faded, with the client's hint, and does
  // nothing when clicked (QuickbarItem.Load and OnClick). A type clicked shows its market (the scroll's selection).
  // Above it, New Folder and Reset (ResetQuickbar's question); the import and export menus are not the page's.
  //
  // A folder's menu (QuickbarGroup.GetMenu: ListGroup.GetMenu, 284 to 311, then GroupMenu and Buy All): Expand or
  // Collapse, Change Label, Delete Folder (ConfirmDeleteFolder), New Folder (maxdepth 99: always), and Buy All where it
  // or its folders hold any type (GetTypesUnderFolder: the multibuy with each type and its quantity). The market
  // ticker's entries are not the page's. A type's menu (GetQuickItemMenu, 577 to 588, then the type's menu): Add or
  // Edit Additional Text, Remove; then Show Info, View Market Details, Find in Contracts, Find Personal Assets and
  // Compare as the type's menu offers them (menusvc.GetMenuFromItemIDTypeID). A browsed type's menu (OnTypeMenu, 1489 to
  // 1496): Add to Market Quickbar and Show Info.
  const QUICKBAR_WORDS: Readonly<Record<string, string>> = {
    "UI/Market/Browse": "Browse",
    // (MarketBase's right-side tab bar and the window's WalletBalance, asked with these)
    "UI/Common/Details": "Details",
    // MarketData's lists (marketbase.MarketData, quote.py's cells)
    "UI/Market/Marketbase/Sellers": "Sellers",
    "UI/Market/Marketbase/Buyers": "Buyers",
    "UI/Market/Marketbase/Jumps": "Jumps",
    "UI/Common/Quantity": "Quantity",
    "UI/Market/Marketbase/Price": "Price",
    "UI/Common/Location": "Location",
    "UI/Market/Marketbase/ExpiresIn": "Expires in",
    "UI/Common/Range": "Range",
    "UI/Market/MarketQuote/HeaderMinVolumn": "Min Volume",
    "UI/Common/LocationTypes/Station": "Station",
    "UI/Common/LocationTypes/System": "System",
    "UI/Common/LocationTypes/SolarSystem": "Solar System",
    "UI/Common/LocationTypes/Region": "Region",
    "UI/Common/LocationTypes/Unreachable": "Unreachable",
    "UI/Market/MarketQuote/NumberOfJumps": "{[numeric]num} Jumps",
    "UI/Market/MarketQuote/Expired": "Expired",
    "UI/Market/Marketbase/CommandPlaceBuyOrder": "Place Buy Order",
    // the Price History tab (pricehistorychart.py, marketGraph.py)
    "UI/PriceHistory/ShowGraph": "Show Graph",
    "UI/PriceHistory/ShowTable": "Show Table",
    "/Carbon/UI/Common/Time": "Time",
    "UI/Common/DateWords/Month": "Month",
    "UI/Common/DateWords/Months": "Months",
    "UI/Common/DateWords/Year": "Year",
    "UI/Common/DateWords/Days": "Days",
    "UI/Common/Date": "Date",
    "UI/Market/PriceHistory": "Orders",
    "UI/Market/PriceHistory/Quantity": "Quantity",
    "UI/Market/PriceHistory/LowestPrice": "Lowest",
    "UI/Market/PriceHistory/HighestPrice": "Highest",
    "UI/Market/PriceHistory/AveragePrice": "Average",
    "UI/PriceHistory/MedianDayPrice": "Median Day Price",
    "UI/PriceHistory/MinMax": "Min/Max",
    "UI/PriceHistory/MovingAvg": "Moving Avg. ({numDays})",
    "/Carbon/UI/Common/WrittenDateTimeQuantityShort/Day": "{value}d",
    "UI/PriceHistory/DonchianChannel": "Donchian Channel",
    "UI/PriceHistory/Volume": "Volume",
    "UI/Market/Marketbase/NoTypeSelected": "No type selected",
    "UI/Market/MarketData": "Market Data",
    "UI/Market/Marketbase/PriceHistory": "Price History",
    "Tooltips/Market/MarketDetailsData": "The orders for the selected item",
    "Tooltips/Market/MarketDetailsHistory": "The selected item's price history",
    "Tooltips/StationServices/MarketOrders": "Market Orders",
    "Tooltips/Market/MarketDetailsTab": "The selected item's orders",
    "UI/Commands/OpenWallet": "Open the wallet",
    "UI/Market/WalletBalanceUnavailable": "Unavailable",
    "UI/Market/QuickBar": "Quickbar",
    "Tooltips/Market/MarketQuickbarNewFolder": "Make a folder",
    "Tooltips/Market/MarketQuickbarReset": "Empty it",
    "UI/Market/Marketbase/FolderName": "Folder",
    "UI/Market/Marketbase/TypeFolderName": "Its name",
    "UI/Market/Marketbase/QuickbarTypeNameWithExtraText": "{typeName} [{extraText}]",
    "UI/Market/Marketbase/NotAvailableOnMarket": "Not sold on the market",
    "UI/Market/Marketbase/EditAdditionalText": "Change its note",
    "UI/Market/Marketbase/AddAdditionalText": "Give it a note",
    "UI/Market/Marketbase/TypeInAdditionalText": "Its note",
    "UI/Market/Remove": "Take out",
    "UI/Market/NewFolder": "Make a folder",
    "/Carbon/UI/Controls/ScrollEntries/ChangeLabel": "Rename",
    "/Carbon/UI/Controls/ScrollEntries/DeleteFolder": "Delete",
    "/Carbon/UI/Controls/ScrollEntries/TypeInNewName": "New name",
    "/Carbon/UI/Controls/ScrollEntries/TypeInNewFolderName": "The folder's new name",
    "UI/Market/MarketQuote/BuyAll": "Buy them all",
    "UI/Common/PleaseTypeSomething": "Type something first.",
    "UI/Common/Expand": "Open it",
    "UI/Common/Collapse": "Close it",
    "UI/Common/NothingFound": "Nothing here",
    "UI/Common/Buttons/OK": "OK",
    "UI/Common/Buttons/Cancel": "Cancel",
    "UI/Common/Buttons/Yes": "Yes",
    "UI/Common/Buttons/No": "No",
    "UI/Inventory/ItemActions/AddTypeToMarketQuickbar": "Put in the quickbar",
    "UI/Commands/ShowInfo": "About it",
    "UI/Inventory/ItemActions/ViewTypesMarketDetails": "Its market",
    "UI/Inventory/ItemActions/FindInContracts": "Contracts of it",
    "UI/Inventory/ItemActions/FindPersonalAssets": "Where you have it",
    "UI/Inventory/AssetSearch/KeywordTypeExact": "typeExact",
    "UI/Compare/CompareButton": "Side by side",
    "dialog:ResetQuickbar/title": "Empty the quickbar?",
    "dialog:ResetQuickbar/body": "Everything in the quickbar goes.",
    "dialog:ConfirmDeleteFolder/title": "Delete the folder?",
    "dialog:ConfirmDeleteFolder/body": "The folder and all in it go.",
    "dialog:cannotTradeOnMarket/body": "{[item]typeID.name} is not traded on the market.",
  };
  function qbWord(label: string, args: Readonly<Record<string, JsonValue>> = {}): string {
    const template = $words.templates[label];
    const text = typeof template === "string" && template !== "" ? template : QUICKBAR_WORDS[label] ?? "";
    return plainText(formatTemplate(text, args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  }

  let leftTab = $state<"browse" | "quickbar">("browse");
  let qbOpen = $state<Record<number, boolean>>({});
  let qbFacts = $state.raw<ReadonlyMap<number, TypeMetaFacts | null>>(new Map());
  type QbMenuTarget =
    | { readonly kind: "folder"; readonly entry: QuickbarEntry }
    | { readonly kind: "type"; readonly entry: QuickbarEntry }
    | { readonly kind: "browse"; readonly typeID: number };
  let qbMenu = $state<(QbMenuTarget & { readonly x: number; readonly y: number }) | null>(null);
  // Shut by its flag, the menu last shown kept: its values are read as it is taken down, and must never be null then.
  let qbMenuUp = $state(false);
  /** The name popup up (NamePopup), and what its OK does. */
  let naming = $state<{ readonly caption: string; readonly label: string; readonly value: string; readonly maxLength: number | null; readonly refuses: boolean; readonly ok: (text: string) => void } | null>(null);
  let namingUp = $state(false);
  /** The client's question up (its dialog), and what its answer does. */
  let question = $state<{ readonly title: string; readonly body: string; readonly answer: (yes: boolean) => void } | null>(null);
  let questionUp = $state(false);
  let qbNotice = $state("");

  // The quickbar's types: their facts (market group, published, category: the client's types records) and names.
  $effect(() => {
    const typeIDs = $quickbar.entries.flatMap((entry) => (isType(entry) ? [entry.label] : []));
    if (typeIDs.length === 0) return;
    flow.requestNames(typeIDs.map((id) => ({ kind: "type" as const, id })));
    void flow.typeFacts(typeIDs).then((facts) => {
      if (facts !== null) qbFacts = facts;
    });
  });

  onMount(() => {
    flow.requestWords(Object.keys(QUICKBAR_WORDS));
  });

  $effect(() => {
    if (!qbMenuUp) return;
    const close = (event: Event): void => {
      if (!(event.target instanceof Element && event.target.closest(".hull-menu"))) qbMenuUp = false;
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") qbMenuUp = false;
    };
    const timer = setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", key);
    });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
    };
  });

  function openQbMenu(menu: QbMenuTarget, event: MouseEvent): void {
    event.preventDefault();
    qbMenu = { ...menu, x: event.clientX, y: event.clientY };
    qbMenuUp = true;
  }

  /** A folder's or the top's entries (GetItems), folders then types, each sorted by name. */
  function qbChildren(parent: number): { readonly folders: QuickbarEntry[]; readonly types: QuickbarEntry[] } {
    const entries = childrenOf($quickbar, parent);
    return {
      folders: entries.filter(isFolder).sort((left, right) => String(left.label).localeCompare(String(right.label))),
      types: entries.filter(isType).sort((left, right) => typeName(Number(left.label)).localeCompare(typeName(Number(right.label)))),
    };
  }

  function qbTypeLabel(entry: QuickbarEntry): string {
    const name = typeName(Number(entry.label));
    const extraText = entry.extraText ?? "";
    return extraText !== "" ? qbWord("UI/Market/Marketbase/QuickbarTypeNameWithExtraText", { typeName: name, extraText: String(extraText) }) : name;
  }

  /** QuickbarItem.Load: a type the market does not sell (no market group); unknown while its facts are not had. */
  const qbUnsold = (typeID: number): boolean => qbFacts.has(typeID) && (qbFacts.get(typeID)?.marketGroupID ?? null) === null;

  function qbClick(entry: QuickbarEntry): void {
    const typeID = Number(entry.label);
    if (qbUnsold(typeID)) return;
    chooseItem({ typeID, name: typeName(typeID), groupName: "" });
  }

  function qbToggled(id: number, event: Event): void {
    const open = (event.currentTarget as HTMLDetailsElement).open;
    if ((qbOpen[id] === true) !== open) qbOpen[id] = open;
  }

  /** The window's NewFolder and AddNewQuickbarFolder: the name popup, then the folder. */
  function newFolder(parent: number): void {
    qbMenuUp = false;
    namingUp = true;
    naming = {
      caption: qbWord("UI/Market/Marketbase/FolderName"),
      label: qbWord("UI/Market/Marketbase/TypeFolderName"),
      value: "",
      maxLength: 20,
      refuses: true,
      ok: (text) => {
        namingUp = false;
        changeQuickbar((quickbar) => addFolder(quickbar, text, parent).quickbar);
      },
    };
  }

  /** ListGroup.ChangeLabel: the list group's popup (no length), then RenameFolder. */
  function changeLabel(entry: QuickbarEntry): void {
    qbMenuUp = false;
    namingUp = true;
    naming = {
      caption: qbWord("/Carbon/UI/Controls/ScrollEntries/TypeInNewName"),
      label: qbWord("/Carbon/UI/Controls/ScrollEntries/TypeInNewFolderName"),
      value: "",
      maxLength: null,
      refuses: true,
      ok: (text) => {
        namingUp = false;
        changeQuickbar((quickbar) => renameFolder(quickbar, entry.id, text));
      },
    };
  }

  /** ListGroup.DeleteFolder: ConfirmDeleteFolder, then GroupDeleteFolder. */
  function deleteQbFolder(entry: QuickbarEntry): void {
    qbMenuUp = false;
    questionUp = true;
    question = {
      title: qbWord("dialog:ConfirmDeleteFolder/title"),
      body: qbWord("dialog:ConfirmDeleteFolder/body"),
      answer: (yes) => {
        questionUp = false;
        if (yes) changeQuickbar((quickbar) => deleteFolder(quickbar, entry.id));
      },
    };
  }

  /** ResetQuickbar: its question, then all of it gone and the numbering from nought. */
  function resetQuickbar(): void {
    questionUp = true;
    question = {
      title: qbWord("dialog:ResetQuickbar/title"),
      body: qbWord("dialog:ResetQuickbar/body"),
      answer: (yes) => {
        questionUp = false;
        if (yes) changeQuickbar(() => ({ entries: [], lastID: 0 }));
      },
    };
  }

  /** EditExtraText: the popup (the type's name its caption, at most 25, nothing refused), then the text kept. */
  function editExtraText(entry: QuickbarEntry): void {
    qbMenuUp = false;
    namingUp = true;
    naming = {
      caption: typeName(Number(entry.label)),
      label: qbWord("UI/Market/Marketbase/TypeInAdditionalText"),
      value: String(entry.extraText ?? ""),
      maxLength: 25,
      refuses: false,
      ok: (text) => {
        namingUp = false;
        changeQuickbar((quickbar) => setExtraText(quickbar, entry.id, text));
      },
    };
  }

  /**
   * The window's AddTypeToQuickBar (1512 to 1518: marketQuote.AddToQuickBar at the top, no extra text): refused, with
   * the client's cannotTradeOnMarket, for a type the market does not sell.
   */
  async function addToQuickbar(typeID: number): Promise<void> {
    qbMenuUp = false;
    const facts = (await flow.typeFacts([typeID]))?.get(typeID) ?? null;
    if (facts !== null && facts.marketGroupID === null) {
      qbNotice = qbWord("dialog:cannotTradeOnMarket/body", { typeID });
      return;
    }
    qbNotice = "";
    changeQuickbar((quickbar) => addType(quickbar, typeID, 0, ""));
  }

  /** The type's menu as menusvc gives it (the page's part of it): what is offered of a type, by its facts. */
  function typeMenuOffers(typeID: number): { readonly market: boolean; readonly published: boolean; readonly compare: boolean } {
    const facts = qbFacts.get(typeID) ?? null;
    return {
      market: facts !== null && facts.marketGroupID !== null,
      published: facts !== null && facts.published,
      compare: facts !== null && facts.categoryID !== null && COMPARE_CATEGORIES.includes(facts.categoryID),
    };
  }
  // ⚠ SELLING NEEDS THE HANGAR. PlaceMultiSellOrder moves a specific STACK into
  // escrow, so a sell must name an itemID — "10 of Tritanium" is not something
  // the market can act on. The hangar the Inventory page already reads is where
  // those stacks come from.
  // svelte-ignore state_referenced_locally
  const inventory = store.inventory;

  let busy = $state(false);
  let error = $state("");

  /** Which of the four views is showing. */
  let tab = $state<"book" | "orders" | "trades" | "escrow">("book");
  /** MarketBase.LoadDetails' detail tabs (the play page): Market Data (the order lists) or Price History. */
  let detailTab = $state<"marketdata" | "pricehistory">("marketdata");

  // The pilot's trades, as the client's market service keeps them (marketSvc.GetPersonalMarketTransactions): read
  // once as this view is chosen, the same read the wallet's Market Transactions shows, and let go when the pilot's
  // own orders change.
  // svelte-ignore state_referenced_locally
  const trades = flow.marketTransactions;
  $effect(() => {
    if (tab === "trades") void flow.loadMarketTransactions().catch(() => undefined);
  });
  $effect(() => {
    const refs: NameRef[] = [];
    for (const row of $trades.transactions) {
      refs.push({ kind: "type", id: row.typeID });
      refs.push({ kind: "station", id: row.stationID });
    }
    if (refs.length > 0) flow.requestNames(refs);
  });

  // --- Item search ---------------------------------------------------------
  let query = $state("");
  let matches = $state<readonly MarketTypeMatch[]>([]);
  let chosenName = $state("");
  // The chosen item's book is drawn under the browse tree, and an order's draft under the whole book, out of sight in a
  // window of its first size: choosing an item or pressing Offer to buy looked like a click that did nothing, and what
  // placing the order did is said at the window's head, far above the draft. The heading is brought to the top of
  // whatever scrolls the window, once it is drawn.
  let windowHead = $state<HTMLElement | undefined>();
  let bookHeading = $state<HTMLElement | undefined>();
  let draftHeading = $state<HTMLElement | undefined>();
  async function bringToTop(which: "head" | "book" | "draft"): Promise<void> {
    await tick();
    const heading = which === "head" ? windowHead : which === "book" ? bookHeading : draftHeading;
    let scroller = heading?.parentElement ?? null;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    if (heading && scroller) {
      scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }
  }
  // The market read as the window opens: of the type whose market details were asked for from outside it
  // (marketDetails.ts, marketutils.ShowMarketDetails), where one opened it, else of none; and of each type asked for
  // so while it is open.
  const marketDetailsRequests = marketDetailsTarget.requests;
  let marketFirstRead = true;
  $effect(() => {
    void $marketDetailsRequests;
    const wanted = marketDetailsTarget.take();
    if (!marketFirstRead && wanted === null) return;
    marketFirstRead = false;
    chosenName = "";
    void run(() => flow.loadMarket(wanted));
  });

  // --- Client-local book controls (retail's `marketQuote`) -----------------
  /** -1 means "no limit"; anything else caps how far away an order may be. */
  let maxJumps = $state(-1);

  // --- Placing / changing orders (Slice B) ---------------------------------
  type Draft = {
    readonly side: MarketSide;
    price: string;
    quantity: string;
    durationDays: number;
  };
  let draft = $state<Draft | null>(null);
  /** True once the player has asked to see the confirmation step. */
  let confirming = $state(false);
  /** The order the player has armed a cancel for. */
  let cancellingOrderID = $state<string | null>(null);
  /** The order being repriced, and the new price they typed. */
  let modifyingOrderID = $state<string | null>(null);
  let modifyPrice = $state("");
  let confirmingModify = $state(false);
  /** The hangar stack a sell will hand over. Null until one is picked. */
  let sellItemID = $state<number | null>(null);

  function typeName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID, "an unnamed item");
  }

  /**
   * MarketData's scrolls sort by a column header (eveScroll smartSort, the sort_<header> values quote.py sets): by
   * price at first - the sellers up, the buyers down - and a header clicked again turns its order round.
   */
  type QuoteKey = "jumps" | "qty" | "price" | "location" | "range" | "minvol" | "expires";
  let sellSort = $state<{ key: QuoteKey; up: boolean }>({ key: "price", up: true });
  let buySort = $state<{ key: QuoteKey; up: boolean }>({ key: "price", up: false });
  function quoteSortValue(order: MarketOrderRow, key: QuoteKey): number | string {
    switch (key) {
      // (GetJumps: in this station -1)
      case "jumps": return order.jumps === 0 && (order.stationID === $market.stationID || order.stationID === $market.structureID) ? -1 : order.jumps;
      case "qty": return order.volumeRemaining;
      case "price": return Number(order.price);
      case "location": return stationName(order.stationID).toLowerCase();
      // (GetRange: station 0, system 0.5, region the most, else the jumps)
      case "range": return order.range === -1 ? 0 : order.range === 0 ? 0.5 : order.range === 32767 ? Number.MAX_SAFE_INTEGER : order.range;
      case "minvol": return Math.min(order.volumeRemaining, order.minimumVolume);
      case "expires": return order.issuedAt === null ? 0 : Number(order.issuedAt) + order.durationDays * 864_000_000_000;
    }
  }
  function quoteSorted(list: readonly MarketOrderRow[], sort: { key: QuoteKey; up: boolean }): MarketOrderRow[] {
    return [...list].sort((a, b) => {
      const x = quoteSortValue(a, sort.key), y = quoteSortValue(b, sort.key);
      const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
      return sort.up ? c : -c;
    });
  }
  function quoteHeader(sort: { key: QuoteKey; up: boolean }, key: QuoteKey): { key: QuoteKey; up: boolean } {
    return sort.key === key ? { key, up: !sort.up } : { key, up: true };
  }

  /** quote.py GetJumps: in this station (the session's station or structure) Station, else at 0 System; Unreachable; the number. */
  function quoteJumps(order: MarketOrderRow): string {
    if (order.jumps === 0) return qbWord(order.stationID === $market.stationID || order.stationID === $market.structureID ? "UI/Common/LocationTypes/Station" : "UI/Common/LocationTypes/System");
    if (order.jumps === 1000000) return qbWord("UI/Common/LocationTypes/Unreachable");
    return String(order.jumps);
  }
  /** quote.py GetRange: rangeStation -1, rangeSolarSystem 0, rangeRegion 32767, else NumberOfJumps. */
  function quoteRange(order: MarketOrderRow): string {
    if (order.range === -1) return qbWord("UI/Common/LocationTypes/Station");
    if (order.range === 0) return qbWord("UI/Common/LocationTypes/SolarSystem");
    if (order.range === 32767) return qbWord("UI/Common/LocationTypes/Region");
    return qbWord("UI/Market/MarketQuote/NumberOfJumps", { num: order.range });
  }
  /** quote.py GetExpiresIn: the issue date plus the duration less now, Expired below nought, else FmtDate(exp, 'ss') (days, hours, minutes, seconds). */
  function quoteExpires(order: MarketOrderRow): string {
    if (order.issuedAt === null) return "—";
    const issuedMs = Number(order.issuedAt / 10000n - 11644473600000n);
    const left = issuedMs + order.durationDays * 86_400_000 - Date.now();
    if (!(left >= 0)) return qbWord("UI/Market/MarketQuote/Expired");
    let sec = Math.floor(left / 1000);
    const d = Math.floor(sec / 86400); sec -= d * 86400;
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const m = Math.floor(sec / 60); sec -= m * 60;
    return [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : "", `${sec}s`].filter(Boolean).join(" ");
  }

  function stationName(stationID: number): string {
    return resolvedName($names.resolved, "station", stationID, "an unnamed station");
  }

  function systemName(solarSystemID: number): string {
    return resolvedName($names.resolved, "system", solarSystemID, "an unknown system");
  }

  /** How far away an order is, the order's station checked against the pilot's own (quote.py GetJumps). */
  function orderDistance(order: MarketOrderRow): string {
    return distanceLabel(order.jumps, order.stationID === $market.stationID || order.stationID === $market.structureID);
  }

  /** A retail FILETIME as a plain date. Never rendered as a number. */
  function dateText(filetime: bigint | null): string {
    if (filetime === null) {
      return "—";
    }
    const unixMs = Number(filetime / 10000n - 11644473600000n);
    if (!Number.isFinite(unixMs) || unixMs <= 0) {
      return "—";
    }
    return new Date(unixMs).toLocaleDateString();
  }

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "Your session ended. Pick your character again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      busy = false;
    }
  }

  function search(): void {
    void run(async () => {
      matches = await flow.findMarketTypes(query);
    });
  }

  function chooseItem(match: MarketTypeMatch): void {
    chosenName = match.name;
    matches = [];
    query = "";
    closeDraft();
    void run(async () => {
      await flow.loadMarket(match.typeID);
      await bringToTop("book");
    });
  }

  function refresh(): void {
    void run(() => flow.loadMarket($market.typeID));
  }

  // --- The book, sorted and filtered client-side ---------------------------

  const sells = $derived.by(() =>
    filterByJumps(sortOrderBook($market.sells, "sell"), maxJumps),
  );
  const buys = $derived.by(() =>
    filterByJumps(sortOrderBook($market.buys, "buy"), maxJumps),
  );
  const best = $derived.by(() => bestPrices({ sells: $market.sells, buys: $market.buys }));

  const openOrders = $derived.by(() =>
    $market.ownOrders.filter((order) => order.state === "open"),
  );
  /**
   * What the pilot's own open orders have tied up, totalled from the orders as the client's orders panel totals them
   * (personalMarketOrders.py UpdateOrderTotals, 32 to 49: each open buy order's escrow), and the goods each open sell
   * order still holds, as the server's GetCharEscrow counts them (units). Not the market progression's kept value:
   * that is asked again at most every twelve hours, so straight after an order it disagreed with the orders listed.
   * The ISK goes through iskDelta's exact hundredths (adding is taking away the escrow's negative).
   */
  const tiedUp = $derived.by(() => {
    let isk = "0.00";
    let items = 0;
    for (const order of openOrders) {
      if (order.isCorp) continue;
      if (order.side === "buy") isk = iskDelta(isk, `-${order.escrow}`) ?? isk;
      else items += order.volumeRemaining;
    }
    return { isk, items };
  });

  /**
   * The stacks of the chosen item the player is actually holding at this
   * station. A sell is offered only against one of these: the market moves a
   * real stack into escrow, so offering a sell for goods the player does not
   * have would produce a refusal they could make no sense of.
   */
  const sellableStacks = $derived.by(() =>
    $market.typeID === null
      ? []
      : $inventory.hangar.rows.filter((row) => row.typeID === $market.typeID),
  );

  const chosenStack = $derived.by(
    () => sellableStacks.find((row) => row.itemID === sellItemID) ?? null,
  );

  // --- The order draft, and what it will cost ------------------------------

  const draftPriceCheck = $derived.by(() =>
    draft === null ? null : checkPrice(Number(draft.price)),
  );
  const draftQuantityCheck = $derived.by(() =>
    draft === null ? null : checkQuantity(Number(draft.quantity)),
  );
  /** price x quantity, at the ROUNDED price that will actually be sent. */
  const draftValue = $derived.by(() => {
    if (draft === null || !draftPriceCheck?.ok || !draftQuantityCheck?.ok) {
      return null;
    }
    return (draftPriceCheck.price * Number(draft.quantity)).toFixed(2);
  });
  /**
   * An order filled right now or not at all (duration 0) pays no broker's fee: the client works the fee out only for
   * an order left open, and shows "-" for one that is not (buyThisTypeWindow.py 876 to 912, `if duration > 0`).
   */
  const draftFillsNow = $derived(draft !== null && Number(draft.durationDays) === 0);
  /**
   * The fee at the pilot's own rate where the Market read has one (the BFF works it out as the game does, on the
   * game port). Without one, ⚠ AN ESTIMATE at the standard 3% rate — see bridge/market.ts.
   */
  const draftFee = $derived.by(() => {
    if (draft === null || draftFillsNow || !draftPriceCheck?.ok || !draftQuantityCheck?.ok) {
      return null;
    }
    return estimateBrokerFee(draftPriceCheck.price, Number(draft.quantity), $market.brokersFeeRate);
  });
  const draftFeeWords = $derived(draftFillsNow ? { heading: "Broker's fee", before: "", percent: null } : brokerFeeWords(draftFee));
  // A rate known while docked in a structure is the structure's own, not the pilot's.
  const draftFeeBasis = $derived(brokerFeeBasisWords($market.structureID !== null));
  const draftReady = $derived.by(() => {
    if (draft === null || draftPriceCheck?.ok !== true || draftQuantityCheck?.ok !== true) {
      return false;
    }
    if (draft.side === "buy") {
      return true;
    }
    // A sell must name a stack, and cannot offer more than that stack holds.
    return chosenStack !== null && Number(draft.quantity) <= chosenStack.quantity;
  });

  function startDraft(side: MarketSide): void {
    const suggested = side === "buy" ? best.bestBuy : best.bestSell;
    const stack = side === "sell" ? sellableStacks[0] ?? null : null;
    sellItemID = stack ? stack.itemID : null;
    draft = {
      side,
      price: suggested ?? "",
      // A sell defaults to the whole stack; a buy to one unit.
      quantity: stack ? String(stack.quantity) : "1",
      durationDays: 30,
    };
    confirming = false;
    void bringToTop("draft");
  }

  /**
   * R84 — TAKE A PRICE OFF THE BOOK.
   *
   * Placing an order meant typing a price and a quantity by hand while the
   * numbers you wanted were sitting on screen a few centimetres away. Clicking
   * a row carries them into the draft.
   *
   * ⚠ IT PRE-FILLS A DRAFT, IT DOES NOT BUY. The wording everywhere is "use this
   * price", never "buy it now", and the existing confirm step is untouched.
   * Placing a buy at a seller's price is not the same act as taking that
   * specific listing — whether it matches immediately is the SERVER's business,
   * and this panel has never been willing to claim an outcome it has not read
   * back. `lastOutcome` still reports what actually happened to the wallet.
   *
   * Clicking a SELL order (someone is selling) drafts a BUY; clicking a BUY
   * order (someone is buying) drafts a SELL.
   */
  function useOrderPrice(order: MarketOrderRow, side: MarketSide): void {
    startDraft(side);
    const current = draft;
    if (current === null) {
      return;
    }
    if (side === "buy") {
      draft = { ...current, price: order.price, quantity: String(order.volumeRemaining) };
      return;
    }
    // Selling: never offer more than the counterparty wants, and never more than
    // the stack actually holds. Both caps are real refusals if ignored.
    const stack = sellableStacks[0] ?? null;
    const most = stack
      ? Math.min(stack.quantity, order.volumeRemaining)
      : order.volumeRemaining;
    draft = { ...current, price: order.price, quantity: String(most) };
  }

  function closeDraft(): void {
    draft = null;
    confirming = false;
    sellItemID = null;
  }

  function placeOrder(): void {
    const current = draft;
    const priceCheck = draftPriceCheck;
    if (current === null || !priceCheck?.ok || $market.typeID === null) {
      return;
    }
    void run(async () => {
      await flow.placeMarketOrder({
        side: current.side,
        typeID: $market.typeID as number,
        price: priceCheck.price,
        quantity: Number(current.quantity),
        durationDays: current.durationDays,
        // Only a sell carries one, and it is required there.
        itemID: current.side === "sell" ? sellItemID ?? 0 : undefined,
      });
      closeDraft();
    }).then(() => bringToTop("head"));
  }

  function cancelOrder(order: MarketOwnOrderRow): void {
    cancellingOrderID = null;
    void run(() => flow.cancelMarketOrder(order.orderID));
  }

  function startModify(order: MarketOwnOrderRow): void {
    modifyingOrderID = order.orderID;
    modifyPrice = order.price;
    confirmingModify = false;
  }

  function closeModify(): void {
    modifyingOrderID = null;
    modifyPrice = "";
    confirmingModify = false;
  }

  const modifyCheck = $derived.by(() =>
    modifyingOrderID === null ? null : checkPrice(Number(modifyPrice)),
  );

  function applyModify(order: MarketOwnOrderRow): void {
    const check = modifyCheck;
    if (!check?.ok) {
      return;
    }
    void run(async () => {
      await flow.modifyMarketOrder(order.orderID, check.price);
      closeModify();
    });
  }

  /** What the last write ACTUALLY did, in words. Never a prediction. */
  const outcomeText = $derived.by(() => {
    const outcome = $market.lastOutcome;
    if (outcome === null) {
      return null;
    }
    if (outcome.declinedSilently) {
      return "The server did not apply that change, and gave no reason.";
    }
    if (outcome.charged === null) {
      return "That went through. The server did not report a wallet change.";
    }
    const negative = outcome.charged.startsWith("-");
    const magnitude = negative ? outcome.charged.slice(1) : outcome.charged;
    if (magnitude === "0.00" || magnitude === "0") {
      return "That went through. Nothing was taken from your wallet.";
    }
    // A sell that filled is paid for its goods; any other change that leaves the wallet higher returned ISK to it.
    if (negative) {
      return outcome.kind === "sell"
        ? `That went through. ${formatIsk(magnitude)} came into your wallet for what you sold.`
        : `That went through. ${formatIsk(magnitude)} was returned to your wallet.`;
    }
    return `That went through. You were actually charged ${formatIsk(magnitude)}.`;
  });
  /** The side of the order whose take-down is being asked, for the words under it. */
  const cancellingSide = $derived(openOrders.find((order) => order.orderID === cancellingOrderID)?.side ?? null);

  // --- R83: BROWSING, not just searching -------------------------------------
  //
  // The only way into this panel was to TYPE an item's name — fine when you know
  // what you want, useless when you do not. "What ammunition fits this?" and
  // "what is even on sale?" are the questions a market is for and neither can be
  // typed. So the market tree is the way in, and the search box narrows it.
  //
  // The tree is STATIC reference data (see space of `/api/market/groups`), which
  // is why it loads before — and independently of — anything the market daemon
  // says. A player can find out what exists even when prices cannot be read.
  interface Crumb {
    readonly marketGroupID: number;
    readonly name: string;
  }
  let crumbs = $state<Crumb[]>([]);
  let groups = $state<readonly MarketGroupNode[]>([]);
  let groupTypes = $state<readonly MarketTypeMatch[]>([]);
  let groupTypesCapped = $state(false);
  let browsing = $state(false);

  /** Where in the tree we are — 0 is the root. */
  const currentGroupID = $derived(crumbs.length === 0 ? 0 : crumbs[crumbs.length - 1]!.marketGroupID);

  async function openGroupID(groupID: number): Promise<void> {
    browsing = true;
    try {
      groups = await flow.loadMarketGroups(groupID);
      if (groupID === 0) {
        // The root holds no items of its own.
        groupTypes = [];
        groupTypesCapped = false;
      } else {
        const result = await flow.loadMarketGroupTypes(groupID);
        groupTypes = result.types;
        groupTypesCapped = result.capped;
      }
    } catch (cause) {
      // Browsing is reference data; failing it must not blank the prices that
      // are already on screen.
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      browsing = false;
    }
  }

  function enterGroup(node: MarketGroupNode): void {
    crumbs = [...crumbs, { marketGroupID: node.marketGroupID, name: node.name }];
    void openGroupID(node.marketGroupID);
  }

  /** Jump to a crumb; -1 is "All items". */
  function goToCrumb(index: number): void {
    crumbs = index < 0 ? [] : crumbs.slice(0, index + 1);
    void openGroupID(index < 0 ? 0 : crumbs[index]!.marketGroupID);
  }

  onMount(() => {
    // (The market's first read is the marketDetailsRequests effect's: the type asked for from outside the window, or none.)
    // The tree, so the panel opens on something to look AT rather than an empty
    // search box. Independent of the market read: it is static data.
    void openGroupID(0);
    // The hangar, so a sell can name a real stack. Deliberately NOT part of the
    // market load: it is a different panel's read, and failing it must cost the
    // player only the ability to sell, not the whole market page.
    void flow.loadInventory().catch(() => {});
    // The pilot's escrow kept as the client's market progression keeps it (asked at most each twelve hours), watched
    // while the window is open. The figures the window shows are its open orders' (tiedUp).
    return flow.watchMarketProgression();
  });
  /**
   * The play page's windows (PlayApp's "retailChrome"): the market laid out as marketbase.MarketBase - the browse side
   * (Browse / Quickbar, the search, the tree) at the left, 180 wide, an 8 divider, the rest at the right.
   */
  const retail = getContext("retailChrome") === true;
</script>

<div class="market-layout" class:retail>
<section class="panel">
  <header class="panel-head" bind:this={windowHead}>
    <h2 class="panel-title">Market</h2>
    <p class="controls">
      <input
        type="search"
        bind:value={query}
        placeholder="Search for an item to trade"
        onkeydown={(event) => event.key === "Enter" && search()}
      />
      <button type="button" class="primary" disabled={busy || query.trim().length < 2} onclick={search}>
        Search
      </button>
      <button type="button" class="minor" disabled={busy} onclick={refresh}>Refresh</button>
    </p>
  </header>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $market.marketUnavailable}
    <p class="error">{$market.marketUnavailable}</p>
  {/if}
  <!-- (A refusal the client's own dialog said is not said again here: ClientDialogs.svelte.) -->
  {#if $market.actionError && !$market.actionErrorSaid}
    <p class="error">Your last order was not placed: {$market.actionError}</p>
  {/if}
  {#if outcomeText}
    <p class="note">{outcomeText}</p>
  {/if}
  <!--
    R83 — THE WAY IN IS A TREE, and the search box narrows it.

    Before this the only route to an item was typing its name, which answers
    "how much is Veldspar" and nothing else. The market's real questions —
    what ammunition exists, what is worth hauling — are BROWSING questions.

    Groups and items are both plain rows in one list: a group descends, an item
    opens its order books. They are visibly different (a group carries a chevron
    and its own icon; an item carries its picture) but they behave consistently,
    which is what makes the list scannable in a narrow window.
  -->
  {#if namingUp && naming !== null}
    {@const held = naming}
    <NamePopup caption={held.caption} label={held.label} value={held.value} maxLength={held.maxLength}
      refusal={held.refuses ? qbWord("UI/Common/PleaseTypeSomething") : null}
      okWord={qbWord("UI/Common/Buttons/OK")} cancelWord={qbWord("UI/Common/Buttons/Cancel")}
      onok={(text) => held.ok(text)} oncancel={() => (namingUp = false)} />
  {/if}
  {#if questionUp && question !== null}
    {@const asked = question}
    <div class="qb-question" role="alertdialog" aria-label={asked.title}>
      <strong>{asked.title}</strong>
      <p>{asked.body}</p>
      <p class="controls">
        <button type="button" onclick={() => asked.answer(true)}>{qbWord("UI/Common/Buttons/Yes")}</button>
        <button type="button" class="minor" onclick={() => asked.answer(false)}>{qbWord("UI/Common/Buttons/No")}</button>
      </p>
    </div>
  {/if}
  {#if qbMenuUp && qbMenu !== null}
    {@const menuFor = qbMenu}
    <span class="hull-menu" role="menu" use:portal style:left={`${menuFor.x}px`} style:top={`${menuFor.y}px`}>
      {#if menuFor.kind === "folder"}
        {@const folder = menuFor.entry}
        {@const buyDict = typesUnderFolder($quickbar, folder.id)}
        <button type="button" role="menuitem" onclick={() => { qbMenuUp = false; qbOpen[folder.id] = qbOpen[folder.id] !== true; }}>{qbWord(qbOpen[folder.id] === true ? "UI/Common/Collapse" : "UI/Common/Expand")}</button>
        <button type="button" role="menuitem" onclick={() => changeLabel(folder)}>{qbWord("/Carbon/UI/Controls/ScrollEntries/ChangeLabel")}</button>
        <button type="button" role="menuitem" onclick={() => deleteQbFolder(folder)}>{qbWord("/Carbon/UI/Controls/ScrollEntries/DeleteFolder")}</button>
        <button type="button" role="menuitem" onclick={() => newFolder(folder.id)}>{qbWord("UI/Market/NewFolder")}</button>
        {#if buyDict.size > 0}
          <button type="button" role="menuitem" onclick={() => { qbMenuUp = false; void flow.openMultiBuy(buyDict).catch(() => {}); }}>{qbWord("UI/Market/MarketQuote/BuyAll")}</button>
        {/if}
      {:else if menuFor.kind === "type"}
        {@const entry = menuFor.entry}
        {@const typeID = Number(entry.label)}
        {@const offers = typeMenuOffers(typeID)}
        <button type="button" role="menuitem" onclick={() => editExtraText(entry)}>{qbWord(entry.extraText ? "UI/Market/Marketbase/EditAdditionalText" : "UI/Market/Marketbase/AddAdditionalText")}</button>
        <hr />
        <button type="button" role="menuitem" onclick={() => { qbMenuUp = false; changeQuickbar((quickbar) => removeType(quickbar, entry.parent, typeID)); }}>{qbWord("UI/Market/Remove")}</button>
        <hr />
        <button type="button" role="menuitem" onclick={() => { qbMenuUp = false; showInfo({ kind: "type", typeID }); }}>{qbWord("UI/Commands/ShowInfo")}</button>
        {#if offers.market}
          <button type="button" role="menuitem" onclick={() => { qbMenuUp = false; showMarketDetails(typeID); }}>{qbWord("UI/Inventory/ItemActions/ViewTypesMarketDetails")}</button>
        {/if}
        {#if offers.published}
          <button type="button" role="menuitem" onclick={() => { qbMenuUp = false; findInContracts(typeID); }}>{qbWord("UI/Inventory/ItemActions/FindInContracts")}</button>
          <button type="button" role="menuitem" onclick={() => { qbMenuUp = false; findInPersonalAssets(assetSearchTextForType(qbWord("UI/Inventory/AssetSearch/KeywordTypeExact"), typeName(typeID))); }}>{qbWord("UI/Inventory/ItemActions/FindPersonalAssets")}</button>
        {/if}
        {#if offers.compare}
          <button type="button" role="menuitem" onclick={() => { qbMenuUp = false; compareType(typeID); }}>{qbWord("UI/Compare/CompareButton")}</button>
        {/if}
      {:else}
        {@const typeID = menuFor.typeID}
        <button type="button" role="menuitem" onclick={() => void addToQuickbar(typeID)}>{qbWord("UI/Inventory/ItemActions/AddTypeToMarketQuickbar")}</button>
        <button type="button" role="menuitem" onclick={() => { qbMenuUp = false; showInfo({ kind: "type", typeID }); }}>{qbWord("UI/Commands/ShowInfo")}</button>
      {/if}
    </span>
  {/if}
  {#if qbNotice}
    <p class="note">{qbNotice}</p>
  {/if}
  <nav class="tabs qb-tabs">
    <button type="button" class:active={leftTab === "browse"} aria-pressed={leftTab === "browse"} onclick={() => (leftTab = "browse")}>{qbWord("UI/Market/Browse")}</button>
    <button type="button" class:active={leftTab === "quickbar"} aria-pressed={leftTab === "quickbar"} onclick={() => (leftTab = "quickbar")}>{qbWord("UI/Market/QuickBar")}</button>
  </nav>
  {#snippet qbLevel(parent: number, depth: number)}
    {@const kids = qbChildren(parent)}
    {#each kids.folders as folder (folder.id)}
      <details class="qb-folder" style:margin-left={`${depth}rem`} open={qbOpen[folder.id] === true} ontoggle={(event) => qbToggled(folder.id, event)}>
        <summary oncontextmenu={(event) => openQbMenu({ kind: "folder", entry: folder }, event)}>{String(folder.label)}</summary>
        {#if qbOpen[folder.id] === true}
          {@render qbLevel(folder.id, 1)}
        {/if}
      </details>
    {/each}
    {#each kids.types as entry (entry.id)}
      {@const typeID = Number(entry.label)}
      <button type="button" class="pick-row qb-type" class:qb-unsold={qbUnsold(typeID)} style:margin-left={`${depth}rem`}
        title={qbUnsold(typeID) ? qbWord("UI/Market/Marketbase/NotAvailableOnMarket") : undefined}
        disabled={busy} onclick={() => qbClick(entry)} oncontextmenu={(event) => openQbMenu({ kind: "type", entry }, event)}>
        <TypeIcon typeID={typeID} name={typeName(typeID)} />
        <span class="pick-main"><span class="pick-name">{qbTypeLabel(entry)}</span></span>
      </button>
    {/each}
  {/snippet}
  {#if leftTab === "quickbar"}
    <p class="controls qb-buttons">
      <button type="button" class="minor" title={qbWord("Tooltips/Market/MarketQuickbarNewFolder")} onclick={() => newFolder(0)}>{qbWord("UI/Market/NewFolder")}</button>
      <button type="button" class="minor" title={qbWord("Tooltips/Market/MarketQuickbarReset")} aria-label={qbWord("Tooltips/Market/MarketQuickbarReset")} onclick={resetQuickbar}>🗑</button>
    </p>
    {#if $quickbar.entries.length === 0}
      <p class="empty">{qbWord("UI/Common/NothingFound")}</p>
    {:else}
      <div class="qb-tree">{@render qbLevel(0, 0)}</div>
    {/if}
  {:else}
  <nav class="market-crumbs" aria-label="Where you are in the market">
    <button type="button" class="crumb" disabled={busy || browsing} onclick={() => goToCrumb(-1)}>
      All items
    </button>
    {#each crumbs as crumb, index (crumb.marketGroupID)}
      <span class="crumb-sep" aria-hidden="true">›</span>
      <button
        type="button"
        class="crumb"
        disabled={busy || browsing}
        aria-current={index === crumbs.length - 1 ? "page" : undefined}
        onclick={() => goToCrumb(index)}
      >{crumb.name}</button>
    {/each}
  </nav>

  {#if matches.length > 0}
    <!-- A search is showing: its results replace the branch, and the breadcrumb
         above is still the way back to browsing. -->
    <h3>Search results</h3>
    <ul class="market-picker">
      {#each matches as match (match.typeID)}
        <li>
          <button type="button" class="pick-row" disabled={busy} onclick={() => chooseItem(match)} oncontextmenu={(event) => openQbMenu({ kind: "browse", typeID: match.typeID }, event)}>
            <TypeIcon typeID={match.typeID} name={match.name} />
            <span class="pick-main">
              <span class="pick-name">{match.name}</span>
              <span class="pick-meta">{match.groupName}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {:else if browsing}
    <p class="note">Opening…</p>
  {:else}
    {#if groups.length === 0 && groupTypes.length === 0}
      <p class="empty">This part of the market holds nothing.</p>
    {/if}
    <ul class="market-picker">
      {#each groups as node (node.marketGroupID)}
        <li>
          <button type="button" class="pick-row pick-group" disabled={busy} onclick={() => enterGroup(node)}>
            <span class="pick-main">
              <span class="pick-name">{node.name}</span>
            </span>
            <span class="pick-chevron" aria-hidden="true">›</span>
          </button>
        </li>
      {/each}
      {#each groupTypes as item (item.typeID)}
        <li>
          <button type="button" class="pick-row" disabled={busy} onclick={() => chooseItem(item)} oncontextmenu={(event) => openQbMenu({ kind: "browse", typeID: item.typeID }, event)}>
            <TypeIcon typeID={item.typeID} name={item.name} />
            <span class="pick-main">
              <span class="pick-name">{item.name}</span>
              <span class="pick-meta">{item.groupName}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
    {#if groupTypesCapped}
      <!-- Never a silent slice: the panel says it capped so a player can narrow
           with the search box instead of believing they have seen everything. -->
      <p class="note">Only the first {groupTypes.length} items here are listed — search to narrow it.</p>
    {/if}
  {/if}
  {/if}
  {#if !$market.loaded}
    <p class="note">Loading the market…</p>
  {:else}
    <p class="note">
      Your ISK: <strong>{formatIsk($market.cashBalance)}</strong>.
      {#if !$market.ownOrdersError}
        {formatIsk(tiedUp.isk)} of it is tied up in buy orders.
      {/if}
    </p>
  {/if}
</section>

{#if $market.loaded && retail}
  <!-- MarketBase's tab bar (32 high): the Details tab at the left (sr.tabs, UI/Common/Details); the ghost buttons at the
       right - Market Orders (OpenMarketOrders: our open orders here), and the page's own trades and tied-up views,
       which the client keeps in the wallet; then the window header's WalletBalance (the ISK icon, its button the
       wallet, and the balance, TextColor.SECONDARY). The NES and Multibuy buttons and the Groups tab are not built. -->
  <section class="mkt-tabbar">
    <nav class="mkt-tabs">
      <button type="button" class:active={tab === "book"} title={qbWord("Tooltips/Market/MarketDetailsTab")} onclick={() => (tab = "book")}>{qbWord("UI/Common/Details")}</button>
    </nav>
    <span class="mkt-ghosts">
      <button type="button" class="mkt-ghost" class:active={tab === "orders"} onclick={() => (tab = "orders")}>{qbWord("Tooltips/StationServices/MarketOrders")}</button>
      <button type="button" class="mkt-ghost" class:active={tab === "trades"} onclick={() => (tab = "trades")}>Your trades</button>
      <button type="button" class="mkt-ghost" class:active={tab === "escrow"} onclick={() => (tab = "escrow")}>What is tied up</button>
    </span>
    <span class="mkt-wallet">
      <img alt="ISK" src="/client-res/ui/texture/eveicon/category_icons/isk_16px.png" />
      <span>{$market.cashBalance === null || $market.cashBalance === undefined ? qbWord("UI/Market/WalletBalanceUnavailable") : formatIsk($market.cashBalance)}</span>
    </span>
  </section>
{:else if $market.loaded}
  <section>
    <p class="controls">
      <button type="button" class:active={tab === "book"} onclick={() => (tab = "book")}>
        What is on sale
      </button>
      <button type="button" class:active={tab === "orders"} onclick={() => (tab = "orders")}>
        Your orders
      </button>
      <button type="button" class:active={tab === "trades"} onclick={() => (tab = "trades")}>
        Your trades
      </button>
      <button type="button" class:active={tab === "escrow"} onclick={() => (tab = "escrow")}>
        What is tied up
      </button>
    </p>
  </section>
{/if}

{#if $market.loaded && tab === "book"}
  <section class={retail ? `mkt-details detail-${detailTab}` : undefined}>
    {#if retail}
      <!-- MarketBase.LoadDetails: the type's head (topDetailsCont, at least 64 high) - its 64 icon (MarketGroupItemImage,
           8 before the text), its name (EveCaptionMedium; NoTypeSelected while none) with its info icon - then the
           detail tabs, Market Data and Price History. The group trace, the find-in-browse button and the requirements
           are not built (the page holds no type's market group path). -->
      <div class="mkt-head">
        {#if $market.typeID !== null}
          <span class="mkt-head-icon"><TypeIcon typeID={$market.typeID} name={chosenName || typeName($market.typeID)} size="lg" /></span>
        {/if}
        <div class="mkt-head-text">
          <span class="mkt-head-name">{$market.typeID === null ? qbWord("UI/Market/Marketbase/NoTypeSelected") : chosenName || typeName($market.typeID)}</span>
          {#if $market.typeID !== null}
            {@const shownTypeID = $market.typeID}
            <button type="button" class="mkt-info" aria-label={qbWord("UI/Commands/ShowInfo")} title={qbWord("UI/Commands/ShowInfo")} onclick={() => showInfo({ kind: "type", typeID: shownTypeID })}>i</button>
          {/if}
        </div>
      </div>
      {#if $market.typeID !== null}
        <nav class="mkt-dtabs">
          <button type="button" class:active={detailTab === "marketdata"} title={qbWord("Tooltips/Market/MarketDetailsData")} onclick={() => (detailTab = "marketdata")}>{qbWord("UI/Market/MarketData")}</button>
          <button type="button" class:active={detailTab === "pricehistory"} title={qbWord("Tooltips/Market/MarketDetailsHistory")} onclick={() => (detailTab = "pricehistory")}>{qbWord("UI/Market/Marketbase/PriceHistory")}</button>
        </nav>
      {/if}
    {/if}
    <h2 bind:this={bookHeading}>
      {#if $market.typeID === null}
        Pick an item
      {:else}
        {chosenName || typeName($market.typeID)}
      {/if}
    </h2>
    {#if $market.typeID === null}
      <p class="note">Search for an item above to see who is buying and selling it.</p>
    {:else}
      {#if $market.bookError}
        <p class="error">This item's market could not be read: {$market.bookError}</p>
      {/if}
      <p class="note">
        Cheapest on sale: <strong>{formatIsk(best.bestSell)}</strong> ·
        Best price anyone is paying: <strong>{formatIsk(best.bestBuy)}</strong>.
        These are what is on offer right now — the server works out what a trade
        actually costs when you place an order.
      </p>
      <p class="controls">
        <label>
          Show orders
          <select bind:value={maxJumps}>
            <option value={-1}>Anywhere in the region</option>
            <option value={0}>In this system only</option>
            <option value={1}>Within 1 jump</option>
            <option value={5}>Within 5 jumps</option>
            <option value={10}>Within 10 jumps</option>
          </select>
        </label>
        <button type="button" disabled={busy} onclick={() => startDraft("buy")}>
          Offer to buy…
        </button>
        <button
          type="button"
          disabled={busy || sellableStacks.length === 0}
          onclick={() => startDraft("sell")}
        >
          Offer to sell…
        </button>
      </p>

      <!--
        R84 — THE BOOKS ARE LISTS, AND THE ROWS DO SOMETHING.

        They were six-column tables, so reading them in a market window meant
        scrolling sideways — the same failure the overview had (R82), and the
        same fix: price and quantity are what a trader reads, everything else is
        a muted line underneath that truncates.

        Each row is a button that carries its price into the order draft. The
        numbers you want were already on screen; typing them again by hand was
        the only way to use them.
      -->
      {#if retail}
        <!-- marketbase.MarketData: Sellers over Buyers (EveCaptionMedium heads), each an eveScroll of quote.py's columns -
             sellers Jumps, Quantity, Price, Location, Expires in (by price up); buyers Jumps, Quantity, Price, Location,
             Range, Min Volume, Expires in (by price down); a row's price carried into the order draft as before. -->
        <div class="mkt-quote">
          <h3 class="mkt-quote-cap">{qbWord("UI/Market/Marketbase/Sellers")}</h3>
          <div class="mkt-quote-scroll">
            <table>
              <thead><tr>
                <th class="r" aria-sort={sellSort.key === "jumps" ? (sellSort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (sellSort = quoteHeader(sellSort, "jumps"))}>{qbWord("UI/Market/Marketbase/Jumps")}{sellSort.key === "jumps" ? (sellSort.up ? " ▲" : " ▼") : ""}</button></th><th class="r" aria-sort={sellSort.key === "qty" ? (sellSort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (sellSort = quoteHeader(sellSort, "qty"))}>{qbWord("UI/Common/Quantity")}{sellSort.key === "qty" ? (sellSort.up ? " ▲" : " ▼") : ""}</button></th>
                <th class="r" aria-sort={sellSort.key === "price" ? (sellSort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (sellSort = quoteHeader(sellSort, "price"))}>{qbWord("UI/Market/Marketbase/Price")}{sellSort.key === "price" ? (sellSort.up ? " ▲" : " ▼") : ""}</button></th><th aria-sort={sellSort.key === "location" ? (sellSort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (sellSort = quoteHeader(sellSort, "location"))}>{qbWord("UI/Common/Location")}{sellSort.key === "location" ? (sellSort.up ? " ▲" : " ▼") : ""}</button></th><th aria-sort={sellSort.key === "expires" ? (sellSort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (sellSort = quoteHeader(sellSort, "expires"))}>{qbWord("UI/Market/Marketbase/ExpiresIn")}{sellSort.key === "expires" ? (sellSort.up ? " ▲" : " ▼") : ""}</button></th>
              </tr></thead>
              <tbody>
                {#each quoteSorted(sells, sellSort) as order (order.orderID)}
                  <tr title={`Use ${formatIsk(order.price)} as your buy price`} onclick={() => { if (!busy) useOrderPrice(order, "buy"); }}>
                    <td class="r">{quoteJumps(order)}</td><td class="r">{order.volumeRemaining.toLocaleString()}</td>
                    <td class="r price">{formatIsk(order.price)}</td><td>{stationName(order.stationID)}</td><td>{quoteExpires(order)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <h3 class="mkt-quote-cap">{qbWord("UI/Market/Marketbase/Buyers")}</h3>
          <div class="mkt-quote-scroll">
            <table>
              <thead><tr>
                <th class="r" aria-sort={buySort.key === "jumps" ? (buySort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (buySort = quoteHeader(buySort, "jumps"))}>{qbWord("UI/Market/Marketbase/Jumps")}{buySort.key === "jumps" ? (buySort.up ? " ▲" : " ▼") : ""}</button></th><th class="r" aria-sort={buySort.key === "qty" ? (buySort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (buySort = quoteHeader(buySort, "qty"))}>{qbWord("UI/Common/Quantity")}{buySort.key === "qty" ? (buySort.up ? " ▲" : " ▼") : ""}</button></th>
                <th class="r" aria-sort={buySort.key === "price" ? (buySort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (buySort = quoteHeader(buySort, "price"))}>{qbWord("UI/Market/Marketbase/Price")}{buySort.key === "price" ? (buySort.up ? " ▲" : " ▼") : ""}</button></th><th aria-sort={buySort.key === "location" ? (buySort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (buySort = quoteHeader(buySort, "location"))}>{qbWord("UI/Common/Location")}{buySort.key === "location" ? (buySort.up ? " ▲" : " ▼") : ""}</button></th><th aria-sort={buySort.key === "range" ? (buySort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (buySort = quoteHeader(buySort, "range"))}>{qbWord("UI/Common/Range")}{buySort.key === "range" ? (buySort.up ? " ▲" : " ▼") : ""}</button></th>
                <th class="r" aria-sort={buySort.key === "minvol" ? (buySort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (buySort = quoteHeader(buySort, "minvol"))}>{qbWord("UI/Market/MarketQuote/HeaderMinVolumn")}{buySort.key === "minvol" ? (buySort.up ? " ▲" : " ▼") : ""}</button></th><th aria-sort={buySort.key === "expires" ? (buySort.up ? "ascending" : "descending") : undefined}><button type="button" onclick={() => (buySort = quoteHeader(buySort, "expires"))}>{qbWord("UI/Market/Marketbase/ExpiresIn")}{buySort.key === "expires" ? (buySort.up ? " ▲" : " ▼") : ""}</button></th>
              </tr></thead>
              <tbody>
                {#each quoteSorted(buys, buySort) as order (order.orderID)}
                  <tr title={`Use ${formatIsk(order.price)} as your sell price`} onclick={() => { if (!busy) useOrderPrice(order, "sell"); }}>
                    <td class="r">{quoteJumps(order)}</td><td class="r">{order.volumeRemaining.toLocaleString()}</td>
                    <td class="r price">{formatIsk(order.price)}</td><td>{stationName(order.stationID)}</td><td>{quoteRange(order)}</td>
                    <td class="r">{Math.min(order.volumeRemaining, order.minimumVolume).toLocaleString()}</td><td>{quoteExpires(order)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <!-- MarketData's ButtonGroup (TOBOTTOM, padTop 16, at the end): Place Buy Order (PRIMARY, the ISK icon - our buy
               draft), Find in Contracts; Export to File is not built. -->
          {#if $market.typeID !== null}
            {@const quotedTypeID = $market.typeID}
            <div class="mkt-quote-buttons">
              <button type="button" class="mkt-primary" disabled={busy} onclick={() => startDraft("buy")}>
                <img alt="" src="/client-res/ui/texture/eveicon/category_icons/isk_16px.png" />{qbWord("UI/Market/Marketbase/CommandPlaceBuyOrder")}
              </button>
              <button type="button" class="mkt-ghost" onclick={() => findInContracts(quotedTypeID)}>{qbWord("UI/Inventory/ItemActions/FindInContracts")}</button>
            </div>
          {/if}
        </div>
      {:else}
      <h3>On sale (you can buy these)</h3>
      {#if sells.length === 0}
        <p class="empty">Nobody is selling this here right now.</p>
      {:else}
        <ul class="market-book">
          {#each sells as order (order.orderID)}
            <li class="book-line">
              <button
                type="button"
                class="book-row"
                disabled={busy}
                title={`Use ${formatIsk(order.price)} as your buy price`}
                onclick={() => useOrderPrice(order, "buy")}
              >
                <span class="book-price">{formatIsk(order.price)}</span>
                <span class="book-main">
                  <span class="book-where">{stationName(order.stationID)}</span>
                  <span class="book-meta">
                    {systemName(order.solarSystemID)} · {orderDistance(order)}{order.minimumVolume >
                    1
                      ? ` · ${order.minimumVolume} minimum`
                      : ""}
                  </span>
                </span>
                <span class="book-qty">×{order.volumeRemaining}</span>
              </button>
              <!-- The order's Location (entries.py GetMenu, 111 to 123): its station's or structure's route entries. -->
              <PlaceRouteMenu {store} {flow} placeID={order.stationID} />
            </li>
          {/each}
        </ul>
      {/if}

      <h3>Wanted (you can sell to these)</h3>
      {#if buys.length === 0}
        <p class="empty">Nobody is buying this here right now.</p>
      {:else}
        <ul class="market-book">
          {#each buys as order (order.orderID)}
            <li class="book-line">
              <button
                type="button"
                class="book-row"
                disabled={busy}
                title={`Use ${formatIsk(order.price)} as your sell price`}
                onclick={() => useOrderPrice(order, "sell")}
              >
                <span class="book-price">{formatIsk(order.price)}</span>
                <span class="book-main">
                  <span class="book-where">{stationName(order.stationID)}</span>
                  <span class="book-meta">
                    {systemName(order.solarSystemID)} · {orderDistance(order)} · reaches {rangeLabel(
                      order.range,
                    )}
                  </span>
                </span>
                <span class="book-qty">×{order.volumeRemaining}</span>
              </button>
              <PlaceRouteMenu {store} {flow} placeID={order.stationID} />
            </li>
          {/each}
        </ul>
      {/if}

      {/if}

      {#if $market.priceHistory.length > 0}
        <div class="mkt-history">
        {#if retail}
          <MarketPriceHistory rows={$market.priceHistory} word={(label, args = {}) => qbWord(label, args)} isk={(v) => formatIsk(v === null ? null : String(v))} />
        {:else}
        <h3>Price history</h3>
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr><th>Day</th><th class="num">Lowest</th><th class="num">Highest</th><th class="num">Average</th><th class="num">Traded</th></tr>
            </thead>
            <tbody>
              <!-- Keyed by its place: the history the game makes of its two halves can have a day twice. -->
              {#each $market.priceHistory as day, place (place)}
                <tr>
                  <td data-label="Day">{historyDayText(day.day)}</td>
                  <td class="num" data-label="Lowest">{formatIsk(day.low)}</td>
                  <td class="num" data-label="Highest">{formatIsk(day.high)}</td>
                  <td class="num" data-label="Average">{formatIsk(day.average)}</td>
                  <td class="num" data-label="Traded">{day.volume}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {/if}
        </div>
      {/if}
    {/if}
  </section>

  {#if draft !== null && $market.typeID !== null}
    <section class="bulk">
      <h2 bind:this={draftHeading}>
        {draft.side === "buy" ? "Offer to buy" : "Offer to sell"}
        {chosenName || typeName($market.typeID)}
      </h2>
      {#if !confirming}
        {#if draft.side === "sell"}
          <p class="controls">
            <label>
              Which of yours to sell
              <select bind:value={sellItemID}>
                {#each sellableStacks as stack (stack.itemID)}
                  <option value={stack.itemID}>
                    {typeName(stack.typeID)} — {stack.quantity} you are holding
                  </option>
                {/each}
              </select>
            </label>
          </p>
          {#if chosenStack === null}
            <p class="note">
              You are not holding any of this here, so there is nothing to sell.
            </p>
          {/if}
        {/if}
        <p class="controls">
          <label>
            Price for each one
            <input type="number" min="0.01" step="0.01" bind:value={draft.price} />
          </label>
          <label>
            How many
            <input type="number" min="1" step="1" bind:value={draft.quantity} />
          </label>
          <label>
            How long to leave it open
            <select bind:value={draft.durationDays}>
              {#each DURATION_CHOICES as choice (choice.days)}
                <option value={choice.days}>{choice.label}</option>
              {/each}
            </select>
          </label>
        </p>
        {#if draftPriceCheck && !draftPriceCheck.ok && draft.price !== ""}
          <p class="error">{draftPriceCheck.message}</p>
        {/if}
        {#if draftQuantityCheck && !draftQuantityCheck.ok && draft.quantity !== ""}
          <p class="error">{draftQuantityCheck.message}</p>
        {/if}
        {#if draft.side === "sell" && chosenStack !== null && Number(draft.quantity) > chosenStack.quantity}
          <p class="error">
            You only have {chosenStack.quantity} of these to sell.
          </p>
        {/if}
        <p class="controls">
          <button type="button" disabled={busy || !draftReady} onclick={() => (confirming = true)}>
            Check this order…
          </button>
          <button type="button" class="minor" disabled={busy} onclick={closeDraft}>
            Never mind
          </button>
        </p>
      {:else}
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <tbody>
              <tr>
                <th>Item</th>
                <td data-label="Item">
                  <span class="cell-item">
                    <TypeIcon typeID={$market.typeID} name={chosenName || typeName($market.typeID)} />
                    {chosenName || typeName($market.typeID)}
                  </span>
                </td>
              </tr>
              <tr>
                <th>Price for each one</th>
                <td class="num" data-label="Price for each one">
                  {formatIsk(draftPriceCheck?.price.toFixed(2) ?? null)}
                </td>
              </tr>
              <tr>
                <th>How many</th>
                <td class="num" data-label="How many">{draft.quantity}</td>
              </tr>
              <tr>
                <th>That comes to</th>
                <td class="num" data-label="That comes to">{formatIsk(draftValue)}</td>
              </tr>
              <tr>
                <th>{draftFeeWords.heading}</th>
                <td class="num" data-label={draftFeeWords.heading}>
                  {draftFeeWords.before}{formatIsk(draftFee?.amount ?? null)}
                </td>
              </tr>
              <tr>
                <th>Your ISK right now</th>
                <td class="num" data-label="Your ISK right now">{formatIsk($market.cashBalance)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {#if draftFillsNow}
          <p class="note">
            An order that is filled right now, or not at all, pays no broker's fee. Once
            it goes through, the amount you were actually charged is shown here.
          </p>
        {:else if draftFee && !draftFee.estimated}
          <p class="note">
            The broker's fee above is worked out at {draftFeeBasis.rate}, {draftFeeWords.percent}%,
            {draftFeeBasis.madeOf}{draftFee.atMinimum ? "; this order is small enough that the smallest fee there is applies" : ""}.{draftFeeBasis.also}
            Once the order goes through, the amount you were actually charged is
            shown here.
          </p>
        {:else}
          <p class="note">
            The broker's fee above is an <strong>estimate</strong> worked out at the
            standard rate. Your trading skills and your standing with this station's
            owner change what you are really charged, and this app cannot see either
            of them. Once the order goes through, the amount you were actually
            charged is shown here.
          </p>
        {/if}
        <p class="controls">
          <button type="button" class="danger" disabled={busy} onclick={placeOrder}>
            {draft.side === "buy" ? "Yes, place this buy order" : "Yes, place this sell order"}
          </button>
          <button type="button" class="minor" disabled={busy} onclick={() => (confirming = false)}>
            Go back and change it
          </button>
        </p>
      {/if}
    </section>
  {/if}
{/if}

{#if $market.loaded && tab === "orders"}
  <section>
    <h2>Orders you have open</h2>
    {#if $market.ownOrdersError}
      <p class="error">Your orders could not be read: {$market.ownOrdersError}</p>
    {/if}
    {#if openOrders.length === 0}
      <p class="empty">You have no orders open right now.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Item</th>
              <th>Buying or selling</th>
              <th class="num">Price each</th>
              <th class="num">Left</th>
              <th>Where</th>
              <th class="num">Tied up</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each openOrders as order (order.orderID)}
              <tr>
                <td data-label="Item">
                  <span class="cell-item">
                    <TypeIcon typeID={order.typeID} name={typeName(order.typeID)} />
                    {typeName(order.typeID)}
                  </span>
                </td>
                <td data-label="Buying or selling">
                  {order.side === "buy" ? "Buying" : "Selling"}
                </td>
                <td class="num" data-label="Price each">{formatIsk(order.price)}</td>
                <td class="num" data-label="Left">{order.volumeRemaining} of {order.volumeEntered}</td>
                <td data-label="Where">{stationName(order.stationID)} <PlaceRouteMenu {store} {flow} placeID={order.stationID} /></td>
                <td class="num" data-label="Tied up">
                  {order.side === "buy" ? formatIsk(order.escrow) : "—"}
                </td>
                <td data-label="Action">
                  <div class="row-actions">
                    {#if modifyingOrderID === order.orderID}
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        bind:value={modifyPrice}
                        aria-label="New price for each one"
                      />
                      {#if confirmingModify}
                        <button
                          type="button"
                          class="danger"
                          disabled={busy || modifyCheck?.ok !== true}
                          onclick={() => applyModify(order)}
                        >
                          Yes, change the price
                        </button>
                        <button
                          type="button"
                          class="minor"
                          disabled={busy}
                          onclick={() => (confirmingModify = false)}
                        >
                          Go back
                        </button>
                      {:else}
                        <button
                          type="button"
                          disabled={busy || modifyCheck?.ok !== true}
                          onclick={() => (confirmingModify = true)}
                        >
                          Check this change…
                        </button>
                        <button type="button" class="minor" disabled={busy} onclick={closeModify}>
                          Never mind
                        </button>
                      {/if}
                    {:else if cancellingOrderID === order.orderID}
                      <button
                        type="button"
                        class="danger"
                        disabled={busy}
                        onclick={() => cancelOrder(order)}
                      >
                        Yes, take this order down
                      </button>
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => (cancellingOrderID = null)}
                      >
                        Leave it up
                      </button>
                    {:else}
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => startModify(order)}
                      >
                        Change the price…
                      </button>
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => (cancellingOrderID = order.orderID)}
                      >
                        Take it down…
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if modifyingOrderID !== null && confirmingModify}
        <p class="note">
          Changing the price of an order costs a fee, and on a buy order it also
          changes how much ISK is tied up. The exact amount is worked out by the
          server, and what you were actually charged is shown once it goes
          through.
        </p>
      {/if}
      {#if cancellingOrderID !== null}
        <p class="note">
          {cancellingSide === "sell"
            ? "Taking a sell order down puts the goods it still holds back in your hangar at its station."
            : "Taking a buy order down returns the ISK it had tied up."}
          The fee you paid to place it is not returned.
        </p>
      {/if}
    {/if}
  </section>

  {#if $market.orderHistory.length > 0}
    <section>
      <h2>Orders that have finished</h2>
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Item</th>
              <th>Buying or selling</th>
              <th class="num">Price each</th>
              <th>Where</th>
              <th>What happened</th>
              <th>Placed</th>
            </tr>
          </thead>
          <tbody>
            {#each $market.orderHistory as order (order.orderID)}
              <tr>
                <td data-label="Item">
                  <span class="cell-item">
                    <TypeIcon typeID={order.typeID} name={typeName(order.typeID)} />
                    {typeName(order.typeID)}
                  </span>
                </td>
                <td data-label="Buying or selling">
                  {order.side === "buy" ? "Buying" : "Selling"}
                </td>
                <td class="num" data-label="Price each">{formatIsk(order.price)}</td>
                <td data-label="Where">{stationName(order.stationID)}</td>
                <td data-label="What happened">{FILL_STATE_LABELS[order.state]}</td>
                <td data-label="Placed">{dateText(order.issuedAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
{/if}

{#if $market.loaded && tab === "trades"}
  <section>
    <h2>Trades you have made</h2>
    {#if $trades.error}
      <p class="error">Your trades could not be read: {$trades.error}</p>
    {/if}
    {#if !$trades.loaded}
      <p class="empty">Reading your trades…</p>
    {:else if $trades.transactions.length === 0}
      <p class="empty">You have not traded anything yet.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Item</th>
              <th>Bought or sold</th>
              <th class="num">How many</th>
              <th class="num">Price each</th>
              <th>Where</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {#each $trades.transactions as trade (trade.transactionID)}
              <tr>
                <td data-label="Item">
                  <span class="cell-item">
                    <TypeIcon typeID={trade.typeID} name={typeName(trade.typeID)} />
                    {typeName(trade.typeID)}
                  </span>
                </td>
                <td data-label="Bought or sold">
                  {trade.isBuyTransaction ? "You bought" : "You sold"}
                </td>
                <td class="num" data-label="How many">{trade.quantity}</td>
                <td class="num" data-label="Price each">{formatIsk(String(trade.price))}</td>
                <td data-label="Where">{stationName(trade.stationID)}</td>
                <td data-label="When">{dateText(trade.transactionDate)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
{/if}

{#if $market.loaded && tab === "escrow"}
  <section>
    <h2>What your orders have tied up</h2>
    {#if $market.ownOrdersError}
      <p class="note">This could not be read right now.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <tbody>
            <tr>
              <th>ISK held for your buy orders</th>
              <td class="num" data-label="ISK held for your buy orders">
                {formatIsk(tiedUp.isk)}
              </td>
            </tr>
            <tr>
              <th>Goods held for your sell orders</th>
              <td class="num" data-label="Goods held for your sell orders">
                {tiedUp.items}
              </td>
            </tr>
            <tr>
              <th>ISK you can still spend</th>
              <td class="num" data-label="ISK you can still spend">{formatIsk($market.cashBalance)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="note">
        When you offer to buy something, the ISK is set aside straight away and
        held until the order is filled or you take it down. Goods you have
        offered for sale are held the same way.
      </p>
    {/if}
  </section>
{/if}

</div>

<style>
  /* The quickbar (QuickbarItem.Load fades a type the market does not sell), its question and its folders. */
  .qb-type.qb-unsold { opacity: 0.5; }
  .qb-question { border: 1px solid rgba(255, 255, 255, 0.15); padding: 0.5rem 0.75rem; margin: 0.5rem 0; }
  .qb-folder > summary { cursor: pointer; padding: 0.25rem 0; }
  .qb-tree { display: flex; flex-direction: column; }
</style>
