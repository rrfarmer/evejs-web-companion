<script lang="ts">
  // INDUSTRY MANAGER (R109 slices 2 and 3): choose a blueprint, owned by a
  // pilot or any at all, see everything it takes to build, and keep it as a
  // plan. Option C of the 2026-10-01 mockups: the left column holds your
  // plans and the blueprints to start one from, as two tabs; the right side is
  // only the plan.
  //
  // ⚠ A GLOBAL WINDOW WITH NO STORE, like Planetary Industry. A plan spans
  // every signed-in pilot's blueprints, so it reads each pilot's own industry
  // read on that pilot's own session and takes neither store nor flow.
  //
  // ⚠ NOTHING HERE SELECTS A PILOT. The blueprint list is each already-online
  // pilot's industry read. Plans and recipes are asked through an online
  // pilot's session, or, with nobody online, a throwaway sign-in of a hangar
  // account (app/industryPlans.ts), exactly as PI's saved plans are.
  //
  // ⚠ A PLAN IS INTENT. The server keeps the product, the runs, the note and
  // the choices; every number on screen is worked again by
  // bridge/industryChain.ts each time, so a plan reopened next week is never
  // a week stale.
  import { onMount, untrack } from "svelte";
  import type { Session } from "../app/sessions.ts";
  import type { ApiOptions } from "../app/api.ts";
  import {
    getIndustryInventionTerms,
    getIndustryRecipeClosure,
    listActiveServerBots,
    loadSystemGraph,
    searchIndustryBlueprints,
  } from "../app/api.ts";
  import {
    chanceWords,
    decodeInventionTerms,
    decryptorEffectWords,
    inventionShortfalls,
    NO_INVENTION_TERMS,
    planInventions,
    type DecryptorTerms,
    type Inventor,
    type InventionTerms,
  } from "../bridge/industryInvention.ts";
  import { readIndustryStock, type IndustryStock } from "../app/industryStockRead.ts";
  import type { OnlinePilot } from "../app/piCorpRead.ts";
  import { installTarget } from "../app/industryInstallTarget.ts";
  import {
    installBlockWords,
    installCheck,
    inventionCheck,
    jobSupply,
    plannedCopies,
    startNext,
    type InstallCheck,
    type InstallPilot,
  } from "../bridge/industryJobs.ts";
  import { buildSystemGraph, distancesFrom, type SystemGraph } from "../nav/routeSolver.ts";
  import type { TabID } from "./tabs.ts";
  import { loadKnownCharacters } from "../app/knownCharacters.ts";
  import {
    askAsAnyone,
    createIndustryPlan,
    deleteIndustryPlan,
    loadIndustryPlans,
    NO_CHOICES,
    resolverChoices,
    updateIndustryPlan,
    withBuying,
    withDecryptor,
    withFacility,
    withIndustryPlan,
    withoutIndustryPlan,
    type IndustryAskers,
    type IndustryPlanChoices,
    type IndustryPlanFields,
    type SavedIndustryPlan,
  } from "../app/industryPlans.ts";
  import {
    loadIndustryPlanView,
    pruneIndustryPlanView,
    saveIndustryPlanView,
    withFolds,
    withOpenIndustryPlan,
    type IndustryPlanView,
  } from "../app/industryPlanView.ts";
  import {
    decodeBlueprintSearch,
    decodeRecipeClosure,
    type IndustryBlueprintMatch,
    type IndustryRecipe,
    type IndustryRecipeBook,
  } from "../bridge/industryRecipes.ts";
  import {
    resolveIndustryChain,
    shortLines,
    type IndustryLine,
    type IndustryNode,
  } from "../bridge/industryChain.ts";
  import {
    groupOwned,
    groupWords,
    ownedBlueprints,
    ownedTerms,
    type OwnedBlueprint,
    ownedWords,
    type PilotBlueprintRead,
  } from "../bridge/industryOwned.ts";
  import { countWords, type Holding } from "../bridge/piStock.ts";
  import {
    heldByType,
    holdingsByType,
    multibuyText,
    planStanding,
    staleWords,
    type PlanStanding,
  } from "../bridge/industryStock.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import { formatDuration } from "../bridge/industry.ts";
  import { characterTimeMultiplier, facilityMultiplier, jobSeconds, type JobPlace } from "../bridge/industryFacility.ts";
  import { resolvedName } from "../store/names.ts";
  import type { IndustryFacilityRow } from "../store/types.ts";

  let {
    sessions = [],
    onOpen,
  }: {
    sessions?: readonly Session[];
    /** Open a per-pilot panel on that pilot's workspace (the Industry panel, to start a job). */
    onOpen?: (tab: TabID, sessionID?: string) => void;
  } = $props();

  // The left column's two views (option C, 2026-10-01): your saved plans, or
  // the blueprints to start one from. The right side is only ever the plan.
  type LeftTab = "plans" | "blueprints";
  let leftTab = $state<LeftTab>("plans");
  // Sessions already asked for their blueprints and skills, so a pilot coming
  // online is read once and not on every store change after.
  const askedSessions = new Set<string>();

  // Bumped whenever a pilot's store moves, so the owned list re-reads.
  let storeTick = $state(0);
  let refreshing = $state(false);

  // The "Any" search.
  let query = $state("");
  let searching = $state(false);
  let searchError = $state<string | null>(null);
  let matches = $state<readonly IndustryBlueprintMatch[]>([]);
  let searchTotal = $state(0);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let searchSerial = 0;

  // Saved plans, and the one open. `openPlan === null` with a target set is a
  // new plan not saved yet.
  let plans = $state<SavedIndustryPlan[]>([]);
  let plansLoaded = $state(false);
  let plansError = $state<string | null>(null);
  let openPlanID = $state<string | null>(null);
  let planError = $state<string | null>(null);
  let planSaving = $state(false);
  let view = $state<IndustryPlanView>(loadIndustryPlanView());

  // What is on the right: a product, runs, choices and a note. For a saved
  // plan these mirror it and every change is saved; for a new one they are a
  // draft until Save.
  let productTypeID = $state<number | null>(null);
  let draftName = $state<string | null>(null);
  let runsText = $state("1");
  let choices = $state<IndustryPlanChoices>(NO_CHOICES);
  let noteText = $state("");

  // What the pilots and their corporations hold of every type any open book
  // names (R109 slice 4). Read when the window opens, when a new book brings
  // types the last read did not ask about, and on Refresh; never on a timer.
  let stock = $state<IndustryStock | null>(null);
  let stockReading = $state(false);
  let stockAsked = new Set<number>();
  let stockTimer: ReturnType<typeof setTimeout> | null = null;
  let browserNowMs = $state(Date.now());
  let copied = $state<string | null>(null);
  let placesOpen = $state<Set<number>>(new Set());

  // Invention odds (R109 slice 6): static terms, read once per open window.
  let inventionTerms = $state<InventionTerms>(NO_INVENTION_TERMS);

  // Recipe books, one per product, read once per open window.
  let books = $state<Map<number, IndustryRecipeBook>>(new Map());
  let bookErrors = $state<Map<number, string>>(new Map());
  const booksAsked = new Set<number>();

  /** Pilots online in this tab, each with its own session. */
  function onlineSessions(): { session: Session; characterID: number; characterName: string }[] {
    const online: { session: Session; characterID: number; characterName: string }[] = [];
    for (const session of sessions) {
      const character = session.store.station.get().online;
      if (character) {
        online.push({ session, characterID: character.characterID, characterName: character.characterName });
      }
    }
    return online;
  }

  /** Who may be asked for plans and recipes: online pilots, then hangar accounts. */
  function askers(): IndustryAskers {
    return {
      online: onlineSessions().map(({ session }) => session.flow.requestOptions()),
      accounts: loadKnownCharacters().map((pilot) => pilot.accountName),
    };
  }

  function ask<T>(call: (options: ApiOptions) => Promise<T>): Promise<T> {
    return askAsAnyone(askers(), call);
  }

  const reads = $derived.by((): PilotBlueprintRead[] => {
    void storeTick;
    return onlineSessions().map(({ session, characterID, characterName }) => {
      const industry = session.store.industry.get();
      return { characterID, characterName, blueprints: industry.blueprints, definitions: industry.definitions };
    });
  });
  const onlineCount = $derived(reads.length);
  /** An online pilot whose blueprints have not been read yet: never say "none" for them. */
  const unreadOnline = $derived.by(() => {
    void storeTick;
    return onlineSessions().some(({ session }) => !session.store.industry.get().loaded);
  });
  const owned = $derived(ownedBlueprints(reads));
  const held = $derived(heldByType(stock?.holdings ?? []));
  /** Every online pilot's jobs, as their own industry read holds them. */
  const jobLists = $derived.by(() => {
    void storeTick;
    return onlineSessions().map(({ session }) => session.store.industry.get().jobs);
  });
  /**
   * What the handoff checks about each online pilot: where it is, its skills,
   * the facilities its own industry read offers, and its stock with places.
   */
  const installPilots = $derived.by(() => {
    void storeTick;
    const pilots = new Map<number, InstallPilot>();
    for (const { session, characterID, characterName } of onlineSessions()) {
      const online = session.store.station.get().online;
      const skills = session.store.skills.get().skills;
      pilots.set(characterID, {
        characterName,
        solarSystemID: online?.solarSystemID ?? null,
        dockedAt: online?.stationID ?? online?.structureID ?? null,
        skills: skills === null ? null : new Map(skills.map((skill) => [skill.typeID, skill.level])),
        facilities: new Map(session.store.industry.get().facilities.map((facility) => [
          facility.facilityID,
          { solarSystemID: facility.solarSystemID, activities: new Set<string>(facility.activities) },
        ])),
        stock: stock?.hangars.get(characterID) ?? null,
      });
    }
    return pilots;
  });
  // The stargate graph, for how far a facility is: the same one the server
  // counts jumps over. Read once per open window; static data.
  let systemGraph = $state<SystemGraph | null>(null);
  const jumpCache = new Map<number, Map<number, number>>();
  function jumpsBetween(fromSystemID: number, toSystemID: number): number | null {
    if (fromSystemID === toSystemID) return 0;
    if (systemGraph === null) return null;
    let distances = jumpCache.get(fromSystemID);
    if (!distances) {
      distances = distancesFrom(systemGraph, fromSystemID);
      jumpCache.set(fromSystemID, distances);
    }
    return distances.get(toSystemID) ?? null;
  }
  /** Blueprint types that are reaction formulas, for which range skill applies. */
  const reactionBlueprints = $derived.by(() => {
    const found = new Set<number>();
    for (const known of books.values()) {
      for (const recipe of known.byProduct.values()) {
        if (recipe.activity === "reaction") found.add(recipe.blueprintTypeID);
      }
    }
    return found;
  });
  /**
   * Per blueprint, the copy a job would run from (bridge/industryJobs.ts
   * plannedCopies): the plan's materials are worked out at its efficiencies.
   */
  const planned = $derived(plannedCopies(owned, installPilots, jumpsBetween, reactionBlueprints));
  const terms = $derived(ownedTerms([...planned.values()].map((entry) => entry.copy)));
  /** The copy a line's job would run from, or null when none is owned. */
  function plannedFor(line: IndustryLine): OwnedBlueprint | null {
    const blueprintTypeID = line.blueprint?.blueprintTypeID;
    return blueprintTypeID === undefined ? null : planned.get(blueprintTypeID)?.copy ?? null;
  }
  // --- Where each job runs (bridge/industryFacility.ts) -----------------------
  // A job runs where its copy sits when an owned copy is in reach (the server
  // installs it nowhere else); otherwise at the plan's "Build at" facility for
  // that work, if one is chosen and an online pilot's read lists it. Its
  // materials and time take that facility's modifiers; its time the skills of
  // the copy's holder, or of the online pilot who would run it fastest.

  /** Every facility an online pilot's industry read lists, with its modifiers. */
  const facilityRows = $derived.by(() => {
    void storeTick;
    const rows = new Map<number, IndustryFacilityRow>();
    for (const { session } of onlineSessions()) {
      for (const facility of session.store.industry.get().facilities) {
        if (!rows.has(facility.facilityID)) rows.set(facility.facilityID, facility);
      }
    }
    return rows;
  });

  /** A facility's name, from any online pilot's names (its Industry read asks for them). */
  function facilityName(facilityID: number): string {
    for (const { session } of onlineSessions()) {
      const name = resolvedName(session.store.names.get().resolved, "station", facilityID, "");
      if (name) return name;
    }
    return "An unnamed facility";
  }

  /** Facilities online pilots can pick for the work, by name. */
  function buildAtChoices(activity: "manufacturing" | "reaction"): IndustryFacilityRow[] {
    return [...facilityRows.values()]
      .filter((facility) => facility.online && facility.activities.includes(activity))
      .sort((a, b) => facilityName(a.facilityID).localeCompare(facilityName(b.facilityID)));
  }

  /** The online pilot whose skills run the work fastest, or null when no skills are read. */
  function fastestPilot(activity: "manufacturing" | "reaction"): { name: string; skills: ReadonlyMap<number, number> } | null {
    let best: { name: string; skills: ReadonlyMap<number, number>; multiplier: number } | null = null;
    for (const pilot of installPilots.values()) {
      if (pilot.skills === null) continue;
      const multiplier = characterTimeMultiplier(activity, pilot.skills);
      if (best === null || multiplier < best.multiplier) best = { name: pilot.characterName, skills: pilot.skills, multiplier };
    }
    return best;
  }

  interface LinePlace {
    readonly facilityID: number | null;
    /** "copy": where the owned copy is; "chosen": the plan's Build at; "none". */
    readonly source: "copy" | "chosen" | "none";
    /** A Build at choice no online pilot's read lists now. */
    readonly chosenAway: boolean;
    readonly pilotName: string | null;
    readonly place: JobPlace;
  }

  function placeOf(recipe: IndustryRecipe, from: IndustryPlanChoices): LinePlace {
    const activity = recipe.activity;
    const copy = planned.get(recipe.blueprintTypeID);
    if (copy?.inReach && copy.copy.facilityID !== null) {
      const row = facilityRows.get(copy.copy.facilityID);
      return {
        facilityID: copy.copy.facilityID,
        source: "copy",
        chosenAway: false,
        pilotName: copy.copy.characterName,
        place: {
          time: row?.modifiers[activity]?.time ?? [],
          material: row?.modifiers[activity]?.material ?? [],
          skills: installPilots.get(copy.copy.characterID)?.skills ?? null,
        },
      };
    }
    const fastest = fastestPilot(activity);
    const chosenID = from.facilities?.[activity] ?? null;
    const row = chosenID === null ? undefined : facilityRows.get(chosenID);
    if (row && row.activities.includes(activity)) {
      return {
        facilityID: row.facilityID,
        source: "chosen",
        chosenAway: false,
        pilotName: fastest?.name ?? null,
        place: { time: row.modifiers[activity]?.time ?? [], material: row.modifiers[activity]?.material ?? [], skills: fastest?.skills ?? null },
      };
    }
    return {
      facilityID: null,
      source: "none",
      chosenAway: chosenID !== null,
      pilotName: fastest?.name ?? null,
      place: { time: [], material: [], skills: fastest?.skills ?? null },
    };
  }

  /** Per blueprint: the material multiplier of the facility its job runs in. */
  function materialModifiersFor(forBook: IndustryRecipeBook, from: IndustryPlanChoices): Map<number, number> {
    const modifiers = new Map<number, number>();
    for (const recipe of forBook.byProduct.values()) {
      const multiplier = facilityMultiplier(placeOf(recipe, from).place.material, forBook.types.get(recipe.productTypeID) ?? null);
      if (multiplier !== 1) modifiers.set(recipe.blueprintTypeID, multiplier);
    }
    return modifiers;
  }

  /** "2 hours 10 minutes", or "3 jobs, up to 1 hour": how long a line's jobs take. */
  function lineTimeWords(line: IndustryLine): string | null {
    const recipe = line.recipe;
    if (!book || !recipe || line.obtain === "buy" || line.jobRuns.length === 0) return null;
    const where = placeOf(recipe, choices);
    const product = book.types.get(recipe.productTypeID) ?? null;
    const each = line.jobRuns.map((jobRunCount) =>
      jobSeconds(recipe, jobRunCount, line.blueprint?.timeEfficiency ?? 0, where.place, product, book!.skillTimePercent));
    if (each.some((seconds) => seconds === null)) return null;
    const longest = Math.max(...(each as number[]));
    return line.jobRuns.length === 1 ? formatDuration(longest) : `${line.jobRuns.length} jobs, up to ${formatDuration(longest)}`;
  }

  /** What a line's time is worked with, for its tooltip. */
  function lineTimeTitle(line: IndustryLine): string {
    if (!line.recipe) return "";
    const where = placeOf(line.recipe, choices);
    const at = where.source === "copy"
      ? `At ${facilityName(where.facilityID!)}, where the copy is`
      : where.source === "chosen" ? `At ${facilityName(where.facilityID!)}` : "No facility chosen";
    const who = where.pilotName ? `, with ${where.pilotName}'s skills` : ", with no pilot's skills known";
    return `${at}${who}. An estimate: the server works the time out when the job starts.`;
  }

  /** Online pilots whose trained skills are known, for invention odds. */
  const inventors = $derived.by((): Inventor[] => {
    void storeTick;
    const list: Inventor[] = [];
    for (const { session, characterName } of onlineSessions()) {
      const skills = session.store.skills.get().skills;
      if (skills === null) continue;
      list.push({ name: characterName, skills: new Map(skills.map((skill) => [skill.typeID, skill.level])) });
    }
    return list;
  });
  const places = $derived(holdingsByType(stock?.holdings ?? []));

  const openPlan = $derived(plans.find((entry) => entry.planID === openPlanID) ?? null);
  const activePlans = $derived(plans.filter((entry) => entry.status === "active"));
  const donePlans = $derived(plans.filter((entry) => entry.status === "done"));

  const runs = $derived.by((): number | null => {
    const value = Number(runsText.trim());
    return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value : null;
  });
  const book = $derived(productTypeID === null ? null : books.get(productTypeID) ?? null);
  const bookError = $derived(productTypeID === null ? null : bookErrors.get(productTypeID) ?? null);

  const supply = $derived(jobSupply(jobLists, book));
  const chain = $derived.by(() => {
    if (productTypeID === null || book === null || runs === null) {
      return null;
    }
    return resolveIndustryChain({
      book,
      productTypeID,
      runs,
      choices: { ...resolverChoices(choices, terms, inventionTerms.decryptors), materialModifiers: materialModifiersFor(book, choices) },
      held,
      inProduction: supply.inProduction,
    });
  });
  const inventions = $derived(
    chain ? planInventions(chain, (blueprintTypeID) => decryptorOf(choices, blueprintTypeID), inventors, inventionTerms, supply.inventing) : [],
  );
  const inventionShort = $derived(inventionShortfalls(inventions, held, nameAnywhere));
  /** Everything to acquire: bought items and invention inputs, for Missing and multibuy. */
  // Lazy: toBuy is declared further down.
  const missingCount = $derived.by(() => toBuy.length + inventionShort.length);
  const startGroups = $derived(chain ? startNext(chain) : []);
  const allRunning = $derived.by(() => {
    if (!chain || productTypeID === null) return false;
    const top = chain.lines.get(productTypeID);
    return top !== undefined && top.short === 0 && top.inProduction > 0;
  });
  const standing = $derived(chain ? planStanding(chain) : null);
  const stale = $derived(stock ? staleWords(stock.holdings, browserNowMs) : null);
  const pilotProblems = $derived(stock ? stock.pilots.filter((pilot) => pilot.state !== "read") : []);
  const corpProblems = $derived(stock ? stock.corps.filter((corp) => corp.state !== "read") : []);
  /** Each saved plan's standing, for its card. Null until its book and the stock are in. */
  const cardStandings = $derived.by(() => {
    const standings = new Map<string, PlanStanding>();
    if (stock === null) return standings;
    for (const entry of plans) {
      const entryBook = books.get(entry.productTypeID);
      if (!entryBook) continue;
      const entrySupply = jobSupply(jobLists, entryBook);
      const entryChain = resolveIndustryChain({
        book: entryBook,
        productTypeID: entry.productTypeID,
        runs: entry.runs,
        choices: { ...resolverChoices(entry.choices, terms, inventionTerms.decryptors), materialModifiers: materialModifiersFor(entryBook, entry.choices) },
        held,
        inProduction: entrySupply.inProduction,
      });
      if (!entryChain) continue;
      const base = planStanding(entryChain);
      const short = inventionShortfalls(
        planInventions(entryChain, (blueprintTypeID) => decryptorOf(entry.choices, blueprintTypeID), inventors, inventionTerms, entrySupply.inventing),
        held,
        nameAnywhere,
      ).length;
      const missing = base.missing + short;
      const buys = base.buys + short;
      standings.set(entry.planID, missing === base.missing ? base : {
        missing,
        buys,
        share: buys === 0 ? 1 : (buys - missing) / buys,
        tone: (buys - missing) / buys >= 0.5 ? "act" : "bad",
        words: `${missing} missing`,
      });
    }
    return standings;
  });
  const toBuy = $derived(chain ? shortLines(chain).filter((line) => line.obtain === "buy") : []);
  const jobCount = $derived(
    chain ? [...chain.lines.values()].reduce((sum, line) => sum + line.jobRuns.length, 0) : 0,
  );
  const productName = $derived(productTypeID === null ? null : nameFor(productTypeID) ?? draftName);
  const folds = $derived(openPlanID === null ? {} : view.folds[openPlanID] ?? {});
  let draftFolds = $state<Record<string, boolean>>({});
  /** One row per owned blueprint, however many copies (bridge/industryOwned.ts). */
  const ownedGroups = $derived(groupOwned(owned));
  /** Those whose name holds the filter text. */
  const ownedShown = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    // The name as listed, without the " Blueprint" every one carries: matched
    // against it, "ri" kept them all.
    return needle.length === 0
      ? ownedGroups
      : ownedGroups.filter((group) => (group.blueprintName ?? "").replace(/ Blueprint$/, "").toLowerCase().includes(needle));
  });
  /**
   * The plan's terms in one line: which blueprint it is planned with, at what
   * efficiencies, held by whom. Where it is built follows (facilityWords).
   */
  const termsWords = $derived.by((): string | null => {
    if (!chain || productTypeID === null) return null;
    const top = chain.lines.get(productTypeID)?.blueprint;
    if (!top) return null;
    const efficiencies = `material ${top.materialEfficiency}%, time ${top.timeEfficiency}%`;
    if (!top.assumed) {
      const copy = planned.get(top.blueprintTypeID)?.copy;
      return copy ? `${ownedWords(copy).split(" - ")[0]} - ${efficiencies} - ${copy.characterName}` : `Owned - ${efficiencies}`;
    }
    return top.invention ? `Invented copy - ${efficiencies}` : `No owned blueprint - assumed ${efficiencies}`;
  });

  /** Where the top job is built, in words: its facility, or that none is counted. */
  const facilityWords = $derived.by((): string => {
    if (!chain || productTypeID === null) return "";
    const recipe = chain.lines.get(productTypeID)?.recipe;
    if (!recipe) return "";
    const where = placeOf(recipe, choices);
    if (where.source === "copy") return `at ${facilityName(where.facilityID!)}, where the copy is`;
    if (where.source === "chosen") return `built at ${facilityName(where.facilityID!)}`;
    return where.chosenAway ? "the chosen facility is out of reach - no facility bonus counted" : "no facility chosen - no bonus counted";
  });
  /** The kinds of work this plan has lines for, for its Build at choices. */
  const planWork = $derived.by((): ("manufacturing" | "reaction")[] => {
    if (!chain) return [];
    const kinds = new Set<"manufacturing" | "reaction">();
    for (const line of chain.lines.values()) {
      if (line.obtain === "build") kinds.add("manufacturing");
      if (line.obtain === "react") kinds.add("reaction");
    }
    return (["manufacturing", "reaction"] as const).filter((kind) => kinds.has(kind));
  });

  function setBuildAt(activity: "manufacturing" | "reaction", value: string): void {
    const facilityID = Number(value);
    choices = withFacility(choices, activity, Number.isSafeInteger(facilityID) && facilityID > 0 ? facilityID : null);
    if (openPlan) {
      void save({ choices });
    }
  }

  /** The decryptor chosen for a T2 blueprint in these choices, or null. */
  function decryptorOf(from: IndustryPlanChoices, blueprintTypeID: number): DecryptorTerms | null {
    const decryptorTypeID = from.decryptors?.[String(blueprintTypeID)];
    return decryptorTypeID === undefined ? null : inventionTerms.decryptors.get(decryptorTypeID) ?? null;
  }

  /** Any type's name: a recipe book's, or a decryptor's. */
  function nameAnywhere(typeID: number): string | null {
    return nameFor(typeID) ?? inventionTerms.decryptors.get(typeID)?.name ?? null;
  }

  function setDecryptor(blueprintTypeID: number, value: string): void {
    const decryptorTypeID = Number(value);
    choices = withDecryptor(choices, blueprintTypeID, Number.isSafeInteger(decryptorTypeID) && decryptorTypeID > 0 ? decryptorTypeID : null);
    if (openPlan) {
      void save({ choices });
    }
  }

  async function loadInventionTerms(): Promise<void> {
    try {
      const decoded = decodeInventionTerms(await ask((options) => getIndustryInventionTerms(options)));
      if (decoded.readable) inventionTerms = decoded;
    } catch {
      // Without them, invented copies are still counted; odds wait for the next open.
    }
  }

  /** A product's name from whichever recipe book has it. */
  function nameFor(typeID: number): string | null {
    for (const candidate of books.values()) {
      const name = candidate.types.get(typeID)?.name;
      if (name) return name;
    }
    return null;
  }

  function lineName(line: IndustryLine): string {
    return line.name ?? "An unnamed item";
  }

  function planTitle(entry: SavedIndustryPlan): string {
    return nameFor(entry.productTypeID) ?? "A plan";
  }

  // --- reads ------------------------------------------------------------------

  async function refreshOwned(): Promise<void> {
    const online = onlineSessions();
    if (online.length === 0) {
      return;
    }
    refreshing = true;
    try {
      // Each pilot's own read, on its own session. One failing does not stop
      // the others; its blueprints simply stay as they were.
      await Promise.allSettled(online.map(({ session }) => session.flow.loadIndustry()));
    } finally {
      refreshing = false;
      storeTick += 1;
    }
  }

  async function loadBook(typeID: number): Promise<void> {
    if (booksAsked.has(typeID)) {
      return;
    }
    booksAsked.add(typeID);
    try {
      const decoded = decodeRecipeClosure(await ask((options) => getIndustryRecipeClosure([typeID], options)));
      if (!decoded.readable) {
        throw new Error("unreadable");
      }
      books = new Map(books).set(typeID, decoded);
    } catch {
      // Asked again on the next open of this product.
      booksAsked.delete(typeID);
      bookErrors = new Map(bookErrors).set(typeID, "The recipes could not be read just now.");
    }
  }

  /** Pilots online in this tab, as the corp read needs them. */
  function onlinePilots(): OnlinePilot[] {
    return onlineSessions().map(({ session, characterID }) => ({
      characterID,
      corporationID: session.store.station.get().online?.corporationID ?? null,
      options: session.flow.requestOptions(),
    }));
  }

  /** Every type any recipe book open in this window names. */
  function bookTypes(): number[] {
    const types = new Set<number>();
    for (const entry of books.values()) {
      for (const typeID of entry.types.keys()) types.add(typeID);
      for (const typeID of entry.byProduct.keys()) types.add(typeID);
    }
    for (const typeID of inventionTerms.decryptors.keys()) types.add(typeID);
    return [...types];
  }

  async function readStock(): Promise<void> {
    const types = bookTypes();
    if (types.length === 0 || stockReading) return;
    stockReading = true;
    try {
      let botCharacterIDs = new Set<number>();
      try {
        botCharacterIDs = new Set((await listActiveServerBots()).map((bot) => bot.characterID));
      } catch {
        // Without the list, a corp with nobody online here says so; it is not guessed.
      }
      stock = await readIndustryStock({
        pilots: loadKnownCharacters().map((pilot) => ({
          characterID: pilot.characterID,
          characterName: pilot.characterName,
          accountName: pilot.accountName,
        })),
        typeIDs: types,
        online: onlinePilots(),
        botCharacterIDs,
      });
      stockAsked = new Set(types);
      browserNowMs = Date.now();
    } finally {
      stockReading = false;
    }
  }

  /** Read again only when a book brought types the last read did not ask about. */
  function stockWhenNeeded(): void {
    if (stockTimer !== null) clearTimeout(stockTimer);
    stockTimer = setTimeout(() => {
      stockTimer = null;
      if (bookTypes().some((typeID) => !stockAsked.has(typeID))) void readStock();
    }, 400);
  }

  async function copyMultibuy(): Promise<void> {
    const { text, unnamed } = multibuyText([...toBuy, ...inventionShort]);
    try {
      await navigator.clipboard.writeText(text);
      copied = unnamed > 0
        ? `Copied. ${unnamed} unnamed ${unnamed === 1 ? "item was" : "items were"} left out.`
        : "Copied.";
    } catch {
      copied = "Your browser would not copy the list.";
    }
  }

  /**
   * Open the Industry panel of the pilot whose copy passed installCheck or
   * inventionCheck, with the job and its facility filled in. The cost and the
   * confirm stay that panel's (app/industryInstallTarget.ts).
   */
  function setUp(check: InstallCheck): void {
    if (!check.ok) return;
    const from = check.from;
    const session = onlineSessions().find((entry) => entry.characterID === from.characterID);
    if (!session) return;
    installTarget.ask({
      characterID: from.characterID,
      blueprintItemID: from.itemID,
      facilityID: from.facilityID ?? 0,
      activity: check.activity,
      runs: check.runs,
      ...(check.decryptorTypeID !== null ? { decryptorTypeID: check.decryptorTypeID } : {}),
    });
    onOpen?.("industry", session.session.id);
  }

  function togglePlaces(typeID: number): void {
    const next = new Set(placesOpen);
    if (next.has(typeID)) next.delete(typeID);
    else next.add(typeID);
    placesOpen = next;
  }

  async function loadPlans(): Promise<void> {
    plansError = null;
    try {
      plans = await loadIndustryPlans(askers());
      plansLoaded = true;
      view = pruneIndustryPlanView(view, plans.map((entry) => entry.planID));
      saveIndustryPlanView(view);
      for (const entry of plans) {
        void loadBook(entry.productTypeID);
      }
      if (plans.length === 0 && productTypeID === null) leftTab = "blueprints";
      const remembered = plans.find((entry) => entry.planID === view.openID);
      if (remembered && openPlanID === null && productTypeID === null) {
        showPlan(remembered);
      }
    } catch (error) {
      plansError = error instanceof Error ? error.message : "Your saved plans could not be read just now.";
    }
  }

  // --- the open plan ---------------------------------------------------------

  function showPlan(entry: SavedIndustryPlan | null): void {
    planError = null;
    draftFolds = {};
    openPlanID = entry?.planID ?? null;
    view = withOpenIndustryPlan(view, openPlanID);
    saveIndustryPlanView(view);
    if (entry === null) {
      productTypeID = null;
      draftName = null;
      runsText = "1";
      choices = NO_CHOICES;
      noteText = "";
      return;
    }
    productTypeID = entry.productTypeID;
    draftName = null;
    runsText = String(entry.runs);
    choices = entry.choices;
    noteText = entry.note;
    clearBookError(entry.productTypeID);
    void loadBook(entry.productTypeID);
  }

  /** Forget a failed read so the product is asked for again. */
  function clearBookError(typeID: number): void {
    if (bookErrors.has(typeID)) {
      const next = new Map(bookErrors);
      next.delete(typeID);
      bookErrors = next;
    }
  }

  /** Start a new, unsaved plan for a product. */
  function draft(typeID: number, name: string | null, defaultRuns: number): void {
    showPlan(null);
    productTypeID = typeID;
    draftName = name;
    runsText = String(defaultRuns);
    clearBookError(typeID);
    void loadBook(typeID);
  }

  function chooseOwned(itemID: string): void {
    const blueprint = owned.find((candidate) => String(candidate.itemID) === itemID);
    if (blueprint) {
      draft(blueprint.productTypeID, blueprint.blueprintName, blueprint.runs ?? 1);
    }
  }

  function chooseMatch(match: IndustryBlueprintMatch): void {
    draft(match.productTypeID, match.productName ?? match.blueprintName, 1);
  }

  // Saves run one after another, each on the newest revision, so quick clicks
  // never race each other into a conflict.
  let saveChain: Promise<void> = Promise.resolve();

  function save(fields: IndustryPlanFields): Promise<void> {
    const planID = openPlanID;
    if (planID === null) {
      return Promise.resolve();
    }
    saveChain = saveChain.then(async () => {
      const current = plans.find((entry) => entry.planID === planID);
      if (!current) return;
      planSaving = true;
      try {
        plans = withIndustryPlan(plans, await updateIndustryPlan(askers(), current, fields));
        planError = null;
      } catch (error) {
        planError = error instanceof Error ? error.message : "That change could not be saved.";
        // A conflict or a refusal: take the server's copy as it stands.
        await loadPlans();
        const fresh = plans.find((entry) => entry.planID === planID);
        if (fresh && openPlanID === planID) {
          runsText = String(fresh.runs);
          choices = fresh.choices;
          noteText = fresh.note;
        }
      } finally {
        planSaving = false;
      }
    });
    return saveChain;
  }

  async function saveNew(): Promise<void> {
    if (productTypeID === null || runs === null) {
      planError = "Enter a number of runs.";
      return;
    }
    planSaving = true;
    planError = null;
    try {
      const created = await createIndustryPlan(askers(), {
        productTypeID,
        runs,
        choices,
        note: noteText,
      });
      plans = withIndustryPlan(plans, created);
      const keptFolds = draftFolds;
      showPlan(created);
      if (Object.keys(keptFolds).length > 0) {
        view = withFolds(view, created.planID, keptFolds);
        saveIndustryPlanView(view);
      }
    } catch (error) {
      planError = error instanceof Error ? error.message : "The plan could not be saved.";
    } finally {
      planSaving = false;
    }
  }

  function commitRuns(): void {
    if (runs === null) {
      planError = "Enter a number of runs.";
      return;
    }
    if (openPlan && openPlan.runs !== runs) {
      void save({ runs });
    }
  }

  function commitNote(): void {
    if (openPlan && openPlan.note !== noteText.trim()) {
      void save({ note: noteText });
    }
  }

  function setBuying(typeID: number, buy: boolean): void {
    choices = withBuying(choices, typeID, buy);
    if (openPlan) {
      void save({ choices });
    }
  }

  async function setStatus(status: "active" | "done"): Promise<void> {
    await save({ status });
  }

  async function removePlan(entry: SavedIndustryPlan): Promise<void> {
    planSaving = true;
    try {
      await deleteIndustryPlan(askers(), entry.planID);
      plans = withoutIndustryPlan(plans, entry.planID);
      showPlan(null);
    } catch (error) {
      planError = error instanceof Error ? error.message : "The plan could not be deleted.";
    } finally {
      planSaving = false;
    }
  }

  // --- the search -------------------------------------------------------------

  function onQuery(): void {
    if (searchTimer !== null) {
      clearTimeout(searchTimer);
    }
    const text = query.trim();
    if (text.length < 2) {
      matches = [];
      searchTotal = 0;
      searchError = null;
      return;
    }
    searchTimer = setTimeout(() => void runSearch(text), 250);
  }

  async function runSearch(text: string): Promise<void> {
    const serial = ++searchSerial;
    searching = true;
    searchError = null;
    try {
      const result = decodeBlueprintSearch(await ask((options) => searchIndustryBlueprints(text, options)));
      if (serial !== searchSerial) {
        return;
      }
      matches = result.matches;
      searchTotal = result.total;
    } catch {
      if (serial === searchSerial) {
        searchError = "The search could not be run just now.";
      }
    } finally {
      if (serial === searchSerial) {
        searching = false;
      }
    }
  }

  // --- the tree ---------------------------------------------------------------

  /** Open by default to two levels below the target; deeper folds. */
  function isOpen(node: IndustryNode): boolean {
    const hand = openPlanID === null ? draftFolds[node.key] : folds[node.key];
    return hand ?? node.key.split(">").length <= 2;
  }

  function toggle(node: IndustryNode): void {
    const next = { ...(openPlanID === null ? draftFolds : folds), [node.key]: !isOpen(node) };
    if (openPlanID === null) {
      draftFolds = next;
      return;
    }
    view = withFolds(view, openPlanID, next);
    saveIndustryPlanView(view);
  }

  /**
   * Read the blueprints and skills of every online pilot not read yet. Runs
   * when the window opens and whenever a pilot comes online in this tab: a
   * pilot signed in after the window opened used to be listed as holding no
   * blueprints, because nothing had read them (seen live, 2026-10-01).
   */
  function readNewcomers(): void {
    const newcomers = onlineSessions().filter(({ session }) => !askedSessions.has(session.id));
    if (newcomers.length === 0) return;
    for (const { session } of newcomers) askedSessions.add(session.id);
    const unread = newcomers.filter(({ session }) => !session.store.industry.get().loaded);
    if (unread.length > 0) {
      refreshing = true;
      void Promise.allSettled(unread.map(({ session }) => session.flow.loadIndustry())).finally(() => {
        refreshing = false;
        storeTick += 1;
      });
    }
    // Skills, for how far each pilot can start a job from where it is.
    for (const { session } of newcomers) {
      if (!session.store.skills.get().loaded) void session.flow.loadSkills().catch(() => {});
    }
  }

  // Each pilot's store, watched so a read made elsewhere (their Industry panel,
  // a Refresh here) shows up in the list without asking again. Re-subscribed
  // when a pilot joins or leaves the tab.
  // ⚠ `subscribe` calls back at once, and the callback reads `storeTick` to
  // bump it; untracked, or this effect would depend on its own write.
  $effect(() => {
    const list = sessions;
    const stops = untrack(() =>
      list.flatMap((session) => [
        session.store.industry.subscribe(() => (storeTick += 1)),
        session.store.station.subscribe(() => {
          storeTick += 1;
          readNewcomers();
        }),
        session.store.skills.subscribe(() => (storeTick += 1)),
      ]),
    );
    return () => {
      for (const stop of stops) {
        stop();
      }
    };
  });

  // A new book, or the invention terms arriving (decryptors are stock too),
  // may bring types the last stock read did not ask about.
  $effect(() => {
    void books;
    void inventionTerms;
    untrack(() => stockWhenNeeded());
  });

  onMount(() => {
    void loadPlans();
    void loadInventionTerms();
    void ask((options) => loadSystemGraph(options))
      .then((data) => {
        systemGraph = buildSystemGraph(data);
      })
      .catch(() => {
        // Without it, a facility in another system reads as out of reach;
        // one in the pilot's own system is still checked.
      });
    readNewcomers();
    // Moves the read-at ages on; touches no network.
    const tick = setInterval(() => (browserNowMs = Date.now()), 30_000);
    return () => {
      clearInterval(tick);
      if (stockTimer !== null) {
        clearTimeout(stockTimer);
      }
      if (searchTimer !== null) {
        clearTimeout(searchTimer);
      }
    };
  });
