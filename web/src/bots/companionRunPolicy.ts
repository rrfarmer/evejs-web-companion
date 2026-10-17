// The fleet companion's launch authority and codec — the companion-shaped
// mirror of runPolicy.ts, for the reasons docs/fleet-companion-plan.md,
// "4. The headless launch grant" (DECIDED), lays out:
//
//   • `validateBotLaunchGrant` (runPolicy.ts:183) is UNCHANGED. It reads only
//     `policy.riskClasses`, so any object shaped like a `BotRunPolicy` passes
//     through it — a script's or a companion's. Keeping the two producers
//     separate and the validator singular means a companion's grant is
//     re-derived and re-checked by the exact code path a script's is, instead
//     of a second, drifting copy of that logic.
//   • A companion has no macros and no program tree, so `macroIDs` and
//     `restartBlockers` are always empty and `containsSubBots` is always
//     false — there is nothing here for either to describe.
//
// ─── Risk derivation, decided ────────────────────────────────────────────────
//
// "fleet" is UNCONDITIONAL. `decideCompanionAction`'s first rung
// (fleetCompanionLoop.ts:280) yields the ship to a fleet warp on every tick,
// server-authoritative and never opted out of, and decision 5 lets the
// companion leave and rejoin a fleet on its own initiative. Both are "fleet"
// risk on their own; the setup has no field that could turn either off.
//
// ⚠ THE TAGGING TOGGLE THIS SECTION USED TO ARGUE ABOUT IS GONE ENTIRELY, NOT
// JUST FAILING TO GATE ANYTHING. `attemptsTagging` no longer exists — tagging
// is unconditional now, gated only by the server's own tag-rank check
// (docs/fleet-companion-simplification.md, "Tagging"). There is no flag left
// for a reader to wonder whether it switches "fleet" off, because there is no
// flag; the question this paragraph used to answer no longer has anywhere to
// be asked.
//
// "social" is UNCONDITIONAL too, and this is the one class whose justification
// is FORWARD-LOOKING rather than already-exercised. Phase 8 gives the companion
// a fleet-chat surface (the command parser, the sender gate, and the
// acknowledgement a heard order needs), and nothing on `CompanionSetup` gates
// whether it may speak — every real channel is always on
// (docs/fleet-companion-simplification.md, "What it listens to").
//
// ⚠ THAT IS DELIBERATE, NOT PREMATURE. A grant describes the authority a run is
// given, not what it has already done, and the alternative is worse in a way
// pilotRoster.ts:229 spells out: it renders an empty list as the sentence "No
// consequential permissions", because "an empty list is a sentence, not a
// blank". A pilot that will write fleet tags and speak in fleet chat must not
// describe itself that way in the Bot Manager, and a class that appeared
// mid-feature would make every already-approved grant read as stale.
//
// ⚠ WHAT IT IS NOT JUSTIFIED BY, since an earlier draft of this comment said so
// and was wrong: decision 5's abandonment protocol sends NO chat. It docks,
// leaves the fleet, waits, and accepts a gated invite — see
// `decideAbandonment` in fleetCompanionLoop.ts. If a later phase adds a field
// that actually withholds the chat send, this class stops being unconditional
// and this comment (and the one above the function) must change with it.
//
// ⚠ "combat" IS NOW UNCONDITIONAL TOO, AND THIS SUPERSEDES THE ARGUMENT THAT
// USED TO STAND HERE. Before the 2026-09-11 simplification this was the one
// CONDITIONAL class: no drones, no fitted defensive module, no fitted SELF-
// repair module of any layer, and no fitted remote-repair module of any family
// meant nothing on the ship could be cycled into a fight, so an honestly
// unarmed request could say so. `docs/fleet-companion-simplification.md`,
// "The request, after" ends that possibility: the eight module lists are no
// longer something an operator picks or leaves empty, they are read off the
// hull at start (`requestForFit`, fleetCompanionLoop.ts) — which happens
// AFTER a grant is built and checked, not before. A setup that claimed "no
// combat" and then flew whatever weapons and repairers the hull turned out to
// carry would be a lie `botHost` cannot catch, because it re-derives this same
// policy from the same setup and checks it matches the grant EXACTLY — the
// identical lie on both sides passes that check. `deriveModulesFromFit`
// already earned combat unconditionally for exactly this reason (a fit
// nobody has read yet "may hold anything"); that argument no longer has an
// opt-out left to be an exception to, so it is simply the rule now, for every
// run, with nothing on `CompanionSetup` that could ever turn it off.
//
// "financial" and "inventory" are conditional on `repairsAtStation`, matching
// what the DSL's own `repair-ship` and `dock-and-repair` already claim
// (`runPolicy.ts`: policy(["financial", "inventory"])) — matched rather than
// re-argued, so there is one answer to this question and not two.
//
// No other class ever applies. Nothing on the setup reaches an item, a
// mission, or a colony, so "mission" and "colony" are never in the set, and
// there is no destructive one-shot here for "destructive" to describe.
//
// ─── Restart safety, decided ─────────────────────────────────────────────────
//
// Always `restartSafe: true`. Every other loop's rungs (`decideCompanionAction`
// included) re-read authoritative server state on every tick before deciding
// anything — there is no in-memory "I already asked once" the way
// `accept-mission` has (runPolicy.ts:97-99: it may decline an offer, and
// replaying the block after a restart can decline a different one). Starting
// the companion over at the top of its ladder repeats no externally visible
// call; it just asks the same questions again and gets the same answers.

