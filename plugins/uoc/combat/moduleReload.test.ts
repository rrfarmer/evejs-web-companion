import test from 'node:test';import assert from 'node:assert/strict';import {chooseCombatAmmo,executeCombatReload,observeCombatReloads} from './moduleReload.ts';
const id={key:'room/module/reload-1',characterID:1,shipID:2,moduleID:3,moduleTypeID:4,cargoItemID:5,chargeTypeID:6};
test('a reload needs exact positive readback and is never repeated',async()=>{let doc:unknown=null,calls=0,loaded=false,clock=0;const deps={document:{read:()=>doc,write:(v:unknown)=>{doc=structuredClone(v);}},current(){},fence:async()=>{},load:async()=>{calls++;loaded=true;},loaded:async()=>loaded,sleep:async(ms:number)=>{clock+=ms;},now:()=>clock};await executeCombatReload(id,deps);await executeCombatReload(id,deps);assert.equal(calls,1);assert.equal((doc as any).rows[0].status,'CONFIRMED');});
test('a lost native reload response retains custody and cannot be replayed',async()=>{let doc:unknown=null,calls=0;const deps={document:{read:()=>doc,write:(v:unknown)=>{doc=structuredClone(v);}},current(){},fence:async()=>{},load:async()=>{calls++;throw Error('lost response');},loaded:async()=>false,sleep:async()=>{},now:()=>0};await assert.rejects(executeCombatReload(id,deps),/lost response/);await assert.rejects(executeCombatReload(id,deps),/unresolved/);assert.equal(calls,1);});
test('ammunition choice requires matching native group and size and excludes FOF',()=>{const rows=[{itemID:1,typeID:21,groupID:9,quantity:1},{itemID:2,typeID:22,groupID:9,quantity:4},{itemID:3,typeID:23,groupID:10,quantity:1}],fit={groups:[9],size:2};assert.deepEqual(chooseCombatAmmo(rows,fit,{21:{128:2,1455:1},22:{128:2},23:{128:2}}),{itemID:2,typeID:22});assert.equal(chooseCombatAmmo(rows,fit,{21:{128:2,1455:1}}),null);});

test("a deferred reload does not block another module or count an acknowledgement as fitting proof",async()=>{
 let doc:unknown=null,calls=0;
 const document={read:()=>structuredClone(doc),write:(v:unknown)=>{doc=structuredClone(v);}};
 const deps={document,current(){},fence:async()=>{},load:async()=>{calls++;},
  loaded:async()=>assert.fail("Defender must use normal fitting reads"),sleep:async()=>assert.fail("Defender must not poll"),now:()=>0,deferConfirmation:true};
 const other={...id,key:"room/other/reload-1",moduleID:7,cargoItemID:8};
 await executeCombatReload(id,deps);
 await executeCombatReload(other,deps);
 assert.equal(calls,2);
 assert.deepEqual(observeCombatReloads(document,id,row=>row.moduleID===other.moduleID),{pending:new Set([id.moduleID]),confirmed:true});
 assert.deepEqual((doc as any).rows.map((r:any)=>r.status),["ACKNOWLEDGED","CONFIRMED"]);
 await assert.rejects(executeCombatReload({...id,key:"room/module/reload-2"},deps),/unresolved/);
 assert.equal(calls,2);
 assert.deepEqual(observeCombatReloads(document,id,row=>row.moduleID===id.moduleID),{pending:new Set(),confirmed:true});
});
