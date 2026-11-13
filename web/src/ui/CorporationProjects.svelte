<script lang="ts">
  // corporation/corp_ui_projects.py CorpUIProjects - corp_goals/goalsBrowser.py GoalsBrowser (Corporation > General >
  // Projects, a player corporation's): GoalSummaryBar (48 high: AmountAvailableToYou and ISKAvailableFromProjects -
  // isk_readable_short, the line green where non-zero; ActiveProjects - n / capacity for a project manager with
  // MaxActiveProjectsHint; CompletedToday (CompletedTodayHint) and CompletedThisWeek - completed inactive goals of the
  // last 30 days by days since finishing), then the top row (32): the Active / History toggle (300 wide), on the right
  // the timespan combo (History only: Last30Days and the five months before, MonthsWithYear), the quick filter (120),
  // the filter menu (CanContributeToProjectSetting on Active, HaveParticipatedIn, HaveUnclaimedRewardsFor, the career
  // path: Any or one) and the sort menu (Active only: name, date created, time remaining, progress, jumps - each
  // either way; default name). Active: ActiveGoalsPanel - a CorporationGoalCard per active goal (cards 186 high, at
  // most 550 wide, 16 apart: the career's flair, the left line in the state's colour, the contribution method's title,
  // the progress gauge - the corporation's on the outside, the pilot's inside -, the name, the ISK remaining),
  // NoProjectsCurrentlySet / FailedToConnect. History: GoalsHistoryPanel - Name, ContributionMethod, Created, Ended,
  // Resolution (StateCompleted green, else red), Progress (%), Creator. Create New at the bottom for a project manager.
  // A card's actions for a project manager (hover): Clone, View Participants - the details overlay (PanelOverlayCont,
  // Back): GoalDetailsCont - the name; Progress (the circular gauge with the method's icon, the progress, "/ target",
  // "n% <progress description>"; with a reward RemainingISKReward and the reward per contribution); Participants
  // (GetContributorSummariesForGoalRequest: Contributor, TotalAmount, OfTargetValue, OfPersonalTarget where limited,
  // ISKPayout; NoContributionsFound); buttons Clone, Delete (no progress yet), Close (active), Set Progress (active,
  // manual). The card menu (get_menu_for_corp_job): Clone; active - manual: Set Progress, Complete Project; Close
  // Project; no progress: Delete Project. History's menu: Clone, View Participants and the creator. Set Progress:
  // SetProjectProgress's form - SetProgressLabel, ProgressValue (current + 1 to the target), Apply.
  // Create New and Clone: CorporationGoalForm.svelte. A card clicked opens its CorporationGoalPage (the job board's
  // details page - in the client in the Opportunities window; here over the browser): the header (career, the method,
  // the name; the Claim button - ClaimableRewardButton, ClaimValue {rewardValue}, success style once completed - where
  // there is an unclaimed reward), Progress (the gauge, progress / target, the method's progress words; RemainingISKReward
  // and the reward per unit), Your Contribution (yours / your total - the limit or the target; AvailableToEarn with a
  // limit, TotalEarned), the description, CreatedOn {dateString} with the creator and the corporation. A card with an
  // unclaimed reward shows the contribution icon (ClaimableRewardsTooltip: UnclaimedRewardShort, the ISK).
  // Not here yet: the job board window itself, tracking, the objectives.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationGoal, CorporationGoals } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import CorporationGoalForm from "./CorporationGoalForm.svelte";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const G = "UI/Corporations/Goals/";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((m) => `/Carbon/UI/Common/MonthsWithYear/${m}`);
  const STATE_LABELS = ["StateUnspecified", "StateActive", "StateClosed", "StateCompleted", "StateExpired"].map((k) => G + k);
  const LABELS = ["AmountAvailableToYou", "ISKAvailableFromProjects", "ActiveProjects", "CompletedToday", "CompletedTodayHint", "CompletedThisWeek", "MaxActiveProjectsHint",
    "Active", "CreateNew", "CanContributeToProjectSetting", "HaveParticipatedIn", "HaveUnclaimedRewardsFor", "DateCreated", "DateCreatedReversed", "Progress",
    "ProgressReversed", "NumJumps", "NumJumpsReversed", "FailedToConnect", "NoProjectsCurrentlySet", "ContributionMethod", "Created", "Ended", "Resolution",
    "CloneProject", "SetProgress", "CompleteProject", "CloseProject", "DeleteProject", "Participants", "Contributor", "TotalAmount", "OfTargetValue", "OfPersonalTarget",
    "ISKPayout", "NoContributionsFound", "RemainingISKReward", "SetProjectProgress", "SetProgressLabel", "ProgressValue", "ClaimValue", "YourContribution",
    "AvailableToEarn", "TotalEarned", "CreatedOn", "Creator", "ParticipationLimitExplanationTooltip", "ClaimedTooltipBreakdown", "UnclaimedTooltipBreakdown",
    "TotalEarnedTooltipBreakdown"].map((k) => G + k)
    .concat(STATE_LABELS, MONTHS, ["UI/Common/History", "UI/Wallet/WalletWindow/Last30Days", "UI/Inventory/Filter", "UI/Common/SortBy", "UI/Common/Name", "UI/Inventory/NameReversed",
      "UI/Common/TimeRemainingFilter", "UI/Common/TimeRemainingReversedFilter", "UI/Common/Any", "Character/CareerPaths/CareerPath", "UI/Calendar/EventWindow/Creator", "UI/Common/ISK",
      "UI/Util/UnitPrefixThousandShort", "UI/Util/UnitPrefixMillionShort", "UI/Util/UnitPrefixBillionShort", "UI/Util/UnitPrefixTrillionShort", "UI/Generic/Unclassified",
      "UI/Corporations/FreelanceProjects/ViewParticipants", "UI/Commands/Back", "UI/Common/Buttons/Apply", "UI/Common/UnclaimedRewardShort", "UI/Common/Description"]);
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  // eveformat number_readable_short (3 significant digits, K / M / B / T) with ISK.
  function iskShort(value: number): string {
    const sig = (v: number) => (v === 0 ? 0 : Number(v.toPrecision(3)));
    const v = sig(value), k = v === 0 ? 0 : Math.max(0, Math.min(4, Math.floor(Math.log10(Math.abs(v)) / 3)));
    const scaled = v / 1000 ** k;
    let places = 0;
    for (let i = 0; i < 2; i++) if (Math.round(scaled * 10 ** (2 - i)) % 10 > 0) { places = 2 - i; break; }
    const text = scaled.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
    const prefix = ["", "UI/Util/UnitPrefixThousandShort", "UI/Util/UnitPrefixMillionShort", "UI/Util/UnitPrefixBillionShort", "UI/Util/UnitPrefixTrillionShort"][k]!;
    return `${text}${prefix ? word(prefix) : ""} ${word("UI/Common/ISK") || "ISK"}`;
  }
  // careerConst.CAREERS_BG_FLAIR.
  const FLAIR: Record<number, string> = { 4: "explorer", 5: "industrialist", 6: "enforcer", 7: "sof" };
  const flair = (careerPath: number | null) => clientTexture(`res:/UI/Texture/Shared/CareerPaths/${(careerPath !== null && FLAIR[careerPath]) || "unclassified"}_flair.png`);
  // careerpath.get_career_paths(): each career path's name (the certified plans' read has them).
  let careerNames = $state<Record<number, number>>({});
  onMount(() => {
    flow.requestWords(LABELS);
    // The job page's corporation (CorpIcon and corporation_link).
    if ($station.online?.corporationID) flow.requestNames([{ kind: "owner", id: $station.online.corporationID }]);
    void flow.certifiedSkillPlans().then((r) => { if (r) careerNames = Object.fromEntries(r.careerPaths.filter((c) => c.nameID !== null).map((c) => [c.careerPathID, c.nameID!])); }, () => {});
  });

  let page = $state<"active" | "history">("active"), filterText = $state(""), monthsSince = $state<number | null>(null);
  let read = $state<CorporationGoals | null>(null), last30 = $state<readonly CorporationGoal[] | null>(null), loading = $state(true);
  let sortBy = $state(readSetting("ActiveCorpProjectsSortBy", "name"));
  let canContribute = $state(false), participated = $state(false), unclaimedOnly = $state(false), career = $state<number | null>(null);
  let menu = $state<"filter" | "sort" | null>(null);
  function readSetting(key: string, fallback: string): string { try { return localStorage.getItem(`evejs.play.${key}`) ?? fallback; } catch { return fallback; } }
  function setSort(value: string): void { sortBy = value; menu = null; try { localStorage.setItem("evejs.play.ActiveCorpProjectsSortBy", value); } catch { /* kept for the session */ } }
  async function load(): Promise<void> {
    loading = true;
    try {
      const r = await flow.corporationGoals(monthsSince);
      read = r;
      if (monthsSince === null) last30 = r.inactive;
      else if (last30 === null) last30 = (await flow.corporationGoals(null)).inactive;
    } finally { loading = false; }
  }
  $effect(() => { void monthsSince; void load(); });
  // GoalMessenger._subscribe_to_notices: a goal created, closed, completed, deleted, progressed, renamed, expired,
  // redeemed or contributed to - the controller's caches change and the panels reconstruct.
  // svelte-ignore state_referenced_locally
  const notices = flow.gatewayNotices;
  const GOAL_NOTICES = /^eve_public\.(goal\.api\.(Closed|Completed|Created|Deleted|Progressed|NameChanged|DescriptionChanged)Notice|corporationgoal\.api\.(Redeemed|Expired)Notice|goal\.contribution\.api\.ContributedNotice)$/;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const n = $notices;
    if (!n || !GOAL_NOTICES.test(n.typeName)) return;
    // ReconstructScrollEntries is throttled (0.5 s).
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { noticeTimer = null; void load(); }, 500);
  });
  const methodTitle = (g: CorporationGoal) => { const m = g.methodID ? read?.methods[g.methodID] : undefined; return m?.titleID ? word(`#${m.titleID}`) : g.methodID ?? ""; };
  // Goal.get_total_remaining_isk / get_my_remaining_isk.
  const remaining = (g: CorporationGoal) => Math.max(0, g.desired - g.current);
  const myRemaining = (g: CorporationGoal) => (g.participationLimit ? Math.min(remaining(g), Math.max(0, g.participationLimit - g.myProgress)) : remaining(g));
  const totalIsk = (g: CorporationGoal) => (g.amountPerUnit ?? 0) * remaining(g);
  const myIsk = (g: CorporationGoal) => (g.amountPerUnit ?? 0) * (g.participationLimit ? myRemaining(g) : remaining(g));
  const ratio = (g: CorporationGoal) => (g.desired ? g.current / g.desired : 0);
  const myRatio = (g: CorporationGoal) => (!g.myProgress ? 0 : g.participationLimit ? g.myProgress / g.participationLimit : g.desired ? g.myProgress / g.desired : 0);
  const stats = $derived.by(() => {
    const active = read?.active ?? [];
    const now = Date.now();
    let today = 0, week = 0;
    for (const g of last30 ?? []) {
      if (g.state !== 3 || !g.finished) continue;
      const days = Math.floor((now - g.finished) / 86400000);
      if (days < 1) { today++; week++; } else if (days < 7) week++;
    }
    return { mine: active.reduce((n, g) => n + myIsk(g), 0), total: active.reduce((n, g) => n + totalIsk(g), 0), active: active.length, today, week };
  });
  function filtered(goals: readonly CorporationGoal[], active: boolean): CorporationGoal[] {
    let out = [...goals];
    if (filterText) out = out.filter((g) => g.name.toLowerCase().includes(filterText.toLowerCase()));
    if (career !== null) out = out.filter((g) => g.careerPath === career);
    if (participated) out = out.filter((g) => g.myProgress);
    if (unclaimedOnly) out = out.filter((g) => g.myUnclaimed > 0 || (read?.unclaimed ?? []).includes(g.goalID));
    // can_contribute_to: active and the pilot's remaining share left.
    if (active && canContribute) out = out.filter((g) => g.state === 1 && myRemaining(g) > 0);
    return out;
  }
  function sorted(goals: CorporationGoal[]): CorporationGoal[] {
    const by = <T,>(key: (g: CorporationGoal) => T, reverse = false) => [...goals].sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return reverse ? -c : c; });
    switch (sortBy) {
      case "name": return by((g) => g.name.toLowerCase());
      case "name_reversed": return by((g) => g.name.toLowerCase(), true);
      case "date_created": return by((g) => g.created);
      case "date_created_reversed": return by((g) => g.created, true);
      case "progress": return by((g) => ratio(g));
      case "progress_reversed": return by((g) => ratio(g), true);
      // A goal's jumps: none of these have a location yet, so all are equal.
      case "num_jumps": case "num_jumps_reversed": return goals;
      case "time_remaining": return by((g) => [g.due === null ? 1 : 0, g.due ?? 0].join(":"));
      case "time_remaining_reversed": return by((g) => [g.due === null ? 1 : 0, g.due ?? 0].join(":"), true);
      default: return goals;
    }
  }
  const activeCards = $derived(read?.active ? sorted(filtered(read.active, true)) : []);
  const history = $derived(read?.inactive ? filtered(read.inactive, false) : []);
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  // get_timespan_options.
  const timespans = $derived.by(() => {
    const now = new Date();
    return [{ value: "", label: word("UI/Wallet/WalletWindow/Last30Days") }, ...[1, 2, 3, 4, 5].map((i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      return { value: String(i), label: word(MONTHS[d.getUTCMonth()]!, { year: d.getUTCFullYear() }) };
    })];
  });
  const SORTS: readonly (readonly [string, string])[][] = [[["name", "UI/Common/Name"], ["name_reversed", "UI/Inventory/NameReversed"]], [["date_created", G + "DateCreated"], ["date_created_reversed", G + "DateCreatedReversed"]],
    [["time_remaining", "UI/Common/TimeRemainingFilter"], ["time_remaining_reversed", "UI/Common/TimeRemainingReversedFilter"]], [["progress", G + "Progress"], ["progress_reversed", G + "ProgressReversed"]],
    [["num_jumps", G + "NumJumps"], ["num_jumps_reversed", G + "NumJumpsReversed"]]];
  const filterActive = $derived(participated || unclaimedOnly || (page === "active" && canContribute) || career !== null);
  // The details overlay, its participants, the menu and the Set Progress form.
  let details = $state<CorporationGoal | null>(null), participants = $state<readonly { characterID: number; progress: number }[] | null>(null);
  let cardMenu = $state<{ goal: CorporationGoal; x: number; y: number; history: boolean } | null>(null);
  // The job page (open_corporation_goal) and its Claim (redeem_reward; the button busy at least 1.5 s).
  let jobPage = $state<CorporationGoal | null>(null), claiming = $state(false);
  const unclaimedIsk = (g: CorporationGoal) => g.myUnclaimed * (g.amountPerUnit ?? 0);
  const earnedIsk = (g: CorporationGoal) => g.myProgress * (g.amountPerUnit ?? 0);
  async function claim(g: CorporationGoal): Promise<void> {
    if (claiming) return;
    claiming = true;
    try {
      await Promise.all([flow.redeemCorporationGoalReward(g.goalID), new Promise((r) => setTimeout(r, 1500))]);
      await load();
      jobPage = [...(read?.active ?? []), ...(read?.inactive ?? [])].find((x) => x.goalID === g.goalID) ?? jobPage;
    } finally { claiming = false; }
  }
  // goalForms.OpenCreateGoalFormWindow / OpenDuplicateGoalFormWindow.
  let goalForm = $state<{ original: CorporationGoal | null } | null>(null);
  function clone(g: CorporationGoal): void { cardMenu = null; goalForm = { original: g }; }
  let progressForm = $state<{ goal: CorporationGoal; value: number } | null>(null);
  async function viewParticipants(g: CorporationGoal): Promise<void> {
    details = g; participants = null; cardMenu = null;
    try { participants = [...await flow.corporationGoalContributors(g.goalID)]; } catch { participants = []; }
  }
  async function act(g: CorporationGoal, action: "close" | "delete" | "complete"): Promise<void> {
    cardMenu = null;
    if (await flow.corporationGoalAction(g, action)) {
      // on_closed / on_deleted close the overlay showing it.
      if (details?.goalID === g.goalID && action !== "complete") details = null;
      await load();
      if (details) details = [...(read?.active ?? []), ...(read?.inactive ?? [])].find((x) => x.goalID === details!.goalID) ?? details;
    }
  }
  async function applyProgress(): Promise<void> {
    const f = progressForm;
    if (!f) return;
    const value = Math.max(f.goal.current + 1, Math.min(f.goal.desired, Math.trunc(f.value) || 0));
    if (await flow.setCorporationGoalProgress(f.goal, value)) {
      progressForm = null;
      await load();
      if (details) details = [...(read?.active ?? []), ...(read?.inactive ?? [])].find((x) => x.goalID === details!.goalID) ?? details;
    }
  }
  const isManual = (g: CorporationGoal) => g.methodID === "Manual";
  const progressDescription = (g: CorporationGoal) => { const m = g.methodID ? read?.methods[g.methodID] : undefined; return m?.progressDescriptionID ? word(`#${m.progressDescriptionID}`) : ""; };
  const rewardDescription = (g: CorporationGoal) => { const m = g.methodID ? read?.methods[g.methodID] : undefined; return m?.rewardingDescriptionID ? word(`#${m.rewardingDescriptionID}`) : ""; };
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  // The left line: the state's colour (Closed orange, Completed green, Expired red), else the theme's.
  const lineColor = (g: CorporationGoal) => (g.state === 2 ? "#f39058" : g.state === 3 ? "#5fb85f" : g.state === 4 ? "#d4534f" : "var(--theme-focus, #58a6dc)");
