// R31 — the server's refusal, in the player's language.
//
// The point of this file is that the regression is impossible, not merely
// unlikely: the sweep at the bottom walks EVERY sentence this client can
// produce for a refusal and proves none of them is a resource path, a numeric
// label prefix, a camelCase identifier or a SCREAMING_SNAKE code.

import assert from "node:assert/strict";
import test from "node:test";

import {
  BRIDGE_REFUSAL_CODES,
  PREDICTED_REFUSAL_TEXTS,
  SERVER_REFUSAL_KEYS,
  SILENT_REFUSAL_TEXT,
  UNKNOWN_REFUSAL_TEXT,
  describeRefusal,
  isPlainPlayerLanguage,
  refusalWords,
} from "./refusals.ts";

// --- The vocabulary is the SERVER'S, pinned ---------------------------------

/**
 * eve.js's own refusal vocabulary for the verbs a browser can dispatch.
 *
 * ⚠ THIS LIST IS NOT A WISH. It is the enumeration of every
 * `throwWrappedUserError("<Name>", …)` site inside the handlers reachable from
 * WEB_CALL_ALLOWLIST (evejsWebGatewayRuntime.js:88) — beyonce.Cmd*, dogmaIM.*,
 * ship.Board/Undock/LaunchDrones/ScoopDrone, invbroker.*, and the structure
 * docking service CmdDock reaches — plus the two localization tuples
 * `_throwStargateJumpUserError` emits under an `info` key
 * (beyonceService.js:1701, :1706), which are the only two that survive
 * `readWrappedUserErrorRefusal`'s info/notify filter.
 *
 * Names that exist in those files but are NOT reachable from this client are
 * deliberately absent, and their absence is the assertion:
 * Handle_InitiateModuleRepair (NotEnoughRepairMaterialToFinishAllRepairs),
 * the overload path (DontHaveThermoDynamicsSkill), the probe-launch and
 * warp-disrupt-field-generator paths and Handle_Scoop (ShpScoopSecureCC) are
 * all real UserError sites behind methods this client cannot call. (NotEnoughCargoSpace WAS here too, until the
 * docked hangar→ship-hold move made invbroker's copy of it reachable.)
 *
 * If eve.js widens the allowlist, this test fails and the table gets an entry —
 * which is the point.
 */
const EVEJS_REFUSAL_VOCABULARY: readonly string[] = [
  // The two `CustomInfo {info: [101, "UI/..."]}` tuples, comma-joined on the
  // wire by `String(proseEntry[1])`.
  "101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist",
  "101,UI/GateIcons/GateClosed",
  // The bare UserError codes.
  // dogma Handle_CreateNewbieShip — reachable from the Station panel's "Board corvette".
  "AlreadyInNewbieShip",
  "ErrorCreatingNewbieShip",
  "MustBeDocked",
  "BookmarkNotAvailable",
  "CannotOnlineReachedMaxGroupOnline",
  "CantInHighSecSpace",
  "CrpAccessDenied",
  "DeniedActivateInWarp",
  "DeniedActivateTargetNotPresent",
  "DeniedShipChanged",
  "DeniedTargetOtherWarping",
  "DeniedTargetSelf",
  "DeniedTargetSelfWarping",
  "DeniedTargetingAttemptFailed",
  "DockingApproach",
  "DockingRequestDenied",
  "EffectAlreadyActive2",
  "EffectCrowdedOut",
  // invbroker Handle_GetInventoryFromId — reachable on every cargo/bay bind.
  "FakeItemNotFound",
  // fleetObjectHandler Handle_LeaveFleet (ensureFleetMembership) — reachable from the Fleet window's "Leave fleet".
  "FleetNotInFleet",
  "ModuleReactivationDelayed2",
  "NoCharges",
  "NotEnoughCapacitorForOnline",
  // invbroker Add/MultiAdd — reachable via the docked hangar→ship-hold move.
  "NotEnoughCargoSpace",
  // officeManager Handle_RentOffice — reachable from the Station panel's "Rent it and pay".
  "NotEnoughMoney",
  "TargetNotWithinRangeGeneric",
  "TargetTooFar",
  "TargetingAttemptCancelled",
  "TargetingSystemsAlreadyFullyUtilized",
  "ThrottleGeneric",
  "WarpDisrupted",
];

