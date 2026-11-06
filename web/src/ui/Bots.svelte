<script lang="ts">
  // THE BUILT-IN BOTS PANEL (goal R43).
  //
  // One place a player goes to say "run something the client already ships
  // with". It answers "what can I run?" and "is anything running?" for every
  // built-in bot — mining and mission — with the same checklist and
  // running-status treatment either way.
  //
  // ⚠ A PLUGIN'S LOOP IS NOT HERE, and that is deliberate: it is not a bot of
  // this pattern, picks no work from this panel's checklist, and is set up and
  // watched in its plugin's own window. What this panel still says about it is
  // the one thing that IS this panel's business: whether it is holding your
  // ship (see `runningName`).
  //
  // What USED to live here has moved to the Bot Manager: the saved-bot
  // library (any account's saved scripts, run here or handed to the server),
  // which pilot is flying what, and starting a bot on any held pilot rather
  // than only the one active in this tab. This panel could never reach those
  // other pilots; the Bot Manager can, so it owns that surface now.
  //
  // ⚠ IT EMBEDS THE REAL COMPONENTS AND FORKS NOTHING. `MiningBot.svelte` and
  // `MissionBot.svelte` are rendered here exactly as they are rendered where
  // they already live: same props, same controls, same readout. A second copy of a readout drifts, and a drifted readout does not
  // go quiet — it keeps rendering, confidently, about a bot that is doing
  // something else. Everything this panel adds is ABOUT the bots (which exist,
  // which is running, what each needs) and nothing it adds is a re-statement of
  // what one is DOING.
  //
  // ⚠ AND IT IS A LAUNCHER, NOT AN EDITOR. Visual/node-based bot authoring is
  // under separate discovery; nothing here should pre-empt those decisions.
  import { onMount } from "svelte";
  import MiningBot from "./MiningBot.svelte";
  import MissionBot from "./MissionBot.svelte";
  import {
    BOTS,
    MINING_BOT_REQUIREMENTS,
    MISSION_BOT_REQUIREMENTS,
    evaluateRequirements,
    holdsTheShip,
    type BotID,
    type RequirementRow,
  } from "../nav/botRegistry.ts";
  import { destinationHold, holdShouldHaul } from "../nav/miningBotLoop.ts";
  import { highSlotMiningModules, ungroupedHighSlotModules } from "../space/rowActions.ts";
  import { nameKey } from "../store/names.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const bots = store.bots;
  // svelte-ignore state_referenced_locally
  const bot = store.bot;
  // svelte-ignore state_referenced_locally
  const missionBot = store.missionBot;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const fitting = store.fitting;
  // svelte-ignore state_referenced_locally
  const mining = store.mining;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const customBot = store.customBot;

  /** Which bot's controls are open. Local view state, never the store's. */
  let opened = $state<BotID | null>(null);

  /**
   * The reads BEHIND THE CHECKLIST, and they are deliberately the store's.
   *
   * ⚠ THIS IS THE ADVISORY COPY. The same requirement objects are evaluated a
   * second time inside `flow.startMiningBot` against reads taken fresh from the
   * server immediately before the first call, and only THAT evaluation decides
   * anything. What is on screen here can be a minute old — the player may have
   * docked, or unfitted a laser, since the last poll. Showing it is useful;
   * trusting it would be the stale-read bug this whole mechanism exists to
   * prevent.
   *
   * Null throughout means UNREADABLE, and an unloaded slice is unreadable rather
   * than empty: a fitting nobody has fetched is not a ship with nothing on it.
   */
  const shipIsDocked = $derived($flight.status === null ? null : $flight.status.docked);

  /**
   * The ship's miners, from its HIGH SLOTS — the only place a mining module
   * lives. Two counts, because "none fitted" and "fitted but switched off" are
   * different problems with different fixes.
   */
  const miners = $derived.by<{ fitted: number | null; online: number | null }>(() => {
    if (!$fitting.loaded || $fitting.slotsError !== null) {
      return { fitted: null, online: null };
    }
    const resolved = $names.resolved;
    const nameOf = (typeID: number): string | null => resolved[nameKey("type", typeID)] ?? null;
    const groupOf = (typeID: number): string | null =>
      resolved[nameKey("typeGroup", typeID)] ?? null;
    // A high-slot module whose GROUP has not resolved yet might BE a Strip
    // Miner, so it poisons both counts instead of being quietly read as "not a
    // miner" (R47 — the group is the game's own answer, resolved via /api/names).
    if (ungroupedHighSlotModules($fitting.slots, nameOf, groupOf).length > 0) {
      return { fitted: null, online: null };
    }
    const rows = highSlotMiningModules($fitting.slots, nameOf, groupOf);
    return { fitted: rows.length, online: rows.filter((row) => row.online).length };
  });

  const holdHasRoom = $derived.by<boolean | null>(() => {
    if (!$mining.holdsLoaded) {
      return null;
    }
    // The loop's own pair, not a second idea of "full".
    const shouldHaul = holdShouldHaul(destinationHold($mining.holds));
    return shouldHaul === null ? null : !shouldHaul;
  });

  /**
   * Only the SHIP-sourced requirements are shown here.
   *
   * The plan-sourced ones ("you have picked a belt") are the player's to satisfy
   * in the bot's own controls, which are on this page directly below — telling
   * them they have not picked a belt above the belt picker would be noise, and
   * asserting they HAVE picked one would be a guess. The declaration carries the
   * distinction so this filter is not a hardcoded list of ids.
   */
  const miningRows = $derived(
    evaluateRequirements(MINING_BOT_REQUIREMENTS, {
      inSpace: shipIsDocked === null ? null : !shipIsDocked,
      minersFitted: miners.fitted,
      minersOnline: miners.online,
      beltChosen: true,
      stationChosen: true,
      holdHasRoom,
    }).rows.filter((row) => row.source === "ship"),
  );

  const missionRows = $derived(
    evaluateRequirements(MISSION_BOT_REQUIREMENTS, {
      docked: shipIsDocked,
      agentChosen: true,
      agentStationKnown: true,
    }).rows.filter((row) => row.source === "ship"),
  );

  function rowsFor(id: BotID): readonly RequirementRow[] {
    return id === "mining" ? miningRows : missionRows;
  }

  /** The bot's own run state, straight from its slice. */
  function statusOf(id: BotID): string {
    return id === "mining" ? $bot.status : $missionBot.status;
  }

  /** What the badge says. Plain language, never the raw state word (R9a). */
  function statusWords(id: BotID): string {
    const status = statusOf(id);
    if (status === "running") {
      return "Running";
    }
    if (status === "paused") {
      return "Paused";
    }
    if (status === "error") {
      return "Stopped after a problem";
    }
    // A bot that has not been started, or was stopped cleanly, is simply ready
    // to go — this panel does not re-state a finished run's outcome, because
    // the bot's own readout below already does and does it better.
    return "Not running";
  }

  const running = $derived($bots.runningBotID);
  /**
   * What is holding the ship, named.
   *
   * ⚠ A PLUGIN'S LOOP IS NAMED HERE THOUGH IT IS NOT A BOT AND IS NOT ON THIS
   * PAGE. It is not in `BOTS`, so a lookup alone would answer "nothing
   * is running" about a ship a plugin is actively flying — and this panel's
   * next act would be to start a mining bot on top of it. Whoever holds the
   * hull gets said out loud; only the CONTROLS moved.
   */
  const runningName = $derived(
    running === "custom"
      ? ($customBot.name ?? "Your bot")
      : (BOTS.find((row) => row.id === running)?.name ?? $bots.runningPluginName),
  );

  /**
   * Open whatever is running, so a player who started a bot and wandered off
   * lands on it. It only ever moves the view to something that IS running, and
   * only while the player has not chosen otherwise.
   */
  $effect(() => {
    if ((running === "mining" || running === "mission") && opened === null) {
      opened = running;
    }
  });

  /**
   * The checklist needs the fit, the hold and the names behind them. This panel
   * asks in its OWN right rather than assuming another tab has been visited —
   * a player may well open the launcher first. Best-effort: a read that fails
   * leaves the requirement at "could not check", which is the honest answer and
   * is exactly what the cannot-tell verdict is for.
   */
  onMount(() => {
    void Promise.resolve(flow.loadFitting()).catch(() => {});
    void Promise.resolve(flow.loadMiningHolds()).catch(() => {});
  });

  // Names AND groups for whatever is fitted, so "is that a Strip Miner?" is
  // answerable — the group is the game's own answer to that (R47).
  $effect(() => {
    const refs = $fitting.slots
      .filter((slot) => slot.module !== null)
      .flatMap((slot) => [
        { kind: "type" as const, id: slot.module!.typeID },
        { kind: "typeGroup" as const, id: slot.module!.typeID },
      ]);
    if (refs.length > 0) {
      flow.requestNames(refs);
    }
  });
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Bots</h2>
    <!-- ⚠ WHAT IS FLYING THE SHIP BELONGS IN THE STRIP. It used to be a
         line of its own below two paragraphs of standing explanation - so the
         one fact on this panel that CHANGES sat underneath the two that never
         do, and the strip above it was empty. -->
    {#if runningName}
      <p class="stat-line">
        <strong>{runningName}</strong> is flying your ship right now.
      </p>
    {:else}
      <p class="stat-line">Nothing is running.</p>
    {/if}
  </header>
  <!-- ⚠ "EVERYTHING THIS CLIENT CAN RUN FOR YOU" IS GONE; THE RULES STAYED.
       That opener described the window, which the title bar and the list below
       it already do. Every sentence after it is a rule about what happens to
       your ship that nothing on screen shows. -->
  <p class="note">
    A bot runs in this tab: close it and your ship finishes what it was last
    told to do and sits. Only one bot can fly your ship at a time — starting one
    stops whatever else was running. A saved bot can instead run <em>on the
    server</em>, which keeps flying after this tab is gone. Saved bots are
    shared: anyone with a character here can run any of them.
  </p>
  <!-- ⚠ NOT "the Bot Manager tab" ANY MORE. There is no such rail entry to send
       anybody to, and this panel is reached FROM the Manager rather than beside
       it, so the old sentence pointed backwards up the path the player just
       walked.
       ⚠ AND NOT "these bots ship with the client" EITHER. That sentence
       described what this window is, which the window already is. What stays
       is the half that sends a player somewhere they cannot otherwise find. -->
  <p class="note">
    Saved bots, every pilot's current run, and starting one on a pilot you are
    not sitting in right now all live in the Bot Manager.
  </p>
</section>

<section>
  <h2>What you can run</h2>
  <div class="bot-list">
    {#each BOTS as entry (entry.id)}
      {@const rows = rowsFor(entry.id)}
      {@const isOpen = opened === entry.id}
      <article class="bot-card" class:running={holdsTheShip(statusOf(entry.id))}>
        <header class="bot-head">
          <h3>{entry.name}</h3>
          <span class="badge">{statusWords(entry.id)}</span>
        </header>
        <p class="note">{entry.summary}</p>

        <h4>What it needs from your ship</h4>
        <ul class="checklist">
          {#each rows as row (row.id)}
            <li class={`check-${row.verdict}`}>
              <span class="mark" aria-hidden="true">
                {row.verdict === "met" ? "✓" : row.verdict === "cannot-tell" ? "?" : "•"}
              </span>
              <span>
                {row.title}
                <!--
                  R30/R33: an unmet requirement STATES ITS REASON rather than
                  going quiet. A checklist line that just fails to tick tells a
                  player nothing they can act on.
                -->
                {#if row.reason}
                  <span class="note"> — {row.reason}</span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>

        <p class="controls">
          <button
            type="button"
            class:primary={!isOpen}
            onclick={() => (opened = isOpen ? null : entry.id)}
            aria-expanded={isOpen}
          >
            {isOpen ? `Hide ${entry.name}` : `Set up and start ${entry.name}`}
          </button>
        </p>
      </article>
    {/each}
  </div>
</section>

<!--
  THE REAL COMPONENT, NOT A COPY. Its Start / Pause / Stop and its live readout
  are the ones that have been live-proven; embedding it is what stops this panel
  ever disagreeing with the bot it is launching.
-->
{#if opened === "mining"}
  <MiningBot {store} {flow} />
{:else if opened === "mission"}
  <MissionBot {store} {flow} />
{/if}

<style>
  .bot-list {
    display: grid;
    gap: 1rem;
    /* R8 — one column on a phone, two where there is room, never a sideways scroll. */
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  }
  .bot-card {
    border: 1px solid currentColor;
    border-radius: 0;
    padding: 0.75rem;
    /* The border is the only thing carrying "this one is live", so it is not
       colour alone — the badge says it in words too. */
    opacity: 0.95;
  }
  .bot-card.running {
    border-width: 2px;
  }
  .bot-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .bot-head h3 {
    margin: 0;
  }
  .badge {
    font-size: 0.85em;
    border: 1px solid currentColor;
    border-radius: 0;
    padding: 0.1rem 0.4rem;
    white-space: nowrap;
  }
  .checklist {
    list-style: none;
    padding: 0;
    margin: 0.25rem 0 0.75rem;
  }
  .checklist li {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
    margin: 0.3rem 0;
  }
  .mark {
    flex: 0 0 1rem;
    text-align: center;
  }
  .check-met .mark {
    font-weight: bold;
  }
  .check-cannot-tell {
    opacity: 0.85;
  }
  /* R8 — a comfortable target on a phone. */
  .bot-card button {
    min-height: 40px;
  }
</style>
