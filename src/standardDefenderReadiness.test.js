"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { defenderReadiness } = require("./standardDefenderReadiness");
const { createMiningPreparation } = require("./miningPreparation");
const data = {
  getType: id => ({ 1:{categoryID:6,groupID:26}, 2:{categoryID:7,groupID:74}, 3:{categoryID:18,groupID:100},
    4:{categoryID:8,groupID:85}, 5:{categoryID:8,groupID:85}, 6:{categoryID:8,groupID:83},
    7:{categoryID:7,groupID:379}, 8:{categoryID:7,groupID:60} })[id] || {categoryID:16},
  getTypeDogma: id => ({attributes: id===2 ? {128:1,604:85,182:100,277:2} : id===4 ? {128:1} : id===5 ? {128:2} : id===6 ? {128:1} : {}, effects:id===2 ? [12] : []}),
  getSkillType: id => id===100 ? {name:"Gunnery"} : null, getTypeName: id => `Type ${id}`,
};
const sheet = {serverNowMs:1000,skills:[{typeID:100,level:2,skillPoints:100}],queue:{active:false,entries:[]}};
const contract = {shipTypeID:1,equipment:[[27,2,1],[87,3,5]],supplies:[]};
const row = (typeID,flagID,quantity=1) => ({typeID,flagID,quantity});
const observation = {complete:true,shipTypeID:1,rows:[row(2,27),row(3,87,5),row(4,5,100)]};
const check = (o=observation,c=contract,s=sheet,allow=false) => defenderReadiness(c,o,s,data,allow);
test("Standard Defender accepts proven weapons+drones without optional utilities", () => {
  assert.deepEqual(check().damagePaths,["DRONES","WEAPONS"]); assert.equal(check().state,"VERIFIED");
});
test("drone-only and weapon-only fits are supported damage paths", () => {
  for (const [equipment,rows,path] of [[[ [87,3,5] ],[row(3,87,5)],"DRONES"],[[[27,2,1]],[row(2,27),row(4,27,5)],"WEAPONS"]])
    assert.deepEqual(check({...observation,rows},{...contract,equipment}).damagePaths,[path]);
});
test("passive or utility-only fit is NOT_READY", () => {
  assert.match(check({...observation,rows:[row(7,19),row(8,11)]},{...contract,equipment:[[19,7,1],[11,8,1]]}).reason,/needs combat/);
});
test("weapon without ammunition is blocked even when combat drones exist", () => {
  assert.match(check({...observation,rows:observation.rows.filter(r=>r.typeID!==4)}).reason,/compatible ammunition/);
});
test("incompatible charge group and size cannot pass readiness", () => {
  for(const typeID of [5,6]) assert.equal(check({...observation,rows:[row(2,27),row(typeID,5,999),row(3,87)]}).state,"BLOCKED");
});
test("shared supply plan may fill known ammo, but final readiness requires it aboard", () => {
  const o={...observation,rows:[row(2,27)]},c={...contract,supplies:[{typeID:4,target:10}]};
  assert.equal(check(o,c,sheet,true).state,"VERIFIED"); assert.equal(check(o,c).state,"BLOCKED");
});
test("skills missing or unreadable fail closed", () => {
  assert.match(check(observation,contract,{...sheet,skills:[]}).reason,/NOT_READY/);
  assert.match(check(observation,contract,null).reason,/UNKNOWN/);
});
test("incomplete fit observation cannot be classified READY", () => {
  assert.equal(check({...observation,complete:false}).state,"BLOCKED");
});
test("Defender participates in ordinary preparation; held/custody pilot is blocked before MAIN", async () => {
  const detail={selected:contract,status:{equipment:"VERIFIED",supplies:"FULL",targets:[]},pilot:{accountID:1,characterID:11,
    quality:"COMPLETE",dockState:"DOCKED",observation,control:{state:"RECOVERY"}},
    candidateSource:{quality:"COMPLETE",query:"ALLOWED",take:"ALLOWED",rows:[]}};
  const preparation=createMiningPreparation({store:{getAccount:async()=>({accountID:1}),getCharacterForAccount:async()=>true},
    readReview:async()=>detail,readSkills:async()=>sheet,data,engine:{unresolved:()=>[{}]}});
  const plan=await preparation.plan({operationID:"op",members:[{role:"DEFENDER",accountName:"owned",characterID:11}]});
  assert.equal(plan.state,"BLOCKED");assert.equal(plan.members.length,1);assert.match(plan.members[0].reason,/RECOVERY/);
});
