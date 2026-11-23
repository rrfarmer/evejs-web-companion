import test from 'node:test';import assert from 'node:assert/strict';import {createRawTypeFacts} from './typeFacts.ts';
test('raw family requires exact catalogue entry, category and quoted native volume',async()=>{const fetcher:typeof fetch=async input=>{const p=new URL(String(input)).pathname;return Response.json({ok:true,...(p.endsWith('resources')?{resources:[{typeID:1,name:'ore',family:'ore'},{typeID:2,name:'ice',family:'ice'}]}:p.endsWith('dogma-types')?{available:true,types:{1:{categoryID:25},2:{categoryID:25},3:{categoryID:25},4:{categoryID:8}}}:{volumes:{1:0.1,2:2.5,3:0.02,4:2},capped:false})})};const facts=await createRawTypeFacts({baseUrl:'http://bff',fetch:fetcher},()=>{})([1,2,3,4]);assert.deepEqual([facts[1]!.resourceFamily,facts[1]!.freightKind,facts[1]!.unitVolumeM3],['ore','RAW',0.1]);assert.deepEqual([facts[2]!.resourceFamily,facts[2]!.freightKind,facts[2]!.unitVolumeM3],['ice','RAW',2.5]);assert.notEqual(facts[3]!.freightKind,'RAW');assert.equal(facts[4]!.freightKind,null);});
test('only actual native recipe outputs are compressed; unknown category-25 items remain unknown',async()=>{
 const fetcher:typeof fetch=async input=>{const p=new URL(String(input)).pathname;const data=p.endsWith('resources')?{resources:[{typeID:1,name:'ore',family:'ore'},{typeID:2,name:'ice',family:'ice'}]}:p.endsWith('compressed')?{compressedTypeIDs:{1:10,2:20},capped:false}:p.endsWith('dogma-types')?{available:true,types:{3:{categoryID:25},10:{categoryID:25},20:{categoryID:25}}}:{volumes:{3:1,10:.001,20:.1},capped:false};return Response.json({ok:true,...data});};
 const facts=await createRawTypeFacts({baseUrl:'http://bff',fetch:fetcher},()=>{})([3,10,20]);assert.equal(facts[3]!.freightKind,null);assert.equal(facts[10]!.freightKind,'COMPRESSED');assert.equal(facts[10]!.resourceFamily,'ore');assert.equal(facts[20]!.resourceFamily,'ice');
});

test("repeated resource types do not repeat metadata requests",async()=>{
 const calls:string[]=[];
 const fetcher:typeof fetch=async input=>{
  const url=new URL(String(input));calls.push(url.pathname+url.search);
  const body=url.pathname.endsWith("resources")?{resources:[{typeID:1,name:"ore",family:"ore"},{typeID:2,name:"ice",family:"ice"}]}:
   url.pathname.endsWith("dogma-types")?{available:true,types:{1:{categoryID:25},2:{categoryID:25}}}:
   {volumes:{1:0.1,2:2.5},capped:false};
  return Response.json({ok:true,...body});
 };
 const facts=createRawTypeFacts({baseUrl:"http://bff",fetch:fetcher},()=>{});
 assert.deepEqual(await facts([]),{});
 const first=await facts([1]);
 assert.deepEqual(await facts([1,1]),first);
 const next=await facts([1,2]);
 assert.equal(next[2]?.resourceFamily,"ice");
 assert.deepEqual(calls,[
  "/api/mining-operations/resources","/api/client-data/dogma-types?typeIDs=1","/api/types/volumes?typeIDs=1",
  "/api/client-data/dogma-types?typeIDs=2","/api/types/volumes?typeIDs=2",
 ]);
});
