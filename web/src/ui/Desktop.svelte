<script lang="ts">
  // The always-open desktop: a positioned surface the floating panel windows live
  // on. It renders one DesktopWindow per open window (a pure reader of the window
  // list App owns), wrapping the real panel via PanelHost. Windows whose tab is
  // not openable in the current state (a docked-only panel after undocking) are
  // hidden here but KEPT in the model, so they reappear on the return trip.
  //
  // R70 — IN SPACE, THE DESKTOP HAS A VIEW OUT OF IT. The tactical viewport fills
  // this surface as its backdrop and the windows float over it, which is the
  // retail client's spatial arrangement and the reason the desktop stops reading
  // as a blank grid with dialogs on it. It is a BACKDROP, not a window: it takes
  // no space in the layout, cannot be closed or focused, and paints below
  // everything because it is first in the DOM and every `.win` is positioned.
  //
  // Docked, it is not drawn at all — there is nothing outside to see, and a
  // starfield behind a market window would be a lie about where you are.
  import DesktopWindow from "./DesktopWindow.svelte";
  import PanelHost from "./PanelHost.svelte";
  import Tactical from "./Tactical.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { tabLabel, isTabVisible, type TabID } from "./tabs.ts";
  import { isWindowTab, MIN_W, MIN_H, type WinState } from "./desktop.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { Session } from "../app/sessions.ts";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { infoWindowLabel } from "./infoWindowLabel.ts";
  import { calendarView } from "./calendarView.ts";

  let {
    store,
    flow,
    wins,
    focused,
    isDocked,
    onFocus,
    onClose,
    onToggleMinimize,
    onMove,
    onResize,
    onOpen,
    onInfoHost,
    onRevealInfo,
    sessions,
    globalWins,
    onToggleGlobalMinimize,
  }: {
    store: ClientStore;
    flow: AppFlow;
    wins: WinState[];
    focused: TabID | null;
    isDocked: boolean;
    onFocus: (id: TabID) => void;
    onClose: (id: TabID) => void;
    onToggleMinimize: (id: TabID) => void;
    onMove: (id: TabID, x: number, y: number) => void;
    onResize: (id: TabID, w: number, h: number) => void;
    onOpen: (id: TabID) => void;
    onInfoHost?: (host: InfoWindowHost | null) => void;
    onRevealInfo?: () => void;
    // R107 — the full pilot roster, threaded down only so the Bot Manager panel
    // can show every held pilot, not just this session's active one. Optional:
    // every other caller/panel is unaffected. See PanelHost.svelte.
    sessions?: readonly Session[];
    /**
     * The GLOBAL windows (globalWindow.ts), listed in this desktop's strip.
     *
     * ⚠ THEY ARE NOT DRAWN HERE — App draws them on its own layer, above the
     * pilot-switch remount. Only their CHIPS come down, and the reason is that
     * putting a window away is ONE act and had grown two answers: a workspace
     * window's chip appeared bottom-left in this strip, a global window's in a
     * second strip of its own in the opposite corner. Two strips is two rules
     * for the same gesture, and the player has to learn which windows obey
     * which. One strip, in one corner, is the whole fix.
     *
     * Optional, because a desktop mounted without App above it (harnesses,
     * tests) has no global layer to list.
     */
    globalWins?: readonly WinState[];
    /** Put a global window away, or bring it back. Owned by App. */
    onToggleGlobalMinimize?: (id: TabID) => void;
  } = $props();

  // Every window this state can show, minimized or not — the strip lists them
  // all, because a window with no visible handle is a window the player has lost.
  const openHere = $derived(wins.filter((w) => isWindowTab(w.id) && isTabVisible(w.id, isDocked)));
  /**
   * The global windows' chips, AFTER this pilot's own.
   *
   * ⚠ LAST, ON PURPOSE. The windows to the left of them belong to the pilot on
   * screen and change with every switch; these do not. Keeping the changing
   * half anchored at the left edge is what stops a chip a player is aiming for
   * moving because another pilot happens to have more windows open.
   */
  const globalChips = $derived(globalWins ?? []);
  // Only the ones actually on the surface get drawn.
  const shown = $derived(openHere.filter((w) => !w.minimized));
  // OpenMemberDetails maximizes the existing dialog, preserving its unsubmitted edits.
  const mounted = $derived(openHere.filter((w) => !w.minimized || w.id === "memberDetails" || w.id === "medalDesigner"));

  let deskEl = $state<HTMLElement | null>(null);
  // svelte-ignore state_referenced_locally
  const infoWindows = flow.infoWindows.state;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const calendar = calendarView(flow);
  const calendarWindows = calendar.windows;
  const auxiliaryTop = $derived(Math.max(0, ...[...$infoWindows, ...$calendarWindows].filter(w => !w.minimized).map(w => w.z)));
  $effect(() => {
    if (!deskEl) return;
    onInfoHost?.({ element: deskEl, mobile: false,
      topZ: () => Math.max(calendar.topZ(), ...wins.map(w => w.z), ...flow.infoWindows.state.get().map(w => w.z)),
      reveal: () => onRevealInfo?.() });
    return () => onInfoHost?.(null);
  });
  /** The desktop's size now, in whole pixels, or null before it is laid out (a window's place is registered with it). */
  export function surfaceSize(): { readonly w: number; readonly h: number } | null {
    const box = deskEl?.getBoundingClientRect();
    return box && box.width > 0 && box.height > 0 ? { w: Math.round(box.width), h: Math.round(box.height) } : null;
  }

  // A window is absolutely positioned and the desktop clips anything past its
  // own box (the same clip R70's tactical view relies on) — so a window placed
  // or sized for a roomier screen (the default cascade plus whatever it was
  // last dragged to) can end up with its title bar and its own resize handles
  // past the visible edge on a narrower one, with nothing reachable on screen
  // to pull it back: the handles that would do it are exactly what's cut off.
  // Whenever the desktop's own box changes size — including first mount — pull
  // every window fully back inside it.
  $effect(() => {
    if (!deskEl) return;
    const el = deskEl;
    const reconcile = (): void => {
      const areaW = el.clientWidth;
      const areaH = el.clientHeight;
      if (areaW <= 0 || areaH <= 0) return;
      // ⚠ Over `wins`, not `shown`: a window put away while the surface was
      // roomy has to be pulled back inside it BEFORE it is restored, or it
      // comes back with its title bar past the edge and no handle to drag.
      for (const win of wins) {
        const w = Math.min(win.w, Math.max(MIN_W, areaW));
        const h = Math.min(win.h, Math.max(MIN_H, areaH));
        if (w !== win.w || h !== win.h) onResize(win.id, w, h);
        const x = Math.min(Math.max(0, win.x), Math.max(0, areaW - w));
        const y = Math.min(Math.max(0, win.y), Math.max(0, areaH - h));
        if (x !== win.x || y !== win.y) onMove(win.id, x, y);
      }
    };
    reconcile();
    const ro = new ResizeObserver(reconcile);
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<div class="desktop" class:has-view={!isDocked} bind:this={deskEl}>
  {#if !isDocked}
    <!-- Its own boundary: a drawing failure must cost the picture, never the
         windows floating on top of it. -->
    <ErrorBoundary name="Tactical view">
      <Tactical {store} {flow} />
    </ErrorBoundary>
  {/if}
  {#if shown.length === 0 && isDocked}
    <!-- Only worth saying when the surface really is empty. In space it is a
         view of the grid, and covering that with a tip about windows would hide
         the most useful thing on screen to explain the least useful. -->
    <p class="desktop-empty">
      Open a panel from the left — it opens here as a window. They stay side by side, so you never
      lose sight of what you were doing.
    </p>
  {/if}
  {#each mounted as win (win.id)}
    <DesktopWindow
      {win}
      title={tabLabel(win.id)}
      focused={focused === win.id && win.z >= auxiliaryTop}
      onFocus={() => onFocus(win.id)}
      onClose={() => onClose(win.id)}
      onToggleMinimize={() => onToggleMinimize(win.id)}
      onMove={(x, y) => onMove(win.id, x, y)}
      onResize={(w, h) => onResize(win.id, w, h)}
      resizable={win.id !== "medalDesigner"}
    >
      <PanelHost {store} {flow} tab={win.id} onOpen={onOpen} onClose={() => onClose(win.id)} {sessions} />
    </DesktopWindow>
  {/each}
  {#if openHere.length > 0 || globalChips.length > 0 || $infoWindows.length > 0 || $calendarWindows.length > 0}
    <!-- THE WINDOW STRIP. One chip per open window, whether it is on the
         surface or put away — the dot says which. It is the only way back to a
         minimized window that does not require remembering which launcher entry
         it was, and it doubles as "what have I got open" without counting
         overlapping title bars.

         ⚠ THE GLOBAL WINDOWS ARE IN HERE TOO, though they are drawn on another
         layer entirely. They used to have a strip of their own in the opposite
         corner, which meant putting a window away landed its handle in one of
         two places depending on which window it was — one gesture, two answers,
         and nothing on screen explaining the difference. Where a chip is must
         not depend on which layer happens to own the window. -->
    <div class="win-strip" role="group" aria-label="Open windows">
      {#each openHere as win (win.id)}
        <button
          type="button"
          class="win-chip"
          class:away={win.minimized}
          aria-pressed={!win.minimized}
          title={win.minimized ? `Bring back ${tabLabel(win.id)}` : `Put away ${tabLabel(win.id)}`}
          onclick={() => onToggleMinimize(win.id)}
        >
          <span class="win-chip-dot" aria-hidden="true"></span>{tabLabel(win.id)}
        </button>
      {/each}
      {#each $infoWindows as win (win.id)}
        <button type="button" class="win-chip" class:away={win.minimized} aria-pressed={!win.minimized}
          title={win.minimized ? `Bring back ${infoWindowLabel(win, $names.resolved)}` : `Put away ${infoWindowLabel(win, $names.resolved)}`}
          onclick={() => flow.infoWindows.minimize(win.id)}><span class="win-chip-dot" aria-hidden="true"></span>{infoWindowLabel(win, $names.resolved)}</button>
      {/each}
      {#each $calendarWindows as win (win.id)}
        {@const title = win.kind === "day" ? win.id : win.event.eventTitle}
        <button type="button" class="win-chip" class:away={win.minimized} aria-pressed={!win.minimized}
          title={win.minimized ? `Bring back ${title}` : `Put away ${title}`}
          onclick={() => calendar.toggleMinimize(win.id)}><span class="win-chip-dot" aria-hidden="true"></span>{title}</button>
      {/each}
      {#each globalChips as win (win.id)}
        <button
          type="button"
          class="win-chip"
          class:away={win.minimized}
          aria-pressed={!win.minimized}
          title={win.minimized ? `Bring back ${tabLabel(win.id)}` : `Put away ${tabLabel(win.id)}`}
          onclick={() => onToggleGlobalMinimize?.(win.id)}
        >
          <span class="win-chip-dot" aria-hidden="true"></span>{tabLabel(win.id)}
        </button>
      {/each}
    </div>
  {/if}
</div>
