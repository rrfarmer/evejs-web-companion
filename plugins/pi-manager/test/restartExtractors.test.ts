// restart-extractors, one tick at a time (moved from core's
// scriptMissionMacros.test.ts with the block).

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus } from "../../../web/src/store/types.ts";
import type { MacroStep } from "../../../web/src/bots/botScript.ts";
import type { ScriptObservation } from "../../../web/src/nav/scriptConditions.ts";
import type { MacroMemory, ScriptBoard } from "../../../web/src/nav/scriptDecide.ts";
import { MACROS as SCRIPT_MACROS } from "./harness.ts";

const AGENT_STATION = 60000004;

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return { inSpace: false, docked: true, solarSystemID: 30000142, stationID: AGENT_STATION, structureID: null, shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null, ...over };
}

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: false, docked: true, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(), journal: { active: [], offered: [] },
    ...over,
  };
}

function step(macro: MacroStep["macro"], args: MacroStep["args"] = {}): MacroStep {
  return { id: "s", kind: "macro", macro, args };
}

const NB: ScriptBoard = {};

test("restart-extractors: restarts only EXPIRED programs on their own resource, one per tick", () => {
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("pi-manager:restart-extractors");
  const past = Date.now() - 60_000;
  const future = Date.now() + 60_000;
  const colonies = [
    {
      planetID: 40000001,
      planetName: "Matar V",
      extractors: [
        { pinID: 1, resourceTypeID: 2268, expiresAtMs: past, headRadius: 0.03 }, // expired -> restart
        { pinID: 2, resourceTypeID: 2305, expiresAtMs: future, headRadius: 0.02 }, // running -> leave
        { pinID: 3, resourceTypeID: null, expiresAtMs: past, headRadius: 0.02 }, // unknown resource -> never guess
        { pinID: 4, resourceTypeID: 2305, expiresAtMs: past, headRadius: null }, // unknown area -> never guess
      ],
    },
  ];

  const first = restart(s, obs({ colonies } as never), {}, NB);
  assert.ok(first.action.kind === "restartExtractor" && first.action.pinID === 1 && first.action.resourceTypeID === 2268);
  // The drill area goes back UNCHANGED: it is what sets how long the program runs.
  assert.equal(first.action.headRadius, 0.03);

  // The re-read shows pin 1 running again. The unknown-resource and
  // unknown-area pins are SKIPPED (with the skip said out loud), and the
  // running one untouched -> done.
  const after = [
    { ...colonies[0]!, extractors: colonies[0]!.extractors.map((pin) => (pin.pinID === 1 ? { ...pin, expiresAtMs: future } : pin)) },
  ];
  const second = restart(s, obs({ colonies: after } as never), first.nextMem, NB);
  assert.equal(second.outcome.kind, "done");
  assert.match(second.why, /2 extractors .*left alone/);

  // No colonies at all -> done, plainly.
  const none = restart(s, obs({ colonies: [] } as never), {}, NB);
  assert.equal(none.outcome.kind, "done");
});

test("restart-extractors: a restart the server refused ends the run BLOCKED, not done", () => {
  // Live, every restart came back "completely bonkers radius" and the run still
  // ended "Every extractor is running." A tried pin that still reads expired on
  // the next read was refused, and the player has to hear that.
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("pi-manager:restart-extractors");
  const past = Date.now() - 60_000;
  const colonies = [
    {
      planetID: 40000001,
      planetName: "Matar V",
      extractors: [{ pinID: 1, resourceTypeID: 2268, expiresAtMs: past, headRadius: 0.03 }],
    },
  ];
  const first = restart(s, obs({ colonies } as never), {}, NB);
  assert.equal(first.action.kind, "restartExtractor");
  // The re-read still shows it expired: refused.
  const second = restart(s, obs({ colonies } as never), first.nextMem, NB);
  assert.equal(second.outcome.kind, "blocked");
  assert.match(second.outcome.kind === "blocked" ? second.outcome.reason : "", /1 of 1 extractor restart did not take/);
});

