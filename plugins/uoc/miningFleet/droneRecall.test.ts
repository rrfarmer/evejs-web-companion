import test from "node:test";
import assert from "node:assert/strict";
import {assertFleetDroneDeparture,readFleetDronePanel,recallFleetDrones} from "./droneRecall.ts";

const drone={itemID:7,typeID:101,controlled:true,activity:"mining"};
const row={itemID:7,typeID:101,quantity:-1};
function fixture(frames:{out:unknown[]|null;bay:unknown[];inSpaceError?:string}[],positions:number[]=[]){
  let time=0,read=0,position=0;
  const calls:string[]=[];
  const run={baseUrl:"http://fixture",fetch:async(url:Parameters<typeof fetch>[0])=>{
    if(String(url).endsWith("/space/snapshot")){
      const geometry=(x:number)=>({position:{x,y:0,z:0},radius:10});
      const x=positions[Math.min(position++,positions.length-1)];
      return Response.json({ok:true,space:x===undefined?null:{
        shipID:11,inSpace:true,stateValid:true,ship:geometry(0),
        entities:[{itemID:7,controllerID:11,kind:"drone",...geometry(x)}],
      }});
    }
    const {out,bay,inSpaceError}=frames[Math.min(read++,frames.length-1)]!;
    calls.push("read");
    return Response.json({ok:true,activeShipID:11,bay,inSpace:out,errors:{bay:null,inSpace:inSpaceError??null,shipInfo:null}});
  }};
  const session={flow:{requestOptions:()=>({}),flying:{bridgeDo:async(_service:string,method:string)=>{
    calls.push(method);return {type:"dict",entries:[]};
  }}}} as any;
  return {calls,session,panel:()=>readFleetDronePanel(run,session,11,()=>{}),recall:()=>recallFleetDrones(run,session,11,()=>{},
    {now:()=>time,wait:async ms=>{time+=ms;},timeoutMs:6000})};
}
test("fleet drone panel decodes controlled state, wrapped IDs, orders and shield",async()=>{
  const long=(value:number)=>({type:"long",value:String(value)});
  const f=fixture([{bay:[],out:[
    {...drone,itemID:long(7),typeID:long(101),targetID:long(23),shieldRatio:"0.6"},
    {itemID:8,controlled:false,activity:"",shieldRatio:null},
  ]}]);
  assert.deepEqual((await f.panel()).out,[
    {itemID:7,typeID:101,controlled:true,activity:"mining",targetID:23,shieldRatio:0.6},
    {itemID:8,typeID:null,controlled:false,activity:null,targetID:null,shieldRatio:null},
  ]);
});

test("fleet drone panel accepts an empty flight and rejects unavailable or ambiguous rows",async()=>{
  assert.deepEqual((await fixture([{bay:[],out:[]}]).panel()).out,[]);
  for(const frame of [{out:null},{out:[],inSpaceError:"READ_FAILED"},
    {out:[drone,{...drone,itemID:{type:"long",value:"7"}}]},{out:[{itemID:7}]}])
    await assert.rejects(fixture([{...frame,bay:[]}]).panel(),/observation is unavailable/);
});

test("return ACK and an empty grid still wait for the exact fresh bay row",async()=>{
  const f=fixture([{out:[drone],bay:[]},{out:[],bay:[]},{out:[],bay:[row]}]);
  assert.deepEqual(await f.recall(),{unrecovered:[],stillControlled:[],refusal:null});
  assert.equal(f.calls.filter(x=>x==="CmdReturnBay").length,1);
  assert.equal(f.calls.filter(x=>x==="InvalidateLocationCache").length,3);
});
test("absent drones are reported unrecovered and a still controlled drone blocks normal travel",async()=>{
  const disappeared=fixture([{out:[drone],bay:[]},{out:[],bay:[]}]);
  assert.match(assertFleetDroneDeparture(await disappeared.recall())??"",/not recovered.*7/);
  const stuck=fixture([{out:[drone],bay:[]}]);
  const result=await stuck.recall();
  assert.throws(()=>assertFleetDroneDeparture(result),/did not settle.*7/);
  assert.equal(stuck.calls.filter(x=>x==="CmdReturnBay").length,1);
});

test("native progress renews the no-progress window without another return order",async()=>{
  const frames=Array.from({length:11},()=>({out:[drone],bay:[]}));
  const f=fixture([...frames,{out:[],bay:[row]}],frames.map((_,i)=>20000-i*300));
  assert.deepEqual(await f.recall(),{unrecovered:[],stillControlled:[],refusal:null});
  assert.equal(f.calls.filter(x=>x==="CmdReturnBay").length,1);
});

test("F4 drone bay updates before the recall acknowledgment is lost",async()=>{
 const f=fixture([{out:[drone],bay:[]},{out:[],bay:[row]}]);
 const bridgeDo=f.session.flow.flying.bridgeDo;let delivered=false,writes=0;
 f.session.flow.flying.bridgeDo=async(service:string,method:string)=>{
  if(method!=="CmdReturnBay")return bridgeDo(service,method);
  writes++;delivered=true;
  await Promise.resolve();
  throw Object.assign(Error("Recall response was lost"),{code:"CALL_TIMEOUT"});
 };
 const result=await f.recall();
 assert.ok(delivered);assert.equal(writes,1);
 assert.deepEqual(result.unrecovered,[]);assert.deepEqual(result.stillControlled,[]);
 assert.equal(result.refusal,"Recall response was lost");
});
