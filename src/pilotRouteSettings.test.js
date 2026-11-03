"use strict";

// Each pilot's route settings as its page keeps them, kept on the BFF for the
// runs the server hosts: kept per pilot, across a restart, bounded, and handed
// to a hosted flow under the key the page's flow reads them by.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createPilotRouteSettings, routeSettingsKey, MAX_SETTINGS_BYTES } = require("./pilotRouteSettings");

test("the key is the one the page's flow keeps a character's route settings under", async () => {
  const { autopilotSettingsKey } = await import("../web/src/nav/autopilotSettings.ts");
  assert.equal(routeSettingsKey(90000001), autopilotSettingsKey(90000001));
});

test("a pilot's settings are kept as sent, its own, and survive a restart", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-settings-"));
  const filePath = path.join(root, "data", "pilot-route-settings.json");
  const kept = createPilotRouteSettings({ filePath });
  assert.equal(kept.get(90000001), null);
  kept.set(90000001, { pfRouteType: "shortest", pfPenalty: 20 });
  kept.set(90000002, { pfRouteType: "unsafe" });
  const again = createPilotRouteSettings({ filePath });
  assert.deepEqual(JSON.parse(again.get(90000001)), { pfRouteType: "shortest", pfPenalty: 20 });
  assert.deepEqual(JSON.parse(again.get(90000002)), { pfRouteType: "unsafe" });
});

test("only an object of bounded size is kept", () => {
  const kept = createPilotRouteSettings();
  assert.throws(() => kept.set(90000001, "shortest"), { code: "INVALID_ROUTE_SETTINGS" });
  assert.throws(() => kept.set(90000001, ["shortest"]), { code: "INVALID_ROUTE_SETTINGS" });
  assert.throws(() => kept.set(90000001, { autopilot_avoidance2: "x".repeat(MAX_SETTINGS_BYTES) }), { code: "INVALID_ROUTE_SETTINGS" });
  assert.throws(() => kept.set(0, {}), { code: "INVALID_CHARACTER" });
  assert.equal(kept.get(90000001), null);
});

test("a hosted flow's storage answers the pilot's route settings, and nothing else", () => {
  const kept = createPilotRouteSettings();
  const storage = kept.storageFor(90000001);
  assert.equal(storage.getItem(routeSettingsKey(90000001)), null);
  kept.set(90000001, { pfRouteType: "shortest" });
  assert.equal(storage.getItem(routeSettingsKey(90000001)), JSON.stringify({ pfRouteType: "shortest" }));
  assert.equal(storage.getItem(routeSettingsKey(90000002)), null);
  assert.equal(storage.getItem("evejs.useFittingNameForShips"), null);
  storage.setItem(routeSettingsKey(90000001), JSON.stringify({ pfRouteType: "unsafe" }));
  assert.equal(storage.getItem(routeSettingsKey(90000001)), JSON.stringify({ pfRouteType: "shortest" }), "a run does not change its pilot's settings");
});
