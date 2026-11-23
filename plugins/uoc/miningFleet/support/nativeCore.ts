import type {PluginRunContext} from '../../../../web/src/plugin-api/backend.ts';
import type {PilotSession} from '../../../../web/src/plugin-api/pilotSession.ts';
import type {SynchronousStore} from '../targetBoard.ts';
import {createIndustrialCoreObservation} from './industrialObservation.ts';
import {createIndustrialCore} from './industrialCore.ts';

/** Native Core control for the same hosted owner; effect name comes from held dogma metadata. */
export function createNativeIndustrialCore(config:{operationID:string;runID:string;run:PluginRunContext;session:PilotSession;shipID:number;moduleID:number;typeID:number;sessionGeneration:number;document:SynchronousStore;current:()=>void}){
 const {run,session,current}=config;const identity={operationID:config.operationID,runID:config.runID,botID:run.botID,sessionGeneration:config.sessionGeneration,characterID:run.characterID,shipID:config.shipID,moduleID:config.moduleID,typeID:config.typeID};
 const source=createIndustrialCoreObservation({...config,current});let effectName:string|null=null;
 const observe=async()=>{const o=await source.observe();current();if(o.availability==='available')effectName=o.core.effectName;return o;};
 const effect=()=>{current();if(!effectName)throw Error('Core effect identity is unavailable.');return effectName;};
 return {...createIndustrialCore({identity,document:config.document,current,observe,activate:()=>session.flow.flying.bridgeDo('dogmaIM','Activate',[config.moduleID,effect(),null,0]),deactivate:()=>session.flow.flying.bridgeDo('dogmaIM','Deactivate',[config.moduleID,effect()])}),observe};
}
