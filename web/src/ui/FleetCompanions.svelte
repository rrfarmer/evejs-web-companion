<script lang="ts">
  // FLEET COMPANIONS — the global window, and the one place companions live.
  //
  // ⚠ WHY IT IS NOT A PANEL IN A PILOT'S DESKTOP. A companion takes its orders
  // from a fleet, and a fleet is a thing several of your pilots are in at once.
  // The questions this window exists to answer — who is following whom, who has
  // stopped, who is not in the fleet yet — are questions about the SQUAD, and a
  // per-pilot panel can only ever answer them one pilot at a time, by switching
  // to each pilot in turn and destroying the view you were reading. So it is
  // hoisted onto App's global layer (globalWindow.ts) and opened from the
  // character bar, which is the only chrome that outlives a pilot switch.
  //
  // ⚠ AND WHY IT IS NOT IN THE BOT MANAGER, where it used to be. A companion is
  // not a bot: it has no script, no library row, no work it picks for itself,
  // nothing to export or share. It was built as the third instance of the
  // mining/mission bot pattern and inherited that furniture; `BotID` no longer
  // lists it (nav/botRegistry.ts) and neither does the Manager.
  //
  // ⚠ IT IS A ROSTER YOU BUILD, NOT A MIRROR OF WHO IS SIGNED IN. It used to
  // list every session in the tab automatically: a pilot brought online to
  // check a contract sat in the fleet roster beside the three you meant, and
  // nothing on screen said which was which. An op is a set of pilots the player
  // CHOSE, so the window holds that choice (app/companionRosterPrefs.ts) and
  // adding a pilot is the act that puts it in the fleet and sets it flying.
  //
  // ⚠ THE JOIN IS THE `join-advertised-fleet` PROTOCOL, NOT A NEW ONE. You name
  // the op's fleet as it appears in the fleet finder; each added pilot then
  // applies, reads the SERVER'S OWN ANSWER, accepts the invite that answer says
  // was minted, and only then is in. An apply does not join you — see
  // docs/join-advertised-fleet-handoff.md, which is what an afternoon of a bot
  // hanging on a healthy fleet bought. The decider is nav/fleetJoinWatch.ts and
  // this file is only its driver: it performs what the decider asks for and
  // hands back what the server said.
  //
  // TWO KINDS OF ROW, both listed here because both are companions:
  //   • a TAB run — a pilot you added, flown by this tab's own loop, and
  //     stopped when the tab closes;
  //   • a SERVER run — started from the Pilot Hangar, flown headless by the BFF,
  //     and still flying when every tab is shut. Those are listed even though
  //     nobody added them: the Manager no longer shows companions, so without
  //     this a headless companion would have no door at all.
  //
  // ⚠ IT EMBEDS THE REAL PANEL AND FORKS NOTHING. The selected pilot's controls
  // and readout are `FleetCompanion.svelte` itself, bound to THAT pilot's store
  // and flow — the same component, the same Start/Pause/Stop, the same checklist
  // that has been live-proven. A second copy of a readout drifts, and a drifted
  // readout does not go quiet: it keeps rendering, confidently, about a
  // companion doing something else.
  import { onMount } from "svelte";
  import FleetCompanion from "./FleetCompanion.svelte";
  import { readBotLog, stopServerBot, type ServerBot } from "../app/api.ts";
  import { buildLogView, parseLogLines } from "./companionLogView.ts";
  import type { BotLogEntry } from "../nav/botLog.ts";
  import { createPilotReach } from "../app/pilotReach.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { holdsTheShip, type ShipControllerID } from "../nav/botRegistry.ts";
  // ⚠ NO `canTagWords` HERE ANY MORE. The roster dropped its Can tag column;
  // what it says now is a short qualifier in the Companion cell, and only when
  // the answer is not a plain yes. `canTagWords` is still the wording for the
  // per-pilot readout in FleetCompanion.svelte, which is the view that reports
  // every field for one pilot rather than one field for every pilot.
  import { inFleetWords, orderFromWords } from "../bots/companionReadout.ts";
  import {
    EMPTY_RESTART_MEMORY,
    companionRestartWords,
    companionStatusWords,
    companionSummaryWords,
    decideCompanionRestart,
    type CompanionRestartMemory,
    inFleetFrom,
    runFactsFor,
    serverCompanions,
    tallyCompanions,
  } from "../nav/companionRoster.ts";
  import {
    EMPTY_JOIN_MEMORY,
    decideFleetJoin,
    type FleetFinderRead,
    type FleetJoinMemory,
    type FleetJoinVerdict,
  } from "../nav/fleetJoinWatch.ts";
  import type { FleetApplication } from "../nav/scriptConditions.ts";
  import {
    EMPTY_COMPANION_ROSTER,
    addRosterMember,
    loadCompanionRoster,
    removeRosterMember,
    saveCompanionRoster,
    setRosterFleetName,
    setRosterSetup,
    type CompanionRosterPrefs,
  } from "../app/companionRosterPrefs.ts";
  import { loadKnownAccounts, loadKnownCharacters } from "../app/knownCharacters.ts";
  import {
    MAX_CAPACITOR_FLOOR,
    MAX_FLEE_ATTEMPTS,
    MAX_FLEE_HEALTH_FLOOR,
    MIN_CAPACITOR_FLOOR,
    MIN_FLEE_ATTEMPTS,
    MIN_FLEE_HEALTH_FLOOR,
    MIN_ABANDON_DRONES_HEALTH_FLOOR,
    abandonDronesFloor,
    type CompanionSetup,
  } from "../nav/fleetCompanionLoop.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { CHAT_COMMAND_HELP } from "../nav/chatCommands.ts";
  import type { Session } from "../app/sessions.ts";
  import type { FleetCompanionState } from "../store/types.ts";

  let {
    sessions,
    onGoToPilot,
  }: {
    // ⚠ NO `flow`. This window used to borrow the ACTIVE pilot's for the
    // account-scoped read of the server's companions, which showed one
    // account's and nothing at all on the Pilot Hangar with nobody in the
    // client. Every per-pilot action below goes through that pilot's OWN flow;
    // the server's roster is read as each account (app/pilotReach.ts).
    sessions?: readonly Session[];
    /** Make a pilot the active cockpit. Absent in tests and harnesses. */
    onGoToPilot?: (sessionID: string) => void;
  } = $props();

  const pilots = $derived(sessions ?? []);

  // --- the op ---------------------------------------------------------------

  let roster = $state<CompanionRosterPrefs>(loadCompanionRoster());

  function keepRoster(next: CompanionRosterPrefs): void {
    roster = next;
    saveCompanionRoster(next);
  }

  /**
   * One pilot's live readings, rebuilt from every session on each store tick.
   *
   * ⚠ REBUILT WHOLE, NEVER PATCHED. Writing `live = { ...live, [id]: … }` would
   * READ `live` inside the effect that writes it, and a Svelte effect that reads
   * what it writes re-runs itself forever. There are a handful of pilots; the
   * rebuild is free and the loop it avoids is not.
   *
   * ⚠ AND IT SUBSCRIBES TO EACH SESSION'S OWN SLICES rather than the active
   * pilot's store, which is the same thing BotManagerPilotRow does and for the
   * same reason: a backgrounded pilot is still live on the BFF, and the whole
   * point of this window is to show what it is doing while you are looking at
   * somebody else.
   */
  interface LivePilot {
    readonly name: string;
    readonly where: string;
    readonly characterID: number | null;
    readonly companion: FleetCompanionState;
    readonly holder: ShipControllerID | null;
    /**
     * The Fleet Center's own answer for this pilot.
     *
     * ⚠ WITHOUT IT THE IN-FLEET COLUMN IS DEAD UNTIL SOMETHING RUNS. A
     * companion's slice only carries a fleet reading while it is flying, so a
     * roster that asked only the slice would print "not known" against every
     * idle pilot — and "who is not in the fleet yet" is half of what this
     * window is for. `inFleetFrom` owns which of the two wins.
     */
    readonly fleetAvailability: string | null;
  }
  let live = $state<Record<string, LivePilot>>({});
  $effect(() => {
    const refresh = (): void => {
      const next: Record<string, LivePilot> = {};
      for (const session of pilots) {
        const state = session.store.get();
        next[session.id] = {
          name: state.station.online?.characterName ?? "This pilot",
          where:
            state.station.station?.stationName ??
            state.station.station?.solarSystemName ??
            state.flight.solarSystemName ??
            "Unknown",
          characterID: state.station.online?.characterID ?? null,
          companion: state.companion,
          holder: state.bots.runningBotID,
          fleetAvailability: state.fleet.availability,
        };
      }
      live = next;
    };
    const unsubs: Array<() => void> = [];
    for (const session of pilots) {
      unsubs.push(session.store.station.subscribe(refresh));
      unsubs.push(session.store.flight.subscribe(refresh));
      unsubs.push(session.store.companion.subscribe(refresh));
      unsubs.push(session.store.bots.subscribe(refresh));
      unsubs.push(session.store.fleet.subscribe(refresh));
    }
    refresh();
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });

  /** The signed-in session flying a given character, when there is one. */
  function sessionFor(characterID: number): Session | null {
    for (const session of pilots) {
      if (live[session.id]?.characterID === characterID) {
        return session;
      }
    }
    return null;
  }

  /**
   * A name for a pilot that is on the roster but not signed in here.
   *
   * ⚠ THE ROSTER STORES IDS AND NOTHING ELSE, and R7d forbids showing one. The
   * browser already knows the names of every pilot it has seen
   * (app/knownCharacters.ts), so the name is looked up rather than copied into
   * a second store that would go stale the day somebody is renamed.
   */
  const knownNames = $derived(
    new Map(loadKnownCharacters().map((known) => [known.characterID, known.characterName])),
  );

  // --- the join watch -------------------------------------------------------
  //
  // One watch per added pilot, ticked on a timer. It performs exactly what
  // nav/fleetJoinWatch.ts asks for and feeds back what the server answered;
  // every rule about what to do next lives in that module, where it can be
  // tested without a fleet.

  /** How often each unsettled pilot re-reads its fleet and the finder. */
  const WATCH_TICK_MS = 10_000;

  interface Watch {
    readonly memory: FleetJoinMemory;
    /** What the last apply answered. Only the caller of a write ever sees it. */
    readonly application: FleetApplication | null;
    readonly finder: FleetFinderRead;
    readonly verdict: FleetJoinVerdict | null;
    /**
     * ⚠ THE GUARD THAT KEEPS A STOP STOPPED. Adding a pilot starts it; without
     * this latch the next tick would see a pilot in the fleet not flying and
     * start it again, so the player's own Stop (and Stop all) would undo itself
     * ten seconds later. It is cleared only when the pilot is out of the fleet
     * and looking for it again, which is the op resuming rather than a decision
     * being overridden.
     */
    readonly started: boolean;
    /**
     * ⚠ LATCHED, AND DELIBERATELY STICKY. See `standingDown` in
     * nav/fleetJoinWatch.ts: the abandonment protocol ends by releasing the
     * ship, and a watch that treated that as "not in the fleet" would rejoin,
     * find itself alone again, and stand down again half an hour later, for
     * ever. Cleared when a human puts the companion back to running.
     */
    readonly stoodDown: boolean;
    /**
     * Why the last call was refused, in the player's words.
     *
     * ⚠ THE SWALLOWING IS WHAT COST AN AFTERNOON LAST TIME. A watch that
     * retries for ever shows the same patient sentence whether the fleet is
     * simply not advertised yet or every apply is being refused outright, and
     * the player has no way to tell those apart. Kept beside the row's own
     * words rather than raised as a panel error: it is one pilot's problem, and
     * the roster is where that pilot is.
     */
    readonly refusal: string | null;
    /**
     * The restart bound for a companion that went down by itself. See
     * `decideCompanionRestart`: the operator's own Stop and Pause are never
     * restarted, and `started` above still guards the join-start.
     */
    readonly restart: CompanionRestartMemory;
    /** Out of restarts: the row says it is waiting for the operator. */
    readonly givenUp: boolean;
  }

  const EMPTY_WATCH: Watch = {
    memory: EMPTY_JOIN_MEMORY,
    application: null,
    finder: { ads: null, ownFleetName: null },
    verdict: null,
    started: false,
    stoodDown: false,
    refusal: null,
    restart: EMPTY_RESTART_MEMORY,
    givenUp: false,
  };

  let watches = $state<Record<number, Watch>>({});
  /** Pilots with a call in flight this tick — never two at once for one pilot. */
  const inFlight = new Set<number>();

  function setWatch(characterID: number, next: Watch): void {
    watches = { ...watches, [characterID]: next };
  }

  async function tickWatch(characterID: number): Promise<void> {
    const session = sessionFor(characterID);
    if (!session || inFlight.has(characterID)) {
      return;
    }
    const watch = watches[characterID] ?? EMPTY_WATCH;
    const pilot = live[session.id] ?? null;
    const companion = pilot?.companion ?? null;
    const holding = holdsTheShip(companion?.status ?? "idle");

    // The latch, both ways: an abandonment under way sets it, and a companion
    // a human has put back to running clears it.
    let stoodDown = watch.stoodDown;
    if (companion?.abandonment != null) stoodDown = true;
    else if (companion?.status === "running") stoodDown = false;

    inFlight.add(characterID);
    try {
      // Membership first: the watch's whole first question is whether this
      // pilot is in the fleet yet, and nothing else in this window refreshes a
      // BACKGROUNDED pilot's fleet.
      //
      // ⚠ BUT NOT WHEN THE RUN ALREADY ANSWERS IT. `flow.loadFleet` is five
      // bridge reads, and a companion that is flying reads its own fleet every
      // tick and reports what it saw — fresher than anything this window could
      // fetch. Paying five calls per pilot per beat for an answer already in
      // hand is the poll `skipWhileBusy`'s header warns about, arriving from
      // the other direction. `inFleetFrom` owns which source wins; this only
      // decides whether to pay for the second one.
      const runReading = holding ? (companion?.inFleet ?? null) : null;
      if (runReading !== true) {
        await Promise.resolve(session.flow.loadFleet()).catch(() => {});
      }
      const fleetSlice = session.store.fleet.get();
      const inFleet = inFleetFrom(fleetSlice.availability, companion?.inFleet ?? null, holding);

      // ⚠ READ EVERY TICK, EVEN FOR A PILOT ALREADY IN. It is the only thing
      // that NAMES the fleet a pilot is in, and a stale name is how a row comes
      // to claim the wrong fleet: an earlier version skipped this read once a
      // row settled, and retyping the op's fleet then left a pilot flying in
      // "Test" reading `In "Nightshift"`. Two argless reads per unsettled pilot
      // per ten seconds is the cheap half of this tick — `loadFleet` above is
      // the five-call one, and that is the one that gets skipped.
      //
      // It is told what this window knows of the pilot's being in a fleet: for
      // one known to be in none, the fleet's own advert is not asked for (the
      // client asks for it only in a fleet), and the read is the adverts alone.
      const finder = await session.flow.readFleetFinder(inFleet);

      const verdict = decideFleetJoin(
        {
          wantedName: roster.fleetName,
          inFleet,
          currentFleetID: fleetSlice.authoritativeFleetID,
          currentFleetName: finder.ownFleetName,
          ads: finder.ads,
          application: watch.application,
          standingDown: stoodDown,
        },
        watch.memory,
      );

      let application = watch.application;
      let memory = verdict.memory;
      // A tick that gets as far as deciding has nothing outstanding to explain;
      // whatever refused the last one is either fixed or about to say so again.
      let refusal: string | null = null;
      if (verdict.action.kind === "apply") {
        const applied = verdict.action.fleetID;
        try {
          // ⚠ THE ANSWER IS THE PROTOCOL. `true` means the advert wanted the
          // boss's approval and no invite exists; `false` means one was minted
          // and this client must accept it. Throwing it away is what made the
          // first version of this round trip hang.
          application = { fleetID: applied, outcome: await session.flow.applyToJoinFleet(applied) };
        } catch (cause) {
          // The id is dropped with the answer: the next tick starts the
          // application over rather than waiting on a call that never landed.
          // It is REPORTED, not swallowed — see `refusal`.
          application = null;
          memory = EMPTY_JOIN_MEMORY;
          refusal = panelErrorWords(cause);
        }
      } else if (verdict.action.kind === "accept") {
        try {
          // The fleet id is passed rather than looked up: the accept must not
          // wait on the invite notification being decoded into the slice.
          await session.flow.acceptFleetInvite(verdict.action.fleetID);
        } catch (cause) {
          // The attempt is already counted in `memory`; the bound in the
          // decider is what stops this repeating for ever.
          refusal = panelErrorWords(cause);
        }
      }

      // ⚠ ADDING A PILOT IS WHAT STARTS IT — the one place a start happens
      // without a press. It is gated on the latch above, on the ship being free,
      // and on this tab actually flying the pilot: a hull the SERVER is flying
      // is not ours to take.
      let started = verdict.state === "watching" ? false : watch.started;
      let joinStarted = false;
      if (
        verdict.state === "in" &&
        !started &&
        !holding &&
        !serverHeldCharacterIDs.has(characterID)
      ) {
        started = true;
        joinStarted = true;
        try {
          await session.flow.startFleetCompanion(roster.setup);
        } catch {
          // The start's own refusal lands on the pilot's companion slice and is
          // shown by the embedded panel, which is the view that owns it.
        }
      }

      // ⚠ THE OTHER START WITHOUT A PRESS: A COMPANION THAT WENT DOWN BY
      // ITSELF. Not gated on the fleet verdict -- a run the operator had going
      // is the operator's intent whether or not this tick could read the fleet,
      // and the ladder decides for itself what being out of one means. It IS
      // gated on the ship being this tab's: a hull the server is flying is not
      // ours to restart. The abandonment record goes back in, so a restart in
      // the middle of getting safe keeps the ORIGINAL thirty-minute clock
      // rather than handing the pilot a fresh one.
      const restartDecision = decideCompanionRestart(
        {
          status: companion?.status ?? null,
          selfPaused: companion?.selfPaused ?? false,
          failureReason: companion?.failureReason ?? null,
          why: companion?.why ?? null,
        },
        watch.restart,
        Date.now(),
      );
      if (restartDecision.restart && !joinStarted && !serverHeldCharacterIDs.has(characterID)) {
        started = true;
        try {
          await session.flow.startFleetCompanion(roster.setup, companion?.abandonment ?? null);
        } catch {
          // As above: a refused start says so on the companion slice.
        }
      }

      // ⚠ ONLY IF THE PILOT IS STILL IN THE OP. A tick awaits three calls, and a
      // player who pressed Remove during them would otherwise get the row back.
      if (roster.members.includes(characterID)) {
        setWatch(characterID, {
          memory,
          application,
          finder,
          verdict,
          started,
          stoodDown,
          refusal,
          // A join-start this tick already brought the pilot up; that start is
          // not one of the bounded restarts, so it is not counted as one.
          restart: restartDecision.restart && joinStarted
            ? { ...watch.restart, downSinceMs: null }
            : restartDecision.memory,
          givenUp: restartDecision.givenUp,
        });
      }
    } finally {
      inFlight.delete(characterID);
    }
  }

  onMount(() => {
    const beat = skipWhileBusy(async () => {
      for (const characterID of roster.members) {
        await tickWatch(characterID);
      }
    });
    void beat();
    const handle = setInterval(() => void beat(), WATCH_TICK_MS);
    return () => clearInterval(handle);
  });

  // --- the server's own companions -----------------------------------------
  //
  // Polled, for BotManager.svelte's reason: a headless companion changes phase,
  // joins a fleet and hits its runtime cap with no local event to notice, so an
  // onMount read alone would freeze this half of the roster at whenever the
  // window was opened — and a stale "Running" is a lie a player acts on.
  const SERVER_ROSTER_POLL_MS = 3000;
  let serverBots = $state<ServerBot[]>([]);
  let serverError = $state<string | null>(null);
  let serverLoaded = $state(false);

  const reach = createPilotReach({
    held: () => pilots,
    known: () => loadKnownCharacters(),
    accounts: () => loadKnownAccounts(),
  });
  onMount(() => () => void reach.release());

  async function refreshServer(): Promise<void> {
    try {
      const read = await reach.readServerBots();
      if (read.allFailed) {
        serverError = "Could not read the server's companions — is the server up?";
      } else {
        serverBots = [...read.bots];
        serverError =
          read.missing.length > 0
            ? `Could not read the companions on ${read.missing.join(", ")} — any running there are not listed.`
            : null;
      }
    } finally {
      serverLoaded = true;
    }
  }

  onMount(() => {
    void refreshServer();
    const beat = skipWhileBusy(refreshServer);
    const handle = setInterval(() => void beat(), SERVER_ROSTER_POLL_MS);
    return () => clearInterval(handle);
  });

  const serverRows = $derived(serverCompanions(serverBots));
  // A server companion flying a pilot whose tab is ALSO open here would
  // otherwise be two rows for one hull. The server holds the ship in that case
  // (bots/pilotRoster.ts's rule), so the tab row defers to it.
  const serverHeldCharacterIDs = $derived(new Set(serverRows.map((bot) => bot.characterID)));

  /** One row of the op: the pilot, its run, and where its joining has got to. */
  const tabRows = $derived(
    roster.members.map((characterID) => {
      const session = sessionFor(characterID);
      const state = session === null ? null : (live[session.id] ?? null);
      const holding = holdsTheShip(state?.companion?.status ?? "idle");
      return {
        characterID,
        session,
        name: state?.name ?? knownNames.get(characterID) ?? "This pilot",
        where: session === null ? "Not signed in here" : (state?.where ?? "Unknown"),
        companion: state?.companion ?? null,
        holder: state?.holder ?? null,
        joining: watches[characterID]?.verdict ?? null,
        joinRefusal: watches[characterID]?.refusal ?? null,
        inFleet: inFleetFrom(
          state?.fleetAvailability ?? null,
          state?.companion?.inFleet ?? null,
          holding,
        ),
        // The run-only columns, silent when no run holds this ship.
        facts: runFactsFor(holding, state?.companion ?? null),
        onServer: serverHeldCharacterIDs.has(characterID),
      };
    }),
  );

  /** Signed-in pilots that are not in the op yet — what Add offers. */
  const addable = $derived(
    pilots
      .map((session) => ({ session, pilot: live[session.id] ?? null }))
      .filter(
        (entry) =>
          entry.pilot?.characterID != null && !roster.members.includes(entry.pilot.characterID),
      ),
  );

  const tally = $derived(
    tallyCompanions([
      ...tabRows.filter((row) => !row.onServer).map((row) => row.companion?.status ?? null),
      ...serverRows.map((bot) => bot.status),
    ]),
  );
  const summary = $derived(companionSummaryWords(tally));

  /**
   * `targets called|all` across every flying pilot, for the header chip.
   *
   * ⚠ THE MODE IS PER PILOT, so the chip says "mixed" rather than picking one
   * when they disagree: a commander who switched only some of them (a pilot
   * that was offline when `targets all` was typed, say) needs to see that, not
   * a word that is true of half the fleet. No flying pilot reported one, no chip.
   */
  const targetMode = $derived.by((): string | null => {
    const modes = new Set<string>();
    for (const row of tabRows) {
      if (!row.onServer && row.facts.targetMode !== null) {
        modes.add(row.facts.targetMode);
      }
    }
    for (const bot of serverRows) {
      if (bot.companion?.targetMode != null) {
        modes.add(bot.companion.targetMode);
      }
    }
    if (modes.size === 0) {
      return null;
    }
    if (modes.size > 1) {
      return "mixed";
    }
    return modes.has("all") ? "free fire" : "called";
  });

  /** Which row's detail is open: a session id, or `server:<botID>`. */
  let selected = $state<string | null>(null);
  const selectedSession = $derived(pilots.find((session) => session.id === selected) ?? null);
  const selectedServerBot = $derived(
    serverRows.find((bot) => `server:${bot.botID}` === selected) ?? null,
  );

  /**
   * Land on whatever is flying, so a player opening this window sees the run
   * they came to check rather than an arbitrary first pilot. It only ever moves
   * the view to something that IS holding a ship, and only while the player has
   * not chosen otherwise.
   */
  $effect(() => {
    if (selected !== null) return;
    const flying = tabRows.find(
      (row) => row.session !== null && holdsTheShip(row.companion?.status ?? "idle"),
    );
    if (flying?.session) {
      selected = flying.session.id;
      return;
    }
    const headless = serverRows[0];
    if (headless) {
      selected = `server:${headless.botID}`;
      return;
    }
    const first = tabRows.find((row) => row.session !== null);
    if (first?.session) selected = first.session.id;
  });

  /** Hand the cockpit to whichever pilot's readout is open. */
  function goToSelectedPilot(): void {
    const id = selectedSession?.id;
    if (id !== undefined) onGoToPilot?.(id);
  }

  // --- the flight log ---------------------------------------------------------
  //
  // READ-ONLY, ONE PILOT AT A TIME, AND ONLY WHEN ASKED. The log is the file the
  // BFF keeps for the character of the session the request is made as, so the
  // read goes through THAT pilot's own flow options (`flow.requestOptions()`,
  // which carries its session token) and can never show another pilot's lines.
  // No polling: Refresh is the only thing that reads it.
  interface PilotLog {
    open: boolean;
    which: "current" | "previous";
    loading: boolean;
    error: string;
    /** Null until the first read has landed. */
    entries: readonly BotLogEntry[] | null;
    /** Row indexes whose full trace is open. */
    expanded: readonly number[];
  }
  const NO_LOG: PilotLog = {
    open: false,
    which: "current",
    loading: false,
    error: "",
    entries: null,
    expanded: [],
  };

  let logs = $state<Record<string, PilotLog>>({});
  let logFilter = $state("");
  // A read that comes back after a newer one was asked for is dropped.
  const logReads = new Map<string, number>();

  function logOf(sessionID: string): PilotLog {
    return logs[sessionID] ?? NO_LOG;
  }

  function patchLog(sessionID: string, patch: Partial<PilotLog>): void {
    logs = { ...logs, [sessionID]: { ...logOf(sessionID), ...patch } };
  }

  async function loadLog(session: Session): Promise<void> {
    const ticket = (logReads.get(session.id) ?? 0) + 1;
    logReads.set(session.id, ticket);
    patchLog(session.id, { loading: true, error: "" });
    try {
      const raw = await readBotLog(logOf(session.id).which, session.flow.requestOptions());
      if (logReads.get(session.id) !== ticket) return;
      patchLog(session.id, { loading: false, entries: parseLogLines(raw), expanded: [] });
    } catch (cause) {
      if (logReads.get(session.id) !== ticket) return;
      patchLog(session.id, { loading: false, error: panelErrorWords(cause) });
    }
  }

  function toggleLog(session: Session): void {
    const next = !logOf(session.id).open;
    patchLog(session.id, { open: next });
    if (next && logOf(session.id).entries === null) void loadLog(session);
  }

  function pickLogRun(session: Session, which: "current" | "previous"): void {
    if (logOf(session.id).which === which) return;
    patchLog(session.id, { which, entries: null, expanded: [] });
    void loadLog(session);
  }

  function toggleTrace(sessionID: string, index: number): void {
    const open = logOf(sessionID).expanded;
    patchLog(sessionID, {
      expanded: open.includes(index) ? open.filter((entry) => entry !== index) : [...open, index],
    });
  }

  let busy = $state(false);
  let error = $state("");

  async function run(action: () => Promise<unknown> | unknown): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }

  // --- adding and removing --------------------------------------------------

  let addChoice = $state<string>("");

  function addPilot(): void {
    const entry = addable.find((candidate) => candidate.session.id === addChoice);
    const characterID = entry?.pilot?.characterID ?? null;
    if (characterID === null) return;
    keepRoster(addRosterMember(roster, characterID));
    // A fresh watch, so a pilot added again after being removed is not held by
    // the latches the last one left behind.
    setWatch(characterID, EMPTY_WATCH);
    selected = entry?.session.id ?? selected;
    addChoice = "";
    void tickWatch(characterID);
  }

  /**
   * Take a pilot out of the op: stop it flying, then take it out of the fleet.
   *
   * ⚠ REMOVING UNDOES THE ADD, MEMBERSHIP INCLUDED, at the operator's call. The
   * add put this pilot in somebody's fleet; leaving it there after the row is
   * gone leaves a ship in a fleet warp chain that nothing on this screen is
   * watching any more.
   *
   * ⚠ NO CONFIRMATION DIALOG, for this window's standing reason: a dialog in
   * front of a fleet that is currently being shot at is worse than either
   * outcome it was guarding.
   */
  async function removePilot(characterID: number): Promise<void> {
    const session = sessionFor(characterID);
    const wasInFleet = session !== null && live[session.id]?.fleetAvailability === "ready";
    keepRoster(removeRosterMember(roster, characterID));
    const rest: Record<number, Watch> = {};
    for (const [key, watch] of Object.entries(watches)) {
      if (Number(key) !== characterID) rest[Number(key)] = watch;
    }
    watches = rest;
    if (session === null) return;
    await run(async () => {
      session.flow.stopFleetCompanion();
      if (wasInFleet) {
        await session.flow.leaveFleet();
      }
    });
  }

  /**
   * Stop every companion this window can reach — the tab runs through each
   * pilot's own flow, the headless ones through the server.
   *
   * ⚠ IT STOPS, IT DOES NOT DISBAND. Nobody is taken out of the fleet: a stop
   * is how you take a ship back by hand mid-op, and pulling it out of the fleet
   * warp chain as well is the one thing you would not want at that moment.
   * Removing a pilot is the act that undoes a join.
   */
  async function stopAll(): Promise<void> {
    await run(async () => {
      for (const row of tabRows) {
        if (row.session !== null && row.companion !== null && holdsTheShip(row.companion.status)) {
          row.session.flow.stopFleetCompanion();
        }
      }
      for (const bot of serverRows) {
        await stopServerBot(bot.botID, await reach.ownerOptions(bot.characterID));
      }
      await refreshServer();
    });
  }

  const anyFlying = $derived(
    tabRows.some((row) => holdsTheShip(row.companion?.status ?? "idle")) || serverRows.length > 0,
  );

  // --- the op's limits ------------------------------------------------------
  //
  // ⚠ ONE SET OF NUMBERS FOR THE OP, NOT ONE PER PILOT, AND THAT IS BECAUSE
  // ADDING A PILOT STARTS IT. A per-pilot form is a form somebody has to fill
  // in before the start it gates, and nobody fills in four of them while a
  // fleet is forming. The embedded panel is handed exactly this and no longer
  // carries a form of its own — two forms for one run is two answers to the
  // same question, and only one of them would reach the loop.

  let fleeHealthFloorPercent = $state(Math.round(roster.setup.fleeHealthFloor * 100));
  let abandonDronesFloorPercent = $state(Math.round(abandonDronesFloor(roster.setup) * 100));
  let capacitorFloorPercent = $state(Math.round(roster.setup.capacitorFloor * 100));
  let maxFleeAttempts = $state(roster.setup.maxFleeAttempts);
  /**
   * Docking gives the shield and the capacitor back but NOT the armour, so a
   * pilot that fled on armour damage cannot get back above its floor by
   * arriving. Ticking this lets it pay the station to fix the difference;
   * leaving it off means such a pilot stays docked and says so.
   */
  let repairsAtStation = $state(roster.setup.repairsAtStation);

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Write the form back to the op.
   *
   * ⚠ IT CHANGES WHAT THE NEXT START FLIES UNDER, NOT A RUNNING ONE. A
   * companion is started with a request read off its hull at that moment
   * (`flow.startFleetCompanion`), and nothing re-reads these numbers afterwards;
   * pretending otherwise would be the setup form on a server run, which this
   * window already refuses to show for the same reason.
   */
  function keepSetup(): void {
    const fleePercent = clamp(fleeHealthFloorPercent, MIN_FLEE_HEALTH_FLOOR * 100, MAX_FLEE_HEALTH_FLOOR * 100);
    keepRoster(
      setRosterSetup(roster, {
        fleeHealthFloor: fleePercent / 100,
        // Never above the flee floor: the drones are left only once the flee
        // has already started, so a higher number would just mean "never wait".
        abandonDronesHealthFloor:
          clamp(abandonDronesFloorPercent, MIN_ABANDON_DRONES_HEALTH_FLOOR * 100, fleePercent) / 100,
        capacitorFloor:
          clamp(capacitorFloorPercent, MIN_CAPACITOR_FLOOR * 100, MAX_CAPACITOR_FLOOR * 100) / 100,
        maxFleeAttempts: clamp(maxFleeAttempts, MIN_FLEE_ATTEMPTS, MAX_FLEE_ATTEMPTS),
        repairsAtStation,
      } satisfies CompanionSetup),
    );
  }
