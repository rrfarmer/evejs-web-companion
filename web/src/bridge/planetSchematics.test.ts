import assert from "node:assert/strict";
import test from "node:test";
import { decodeRecipeBook } from "./piRecipes.ts";
import { planSchematicEdit, processorSchematics, schematicBuffer } from "./planetSchematics.ts";
import { decodeColonyReport } from "./planets.ts";

const recipes = decodeRecipeBook({
  schematics: [
    { schematicID: 121, name: "Water", factoryTypeIDs: [2473], cycleTimeSeconds: 1800,
      inputs: [{ typeID: 2268, typeName: "Aqueous Liquids", quantity: 3000 }], output: { typeID: 3645, typeName: "Water", quantity: 20 } },
    { schematicID: 43, name: "Oxygen", factoryTypeIDs: [2473], cycleTimeSeconds: 1800,
      inputs: [{ typeID: 2310, typeName: "Noble Gas", quantity: 3000 }], output: { typeID: 3683, typeName: "Oxygen", quantity: 20 } },
    { schematicID: 71, name: "Coolant", factoryTypeIDs: [2474], cycleTimeSeconds: 3600,
      inputs: [{ typeID: 3645, typeName: "Water", quantity: 40 }], output: { typeID: 9832, typeName: "Coolant", quantity: 5 } },
  ],
});
const colony = decodeColonyReport({ coloniesReadable: true, colonies: [{
  planetID: 40009077, pins: [{
    pinID: 7, kind: "factory", typeID: 2473, schematicID: 121, schematicName: "Water", active: true,
    contents: [{ typeID: 2268, typeName: "Aqueous Liquids", quantity: 700 }],
  }],
  routes: [
    { routeID: 1, path: [6, 7], commodityTypeID: 2268, commodityQuantity: 3000 },
    { routeID: 2, path: [7, 8], commodityTypeID: 3645, commodityQuantity: 20 },
    { routeID: 3, path: [6, 7, 8], commodityTypeID: 2268, commodityQuantity: 200 },
    { routeID: 4, path: [6, 7], commodityTypeID: 2310, commodityQuantity: 500 },
  ],
}] }, 0).colonies[0]!;
const factory = colony.pins[0]!;
const oxygen = recipes.bySchematicID.get(43)!;

test("the schematic list uses the installation type and the native product ordering", () => {
  assert.deepEqual(processorSchematics(factory, recipes).map(recipe => recipe.name), ["Oxygen", "Water"]);
  assert.deepEqual(processorSchematics({ ...factory, kind: "storage" }, recipes), []);
});

test("an obsolete input or output is removed before install while compatible and transiting routes survive", () => {
  const edit = { pinID: 7, previousSchematicID: 121, recipe: oxygen, removedRoutes: colony.routes.slice(0, 2) };
  const result = planSchematicEdit(colony, edit, recipes);
  assert.deepEqual(result.commands, [[7, [1]], [7, [2]], [8, [7, 43]]]);
  assert.deepEqual(result.colony.routes.map(route => route.routeID), [3, 4]);
  assert.deepEqual(result.colony.pins[0]?.contents, []);
  assert.equal(result.colony.pins[0]?.active, false);
  assert.equal(result.colony.pins[0]?.schematicName, "Oxygen");
  assert.throws(() => planSchematicEdit(colony, { ...edit, previousSchematicID: 43 }, recipes), /installed schematic changed/);
  assert.throws(() => planSchematicEdit(colony, { ...edit, removedRoutes: colony.routes.slice(0, 1) }, recipes), /routes changed/);
  assert.throws(() => planSchematicEdit(colony, { ...edit, recipe: recipes.bySchematicID.get(71)! }, recipes),
    /cannot use the selected schematic/);
});

test("changing a recipe keeps only compatible inputs and limits them to one batch", () => {
  const loaded = { ...factory, contents: [...factory.contents, { typeID: 2310, typeName: "Noble Gas", quantity: 3100 }] };
  const preview = schematicBuffer(loaded, oxygen);
  assert.deepEqual(preview.retained.map(item => [item.typeID, item.quantity]), [[2310, 3000]]);
  assert.deepEqual(preview.discarded.map(item => [item.typeID, item.quantity]), [[2268, 700], [2310, 100]]);
});
