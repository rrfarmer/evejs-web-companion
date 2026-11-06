// What a plugin adds to the page beyond its windows: settings of its own, the count on
// its launcher, and what it draws in the Pilot Hangar.

import test from "node:test";
import assert from "node:assert/strict";

import { formerHangarSetting, pluginSetting, resetPluginSettingsForTests } from "./pluginSettings.ts";
import { loadHangarPrefs, onHangarPrefsSaved, saveHangarPrefs, setHangarPrefsStorage } from "../app/hangarPrefs.ts";
import { countPluginPilots, pluginIDOf } from "../ui/pluginPilotCounts.ts";
import { pluginMemberSettings, pluginSquadControls, registerHangarViews, type SquadControlView, type SquadMemberSettingView } from "../ui/pluginHangarViews.ts";

function memoryStorage(seed: Record<string, string> = {}, refuses = false) {
  const held = new Map(Object.entries(seed));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refuses) throw new Error("full");
      held.set(key, value);
    },
  };
  resetPluginSettingsForTests();
  return held;
}

const numberOrNothing = (raw: unknown): number | undefined => (typeof raw === "number" ? raw : undefined);
const KEY = "evejs-web-plugin-settings:plugin:trader";

test("a setting starts at its initial, and what is set is saved and read back", () => {
  const held = memoryStorage();
  const setting = pluginSetting("plugin:trader", { initial: 1, decode: numberOrNothing });
  assert.equal(setting.get(), 1);
  setting.set(5);
  assert.equal(held.get(KEY), "5");
  resetPluginSettingsForTests();
  assert.equal(pluginSetting("plugin:trader", { initial: 1, decode: numberOrNothing }).get(), 5);
});

test("update saves as set does, and listeners hear both", () => {
  const held = memoryStorage();
  const setting = pluginSetting("plugin:trader", { initial: 1, decode: numberOrNothing });
  const heard: number[] = [];
  setting.subscribe((value) => heard.push(value));
  setting.update((value) => value + 1);
  assert.equal(held.get(KEY), "2");
  assert.equal(heard.at(-1), 2);
});

test("the same key is the same signal", () => {
  memoryStorage();
  const first = pluginSetting("plugin:trader", { initial: 1, decode: numberOrNothing });
  first.set(3);
  assert.equal(pluginSetting("plugin:trader", { initial: 9, decode: numberOrNothing }).get(), 3);
});

test("saved bytes that mean nothing give the initial, and broken ones do not throw", () => {
  memoryStorage({ [KEY]: "\"not a number\"" });
  assert.equal(pluginSetting("plugin:trader", { initial: 1, decode: numberOrNothing }).get(), 1);
  memoryStorage({ [KEY]: "{broken" });
  assert.equal(pluginSetting("plugin:trader", { initial: 1, decode: numberOrNothing }).get(), 1);
});

test("storage that refuses keeps the setting for as long as the page is open", () => {
  memoryStorage({}, true);
  const setting = pluginSetting("plugin:trader", { initial: 1, decode: numberOrNothing });
  setting.set(4);
  assert.equal(setting.get(), 4);
});

test("a setting takes over from where it was kept, once, and saves it as its own", () => {
  const held = memoryStorage({ "evejs-web-hangar-prefs:v1": JSON.stringify({ oldField: 8 }) });
  const read = () => pluginSetting("plugin:trader", { initial: 1, decode: numberOrNothing, formerly: () => formerHangarSetting("oldField") });
  assert.equal(read().get(), 8);
  assert.equal(held.get(KEY), "8");
  resetPluginSettingsForTests();
  held.set("evejs-web-hangar-prefs:v1", JSON.stringify({ oldField: 99 }));
  assert.equal(read().get(), 8, "what is saved as its own wins");
});

