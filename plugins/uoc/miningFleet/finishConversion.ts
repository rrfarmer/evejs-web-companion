import type {PluginRunContext} from '../../../web/src/plugin-api/backend.ts';
import type {PilotSession} from '../../../web/src/plugin-api/pilotSession.ts';
import {createCompressionController,type CompressionReceipt} from './support/compressionController.ts';
import type {FleetSetup} from './runtime.ts';
import type {Manifest,Member} from './operation.ts';
import type {SynchronousStore} from './targetBoard.ts';
/** Locate the original COMMAND conversion by its durable launch bot ID. This
 * can only reconcile/return a receipt; it cannot dispatch compression. */
export async function recoverCollectedConversion(run:PluginRunContext,session:PilotSession,setup:FleetSetup,member:Member,oldBotID:string,item:{itemID:number;typeID:number;quantity:number;flagID:number},manifest:Manifest,generation:number,current:()=>void,document:(name:string)=>SynchronousStore):Promise<CompressionReceipt|null>{
 if(member.role!=='COMMAND'||!setup.supportPolicy?.compressCollectedOre||!oldBotID||manifest.operationID!==setup.operationID||manifest.runID!==setup.operationRunID)throw Error('Original collected-conversion authority is unavailable.');
 const doc=document(`mining-fleet-collection-compression:${JSON.stringify([setup.operationID,setup.operationRunID,oldBotID,member.characterID,member.shipID,manifest.containerID,generation,item.itemID])}`);
 if(doc.read()===null)return null;
 const controller=createCompressionController({operationID:setup.operationID,runID:setup.operationRunID,run,session,shipID:member.shipID,systemID:setup.systemID,reconcileSystemID:setup.delivery?.systemID??setup.systemID,document:doc,current,beforeDispatch:()=>{throw Error('FINISH cannot dispatch compression.');},facility:async()=>{throw Error('FINISH cannot acquire a new facility.');}});
 if(controller.snapshot().pending&&!await controller.reconcile())throw Error('Original collected conversion remains unknown; no replay.');
 const matches=controller.snapshot().receipts.filter(r=>r.item.itemID===item.itemID&&r.item.typeID===item.typeID&&r.item.quantity===item.quantity&&r.item.flagID===item.flagID);
 if(matches.length!==1)throw Error('Exact original collected conversion receipt is missing or ambiguous.');return matches[0]!;
}
