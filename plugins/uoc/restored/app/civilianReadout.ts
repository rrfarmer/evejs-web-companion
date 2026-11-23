import type {ServerBot as NativeBot} from '../../../../web/src/plugin-api/index.ts';
import {miningMissionTitle} from '../nav/miningMissionCatalog.ts';
import type {FoundAgent,ResolvedDestination} from './apiTypes.ts';

const positiveID=(value:unknown):number|null=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:null;
const routeText=/^Flying to (station|structure) (\d+)\.?$/i;
const phaseLabels:Readonly<Record<string,string>>={
 Requesting:'Requesting a mission', Accepting:'Accepting the mission', Approaching:'Approaching mission ore',
 'Entering mission':'Heading to the mission site', Loading:'Collecting mission cargo', Delivering:'Delivering mission cargo',
 Completing:'Submitting the mission to the agent', 'Finding a dock':'Finding a parking location',
};

export function civilianLocations(bot:NativeBot){
 const v=bot.plugin?.readout as any;
 const route=routeText.exec(bot.why??'');
 const routeID=positiveID(v?.travel?.destinationID)??positiveID(Number(route?.[2]));
 const parkingID=positiveID(v?.parking?.destinationID??v?.parking?.stationID);
 const currentID=positiveID(v?.currentLocationID)??(v?.parking?.state==='DOCKED'?parkingID:null);
 const objectiveID=bot.endedAt?null:positiveID(v?.missionDestinationID);
 return {routeID,parkingID,currentID,objectiveID};
}

export function civilianDuration(minutes:number):string|null{
 if(!Number.isFinite(minutes)||minutes<=0)return null;
 const rounded=Math.round(minutes);
 if(rounded===0)return 'Less than a minute';
 if(rounded%60===0){const hours=rounded/60;return `${hours} ${hours===1?'hour':'hours'}`;}
 return `${rounded} ${rounded===1?'minute':'minutes'}`;
}

type CivilianAgent = Pick<FoundAgent,'name'|'corporationName'> & Partial<Pick<FoundAgent,'stationID'|'stationName'|'solarSystemID'|'solarSystemName'>>;
type CivilianLocation={id:number;name:string;systemName:string|null};

function displayLocation(id:number|null,names:ReadonlyMap<number,ResolvedDestination>,agent?:CivilianAgent,
 fallback?:{kind?:string;name?:string|null}):CivilianLocation|null{
 if(id===null)return null;
 const resolved=names.get(id),atAgent=agent?.stationID===id,inAgentSystem=agent?.solarSystemID===id;
 const knownName=atAgent?agent.stationName:inAgentSystem?agent.solarSystemName:null;
 const kind=resolved?.kind??fallback?.kind??(inAgentSystem?'system':atAgent?'station':null);
 const resolvedName=kind==='system'?resolved?.systemName:resolved?.stationName;
 const name=resolvedName&&resolvedName!==`Station ${id}`?resolvedName:fallback?.name??knownName;
 const label=kind==='system'?'System':kind==='structure'?'Structure':kind==='station'?'Station':'Location';
 return {id,name:name||`${label} ${id}`,
  systemName:resolved?.systemName??(atAgent||inAgentSystem?agent?.solarSystemName??null:null)};
}

