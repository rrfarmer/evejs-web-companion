import {decodeSpaceSnapshot} from "../../../web/src/plugin-api/flying.ts";
import {FleetObservationUnavailable} from "./stopSignal.ts";
type Space=ReturnType<typeof decodeSpaceSnapshot>;
type Scope={shipID:number;characterID:number;systemID:number;beltID:number};
const distance=(a:{x:number;y:number;z:number},b:{x:number;y:number;z:number})=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
/** Use the actual belt sphere as a conservative inner bound; never assign a synthetic belt ID. */
export function claimedBeltRocks(space:Space,scope:Scope){
 if(space.stateValid===false||!space.inSpace||space.shipID!==scope.shipID||space.solarSystemID!==scope.systemID||space.ship?.itemID!==scope.shipID||
    (space.ship.characterID!=null&&space.ship.characterID!==scope.characterID)||!space.ship.geometryAvailable||!Number.isFinite(space.sampledAtMs))throw new FleetObservationUnavailable("Fleet mining scene identity is unreadable.");
 const matches=space.entities.filter(e=>e.itemID===scope.beltID),belt=matches[0];
 if(matches.length!==1||!belt||belt.groupID===null||!belt.geometryAvailable||!Number.isFinite(belt.radius)||belt.radius<=0)
  throw new FleetObservationUnavailable("Claimed belt geometry or type is temporarily unreadable.");
 if(belt.groupID!==9)throw Error("The claimed object is not an asteroid belt.");
 if(Math.max(0,distance(space.ship.position,belt.position)-belt.radius-space.ship.radius)>20000)throw Error("Miner has not reached the claimed belt.");
 const others=space.entities.filter(e=>e.groupID===9&&e.itemID!==scope.beltID);
 if(others.some(e=>!e.geometryAvailable||!Number.isFinite(e.radius)||e.radius<=0))throw new FleetObservationUnavailable("Other belt geometry is unreadable.");
 return space.entities.filter(r=>r.categoryID===25&&r.itemID>0&&r.geometryAvailable&&
  (r.beltID===scope.beltID||(r.beltID===null&&distance(r.position,belt.position)<=belt.radius&&!others.some(b=>distance(r.position,b.position)<=b.radius))));
}
