// R28 as it actually RENDERS: the character sheet, the queue, and the clock.
//
// Screenshots have been unavailable to every worker on this repo, so the only
// honest way to say "this is on screen" is to render the component and read the
// output. That is what this file does.
//
// Three claims are load-bearing and each is checked against real markup:
//
//   1. THE ICONS ACTUALLY APPEAR. R27 cached 466 skill icons — 100% of the
//      skill types — and this is the only panel in the app where the cache is
//      near-complete. A skill therefore renders an <img> pointing at the local
//      cache, not the lettered fallback tile.
//
//   2. A LEVEL IS NEVER A BARE DIGIT. Levels render as Roman numerals and as
//      five pips, and the pips distinguish OWNED from QUEUED — showing a
//      planned level as owned would tell a player they can fly something they
//      cannot.
//
//   3. TIME AND SP ON SCREEN COME FROM THE SERVER. The countdown is derived
//      from the entry's own end instant against the server's clock, and the
//      panel never renders a number the sheet did not carry.
//
// The standing invariants are re-proven on the new markup: R7d (no visible
// numeric IDs — a skill is its name, never a typeID), R9a (plain language),
// R8 (real, touch-sized controls).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const Skills = (await import("./Skills.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "Skills.svelte"), "utf8");

const GUNNERY = 3300;
const SURGICAL = 3315;
const INDUSTRY = 3380;

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

/**
 * Everything a player can see, with markup and comments stripped and runs of
 * whitespace collapsed — a template's line breaks are not something a reader
 * of the page can perceive, so the assertions must not depend on them.
 */
function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

const NOW = 1_784_617_000_000;
const HOUR = 3_600_000;

// ⚠ THE BROWSER CLOCK IS FROZEN, NOT SAMPLED — the same fix planetsPanel.test.ts
// carries, for the same defect. The panel's reference "now" is
// `Date.now() + clockOffsetMs`, sampled during render, a tick AFTER the scene
// pinned the offset. Deriving the offset from the real clock therefore left the
// countdown a millisecond or two short, and because the readouts FLOOR, a
// boundary-exact "30m 0s" rendered as "29m 59s" whenever the two samples fell in
// different milliseconds. One run in twenty went red on that. Pinning Date.now()
// removes the sampling rather than padding the fixture.
//
// Frozen five hours BEHIND the server on purpose: `clockOffsetMs` has to carry
// those five hours for the time words to come out right at all, so a panel
// ticking off the raw browser clock cannot pass by accident.
const BROWSER_NOW = NOW - 5 * HOUR;
const CLOCK_OFFSET = NOW - BROWSER_NOW;

/** Runs `body` with Date.now() pinned to the (deliberately wrong) browser clock. */
function atFrozenBrowserClock<T>(body: () => T): T {
  const realNow = Date.now;
  Date.now = () => BROWSER_NOW;
  try {
    return body();
  } finally {
    Date.now = realNow;
  }
}

interface SceneOptions {
  readonly queueEntries?: {
    typeID: number;
    toLevel: number;
    startSP: number;
    destinationSP: number;
    offsetHours: number;
    lengthHours: number;
    rate: number;
  }[];
  readonly queue?: null;
  readonly loaded?: boolean;
  /** A queue the server has stopped: its skills still on it, none with a start or an end. */
  readonly paused?: boolean;
}

/** The sheet the panel reads, with every instant expressed against NOW. */
function sceneStore(options: SceneOptions) {
  const store = createClientStore();
  const entries = options.queueEntries ?? [];
  if (options.loaded !== false) {
    store.apply({
      type: "skills/loaded",
      characterName: "Farmer",
      totalSkillPoints: 384402,
      freeSkillPoints: 0,
      skills: [
        {
          typeID: GUNNERY,
          name: "Gunnery",
          groupName: "Gunnery",
          level: 2,
          rank: 1,
          skillPoints: 1414,
          levelSkillPoints: [250, 1414, 8000, 45255, 256000],
          inTraining: false,
        },
        {
          typeID: SURGICAL,
          name: "Surgical Strike",
          groupName: "Gunnery",
          level: 5,
          rank: 4,
          skillPoints: 1024000,
          levelSkillPoints: [1000, 5657, 32000, 181019, 1024000],
          inTraining: false,
        },
        {
          typeID: INDUSTRY,
          name: "Industry",
          groupName: "Production",
          level: 1,
          rank: 1,
          skillPoints: 250,
          levelSkillPoints: [250, 1414, 8000, 45255, 256000],
          inTraining: false,
        },
      ],
      queue:
        options.queue === null
          ? null
          : {
              active: entries.length > 0 && !options.paused,
              maxEntries: 150,
              endTimeMs:
                entries.length > 0 && !options.paused
                  ? NOW + (entries.at(-1)!.offsetHours + entries.at(-1)!.lengthHours) * HOUR
                  : null,
              entries: entries.map((entry) => ({
                typeID: entry.typeID,
                toLevel: entry.toLevel,
                startSP: entry.startSP,
                destinationSP: entry.destinationSP,
                startTimeMs: options.paused ? null : NOW + entry.offsetHours * HOUR,
                endTimeMs: options.paused ? null : NOW + (entry.offsetHours + entry.lengthHours) * HOUR,
                skillPointsPerMinute: options.paused ? 0 : entry.rate,
              })),
            },
      // The panel's "now" is Date.now() + this. Date.now() is pinned to a
      // browser five hours behind, so this offset is what puts "now" on NOW.
      clockOffsetMs: CLOCK_OFFSET,
    });
  }
  return store;
}

