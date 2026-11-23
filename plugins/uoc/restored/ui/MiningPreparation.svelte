<!-- WC74 web/src/ui/MiningPreparation.svelte @ 213da333; imports adapted for UOC plugin. -->
<script lang="ts">
  import type { MiningOperationMemberDefinition } from "../adapters/mining.ts";
  import { preparationStateLabel, type MiningPreparationProjection } from "../mining/miningPreparation.ts";
  let { preparation, members, planning = false, stale = false }: {
    preparation?: MiningPreparationProjection; members: readonly MiningOperationMemberDefinition[]; planning?: boolean; stale?: boolean;
  } = $props();
  function observed(value?: number | string | null): string {
    if (value == null) return "Unknown";
    const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
  }
</script>

<section class="preparation" aria-label={planning ? "Launch equipment and supplies review" : "Operation equipment and supplies preparation"}>
  <h4>{planning ? "Launch preflight" : preparation?.historical ? "Last recorded preparation" : "Equipment and supplies"}: {preparationStateLabel(preparation?.state)}</h4>
  <p class="muted">{stale ? "Last known server observation. " : ""}{planning ? "Review checks pilot availability and compares selected corporate fittings. Fitting differences and optional supply shortages are warnings." : "Equipment is checked before productive work. Consumable top-up is optional; each module still needs its actual fuel or charges."}</p>
  {#if preparation?.historical}<p class="muted">Retained native preparation evidence for this exact operation, pilot and ship. It does not replace fresh Review or authorize another Start.</p>{/if}
  {#if preparation?.reason}<p class="notice">{preparation.reason}</p>{/if}
  {#if !preparation}<p class="notice">Equipment and supply readiness has not been reported.</p>{/if}
  {#if preparation?.members?.length}
    <ul class="summary">
      {#each members as member (member.characterID)}
        {@const readiness = preparation.members.find(row => row.characterID === member.characterID)}
        <li><strong>{member.characterName}</strong>{#if readiness?.currentHull} · {readiness.currentHull}{/if}{#if readiness?.fittingName} · {readiness.fittingName}{/if}
          · {readiness?.equipment==="AS IS" ? "As is" : planning && readiness?.state==="PENDING" ? "Equipment not checked yet" : readiness?.state==="DEGRADED" ? "Warnings" : preparationStateLabel(readiness?.state)}
          {#if readiness?.reason} · {readiness.reason}{/if}</li>
      {/each}
    </ul>
  {/if}
  <details><summary>Equipment, supplies and source details</summary>
  <div class="table-wrap"><table>
    <thead><tr><th>Pilot / role</th><th>Equipment</th><th>Supplies</th><th>Preparation</th><th>Source / reason</th></tr></thead>
    <tbody>{#each members as member (member.characterID)}
      {@const readiness = preparation?.members?.find(row => row.characterID === member.characterID)}
      <tr>
        <td><strong>{member.characterName}</strong><br />{member.role}</td>
        <td>{readiness?.equipment ?? "UNKNOWN"}{#if readiness?.fittingName}<br /><small>{readiness.fittingName}</small>{/if}</td>
        <td>{readiness?.supplies ?? "UNKNOWN"}
          {#if readiness?.targets?.length}<details><summary>Supply quantities</summary><ul>
            {#each readiness.targets as target}<li>{target.name}: current {target.current ?? "Unknown"} / target {target.target} · deficit {target.deficit ?? "Unknown"} · {target.state}{target.required === true ? " · required" : target.required === false ? " · optional" : ""}</li>{/each}
          </ul></details>{/if}
        </td>
        <td class:blocked={readiness?.state === "BLOCKED" || readiness?.state === "RECOVERY_REQUIRED"}>{preparationStateLabel(readiness?.state)}</td>
        <td>{readiness?.sourceLabel ?? "Source not reported"}{#if readiness?.reason}<p class="notice">{readiness.reason}</p>{/if}{#if readiness}<small>Observed: {observed(readiness.observedAt)}</small>{/if}</td>
      </tr>
    {/each}</tbody>
  </table></div>
  </details>
</section>

<style>
  .preparation { margin: .8rem 0; border: 1px solid #304754; padding: .7rem; min-width: 0; }
  h4, p { margin: .25rem 0 .5rem; }
  .muted, small { color: #93a9b5; }
  .notice { border-left: 3px solid #d4a84d; padding-left: .5rem; }
  .blocked { color: #ff9e9e; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: .4rem; border-bottom: 1px solid #263943; overflow-wrap: anywhere; }
  th { color: #8fb4c7; } ul { padding-left: 1rem; } li { margin-bottom: .3rem; }
</style>
