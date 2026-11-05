// The plugin launchers beside the brand: what the player pinned, a new plugin
// pinning itself only while there is room, a plugin pinned whole covering its
// windows, and an unpinned window having no launcher even while it is open.

import test from "node:test";
import assert from "node:assert/strict";

import type { PluginWindowGroup } from "./globalWindow.ts";
import {
  AUTO_PIN_LIMIT,
  NO_PINS,
  launcherWord,
  loadPins,
  meetPlugins,
  pluginLaunchers,
  savePins,
  togglePlugin,
  toggleWindow,
  type PinState,
} from "./pluginPins.ts";
import type { TabID } from "./tabs.ts";

function group(id: string, windows: readonly string[]): PluginWindowGroup {
  return {
    plugin: { id, name: `Plugin ${id}`, label: id.toUpperCase() },
    windows: windows.map((name) => ({ id: `plugin:${id}.${name}` as TabID, label: name, title: `${id} ${name}`, hint: `${id} ${name} hint` })),
  };
}

test("⚠ a launcher's word is cut past the length of \"Planetary Industry\", and the full name stays", () => {
  assert.equal(launcherWord("PI"), "PI");
  assert.equal(launcherWord("Planetary Industry"), "Planetary Industry", "the longest word shown whole");
  assert.equal(launcherWord("Planetary Industries"), "Planetary Industri...");
  assert.equal(launcherWord("Planetary Industry Manager"), "Planetary Industry...");
  assert.equal(launcherWord("Planetary Industr  Manager"), "Planetary Industr...", "no space before the dots");
  const long = "A very long plugin name indeed";
  const plugin = { ...group("long", ["one", "two"]).plugin, label: long };
  const windows = group("long", ["one", "two"]).windows;
  const [whole] = pluginLaunchers({ pins: [{ kind: "plugin", pluginID: "long" }], seen: [] }, [{ plugin, windows }], new Set());
  assert.equal(whole?.label, "A very long plugin...");
  assert.equal(whole?.title, "Plugin long", "the accessible name is not cut");
  const single = { plugin, windows: [{ ...windows[0]!, label: long }] };
  const [one] = pluginLaunchers({ pins: [{ kind: "plugin", pluginID: "long" }], seen: [] }, [single], new Set());
  assert.equal(one?.label, "A very long plugin...");
});

test("a plugin's own icon is on the launcher that stands for it, and a window pinned alone keeps its own", () => {
  const glyph = ["M1 1h2"];
  const base = group("own", ["one", "two"]);
  const withIcon = { ...base, plugin: { ...base.plugin, glyph } };
  const whole: PinState = { pins: [{ kind: "plugin", pluginID: "own" }], seen: [] };
  assert.deepEqual(pluginLaunchers(whole, [withIcon], new Set())[0]?.glyph, glyph, "several windows, pinned whole");
  assert.deepEqual(pluginLaunchers(whole, [{ ...withIcon, windows: [base.windows[0]!] }], new Set())[0]?.glyph, glyph, "one window, pinned whole");
  const alone: PinState = { pins: [{ kind: "window", windowID: base.windows[0]!.id }], seen: [] };
  assert.equal(pluginLaunchers(alone, [withIcon], new Set())[0]?.glyph, undefined);
  assert.equal(pluginLaunchers(whole, [base], new Set())[0]?.glyph, undefined, "no icon of its own: its first window's stands in");
  assert.equal(pluginLaunchers(whole, [base], new Set())[0]?.glyphOf, base.windows[0]!.id);
});

const PI = group("pi", ["board", "haul", "expand"]);
const SOLO = group("solo", ["main"]);
const none = new Set<TabID>();

test("a plugin never seen pins itself whole, until three are pinned; it is met only once", () => {
  const groups = [group("a", ["x"]), group("b", ["x"]), group("c", ["x"]), group("d", ["x"])];
  const met = meetPlugins(NO_PINS, groups);
  assert.equal(met.pins.length, AUTO_PIN_LIMIT);
  assert.deepEqual(met.seen, ["a", "b", "c", "d"]);
  // Unpinned by the player, it does not come back on the next load.
  const unpinned = togglePlugin(met, groups[0]!);
  assert.deepEqual(meetPlugins(unpinned, groups), unpinned);
});

test("pinning a plugin whole takes back its windows' own pins, and covers them", () => {
  let state: PinState = { pins: [], seen: ["pi"] };
  state = toggleWindow(state, PI, "plugin:pi.haul");
  assert.deepEqual(state.pins, [{ kind: "window", windowID: "plugin:pi.haul" }]);
  state = togglePlugin(state, PI);
  assert.deepEqual(state.pins, [{ kind: "plugin", pluginID: "pi" }]);
  assert.equal(toggleWindow(state, PI, "plugin:pi.board"), state, "a covered window is not pinned twice");
});

test("a plugin pinned whole is one launcher that lists its windows, lit while any is open", () => {
  const launchers = pluginLaunchers({ pins: [{ kind: "plugin", pluginID: "pi" }], seen: [] }, [PI], new Set<TabID>(["plugin:pi.haul"]));
  assert.equal(launchers.length, 1);
  assert.equal(launchers[0]!.kind, "plugin");
  assert.equal(launchers[0]!.label, "PI");
  assert.deepEqual(launchers[0]!.windows.map((window) => window.id), ["plugin:pi.board", "plugin:pi.haul", "plugin:pi.expand"]);
  assert.equal(launchers[0]!.open, true);
});

test("a plugin with one window, pinned whole, is a launcher straight onto that window", () => {
  const [launcher] = pluginLaunchers({ pins: [{ kind: "plugin", pluginID: "solo" }], seen: [] }, [SOLO], none);
  assert.equal(launcher!.kind, "window");
  assert.equal(launcher!.windowID, "plugin:solo.main");
  assert.equal(launcher!.label, "main");
});

test("launchers keep pin order, and an unpinned window has no launcher even while it is open", () => {
  const state: PinState = { pins: [{ kind: "window", windowID: "plugin:pi.expand" }, { kind: "plugin", pluginID: "solo" }], seen: [] };
  const launchers = pluginLaunchers(state, [PI, SOLO], new Set<TabID>(["plugin:pi.board"]));
  assert.deepEqual(launchers.map((launcher) => launcher.key), ["window:plugin:pi.expand", "window:plugin:solo.main"]);
});

test("a pin of a plugin not loaded now draws nothing, and is kept for when it is back", () => {
  const state: PinState = { pins: [{ kind: "plugin", pluginID: "gone" }], seen: ["gone"] };
  assert.deepEqual(pluginLaunchers(state, [PI], none), []);
  assert.deepEqual(meetPlugins(state, []).pins, state.pins);
});

test("pins are kept in this browser, and unreadable storage is no pins", () => {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
  const state: PinState = { pins: [{ kind: "plugin", pluginID: "pi" }, { kind: "window", windowID: "plugin:x" }], seen: ["pi"] };
  savePins(state);
  assert.deepEqual(loadPins(), state);
  map.set("evejs-web-plugin-pins:v1", "{not json");
  assert.deepEqual(loadPins(), NO_PINS);
});
