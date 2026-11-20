// R25 slice A: the drone decoders.
//
// The whole file is about ONE distinction: null means "we could not look", and
// an empty array means "there is nothing there". For every other panel in this
// client that difference is a nicety; for drones it decides whether a player
// launches a second flight on top of the one already flying, or believes their
// drones are idle when nobody actually asked.

import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeDroneBay,
  decodeDroneEngageOutcome,
  decodeDroneLimits,
  decodeDroneOrderRefusals,
  decodeDronesInSpace,
  droneActivityLabel,
  droneIsBusy,
} from "./drones.ts";
import { describeRefusal, isPlainPlayerLanguage, UNKNOWN_REFUSAL_TEXT } from "./refusals.ts";
import type { DroneOrderRefusal } from "./drones.ts";
import type { JsonValue } from "./wire.ts";

/**
 * A dogmaIM.ShipGetInfo result carrying an attribute map, in the exact shape
 * the wire has it — a dict whose first entry holds a util.KeyVal whose
 * "attributes" key is the attributeID -> value dict. Deliberately built here
 * rather than hand-waved, because this is the shape the FITTING panel's decoder
 * already reads and R25 reuses it byte for byte instead of adding a call.
 */
function shipInfo(entries: readonly (readonly [number, number])[]): JsonValue {
  return {
    type: "dict",
    entries: [
      [
        "shipInfo",
        {
          args: {
            entries: [
              ["attributes", { type: "dict", entries: entries.map((pair) => [...pair]) }],
            ],
          },
        },
      ],
    ],
  } as unknown as JsonValue;
}

// --- The bay ----------------------------------------------------------------

test("an absent bay decodes to null, not an empty bay", () => {
  assert.equal(decodeDroneBay(undefined), null);
  assert.equal(decodeDroneBay(null), null);
  // ⚠ The two facts that must never collapse into one another.
  assert.deepEqual(decodeDroneBay([]), [], "an EMPTY array is a real, empty bay");
});

test("bay stacks decode itemID / typeID / quantity, long-wrapped or plain", () => {
  const bay = decodeDroneBay([
    { itemID: { type: "long", value: "7800001" }, typeID: 2456, quantity: 3 },
    { itemID: 7800002, typeID: 2486, quantity: 1 },
    // No usable identity — dropped rather than kept with a zero id.
    { typeID: 2456, quantity: 5 },
  ] as unknown as JsonValue);
  assert.deepEqual(bay, [
    { itemID: 7800001, typeID: 2456, quantity: 3 },
    { itemID: 7800002, typeID: 2486, quantity: 1 },
  ]);
});

// --- What is in space -------------------------------------------------------

test("an absent in-space list decodes to null — NEVER 'no drones out'", () => {
  assert.equal(decodeDronesInSpace(undefined), null);
  assert.equal(decodeDronesInSpace(null), null);
  assert.deepEqual(decodeDronesInSpace([]), []);
});

test("a drone's activity stays a WORD, and an unknown one stays null", () => {
  const drones = decodeDronesInSpace([
    { itemID: 9500001, typeID: 2456, name: "Hobgoblin I", activity: "fighting", targetID: 50002001 },
    // The gateway could not tell. This must NOT become "idle".
    { itemID: 9500002, typeID: 2456, name: "Hobgoblin I", activity: null, targetID: null },
    { itemID: 9500003, typeID: 2456, name: "Hobgoblin I", activity: "", targetID: null },
  ] as unknown as JsonValue);
  assert.equal(drones?.length, 3);
  assert.equal(drones?.[0]?.activity, "fighting");
  assert.equal(drones?.[0]?.targetID, 50002001);
  assert.equal(drones?.[1]?.activity, null);
  assert.equal(drones?.[2]?.activity, null, "an empty string is not an activity either");
});

