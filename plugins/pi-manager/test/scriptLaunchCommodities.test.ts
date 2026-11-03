// The launch-commodities block's key transitions: only a command centre pin
// is ever targeted, the fill threshold (with its null-volume fallback), the
// 60s post-launch cooldown, one launch per tick with memory guarding against
// re-firing a stale read, the attempt guard, and that a launchpad/storage pin
// holding goods is never mistaken for a command centre. Pure, over fixture
// observations - same idiom as scriptMissionMacros.test.ts's restart-extractors
// coverage.

import test from "node:test";
import assert from "node:assert/strict";

import type { FlightStatus } from "../../../web/src/store/types.ts";
import type { MacroStep } from "../../../web/src/bots/botScript.ts";
import type { ScriptObservation } from "../../../web/src/nav/scriptConditions.ts";
import type { ScriptBoard } from "../../../web/src/nav/scriptDecide.ts";
import { MACROS as SCRIPT_MACROS } from "./harness.ts";

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return {
    inSpace: false, docked: true, solarSystemID: 30000142, stationID: 60000004, structureID: null,
    shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null,
    ...over,
  };
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

function step(args: MacroStep["args"] = {}): MacroStep {
  return { id: "s", kind: "macro", macro: "pi-manager:launch-commodities" as never, args };
}

// A ready-to-launch command pin: full past the default 80% threshold, no
// cooldown in effect.
function commandPin(over: Record<string, unknown> = {}) {
  return {
    pinID: 100,
    kind: "command",
    usedM3: 900,
    capacityM3: 1000,
    contents: [{ typeID: 3200, quantity: 40 }],
    lastLaunchAtMs: null,
    ...over,
  };
}

function colony(over: Record<string, unknown> = {}) {
  return {
    planetID: 40000001,
    planetName: "Matar V",
    extractors: [],
    pins: [commandPin()],
    ...over,
  };
}

const NB: ScriptBoard = {};
const launch = SCRIPT_MACROS["launch-commodities"]!;

test("unreadable colonies (null) -> waits, still acting, keeps memory - never read as nothing to launch", () => {
  const s = step();
  const t = launch(s, obs({ colonies: null } as never), { attempts: 3 }, NB);
  assert.equal(t.action.kind, "wait");
  assert.equal(t.outcome.kind, "acting");
  assert.equal(t.armed, false);
  assert.equal(t.nextMem["attempts"], 3);
});

test("no colonies -> done", () => {
  const s = step();
  const t = launch(s, obs({ colonies: [] } as never), {}, NB);
  assert.equal(t.outcome.kind, "done");
});

test("below the fill threshold -> nothing fires, done", () => {
  const s = step();
  const colonies = [colony({ pins: [commandPin({ usedM3: 700, capacityM3: 1000 })] })]; // 70% < 80%
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.equal(t.outcome.kind, "done");
});

test("at the fill threshold -> launches everything the command centre holds", () => {
  const s = step();
  const colonies = [
    colony({
      pins: [
        commandPin({
          usedM3: 800,
          capacityM3: 1000, // exactly 80% == default threshold
          contents: [{ typeID: 3200, quantity: 40 }, { typeID: 3201, quantity: 5 }],
        }),
      ],
    }),
  ];
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.ok(t.action.kind === "launchCommodities");
  if (t.action.kind === "launchCommodities") {
    assert.equal(t.action.planetID, 40000001);
    assert.equal(t.action.commandPinID, 100);
    assert.deepEqual(t.action.commodities, { 3200: 40, 3201: 5 });
  }
  assert.equal(t.outcome.kind, "acting");
  assert.equal(t.armed, false);
  assert.match(t.why, /Matar V/);
});

test("null volumes -> fill fraction cannot be stated, fall back to 'holding something' and fire", () => {
  const s = step();
  const colonies = [colony({ pins: [commandPin({ usedM3: null, capacityM3: null })] })];
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.equal(t.action.kind, "launchCommodities");
});

test("null capacity with empty contents -> never divides, never fires, just skips", () => {
  const s = step();
  const colonies = [colony({ pins: [commandPin({ usedM3: null, capacityM3: null, contents: [] })] })];
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.equal(t.outcome.kind, "done");
});

test("empty command centre -> skipped silently, done", () => {
  const s = step();
  const colonies = [colony({ pins: [commandPin({ contents: [] })] })];
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.equal(t.outcome.kind, "done");
});

test("60s cooldown -> skipped this tick, said out loud, never blocked", () => {
  const s = step();
  const recent = Date.now() - 30_000; // inside the 60s window
  const colonies = [colony({ pins: [commandPin({ lastLaunchAtMs: recent })] })];
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.equal(t.outcome.kind, "acting");
  assert.notEqual(t.outcome.kind, "blocked");
  assert.match(t.why, /cooldown/);
});

test("past the 60s cooldown -> ready again and fires", () => {
  const s = step();
  const old = Date.now() - 61_000;
  const colonies = [colony({ pins: [commandPin({ lastLaunchAtMs: old })] })];
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.equal(t.action.kind, "launchCommodities");
});

test("one launch per tick: memory stops the just-fired centre from firing again on the same stale read", () => {
  const s = step();
  const colonies = [
    colony({ planetID: 40000001, planetName: "Matar V", pins: [commandPin({ pinID: 100 })] }),
    colony({ planetID: 40000002, planetName: "Matar VI", pins: [commandPin({ pinID: 200 })] }),
  ];

  const first = launch(s, obs({ colonies } as never), {}, NB);
  assert.ok(first.action.kind === "launchCommodities" && first.action.commandPinID === 100);

  // Same (stale) colonies snapshot, but carrying forward the memory the first
  // tick returned - pin 100 must not fire twice; pin 200 fires instead.
  const second = launch(s, obs({ colonies } as never), first.nextMem, NB);
  assert.ok(second.action.kind === "launchCommodities" && second.action.commandPinID === 200);

  // Both fired now: a further stale read with the same memory finds nothing
  // left to do and reports done (not a third launch).
  const third = launch(s, obs({ colonies } as never), second.nextMem, NB);
  assert.equal(third.outcome.kind, "done");
});

