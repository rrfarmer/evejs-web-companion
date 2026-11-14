<script lang="ts">
  // The client's info panels (infoPanels/infoPanelContainer.InfoPanelContainer, PANELWIDTH 312, at the top of the
  // left side beside the Neocom), the panels in PANELTYPES' order each where IsAvailable. Here the location's (InfoPanelLocation.svelte, always available), the route's (InfoPanelRoute.svelte, always
  // available), the factional warfare's (InfoPanelFactionalWarfare.svelte, in a warzone system) and the job board's
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
  import { openJobBoard } from "./jobBoardRequests.ts";
  let { store, flow, showAgents, openRouteWindow }: { store: ClientStore; flow: AppFlow; showAgents?: () => void; openRouteWindow?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const me = $derived($station.online?.characterID ?? null);
  // each panel's mode by its panelTypeID (PANEL_LOCATION_INFO 1, PANEL_ROUTE 2, PANEL_FACTIONAL_WARFARE 5, PANEL_JOB_BOARD 24)
  const modeKey = (panel: number) => (me ? `evejs.play.${me}.infoPanelMode.${panel}` : null);
  let modes = $state<Record<number, boolean>>({}), count = $state(0);
  $effect(() => {
    const read: Record<number, boolean> = {};
    for (const panel of [1, 2, 5, 24]) { const k = modeKey(panel); try { read[panel] = k ? localStorage.getItem(k) === "compact" : false; } catch { read[panel] = false; } }
    modes = read;
  });
  function toggleMode(panel: number): void {
    const compact = !modes[panel];
    modes = { ...modes, [panel]: compact };
    const k = modeKey(panel);
    if (k) try { localStorage.setItem(k, compact ? "compact" : "normal"); } catch { /* the window keeps it */ }
  }
  const compact = $derived(modes[24] === true);
  const caption = $derived(plainText($words.templates["UI/Opportunities/WindowTitle"] ?? "") || "Opportunities");
</script>

<div class="ip-container">
  <InfoPanelLocation {store} {flow} compact={modes[1] === true} onToggle={() => toggleMode(1)} />
  <InfoPanelRoute {store} {flow} compact={modes[2] === true} onToggle={() => toggleMode(2)} {openRouteWindow} />
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
</div>

<style>
  .ip-container { position: absolute; left: 44px; top: 8px; width: 312px; z-index: 15; pointer-events: none; }
  .ip-panel { pointer-events: auto; }
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
