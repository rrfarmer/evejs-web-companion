import test from 'node:test';import assert from 'node:assert/strict';
import {bridgeCallQueueTimeout,progressDeadline,travelFacts,readAfterTimeout} from './progressDeadline.ts';
test('travel has an idle watchdog, not an overall wall deadline; sample clocks alone do not extend it',()=>{let clock=0;const check=progressDeadline(100,()=>clock),f={shipID:1,solarSystemID:2,shipMode:'FOLLOW'};
 assert.equal(check(travelFacts(f,null,{x:0,y:0,z:0})),true);clock=110;assert.equal(check(travelFacts({...f,sampledAtMs:110},null,{x:1,y:0,z:0})),true);clock=200;assert.equal(check(travelFacts({...f,sampledAtMs:200},null,{x:2,y:0,z:0})),true);clock=301;assert.equal(check(travelFacts({...f,sampledAtMs:301},null,{x:2,y:0,z:0})),false);
});


test('an RPC read timeout gets one immediate current-state reread; ordinary refusals do not retry',async()=>{let calls=0;assert.equal(await readAfterTimeout(async()=>{if(++calls===1)throw Object.assign(Error('late'),{code:'CALL_TIMEOUT'});return 'current-native-state';}),'current-native-state');assert.equal(calls,2);calls=0;await assert.rejects(readAfterTimeout(async()=>{calls++;throw Error('wrong ship');}),/wrong ship/);assert.equal(calls,1);});

test("only a definite queue rejection proves the bridge command was never sent", () => {
 const error=(message:string)=>({code:"BRIDGE_NETWORK_ERROR",status:0,message});
 assert.equal(bridgeCallQueueTimeout(error("/api/bridge/call waited 65s for a hosted request slot. Hosted BFF requests: 8 active.")),true);
 assert.equal(bridgeCallQueueTimeout(error("/api/bridge/call never got a connection: it waited 20s for one of the browser's 4 request lanes.")),true);
 assert.equal(bridgeCallQueueTimeout(error("Bridge call invbroker.Add could not reach the BFF: fetch failed.")),false);
 assert.equal(bridgeCallQueueTimeout(error("Bridge call invbroker.Add timed out; other calls waited 65s for a hosted request slot.")),false);
 assert.equal(bridgeCallQueueTimeout({code:"CALL_TIMEOUT",status:504,message:"Remote call timed out"}),false);
});