</script>

<section class="panel im-manager">
  <header class="panel-head">
    <h2 class="panel-title">Industry Manager</h2>
    <span class="controls">
      <button
        type="button"
        disabled={refreshing || stockReading}
        onclick={() => {
          void refreshOwned();
          void loadPlans();
          void readStock();
        }}
      >
        {refreshing || stockReading ? "Looking..." : "Refresh"}
      </button>
    </span>
  </header>

  <div class="im-body">
    <!-- THE LEFT COLUMN: your plans, or the blueprints to start one from. -->
    <aside class="im-side" aria-label="Plans and blueprints">
      <div class="im-tabs" role="tablist" aria-label="Show">
        <button type="button" role="tab" class="im-tab" class:on={leftTab === "plans"} aria-selected={leftTab === "plans"} onclick={() => (leftTab = "plans")}>
          Plans{#if activePlans.length > 0}<span class="im-count-badge">{activePlans.length}</span>{/if}
        </button>
        <button type="button" role="tab" class="im-tab" class:on={leftTab === "blueprints"} aria-selected={leftTab === "blueprints"} onclick={() => (leftTab = "blueprints")}>
          Blueprints{#if ownedGroups.length > 0}<span class="im-count-badge">{ownedGroups.length}</span>{/if}
        </button>
      </div>

      {#if leftTab === "plans"}
        {#snippet planCard(entry: SavedIndustryPlan)}
          {@const cardStanding = cardStandings.get(entry.planID)}
          <li>
            <button
              type="button"
              class="im-item"
              class:on={entry.planID === openPlanID}
              aria-current={entry.planID === openPlanID ? "true" : undefined}
              onclick={() => showPlan(entry)}
            >
              <TypeIcon typeID={entry.productTypeID} name={planTitle(entry)} size="md" />
              <span class="im-item-text">
                <span class="im-item-name">{planTitle(entry)}</span>
                <span class="im-item-sub">
                  {countWords(entry.runs)} {entry.runs === 1 ? "run" : "runs"}{entry.note ? ` - ${entry.note}` : ""}
                </span>
                {#if cardStanding}
                  <span class="im-item-foot">
                    <span class="im-meter" aria-hidden="true">
                      <span class="im-meter-fill tone-{cardStanding.tone}" style:width={`${Math.round(cardStanding.share * 100)}%`}></span>
                    </span>
                    <span class="im-pill tone-{cardStanding.tone}">{cardStanding.words}</span>
                  </span>
                {/if}
              </span>
            </button>
          </li>
        {/snippet}
        <button
          type="button"
          class="im-new"
          onclick={() => {
            showPlan(null);
            leftTab = "blueprints";
          }}
        >+ New plan</button>
        {#if plansError}
          <p class="im-error" role="alert">{plansError}</p>
        {:else if !plansLoaded}
          <p class="im-note">Reading your saved plans...</p>
        {:else if activePlans.length === 0}
          <p class="im-note">{donePlans.length > 0 ? "No active plans." : "No plans yet."}</p>
        {:else}
          <ul class="im-list">
            {#each activePlans as entry (entry.planID)}
              {@render planCard(entry)}
            {/each}
          </ul>
        {/if}
        {#if donePlans.length > 0}
          <h4 class="im-section-title">Done</h4>
          <ul class="im-list">
            {#each donePlans as entry (entry.planID)}
              {@render planCard(entry)}
            {/each}
          </ul>
        {/if}
      {:else}
        <input
          type="search"
          class="im-filter"
          aria-label="Filter blueprints"
          placeholder="Filter, or search all"
          bind:value={query}
          oninput={onQuery}
        />
        {#if onlineCount === 0}
          <p class="im-note">Sign a pilot in here to list their blueprints.</p>
        {:else if owned.length === 0}
          <p class="im-note">{unreadOnline || refreshing ? "Looking at your blueprints..." : "None of your signed-in pilots holds a blueprint."}</p>
        {:else if ownedShown.length === 0}
          <p class="im-note">None of your blueprints is called that.</p>
        {:else}
          <h4 class="im-section-title">Yours</h4>
          <ul class="im-list" aria-label="Your blueprints">
            {#each ownedShown as group (group.blueprintTypeID)}
              {@const plan = planned.get(group.blueprintTypeID)}
              {@const shown = plan?.copy ?? group.copies[0]!}
              <li>
                <button
                  type="button"
                  class="im-item"
                  class:on={openPlan === null && productTypeID === group.productTypeID}
                  onclick={() => chooseOwned(String(shown.itemID))}
                >
                  <TypeIcon typeID={group.productTypeID} name={group.blueprintName ?? "An unnamed blueprint"} size="md" />
                  <span class="im-item-text">
                    <span class="im-item-name">{(group.blueprintName ?? "An unnamed blueprint").replace(/ Blueprint$/, "")}</span>
                    <span class="im-item-sub">{groupWords(group, shown)}</span>
                    {#if plan?.inReach}<span class="im-chip im-reach" title="A job can start from this copy where it is">in reach</span>{/if}
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        {#if query.trim().length < 2}
          <p class="im-note">Type two letters to search every blueprint too.</p>
        {:else}
          <h4 class="im-section-title">All blueprints</h4>
          {#if searchError}
            <p class="im-error" role="alert">{searchError}</p>
          {:else if searching && matches.length === 0}
            <p class="im-note">Looking...</p>
          {:else if matches.length === 0}
            <p class="im-note">No blueprint is called that.</p>
          {:else}
            <ul class="im-list" aria-label="All blueprints">
              {#each matches as match (match.blueprintTypeID)}
                <li>
                  <button
                    type="button"
                    class="im-item"
                    class:on={openPlan === null && productTypeID === match.productTypeID}
                    onclick={() => chooseMatch(match)}
                  >
                    <TypeIcon typeID={match.productTypeID} name={match.productName ?? match.blueprintName} size="md" />
                    <span class="im-item-text">
                      <span class="im-item-name">{match.blueprintName.replace(/ (Blueprint|Reaction Formula)$/, "")}</span>
                      <span class="im-item-sub">{match.activity === "reaction" ? "Reaction formula" : "Blueprint"}</span>
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
            {#if searchTotal > matches.length}
              <p class="im-note">Showing {matches.length} of {countWords(searchTotal)}. Type more to narrow it.</p>
            {/if}
          {/if}
        {/if}
      {/if}
    </aside>

    <div class="im-plan">
      {#if productTypeID === null}
        <p class="im-empty">Choose a blueprint and this will work out everything it takes to build.</p>
      {:else}
        <header class="im-head">
          <span class="im-head-icon">
            <TypeIcon typeID={productTypeID} name={productName ?? "An unnamed item"} size="lg" />
          </span>
          <div class="im-head-title">
            <h3>
              <span>{productName ?? "An unnamed item"}</span>
              {#if openPlan?.status === "done"}<span class="im-chip">done</span>{/if}
              {#if openPlan === null}<span class="im-chip">not saved</span>{/if}
            </h3>
            {#if termsWords}
              <p class="im-terms">{termsWords} <span class="im-terms-quiet">- {facilityWords}</span></p>
            {/if}
          </div>
          <div class="im-head-actions">
            <label class="im-runs">
              <span>Runs</span>
              <input
                inputmode="numeric"
                bind:value={runsText}
                aria-invalid={runs === null}
                oninput={() => (planError = null)}
                onchange={commitRuns}
                onkeydown={(event) => event.key === "Enter" && commitRuns()}
              />
            </label>
            {#if openPlan === null}
              <button type="button" class="primary" disabled={planSaving || runs === null} onclick={() => void saveNew()}>Save plan</button>
            {:else if openPlan.status === "active"}
              <button type="button" disabled={planSaving} onclick={() => void setStatus("done")}>Mark done</button>
            {:else}
              <button type="button" disabled={planSaving} onclick={() => void setStatus("active")}>Reopen</button>
              <button type="button" class="danger" disabled={planSaving} onclick={() => openPlan && void removePlan(openPlan)}>Delete</button>
            {/if}
          </div>
        </header>
        {#if planWork.length > 0}
          <!-- BUILD AT. Owned copies are built where they sit; this is where
               the rest are, per kind of work. Its modifiers and the fastest
               online pilot's skills set those jobs' materials and time. -->
          <div class="im-build-at">
            {#each planWork as work (work)}
              <label>
                <span>{work === "reaction" ? "React at" : "Build at"}</span>
                <select value={String(choices.facilities?.[work] ?? "")} onchange={(event) => setBuildAt(work, event.currentTarget.value)}>
                  <option value="">No facility - no bonus counted</option>
                  {#each buildAtChoices(work) as facility (facility.facilityID)}
                    <option value={String(facility.facilityID)}>{facilityName(facility.facilityID)}</option>
                  {/each}
                </select>
              </label>
            {/each}
            <span class="im-build-at-note">Owned copies are built where they are.</span>
          </div>
        {/if}
        <input
          class="im-note-input"
          aria-label="Note"
          placeholder="Add a note"
          maxlength="500"
          bind:value={noteText}
          onchange={commitNote}
        />
        {#if planError}
          <p class="im-error" role="alert">{planError}</p>
        {/if}

        {#if runs === null}
          <p class="im-error" role="alert">Enter a number of runs.</p>
        {:else if bookError}
          <p class="im-error" role="alert">{bookError}</p>
        {:else if book === null}
          <p class="im-note">Working out the recipes...</p>
        {:else if book.capped}
          <p class="im-error" role="alert">This tree is too large to show in full.</p>
        {:else if chain}
          <!-- THE VERDICT FIRST, so a screen reader reaches the answer before the tree. -->
          {#if stock === null}
            <p class="im-verdict">{stockReading ? "Looking at your hangars..." : "What you hold has not been read yet."}</p>
          {:else if allRunning}
            <p class="im-verdict tone-ok">All of it is in production.{openPlan?.status === "active" ? " Mark it done once it is delivered." : ""}</p>
          {:else if standing && standing.missing + inventionShort.length === 0}
            <p class="im-verdict tone-ok">You have everything to build {countWords(chain.root.quantity)} {productName ?? "of these"}.</p>
          {:else if standing}
            <p class="im-verdict tone-bad">You are short {countWords(standing.missing + inventionShort.length)} {standing.missing + inventionShort.length === 1 ? "item" : "items"}.</p>
          {/if}
          <p class="im-note">
            {countWords(jobCount)} {jobCount === 1 ? "job" : "jobs"} to run.
            {#if stale}{stale}{/if}
          </p>
          {#each pilotProblems as pilot (pilot.characterID)}
            <p class="im-note">
              {pilot.state === "no-sign-in" ? `${pilot.characterName}'s account could not be signed in to read their hangars.` : `${pilot.characterName}'s hangars could not be read just now.`}
            </p>
          {/each}
          {#each corpProblems as corp (corp.corporationID)}
            <p class="im-note">
              {corp.state === "unreachable"
                ? `${corp.corporationName ?? "A corporation"}'s hangars need one of its pilots online here, or flown by a bot.`
                : `${corp.corporationName ?? "A corporation"}'s hangars could not be read just now.`}
            </p>
          {/each}

          {#if missingCount > 0}
            <div class="im-section-head">
              <h4 class="im-section-title">Missing</h4>
              <button type="button" class="im-copy" onclick={() => void copyMultibuy()}>Copy multibuy</button>
            </div>
            {#if copied}<p class="im-note" role="status">{copied}</p>{/if}
            <ul class="im-buy" aria-label="Missing">
              {#each toBuy as line (line.typeID)}
                {@const where = places.get(line.typeID) ?? []}
                <li class="im-buy-row">
                  <span class="im-buy-name">
                    <TypeIcon typeID={line.typeID} name={lineName(line)} />
                    {lineName(line)}
                    {#if line.planetary}<span class="im-chip">PI</span>{/if}
                  </span>
                  <span class="im-buy-held">
                    {#if where.length > 0}
                      <button type="button" class="im-held" aria-expanded={placesOpen.has(line.typeID)} title="Where it is" onclick={() => togglePlaces(line.typeID)}>
                        {countWords(line.held)} held
                      </button>
                    {:else}
                      {countWords(line.held)} held
                    {/if}
                    of {countWords(line.needed)}
                  </span>
                  <span class="im-buy-count">{countWords(line.short)}</span>
                </li>
                {#if placesOpen.has(line.typeID)}
                  <li>
                    <ul class="im-places">
                      {#each where as place, index (index)}
                        <li><span class="im-source-tag">{place.source === "corp" ? "corp" : "hangar"}</span>{countWords(place.quantity)} - {place.placeWords} - {place.ownerWords}</li>
                      {/each}
                    </ul>
                  </li>
                {/if}
              {/each}
              {#each inventionShort as entry (entry.typeID)}
                <li class="im-buy-row">
                  <span class="im-buy-name">
                    <TypeIcon typeID={entry.typeID} name={entry.name ?? "An unnamed item"} />
                    {entry.name ?? "An unnamed item"}
                    <span class="im-chip" title="For invention, on average">invention</span>
                  </span>
                  <span class="im-buy-held">{countWords(entry.held)} held of {countWords(entry.needed)}</span>
                  <span class="im-buy-count">{countWords(entry.short)}</span>
                </li>
              {/each}
            </ul>
          {/if}

          <!-- START NEXT, by stage as a build is worked. A step whose inputs are all
               in hand can be set up in the Industry panel of the pilot who holds its
               blueprint; starting it is still that panel's confirm. -->
          {#if startGroups.length > 0}
            <h4 class="im-section-title">Start next</h4>
            {#if toBuy.length > 0}
              <p class="im-note">Buy {countWords(toBuy.length)} {toBuy.length === 1 ? "item" : "items"} first - see Missing.</p>
            {/if}
            {#each startGroups as group (group.stage)}
              <h5 class="im-stage">{group.label}</h5>
              <ul class="im-start" aria-label={group.label}>
                {#each group.steps as step (step.line.typeID)}
                  {@const check = installCheck(step.line, owned, installPilots, jumpsBetween, plannedFor(step.line))}
                  <li class="im-start-row" class:ready={step.canStart}>
                    <span class="im-buy-name">
                      <TypeIcon typeID={step.line.typeID} name={lineName(step.line)} />
                      {lineName(step.line)}
                    </span>
                    <span class="im-start-runs">
                      {countWords(step.line.runs)} {step.line.runs === 1 ? "run" : "runs"}{step.line.jobRuns.length > 1 ? ` in ${step.line.jobRuns.length} jobs` : ""}
                      {#if step.line.inProduction > 0}- {countWords(step.line.inProduction)} already in production{/if}
                    </span>
                    {#if !step.canStart}
                      <span class="im-pill tone-act">waits for inputs</span>
                    {:else if check.ok}
                      <button type="button" class="im-setup" title="Opens {check.from.characterName}'s Industry panel with this job filled in" onclick={() => setUp(check)}>
                        Set up in Industry
                      </button>
                    {:else}
                      <span class="im-pill tone-act">cannot start here</span>
                    {/if}
                  </li>
                  {#if step.canStart && !check.ok}
                    <li class="im-start-why">{installBlockWords(check)}</li>
                  {/if}
                {/each}
              </ul>
            {/each}
          {/if}

          <!-- INVENTION, ON AVERAGE. A T2 blueprint nobody here owns needs copies
               invented; the odds are the server's formula with the best skills
               among the pilots online here, and the decryptor is the plan's choice. -->
          {#if inventions.length > 0}
            <h4 class="im-section-title">Invention, on average</h4>
            <ul class="im-start" aria-label="Invention">
              {#each inventions as row (row.line.typeID)}
                {@const blueprintTypeID = row.line.blueprint?.blueprintTypeID ?? 0}
                <li class="im-invent-row">
                  <span class="im-buy-name">
                    <TypeIcon typeID={row.line.typeID} name={lineName(row.line)} />
                    {lineName(row.line)}
                  </span>
                  <span class="im-start-runs">
                    {countWords(row.copies)} {row.copies === 1 ? "copy" : "copies"} of {countWords(row.runsPerCopy)} {row.runsPerCopy === 1 ? "run" : "runs"},
                    {chanceWords(row.need.chance)} a try
                    {row.inventorName ? `with ${row.inventorName}'s skills` : "- skills not counted, sign a pilot in here"},
                    about {countWords(row.need.attempts)} {row.need.attempts === 1 ? "attempt" : "attempts"}{row.need.running > 0 ? `, ${countWords(row.need.running)} running` : ""}
                  </span>
                  {#if inventionTerms.decryptors.size > 0}
                    <label class="im-decryptor">
                      <span class="sr-only">Decryptor for {lineName(row.line)}</span>
                      <select value={String(choices.decryptors?.[String(blueprintTypeID)] ?? "")} onchange={(event) => setDecryptor(blueprintTypeID, event.currentTarget.value)}>
                        <option value="">No decryptor</option>
                        {#each [...inventionTerms.decryptors.values()] as decryptor (decryptor.typeID)}
                          <option value={String(decryptor.typeID)}>{decryptorEffectWords(decryptor)}</option>
                        {/each}
                      </select>
                    </label>
                  {/if}
                </li>
                {#if row.need.toStart === 0}
                  <li class="im-start-why">Every attempt is running; the copies arrive when the jobs are delivered.</li>
                {:else}
                  {@const check = inventionCheck(row, owned, installPilots, jumpsBetween)}
                  <li class="im-start-why im-invent-setup">
                    {#if check.ok}
                      <span>{countWords(check.runs)} {check.runs === 1 ? "attempt" : "attempts"} from {check.from.characterName}'s copy</span>
                      <button type="button" class="im-setup" title="Opens {check.from.characterName}'s Industry panel with this invention filled in" onclick={() => setUp(check)}>
                        Set up in Industry
                      </button>
                    {:else}
                      {installBlockWords(check)}
                    {/if}
                  </li>
                {/if}
              {/each}
            </ul>
          {/if}

          <!-- THE TREE. Each type is worked once for the whole plan; a type
               that appears again is marked "above" rather than drawn twice. -->
          {#snippet treeNode(node: IndustryNode, isRoot: boolean)}
            {@const line = node.line}
            {@const open = node.children.length > 0 && isOpen(node)}
            <li role="treeitem" aria-selected="false" aria-expanded={node.children.length > 0 ? open : undefined}>
              <div class="im-node obtain-{line.obtain}">
                {#if node.children.length > 0}
                  <button type="button" class="im-node-name" onclick={() => toggle(node)}>
                    <span class="im-chevron" aria-hidden="true">{open ? "v" : ">"}</span>
                    <TypeIcon typeID={node.typeID} name={lineName(line)} />
                    <span>{lineName(line)}</span>
                  </button>
                {:else}
                  <span class="im-node-name">
                    <span class="im-chevron" aria-hidden="true"></span>
                    <TypeIcon typeID={node.typeID} name={lineName(line)} />
                    <span>{lineName(line)}</span>
                  </span>
                {/if}
                <span class="im-tags">
                  {#if node.repeat}
                    <span class="im-tag" title="Drawn in full above">above</span>
                  {/if}
                  {#if line.planetary}<span class="im-tag">PI</span>{/if}
                  {#if line.inProduction > 0 && !node.repeat}
                    <span class="im-tag ok" title="Jobs already running for it">{countWords(line.inProduction)} in production</span>
                  {/if}
                  {#if line.held > 0 && !node.repeat}
                    <span class="im-tag ok" title="Used from what you hold">{countWords(line.held)} held</span>
                  {/if}
                  {#if line.obtain !== "buy" && line.runs > 0}
                    <span class="im-tag">{countWords(line.runs)} {line.runs === 1 ? "run" : "runs"}</span>
                    {#if !node.repeat}
                      {@const time = lineTimeWords(line)}
                      {#if time}<span class="im-tag" title={lineTimeTitle(line)}>{time}</span>{/if}
                    {/if}
                  {/if}
                  {#if line.leftover > 0}
                    <span class="im-tag" title="Whole runs make more than the plan needs">{countWords(line.leftover)} left over</span>
                  {/if}
                  {#if line.blueprint?.invention}
                    <span class="im-tag act" title="Each success gives a copy with {line.blueprint.invention.runsPerCopy} runs">
                      needs {line.blueprint.invention.copies} invented {line.blueprint.invention.copies === 1 ? "copy" : "copies"}
                    </span>
                  {/if}
                  {#if line.blueprint && !isRoot && line.blueprint.assumed && line.obtain === "build" && line.runs > 0}
                    <span class="im-tag" title="No pilot here owns this blueprint">assumed material {line.blueprint.materialEfficiency}%</span>
                  {/if}
                  {#if line.buyReason === "cycle"}
                    <span class="im-tag bad">made from itself</span>
                  {/if}
                </span>
                <span class="im-count">{countWords(node.quantity)}</span>
                {#if !isRoot && line.canBuild && line.buyReason !== "cycle"}
                  <button
                    type="button"
                    class="im-obtain"
                    aria-pressed={line.obtain === "buy"}
                    title={line.obtain === "buy" ? "Build this instead of buying it" : "Buy this instead of building it"}
                    onclick={() => setBuying(node.typeID, line.obtain !== "buy")}
                  >{line.obtain}</button>
                {:else}
                  <span class="im-obtain-fixed">{line.obtain}</span>
                {/if}
              </div>
              {#if open}
                <ul class="im-tree-kids" role="group">
                  {#each node.children as child (child.key)}
                    {@render treeNode(child, false)}
                  {/each}
                </ul>
              {/if}
            </li>
          {/snippet}

          <h4 class="im-section-title">Build tree</h4>
          <ul class="im-tree" role="tree" aria-label="Build tree">
            {@render treeNode(chain.root, true)}
          </ul>
        {/if}
      {/if}
    </div>
  </div>
</section>

<style>
  /* Square, like the rest of the app (R53): corners go through the tokens. */
  .im-body {
    display: grid;
    grid-template-columns: minmax(13rem, 16rem) minmax(0, 1fr);
    gap: 1rem;
    align-items: start;
    margin-top: 0.75rem;
  }
  .im-side,
  .im-plan {
    background: var(--color-panel-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-frame);
    min-width: 0;
  }
  .im-side {
    display: grid;
    align-content: start;
    gap: 0.5rem;
    padding: 0 0.6rem 0.6rem;
  }
  /* ⚠ ITS OWN CONTAINER. The rows inside fold to their narrow layout by the
   * width of THIS pane, not the window: beside the plan list a 700px window
   * leaves the pane about 400px, and measured by the window the tree rows kept
   * their wide grid and scrolled sideways (seen live, 2026-10-01). */
  .im-plan {
    display: grid;
    align-content: start;
    gap: 0.75rem;
    padding: 1rem 1.1rem;
    container-type: inline-size;
  }

  /* The left column's two views, as a tab strip across its top. */
  .im-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    margin: 0 -0.6rem;
    border-bottom: 1px solid var(--color-line);
  }
  /* ⚠ NOT `class:active` — a bare `button.active` is a filled accent control
   * in the app's component layer. */
  .im-tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-height: 40px;
    padding: 0 0.6rem;
    background: transparent;
    border: 0;
    border-bottom: 2px solid transparent;
    color: var(--color-muted);
    font-weight: 500;
    cursor: pointer;
  }
  .im-tab.on {
    border-bottom-color: var(--color-accent);
    color: var(--color-text-bright);
  }
  .im-count-badge {
    min-width: 1.3rem;
    padding: 0 0.3rem;
    border: 1px solid var(--color-line-strong);
    color: var(--color-cell);
    font-size: 11px;
    text-align: center;
  }
  .im-new {
    justify-self: start;
    min-height: 32px;
    padding: 0 0.7rem;
  }
  .im-filter {
    width: 100%;
    min-height: 36px;
  }
  .im-section-title {
    margin: 0.2rem 0 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted);
  }

  /* One row in either list: icon, name, and one muted line under it. */
  .im-list,
  .im-buy,
  .im-tree,
  .im-tree-kids {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .im-list {
    display: grid;
    gap: 0.2rem;
  }
  .im-item {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    min-height: 44px;
    padding: 0.4rem 0.5rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    color: var(--color-text);
    text-align: left;
    cursor: pointer;
  }
  .im-item:hover:not(.on) {
    background: var(--color-panel);
    border-color: var(--color-line);
  }
  .im-item.on {
    background: var(--color-panel-2);
    border-color: var(--color-accent-dim);
  }
  .im-item-text {
    display: grid;
    flex: 1 1 auto;
    min-width: 0;
  }
  .im-item-name {
    color: var(--color-text-bright);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .im-item-sub {
    color: var(--color-muted);
    font-size: 0.8rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .im-item-foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  .im-note,
  .im-empty {
    margin: 0;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .im-error {
    margin: 0;
    color: var(--color-danger);
    font-size: 0.85rem;
  }
  .im-chip,
  .im-tag {
    font-size: 11px;
    padding: 0 0.4rem;
    border: 1px solid var(--color-line-strong);
    color: var(--color-cell);
    white-space: nowrap;
  }
  .im-chip.im-reach {
    align-self: flex-start;
    border-color: var(--color-good);
    color: var(--color-good);
  }
  .im-tag.act {
    border-color: var(--color-warn);
    color: var(--color-warn);
  }
  .im-tag.ok {
    border-color: var(--color-good);
    color: var(--color-good);
  }
  .im-tag.bad {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }
  .im-head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.9rem;
  }
  .im-head-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 3.25rem;
    height: 3.25rem;
    overflow: hidden;
    background: var(--color-panel-2);
    border: 1px solid var(--color-line);
  }
  .im-head-title {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
  }
  .im-head-title h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 1.2rem;
    font-weight: 500;
    color: var(--color-text-bright);
  }
  .im-terms {
    margin: 0;
    color: var(--color-cell);
    font-size: 0.85rem;
  }
  .im-build-at {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    align-items: center;
    margin: 0.2rem 0 0.4rem;
  }
  .im-build-at label {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .im-build-at select {
    min-height: 32px;
    max-width: 22rem;
  }
  .im-build-at-note {
    color: var(--color-muted);
    font-size: 0.8rem;
  }
  .im-terms-quiet {
    color: var(--color-muted);
  }
  .im-head-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .im-head-actions button {
    min-height: 34px;
  }
  /* The note: a quiet line under the header that reads as text until used. */
  .im-note-input {
    width: 100%;
    min-height: 30px;
    padding: 0 0.4rem;
    background: transparent;
    border: 1px solid transparent;
    border-bottom-color: var(--color-row-line);
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .im-note-input:hover,
  .im-note-input:focus {
    border-color: var(--color-line-strong);
    background: var(--color-field);
    color: var(--color-text);
  }
  .im-runs {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .im-runs input {
    width: 5.5rem;
    min-height: 34px;
  }
  .im-verdict {
    margin: 0;
    color: var(--color-text);
  }
  .im-verdict.tone-ok {
    color: var(--color-good);
  }
  .im-verdict.tone-bad {
    color: var(--color-danger);
  }
  .im-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .im-copy {
    min-height: 32px;
    padding: 0 0.7rem;
  }
  .im-buy-held {
    color: var(--color-muted);
    font-size: 0.85rem;
    text-align: right;
  }
  .im-held {
    min-height: 0;
    padding: 0;
    background: none;
    border: 0;
    color: var(--color-text-bright);
    font: inherit;
    text-decoration: underline dotted;
    cursor: pointer;
  }
  .im-places {
    list-style: none;
    margin: 0 0 0.3rem 2.2rem;
    padding: 0;
    font-size: 0.85rem;
  }
  .im-places li {
    padding: 0.1rem 0;
  }
  .im-source-tag {
    display: inline-block;
    min-width: 3.5rem;
    margin-right: 0.4rem;
    color: var(--color-muted);
    font-size: 11px;
  }
  .im-stage {
    margin: 0.3rem 0 0;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--color-cell);
  }
  .im-start {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .im-start-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(8rem, auto) auto;
    gap: 0.6rem;
    align-items: center;
    min-height: 40px;
    padding: 0.2rem 0.6rem;
    border-top: 1px solid var(--color-line);
    border-left: 3px solid var(--color-line-strong);
  }
  .im-start-why {
    padding: 0 0.6rem 0.4rem 1.2rem;
    color: var(--color-muted);
    font-size: 0.8rem;
  }
  .im-start-row.ready {
    border-left-color: var(--color-good);
  }
  .im-start-runs {
    color: var(--color-muted);
    font-size: 0.85rem;
  }
  .im-setup {
    min-height: 32px;
    padding: 0 0.7rem;
  }
  .im-invent-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) minmax(10rem, 16rem);
    gap: 0.6rem;
    align-items: center;
    min-height: 40px;
    padding: 0.2rem 0.6rem;
    border-top: 1px solid var(--color-line);
    border-left: 3px solid var(--color-warn);
  }
  .im-decryptor select {
    width: 100%;
    min-height: 34px;
  }
  .im-invent-setup {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    align-items: center;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .im-meter {
    flex: 1 1 auto;
    height: 4px;
    background: var(--color-line);
    overflow: hidden;
  }
  .im-meter-fill {
    display: block;
    height: 100%;
    background: var(--color-good);
  }
  .im-meter-fill.tone-act {
    background: var(--color-warn);
  }
  .im-meter-fill.tone-bad {
    background: var(--color-danger);
  }
  .im-pill {
    padding: 0.05rem 0.45rem;
    border: 1px solid var(--color-line-strong);
    border-radius: var(--radius-control);
    color: var(--color-cell);
    font-size: 11px;
    white-space: nowrap;
  }
  .im-pill.tone-ok {
    border-color: var(--color-good);
    color: var(--color-good);
  }
  .im-pill.tone-act {
    border-color: var(--color-warn);
    color: var(--color-warn);
  }
  .im-pill.tone-bad {
    border-color: var(--color-danger);
    color: var(--color-danger);
  }
  .im-buy-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(6rem, auto) 7rem;
    gap: 0.6rem;
    align-items: center;
    min-height: 36px;
    padding: 0.2rem 0.6rem;
    border-top: 1px solid var(--color-line);
    border-left: 3px solid var(--color-warn);
  }
  .im-buy-name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    color: var(--color-text-bright);
  }
  .im-buy-count,
  .im-count {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--color-text);
  }
  .im-tree-kids {
    margin-left: 0.9rem;
    padding-left: 0.8rem;
    border-left: 1px dashed var(--color-line-strong);
  }
  .im-node {
    display: grid;
    grid-template-columns: minmax(12rem, 1.3fr) minmax(0, 1.4fr) 6rem 4.5rem;
    gap: 0.75rem;
    align-items: center;
    margin: 0.3rem 0;
    padding: 0.4rem 0.6rem;
    background: var(--color-panel);
    border-left: 3px solid var(--color-accent-dim);
  }
  .im-node.obtain-react {
    border-left-color: var(--color-powergrid);
  }
  .im-node.obtain-buy {
    border-left-color: var(--color-warn);
  }
  .im-node-name {
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
  button.im-node-name {
    cursor: pointer;
  }
  .im-chevron {
    display: inline-block;
    width: 0.8rem;
    color: var(--color-muted);
    font-size: 11px;
  }
  .im-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .im-obtain,
  .im-obtain-fixed {
    justify-self: end;
    font-size: 11px;
    min-width: 4rem;
    text-align: center;
  }
  .im-obtain {
    min-height: 28px;
    padding: 0 0.5rem;
  }
  .im-obtain-fixed {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--color-muted);
  }
  @container (max-width: 640px) {
    .im-body {
      grid-template-columns: minmax(0, 1fr);
    }
    .im-head {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .im-head-actions {
      grid-column: 1 / -1;
    }
    .im-head-actions button {
      flex: 1 1 auto;
      min-height: 40px;
    }
    /* Name, count and the build/buy button on one line; the tags below. */
    .im-node {
      grid-template-columns: minmax(0, 1fr) auto auto;
    }
    .im-tags {
      grid-column: 1 / -1;
      grid-row: 2;
    }
    .im-obtain,
    .im-obtain-fixed {
      min-height: 40px;
    }
    .im-start-row,
    .im-buy-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .im-invent-row {
      grid-template-columns: minmax(0, 1fr);
    }
    .im-decryptor select {
      min-height: 40px;
    }
    .im-start-runs,
    .im-buy-held {
      grid-column: 1 / -1;
      grid-row: 2;
      text-align: left;
    }
    .im-setup {
      min-height: 40px;
    }
  }
</style>
