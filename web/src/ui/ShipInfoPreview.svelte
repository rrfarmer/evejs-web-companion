<script lang="ts">
  import { getHullBrowser } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ShipInfoScene } from "../play/shipInfoScene.ts";

  let { typeID, active, expanded, flow }: { typeID: number; active: boolean; expanded: boolean; flow: AppFlow } = $props();
  const keyboardHelp = $props.id();
  let host = $state<HTMLElement | null>(null);
  let scene = $state.raw<ShipInfoScene | null>(null);
  let load = $state<"waiting" | "shown" | "unavailable">("waiting");

  $effect(() => {
    const element = host;
    if (!element) return;
    let current = true;
    void import("../play/shipInfoScene.ts").then(({ ShipInfoScene }) => {
      if (current) scene = new ShipInfoScene(element);
    }).catch(() => { if (current) load = "unavailable"; });
    return () => { current = false; scene?.close(); };
  });

  $effect(() => { scene?.setActive(active && load !== "unavailable"); });
  $effect(() => { scene?.setExpanded(expanded); });
  $effect(() => {
    const id = typeID;
    const view = scene;
    if (!view) return;
    let current = true;
    load = "waiting";
    void getHullBrowser([id], flow.requestOptions()).catch(() => null).then(facts => {
      if (current) return view.show(id, facts?.types[id]?.factionID ?? null);
    }).then(shown => {
      if (current) load = shown ? "shown" : "unavailable";
    }).catch(() => { if (current) load = "unavailable"; });
    return () => { current = false; };
  });

  function key(event: KeyboardEvent) {
    if (!scene || !expanded) return;
    switch (event.key) {
      case "ArrowLeft": scene.orbit(0.12, 0); break;
      case "ArrowRight": scene.orbit(-0.12, 0); break;
      case "ArrowUp": scene.orbit(0, -0.12); break;
      case "ArrowDown": scene.orbit(0, 0.12); break;
      case "+": case "=": scene.moveZoom(-0.08); break;
      case "-": scene.moveZoom(0.08); break;
      default: return;
    }
    event.preventDefault();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (The canvas group handles orbit and zoom keys.) -->
<div class="ship-preview" role="group" aria-label="Ship preview" aria-describedby={expanded ? keyboardHelp : undefined}
  tabindex={expanded && load === "shown" ? 0 : undefined} onkeydown={key}>
  {#if expanded}<span class="sr-only" id={keyboardHelp}>Use the arrow keys to rotate the ship and plus or minus to zoom.</span>{/if}
  <div class="scene" class:shown={load === "shown"} class:interactive={expanded} bind:this={host}></div>
  {#if load !== "shown"}<p role="status">{load === "waiting" ? "Loading ship preview…" : "Ship preview unavailable"}</p>{/if}
</div>

<style>
  .ship-preview { position: relative; width: 100%; height: 100%; background: #000; overflow: hidden; }
  .scene { width: 100%; height: 100%; visibility: hidden; }
  .scene.shown { visibility: visible; }
  .scene.interactive { cursor: grab; }
  .scene:not(.interactive) { pointer-events: none; }
  .scene.interactive:active { cursor: grabbing; }
  p { position: absolute; inset: 0; display: grid; place-items: center; color: #cdd2d7; margin: 0; }
</style>
