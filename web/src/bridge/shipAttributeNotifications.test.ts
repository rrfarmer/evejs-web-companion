// godma.OnMultiEvent_ and BroadcastFilteredGSF (godma.py 212 to 271): the effects riding a multi-event go on as an
// OnGodmaShipEffect each, a moment at a time, the last of each item's effect in a moment. The events are an
// afterburner's start and stop as EveJS sent them to the page on 2026-11-09 (Test Pilot, Jita).

import test from "node:test";
import assert from "node:assert/strict";

import { multiEventShipEffects, multiEventDamageMessages } from "./shipAttributeNotifications.ts";

const long = (value: string) => ({ type: "long", value });
const env = [9988400103292, 140000001, 9988400103291, null, null, [], 6731, null];
const start = ["OnGodmaShipEffect", 9988400103292, 6731, long("134387255703400000"), 1, 1, env, long("134387255703400000"), 10000, 1000, null];
const stop = ["OnGodmaShipEffect", 9988400103292, 6731, long("134387255803400000"), 0, 0, env, long("134387255703400000"), 10000, false, null];
const attribute = ["OnModuleAttributeChange", 140000001, 9988400103291, 18, long("134387255703400000"), 120, 123, long("134387255703400000")];

test("an effect's start and stop in two moments go on in order, as the notice's arguments", () => {
  const told = multiEventShipEffects([{ type: "list", items: [[stop, long("134387255803400000")], [start, long("134387255703400000")], [attribute, long("134387255703400000")]] }]);
  assert.deepEqual(told, [start.slice(1), stop.slice(1)]);
});

test("of one moment only the last told for an item's effect goes on", () => {
  const moment = long("134387255803400000");
  const told = multiEventShipEffects([{ type: "list", items: [[stop, moment], [start, moment]] }]);
  assert.deepEqual(told, [stop.slice(1)]);
});

// A Tranquility abyssal run's multi-event (LOGS/Abyssal/TQCalmAbysaal1.txt): its OnDamageMessage events, each
// (['OnDamageMessage', {...}], time), several to one moment, beside the moment's OnTarget events.
test("every damage message in a multi-event goes on, a moment at a time and in the order told", () => {
  const msg = (attackerID: number, damage: number) => ["OnDamageMessage", { attackerID, damage, attackType: "otherPlayerWeapons" }];
  const t1 = long("134286286103142768"), t0 = long("134286286102830208");
  const target = ["OnTarget", "otheradd", 9002291438000172808];
  const told = multiEventDamageMessages([{ type: "list", items: [[target, t0], [msg(807, 0), t1], [msg(808, 3), t1], [msg(806, 1), t0]] }]);
  assert.deepEqual(told, [[{ attackerID: 806, damage: 1, attackType: "otherPlayerWeapons" }], [{ attackerID: 807, damage: 0, attackType: "otherPlayerWeapons" }], [{ attackerID: 808, damage: 3, attackType: "otherPlayerWeapons" }]]);
});
