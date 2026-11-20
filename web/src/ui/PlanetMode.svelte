<script lang="ts">
  import { onMount } from "svelte";
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import { isStorage } from "../bridge/colonyRoutes.ts";
  import { canReceiveExpeditedTransfer, type TransferCargo } from "../bridge/expeditedTransfer.ts";
  import { EXTRACTOR_COOLDOWN_MS, extractorBasis, extractorHeadCommands, type ExtractorEdit } from "../bridge/extractorEdits.ts";
  import { MAX_HEAD_RADIUS, MIN_HEAD_RADIUS } from "../bridge/extractorSurvey.ts";
  import { appendPlanetWaypoint, linkKey, pinDesignator, previewPlanetRoute } from "../bridge/planetRouting.ts";
  import { applyPlanetLinkEdit, colonyLinkBudget, linkBudgetError, linkEndpoints, linkInColony, linkUsage, MAX_LINK_LEVEL,
    pathUsesLink, type LinkEdit, type PlanetLinkFacts } from "../bridge/planetLinks.ts";
  import type { NewRoute } from "../bridge/planetWrites.ts";
  import { serverNow } from "../bridge/planets.ts";
  import { PlanetScene, type ExtractorMarkerPosition, type PlanetMarkerPosition } from "../play/planetScene.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { Colony, ColonyLink, ColonyPin, ColonyRoute, ExtractorHead } from "../store/types.ts";
  import ColonyTemplate from "./ColonyTemplate.svelte";
  import ExtractorSurvey from "./ExtractorSurvey.svelte";
  import ExpeditedTransfer from "./ExpeditedTransfer.svelte";
  import PlanetLink from "./PlanetLink.svelte";
  import PlanetSurvey from "./PlanetSurvey.svelte";
  import PlanetRouting from "./PlanetRouting.svelte";
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
  let newRoutes = $state.raw<readonly NewRoute[]>([]);
  let removedRoutes = $state.raw<readonly ColonyRoute[]>([]);
  let linkEdits = $state.raw<readonly LinkEdit[]>([]);
  let linking = $state(false);
  let linkSource = $state<number | null>(null);
  let selectedLink = $state.raw<Pick<ColonyLink, "endpoint1" | "endpoint2"> | null>(null);
  let linkFacts = $state.raw<PlanetLinkFacts>({});
  let linkFactsError = $state("");
  let linkError = $state("");
  let rubberLink = $state.raw<{ x: number; y: number; latitude: number; longitude: number } | null>(null);
  let routePath = $state.raw<readonly number[]>([]);
  let routeTypeID = $state<number | null>(null);
  let transferring = $state(false);
  let transferPath = $state.raw<readonly number[]>([]);
  let transferError = $state("");
  let highlight = $state.raw<readonly number[]>([]);
  let hoveredWaypoint = $state<number | null>(null);
  let waypointError = $state("");
  let routePanel: { stageRoute: () => void } | undefined = $state();
  let submitting = $state(false);
  let refreshing = $state(false);
  let refreshError = $state("");
  let submitError = $state("");
  let browserNow = $state(Date.now());
  let ready = $state(false);
  let error = $state("");
  const routing = $derived(routePath.length > 0);
  const pending = $derived(edits.size + newRoutes.length + removedRoutes.length + linkEdits.length > 0);
  const removedIDs = $derived(new Set(removedRoutes.map(route => route.routeID)));
  const networkView = $derived(linkEdits.reduce(applyPlanetLinkEdit, colony));
  const changedLinks = $derived(new Set(linkEdits.map(edit => linkKey(edit.endpoint1, edit.endpoint2))));
  const link = $derived(selectedLink ? linkInColony(networkView, selectedLink) : undefined);
  const routeRows = $derived([...networkView.routes, ...newRoutes.map((route, index) => previewPlanetRoute(networkView, route, index, $planets.recipes))]);
  const routeView = $derived({ ...networkView, routes: routeRows.filter(route => !removedIDs.has(route.routeID)
    && edits.get(route.path[0]!)?.resourceID !== null) });
  const displayPath = $derived(transferring
    ? (hoveredWaypoint === null || selectedID === null ? transferPath
      : appendPlanetWaypoint(colony, [selectedID], hoveredWaypoint) ?? transferPath)
    : routing
    ? (hoveredWaypoint === null ? routePath : appendPlanetWaypoint(networkView, routePath, hoveredWaypoint) ?? routePath)
    : highlight.length ? highlight : link ? [link.endpoint1, link.endpoint2] : []);
  const centre = $derived(colony.pins.find(pin => pin.kind === "command" && pin.latitude != null && pin.longitude != null));
  const pinsByID = $derived(new Map(colony.pins.map(pin => [pin.pinID, pin])));
  const selected = $derived(selectedID === null ? undefined : pinsByID.get(selectedID));
  const linkOrigin = $derived(linkSource === null ? undefined : pinsByID.get(linkSource));
  const rubberUsage = $derived(linkOrigin && rubberLink ? linkUsage(colony.radius, linkOrigin, rubberLink, 0, linkFacts) : null);
  const budget = $derived((linking || link) ? colonyLinkBudget(networkView, linkFacts) : null);
  const removedLinkRoutes = $derived(colony.routes.filter(route => !removedIDs.has(route.routeID)
    && !networkView.routes.some(remaining => remaining.routeID === route.routeID)).length);
  const selectedEdit = $derived(selectedID === null ? undefined : edits.get(selectedID));
  const pendingResource = $derived(colony.resources?.find(resource => resource.typeID === selectedEdit?.resourceID)?.typeName);
  const removedOutputs = $derived(networkView.routes.filter(route => !removedIDs.has(route.routeID) && edits.get(route.path[0]!)?.resourceID === null).length);
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

  function select(pin: ColonyPin, moveCamera = false, shortcut = false): void {
    if (transferring) { chooseTransferDestination(pin.pinID); return; }
    if (routing) { addWaypoint(pin.pinID); return; }
    if (linking) { chooseLinkPin(pin); return; }
    if (shortcut) { startLink(pin); return; }
    closeLink();
    highlight = [];
    if (extractorID !== null && extractorID !== pin.pinID) closeExtractor();
    selectedID = pin.pinID;
    if (moveCamera) scene?.focus(pin);
  }

  function openExtractor(pin: ColonyPin): void {
    if (pin.kind !== "extractor-control" || !ready || submitting || extractorID === pin.pinID) return;
    selectedID = pin.pinID;
    closeRoute();
    closeTransfer();
    closeLink();
    surveyShown = templateShown = false;
    extractorID = pin.pinID;
    const staged = edits.get(pin.pinID);
    basis = staged?.basis ?? extractorBasis(pin);
    heads = staged?.heads ?? pin.extractor?.heads ?? pin.program?.heads ?? [];
    const storedRadius = staged?.radius ?? pin.extractor?.headRadius ?? pin.program?.headRadius ?? MIN_HEAD_RADIUS;
    radius = Math.max(MIN_HEAD_RADIUS, Math.min(MAX_HEAD_RADIUS, storedRadius));
    scene?.focus(pin);
  }

  function closeRoute(): void {
    routePath = [];
    routeTypeID = null;
    highlight = [];
    hoveredWaypoint = null;
    waypointError = "";
  }

  function startRoute(typeID: number): void {
    if (!selected || selectedEdit?.resourceID !== undefined || submitting) return;
    closeExtractor();
    closeTransfer();
    closeRoute();
    closeLink();
    routePath = [selected.pinID];
    routeTypeID = typeID;
  }

  function closeTransfer(): void {
    transferring = false;
    transferPath = [];
    hoveredWaypoint = null;
    transferError = "";
  }

  function startTransfer(): void {
    if (!selected || !isStorage(selected) || pending || submitting || refreshing) return;
    closeExtractor();
    closeRoute();
    closeTransfer();
    closeLink();
    transferring = true;
  }

  function chooseTransferDestination(id: number): void {
    if (!transferring || !selected || submitting) return;
    hoveredWaypoint = null;
    const destination = pinsByID.get(id);
    const path = appendPlanetWaypoint(colony, [selected.pinID], id);
    if (!destination || id === selected.pinID || !canReceiveExpeditedTransfer(destination) || !path) {
      transferError = "Choose a different linked storage installation or a configured processor.";
      transferPath = [];
      return;
    }
    transferError = "";
    transferPath = path;
  }

  async function executeTransfer(cargo: TransferCargo): Promise<void> {
    if (!transferring || transferPath.length < 2 || pending || submitting || refreshing) return;
    submitting = true;
    transferError = "";
    try {
      await flow.expediteColonyTransfer(colony.planetID, transferPath, cargo);
      closeTransfer();
    } catch (cause) {
      transferError = errorWords(cause);
    } finally {
      submitting = false;
    }
  }

  function addWaypoint(id: number): void {
    if (!routing || submitting) return;
    hoveredWaypoint = null;
    const path = appendPlanetWaypoint(networkView, routePath, id);
    waypointError = path ? "" : "There is no linked path to that installation.";
    if (path) routePath = path;
  }

  function stageRoute(route: NewRoute): void {
    if (submitting) return;
    newRoutes = [...newRoutes, route];
    submitError = "";
    closeRoute();
    highlight = route.path;
  }

  function toggleRouteRemoval(route: ColonyRoute): void {
    if (submitting) return;
    if (route.routeID < 0) {
      newRoutes = newRoutes.filter((_, index) => index !== -route.routeID - 1);
      highlight = [];
    } else {
      removedRoutes = removedIDs.has(route.routeID) ? removedRoutes.filter(item => item.routeID !== route.routeID)
        : [...removedRoutes, route];
    }
    submitError = "";
  }

  function closeExtractor(): void {
    extractorID = null;
    dragging = null;
    heads = [];
  }

  function resetLinkPreview(): void {
    rubberLink = null;
    scene?.previewLink(null);
  }

  function closeLink(): void {
    if (linking) resetLinkPreview();
    linking = false;
    linkSource = null;
    selectedLink = null;
    linkError = "";
  }

  function startLink(pin?: ColonyPin): void {
    if (!ready || submitting || refreshing) return;
    closeExtractor();
    closeRoute();
    closeTransfer();
    closeLink();
    surveyShown = templateShown = false;
    linking = true;
    if (pin) chooseLinkPin(pin);
  }

  function chooseLinkPin(pin: ColonyPin): void {
    if (submitting || refreshing || pin.latitude === null || pin.longitude === null) return;
    if (!linkOrigin) {
      linkSource = selectedID = pin.pinID;
      linkError = "";
      return;
    }
    const endpoints = linkEndpoints(linkOrigin.pinID, pin.pinID);
    const proposed = { ...endpoints, level: 0 };
    linkError = linkInColony(networkView, endpoints) ? "These installations are already linked."
      : linkFactsError || linkBudgetError(networkView, proposed, linkFacts);
    if (linkError) return;
    stageLink({ ...proposed, previousLevel: null, removedRoutes: [] });
    // The native build mode returns to choosing a source after placement.
    linkSource = null;
    resetLinkPreview();
  }

  function openLink(value: ColonyLink): void {
    if (submitting || routing || transferring || linking || dragging) return;
    closeExtractor();
    closeLink();
    surveyShown = templateShown = false;
    highlight = [];
    selectedLink = value;
  }

  function stageLink(edit: LinkEdit): void {
    submitError = "";
    linkEdits = [...linkEdits, edit];
  }

  function upgradeLink(): void {
    if (!link || submitting || refreshing || link.level >= MAX_LINK_LEVEL) return;
    const level = link.level + 1;
    if (linkBudgetError(networkView, { ...link, level }, linkFacts)) return;
    stageLink({ ...link, previousLevel: link.level, level, removedRoutes: [] });
  }

  function removeLink(): void {
    if (!link || submitting || refreshing) return;
    const removed = link;
    const sameLink = (edit: LinkEdit) => pathUsesLink([removed.endpoint1, removed.endpoint2], edit);
    const created = linkEdits.findLastIndex(edit => edit.previousLevel === null && sameLink(edit));
    if (created >= 0) {
      linkEdits = linkEdits.filter((edit, index) => index < created || !sameLink(edit));
      submitError = "";
    } else {
      stageLink({ ...removed, previousLevel: removed.level, level: null,
        removedRoutes: networkView.routes.filter(route => !removedIDs.has(route.routeID) && pathUsesLink(route.path, removed)) });
    }
    newRoutes = newRoutes.filter(route => !pathUsesLink(route.path, removed));
    closeLink();
    highlight = [];
  }

  function moveLink(event: PointerEvent): void {
    if (!linking || linkSource === null || !scene) return;
    const element = event.target as Element | null;
    const target = element?.closest<HTMLElement>(".installation-marker");
    if (!target && !host.contains(element)) {
      if (rubberLink) resetLinkPreview();
      return;
    }
    const hit = scene.previewLink(linkSource, event.clientX, event.clientY, target ? Number(target.dataset.pinId) : undefined);
    rubberLink = hit ? { x: event.clientX, y: event.clientY, ...hit } : null;
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
    closeRoute();
    closeLink();
    edits = new Map();
    newRoutes = [];
    removedRoutes = [];
    linkEdits = [];
    submitError = "";
  }

  export function canLeave(): boolean {
    return !submitting && (!pending || window.confirm("Discard pending colony changes?"));
  }

  export function escapeCanLeave(): boolean {
    if (transferring) {
      if (!submitting) closeTransfer();
      return false;
    }
    if (linking || link) {
      if (!submitting) { closeLink(); highlight = []; }
      return false;
    }
    if (!routing) return canLeave();
    closeRoute();
    return false;
  }

  async function submitEdits(): Promise<void> {
    if (submitting || refreshing || dragging || !pending) return;
    submitting = true;
    submitError = "";
    try {
      await flow.submitPlanetEdits(colony.planetID, [...edits.values()], { create: newRoutes, remove: removedRoutes }, linkEdits);
      closeExtractor();
      closeRoute();
      edits = new Map();
      newRoutes = [];
      removedRoutes = [];
      linkEdits = [];
    } catch (cause) {
      submitError = errorWords(cause);
    } finally {
      submitting = false;
    }
  }

  async function refreshColony(): Promise<void> {
    if (refreshing || submitting) return;
    refreshing = true;
    refreshError = "";
    try {
      await flow.loadPlanets();
      refreshError = planets.get().error ?? "";
    } catch (cause) {
      refreshError = errorWords(cause);
    } finally {
      refreshing = false;
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
    let pressed: { x: number; y: number } | null = null;
    const pressSurface = (event: PointerEvent) => {
      pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const clickSurface = (event: MouseEvent) => {
      const origin = pressed;
      pressed = null;
      if (!origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 5 || linking) return;
      const hit = view?.linkAt(event.clientX, event.clientY);
      if (hit) openLink(hit);
    };
    host.addEventListener("pointerdown", pressSurface);
    host.addEventListener("click", clickSurface);
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
    return () => {
      disposed = true;
      host.removeEventListener("pointerdown", pressSurface);
      host.removeEventListener("click", clickSurface);
      view?.dispose();
    };
  });

  $effect(() => { scene?.setColony(networkView, changedLinks); });
  $effect(() => { networkView; scene?.setRoutePath(displayPath, routing || transferring); });
  $effect(() => {
    if (!linking && !selectedLink) return;
    let active = true;
    linkFactsError = "";
    void flow.readPlanetLinkFacts(colony.pins.map(pin => pin.typeID)).then(facts => {
      if (active) linkFacts = facts;
    }).catch(cause => { if (active) linkFactsError = errorWords(cause); });
    return () => { active = false; };
  });
  $effect(() => { scene?.setExtractor(workingUnit, displayedHeads, displayedRadius, workingUnit?.extractor?.areaOfInfluence ?? null); });
  $effect(() => {
    if (!running) return;
    browserNow = Date.now();
    const timer = setInterval(() => { browserNow = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
</script>

<svelte:window onpointermove={moveLink} />
<section class="planet-mode" aria-label="Planet Mode" aria-busy={!ready && !error}>
  <div class="planet-globe" bind:this={host}></div>
  <div class="planet-markers">
    {#each positions as position (position.pinID)}
      {@const pin = pinsByID.get(position.pinID)}
      {#if pin}
        <button type="button" class="installation-marker {pin.kind}" class:chosen={pin.pinID === selectedID}
          class:waypoint={routePath.includes(pin.pinID) || transferPath.includes(pin.pinID)} data-pin-id={pin.pinID}
          style:left={`${position.x}%`} style:top={`${position.y}%`}
          aria-label={pin.typeName} aria-pressed={pin.pinID === selectedID} title={`${pin.typeName} · ${pinDesignator(pin.pinID)}`}
          onclick={(event) => select(pin, false, event.ctrlKey)}
          ondblclick={() => { if (routing) routePanel?.stageRoute(); else if (!transferring && !linking) openExtractor(pin); }}
          onmouseenter={() => { if (routing || transferring) hoveredWaypoint = pin.pinID; }}
          onmouseleave={() => { if (routing || transferring) hoveredWaypoint = null; }}></button>
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
  {#if rubberUsage && rubberLink}
    <div class="rubber-link" style:left={`min(${rubberLink.x - 32}px, calc(100% - 9rem))`}
      style:top={`min(${rubberLink.y + 13}px, calc(100% - 4rem))`}>
      <span>{rubberUsage.km.toLocaleString(undefined, { maximumFractionDigits: 1 })} km</span>
      <span>{rubberUsage.cpu.toLocaleString()} tf · {rubberUsage.power.toLocaleString()} MW</span>
    </div>
  {/if}
  <header class="planet-toolbar">
    <div class="planet-title">
      <h1>{colony.planetName ?? "Planet"}</h1>
      {#if colony.planetTypeName}<p>{colony.planetTypeName}</p>{/if}
      <button type="button" disabled={refreshing || submitting} onclick={() => void refreshColony()}>{refreshing ? "Refreshing…" : "Refresh Colony"}</button>
    </div>
    {#if refreshError}<p role="alert">{refreshError}</p>{/if}
    <div class="planet-actions">
      <button type="button" disabled={!ready || !centre} onclick={() => scene?.focus(centre)}>Focus Command Center</button>
      <button type="button" aria-expanded={surveyShown} disabled={submitting} onclick={() => { closeExtractor(); closeRoute(); closeTransfer(); closeLink(); surveyShown = !surveyShown; templateShown = false; }}>Scan</button>
      <button type="button" aria-expanded={templateShown} disabled={pending || submitting} onclick={() => { closeExtractor(); closeRoute(); closeTransfer(); closeLink(); templateShown = !templateShown; surveyShown = false; }}>Templates</button>
      <button type="button" aria-pressed={linking} disabled={!ready || submitting || refreshing}
        title="Create Link (Ctrl-click an installation)" onclick={() => { if (linking) closeLink(); else startLink(); }}>Create Link</button>
      <button type="button" bind:this={closeButton} disabled={submitting} onclick={() => { if (canLeave()) onClose(); }}>Exit Planet Mode</button>
    </div>
  </header>
  {#if error}
    <p class="planet-message" role="alert">{error}</p>
  {:else if !ready}
    <p class="planet-message" role="status">Loading planet surface…</p>
  {/if}
  {#if pending}
    <section class="planet-edit-bar" aria-label="Colony edits">
      <div class="planet-actions">
        <span aria-live="polite">
          {#if edits.size}{edits.size} {edits.size === 1 ? "extractor" : "extractors"} with pending changes{/if}
          {#if newRoutes.length + removedRoutes.length}{edits.size ? " · " : ""}{newRoutes.length + removedRoutes.length} pending route changes{/if}
          {#if linkEdits.length}{edits.size || newRoutes.length || removedRoutes.length ? " · " : ""}{changedLinks.size} pending link {changedLinks.size === 1 ? "change" : "changes"}{/if}
        </span>
        <button type="button" disabled={submitting || refreshing || dragging !== null} onclick={() => void submitEdits()}>{submitting ? "Submitting…" : "Submit"}</button>
        <button type="button" disabled={submitting} onclick={cancelEdits}>Cancel</button>
      </div>
      {#if removedOutputs}
        <p>Submitting will remove {removedOutputs} {removedOutputs === 1 ? "output route" : "output routes"} from stopped extractors.</p>
      {/if}
      {#if removedLinkRoutes}
        <p>Submitting will remove {removedLinkRoutes} {removedLinkRoutes === 1 ? "route" : "routes"} through decommissioned links.</p>
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
    <aside class="planet-overview" class:link-overview={link || linking}>
      {#if linking}
        <div class="installation-heading">
          <strong>Create Link</strong>
          <button type="button" aria-label="Cancel link placement" onclick={closeLink}>×</button>
        </div>
        <p>{linkOrigin ? "Select the destination installation." : "Select the source installation."}</p>
        {#if linkOrigin}<p>{linkOrigin.typeName} · {pinDesignator(linkOrigin.pinID)}</p>{/if}
        {#if linkFactsError || linkError}<p role="alert">{linkFactsError || linkError}</p>{/if}
      {:else if link}
        {#key linkKey(link.endpoint1, link.endpoint2)}
          <PlanetLink colony={routeView} {link} recipes={$planets.recipes} facts={linkFacts} factsError={linkFactsError}
            disabled={submitting || refreshing} {flow} close={() => { closeLink(); highlight = []; }}
            upgrade={upgradeLink} remove={removeLink} highlight={(value) => { highlight = value; }} />
        {/key}
      {:else if selected}
        <div class="installation-heading">
          <TypeIcon typeID={selected.typeID} name={selected.typeName} />
          <strong>{selected.typeName}</strong>
          <button type="button" aria-label="Close installation details" disabled={submitting} onclick={() => { closeRoute(); closeTransfer(); selectedID = null; }}>×</button>
        </div>
        {#if selected.schematicName}<p>Recipe <strong>{selected.schematicName}</strong></p>{/if}
        {#if selected.kind === "factory" && selected.schematicID !== null && selected.active != null}
          <p class="processor-status">{selected.active ? "Processing" : "Waiting for inputs"}</p>
        {/if}
        {#if selected.kind === "command"}<p>Command centre level <strong>{colony.commandCenterLevel}</strong></p>{/if}
        {#if selected.program?.resourceTypeName}<p>Resource <strong>{selected.program.resourceTypeName}</strong></p>{/if}
        {#if selected.kind === "extractor-control"}
          {#if pendingResource}<p>Pending program <strong>{pendingResource}</strong></p>
          {:else if selectedEdit?.stopped}<p>Program queued to stop</p>{/if}
          <button type="button" disabled={!ready} onclick={() => openExtractor(selected)}>Survey for Deposits</button>
        {/if}
        {#if !isStorage(selected) && selected.contents.length}
          {#if selected.kind === "factory"}<p>Input buffer</p>{/if}
          <ul class="planet-contents">
            {#each selected.contents as item (item.typeID)}
              <li>{item.typeName ?? "Commodity"} <span>{item.quantity.toLocaleString()}</span></li>
            {/each}
          </ul>
        {/if}
        <p>{networkView.links.filter(link => link.endpoint1 === selected.pinID || link.endpoint2 === selected.pinID).length} links ·
          {networkView.routes.filter(route => route.path.includes(selected.pinID)).length} routes</p>
        {#if !routing && !transferring}
          <button type="button" disabled={!ready || submitting || refreshing} onclick={() => startLink(selected)}>Create Link from Here</button>
        {/if}
        {#if transferring}
          {#key transferPath.at(-1) ?? null}
            <ExpeditedTransfer {colony} source={selected} path={transferPath} recipes={$planets.recipes} {flow}
              clockOffsetMs={$planets.clockOffsetMs} submitting={submitting || refreshing} submitError={transferError}
              choose={chooseTransferDestination} close={closeTransfer} execute={(cargo) => void executeTransfer(cargo)} />
          {/key}
        {:else}
          {#key selected.pinID}
            <PlanetRouting bind:this={routePanel} pin={selected} colony={routeView} recipes={$planets.recipes} {flow}
              routes={routeRows} removing={removedIDs} path={routePath} {routing} {routeTypeID} {waypointError} disabled={submitting}
              sourceChanging={selectedEdit?.resourceID !== undefined} start={startRoute} {addWaypoint} close={closeRoute}
              transferBlocked={pending || refreshing} {startTransfer}
              highlight={(value) => { highlight = value; }} stage={stageRoute} toggleRemoval={toggleRouteRemoval} />
          {/key}
        {/if}
      {/if}
      {#if budget}
        <dl class="colony-budget">
          <div><dt>Colony CPU</dt><dd>{budget.cpu.toLocaleString()} / {budget.cpuSupply.toLocaleString()} tf</dd></div>
          <div><dt>Colony power</dt><dd>{budget.power.toLocaleString()} / {budget.powerSupply.toLocaleString()} MW</dd></div>
        </dl>
      {/if}
      {#if !link && !linking && !routing && !transferring && networkView.links.length}
        <details>
          <summary>Links ({networkView.links.length})</summary>
          <ul>
            {#each networkView.links as item (linkKey(item.endpoint1, item.endpoint2))}
              <li><button type="button" onclick={() => openLink(item)}>
                {pinDesignator(item.endpoint1)} — {pinDesignator(item.endpoint2)} · Level {item.level}
              </button></li>
            {/each}
          </ul>
        </details>
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
  .installation-marker.waypoint { color: #a9ffac; outline: 2px solid currentColor; outline-offset: 2px; }
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
  .planet-title button { margin-inline-start: auto; }
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
  .planet-overview { bottom: 16px; right: 16px; width: min(310px, calc(100% - 32px)); max-height: calc(100% - 144px); overflow: auto; display: grid; gap: 8px; }
  .planet-overview.link-overview { width: min(350px, calc(100% - 32px)); }
  .rubber-link { position: absolute; z-index: 1; pointer-events: none; display: grid; gap: 2px;
    padding: 4px 7px; background: #0a131bf2; border: 1px solid #83b994; font-size: 12px; white-space: nowrap; }
  .colony-budget { margin: 0; padding-top: 6px; border-top: 1px solid #819fad44; }
  .colony-budget div { display: flex; justify-content: space-between; gap: 6px; }
  .colony-budget dd { margin: 0; }
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