test("health ratios clamp to 0-1 and an absent layer stays null", () => {
  const drones = decodeDronesInSpace([
    { itemID: 9500001, shieldRatio: 1.4, armorRatio: -0.2, hullRatio: 0.5 },
    { itemID: 9500002 },
  ] as unknown as JsonValue);
  assert.equal(drones?.length, 2);
  assert.equal(drones?.[0]?.shieldRatio, 1);
  assert.equal(drones?.[0]?.armorRatio, 0);
  assert.equal(drones?.[0]?.hullRatio, 0.5);
  assert.equal(drones?.[1]?.shieldRatio, null);
});

// ⚠ OWNED IS NOT FLOWN. The read keeps a drone this CHARACTER owns even when
// this hull does not control it, so an orphaned drone stays visible instead of
// quietly becoming someone else's salvage. Recall and Engage only work on the
// controlled ones, so the panel has to be able to tell them apart.
test("a drone carries whether THIS ship controls it", () => {
  const drones = decodeDronesInSpace([
    { itemID: 9500001, controlled: true },
    { itemID: 9500002, controlled: false },
  ] as unknown as JsonValue);
  assert.equal(drones?.[0]?.controlled, true);
  assert.equal(drones?.[1]?.controlled, false);
});

test("an absent control flag reads as NOT controlled — the safe way round", () => {
  // Offering recovery on a drone that may not need it is harmless; offering
  // Recall on one that cannot hear the order is the silent decline again.
  const drones = decodeDronesInSpace([{ itemID: 9500001 }] as unknown as JsonValue);
  assert.equal(drones?.[0]?.controlled, false);
});

// --- The limits -------------------------------------------------------------

test("the launch limits come out of the ship's ORDINARY attribute map", () => {
  // ⚠ No new server call: 352 (maxActiveDrones) and 1271 (droneBandwidth) ride
  // back in dogmaIM.ShipGetInfo, allowlisted since the fitting panel.
  const limits = decodeDroneLimits(shipInfo([[352, 5], [1271, 50]]));
  assert.deepEqual(limits, { maxActiveDrones: 5, droneBandwidth: 50 });
});

test("a hull with no drone dogma reports UNKNOWN, not zero", () => {
  // A confident 0 reads as "this ship may carry no drones", which is
  // indistinguishable from a read that simply did not answer.
  assert.deepEqual(decodeDroneLimits(shipInfo([[263, 300]])), {
    maxActiveDrones: null,
    droneBandwidth: null,
  });
  assert.deepEqual(decodeDroneLimits(undefined), {
    maxActiveDrones: null,
    droneBandwidth: null,
  });
  assert.deepEqual(decodeDroneLimits(null), {
    maxActiveDrones: null,
    droneBandwidth: null,
  });
});

// --- Player-facing wording (R9a) --------------------------------------------

test("every activity has the client's word, and no state says \"-\" (DRONE_STATES None)", () => {
  // dronesConst.DRONE_STATES as the 3698585 client words them
  assert.equal(droneActivityLabel("idle"), "Idle");
  assert.equal(droneActivityLabel("fighting"), "Fighting");
  assert.equal(droneActivityLabel("mining"), "Mining");
  assert.equal(droneActivityLabel("approaching"), "Approaching");
  assert.equal(droneActivityLabel("returning"), "Returning");
  assert.equal(droneActivityLabel("chasing"), "Following");
  assert.equal(droneActivityLabel("salvaging"), "Salvaging");
  // ⚠ NOT "Waiting". A player told their drones are idle when nobody looked
  // will not launch the ones that would have saved them.
  assert.equal(droneActivityLabel(null), "-");
  assert.equal(droneActivityLabel("something-new"), "Incapacitated");
});

test("nothing in the wording is a raw enum or an id", () => {
  for (const activity of [
    "idle",
    "fighting",
    "mining",
    "approaching",
    "returning",
    "chasing",
    "salvaging",
    null,
  ]) {
    const label = droneActivityLabel(activity);
    assert.doesNotMatch(label, /\d/, `"${label}" must contain no number (R7d)`);
  }
});

