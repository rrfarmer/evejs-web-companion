import test from "node:test";
import assert from "node:assert/strict";
import {createFleetAssembly,FLEET_ACCEPT_OBSERVATION_MS,type FleetAssemblyObservation,type FleetAssemblyPeer} from "./fleetAssembly.ts";
function fixture(){let saved:unknown=null;const members=new Set<number>(),invites=new Map<number,{fleetID:number;inviterID:number;receivedAtMs:number}>(),calls:string[]=[];let failCreate=false,failInvite=false,failAccept=false;
 const peers:FleetAssemblyPeer[]=[1,2,3].map(id=>({characterID:id,shipID:id+10,botID:`bot${id}`,current(){},async read(){return members.has(id)?{state:"ready" as const,fleetID:90,memberIDs:[...members]}:{state:"not-in-fleet" as const}},invitation:()=>invites.get(id)??null,
  async create(){calls.push("create");if(failCreate)throw Error("lost create");members.add(1)},async invite(who){calls.push(`invite:${who}`);if(failInvite)throw Error("lost invite");invites.set(who,{fleetID:90,inviterID:1,receivedAtMs:1000})},async accept(){calls.push(`accept:${id}`);if(failAccept)throw Error("lost accept");members.add(id);invites.delete(id)}}));
 const document={read:()=>saved===null?null:structuredClone(saved),write:(v:unknown)=>{saved=structuredClone(v)}};
 const assembly=createFleetAssembly(document,"op","epoch",peers,()=>1000);return {assembly,peers,members,calls,invites,document,fail:(k:string)=>{failCreate=k==="create";failInvite=k==="invite";failAccept=k==="accept"}};}
test("one durable CreateFleet then exact invites and acceptances lead to confirmed common roster",async()=>{const x=fixture();for(let i=0;i<12;i++)if(await x.assembly.step()==="ready")break;assert.deepEqual(x.calls,["create","invite:2","accept:2","invite:3","accept:3"]);assert.deepEqual([...x.members],[1,2,3]);assert.equal(await x.assembly.step(),"ready");});
test("unknown create, invitation or acceptance is not blindly repeated",async()=>{for(const kind of ["create","invite","accept"]){const x=fixture();if(kind!=="create"){await x.assembly.step();await x.assembly.step();}if(kind==="accept")await x.assembly.step();x.fail(kind);await assert.rejects(x.assembly.step(),/lost/);const count=x.calls.length;try{await x.assembly.step()}catch{}assert.equal(x.calls.length,count);assert.equal(x.assembly.snapshot().pending?.kind,kind);}});
test("an existing selected leader-only fleet is adopted without a write",async()=>{const x=fixture();x.members.add(1);assert.equal(await x.assembly.step(),"waiting");assert.equal(x.assembly.snapshot().origin?.kind,"existing-partial");assert.equal(x.calls.length,0);});
test("exact existing selected roster is read from every pilot and durably reused without writes",async()=>{const x=fixture();for(const id of [1,2,3])x.members.add(id);assert.equal(await x.assembly.step(),"ready");assert.deepEqual(x.calls,[]);assert.deepEqual(x.assembly.snapshot().origin,{kind:"existing-exact",fleetID:90,memberIDs:[1,2,3],observedAt:1000});const restored=createFleetAssembly(x.document,"op","epoch",x.peers,()=>1001);assert.equal(await restored.step(),"ready");assert.deepEqual(x.calls,[]);});
test("a reused fleet losing a member is not modified",async()=>{const x=fixture();for(const id of [1,2,3])x.members.add(id);assert.equal(await x.assembly.step(),"ready");x.members.delete(3);await assert.rejects(x.assembly.step(),/no longer has the exact selected roster/);assert.deepEqual(x.calls,[]);});
test("existing fleet with an extra member is refused",async()=>{const x=fixture();for(const id of [1,2,3,4])x.members.add(id);await assert.rejects(x.assembly.step(),/Explicit approval/);assert.deepEqual(x.calls,[]);assert.equal(x.assembly.snapshot().origin,undefined);});
test("mixed valid fleet views wait without adopting",async()=>{for(const mixed of [true,false]){const x=fixture();for(const id of [1,2,3])x.members.add(id);x.peers[2]!.read=async()=>mixed?{state:"ready",fleetID:91,memberIDs:[1,2,3]}:{state:"not-in-fleet"};assert.equal(await x.assembly.step(),"waiting");assert.deepEqual(x.calls,[]);}});
test("an unresolved create is never reclassified as an existing fleet",async()=>{const x=fixture();x.fail("create");await assert.rejects(x.assembly.step(),/lost create/);for(const id of [1,2,3])x.members.add(id);await assert.rejects(x.assembly.step(),/creation is unresolved/);assert.deepEqual(x.calls,["create"]);assert.equal(x.assembly.snapshot().origin,undefined);});
test("invitation from another sender is never accepted",async()=>{const x=fixture();await x.assembly.step();await x.assembly.step();await x.assembly.step();x.invites.set(2,{fleetID:90,inviterID:3,receivedAtMs:1000});await assert.rejects(x.assembly.step(),/does not match/);assert.deepEqual(x.calls,["create","invite:2"]);});

