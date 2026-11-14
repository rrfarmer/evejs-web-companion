// EVERY TAB REACHES ITS OWN PANEL.
//
// ⚠ FOUND LIVE, AND IT HAD BEEN WRONG THE WHOLE TIME. `PanelHost` is one long
// `{#if tab === …}` chain, so a tab with no branch of its own did not error — it
// fell through to the last arm, inside a window whose title bar said whatever
// the tab was called. The notice log was in exactly that state: imported at the
// top of the file, rendered nowhere, and reachable from the Neocom by a button
// that opened the wrong thing in a window titled "Log".
//
// That is a failure mode no render test catches, because every render test asks
// for the panel it already knows about. It is caught by counting instead: the
// tab list is the authority, and every id on it must appear in the chain.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { TABS } from "./tabs.ts";
import { CORE_GLOBAL_LAUNCHERS } from "./globalWindow.ts";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = readFileSync(path.join(UI_DIR, "PanelHost.svelte"), "utf8").replace(/\r\n/g, "\n");
/** Just the render chain, so an id mentioned only in a comment cannot count. */
const CHAIN = HOST.slice(HOST.indexOf("{#if GlobalView}"));
const VIEWS = readFileSync(path.join(UI_DIR, "globalWindowViews.ts"), "utf8");
/** Global windows draw what they registered (globalWindowViews.ts), not a branch of their own. */
const GLOBAL = new Set<string>(CORE_GLOBAL_LAUNCHERS.map((launcher) => launcher.id));
/**
 * Tabs that never open a window, so PanelHost must NOT route them. The Mining
 * Command Center is a standalone page linked from the brand strip; its own test
 * (miningOperationsPanel.test.ts) pins both the link and its absence here.
 */
const NOT_A_WINDOW = new Set(["miningOperations"]);

test("⚠ EVERY TAB HAS ITS OWN BRANCH — none falls through to another panel", () => {
  assert.ok(CHAIN.length > 0, "the render chain is not where this test looks");
  const missing = TABS.filter((tab) => !NOT_A_WINDOW.has(tab.id) && !GLOBAL.has(tab.id) && !CHAIN.includes(`tab === "${tab.id}"`)).map((t) => t.id);
  assert.deepEqual(missing, [], `these tabs open some other panel: ${missing.join(", ")}`);
});

test("every core global window has a view, and the host draws it before any branch", () => {
  for (const id of GLOBAL) assert.match(VIEWS, new RegExp(`\["${id}", \w+ as GlobalWindowView\]`), `${id} draws nothing`);
  assert.ok(CHAIN.startsWith("{#if GlobalView}\n  <GlobalView "), "a global window falls into some other branch");
});

test("the log tab opens the log, which is the half of the notice system you can go back to", () => {
  // (the play page's Log reads the store's words and asks for them: it is handed the store and flow)
  assert.match(CHAIN, /\{:else if tab === "log"\}[\s\S]{0,900}<NoticeLog( \{store\} \{flow\})? \/>/);
  assert.ok(TABS.some((tab) => tab.id === "log"), "there is no log tab to open");
});

test("⚠ THE FINAL ARM IS NOT A PANEL, so a missing branch shows as missing", () => {
  // This is the fix that outlasts the one bug. While the last arm was a real
  // panel, every future unrouted tab would silently have been that panel too.
  const lastArm = CHAIN.slice(CHAIN.lastIndexOf("{:else}"));
  assert.ok(lastArm.startsWith("{:else}"), "there is no fallback arm");
  assert.equal(/<[A-Z]\w+ /.test(lastArm), false, "the fallback still renders a real panel");
  assert.match(lastArm, /There is no panel called \{tab\} yet\./);
});

test("⚠ THE LOG IS A `panel`, or the window it opens in scrolls sideways", () => {
  // `.panel-head`'s negative inline margin bleeds to the edges of a PADDED
  // panel; a windowed one has none, so the stylesheet cancels the bleed with
  // `.win-body > .panel > .panel-head`. A section that is a panel in every way
  // except the class does not match it, and the head hangs 16px outside on each
  // side — 5px of sideways scroll, measured live (R8).
  //
  // This is the second panel in this codebase to hit it, so it is pinned rather
  // than fixed again.
  const log = readFileSync(path.join(UI_DIR, "NoticeLog.svelte"), "utf8");
  assert.match(log, /<section class="panel notice-log">/);
  const css = readFileSync(path.join(UI_DIR, "..", "styles.css"), "utf8").replace(/\r\n/g, "\n");
  assert.match(css, /\.win-body > \.panel > \.panel-head \{\n\s*margin-inline: 0;/);
});
