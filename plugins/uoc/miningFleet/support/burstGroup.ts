import type {createNativeBurst} from './native.ts';
import type {BurstObservation} from './controller.ts';
import type {createCommandProof} from '../commandProof.ts';
export type BurstModule={readonly moduleID:number;readonly typeID:number};
export type BurstUnit={readonly moduleID:number;readonly typeID:number;readonly command:ReturnType<typeof createNativeBurst>;readonly proof:ReturnType<typeof createCommandProof>};
export type BurstTickResult={readonly complete:boolean;readonly modules:readonly {moduleID:number;typeID:number;state:'updated'|'waiting';reason:string|null;observation?:BurstObservation}[]};
export type BurstStopResult={readonly complete:boolean;readonly modules:readonly {moduleID:number;typeID:number;state:'inactive'|'waiting';reason:string|null;proofPending:boolean}[]};
const positive=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0;
/** Serializes existing per-module burst and proof controllers; it never dispatches a native action itself. */
export function createBurstGroup(config:{modules:readonly BurstModule[];create:(module:BurstModule)=>BurstUnit;current:()=>void;tick:(unit:BurstUnit,beforeAction:()=>void)=>Promise<BurstObservation|void>;settleProof?:(unit:BurstUnit)=>Promise<void>}){
 if(!Array.isArray(config.modules)||config.modules.some(m=>!m||!positive(m.moduleID)||!positive(m.typeID))||new Set(config.modules.map(m=>m.moduleID)).size!==config.modules.length)throw Error('Burst module identities are invalid.');
 const entries=config.modules.map(m=>{try{const unit=config.create({...m});if(!unit||unit.moduleID!==m.moduleID||unit.typeID!==m.typeID||!unit.command||!unit.proof)throw Error('Burst controller identity changed.');return {module:m,unit,error:null as string|null};}catch(error){config.current();return {module:m,unit:null,error:error instanceof Error?error.message:'Burst controller is unavailable.'};}});
 const proofPending=(unit:BurstUnit)=>{try{return unit.proof.snapshot().pending!==null;}catch{return true;}};
 let stopping=false,tail:Promise<unknown>=Promise.resolve();const serial=<T>(work:()=>Promise<T>):Promise<T>=>{const result=tail.then(work);tail=result.then(()=>undefined,()=>undefined);return result;};
 const beforeAction=()=>{config.current();if(stopping)throw Error('Burst group is stopping before dispatch.');};
 const tick=()=>serial(async():Promise<BurstTickResult>=>{
  beforeAction();
  const modules:BurstTickResult['modules'][number][]=[];
  for(const entry of entries){
   if(stopping)break;
   beforeAction();
   if(!entry.unit){modules.push({...entry.module,state:'waiting',reason:entry.error});continue;}
   const {unit,module}=entry;
   try{
    const observation=await config.tick(unit,beforeAction);
    config.current();
    modules.push({...module,state:'updated',reason:null,...(observation?{observation}:{})});
   }catch(error){
    config.current();
    modules.push({...module,state:'waiting',reason:error instanceof Error?error.message:'Burst update is unresolved.'});
   }
  }
  return {complete:modules.length===entries.length&&modules.every(m=>m.state==='updated'),modules};
 });
 const stop=()=>{stopping=true;return serial(async():Promise<BurstStopResult>=>{config.current();const modules:BurstStopResult['modules'][number][]=[];for(const entry of entries){if(!entry.unit){modules.push({...entry.module,state:'waiting',reason:entry.error,proofPending:true});continue;}const unit=entry.unit;try{config.current();const result=await unit.command.settle();config.current();const after=result?.after,state=unit.command.snapshot();if(!after||after.moduleID!==unit.moduleID||after.typeID!==unit.typeID||after.active!==false||state.pending!==null)throw Error('The exact native burst effect has not settled.');let proofReason:string|null=null;if(proofPending(unit)&&config.settleProof){try{await config.settleProof(unit);config.current();}catch(error){config.current();proofReason=error instanceof Error?error.message:'Burst benefit remains unconfirmed.';}}const pending=proofPending(unit);modules.push({moduleID:unit.moduleID,typeID:unit.typeID,state:'inactive',reason:pending?(proofReason??'Burst benefit remains unconfirmed.'):null,proofPending:pending});}catch(error){config.current();modules.push({moduleID:unit.moduleID,typeID:unit.typeID,state:'waiting',reason:error instanceof Error?error.message:'Native burst settlement is unresolved.',proofPending:proofPending(unit)});}}return {complete:modules.every(m=>m.state==='inactive'),modules};});};
 return {units:()=>entries.flatMap(e=>e.unit?[e.unit]:[]),tick,stop,isStopping:()=>stopping};
}
