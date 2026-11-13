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
  // its click opens the job page (FreelanceJobPage.svelte). Not here: the board's other features (agent missions,
  // corporation projects, the career program), its home page, filters and content tags, tracking.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, FreelanceJob } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import FreelanceJobPage from "./FreelanceJobPage.svelte";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const O = "UI/Opportunities/", N = "UI/Corporations/FreelanceProjects/NoJobs/";
  const LABELS = [O + "WindowTitle", O + "TabNameActive", O + "TabNameUnclaimedRewards", O + "VisibilityFreelanceProjects", O + "NoOpportunitiesFound", O + "ClaimAll", O + "FailedToLoad",
    N + "NoJobsDiscoveredTitle", N + "NoJobsDiscoveredDescription", "UI/Corporations/FreelanceProjects/YouAreAParticipant", "UI/Corporations/Goals/ClaimValue", "UI/Common/ISK"];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  let tab = $state<"browse" | "active" | "unclaimed">("browse"), open = $state<string | null>(null), busy = $state(false);
  let board = $state<Awaited<ReturnType<AppFlow["freelanceBoard"]>> | undefined>(undefined);
  async function load(): Promise<void> { board = await flow.freelanceBoard(); }
  onMount(() => { flow.requestWords(LABELS); void load(); });
  const jobs = $derived(board ? (tab === "browse" ? board.browse : tab === "active" ? board.active : board.unclaimed) : []);
  const left = (j: FreelanceJob) => { const p = j.project, r = Math.max(0, p.target - p.current); return (p.contributionLimit ? Math.min(r, Math.max(0, p.contributionLimit - p.myProgress)) : r) * p.iskPerUnit; };
  async function claimAll(): Promise<void> {
    busy = true;
    try { for (const j of board?.unclaimed ?? []) await flow.freelanceJobAction("redeem", j.project.projectID); await load(); } finally { busy = false; }
  }
</script>

<div class="jb">
  <div class="jb-tabs">
    <button class:on={tab === "browse"} onclick={() => { tab = "browse"; open = null; }}>{word(O + "WindowTitle")}</button>
    <button class:on={tab === "active"} onclick={() => { tab = "active"; open = null; }}>{word(O + "TabNameActive")}{#if board?.active.length}<span class="jb-count">{board.active.length}</span>{/if}</button>
    <button class:on={tab === "unclaimed"} onclick={() => { tab = "unclaimed"; open = null; }}>{word(O + "TabNameUnclaimedRewards")}{#if board?.unclaimed.length}<span class="jb-count gold">{board.unclaimed.length}</span>{/if}</button>
  </div>
  <div class="jb-body">
    {#if open}
      {#key open}<FreelanceJobPage {store} {flow} projectID={open} onBack={() => { open = null; void load(); }} />{/key}
    {:else if board === undefined}<p class="jb-hint">…</p>
    {:else if board === null}<p class="jb-hint">{word(O + "FailedToLoad")}</p>
    {:else}
      {#if tab === "unclaimed" && jobs.length}<div class="jb-claim"><button disabled={busy} onclick={() => void claimAll()}>{word(O + "ClaimAll")}</button></div>{/if}
      {#if !jobs.length}
        {#if tab === "browse"}<div class="jb-empty"><b>{word(N + "NoJobsDiscoveredTitle")}</b><span>{word(N + "NoJobsDiscoveredDescription")}</span></div>
        {:else}<p class="jb-hint">{word(O + "NoOpportunitiesFound")}</p>{/if}
      {/if}
      <div class="jb-cards" title={tab === "browse" ? word(O + "VisibilityFreelanceProjects") : ""}>
        {#each jobs as j (j.project.projectID)}
          {@const p = j.project}
          {@const pct = p.target ? p.current / p.target : 0}
          {@const mine = (p.contributionLimit || p.target) ? p.myProgress / (p.contributionLimit || p.target) : 0}
          <div class="jb-card" role="button" tabindex="-1" onclick={() => { open = p.projectID; }} onkeydown={() => {}}>
            <div class="jb-card-top"><span class="jb-dim">{nameAny("owner", j.corporationID)}</span>
              <span class="jb-gauge" style:--outer={`${Math.min(1, pct) * 360}deg`} style:--inner={`${Math.min(1, mine) * 360}deg`}><span>{Math.floor(pct * 100)}%</span></span></div>
            <div class="jb-title">{p.name}</div>
            <div class="jb-bottom">
              {#if tab === "unclaimed"}<span class="gold">{word("UI/Corporations/Goals/ClaimValue", { rewardValue: isk(j.unredeemed * p.iskPerUnit) })}</span>
              {:else}<span>¤ {isk(left(j))}</span>{/if}
              {#if j.participation === 1}<span class="jb-dim" title={word("UI/Corporations/FreelanceProjects/YouAreAParticipant")}>✔</span>{/if}
              {#if p.deadline}<span class="jb-dim">{new Date(p.deadline).toISOString().slice(0, 10)}</span>{/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .jb { display: flex; flex-direction: column; height: 100%; }
  .jb-tabs { display: flex; gap: 2px; padding: 4px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); flex: none; }
  .jb-tabs button { all: unset; cursor: pointer; padding: 4px 12px; opacity: 0.7; }
  .jb-tabs button.on { opacity: 1; border-bottom: 2px solid var(--theme-focus, #58a6dc); }
  .jb-count { margin-left: 6px; padding: 0 5px; border-radius: 8px; background: rgba(88, 166, 220, 0.4); font-size: 11px; }
  .jb-count.gold { background: rgba(212, 170, 60, 0.5); }
  .gold { color: #d4aa3c; }
  .jb-body { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
  .jb-hint { text-align: center; opacity: 0.65; }
  .jb-empty { display: flex; flex-direction: column; gap: 4px; padding: 16px; border-left: 4px solid var(--theme-focus, #58a6dc); background: rgba(255, 255, 255, 0.04); }
  .jb-claim { display: flex; justify-content: flex-end; padding-bottom: 8px; }
  .jb-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .jb-card { cursor: pointer; height: 150px; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; border-left: 2px solid var(--theme-focus, #58a6dc); background: rgba(0, 0, 0, 0.6); border-radius: 0 8px 8px 0; }
  .jb-card-top { display: flex; justify-content: space-between; }
  .jb-dim { opacity: 0.65; }
  .jb-gauge { width: 40px; height: 40px; border-radius: 50%; background: conic-gradient(var(--theme-focus, #58a6dc) var(--outer), rgba(255, 255, 255, 0.1) 0); display: flex; align-items: center; justify-content: center; }
  .jb-gauge span { width: 30px; height: 30px; border-radius: 50%; background: conic-gradient(#d4aa3c var(--inner), #111 0); display: flex; align-items: center; justify-content: center; font-size: 10px; }
  .jb-title { flex: 1; font-weight: bold; padding-top: 6px; }
  .jb-bottom { display: flex; gap: 8px; justify-content: space-between; align-items: center; padding: 2px 8px; border-radius: 8px; background: rgba(255, 255, 255, 0.05); }
</style>
