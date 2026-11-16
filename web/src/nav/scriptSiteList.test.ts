// The site list on the two site-warp blocks (issue 182): which scanner sites a
// block may fly to, by name. The matching itself is pinned in
// scanner/siteNames.test.ts; this file pins what the BLOCKS do with it.

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus, SpaceShipStatus, SpaceSnapshot, SpaceVector } from "../store/types.ts";
import type { MacroMemory, MacroTick, ScriptBoard } from "./scriptDecide.ts";
import type { ScannedAnomaly, ScriptObservation } from "./scriptConditions.ts";
import type { MacroStep, SiteListMode } from "../bots/botScript.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";

const ORIGIN: SpaceVector = { x: 0, y: 0, z: 0 };

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null, shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null, ...over };
}

function snapshot(): SpaceSnapshot {
  const ship = {
    itemID: 9001, typeID: 17476, name: "Procurer", mode: null, maxVelocity: 100, radius: 100,
    position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
    shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
  } as unknown as SpaceShipStatus;
  return { inSpace: true, solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1, entities: [], ship };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(), snapshot: null, lockedTargetIDs: [], holds: null, droneBayItemIDs: [],
    miningModuleIDs: [], startingStationID: null,
    systemName: "Test System",
    ...over,
  };
}

const den = (label: string, name: string | null | undefined): ScannedAnomaly =>
  name === undefined ? { label, kind: "combat" } : { label, kind: "combat", name };
const oreSite = (label: string, name: string | null): ScannedAnomaly => ({ label, kind: "ore", name });

function warpStep(macro: "warp-to-anomaly" | "warp-to-ore-anomaly", mode?: SiteListMode, names: string[] = []): MacroStep {
  return {
    id: "w",
    kind: "macro",
    macro,
    args: mode === undefined ? {} : { sites: { kind: "siteList", mode, names } },
  } as MacroStep;
}

const warp = SCRIPT_MACROS["warp-to-anomaly"]!;
const warpOre = SCRIPT_MACROS["warp-to-ore-anomaly"]!;
const mine = SCRIPT_MACROS["mine-at-belt"]!;

/** Phase 1 (commit the pick) then phase 2 (press), the way the runner drives it. */
function pickThenIssue(macro: typeof warp, step: MacroStep, observation: ScriptObservation, board: ScriptBoard = {}): MacroTick {
  const committed = macro(step, observation, {}, board);
  assert.equal(committed.action.kind, "wait", "phase 1 presses nothing");
  return macro(step, observation, committed.nextMem, board);
}

function warpTarget(t: MacroTick): string | null {
  return t.action.kind === "warpScan" ? t.action.target : null;
}

test("only: the block skips a den not on the list and flies to one that is", () => {
  const scanner = obs({ anomalies: [den("AAA-100", "Angel Den"), den("BBB-200", "Angel Haven")] });
  const t = pickThenIssue(warp, warpStep("warp-to-anomaly", "only", ["Haven"]), scanner);
  assert.equal(warpTarget(t), "BBB-200");
  assert.equal(t.why, "Warping to the next den, Angel Haven.", "the player reads which den was chosen");
});

test("only: Sanctum on the list never sends a fleet into a Forsaken Sanctum", () => {
  const scanner = obs({ anomalies: [den("AAA-100", "Guristas Forsaken Sanctum"), den("BBB-200", "Guristas Sanctum")] });
  assert.equal(warpTarget(pickThenIssue(warp, warpStep("warp-to-anomaly", "only", ["Sanctum"]), scanner)), "BBB-200");
  const forsaken = pickThenIssue(warp, warpStep("warp-to-anomaly", "only", ["Forsaken Sanctum"]), scanner);
  assert.equal(warpTarget(forsaken), "AAA-100");
});

test("skip: every den but the listed ones", () => {
  const scanner = obs({ anomalies: [den("AAA-100", "Serpentis Den"), den("BBB-200", "Serpentis Hidden Den")] });
  const t = pickThenIssue(warp, warpStep("warp-to-anomaly", "skip", ["Den"]), scanner);
  assert.equal(warpTarget(t), "BBB-200", "a Hidden Den is not a Den");
});

test("no list: the block behaves exactly as before, and writes no list onto the board", () => {
  const scanner = obs({ anomalies: [den("AAA-100", "Angel Den"), den("BBB-200", null)] });
  const t = pickThenIssue(warp, warpStep("warp-to-anomaly"), scanner);
  assert.equal(warpTarget(t), "AAA-100");
  assert.equal(t.boardPatch?.["anomsVisitedSiteList"], undefined);
});

test("the warp publishes the list on the board, and a later step without one clears it", () => {
  const scanner = obs({ anomalies: [den("BBB-200", "Angel Haven")] });
  const t = pickThenIssue(warp, warpStep("warp-to-anomaly", "only", ["Haven"]), scanner);
  assert.deepEqual(JSON.parse(String(t.boardPatch?.["anomsVisitedSiteList"])), { mode: "only", names: ["Haven"] });
  const cleared = pickThenIssue(warp, warpStep("warp-to-anomaly"), scanner, { anomsVisitedSiteList: String(t.boardPatch?.["anomsVisitedSiteList"]) });
  assert.equal(cleared.boardPatch?.["anomsVisitedSiteList"], "");
});