import { BOT_RISK_CLASSES, type BotRiskClass, type BotRunPolicy } from "./runPolicy.ts";
import type { MacroID } from "./botScript.ts";
import {
  COMPANION_SETUP_KEYS,
  MAX_CAPACITOR_FLOOR,
  MAX_FLEE_ATTEMPTS,
  MAX_ABANDON_DRONES_HEALTH_FLOOR,
  MAX_FLEE_HEALTH_FLOOR,
  MIN_CAPACITOR_FLOOR,
  MIN_FLEE_ATTEMPTS,
  MIN_ABANDON_DRONES_HEALTH_FLOOR,
  MIN_FLEE_HEALTH_FLOOR,
  type CompanionAbandonmentRecord,
  type CompanionSetup,
} from "../nav/fleetCompanionLoop.ts";

const NO_MACRO_IDS: readonly MacroID[] = Object.freeze([]);

/**
 * The value a companion's launch grant carries in its `scriptRev` slot.
 *
 * A companion setup has no revision SERIES: there is no library, no "rev 3 of
 * this companion setup", just the one setup the operator wrote. The canonical
 * hash of that setup is its real identity. This sentinel exists ONLY to fill
 * the slot `validateBotLaunchGrant` (`runPolicy.ts`) already compares a grant
 * against, so a companion's grant stays the exact shape a script's is rather
 * than growing a second field for a version that does not exist. See
 * docs/fleet-companion-handoff.md, "3. Extend botHost".
 *
 * ⚠ IT LIVES HERE, IN THE LAYER BOTH SIDES IMPORT, FOR A REASON. The BFF's bot
 * host compares it and the browser's grant-builder sends it. It was originally
 * a constant private to `src/botHost.js` whose comment instructed future callers
 * to send "this exact value" — two copies of a bare `1`, in two languages, with
 * nothing to fail if one ever changed. A grant whose revision does not match is
 * refused as stale, so a drift between those copies would read to a player as
 * "this bot changed after its run was approved" with nothing actually changed.
 */
export const COMPANION_GRANT_SCRIPT_REV = 1;

/** Build the same `BotRunPolicy` shape a script produces, from a companion setup. */
export function analyzeCompanionRunPolicy(setup: CompanionSetup): BotRunPolicy {
  // "fleet", "social" and "combat" are all unconditional — see the header
  // comment's "Risk derivation, decided" section for why each one is, now
  // that the eight module lists (and the flags that used to gate combat) are
  // gone from what a setup even carries.
  const risks = new Set<BotRiskClass>(["fleet", "social", "combat"]);
  // Paying a station to fix the ship is spending ISK and modifying an item,
  // which is exactly what the DSL's own `repair-ship` and `dock-and-repair`
  // claim (`runPolicy.ts`: policy(["financial", "inventory"])). Matched rather
  // than re-argued, so there is one answer to this question and not two.
  if (setup.repairsAtStation) {
    risks.add("financial");
    risks.add("inventory");
  }
  return Object.freeze({
    macroIDs: NO_MACRO_IDS,
    riskClasses: Object.freeze(BOT_RISK_CLASSES.filter((risk) => risks.has(risk))),
    restartSafe: true,
    restartBlockers: NO_MACRO_IDS,
    containsSubBots: false,
  });
}

