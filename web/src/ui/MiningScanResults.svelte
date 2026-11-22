<script lang="ts">
  import { getContext } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { miningScanInWarp, miningScanRows, MINING_SCANNER_UPGRADE, roundIsk, type MiningScanTypeFacts } from "../bridge/miningScanResults.ts";
  import type { SpaceView } from "../play/spaceView.ts";
  import type { FlightMiningSurvey } from "../play/miningSurveyWave.ts";
  import { fmtDist } from "../space/overview.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { createSignal } from "../store/signals.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import { showInfo } from "./showInfo.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { loadMiningScanSort, miningScanSort } from "./miningScanSort.ts";
  import { clientTexture } from "../play/window.ts";
  import { bracketIcon } from "../play/brackets.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const flightView = getContext<(() => SpaceView | null) | undefined>("flightSpaceView");
  const flightSurvey = getContext<FlightMiningSurvey | undefined>("flightMiningSurvey");
  const waveBusy = flightSurvey?.busy ?? createSignal(false);
  const mining = $derived(store.mining);
  const space = $derived(store.space);
  const names = $derived(store.names);
  const fitting = $derived(store.fitting);
  const targeting = $derived(store.targeting);
  const snapshot = $derived($space.snapshot);
  const upgrade = $derived($fitting.shipAttributes?.[MINING_SCANNER_UPGRADE] ?? 0);
  const inWarp = $derived(miningScanInWarp(snapshot));
  const upgradeTypeID = 444;
  const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  /**
   * The client's formatting of the scan's tier 2 rows (mining_scan_results_window get_entries_tier_2, read through
   * gridcheck): FmtISKAndRound(price x quantity) - RoundISK's three figures, two places ('766,000,000.00 ISK'); the
   * volume ValueAndUnit of FmtAmt(volume, showFraction=0) - the whole part, not rounded - and the unit's 'm3'
   * ('22,999 m3' of 22,999.95); the group's post text EstimatedPricePerSquareMeter of FmtISKAndRound(per m3, False),
   * whole ('52 ISK / m³'), and its label LabelWithLength 'Scordite [38]'.
   */
  const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const cents = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const iskRound = (v: number, places: boolean) => { const r = Math.round(roundIsk(v) * 100) / 100; return `${places ? cents.format(r) : whole.format(Math.round(r))} ISK`; };
  const volumeText = (v: number) => `${whole.format(Math.trunc(v))} m3`;
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, `Type ${id}`);

  let busy = $state(false);
  let facts = $state<ReadonlyMap<number, MiningScanTypeFacts>>(new Map());
  // the group order (sort_groups_by_setting), chosen in the window's header (MiningScanWindowActions)
  const sortStore = miningScanSort;
  $effect(() => { loadMiningScanSort(store.character.get().selectedCharacterID ?? null); });
  const sortGroups = $derived($sortStore);
  flow.requestWords(["UI/Inflight/Scanner/Scan", "UI/Mining/MiningScannerUpgradeRequired", "UI/Mining/NoScanResultsFound"]);
  const words = $derived(store.words);
  const say = (label: string, own: string, args: Record<string, string | number> = {}) => { const t = $words.templates[label]; return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args as never, { nameOf: () => null } as never)) : own; };
  let collapsed = $state<ReadonlySet<number>>(new Set());
  let colSort = $state<number | null>(null);
  let colReversed = $state(false);
  function sortByColumn(k: number): void { if (colSort === k) colReversed = !colReversed; else { colSort = k; colReversed = false; } }
  const COLUMNS = [["UI/Common/Ore", "Ore"], ["UI/Common/Quantity", "Quantity"], ["UI/Common/Volume", "Volume"], ["UI/Common/Value", "Value"], ["UI/Common/Distance", "Distance"]] as const;
  flow.requestWords(COLUMNS.map((c) => c[0]));
  const rows = $derived(miningScanRows($mining.survey, snapshot, facts));
  const groups = $derived.by(() => {
    const byType = new Map<number, typeof rows>();
    for (const row of rows) {
      const group = byType.get(row.typeID);
      if (group) group.push(row);
      else byType.set(row.typeID, [row]);
    }
    // the scroll's headers sort each group's entries by their sort_ values (quantity, volume, value, distance; the
    // name as the label), a second click on the same header the other way
    const key = (row: (typeof rows)[number]): number | string => colSort === 1 ? row.quantity ?? -1 : colSort === 2 ? row.volume ?? -1
      : colSort === 3 ? row.value ?? -1 : colSort === 4 ? row.distance ?? Infinity : typeName(row.typeID).toLowerCase();
    const ordered = (list: typeof rows) => colSort === null ? list : [...list].sort((a, b) => {
      const x = key(a), y = key(b);
      const c = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x - y;
      return colReversed ? -c : c;
    });
    return Array.from(byType, ([typeID, rows]) => ({
      typeID, name: typeName(typeID), rows: ordered(rows),
      icon: bracketIcon({ typeID, groupID: rows[0]?.groupID ?? null, categoryID: 25 }),
      groupID: rows[0]?.groupID ?? Infinity,
      pricePerM3: rows.find(row => row.pricePerM3 !== null)?.pricePerM3 ?? null,
    })).sort((a, b) => {
      if (sortGroups === "type") return a.groupID - b.groupID || a.typeID - b.typeID;
      if (sortGroups === "value") return (b.pricePerM3 ?? -Infinity) - (a.pricePerM3 ?? -Infinity) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
  });

  $effect(() => {
    const ids = [...new Set($mining.survey.flatMap(row => row.yieldTypeID === null ? [] : [row.yieldTypeID]))];
    flow.requestNames([upgradeTypeID, ...ids].map(id => ({ kind: "type", id })));
    let current = true;
    void flow.miningScanFacts(ids).then(result => { if (current) facts = result; }).catch(() => {});
    return () => { current = false; };
  });

  async function scan() {
    busy = true;
    try {
      if (flightSurvey) await flightSurvey.scan();
      else await flow.runSurveyScan();
    }
    catch { /* The flow handles session loss and presents scanner errors. */ }
    finally { busy = false; }
  }

  function toggleGroup(typeID: number) {
    const next = new Set(collapsed);
    if (next.has(typeID)) next.delete(typeID);
    else next.add(typeID);
    collapsed = next;
  }
</script>

<section class="mining-scan-results" aria-label="Mining Scan Results">
  {#if inWarp}<p class="status">Mining scans are unavailable while warping.</p>{/if}
  {#if $mining.surveyError}<p role="alert" class="status">{$mining.surveyError}</p>{/if}
  <div class="scan-table">
    <table>
      <thead><tr>{#each COLUMNS as [label, own], k (label)}<th scope="col" class:sorted={colSort === k} onclick={() => sortByColumn(k)}>{say(label, own)}{#if colSort === k}<span class="dir" class:down={colReversed}></span>{/if}</th>{/each}</tr></thead>
      {#each groups as group (group.typeID)}
        <tbody data-ore-type={group.typeID}>
          <tr class="ore-group"><th colspan="5" scope="rowgroup">
            <button type="button" aria-expanded={!collapsed.has(group.typeID)} onclick={() => toggleGroup(group.typeID)}>
              <span aria-hidden="true">{collapsed.has(group.typeID) ? "▸" : "▾"}</span>
              <!-- the ListGroup's iconID: the type's bracket icon (bracket.GetBracketIcon) -->
              {#if group.icon}<img class="group-icon" src={group.icon} alt="" />{:else}<TypeIcon typeID={group.typeID} name={group.name} size="sm" />{/if}
              <span>{group.name} [{group.rows.length}]</span>
              {#if group.pricePerM3 !== null && group.pricePerM3 > 0}<span class="price">{iskRound(group.pricePerM3, false)} / m³</span>{/if}
            </button>
          </th></tr>
          {#if !collapsed.has(group.typeID)}
            {#each group.rows as row (row.itemID)}
              {@const locked = $targeting.lockedTargetIDs?.includes(row.itemID) ?? false}
              {@const acquiring = !locked && ($targeting.acquiringTargetIDs?.includes(row.itemID) ?? false)}
              <!-- MiningScanEntry: hover the rock's mouseOver state, right-click its CelestialMenu (the space menu), click
                   ExecuteCombatCommand then select (the view's select runs a held combat command); its TargetIconCont
                   (2, 0, 16 x 16) the activeTarget icon when locked, the shrinking targetFrame while locking -->
              <tr data-rock-id={row.itemID}
                onmouseenter={() => flightView?.()?.hoverObject(row.itemID)}
                onmouseleave={() => flightView?.()?.hoverObject(null)}
                oncontextmenu={(e) => { e.preventDefault(); dispatchEvent(new CustomEvent("evejs:open-space-menu", { detail: { itemID: row.itemID, x: e.clientX, y: e.clientY } })); }}>
                <td>
                  <span class="tgt-icon">{#if locked}<img src={clientTexture("res:/UI/Texture/classes/Bracket/activeTarget.png")} alt="" />{:else if acquiring}<span class="tgt-frame" style:border-image-source={`url(${clientTexture("res:/UI/Texture/classes/Bracket/targetFrame.png")})`}></span>{/if}</span>
                  {#if flightView}
                    <button type="button" class="rock" onclick={() => flightView()?.selectObjectiveTarget(row.itemID)} aria-label={`Select ${group.name}${locked ? ", locked target" : ""}`}>
                      {group.name}
                    </button>
                  {:else}{group.name}{/if}
                </td>
                <td>{row.quantity === null ? "-" : row.quantity.toLocaleString()}</td>
                <td>{row.volume === null ? "-" : volumeText(row.volume)}</td>
                <td>{row.value === null ? "-" : iskRound(row.value, true)}</td>
                <td>{fmtDist(row.distance)}</td>
              </tr>
            {/each}
          {/if}
        </tbody>
      {/each}
    </table>
    <!-- the scroll's noContentHint, UI/Mining/NoScanResultsFound -->
    {#if groups.length === 0}<p class="status">{say("UI/Mining/NoScanResultsFound", "No Scan Results Found")}</p>{/if}
  </div>
  <!-- construct_layout's bottom_cont (WindowSegmentUnderlay): under a tier below 2 the WarningContainer of
       UI/Mining/MiningScannerUpgradeRequired (its module the Survey Scanner's link), then the ButtonGroup's Scan -->
  <div class="scan-bottom">
    {#if upgrade <= 0}
      <p class="upgrade"><button type="button" class="link" onclick={() => showInfo({ kind: "type", typeID: upgradeTypeID })}>{say("UI/Mining/MiningScannerUpgradeRequired", `Fit ${typeName(upgradeTypeID)} to reveal ore quantities.`, { module_name: typeName(upgradeTypeID) })}</button></p>
    {/if}
    <div class="scan-buttons"><button class="scan-button client-btn" type="button" onclick={scan} disabled={busy || $waveBusy || inWarp || !snapshot?.inSpace}>{say("UI/Inflight/Scanner/Scan", "Scan")}</button></div>
  </div>
</section>

<style>
  .group-icon { width: 16px; height: 16px; }
  thead th { cursor: pointer; user-select: none; }
  thead th .dir { display: inline-block; margin-left: 4px; border: 4px solid transparent; border-bottom-color: currentColor; vertical-align: 2px; }
  thead th .dir.down { border-bottom-color: transparent; border-top-color: currentColor; vertical-align: -2px; }
  .tgt-icon { display: inline-flex; width: 16px; height: 16px; margin: 0 4px 0 2px; vertical-align: middle; align-items: center; justify-content: center; }
  .tgt-icon img { width: 16px; height: 16px; }
  .tgt-frame { width: 22px; height: 22px; opacity: 0.75; border-style: solid; border-width: 4px; border-image-slice: 4; animation: tgt-shrink 0.4s linear infinite; }
  @keyframes tgt-shrink { from { width: 22px; height: 22px; } to { width: 12px; height: 12px; } }
  .scan-bottom { margin: 0 -0.65rem -0.65rem; padding: 4px 0.65rem 0.65rem; background: rgba(255, 255, 255, 0.04); }
  .scan-buttons { display: flex; justify-content: center; padding-top: 4px; }
  .upgrade .link { all: unset; cursor: pointer; }
  section { display: flex; flex-direction: column; min-height: 0; height: 100%; padding: 0.65rem; gap: 0.55rem; color: #e0e9ed; }
  .scan-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.65rem; }
  label { display: flex; align-items: center; gap: 0.45rem; font-size: 0.8rem; }
  select, .scan-button { color: inherit; background: #24353d; border: 1px solid #47616b; padding: 0.3rem 0.55rem; }
  .scan-button { min-width: 5rem; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.55; cursor: default; }
  .scan-table { overflow: auto; flex: 1; min-height: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  td, th { padding: 0.28rem 0.42rem; text-align: right; border-bottom: 1px solid #34444a; white-space: nowrap; tab-size: 4; }
  th:first-child, td:first-child { text-align: left; }
  thead th { color: #bdd1d9; position: sticky; top: 0; background: #263239; }
  tbody th { padding: 0; background: #21363f; }
  tbody button, .upgrade button { background: transparent; border: 0; color: inherit; }
  tbody th button { display: flex; align-items: center; gap: 0.4rem; width: 100%; padding: 0.26rem 0.42rem; text-align: left; }
  tbody button:hover, .upgrade button:hover { color: #8ad0e3; }
  .price { margin-left: auto; color: #bdd1d9; font-weight: normal; }
  .rock { padding: 0 0 0 0.7rem; }
  .locked { color: #8ad0e3; }
  .status, .upgrade { margin: 0; color: #c0d3d9; font-size: 0.8rem; }
  .status { padding: 0.45rem 0; }
  .upgrade { padding: 0.55rem 0.4rem; background: #292a21; border-left: 2px solid #b89b58; }
  .upgrade button { padding: 0; text-decoration: underline; }
</style>
