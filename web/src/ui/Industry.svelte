<script lang="ts">
  // Industry page (goal R15): the player's blueprints with their efficiencies
  // and runs, the jobs they have running or waiting to collect, and the
  // facilities their region offers — everything BY NAME.
  //
  // A pure reader of the store's industry slice. Every call lives on the BFF
  // and in app/flow.ts; every identifier is translated to a name in
  // bridge/industry.ts before it reaches this file. Nothing here shows an
  // activityID, a status code, a blueprint typeID or a facilityID (R7d), and
  // nothing here computes a job outcome — the status a job shows, including
  // whether it is ready, is the one the SERVER returned.
  import { getContext, onMount, untrack } from "svelte";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { installTarget } from "../app/industryInstallTarget.ts";
  import {
    ACTIVITY_LABELS,
    ACTIVITY_ORDER,
    STATUS_LABELS,
    activityIsFor,
    formatDuration,
    inventionChoices,
    isActiveJob,
    jobAsChosen,
    jobCannotBeAsked,
    mostRunsToAsk,
    previewMaterials,
    previewTimeSeconds,
    jobFeeParts,
    materialsToUse,
    type IndustryJobFee,
    recipeFor,
    researchStanding,
    secondsUntil,
  } from "../bridge/industry.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { decryptorEffectWords, type DecryptorTerms } from "../bridge/industryInvention.ts";
  import { placeHasNow } from "../bridge/industryMaterials.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type {
    IndustryActivity,
    IndustryBlueprintRow,
    IndustryJobRow,
    IndustryJobStatus,
  } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  // R27 — the shared item icon: one cached picture per thing, falling back
  // to a name-derived tile whenever the icon cache has no entry (or no cache).
  import { formatIsk } from "./isk.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import PlaceRouteMenu from "./PlaceRouteMenu.svelte";
  import { panelErrorWords } from "../bridge/refusals.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const industry = store.industry;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const installRequest = installTarget.pending;

  let busy = $state(false);
  let error = $state("");
  /** Ticks once a second so job countdowns stay live without a server poll. */
  let nowMs = $state(Date.now());

  function typeName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID);
  }

  /** A facility's name. An NPC facility's id IS its station id, so the shared
   * station name cache answers it; a structure the cache does not know reads
   * as "an unnamed facility" rather than falling back to its number —
   * `resolvedName` is the R7d helper that never returns a raw ID. */
  function facilityName(facilityID: number): string {
    return resolvedName($names.resolved, "station", facilityID, "An unnamed facility");
  }
  /** The heading a job's or blueprint's row menu gives its facility (jobEntry.py 197, blueprintEntry.py 183). */
  const FACILITY_HEADING = { label: "UI/Industry/Facility", own: "Facility" } as const;

  function systemName(solarSystemID: number): string {
    return resolvedName($names.resolved, "system", solarSystemID, "an unknown system");
  }

  /** What a blueprint makes, from its static recipe. */
  function productName(blueprintTypeID: number): string | null {
    const definition = $industry.definitions[blueprintTypeID];
    if (!definition) {
      return null;
    }
    if (definition.productName) {
      return definition.productName;
    }
    return definition.productTypeID ? typeName(definition.productTypeID) : null;
  }

  /**
   * The kinds of work a blueprint can be put to, as names the player can read: those its type has a recipe for
   * that are for the blueprint as it is, an original or a copy (activityIsFor).
   */
  function blueprintActivities(blueprint: IndustryBlueprintRow): readonly IndustryActivity[] {
    const definition = $industry.definitions[blueprint.typeID];
    return definition
      ? definition.recipes.map((recipe) => recipe.activity).filter((activity) => activityIsFor(activity, blueprint.original))
      : [];
  }

  /** The most runs a copy of a blueprint can be licensed for: its type's own limit, and one where it has none. */
  function mostLicensedRuns(blueprint: IndustryBlueprintRow): number {
    return Math.max(1, $industry.definitions[blueprint.typeID]?.maxProductionLimit ?? 1);
  }

  /**
   * A blueprint's runs, in words. An ORIGINAL never runs out, so showing it a
   * run count would be actively misleading — the server's `runs` field is only
   * meaningful for a copy.
   */
  function runsText(blueprint: IndustryBlueprintRow): string {
    return blueprint.original ? "Unlimited (original)" : `${blueprint.runs} left`;
  }

  /**
   * A job's status as the window shows it: one the server still calls running whose end date has passed is ready, as
   * the client's industry service marks it each second (industrySvc.py _PollJobCompletionThreaded, 182 to 186: an
   * installed job whose endDate is before now, STATUS_READY). It stood at "Any moment now" with "Stop this job…"
   * until the window was read again.
   */
  function shownStatus(job: IndustryJobRow): IndustryJobStatus {
    if (job.status !== "running") return job.status;
    const remaining = secondsUntil(job.endDate, nowMs);
    return remaining !== null && remaining < 0 ? "ready" : job.status;
  }

  /** How long a running job has to go, or why it has no countdown. */
  function jobTimeText(job: IndustryJobRow): string {
    if (shownStatus(job) === "ready") {
      return "Finished — collect it";
    }
    if (!isActiveJob(job.status)) {
      return "—";
    }
    const remaining = secondsUntil(job.endDate, nowMs);
    if (remaining === null) {
      return "Unknown";
    }
    // A job past its end date that the server still calls "running" is simply
    // waiting to be re-read; say so rather than showing a negative countdown.
    return remaining <= 0 ? "Any moment now" : formatDuration(remaining);
  }

  const activeJobs = $derived.by(() => $industry.jobs.filter((job) => isActiveJob(job.status)));
  const finishedJobs = $derived.by(() =>
    $industry.jobs.filter((job) => !isActiveJob(job.status)),
  );

  /** Job slots in use, by activity name — only the activities actually used. */
  const slotRows = $derived.by(() =>
    ACTIVITY_ORDER.map((activity) => ({
      activity,
      used: $industry.slotsUsed[activity] ?? 0,
    })).filter((row) => row.used > 0),
  );

  /** Facilities that are online and will host at least one activity. */
  const usableFacilities = $derived.by(() =>
    $industry.facilities.filter((facility) => facility.activities.length > 0),
  );

  function taxText(tax: number | null): string {
    if (tax === null) {
      return "Unknown";
    }
    // The server speaks in fractions; players read percentages.
    const percent = tax * 100;
    return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
  }

  async function run(action: () => Promise<void>): Promise<void> {
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
        error =
          panelErrorWords(cause);
      }
    } finally {
      busy = false;
    }
  }

  // --- Starting a job ------------------------------------------------------
  // A three-step flow, because installing SPENDS things: pick a blueprint ->
  // choose the work, where, and how many runs -> see what it will take and
  // confirm. The BFF refuses an install without an explicit confirmation flag
  // too, so neither a stray click nor a stray request can spend anything.
  //
  // As the game's own client makes a job the moment a blueprint is chosen, at
  // the blueprint's own facility, and shows what it will take at once
  // (industryWnd.py 131 to 160): the pick chooses the work and the place for
  // the pilot and asks what the job will take straight away, where it can. The
  // pilot goes back to change any of them, and nothing is spent before the yes.

  /** The blueprint the player is setting a job up for, or null. */
  let startingBlueprint = $state<IndustryBlueprintRow | null>(null);
  let chosenActivity = $state<IndustryActivity | null>(null);
  let chosenFacilityID = $state<number | null>(null);
  let chosenRuns = $state(1);
  /**
   * A copy job only: the runs each copy is licensed for. The most the blueprint allows until the pilot says
   * another, which is where the game's own client starts a copy job.
   */
  let chosenLicensedRuns = $state(1);
  /** What goes with a copy job's request beside its runs: the runs each copy is licensed for. */
  const licensedForJob = $derived(chosenActivity === "copying" ? { licensedRuns: chosenLicensedRuns } : {});
  /** typeID -> how much of it the player HAS, read from the SERVER. */
  let availableMaterials = $state<Readonly<Record<string, number>> | null>(null);
  /** The number of the job's monitor, as the preview said it; null where it said none. */
  let previewMonitorID = $state<number | null>(null);
  /** The count of the server's tellings of a monitored place as the preview was asked: one counted by then is no later than it. */
  let previewedAtTelling = $state(0);
  /**
   * What the job's place has now: what the server last said of the job's monitor since the preview, or what the
   * preview had (industrySvc.OnIndustryMaterials sets the client's job.available, and its window shows it at once).
   */
  const placeHas = $derived(placeHasNow(availableMaterials, previewMonitorID, previewedAtTelling, $industry.materialsSaid));
  /** The seconds the job will take, as the preview reckoned them; null where it reckoned none. */
  let reckonedSeconds = $state<number | null>(null);
  /** What the job costs to start, as the preview reckoned it; null where it reckoned none. */
  let reckonedFee = $state<IndustryJobFee | null>(null);
  /** typeID -> how much of it the job will USE, as the preview reckoned it; null where it reckoned none. */
  let reckonedMaterials = $state<Readonly<Record<string, number>> | null>(null);
  /** The fee in a sentence: its total, and what it is made of where that is more than one thing. */
  const feeWords = $derived.by(() => {
    if (reckonedFee === null) {
      return null;
    }
    const isk = (amount: number): string => formatIsk(String(amount));
    const parts = jobFeeParts(reckonedFee);
    if (parts.length === 0) {
      return "Starting it costs nothing.";
    }
    const made = parts.length > 1 ? `: ${parts.map((part) => `${isk(part.amount)} for ${part.what}`).join(", ")}` : "";
    return `Starting it costs ${isk(reckonedFee.total)}${made}.`;
  });
  /** True once the player has asked to see the cost — the second step. */
  let confirming = $state(false);
  /**
   * Invention only: the decryptor to add, one per run. Every decryptor is
   * offered (static data); whether the hangar holds enough shows in the
   * preview, the way every other material does.
   */
  let chosenDecryptorTypeID = $state<number | null>(null);
  /** Every decryptor, read once when invention is first chosen; null until then. */
  let decryptors = $state<readonly DecryptorTerms[] | null>(null);
  let decryptorsAsked = false;
  /** The decryptor this job will send, or 0: only an invention carries one. */
  const decryptorForJob = $derived(chosenActivity === "invention" && chosenDecryptorTypeID !== null ? chosenDecryptorTypeID : 0);
  /**
   * Invention only, of a blueprint that could make one of several: the one this job is to make. The game's own
   * client sends no such job until one is chosen, and names none where the recipe has the one.
   */
  let chosenProductTypeID = $state<number | null>(null);
  /** The job awaiting an explicit "yes, cancel it" — never a one-click loss. */
  let cancellingJobID = $state<number | null>(null);

  /** Facilities that will take the chosen kind of work and are online. */
  const facilityChoices = $derived.by(() =>
    $industry.facilities.filter(
      (facility) =>
        facility.online &&
        (chosenActivity === null || facility.activities.includes(chosenActivity)),
    ),
  );

  const chosenRecipe = $derived.by(() => {
    if (!startingBlueprint || !chosenActivity) {
      return null;
    }
    return recipeFor($industry.definitions[startingBlueprint.typeID], chosenActivity);
  });

  /** The blueprints the chosen invention could make, where there is a choice of them; none otherwise. */
  const productChoices = $derived(inventionChoices(chosenRecipe));
  /** What goes with such an invention's request: the blueprint chosen of those. */
  const productForJob = $derived(
    chosenProductTypeID !== null && productChoices.includes(chosenProductTypeID) ? { productTypeID: chosenProductTypeID } : {},
  );
  /** True where the invention could make one of several and none of them is chosen yet. */
  const productUnchosen = $derived(productChoices.length > 0 && !("productTypeID" in productForJob));

  /**
   * What this job will consume: the preview's own reckoning where it made one (which is what goes with the job),
   * and the page's estimate where it made none.
   */
  const materialsForJob = $derived.by(() =>
    materialsToUse(
      startingBlueprint
        ? previewMaterials(chosenRecipe, chosenRuns, startingBlueprint.materialEfficiency, chosenLicensedRuns, decryptorForJob)
        : [],
      reckonedMaterials,
    ),
  );

  /** Each material this job will consume, paired with what the player has. */
  const materialLines = $derived.by(() => {
    if (!startingBlueprint) {
      return [];
    }
    // (An invention's decryptor is among them, one a run: previewMaterials lists it, and the preview reckons it.)
    return materialsForJob.materials.map((material) => {
      const have =
        placeHas === null ? null : placeHas[String(material.typeID)] ?? 0;
      return {
        typeID: material.typeID,
        need: material.quantity,
        have,
        short: have !== null && have < material.quantity,
      };
    });
  });

  /**
   * A research only: where the blueprint stands in it, and what the runs chosen would bring its research to. Null
   * for any other kind of work.
   */
  const research = $derived(
    startingBlueprint && chosenActivity ? researchStanding(chosenActivity, startingBlueprint, chosenRuns) : null,
  );

  const previewTime = $derived.by(() =>
    startingBlueprint
      ? previewTimeSeconds(chosenRecipe, chosenRuns, startingBlueprint.timeEfficiency, chosenLicensedRuns, research ? research.level : 0)
      : 0,
  );

  /** The most runs this blueprint could be asked for, of the chosen kind of work (mostRunsToAsk). */
  const maxRuns = $derived(startingBlueprint ? mostRunsToAsk(chosenActivity, startingBlueprint) : 1);

  /** Whether anything keeps the job from being asked about, as it is chosen now (bridge/industry.ts, jobCannotBeAsked). */
  const cannotAsk = $derived(
    startingBlueprint === null ||
      jobCannotBeAsked({
        activity: chosenActivity,
        facilityID: chosenFacilityID,
        runs: chosenRuns,
        researchFinished: research !== null && research.finished,
        productUnchosen,
        licensedRuns: chosenLicensedRuns,
        mostLicensedRuns: mostLicensedRuns(startingBlueprint),
      }),
  );

  function startJobFor(blueprint: IndustryBlueprintRow): void {
    startingBlueprint = blueprint;
    confirming = false;
    availableMaterials = null;
    previewMonitorID = null;
    reckonedSeconds = null;
    reckonedFee = null;
    reckonedMaterials = null;
    chosenRuns = 1;
    chosenLicensedRuns = mostLicensedRuns(blueprint);
    // The work and the place the client's window gives a job as its blueprint is chosen (bridge/industry.ts,
    // jobAsChosen): the blueprint's own facility, where the page has it and it takes the work.
    const chosen = jobAsChosen(blueprintActivities(blueprint), blueprint.facilityID, $industry.facilities);
    chosenActivity = chosen.activity;
    chosenFacilityID = chosen.facilityID;
    chosenDecryptorTypeID = null;
    chosenProductTypeID = null;
  }

  /**
   * The row's press: the job is made as its blueprint is chosen, and what it will take is asked at once, as the
   * client's window shows it at once (industryWnd.py 131 to 160; industrySvc.ConnectJob, 305 to 308). Where
   * something is wanting for the asking (no place the page has, an invention with several to choose of), the form
   * waits for the pilot.
   */
  function chooseBlueprint(blueprint: IndustryBlueprintRow): void {
    startJobFor(blueprint);
    if (!cannotAsk) {
      askToConfirm();
    }
  }

  function closeStartJob(): void {
    startingBlueprint = null;
    chosenActivity = null;
    chosenFacilityID = null;
    chosenDecryptorTypeID = null;
    chosenProductTypeID = null;
    availableMaterials = null;
    previewMonitorID = null;
    reckonedSeconds = null;
    reckonedFee = null;
    reckonedMaterials = null;
    confirming = false;
  }

  /**
   * "Never mind": the job is put away with nothing started. The game's own client keeps a job for as long as its
   * window has the blueprint, and what it kept open for it is no longer the window's once the job is gone; the
   * pilot's transport is told so.
   */
  function neverMind(): void {
    closeStartJob();
    void flow.industryJobLetGo();
  }

  /**
   * The blueprint's own time research and its material research, to go with a job's request: a job's time is
   * reckoned from the one, and a manufacturing job's materials from the other.
   */
  function researchOf(blueprint: IndustryBlueprintRow): { timeEfficiency?: number; materialEfficiency?: number } {
    const [time, material] = [blueprint.timeEfficiency, blueprint.materialEfficiency];
    return {
      ...(Number.isInteger(time) && time >= 0 && time <= 20 ? { timeEfficiency: time } : {}),
      ...(Number.isInteger(material) && material >= 0 && material <= 10 ? { materialEfficiency: material } : {}),
    };
  }

  // The decryptor list, once, the first time invention is the chosen work.
  $effect(() => {
    if (chosenActivity !== "invention" || decryptorsAsked) {
      return;
    }
    decryptorsAsked = true;
    void flow.loadDecryptors().then(
      (list) => {
        decryptors = list;
      },
      () => {
        // Without the list the job can still start, without a decryptor.
        decryptors = [];
      },
    );
  });

  /** Step two: ask the SERVER what the player actually has, then confirm. */
  function askToConfirm(): void {
    const blueprint = startingBlueprint;
    const activity = chosenActivity;
    const facilityID = chosenFacilityID;
    if (!blueprint || !activity || facilityID === null) {
      return;
    }
    const tellingsAsAsked = untrack(() => $industry.materialsSaid?.seq ?? 0);
    void run(async () => {
      const previewed = await flow.previewIndustryJob({
        blueprintItemID: blueprint.itemID,
        blueprintTypeID: blueprint.typeID,
        activity,
        facilityID,
        runs: chosenRuns,
        ...licensedForJob,
        ...(decryptorForJob > 0 ? { decryptorTypeID: decryptorForJob } : {}),
        ...productForJob,
        ...researchOf(blueprint),
      });
      availableMaterials = previewed.available;
      previewMonitorID = previewed.monitorID;
      previewedAtTelling = tellingsAsAsked;
      reckonedSeconds = previewed.timeSeconds;
      reckonedFee = previewed.fee;
      reckonedMaterials = previewed.materials;
      confirming = true;
    });
  }

  function confirmInstall(): void {
    const blueprint = startingBlueprint;
    const activity = chosenActivity;
    const facilityID = chosenFacilityID;
    if (!blueprint || !activity || facilityID === null) {
      return;
    }
    void run(async () => {
      await flow.installIndustryJob({
        blueprintItemID: blueprint.itemID,
        blueprintTypeID: blueprint.typeID,
        activity,
        facilityID,
        runs: chosenRuns,
        ...licensedForJob,
        ...(decryptorForJob > 0 ? { decryptorTypeID: decryptorForJob } : {}),
        ...productForJob,
        ...researchOf(blueprint),
      });
      closeStartJob();
    });
  }

  function deliver(jobID: number): void {
    void run(() => flow.deliverIndustryJob(jobID));
  }

  function cancelJob(jobID: number): void {
    cancellingJobID = null;
    void run(() => flow.cancelIndustryJob(jobID));
  }

  // R109 slice 5 — the Industry Manager's "Set up in Industry". It only fills
  // in step one of the flow above (the blueprint, the work, the runs); choosing
  // the facility, seeing the cost and confirming stay the player's. Served by
  // this pilot's panel alone, once its blueprints are read, and dropped when
  // served so a remount does not set the same job up again.
  $effect(() => {
    const request = $installRequest;
    const me = $station.online?.characterID ?? null;
    const loaded = $industry.loaded;
    if (request === null || me === null || request.characterID !== me || !loaded) {
      return;
    }
    const blueprint = $industry.blueprints.find((row) => row.itemID === request.blueprintItemID);
    // Its recipe arrives after the list; wait for it, or the work cannot be chosen.
    if (blueprint && !(blueprint.typeID in $industry.definitions)) {
      return;
    }
    untrack(() => {
      installTarget.served(request.n);
      if (!blueprint) {
        error = "That blueprint is not in this pilot's list any more.";
        return;
      }
      startJobFor(blueprint);
      if (blueprintActivities(blueprint).includes(request.activity)) {
        chosenActivity = request.activity;
      }
      chosenRuns = Math.min(Math.max(1, request.runs), mostRunsToAsk(chosenActivity, blueprint));
      // The blueprint's own facility, when this panel offers it: the server
      // installs the job nowhere else.
      if (facilityChoices.some((facility) => facility.facilityID === request.facilityID)) {
        chosenFacilityID = request.facilityID;
      }
      if (request.activity === "invention" && request.decryptorTypeID !== undefined) {
        chosenDecryptorTypeID = request.decryptorTypeID;
      }
      // The blueprint the plan wants invented: it counts where the blueprint could make another too.
      if (request.activity === "invention" && request.productTypeID !== undefined) {
        chosenProductTypeID = request.productTypeID;
      }
    });
  });

  onMount(() => {
    void run(() => flow.loadIndustry());
    const timer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
  /** The play page's windows (PlayApp's "retailChrome"): the browsers under the client's tabs (industryWnd.Industry). */
  const retail = getContext("retailChrome") === true;
  let browserTab = $state<"blueprints" | "facilities" | "jobs" | "research">("blueprints");
  const INDUSTRY_TABS: readonly { id: "blueprints" | "facilities" | "jobs" | "research"; label: string; own: string }[] = [
    { id: "blueprints", label: "UI/Industry/Blueprints", own: "Blueprints" },
    { id: "facilities", label: "UI/Industry/Facilities", own: "Facilities" },
    { id: "jobs", label: "UI/Industry/Jobs", own: "Jobs" },
    { id: "research", label: "UI/Journal/JournalWindow/Agents/Research", own: "Research" },
  ];
  /**
   * BrowserFacilities on the play page (browserFacilities.py, facilityEntry.py): its top row - the Owner combo (All
   * Facilities, Public Facilities, Corp-Owned: a facility owned by the pilot's corporation or not), the Activity
   * combo (All Activities and the six), a quick filter on the name, owner and type - and the scroll's columns Jumps,
   * Security, Facility, one per activity (the system cost index there: industry.Reference.SYSTEM modifiers, which the
   * page does not read - a dash where the facility hosts the activity), Tax with an activity chosen, Facility Type,
   * Owner. The Range combo and the jumps are not built (the page reads no distances).
   */
  const CLIENT_ACTIVITIES: readonly { id: IndustryActivity; label: string; icon: string }[] = [
    { id: "manufacturing", label: "UI/Industry/ActivityManufacturing", icon: "manufacturing" },
    { id: "copying", label: "UI/Industry/ActivityCopying", icon: "copying" },
    { id: "research_material", label: "UI/Industry/ActivityMaterialEfficiencyResearch", icon: "researchmaterial" },
    { id: "research_time", label: "UI/Industry/ActivityTimeEfficiencyResearch", icon: "researchtime" },
    { id: "invention", label: "UI/Industry/ActivityInvention", icon: "invention" },
    { id: "reaction", label: "UI/Industry/ActivityReaction", icon: "reaction" },
  ];
  let facOwner = $state<"any" | "npc" | "corp">("any");
  let facActivity = $state<IndustryActivity | "">("");
  let facFilter = $state("");
  let securityBySystem = $state<ReadonlyMap<number, number>>(new Map());
  $effect(() => {
    if (!retail || (browserTab !== "facilities" && browserTab !== "jobs") || securityBySystem.size) return;
    void flow.loadStarMap().then((map) => {
      securityBySystem = new Map(map.systems.filter((s) => typeof s[8] === "number").map((s) => [s[0], s[8] as number]));
    }).catch(() => {});
  });
  $effect(() => {
    if (!retail || browserTab !== "facilities") return;
    const refs = $industry.facilities.flatMap((f) => [{ kind: "type" as const, id: f.typeID }, { kind: "owner" as const, id: f.ownerID }]);
    if (refs.length) flow.requestNames(refs);
  });
  const shownFacilities = $derived.by(() => {
    const corp = $station.online?.corporationID ?? null;
    const q = facFilter.trim().toLowerCase();
    return usableFacilities.filter((f) => {
      if (facActivity && !f.activities.includes(facActivity)) return false;
      if (facOwner !== "any" && (f.ownerID === corp) !== (facOwner === "corp")) return false;
      if (q && !(facilityName(f.facilityID) + resolvedName($names.resolved, "owner", f.ownerID, "") + typeName(f.typeID)).toLowerCase().includes(q)) return false;
      return true;
    });
  });
  const INDUSTRY_TAB_WORDS = [...INDUSTRY_TABS.map((t) => t.label), ...CLIENT_ACTIVITIES.map((a) => a.label),
    "UI/Industry/AllFacilities", "UI/Industry/PublicFacilities", "UI/Industry/CorpOwnedFacilities", "UI/Industry/AllActivities",
    "UI/Common/Jumps", "UI/Common/Security", "UI/Industry/Facility", "UI/Industry/Tax", "UI/Industry/FacilityType", "UI/Common/Owner",
    "UI/Industry/NoFacilitiesFound"];
  $effect(() => { if (retail) flow.requestWords(INDUSTRY_TAB_WORDS); });
  /**
   * BrowserBlueprints on the play page (browserBlueprints.py, blueprintEntry.py): its top row - the Owner combo (Owned
   * by Me; the corporation's are not read), the Facility combo (All Facilities, then each facility holding blueprints
   * with their count), the Blueprint Type combo (All Blueprints, Originals, Copies), a quick filter - and the scroll's
   * columns Blueprint, Material Efficiency, Time Efficiency (gauges of 10 and 20), Runs Remaining (the infinity mark
   * for an original), Activities (the six small icons, the blueprint's own lit - a click opens the job's view on that
   * activity), Jumps and Facility (with All Facilities), Group, Availability. A blueprint in a job is dimmed (0.15).
   */
  let bpFacility = $state<number | null>(null);
  let bpKind = $state<"all" | "original" | "copy">("all");
  let bpFilter = $state("");
  $effect(() => {
    if (!retail || browserTab !== "blueprints") return;
    const refs = $industry.blueprints.flatMap((b) => [{ kind: "type" as const, id: b.typeID }, { kind: "typeGroup" as const, id: b.typeID }]);
    if (refs.length) flow.requestNames(refs);
  });
  const bpFacilityCounts = $derived.by(() => {
    const counts = new Map<number, number>();
    for (const b of $industry.blueprints) if (b.facilityID !== null) counts.set(b.facilityID, (counts.get(b.facilityID) ?? 0) + 1);
    return [...counts].sort((x, y) => facilityName(x[0]).localeCompare(facilityName(y[0])));
  });
  const shownBlueprints = $derived.by(() => {
    const q = bpFilter.trim().toLowerCase();
    return $industry.blueprints.filter((b) => {
      if (bpFacility !== null && b.facilityID !== bpFacility) return false;
      if (bpKind !== "all" && b.original !== (bpKind === "original")) return false;
      if (q && !typeName(b.typeID).toLowerCase().includes(q)) return false;
      return true;
    }).sort((x, y) => typeName(x.typeID).localeCompare(typeName(y.typeID)));
  });
  /** An activity's icon pressed on a blueprint's row (BlueprintEntry.OnActivityBtn): the job's view on that work. */
  function chooseBlueprintActivity(blueprint: IndustryBlueprintRow, activity: IndustryActivity): void {
    startJobFor(blueprint);
    chosenActivity = activity;
    if (!cannotAsk) askToConfirm();
  }
  /**
   * BrowserJobs on the play page (browserJobs.py, jobEntry.py, industry/mixins.py): its top row - Owner (Owned by Me),
   * Status (All Active Jobs, In Progress, Ready, Halted, History), Activity (All Activities and the six), Installer
   * (personal jobs: by me) - and the scroll's columns: the status icon (industryUIConst.GetStatusIconAndColor), Status
   * (JobStateContainer: a Deliver button on a ready job, else GetJobStateLabel - the time left over a progress gauge
   * coloured by the activity, or Succeeded / Failed / Cancelled), Runs ("x N"), Activity (its icon), Blueprint, Jumps,
   * Security, Facility, Output Location, Install Date, End Date; Deliver Selected / Deliver All Jobs at the bottom.
   */
  let jobStatus = $state<"active" | "running" | "ready" | "paused" | "history">("active");
  let jobActivity = $state<IndustryActivity | "">("");
  const shownJobs = $derived.by(() => $industry.jobs.filter((job) => {
    const st = shownStatus(job);
    if (jobActivity && job.activity !== jobActivity) return false;
    if (jobStatus === "active") return isActiveJob(job.status);
    if (jobStatus === "history") return !isActiveJob(job.status);
    return st === jobStatus;
  }).sort((a, b) => Number((a.endDate ?? 0n) - (b.endDate ?? 0n))));
  const readyJobs = $derived(shownJobs.filter((job) => shownStatus(job) === "ready"));
  function jobStatusIcon(job: IndustryJobRow): string {
    const st = shownStatus(job);
    return st === "running" ? "installed" : st === "paused" || st === "cancelled" ? "halted" : st === "ready" ? "ready" : "delivered";
  }
  function jobProgress(job: IndustryJobRow): number {
    const start = filetimeToUnixMs(job.startDate);
    const end = filetimeToUnixMs(job.endDate);
    if (start === null || end === null || end <= start) return 0;
    return Math.min(1, Math.max(0, (nowMs - start) / (end - start)));
  }
  /** GetJobStateLabel past the ready state: Succeeded, an invention's partial or failed outcome, Cancelled. */
  function jobOutcomeText(job: IndustryJobRow): string {
    if (job.status === "cancelled") return industryWord("UI/Industry/Cancelled") || "Cancelled";
    if (job.activity === "invention" && job.successfulRuns === 0) return industryWord("UI/Industry/JobFailed") || "Failed";
    if (job.activity === "invention" && job.successfulRuns < job.runs) return `${job.successfulRuns} / ${job.runs}`;
    return industryWord("UI/Industry/Succeeded") || "Succeeded";
  }
  /** FmtDate(..., 'ls'): the date and the hours and minutes, as the client writes them. */
  function jobDateText(value: bigint | null): string {
    const ms = filetimeToUnixMs(value);
    if (ms === null) return "";
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }
  const JOB_WORDS = ["UI/Industry/StatusAllActiveJobs", "UI/Industry/StatusInProgress", "UI/Industry/StatusReady",
    "UI/Industry/StatusHalted", "UI/Industry/StatusHistory", "UI/Industry/InstalledByMe", "UI/Generic/Status",
    "UI/Industry/JobRuns", "UI/Industry/Activity", "UI/Industry/OutputLocation",
    "UI/ScienceAndIndustry/ScienceAndIndustryWindow/InstallDate", "UI/ScienceAndIndustry/ScienceAndIndustryWindow/EndDate",
    "UI/Industry/NoJobsFound", "UI/Industry/Deliver", "UI/Industry/DeliverSelectedJobs", "UI/Industry/DeliverAllJobs",
    "UI/Industry/Cancelled", "UI/Industry/JobFailed", "UI/Industry/Succeeded"];
  onMount(() => { if (retail) flow.requestWords(JOB_WORDS); });
  /**
   * The job's view on top of the window (industryWnd VIEW_HEIGHT 418: views/baseView.py BaseView - topCont 18 high with
   * the blueprint's name at left 24, mainCont 400 high over the 400 x 400 circle bgCircle / bgCircleBorder in the job's
   * colour at 0.3, COLOR_FRAME with no job; views/blueprintCenter.py BlueprintCenter - the 90 frame bgFrame and a 75
   * frame at 0.1 round the 64 icon, the four wedges (84 x 60, 60 x 84) of a 150 box, travelled in 15 with a job, their
   * patterns in the job's colour; ContainerME / ContainerTE 79 x 30 at (113, -25) and (113, 25) - icon, value in
   * COLOR_READY / COLOR_FRAME, a 6-high gauge of MAX 10 / 20; the runs remaining (its caption by the activity) 90 from
   * the top and the Job Runs edit 100 below the centre).
   */
  const JOB_COLORS: Record<string, string> = { manufacturing: "#ff9900", reaction: "#12e6c9" };
  const viewColor = $derived(startingBlueprint && chosenActivity ? JOB_COLORS[chosenActivity] ?? "#3372b6" : "#666666");
  const runsRemainingCaption = $derived.by(() => {
    if (!startingBlueprint || !chosenActivity) return "";
    if (chosenActivity === "manufacturing" || chosenActivity === "invention")
      return startingBlueprint.original ? industryWord("UI/Industry/MaximumRuns") || "Maximum Runs" : industryWord("UI/Industry/RunsRemaining") || "Runs Remaining";
    if (chosenActivity === "research_material" || chosenActivity === "research_time") return industryWord("UI/Industry/LevelsRemaining") || "Levels Remaining";
    return industryWord("UI/Industry/MaximumRuns") || "Maximum Runs";
  });
  const runsRemainingValue = $derived(startingBlueprint ? (startingBlueprint.original ? maxRuns : Math.min(startingBlueprint.runs, maxRuns)) : 0);
  /**
   * The view's inputs (views/materialGroups.py, materialGroup.py, material.py; industryUIConst.GetIndustryGroupID,
   * mixins.GetMaterialsByGroups): the job's materials in industry groups by their type's group / category - a
   * decryptor the optional group - each sorted by type, the groups by (count, group) downward and then placed by
   * GROUPORDERINDEXES_BY_NUMGROUPS; six rows of 60 (8 between) shared out by GROUP_NUMROWS, or by what the groups need;
   * the background for that share (GROUP_BACKGROUNDS); a group's 22 icon at 7 and its materials 45 x 60 from 38, 48
   * apart, 66 a row, five a row at most (GetNumPerRow); a material's 32 picture at 6, its quantity (FmtAmt 'ss') and a 3
   * high gauge of what is had, COLOR_READY or COLOR_NOTREADY with the not-ready pattern. With no material, the caption
   * NoBlueprintSelectedCaption / NoInputItemsRequired in the left half.
   */
  const IND_GROUP_BY_GROUP: Readonly<Record<number, number>> = { 18: 1, 423: 1, 530: 2, 528: 2, 886: 2, 754: 4, 966: 4, 427: 5, 428: 5, 429: 5,
    712: 5, 974: 5, 334: 6, 913: 6, 873: 6, 964: 6, 1136: 6, 536: 6, 716: 9, 333: 10 };
  const IND_GROUP_BY_CATEGORY: Readonly<Record<number, number>> = { 43: 3, 42: 3, 35: 8 };
  const IND_GROUP_ICON: Readonly<Record<number, string>> = { 1: "groupmineral", 2: "grouprefinedmaterials", 3: "groupplantarymaterials",
    4: "groupsalavagematerials", 5: "groupreactionmaterials", 6: "groupcomponents", 8: "groupdecryptors", 9: "groupdatainterfaces",
    10: "groupdatacores", 11: "groupitems", 12: "groupdatainterfaces", 13: "groupitems" };
  const GROUP_NUMROWS: readonly (readonly number[])[] = [[6], [3, 3], [2, 2, 2], [2, 1, 1, 2], [1, 1, 2, 1, 1], [1, 1, 1, 1, 1, 1]];
  const GROUP_BACKGROUND: Readonly<Record<string, string>> = { "6": "bg1groups", "3,3": "bg2groups", "2,2,2": "bg3groups", "2,1,1,2": "bg4groups",
    "1,1,2,1,1": "bg5groups", "1,1,1,1,1,1": "bg6groups", "2,3,1": "bggroups_2_3_1", "3,1,1,1": "bggroups_3_1_1_1", "4,2": "bggroups_4_2", "5,1": "bggroups_5_1" };
  const GROUP_ORDER: readonly (readonly number[])[] = [[0], [0, 1], [1, 0, 2], [0, 3, 2, 1], [1, 3, 0, 4, 2], [4, 2, 0, 1, 3, 5]];
  let typeGroups = $state<ReadonlyMap<number, { readonly groupID: number | null; readonly categoryID: number | null } | null>>(new Map());
  $effect(() => {
    if (!retail) return;
    const wanted = materialLines.map((m) => m.typeID).filter((typeID) => !untrack(() => typeGroups.has(typeID)));
    if (!wanted.length) return;
    void flow.industryTypeGroups(wanted).then((found) => { typeGroups = new Map([...typeGroups, ...found]); }).catch(() => {});
  });
  function industryGroupOf(typeID: number): number {
    if (typeID === decryptorForJob) return 13;
    if (typeID === 30386) return 11;
    const facts = typeGroups.get(typeID);
    const byGroup = facts?.groupID != null ? IND_GROUP_BY_GROUP[facts.groupID] : undefined;
    if (byGroup !== undefined) return byGroup;
    const byCategory = facts?.categoryID != null ? IND_GROUP_BY_CATEGORY[facts.categoryID] : undefined;
    if (byCategory !== undefined) return byCategory;
    return 11;
  }
  const inputGroups = $derived.by(() => {
    const byGroup = new Map<number, (typeof materialLines)[number][]>();
    for (const line of materialLines) {
      const id = industryGroupOf(line.typeID);
      byGroup.set(id, [...(byGroup.get(id) ?? []), line]);
    }
    const isShip = (typeID: number) => typeGroups.get(typeID)?.categoryID === 6;
    const sorted = [...byGroup].map(([id, lines]) => [id, [...lines].sort((a, b) => Number(isShip(b.typeID)) - Number(isShip(a.typeID)) || a.typeID - b.typeID)] as const)
      .sort((a, b) => b[1].length - a[1].length || b[0] - a[0]).slice(0, 6);
    const ordered = sorted.length ? (GROUP_ORDER[sorted.length - 1] ?? []).flatMap((i) => (sorted[i] ? [sorted[i]] : [])) : [];
    // _GetNumRowsByGroup: the share for so many groups, unless a group needs more rows and they fit in six.
    const share = ordered.length ? [...(GROUP_NUMROWS[ordered.length - 1] ?? [])] : [];
    const needed = ordered.map(([, lines]) => Math.ceil(lines.length / 5));
    const total = needed.reduce((a, b) => a + b, 0);
    let rows = share;
    if (total <= 6 && needed.some((n, i) => n > (share[i] ?? 0))) {
      rows = [...needed];
      if (total < 6) rows[rows.length - 1] = (rows[rows.length - 1] ?? 0) + 6 - total;
    }
    let top = 1;
    const groups = ordered.map(([id, lines], i) => {
      const numRows = rows[i] ?? 1;
      const height = 60 * numRows + 8 * Math.max(0, numRows - 1);
      const perRow = numRows >= 2 && lines.length > 3 ? Math.min(5, Math.ceil(lines.length / 2)) : lines.length;
      const usedRows = Math.ceil(lines.length / Math.max(1, perRow));
      const group = { id, lines, top, height, perRow, contTop: (height - (66 * (usedRows - 1) + 60)) / 2 };
      top += height + 8;
      return group;
    });
    return { groups, background: GROUP_BACKGROUND[rows.join(",")] ?? "bg1groups" };
  });
  function materialAmount(n: number): string {
    const label = n < 100_000 ? "FmtThousandShort" : n < 100_000_000 ? "FmtMillionShort" : "FmtBillionShort";
    const template = $words.templates[`/Carbon/UI/Common/Formatting/${label}`];
    if (n < 10_000) return n.toLocaleString("en-US");
    const value = n / (n < 100_000 ? 1e3 : n < 100_000_000 ? 1e6 : 1e9);
    return typeof template === "string" ? plainText(formatTemplate(template, { amount: value }, { nameOf: () => "" })) : `${value.toFixed(1)}${label[3]}`;
  }
  const VIEW_WORDS = ["UI/Industry/NoBlueprintSelectedCaption", "UI/Industry/NoInputItemsRequired", "UI/Industry/JobActive",
    "/Carbon/UI/Common/Formatting/FmtThousandShort", "/Carbon/UI/Common/Formatting/FmtMillionShort", "/Carbon/UI/Common/Formatting/FmtBillionShort",
    "UI/Industry/JobRuns", "UI/Industry/MaximumRuns", "UI/Industry/RunsRemaining", "UI/Industry/LevelsRemaining"];
  onMount(() => { if (retail) flow.requestWords(VIEW_WORDS); });
  const BLUEPRINT_WORDS = ["UI/Industry/OwnedByMe", "UI/Industry/AllBlueprints", "UI/Industry/Originals", "UI/Industry/Copies",
    "UI/Industry/Blueprint", "UI/Industry/MaterialEfficiency", "UI/Industry/TimeEfficiency", "UI/Industry/RunsRemaining",
    "UI/Industry/Activities", "UI/Common/Group", "UI/ScienceAndIndustry/ScienceAndIndustryWindow/Availability",
    "UI/Industry/NoBlueprintsFound", "UI/Industry/ActivityNotAvailable"];
  onMount(() => { if (retail) flow.requestWords(BLUEPRINT_WORDS); });

  function industryWord(label: string): string {
    const t = $words.templates[label];
    return typeof t === "string" ? t : "";
  }
</script>

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Industry</h2>
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={() => run(() => flow.loadIndustry())}>
        Refresh
      </button>
    </p>
  </header>
  {#if error}
    <p class="error">{error}</p>
  {/if}
  <!-- (A refusal the client's own dialog said is not said again here: ClientDialogs.svelte.) -->
  {#if $industry.actionError && !$industry.actionErrorSaid}
    <p class="error">Last change failed: {$industry.actionError}</p>
  {/if}
  {#if !$industry.loaded}
    <p class="note">Loading your industry…</p>
  {/if}
</section>

{#if $industry.loaded}
  <div class="ind-layout" class:retail data-tab={retail ? browserTab : undefined}>
  {#if retail}
    <!-- industryWnd.Industry's browser tabs (TabGroup 26 high, labels padded 12): Blueprints, Facilities, Jobs,
         Research - one browser shown at a time; the job's view (Start a job) stays above them -->
    <div class="ind-cv" class:job={startingBlueprint !== null} style={`--job: ${viewColor}`}>
      <div class="ind-cv-top">{startingBlueprint ? typeName(startingBlueprint.typeID) : ""}</div>
      <div class="ind-cv-main">
        <div class="ind-cv-inputs" style={`--bg: url(/client-res/ui/texture/classes/industry/input/${inputGroups.background}.png)`}>
          {#if inputGroups.groups.length === 0}
            <div class="ind-cv-noitems">{startingBlueprint ? industryWord("UI/Industry/NoInputItemsRequired") || "No input items required" : industryWord("UI/Industry/NoBlueprintSelectedCaption") || "No blueprint selected"}</div>
          {/if}
          {#each inputGroups.groups as g (g.id)}
            <div class="ind-cv-group" style={`top: ${g.top}px; height: ${g.height}px`}>
              <img class="ind-cv-group-icon" alt="" src={`/client-res/ui/texture/classes/industry/groups/${IND_GROUP_ICON[g.id]}.png`} />
              {#each g.lines as m, i (m.typeID)}
                {@const ready = m.have === null || !m.short}
                <div class={`ind-cv-mat ${ready ? "ready" : "short"}`} style={`left: ${38 + (i % g.perRow) * 48}px; top: ${g.contTop + 66 * Math.floor(i / g.perRow)}px`}
                  title={`${typeName(m.typeID)}: ${m.need.toLocaleString("en-US")}${m.have !== null ? ` (${m.have.toLocaleString("en-US")})` : ""}`}>
                  <span class="glow"></span><span class="pic"><TypeIcon typeID={m.typeID} name={typeName(m.typeID)} size="md" /></span>
                  <span class="gauge"><span style={`width: ${m.have === null ? 100 : Math.min(1, m.have / Math.max(1, m.need)) * 100}%`}></span></span>
                  <small>{materialAmount(m.need)}</small>
                </div>
              {/each}
            </div>
          {/each}
        </div>
        <div class="ind-cv-circle"><span class="border"></span></div>
        <div class="ind-cv-center">
          <div class="ind-cv-wedges">
            {#each ["top", "bottom", "left", "right"] as side (side)}
              <div class={`wedge ${side}`}><span class="lines"></span><span class="dots"></span><span class="bg"></span></div>
            {/each}
          </div>
          <span class="ind-cv-frame75"></span><span class="ind-cv-frame90"></span>
          {#if startingBlueprint}
            <span class="ind-cv-icon"><TypeIcon typeID={startingBlueprint.typeID} name={typeName(startingBlueprint.typeID)} size="lg" /></span>
            {#if runsRemainingCaption}
              <div class="ind-cv-remaining"><small>{runsRemainingCaption}</small><span>{runsRemainingValue}</span></div>
            {/if}
            <label class="ind-cv-runs"><small>{industryWord("UI/Industry/JobRuns") || "Job Runs"}</small>
              <input type="number" min="1" max={maxRuns} bind:value={chosenRuns} disabled={busy || confirming} /></label>
          {/if}
          {#each [{ k: "me", v: startingBlueprint?.materialEfficiency ?? 0, max: 10 }, { k: "te", v: startingBlueprint?.timeEfficiency ?? 0, max: 20 }] as m (m.k)}
            <div class={`ind-cv-mete ${m.k}`}>
              <img alt="" src={`/client-res/ui/texture/classes/industry/icon${m.k}.png`} />
              <b class:ready={m.v > 0}>{m.v}%</b>
              <span class="gauge"><span style={`width: ${Math.max(0, m.v) / m.max * 100}%`}></span></span>
            </div>
          {/each}
        </div>
      </div>
    </div>
    <nav class="ind-tabs">
      {#each INDUSTRY_TABS as t (t.id)}
        <button type="button" class:active={browserTab === t.id} onclick={() => (browserTab = t.id)}>{industryWord(t.label) || t.own}</button>
      {/each}
    </nav>
    {#if browserTab === "research"}<p class="note ind-research">Research agents are not in the play page yet.</p>{/if}
  {/if}
  {#if retail}
  <section class="ind-jobs ind-jobs-client">
    <div class="ind-fac-top">
      <select><option>{industryWord("UI/Industry/OwnedByMe") || "Owned by Me"}</option></select>
      <select bind:value={jobStatus}>
        <option value="active">{industryWord("UI/Industry/StatusAllActiveJobs") || "All Active Jobs"}</option>
        <option value="running">{industryWord("UI/Industry/StatusInProgress") || "In Progress"}</option>
        <option value="ready">{industryWord("UI/Industry/StatusReady") || "Ready"}</option>
        <option value="paused">{industryWord("UI/Industry/StatusHalted") || "Halted"}</option>
        <option value="history">{industryWord("UI/Industry/StatusHistory") || "History"}</option>
      </select>
      <select bind:value={jobActivity}>
        <option value="">{industryWord("UI/Industry/AllActivities") || "All Activities"}</option>
        {#each CLIENT_ACTIVITIES as a (a.id)}<option value={a.id}>{industryWord(a.label) || ACTIVITY_LABELS[a.id]}</option>{/each}
      </select>
      <select><option>{industryWord("UI/Industry/InstalledByMe") || "Installed by Me"}</option></select>
    </div>
    {#if $industry.jobsError}<p class="error">{$industry.jobsError}</p>{/if}
    <div class="ind-scroll">
      <table>
        <thead><tr>
          <th></th><th>{industryWord("UI/Generic/Status") || "Status"}</th><th>{industryWord("UI/Industry/JobRuns") || "Runs"}</th>
          <th>{industryWord("UI/Industry/Activity") || "Activity"}</th><th>{industryWord("UI/Industry/Blueprint") || "Blueprint"}</th>
          <th class="r">{industryWord("UI/Common/Jumps") || "Jumps"}</th><th>{industryWord("UI/Common/Security") || "Security"}</th>
          <th>{industryWord("UI/Industry/Facility") || "Facility"}</th><th>{industryWord("UI/Industry/OutputLocation") || "Output Location"}</th>
          <th>{industryWord("UI/ScienceAndIndustry/ScienceAndIndustryWindow/InstallDate") || "Install Date"}</th>
          <th>{industryWord("UI/ScienceAndIndustry/ScienceAndIndustryWindow/EndDate") || "End Date"}</th>
        </tr></thead>
        <tbody>
          {#each shownJobs as job (job.jobID)}
            {@const st = shownStatus(job)}
            {@const sec = securityBySystem.get(job.solarSystemID)}
            {@const act = CLIENT_ACTIVITIES.find((a) => a.id === job.activity)}
            <tr>
              <td class="ic"><img class="ind-status" alt="" src={`/client-res/ui/texture/classes/industry/status/${jobStatusIcon(job)}.png`} /></td>
              <td class="ind-job-state">
                {#if st === "ready"}
                  <button type="button" class="ind-deliver" disabled={busy} onclick={() => deliver(job.jobID)}><b>{industryWord("UI/Industry/Deliver") || "Deliver"}</b></button>
                {:else if isActiveJob(job.status)}
                  <span>{jobTimeText(job)}</span>
                  {#if st === "running"}<span class={`ind-job-gauge ${job.activity === "manufacturing" ? "mfg" : job.activity === "reaction" ? "rx" : "sci"}`}><span style={`width: ${jobProgress(job) * 100}%`}></span></span>{/if}
                {:else}
                  <span class={job.status === "cancelled" || (job.activity === "invention" && job.successfulRuns === 0) ? "ind-not-ready" : ""}>{jobOutcomeText(job)}</span>
                {/if}
              </td>
              <td>x {job.runs}</td>
              <td class="ic">{#if act}<img class="ind-act" alt="" title={industryWord(act.label) || ACTIVITY_LABELS[act.id]} src={`/client-res/ui/texture/classes/industry/${act.icon}.png`} />{/if}</td>
              <td><span class="ind-bp-name"><TypeIcon typeID={job.blueprintTypeID} name={typeName(job.blueprintTypeID)} />{typeName(job.blueprintTypeID)}</span></td>
              <td class="r">—</td>
              <td>{#if sec !== undefined}<span style={`color: ${securityStatusColor(sec)}`}>{shownSecurity(sec).toFixed(1)}</span>{/if}</td>
              <td>{facilityName(job.facilityID)}</td>
              <td>{facilityName(job.facilityID)}</td>
              <td>{jobDateText(job.startDate)}</td><td>{jobDateText(job.endDate)}</td>
            </tr>
          {:else}
            <tr><td colspan="11" class="ind-none">{industryWord("UI/Industry/NoJobsFound") || "No jobs found"}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <div class="ind-jobs-bottom">
      <button type="button" disabled={busy || readyJobs.length === 0} onclick={() => { for (const job of readyJobs) deliver(job.jobID); }}>{industryWord("UI/Industry/DeliverAllJobs") || "Deliver All Jobs"}</button>
    </div>
  </section>
  {:else}
  <section class="ind-jobs">
    <h2>Jobs you have running</h2>
    {#if $industry.jobsError}
      <p class="error">Your jobs could not be loaded: {$industry.jobsError}</p>
    {/if}
    {#if slotRows.length > 0}
      <p class="note">
        Job slots in use:
        {#each slotRows as row, index (row.activity)}{index > 0
            ? ", "
            : ""}{ACTIVITY_LABELS[row.activity]} {row.used}{/each}.
      </p>
    {/if}
    {#if activeJobs.length === 0}
      <p class="empty">Nothing in progress right now.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Making</th>
              <th>Work</th>
              <th class="num">Runs</th>
              <th>Where</th>
              <th>Status</th>
              <th class="num">Time left</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each activeJobs as job (job.jobID)}
              <tr>
                <td data-label="Making">{typeName(job.productTypeID)}</td>
                <td data-label="Work">
                  {job.activity ? ACTIVITY_LABELS[job.activity] : "Unknown work"}
                </td>
                <td class="num" data-label="Runs">{job.runs}</td>
                <td data-label="Where">
                  {facilityName(job.facilityID)}
                  <PlaceRouteMenu {store} {flow} placeID={job.facilityID} heading={FACILITY_HEADING} />
                </td>
                <td data-label="Status">{STATUS_LABELS[shownStatus(job)]}</td>
                <td class="num" data-label="Time left">{jobTimeText(job)}</td>
                <td data-label="Action">
                  <div class="row-actions">
                    <!-- One or the other, as the client's own button is (submitButton.ClickFunc): a job
                         that is ready is collected, and only a job that is not is stopped. -->
                    {#if shownStatus(job) === "ready"}
                      <button type="button" disabled={busy} onclick={() => deliver(job.jobID)}>
                        Collect the results
                      </button>
                    {:else if cancellingJobID === job.jobID}
                      <button
                        type="button"
                        class="danger"
                        disabled={busy}
                        onclick={() => cancelJob(job.jobID)}
                      >
                        Yes, stop it and lose the materials
                      </button>
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => (cancellingJobID = null)}
                      >
                        Keep it running
                      </button>
                    {:else}
                      <button
                        type="button"
                        class="minor"
                        disabled={busy}
                        onclick={() => (cancellingJobID = job.jobID)}
                      >
                        Stop this job…
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if cancellingJobID !== null}
        <p class="error">
          Stopping a job gives the blueprint back, but the materials it already
          used and the fee you paid to start it are gone for good.
        </p>
      {/if}
    {/if}
  </section>

  {#if finishedJobs.length > 0}
    <section class="ind-jobs">
      <h2>Jobs you have finished</h2>
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Made</th>
              <th>Work</th>
              <th class="num">Runs</th>
              <th>Where</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {#each finishedJobs as job (job.jobID)}
              <tr>
                <td data-label="Made">{typeName(job.productTypeID)}</td>
                <td data-label="Work">
                  {job.activity ? ACTIVITY_LABELS[job.activity] : "Unknown work"}
                </td>
                <td class="num" data-label="Runs">
                  {job.status === "cancelled" ? "—" : job.successfulRuns || job.runs}
                </td>
                <td data-label="Where">
                  {facilityName(job.facilityID)}
                  <PlaceRouteMenu {store} {flow} placeID={job.facilityID} heading={FACILITY_HEADING} />
                </td>
                <td data-label="Outcome">{STATUS_LABELS[job.status]}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
  {/if}

  {#if retail}
  <section class="ind-blueprints ind-bp-client">
    <div class="ind-fac-top">
      <select><option>{industryWord("UI/Industry/OwnedByMe") || "Owned by Me"}</option></select>
      <select class="wide" bind:value={bpFacility}>
        <option value={null}>{industryWord("UI/Industry/AllFacilities") || "All Facilities"}</option>
        {#each bpFacilityCounts as [id, count] (id)}<option value={id}>{facilityName(id)} ({count})</option>{/each}
      </select>
      <select bind:value={bpKind}>
        <option value="all">{industryWord("UI/Industry/AllBlueprints") || "All Blueprints"}</option>
        <option value="original">{industryWord("UI/Industry/Originals") || "Originals"}</option>
        <option value="copy">{industryWord("UI/Industry/Copies") || "Copies"}</option>
      </select>
      <input type="search" placeholder="Filter" bind:value={bpFilter} />
    </div>
    {#if $industry.blueprintsError}<p class="error">{$industry.blueprintsError}</p>{/if}
    <div class="ind-scroll">
      <table>
        <thead><tr>
          <th>{industryWord("UI/Industry/Blueprint") || "Blueprint"}</th>
          <th>{industryWord("UI/Industry/MaterialEfficiency") || "Material Efficiency"}</th>
          <th>{industryWord("UI/Industry/TimeEfficiency") || "Time Efficiency"}</th>
          <th>{industryWord("UI/Industry/RunsRemaining") || "Runs Remaining"}</th>
          <th>{industryWord("UI/Industry/Activities") || "Activities"}</th>
          {#if bpFacility === null}<th class="r">{industryWord("UI/Common/Jumps") || "Jumps"}</th><th>{industryWord("UI/Industry/Facility") || "Facility"}</th>{/if}
          <th>{industryWord("UI/Common/Group") || "Group"}</th>
          <th>{industryWord("UI/ScienceAndIndustry/ScienceAndIndustryWindow/Availability") || "Availability"}</th>
        </tr></thead>
        <tbody>
          {#each shownBlueprints as b (b.itemID)}
            {@const acts = blueprintActivities(b)}
            <tr class={b.jobID !== null ? "ind-busy" : ""} ondblclick={() => { if (b.jobID === null) chooseBlueprint(b); }}>
              <td><span class="ind-bp-name"><TypeIcon typeID={b.typeID} name={typeName(b.typeID)} />{typeName(b.typeID)}</span></td>
              <td><span class="ind-gauge" title={`${b.materialEfficiency}`}><span style={`width: ${b.materialEfficiency * 10}%`}></span></span> {b.materialEfficiency}</td>
              <td><span class="ind-gauge" title={`${b.timeEfficiency}`}><span style={`width: ${b.timeEfficiency * 5}%`}></span></span> {b.timeEfficiency}</td>
              <td>{#if b.original}<img class="ind-inf" alt="∞" src="/client-res/ui/texture/classes/industry/infinity.png" />{:else}{b.runs}{/if}</td>
              <td class="ind-acts">
                {#each CLIENT_ACTIVITIES as a (a.id)}
                  {@const on = acts.includes(a.id)}
                  <button type="button" class:on disabled={!on || b.jobID !== null || busy}
                    title={on ? industryWord(a.label) || ACTIVITY_LABELS[a.id] : industryWord("UI/Industry/ActivityNotAvailable") || "Activity not available"}
                    onclick={() => chooseBlueprintActivity(b, a.id)}><img alt="" src={`/client-res/ui/texture/classes/industry/${a.icon}.png`} /></button>
                {/each}
              </td>
              {#if bpFacility === null}<td class="r">—</td><td>{b.facilityID !== null ? facilityName(b.facilityID) : "—"}</td>{/if}
              <td>{resolvedName($names.resolved, "typeGroup", b.typeID, "")}</td>
              <td>{b.jobID !== null ? "In use" : ""}</td>
            </tr>
          {:else}
            <tr><td colspan="10" class="ind-none">{industryWord("UI/Industry/NoBlueprintsFound") || "No blueprints found"}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
  {:else}
  <section class="ind-blueprints">
    <h2>Your blueprints</h2>
    {#if $industry.blueprintsError}
      <p class="error">Your blueprints could not be loaded: {$industry.blueprintsError}</p>
    {/if}
    {#if $industry.blueprints.length === 0}
      <p class="empty">You do not own any blueprints.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Blueprint</th>
              <th>Makes</th>
              <th class="num">Runs</th>
              <th class="num">Material efficiency</th>
              <th class="num">Time efficiency</th>
              <th>Where</th>
              <th>Can be used for</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {#each $industry.blueprints as blueprint (blueprint.itemID)}
              <tr class={startingBlueprint?.itemID === blueprint.itemID ? "self" : ""}>
                <td data-label="Blueprint">
                  <span class="cell-item">
                    <TypeIcon typeID={blueprint.typeID} name={typeName(blueprint.typeID)} />
                    {typeName(blueprint.typeID)}
                  </span>
                  {#if blueprint.jobID !== null}
                    <small class="note">in use by a job</small>
                  {/if}
                </td>
                <td data-label="Makes">{productName(blueprint.typeID) ?? "—"}</td>
                <td class="num" data-label="Runs">{runsText(blueprint)}</td>
                <!-- Spelled out, never "ME"/"TE" (R9a). -->
                <td class="num" data-label="Material efficiency">
                  {blueprint.materialEfficiency}% saved
                </td>
                <td class="num" data-label="Time efficiency">{blueprint.timeEfficiency}% faster</td>
                <!-- Its facility, as the client's blueprint list has it (blueprintEntry.py, the Facility column), with its
                     route entries. -->
                <td data-label="Where">
                  {#if blueprint.facilityID !== null}
                    {facilityName(blueprint.facilityID)}
                    <PlaceRouteMenu {store} {flow} placeID={blueprint.facilityID} heading={FACILITY_HEADING} />
                  {:else}
                    <span class="note">—</span>
                  {/if}
                </td>
                <td data-label="Can be used for">
                  {#if blueprintActivities(blueprint).length === 0}
                    <span class="note">—</span>
                  {:else}
                    {blueprintActivities(blueprint)
                      .map((activity) => ACTIVITY_LABELS[activity])
                      .join(", ")}
                  {/if}
                </td>
                <td data-label="Action">
                  {#if blueprint.jobID !== null}
                    <span class="note">Busy</span>
                  {:else if startingBlueprint?.itemID === blueprint.itemID}
                    <button type="button" class="minor" disabled={busy} onclick={neverMind}>
                      Never mind
                    </button>
                  {:else}
                    <button type="button" disabled={busy} onclick={() => chooseBlueprint(blueprint)}>
                      Start a job…
                    </button>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
  {/if}

  {#if startingBlueprint}
    <section class="bulk ind-view">
      <h2>Start a job with {typeName(startingBlueprint.typeID)}</h2>
      {#if blueprintActivities(startingBlueprint).length === 0}
        <p class="note">
          Nothing is known about what this blueprint can be used for, so a job
          cannot be set up for it here.
        </p>
      {:else}
        <p class="controls">
          <label>
            Work
            <select bind:value={chosenActivity} disabled={busy || confirming}>
              {#each blueprintActivities(startingBlueprint) as activity (activity)}
                <option value={activity}>{ACTIVITY_LABELS[activity]}</option>
              {/each}
            </select>
          </label>
          <label>
            Where
            <select bind:value={chosenFacilityID} disabled={busy || confirming}>
              <option value={null}>Choose a facility…</option>
              {#each facilityChoices as facility (facility.facilityID)}
                <option value={facility.facilityID}>
                  {facilityName(facility.facilityID)} — {systemName(facility.solarSystemID)}
                </option>
              {/each}
            </select>
          </label>
          <label>
            {chosenActivity === "copying" ? "Copies" : research ? "Levels" : "Runs"}
            <input
              type="number"
              min="1"
              max={maxRuns}
              bind:value={chosenRuns}
              disabled={busy || confirming}
            />
          </label>
          {#if chosenActivity === "copying"}
            <label>
              Runs on each copy
              <input
                type="number"
                min="1"
                max={mostLicensedRuns(startingBlueprint)}
                bind:value={chosenLicensedRuns}
                disabled={busy || confirming}
                data-job-licensed-runs
              />
            </label>
          {/if}
          {#if chosenActivity === "invention"}
            <label>
              Decryptor
              <select bind:value={chosenDecryptorTypeID} disabled={busy || confirming || decryptors === null}>
                <option value={null}>{decryptors === null ? "Reading decryptors…" : "No decryptor"}</option>
                {#each decryptors ?? [] as decryptor (decryptor.typeID)}
                  <option value={decryptor.typeID}>{decryptorEffectWords(decryptor)}</option>
                {/each}
              </select>
            </label>
          {/if}
          {#if productChoices.length > 0}
            <label>
              To invent
              <select bind:value={chosenProductTypeID} disabled={busy || confirming} data-job-product>
                <option value={null}>Choose a blueprint…</option>
                {#each productChoices as typeID (typeID)}
                  <option value={typeID}>{typeName(typeID)}</option>
                {/each}
              </select>
            </label>
          {/if}
        </p>

        {#if facilityChoices.length === 0}
          <p class="note">
            No facility where you are will take that kind of work.
          </p>
        {/if}

        {#if research}
          <p class="note" data-job-research={research.finished ? "finished" : "left"}>
            {#if research.finished}
              It cannot be researched any further.
            {:else}
              This takes its {chosenActivity === "research_time" ? "time efficiency" : "material efficiency"} from
              {research.from}% to {research.to}%.
            {/if}
          </p>
        {/if}

        {#if !confirming}
          <p class="controls">
            <button
              type="button"
              disabled={busy || cannotAsk}
              onclick={askToConfirm}
            >
              See what this will take
            </button>
          </p>
        {:else}
          <h3>What this job will use</h3>
          {#if materialLines.length === 0}
            <p class="empty">This job does not use any materials.</p>
          {:else}
            <div class="table-wrap overflow-x-auto">
              <table class="guests reflow" data-job-materials={materialsForJob.exact ? "reckoned" : "rough"}>
                <thead>
                  <tr><th>Material</th><th class="num">{materialsForJob.exact ? "It will use" : "It will use about"}</th><th class="num">You have</th></tr>
                </thead>
                <tbody>
                  {#each materialLines as line (line.typeID)}
                    <tr class={line.short ? "self" : ""}>
                      <td data-label="Material">
                        <span class="cell-item">
                          <TypeIcon typeID={line.typeID} name={typeName(line.typeID)} />
                          {typeName(line.typeID)}
                        </span>
                      </td>
                      <td class="num" data-label={materialsForJob.exact ? "It will use" : "It will use about"}>{line.need}</td>
                      <td class="num" data-label="You have">
                        {line.have === null ? "—" : line.have}
                        {#if line.short}
                          <small class="note">not enough</small>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
          <p class="note">
            {#if reckonedSeconds !== null}
              <span data-job-time="reckoned">It will take {formatDuration(reckonedSeconds)}.</span>
            {:else}
              <span data-job-time="rough">It should take about {formatDuration(previewTime)}.</span>
            {/if}
            {#if feeWords !== null}
              <span data-job-fee="reckoned">{feeWords}</span>
              {#if !materialsForJob.exact}
                The amounts above are an estimate — the facility you picked may work
                out cheaper, which the server works out when you confirm.
              {/if}
            {:else if materialsForJob.exact}
              <span data-job-fee="unknown">The station also charges a fee to start
              the job, which the server works out when you confirm, and you will see
              what was actually charged straight afterwards.</span>
            {:else}
              <span data-job-fee="unknown">The amounts above
              are an estimate — the facility you picked may work out cheaper, and
              the station also charges a fee to start the job. Both are worked out
              by the server when you confirm, and you will see what was actually
              charged straight afterwards.</span>
            {/if}
          </p>
          <p class="error">
            Starting this job spends the materials and the fee immediately.
            Stopping it later does not give either back.
          </p>
          <p class="controls">
            <button type="button" class="danger" disabled={busy} onclick={confirmInstall}>
              Yes, start the job
            </button>
            <button
              type="button"
              class="minor"
              disabled={busy}
              onclick={() => (confirming = false)}
            >
              Go back
            </button>
          </p>
        {/if}
      {/if}
    </section>
  {/if}

  {#if retail}
  <section class="ind-facilities ind-fac-client">
    <div class="ind-fac-top">
      <select bind:value={facOwner}>
        <option value="any">{industryWord("UI/Industry/AllFacilities") || "All Facilities"}</option>
        <option value="npc">{industryWord("UI/Industry/PublicFacilities") || "Public Facilities"}</option>
        <option value="corp">{industryWord("UI/Industry/CorpOwnedFacilities") || "Corp-Owned Facilities"}</option>
      </select>
      <select bind:value={facActivity}>
        <option value="">{industryWord("UI/Industry/AllActivities") || "All Activities"}</option>
        {#each CLIENT_ACTIVITIES as a (a.id)}<option value={a.id}>{industryWord(a.label) || ACTIVITY_LABELS[a.id]}</option>{/each}
      </select>
      <input type="search" placeholder="Filter" bind:value={facFilter} />
    </div>
    <div class="ind-scroll">
      <table>
        <thead><tr>
          <th class="r">{industryWord("UI/Common/Jumps") || "Jumps"}</th><th>{industryWord("UI/Common/Security") || "Security"}</th>
          <th>{industryWord("UI/Industry/Facility") || "Facility"}</th>
          {#each CLIENT_ACTIVITIES as a (a.id)}<th class="ic" title={industryWord(a.label) || ACTIVITY_LABELS[a.id]}><img alt="" src={`/client-res/ui/texture/classes/industry/${a.icon}.png`} /></th>{/each}
          {#if facActivity}<th class="r">{industryWord("UI/Industry/Tax") || "Tax"}</th>{/if}
          <th>{industryWord("UI/Industry/FacilityType") || "Facility Type"}</th><th>{industryWord("UI/Common/Owner") || "Owner"}</th>
        </tr></thead>
        <tbody>
          {#each shownFacilities as f (f.facilityID)}
            {@const sec = securityBySystem.get(f.solarSystemID)}
            <tr>
              <td class="r">—</td>
              <td>{#if sec !== undefined}<span style={`color: ${securityStatusColor(sec)}`}>{shownSecurity(sec).toFixed(1)}</span>{/if}</td>
              <td>{facilityName(f.facilityID)}{#if !f.online}<small class="note"> offline</small>{/if}</td>
              {#each CLIENT_ACTIVITIES as a (a.id)}<td class="ic">{f.activities.includes(a.id) ? "—" : ""}</td>{/each}
              {#if facActivity}<td class="r">{taxText(f.tax)}</td>{/if}
              <td>{typeName(f.typeID)}</td><td>{resolvedName($names.resolved, "owner", f.ownerID, "")}</td>
            </tr>
          {:else}
            <tr><td colspan="12" class="ind-none">{industryWord("UI/Industry/NoFacilitiesFound") || "No facilities found"}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
  {:else}
  <section class="ind-facilities">
    <h2>Places you can work</h2>
    {#if $industry.facilitiesError}
      <p class="error">Nearby facilities could not be loaded: {$industry.facilitiesError}</p>
    {/if}
    {#if usableFacilities.length === 0}
      <p class="empty">No industry facilities are available where you are.</p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Facility</th>
              <th>System</th>
              <th class="num">Work it takes</th>
              <th class="num">Fee</th>
            </tr>
          </thead>
          <tbody>
            {#each usableFacilities as facility (facility.facilityID)}
              <tr>
                <td data-label="Facility">
                  {facilityName(facility.facilityID)}
                  {#if !facility.online}
                    <small class="note">offline</small>
                  {/if}
                </td>
                <td data-label="System">{systemName(facility.solarSystemID)}</td>
                <td class="num" data-label="Work it takes">
                  {facility.activities.map((activity) => ACTIVITY_LABELS[activity]).join(", ")}
                </td>
                <td class="num" data-label="Fee">{taxText(facility.tax)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
  {/if}
  </div>
{/if}