test("two selected miners can form the exact two-person native fleet",async()=>{const x=fixture(),peers=x.peers.slice(0,2),d={read:()=>null,write:(_v:unknown)=>{}};const assembly=createFleetAssembly(d,"two","epoch",peers,()=>1000);for(let i=0;i<10;i++)if(await assembly.step()==="ready")break;assert.deepEqual(x.calls,["create","invite:2","accept:2"]);assert.equal(await assembly.step(),"ready");});

function consolidation(initial:Record<number,number|null>,explicitMoves?:readonly {characterID:number;shipID:number;fromFleetID:number}[],selected:readonly number[]=[1,2,3]){let value:unknown=null,now=1000,loseLeave=false,leaveApplies=true,lostActor=0;const fleetByID=new Map(Object.entries(initial).map(([id,f])=>[Number(id),f])),calls:string[]=[],invites=new Map<number,{fleetID:number;inviterID:number;receivedAtMs:number}>();const peers:FleetAssemblyPeer[]=selected.map(characterID=>({characterID,shipID:characterID+10,botID:`c${characterID}`,current(){if(lostActor===characterID)throw Error('actor retired');},async read(){const fleetID=fleetByID.get(characterID);return fleetID==null?{state:'not-in-fleet' as const}:{state:'ready' as const,fleetID,memberIDs:[...fleetByID].filter(([,f])=>f===fleetID).map(([id])=>id)};},invitation:()=>invites.get(characterID)??null,async create(){calls.push('create');fleetByID.set(characterID,90)},async invite(id,fleetID){calls.push(`invite:${id}`);invites.set(id,{fleetID,inviterID:1,receivedAtMs:now})},async accept(fleetID){calls.push(`accept:${characterID}`);fleetByID.set(characterID,fleetID);invites.delete(characterID)},async leave(){calls.push(`leave:${characterID}`);if(leaveApplies)fleetByID.set(characterID,null);if(loseLeave)throw Error('leave response lost')}}));const store={read:()=>value===null?null:structuredClone(value),write:(v:unknown)=>{value=structuredClone(v)}},moves=explicitMoves??[2,3].filter(id=>initial[id]!=null&&initial[id]!==initial[1]).map(id=>({characterID:id,shipID:id+10,fromFleetID:initial[id]!}));return {peers,calls,fleetByID,store,moves,assembly:createFleetAssembly(store,'consolidation','epoch',peers,()=>now,moves),lose:(applies:boolean)=>{loseLeave=true;leaveApplies=applies},retire:(id:number)=>{lostActor=id}};}
test('selected two-miner fleet is retained while solo hauler leaves and joins once',async()=>{const x=consolidation({1:90,2:90,3:91});for(let i=0;i<12;i++)if(await x.assembly.step()==='ready')break;assert.deepEqual(x.calls,['leave:3','invite:3','accept:3']);assert.equal(x.assembly.snapshot().origin?.kind,'existing-partial');assert.equal(await x.assembly.step(),'ready');});
test('selected partial fleet without leader is left before new leader creates fleet',async()=>{const x=consolidation({1:null,2:91,3:91});for(let i=0;i<18;i++)if(await x.assembly.step()==='ready')break;assert.deepEqual(x.calls,['leave:2','leave:3','create','invite:2','accept:2','invite:3','accept:3']);assert.equal(await x.assembly.step(),'ready');});
test('unknown leave is never repeated and only not-in-fleet native read resolves it',async()=>{for(const applies of [false,true]){const x=consolidation({1:90,2:90,3:91});await x.assembly.step();x.lose(applies);await assert.rejects(x.assembly.step(),/lost/);const restored=createFleetAssembly(x.store,'consolidation','epoch',x.peers,()=>1001,x.moves);if(applies){assert.equal(await restored.step(),'waiting');assert.equal(restored.snapshot().pending,null);}else{await assert.rejects(restored.step(),/leave is unresolved/);assert.equal(restored.snapshot().pending?.kind,'leave');}assert.deepEqual(x.calls,['leave:3']);}});
test('unselected fleet member or retired selected actor prevents any leave',async()=>{const x=consolidation({1:90,2:90,3:91,4:91},[]);await assert.rejects(x.assembly.step(),/Explicit approval/);assert.deepEqual(x.calls,[]);const y=consolidation({1:90,2:90,3:91});await y.assembly.step();y.retire(2);await assert.rejects(y.assembly.step(),/actor retired/);assert.deepEqual(y.calls,[]);});

