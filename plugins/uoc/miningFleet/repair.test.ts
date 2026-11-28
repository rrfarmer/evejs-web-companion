import test from "node:test";
import assert from "node:assert/strict";
import {decodeSpaceSnapshot} from "../../../web/src/plugin-api/flying.ts";
import {createBeltRepair} from "./repair.ts";
import {createMiningDefender} from "./defender.ts";

const pos=(x:number)=>({x,y:0,z:0});
const dict=(entries:unknown[])=>({type:"dict",entries});
const keyval=(entries:unknown[])=>({type:"object",name:"util.KeyVal",args:dict(entries)});
const point=(characterID:number,shipID:number,patch:Record<string,unknown>={})=>({
 itemID:shipID,characterID,ownerID:characterID,kind:"ship",categoryID:6,name:"Pilot "+characterID,
 position:pos(1000),radius:10,shieldRatio:1,armorRatio:1,hullRatio:1,...patch,
});
const belt={itemID:77,kind:"asteroidBelt",groupID:9,name:"Belt",position:pos(0),radius:10};
const npc={...point(999,90),categoryID:11,isNpc:true,npcEntityType:"npc"};
const members=[{characterID:2,shipID:12,role:"MINER"},{characterID:3,shipID:13,role:"HAULER"},
 {characterID:4,shipID:14,role:"DEFENDER"},{characterID:5,shipID:15,role:"MINER"}];

function fixture(kinds:("shield"|"armor"|"hull")[]=["shield"]){
 const calls:{method:string;args:unknown[]}[]=[];
 const active=new Map<number,number>(),locked=new Set<number>(),ineligible=new Set<number>();
 const peers=new Map<number,ReturnType<typeof point>>([[12,point(2,12)],[13,point(3,13)],[14,point(4,14)],[15,point(5,15)]]);
 let cap=100,sampled=0,tick=0;
 const fitModules=kinds.map((kind,index)=>({kind,itemID:50+index,typeID:150+index,flagID:27+index,ownerID:1,
  locationID:11,categoryID:7,quantity:1,online:true,charge:null}));
 const data=()=>({inSpace:true,stateValid:true,shipID:11,solarSystemID:300,sampledAtMs:++sampled,
  ship:{itemID:11,characterID:1,position:pos(0),radius:10,mode:"STOP",shieldRatio:1,armorRatio:1,hullRatio:1},
  entities:[belt,...peers.values()]});
 const scene=async()=>decodeSpaceSnapshot(data());
 const controls={
  refuse:(_method:string,_args:unknown[])=>{},
  delayedEffect:false,
  cap(value:number){cap=value;},
  clock(ms:number){tick=ms;},
 };
 async function call(method:string,args:unknown[],of?:number):Promise<any>{
  if(method==="ItemGetInfo"){
   const itemID=Number(args[0]),stamp={type:"long",value:String(134385165369120001n+BigInt(tick)*10000n)};
   if(itemID===11)return keyval([["itemID",11],["invItem",{type:"packedrow",fields:{ownerID:1}}],
    ["attributes",dict([[18,cap]])]]);
   const module=fitModules.find(m=>m.itemID===itemID)!;
   const effect=(effectID:number,targetID:number|null)=>[itemID,1,11,targetID,null,[],effectID,stamp,1000,0];
   return keyval([["itemID",itemID],["invItem",{type:"packedrow",fields:module}],
    ["time",stamp],["wallclockTime",stamp],["attributes",dict([[54,5000],[6,10],[73,1000]])],
    ["activeEffects",dict([[16,effect(16,null)],...(active.has(itemID)?[[100,effect(100,active.get(itemID)!)]]:[])])]]);
  }
  if(method==="List")return {type:"list",items:of===11?fitModules.filter(m=>m.flagID===args[0]):[]};
  if(method==="InvalidateLocationCache")return null;
  calls.push({method,args});controls.refuse(method,args);
  if(method==="Activate"&&!controls.delayedEffect)active.set(Number(args[0]),Number(args[2]));
  if(method==="Deactivate")active.delete(Number(args[0]));
  if(method==="RemoveTarget")locked.delete(Number(args[0]));
  return method==="AddTarget"?[true,[]]:null;
 }
 const run:any={botID:"repair",characterID:1,held:{characterID:1},baseUrl:"http://fixture",fetch:async(input:unknown,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  if(path==="/api/bridge/space/snapshot")return Response.json({ok:true,space:data()});
  if(path==="/api/bridge/flight/status")return Response.json({ok:true,flight:{inSpace:true,docked:false,shipID:11,solarSystemID:300,
   shipMode:"STOP",transition:{phase:"ready",sessionStable:true,locationReady:true,sceneReady:true,egoReady:true,shipReady:true,boundContextReady:true}}});
  if(path==="/api/bridge/targets")return Response.json({ok:true,targetIDs:[...locked]});
  if(path==="/api/bridge/drones")return Response.json({ok:true,activeShipID:11,bay:[],inSpace:[],errors:{bay:null,inSpace:null,shipInfo:null}});
  if(path==="/api/bridge/call"){const q=JSON.parse(String(init?.body));return Response.json({ok:true,result:await call(q.method,q.args,q.of)});}
  throw Error(path);
 }};
 const session:any={store:{station:{get:()=>({online:{characterID:1}})},
  fitting:{get:()=>({activeShipID:11,slotsError:null,slots:fitModules.map((module,index)=>({family:"high",index,module})),chargeFits:{}})}},
  flow:{requestOptions:()=>({}),stopShip:async()=>{await call("Stop",[]);},
   flying:{sessionGeneration:()=>1,isSessionClosing:()=>false,readFit:async()=>true,
    resolveDefenseModuleIDs:()=>({weapons:[],shield:[],armor:[],hull:[],hardeners:[]}),
    resolveRemoteRepModuleIDs:()=>Object.fromEntries(["shield","armor","hull","cap"].map(kind=>[kind,fitModules.filter(m=>m.kind===kind).map(m=>m.itemID)])),
    fittedModuleActivation:()=>"activatable",classifyDroneRoles:async()=>({bay:{combat:[]},out:{combat:[]}}),
    bridgeDo:(_service:string,method:string,args:unknown[])=>call(method,args),
    bridgeAsk:(_service:string,method:string,args:unknown[])=>call(method,args),
    approachShip:async(...args:unknown[])=>call("Approach",args),
   }}};
 const guard=()=>{};
 const eligible=(member:{characterID:number})=>!ineligible.has(member.characterID);
 const repair=createBeltRepair({run,session,shipID:11,members,eligible,guard,scene,fence:async()=>guard(),
  canApproach:(_s,peer)=>peer.position.x<=20000});
 const nativeCalls=(method:string)=>calls.filter(c=>c.method===method).map(c=>c.args);
 return {run,session,repair,scene,eligible,controls,active,locked,peers,ineligible,nativeCalls,tick:async()=>repair.tick(await scene())};
}

