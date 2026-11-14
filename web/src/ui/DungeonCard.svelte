<script lang="ts">
  // jobboard features/dungeons/card.DungeonCard (a JobCard): at the top the feature's tag (the first feature-type tag of
  // GetDungeonContentTags: its eveicon and title) and, at the right, the state's icon (get_state_info: UI/Generic/
  // CurrentLocation in CRYO_BLUE while the pilot is in it; the left line in its colour, else THEME_FOCUS); the solar
  // system (SolarSystemChip: security, name, the jumps); the title (the dungeon's name, two lines); at the bottom the
  // subtitle - CombatAnomalyJob.subtitle: the faction's name and UI/Agency/LevelX of the difficulty, "-" between.
  // Its click opens the dungeon's page.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, DungeonJob } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  let { store, flow, job, onOpen }: { store: ClientStore; flow: AppFlow; job: DungeonJob; onOpen: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const feature = $derived(job.data?.contentTags.find((t) => t.type === "feature") ?? null);
  $effect(() => {
    flow.requestWords(["UI/Agency/LevelX", "UI/Generic/CurrentLocation", ...[job.data?.nameID ?? null, feature?.title ?? null].filter((x): x is number => x !== null).map((x) => `#${x}`)]);
    flow.requestSystemSecurity([job.solarSystemID]);
  });
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (k, id) => resolvedName($names.resolved, k, id, "") }));
  const subtitle = $derived.by(() => {
    const faction = job.data?.factionID ? resolvedName($names.resolved, "owner", job.data.factionID, "") : "";
    const level = job.data?.difficulty ? word("UI/Agency/LevelX", { level: job.data.difficulty }) : "";
    return level ? (faction ? `${faction} - ${level}` : level) : faction;
  });
  const security = $derived($names.systemSecurity?.[job.solarSystemID] ?? null);
</script>

<div class="dj-card" role="button" tabindex="-1" style:border-left-color={job.active ? "#57b8d6" : "var(--theme-focus, #58a6dc)"} onclick={onOpen} onkeydown={() => {}}>
  <div class="dj-top">
    {#if feature?.icon}<img alt="" src={clientTexture(`res:/UI/Texture/eveicon/category_icons/${feature.icon}_16px.png`)} />{/if}
    <span class="dj-dim">{feature?.title ? word(`#${feature.title}`) : ""}</span>
    {#if job.active}<span class="dj-state" title={word("UI/Generic/CurrentLocation")}>📍</span>{/if}
  </div>
  <div class="dj-system">{#if security !== null}<b style:color={securityStatusColor(security)}>{shownSecurity(security).toFixed(1)}</b>{/if} {resolvedName($names.resolved, "system", job.solarSystemID, "")}{#if job.jumps !== null && job.jumps > 0}<span class="dj-dim"> · {job.jumps} {job.jumps === 1 ? "jump" : "jumps"}</span>{/if}</div>
  <div class="dj-title">{job.data?.nameID ? word(`#${job.data.nameID}`) : ""}</div>
  <div class="dj-bottom">{subtitle}</div>
</div>

<style>
  .dj-card { position: relative; overflow: hidden; cursor: pointer; height: 150px; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; border-left: 2px solid; background: rgba(0, 0, 0, 0.6); border-radius: 0 8px 8px 0; }
  .dj-top { display: flex; align-items: center; gap: 6px; height: 20px; }
  .dj-top img { width: 16px; height: 16px; }
  .dj-dim { opacity: 0.7; font-size: 12px; }
  .dj-state { margin-left: auto; color: #57b8d6; }
  .dj-system { margin-top: 8px; font-size: 12px; }
  .dj-title { flex: 1; font-weight: bold; padding-top: 8px; overflow: hidden; }
  .dj-bottom { font-size: 12px; opacity: 0.8; }
</style>