test("valid inconsistent fleet views wait without writes, then converge to one fleet",async()=>{const x=consolidation({1:90,2:90,3:91}),read=x.peers[1]!.read;x.peers[1]!.read=async()=>({state:"ready",fleetID:90,memberIDs:[2]});const before=x.assembly.snapshot();assert.equal(await x.assembly.step(),"waiting");assert.deepEqual(x.calls,[]);assert.deepEqual(x.assembly.snapshot(),before);x.peers[1]!.read=read;for(let i=0;i<12;i++)if(await x.assembly.step()==="ready")break;assert.deepEqual(x.calls,["leave:3","invite:3","accept:3"]);assert.equal(await x.assembly.step(),"ready");});

test("inconsistent views preserve an unresolved leave intent without replay",async()=>{const x=consolidation({1:90,2:90,3:91});await x.assembly.step();x.lose(false);await assert.rejects(x.assembly.step(),/lost/);const before=x.assembly.snapshot();x.peers[1]!.read=async()=>({state:"ready",fleetID:90,memberIDs:[2]});assert.equal(await x.assembly.step(),"waiting");assert.deepEqual(x.assembly.snapshot(),before);assert.deepEqual(x.calls,["leave:3"]);});

test("missing or stale consent refuses the exact prior fleet before leave",async()=>{for(const moves of [[],[{characterID:3,shipID:13,fromFleetID:92}],[{characterID:3,shipID:14,fromFleetID:91}]]){if(moves[0]?.shipID===14){assert.throws(()=>consolidation({1:90,2:90,3:91},moves),/authorization is invalid/);continue;}const x=consolidation({1:90,2:90,3:91},moves);const before=x.assembly.snapshot();await assert.rejects(x.assembly.step(),/Explicit approval/);assert.deepEqual(x.calls,[]);assert.deepEqual(x.assembly.snapshot(),before);}});
test("approval is bound to the durable assembly identity and cannot be switched after dispatch",async()=>{const x=consolidation({1:90,2:90,3:91});await x.assembly.step();x.lose(false);await assert.rejects(x.assembly.step(),/lost/);assert.throws(()=>createFleetAssembly(x.store,"consolidation","epoch",x.peers,()=>1001,[]),/custody needs reconciliation/);assert.deepEqual(x.calls,["leave:3"]);});

test("partial approval refuses every move until all observed selected moves are approved",async()=>{const x=consolidation({1:null,2:91,3:91},[{characterID:2,shipID:12,fromFleetID:91}]);const before=x.assembly.snapshot();await assert.rejects(x.assembly.step(),/Explicit approval/);assert.deepEqual(x.calls,[]);assert.deepEqual(x.assembly.snapshot(),before);});

