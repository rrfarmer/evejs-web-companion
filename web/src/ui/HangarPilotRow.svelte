<script lang="ts">
  // One pilot in the Pilot Hangar.
  //
  // Split out of PilotHangar.svelte for the same reason BotManagerPilotRow was
  // split out of BotManager: the row carries four independent controls (select,
  // launch, pin, and — in manage mode — remove and a squad checklist) over three
  // lines of data, and inlining all of that put the screen's actual layout out
  // of reach in the middle of a 200-line template.
  //
  // The row renders and reports; it owns no state but the open/closed squad
  // menu, which is passed in so only one menu is open across the whole screen.
  import type { HangarPilot } from "../app/hangar.ts";
  import type { Squad } from "../app/hangarPrefs.ts";
  import type { ActiveServerBot } from "../app/api.ts";
  import { formatIskCompact, formatSpCompact } from "../app/hangar.ts";
  // One vocabulary for every bot readout in the client — see bots/pilotRoster.ts.
  import { activeBotCommandWords, activeBotVitalsWords } from "../bots/pilotRoster.ts";
  import type { Session } from "../app/sessions.ts";
  import type { StationSlice } from "../store/clientStore.ts";
  import type { FlightState } from "../store/types.ts";
  import { deriveDocked } from "./tabs.ts";

  let {
    pilot,
    session = null,
    selected,
    manage,
    /** Below 760px a tap SELECTS instead of launching — mis-tap protection. */
    tapSelects,
    bot = null,
    stopping = false,
    stopBusy = false,
    squads,
    squadMenuOpen,
    onActivate,
    onToggleSelect,
    onTogglePin,
    onRemove,
    onStopBot,
    onToggleSquadMenu,
    onToggleSquad,
    companionEnabledFor = () => false,
    onToggleCompanion = () => {},
  }: {
    pilot: HangarPilot;
    /**
     * The session flying this pilot in this tab, or null. The roster's place is the selection read's, made when
     * the hangar opened; a pilot in the client can move while the hangar stays open over the cockpit.
     */
    session?: Session | null;
    selected: boolean;
    manage: boolean;
    tapSelects: boolean;
    /**
     * The server bot flying this pilot right now, or null. Not part of
     * `HangarPilot`: the roster is a local snapshot of who exists, and this is a
     * live server fact polled on its own clock.
     */
    bot?: ActiveServerBot | null;
    /** A stop is in flight for THIS pilot. */
    stopping?: boolean;
    /** A stop is in flight for SOME pilot — one at a time across the screen. */
    stopBusy?: boolean;
    /** Every squad, for the manage-mode checklist. */
    squads: readonly Squad[];
    squadMenuOpen: boolean;
    onActivate: () => void;
    onToggleSelect: () => void;
    onTogglePin: () => void;
    onRemove: () => void;
    onStopBot?: () => void;
    onToggleSquadMenu: () => void;
    onToggleSquad: (squadID: string) => void;
    /**
     * Whether this pilot is set up to fly a companion in one squad.
     *
     * ⚠ PRESENCE IS THE WHOLE SETTING NOW. There used to be a role here, and
     * the role doubled as this same yes/no -- picking one meant "yes, and this
     * is the job"; picking none meant "no". With the role gone
     * (docs/fleet-companion-simplification.md, "The one-line version"), the
     * yes/no is asked directly: a companion setup either exists for this pilot
     * in this squad or it does not, and there is nothing left in the hangar to
     * tune -- the setup it starts with is the shipped default. See
     * `companionConfigFor` in hangarPrefs.ts.
     */
    companionEnabledFor?: (squadID: string) => boolean;
    /** Turn a companion setup on (shipped defaults) or off (remove it) for one squad. */
    onToggleCompanion?: (squadID: string) => void;
  } = $props();

  // Read from that session's own store, as BotManagerPilotRow.svelte reads it: `session` can come and go with the row.
  let station = $state<StationSlice | null>(null);
  let flight = $state<FlightState | null>(null);
  $effect(() => {
    if (!session) {
      station = null;
      flight = null;
      return;
    }
    const unsubs = [
      session.store.station.subscribe((value) => {
        station = value;
      }),
      session.store.flight.subscribe((value) => {
        flight = value;
      }),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });

  // Where a pilot in the client is now, by CharacterChip.svelte's chain: docked, the station (or its system); in
  // space, the flight's system. Null for a pilot with no session here, which keeps the roster's place.
  const livePlace = $derived(
    station?.online
      ? deriveDocked(flight?.status ?? null, station.online)
        ? (station.station?.stationName ?? station.station?.solarSystemName ?? flight?.solarSystemName ?? null)
        : (flight?.solarSystemName ?? null)
      : null,
  );

  // Manage mode deliberately makes the row inert: it is the mode where you
  // remove pilots and shuffle squads, and a stray click that put six pilots in
  // the client would be the worst possible surprise there.
  const clickable = $derived(!manage);
  const memberOf = $derived(new Set(pilot.squads.map((s) => s.id)));

  function activate(): void {
    if (manage) return;
    // A pilot already in the client has nothing to launch, so the mis-tap
    // protection has nothing to protect against: the tap takes you to its
    // cockpit on every width. Selecting it instead is what made an online row
    // feel dead — the checkbox is still right there for the rare case where you
    // want it in a squad.
    if (tapSelects && !pilot.online) onToggleSelect();
    else onActivate();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  }

  // Groundwork for dragging a pilot into a squad; no drop targets exist yet, so
  // this only makes the row grabbable and names what is being dragged.
  function onDragStart(event: DragEvent): void {
    event.dataTransfer?.setData("text/plain", pilot.name);
  }
</script>

<!-- The row is the target: a click (desktop) brings the pilot online, and a
     keyboard player gets the same through Enter/Space. In manage mode it is
     deliberately inert, so the role and the tab stop go away with the
     behaviour — which is what the two ignores below are about: the linter reads
     the conditional role as "a plain div with a tabindex". -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="hangar-row"
  class:is-selected={selected}
  class:is-clickable={clickable}
  draggable="true"
  role={clickable ? "button" : undefined}
  tabindex={clickable ? 0 : undefined}
  onclick={activate}
  onkeydown={clickable ? onKey : undefined}
  ondragstart={onDragStart}
>
  {#if !manage}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <input
      type="checkbox"
      checked={selected}
      aria-label={`Select ${pilot.name}`}
      onclick={(event) => event.stopPropagation()}
      onchange={onToggleSelect}
    />
  {/if}

  <div class="hangar-row-main">
    <div class="hangar-row-title">
      <span class="hangar-name">{pilot.name}</span>
      {#if pilot.online}
        <!-- Words with the mark, never the mark alone (R9a). -->
        <span class="hangar-badge is-online" title="Already in the client — click the row to go to it">ON</span>
      {/if}
      {#if pilot.training === null}
        <span class="hangar-badge is-idle" title="No skill in training">IDLE</span>
      {/if}
      {#if bot}
        <span class="hangar-badge is-bot" title="A server bot is flying this pilot">BOT</span>
      {/if}
    </div>

    <div class="hangar-meta">
      <span>{pilot.shipName ?? "—"}</span>
      <span class="hangar-meta-sep">·</span>
      <span class="hangar-meta-loc">{livePlace ?? pilot.locationName ?? "—"}</span>
    </div>

    <div class="hangar-stats">
      <span class="hangar-isk">{formatIskCompact(pilot.balance)} ISK</span>
      <span class="hangar-sp">{formatSpCompact(pilot.skillPoints)}</span>
      <span class="hangar-train" class:is-idle={pilot.training === null}>
        {pilot.training ?? "not training"}
      </span>
    </div>

    {#if bot}
      <!-- THE STOP LIVES ON THE ROW, and in manage mode too. It is the one
           control here that is not about arranging the list, and a player whose
           hull is out mining unattended must not have to leave a mode to reach
           it. It is a real button inside a clickable row, so it stops the click
           from also trying to launch a pilot the server would refuse anyway. -->
      {@const vitals = activeBotVitalsWords(bot.vitals)}
      <div class="hangar-botline">
        <div class="hangar-botwords">
          <span class="hangar-botphase">{activeBotCommandWords(bot)}</span>
          {#if vitals}
            <span class="hangar-botvitals">{vitals}</span>
          {/if}
        </div>
        {#if onStopBot}
          <button
            type="button"
            class="hangar-stopbot"
            title={`Stop the server bot flying ${pilot.name}`}
            disabled={stopBusy}
            onclick={(event) => {
              event.stopPropagation();
              onStopBot();
            }}
          >{stopping ? "Stopping…" : "Stop bot"}</button>
        {/if}
      </div>
    {/if}

    {#if manage}
      <!-- A checklist rather than a row of chips: at eleven squads a flat chip
           grid made every row about 230px tall and the grid unreadable. -->
      <div class="hangar-squadbtn-wrap">
        <button
          type="button"
          class="hangar-squadbtn"
          class:is-open={squadMenuOpen}
          aria-expanded={squadMenuOpen}
          onclick={(event) => {
            event.stopPropagation();
            onToggleSquadMenu();
          }}
        >
          <span>Squads ({pilot.squads.length})</span>
          <span aria-hidden="true">▼</span>
        </button>
        {#if squadMenuOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div class="hangar-squadmenu" onclick={(event) => event.stopPropagation()}>
            <div class="hangar-squadmenu-list">
              {#each squads as squad (squad.id)}
                {@const member = memberOf.has(squad.id)}
                <!--
                  ⚠ THE TICK STAYS ITS OWN BUTTON AND THE SETUP SITS BENEATH IT.
                  A control nested inside that button would be invalid HTML and
                  would fire the membership toggle on every click, so the
                  companion toggle is a sibling, not a child.

                  ⚠ AND IT APPEARS ONLY FOR A SQUAD THIS PILOT IS IN. Growing
                  EVERY row was tried before and rejected -- at eleven squads it
                  made each row about 230px tall (docs/pilot-hangar.md). A pilot
                  is typically in one or two squads, so this grows the one or
                  two rows that have something to say.
                -->
                <button
                  type="button"
                  class="hangar-squadmenu-row"
                  class:is-member={member}
                  aria-pressed={member}
                  onclick={() => onToggleSquad(squad.id)}
                >
                  <span class="hangar-squadmenu-mark" aria-hidden="true">✓</span>
                  <span class="hangar-swatch" style:background={squad.color}></span>
                  <span class="hangar-squadmenu-name">{squad.name}</span>
                </button>
                {#if member}
                  <!--
                    ⚠ A TOGGLE, NOT A PICKER, AND THAT IS THE WHOLE OF WHAT
                    LIVES HERE NOW. There used to be a role select (setting
                    both "is this pilot a companion here" and "what job") and a
                    second checkbox underneath it for tagging. The role is gone
                    (docs/fleet-companion-simplification.md) and tagging is
                    every pilot's, gated by the server's own commander check --
                    so the only question left is yes/no, and this is the whole
                    of it. Ticking it writes the shipped default setup; there
                    is nothing in the hangar left to tune.
                  -->
                  <div class="hangar-squadmenu-setup">
                    <label class="hangar-squadmenu-setuprow">
                      <input
                        type="checkbox"
                        checked={companionEnabledFor(squad.id)}
                        onchange={() => onToggleCompanion(squad.id)}
                      />
                      <span>Flies as companion</span>
                    </label>
                    {#each pluginMemberSettings() as setting (setting.pluginID)}
                      <ErrorBoundary name={`${setting.pluginID} on ${squad.name}`}>
                        <setting.view {squad} characterID={pilot.characterID} />
                      </ErrorBoundary>
                    {/each}
                  </div>
                {/if}
              {/each}
              {#if squads.length === 0}
                <div class="hangar-picker-empty">No squads yet.</div>
              {/if}
            </div>
            <button type="button" class="hangar-squadmenu-done" onclick={onToggleSquadMenu}>
              Done
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="hangar-rail">
    <button
      type="button"
      class="hangar-star is-row"
      class:is-on={pilot.pinned}
      aria-pressed={pilot.pinned}
      title={pilot.pinned ? "Unpin from the top of the account" : "Pin to the top of the account"}
      onclick={(event) => {
        event.stopPropagation();
        onTogglePin();
      }}
    >★</button>
    {#if manage}
      <button
        type="button"
        class="hangar-remove is-pilot"
        title={`Remove ${pilot.name} from this list`}
        onclick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
      >✕</button>
    {/if}
    {#if pilot.squads.length > 0}
      <div class="hangar-tags">
        {#each pilot.squads as squad (squad.id)}
          <span class="hangar-tag" style:background={squad.color} title={squad.name}></span>
        {/each}
      </div>
    {/if}
  </div>
</div>
