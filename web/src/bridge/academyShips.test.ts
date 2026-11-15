import assert from "node:assert/strict";
import test from "node:test";
import {
  academyFit, academyOffers, academyStandardBuy, academyStateOf, academyTutorialLocked,
  type AcademyCatalogue, type AcademyOffer, type AcademyType,
} from "./academyShips.ts";

test("a disabled Academy is distinct from the 24.02 reduce object for a pilot without a loan", () => {
  const klass = { type: "token", value: "academyships.common.types.AcademyShipState" };
  assert.equal(academyStateOf(null), null);
  assert.deepEqual(academyStateOf({ type: "objectex1", header: [klass, [null, null, null, null]], list: [], dict: [] }),
    { shipID: null, typeID: null, fittingID: null, stationID: null });
  assert.deepEqual(academyStateOf({ type: "objectex1", header: [klass, [9988400000888, 95859, 100, 60015249]], list: [], dict: [] }),
    { shipID: 9988400000888, typeID: 95859, fittingID: 100, stationID: 60015249 });
  assert.throws(() => academyStateOf({ type: "objectex1", header: [klass, [0, 95859, 100, 60015249]] }), /loan state/);
});

test("an active AIR tutorial unlocks Academy boarding from scene 2.4", () => {
  assert.equal(academyTutorialLocked(1, 63), true);
  assert.equal(academyTutorialLocked(1, 0), true);
  assert.equal(academyTutorialLocked(1, 64), false);
  assert.equal(academyTutorialLocked(1, 92), false);
  assert.equal(academyTutorialLocked(2, 0), false);
  assert.equal(academyTutorialLocked(3, 0), false);
});

const offer = (shipTypeID: number, name: string, categoryID = 1): AcademyOffer => ({
  fittingID: shipTypeID, shipTypeID, categoryID, name, nameID: 1, descriptionID: 2, taglineID: 3, modules: [], cargo: [],
});
const type = (factionID: number | null, standardTypeID: number, effects: number[] = [], categoryID = 7): AcademyType =>
  ({ factionID, categoryID, standardTypeID, effects });

test("Academy combat ranks the pilot's recommendation, faction and the empire order before names", () => {
  const catalogue: AcademyCatalogue = {
    offers: [offer(1, "Ab"), offer(95859, "Merlin"), offer(2, "Caldari"), offer(97268, "Rifter"), offer(3, "Ac"), offer(95861, "Probe", 2)],
    facts: {
      1: type(500003, 1), 2: type(500001, 2), 3: type(500003, 3),
      95859: type(500001, 603), 97268: type(500002, 587), 95861: type(500002, 586),
    },
  };
  assert.deepEqual(academyOffers(catalogue, 1, 1, item => item.name).map(item => item.name),
    ["Merlin", "Caldari", "Ab", "Ac", "Rifter"]);
  assert.deepEqual(academyOffers(catalogue, 1, 2, item => item.name).map(item => item.name),
    ["Rifter", "Ab", "Ac", "Caldari", "Merlin"]);
});

test("academy rack flags split fitted modules and preserve drone and cargo stack sizes", () => {
  const fitting = {
    ...offer(95859, "Merlin"),
    modules: [{ typeID: 2, amount: 1 }, { typeID: 4, amount: 3 }, { typeID: 3, amount: 2 }, { typeID: 5, amount: 1 }],
    cargo: [{ typeID: 6, amount: 13000 }, { typeID: 7, amount: 18000 }, { typeID: 8, amount: 13000 }],
  };
  const facts = {
    95859: type(500001, 603), 2: type(null, 12, [13]), 3: type(null, 13, [42, 12]),
    4: type(null, 14, [], 18), 5: type(null, 15, [12]), 6: type(null, 16),
    7: type(null, 17), 8: type(null, 16),
  };
  assert.deepEqual(academyFit(fitting, facts).map(({ typeID, flag, amount }) => [typeID, flag, amount]), [
    [3, 27, 1], [3, 28, 1], [5, 29, 1], [2, 19, 1], [4, 87, 3],
    [6, 5, 13000], [7, 5, 18000], [8, 5, 13000],
  ]);
  assert.deepEqual([...academyStandardBuy(fitting, facts)], [[603, 1], [12, 1], [14, 3], [13, 2], [15, 1], [16, 26000], [17, 18000]]);
});
