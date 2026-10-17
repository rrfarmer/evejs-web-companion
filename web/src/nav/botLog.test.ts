// The flight recorder's HARD RULES, as tests. The log is automatic — no macro
// opts into it — and these are what keep it that way as the app grows.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describeAction, newRunID } from "./botLog.ts";
import type { ScriptAction } from "./scriptDecide.ts";

/**
 * One instance of EVERY action the runner can be handed. The test below proves
 * this list is complete against the union itself, so it cannot rot: add a
 * variant to `ScriptAction` and this file fails until it is represented here.
 */
const EVERY_ACTION: readonly ScriptAction[] = [
  { kind: "wait" },
  { kind: "undock" },
  { kind: "dock", stationID: 60003760 },
  { kind: "warp", targetID: 1001 },
  { kind: "approach", targetID: 1001 },
  { kind: "stopShip" },
  { kind: "align", targetID: 1001 },
  { kind: "orbit", targetID: 1001, range: 5000 },
  { kind: "keepAtRange", targetID: 1001, range: 2000 },
  { kind: "setFleetTargetTag", targetID: 1001, tag: "1" },
  { kind: "jump", fromGateID: 1, toGateID: 2 },
  { kind: "lock", targetID: 1001 },
  { kind: "unlock", targetID: 1001 },
  { kind: "activate", moduleID: 500, targetID: 1001 },
  { kind: "activate", moduleID: 500, targetID: 0 },
  { kind: "deactivate", moduleID: 500 },
  { kind: "loadCombatAmmo", moduleID: 500, chargeItemID: 501, chargeTypeID: 502 },
  { kind: "launchDrones", droneItemIDs: [11, 12] },
  { kind: "engageDrones", droneIDs: [11], targetID: 1001 },
  { kind: "mineDrones", droneIDs: [11], targetID: 1001 },
  { kind: "recallDrones", droneIDs: [11] },
  { kind: "unloadOre", itemIDs: [21] },
  { kind: "unloadOre", itemIDs: [21], division: 3 },
  { kind: "agentButton", agentID: 3019494, actionID: 4, label: "Accept" },
  { kind: "startRoute", stationID: 60003760 },
  { kind: "loadMissionCargo", typeID: 34, quantity: 5 },
  { kind: "unloadMissionCargo", itemIDs: [31], quantity: 10 },
  { kind: "unloadHolds", groups: [{ bay: null, itemIDs: [41] }, { bay: "ore", itemIDs: [42] }] },
  {
    kind: "loadHolds",
    groups: [
      { bay: "commandCenter", itemIDs: [43], qty: 6 },
      { bay: null, itemIDs: [44], qty: null },
    ],
  },
  { kind: "salvageDrones", droneIDs: [11], targetID: 0 },
  { kind: "lootWreck", wreckID: 51 },
  { kind: "lootContainer", containerID: 52 },
  { kind: "collectLaunch", containerID: 52, launchID: 72 },
  { kind: "collectCustoms", officeID: 1_200_040_000_001 },
  { kind: "exportCustoms", officeID: 1_200_040_000_001, pinID: 1054656331535, commodities: { 2268: 200, 2073: 50 } },
  { kind: "haulTransfer", itemID: 53, quantity: 1, from: { kind: "cargo" },
    to: { kind: "corp", division: 1 }, stationID: 60003760, corporationID: 98, division: 1,
    typeID: 34, sourceQuantity: 1 },
  { kind: "reprocessOre", itemIDs: [61] },
  { kind: "warpScan", target: "QEE-288" },
  { kind: "warpBookmark", bookmarkID: 71 },
  { kind: "addKnownFolder", folderID: 72 },
  { kind: "setFolderActive", folderID: 73, active: false },
  { kind: "moveBookmarks", fromFolderID: 74, toFolderID: 75, bookmarkIDs: [76] },
  { kind: "stopRoute" },
  { kind: "salvageBatch", steps: [{ kind: "lock", targetID: 77 }, { kind: "activate", moduleID: 78, targetID: 79 }, { kind: "deactivate", moduleID: 80 }] },
  { kind: "warpLaunch", launchID: 72 },
  { kind: "warpMissionLocation", agentID: 3018920, locationType: "dungeon", locationNumber: 0 },
  { kind: "boardShip", shipID: 81 },
  { kind: "applyFitting", fittingID: 91 },
  { kind: "restartExtractor", planetID: 40001, pinID: 40002, resourceTypeID: 2073, headRadius: 0.03 },
  {
    kind: "rerouteExtractor",
    planetID: 40001,
    pinID: 40002,
    removeRouteIDs: [7],
    create: [{ path: [40002, 40003], typeID: 2073, quantity: 95888 }],
  },
  { kind: "launchCommodities", planetID: 40001, commandPinID: 40003, commodities: { 2393: 300 } },
  { kind: "repairItems", itemIDs: [101] },
  { kind: "rememberBeltDry", systemName: "Obe", beltName: "Obe III - Asteroid Belt 1", groupID: null },
  { kind: "callPrimary", targetID: 1001 },
  { kind: "callPrimary", targetID: null },
  { kind: "moveItems", itemIDs: [111], from: "hangar", to: "cargo", qty: null },
  { kind: "placeBuyOrder", typeID: 34, quantity: 10, price: 5 },
  { kind: "placeSellOrder", itemID: 121, typeID: 34, price: 6, quantity: 1 },
  { kind: "jettison", itemIDs: [131] },
  { kind: "compressOre", itemID: 141, facilityID: 151 },
  { kind: "scannerLaunch" },
  { kind: "scannerAnalyze" },
  { kind: "scannerRecover" },
  { kind: "stackHangar" },
  { kind: "startSystemRoute", systemID: 30000142 },
  { kind: "createFleet" },
  { kind: "inviteToFleet", charID: 90000001 },
  { kind: "acceptFleetInvite", fleetID: null },
  { kind: "acceptFleetInvite", fleetID: 91000001 },
  { kind: "applyToJoinFleet", fleetID: 91000001 },
  { kind: "maintainMiningSupport", relocating: false },
  { kind: "stopMiningSupportOperation" },
  { kind: "gotoPoint", position: { x: 1, y: 2, z: 3 }, shipID: 81, solarSystemID: 30000142 },
  { kind: "bookmarkMiningSite", targetKey: "belt:1" },
  { kind: "reserveMiningTarget", targetType: "BELT", systemID: 30000142, systemName: "Obe", targetName: "Obe III - Asteroid Belt 1" },
  { kind: "activateMiningTarget", targetKey: "belt:1" },
  { kind: "depleteMiningTarget", targetKey: "belt:1", evidence: { rocks: 0 } },
  { kind: "miningMemberReady" },
  { kind: "miningDrainComplete", targetKey: "belt:1" },
  { kind: "alert", message: "your bot noticed something" },
];

