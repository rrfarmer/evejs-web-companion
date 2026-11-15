import assert from "node:assert/strict";
import test from "node:test";
import { DogmaLocation, type DogmaStatic, type DogmaTypeFacts } from "./location.ts";
import { chargeFitsModule } from "./simulation.ts";
import { usedWithTypeIDs } from "./fittingWarnings.ts";

test("academy charges only fit Academy launchers and appear in their Used With warnings", () => {
  const type = (groupID: number, changes: Partial<DogmaTypeFacts> = {}): DogmaTypeFacts => ({
    groupID, categoryID: null, attributes: [[128, 1]], effects: [], requiredSkills: [], ...changes,
  });
  const staticData: DogmaStatic = {
    types: {
      10678: type(74, { chargeGroups: [85] }),
      95869: type(74, { academy: true, published: false, chargeGroups: [85] }),
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
});