test("an unknown activity sorts with the drones you might give a job to", () => {
  assert.equal(droneIsBusy("fighting"), true);
  assert.equal(droneIsBusy("mining"), true);
  assert.equal(droneIsBusy("approaching"), true);
  assert.equal(droneIsBusy("idle"), false);
  assert.equal(droneIsBusy(null), false);
});

// --- R34: the thirteen sentences the server already wrote --------------------
//
// ⚠ THE SERVER WAS NEVER SILENT ABOUT ANY OF THIS. `droneRuntime.js` refuses a
// drone order one drone at a time and writes its reason into the call RESULT
// dict as it goes. The BFF forwarded only `outcome.notifications` and dropped
// `outcome.result`, so all thirteen sentences were destroyed in our own code
// before the browser ever had a chance to read one. These tests pin the
// recovery, and they pin it against the EXACT bytes the running emulator
// produced rather than a shape invented here.

/**
 * The live capture — the EXACT body `POST /api/bridge/drones/recall` returned
 * for the abandoned `Ice Harvesting Drone II` (`9988400023314`), measured by
 * R34 against the running emulator.
 *
 * ⚠ THE `type` TAGS ARE REAL AND THE FIXTURE MUST CARRY THEM. R33's writeup
 * quoted this payload WITHOUT them, and a decoder built to that quote would
 * have been tested against a shape the server does not send. The measured wire
 * keeps `{"type":"dict"}` on both dicts. The decoder ignores the tag and reads
 * `entries` either way — which is why the untagged variant is pinned
 * separately below rather than assumed to be the only shape.
 *
 * ⚠ AND THE CALL ANSWERED 200 WITH ZERO NOTIFICATIONS. That is the whole
 * defect in one line: the only channel the BFF forwarded was empty, and the
 * reason was sitting in the channel it discarded.
 */
const LIVE_ABANDONED_DRONE_RESULT: JsonValue = {
  type: "dict",
  entries: [
    [
      9988400023314,
      [
        "CustomNotify",
        {
          type: "dict",
          entries: [["notify", "That drone is not currently under this ship's control."]],
        },
      ],
    ],
  ],
};

/** The same payload with the `type` tags stripped, which some paths do emit. */
const UNTAGGED_ABANDONED_DRONE_RESULT: JsonValue = {
  entries: [
    [
      9988400023314,
      [
        "CustomNotify",
        { entries: [["notify", "That drone is not currently under this ship's control."]] },
      ],
    ],
  ],
};

/** Every sentence `appendDroneError` can write, read straight out of eve.js. */
const THE_THIRTEEN: readonly string[] = [
  "Drone is too far away to scoop into the bay.",
  "No owned salvageable wreck is available.",
  "That drone cannot currently be scooped into the drone bay.",
  "That drone cannot mine the selected resource.",
  "That drone has no supported engage profile.",
  "That drone has no supported mining profile.",
  "That drone is not currently under this ship's control.",
  "That drone is not in local space.",
  "That target cannot be engaged by drones.",
  "That target cannot be mined or salvaged by drones.",
  "That target cannot be salvaged by drones.",
  "That target is not visible to this drone.",
  "Unable to scoop that drone.",
];

/** One drone's error, in the tuple shape `buildDroneErrorTuple` makes. */
function droneError(droneID: JsonValue, message: string): JsonValue {
  return [droneID, ["CustomNotify", { entries: [["notify", message]] }]];
}

/**
 * The refusal at `index`, with the presence check `noUncheckedIndexedAccess`
 * requires. Asserting rather than `!`-ing keeps a decoder that returns too few
 * entries a TEST FAILURE instead of a crash three lines later.
 */
function at(refusals: readonly DroneOrderRefusal[], index: number): DroneOrderRefusal {
  const refusal = refusals[index];
  assert.ok(refusal, `expected a refusal at position ${index + 1}, got none`);
  return refusal;
}

