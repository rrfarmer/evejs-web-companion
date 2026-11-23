import test from 'node:test';import assert from 'node:assert/strict';import {launchedDroneIDs,checkDroneEngage,allDronesTargetUnavailable,DroneTargetUnavailableRefusal,boundedDroneWrite,boundedDroneRead,stalledReturn} from './droneAdapter.ts';
import {planCombatDroneLaunch,readCombatDroneLaunch} from './droneAdapter.ts';
test('native launch response identifies exact stacks and preserves partial refusal',()=>{assert.deepEqual(launchedDroneIDs({type:'dict',entries:[[7,{type:'list',items:[8,9]}]]},[{itemID:7,quantity:2}]),[8,9]);assert.throws(()=>launchedDroneIDs({type:'dict',entries:[[7,{type:'list',items:[8,['CustomNotify',{}]]}]]},[{itemID:7,quantity:2}]));assert.throws(()=>launchedDroneIDs({type:'dict',entries:[]},[{itemID:7,quantity:2}]));});
test('engage accepts empty per-drone error map and rejects refusals or malformed outcomes',()=>{checkDroneEngage({type:'dict',entries:[]},[8,9]);assert.throws(()=>checkDroneEngage({type:'dict',entries:[[8,['error',{}]]]},[8,9]));assert.throws(()=>checkDroneEngage(null,[8]));});
test('bounded unresolved write retains custody, without reissuing',async()=>{let issued=0,unknown=0;await assert.rejects(boundedDroneWrite(()=>{issued++;return new Promise(()=>{});},5,()=>unknown++),/still in flight/);assert.equal(issued,1);assert.ok(unknown>=1);await assert.rejects(boundedDroneRead(()=>new Promise(()=>{}),5),/timed out/);});

test('only an acknowledged, stalled returning drone can be rearmed once',()=>{const p={at:0,distance:55000,rearmed:false};assert.equal(stalledReturn(p,55000,15000,'returning',3,3),true);assert.equal(stalledReturn(p,55000,15000,'idle',3,3),false);assert.equal(stalledReturn(p,54000,16000,'returning',3,3),false);assert.equal(p.at,16000);p.rearmed=true;assert.equal(stalledReturn(p,54000,50000,'returning',3,3),false);});
test('native wire long IDs and per-drone refusal are preserved',()=>{const lng=(value:string)=>({type:'long',value});assert.deepEqual(launchedDroneIDs({type:'dict',entries:[[lng('7'),{type:'list',items:[lng('8'),lng('9')]}]]},[{itemID:7,quantity:2}]),[8,9]);assert.throws(()=>launchedDroneIDs({type:'dict',entries:[[7,{type:'list',items:[8]}]]},[{itemID:7,quantity:2}]),/count/);assert.throws(()=>checkDroneEngage({type:'dict',entries:[[lng('8'),['CustomNotify',{type:'dict',entries:[['notify','Out of range']]}]]]},[8]),/Out of range/);});

test('only exact complete native target-unavailable refusals qualify',()=>{const error=['CustomNotify',{type:'dict',entries:[['notify','That target cannot be engaged by drones.']]}],result={type:'dict',entries:[[8,error],[9,error]]};assert.equal(allDronesTargetUnavailable(result,[8,9]),true);assert.equal(allDronesTargetUnavailable({type:'dict',entries:[[8,error]]},[8,9]),false);assert.throws(()=>checkDroneEngage({type:'dict',entries:[[8,error]]},[8,9]),/Drone order refused/);assert.throws(()=>checkDroneEngage(result,[8,9]),DroneTargetUnavailableRefusal);assert.equal(allDronesTargetUnavailable({type:'dict',entries:[[8,error],[8,error]]},[8,9]),false);assert.equal(allDronesTargetUnavailable({type:'dict',entries:[[8,['Other',error[1]]],[9,error]]},[8,9]),false);assert.equal(allDronesTargetUnavailable({type:'dict',entries:[[8,['CustomNotify',{type:'dict',entries:[['notify','Out of range']]}]],[9,error]]},[8,9]),false);assert.equal(allDronesTargetUnavailable(result,[8,8]),false);});

test('mixed drone stacks fit both native limits after subtracting already controlled drones',()=>{
 const bay=[{itemID:10,typeID:1,quantity:10},{itemID:20,typeID:2,quantity:5}];
 assert.deepEqual(planCombatDroneLaunch(bay,[{typeID:3}],{maxActiveDrones:10,droneBandwidth:70},{1:5,2:10,3:5}),[
  {itemID:20,typeID:2,quantity:5},{itemID:10,typeID:1,quantity:3},
 ]);
 assert.deepEqual(planCombatDroneLaunch(bay,[{typeID:3}],{maxActiveDrones:2,droneBandwidth:70},{1:5,2:10,3:5}),[
  {itemID:20,typeID:2,quantity:1},
 ]);
});

test('capacity refusal preserves a partial launch without inventing missing IDs',()=>{
 const notify='Not enough drone bandwidth to launch that drone.';
 const error=['CustomNotify',{type:'dict',entries:[['notify',notify]]}];
 const stacks=[{itemID:10,quantity:3},{itemID:20,quantity:1}];
 const result={type:'dict',entries:[[10,{type:'list',items:[100,error]}],[20,{type:'list',items:[200]}]]};
 assert.deepEqual(readCombatDroneLaunch(result,stacks),{ids:[100,200],refusals:[notify]});
 assert.throws(()=>readCombatDroneLaunch({...result,entries:[[10,{type:'list',items:[100]}],result.entries[1]]},stacks),/omitted/);
});
