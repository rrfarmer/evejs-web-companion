import type {FleetMoveAuthorization} from './fleetAssembly.ts';
type Fleet={state:'not-in-fleet'}|{state:'ready';fleetID:number;memberIDs:readonly number[]};
type Observation={characterID:number;shipID:number;fleet:Fleet};
const positive=(x:unknown):x is number=>typeof x==='number'&&Number.isSafeInteger(x)&&x>0;
/** Moves only selected pilots; an existing leader fleet with outsiders is never adopted. */
export function planFleetMoves(observations:readonly Observation[],leaderID:number):FleetMoveAuthorization[]{
 if(!Array.isArray(observations)||observations.length<2||!positive(leaderID)||observations.some(x=>!x||!positive(x.characterID)||!positive(x.shipID))||new Set(observations.map(x=>x.characterID)).size!==observations.length||new Set(observations.map(x=>x.shipID)).size!==observations.length)throw Error('Selected fleet pilots are invalid.');
 const selected=new Map(observations.map(x=>[x.characterID,x])),leader=selected.get(leaderID);if(!leader)throw Error('The selected leader is unavailable.');
 for(const x of observations){const f=x.fleet;if(!f||(f.state!=='not-in-fleet'&&f.state!=='ready'))throw Error('Native fleet membership is unavailable. Inspect pilots again.');if(f.state==='ready'&&(!positive(f.fleetID)||!Array.isArray(f.memberIDs)||!f.memberIDs.length||!f.memberIDs.includes(x.characterID)||f.memberIDs.some((id:unknown)=>!positive(id))||new Set(f.memberIDs).size!==f.memberIDs.length))throw Error('Native fleet membership is unreadable.');}
 for(const x of observations){const f=x.fleet;if(f.state==='ready')for(const id of f.memberIDs){const other=selected.get(id);if(!other)continue;const o=other.fleet;if(o.state!=='ready'||o.fleetID!==f.fleetID||JSON.stringify([...o.memberIDs].sort((a,b)=>a-b))!==JSON.stringify([...f.memberIDs].sort((a,b)=>a-b)))throw Error('Native fleet observations disagree. Inspect pilots again.');}}
 const f=leader.fleet,retained=f.state==='ready'&&f.memberIDs.every((id:number)=>selected.has(id))?f.fleetID:null;
 return observations.flatMap(x=>x.fleet.state==='ready'&&x.fleet.fleetID!==retained?[{characterID:x.characterID,shipID:x.shipID,fromFleetID:x.fleet.fleetID}]:[]);
}
