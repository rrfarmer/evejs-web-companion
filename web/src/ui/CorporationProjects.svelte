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
  // Not here yet: a card's details overlay and menu, Create New's form, claiming rewards.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationGoal, CorporationGoals } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const G = "UI/Corporations/Goals/";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((m) => `/Carbon/UI/Common/MonthsWithYear/${m}`);
  const STATE_LABELS = ["StateUnspecified", "StateActive", "StateClosed", "StateCompleted", "StateExpired"].map((k) => G + k);
  const LABELS = ["AmountAvailableToYou", "ISKAvailableFromProjects", "ActiveProjects", "CompletedToday", "CompletedTodayHint", "CompletedThisWeek", "MaxActiveProjectsHint",
    "Active", "CreateNew", "CanContributeToProjectSetting", "HaveParticipatedIn", "HaveUnclaimedRewardsFor", "DateCreated", "DateCreatedReversed", "Progress",
    "ProgressReversed", "NumJumps", "NumJumpsReversed", "FailedToConnect", "NoProjectsCurrentlySet", "ContributionMethod", "Created", "Ended", "Resolution"].map((k) => G + k)
    .concat(STATE_LABELS, MONTHS, ["UI/Common/History", "UI/Wallet/WalletWindow/Last30Days", "UI/Inventory/Filter", "UI/Common/SortBy", "UI/Common/Name", "UI/Inventory/NameReversed",
      "UI/Common/TimeRemainingFilter", "UI/Common/TimeRemainingReversedFilter", "UI/Common/Any", "Character/CareerPaths/CareerPath", "UI/Calendar/EventWindow/Creator", "UI/Common/ISK",
      "UI/Util/UnitPrefixThousandShort", "UI/Util/UnitPrefixMillionShort", "UI/Util/UnitPrefixBillionShort", "UI/Util/UnitPrefixTrillionShort", "UI/Generic/Unclassified"]);
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
  // The left line: the state's colour (Closed orange, Completed green, Expired red), else the theme's.
  const lineColor = (g: CorporationGoal) => (g.state === 2 ? "#f39058" : g.state === 3 ? "#5fb85f" : g.state === 4 ? "#d4534f" : "var(--theme-focus, #58a6dc)");
</script>

<div class="cp">
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
            <div class="cp-card" style:--line={lineColor(g)}>
              <img class="cp-flair" src={flair(g.careerPath)} alt="" />
              <div class="cp-card-top">
                <span class="cp-method" title={g.description}>{methodTitle(g)}</span>
                <span class="cp-gauge" title={`${Math.round(ratio(g) * 100)}% · ${Math.round(myRatio(g) * 100)}%`} style:--outer={`${Math.min(1, ratio(g)) * 360}deg`} style:--inner={`${Math.min(1, myRatio(g)) * 360}deg`}><span></span></span>
              </div>
              <div class="cp-card-title">{g.name}</div>
              <div class="cp-card-bottom">{#if totalIsk(g)}<span>¤ {iskShort(totalIsk(g))}</span>{/if}</div>
            </div>
          {/each}
        </div>
      {/if}
    {:else}
      <div class="cp-row cp-head"><span>{word("UI/Common/Name")}</span><span>{word(G + "ContributionMethod")}</span><span>{word(G + "Created")}</span><span>{word(G + "Ended")}</span>
        <span>{word(G + "Resolution")}</span><span>{word(G + "Progress")}</span><span>{word("UI/Calendar/EventWindow/Creator")}</span></div>
      {#each history as g (g.goalID)}
        <div class="cp-row"><span>{g.name}</span><span>{methodTitle(g)}</span><span>{date(g.created)}</span><span>{g.finished ? date(g.finished) : "-"}</span>
          <span style:color={g.state === 3 ? "#5fb85f" : "#d4534f"}>{word(STATE_LABELS[g.state] ?? STATE_LABELS[0]!)}</span><span>{(ratio(g) * 100).toFixed(0)}%</span><span>{nameAny("owner", g.creator)}</span></div>
      {:else}
        <p class="cp-hint">{read?.inactive === null ? word(G + "FailedToConnect") : word(G + "NoProjectsCurrentlySet")}</p>
      {/each}
    {/if}
  </div>
  {#if read?.canAuthor}<div class="cp-buttons"><button disabled title="goalForms.OpenCreateGoalFormWindow">{word(G + "CreateNew")}</button></div>{/if}
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
</style>
