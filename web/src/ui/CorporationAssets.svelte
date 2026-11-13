<script lang="ts">
  // corporation/corp_ui_accounts.py CorpAccounts (Administration > General > Assets, an accountant's): the toggle
  // buttons Offices / Impounded / In Space / Deliveries / Capsuleer deliveries (GetAssetInventory(corpid, which)), the
  // Sort By combo (Name, Number of Jumps, and Number of Items for the deliveries; settings.char corpAssetsSortKey) and the
  // View combo (Current Region, All Regions, then each region the locations are in by name; corpAssetsKeyID_<which>);
  // a locked, closed ListGroup per location labelled "<sec> <location> - <n> Jumps" (LocationAndJumps, LocationNoRoute,
  // the deliveries' LocationDataLabel with the item count), sorted by label and then by the sort key. A location opens
  // to GetAssetInventoryForLocation's items - an office to its eight division groups (flagCorpSAGs, named by
  // GetDivisionNames[division + 1]), each to its own flag's items; an empty one says UnusedCorpOffice (an office) or
  // NoItem. Without Accountant or Junior Accountant: NeedAccountantOrJuniorRole. Lockdown: the role check first
  // (NeedAccountantRole), then lockedItems.GetLockedItemLocations as groups, each to its locked items (one each).
  // Search: Where (the five and Asset Safety), category, group and minimum quantity (corp_assets_filter_*), searched at
  // once and on Search: SearchAssets, the locations by name, each to its items that meet the search. Item Type: a
  // market type named exactly so, else DoParseItemType - under three letters ConNeedAtLeastThreeLetters, the text last
  // picked nothing, the types whose name holds it (SelectItemTypeDlg: none ConNoItemsFound, one taken, more a list of
  // ItemTypeLine to pick from), the field then the type's name.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, AssetTypeFacts, CorpAssetItem, CorpAssetLocation } from "../app/flow.ts";
  import { formatNumeric, fmtAmt } from "../bridge/pyNumbers.ts";
  import { iskWords } from "../bridge/questions.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { shownSecurity, securityStatusRgb } from "../bridge/systemSecurity.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import TypeIcon from "./TypeIcon.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const A = "UI/Corporations/Assets/";
  const TABS = [["offices", "UI/Corporations/Common/Offices"], ["impounded", A + "Impounded"], ["property", A + "InSpace"], ["deliveries", A + "Deliveries"], ["capsuleerdeliveries", "UI/Corporations/DeliverItem/CapsuleerDeliveries"], ["lockdown", A + "Lockdown"], ["search", "UI/Common/Search"]] as const;
  const FLAG: Record<string, number> = { offices: 71, impounded: 72, property: 74, deliveries: 75, assetwraps: 76, capsuleerdeliveries: 78 };
  const WHERE = [["offices", "UI/Corporations/Common/Offices"], ["impounded", A + "Impounded"], ["property", A + "InSpace"], ["deliveries", A + "Deliveries"], ["capsuleerdeliveries", "UI/Corporations/DeliverItem/CapsuleerDeliveries"], ["assetwraps", A + "AssetSafety"]] as const;
  const CORP_SAGS = [115, 116, 117, 118, 119, 120, 121, 184];
  const DIVISION_BY_FLAG: Record<number, number> = { 115: 0, 116: 1, 117: 2, 118: 3, 119: 4, 120: 5, 121: 6, 184: 14 };
  const LABELS = [...TABS.map(([, l]) => l), "UI/Common/SortBy", "UI/Common/View", "UI/Common/Name", "UI/Common/NumberOfJumps", "UI/Common/NumberOfItems", A + "CurrentRegion", A + "AllRegions",
    A + "LocationAndJumps", A + "LocationNoRoute", "UI/Inventory/AssetsWindow/LocationDataLabel", "UI/Inventory/AssetsWindow/LocationDataLabelNoRoute", A + "NoItemsFound", A + "UnusedCorpOffice",
    A + "NeedAccountantOrJuniorRole", A + "NeedAccountantRole", A + "AssetSafety", A + "AllCategories", A + "AllGroups", "UI/Common/Where", "UI/Wallet/WalletWindow/MinQty", "UI/Wallet/WalletWindow/ItemType", "UI/Contracts/Util/SelectItemType", "UI/Contracts/Util/ItemTypeLine", "UI/Common/Buttons/OK", "UI/Common/Buttons/Cancel", "UI/Common/Searching", "/Carbon/UI/Controls/Common/NoItem", "UI/Common/Quantity", "UI/Inventory/ItemGroup", "UI/Inventory/ItemCategory", "UI/Inventory/ItemSize", "UI/Inventory/ItemSlot", "UI/Inventory/ItemVolume", "UI/Contracts/ContractsWindow/EstPrice", ...Object.keys(LINK_WORDS)];
  const nameOf = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const text = (label: string, args: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", args as never, { nameOf });
  const followerOf = (url: string, t: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), t);
  // settings.char.ui
  const setting = (key: string): string | null => { try { return localStorage.getItem(`evejs.play.${key}`); } catch { return null; } };
  const setSetting = (key: string, value: string) => { try { localStorage.setItem(`evejs.play.${key}`, value); } catch { /* not kept */ } };

  let which = $state<string>("offices"), error = $state("");
  let read = $state<Awaited<ReturnType<AppFlow["corporationAssetLocations"]>> | null>(null);
  let sortKey = $state(0), regionKey = $state<number>(0);
  let open = $state<Record<string, boolean>>({});
  let items = $state<Record<number, readonly CorpAssetItem[] | "loading">>({});
  // The search's filters as last searched (settings.user.ui corp_assets_filter_*), and the condition its locations
  // open with.
  let searchWhich = $state(setting("corp_assets_filter_type") ?? "offices"), searchCategory = $state<number | null>(Number(setting("corp_assets_filter_categories")) || null);
  let searchGroup = $state<number | null>(Number(setting("corp_assets_filter_groups")) || null), searchQty = $state(setting("corp_assets_filter_quantity") ?? "");
  let itemTypeText = $state(setting("corp_assets_filter_itemtype") ?? ""), parsingItemType: string | null = null;
  let picking = $state<{ rows: readonly { typeID: number; name: string; category: string }[]; selected: number | null; done: (typeID: number | null) => void } | null>(null);
  // The list's answer: its resolver taken before the list is closed.
  function answerPick(typeID: number | null): void { const done = picking?.done; picking = null; done?.(typeID); }
  let categories = $state<readonly { id: number; name: string }[]>([]), groups = $state<readonly { id: number; name: string }[]>([]);
  let condition = $state<{ categoryID: number | null; groupID: number | null; typeID: number | null; qty: number | null; which: string } | null>(null), searching = $state(false);
  // svelte-ignore state_referenced_locally
  const flight = store.flight;

  async function show(tab: string): Promise<void> {
    which = tab; error = ""; read = null; open = {}; items = {};
    // UpdateSortOptions: the key kept, or nought where it is past the options; the region kept per tab.
    const options = tab === "deliveries" || tab === "capsuleerdeliveries" ? 3 : 2;
    const kept = Number(setting("corpAssetsSortKey") ?? "0");
    sortKey = Number.isInteger(kept) && kept >= 0 && kept < options ? kept : 0;
    setSetting("corpAssetsSortKey", String(sortKey));
    regionKey = Number(setting(`corpAssetsKeyID_${tab}`) ?? "0") || 0;
    try {
      if (tab === "lockdown") {
        // ShowLockdown: the sort key and region kept; the role check before the locations are asked.
        sortKey = Number(setting("corpAssetsSortKey") ?? "0") === 1 ? 1 : 0;
        const ctx = await flow.corporationAssetContext();
        read = ctx.allowed ? { ...ctx, rows: await flow.corporationLockedLocations() } : ctx;
      } else if (tab === "search") {
        const ctx = await flow.corporationAssetContext();
        read = { ...ctx, allowed: true };
        if (!categories.length) categories = await flow.corporationAssetCategories();
        if (searchCategory !== null) groups = await flow.corporationAssetGroups(searchCategory);
        await search();
      } else read = await flow.corporationAssetLocations(tab);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
  }
  async function search(): Promise<void> {
    if (!read || searching) return;
    searching = true; open = {}; items = {};
    // Search: a group over a category; the quantity a whole number, nought at least, else None.
    const groupID = searchGroup && searchGroup > 0 ? searchGroup : null, categoryID = groupID === null && searchCategory && searchCategory > 0 ? searchCategory : null;
    // Search: the item type - an exact market type name, else ParseItemType.
    let itemTypeID: number | null = null;
    const typed = itemTypeText;
    if (typed !== "") {
      const found = await flow.marketTypeMatches(typed);
      if (found.exact) itemTypeID = found.exact.typeID;
      else if (typed.length < 3) flow.sayDialog("ConNeedAtLeastThreeLetters", null, "Please type at least three letters.");
      else if (typed !== parsingItemType) {
        if (!found.matches.length) flow.sayDialog("ConNoItemsFound", null, "No items found.");
        else itemTypeID = found.matches.length === 1 ? found.matches[0]!.typeID : await new Promise<number | null>((done) => { picking = { rows: found.matches, selected: null, done }; });
        const picked = found.matches.find((row) => row.typeID === itemTypeID);
        if (picked) { itemTypeText = picked.name; parsingItemType = picked.name; }
      }
    }
    let qty: number | null = /^\s*-?\d+\s*$/.test(searchQty) ? Math.max(0, Number(searchQty)) : null;
    setSetting("corp_assets_filter_type", searchWhich); setSetting("corp_assets_filter_categories", String(categoryID ?? "")); setSetting("corp_assets_filter_groups", String(groupID ?? ""));
    setSetting("corp_assets_filter_quantity", qty === null ? "" : String(qty)); setSetting("corp_assets_filter_itemtype", itemTypeText);
    try {
      const rows = await flow.corporationAssetSearch(searchWhich, categoryID, groupID, itemTypeID, qty);
      condition = { categoryID, groupID, typeID: itemTypeID, qty, which: searchWhich };
      read = { ...read, rows };
    } catch (e) { error = e instanceof Error ? e.message : String(e); } finally { searching = false; }
  }
  async function chooseCategory(id: number | null): Promise<void> {
    searchCategory = id; searchGroup = null;
    groups = id === null ? [] : await flow.corporationAssetGroups(id);
  }
  onMount(() => { flow.requestWords(LABELS); void show("offices"); });

  // GetJumpCountFromCurrent: the autopilot's count from where the pilot is; 0 in the same system, none unreachable.
  const here = $derived($flight.status?.solarSystemID ?? read?.solarSystemID ?? null);
  $effect(() => {
    const systems = [...new Set((read?.rows ?? []).map((r) => r.solarSystemID).filter((id) => id > 0 && id !== here))];
    if (here !== null && systems.length) flow.requestAutopilotJumps(here, systems);
  });
  function jumpsOf(row: CorpAssetLocation): number | null | undefined {
    if (here === null) return undefined;
    if (row.solarSystemID === here) return 0;
    return $names.autopilotJumps[`${here}:${row.solarSystemID}`];
  }
  // solar_system_security_status: the rounded level in its colour.
  function secStatus(systemID: number): string {
    const level = $names.systemSecurity[systemID];
    if (level === undefined || level === null) return "";
    const shown = shownSecurity(level), [r, g, b] = securityStatusRgb(level);
    const hex = [r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
    return `<color=0xff${hex}>${shown.toFixed(1)}</color>`;
  }
  function label(row: CorpAssetLocation): string {
    const jumps = jumpsOf(row), unreachable = jumps === null, args = { location: row.locationID, jumps: jumps ?? 0, itemCount: row.itemCount ?? 0, secStatus: secStatus(row.solarSystemID) };
    if (row.itemCount === null) return text(unreachable ? A + "LocationNoRoute" : A + "LocationAndJumps", args);
    return text(unreachable ? "UI/Inventory/AssetsWindow/LocationDataLabelNoRoute" : "UI/Inventory/AssetsWindow/LocationDataLabel", args);
  }
  const regionOptions = $derived.by(() => {
    if (!read) return [] as { label: string; key: number }[];
    const byLabel = new Map<string, number>();
    for (const row of read.rows) if (row.regionID !== null) byLabel.set(read.regionNames.get(row.regionID) ?? String(row.regionID), row.regionID);
    return [...byLabel.keys()].sort().map((l) => ({ label: l, key: byLabel.get(l)! }));
  });
  const locations = $derived.by(() => {
    if (!read) return [];
    const rows = read.rows.map((row) => ({ row, label: label(row), jumps: jumpsOf(row) ?? -1, name: plainText(text("UI/Common/LocationDynamic", { location: row.locationID })) || nameOf("station", row.locationID) }));
    if (which === "search") return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const shown = rows.filter((r) => regionKey === 1 || (regionKey === 0 ? r.row.regionID === read!.regionID : r.row.regionID === regionKey));
    const cmp = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);
    return shown.sort((a, b) => sortKey === 0 ? cmp(a.name, b.name) : sortKey === 1 ? cmp(a.jumps, b.jumps) : cmp(b.row.itemCount ?? -1, a.row.itemCount ?? -1));
  });
  async function toggle(row: CorpAssetLocation): Promise<void> {
    const key = `l${row.locationID}`;
    open = { ...open, [key]: !open[key] };
    if (open[key] && items[row.locationID] === undefined) {
      items = { ...items, [row.locationID]: "loading" };
      try {
        let list: readonly CorpAssetItem[];
        if (which === "lockdown") list = (await flow.corporationLockedItems(row.locationID)).map((item) => ({ itemID: item.itemID, typeID: item.typeID, flagID: 4, stacksize: 1, singleton: 1, groupID: 0, categoryID: 0 }));
        else if (which === "search" && condition) {
          const c = condition;
          list = (await flow.corporationAssetItems(row.locationID, c.which)).filter((item) => !((c.typeID !== null && c.typeID !== item.typeID) || (c.groupID !== null && c.groupID !== item.groupID) || (c.categoryID !== null && c.categoryID !== item.categoryID) || (c.qty !== null && c.qty > item.stacksize)));
        } else list = await flow.corporationAssetItems(row.locationID, which);
        items = { ...items, [row.locationID]: list };
        const missing = [...new Set(list.map((item) => item.typeID))].filter((id) => !facts.has(id));
        if (missing.length) { const read = await flow.assetTypeFacts(missing); facts = new Map([...facts, ...read]); }
      }
      catch (e) { error = e instanceof Error ? e.message : String(e); items = { ...items, [row.locationID]: [] }; }
    }
  }
  const typeName = (id: number) => nameOf("type", id) || String(id);
  // uix.GetItemData and the default visible columns (GetInvItemDefaultHeaders less the hidden Meta level, Tech level
  // and Category): Name, Quantity, Group, Size, Slot, Volume, Est. Price.
  let facts = $state<ReadonlyMap<number, AssetTypeFacts>>(new Map());
  const SIZES: Record<number, string> = { 1: "UI/InfoWindow/SmallSize", 2: "UI/InfoWindow/MediumSize", 3: "UI/InfoWindow/LargeSize", 4: "UI/InfoWindow/XLargeSize" };
  const SLOTS: Record<number, string> = { 2663: "UI/Inventory/SlotRigs", 12: "UI/Inventory/SlotHigh", 13: "UI/Inventory/SlotMedium", 11: "UI/Inventory/SlotLow" };
  // GetItemQty: nothing for a singleton (or a bookmark), else FmtAmt of the stack.
  const qtyOf = (item: CorpAssetItem) => (item.singleton || item.typeID === 51 ? "" : fmtAmt(item.stacksize));
  // _get_item_size: the charge size in its size class's words.
  const sizeOf = (item: CorpAssetItem) => { const v = facts.get(item.typeID)?.chargeSize; return v === null || v === undefined ? "" : plainText(text(SIZES[Math.trunc(v)] ?? "")); };
  // _get_item_slot: the implant slot, else the booster slot, else the power slot its effects fit.
  const slotOf = (item: CorpAssetItem) => {
    const f = facts.get(item.typeID);
    if (!f) return "";
    if (f.implantness !== null) return String(Math.trunc(f.implantness));
    if (f.boosterness !== null) return String(Math.trunc(f.boosterness));
    return f.slotEffect === null ? "" : plainText(text(SLOTS[f.slotEffect] ?? ""));
  };
  // GetItemVolume (a singleton's type volume, else its packaged one, times the stack) as ValueAndUnit with m3 (dogma unit
  // 9's display name), two places where it has a fraction; none for plastic wrap.
  const volumeOf = (item: CorpAssetItem) => {
    const f = facts.get(item.typeID);
    if (!f || item.typeID === 3468) return "";
    const each = item.singleton ? f.volume : f.packagedVolume;
    if (each === null) return "";
    const volume = each === -1 ? -1 : each * (item.stacksize < 0 ? 1 : item.stacksize);
    const places = Math.abs(volume - Math.trunc(volume)) > 1e-7 ? 2 : 0;
    return plainText(text("UI/InfoWindow/ValueAndUnit", { value: formatNumeric(places ? volume : Math.trunc(volume), { useGrouping: true, decimalPlaces: places }), unit: "m3" }));
  };
  // estPrice: the cfg's average price times the stack (none for a blueprint copy), FmtISK.
  const priceOf = (item: CorpAssetItem) => {
    const price = item.singleton === 2 ? null : facts.get(item.typeID)?.averagePrice ?? null;
    return price && item.stacksize ? iskWords(item.stacksize * price, 2, $words.templates, nameOf) ?? "" : "";
  };
</script>

{#snippet itemRow(item: CorpAssetItem, depth: number)}
  <div class="ca-item" style:padding-left={`${depth * 16}px`}>
    <span class="ca-name"><TypeIcon typeID={item.typeID} name={typeName(item.typeID)} size="sm" /> {typeName(item.typeID)}</span>
    <span class="ca-num">{qtyOf(item)}</span>
    <span>{nameOf("typeGroup", item.typeID)}</span>
    <span>{sizeOf(item)}</span>
    <span>{slotOf(item)}</span>
    <span class="ca-num">{volumeOf(item)}</span>
    <span class="ca-num">{priceOf(item)}</span>
  </div>
{/snippet}

{#if picking}
  {@const p = picking}
  <!-- SelectItemTypeDlg: uix.ListWnd of ItemTypeLine rows, one to pick; OK returns it, Cancel nothing. -->
  <div class="ca-picker" role="dialog" aria-label={plainText(text("UI/Contracts/Util/SelectItemType"))}>
    <div class="ca-picker-title">{plainText(text("UI/Contracts/Util/SelectItemType"))}</div>
    <div class="ca-picker-list">
      {#each p.rows as row, i (row.typeID)}
        <button class:selected={p.selected === i} onclick={() => { picking = { ...p, selected: i }; }} ondblclick={() => answerPick(row.typeID)}>
          {plainText(formatTemplate($words.templates["UI/Contracts/Util/ItemTypeLine"] ?? "{[item]item.name} ({categoryName})", { item: row.typeID, categoryName: row.category } as never, { nameOf: (k, id) => (id === row.typeID ? row.name : nameOf(k, id)) }))}
        </button>
      {/each}
    </div>
    <div class="ca-picker-buttons">
      <button disabled={p.selected === null} onclick={() => answerPick(p.selected === null ? null : p.rows[p.selected]!.typeID)}>{plainText(text("UI/Common/Buttons/OK"))}</button>
      <button onclick={() => answerPick(null)}>{plainText(text("UI/Common/Buttons/Cancel"))}</button>
    </div>
  </div>
{/if}

<div class="ca">
  {#if error}<p class="error">{error}</p>{/if}
  <div class="ca-tabs">
    {#each TABS as [id, l] (id)}<button class:active={which === id} onclick={() => void show(id)}>{plainText(text(l))}</button>{/each}
  </div>
  {#if which === "search"}
    <div class="ca-search">
      <label><span>{plainText(text("UI/Common/Where"))}</span>
        <select value={searchWhich} onchange={(e) => { searchWhich = e.currentTarget.value; }}>{#each WHERE as [id, l] (id)}<option value={id}>{plainText(text(l))}</option>{/each}</select></label>
      <label><span>&nbsp;</span>
        <select value={searchCategory ?? ""} onchange={(e) => void chooseCategory(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}>
          <option value="">{plainText(text(A + "AllCategories"))}</option>{#each categories as c (c.id)}<option value={c.id}>{c.name}</option>{/each}</select></label>
      <label><span>&nbsp;</span>
        <select value={searchGroup ?? ""} onchange={(e) => { searchGroup = e.currentTarget.value === "" ? null : Number(e.currentTarget.value); }}>
          <option value="">{plainText(text(A + "AllGroups"))}</option>{#each groups as g (g.id)}<option value={g.id}>{g.name}</option>{/each}</select></label>
      <label class="ca-type-field"><span>{plainText(text("UI/Wallet/WalletWindow/ItemType"))}</span><input value={itemTypeText} oninput={(e) => { itemTypeText = e.currentTarget.value; }} /></label>
      <label class="ca-qty-field"><span>{plainText(text("UI/Wallet/WalletWindow/MinQty"))}</span><input value={searchQty} oninput={(e) => { searchQty = e.currentTarget.value.replace(/[^\d-]/g, ""); }} /></label>
      <button disabled={searching} onclick={() => void search()}>{plainText(text("UI/Common/Search"))}</button>
    </div>
  {:else}
  <div class="ca-filters">
    <label><span>{plainText(text("UI/Common/SortBy"))}</span>
      <select value={sortKey} onchange={(e) => { sortKey = Number(e.currentTarget.value); setSetting("corpAssetsSortKey", String(sortKey)); }}>
        <option value={0}>{plainText(text("UI/Common/Name"))}</option>
        <option value={1}>{plainText(text("UI/Common/NumberOfJumps"))}</option>
        {#if which === "deliveries" || which === "capsuleerdeliveries"}<option value={2}>{plainText(text("UI/Common/NumberOfItems"))}</option>{/if}
      </select></label>
    <label><span>{plainText(text("UI/Common/View"))}</span>
      <select value={regionKey} onchange={(e) => { regionKey = Number(e.currentTarget.value); setSetting(`corpAssetsKeyID_${which}`, String(regionKey)); }}>
        <option value={0}>{plainText(text(A + "CurrentRegion"))}</option>
        <option value={1}>{plainText(text(A + "AllRegions"))}</option>
        {#each regionOptions as o (o.key)}<option value={o.key}>{o.label}</option>{/each}
      </select></label>
  </div>
  {/if}
  <div class="ca-head">{#each ["UI/Common/Name", "UI/Common/Quantity", "UI/Inventory/ItemGroup", "UI/Inventory/ItemSize", "UI/Inventory/ItemSlot", "UI/Inventory/ItemVolume", "UI/Contracts/ContractsWindow/EstPrice"] as h (h)}<span>{plainText(text(h))}</span>{/each}</div>
  <div class="ca-scroll">
    {#if searching}
      <p class="ca-hint">{plainText(text("UI/Common/Searching"))}</p>
    {:else if read && !read.allowed}
      <p class="ca-hint">{plainText(text(which === "lockdown" ? A + "NeedAccountantRole" : A + "NeedAccountantOrJuniorRole"))}</p>
    {:else if read}
      {#each locations as loc (loc.row.locationID)}
        {@const list = items[loc.row.locationID]}
        <button class="ca-group" onclick={() => void toggle(loc.row)}>
          <span class="ca-arrow">{open[`l${loc.row.locationID}`] ? "▾" : "▸"}</span><LabelText markup={loc.label} {followerOf} />
        </button>
        {#if open[`l${loc.row.locationID}`] && list && list !== "loading"}
          {#if list.length === 0}
            <div class="ca-item ca-empty" style:padding-left="16px">{plainText(text(FLAG[which === "search" ? condition?.which ?? "" : which] === 71 ? A + "UnusedCorpOffice" : "/Carbon/UI/Controls/Common/NoItem"))}</div>
          {:else if which === "offices"}
            {#each CORP_SAGS as flag (flag)}
              {@const key = `d${loc.row.locationID}:${flag}`}
              <button class="ca-group ca-sub" onclick={() => { open = { ...open, [key]: !open[key] }; }}>
                <span class="ca-arrow">{open[key] ? "▾" : "▸"}</span>{read.divisionNames[DIVISION_BY_FLAG[flag]! + 1]}
              </button>
              {#if open[key]}
                {#each list.filter((item) => item.flagID === flag) as item (item.itemID)}{@render itemRow(item, 2)}{/each}
              {/if}
            {/each}
          {:else}
            {#each list as item (item.itemID)}{@render itemRow(item, 1)}{/each}
          {/if}
        {/if}
      {:else}
        <p class="ca-hint">{plainText(text(A + "NoItemsFound"))}</p>
      {/each}
    {/if}
  </div>
</div>

<style>
  .ca { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 4px; gap: 6px; }
  .ca-tabs { display: flex; gap: 2px; flex-wrap: wrap; }
  .ca-tabs button { padding: 2px 10px; }
  .ca-tabs button.active { background: rgba(255, 255, 255, 0.18); }
  .ca-filters, .ca-search { display: flex; gap: 6px; align-items: flex-end; }
  .ca-search label { display: flex; flex-direction: column; font-size: 10px; width: 90px; }
  .ca-search .ca-qty-field { width: 60px; }
  .ca-search .ca-type-field { width: 106px; }
  .ca-picker { position: fixed; left: 50%; top: 30%; transform: translateX(-50%); z-index: 50; width: 320px; max-height: 360px; display: flex; flex-direction: column; background: rgba(12, 14, 16, 0.98); border: 1px solid rgba(255, 255, 255, 0.2); padding: 6px; gap: 6px; }
  .ca-picker-title { font-weight: bold; }
  .ca-picker-list { flex: 1; overflow: auto; display: flex; flex-direction: column; }
  .ca-picker-list button { all: unset; cursor: pointer; padding: 2px 4px; }
  .ca-picker-list button.selected { background: rgba(255, 255, 255, 0.15); }
  .ca-picker-buttons { display: flex; justify-content: center; gap: 6px; }
  .ca-filters label { display: flex; flex-direction: column; font-size: 10px; width: 140px; }
  .ca-head, .ca-item { display: grid; grid-template-columns: minmax(160px, 2fr) 70px 1fr 60px 60px 90px 110px; gap: 6px; align-items: center; }
  .ca-num { text-align: right; }
  .ca-head { font-size: 10px; opacity: 0.7; padding: 0 4px; }
  .ca-scroll { flex: 1; min-height: 0; overflow: auto; }
  .ca-group { all: unset; cursor: pointer; display: flex; align-items: center; gap: 4px; min-height: 42px; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); width: calc(100% - 8px); }
  .ca-group.ca-sub { min-height: 22px; padding-left: 16px; }
  .ca-arrow { width: 10px; opacity: 0.7; }
  .ca-item { min-height: 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.03); }
  .ca-name { display: flex; align-items: center; gap: 4px; }
  .ca-empty { opacity: 0.8; }
  .ca-hint { opacity: 0.8; padding: 4px; }
</style>
