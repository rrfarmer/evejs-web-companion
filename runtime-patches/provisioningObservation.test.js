"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const { createProvisioningObservation }=require("./provisioningObservation");
const reference = process.env.EVEJS_CLEAN_REFERENCE || require("../scripts/prepare-runtime-test-reference").prepareRuntimeTestReference().reference;
function fixture(options={}) {
  const item=(itemID,typeID,locationID,flagID,quantity=1,singleton=0)=>({itemID,typeID,locationID,flagID,quantity,stacksize:quantity,singleton,ownerID:10});
  const tables={accounts:{qa:{id:1,passwordhash:"SECRET"}},characters:{10:{accountId:1,characterName:"QA",corporationID:20,shipID:50,shipTypeID:1,stationID:60,solarSystemID:70}},
    items:{50:item(50,1,60,4,1,1),51:item(51,2,50,19,1,1),52:item(52,3,50,5,3)},corporations:{records:{20:{stationID:60}}},
    corporationRuntime:{corporations:{20:{members:{10:{roles:"0",titleMask:0,rolesAtHQ:"1048576",rolesAtOther:"0",rolesAtBase:"0"}},offices:{80:{officeID:80,stationID:60,corporationID:20,impounded:false}}}}}};
  let calls=0;
  const reader=table=>{calls++; if(options.drift && calls===5)tables.items[52].quantity=tables.items[52].stacksize=4;
    if(options.fail===table)return{success:false}; return{success:true,data:tables[table]};};
  const model=createProvisioningObservation({read:reader,control:id=>({characterID:id,online:!!options.busy,controlState:options.busy?"browser_pilot":"offline",leaseSecret:"HIDDEN"}),processRole:options.role||"world",limit:options.limit||100,now:()=>100});
  return{tables,project:(characterID=10,source)=>model.project(1,characterID,source)};
}
test("complete docked observation preserves physical quantities, secret-free and read-only",()=>{const f=fixture(),before=structuredClone(f.tables),p=f.project();assert.equal(p.pilots[0].quality,"COMPLETE");assert.equal(p.pilots[0].observation.rows.length,2);assert.equal(p.pilots[0].shipID,50);assert.equal(p.pilots[0].control.state,"FREE");assert.deepEqual(f.tables,before);assert.doesNotMatch(JSON.stringify(p),/SECRET|HIDDEN|password|leaseSecret/);});
test("foreign pilot and corporation scope are refused",()=>{const f=fixture();f.tables.characters[99]={accountId:2,characterName:"Foreign",corporationID:20,shipID:50};assert.throws(()=>f.project(99),{code:"CHARACTER_NOT_OWNED"});assert.throws(()=>f.project(10,{kind:"corp",corporationID:30,division:1}),{code:"CORPORATION_SCOPE_REJECTED"});});
for(const fault of ["character","ship","child","identity","singleton","traversal"])test(`${fault} cannot produce complete observation`,()=>{const f=fixture(fault==="traversal"?{limit:1}:{});if(fault==="character")delete f.tables.characters[10].characterName;if(fault==="ship")delete f.tables.items[50];if(fault==="child")delete f.tables.items[51].locationID;if(fault==="identity")f.tables.items[50].ownerID=11;if(fault==="singleton")f.tables.items[50].singleton=2;const p=f.project().pilots[0];assert.equal(p.quality,"PARTIAL");assert.equal(p.observation.complete,false);});
for(const table of ["accounts","characters","items"])test(`failed ${table} root is not verified empty`,()=>{const p=fixture({fail:table}).project();assert.notEqual(p.quality,"COMPLETE");if(p.pilots.length)assert.equal(p.pilots[0].observation.complete,false);else assert.equal(p.completeRoster,false);});
test("material drift and a reader-process cache cannot assert completeness",()=>{for(const options of [{drift:true},{role:"reader"}]){const p=fixture(options).project();assert.equal(p.evidence.stable,false);assert.equal(p.pilots[0].observation.complete,false);}});
test("busy pilot is observed without selection; Query never proves Take",()=>{const f=fixture({busy:true});f.tables.items[81]={itemID:81,typeID:1,locationID:80,flagID:115,quantity:2,stacksize:2,singleton:0,ownerID:20};const p=f.project(10,{kind:"corp",corporationID:20,division:1}).pilots[0];assert.equal(p.control.state,"BUSY");assert.equal(p.source.query,"ALLOWED");assert.equal(p.source.contentsLocationID,80);assert.equal(p.source.rows[0].quantity,2);assert.match(p.source.take,/UNKNOWN/);f.tables.corporationRuntime.corporations[20].members[10].titleMask=1;const next=f.project(10,{kind:"corp",corporationID:20,division:1}).pilots[0];assert.equal(next.source.query,"UNKNOWN");assert.deepEqual(next.source.rows,[]);});
test("incomplete corporation roots, impounded offices and denied Query never expose stock",()=>{
 for(const fault of ["corporations","corporationRuntime","impounded","query"]){const f=fixture(["corporations","corporationRuntime"].includes(fault)?{fail:fault}:{});
  if(fault==="impounded")f.tables.corporationRuntime.corporations[20].offices[80].impounded=true;
  if(fault==="query")f.tables.corporationRuntime.corporations[20].members[10].rolesAtHQ="0";
  const source=f.project(10,{kind:"corp",corporationID:20,division:1}).pilots[0].source;
  assert.equal(source.quality,"UNAVAILABLE");assert.deepEqual(source.rows,[]);assert.match(source.take,/UNKNOWN/);
  if(fault==="query")assert.equal(source.query,"DENIED");
 }
});
test("actual generated gateway handler emits the real envelope and fail-closed errors",async()=>{
 const {plans}=require("../scripts/provisioning-runtime-patch"),path=require("node:path"),vm=require("node:vm");
 const source=plans(reference)[1].after.toString();
 const start=source.indexOf('  app.get(`${GATEWAY_PREFIX}/provisioning-observation`'),end=source.indexOf('  app.get(`${GATEWAY_PREFIX}/snapshot`',start);
 let handler;vm.runInNewContext(source.slice(start,end),{GATEWAY_PREFIX:"/_evejs-web/v1",GATEWAY_SOURCE:"evejs-web-gateway",GATEWAY_API_VERSION:1,
 app:{get:(route,fn)=>{assert.equal(route,"/_evejs-web/v1/provisioning-observation");handler=fn;}},requireAuthorizedRuntime:fn=>fn,
 sendGatewayError:(res,status,error,message)=>res.status(status).json({ok:false,error,message})});
 let status,body;const res={status:n=>{status=n;return res;},json:v=>{body=v;}};
 const f=fixture();await handler({buildProvisioningObservation:()=>f.project()},{query:{accountID:"1",characterID:"10"}},res);
 assert.equal(status,200);assert.equal(body.source,"evejs-web-gateway");assert.equal(body.projection.pilots[0].observation.complete,true);
 await handler({}, {query:{}},res);assert.equal(status,503);
 await handler({buildProvisioningObservation:()=>{throw Object.assign(new Error(),{code:"CHARACTER_NOT_OWNED"});}}, {query:{accountID:"1",characterID:"99"}},res);assert.equal(status,403);assert.equal(body.message,"CHARACTER_NOT_OWNED");
});
test("pure ownership peek neither expires a lease nor changes the existing lifecycle getter",()=>{
 const {plans}=require("../scripts/provisioning-runtime-patch"),path=require("node:path"),vm=require("node:vm");
 const patch=plans(reference)[3],mod={exports:{}};
 vm.runInNewContext(patch.after.toString(),{module:mod,__dirname:path.dirname(path.join(reference,patch.file)),
  require:name=>name.endsWith("/chat/sessionRegistry")||name.endsWith("\\chat\\sessionRegistry")?{findSessionByCharacterID:()=>null}:require(name),
  Buffer,Uint8Array,setTimeout,clearTimeout});
 let now=100,transitions=0;const control=mod.exports.createCharacterControlRuntime({now:()=>now,setTimeout:()=>1,clearTimeout:()=>{}});
 control.subscribe(()=>transitions++);control.claimBrowserControl(10,"qa-owned-controller-identity",{ttlMs:10});
 assert.equal(control.peekCharacterControlSnapshot(10).controlState,"browser_pilot");assert.equal(transitions,1);
 now=111;assert.throws(()=>control.peekCharacterControlSnapshot(10),{code:"CHARACTER_CONTROL_UNAVAILABLE"});assert.equal(transitions,1);
 assert.equal(control.getCharacterControlSnapshot(10).controlState,"offline");assert.equal(transitions,2);control.shutdown();
});
test("patch uses unique semantic seams, is repeatable, and fails closed on changed seams",()=>{
 const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),{execFileSync}=require("node:child_process");
 const {plans}=require("../scripts/provisioning-runtime-patch"),root=fs.mkdtempSync(path.join(os.tmpdir(),"projection-patch-"));
 try {
  const base=reference,files=["server/src/_secondary/express/evejsWebGatewayRuntime.js","server/src/_secondary/express/evejsWebGateway.js",
   "server/src/edge/gateway/gatewayRuntimeProtocol.js","server/src/services/online/characterControlRuntime.js"];
  for(const file of files){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.copyFileSync(path.join(base,file),path.join(root,file));}
  const changes=plans(root);for(const c of changes){
   if(c.before?.includes(Buffer.from("\r\n")))assert.equal((c.after.toString().match(/(?<!\r)\n/g)||[]).length,(c.before.toString().match(/(?<!\r)\n/g)||[]).length,"Existing LF seams are preserved within CRLF sources");
   execFileSync(process.execPath,["--check"],{input:c.after});fs.writeFileSync(path.join(root,c.file),c.after);
  }
  assert.deepEqual(plans(root).map(c=>c.after),changes.map(c=>c.after));
  const prior=path.join(root,files[0]);fs.writeFileSync(prior,fs.readFileSync(prior,"utf8").replace(".peekCharacterControlSnapshot(",".getCharacterControlSnapshot("));
  assert.deepEqual(plans(root)[0].after,changes[0].after);
  const helper=path.join(root,changes[4].file),crlf=Buffer.from(changes[4].after.toString().replace(/\r?\n/g,"\r\n"));
  fs.writeFileSync(helper,crlf);assert.deepEqual(plans(root)[4].after,crlf,"Git EOL representation does not demand exclusive byte ownership");
  fs.appendFileSync(helper,"\n// Unknown local edit\n");assert.throws(()=>plans(root),/preserve and review/);fs.writeFileSync(helper,changes[4].after);
  const file=path.join(root,files[2]);fs.writeFileSync(file,fs.readFileSync(file,"utf8").replace('  "buildSnapshot",','  "otherSnapshot",').replace('  "buildProvisioningObservation",\n',''));
  assert.throws(()=>plans(root),/unique semantic seam/);
 } finally {assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}
});
