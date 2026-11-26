<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatInterval, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { MercenaryDenActivities, MercenaryDenRow } from "../bridge/mercenaryDens.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, den, characterID }: {
    store: ClientStore; flow: AppFlow; den: MercenaryDenRow; characterID: number | null;
  } = $props();
  const words = $derived(store.words);
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
    levelProgress: [config + "LevelProgress", "{current_level} / {level_upper_band}"],
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
  type Tab = typeof tabs[number];
  let tab = $state<Tab>("evolution");
  const tabKey = $derived(`evejs.play.${characterID}.MercenaryDen_MyMercenaryDensWindow_LastSelectedTab`);
  function selectTab(next: Tab) {
    tab = next;
    if (characterID) try { localStorage.setItem(tabKey, next); } catch { /* kept in this window */ }
  }

  let activity = $state.raw<MercenaryDenActivities | null>(null);
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
    activity = null;
    error = "";
    if (tab !== "activities") return;
    void retry;
    let current = true;
    now = Date.now();
    void flow.loadMercenaryDenActivities(den.id).then(result => {
      if (current) activity = result;
    }).catch(cause => { if (current) error = panelErrorWords(cause); });
    const clock = setInterval(() => { now = Date.now(); }, 1000);
    return () => { current = false; clearInterval(clock); };
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
        <div class="evolution-track">
          <strong>{word(key)}</strong>
          <span>{word(key === "development" ? "developmentValue" : "anarchyValue", { level: progress.stage })}</span>
          {#if progress.upperLevel > progress.lowerLevel}
            <progress max={progress.upperLevel - progress.lowerLevel} value={Math.max(0, progress.level - progress.lowerLevel)}
              aria-label={word(key)} aria-valuetext={word("levelProgress", { current_level: progress.level, level_upper_band: progress.upperLevel })}></progress>
            <small>{word("levelProgress", { current_level: progress.level, level_upper_band: progress.upperLevel })}</small>
          {/if}
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
  .evolution-track { display: grid; grid-template-columns: 1fr auto; gap: 3px 8px; align-items: center; }
  progress { width: 100%; height: 8px; accent-color: #b6dbe6; }
  small { color: #bcc6ce; }
  details { background: #ffffff0d; }
  summary { cursor: pointer; padding: 6px 8px; }
  summary small { display: flex; justify-content: space-between; gap: 4px; flex-wrap: wrap; margin-left: 14px; }
  details p { padding: 0 8px 6px; white-space: pre-line; }
  .operation-impact { list-style: none; margin: 0; padding: 0 8px 8px; color: #bcc6ce; }
  .next-activity { color: #bcc6ce; }
</style>
