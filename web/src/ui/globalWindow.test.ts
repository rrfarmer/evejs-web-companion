// The global window layer — the windows that outlive a pilot switch.
//
// What is worth pinning here is not the arithmetic but the rules that make a
// window "global" at all: that its position is NOT stored per character (the
// bug being fixed is the same window jumping around as you switch pilots), that
// a tab which is global can never also be a per-pilot desktop window (which
// would put a second, character-scoped copy of the roster on screen), and —
// since a second window arrived beside the Bot Manager — that two global
// windows can be open AT ONCE rather than evicting each other.
//
// The desktop rule is enforced in desktop.ts and asserted from here, because it
// is this module's decision that desktop.ts is obeying.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BUILDER_TAB,
  DEFAULT_GLOBAL_POS,
  CORE_GLOBAL_LAUNCHERS,
  globalLaunchers,
  isGlobalTab,
  isGlobalWindow,
  loadGlobalWindows,
  openGlobal,
  saveGlobalWindows,
} from "./globalWindow.ts";
import { isWindowTab, loadLayout, openWindow, saveLayout, type WinState } from "./desktop.ts";
import { launchableTabsFor, TABS } from "./tabs.ts";

/** A minimal localStorage, since Node has none by default. */
function installStorage(): void {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    removeItem: (key: string): void => void map.delete(key),
    clear: (): void => map.clear(),
  };
}

const win = (id: string, over: Partial<WinState> = {}): WinState =>
  ({ id, x: 10, y: 10, w: 400, h: 300, z: 1, minimized: false, ...over }) as WinState;

/** One window by position, asserted present — `noUncheckedIndexedAccess` is on. */
function at(wins: readonly WinState[], index: number): WinState {
  const found = wins[index];
  assert.ok(found, `expected a window at index ${index}`);
  return found;
}

/** One window by id, asserted present. */
function byId(wins: readonly WinState[], id: string): WinState {
  const found = wins.find((w) => w.id === id);
  assert.ok(found, `expected the ${id} window`);
  return found;
}

const CHARACTER_BAR = readFileSync(new URL("./CharacterBar.svelte", import.meta.url), "utf8");
const HANGAR = readFileSync(new URL("./PilotHangar.svelte", import.meta.url), "utf8");

// ─── which tabs are global ───────────────────────────────────────────────────

test("the Bot Manager and Industry Manager are global; an ordinary panel is not", () => {
  assert.equal(isGlobalTab("botManager"), true);
  assert.equal(isGlobalTab("industryManager"), true);
  assert.equal(isGlobalTab("market"), false);
});

test("every global tab has a door somewhere", () => {
  // Being global changes WHERE a panel opens, never whether it can be opened.
  // If this ever fails the panel has become unreachable, which is a worse bug
  // than the crowding the hoist was part of fixing.
  //
  // They share ONE door, and it is not the rail: the launcher strip beside the
  // brand (GlobalLaunchers.svelte), which the character bar AND the Pilot
  // Hangar carry — so each opens with nobody in the client as well as over a
  // cockpit. So every global tab must be a launcher and none a rail entry.
  const launchers = new Set(globalLaunchers().map((launcher) => launcher.id));
  assert.equal(launchers.size, globalLaunchers().length, "a global tab is launched twice");
  for (const id of launchers) assert.equal(isGlobalTab(id), true, `${id} has a door but is not global`);
  for (const docked of [true, false]) {
    const offered = new Set(launchableTabsFor(docked).map((tab) => tab.id));
    for (const id of launchers) {
      assert.equal(offered.has(id), false, `'${id}' opens from the brand strip, not the rail`);
    }
  }
  assert.match(CHARACTER_BAR, /<GlobalLaunchers/, "the character bar must carry the launchers");
  assert.match(HANGAR, /<GlobalLaunchers/, "the Pilot Hangar must carry the launchers");
});