// ─── The codec door for a persisted setup ────────────────────────────────────
//
// The BFF's durable bot roster persists a companion setup as plain JSON and
// re-reads it on every restart (docs/fleet-companion-plan.md, "4. The headless
// launch grant"), exactly the way it re-reads a stored script document. This
// is that setup's ONE gate, mirroring scriptCodec.ts's `decodeScriptValue`
// verdict shape: `{ ok: true, setup }` on success, `{ ok: false, refusal }`
// with one plain sentence otherwise.
//
// Unlike `decodeScriptValue`, there is no warnings channel and no clamp-with-a-
// warning: a `CompanionSetup` is flat, produced by one settings form and never
// hand-edited, so there is no "generous to a hand-edited share" case to serve,
// and every one of its numbers already has a real domain bound
// (fleetCompanionLoop.ts's `MIN_`/`MAX_` constants) rather than an arbitrary
// clamp range invented here. A value outside that bound is not a slightly-off
// number to bring back into range; it is a setup this app's own UI could
// never have produced, so it refuses.
//
// UNKNOWN EXTRA KEYS ARE REFUSED, not ignored — the same choice `readDocument`
// makes for a script document (scriptCodec.ts's `unknownKey`), and for the
// same reason: a stored key this codec does not recognise is a field a later
// version wrote and this version cannot honour, and silently dropping it
// would run a setup that is not the one that was saved. `COMPANION_SETUP_KEYS`
// (imported from fleetCompanionLoop.ts, where the flown shape and the stored
// shape are defined together) is the ONE list of what is recognised, so there
// is no second copy of it in this file to drift out of step — the same lesson
// `COMPANION_GRANT_SCRIPT_REV`'s own comment already records about a bare `1`
// living in two languages.
//
// ⚠ FIFTEEN NAMES ARE THE ONE EXCEPTION TO "REFUSED", AND THEY ARE A FINITE
// MIGRATION, NOT A CRACK IN THE RULE ABOVE. `role`, the eight module-id lists,
// `deriveModulesFromFit`, `useDrones`, `attemptsTagging`, `obeys`,
// `chatCommandSenders` and `safeSpotBookmarkID` were real fields on the
// pre-2026-09-11 request (docs/fleet-companion-simplification.md, "The
// request, after"), and every config an operator has already saved — in
// `hangarPrefs` localStorage, and in the BFF's persisted bot roster — carries
// all fifteen of them. Refusing them outright would make `companionConfigMap`
// (`hangarPrefs.ts`) drop every one of those configs SILENTLY, because it
// treats a failed decode as "nothing was saved here" — so the visible symptom
// of a plain deletion would be every existing squad quietly losing its setup
// on the very next load. `COMPANION_RETIRED_KEYS` below names exactly those
// fifteen, and the two drone settings retired the same way on 2026-10-12: a key on that list is accepted, its value is thrown away without
// being looked at, and it is never written back. A key in NEITHER set is
// still refused — that rule is exactly as strict as it always was. Do not
// read this as "unknown keys are fine now": it is a closed, finite list of
// names this codec once owned and no longer does, and it must stay finite. A
// genuinely new key this codec does not recognise is still a refusal.
//
// The document is flat, so — unlike the script codec's nested tree — a plain
// sequence of early returns is the clearest control flow here; there is no
// recursion depth that would make a throw-caught-at-the-boundary style earn
// its keep.

const SETUP_KEYS = new Set<string>(COMPANION_SETUP_KEYS);

/**
 * ⚠ A FINITE MIGRATION LIST, NOT A SECOND UNKNOWN-KEY POLICY. See the header
 * comment above this constant for the full argument; in short, every name
 * here failed the "can this be read off the ship" test that decided what
 * survived the 2026-09-11 simplification. The eight module-id lists are now
 * derived from the fit at start; `role` and `deriveModulesFromFit` named a
 * mechanism that no longer has an alternative to select between (a companion
 * always reads its own fit now); `useDrones` and `attemptsTagging` were
 * toggles in front of behaviour that is simply unconditional now; `obeys` and
 * `chatCommandSenders` named channels that are all always on; and
 * `safeSpotBookmarkID` was superseded by warping to the system's own sun
 * (docs/fleet-companion-simplification.md, "The sun exists"). A key on this
 * list is accepted and ignored — decoding one does not resurrect the field,
 * it only stops an old row from being refused for still carrying it.
 *
 * Do NOT add a name here for a field being retired in the future without
 * rereading the paragraph above it: the day this becomes "things we did not
 * feel like migrating properly" is the day the closed-key-set refusal this
 * codec is built around stops meaning anything.
 */
