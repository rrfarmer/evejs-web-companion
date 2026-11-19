import assert from "node:assert/strict";
import test from "node:test";
import { asteroidGraphic, makeAsteroidGeometry, type AsteroidRules } from "./asteroidModel.ts";

const rules: AsteroidRules = {
  groups: { 460: {
    graphicIDs: [8, 9],
    categories: { categoryAttribute: "radius", categoryList: [
      { categoryRangeBegin: 0, categoryRangeEnd: 300, graphicIDs: [10, 11] },
      { categoryRangeBegin: 300, categoryRangeEnd: 670, graphicIDs: [20, 21] },
      { categoryRangeBegin: 670, graphicIDs: [30, 31] },
    ] },
    typeIDs: { 1228: {
      graphicIDs: [60, 61],
      typeCategories: { typeCategoryAttribute: "radius", typeCategoryList: [
        { typeCategoryRangeBegin: 900, graphicIDs: [40, 41] },
      ] },
    } },
  } },
  typeGraphicIDs: { 4: 90 },
};

test("asteroid choices use per-type priority, half-open radius ranges and the full item ID", () => {
  const ball = { itemID: 5_020_484_735_533, typeID: 17463, groupID: 460, radius: 299.9 };
  const pick = (radius: number) => asteroidGraphic({ ...ball, radius }, rules);
  assert.equal(pick(299.9), 11);
  assert.equal(pick(300), 21);
  assert.equal(pick(670), 31);
  assert.equal(asteroidGraphic({ ...ball, typeID: 1228, radius: 670 }, rules), 61);
  assert.equal(asteroidGraphic({ ...ball, typeID: 1228, radius: 900 }, rules), 41);
  assert.equal(asteroidGraphic({ ...ball, typeID: 4, groupID: 1 }, rules), 90);
  assert.equal(asteroidGraphic({ ...ball, typeID: null, groupID: null }, rules), null);
});

test("procedural variants are deterministic, distinct and centered within unit bounds", () => {
  const rock = makeAsteroidGeometry(32557);
  const same = makeAsteroidGeometry(32557);
  const next = makeAsteroidGeometry(32558);
  assert.deepEqual(rock.attributes.position!.array, same.attributes.position!.array);
  assert.notDeepEqual(rock.attributes.position!.array, next.attributes.position!.array);
  assert.ok(Math.abs(rock.boundingSphere!.radius - 1) < 1e-6);
  assert.ok(rock.boundingSphere!.center.length() < 1e-6);
  assert.equal(rock.attributes.color!.count, rock.attributes.position!.count);
  for (const geometry of [rock, same, next]) geometry.dispose();
});
