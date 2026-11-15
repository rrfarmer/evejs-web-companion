"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readPhasedFieldSystems } = require("../src/clientData/achievementDefinitions");
const { oreActivities, convoyActivities } = require("../web/src/bridge/starMapFilters.ts");
const { activityClusterCentroid, groupActivityPins, mapZoomValue } = require("../web/src/play/starMapActivityGroups.ts");

const dict = (entries) => ({ type: "dict", entries });
const list = (...items) => ({ type: "list", items });
const anomaly = (id) => ({ type: "object", name: "util.KeyVal", args: dict([["dungeonNameID", id]]) });

test("ore anomaly details replace projections, including empty results for the pilot's system", () => {
  const counts = dict([[30000142, 3], [30000144, 0], [30000145, 5], [30000146, 4], [30000148, 2]]);
  const exact = dict([[30000145, list(anomaly(10), anomaly(20))], [30000146, list()], [30000147, list(anomaly(30))]]);
  assert.deepEqual(oreActivities(counts, exact, 30000142), [
    { systemID: 30000145, count: 2, dungeonNameIDs: [10, 20] },
    { systemID: 30000148, count: 2, dungeonNameIDs: null },
    { systemID: 30000147, count: 1, dungeonNameIDs: [30] },
  ]);
});

const pin = (systemID, constellationID, sites, x, y = 0, z = 0) =>
  ({ systemID, constellationID, regionID: 10000002, sites, position: { x, y, z } });
const origin = { x: 0, y: 0, z: 0 };

test("abstract activity clusters follow strict 24.02 zoom thresholds and leave singletons as individual systems", () => {
  const pins = [
    pin(30000119, 20000017, 1, 50, 40), pin(30000120, 20000017, 5, 70, 30), pin(30000131, 20000018, 3, 590),
  ];
  assert.deepEqual(groupActivityPins(pins, "ore", 0.75, true, origin), []);
  const constellations = groupActivityPins(pins, "ore", 0.85, true, origin);
  assert.deepEqual(constellations, [{ id: 20000017, level: "constellation", regionID: 10000002, members: pins.slice(0, 2), value: 6 }]);
  assert.deepEqual(activityClusterCentroid(constellations[0].members), { x: 60, y: 35, z: 0 });
  assert.deepEqual(groupActivityPins(pins, "ore", 0.851, true, origin), [
    { id: 10000002, level: "region", regionID: 10000002, members: pins, value: 9 },
  ]);
  assert.equal(mapZoomValue(3100, 3100, 310000), 0);
  assert.equal(mapZoomValue(310000, 3100, 310000), 1);
});

test("perspective activity clusters use each pin's distance and can split a region across grouping levels", () => {
  const pins = [
    pin(30000119, 20000017, 3, 15000), pin(30000120, 20000017, 3, 16000),
    pin(30000121, 20000017, 3, 25000), pin(30000122, 20000017, 3, 25001), pin(30000123, 20000017, 3, 27000),
  ];
  const groups = groupActivityPins(pins, "ore", 0.25, false, origin);
  assert.deepEqual(groups.map(group => [group.level, group.members.map(member => member.systemID)]), [
    ["constellation", [30000120, 30000121]],
    ["region", [30000122, 30000123]],
  ]);
});

test("phased pin groups tolerate missing native values and Vanguard star data does not form pin groups", () => {
  const pins = [pin(30000119, 20000017, 1, 50), pin(30000120, 20000017, 1, 70)];
  assert.equal(groupActivityPins(pins, "phased", 0.91, true, origin)[0].value, 0);
  assert.deepEqual(groupActivityPins(pins, "convoys", 0.91, true, origin), []);
});

test("Vanguard counts use each distinct active tale in its system", () => {
  const tale = (id, systemID) => dict([["tale_id", id], ["solar_system_id", systemID]]);
  const first = tale(41, 30000142);
  const replies = [list(first, tale(42, 30000142), tale(43, 20000002)), list(first, tale(44, 30000144)), []];
  assert.deepEqual(convoyActivities(replies), [{ systemID: 30000142, count: 2 }, { systemID: 30000144, count: 1 }]);
});

test("the 24.02 map catalogue marks tagged systems and ignores region or constellation tags", () => {
  // EveJS buildMapTagsFlatbuffer output for two systems, a constellation, and a
  // region. Only 30000142 has the phased-field tag among the systems.
  const bytes = Buffer.from(
    "FAAAAAAAAAAAAAoAEAAEAAgADAAKAAAADAAAADAAAABYAAAAAQAAAAwAAAAIABAABAAMAAgAAACClpgAAAAAAAQAAAABAAAAkAAAAAEAAAAMAAAACAAUAAQAEAAIAAAAFC0xAQAAAAAAAAAABAAAAAEAAABkAAAAAgAAADAAAAAMAAAACAAQAAQADAAIAAAAEMTJAQAAAAAEAAAAAQAAACwAAAAIABQABAAQAAgAAAAOxMkBAAAAAAAAAAAEAAAAAgAAABQAAAAEAAAABQAAAG90aGVyAAAAOQAAAGhpZ2hfbWluaW5nX2NvbnRlbnRfYXZhaWxhYmlsaXR5Lmhhc19waGFzZWRfZmllbGRfZXhwb3NlZAAAAA==",
    "base64",
  );
  assert.deepEqual(readPhasedFieldSystems(bytes), { systems: [30000142] });
  assert.throws(() => readPhasedFieldSystems(bytes.subarray(0, -8)), /Invalid map tag definitions/);
});
