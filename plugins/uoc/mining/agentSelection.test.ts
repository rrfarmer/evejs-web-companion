import test from "node:test";
import assert from "node:assert/strict";
import {selectMiningAgent} from "./agentSelection.ts";
import {findMiningAgent} from "./finder.ts";
import type {MacroStep, ScriptObservation} from "../../../web/src/plugin-api/index.ts";
import type {FoundAgent} from "../shared/types.ts";
const agent=(id:number,level:number,system:number)=>({agentID:id,level,divisionID:23,agentTypeID:2,stationID:60,solarSystemID:system,corporationID:5} as FoundAgent);
const policy={preferredLevel:2,fallback:true,corporationID:null,maxJumps:3,originSystemID:1,distances:new Map([[2,2]])};
test("finder probes native access in route order and honors level fallback",async()=>{
 const order:number[]=[];
 const result=await selectMiningAgent(policy,async level=>{const agents=level===2?[agent(5,2,2),agent(3,2,1)]:[agent(7,1,1)];return {agents,total:agents.length,capped:false};},
  async id=>{order.push(id);return id===7?"usable":"ineligible"});
 assert.deepEqual(order,[3,5,7]);assert.equal(result.agent?.agentID,7);
});
test("incomplete directory and unreadable access never establish an agent",async()=>{
 const incomplete=await selectMiningAgent({...policy,fallback:false},async()=>({agents:[],total:10,capped:true}),async()=>"usable");
 assert.equal(incomplete.agent,null);assert.match(incomplete.reason,/incomplete/);
 const unreadable=await selectMiningAgent({...policy,fallback:false},async()=>({agents:[agent(3,2,1)],total:1,capped:false}),async()=>"unavailable");
 assert.equal(unreadable.agent,null);assert.match(unreadable.reason,/could not be confirmed/);
});
test("finder publishes criteria and blocks on unreadable search",()=>{
 const step={id:"finder",kind:"macro",macro:"uoc:find-mining-agent",args:{}} as MacroStep;
 const tick=findMiningAgent(step,{} as ScriptObservation,{},{});
 assert.equal(tick.boardPatch?.findKind,"mining");assert.equal(tick.boardPatch?.findLevel,1);
 assert.equal(findMiningAgent(step,{agentSearchFailure:"unreadable"} as ScriptObservation,{},{}).outcome.kind,"blocked");
});
