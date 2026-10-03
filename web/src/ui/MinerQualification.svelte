<script lang="ts">
  import { formatDuration, romanLevel } from "../bridge/skills.ts";
  import { hullChoices, configurationFromFit, qualificationName, type TrainingConfiguration } from "../training/configurations.ts";
  import { fittingsForHull } from "../training/fittingSelection.ts";
  import { requirementCounts, skillTargetLabel, type PlanMode } from "../training/factory.ts";
  import type { MinerTrainingRead, RequirementRow, CorporationSavedFitting, StageFittingSelection } from "../training/types.ts";
  import { equipmentState } from "../training/equipment.ts";
  let { result, selections, mode, busy, onSelect, onAccept, configurations = [], role = "MINER", onSave = () => {}, onRemove = () => {}, now = Date.now(), onReviewEquipment = () => {}, equipmentSourceReady = false }: {
    now?: number; onReviewEquipment?: (id: string) => void; equipmentSourceReady?: boolean;
    configurations?: readonly TrainingConfiguration[]; role?: string; onSave?: (config: TrainingConfiguration) => void; onRemove?: (id: string) => void;
    result: MinerTrainingRead; selections: Readonly<Record<string, StageFittingSelection>>;
    mode: PlanMode; busy: boolean;
    onSelect: (stageID: string, fittingID: number) => void;
    onAccept: (stageID: string, fit: CorporationSavedFitting) => void;
  } = $props();
  let editing = $state<string | null>(null);
  let hull = $state(0), fitting = $state(0), policy = $state("");
  let localError = $state("");
  function edit(id: string | null) {
    const c = configurations.find((c) => c.configurationID === id);
    editing = id || "new"; hull = c?.hullTypeID || 0; fitting = c?.fittingID || 0; policy = c?.supportPolicyKey || ""; localError = "";
  }
  function save() {
    try {
      const fit = result.fittings.find((f) => f.fittingID === fitting && f.shipTypeID === hull && f.ownerID === result.corporationID);
      if (!fit) throw new Error("Choose a valid corporation fitting.");
      const previous = configurations.find((c) => c.configurationID === editing);
      if (configurations.some((c) => c.configurationID !== editing && c.corporationOwnerID === fit.ownerID && c.fittingID === fit.fittingID)) throw new Error("This qualification contract already exists.");
      if (!previous && configurations.length >= 3) throw new Error("Maximum three configurations per role.");
      const next = configurationFromFit(role, fit, previous?.order ?? configurations.length, previous?.configurationID || crypto.randomUUID(), policy || null);
      if (previous && previous.fittingID === fit.fittingID && previous.hullTypeID === fit.shipTypeID && previous.corporationOwnerID === fit.ownerID) {
        next.acceptedSavedDate = previous.acceptedSavedDate; next.acceptedFingerprint = previous.acceptedFingerprint;
      }
      onSave(next); editing = null;
    } catch (cause) { localError = String(cause); }
  }
  const report = $derived(result.report);
  const preview = $derived(report.previews[mode]);
</script>