</script>
<!--
  ⚠ THREE FRAMES BECAME ONE, BECAUSE THE OP IS ONE THOUGHT. The fleet name, the
  roster and the control that adds to it used to sit in three stacked panels,
  each with its own border, accent hairline and bottom margin — and the caption
  under the fleet field read "Pilots added BELOW join this fleet", a sentence
  that has to reach ACROSS a panel border to say what it means. A frame is a
  boundary: drawing one between a field and the list it governs tells the player
  they are separate settings. They are not. Naming the fleet, listing who flies
  in it, and adding the next pilot are one task, so they are one panel, read top
  to bottom: what the op IS, who is IN it, how to add the next.
-->
<section class="panel op-panel">
  <header class="panel-head">
    <h2 class="panel-title">Fleet companions</h2>
    <!-- ⚠ NO DESCRIPTION OF WHAT A COMPANION IS. The title says it, the table
         shows it, and a paragraph restating it is a paragraph the player reads
         once and then has to look past every time afterwards. What stays is the
         one line that CHANGES: how many are flying.
         And it sits IN the strip, beside Stop all, rather than on its own line
         under it — the count and the button that acts on the count are one
         thought, and splitting them across the divider made the strip look like
         a toolbar with a caption. -->
    <p class="stat-line">{summary}</p>
    {#if targetMode !== null}
      <span
        class="mode-chip"
        title="What companions shoot when nobody calls a target. Change it with targets called or targets all in fleet chat."
      >
        Targets: {targetMode}
      </span>
    {/if}
    <span class="controls">
      <button type="button" class="danger" disabled={busy || !anyFlying} onclick={stopAll}>
        Stop all
      </button>
    </span>
  </header>

  <!-- THE FLEET THE OP IS. Every pilot in the roster below watches for this name
       in the fleet finder and joins it when it appears, so it is asked for once,
       here, rather than per pilot. Typed as it is advertised: matching is
       trimmed and case-insensitive but never a substring, so an unattended ship
       cannot end up in a stranger's fleet whose name happened to contain the
       word.

       ⚠ THE FIELD GETS THE ROW AND THE EXPLANATION GETS THE NEXT ONE. Side by
       side, the longest sentence on the screen and the only input on it shared
       one line, and the input lost: measured in the running app it was squeezed
       to about a third of the row and clipped its own placeholder mid-word
       ("the name in the fleet finde"), so the one control that decides what
       every pilot below does looked like an afterthought beside its own
       footnote. Under it, the note is still read and the field is a field. -->
  <div class="op-fleet">
    <label for="companion-op-fleet">Fleet</label>
    <input
      id="companion-op-fleet"
      type="text"
      placeholder="the name in the fleet finder"
      value={roster.fleetName}
      oninput={(event) =>
        keepRoster(setRosterFleetName(roster, (event.currentTarget as HTMLInputElement).value))}
    />
    <span class="note">
      {#if roster.fleetName.trim().length === 0}
        Every pilot in this op joins this fleet as soon as it is advertised.
      {:else}
        Every pilot in this op waits for "{roster.fleetName.trim()}" and joins it as soon as it is
        advertised.
      {/if}
    </span>
  </div>

  <!-- ⚠ NO "PILOTS" HEADING OVER THE ONLY TABLE HERE. A section heading earns
       its place by telling one block apart from its siblings; this block has
       none, and the table names its own first column "Pilot". A heading over a
       panel's single table is the panel's title said a third time. -->
  {#if tabRows.length === 0 && serverRows.length === 0}
    <!-- ⚠ THE `.empty` TREATMENT, NOT A `.note`. An empty op is the STATE of
         this window, not a footnote to it: as grey fine print under the fleet
         field it read like a caption on the field above, and the one thing the
         player has to do next was set in the quietest ink on the panel. -->
    {#if pilots.length === 0}
      <p class="empty">
        No pilot is signed in here. Bring one online from the Pilot hangar, then add it to this op.
      </p>
    {:else}
      <p class="empty">
        Nobody is in this op yet. Add a pilot below and it will join the fleet and start flying.
      </p>
    {/if}
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <!-- ⚠ FIVE COLUMNS, AND SHORT ONES. "Following orders from" and
                 "Last order heard" were each about twice the width of the value
                 under them, so two of the five columns were mostly header. A
                 column head is a label, not a sentence.
                 ⚠ AND "CAN TAG" IS NOT ONE OF THEM ANY MORE — see the Companion
                 cell below, which is where that fact went. It was a column that
                 read "yes" for nearly every pilot nearly all the time, and a
                 column whose interesting value is rare is a column a player
                 stops reading before the day it matters. -->
            <th>Pilot</th>
            <th>Companion</th>
            <th>In fleet</th>
            <th>Orders from</th>
            <th>Last order</th>
          </tr>
        </thead>
        <tbody>
          {#each tabRows as row (row.characterID)}
            {@const state = row.companion}
            <!-- A pilot whose hull the SERVER is flying is listed by the server
                 row below instead: that side owns the run, and this tab's
                 companion slice is a stale copy of a run it is not driving. -->
            {#if !row.onServer}
              <tr class:selected={row.session !== null && selected === row.session.id}>
                <!-- ⚠ ONE LINE, NOT THREE. The name, the place and Remove were
                     three stacked blocks in this cell, so every pilot's row
                     stood about 80px tall while the four cells beside it held
                     one line each — a five-pilot op filled the window with one
                     column's leading. They sit on a line together now, and the
                     place wraps under the name only when the column is too
                     narrow to hold both. -->
                <td data-label="Pilot">
                  <span class="pilot-cell">
                    <span class="pilot-who">
                      {#if row.session !== null}
                        {@const sessionID = row.session.id}
                        <button
                          type="button"
                          class="link-button"
                          aria-pressed={selected === sessionID}
                          onclick={() => (selected = sessionID)}
                        >
                          {row.name}
                        </button>
                      {:else}
                        <span>{row.name}</span>
                      {/if}
                      <span class="note where">{row.where}</span>
                    </span>
                    <!-- ⚠ THE ROW'S ONE DESTRUCTIVE ACT, IN THE QUIETEST INK ON
                         THE ROW. It used to be an underlined link the same
                         weight as the pilot's own name directly above it, so the
                         two things you can click in this cell — open this pilot,
                         take it out of the fleet — looked identical. -->
                    <button
                      type="button"
                      class="link-button remove"
                      disabled={busy}
                      onclick={() => removePilot(row.characterID)}
                    >
                      Remove
                    </button>
                  </span>
                </td>
                <td data-label="Companion">
                  {companionStatusWords(state?.status ?? null)}
                  <!-- ⚠ THE REASON RIDES WITH THE WORD. "Stopped after a
                       problem" alone sends the player into the panel and down
                       past the start checklist to find which problem; the row
                       is where they are already looking. -->
                  {#if state?.status === "error" && state.failureReason}
                    <span class="note"> - {state.failureReason}</span>
                  {/if}
                  {#if watches[row.characterID]}
                    {@const restartWords = companionRestartWords(
                      watches[row.characterID].restart,
                      watches[row.characterID].givenUp,
                      Date.now(),
                    )}
                    {#if restartWords}
                      <span class="note"> - {restartWords}</span>
                    {/if}
                  {/if}
                  <!-- ⚠ SAID OUT LOUD, THOUGH A BOT IS NOT THIS WINDOW'S
                       BUSINESS. Starting a companion on a hull a bot is flying
                       takes the ship off that bot; a roster that showed only
                       companions would make that look like it came from
                       nowhere. -->
                  {#if state !== null && !holdsTheShip(state.status) && row.holder !== null && row.holder !== "companion"}
                    <span class="note"> — a bot is flying this ship</span>
                  {/if}
                  <!-- ⚠ ONLY ONE OF THESE IS A PROBLEM, AND IT IS NOT THE
                       COMMON ONE. `canTag === false` says this pilot is not a
                       fleet, wing or squad commander, which is what a companion
                       alt in somebody else's fleet always is and always will
                       be — it calls its tackler out by broadcast instead (rung
                       4's other arm), and there is nothing here for a player to
                       fix or even to think about. It used to read "cannot tag,
                       not a fleet commander", which flagged the normal case as
                       a fault every run, and was wrong besides: the pilot is
                       not unable to call a target, only unable to letter one.
                       ⚠ `null` IS THE ONE WORTH A LINE, and is still unflattened
                       — "we could not read the roster" is not an answer about
                       this pilot, and a run that stays there is a run whose
                       fleet reads are failing. `row.facts` is already silent
                       unless a run holds this ship, so it cannot appear against
                       an idle pilot. -->
                  {#if row.facts.canTag === null && holdsTheShip(state?.status ?? "idle")}
                    <span class="note"> — fleet roster unreadable, not calling targets</span>
                  {/if}
                </td>
                <!-- ⚠ THE JOINING SENTENCE, NOT A BARE YES/NO, and it is the
                     whole reason this column is worth reading now. "no" against
                     a pilot that is applying, and "no" against one waiting for
                     a fleet nobody has advertised yet, are the same word for
                     two situations the player would act on differently. The
                     watch's own words say which. A pilot with no watch yet — one
                     not signed in here — falls back to the plain answer. -->
                <td data-label="In fleet">
                  {row.joining?.words ?? inFleetWords(row.inFleet)}
                  {#if row.joinRefusal}
                    <span class="note">{row.joinRefusal}</span>
                  {/if}
                </td>
                <!-- ⚠ `row.facts`, NOT THE SLICE. The companion slice keeps its
                     last readout after a run ends, so reading it directly left a
                     stopped pilot still claiming to be following orders and
                     still reporting whether it could tag — three confident
                     sentences about a pilot doing nothing. -->
                <td data-label="Orders from">{orderFromWords(row.facts.followingOrderFrom)}</td>
                <td data-label="Last order">{row.facts.lastOrderHeard ?? "-"}</td>
              </tr>
            {/if}
          {/each}
          {#each serverRows as bot (bot.botID)}
            {@const facts = bot.companion}
            <tr class:selected={selected === `server:${bot.botID}`}>
              <td data-label="Pilot">
                <span class="pilot-cell">
                  <span class="pilot-who">
                    <button
                      type="button"
                      class="link-button"
                      aria-pressed={selected === `server:${bot.botID}`}
                      onclick={() => (selected = `server:${bot.botID}`)}
                    >
                      {bot.characterName ?? "Unnamed pilot"}
                    </button>
                    <span class="note where">On the server</span>
                  </span>
                </span>
              </td>
              <td data-label="Companion">
                {companionStatusWords(bot.status)}
                <!-- ⚠ THE SAME SENTENCE AS THE TAB ROWS, and it belongs here
                     MORE, not less: this run is on the server, so nobody is
                     sitting in front of it to notice its fleet reads failing.
                     No `holdsTheShip` guard is needed — a row exists in this
                     half of the roster only while the server is flying the
                     hull. `false` is silent here for the same reason it is
                     silent above: a plain member broadcasts its tackler instead
                     of lettering it, which is not news. -->
                {#if (facts?.canTag ?? null) === null}
                  <span class="note"> — fleet roster unreadable, not calling targets</span>
                {/if}
              </td>
              <td data-label="In fleet">{inFleetWords(facts?.inFleet ?? null)}</td>
              <td data-label="Orders from">{orderFromWords(facts?.followingOrderFrom ?? null)}</td>
              <td data-label="Last order">{facts?.lastOrderHeard ?? "-"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if !serverLoaded}
      <p class="note">Reading the server's companions…</p>
    {/if}
  {/if}

  <!-- ⚠ THE ADD CONTROL IS A FOOTER UNDER THE LIST IT ADDS TO, not a form row
       above it. It used to open the second panel, so the first thing under the
       fleet field was a control, and the roster it fills came after — a list
       introduced by the thing that appends to it. Under the list it needs no
       explaining: whatever is above is the op, and this is how it grows.
       ⚠ ONLY PILOTS ALREADY SIGNED IN. Bringing one online is the Pilot
       hangar's job and needs an account password; this window takes pilots that
       are already flying and puts them in a fleet. -->
  <!-- ⚠ GENERATED FROM `CHAT_COMMAND_HELP`, never written out here. The parser
       owns the verbs, and its own test fails when a command has no help row, so
       this list cannot fall behind what the companions actually obey. Closed by
       default: it is a reference, and the roster above it is what the window
       is for. -->
  <details class="chat-help">
    <summary>Chat commands <span class="note">- type them in fleet or local chat</span></summary>
    <dl>
      {#each CHAT_COMMAND_HELP as row (row.usage)}
        <dt>{row.usage}</dt>
        <dd>{row.does}</dd>
      {/each}
    </dl>
  </details>

  <div class="op-add">
    <label for="companion-add-pilot">Add a pilot</label>
    <select id="companion-add-pilot" bind:value={addChoice} disabled={addable.length === 0}>
      <option value="">Choose a pilot…</option>
      {#each addable as entry (entry.session.id)}
        <option value={entry.session.id}>{entry.pilot?.name ?? "This pilot"}</option>
      {/each}
    </select>
    <button type="button" class="primary" disabled={addChoice === ""} onclick={addPilot}>
      Add
    </button>
    <!-- Only when there is a pilot signed in to be already added. With none,
         the empty state above is the honest answer and this would contradict
         it. -->
    {#if addable.length === 0 && pilots.length > 0}
      <span class="note">Every pilot signed in here is already in this op.</span>
    {/if}
  </div>

  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if serverError}
    <p class="error">{serverError}</p>
  {/if}
</section>

<section class="limits-section">
  <h2>Limits for every pilot in this op</h2>
  <!-- ⚠ SET HERE, NOT ON EACH PILOT. Adding a pilot starts it, so there is no
       moment at which a per-pilot form would be filled in. A change here
       applies to the next companion that starts; one already flying keeps the
       numbers it was started with.

       ⚠ ONE COLUMN OF BOXES, NOT SIX. Each limit used to be its own flex row of
       label, box and unit, so six labels of six different lengths — "Flee
       below" against "Hold drones in the bay for at least" — put six boxes at
       six different places across the panel, with the unit trailing each at a
       seventh. There was no column for the eye to run down, and the numbers a
       player actually came to change were the hardest thing on the block to
       find. The grid gives the boxes one column and lets the labels END against
       it, which is also the only arrangement in which these read the way they
       are written: "Flee below | 30 | % of shield, armour or hull remaining" is
       one sentence with a control in the middle of it, not a label and a field.

       ⚠ AND THEY ARE IN TWO GROUPS, because they answer two questions. Four of
       them are about the ship getting hurt and two are about drones, and a flat
       list of six made the player read all six to find the one they wanted.

       ⚠ THE GROUPS ARE THE COLUMNS. Stacked, the block ran to nine lines of a
       window whose real subject — the roster and the pilot's readout — sits
       above and below it, so a form nobody touches between ops pushed the two
       things they watch during one apart. Side by side it is four lines, and
       the split costs nothing to explain because the reader already has it:
       there are two questions here, so there are two columns. They fold back
       into one when the window is too narrow to hold both without squeezing the
       units — `auto-fit` off a real minimum, so it is the CONTENT that decides,
       not a width somebody guessed.

       ⚠ AND THE UNITS WERE TRIMMED TO FIT, ONCE. A half-width column has about
       twelve characters' less room for the trailing phrase, and a unit that
       wraps to three lines gives back exactly what the second column won. What
       went is "remaining" (a floor is remaining health by definition) and
       "them" — and the drone shield fact, which was never a unit at all: it is
       a thing that happens when a drone comes home, so it is one note under the
       row rather than a tail on the label of it. -->
  <div class="limits">
    <div class="limit-group">
      <h3>If the ship gets hurt</h3>

      <label for="companion-flee-floor">Flee below</label>
      <input
        id="companion-flee-floor"
        type="number"
        min={Math.round(MIN_FLEE_HEALTH_FLOOR * 100)}
        max={Math.round(MAX_FLEE_HEALTH_FLOOR * 100)}
        step="5"
        bind:value={fleeHealthFloorPercent}
        onchange={keepSetup}
      />
      <span class="note">% of shield, armour or hull</span>

      <label for="companion-abandon-drones-floor">Leave the drones below</label>
      <input
        id="companion-abandon-drones-floor"
        type="number"
        min={Math.round(MIN_ABANDON_DRONES_HEALTH_FLOOR * 100)}
        max={fleeHealthFloorPercent}
        step="5"
        bind:value={abandonDronesFloorPercent}
        onchange={keepSetup}
      />
      <span class="note">% and warp at once</span>

      <label for="companion-cap-floor">Do not run repairers below</label>
      <input
        id="companion-cap-floor"
        type="number"
        min={Math.round(MIN_CAPACITOR_FLOOR * 100)}
        max={Math.round(MAX_CAPACITOR_FLOOR * 100)}
        step="5"
        bind:value={capacitorFloorPercent}
        onchange={keepSetup}
      />
      <span class="note">% capacitor</span>

      <label for="companion-flee-attempts">Stay home after</label>
      <input
        id="companion-flee-attempts"
        type="number"
        min={MIN_FLEE_ATTEMPTS}
        max={MAX_FLEE_ATTEMPTS}
        step="1"
        bind:value={maxFleeAttempts}
        onchange={keepSetup}
      />
      <span class="note">flee round trips</span>

      <!-- The label carries the whole fact: armour is the only damage a station
           charges for, because docking gives shield and capacitor back by
           itself. It sits in the BOX column rather than the label one, so the
           tick lines up under the numbers and reads as the fourth answer in
           this group. -->
      <label class="check">
        <input type="checkbox" bind:checked={repairsAtStation} onchange={keepSetup} />
        Pay a station to repair armour
      </label>
    </div>
  </div>
</section>

{#if selectedSession}
  <!--
    THE REAL PANEL, BOUND TO THAT PILOT.

    ⚠ IT NAMES THE PILOT IN ITS OWN STRIP, AND THERE IS NO SECOND HEADING.
    This used to be preceded by a framed panel whose entire body was its own
    header: a border, an accent hairline and a divider drawn around a pilot's
    name and one button, sitting directly on top of the panel that actually
    reports on that pilot. Two frames, two headings and two rules for one
    subject — and the emptier of the two came first, so the heaviest chrome in
    the window was around the least in it. A panel's strip is where it names
    itself and where its controls live, so the pilot's name and Go to pilot go
    IN it, beside Pause and Stop.

    ⚠ `{#key}` IS LOAD-BEARING. `FleetCompanion.svelte` reads its store's slices
    once at init — it has to, because `$companion` needs a stable top-level
    binding — so handing a live instance a different `store` changes nothing: it
    would go on rendering the pilot it was created for, under another pilot's
    name. CharacterBar.svelte keys its one chip for exactly this reason.
  -->
  {#key selectedSession.id}
    <FleetCompanion
      store={selectedSession.store}
      flow={selectedSession.flow}
      setup={roster.setup}
      title={live[selectedSession.id]?.name ?? "This pilot"}
      onGoToPilot={onGoToPilot ? goToSelectedPilot : undefined}
    />
  {/key}
  <!-- THE FLIGHT LOG for the pilot above: read-only, closed until asked for,
       and read again only by Refresh. The line wording is companionLogView.ts. -->
  {@const logSession = selectedSession}
  {@const log = logOf(logSession.id)}
  {@const logView = buildLogView(log.entries ?? [], logFilter)}
  <section class="panel log-panel">
    <header class="panel-head">
      <h2>Log</h2>
      <span class="controls">
        <button
          type="button"
          class="minor"
          aria-pressed={log.open}
          onclick={() => toggleLog(logSession)}
        >
          {log.open ? "Hide log" : "Show log"}
        </button>
      </span>
    </header>
    {#if log.open}
      <div class="log-bar">
        <button
          type="button"
          class="minor"
          aria-pressed={log.which === "current"}
          onclick={() => pickLogRun(logSession, "current")}
        >
          This run
        </button>
        <button
          type="button"
          class="minor"
          aria-pressed={log.which === "previous"}
          onclick={() => pickLogRun(logSession, "previous")}
        >
          Previous run
        </button>
        <button type="button" disabled={log.loading} onclick={() => loadLog(logSession)}>
          {log.loading ? "Loading" : "Refresh"}
        </button>
        <input
          type="text"
          class="log-filter"
          aria-label="Filter the log"
          placeholder="filter the log"
          bind:value={logFilter}
        />
      </div>
      {#if log.error}
        <p class="note log-error">{log.error}</p>
      {/if}
      {#if log.entries === null}
        {#if !log.error}
          <p class="note">Loading the log.</p>
        {/if}
      {:else if log.entries.length === 0}
        <p class="note">Nothing logged for the {log.which} run.</p>
      {:else}
        <p class="note">
          {logView.matched} of {logView.total} lines, newest first, times in UTC.
          {#if logView.hidden > 0}{logView.hidden} older lines are not drawn; filter to find them.{/if}
        </p>
        <div class="log-rows">
          {#each logView.rows as row (row.index)}
            <div
              class="log-row"
              class:log-grouped={row.inGroup}
              class:log-start={row.groupStart}
              class:log-heartbeat={row.heartbeat}
            >
              <span class="log-time">{row.time}</span>
              <span class="log-kind">{row.kind}</span>
              <span class="log-phase">{row.phase}</span>
              <span
                class="log-text"
                class:log-good={row.tone === "good"}
                class:log-warn={row.tone === "warn"}
                class:log-bad={row.tone === "bad"}
              >
                {row.text}{row.heartbeat ? " (heartbeat)" : ""}
              </span>
              {#if row.summary !== null && row.trace !== null}
                {@const traceOpen = log.expanded.includes(row.index)}
                <button
                  type="button"
                  class="log-trace"
                  aria-expanded={traceOpen}
                  onclick={() => toggleTrace(logSession.id, row.index)}
                >
                  {row.summary === "" ? "(empty trace)" : row.summary}
                </button>
                {#if traceOpen}
                  <pre class="log-json">{JSON.stringify(row.trace, null, 2)}</pre>
                {/if}
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </section>
{:else if selectedServerBot}
  <!-- The server row keeps its panel: unlike the bar above, this one has a body
       — what the run is doing, why, and what is wrong with the fit. -->
  <section class="panel">
    <header class="panel-head">
      <h2>{selectedServerBot.characterName ?? "Unnamed pilot"}</h2>
      <span class="controls">
        <button
          type="button"
          class="danger"
          disabled={busy}
          onclick={() =>
            run(async () => {
              await stopServerBot(selectedServerBot.botID, await reach.ownerOptions(selectedServerBot.characterID));
              await refreshServer();
            })}
        >
          Stop
        </button>
      </span>
    </header>
    <!--
      ⚠ NO SETUP FORM, AND THAT IS NOT AN OVERSIGHT. This run is on the server,
      which took its limits when it was started from the Pilot hangar. Offering
      the fields here would let a player change numbers that reach nothing.
    -->
    <p class="note">
      This companion is flying on the server, so it keeps going when this tab is
      closed. Its limits were set when it was started, and the only thing this
      window can do to it from here is stop it.
    </p>
    <p class="stat-line">
      <strong>{selectedServerBot.phase ?? "Working"}</strong>
    </p>
    {#if selectedServerBot.why}
      <p class="note"><strong>Why:</strong> {selectedServerBot.why}</p>
    {/if}
    {#if selectedServerBot.companion && selectedServerBot.companion.fitWarnings.length > 0}
      <p class="note"><strong>Worth knowing about this fit:</strong></p>
      <ul>
        {#each selectedServerBot.companion.fitWarnings as warning (warning)}
          <li class="note">{warning}</li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  /* ---------------------------------------------------------------- the op --
     The panel is a container, so the two layouts below can ask how wide IT is
     rather than how wide the browser window is — this window floats and is
     resized, which is the reason `.table-wrap` inside it is already one. Safe
     to contain for the same reason it is: a panel's inline size comes from its
     parent and never from its contents. */
  .op-panel {
    container-type: inline-size;
  }

  /* Label, field, and the explanation under the field rather than beside it.
     The input is given a real width and a ceiling: a fleet name is a handful of
     words, and a text box stretched across a 1400px window is as hard to read
     back as one clipped to a third of a row. */
  .op-fleet {
    display: grid;
    grid-template-columns: max-content minmax(10rem, 24rem);
    align-items: center;
    gap: 0.3rem 0.6rem;
    margin: 0 0 0.7rem;
  }
  .op-fleet > .note {
    grid-column: 2;
  }
  /* Below the fleet field's own width there is nothing to align to, so it
     stacks rather than crushing the input into the label. */
  @container (max-width: 26rem) {
    .op-fleet {
      grid-template-columns: 1fr;
    }
    .op-fleet > .note {
      grid-column: 1;
    }
  }

  /* The footer under the roster. A row, wrapping, with the note taking the
     whole of the next line when it appears. */
  .op-add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.7rem;
    padding-top: 0.6rem;
    border-top: 1px solid var(--color-line);
  }
  .op-add > .note {
    flex-basis: 100%;
  }

  /* The target mode beside the count: a bordered word, not a colour alone. */
  .mode-chip {
    border: 1px solid var(--color-accent-dim);
    color: var(--color-accent);
    padding: 0 0.4rem;
    font-size: 0.85em;
    white-space: nowrap;
  }

  /* The command reference: verb column and meaning column, stacking when the
     window is too narrow for both. */
  .chat-help {
    margin-top: 0.7rem;
    border: 1px solid var(--color-line);
    padding: 0.35rem 0.6rem;
  }
  .chat-help > summary {
    cursor: pointer;
    color: var(--color-text-bright);
  }
  .chat-help dl {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.15rem 1rem;
    margin: 0.5rem 0 0.2rem;
  }
  .chat-help dt {
    font-family: var(--font-mono, monospace);
    color: var(--color-accent);
  }
  .chat-help dd {
    margin: 0;
  }
  @container (max-width: 26rem) {
    .chat-help dl {
      grid-template-columns: 1fr;
    }
    .chat-help dd {
      margin-bottom: 0.3rem;
    }
  }

  /* ------------------------------------------------------------- the roster --
     The chosen row, marked by an edge and a wash rather than colour alone — the
     detail below carries the pilot's name in its own heading, which is the real
     confirmation of what is open. */
  tr.selected > td {
    border-top: 1px solid var(--color-accent-dim);
    border-bottom: 1px solid var(--color-accent-dim);
    background: rgb(127 180 217 / 0.07);
  }
  tr.selected > td:first-child {
    box-shadow: inset 2px 0 0 0 var(--color-accent);
  }
  .link-button {
    display: inline;
    padding: 0;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  /* Remove is not the pilot's name. Same cell, quieter ink, and it only
     underlines when you are on it. */
  .link-button.remove {
    color: var(--color-muted);
    font-size: 12px;
    text-decoration: none;
  }
  .link-button.remove:hover:not(:disabled),
  .link-button.remove:focus-visible {
    color: var(--color-danger);
    text-decoration: underline;
  }
  /* The pilot cell: who and where on one line, and the row's one destructive
     control held at the far end of it. */
  .pilot-cell {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem 1rem;
  }
  .pilot-who {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 0.5rem;
    min-width: 0;
  }
  .pilot-who > .where {
    font-size: 12px;
  }
  /* ⚠ THE CARD REFLOW MAKES EVERY BUTTON IN A CELL FULL WIDTH (R8: a phone
     row is a touch target). These two are text in a sentence, not row actions,
     and stretching them would put the pilot's name and Remove on two 100%-wide
     lines — the stack this cell just stopped being. */
  .pilot-cell button {
    width: auto;
    min-height: 0;
  }
  /* Every OTHER note in a cell is still its own line: the joining refusal and
     the qualifiers in the Companion column are sentences under a value, not
     things beside it. */
  td > .note {
    display: block;
  }
  /* ⚠ THE WIDTH GOES WHERE THE WORDS ARE. Four of these five columns hold two
     or three words — "Running", "nothing yet", "align to" — and the fifth holds
     the joining SENTENCE, which is the column a player opens this window to
     read. Left to size itself, the table gave each column a share of the words
     it happened to contain and wrapped "nothing yet" onto two lines beside a
     sentence that had wrapped onto three. So the short ones are told not to
     wrap and the long one is given the floor it needs; the rest is the table's
     to distribute. Below the reflow width every cell is its own line and none
     of this applies. */
  @container (min-width: 641px) {
    th:nth-child(1),
    td:nth-child(1) {
      min-width: 13rem;
    }
    th:nth-child(2),
    td:nth-child(2),
    th:nth-child(4),
    td:nth-child(4),
    th:nth-child(5),
    td:nth-child(5) {
      white-space: nowrap;
    }
    /* ...but the Companion column's QUALIFIERS are sentences, and they are the
       one thing in these columns that has to be allowed to wrap. Holding the
       status word on one line and letting the sentence under it fold is two
       rules, because it is two kinds of text in one cell. */
    td:nth-child(2) > .note {
      white-space: normal;
    }
    td:nth-child(3) {
      min-width: 20rem;
    }
  }

  /* ------------------------------------------------------------- the limits --
     A container, so the grid below can ask how wide THIS PANEL is rather than
     how wide the browser window is — the same question `.table-wrap` asks, for
     the same reason: this window floats and is resized.

     ⚠ AND IT DRAWS ITS OWN SEPARATION, because inside a window it has none. A
     window flattens the panels directly under it — no frame, no margin, no
     padding (`.win-body > section`) — so the limits block, which is a sibling
     of the op panel rather than part of it, ran straight on from the Add row
     above with nothing between them but a heading. A heading over a hairline is
     how the other twenty-three windows separate a block; this is that. */
  .limits-section {
    container-type: inline-size;
    margin: 1rem 0 0.9rem;
    padding-top: 0.85rem;
    border-top: 1px solid var(--color-line);
  }
  /* ⚠ TWO GROUPS SIDE BY SIDE, AND THE TRACK MINIMUM IS WHAT DECIDES. A column
     has to hold a label, a box and a unit on one line — 28rem, which is not a
     guess: it is what the browser answers for these two blocks at `width:
     max-content`, rounded up. A track a rem under it looks like it fits and
     then folds every unit in both columns onto a second line — and a
     pair of columns that cannot is worse than one that can, because every unit
     in both of them wraps and the block comes out taller than it started.
     `auto-fit` with that minimum lays out two tracks when the panel can afford
     them and one when it cannot, so the question is asked of the real width
     every time rather than answered once with a guess.

     `min(28rem, 100%)` rather than a bare `28rem`: below the minimum a track
     would otherwise stay 28rem wide and push the panel sideways, which is the
     one thing R8 does not allow.

     ⚠ AND THE PAIR IS CAPPED, because `1fr` tracks divide ALL of a wide
     window between them. On a maximised one that put about 160px of nothing
     between the last unit of the left group and the heading of the right, and
     two blocks that far apart stop reading as a pair and start reading as two
     unrelated forms that happen to be level. The cap is a little over two
     tracks' worth, so the columns sit beside each other and the slack goes
     where slack belongs — the margin. */
  .limits {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(28rem, 100%), 1fr));
    align-items: start;
    gap: 0.5rem 2.5rem;
    max-width: 60rem;
  }
  /* The uneven bottom edge is deliberate and not worth fixing: the ship has
     four answers and drones have two, and padding one group to match the other
     would draw a box around nothing. */
  .limit-group {
    display: grid;
    grid-template-columns: max-content max-content 1fr;
    align-items: center;
    column-gap: 0.6rem;
    row-gap: 0.3rem;
  }
  .limit-group > h3 {
    grid-column: 1 / -1;
    margin: 0.35rem 0 0.15rem;
  }
  /* The labels END against the boxes, so each line reads as the sentence it is
     and no gutter opens up after the short ones. */
  .limit-group > label {
    justify-self: end;
    text-align: right;
  }
  .limit-group > input[type="number"] {
    width: 5rem;
  }
  .limit-group > .note {
    margin: 0;
  }
  /* The tick sits under the boxes, not under the labels: it is an answer in
     this group, not a heading for one. The group's closing note keeps the same
     column for the same reason — it is about the rows above it, not about the
     group. */
  .limit-group > .check,
  .limit-group > .group-note {
    grid-column: 2 / -1;
    justify-self: start;
  }
  .limit-group > .check {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    text-align: left;
    margin: 0.2rem 0;
  }
  .limit-group > .check > input {
    margin: 0;
  }
  .limit-group > .group-note {
    margin-top: 0.2rem;
  }
  /* Narrow: the label takes its own line above the box it names, and the box
     keeps its unit beside it. Right-aligned labels over a one-box column would
     be a right-aligned column of sentences, which is worse than either. */
  @container (max-width: 30rem) {
    .limit-group {
      grid-template-columns: max-content 1fr;
    }
    .limit-group > label {
      grid-column: 1 / -1;
      justify-self: start;
      text-align: left;
      margin-top: 0.45rem;
    }
    .limit-group > .check,
    .limit-group > .group-note {
      grid-column: 1 / -1;
    }
    .limit-group > .check {
      margin-top: 0.5rem;
    }
  }

  /* ------------------------------------------------------- the flight log --
     Compact rows in the window's own width: time, kind and phase are narrow
     columns, the sentence takes the rest and wraps. The kind is a word, not a
     colour; only a result's outcome is toned, and it says ok or the refusal in
     words as well. */
  .log-panel {
    container-type: inline-size;
  }
  .log-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin: 0.4rem 0;
  }
  .log-bar > button[aria-pressed="true"] {
    border-color: var(--color-accent-dim);
    color: var(--color-accent);
  }
  .log-filter {
    flex: 1 1 12rem;
    min-width: 8rem;
  }
  .log-error {
    color: var(--color-danger);
  }
  .log-rows {
    max-height: 32rem;
    overflow: auto;
    border: 1px solid var(--color-line);
    font-family: var(--font-mono, monospace);
    font-size: 0.85em;
  }
  .log-row {
    display: grid;
    grid-template-columns: 4.5rem 3.8rem 6rem minmax(0, 1fr);
    gap: 0 0.5rem;
    padding: 0.1rem 0.4rem;
    border-bottom: 1px solid var(--color-row-line);
  }
  /* A tick's decide, issue and result: one block with a rule down its left. */
  .log-row.log-grouped {
    border-left: 2px solid var(--color-accent-dim);
  }
  .log-row.log-start:not(:first-child) {
    border-top: 1px solid var(--color-line-strong);
  }
  .log-row.log-heartbeat {
    opacity: 0.5;
  }
  .log-time,
  .log-kind {
    color: var(--color-muted);
  }
  .log-phase {
    color: var(--color-cell);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .log-text {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--color-text);
  }
  .log-text.log-good {
    color: var(--color-good);
  }
  .log-text.log-warn {
    color: var(--color-warn);
  }
  .log-text.log-bad {
    color: var(--color-danger);
  }
  .log-trace,
  .log-json {
    grid-column: 4;
  }
  /* The trace summary is a button so it can be reached by keyboard, but it is
     drawn as text: the global button chrome would make each row a slab. */
  .log-trace {
    min-height: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--color-accent);
    text-align: left;
    font: inherit;
    letter-spacing: 0;
    overflow-wrap: anywhere;
  }
  .log-trace:hover:not(:disabled) {
    background: none;
    color: var(--color-accent-bright);
  }
  .log-json {
    margin: 0.2rem 0;
    padding: 0.3rem 0.4rem;
    overflow: auto;
    max-height: 18rem;
    border: 1px solid var(--color-line);
    background: var(--color-field);
    color: var(--color-cell);
  }
  /* Narrow window: the sentence goes under the columns instead of crushing. */
  @container (max-width: 34rem) {
    .log-row {
      grid-template-columns: 4.5rem 3.8rem minmax(0, 1fr);
    }
    .log-phase {
      display: none;
    }
    .log-text,
    .log-trace,
    .log-json {
      grid-column: 1 / -1;
    }
  }

</style>
