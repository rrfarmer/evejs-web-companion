// Picturing existing info subjects and the remaining launcher tabs.
// The old shared-target/repeat-raises/tab assertions described removed plumbing.
// Native infosvc412-454 uses independent windows and duplicate modern no-op.
import test from "node:test";
import assert from "node:assert/strict";
import { subjectTypeID } from "./showInfo.ts";
import { TABS, isLaunchable, launchableTabsFor, visibleTabsFor } from "./tabs.ts";

// --- picturing a subject -----------------------------------------------------

test("a subject's typeID is what it can be pictured by", () => {
  assert.equal(subjectTypeID({ kind: "type", typeID: 34 }), 34);
  assert.equal(subjectTypeID({ kind: "module", itemID: 1, typeID: 483 }), 483);
  // inventorycommon.const.typeMedal1592; MedalRibbonEntry.ShowInfo869-872.
  assert.equal(subjectTypeID({ kind: "medal", typeID: 29496, itemID: 2, graphics: [] }), 29496);
  assert.equal(subjectTypeID({ kind: "spaceObject", itemID: 1, typeID: 1230 }), 1230);
});

test("a space object with no type stays NULL, never a zero", () => {
  // The snapshot really does carry `typeID: null` for rows the runtime did not
  // stamp. A 0 would send the icon cache off to fetch a picture for type zero.
  assert.equal(subjectTypeID({ kind: "spaceObject", itemID: 1, typeID: null }), null);
});

test("a pilot has no typeID to be pictured by", () => {
  assert.equal(subjectTypeID({ kind: "character", characterID: 140000005 }), null);
});

test("no subject, no typeID", () => {
  assert.equal(subjectTypeID(null), null);
});

/**
 * The tabs deliberately kept OUT of the launcher rail, and why each is.
 *
 * Two different reasons, both legitimate, and worth keeping distinct:
 *  • `botBuilder` and `bots` are GROUPED — both open perfectly well on nothing
 *    (a new, empty bot; the built-in checklists), but the rail carried four bot
 *    entries and the Bot Manager is the one door onto bots now. Both are
 *    reached from there.
 *
 * Anything NOT on this list must stay launchable.
 */
// The Bot Manager, Planetary Industry and the Industry Manager are out because
// they are global windows that open from the brand strip (GlobalLaunchers.svelte).
// The Mining Command Center is out too, and is not a window at all: its door is a
// link from that strip to the standalone '/mining-command-center' page,
// pinned by miningOperationsPanel.test.ts.
// CorpDecorations.CreateDecorationForm50 opens the contextual picker window.
const NOT_IN_THE_RAIL = new Set(["botBuilder", "bots", "botManager", "pluginManager", "industryManager", "miningOperations", "medalDesigner"]);

test("every OTHER tab is still launchable", () => {
  // ⚠ `launchable` is absent on every pre-existing tab and absent means yes. A
  // truthiness test instead of `!== false` would empty the entire rail, which is
  // the kind of change that looks like a styling bug. This is also the guard
  // that makes hiding a tab from the rail a DELIBERATE act: a panel quietly
  // dropping off it is otherwise invisible until somebody goes looking for it.
  for (const tab of TABS) {
    if (NOT_IN_THE_RAIL.has(tab.id)) continue;
    assert.equal(isLaunchable(tab), true, `the '${tab.id}' tab must stay launchable`);
  }
});

test("every tab kept out of the rail is still VISIBLE, so its window can stay open", () => {
  // Not launchable and not visible are different facts. A tab that is not
  // VISIBLE has its window closed by the state filter, which would shut the Bot
  // Builder the moment it opened.
  for (const id of NOT_IN_THE_RAIL) {
    for (const docked of [true, false]) {
      assert.equal(
        visibleTabsFor(docked).some((entry) => entry.id === id),
        true,
        `'${id}' must stay visible while ${docked ? "docked" : "in space"}`,
      );
      assert.equal(
        launchableTabsFor(docked).some((entry) => entry.id === id),
        false,
        `'${id}' must not sit in the rail`,
      );
    }
  }
});
