// SSR render checks for ONE pilot row in the Bot Manager.
//
// WHY THIS FILE EXISTS SEPARATELY FROM botManagerPanel.test.ts. The panel loads
// its roster in `onMount`, which the SSR harness never runs — so rendering the
// PANEL never reaches a single row, and the Start controls (which start real
// bots on real ships) would otherwise have no coverage at all. Rendering the row
// directly is the only way to see them, and it needs no test-only seam: the row
// takes everything it renders as props, and its store subscriptions live in an
// `$effect` that SSR skips, so the run-state fallbacks put a fresh row in
// exactly the "nothing running" state the Start controls key off.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const PilotRow = (await import("./BotManagerPilotRow.svelte")).default;

// ESI's own published example CharacterID — documented, obviously synthetic.
const PILOT_ID = 90000001;

function fakeSession(): unknown {
  return {
    id: "session-under-test",
    store: createClientStore(),
    flow: new Proxy({}, { get: () => async () => ({}) }),
  };
}

function fakeServerBot(over: Record<string, unknown> = {}): unknown {
  return {
    botID: "bot-under-test",
    characterID: PILOT_ID,
    characterName: "Test Pilot One",
    scriptID: "script-1",
    scriptName: "Sample belt loop",
    scriptRev: 1,
    scriptHash: "hash",
    restartSafe: true,
    riskClasses: [],
    maxRuntimeMinutes: 720,
    expiresAt: null,
    status: "running",
    phase: "Mining",
    why: null,
    stepPath: null,
    pauseReason: null,
    note: null,
    startedAt: "2026-09-02T12:00:00.000Z",
    endedAt: null,
    resumedAt: null,
    lastAlert: null,
    vitals: null,
    ...over,
  };
}

const SCRIPTS = [
  { scriptID: "script-1", name: "Sample belt loop", rev: 1, updatedAt: "2026-09-02T12:00:00.000Z", authorAccountID: 424242, authorName: "Test Pilot One", categoryID: null },
  { scriptID: "script-2", name: "Second sample bot", rev: 3, updatedAt: "2026-09-02T12:00:00.000Z", authorAccountID: 424242, authorName: null, categoryID: null },
];

function renderRow(props: Record<string, unknown>): string {
  const output = render(PilotRow as never, {
    props: { serverBot: null, scripts: SCRIPTS, onChanged: () => {}, ...props },
  } as never);
  return output.body;
}