test("a fresh read showing the centre emptied confirms the launch landed -> done", () => {
  const s = step();
  const firedColonies = [colony({ pins: [commandPin({ pinID: 100 })] })];
  const first = launch(s, obs({ colonies: firedColonies } as never), {}, NB);
  assert.equal(first.action.kind, "launchCommodities");

  const emptiedColonies = [colony({ pins: [commandPin({ pinID: 100, contents: [], usedM3: 0 })] })];
  const confirmed = launch(s, obs({ colonies: emptiedColonies } as never), first.nextMem, NB);
  assert.equal(confirmed.outcome.kind, "done");
});

test("attempt guard: launches that keep not landing stop the bot with a plain reason", () => {
  const s = step();
  const colonies = [colony({ pins: [commandPin()] })];
  const t = launch(s, obs({ colonies } as never), { attempts: 20, launched: [] }, NB);
  assert.equal(t.outcome.kind, "blocked");
  if (t.outcome.kind === "blocked") {
    assert.match(t.outcome.reason, /launches kept not/);
  }
});

test("a launchpad or storage pin holding goods is NEVER targeted, even instead of an empty command centre", () => {
  const s = step();
  const colonies = [
    colony({
      pins: [
        { pinID: 300, kind: "launchpad", usedM3: 500, capacityM3: 1000, contents: [{ typeID: 3200, quantity: 999 }], lastLaunchAtMs: null },
        { pinID: 301, kind: "storage", usedM3: 500, capacityM3: 1000, contents: [{ typeID: 3200, quantity: 999 }], lastLaunchAtMs: null },
        commandPin({ pinID: 100, contents: [] }), // the only pin this block may ever act on, and it is empty
      ],
    }),
  ];
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.notEqual(t.action.kind, "launchCommodities");
  assert.equal(t.outcome.kind, "done");
});

test("no command pin at all on a colony -> nothing to do there, done (never a launchpad/storage substitute)", () => {
  const s = step();
  const colonies = [
    colony({
      pins: [
        { pinID: 300, kind: "launchpad", usedM3: 900, capacityM3: 1000, contents: [{ typeID: 3200, quantity: 999 }], lastLaunchAtMs: null },
      ],
    }),
  ];
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.notEqual(t.action.kind, "launchCommodities");
  assert.equal(t.outcome.kind, "done");
});

test("fullPercent step arg overrides the default threshold", () => {
  const s = step({ fullPercent: { kind: "count", value: 50 } });
  const colonies = [colony({ pins: [commandPin({ usedM3: 600, capacityM3: 1000 })] })]; // 60% >= 50%, would fail default 80%
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.equal(t.action.kind, "launchCommodities");
});

test("anyAmount launches a positive stack below one percent full, even with a larger threshold", () => {
  const s = step({ anyAmount: { kind: "toggle", enabled: true }, fullPercent: { kind: "count", value: 90 } });
  const colonies = [colony({ pins: [commandPin({ usedM3: 1, capacityM3: 500 })] })];
  const t = launch(s, obs({ colonies } as never), {}, NB);
  assert.equal(t.action.kind, "launchCommodities");
});

test("a disabled anyAmount keeps the threshold, and an enabled one still skips empty or cooling centres", () => {
  const underfilled = colony({ pins: [commandPin({ usedM3: 1, capacityM3: 500 })] });
  const disabled = step({ anyAmount: { kind: "toggle", enabled: false }, fullPercent: { kind: "count", value: 50 } });
  assert.equal(launch(disabled, obs({ colonies: [underfilled] } as never), {}, NB).outcome.kind, "done");

  const enabled = step({ anyAmount: { kind: "toggle", enabled: true } });
  const empty = colony({ pins: [commandPin({ contents: [], usedM3: 0 })] });
  assert.equal(launch(enabled, obs({ colonies: [empty] } as never), {}, NB).outcome.kind, "done");
  const cooling = colony({ pins: [commandPin({ usedM3: 1, capacityM3: 500, lastLaunchAtMs: Date.now() - 30_000 })] });
  const t = launch(enabled, obs({ colonies: [cooling] } as never), {}, NB);
  assert.equal(t.action.kind, "wait");
  assert.equal(t.outcome.kind, "acting");
});

// ── limited to the ticked colonies (the PI window's Haul button) ─────────────

test("a planets list limits the launch to those colonies, and every other colony is left alone", () => {
  const ticked = colony({ planetID: 40000002, planetName: "Matar VI", pins: [commandPin({ pinID: 200 })] });
  const s = step({ planets: { kind: "planetList", planets: [{ planetID: 40000002, name: "Matar VI" }] } });
  const t = launch(s, obs({ colonies: [colony(), ticked] } as never), {}, NB);
  assert.ok(t.action.kind === "launchCommodities" && t.action.planetID === 40000002 && t.action.commandPinID === 200);
  // Once that one is fired, the untick'd colony is NOT next: the block is done.
  const after = launch(s, obs({ colonies: [colony(), ticked] } as never), t.nextMem, NB);
  assert.equal(after.outcome.kind, "done");
});

test("an empty planets list means every colony, as before", () => {
  const s = step({ planets: { kind: "planetList", planets: [] } });
  const t = launch(s, obs({ colonies: [colony()] } as never), {}, NB);
  assert.equal(t.action.kind, "launchCommodities");
});