test("R34: the live wire capture decodes to the drone and the server's sentence", () => {
  const refusals = decodeDroneOrderRefusals(LIVE_ABANDONED_DRONE_RESULT);
  assert.equal(refusals.length, 1);
  assert.equal(at(refusals, 0).droneID, 9988400023314);
  // VERBATIM. Not "close to", not "means the same as" — the same string.
  assert.equal(at(refusals, 0).raw, "That drone is not currently under this ship's control.");
});

test("R34: the same payload decodes with or without the marshal `type` tags", () => {
  // The decoder reads `entries` and ignores the tag, so a path that strips them
  // (or adds them) cannot silently blank a reason.
  assert.deepEqual(
    decodeDroneOrderRefusals(UNTAGGED_ABANDONED_DRONE_RESULT),
    decodeDroneOrderRefusals(LIVE_ABANDONED_DRONE_RESULT),
  );
});

test("R34: a result with no errors in it is no refusals — not an unknown", () => {
  // The success shape. `buildMultiDroneResult` answers an EMPTY dict when every
  // drone was obeyed, and an empty dict must not manufacture a complaint.
  assert.deepEqual(decodeDroneOrderRefusals({ entries: [] }), []);
  assert.deepEqual(decodeDroneOrderRefusals(null), []);
  assert.deepEqual(decodeDroneOrderRefusals(undefined), []);
});

test("R34: EVERY drone in a fan-out gets its own entry — none is collapsed", () => {
  // ⚠ THIS IS R30'S FINDING, MOVED TO THE SERVER SIDE OF THE FENCE. R30 proved
  // with two Strip Miner Is that a shared slot lets a later answer erase an
  // earlier refusal. A drone order fans out the same way, so three refused
  // drones must produce three reports — not one, and not "the last one".
  const refusals = decodeDroneOrderRefusals({
    entries: [
      droneError(101, "That drone is not currently under this ship's control."),
      droneError(102, "That target cannot be mined or salvaged by drones."),
      droneError(103, "That drone has no supported mining profile."),
    ],
  });
  assert.equal(refusals.length, 3);
  assert.deepEqual(
    refusals.map((refusal) => refusal.droneID),
    [101, 102, 103],
  );
  assert.deepEqual(
    refusals.map((refusal) => refusal.raw),
    [
      "That drone is not currently under this ship's control.",
      "That target cannot be mined or salvaged by drones.",
      "That drone has no supported mining profile.",
    ],
  );
});

test("R34: two drones refused for the SAME reason stay two drones", () => {
  // The exact collapse R30 measured, in its drone form. Deduplicating identical
  // sentences would read as "one drone was refused" when two were.
  const refusals = decodeDroneOrderRefusals({
    entries: [
      droneError(201, "That drone is not currently under this ship's control."),
      droneError(202, "That drone is not currently under this ship's control."),
    ],
  });
  assert.equal(refusals.length, 2);
  assert.notEqual(at(refusals, 0).droneID, at(refusals, 1).droneID);
});

test("R34: a long-wrapped droneID survives (the bridge decoder rule)", () => {
  // docs/bridge-wire-contract.md — ids decode with unwrapLong, never with the
  // `typeof === "number"` pattern that silently zeroes a wrapper. A drone id is
  // well past 2^32, and this is exactly where that rule earns its keep.
  const refusals = decodeDroneOrderRefusals({
    entries: [
      droneError({ type: "long", value: "9988400023314" }, "That drone is not in local space."),
    ],
  });
  assert.equal(refusals.length, 1);
  assert.equal(at(refusals, 0).droneID, 9988400023314);
});

test("R34: a malformed entry is skipped, and never costs the other drones", () => {
  const refusals = decodeDroneOrderRefusals({
    entries: [
      "not a pair",
      [],
      [0, ["CustomNotify", { entries: [["notify", "an id of zero is not a drone"]] }]],
      [301, ["CustomNotify", { entries: [["notify", "   "]] }]],
      droneError(302, "That target is not visible to this drone."),
    ],
  } as JsonValue);
  assert.equal(refusals.length, 1);
  assert.equal(at(refusals, 0).droneID, 302);
});

