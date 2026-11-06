<script lang="ts">
  // BOT MANAGER — one row for one GROUP of pilots.
  //
  // Sibling to BotManagerPilotRow.svelte, and deliberately its shape: the same
  // bot picker, the same two ways to start, the same runtime limit on the one
  // they apply to. A player who has started a bot on one pilot already knows
  // how to start one on six.
  //
  // ⚠ WHAT IT ADDS OVER SIX PILOT ROWS IS THE PART THAT CANNOT BE DONE SIX
  // TIMES. A group start asks for approval ONCE, fetches the script ONCE, and
  // works the pilots one at a time so a refusal on pilot three does not strand
  // pilots four to six (bots/startRun.ts, bots/groupStart.ts). Doing it by hand
  // in the pilot rows means six confirms, six fetches of a library that can
  // change between them, and no shared record of how it went.
  //
  // ⚠ AND IT CAN REACH PILOTS NO TAB HERE HOLDS. The bot host mints its own
  // session and selects the character itself, so "Run on server" starts a pilot
  // that is not signed into this browser at all -- which is the whole point of
  // launching for a group. "Run here" cannot: a tab run flies a ship this tab
  // already controls, so it reaches only the members with a session open, and
  // says so rather than quietly doing less than it looks like.
  //
  // Every rule about WHO can be started lives in bots/pilotGroups.ts; this
  // component fetches, wires the flows, and renders.
  import {
    startServerBot as apiStartServerBot,
    startServerCompanion,
    stopServerBot,
    getBotScript,
    type ApiOptions,
    type BotScriptSummary,
    type ServerBot,
  } from "../app/api.ts";
  import type { Session } from "../app/sessions.ts";
  import {
    groupMemberStates,
    groupStartEmptyWords,
    groupCanStop,
    groupRosterWords,
    groupRunStatusWords,
    groupStatusWords,
    planGroupLaunch,
    planGroupStop,
    type PilotGroup,
  } from "../bots/pilotGroups.ts";
  import { groupStartSummary, type GroupStartEntry } from "../bots/groupStart.ts";
  import { startGroupHere, startGroupOnServer, type GroupStartOutcome } from "../bots/startRun.ts";
  import { startCompanionSquad } from "../bots/squadStart.ts";
  import {
    analyzeCompanionRunPolicy,
    COMPANION_GRANT_SCRIPT_REV,
  } from "../bots/companionRunPolicy.ts";
  import { createBotLaunchGrant, DEFAULT_SERVER_BOT_RUNTIME_MINUTES } from "../bots/runPolicy.ts";
  import type { CompanionSetup } from "../nav/fleetCompanionLoop.ts";
  import ActionButton from "./ActionButton.svelte";

  let {
    group,
    scripts,
    sessions,
    serverBots,
    ownerOptions,
    libraryOptions,
    companionSetups,
    nameOf,
    runtimeMinutes,
    onChanged,
  }: {
    group: PilotGroup;
    /** The library rows the panel already loaded — this row never fetches its own. */
    scripts: readonly BotScriptSummary[];
    /** Every pilot this browser tab holds, for "Run here" and for per-pilot tokens. */
    sessions: readonly Session[];
    /** The server roster the panel already polls. */
    serverBots: readonly ServerBot[];
    /**
     * The options a call about one member rides: its own session when this tab
     * holds it, otherwise its ACCOUNT's (BotManager.svelte's `ownerOptions`).
     */
    ownerOptions: (characterID: number) => Promise<ApiOptions>;
    /** Options any signed-in account can read the shared bot library with. */
    libraryOptions: () => Promise<ApiOptions>;
    /** Each companion's saved setup, by characterID. Empty for a squad group. */
    companionSetups: ReadonlyMap<number, CompanionSetup>;
    nameOf: (characterID: number) => string | null;
    /**
     * How long a server start may fly. ONE setting for the whole list, owned by
     * the panel: a limit per row was a picker repeated five times that nobody
     * set differently.
     */
    runtimeMinutes: number;
    /** Fires after a start, so the panel re-reads the roster. */
    onChanged: () => void;
  } = $props();

  // --- who is where ---------------------------------------------------------
  //
  // ⚠ `.get()`, NOT `$store` SUGAR, for the same reason BotManager.svelte reads
  // held characters that way: these are OTHER pilots' stores, any number of
  // them, and the list itself changes. The read re-runs whenever `sessions` or
  // `serverBots` change identity — and `serverBots` is replaced by the panel's
  // 3s roster poll, so the row cannot sit on a stale reading for long.
  //
  // ⚠ A PLAIN FUNCTION, NOT A `$derived` HOLDING ONE. A `$derived` is a VALUE;
  // one that evaluates to a function has to be called to be useful, and the
  // house sweep in ui/panelFirstMount.test.ts refuses exactly that shape
  // because `thing()` on a `$derived` is indistinguishable at a glance from
  // the far commoner bug of calling a derived value by mistake. Reading the
  // `sessions` prop inside a plain function is reactive on its own.
  function sessionFor(characterID: number): Session | undefined {
    return sessions.find((s) => s.store.station.get().online?.characterID === characterID);
  }

  const heldCharacterIDs = $derived(
    sessions
      .map((session) => session.store.station.get().online?.characterID ?? null)
      .filter((id): id is number => id !== null),
  );

  /** Held pilots whose own tab is already flying something. */
  const busyHereCharacterIDs = $derived.by(() => {
    // Read for its identity: the poll replacing it is what looks at these stores again.
    void serverBots;
    return sessions
      .filter((session) => session.store.bots.get().runningBotID !== null)
      .map((session) => session.store.station.get().online?.characterID ?? null)
      .filter((id): id is number => id !== null);
  });

  const states = $derived(
    groupMemberStates(group.members, {
      serverBots,
      heldCharacterIDs,
      busyHereCharacterIDs,
      nameOf,
    }),
  );
  const plan = $derived(planGroupLaunch(states));
  const statusWords = $derived(groupStatusWords(states));
  const roster = $derived(groupRosterWords(states));
  const stopPlan = $derived(planGroupStop(states, serverBots));
  /** The row's one button is Stop while anything this row may stop is flying. */
  const canStop = $derived(groupCanStop(stopPlan));

  // --- the picker -----------------------------------------------------------
  //
  // ⚠ SAVED BOTS ONLY, AND THE ABSENCE OF THE BUILT-INS IS EXPLAINED BELOW
  // RATHER THAN HIDDEN. A pilot row offers built-ins because picking one there
  // has an honest action — go to that pilot's own panel and set it up against
  // the ship it is sitting in. A group has no such panel and no such ship:
  // "which belt, which station, which agent" is a different answer per pilot,
  // so a built-in in this list would be a choice with no button under it.
  let selectedScriptID = $state<string | null>(null);

  /**
   * Where Start flies the group: unticked (the default), only the pilots
   * signed in to this tab; ticked, on the server, where it outlives the tab.
   * Unticked by default at the player's request: a server run is the one that
   * keeps flying unwatched, so it is the one a player opts into.
   *
   * ⚠ ONE BUTTON, AND THIS IS WHAT USED TO BE THE SECOND ONE. The two starts
   * differ only in what happens when the tab closes, so it is a setting on the
   * start rather than a second start. Companions always fly on the server and
   * have no box to untick.
   */
  let onServer = $state(false);

  const isCompanions = $derived(group.kind === "companions");
  /** Companions flies itself; a squad needs a bot chosen first. */
  const canStart = $derived(isCompanions || selectedScriptID !== null);

  // --- running it -----------------------------------------------------------
  let busy = $state(false);
  let startError = $state<string | null>(null);
  let rows = $state<readonly GroupStartEntry[]>([]);
  let summary = $state<string | null>(null);

  function begin(targets: readonly number[]): boolean {
    startError = null;
    summary = null;
    rows = targets.map((characterID) => ({ characterID, state: "queued" as const }));
    if (targets.length === 0) {
      summary = groupStartEmptyWords(group.kind, group.members.length);
      return false;
    }
    busy = true;
    return true;
  }

  function finish(entries: readonly GroupStartEntry[]): void {
    summary = groupStartSummary(entries, groupStartEmptyWords(group.kind, group.members.length));
    // The server roster is what this row reads its states from; ask for it now
    // rather than waiting out the panel's poll.
    onChanged();
  }

  /**
   * The token a call about this member must ride.
   *
   * ⚠ THE MEMBER'S OWN SESSION WHEN IT HAS ONE, and that is not a nicety.
   * `/api/bots/start` releases the CALLER's held session and claims the
   * character atomically; for a pilot this tab is holding, the caller has to be
   * that pilot's own session or the server sees the hull still held by somebody
   * else and refuses with CHARACTER_IN_USE.
   *
   * ⚠ A MEMBER WITH NO SESSION HERE IS REACHED AS ITS OWN ACCOUNT, never as
   * whichever pilot is on screen — the gateway refuses a character the
   * caller's account does not own, and a group may span several accounts.
   * The panel decides how (app/accountPass.ts); a sign-in that fails is that
   * member's refusal, and the rest of the group still flies.
   */
  function optionsFor(characterID: number): Promise<ApiOptions> {
    return ownerOptions(characterID);
  }

  /**
   * Catch this tab's own UI up after the host took a hull a session here held.
   *
   * ⚠ NOT THE HANDOVER — the server already did that as part of the start. A
   * failure here is not a failed start: the bot has the hull either way.
   */
  async function releaseHeld(characterID: number): Promise<void> {
    await sessionFor(characterID)?.flow.releaseSession();
  }

  async function runOnServer(): Promise<void> {
    if (busy || !canStart) return;
    // ⚠ THE COMPANIONS LIST IS NARROWED HERE, NOT INSIDE THE START. A member
    // whose setup went missing between the read and the press has nothing to
    // fly, and queueing it would put a row on screen that can never resolve.
    const targets = isCompanions
      ? plan.onServer.filter((characterID) => companionSetups.has(characterID))
      : plan.onServer;
    if (!begin(targets)) return;
    try {
      if (isCompanions) {
        await runCompanionsOnServer(targets);
      } else {
        await runScriptOnServer(targets);
      }
    } finally {
      busy = false;
    }
  }

  async function runScriptOnServer(targets: readonly number[]): Promise<void> {
    const scriptID = selectedScriptID;
    if (scriptID === null) return;
    const outcome = await startGroupOnServer(
      {
        fetchScript: async (id) => getBotScript(id, await libraryOptions()),
        confirm: (message) => window.confirm(message),
        startServerBot: async (characterID, id, grant) =>
          apiStartServerBot(characterID, id, grant, await optionsFor(characterID)),
        releaseHeld,
      },
      scriptID,
      targets,
      runtimeMinutes,
      (entries) => {
        rows = entries;
      },
    );
    applyGroupOutcome(outcome);
  }

  /**
   * The Companions group's start.
   *
   * ⚠ NO CONFIRM, DELIBERATELY, AND IT IS NOT AN OVERSIGHT ABOUT SIX HULLS. The
   * confirm on a saved bot exists because a saved script is executable
   * authority of unknown content — it is fetched, decoded and its permissions
   * read out before a player agrees to it. A companion is fixed code in this
   * client with a setup the player themselves ticked; the Pilot Hangar's own
   * squad FLY button starts one the same way, and a second gate here would make
   * the same act mean different things in two windows.
   *
   * ⚠ AND THE GRANT IS BUILT PER PILOT, from that pilot's own setup — see
   * bots/squadStart.ts. One grant reused across the group would not describe
   * whichever member pays for repairs when the others do not, and the host
   * re-derives and compares.
   */
  async function runCompanionsOnServer(targets: readonly number[]): Promise<void> {
    const entries = await startCompanionSquad(
      {
        startCompanion: async (characterID, setup) => {
          const grant = createBotLaunchGrant(
            COMPANION_GRANT_SCRIPT_REV,
            analyzeCompanionRunPolicy(setup),
            DEFAULT_SERVER_BOT_RUNTIME_MINUTES,
          );
          await startServerCompanion(characterID, setup, grant, await optionsFor(characterID));
          try {
            // Same sync, same order, same reason as the saved-bot path: the
            // host has the hull, so a member whose tab was holding it must
            // stop showing a ship it no longer flies.
            await releaseHeld(characterID);
          } catch {
            // The companion has the hull either way; the tab's next read notices.
          }
        },
      },
      targets.flatMap((characterID) => {
        const setup = companionSetups.get(characterID);
        return setup === undefined ? [] : [{ characterID, setup }];
      }),
      (entries) => {
        rows = entries;
      },
    );
    finish(entries);
  }

  async function runHere(): Promise<void> {
    if (busy || !canStart || selectedScriptID === null) return;
    const scriptID = selectedScriptID;
    const targets = plan.here;
    if (!begin(targets)) return;
    try {
      const outcome = await startGroupHere(
        {
          fetchScript: async (id) => getBotScript(id, await libraryOptions()),
          confirm: (message) => window.confirm(message),
          startCustomBotFor: async (characterID, doc, id) => {
            const session = sessionFor(characterID);
            if (session === undefined) {
              // Unreachable through `plan.here`, which is built from the held
              // members. Said as a refusal rather than thrown as undefined so a
              // pilot signed out mid-start reads as one refused row.
              throw new Error("That pilot no longer has a tab open here.");
            }
            await session.flow.startCustomBot(doc, id);
          },
        },
        scriptID,
        targets,
        (entries) => {
          rows = entries;
        },
      );
      applyGroupOutcome(outcome);
    } finally {
      busy = false;
    }
  }

  function applyGroupOutcome(outcome: GroupStartOutcome): void {
    if (outcome.kind === "ran") {
      finish(outcome.entries);
    } else if (outcome.kind === "refused") {
      // Nothing started at all — the queued rows would be a lie about work
      // that never began.
      rows = [];
      startError = outcome.sentence;
    } else {
      // "declined": the player said no at the confirm. Not an error, and not a
      // run — clear the queue so the row does not show pilots waiting forever.
      rows = [];
    }
  }

  const startTargets = $derived(isCompanions || onServer ? plan.onServer : plan.here);
  const startLabel = $derived(
    busy ? "Starting" : isCompanions || onServer ? "Start on the server" : "Start in this tab",
  );

  function start(): void {
    void (isCompanions || onServer ? runOnServer() : runHere());
  }

  // --- stopping it ----------------------------------------------------------
  let stopping = $state(false);

  /**
   * Stop every member this row may stop: the pilot row's Stop, once per member.
   *
   * ⚠ ONE FAILURE DOES NOT STRAND THE REST, the same rule as a group start. Each
   * member is stopped on its own call as its own account, and a refusal is said
   * after the others have been tried.
   */
  async function stopGroup(): Promise<void> {
    if (stopping || !canStop) return;
    stopping = true;
    startError = null;
    summary = null;
    rows = [];
    let failed = 0;
    try {
      for (const characterID of stopPlan.here) {
        try {
          // Whichever is flying it here. stopPluginLoop does nothing without a plugin's loop.
          sessionFor(characterID)?.flow.stopCustomBot();
          sessionFor(characterID)?.flow.stopPluginLoop();
        } catch {
          failed += 1;
        }
      }
      for (const { characterID, botID } of stopPlan.onServer) {
        try {
          await stopServerBot(botID, await optionsFor(characterID));
        } catch {
          failed += 1;
        }
      }
      if (failed > 0) {
        startError = `Could not stop ${failed === 1 ? "1 pilot" : `${failed} pilots`} - they may have already ended.`;
      }
    } finally {
      stopping = false;
      onChanged();
    }
  }

  /** What the Status cell says, in order of what the player most needs. */
  const statusLine = $derived.by(() => {
    if (busy && rows.length > 0) {
      const started = rows.filter((row) => row.state === "started").length;
      return `${started} of ${rows.length} started`;
    }
    if (stopping) return "Stopping";
    const words = groupRunStatusWords(plan, isCompanions || onServer);
    // The bot the whole group flies, said once here rather than per name.
    return plan.busy.length > 0 && roster.commonBot !== null ? `${words} - ${roster.commonBot}` : words;
  });

  /** Members a start refused, with the server's own reason -- never dropped. */
  const refusals = $derived(rows.filter((row) => row.state === "refused"));
