import {decodeFlightStatus,getFlightStatus} from "../../../web/src/plugin-api/flying.ts";
import type {PluginRunContext} from "../../../web/src/plugin-api/backend.ts";
import type {PilotSession} from "../../../web/src/plugin-api/pilotSession.ts";
import type {Target} from "./targetBoard.ts";
import {classifyMiningSite,type MiningSiteFamily} from "./siteClassification.ts";
import {sameSiteClassification,validSavedSiteClassification} from "./siteSelection.ts";
import {decodeSpaceSnapshot} from '../../../web/src/plugin-api/flying.ts';
export type SiteTarget=Extract<Target,{kind:"ORE_ANOMALY"|"ICE"}>;
export interface NativeSite {readonly target:SiteTarget;readonly label:string;readonly scannerKey:number;readonly instanceID:number;readonly archetypeID:27|28;readonly observedAt:number;/** Raw scanner dungeonID; transient Moon aliases are signed and not source template IDs. */readonly sourceDungeonID?:number|null;readonly sourceDungeonNameID?:number;readonly siteFamily?:MiningSiteFamily}
const id=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
function integer(v:any){if(v&&typeof v==="object"&&v.type==="long"&&typeof v.value==="string"&&/^\d+$/.test(v.value))v=Number(v.value);return id(v)?v:null;}
function signedInteger(v:any){if(v&&typeof v==="object"&&v.type==="long"&&typeof v.value==="string"&&/^-?\d+$/.test(v.value))v=Number(v.value);return typeof v==="number"&&Number.isSafeInteger(v)?v:null;}
function dict(v:any){if(!v||v.type!=="dict"||!Array.isArray(v.entries))throw Error("Scanner dictionary is unreadable.");const out=new Map<any,any>();for(const entry of v.entries){if(!Array.isArray(entry)||entry.length!==2||out.has(entry[0]))throw Error("Scanner dictionary is malformed.");out.set(entry[0],entry[1]);}return out;}
function keyval(v:any){if(!v||v.type!=="object"||v.name!=="util.KeyVal")throw Error("Scanner row is unreadable.");const out=dict(v.args);if([...out.keys()].some(k=>typeof k!=="string"))throw Error("Scanner field name is invalid.");return out;}
function real(v:any){const n=v&&typeof v==="object"&&v.type==="real"?v.value:v;return typeof n==="number"&&Number.isFinite(n)?n:null;}
/** Distinguishes a valid four-dictionary empty scan from malformed or unresolved native rows. */
export function decodeNativeSites(value:unknown,systemID:number,observedAt:number):NativeSite[]{
 if(!id(systemID)||!Number.isFinite(observedAt)||observedAt<=0||!Array.isArray(value)||value.length!==4)throw Error("Scanner full state is unreadable.");
 const slots=value.map(dict),result:NativeSite[]=[];
 for(const slot of slots){const keys=new Set<number>();for(const [key,row] of slot){const normalized=integer(key);if(!normalized||keys.has(normalized))throw Error("Scanner site key is invalid or repeated.");keys.add(normalized);keyval(row);}}
 const seenKeys=new Set<number>(),labels=new Set<string>();
 for(const [key,raw] of slots[0]!){const scannerKey=integer(key),f=keyval(raw);if(!scannerKey||seenKeys.has(scannerKey))throw Error("Scanner site key is invalid or repeated.");seenKeys.add(scannerKey);
  const rawArchetype=f.get("archetypeID"),rawStrength=f.get("scanStrengthAttribute"),archetype=integer(rawArchetype),strength=integer(rawStrength);
  if(rawArchetype!=null&&!archetype||rawStrength!=null&&!strength)throw Error("Scanner classification is unreadable.");
  if(archetype!==27&&archetype!==28){if(!archetype&&strength===211)throw Error("Mining site archetype is unreadable.");continue;}
  if(strength!==211)throw Error("Mining site scanner classification is uncertain.");const instance=integer(f.get("instanceID")),label=f.get("targetID"),p=f.get("position"),system=f.get("solarSystemID");
  if(!instance||typeof label!=="string"||!label.trim()||labels.has(label)||!Array.isArray(p)||p.length!==3||p.some(x=>real(x)===null)||(system!==undefined&&integer(system)!==systemID))throw Error("Mining site identity or position is uncertain.");labels.add(label);
  const sourceDungeonID=signedInteger(f.get("dungeonID")),sourceDungeonNameID=sourceDungeonID!==null&&sourceDungeonID<0?integer(f.get("dungeonNameID")):null,siteFamily=classifyMiningSite({systemID,scannerKey,instanceID:instance,archetypeID:archetype,scanStrengthAttribute:strength,dungeonID:sourceDungeonID,dungeonNameID:sourceDungeonNameID});
  const position={x:real(p[0])!,y:real(p[1])!,z:real(p[2])!};const kind=archetype===27?"ORE_ANOMALY" as const:"ICE" as const;
  result.push({scannerKey,instanceID:instance,label,archetypeID:archetype,observedAt,sourceDungeonID,...(sourceDungeonNameID!==null?{sourceDungeonNameID}:{}),siteFamily,target:{kind,systemID,name:label,siteID:scannerKey,instanceID:instance,position}});
 }
 return result;
}
export function selectNativeSite(sites:readonly NativeSite[],family:"ORE_ANOMALY"|"ICE",scannerKey:number):NativeSite{const hits=sites.filter(s=>s.target.kind===family&&s.scannerKey===scannerKey);if(hits.length!==1)throw Error("Selected exact mining site is missing or ambiguous.");return structuredClone(hits[0]!);}
/** Conservative site-grid association: no neighboring mining site or belt may overlap this grid. */
export function claimedSiteRocks(space:ReturnType<typeof decodeSpaceSnapshot>,site:NativeSite,sites:readonly NativeSite[],shipID:number,characterID:number){
 const fresh=selectNativeSite(sites,site.target.kind,site.scannerKey);if(JSON.stringify(fresh.target)!==JSON.stringify(site.target)||fresh.instanceID!==site.instanceID||fresh.label!==site.label||!sameSiteClassification(site,fresh))throw Error('Mining site was replaced.');
 const d=(a:{x:number;y:number;z:number},b:{x:number;y:number;z:number})=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),p=site.target.position;
 if(space.stateValid===false||!space.inSpace||space.shipID!==shipID||space.solarSystemID!==site.target.systemID||space.ship?.itemID!==shipID||(space.ship.characterID!=null&&space.ship.characterID!==characterID)||!space.ship.geometryAvailable||!Number.isFinite(space.sampledAtMs)||d(space.ship.position,p)>=150000)throw Error('Exact site grid is unavailable.');
 // Generated ice is anchored 120 km from an ordinary belt. Its stable public
 // child IDs encode the exact generated anchor; ordinary belt rocks do not.
 const generatedOffset=site.scannerKey-5_100_000_000_000-site.target.systemID*10_000;
 const generatedIce=site.target.kind==='ICE'&&site.archetypeID===28&&site.siteFamily==='ICE'&&typeof site.sourceDungeonID==='number'&&site.sourceDungeonID>0&&validSavedSiteClassification(site)&&Number.isSafeInteger(generatedOffset)&&generatedOffset>=0&&generatedOffset<10_000&&generatedOffset%100===0;
 if(sites.some(s=>s.scannerKey!==site.scannerKey&&d(s.target.position,p)<300000)||!generatedIce&&space.entities.some(e=>e.groupID===9&&(!e.geometryAvailable||d(e.position,p)<=150000+e.radius)))throw Error('Mining site grid overlaps another source.');
 return space.entities.filter(e=>e.categoryID===25&&e.itemID>0&&e.geometryAvailable&&e.beltID===null&&d(e.position,p)<150000&&(!generatedIce||e.itemID>site.scannerKey&&e.itemID<site.scannerKey+100));
}
/** The held session alone supplies both flight identity and the bound system scanner. */
export function createSiteDiscovery(run:Pick<PluginRunContext,"characterID"|"baseUrl"|"fetch">,session:PilotSession,config:{shipID:number;systemID:number;current:()=>void;now?:()=>number}){
 const options={...session.flow.requestOptions(),baseUrl:run.baseUrl,fetch:run.fetch};const now=config.now??Date.now;
 const flight=async()=>{config.current();if(session.store.station.get().online?.characterID!==run.characterID)throw Error("Scanner pilot changed.");const s=decodeFlightStatus((await getFlightStatus(options)).flight);config.current();if(s.shipID!==config.shipID||s.solarSystemID!==config.systemID||(!s.inSpace&&!s.docked))throw Error("Scanner flight scope changed.");return s;};
 return {async read(){const before=await flight();config.current();const raw=await session.flow.flying.bridgeAsk("scanMgr","GetFullState",[]);config.current();const after=await flight();if(before.shipID!==after.shipID||before.solarSystemID!==after.solarSystemID||before.inSpace!==after.inSpace||before.docked!==after.docked||before.stationID!==after.stationID||before.structureID!==after.structureID)throw Error("Scanner scope changed during observation.");return decodeNativeSites(raw,config.systemID,now());}};
}
