import test from "node:test";
import assert from "node:assert/strict";
import { legacyMasteryGoals, recommendFittingSkills, type FittingDogma, type FittingItem } from "./planner.ts";

const type = (categoryID: number, groupID: number, requiredSkills: number[], effects: number[], attributes: [number,number][] = []) =>
  ({ categoryID, groupID, requiredSkills, effects, attributes });
const shipModifier = (target:number, input:number, operation:number) =>
  ({func:"ItemModifier",domain:"shipID",modifiedAttributeID:target,modifyingAttributeID:input,operation});
const data: FittingDogma = {
  types: {
    32880: type(6,25,[32918],[5139,8313],[[1271,10],[192,5]]),
    597: type(6,25,[3331],[511],[[192,4]]),
    626: type(6,26,[],[],[[1271,75]]),
    648: type(6,28,[3342],[727],[[38,3900],[495,5]]),
    2100000919: type(6,28,[3343,3331],[728],[[1556,42000],[809,10]]),
    3342: type(16,257,[],[729]),
    3343: type(16,257,[],[730]),
    3331: type(16,257,[],[731]),
    483: type(7,54,[3386],[67],[[6,5],[30,2],[50,60]]),
    25266: type(7,737,[25544],[2726],[[6,10],[30,2],[50,60]]),
    16278: type(7,464,[16281],[67]),
    451: type(7,53,[3300,3303],[10],[[6,2.67]]),
    523: type(7,62,[3393,3392],[27]),
    1319: type(7,765,[3394],[59]),
    2456: type(18,100,[3436,24241],[10],[[1272,5]]),
    10250: type(18,101,[3438,22541],[17],[[1272,5]]),
  },
  effects: {5139:{name:"miningFrigateBonusOreMiningYield"},8313:{name:"miningFrigateBonusGasCloudHarvestingDuration"},
    727:{modifiers:[shipModifier(38,495,6)]},728:{name:"unrelated display name",modifiers:[shipModifier(1556,809,6)]},
    729:{modifiers:[shipModifier(495,280,0)]},730:{modifiers:[shipModifier(809,280,0)]},
    731:{modifiers:[shipModifier(810,280,0)]}},
};
const hard = [{typeID:3386,toLevel:1},{typeID:32918,toLevel:1}];
const ore: FittingItem[] = [[483,27,1],[483,28,1],[25266,5,1]];
const mapped = (goals: ReturnType<typeof recommendFittingSkills>) => Object.fromEntries(goals.map(g=>[g.typeID,g.level]));
test("tier goals follow installed ore, ice and gas tools, including two gas scoops", () => {
  assert.deepEqual(recommendFittingSkills(32880,ore,hard,"FAST",data),[]);
  const veteran = mapped(recommendFittingSkills(32880,ore,hard,"VETERAN",data));
  const elite = mapped(recommendFittingSkills(32880,ore,hard,"ELITE",data));
  assert.equal(veteran[3410],3);
  assert.equal(elite[3410],5);
  assert.equal(elite[25544],undefined,"a gas scoop in cargo does not define an ore fitting");
  assert.equal(elite[3419],undefined);
  const gas = mapped(recommendFittingSkills(32880,[[25266,27,1],[25266,28,1]],[{typeID:25544,toLevel:1}],"ELITE",data));
  assert.equal(gas[25544],2);
  assert.equal(gas[3410],undefined);
  assert.equal(gas[32918],5);
  const ice = mapped(recommendFittingSkills(32880,[[16278,27,1]],[],"ELITE",data));
  assert.equal(ice[16281],5);
  assert.equal(ice[3386],undefined);
});
test("armor/turrets, native hauling bonuses, and fitted drone bandwidth select different goals", () => {
  const combat = mapped(recommendFittingSkills(597,[[451,27,1],[523,11,1]],[],"ELITE",data));
  assert.equal(combat[3315],3);
  assert.equal(combat[3303],5);
  assert.equal(combat[3393],4);
  assert.equal(combat[12213],undefined,"T1 fit does not need T2 specialization");
  assert.equal(combat[3410],undefined);
  for(const [hull,skill] of [[648,3342],[2100000919,3343]] as const){
    const haul=mapped(recommendFittingSkills(hull,[],[{typeID:skill,toLevel:1}],"VETERAN",data));
    assert.equal(haul[skill],4);
    assert.equal(haul[3455],4);
    assert.equal(haul[3426],undefined,"zero-demand expander");
    assert.equal(haul[3436],undefined,"ship has no fitted drones");
    assert.equal(haul[3331],undefined,"a required skill with no link to a hauling coefficient adds no recommendation");
    assert.equal(mapped(recommendFittingSkills(hull,[],[],"ELITE",data))[skill],5);
  }
  const combatDrones = mapped(recommendFittingSkills(32880,[[2456,87,8]],[],"VETERAN",data));
  assert.equal(combatDrones[3436],2,"limited by 10 Mbit/s despite the eight fitted spares");
  assert.equal(combatDrones[24241],4);
  assert.equal(combatDrones[3438],undefined);
  assert.equal(mapped(recommendFittingSkills(626,[[2456,87,8]],[],"VETERAN",data))[3436],5);
  const miningDrones = mapped(recommendFittingSkills(32880,[[10250,87,2]],[],"ELITE",data));
  assert.equal(miningDrones[3438],5);
  assert.equal(miningDrones[22541],4);
  assert.equal(miningDrones[24241],undefined);
});
test("legacy MASTERY goals retain their prior level V policy", () => {
  assert.deepEqual(legacyMasteryGoals(hard,[[48,100],[11,30]]),[
    {typeID:3386,level:5},{typeID:32918,level:5},{typeID:3426,level:5},{typeID:3413,level:5},
  ]);
});
