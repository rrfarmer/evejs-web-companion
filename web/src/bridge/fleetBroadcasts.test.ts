import test from "node:test";
import assert from "node:assert/strict";

import {
  FLEET_BROADCAST_CLASSIFICATION,
  FLEET_BROADCAST_NAMES,
  FLEET_BROADCAST_TTL_MS,
  broadcastHistoryLabel,
  decodeFleetBroadcastNotification,
  decodeFleetStateChangeNotification,
  fleetTravelDestination,
  isFleetBroadcastFresh,
} from "./fleetBroadcasts.ts";

test("decodes a broadcast with normal (already-numeric) positional args", () => {
  const broadcast = decodeFleetBroadcastNotification(
    "OnFleetBroadcast",
    ["Target", 3, 90000001, 30000142, 1099511628000, 670],
    1_000,
  );
  assert.deepEqual(broadcast, {
    name: "Target",
    scope: 3,
    senderCharID: 90000001,
    senderSolarSystemID: 30000142,
    itemID: 1099511628000,
    typeID: 670,
    receivedAtMs: 1_000,
  });
});

// ⚠ itemID/typeID skip server-side normalization and cross our web gateway's
// encodeJsonSafeCallValue, which turns a bigint into `.toString()` — a bare
// decimal string, not a {type:"long"} wrapper. A previous investigation
// concluded this shape was impossible and was wrong: it traced the binary
// marshal path the retail client uses, not the JSON path our gateway serves.
// A bare `unwrapLong` returns null for a string and would silently drop the
// broadcast's target; positiveSafeID (this module's local coercer) must not
// regress to that.
test("decodes itemID/typeID arriving as bare numeric strings", () => {
  const broadcast = decodeFleetBroadcastNotification(
    "OnFleetBroadcast",
    ["JumpTo", 2, "90000001", "30000142", "1099511628000", "670"],
    2_000,
  );
  assert.deepEqual(broadcast, {
    name: "JumpTo",
    scope: 2,
    senderCharID: 90000001,
    senderSolarSystemID: 30000142,
    itemID: 1099511628000,
    typeID: 670,
    receivedAtMs: 2_000,
  });
});

test("decodes itemID/typeID wrapped as a retail long", () => {
  const broadcast = decodeFleetBroadcastNotification(
    "OnFleetBroadcast",
    ["AlignTo", 1, 90000001, 30000142, { type: "long", value: "1099511628000" }, { type: "long", value: 670 }],
    3_000,
  );
  assert.equal(broadcast?.itemID, 1099511628000);
  assert.equal(broadcast?.typeID, 670);
});

test("a Travel To Me broadcast carries the system ID without a type ID", () => {
  const broadcast = decodeFleetBroadcastNotification(
    "OnFleetBroadcast",
    ["TravelTo", 3, 90000001, 30000142, 30000144, null],
    4_000,
  );
  assert.equal(broadcast?.itemID, 30000144);
  assert.equal(broadcast?.typeID, null);
  assert.equal(FLEET_BROADCAST_CLASSIFICATION.TravelTo.itemMeaning, "route-destination");
  assert.equal(FLEET_BROADCAST_CLASSIFICATION.TravelTo.act, true);
});

test("Travel To uses the explicit destination independent of type and falls back to the sender's system", () => {
  const senderSystemID = 30000142;
  for (const [itemID, typeID, expected] of [
    [30000144, 5, 30000144],
    [60003760, null, 60003760],
    [null, null, senderSystemID],
    [0, 5, senderSystemID],
  ]) {
    const broadcast = decodeFleetBroadcastNotification("OnFleetBroadcast", ["TravelTo", 3, 140000001, senderSystemID, itemID, typeID], 4_000);
    assert.ok(broadcast);
    assert.equal(fleetTravelDestination(broadcast), expected);
    assert.equal(broadcastHistoryLabel(broadcast).args.locationID, expected);
    assert.equal(fleetTravelDestination({ ...broadcast, name: "Location" }), null);
  }
});

test("null itemID/typeID decode to null, not a fabricated zero", () => {
  const broadcast = decodeFleetBroadcastNotification(
    "OnFleetBroadcast",
    ["EnemySpotted", 3, 90000001, 30000142, null, null],
    5_000,
  );
  assert.equal(broadcast?.itemID, null);
  assert.equal(broadcast?.typeID, null);
});

test("returns null for a different method", () => {
  assert.equal(
    decodeFleetBroadcastNotification("OnFleetInvite", ["Target", 3, 1, 2, 3, 4], 1),
    null,
  );
});

test("returns null for an unrecognised broadcast name (decode garbage, not a legal 16th kind)", () => {
  assert.equal(
    decodeFleetBroadcastNotification("OnFleetBroadcast", ["NotARealBroadcast", 3, 1, 2, 3, 4], 1),
    null,
  );
});

