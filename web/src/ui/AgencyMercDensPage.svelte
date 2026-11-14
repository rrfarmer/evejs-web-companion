<script lang="ts">
  // agencyNew/ui/contentPages/contentPageMercDens.ContentPageMercDen (a BaseContentGroupPage, two columns of COL_WIDTH 500,
  // 500 high): the left column Overview (OverviewText, and Set Destination to Zarzakh - a MercDenContentPiece's
  // stateful button for solarSystemZarzakh 30100000), Deployment (DeploymentText; Upgrade to Omega where the clone is not
  // Omega, Open Skill Training where Mercenary Den Management (85233) is below level 5) and States (StatesText); the
  // right column Activities (ActivitiesText, Open MTO Opportunities: the job board's browse page) and My Mercenary Dens
  // (MyMercDensText, Open My Mercenary Dens). Each section 10 apart, its buttons BTN_TOP_PADDING 12 below the text.
  // Not here (later parts): the job board's browse page filtered to the Mercenary Tactical Ops tag, the clone upgrade
  // window, the My Mercenary Dens window (neither is built: those two buttons do nothing yet).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { openJobBoard } from "./jobBoardRequests.ts";

  let { store, flow, onOpenTab }: { store: ClientStore; flow: AppFlow; onOpenTab?: (tab: string) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const skills = store.skills;
  // svelte-ignore state_referenced_locally
  const waypoints = flow.waypoints;
  const M = "UI/Agency/MercDen/";
  const ZARZAKH = 30100000, MERC_DEN_SKILL = 85233;
  const word = (label: string) => plainText(formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  $effect(() => {
    flow.requestWords([`${M}OverviewHeader`, `${M}OverviewText`, `${M}SetDestinationToZarzakh`, `${M}DeploymentHeader`, `${M}DeploymentText`, `${M}StatesHeader`, `${M}StatesText`,
      `${M}ActivitiesHeader`, `${M}ActivitiesText`, `${M}OpenMTOOpportunities`, `${M}MyMercDensHeader`, `${M}MyMercDensText`, `${M}OpenMyMercDenBtn`, `${M}OpenSkillTraining`,
      "Tooltips/SkillPlanner/UpgradeToOmega", "UI/Inflight/DestinationSet"]);
    if ($skills.skills === null) void flow.loadSkills().catch(() => {});
  });
  const isOmega = $derived($station.cloneGrade !== 0);
  const skillLevel = $derived(($skills.skills ?? []).find((s) => s.typeID === MERC_DEN_SKILL)?.level ?? 0);
  const destinationSet = $derived($waypoints[$waypoints.length - 1] === ZARZAKH);
</script>

<div class="amd">
  <div class="amd-col">
    <section class="amd-section"><h3>{word(`${M}OverviewHeader`)}</h3><p>{word(`${M}OverviewText`)}</p>
      <button type="button" class="amd-wide" disabled={destinationSet} onclick={() => flow.setDestination(ZARZAKH)}>{destinationSet ? word("UI/Inflight/DestinationSet") : word(`${M}SetDestinationToZarzakh`)}</button></section>
    <section class="amd-section"><h3>{word(`${M}DeploymentHeader`)}</h3><p>{word(`${M}DeploymentText`)}</p>
      {#if !isOmega || skillLevel < 5}
        <div class="amd-buttons">
          {#if !isOmega}<button type="button" class="amd-omega" disabled>Ω {word("Tooltips/SkillPlanner/UpgradeToOmega")}</button>{/if}
          {#if skillLevel < 5}<button type="button" onclick={() => onOpenTab?.("skills")}>{word(`${M}OpenSkillTraining`)}</button>{/if}
        </div>
      {/if}</section>
    <section class="amd-section"><h3>{word(`${M}StatesHeader`)}</h3><p>{word(`${M}StatesText`)}</p></section>
  </div>
  <div class="amd-col">
    <section class="amd-section"><h3>{word(`${M}ActivitiesHeader`)}</h3><p>{word(`${M}ActivitiesText`)}</p>
      <button type="button" class="amd-wide" onclick={() => openJobBoard()}>{word(`${M}OpenMTOOpportunities`)}</button></section>
    <section class="amd-section"><h3>{word(`${M}MyMercDensHeader`)}</h3><p>{word(`${M}MyMercDensText`)}</p>
      <button type="button" class="amd-wide" disabled>{word(`${M}OpenMyMercDenBtn`)}</button></section>
  </div>
</div>

<style>
  .amd { display: flex; gap: 0; justify-content: center; height: 100%; min-height: 0; }
  .amd-col { width: 500px; flex: none; display: flex; flex-direction: column; gap: 10px; padding: 0 20px; overflow: auto; box-sizing: border-box; }
  .amd-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; }
  .amd-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .amd-section p { margin: 0; font-size: 13px; line-height: 1.4; white-space: pre-line; }
  .amd-wide { display: block; width: 100%; margin-top: 12px; }
  .amd-buttons { display: flex; gap: 10px; margin-top: 12px; }
  .amd-buttons button { flex: 1; }
  .amd-omega { color: #e6a23c; }
</style>
