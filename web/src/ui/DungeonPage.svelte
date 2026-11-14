<script lang="ts">
  // jobboard features/dungeons/page.DungeonPage (a JobPage): Back; the header (the feature's tag, the dungeon's name,
  // the subtitle, the solar system); UI/Common/Description (the dungeon's description); UI/Dungeons/
  // GameplayDescriptionHeader, the operational intel: the gameplay description, then the parameters - the difficulty
  // (UI/Agency/ContentDifficulty: UI/Agency/LevelX, its hint ContentDifficultyTooltip) and the roaming enemies
  // (UI/Agency/RoamingEnemies: the faction where it is one and not factionUnknown, its hint RoamingEnemiesTooltip);
  // then the archetype's section (its title and description). Not here: the ship restrictions, the scan result's ID,
  // the call to action (the travel objective chain's enter_dungeon tasks: set destination, warp to).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, DungeonJob } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow, job, onBack }: { store: ClientStore; flow: AppFlow; job: DungeonJob; onBack: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const d = $derived(job.data);
  const feature = $derived(d?.contentTags.find((t) => t.type === "feature") ?? null);
  const A = "UI/Agency/";
  $effect(() => {
    flow.requestWords(["UI/Commands/Back", "UI/Common/Description", "UI/Dungeons/GameplayDescriptionHeader", A + "ContentDifficulty", A + "ContentDifficultyTooltip", A + "LevelX", A + "RoamingEnemies", A + "RoamingEnemiesTooltip",
      ...[d?.nameID, d?.descriptionID, d?.gameplayDescriptionID, d?.archetypeTitleID, d?.archetypeDescriptionID, feature?.title].filter((x): x is number => typeof x === "number").map((x) => `#${x}`)]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  // appConst.factionUnknown.
  const enemy = $derived(d?.factionID && d.factionID !== 500021 ? d.factionID : null);
  const faction = $derived(d?.factionID ? resolvedName($names.resolved, "owner", d.factionID, "") : "");
  const subtitle = $derived(d?.difficulty ? (faction ? `${faction} - ${word(A + "LevelX", { level: d.difficulty })}` : word(A + "LevelX", { level: d.difficulty })) : faction);
</script>

<div class="dp">
  <div><button class="dp-ghost" onclick={onBack}>{word("UI/Commands/Back") || "Back"}</button></div>
  <header class="dp-head">
    <span class="dp-caption">{#if feature?.icon}<img alt="" src={clientTexture(`res:/UI/Texture/eveicon/category_icons/${feature.icon}_16px.png`)} />{/if}{feature?.title ? word(`#${feature.title}`) : ""}</span>
    <h2>{d?.nameID ? word(`#${d.nameID}`) : ""}</h2>
    <span class="dp-caption">{subtitle}</span>
    <span class="dp-caption">{resolvedName($names.resolved, "system", job.solarSystemID, "")}</span>
  </header>
  {#if d?.descriptionID}<section><h3>{word("UI/Common/Description")}</h3><p>{word(`#${d.descriptionID}`)}</p></section>{/if}
  {#if d?.gameplayDescriptionID || d?.difficulty || enemy}
    <section><h3>{word("UI/Dungeons/GameplayDescriptionHeader")}</h3>
      {#if d?.gameplayDescriptionID}<p>{word(`#${d.gameplayDescriptionID}`)}</p>{/if}
      <div class="dp-params">
        {#if d?.difficulty}<div title={word(A + "ContentDifficultyTooltip")}><small>{word(A + "ContentDifficulty")}</small><b>{word(A + "LevelX", { level: d.difficulty })}</b></div>{/if}
        {#if enemy}<div title={word(A + "RoamingEnemiesTooltip")}><small>{word(A + "RoamingEnemies")}</small><b>{faction}</b></div>{/if}
      </div>
    </section>
  {/if}
  {#if d?.archetypeTitleID && d.archetypeDescriptionID}<section><h3>{word(`#${d.archetypeTitleID}`)}</h3><p>{word(`#${d.archetypeDescriptionID}`)}</p></section>{/if}
</div>

<style>
  .dp { display: flex; flex-direction: column; gap: 8px; }
  .dp-ghost { background: none; border: 1px solid rgba(255, 255, 255, 0.2); }
  .dp-head { padding: 16px; background: rgba(0, 0, 0, 0.5); display: flex; flex-direction: column; gap: 4px; }
  .dp-caption { opacity: 0.8; display: flex; align-items: center; gap: 4px; }
  .dp-caption img { width: 16px; height: 16px; }
  .dp-head h2 { margin: 8px 0 0; font-size: 20px; }
  .dp h3 { margin: 12px 0 8px; font-size: 14px; }
  .dp-params { display: flex; gap: 24px; margin-top: 12px; }
  .dp-params div { display: flex; flex-direction: column; }
  .dp-params small { opacity: 0.65; }
</style>