{#snippet skillRows(rows: readonly RequirementRow[])}
  <div class="table-wrap overflow-x-auto"><table class="guests reflow">
    <thead><tr><th>Skill</th><th>Target</th><th>Trained</th><th>Target status</th></tr></thead>
    <tbody>{#each rows as row (row.typeID)}<tr>
      <td data-label="Skill">{row.name}</td>
      <td data-label="Target">{romanLevel(row.level)}</td>
      <td data-label="Trained">{row.trainedLevel === null ? "Unknown" : romanLevel(row.trainedLevel) || "—"}</td>
      <td data-label="Target status">{skillTargetLabel(row.state)}{row.queuePosition >= 0 ? ` · queue ${row.queuePosition + 1}` : ""}</td>
    </tr>{/each}</tbody>
  </table></div>
{/snippet}

<section aria-label="Training qualifications">
  <h3>Training ships</h3>
  {#if report.stages.length === 0}<p>No training configurations yet.</p>{/if}
  <button class="minor" type="button" disabled={busy || configurations.length >= 3 || !role} onclick={() => edit(null)}>+ Add ship</button>
  <span class="note"> {configurations.length} / 3 configurations for {role}</span>
  {#if editing}
    <div class="editor">
      <label>Ship <select bind:value={hull} disabled={busy} onchange={() => fitting = 0}>
        <option value={0}>Select hull</option>{#each hullChoices(result.fittings) as choice}<option value={choice.typeID}>{choice.name}</option>{/each}
      </select></label>
      <label>Corporation fitting <select bind:value={fitting} disabled={busy || !hull}>
        <option value={0}>Select fitting</option>{#each fittingsForHull(result.fittings, hull) as fit}<option value={fit.fittingID}>{fit.name} · {fit.ownerID}/{fit.fittingID}</option>{/each}
      </select></label>
      {#if role === "MINER"}<label>Miner support package <select bind:value={policy} disabled={busy}>
        <option value="">None · FAST only</option><option value="VENTURE">Basic · policy v1</option><option value="PIONEER">Intermediate · policy v1</option><option value="PROCURER">Advanced · policy v1</option>
      </select></label>{/if}
      <button type="button" disabled={busy || !fitting} onclick={save}>{editing === "new" ? "Add" : "Save"}</button>
      <button class="minor" type="button" disabled={busy} onclick={() => editing = null}>Cancel</button>
      {#if localError}<p role="alert">{localError}</p>{/if}
    </div>
  {/if}
  <p class="note">Highest proven qualification: <strong>{report.currentStage ? qualificationName(report, report.currentStage) : "None proven"}</strong>. Next qualification: {report.nextStage ? qualificationName(report, report.nextStage) : "None"}.</p>
  <p class="note">NEEDS TRAINING means the target level is not yet trained or queued; a lower level may already be trained. Queued levels do not count as trained.</p>
  {#each report.stages as stage, index (stage.id)}
    {@const counts = requirementCounts(stage.hard)}
    {@const support = requirementCounts(stage.support)}
    {@const chosen = selections[stage.id]}
    {@const readiness = equipmentState(stage, now)}
    <div class="contract-head"><strong>{index + 1}. {stage.hullName || stage.id} · {stage.fitName}</strong>
      <span>{stage.skillQualification === "NOT_READY" ? "NEEDS TRAINING" : stage.skillQualification} · fitting {stage.fitting.status}</span>
      <button class="minor" disabled={busy} onclick={() => edit(stage.id)}>Edit</button>
      <button class="minor" disabled={busy} onclick={() => onRemove(stage.id)}>Remove</button>
    </div>
    <p>Skills: <strong>{stage.skillQualification}</strong> · Equipment: <strong>{readiness.equipment}</strong> · Supplies: <strong>{readiness.supplies}</strong> · <strong>{readiness.duty}</strong></p>
    <button class="minor" type="button" disabled={busy || !equipmentSourceReady || stage.fitting.status !== "READY" || stage.skillQualification !== "READY"} onclick={() => onReviewEquipment(stage.id)}>Review Equipment plan · {stage.fitName}</button>
    <details open={stage.fitting.status === "REVIEW_REQUIRED"}>
      <summary>Details</summary>
      <p>Expected hull: {stage.hullName || stage.id} (type {stage.hullTypeID})</p>
      <p class="note">Selected: {stage.fitName}. Identity: {chosen ? `${chosen.ownerID} / ${chosen.fittingID}` : "not configured"}.</p>
      {#if stage.fitting.reason}<p class="note">{stage.fitting.reason}</p>{/if}
      <p class="note">Accepted saved date: {chosen?.acceptedSavedDate ?? "none"}</p>
      <p class="note fingerprint">Accepted fingerprint: {chosen?.acceptedFingerprint ?? "none"}</p>
      {#if stage.fitting.status === "REVIEW_REQUIRED"}
        {@const fit = result.fittings.find((candidate) => candidate.fittingID === chosen?.fittingID)}
        <p class="note">Current saved date: {stage.fitting.currentSavedDate ?? "unknown"}</p>
        <p class="note fingerprint">Current fingerprint: {stage.fitting.currentFingerprint ?? "unknown"}</p>
        {#if fit && !fit.invalid}
          <button type="button" class="minor" disabled={busy} onclick={() => onAccept(stage.id, fit)}>Accept current fitting</button>
          <p class="note">Updates this browser's Training Center configuration only.</p>
        {/if}
      {/if}
      <h4>Hard requirements</h4>
      {#if stage.fitting.status === "READY"}
        <p>{counts.TRAINED} / {stage.hard.length} satisfied · Training {counts.TRAINING} · Queued {counts.QUEUED} · Needs training {counts.MISSING} · Unknown {counts.UNKNOWN}</p>
        {@render skillRows(stage.hard)}
      {:else}<p class="note">UNKNOWN — an accepted, readable qualification fitting is required.</p>{/if}
      <details><summary>Support policy · {support.TRAINED} / {stage.support.length} targets trained</summary>
        {@render skillRows(stage.support)}
      </details>
      <p class="note">Equipment: {readiness.equipment}. {readiness.fresh ? stage.equipmentReason : "Refresh authoritative observations; equipment evidence has expired or is unavailable."}</p>
      {#if stage.equipment}<p class="note">Actual hull: {stage.equipment.hullName || "Unknown"} · Observation {stage.equipment.quality} · Control {stage.equipment.control.state}. Fresh equipment evidence expires after one minute.</p>{/if}
      {#if readiness.fresh && stage.equipment}<ul>{#each stage.equipment.status.targets as target}<li>{target.name}: {target.current ?? "UNKNOWN"} / {target.target} · {target.state}</li>{/each}</ul>{/if}
    </details>
  {/each}
  <h3>{mode} preview → {preview.stage ? qualificationName(report, preview.stage) : "No target qualification"}</h3>
  <p class="note">{mode === "FAST" ? "Target qualification hard requirements only." : mode === "BALANCED" ? "Target qualification hard requirements plus selected role support." : "Target qualification requirements and selected support/mastery targets, including intentional level V goals."}</p>
  <p>ETA: {preview.eta.kind === "READY" ? "Already trained" : preview.eta.kind === "SERVER_QUEUE" ? `${formatDuration(preview.eta.remainingMs)} · authoritative server queue` : `UNKNOWN · ${preview.eta.reason}`}</p>
  {#if preview.targets.length > 0}{@render skillRows(preview.targets)}{/if}
  <p class="note">This preview does not change training or equipment. Queue Apply and manual Provision Equipment are separate actions.</p>
</section>
<style>
  details { margin: .75rem 0; padding: .75rem; border: 1px solid var(--border, #364252); border-radius: 6px; }
  summary { cursor: pointer; font-weight: 600; }
  .editor { border: 1px solid #455569; padding: 1rem; margin: 1rem 0; }
  .contract-head { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; margin-top: 1rem; }
  select { display: block; max-width: 100%; margin: .5rem 0; }
  .fingerprint { overflow-wrap: anywhere; }
</style>
