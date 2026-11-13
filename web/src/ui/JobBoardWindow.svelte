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
  // other features (agent missions,
  // corporation projects, the career program), its home page, filters and content tags, tracking.
  // Asked from elsewhere (jobBoardRequests: open_freelance_project from Show Info's Freelance Projects tab, its OpenAIR
  // the browse page) the window shows that job's page, or the browse page.
  import { onMount } from "svelte";
  import FreelanceJobCard from "./FreelanceJobCard.svelte";
  import { jobBoardRequests, serveJobBoardRequest } from "./jobBoardRequests.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, FreelanceJob } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import FreelanceJobPage from "./FreelanceJobPage.svelte";
  import CorporationFreelanceForm from "./CorporationFreelanceForm.svelte";
  import type { FreelanceProject } from "../app/flow.ts";
  let { store, flow, openCorporation }: { store: ClientStore; flow: AppFlow; openCorporation?: () => void } = $props();
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
  async function load(): Promise<void> { board = await flow.freelanceBoard(); }
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
    if (r.projectID) { tab = "browse"; open = r.projectID; openCorp = r.corporationID; } else { tab = "browse"; open = null; }
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
      {#if tab === "unclaimed" && jobs.length}<div class="jb-claim"><button disabled={busy} onclick={() => void claimAll()}>{word(O + "ClaimAll")}</button></div>{/if}
      {#if !jobs.length}
        {#if tab === "browse"}<div class="jb-empty"><b>{word(N + "NoJobsDiscoveredTitle")}</b><span>{word(N + "NoJobsDiscoveredDescription")}</span></div>
        {:else}<p class="jb-hint">{word(O + "NoOpportunitiesFound")}</p>{/if}
      {/if}
      <div class="jb-cards" title={tab === "browse" ? word(O + "VisibilityFreelanceProjects") : ""}>
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
  .jb-body { flex: 1; min-height: 0; overflow: auto; padding: 8px; }
  .jb-hint { text-align: center; opacity: 0.65; }
  .jb { position: relative; }
  .jb-notice { color: #d4534f; }
  .jb-empty { display: flex; flex-direction: column; gap: 4px; padding: 16px; border-left: 4px solid var(--theme-focus, #58a6dc); background: rgba(255, 255, 255, 0.04); }
  .jb-claim { display: flex; justify-content: flex-end; padding-bottom: 8px; }
  .jb-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
</style>