test("the refusal table is EXACTLY eve.js's reachable vocabulary — no more, no fewer", () => {
  assert.deepEqual(
    [...SERVER_REFUSAL_KEYS].sort(),
    [...EVEJS_REFUSAL_VOCABULARY].sort(),
  );
});

test("every refusal string is explained by a different sentence", () => {
  const sentences = SERVER_REFUSAL_KEYS.map((key) => refusalWords(key));
  assert.equal(new Set(sentences).size, sentences.length);
});

// --- The R9a sweep ----------------------------------------------------------

/** Every sentence this module can ever put in front of a player. */
function everyPlayerFacingSentence(): string[] {
  return [
    ...SERVER_REFUSAL_KEYS.map((key) => describeRefusal(key).text),
    ...BRIDGE_REFUSAL_CODES.map((code) => describeRefusal(code).text),
    UNKNOWN_REFUSAL_TEXT,
    SILENT_REFUSAL_TEXT,
  ];
}

/**
 * R33's predicted refusals are held to the same R9a LANGUAGE bar (below), but
 * deliberately NOT to this function's punctuation rule.
 *
 * ⚠ THE DIFFERENCE IS THE RENDERING CONTEXT, not a relaxed standard. Everything
 * in `everyPlayerFacingSentence` is prose in an error paragraph, where a
 * terminal full stop is correct. A predicted refusal is a BUTTON LABEL — it
 * replaces "Bring home" on the control itself, following R30's `unavailable`
 * convention ("There is nothing in your holds to take anywhere"), which carries
 * no full stop because a label is not a sentence in a paragraph. Forcing one
 * here would make the drone control read differently from the haul control
 * sitting a few hundred pixels above it.
 */

test("R9a — no refusal a player reads contains a resource path, a code prefix, or an identifier", () => {
  for (const sentence of everyPlayerFacingSentence()) {
    assert.ok(
      isPlainPlayerLanguage(sentence),
      `not plain player language: ${sentence}`,
    );
    assert.ok(!sentence.includes("UI/"), `resource path leaked: ${sentence}`);
    assert.ok(!sentence.includes("CALL_REFUSED"), `wire code leaked: ${sentence}`);
    assert.ok(!/^\d/.test(sentence), `numeric prefix leaked: ${sentence}`);
  }
});

test("no refusal sentence contains the code it explains", () => {
  for (const key of SERVER_REFUSAL_KEYS) {
    assert.ok(
      !describeRefusal(key).text.includes(key),
      `${key} names itself to the player`,
    );
  }
  for (const code of BRIDGE_REFUSAL_CODES) {
    assert.ok(
      !describeRefusal(code).text.includes(code),
      `${code} names itself to the player`,
    );
  }
});

test("a refusal is a sentence, not a label — every one is a real explanation", () => {
  for (const sentence of everyPlayerFacingSentence()) {
    assert.ok(sentence.length > 20, `too terse to explain anything: ${sentence}`);
    assert.ok(/[.!]$/.test(sentence), `not a sentence: ${sentence}`);
  }
});

// --- The live string that started the goal ----------------------------------

test("the out-of-range jump reads as a sentence, not a resource key", () => {
  // Captured live from the running emulator: an out-of-range CmdStargateJump
  // answers 409 CALL_REFUSED with exactly this message.
  const refusal = describeRefusal("CALL_REFUSED: 101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist");
  assert.equal(
    refusal.text,
    "That gate is too far away to jump through. Get closer to it first.",
  );
  // The raw text is not thrown away — it is just not in the player's face.
  assert.equal(refusal.detail, "CALL_REFUSED: 101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist");
});

