<script lang="ts">
  import { tick, untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { getShipTreeCatalogue, getSystemStations } from "../app/api.ts";
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import { ACADEMY_BUTTON, EXORDIUM_REGION } from "../bridge/academyShips.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import {
    AIR_FACTION, AIR_SHIP_TOP, AIR_TREE_FACTION, SHIP_TREE_FACTIONS, TREE_CHROME_PAD,
    raceShipTree, shipTreeFaction, shipTreeGraph, type ShipTreeCatalogue, type ShipTreeIcon, type ShipTreeNode,
  } from "../bridge/shipTree.ts";
  import { clientTexture } from "../play/window.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { capturePointer, releasePointer } from "./pointerCapture.ts";
  import { shipTreeSelection } from "./shipTreeSelection.ts";
  import { showInfo } from "./showInfo.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const { flight, names, station, words } = store;
  // svelte-ignore state_referenced_locally
  const selected = shipTreeSelection(flow);
  // svelte-ignore state_referenced_locally
  const academyChanged = flow.academyChanged;
  const place = $derived(sessionPlace($flight.status, $station.online));
  const pilotFaction = $derived(raceShipTree($station.online?.raceID));

  let catalogue = $state.raw<ShipTreeCatalogue | null | undefined>();
  let failure = $state("");
  let canShowAIR = $state<boolean | null>(null);
  let factionDescription = $state("");
  let viewport = $state<HTMLDivElement | null>(null);
  let pointer = $state<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  let zoom = $state(1);
  let history = $state<number[]>([]);
  let historyAt = $state(-1);
  const missingIcons = new SvelteSet<number>();
  const mainFactions = new Set(SHIP_TREE_FACTIONS.slice(0, 4).map(({ id }) => id));
  const tipPrefix = $props.id();

  const factionID = $derived($selected === AIR_FACTION && canShowAIR !== true ? pilotFaction : ($selected ?? pilotFaction));
  const faction = $derived(shipTreeFaction(factionID)!);
  const air = $derived(factionID === AIR_FACTION);
  const graph = $derived(catalogue ? shipTreeGraph(catalogue, factionID, canShowAIR === true) : null);
  const background = $derived(clientTexture(`res:/UI/Texture/Classes/ShipTree/factionBG/${faction.background ?? faction.image}.png`));
  const shipTop = $derived(air ? AIR_SHIP_TOP : 24);
  const branchY = $derived(air ? 143 : 40);
  const bounds = $derived.by(() => {
    const nodes = graph?.nodes ?? [];
    const left = Math.min(0, ...nodes.map(node => node.x)) - 28;
    const top = Math.min(0, ...nodes.map(node => node.y)) - 30;
    const right = Math.max(0, ...nodes.map(node => node.x + TREE_CHROME_PAD + Math.max(1, Math.min(node.columns, node.ships.length)) * (node.iconSize + 1))) + 30;
    const bottom = Math.max(0, ...nodes.map(node => node.y + shipTop + Math.max(1, Math.ceil(node.ships.length / node.columns)) * (node.iconSize + 1))) + 32;
    return { left, top, width: right - left, height: bottom - top };
  });

  $effect(() => {
    let current = true;
    flow.requestWords([ACADEMY_BUTTON, "UI/ShipTree/ExitShipTree"]);
    flow.requestNames(SHIP_TREE_FACTIONS.map(({ id }) => ({ kind: "faction", id })));
    void getShipTreeCatalogue(flow.requestOptions()).then(read => {
      if (current) catalogue = read;
    }).catch(error => { if (current) failure = errorWords(error); });
    return () => { current = false; };
  });

  let checkedSystem: number | null = null;
  $effect(() => {
    const systemID = place.solarSystemID;
    void $academyChanged;
    if (systemID === null) { canShowAIR = false; return; }
    if (systemID !== checkedSystem) canShowAIR = null;
    checkedSystem = systemID;
    let current = true;
    void getSystemStations(systemID, flow.requestOptions()).then(async system => {
      const available = system.regionID === EXORDIUM_REGION && await flow.academyShipState() !== null;
      if (!current) return;
      canShowAIR = available;
      if (!available && selected.get() === AIR_FACTION) selected.set(null);
    }).catch(() => { if (current) canShowAIR = false; });
    return () => { current = false; };
  });

  $effect(() => {
    const id = factionID, currentGraph = graph;
    if (!currentGraph || ($selected === AIR_FACTION && canShowAIR === null)) return;
    const typeIDs = new Set([670, ...currentGraph.nodes.flatMap(node => node.ships.map(ship => ship.typeID))]);
    const labelIDs = new Set(currentGraph.nodes.flatMap(node => {
      const label = node.groupID === null ? null : catalogue?.classes[node.groupID]?.nameID;
      return label ? [`#${label}`] : [];
    }));
    for (const { ships } of currentGraph.nodes) {
      for (const { nameID } of ships) if (nameID) labelIDs.add(`#${nameID}`);
    }
    flow.requestNames([...typeIDs].map(typeID => ({ kind: "type", id: typeID })));
    flow.requestWords([...labelIDs]);
    untrack(() => {
      const previous = history[historyAt];
      if (previous === id) return;
      history = [...history.slice(0, historyAt + 1), id];
      historyAt = history.length - 1;
    });
  });

  $effect(() => {
    const id = factionID;
    let current = true;
    factionDescription = "";
    void flow.factionShowInfo(id).then(info => {
      if (current) factionDescription = plainText(info?.description ?? "");
    }).catch(() => {});
    return () => { current = false; };
  });

  let lastPannedFaction: number | null = null;
  $effect(() => {
    const id = factionID, scroller = viewport;
    const first = graph?.nodes.find(node => node.kind === "group");
    if (!scroller || !first || lastPannedFaction === id) return;
    const previous = lastPannedFaction;
    lastPannedFaction = id;
    if (previous !== null && mainFactions.has(previous) && mainFactions.has(id)) return;
    void tick().then(() => {
      if (viewport !== scroller || factionID !== id) return;
      scroller.scrollLeft = Math.max(0, (first.x - bounds.left) * zoom - scroller.clientWidth / 3);
      scroller.scrollTop = Math.max(0, (first.y - bounds.top) * zoom - scroller.clientHeight / 2);
    });
  });

  function factionName(id: number): string {
    if (id === AIR_FACTION) return plainText($words.templates[ACADEMY_BUTTON] ?? AIR_TREE_FACTION.name);
    return resolvedName($names.resolved, "faction", id, shipTreeFaction(id)?.name ?? "");
  }

  function factionIcon(id: number): string {
    return clientTexture(id === AIR_FACTION ? "res:/UI/Texture/eveicon/faction_logos/air_logo_64px.png"
      : `res:/UI/Texture/Classes/ShipTree/factions/${shipTreeFaction(id)?.image}.png`);
  }

  function groupName(id: number | null): string {
    const nameID = id === null ? null : catalogue?.classes[id]?.nameID;
    return nameID ? plainText($words.templates[`#${nameID}`] ?? "") : "";
  }

  function typeName(typeID: number, icon: ShipTreeIcon): string {
    const local = icon.nameID ? $words.templates[`#${icon.nameID}`] : null;
    return resolvedName($names.resolved, "type", typeID, local ? plainText(local) : typeID === 670 ? "Capsule" : "Ship");
  }

  function silhouetteFailed(typeID: number) {
    missingIcons.add(typeID);
  }

  function moveHistory(delta: number) {
    let at = historyAt + delta;
    if (!canShowAIR && history[at] === AIR_FACTION) at += delta;
    const id = history[at];
    if (id === undefined) return;
    historyAt = at;
    selected.set(id);
  }

  async function changeZoom(value: number) {
    const scroller = viewport;
    if (!scroller || zoom === value) return;
    const centreX = (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth;
    const centreY = (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight;
    zoom = value;
    await tick();
    if (viewport !== scroller) return;
    scroller.scrollLeft = centreX * scroller.scrollWidth - scroller.clientWidth / 2;
    scroller.scrollTop = centreY * scroller.scrollHeight - scroller.clientHeight / 2;
  }

  function startPan(event: PointerEvent) {
    if (!viewport || event.button !== 0 || event.pointerType === "touch" || (event.target as HTMLElement).closest("button")) return;
    capturePointer(viewport, event.pointerId);
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
  }

  function pan(event: PointerEvent) {
    if (!viewport || pointer?.id !== event.pointerId) return;
    viewport.scrollLeft = pointer.left + pointer.x - event.clientX;
    viewport.scrollTop = pointer.top + pointer.y - event.clientY;
  }

  function stopPan(event: PointerEvent) {
    if (!viewport || pointer?.id !== event.pointerId) return;
    releasePointer(viewport, pointer.id);
    pointer = null;
  }

  function edgeStyle(from: ShipTreeNode, to: ShipTreeNode) {
    let x = from.x + 22;
    const y = from.y + branchY;
    if (from.kind === "group" && from.y === to.y) {
      x = from.x + Math.min(from.ships.length, from.columns) * (from.iconSize + 1) + (from.chrome ? TREE_CHROME_PAD : 0);
    }
    const dx = to.x + 22 - x, dy = to.y + branchY - y;
    return `left:${x - bounds.left}px;top:${y - bounds.top}px;width:${Math.hypot(dx, dy)}px;rotate:${Math.atan2(dy, dx)}rad`;
  }
</script>

{#snippet hull(typeID: number, icon: ShipTreeIcon, className: string, academyOverlay = false)}
  {@const name = typeName(typeID, icon)}
  {@const description = icon.descriptionID ? plainText($words.templates[`#${icon.descriptionID}`] ?? "") : ""}
  <div class="hull">
    <button type="button" class="ship-icon" aria-label={name} aria-describedby={`${tipPrefix}-${typeID}`} class:academy-overlay={academyOverlay}
      onfocus={() => icon.descriptionID && flow.requestWords([`#${icon.descriptionID}`])}
      onpointerenter={() => icon.descriptionID && flow.requestWords([`#${icon.descriptionID}`])}
      onclick={() => showInfo({ kind: "type", typeID })}>
      {#if icon.holoIcon && !missingIcons.has(typeID)}
        <img class="silhouette" alt="" src={clientTexture(icon.holoIcon)} onerror={() => silhouetteFailed(typeID)} draggable="false" />
      {:else}
        <span aria-hidden="true"><TypeIcon {typeID} {name} size="lg" /></span>
      {/if}
    </button>
    <div class="ship-tip" role="tooltip" id={`${tipPrefix}-${typeID}`}>
      <strong>{name}</strong>
      {#if className}<span>{className}</span>{/if}
      {#if description}<p>{description}</p>{/if}
    </div>
  </div>
{/snippet}

<div class="ship-tree">
  <aside>
    <div class="history">
      <button type="button" aria-label="Back" disabled={historyAt <= 0} onclick={() => moveHistory(-1)}>‹</button>
      <button type="button" aria-label="Forward" disabled={historyAt >= history.length - 1} onclick={() => moveHistory(1)}>›</button>
    </div>
    <nav aria-label="Ship Tree factions">
      {#each SHIP_TREE_FACTIONS as tree (tree.id)}
        <button type="button" class="faction-button" aria-label={factionName(tree.id)} title={factionName(tree.id)}
          aria-pressed={factionID === tree.id} onclick={() => selected.set(tree.id)}>
          <img alt="" src={factionIcon(tree.id)} />
        </button>
      {/each}
    </nav>
    {#if canShowAIR}
      <button type="button" class="air-choice" aria-pressed={air} onclick={() => selected.set(AIR_FACTION)}>
        <img alt="" src={factionIcon(AIR_FACTION)} />{factionName(AIR_FACTION)}
      </button>
    {/if}
    <div class="faction-copy">
      <h2>{factionName(factionID)}</h2>
      {#if factionDescription}<p>{factionDescription}</p>{/if}
    </div>
  </aside>
  <section class="tree-pane" aria-label={factionName(factionID)} style:--faction-background={`url("${background}")`}>
    <div class="zoom" aria-label="Ship Tree zoom">
      <button type="button" aria-label="Zoom out" disabled={zoom === 0.5} onclick={() => changeZoom(0.5)}>−</button>
      <button type="button" aria-label="Zoom in" disabled={zoom === 1} onclick={() => changeZoom(1)}>+</button>
    </div>
    {#if failure}<p role="alert">{failure}</p>
    {:else if catalogue === null}<p role="status">Ship Tree data is unavailable from the installed client.</p>
    {:else if !graph || ($selected === AIR_FACTION && canShowAIR === null)}
      <p role="status">Loading Ship Tree…</p>
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable graph supports keyboard and pointer panning.) -->
      <div class="viewport" class:panning={pointer !== null} bind:this={viewport} role="region" aria-label="Hull progression" tabindex="0"
        onpointerdown={startPan} onpointermove={pan} onpointerup={stopPan} onpointercancel={stopPan} onlostpointercapture={stopPan}>
        <div class="canvas" style:--width={`${bounds.width * zoom}px`} style:--height={`${bounds.height * zoom}px`}>
          <div class="graph" style:--scale={zoom}>
            {#each graph.edges as edge}
              <span class="edge" style={edgeStyle(graph.nodes[edge.from]!, graph.nodes[edge.to]!)}></span>
            {/each}
            {#each graph.nodes as node (node.id)}
              {@const x = node.x - bounds.left}
              {@const y = node.y - bounds.top}
              {@const className = groupName(node.groupID)}
              {#if node.kind === "root" && catalogue}
                <div class="capsule" style:left={`${x + 6}px`} style:top={`${y + branchY - 18}px`}>
                  {@render hull(670, catalogue.capsule, "")}
                </div>
              {:else if node.kind === "group"}
                <div class="ship-group" style:left={`${x}px`} style:top={`${y}px`} style:--ship-size={`${node.iconSize}px`}
                  style:--pad={node.chrome ? `${TREE_CHROME_PAD}px` : "0px"} style:--top={`${shipTop}px`} style:--columns={node.columns}>
                  {#if air}
                    <button type="button" class="branch-flag" aria-label={`Open ${factionName(node.factionID)} Ship Tree`}
                      title={factionName(node.factionID)} onclick={() => selected.set(node.factionID)}>
                      <img alt="" src={factionIcon(node.factionID)} />
                    </button>
                  {/if}
                  {#if node.chrome}
                    {@const icon = node.groupID === null ? null : catalogue?.classes[node.groupID]?.iconSmall}
                    <div class="group-heading" class:academy-class={air}>
                      {#if icon}<img alt="" title={className} src={clientTexture(icon)} />{/if}
                      {#if !air}<span>{className}</span>{/if}
                    </div>
                  {/if}
                  <div class="ships" aria-label={`${factionName(node.factionID)} ${className}`}>
                    {#each node.ships as ship (ship.typeID)}
                      {@render hull(ship.typeID, ship, className, ship.academy && !air)}
                    {/each}
                  </div>
                </div>
              {:else if node.kind === "faction"}
                <button type="button" class="connected-faction" style:left={`${x - 1}px`} style:top={`${y + branchY - 23}px`}
                  aria-label={`Open ${factionName(node.factionID)} Ship Tree`} title={factionName(node.factionID)} onclick={() => selected.set(node.factionID)}>
                  <img alt="" src={factionIcon(node.factionID)} />
                </button>
              {/if}
            {/each}
          </div>
        </div>
      </div>
    {/if}
  </section>
</div>

<style>
  .ship-tree { min-height: 100%; height: 100%; display: grid; grid-template-columns: 274px minmax(0, 1fr); background: #09121a; color: #d7e9f0; }
  aside { min-height: 0; padding: 12px; overflow: auto; border-right: 1px solid #45616b; background: #0e161d; }
  button { color: inherit; cursor: pointer; }
  button:disabled { opacity: .35; cursor: default; }
  button:focus-visible { outline: 2px solid #b8edf4; outline-offset: 2px; }
  .history, .zoom { display: flex; gap: 4px; }
  .history button, .zoom button { width: 28px; height: 28px; border: 1px solid #385867; background: #162733; }
  nav { margin: 9px 0 6px; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 2px; }
  .faction-button, .air-choice { background: #142632; border: 1px solid #374e5b; }
  .faction-button { aspect-ratio: 1; padding: 3px; }
  .faction-button img { width: 100%; height: 100%; object-fit: contain; }
  .faction-button[aria-pressed="true"], .air-choice[aria-pressed="true"], .faction-button:hover, .air-choice:hover { border-color: #8caeb9; background: #253d4b; }
  .air-choice { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 9px; }
  .air-choice img { width: 26px; height: 26px; object-fit: contain; }
  .faction-copy { margin-top: 12px; border-top: 1px solid #385867; padding-top: 10px; }
  .faction-copy h2 { font-size: 17px; margin: 0 0 6px; }
  p { margin: 0; font-size: 13px; line-height: 1.45; }
  .tree-pane { position: relative; min-width: 0; min-height: 0; isolation: isolate; overflow: hidden; }
  .tree-pane::before, .tree-pane::after { position: absolute; inset: 0; z-index: -1; content: ""; pointer-events: none; }
  .tree-pane::before { background: var(--faction-background) center / min(100%, 850px) auto no-repeat; opacity: .18; }
  .tree-pane::after { background: url('/client-res/ui/texture/classes/shiptree/grid.png') center repeat; opacity: .2; }
  .tree-pane > p { padding: 16px; }
  .zoom { position: absolute; z-index: 4; top: 8px; right: 10px; }
  .viewport { position: relative; height: 100%; overflow: auto; contain: paint; cursor: grab; }
  .viewport.panning { cursor: grabbing; user-select: none; }
  .canvas { position: relative; min-width: max(100%, var(--width)); min-height: max(100%, var(--height)); overflow: clip; }
  .graph { position: absolute; inset: max(0px, calc((100% - var(--height)) / 2)) auto auto max(0px, calc((100% - var(--width)) / 2)); transform: scale(var(--scale)); transform-origin: top left; }
  .edge { position: absolute; height: 2px; transform-origin: left center; background: #6f9cac; opacity: .5; }
  .capsule, .ship-group, .connected-faction { position: absolute; }
  .capsule { --ship-size: 32px; }
  .group-heading { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 4px; height: 23px; white-space: nowrap; font-size: 13px; }
  .group-heading img { width: 19px; height: 19px; object-fit: contain; margin-left: 20px; }
  .academy-class { top: 126px; height: 34px; }
  .branch-flag { position: absolute; top: 0; left: var(--pad); width: var(--ship-size); height: 48px; background: none; border: 0; }
  .branch-flag::after { content: ""; position: absolute; top: 48px; left: 50%; height: 78px; border-left: 1px solid #7bacbb99; pointer-events: none; }
  .branch-flag img, .connected-faction img { width: 46px; height: 46px; object-fit: contain; }
  .connected-faction { padding: 0; background: none; border: 0; }
  .ships { position: relative; left: var(--pad); top: var(--top); display: grid; grid-template-columns: repeat(var(--columns), var(--ship-size)); gap: 1px; }
  .hull { position: relative; width: var(--ship-size); height: var(--ship-size); }
  .ship-icon { width: 100%; height: 100%; padding: 0; border: 1px solid #50748688; background: #204255 url('/client-res/ui/texture/classes/shiptree/groups/bgvignette.png') center / 100% 100% no-repeat; background-blend-mode: multiply; }
  .ship-icon:hover, .ship-icon:focus-visible { border-color: #9bc8d7; background-color: #264858; }
  .ship-icon.academy-overlay { background-image: url('/client-res/ui/texture/classes/shiptree/academyships/academy_overlay.png'); border-color: #4f9d9f; }
  .silhouette { width: 78%; height: 78%; object-fit: contain; mix-blend-mode: screen; }
  .capsule .ship-icon { border: none; background: transparent; }
  .capsule .silhouette { width: 100%; height: 100%; }
  .ship-tip { display: none; pointer-events: none; position: absolute; z-index: 3; bottom: calc(100% + 7px); left: 0; width: 225px; border: 1px solid #5f8897; background: #111c25; padding: 8px; }
  .ship-tip strong, .ship-tip span { display: block; }
  .ship-tip span { color: #9cc4d4; margin: 2px 0 4px; }
  .ship-tip p { max-height: 140px; overflow: hidden; }
  .hull:hover, .hull:focus-within { z-index: 2; }
  .hull:hover .ship-tip, .hull:focus-within .ship-tip { display: block; }
  @media (max-width: 750px) {
    .ship-tree { grid-template-columns: minmax(110px, 29%) minmax(0, 1fr); }
    aside { padding: 7px; }
    nav { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
</style>
