import test from "node:test";
import assert from "node:assert/strict";
import {inspectRawStockOperation,createStockOperationClient,type StockDefinition,type HoldSnapshot,type ResourceRow} from "./stockPreflight.ts";
const members=[{characterID:1,accountName:"a",role:"MINER" as const,routineMode:"STANDARD" as const},
 {characterID:2,accountName:"b",role:"MINER" as const,routineMode:"STANDARD" as const},
 {characterID:3,accountName:"c",role:"HAULER" as const,routineMode:"STANDARD" as const}];
const def:StockDefinition={operationID:"op",area:{anchorSystemID:300,reach:"CURRENT_SYSTEM",targetClasses:["BELT"]},unloadPolicy:"HAULER_SERVICE",
 unloadDestination:{stationID:600,corporationID:100,corporationDivision:1},policies:{parking:{mode:"RETURN_HOME_UNLOAD_DOCK"}},members};
// Stock `listMiningResources` excludes compressed type IDs using sourceTypesByCompressedTypeID.
const resources:ResourceRow[]=[{typeID:34,name:"Veldspar",family:"ore"},{typeID:35,name:"Scordite",family:"ore"},{typeID:16262,name:"Ice",family:"ice"}];
const holds=(id:number):HoldSnapshot=>({characterID:id,accountName:id===1?"a":"b",heldCharacterID:id,onlineCharacterID:id,
 shipID:10+id,activeShipID:10+id,source:"stock-ore-hold",observedAt:1000,
 holds:[{key:"cargo",present:true,error:null,capacity:{capacity:100,used:1},items:[{itemID:1000+id,typeID:999,categoryID:7,quantity:1}]},
  {key:"ore",present:true,error:null,capacity:{capacity:100,used:10},items:[{itemID:2000+id,typeID:34,categoryID:25,quantity:10}]},
  ...["gas","ice","asteroid"].map(key=>({key,present:false,error:null,capacity:{capacity:0,used:0},items:[]}))]});
test("stock raw preflight checks both owned ships but never asserts execution-ready",()=>{
 const result=inspectRawStockOperation(def,resources,[holds(1),holds(2)],1000);
 assert.equal(result.observedRawOnly,true);assert.equal(result.launchReady,false);assert.match(result.blockers.join(" "),/manifest/);
});
test("compressed or unknown specialty rows, stale reads and custody mismatch fail preflight",()=>{
 const compressed=holds(1);(compressed.holds[1]!.items as any)[0].typeID=28432;
 assert.equal(inspectRawStockOperation(def,resources,[compressed,holds(2)],1000).observedRawOnly,false);
 assert.equal(inspectRawStockOperation(def,resources,[holds(1),{...holds(2),heldCharacterID:99}],1000).observedRawOnly,false);
 assert.equal(inspectRawStockOperation(def,resources,[holds(1),holds(2)],17001).observedRawOnly,false);
 assert.equal(inspectRawStockOperation({...def,support:{enabled:true}},resources,[holds(1),holds(2)],1000).observedRawOnly,false);
 assert.equal(inspectRawStockOperation(def,[resources[0]!,resources[0]!],[holds(1),holds(2)],1000).observedRawOnly,false);
});
test("player-authorized client exposes read and Stop, never a hosted-run Start escape",async()=>{
 const calls:{url:string;method:string}[]=[];const fetcher:typeof fetch=async(input,init)=>{calls.push({url:String(input),method:init?.method??"GET"});return new Response(JSON.stringify({ok:true,resources:[],planHash:"x"}));};
 const client=createStockOperationClient(fetcher,"http://bff/");assert.equal("start" in client,false);
 await client.resources();await client.preview("op/1");await client.stop("op/1");
 assert.deepEqual(calls.map(c=>[new URL(c.url).pathname,c.method]),[["/api/mining-operations/resources","GET"],["/api/mining-operations/op%2F1/launch-plan","GET"],["/api/mining-operations/op%2F1/stop","POST"]]);
});
