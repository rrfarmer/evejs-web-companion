<script lang="ts">
  // The fleet companion's controls and readout — the third instance of the
  // MiningBot.svelte / MissionBot.svelte pattern.
  //
  // A pure reader of the store's `companion` slice plus the request's own
  // controls. It decides NOTHING about the companion: the ladder, the order
  // precedence and the reasons all live in nav/fleetCompanionLoop.ts, and every
  // word on screen here came from that loop or from the server.
  //
  // ⚠ 2026-09-11 SIMPLIFICATION — SEE docs/fleet-companion-simplification.md.
  // This panel no longer picks a role, a module, or an order channel: a
  // companion now reads its own fit at start and obeys every order channel
  // there is, so there was never anything for a player to disambiguate.
  //
  // ⚠ AND IT NO LONGER BUILDS A `CompanionSetup` EITHER. The six limits are one
  // op-wide answer now, set in FleetCompanions.svelte and handed down as the
  // `setup` prop, because adding a pilot to the roster is what starts it —
  // there is no longer a moment at which a per-pilot form would be filled in.
  // What this panel owns is what is true of THIS pilot: the checklist, the
  // controls, and the readout.
  import { onMount } from "svelte";
  import { evaluateRequirements, isFleetBroadcastFresh, isSessionLost, panelErrorWords, resolvedName, type ClientStore, type FleetBroadcastName, type NameRef } from "../../../web/src/plugin-api/flying.ts";
  import {
    FLEET_COMPANION_REQUIREMENTS,
    type FleetCompanionReads,
  } from "../lib/fleetCompanionRequirements.ts";
  import {
    FLEET_COMPANION_ABANDONMENT_WAIT_MS,
    type CompanionSetup,
  } from "../lib/fleetCompanionLoop.ts";
  // The words this readout uses live in the shared layer, because the Bot
  // Manager's per-pilot row says the same things about the same run and the two
  // must not drift. See companionReadout.ts's header.
  import { canTagWords, inFleetWords, orderFromWords } from "../lib/companionReadout.ts";
  import { companionState, type FleetCompanionState } from "../lib/companionState.ts";
  import { companionFor } from "../lib/companions.ts";
  import type { AppFlow } from "../../../web/src/plugin-api/index.ts";

  let {
    store,
    flow,
    setup,
    title = "Fleet companion",
    onGoToPilot,
  }: {
    store: ClientStore;
    flow: AppFlow;
    /**
     * The limits this pilot starts under, set once for the whole op in
     * FleetCompanions.svelte.
     *
     * ⚠ THE FORM THAT USED TO BE HERE IS GONE, AND ITS ABSENCE IS THE POINT.
     * Adding a pilot to the op now starts it, so a per-pilot form would be a
     * form nobody gets to fill in before the start it gates — and two forms for
     * one run is two answers to the same question, of which only one would ever
     * reach the loop. What this panel still owns is everything that is about
     * THIS pilot: the checklist, the controls, and the readout.
     */
    setup: CompanionSetup;
    /**
     * What this panel's strip calls itself.
     *
     * ⚠ IT EXISTS SO THE EMBEDDED CASE NAMES THE PILOT INSTEAD OF NAMING THE
     * COMPONENT. Inside the companions window this panel is the readout for the
     * pilot a player just clicked, and that window used to say so in a framed
     * strip of its own directly above — a heading with a pilot's name, then a
     * heading reading "Fleet companion", then the controls. Two headings and two
     * rules for one subject. The strip is where a panel names itself and where
     * its controls live, so the name goes IN it. Standalone, the default is the
     * component's own name and nothing changes.
     */
    title?: string;
    /**
     * Make this pilot the active cockpit. When absent — standalone, and in
     * tests — no such button is drawn.
     */
    onGoToPilot?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const companion = companionState(store);
  const companionFlow = companionFor({ store, flow });
  // svelte-ignore state_referenced_locally
  const fleet = store.fleet;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const names = store.names;

  let busy = $state(false);
  let error = $state("");

  const running = $derived($companion.status === "running");
  const paused = $derived($companion.status === "paused");
  const active = $derived(running || paused);

  /**
   * The launcher's OWN best-effort reads, taken fresh whenever this panel is on
   * screen. This is the ADVISORY copy (R43's own rule) — `flow.startFleetCompanion`
   * evaluates the same requirements again, against reads taken immediately
   * before the first call, and only that evaluation decides anything. A stale
   * "you are in a fleet" here is exactly the failure that second read exists to
   * catch.
   */
  const inFleet = $derived(
    $fleet.availability === "ready" ? true : $fleet.availability === "not-in-fleet" ? false : null,
  );
  const docked = $derived($flight.status?.docked ?? null);
  const reads = $derived<FleetCompanionReads>({ inFleet, docked });
  const preflight = $derived(evaluateRequirements(FLEET_COMPANION_REQUIREMENTS, reads));
  const canStart = $derived(preflight.canStart && !active);

  /**
   * Roughly how long an abandoned pilot has left, in whole minutes.
   *
   * Rounded UP and described as "about" on purpose: the authority on when the
   * wait ends is the loop itself, which re-decides every couple of seconds, and
   * a countdown that claimed to be exact would be a second wrong answer to a
   * question the panel does not own.
   */
  function abandonmentMinutesLeft(
    abandonment: NonNullable<FleetCompanionState["abandonment"]>,
  ): number {
    const left = FLEET_COMPANION_ABANDONMENT_WAIT_MS - (Date.now() - abandonment.abandonedAtMs);
    return Math.max(0, Math.ceil(left / 60_000));
  }

  // The rejoin allowlist is character ids; the player should read names.
  $effect(() => {
    const ids = $companion.abandonment?.supervisorCharacterIDs ?? [];
    if (ids.length > 0) {
      flow.requestNames(ids.map((id) => ({ kind: "character", id }) as NameRef));
    }
  });

  /**
   * What the fleet has most recently said, in the player's words. Shown even
   * before this pilot can act on any of it: during live QA the first question
   * is always "is the broadcast even arriving".
   */
  const lastOrder = $derived($fleet.lastBroadcast);
  const orderIsFresh = $derived(
    lastOrder === null ? false : isFleetBroadcastFresh(lastOrder, Date.now()),
  );

  // The broadcaster is a character id; the player should read a name. Same
  // shape as the abandonment lookup above.
  $effect(() => {
    const sender = $fleet.lastBroadcast?.senderCharID ?? null;
    if (sender !== null) {
      flow.requestNames([{ kind: "character", id: sender } as NameRef]);
    }
  });

  /** Plain words for a broadcast name. Never the wire name, which is jargon. */
  const broadcastWords: Record<FleetBroadcastName, string> = {
    // ⚠ NOT "shoot this". Answering a Target call always means LOCKING the
    // ship first, and firing after only happens if this hull carries a weapon
    // -- saying "shoot" here would promise every pilot something only some of
    // them can do.
    Target: "lock this target",
    AlignTo: "align to this",
    WarpTo: "warp to this",
    JumpTo: "jump through this gate",
    TravelTo: "travel to this system",
    JumpBeacon: "jump to this beacon",
    HealShield: "needs shield reps",
    HealArmor: "needs armour reps",
    HealCapacitor: "needs capacitor",
    HealTarget: "rep this pilot",
    EnemySpotted: "enemy spotted",
    NeedBackup: "needs backup",
    HoldPosition: "hold position",
    InPosition: "in position",
    Location: "reporting position",
  };

  /**
   * The checklist's live reads need the fleet and the flight status.
   * Best-effort, same as `Bots.svelte`: a failed read leaves the requirement at
   * "could not check", which is the honest answer.
   */
  onMount(() => {
    void Promise.resolve(flow.loadFleet()).catch(() => {});
  });

  async function run(action: () => Promise<void> | void): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        error = "The live session ended (idle timeout or another client took over).";
      } else {
        error = panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  /**
   * Start this pilot on the op's limits, exactly as given.
   *
   * ⚠ THE SETUP IS PASSED THROUGH UNTOUCHED, AND NOTHING IS INVENTED HERE. It
   * is a `CompanionSetup` and nothing else: the eight module lists that
   * complete a request are read off the hull this pilot is actually sitting in,
   * by `flow.startFleetCompanion`, at the moment it starts — an itemID picked
   * in a panel would be stale the moment somebody refits.
   */
  async function start(): Promise<void> {
    await run(() => companionFlow.startFleetCompanion(setup satisfies CompanionSetup));
  }
</script>

<section class="panel">
  <header class="panel-head">
    <h2>{title}</h2>
    <span class="controls">
      <!-- The one thing you can do to this pilot that is not about the run: go
           and fly it yourself. First in the strip because it is the least
           destructive thing in it. -->
      {#if onGoToPilot}
        <button type="button" onclick={onGoToPilot}>Go to pilot</button>
      {/if}
      {#if running}
        <button type="button" disabled={busy} onclick={() => run(() => companionFlow.pauseFleetCompanion())}>
          Pause
        </button>
        <button type="button" class="danger" disabled={busy} onclick={() => run(() => companionFlow.stopFleetCompanion())}>
          Stop
        </button>
      {:else if paused}
        <button type="button" class="primary" disabled={busy} onclick={() => run(() => companionFlow.resumeFleetCompanion())}>
          Carry on
        </button>
        <button type="button" class="danger" disabled={busy} onclick={() => run(() => companionFlow.stopFleetCompanion())}>
          Stop
        </button>
      {:else}
        <button type="button" class="primary" disabled={busy || !canStart} onclick={start}>
          Start
        </button>
      {/if}
    </span>
  </header>
  <!-- ⚠ WHAT IT IS was two sentences here and is now none: the window is called
       Fleet companions and the readout below says what this one is doing. What
       survives is the one fact a player cannot see anywhere on screen — that
       closing the tab ends the run. -->
  <p class="note">Runs in this tab: close it and your ship stops taking orders.</p>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if $companion.startError}
    <p class="error">{$companion.startError}</p>
  {/if}
</section>

{#if active}
  <!--
    THE READOUT. `why` is the field this whole panel exists for: whatever the
    companion is doing, the player can see the reason for it without asking.
  -->
  <section>
    <h2>What it is doing</h2>
    <p class="stat-line">
      <strong>{$companion.phase ?? "Working"}</strong>
      {#if $companion.action}<span class="note"> - {$companion.action}</span>{/if}
    </p>
    {#if $companion.why}
      <p class="note"><strong>Why:</strong> {$companion.why}</p>
    {/if}
    {#if $companion.failureReason}
      <p class="error">{$companion.failureReason}</p>
    {/if}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>In fleet</th>
            <!-- ⚠ THE SAME SHORT HEADS AS THE ROSTER. These two were each
                 about twice the width of the value under them. "Calls targets"
                 STAYS here, though the roster dropped it: that table reports one
                 field for every pilot, where a column of near-identical answers
                 is noise; this one reports every field for one pilot, which is
                 the view a player opens precisely to read the rare answers.
                 ⚠ IT ASKS HOW, NOT WHETHER. The head used to read "Can tag"
                 over a "no" that meant only "this pilot broadcasts its targets
                 instead of lettering them" — a method, printed as a
                 shortcoming. See `canTagWords`. -->
            <th>Orders from</th>
            <th>Last order</th>
            <th>Calls targets</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="In fleet">{inFleetWords($companion.inFleet)}</td>
            <td data-label="Orders from">{orderFromWords($companion.followingOrderFrom)}</td>
            <td data-label="Last order">{$companion.lastOrderHeard ?? "-"}</td>
            <td data-label="Calls targets">{canTagWords($companion.canTag)}</td>
          </tr>
        </tbody>
      </table>
    </div>
    {#if $companion.fitWarnings.length > 0}
      <!--
        WHAT THIS SHIP IS MISSING, measured once when the run started.
        ADVISORY, NEVER A REFUSAL: the operator's rule is that a human either
        loads the missing thing or ignores this and flies. Nothing here stops a
        start, and nothing here nags on an unreadable fit -- an empty list is
        what both "all well" and "could not tell" produce.
      -->
      <p class="note"><strong>Worth knowing about this fit:</strong></p>
      <ul>
        {#each $companion.fitWarnings as warning (warning)}
          <li class="note">{warning}</li>
        {/each}
      </ul>
    {/if}
    <!--
      WHAT THE FLEET IS SAYING. Deliberately shown even before this pilot can
      act on any of it: during live QA the first question is always "is the
      broadcast even arriving", and a panel that only showed what the pilot DID
      cannot answer it.
    -->
    <h3>What the fleet is saying</h3>
    {#if lastOrder === null}
      <p class="note">
        Nothing has come over the fleet yet. Broadcasts and target tags only
        arrive while someone in the fleet is actually sending them.
      </p>
    {:else}
      <p class="stat-line">
        <strong>{broadcastWords[lastOrder.name] ?? lastOrder.name}</strong>
        <span class="note">
          - from {resolvedName($names.resolved, "character", lastOrder.senderCharID, "someone in the fleet")}
        </span>
      </p>
      {#if !orderIsFresh}
        <p class="note">
          That call has lapsed, so this pilot is back on its own judgement. A
          call only stands for about half a minute.
        </p>
      {/if}
    {/if}
    {#if $fleet.targetTags === null}
      <p class="note">No target tags have been read from this fleet.</p>
    {:else if $fleet.targetTags.size === 0}
      <p class="note">The fleet has tagged nothing.</p>
    {:else}
      <p class="note">
        The fleet has tagged {$fleet.targetTags.size} ship(s):
        {[...$fleet.targetTags.values()].join(", ")}.
      </p>
    {/if}

    {#if $companion.abandonment}
      <p class="note warn">
        Nobody is left in this fleet that this computer is not flying, so this
        pilot has got itself safe and dropped fleet. It will wait about
        {abandonmentMinutesLeft($companion.abandonment)} more minute(s) for
        someone to invite it back, then release the ship.
        {#if $companion.abandonment.supervisorCharacterIDs.length > 0}
          It will only accept an invite from
          {$companion.abandonment.supervisorCharacterIDs
            .map((id) => resolvedName($names.resolved, "character", id, "(name pending)"))
            .join(", ")}.
        {:else}
          It has nobody to accept an invite from, so it will simply wait out the
          time.
        {/if}
      </p>
    {/if}
    {#if paused}
      <p class="note">
        Paused. Your ship keeps doing whatever it was last told to - press Carry
        on to pick the run back up, or Stop to leave it alone.
      </p>
    {/if}
  </section>
{:else}
  <section>
    <h2>Set it up</h2>

    <h3>Before it can start</h3>
    <ul class="checklist">
      {#each preflight.rows as row (row.id)}
        {@const label = row.verdict === "met" ? "Ready" : row.verdict === "cannot-tell" ? "Unknown" : "Not yet"}
        <li class={`check-${row.verdict}`}>
          <strong>{label}</strong>
          {#if row.verdict !== "met"}
            <span class="note">({row.severity === "blocking" ? "required" : "worth knowing"})</span>
          {/if}
          <span>{row.title}</span>
          {#if row.reason}
            <span class="note"> - {row.reason}</span>
          {/if}
        </li>
      {/each}
    </ul>

    <!-- ⚠ "What it uses" IS GONE, HEADING AND ALL. It listed the modules and
         the order channels a companion reads, and every line of it ended in
         "with nothing here to switch on" — a section of settings that are not
         settings. A player who wants to know what their ship will use looks at
         the fit. -->

    <!-- The limits form is NOT here any more, and must not come back. The six
         numbers a companion flies under are set once for the whole op in
         FleetCompanions.svelte, because adding a pilot there STARTS it: a form
         on this panel would be a form nobody fills in before the start it
         gates, and a second copy of one question for the two to disagree on. -->
    <p class="note">
      It flies on the limits set for this op, above the roster. Changing them
      there changes what the next companion starts under.
    </p>

    <!-- ⚠ ONE SENTENCE, AND IT STAYS. This is the one behaviour a player would
         otherwise meet as a surprise — a companion that stops, leaves the fleet
         and will not take an invite from a stranger. The paragraph about
         warping to the star when no station is in reach went: there is nothing
         to set for it and nothing to do about it. -->
    <h3>If it ends up alone</h3>
    <p class="note">
      It needs one pilot in the fleet who is not flown by this browser. Without
      one it docks, leaves the fleet, and waits half an hour for an invite from
      somebody who was in it.
    </p>

    {#if $companion.failureReason}
      <h3>Last time it stopped</h3>
      <p class="error">{$companion.failureReason}</p>
    {/if}
  </section>
{/if}

<style>
  /* The form's own rules went with the form — Svelte prunes unused selectors
     with a warning, and a stylesheet that still dresses controls this panel no
     longer has is the first place a deleted section grows back from. */
  .checklist {
    list-style: none;
    margin: 0.25rem 0 0.75rem;
    padding: 0;
  }
  .checklist li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: baseline;
    /* R8 — a comfortable row on a phone. */
    min-height: 40px;
    padding: 0.3rem 0;
  }
  .check-cannot-tell {
    opacity: 0.85;
  }
</style>