test("a former setting that is absent, unreadable or throws gives the initial and saves nothing", () => {
  for (const formerly of [() => formerHangarSetting("nothing"), () => "words", () => { throw new Error("boom"); }]) {
    const held = memoryStorage({ "evejs-web-hangar-prefs:v1": "{}" });
    assert.equal(pluginSetting("plugin:trader", { initial: 1, decode: numberOrNothing, formerly }).get(), 1);
    assert.equal(held.has(KEY), false);
  }
});

test("a null that was saved stays null, where nothing saved gives the initial", () => {
  memoryStorage();
  const nullable = () => pluginSetting<string | null>("plugin:trader", {
    initial: "a",
    decode: (raw) => (raw === null || typeof raw === "string" ? raw : undefined),
  });
  assert.equal(nullable().get(), "a");
  nullable().set(null);
  resetPluginSettingsForTests();
  assert.equal(nullable().get(), null);
});

test("a decode that throws counts as bytes that mean nothing, saved or former", () => {
  const throwing = { initial: 1, decode: (raw: unknown) => (raw as number[]).map(Number)[0] };
  memoryStorage({ [KEY]: "5" });
  assert.equal(pluginSetting("plugin:trader", throwing).get(), 1);
  memoryStorage();
  assert.equal(pluginSetting("plugin:trader", { ...throwing, formerly: () => 5 }).get(), 1);
});

test("the Hangar keeps a field it does not know when it saves, for a plugin yet to take it over", () => {
  const held = memoryStorage();
  setHangarPrefsStorage(globalThis.localStorage as never);
  held.set("evejs-web-hangar-prefs:v1", JSON.stringify({ squads: [], members: {}, oldField: { kept: true } }));
  saveHangarPrefs({ ...loadHangarPrefs(), pinnedPilots: [90000001] });
  const after = JSON.parse(held.get("evejs-web-hangar-prefs:v1")!);
  assert.deepEqual(after.oldField, { kept: true });
  assert.deepEqual(after.pinnedPilots, [90000001]);
  assert.deepEqual(formerHangarSetting("oldField"), { kept: true });
});

test("a listener hears each arrangement saved, and a throwing one goes no further", () => {
  memoryStorage();
  setHangarPrefsStorage(globalThis.localStorage as never);
  const heard: (readonly number[])[] = [];
  const realError = console.error;
  console.error = () => {};
  const stopThrowing = onHangarPrefsSaved(() => { throw new Error("boom"); });
  const stop = onHangarPrefsSaved((prefs) => heard.push(prefs.pinnedPilots));
  saveHangarPrefs({ ...loadHangarPrefs(), pinnedPilots: [7] });
  console.error = realError;
  stop();
  stopThrowing();
  saveHangarPrefs({ ...loadHangarPrefs(), pinnedPilots: [8] });
  assert.deepEqual(heard, [[7]]);
});

test("the launcher's count is pilots per plugin, from what holds each ship", () => {
  const counts = countPluginPilots(["plugin:trader", "custom", null, "plugin:trader", "plugin:hauler", "mining"]);
  assert.deepEqual([...counts], [["trader", 2], ["hauler", 1]]);
  assert.equal(countPluginPilots([null, "mission"]).size, 0);
});

test("a window's id and a holder's name both give the plugin", () => {
  assert.equal(pluginIDOf("plugin:trader"), "trader");
  assert.equal(pluginIDOf("plugin:trader.prices"), "trader");
  assert.equal(pluginIDOf("mission"), null);
  assert.equal(pluginIDOf("plugin:"), null);
});

test("what a plugin draws in the Hangar is listed under the plugin, and what it does not, not", () => {
  const button = (() => {}) as unknown as SquadControlView;
  const tick = (() => {}) as unknown as SquadMemberSettingView;
  registerHangarViews("trader", { squadControl: button, squadMemberSetting: tick });
  registerHangarViews("hauler", {});
  assert.deepEqual(pluginSquadControls().filter((row) => row.pluginID === "hauler"), []);
  assert.equal(pluginSquadControls().find((row) => row.pluginID === "trader")?.view, button);
  assert.equal(pluginMemberSettings().find((row) => row.pluginID === "trader")?.view, tick);
});
