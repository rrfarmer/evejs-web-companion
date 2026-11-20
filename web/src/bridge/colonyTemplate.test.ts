import assert from "node:assert/strict";
import test from "node:test";
import { planColonyTemplate, readColonyTemplate } from "./colonyTemplate.ts";
import { decodeRecipeBook } from "./piRecipes.ts";
import type { Colony } from "../store/types.ts";

const target = {
  planetID: 40009077, planetTypeID: 2016, commandCenterLevel: 0,
  pins: [{ pinID: 8808, kind: "command", typeID: 2524, latitude: 1.17, longitude: 2.11 }],
} as unknown as Colony;
const recipe = decodeRecipeBook({ schematics: [{ schematicID: 121, name: "Water", cycleTimeSeconds: 1800,
  output: { typeID: 3645, quantity: 20 }, inputs: [{ typeID: 2268, quantity: 3000 }], factoryTypeIDs: [2473] }] });
const pin = (T: number, La: number, Lo: number, S: number | null = null) => ({ T, La, Lo, S, H: 0 });
const fixture = {
  Pln: 11, Diam: 6000, CmdCtrLv: 1, Cmt: "Water",
  P: [pin(2254, 1.1, 2.1), pin(2562, 1.2, 2.1), pin(2481, 1.2, 2.2, 3645), pin(2562, 1.3, 2.2)],
  L: [{ S: "CmdCtr", D: 1, Lv: 0 }, { S: 1, D: 2, Lv: 0 }, { S: 2, D: 3, Lv: 1 }],
  R: [{ P: [1, 2], T: 2268, Q: 3000 }, { P: [2, 3], T: 3645, Q: 20 }, { P: [1, 3], T: 2268, Q: 10 }],
};

test("native template maps facilities, links, schematic and route pins to target types and temporary IDs", () => {
  const plan = planColonyTemplate(readColonyTemplate(JSON.stringify(fixture)), target, recipe, [0, 0, 0]);
  assert.deepEqual(plan.pins.map(p => [p.index, p.typeID]), [["CmdCtr", 2524], [1, 2541], [2, 2473], [3, 2541]]);
  assert.equal(plan.pins[0]?.longitude, 2.11);
  assert.deepEqual(plan.changes[0], [9, [8808, 1]]);
  assert.ok(plan.changes.some(c => JSON.stringify(c) === JSON.stringify([8, [[1, 2], 121]])));
  assert.ok(plan.changes.some(c => JSON.stringify(c) === JSON.stringify([5, [[1, 2], [1, 3], 1]])));
  assert.equal(plan.upgradeCost, 580000);
  assert.equal(plan.routes, 2);
  assert.deepEqual(plan.skipped.map(r => r.path), [[1, 3]]);
});

test("shipped packed links preserve UTF-8 descriptions and rotation moves the proposed surface points", () => {
  let base = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ ...fixture, Cmt: "Water • Jita" }))));
  if (base.length % 2 !== 0) base += "\0";
  let link = "colonytemplate:";
  for (let i = 0; i < base.length; i += 2) link += String.fromCharCode(base.charCodeAt(i) * 256 + base.charCodeAt(i + 1));
  const template = readColonyTemplate(link);
  assert.equal(template.comment, "Water • Jita");
  const original = planColonyTemplate(template, target, recipe, [0, 0, 0]);
  const moved = planColonyTemplate(template, target, recipe, [0, 25, 0]);
  assert.notEqual(original.pins[1]?.longitude, moved.pins[1]?.longitude);
  assert.equal(original.pins[0]?.longitude, moved.pins[0]?.longitude);
});

test("unreadable templates, missing command centres and unsupported placements keep useful errors", () => {
  assert.throws(() => readColonyTemplate("broken"), /readable planetary template/);
  assert.throws(() => readColonyTemplate(JSON.stringify({ ...fixture, R: {} })), /routes/);
  const template = readColonyTemplate(JSON.stringify(fixture));
  assert.throws(() => planColonyTemplate(template, { ...target, pins: [] }, recipe, [0, 0, 0]), /established command centre/);
  assert.throws(() => planColonyTemplate({ ...template, pins: [pin(42, 1.1, 2.2)].map(p => ({
    typeID: p.T, latitude: p.La, longitude: p.Lo, product: p.S,
  })) }, target, recipe, [0, 0, 0]), /no corresponding installation/);
});