function largeFixture(){let saved:unknown=null,fail=0;const joined=new Set<number>(),invites=new Map<number,{fleetID:number;inviterID:number;receivedAtMs:number}>(),calls:string[]=[];const peers:FleetAssemblyPeer[]=Array.from({length:14},(_,i)=>i+1).map(id=>({characterID:id,shipID:id+100,botID:`large-${id}`,current(){},async read(){return joined.has(id)?{state:"ready" as const,fleetID:90,memberIDs:[...joined]}:{state:"not-in-fleet" as const}},invitation:()=>invites.get(id)??null,async create(){calls.push("create");joined.add(id)},async invite(who){calls.push(`invite:${who}`);if(who===fail)throw Error("lost invite");invites.set(who,{fleetID:90,inviterID:1,receivedAtMs:1000})},async accept(){calls.push(`accept:${id}`);joined.add(id);invites.delete(id)}}));const store={read:()=>saved===null?null:structuredClone(saved),write:(x:unknown)=>saved=structuredClone(x)};return {peers,joined,calls,store,assembly:createFleetAssembly(store,"large","epoch",peers,()=>1000),failAt:(id:number)=>fail=id};}
test("fourteen selected native peers assemble and verify the entire roster",async()=>{const x=largeFixture();let result="waiting";for(let i=0;i<80&&result!=="ready";i++)result=await x.assembly.step();assert.equal(result,"ready");assert.equal(x.joined.size,14);assert.equal(x.calls.filter(c=>c.startsWith("invite:")).length,13);assert.equal(x.calls.filter(c=>c.startsWith("accept:")).length,13);assert.equal(await x.assembly.step(),"ready");});
test("unknown invitation beyond the former cap is retained and never replayed",async()=>{const x=largeFixture();x.failAt(10);let failed=false;for(let i=0;i<80&&!failed;i++){try{await x.assembly.step()}catch(e){assert.match(String(e),/lost invite/);failed=true}}assert.equal(failed,true);const before=x.calls.length;assert.equal(x.assembly.snapshot().pending?.characterID,10);await x.assembly.step();assert.equal(x.calls.length,before);assert.equal(x.assembly.snapshot().pending?.kind,"invite");});

test("consented selected pilots leave foreign-populated old fleet and form a new exact fleet",async()=>{const moves=[1,2,3].map(characterID=>({characterID,shipID:characterID+10,fromFleetID:91})),x=consolidation({1:91,2:91,3:91,4:null,5:91},moves,[1,2,3,4]);for(let i=0;i<30;i++)if(await x.assembly.step()==="ready")break;assert.equal(await x.assembly.step(),"ready");assert.deepEqual(x.calls,["leave:1","leave:2","leave:3","create","invite:2","accept:2","invite:3","accept:3","invite:4","accept:4"]);assert.equal(x.fleetByID.get(5),91);assert.deepEqual([1,2,3,4].map(id=>x.fleetByID.get(id)),[90,90,90,90]);});
test('leader in fleet with outsiders requires approval for every selected departure before any write',async()=>{const x=consolidation({1:91,2:91,3:91,4:null,5:91},[{characterID:1,shipID:11,fromFleetID:91},{characterID:2,shipID:12,fromFleetID:91}],[1,2,3,4]);await assert.rejects(x.assembly.step(),/Explicit approval/);assert.deepEqual(x.calls,[]);assert.equal(x.fleetByID.get(5),91);});
test('a foreign join to the already-created target fleet stops formation without a kick or adoption',async()=>{const x=fixture();await x.assembly.step();await x.assembly.step();x.members.add(4);await assert.rejects(x.assembly.step(),/unselected member/);assert.deepEqual(x.calls,['create']);assert.equal(x.members.has(4),true);});
test('lost response to approved leader leave never causes a second leave',async()=>{const moves=[1,2].map(characterID=>({characterID,shipID:characterID+10,fromFleetID:91})),x=consolidation({1:91,2:91,3:null,4:91},moves);x.lose(false);await assert.rejects(x.assembly.step(),/lost/);assert.equal(x.assembly.snapshot().pending?.kind,'leave');await assert.rejects(x.assembly.step(),/leave is unresolved/);assert.deepEqual(x.calls,['leave:1']);assert.equal(x.fleetByID.get(4),91);});

