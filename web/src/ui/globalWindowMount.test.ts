// THE GLOBAL WINDOW IS MOUNTED ABOVE THE PILOT-SWITCH REMOUNT — a source sweep.
//
// ⚠ WHY THIS IS A TEXT SWEEP AND NOT A RENDER TEST. The whole feature is a
// question about WHERE a component is mounted, and the failure is silent. App
// renders the active pilot's Workspace inside `{#key active.id}`, which
// destroys and rebuilds everything under it on every character switch. The Bot
// Manager works perfectly well from inside there — it just quietly loses its
// roster, its search box and its poll every time you switch, which is the exact
// behaviour the hoist removed and the exact behaviour nothing else would fail
// on. Moving the layer a few lines down, into the key, would pass every other
// test in this repo.
//
// A render test cannot see it either: `svelte/server` runs no effects and never
// switches a pilot, so both placements render identically. The placement itself
// is the thing to assert, so this reads the source and checks it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APP = readFileSync(fileURLToPath(new URL("./App.svelte", import.meta.url)), "utf8");
const WORKSPACE = readFileSync(fileURLToPath(new URL("./Workspace.svelte", import.meta.url)), "utf8");

/** Blank out HTML comments, so the sweep reads MARKUP and not prose about it. */
function withoutComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, "");
}

const MARKUP = withoutComments(APP);

