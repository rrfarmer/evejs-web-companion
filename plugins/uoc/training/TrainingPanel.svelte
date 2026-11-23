<script lang="ts">
  import { onMount } from "svelte";
  import { createTrainingAccountPass } from "./accountPass.ts";
  import ProvisioningPanel from "../provisioning/ProvisioningPanel.svelte";
  import { checkPluginRun, createPilotReach, createPluginRunGrant, loadKnownAccounts, loadKnownCharacters,
    startPluginRun, type Session, type JsonValue, type ServerBot } from "../../../web/src/plugin-api/index.ts";

  let { sessions = [], mode = "training" }: { sessions?: readonly Session[]; mode?: "training" | "provisioning" } = $props();
  type Pilot = { characterID:number; characterName:string; accountName:string };
  type Choice = { corporationID:number; fittingID:number; name:string; goalTypeID:number; fingerprint:string; estimatedCostISK:number|null; issue:string|null };
  type Authority = { characterID:number; name:string; corporationID:number; corporationName:string };
  let pilots = $state<Pilot[]>([]), selected = $state(0), busy = $state(false), message = $state("");
  let extraPilots = $state<Pilot[]>([]), traineeAccount = $state("");
  let inspectID = $state(""), trainingID = $state(""), choices = $state<Choice[]>([]), fittingID = $state(0);
  type ServiceTask={taskID:string;characterID:number;ownerBotID:string;kind:"inspect"|"train";status:string;phase:string;why:string|null;readout:any;endedAt:number|null};
  let serviceTask=$state<ServiceTask|null>(null);
  let corpFunding = $state(false), balance = $state<number|null>(null), bots = $state<readonly ServerBot[]>([]);
  let hrAccount = $state(""), authorities = $state<Authority[]>([]), authorityID = $state(0), hrMessage = $state("");
  let accountNames = $state<string[]>([]);
  const reach = createPilotReach({ pass:createTrainingAccountPass(), held:()=>sessions, known:()=>[...authorities.map(a=>({characterID:a.characterID,characterName:a.name,accountName:hrAccount})),...extraPilots,...loadKnownCharacters()], accounts:()=>[...new Set([
    ...extraPilots.map(p=>p.accountName), ...(hrAccount?[hrAccount]:[]), ...loadKnownAccounts(), ...sessions.map(s=>s.store.get().session.username).filter((name):name is string=>!!name),
  ])] });
  const fit = $derived(choices.find(c=>c.fittingID===fittingID)??null);
  const authority = $derived(authorities.find(a=>a.characterID===authorityID)??null);
  const trainingBot = $derived(serviceTask?.kind==="train"?serviceTask:bots.find(b=>b.botID===trainingID)??null);
  function refreshPilots() {
    const known=[...extraPilots,...loadKnownCharacters().map(c=>({characterID:c.characterID,characterName:c.characterName,accountName:c.accountName}))]
      .filter((p,i,all)=>all.findIndex(other=>other.characterID===p.characterID)===i);
    for(const session of sessions){const state=session.store.get(),p=state.station.online;if(p && !known.some(c=>c.characterID===p.characterID)){
      const accountName=state.session.username;if(accountName)known.push({characterID:p.characterID,characterName:p.characterName,accountName});
    }}
    pilots=known;
    accountNames=[...new Set([...extraPilots.map(p=>p.accountName),...loadKnownAccounts(), ...sessions.map(s=>s.store.get().session.username).filter((name):name is string=>!!name)])];
    if(!pilots.some(p=>p.characterID===selected))selected=0;
  }
  function changed(){inspectID="";trainingID="";choices=[];fittingID=0;balance=null;message="";hrMessage="";serviceTask=null;}
  async function trainingAPI(options: Awaited<ReturnType<typeof reach.accountOptions>>, route:string, body?:unknown){
    if(typeof options.token!=="string" || !options.token)throw Error("The account session is no longer available.");
    const response=await (options.fetch??fetch)(`${options.baseUrl??""}${route}`,{method:body===undefined?"GET":"POST",
      headers:{authorization:`Bearer ${options.token}`,...(body===undefined?{}:{"content-type":"application/json"})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    if(!response.ok||data?.ok===false)throw Error(data?.message||data?.error||"Training request failed.");
    return data;
  }
  async function loadTrainees(){
    const account=traineeAccount.trim();if(busy||!account)return;busy=true;message="";
    try{
      const data=await trainingAPI(await reach.accountOptions(account),"/api/pilot-training/characters");
      if(account!==traineeAccount.trim()||data.account!==account||!Array.isArray(data.characters))throw Error("The trainee account roster changed or is unavailable.");
      const added=data.characters.flatMap((p:any)=>Number.isSafeInteger(p?.characterID)&&p.characterID>0&&typeof p.name==="string"
        ?[{characterID:p.characterID,characterName:p.name,accountName:account}]:[]);
      extraPilots=[...extraPilots.filter(p=>p.accountName!==account),...added];refreshPilots();
      message=added.length?"Choose a pilot from the account.":"This account has no pilots.";
    }catch(error){message=error instanceof Error?error.message:"Could not read the trainee account.";}finally{busy=false;}
  }
  async function loadHR(){
    if(busy||!hrAccount)return;busy=true;hrMessage="";authorities=[];authorityID=0;
    const account=hrAccount;
    try{
      const data=await trainingAPI(await reach.accountOptions(account),"/api/pilot-training/settings-context");
      if(account!==hrAccount||!Array.isArray(data.authorities)||!Array.isArray(data.corporations))throw Error("HR account or authority data changed.");
      authorities=data.authorities.flatMap((a:any)=>{
        const corp=data.corporations.find((c:any)=>c?.corporationID===a?.corporationID);
        return a?.eligible===true&&Number.isSafeInteger(a.characterID)&&a.characterID>0&&Number.isSafeInteger(a.corporationID)&&a.corporationID>0&&typeof a.name==="string"&&typeof corp?.name==="string"
          ?[{characterID:a.characterID,name:a.name,corporationID:a.corporationID,corporationName:corp.name}]:[];
      });
      hrMessage=authorities.length?"Choose the director who will onboard this pilot.":"This account has no eligible non-CEO director.";
    }catch(error){hrMessage=error instanceof Error?error.message:"Could not read HR authority.";}finally{busy=false;}
  }
  async function launchAs(id:number, kind:string, setup:JsonValue){
    const options=await reach.ownerOptions(id), reviewed=await checkPluginRun("uoc",kind,setup,options);
    return startPluginRun(id,"uoc",kind,reviewed.setup,createPluginRunGrant(reviewed.policy),options);
  }
  async function waitOnboarding(botID:string, expected:string){
    const deadline=Date.now()+120000;
    while(Date.now()<deadline){
      const result=await reach.readServerBots();
      if(result.allFailed)throw Error("Cannot read the onboarding run; check its outcome before retrying.");
      bots=result.bots;
      const bot=result.bots.find(b=>b.botID===botID);
      if(bot?.endedAt){
        if(bot.phase!==expected && !(expected==="Membership verified" && bot.phase==="Membership check needed"))throw Error(bot.why??bot.pauseReason??"Onboarding outcome needs review.");
        return;
      }
      await new Promise(resolve=>setTimeout(resolve,1500));
    }
    throw Error("Onboarding did not finish in time; check the run before retrying.");
  }
  async function joinHR(){
    if(busy||!selected||!authority)return;
    const traineeID=selected, officer=authority, account=hrAccount;busy=true;hrMessage="";
    try{
      const setup={traineeID,authorityID:officer.characterID,corporationID:officer.corporationID};
      for(const [actor,kind,stage,expected] of [
        [officer.characterID,"training-hr","invite","Invitation verified"],
        [traineeID,"training-join","join","Membership verified"],
        [officer.characterID,"training-hr","grant","Onboarding verified"],
      ] as const){
        if(selected!==traineeID||hrAccount!==account||authorityID!==officer.characterID)throw Error("The selected onboarding actors changed.");
        hrMessage=`Onboarding: ${stage}-`;
        const bot=await launchAs(actor,kind,{...setup,stage} as JsonValue);
        await waitOnboarding(bot.botID,expected);
      }
      choices=[];fittingID=0;balance=null;
      hrMessage="Corporation membership and access verified.";
      const bot=await launchAs(traineeID,"training-inspect",{});inspectID=bot.botID;
      message="Reading the pilot's corporation and fittings-";await refreshRuns();
    }catch(error){hrMessage=`${error instanceof Error?error.message:"Onboarding outcome is unknown."} Check the run before retrying.`;}
    finally{busy=false;}
  }
  async function launch(kind:string, setup:JsonValue){
    const id=selected;if(!id)throw Error("Choose a pilot.");
    const options=await reach.ownerOptions(id);
    if(kind==="training"||kind==="training-inspect"){
      const current=await trainingAPI(options,`/api/plugins/uoc/training/${id}/service`);
      if(id!==selected)throw Error("The selected pilot changed.");
      if(current.available===true){
        const started=await trainingAPI(options,`/api/plugins/uoc/training/${id}/service`,{kind:kind==="training"?"train":"inspect",setup});
        if(started.task?.characterID!==id||typeof started.task.taskID!=="string"||typeof started.task.ownerBotID!=="string")throw Error("The existing pilot's training task could not be verified.");
        serviceTask=started.task;
        return {botID:`service:${started.task.taskID}`};
      }
    }
    const reviewed=await checkPluginRun("uoc",kind,setup,options);
    if(id!==selected)throw Error("The selected pilot changed.");
    return startPluginRun(id,"uoc",kind,reviewed.setup,createPluginRunGrant(reviewed.policy),options);
  }
  async function inspect(){
    if(busy||!selected)return;busy=true;choices=[];fittingID=0;balance=null;message="";
    try{const bot=await launch("training-inspect",{});inspectID=bot.botID;message="Reading the pilot's corporation and fittings…";await refreshRuns();}
    catch(error){message=error instanceof Error?error.message:"Inspection could not start.";}finally{busy=false;}
  }
  async function train(){
    if(busy||!fit||fit.estimatedCostISK===null||!selected)return;
    const chosen=fit,pilotID=selected;busy=true;message="";
    try{
      const setup={goalTypeID:chosen.goalTypeID,maxSpendISK:chosen.estimatedCostISK,corporationID:chosen.corporationID,
        fittingID:chosen.fittingID,fingerprint:chosen.fingerprint,...(corpFunding?{corporateFunding:true}:{})};
      const bot=await launch("training",setup as JsonValue);
      if(pilotID!==selected)throw Error("The selected pilot changed.");
      trainingID=bot.botID;message="Training started. The queue will be checked before release.";await refreshRuns();
    }catch(error){message=error instanceof Error?error.message:"Training could not start.";}finally{busy=false;}
  }
  async function refreshRuns(){
    try{
      const result=await reach.readServerBots();if(result.allFailed)throw Error("Could not read training runs.");
      bots=result.bots;
      if(selected){
        const current=await trainingAPI(await reach.ownerOptions(selected),`/api/plugins/uoc/training/${selected}/service`);
        if(current.task?.characterID===selected&&typeof current.task.taskID==="string")serviceTask=current.task;
      }
      const inspection=serviceTask?.kind==="inspect"&&`service:${serviceTask.taskID}`===inspectID
        ? {endedAt:serviceTask.endedAt,status:serviceTask.status,phase:serviceTask.phase,why:serviceTask.why,pauseReason:null,plugin:{readout:serviceTask.readout}}
        : bots.find(b=>b.botID===inspectID);
      if(inspection?.endedAt && inspection.phase==="Training inspected" && inspection.plugin?.readout && typeof inspection.plugin.readout==="object" && !Array.isArray(inspection.plugin.readout)){
        const output=inspection.plugin.readout as Record<string,any>;
        if(output.characterID===selected && Array.isArray(output.choices)){
          choices=output.choices.filter((c:any)=>c && Number.isSafeInteger(c.fittingID) && typeof c.fingerprint==="string");
          balance=typeof output.balanceISK==="number"?output.balanceISK:null;
          if(inspection.endedAt && !trainingID)message=choices.length?"Choose a fitting to see its skillbook cost.":"This corporation has no saved fittings.";
        }
      } else if(inspection?.endedAt && inspection.status!=="running")message=inspection.why??inspection.pauseReason??"Inspection failed.";
    }catch(error){message=error instanceof Error?error.message:"Could not read training runs.";}
  }
  onMount(()=>{refreshPilots();void refreshRuns();const timer=setInterval(()=>void refreshRuns(),3000);return()=>{clearInterval(timer);void reach.release();};});
</script>

<section aria-label={mode === "training" ? "Pilot Training" : "Ship Provisioning selection"}>
  <h2>{mode === "training" ? "Pilot Training" : "Ship Provisioning"}</h2>
  <p>{mode === "training" ? "Inspect a pilot's corporation fittings, then queue the skills for one fitting." : "Choose a pilot and inspect corporation fittings to provision a ship."}</p>
  <label>Trainee account <input bind:value={traineeAccount} disabled={busy} placeholder="Account name" /></label>
  <button type="button" onclick={loadTrainees} disabled={busy || !traineeAccount.trim()}>Load pilots</button>
  <label>Pilot
    <select bind:value={selected} onchange={changed} disabled={busy}>
      <option value={0}>Choose a pilot</option>
      {#each pilots as pilot (pilot.characterID)}<option value={pilot.characterID}>{pilot.characterName} · {pilot.accountName}</option>{/each}
    </select>
  </label>
  <button type="button" onclick={refreshPilots} disabled={busy}>Refresh pilots</button>
  {#if mode === "training"}<details>
    <summary>Join a training corporation</summary>
    <p>If the pilot needs to join a different corporation, select its dedicated non-CEO director.</p>
    <label>HR account
      <input list="training-hr-accounts" bind:value={hrAccount} oninput={()=>{authorities=[];authorityID=0;hrMessage="";}} disabled={busy} placeholder="Account name" />
      <datalist id="training-hr-accounts">{#each accountNames as name (name)}<option value={name}></option>{/each}</datalist>
    </label>
    <button type="button" onclick={loadHR} disabled={busy || !hrAccount}>Load directors</button>
    {#if authorities.length}
      <label>Director and corporation
        <select bind:value={authorityID} onchange={()=>{hrMessage="";}} disabled={busy}>
          <option value={0}>Choose a director</option>
          {#each authorities as officer (officer.characterID)}<option value={officer.characterID}>{officer.name} · {officer.corporationName}</option>{/each}
        </select>
      </label>
      <button type="button" onclick={joinHR} disabled={busy || !selected || !authority}>Join and prepare</button>
    {/if}
    {#if hrMessage}<p role="status">{hrMessage}</p>{/if}
  </details>{/if}
  <button type="button" onclick={inspect} disabled={busy || !selected}>Inspect fittings</button>
  {#if choices.length}
    <label>Corporation fitting
      <select bind:value={fittingID} disabled={busy}>
        <option value={0}>Choose a fitting</option>
        {#each choices as choice (choice.fittingID)}<option value={choice.fittingID}>{choice.name}</option>{/each}
      </select>
    </label>
  {/if}
  {#if mode === "training" && fit}
    {#if fit.issue}<p role="alert">{fit.issue}</p>{:else}
      <p>Skillbooks: {fit.estimatedCostISK?.toLocaleString()} ISK. Personal balance: {balance?.toLocaleString() ?? "unavailable"} ISK.</p>
      <label><input type="checkbox" bind:checked={corpFunding} disabled={busy} /> Use the corporation Master Wallet for any shortfall, if this pilot has permission</label>
      <button type="button" onclick={train} disabled={busy || fit.estimatedCostISK===null}>Start training</button>
    {/if}
  {/if}
  {#if mode === "training" && fit}<p><a href="/uoc/ship-provisioning/">Open Ship Provisioning</a></p>{/if}
  {#if mode === "training" && trainingBot}<p>{trainingBot.phase ?? trainingBot.status}: {trainingBot.why ?? trainingBot.pauseReason ?? ""}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>
{#if mode === "provisioning" && selected&&fit}
 {#key `${selected}:${fit.fingerprint}`}
  <ProvisioningPanel characterID={selected} fitting={fit} {bots} launch={launch} refresh={refreshRuns}/>
 {/key}
{/if}