test("a managed fleet reconnect invites its returning former leader from the observed successor",async()=>{
 const x=fixture();for(const id of [1,2,3])x.members.add(id);
 assert.equal(await x.assembly.step(),"ready");
 x.members.delete(1);
 for(const peer of x.peers){
  const read=peer.read;
  peer.read=async()=>{const r=await read();return r.state==="ready"?{...r,bossID:2}:r;};
 }
 x.peers[1]!.invite=async who=>{x.calls.push("boss2 invite:"+who);x.invites.set(who,{fleetID:90,inviterID:2,receivedAtMs:1000});};
 const resumed=createFleetAssembly(x.document,"op","epoch",x.peers,()=>1000,[],()=>true);
 for(let i=0;i<6;i++)if(await resumed.step()==="ready")break;
 assert.deepEqual(x.calls,["boss2 invite:1","accept:1"]);
 assert.equal(await resumed.step(),"ready");
});

test("all selected sessions observing no fleet can rebuild an ended managed fleet once",async()=>{
 const x=fixture();for(const id of [1,2,3])x.members.add(id);
 assert.equal(await x.assembly.step(),"ready");x.members.clear();
 const resumed=createFleetAssembly(x.document,"op","epoch",x.peers,()=>1000,[],()=>true);
 // The fake's CreateFleet assigns the expected boss.
 for(const peer of x.peers){const read=peer.read;peer.read=async()=>{const r=await read();return r.state==="ready"?{...r,bossID:1}:r;};}
 for(let i=0;i<12;i++)if(await resumed.step()==="ready")break;
 assert.equal(await resumed.step(),"ready");
 assert.deepEqual(x.calls,["create","invite:2","accept:2","invite:3","accept:3"]);
});

function retainedMccAcceptance(kind:"accept"|"invite"="accept"){
 const x=fixture();
 let time=1000;
 x.members.add(1);x.members.add(3);
 x.invites.set(2,{fleetID:90,inviterID:1,receivedAtMs:999});
 x.document.write({version:1,identity:JSON.stringify(["mcc","epoch",x.peers.map(p=>[p.characterID,p.shipID])]),
  leaderID:1,fleetID:90,pending:null,joined:[1,3],deferred:[{kind,characterID:2,issuedAt:time}]});
 const cached=(peer:FleetAssemblyPeer):FleetAssemblyObservation=>x.members.has(peer.characterID)?
  {state:"ready",fleetID:90,memberIDs:[...x.members]}:{state:"not-in-fleet"};
 x.peers[0]!.invite=async(id,fleetID)=>{
  x.calls.push(`invite:${id}`);x.invites.set(id,{fleetID,inviterID:1,receivedAtMs:time});
 };
 const create=()=>createFleetAssembly(x.document,"mcc","epoch",x.peers,()=>time,[],()=>false,{existingOnly:false,read:cached});
 return {...x,create,tick:(ms=FLEET_ACCEPT_OBSERVATION_MS)=>{time+=ms;}};
}

test("MCC rejoins only the absent pilot after a retained acceptance using a fresh invitation",async()=>{
 const x=retainedMccAcceptance(),assembly=x.create();
 await assembly.step();assert.deepEqual(x.calls,[]);
 x.tick();await assembly.step();assert.deepEqual(x.calls,["invite:2"]);
 const fresh=x.invites.get(2)!;
 x.invites.set(2,{...fresh,receivedAtMs:999});
 await assembly.step();assert.deepEqual(x.calls,["invite:2"]);
 x.invites.set(2,fresh);
 await assembly.step();assert.deepEqual(x.calls,["invite:2","accept:2"]);
 await assembly.step();
 assert.deepEqual([...x.members],[1,3,2]);
 assert.deepEqual(assembly.snapshot().deferred,[]);
});

test("MCC keeps observing when fresh fleet readback already includes the pilot or the invite is unrelated",async()=>{
 for(const situation of ["joined","other invite"]){
  const x=retainedMccAcceptance();x.tick();
  if(situation==="joined")x.peers[0]!.read=async()=>({state:"ready",fleetID:90,memberIDs:[1,2,3]});
  else x.invites.set(2,{fleetID:91,inviterID:4,receivedAtMs:999});
  await x.create().step();assert.deepEqual(x.calls,[]);
 }
});

