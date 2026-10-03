import test from "node:test";
import assert from "node:assert/strict";
import { combatUtilityFit, utilityEffect, utilityChargeFits, decideCombatUtilities, combatCapSustain,
  type CombatUtilities, type CombatUtility, type UtilityType } from "./combatUtilities.ts";
import { issueCombatUtility, issueUtilityReload } from "./combatUtilityIssue.ts";
import { ownCombatAction, combatOwnership, settleCombat } from "./combatOwnership.ts";
import { decideDroneBoat } from "./droneBoatLadder.ts";
import { decideScriptAction, initialMemory, type MacroMemory, type ScriptAction } from "./scriptDecide.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import type { BoundDogmaAllInfo, DogmaItemInfo } from "../bridge/boundDogma.ts";
import type { FittingSlot, SpaceSnapshot } from "../store/types.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { BotScript } from "../bots/botScript.ts";

const type: UtilityType = { typeID: 526, groupID: 65, categoryID: 7, effects: [6426], attributes: {}, volume: 5, capacity: null };
const capType: UtilityType = { ...type, typeID: 3566, groupID: 76, effects: [48], attributes: {604:87}, capacity: 5 };
const charge: UtilityType = { ...type, typeID: 11285, groupID: 87, categoryID: 8, effects: [], attributes: {128:2,67:200}, volume: 4 };
const module: CombatUtility = { itemID: 11, typeID: 526, family: "web", effectID: 6426, type, charge: null, quantity: 0,
  active: false, targetID: null, rangeM: 10_000, falloffM: 0, capNeed: 5, modeKnown: true, chargeUnits: null };
const cap: CombatUtility = { ...module, typeID:3566, family:"capacitor", effectID:48, type:capType, charge,quantity:1,chargeUnits:1,capNeed:0 };
const world = (modules: readonly CombatUtility[] = [module], extra: Partial<ScriptObservation> = {}): ScriptObservation => ({
  inSpace:true,docked:false,inWarp:false,shieldRatio:1,armorRatio:1,hullRatio:1,health:1,oreHoldFraction:0,holdEmpty:true,
  hostileOnGrid:true,dronesOut:false,combatDroneIDs:[71],myDrones:[],lockedTargetIDs:[1],capacitorRatio:1,
  combatUtilities:{shipID:9001,modules,cargo:[],capacitor:100,capacitorRatio:1},
  snapshot:{inSpace:true,solarSystemID:1,shipID:9001,ship:{itemID:9001,position:{x:0,y:0,z:0},radius:0,geometryAvailable:true,
    activeModuleIDs:modules.filter(row=>row.active).map(row=>row.itemID),weaponBanks:{}},entities:[{itemID:1,typeID:100,
    kind:"ship",isNpc:true,characterID:null,npcEntityType:"pirate",position:{x:5000,y:0,z:0},radius:0,geometryAvailable:true}]} as unknown as SpaceSnapshot,
  ...extra });
function dogma(groupID=65,effectID=6426,active=false): BoundDogmaAllInfo {
  return {activeShipID:9001,ships:[{itemID:9001,attributes:[{attributeID:482,value:100}]},{itemID:11,typeID:526,
    locationID:9001,flagID:19,groupID,attributes:[{attributeID:73,value:5000},{attributeID:54,value:10000},{attributeID:6,value:5}],
    activeEffects:{type:"dict",entries:active?[[effectID,[11,44,9001,1,null,[],effectID,"123",5000,-1]]]:[]}}]} as unknown as BoundDogmaAllInfo;
}
const slots = (loaded: number | null = null): FittingSlot[] => [{family:"mid",index:0,module:{itemID:11,typeID:526,groupID:65,
  online:true,charge:loaded===null?null:{itemID:[9001,19,loaded],typeID:loaded,quantity:1}}}];
const action = {kind:"activate",moduleID:11,typeID:526,targetID:1,utility:true} as const;
const inject = {kind:"activate",moduleID:11,typeID:3566,targetID:0,utility:true,repeat:0,capDemandFloor:.3} as const;
const facts = (m: CombatUtility, capacitor=100,ratio=1): CombatUtilities => ({shipID:9001,modules:[m],cargo:[],capacitor,capacitorRatio:ratio});