test("a global tab that is not launchable is still a named tab", () => {
  // The window's title comes from `tabLabel`, and NEOCOM_GLYPHS is exhaustive
  // over TabID — so a global tab missing from the table would be a window
  // called by its id, or a build failure in the icon map.
  for (const { id } of CORE_GLOBAL_LAUNCHERS) {
    assert.equal(
      TABS.some((tab) => tab.id === id),
      true,
      `${id} must be in the tab table`,
    );
  }
});

// ─── it is never ALSO a per-pilot window ─────────────────────────────────────

test("a workspace desktop refuses to open a global tab as its own window", () => {
  // Two copies of the roster, one per pilot, is exactly what the hoist removes.
  assert.deepEqual(openWindow([], "botManager"), []);
  assert.deepEqual(openWindow([], "industryManager"), []);
});

test("a layout saved before the hoist does not resurrect a per-pilot copy", () => {
  installStorage();
  saveLayout(140000005, {
    wins: [win("botManager"), win("industryManager"), win("market")],
    dockCollapsed: false,
    dockWidth: 340,
    targetsX: 20,
    targetsY: 12,
    stationExpanded: false,
  });
  assert.deepEqual((loadLayout(140000005)?.wins ?? []).map((w) => w.id), ["market"]);
});

test("a global tab is still a WINDOW — the rail filters on that and must keep it", () => {
  // ⚠ The guard deliberately lives in openWindow/isWinState and NOT in
  // isWindowTab, because Neocom and MobileWorkspace filter their entries with
  // isWindowTab: excluding it there would delete the launcher entry instead of
  // just the desktop window. This pins that distinction.
  assert.equal(isWindowTab("botManager"), true);
  assert.equal(isWindowTab("industryManager"), true);
});

// ─── opening ────────────────────────────────────────────────────────────────

test("opening the first one places it at the default spot", () => {
  const wins = openGlobal([], "botManager");
  assert.equal(wins.length, 1);
  assert.equal(at(wins, 0).id, "botManager");
  assert.equal(at(wins, 0).x, DEFAULT_GLOBAL_POS.x);
  assert.equal(at(wins, 0).y, DEFAULT_GLOBAL_POS.y);
  assert.equal(at(wins, 0).minimized, false);
});

test("a second global window opens BESIDE the first, never in place of it", () => {
  // ⚠ THE REGRESSION THIS LAYER WAS RESHAPED FOR. It held exactly one window
  // while the Bot Manager was alone on it; adding a second window to that
  // model would have made the two evict each other — open the Industry
  // Manager and the Bot Manager you were reading vanishes.
  const wins = openGlobal(openGlobal([], "botManager"), "industryManager");
  assert.deepEqual(wins.map((w) => w.id), ["botManager", "industryManager"]);
  assert.notEqual(at(wins, 1).x, at(wins, 0).x, "the second must not land on the first");
  assert.equal(at(wins, 1).z > at(wins, 0).z, true, "the one just opened is on top");
});

test("re-opening a window already open keeps where the player put it", () => {
  // The door is a toggle onto a window that may just be put away — it must not
  // snap a window the player dragged and resized back to the default.
  const opened = at(openGlobal([], "botManager"), 0);
  const again = openGlobal([{ ...opened, x: 300, y: 200, w: 900, h: 600 }], "botManager");
  assert.equal(again.length, 1);
  assert.equal(at(again, 0).x, 300);
  assert.equal(at(again, 0).y, 200);
  assert.equal(at(again, 0).w, 900);
  assert.equal(at(again, 0).h, 600);
});

test("re-opening a put-away window brings it back rather than doing nothing", () => {
  const away = [{ ...at(openGlobal([], "industryManager"), 0), minimized: true }];
  assert.equal(at(openGlobal(away, "industryManager"), 0).minimized, false);
});

test("re-opening the one underneath raises it above the other", () => {
  const both = openGlobal(openGlobal([], "botManager"), "industryManager");
  const raised = openGlobal(both, "botManager");
  assert.equal(byId(raised, "botManager").z > byId(raised, "industryManager").z, true);
});

