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
  const INDUSTRY_TAB_WORDS = INDUSTRY_TABS.map((t) => t.label);
  $effect(() => { if (retail) flow.requestWords(INDUSTRY_TAB_WORDS); });
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
    <nav class="ind-tabs">
      {#each INDUSTRY_TABS as t (t.id)}
        <button type="button" class:active={browserTab === t.id} onclick={() => (browserTab = t.id)}>{industryWord(t.label) || t.own}</button>
      {/each}
    </nav>
    {#if browserTab === "research"}<p class="note ind-research">Research agents are not in the play page yet.</p>{/if}
  {/if}
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
  </div>
{/if}