// --- R34: the wording is the SERVER'S, and stays the server's ----------------

test("R34: all thirteen sentences pass R9a AS WRITTEN — no translation needed", () => {
  // ⚠ THE WHOLE JUSTIFICATION FOR PASSING THEM THROUGH. R31's table exists to
  // turn CODES into prose; these are already prose, and re-spelling them would
  // be this client talking over a server that said it better. If this ever
  // fails, a sentence has changed on the server side and the pass-through has
  // to be re-argued — not silently patched with a lookup table.
  for (const sentence of THE_THIRTEEN) {
    assert.equal(
      isPlainPlayerLanguage(sentence),
      true,
      `the server's own sentence must read as player language: "${sentence}"`,
    );
  }
});

test("R34: every one of the thirteen reaches the player VERBATIM", () => {
  for (const sentence of THE_THIRTEEN) {
    const refusal = describeRefusal(sentence);
    assert.equal(refusal.text, sentence, "the server's sentence must not be reworded");
    // No detail, because nothing was translated and nothing was lost.
    assert.equal(refusal.detail, null);
  }
});

test("R34: an UNKNOWN sentence survives — it is not swallowed or genericised", () => {
  // ⚠ THE FOURTEENTH SENTENCE IS THE POINT. A thirteen-entry lookup table would
  // have looked correct today and silently blanked whatever eve.js adds next.
  // A sentence we have never seen is still a sentence, and the player gets it.
  const novel = "That drone has run out of something this client has never heard of.";
  const refusals = decodeDroneOrderRefusals({ entries: [droneError(401, novel)] });
  assert.equal(at(refusals, 0).raw, novel);
  assert.equal(describeRefusal(novel).text, novel);
});

test("R34: a CODE where a sentence was expected falls back to R31, not raw", () => {
  // The only guard: if what arrives is an identifier rather than prose, the
  // player must not be shown it. R31's generic wording answers, and the raw
  // text stays recoverable as `detail` for whoever has to chase it.
  const refusals = decodeDroneOrderRefusals({ entries: [droneError(501, "DroneNotUnderControl")] });
  // The decoder does NOT judge — it forwards what the server said.
  assert.equal(at(refusals, 0).raw, "DroneNotUnderControl");
  // The presentation seam does, and it refuses to print an identifier.
  const refusal = describeRefusal(at(refusals, 0).raw);
  assert.equal(refusal.text, UNKNOWN_REFUSAL_TEXT);
  assert.equal(refusal.detail, "DroneNotUnderControl");
  assert.equal(isPlainPlayerLanguage(refusal.text), true);
});

test("R34: the decoder never invents a sentence the server did not send", () => {
  // An entry whose value carries no notify text at all yields NOTHING, rather
  // than a placeholder that would read as a refusal the server never made.
  const refusals = decodeDroneOrderRefusals({
    entries: [[601, ["CustomNotify", { entries: [["somethingElse", "not a notify key"]] }]]],
  } as JsonValue);
  assert.deepEqual(refusals, []);
});

// --- one drone, one row -------------------------------------------------------
//
// Both lists are rendered by a keyed `{#each ... (itemID)}`, which throws rather
// than draw when handed the same key twice — and that throw takes the whole
// render flush with it. A repeat on the wire is the same drone, not a new one.

test("a bay that lists the same stack twice yields one stack", () => {
  const bay = decodeDroneBay([
    { itemID: 501, typeID: 2456, quantity: 5 },
    { itemID: 502, typeID: 2456, quantity: 3 },
    { itemID: 501, typeID: 2456, quantity: 5 },
  ] as unknown as JsonValue);
  assert.deepEqual((bay ?? []).map((stack) => stack.itemID), [501, 502]);
});

test("a snapshot that lists the same drone twice yields one drone", () => {
  const drones = decodeDronesInSpace([
    { itemID: 601, typeID: 2456, activity: "Attacking" },
    { itemID: 601, typeID: 2456, activity: "Attacking" },
    { itemID: 602, typeID: 2456, activity: null },
  ] as unknown as JsonValue);
  assert.deepEqual((drones ?? []).map((drone) => drone.itemID), [601, 602]);
});

