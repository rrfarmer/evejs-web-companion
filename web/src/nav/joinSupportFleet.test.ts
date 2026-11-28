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
function observation(own = fleet(A, F), support: MiningSupportFleetObservation | null = fleet(S, F)): ScriptObservation {
  return { inSpace: false, docked: true, inWarp: false, shieldRatio: null, armorRatio: null, hullRatio: null, health: null,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    fleetMining: { fleet: own, supportFleet: support, anchors: null, nowMs: now } };
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
  const invited = SCRIPT_MACROS[step.macro]!(step, observation(fleet(A, null, [], F)), {}, {});
  assert.equal(invited.action.kind, "wait", "joining a fleet manually requires observed membership");
});
test("foreign fleet, unknown support and stale old invitations cannot authorize a split or leave", () => {
  const foreign = SCRIPT_MACROS[step.macro]!(step, observation(fleet(A, F + 1)), {}, {});
  assert.equal(foreign.action.kind, "wait"); assert.equal(foreign.outcome.kind, "blocked");
  for (const obs of [observation(fleet(A, null, [], F), null), observation(fleet(A, null, [], F), fleet(S, F + 1)), observation(fleet(A, null, [], F), fleet(S, F))]) {
    assert.equal(SCRIPT_MACROS[step.macro]!(step, obs, {}, {}).action.kind, "wait");
  }
});

test("join-support-fleet verifies the selected pilot in a fresh roster without any support anchor", () => {
  const obs = observation(fleet(A, F), null);
  const roster = { fleetID: String(F), readerCharacterID: A, observedAtMs: now, expiresAtMs: now + 10_000,
    members: [A, S].map(characterID => ({ characterID, solarSystemID: null })) };
  const decide = (read: typeof roster) => SCRIPT_MACROS[step.macro]!(step,
    { ...obs, fleetMining: { ...obs.fleetMining!, anchors: { availability: "available", reason: null, readAtMs: now, fleet: read, anchors: [] } } }, {}, {});
  assert.equal(decide(roster).outcome.kind, "done");
  for (const invalid of [{ ...roster, readerCharacterID: S }, { ...roster, fleetID: String(F + 1) },
    { ...roster, expiresAtMs: now }, { ...roster, members: roster.members.slice(0, 1) }]) {
    assert.notEqual(decide(invalid).outcome.kind, "done");
    assert.equal(decide(invalid).action.kind, "wait");
  }
});
