<script lang="ts">
  // eve/client/script/ui/shared/info/panels/panelFreelanceProjects.PanelFreelanceProjects - Show Info's Freelance
  // Projects tab of a player corporation (infosvc.UpdateDataCorp adds TAB_FREELANCE_PROJECTS where not IsNPC; its
  // name UI/Metadata/ContentTags/FreelanceProjects). The top row: PanelTitle and ExtraInfoWrapper {extraInfo} - the
  // corporation's active projects (get_amount_active_for_corporation, '-' until read) -, on the right the filter menu
  // (FreelanceShowInfoFilterMenuButtonIcon: OnlyMyActiveJobs, OnlyProjectsICanAccept, FilterJobsIHaveContributedTo,
  // HaveUnclaimedRewardsFor; CareerPath Any or each), the quick filter (120 wide, the title) and the sort menu
  // (FreelanceSortByMenuButtonIcon, the setting ActiveFreelanceProjectsSortBy - the Corporation window's Freelance
  // Jobs shares it). The jobs (FreelanceJobProviderSection): request_projects_for_corporation (GetAllActiveForCorporation)
  // those of the corporation still active (_is_relevant) as job cards; a card opens the job board's page of the job
  // (open_freelance_project). Empty: NoCorporationJobsContainer - NoProjectsFoundForCorpTitle / Body, OpenAIR (the job
  // board's browse page); a failed read FailureToLoad (Title, Description, the refresh Button).
  // Opened on this tab by ShowInfo(typeCorporation, corpID, selectTabType=TAB_FREELANCE_PROJECTS) - the job page's
  // ViewMoreForCorporation: the section is scrolled to.
  import { onDestroy, onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, FreelanceJob } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import FreelanceJobCard from "./FreelanceJobCard.svelte";
  import { infoTabRequests, serveInfoTabRequest, TAB_FREELANCE_PROJECTS, type InfoTabRequest } from "./showInfo.ts";
  import { openJobBoard } from "./jobBoardRequests.ts";
  let { store, flow, corporationID }: { store: ClientStore; flow: AppFlow; corporationID: number } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const F = "UI/Corporations/FreelanceProjects/", G = "UI/Corporations/Goals/";
  const SORTS: readonly (readonly [string, string])[][] = [[["name", "UI/Common/Name"], ["name_reversed", "UI/Inventory/NameReversed"]], [["date_created", G + "DateCreated"], ["date_created_reversed", G + "DateCreatedReversed"]],
    [["time_remaining", "UI/Common/TimeRemainingFilter"], ["time_remaining_reversed", "UI/Common/TimeRemainingReversedFilter"]], [["progress", G + "Progress"], ["progress_reversed", G + "ProgressReversed"]],
    [["num_jumps", G + "NumJumps"], ["num_jumps_reversed", G + "NumJumpsReversed"]]];
  const FILTERS = [["mine", F + "OnlyMyActiveJobs"], ["committable", F + "OnlyProjectsICanAccept"], ["contributed", F + "FilterJobsIHaveContributedTo"], ["unclaimed", F + "HaveUnclaimedRewardsFor"]] as const;
  const LABELS = ["UI/Metadata/ContentTags/FreelanceProjects", F + "PanelTitle", "UI/Corporations/CorporationWindow/Politics/ExtraInfoWrapper", F + "NoProjectsFoundForCorpTitle",
    F + "NoProjectsFoundForCorpBody", "UI/Opportunities/OpenAIR", F + "NoJobs/FailureToLoadTitle", F + "NoJobs/FailureToLoadDescription", F + "NoJobs/FailureToLoadButton", "UI/Inventory/Filter",
    "UI/Common/SortBy", "UI/Common/Any", "Character/CareerPaths/CareerPath", "UI/Corporations/Goals/ClaimValue", F + "YouAreAParticipant", "UI/Common/ISK", "UI/Common/Track", "UI/Common/Untrack",
    ...SORTS.flat().map(([, l]) => l), ...FILTERS.map(([, l]) => l)];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  let jobs = $state<readonly FreelanceJob[] | null | undefined>(undefined), loading = $state(false);
  let filterText = $state(""), menu = $state<"filter" | "sort" | null>(null), career = $state<number | null>(null);
  let checks = $state<Record<string, boolean>>({});
  let careerNames = $state<Record<number, number>>({});
  let sortBy = $state((() => { try { return localStorage.getItem("evejs.play.ActiveFreelanceProjectsSortBy") ?? "name"; } catch { return "name"; } })());
  function setSort(v: string): void { sortBy = v; menu = null; try { localStorage.setItem("evejs.play.ActiveFreelanceProjectsSortBy", v); } catch { /* the window keeps it */ } }
  async function load(): Promise<void> { loading = true; try { jobs = await flow.corporationFreelanceJobs(corporationID); } finally { loading = false; } }
  let section = $state<HTMLElement | null>(null);
  onMount(() => {
    flow.requestWords(LABELS);
    void flow.certifiedSkillPlans().then((r) => { if (r) careerNames = Object.fromEntries(r.careerPaths.filter((c) => c.nameID !== null).map((c) => [c.careerPathID, c.nameID!])); }, () => {});
    void load();
  });
  // selectTabType: the window opened on this tab. The window's other sections are still being read (and its content can
  // be built again as they arrive, making a new panel) and the window is fitted to the desktop after it opens, so the
  // section is put in view again every 200 ms for 3 s, unless the pilot scrolls or clicks first; then the request is
  // served. One older than 5 s is not taken.
  let unpin: (() => void) | null = null;
  let taken: InfoTabRequest | null = null;
  $effect(() => {
    const r = $infoTabRequests;
    if (!r || r === taken || r.tab !== TAB_FREELANCE_PROJECTS || r.corporationID !== corporationID || !section || Date.now() - r.atMs > 5000) return;
    taken = r;
    const target = section, body = target.closest<HTMLElement>(".win-body, .info-modal-body");
    target.scrollIntoView({ block: "start" });
    if (!body) { serveInfoTabRequest(r); return; }
    const stop = () => { clearInterval(again); clearTimeout(timer); body.removeEventListener("wheel", stop); body.removeEventListener("pointerdown", stop); };
    const again = setInterval(() => target.scrollIntoView({ block: "start" }), 200);
    const timer = setTimeout(() => { stop(); serveInfoTabRequest(r); }, 3000);
    body.addEventListener("wheel", stop, { once: true });
    body.addEventListener("pointerdown", stop, { once: true });
    // Not the effect's cleanup: the request's own changes re-run this effect.
    unpin = stop;
  });
  onDestroy(() => unpin?.());
  const ratio = (j: FreelanceJob) => (j.project.target ? j.project.current / j.project.target : 0);
  // FreelanceProjectJob.can_commit: active, not committed nor kicked, not at the committed limit, not at capacity.
  const canCommit = (j: FreelanceJob) => j.project.state === 1 && j.participation !== 1 && j.participation !== 2 && !j.atMaxProjects
    && (j.project.maxCommitted === null || j.project.participants < j.project.maxCommitted);
  const shown = $derived.by(() => {
    let out = [...(jobs ?? [])];
    if (filterText) out = out.filter((j) => j.project.name.toLowerCase().includes(filterText.toLowerCase()));
    if (checks.contributed) out = out.filter((j) => j.project.myProgress > 0);
    if (checks.unclaimed) out = out.filter((j) => j.unredeemed * j.project.iskPerUnit > 0);
    if (checks.mine) out = out.filter((j) => j.participation === 1);
    if (checks.committable) out = out.filter(canCommit);
    if (career !== null) out = out.filter((j) => j.project.careerPath === career);
    const by = <T,>(key: (j: FreelanceJob) => T, rev = false) => out.sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return rev ? -c : c; });
    switch (sortBy) {
      case "name": return by((j) => j.project.name.toLowerCase());
      case "name_reversed": return by((j) => j.project.name.toLowerCase(), true);
      case "date_created": return by((j) => j.project.created);
      case "date_created_reversed": return by((j) => j.project.created, true);
      case "progress": return by(ratio);
      case "progress_reversed": return by(ratio, true);
      case "time_remaining": return by((j) => [j.project.deadline === null ? 1 : 0, j.project.deadline ?? 0].join(":"));
      case "time_remaining_reversed": return by((j) => [j.project.deadline === null ? 1 : 0, j.project.deadline ?? 0].join(":"), true);
      default: return out;
    }
  });
  const filterOn = $derived(career !== null || Object.values(checks).some(Boolean));
