<script lang="ts">
  import type { MiningOperationMemberDefinition } from "../app/api.ts";
  import { preparationStateLabel, type MiningPreparationProjection } from "../app/miningPreparation.ts";
  let { preparation, members, planning = false, stale = false }: {
    preparation?: MiningPreparationProjection; members: readonly MiningOperationMemberDefinition[]; planning?: boolean; stale?: boolean;
  } = $props();
  function observed(value?: number | string | null): string {
    if (value == null) return "Unknown";
    const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
  }
</script>

<section class="preparation" aria-label={planning ? "Launch equipment and supplies review" : "Operation equipment and supplies preparation"}>
  <h4>{planning ? "Launch preflight" : "Preparation barrier"}: {preparationStateLabel(preparation?.state)}</h4>
  <p class="muted">{stale ? "Last known server observation. " : ""}{planning ? "Read-only member review; Start revalidates before hosted preparation." : "Productive work waits for the server preparation barrier. Hosting alone does not establish readiness."}</p>
  {#if preparation?.reason}<p class="notice">{preparation.reason}</p>{/if}
  {#if !preparation}<p class="notice">Equipment and supply readiness has not been reported.</p>{/if}
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
