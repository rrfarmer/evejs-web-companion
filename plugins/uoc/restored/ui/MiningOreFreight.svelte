<!-- WC74 web/src/ui/MiningOreFreight.svelte @ 213da333; imports adapted for UOC plugin. -->
<script lang="ts">
  import type {MiningOperationRuntime} from '../adapters/mining.ts';
  import type {OreLogisticsConfig,OreLogisticsWork} from '../mining/contracts.ts';
  let {config,runtime,stale=false}:{config:OreLogisticsConfig|undefined;runtime:MiningOperationRuntime;stale?:boolean}=$props();
  const fresh=(work:OreLogisticsWork|null|undefined)=>!stale&&!runtime.recoveryRequired&&!['UNKNOWN','WAITING_FOR_HOST','DRAFT','STOPPED','STOPPING','PARKING','PARKING_FAILED'].includes(runtime.state)&&work&&
    Date.parse(runtime.observedAt??'')>=work.observedAtMs&&Date.parse(runtime.observedAt??'')-work.observedAtMs<60000;
  const number=(n:number|null|undefined)=>n==null?'unknown':n.toLocaleString(undefined,{maximumFractionDigits:3});
</script>
{#if config}
  <section aria-label="Ore logistics">
    <p><strong>Remote Fleet Compression:</strong> {config.remoteCompression?'Enabled':'Disabled'} · Raw ore jettison: 90% · Compressed ore jettison: {number(config.compressedJettisonFraction*100)}% of effective hold capacity.</p>
    <p>Raw and compressed ore use separate containers. Hauler load limits and the bounded collection window are independent of miner thresholds.</p>
    {#each runtime.members.filter(m=>m.role==='MINER'||m.role==='HAULER'||m.role==='COMMAND'&&m.oreLogisticsWork) as member}
      {@const work=member.oreLogisticsWork}
      <div class="freight-member"><strong>{member.characterName} · {member.role==='HAULER'?'Freight hold':'Mining hold'}:</strong>
        {#if fresh(work)}
          Raw {number(work?.rawUnits)} units / {number(work?.rawM3)} m³ · Compressed {number(work?.compressedUnits)} units / {number(work?.compressedM3)} m³ · Capacity {number(work?.capacityM3)} m³.
          {#if work?.pending===null}Inventory mutation state unknown.{:else if work?.pending}<strong>Inventory mutation pending — no replay.</strong>{:else if work?.fault}<strong>{work.fault}</strong>
          {:else if work?.jettisonRetryAfterMs && work.jettisonRetryAfterMs>Date.parse(runtime.observedAt??'')} Waiting for the next native jettison admission check.{/if}
          {#if (work?.holds?.length??0)>1}<details><summary>Individual hold volumes</summary>{#each work!.holds! as hold}<p>Bay {hold.flagID}: raw {number(hold.rawM3)} m³ · compressed {number(hold.compressedM3)} m³ · capacity {number(hold.capacityM3)} m³. Each threshold uses its own eligible hold.</p>{/each}</details>{/if}
          {#if member.role==='MINER'&&config.remoteCompression}
            {#if work?.facility} Assigned COMMAND facility qualified on this grid · range {number(Math.min(...work.facility.typeListRanges.map(p=>p.rangeMeters)))} m.
            {:else if work?.facilityObservation} Last native compression facility observation: range {number(work.facilityObservation.rangeMeters)} m, distance {number(work.facilityObservation.surfaceDistanceMeters)} m, {new Date(work.facilityObservation.observedAt).toLocaleTimeString()}. Current facility readiness is not inferred from that receipt.
            {:else} Assigned COMMAND facility currently unqualified; ordinary raw handling remains available.{/if}
          {/if}
        {:else}Current inventory/facility state unknown or run ended. No current readiness is inferred from retained observations.
          {#if work}<details><summary>Last native hold observation · {new Date(work.observedAtMs).toLocaleString()}</summary><p>Raw {number(work.rawUnits)} units / {number(work.rawM3)} m³ · Compressed {number(work.compressedUnits)} units / {number(work.compressedM3)} m³ · Capacity {number(work.capacityM3)} m³. {work.pending?'Unresolved inventory mutation was retained.':'Mutation state must be checked by the original owner.'}</p></details>{/if}
        {/if}
      </div>
    {/each}
  </section>
{/if}
<style>
  section { border: 1px solid var(--center-border); padding: .65rem .8rem; margin: .6rem 0; }
  p, .freight-member { margin: .35rem 0; }
</style>