function visibleText(body: string): string {
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("a held pilot with nothing running offers the Start controls", () => {
  const html = renderRow({ session: fakeSession() });
  const text = visibleText(html);
  assert.match(text, /Run here/);
  assert.match(text, /Run on server/);
  assert.match(text, /Choose a bot/);
});

test("the bot picker lists the library rows it was handed, and fetches nothing itself", () => {
  const text = visibleText(renderRow({ session: fakeSession() }));
  assert.match(text, /Sample belt loop/);
  assert.match(text, /Second sample bot/);
});

test("the server run limit offers the same choices as the Bots launcher", () => {
  const text = visibleText(renderRow({ session: fakeSession() }));
  for (const label of ["1 hour", "4 hours", "12 hours", "24 hours", "48 hours", "72 hours"]) {
    assert.match(text, new RegExp(label));
  }
});

test("a pilot already flying a server bot gets Stop, never Start", () => {
  const text = visibleText(renderRow({ session: fakeSession(), serverBot: fakeServerBot() }));
  assert.match(text, /Stop/);
  assert.doesNotMatch(text, /Run here/);
  assert.doesNotMatch(text, /Choose a bot/);
});

test("a server bot is labelled as flying on the server, and says it outlives the tab", () => {
  const text = visibleText(renderRow({ session: fakeSession(), serverBot: fakeServerBot() }));
  assert.match(text, /On the server/i);
  assert.match(text, /Keeps flying/i);
});

test("a character with no tab open here cannot be started, and says why", () => {
  // No session at all: nothing in this browser tab is holding that pilot, so a
  // Start control would be a button that cannot work.
  const text = visibleText(renderRow({ session: undefined, serverBot: null }));
  assert.doesNotMatch(text, /Run here/);
  assert.match(text, /No tab is open here/i);
});

// --- the built-in bots, now that Bots has no rail entry ---------------------

test("the picker offers the built-in bots as well as the saved ones", () => {
  // The Bots panel is `launchable: false` now, so this picker is where a player
  // discovers that mining and mission bots exist at all.
  const text = visibleText(renderRow({ session: fakeSession() }));
  assert.match(text, /Mining bot/);
  assert.match(text, /Mission bot/);
  assert.match(text, /Sample belt loop/);
});

test("the two kinds are named as separate groups, not run together in one list", () => {
  // They start differently, so offering them as one flat list would change the
  // buttons underneath with nothing on screen explaining why.
  const html = renderRow({ session: fakeSession() });
  assert.match(html, /<optgroup label="Built in"/);
  assert.match(html, /<optgroup label="Saved"/);
});

test("the built-ins are offered even when nothing has been saved yet", () => {
  // The Saved group disappears with an empty library; the built-ins must not,
  // or a fresh install has a picker with nothing in it.
  const html = renderRow({ session: fakeSession(), scripts: [] });
  assert.match(visibleText(html), /Mining bot/);
  assert.doesNotMatch(html, /<optgroup label="Saved"/);
});

test("a row with no session held here offers no built-in setup either", () => {
  // Nothing in this tab is holding that pilot, so there is no ship to check a
  // built-in's requirements against and nowhere to go.
  const text = visibleText(renderRow({ session: undefined, serverBot: null }));
  assert.doesNotMatch(text, /Set up/);
  assert.match(text, /No tab is open here/i);
});

// --- what the row absorbed from the Server Bots panel ----------------------
//
// These three facts had exactly one home before — the standalone Server Bots
// panel — and its rail entry is gone. If the row stops printing them they are
// not merely harder to find, they are unreachable while a pilot is online, so
// each gets its own test rather than riding along in a broader render check.

test("a live server bot's alert reaches the row — it is the only notification one ever gives", () => {
  const text = visibleText(
    renderRow({
      serverBot: fakeServerBot({
        lastAlert: { message: "Shields dropped below the level you set.", atMs: Date.now() },
      }),
    }),
  );
  assert.match(text, /Shields dropped below the level you set/);
  // Relative age, not a clock time: the row cannot know the reader's timezone.
  assert.match(text, /just now|minute|hour/i);
});

test("an alert is not swallowed by the status detail line", () => {
  // `detail` is pauseReason/phase/why. A bot with all three set AND an alert
  // must still show the alert — the bug this guards is the alert being dropped
  // because the row already had a line to print.
  const text = visibleText(
    renderRow({
      serverBot: fakeServerBot({
        phase: "Hauling",
        why: "The ore hold filled up.",
        pauseReason: "Waiting for the hold to empty.",
        lastAlert: { message: "A neutral pilot entered the belt.", atMs: Date.now() },
      }),
    }),
  );
  assert.match(text, /A neutral pilot entered the belt/);
});

test("a live server bot states its revision, its permissions and its time limit", () => {
  const text = visibleText(
    renderRow({ serverBot: fakeServerBot({ scriptRev: 4, riskClasses: ["combat"], maxRuntimeMinutes: 720 }) }),
  );
  assert.match(text, /Revision 4/);
  assert.match(text, /weapons, drones, or combat modules/i);
  assert.match(text, /limit 12 hr/);
});

test("a bot granted nothing consequential says so, rather than showing a blank", () => {
  const text = visibleText(renderRow({ serverBot: fakeServerBot({ riskClasses: [] }) }));
  assert.match(text, /No consequential permissions/i);
});

test("a bot the server picked back up after a restart says so while it is still flying", () => {
  const text = visibleText(
    renderRow({ serverBot: fakeServerBot({ resumedAt: "2026-09-02T13:00:00.000Z" }) }),
  );
  assert.match(text, /Restarted with the server/i);
});

test("an ENDED server bot gets none of those live lines — that is the recent-runs strip's job", () => {
  // `serverBotFor` already keeps ended bots off a held pilot's row; this pins
  // the row's own half of that rule so the two cannot disagree.
  const text = visibleText(
    renderRow({
      serverBot: fakeServerBot({
        status: "stopped",
        endedAt: "2026-09-02T14:00:00.000Z",
        resumedAt: "2026-09-02T13:00:00.000Z",
        lastAlert: { message: "A neutral pilot entered the belt.", atMs: Date.now() },
      }),
    }),
  );
  assert.doesNotMatch(text, /Revision/);
  assert.doesNotMatch(text, /Restarted with the server/i);
  assert.doesNotMatch(text, /A neutral pilot entered the belt/);
});

test("no raw numeric id reaches the row (R7d)", () => {
  const text = visibleText(renderRow({ session: fakeSession(), serverBot: fakeServerBot() }));
  assert.doesNotMatch(text, /\b\d{4,}\b/);
});

test("the R7d sweep would actually catch a leaked id", () => {
  // Keeps the assertion above from passing vacuously.
  assert.match(visibleText(`<td>${PILOT_ID}</td>`), /\b\d{4,}\b/);
});


test("a plain script row grows no fleet readout", () => {
  const text = visibleText(renderRow({ serverBot: fakeServerBot() }));
  assert.doesNotMatch(text, /In fleet:/);
  assert.doesNotMatch(text, /can tag:/);
  // The fleet readout lives in a plugin's window now; this row must not grow
  // a copy of it.
  assert.doesNotMatch(text, /Last order/);
});
