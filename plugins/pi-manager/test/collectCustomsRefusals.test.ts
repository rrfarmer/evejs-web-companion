// Refusals in the PI blocks through the REAL runner, as scriptRunnerRefusals.test.ts
// drives core's (moved here with the blocks).


import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, InterruptRow, MacroStep, ProgramNode } from "../../../web/src/bots/botScript.ts";
import type { ScriptObservation } from "../../../web/src/nav/scriptConditions.ts";
import type { SpaceEntity, SpaceSnapshot } from "../../../web/src/store/types.ts";
import type { HomeTravelDecider, MacroDecider, ScriptAction } from "../../../web/src/nav/scriptDecide.ts";
import { MACROS as SCRIPT_MACROS } from "./harness.ts";
import { scriptTravelHome } from "../../../web/src/nav/scriptMacros.ts";
import { createScriptRunner } from "../../../web/src/nav/scriptRunner.ts";

const ORIGIN = { x: 0, y: 0, z: 0 };
const AU = 149_597_870_700;

function calm(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: { inSpace: true, docked: false, solarSystemID: 30000142, stationID: null, structureID: null,
      shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null },
    lockedTargetIDs: [], holds: null, droneBayItemIDs: [], miningModuleIDs: [], startingStationID: null,
    systemName: "Test System",
    ...over,
  } as ScriptObservation;
}

function rock(itemID: number, x: number): SpaceEntity {
  return {
    itemID, kind: "celestial", typeID: 1, groupID: 1, categoryID: 2, name: "Veldspar", ownerID: null,
    radius: 10, position: { x, y: 0, z: 0 }, velocity: ORIGIN, isSelf: false,
    shieldRatio: null, armorRatio: null, hullRatio: null, characterID: null, corporationID: null,
    allianceID: null, securityStatus: null, maxVelocity: null, mode: null, capacitorRatio: null,
    remainingQuantity: null, miningYieldTypeID: 1230, beltID: 40001, oreGrade: null,
    oreValuePerM3: null, isNpc: false, npcEntityType: null,
    controllerID: null, droneActivity: null, targetEntityID: null,
  } as SpaceEntity;
}

function space(entities: SpaceEntity[]): SpaceSnapshot {
  return {
    inSpace: true, solarSystemID: 30000142, shipID: 9001, sampledAtMs: 1, entities,
    ship: {
      itemID: 9001, typeID: 17476, name: "Procurer", mode: null, maxVelocity: 100, radius: 100,
      position: ORIGIN, velocity: ORIGIN, shieldRatio: 1, armorRatio: 1, hullRatio: 1, capacitorRatio: 1,
      shieldCapacity: null, armorCapacity: null, hullCapacity: null, activeModuleIDs: [],
      overloadedModuleIDs: null, moduleDamage: null, weaponBanks: null,
    },
  };
}

const home: HomeTravelDecider = () => ({
  action: { kind: "wait" }, why: "home", phase: "Heading home", armed: true, outcome: { kind: "acting" }, nextMem: {},
});

function script(program: readonly ProgramNode[], watches: readonly InterruptRow[] = []): BotScript {
  return {
    format: "evejs-bot-script", version: 1, name: "t", notes: "",
    home: { entity: "station", id: 1, name: "Home", systemName: null },
    interrupts: [{ id: "floor", when: { kind: "health-below", fraction: 0.5 }, respond: "dock-and-pause" }, ...watches],
    program,
  };
}

const REFUSED_WARP = "CALL_REFUSED: You cannot warp there right now.";
const REFUSED_LOCK = "CALL_REFUSED: TargetNotWithinRangeGeneric";

/** The runner, the real macros, and an `issue` that throws whatever `refuse` says. */
function rig(
  program: readonly ProgramNode[],
  observation: () => ScriptObservation,
  refuse: (action: ScriptAction) => string | null,
  registry: Record<string, MacroDecider> = SCRIPT_MACROS as unknown as Record<string, MacroDecider>,
  watches: readonly InterruptRow[] = [],
  travelHome: HomeTravelDecider = home,
) {
  const issued: ScriptAction[] = [];
  /** Every status line the run showed, in order: how a test sees which rung a block reached. */
  const said: string[] = [];
  const runner = createScriptRunner({
    observe: async () => observation(),
    issue: async (action) => {
      issued.push(action);
      const words = refuse(action);
      if (words !== null) {
        throw new Error(words);
      }
      return null;
    },
    sleep: async () => {},
    onProgress: (snapshot) => {
      if (snapshot.why !== null) said.push(snapshot.why);
    },
    isSessionLost: () => false,
    refusalReason: (error) => (error instanceof Error ? error.message : String(error)),
    registry: registry as never,
    travelHome,
  });
  runner.start(script(program, watches));
  const run = async (ticks: number, until: () => boolean = () => false): Promise<void> => {
    for (let i = 0; i < ticks && runner.getStatus() === "running" && !until(); i += 1) {
      await runner.tick();
    }
  };
  return { runner, issued, said, run };
}

const oreSite = (label: string, x: number) => ({ label, kind: "ore" as const, position: { x, y: 0, z: 0 } });
const warpStep: MacroStep = { id: "w", kind: "macro", macro: "warp-to-ore-anomaly", args: {} };
const marker: MacroStep = { id: "u", kind: "macro", macro: "undock", args: {} };
const mineStep: MacroStep = {
  id: "m", kind: "macro", macro: "mine-at-belt",
  args: { belt: { kind: "belt", belt: { mode: "nearest" } } },
  until: { kind: "ore-hold-at-least", fraction: 0.9 },
};