const COMPANION_RETIRED_KEYS = new Set<string>([
  "role",
  "defenseModuleIDs",
  "shieldBoosterModuleIDs",
  "armorRepairerModuleIDs",
  "hullRepairerModuleIDs",
  "remoteShieldModuleIDs",
  "remoteArmorModuleIDs",
  "remoteCapacitorModuleIDs",
  "weaponModuleIDs",
  "deriveModulesFromFit",
  "useDrones",
  "attemptsTagging",
  "obeys",
  "chatCommandSenders",
  "safeSpotBookmarkID",
  // Retired 2026-10-12, when rung 6 began rotating the one drone whose shield
  // is below full instead of recalling the flight at a floor and holding it.
  // Neither number has anything left to configure; every saved squad carries
  // both, so they are accepted and dropped like the names above.
  "droneHealthFloor",
  "droneRedeployHoldOffSeconds",
]);

/**
 * The rejoin allowlist is the fleet-mates seen on one tick, and a fleet does
 * not run into the low hundreds of pilots, so 64 bounds the list without ever
 * binding an honest one.
 */
const MAX_SUPERVISOR_IDS = 64;

const SAY = {
  notObject: "This companion setup is not a valid request.",
  unknownKey: "This companion setup has settings this app does not recognise.",
  badFleeHealthFloor: "This companion setup's flee-health threshold is not a valid number.",
  badAbandonDronesHealthFloor: "This companion setup's leave-the-drones threshold is not a valid number.",
  badCapacitorFloor: "This companion setup's capacitor threshold is not a valid number.",
  badMaxFleeAttempts: "This companion setup's flee-attempt limit is not a valid number.",
  badRepairsAtStation: "This companion setup's station-repair setting is not valid.",
  badAbandonment: "This pilot's saved supervision state is not valid.",
} as const;

// Not exported: this module's public surface is exactly the two decode
// functions in this file. A caller narrows the return value's `ok` field
// directly rather than importing a name for its shape.
type CompanionSetupVerdict =
  | { readonly ok: true; readonly setup: CompanionSetup }
  | { readonly ok: false; readonly refusal: string };

function isPositiveSafeIntegerArray(value: unknown, max: number): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0)
  );
}

function isFiniteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Decode an already-parsed, UNTRUSTED value into a `CompanionSetup`. */
export function decodeCompanionSetupValue(value: unknown): CompanionSetupVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, refusal: SAY.notObject };
  }
  const obj = value as Readonly<Record<string, unknown>>;

  // Own enumerable keys only — never followed as a prototype path. A retired
  // key (see `COMPANION_RETIRED_KEYS` above) is accepted and skipped without
  // being decoded; any other key outside the closed `SETUP_KEYS` set is still
  // refused, exactly as before.
  for (const key of Object.keys(obj)) {
    if (COMPANION_RETIRED_KEYS.has(key)) {
      continue;
    }
    if (!SETUP_KEYS.has(key)) {
      return { ok: false, refusal: SAY.unknownKey };
    }
  }

  const fleeHealthFloor = obj["fleeHealthFloor"];
  if (!isFiniteNumberInRange(fleeHealthFloor, MIN_FLEE_HEALTH_FLOOR, MAX_FLEE_HEALTH_FLOOR)) {
    return { ok: false, refusal: SAY.badFleeHealthFloor };
  }

  // ABSENT STAYS ABSENT, not a default filled in here. A setup saved before
  // this field existed must decode to exactly what it did: `src/botHost.js`
  // hashes the decoded setup and refuses a resumed run whose hash moved. The
  // loop reads absence as half the flee floor (`abandonDronesFloor`).
  const abandonDronesHealthFloor = obj["abandonDronesHealthFloor"];
  if (
    abandonDronesHealthFloor !== undefined &&
    !isFiniteNumberInRange(abandonDronesHealthFloor, MIN_ABANDON_DRONES_HEALTH_FLOOR, MAX_ABANDON_DRONES_HEALTH_FLOOR)
  ) {
    return { ok: false, refusal: SAY.badAbandonDronesHealthFloor };
  }

  const capacitorFloor = obj["capacitorFloor"];
  if (!isFiniteNumberInRange(capacitorFloor, MIN_CAPACITOR_FLOOR, MAX_CAPACITOR_FLOOR)) {
    return { ok: false, refusal: SAY.badCapacitorFloor };
  }

  const maxFleeAttempts = obj["maxFleeAttempts"];
  if (
    typeof maxFleeAttempts !== "number" ||
    !Number.isSafeInteger(maxFleeAttempts) ||
    maxFleeAttempts < MIN_FLEE_ATTEMPTS ||
    maxFleeAttempts > MAX_FLEE_ATTEMPTS
  ) {
    return { ok: false, refusal: SAY.badMaxFleeAttempts };
  }

  // ABSENT DECODES TO FALSE, the same rule this field has always had:
  // `src/botHost.js` re-decodes a persisted roster row on every BFF restart,
  // and a row written before this field existed was saved by an operator who
  // was never shown the choice, so its absence cannot be read as consent to
  // spend ISK. False is also the safe direction: a pilot that stays docked is
  // a pilot that cost nothing.
  const repairsAtStationRaw = obj["repairsAtStation"];
  const repairsAtStation = repairsAtStationRaw === undefined ? false : repairsAtStationRaw;
  if (typeof repairsAtStation !== "boolean") {
    return { ok: false, refusal: SAY.badRepairsAtStation };
  }

  const setup: CompanionSetup = {
    fleeHealthFloor,
    capacitorFloor,
    maxFleeAttempts,
    repairsAtStation,
    ...(abandonDronesHealthFloor === undefined ? {} : { abandonDronesHealthFloor }),
  };
  return { ok: true, setup: Object.freeze(setup) };
}

