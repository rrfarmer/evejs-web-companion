// The readout line whose ABSENCE was the whole twelve-hour problem.
//
// A bot answered 227 consecutive NotEnoughCargoSpace refusals overnight while
// this panel showed nothing but its cheerful phase and "Why". The refusals
// existed only in the BFF's log. A store field nobody paints is not visible, so
// this pins the paint rather than the plumbing.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function runningBot(refusals: readonly unknown[]) {
  const store = createClientStore();
  store.apply({ type: "custom-bot/started", name: "Haul the belt" });
  store.apply({
    type: "custom-bot/progress",
    status: "running",
    phase: "Looting",
    why: "Taking what's inside.",
    stepPath: "loot",
    interruptID: null,
    pauseReason: null,
    refusals: refusals as never,
  });
  return store;
}

const NO_ROOM = {
  key: "loot:lootContainer:80001",
  count: 7,
  firstAt: Date.now(),
  lastAt: Date.now(),
  words: "There isn't enough room in that hold.",
  kind: "refused" as const,
};

test("many targets refused in the same words are one line, in a box of its own that scrolls", async () => {
  const store = runningBot([NO_ROOM, { ...NO_ROOM, key: "loot:lootContainer:80002", count: 2 }]);
  const Readout = (await import("./CustomBotReadout.svelte")).default;
  const body = render(Readout as never, { props: { store, flow: fakeFlow() } } as never).body;
  assert.equal(body.match(/enough room in that hold/g)?.length, 1);
  assert.match(body, /\(9 times\)/);
  assert.match(body, /class="refusals/);
});

test("a refusal long past has gone from a running bot's readout, and one refused once says so", async () => {
  const store = runningBot([
    { ...NO_ROOM, lastAt: Date.now() - 10 * 60_000 },
    { ...NO_ROOM, key: "loot:lootContainer:80002", count: 1, words: "That container is no longer there." },
  ]);
  const Readout = (await import("./CustomBotReadout.svelte")).default;
  const body = render(Readout as never, { props: { store, flow: fakeFlow() } } as never).body;
  assert.equal(/enough room in that hold/.test(body), false);
  assert.match(body, /no longer there/);
  assert.match(body, /\(1 time\)/);
});

test("a refused run SHOWS what is being refused, and how often", async () => {
  const store = runningBot([NO_ROOM]);
  const Readout = (await import("./CustomBotReadout.svelte")).default;
  const body = render(Readout as never, { props: { store, flow: fakeFlow() } } as never).body;

  assert.match(body, /enough room in that hold/, "the server's own words reach the screen");
  assert.match(body, /\(7 times\)/, "and the tally, so a streak is visible as a streak");
  // The cheerful line the bot was showing INSTEAD of this, for twelve hours.
  assert.match(body, /Taking what's inside/, "the phase still shows — the warning is added, not swapped");
});

test("a refusal is worded, never coded", async () => {
  const store = runningBot([NO_ROOM]);
  const Readout = (await import("./CustomBotReadout.svelte")).default;
  const body = render(Readout as never, { props: { store, flow: fakeFlow() } } as never).body;
  assert.equal(/NotEnoughCargoSpace/.test(body), false, "R31: no codes on screen");
});

test("a healthy run paints no refusal line at all", async () => {
  const store = runningBot([]);
  const Readout = (await import("./CustomBotReadout.svelte")).default;
  const body = render(Readout as never, { props: { store, flow: fakeFlow() } } as never).body;
  assert.equal(/times\)/.test(body), false, "nothing to warn about, so nothing shown");
});

test("several things being refused at once are all listed", async () => {
  const store = runningBot([
    NO_ROOM,
    { ...NO_ROOM, key: "loot:lootContainer:80002", count: 2, words: "That container is no longer there." },
  ]);
  const Readout = (await import("./CustomBotReadout.svelte")).default;
  const body = render(Readout as never, { props: { store, flow: fakeFlow() } } as never).body;
  assert.match(body, /enough room in that hold/);
  assert.match(body, /no longer there/);
});
