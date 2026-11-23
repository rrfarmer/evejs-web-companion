import {progressDeadline,routeFlightObservation,travelFacts,readAfterTimeout,transientNativeRead} from './progressDeadline.ts';
import fs from "node:fs";
import { decodeFlightStatus, decodeSpaceSnapshot, getFlightStatus, getSpaceSnapshot } from "../../../web/src/plugin-api/flying.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { readRowField, unwrapLong, unwrapReal, type JsonValue } from "./wire.ts";

/** Reference: CCP public SDE 3396210 npcStations, generated EveJS stations table. */
const SOURCE_SHA256 = "b4c1eacc28f1b020dd74c5cb718509b24299758fc483bd9a6a89d72713cec75f";
type Position = { readonly x: number; readonly y: number; readonly z: number };
import {decodeParkingPolicy,type ParkingPolicy} from "./parkingPolicy.ts";
export {decodeParkingPolicy,type ParkingPolicy} from "./parkingPolicy.ts";
export interface ParkingDestination { readonly destinationID: number; readonly kind: "station" | "structure"; readonly systemID: number }
type Candidate = ParkingDestination & { readonly position: Position | null };
type Run = Pick<PluginRunContext, "baseUrl" | "fetch">;
type Progress = (phase: string, why: string) => void;
export type ParkingOptions={
  expectedShipID?:number;
  observeDockOnly?:boolean;
  beforeDock?:(destination:ParkingDestination)=>void;
  refusedDock?:()=>void;
  observeTravel?:(snapshot:ReturnType<typeof decodeSpaceSnapshot>)=>void;
  now?:()=>number;
  wait?:(ms:number)=>Promise<void>;
};
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const real = (v: unknown): number | null => { const n = unwrapReal(v); return n !== null && Number.isFinite(n) ? n : null; };
const id = (v: unknown): number | null => { const n = unwrapLong(v); if (n === null || n <= 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return null; return Number(n); };
const record = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const fields = (v: unknown): unknown[] | null => { const r = record(v); return r?.type === "dict" && Array.isArray(r.entries) ? r.entries : null; };
const field = (v: unknown, name: string): unknown => { const r = record(v); const d = r?.type === "object" ? r.args : v; const list = fields(d); const found = list?.find(pair => Array.isArray(pair) && pair[0] === name); return Array.isArray(found) ? found[1] : undefined; };
const pt = (x: unknown, y: unknown, z: unknown): Position | null => { const a=real(x), b=real(y), c=real(z); return a === null || b === null || c === null ? null : {x:a,y:b,z:c}; };

/** Access-scoped native directory. Invalid entries make the read unknown, never empty. */
export function parseAccessibleStructures(value: unknown): readonly { id: number; systemID: number }[] {
  const rows = fields(value); if (!rows) throw new Error("Accessible structure directory is unreadable.");
  const result: {id:number;systemID:number}[] = [], seen = new Set<number>();
  for (const pair of rows) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Accessible structure directory is malformed.");
    const structureID = id(pair[0]); if (!structureID || seen.has(structureID)) throw new Error("Accessible structure identity is ambiguous."); seen.add(structureID);
    if (structureID < 1_000_000_000_000) continue; // Native directory also lists NPC stations.
    const systemID = id(field(pair[1], "solarSystemID")); if (!systemID) throw new Error("An accessible structure has no verified system.");
    result.push({ id: structureID, systemID });
  }
  return result;
}
/** Map data: CachedMethodCallResult -> substream -> objectex2 packed rows. */
export function parseStructurePositions(value: unknown, systemID: number): ReadonlyMap<number, Position> {
  let result = record(value);
  const name = typeof result?.name === "string" ? result.name : record(result?.name)?.value;
  if (result?.type === "object" && typeof name === "string" && name.endsWith("objectCaching.CachedMethodCallResult")) {
    const args = result.args; const carrier = Array.isArray(args) ? record(args[1]) : null;
    if (carrier?.type !== "substream") throw new Error("Structure map cache is unreadable."); result = record(carrier.value);
  }
  if (result?.type !== "objectex2" || !Array.isArray(result.list)) throw new Error("Structure map is unreadable.");
  const positions = new Map<number, Position>();
  for (const row of result.list) {
    const structureID = id(readRowField(row, "itemID")), rowSystem = id(readRowField(row, "locationID"));
    const position = pt(readRowField(row, "x"), readRowField(row, "y"), readRowField(row, "z"));
    if (!structureID || !rowSystem || rowSystem !== systemID || !position || positions.has(structureID)) throw new Error("Structure map contains an invalid or duplicate location.");
    positions.set(structureID, position);
  }
  return positions;
}
function npcCatalogue(): readonly Candidate[] {
  const doc = JSON.parse(fs.readFileSync(new URL("./npc-stations-3396210.json", import.meta.url), "utf8")) as {sourceSHA256?:unknown;stations?:unknown};
  if (doc.sourceSHA256 !== SOURCE_SHA256 || !Array.isArray(doc.stations) || doc.stations.length !== 5210) throw new Error("The bundled station reference is invalid.");
  const ids = new Set<number>();
  return doc.stations.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 5 || !positive(row[0]) || !positive(row[1]) || ids.has(row[0])) throw new Error("The bundled station reference is invalid.");
    const position = pt(row[2],row[3],row[4]); if (!position) throw new Error("A bundled station position is invalid."); ids.add(row[0]);
    return { destinationID: row[0], systemID: row[1], position, kind: "station" as const };
  });
}
/** Physical center distance within the same system. All candidates must have comparable positions. */
export function closestInSystem(candidates: readonly Candidate[], ship: Position): Candidate {
  if (!candidates.length || ![ship.x,ship.y,ship.z].every(Number.isFinite) || candidates.some(c => !c.position || ![c.position.x,c.position.y,c.position.z].every(Number.isFinite))) throw new Error("Same-system docking positions are incomplete; nearest is unknown.");
  return [...candidates].sort((a,b) => {
    const distance = (p: Position) => Math.hypot(p.x-ship.x,p.y-ship.y,p.z-ship.z);
    return distance(a.position!) - distance(b.position!) || a.destinationID-b.destinationID;
  })[0]!;
}
export function routeDistances(origin: number, value: unknown): ReadonlyMap<number, number> {
  const graph=record(value), systems=record(graph?.systems); if (!graph || !Array.isArray(graph.edges) || !systems || !Object.hasOwn(systems, String(origin))) throw new Error("The system graph is unreadable.");
  const adjacency = new Map<number,number[]>();
  for (const edge of graph.edges) { if (!Array.isArray(edge) || edge.length < 4 || !edge.slice(0,4).every(positive)) throw new Error("The system graph contains an unreadable edge."); const [a,b]=edge as number[]; const links=adjacency.get(a!) ?? []; links.push(b!); adjacency.set(a!,links); }
  const distances = new Map([[origin,0]]), queue=[origin];
  for (let at=0;at<queue.length;at++) {const from=queue[at]!; for (const next of adjacency.get(from) ?? []) if (!distances.has(next)) { distances.set(next,distances.get(from)!+1); queue.push(next); }}
  return distances;
}
async function get(run: Run, path: string, current: () => void): Promise<Record<string, any>> {
  current(); const response=await run.fetch(`${run.baseUrl}${path}`); current();
  let data: Record<string,any>; try { data=await response.json() as Record<string,any>; } catch { throw new Error(`Parking read ${path} was unreadable.`); }
  current(); if (!response.ok || data.ok === false) throw new Error(`Parking read ${path} failed (${response.status}).`); return data;
}
/** Stop has already fenced productive work and settled all in-flight actions. */
export async function parkWithPolicy(run: Run, session: PilotSession, onProgress: Progress, current: () => void, policy:ParkingPolicy, recovery:ParkingOptions={}): Promise<ParkingDestination> {
  const selected=decodeParkingPolicy(policy);if(!selected)throw new Error("Parking selection is invalid.");
  const flow=session.flow, options={...flow.requestOptions?.(),baseUrl:run.baseUrl,fetch:run.fetch};
  const now=recovery.now??Date.now, wait=recovery.wait??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)));
  const guard=()=>current();
  const status=async()=>{guard();const raw=(await readAfterTimeout(()=>getFlightStatus(options))).flight;const transition=record(record(raw)?.transition);if(transition&&!['requested','accepted','session-changing','ready','failed'].includes(String(transition.phase)))throw Error("Dock transition state is unreadable.");const f=decodeFlightStatus(raw);guard();if(f.inSpace===f.docked||recovery.expectedShipID!==undefined&&f.shipID!==recovery.expectedShipID)throw Error("Held ship or native flight state changed during Parking.");return f;};
  const matchesDock=(f:Awaited<ReturnType<typeof status>>,d:ParkingDestination,shipID:number)=>
    f.shipID===shipID&&f.docked&&!f.inSpace&&f.solarSystemID===d.systemID&&
    (d.kind==="station"?f.stationID:f.structureID)===d.destinationID&&(!f.transition||f.transition.phase==="ready");
  const observeDock=async(d:ParkingDestination,shipID:number,cause:unknown,requireReady=false)=>{
    const until=now()+30000;
    do {
      const f=await status();
      if(f.transition&&f.transition.phase!=="ready")requireReady=true;
      if(matchesDock(f,d,shipID)&&(!requireReady||f.transition?.phase==="ready")){
        onProgress("Docked", `Docking at ${d.destinationID} was observed.`);return d;
      }
      if(f.shipID!==shipID||f.solarSystemID!==d.systemID||
         f.docked&&(f.stationID??f.structureID)!==d.destinationID||f.transition?.phase==="failed")break;
      if(cause!==null&&!transientNativeRead(cause)&&!f.docked&&
         !["requested","accepted","session-changing"].includes(f.transition?.phase??""))break;
      onProgress("Checking original Dock",`Waiting for native docking at ${d.destinationID}. No new Dock order.`);
      await wait(2000);
    }while(now()<until);
    throw Error(`Dock at ${d.destinationID} remains unverified; no Dock replay.${cause instanceof Error?" "+cause.message:""}`,{cause});
  };
  let flight=await status();
  if (!positive(flight.shipID) || !positive(flight.solarSystemID)) throw new Error("Pilot ship or system is unknown; parking remains unresolved.");
  const heldShipID=flight.shipID;
  if(recovery.observeDockOnly){
    if(selected.mode!=="selected")throw Error("Original Dock destination is unavailable.");
    return observeDock(selected,heldShipID,null,!!flight.transition&&flight.transition.phase!=="ready");
  }
  const stableBy=now()+60000;
  while(flight.inSpace&&(flight.shipMode?.toUpperCase()==="WARP"||
       ["requested","accepted","session-changing"].includes(flight.transition?.phase??""))){
    if(now()>=stableBy)throw Error("Original flight or session transition is still in progress. Parking has not sent movement.");
    onProgress("Checking original flight",`Ship ${heldShipID} in system ${flight.solarSystemID}; waiting for a stable flight observation.`);
    await wait(2000);flight=await status();
    if(flight.shipID!==heldShipID)throw Error("The held ship changed during the original flight transition.");
  }
  if(!positive(flight.solarSystemID))throw Error("Pilot system is unknown; parking remains unresolved.");
  if (flight.docked) {
    const target=flight.stationID ?? flight.structureID,shipID=flight.shipID,systemID=flight.solarSystemID,kind=flight.structureID === target ? "structure" : "station";
    if (!positive(target)) throw new Error("Docked location is unknown.");
    if(flight.transition && flight.transition.phase!=="ready"){
      onProgress("Docking", "Waiting for the observed dock transition to settle.");
      const dockReadyBy=now()+30000;
      do { if(now()>=dockReadyBy)throw Error("Native dock is visible, but its session transition has not settled.");
        await wait(2000);flight=await status();
        if(flight.shipID!==shipID||flight.solarSystemID!==systemID||!flight.docked||(flight.stationID??flight.structureID)!==target)throw Error("Docked pilot, ship or location changed during transition.");
      } while(!flight.transition||flight.transition.phase!=="ready");
    }
    if(selected.mode==="nearest" || (selected.destinationID===target&&selected.systemID===systemID&&selected.kind===kind))return {destinationID:target,systemID,kind};
  }
  if (!flight.inSpace && !flight.docked) throw new Error("The pilot is not verifiably in space or docked.");
  const origin=flight.solarSystemID, shipID=flight.shipID, wasDocked=flight.docked, originDock=flight.stationID??flight.structureID;
  let destination: Candidate;
  if(selected.mode==="selected"){
    destination={...selected,position:null};
    if(destination.kind==="structure"){guard();const structures=parseAccessibleStructures(await flow.flying.bridgeAsk("structureDirectory","GetMyCharacterStructures",[]));guard();
      if(!structures.some(s=>s.id===destination.destinationID&&s.systemID===destination.systemID))throw new Error("Selected structure is not in the pilot's accessible directory.");}
    if(origin!==destination.systemID){const graph=await get(run,"/api/map/graph",guard);if(!routeDistances(origin,graph).has(destination.systemID))throw new Error("Selected destination has no verified route.");}
  }else{
  onProgress("Finding a dock", "Checking current-system stations and the pilot's accessible structures.");
  guard(); const accessible=parseAccessibleStructures(await flow.flying.bridgeAsk("structureDirectory","GetMyCharacterStructures",[])); guard();
  const catalogue=npcCatalogue(), localNpc=catalogue.filter(c=>c.systemID===origin), localStructures=accessible.filter(c=>c.systemID===origin);
  const localList=await get(run,`/api/map/system-stations/${origin}`,guard);
  if (!Array.isArray(localList.stations) || localList.stations.some((s:unknown)=>!positive(record(s)?.stationID))) throw new Error("Current-system station catalogue is unreadable.");
  const actualIDs=localList.stations.map((s:{stationID:number})=>s.stationID).sort((a:number,b:number)=>a-b), assetIDs=localNpc.map(s=>s.destinationID).sort((a,b)=>a-b);
  if (JSON.stringify(actualIDs)!==JSON.stringify(assetIDs)) throw new Error("Station reference differs from this world; nearest cannot be verified.");
  const allLocal: Candidate[]=[...localNpc];
  if (localStructures.length) {
    guard(); const positions=parseStructurePositions(await flow.flying.bridgeAsk("structureDirectory","GetStructureMapData",[origin]),origin); guard();
    for (const s of localStructures) { const position=positions.get(s.id); if (!position) throw new Error("An accessible structure has no confirmed map position."); allLocal.push({destinationID:s.id,systemID:origin,kind:"structure",position}); }
  }
  if (allLocal.length) {
    guard(); const space=await getSpaceSnapshot(options).then(r=>decodeSpaceSnapshot(r.space)).catch(()=>null); guard();
    if (!space || space.stateValid === false || !space.inSpace || space.shipID!==shipID || space.solarSystemID!==origin || space.ship?.itemID!==shipID || space.ship.geometryAvailable!==true || !space.ship.position) throw new Error("Current ship coordinates are unavailable; physical nearest cannot be established.");
    destination=closestInSystem(allLocal,space.ship.position);
  } else {
    const graph=await get(run,"/api/map/graph",guard), distances=routeDistances(origin,graph);
    const candidates: Candidate[]=[...catalogue,...accessible.map(s=>({destinationID:s.id,systemID:s.systemID,kind:"structure" as const,position:null}))].filter(c=>distances.has(c.systemID));
    candidates.sort((a,b)=>distances.get(a.systemID)!-distances.get(b.systemID)! || a.destinationID-b.destinationID);
    if (!candidates.length) throw new Error("No reachable dock was found; parking remains unresolved.");
    destination=candidates[0]!;
    onProgress("Finding a dock", `No dock is available in this system; choosing a reachable dock at ${distances.get(destination.systemID)} jumps (ties by ID).`);
  }
  }
  if (destination.kind === "station") {
    const known=await get(run,`/api/map/station/${destination.destinationID}`,guard);
    const resolved=await get(run,`/api/map/resolve/${destination.destinationID}`,guard);
    if (Number(known.station?.stationID)!==destination.destinationID || resolved.kind!=="station" || Number(resolved.stationID)!==destination.destinationID || Number(resolved.solarSystemID)!==destination.systemID) throw new Error("Chosen station identity could not be verified.");
  } else {
    const known=await get(run,`/api/dockable-structures/${destination.destinationID}`,guard);
    if (Number(known.location?.id)!==destination.destinationID || Number(known.location?.solarSystemID)!==destination.systemID) throw new Error("Structure docking access could not be verified.");
  }
  // Recheck exact origin/ship just before native routing: selection must not outlive the scene.
  flight=await status(); if (flight.shipID!==shipID || flight.solarSystemID!==origin || flight.docked!==wasDocked || (!flight.docked&&!flight.inSpace)) throw new Error("Pilot location changed before parking; resolve the dock again.");
  onProgress("Parking", `Flying to ${destination.kind} ${destination.destinationID}.`);
  let dockRefusals=0, replans=0;
  const replan=async(error:unknown)=>{
    if(replans>=2||!transientNativeRead(error))throw error;
    await wait(2000*(++replans));const fresh=await status();
    if(matchesDock(fresh,destination,shipID))return false;
    if(fresh.shipID!==shipID||fresh.inSpace===fresh.docked||
       fresh.docked&&(!wasDocked||(fresh.stationID??fresh.structureID)!==originDock)||
       fresh.shipMode?.toUpperCase()==="WARP"||
       fresh.transition&&fresh.transition.phase!=="ready"&&fresh.transition.phase!=="failed")throw error;
    flow.flying.abortAutopilot();guard();
    onProgress("Retrying parking route",`Verified ship ${shipID} in system ${fresh.solarSystemID}; replanning to ${destination.destinationID}.`);
    return true;
  };
  const begin=async()=>{
    while(true){
      try {
        guard(); const route=await flow.startRoute(destination.destinationID); guard();
        if(!route.started){
          const cause=route.cause as {code?:unknown;status?:unknown}|null;
          throw Object.assign(Error(`Parking route refused: ${route.reason}`,{cause}),{code:cause?.code,status:cause?.status});
        }
        return;
      }catch(error){if(!await replan(error))return;}
    }
  };
  try {
    await begin();
    const progressing=progressDeadline(3_600_000,now),observe=routeFlightObservation(session,shipID);
    let lastPosition:unknown;
    while (true) {
      guard();
      const progress=flow.flying.autopilotProgress(),{flight:observed,read}=observe(progress);
      const verify=read||observed&&(observed.inSpace===observed.docked||observed.solarSystemID!==flight.solarSystemID||
        observed.docked&&(!wasDocked||(observed.stationID??observed.structureID)!==originDock));
      if(verify)flight=await status();
      else if(observed)flight=observed;
      if (flight.shipID!==shipID) throw new Error("The active ship changed during parking.");
      const routeStopped=progress?.status==="error"||progress?.status==="paused"||progress?.status==="aborted";
      if (flight.docked) {
        const actual=flight.stationID ?? flight.structureID;
        if(actual===destination.destinationID&&flight.solarSystemID===destination.systemID){
          if(!matchesDock(flight,destination,shipID))return await observeDock(destination,shipID,null,!!flight.transition);
          onProgress("Docked", `Docking at ${destination.destinationID} was observed.`);
          return {destinationID:destination.destinationID,kind:destination.kind,systemID:destination.systemID};
        }
        if(!wasDocked||actual!==originDock||flight.solarSystemID!==origin)
          throw new Error("Pilot docked somewhere other than the chosen destination.");
        if(routeStopped)throw new Error(`Parking route stopped: ${progress.failureReason??progress.status}`);
      }
      if (routeStopped){
        const reason=progress.failureReason??progress.status;
        // Autopilot bounds native movement refusals itself. Only a transport
        // read failure permits a replan, never a manual pause or spent warp budget.
        const error=Object.assign(Error(`Parking route stopped: ${reason}`),{
          code:/Could not read flight status after .*?(?:timeout|timed out|unreachable|network)/i.test(reason)?"TRANSPORT":null,
        });
        if(await replan(error))await begin();
        continue;
      }
      if (progress?.status === "arrived" && flight.solarSystemID===destination.systemID && flight.inSpace &&
          (dockRefusals===0||flight.transition?.phase==="ready")) {
        guard();recovery.beforeDock?.(destination);
        try { await flow.flying.dockStep(destination.destinationID); guard(); }
        catch(error){
          guard();
          if((error as {code?:unknown}|null)?.code!=="SESSION_CHANGE_IN_PROGRESS")
            return await observeDock(destination,shipID,error);
          recovery.refusedDock?.();
          if(++dockRefusals>=3)return await observeDock(destination,shipID,error);
          // A pre-dispatch refusal allows another attempt after fresh flight.
          await wait(2000);continue;
        }
        return await observeDock(destination,shipID,null);
      }
      const snapshot=flight.inSpace?session.store?.space?.get().snapshot:null;
      if(snapshot?.inSpace&&snapshot.stateValid!==false&&snapshot.solarSystemID===flight.solarSystemID&&
        snapshot.ship?.itemID===shipID&&snapshot.ship.geometryAvailable){
        lastPosition=snapshot.ship.position;
        recovery.observeTravel?.(snapshot);
      }
      if(!progressing(travelFacts(flight,progress,lastPosition)))throw Error("Parking made no observable native progress; review or Stop the current route.");
      await wait(2000);
    }
  } catch (error) { flow.flying.abortAutopilot(); throw error; }
}

/** Backward-compatible nearest-at-stop entry point. */
export function parkNearest(run:Run,session:PilotSession,onProgress:Progress,current:()=>void):Promise<ParkingDestination>{
 return parkWithPolicy(run,session,onProgress,current,{mode:"nearest"});
}