/** Presentation of native hosted readouts. Ending a host is not a mission or dock receipt. */
export function civilianReadout(bot:NativeBot,agent?:CivilianAgent,custody?:{releaseVerified:boolean;ownerAvailable:boolean;missionUnresolved:boolean},
 names:ReadonlyMap<number,ResolvedDestination>=new Map()) {
 const v=bot.plugin?.readout as any;
 const held=/blocked|unresolved|reconciliation|needs attention/i.test(bot.phase??'');
 const missionUnresolved=held||!!(bot.endedAt||bot.status==='paused')&&(!!v?.pending||v?.legacyCycle||v?.recoveryRequired===true||custody?.missionUnresolved===true);
 const releaseUnconfirmed=!!custody&&!!bot.endedAt&&!custody.releaseVerified;
 const unresolved=missionUnresolved||releaseUnconfirmed;
 const {routeID,parkingID,currentID,objectiveID}=civilianLocations(bot);
 const parkingDestination=displayLocation(parkingID,names,agent,v?.parking);
 const currentLocation=displayLocation(currentID,names,agent);
 const oldRoute=routeText.exec(bot.why??'');
 const traveling=bot.phase==='Traveling'||bot.phase==='Parking';
 const destinationID=traveling?routeID??objectiveID:objectiveID;
 const destination=displayLocation(destinationID,names,agent,
  {kind:oldRoute?.[1]?.toLowerCase()??(destinationID===objectiveID&&bot.plugin?.run==='civilian-mining'?'system':'station')});
 const phase=bot.phase??bot.status;
 const phaseLabel=traveling&&routeID!==null&&destination?
  `${phase==='Parking'?'Parking at':v?.travel?.returning?'Returning to the agent at':'Traveling to'} ${destination.name}`:
  phaseLabels[phase]??phase;
 const maxRuntimeMinutes=Math.max(0,(Date.parse(bot.expiresAt??'')-Date.parse(bot.startedAt))/60000);
 const parkingMode=v?.parkingPolicy?.mode==='selected'?'SELECTED' as const:v?.parkingPolicy?.mode==='nearest'?'NEAREST' as const:undefined;
 const missionName=typeof v?.missionName==='string'?v.missionName:
  bot.plugin?.run==='civilian-mining'&&Number.isSafeInteger(v?.mission)?miningMissionTitle(v.mission):null;
 return {
  civilianOwned:custody?custody.ownerAvailable:!bot.endedAt,
  ownerRelease:custody?.releaseVerified?'VERIFIED':'UNCONFIRMED',
  missionRecovery:v?.missionSettled===true?'Native mission settlement recorded.':unresolved?'Mission/cargo recovery remains unresolved; docking and release do not complete it.':null,
  civilianView:unresolved?'RECOVERY' as const:bot.endedAt?'HISTORY' as const:'CURRENT' as const,
  ...(unresolved?{missionIssue:{state:'RECOVERY_REQUIRED',reason:missionUnresolved?(v?.firstFailure??'The exact mission or cargo state still needs reconciliation.'):'Independent native session/owner release has not been confirmed.'}}:{}),
  ...(typeof v?.firstFailure==='string'&&v.firstFailure?{civilianSafetyReason:v.firstFailure}:{}),
  scriptName:`Civilian ${bot.plugin?.run==='civilian-mining'?'Mining':'Distribution'} · ${agent?.name??'Automatic agent'}`,
  maxRuntimeMinutes,
  civilianPresentation:{phase:phaseLabel,destination,currentLocation,agentSystemName:agent?.solarSystemName??null,
   showDestination:!(traveling&&routeID!==null),runtime:civilianDuration(maxRuntimeMinutes),
   showRelease:!!bot.endedAt||phase==='Parking'||phase==='Docked'||bot.status==='stopped',
   reason:traveling&&oldRoute?null:bot.why??null},
  missionProgress:{agentName:agent?.name??null,corporationName:agent?.corporationName??null,missionName,
   completedCount:Number.isSafeInteger(v?.completedCount)&&v.completedCount>=0?v.completedCount:null},
  lastMissionReward:v?.reward??null,
  ...(parkingMode?{civilianParkingMode:parkingMode}:{}),
  ...(parkingDestination?{parkingDestination}:{}),
  ...(v?.parking?.state==='DOCKED'&&parkingDestination?{
   parking:{phase:custody?.releaseVerified?'PARKED':'RELEASING',reason:custody?.releaseVerified?'Native docking and independent OFF/no-owner release verified.':'Docking observed; native session release has not been independently read back.',dock:{id:parkingDestination.id,kind:v.parking.kind==='structure'?'structure':'station',name:parkingDestination.name}},
  }:{}),
 };
}

/** Older index snapshots are history, not another current mission or proof that its old objective completed. */
export function earlierCivilianSnapshot(row:any,rows:readonly any[]):boolean{return !!row&&row.ownerAvailable!==true&&rows.find(r=>r.characterID===row.characterID&&r.kind===row.kind)?.botID!==row.botID;}