test("the sweep is actually reading App's markup", () => {
  // A path or stripping bug would make every assertion below vacuous.
  assert.match(MARKUP, /<Workspace/);
  assert.match(MARKUP, /\{#key active\.id\}/);
  assert.match(MARKUP, /global-layer/);
});

test("the global window layer sits OUTSIDE the {#key active.id} that remounts on a pilot switch", () => {
  const keyStart = MARKUP.indexOf("{#key active.id}");
  const keyEnd = MARKUP.indexOf("{/key}", keyStart);
  const layer = MARKUP.indexOf("global-layer");
  assert.ok(keyStart >= 0 && keyEnd > keyStart, "the pilot-switch key block moved or was renamed");
  assert.ok(layer >= 0, "the global window layer is gone");
  assert.ok(
    layer > keyEnd,
    "the global window layer is inside {#key active.id} — it will be torn down on every character switch, " +
      "which is the one thing it exists not to do",
  );
});

test("the Workspace is still inside that key — the hoist is for one window, not a general escape", () => {
  // Every other panel is a view of ONE pilot's store, so being remounted with
  // that pilot is correctness, not a limitation. If this ever fails, a stale
  // pilot's panels can outlive the switch away from them.
  const keyStart = MARKUP.indexOf("{#key active.id}");
  const keyEnd = MARKUP.indexOf("{/key}", keyStart);
  const workspace = MARKUP.indexOf("<Workspace");
  assert.ok(workspace > keyStart && workspace < keyEnd, "<Workspace> must stay inside the key");
});

test("the layer is given NO pilot's store or flow, only the held sessions", () => {
  // It opens from the Pilot Hangar with nobody in the client, so it cannot
  // need an active pilot; and over a cockpit, a window about every pilot that
  // borrowed the active one's token would speak for one account only. Each
  // panel reaches pilots through their own sessions or accounts
  // (app/pilotReach.ts).
  const layer = MARKUP.slice(MARKUP.indexOf("global-layer"));
  assert.match(layer, /<GlobalPanel/);
  assert.doesNotMatch(layer, /active\.store/);
  assert.doesNotMatch(layer, /active\.flow/);
});

test("the layer is not inside {#if active}, and is drawn after the hangar", () => {
  // Nobody in the client is exactly when the hangar shows, and the windows
  // must open there; drawn before the hangar they would sit under it.
  const body = MARKUP.slice(MARKUP.indexOf("</script>"));
  const activeStart = body.indexOf("{#if active}");
  const activeEnd = body.indexOf("{:else if restoring}");
  const layer = body.indexOf("global-layer");
  const hangar = body.indexOf("<PilotHangar");
  assert.ok(activeStart >= 0 && activeEnd > activeStart, "the active-pilot block moved or was renamed");
  assert.ok(layer > activeEnd, "the global layer is inside {#if active} - it cannot open from the hangar");
  assert.ok(layer > hangar, "the global layer is drawn before the hangar, so the hangar covers it");
});

// ─── the open-request counter ────────────────────────────────────────────────

test("an open request is ADDRESSED to a pilot, not merely timed", () => {
  // ⚠ TWO BUGS, OPPOSITE DIRECTIONS, BOTH FOUND BY CLICKING. App's request lives
  // above the `{#key active.id}` that remounts a workspace per pilot, so a bare
  // counter cannot tell "asked for before I existed" from "asked for AS I was
  // being created" — and both happen here:
  //
  //  • Serving any unseen number replayed old requests: opening the Bot Builder
  //    and then switching pilots opened it again on the pilot switched TO, and
  //    on every pilot after that, each saving it into their own layout.
  //  • Seeding the mark from the counter at mount fixed that and broke the
  //    other: "Set up this built-in on that pilot" switches pilots and asks for
  //    the panel in ONE tick, so the new workspace saw a counter that already
  //    included its own request and ignored it. The pilot switched, no panel.
  //
  // Neither is a timing problem, so neither has a timing fix. The request names
  // the pilot; the matching workspace serves it and says so; App drops it.
  const effect = WORKSPACE.slice(WORKSPACE.indexOf("servedOpenRequest"));
  assert.match(
    effect,
    /request\.sessionID !== sessionID/,
    "a workspace must ignore a request addressed to a different pilot",
  );
  assert.match(
    effect,
    /onOpenRequestServed\?\.\(\)/,
    "a served request must be reported, so App can drop it before a remount finds it",
  );
  assert.match(APP, /onOpenRequestServed=\{\(\) => \(openRequest = null\)\}/);
  assert.match(APP, /sessionID=\{active\.id\}/);
});

test("a request for a pilot who is not active switches to them first", () => {
  // The panels reached this way read the MOUNTED pilot's store. Opening one for
  // a pilot who is not on screen would show the wrong ship under the right name.
  const opener = APP.slice(APP.indexOf("const requestOpenInWorkspace"));
  const switchAt = opener.indexOf("switchTo(target)");
  const setAt = opener.indexOf("openRequest = {");
  assert.ok(switchAt >= 0, "the opener no longer switches pilots");
  assert.ok(setAt > switchAt, "the pilot must be switched before the request is made");
});
test("the request is passed down as a prop, not pulled from a shared singleton", () => {
  // Data flows down. A registered callback or module-level store would let a
  // workspace be driven by something it cannot see in its own props, which is
  // what makes the staleness above hard to reason about in the first place.
  assert.match(withoutComments(WORKSPACE), /openRequest,/);
  assert.match(MARKUP, /\{openRequest\}/);
});

// ─── the layer holds MORE THAN ONE window ────────────────────────────────────

test("the layer draws every global window, not just the front one", () => {
  // ⚠ THE REGRESSION THIS GUARDS. The layer held exactly one window while the
  // Bot Manager was alone on it. A second window joined it, and a layer that
  // still drew one would make the two evict each other — open the Industry
  // Manager and the Manager you were reading vanishes, with nothing on screen
  // saying why. A `{#each}` over the list is what makes both fit.
  const layer = MARKUP.slice(MARKUP.indexOf("global-layer"));
  assert.match(layer, /\{#each shownGlobalWins as win \(win\.id\)\}/);
  assert.match(layer, /<DesktopWindow/);
});

test("⚠ a put-away global window keeps a chip, in the ONE strip a player already reads", () => {
  // ⚠ THE BUG THIS REPLACES A TEST FOR. This layer used to render a strip of
  // its own, bottom-right, opposite the desktop's own strip — so putting a
  // window away sent its handle to one of two corners depending on which window
  // it was, with nothing on screen explaining the difference. One gesture must
  // not have two answers, so the chips go down to the desktop's strip and this
  // layer has no strip at all.
  //
  // A hide with no visible handle is still a window the player has lost, so
  // what must hold is not "no strip here" but "listed SOMEWHERE": App hands the
  // whole list down, Workspace forwards it, and Desktop renders it.
  const layer = MARKUP.slice(MARKUP.indexOf("global-layer"));
  assert.doesNotMatch(layer, /win-strip/, "the second strip is back");
  assert.match(MARKUP, /<Workspace[\s\S]*?\{globalWins\}/);
  assert.match(MARKUP, /onToggleGlobalMinimize=\{\(id\) =>/);

  const workspace = withoutComments(WORKSPACE);
  assert.match(workspace, /globalWins,/, "Workspace must take the list");
  assert.match(workspace, /<Desktop[\s\S]*?\{globalWins\}/, "and hand it to the desktop");

  const desktop = withoutComments(
    readFileSync(fileURLToPath(new URL("./Desktop.svelte", import.meta.url)), "utf8"),
  );
  const strip = desktop.slice(desktop.indexOf('class="win-strip"'));
  assert.match(strip, /\{#each globalChips as win \(win\.id\)\}/, "the chips must be drawn");
  assert.match(strip, /onToggleGlobalMinimize\?\.\(win\.id\)/, "and act on the layer that owns them");
});

test("the desktop draws the global windows' CHIPS and never the windows", () => {
  // They belong to App's layer, above the pilot-switch remount. A desktop that
  // drew one would put a character-scoped second copy on screen and tear it
  // down on every switch — the whole thing the hoist removed.
  const desktop = withoutComments(
    readFileSync(fileURLToPath(new URL("./Desktop.svelte", import.meta.url)), "utf8"),
  );
  // The SURFACE is the markup above the strip's own `{#if}` — the script block
  // names the props and the guard counts the chips, and neither is drawing a
  // window. What must be clean is the part that mounts `<DesktopWindow>`.
  const body = desktop.slice(desktop.indexOf("</script>"));
  const surface = body.slice(0, body.indexOf("{#if openHere"));
  assert.doesNotMatch(surface, /globalChips|globalWins/, "a global window drawn on a pilot's desktop");
});

test("focus is a real question now that two windows can overlap", () => {
  // With one window it could be hard-coded true. With two, a hard-coded focus
  // ring is a lie about which one a keypress reaches.
  const layer = MARKUP.slice(MARKUP.indexOf("global-layer"));
  assert.match(layer, /focused=\{win\.id === globalFocusedId\}/);
  assert.doesNotMatch(layer, /focused=\{true\}/);
});

// ─── the global windows' door ─────────────────────────────────────────────────────

test("the character bar opens the global windows, and sits outside the pilot-switch key", () => {
  // The bar is the only chrome that survives a switch, which is why the door to
  // a window about EVERY pilot hangs there — a door inside the key would be
  // rebuilt with the pilot it is not about.
  // ⚠ MEASURED IN THE MARKUP, NOT THE WHOLE FILE. `{#key active.id}` is also
  // written in a code comment up in the script block, and an index taken over
  // the file would compare a position against that sentence rather than against
  // the real block.
  const body = MARKUP.slice(MARKUP.indexOf("</script>"));
  const keyStart = body.indexOf("{#key active.id}");
  const barAt = body.indexOf("<CharacterBar");
  assert.ok(keyStart > 0, "the pilot-switch key block moved or was renamed");
  assert.ok(barAt >= 0 && barAt < keyStart, "the character bar must stay above the key");
  const bar = body.slice(barAt, body.indexOf("/>", barAt));
  assert.match(bar, /onOpenGlobal=\{openGlobalTab\}/);
  assert.match(bar, /\{globalOpenIds\}/);
});

test("on a phone a global tab opens as a PANEL, because the layer is not mounted there", () => {
  // MobileWorkspace is one panel at a time with nowhere to float. Opening onto
  // the layer there would light the door's "open" state on a window nothing
  // draws — a click that appears to do nothing at all.
  const opener = APP.slice(APP.indexOf("const openGlobalTab"));
  // ⚠ UNLESS NOBODY IS IN THE CLIENT: then there is no workspace to show a
  // panel in, and the layer is mounted on a phone too, over the hangar.
  const mobileAt = opener.indexOf("if (isMobile && active)");
  const openAt = opener.indexOf("openGlobal(globalWins, id)");
  assert.ok(mobileAt >= 0, "the phone case is gone");
  assert.ok(openAt > mobileAt, "the phone must be answered before the layer is touched");
  assert.match(MARKUP, /\{#if globalWins\.length > 0 && \(!isMobile \|\| !active\)\}/);
});
