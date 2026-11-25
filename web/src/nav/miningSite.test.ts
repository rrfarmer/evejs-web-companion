import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { iceHoldFraction, iceMiningType, miningSiteFamily, siteIdentity, siteMiningFitRefusal } from "./miningSite.ts";
import type { BotScript } from "../bots/botScript.ts";
import { freightHoldItemIDs } from "./miningBotLoop.ts";
import { preferredBays } from "../bridge/bayRouting.ts";
import type { MiningHold } from "../store/types.ts";
const require = createRequire(import.meta.url);
const { miningResourceFamily } = require("../../../src/miningResourceFamily.js");
test("a Startup refit defers the site mining fit check to the refitted hull", () => {
  const main = { id: "mine", kind: "macro" as const, macro: "mine-at-belt" as const,
    args: { belt: { kind: "belt" as const, belt: { mode: "ice-site" as const } } } };
  const refit = { id: "refit", kind: "macro" as const, macro: "refit-ship" as const,
    args: { fitting: { kind: "fitting" as const, fittingID: 5, name: "Ice fit" } } };
  const plain: BotScript = { format: "evejs-bot-script", version: 1, name: "Ice mining", notes: "",
    home: { entity: "station", id: 60003760, name: "Home", systemName: "Jita" }, interrupts: [], program: [main] };
  assert.notEqual(siteMiningFitRefusal(plain, [], []), null, "without a refit the ship at Start must already mine ice");
  assert.equal(siteMiningFitRefusal({ ...plain, program: [refit, { id: "main", kind: "loop", repeat: { kind: "forever" }, body: [main] }] }, [], []), null);
});

test("scanner families and identity require authoritative fields, not names", () => {
  assert.equal(miningSiteFamily({ label: "Ice Haven", kind: "ore", archetypeID: 27 }), "ORE_ANOMALY");
  assert.equal(miningSiteFamily({ label: "Ordinary ore", kind: "ore", archetypeID: 28 }), "ICE");
  assert.equal(miningSiteFamily({ label: "Ice", kind: "ore" }), null);
  assert.equal(miningSiteFamily({ label: "Ice", kind: "gas", archetypeID: 28 }), null);
  assert.equal(siteIdentity({ label: "ABC", kind: "ore", siteID: 100, instanceID: 200 }), "site:100:instance:200");
  assert.equal(siteIdentity({ label: "ABC", kind: "ore" }), null);
});

test("Ice capability comes from mining amount and required skill dogma, never display names", () => {
  // Audited Ice Harvester I (16278): miningAmount 1000, requiredSkill1 16281.
  assert.equal(iceMiningType({ 77: 1000, 182: 16281 }), true);
  assert.equal(iceMiningType({ 77: 540, 182: 3386 }), false);
  assert.equal(iceMiningType({ 182: 16281 }), false, "an upgrade/rig is not an active harvester");
  assert.equal(iceMiningType(undefined), false);
  assert.equal(miningResourceFamily({ groupID: 465, categoryID: 25 }), "ice");
  assert.equal(miningResourceFamily({ groupID: 462, categoryID: 25 }), "ore");
  assert.equal(miningResourceFamily({ groupID: 711, categoryID: 25 }), "gas");
  assert.equal(miningResourceFamily({ groupID: 4094, categoryID: 25 }), null);
});

test("Ice freight uses ice/general mining holds; unrelated cargo remains aboard", () => {
  const holds: MiningHold[] = [{ key: "ice", label: "Ice", present: true, error: null,
    capacity: { capacity: 10000, used: 9000 } as MiningHold["capacity"],
    items: [{ itemID: 10, typeID: 16265, quantity: 9, groupID: 465, categoryID: 25 }] },
  { key: "ore", label: "Mining", present: true, error: null, capacity: { capacity: 10000, used: 0 } as MiningHold["capacity"], items: [] },
  { key: "cargo", label: "Cargo", present: true, error: null, capacity: null, items: [{ itemID: 20, typeID: 1, quantity: 5, categoryID: 8, groupID: 1 }] }];
  assert.equal(iceHoldFraction(holds), 0.9);
  assert.equal(iceHoldFraction(null), null);
  assert.deepEqual(freightHoldItemIDs(holds), [10]);
  assert.deepEqual(preferredBays({ groupID: 465, categoryID: 25 }), ["ice", "ore"]);
});
