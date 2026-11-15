import assert from "node:assert/strict";
import test from "node:test";
import { affectedBy } from "./affectedBy.ts";
import { OP_MOD_ADD, OP_MOD_SUB, OP_POST_DIV, OP_POST_MUL, OP_POST_PERCENT } from "./attribute.ts";
import { DogmaLocation, type DogmaTypeFacts } from "./location.ts";

test("Affected By counts distinct items of the same type and follows non-neutral modifier chains", () => {
  const type = (categoryID: number, attributes: DogmaTypeFacts["attributes"], effects: readonly number[] = []): DogmaTypeFacts => ({
    categoryID, attributes, effects, groupID: null, requiredSkills: [],
  });
  const location = new DogmaLocation({
    types: {
      100: type(6, [[9, 100], [38, 100]]),
      200: type(7, [[1, 0.8], [2, 0.8]]),
      300: type(7, [[3, 0.1]], [90]),
      400: type(1, []),
    },
    effects: {
      90: {
        category: 5, chanceAttributeID: null,
        modifiers: [{ modifyingAttributeID: 3, func: null, domain: null, modifiedAttributeID: null, operation: null, groupID: null, skillTypeID: null }],
      },
    },
    attributes: {},
  });
  const ship = location.loadItem("ship", 100);
  const pilot = location.loadItem("pilot", 400);
  const left = location.loadItem("left", 200);
  const right = location.loadItem("right", 200);
  const booster = location.loadItem("booster", 300);
  location.applyBrainEffects(ship, pilot, {
    version: 1, charEffects: [], structureEffects: [],
    shipEffects: [{ modifierType: "M", toAttribID: 9, operation: OP_POST_PERCENT, value: 10, skills: [901, 901], extras: [] }],
  });
  location.addItemModifier(OP_MOD_ADD, left, 1, booster, 3);
  location.addItemModifier(OP_POST_MUL, ship, 9, left, 1);
  location.addItemModifier(OP_POST_MUL, ship, 9, left, 2);
  location.addItemModifier(OP_POST_MUL, ship, 9, right, 1);
  location.addItemModifier(OP_POST_DIV, ship, 38, right, 1);
  location.addItemModifier(OP_MOD_SUB, ship, 38, booster, 3);
  const local = location.value(ship, 9);
  assert.deepEqual(affectedBy(location, ship, 9, local + 5), [
    { direction: "up", typeID: 901, count: 2, overloaded: false },
    { direction: "up", typeID: 300, count: 1, overloaded: true },
    { direction: "up", typeID: null },
    { direction: "down", typeID: 200, count: 2, overloaded: false },
  ]);
  assert.deepEqual(affectedBy(location, ship, 38, location.value(ship, 38) - 0.0000001), [
    { direction: "up", typeID: 200, count: 1, overloaded: false },
    { direction: "down", typeID: 300, count: 1, overloaded: true },
  ]);
});
