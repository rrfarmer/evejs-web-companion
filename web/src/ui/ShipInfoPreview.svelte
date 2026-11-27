<script lang="ts">
  import { untrack } from "svelte";
  import type { ShipInfoScene } from "../play/shipInfoScene.ts";
  import type { ShipSkinrBlendMode, ShipSkinrPatternPreview, ShipSkinrProjectorGesture } from "../bridge/shipSkinrPatterns.ts";
  import { capturePointer, releasePointer } from "./pointerCapture.ts";

  let { typeID, factionID, active, expanded, coatings, patterns, blendMode, darkhullChannel, clearedTechCoating, onProjectorGesture, skinMaterialSetID }: {
    typeID: number; factionID: number | null | undefined; active: boolean; expanded: boolean;
    coatings?: readonly (string | null)[];
    patterns?: readonly ShipSkinrPatternPreview[];
    blendMode?: ShipSkinrBlendMode;
    darkhullChannel?: number;
    clearedTechCoating?: boolean;
    skinMaterialSetID?: number | null;
    onProjectorGesture?: (gesture: ShipSkinrProjectorGesture) => void;
  } = $props();
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
    const surface = host;
    if (!surface || !onProjectorGesture) return;
    let drag: { id: number; x: number; y: number; buttons: number } | null = null;
    let suppressMenu = false;
    let lastSnap = -Infinity;
    const down = (event: PointerEvent) => {
      if (event.button === 2) suppressMenu = event.ctrlKey;
      if (!event.ctrlKey || event.pointerType !== "mouse" || !(event.buttons & 3)) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, buttons: event.buttons };
      capturePointer(surface, event.pointerId);
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      if (!(event.buttons & 3)) { end(event); return; }
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag = { ...drag, x: event.clientX, y: event.clientY, buttons: event.buttons };
      if (!event.ctrlKey || !scene || (!dx && !dy)) return;
      if (event.buttons & 2) suppressMenu = true;
      onProjectorGesture?.({ kind: "drag", dx, dy, buttons: event.buttons, ...scene.projectorView(),
        precision: event.shiftKey, alt: event.altKey });
      event.preventDefault();
    };
    const end = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      drag = null;
      releasePointer(surface, event.pointerId);
    };
    const menu = (event: MouseEvent) => {
      if (event.ctrlKey || suppressMenu) event.preventDefault();
      suppressMenu = false;
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !event.deltaY) return;
      event.preventDefault();
      const buttons = event.buttons || drag?.buttons || 0;
      const snap = event.altKey && (buttons & 3) !== 3;
      if (snap) {
        if (event.timeStamp - lastSnap < 50) return;
        lastSnap = event.timeStamp;
      }
      const units = event.deltaMode === 1 ? 0.04 : event.deltaMode === 2 ? 0.12 : 0.0012;
      onProjectorGesture?.({ kind: "wheel", delta: -event.deltaY * units, buttons, precision: event.shiftKey, snap });
    };
    const listeners = new AbortController();
    const { signal } = listeners;
    surface.addEventListener("pointerdown", down, { signal });
    // Chromium can release capture when the second mouse button is pressed.
    // Keep the active chord until pointerup or pointercancel, including outside the preview.
    window.addEventListener("pointermove", move, { signal });
    window.addEventListener("pointerup", end, { signal });
    window.addEventListener("pointercancel", end, { signal });
    surface.addEventListener("contextmenu", menu, { signal });
    surface.addEventListener("wheel", wheel, { passive: false, signal });
    return () => {
      listeners.abort();
      if (drag) releasePointer(surface, drag.id);
    };
  });
  $effect(() => {
    const id = typeID;
    const faction = factionID;
    const view = scene;
    if (!view || faction === undefined) return;
    let current = true;
    if (untrack(() => load) !== "shown") load = "waiting";
    void view.show(id, faction, coatings, patterns, blendMode, darkhullChannel, clearedTechCoating, skinMaterialSetID).then(shown => {
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
  <div class="scene" class:shown={load === "shown"} class:interactive={expanded}
    class:projector={!!onProjectorGesture} bind:this={host}></div>
  {#if load !== "shown"}<p role="status">{load === "waiting" ? "Loading ship preview…" : "Ship preview unavailable"}</p>{/if}
</div>

<style>
  .ship-preview { position: relative; width: 100%; height: 100%; background: #000; overflow: hidden; }
  .scene { width: 100%; height: 100%; visibility: hidden; }
  .scene.shown { visibility: visible; }
  .scene.interactive { cursor: grab; }
  .scene:not(.interactive, .projector) { pointer-events: none; }
  .scene.projector { touch-action: none; }
  .scene.interactive:active { cursor: grabbing; }
  p { position: absolute; inset: 0; display: grid; place-items: center; color: #cdd2d7; margin: 0; }
</style>