/** `undock` stands in for "the block after the warp": reaching it proves the warp step finished. */
function withMarker() {
  const state = { reached: false };
  const registry = {
    ...(SCRIPT_MACROS as unknown as Record<string, MacroDecider>),
    undock: ((_step, _obs) => {
      state.reached = true;
      return { action: { kind: "wait" }, why: "reached", phase: "Reached", armed: true, outcome: { kind: "done" }, nextMem: {} };
    }) as MacroDecider,
  };
  return { state, registry };
}

const customsStep: MacroStep = { id: "cc", kind: "macro", macro: "pi-manager:collect-customs", args: {} };
const CUSTOMS_OFFICE = 1_200_040_000_001;
const CUSTOMS_PLANET = 40000001;

function customsOffice(): SpaceEntity {
  return { ...rock(CUSTOMS_OFFICE, 1000), kind: "orbital", typeID: 2233, groupID: 1025, categoryID: 46, name: "Customs Office",
    miningYieldTypeID: null, beltID: null, planetID: CUSTOMS_PLANET } as SpaceEntity;
}

test("collect-customs: a launchpad the server refuses is tried five times and left; the next launchpad goes up and the office is emptied", async () => {
  const { state, registry } = withMarker();
  const world = { pads: new Map<number, [number, number][]>([[501, [[2268, 200]]], [502, [[2073, 50]]]]), office: 0 };
  const { issued, run, runner } = rig(
    [customsStep, marker],
    () => calm({
      snapshot: space([customsOffice()]),
      customsOffices: [{ officeID: CUSTOMS_OFFICE, stacks: world.office > 0 ? 1 : 0, units: world.office }],
      colonies: [{ planetID: CUSTOMS_PLANET, planetName: null, extractors: [], pins: [...world.pads].map(([pinID, contents]) => ({
        pinID, kind: "launchpad" as const, usedM3: null, capacityM3: null, lastLaunchAtMs: null,
        contents: contents.map(([typeID, quantity]) => ({ typeID, quantity })),
      })) }],
    }),
    (action) => {
      if (action.kind === "exportCustoms") {
        if (action.pinID === 501) return "CALL_REFUSED: CannotLaunchCommoditiesNotFound";
        world.office += Object.values(action.commodities).reduce((total, quantity) => total + quantity, 0);
        world.pads.set(action.pinID, []);
      }
      if (action.kind === "collectCustoms") world.office = 0;
      return null;
    },
    registry,
  );
  await run(400, () => state.reached);
  assert.equal(state.reached, true, "the block ended and the program moved on");
  const sentUp = issued.filter((action): action is Extract<ScriptAction, { kind: "exportCustoms" }> => action.kind === "exportCustoms");
  assert.deepEqual([sentUp.filter((action) => action.pinID === 501).length, sentUp.filter((action) => action.pinID === 502).length], [5, 1]);
  assert.deepEqual(sentUp.find((action) => action.pinID === 502), { kind: "exportCustoms", officeID: CUSTOMS_OFFICE, pinID: 502, commodities: { 2073: 50 } });
  assert.equal(issued.filter((action) => action.kind === "collectCustoms").length, 1);
  assert.deepEqual([world.office, world.pads.get(501)!.length, world.pads.get(502)!.length], [0, 1, 0]);
  assert.notEqual(runner.getStatus(), "error");
});

test("collect-customs: a launchpad the wallet cannot pay the tax on stops the run at once, saying why", async () => {
  const { state, registry } = withMarker();
  const world = { pads: new Map<number, [number, number][]>([[501, [[2390, 24260]]], [502, [[2073, 50]]]]) };
  // Home is reached at once, so the stop lands as a pause carrying its reason.
  const arrived: HomeTravelDecider = () => ({
    action: { kind: "wait" }, why: "Stopped.", phase: "Heading home", armed: false, outcome: { kind: "done" }, nextMem: {},
  });
  const { issued, run, runner } = rig(
    [customsStep, marker],
    () => calm({
      snapshot: space([customsOffice()]),
      customsOffices: [{ officeID: CUSTOMS_OFFICE, stacks: 0, units: 0 }],
      colonies: [{ planetID: CUSTOMS_PLANET, planetName: null, extractors: [], pins: [...world.pads].map(([pinID, contents]) => ({
        pinID, kind: "launchpad" as const, usedM3: null, capacityM3: null, lastLaunchAtMs: null,
        contents: contents.map(([typeID, quantity]) => ({ typeID, quantity })),
      })) }],
    }),
    (action) => (action.kind === "exportCustoms" ? "CALL_REFUSED: NotEnoughMoney" : null),
    registry,
    [],
    arrived,
  );
  await run(200);
  assert.equal(state.reached, false, "the program does not move on");
  // One refusal is the answer: neither launchpad is asked again.
  assert.equal(issued.filter((action) => action.kind === "exportCustoms").length, 1);
  assert.equal(runner.getStatus(), "paused");
  assert.match(runner.snapshot().pauseReason ?? "", /not have enough ISK to pay the customs office's export tax/);
});
