"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),http=require("node:http");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"wc-center-"));process.env.EVEJS_WEB_POC_DATA_DIR=root;
const {createApp}=require("./server"),{createProvisioningObservation}=require("../runtime-patches/provisioningObservation");
test("missing per-pilot consistency evidence cannot authorize Review",()=>{
 const {validateProjection}=require("./provisioningCenter");
 assert.throws(()=>validateProjection({version:1,accountID:1,quality:"PARTIAL",completeRoster:false,pilots:[{
  characterID:10,accountID:1,quality:"PARTIAL",reasons:[],observation:{complete:false,rows:[]}
 }]},1),/PROJECTION_INVALID/);
});
test("physical loaded charges and carried spares share the accepted counting policy exactly once",()=>{
 const {buildContract,inspectContract}=require("./provisioningContracts"),{fittingFingerprint}=require("./pilotTrainingFittings");
 const items=[{typeID:2,flagID:19,quantity:1},{typeID:3,flagID:19,quantity:7}];
 const data={getType:id=>({categoryID:{1:6,2:7,3:8}[id]}),getTypeName:id=>`Type ${id}`};
 const contract=buildContract({fittingID:4,ownerID:20,shipTypeID:1,name:"Charge fit",savedDate:"100",items,fingerprint:fittingFingerprint(1,items)},
  {scope:"CORPORATION",accountID:1,characterID:10,corporationID:20},data);
 const tables={accounts:{qa:{id:1}},characters:{10:{accountId:1,characterName:"QA",corporationID:20,stationID:60,shipID:50}},items:{
  50:{itemID:50,typeID:1,ownerID:10,locationID:60,flagID:4,singleton:1},
  51:{itemID:51,typeID:2,ownerID:10,locationID:50,flagID:19,singleton:1},
  52:{itemID:52,typeID:3,ownerID:10,locationID:50,flagID:19,singleton:0,stacksize:3},
  53:{itemID:53,typeID:3,ownerID:10,locationID:50,flagID:5,singleton:0,stacksize:2}}};
 const p=createProvisioningObservation({read:t=>({success:true,data:tables[t]}),processRole:"world",control:characterID=>({characterID,online:false,controlState:"offline"})}).project(1,10).pilots[0];
 const status=inspectContract(contract,p.observation,data);assert.equal(status.equipment,"VERIFIED");assert.equal(status.targets[0].current,5);assert.equal(status.targets[0].deficit,2);assert.equal(status.supplies,"LOW");
});
test("account HTTP roster/detail is read-only, uses shared exact Review and refuses foreign scope",async t=>{
 const row=(itemID,typeID,locationID,flagID,quantity=1,singleton=0,ownerID=10)=>({itemID,typeID,locationID,flagID,quantity,stacksize:quantity,singleton,ownerID});
 const tables={accounts:{qa:{id:1}},characters:{10:{accountId:1,characterName:"QA",corporationID:20,shipID:50,shipTypeID:1,stationID:60,solarSystemID:70}},items:{50:row(50,1,60,4,1,1),51:row(51,2,50,27,1,1),52:row(52,3,50,5,3)},corporations:{records:{20:{stationID:60}}},corporationRuntime:{corporations:{20:{members:{10:{roles:"0",titleMask:0,rolesAtHQ:"1048576"}},offices:{80:{corporationID:20,officeID:80,stationID:60,impounded:false}}}}}};
 let broken=false,drift=false, reads=0,selected=0,busy=false,definitionCount=1,definitionSavedDate="100",enableApply=false,released=0;
 const project=createProvisioningObservation({read:table=>broken&&table==="items"?{success:false}:{success:true,data:tables[table]},processRole:"world",control:characterID=>({characterID,online:busy,controlState:busy?"browser_pilot":"offline"})});
 const object=args=>({type:"object",args:{type:"dict",entries:Object.entries(args)}});
 const gateway={async getProvisioningObservation(accountID,characterID=null,source){assert.equal(accountID,1);reads++;if(drift&&reads%2===0)tables.items[52].stacksize++;return project.project(accountID,characterID,source);},
 async callMethod(service,method,args,kwargs,fields){assert.equal(service,"corpFittingMgr");assert.equal(method,"GetFittings");assert.equal(fields.characterID,10);assert.equal(fields.corpid,20);return{result:{type:"dict",entries:Array.from({length:definitionCount},(_,i)=>[4+i,object({fittingID:4+i,ownerID:20,name:`Fit ${i+1}`,shipTypeID:1,savedDate:definitionSavedDate,fitData:{type:"list",items:[{type:"tuple",items:[2,27,1]},{type:"tuple",items:[3,5,5]}]}})])}};},
 async selectCharacter(){selected++;throw new Error("No selection permitted");},
 async getCharacterStatus(){return{characterID:10,online:busy,controlState:busy?"browser_pilot":"offline"};},
 async selectFactoryCharacter(){assert.equal(enableApply,true,"Review cannot select a pilot");selected++;busy=true;return{bridgeSessionID:"qa-private",session:{characterID:10,shipID:50,shipTypeID:1,stationID:60,corporationID:20}};},
 async releaseBridgeSession(){released++;busy=false;return{released:true,offline:true};}};
 const app=createApp({eveGatewayClient:gateway,eveStore:{getAccount:async()=>({accountID:1,username:"qa",banned:false}),listCharactersForAccount:async()=>[{characterID:10}]},
  webAuth:{verifySessionToken:()=>({accountID:1,username:"qa",sessionID:"standalone"}),createSessionToken:()=>"qa-token"},errorLogger:()=>{},
  staticData:{getType:id=>({1:{categoryID:6},2:{categoryID:7},3:{categoryID:8}})[id],getTypeName:id=>`Type ${id}`,getStationName:()=>"Station",getSolarSystemName:()=>"System"}});
 const server=http.createServer(app);await new Promise(r=>server.listen(0,"127.0.0.1",r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const request=async(route,method="GET",body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{authorization:"Bearer qa-token","content-type":"application/json",connection:"close"},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:r.headers.get("content-type")?.includes("json")?await r.json():{},cookie:r.headers.get("set-cookie")};};
 const before=structuredClone(tables),base="/api/ship-provisioning";
 const roster=(await request(base+"/roster")).body;assert.equal(roster.pilots[0].matches.state,"MATCH");assert.equal(roster.pilots[0].status.equipment,"VERIFIED");assert.equal(roster.pilots[0].status.supplies,"LOW");assert.equal(roster.pilots[0].control.state,"FREE");
 const detail=(await request(base+"/review?characterID=10&providerCharacterID=10&fittingID=4&sourceKind=corp&corporationID=20&division=1")).body;assert.equal(detail.selected.name,"Fit 1");assert.equal(detail.candidateSource.contentsLocationID,80);assert.match(detail.candidateSource.take,/UNKNOWN/);assert.equal(detail.readOnly,true);assert.deepEqual(tables,before);assert.equal(selected,0);
 definitionCount=2;assert.equal((await request(base+"/roster")).body.pilots[0].matches.state,"AMBIGUOUS");definitionCount=1;
 delete tables.items[51];const modified=(await request(base+"/review?characterID=10&fittingID=4")).body;assert.equal(modified.matches.state,"MODIFIED");assert.equal(modified.status.equipment,"MODIFIED");tables.items[51]=before.items[51];
 broken=true;const partial=(await request(base+"/review?characterID=10&fittingID=4")).body;assert.equal(partial.pilot.quality,"PARTIAL");assert.equal(partial.status.equipment,"UNKNOWN");assert.equal(partial.status.supplies,"UNKNOWN");broken=false;
 busy=true;assert.equal((await request(base+"/roster")).body.pilots[0].control.state,"BUSY");assert.equal(selected,0);
 busy=false;const release=app.locals.replenishment.enterWrite(10);
 try { const owned=(await request(base+"/roster")).body.pilots[0].control;assert.equal(owned.state,"BUSY");assert.equal(owned.owner,"WC_OPERATION");assert.throws(()=>app.locals.replenishment.assertSelectable(10),/CHARACTER_IN_USE/);assert.equal(selected,0); }
 finally { release(); }
 assert.notEqual((await request(base+"/review?characterID=99")).status,200);assert.notEqual((await request(base+"/review?characterID=10&sourceKind=corp&corporationID=30&division=1")).status,200);
 for(const selector of ["sourceKind=corp-unknown","providerCharacterID=bad","fittingID=bad","sourceKind=corp&division=bad"])
  assert.notEqual((await request(base+"/review?characterID=10&"+selector)).status,200);
 drift=true;const mixed=(await request(base+"/review?characterID=10&fittingID=4")).body;
 assert.equal(mixed.status.equipment,"UNKNOWN");assert.equal(mixed.pilot.observation.complete,false);assert.equal(mixed.pilot.control.state,"UNKNOWN");assert.equal(mixed.candidateSource.quality,"PARTIAL");drift=false;
 const login=await request(base+"/login","POST",{username:"qa"});assert.equal(login.cookie,null);assert.equal(selected,0);
 assert.equal((await request(base+"/apply","POST",{})).body.error,"CONFIRMATION_REQUIRED");assert.equal(selected,0);
 // Exercise the real HTTP -> account/provider GetFittings -> buildContract ->
 // server accepted-intent -> post-acquisition readReview refusal path.
 const accepted=(await request(base+"/review?characterID=10&fittingID=4")).body;
 assert.equal(accepted.applyReview.canApply,true);definitionSavedDate="101";enableApply=true;
 const beforeApply=structuredClone(tables);
 const refused=(await request(base+"/apply","POST",{confirm:true,reviewID:accepted.applyReview.reviewID,reviewHash:accepted.applyReview.reviewHash})).body.outcome;
 assert.equal(refused.state,"REFUSED");assert.equal(refused.reason,"REVIEW_STALE");assert.equal(refused.provisioning,null);
 assert.equal(refused.release.state,"VERIFIED_OFFLINE");assert.equal(selected,1);assert.equal(released,1);assert.equal(busy,false);
 assert.equal(app.locals.replenishment.journal.list().length,0);assert.deepEqual(tables,beforeApply);
 assert.deepEqual(app.locals.provisioningCenterApply.journal.get(accepted.applyReview.reviewID).pin.definition,accepted.selected.definition);
});
