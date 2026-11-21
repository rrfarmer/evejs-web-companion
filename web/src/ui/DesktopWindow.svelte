<script lang="ts">
  // One floating panel window on the desktop: a title bar (drag to move,
  // double-click to put away, buttons to put away/close) over a scrollable body
  // that hosts the real panel. Free-floating and resizable from the right/bottom
  // edges and the SE corner. Pure chrome + pointer math: all window STATE lives in
  // the desktop model (desktop.ts); this component only reports moves/resizes up
  // and clamps a drag so the title bar can never leave the desktop.
  import type { Snippet } from "svelte";
  import type { WinState } from "./desktop.ts";
  import { capturePointer, releasePointer } from "./pointerCapture.ts";

  let {
    win,
    title,
    focused,
    onFocus,
    onClose,
    onToggleMinimize,
    onMove,
    onResize,
    headerActions,
    loading = false,
    resizable = true,
    showTitle = true,
    icon = null,
    killable = true,
    children,
  }: {
    /** Window.killable: false (default_isKillable False - the drones window, the overview, Selected Item) draws no close button. */
    killable?: boolean;
    /** The window's caption icon (Window.default_iconNum), a URL; none where null. */
    icon?: string | null;
    win: Pick<WinState, "x" | "y" | "w" | "h" | "z" | "minimized"> & { readonly id?: string | number };
    title: string;
    focused: boolean;
    onFocus: () => void;
    onClose: () => void;
    /** Put the window away. It stays open, and the strip is how it comes back. */
    onToggleMinimize?: () => void;
    onMove: (x: number, y: number) => void;
    onResize: (w: number, h: number) => void;
    headerActions?: Snippet;
    loading?: boolean;
    resizable?: boolean;
    showTitle?: boolean;
    children: Snippet;
  } = $props();

  let el = $state<HTMLElement | null>(null);

  function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // Drag by the title bar. Pointer capture keeps the drag alive if the cursor
  // outruns the bar; we keep at least a grab-strip of the bar on the desktop so a
  // window can always be dragged back into view.
  function startDrag(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    onFocus();
    const parent = el?.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const originX = win.x;
    const originY = win.y;
    const target = ev.currentTarget as HTMLElement;
    capturePointer(target, ev.pointerId);
    const move = (e: PointerEvent): void => {
      const nx = originX + (e.clientX - startX);
      const ny = originY + (e.clientY - startY);
      onMove(clamp(nx, 0, Math.max(0, rect.width - 48)), clamp(ny, 0, Math.max(0, rect.height - 30)));
    };
    const up = (): void => {
      releasePointer(target, ev.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }

  function startResize(ev: PointerEvent, edge: "e" | "s" | "se"): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    onFocus();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const originW = win.w;
    const originH = win.h;
    const target = ev.currentTarget as HTMLElement;
    capturePointer(target, ev.pointerId);
    const move = (e: PointerEvent): void => {
      const w = edge === "s" ? originW : originW + (e.clientX - startX);
      const h = edge === "e" ? originH : originH + (e.clientY - startY);
      onResize(w, h);
    };
    const up = (): void => {
      releasePointer(target, ev.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<section
  bind:this={el}
  class="win"
  data-win={win.id}
  class:focused
  class:ship-tree-window={win.id === "shipTree"}
  style:display={win.minimized ? "none" : undefined}
  style="left:{win.x}px; top:{win.y}px; width:{win.w}px; height:{win.h}px; z-index:{win.z};"
  onpointerdown={onFocus}
  aria-label={title}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!--
    ⚠ DOUBLE-CLICKING THE BAR PUTS THE WINDOW AWAY, WHERE IT USED TO SHADE IT.
    It is the same gesture on the same target; what it does now is the thing
    that survived — see the note on the buttons below.
  -->
  <header class="win-bar" onpointerdown={startDrag} ondblclick={onToggleMinimize}>
    {#if icon}<img class="win-icon" src={icon} alt="" />{/if}<span class="win-title">{#if showTitle}{title}{/if}</span>
    {#if headerActions}{@render headerActions()}{/if}
    <span class="win-actions">
      <!--
        ⚠ TWO BUTTONS, NOT THREE. There used to be a "collapse" that shaded a
        window down to its title bar, alongside a "put away" that hid it into
        the strip at the bottom. Two ways to get a window out of the way is one
        too many — and the shade is the weaker of the two: it still occupies the
        desktop, still overlaps whatever is under it, and leaves a stub a pilot
        has to find again. Put-away leaves a chip in the strip, which is a
        better handle than a floating stub.

        So the shade is gone, and `—` — the glyph a player already reads as
        "minimize" — is the put-away.
      -->
      {#if onToggleMinimize}<button
        type="button"
        class="win-btn"
        title="Put away"
        aria-label="Put away"
        onpointerdown={(e) => e.stopPropagation()}
        onclick={onToggleMinimize}
      >—</button>{/if}
      {#if killable}<button
        type="button"
        class="win-btn win-close"
        title="Close"
        aria-label="Close"
        onpointerdown={(e) => e.stopPropagation()}
        onclick={onClose}
      >✕</button>{/if}
    </span>
  </header>

  <div class="win-body" inert={loading} aria-busy={loading}>
    {@render children()}
  </div>
  {#if resizable}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span class="win-resize win-resize-e" title="Resize" onpointerdown={(e) => startResize(e, "e")}></span>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span class="win-resize win-resize-s" title="Resize" onpointerdown={(e) => startResize(e, "s")}></span>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <span class="win-resize win-resize-se" title="Resize" onpointerdown={(e) => startResize(e, "se")}></span>
  {/if}
</section>

<style>
  /* The scrollable graph can extend under the title bar during a pan. */
  .ship-tree-window > .win-bar { position: relative; z-index: 1; }
  .ship-tree-window > .win-body { position: relative; isolation: isolate; }
</style>
