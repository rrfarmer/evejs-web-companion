<script lang="ts">
  // jobboard ui/job_board_window.JobBoardWindow (OpenJobBoardWindow, Alt-J; caption UI/Opportunities/WindowTitle,
  // 720 x 960): the header's tabs - the browse page (WindowTitle), Active (TabNameActive, with its count) and Unclaimed
  // Rewards (TabNameUnclaimedRewards, with its count) - and a job's page (the details page) in place of the tab's
  // content, Back to it. Here only the freelance jobs' feature (features/freelance_projects: FreelanceProjectsProvider
  // - the projects broadcast within 6 jumps, the committed and the unredeemed ones) is on the board: Browse lists the
  // jobs FreelanceProjectJob.is_available_in_browse takes (NoJobsDiscovered where none), Active the active committed
  // ones (NoOpportunitiesFound), Unclaimed Rewards the ones with unredeemed units (ClaimAll redeeming each). A card
  // (features/freelance_projects/card): the corporation, the title, the progress % (the overall gauge, the pilot's part
  // inside), YouAreAParticipant where committed, the ISK still to earn (available_amount) or to claim, the deadline;
  // its click opens the job page (FreelanceJobPage.svelte), with the project manager's buttons where the job is the
  // pilot's corporation's and the pilot a project manager (is_project_manager_for_corporation: session.corpid and
  // corpRoleDirector | corpRoleProjectManager): DuplicateProject (open_create_project_window with the job's draft -
  // CorporationFreelanceForm), ViewParticipants (open_participant_view - the Corporation window's Freelance Jobs on
  // the job's admin details) and CloseProject (ConfirmClosure asked; Errors/Close on failure). Not here: the board's
  // other features (corporation projects, the career program), its home page, filters and content tags.
  // The agent missions' feature (features/agent_missions: AgentMissionsJobProvider - the journal,
  // GetMyAgentJournalDetails, each mission an AgentMissionJob): in Browse the active ones not expired
  // (is_available_in_browse), in Active the accepted ones (is_available_in_active - accepted or tracked, and the
  // provider tracks every accepted one), as AgentMissionCard (MissionJobCard.svelte) before the freelance jobs; a card
  // opens the mission's page (AgentMissionPage - MissionJobPage.svelte) with the board's Back.
  // The corporation goals' feature (features/corporation_goals: CorporationGoalsProvider - the active goals and the
  // unclaimed ones, CorporationGoalJob): in Browse the ones the pilot can contribute to (can_contribute_to: active and
  // its share not done), in Active the active ones the pilot has progress in and can still contribute to, in Unclaimed
  // Rewards those with unclaimed rewards (Claim All redeems them too); CorporationGoalCard, its page
  // CorporationGoalPage with the board's Back.
  // The daily goals' feature (features/daily_goals: DailyGoalsProvider - GetAllCurrentRequest, DailyGoalJob): in Browse
  // the daily ones (CATEGORY_DAILY) not expired and not completed unless a reward is claimable, in Active the started
  // and not completed ones, in Unclaimed Rewards the claimable ones (Claim All redeems them); DailyGoalCard, its page
  // DailyGoalPage with the board's Back. Above Browse's cards the reward track (DailyRewardTrack); Unclaimed Rewards
  // holds every daily-goals job with a claimable reward (get_jobs_with_unclaimed_rewards), the bonus and milestones too.
  // Asked from elsewhere (jobBoardRequests: open_freelance_project from Show Info's Freelance Projects tab, its OpenAIR
  // the browse page) the window shows that job's page, or the browse page.
  import { onMount } from "svelte";
  import FreelanceJobCard from "./FreelanceJobCard.svelte";
  import MissionJobCard from "./MissionJobCard.svelte";
  import MissionJobPage from "./MissionJobPage.svelte";
  import CorporationGoalCard from "./CorporationGoalCard.svelte";
  import CorporationGoalPage from "./CorporationGoalPage.svelte";
  import type { CorporationGoal, CorporationGoals, DailyGoal, DungeonJob, EpicArcsRead } from "../app/flow.ts";
  import DailyGoalCard from "./DailyGoalCard.svelte";
  import DailyGoalPage from "./DailyGoalPage.svelte";
  import DailyRewardTrack from "./DailyRewardTrack.svelte";
  import EpicArcCard from "./EpicArcCard.svelte";
  import EpicArcPage from "./EpicArcPage.svelte";
  import DungeonCard from "./DungeonCard.svelte";
  import DungeonPage from "./DungeonPage.svelte";
  import { ARC_AVAILABLE, ARC_STARTED } from "../bridge/epicArcs.ts";
  import type { JournalMission } from "../store/types.ts";
  import { jobBoardRequests, serveJobBoardRequest } from "./jobBoardRequests.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, FreelanceJob } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import FreelanceJobPage from "./FreelanceJobPage.svelte";
  import CorporationFreelanceForm from "./CorporationFreelanceForm.svelte";
  import type { FreelanceProject } from "../app/flow.ts";
  let { store, flow, openCorporation, showAgents }: { store: ClientStore; flow: AppFlow; openCorporation?: () => void; showAgents?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const O = "UI/Opportunities/", N = "UI/Corporations/FreelanceProjects/NoJobs/";
  const LABELS = [O + "WindowTitle", O + "TabNameActive", O + "TabNameUnclaimedRewards", O + "VisibilityFreelanceProjects", O + "NoOpportunitiesFound", O + "ClaimAll", O + "FailedToLoad",
    N + "NoJobsDiscoveredTitle", N + "NoJobsDiscoveredDescription", "UI/Corporations/FreelanceProjects/Dialogs/ConfirmClosureHeader", "UI/Corporations/FreelanceProjects/Dialogs/ConfirmClosureBody", "UI/Corporations/FreelanceProjects/YouAreAParticipant", "UI/Corporations/Goals/ClaimValue", "UI/Common/ISK", "UI/Common/Track", "UI/Common/Untrack"];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  let tab = $state<"browse" | "active" | "unclaimed">("browse"), open = $state<string | null>(null), busy = $state(false);
  let board = $state<Awaited<ReturnType<AppFlow["freelanceBoard"]>> | undefined>(undefined);
  let goals = $state<CorporationGoals | null>(null), openGoal = $state<string | null>(null);
  let daily = $state<readonly DailyGoal[]>([]), openDaily = $state<string | null>(null);
  const dailyDone = (d: DailyGoal) => d.target > 0 && d.current >= d.target;
  const dailyExpired = (d: DailyGoal) => d.activeUntilMs !== null && d.activeUntilMs <= Date.now();
  const dailyLists = $derived.by(() => {
    const own = daily.filter((d) => d.category === "CATEGORY_DAILY");
    return { browse: own.filter((d) => !dailyExpired(d) && (!dailyDone(d) || d.claimable)), active: own.filter((d) => d.current > 0 && !dailyDone(d)), unclaimed: daily.filter((d) => d.claimable) };
  });
  const shownDaily = $derived(tab === "browse" ? dailyLists.browse : tab === "active" ? dailyLists.active : dailyLists.unclaimed);
  // The epic arcs (features/epic_arcs: EpicArcJob): in Browse those available, started or replayable; in Active the
  // started ones. Not trackable, no rewards to claim.
  let epic = $state<EpicArcsRead | null>(null), openArc = $state<number | null>(null);
  const epicLists = $derived.by(() => {
    const arcs = epic?.arcs ?? [];
    return { browse: arcs.filter((a) => a.state === ARC_AVAILABLE || a.state === ARC_STARTED || a.replayable), active: arcs.filter((a) => a.state === ARC_STARTED) };
  });
  const shownArcs = $derived(tab === "browse" ? epicLists.browse : tab === "active" ? epicLists.active : []);
  const arcOpen = $derived(openArc === null ? null : epic?.arcs.find((a) => a.epicArcID === openArc) ?? null);
  // The combat anomalies (features/dungeons: CombatAnomaliesProvider, DungeonJob): in Browse those the provider
  // lists, in Active the one the pilot is in (active_dungeon; tracking is not here).
  let dungeons = $state<readonly DungeonJob[]>([]), openDungeon = $state<number | null>(null);
  const shownDungeons = $derived(tab === "browse" ? dungeons : tab === "active" ? dungeons.filter((d) => d.active) : []);
  const dungeonOpen = $derived(openDungeon === null ? null : dungeons.find((d) => d.instanceID === openDungeon) ?? null);
  const dailyOpen = $derived(openDaily === null ? null : daily.find((d) => d.goalID === openDaily) ?? null);
  async function claimDaily(goalID: string): Promise<void> { await flow.redeemDailyGoal(goalID); daily = (await flow.dailyGoals()) ?? daily; }
  // The reward track's Claim All (DailyGoalsFeaturePage._claim_all): every daily goal's claimable reward.
  async function claimAllDaily(): Promise<void> {
    busy = true;
    try { for (const d of dailyLists.unclaimed) await flow.redeemDailyGoal(d.goalID); daily = (await flow.dailyGoals()) ?? daily; } finally { busy = false; }
  }
  async function load(): Promise<void> {
    void flow.loadJournal().catch(() => {});
    void flow.corporationGoals(null).then((g) => { goals = g; }, () => { goals = null; });
    void flow.dailyGoals().then((d) => { daily = d ?? []; }, () => { daily = []; });
    void flow.epicArcs().then((e) => { epic = e; }, () => { epic = null; });
    void flow.combatAnomalies().then((d) => { dungeons = d ?? []; }, () => { dungeons = []; });
    board = await flow.freelanceBoard();
  }
  const goalRemaining = (g: CorporationGoal) => { const left = Math.max(0, g.desired - g.current); return g.participationLimit ? Math.min(left, Math.max(0, g.participationLimit - g.myProgress)) : left; };
  const canContribute = (g: CorporationGoal) => g.state === 1 && goalRemaining(g) > 0;
  const goalLists = $derived.by(() => {
    const active = goals?.active ?? [];
    const all = [...active, ...(goals?.inactive ?? [])];
    return { browse: active.filter(canContribute), active: active.filter((g) => g.myProgress > 0 && canContribute(g)), unclaimed: all.filter((g) => g.myUnclaimed > 0) };
  });
  const shownGoals = $derived(tab === "browse" ? goalLists.browse : tab === "active" ? goalLists.active : goalLists.unclaimed);
  const goalOpen = $derived(openGoal === null ? null : [...(goals?.active ?? []), ...(goals?.inactive ?? [])].find((g) => g.goalID === openGoal) ?? null);
  // svelte-ignore state_referenced_locally
  const agentsStore = store.agents;
  let openMission = $state<number | null>(null);
  const missionExpired = (m: JournalMission) => !!m.expirationTime && /^\d+$/.test(m.expirationTime) && BigInt(m.expirationTime) <= BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n;
  const missions = $derived.by(() => {
    const j = $agentsStore.journal;
    if (!j) return { browse: [] as JournalMission[], active: [] as JournalMission[] };
    const all = [...j.active, ...j.offered].filter((m) => m.agentID !== null);
    return { browse: all.filter((m) => (m.missionState === 1 || m.missionState === 2) && !missionExpired(m)), active: j.active.filter((m) => m.missionState === 2 && m.agentID !== null) };
  });
  const shownMissions = $derived(tab === "browse" ? missions.browse : tab === "active" ? missions.active : []);
  async function openMissionPage(agentID: number): Promise<void> { openMission = agentID; open = null; await flow.openMissionDetails(agentID); }
  onMount(() => { flow.requestWords(LABELS); void load(); });
  const jobs = $derived(board ? (tab === "browse" ? board.browse : tab === "active" ? board.active : board.unclaimed) : []);
  // freelanceprojects util.is_project_manager_for_corporation.
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const managerOf = (corporationID: number) => corporationID === $station.online?.corporationID && (BigInt($station.online?.corpRole ?? "0") & (1n | 1152921504606846976n)) !== 0n;
  let openCorp = $state<number | null>(null), duplicating = $state<FreelanceProject | null>(null), notice = $state("");
  $effect(() => {
    const r = $jobBoardRequests;
    if (!r) return;
    serveJobBoardRequest(r.n);
    notice = "";
    if (r.projectID) { tab = "browse"; open = r.projectID; openCorp = r.corporationID; } else { tab = r.page; open = null; }
  });
  async function closeJob(p: FreelanceProject): Promise<void> {
    const body = word("UI/Corporations/FreelanceProjects/Dialogs/ConfirmClosureBody", { project_name: p.name });
    if (!(await flow.askClientWarning(word("UI/Corporations/FreelanceProjects/Dialogs/ConfirmClosureHeader"), body || "Close?"))) return;
    const e = await flow.freelanceManagerAction("close", p.projectID);
    if (e) { flow.requestWords([e.label]); notice = e.label; return; }
    open = null; await load();
  }
  async function claimAll(): Promise<void> {
    busy = true;
    try {
      for (const j of board?.unclaimed ?? []) await flow.freelanceJobAction("redeem", j.project.projectID);
      for (const g of goalLists.unclaimed) await flow.redeemCorporationGoalReward(g.goalID);
      for (const d of dailyLists.unclaimed) await flow.redeemDailyGoal(d.goalID);
      await load();
    } finally { busy = false; }
  }
</script>

<div class="jb">
  <div class="jb-tabs">
    <button class:on={tab === "browse"} onclick={() => { tab = "browse"; open = null; openMission = null; openGoal = null; openDaily = null; openArc = null; openDungeon = null; }}>{word(O + "WindowTitle")}</button>
    <button class:on={tab === "active"} onclick={() => { tab = "active"; open = null; openMission = null; openGoal = null; openDaily = null; openArc = null; openDungeon = null; }}>{word(O + "TabNameActive")}{#if (board?.active.length ?? 0) + missions.active.length + goalLists.active.length + dailyLists.active.length + epicLists.active.length + dungeons.filter((d) => d.active).length}<span class="jb-count">{(board?.active.length ?? 0) + missions.active.length + goalLists.active.length + dailyLists.active.length + epicLists.active.length + dungeons.filter((d) => d.active).length}</span>{/if}</button>
    <button class:on={tab === "unclaimed"} onclick={() => { tab = "unclaimed"; open = null; openMission = null; openGoal = null; openDaily = null; openArc = null; openDungeon = null; }}>{word(O + "TabNameUnclaimedRewards")}{#if (board?.unclaimed.length ?? 0) + goalLists.unclaimed.length + dailyLists.unclaimed.length}<span class="jb-count gold">{(board?.unclaimed.length ?? 0) + goalLists.unclaimed.length + dailyLists.unclaimed.length}</span>{/if}</button>
  </div>
  <div class="jb-body">
    {#if dungeonOpen}
      <DungeonPage {store} {flow} job={dungeonOpen} onBack={() => { openDungeon = null; }} />
    {:else if arcOpen}
      <EpicArcPage {store} {flow} arc={arcOpen} featureTag={epic?.featureTag ?? null} onBack={() => { openArc = null; }} onViewMission={(agentID) => { openArc = null; void openMissionPage(agentID); }} onTalk={async (agentID) => { await flow.openConversation(agentID); showAgents?.(); }} />
    {:else if dailyOpen}
      <DailyGoalPage {store} {flow} goal={dailyOpen} onBack={() => { openDaily = null; }} onClaim={() => claimDaily(dailyOpen!.goalID)} />
    {:else if goalOpen}
      <div class="jb-goal"><CorporationGoalPage {store} {flow} goal={goalOpen} methods={goals?.methods ?? {}} canAuthor={goals?.canAuthor ?? false} onBack={() => { openGoal = null; }} onClaimed={load} /></div>
    {:else if openMission !== null}
      <MissionJobPage {store} {flow} onBack={() => { openMission = null; }} />
    {:else if open}
      {#if notice}<p class="jb-notice">{word(notice) || notice}</p>{/if}
      {#key open}
        {#if openCorp !== null && managerOf(openCorp)}
          <FreelanceJobPage {store} {flow} projectID={open} onBack={() => { open = null; notice = ""; void load(); }} onDuplicate={(p) => { duplicating = p; }}
            onViewParticipants={(p) => { flow.requestFreelanceAdminDetails(p.projectID); openCorporation?.(); }} onCloseJob={closeJob} />
        {:else}<FreelanceJobPage {store} {flow} projectID={open} onBack={() => { open = null; notice = ""; void load(); }} />{/if}
      {/key}
    {:else if board === undefined}<p class="jb-hint">…</p>
    {:else if board === null}<p class="jb-hint">{word(O + "FailedToLoad")}</p>
    {:else}
      {#if tab === "unclaimed" && (jobs.length || goalLists.unclaimed.length || dailyLists.unclaimed.length)}<div class="jb-claim"><button disabled={busy} onclick={() => void claimAll()}>{word(O + "ClaimAll")}</button></div>{/if}
      {#if !jobs.length && !shownMissions.length && !shownGoals.length && !shownDaily.length && !shownArcs.length && !shownDungeons.length}
        {#if tab === "browse"}<div class="jb-empty"><b>{word(N + "NoJobsDiscoveredTitle")}</b><span>{word(N + "NoJobsDiscoveredDescription")}</span></div>
        {:else}<p class="jb-hint">{word(O + "NoOpportunitiesFound")}</p>{/if}
      {/if}
      {#if tab === "browse"}<DailyRewardTrack {store} {flow} goals={daily} {busy} onClaimAll={() => void claimAllDaily()} />{/if}
      <div class="jb-cards" title={tab === "browse" ? word(O + "VisibilityFreelanceProjects") : ""}>
        {#each shownArcs as a (a.epicArcID)}
          <EpicArcCard {store} {flow} arc={a} featureTag={epic?.featureTag ?? null} onOpen={() => { openArc = a.epicArcID; open = null; openMission = null; openGoal = null; openDaily = null; }} />
        {/each}
        {#each shownMissions as m (m.agentID)}
          <MissionJobCard {store} {flow} mission={m} onOpen={() => void openMissionPage(m.agentID!)} />
        {/each}
        {#each shownDaily as d (d.goalID)}
          <DailyGoalCard {store} {flow} goal={d} onOpen={() => { openDaily = d.goalID; open = null; openMission = null; openGoal = null; }} onClaim={() => claimDaily(d.goalID)} />
        {/each}
        {#each shownDungeons as d (d.instanceID)}
          <DungeonCard {store} {flow} job={d} onOpen={() => { openDungeon = d.instanceID; open = null; openMission = null; openGoal = null; openDaily = null; openArc = null; }} />
        {/each}
        {#each shownGoals as g (g.goalID)}
          <CorporationGoalCard {store} {flow} goal={g} methods={goals?.methods ?? {}} onOpen={() => { openGoal = g.goalID; open = null; openMission = null; }} />
        {/each}
        {#each jobs as j (j.project.projectID)}
          <FreelanceJobCard {store} job={j} claim={tab === "unclaimed"} onOpen={() => { open = j.project.projectID; openCorp = j.corporationID; }} />
        {/each}
      </div>
    {/if}
  </div>
  {#if duplicating}<CorporationFreelanceForm {store} {flow} original={duplicating} onClose={(made) => { duplicating = null; if (made) void load(); }} />{/if}
</div>

<style>
  .jb { display: flex; flex-direction: column; height: 100%; }
  .jb-tabs { display: flex; gap: 2px; padding: 4px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); flex: none; }
  .jb-tabs button { all: unset; cursor: pointer; padding: 4px 12px; opacity: 0.7; }
  .jb-tabs button.on { opacity: 1; border-bottom: 2px solid var(--theme-focus, #58a6dc); }
  .jb-count { margin-left: 6px; padding: 0 5px; border-radius: 8px; background: rgba(88, 166, 220, 0.4); font-size: 11px; }
  .jb-count.gold { background: rgba(212, 170, 60, 0.5); }
  .gold { color: #d4aa3c; }
  .jb-goal { display: flex; flex-direction: column; height: 100%; }
  .jb-body { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
  .jb-hint { text-align: center; opacity: 0.65; }
  .jb { position: relative; }
  .jb-notice { color: #d4534f; }
  .jb-empty { display: flex; flex-direction: column; gap: 4px; padding: 16px; border-left: 4px solid var(--theme-focus, #58a6dc); background: rgba(255, 255, 255, 0.04); }
  .jb-claim { display: flex; justify-content: flex-end; padding-bottom: 8px; }
  .jb-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
</style>