test("the same refusal is recognised whether or not the wire code is attached", () => {
  assert.equal(
    describeRefusal("101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist").text,
    describeRefusal("CALL_REFUSED: 101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist").text,
  );
});

test("the two other live refusals read as sentences too", () => {
  // Both captured live: dock at a station in another system, and lock a target
  // that is out of range.
  assert.equal(
    describeRefusal("CALL_REFUSED: DockingApproach").text,
    "You are too far from the station to dock. Your ship is closing in — try docking again once it arrives.",
  );
  assert.equal(
    describeRefusal("CALL_REFUSED: TargetTooFar").text,
    "That is too far away. Get closer and try again.",
  );
});

// --- Degrading honestly -----------------------------------------------------

test("an UNKNOWN refusal is never dumped raw at the player", () => {
  const refusal = describeRefusal("CALL_REFUSED: SomeCodeNobodyHasSeen");
  assert.equal(refusal.text, UNKNOWN_REFUSAL_TEXT);
  assert.ok(isPlainPlayerLanguage(refusal.text));
  // ...but it is still recoverable for whoever has to diagnose it.
  assert.equal(refusal.detail, "CALL_REFUSED: SomeCodeNobodyHasSeen");
});

test("an unknown refusal never invents a reason", () => {
  // Nothing in the fallback claims to know WHY — only that it was refused.
  assert.ok(!/because|since|out of range|too far|not enough/i.test(UNKNOWN_REFUSAL_TEXT));
});

test("a refusal with no text at all says so rather than showing nothing", () => {
  for (const empty of ["", "   "]) {
    const refusal = describeRefusal(empty);
    assert.equal(refusal.text, SILENT_REFUSAL_TEXT);
    assert.equal(refusal.detail, null);
  }
});

test("the server's OWN sentence is passed through, not reworded over the top", () => {
  // Over 130 eve.js handlers refuse with real prose via CustomNotify. Those are
  // already plain player language and this client must not talk over them.
  const prose = "Your ship cannot warp while an active module is preventing movement.";
  const refusal = describeRefusal(prose);
  assert.equal(refusal.text, prose);
  // Nothing to recover: the text the player read IS what the server said.
  assert.equal(refusal.detail, null);
});

test("server prose survives the wire envelope glued to the front of it", () => {
  // This is how prose ACTUALLY arrives — `readRefusalReason` prefixes the code.
  // Judging the whole string would see CALL_REFUSED, call it jargon, and bin a
  // sentence the server had already written for the player (R14's corp-hangar
  // refusal is exactly this shape).
  const refusal = describeRefusal("CALL_REFUSED: You do not have the required roles.");
  assert.equal(refusal.text, "You do not have the required roles.");
  assert.equal(refusal.detail, null);
});

test("a structured refusal is jargon, not prose, and falls back", () => {
  // The gateway's `readStructuredRefusalReasons` shape — real, and unreadable.
  const refusal = describeRefusal("IndustryValidationError: MISSING_MATERIAL, ACCOUNT_FUNDS");
  assert.equal(refusal.text, UNKNOWN_REFUSAL_TEXT);
  assert.equal(refusal.detail, "IndustryValidationError: MISSING_MATERIAL, ACCOUNT_FUNDS");
});

test("a BFF validation message that leaks an identifier never reaches the player", () => {
  // `POST /api/bridge/flight/approach` answers exactly this on a bad target.
  const refusal = describeRefusal("INVALID_TARGET: A positive destinationID is required.");
  assert.equal(refusal.text, "That target could not be identified.");
  assert.ok(!refusal.text.includes("destinationID"));
});

test("the wire envelope never shadows the real reason inside it", () => {
  // CALL_REFUSED is deliberately absent from the bridge table: if it were there
  // it would match the before-colon candidate and hide the server's own code.
  assert.notEqual(describeRefusal("CALL_REFUSED: TargetTooFar").text, UNKNOWN_REFUSAL_TEXT);
  // On its own it is still explained rather than shown.
  assert.ok(isPlainPlayerLanguage(describeRefusal("CALL_REFUSED").text));
});

