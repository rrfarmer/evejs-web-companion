// R107 — the character bar's server-connection indicator. Rendered with Svelte's
// server generator (no DOM), like characterChip.test.ts. Empty roster so no chip
// mounts; we only assert the status indicator reflects the passed serverStatus.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const CharacterBar = (await import("./CharacterBar.svelte")).default;

function renderBar(serverStatus: "checking" | "online" | "offline"): string {
  return render(CharacterBar as never, {
    props: { sessions: [], activeId: null, serverStatus, onSwitch: () => {}, onAdd: () => {} },
  } as never).body;
}

test("the bar shows a Connected status when the server is online", () => {
  const body = renderBar("online");
  assert.match(body, /char-bar-status-online/);
  assert.match(body, /Connected/);
});

test("the bar shows Server offline when the health poll fails", () => {
  const body = renderBar("offline");
  assert.match(body, /char-bar-status-offline/);
  assert.match(body, /Server offline/);
});

test("the bar shows Connecting… while the first health ping is in flight", () => {
  const body = renderBar("checking");
  assert.match(body, /char-bar-status-checking/);
  assert.match(body, /Connecting/);
});

// ─── the global-window doors ─────────────────────────────────────────────────
//
// ⚠ THESE BUTTONS ARE THE ONLY WAY INTO WHOLE WINDOWS. The Bot Manager, PI and
// other global windows are global and deliberately NOT in the Neocom rail (they are
// about every pilot, and the rail belongs to one), so if the strip ever stops
// rendering the panels become unreachable rather than merely harder to find.

function renderLauncherBar(props: Record<string, unknown>): string {
  return render(CharacterBar as never, {
    props: {
      sessions: [],
      activeId: null,
      serverStatus: "online",
      onSwitch: () => {},
      onAdd: () => {},
      onOpenGlobal: () => {},
      ...props,
    },
  } as never).body;
}

test("the bar carries a door onto each global window", () => {
  const body = renderLauncherBar({});
  assert.match(body, /data-launch="botManager"/);
  assert.match(body, /data-launch="plugins"/);
  assert.match(body, /data-launch="industryManager"/);
  assert.doesNotMatch(body, /data-launch="companion"/, "the fleet companions window is a plugin's, with its own door");
});

test("the button says whether its window is already open", () => {
  // The bar doubles as the answer to "is that thing on screen somewhere?" — a
  // window that is merely put away still counts as open.
  const open = renderLauncherBar({ globalOpenIds: new Set(["industryManager"]) });
  assert.match(open, /aria-pressed="true"[^>]*data-launch="industryManager"|data-launch="industryManager"[^>]*aria-pressed="true"/);
  assert.match(open, /data-launch="botManager"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-launch="botManager"/);
  assert.doesNotMatch(renderLauncherBar({}), /aria-pressed="true"/);
});

test("a bar mounted without the door renders without one, rather than throwing", () => {
  // Harnesses and older mounts pass no `onOpenGlobal`; a bar that crashed on
  // that would take the whole top of the tab down with it.
  const body = render(CharacterBar as never, {
    props: {
      sessions: [],
      activeId: null,
      serverStatus: "online",
      onSwitch: () => {},
      onAdd: () => {},
    },
  } as never).body;
  assert.doesNotMatch(body, /global-launch/);
});
