import test from "node:test";
import assert from "node:assert/strict";
import { decodeFleetCenter, decodeFleetInviteNotification } from "../bridge/fleetCenter.ts";
import type { JsonValue } from "../bridge/wire.ts";
import type { BotScript, MacroStep } from "../bots/botScript.ts";
import { decodeScriptValue } from "../bots/scriptCodec.ts";
import { analyzeBotRunPolicy } from "../bots/runPolicy.ts";
import { stepSentence, macroName } from "../bots/scriptText.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { MiningSupportFleetObservation } from "./miningSupportFleet.ts";
const S = 140000005, A = 140000002, F = 999000001, now = 100;
const step: MacroStep = { id: "join", kind: "macro", macro: "join-support-fleet", args: { support: { kind: "character", charID: S, name: "Support" } } };
const doc: BotScript = { format: "evejs-bot-script", version: 1, name: "Join support", notes: "", home: { entity: "station", id: 60003760, name: "Home", systemName: "Jita" }, interrupts: [], program: [step] };
const kv = (entries: [string | number, JsonValue][]): JsonValue => ({ type: "object", name: "util.KeyVal", args: { type: "dict", entries } });
function fleet(characterID: number, fleetID: number | null, roster = [S, A], inviteID: number | null = null): MiningSupportFleetObservation {
  const reads = fleetID === null ? Object.fromEntries(["GetInitState", "GetWings", "GetMotd", "GetJoinRequests", "GetFleetComposition"].map(key => [key, { error: "CALL_REFUSED", message: "FleetNotInFleet" }])) : {
    GetInitState: { result: kv([["fleetID", fleetID], ["members", { type: "dict", entries: roster.map(id => [id, kv([["charID", id], ["role", 0], ["job", 0]])]) }]]) },
    GetWings: { result: { type: "dict", entries: [] } }, GetMotd: { result: "" }, GetJoinRequests: { result: { type: "dict", entries: [] } }, GetFleetComposition: { result: [] }
  };
  return { scope: { characterID, sessionEpoch: "run" }, receivedAtMs: now, snapshot: decodeFleetCenter({ ok: true, characterID, reads } as JsonValue),
    join: { inviteKnown: true, invite: inviteID === null ? null : decodeFleetInviteNotification("OnFleetInvite", [inviteID, S, "AskJoinFleet", {}], now), ads: [] } };
}
function observation(own = fleet(A, F), support: MiningSupportFleetObservation | null = fleet(S, F), managed = true): ScriptObservation {
  return { inSpace: false, docked: true, inWarp: false, shieldRatio: null, armorRatio: null, hullRatio: null, health: null,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    fleetMining: { fleet: own, supportFleet: support, anchors: null, modules: null, sceneReceivedAtMs: now, nowMs: now, requirements: { requireMiningBurst: true } },
    miningOperation: managed ? { operationID: "owned", role: "HAULER", support: { characterID: S, fleetPolicy: "MANAGED" } } as ScriptObservation["miningOperation"] : null };
}
test("public join block is codec-valid, named and grants fleet authority", () => {
  assert.ok(decodeScriptValue(doc).ok);
  assert.deepEqual(analyzeBotRunPolicy(doc).riskClasses, ["fleet"]);
  assert.equal(macroName(step.macro), "Join the support fleet");
  assert.match(stepSentence(step), /Support/);
  assert.equal(decodeScriptValue({ ...doc, program: [{ ...step, args: {} }] }).ok, false);
});
test("docked hauler completes only from fresh selected support membership", () => {
  assert.equal(SCRIPT_MACROS[step.macro]!(step, observation(), {}, {}).outcome.kind, "done");
  const joining = SCRIPT_MACROS[step.macro]!(step, observation(fleet(A, null, [], F)), {}, {});
  assert.deepEqual(joining.action, { kind: "acceptFleetInvite", fleetID: F });
  assert.equal(joining.outcome.kind, "acting");
  assert.equal(SCRIPT_MACROS[step.macro]!(step, observation(fleet(A, null, [], F)), joining.nextMem, {}).action.kind, "wait");
});
test("foreign fleet, unknown support and stale old invitations cannot authorize a split or leave", () => {
  const foreign = SCRIPT_MACROS[step.macro]!(step, observation(fleet(A, F + 1)), {}, {});
  assert.equal(foreign.action.kind, "wait"); assert.equal(foreign.outcome.kind, "blocked");
  for (const obs of [observation(fleet(A, null, [], F), null), observation(fleet(A, null, [], F), fleet(S, F + 1)), observation(fleet(A, null, [], F), fleet(S, F), false)]) {
    assert.equal(SCRIPT_MACROS[step.macro]!(step, obs, {}, {}).action.kind, "wait");
  }
});
test("managed grant does not permit changing the assigned support identity", () => {
  const wrong = { ...step, args: { support: { kind: "character" as const, charID: S + 1, name: "Another" } } };
  const result = SCRIPT_MACROS[step.macro]!(wrong, observation(), {}, {});
  assert.equal(result.action.kind, "wait"); assert.equal(result.outcome.kind, "blocked");
});

test("only correlated apply source proof can accept when its invitation notification is delayed", () => {
  const own = fleet(A, null);
  const advertised = { ...own, join: { ...own.join, ads: [{ fleetID: F, fleetName: "Support", numMembers: 1 }] } };
  const first = SCRIPT_MACROS[step.macro]!(step, observation(advertised), {}, {});
  assert.equal(first.action.kind, "applyToJoinFleet");
  if (first.action.kind !== "applyToJoinFleet") return;
  const freshOwn = { ...advertised, receivedAtMs: now + 1 };
  const original = observation(freshOwn);
  const base = { ...original, fleetMining: { ...original.fleetMining!, nowMs: now + 1 } };
  const proof = { fleetID: F, outcome: "invited" as const, supportOrder: first.action.supportOrder };
  const accepted = SCRIPT_MACROS[step.macro]!(step, { ...base, fleetApplication: proof }, first.nextMem, {});
  assert.deepEqual(accepted.action, { kind: "acceptFleetInvite", fleetID: F });
  for (const application of [{ ...proof, supportOrder: undefined }, { ...proof, fleetID: F + 1 },
    { ...proof, supportOrder: { ...proof.supportOrder!, actionID: 99 } },
    { ...proof, supportOrder: { ...proof.supportOrder!, scope: { characterID: A, sessionEpoch: "old" } } },
    { ...proof, outcome: "unknown" as const }]) {
    assert.equal(SCRIPT_MACROS[step.macro]!(step, { ...base, fleetApplication: application }, first.nextMem, {}).action.kind, "wait");
  }
});
