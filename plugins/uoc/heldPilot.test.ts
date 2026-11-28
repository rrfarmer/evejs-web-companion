import test from "node:test";
import assert from "node:assert/strict";
import {prepareHeldPilot} from "./heldPilot.ts";

function fixture(){let generation=1,selected=12,ready=false;const calls:string[]=[];
 const session:any={store:{get:()=>({session:{phase:"logged-in"},character:{selectedCharacterID:selected},station:{online:{characterID:selected}}})},
  flow:{sessionToken:()=>"held",flying:{sessionGeneration:()=>generation},retryDroneRecovery:async()=>{calls.push("recovery");ready=true;},requireAutomationReady:()=>{calls.push("ready");if(!ready)throw Error("Recovery remains pending.");}}};
 return {session,calls,change:()=>{generation++;},select:()=>{selected=13;}};
}
test("hosted handoff waits for the selected owner's existing recovery",async()=>{const f=fixture();await prepareHeldPilot(f.session,12);assert.deepEqual(f.calls,["recovery","ready"]);});
test("recovery refusal is retained without allowing hosted Start",async()=>{const f=fixture();f.session.flow.retryDroneRecovery=async()=>{};await assert.rejects(prepareHeldPilot(f.session,12),/pending/);assert.deepEqual(f.calls,["ready"]);});
test("changed owner after recovery cannot continue hosted Start",async()=>{const f=fixture();f.session.flow.retryDroneRecovery=async()=>{f.change();};await assert.rejects(prepareHeldPilot(f.session,12),/session changed/);assert.deepEqual(f.calls,[]);});
test("a different selected character is refused before recovery",async()=>{const f=fixture();f.select();await assert.rejects(prepareHeldPilot(f.session,12),/session changed/);assert.deepEqual(f.calls,[]);});
