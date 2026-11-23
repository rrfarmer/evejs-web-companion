import {loadBoundFleet,decodeFleetCenter,authoritativeFleetMemberCharacterIDs} from '../../../web/src/plugin-api/flying.ts';
import type {PluginRunContext} from '../../../web/src/plugin-api/backend.ts';
import type {PilotSession} from '../../../web/src/plugin-api/pilotSession.ts';

export type CombatMember={characterID:number;shipID:number;required?:boolean};
export class RequiredCombatMemberLost extends Error {}
export class CombatRosterChanged extends Error {}
type Doc={read():unknown;write(v:unknown):void};
/** Membership decisions only. Native settlement, Parking and release remain with
 * the original member controller and its journals. Retirement never proves release. */
export function createCombatRoster(members:readonly CombatMember[],ownerID?:number,document?:Doc){
 const retired=new Map<number,{characterID:number;shipID:number;required:boolean;reason:string;observedAt:number}>();
 const save=()=>document?.write({version:1,members:structuredClone(members),retired:[...retired.values()]});
 const required=(id:number)=>id===ownerID||members.find(m=>m.characterID===id)?.required!==false;
 function retire(id:number,reason:string){const m=members.find(m=>m.characterID===id);if(!m)throw Error('Unselected combat member cannot retire.');
  if(!retired.has(id)){retired.set(id,{characterID:id,shipID:m.shipID,required:required(id),reason,observedAt:Date.now()});save();}
  return required(id)?'STOP_OPERATION' as const:'CONTINUE_HEALTHY' as const;
 }
 return {required,retire,active:(id:number)=>members.some(m=>m.characterID===id)&&!retired.has(id),
  members:()=>members.filter(m=>!retired.has(m.characterID)),snapshot:()=>structuredClone([...retired.values()]),
  check(read:(id:number)=>void){const lost=[...retired.values()].find(m=>m.required);if(lost)throw new RequiredCombatMemberLost(`Required pilot ${lost.characterID}: ${lost.reason}`);for(const m of members)if(!retired.has(m.characterID))try{read(m.characterID);}catch(error){const reason=error instanceof Error?error.message:String(error);if(retire(m.characterID,reason)==='STOP_OPERATION')throw new RequiredCombatMemberLost(`Required pilot ${m.characterID}: ${reason}`);}
   if(!members.some(m=>!retired.has(m.characterID)))throw new RequiredCombatMemberLost('No healthy combat participant remains.');}
 };
}

/** After assembly, a retired original pilot may remain in the native fleet.
 * Require agreeing fresh healthy views, every healthy member and no outsider.
 * This read never creates, leaves or moves a fleet. */
export async function verifyCombatFleet(peers:readonly {run:PluginRunContext;session:PilotSession;current():void}[],original:readonly CombatMember[]){
 if(!peers.length)throw Error('No healthy native fleet reader remains.');
 const views=await Promise.all(peers.map(async p=>{p.current();const data=decodeFleetCenter(await loadBoundFleet({...p.session.flow.requestOptions(),baseUrl:p.run.baseUrl,fetch:p.run.fetch}));p.current();const ids=authoritativeFleetMemberCharacterIDs(data),fleetID=Number(data.fleet.initState.value.fleetID);
  if(data.availability!=='ready'||!ids||ids.length!==data.fleet.initState.value.members.length||!Number.isSafeInteger(fleetID)||fleetID<=0||ids.some(id=>!original.some(m=>m.characterID===id))||peers.some(p=>!ids.includes(p.run.characterID)))throw Error('Healthy native combat fleet membership is not verified.');return {fleetID,ids:[...ids].sort((a,b)=>a-b)};}));
 if(views.some(v=>v.fleetID!==views[0]!.fleetID||JSON.stringify(v.ids)!==JSON.stringify(views[0]!.ids)))throw Error('Healthy combat fleet observations disagree.');
 return views[0]!;
}
