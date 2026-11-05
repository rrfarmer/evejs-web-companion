<script lang="ts">
  // BOT MANAGER — region A, one row for one pilot (docs/bot-manager-brainstorm.md
  // §4 region A). Sibling to BotManager.svelte, which renders one of these per
  // held session plus one per `serverOnlyBots()` entry.
  //
  // `session` is OPTIONAL: a server bot can be flying a character for which no
  // tab is open in this browser tab at all (the roster in §4's "multibox
  // wrinkle" only sees held sessions, never a bot's own headless run). Rather
  // than fork this into two components, one prop is made optional and every
  // signal read below is guarded — the alternative (a separate "server-only
  // row" component) would duplicate the run-state rendering for no benefit,
  // since `pilotRunState`/`serverRunState` already collapse to the right
  // answer once `bots`/`customBot` are treated as absent.
  //
  // Follows CharacterChip.svelte's pattern for a background pilot staying
  // live: read THAT session's own store signals rather than the active
  // session's. Unlike CharacterChip, `session` here can be undefined and can
  // (in principle) change identity, so the slices are captured explicitly
  // inside `$effect` (App.svelte's station-watch effect is the precedent for
  // subscribing explicitly rather than with `$store` sugar) instead of once
  // at the top level.
  import { getBotScript, startServerBot as apiStartServerBot, stopServerBot, type ApiOptions, type BotScriptSummary, type ServerBot } from "../app/api.ts";
  import type { Session } from "../app/sessions.ts";
  import {
    lastAlertPhrase,
    pilotRunState,
    resumedNote,
    serverBotProvenance,
    serverRunState,
    type PilotRunState,
  } from "../bots/pilotRoster.ts";
  import { BOTS } from "../nav/botRegistry.ts";
  import { DEFAULT_SERVER_BOT_RUNTIME_MINUTES } from "../bots/runPolicy.ts";
  import { startHere, startOnServer, type StartOutcome } from "../bots/startRun.ts";
  import type { StationSlice } from "../store/clientStore.ts";
  import type { BotsState, CustomBotState, FlightState } from "../store/types.ts";
  import { deriveDocked } from "./tabs.ts";
  import ActionButton from "./ActionButton.svelte";

  let {
    session,
    serverBot,
    scripts,
    ownerOptions,
    onChanged,
    onSetUpBuiltIn,
  }: {
    session?: Session;
    serverBot: ServerBot | null;
    /** The library rows the panel already loaded — this row never fetches its own. */
    scripts: readonly BotScriptSummary[];
    /**
     * The options a call about a pilot rides — its account's, for a
     * server-only row that has no session here. Absent in tests, where the
     * row falls back to the tab's own token.
     */
    ownerOptions?: (characterID: number) => Promise<ApiOptions>;
    /** Fires after a stop OR a start, so the panel refreshes the roster and server-bot list either way. */
    onChanged: () => void;
    /**
     * Go to this pilot and open the built-in bots panel. Absent on a row with
     * no session — there is no pilot here to go to.
     */
    onSetUpBuiltIn?: () => void;
  } = $props();

  // A tab run with no server claim reads as "nothing running" here — the same
  // fallback tabRunState itself uses for a released ship — so a row never
  // shows stale data before its first store tick lands.
  const FALLBACK_BOTS: BotsState = { runningBotID: null, runningPluginName: null };
  const FALLBACK_CUSTOM_BOT: CustomBotState = {
    status: "idle",
    name: null,
    phase: null,
    why: null,
    stepPath: null,
    interruptID: null,
    pauseReason: null,
    note: null,
    startError: null,
    lastAlert: null,
  };

  let station = $state<StationSlice | null>(null);
  let flight = $state<FlightState | null>(null);
  let bots = $state<BotsState | null>(null);
  let customBot = $state<CustomBotState | null>(null);

  $effect(() => {
    if (!session) {
      station = null;
      flight = null;
      bots = null;
      customBot = null;
      return;
    }
    const unsubs = [
      session.store.station.subscribe((value) => {
        station = value;
      }),
      session.store.flight.subscribe((value) => {
        flight = value;
      }),
      session.store.bots.subscribe((value) => {
        bots = value;
      }),
      session.store.customBot.subscribe((value) => {
        customBot = value;
      }),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });

  const pilotName = $derived(
    session ? (station?.online?.characterName ?? null) : (serverBot?.characterName ?? null),
  );

  // Same station/system fallback chain CharacterChip.svelte reads from these
  // slices. A server-only row (no tab held here) has no station/flight
  // reading to derive a location from at all — said plainly rather than
  // guessed at.
  // (Docked, the station or its system; in space, the flight's system: the station slice keeps the last station read
  // after an undock, and named a station the pilot had left.)
  const where = $derived(
    session
      ? (deriveDocked(flight?.status ?? null, station?.online ?? null)
          ? (station?.station?.stationName ?? station?.station?.solarSystemName ?? flight?.solarSystemName ?? "Unknown")
          : (flight?.solarSystemName ?? "Unknown"))
      : "No tab open here",
  );

  const runState = $derived<PilotRunState>(
    session
      ? pilotRunState(bots ?? FALLBACK_BOTS, customBot ?? FALLBACK_CUSTOM_BOT, serverBot)
      : serverBot
        ? serverRunState(serverBot)
        : { mode: "none", botName: null, statusWords: "Nothing is running", detail: null },
  );

  const modeLabel = $derived(
    runState.mode === "server" ? "On the server" : runState.mode === "tab" ? "In this tab" : null,
  );

  // Decision 3's honest lifetime copy, plain enough to sit right under the badge.
  const lifetimeNote = $derived(
    runState.mode === "server"
      ? "Keeps flying if this tab closes."
      : runState.mode === "tab"
        ? "Stops if this tab closes."
        : null,
  );

  // A TAB run only exposes Pause/Resume/Stop when the custom-bot runner is the
  // one holding the ship — the controls this row is given
  // (session.flow.pauseCustomBot / resumeCustomBot / stopCustomBot) are that
  // runner's own remote control, not a generic one. A built-in bot's tab run
  // (mining/mission) is controlled from its own panel, unchanged by this row.
  const isCustomTabRun = $derived(
    session !== undefined && runState.mode === "tab" && bots?.runningBotID === "custom",
  );
  const customStatus = $derived(customBot?.status ?? null);
  // A plugin's loop in this tab has one control any plugin's can answer to: Stop.
  const isPluginTabRun = $derived(
    session !== undefined && runState.mode === "tab" && bots?.runningBotID?.startsWith("plugin:") === true,
  );

  // ⚠ A LIVE SERVER BOT SAYS MORE THAN ITS STATUS WORD. These three lines are
  // what the standalone Server Bots panel showed and this row did not, and they
  // are the reason that panel could not simply be deleted:
  //
  //  • the ALERT is the whole delivery. A server bot has no browser to notify,
  //    so if this row does not print `lastAlert`, an "alert me" watch that fired
  //    an hour ago reaches nobody at all. `runState.detail` cannot carry it —
  //    that is pauseReason/phase/why, none of which an alert is.
  //  • RESUMED says the server restarted mid-run and picked this bot back up.
  //  • PROVENANCE says which revision is flying, what it was permitted to do,
  //    and when the server will stop it regardless of anything here.
  //
  // Only for a bot that is still flying: an ended run is region C's subject, and
  // `serverBotFor` has already excluded ended bots from a held pilot's row.
  const liveServerBot = $derived(
    serverBot !== null && serverBot.endedAt === null ? serverBot : null,
  );
  // Date.now() at render: the phrase is relative ("4 minutes ago") and this row
  // re-renders on every roster poll, which is exactly when it can change.
  const serverAlert = $derived(
    liveServerBot === null ? null : lastAlertPhrase(liveServerBot, Date.now()),
  );
  const serverResumed = $derived(liveServerBot === null ? null : resumedNote(liveServerBot));
  const serverProvenance = $derived(
    liveServerBot === null ? null : serverBotProvenance(liveServerBot),
  );

  function pause(): void {
    session?.flow.pauseCustomBot();
  }
  function resume(): void {
    session?.flow.resumeCustomBot();
  }
  function stop(): void {
    session?.flow.stopCustomBot();
  }

  let busy = $state(false);
  let stopError = $state<string | null>(null);

  async function stopServer(): Promise<void> {
    if (serverBot === null || busy) {
      return;
    }
    busy = true;
    stopError = null;
    try {
      // Direct api.ts calls must ride the owning pilot's flow options; a
      // server-only row (no session held here) has no flow of its own and is
      // stopped AS ITS ACCOUNT — /api/bots/:id/stop is scoped to the caller's
      // account, so the tab's token would refuse any other account's bot.
      const options = session
        ? session.flow.requestOptions()
        : ((await ownerOptions?.(serverBot.characterID)) ?? {});
      await stopServerBot(serverBot.botID, options);
      onChanged();
    } catch {
      stopError = "Could not stop that bot — it may have already ended.";
    } finally {
      busy = false;
    }
  }

  // --- starting a saved bot ON THIS PILOT --------------------------------
  //
  // ⚠ THIS ROW'S OWN SESSION, NEVER THE PANEL'S. A pilot row's whole reason
  // to carry a Start control (rather than leaving that to Bots.svelte) is
  // that it can start a bot on a pilot who is not the active tab — so every
  // dep below reads `session.flow` / `session.store`, the row's OWN pilot,
  // not any `store`/`flow` belonging to the panel around it. Getting this
  // backwards would start a bot on whatever pilot happens to be active
  // instead of the one this row is showing.
  /**
   * What the picker is set to: a saved script's id, or a built-in bot's id.
   *
   * ⚠ THE TWO KINDS DO NOT START THE SAME WAY, which is why the picker cannot
   * simply be a longer list of scripts. A saved script has a scriptID, so it can
   * be handed to `startCustomBot` here or to the server. A built-in has no
   * script at all — it is code in `nav/botRegistry.ts` — so the server path,
   * which takes a scriptID, cannot express it, and its setup (which belt, which
   * station, which agent) lives in its own per-pilot panel. So picking one
   * offers exactly one action, and that action is to go there.
   */
  const BUILT_IN_PREFIX = "built-in:";
  let selectedValue = $state<string | null>(null);
  const selectedBuiltIn = $derived(
    selectedValue !== null && selectedValue.startsWith(BUILT_IN_PREFIX)
      ? selectedValue.slice(BUILT_IN_PREFIX.length)
      : null,
  );
  const selectedScriptID = $derived(selectedBuiltIn === null ? selectedValue : null);
  let runtimeMinutes = $state(DEFAULT_SERVER_BOT_RUNTIME_MINUTES);
  let startError = $state<string | null>(null);

  function applyOutcome(outcome: StartOutcome): void {
    if (outcome.kind === "refused") {
      startError = outcome.sentence;
    } else if (outcome.kind === "started") {
      startError = null;
      onChanged();
    }
    // "declined" (the player said no at the confirm): do nothing.
  }

  async function runHere(): Promise<void> {
    if (session === undefined || selectedScriptID === null || busy) {
      return;
    }
    const pilot = session;
    busy = true;
    startError = null;
    try {
      const outcome = await startHere(
        {
          fetchScript: (scriptID) => getBotScript(scriptID, pilot.flow.requestOptions()),
          confirm: (message) => window.confirm(message),
          startCustomBot: (doc, scriptID) => pilot.flow.startCustomBot(doc, scriptID),
        },
        selectedScriptID,
      );
      applyOutcome(outcome);
    } finally {
      busy = false;
    }
  }

  async function runOnServer(): Promise<void> {
    if (session === undefined || selectedScriptID === null || busy) {
      return;
    }
    const pilot = session;
    // THIS ROW'S OWN station reading — the character its own tab currently
    // holds — never the panel's active pilot.
    const characterID = pilot.store.station.get().online?.characterID ?? null;
    if (characterID === null) {
      startError = "Bring this pilot online first — the server bot flies its current character.";
      return;
    }
    busy = true;
    startError = null;
    try {
      const outcome = await startOnServer(
        {
          fetchScript: (scriptID) => getBotScript(scriptID, pilot.flow.requestOptions()),
          confirm: (message) => window.confirm(message),
          startServerBot: (charID, scriptID, grant) =>
            apiStartServerBot(charID, scriptID, grant, pilot.flow.requestOptions()),
          releaseSession: () => pilot.flow.releaseSession(),
        },
        selectedScriptID,
        characterID,
        runtimeMinutes,
      );
      applyOutcome(outcome);
    } finally {
      busy = false;
    }
  }
</script>

<tr>
  <td data-label="Pilot">{pilotName ?? "Unknown pilot"}</td>
  <td data-label="Where">{where}</td>
  <td data-label="Running">
    {#if runState.botName}
      <div>
        {runState.botName}
        {#if modeLabel}
          <span class="badge" class:accent={runState.mode === "server"}>{modeLabel}</span>
        {/if}
        <!--
          ⚠ A COMPANION'S READOUT USED TO BE HERE, AND ITS ABSENCE IS THE POINT.
          This row carried the whole fleet badge — in fleet, whose orders, can it
          tag, its fit warnings — because a companion was once listed as a bot.
          It is not one (nav/botRegistry.ts), and a bot library is not where a
          player looks for what their fleet is doing. All of it lives in the
          Fleet companions window now, over every pilot at once, and
          `runState.detail` below says so. What stays here is the ONE fact this
          panel cannot do without: that something is holding this hull.
        -->
      </div>
      {#if lifetimeNote}
        <p class="note why">{lifetimeNote}</p>
      {/if}
    {:else}
      —
    {/if}
  </td>
  <td data-label="Status">
    {runState.statusWords}
    {#if runState.detail}
      <p class="note why">{runState.detail}</p>
    {/if}
    {#if serverAlert}
      <!-- Above the quieter lines and marked: this is the only notification a
           server bot ever gives. -->
      <p class="alert">{serverAlert}</p>
    {/if}
    {#if serverResumed}
      <p class="note why">{serverResumed}</p>
    {/if}
    {#if serverProvenance}
      <p class="note why">{serverProvenance}</p>
    {/if}
  </td>
  <td data-label="Actions">
    <span class="row-actions">
      {#if isCustomTabRun}
        {#if customStatus === "paused"}
          <ActionButton action="resume" onclick={resume} />
        {:else}
          <ActionButton action="pause" disabled={customStatus !== "running"} onclick={pause} />
        {/if}
        <ActionButton action="stop" danger onclick={stop} />
      {:else if isPluginTabRun}
        <ActionButton action="stop" danger onclick={() => session?.flow.stopPluginLoop()} />
      {:else if runState.isCompanion}
        <!-- ⚠ NO STOP HERE, DELIBERATELY. Stopping a companion is the Fleet
             companions window's job, and it is not the same act as stopping a
             bot: it drops a pilot out of whatever its fleet is in the middle
             of, which is a decision made while LOOKING at the fleet. This panel
             names the run so nothing here lies about a free hull, and sends the
             player to the one place that can act on it. -->
        <span class="note">In the Fleet companions window</span>
      {:else if runState.mode === "server"}
        <ActionButton
          action="stop"
          danger
          disabled={busy}
          label={busy ? "Stopping…" : undefined}
          onclick={stopServer}
        />
      {:else if runState.mode === "none" && session !== undefined}
        <!-- ⚠ NOT `.row-actions`. This is a small FORM — a bot to pick, two
             different ways to start it, and a limit that governs only one of
             them — and `.row-actions` lays a flat row of buttons out, so the
             two labelled selects and the two buttons ran off the end of the
             cell and collided with the row beneath.
             The run limit sits WITH "Run on server" because that is the only
             thing it applies to; beside the bot picker it read as a setting on
             both, which is the one thing it is not. -->
        <div class="pilot-launch">
          <label class="pilot-launch-bot">
            Bot
            <!-- ⚠ TWO GROUPS, NAMED. The built-ins ship with the client and the
                 saved ones were written by somebody here; they start differently
                 (see `selectedValue` above), so a flat list would offer two
                 kinds of thing under one word and then change the buttons
                 underneath without explaining why. -->
            <select bind:value={selectedValue} disabled={busy}>
              <option value={null}>Choose a bot</option>
              <optgroup label="Built in">
                {#each BOTS as builtIn (builtIn.id)}
                  <option value={`${BUILT_IN_PREFIX}${builtIn.id}`}>{builtIn.name}</option>
                {/each}
              </optgroup>
              {#if scripts.length > 0}
                <optgroup label="Saved">
                  {#each scripts as script (script.scriptID)}
                    <option value={script.scriptID}>{script.name}</option>
                  {/each}
                </optgroup>
              {/if}
            </select>
          </label>
          {#if selectedBuiltIn !== null}
            <!-- A built-in needs setting up against THIS pilot's ship before it
                 can start, and that is a panel, not a row. Going there is the
                 only honest action to offer. -->
            <div class="pilot-launch-run">
              <button type="button" class="primary" disabled={busy} onclick={() => onSetUpBuiltIn?.()}>
                Set up
              </button>
              <span class="pilot-launch-where">check its requirements and start it</span>
            </div>
          {:else}
          <div class="pilot-launch-run">
            <ActionButton
              action="run-here"
              primary
              disabled={busy || selectedScriptID === null}
              onclick={runHere}
            />
            <span class="pilot-launch-where">in this tab</span>
          </div>
          <div class="pilot-launch-run">
            <ActionButton
              action="run-on-server"
              disabled={busy || selectedScriptID === null}
              label={busy ? "Handing over…" : undefined}
              onclick={runOnServer}
            />
            <span class="pilot-launch-where">on the server</span>
            <label class="pilot-launch-limit">
              for up to
              <select bind:value={runtimeMinutes} disabled={busy}>
                <option value={60}>1 hour</option>
                <option value={240}>4 hours</option>
                <option value={720}>12 hours</option>
                <option value={1440}>24 hours</option>
                <option value={2880}>48 hours</option>
                <option value={4320}>72 hours</option>
              </select>
            </label>
          </div>
          {/if}
        </div>
      {:else if runState.mode === "none"}
        <!-- A server-only row: no tab is open here to hold this character, so
             there is nothing this row can start (only stop, once something is
             running) — said plainly rather than rendering a dead control. -->
        <span class="note">No tab is open here for this pilot.</span>
      {/if}
    </span>
    {#if stopError}
      <p class="note error">{stopError}</p>
    {/if}
    {#if startError}
      <p class="note error">{startError}</p>
    {/if}
  </td>
</tr>

<style>
  /* The one line in this row worth interrupting the eye for. A server bot has no
     browser to notify, so an alert reaching the player at all depends on it not
     looking like the muted notes around it — same treatment the standalone
     Server Bots panel gave the same fact. */
  .alert {
    margin: 0.3rem 0 0;
    color: var(--color-accent);
    border-left: 2px solid var(--color-accent);
    padding-left: 0.4rem;
  }
</style>
