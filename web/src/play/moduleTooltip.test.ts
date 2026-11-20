// The module tooltip's rows as the 3698585 client builds them (ModuleButtonTooltip.LoadTooltip on the new HUD's
// slots, read through gridcheck's client eval on an Ibis): its templates as the client's localization holds them.
import test from "node:test";
import assert from "node:assert/strict";
import { formatTemplate } from "../bridge/clientWords.ts";
import { fmtDist } from "../space/overview.ts";
import { moduleTooltipRows, type ModuleTooltipFacts } from "./moduleTooltip.ts";

const TEMPLATES: Record<string, string> = {
  "UI/Inflight/ModuleRacks/OptimalRange": "Optimal range within {optimalRange}",
  "UI/Inflight/ModuleRacks/OptimalRangeAndFalloff": "Falloff range within {falloffPlusOptimal}<br>Optimal range within {optimalRange}",
  "UI/Inflight/ModuleRacks/Tooltips/MiningAmountPerTime2": "{[numeric]amount, decimalPlaces=0} m³ per {duration} ({[numeric]amountPerSec, decimalPlaces=1} m³/s)",
  "UI/Inflight/ModuleRacks/Tooltips/MaxVelocityWithAndWithoutPropulsion": "Max Velocity without: {[numeric]maxVelocity} m/s\nMax Velocity with: {[numeric]maxVelocityWithBonus} m/s",
  "UI/Inflight/ModuleRacks/Tooltips/WeaponAccuracyScore": "{activeName}: {[numeric]activeValue, decimalPlaces=2, useGrouping}",
  "/Carbon/UI/Common/WrittenDateTimeQuantityShort/Second": "{value}s",
  "UI/Inflight/ModuleRacks/DamagePerSecond": "Damage Per Second {[numeric]dps, decimalPlaces=1}",
  "UI/Inflight/ModuleRacks/Tooltips/OneDamageTypeText": "{[numeric]activeValue, decimalPlaces=0} HP {activeName}",
  "UI/Inflight/ModuleRacks/Tooltips/DamageTypesHeader": "Damage caused",
  "UI/Inflight/ModuleRacks/Tooltips/DamageHitpoints": "{[numeric]activeValue, decimalPlaces=0} HP",
};
const word = (label: string, args: Readonly<Record<string, unknown>>) =>
  TEMPLATES[label] === undefined ? null : formatTemplate(TEMPLATES[label]!, args as never, { nameOf: () => null } as never);

function facts(over: Partial<ModuleTooltipFacts> & { attrs?: Record<number, number>; ship?: Record<number, number> }): ModuleTooltipFacts {
  return {
    typeID: 0, typeName: "", groupID: null, numInGroup: 0, shortcut: null, damagePercent: 0, repairing: false, charge: null,
    attr: (id) => over.attrs?.[id] ?? null, shipAttr: (id) => over.ship?.[id] ?? null, chargeAttr: () => null,
    launcher: false, turret: false, active: false, attributeIcon: () => null, attributeName: () => "Turret Tracking",
    typeIcon: () => null, ...over,
  };
}

test("a mining laser: its name and shortcut, its optimal range, its amount per cycle (Civilian Miner)", () => {
  const rows = moduleTooltipRows(facts({ typeID: 3651, typeName: "Civilian Miner", groupID: 54, shortcut: "F2", turret: true,
    attrs: { 54: 10000, 73: 10000, 77: 6.9 } }), word, (m) => fmtDist(m));
  assert.deepEqual(rows.map((r) => [r.text, r.shortcut ?? null, r.iconSize]), [
    ["<b>Civilian Miner</b>", "F2", 26],
    ["Optimal range within 10 km", null, 24],
    ["7 m³ per 10s (0.7 m³/s)", null, 24],
  ]);
});

test("a turret: optimal and falloff, its damage per second and types, its tracking (Civilian Gatling Railgun)", () => {
  // The client: rate of fire 1692.8 ms, damage multiplier 1.25, thermal 2 and kinetic 3 of its own (no charge).
  const rows = moduleTooltipRows(facts({ typeID: 3638, typeName: "Civilian Gatling Railgun", groupID: 74, shortcut: "F1", turret: true,
    attrs: { 54: 5280, 158: 2100, 160: 550, 51: 1692.8, 64: 1.25, 118: 2, 117: 3 } }), word, (m) => fmtDist(m));
  assert.deepEqual(rows.map((r) => r.values ? r.values.map((v) => v.text).join(" ") : r.text), [
    "<b>Civilian Gatling Railgun</b>",
    "Falloff range within 7,380 m<br>Optimal range within 5,280 m",
    "Damage Per Second 3.7",
    "Damage caused",
    "3 HP 4 HP",
    "Turret Tracking: 550.00",
  ]);
});

test("one damage type is written by its name", () => {
  const rows = moduleTooltipRows(facts({ typeID: 1, typeName: "Gun", groupID: 74, turret: true, attributeName: () => "Kinetic damage",
    attrs: { 51: 2000, 64: 1, 117: 10 } }), word, (m) => fmtDist(m));
  assert.deepEqual(rows.slice(1).map((r) => r.text), ["Damage Per Second 5.0", "10 HP Kinetic damage"]);
});

test("an afterburner not running: the ship's velocity now and with the module's boost on its mass and addition", () => {
  // 1MN Civilian Afterburner on an Ibis: the client says 339.25 m/s without, 522.85 m/s with.
  const rows = moduleTooltipRows(facts({ typeID: 21857, typeName: "1MN Civilian Afterburner", groupID: 46, shortcut: "Alt-F1",
    attrs: { 20: 60, 567: 1500000, 796: 500000 }, ship: { 37: 339.25, 4: 1163000 } }), word, (m) => fmtDist(m));
  assert.equal(rows[1]!.text, "Max Velocity without: 339.25 m/s\nMax Velocity with: 522.85 m/s");
});
