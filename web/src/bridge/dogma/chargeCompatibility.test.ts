import assert from "node:assert/strict";
import test from "node:test";
import { DogmaLocation, type DogmaStatic, type DogmaTypeFacts } from "./location.ts";
import { chargeFitsModule } from "./simulation.ts";
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
