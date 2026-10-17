import test from "node:test";
import assert from "node:assert/strict";

import { validateBotLaunchGrant, createBotLaunchGrant } from "./runPolicy.ts";
import {
  analyzeCompanionRunPolicy,
  decodeCompanionAbandonmentValue,
  decodeCompanionSetupValue,
} from "./companionRunPolicy.ts";
import {
  DEFAULT_COMPANION_SETUP,
  MAX_CAPACITOR_FLOOR,
  MAX_FLEE_ATTEMPTS,
  MAX_FLEE_HEALTH_FLOOR,
  MIN_CAPACITOR_FLOOR,
  MIN_FLEE_ATTEMPTS,
  MIN_FLEE_HEALTH_FLOOR,
  MIN_ABANDON_DRONES_HEALTH_FLOOR,
  MAX_ABANDON_DRONES_HEALTH_FLOOR,
  type CompanionSetup,
} from "../nav/fleetCompanionLoop.ts";

/**
 * A complete, valid setup with named overrides — same builder shape
 * `fleetCompanionLoop.test.ts` uses for observations, so a test never
 * hand-rolls a partial object and forgets a field.
 */
function setup(overrides: Partial<CompanionSetup> = {}): CompanionSetup {
  return { ...DEFAULT_COMPANION_SETUP, ...overrides };
}

// The ESI docs' own example CharacterID (obviously synthetic, self-describing)
// — used only for the abandonment record's supervisor list below.
const SYNTHETIC_CHARACTER_ID = 90000001;
// A synthetic item-type id, not a real game identifier — used only to prove a
// retired module-id field is accepted and dropped, never read.
const SYNTHETIC_MODULE_ID = 11200001;

// ─── analyzeCompanionRunPolicy ───────────────────────────────────────────────

test("fleet, social and combat are unconditional, even on the setup that spends nothing", () => {
  const policy = analyzeCompanionRunPolicy(setup({ repairsAtStation: false }));
  assert.deepEqual([...policy.riskClasses], ["combat", "fleet", "social"]);
});

test("risk classes come out in the same stable order runPolicy.ts uses", () => {
  const policy = analyzeCompanionRunPolicy(setup());
  assert.deepEqual([...policy.riskClasses], ["combat", "fleet", "social"]);
});

test("a companion carries no macros, no restart blockers, and no sub-bots", () => {
  const policy = analyzeCompanionRunPolicy(setup());
  assert.deepEqual(policy.macroIDs, []);
  assert.deepEqual(policy.restartBlockers, []);
  assert.equal(policy.containsSubBots, false);
});

test("a companion is always restart-safe — it re-reads authoritative state every tick", () => {
  const policy = analyzeCompanionRunPolicy(setup({ repairsAtStation: true }));
  assert.equal(policy.restartSafe, true);
});

test("mission, colony, and destructive never appear", () => {
  const policy = analyzeCompanionRunPolicy(setup({ repairsAtStation: true }));
  for (const forbidden of ["mission", "colony", "destructive"] as const) {
    assert.ok(!policy.riskClasses.includes(forbidden));
  }
});

test("repairsAtStation earns financial and inventory, and nothing else does", () => {
  // The claim is two-sided: the flag turns them on, and no OTHER field in the
  // setup can. If something else ever earns financial, this test says so
  // rather than letting the flag quietly stop being the reason.
  const off = analyzeCompanionRunPolicy(setup({ repairsAtStation: false }));
  assert.equal(off.riskClasses.includes("financial"), false);
  assert.equal(off.riskClasses.includes("inventory"), false);

  const on = analyzeCompanionRunPolicy(setup({ repairsAtStation: true }));
  assert.equal(on.riskClasses.includes("financial"), true);
  assert.equal(on.riskClasses.includes("inventory"), true);
});

test("validateBotLaunchGrant works on a companion's policy unchanged", () => {
  const policy = analyzeCompanionRunPolicy(setup());
  const grant = createBotLaunchGrant(1, policy, 60);
  assert.deepEqual(validateBotLaunchGrant(grant, 1, policy), { ok: true, grant });
  assert.equal(validateBotLaunchGrant({ ...grant, riskClasses: [] }, 1, policy).ok, false);
});

