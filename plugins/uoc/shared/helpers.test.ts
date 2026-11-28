import test from "node:test";
import assert from "node:assert/strict";
import { acceptedMissionKey, dungeonEntered, readObservedModuleReach, iceMiningType } from "./helpers.ts";
import { decodeInventoryRowsChecked } from "./inventory.ts";
import { unwrapLong } from "./wire.ts";
import type { JournalState, SpaceSnapshot } from "./types.ts";
test("mission and dungeon identity are explicit and unambiguous",()=>{
 const row={agentID:4,missionID:5,missionTitleID:6,expirationTime:"7"};
 const journal={active:[row],offered:[]} as unknown as JournalState;
 assert.equal(acceptedMissionKey(journal,4),'[4,5,6,"7"]');
 assert.equal(acceptedMissionKey({active:[row,row],offered:[]} as unknown as JournalState,4),null);
 assert.deepEqual(dungeonEntered([875,0,null,99]),{dungeonID:875,roomID:0,instanceID:99});
 assert.equal(dungeonEntered([null,0,null,99]),null);
});
test("missing and stale projected module reach never authorize range",()=>{
 const scene={inSpace:true,shipID:1,sampledAtMs:50,ship:{itemID:1}} as unknown as SpaceSnapshot;
 assert.equal(readObservedModuleReach(scene,2,3),null);
 const row={moduleID:2,typeID:3,family:"mining",resourceFamily:"ore",maxRangeMeters:100,settlementSurfaceDistanceMeters:null,availability:"available",reason:null};
 const withReach={...scene,ship:{...scene.ship!,moduleReach:{shipID:1,sampledAtSimTimeMs:49,availability:"available",modules:[row]}}} as unknown as SpaceSnapshot;
 assert.equal(readObservedModuleReach(withReach,2,3),null);
 assert.equal(readObservedModuleReach({...withReach,ship:{...withReach.ship!,moduleReach:{...withReach.ship!.moduleReach!,sampledAtSimTimeMs:50}}},2,3)?.maxRangeMeters,100);
});
test("inventory proof refuses ambiguous malformed list; wire numeric precision is kept",()=>{
 assert.equal(decodeInventoryRowsChecked(null),null);
 assert.deepEqual(decodeInventoryRowsChecked({type:"list",items:[]}),[]);
 assert.equal(decodeInventoryRowsChecked({type:"list",items:[{type:"packedrow",fields:{itemID:0,typeID:1,quantity:2}}]}),null);
 assert.equal(unwrapLong({type:"long",value:"9223372036854775807"}),9223372036854775807n);
 assert.equal(iceMiningType({77:1,182:16281}),true);
});
