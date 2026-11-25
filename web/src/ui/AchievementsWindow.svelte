<script lang="ts">
  // 24.02 achievement_system/client/ui/window: header tabs, grouped side navigation,
  // Career Overview banners and category cards. Definitions come from the client
  // CDN; progress and unclaimed rewards come from the selected pilot's gateway.
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { AchievementCatalogue, AchievementCategory, AchievementDefinition, AchievementMilestone, AchievementProgress, AchievementReward, UnclaimedAchievementReward } from "../bridge/achievements.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { uuidFromBytes } from "../bridge/skillPlans.ts";
  import { clientTexture } from "../play/window.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { achievementRequest } from "./achievementRequests.ts";
  import { achievementMilestone, achievementTrackingFor } from "./achievementTracking.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const tracking = $derived(achievementTrackingFor($station.online?.characterID ?? null));
  const tracked = $derived(tracking.state);
  const W = "UI/Achievements/Window/";
  const N = `${W}SideNavigation/`;
  const C = `${W}CareerProgram/`;
  const hiddenDescription = `${W}Card/DiscoverableAchievementDescription`;
  const trackLabel = `${W}Card/TrackButtonLabel`, untrackLabel = `${W}Card/UntrackButtonLabel`;
  const trackLimit = "UI/Achievements/Error/TrackedAchievementLimitReached";
  const claimAllLabel = `${W}Rewards/ClaimAll`;
  const art = "res:/UI/Texture/classes/Achievements/";
  const labels = {
    achievements: `${W}Tab/Achievements`, pinned: `${W}Tab/Pinned`, rewards: `${W}Tab/Rewards`,
    overview: `${N}Overview`, all: `${N}AllAchievements`, general: `${N}General`, careerOverview: `${N}CareerOverview`,
    base: `${N}BaseAchievements`, campaigns: `${N}MilitaryCampaigns`, historic: `${N}Historic`,
    exclusive: `${N}Exclusive`, archived: `${N}Archived`, expired: `${N}Expired`,
  } as const;
  const careers = {
    career_program_enforcer: { name: "Enforcer", art: "enforcer", desc: `${C}OverviewDescriptionEnforcer` },
    career_program_explorer: { name: "Explorer", art: "explorer", desc: `${C}OverviewDescriptionExplorer` },
    career_program_industrialist: { name: "Industrialist", art: "industrialist", desc: `${C}OverviewDescriptionIndustrialist` },
    career_program_soldier_of_fortune: { name: "Soldier of Fortune", art: "sof", desc: `${C}OverviewDescriptionSoldierOfFortune` },
  } as Readonly<Record<string, { name: string; art: string; desc: string }>>;
  const label = (id: string | number, fallback = "") => plainText($words.templates[typeof id === "number" ? `#${id}` : id] ?? "") || fallback;
  const icon = (name: string) => clientTexture(`res:/UI/Texture/eveicon/career_icons/${name}_64px.png`);
  const banner = (category: AchievementCategory) => clientTexture(`${art}career_program/career_page_${careers[category.style]?.art ?? "enforcer"}.jpg`);
  const categoryName = (c: AchievementCategory) => label(c.name, careers[c.style]?.name ?? c.icon);
  const number = (value: number) => value.toLocaleString("en-US");
  const goal = (c: AchievementCategory) => c.milestones.at(-1)?.target ?? 0;
  const describe = (a: AchievementDefinition, progress?: AchievementProgress) => {
    if (a.visibility === 1 && !progress?.completed) return label(hiddenDescription, "Discover this achievement by completing it.");
    const amount = achievementMilestone(a, progress)?.target ?? 0;
    return plainText(formatTemplate($words.templates[`#${a.description}`] ?? "", { amount }, { nameOf: () => "" }));
  };
  const rewardText = (r: AchievementReward) => label(r.description, r.kind === "title" ? titleNames.get(r.titleID ?? "") ?? "Character title" : `${number(r.amount ?? 0)} ${r.kind ?? ""}`);

  let catalogue = $state.raw<AchievementCatalogue | null>(null);
  let scores = $state<Record<string, number>>({});
  let score = $state<number | null>(null);
  let progress = $state<Record<string, AchievementProgress>>({});
  let rewards = $state<readonly UnclaimedAchievementReward[]>([]);
  let pins = $state<string[]>([]);
  let pinKey = "";
  let page = $state("overview");
  let tab = $state<"achievements" | "pinned" | "rewards">("achievements");
  let search = $state("");
  let limit = $state(24);
  let selected = $state<AchievementDefinition | null>(null);
  let loading = $state(true);
  let error = $state("");
  let claiming = $state(false);
  let disposed = false;
  let titleNames = $state.raw<ReadonlyMap<string, string>>(new Map());
  let askedTitles = false;
  $effect(() => {
    if (!askedTitles && (selected?.milestones.some(m => m.rewards.some(r => r.kind === "title")) || tab === "rewards")) {
      askedTitles = true;
      void flow.characterTitleDefinitions().then(rows => {
        if (!disposed) titleNames = new Map(rows.map(r => [r.id, r.name]));
      }).catch(() => { askedTitles = false; });
    }
  });

  const categories = $derived(new Map(catalogue?.categories.map(c => [c.id, c])));
  const definitions = $derived(new Map(catalogue?.achievements.map(a => [a.id, a])));
  const career = $derived(categories.get(catalogue?.roots.career ?? ""));
  const children = (c: AchievementCategory | undefined) => c?.categories.flatMap(id => categories.get(id) ?? []) ?? [];
  const active = $derived(categories.get(page));
  const base = $derived(categories.get(catalogue?.roots.challenges ?? ""));
  const campaigns = $derived(categories.get(catalogue?.roots.timeLimited ?? ""));
  const manual = $derived(categories.get(catalogue?.roots.manual ?? ""));
  const now = Date.now();
  const released = (a: AchievementDefinition) => !a.releasedAt || a.releasedAt <= now;
  const expired = (a: AchievementDefinition) => Boolean(a.expiresAt && a.expiresAt <= now);
  const visible = (a: AchievementDefinition) => released(a) && !a.archived && !expired(a);
  const categoryRows = (c: AchievementCategory): string[] => [...c.achievements, ...children(c).flatMap(categoryRows)];
  const isCareer = $derived(tab === "achievements" && Boolean(career && page === career.id));
  const candidates = $derived.by(() => {
    const all = catalogue?.achievements ?? [];
    if (tab === "rewards" || isCareer || (tab === "achievements" && page === "overview")) return [];
    if (tab === "pinned") return all.filter(a => pins.includes(a.id));
    if (page === "archived") return all.filter(a => a.archived && released(a));
    if (page === "expired") return all.filter(a => expired(a) && !a.archived);
    if (page === "exclusive" && manual) return categoryRows(manual).flatMap(id => definitions.get(id) ?? []).filter(visible);
    if (page === "all") return all.filter(visible);
    return active ? categoryRows(active).flatMap(id => definitions.get(id) ?? []).filter(visible) : [];
  });
  const matches = $derived(candidates.filter(a => label(a.name, a.icon).toLowerCase().includes(search.trim().toLowerCase())));
  const listed = $derived(matches.slice(0, limit).filter(a => a.visibility !== 2 || progress[a.id]?.completed));

  async function loadScores(rows: readonly AchievementCategory[]) {
    for (const row of await Promise.allSettled(rows.map(async c => [c.id, await flow.achievementCategoryScore(c.id)] as const))) {
      if (!disposed && row.status === "fulfilled") scores[row.value[0]] = row.value[1];
    }
  }
  async function loadRewards() { const rows = await flow.achievementRewards(); if (!disposed) rewards = rows; }
  async function loadScore() { const n = await flow.achievementScore(); if (!disposed) score = n; }
  async function load() {
    loading = true;
    error = "";
    try {
      const data = await flow.achievementCatalogue();
      if (disposed) return;
      catalogue = data;
      const c = data.categories.find(row => row.id === data.roots.career);
      const ids = [...data.categories.flatMap(row => [row.name, row.description]),
        ...data.achievements.flatMap(row => [row.name, row.description, row.flavor]),
        ...[...data.categories, ...data.achievements].flatMap(row => row.milestones.flatMap(m => m.rewards.map(r => r.description)))];
      flow.requestWords([hiddenDescription, trackLabel, untrackLabel, trackLimit, claimAllLabel, ...Object.values(labels), ...Object.values(careers).map(row => row.desc), ...ids.filter(Boolean).map(id => `#${id}`)]);
      if (c) void loadScores([c, ...data.categories.filter(row => row.parent === c.id)]);
      void loadScore().catch(() => {});
      void loadRewards().catch(() => {});
    } catch (e) { if (!disposed) error = e instanceof Error ? e.message : String(e); }
    finally { if (!disposed) loading = false; }
  }
  onMount(() => {
    pinKey = `evejs.play.${store.station.get().online?.characterID}.achievementPins`;
    try { const stored = JSON.parse(localStorage.getItem(pinKey) ?? "[]"); if (Array.isArray(stored)) pins = stored.filter(id => typeof id === "string"); } catch { /* optional storage */ }
    void load();
    const stop = flow.gatewayNotices.subscribe(notice => {
      if (!notice?.typeName.startsWith("eve_public.achievement.") || !notice.payload || typeof notice.payload !== "object") return;
      const data = notice.payload as { category?: { uuid?: string }; achievement?: { uuid?: string }; score?: number };
      const category = uuidFromBytes(data.category?.uuid ?? "");
      const id = uuidFromBytes(data.achievement?.uuid ?? "");
      if (category && typeof data.score === "number") scores[category] = data.score;
      if (id) fetchProgress(id, true);
      if (notice.typeName.endsWith("ReachedNotice") || notice.typeName.endsWith("CompletedNotice")) {
        void loadScore().catch(() => {});
        void loadRewards().catch(() => {});
      }
    });
    return () => { disposed = true; stop(); };
  });

  const pending = new Set<string>();
  function fetchProgress(id: string, refresh = false): void {
    if ((!refresh && progress[id]) || pending.has(id)) return;
    pending.add(id);
    void flow.achievementProgress(id).then(v => { if (!disposed) progress[id] = v; }).catch(() => {}).finally(() => pending.delete(id));
  }
  $effect(() => {
    for (const a of matches.slice(0, limit)) fetchProgress(a.id);
  });
  function selectTab(next: typeof tab) {
    tab = next; search = ""; limit = 24; selected = null;
    if (next === "rewards") void loadRewards().catch(e => { error = String(e.message ?? e); });
  }
  function show(id: string) { page = id; selectTab("achievements"); }
  $effect(() => {
    const requested = $achievementRequest;
    if (!catalogue || requested === null) return;
    if (requested.kind === "rewards") selectTab("rewards");
    if (requested.kind === "category") show(requested.id);
    if (requested.kind === "achievement") {
      const row = definitions.get(requested.id);
      if (row) { show(row.category); selected = row; fetchProgress(row.id); }
    }
    achievementRequest.set(null);
  });
  function pin(id: string) {
    pins = pins.includes(id) ? pins.filter(p => p !== id) : [...pins, id];
    try { localStorage.setItem(pinKey, JSON.stringify(pins)); } catch { /* optional storage */ }
  }
  function rewardMilestone(r: UnclaimedAchievementReward): AchievementMilestone | undefined {
    return (r.kind === "category" ? categories.get(r.source) : definitions.get(r.source))?.milestones.find(m => m.id === r.milestone);
  }
  function canTrack(a: AchievementDefinition) {
    return $tracked.ids.includes(a.id) || Boolean(progress[a.id] && !progress[a.id]?.completed && a.visibility === 0 && visible(a));
  }
  function toggleTracking(id: string) {
    error = "";
    if ($tracked.ids.includes(id)) tracking.untrack(id);
    else if (!tracking.track(id)) error = label(trackLimit, "You can track up to five achievements.");
  }
  async function claim(rows: readonly UnclaimedAchievementReward[], all = false) {
    if (claiming) return;
    claiming = true; error = "";
    const activeTracking = tracking;
    const claimed = new Set<string>();
    try {
      for (const row of rows) {
        if (disposed || activeTracking !== tracking) break;
        try {
          await flow.claimAchievementReward(row);
          if (row.kind === "achievement") claimed.add(row.source);
        } catch (e) {
          if (!disposed) error = e instanceof Error ? e.message : String(e);
        }
      }
      if (activeTracking !== tracking) return;
      const remaining = await flow.achievementRewards();
      if (!disposed) rewards = remaining;
      const candidates = activeTracking.state.get().ids.filter(id => (all || claimed.has(id)) && !remaining.some(row => row.kind === "achievement" && row.source === id));
      await Promise.allSettled(candidates.map(async id => {
        if ((await flow.achievementProgress(id)).completed && activeTracking === tracking) activeTracking.untrack(id);
      }));
    } catch (e) {
      if (!disposed) error = e instanceof Error ? e.message : String(e);
    } finally { if (!disposed) claiming = false; }
  }
