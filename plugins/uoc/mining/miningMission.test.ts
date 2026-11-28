import test from "node:test";
import assert from "node:assert/strict";
import { MINING_MISSION_CONTENT, GAS_MISSION_IDS, SPECIAL_MINING_MISSION_IDS } from "./catalog.ts";
import { decodeMiningMissionRead, decodeMiningObjective } from "./objective.ts";
import { entryAfter } from "./entryEvidence.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";

const list = (...items: JsonValue[]): JsonValue => ({ type: "list", items });
const tuple = (...items: JsonValue[]): JsonValue => ({ type: "tuple", items });
const dict = (v: Record<string, JsonValue>): JsonValue => ({ type: "dict", entries: Object.entries(v) });
const c = MINING_MISSION_CONTENT[0]!;
function objective(patch: Record<string, JsonValue> = {}): JsonValue {
  return dict({ contentID: c.contentID, missionState: 1, completionStatus: 0, importantStandings: 0,
    agentGift: list(), objectives: list(tuple("fetch", tuple(1001, dict({typeID:1531, locationID:600, solarsystemID:300}),
      dict({typeID:c.typeID, quantity:c.quantity, volume:c.quantity*c.unitVolume, hasCargo:false})))),
    dungeons:list(dict({dungeonID:c.dungeonID, optional:false, location:dict({typeID:5,locationType:"dungeon",agentID:42,
      locationNumber:0,locationID:300,solarsystemID:300,coords:tuple(1,2,3)})})), ...patch });
}
test("native objective accepts only qualified exact resource and location", () => {
  assert.equal(decodeMiningObjective(null, objective(), 7, 42).objective?.content.contentID, c.contentID);
  for (const patch of [{completionStatus:null}, {completionStatus:2}, {agentGift:null}, {dungeons:[]},
    {objectives:null}, {importantStandings:1}, {contentID:999}])
    assert.equal(decodeMiningObjective(null, objective(patch as unknown as Record<string, JsonValue>), 7, 42).objective, null);
  for (const contentID of [...GAS_MISSION_IDS, ...SPECIAL_MINING_MISSION_IDS])
    assert.equal(decodeMiningObjective(null, objective({contentID}), 7, 42).objective, null);
});
test("absence requires successful native reads and an empty known journal", () => {
  const reads = {briefing:null, objective:null, errors:{briefing:null,objective:null}};
  assert.equal(decodeMiningMissionRead(reads,{active:[],offered:[]},7,42).reason,"NO_MISSION");
  assert.notEqual(decodeMiningMissionRead({...reads,errors:{briefing:"FAILED",objective:null}},{active:[],offered:[]},7,42).reason,"NO_MISSION");
  assert.notEqual(decodeMiningMissionRead(reads,null,7,42).reason,"NO_MISSION");
});
test("dungeon entry receipt is scoped, causal and fresh", () => {
  const scope={characterID:7,shipID:8,flowGeneration:3};
  const receipt={source:"NATIVE_PUSH" as const,scope,sequence:11,receivedAtMs:1000,
    dungeon:{dungeonID:9,roomID:null,instanceID:10}};
  const expected={scope,afterSequence:10,issuedAtMs:900,dungeonID:9,instanceID:10};
  assert.equal(entryAfter(receipt,expected,1100),true);
  assert.equal(entryAfter(receipt,{...expected,afterSequence:11},1100),false);
  assert.equal(entryAfter(receipt,{...expected,scope:{...scope,flowGeneration:4}},1100),false);
  assert.equal(entryAfter(receipt,{...expected,instanceID:11},1100),false);
  assert.equal(entryAfter(receipt,expected,17000),false);
});
import {miningAgentApproach, missionShipQuantity, missionModuleRange} from "./miningMission.ts";
import type {MiningMissionState, MiningScriptObservation as ScriptObservation} from "../shared/missionTypes.ts";
test("uncertain pending work never reopens ordinary agent approach",()=>{
 assert.equal(miningAgentApproach(null,null),true);
 const initial={phase:"ready",objective:null,pending:null,cycle:null} as MiningMissionState;
 assert.equal(miningAgentApproach(initial,null),true);
 assert.equal(miningAgentApproach({...initial,pending:{id:"op",kind:"request"}},null),false);
 assert.equal(miningAgentApproach(initial,{id:"op",dispatched:true,acknowledged:false,missionCompleted:false}),false);
});
test("unknown hold and missing native reach never authorize guessed freight or range",()=>{
 assert.equal(missionShipQuantity({holds:null},28617),null);
 const obs={miningMission:{nowMs:100,readAtMs:100,fit:[{itemID:1,typeID:2,family:"ore",cycleMs:1000}]},snapshot:{ship:{moduleReach:null}}} as unknown as ScriptObservation;
 assert.equal(missionModuleRange(obs,1,2,"ore"),null);
});
test("GamePort native range guides admission without inventing extended moduleReach",()=>{
 const obs={flightStatus:{shipID:8},miningMission:{nowMs:100,readAtMs:100,sceneReadAtMs:100,
  fit:[{itemID:1,typeID:2,family:"ore",cycleMs:1000}]},
  snapshot:{inSpace:true,shipID:8,ship:{itemID:8,moduleReach:null,moduleRanges:[{moduleID:1,rangeM:15000}]}}} as unknown as ScriptObservation;
 assert.equal(missionModuleRange(obs,1,2,"ore"),15000);
 assert.equal(missionModuleRange(obs,1,3,"ore"),null);
 assert.equal(missionModuleRange(obs,1,2,"ice"),null);
 assert.equal(missionModuleRange({...obs,flightStatus:{shipID:9}} as ScriptObservation,1,2,"ore"),null);
 for(const rangeM of [0,-1,NaN]) assert.equal(missionModuleRange({...obs,snapshot:{...obs.snapshot,
  ship:{...obs.snapshot!.ship,moduleRanges:[{moduleID:1,rangeM}]}}} as ScriptObservation,1,2,"ore"),null);
 assert.equal(missionModuleRange({...obs,miningMission:{...obs.miningMission!,sceneReadAtMs:-20000}} as ScriptObservation,1,2,"ore"),null);
 assert.equal(missionModuleRange({...obs,snapshot:{...obs.snapshot,ship:{...obs.snapshot!.ship,
  moduleReach:{availability:"unavailable"}}}} as unknown as ScriptObservation,1,2,"ore"),null);
});
import {createMiningMissionMacro} from "./miningMission.ts";
import type {MacroStep} from "../../../web/src/plugin-api/index.ts";
test("mission policy refuses a non-hosted run without sending an action",()=>{
 const unexpected=()=>{throw new Error("mechanics must not run")};
 const decide=createMiningMissionMacro({station:unexpected,system:unexpected,mine:unexpected});
 const step={id:"mine",kind:"macro",macro:"uoc:run-mining-mission",args:{}} as MacroStep;
 const obs={miningMission:{hosted:false}} as unknown as ScriptObservation;
 const tick=decide(step,obs,{},{});
 assert.equal(tick.outcome.kind,"blocked");assert.equal(tick.action.kind,"wait");
});

test("a transport unable to read the native pocket cannot request or accept a mission", () => {
  const unexpected = () => { throw new Error("movement or mining must not run"); };
  const decide = createMiningMissionMacro({ station: unexpected, system: unexpected, mine: unexpected });
  const step: MacroStep = { id: "mine", kind: "macro", macro: "uoc:mine-mission", args: {} };
  const obs = { miningMission: { hosted: true, state: null,
    agent: { agentID: 42, stationID: 600, solarSystemID: 300, divisionID: 23, agentTypeID: 2, level: 1, name: "Agent" },
    entryAuthorityFailure: "keeper.GetCurrentDungeonForCharacter (CALL_NOT_ALLOWED)" } } as unknown as ScriptObservation;
  const tick = decide(step, obs, {}, { agentID: 42 });
  assert.equal(tick.action.kind, "wait");
  assert.equal(tick.outcome.kind, "blocked");
  assert.match(tick.why, /keeper\.GetCurrentDungeonForCharacter \(CALL_NOT_ALLOWED\)/);
});