// ─── decodeCompanionSetupValue ───────────────────────────────────────────────

function validPayload(): Record<string, unknown> {
  return {
    fleeHealthFloor: 0.3,
    capacitorFloor: 0.2,
    maxFleeAttempts: 3,
    repairsAtStation: false,
  };
}

test("a well-formed setup round-trips", () => {
  const result = decodeCompanionSetupValue(validPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.setup, {
      fleeHealthFloor: 0.3,
      capacitorFloor: 0.2,
      maxFleeAttempts: 3,
      repairsAtStation: false,
    });
  }
});

test("null, an array, and a primitive are all refused, not thrown", () => {
  assert.equal(decodeCompanionSetupValue(null).ok, false);
  assert.equal(decodeCompanionSetupValue([]).ok, false);
  assert.equal(decodeCompanionSetupValue("dps").ok, false);
  assert.equal(decodeCompanionSetupValue(42).ok, false);
});

test("a genuinely unknown key is STILL refused", () => {
  // A stored key this codec does not recognise (and that is not on the
  // retired list) is a field a later version wrote and this one cannot
  // honour; running the setup anyway would run a setup that is not the one
  // that was saved.
  const result = decodeCompanionSetupValue({
    ...validPayload(),
    anchorToFleetCommander: true,
  });
  assert.equal(result.ok, false);
});

// ─── repairsAtStation ────────────────────────────────────────────────────────

test("repairsAtStation round-trips both ways when the key IS present", () => {
  for (const value of [true, false]) {
    const result = decodeCompanionSetupValue({ ...validPayload(), repairsAtStation: value });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.setup.repairsAtStation, value);
    }
  }
});

test("repairsAtStation defaults to false when absent", () => {
  const payload = validPayload();
  delete payload.repairsAtStation;
  const result = decodeCompanionSetupValue(payload);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.setup.repairsAtStation, false);
  }
});

test("a non-boolean repairsAtStation is refused rather than coerced", () => {
  // ⚠ INCLUDING THE TRUTHY ONES. "true" and 1 are exactly what a hand-edited
  // or half-migrated row would carry, and coercing either would turn a row
  // that never consented to spending ISK into one that does.
  for (const bad of ["true", 1, 0, null, {}, []]) {
    const result = decodeCompanionSetupValue({ ...validPayload(), repairsAtStation: bad });
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
});

// ─── the surviving numeric bounds ────────────────────────────────────────────

test("fleeHealthFloor and capacitorFloor are refused outside their real domain bounds", () => {
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), fleeHealthFloor: MIN_FLEE_HEALTH_FLOOR - 0.01 }).ok,
    false,
  );
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), fleeHealthFloor: MAX_FLEE_HEALTH_FLOOR + 0.01 }).ok,
    false,
  );
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), capacitorFloor: MIN_CAPACITOR_FLOOR - 0.01 }).ok,
    false,
  );
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), capacitorFloor: MAX_CAPACITOR_FLOOR + 0.01 }).ok,
    false,
  );
  // The bounds are inclusive.
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), fleeHealthFloor: MIN_FLEE_HEALTH_FLOOR }).ok,
    true,
  );
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), capacitorFloor: MAX_CAPACITOR_FLOOR }).ok,
    true,
  );
});

test("fleeHealthFloor refuses NaN, Infinity, and non-numbers", () => {
  assert.equal(decodeCompanionSetupValue({ ...validPayload(), fleeHealthFloor: Number.NaN }).ok, false);
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), fleeHealthFloor: Number.POSITIVE_INFINITY }).ok,
    false,
  );
  assert.equal(decodeCompanionSetupValue({ ...validPayload(), fleeHealthFloor: "0.3" }).ok, false);
});

