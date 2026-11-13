<script lang="ts">
  // corporation/corp_ui_accounts.py CorpAccounts (Administration > General > Assets, an accountant's): the toggle
  // buttons Offices / Impounded / In Space / Deliveries / Capsuleer deliveries (GetAssetInventory(corpid, which)), the
  // Sort By combo (Name, Number of Jumps, and Number of Items for the deliveries; settings.char corpAssetsSortKey) and the
  // View combo (Current Region, All Regions, then each region the locations are in by name; corpAssetsKeyID_<which>);
  // a locked, closed ListGroup per location labelled "<sec> <location> - <n> Jumps" (LocationAndJumps, LocationNoRoute,
  // the deliveries' LocationDataLabel with the item count), sorted by label and then by the sort key. A location opens
  // to GetAssetInventoryForLocation's items - an office to its eight division groups (flagCorpSAGs, named by
  // GetDivisionNames[division + 1]), each to its own flag's items; an empty one says UnusedCorpOffice (an office) or
  // NoItem. Without Accountant or Junior Accountant: NeedAccountantOrJuniorRole.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorpAssetItem, CorpAssetLocation } from "../app/flow.ts";
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
  const TABS = [["offices", "UI/Corporations/Common/Offices"], ["impounded", A + "Impounded"], ["property", A + "InSpace"], ["deliveries", A + "Deliveries"], ["capsuleerdeliveries", "UI/Corporations/DeliverItem/CapsuleerDeliveries"]] as const;
  const FLAG: Record<string, number> = { offices: 71, impounded: 72, property: 74, deliveries: 75, capsuleerdeliveries: 78 };
  const CORP_SAGS = [115, 116, 117, 118, 119, 120, 121, 184];
  const DIVISION_BY_FLAG: Record<number, number> = { 115: 0, 116: 1, 117: 2, 118: 3, 119: 4, 120: 5, 121: 6, 184: 14 };
  const LABELS = [...TABS.map(([, l]) => l), "UI/Common/SortBy", "UI/Common/View", "UI/Common/Name", "UI/Common/NumberOfJumps", "UI/Common/NumberOfItems", A + "CurrentRegion", A + "AllRegions",
    A + "LocationAndJumps", A + "LocationNoRoute", "UI/Inventory/AssetsWindow/LocationDataLabel", "UI/Inventory/AssetsWindow/LocationDataLabelNoRoute", A + "NoItemsFound", A + "UnusedCorpOffice",
    A + "NeedAccountantOrJuniorRole", "/Carbon/UI/Controls/Common/NoItem", "UI/Common/Quantity", "UI/Inventory/ItemGroup", "UI/Inventory/ItemCategory", ...Object.keys(LINK_WORDS)];
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
    try { read = await flow.corporationAssetLocations(tab); } catch (e) { error = e instanceof Error ? e.message : String(e); }
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
      try { items = { ...items, [row.locationID]: await flow.corporationAssetItems(row.locationID, which) }; }
      catch (e) { error = e instanceof Error ? e.message : String(e); items = { ...items, [row.locationID]: [] }; }
    }
  }
  const typeName = (id: number) => nameOf("type", id) || String(id);
</script>

{#snippet itemRow(item: CorpAssetItem, depth: number)}
  <div class="ca-item" style:padding-left={`${depth * 16}px`}>
    <span class="ca-name"><TypeIcon typeID={item.typeID} name={typeName(item.typeID)} size="sm" /> {typeName(item.typeID)}</span>
    <span class="ca-qty">{item.stacksize.toLocaleString()}</span>
    <span>{nameOf("typeGroup", item.typeID)}</span>
  </div>
{/snippet}

<div class="ca">
  {#if error}<p class="error">{error}</p>{/if}
  <div class="ca-tabs">
    {#each TABS as [id, l] (id)}<button class:active={which === id} onclick={() => void show(id)}>{plainText(text(l))}</button>{/each}
  </div>
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
  <div class="ca-head"><span>{plainText(text("UI/Common/Name"))}</span><span>{plainText(text("UI/Common/Quantity"))}</span><span>{plainText(text("UI/Inventory/ItemGroup"))}</span></div>
  <div class="ca-scroll">
    {#if read && !read.allowed}
      <p class="ca-hint">{plainText(text(A + "NeedAccountantOrJuniorRole"))}</p>
    {:else if read}
      {#each locations as loc (loc.row.locationID)}
        {@const list = items[loc.row.locationID]}
        <button class="ca-group" onclick={() => void toggle(loc.row)}>
          <span class="ca-arrow">{open[`l${loc.row.locationID}`] ? "▾" : "▸"}</span><LabelText markup={loc.label} {followerOf} />
        </button>
        {#if open[`l${loc.row.locationID}`] && list && list !== "loading"}
          {#if list.length === 0}
            <div class="ca-item ca-empty" style:padding-left="16px">{plainText(text(FLAG[which] === 71 ? A + "UnusedCorpOffice" : "/Carbon/UI/Controls/Common/NoItem"))}</div>
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
  .ca-filters { display: flex; gap: 6px; }
  .ca-filters label { display: flex; flex-direction: column; font-size: 10px; width: 140px; }
  .ca-head, .ca-item { display: grid; grid-template-columns: minmax(160px, 2fr) 80px 1fr; gap: 6px; align-items: center; }
  .ca-head { font-size: 10px; opacity: 0.7; padding: 0 4px; }
  .ca-scroll { flex: 1; min-height: 0; overflow: auto; }
  .ca-group { all: unset; cursor: pointer; display: flex; align-items: center; gap: 4px; min-height: 42px; padding: 0 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); width: calc(100% - 8px); }
  .ca-group.ca-sub { min-height: 22px; padding-left: 16px; }
  .ca-arrow { width: 10px; opacity: 0.7; }
  .ca-item { min-height: 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.03); }
  .ca-name { display: flex; align-items: center; gap: 4px; }
  .ca-qty { text-align: right; }
  .ca-empty { opacity: 0.8; }
  .ca-hint { opacity: 0.8; padding: 4px; }
</style>
