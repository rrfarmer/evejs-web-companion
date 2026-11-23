import test from 'node:test';import assert from 'node:assert/strict';import {unresolvedCombatRuns} from './combatCustody.ts';
test('only exact later native completion receipts resolve an earlier stopped accepted mission',()=>{
 const old={epoch:'old',character_id:1,owner:'pilot',status:'ENDED',receipt:{phase:'COMBAT',identity:{acceptedKey:'accepted'}}},done={epoch:'new',character_id:1,owner:'pilot',status:'ENDED',receipt:{phase:'DONE',completed:[{identity:{acceptedKey:'accepted'},commandID:'native-complete'}]}};
 assert.deepEqual(unresolvedCombatRuns([done,old],'SECURITY_MISSION'),[]);
 for(const receipt of [{phase:'DONE',completed:[{identity:{acceptedKey:'different'},commandID:'native-complete'}]},{phase:'DONE',completed:[{identity:{acceptedKey:'accepted'},walletDelta:100}]},{phase:'COMBAT',completed:[{identity:{acceptedKey:'accepted'},commandID:'native-complete'}]}])assert.ok(unresolvedCombatRuns([{...done,receipt},old],'SECURITY_MISSION').includes(old));
 assert.ok(unresolvedCombatRuns([{...done,owner:'foreign'},old],'SECURITY_MISSION').includes(old));assert.ok(unresolvedCombatRuns([{...done,status:'RUNNING'},old],'SECURITY_MISSION').some(r=>r.epoch==='new'));
});
