import test from "node:test";
import assert from "node:assert/strict";
import {createCivilianProfileRoutes} from "./profiles.ts";
import {civilianSetup,type CivilianProfile} from "./profile.ts";

const profile: CivilianProfile = {
 pilot:{characterID:7,characterName:"FixtureHaul1",accountName:"FixtureHaul1"},
 mode:"distribution", automatic:false, agent:{agentID:42,name:"Courier Agent",stationID:600,corporationID:68,corporationName:"Carthum",level:2},
 corporationID:68, corporationName:"Carthum", level:2, fallback:false, runtime:120,
 policy:"COUNT",limit:3,maxJumps:12,searchJumps:6,
 parking:{mode:"SELECTED",destination:{kind:"structure",id:99,name:"Home",solarSystemID:30,solarSystemName:"Mista"}},
};

test("saved profiles survive reopening, edit one pilot in place and leave mission history intact on Remove", async () => {
 const history = {worker:"original FixtureHaul1", acceptedMission:900};
 const documents = new Map<string,unknown>([["runs",history]]);
 const routes = () => createCivilianProfileRoutes(world => ({
  doc:{read:()=>structuredClone(documents.get("profiles:"+world)??null),write:value=>documents.set("profiles:"+world,structuredClone(value))},
  close(){},
 }), () => ["fixturehaul1"]);
 const request = (worldID:string,body:unknown=null) => ({
  account:{accountID:1,username:"operator"},path:"",method:"GET",params:{characterID:"7"},query:{},worldID,body,
 });
 const saved = await routes()["POST /civilian/profiles"]!(request("world-a",{...profile,worker:"ignored"}));
 assert.deepEqual((saved.body as any).profiles,[profile]);
 const reopened = await routes()["GET /civilian/profiles"]!(request("world-a"));
 assert.deepEqual(reopened.body,{ok:true,profiles:[profile],workerAccounts:["fixturehaul1"]});
 assert.deepEqual((await routes()["GET /civilian/profiles"]!(request("world-b")) as any).body.profiles,[]);
 const edited = {...profile,mode:"mining" as const,automatic:true,agent:null,policy:"TIME" as const,limit:0,runtime:180,
  fallback:true,parking:{mode:"NEAREST" as const}};
 const update = await routes()["POST /civilian/profiles"]!(request("world-a",edited));
 assert.deepEqual((update.body as any).profiles,[edited]);
 assert.deepEqual(civilianSetup((update.body as any).profiles[0]),{agent:{mode:"auto",levelRule:"max",level:2,corporationID:68,maxJumps:6},missionCount:1,parking:{mode:"nearest"},durationMinutes:180});
 const removed = await routes()["POST /civilian/profiles/:characterID/remove"]!(request("world-a",{}));
 assert.deepEqual((removed.body as any).profiles,[]);
 assert.equal(documents.get("runs"),history);
});

test("profile validation rejects unsupported mission settings before writing", async () => {
 let writes = 0;
 const routes = createCivilianProfileRoutes(()=>({doc:{read:()=>null,write:()=>{writes++;}},close(){}}));
 const request = {account:{accountID:1,username:"operator"},path:"",method:"POST",params:{},query:{},worldID:"a",body:{...profile,maxJumps:31}};
 const result = await routes["POST /civilian/profiles"]!(request);
 assert.equal(result.status,409);
 assert.equal(writes,0);
});