test("fit enrolment requires numeric group AND effect, online and positive effective cycle",()=>{
  assert.equal(combatUtilityFit(9001,slots(),dogma(),{526:type},[],1)?.modules.length,1);
  for(const bad of [{...type,groupID:999},{...type,effects:[]},{...type,categoryID:9}])
    assert.equal(combatUtilityFit(9001,slots(),dogma(),{526:bad},[],1)?.modules.length,0);
  const original=dogma();const passive={...original,ships:original.ships.map((row,index)=>index===1?{...row,attributes:[]}:row)};
  assert.equal(combatUtilityFit(9001,slots(),passive,{526:type},[],1)?.modules.length,0);
  assert.equal(combatUtilityFit(9002,slots(),dogma(),{526:type},[],1),null);
});
test("exact activeEffects decoder retains target binding and rejects malformed/foreign identity",()=>{
  const entry=dogma(65,6426,true).ships[1]!;
  assert.deepEqual(utilityEffect(entry,6426,9001),{active:true,targetID:1});
  assert.equal(utilityEffect(entry,6426,9002),null);
  assert.deepEqual(utilityEffect(entry,6425,9001),{active:false,targetID:null});
  assert.equal(utilityEffect({...entry,activeEffects:null},6426,9001),null);
  const invalid: NonNullable<DogmaItemInfo["activeEffects"]>[] = [{},{type:"dict",entries:[[]]},
    {type:"dict",entries:[[6426,null],[6426,null]]}];
  for (const bad of invalid)
    assert.equal(utilityEffect({...entry,activeEffects:bad},6426,9001),null);
});
test("unknown loaded scripts fail closed; understood sensor/tracking/omni script modes enroll",()=>{
  for(const [group,effect,family,script] of [[212,2670,"sensor",29009],[213,4559,"tracking",29001],[646,6557,"omni",28999]] as const){
    const mt={...type,groupID:group,effects:[effect],attributes:{604:family==="sensor"?910:907,128:1},capacity:1};
    const st={...charge,typeID:script,groupID:family==="sensor"?910:907,attributes:{128:1},volume:1};
    const sl=slots(script).map(s=>({...s,module:{...s.module!,groupID:group}}));
    assert.equal(combatUtilityFit(9001,sl,dogma(group,effect),{526:mt,[script]:st},[],1)?.modules[0]?.modeKnown,true);
    assert.equal(combatUtilityFit(9001,sl,dogma(group,effect),{526:mt,[script]:{...st,typeID:999}},[],1)?.modules[0]?.modeKnown,false);
    assert.equal(combatUtilityFit(9001,slots().map(s=>({...s,module:{...s.module!,groupID:group}})),dogma(group,effect),{526:mt},[],1)?.modules[0]?.modeKnown,true);
  }
});
test("web selects exact locked NPC primary within optimal; no motion orders",()=>{
  assert.deepEqual(decideCombatUtilities(world(),{},1).action,action);
  assert.equal(decideCombatUtilities(world(),{},null).action,null);
  assert.equal(decideCombatUtilities(world([module],{lockedTargetIDs:[]}),{},1).action,null);
});
test("player and unknown geometry never authorize a targeted utility",()=>{
  for(const over of [{isNpc:false,characterID:14},{isNpc:true,characterID:14},{geometryAvailable:false}]){
    const base=world();const obs={...base,snapshot:{...base.snapshot!,entities:[{...base.snapshot!.entities[0]!,...over}]}};
    assert.equal(decideCombatUtilities(obs,{},1).action,null);
  }
});
test("targeted utility has conservative proven range; falloff never invents certain application",()=>{
  assert.equal(decideCombatUtilities(world([{...module,rangeM:4000,falloffM:100000}]),{},1).action,null);
  assert.equal(decideCombatUtilities(world([{...module,rangeM:null}]),{},1).action,null);
});
test("painter requires real drone or loaded supported weapon damage path",()=>{
  const painter={...module,family:"painter" as const,effectID:6425};
  assert.equal(decideCombatUtilities(world([painter]),{},1).action?.kind,"activate");
  assert.equal(decideCombatUtilities(world([painter],{combatDroneIDs:[]}),{},1).action,null);
});
test("preexisting active utilities neither reactivated nor claimed nor stopped",()=>{
  const obs=world([{...module,active:true,targetID:99}]);
  assert.equal(decideCombatUtilities(obs,{},1).action,null);
  assert.deepEqual(ownCombatAction(combatOwnership({},obs),action,obs).modules,{});
  assert.equal(settleCombat(obs,{}).outcome.kind,"done");
});
test("owned targeted utility retires on primary change/death/range loss before reassign",()=>{
  const memory={combatOwned:{...combatOwnership({},world()),modules:{11:{typeID:526}}}};
  const obs=world([{...module,active:true,targetID:2}]);
  const stop=decideCombatUtilities(obs,memory,1);
  assert.deepEqual(stop.action,{kind:"deactivate",moduleID:11,typeID:526,settlement:true});
  assert.equal(decideCombatUtilities(obs,stop.memory,1).action?.kind,"wait");
  assert.equal(decideCombatUtilities(world(),stop.memory,1).action?.kind,"activate");
  assert.equal(decideCombatUtilities(obs,memory,null).action?.kind,"deactivate");
});
test("utility OFF reconciliation is bounded without repeated deactivation",()=>{
  let memory:MacroMemory={combatOwned:{...combatOwnership({},world()),modules:{11:{typeID:526}}}};
  const obs=world([{...module,active:true,targetID:2}]);
  memory=decideCombatUtilities(obs,memory,1).memory;
  // A clear grid, timeout or public Stop must inherit the same pending intent,
  // rather than replaying an unconfirmed retarget shutdown through settlement.
  assert.equal(settleCombat(obs,memory).action.kind,"wait");
  for(let i=0;i<31;i++){const result=decideCombatUtilities(obs,memory,1);assert.equal(result.action?.kind,"wait");memory=result.memory;}
  assert.ok(decideCombatUtilities(obs,memory,1).blocked);
});
test("sensor needs combat, tracking needs turret, omni needs combat drones; unknown mode is off",()=>{
  const sensor={...module,family:"sensor" as const};
  assert.equal(decideCombatUtilities(world([sensor]),{},1).action?.kind,"activate");
  assert.equal(decideCombatUtilities(world([sensor]),{},null).action,null);
  const tracking={...sensor,family:"tracking" as const};
  assert.equal(decideCombatUtilities(world([tracking]),{},1).action,null);
  const weapons={shipID:9001,cargo:[],weapons:[{itemID:22,typeID:561,tracking:1,reachM:10000,chargeTypeID:222,chargeQuantity:1,acceptedGroups:[83],chargeSize:1}]};
  assert.equal(decideCombatUtilities(world([tracking],{combatWeapons:weapons}),{},1).action?.kind,"activate");
  assert.equal(decideCombatUtilities(world([{...sensor,family:"omni"}],{combatDroneIDs:[]}),{},1).action,null);
  assert.equal(decideCombatUtilities(world([{...sensor,modeKnown:false}]),{},1).action,null);
});
test("ordinary cap booster enforces declared group/numeric size AND known physical size",()=>{
  assert.equal(utilityChargeFits(capType,charge),true);
  for(const bad of [{...charge,groupID:83},{...charge,volume:6},{...charge,volume:null}]) assert.equal(utilityChargeFits(capType,bad),false);
  assert.equal(utilityChargeFits({...capType,attributes:{604:87,128:1}},charge),false);
  assert.equal(utilityChargeFits({...capType,capacity:null},charge),false);
});
test("no-demand/no-known-cap/sufficient-cap never inject",()=>{
  assert.equal(decideCombatUtilities(world([cap]),{},1).action,null);
  assert.equal(combatCapSustain(world([cap]),{},.3).action,null);
  assert.equal(combatCapSustain(world([cap],{combatUtilities:{...facts(cap),capacitor:null}}),{},.3).action,null);
});
test("real existing cap floor produces a single-cycle exact injection with bounded count",()=>{
  const obs=world([cap],{capacitorRatio:.1,combatUtilities:facts(cap,10,.1)});
  let memory:MacroMemory={};
  for(let i=0;i<3;i++){const result=combatCapSustain(obs,memory,.3);assert.deepEqual(result.action,inject);memory=result.memory;}
  assert.equal(combatCapSustain(obs,memory,.3).action,null);
  assert.equal(combatCapSustain({...obs,combatUtilities:facts({...cap,active:true},10,.1)}, {},.3).action,null);
});
test("dry cap booster chooses only compatible cargo; unavailable/incompatible never spam",()=>{
  const dry={...cap,charge:null,quantity:0};
  const obs=world([dry],{combatUtilities:{...facts(dry,10,.1),cargo:[{itemID:22,quantity:5,type:charge}]}});
  assert.deepEqual(combatCapSustain(obs,{},.3).action,{kind:"loadCombatAmmo",moduleID:11,chargeItemID:22,chargeTypeID:11285,utility:true});
  for(const cargo of [[],null,[{itemID:22,quantity:5,type:{...charge,volume:100}}]])
    assert.equal(combatCapSustain({...obs,combatUtilities:{...obs.combatUtilities!,cargo}}, {},.3).action,null);
});
test("hull escape and repair OFF maintenance outrank utilities/cap sustain",()=>{
  const doc:BotScript={format:"evejs-bot-script",version:1,name:"utilities",notes:"",home:{entity:"station",id:9,name:"home",systemName:"test"},
    interrupts:[{id:"rep",when:{kind:"armor-below",fraction:.3},respond:"repair"},{id:"acute",when:{kind:"hull-below",fraction:.3},respond:"dock-and-pause"}],
    program:[{id:"fight",kind:"macro",macro:"fight-with-drones",args:{}}]};
  const home=()=>({action:{kind:"warp",targetID:9} as ScriptAction,why:"home",phase:"home",armed:true,outcome:{kind:"acting" as const},nextMem:{}});
  const obs=world([cap],{hullRatio:.1,armorRatio:.1,health:.1,armorRepairerIDs:[55],capacitorRatio:.1,combatUtilities:facts(cap,10,.1)});
  assert.equal(decideScriptAction(doc,obs,initialMemory(doc),SCRIPT_MACROS,home).memory.latched?.interruptID,"acute");
  const base=world([module],{armorRepairerIDs:[55]});const recovered={...base,snapshot:{...base.snapshot!,ship:{...base.snapshot!.ship!,activeModuleIDs:[55]}}};
  assert.deepEqual(decideScriptAction(doc,recovered,initialMemory(doc),SCRIPT_MACROS,home).action,{kind:"deactivate",moduleID:55});
});
test("mobile core uses utilities beneath established primary/drone handling and above idle guns",()=>{
  const obs=world([module],{maxTargetRangeM:40000,droneControlRangeM:45000,weaponModuleIDs:[22],
    combatWeapons:{shipID:9001,cargo:[],weapons:[{itemID:22,typeID:561,tracking:1,reachM:10000,
      chargeTypeID:222,chargeQuantity:1,acceptedGroups:[83],chargeSize:1}]}});
  const result=decideDroneBoat({obs,mem:{holdM:5000,anchorID:1,targetID:1,dronesOn:1},board:{},targets:[],holdRangeM:5000,propMode:"off",squad:"off"});
  assert.deepEqual(result.action,action);
  assert.equal((result.nextMem.combatOwned as {modules:Record<number,unknown>}).modules[11]!==undefined,true);
});
test("exact targeted effect confirms; another target or module never proves application",async()=>{
  let reads=0,calls=0;
  await issueCombatUtility(action,{current:()=>true,targetValid:async()=>true,
    read:async()=>facts(++reads===1?module:{...module,active:true,targetID:1}),activate:async()=>{calls++;return{itemID:11,active:true};}});
  assert.equal(calls,1);
  for(const wrong of [{...module,active:true,targetID:2},{...module,itemID:99,active:true,targetID:1}]){
    reads=0;await assert.rejects(issueCombatUtility(action,{current:()=>true,targetValid:async()=>true,
      read:async()=>facts(++reads===1?module:wrong),activate:async()=>({itemID:11,active:true})}),{code:"MODULE_ACTION_UNCERTAIN"});
  }
});
test("definite refusal is retryable; uncertain utility dispatch is not replayed",async()=>{
  let calls=0;
  const deps={current:()=>true,targetValid:async()=>true,read:async()=>facts(module),activate:async()=>{calls++;return{itemID:11,active:false};}};
  await assert.rejects(issueCombatUtility(action,deps),{code:"CALL_REFUSED"});
  await assert.rejects(issueCombatUtility(action,deps),{code:"CALL_REFUSED"});assert.equal(calls,2);
  await assert.rejects(issueCombatUtility(action,{...deps,activate:async()=>{calls++;return{itemID:11,active:null};}}),{code:"MODULE_ACTION_UNCERTAIN"});
  assert.equal(calls,3);
});
test("dispatch rechecks NPC validity and run generation after awaited reads",async()=>{
  let current=true,calls=0;
  await assert.rejects(issueCombatUtility(action,{current:()=>current,read:async()=>facts(module),
    targetValid:async()=>{current=false;return true;},activate:async()=>{calls++;return{itemID:11,active:true};}}),{code:"CALL_REFUSED"});
  assert.equal(calls,0);
  current=true;let reads=0;
  await assert.rejects(issueCombatUtility(action,{current:()=>current,targetValid:async()=>true,
    read:async()=>{if(++reads>1)current=false;return facts(module);},activate:async()=>{calls++;return{itemID:11,active:true};}}),{code:"MODULE_ACTION_UNCERTAIN"});
  assert.equal(calls,1);
});
test("cap application requires exact consumed charge AND capacitor increase; never ACK only",async()=>{
  let reads=0,calls=0;
  await issueCombatUtility(inject,{current:()=>true,read:async()=>++reads===1?facts(cap,10,.1):facts({...cap,charge:null,quantity:0,active:true},210,.8),
    activate:async()=>{calls++;return{itemID:11,active:true};}});assert.equal(calls,1);
  for(const after of [facts(cap,210,.8),facts({...cap,quantity:0},10,.1)]){
    reads=0;await assert.rejects(issueCombatUtility(inject,{current:()=>true,read:async()=>++reads===1?facts(cap,10,.1):after,
      activate:async()=>{calls++;return{itemID:11,active:true};}}),{code:"MODULE_ACTION_UNCERTAIN"});
  }
  assert.equal(calls,3);
});
test("fresh sufficient cap or repeat cycle request refuses without spending charge",async()=>{
  let calls=0;
  for(const a of [inject,{...inject,repeat:undefined}])await assert.rejects(issueCombatUtility(a,{current:()=>true,read:async()=>facts(cap),
    activate:async()=>{calls++;return{itemID:11,active:true};}}),{code:"CALL_REFUSED"});assert.equal(calls,0);
});
test("utility reload verifies exact compatible charge and has no ambiguous replay",async()=>{
  const a={kind:"loadCombatAmmo",moduleID:11,chargeItemID:22,chargeTypeID:11285,utility:true} as const;
  const dry={...facts({...cap,charge:null,quantity:0},10,.1),cargo:[{itemID:22,quantity:2,type:charge}]};
  let reads=0,calls=0;
  await issueUtilityReload(a,{current:()=>true,read:async()=>++reads===1?dry:facts(cap,10,.1),load:async()=>{calls++;}});
  assert.equal(calls,1);
  await assert.rejects(issueUtilityReload(a,{current:()=>true,read:async()=>dry,load:async()=>{calls++;}}),{code:"MODULE_ACTION_UNCERTAIN"});
  assert.equal(calls,2);
});
test("settlement stops only utility modules owned by invocation, waits for deferred stop",()=>{
  const obs=world([{...module,active:true,targetID:1},{...module,itemID:99,active:true,targetID:2}]);
  const memory={combatOwned:{...combatOwnership({},obs),modules:{11:{typeID:526}}}};
  const first=settleCombat(obs,memory);assert.deepEqual(first.action,{kind:"deactivate",moduleID:11,typeID:526,settlement:true});
  assert.equal(settleCombat(obs,first.nextMem).action.kind,"wait");
  const off=world([{...module,active:false},{...module,itemID:99,active:true}]);
  assert.equal(settleCombat(off,first.nextMem).outcome.kind,"done");
});
