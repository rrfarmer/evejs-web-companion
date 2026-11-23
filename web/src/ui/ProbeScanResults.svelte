<script lang="ts">
  import { getContext } from "svelte";
  import { resultColor } from "../bridge/probeResults.ts";
  import { selectedSites, selectSite, setSelectedSites } from "../app/probeSiteSelection.ts";
  // The probe scanner's results (bridge/probeResults.ts): the session's system's results as the client's scan handler
  // keeps them from OnSystemScanStopped, listed as its results scroll lists them (scanResults.py, ScanResultNew):
  // distance from the ship, ID, name, group and signal strength, by ID; the client's words for "no results" where
  // there are none. Plain text: no icon, no colour by certainty, no Warp To button for a perfect result yet.
  //
  // A row's menu has the client's two orders of its own (scanResults.result_menu, 188 and 189): Ignore Result and
  // Ignore Other Results, the row the menu is on (the client's selected rows, or that one). The ignored are left out
  // of the list and counted in the ignored box, shown where there is one (scannerToolsUIComponents.IgnoredBox, 121 to
  // 129), which lists each by "id (name)" to be shown again, and Clear All Ignored Results where there are two or
  // more (probeScannerPalette.LoadIgnoredTooltipPanel, 492 to 537). None of it is asked of the server.
  import { onMount } from "svelte";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import ProbeFilterEditor from "./ProbeFilterEditor.svelte";
  import { ASKED_KEEPING_YES, DO_NOT_ASK_AGAIN_LABEL, suppressableKey } from "../bridge/dialogSuppression.ts";
  import {
    MAX_CUSTOM_RESULT_FILTERS,
    MIN_WARP_DISTANCE,
    type CustomResultFilter,
    PROBE_RESULT_LABELS,
    PROBE_RESULT_WORD_LABELS,
    SCAN_GROUP,
    STANDARD_RESULT_FILTERS,
    isAccurate,
    resultRows,
    splitResults,
    type Vec3,
  } from "../bridge/probeResults.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { WARP_RANGES } from "./flyingDistances.ts";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import { fmtDist } from "../space/overview.ts";
  import { nameKey, type NameKind } from "../store/names.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { noticeBoard } from "./notices.ts";
  import { scrollListHomeEnd } from "./scrollColumnFit.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const warpDistance = flow.warpDistance;
  // svelte-ignore state_referenced_locally
  const scanner = store.scanner;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const space = store.space;

  const held = $derived($scanner.probeResults);
  /** On the play page the rows as scannerListEntries.ScanResultNew draws them (the icon, the bar, the warp button). */
  const retail = getContext("retailChrome") === true;

  // The distances are from the ship, as the space read has it (michelle.GetMyPosition). This window shows live space
  // data, so it claims the space feed as every such window does (HudBar, SpaceOverview): on a screen with no HUD (the
  // phone's layout) nothing else asked, and no distance was shown (seen 2026-10-15).
  onMount(() => {
    void flow.loadSpaceSnapshot().catch(() => {});
    flow.startSpacePolling();
    return () => flow.stopSpacePolling();
  });

  $effect(() => {
    flow.requestWords([
      ...PROBE_RESULT_WORD_LABELS, "UI/Common/EntriesCopied",
      ...STANDARD_RESULT_FILTERS.map((each) => each.label),
      ...["DeleteFilter", "TooManyFilters"].flatMap((dialog) => [`dialog:${dialog}/title`, `dialog:${dialog}/body`, suppressableKey(dialog)]),
      DO_NOT_ASK_AGAIN_LABEL,
    ]);
  });
  // What the rows are named with: a type's name, a group's name, an exploration site's dungeon name.
  $effect(() => {
    const results = held?.results ?? [];
    const refs: Array<{ kind: NameKind; id: number }> = [];
    const messages: string[] = [];
    for (const result of results) {
      const site = result.scanGroupID === SCAN_GROUP.signatures || result.scanGroupID === SCAN_GROUP.anomalies;
      if (site && result.dungeonNameID !== null) messages.push(`#${result.dungeonNameID}`);
      if (!site && result.typeID !== null) refs.push({ kind: "type", id: result.typeID });
      if (!site && result.groupID !== null) refs.push({ kind: "group", id: result.groupID });
    }
    if (refs.length > 0) flow.requestNames(refs);
    if (messages.length > 0) flow.requestWords(messages);
  });

  const word = (label: string, args: Record<string, string | number> = {}): string | null => {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf: () => "" })).trim() : null;
  };
  const nameOf = (kind: NameKind, id: number): string | null => {
    const name = $names.resolved[nameKey(kind, id)];
    return typeof name === "string" && name.trim() !== "" ? name : null;
  };
  // michelle.GetMyPosition: the ship's own ball, as the page's space read has it.
  const myPosition = $derived.by((): Vec3 | null => {
    const position = $space.snapshot?.ship?.position ?? null;
    return position === null ? null : [position.x, position.y, position.z];
  });
  const wording = {
    words: word,
    typeName: (typeID: number) => nameOf("type", typeID),
    groupName: (groupID: number) => nameOf("group", groupID),
    messageText: (messageID: number) => word(`#${messageID}`),
  };
  const ignoredIDs = $derived(new Set((held?.ignored ?? []).map((result) => result.id)));
  // scanHandler.GetResults: the ignored left out, and counted.
  // scanHandler.GetResults: the ignored and the filtered left out, and counted (bridge/probeResults.ts splitResults).
  const split = $derived(held === null ? null : splitResults(held.results, ignoredIDs, held.filter));
  const rows = $derived(split === null ? [] : resultRows(split.shown, myPosition, wording));
  const ignoredCount = $derived(split?.ignored ?? 0);
  // The filtered box (ShowFilteredAndIgnored, 816 to 818): the filtered and the anomalies left out, together.
  const filteredCount = $derived(split === null ? 0 : split.filtered + split.anomaliesFiltered);
  let filterOpen = $state(false);

  // The pilot's own filters: the editor (undefined while closed, null for a new filter), the delete asked, and the
  // panel's refusal (TooManyFilters).
  let editorFor = $state<CustomResultFilter | null | undefined>(undefined);
  let deleting = $state<CustomResultFilter | null>(null);
  let dontAskAgain = $state(false);
  let filterNotice = $state<string | null>(null);
  function dialogWord(dialog: string, part: "title" | "body", own: string, args: Record<string, string | number> = {}): string {
    return word(`dialog:${dialog}/${part}`, args) ?? plainText(formatTemplate(own, args, { nameOf: () => "" }));
  }
  // AddFilter (45 to 52): no more than twenty-five of the pilot's own (TooManyFilters).
  function createFilter(): void {
    filterNotice = null;
    if (held !== null && held.filter.custom.length >= MAX_CUSTOM_RESULT_FILTERS) {
      filterNotice = dialogWord("TooManyFilters", "body", "You have as many filters as you can keep.");
      return;
    }
    editorFor = null;
  }
  // DeleteFilter (553 to 560): asked with suppress=ID_YES, Yes kept where the box was ticked.
  function askDelete(custom: CustomResultFilter): void {
    filterNotice = null;
    if (ASKED_KEEPING_YES.has("DeleteFilter") && flow.dialogYesKept("DeleteFilter")) {
      flow.deleteProbeResultFilter(custom.id);
      return;
    }
    dontAskAgain = false;
    deleting = custom;
  }
  function answerDelete(yes: boolean): void {
    const asked = deleting;
    deleting = null;
    if (asked === null || !yes) return;
    if (dontAskAgain) flow.keepDialogYes("DeleteFilter");
    flow.deleteProbeResultFilter(asked.id);
  }
  // scanSvc.GetIgnoredResultsDesc: each ignored one held, by ID, with its name.
  const ignoredRows = $derived(held === null ? [] : resultRows(held.ignored, myPosition, wording));

  let menuFor = $state<string | null>(null);
  // Scroll.OnUp / OnDown (BrowseNodes): with nothing selected the last / first result; else the one past the selection
  // (its last going down, its first going up), Shift growing the range from where it began, past either end nothing;
  // ActivateIdx selects it (the scroll's selection, SetSelectedSites) and brings it into view
  let browseAnchor: string | null = null;
  function browse(up: boolean, shift: boolean, from: HTMLElement): void {
    const order = rows.map((row) => row.id);
    if (!order.length) return;
    const sel = order.map((id, i) => ($selectedSites.has(id) ? i : -1)).filter((i) => i >= 0);
    let idx: number;
    const anchorAt = browseAnchor === null ? -1 : order.indexOf(browseAnchor);
    if (!sel.length) idx = up ? order.length - 1 : 0;
    else if (shift && anchorAt >= 0) idx = (sel[0]! < anchorAt ? sel[0]! : sel[sel.length - 1]!) + (up ? -1 : 1);
    else idx = (sel.length > 1 ? sel[up ? 0 : sel.length - 1]! : sel[0]!) + (up ? -1 : 1);
    if (idx < 0 || idx >= order.length) return;
    if (shift && sel.length && anchorAt >= 0) setSelectedSites(order.slice(Math.min(anchorAt, idx), Math.max(anchorAt, idx) + 1));
    else { setSelectedSites([order[idx]!]); browseAnchor = order[idx]!; }
    const tr = from.closest("tbody")?.querySelectorAll<HTMLElement>("tr.ps-row")[idx];
    tr?.focus({ preventScroll: true });
    tr?.scrollIntoView({ block: "nearest" });
  }
  // Scroll.Copy (Ctrl+C on the list): the selected results' ScanResultNew.GetCopyData - id, scan group, group, type,
  // the certainty as UI/Common/Percentage, the distance (FmtDist) - every result where none is selected, one a line,
  // tab-separated; then UI/Common/EntriesCopied
  async function copyResults(): Promise<void> {
    const chosen = rows.filter((row) => $selectedSites.has(row.id));
    const list = chosen.length ? chosen : rows;
    if (!list.length) return;
    const text = list.map((row) => [row.id, row.scanGroupName, row.group, row.typeName, row.copyPercent, row.distance === null ? "" : fmtDist(row.distance)].join("\t")).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      noticeBoard.post({ kind: "info", title: word("UI/Common/EntriesCopied", { numEntries: list.length }) ?? `Copied ${list.length} entries to clipboard` });
    } catch { /* the clipboard refused */ }
  }
  let ignoredOpen = $state(false);

  // An accurate result's warp (scanSvc.GetScannedDownMenu): offered where it is farther off than a warp's least
  // distance (michelle.IsPositionWithinWarpDistance); Warp To at the pilot's own warp distance (the Settings' "Warp to
  // within"), and Warp to Within at one of the seven (movementFunctions.GetWarpToRanges, 334 to 343).
  const accurateIDs = $derived(new Set((held?.results ?? []).filter(isAccurate).map((result) => result.id)));
  const defaultWarp = $derived($warpDistance || 0);
  let warpListFor = $state<string | null>(null);
  // Bookmark Location (GetScannedDownMenu): the bookmark window for the result, its default name "id name"
  // (bookmarkData.name, '%s %s' % (targetID, scanResultName)).
  let bookmarking = $state<{ readonly resultID: string; readonly name: string } | null>(null);
  let actionError = $state<string | null>(null);
  // Align To, in any accurate result's menu (GetAlignToMenu, whatever the distance).
  async function alignTo(resultID: string): Promise<void> {
    menuFor = null;
    actionError = null;
    try {
      await flow.alignToProbeResult(resultID);
    } catch (cause) {
      actionError = panelErrorWords(cause);
    }
  }
  async function warpTo(resultID: string, range: number): Promise<void> {
    menuFor = null;
    warpListFor = null;
    actionError = null;
    try {
      await flow.warpToProbeResult(resultID, range);
    } catch (cause) {
      actionError = panelErrorWords(cause);
    }
  }
  // ScanResults' ScrollColumnHeader (settingsID probescannerwindow_resultScrollList, ScanResultNew's columns): Distance, ID
  // and Name scalable - a 4 px scaler at each header's top right dragged to a width no narrower than the column's own
  // (GetColumnsMinSize 50 / 30 / 70), kept (RegisterCurrentSizes); a double-click puts the column back to its
  // GetColumnsDefaultSize (70 / 60 / 100: OnColumnSizeReset). Group stretches; the icon (16) and Signal Strength (60) are fixed.
  const SCALABLE = [
    { key: "distance", own: "Distance", min: 50, def: 70 },
    { key: "id", own: "ID", min: 30, def: 60 },
    { key: "name", own: "Name", min: 70, def: 100 },
  ] as const;
  type Scalable = (typeof SCALABLE)[number];
  const WIDTHS_KEY = "evejs.ui.columnWidths.probescannerwindow_resultScrollList";
  let colWidths = $state<Record<string, number>>((() => { try { const v = JSON.parse(globalThis.localStorage?.getItem(WIDTHS_KEY) ?? "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; } })());
  function keepWidths(next: Record<string, number>): void {
    colWidths = next;
    try { globalThis.localStorage?.setItem(WIDTHS_KEY, JSON.stringify(next)); } catch { /* lasts the page */ }
  }
  function startScale(col: Scalable, e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
    const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
    if (w0 <= 0) return;
    const move = (m: PointerEvent) => { colWidths = { ...colWidths, [col.key]: Math.max(col.min, Math.round(w0 + m.clientX - x0)) }; };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); keepWidths({ ...colWidths }); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  }
  function resetWidth(col: Scalable): void { keepWidths({ ...colWidths, [col.key]: col.def }); }
</script>

{#if held !== null}
  <section class="probe-results" class:ps-retail={retail}>
    {#if retail}<span class="ps-caption">{word(PROBE_RESULT_LABELS.scanResults) ?? "Scan Results"}</span>
      <!-- ConstructFilterCont's solarSystemMapButton (24 wide, solarSystem.png, btnSolarsystemMap): MapBtnClicked -->
      <button type="button" class="ps-map" title={word("UI/Map/MapPallet/btnSolarsystemMap") ?? "Solar System Map"}
        onclick={() => window.dispatchEvent(new CustomEvent("evejs:toggle-solar-system-map"))}><img alt="" src="/client-res/ui/texture/shared/brackets/solarsystem.png" /></button>{/if}
    <!-- The filtered box and its panel, "Show results for" (_LoadFilterTooltipPanel, 445 to 480): the anomalies' box
         and each standard filter's. -->
    <div class="ignored-box">
      <button type="button" class="minor" aria-expanded={filterOpen} onclick={() => (filterOpen = !filterOpen)}>
        {word(PROBE_RESULT_LABELS.filtered, { noFiltered: filteredCount }) ?? `${filteredCount} Filtered`}
      </button>
      {#if filterOpen}
        <fieldset class="filter-panel">
          <legend>{word(PROBE_RESULT_LABELS.showResultsFor) ?? "Show results for"}</legend>
          <label><input type="checkbox" checked={held.filter.showingAnomalies}
            onchange={(event) => flow.setShowingProbeAnomalies(event.currentTarget.checked)} />
            {word(PROBE_RESULT_LABELS.anomalies) ?? "Anomalies"}</label>
          {#each STANDARD_RESULT_FILTERS as standard (standard.id)}
            <label><input type="checkbox" checked={held.filter.active.includes(standard.id)}
              onchange={(event) => flow.setProbeResultFilterActive(standard.id, event.currentTarget.checked)} />
              {word(standard.label) ?? standard.label.split("/").at(-1)}</label>
          {/each}
          <!-- The pilot's own filters, each with its box, edit and delete (_LoadFilterTooltipPanel, 470 to 477). -->
          {#each held.filter.custom as custom (custom.id)}
            <span class="custom-filter">
              <label><input type="checkbox" checked={held.filter.active.includes(custom.id)}
                onchange={(event) => flow.setProbeResultFilterActive(custom.id, event.currentTarget.checked)} /> {custom.name}</label>
              <button type="button" class="minor" onclick={() => { editorFor = custom; filterNotice = null; }}>Edit</button>
              <button type="button" class="minor" onclick={() => askDelete(custom)}>Delete</button>
            </span>
          {/each}
          <button type="button" class="minor" onclick={createFilter}>{word(PROBE_RESULT_LABELS.createNewFilter) ?? "Create New Filter"}</button>
          {#if deleting !== null}
            <!-- DeleteFilter (553 to 560), asked keeping Yes. -->
            <span class="filter-question" role="alertdialog">
              <strong>{dialogWord("DeleteFilter", "title", "Delete?")}</strong>
              <span>{dialogWord("DeleteFilter", "body", "Delete the filter {filterName}?", { filterName: deleting.name })}</span>
              {#if $words.templates[suppressableKey("DeleteFilter")] === "1"}
                <label><input type="checkbox" bind:checked={dontAskAgain} /> {word(DO_NOT_ASK_AGAIN_LABEL) ?? "Skip this question from now on"}</label>
              {/if}
              <button type="button" onclick={() => answerDelete(true)}>{word(PROBE_RESULT_LABELS.yes) ?? "Yes"}</button>
              <button type="button" class="minor" onclick={() => answerDelete(false)}>{word(PROBE_RESULT_LABELS.no) ?? "No"}</button>
            </span>
          {/if}
          {#if filterNotice !== null}
            <span class="error">{filterNotice}</span>
          {/if}
        </fieldset>
      {/if}
      {#if editorFor !== undefined}
        <ProbeFilterEditor {store} {flow} editing={editorFor} settings={held.filter} onDone={() => (editorFor = undefined)} />
      {/if}
    </div>
    {#if ignoredCount > 0 || ignoredRows.length > 0}
      <div class="ignored-box">
        <button type="button" class="minor" title={word(PROBE_RESULT_LABELS.resetIgnored) ?? "Show ignored results again"}
          aria-expanded={ignoredOpen} onclick={() => (ignoredOpen = !ignoredOpen)}>
          {word(PROBE_RESULT_LABELS.ignored, { noIgnored: ignoredCount }) ?? `${ignoredCount} Ignored`}
        </button>
        {#if ignoredOpen}
          <ul class="ignored-list">
            {#if ignoredRows.length > 1}
              <li><button type="button" class="minor" onclick={() => { flow.clearIgnoredProbeResults(); ignoredOpen = false; }}>
                {word(PROBE_RESULT_LABELS.clearAllIgnored) ?? "Clear All Ignored Results"}
              </button></li>
            {/if}
            {#each ignoredRows as ignoredRow (ignoredRow.id)}
              <li><button type="button" class="minor" onclick={() => flow.showIgnoredProbeResult(ignoredRow.id)}>
                {ignoredRow.name
                  ? word(PROBE_RESULT_LABELS.resultIdAndDesc, { id: ignoredRow.id, desc: ignoredRow.name }) ?? `${ignoredRow.id} (${ignoredRow.name})`
                  : ignoredRow.id}
              </button></li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    {#if rows.length === 0}
      <p class="note">{word(PROBE_RESULT_LABELS.noResults) ?? "No signatures or anomalies in current system"}</p>
    {:else}
      <table class="guests">
        <thead>
          <tr>
            {#if retail}<th class="ps-ic"></th>{/if}
            {#each SCALABLE as col (col.key)}
              <th style:width={retail && colWidths[col.key] ? `${colWidths[col.key]}px` : null}>{word(PROBE_RESULT_LABELS[col.key]) ?? col.own}{#if retail}<span class="ps-scaler" role="separator" aria-orientation="vertical"
                onpointerdown={(e) => startScale(col, e)} onclick={(e) => e.stopPropagation()} ondblclick={(e) => { e.stopPropagation(); resetWidth(col); }}></span>{/if}</th>
            {/each}
            <th>{word(PROBE_RESULT_LABELS.group) ?? "Group"}</th>
            <th class="num">{word(PROBE_RESULT_LABELS.signalStrength) ?? "Signal"}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr class:ps-row={retail} class:ps-selected={retail && $selectedSites.has(row.id)}
              onclick={retail ? (event) => { if ((event.target as HTMLElement).closest("button")) return; selectSite(row.id, event.shiftKey || event.ctrlKey); browseAnchor = row.id; (event.currentTarget as HTMLElement).focus({ preventScroll: true }); } : undefined}
              style={retail ? `--cert: ${resultColor(row.certainty)}; --base: ${Math.min(row.certainty, row.prevCertainty) * 100}%; --change: ${Math.abs(row.certainty - row.prevCertainty) * 100}%` : undefined}
              tabindex={retail ? -1 : undefined}
              onkeydown={retail ? (event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") { event.preventDefault(); event.stopPropagation(); void copyResults(); } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); event.stopPropagation(); setSelectedSites(rows.map((x) => x.id)); } else if (event.key === "Home" || event.key === "End") { event.preventDefault(); event.stopPropagation(); scrollListHomeEnd(event.currentTarget as HTMLElement, event.key === "End"); } else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); browse(event.key === "ArrowUp", event.shiftKey, event.currentTarget as HTMLElement); } } : undefined}
              oncontextmenu={retail ? (event) => { event.preventDefault(); if (!$selectedSites.has(row.id)) selectSite(row.id, false); menuFor = menuFor === row.id ? null : row.id; } : undefined}>
              {#if retail}<td class="ps-ic"><span class="ps-result-icon" style={`--icon: url(/client-res/${row.icon})`}></span></td>{/if}
              <td class="num">{row.distance === null ? "" : fmtDist(row.distance)}</td>
              <td>{row.id}</td>
              <td>{row.name}</td>
              <td>{row.group}</td>
              <td class="num">
                {#if retail && row.isPerfect && accurateIDs.has(row.id) && row.distance !== null && row.distance > MIN_WARP_DISTANCE}
                  <button type="button" class="ps-warp" title={word(PROBE_RESULT_LABELS.warpTo) ?? "Warp To"} onclick={() => warpTo(row.id, defaultWarp)}><img alt="" src="/client-res/ui/texture/icons/44_32_18.png" /></button>
                {:else}{row.signal}{/if}
              </td>
              <td>
                <button type="button" class="minor" aria-label="Result menu" aria-expanded={menuFor === row.id}
                  onclick={() => (menuFor = menuFor === row.id ? null : row.id)}>⋯</button>
                {#if menuFor === row.id}
                  <span class="result-menu">
                    {#if accurateIDs.has(row.id) && row.distance !== null && row.distance > MIN_WARP_DISTANCE}
                      <button type="button" class="minor" onclick={() => warpTo(row.id, defaultWarp)}>
                        {word(PROBE_RESULT_LABELS.warpToWithinDistance, { distance: fmtDist(defaultWarp) }) ?? `Warp to Within ${fmtDist(defaultWarp)}`}
                      </button>
                      <button type="button" class="minor" aria-expanded={warpListFor === row.id}
                        onclick={() => (warpListFor = warpListFor === row.id ? null : row.id)}>
                        {word(PROBE_RESULT_LABELS.warpToWithinMenu, { distance: 0 }) ?? "Warp to Within"} {warpListFor === row.id ? "▾" : "▸"}
                      </button>
                      {#if warpListFor === row.id}
                        {#each WARP_RANGES as choice (choice.metres)}
                          <button type="button" class="minor" onclick={() => warpTo(row.id, choice.metres)}>
                            {word(PROBE_RESULT_LABELS.warpToWithin, { distance: fmtDist(choice.metres) }) ?? `Within ${fmtDist(choice.metres)}`}
                          </button>
                        {/each}
                      {/if}
                    {/if}
                    {#if accurateIDs.has(row.id)}
                      <button type="button" class="minor" onclick={() => alignTo(row.id)}>
                        {word(PROBE_RESULT_LABELS.alignTo) ?? "Align To"}
                      </button>
                      <button type="button" class="minor" onclick={() => { menuFor = null; bookmarking = { resultID: row.id, name: `${row.id} ${row.name}` }; }}>
                        {word(PROBE_RESULT_LABELS.bookmarkLocation) ?? "Save Location"}
                      </button>
                    {/if}
                    <button type="button" class="minor" onclick={() => { flow.ignoreProbeResults([row.id]); menuFor = null; }}>
                      {word(PROBE_RESULT_LABELS.ignoreResult) ?? "Ignore Result"}
                    </button>
                    <button type="button" class="minor" onclick={() => { flow.ignoreOtherProbeResults([row.id]); menuFor = null; }}>
                      {word(PROBE_RESULT_LABELS.ignoreOtherResults) ?? "Ignore Other Results"}
                    </button>
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if actionError !== null}
      <p class="error">{actionError}</p>
    {/if}
    {#if bookmarking !== null}
      <BookmarkWindow {store} {flow} scanResult={bookmarking} onDone={() => (bookmarking = null)} />
    {/if}
  </section>
{/if}

<style>
  /* the map button left of the filtered box (TORIGHT after it) */
  .ps-map { all: unset; display: inline-grid; place-items: center; width: 24px; height: 24px; cursor: pointer; opacity: 0.7; vertical-align: middle; }
  .ps-map:hover { opacity: 1; }
  .ps-map img { width: 16px; height: 16px; }
  .ignored-box {
    margin-bottom: 0.4rem;
  }
  .ignored-list {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
  }
  .custom-filter,
  .filter-question {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    align-items: center;
  }
  .filter-panel {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin: 0.3rem 0 0;
  }
  .result-menu {
    display: inline-flex;
    gap: 0.3rem;
    margin-left: 0.3rem;
  }
</style>
