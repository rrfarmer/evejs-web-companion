import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { EMPTY_PI_HAUL_PREFS, loadPiHaulPrefs, savePiHaulPrefs, withPiHaulDelivery } from "../lib/piHaulPrefs.ts";
import { startingStation, type WorldRef } from "../../../web/src/bots/botScript.ts";
import { piHaulBotDoc } from "../lib/piDispatch.ts";

register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);
const { render } = await import("svelte/server");
const StationPicker = (await import("../../../web/src/ui/StationPicker.svelte")).default;

const PILOT = 90000001;
const STATION: WorldRef = { entity: "station", id: 60000004, name: "Home Office", systemName: "Alpha" };

function picker(value: WorldRef, boardBindings = false): string {
  return render(StationPicker as never, { props: {
    value,
    current: null,
    boardBindings,
    flow: { searchDestinations: async () => [] },
    onPick: () => {},
  } } as never).body;
}

test("Change can open delivery search before choosing a station for the haul", () => {
  let prefs = EMPTY_PI_HAUL_PREFS;
  assert.match(picker(prefs.deliverTo.get(PILOT) ?? startingStation()), /Your starting station/);
  // The actual StationPicker Change handler emits this empty ref.
  prefs = withPiHaulDelivery(prefs, PILOT, { entity: "station", id: null, name: null, systemName: null });
  const search = picker(prefs.deliverTo.get(PILOT) ?? startingStation());
  assert.match(search, /<input/);
  assert.match(search, /Search<\/button>/);
  prefs = withPiHaulDelivery(prefs, PILOT, STATION);
  assert.match(picker(prefs.deliverTo.get(PILOT) ?? startingStation()), /Home Office/);
  const doc = piHaulBotDoc([{ planetID: 40000001, planetName: "Alpha I", solarSystemID: 30000001, solarSystemName: "Alpha" }], null, prefs.deliverTo.get(PILOT));
  const deliver = doc.program.find((step) => step.id === "deliver");
  assert.ok(deliver?.kind === "macro");
  assert.deepEqual(deliver.args["station"], { kind: "station", ref: STATION });
});

test("search state is temporary, chosen stations persist, and Starting station restores the default", () => {
  const data = new Map<string, string>();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
  try {
    let prefs = withPiHaulDelivery(EMPTY_PI_HAUL_PREFS, PILOT, STATION);
    savePiHaulPrefs(prefs);
    assert.deepEqual(loadPiHaulPrefs().deliverTo.get(PILOT), STATION);
    prefs = withPiHaulDelivery(prefs, PILOT, { entity: "station", id: null, name: null, systemName: null });
    savePiHaulPrefs(prefs);
    assert.equal(loadPiHaulPrefs().deliverTo.has(PILOT), false);
    assert.deepEqual(JSON.parse(data.get("evejs.piHaul")!).deliverTo, {});
    prefs = withPiHaulDelivery(prefs, PILOT, startingStation());
    assert.equal(prefs.deliverTo.has(PILOT), false);
    assert.match(picker(prefs.deliverTo.get(PILOT) ?? startingStation()), /Your starting station/);
  } finally {
    if (previous === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
    else globalThis.localStorage = previous;
  }
});

test("PI search hides board slots while the builder keeps them available", () => {
  const empty: WorldRef = { entity: "station", id: null, name: null, systemName: null };
  assert.doesNotMatch(picker(empty), /mission (?:pickup|delivery) station/);
  assert.notEqual(picker(empty, true), picker(empty));
});
