// Planet richness: kept once learned, from colony reads or the game's own read.

import test from "node:test";
import assert from "node:assert/strict";

import type { JsonValue } from "../../../web/src/bridge/wire.ts";
import type { PilotColonyReading } from "../lib/piRoster.ts";
import {
  decodePlanetRichness,
  loadRichness,
  mergeRichness,
  readRichness,
  RICHNESS_BATCH,
  richnessFromReadings,
  saveRichness,
  setPiRichnessStorage,
} from "../lib/piRichness.ts";

const PLANET_A = 40000002;
const PLANET_B = 40000004;
const AQUEOUS = 2268;
const BASE_METALS = 2267;

/** GetPlanetResourceInfo as the server sends it: a CachedMethodCallResult around a substream dict. */
function cached(entries: readonly [number, number][]): JsonValue {
  return {
    type: "object",
    name: "carbon.common.script.net.objectCaching.CachedMethodCallResult",
    args: [
      { type: "dict", entries: [["versionCheck", "run"]] },
      { type: "substream", value: { type: "dict", entries: entries.map(([typeID, q]) => [typeID, q]) } },
    ],
  } as unknown as JsonValue;
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

test("the game's own read decodes to a richness table, and a failed planet is left out", () => {
  const map = decodePlanetRichness({
    ok: true,
    planets: [
      { planetID: PLANET_A, result: cached([[AQUEOUS, 140], [BASE_METALS, 96]]) },
      { planetID: PLANET_B, error: "CALL_FAILED" },
    ],
  } as unknown as JsonValue);
  assert.deepEqual([...map.keys()], [PLANET_A]);
  assert.equal(map.get(PLANET_A)!.get(AQUEOUS), 140);
  assert.equal(map.get(PLANET_A)!.get(BASE_METALS), 96);
});

test("richness is kept in the browser and comes back as it went in; a damaged store is empty", () => {
  const store = memoryStorage();
  setPiRichnessStorage(store);
  saveRichness(new Map([[PLANET_A, new Map([[AQUEOUS, 140]])]]));
  assert.equal(loadRichness().get(PLANET_A)!.get(AQUEOUS), 140);
  store.setItem("evejs-web-pi-richness:v1", "{not json");
  assert.equal(loadRichness().size, 0);
  setPiRichnessStorage(null);
});

test("colony reads already carry their planets' richness, and merging keeps every planet", () => {
  const readings = new Map<number, PilotColonyReading>([[90000001, {
    characterID: 90000001,
    readAtMs: null,
    report: {
      coloniesReadable: true,
      clockOffsetMs: 0,
      colonies: [{
        planetID: PLANET_A, planetName: null, solarSystemID: 30000001, solarSystemName: null, planetTypeID: 2016,
        planetTypeName: null, commandCenterLevel: 5, lastSimulatedAtMs: null, pins: [], linkCount: 0, links: [], routes: [],
        resources: [{ typeID: AQUEOUS, typeName: null, quality: 133 }, { typeID: BASE_METALS, typeName: null, quality: null }],
      }],
    },
  }]]);
  const fromColonies = richnessFromReadings(readings);
  assert.deepEqual([...fromColonies.get(PLANET_A)!], [[AQUEOUS, 133]], "an unknown quality is left out, not zero");
  const merged = mergeRichness(fromColonies, new Map([[PLANET_B, new Map([[AQUEOUS, 90]])]]));
  assert.deepEqual([...merged.keys()].sort(), [PLANET_A, PLANET_B]);
});

test("a long list is asked a batch at a time, on the options it was given", async () => {
  const asked: number[][] = [];
  const options = { token: "a-tab-session" };
  const ids = Array.from({ length: RICHNESS_BATCH + 5 }, (_, index) => 40000002 + index * 2);
  const found = await readRichness(ids, options, async (batch, given) => {
    assert.equal(given, options);
    asked.push([...batch]);
    return { planets: batch.map((planetID) => ({ planetID, result: cached([[AQUEOUS, 100]]) })) } as unknown as JsonValue;
  });
  assert.deepEqual(asked.map((batch) => batch.length), [RICHNESS_BATCH, 5]);
  assert.equal(found.size, RICHNESS_BATCH + 5);
});
