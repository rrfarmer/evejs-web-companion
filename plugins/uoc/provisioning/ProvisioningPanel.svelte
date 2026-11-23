<script lang="ts">
 import type {JsonValue,ServerBot} from "../../../web/src/plugin-api/index.ts";
 type Fitting={corporationID:number;fittingID:number;goalTypeID:number;fingerprint:string;name:string};
 let {characterID,fitting,bots,launch,refresh}:{characterID:number;fitting:Fitting;bots:readonly ServerBot[];
  launch:(kind:string,setup:JsonValue)=>Promise<ServerBot>;refresh:()=>Promise<void>}=$props();
 let division=$state(1),busy=$state(false),error=$state(""),inspectID=$state(""),applyID=$state("");
 const inspection=$derived(bots.find(b=>b.botID===inspectID));
 const application=$derived(bots.find(b=>b.botID===applyID));
 const verified=$derived(Boolean(application?.endedAt&&application.phase==="Provisioning verified"));
 const output=$derived((inspection?.endedAt&&inspection.phase==="Provisioning inspected"?inspection.plugin?.readout:null) as any);
 const plan=$derived(output?.plan);
 const projected=$derived(output?.resources);
 const measured=$derived((application?.plugin?.readout as any)?.nativeResources??output?.nativeResources);
 const amount=(n:number)=>n.toLocaleString("en-US",{maximumFractionDigits:2});
 const selection=$derived({corporationID:fitting.corporationID,fittingID:fitting.fittingID,goalTypeID:fitting.goalTypeID,fingerprint:fitting.fingerprint,division});
 function items(rows:any[]){const grouped=new Map<number,{name:string;quantity:number}>();
  for(const row of rows??[]){const previous=grouped.get(row.typeID);grouped.set(row.typeID,{name:row.name??"Equipment",quantity:(previous?.quantity??0)+row.quantity});}
  return [...grouped.values()];
 }
 async function inspect(){if(busy)return;busy=true;error="";inspectID="";applyID="";
  try{const run=await launch("provision-inspect",selection as JsonValue);inspectID=run.botID;await refresh();}
  catch(e){error=e instanceof Error?e.message:"Could not inspect the ship and stock.";}finally{busy=false;}}
 async function apply(){if(busy||!output?.canApply||!output.reviewedPlanFingerprint)return;busy=true;error="";
  try{const run=await launch("provision-apply",{...selection,reviewedPlanFingerprint:output.reviewedPlanFingerprint} as JsonValue);applyID=run.botID;await refresh();}
  catch(e){error=e instanceof Error?e.message:"Could not apply the reviewed plan.";}finally{busy=false;}}
</script>

<section aria-label="Ship Provisioning">
 <h2>Ship Provisioning</h2>
 <p>{fitting.name}</p>
 <label>Corporate stock division <select bind:value={division} disabled={busy} onchange={()=>{inspectID="";applyID="";}}>
  {#each [1,2,3,4,5,6,7] as value}<option value={value}>Division {value}</option>{/each}
 </select></label>
 <button type="button" onclick={inspect} disabled={busy}>Inspect ship and stock</button>
 {#if inspection&&!inspection.endedAt}<p role="status">{inspection.phase??"Inspecting ship and stock"}: {inspection.why??""}</p>{/if}
 {#if inspection?.endedAt&&inspection.phase!=="Provisioning inspected"}<p role="alert">{inspection.why??"Ship inspection could not be verified."}</p>{/if}
 {#if plan}
  <p>Required ship: <strong>{plan.targetHullName??"Selected fitting hull"}</strong>.</p>
  {#if verified}<p>The active ship and its fitting are verified.</p>
  {:else if plan.mode==="ALREADY_SATISFIED"}<p>Ready ship · current ship #{output.shipID}.</p>
  {:else if plan.hullSelection}
   <p>{plan.hullSelection.kind==="READY"?"Ready ship":plan.hullSelection.kind==="PARTIAL"?"Complete the existing fit":"Fit an empty assembled ship"} · #{plan.targetHullID}.</p>
  {:else}<p>New assembly from packaged stock. The previous ship stays in the personal hangar.</p>{/if}
  <ul>{#each items(plan.requirements.map((row:any)=>({...row,quantity:row.missing??row.quantity})).filter((row:any)=>row.quantity>0)) as item}<li>{item.name} × {item.quantity}</li>{/each}</ul>
  {#each [...(plan.shortages??[]),...(plan.unsupported??[])] as issue}<p role="alert">{issue}</p>{/each}
  {#if output.skills?.missing?.length}<p role="alert">Required skills are still training or missing.</p>{/if}
  {#if projected?.state==="SIMULATED"}
   <h3>Projected fit · this pilot's skills</h3>
   <table><thead><tr><th>Resource</th><th>Required</th><th>Available</th><th>Spare</th></tr></thead><tbody>
    <tr><td>CPU</td><td>{amount(projected.cpu.used)} tf</td><td>{amount(projected.cpu.total)} tf</td><td>{amount(projected.cpu.total-projected.cpu.used)} tf</td></tr>
    <tr><td>Powergrid</td><td>{amount(projected.powergrid.used)} MW</td><td>{amount(projected.powergrid.total)} MW</td><td>{amount(projected.powergrid.total-projected.powergrid.used)} MW</td></tr>
   </tbody></table>
   {#if !projected.fits}<p role="alert">This fitting exceeds the pilot's CPU or Powergrid. Train suitable fitting skills or choose a lighter fitting.</p>{/if}
   <p>Client simulation with the selected pilot's current skills. Native fitting remains authoritative.</p>
  {:else if projected}<p role="status">CPU/PG prediction unavailable: {projected.reason} Native fitting will still check the actual ship.</p>{/if}
  {#if measured?.state==="NATIVE"}
   <h3>Assembled ship · native readback</h3>
   <p>CPU: {amount(measured.cpu.used)} / {amount(measured.cpu.total)} tf. Powergrid: {amount(measured.powergrid.used)} / {amount(measured.powergrid.total)} MW.</p>
   <p>{measured.allModulesOnline===true?"All required fitted modules are online.":"Some modules are offline or unreadable; current load does not prove the whole fitting is ready."}</p>
  {:else if measured}<p role="status">Actual CPU/PG unverified: {measured.reason}</p>{/if}
  <button type="button" onclick={apply} disabled={busy||verified||plan.mode==="ALREADY_SATISFIED"||!output.canApply||Boolean(application)}>Apply reviewed fitting</button>
  <details><summary>Advanced evidence</summary><pre>{JSON.stringify({characterID,...output},null,2)}</pre></details>
 {/if}
 {#if application}<p role="status">{application.phase??"Preparing ship"}: {application.why??""}</p>{/if}
 {#if error}<p role="alert">{error}</p>{/if}
</section>