</script>

<svelte:window onclick={() => { cardMenu = null; }} />
<div class="cp">
  {#if details}
    {@const g = details}
    <div class="cp-overlay">
      <div class="cp-overlay-head"><button class="cp-ghost" onclick={() => { details = null; }}>{word("UI/Commands/Back")}</button></div>
      <div class="cp-details">
        <h2>{g.name}</h2>
        <section><h3>{word(G + "Progress")}</h3>
          <div class="cp-progress">
            <div class="cp-overview">
              <span class="cp-gauge cp-gauge-big" style:--line={lineColor(g)} style:--outer={`${Math.min(1, ratio(g)) * 360}deg`} style:--inner="0deg"><span></span></span>
              <div><b>{g.current.toLocaleString("en-US")}</b><small>/ {g.desired.toLocaleString("en-US")}</small><small>{(ratio(g) * 100).toFixed(0)}% <span class="cp-dim">{progressDescription(g)}</span></small></div>
            </div>
            {#if g.amountPerUnit}
              <div class="cp-reward"><small>{word(G + "RemainingISKReward")}</small><b>{isk(totalIsk(g))}</b><small>{rewardDescription(g)}</small><b>{isk(g.amountPerUnit)}</b></div>
            {/if}
          </div>
        </section>
        <h3>{word(G + "Participants")}</h3>
        <div class="cp-part cp-part-head" class:limited={g.participationLimit}><span>{word(G + "Contributor")}</span><span>{word(G + "TotalAmount")}</span><span>{word(G + "OfTargetValue")}</span>
          {#if g.participationLimit}<span>{word(G + "OfPersonalTarget")}</span>{/if}<span>{word(G + "ISKPayout")}</span></div>
        {#if participants === null}<p class="cp-hint">…</p>
        {:else}
          {#each participants as p (p.characterID)}
            {@const share = g.desired ? p.progress / g.desired : 0}
            <div class="cp-part" class:limited={g.participationLimit}><span>{nameAny("owner", p.characterID)}</span><span>{p.progress}</span><span>{(share * 100).toFixed(1)}%</span>
              {#if g.participationLimit}<span>{((p.progress / g.participationLimit) * 100).toFixed(1)}%</span>{/if}<span>{isk(share * (g.amountPerUnit ?? 0) * g.desired)}</span></div>
          {:else}<p class="cp-hint">{word(G + "NoContributionsFound")}</p>{/each}
        {/if}
        {#if read?.canAuthor}
          <div class="cp-detail-buttons">
            <button class="cp-ghost" onclick={() => clone(g)}>⧉ {word(G + "CloneProject")}</button>
            {#if !g.current}<button class="cp-ghost" onclick={() => void act(g, "delete")}>🗑 {word(G + "DeleteProject")}</button>{/if}
            {#if g.state === 1}<button class="cp-ghost" onclick={() => void act(g, "close")}>✕ {word(G + "CloseProject")}</button>
              {#if isManual(g)}<button onclick={() => { progressForm = { goal: g, value: g.current + 1 }; }}>{word(G + "SetProgress")}</button>{/if}{/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
  {#if cardMenu}
    {@const m = cardMenu}
    <div class="cp-menu cp-context" style:left={`${m.x}px`} style:top={`${m.y}px`} role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
      {#if read?.canAuthor}
        <button onclick={() => clone(m.goal)}>⧉ {word(G + "CloneProject")}</button>
        {#if m.history}<button onclick={() => void viewParticipants(m.goal)}>{word("UI/Corporations/FreelanceProjects/ViewParticipants")}</button>
        {:else}
          {#if m.goal.state === 1}
            {#if isManual(m.goal)}<button onclick={() => { progressForm = { goal: m.goal, value: m.goal.current + 1 }; cardMenu = null; }}>{word(G + "SetProgress")}</button>
              <button onclick={() => void act(m.goal, "complete")}>✓ {word(G + "CompleteProject")}</button>{/if}
            <button onclick={() => void act(m.goal, "close")}>✕ {word(G + "CloseProject")}</button>
          {/if}
          {#if !m.goal.current}<hr /><button onclick={() => void act(m.goal, "delete")}>🗑 {word(G + "DeleteProject")}</button>{/if}
        {/if}
      {/if}
      {#if m.history}<hr /><button disabled>{nameAny("owner", m.goal.creator)}</button>{/if}
    </div>
  {/if}
  {#if jobPage}
    {@const g = jobPage}
    <div class="cp-overlay cp-job">
      <div class="cp-overlay-head"><button class="cp-ghost" onclick={() => { jobPage = null; }}>{word("UI/Commands/Back")}</button></div>
      <div class="cp-details">
        <header class="cp-job-head">
          <img class="cp-flair" src={flair(g.careerPath)} alt="" />
          <span class="cp-method">{methodTitle(g)}</span>
          <h2>{g.name}</h2>
          {#if g.myUnclaimed > 0}
            <button class="cp-claim" class:done={g.state === 3} disabled={claiming} title={`${word(G + "ClaimedTooltipBreakdown")} ${isk(earnedIsk(g) - unclaimedIsk(g))} · ${word(G + "UnclaimedTooltipBreakdown")} ${isk(unclaimedIsk(g))} · ${word(G + "TotalEarnedTooltipBreakdown")} ${isk(earnedIsk(g))}`}
              onclick={() => void claim(g)}>{claiming ? "…" : word(G + "ClaimValue", { rewardValue: isk(unclaimedIsk(g)) })}</button>
          {/if}
        </header>
        <section><h3>{word(G + "Progress")}</h3>
          <div class="cp-progress">
            <div class="cp-overview">
              <span class="cp-gauge cp-gauge-big" style:--line={lineColor(g)} style:--outer={`${Math.min(1, ratio(g)) * 360}deg`} style:--inner="0deg"><span></span></span>
              <div><b>{g.current.toLocaleString("en-US")}</b><small>/ {g.desired.toLocaleString("en-US")}</small><small>{(ratio(g) * 100).toFixed(0)}% <span class="cp-dim">{progressDescription(g)}</span></small></div>
            </div>
            {#if g.amountPerUnit}
              <div class="cp-reward"><small>{word(G + "RemainingISKReward")}</small><b>{isk(totalIsk(g))}</b><small>{rewardDescription(g)}</small><b>{isk(g.amountPerUnit)}</b></div>
            {/if}
          </div>
        </section>
        {#if g.methodID !== "Manual" || read?.canAuthor}
          <section title={g.participationLimit ? word(G + "ParticipationLimitExplanationTooltip") : ""}><h3>{word(G + "YourContribution")}</h3>
            <div class="cp-progress">
              <div class="cp-overview">
                <span class="cp-gauge cp-gauge-big" style:--line={lineColor(g)} style:--outer={`${Math.min(1, myRatio(g)) * 360}deg`} style:--inner="0deg"><span></span></span>
                <div><b>{g.myProgress.toLocaleString("en-US")}</b><small>/ {(g.participationLimit ?? g.desired).toLocaleString("en-US")}</small><small>{(myRatio(g) * 100).toFixed(0)}% <span class="cp-dim">{progressDescription(g)}</span></small></div>
              </div>
              {#if g.amountPerUnit}
                <div class="cp-reward">
                  {#if g.participationLimit}<small>{word(G + "AvailableToEarn")}</small><b>{isk(myIsk(g))}</b>{/if}
                  <small>{word(G + "TotalEarned")}</small><b>{isk(earnedIsk(g))}</b>
                </div>
              {/if}
            </div>
          </section>
        {/if}
        {#if g.description}<section><h3>{word("UI/Common/Description")}</h3><p>{g.description}</p></section>{/if}
        <section><h3>{word(G + "CreatedOn", { dateString: date(g.created) })}</h3>
          <div class="cp-creator"><span><small>{word(G + "Creator")}</small><b>{nameAny("owner", g.creator)}</b></span><span>{nameAny("owner", $station.online?.corporationID ?? 0)}</span></div>
        </section>
      </div>
    </div>
  {/if}
  {#if goalForm && read}
    <CorporationGoalForm {store} {flow} methods={read.methods} capacity={read.capacity} original={goalForm.original} onClose={(made) => { goalForm = null; if (made) void load(); }} />
  {/if}
  {#if progressForm}
    {@const f = progressForm}
    <div class="cp-modal-back">
      <div class="cp-modal" role="dialog" aria-label={word(G + "SetProjectProgress")}>
        <header>{word(G + "SetProjectProgress")}</header>
        <p>{word(G + "SetProgressLabel", { name: f.goal.name, progress: f.goal.current, target: f.goal.desired })}</p>
        <label>{word(G + "ProgressValue")}<input type="number" min={f.goal.current + 1} max={f.goal.desired} bind:value={f.value} /></label>
        <footer><button onclick={() => void applyProgress()}>{word("UI/Common/Buttons/Apply")}</button><button onclick={() => { progressForm = null; }}>✕</button></footer>
      </div>
    </div>
  {/if}
  <div class="cp-summary">
    <div class="cp-stat" style:--line={stats.mine ? "rgba(95, 184, 95, 0.5)" : "rgba(160, 160, 160, 0.5)"}><b>{iskShort(stats.mine)}</b><span>{word(G + "AmountAvailableToYou")}</span></div>
    <div class="cp-stat" style:--line={stats.total ? "rgba(95, 184, 95, 0.5)" : "rgba(160, 160, 160, 0.5)"}><b>{iskShort(stats.total)}</b><span>{word(G + "ISKAvailableFromProjects")}</span></div>
    <div class="cp-stat" title={read?.canAuthor ? word(G + "MaxActiveProjectsHint", { maxNum: read.capacity }) : ""}>
      <b>{stats.active}{#if read?.canAuthor && read.capacity}<small>/{read.capacity}</small>{/if}</b><span>{word(G + "ActiveProjects")}</span></div>
    <div class="cp-stat" title={word(G + "CompletedTodayHint")} style:--line={stats.today ? "#5fb85f" : "rgba(160, 160, 160, 1)"}><b>{stats.today}</b><span>{word(G + "CompletedToday")}</span></div>
    <div class="cp-stat" style:--line={stats.week ? "rgba(95, 184, 95, 0.5)" : "rgba(160, 160, 160, 0.5)"}><b>{stats.week}</b><span>{word(G + "CompletedThisWeek")}</span></div>
  </div>
  <div class="cp-top">
    <div class="cp-toggle">
      <button class:active={page === "active"} onclick={() => { page = "active"; filterText = ""; }}>{word(G + "Active")}</button>
      <button class:active={page === "history"} onclick={() => { page = "history"; filterText = ""; }}>{word("UI/Common/History")}</button>
    </div>
    <span class="cp-gap"></span>
    {#if page === "active"}<button class="cp-icon" title={word("UI/Common/SortBy")} onclick={() => { menu = menu === "sort" ? null : "sort"; }}>⇅</button>{/if}
    <button class="cp-icon" class:on={filterActive} title={word("UI/Inventory/Filter")} onclick={() => { menu = menu === "filter" ? null : "filter"; }}>⏷</button>
    <input class="cp-filter" type="search" bind:value={filterText} />
    {#if page === "history"}
      <select value={monthsSince === null ? "" : String(monthsSince)} onchange={(e) => { monthsSince = e.currentTarget.value ? Number(e.currentTarget.value) : null; }}>
        {#each timespans as t (t.value)}<option value={t.value}>{t.label}</option>{/each}
      </select>
    {/if}
    {#if menu === "sort"}
      <div class="cp-menu"><div class="cp-caption">{word("UI/Common/SortBy")}</div>
        {#each SORTS as group, gi (gi)}{#if gi}<hr />{/if}{#each group as [value, label] (value)}<button onclick={() => setSort(value)}>{sortBy === value ? "◉" : "○"} {word(label)}</button>{/each}{/each}
      </div>
    {:else if menu === "filter"}
      <div class="cp-menu"><div class="cp-caption">{word("UI/Inventory/Filter")}</div>
        {#if page === "active"}<label><input type="checkbox" bind:checked={canContribute} /> {word(G + "CanContributeToProjectSetting")}</label>{/if}
        <label><input type="checkbox" bind:checked={participated} /> {word(G + "HaveParticipatedIn")}</label>
        <label><input type="checkbox" bind:checked={unclaimedOnly} /> {word(G + "HaveUnclaimedRewardsFor")}</label>
        <hr /><div class="cp-caption">{word("Character/CareerPaths/CareerPath")}</div>
        <button onclick={() => { career = null; }}>{career === null ? "◉" : "○"} {word("UI/Common/Any")}</button>
        {#each [4, 5, 6, 7] as c (c)}<button onclick={() => { career = c; }}>{career === c ? "◉" : "○"} {careerNames[c] ? word(`#${careerNames[c]}`) : FLAIR[c]}</button>{/each}
      </div>
    {/if}
  </div>
  <div class="cp-panels">
    {#if loading && !read}
      <p class="cp-hint">…</p>
    {:else if page === "active"}
      {#if read?.active === null}<p class="cp-hint">{word(G + "FailedToConnect")}</p>
      {:else if !activeCards.length}<p class="cp-hint">{word(G + "NoProjectsCurrentlySet")}</p>
      {:else}
        <div class="cp-cards">
          {#each activeCards as g (g.goalID)}
            <div class="cp-card" style:--line={lineColor(g)} role="button" tabindex="-1" onclick={() => { jobPage = g; }} onkeydown={() => {}} oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); cardMenu = { goal: g, x: e.offsetX + (e.currentTarget as HTMLElement).offsetLeft, y: e.offsetY + (e.currentTarget as HTMLElement).offsetTop + 120, history: false }; }}>
              <img class="cp-flair" src={flair(g.careerPath)} alt="" />
              <div class="cp-card-top">
                <span class="cp-method" title={g.description}>{methodTitle(g)}</span>
                <span class="cp-gauge" title={`${Math.round(ratio(g) * 100)}% · ${Math.round(myRatio(g) * 100)}%`} style:--outer={`${Math.min(1, ratio(g)) * 360}deg`} style:--inner={`${Math.min(1, myRatio(g)) * 360}deg`}><span></span></span>
              </div>
              <div class="cp-card-title">{g.name}</div>
              <div class="cp-card-bottom">{#if totalIsk(g)}<span>¤ {iskShort(totalIsk(g))}</span>{/if}
                {#if g.myUnclaimed > 0}<span class="cp-claimable" title={`${word("UI/Common/UnclaimedRewardShort")} ${isk(unclaimedIsk(g))}`}>✚</span>{/if}
                {#if read?.canAuthor}<span class="cp-card-actions"><button title={word(G + "CloneProject")} onclick={(e) => { e.stopPropagation(); clone(g); }}>⧉</button><button title={word("UI/Corporations/FreelanceProjects/ViewParticipants")} onclick={(e) => { e.stopPropagation(); void viewParticipants(g); }}>☰</button></span>{/if}</div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="cp-row cp-head"><span>{word("UI/Common/Name")}</span><span>{word(G + "ContributionMethod")}</span><span>{word(G + "Created")}</span><span>{word(G + "Ended")}</span>
        <span>{word(G + "Resolution")}</span><span>{word(G + "Progress")}</span><span>{word("UI/Calendar/EventWindow/Creator")}</span></div>
      {#each history as g (g.goalID)}
        <div class="cp-row" role="listitem" oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); cardMenu = { goal: g, x: 40, y: (e.currentTarget as HTMLElement).offsetTop + 120, history: true }; }}
          ondblclick={() => { if (read?.canAuthor) void viewParticipants(g); }}><span>{g.name}</span><span>{methodTitle(g)}</span><span>{date(g.created)}</span><span>{g.finished ? date(g.finished) : "-"}</span>
          <span style:color={g.state === 3 ? "#5fb85f" : "#d4534f"}>{word(STATE_LABELS[g.state] ?? STATE_LABELS[0]!)}</span><span>{(ratio(g) * 100).toFixed(0)}%</span><span>{nameAny("owner", g.creator)}</span></div>
      {:else}
        <p class="cp-hint">{read?.inactive === null ? word(G + "FailedToConnect") : word(G + "NoProjectsCurrentlySet")}</p>
      {/each}
    {/if}
  </div>
  {#if read?.canAuthor}<div class="cp-buttons"><button onclick={() => { goalForm = { original: null }; }}>{word(G + "CreateNew")}</button></div>{/if}
</div>

<style>
  .cp { position: relative; display: flex; flex-direction: column; height: 100%; padding: 0 8px 8px; box-sizing: border-box; }
  .cp-summary { height: 48px; margin-top: 8px; display: flex; gap: 32px; overflow: hidden; flex: none; }
  .cp-stat { min-width: 120px; display: flex; flex-direction: column; padding-left: 20px; border-left: 2px solid var(--line, rgba(255, 255, 255, 0.3)); }
  .cp-stat b { font-size: 20px; line-height: 24px; }
  .cp-stat small { font-size: 14px; opacity: 0.65; }
  .cp-stat span { opacity: 0.65; }
  .cp-top { position: relative; height: 32px; margin-top: 8px; display: flex; gap: 8px; align-items: center; flex: none; }
  .cp-toggle { width: 300px; display: flex; }
  .cp-toggle button { flex: 1; }
  .cp-toggle button.active { background: rgba(255, 255, 255, 0.15); }
  .cp-gap { flex: 1; }
  .cp-filter { width: 120px; }
  .cp-icon { all: unset; cursor: pointer; width: 24px; text-align: center; opacity: 0.8; }
  .cp-icon.on { color: var(--theme-focus, #58a6dc); }
  .cp-menu { position: absolute; right: 0; top: 34px; z-index: 5; min-width: 220px; display: flex; flex-direction: column; gap: 2px; padding: 6px; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .cp-menu button { all: unset; cursor: pointer; padding: 2px 4px; }
  .cp-menu button:hover { background: rgba(255, 255, 255, 0.08); }
  .cp-caption { font-size: 11px; opacity: 0.65; }
  .cp-panels { flex: 1; min-height: 0; overflow: auto; margin-top: 16px; }
  .cp-hint { text-align: center; opacity: 0.65; }
  .cp-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 550px)); gap: 16px; }
  .cp-card { position: relative; height: 186px; display: flex; flex-direction: column; padding: 16px; box-sizing: border-box; overflow: hidden; border-left: 2px solid var(--line); background: rgba(0, 0, 0, 0.6); border-radius: 0 8px 8px 0; }
  .cp-flair { position: absolute; left: -175px; top: -175px; width: 400px; height: 400px; opacity: 0.35; pointer-events: none; }
  .cp-card-top { position: relative; display: flex; justify-content: space-between; align-items: flex-start; height: 50px; }
  .cp-method { opacity: 0.65; }
  .cp-gauge { width: 50px; height: 50px; border-radius: 50%; background: conic-gradient(var(--line) var(--outer), rgba(255, 255, 255, 0.1) 0); display: flex; align-items: center; justify-content: center; }
  .cp-gauge span { width: 38px; height: 38px; border-radius: 50%; background: radial-gradient(#111 55%, transparent 56%), conic-gradient(#fff var(--inner), rgba(255, 255, 255, 0.05) 0); }
  .cp-card-title { position: relative; flex: 1; font-size: 16px; font-weight: bold; padding-top: 8px; overflow: hidden; }
  .cp-card-bottom { position: relative; height: 24px; display: flex; align-items: center; border-radius: 8px; background: rgba(255, 255, 255, 0.05); padding: 0 8px; }
  .cp-row { display: grid; grid-template-columns: 2fr 1.4fr 1fr 1fr 1fr 0.7fr 1.2fr; gap: 6px; min-height: 24px; align-items: center; padding: 0 4px; }
  .cp-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cp-head { font-size: 11px; opacity: 0.65; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .cp-buttons { display: flex; justify-content: center; padding-top: 8px; }
  .cp-card-bottom { justify-content: space-between; }
  .cp-card { cursor: pointer; }
  .cp-claimable { color: #5fb85f; }
  .cp-job-head { position: relative; overflow: hidden; display: flex; flex-direction: column; gap: 4px; padding: 16px; background: rgba(0, 0, 0, 0.5); }
  .cp-job-head .cp-flair { opacity: 0.25; }
  .cp-claim { align-self: flex-start; margin-top: 16px; position: relative; }
  .cp-claim.done { background: rgba(95, 184, 95, 0.35); border-color: #5fb85f; }
  .cp-creator { display: flex; gap: 32px; }
  .cp-creator span { display: flex; flex-direction: column; }
  .cp-card-actions { display: flex; gap: 4px; opacity: 0; transition: opacity 0.3s; }
  .cp-card:hover .cp-card-actions { opacity: 1; }
  .cp-card-actions button { all: unset; cursor: pointer; width: 24px; text-align: center; }
  .cp-context { position: absolute; right: auto; }
  .cp-overlay { position: absolute; inset: 0; z-index: 4; display: flex; flex-direction: column; padding: 0 8px 8px; background: var(--window-bg, #15171a); }
  .cp-overlay-head { padding-top: 8px; min-height: 32px; }
  .cp-ghost { background: none; border: 1px solid rgba(255, 255, 255, 0.2); }
  .cp-details { flex: 1; min-height: 0; overflow: auto; padding-top: 16px; display: flex; flex-direction: column; }
  .cp-details h2 { margin: 24px 0 0; font-size: 20px; }
  .cp-details h3 { margin: 16px 0 8px; font-size: 14px; }
  .cp-progress { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 500px)); gap: 8px 16px; min-height: 100px; }
  .cp-overview { display: flex; gap: 16px; align-items: flex-start; }
  .cp-overview div { display: flex; flex-direction: column; gap: 2px; }
  .cp-gauge-big { width: 80px; height: 80px; flex: none; }
  .cp-gauge-big span { width: 64px; height: 64px; }
  .cp-dim { opacity: 0.65; }
  .cp-reward { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
  .cp-part { display: grid; grid-template-columns: 2fr 1fr 1fr 1.2fr; gap: 6px; min-height: 22px; align-items: center; padding: 0 4px; }
  .cp-part.limited { grid-template-columns: 2fr 1fr 1fr 1fr 1.2fr; }
  .cp-part-head { font-size: 11px; opacity: 0.65; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .cp-detail-buttons { display: flex; justify-content: flex-end; gap: 6px; padding-top: 16px; margin-top: auto; }
  .cp-modal-back { position: absolute; inset: 0; z-index: 6; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); }
  .cp-modal { min-width: 320px; display: flex; flex-direction: column; gap: 8px; padding: 8px; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .cp-modal label { display: flex; flex-direction: column; gap: 2px; }
  .cp-modal footer { display: flex; justify-content: flex-end; gap: 6px; }
</style>
