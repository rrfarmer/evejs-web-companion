<script lang="ts">
  // careerPortal/careerPortalWnd.CareerPortalDockablePanel (UI/CareerPortal/CareerPortalWnd, 900 x 750), part one: its
  // three views as the window's state goes (careerConst.CareerWindowState, kept for the character as
  // careerPortal_careerWindowState with the selected career, activity and goal; OnBack: goals -> activities -> careers):
  // - CAREERS_VIEW: the four careers in GetSortedCareerPaths' order (explorer, soldier of fortune, industrialist,
  //   enforcer), each its eveicon (128), its name (careerpath nameID) and its goals done of all;
  // - ACTIVITIES_VIEW: the career's activities in CAREER_PATH_GROUPS' order, each its name
  //   (Character/CareerGoals/<Career>/GroupNames/<key>) and its goals done of all; an activity with no goal is left out;
  // - GOALS_VIEW: the activity's goals by their order annotation, each its name and progress / target.
  // The goal's panel (panels/goalDetailsPanel.GoalPanel): its name and description; RewardsHeader - the omega rewards,
  // the alpha ones (get_text_for_reward: "<amount> ISK", "<amount> Skill Points", "<amount>x <type>"), the career
  // points; Information - Threat (THREAT_NAMES) and GoalDuration (where the goal has one); and TrackGoal / UntrackGoal
  // (track_goal / untrack_goal), or, completed, GoalCompleted.
  // The left column (rewards/rewardsCont.RewardsCont): UI/CareerPortal/YourRewards and ClaimAllRewards (each entry's
  // claim); expanded where a reward is claimable, an entry (RewardEntry) for each completed goal's unclaimed label: its
  // reward (one: its icon and text; more: the career's crate, RewardBundle, ItemsInRewardBundle {quantity}), the goal's
  // name, ClaimReward (ClaimRewardRequest {goal, label}) - then RewardClaimed, its hint CheckRedeemingQueue. An omega
  // label for an alpha clone (OmegaRewardEntry): Locked and UpgradeToClaim, not claimable here.
  // The goals (goal_data_controller._load_definitions): of no career, the overall goals; of a career with an activity
  // group (CAREER_PATH_GROUPS), that activity's; of a career with none, the career's own (its graduation).
  // The right side by the view (panels/panelConts): CAREERS_VIEW - the Aura panel (AuraAssistancePanelTitle) with the
  // freelance jobs (AuraAssistanceFreelanceJobsTitle, AuraAssistanceFreelanceJobsText, OpenFreelanceJobs);
  // ACTIVITIES_VIEW - CareerDetailsPanel (the career's 32 px icon and name, PlayVideo - CAREER_VIDEOS -, its
  // description, GraduationReward with the career's crate and its career goal's omega then alpha rewards) and
  // AuraCareerAssistancePanelActivity (AuraAssistanceCareerAgentMissionsTitle and AuraAssistanceCareerAgentsText
  // {careerPathName}; AuraAssistanceSkillPlansTitle, AuraAssistanceSkillPlansText, AuraAssistanceOpenSkillPlanButton
  // {careerPathName}; the freelance jobs with FreelanceJobsAOFeatureDescription).
  // The footer (globalProgress.GlobalProgress): UI/CareerPortal/OverallProgress and the progress bar - the last overall
  // goal's progress of the greatest overall target, a marker at each overall goal with rewards (its target's share),
  // its hint OverallCareerPoints {currentPoints, totalPoints}.
  // GOALS_VIEW with no goal of the activity chosen: AuraVideoAssistancePanel - UI/CareerPortal/HelpVideos, the
  // activity's goals' distinct videos (AgencyHelpVideosFSDLoader by videoID; NoVideosAvailable where none has one),
  // and the freelance jobs. A goal chosen: the goal's panel and AuraGoalPanel - the Aura icon and
  // AuraAssistancePanelTitle, the goal's aura text, its video's button, its agency link (agencyLinkTextID, to
  // agencyScreen's content group, AGENCY_SECTION_NAMES_TO_IDS, the home group where it has none), and the freelance jobs.
  // AuraAssistanceOpenSkillPlanButton: OpenSkillPlanWindow(careerID) - the skills window's certified plans of the career.
  // Not here (later parts): the circle view's drawing and animation, the help videos themselves (no goal of this build
  // has a videoID), the fanfare, the background, sounds.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CareerGoal } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { careerIcon } from "./skillPlanIcons.ts";
  import CareerCircle from "./CareerCircle.svelte";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { openJobBoard } from "./jobBoardRequests.ts";
  import { showCertifiedPlans } from "./skillPlanCareerRequests.ts";
  import { openAgencyGroup } from "./agencyRequests.ts";
  import { AGENCY_SCREEN_GROUPS } from "./agencyContentGroups.ts";
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
  let careerTexts = $state<Record<number, { nameID: number | null; descriptionID: number | null }>>({});
  $effect(() => {
    void flow.careerGoals().then((g) => { goals = g; }, () => { goals = null; });
    void flow.careerPathNameIDs().then((n) => { careerTexts = { ...n }; }, () => {});
  });
  // The window's state and selections, kept for the character (careerConst's CharSettingEnum / CharSettingUUID).
  const me = $derived($station.online?.characterID ?? null);
  const key = (name: string) => (me ? `evejs.play.${me}.${name}` : null);
  const read = (name: string): string | null => { const k = key(name); try { return k ? localStorage.getItem(k) : null; } catch { return null; } };
  const write = (name: string, value: string | null) => { const k = key(name); try { if (k) { if (value === null) localStorage.removeItem(k); else localStorage.setItem(k, value); } } catch { /* kept for the window's life */ } };
  let view = $state<"CAREERS_VIEW" | "ACTIVITIES_VIEW" | "GOALS_VIEW">("CAREERS_VIEW");
  let careerID = $state<number | null>(null), activity = $state<string | null>(null), goalID = $state<string | null>(null);
  // CareerCircleView.OnCareerNodeHoverOn / Off: the inner circles to 0.4 while a career node is hovered, out after.
  let careerHover = $state(false);
  // CareerCircleView._GetNodeMask: the inner mask down for the enforcer (6) and explorer (4), up otherwise; the other
  // views' CircleView._GetNodeMask: the count's mask.
  const careerMask = $derived(`res:/UI/Texture/classes/careerPortal/nodeMasks/career_inner_mask_${careerID === 6 || careerID === 4 ? "down" : "up"}.png`);
  const countMask = (n: number) => `res:/UI/Texture/classes/careerPortal/nodeMasks/${n}_node_mask.png`;
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
  // _load_definitions: a career's goals with an activity group of CAREER_PATH_GROUPS'; the one with none is its own.
  const careerGoals = (c: Career) => (goals ?? []).filter((g) => g.career === c.proto && (c.groups as readonly string[]).includes(g.annotations.group ?? ""));
  const careerPathGoal = (c: Career | null) => (c ? (goals ?? []).find((g) => g.career === c.proto && !(c.groups as readonly string[]).includes(g.annotations.group ?? "")) ?? null : null);
  // OverallGoalGroup: the goals of no career, by target; get_overall_progress the last one's progress, get_max_target its target.
  const overall = $derived([...(goals ?? []).filter((g) => !CAREERS.some((c) => c.proto === g.career))].sort((a, b) => a.target - b.target));
  const overallTarget = $derived(overall.at(-1)?.target ?? 0);
  const overallProgress = $derived(overall.at(-1)?.progress ?? 0);
  const CAREER_VIDEOS: Record<number, string> = { 6: "Enforcer_Intro", 7: "SOF_Intro", 4: "Exploration_Intro", 5: "Industry_Intro" };
  let video = $state<string | null>(null);
  // careerConst.ICON_BY_ACTIVITY_ID, in CAREER_PATH_GROUPS' order for each career.
  const ACTIVITY_ICONS: Record<number, readonly string[]> = {
    4: ["explorer_agent", "scanning", "hacking", "advanced_hacking", "wormholes", "gas_sites", "combat_sites", "navigation", "advanced_navigation", "project_discovery"],
    5: ["industrialist_agent", "market", "salvaging", "explorer_agent", "refining", "industry", "industrialist_agent", "mining_agent", "research"],
    6: ["enforcer_agent", "enforcer_agent", "abyssal_filament", "combat", "bounties", "combat_sites", "epic_arc", "market", "standings", "loyalty_points"],
    7: ["sof_agent", "social", "electronicwarfare", "combat", "duel_pvp", "cap_warfare", "faction_warfare", "fleet_support", "destroy", "duel_pvp"],
  };
  const activityIcon = (c: Career, key: string) => { const i = (c.groups as readonly string[]).indexOf(key), name = ACTIVITY_ICONS[c.id]?.[i]; return name ? clientTexture(`res:/UI/Texture/classes/careerPortal/activities/${name}_32.png`) : null; };
  // CircleViewContainer.PrepareUI: min(MAX_CIRCLE_WIDTH, the window's width / 2) - the circle behind the panels, which
  // lie over it (CareerPortal: central_container TOALL under clip_container's left and right panels, PANEL_WIDTH_RATIO
  // 0.25). The width read on a timer: a hidden page's ResizeObserver does not run.
  let centreEl = $state<HTMLDivElement | null>(null), centreWidth = $state(0), centreHeight = $state(0);
  $effect(() => { const t = setInterval(() => { if (centreEl) { centreWidth = centreEl.clientWidth; centreHeight = centreEl.clientHeight; } }, 400); return () => clearInterval(t); });
  const circle = $derived(Math.max(220, Math.min(800, (centreWidth || 900) / 2, (centreHeight || 600) - 16)));
  const done = (list: readonly CareerGoal[]) => list.filter((g) => g.completed).length;
  const byOrder = (list: readonly CareerGoal[]) => [...list].sort((a, b) => (Number(a.annotations.order) || 0) - (Number(b.annotations.order) || 0));
  const activities = $derived(career ? career.groups.map((g) => ({ key: g, goals: byOrder(careerGoals(career).filter((x) => x.annotations.group === g)) })).filter((a) => a.goals.length) : []);
  const activityGoals = $derived(activities.find((a) => a.key === activity)?.goals ?? []);
  const goal = $derived(goalID ? (goals ?? []).find((g) => g.goalID === goalID) ?? null : null);
  $effect(() => {
    flow.requestWords([C + "CareerPortalWnd", C + "RewardsHeader", "UI/Common/Information", C + "Threat", C + "GoalDuration", C + "TrackGoal", C + "UntrackGoal", C + "GoalCompleted", "UI/Commands/Back",
      ...[0, 1, 2, 3].map((t) => `${C}Threat${t}`),
      ...CAREERS.flatMap((c) => c.groups.map((g) => `Character/CareerGoals/${c.key}/GroupNames/${g}`)),
      C + "HelpVideos", C + "NoVideosAvailable",
      ...(goal ? [Number(goal.annotations.auraTextID) || null, Number(goal.annotations.agencyLinkTextID) || null].filter((x): x is number => !!x).map((x) => `#${x}`) : []),
      ...Object.values(careerTexts).flatMap((t) => [t.nameID, t.descriptionID]).filter((x): x is number => !!x).map((x) => `#${x}`),
      C + "AuraAssistancePanelTitle", C + "AuraAssistanceFreelanceJobsTitle", C + "AuraAssistanceFreelanceJobsText", C + "OpenFreelanceJobs", "UI/Corporations/FreelanceProjects/FreelanceJobsAOFeatureDescription",
      C + "AuraAssistanceCareerAgentMissionsTitle", C + "AuraAssistanceCareerAgentsText", C + "AuraAssistanceSkillPlansTitle", C + "AuraAssistanceSkillPlansText", C + "AuraAssistanceOpenSkillPlanButton",
      C + "GraduationReward", C + "PlayVideo", C + "OverallProgress", C + "OverallCareerPoints",
      ...(goals ?? []).filter((g) => view === "GOALS_VIEW" ? g.annotations.group === activity : g.goalID === goalID).flatMap((g) => [g.nameID, g.descriptionID]).filter((x): x is number => !!x).map((x) => `#${x}`)]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const careerName = (c: Career) => (careerTexts[c.id]?.nameID ? word(`#${careerTexts[c.id]!.nameID}`) : c.key);
  const groupName = (c: Career, g: string) => word(`Character/CareerGoals/${c.key}/GroupNames/${g}`) || g;
  const threat = (g: CareerGoal) => word(`${C}Threat${g.threat}`);
  // get_text_for_reward; get_texture_path_for_reward (skill points' icons by amount; ISK the Kredits' icon).
  const rewardText = (r: CareerGoal["rewards"][number]) => (r.kind === "item" ? `${r.quantity.toLocaleString("en-US")}x ${r.typeID ? resolvedName($names.resolved, "type", r.typeID, "") : ""}`
    : `${r.quantity.toLocaleString("en-US")} ${r.kind === "sp" ? word("UI/Common/SkillPoints") || "Skill Points" : word("UI/Common/ISK") || "ISK"}`);
  const rewardIcon = (r: CareerGoal["rewards"][number]) => (r.kind === "sp" ? clientTexture(`res:/UI/Texture/Icons/SkillPoints/${r.quantity >= 125000 ? "150k" : r.quantity >= 100000 ? "100k" : "50k"}.png`)
    : r.kind === "isk" ? clientTexture("res:/UI/Texture/eveicon/category_icons/isk_32px.png") : null);
  // careerConst.CRATE_64_SIZES by career.
  const CRATES: Record<number, string> = { 6: "enforcerCrate", 7: "sofCrate", 4: "explorerCrate", 5: "industrialistCrate" };
  const isOmega = $derived($station.cloneGrade !== 0);
  let claimed = $state<Record<string, "busy" | "done">>({});
  const entries = $derived((goals ?? []).flatMap((g) => g.unclaimedLabels.map((label) => ({ goal: g, label, rewards: g.rewards.filter((r) => r.label === label) }))));
  async function claim(goalID: string, label: string): Promise<void> {
    const k = `${goalID}:${label}`;
    if (claimed[k]) return;
    claimed = { ...claimed, [k]: "busy" };
    const ok = await flow.claimCareerReward(goalID, label);
    claimed = ok ? { ...claimed, [k]: "done" } : Object.fromEntries(Object.entries(claimed).filter(([key]) => key !== k));
  }
  $effect(() => {
    flow.requestWords([C + "YourRewards", C + "ClaimAllRewards", C + "ClaimReward", C + "RewardClaimed", C + "CheckRedeemingQueue", C + "RewardBundle", C + "ItemsInRewardBundle", C + "Locked", C + "UpgradeToClaim",
      "UI/Common/SkillPoints", "UI/Common/ISK", ...entries.map((e) => e.goal.nameID).filter((x): x is number => !!x).map((x) => `#${x}`)]);
    const types = [...new Set((goals ?? []).flatMap((g) => g.rewards.map((r) => r.typeID)).filter((x): x is number => !!x))];
    if (types.length) flow.requestNames(types.map((id) => ({ kind: "type" as const, id })));
  });
</script>

<div class="cpw">
  <header class="cpw-head">
    {#if view !== "CAREERS_VIEW"}<button type="button" class="cpw-back" onclick={() => (view === "GOALS_VIEW" ? go("ACTIVITIES_VIEW", careerID, activity, null) : go("CAREERS_VIEW", careerID, null, null))}>‹ {word("UI/Commands/Back") || "Back"}</button>{/if}
    <h2>{view === "CAREERS_VIEW" ? word(C + "CareerPortalWnd") : career ? careerName(career) : ""}{#if view === "GOALS_VIEW" && career && activity} · {groupName(career, activity)}{/if}</h2>
  </header>
  <div class="cpw-body">
    <aside class="cpw-rewards">
      <div class="cpw-rewards-head"><h3>{word(C + "YourRewards")}</h3>
        {#if entries.some((e) => !claimed[`${e.goal.goalID}:${e.label}`] && !(e.label === "REWARD_LABEL_OMEGA" && !isOmega))}
          <button type="button" onclick={() => { for (const e of entries) if (!(e.label === "REWARD_LABEL_OMEGA" && !isOmega)) void claim(e.goal.goalID, e.label); }}>{word(C + "ClaimAllRewards")}</button>{/if}</div>
      {#each entries as e (`${e.goal.goalID}:${e.label}`)}
        {@const k = `${e.goal.goalID}:${e.label}`}
        {@const locked = e.label === "REWARD_LABEL_OMEGA" && !isOmega}
        {@const careerID = CAREERS.find((c) => c.proto === e.goal.career)?.id ?? 0}
        <div class="cpw-reward" class:claimed={claimed[k] === "done"} title={claimed[k] === "done" ? word(C + "CheckRedeemingQueue") : ""}>
          <div class="cpw-reward-top">
            {#if e.rewards.length === 1}
              {#if rewardIcon(e.rewards[0]!)}<img alt="" src={rewardIcon(e.rewards[0]!)} />{/if}<b>{rewardText(e.rewards[0]!)}</b>
            {:else}
              {#if CRATES[careerID]}<img alt="" src={clientTexture(`res:/UI/Texture/classes/careerPortal/crates/${CRATES[careerID]}_64.png`)} />{/if}
              <span><b>{word(C + "RewardBundle")}</b><small>{word(C + "ItemsInRewardBundle", { quantity: e.rewards.length })}</small></span>
            {/if}
            {#if locked}<button type="button" disabled>{word(C + "UpgradeToClaim")}</button>
            {:else}<button type="button" disabled={!!claimed[k]} onclick={() => void claim(e.goal.goalID, e.label)}>{claimed[k] === "done" ? word(C + "RewardClaimed") : claimed[k] === "busy" ? "…" : word(C + "ClaimReward")}</button>{/if}
          </div>
          <div class="cpw-reward-goal">{locked ? `${word(C + "Locked")} · ` : ""}{e.goal.nameID ? word(`#${e.goal.nameID}`) : ""}</div>
        </div>
      {/each}
    </aside>
    <div class="cpw-centre" bind:this={centreEl}>
      {#if goals === undefined}<p class="cpw-dim">…</p>
      {:else if goals === null}<p class="cpw-dim">{word("UI/Opportunities/FailedToLoad")}</p>
      {:else if view === "CAREERS_VIEW"}
        <!-- CareerView: the four careers, their 128 px icons, names and goals done (CareerPointsNumFull). -->
        <CareerCircle nodes={CAREERS} size={circle} nodeSize={Math.min(180, circle * 0.215)} offset={-Math.PI / 4} completed={CAREERS.every((c) => careerGoals(c).every((g) => g.completed))}
          inner={{ mask: careerMask, scale: 0.8, opacity: careerHover ? 0.4 : 0 }}>
          {#snippet node(n: unknown)}
            {@const c = n as Career}
            {@const list = careerGoals(c)}
            <button type="button" class="cpw-career" class:on={careerID === c.id} title={careerName(c)} onclick={() => go("ACTIVITIES_VIEW", c.id, null, null)}
              onmouseenter={() => (careerHover = true)} onmouseleave={() => (careerHover = false)}>
              {#if careerIcon(c.id, 128)}<img alt="" src={careerIcon(c.id, 128)} />{/if}
              <b>{careerName(c)}</b><small>{done(list)} / {list.length}</small>
            </button>
          {/snippet}
          {#snippet centre()}<b class="cpw-centre-title">{word(C + "CareerPortalWnd")}</b>{/snippet}
        </CareerCircle>
      {:else if view === "ACTIVITIES_VIEW" && career}
        <!-- ActivityView: the career's activities, each its ICON_BY_ACTIVITY_ID icon in a ring of dashes (one a goal, green
             for those done) and, on hover, its name and ActivityProgressCount. -->
        <CareerCircle nodes={activities} size={circle} nodeSize={48} offset={-Math.PI / 2} completed={activities.every((a) => a.goals.every((g) => g.completed))}
          inner={{ mask: countMask(activities.length), scale: 0.91, opacity: 1 }}>
          {#snippet node(n: unknown)}
            {@const a = n as (typeof activities)[number]}
            <button type="button" class="cpw-row cpw-node" class:on={activity === a.key} class:done={a.goals.every((g) => g.completed)}
              title={`${groupName(career, a.key)} - ${done(a.goals)} / ${a.goals.length}`} style:--done={`${(done(a.goals) / Math.max(1, a.goals.length)) * 360}deg`}
              onclick={() => go("GOALS_VIEW", careerID, a.key, null)}>
              {#if activityIcon(career, a.key)}<img alt="" src={activityIcon(career, a.key)} />{/if}
              <span class="cpw-node-label">{groupName(career, a.key)}<small>{done(a.goals)} / {a.goals.length}</small></span>
            </button>
          {/snippet}
          {#snippet centre()}{#if careerIcon(career.id, 128)}<img class="cpw-centre-icon" alt="" src={careerIcon(career.id, 128)} />{/if}<b class="cpw-centre-title">{careerName(career)}</b>{/snippet}
        </CareerCircle>
      {:else if view === "GOALS_VIEW" && career}
        <!-- GoalView: the activity's goals, each a dot (smallDot), goalCompleted where done, the open eye where tracked. -->
        <CareerCircle nodes={activityGoals} size={circle} nodeSize={48} offset={-Math.PI / 2} completed={activityGoals.every((g) => g.completed)}
          inner={{ mask: countMask(activityGoals.length), scale: 0.91, opacity: 1 }}>
          {#snippet node(n: unknown)}
            {@const g = n as CareerGoal}
            <button type="button" class="cpw-row cpw-node cpw-goalnode" class:on={goalID === g.goalID} class:done={g.completed}
              title={`${g.nameID ? word(`#${g.nameID}`) : ""} - ${g.progress.toLocaleString("en-US")} / ${g.target.toLocaleString("en-US")}`}
              onclick={() => go("GOALS_VIEW", careerID, activity, g.goalID)}>
              <img alt="" src={clientTexture(g.completed ? "res:/UI/Texture/classes/careerPortal/circleView/goalCompleted.png" : $tracked.includes(g.goalID) ? "res:/UI/Texture/classes/careerPortal/circleView/eye_open_32.png" : "res:/UI/Texture/Shared/smallDot.png")} />
              <span class="cpw-node-label">{$tracked.includes(g.goalID) ? "👁 " : ""}{g.nameID ? word(`#${g.nameID}`) : ""}<small>{g.progress.toLocaleString("en-US")} / {g.target.toLocaleString("en-US")}</small></span>
            </button>
          {/snippet}
          {#snippet centre()}{#if activity && activityIcon(career, activity)}<img class="cpw-centre-icon small" alt="" src={activityIcon(career, activity)} />{/if}<b class="cpw-centre-title">{activity ? groupName(career, activity) : ""}</b>{/snippet}
        </CareerCircle>
      {/if}
    </div>
    {#snippet freelance(short: boolean)}
      <h4>{word(C + "AuraAssistanceFreelanceJobsTitle")}</h4>
      <p>{short ? word("UI/Corporations/FreelanceProjects/FreelanceJobsAOFeatureDescription") : word(C + "AuraAssistanceFreelanceJobsText")}</p>
      <button type="button" class="cpw-ghost" onclick={() => openJobBoard()}>{word(C + "OpenFreelanceJobs")}</button>
    {/snippet}
    {#if view === "CAREERS_VIEW" && goals}
      <aside class="cpw-goal cpw-aura"><h3>{word(C + "AuraAssistancePanelTitle")}</h3>{@render freelance(false)}</aside>
    {:else if view === "ACTIVITIES_VIEW" && career}
      {@const cg = careerPathGoal(career)}
      {@const cname = careerName(career)}
      <div class="cpw-side">
        <aside class="cpw-goal">
          <div class="cpw-title">{#if careerIcon(career.id, 32)}<img alt="" src={careerIcon(career.id, 32)} />{/if}<h3>{cname}</h3></div>
          <button type="button" class="cpw-ghost" onclick={() => { video = CAREER_VIDEOS[career.id] ?? null; }}>▶ {word(C + "PlayVideo")}</button>
          <p>{careerTexts[career.id]?.descriptionID ? word(`#${careerTexts[career.id]!.descriptionID}`) : ""}</p>
          <div class="cpw-title"><img alt="" class="cpw-crate" src={clientTexture(`res:/UI/Texture/classes/careerPortal/crates/${CRATES[career.id]}_64.png`)} /><h4>{word(C + "GraduationReward")}</h4></div>
          {#if cg}{#each [...cg.rewards.filter((r) => r.label === "REWARD_LABEL_OMEGA"), ...cg.rewards.filter((r) => r.label !== "REWARD_LABEL_OMEGA")] as r, i (i)}
            <div class="cpw-entry">{#if rewardIcon(r)}<img alt="" src={rewardIcon(r)} />{/if}<span>{rewardText(r)}</span>{#if r.label === "REWARD_LABEL_OMEGA"}<small class="cpw-omega">Ω</small>{/if}</div>
          {/each}{/if}
        </aside>
        <aside class="cpw-goal cpw-aura">
          <h3>{word(C + "AuraAssistancePanelTitle")}</h3>
          <h4>{word(C + "AuraAssistanceCareerAgentMissionsTitle")}</h4><p>{word(C + "AuraAssistanceCareerAgentsText", { careerPathName: cname })}</p><hr />
          <h4>{word(C + "AuraAssistanceSkillPlansTitle")}</h4><p>{word(C + "AuraAssistanceSkillPlansText")}</p>
          <button type="button" class="cpw-ghost" onclick={() => showCertifiedPlans(career.id)}>{word(C + "AuraAssistanceOpenSkillPlanButton", { careerPathName: cname })}</button><hr />
          {@render freelance(true)}
        </aside>
      </div>
    {/if}
    {#if view === "GOALS_VIEW" && !goal}
      <aside class="cpw-goal cpw-aura"><h3>{word(C + "AuraAssistancePanelTitle")}</h3>
        <h4>{word(C + "HelpVideos")}</h4>
        {#if !activityGoals.some((g) => Number(g.annotations.videoID))}<p>{word(C + "NoVideosAvailable")}</p>{/if}<hr />
        {@render freelance(true)}</aside>
    {/if}
    {#if view === "GOALS_VIEW" && goal}
      <div class="cpw-side">
      <aside class="cpw-goal">
        <h3>{goal.nameID ? word(`#${goal.nameID}`) : ""}</h3>
        <p>{goal.descriptionID ? word(`#${goal.descriptionID}`) : ""}</p>
        <hr /><h4>{word(C + "RewardsHeader")}</h4>
        {#each [...goal.rewards.filter((r) => r.label === "REWARD_LABEL_OMEGA"), ...goal.rewards.filter((r) => r.label !== "REWARD_LABEL_OMEGA")] as r, i (i)}
          <div class="cpw-entry">{#if rewardIcon(r)}<img alt="" src={rewardIcon(r)} />{/if}<span>{rewardText(r)}</span>{#if r.label === "REWARD_LABEL_OMEGA"}<small class="cpw-omega">Ω</small>{/if}</div>
        {/each}
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
      <aside class="cpw-goal cpw-aura">
        <div class="cpw-title"><img alt="" src={clientTexture("res:/UI/Texture/classes/careerPortal/aura/aura_icon_32x32.png")} /><h3>{word(C + "AuraAssistancePanelTitle")}</h3></div>
        {#if Number(goal.annotations.auraTextID)}<p class="cpw-aura-text">{word(`#${goal.annotations.auraTextID}`)}</p>{/if}
        {#if Number(goal.annotations.agencyLinkTextID)}<button type="button" class="cpw-ghost" onclick={() => openAgencyGroup(AGENCY_SCREEN_GROUPS[goal.annotations.agencyScreen ?? ""] ?? 1)}>{word(`#${goal.annotations.agencyLinkTextID}`)}</button>{/if}
        <hr />{@render freelance(true)}
      </aside>
      </div>
    {/if}
  </div>
  {#if goals && overallTarget > 0}
    <footer class="cpw-footer" title={word(C + "OverallCareerPoints", { currentPoints: overallProgress, totalPoints: overallTarget })}>
      <span>{word(C + "OverallProgress")}</span>
      <div class="cpw-bar"><span style:width={`${Math.min(1, overallProgress / overallTarget) * 100}%`}></span>
        {#each overall.filter((g) => g.rewards.length) as g (g.goalID)}<i class:done={g.completed} style:left={`${(g.target / overallTarget) * 100}%`}></i>{/each}</div>
      <small>{overallProgress.toLocaleString("en-US")} / {overallTarget.toLocaleString("en-US")}</small>
    </footer>
  {/if}
  {#if video}
    <div class="cpw-video" role="presentation" onclick={() => { video = null; }}>
      <!-- svelte-ignore a11y_media_has_caption -->
      <video autoplay controls src={clientTexture(`res:/video/AIRCareerProgram/CareerIntros/${video}.webm`)}></video>
    </div>
  {/if}
</div>

<style>
  .cpw { position: relative; display: flex; flex-direction: column; height: 100%; gap: 8px; }
  .cpw-head { display: flex; align-items: center; gap: 12px; }
  .cpw-head h2 { margin: 0; font-size: 18px; }
  .cpw-back { background: none; border: 1px solid rgb(255 255 255 / 0.2); }
  .cpw-body { position: relative; flex: 1; min-height: 0; }
  .cpw-centre { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  .cpw-body > .cpw-rewards { position: absolute; left: 0; top: 0; max-height: 100%; z-index: 1; }
  .cpw-body > .cpw-goal, .cpw-body > .cpw-side { position: absolute; right: 0; top: 0; max-height: 100%; z-index: 1; }
  .cpw-dim { opacity: 0.65; }
  .cpw-career { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; font-size: 12px; }
  .cpw-career img { width: 70%; height: auto; }
  .cpw-career:hover img, .cpw-career.on img { filter: drop-shadow(0 0 6px rgb(255 255 255 / 0.6)); }
  .cpw-node { position: relative; width: 48px; height: 48px; padding: 0; border-radius: 50%; justify-content: center; align-items: center; border-left: none;
    background: radial-gradient(circle, rgb(0 0 0 / 0.85) 62%, transparent 64%), conic-gradient(#6ab04c var(--done, 0deg), rgb(255 255 255 / 0.35) 0); }
  .cpw-node img { width: 32px; height: 32px; }
  .cpw-goalnode { background: rgb(0 0 0 / 0.6); }
  .cpw-goalnode img { width: 20px; height: 20px; }
  .cpw-node.done img { filter: hue-rotate(60deg) saturate(2); }
  .cpw-node.on { box-shadow: 0 0 0 2px rgb(255 255 255 / 0.7); }
  .cpw-node-label { display: none; position: absolute; top: 52px; left: 50%; transform: translateX(-50%); white-space: nowrap; padding: 2px 6px; background: rgb(0 0 0 / 0.85); font-size: 12px; z-index: 2; }
  .cpw-node-label small { margin-left: 6px; opacity: 0.7; }
  .cpw-node:hover .cpw-node-label, .cpw-node.on .cpw-node-label { display: block; }
  .cpw-centre-title { display: block; font-size: 16px; }
  .cpw-centre-icon { width: 96px; height: 96px; opacity: 0.85; }
  .cpw-centre-icon.small { width: 48px; height: 48px; }
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
  .cpw-rewards { width: 260px; flex: none; overflow: auto; padding: 12px; background: rgb(0 0 0 / 0.9); border-top: 1px solid rgb(88 166 220 / 0.6); }
  .cpw-rewards-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
  .cpw-rewards-head h3 { margin: 0; font-size: 16px; }
  .cpw-reward { margin-bottom: 8px; background: rgb(255 255 255 / 0.05); }
  .cpw-reward.claimed { opacity: 0.5; }
  .cpw-reward-top { display: flex; align-items: center; gap: 8px; padding: 8px; }
  .cpw-reward-top img { width: 48px; height: 48px; }
  .cpw-reward-top span { display: flex; flex-direction: column; }
  .cpw-reward-top b { flex: 1; }
  .cpw-reward-goal { padding: 4px 8px; font-size: 12px; opacity: 0.7; background: rgb(0 0 0 / 0.5); }
  .cpw-omega { color: #e6a23c; }
  .cpw-aura-text { font-size: 14px !important; }
  .cpw-side { display: flex; flex-direction: column; gap: 16px; width: 320px; flex: none; overflow: auto; }
  .cpw-side .cpw-goal { width: auto; }
  .cpw-aura { border-left: 2px solid rgb(166 110 224 / 0.8); }
  .cpw-aura h3 { color: rgb(166 110 224); }
  .cpw-goal p { font-size: 12px; color: rgb(255 255 255 / 0.8); }
  .cpw-title { display: flex; align-items: center; gap: 8px; }
  .cpw-title img { width: 32px; height: 32px; }
  .cpw-title .cpw-crate { width: 64px; height: 64px; }
  .cpw-ghost { background: none; border: 1px solid rgb(255 255 255 / 0.2); width: 100%; margin: 4px 0; }
  .cpw-footer { display: flex; align-items: center; gap: 12px; padding: 8px 32px; }
  .cpw-bar { position: relative; flex: 1; height: 6px; background: rgb(255 255 255 / 0.1); }
  .cpw-bar > span { display: block; height: 100%; background: rgb(88 166 220); }
  .cpw-bar i { position: absolute; top: -4px; width: 2px; height: 14px; background: rgb(255 255 255 / 0.5); }
  .cpw-bar i.done { background: #5fb85f; }
  .cpw-video { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgb(0 0 0 / 0.85); z-index: 5; }
  .cpw-video video { max-width: 90%; max-height: 90%; }
</style>
