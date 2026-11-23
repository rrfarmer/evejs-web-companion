/** Strict Security objective reads over the same native journal/briefing wire used by WC74. */
import { unwrapLong, unwrapReal } from "../shared/wire.ts";
import { checkedJournal, conversation } from "../distribution/native.ts";
import { securityContent, type Offer } from "./security.ts";
const seq=(v:any):any[]|null=>Array.isArray(v)?v:(v && (v.type==="list"||v.type==="tuple")&&Array.isArray(v.items)?v.items:null);
const get=(v:any,k:string):any=>{ if(v?.type==="object"&&v.name==="util.KeyVal") v=v.args; if(v?.type!=="dict"||!Array.isArray(v.entries))return undefined; return v.entries.find((x:any)=>Array.isArray(x)&&x[0]===k)?.[1]; };
const num=(v:any):number|null=>{const n=unwrapLong(v);return n!==null&&n>=BigInt(Number.MIN_SAFE_INTEGER)&&n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;};
const number=(v:any):number|null=>unwrapReal(v)??num(v);
export { checkedJournal, conversation };
export function securityObjective(raw:unknown, journal:ReturnType<typeof checkedJournal>, agentID:number,level:number=1): { offer:Offer; position:{x:number;y:number;z:number}; objectiveComplete:boolean; dungeonComplete:boolean } | null {
 if(!journal || journal.active.length+journal.offered.length!==1)return null;
 const row=[...journal.active,...journal.offered][0]!;if(row.agentID!==agentID)return null;
 const content=num(get(raw,"contentID")),state=num(get(raw,"missionState")),objectives=seq(get(raw,"objectives")),dungeons=seq(get(raw,"dungeons")),rewards=seq(get(raw,"normalRewards"));
 if(!content || securityContent(level)?.get(content)===undefined||content!==row.missionID||state!==row.missionState||!objectives||objectives.length!==0||!dungeons||dungeons.length!==1||!rewards)return null;
 const dungeon=dungeons[0], dungeonID=num(get(dungeon,"dungeonID")), optional=get(dungeon,"optional"), restriction=num(get(dungeon,"shipRestrictions")),location=get(dungeon,"location"),coords=seq(get(location,"coords"));
 const x=number(coords?.[0]),y=number(coords?.[1]),z=number(coords?.[2]);
 const system=num(get(location,"solarsystemID")),locationNumber=num(get(location,"locationNumber")),owner=num(get(location,"agentID"));
 const overall=num(get(raw,"completionStatus")), dungeonComplete=num(get(dungeon,"objectiveCompleted"));
 if(dungeonID!==securityContent(level)?.get(content)||optional!==false||(restriction!==null&&restriction!==0)||!system||system<=0||!Number.isSafeInteger(locationNumber)||locationNumber!<0||owner!==agentID||get(location,"locationType")!=="dungeon"||!coords||coords.length!==3||x===null||y===null||z===null||(overall!==0&&overall!==1)||(dungeonComplete!==null&&dungeonComplete!==0&&dungeonComplete!==1))return null;
 let expectedISK=0; for(const reward of rewards){const tuple=seq(reward);if(!tuple||tuple.length<2)return null;const type=num(tuple[0]),amount=number(tuple[1]);if(!type||amount===null||amount<0)return null;if(type===29)expectedISK+=amount;}
 if(!Number.isFinite(expectedISK))return null;
 let key:unknown;try{key=JSON.parse(row.missionKey);}catch{return null;}if(!Array.isArray(key)||key.length!==4||key[0]!==agentID||key[1]!==row.missionID)return null;
 return {offer:{agentID,missionID:row.missionID,titleID:typeof key[2]==="number"?key[2]:null,expirationTime:typeof key[3]==="string"?key[3]:null,key:row.missionKey,status:state===1?"offered":"accepted",contentID:content,dungeonID,dungeonCount:1,otherObjectives:0,shipRestricted:false,destinationSystemID:system,locationNumber:locationNumber!,expectedISK},position:{x,y,z},objectiveComplete:overall===1,dungeonComplete:dungeonComplete===1};
}
/** keeper.GetCurrentDungeonForCharacter tuple; missing values are not a room. */
export function securityDungeon(raw:unknown):{dungeonID:number;roomID:number;instanceID:number}|null{
 const rows=seq(raw),d=num(rows?.[0]),room=num(rows?.[1]),instance=num(rows?.[2]);
 return d!==null&&d>0&&room!==null&&room>=0&&instance!==null&&instance>0?{dungeonID:d,roomID:room,instanceID:instance}:null;
}

/** Choose the existing engine's phase from current native location, not a historical Dock requirement. */
export function securityResumePhase(f:{docked?:boolean;inSpace?:boolean;shipMode?:string;solarSystemID:number},identity:{dungeonID:number;instanceID:number|null;roomID:number|null;destinationSystemID:number},keeper:unknown,tracker:boolean):'COMBAT'|'MISSION_SYSTEM'|null{
 if(f.docked===true)return keeper===null&&!tracker?'MISSION_SYSTEM':null;
 if(f.inSpace!==true||typeof f.shipMode!=='string'||/warp/i.test(f.shipMode))return null;
 if(keeper===null)return tracker?null:'MISSION_SYSTEM';
 const room=securityDungeon(keeper);
 return tracker&&room&&f.solarSystemID===identity.destinationSystemID&&room.dungeonID===identity.dungeonID&&room.instanceID===identity.instanceID&&room.roomID===identity.roomID?'COMBAT':null;
}