const ENGAGE_TARGET = 300001;
const engagedDrone = (itemID: number, targetID: number | null = ENGAGE_TARGET) => ({
  itemID, controlled: true, targetID, activity: "fighting",
});

test("Engage confirms combat and repair assignments from the authoritative controlled target", () => {
  for (const activity of ["fighting", "approaching", "chasing", null]) {
    assert.deepEqual(decodeDroneEngageOutcome({ type: "dict", entries: [] }, [
      { ...engagedDrone(601), activity },
    ], [601], ENGAGE_TARGET), {
      status: "accepted", acceptedDroneIDs: [601], refusedDroneIDs: [], uncertainDroneIDs: [], refusals: [],
    });
  }
});

test("Engage preserves accepted and explicitly refused subsets of one flight", () => {
  const result = { type: "dict", entries: [droneError(602, "That target is out of drone control range.")] };
  assert.deepEqual(decodeDroneEngageOutcome(result, [engagedDrone(601), engagedDrone(602)], [601, 602], ENGAGE_TARGET), {
    status: "refused", acceptedDroneIDs: [601], refusedDroneIDs: [602], uncertainDroneIDs: [],
    refusals: [{ droneID: 602, errorKey: "CustomNotify", raw: "That target is out of drone control range." }],
  }, "an existing target assignment does not override this call's explicit refusal");
});

test("Engage recognizes named UserError tuples and long drone ids without requiring prose", () => {
  assert.deepEqual(decodeDroneEngageOutcome({ entries: [
    [{ type: "long", value: "602" }, ["SafetyActivated", { type: "dict", entries: [] }]],
  ] }, null, [602], ENGAGE_TARGET), {
    status: "refused", acceptedDroneIDs: [], refusedDroneIDs: [602], uncertainDroneIDs: [],
    refusals: [{ droneID: 602, errorKey: "SafetyActivated", raw: "SafetyActivated" }],
  });
});

test("Engage retains definite refusals while an omitted drone's outcome is unknown", () => {
  assert.deepEqual(decodeDroneEngageOutcome({ entries: [droneError(602, "Not visible.")] },
    [engagedDrone(601, null), engagedDrone(602)], [601, 602], ENGAGE_TARGET), {
    status: "uncertain", acceptedDroneIDs: [], refusedDroneIDs: [602], uncertainDroneIDs: [601],
    refusals: [{ droneID: 602, errorKey: "CustomNotify", raw: "Not visible." }],
  });
});

test("Engage cannot infer acceptance from an empty dict with unreadable or inconsistent post-state", () => {
  for (const flight of [null, [], [engagedDrone(601, null)], [{ ...engagedDrone(601), controlled: false }],
    [{ itemID: 601, targetID: ENGAGE_TARGET }], [engagedDrone(601), engagedDrone(601)]]) {
    assert.deepEqual(decodeDroneEngageOutcome({ entries: [] }, flight, [601], ENGAGE_TARGET), {
      status: "uncertain", acceptedDroneIDs: [], refusedDroneIDs: [], uncertainDroneIDs: [601], refusals: [],
    });
  }
});

test("Engage cannot infer acceptance or a safe retry from malformed result entries", () => {
  const malformed: JsonValue[] = [null, {}, { entries: [droneError(999, "Foreign drone.")] },
    { entries: [[601, null]] }, { entries: [droneError(601, "No."), droneError(601, "No.")] },
    { entries: [[601, ["CustomNotify", null]]] }];
  for (const result of malformed) {
    assert.deepEqual(decodeDroneEngageOutcome(result, [engagedDrone(601)], [601], ENGAGE_TARGET), {
      status: "uncertain", acceptedDroneIDs: [], refusedDroneIDs: [], uncertainDroneIDs: [601], refusals: [],
    });
  }
});