</script>

{#snippet trackButton(a: AchievementDefinition)}
  {@const isTracked = $tracked.ids.includes(a.id)}
  <button type="button" class="ach-track" aria-pressed={isTracked} disabled={!canTrack(a)} onclick={() => toggleTracking(a.id)}>
    {isTracked ? label(untrackLabel, "Untrack") : label(trackLabel, "Track")}
  </button>
{/snippet}

<section class="ach-window" aria-label="Achievements">
  <header class="ach-tabs" aria-label="Achievements tabs">
    {#each ["achievements", "pinned", "rewards"] as t}
      {@const id = t as typeof tab}
      <button type="button" aria-pressed={tab === id} onclick={() => selectTab(id)}>{label(labels[id], t[0]?.toUpperCase() + t.slice(1))}
        {#if id === "pinned" && pins.length}<b>{pins.length}</b>{:else if id === "rewards" && rewards.length}<b>{rewards.length}</b>{/if}
      </button>
    {/each}
    {#if score !== null}<span class="ach-total" title="Achievement Score">{number(score)}</span>{/if}
  </header>

  {#snippet nav(id: string, title: string, child = false)}
    <button type="button" class:child aria-current={page === id ? "page" : undefined} onclick={() => show(id)}>{title}</button>
  {/snippet}

  {#snippet meter(score: number | undefined, target: number)}
    <div class="ach-meter">
      <span>{score === undefined ? "—" : number(score)} / {number(target)}</span>
      <progress aria-label="Career points" max={target || 1} value={score ?? 0}></progress>
    </div>
  {/snippet}

  <div class="ach-body">
    {#if tab === "achievements"}
      <nav class="ach-side" aria-label="Achievement categories">
        <h3>{label(labels.general, "General")}</h3>
        {@render nav("overview", label(labels.overview, "Overview"))}
        {@render nav("all", label(labels.all, "All Achievements"))}
        {#if career}
          <h3>{label(career.name, "Career Program")}</h3>
          {@render nav(career.id, label(labels.careerOverview, "Career Overview"))}
          {#each children(career) as c (c.id)}{@render nav(c.id, categoryName(c), true)}{/each}
        {/if}
        {#each [campaigns, base] as root}
          {#if root && categoryRows(root).some(id => { const a = definitions.get(id); return a && visible(a); })}
            <h3>{root === base ? label(labels.base, "Achievements") : label(root.name, "Time Limited")}</h3>
            {#each children(root) as c (c.id)}
              {#if categoryRows(c).some(id => { const a = definitions.get(id); return a && visible(a); })}
                {@render nav(c.id, root === campaigns ? label(labels.campaigns, "Military Campaigns") : categoryName(c))}
                {#each children(c) as sub (sub.id)}{@render nav(sub.id, categoryName(sub), true)}{/each}
              {/if}
            {/each}
          {/if}
        {/each}
        {#if catalogue?.achievements.some(a => a.archived || expired(a)) || manual?.achievements.length}
          <h3>{label(labels.historic, "Historic")}</h3>
          {#if manual?.achievements.length}{@render nav("exclusive", label(labels.exclusive, "Exclusive"))}{/if}
          {#if catalogue?.achievements.some(a => a.archived)}{@render nav("archived", label(labels.archived, "Archived"))}{/if}
          {#if catalogue?.achievements.some(expired)}{@render nav("expired", label(labels.expired, "Expired"))}{/if}
        {/if}
      </nav>
    {/if}
    <div class="ach-main">
      {#if error}<p class="ach-error" role="alert">{error} {#if !catalogue}<button type="button" onclick={load}>Retry</button>{/if}</p>{/if}
      {#if loading}
        <p role="status">Loading achievements…</p>
      {:else if catalogue && tab === "rewards"}
        <h2>{label(labels.rewards, "Rewards")}</h2>
        {#if rewards.length}
          <button type="button" disabled={claiming} onclick={() => claim(rewards, true)}>{label(claimAllLabel, "Claim All")}</button>
        {:else}<p>No unclaimed rewards.</p>{/if}
        {#each rewards as row (`${row.kind}:${row.source}:${row.milestone}`)}
          {@const name = (row.kind === "category" ? categories.get(row.source) : definitions.get(row.source))?.name}
          <article class="ach-reward">
            <div><h3>{label(name ?? 0, "Milestone reward")}</h3>
              {#each rewardMilestone(row)?.rewards.filter(r => row.rewards.includes(r.id)) ?? [] as reward (reward.id)}
                <div>{rewardText(reward)}{reward.omega ? " · Omega" : ""}</div>
              {/each}
            </div>
            <button type="button" disabled={claiming} onclick={() => claim([row])}>Claim</button>
          </article>
        {/each}
      {:else if catalogue && isCareer && career}
        <div class="ach-careers">
          {#each children(career) as c (c.id)}
            <button type="button" class="ach-banner" style:background-image={`linear-gradient(transparent, #0b1016 92%), url('${banner(c)}')`}
              onclick={() => show(c.id)}>
              <img alt="" src={icon(c.icon)} />
              <strong>{categoryName(c)}</strong>
              <small>{label(careers[c.style]?.desc ?? c.description)}</small>
              {@render meter(scores[c.id], goal(c))}
            </button>
          {/each}
        </div>
        <div class="ach-global">
          <h3>Overall Career Progress</h3>
          {@render meter(scores[career.id], goal(career))}
          <div class="ach-milestones">{#each career.milestones as m (m.id)}<span>{number(m.target)}</span>{/each}</div>
        </div>
      {:else if catalogue && tab === "achievements" && page === "overview"}
        <h2>{label(labels.overview, "Overview")}</h2>
        {#if career}
          <button class="ach-feature" type="button" onclick={() => show(career.id)}>
            <strong>{label(career.name, "Career Program")}</strong>
            <small>{label(career.description)}</small>
            <span>{label(labels.careerOverview, "Career Overview")} ›</span>
          </button>
        {/if}
        {#each [campaigns, base].flatMap(children).filter(c => c.featured > 0 && categoryRows(c).some(id => { const a = definitions.get(id); return a && visible(a); })).sort((a, b) => a.featured - b.featured) as c (c.id)}
          <button class="ach-feature" type="button" onclick={() => show(c.id)}><strong>{categoryName(c)}</strong><small>{label(c.description)}</small></button>
        {/each}
      {:else if catalogue}
        {#if active?.style && careers[active.style]}
          <header class="ach-hero" style:background-image={`linear-gradient(90deg,#0b1016,transparent), url('${banner(active)}')`}>
            <button type="button" onclick={() => career && show(career.id)}>‹ {label(labels.careerOverview, "Career Overview")}</button>
            <h2>{categoryName(active)}</h2>
            <p>{label(active.description)}</p>
            {@render meter(scores[active.id], goal(active))}
          </header>
        {:else}
          <h2>{tab === "pinned" ? label(labels.pinned, "Pinned") : active ? categoryName(active) : label(labels[page as keyof typeof labels] ?? "", page === "all" ? "All Achievements" : page)}</h2>
        {/if}
        <input type="search" placeholder="Search" aria-label="Search achievements" bind:value={search} />
        <div class="ach-cards">
          {#each listed as a (a.id)}
            {@const p = progress[a.id]}
            <article class="ach-card">
              <button type="button" class="ach-card-open" onclick={() => selected = a}>
                <strong>{label(a.name, a.icon)}</strong>
                <small>{describe(a, p)}</small>
                {#if p && a.milestones.length}
                  <span>{p.completed ? "Completed" : `${number(p.current)} / ${number(a.milestones.at(-1)?.target ?? 0)}`}</span>
                {/if}
              </button>
              <div class="ach-card-actions">
                <button type="button" class="ach-pin" aria-label={pins.includes(a.id) ? "Unpin achievement" : "Pin achievement"} aria-pressed={pins.includes(a.id)} onclick={() => pin(a.id)}>{pins.includes(a.id) ? "★" : "☆"}</button>
                {@render trackButton(a)}
              </div>
            </article>
          {:else}<p>No achievements to display.</p>{/each}
        </div>
        {#if matches.length > limit}
          <button type="button" onclick={() => limit += 24}>Show more</button>
        {/if}
      {/if}
    </div>
  </div>

  {#if selected}
    <div class="ach-detail" role="dialog" aria-label={label(selected.name, selected.icon)}>
      <button type="button" aria-label="Close achievement" onclick={() => selected = null}>✕</button>
      <h2>{label(selected.name, selected.icon)}</h2>
      {@render trackButton(selected)}
      {#if error}<p class="ach-error" role="alert">{error}</p>{/if}
      <p>{describe(selected, progress[selected.id])}</p><p>{label(selected.flavor)}</p>
      {#each selected.milestones as m (m.id)}
        <article><strong>{number(m.target)}</strong> · {number(m.points ?? 0)} points
          {#each m.rewards as r (r.id)}<div>{rewardText(r)}{r.omega ? " · Omega" : ""}</div>{/each}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .ach-window { height: 100%; min-height: 0; display: flex; flex-direction: column; position: relative; background: #10151a; color: #e0e5e9; }
  button { background: #ffffff0a; border: 1px solid #ffffff22; color: inherit; cursor: pointer; padding: 6px 12px; }
  button:hover, button:focus-visible { background-color: #ffffff1a; }
  .ach-tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid #ffffff24; min-height: 34px; }
  .ach-tabs button { border: 0; background: transparent; }
  .ach-tabs button[aria-pressed="true"] { border-bottom: 2px solid #8ccdde; }
  .ach-tabs b { padding: 2px 5px; margin-left: 4px; color: #15191b; background: #a4d4e5; border-radius: 6px; }
  .ach-total { margin: auto 0 auto auto; background: #ffffff12; padding: 2px 16px; color: #f0c576; }
  .ach-body { flex: 1; min-height: 0; display: flex; }
  .ach-side { overflow: auto; flex: 0 0 min(22%, 208px); min-width: 122px; border-right: 1px solid #ffffff22; padding: 8px 0; background: #0c1117; }
  .ach-side h3 { text-transform: uppercase; padding: 8px 12px 3px; margin: 4px 0 0; color: #b5bec7; font-size: 12px; }
  .ach-side button { width: 100%; text-align: left; border: 0; padding: 8px 12px; background: transparent; }
  .ach-side button.child { padding-left: 26px; }
  .ach-side button[aria-current] { background: #b2d0e226; box-shadow: inset 2px 0 #8ccdde; }
  .ach-side button:hover { background: #ffffff18; }
  .ach-main { flex: 1; min-width: 0; overflow: auto; padding: 16px; container-type: inline-size; }
  h2 { margin: 0 0 12px; font-size: 26px; }
  h3 { margin: 0 0 6px; }
  p { margin: 8px 0; }
  .ach-error { border-left: 3px solid #d49254; padding-left: 8px; }
  .ach-careers, .ach-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .ach-banner { position: relative; isolation: isolate; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: end; min-height: 226px; padding: 14px; text-align: center; background-size: cover; background-position: center; }
  .ach-banner::before { content: ""; position: absolute; z-index: -1; inset: 0; background: linear-gradient(transparent 30%, #0b1016eb 90%); pointer-events: none; }
  .ach-banner:hover { outline: 1px solid #a8d4e6; }
  .ach-banner strong { font-size: 25px; }
  .ach-banner img { width: 48px; height: 48px; object-fit: contain; }
  small { display: block; color: #c0cbd3; font-size: 13px; }
  .ach-meter { width: 100%; text-align: right; margin-top: 10px; }
  progress { display: block; width: 100%; height: 9px; accent-color: #88becd; }
  .ach-global, .ach-feature, .ach-hero { background: #18232d; border: 1px solid #ffffff26; padding: 16px; margin: 8px 0; }
  .ach-feature { display: grid; width: 100%; min-height: 126px; text-align: left; }
  .ach-feature strong { font-size: 26px; }
  .ach-milestones { display: flex; padding-left: 20%; justify-content: space-between; }
  .ach-hero { background-size: cover; background-position: center; }
  .ach-hero h2 { margin-top: 14px; }
  input { color: inherit; border: 1px solid #ffffff32; background: #080e15; padding: 6px; margin: 8px 0; }
  .ach-card { display: flex; align-items: start; border: 1px solid #ffffff22; background: #ffffff08; }
  .ach-card-open { flex: 1; align-self: stretch; background: transparent; border: 0; text-align: left; min-width: 0; min-height: 85px; }
  .ach-card-open small { margin: 4px 0; }
  .ach-card-actions { display: grid; justify-items: end; padding: 4px; }
  .ach-pin { border: 0; background: transparent; padding: 6px; }
  .ach-pin[aria-pressed="true"] { color: #f0c576; }
  .ach-track { font-size: 12px; padding: 3px 6px; }
  .ach-track:disabled { opacity: .45; cursor: default; }
  .ach-track[aria-pressed="true"] { color: #a4d4e5; }
  .ach-reward { display: flex; gap: 12px; align-items: center; justify-content: space-between; margin: 8px 0; padding: 12px; border: 1px solid #ffffff22; }
  .ach-detail { position: absolute; z-index: 1; inset: 12% 12% auto; max-height: 80%; overflow: auto; background: #141d25; border: 1px solid #658496; padding: 18px; box-shadow: 0 12px 40px #000; }
  .ach-detail > button:first-child { float: right; }
  .ach-detail article { padding-top: 8px; }
  @container (min-width: 960px) { .ach-careers { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @container (max-width: 410px) { .ach-careers, .ach-cards { grid-template-columns: 1fr; } }
</style>