test("a tab that is not global is refused rather than placed here", () => {
  // It belongs to a pilot's desktop; drawing it here would float a
  // character-scoped panel above the bar that switches characters.
  assert.deepEqual(openGlobal([], "market"), []);
});

test("the Bot Builder floats here, over the Bot Manager that opens it", () => {
  // The Manager's New and Edit are its only doors. On a pilot's desktop it sat
  // under this layer, behind the Manager; and with nobody in the client there
  // is no desktop at all.
  const manager = openGlobal([], "botManager");
  const wins = openGlobal(manager, BUILDER_TAB);
  assert.deepEqual(wins.map((w) => w.id), ["botManager", "botBuilder"]);
  const [m, b] = wins as [WinState, WinState];
  assert.ok(b.z > m.z, "the builder opened under the Manager");
  assert.equal(isGlobalWindow(BUILDER_TAB), true);
  assert.equal(isGlobalTab(BUILDER_TAB), false, "it would demand a launcher in the brand strip");
});

// ─── persistence ────────────────────────────────────────────────────────────

test("the saved positions round-trip", () => {
  installStorage();
  saveGlobalWindows([
    win("botManager", { x: 120, y: 90, w: 800, h: 560 }),
    win("industryManager", { x: 200, y: 150, w: 760, h: 500 }),
  ]);
  const loaded = loadGlobalWindows();
  assert.deepEqual(loaded.map((w) => w.id), ["botManager", "industryManager"]);
  assert.equal(at(loaded, 0).x, 120);
  assert.equal(at(loaded, 1).h, 500);
});

test("the windows are stored ONCE, not once per character", () => {
  // The whole point: desktop.ts keys its layout by characterID because a
  // desktop belongs to a pilot. These do not, so two pilots must not be able to
  // hold two different positions for them — the "same window jumping around as
  // you switch" behaviour the hoist exists to remove.
  installStorage();
  saveGlobalWindows([win("botManager", { x: 120, y: 90 })]);
  saveGlobalWindows([win("botManager", { x: 300, y: 200 })]);
  assert.equal(at(loadGlobalWindows(), 0).x, 300);

  for (const characterID of [140000005, 140000006]) {
    saveLayout(characterID, {
      wins: [win("botManager"), win("market")],
      dockCollapsed: false,
      dockWidth: 340,
      targetsX: 20,
      targetsY: 12,
      stationExpanded: false,
    });
    assert.deepEqual((loadLayout(characterID)?.wins ?? []).map((w) => w.id), ["market"]);
  }
});

test("a window saved under the old single-window key is carried over, once", () => {
  // ⚠ A PLAYER HAS A BOT MANAGER SITTING WHERE THEY PUT IT. Shipping the list
  // key without reading the old one would silently move it back to the default
  // corner. It is migrated on the first read and the old key is then cleared,
  // so it can never drift back into use.
  installStorage();
  localStorage.setItem(
    "evejs-web-global-window:v1",
    JSON.stringify({ id: "botManager", x: 240, y: 160, w: 700, h: 520, z: 1, minimized: false }),
  );
  const loaded = loadGlobalWindows();
  assert.deepEqual(loaded.map((w) => w.id), ["botManager"]);
  assert.equal(at(loaded, 0).x, 240);
  assert.equal(localStorage.getItem("evejs-web-global-window:v1"), null);
});

test("a stored id that is no longer global is dropped rather than drawn", () => {
  // The migration path if a tab ever stops being global: a leftover record must
  // not open a window on a layer that no longer claims that panel.
  installStorage();
  localStorage.setItem(
    "evejs-web-global-windows:v2",
    JSON.stringify([{ id: "market", x: 10, y: 10, w: 400, h: 300, z: 1, minimized: false }]),
  );
  assert.deepEqual(loadGlobalWindows(), []);
});