// ─── The codec door for a persisted ABANDONMENT ──────────────────────────────
//
// Decision 5's thirty-minute wait is only a bound if its clock outlives a BFF
// restart, so the roster row carries it — and a value read back off disk is
// untrusted bytes for exactly the same reason the setup beside it is. This is
// its one gate, in the same verdict shape.
//
// ⚠ THE CLOCK IS REFUSED IF IT IS IN THE FUTURE. `abandonedAtMs` is only ever
// written from this host's own clock, so a timestamp ahead of now is either a
// corrupted row or an edited one — and the failure it would cause is the whole
// point of persisting it: an abandonment dated an hour from now never expires,
// which is the unbounded wait the persistence exists to prevent. A row that
// cannot be trusted is refused, and a refused row starts a FRESH thirty
// minutes, which is bounded and safe.
//
// ⚠ AN EMPTY `supervisorCharacterIDs` IS VALID AND MEANS SOMETHING. It is what
// a companion abandoned before it ever saw a human legitimately has, and it
// reads as "accept no invite from anyone" — the safe direction. It must not be
// confused with a missing field, which is refused.

const ABANDONMENT_KEYS = new Set<string>(["abandonedAtMs", "supervisorCharacterIDs"]);

type CompanionAbandonmentVerdict =
  | { readonly ok: true; readonly abandonment: CompanionAbandonmentRecord }
  | { readonly ok: false; readonly refusal: string };

/** Decode an already-parsed, UNTRUSTED value into a `CompanionAbandonmentRecord`. */
export function decodeCompanionAbandonmentValue(
  value: unknown,
  nowMs: number = Date.now(),
): CompanionAbandonmentVerdict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, refusal: SAY.badAbandonment };
  }
  const obj = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(obj)) {
    if (!ABANDONMENT_KEYS.has(key)) {
      return { ok: false, refusal: SAY.badAbandonment };
    }
  }
  const abandonedAtMs = obj["abandonedAtMs"];
  if (
    typeof abandonedAtMs !== "number" ||
    !Number.isSafeInteger(abandonedAtMs) ||
    abandonedAtMs <= 0 ||
    abandonedAtMs > nowMs
  ) {
    return { ok: false, refusal: SAY.badAbandonment };
  }
  const supervisorCharacterIDs = obj["supervisorCharacterIDs"];
  if (!isPositiveSafeIntegerArray(supervisorCharacterIDs, MAX_SUPERVISOR_IDS)) {
    return { ok: false, refusal: SAY.badAbandonment };
  }
  return {
    ok: true,
    abandonment: Object.freeze({
      abandonedAtMs,
      supervisorCharacterIDs: Object.freeze([...supervisorCharacterIDs]),
    }),
  };
}