</script>

<section class="ifp" bind:this={section} data-tab={TAB_FREELANCE_PROJECTS}>
  <h3>{word("UI/Metadata/ContentTags/FreelanceProjects")}</h3>
  <div class="ifp-top">
    <b>{word(F + "PanelTitle")} {word("UI/Corporations/CorporationWindow/Politics/ExtraInfoWrapper", { extraInfo: jobs ? jobs.length : "-" })}</b>
    <span class="ifp-gap"></span>
    <button class="ifp-icon" title={word("UI/Common/SortBy")} onclick={() => { menu = menu === "sort" ? null : "sort"; }}>⇅</button>
    <input class="ifp-filter" type="search" bind:value={filterText} />
    <button class="ifp-icon" class:on={filterOn} title={word("UI/Inventory/Filter")} onclick={() => { menu = menu === "filter" ? null : "filter"; }}>⏷</button>
    {#if menu === "sort"}
      <div class="ifp-menu"><div class="ifp-caption">{word("UI/Common/SortBy")}</div>
        {#each SORTS as group, gi (gi)}{#if gi}<hr />{/if}{#each group as [value, label] (value)}<button onclick={() => setSort(value)}>{sortBy === value ? "◉" : "○"} {word(label)}</button>{/each}{/each}</div>
    {:else if menu === "filter"}
      <div class="ifp-menu"><div class="ifp-caption">{word("UI/Inventory/Filter")}</div>
        {#each FILTERS as [key, label] (key)}<button onclick={() => { checks = { ...checks, [key]: !checks[key] }; }}>{checks[key] ? "☑" : "☐"} {word(label)}</button>{/each}
        <hr /><div class="ifp-caption">{word("Character/CareerPaths/CareerPath")}</div>
        <button onclick={() => { career = null; }}>{career === null ? "◉" : "○"} {word("UI/Common/Any")}</button>
        {#each [4, 5, 6, 7] as c (c)}{#if careerNames[c]}<button onclick={() => { career = c; }}>{career === c ? "◉" : "○"} {word(`#${careerNames[c]}`)}</button>{/if}{/each}</div>
    {/if}
  </div>
  {#if jobs === undefined}<p class="ifp-hint">…</p>
  {:else if jobs === null}
    <div class="ifp-alert warn"><b>{word(F + "NoJobs/FailureToLoadTitle")}</b><span>{word(F + "NoJobs/FailureToLoadDescription")}</span>
      <button disabled={loading} onclick={() => void load()}>⟳ {word(F + "NoJobs/FailureToLoadButton")}</button></div>
  {:else if shown.length === 0}
    <div class="ifp-alert"><b>{word(F + "NoProjectsFoundForCorpTitle")}</b><span>{word(F + "NoProjectsFoundForCorpBody")}</span>
      <button onclick={() => openJobBoard()}>{word("UI/Opportunities/OpenAIR")}</button></div>
  {:else}
    <div class="ifp-cards">
      {#each shown as j (j.project.projectID)}<FreelanceJobCard {store} job={j} onOpen={() => openJobBoard(j.project.projectID, j.corporationID)} />{/each}
    </div>
  {/if}
</section>

<style>
  .ifp { position: relative; }
  .ifp-top { position: relative; display: flex; align-items: center; gap: 6px; padding: 8px 4px; }
  .ifp-gap { flex: 1; }
  .ifp-icon { all: unset; cursor: pointer; padding: 2px 6px; opacity: 0.75; }
  .ifp-icon.on { color: var(--theme-focus, #58a6dc); opacity: 1; }
  .ifp-filter { width: 120px; }
  .ifp-menu { position: absolute; right: 0; top: 100%; z-index: 5; display: flex; flex-direction: column; min-width: 220px; padding: 4px; background: rgba(20, 22, 26, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .ifp-menu button { all: unset; cursor: pointer; padding: 3px 8px; }
  .ifp-menu button:hover { background: rgba(255, 255, 255, 0.08); }
  .ifp-menu hr { border: none; border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 3px 0; width: 100%; }
  .ifp-caption { opacity: 0.6; padding: 3px 8px; font-size: 11px; }
  .ifp-hint { opacity: 0.65; }
  .ifp-alert { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; padding: 12px 16px; border-left: 4px solid var(--theme-focus, #58a6dc); background: rgba(255, 255, 255, 0.04); }
  .ifp-alert.warn b { color: #e0913a; }
  .ifp-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
</style>
