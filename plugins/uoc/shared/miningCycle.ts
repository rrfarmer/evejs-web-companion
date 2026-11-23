import {readAfterTimeout} from './progressDeadline.ts';
import type {ModuleObservation} from "./moduleObservation.ts";
/** Observe the original target's live effect through native inactivity; report actual yield, including zero. */
export async function observeMiningCycle(deps:{targetID:number;cycleMs:number;before:number;current:()=>void;module:()=>Promise<ModuleObservation>;
 quantity:()=>Promise<number>;onActive:(observation:ModuleObservation)=>void|Promise<void>;onProgress:(gain:number)=>void;
 wait:(ms:number)=>Promise<void>;now?:()=>number}):Promise<{gain:number;observedAt:number}>{
 const now=deps.now??Date.now;if(!Number.isSafeInteger(deps.targetID)||deps.targetID<=0||!Number.isFinite(deps.cycleMs)||deps.cycleMs<=0||!Number.isSafeInteger(deps.before)||deps.before<0)throw Error("Mining cycle observation scope is invalid.");
 let activeObserved=false,lastProgress=now(),bestGain=0,bestElapsed=-1;const window=deps.cycleMs+60000;
 while(true){deps.current();const observed=await readAfterTimeout(deps.module),gain=(await readAfterTimeout(deps.quantity))-deps.before;deps.current();
  const on=observed.activeTargets.length>0;
  if(observed.activeTargets.some(t=>t.targetID===deps.targetID)){activeObserved=true;await deps.onActive(observed);deps.current();}
  // Native simulation time can advance slower than wall time. Credit actual effect progress only up to its native duration, never a ticking wall clock alone.
  const effect=observed.activeTargets.find(t=>t.targetID===deps.targetID);
  const elapsed=effect?Number((BigInt(observed.timeFiletime)-BigInt(effect.startFiletime))/10000n):-1;
  if(gain>bestGain||effect&&elapsed>bestElapsed&&elapsed>=0&&elapsed<=effect.durationMs){lastProgress=now();bestGain=Math.max(bestGain,gain);bestElapsed=Math.max(bestElapsed,elapsed);}
  deps.onProgress(gain);
  if(activeObserved&&gain>=0&&!on)return {gain,observedAt:now()};
  if(now()-lastProgress>=window)throw Error("The exact Mining cycle remains unresolved with no observable native progress; its original Activate remains pending. Read current module/cargo state or Dock/Stop; do not replay Activate.");
  await deps.wait(2000);
 }
}
