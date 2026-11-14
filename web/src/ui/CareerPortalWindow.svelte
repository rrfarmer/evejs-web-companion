<script lang="ts">
  // careerPortal/careerPortalWnd.CareerPortalDockablePanel (UI/CareerPortal/CareerPortalWnd, 900 x 750), part one: its
  // three views as the window's state goes (careerConst.CareerWindowState, kept for the character as
  // careerPortal_careerWindowState with the selected career, activity and goal; OnBack: goals -> activities -> careers):
  // - CAREERS_VIEW: the four careers in GetSortedCareerPaths' order (explorer, soldier of fortune, industrialist,
  //   enforcer), each its eveicon (128), its name (careerpath nameID) and its goals done of all;
  // - ACTIVITIES_VIEW: the career's activities in CAREER_PATH_GROUPS' order, each its name
  //   (Character/CareerGoals/<Career>/GroupNames/<key>) and its goals done of all; an activity with no goal is left out;
  // - GOALS_VIEW: the activity's goals by their order annotation, each its name and progress / target.
  // The goal's panel (panels/goalDetailsPanel.GoalPanel): its name and description; RewardsHeader (here the career
  // points: careerPointsLabel); Information - Threat (THREAT_NAMES) and GoalDuration (where the goal has one); and
  // TrackGoal / UntrackGoal (track_goal / untrack_goal), or, completed, GoalCompleted.
  // Not here (later parts): the circle view's drawing and animation, the career and activity panels, the rewards column
  // and claiming (ClaimRewardRequest), the global progress footer, the Aura panel, the background, sounds.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CareerGoal } from "../app/flow.ts";
  import * as api from "../app/api.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { careerIcon } from "./skillPlanIcons.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const tracked = flow.trackedCareerGoals;
  const C = "UI/CareerPortal/";
  // GetSortedCareerPaths; the proto's career by careerpathconst ID; careerConst's names for the group labels.
  const CAREERS = [
    { id: 4, proto: "CAREER_EXPLORATION", key: "Explorer", groups: ["CareerAgentMissions", "Scanning", "Hacking", "AdvancedHacking", "Wormholes", "GasSites", "CombatSites", "Navigation", "AdvancedNavigation", "ProjectDiscovery"] },
    { id: 7, proto: "CAREER_SOLDIER_OF_FORTUNE", key: "SoldierOfFortune", groups: ["CareerAgentMissions", "Social", "ElectronicWarfare", "Combat", "PvP", "CapacitorWarfare", "FactionWarfare", "Support", "Destruction", "Duels"] },
    { id: 5, proto: "CAREER_INDUSTRIALIST", key: "Industrialist", groups: ["IndustrialistCareerAgentsMissions", "Market", "Salvage", "ResourceHarvesting", "Refining", "Manufacturing", "DistributionAgent", "MiningAgent", "Research"] },
    { id: 6, proto: "CAREER_ENFORCER", key: "Enforcer", groups: ["CareerAgentMissions", "SecurityAgent", "AbyssalDeadspace", "Combat", "Bounties", "CombatSites", "EpicArc", "Market", "Standings", "LoyaltyPoints"] },
  ] as const;
  type Career = (typeof CAREERS)[number];
  let goals = $state<readonly CareerGoal[] | null | undefined>(undefined);
  let careerNames = $state<Record<number, number | null>>({});
  $effect(() => {
    void flow.careerGoals().then((g) => { goals = g; }, () => { goals = null; });
    void api.getCertifiedSkillPlans().then((d) => { careerNames = Object.fromEntries(d.careerPaths.map((c) => [c.careerPathID, c.nameID])); }, () => {});
  });
  // The window's state and selections, kept for the character (careerConst's CharSettingEnum / CharSettingUUID).
  const me = $derived($station.online?.characterID ?? null);
  const key = (name: string) => (me ? `evejs.play.${me}.${name}` : null);
  const read = (name: string): string | null => { const k = key(name); try { return k ? localStorage.getItem(k) : null; } catch { return null; } };
  const write = (name: string, value: string | null) => { const k = key(name); try { if (k) { if (value === null) localStorage.removeItem(k); else localStorage.setItem(k, value); } } catch { /* kept for the window's life */ } };
  let view = $state<"CAREERS_VIEW" | "ACTIVITIES_VIEW" | "GOALS_VIEW">("CAREERS_VIEW");
  let careerID = $state<number | null>(null), activity = $state<string | null>(null), goalID = $state<string | null>(null);
  $effect(() => {
    if (me === null) return;
    const v = read("careerPortal_careerWindowState");
    view = v === "ACTIVITIES_VIEW" || v === "GOALS_VIEW" ? v : "CAREERS_VIEW";
    careerID = Number(read("careerPortal_selectedCareerPath")) || null;
    activity = read("careerPortal_selectedActivity");
    goalID = read("careerPortal_selectedGoal");
  });
  function go(next: typeof view, c: number | null = careerID, a: string | null = activity, g: string | null = goalID) {
    view = next; careerID = c; activity = a; goalID = g;
    write("careerPortal_careerWindowState", next); write("careerPortal_selectedCareerPath", c === null ? null : String(c));
    write("careerPortal_selectedActivity", a); write("careerPortal_selectedGoal", g);
  }
  const career = $derived(CAREERS.find((c) => c.id === careerID) ?? null);
  const careerGoals = (c: Career) => (goals ?? []).filter((g) => g.career === c.proto && g.annotations.subtype === "CAREER_PATH_GOAL");
  const done = (list: readonly CareerGoal[]) => list.filter((g) => g.completed).length;
  const byOrder = (list: readonly CareerGoal[]) => [...list].sort((a, b) => (Number(a.annotations.order) || 0) - (Number(b.annotations.order) || 0));
  const activities = $derived(career ? career.groups.map((g) => ({ key: g, goals: byOrder(careerGoals(career).filter((x) => x.annotations.group === g)) })).filter((a) => a.goals.length) : []);
  const activityGoals = $derived(activities.find((a) => a.key === activity)?.goals ?? []);
  const goal = $derived(goalID ? (goals ?? []).find((g) => g.goalID === goalID) ?? null : null);
  $effect(() => {
    flow.requestWords([C + "CareerPortalWnd", C + "RewardsHeader", "UI/Common/Information", C + "Threat", C + "GoalDuration", C + "TrackGoal", C + "UntrackGoal", C + "GoalCompleted", "UI/Commands/Back",
      ...[0, 1, 2, 3].map((t) => `${C}Threat${t}`),
      ...CAREERS.flatMap((c) => c.groups.map((g) => `Character/CareerGoals/${c.key}/GroupNames/${g}`)),
      ...Object.values(careerNames).filter((x): x is number => !!x).map((x) => `#${x}`),
      ...(goals ?? []).filter((g) => view === "GOALS_VIEW" ? g.annotations.group === activity : g.goalID === goalID).flatMap((g) => [g.nameID, g.descriptionID]).filter((x): x is number => !!x).map((x) => `#${x}`)]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const careerName = (c: Career) => (careerNames[c.id] ? word(`#${careerNames[c.id]}`) : c.key);
  const groupName = (c: Career, g: string) => word(`Character/CareerGoals/${c.key}/GroupNames/${g}`) || g;
  const threat = (g: CareerGoal) => word(`${C}Threat${g.threat}`);
</script>

<div class="cpw">
  <header class="cpw-head">
    {#if view !== "CAREERS_VIEW"}<button type="button" class="cpw-back" onclick={() => (view === "GOALS_VIEW" ? go("ACTIVITIES_VIEW", careerID, activity, null) : go("CAREERS_VIEW", careerID, null, null))}>‹ {word("UI/Commands/Back") || "Back"}</button>{/if}
    <h2>{view === "CAREERS_VIEW" ? word(C + "CareerPortalWnd") : career ? careerName(career) : ""}{#if view === "GOALS_VIEW" && career && activity} · {groupName(career, activity)}{/if}</h2>
  </header>
  <div class="cpw-body">
    <div class="cpw-centre">
      {#if goals === undefined}<p class="cpw-dim">…</p>
      {:else if goals === null}<p class="cpw-dim">{word("UI/Opportunities/FailedToLoad")}</p>
      {:else if view === "CAREERS_VIEW"}
        <div class="cpw-careers">
          {#each CAREERS as c (c.id)}
            {@const list = careerGoals(c)}
            <button type="button" class="cpw-career" class:on={careerID === c.id} onclick={() => go("ACTIVITIES_VIEW", c.id, null, null)}>
              {#if careerIcon(c.id, 128)}<img alt="" src={careerIcon(c.id, 128)} />{/if}
              <b>{careerName(c)}</b><small>{done(list)} / {list.length}</small>
            </button>
          {/each}
        </div>
      {:else if view === "ACTIVITIES_VIEW" && career}
        <div class="cpw-list">
          {#each activities as a (a.key)}
            <button type="button" class="cpw-row" class:on={activity === a.key} onclick={() => go("GOALS_VIEW", careerID, a.key, null)}>
              <span>{groupName(career, a.key)}</span><small>{done(a.goals)} / {a.goals.length}</small></button>
          {/each}
        </div>
      {:else if view === "GOALS_VIEW"}
        <div class="cpw-list">
          {#each activityGoals as g (g.goalID)}
            <button type="button" class="cpw-row" class:on={goalID === g.goalID} class:done={g.completed} onclick={() => go("GOALS_VIEW", careerID, activity, g.goalID)}>
              <span>{#if $tracked.includes(g.goalID)}👁 {/if}{g.nameID ? word(`#${g.nameID}`) : ""}</span><small>{g.progress.toLocaleString("en-US")} / {g.target.toLocaleString("en-US")}</small></button>
          {/each}
        </div>
      {/if}
    </div>
    {#if view === "GOALS_VIEW" && goal}
      <aside class="cpw-goal">
        <h3>{goal.nameID ? word(`#${goal.nameID}`) : ""}</h3>
        <p>{goal.descriptionID ? word(`#${goal.descriptionID}`) : ""}</p>
        <hr /><h4>{word(C + "RewardsHeader")}</h4>
        <div class="cpw-entry">{#if careerIcon(career?.id ?? null, 32)}<img alt="" src={careerIcon(career?.id ?? null, 32)} />{/if}<span>{goal.careerPoints.toLocaleString("en-US")}</span></div>
        <hr /><h4>{word("UI/Common/Information")}</h4>
        <div class="cpw-entry"><span>{word(C + "Threat")}</span><b>{threat(goal)}</b></div>
        {#if Number(goal.annotations.duration)}<div class="cpw-entry"><span>{word(C + "GoalDuration")}</span><b>{goal.annotations.duration} min</b></div>{/if}
        <div class="cpw-bottom">
          {#if goal.completed}<span class="cpw-completed">{word(C + "GoalCompleted")}</span>
          {:else}<button type="button" class:primary={!$tracked.includes(goal.goalID)} onclick={() => flow.trackCareerGoal(goal.goalID, !$tracked.includes(goal.goalID))}>
            {$tracked.includes(goal.goalID) ? word(C + "UntrackGoal") : word(C + "TrackGoal")}</button>{/if}
        </div>
      </aside>
    {/if}
  </div>
</div>

<style>
  .cpw { display: flex; flex-direction: column; height: 100%; gap: 8px; }
  .cpw-head { display: flex; align-items: center; gap: 12px; }
  .cpw-head h2 { margin: 0; font-size: 18px; }
  .cpw-back { background: none; border: 1px solid rgb(255 255 255 / 0.2); }
  .cpw-body { flex: 1; display: flex; gap: 16px; min-height: 0; }
  .cpw-centre { flex: 1; overflow: auto; }
  .cpw-dim { opacity: 0.65; }
  .cpw-careers { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
  .cpw-career { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px; background: rgb(0 0 0 / 0.35); border: 1px solid transparent; }
  .cpw-career:hover, .cpw-career.on { border-color: rgb(255 255 255 / 0.3); }
  .cpw-career img { width: 96px; height: 96px; }
  .cpw-list { display: flex; flex-direction: column; gap: 4px; }
  .cpw-row { all: unset; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; padding: 8px 12px; background: rgb(0 0 0 / 0.3); border-left: 2px solid transparent; }
  .cpw-row:hover, .cpw-row.on { border-left-color: rgb(255 255 255 / 0.5); }
  .cpw-row.done small { color: #5fb85f; }
  .cpw-goal { width: 320px; flex: none; overflow: auto; padding: 12px; background: rgb(0 0 0 / 0.4); }
  .cpw-goal h3 { margin: 0 0 6px; font-size: 18px; }
  .cpw-goal h4 { margin: 0 0 6px; font-size: 13px; }
  .cpw-goal hr { border: 0; border-top: 1px solid rgb(255 255 255 / 0.15); margin: 8px 0; }
  .cpw-entry { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0; }
  .cpw-entry img { width: 24px; height: 24px; }
  .cpw-bottom { margin-top: 16px; }
  .cpw-bottom button { width: 100%; }
  .cpw-bottom button.primary { background: rgb(88 166 220 / 0.35); }
  .cpw-completed { color: #6ab04c; font-weight: bold; }
</style>
