// SSR render checks for ONE group row in the Bot Manager.
//
// WHY THIS FILE EXISTS SEPARATELY FROM botManagerPanel.test.ts, for the same
// reason botManagerPilotRow.test.ts does: the panel's roster load is in
// `onMount`, which SSR never runs, so rendering the PANEL never reaches a row.
// The controls here start real bots on several real ships at once, which is
// exactly the kind of button that should not be reachable only through a path
// nothing renders.
//
// No test-only seam is needed: the row takes everything it renders as props,
// and the store reads it does make are plain `.get()`s on a fresh client store.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const GroupRow = (await import("./BotManagerGroupRow.svelte")).default;

// ESI's own published example CharacterID — documented, obviously synthetic.
const PILOT_A = 90000001;
const PILOT_B = 90000002;

const SCRIPTS = [
  {
    scriptID: "script-1",
    name: "Sample belt loop",
    rev: 1,
    updatedAt: "2026-09-02T12:00:00.000Z",
    authorAccountID: 424242,
    authorName: "Test Pilot One",
    categoryID: null,
  },
];

const NAMES: Record<number, string> = {
  [PILOT_A]: "Test Pilot One",
  [PILOT_B]: "Test Pilot Two",
};

function squadGroup(members: readonly number[] = [PILOT_A, PILOT_B]): unknown {
  return { id: "squad-1", name: "Mining Op", color: "#52d9a3", kind: "squad", members };
}

function renderRow(props: Record<string, unknown>): string {
  const output = render(GroupRow as never, {
    props: {
      scripts: SCRIPTS,
      sessions: [],
      serverBots: [],
      flow: new Proxy({}, { get: () => async () => ({}) }),
      nameOf: (characterID: number) => NAMES[characterID] ?? null,
      runtimeMinutes: 720,
      onChanged: () => {},
      ...props,
    },
  } as never);
  return output.body;
}

function visibleText(body: string): string {
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

test("a squad row names the group and counts its pilots", () => {
  const text = visibleText(renderRow({ group: squadGroup() }));
  assert.match(text, /Mining Op/);
  assert.match(text, /2 pilots/);
  // Nobody is flying anything and nothing here holds them, so both are free.
  assert.match(text, /2 free/);
});

test("NO RAW ID REACHES THE PAGE — members are named (R7d)", () => {
  const body = renderRow({ group: squadGroup() });
  assert.match(visibleText(body), /Test Pilot One/);
  assert.doesNotMatch(visibleText(body), new RegExp(String(PILOT_A)));
});

test("a squad row offers the saved library", () => {
  // Why the built-ins are absent is said once under the list, not per row --
  // see the panel test "the group list says once what is true of every row".
  const text = visibleText(renderRow({ group: squadGroup() }));
  assert.match(text, /Sample belt loop/);
});

test("an empty group says where to go and fill it, rather than showing dead controls", () => {
  const squad = visibleText(renderRow({ group: squadGroup([]) }));
  assert.match(squad, /Pilot Hangar/);
  assert.doesNotMatch(squad, /Choose a bot/);
});

test("a squad row has ONE start, and a Server box that decides where it flies", () => {
  // ⚠ THE TWO STARTS BECAME ONE. They differed only in what happens when the
  // tab closes, so that is a setting rather than a second button. UNTICKED by
  // default: a server run keeps flying unwatched, so it is opted into. With no
  // tab open here, the status says why Start reaches nobody.
  const body = renderRow({ group: squadGroup() });
  const text = visibleText(body);
  assert.match(body, /type="checkbox"/);
  assert.doesNotMatch(body, /type="checkbox"[^>]*checked/);
  assert.match(text, /Server/);
  assert.match(text, /Start in this tab/);
  assert.doesNotMatch(text, /Run here|Run on server/);
  assert.match(text, /No tab open here/);
});

test("a member the server is already flying is counted as flying, not as free", () => {
  const serverBots = [
    {
      botID: "bot-1",
      characterID: PILOT_A,
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
      kind: "script",
    },
  ];
  const text = visibleText(renderRow({ group: squadGroup(), serverBots }));
  assert.match(text, /1 already flying/);
  assert.match(text, /1 free/);
  // And it says WHAT is flying it -- once, in the status, not beside the name.
  assert.doesNotMatch(text, /Test Pilot One \(Sample belt loop\)/);
  assert.match(text, /1 flying - Sample belt loop/);
  // ⚠ AND THE ONE BUTTON IS NOW STOP. Something this row may stop is flying,
  // so Start gives way to it; pressing Start again would only reach the free.
  assert.match(text, /Stop Mining Op/);
  assert.doesNotMatch(text, /Start (in this tab|on the server)/);
  assert.match(text, /1 flying/);
});

test("a plugin's server run is stopped from the group row like any other", () => {
  const serverBots = [
    {
      botID: "bot-p",
      characterID: PILOT_A,
      characterName: "Test Pilot One",
      scriptID: "",
      scriptName: "Sample loop",
      scriptRev: 0,
      scriptHash: "",
      restartSafe: true,
      riskClasses: [],
      maxRuntimeMinutes: 720,
      expiresAt: null,
      status: "running",
      phase: null,
      why: null,
      stepPath: null,
      pauseReason: null,
      note: null,
      startedAt: "2026-09-02T12:00:00.000Z",
      endedAt: null,
      resumedAt: null,
      lastAlert: null,
      kind: "plugin",
    },
  ];
  const text = visibleText(renderRow({ group: squadGroup(), serverBots }));
  assert.match(text, /Stop Mining Op/);
  assert.match(text, /1 flying - Sample loop/);
});

test("a row with a held session still renders — the store reads are plain gets", () => {
  // The row reads other pilots' stores directly rather than through `$store`
  // sugar; a fresh store must not throw on the server.
  const session = {
    id: "session-under-test",
    store: createClientStore(),
    flow: new Proxy({}, { get: () => async () => ({}) }),
  };
  const text = visibleText(renderRow({ group: squadGroup(), sessions: [session] }));
  assert.match(text, /Mining Op/);
});
