<script lang="ts">
  // The client's info panels (infoPanels/infoPanelContainer.InfoPanelContainer, PANELWIDTH 312, at the top of the
  // left side beside the Neocom), the panels in PANELTYPES' order each where IsAvailable. Here the location's (InfoPanelLocation.svelte, always available), the route's (InfoPanelRoute.svelte, always
  // available), the incursion's (InfoPanelIncursions.svelte, in an incursion), the factional warfare's (InfoPanelFactionalWarfare.svelte, in a
  // warzone system) and the job board's
  // (infoPanelJobBoard.InfoPanelJobBoard, PANEL_JOB_BOARD): available while the board tracks a job
  // (service.get_tracked_jobs - the accepted agent missions and the tracked freelance jobs). InfoPanelBase's top row
  // (28 high): in the left gutter (LEFTPAD 56) the ExpandButton (ToggleMode: MODE_NORMAL <-> MODE_COMPACT, the arrow
  // down when expanded) and the header button - the opportunities_board icon (18), opening the board's Active page
  // (open_active_page) -; the caption (EveCaptionSmall UI/Opportunities/WindowTitle); under it, indented by LEFTPAD,
  // the entries in a scroll area of at most 450 (SCROLL_CONTAINER_HEIGHT_MAX), hidden in compact mode. The mode is
  // a setting of the panel's (infoPanelSettingsController), kept here per character in the browser.
  // Not here: the other panels (location, route, ...), their reordering by drag, the compact header's own content.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { clientTexture } from "../play/window.ts";
  import MissionTracker from "./MissionTracker.svelte";
  import InfoPanelLocation from "./InfoPanelLocation.svelte";
  import InfoPanelRoute from "./InfoPanelRoute.svelte";
  import InfoPanelFactionalWarfare from "./InfoPanelFactionalWarfare.svelte";
  import InfoPanelIncursions from "./InfoPanelIncursions.svelte";
  import InfoPanelInsurgency from "./InfoPanelInsurgency.svelte";
  import InfoPanelAchievement from "./InfoPanelAchievement.svelte";
  import { openJobBoard } from "./jobBoardRequests.ts";
  import { searchLocationsInWindow } from "./locationSearchRequests.ts";
  import { tooltipDue, showLabelShortcutTooltip, hideLabelShortcutTooltip } from "../play/labelShortcutTooltip.ts";
  let { store, flow, showAgents, openRouteWindow }: { store: ClientStore; flow: AppFlow; showAgents?: () => void; openRouteWindow?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const me = $derived($station.online?.characterID ?? null);
  // Each remaining panel's mode by its panelTypeID. 24.02 removed the career panel (23).
  const modeKey = (panel: number) => (me ? `evejs.play.${me}.infoPanelMode.${panel}` : null);
  let modes = $state<Record<number, boolean>>({}), count = $state(0);
  $effect(() => {
    const read: Record<number, boolean> = {};
    for (const panel of [1, 2, 4, 5, 24, 25, 30]) { const k = modeKey(panel); try { read[panel] = k ? localStorage.getItem(k) === "compact" : false; } catch { read[panel] = false; } }
    modes = read;
  });
  function toggleMode(panel: number): void {
    const compact = !modes[panel];
    modes = { ...modes, [panel]: compact };
    const k = modeKey(panel);
    if (k) try { localStorage.setItem(k, compact ? "compact" : "normal"); } catch { /* the window keeps it */ }
  }
  const compact = $derived(modes[24] === true);

  // InfoPanelContainer's iconCont (the live client, gridcheck g284): a ButtonIconInfoPanel per panel class - Search New
  // Eden (14), System info (1), Route (2) - 16 wide with padRight 4 from LEFTPAD 56, the 18 icon at 0.75; a click sets
  // its panel MODE_HIDDEN or back (OnPanelContainerIconPressed), the button SetSelected while its panel is hidden; the
  // panels under it from 21. Kept per pilot as the page keeps the modes.
  const ICONS = [
    { id: 14, hint: "Search New Eden", icon: "res:/UI/Texture/Classes/InfoPanels/search.png" },
    { id: 1, hint: "System info", icon: "res:/UI/Texture/Classes/InfoPanels/LocationInfo.png" },
    { id: 2, hint: "Route", icon: "res:/UI/Texture/Classes/InfoPanels/Route.png" },
  ];
  const hiddenKey = (panel: number) => (me ? `evejs.play.${me}.infoPanelHidden.${panel}` : null);
  let hidden = $state<Record<number, boolean>>({});
  $effect(() => {
    const read: Record<number, boolean> = {};
    for (const { id } of ICONS) { const k = hiddenKey(id); try { read[id] = k ? localStorage.getItem(k) === "1" : false; } catch { read[id] = false; } }
    hidden = read;
  });
  function toggleHidden(panel: number): void {
    hideLabelShortcutTooltip();
    const on = !hidden[panel];
    hidden = { ...hidden, [panel]: on };
    const k = hiddenKey(panel);
    if (k) try { localStorage.setItem(k, on ? "1" : "0"); } catch { /* kept this session */ }
  }
  function iconTip(e: MouseEvent, hint: string): void {
    const el = e.currentTarget as HTMLElement;
    tooltipDue(el, () => showLabelShortcutTooltip(el, "", "", [hint], "top", true));
  }

  // InfoPanelSearch (MODE fixed, 38 high): the header button (search.png 18 in a 28 button at 28) and a SingleLineEditText
  // filling the header (256 x 24, padded 2, hint UI/Search/SearchForAnything, its text 8 in, a clear button); Return or
  // the button: GetResultsInNewWindow(text) - the page's search results window
  let searchText = $state("");
  function runSearch(): void {
    const text = searchText.trim();
    if (text) searchLocationsInWindow(text);
  }
  const caption = $derived(plainText($words.templates["UI/Opportunities/WindowTitle"] ?? "") || "Opportunities");
</script>

<div class="ip-container">
  <div class="ip-iconbar">
    {#each ICONS as b (b.id)}
      <button type="button" class="ip-barbtn" class:selected={hidden[b.id]} aria-label={b.hint} onclick={() => toggleHidden(b.id)}
        onmouseenter={(e) => iconTip(e, b.hint)} onmouseleave={() => hideLabelShortcutTooltip()}><img alt="" src={clientTexture(b.icon)} /></button>
    {/each}
  </div>
  {#if !hidden[14]}
    <section class="ip-panel ip-search">
      <div class="ip-top">
        <div class="ip-gutter">
          <span class="ip-expand-slot"></span>
          <button type="button" class="ip-icon" aria-label="Search" onclick={runSearch}><img alt="" src={clientTexture("res:/UI/Texture/Classes/InfoPanels/search.png")} /></button>
        </div>
        <input class="ip-search-edit" type="text" placeholder="Search for anything" bind:value={searchText}
          onkeydown={(e) => { if (e.key === "Enter") runSearch(); }} />
      </div>
    </section>
  {/if}
  <div class:hidden={hidden[1]} class="ip-wrap"><InfoPanelLocation {store} {flow} compact={modes[1] === true} onToggle={() => toggleMode(1)} /></div>
  <div class:hidden={hidden[2]} class="ip-wrap"><InfoPanelRoute {store} {flow} compact={modes[2] === true} onToggle={() => toggleMode(2)} {openRouteWindow} /></div>
  <InfoPanelIncursions {store} {flow} compact={modes[4] === true} onToggle={() => toggleMode(4)} />
  <InfoPanelFactionalWarfare {store} {flow} compact={modes[5] === true} onToggle={() => toggleMode(5)} />
  <!-- the panel is built while hidden, so its reads run and its count says whether it is available -->
  <section class="ip-panel" class:hidden={count === 0}>
    <div class="ip-top">
      <div class="ip-gutter">
        <button type="button" class="ip-expand" class:expanded={!compact} aria-label={compact ? "Expand" : "Collapse"} onclick={() => toggleMode(24)}>
          <img alt="" src={clientTexture("res:/UI/Texture/classes/Neocom/arrowDown.png")} /></button>
        <button type="button" class="ip-icon" title={caption} onclick={() => openJobBoard(null, null, "active")}>
          <img alt="" src={clientTexture("res:/UI/Texture/eveicon/system_icons/opportunities_board_16px.png")} /></button>
      </div>
      <span class="ip-caption">{caption}</span>
    </div>
    <div class="ip-main" class:hidden={compact}>
      <MissionTracker {store} {flow} {showAgents} embedded onCount={(n) => { count = n; }} />
    </div>
  </section>
  <InfoPanelInsurgency {store} {flow} compact={modes[25] === true} onToggle={() => toggleMode(25)} />
  <InfoPanelAchievement {store} {flow} compact={modes[30] === true} onToggle={() => toggleMode(30)} />
</div>

<style>
  /* the side panels (the live client, gridcheck g264 / g283): the Neocom 48 wide, then TOTOP the crimewatch TimerContainer
     (top 12, 32 high, padBottom 6 - there with no timer too) and under it the InfoPanelContainer at (48, 50) */
  .ip-container { position: absolute; left: 48px; top: 50px; width: 312px; z-index: 15; pointer-events: none; }
  /* the app's section frame (padding 13, a 1 px border) is not the client's: InfoPanelBase draws none */
  .ip-container :global(section.ip-panel) { padding: 0; border: 0; border-radius: 0; background: none; box-shadow: none; }
  .ip-panel { pointer-events: auto; }
  .ip-wrap.hidden { display: none; }
  .ip-iconbar { display: flex; height: 16px; margin: 0 0 5px 56px; pointer-events: auto; }
  .ip-barbtn { all: unset; position: relative; width: 16px; height: 16px; margin-right: 4px; cursor: pointer; }
  .ip-barbtn img { position: absolute; left: -1px; top: -1px; width: 18px; height: 18px; max-width: none; opacity: 0.75; }
  .ip-barbtn:hover img { opacity: 1; }
  .ip-barbtn.selected img { opacity: 0.3; }
  .ip-search { height: 38px; margin: 0; }
  .ip-expand-slot { width: 28px; flex: none; }
  .ip-search .ip-icon img { width: 18px; height: 18px; }
  .ip-search-edit { box-sizing: border-box; width: 256px; height: 24px; min-height: 0; line-height: 22px; margin: 2px 0; padding: 0 8px; border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(0, 0, 0, 0.25); color: rgba(255, 255, 255, 0.75); font: 14px "EVE Sans Neue", "Segoe UI", sans-serif; outline: none; }
  .ip-search-edit::placeholder { color: rgba(255, 255, 255, 0.5); }
  .ip-search-edit:focus { border-color: rgba(255, 255, 255, 0.3); }
  .ip-panel.hidden, .ip-main.hidden { display: none; }
  .ip-top { display: flex; align-items: center; height: 28px; }
  .ip-gutter { display: flex; width: 56px; flex: none; }
  .ip-expand, .ip-icon { all: unset; cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; opacity: 0.8; }
  .ip-expand:hover, .ip-icon:hover { opacity: 1; }
  .ip-expand img { width: 7px; height: 7px; transform: rotate(-90deg); }
  .ip-expand.expanded img { transform: none; }
  .ip-icon img { width: 18px; height: 18px; }
  .ip-caption { font-size: 14px; letter-spacing: 0.04em; color: rgb(255 255 255 / 0.85); }
  .ip-main { padding-left: 56px; max-height: 450px; overflow-y: auto; }
</style>
