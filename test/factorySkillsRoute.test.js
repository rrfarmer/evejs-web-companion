"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const client = require("../src/eveGatewayClient");

test("stock release acknowledgement does not manufacture offline proof or expose private endpoint methods",async t=>{
 const original=global.fetch;t.after(()=>global.fetch=original);let url;
 global.fetch=async u=>{url=String(u);return Response.json({source:"evejs-web-gateway",apiVersion:1,ok:true,released:true,characterID:7});};
 const release=await client.releaseBridgeSession("own-handle",{userid:1});assert.deepEqual(release,{released:true,characterID:7});assert.match(url,/session\/release$/);
 for(const name of ["selectFactoryCharacter","quoteFactorySkills","acquireFactorySkills","getProvisioningObservation"])assert.equal(client[name],undefined);
});