// ⚠ THE CLOSED KEY SET IS WHAT MAKES THIS WORTH TESTING. A setup that reaches
// the bot host has crossed a process boundary and been sat in a database; the
// decoder refuses anything it does not recognise (outside the retired list)
// and anything out of domain.
test("a missing threshold is refused, never defaulted", () => {
  const withoutIt: Record<string, unknown> = { ...validPayload() };
  delete withoutIt.fleeHealthFloor;
  assert.equal(
    decodeCompanionSetupValue(withoutIt).ok,
    false,
    "a silent default here would fly a pilot on a number nobody chose",
  );
});

// ⚠ THE ONE THRESHOLD THAT MAY BE MISSING, and it stays missing. Every setup
// saved before 2026-10-13 lacks it: refusing would drop every saved squad's
// setup, and filling it in here would move the hash a resumed server run is
// checked against. The loop reads absence as half the flee floor.
test("abandonDronesHealthFloor is optional, and absent stays absent", () => {
  const without = decodeCompanionSetupValue(validPayload());
  assert.equal(without.ok, true);
  if (without.ok) {
    assert.equal("abandonDronesHealthFloor" in without.setup, false);
  }
  const withIt = decodeCompanionSetupValue({ ...validPayload(), abandonDronesHealthFloor: 0.1 });
  assert.equal(withIt.ok, true);
  if (withIt.ok) {
    assert.equal(withIt.setup.abandonDronesHealthFloor, 0.1);
  }
  assert.equal(decodeCompanionSetupValue({ ...validPayload(), abandonDronesHealthFloor: 0 }).ok, true);
});

test("abandonDronesHealthFloor is refused outside its bounds and when not a number", () => {
  for (const bad of [
    MIN_ABANDON_DRONES_HEALTH_FLOOR - 0.01,
    MAX_ABANDON_DRONES_HEALTH_FLOOR + 0.01,
    Number.NaN,
    "0.1",
    null,
  ]) {
    assert.equal(
      decodeCompanionSetupValue({ ...validPayload(), abandonDronesHealthFloor: bad }).ok,
      false,
      String(bad),
    );
  }
});

test("maxFleeAttempts is a bounded, positive, safe integer", () => {
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), maxFleeAttempts: MIN_FLEE_ATTEMPTS - 1 }).ok,
    false,
  );
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), maxFleeAttempts: MAX_FLEE_ATTEMPTS + 1 }).ok,
    false,
  );
  assert.equal(decodeCompanionSetupValue({ ...validPayload(), maxFleeAttempts: 2.5 }).ok, false);
  assert.equal(
    decodeCompanionSetupValue({ ...validPayload(), maxFleeAttempts: MAX_FLEE_ATTEMPTS }).ok,
    true,
  );
});

// ─── retired keys: accepted, ignored, never written back ────────────────────

// Every field a pre-2026-09-11 request carried and this codec no longer
// stores. A payload shaped like this is exactly what `hangarPrefs`
// localStorage and the BFF's persisted bot roster already have on disk for
// every squad configured before the simplification.
function oldShapePayload(): Record<string, unknown> {
  return {
    ...validPayload(),
    role: "dps",
    defenseModuleIDs: [SYNTHETIC_MODULE_ID],
    shieldBoosterModuleIDs: [SYNTHETIC_MODULE_ID],
    armorRepairerModuleIDs: [SYNTHETIC_MODULE_ID],
    hullRepairerModuleIDs: [SYNTHETIC_MODULE_ID],
    remoteShieldModuleIDs: [SYNTHETIC_MODULE_ID],
    remoteArmorModuleIDs: [SYNTHETIC_MODULE_ID],
    remoteCapacitorModuleIDs: [SYNTHETIC_MODULE_ID],
    weaponModuleIDs: [SYNTHETIC_MODULE_ID],
    deriveModulesFromFit: true,
    useDrones: true,
    attemptsTagging: true,
    obeys: ["broadcast", "tag"],
    chatCommandSenders: [SYNTHETIC_CHARACTER_ID],
    safeSpotBookmarkID: 4242,
    droneHealthFloor: 0.5,
    droneRedeployHoldOffSeconds: 10,
  };
}