test("restart-extractors: after the restarts land, routes sized for the old program are re-sized, then done", () => {
  // Live: a restart raised the yield, the emulator never grows routes, and the
  // game flagged the colony while every factory was running.
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("pi-manager:restart-extractors");
  const past = Date.now() - 60_000;
  const future = Date.now() + 60_000;
  const plan = {
    planetID: 40000001,
    pinID: 1,
    removeRouteIDs: [7],
    create: [{ path: [1, 2], typeID: 2268, quantity: 35608 }],
  };
  const expired = [{
    planetID: 40000001,
    planetName: "Matar V",
    extractors: [{ pinID: 1, resourceTypeID: 2268, expiresAtMs: past, headRadius: 0.03 }],
    reroutes: [],
  }];
  const first = restart(s, obs({ colonies: expired } as never), {}, NB);
  assert.equal(first.action.kind, "restartExtractor");

  // The re-read: running again, and its route now short of the new maximum.
  const running = [{ ...expired[0]!, extractors: [{ ...expired[0]!.extractors[0]!, expiresAtMs: future }], reroutes: [plan] }];
  const second = restart(s, obs({ colonies: running } as never), first.nextMem, NB);
  assert.deepEqual(second.action, { kind: "rerouteExtractor", ...plan });

  // Settled on the next read -> done.
  const settled = [{ ...running[0]!, reroutes: [] }];
  const third = restart(s, obs({ colonies: settled } as never), second.nextMem, NB);
  assert.equal(third.outcome.kind, "done");

  // Still short after its edit -> refused, and said so.
  const refused = restart(s, obs({ colonies: running } as never), second.nextMem, NB);
  assert.equal(refused.outcome.kind, "blocked");
  assert.match(refused.outcome.kind === "blocked" ? refused.outcome.reason : "", /1 extractor reroute did not take/);
});

test("restart-extractors: a roster of twelve expired extractors is restarted and re-sized to the end, not stopped on a fixed cap", () => {
  // Live: six colonies of two extractors each, all expired. Every restart and
  // reroute landed, and the run stopped on its 21st action saying the
  // reroutes "kept not taking", because the two shared a cap of 20.
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("pi-manager:restart-extractors");
  const past = Date.now() - 60_000;
  const future = Date.now() + 60_000;
  const running = new Set<number>();
  const rerouted = new Set<number>();
  const colonies = () => [1, 2, 3, 4, 5, 6].map((n) => {
    const pins = [n * 10, n * 10 + 1];
    return {
      planetID: 40000000 + n,
      planetName: `Matar ${n}`,
      extractors: pins.map((pinID) => ({ pinID, resourceTypeID: 2268, expiresAtMs: running.has(pinID) ? future : past, headRadius: 0.03 })),
      // A restarted extractor's routes are short of its new maximum until re-sized.
      reroutes: pins.filter((pinID) => running.has(pinID) && !rerouted.has(pinID)).map((pinID) => ({
        planetID: 40000000 + n, pinID, removeRouteIDs: [pinID], create: [{ path: [pinID, 99], typeID: 2268, quantity: 10 }],
      })),
    };
  });
  let mem: MacroMemory = {};
  const kinds: string[] = [];
  for (let tickNo = 0; tickNo < 40; tickNo += 1) {
    const t = restart(s, obs({ colonies: colonies() } as never), mem, NB);
    if (t.outcome.kind !== "acting") {
      assert.equal(t.outcome.kind, "done", t.outcome.kind === "blocked" ? t.outcome.reason : "");
      break;
    }
    const action = t.action as { kind: string; pinID: number };
    kinds.push(action.kind);
    // Each edit lands, as every one did live.
    (action.kind === "restartExtractor" ? running : rerouted).add(action.pinID);
    mem = t.nextMem;
  }
  assert.equal(kinds.filter((kind) => kind === "restartExtractor").length, 12);
  assert.equal(kinds.filter((kind) => kind === "rerouteExtractor").length, 12);
});

test("restart-extractors: a colony with nothing expired still gets its stale routes fixed", () => {
  const restart = SCRIPT_MACROS["restart-extractors"]!;
  const s = step("pi-manager:restart-extractors");
  const colonies = [{
    planetID: 40000001,
    planetName: "Matar V",
    extractors: [{ pinID: 1, resourceTypeID: 2268, expiresAtMs: Date.now() + 60_000, headRadius: 0.03 }],
    reroutes: [{ planetID: 40000001, pinID: 1, removeRouteIDs: [7], create: [{ path: [1, 2], typeID: 2268, quantity: 10 }] }],
  }];
  assert.equal(restart(s, obs({ colonies } as never), {}, NB).action.kind, "rerouteExtractor");
});
