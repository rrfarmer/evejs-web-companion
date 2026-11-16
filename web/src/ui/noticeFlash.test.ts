// WHERE THE FLASH APPEARS, AND THAT SOMETHING IS FEEDING IT.
//
// The board and the bridge are covered by their own suites. What is left is the
// pair of facts that only the workspace and the stylesheet can state: the flash
// is CENTRED (it used to be a corner toast), and the bridge that fills it is
// mounted — once — in both arms of the workspace.
//
// ⚠ THE MOUNT CLAIM IS THE LOAD-BEARING ONE. The failure this whole feature
// fixes is a notice system with nothing plugged into it, and that is precisely
// the failure that no unit test of either half can see. Both halves passed
// while the feature did not exist.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * ⚠ READ WITH LINE ENDINGS NORMALISED. The working copy is CRLF, so a slice
 * taken between two `indexOf` calls that spell a newline as `\n` finds nothing,
 * comes back as the whole rest of the file, and then matches almost anything
 * asked of it. A test that passes because its haystack quietly became the
 * entire stylesheet is worse than no test.
 */
function read(...parts: string[]): string {
  return readFileSync(path.join(UI_DIR, ...parts), "utf8").replace(/\r\n/g, "\n");
}

const WORKSPACE = read("Workspace.svelte");
const FLASH = read("Toasts.svelte");
const CSS = read("..", "styles.css");

/**
 * One CSS rule's body, by its selector — so a failure prints the rule rather
 * than the entire design system.
 */
function rule(selector: string): string {
  const at = CSS.indexOf(`\n  ${selector} {`);
  assert.notEqual(at, -1, `there is no ${selector} rule`);
  return CSS.slice(at, CSS.indexOf("\n  }", at));
}

const STACK_RULE = rule(".toasts");
const FLASH_RULE = rule(".toast");

// --- centred, which is the ask ----------------------------------------------

test("⚠ THE FLASH IS CENTRED ON SCREEN, NOT PINNED TO A CORNER", () => {
  assert.match(STACK_RULE, /align-items: center;/, "the column is not centred");
  assert.match(STACK_RULE, /left: 0;/);
  assert.match(STACK_RULE, /right: 0;/);
  // The old shape: a fixed-width column jammed against the right edge.
  assert.equal(/right: 0\.7rem;/.test(STACK_RULE), false, "the stack is still in the corner");
  assert.equal(/width: min\(22rem/.test(STACK_RULE), false, "the container still sizes itself");
});

test("it sits ABOVE the middle, and never under the character bar", () => {
  // Dead centre is where the ship is and where a pilot clicks; the top of the
  // viewport is where the character bar already is. `max()` of the two is the
  // only expression that is right on a tall screen AND on a short one.
  assert.match(STACK_RULE, /top: max\(calc\(var\(--char-bar-h\) \+ 0\.6rem\), 16vh\);/);
});

test("⚠ IT STILL NEVER EATS A CLICK — which matters more now that it is centred", () => {
  // A corner overlay that swallowed a click was rude. One across the middle of
  // the screen, over the ship and the overview, would be a misfire.
  assert.match(STACK_RULE, /pointer-events: none;/);
  assert.match(FLASH_RULE, /pointer-events: auto;/);
});

test("a flash is capped in width, so a long refusal does not span the screen", () => {
  assert.match(FLASH_RULE, /width: min\(26rem, 100%\);/);
});

// --- and something is feeding it --------------------------------------------

test("⚠ BOTH ARMS OF THE WORKSPACE MOUNT THE BRIDGE, or notices never arrive", () => {
  // The mobile arm is a separate branch and it is the one that gets forgotten:
  // it is the arm where a player has the FEWEST panels open, which is exactly
  // when a notice raised outside the open one is the only way to hear about it.
  assert.match(WORKSPACE, /import NoticeBridge from "\.\/NoticeBridge\.svelte";/);
  const mounts = WORKSPACE.match(/<NoticeBridge\b[^>]*\/>/g) ?? [];
  assert.equal(mounts.length, 2, "the bridge is not mounted in exactly both arms");
  for (const mount of mounts) {
    assert.match(mount, /\{store\}/);
    assert.match(mount, /\{flow\}/);
  }
  const flashes = WORKSPACE.match(/<Toasts \/>/g) ?? [];
  assert.equal(flashes.length, 2, "the flash is not mounted in exactly both arms");
});

test("⚠ ONE BRIDGE PER ARM, NOT TWO — a second would double every notice", () => {
  // Only one arm renders at a time, so two mounts total is one live bridge. Two
  // in the SAME arm would post everything twice, past the dedupe window and
  // into the permanent log.
  const from = WORKSPACE.indexOf("{:else if isMobile}");
  const to = WORKSPACE.indexOf("{:else}", from);
  assert.ok(from !== -1 && to > from, "the mobile arm is not where this test looks");
  const mobileArm = WORKSPACE.slice(from, to);
  assert.equal((mobileArm.match(/<NoticeBridge/g) ?? []).length, 1);
  assert.equal((mobileArm.match(/<Toasts/g) ?? []).length, 1);
});

test("the bridge tears itself down with the workspace it is mounted in", () => {
  // Every pilot's store stays live in memory while you fly another. A bridge
  // that outlived its workspace would flash a pilot you had left.
  const bridge = read("NoticeBridge.svelte");
  assert.match(bridge, /\$effect\(\(\) => watchNotices\(store\)\);/);
});

// --- the flash is still readable without colour ------------------------------

test("severity is a WORD on every flash, not a colour", () => {
  assert.match(FLASH, /class="toast-kind">\{notice\.kind === "danger" \? "Alert"/);
  assert.match(FLASH, /aria-live="polite"/);
});
