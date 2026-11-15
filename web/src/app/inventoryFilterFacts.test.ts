import assert from "node:assert/strict";
import test from "node:test";
import { FILTER_FIELD as F } from "../bridge/inventoryFilters.ts";
import { loadInventoryFilterFacts } from "./inventoryFilterFacts.ts";

test("inventory filters use native type effect IDs, dogma attributes and meta defaults", async () => {
  const fetch: typeof globalThis.fetch = async (input, options) => {
    const path = String(input);
    if (path.startsWith("/api/types/effects?")) return Response.json({ ok: true, effects: { 10: [12, 23], 20: [] } });
    if (path.startsWith("/api/client-data/type-meta?")) return Response.json({ ok: true, available: true, types: { 10: { techLevel: 3 }, 20: { metaGroupID: 4, metaLevel: 8 } } });
    assert.equal(path, "/api/types/dogma");
    assert.deepEqual(JSON.parse(String(options?.body)), { typeIDs: [10, 20], attributeIDs: [30, 50] });
    return Response.json({ ok: true, attributes: { 10: { 30: 4.7, 50: 5.8 }, 20: {} } });
  };
  assert.deepEqual(await loadInventoryFilterFacts([10, 20], new Set([F.slot, F.metaGroup, F.metaLevel, F.power, F.cpu]), { fetch }), new Map([
    [10, { [F.slot]: [12, 23], [F.metaGroup]: 14, [F.metaLevel]: 0, [F.power]: 4, [F.cpu]: 5 }],
    [20, { [F.slot]: [], [F.metaGroup]: 4, [F.metaLevel]: 8, [F.power]: 0, [F.cpu]: 0 }],
  ]));
});

test("a missing effects row stays unknown, and an effects-only filter skips other reads", async () => {
  const fetch: typeof globalThis.fetch = async (input) => {
    assert.match(String(input), /^\/api\/types\/effects\?/);
    return Response.json({ ok: true, effects: { 10: null } });
  };
  assert.deepEqual(await loadInventoryFilterFacts([10], new Set([F.slot]), { fetch }), new Map([[10, {}]]));
});

test("clone filters follow recursive skills and allow a blueprint if any activity is Alpha-compatible", async () => {
  const fetch: typeof globalThis.fetch = async (input, options) => {
    const path = String(input);
    if (path.startsWith("/api/client-data/clone-grade?")) {
      assert.equal(path, "/api/client-data/clone-grade?raceID=1");
      return Response.json({ ok: true, available: true, levels: { 100: 1, 200: 3 } });
    }
    if (path.startsWith("/api/client-data/type-meta?")) {
      return Response.json({ ok: true, available: true, types: { 10: { categoryID: 6 }, 20: { categoryID: 9 }, 30: { categoryID: 34 }, 40: { categoryID: 16 } } });
    }
    if (path.startsWith("/api/client-data/required-skills?")) {
      return Response.json({ ok: true, available: true, order: { 10: [[100, 1]], 100: [[200, 4]], 20: [], 30: [], 40: [] } });
    }
    assert.equal(path, "/api/industry/blueprints");
    assert.deepEqual(JSON.parse(String(options?.body)).blueprintTypeIDs, [20, 30]);
    const restricted = { skills: [{ typeID: 200, level: 4 }] };
    return Response.json({ ok: true, definitions: { 20: { activities: { manufacturing: restricted, copying: { time: 1 } } }, 30: { activities: { invention: restricted } } } });
  };
  const facts = await loadInventoryFilterFacts([10, 20, 30, 40], new Set([F.clone]), { fetch }, 1);
  assert.deepEqual([...facts.values()].map(row => row[F.clone]), [1, 0, 1, 1]);
});
