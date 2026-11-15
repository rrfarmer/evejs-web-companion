import test from "node:test";
import assert from "node:assert/strict";
import { fittingSkillRequirements, fittingSkillWarning } from "./fittingSkills.ts";

test("the fit and cargo tooltip uses the highest requirement and marks the original slots", () => {
  const facts = {
    required: {
      100: [[300, 2]],
      101: [[301, 1]],
      102: [[300, 3]],
      103: [[301, 1]],
      104: [[302, 5]],
      301: [[303, 1]],
    } as const,
    mine: new Map(),
    lapsed: new Map(),
    categoryOf: (typeID: number) => typeID === 104 ? 9 : 7,
  };
  const fit = fittingSkillWarning({
    ...facts,
    ship: 100,
    fitted: [],
    bays: [[101]],
    cargo: [101, 102, 103, 104],
    items: [[101, 87], [101, 5], [102, 5], [103, 5], [104, 5]],
  });
  const rows = fittingSkillRequirements([100, 101], [101, 102, 103, 104], facts);
  assert.deepEqual(new Map(rows.fit), new Map([[300, 2], [301, 1], [303, 1]]));
  assert.deepEqual(rows.cargo, [[300, 3]]);
  assert.deepEqual(new Map(rows.listed), new Map([[300, 3], [301, 1], [303, 1]]));
  assert.ok(rows.listed.findIndex(([skill]) => skill === 303) < rows.listed.findIndex(([skill]) => skill === 301));
  assert.equal(rows.shipAndFitHeading, true);
  assert.deepEqual(fit.fit, rows.fit);
  assert.deepEqual(fit.cargo, rows.cargo);
  assert.deepEqual(fit.flags, [87, 5]);
  assert.equal(fit.count, 3);
  assert.deepEqual(fittingSkillRequirements([100, 101], [101], facts).cargo, []);
  assert.equal(fittingSkillRequirements([100, 101], [101], facts).shipAndFitHeading, false);
});
