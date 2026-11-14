<script lang="ts">
  // Planets page (goal R41): the colonies this character has built, and what is
  // on each planet.
  //
  // A pure reader of the store's planets slice. Nothing here shows a planetID,
  // a systemID, a typeID or a pinID (R7d) — a place is its NAME and a structure
  // is its NAME. Raw ids appear only in `{#each}` keys, in TypeIcon's typeID and
  // in onclick arguments, which is exactly where they belong.
  //
  // ⚠ NOTHING HERE SIMULATES A COLONY. Cycle times, quantities per cycle and
  // both instants are the emulator's own numbers. The single judgement this
  // panel makes is whether an expiry has PASSED, and it makes it against the
  // server's clock (clockOffsetMs), not the browser's.
  //
  // ⚠ THREE OUTCOMES, THREE DIFFERENT SENTENCES. "Still loading", "that read
  // failed", and "you genuinely have no colonies" are distinct facts. The last
  // is claimed ONLY from `hasNoColonies`, which the store sets only when the
  // read succeeded AND the gateway actually carried a colony table. A fourth
  // case exists and is worded separately: the read succeeded but the gateway
  // reported no colony table at all — that is not evidence of anything.
  //
  // READ ONLY. The emulator does expose a write (restart the expired
  // extractors); this slice ships looking before it ships acting.
  //
  // ⚠ THE MONITOR IS ALLOWED TO SAY NOTHING. Every "needs you" line comes from
  // bridge/colonyAttention.ts, which raises a finding only from a fact the
  // server actually stated — never from a null. A colony with nothing to say
  // gets no line, and that silence is the part a player has to be able to
  // trust: it is what lets them close the tab.
  import { getContext, onMount } from "svelte";
  import {
    attentionByColony,
    attentionSummaryWords,
    colonyLineWords,
    pinFill,
  } from "../bridge/colonyAttention.ts";
  import {
    colonyPlaceWords,
    formatDuration,
    pooledContents,
    programHasExpired,
    programProgress,
    serverNow,
  } from "../bridge/planets.ts";
  import { factoryRecipeWords } from "../bridge/piFactoryWords.ts";
  import { isSessionLost } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { Colony, ColonyPin } from "../store/types.ts";
  import TypeIcon from "./TypeIcon.svelte";
  import PlanetLaunches from "./PlanetLaunches.svelte";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { shownSecurity, securityStatusRgb } from "../bridge/systemSecurity.ts";
  import { romanLevel } from "../bridge/skills.ts";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const planets = store.planets;
  // svelte-ignore state_referenced_locally
  const launchesRead = flow.planetLaunches;
  // svelte-ignore state_referenced_locally
  const words = store.words;

  // ReconstructWindow (planetWindow.py 40 to 53): with launches, two tabs, Colonies and Launches; without, the
  // colonies alone. The launches are read as the window is built (onMount).
  const TAB_WORDS = {
    colonies: "UI/ScienceAndIndustry/ScienceAndIndustryWindow/Colonies",
    launches: "UI/ScienceAndIndustry/ScienceAndIndustryWindow/Launches",
  } as const;
  $effect(() => {
    flow.requestWords(Object.values(TAB_WORDS));
  });
  function tabWord(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" && template !== "" ? plainText(template) : own;
  }
  let chosenTab = $state<"colonies" | "launches">("colonies");
  const hasLaunches = $derived($launchesRead.launches.length > 0);
  const shownTab = $derived(hasLaunches ? chosenTab : "colonies");

  let busy = $state(false);
  let error = $state("");

  // Ticks so a countdown moves. The INSTANTS never change between reads — only
  // this reference "now" does, so nothing on screen can drift past what the
  // server said.
  let browserNowMs = $state(Date.now());

  const colonies = $derived($planets.colonies ?? []);
  const nowMs = $derived(serverNow($planets.clockOffsetMs, browserNowMs));

  // Only the colonies with something to say, loudest first. Recomputed as the
  // clock ticks, because an expiry passing is exactly what turns a quiet
  // colony into a loud one.
  // The recipe table lets a starved factory be judged against what it needs.
  const attention = $derived(attentionByColony(colonies, nowMs, undefined, $planets.recipes));
  const summaryWords = $derived(attentionSummaryWords(attention));
  const findingsByPlanetID = $derived(
    new Map(attention.map((entry) => [entry.colony.planetID, entry.findings])),
  );

  const openColony = $derived<Colony | null>(
    $planets.selectedPlanetID === null
      ? null
      : (colonies.find((colony) => colony.planetID === $planets.selectedPlanetID) ?? null),
  );

  /** What a structure does, in a player's words rather than a group name. */
  function pinRole(pin: ColonyPin): string {
    switch (pin.kind) {
      case "command":
        return "Command centre";
      case "extractor-control":
        return "Extractor";
      case "extractor":
        return "Extractor head";
      case "factory":
        return "Factory";
      case "storage":
        return "Storage";
      case "launchpad":
        return "Launchpad";
      default:
        return "Structure";
    }
  }

  function units(quantity: number): string {
    return `${quantity.toLocaleString()} unit${quantity === 1 ? "" : "s"}`;
  }

  /** "Running, 7h 12m left" / "Finished" / "Never programmed". */
  function programWords(pin: ColonyPin): string {
    const program = pin.program;
    if (!program || program.expiresAtMs === null) {
      return "No program installed";
    }
    if (programHasExpired(program, nowMs)) {
      return "Finished — this extractor has stopped";
    }
    return `Running — ${formatDuration(program.expiresAtMs - nowMs)} left`;
  }

  function cycleWords(pin: ColonyPin): string {
    const program = pin.program;
    if (!program || program.cycleTimeSeconds <= 0) {
      return "";
    }
    return `${program.quantityPerCycle.toLocaleString()} per ${formatDuration(
      program.cycleTimeSeconds * 1000,
    )} cycle`;
  }

  function headWords(pin: ColonyPin): string {
    const heads = pin.program?.headCount ?? 0;
    return heads === 1 ? "1 head" : `${heads} heads`;
  }

  /** "9,900 of 10,000 m3 - 99% full", or "" when either half is unreadable. */
  function fillWords(pin: ColonyPin): string {
    const fill = pinFill(pin);
    if (fill === null || typeof pin.usedM3 !== "number" || typeof pin.capacityM3 !== "number") {
      return "";
    }
    const used = Math.round(pin.usedM3).toLocaleString();
    const capacity = Math.round(pin.capacityM3).toLocaleString();
    return `${used} of ${capacity} m3 - ${Math.min(100, Math.floor(fill * 100))}% full`;
  }

  /** The one-line state of a colony in the list (shared with the PI Manager). */
  function colonyWords(colony: Colony): string {
    return colonyLineWords(colony, findingsByPlanetID.get(colony.planetID) ?? [], nowMs);
  }

  function toggle(colony: Colony): void {
    flow.selectColony(
      $planets.selectedPlanetID === colony.planetID ? null : colony.planetID,
    );
  }

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "Your session ended. Pick your character again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      busy = false;
    }
  }

  // planet/planetsWindow/coloniesPanel.py ColoniesPanel on the play page: a ColonyEntry per colony (120 high; the
  // planet's icon in a column as wide; a caption bar "<sec> <planet> - <type> - N installations"; No Industrial
  // Activity where it has none), then ColonyEntryEmpty for the slots up to MAX_NUM_COLONIES 6 - an open one
  // (slotUnlocked.png 98) under Interplanetary Consolidation's level + 1 with RequiresCommandCenter (the Barren Command
  // Center's market group, 1322), the rest locked (slotLocked.png 68 on the hatch) with RequiresSkillLevelX - each
  // captioned Unestablished Colony; at the bottom View / Warp To / Access, enabled by a colony chosen.
  const retail = getContext("retailChrome") === true;
  const MAX_NUM_COLONIES = 6;
  const INTERPLANETARY_CONSOLIDATION = 2495;
  const COMMAND_CENTER_MARKET_GROUP = 1322;
  const PI_WORDS = ["UI/PI/Common/UnestablishedColony", "UI/PI/Common/RequiresCommandCenter", "UI/PI/Common/RequiresSkillLevelX", "UI/PI/Common/NumInstallations",
    "UI/PI/Common/NoIndustrialActivity", "UI/Common/View", "UI/PI/Common/ViewInPlanetMode", "UI/Commands/WarpTo", "UI/PI/Common/Access", "UI/PI/Common/AccessCustomOffice"];
  // svelte-ignore state_referenced_locally
  const piWords = store.words;
  // svelte-ignore state_referenced_locally
  const piNames = store.names;
  // svelte-ignore state_referenced_locally
  const piSkills = store.skills;
  const piText = (label: string, args: Record<string, unknown> = {}) =>
    formatTemplate($piWords.templates[label] ?? "", args as never, { nameOf: (k, id) => resolvedName($piNames.resolved, k, id, "") });
  const piFollowerOf = (url: string, t: string) => linkFollowerOf(url, flow, null, (label) => plainText($piWords.templates[label] ?? LINK_WORDS[label] ?? ""), t);
  const slotsTotal = $derived((($piSkills.skills ?? []).find((s) => s.typeID === INTERPLANETARY_CONSOLIDATION)?.level ?? 0) + 1);
  let chosenColony = $state<number | null>(null);
  function colonySecurity(systemID: number): string {
    const level = $piNames.systemSecurity[systemID];
    if (level === undefined || level === null) return "";
    const shown = shownSecurity(level), [r, g, b] = securityStatusRgb(level);
    return `<color=0xff${[r, g, b].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}>${shown.toFixed(1)}</color>`;
  }
  $effect(() => {
    if (!retail) return;
    flow.requestWords([...PI_WORDS, ...Object.keys(LINK_WORDS)]);
    flow.requestNames([{ kind: "type", id: INTERPLANETARY_CONSOLIDATION }]);
    const systems = [...new Set(colonies.map((c) => c.solarSystemID))];
    if (systems.length > 0) flow.requestSystemSecurity(systems);
    if ($piSkills.skills === null) void flow.loadSkills().catch(() => {});
  });

  onMount(() => {
    void run(() => flow.loadPlanets());
    void flow.loadPlanetLaunches().catch(() => undefined);
    const timer = setInterval(() => {
      browserNowMs = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
</script>

<section class="panel" class:pl-retail={retail}>
  <header class="panel-head">
    <h2 class="panel-title">Planets</h2>
    <p class="controls">
      <button
        type="button"
        class="primary"
        disabled={busy}
        onclick={() => void run(() => flow.loadPlanets())}
      >
        Refresh
      </button>
    </p>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if hasLaunches}
    <nav class="tabs">
      <button type="button" class:active={shownTab === "colonies"} onclick={() => (chosenTab = "colonies")}>{tabWord(TAB_WORDS.colonies, "Colonies")}</button>
      <button type="button" class:active={shownTab === "launches"} onclick={() => (chosenTab = "launches")}>{tabWord(TAB_WORDS.launches, "Launches")}</button>
    </nav>
  {/if}

  {#if shownTab === "launches"}
    <PlanetLaunches {store} {flow} {nowMs} />
  {:else if retail && $planets.loaded && !$planets.error}
    <div class="pc">
      <div class="pc-scroll">
        {#each colonies as colony (colony.planetID)}
          <button type="button" class="pc-entry" class:pc-selected={chosenColony === colony.planetID} onclick={() => (chosenColony = colony.planetID)}>
            <span class="pc-icon"><TypeIcon typeID={colony.planetTypeID} name={colony.planetTypeName ?? ""} size="lg" /></span>
            <span class="pc-body">
              <span class="pc-caption"><LabelText markup={`${colonySecurity(colony.solarSystemID)} ${colony.planetName ?? ""} - ${colony.planetTypeName ?? ""} - ${plainText(piText("UI/PI/Common/NumInstallations", { numInstallations: colony.pins.length }))}`} followerOf={piFollowerOf} /></span>
              {#if colony.pins.length === 0}<span class="pc-text">{plainText(piText("UI/PI/Common/NoIndustrialActivity"))}</span>{/if}
            </span>
          </button>
        {/each}
        {#each Array.from({ length: Math.max(0, MAX_NUM_COLONIES - colonies.length) }, (_, i) => colonies.length + i) as slot (slot)}
          {@const locked = slot >= slotsTotal}
          <div class="pc-entry pc-empty">
            <span class="pc-icon" class:pc-locked={locked}><img alt="" class:pc-slot-locked={locked}
              src={locked ? "/client-res/ui/texture/planet/planetswnd/slotlocked.png" : "/client-res/ui/texture/planet/planetswnd/slotunlocked.png"} /></span>
            <span class="pc-body">
              <span class="pc-caption">{plainText(piText("UI/PI/Common/UnestablishedColony"))}</span>
              <span class="pc-text"><LabelText followerOf={piFollowerOf} markup={locked
                ? piText("UI/PI/Common/RequiresSkillLevelX", { typeID: INTERPLANETARY_CONSOLIDATION, skillLevel: romanLevel(slot) })
                : piText("UI/PI/Common/RequiresCommandCenter", { marketGroupID: COMMAND_CENTER_MARKET_GROUP })} /></span>
            </span>
          </div>
        {/each}
      </div>
      <!-- the ButtonGroup: View, Warp To, Access - disabled until a colony is chosen (Warp To and Access here stay so) -->
      <div class="pc-buttons">
        <button type="button" disabled={chosenColony === null} title={plainText(piText("UI/PI/Common/ViewInPlanetMode"))}>{plainText(piText("UI/Common/View")) || "View"}</button>
        <button type="button" disabled>{plainText(piText("UI/Commands/WarpTo")) || "Warp To"}</button>
        <button type="button" disabled title={plainText(piText("UI/PI/Common/AccessCustomOffice"))}>{plainText(piText("UI/PI/Common/Access")) || "Access"}</button>
      </div>
    </div>
  {:else if !$planets.loaded}
    <p class="note">Looking for your colonies…</p>
  {:else if $planets.error}
    <!-- A FAILED read. Worded deliberately unlike the empty case: "you have no
         colonies" is a claim only a SUCCESSFUL read may make. -->
    <p class="error">
      Your colonies could not be read just now, so there may be planets you
      cannot see here. Try again in a moment.
    </p>
  {:else if $planets.hasNoColonies}
    <!-- ⚠ A FACT FROM A SUCCESSFUL EMPTY READ, not an inference from absence. -->
    <p class="note">
      You have not built on any planet yet. Drop a command centre on a planet
      in-game and the colony will show up here.
    </p>
  {:else if colonies.length === 0}
    <!-- The fourth case: the read worked but carried no colony table at all.
         That says nothing about whether this character has colonies, so this
         must NOT say "you have none". -->
    <p class="note">
      This server did not report any colony information, so there is nothing to
      show. That is not the same as having no colonies.
    </p>
  {:else}
    <p class="note">
      You have {colonies.length === 1 ? "one colony" : `${colonies.length} colonies`}.
    </p>

    <!-- The whole point of the panel: where to go, before any planet is
         opened. Absent entirely when every colony is quiet — no "all good"
         banner, because an empty space says it without being read. -->
    {#if summaryWords}
      <section class="attention">
        <h3>{summaryWords}</h3>
        <ul class="plain-list">
          {#each attention as entry (entry.colony.planetID)}
            <li>
              <span class="asset-place">
                <TypeIcon
                  typeID={entry.colony.planetTypeID}
                  name={entry.colony.planetTypeName ?? colonyPlaceWords(entry.colony)}
                />
                <strong>{colonyPlaceWords(entry.colony)}</strong>
                <span class="muted">{entry.needsYouNow ? "now" : "coming up"}</span>
              </span>
              <ul class="plain-list reasons">
                {#each entry.findings as finding (`${finding.pinID ?? "colony"}:${finding.kind}`)}
                  <li>
                    {finding.words}{#if finding.dueAtMs !== null && finding.dueAtMs > nowMs}
                      — in {formatDuration(finding.dueAtMs - nowMs)}
                    {:else if finding.dueAtMs !== null}
                      — {formatDuration(nowMs - finding.dueAtMs)} ago
                    {/if}
                  </li>
                {/each}
              </ul>
              <div class="row-actions">
                <button type="button" disabled={busy} onclick={() => toggle(entry.colony)}>
                  {$planets.selectedPlanetID === entry.colony.planetID
                    ? "Hide this colony"
                    : "See this colony"}
                </button>
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- R8: the record table scrolls inside its OWN box and reflows to labelled
         cards below 640px, so the page body never scrolls sideways. -->
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            <th>Planet</th>
            <th>System</th>
            <th>State</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each colonies as colony (colony.planetID)}
            <tr>
              <td data-label="Planet">
                <span class="asset-place">
                  <TypeIcon
                    typeID={colony.planetTypeID}
                    name={colony.planetTypeName ?? colonyPlaceWords(colony)}
                  />
                  {colonyPlaceWords(colony)}
                </span>
              </td>
              <td data-label="System">{colony.solarSystemName ?? "an unnamed system"}</td>
              <td data-label="State">{colonyWords(colony)}</td>
              <td data-label="">
                <div class="row-actions">
                  <button type="button" disabled={busy} onclick={() => toggle(colony)}>
                    {$planets.selectedPlanetID === colony.planetID
                      ? "Hide this colony"
                      : "See this colony"}
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if openColony}
      <section class="panel inner">
        <header class="panel-head">
          <h3>{colonyPlaceWords(openColony)}</h3>
          <p class="note">
            {openColony.planetTypeName ?? "an unnamed kind of planet"} ·
            command centre level {openColony.commandCenterLevel} ·
            {openColony.linkCount === 1 ? "1 link" : `${openColony.linkCount} links`} ·
            {openColony.routes.length === 1
              ? "1 route"
              : `${openColony.routes.length} routes`}
          </p>
        </header>

        {#if (findingsByPlanetID.get(openColony.planetID) ?? []).length}
          <h4>What needs you here</h4>
          <ul class="plain-list">
            {#each findingsByPlanetID.get(openColony.planetID) ?? [] as finding (`${finding.pinID ?? "colony"}:${finding.kind}`)}
              <li>{finding.words}</li>
            {/each}
          </ul>
        {/if}

        <h4>What is on this planet</h4>
        <ul class="plain-list">
          {#each openColony.pins as pin (pin.pinID)}
            {@const factory = pin.kind === "factory" ? factoryRecipeWords($planets.recipes, pin) : null}
            <li>
              <span class="asset-place">
                <TypeIcon typeID={pin.typeID} name={pin.typeName} />
                <strong>{pin.typeName}</strong>
                <span class="muted">{pinRole(pin)}</span>
              </span>
              {#if pin.kind === "extractor-control"}
                <p class="note">
                  {programWords(pin)}
                  {#if pin.program?.resourceTypeName}
                    · pulling {pin.program.resourceTypeName}
                  {/if}
                  {#if cycleWords(pin)}
                    · {cycleWords(pin)}
                  {/if}
                  · {headWords(pin)}
                </p>
                {#if pin.program && programProgress(pin.program, nowMs) !== null}
                  <progress
                    max="1"
                    value={programProgress(pin.program, nowMs)}
                    aria-label="Program progress"
                  ></progress>
                {/if}
              {/if}
              {#if factory}
                <p class="note">
                  {factory.making}
                  {#if factory.rate}
                    · {factory.rate}
                  {/if}
                  <!-- ⚠ Only an explicit false is an alarm. null means this pin
                       has no such state, and says nothing. -->
                  {#if pin.receivedInputsLastCycle === false}
                    · fed nothing last cycle
                  {/if}
                </p>
                {#if factory.needs}
                  <p class="note">{factory.needs}</p>
                {/if}
              {/if}
              {#if pin.contents.length}
                <p class="note">
                  Holding {pin.contents
                    .map((item) => `${item.typeName} (${units(item.quantity)})`)
                    .join(", ")}
                </p>
              {/if}
              <!-- A volume, not a unit count: 12,000 Aqueous Liquids is the
                   biggest pile on the planet and 0.5% of the hold. -->
              {#if fillWords(pin)}
                <p class="note">{fillWords(pin)}</p>
              {/if}
            </li>
          {/each}
        </ul>

        {#if pooledContents(openColony).length}
          <h4>Everything stored here</h4>
          <ul class="plain-list">
            {#each pooledContents(openColony) as item (item.typeID)}
              <li>
                <span class="asset-place">
                  <TypeIcon typeID={item.typeID} name={item.typeName} />
                  {item.typeName} — {units(item.quantity)}
                </span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if openColony.routes.length}
          <h4>What moves where</h4>
          <ul class="plain-list">
            {#each openColony.routes as route (route.routeID)}
              <li>
                {route.commodityTypeName ?? "an unnamed commodity"} —
                {units(route.commodityQuantity)} per run, across
                {route.path.length === 2
                  ? "one link"
                  : `${route.path.length - 1} links`}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</section>

<style>
  /* Icon and name read as one thing, and wrap together rather than letting the
     name run away from its picture on a narrow screen (R8). */
  .asset-place {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    flex-wrap: wrap;
  }

  .panel.inner {
    margin-top: 1rem;
  }

  /* The attention block reads as a notice, not as another table. It is absent
     entirely when nothing is waiting, so it never becomes furniture the eye
     learns to skip. */
  .attention {
    margin: 0 0 1rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--color-line, #23303d);
    border-left: 3px solid var(--color-warn, #d4a13a);
    border-radius: 4px;
  }

  .attention h3 {
    margin: 0 0 0.75rem;
    font-size: 15px;
  }

  .attention .reasons {
    margin: 0.25rem 0 0.5rem;
    padding-left: 1rem;
    gap: 0.25rem;
    color: var(--color-muted, #8fa3b8);
    font-size: 13px;
  }

  .attention .reasons > li {
    border-top: 0;
    padding-top: 0;
    list-style: disc;
  }

  .plain-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .plain-list > li {
    border-top: 1px solid var(--color-line, #23303d);
    padding-top: 0.75rem;
  }

  .plain-list > li:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .muted {
    color: var(--color-muted, #8fa3b8);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* A bar the player can read at a glance; the VALUE is the server's, this is
     only how wide it is drawn. */
  progress {
    width: 100%;
    max-width: 320px;
    height: 8px;
  }
</style>
