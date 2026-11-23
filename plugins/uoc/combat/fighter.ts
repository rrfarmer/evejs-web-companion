import type { Identity } from './security.ts';

export interface FighterDrone { itemID:number; controlled:boolean; targetID:number|null; shieldRatio:number|null; armorRatio:number|null; hullRatio:number|null }
export interface FighterTarget { itemID:number; shieldRatio:number|null; armorRatio:number|null; hullRatio:number|null; engageable?:boolean; inRange?:boolean; droneInRange?:boolean; priority?:number }
export interface FighterFrame { bay:readonly {itemID:number;quantity:number}[]; combatBay:readonly number[]; drones:readonly FighterDrone[]; combatOut:readonly number[]; targets:readonly FighterTarget[]; weaponIDs?:readonly number[]; canPrepareLock?:boolean; weaponRevision?:number; supportCapable?:boolean; droneLaunch?:readonly {itemID:number;quantity:number}[]; dronesDeploying?:boolean; droneWarning?:string; capabilitiesPending?:boolean }
type DefenderReadiness="approaching"|"waiting-lock"|"not-dispatched"|"target-absent"|"ready";
export interface FighterHooks<I = Identity> {
 read(identity:I):Promise<FighterFrame>;
 refreshTargets?(identity:I,lostTarget:number):Promise<FighterFrame|null>;
 launch(stacks:readonly {itemID:number;quantity:number}[],context?:{targetID:number;selected:boolean}):Promise<void|string>;
 readLaunchedDrones?():Promise<readonly FighterDrone[]>;
 engage(ids:readonly number[],target:number,dispatched?:()=>void):Promise<void|"target-absent"|"not-dispatched"|"unavailable"|"pending">;
 engageWeapons?(ids:readonly number[],target:number):Promise<void|"target-absent"|"waiting-lock"|"unavailable"|"settling">;
 canReacquire?(target:number):Promise<boolean>;
 targetChanged?(prior:number,next:number|null):void;
 targetSelected?(targetID:number):void;
 weaponFitPending?(targetID:number):void;
 weaponsActive?(ids:readonly number[],target:number):Promise<boolean>;
 prepareTarget?(target:number,frame:FighterFrame):Promise<DefenderReadiness>;
 settle(regrouping?:boolean):Promise<void>;
 now():number;
}
/** One engagement per target; uncertain dispatch is never repeated. All reads and writes are held-session scoped. */
export function createSecurityFighter<I = Identity>(h:FighterHooks<I>) {
 let target:number|null=null, damageAt=0, bestHealth:number|null=null, launched=false, dirty=false,engagedRevision=0,waitingForLock=false;const retiredTargets=new Set<number>(),unavailableSince=new Map<number,number>();
 let droneOrderedFor:number|null=null,droneRetryAt=0;
 const hp=(x:{shieldRatio:number|null;armorRatio:number|null;hullRatio:number|null})=>[x.shieldRatio,x.armorRatio,x.hullRatio].every(v=>v!==null)?x.shieldRatio!+x.armorRatio!+x.hullRatio!:null;
 function checkDrones(drones:readonly FighterDrone[]){
  if(drones.some(d=>!d.controlled))throw Error('Uncontrolled drone in Security flight; reconciliation required.');
  if(drones.some(d=>hp(d)!==null&&(d.armorRatio!<0.5||d.hullRatio!<0.99)))throw Error('A Security drone is damaged; recalling before parking.');
 }
 const dropTarget=(next:number|null)=>{
  if(target!==null){
   if(!h.prepareTarget)retiredTargets.add(target);
   h.targetChanged?.(target,next);
  }
  target=null;bestHealth=null;waitingForLock=false;droneOrderedFor=null;droneRetryAt=0;
 };
 return {
  async tick(id:I,assertCurrent:()=>void) {
   const f=await h.read(id); assertCurrent();
   checkDrones(f.drones);
   if(!h.prepareTarget&&f.targets.some(x=>retiredTargets.has(x.itemID)))throw new Error('A retired Security target reappeared; reconciliation required.');
   if(target!==null){
    const current=f.targets.find(x=>x.itemID===target),preferred=f.targets.find(x=>x.engageable===true);
    const health=current?hp(current):null;
    const productive=health!==null&&bestHealth!==null&&health<bestHealth-0.001;
    const fallback=h.prepareTarget&&current&&preferred&&preferred.itemID!==target&&
     (current.engageable===false&&(!productive||current.inRange===false)||((preferred.priority??0)>=2&&(preferred.priority??0)>(current.priority??0)&&!productive));
    if(!current||fallback)dropTarget(preferred?.itemID??null);
   }
   if(!f.combatOut.length){
    if(launched&&!f.dronesDeploying){
     if(!h.canReacquire)throw Error('Security combat drones did not launch or were lost.');
     launched=false;target=null;bestHealth=null;waitingForLock=false;
    }
    let launchWarning=f.droneWarning;
    let deploying=f.dronesDeploying===true;
    const stacks=f.droneLaunch??f.bay.filter(x=>f.combatBay.includes(x.itemID));
    if(stacks.length){
     dirty=true;assertCurrent();
     const launchFlight=()=>{
      const contextTargetID=target??f.targets[0]?.itemID;
      return h.launch(stacks,contextTargetID===undefined?undefined:{targetID:contextTargetID,selected:target!==null});
     };
     const readLaunchedDrones=h.readLaunchedDrones;
     if(readLaunchedDrones&&f.targets.length)return attackTargets(async()=>{
      const outcome=await launchFlight();
      if(typeof outcome==="string")return [];
      launched=true;
      const drones=await readLaunchedDrones();
      checkDrones(drones);
      return drones.map(drone=>drone.itemID);
     });
     if(h.prepareTarget&&(f.weaponIDs?.length||f.canPrepareLock)&&f.targets.length){
      const [attack,launch]=await Promise.allSettled([attackTargets(),launchFlight()]);
      if(launch.status==="fulfilled"&&typeof launch.value!=="string")launched=true;
      if(attack.status==="rejected")throw attack.reason;
      if(launch.status==="rejected")throw launch.reason;
      return attack.value;
     }
     const outcome=await launchFlight();
     if(typeof outcome!=="string"){launched=true;deploying=true;}
     else launchWarning=outcome;
    }
    if(h.prepareTarget&&f.canPrepareLock&&f.targets.length)return attackTargets();
    if(deploying&&(!h.prepareTarget||!f.weaponIDs?.length))return "deploying" as const;
    if(!f.weaponIDs?.length&&f.supportCapable){dirty=true;return;}
    if(f.capabilitiesPending&&!f.weaponIDs?.length)return "combat-wait" as const;
    if(!f.weaponIDs?.length||!h.engageWeapons||!h.weaponsActive)throw Error(launchWarning??'No classified combat drones or verified weapons are available.');
   }
   return attackTargets();
   async function attackTargets(launchAndObserve?:()=>Promise<readonly number[]>){
    let frame=f;
    let next=frame.targets[0];
    for(let attempt=0;attempt<2;attempt++){
     const f=frame;
     const newTarget=target===null;
     if(newTarget){
      if(!next)return;
      target=next.itemID;bestHealth=hp(next);damageAt=h.now();dirty=true;
      h.targetSelected?.(target);
     }
     const selected=target!;
     const row=f.targets.find(x=>x.itemID===selected)!;
     const dronesActive=f.combatOut.some(id=>f.drones.some(d=>d.itemID===id&&d.targetID===selected));
     const launch=attempt===0?launchAndObserve:undefined;
     const needDroneOrder=!!launch||f.combatOut.length>0&&(h.prepareTarget?
      !dronesActive&&droneOrderedFor!==selected&&h.now()>=droneRetryAt&&row.droneInRange!==false:
      newTarget&&(!dronesActive||!h.canReacquire));
     const useWeapons=async()=>{
      if(h.prepareTarget&&!f.canPrepareLock&&!f.weaponIDs?.length&&(f.capabilitiesPending||launch)){
       if(f.capabilitiesPending){h.weaponFitPending?.(selected);waitingForLock=true;}
       return {readiness:"ready" as const,needsWeapons:false,weapons:undefined};
      }
      const readiness=h.prepareTarget?await h.prepareTarget(selected,f):"ready";
      assertCurrent();
      const needsWeapons=readiness==="ready"&&(newTarget||waitingForLock||(f.weaponRevision??0)>engagedRevision)&&!!f.weaponIDs?.length;
      if(h.prepareTarget)waitingForLock=readiness!=="ready";
      if(!needsWeapons)return {readiness,needsWeapons,weapons:undefined};
      if(!h.engageWeapons||!h.weaponsActive)throw Error('Weapon effect authority is unavailable.');
      return {readiness,needsWeapons,weapons:await h.engageWeapons(f.weaponIDs!,selected)};
     };
     const useDrones=async()=>{
      const ids=launch?await launch():f.combatOut;
      if(!ids.length)return "not-dispatched" as const;
      assertCurrent();
      return h.engage(ids,selected,h.prepareTarget?()=>{droneOrderedFor=selected;}:undefined);
     };
     let attack:Awaited<ReturnType<typeof useWeapons>>;
     let drones:Awaited<ReturnType<typeof h.engage>>=undefined;
     if(h.prepareTarget&&needDroneOrder){
      // CmdEngage can run while the ship is still acquiring the gun's lock.
      const [weaponResult,droneResult]=await Promise.allSettled([useWeapons(),useDrones()]);
      if(weaponResult.status==="rejected")throw weaponResult.reason;
      if(droneResult.status==="rejected")throw droneResult.reason;
      attack=weaponResult.value;drones=droneResult.value;
     }else{
      attack=await useWeapons();
      if(needDroneOrder&&attack.weapons!=="target-absent")drones=await useDrones();
     }
     assertCurrent();
     const {readiness,needsWeapons,weapons}=attack;
      const targetLost=readiness==="target-absent"||weapons==="target-absent"||drones==="target-absent";
      if(targetLost||readiness==="not-dispatched"){
       if(targetLost&&attempt===0&&h.refreshTargets){
        // The original list can lose several targets while a call is pending.
        const fresh=await h.refreshTargets(id,selected);assertCurrent();
        if(!fresh){dropTarget(null);return "combat-wait" as const;}
        checkDrones(fresh.drones);
        frame=fresh;
       }
       next=h.prepareTarget&&attempt===0?frame.targets.find(row=>row.itemID!==selected):undefined;
       dropTarget(next?.itemID??null);
       continue;
      }
     const weaponConfirmed=needsWeapons&&weapons===undefined;
     if(needsWeapons){
      engagedRevision=(f.weaponRevision??0)-(weapons==="settling"?1:0);
      waitingForLock=weapons==="waiting-lock";
     }
     if(needDroneOrder&&drones==='not-dispatched'){
      if(!h.prepareTarget){
       const first=unavailableSince.get(selected)??h.now();unavailableSince.set(selected,first);
       if(h.now()-first>=90000)throw Error('Security target remained unavailable before dispatch.');
       target=null;bestHealth=null;return;
      }
     }else if(needDroneOrder){
      unavailableSince.delete(selected);
      if(drones==="pending"){
       droneOrderedFor=selected;
       if(weaponConfirmed)return "engaged" as const;
       return readiness==="approaching"||readiness==="waiting-lock"?readiness:"combat-wait" as const;
      }
      if(drones!=='unavailable'){if(h.prepareTarget)droneOrderedFor=selected;return "engaged" as const;}
      if(h.prepareTarget){droneOrderedFor=null;droneRetryAt=h.now()+5000;}
      else if(!f.weaponIDs?.length)throw Error('That target cannot be engaged by drones, and no weapons are available.');
     }
     if(weaponConfirmed)return "engaged" as const;
     if(readiness!=="ready"&&!dronesActive)return readiness;
     if(launch&&launched&&drones==="not-dispatched"&&!f.weaponIDs?.length)return "deploying" as const;
     if(waitingForLock&&!dronesActive)return "waiting-lock" as const;
     const nextHealth=hp(row);
     if(bestHealth===null&&nextHealth!==null)bestHealth=nextHealth;
     else if(bestHealth!==null&&nextHealth!==null&&nextHealth<bestHealth-0.001){bestHealth=nextHealth;damageAt=h.now();}
     const weaponsActive=!(h.prepareTarget&&dronesActive)&&!!f.weaponIDs?.length&&!!h.weaponsActive&&await h.weaponsActive(f.weaponIDs,selected);assertCurrent();
     if(!dronesActive&&!weaponsActive){
      if(h.prepareTarget)return "combat-wait" as const;
      if(h.canReacquire&&await h.canReacquire(selected)){
       waitingForLock=true;droneOrderedFor=null;return "waiting-lock" as const;
      }
      throw Error('Combat engagement is no longer observable; no order is replayed.');
     }
     if(h.now()-damageAt>90000){
      if(!h.prepareTarget)throw Error('Security target did not take observable damage in time.');
      if(nextHealth!==null)return "combat-wait" as const;
     }
     return "engaged" as const;
    }
   }
  },
  async settle(assertCurrent:()=>void,regrouping=false){assertCurrent();await h.settle(regrouping);dirty=false;
   if(regrouping&&h.prepareTarget){dropTarget(null);return;}
   target=null;bestHealth=null;launched=false;waitingForLock=false;droneOrderedFor=null;droneRetryAt=0;},
  get dirty(){return dirty;}
 };
}
