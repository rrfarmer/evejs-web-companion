<script lang="ts">
  // PLANETARY INDUSTRY (R108 slices 3 to 5) — every assigned pilot's colonies
  // on one board, one action (restarting a pilot's ended extractors), what is
  // held across colonies, hangars and corp hangars, and the planner.
  //
  // ⚠ A GLOBAL WINDOW WITH NO STORE. Every other panel is a view of the mounted
  // pilot. This one is a view of the player's own PI roster, which spans
  // accounts, and it reads through its own throwaway sign-ins
  // (app/piRosterRead.ts) — so it takes no `store` and no `flow`, and a pilot
  // switch does not tear it down (globalWindow.ts).
  //
  // ⚠ NOTHING HERE SELECTS A CHARACTER. Reading a colony needs only ownership,
  // proved live; a select claims a hull, and a bot flying that pilot in another
  // tab would lose its ship without a word. Acting on a colony goes through the
  // SERVER bot host (app/piDispatch.ts), the one thing that arbitrates hulls
  // honestly: it refuses a pilot already flown, in its own words.
  //
  // ⚠ IT READS WHEN OPENED AND WHEN ASKED, AND NEVER ON A TIMER. The 30-second
  // tick below moves the ages on and touches no network. When to read on its
  // own is the scheduler's job, a later slice.
  //
  // ⚠ ONE EXCEPTION: WHILE A SERVER BOT FLIES A ROSTER PILOT. Then the public
  // bot roster (/api/bots/active, the BFF's own memory, no game call) is polled
  // every RUN_POLL_MS so a haul or restart started here shows how far it has
  // got, and a pilot whose run ends has its colonies read again: a run is the
  // one thing that changes a colony while the window looks at it. With no bot
  // flying anybody the poll makes no request at all.
  //
  // ⚠ EVERY ROW SAYS HOW OLD IT IS. Pilots are read at different moments; the
  // board never presents them as one (bridge/piBoard.ts).
  import { onMount, tick } from "svelte";
  import { loadKnownCharacters, type KnownCharacter } from "../app/knownCharacters.ts";
  import { loadHangarPrefs } from "../app/hangarPrefs.ts";
  import {
    addPiMember,
    addPiMembers,
    loadPiRoster,
    piReadings,
    recordPiAnswer,
    removePiMember,
    savePiRoster,
    type PiRosterPrefs,
  } from "../app/piRosterPrefs.ts";
  import { readPiRoster } from "../app/piRosterRead.ts";
  import {
    buildPiBoard,
    piHaulDispatchWords,
    piHaulWords,
    pilotRowFacts,
    pilotsByAccount,
    type PiAccountGroup,
    type PiColonyRow,
    type PiDispatchState,
    type PilotAttempt,
  } from "../bridge/piBoard.ts";
  import { haulFor, restartExtractorsFor, type PiHaulDivision } from "../app/piDispatch.ts";
  import {
    divisionLabel,
    learnDivisionNames,
    loadPiHaulPrefs,
    savePiHaulPrefs,
    withEntry,
    withPiHaulDelivery,
    type PiHaulPrefs,
  } from "../app/piHaulPrefs.ts";
  import CorpHangarPicker from "./CorpHangarPicker.svelte";
  import StationPicker from "./StationPicker.svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { findMapLocations } from "../app/api.ts";
  import { readBotDivisionNames, type PiDivisionNamesRead } from "../app/piHaulNames.ts";
  import { startingStation, type WorldRef } from "../bots/botScript.ts";
  import { listActiveServerBots, type ActiveServerBot } from "../app/api.ts";
  import { readPiRunOutcome } from "../app/piRunOutcome.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { stopServerBotFor } from "../app/stopBotFor.ts";
  import PiHelp from "./PiHelp.svelte";
  import {
    colonyRunMark,
    piRunView,
    startWatch,
    watchEnded,
    watchPoll,
    type PiColonyRunMark,
    type PiRunEnd,
    type PiRunView,
    type PiRunWatch,
  } from "../bridge/piRunProgress.ts";
  import { commodityName, decodeRecipeBook, madeThings, tierOf, type PiRecipeBook, type PiTier } from "../bridge/piRecipes.ts";
  import {
    countWords,
    holdingAgeWords,
    holdingsFromCorpReads,
    holdingsFromReadings,
    isPlayerCorporation,
    stockByTier,
    stockLines,
    stockSources,
    stockSummary,
    tierLabel,
    tierTag,
    type CorpStockRead,
  } from "../bridge/piStock.ts";
  import { balancedDemand, buildCoverage, type CoverageLine } from "../bridge/piCoverage.ts";
  import {
    commandCentresToBuy,
    decodePlanetsNear,
    expansionGroups,
    expansionPilots,
    homeSystems,
    layoutToCopy,
    proposeExpansion,
    rowState,
    type ExpansionGroupView,
    type ExpansionProposal,
    type PlanetNear,
  } from "../bridge/piExpansion.ts";
  import {
    createPiExpansion,
    deletePiExpansion,
    loadPiExpansions,
    updatePiExpansion,
    type SavedPiExpansion,
  } from "../app/piExpansions.ts";
  import {
    loadRichness,
    mergeRichness,
    readRichness,
    richnessFromReadings,
    saveRichness,
    type RichnessMap,
  } from "../app/piRichness.ts";
  import { getPlanetsNear } from "../app/api.ts";
  import { DEFAULT_PI_PLAN_DEPS, signedIn } from "../app/piPlans.ts";
  import { missingByTier, planStepCounts, planWithStock, type PlanNode, type PlannerColony } from "../bridge/piPlanner.ts";
  import { readCorpStock, type BotPilot, type OnlinePilot } from "../app/piCorpRead.ts";
  import {
    createPiPlan,
    deletePiPlan,
    loadPiPlans,
    updatePiPlan,
    withPlan,
    withoutPlan,
    type SavedPiPlan,
  } from "../app/piPlans.ts";
  import {
    loadPiPlanView,
    prunePiPlanView,
    savePiPlanView,
    withOpenNodes,
    withOpenPlan,
    type PiPlanView,
  } from "../app/piPlanView.ts";
  import type { Session } from "../app/sessions.ts";
  import TypeIcon from "./TypeIcon.svelte";

  // ⚠ THE SESSIONS ARE FOR CORP HANGARS ONLY. Corp-owned goods are in no
  // pilot's snapshot, so they are read through a pilot of that corporation who
  // is already online: in this tab, on that pilot's own session, or flown by a
  // server bot, on the bot's session through a read-only route
  // (app/piCorpRead.ts). Nothing here selects or brings anyone online.
  let { sessions = [] }: { sessions?: readonly Session[] } = $props();

  let roster = $state<PiRosterPrefs>(loadPiRoster());
  let known = $state<KnownCharacter[]>(loadKnownCharacters());
  // A snapshot at open: squads change in the hangar, and "add everyone in this
  // squad" copies whoever is in it at the moment of the click.
  const hangar = loadHangarPrefs();
  let attempts = $state<Map<number, PilotAttempt>>(new Map());
  let reading = $state(false);
  let browserNowMs = $state(Date.now());
  let choice = $state("");
  // Static, so read once per open window. Without it a starved factory is
  // judged by what its routes bring rather than by its recipe.
  let recipes = $state<PiRecipeBook | null>(null);
  // Who a server bot is flying (a public read), and what this window's own
  // starts did. Read when the window opens, on Refresh and after a start —
  // never on a timer.
  let activeBots = $state<Set<number>>(new Set());
  let dispatch = $state<Map<number, PiDispatchState>>(new Map());
  // The public roster's rows by pilot, and the runs this window started and is
  // following (bridge/piRunProgress.ts). A watch stays after its run ends, so
  // the outcome stays said, until the next start or Refresh.
  let liveBots = $state<Map<number, ActiveServerBot>>(new Map());
  let runWatch = $state<Map<number, PiRunWatch>>(new Map());
  // Pilots whose run ended while a read was in flight; read when it is done.
  let rereadPending = new Set<number>();
  /** How often the bot roster is polled while a bot flies a roster pilot (BotManager's cadence). */
  const RUN_POLL_MS = 3000;

  // THE COLONIES VIEW'S LAYOUT. Normal shows planet icons and two bars per
  // colony; Compact one line per colony. Remembered in this browser only.
  type Density = "normal" | "compact";
  const DENSITY_KEY = "evejs.piManager.density";
  function loadDensity(): Density {
    try {
      return globalThis.localStorage?.getItem(DENSITY_KEY) === "compact" ? "compact" : "normal";
    } catch {
      return "normal";
    }
  }
  let density = $state<Density>(loadDensity());
  // Lines the player opened or closed; every other line opens when it needs
  // the player (pilotOpen). Per window, not remembered.
  let openOverride = $state<Map<number, boolean>>(new Map());
  let haulSettingsOpen = $state<Set<number>>(new Set());
  let helpOpen = $state(false);
  let stopping = $state<Set<number>>(new Set());
  let stopWords = $state<Map<number, string>>(new Map());
  const MARK_WORDS: Record<PiColonyRunMark, string> = {
    queued: "Queued",
    collecting: "Collecting",
    collected: "Collected",
    missed: "Not collected",
  };
  /** How full a colony must be for "Tick colonies 70%+ full" to tick it. */
  const TICK_FULL_FRACTION = 0.7;
  // HAUL (the Colonies view's per-pilot Haul button). Which colonies are
  // ticked lives only in this open window; where the goods go is remembered
  // per pilot in this browser, because it is the same answer every haul.
  let haulTicked = $state<Map<number, Set<number>>>(new Map());
  let haulPrefs = $state<PiHaulPrefs>(loadPiHaulPrefs());
  let haulDispatch = $state<Map<number, PiDispatchState>>(new Map());

  // One view at a time, picked from the window's own menu. An empty roster
  // opens on Pilots, because adding one is the only thing to do there.
  // ⚠ Every view is RENDERED and the others are `hidden`, not left out: a
  // restart already started keeps saying so while the player looks elsewhere.
  type View = "colonies" | "stock" | "coverage" | "planner" | "pilots";
  let view = $state<View>(loadPiRoster().members.length === 0 ? "pilots" : "colonies");

  // What each corporation's hangars said at the last Refresh (R108 slice 5).
  let corpReads = $state<CorpStockRead[]>([]);
  // The Stock view's own controls. Opening a row shows where every unit is.
  let stockTier = $state<PiTier | "all">("all");
  let stockSearch = $state("");
  let stockOpen = $state<Set<number>>(new Set());
  // The Coverage view's own controls, the Stock view's in kind.
  let coverageTier = $state<PiTier | "all">("all");
  let coverageOpen = $state<Set<number>>(new Set());
  // The planner's form, and the request its Plan button last made. The plan is
  // derived from the request and the stock as it stands, so a Refresh re-plans.
  let planTarget = $state("");
  let planQuantity = $state("");
  let planError = $state<string | null>(null);
  let planRequest = $state<{ typeID: number; quantity: number } | null>(null);
  // Which tree nodes the player opened; the tree starts folded, because the
  // missing summary above it is what to read first. And which nodes show where
  // their stock is.
  let treeOverride = $state<Map<string, boolean>>(new Map());
  let placesOpen = $state<Set<string>>(new Set());
  // SAVED PLANS (app/piPlans.ts). The rows live on the server; which one was
  // open and how its tree was unfolded live in this browser (app/piPlanView.ts).
  // Every Plan press saves, so there is no Save button to forget.
  let plans = $state<SavedPiPlan[]>([]);
  let plansLoaded = $state(false);
  let plansError = $state<string | null>(null);
  let planSaving = $state(false);
  let planNote = $state("");
  let planView = $state<PiPlanView>(loadPiPlanView());
  // EXPANSION PLANS (app/piExpansions.ts): where free colony slots should go.
  // The rows live on the server; the draft, the map read for it and which
  // plan is open live in this window.
  let expansions = $state<SavedPiExpansion[]>([]);
  let expansionsLoaded = $state(false);
  let openExpansionID = $state<string | null>(null);
  let composeKind = $state<"commodity" | "expansion">("commodity");
  let expHome = $state("");
  let expJumps = $state("2");
  let expTolerance = $state("20");
  let expBusy = $state(false);
  let expWords = $state<string | null>(null);
  let expError = $state<string | null>(null);
  let expPlanets = $state<Map<number, PlanetNear>>(new Map());
  let draft = $state<ExpansionProposal | null>(null);
  let draftSettings = $state<{ homeSystemID: number; maxJumps: number; nullsecTolerance: number } | null>(null);
  let richness = $state<RichnessMap>(loadRichness());

  /** `covered`: pilots a read is about to take anyway, so an ended run there is not read twice. */
  async function loadActiveBots(covered: readonly number[] = []): Promise<void> {
    let rows: ActiveServerBot[];
    try {
      rows = await listActiveServerBots();
    } catch {
      // Keep what we had: the server still refuses a start for a flown pilot,
      // in its own words, so a stale list here cannot cause a takeover.
      return;
    }
    const before = activeBots;
    liveBots = new Map(rows.map((bot) => [bot.characterID, bot]));
    activeBots = new Set(liveBots.keys());
    // A roster pilot whose run ended: its colonies may have changed under it.
    const ended = [...before].filter((id) => !activeBots.has(id) && roster.members.includes(id) && !covered.includes(id));
    followRuns();
    if (ended.length > 0) void reread(ended);
  }

  function setWatch(characterID: number, watch: PiRunWatch | null): void {
    const next = new Map(runWatch);
    if (watch === null) next.delete(characterID);
    else next.set(characterID, watch);
    runWatch = next;
  }

  /** Move every watched run on by the roster just read; ask how ended ones went. */
  function followRuns(): void {
    for (const [characterID, watch] of runWatch) {
      const next = watchPoll(watch, liveBots.get(characterID) ?? null);
      if (next === watch) continue;
      setWatch(characterID, next);
      if (next.ending) void lookUpEnding(characterID);
    }
  }

  async function lookUpEnding(characterID: number): Promise<void> {
    const accountName = known.find((pilot) => pilot.characterID === characterID)?.accountName;
    let end: PiRunEnd | null = null;
    if (accountName) {
      try {
        end = await readPiRunOutcome(accountName, characterID);
      } catch {
        // Unread: the board says the run ended and points at the Bot Manager.
      }
    }
    const watch = runWatch.get(characterID);
    if (watch?.ending) setWatch(characterID, watchEnded(watch, end));
  }

  /** What the board draws for this pilot's watched run, or null when none is watched. */
  function runViewFor(characterID: number): PiRunView | null {
    const watch = runWatch.get(characterID);
    return watch ? piRunView(watch, liveBots.get(characterID) ?? null) : null;
  }

  function pickDensity(next: Density): void {
    density = next;
    try {
      globalThis.localStorage?.setItem(DENSITY_KEY, next);
    } catch {
      // Private window or blocked storage: the choice lasts this window.
    }
  }

  /** Open when the player said so; otherwise when it needs the player or a run is worth seeing. */
  function pilotOpen(characterID: number, needYouNow: number, run: PiRunView | null): boolean {
    const chosen = openOverride.get(characterID);
    if (chosen !== undefined) return chosen;
    return needYouNow > 0 || (run !== null && (!run.over || run.tone === "stopped"));
  }

  function setOpen(characterID: number, open: boolean): void {
    const next = new Map(openOverride);
    next.set(characterID, open);
    openOverride = next;
  }

  function showPilot(characterID: number): void {
    setOpen(characterID, true);
    void tick().then(() => document.getElementById(`pi-pilot-${characterID}`)?.scrollIntoView({ block: "nearest" }));
  }

  function toggleHaulSettings(characterID: number): void {
    const next = new Set(haulSettingsOpen);
    if (next.has(characterID)) next.delete(characterID);
    else next.add(characterID);
    haulSettingsOpen = next;
  }

  /** Tick every colony of this pilot's whose storage is at least 70% full; leaves other ticks alone. */
  function tickFull(characterID: number, rows: readonly PiColonyRow[]): void {
    const next = new Map(haulTicked);
    const ticked = new Set(next.get(characterID) ?? []);
    for (const row of rows) {
      if (row.storage !== null && row.storage.fraction >= TICK_FULL_FRACTION) ticked.add(row.planetID);
    }
    next.set(characterID, ticked);
    haulTicked = next;
  }

  /** The left edge of a pilot's line: red when something needs the player, amber for a paused run. */
  function pilotEdge(needYouNow: number, run: PiRunView | null): "bad" | "warn" | "none" {
    if (run?.tone === "stopped" || needYouNow > 0) return "bad";
    if (run?.tone === "paused") return "warn";
    return "none";
  }

  /** The short word on a closed line for a watched run. */
  function runFlag(run: PiRunView, kind: "haul" | "restart" | null): string {
    if (run.tone === "paused") return "Paused";
    if (run.tone === "stopped") return "Stopped";
    if (run.tone === "done") return kind === "haul" ? "Hauled" : "Restarted";
    if (run.tone === "ended") return "Ended";
    if (kind !== "haul") return "Restarting";
    const at = run.stages.findIndex((stage) => stage.state === "current");
    return `Hauling ${Math.max(0, at) + 1}/${run.stages.length}`;
  }

  function elapsedWords(startedAtMs: number): string {
    const minutes = Math.max(0, Math.round((browserNowMs - startedAtMs) / 60_000));
    return minutes === 0 ? "" : ` - ${minutes} min`;
  }

  /** Stop a paused run, as its owner; the roster poll then sees it end and says how. */
  async function stopRun(characterID: number): Promise<void> {
    const accountName = known.find((pilot) => pilot.characterID === characterID)?.accountName;
    const words = new Map(stopWords);
    words.delete(characterID);
    if (!accountName) {
      words.set(characterID, "This pilot is no longer in the hangar, so there is no account to stop it with.");
      stopWords = words;
      return;
    }
    stopWords = words;
    stopping = new Set(stopping).add(characterID);
    try {
      await stopServerBotFor(accountName, characterID);
      await loadActiveBots();
    } catch {
      const failed = new Map(stopWords);
      failed.set(characterID, "The run could not be stopped just now.");
      stopWords = failed;
    } finally {
      const next = new Set(stopping);
      next.delete(characterID);
      stopping = next;
    }
  }

  /** Read these pilots' colonies again, and the corp stock; queued behind a read in flight. */
  async function reread(characterIDs: readonly number[]): Promise<void> {
    for (const id of characterIDs) rereadPending.add(id);
    if (reading) return;
    const asked = roster.members.filter((id) => rereadPending.has(id));
    rereadPending = new Set();
    await readPilots(asked);
  }

  /**
   * Restart a pilot's ended extractors, as a SERVER run. Never a select from
   * here: the bot host decides whether the pilot is free, and says why not.
   */
  async function restartExtractors(characterID: number): Promise<void> {
    const accountName = known.find((pilot) => pilot.characterID === characterID)?.accountName;
    const set = (state: PiDispatchState) => {
      const next = new Map(dispatch);
      next.set(characterID, state);
      dispatch = next;
    };
    if (!accountName) {
      set({ kind: "refused", sentence: "This pilot is no longer in the hangar, so there is no account to start it with." });
      return;
    }
    set({ kind: "starting" });
    const outcome = await restartExtractorsFor(accountName, characterID);
    set(outcome);
    setWatch(characterID, outcome.kind === "started" ? startWatch("restart", Date.now()) : null);
    await loadActiveBots();
  }

  function keepHaul(next: PiHaulPrefs): void {
    haulPrefs = next;
    savePiHaulPrefs(next);
  }

  function pickHaulDivision(characterID: number, picked: PiHaulDivision): void {
    keepHaul({ ...haulPrefs, divisions: withEntry(haulPrefs.divisions, characterID, picked) });
  }

  /** Change keeps an empty ref while searching; starting station is the default. */
  function pickDeliverTo(characterID: number, ref: WorldRef): void {
    keepHaul(withPiHaulDelivery(haulPrefs, characterID, ref));
  }

  /** This pilot's corporation, from its last colony read. */
  function corporationOf(characterID: number): number | null {
    return piReadings(roster).get(characterID)?.corporationID ?? null;
  }

  /**
   * LEARN THE DIVISION NAMES while somebody of the corporation is in game: a
   * pilot online in this tab, or one a server bot is flying. Remembered per
   * corporation, so the picker says the names on a day nobody is online.
   */
  async function learnNames(): Promise<void> {
    const reads: PiDivisionNamesRead[] = [];
    for (const session of sessions) {
      const online = session.store.station.get().online;
      if (!online) continue;
      try {
        const offices = await session.flow.loadCorpOffices();
        reads.push({ characterID: online.characterID, corporationID: online.corporationID, divisions: offices.divisions });
      } catch {
        // Not this one; the names stay as they were.
      }
    }
    reads.push(...await readBotDivisionNames(botPilots()));
    // Choices can change while the reads are in flight. Merge names onto the
    // current choices, so a refresh never restores an earlier destination.
    let next = haulPrefs;
    for (const read of reads) {
      next = learnDivisionNames(next, read.corporationID ?? corporationOf(read.characterID) ?? 0, read.divisions);
    }
    if (next !== haulPrefs) keepHaul(next);
  }

  /** The station search for the Deliver to picker: the static map, no session needed. */
  const stationSearch: Pick<AppFlow, "searchDestinations"> = {
    async searchDestinations(query, kind) {
      const trimmed = query.trim();
      if (trimmed.length < 2) return [];
      const result = await findMapLocations(trimmed, kind === "dockable" ? "station" : kind);
      return result.matches.map((match) => ({ ...match, jumps: null }));
    },
  };

  function toggleHaul(characterID: number, planetID: number): void {
    const next = new Map(haulTicked);
    const ticked = new Set(next.get(characterID) ?? []);
    if (ticked.has(planetID)) ticked.delete(planetID);
    else ticked.add(planetID);
    next.set(characterID, ticked);
    haulTicked = next;
  }

  /**
   * Where the division picker reads the corporation's division names: this
   * pilot's own session when it is online in this tab. Otherwise the seven
   * divisions by number - the run checks the office on arrival either way.
   */
  function divisionSource(characterID: number): Pick<AppFlow, "loadCorpOffices"> {
    for (const session of sessions) {
      if (session.store.station.get().online?.characterID === characterID) {
        return session.flow;
      }
    }
    const corporationID = corporationOf(characterID);
    const known = corporationID === null ? null : haulPrefs.divisionNames.get(corporationID) ?? null;
    return {
      loadCorpOffices: async () => ({
        stationIDs: [],
        divisions: [1, 2, 3, 4, 5, 6, 7].map((division) => ({
          division,
          name: known?.find((entry) => entry.division === division)?.name ?? null,
        })),
        error: null,
      }),
    };
  }

  /** True when this pilot's division names are known (remembered, or online here). */
  function namesKnown(characterID: number): boolean {
    if (sessions.some((session) => session.store.station.get().online?.characterID === characterID)) return true;
    const corporationID = corporationOf(characterID);
    return corporationID !== null && haulPrefs.divisionNames.has(corporationID);
  }

  /** Haul the ticked colonies of this pilot, as a SERVER run (the restart's rules). */
  async function haul(characterID: number, rows: readonly PiColonyRow[]): Promise<void> {
    const accountName = known.find((pilot) => pilot.characterID === characterID)?.accountName;
    const set = (state: PiDispatchState) => {
      const next = new Map(haulDispatch);
      next.set(characterID, state);
      haulDispatch = next;
    };
    if (!accountName) {
      set({ kind: "refused", sentence: "This pilot is no longer in the hangar, so there is no account to start it with." });
      return;
    }
    const ticked = haulTicked.get(characterID) ?? new Set<number>();
    const colonies = rows
      .filter((row) => ticked.has(row.planetID))
      .map((row) => ({
        planetID: row.planetID,
        planetName: row.planetName,
        solarSystemID: row.solarSystemID,
        solarSystemName: row.solarSystemName,
      }));
    set({ kind: "starting" });
    const outcome = await haulFor(
      accountName,
      characterID,
      colonies,
      haulPrefs.divisions.get(characterID) ?? null,
      haulPrefs.deliverTo.get(characterID) ?? null,
    );
    set(outcome);
    setWatch(characterID, outcome.kind === "started" ? startWatch("haul", Date.now(), outcome.stages ?? [], colonies.map((colony) => colony.planetID)) : null);
    await loadActiveBots();
  }

  function keep(next: PiRosterPrefs): void {
    roster = next;
    savePiRoster(next);
  }

  const names = $derived(new Map(known.map((pilot) => [pilot.characterID, pilot.characterName])));
  const readings = $derived(piReadings(roster));
  const board = $derived(
    buildPiBoard({ members: roster.members, names, readings, attempts, browserNowMs, recipes, activeBots, dispatch }),
  );
  // Runs that want the player, said at the top of the Colonies view.
  const runAlerts = $derived(board.groups.flatMap((group) => {
    const run = runViewFor(group.characterID);
    return run !== null && (run.tone === "paused" || run.tone === "stopped")
      ? [{ characterID: group.characterID, pilotName: group.pilotName, run }]
      : [];
  }));
  // THE ROSTER BY ACCOUNT. What a pilot's colonies are ("5 colonies, Alpha")
  // is the Colonies view's own words, so the two views cannot disagree.
  const accounts = $derived(
    pilotsByAccount(board.pilots, new Map(known.map((pilot) => [pilot.characterID, pilot.accountName]))),
  );
  const colonyWords = $derived(new Map(board.groups.map((group) => [group.characterID, group.countWords])));
  const pilotRows = $derived(new Map(board.pilots.map((pilot) => [pilot.characterID, pilot])));
  /** "3 pilots, 5 colonies - Read 45 minutes ago": the age only when it is one. */
  function accountWords(account: PiAccountGroup): string {
    const pilots = account.rows.length + account.notBuilt.length;
    const parts = [pilots === 1 ? "1 pilot" : `${pilots} pilots`];
    if (account.colonyCount > 0) {
      parts.push(account.colonyCount === 1 ? "1 colony" : `${account.colonyCount} colonies`);
    }
    const counts = parts.join(", ");
    return account.readAgeWords ? `${counts} - ${account.readAgeWords}` : counts;
  }
  const addablePilots = $derived(
    known
      .filter((pilot) => !roster.members.includes(pilot.characterID))
      .sort((left, right) => left.characterName.localeCompare(right.characterName)),
  );
  // The badge is what waits in that view: colonies that need you. A restart
  // is offered on its pilot's colonies, so it waits there too. Nothing
  // waiting, no badge.
  const menu = $derived<{ id: View; label: string; badge: number; urgent: boolean }[]>([
    {
      id: "colonies",
      label: "Colonies",
      badge: board.needsYou.length,
      urgent: board.needsYou.some((item) => item.urgency === "now"),
    },
    { id: "stock", label: "Stock", badge: 0, urgent: false },
    { id: "coverage", label: "Coverage", badge: 0, urgent: false },
    { id: "planner", label: "Planner", badge: 0, urgent: false },
    { id: "pilots", label: "Pilots", badge: 0, urgent: false },
  ]);

  // ③ WHAT YOU HOLD. `readings` is already the roster's own pilots only
  // (piReadings), so a removed pilot's goods leave the totals with it.
  const memberReadings = $derived(readings);
  const holdings = $derived([
    ...holdingsFromReadings(memberReadings, names),
    ...holdingsFromCorpReads(corpReads, recipes),
  ]);
  const lines = $derived(stockLines(holdings, recipes));
  const summary = $derived(stockSummary(lines));
  const sources = $derived(
    stockSources({ members: roster.members, readings: memberReadings, names, corpReads, browserNowMs }),
  );
  const shownGroups = $derived(
    stockByTier(
      lines.filter((line) =>
        (stockTier === "all" || line.tier === stockTier)
        && line.typeName.toLowerCase().includes(stockSearch.trim().toLowerCase())),
    ),
  );
  const corpWords = $derived.by(() => {
    const read = corpReads.filter((corp) => corp.state === "read").length;
    if (corpReads.length === 0) return "-";
    return read === corpReads.length ? countWords(summary.inCorp) : `${read} of ${corpReads.length} read`;
  });

  // ⑤ WHAT THE COLONIES MAKE (bridge/piCoverage.ts), against the balanced aim.
  const coverage = $derived(
    recipes?.readable ? buildCoverage({ book: recipes, readings: memberReadings, names, browserNowMs }) : null,
  );
  const coverageGroups = $derived.by(() => {
    if (coverage === null) return [];
    const shown = coverage.lines.filter((line) => coverageTier === "all" || line.tier === coverageTier);
    return ([0, 1, 2, 3, 4] as const)
      .map((tier) => ({ tier, label: tierLabel(tier), lines: shown.filter((line) => line.tier === tier) }))
      .filter((group) => group.lines.length > 0);
  });

  // What the two summary numbers mean, on their question marks.
  const BALANCE_HELP =
    "Balanced is your basics' total output per hour, split the way the recipes use each one to make every P4 once. "
    + "It comes from the recipes, not from a setting. A basic below balance runs short first; its gap says roughly "
    + "how many colonies like yours would close it.";
  const WEAK_HELP =
    "A colony extracting under three quarters of what the typical colony drilling the same resource does: "
    + "usually a poor planet or a thin extractor layout. Open the Raw rows to see which.";

  /** "about 2 colonies short", "none made", "balanced", or "-" where no balance applies. */
  function gapWords(line: CoverageLine): string {
    if (line.state === "untargeted") return "-";
    if (line.state === "ok") return "balanced";
    if (line.colonyGap === null) return line.state === "none" ? "none made" : "short";
    return line.colonyGap === 1 ? "about 1 colony short" : `about ${line.colonyGap} colonies short`;
  }

  function rateWords(perHour: number): string {
    return perHour > 0 && perHour < 10 ? (Math.round(perHour * 10) / 10).toString() : countWords(perHour);
  }

  function toggle(set: Set<number>, typeID: number): Set<number> {
    const next = new Set(set);
    if (next.has(typeID)) next.delete(typeID);
    else next.add(typeID);
    return next;
  }

  // ④ THE PLANNER.
  // Everything a factory makes, grouped by tier for the picker. A recipe the
  // book does not classify still appears, under Other, rather than vanishing.
  const targetGroups = $derived.by(() => {
    const book = recipes;
    if (!book) return [];
    const groups = new Map<string, { label: string; rows: { typeID: number; name: string }[] }>();
    for (const row of madeThings(book)) {
      const tier = tierOf(book, row.output.typeID);
      const label = tier === null ? "Other" : `P${tier}`;
      const group = groups.get(label) ?? { label, rows: [] };
      group.rows.push({ typeID: row.output.typeID, name: commodityName(book, row.output.typeID) ?? row.name });
      groups.set(label, group);
    }
    return [...groups.values()];
  });
  const plannerColonies = $derived<PlannerColony[]>(
    [...memberReadings.values()].flatMap((reading) =>
      reading.report.colonies.map((colony) => ({ colony, clockOffsetMs: reading.report.clockOffsetMs }))),
  );
  const plan = $derived(
    planRequest && recipes?.readable
      ? planWithStock({
          book: recipes,
          targetTypeID: planRequest.typeID,
          quantity: planRequest.quantity,
          holdings,
          colonies: plannerColonies,
          browserNowMs,
        })
      : null,
  );

  const missing = $derived(plan ? missingByTier(plan) : []);

  function isTreeOpen(key: string): boolean {
    return treeOverride.get(key) ?? false;
  }

  function toggleTree(key: string): void {
    const next = new Map(treeOverride);
    next.set(key, !isTreeOpen(key));
    treeOverride = next;
    const openID = planView.openID;
    if (openID !== null) {
      const keys = [...next].filter(([, open]) => open).map(([nodeKey]) => nodeKey);
      keepView(withOpenNodes(planView, openID, keys));
    }
  }

  // ④ SAVED PLANS.
  const openPlan = $derived(plans.find((entry) => entry.planID === planView.openID) ?? null);
  const activePlans = $derived(plans.filter((entry) => entry.status === "active"));
  const donePlans = $derived(plans.filter((entry) => entry.status === "done"));
  // Each plan's standing, worked out now from the stock as it stands -- the
  // same planner the open plan uses, never a stored verdict.
  const planStanding = $derived.by(() => {
    const out = new Map<string, PlanStanding>();
    const book = recipes;
    if (!book?.readable) return out;
    for (const entry of plans) {
      out.set(entry.planID, standingOf(planWithStock({
        book,
        targetTypeID: entry.typeID,
        quantity: entry.quantity,
        holdings,
        colonies: plannerColonies,
        browserNowMs,
      })));
    }
    return out;
  });
  // The open plan's own counts, for the summary above its missing list.
  const openCounts = $derived(plan ? planStepCounts(plan) : null);

  interface PlanStanding {
    readonly words: string;
    readonly tone: "ok" | "act" | "bad";
    readonly title: string;
    /** Share of steps already covered, 0 to 1, for the bar. */
    readonly share: number;
  }

  function standingOf(result: ReturnType<typeof planWithStock>): PlanStanding {
    if (result === null) {
      return { words: "unknown", tone: "bad", title: "The recipe table has no way to make this.", share: 0 };
    }
    const counts = planStepCounts(result);
    const share = counts.steps > 0 ? counts.ok / counts.steps : 1;
    const title = `${counts.ok} of ${counts.steps} steps covered. ${result.verdict}`;
    if (result.gaps.length > 0) return { words: `${result.gaps.length} blocked`, tone: "bad", title, share };
    if (counts.act > 0) return { words: `${counts.act} to change`, tone: "act", title, share };
    return { words: "covered", tone: "ok", title, share };
  }

  function planName(typeID: number): string {
    return (recipes ? commodityName(recipes, typeID) : null) ?? `Commodity ${typeID}`;
  }

  /** Change the open plan's quantity: planned at once, saved behind it. */
  function commitQuantity(): void {
    const quantity = Number(planQuantity.replace(/,/g, "").trim());
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      planError = "Enter how many, as a whole number.";
      return;
    }
    planError = null;
    if (planRequest === null || planRequest.quantity === quantity) return;
    planRequest = { ...planRequest, quantity };
    if (openPlan !== null) void changePlan(openPlan, { quantity });
  }

  function commitNote(): void {
    const note = planNote.trim();
    if (openPlan !== null && openPlan.note !== note) void changePlan(openPlan, { note });
  }

  function keepView(next: PiPlanView): void {
    planView = next;
    savePiPlanView(next);
  }

  /** The accounts a plan call may sign in with: the roster's own first. */
  function planAccounts(): string[] {
    const byCharacter = new Map(known.map((pilot) => [pilot.characterID, pilot.accountName]));
    const first = roster.members.map((id) => byCharacter.get(id)).filter((name): name is string => !!name);
    return [...first, ...known.map((pilot) => pilot.accountName)];
  }

  function showPlan(entry: SavedPiPlan | null): void {
    openExpansionID = null;
    planError = null;
    placesOpen = new Set();
    if (entry === null) {
      planTarget = "";
      planQuantity = "";
      planNote = "";
      planRequest = null;
      treeOverride = new Map();
      keepView(withOpenPlan(planView, null));
      return;
    }
    planTarget = String(entry.typeID);
    planQuantity = String(entry.quantity);
    planNote = entry.note;
    planRequest = { typeID: entry.typeID, quantity: entry.quantity };
    treeOverride = new Map((planView.openNodes[entry.planID] ?? []).map((key) => [key, true]));
    keepView(withOpenPlan(planView, entry.planID));
  }

  async function loadPlans(): Promise<void> {
    try {
      plans = await loadPiPlans(planAccounts());
      plansError = null;
      plansLoaded = true;
      keepView(prunePiPlanView(planView, plans.map((entry) => entry.planID)));
      // Where you left off: the plan that was open, unless the form moved on.
      if (planRequest === null && openPlan !== null) showPlan(openPlan);
    } catch (error) {
      plansError = error instanceof Error ? error.message : String(error);
    }
  }

  async function changePlan(entry: SavedPiPlan, fields: Parameters<typeof updatePiPlan>[2]): Promise<void> {
    planSaving = true;
    try {
      plans = withPlan(plans, await updatePiPlan(planAccounts(), entry, fields));
      plansError = null;
    } catch (error) {
      plansError = error instanceof Error ? error.message : String(error);
      // Most likely changed elsewhere: take the server's copy.
      void loadPlans();
    } finally {
      planSaving = false;
    }
  }

  /** Done, or back to active. Leaving a plan open when it is marked done is fine. */
  function setPlanStatus(entry: SavedPiPlan, status: "active" | "done"): void {
    void changePlan(entry, { status });
  }

  /** For good -- offered only on a plan already marked done. */
  async function removePlan(entry: SavedPiPlan): Promise<void> {
    planSaving = true;
    try {
      await deletePiPlan(planAccounts(), entry.planID);
      plans = withoutPlan(plans, entry.planID);
      plansError = null;
      if (planView.openID === entry.planID) showPlan(null);
      keepView(prunePiPlanView(planView, plans.map((row) => row.planID)));
    } catch (error) {
      plansError = error instanceof Error ? error.message : String(error);
    } finally {
      planSaving = false;
    }
  }

  function toggleKey(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  function submitPlan(): void {
    const typeID = Number(planTarget);
    const quantity = Number(planQuantity.replace(/,/g, "").trim());
    if (!Number.isSafeInteger(typeID) || typeID <= 0) {
      planError = "Choose something to make.";
    } else if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      planError = "Enter how many, as a whole number.";
    } else {
      planError = null;
      const note = planNote.trim();
      const current = openPlan;
      // A different commodity is a different plan; the same one is this plan
      // with a new number or note.
      if (current === null || current.typeID !== typeID) {
        treeOverride = new Map();
        placesOpen = new Set();
      }
      // Planned at once, from what is held: the save is bookkeeping, and a
      // server that cannot take it right now must not stop the planning.
      planRequest = { typeID, quantity };
      void savePlan(current, { typeID, quantity, note });
    }
  }

  async function savePlan(
    current: SavedPiPlan | null,
    fields: { typeID: number; quantity: number; note: string },
  ): Promise<void> {
    if (current !== null && current.typeID === fields.typeID) {
      if (current.quantity === fields.quantity && current.note === fields.note) return;
      await changePlan(current, { quantity: fields.quantity, note: fields.note });
      return;
    }
    planSaving = true;
    try {
      const created = await createPiPlan(planAccounts(), fields);
      plans = withPlan(plans, created);
      plansError = null;
      keepView(withOpenPlan(planView, created.planID));
    } catch (error) {
      plansError = `Not saved: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      planSaving = false;
    }
  }

  // ⑥ EXPANSION PLANS. Free slots, the map around a home system, and the
  // richness of its planets go in; a proposal comes out (bridge/piExpansion.ts).
  const knownRichness = $derived(mergeRichness(richness, richnessFromReadings(memberReadings)));
  const expansionRoster = $derived(expansionPilots(roster.members, memberReadings, names));
  const freeSlots = $derived(expansionRoster.pilots.reduce((total, pilot) => total + pilot.freeSlots, 0));
  const homes = $derived(homeSystems(memberReadings));
  const openExpansion = $derived(expansions.find((entry) => entry.planID === openExpansionID) ?? null);
  const activeExpansions = $derived(expansions.filter((entry) => entry.status === "active"));
  const doneExpansions = $derived(expansions.filter((entry) => entry.status === "done"));
  /** The draft's rows, or the open plan's, as the window shows them. */
  const expansionShown = $derived.by((): readonly ExpansionGroupView[] => {
    if (!recipes?.readable) return [];
    const rows = openExpansion
      ? openExpansion.rows
      : (draft?.rows ?? []).map((row) => ({
          characterID: row.characterID,
          planetID: row.planet.planetID,
          resourceTypeID: row.resourceTypeID,
          productTypeID: row.productTypeID,
        }));
    return expansionGroups(rows, expPlanets, knownRichness, memberReadings, names, recipes);
  });
  const expansionRows = $derived(expansionShown.flatMap((group) => group.rows));
  const expansionToBuy = $derived(
    commandCentresToBuy(expansionRows.map((row) => ({ planetTypeName: row.planetTypeName, state: row.state }))),
  );

  /** Each saved expansion's standing: how many of its rows stand built now. */
  function expansionStanding(entry: SavedPiExpansion): { words: string; share: number; tone: "ok" | "act" } {
    const built = entry.rows.filter((row) => rowState(row, memberReadings) === "built").length;
    const total = entry.rows.length;
    return { words: `${built} of ${total} built`, share: total > 0 ? built / total : 1, tone: built === total ? "ok" : "act" };
  }

  function systemName(solarSystemID: number): string {
    return homes.find((home) => home.solarSystemID === solarSystemID)?.name ?? "A system this map does not name";
  }

  async function loadExpansions(): Promise<void> {
    try {
      expansions = await loadPiExpansions(planAccounts());
      expansionsLoaded = true;
    } catch (error) {
      expError = error instanceof Error ? error.message : String(error);
    }
  }

  /** The map around a system, asked on a throwaway sign-in like the plans are. */
  async function readPlanetsNear(systemID: number, jumps: number): Promise<Map<number, PlanetNear>> {
    const raw = await signedIn(planAccounts(), DEFAULT_PI_PLAN_DEPS, (token) =>
      getPlanetsNear(systemID, jumps, { token, priority: "user" }));
    return new Map(decodePlanetsNear(raw).planets.map((planet) => [planet.planetID, planet]));
  }

  /** A pilot online in this tab, whose session may ask the game for richness. */
  function richnessReader(): { name: string; options: ReturnType<Session["flow"]["requestOptions"]> } | null {
    for (const session of sessions) {
      const online = session.store.station.get().online;
      if (online) return { name: online.characterName, options: session.flow.requestOptions() };
    }
    return null;
  }

  function newExpansion(): void {
    showPlan(null);
    composeKind = "expansion";
    if (expHome === "" && homes[0]) expHome = String(homes[0].solarSystemID);
  }

  function showExpansion(entry: SavedPiExpansion): void {
    showPlan(null);
    openExpansionID = entry.planID;
    draft = null;
    expWords = null;
    expError = null;
    if (entry.settings.homeSystemID > 0) {
      void readPlanetsNear(entry.settings.homeSystemID, entry.settings.maxJumps)
        .then((planets) => {
          if (openExpansionID === entry.planID) expPlanets = planets;
        })
        .catch((error) => (expError = error instanceof Error ? error.message : String(error)));
    }
  }

  /** Read the map and the richness it needs, then propose. Nothing is saved until Keep. */
  async function proposeNow(): Promise<void> {
    const homeSystemID = Number(expHome);
    const maxJumps = Number(expJumps);
    const tolerancePercent = Number(expTolerance);
    if (!Number.isSafeInteger(homeSystemID) || homeSystemID <= 0) {
      expError = "Choose a system to look around.";
      return;
    }
    if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > 100) {
      expError = "Enter a tolerance from 0 to 100 percent.";
      return;
    }
    if (!recipes?.readable || coverage === null) {
      expError = "The recipe table has not been read yet. Refresh reads it.";
      return;
    }
    expError = null;
    expBusy = true;
    try {
      const planets = await readPlanetsNear(homeSystemID, maxJumps);
      expPlanets = planets;
      // Only the planets that carry a resource a basic is refined from, and whose richness is not known yet.
      const unknown = [...planets.values()]
        .filter((planet) => planet.resourceTypeIDs.length > 0 && !knownRichness.has(planet.planetID))
        .map((planet) => planet.planetID);
      const reader = unknown.length > 0 ? richnessReader() : null;
      let notRead = unknown.length;
      if (reader) {
        const found = await readRichness(unknown, reader.options);
        richness = mergeRichness(richness, found);
        saveRichness(richness);
        notRead = unknown.filter((planetID) => !found.has(planetID)).length;
      }
      draftSettings = { homeSystemID, maxJumps, nullsecTolerance: tolerancePercent / 100 };
      draft = proposeExpansion({
        book: recipes,
        coverage,
        demand: balancedDemand(recipes),
        pilots: expansionRoster.pilots,
        planets: [...planets.values()],
        richness: mergeRichness(richness, richnessFromReadings(memberReadings)),
        readings: memberReadings,
        nullsecTolerance: tolerancePercent / 100,
      });
      const parts = [`${planets.size} planets within ${maxJumps === 1 ? "1 jump" : `${maxJumps} jumps`}.`];
      if (reader && unknown.length > notRead) {
        parts.push(`Richness read for ${unknown.length - notRead} of them through ${reader.name}, and kept.`);
      }
      if (notRead > 0) {
        parts.push(reader
          ? `${notRead} did not answer, so they rank below the planets whose richness is known.`
          : `No pilot is online in this tab, so ${notRead} planets' richness is unknown and they rank last. Bring a pilot online here and propose again to read it.`);
      }
      if (draft.unusedSlots > 0) parts.push(`${draft.unusedSlots} free slots found nothing left to drill in reach.`);
      expWords = parts.join(" ");
    } catch (error) {
      expError = error instanceof Error ? error.message : String(error);
    } finally {
      expBusy = false;
    }
  }

  async function keepDraft(): Promise<void> {
    if (draft === null || draftSettings === null || draft.rows.length === 0) return;
    expBusy = true;
    try {
      const plan = await createPiExpansion(planAccounts(), {
        settings: { ...draftSettings, characterIDs: [...new Set(draft.rows.map((row) => row.characterID))] },
        rows: draft.rows.map((row) => ({
          characterID: row.characterID,
          planetID: row.planet.planetID,
          resourceTypeID: row.resourceTypeID,
          productTypeID: row.productTypeID,
        })),
      });
      expansions = [plan, ...expansions];
      draft = null;
      expWords = null;
      openExpansionID = plan.planID;
    } catch (error) {
      expError = `Not saved: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      expBusy = false;
    }
  }

  async function setExpansionStatus(entry: SavedPiExpansion, status: "active" | "done"): Promise<void> {
    expBusy = true;
    try {
      const plan = await updatePiExpansion(planAccounts(), entry, { status });
      expansions = expansions.map((row) => (row.planID === plan.planID ? plan : row));
    } catch (error) {
      expError = error instanceof Error ? error.message : String(error);
      void loadExpansions();
    } finally {
      expBusy = false;
    }
  }

  /** For good -- offered only on a plan already marked done, as for commodity plans. */
  async function removeExpansion(entry: SavedPiExpansion): Promise<void> {
    expBusy = true;
    try {
      await deletePiExpansion(planAccounts(), entry.planID);
      expansions = expansions.filter((row) => row.planID !== entry.planID);
      if (openExpansionID === entry.planID) openExpansionID = null;
    } catch (error) {
      expError = error instanceof Error ? error.message : String(error);
    } finally {
      expBusy = false;
    }
  }

  /** Pilots online in this tab, read at call time, for the corp hangar read. */
  function onlinePilots(): OnlinePilot[] {
    const pilots: OnlinePilot[] = [];
    for (const session of sessions) {
      const online = session.store.station.get().online;
      if (!online) continue;
      pilots.push({
        characterID: online.characterID,
        corporationID: online.corporationID,
        options: session.flow.requestOptions(),
      });
    }
    return pilots;
  }

  /**
   * Roster pilots a server bot is flying, for the corp hangar read. Roster
   * pilots only: a pilot's corporation is known from its last colony read.
   */
  function botPilots(): BotPilot[] {
    const pilots: BotPilot[] = [];
    for (const [characterID, reading] of piReadings(roster)) {
      if (!activeBots.has(characterID)) continue;
      const accountName = known.find((pilot) => pilot.characterID === characterID)?.accountName;
      if (!accountName) continue;
      pilots.push({ characterID, corporationID: reading.corporationID ?? null, accountName });
    }
    return pilots;
  }

  async function refreshCorpStock(): Promise<void> {
    const online = onlinePilots();
    const corporations = [
      ...[...piReadings(roster).values()].map((reading) => reading.corporationID ?? null),
      ...online.map((pilot) => pilot.corporationID),
    ].filter(isPlayerCorporation);
    try {
      corpReads = await readCorpStock(corporations, online, botPilots());
    } catch {
      // Each corp's outcome is caught inside the read; keep the last answer.
    }
  }
  const squadsWithNewPilots = $derived(
    hangar.squads.filter((squad) =>
      (hangar.members[squad.id] ?? []).some((id) => !roster.members.includes(id)),
    ),
  );

  async function refresh(): Promise<void> {
    // A run that is over has said how it went; a Refresh is the player moving on.
    const live = new Map([...runWatch].filter(([characterID]) => !runViewFor(characterID)?.over));
    if (live.size !== runWatch.size) runWatch = live;
    await readPilots(roster.members);
  }

  /** Read these roster pilots' colonies (all of them on Refresh), then the corp stock. */
  async function readPilots(asked: readonly number[]): Promise<void> {
    if (reading || asked.length === 0) return;
    reading = true;
    known = loadKnownCharacters();
    // Awaited before the corp read below, which reads through bot-flown pilots.
    const botsRead = loadActiveBots(asked);
    const marked = new Map(asked.length === roster.members.length ? [] : attempts);
    for (const id of asked) marked.set(id, "reading");
    attempts = marked;
    try {
      await readPiRoster(asked, known, undefined, (result) => {
        let next = roster;
        for (const answer of result.answers) {
          next = recordPiAnswer(next, answer.envelope, answer.browserNowMs);
        }
        keep(next);
        const merged = new Map(attempts);
        for (const [characterID, attempt] of result.attempts) merged.set(characterID, attempt);
        attempts = merged;
        browserNowMs = Date.now();
      }, recipes?.readable ? {} : {
        onRecipes: (raw) => {
          const book = decodeRecipeBook(raw);
          if (book.readable) recipes = book;
        },
      });
      // After the roster, because it names each pilot's corporation.
      await botsRead;
      await refreshCorpStock();
      await learnNames();
    } finally {
      reading = false;
      browserNowMs = Date.now();
    }
    if (rereadPending.size > 0) void reread([]);
  }

  function add(): void {
    const [kind, id] = choice.split(":");
    if (kind === "pilot") {
      keep(addPiMember(roster, Number(id)));
    } else if (kind === "squad" && id) {
      keep(addPiMembers(roster, hangar.members[id] ?? []));
    }
    choice = "";
  }

  /** Off the PI list only: nothing is signed in, selected or undocked. */
  function removePilot(characterID: number): void {
    keep(removePiMember(roster, characterID));
    const next = new Map(attempts);
    next.delete(characterID);
    attempts = next;
    const started = new Map(dispatch);
    started.delete(characterID);
    dispatch = started;
  }

  onMount(() => {
    void refresh();
    void loadPlans();
    void loadExpansions();
    const tick = setInterval(() => (browserNowMs = Date.now()), 30_000);
    // Guarded (app/skipWhileBusy.ts), and silent while no bot flies anybody here.
    const poll = skipWhileBusy(async () => {
      const flying = roster.members.some((id) => activeBots.has(id));
      if (!flying && ![...runWatch.values()].some((watch) => !watch.seen)) return;
      await loadActiveBots();
    });
    const runs = setInterval(() => void poll(), RUN_POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(runs);
    };
  });
</script>

<section class="panel pi-manager">
  <header class="panel-head">
    <h2 class="panel-title">Planetary Industry</h2>
    {#if board.staleWords}
      <p class="stat-line">{board.staleWords}</p>
    {/if}
    <span class="controls">
      <button
        type="button"
        class="pi-help-open"
        aria-label="How Planetary Industry works"
        title="How Planetary Industry works"
        onclick={() => (helpOpen = true)}
      >
        ?
      </button>
      <button
        type="button"
        disabled={reading || roster.members.length === 0}
        onclick={() => void refresh()}
      >
        {reading ? "Looking..." : "Refresh"}
      </button>
    </span>
  </header>
  <PiHelp open={helpOpen} section={view} onClose={() => (helpOpen = false)} />

  <div class="pi-body">
    <!-- THE WINDOW'S OWN MENU. A side rail while the window is wide, a row across
         the top when it is narrow; the same buttons either way. -->
    <nav class="pi-menu" aria-label="Planetary Industry">
      <div role="tablist" class="pi-menu-list">
        {#each menu as item (item.id)}
          <button
            type="button"
            role="tab"
            id="pi-tab-{item.id}"
            class="pi-menu-item"
            class:on={view === item.id}
            aria-selected={view === item.id}
            aria-controls="pi-view-{item.id}"
            onclick={() => (view = item.id)}
          >
            <span>{item.label}</span>
            {#if item.badge > 0}
              <span class="pi-badge" class:urgent={item.urgent}>{item.badge}</span>
            {/if}
          </button>
        {/each}
      </div>
    </nav>

    <div class="pi-views">
      <section
        class="pi-view"
        id="pi-view-colonies"
        role="tabpanel"
        aria-labelledby="pi-tab-colonies"
        hidden={view !== "colonies"}
      >
        {#if roster.members.length === 0}
          <p class="empty">
            No pilots are on planetary industry yet.
            <button type="button" class="pi-link" onclick={() => (view = "pilots")}>Add one under Pilots</button>
          </p>
        {:else if board.emptyWords}
          <p class="empty">{board.emptyWords}</p>
        {/if}

        {#if board.colonies.length > 0}
          <!-- THE STRIP: the whole estate in four numbers, before any row. -->
          <dl class="pi-summary">
            <div>
              <dt>Colonies</dt>
              <dd>{board.summary.colonies}</dd>
            </div>
            <div>
              <dt>Extracting</dt>
              <dd class="good">{board.summary.extracting}</dd>
            </div>
            <div>
              <dt>Need you now</dt>
              <dd class:bad={board.summary.needYouNow > 0}>{board.summary.needYouNow}</dd>
            </div>
            <div>
              <dt>Next program ends</dt>
              <dd>{board.summary.nextEndsWords ?? "-"}</dd>
            </div>
          </dl>

          <!-- A RUN THAT WANTS THE PLAYER is said above every pilot, so a paused
               haul on a closed line is not missed. -->
          {#each runAlerts as alert (alert.characterID)}
            <div class="pi-alert tone-{alert.run.tone}" role="alert">
              <span><strong>{alert.pilotName}</strong>: {alert.run.words}</span>
              <button type="button" class="pi-link" onclick={() => showPilot(alert.characterID)}>Show</button>
            </div>
          {/each}

          <div class="pi-colonies-tools" role="group" aria-label="Colony rows">
            <button type="button" aria-pressed={density === "normal"} onclick={() => pickDensity("normal")}>Normal</button>
            <button type="button" aria-pressed={density === "compact"} onclick={() => pickDensity("compact")}>Compact</button>
          </div>

          <!-- ② COLONIES BY PILOT. One line per pilot, opened on demand: the
               line says what needs the player, how full the fullest store is and
               what a run is doing, so a closed line hides nothing urgent. A line
               that needs the player opens by itself. One reading per pilot, so
               its age is said once and is true of every row under it. -->
          {#each board.groups as group (group.characterID)}
            {@const pilot = pilotRows.get(group.characterID)}
            {@const facts = pilotRowFacts(group.rows)}
            {@const ticked = haulTicked.get(group.characterID) ?? new Set()}
            {@const tickedCount = group.rows.filter((row) => ticked.has(row.planetID)).length}
            {@const division = haulPrefs.divisions.get(group.characterID) ?? null}
            {@const deliverTo = haulPrefs.deliverTo.get(group.characterID) ?? null}
            {@const intoWords = division === null ? null : divisionLabel(division.division, division.name)}
            {@const haulOffer = piHaulWords(group.pilotName, tickedCount, intoWords, deliverTo?.name ?? null)}
            {@const namesHere = namesKnown(group.characterID)}
            {@const haulState = haulDispatch.get(group.characterID) ?? null}
            {@const watch = runWatch.get(group.characterID) ?? null}
            {@const haulWords = piHaulDispatchWords(haulState, watch?.kind === "haul")}
            {@const run = runViewFor(group.characterID)}
            {@const runKind = watch?.kind ?? null}
            {@const open = pilotOpen(group.characterID, facts.needYouNow, run)}
            {@const settingsOpen = haulSettingsOpen.has(group.characterID)}
            {@const hauling = run !== null && runKind === "haul" && !run.over}
            <section
              class="pi-group"
              class:compact={density === "compact"}
              id="pi-pilot-{group.characterID}"
              aria-label={`${group.pilotName}'s colonies`}
            >
              <button
                type="button"
                class="pi-pilot-row edge-{pilotEdge(facts.needYouNow, run)}"
                aria-expanded={open}
                aria-controls="pi-pilot-body-{group.characterID}"
                onclick={() => setOpen(group.characterID, !open)}
              >
                <span class="pi-chevron" class:open aria-hidden="true"></span>
                <span class="pi-pilot-id">
                  <span class="pi-pilot-name">{group.pilotName}</span>
                  <span class="note">{group.countWords}</span>
                </span>
                {#if density === "normal"}
                  <span class="pi-planet-strip" aria-hidden="true">
                    {#each group.rows as row (row.key)}
                      <TypeIcon typeID={row.planetTypeID} name={row.kindWords} />
                    {/each}
                  </span>
                {/if}
                {#if facts.needYouNow > 0}
                  <span class="pi-flag bad">{facts.needYouNow === 1 ? "1 needs you" : `${facts.needYouNow} need you`}</span>
                {:else if facts.soon > 0}
                  <span class="pi-flag warn">{facts.soon} soon</span>
                {:else}
                  <span class="pi-flag good">Fine</span>
                {/if}
                <span class="pi-pilot-run">
                  {#if run}
                    <span class="pi-flag run tone-{run.tone}">{runFlag(run, runKind)}</span>
                    <span class="note">{run.words}</span>
                  {/if}
                </span>
                <span class="note pi-pilot-age">{group.readAgeWords}</span>
                {#if facts.fullest}
                  <span class="pi-pilot-fill">
                    <span class="pi-bar" aria-hidden="true">
                      <span class="pi-bar-fill storage" class:high={facts.fullest.high} style:width={`${facts.fullest.fraction * 100}%`}></span>
                    </span>
                    <span class="note" class:warn={facts.fullest.high}>{Math.floor(facts.fullest.fraction * 100)}%</span>
                  </span>
                {/if}
              </button>

              {#if open}
                <div class="pi-pilot-body" id="pi-pilot-body-{group.characterID}">
                  <div class="pi-group-action pi-haul">
                    {#if pilot?.restart}
                      <!-- The count is on the button; what the run does is in the
                           help, and in full on hover. -->
                      <button
                        type="button"
                        title={pilot.restart.words}
                        disabled={!pilot.restart.enabled}
                        onclick={() => void restartExtractors(pilot.characterID)}
                      >
                        {pilot.restart.label}
                      </button>
                    {/if}
                    <span class="note pi-haul-where">
                      To {deliverTo?.name ?? "the pilot's station"}, {intoWords ?? "the pilot's own hangar"}
                    </span>
                    <button
                      type="button"
                      class="pi-link"
                      aria-expanded={settingsOpen}
                      onclick={() => toggleHaulSettings(group.characterID)}
                    >
                      Change
                    </button>
                    <span class="pi-haul-go">
                      <button
                        type="button"
                        title="Ticks this pilot's colonies whose storage is at least 70% full, for the next haul."
                        onclick={() => tickFull(group.characterID, group.rows)}
                      >
                        Tick colonies 70%+ full
                      </button>
                      {#if haulOffer.hint}
                        <span class="note">{haulOffer.hint}</span>
                      {/if}
                      <button
                        type="button"
                        disabled={tickedCount === 0 || Boolean(pilot?.botWords) || haulState?.kind === "starting" || hauling}
                        onclick={() => void haul(group.characterID, group.rows)}
                      >
                        {hauling ? "Haul running" : haulOffer.label}
                      </button>
                    </span>
                    {#if settingsOpen}
                      <!-- Where this pilot's hauls go, and the sentence that says
                           what a haul will do with these choices. -->
                      <div class="pi-haul-settings">
                        <span class="pi-haul-into">
                          <span class="note">Deliver to</span>
                          <StationPicker
                            flow={stationSearch}
                            value={deliverTo ?? startingStation()}
                            current={null}
                            boardBindings={false}
                            onPick={(ref) => pickDeliverTo(group.characterID, ref)}
                          />
                        </span>
                        <span class="pi-haul-into">
                          <span class="note">Unload into</span>
                          {#key `${group.characterID}:${namesHere}`}
                            <CorpHangarPicker
                              flow={divisionSource(group.characterID)}
                              value={division}
                              station={null}
                              onPick={(picked) => pickHaulDivision(group.characterID, picked)}
                            />
                          {/key}
                          {#if !namesHere}
                            <span class="note">Division names show once a pilot of this corporation has been online here.</span>
                          {/if}
                        </span>
                        <p class="note">{haulOffer.words}</p>
                      </div>
                    {/if}
                    {#if pilot?.botWords && (!run || run.over)}
                      <span class="note pilot-note">{pilot.botWords}</span>
                    {/if}
                    {#if run && runKind === "restart"}
                      <span class="note pilot-note pi-run-words tone-{run.tone}" role="status">{run.words}</span>
                    {:else if pilot?.dispatchWords}
                      <span class="note pilot-note" role="status">{pilot.dispatchWords}</span>
                    {/if}
                    {#if haulWords}
                      <span class="note pilot-note" role="status">{haulWords}</span>
                    {/if}
                    {#if run && watch && runKind === "haul"}
                      <!-- The lap's route, from the step the server says the run
                           is on (bridge/piRunProgress.ts). -->
                      <div class="pi-run tone-{run.tone}" role="status">
                        <ol class="pi-stages" aria-label="Haul route">
                          {#each run.stages as stage, index (index)}
                            <li class="pi-stage {stage.state}" aria-current={stage.state === "current" ? "step" : undefined}>
                              {stage.label}
                            </li>
                          {/each}
                        </ol>
                        <span class="note pi-run-words">{run.words}{elapsedWords(watch.startedAtMs)}</span>
                      </div>
                    {/if}
                    {#if run && run.tone === "paused"}
                      <div class="pi-banner">
                        <span>
                          The run waits where it is. Fix what it says and it carries on, or stop it. Its full log is in the Bot Manager.
                        </span>
                        <button
                          type="button"
                          disabled={stopping.has(group.characterID)}
                          onclick={() => void stopRun(group.characterID)}
                        >
                          {stopping.has(group.characterID) ? "Stopping..." : "Stop"}
                        </button>
                      </div>
                    {/if}
                    {#if stopWords.get(group.characterID)}
                      <span class="note pilot-note bad" role="status">{stopWords.get(group.characterID)}</span>
                    {/if}
                  </div>
                  <ul class="pi-colonies density-{density}">
                    {#each group.rows as row (row.key)}
                      {@const mark = watch ? colonyRunMark(watch, row.planetID, row.solarSystemID) : null}
                      <li class="pi-colony tone-{row.tone}">
                        <span class="pi-colony-place">
                          <input
                            type="checkbox"
                            class="pi-haul-tick"
                            aria-label={`Haul from ${row.placeWords}`}
                            checked={ticked.has(row.planetID)}
                            onchange={() => toggleHaul(group.characterID, row.planetID)}
                          />
                          {#if density === "normal"}
                            <TypeIcon typeID={row.planetTypeID} name={row.kindWords} size="md" />
                          {/if}
                          <span>
                            <span class="pi-colony-name">{row.placeWords}</span>
                            <span class="note">{row.kindWords}</span>
                          </span>
                        </span>
                        <span class="pi-colony-resources">
                          {#each row.resources as resource (resource)}
                            <span class="pi-chip">{resource}</span>
                          {/each}
                          {#if mark}
                            <span class="pi-mark {mark}">{MARK_WORDS[mark]}</span>
                          {/if}
                        </span>
                        <span class="pi-colony-program">
                          {#if row.program && density === "normal"}
                            <span class="pi-bar" aria-hidden="true">
                              <span class="pi-bar-fill program" class:ended={row.program.ended} style:width={`${row.program.fraction * 100}%`}></span>
                            </span>
                          {/if}
                          <span class="pi-status">{row.statusWords}</span>
                        </span>
                        <span class="pi-colony-storage">
                          {#if row.storage}
                            <span class="pi-bar" aria-hidden="true">
                              <span class="pi-bar-fill storage" class:high={row.storage.high} style:width={`${row.storage.fraction * 100}%`}></span>
                            </span>
                            <span class="note" class:warn={row.storage.high}>{density === "normal" ? row.storage.words : `${Math.floor(row.storage.fraction * 100)}%`}</span>
                          {/if}
                        </span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </section>
          {/each}
        {/if}
      </section>

      <!-- THE ROSTER: who is on planetary industry, and what each read said. The
           per-pilot sentence is where the four outcomes are told apart. -->
      <section
        class="pi-view"
        id="pi-view-pilots"
        role="tabpanel"
        aria-labelledby="pi-tab-pilots"
        hidden={view !== "pilots"}
      >
        <section class="pi-section" aria-labelledby="pi-pilots">
          <h3 id="pi-pilots">Pilots</h3>
          {#if roster.members.length === 0 && board.emptyWords}
            <p class="empty">{board.emptyWords}</p>
          {/if}
          {#if addablePilots.length > 0 || squadsWithNewPilots.length > 0}
            <div class="pi-add">
              <label for="pi-add-choice">Add</label>
              <select id="pi-add-choice" bind:value={choice}>
                <option value="">Choose a pilot or a squad</option>
                {#if addablePilots.length > 0}
                  <optgroup label="Pilots">
                    {#each addablePilots as pilot (pilot.characterID)}
                      <option value={`pilot:${pilot.characterID}`}>{pilot.characterName}</option>
                    {/each}
                  </optgroup>
                {/if}
                {#if squadsWithNewPilots.length > 0}
                  <optgroup label="Everyone in a squad">
                    {#each squadsWithNewPilots as squad (squad.id)}
                      <option value={`squad:${squad.id}`}>{squad.name}</option>
                    {/each}
                  </optgroup>
                {/if}
              </select>
              <button type="button" disabled={choice === ""} onclick={add}>Add</button>
            </div>
          {:else if known.length === 0}
            <p class="note">Pilots come from the Pilot hangar. Add an account there first.</p>
          {/if}

          <!-- BY ACCOUNT. A pilot with colonies, or with anything else to say,
               is a row; one read and found with no colony is only a name, so
               the same sentence is not printed once per alt. -->
          {#each accounts as account (account.accountName ?? "")}
            <section class="pi-account" aria-label={account.accountName ?? "No longer in the hangar"}>
              <header class="pi-group-head">
                <h4>{account.accountName ?? "No longer in the hangar"}</h4>
                <span class="note">{accountWords(account)}</span>
              </header>
              {#if account.rows.length > 0}
                <ul class="pi-pilots">
                  {#each account.rows as pilot (pilot.characterID)}
                    <li class="pi-pilot">
                      <span class="pi-pilot-who">
                        <span class="pi-pilot-name">{pilot.pilotName}</span>
                        {#if colonyWords.get(pilot.characterID)}
                          <span class="note">{colonyWords.get(pilot.characterID)}</span>
                        {/if}
                        {#if pilot.noteWords}
                          <span class="note">{pilot.noteWords}</span>
                        {/if}
                        {#if pilot.botWords}
                          <span class="note">{pilot.botWords}</span>
                        {/if}
                      </span>
                      {#if !account.readAgeWords}
                        <span class="note pi-pilot-age">{pilot.readAgeWords ?? "-"}</span>
                      {/if}
                      <button
                        type="button"
                        class="pi-remove"
                        disabled={pilot.busy}
                        aria-label={`Remove ${pilot.pilotName}`}
                        title={`Remove ${pilot.pilotName}`}
                        onclick={() => removePilot(pilot.characterID)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if account.notBuilt.length > 0}
                <div class="pi-unbuilt">
                  <span class="note">Not on a planet yet</span>
                  <ul>
                    {#each account.notBuilt as pilot (pilot.characterID)}
                      <li class="pi-tag">
                        <span>{pilot.pilotName}</span>
                        {#if !account.readAgeWords && pilot.readAgeWords}
                          <span class="note">- {pilot.readAgeWords}</span>
                        {/if}
                        <button
                          type="button"
                          class="pi-remove"
                          disabled={pilot.busy}
                          aria-label={`Remove ${pilot.pilotName}`}
                          title={`Remove ${pilot.pilotName}`}
                          onclick={() => removePilot(pilot.characterID)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                        </button>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </section>
          {/each}
        </section>

        <p class="note pi-footnote">Colonies are read without bringing any pilot online.</p>
      </section>

      <!-- ③ WHAT YOU HOLD (R108 slice 5). One line per commodity; colony stock is
           its own column because it is already where it is needed. Opening a
           line lists every place it sits, whose it is and when it was read. -->
      <section
        class="pi-view"
        id="pi-view-stock"
        role="tabpanel"
        aria-labelledby="pi-tab-stock"
        hidden={view !== "stock"}
      >
        {#if roster.members.length === 0}
          <p class="empty">
            No pilots are on planetary industry yet.
            <button type="button" class="pi-link" onclick={() => (view = "pilots")}>Add one under Pilots</button>
          </p>
        {:else}
          <dl class="pi-summary">
            <div>
              <dt>Kinds held</dt>
              <dd>{summary.kinds}</dd>
            </div>
            <div>
              <dt>In colonies</dt>
              <dd>{countWords(summary.inColonies)}</dd>
            </div>
            <div>
              <dt>In hangars</dt>
              <dd>{countWords(summary.inHangars)}</dd>
            </div>
            <div>
              <dt>Corp hangars</dt>
              <dd class:warn={corpReads.some((corp) => corp.state !== "read")}>{corpWords}</dd>
            </div>
          </dl>

          <div class="pi-filter">
            <div class="pi-tiers" role="group" aria-label="Tier">
              {#each ["all", 0, 1, 2, 3, 4] as const as tier (tier)}
                <button
                  type="button"
                  class="pi-tier"
                  class:on={stockTier === tier}
                  aria-pressed={stockTier === tier}
                  onclick={() => (stockTier = tier)}
                >
                  {tier === "all" ? "All" : tier === 0 ? "Raw" : `P${tier}`}
                </button>
              {/each}
            </div>
            <input
              type="search"
              class="pi-search"
              placeholder="Find a commodity"
              aria-label="Find a commodity"
              bind:value={stockSearch}
            />
          </div>

          {#if lines.length === 0}
            <p class="empty">
              {reading ? "Reading what you hold..." : "Nothing planetary is held anywhere that was read."}
            </p>
          {:else if shownGroups.length === 0}
            <p class="empty">Nothing held matches that.</p>
          {:else}
            <div class="table-wrap overflow-x-auto">
              <table class="pi-table">
                <thead>
                  <tr>
                    <th>Commodity</th>
                    <th class="num">In colonies</th>
                    <th class="num">In hangars</th>
                    <th class="num">Corp</th>
                    <th class="num">Total</th>
                  </tr>
                </thead>
                {#each shownGroups as group (group.label)}
                  <tbody>
                    <tr class="pi-tier-head">
                      <th colspan="5" scope="rowgroup">{group.label}</th>
                    </tr>
                    {#each group.lines as line (line.typeID)}
                      <tr>
                        <td>
                          <button
                            type="button"
                            class="pi-open"
                            aria-expanded={stockOpen.has(line.typeID)}
                            onclick={() => (stockOpen = toggle(stockOpen, line.typeID))}
                          >
                            <span class="pi-caret" aria-hidden="true">{stockOpen.has(line.typeID) ? "v" : ">"}</span>
                            <TypeIcon typeID={line.typeID} name={line.typeName} />
                            <span>{line.typeName}</span>
                          </button>
                        </td>
                        <td class="num">{line.inColonies > 0 ? countWords(line.inColonies) : "-"}</td>
                        <td class="num">{line.inHangars > 0 ? countWords(line.inHangars) : "-"}</td>
                        <td class="num">{line.inCorp > 0 ? countWords(line.inCorp) : "-"}</td>
                        <td class="num">{countWords(line.total)}</td>
                      </tr>
                      {#if stockOpen.has(line.typeID)}
                        <tr class="pi-where">
                          <td colspan="5">
                            <ul>
                              {#each line.holdings as holding, index (index)}
                                <li>
                                  <span class="pi-source">{holding.source}</span>
                                  {countWords(holding.quantity)} - {holding.placeWords} - {holding.ownerWords}
                                  <span class="note">- {holdingAgeWords(holding, browserNowMs)}</span>
                                </li>
                              {/each}
                            </ul>
                          </td>
                        </tr>
                      {/if}
                    {/each}
                  </tbody>
                {/each}
              </table>
            </div>
          {/if}

          {#if sources.length > 0}
            <section class="pi-section" aria-labelledby="pi-sources">
              <h3 id="pi-sources">Where this came from</h3>
              <ul class="pi-sources">
                {#each sources as source, index (index)}
                  <li class="note" class:warn={source.warn}>{source.words}</li>
                {/each}
              </ul>
            </section>
          {/if}
        {/if}
      </section>

      <!-- ⑤ COVERAGE. What the colonies make, tier by tier, built like Stock. The
           basics carry a target: the balanced share of what is made now
           (bridge/piCoverage.ts). Opening a row lists every colony behind it. -->
      <section
        class="pi-view"
        id="pi-view-coverage"
        role="tabpanel"
        aria-labelledby="pi-tab-coverage"
        hidden={view !== "coverage"}
      >
        {#if roster.members.length === 0}
          <p class="empty">
            No pilots are on planetary industry yet.
            <button type="button" class="pi-link" onclick={() => (view = "pilots")}>Add one under Pilots</button>
          </p>
        {:else if coverage === null}
          <p class="empty">{reading ? "Reading the recipe table..." : "The recipe table has not been read yet. Refresh reads it."}</p>
        {:else}
          <dl class="pi-summary">
            <div>
              <dt>Colonies</dt>
              <dd>{coverage.summary.colonies}</dd>
            </div>
            <div>
              <dt>Basics made</dt>
              <dd class:good={coverage.summary.basicsMade === coverage.summary.basicsKnown}>
                {coverage.summary.basicsMade} of {coverage.summary.basicsKnown}
              </dd>
            </div>
            <div>
              <dt>Below balance <button type="button" class="pi-help" aria-label={BALANCE_HELP} title={BALANCE_HELP}>?</button></dt>
              <dd class:warn={coverage.summary.short > 0}>{coverage.summary.short}</dd>
            </div>
            <div>
              <dt>Weak colonies <button type="button" class="pi-help" aria-label={WEAK_HELP} title={WEAK_HELP}>?</button></dt>
              <dd class:warn={coverage.summary.weak > 0}>{coverage.summary.weak}</dd>
            </div>
          </dl>

          <div class="pi-filter">
            <div class="pi-tiers" role="group" aria-label="Tier">
              {#each ["all", 0, 1, 2, 3, 4] as const as tier (tier)}
                <button
                  type="button"
                  class="pi-tier"
                  class:on={coverageTier === tier}
                  aria-pressed={coverageTier === tier}
                  onclick={() => (coverageTier = tier)}
                >
                  {tier === "all" ? "All" : tier === 0 ? "Raw" : `P${tier}`}
                </button>
              {/each}
            </div>
          </div>

          {#if coverageGroups.length === 0}
            <p class="empty">Nothing in this tier is made by a colony that was read.</p>
          {:else}
            <div class="table-wrap overflow-x-auto">
              <table class="pi-table">
                <thead>
                  <tr>
                    <th>Commodity</th>
                    <th class="num">Colonies</th>
                    <th class="num">Per hour</th>
                    <th class="num" title="This basic's share of the basics made now, split the way the recipes use them to make every P4 once">Balanced</th>
                    <th class="num">Gap</th>
                  </tr>
                </thead>
                {#each coverageGroups as group (group.tier)}
                  <tbody>
                    <tr class="pi-tier-head">
                      <th colspan="5" scope="rowgroup">{group.label}</th>
                    </tr>
                    {#each group.lines as line (line.typeID)}
                      <tr>
                        <td>
                          <button
                            type="button"
                            class="pi-open"
                            aria-expanded={coverageOpen.has(line.typeID)}
                            disabled={line.sources.length === 0}
                            onclick={() => (coverageOpen = toggle(coverageOpen, line.typeID))}
                          >
                            <span class="pi-caret" aria-hidden="true">{line.sources.length === 0 ? "" : coverageOpen.has(line.typeID) ? "v" : ">"}</span>
                            <TypeIcon typeID={line.typeID} name={line.typeName} />
                            <span>{line.typeName}</span>
                          </button>
                        </td>
                        <td class="num">
                          {line.colonies > 0 ? line.colonies : "-"}
                          {#if line.weakCount > 0}<span class="note warn"> - {line.weakCount} weak</span>{/if}
                        </td>
                        <td class="num">{line.perHour > 0 ? rateWords(line.perHour) : "-"}</td>
                        <td class="num">{line.targetPerHour === null ? "-" : rateWords(line.targetPerHour)}</td>
                        <td
                          class="num"
                          class:good={line.state === "ok"}
                          class:warn={line.state === "short" || line.state === "none"}
                        >{gapWords(line)}</td>
                      </tr>
                      {#if coverageOpen.has(line.typeID) && line.sources.length > 0}
                        <tr class="pi-where">
                          <td colspan="5">
                            <ul>
                              {#each line.sources as source, index (index)}
                                <li>
                                  <span class="pi-source" class:warn={source.weak}>{source.weak ? "weak" : "colony"}</span>
                                  {source.ownerName} - {source.placeWords}
                                  {#if source.quality !== null} - richness {source.quality}{/if}
                                  - up to {rateWords(source.perHour)} an hour
                                  {#if source.programWords}<span class="note">- {source.programWords}</span>{/if}
                                </li>
                              {/each}
                            </ul>
                          </td>
                        </tr>
                      {/if}
                    {/each}
                  </tbody>
                {/each}
              </table>
            </div>
          {/if}
          <p class="note">
            Rates are what the extractors can pull up on the programs installed now, and what running factories can make.
          </p>
        {/if}
      </section>

      <!-- ④ THE PLANNER (R108 slice 5). Something to make and how many; the
           verdict, the gaps in the order worth telling, then the chain. Every
           number is recipe arithmetic or a server-stated fact. -->
      <section
        class="pi-view"
        id="pi-view-planner"
        role="tabpanel"
        aria-labelledby="pi-tab-planner"
        hidden={view !== "planner"}
      >
        {#if !recipes?.readable}
          <p class="empty">
            {reading ? "Reading the recipe table..." : "The recipe table has not been read yet. Refresh reads it."}
          </p>
        {:else}
          <!-- SAVED PLANS, LIST AND DETAIL. Plans on the left, each with its
               standing worked out now from the stock as it stands; the open one
               on the right. Each plan is judged on its own, so two plans can both
               count the same units. -->
          <div class="pi-planner">
            <aside class="pi-plans" aria-label="Your plans">
              <div class="pi-plans-head">
                <h3>Your plans</h3>
                <button type="button" class="pi-new" onclick={() => showPlan(null)}>+ New</button>
              </div>
              {#snippet planRow(entry: SavedPiPlan)}
                {@const standing = planStanding.get(entry.planID)}
                <li>
                  <button
                    type="button"
                    class="pi-plan-card"
                    class:on={entry.planID === planView.openID}
                    aria-current={entry.planID === planView.openID ? "true" : undefined}
                    onclick={() => showPlan(entry)}
                    title={standing?.title}
                  >
                    <span class="pi-plan-card-top">
                      <TypeIcon typeID={entry.typeID} name={planName(entry.typeID)} size="md" />
                      <span class="pi-plan-card-text">
                        <span class="pi-plan-card-name">{planName(entry.typeID)}</span>
                        <span class="pi-plan-card-sub">{countWords(entry.quantity)}{entry.note ? ` - ${entry.note}` : ""}</span>
                      </span>
                    </span>
                    {#if standing}
                      <span class="pi-plan-card-foot">
                        <span class="pi-meter" aria-hidden="true">
                          <span class="pi-meter-fill tone-{standing.tone}" style:width={`${Math.round(standing.share * 100)}%`}></span>
                        </span>
                        <span class="pi-pill tone-{standing.tone}">{standing.words}</span>
                      </span>
                    {/if}
                  </button>
                </li>
              {/snippet}
              {#snippet expansionRow(entry: SavedPiExpansion)}
                {@const standing = expansionStanding(entry)}
                <li>
                  <button
                    type="button"
                    class="pi-plan-card"
                    class:on={entry.planID === openExpansionID}
                    aria-current={entry.planID === openExpansionID ? "true" : undefined}
                    onclick={() => showExpansion(entry)}
                  >
                    <span class="pi-plan-card-top">
                      <TypeIcon typeID={entry.rows[0]?.productTypeID ?? null} name="Expand colonies" size="md" />
                      <span class="pi-plan-card-text">
                        <span class="pi-plan-card-name">Expand colonies</span>
                        <span class="pi-plan-card-sub">
                          {systemName(entry.settings.homeSystemID)} - {entry.rows.length} colonies{entry.note ? ` - ${entry.note}` : ""}
                        </span>
                      </span>
                    </span>
                    <span class="pi-plan-card-foot">
                      <span class="pi-meter" aria-hidden="true">
                        <span class="pi-meter-fill tone-{standing.tone}" style:width={`${Math.round(standing.share * 100)}%`}></span>
                      </span>
                      <span class="pi-pill tone-{standing.tone}">{standing.words}</span>
                    </span>
                  </button>
                </li>
              {/snippet}
              {#if (!plansLoaded && !plansError) || (!expansionsLoaded && !expError)}
                <p class="pi-plans-empty">Reading your saved plans...</p>
              {:else if activePlans.length === 0 && activeExpansions.length === 0}
                <p class="pi-plans-empty">No plans yet. Start one with New.</p>
              {:else}
                <ul class="pi-plan-list">
                  {#each activePlans as entry (entry.planID)}
                    {@render planRow(entry)}
                  {/each}
                  {#each activeExpansions as entry (entry.planID)}
                    {@render expansionRow(entry)}
                  {/each}
                </ul>
              {/if}
              {#if donePlans.length > 0 || doneExpansions.length > 0}
                <details class="pi-plans-done">
                  <summary>Done ({donePlans.length + doneExpansions.length})</summary>
                  <ul class="pi-plan-list">
                    {#each donePlans as entry (entry.planID)}
                      {@render planRow(entry)}
                    {/each}
                    {#each doneExpansions as entry (entry.planID)}
                      {@render expansionRow(entry)}
                    {/each}
                  </ul>
                </details>
              {/if}
            </aside>

            <div class="pi-plan-detail">
              {#if plansError}
                <p class="pi-plan-error" role="alert">{plansError}</p>
              {/if}

              <!-- AN EXPANSION'S BODY, for a draft and a kept plan alike: the
                   colonies by pilot, as the Colonies view draws a pilot, then
                   the command centres still to buy. -->
              {#snippet expansionBody()}
                {@const built = expansionRows.filter((row) => row.state === "built").length}
                {@const toBuy = expansionToBuy.reduce((total, entry) => total + entry.count, 0)}
                {@const rated = expansionRows.filter((row) => row.quality !== null).length}
                <dl class="pi-summary">
                  <div>
                    <dt>Colonies</dt>
                    <dd>{expansionRows.length}</dd>
                  </div>
                  <div>
                    <dt>Built</dt>
                    <dd class:good={built > 0 && built === expansionRows.length}>{built}</dd>
                  </div>
                  <div>
                    <dt>Command centres to buy</dt>
                    <dd>{toBuy}</dd>
                  </div>
                  <div>
                    <dt>Richness known</dt>
                    <dd class:warn={rated < expansionRows.length}>{rated} of {expansionRows.length}</dd>
                  </div>
                </dl>
                {#each expansionShown as group (group.characterID)}
                  {@const layout = group.commandCenterLevel === null ? null : layoutToCopy(group.commandCenterLevel, memberReadings, names)}
                  <section class="pi-group" aria-label={`${group.pilotName}'s new colonies`}>
                    <header class="pi-group-head">
                      <h3>
                        {group.pilotName}
                        <span class="note">- {group.rows.length === 1 ? "1 colony" : `${group.rows.length} colonies`}{group.commandCenterLevel === null ? "" : `, command centre ${group.commandCenterLevel}`}</span>
                      </h3>
                      {#if layout}<span class="note">{layout.words}</span>{/if}
                    </header>
                    <ul class="pi-colonies">
                      {#each group.rows as row (row.key)}
                        <li class="pi-colony" class:tone-planned={row.state !== "built"}>
                          <span class="pi-colony-place">
                            <TypeIcon typeID={expPlanets.get(row.ref.planetID)?.planetTypeID ?? null} name={row.planetTypeName ?? "Planet"} size="md" />
                            <span>
                              <span class="pi-colony-name">{row.planetName}</span>
                              <span class="note">{[row.planetTypeName, row.placeWords].filter(Boolean).join(" - ")}</span>
                            </span>
                          </span>
                          <span class="pi-colony-resources">
                            <span class="pi-chip">{row.resourceName}</span>
                            <span class="note">for {row.productName}</span>
                          </span>
                          <span class="pi-colony-program">
                            <span class="pi-status">{row.quality === null ? "richness not read" : `richness ${row.quality}`}</span>
                          </span>
                          <span class="pi-colony-storage">
                            <span class="note" class:good={row.state === "built"} class:warn={row.state === "other-resource"}>
                              {row.state === "built" ? "Built" : row.state === "other-resource" ? "Built, drilling something else" : "Not built"}
                            </span>
                          </span>
                        </li>
                      {/each}
                    </ul>
                  </section>
                {/each}
                {#if expansionToBuy.length > 0}
                  <h4 class="pi-section-title">Command centres to buy</h4>
                  <p class="note">{expansionToBuy.map((entry) => `${entry.planetTypeName} ${entry.count}`).join(" - ")}</p>
                {/if}
              {/snippet}

              {#if openExpansion}
                <header class="pi-detail-head">
                  <div class="pi-detail-title">
                    <h3>
                      Expand colonies
                      {#if openExpansion.status === "done"}<span class="pi-pill">done</span>{/if}
                    </h3>
                    <p class="note">
                      Around {systemName(openExpansion.settings.homeSystemID)}, within {openExpansion.settings.maxJumps === 1 ? "1 jump" : `${openExpansion.settings.maxJumps} jumps`},
                      nullsec unless {Math.round(openExpansion.settings.nullsecTolerance * 100)}% poorer
                    </p>
                  </div>
                  <div class="pi-detail-actions">
                    {#if openExpansion.status === "active"}
                      <button type="button" disabled={expBusy} onclick={() => openExpansion && setExpansionStatus(openExpansion, "done")}>Mark done</button>
                    {:else}
                      <button type="button" disabled={expBusy} onclick={() => openExpansion && setExpansionStatus(openExpansion, "active")}>Reopen</button>
                      <button type="button" class="danger" disabled={expBusy} onclick={() => openExpansion && removeExpansion(openExpansion)}>Delete</button>
                    {/if}
                  </div>
                </header>
                {#if expError}
                  <p class="pi-plan-error" role="alert">{expError}</p>
                {/if}
                {@render expansionBody()}
              {:else if planRequest === null && composeKind === "expansion"}
                <!-- A NEW EXPANSION. Proposed from the map, the richness and the
                     free slots; nothing is kept until Keep this plan. -->
                <form
                  class="pi-compose"
                  onsubmit={(event) => {
                    event.preventDefault();
                    void proposeNow();
                  }}
                >
                  <h3 class="pi-compose-title">New plan</h3>
                  <div class="pi-tiers" role="group" aria-label="Kind of plan">
                    <button type="button" class="pi-tier" aria-pressed="false" onclick={() => (composeKind = "commodity")}>Make a commodity</button>
                    <button type="button" class="pi-tier on" aria-pressed="true">Expand colonies</button>
                  </div>
                  <div class="pi-compose-row">
                    <label class="pi-field pi-field-grow">
                      <span>Look around</span>
                      <select id="pi-exp-home" bind:value={expHome} onchange={() => (expError = null)}>
                        <option value="">Choose a system</option>
                        {#each homes as home (home.solarSystemID)}
                          <option value={String(home.solarSystemID)}>{home.name} - {home.colonies === 1 ? "1 colony" : `${home.colonies} colonies`}</option>
                        {/each}
                      </select>
                    </label>
                    <label class="pi-field pi-field-qty">
                      <span>Within jumps</span>
                      <select bind:value={expJumps}>
                        {#each [0, 1, 2, 3, 4, 5] as jumps (jumps)}
                          <option value={String(jumps)}>{jumps}</option>
                        {/each}
                      </select>
                    </label>
                    <label class="pi-field pi-field-qty">
                      <span>Nullsec unless poorer by %</span>
                      <input inputmode="numeric" bind:value={expTolerance} oninput={() => (expError = null)} />
                    </label>
                  </div>
                  <p class="note">
                    {freeSlots === 1 ? "1 free colony slot" : `${freeSlots} free colony slots`} across
                    {expansionRoster.pilots.filter((pilot) => pilot.freeSlots > 0).length} pilots.
                    {#if expansionRoster.unknown.length > 0}
                      {expansionRoster.unknown.length === 1 ? "1 pilot's" : `${expansionRoster.unknown.length} pilots'`} skills were not read; Refresh reads them.
                    {/if}
                  </p>
                  <div class="pi-compose-actions">
                    {#if draft && draft.rows.length > 0}
                      <button type="button" disabled={expBusy} onclick={() => void proposeNow()}>Propose again</button>
                      <button type="button" class="primary" disabled={expBusy} onclick={() => void keepDraft()}>Keep this plan</button>
                    {:else}
                      <button type="submit" class="primary" disabled={expBusy || freeSlots === 0}>{expBusy ? "Looking..." : "Propose colonies"}</button>
                    {/if}
                  </div>
                  {#if expWords}
                    <p class="note">{expWords}</p>
                  {/if}
                  {#if expError}
                    <p class="pi-plan-error" role="alert">{expError}</p>
                  {/if}
                </form>
                {#if draft && draft.rows.length > 0}
                  {@render expansionBody()}
                {:else if draft}
                  <p class="empty">Nothing in reach is left to drill for the basics that need it. Look further, or around another system.</p>
                {/if}
              {:else if planRequest === null}
                <!-- A NEW PLAN. It is kept the moment it is planned. -->
                <form
                  class="pi-compose"
                  onsubmit={(event) => {
                    event.preventDefault();
                    submitPlan();
                  }}
                >
                  <h3 class="pi-compose-title">New plan</h3>
                  <div class="pi-tiers" role="group" aria-label="Kind of plan">
                    <button type="button" class="pi-tier on" aria-pressed="true">Make a commodity</button>
                    <button type="button" class="pi-tier" aria-pressed="false" onclick={newExpansion}>Expand colonies</button>
                  </div>
                  <div class="pi-compose-row">
                    <label class="pi-field pi-field-qty">
                      <span>Make</span>
                      <input
                        id="pi-plan-quantity"
                        inputmode="numeric"
                        placeholder="20"
                        bind:value={planQuantity}
                        oninput={() => (planError = null)}
                      />
                    </label>
                    <label class="pi-field pi-field-grow">
                      <span>Commodity</span>
                      <select bind:value={planTarget} onchange={() => (planError = null)}>
                        <option value="">Choose a commodity</option>
                        {#each targetGroups as group (group.label)}
                          <optgroup label={group.label}>
                            {#each group.rows as row (row.typeID)}
                              <option value={String(row.typeID)}>{row.name}</option>
                            {/each}
                          </optgroup>
                        {/each}
                      </select>
                    </label>
                  </div>
                  <label class="pi-field">
                    <span>Note</span>
                    <input placeholder="For mining foreman boosters" maxlength="500" bind:value={planNote} />
                  </label>
                  <div class="pi-compose-actions">
                    <button type="submit" class="primary" disabled={planSaving}>Create plan</button>
                  </div>
                  {#if planError}
                    <p class="pi-plan-error" role="alert">{planError}</p>
                  {/if}
                </form>
              {:else}
                <header class="pi-detail-head">
                  <span class="pi-detail-icon">
                    <TypeIcon typeID={planRequest.typeID} name={planName(planRequest.typeID)} size="lg" />
                  </span>
                  <div class="pi-detail-title">
                    <h3>
                      {planName(planRequest.typeID)}
                      {#if recipes && tierTag(tierOf(recipes, planRequest.typeID))}
                        <span class="pi-chip">{tierTag(tierOf(recipes, planRequest.typeID))}</span>
                      {/if}
                      {#if openPlan?.status === "done"}<span class="pi-pill">done</span>{/if}
                    </h3>
                    <input
                      class="pi-detail-note"
                      aria-label="Note"
                      placeholder={openPlan ? "Add a note" : "Not saved"}
                      maxlength="500"
                      disabled={openPlan === null}
                      bind:value={planNote}
                      onchange={commitNote}
                    />
                  </div>
                  <div class="pi-detail-actions">
                    <label class="pi-detail-qty">
                      <span>Make</span>
                      <input
                        inputmode="numeric"
                        bind:value={planQuantity}
                        oninput={() => (planError = null)}
                        onchange={commitQuantity}
                        onkeydown={(event) => event.key === "Enter" && commitQuantity()}
                      />
                    </label>
                    {#if openPlan?.status === "active"}
                      <button type="button" disabled={planSaving} onclick={() => openPlan && setPlanStatus(openPlan, "done")}>Mark done</button>
                    {:else if openPlan?.status === "done"}
                      <button type="button" disabled={planSaving} onclick={() => openPlan && setPlanStatus(openPlan, "active")}>Reopen</button>
                      <button type="button" class="danger" disabled={planSaving} onclick={() => openPlan && removePlan(openPlan)}>Delete</button>
                    {/if}
                  </div>
                </header>
                {#if planError}
                  <p class="pi-plan-error" role="alert">{planError}</p>
                {/if}

                {#if plan && openCounts}
                  <div class="pi-stats" title={plan.verdict}>
                    <div class="pi-stat tone-ok">
                      <span class="pi-stat-label">Covered</span>
                      <span class="pi-stat-value">{openCounts.ok} of {openCounts.steps} steps</span>
                    </div>
                    <div class="pi-stat tone-act">
                      <span class="pi-stat-label">Can fix now</span>
                      <span class="pi-stat-value">{openCounts.act}</span>
                    </div>
                    <div class="pi-stat tone-bad">
                      <span class="pi-stat-label">Blocked</span>
                      <span class="pi-stat-value">{plan.gaps.length}</span>
                    </div>
                  </div>
                  <p class="pi-verdict">{plan.verdict}</p>

                  <!-- WHAT IS MISSING, by tier from the ground up: raw first,
                       because an extractor feeds everything above it. Blocked
                       steps lead each tier. -->
                  {#if missing.length > 0}
                    <h4 class="pi-section-title">Missing, from the ground up</h4>
                    <ul class="pi-missing" aria-label="Missing">
                      {#each missing as group (group.tier)}
                        {#each group.rows as row (row.typeID)}
                          <li class="pi-missing-row state-{row.state}">
                            <span class="pi-chip">{tierTag(group.tier) ?? "other"}</span>
                            <span class="pi-missing-name">
                              <TypeIcon typeID={row.typeID} name={row.typeName} />
                              {row.typeName}
                            </span>
                            <span class="pi-missing-count" title={`${countWords(row.held)} held of ${countWords(row.needed)}`}>{countWords(row.toMake)}</span>
                            <span class="pi-tags">
                              {#each row.tags as tag, index (index)}
                                <span class="pi-pill" class:tone-act={tag.tone === "act"} class:tone-bad={tag.tone === "bad"} title={tag.title}>{tag.text}</span>
                              {/each}
                            </span>
                          </li>
                        {/each}
                      {/each}
                    </ul>
                  {/if}

                    <!-- THE CHAIN AS A TREE. Colour, a bar and short tags say how each step
                         stands; the sentence behind a tag is its hover title. A step with
                         inputs folds; while folded, one dot per input says how that input
                         stands, so a green step hiding a red input still shows it. -->
                    {#snippet planNode(node: PlanNode)}
                      {@const row = node.row}
                      {@const open = node.children.length > 0 && isTreeOpen(node.key)}
                      <li role="treeitem" aria-selected="false" aria-expanded={node.children.length > 0 ? open : undefined}>
                        <div class="pi-node state-{row.state}">
                          {#if node.children.length > 0}
                            <button type="button" class="pi-node-name" onclick={() => toggleTree(node.key)}>
                              <span class="pi-chevron" aria-hidden="true">{open ? "v" : ">"}</span>
                              <TypeIcon typeID={row.typeID} name={row.typeName} />
                              <span>{row.typeName}</span>
                              {#if tierTag(row.tier)}<span class="pi-chip">{tierTag(row.tier)}</span>{/if}
                              {#if !open}
                                <span class="pi-dots" aria-hidden="true">
                                  {#each node.children as child (child.key)}
                                    <span class="pi-dot state-{child.worst}"></span>
                                  {/each}
                                </span>
                              {/if}
                            </button>
                          {:else}
                            <span class="pi-node-name">
                              <span class="pi-chevron" aria-hidden="true"></span>
                              <TypeIcon typeID={row.typeID} name={row.typeName} />
                              <span>{row.typeName}</span>
                              {#if tierTag(row.tier)}<span class="pi-chip">{tierTag(row.tier)}</span>{/if}
                            </span>
                          {/if}
                          <span class="pi-tags">
                            {#if node.repeat}
                              <span class="pi-tag" title="Drawn in full above">above</span>
                            {:else}
                              {#each row.tags as tag, index (index)}
                                <span class="pi-tag" class:act={tag.tone === "act"} class:bad={tag.tone === "bad"} title={tag.title}>{tag.text}</span>
                              {/each}
                            {/if}
                          </span>
                          <span class="pi-cover">
                            <span class="pi-bar" aria-hidden="true">
                              <span class="pi-bar-fill held" style:width={`${Math.min(1, row.held / row.needed) * 100}%`}></span>
                            </span>
                            <span class="pi-cover-nums">
                              {#if row.holdings.length > 0}
                                <button
                                  type="button"
                                  class="pi-held"
                                  aria-expanded={placesOpen.has(node.key)}
                                  title="Where it is"
                                  onclick={() => (placesOpen = toggleKey(placesOpen, node.key))}
                                >{countWords(row.held)}</button>
                              {:else}
                                {countWords(row.held)}
                              {/if}
                              / {countWords(row.needed)}
                            </span>
                          </span>
                        </div>
                        {#if placesOpen.has(node.key)}
                          <ul class="pi-places">
                            {#each row.holdings as holding, index (index)}
                              <li title={`${holding.ownerWords} - ${holdingAgeWords(holding, browserNowMs)}`}>
                                <span class="pi-source">{holding.source}</span>{countWords(holding.quantity)} {holding.placeWords}
                              </li>
                            {/each}
                          </ul>
                        {/if}
                        {#if open}
                          <ul class="pi-tree-kids" role="group">
                            {#each node.children as child (child.key)}
                              {@render planNode(child)}
                            {/each}
                          </ul>
                        {/if}
                      </li>
                    {/snippet}

                  <details class="pi-chain">
                    <summary>Full chain ({openCounts.steps} steps)</summary>
                    <ul class="pi-tree" role="tree" aria-label={plan.verdict}>
                      {@render planNode(plan.tree)}
                    </ul>
                  </details>
                {/if}
              {/if}
            </div>
          </div>
        {/if}
      </section>
    </div>
  </div>
</section>

<style>
  .pi-body {
    display: grid;
    grid-template-columns: 11rem minmax(0, 1fr);
    gap: 1rem;
    margin-top: 0.75rem;
  }
  .pi-menu-list {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--color-line);
    height: 100%;
  }
  /* ⚠ NOT `class:active` — a bare `button.active` is a filled accent control
   * in the app's component layer (see StationPanel's tabs). */
  .pi-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 40px;
    padding: 0 0.75rem;
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    color: var(--color-muted);
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .pi-menu-item:hover:not(.on) {
    color: var(--color-text-bright);
    background: var(--color-panel-3);
  }
  .pi-menu-item.on {
    color: var(--color-text-bright);
    border-left-color: var(--color-accent);
    background: var(--color-panel-3);
  }
  .pi-badge {
    min-width: 1.4rem;
    padding: 0 0.35rem;
    border: 1px solid var(--color-warn);
    color: var(--color-warn);
    font-size: 11px;
    text-align: center;
  }
  .pi-badge.urgent {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }
  .pi-view > :first-child,
  .pi-view > .pi-section:first-of-type {
    margin-top: 0;
  }
  .pi-link {
    background: none;
    border: 0;
    padding: 0;
    min-height: 0;
    color: var(--color-accent);
    text-decoration: underline;
    cursor: pointer;
  }
  .pi-section {
    margin-top: 0.75rem;
  }
  .pi-section h3 {
    margin: 0 0 0.35rem;
    font-size: 0.95rem;
  }
  /* ⚠ ONE FRAME, THE WINDOW'S. The app styles every `section` as a framed
   * panel, so this window came out as box in box in box. Its own sections are
   * headings and rules, not cards — the same reset StationPanel makes. A
   * scoped rule is unlayered, so it outranks the components layer outright. */
  .pi-manager,
  .pi-manager section {
    border: 0;
    background: none;
    margin: 0;
    padding: 0;
  }
  .pi-manager::before,
  .pi-manager section::before {
    content: none;
  }
  /* ⚠ THE PANEL IS ITS OWN SIZE CONTAINER, or the `@container` rules at the
     bottom never fire: nothing between here and the page is one, so a query
     finds no container and the rail stayed a rail in a 450px window. Safe to
     contain: a panel's width comes from its window, never its contents. */
  .pi-manager {
    container-type: inline-size;
  }

  .pi-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .pi-summary dt {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .pi-summary dd {
    margin: 0;
    font-size: 1.35rem;
    color: var(--color-text-bright);
    font-variant-numeric: tabular-nums;
  }
  .pi-summary dd.good {
    color: var(--color-good);
  }
  .pi-summary dd.bad {
    color: var(--color-danger);
  }

  .pi-group + .pi-group {
    margin-top: 1rem;
  }
  .pi-group-head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.25rem 1rem;
    padding: 0.35rem 0;
    border-bottom: 1px solid var(--color-line-strong);
  }
  .pi-group-head h3 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--color-text-bright);
  }
  .pi-colonies {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-colony {
    display: grid;
    grid-template-columns: minmax(11rem, 1.5fr) minmax(8rem, 1.3fr) minmax(9rem, 1.6fr) minmax(7rem, 0.9fr);
    gap: 0.5rem 1rem;
    align-items: center;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-row-line);
    border-left: 3px solid var(--color-good);
  }
  .pi-help {
    display: inline-flex;
    vertical-align: middle;
    margin-left: 0.3rem;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    min-height: 0;
    padding: 0;
    background: transparent;
    border: 1px solid var(--color-line-strong);
    border-radius: var(--radius-control);
    color: var(--color-muted);
    font-size: 11px;
    line-height: 1;
    cursor: help;
  }
  .pi-help:hover,
  .pi-help:focus-visible {
    color: var(--color-text-bright);
    border-color: var(--color-accent);
  }
  .pi-colony.tone-planned {
    border-left-color: var(--color-line-strong);
  }
  .note.good {
    color: var(--color-good);
  }
  .pi-colony.tone-soon {
    border-left-color: var(--color-warn);
  }
  .pi-colony.tone-stopped {
    border-left-color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 7%, transparent);
  }
  .pi-colony-place {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
  }
  .pi-colony-place > span:last-child {
    display: grid;
    min-width: 0;
  }
  .pi-colony-name {
    color: var(--color-text-bright);
  }
  .pi-colony-resources {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .pi-chip {
    font-size: 11px;
    padding: 0 0.4rem;
    border: 1px solid var(--color-line-strong);
    color: var(--color-cell);
    white-space: nowrap;
  }
  .pi-colony-program,
  .pi-colony-storage {
    display: grid;
    gap: 0.2rem;
    min-width: 0;
  }
  .pi-bar {
    display: block;
    height: 4px;
    background: var(--color-line);
  }
  .pi-bar-fill {
    display: block;
    height: 100%;
  }
  .pi-bar-fill.program {
    background: var(--color-good);
  }
  .pi-bar-fill.program.ended {
    background: var(--color-danger);
  }
  .pi-bar-fill.storage {
    background: var(--color-accent);
  }
  .pi-bar-fill.storage.high {
    background: var(--color-warn);
  }
  .pi-status {
    font-size: 0.85rem;
    color: var(--color-muted);
  }
  .tone-stopped .pi-status {
    color: var(--color-danger);
  }
  .tone-soon .pi-status {
    color: var(--color-warn);
  }
  .note.warn {
    color: var(--color-warn);
  }
  .pilot-note {
    flex: 1 1 100%;
  }
  /* The global .note caps a line at 68ch, which let a full-width line shrink
     and sit beside the haul buttons. A status line here is its own row. */
  .pi-group-action .pilot-note,
  .pi-group-action .pi-run-words {
    max-width: none;
  }
  /* A restart, on the pilot's colonies: its sentence, then the button. */
  .pi-group-action {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.35rem 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--color-row-line);
    border-left: 3px solid var(--color-warn);
  }
  .pi-group-action > .note:first-child {
    flex: 1 1 24rem;
  }
  /* THE PILOT LINE: one button that opens the pilot's colonies. */
  .pi-colonies-tools {
    display: flex;
    justify-content: flex-end;
    gap: 0.25rem;
    padding: 0.25rem 0;
  }
  .pi-colonies-tools button[aria-pressed="true"] {
    border-color: var(--color-accent);
    color: var(--color-accent);
  }
  .pi-pilot-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.35rem 0.75rem;
    width: 100%;
    min-height: 40px;
    padding: 0.4rem 0.75rem 0.4rem 0.5rem;
    border: 0;
    border-left: 2px solid transparent;
    border-bottom: 1px solid var(--color-row-line);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  /* The menu rail's own hover and selected surface, so the two read alike. */
  .pi-pilot-row:hover,
  .pi-pilot-row[aria-expanded="true"] {
    background: var(--color-panel-3);
  }
  .pi-pilot-row.edge-bad {
    border-left-color: var(--color-danger);
  }
  .pi-pilot-row.edge-warn {
    border-left-color: var(--color-warn);
  }
  .pi-chevron {
    width: 0;
    height: 0;
    border-top: 0.3rem solid transparent;
    border-bottom: 0.3rem solid transparent;
    border-left: 0.4rem solid var(--color-muted);
    flex: none;
  }
  .pi-chevron.open {
    transform: rotate(90deg);
  }
  .pi-pilot-id {
    display: flex;
    flex-direction: column;
    min-width: 11rem;
  }
  .pi-pilot-name {
    color: var(--color-text-bright);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: 0.85rem;
  }
  .pi-planet-strip {
    display: inline-flex;
    gap: 0.15rem;
  }
  .pi-flag {
    font-size: 0.75rem;
    padding: 0 0.35rem;
    border: 1px solid var(--color-line-strong);
    white-space: nowrap;
  }
  .pi-flag.bad {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  }
  .pi-flag.warn,
  .pi-flag.run.tone-paused {
    color: var(--color-warn);
    border-color: color-mix(in srgb, var(--color-warn) 45%, transparent);
  }
  .pi-flag.good,
  .pi-flag.run.tone-done {
    color: var(--color-good);
    border-color: color-mix(in srgb, var(--color-good) 45%, transparent);
  }
  .pi-flag.run {
    color: var(--color-accent);
    border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
  }
  .pi-flag.run.tone-stopped {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  }
  .pi-pilot-run {
    flex: 1 1 12rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .pi-pilot-run .note {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pi-pilot-fill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .pi-pilot-fill .pi-bar {
    width: 4.5rem;
  }
  .pi-pilot-body {
    border-bottom: 1px solid var(--color-line);
  }
  .pi-haul-where {
    flex: 0 1 auto;
  }
  .pi-haul-go {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
  }
  .pi-haul-settings {
    flex: 1 1 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 0.5rem;
    border: 1px solid var(--color-line);
  }
  .pi-haul-settings p {
    flex: 1 1 100%;
    margin: 0;
  }
  .pi-alert {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.4rem 0.75rem;
    margin: 0 0 0.35rem;
    border: 1px solid color-mix(in srgb, var(--color-warn) 45%, transparent);
    border-left: 3px solid var(--color-warn);
    color: var(--color-warn);
  }
  .pi-alert.tone-stopped {
    border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
    border-left-color: var(--color-danger);
    color: var(--color-danger);
  }
  .pi-banner {
    flex: 1 1 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.4rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--color-warn) 45%, transparent);
    border-left: 3px solid var(--color-warn);
  }
  .pi-mark {
    font-size: 0.75rem;
    padding: 0 0.35rem;
    border: 1px solid var(--color-line-strong);
    color: var(--color-muted);
  }
  .pi-mark.collecting {
    color: var(--color-accent);
    border-color: color-mix(in srgb, var(--color-accent) 45%, transparent);
  }
  .pi-mark.collected {
    color: var(--color-good);
    border-color: color-mix(in srgb, var(--color-good) 45%, transparent);
  }
  .pi-mark.missed {
    color: var(--color-danger);
    border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
  }
  /* COMPACT: one line per pilot, per haul line and per colony; no icons and
     no program bar. The cells are grids in Normal, so each becomes a row here. */
  .pi-group.compact .pi-pilot-row {
    min-height: 0;
    padding-top: 0.2rem;
    padding-bottom: 0.2rem;
  }
  .pi-group.compact .pi-pilot-id {
    flex-direction: row;
    align-items: baseline;
    gap: 0.6rem;
  }
  .pi-group.compact .pi-group-action {
    padding-top: 0.25rem;
    padding-bottom: 0.25rem;
  }
  .pi-group.compact .pi-group-action button {
    min-height: 0;
    padding-top: 0.1rem;
    padding-bottom: 0.1rem;
  }
  .pi-colonies.density-compact .pi-colony {
    padding-top: 0.15rem;
    padding-bottom: 0.15rem;
    row-gap: 0;
  }
  .pi-colonies.density-compact .pi-colony-place > span:last-child {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    white-space: nowrap;
    overflow: hidden;
  }
  .pi-colonies.density-compact .pi-colony-program,
  .pi-colonies.density-compact .pi-colony-storage {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .pi-colonies.density-compact .pi-colony-storage .pi-bar {
    flex: 1 1 auto;
  }
  .pi-colonies.density-compact .pi-haul-tick {
    width: 0.9rem;
    height: 0.9rem;
  }
  .pi-help-open {
    min-width: 2rem;
  }
  /* A watched run: the haul's route as stages, then what the bot is doing. */
  .pi-run {
    flex: 1 1 100%;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .pi-stages {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pi-stage {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.85rem;
    color: var(--color-muted);
  }
  .pi-stage::before {
    content: "";
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    border: 1px solid var(--color-line-strong);
  }
  .pi-stage + .pi-stage::after {
    order: -1;
    content: "";
    width: 1rem;
    height: 1px;
    margin-right: 0.15rem;
    background: var(--color-line-strong);
  }
  .pi-stage.done::before {
    background: var(--color-good);
    border-color: var(--color-good);
  }
  .pi-stage.current {
    color: var(--color-text-bright);
  }
  .pi-stage.current::before {
    background: var(--color-accent);
    border-color: var(--color-accent);
  }
  .pi-stage.stopped {
    color: var(--color-danger);
  }
  .pi-stage.stopped::before {
    background: var(--color-danger);
    border-color: var(--color-danger);
  }
  .pi-run.tone-paused .pi-stage.current::before,
  .pi-run-words.tone-paused,
  .pi-run.tone-paused .pi-run-words {
    color: var(--color-warn);
  }
  .pi-run.tone-paused .pi-stage.current::before {
    background: var(--color-warn);
    border-color: var(--color-warn);
  }
  .pi-run-words.tone-stopped,
  .pi-run.tone-stopped .pi-run-words {
    color: var(--color-danger);
  }
  .pi-run-words.tone-done,
  .pi-run.tone-done .pi-run-words {
    color: var(--color-good);
  }
  .pi-group-action button {
    min-height: 40px;
  }
  .pi-haul {
    border-left-color: var(--color-row-line);
  }
  .pi-haul-into {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .pi-haul-tick {
    width: 1.1rem;
    height: 1.1rem;
    flex: none;
  }
  .pi-footnote {
    margin-top: 1rem;
  }
  .pi-add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    max-width: 36rem;
    margin-bottom: 1rem;
  }
  .pi-add select {
    flex: 1 1 14rem;
    min-height: 40px;
  }
  .pi-add button {
    min-height: 40px;
  }
  .pi-account + .pi-account {
    margin-top: 1rem;
  }
  .pi-account h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-accent);
  }
  .pi-pilots,
  .pi-unbuilt ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-pilot {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.35rem 0 0.35rem 0.75rem;
    border-bottom: 1px solid var(--color-row-line);
  }
  .pi-pilot-who {
    display: grid;
    flex: 1 1 auto;
    min-width: 0;
  }
  .pi-pilot-name {
    color: var(--color-text-bright);
  }
  .pi-pilot-age {
    white-space: nowrap;
  }
  .pi-unbuilt {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
    padding: 0.5rem 0 0 0.75rem;
  }
  .pi-unbuilt ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .pi-tag {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding-left: 0.5rem;
    border: 1px solid var(--color-line-strong);
    background: var(--color-panel-2);
  }
  /* Quiet until pointed at: removing is rare, and never the row's point. */
  .pi-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    background: transparent;
    border: 0;
    color: var(--color-muted);
    cursor: pointer;
  }
  .pi-tag .pi-remove {
    min-width: 32px;
    min-height: 32px;
  }
  .pi-remove svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }
  .pi-remove:hover:not(:disabled) {
    color: var(--color-danger);
    background: var(--color-panel-3);
  }
  .pi-summary dd.warn {
    color: var(--color-warn);
  }
  .pi-filter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
    margin-bottom: 0.5rem;
  }
  .pi-tiers {
    display: flex;
    gap: 0.25rem;
  }
  .pi-tier {
    min-height: 32px;
    padding: 0 0.6rem;
    background: transparent;
    border: 1px solid var(--color-line);
    color: var(--color-muted);
  }
  .pi-tier.on {
    border-color: var(--color-accent);
    color: var(--color-text-bright);
  }
  .pi-search {
    margin-left: auto;
    min-height: 32px;
    flex: 0 1 14rem;
  }
  .pi-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .pi-table th,
  .pi-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--color-row-line);
    text-align: left;
    vertical-align: top;
  }
  .pi-table th {
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
    font-weight: 500;
  }
  .pi-table .num {
    text-align: right;
    white-space: nowrap;
  }
  .pi-table td.good {
    color: var(--color-good);
  }
  .pi-table td.bad {
    color: var(--color-danger);
  }
  .pi-table td.warn,
  .pi-source.warn {
    color: var(--color-warn);
  }
  .pi-tier-head th {
    padding-top: 0.75rem;
    border-bottom-color: var(--color-line-strong);
    color: var(--color-text-bright);
  }
  .pi-open {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 0;
    padding: 0;
    background: none;
    border: 0;
    color: var(--color-text-bright);
    text-align: left;
    cursor: pointer;
  }
  .pi-caret {
    display: inline-block;
    width: 0.8rem;
    color: var(--color-muted);
    font-size: 11px;
  }
  .pi-where td {
    padding-left: 2rem;
    background: var(--color-panel-3);
  }
  .pi-where ul,
  .pi-sources {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-where li {
    padding: 0.15rem 0;
    font-size: 0.85rem;
  }
  .pi-source {
    display: inline-block;
    min-width: 4rem;
    margin-right: 0.4rem;
    padding: 0 0.3rem;
    border: 1px solid var(--color-line-strong);
    font-size: 11px;
    text-align: center;
    color: var(--color-cell);
  }
  .pi-sources li {
    padding: 0.1rem 0;
  }
  /* THE PLANNER: plans on the left, the open plan on the right. Square like
   * the rest of the app (R53): every corner goes through the radius tokens. */
  .pi-planner {
    display: grid;
    grid-template-columns: minmax(13rem, 16rem) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
  }
  .pi-plans,
  .pi-plan-detail {
    background: var(--color-panel-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-frame);
  }
  .pi-plans {
    padding: 0.6rem;
  }
  .pi-plan-detail {
    padding: 1rem 1.1rem;
    min-width: 0;
  }
  .pi-plans-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .pi-plans-head h3,
  .pi-section-title,
  .pi-stat-label {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }
  .pi-new {
    min-height: 28px;
    padding: 0 0.6rem;
  }
  .pi-plans-empty {
    margin: 0.5rem 0.2rem;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .pi-plan-list {
    display: grid;
    gap: 0.3rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-plan-card {
    display: grid;
    gap: 0.45rem;
    width: 100%;
    padding: 0.5rem 0.55rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
  }
  .pi-plan-card:hover:not(.on) {
    background: var(--color-panel);
    border-color: var(--color-line);
  }
  .pi-plan-card.on {
    background: var(--color-panel-2);
    border-color: var(--color-accent-dim);
  }
  .pi-plan-card-top {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
  }
  .pi-plan-card-text {
    display: grid;
    min-width: 0;
  }
  .pi-plan-card-name {
    color: var(--color-text-bright);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pi-plan-card-sub {
    color: var(--color-muted);
    font-size: 0.8rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pi-plan-card-foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .pi-meter {
    flex: 1 1 auto;
    height: 4px;
    background: var(--color-line);
    overflow: hidden;
  }
  .pi-meter-fill {
    display: block;
    height: 100%;
    background: var(--color-good);
  }
  .pi-meter-fill.tone-act {
    background: var(--color-warn);
  }
  .pi-meter-fill.tone-bad {
    background: var(--color-danger);
  }
  .pi-plans-done {
    margin-top: 0.6rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--color-line);
  }
  .pi-plans-done summary {
    margin-bottom: 0.3rem;
    color: var(--color-muted);
    font-size: 0.85rem;
    cursor: pointer;
  }
  .pi-pill {
    display: inline-block;
    padding: 0.05rem 0.45rem;
    border: 1px solid var(--color-line-strong);
    border-radius: var(--radius-control);
    color: var(--color-cell);
    font-size: 11px;
    white-space: nowrap;
  }
  .pi-pill.tone-ok {
    border-color: color-mix(in srgb, var(--color-good) 55%, transparent);
    background: color-mix(in srgb, var(--color-good) 12%, transparent);
    color: var(--color-good);
  }
  .pi-pill.tone-act {
    border-color: color-mix(in srgb, var(--color-warn) 55%, transparent);
    background: color-mix(in srgb, var(--color-warn) 12%, transparent);
    color: var(--color-warn);
  }
  .pi-pill.tone-bad {
    border-color: color-mix(in srgb, var(--color-danger) 55%, transparent);
    background: color-mix(in srgb, var(--color-danger) 12%, transparent);
    color: var(--color-danger);
  }

  /* A new plan. */
  .pi-compose {
    display: grid;
    gap: 0.75rem;
    max-width: 40rem;
  }
  .pi-compose-title {
    margin: 0;
    font-size: 1.05rem;
    color: var(--color-text-bright);
  }
  .pi-compose-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .pi-field {
    display: grid;
    gap: 0.25rem;
    color: var(--color-muted);
    font-size: 0.8rem;
  }
  .pi-field input,
  .pi-field select {
    min-height: 38px;
  }
  .pi-field-qty input {
    width: 6rem;
  }
  .pi-field-grow {
    flex: 1 1 16rem;
  }
  .pi-compose-actions {
    display: flex;
    justify-content: flex-end;
  }
  .pi-plan-error {
    margin: 0.35rem 0 0;
    color: var(--color-danger);
    font-size: 0.85rem;
  }

  /* The open plan. */
  .pi-detail-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.9rem;
  }
  .pi-detail-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.25rem;
    height: 3.25rem;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line);
  }
  .pi-detail-title {
    display: grid;
    flex: 1 1 14rem;
    gap: 0.2rem;
    min-width: 0;
  }
  .pi-detail-title h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 1.2rem;
    font-weight: 500;
    color: var(--color-text-bright);
  }
  .pi-detail-note {
    min-height: 28px;
    padding: 0 0.3rem;
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .pi-detail-note:hover:not(:disabled),
  .pi-detail-note:focus {
    border-color: var(--color-line-strong);
    background: var(--color-field);
    color: var(--color-text);
  }
  .pi-detail-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .pi-detail-actions button {
    min-height: 34px;
  }
  .pi-detail-qty {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .pi-detail-qty input {
    width: 5.5rem;
    min-height: 34px;
  }
  .pi-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.6rem;
    margin: 1rem 0 0.4rem;
  }
  .pi-stat {
    display: grid;
    gap: 0.2rem;
    padding: 0.55rem 0.75rem;
    background: var(--color-panel);
    border: 1px solid var(--color-line);
    border-top-width: 2px;
  }
  .pi-stat.tone-ok {
    border-top-color: var(--color-good);
  }
  .pi-stat.tone-act {
    border-top-color: var(--color-warn);
  }
  .pi-stat.tone-bad {
    border-top-color: var(--color-danger);
  }
  .pi-stat-value {
    font-size: 1.15rem;
    color: var(--color-text-bright);
  }
  .pi-verdict {
    margin: 0 0 1rem;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .pi-section-title {
    margin-bottom: 0.35rem;
  }
  .pi-missing {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
  }
  .pi-missing-row {
    display: grid;
    grid-template-columns: 3rem minmax(9rem, 16rem) 6rem minmax(0, 1fr);
    gap: 0.6rem;
    align-items: center;
    min-height: 36px;
    padding: 0.2rem 0.6rem;
    border-top: 1px solid var(--color-line);
    border-left: 3px solid var(--color-good);
  }
  .pi-missing-row.state-act {
    border-left-color: var(--color-warn);
  }
  .pi-missing-row.state-bad {
    border-left-color: var(--color-danger);
  }
  .pi-missing-row .pi-chip {
    justify-self: start;
  }
  .pi-missing-name {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--color-text-bright);
  }
  .pi-missing-count {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }
  .pi-chain summary {
    color: var(--color-muted);
    cursor: pointer;
    margin-bottom: 0.5rem;
  }
  @media (max-width: 760px) {
    .pi-planner {
      grid-template-columns: minmax(0, 1fr);
    }
    .pi-missing-row {
      grid-template-columns: 2.6rem minmax(0, 1fr) auto;
    }
    .pi-missing-row .pi-tags {
      grid-column: 2 / -1;
    }
  }
  .pi-tree,
  .pi-tree-kids,
  .pi-places {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .pi-tree-kids {
    margin-left: 0.9rem;
    padding-left: 0.8rem;
    border-left: 1px dashed var(--color-line-strong);
  }
  .pi-node {
    display: grid;
    grid-template-columns: minmax(12rem, 1.2fr) minmax(0, 1.4fr) 9rem;
    gap: 0.75rem;
    align-items: center;
    margin: 0.3rem 0;
    padding: 0.4rem 0.6rem;
    background: var(--color-panel-3);
    border-left: 3px solid var(--color-good);
  }
  .pi-node.state-act {
    border-left-color: var(--color-warn);
  }
  .pi-node.state-bad {
    border-left-color: var(--color-danger);
  }
  .pi-node-name {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    min-height: 0;
    padding: 0;
    background: none;
    border: 0;
    color: var(--color-text-bright);
    text-align: left;
  }
  button.pi-node-name {
    cursor: pointer;
  }
  .pi-chevron {
    display: inline-block;
    width: 0.8rem;
    color: var(--color-muted);
    font-size: 11px;
  }
  .pi-dots {
    display: inline-flex;
    gap: 3px;
    margin-left: 0.2rem;
  }
  .pi-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-good);
  }
  .pi-dot.state-act {
    background: var(--color-warn);
  }
  .pi-dot.state-bad {
    background: var(--color-danger);
  }
  .pi-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .pi-tag {
    font-size: 11px;
    padding: 0 0.4rem;
    border: 1px solid var(--color-line-strong);
    color: var(--color-cell);
    white-space: nowrap;
  }
  .pi-tag.act {
    border-color: var(--color-warn);
    color: var(--color-warn);
  }
  .pi-tag.bad {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }
  .pi-tag.ok {
    border-color: var(--color-good);
    color: var(--color-good);
  }
  .pi-cover {
    display: grid;
    gap: 0.2rem;
  }
  .pi-bar-fill.held {
    background: var(--color-good);
  }
  .pi-cover-nums {
    font-size: 11px;
    color: var(--color-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .pi-held {
    min-height: 0;
    padding: 0;
    background: none;
    border: 0;
    color: var(--color-text-bright);
    font: inherit;
    text-decoration: underline dotted;
    cursor: pointer;
  }
  .pi-places {
    margin: 0 0 0.3rem 2.2rem;
    font-size: 0.85rem;
  }
  .pi-places li {
    padding: 0.1rem 0;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @container (max-width: 640px) {
    .pi-add button {
      width: 100%;
    }
    /* Too narrow for a rail: the menu becomes a row across the top. */
    .pi-body {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.5rem;
    }
    .pi-menu-list {
      flex-direction: row;
      flex-wrap: wrap;
      border-right: 0;
      border-bottom: 1px solid var(--color-line);
    }
    .pi-menu-item {
      border-left: 0;
      border-bottom: 2px solid transparent;
    }
    .pi-menu-item.on {
      border-bottom-color: var(--color-accent);
    }
    .pi-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .pi-search {
      margin-left: 0;
      flex: 1 1 100%;
    }
    .pi-node {
      grid-template-columns: minmax(0, 1fr);
    }
    /* A colony becomes a small card: place and resources, then the bars. */
    .pi-colony {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
