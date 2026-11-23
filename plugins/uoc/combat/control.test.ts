import test from 'node:test';import assert from 'node:assert/strict';
import {registerCombatRun,requestCombatOperationStop,combatControlSnapshot} from './control.ts';
import {runControlRoutes} from '../runControl.ts';
test('one member Stop and exact whole-operation Stop have distinct original controller callbacks',async()=>{
 let retired=0,whole=0;const run:any={botID:'coc-control-test',characterID:1,setup:{operationID:'control-op',operationRunID:'epoch'}},close=registerCombatRun(run,'Pilot1',()=>{retired++;},()=>{whole++;},()=>({anchor:{characterID:1,shipID:11,size:3}}));
 try{const result=await runControlRoutes['POST /runs/:botID/stop']!({params:{botID:run.botID},account:{username:'Pilot1'}} as any);assert.equal(result.status,202);assert.equal(retired,1);assert.equal(whole,0);assert.throws(()=>requestCombatOperationStop('control-op','foreign'),/unavailable/);assert.equal(requestCombatOperationStop('control-op','epoch'),1);assert.equal(whole,1);assert.equal((combatControlSnapshot('control-op','epoch') as any).anchor.shipID,11);}finally{close();}assert.equal(combatControlSnapshot('control-op','epoch'),null);
});