test("MCC sends one fresh invitation even if the new acceptance also fails and the controller reloads",async()=>{
 const x=retainedMccAcceptance(),assembly=x.create();
 x.tick();await assembly.step();
 x.fail("accept");await assert.rejects(assembly.step(),/lost accept/);
 const resumed=x.create();x.tick();await resumed.step();
 assert.deepEqual(x.calls,["invite:2","accept:2"]);
 assert.deepEqual([...x.members],[1,3]);
 assert.match(resumed.admissionIssue(2)??"",/membership has not been confirmed/);
});

test("MCC reinvites a pilot whose first invite was not observed while the others are admitted",async()=>{
 const x=retainedMccAcceptance("invite"),assembly=x.create();
 x.invites.delete(2);
 await assembly.step();
 assert.deepEqual(x.calls,[]);
 assert.deepEqual(assembly.snapshot().joined,[1,3]);
 x.tick();
 await assembly.step();
 assert.deepEqual(x.calls,["invite:2"]);
 await assembly.step();
 await assembly.step();
 assert.deepEqual(x.calls,["invite:2","accept:2"]);
 assert.deepEqual(assembly.snapshot().joined,[1,3,2]);
});

test("an AcceptInvite refused during undock leaves the matching invitation available for the next pass",async()=>{
 const x=retainedMccAcceptance("invite"),assembly=x.create(),peer=x.peers[1]!;
 x.invites.set(2,{fleetID:90,inviterID:1,receivedAtMs:1000});
 const accept=peer.accept;
 peer.accept=async()=>{throw Object.assign(Error("The undock transition is not ready for another command."),{code:"SESSION_CHANGE_IN_PROGRESS"});};
 const before=assembly.snapshot();
 await assert.rejects(assembly.step(),/undock transition/);
 assert.deepEqual(assembly.snapshot(),before);

 peer.accept=accept;
 await assembly.step();
 assert.deepEqual(x.calls,["accept:2"]);
 assert.deepEqual(assembly.snapshot().joined,[1,3]);
 await assembly.step();
 assert.deepEqual(assembly.snapshot().joined,[1,3,2]);
});

test("a fresh invitation refused during the boss's jump does not spend the fleet retry",async()=>{
 const x=retainedMccAcceptance("invite"),assembly=x.create(),boss=x.peers[0]!,peer=x.peers[1]!;
 x.invites.set(2,{fleetID:90,inviterID:1,receivedAtMs:1000});
 const accept=peer.accept;
 peer.accept=async()=>{throw Object.assign(Error("The undock transition is not ready for another command."),{code:"SESSION_CHANGE_IN_PROGRESS"});};
 await assert.rejects(assembly.step(),/undock transition/);
 peer.accept=accept;

 x.invites.delete(2);
 x.tick();
 const invite=boss.invite;
 boss.invite=async()=>{throw Object.assign(Error("The stargate transition is not ready for another command."),{code:"SESSION_CHANGE_IN_PROGRESS"});};
 await assert.rejects(assembly.step(),/stargate transition/);
 assert.equal(assembly.snapshot().deferred?.[0]?.reinvited,undefined);
 assert.deepEqual(x.calls,[]);

 boss.invite=invite;
 const resumed=x.create();
 x.tick(1500);
 await resumed.step();
 await resumed.step();
 assert.deepEqual(x.calls,["invite:2","accept:2"]);
 assert.deepEqual(resumed.snapshot().joined,[1,3]);
 await resumed.step();
 assert.deepEqual(resumed.snapshot().joined,[1,3,2]);
});

test("the final native refusal is shown for the affected pilot without another write",async()=>{
 const x=retainedMccAcceptance(),assembly=x.create();
 x.peers[0]!.invite=async id=>{
  x.calls.push(`invite:${id}`);
  throw Object.assign(Error("FleetCandidateOffline"),{code:"CALL_REFUSED"});
 };
 x.tick();
 await assert.rejects(assembly.step(),/FleetCandidateOffline/);
 const resumed=x.create();
 x.tick();
 await resumed.step();
 assert.deepEqual(x.calls,["invite:2"]);
 assert.equal(resumed.admissionIssue(2),"Fleet invitation refused: FleetCandidateOffline");
 assert.equal(resumed.admissionIssue(3),null);
 assert.deepEqual(resumed.snapshot().joined,[1,3]);
});
