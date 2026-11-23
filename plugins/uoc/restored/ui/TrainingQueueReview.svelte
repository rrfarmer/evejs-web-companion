<script lang="ts">
  import { qualificationName } from "../training/configurations.ts";
  const romanLevel = (n: number) => ["", "I", "II", "III", "IV", "V"][n] ?? String(n);
  import type { QueueReview, TrainingQueue, MinerTrainingRead } from "../training/types.ts";
  import type { PlanMode, LastQueueApply } from "../training/factory.ts";
  let { result, queue, review, mode, busy, message, lastApply, onReview, onApply }: {
    result: MinerTrainingRead | null; queue: TrainingQueue | null; review: QueueReview | null;
    mode: PlanMode; busy: boolean; message: string; lastApply: LastQueueApply | null;
    onReview: () => void; onApply: () => void;
  } = $props();
  const preview = $derived(result?.report.previews[mode]);
  const fitReady = $derived(result?.report.stages.find((stage) => stage.id === preview?.stage)?.fitting.status === "READY");
  const unknown = $derived(!preview || preview.disabled || preview.targets.some((row) => row.state === "UNKNOWN"));
  function skillName(typeID: number): string {
    return result?.report.stages.flatMap((stage) => [...stage.hard, ...stage.support]).find((row) => row.typeID === typeID)?.name ?? `Skill #${typeID}`;
  }
</script>

<section aria-label="Reviewed queue append">
  <h3>Authoritative skill queue</h3>
  {#if queue}
    <details><summary>{queue.entries.length} / {queue.maxEntries} entries · {queue.active ? "Active" : "Inactive"}</summary>
      <ol>{#each queue.entries as item, index}<li>{index + 1}. {skillName(item.typeID)} {romanLevel(item.toLevel)}</li>{/each}</ol>
    </details>
  {:else}<p>UNKNOWN — queue is unreadable.</p>{/if}
  <p class="note">Append only. Existing queue order is preserved. Nonempty paused queues stay paused; an empty queue starts training. Pilot must be offline. No skillbooks are bought or injected.</p>
  <button type="button" class="minor" disabled={busy || !queue || unknown || !fitReady}
    onclick={onReview}>Review {mode} append → {qualificationName(result?.report, preview?.stage)}</button>
  {#if !fitReady}<p class="note">An accepted, readable target qualification fitting is required.</p>{/if}
  {#if unknown}<p class="note">UNKNOWN requirements block Apply.</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if review}
    <h4>{review.mode} → {qualificationName(result?.report, review.stage)} · {review.status === "NOTHING_TO_ADD" ? "Nothing to add" : review.status}</h4>
    <p>Existing: {review.existing.length} · Already trained: {review.requirements.filter((row) => row.reviewState === "ALREADY_TRAINED").length} · Already queued: {review.requirements.filter((row) => row.reviewState === "ALREADY_QUEUED").length} · Will append: {review.additions.length} · Capacity: {review.maxEntries ?? "UNKNOWN"}</p>
    <p>After Apply: {review.activate ? "training active" : "queue remains paused"}. Review expires at {new Date(review.expiresAt).toLocaleTimeString()}.</p>
    <details><summary>Requirement coverage</summary>
      <ul>{#each review.requirements as row (row.typeID)}<li>{row.name} {romanLevel(row.level)} · {row.reviewState}</li>{/each}</ul>
    </details>
    <h4>Exact additions (in order)</h4>
    <ol>{#each review.additions as item, index}<li>{index + 1}. {item.name ?? skillName(item.typeID)} {romanLevel(item.toLevel)}</li>{/each}</ol>
    {#if review.blockers.length}
      <p>Blocked — the complete plan will not be submitted.</p>
      <ul>{#each review.blockers as blocker}<li>{blocker.code}: {blocker.message}</li>{/each}</ul>
    {:else}<p>Preflight blockers: none. EveJS still validates clone limits, duration and training slots atomically.</p>{/if}
    <button type="button" disabled={busy || !review.canApply || !review.reviewID}
      onclick={onApply}>Apply {review.mode} plan → {qualificationName(result?.report, review.stage)}</button>
  {/if}
  {#if lastApply}
    <p class="note">Last apply: {lastApply.mode} → {qualificationName(result?.report, lastApply.stage)} · {lastApply.status} · {new Date(lastApply.at).toLocaleString()} · Added: {lastApply.added ?? "unverified"} · Verified: {lastApply.verified ? "yes" : "no"}{lastApply.code ? ` · ${lastApply.code}` : ""}</p>
  {/if}
</section>
<style>
  section { margin-top: 1.25rem; border-top: 1px solid var(--color-line); padding-top: 1rem; }
  details, p, button { margin: .65rem 0; }
  ul, ol { padding-left: 1rem; }
</style>