test("a stored old-shape config decodes to a valid setup — every retired key at once", () => {
  const result = decodeCompanionSetupValue(oldShapePayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.setup, {
      fleeHealthFloor: 0.3,
      capacitorFloor: 0.2,
      maxFleeAttempts: 3,
      repairsAtStation: false,
    });
  }
});

const RETIRED_KEYS = [
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
  "droneHealthFloor",
  "droneRedeployHoldOffSeconds",
] as const;

test("each of the seventeen retired keys is accepted and dropped, one at a time", () => {
  const old = oldShapePayload();
  assert.equal(
    RETIRED_KEYS.length,
    17,
    "the list this test walks must match the spec's fifteen plus the two drone settings",
  );
  for (const key of RETIRED_KEYS) {
    const payload = { ...validPayload(), [key]: old[key] };
    const result = decodeCompanionSetupValue(payload);
    assert.equal(result.ok, true, `${key} alone should still decode`);
    if (result.ok) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(result.setup, key),
        `${key} must not be written back onto the decoded setup`,
      );
    }
  }
});

test("a garbage value under a retired key is still accepted, because it is never read", () => {
  // The whole point of "ignored" is that the value is thrown away without
  // being looked at — a malformed leftover must not resurrect the refusal
  // this key used to earn before it was retired.
  for (const bad of [null, "nonsense", 42, {}, [1, 2, 3]]) {
    const result = decodeCompanionSetupValue({ ...validPayload(), role: bad });
    assert.equal(result.ok, true, `garbage under a retired key must not refuse: ${JSON.stringify(bad)}`);
  }
});

// --- the persisted abandonment (decision 5's clock) --------------------------

test("a well-formed abandonment round-trips", () => {
  const result = decodeCompanionAbandonmentValue(
    { abandonedAtMs: 1_000, supervisorCharacterIDs: [SYNTHETIC_CHARACTER_ID] },
    2_000,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.abandonment.abandonedAtMs, 1_000);
    assert.deepEqual(result.abandonment.supervisorCharacterIDs, [SYNTHETIC_CHARACTER_ID]);
  }
});

test("an EMPTY supervisor list is valid, and means 'accept nobody'", () => {
  // It is what a companion abandoned before it ever saw a human legitimately
  // has. It must not be confused with a missing field, which is refused.
  const empty = decodeCompanionAbandonmentValue(
    { abandonedAtMs: 1_000, supervisorCharacterIDs: [] },
    2_000,
  );
  assert.equal(empty.ok, true);
  assert.equal(decodeCompanionAbandonmentValue({ abandonedAtMs: 1_000 }, 2_000).ok, false);
});

test("a clock in the FUTURE is refused — it would never expire", () => {
  // ⚠ The failure it would cause is the whole point of persisting it: an
  // abandonment dated an hour from now never runs out, which is exactly the
  // unbounded wait the persistence exists to prevent. A refused row starts a
  // fresh thirty minutes, which is bounded and safe.
  assert.equal(
    decodeCompanionAbandonmentValue({ abandonedAtMs: 9_000, supervisorCharacterIDs: [] }, 2_000).ok,
    false,
  );
});

test("an abandonment refuses junk rather than throwing", () => {
  for (const bad of [
    null,
    [],
    "now",
    { abandonedAtMs: 0, supervisorCharacterIDs: [] },
    { abandonedAtMs: 1.5, supervisorCharacterIDs: [] },
    { abandonedAtMs: 1_000, supervisorCharacterIDs: [0] },
    { abandonedAtMs: 1_000, supervisorCharacterIDs: "nobody" },
    { abandonedAtMs: 1_000, supervisorCharacterIDs: [], safeSpotWarpIssued: true },
  ]) {
    assert.equal(
      decodeCompanionAbandonmentValue(bad, 2_000).ok,
      false,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("a setup decoded from bytes produces the same run policy as one built in memory", () => {
  const result = decodeCompanionSetupValue(validPayload());
  assert.equal(result.ok, true);
  if (result.ok) {
    const policy = analyzeCompanionRunPolicy(result.setup);
    assert.deepEqual([...policy.riskClasses], ["combat", "fleet", "social"]);
  }
});