test("an undamaged fleet does not delay the Defender with repair fitting or module reads",async()=>{
 const x=fixture();
 x.session.flow.flying.readFit=async()=>assert.fail("No repair recipient needs the fitting.");
 x.session.flow.flying.bridgeAsk=async()=>assert.fail("No repair module needs inspection.");
 assert.equal(await x.tick(),null);
});

test("friendly native lock and compatible one-cycle repair prioritize a critical miner and then reassign",async()=>{
 const x=fixture();
 x.peers.set(12,point(2,12,{shieldRatio:.2,armorRatio:.4}));
 x.peers.set(13,point(3,13,{shieldRatio:.6}));
 x.peers.set(14,point(4,14,{shieldRatio:.02,armorRatio:.4}));
 x.peers.set(15,point(5,15,{shieldRatio:.01,ownerID:99}));
 x.peers.set(90,{...npc,shieldRatio:.01});
 assert.match((await x.tick())!.waiting!,/pilot 2/);
 await x.tick();
 assert.deepEqual(x.nativeCalls("AddTarget"),[[12]]);
 assert.deepEqual(x.nativeCalls("Activate"),[]);
 x.locked.add(12);
 assert.match((await x.tick())!.active!,/Pilot 2/);
 assert.deepEqual(x.nativeCalls("Activate"),[[50,"",12,0]]);
 x.active.clear();
 x.peers.set(12,point(2,12));
 x.peers.set(13,point(3,13,{shieldRatio:.3,hullRatio:.6}));
 x.locked.add(13);
 await x.tick();
 assert.deepEqual(x.nativeCalls("Activate"),[[50,"",12,0],[50,"",13,0]]);
 assert.deepEqual(x.nativeCalls("RemoveTarget"),[[12]]);
 x.active.clear();x.peers.set(13,point(3,13));x.peers.set(14,point(4,14,{armorRatio:.3}));
 const idle=await x.tick();
 assert.equal(idle?.active,null);
 assert.equal(x.nativeCalls("Activate").length,2,"shield module never repairs armor damage");
});

test("range approach stays inside the belt and holds activation until the peer is actually in range",async()=>{
 const x=fixture(["armor"]);
 x.peers.set(12,point(2,12,{armorRatio:.3,position:pos(22000)}));
 assert.match((await x.tick())!.warning!,/permitted approach area/);
 assert.deepEqual(x.nativeCalls("Approach"),[]);
 x.peers.set(12,point(2,12,{armorRatio:.3,position:pos(9000)}));
 assert.match((await x.tick())!.waiting!,/Closing repair range/);
 await x.tick();
 assert.deepEqual(x.nativeCalls("Approach"),[[12,3750]]);
 assert.deepEqual(x.nativeCalls("Activate"),[]);
 x.peers.set(12,point(2,12,{armorRatio:.3}));
 x.locked.add(12);
 await x.tick();
 assert.deepEqual(x.nativeCalls("Activate"),[[50,"",12,0]]);
});

