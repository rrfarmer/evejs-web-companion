import test from 'node:test';import assert from 'node:assert/strict';
import {civilianDuration,civilianReadout} from './civilianReadout.ts';
import type {ResolvedDestination} from './apiTypes.ts';
const bot=(readout:any={},extra:any={})=>({botID:'held',characterID:3,startedAt:'2026-11-08T10:00:00Z',expiresAt:'2026-11-08T11:00:00Z',endedAt:null,phase:'Mining',kind:'plugin',plugin:{pluginID:'uoc',run:'civilian-mining',readout},...extra}) as any;
test('unknown parking is not silently nearest and absence of a mission is not success',()=>{const r=civilianReadout(bot());assert.equal(r.civilianParkingMode,undefined);assert.equal(r.missionProgress.completedCount,null);assert.equal(r.missionProgress.missionName,null);assert.equal(r.civilianView,'CURRENT');});
test('ended unresolved action stays in Recovery and native dock is not release proof',()=>{const r=civilianReadout(bot({pending:'COMPLETE',completedCount:0,parking:{state:'DOCKED',stationID:9,release:'PENDING_CORE'}},{endedAt:'2026-11-08T10:30:00Z',phase:'Docked'}));assert.equal(r.civilianView,'RECOVERY');assert.equal(r.parking?.phase,'RELEASING');assert.equal(r.civilianOwned,false);assert.equal(r.missionProgress.completedCount,0);});
test('confirmed native count/reward survive History and policy comes from the run',()=>{const reward={confirmedIsk:'0.00',withheldIsk:'250000.00'};const r=civilianReadout(bot({completedCount:2,mission:4813,reward,parkingPolicy:{mode:'selected'}},{endedAt:'2026-11-08T10:30:00Z',phase:'Completed'}),{name:'Fixture Agent',corporationName:'Fixture Corp'});assert.equal(r.civilianView,'HISTORY');assert.equal(r.missionProgress.completedCount,2);assert.ok(r.missionProgress.missionName);assert.equal(r.lastMissionReward,reward);assert.equal(r.civilianParkingMode,'SELECTED');});

test('retains original failure and exact Upwell dock without asserting release',()=>{const r=civilianReadout(bot({firstFailure:'transfer uncertain',parking:{state:'DOCKED',destinationID:9,kind:'structure'}},{endedAt:'2026-11-08T10:30:00Z',phase:'Docked',why:'dock verified'}));assert.equal(r.civilianSafetyReason,'transfer uncertain');assert.equal(r.parking?.dock.kind,'structure');assert.equal(r.parking?.phase,'RELEASING');});


test('a superseded unresolved snapshot is historical rather than a second current recovery, without claiming old completion',async()=>{const {earlierCivilianSnapshot}=await import('./civilianReadout.ts');const old={characterID:7,kind:'mining',botID:'old',resolved:false,ownerAvailable:false},latest={...old,botID:'new',resolved:true};assert.equal(earlierCivilianSnapshot(old,[latest,old]),true);assert.equal(old.resolved,false);assert.equal(earlierCivilianSnapshot(latest,[latest,old]),false);assert.equal(earlierCivilianSnapshot({...old,ownerAvailable:true},[latest,old]),false);assert.equal(earlierCivilianSnapshot(old,[{...latest,kind:'distribution'},old]),false);});

test('travel names use resolved native destinations, preserve agent and last known system, and hide release while running',()=>{
 const locations=new Map<number,ResolvedDestination>([
  [60007804,{id:60007804,kind:'station',stationID:60007804,stationName:'Resolved station',systemName:'Destination system',solarSystemID:30001,lookupFailed:false,stationTypeID:1}],
  [30002,{id:30002,kind:'system',stationID:null,stationName:null,systemName:'Origin system',solarSystemID:30002,lookupFailed:false,stationTypeID:null}],
 ]);
 const agent={name:'Fixture agent',stationID:60007804,stationName:'Saved station',solarSystemName:'Destination system'};
 const active=bot({currentLocationID:30002,travel:{destinationID:60007804,returning:true}},
  {phase:'Traveling',why:'Flying to station 60007804.',expiresAt:'2026-11-09T09:59:59.970Z'});
 const row=civilianReadout(active,agent,undefined,locations).civilianPresentation;
 assert.equal(row.phase,'Returning to the agent at Resolved station');
 assert.equal(row.currentLocation?.name,'Origin system');
 assert.equal(row.agentSystemName,'Destination system');
 assert.equal(row.runtime,'24 hours');
 assert.equal(row.reason,null);
 assert.equal(row.showRelease,false);
 assert.equal(civilianDuration(60),'1 hour');
 assert.equal(civilianDuration(85),'85 minutes');
 const parked=civilianReadout(bot({parking:{state:'DOCKED',destinationID:60007804,kind:'station'}},
  {phase:'Docked',endedAt:'2026-11-08T11:00:00Z'}),agent,undefined,locations);
 assert.equal(parked.civilianPresentation.showRelease,true);
 assert.equal(parked.parking?.dock.name,'Resolved station');
});

test('legacy travel uses a known station name or the actual ID, and preserves non-travel reasons',()=>{
 const legacy=bot({},{phase:'Traveling',why:'Flying to station 60007303.'});
 assert.equal(civilianReadout(legacy,{name:'Agent',stationID:60007303,stationName:'Known station'}).civilianPresentation.phase,
  'Traveling to Known station');
 assert.equal(civilianReadout(legacy).civilianPresentation.phase,'Traveling to Station 60007303');
 assert.equal(civilianReadout(bot({},{phase:'Mining',why:'Native ore yield observed.'})).civilianPresentation.reason,'Native ore yield observed.');
});
