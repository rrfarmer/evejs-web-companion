<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { PlanetScene, type PlanetMarkerPosition } from "../play/planetScene.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { Colony, ColonyPin } from "../store/types.ts";
  import ColonyTemplate from "./ColonyTemplate.svelte";
  import TypeIcon from "./TypeIcon.svelte";

  let { colony, store, flow, onClose }: { colony: Colony; store: ClientStore; flow: AppFlow; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const planets = store.planets;
  let host: HTMLDivElement;
  let closeButton: HTMLButtonElement;
  let scene = $state.raw<PlanetScene | null>(null);
  let positions = $state.raw<readonly PlanetMarkerPosition[]>([]);
  let selectedID = $state<number | null>(null);
  let templateShown = $state(false);
  let ready = $state(false);
  let error = $state("");
  const centre = $derived(colony.pins.find(pin => pin.kind === "command" && pin.latitude != null && pin.longitude != null));
  const pinsByID = $derived(new Map(colony.pins.map(pin => [pin.pinID, pin])));
  const selected = $derived(selectedID === null ? undefined : pinsByID.get(selectedID));

  function select(pin: ColonyPin, moveCamera = false): void {
    selectedID = pin.pinID;
    if (moveCamera) scene?.focus(pin);
  }

  onMount(() => {
    let disposed = false;
    let view: PlanetScene | undefined;
    closeButton.focus();
    try {
      view = new PlanetScene(host, markers => { positions = markers; });
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
          onclick={() => select(pin)}></button>
      {/if}
    {/each}
  </div>
  <header class="planet-toolbar">
    <div class="planet-title">
      <h1>{colony.planetName ?? "Planet"}</h1>
      {#if colony.planetTypeName}<p>{colony.planetTypeName}</p>{/if}
    </div>
    <div class="planet-actions">
      <button type="button" disabled={!ready || !centre} onclick={() => scene?.focus(centre)}>Focus Command Center</button>
      <button type="button" aria-expanded={templateShown} onclick={() => { templateShown = !templateShown; }}>Templates</button>
      <button type="button" bind:this={closeButton} onclick={onClose}>Exit Planet Mode</button>
    </div>
  </header>
  {#if error}
    <p class="planet-message" role="alert">{error}</p>
  {:else if !ready}
    <p class="planet-message" role="status">Loading planet surface…</p>
  {/if}
  {#if templateShown}
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
  .planet-markers { pointer-events: none; }
  .installation-marker { position: absolute; transform: translate(-50%, -50%); pointer-events: auto; cursor: pointer; width: 17px; height: 17px;
    min-width: 0; min-height: 0; box-sizing: border-box;
    border: 1px solid currentColor; border-radius: 50%; background: #10222b; color: #a9d9e3; padding: 0; box-shadow: 0 0 0 2px #071018b0; }
  .installation-marker::after { content: ""; display: block; background: currentColor; width: 5px; height: 5px; margin: auto; border-radius: 50%; }
  .installation-marker.command { color: #ffd38a; }
  .installation-marker.factory { color: #ffae76; }
  .installation-marker.extractor-control { color: #b2e7a8; }
  .installation-marker:hover, .installation-marker:focus-visible, .installation-marker.chosen { z-index: 1; outline: 2px solid currentColor; outline-offset: 2px; }
  .planet-toolbar, .planet-overview, .planet-template, .planet-message { position: absolute; }
  .planet-toolbar, .planet-overview, .planet-message { border: 1px solid #819fad65; background: #0a131be8; padding: 10px 12px; }
  .planet-toolbar { top: 14px; right: 16px; width: min(420px, calc(100% - 32px)); display: grid; gap: 8px; }
  .planet-title { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; }
  h1 { margin: 0; font-size: 22px; font-weight: 600; }
  p { margin: 0; }
  .planet-title p { color: #a1b7c4; }
  .planet-actions, .installation-heading { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  button:not(.installation-marker) { background: #283643; color: inherit; border: 1px solid #536673; border-radius: 0; padding: 5px 8px; font: inherit; cursor: pointer; }
  button:not(.installation-marker):hover { border-color: #a7dbe8; }
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
</style>