function scene(options: SceneOptions = {}) {
  // Frozen across the render, because that is where the panel samples the clock.
  return atFrozenBrowserClock(() => {
    const output = render(Skills as never, {
      props: { store: sceneStore(options), flow: fakeFlow() },
    } as never);
    return { body: output.body, text: visibleText(output.body) };
  });
}

// --- The icons R27 cached finally have somewhere to appear -------------------

test("every skill on screen asks for its CACHED icon, not a lettered tile", () => {
  const { body } = scene();
  // The three skills in the sheet render three <img> tags pointing at the local
  // cache — never an external host (R27's rule), and never the fallback tile.
  for (const typeID of [GUNNERY, SURGICAL, INDUSTRY]) {
    assert.ok(
      body.includes(`/client-res/type-picture/${typeID}/64.png`),
      `the icon for type ${typeID} must come from the local cache`,
    );
  }
  assert.equal(
    body.includes("type-icon-tile"),
    false,
    "with a typeID on every skill, no lettered tile should render at all",
  );
  assert.equal(body.includes("images.evetech.net"), false, "icons are LOCAL only");
});

test("an icon carries the skill's NAME as its label, never its id", () => {
  const { body } = scene();
  assert.match(body, /alt="Gunnery"/);
  assert.match(body, /alt="Surgical Strike"/);
});

// --- The sheet ---------------------------------------------------------------

test("skills render grouped, with the group's own counts", () => {
  const { text } = scene();
  assert.match(text, /Gunnery/);
  assert.match(text, /Production/);
  // "1 of 2 at V" for Gunnery: Surgical Strike is finished, Gunnery is not.
  assert.match(text, /1 of 2 at V/);
  assert.match(text, /0 of 1 at V/);
});

test("a level is Roman numerals and five pips, never a bare digit", () => {
  const { body, text } = scene({
    queueEntries: [
      {
        typeID: GUNNERY,
        toLevel: 4,
        startSP: 1414,
        destinationSP: 45255,
        offsetHours: 0,
        lengthHours: 1,
        rate: 730,
      },
    ],
  });
  // Five pips per skill, and the queued levels are distinguishable from owned.
  assert.ok(body.includes("rank-filled"), "owned levels are filled");
  assert.ok(body.includes("rank-queued"), "planned levels are outlined, not filled");
  assert.ok(body.includes("rank-empty"));
  // ...and the level is also in words, so colour is never the only signal.
  assert.match(body, /aria-label="Level II"/);
  assert.match(text, /Gunnery IV/, "the queued level reads as a numeral");
});

test("SP shows where a skill stands against the SERVER's next threshold", () => {
  const { text } = scene();
  // Gunnery: 1,414 SP now, 8,000 for III. Both numbers came off the sheet.
  assert.match(text, /1,414/);
  assert.match(text, /of 8,000\s+for III/);
  // A finished skill offers nothing to train.
  assert.match(text, /Finished/);
});

// --- The clock ---------------------------------------------------------------

test("nothing training says so plainly instead of showing an empty bar", () => {
  const { text } = scene();
  assert.match(text, /Nothing is training/);
  assert.match(text, /The queue is empty/);
});

const TWO_QUEUED = [
  { typeID: GUNNERY, toLevel: 3, startSP: 1414, destinationSP: 8000, offsetHours: 0, lengthHours: 1, rate: 110 },
  { typeID: INDUSTRY, toLevel: 2, startSP: 250, destinationSP: 1414, offsetHours: 1, lengthHours: 1, rate: 0 },
];
/** Whether the page has a button with exactly these words on it. */
const buttonNamed = (body: string, label: string): boolean =>
  [...body.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].some((match) => visibleText(match[1]!).trim() === label);

test("a paused queue says it is paused, keeps its skills listed, and offers to start it again", () => {
  const { body, text } = scene({ queueEntries: TWO_QUEUED, paused: true });
  assert.match(text, /Training is paused/);
  assert.match(text, /Nothing on the queue is training while it is paused/);
  // The queue is still there to read and to rearrange.
  assert.match(body, /aria-label="Move Gunnery later"/);
  assert.match(body, /aria-label="Take Industry off the queue"/);
  // Each skill on it says it is paused, where a finishing time would be: none is "not known".
  assert.equal((body.match(/<td data-label="Finishes"[^>]*>paused<\/td>/g) ?? []).length, 2);
  assert.equal(/not known/.test(text), false);
  // It is not "nothing training, add something", and it has no finishing time to give.
  assert.equal(/Nothing is training\./.test(text), false);
  assert.equal(/finishes/.test(text), false);
  assert.deepEqual([buttonNamed(body, "Start training"), buttonNamed(body, "Pause training")], [true, false]);
});