test("the classification table covers exactly the 15 legal names with the documented act/no-act split", () => {
  assert.deepEqual(Object.keys(FLEET_BROADCAST_CLASSIFICATION).sort(), [...FLEET_BROADCAST_NAMES].sort());

  // ⚠ `WarpTo` MOVED FROM noAct TO actOn ON 2026-09-11, because the reason it
  // sat in noAct was false. The table said the fleet warp "is executed
  // server-side once the broadcast lands"; `sendBroadcast` (fleetRuntime.js)
  // only ever calls `notifySession` and warps nobody. The server-side fleet
  // warp is a different command entirely (`CmdWarpToStuff` with `fleet=1`).
  const actOn = [
    "Target",
    "AlignTo",
    "JumpTo",
    "TravelTo",
    "WarpTo",
    "HealShield",
    "HealArmor",
    "HealCapacitor",
    "HealTarget",
  ];
  const noAct = ["JumpBeacon", "EnemySpotted", "NeedBackup", "HoldPosition", "InPosition", "Location"];
  for (const name of actOn) {
    assert.equal(FLEET_BROADCAST_CLASSIFICATION[name as keyof typeof FLEET_BROADCAST_CLASSIFICATION].act, true, name);
  }
  for (const name of noAct) {
    assert.equal(FLEET_BROADCAST_CLASSIFICATION[name as keyof typeof FLEET_BROADCAST_CLASSIFICATION].act, false, name);
  }

  // The "announcement only" group's itemID is GetNearestBall on the sender,
  // not an order — acting on it would warp a follower to a random nearby
  // object every time somebody broadcast "enemy spotted".
  for (const name of ["EnemySpotted", "NeedBackup", "HoldPosition", "InPosition", "Location"]) {
    assert.equal(
      FLEET_BROADCAST_CLASSIFICATION[name as keyof typeof FLEET_BROADCAST_CLASSIFICATION].itemMeaning,
      "nearest-ball",
      name,
    );
  }
});

test("fleet state tags: reads the KeyVal-wrapped targetTags field", () => {
  const tags = decodeFleetStateChangeNotification("OnFleetStateChange", [
    {
      type: "object",
      name: "util.KeyVal",
      args: {
        type: "dict",
        entries: [
          [
            "targetTags",
            {
              type: "dict",
              entries: [
                [1099511628000, "Primary"],
                [1099511628001, "Secondary"],
              ],
            },
          ],
        ],
      },
    },
  ]);
  assert.deepEqual(
    [...(tags ?? new Map())].sort(),
    [
      [1099511628000, "Primary"],
      [1099511628001, "Secondary"],
    ],
  );
});

test("fleet state tags: falls back to args[0] itself when the targetTags field is absent", () => {
  const tags = decodeFleetStateChangeNotification("OnFleetStateChange", [
    {
      type: "dict",
      entries: [[90000001, "Primary"]],
    },
  ]);
  assert.deepEqual([...(tags ?? new Map())], [[90000001, "Primary"]]);
});

test("fleet state tags: an authoritative empty map is distinct from null", () => {
  const noTags = decodeFleetStateChangeNotification("OnFleetStateChange", [
    { type: "dict", entries: [] },
  ]);
  assert.notEqual(noTags, null);
  assert.equal(noTags?.size, 0);

  const wrongMethod = decodeFleetStateChangeNotification("OnFleetBroadcast", [
    { type: "dict", entries: [] },
  ]);
  assert.equal(wrongMethod, null);
});

test("fleet state tags: an UNREADABLE payload is null, not an empty map", () => {
  // ⚠ THE SHARPEST EDGE OF THE null-VERSUS-EMPTY CONVENTION, and the one a
  // defensive decoder gets wrong by being helpful. `readDictPairs` answers []
  // both for an empty dict and for a value that is not a dict at all, so
  // counting entries alone would report an unparseable payload as "received,
  // and the fleet has tagged nothing".
  //
  // That is not a cosmetic lie. A companion allowed to WRITE tags reads
  // exactly that as permission to assign a letter, so it would stamp "A" on a
  // ship while the fleet already had an A this code merely failed to parse --
  // the tag collision the convention exists to prevent, and the one that makes
  // a fleet stop trusting its tags.
  for (const unreadable of [null, undefined, 42, "targetTags", [], { type: "list", items: [] }]) {
    assert.equal(
      decodeFleetStateChangeNotification("OnFleetStateChange", [unreadable]),
      null,
      `expected ${JSON.stringify(unreadable) ?? "undefined"} to read as unreadable`,
    );
  }
  // A KeyVal whose targetTags field is a real but empty dict is the OTHER
  // answer, and must survive: the fleet was read, and nothing is tagged.
  const emptyButRead = decodeFleetStateChangeNotification("OnFleetStateChange", [
    {
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries: [["targetTags", { type: "dict", entries: [] }]] },
    },
  ]);
  assert.notEqual(emptyButRead, null);
  assert.equal(emptyButRead?.size, 0);
});

test("fleet state tags: decodes defensively, dropping entries that don't decode cleanly", () => {
  const tags = decodeFleetStateChangeNotification("OnFleetStateChange", [
    {
      type: "dict",
      entries: [
        [90000001, "Primary"],
        [0, "ZeroIsNotAValidItemID"],
        [90000002, 12345],
        ["not-a-number", "Ignored"],
      ],
    },
  ]);
  assert.deepEqual([...(tags ?? new Map())], [[90000001, "Primary"]]);
});

test("broadcast freshness is a pure read-time check, not a timer", () => {
  const broadcast = decodeFleetBroadcastNotification(
    "OnFleetBroadcast",
    ["Target", 3, 90000001, 30000142, 90000050, 670],
    10_000,
  );
  assert.ok(broadcast);
  assert.equal(isFleetBroadcastFresh(broadcast, 10_000), true);
  assert.equal(isFleetBroadcastFresh(broadcast, 10_000 + FLEET_BROADCAST_TTL_MS - 1), true);
  assert.equal(isFleetBroadcastFresh(broadcast, 10_000 + FLEET_BROADCAST_TTL_MS), false);
  assert.equal(isFleetBroadcastFresh(broadcast, 10_000 + FLEET_BROADCAST_TTL_MS + 5_000), false);
});
