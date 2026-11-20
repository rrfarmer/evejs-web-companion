import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppFlow, type LocationFound, type LocationSearchOptions } from "../app/flow.ts";
import { createClientStore } from "../store/clientStore.ts";
import { createLocationSearch } from "./locationSearchRequests.ts";

type Results = ReadonlyMap<number, readonly LocationFound[]> | null;

function pendingSearches() {
  const pending: {
    query: string;
    options?: LocationSearchOptions;
    resolve: (result: Results) => void;
    reject: (cause: Error) => void;
  }[] = [];
  const search = createLocationSearch((query, options) => new Promise((resolve, reject) => {
    pending.push({ query, options, resolve, reject });
  }));
  return { search, pending };
}

test("a late location reply cannot replace the latest result or its submitted query", async () => {
  const { search, pending } = pendingSearches();
  const older = search.run("Perimeter");
  const newer = search.run(" * Dodixie * ", { kinds: [7], matchBy: 3 });
  assert.deepEqual(pending[1]?.options, { kinds: [7], matchBy: 3 });
  const result = new Map([[7, [{ resultType: 7, id: 30002659, name: "Dodixie", solarSystemID: 30002659 }]]]);
  pending[1]!.resolve(result);
  await newer;
  assert.deepEqual(search.state.get(), { busy: false, error: "", result: { found: result, query: "Dodixie" } });
  pending[0]!.resolve(new Map());
  await older;
  assert.equal(search.state.get().result?.found, result);
});

test("stale errors do not clear the latest search and a pilot change retires pending replies", async () => {
  const { search, pending } = pendingSearches();
  const older = search.run("Perimeter");
  const newest = search.run("Jita");
  pending[0]!.reject(new Error("Old request failed"));
  await older;
  assert.deepEqual(search.state.get(), { busy: true, error: "", result: null });
  search.reset();
  pending[1]!.resolve(new Map());
  await newest;
  assert.deepEqual(search.state.get(), { busy: false, error: "", result: null });
  const current = search.run("Dodixie");
  pending[2]!.reject(new Error("Location search unavailable."));
  await current;
  assert.equal(search.state.get().busy, false);
  assert.notEqual(search.state.get().error, "");
});

test("Location Search options follow the online pilot", () => {
  const values = new Map([["evejs.play.locations_window_search_type", "1"]]);
  const store = createClientStore();
  const flow = createAppFlow(store, {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    },
  });
  const play = (characterID: number) => store.apply({
    type: "character/online",
    character: { characterID, characterName: String(characterID), stationID: 60003760, structureID: null, solarSystemID: 30000142, corporationID: null },
    station: null,
  });
  play(140000001);
  assert.deepEqual(flow.locationSearchSettings(), { searchType: 0, searchBy: 0 });
  flow.keepLocationSearchSetting("type", 2);
  flow.keepLocationSearchSetting("by", 3);
  play(140000002);
  assert.deepEqual(flow.locationSearchSettings(), { searchType: 0, searchBy: 0 });
  flow.keepLocationSearchSetting("type", 1);
  flow.keepLocationSearchSetting("by", 4);
  assert.deepEqual(flow.locationSearchSettings(), { searchType: 1, searchBy: 0 });
  play(140000001);
  assert.deepEqual(flow.locationSearchSettings(), { searchType: 2, searchBy: 3 });
});