test("a queue that is training offers to pause it, and an empty queue offers neither", () => {
  const training = scene({ queueEntries: TWO_QUEUED });
  assert.deepEqual([buttonNamed(training.body, "Pause training"), buttonNamed(training.body, "Start training")], [true, false]);
  assert.equal(/Training is paused/.test(training.text), false);
  assert.match(training.text, /Everything on the queue finishes/);
  // Each skill on it says when it finishes, and none says it is paused.
  const finishes = [...training.body.matchAll(/<td data-label="Finishes"[^>]*>([^<]*)<\/td>/g)].map((match) => match[1]!);
  assert.deepEqual([finishes.length, finishes.every((words) => /from now/.test(words))], [2, true]);
  const empty = scene();
  assert.deepEqual([buttonNamed(empty.body, "Pause training"), buttonNamed(empty.body, "Start training")], [false, false]);
});

test("a queue that could not be READ is not a queue that is empty", () => {
  const { text } = scene({ queue: null });
  assert.match(text, /could not be read/);
  assert.equal(/The queue is empty/.test(text), false);
});

test("the countdown and the bar are derived from the server's own instants", () => {
  const { body, text } = scene({
    queueEntries: [
      {
        typeID: GUNNERY,
        toLevel: 3,
        startSP: 1414,
        destinationSP: 8000,
        // Started half an hour ago; one hour long. Half done.
        offsetHours: -0.5,
        lengthHours: 1,
        rate: 6586 / 60,
      },
      {
        typeID: INDUSTRY,
        toLevel: 2,
        startSP: 250,
        destinationSP: 1414,
        offsetHours: 0.5,
        lengthHours: 2,
        rate: 0,
      },
    ],
  });
  // 30 minutes left on the head of the queue.
  assert.match(text, /30m 0s left/);
  // The bar is at 50%, from the server's SP span — not from a local clock.
  assert.match(body, /width: 50/);
  assert.match(body, /aria-valuenow="50"/);
  // The SP readout names both ends and the rate, all server values.
  assert.match(text, /4,707 of 8,000 skill points/);
  assert.match(text, /at 110 a minute/);
  // The whole queue's finish is 2h 30m out.
  assert.match(text, /finishes 2h 30m from now/);
});

test("the panel never advances a skill itself — a finish is re-read, not assumed", () => {
  // The panel's own source is the proof here: it calls loadSkills when the
  // countdown reaches zero, and there is no branch anywhere that promotes a
  // level or adds SP locally.
  assert.match(SOURCE, /confirmedFinishAt = readout\.finishAtMs;\s*\n\s*void run\(\(\) => flow\.loadSkills\(\)\)/);
  assert.equal(/skills\.level\s*\+/.test(SOURCE), false, "no local level promotion");
  assert.equal(/skillPoints\s*\+=/.test(SOURCE), false, "no local SP accrual");
});

// --- Standing invariants -----------------------------------------------------

test("R7d: a skill is its name, and no numeric id is ever visible", () => {
  const { text } = scene({
    queueEntries: [
      {
        typeID: GUNNERY,
        toLevel: 3,
        startSP: 1414,
        destinationSP: 8000,
        offsetHours: 0,
        lengthHours: 1,
        rate: 110,
      },
    ],
  });
  for (const typeID of [GUNNERY, SURGICAL, INDUSTRY]) {
    assert.equal(
      text.includes(String(typeID)),
      false,
      `typeID ${typeID} must never be rendered as data`,
    );
  }
});

test("R9a: the panel explains itself in a player's words", () => {
  const { text } = scene();
  assert.match(text, /What you know/);
  assert.match(text, /Training now/);
  assert.match(text, /Up next/);
  assert.match(text, /keeps going whether or not this page is open/);
  // No jargon leaks from the wire.
  for (const jargon of ["CALL_REFUSED", "typeID", "SaveNewQueue", "skillMgr", "queuePosition"]) {
    assert.equal(text.includes(jargon), false, `${jargon} must not reach the player`);
  }
});

test("R8: the controls are real buttons with real labels", () => {
  const { body } = scene({
    queueEntries: [
      {
        typeID: GUNNERY,
        toLevel: 3,
        startSP: 1414,
        destinationSP: 8000,
        offsetHours: 0,
        lengthHours: 1,
        rate: 110,
      },
      {
        typeID: INDUSTRY,
        toLevel: 2,
        startSP: 250,
        destinationSP: 1414,
        offsetHours: 1,
        lengthHours: 1,
        rate: 0,
      },
    ],
  });
  // Reordering and removal are labelled for a screen reader by SKILL NAME.
  assert.match(body, /aria-label="Move Gunnery later"/);
  assert.match(body, /aria-label="Take Industry off the queue"/);
  // Every table that can outgrow a phone scrolls inside its own box.
  assert.ok(body.includes("table-wrap"));
  assert.ok(body.includes("reflow"), "tables use the R8 card-reflow contract");
  // Every cell carries its reflow label.
  const cells = body.match(/<td(?![^>]*data-label)/g) ?? [];
  assert.deepEqual(cells, [], "every <td> needs a data-label for the R8 reflow");
});
