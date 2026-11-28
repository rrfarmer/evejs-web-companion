import test from "node:test";
import assert from "node:assert/strict";
import {decodeSpaceSnapshot} from "../../../web/src/plugin-api/flying.ts";
import {claimedBeltRocks} from "./beltRocks.ts";
// NativeGridcheck snapshot 2026-11-07 12:38:24 UTC, belt 40009129; retail omits rock beltID.
const center={x:26450042880,y:654827520,z:73017630720};
const belt={itemID:40009129,groupID:9,categoryID:2,name:"Niyabainen II - Asteroid Belt 1",position:center,radius:27471.900391};
const rock={itemID:5020484674074,typeID:1228,groupID:462,categoryID:25,beltID:null,position:{x:26450025737.701973,y:654827725.1931722,z:73017610884.76143},radius:433.0127018922193};
const context={shipID:11,characterID:1,systemID:30000143,beltID:40009129};
const scene=(entities:any[],ship:any={itemID:11,characterID:1,position:center,radius:100})=>decodeSpaceSnapshot({stateValid:true,sampledAtMs:Date.now(),inSpace:true,shipID:11,solarSystemID:30000143,ship,entities} as any);
test("a GamePort rock with null belt ID is selected only inside the exact proven belt",()=>{assert.deepEqual(claimedBeltRocks(scene([belt,rock]),context).map(r=>r.itemID),[rock.itemID]);});
test("foreign explicit belt, outside rock, competing envelope and missing geometry are rejected",()=>{
 const foreign={...rock,beltID:40009130},outside={...rock,position:{...center,x:center.x+belt.radius+1}},other={...belt,itemID:40009130,name:"other"};
 assert.deepEqual(claimedBeltRocks(scene([belt,foreign,outside,{...rock,position:undefined}]),context),[]);
 assert.deepEqual(claimedBeltRocks(scene([belt,rock,other]),context),[]);
 assert.throws(()=>claimedBeltRocks(scene([belt,rock,{...other,position:undefined}]),context),/geometry/);
 assert.throws(()=>claimedBeltRocks(scene([{...belt,position:undefined},rock]),context),/belt/);
});
test("claimed belt identity and native ship arrival are required",()=>{
 assert.deepEqual(claimedBeltRocks(scene([{...belt,name:null},rock]),context).map(r=>r.itemID),[rock.itemID]);
 assert.throws(()=>claimedBeltRocks(scene([{...belt,groupID:10},rock]),context),/not an asteroid belt/);
 assert.throws(()=>claimedBeltRocks(scene([{...belt,itemID:40009130},rock]),context),/belt/);
 assert.throws(()=>claimedBeltRocks(scene([belt,rock],{itemID:11,characterID:1,position:{...center,x:center.x+100000},radius:100}),context),/reached/);
 assert.throws(()=>claimedBeltRocks(scene([belt,rock],{itemID:11,characterID:2,position:center,radius:100}),context),/identity/);
});
