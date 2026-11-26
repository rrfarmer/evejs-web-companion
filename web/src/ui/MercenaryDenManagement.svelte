<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatInterval, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { MercenaryDenActivities, MercenaryDenRow, MercenaryDenStage } from "../bridge/mercenaryDens.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, den, characterID, activityRevision }: {
    store: ClientStore; flow: AppFlow; den: MercenaryDenRow; characterID: number | null; activityRevision: number;
  } = $props();
  const words = $derived(store.words);
  const denID = $derived(den.id);
  const hintID = $props.id();
  const path = "UI/Sovereignty/MercenaryDen/MyMercenaryDensWindow/";
  const config = "UI/Sovereignty/MercenaryDen/ConfigurationWindow/";
  const labels = {
    evolution: [path + "TabEvolution", "Control Levels"],
    activities: [path + "TabActivities", "Operations"],
    activityTitle: [config + "ActivitiesTitle", "Mercenary Tactical Operations"],
    activityHint: [config + "ActivitiesTooltip", ""],
    next: [config + "NextActivityTimer", "Available in {time_left}"],
    ready: ["UI/Agency/MercDen/ReadyToStart", "Ready to Start"],
    started: ["UI/Agency/MercDen/InProgress", "In Progress"],
    development: [config + "DevelopmentTitle", "Development"],
    anarchy: [config + "AnarchyTitle", "Anarchy"],
    developmentValue: [config + "DevelopmentValue", "Level {level}"],
    anarchyValue: [config + "AnarchyValue", "Level {level}"],
    levelProgress: [config + "LevelProgress", "{current_level}/{level_upper_band}"],
    generationRange: [config + "InfomorphGenerationRateData", "{lower}-{upper}/h"],
    percentage: ["UI/Common/Formatting/Percentage", "{percentage}%"],
    developmentTitleHint: [config + "DevelopmentTooltip", "Current infomorph generation: {current_rate}"],
    anarchyTitleHint: [config + "AnarchyTooltip", "Current workforce impact: {workforce_cost}"],
    developmentProgressHint: [config + "DevelopmentProgressTooltip", "Development {development_value} ({development_progress})\nInfomorph generation: {rate}"],
    anarchyProgressHint: [config + "AnarchyProgressTooltip", "Anarchy {anarchy_value} ({anarchy_progress})\nWorkforce impact: {workforce_cost}"],
    developmentImpact: ["UI/Sovereignty/MercenaryDen/DevelopmentImpact", "Development Impact {impact}"],
    anarchyImpact: ["UI/Sovereignty/MercenaryDen/AnarchyImpact", "Anarchy Impact {impact}"],
    infomorphBonus: ["UI/Sovereignty/MercenaryDen/InfomorphBonus", "Infomorph Bonus {bonus}"],
  } as const;
  const word = (key: keyof typeof labels, args: Record<string, string | number> = {}) =>
    plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1], args, { nameOf: () => "" }));
  function message(id: number): string {
    const text = $words.templates[`#${id}`];
    return text ? plainText(text).trim() : "";
  }
  const tabs = ["evolution", "activities"] as const;
  const tracks = ["development", "anarchy"] as const;
  type Track = typeof tracks[number];
  const levelLabel = (key: Track, stage: number) =>
    word(key === "development" ? "developmentValue" : "anarchyValue", { level: stage });
  const rateLabel = (rate: MercenaryDenRow["infomorphsPerHour"] | null) =>
    rate ? word("generationRange", { lower: rate[0], upper: rate[1] }) : "—";
  const workforceLabel = (workforce: number | null) =>
    workforce === null ? "—" : word("percentage", { percentage: workforce });
  const stageProgress = (stage: MercenaryDenStage) =>
    word("levelProgress", { current_level: stage.points, level_upper_band: stage.maximum });
  function stageHint(key: Track, stage: MercenaryDenStage) {
    const value = levelLabel(key, stage.stage);
    const progress = stageProgress(stage);
    const impact = stage.nextImpact;
    return "infomorphsPerHour" in impact
      ? word("developmentProgressHint", { development_value: value, development_progress: progress, rate: rateLabel(impact.infomorphsPerHour) })
      : word("anarchyProgressHint", { anarchy_value: value, anarchy_progress: progress, workforce_cost: workforceLabel(impact.workforcePercent) });
  }
  type Tab = typeof tabs[number];
  let tab = $state<Tab>("evolution");
  const tabKey = $derived(`evejs.play.${characterID}.MercenaryDen_MyMercenaryDensWindow_LastSelectedTab`);
  function selectTab(next: Tab) {
    tab = next;
    if (characterID) try { localStorage.setItem(tabKey, next); } catch { /* kept in this window */ }
  }

  let activity = $state.raw<MercenaryDenActivities | null>(null);
  let activityDenID: number | null = null;
  let error = $state("");
  let retry = $state(0);
  let now = $state(Date.now());
  const visibleActivities = $derived(activity?.rows.filter(row => row.expiresAt === 0 || row.expiresAt > now).slice(0, 10) ?? []);
  const nextActivity = $derived(activity && activity.capacity !== null && visibleActivities.length < activity.capacity
    && activity.nextAt > now ? formatInterval((activity.nextAt - now) * 10_000) : "");
  $effect(() => {
    const saved = characterID ? readTab(tabKey) : null;
    tab = saved === "activities" ? "activities" : "evolution";
  });
  function readTab(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  $effect(() => {
    const id = tab === "activities" ? denID : null;
    if (id !== activityDenID) {
      activity = null;
      activityDenID = id;
    }
    error = "";
    if (id === null) return;
    void activityRevision;
    void retry;
    let current = true;
    void flow.loadMercenaryDenActivities(id).then(result => {
      if (current) activity = result;
    }).catch(cause => { if (current) error = panelErrorWords(cause); });
    return () => { current = false; };
  });
  $effect(() => {
    if (tab !== "activities") return;
    now = Date.now();
    const clock = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(clock);
  });
  $effect(() => { flow.requestWords(Object.values(labels).map(([key]) => key)); });
</script>

<div class="den-management">
  <div class="den-tabs" role="group" aria-label="Mercenary Den management">
    {#each tabs as key}
      <button type="button" aria-pressed={tab === key} onclick={() => selectTab(key)}>{word(key)}</button>
    {/each}
  </div>
  {#if tab === "evolution"}
    <div class="evolution">
      {#each tracks as key (key)}
        {@const progress = den[key]}
        <div class="evolution-track" data-evolution={key}>
          <div class="evolution-title">
            <strong>{word(key)}</strong>
            <div class="evolution-detail">
              <button class="evolutionInfo" type="button" aria-label={word(key)} aria-describedby={`${hintID}-${key}`}>ⓘ</button>
              <span class="evolution-tooltip" role="tooltip" id={`${hintID}-${key}`}>
                {key === "development"
                  ? word("developmentTitleHint", { current_rate: rateLabel(den.infomorphsPerHour) })
                  : word("anarchyTitleHint", { workforce_cost: workforceLabel(den.workforcePercent) })}
              </span>
            </div>
            <span class="evolution-level">{levelLabel(key, progress.stage)}</span>
          </div>
          <div class="evolution-stages">
            {#each progress.stages as stage (stage.stage)}
              {@const id = `${hintID}-${key}-${stage.stage}`}
              <div class="evolution-detail" data-stage={stage.stage}>
                <button class="stage-ring" class:complete={stage.points === stage.maximum} class:active={stage.active}
                  type="button" aria-current={stage.active ? "step" : undefined}
                  aria-label={levelLabel(key, stage.stage)} aria-describedby={id} style:--fill={`${stage.points / stage.maximum * 100}%`}>
                  <span class="stage-number">{stage.stage}</span>
                  <span class="stage-progress">{stageProgress(stage)}</span>
                </button>
                <span class="evolution-tooltip" role="tooltip" {id}>{stageHint(key, stage)}</span>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <h4 title={word("activityHint")}>{word("activityTitle")}</h4>
    {#if error}
      <p role="alert">{error}</p>
      <button type="button" onclick={() => retry++}>Retry</button>
    {:else if activity === null}
      <p role="status">Loading activities…</p>
    {:else}
      {#key den.id}
        <div class="activity-list">
          {#each visibleActivities as row, index (row.id)}
            <details>
              <summary>
                <strong>{message(row.nameID) || `${word("activityTitle")} ${index + 1}`}</strong>
                <small>
                  {word(row.started ? "started" : "ready")}
                  {#if row.expiresAt > now}
                    <time datetime={new Date(row.expiresAt).toISOString()} title={new Date(row.expiresAt).toLocaleString()}>
                      {formatInterval((row.expiresAt - now) * 10_000)}
                    </time>
                  {/if}
                </small>
              </summary>
              {#if message(row.descriptionID)}<p>{message(row.descriptionID)}</p>{/if}
              <ul class="operation-impact">
                <li>{word("developmentImpact", { impact: row.developmentImpact })}</li>
                <li>{word("anarchyImpact", { impact: row.anarchyImpact })}</li>
                <li>{word("infomorphBonus", { bonus: row.infomorphBonus })}</li>
              </ul>
            </details>
          {/each}
        </div>
      {/key}
      {#if nextActivity}<p class="next-activity">{word("next", { time_left: nextActivity })}</p>{/if}
    {/if}
  {/if}
</div>

<style>
  .den-management { display: grid; gap: 8px; }
  .den-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; border-bottom: 1px solid #ffffff24; margin-top: 4px; }
  .den-tabs button { background: #ffffff0d; border: 0; border-bottom: 2px solid transparent; padding: 6px; color: inherit; }
  .den-tabs button[aria-pressed="true"] { background: #ffffff16; border-color: #b6dbe6; }
  h4, p { margin: 0; }
  .evolution, .activity-list { display: grid; gap: 6px; }
  .activity-list:empty { display: none; }
  .evolution-track { position: relative; display: grid; gap: 5px; }
  .evolution-title { display: flex; gap: 5px; align-items: center; }
  .evolution-level { margin-left: auto; }
  .evolutionInfo { background: none; border: 0; padding: 0 3px; color: #b6dbe6; }
  .evolution-stages { display: flex; align-items: center; justify-content: space-between; gap: 2px; min-height: 42px; }
  .stage-ring { position: relative; isolation: isolate; display: grid; place-items: center; width: 28px; height: 28px; border: 0; padding: 0;
    border-radius: 50%; background: conic-gradient(#80b8cb var(--fill), #48535d 0); color: #d4e2e9; font-size: 11px; }
  .stage-ring::before { content: ""; position: absolute; z-index: -1; inset: 2px; border-radius: inherit; background: #212830; }
  .stage-ring.complete::before { background: #447e91; }
  .stage-ring.active { outline: 1px solid #b6dbe6; outline-offset: 2px; }
  .stage-progress { display: none; }
  .evolution-detail:hover .stage-ring, .evolution-detail:focus-within .stage-ring { width: 42px; height: 42px; }
  .evolution-detail:hover .stage-progress, .evolution-detail:focus-within .stage-progress { display: inline; }
  .evolution-detail:hover .stage-number, .evolution-detail:focus-within .stage-number { display: none; }
  .evolution-tooltip { display: none; position: absolute; z-index: 3; left: 0; right: 0; top: 100%; pointer-events: none;
    padding: 6px 8px; background: #14191f; border: 1px solid #53636f; color: #ebeff2; white-space: pre-line; }
  .evolution-detail:hover .evolution-tooltip, .evolution-detail:focus-within .evolution-tooltip { display: block; }
  small { color: #bcc6ce; }
  details { background: #ffffff0d; }
  summary { cursor: pointer; padding: 6px 8px; }
  summary small { display: flex; justify-content: space-between; gap: 4px; flex-wrap: wrap; margin-left: 14px; }
  details p { padding: 0 8px 6px; white-space: pre-line; }
  .operation-impact { list-style: none; margin: 0; padding: 0 8px 8px; color: #bcc6ce; }
  .next-activity { color: #bcc6ce; }
</style>
