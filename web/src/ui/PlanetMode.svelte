<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { MIN_HEAD_RADIUS, radiusForSlider, sliderForRadius } from "../bridge/extractorSurvey.ts";
  import { PlanetScene, type ExtractorMarkerPosition, type PlanetMarkerPosition } from "../play/planetScene.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { Colony, ColonyPin, ExtractorHead } from "../store/types.ts";
  import ColonyTemplate from "./ColonyTemplate.svelte";
  import ExtractorSurvey from "./ExtractorSurvey.svelte";
  import PlanetSurvey from "./PlanetSurvey.svelte";
  import TypeIcon from "./TypeIcon.svelte";

  let { colony, store, flow, onClose }: { colony: Colony; store: ClientStore; flow: AppFlow; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const planets = store.planets;
  let host: HTMLDivElement;
  let closeButton: HTMLButtonElement;
  let scene = $state.raw<PlanetScene | null>(null);
  let positions = $state.raw<readonly PlanetMarkerPosition[]>([]);
  let headPositions = $state.raw<readonly ExtractorMarkerPosition[]>([]);
  let selectedID = $state<number | null>(null);
  let templateShown = $state(false);
  let surveyShown = $state(false);
  let extractorID = $state<number | null>(null);
  let heads = $state.raw<readonly ExtractorHead[]>([]);
  let radius = $state(MIN_HEAD_RADIUS);
  let dragging = $state.raw<{ pointer: number; head: ExtractorHead } | null>(null);
  let ready = $state(false);
  let error = $state("");
  const centre = $derived(colony.pins.find(pin => pin.kind === "command" && pin.latitude != null && pin.longitude != null));
  const pinsByID = $derived(new Map(colony.pins.map(pin => [pin.pinID, pin])));
  const selected = $derived(selectedID === null ? undefined : pinsByID.get(selectedID));
  const unit = $derived(extractorID === null ? null : pinsByID.get(extractorID) ?? null);
  const area = $derived(unit?.extractor?.areaOfInfluence ?? null);
  const editable = $derived(unit?.active === false && area !== null && unit.extractor?.heads != null);

  function select(pin: ColonyPin, moveCamera = false): void {
    if (extractorID !== null && extractorID !== pin.pinID) closeExtractor();
    selectedID = pin.pinID;
    if (moveCamera) scene?.focus(pin);
  }

  function openExtractor(pin: ColonyPin): void {
    if (pin.kind !== "extractor-control" || !ready || extractorID === pin.pinID) return;
    selectedID = pin.pinID;
    surveyShown = templateShown = false;
    extractorID = pin.pinID;
    heads = pin.extractor?.heads ?? pin.program?.heads ?? [];
    radius = radiusForSlider(sliderForRadius(pin.extractor?.headRadius ?? pin.program?.headRadius ?? MIN_HEAD_RADIUS));
    scene?.focus(pin);
  }

  function closeExtractor(): void {
    extractorID = null;
    dragging = null;
    heads = [];
  }

  function toggleHead(id: number): void {
    if (!editable || !unit || area === null || dragging) return;
    if (heads.some(([slot]) => slot === id)) {
      heads = heads.filter(([slot]) => slot !== id);
    } else {
      const head = scene?.defaultHead(unit, id, area);
      if (head) heads = [...heads, head];
    }
  }

  function beginDrag(event: PointerEvent, id: number): void {
    const head = heads.find(([slot]) => slot === id);
    if (!editable || dragging || event.button !== 0 || !head) return;
    const target = event.currentTarget as HTMLButtonElement;
    target.setPointerCapture(event.pointerId);
    dragging = { pointer: event.pointerId, head };
  }

  function dragHead(event: PointerEvent): void {
    if (!editable || !unit || area === null || !dragging || dragging.pointer !== event.pointerId) return;
    const moved = scene?.moveHead(unit, dragging.head[0], event.clientX, event.clientY, area);
    if (moved) heads = heads.map(head => head[0] === moved[0] ? moved : head);
  }

  function endDrag(event: PointerEvent, cancel = false): void {
    if (!dragging || dragging.pointer !== event.pointerId) return;
    const original = dragging.head;
    if (cancel) heads = heads.map(head => head[0] === original[0] ? original : head);
    dragging = null;
  }

  onMount(() => {
    let disposed = false;
    let view: PlanetScene | undefined;
    closeButton.focus();
    try {
      view = new PlanetScene(host, markers => { positions = markers; }, markers => { headPositions = markers; });
      scene = view;
      for (const kind of ["extractor-control", "launchpad", "command"] as const) {
        if (view.focus(colony.pins.find(pin => pin.kind === kind && pin.latitude != null && pin.longitude != null))) break;
      }
      void view.load(colony).then(() => {
        if (!disposed) ready = true;
      }).catch(() => {
        if (!disposed) error = "The planet's surface could not be loaded.";
      });
    } catch {
      error = "Planet Mode could not start its 3D view.";
    }
    return () => { disposed = true; view?.dispose(); };
  });

  $effect(() => { scene?.setColony(colony); });
  $effect(() => { scene?.setExtractor(unit, heads, radius, area); });
</script>

<section class="planet-mode" aria-label="Planet Mode" aria-busy={!ready && !error}>
  <div class="planet-globe" bind:this={host}></div>
  <div class="planet-markers">
    {#each positions as position (position.pinID)}
      {@const pin = pinsByID.get(position.pinID)}
      {#if pin}
        <button type="button" class="installation-marker {pin.kind}" class:chosen={pin.pinID === selectedID}
          style:left={`${position.x}%`} style:top={`${position.y}%`}
          aria-label={pin.typeName} aria-pressed={pin.pinID === selectedID} title={pin.typeName}
          onclick={() => select(pin)} ondblclick={() => openExtractor(pin)}></button>
      {/if}
    {/each}
    {#each headPositions as position (position.id)}
      <button type="button" class="extraction-head" class:dragging={dragging?.head[0] === position.id}
        style:left={`${position.x}%`} style:top={`${position.y}%`}
        aria-label={`Extraction head ${position.id + 1}`} disabled={!editable}
        onpointerdown={(event) => beginDrag(event, position.id)} onpointermove={dragHead} onpointerup={endDrag}
        onlostpointercapture={(event) => endDrag(event, true)} onpointercancel={(event) => endDrag(event, true)}>{position.id + 1}</button>
    {/each}
  </div>
  <header class="planet-toolbar">
    <div class="planet-title">
      <h1>{colony.planetName ?? "Planet"}</h1>
      {#if colony.planetTypeName}<p>{colony.planetTypeName}</p>{/if}
    </div>
    <div class="planet-actions">
      <button type="button" disabled={!ready || !centre} onclick={() => scene?.focus(centre)}>Focus Command Center</button>
      <button type="button" aria-expanded={surveyShown} onclick={() => { closeExtractor(); surveyShown = !surveyShown; templateShown = false; }}>Scan</button>
      <button type="button" aria-expanded={templateShown} onclick={() => { closeExtractor(); templateShown = !templateShown; surveyShown = false; }}>Templates</button>
      <button type="button" bind:this={closeButton} onclick={onClose}>Exit Planet Mode</button>
    </div>
  </header>
  {#if error}
    <p class="planet-message" role="alert">{error}</p>
  {:else if !ready}
    <p class="planet-message" role="status">Loading planet surface…</p>
  {/if}
  {#if unit}
    <div class="extractor-survey-panel">
      {#key unit.pinID}
        <ExtractorSurvey {colony} {unit} characterID={store.station.get().online?.characterID ?? null} {flow}
          {heads} {radius} {editable} dragging={dragging !== null} {toggleHead}
          changeRadius={(value) => { radius = value; }} onClose={closeExtractor}
          showChart={async (chart) => { await scene?.showSurvey(chart); }}
          setRange={(low, high) => scene?.setSurveyRange(low, high)} />
      {/key}
    </div>
  {:else if surveyShown}
    <div class="planet-survey-panel">
      <PlanetSurvey {colony} characterID={store.station.get().online?.characterID ?? null} {flow}
        showChart={async (chart) => { await scene?.showSurvey(chart); }}
        setRange={(low, high) => scene?.setSurveyRange(low, high)} onClose={() => { surveyShown = false; }} />
    </div>
  {:else if templateShown}
    <div class="planet-template">
      <ColonyTemplate {colony} recipes={$planets.recipes} {store} {flow} onClose={() => { templateShown = false; }} />
    </div>
  {:else}
    <aside class="planet-overview">
      {#if selected}
        <div class="installation-heading">
          <TypeIcon typeID={selected.typeID} name={selected.typeName} />
          <strong>{selected.typeName}</strong>
          <button type="button" aria-label="Close installation details" onclick={() => { selectedID = null; }}>×</button>
        </div>
        {#if selected.schematicName}<p>Recipe <strong>{selected.schematicName}</strong></p>{/if}
        {#if selected.kind === "command"}<p>Command centre level <strong>{colony.commandCenterLevel}</strong></p>{/if}
        {#if selected.program?.resourceTypeName}<p>Resource <strong>{selected.program.resourceTypeName}</strong></p>{/if}
        {#if selected.kind === "extractor-control"}
          <button type="button" disabled={!ready} onclick={() => openExtractor(selected)}>Survey for Deposits</button>
        {/if}
        {#if selected.contents.length}
          <ul class="planet-contents">
            {#each selected.contents as item (item.typeID)}
              <li>{item.typeName ?? "Commodity"} <span>{item.quantity.toLocaleString()}</span></li>
            {/each}
          </ul>
        {/if}
        <p>{colony.links.filter(link => link.endpoint1 === selected.pinID || link.endpoint2 === selected.pinID).length} links ·
          {colony.routes.filter(route => route.path.includes(selected.pinID)).length} routes</p>
      {/if}
      <details>
        <summary>Installations ({colony.pins.length})</summary>
        <ul>
          {#each colony.pins as pin (pin.pinID)}
            <li><button type="button" aria-pressed={selectedID === pin.pinID} onclick={() => select(pin, true)}>{pin.typeName}</button></li>
          {/each}
        </ul>
      </details>
    </aside>
  {/if}
</section>

<style>
  .planet-mode { position: fixed; inset: 0 0 0 44px; z-index: 12; overflow: hidden; color: #e1eef3; background: #071018; }
  .planet-globe, .planet-markers { position: absolute; inset: 0; }
  .planet-globe :global(canvas) { display: block; cursor: grab; }
  .planet-globe :global(canvas:active) { cursor: grabbing; }
  .planet-markers { pointer-events: none; z-index: 1; }
  .installation-marker { position: absolute; transform: translate(-50%, -50%); pointer-events: auto; cursor: pointer; width: 17px; height: 17px;
    min-width: 0; min-height: 0; box-sizing: border-box;
    border: 1px solid currentColor; border-radius: 50%; background: #10222b; color: #a9d9e3; padding: 0; box-shadow: 0 0 0 2px #071018b0; }
  .installation-marker::after { content: ""; display: block; background: currentColor; width: 5px; height: 5px; margin: auto; border-radius: 50%; }
  .installation-marker.command { color: #ffd38a; }
  .installation-marker.factory { color: #ffae76; }
  .installation-marker.extractor-control { color: #b2e7a8; }
  .installation-marker:hover, .installation-marker:focus-visible, .installation-marker.chosen { z-index: 1; outline: 2px solid currentColor; outline-offset: 2px; }
  button.extraction-head { position: absolute; transform: translate(-50%, -50%); pointer-events: auto; z-index: 2;
    touch-action: none; padding: 0; width: 19px; height: 19px; border: 1px solid #f0d088; border-radius: 50%;
    color: #ffe4a9; background: #172225; font-size: 10px; cursor: grab; }
  button.extraction-head.dragging { cursor: grabbing; }
  button.extraction-head:disabled { opacity: .8; cursor: default; }
  .planet-toolbar, .planet-overview, .planet-template, .planet-survey-panel, .extractor-survey-panel, .planet-message { position: absolute; z-index: 2; }
  .planet-toolbar, .planet-overview, .planet-message { border: 1px solid #819fad65; background: #0a131be8; padding: 10px 12px; }
  .planet-toolbar { top: 14px; right: 16px; width: min(420px, calc(100% - 32px)); display: grid; gap: 8px; }
  .planet-title { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; }
  h1 { margin: 0; font-size: 22px; font-weight: 600; }
  p { margin: 0; }
  .planet-title p { color: #a1b7c4; }
  .planet-actions, .installation-heading { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  button:not(.installation-marker, .extraction-head) { background: #283643; color: inherit; border: 1px solid #536673; border-radius: 0; padding: 5px 8px; font: inherit; cursor: pointer; }
  button:not(.installation-marker, .extraction-head):hover { border-color: #a7dbe8; }
  button:disabled { opacity: .5; cursor: default; }
  .planet-message { bottom: 18px; left: 50%; transform: translateX(-50%); }
  .planet-overview { bottom: 16px; right: 16px; width: min(272px, calc(100% - 32px)); max-height: 55%; overflow: auto; display: grid; gap: 8px; }
  .installation-heading strong { flex: 1; }
  .installation-heading button { margin-inline-start: auto; }
  .planet-overview ul { padding: 0; margin: 8px 0 0; list-style: none; display: grid; gap: 4px; }
  .planet-overview li button { width: 100%; text-align: start; }
  .planet-contents li { display: flex; justify-content: space-between; gap: 6px; }
  summary { cursor: pointer; }
  .planet-template { top: 122px; right: 16px; bottom: 16px; width: min(492px, calc(100% - 32px)); overflow: auto; }
  .planet-survey-panel { top: 122px; right: 16px; width: min(310px, calc(100% - 32px)); max-height: calc(100% - 138px); overflow: auto; }
  .extractor-survey-panel { top: 122px; right: 16px; width: min(340px, calc(100% - 32px)); max-height: calc(100% - 138px); overflow: auto; }
</style>