test("standalone MCC does not reopen its old floating window or discard other global windows", () => {
  installStorage();
  localStorage.setItem(
    "evejs-web-global-windows:v2",
    JSON.stringify([win("miningOperations"), win("botManager"), win("industryManager")]),
  );
  assert.equal(isGlobalTab("miningOperations"), false);
  assert.deepEqual(openGlobal([], "miningOperations"), []);
  assert.deepEqual(loadGlobalWindows().map(w => w.id), ["botManager", "industryManager"]);
});

test("one window per tab, enforced on the way IN as well as by the reducers", () => {
  // A duplicate id makes App's keyed `{#each … (win.id)}` throw on every render
  // from then on, permanently, because the bad list is written straight back.
  installStorage();
  localStorage.setItem(
    "evejs-web-global-windows:v2",
    JSON.stringify([
      { id: "industryManager", x: 10, y: 10, w: 400, h: 300, z: 1, minimized: false },
      { id: "industryManager", x: 90, y: 90, w: 400, h: 300, z: 2, minimized: false },
    ]),
  );
  const loaded = loadGlobalWindows();
  assert.equal(loaded.length, 1);
  assert.equal(at(loaded, 0).x, 10, "first one wins");
});

test("a corrupt record reads as 'no windows', never as a throw", () => {
  installStorage();
  localStorage.setItem("evejs-web-global-windows:v2", "{not json");
  assert.deepEqual(loadGlobalWindows(), []);
  localStorage.setItem(
    "evejs-web-global-windows:v2",
    JSON.stringify([{ id: "botManager", x: "left", y: 10, w: 400, h: 300 }]),
  );
  assert.deepEqual(loadGlobalWindows(), []);
});

test("saving an empty list clears the record", () => {
  installStorage();
  saveGlobalWindows([win("botManager")]);
  saveGlobalWindows([]);
  assert.deepEqual(loadGlobalWindows(), []);
});

test("a put-away window comes back put away, not on screen", () => {
  installStorage();
  saveGlobalWindows([win("industryManager", { minimized: true })]);
  assert.equal(at(loadGlobalWindows(), 0).minimized, true);
});

test("a floating Bot Builder is not reopened by a reload", () => {
  // Which pilot it reads is decided by the New or Edit that opened it.
  installStorage();
  saveGlobalWindows([win("botManager"), win(BUILDER_TAB)]);
  assert.deepEqual(loadGlobalWindows().map((w) => w.id), ["botManager"]);
});

// ─── a plugin's global window ───────────────────────────────────────────────

test("a plugin's global window gets a launcher, a named tab, a glyph and a stored place, and core keeps its own", async () => {
  const { registerGlobalWindow } = await import("./globalWindow.ts");
  const { neocomGlyph } = await import("./neocomIcons.ts");
  const { allTabs, tabLabel } = await import("./tabs.ts");
  const glyph = ["M4 4h16v16H4z"];
  registerGlobalWindow({ id: "plugin:test-board", label: "Board", title: "Test board", hint: "A plugin board", glyph, plugin: { id: "test-board", name: "Test", label: "Board" } });
  assert.equal(isGlobalTab("plugin:test-board"), true);
  assert.deepEqual(globalLaunchers().slice(0, CORE_GLOBAL_LAUNCHERS.length), [...CORE_GLOBAL_LAUNCHERS], "core's launchers come first, unchanged");
  assert.equal(tabLabel("plugin:test-board"), "Test board");
  assert.deepEqual(neocomGlyph("plugin:test-board"), glyph);
  const tab = allTabs().find((entry) => entry.id === "plugin:test-board");
  assert.equal(tab?.launchable, false, "a global window never sits in the rail");
  assert.throws(() => registerGlobalWindow({ id: "plugin:test-board", label: "Again", title: "Again", hint: "", glyph, plugin: { id: "test-board", name: "Test", label: "Again" } }), /already a tab/);
  installStorage();
  saveGlobalWindows(openGlobal([], "plugin:test-board"));
  assert.deepEqual(loadGlobalWindows().map((win) => win.id), ["plugin:test-board"]);
});
