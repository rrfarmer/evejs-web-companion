import type {Session} from "../../web/src/plugin-api/index.ts";

/** Finish the existing owner's normal recovery before handing its pilot over. */
export async function prepareHeldPilot(session:Session,characterID:number):Promise<void>{
 const token=session.flow.sessionToken(),generation=session.flow.flying.sessionGeneration();
 const current=()=>{const s=session.store.get();
  if(!token||session.flow.sessionToken()!==token||session.flow.flying.sessionGeneration()!==generation||
   s.session.phase!=="logged-in"||s.character.selectedCharacterID!==characterID||s.station.online?.characterID!==characterID)
   throw Error("The selected pilot session changed before hosted Start.");
 };
 current();await session.flow.retryDroneRecovery();current();session.flow.requireAutomationReady();
}