test("a bare transport code becomes words", () => {
  assert.equal(
    describeRefusal("BRIDGE_NETWORK_ERROR").text,
    "The connection to the server dropped. Check it and try again.",
  );
  assert.equal(describeRefusal("NOT_IN_SPACE").text, "Your ship is docked. Undock before doing that.");
});

// --- The predicate itself ---------------------------------------------------

test("isPlainPlayerLanguage rejects everything a player should never read", () => {
  const jargon = [
    "",
    "   ",
    "DockingApproach",
    "TargetTooFar",
    "CALL_REFUSED",
    "101,UI/Menusvc/MenuHints/NotWithingMaxJumpDist",
    "UI/GateIcons/GateClosed",
    "The ship is NOT_IN_SPACE right now.",
    "A positive destinationID is required.",
    "Could not read solarSystemID for that ship.",
  ];
  for (const value of jargon) {
    assert.ok(!isPlainPlayerLanguage(value), `should have been rejected: ${value}`);
  }
});

test("isPlainPlayerLanguage accepts real sentences, including ones with proper nouns", () => {
  const prose = [
    "Warp is disabled while the criminal timer is active.",
    "You do not have the required roles.",
    "Capital ships cannot use stargates while affected by a focused Heavy Interdictor disruption script.",
    "You need the Thermodynamics skill to overheat a module.",
    "Your ship does not have enough power, CPU or capacitor to bring that module online.",
  ];
  for (const value of prose) {
    assert.ok(isPlainPlayerLanguage(value), `should have been accepted: ${value}`);
  }
});

test("refusalWords is describeRefusal's text, and never empty", () => {
  for (const raw of ["", "DockingApproach", "something nobody has seen before", "WhatIsThis"]) {
    const words = refusalWords(raw);
    assert.equal(words, describeRefusal(raw).text);
    assert.ok(words.trim().length > 0);
  }
});

// --- R33: the refusals we can see coming ------------------------------------

test("R33 — a predicted refusal is NOT in the wire vocabulary", () => {
  // ⚠ The two tables must never merge. SERVER_REFUSALS is pinned key-for-key
  // against the codes a browser call can actually provoke; a sentence that no
  // wire message maps to would quietly destroy the one property that makes that
  // table worth having.
  for (const text of PREDICTED_REFUSAL_TEXTS) {
    assert.ok(
      !SERVER_REFUSAL_KEYS.includes(text),
      `${text} must not be keyed as a wire refusal`,
    );
    assert.ok(
      !BRIDGE_REFUSAL_CODES.includes(text),
      `${text} must not be keyed as a bridge code`,
    );
  }
});

test("R33 — each predicted refusal is a distinct sentence a player can act on", () => {
  assert.ok(PREDICTED_REFUSAL_TEXTS.length > 0);
  assert.equal(
    new Set(PREDICTED_REFUSAL_TEXTS).size,
    PREDICTED_REFUSAL_TEXTS.length,
    "two controls must not wear the same words",
  );
  for (const text of PREDICTED_REFUSAL_TEXTS) {
    // The same R9a language bar every arriving refusal clears.
    assert.ok(isPlainPlayerLanguage(text), `not plain player language: ${text}`);
    assert.ok(!text.includes("UI/"), `resource path leaked: ${text}`);
    assert.ok(!text.includes("CALL_REFUSED"), `wire code leaked: ${text}`);
    assert.ok(!/^\d/.test(text), `numeric prefix leaked: ${text}`);
    assert.ok(text.trim().length > 10, `too terse to explain anything: ${text}`);
    // ⚠ NO INVENTED REMEDY. Regaining drone control is CmdReconnectToDrones,
    // which this client cannot dispatch — the gateway does not allowlist it.
    assert.doesNotMatch(text, /reconnect|regain control/i);
  }
});