</script>

<!--
  ⚠ ONE LINE OF CONTROLS PER GROUP: a bot, where it flies, and one button that
  is Start or Stop. What is true of every group alike -- what the Server box
  means, the time limit, why built-ins are not in the picker -- is said once
  under the list by BotManager.svelte.
-->
<tr class="bot-group-row">
  <td data-label="Group">
    <span class="bot-group-name">
      {#if group.color}
        <span class="bot-group-swatch" style:background={group.color}></span>
      {:else}
        <span class="bot-group-swatch is-special"></span>
      {/if}
      {group.name}
    </span>
    <span class="bot-group-count">{statusWords}</span>
    {#if isCompanions}
      <!-- What makes this group the special one, in the place a player is
           deciding whether to press its button. -->
      <p class="note why">Always flies the fleet companion.</p>
    {/if}
    {#if states.length > 0}
      <p class="note why">{roster.names}</p>
    {/if}
  </td>
  {#if group.members.length === 0}
    <td data-label="Bot" colspan="4">
      <span class="note">{groupStartEmptyWords(group.kind, 0)}</span>
    </td>
  {:else}
    <td data-label="Bot">
      {#if isCompanions}
        <span class="note">Fleet companion</span>
      {:else}
        <select
          class="bot-group-pick"
          aria-label={`Bot for ${group.name}`}
          bind:value={selectedScriptID}
          disabled={busy || stopping}
        >
          <option value={null}>Choose a bot</option>
          {#each scripts as script (script.scriptID)}
            <option value={script.scriptID}>{script.name}</option>
          {/each}
        </select>
        {#if scripts.length === 0}
          <span class="note">No saved bots yet.</span>
        {/if}
      {/if}
    </td>
    <td data-label="Server">
      {#if isCompanions}
        <span class="note">Always</span>
      {:else}
        <label class="bot-group-server">
          <input type="checkbox" bind:checked={onServer} disabled={busy || stopping} />
          Server
        </label>
      {/if}
    </td>
    <td data-label="Run" class="bot-group-run">
      {#if canStop && !isCompanions}
        <ActionButton
          action="stop"
          danger
          disabled={stopping}
          label={stopping ? "Stopping" : `Stop ${group.name}`}
          onclick={() => void stopGroup()}
        />
      {:else}
        <ActionButton
          action="run-here"
          primary
          disabled={busy || !canStart || startTargets.length === 0}
          label={startLabel}
          onclick={start}
        />
      {/if}
    </td>
    <td data-label="Status">
      <span class="bot-group-status" class:is-flying={plan.busy.length > 0}>{statusLine}</span>
      {#if isCompanions}
        <!-- A companion in THIS TAB, and stopping any companion, is the Fleet
             companions window's whole job. Offering a second, weaker door onto
             it here would split one operation across two windows. -->
        <p class="note why">To fly companions in this tab, or stop them, use the Companions window.</p>
      {/if}
      {#if summary !== null && !busy && plan.busy.length === 0}
        <p class="note">{summary}</p>
      {/if}
      {#each refusals as row (row.characterID)}
        <p class="note error">{nameOf(row.characterID) ?? "Unknown pilot"}: {row.sentence ?? "could not start"}</p>
      {/each}
      {#if startError}
        <p class="note error">{startError}</p>
      {/if}
    </td>
  {/if}
</tr>

<style>
  /* The group's identity, carried over from the hangar chip that made it: the
     same colour dot, so a player recognises "Mining Op" as the thing they
     arranged rather than as a list that happens to share its name. */
  .bot-group-name {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-text-bright);
  }
  /* Square, as the hangar's own squad swatches are. */
  .bot-group-swatch {
    width: 0.6rem;
    height: 0.6rem;
    flex: 0 0 auto;
  }
  .bot-group-count {
    display: block;
    margin-left: 1rem;
    color: var(--color-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .bot-group-row .note.why {
    margin: 0.2rem 0 0;
  }
  .bot-group-row td[data-label="Group"] > .note.why {
    margin-left: 1rem;
  }
  .bot-group-pick {
    width: 100%;
    min-width: 8rem;
  }
  .bot-group-server {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 40px;
    color: var(--color-text);
    cursor: pointer;
    white-space: nowrap;
  }
  .bot-group-status {
    color: var(--color-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .bot-group-status.is-flying {
    color: var(--color-good);
  }
  /* Companions has no squad colour to show. A ring rather than a filled dot,
     so it reads as "not one of your squads" instead of borrowing a palette
     entry that would make it look like one. */
  .bot-group-swatch.is-special {
    background: transparent;
    border: 2px solid var(--color-accent);
  }
</style>
