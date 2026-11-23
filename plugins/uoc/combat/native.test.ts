import test from "node:test";
import assert from "node:assert/strict";
import { checkedJournal, securityDungeon, securityObjective, securityResumePhase } from "./native.ts";
const list=(...items:unknown[])=>({type:"list",items});
const tuple=(...items:unknown[])=>({type:"tuple",items});
const dict=(value:Record<string,unknown>)=>({type:"dict",entries:Object.entries(value)});
test('current exact dungeon can resume combat without a historical docking step',()=>{
 const id={dungeonID:875,roomID:0,instanceID:99,destinationSystemID:6},f={inSpace:true,docked:false,shipMode:'STOP',solarSystemID:6};
 assert.equal(securityResumePhase(f,id,tuple(875,0,99),true),'COMBAT');
 assert.equal(securityResumePhase(f,id,null,false),'MISSION_SYSTEM');
 assert.equal(securityResumePhase(f,id,tuple(875,0,100),true),null);
 assert.equal(securityResumePhase({...f,shipMode:'WARP'},id,tuple(875,0,99),true),null);
 assert.equal(securityResumePhase(f,id,null,true),null);
});
function journal(state=1){return checkedJournal(tuple(list(...(state===2?[tuple(2,0,0,70,4,"123",0,0,0,2504)]:[])),list(...(state===1?[tuple(1,0,0,70,4,"123",0,0,0,2504)]:[]))));}
function objective(extra:Record<string,unknown>={}){return dict({contentID:2504,missionState:1,completionStatus:0,objectives:list(),normalRewards:list(tuple(29,100,null)),dungeons:list(dict({dungeonID:875,optional:false,location:dict({solarsystemID:6,locationNumber:0,agentID:4,locationType:"dungeon",coords:tuple(1,2,3)}),objectiveCompleted:null})),...extra});}
test("real-shaped Security wire permits only source-qualified dungeon with exact owner",()=>{
 const parsed=securityObjective(objective(),journal(),4);assert.equal(parsed?.offer.dungeonID,875);assert.equal(parsed?.offer.expectedISK,100);assert.deepEqual(parsed?.position,{x:1,y:2,z:3});
 assert.equal(securityObjective(objective(),journal(),8),null);
 assert.equal(securityObjective(objective({dungeons:list(dict({dungeonID:875,optional:false,shipRestrictions:1,location:dict({})}))}),journal(),4),null);
 assert.equal(securityObjective(objective({objectives:list(tuple("fetch",list()))}),journal(),4),null);
});
test("keeper native tuple rejects missing/unknown identity",()=>{
 assert.deepEqual(securityDungeon(tuple(875,0,99)),{dungeonID:875,roomID:0,instanceID:99});
 assert.equal(securityDungeon(tuple(875,0,null)),null);assert.equal(securityDungeon(null),null);
});

test("level 2 native briefing requires its exact 909/209 tuple and agent",()=>{
 const j=checkedJournal(tuple(list(),list(tuple(1,0,0,70,4,"123",0,0,0,909))));
 const raw=objective({contentID:909,dungeons:list(dict({dungeonID:209,optional:false,location:dict({solarsystemID:6,locationNumber:0,agentID:4,locationType:"dungeon",coords:tuple(1,2,3)}),objectiveCompleted:null}))});
 assert.equal(securityObjective(raw,j,4,2)?.offer.dungeonID,209);assert.equal(securityObjective(raw,j,4,1),null);assert.equal(securityObjective(raw,j,8,2),null);
});