test("capacitor and charge refusals stay local, and active-effect readback settles a raced activation",async()=>{
 const x=fixture(["shield","hull"]);
 x.peers.set(12,point(2,12,{shieldRatio:.3,hullRatio:.4}));
 x.locked.add(12);
 x.controls.cap(5);
 assert.match((await x.tick())!.warning!,/Insufficient capacitor/);
 assert.deepEqual(x.nativeCalls("Activate"),[]);
 x.controls.cap(100);
 x.controls.refuse=(method,args)=>{
  if(method!=="Activate")return;
  if(args[0]===50)throw Object.assign(Error("NoCharges"),{code:"CALL_REFUSED",status:409});
  x.active.set(51,12);
  throw Object.assign(Error("EffectAlreadyActive2"),{code:"CALL_REFUSED",status:409});
 };
 assert.match((await x.tick())!.active!,/remote hull repair/);
 await x.tick();
 assert.deepEqual(x.nativeCalls("Activate"),[[50,"",12,0],[51,"",12,0]]);
});

test("an acknowledged but not yet visible repair cannot dispatch twice in the same native cycle",async()=>{
 const x=fixture();
 x.peers.set(12,point(2,12,{shieldRatio:.3}));
 x.locked.add(12);
 x.controls.delayedEffect=true;
 await x.tick();
 await x.tick();
 assert.equal(x.nativeCalls("Activate").length,1);
 x.controls.clock(1200);
 await x.tick();
 assert.equal(x.nativeCalls("Activate").length,2);
});

test("a lost friendly lock waits for native loss and reacquisition before another activation",async()=>{
 const x=fixture();
 x.peers.set(12,point(2,12,{shieldRatio:.3}));
 x.locked.add(12);
 const notify="That target is not locked.";
 x.controls.refuse=method=>{
  if(method==="Activate")throw Object.assign(Error(notify),{status:409,code:"CALL_REFUSED",
   refusal:{key:"CustomNotify",values:dict([["notify",notify]])}});
 };
 assert.match((await x.tick())!.waiting!,/lock was lost/);
 await x.tick();
 assert.equal(x.nativeCalls("Activate").length,1);
 x.locked.delete(12);
 await x.tick();
 assert.deepEqual(x.nativeCalls("AddTarget"),[[12]]);
 x.locked.add(12);x.controls.refuse=()=>{};
 assert.match((await x.tick())!.active!,/Pilot 2/);
 assert.equal(x.nativeCalls("Activate").length,2);
});

test("an ambiguous repair write leaves its module on watch without blocking another repairer",async()=>{
 const x=fixture(["shield","armor"]);
 x.peers.set(12,point(2,12,{shieldRatio:.3,armorRatio:.3}));
 x.locked.add(12);
 x.controls.refuse=(method,args)=>{if(method==="Activate"&&args[0]===50)throw Error("GamePort response lost");};
 assert.match((await x.tick())!.active!,/remote armor repair/);
 x.controls.clock(5000);
 await x.tick();
 assert.deepEqual(x.nativeCalls("Activate"),[[50,"",12,0],[51,"",12,0]]);
 x.peers.set(12,point(2,12));
 x.active.set(50,12);
 await x.tick();
 assert.equal(x.nativeCalls("Activate").length,2);
 x.active.clear();x.controls.refuse=()=>{};
 x.peers.set(13,point(3,13,{shieldRatio:.4}));x.locked.add(13);
 assert.match((await x.tick())!.active!,/remote shield repair on Pilot 3/);
});

test("the existing Defender hosts a weaponless logistics ship and shuts down a repair on Stop",async()=>{
 const x=fixture(),docs=new Map<string,unknown>(),target={kind:"BELT" as const,systemID:300,name:"Belt"};
 const claim={key:"BELT:300:Belt",operationID:"op",runID:"run",generation:1,expiresAt:Date.now()+60000};
 x.peers.set(90,npc);
 x.peers.set(12,point(2,12));
 const defender=createMiningDefender({run:x.run,session:x.session,shipID:11,target,claim,beltID:77,
  document:key=>({read:()=>docs.get(key)??null,write:value=>{docs.set(key,structuredClone(value));}}),
  current(){},stopRequested:()=>false,authority:()=>({state:"ACTIVE",target,claim}),
  repairMembers:members,repairEligible:x.eligible});
 x.peers.set(13,point(3,13,{shieldRatio:.2,position:pos(9000)}));
 assert.equal(await defender.tick(),"logistics-watch");
 assert.deepEqual(x.nativeCalls("Approach"),[]);
 x.peers.set(13,point(3,13));
 x.peers.set(12,point(2,12,{shieldRatio:.2,armorRatio:.3}));
 x.locked.add(12);
 x.session.flow.flying.classifyDroneRoles=async()=>{throw Error("The urgent repair should take priority over the combat tick.");};
 assert.equal(await defender.tick(),"repairing");
 assert.deepEqual(x.nativeCalls("Activate"),[[50,"",12,0]]);
 assert.match(defender.repairStatus()!,/remote shield repair on Pilot 2/);
 await defender.stop();
 assert.deepEqual(x.nativeCalls("Deactivate"),[[50,null]]);
 assert.equal(x.active.size,0);
 assert.equal(x.nativeCalls("CmdEngage").length,0);
});
