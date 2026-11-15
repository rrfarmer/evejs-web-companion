"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readPhasedFieldSystems } = require("../src/clientData/achievementDefinitions");
const { oreActivities, convoyActivities } = require("../web/src/bridge/starMapFilters.ts");

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
