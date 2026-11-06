<script lang="ts">
  // R107 — the character bar across the top of the tab: every online pilot as a
  // chip, the active one highlighted, a server-connection indicator, plus "Add
  // character". One cockpit shows at a time (the active pilot's Workspace, below);
  // clicking a chip switches which. All the pilots stay live on the BFF while
  // backgrounded — this bar just picks which one the workspace is driving.
  import CharacterChip from "./CharacterChip.svelte";
  import GlobalLaunchers from "./GlobalLaunchers.svelte";
  import type { Session } from "../app/sessions.ts";
  import type { TabID } from "./tabs.ts";

  let {
    sessions,
    activeId,
    serverStatus,
    globalOpenIds = new Set<TabID>(),
    onSwitch,
    onAdd,
    onHangar,
    onOpenGlobal,
  }: {
    sessions: Session[];
    activeId: string | null;
    serverStatus: "checking" | "online" | "offline";
    /** The global windows open right now (possibly put away). */
    globalOpenIds?: ReadonlySet<TabID>;
    onSwitch: (id: string) => void;
    onAdd: () => void;
    /**
     * Reopen the Pilot Hangar over the cockpit. Without this the hangar was a
     * one-way door: the moment the first pilot came online, the only screen that
     * can bring the OTHER twenty online, edit squads or forget a pilot became
     * unreachable for the life of the tab.
     */
    onHangar: () => void;
    /**
     * Open one of the global windows — Bot Manager, Planetary Industry, the
     * plugins' windows.
     *
     * ⚠ THEY HANG HERE RATHER THAN IN THE NEOCOM, and the reason is the same
     * one that makes them global: none is a view of the pilot whose cockpit
     * happens to be showing. This bar is the only chrome that survives a pilot
     * switch, so it is the only place a door onto every pilot at once can
     * honestly sit. Optional so the bar still renders in the tests and
     * harnesses that mount it without the roster behind it.
     */
    onOpenGlobal?: (id: TabID) => void;
  } = $props();

  /**
   * A NARROW BAR SHOWS ONE PILOT AND A WAY TO CHANGE IT.
   *
   * ⚠ THE TAB STRIP IS A DESKTOP SHAPE. It is a scrolling row of 11rem tabs,
   * which needs room the phone does not have: at 375px the bar had 359px, the
   * other controls took 316, and the chip absorbed the whole shortfall — eleven
   * pixels, a border with the pilot's name clipped away inside it.
   *
   * So below the breakpoint the strip becomes the ACTIVE pilot plus a switcher,
   * and the switcher only exists when there is somebody to switch to.
   *
   * ⚠ ONE NUMBER, IN ONE PLACE. This flag drives the markup AND the narrow-bar
   * styling (`.char-bar.narrow`), rather than a `$state` here and a `@media`
   * there that have to be kept equal by hand.
   */
  let narrow = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 560px)");
    const update = (): void => { narrow = mq.matches; };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  });

  const activeSession = $derived(sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null);
  const others = $derived(sessions.filter((s) => s.id !== activeSession?.id));

  /** The switcher's list, open or shut. */
  let switching = $state(false);
  $effect(() => {
    // A pilot list that outlives the pilots is a menu onto nothing.
    if (others.length === 0) {
      switching = false;
    }
  });
  function pick(id: string): void {
    switching = false;
    onSwitch(id);
  }

  const statusLabel = $derived(
    serverStatus === "online"
      ? "Connected"
      : serverStatus === "offline"
        ? "Server offline"
        : "Connecting…",
  );
</script>

<svelte:window onkeydown={(event) => event.key === "Escape" && (switching = false)} />

<div class="char-bar" class:narrow>
  <span class="char-bar-brand">EVEJS</span>
  <!--
    THE DOORS ONTO THE GLOBAL WINDOWS. Beside the brand, before the pilots:
    everything to the right of them is about ONE pilot, and these are the
    controls up here that are about all of them. The Pilot Hangar's header
    carries the same strip (GlobalLaunchers.svelte).
  -->
  {#if onOpenGlobal}
    <GlobalLaunchers openIds={globalOpenIds} onOpen={onOpenGlobal} />
  {/if}
  {#if narrow}
    <!--
      One pilot, and a way to change it. The chip is COMPACT here — dot and
      name — because the workspace header directly below already says where the
      ship is, in more detail than the chip's state line can.
    -->
    <div class="char-bar-list">
      {#if activeSession}
        <!--
          ⚠ `{#key}`, AND IT IS LOAD-BEARING. `CharacterChip` reads its session's
          store slices once at init — it has to, because `$station` needs a
          stable top-level binding — so handing a live instance a different
          `session` changes nothing: it goes on rendering the pilot it was
          created for. The desktop strip never hits this because `{#each … (id)}`
          keys every chip; this one chip has to say so itself.
        -->
        {#key activeSession.id}
          <CharacterChip
            session={activeSession}
            active={true}
            compact={true}
            onSelect={() => others.length > 0 && (switching = !switching)}
          />
        {/key}
      {/if}
      {#if others.length > 0}
        <button
          type="button"
          class="char-bar-switch"
          aria-haspopup="listbox"
          aria-expanded={switching}
          aria-label={`Switch pilot — ${others.length} other${others.length === 1 ? "" : "s"} online`}
          onclick={() => (switching = !switching)}
        >
          <span aria-hidden="true">▾</span>
        </button>
      {/if}
    </div>
  {:else}
    <div class="char-bar-list">
      {#each sessions as session (session.id)}
        <CharacterChip
          {session}
          active={session.id === activeId}
          onSelect={() => onSwitch(session.id)}
        />
      {/each}
    </div>
  {/if}
  <span class="char-bar-status char-bar-status-{serverStatus}" title={`Server: ${statusLabel}`}>
    <span class="char-bar-status-dot"></span>
    <span class="char-bar-status-text">{statusLabel}</span>
  </span>
  <button type="button" class="char-bar-hangar" onclick={onHangar} title="Pilot hangar — every pilot, squads and accounts">
    Pilots
  </button>
  <!--
    ⚠ THE LABEL IS TWO PIECES SO A NARROW BAR CAN DROP ONE.

    At 375px the whole bar is 359px of usable width and this button alone took
    119 of it, which crushed the pilot CHIP — the one thing the bar exists to
    show — down to an 11px stub with nothing readable in it. The "+" carries
    the button on a phone; the words come back as soon as there is room.

    `aria-label` is unconditional, so the button is never just a plus sign to
    anything that reads it aloud.
  -->
  <button type="button" class="char-bar-add" onclick={onAdd} aria-label="Add character">
    <span aria-hidden="true">+</span>
    <span class="char-bar-add-text">Add character</span>
  </button>

  {#if switching && others.length > 0}
    <!--
      ⚠ THE OTHERS KEEP THEIR STATE LINE. The active chip drops it because the
      header repeats it; here it is the whole point — the state is how you tell
      which pilot you are about to switch to.
    -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="char-bar-shade" onclick={() => (switching = false)}></div>
    <div class="char-bar-pilots" role="listbox" aria-label="Pilots online">
      {#each others as session (session.id)}
        <CharacterChip
          {session}
          active={false}
          onSelect={() => pick(session.id)}
        />
      {/each}
    </div>
  {/if}
</div>