/** The action kinds the union itself declares, read out of the source. */
function unionKinds(): ReadonlySet<string> {
  const source = readFileSync(fileURLToPath(new URL("./scriptDecide.ts", import.meta.url)), "utf8");
  const start = source.indexOf("export type ScriptAction =");
  assert.ok(start >= 0, "the action union moved");
  // The union runs until the next top-level declaration.
  const end = source.indexOf("\nexport ", start + 1);
  const body = source.slice(start, end < 0 ? undefined : end);
  return new Set([...body.matchAll(/readonly kind: "([a-zA-Z]+)"/g)].map((m) => m[1] as string));
}

// ── Rule 1: an action is DATA, not a call ────────────────────────────────────

test("every action is plain data, so a log line is just JSON", () => {
  for (const action of EVERY_ACTION) {
    const round = JSON.parse(JSON.stringify(action));
    assert.deepEqual(round, action, `${action.kind} did not survive a round trip`);
  }
});

// ── Rule 2: every action has a sentence, or the build fails ──────────────────

test("the fixture covers the union — a new action cannot slip past the log", () => {
  const declared = unionKinds();
  const covered = new Set(EVERY_ACTION.map((a) => a.kind));
  const missing = [...declared].filter((kind) => !covered.has(kind as ScriptAction["kind"]));
  assert.deepEqual(missing, [], "these action kinds have no fixture, so nothing proves they log");
  const stale = [...covered].filter((kind) => !declared.has(kind));
  assert.deepEqual(stale, [], "these fixtures name actions the union no longer has");
});

test("every action says something specific — never 'did something'", () => {
  for (const action of EVERY_ACTION) {
    const says = describeAction(action);
    assert.ok(says.length > 0, `${action.kind} has no sentence`);
    assert.doesNotMatch(says, /undefined|\[object/, `${action.kind} rendered a hole: ${says}`);
  }
});

test("the ids an operator needs are IN the sentence (this is not player copy)", () => {
  assert.match(describeAction({ kind: "lock", targetID: 1001 }), /1001/);
  assert.match(describeAction({ kind: "dock", stationID: 60003760 }), /60003760/);
  assert.match(describeAction({ kind: "activate", moduleID: 500, targetID: 0 }), /self/);
  assert.match(describeAction({ kind: "callPrimary", targetID: null }), /clear/i);
});

// ── Rule 3: only the runner performs ─────────────────────────────────────────

test("the deciders cannot call the world, so nothing can act unlogged", () => {
  for (const file of ["./scriptMacros.ts", "./scriptDecide.ts"]) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    const imports = [...source.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1] as string);
    const worldly = imports.filter((from) => /\/api\.ts$|^\.\.\/app\//.test(from));
    assert.deepEqual(worldly, [], `${file} imports something that can perform an action`);
  }
});

// ── The run id ───────────────────────────────────────────────────────────────

test("a run id is stable input in, distinct runs out", () => {
  assert.equal(newRunID(1_700_000_000_000, () => 0.5), newRunID(1_700_000_000_000, () => 0.5));
  assert.notEqual(newRunID(1_700_000_000_000, () => 0.1), newRunID(1_700_000_000_000, () => 0.9));
});
