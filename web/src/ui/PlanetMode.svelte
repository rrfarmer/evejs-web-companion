<script lang="ts">
  import { onMount } from "svelte";
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import { EXTRACTOR_COOLDOWN_MS, extractorBasis, extractorHeadCommands, type ExtractorEdit } from "../bridge/extractorEdits.ts";
  import { MAX_HEAD_RADIUS, MIN_HEAD_RADIUS } from "../bridge/extractorSurvey.ts";
  import { serverNow } from "../bridge/planets.ts";
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
  let basis = "";
  let dragging = $state.raw<{ pointer: number; head: ExtractorHead } | null>(null);
  let edits = $state.raw(new Map<number, ExtractorEdit>());
  let submitting = $state(false);
  let submitError = $state("");
  let browserNow = $state(Date.now());
  let ready = $state(false);
  let error = $state("");
  const centre = $derived(colony.pins.find(pin => pin.kind === "command" && pin.latitude != null && pin.longitude != null));
  const pinsByID = $derived(new Map(colony.pins.map(pin => [pin.pinID, pin])));
  const selected = $derived(selectedID === null ? undefined : pinsByID.get(selectedID));
  const selectedEdit = $derived(selectedID === null ? undefined : edits.get(selectedID));
  const pendingResource = $derived(colony.resources?.find(resource => resource.typeID === selectedEdit?.resourceID)?.typeName);
  const removedOutputs = $derived(colony.routes.filter(route => edits.get(route.path[0]!)?.resourceID === null).length);
  const unit = $derived(extractorID === null ? null : pinsByID.get(extractorID) ?? null);
  const area = $derived(unit?.extractor?.areaOfInfluence ?? null);
  const edit = $derived(extractorID === null ? undefined : edits.get(extractorID));
  const editable = $derived(!submitting && (unit?.active === false || edit?.stopped === true) && area !== null && unit?.extractor?.heads != null);
  const running = $derived(unit?.active === true && !edit?.stopped);
  const cooldown = $derived(running && unit?.program?.installedAtMs != null
    ? Math.max(0, Math.ceil((unit.program.installedAtMs + EXTRACTOR_COOLDOWN_MS - serverNow($planets.clockOffsetMs, browserNow)) / 1000))
    : 0);
  const workingUnit = $derived(unit ?? (selected && edits.has(selected.pinID) ? selected : null));
  const displayedHeads = $derived(unit ? running ? unit.extractor?.heads ?? unit.program?.heads ?? [] : heads
    : workingUnit ? edits.get(workingUnit.pinID)?.heads ?? [] : []);
  const displayedRadius = $derived(unit ? running ? unit.extractor?.headRadius ?? radius : radius
    : workingUnit ? edits.get(workingUnit.pinID)?.radius ?? MIN_HEAD_RADIUS : MIN_HEAD_RADIUS);

  function select(pin: ColonyPin, moveCamera = false): void {
    if (extractorID !== null && extractorID !== pin.pinID) closeExtractor();
    selectedID = pin.pinID;
    if (moveCamera) scene?.focus(pin);
  }

  function openExtractor(pin: ColonyPin): void {
    if (pin.kind !== "extractor-control" || !ready || submitting || extractorID === pin.pinID) return;
    selectedID = pin.pinID;
    surveyShown = templateShown = false;
    extractorID = pin.pinID;
    const staged = edits.get(pin.pinID);
    basis = staged?.basis ?? extractorBasis(pin);
    heads = staged?.heads ?? pin.extractor?.heads ?? pin.program?.heads ?? [];
    const storedRadius = staged?.radius ?? pin.extractor?.headRadius ?? pin.program?.headRadius ?? MIN_HEAD_RADIUS;
    radius = Math.max(MIN_HEAD_RADIUS, Math.min(MAX_HEAD_RADIUS, storedRadius));
    scene?.focus(pin);
  }

  function closeExtractor(): void {
    extractorID = null;
    dragging = null;
    heads = [];
  }

  function stageHeads(): void {
    if (!unit?.extractor?.heads) return;
    const next = new Map(edits);
    const previous = next.get(unit.pinID);
    const resourceID = heads.length ? previous?.resourceID : previous?.stopped ? null : undefined;
    if (resourceID === undefined && !extractorHeadCommands(unit.pinID, unit.extractor.heads, heads).length) {
      next.delete(unit.pinID);
    } else {
      next.set(unit.pinID, {
        pinID: unit.pinID, basis, heads, resourceID, stopped: previous?.stopped ?? false,
        radius: previous?.radius ?? unit.extractor.headRadius ?? MIN_HEAD_RADIUS,
      });
    }
    edits = next;
    submitError = "";
  }

  function stageProgram(resourceID: number | null): void {
    if (!unit?.extractor?.heads || submitting) return;
    const next = new Map(edits);
    next.set(unit.pinID, { pinID: unit.pinID, basis, heads, radius, resourceID, stopped: resourceID === null || edit?.stopped === true });
    edits = next;
    submitError = "";
    if (resourceID !== null) closeExtractor();
  }

  function cancelEdits(): void {
    if (submitting) return;
    closeExtractor();
    edits = new Map();
    submitError = "";
  }

  export function canLeave(): boolean {
    return !submitting && (!edits.size || window.confirm("Discard pending colony changes?"));
  }

  async function submitEdits(): Promise<void> {
    if (submitting || dragging || !edits.size) return;
    submitting = true;
    submitError = "";
    try {
      await flow.submitExtractorEdits(colony.planetID, [...edits.values()]);
      closeExtractor();
      edits = new Map();
    } catch (cause) {
      submitError = errorWords(cause);
    } finally {
      submitting = false;
    }
  }

  function toggleHead(id: number): void {
    if (!editable || !unit || area === null || dragging) return;
    if (heads.some(([slot]) => slot === id)) {
      heads = heads.filter(([slot]) => slot !== id);
    } else {
      const head = scene?.defaultHead(unit, id, area);
      if (head) heads = [...heads, head];
    }
    stageHeads();
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
    if (!cancel) stageHeads();
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
  $effect(() => { scene?.setExtractor(workingUnit, displayedHeads, displayedRadius, workingUnit?.extractor?.areaOfInfluence ?? null); });
  $effect(() => {
    if (!running) return;
    browserNow = Date.now();
    const timer = setInterval(() => { browserNow = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
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
      <button type="button" aria-expanded={templateShown} disabled={edits.size > 0} onclick={() => { closeExtractor(); templateShown = !templateShown; surveyShown = false; }}>Templates</button>
      <button type="button" bind:this={closeButton} disabled={submitting} onclick={() => { if (canLeave()) onClose(); }}>Exit Planet Mode</button>
    </div>
  </header>
  {#if error}
    <p class="planet-message" role="alert">{error}</p>
  {:else if !ready}
    <p class="planet-message" role="status">Loading planet surface…</p>
  {/if}
  {#if edits.size}
    <section class="planet-edit-bar" aria-label="Colony edits">
      <div class="planet-actions">
        <span aria-live="polite">{edits.size} {edits.size === 1 ? "extractor" : "extractors"} with pending changes</span>
        <button type="button" disabled={submitting || dragging !== null} onclick={() => void submitEdits()}>{submitting ? "Submitting…" : "Submit"}</button>
        <button type="button" disabled={submitting} onclick={cancelEdits}>Cancel</button>
      </div>
      {#if removedOutputs}
        <p>Submitting will remove {removedOutputs} {removedOutputs === 1 ? "output route" : "output routes"} from stopped extractors.</p>
      {/if}
      {#if submitError}<p role="alert">{submitError}</p>{/if}
    </section>
  {/if}
  {#if unit}
    <div class="extractor-survey-panel">
      {#key unit.pinID}
        <ExtractorSurvey {colony} {unit} characterID={store.station.get().online?.characterID ?? null} {flow}
          heads={displayedHeads} radius={displayedRadius} {editable} {running} {cooldown} {submitting}
          stagedResource={edit?.resourceID} dragging={dragging !== null} {toggleHead}
          changeRadius={(value) => { radius = value; }} onClose={closeExtractor}
          installProgram={stageProgram} stopProgram={() => stageProgram(null)}
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
          {#if pendingResource}<p>Pending program <strong>{pendingResource}</strong></p>
          {:else if selectedEdit?.stopped}<p>Program queued to stop</p>{/if}
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
  .planet-toolbar, .planet-overview, .planet-template, .planet-survey-panel, .extractor-survey-panel, .planet-message, .planet-edit-bar { position: absolute; z-index: 2; }
  .planet-toolbar, .planet-overview, .planet-message, .planet-edit-bar { border: 1px solid #819fad65; background: #0a131be8; padding: 10px 12px; }
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
  .planet-edit-bar { bottom: 16px; left: 50%; transform: translateX(-50%); width: max-content; max-width: calc(100% - 32px); z-index: 3; }
  .planet-edit-bar [role=alert] { color: #ffca83; margin-top: .35rem; max-width: 36rem; }
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