test("no den on the list: the bot stops and says which list ruled them out", () => {
  const scanner = obs({ anomalies: [den("AAA-100", "Angel Den"), den("BBB-200", "Angel Port")] });
  const t = warp(warpStep("warp-to-anomaly", "only", ["Haven", "Sanctum"]), scanner, {}, {});
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(
    t.outcome.kind === "blocked" ? t.outcome.reason : "",
    "The scanner lists 2 dens in this system, and your site list (only Haven or Sanctum) rules out every one.",
  );
});

test("a name not read yet is waited for, then treated as no name at all", () => {
  const step = warpStep("warp-to-anomaly", "skip", ["Den"]);
  const scanner = obs({ anomalies: [den("AAA-100", undefined)] });
  let mem: MacroMemory = {};
  for (let wait = 1; wait <= 5; wait += 1) {
    const t = warp(step, scanner, mem, {});
    assert.equal(t.action.kind, "wait");
    assert.equal(t.outcome.kind, "acting", `wait ${wait} keeps waiting`);
    assert.equal(t.why, "Reading the site names.");
    mem = t.nextMem;
  }
  const gaveUp = warp(step, scanner, mem, {});
  assert.equal(gaveUp.outcome.kind, "blocked");
  assert.match(
    gaveUp.outcome.kind === "blocked" ? gaveUp.outcome.reason : "",
    /It did not say its name, and with a site list set this block will not warp to a site it cannot name\.$/,
  );
});

test("the name arriving ends the wait and the pick goes ahead", () => {
  const step = warpStep("warp-to-anomaly", "only", ["Haven"]);
  const waiting = warp(step, obs({ anomalies: [den("AAA-100", undefined)] }), {}, {});
  assert.equal(waiting.why, "Reading the site names.");
  const named = obs({ anomalies: [den("AAA-100", "Blood Haven")] });
  const committed = warp(step, named, waiting.nextMem, {});
  assert.equal(committed.nextMem["target"], "AAA-100");
});

test("the ore block keeps to its list the same way", () => {
  const scanner = obs({
    anomalies: [oreSite("AAA-100", "Average Frontier Deposit"), oreSite("BBB-200", "Average Kernite and Omber Deposit")],
  });
  const t = pickThenIssue(warpOre, warpStep("warp-to-ore-anomaly", "only", ["Average Kernite and Omber Deposit"]), scanner);
  assert.equal(warpTarget(t), "BBB-200");
  assert.ok(String(t.boardPatch?.["oreAnomsVisitedSiteList"]).includes("Kernite"));
});

// ── Mine-at-a-belt moving on from a barren site reads the warp block's list ──

const siteMineStep: MacroStep = {
  id: "ms",
  kind: "macro",
  macro: "mine-at-belt",
  args: { belt: { kind: "belt", belt: { mode: "site" } } },
  until: { kind: "ore-hold-at-least", fraction: 0.9 },
} as MacroStep;

/** Feed the same barren grid until the block acts (it confirms an empty grid three times first). */
function mineUntilBarren(observation: ScriptObservation, board: ScriptBoard): MacroTick {
  let mem: MacroMemory = {};
  let last = mine(siteMineStep, observation, mem, board);
  for (let read = 1; read < 3; read += 1) {
    mem = last.nextMem;
    last = mine(siteMineStep, observation, mem, board);
  }
  if (last.outcome.kind === "acting" && last.nextMem["siteTarget"] !== undefined) {
    last = mine(siteMineStep, observation, last.nextMem, board);
  }
  return last;
}

test("mine (site mode): a barren site moves on to the next site the LIST allows, not merely the next one", () => {
  const sites = [
    oreSite("QEE-100", "Average Kernite Deposit"),
    oreSite("QEE-200", "Average Frontier Deposit"),
    oreSite("QEE-300", "Large Kernite Deposit"),
  ];
  const board: ScriptBoard = {
    oreAnomsVisited: "QEE-100",
    oreAnomsVisitedSiteList: JSON.stringify({ mode: "skip", names: ["Average Frontier Deposit"] }),
  };
  const t = mineUntilBarren(obs({ snapshot: snapshot(), anomalies: sites }), board);
  assert.equal(warpTarget(t), "QEE-300");
});

test("mine (site mode): with only ruled-out sites left, the stop names the list", () => {
  const sites = [oreSite("QEE-100", "Average Kernite Deposit"), oreSite("QEE-200", "Average Frontier Deposit")];
  const board: ScriptBoard = {
    oreAnomsVisited: "QEE-100",
    oreAnomsVisitedSiteList: JSON.stringify({ mode: "skip", names: ["Average Frontier Deposit"] }),
  };
  const t = mineUntilBarren(obs({ snapshot: snapshot(), anomalies: sites }), board);
  assert.equal(t.outcome.kind, "blocked");
  assert.equal(
    t.outcome.kind === "blocked" ? t.outcome.reason : "",
    "Every ore site in this system your site list allows (except Average Frontier Deposit) is mined out.",
  );
});
