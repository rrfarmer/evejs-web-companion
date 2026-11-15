import assert from "node:assert/strict";
import test from "node:test";
import { DogmaLocation, loadSimulatedShip, type DogmaStatic, type DogmaTypeFacts } from "./location.ts";
import { chargeFitsModule, loadChargesToSimulation, type SimulatedShip } from "./simulation.ts";
import { usedWithTypeIDs } from "./fittingWarnings.ts";
import { usedWithPair } from "./chargeCompatibility.ts";

test("academy charges only fit Academy launchers and appear in their Used With warnings", () => {
  const type = (groupID: number, changes: Partial<DogmaTypeFacts> = {}): DogmaTypeFacts => ({
    groupID, categoryID: null, attributes: [[128, 1]], effects: [], requiredSkills: [], published: true, ...changes,
  });
  const staticData: DogmaStatic = {
    types: {
      10678: type(74, { attributes: [[128, 1], [604, 85]], chargeGroups: [85] }),
      95869: type(74, { academy: true, published: false, attributes: [[128, 1], [604, 85]], chargeGroups: [85] }),
      215: type(85),
      95874: type(85, { academy: true, published: false }),
      90001: type(85, { published: false }),
    },
    effects: {}, attributes: {},
  };
  const dogma = new DogmaLocation(staticData);
  const group = () => [215, 95874, 90001];
  assert.deepEqual(usedWithTypeIDs(staticData, 10678, group), [215]);
  assert.deepEqual(usedWithTypeIDs(staticData, 95869, group), [215, 95874]);
  assert.equal(chargeFitsModule(dogma, 95874, 10678), false);
  assert.equal(chargeFitsModule(dogma, 95874, 95869), true);
  assert.equal(chargeFitsModule(dogma, 215, 95869), true);
  assert.equal(usedWithPair(staticData.types[10678], staticData.types[95874]), false);
  assert.equal(usedWithPair(staticData.types[95869], staticData.types[95874]), true);
});

test("Used With is limited to the first four charge groups, and checks size and volume in either direction", () => {
  const module: DogmaTypeFacts = {
    groupID: 74, categoryID: 7, published: true, effects: [], requiredSkills: [],
    attributes: [[128, 1], [38, 0.1], [604, 85], [610, 86]],
  };
  const charge = (groupID: number, size: number, volume: number): DogmaTypeFacts => ({
    groupID, categoryID: 8, published: true, effects: [], requiredSkills: [], attributes: [[128, size], [161, volume]],
  });
  const types = { 1: module, 2: charge(85, 1, 0.1), 3: charge(85, 1, 0.2), 4: charge(85, 2, 0.1), 5: charge(86, 1, 0.1) };
  assert.deepEqual(usedWithTypeIDs({ types, attributes: {}, effects: {} }, 1, id => id === 85 ? [2, 3, 4] : [5]), [2]);
  assert.deepEqual(([2, 3, 4, 5] as const).filter(id => usedWithPair(module, types[id])), [2]);
});

test("simulation skips a charge with no Used with match and loads the first match into each compatible rack slot", () => {
  const module = (chargeGroup: number): DogmaTypeFacts => ({
    groupID: 74, categoryID: 7, published: true, effects: [], requiredSkills: [],
    attributes: [[128, 1], [38, 0.1], [604, chargeGroup]], chargeGroups: [chargeGroup],
  });
  const charge = (groupID: number): DogmaTypeFacts => ({
    groupID, categoryID: 8, published: true, effects: [], requiredSkills: [], attributes: [[128, 1], [161, 0.025]],
  });
  const staticData = { types: { 100: module(85), 101: module(86), 1: charge(999), 2: charge(85), 3: charge(85), 4: charge(86) }, effects: {}, attributes: {} };
  const view = loadSimulatedShip(staticData, 587, { characterID: 1, typeID: 1373, securityStatus: 0 }, null);
  const simulation: SimulatedShip = { ...view, cargo: new Map(), selectedDrones: new Map(), changed: false, ghosts: 0 };
  for (const [flag, typeID] of [[27, 100], [28, 100], [19, 101], [92, 100]] as const) view.location.fitModule(view.ship, `${flag}`, typeID, flag);
  loadChargesToSimulation(simulation, [1]);
  assert.equal(view.ship.subLocations.size, 0);
  assert.equal(simulation.changed, false);
  loadChargesToSimulation(simulation, [1, 2, 3, 4]);
  assert.deepEqual([...view.ship.subLocations].map(([flag, ammo]) => [flag, ammo.typeID, ammo.stacksize]), [[27, 2, 4], [28, 2, 4], [19, 4, 4]]);
  assert.equal(simulation.changed, true);
});
