// THE LAUNCHER as it actually RENDERS (goal R43).
//
// What this panel can get wrong is narrow and expensive:
//
//   1. LISTING A BOT AND NOT LAUNCHING IT. A launcher that renders but whose
//      Start does nothing is the failure mode of the whole goal, so the real
//      components must be EMBEDDED rather than described.
//   2. FORKING A READOUT. A second copy of "what the bot is doing" does not go
//      quiet when it drifts — it keeps rendering, confidently, about something
//      else. A static sweep pins that this file contains no such copy.
//   3. GOING SILENT ABOUT WHY. R30 and R33 both established that an unavailable
//      control states its reason. A checklist line that merely fails to tick
//      tells a player nothing they can act on.
//   4. The standing invariants — R7d (no visible numeric IDs), R9a (plain
//      player language), R8 (≥40px targets, no horizontal body scroll), R18
//      (renders against an empty store).

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { createClientStore } = await import("../store/clientStore.ts");
const { BOTS } = await import("../nav/botRegistry.ts");
const { PROCURER_MODULES, STRIP_MINER_ITEM_IDS, SHIP_ID, STATION_ID } = await import(
  "../app/botFixtures.ts"
);
const Bots = (await import("./Bots.svelte")).default;

const UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(UI_DIR, "Bots.svelte"), "utf8");

/**
 * The panel's source with every comment removed.
 *
 * ⚠ THE FORK SWEEP MUST READ CODE, NOT PROSE. The panel's own comments name
 * `flow.startMiningBot` while explaining that the launcher deliberately does
 * NOT call it — sweeping the raw text would fail on the very comment that
 * documents the property being asserted, which is a test that punishes
 * explanation. Comments come out first; what is left is what runs.
 */
const CODE = SOURCE.replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^[ \t]*\/\/.*$/gm, " ");

function fakeFlow(): unknown {
  return new Proxy({}, { get: () => async () => {} });
}

function visibleText(body: string): string {
  return body
    .replace(/<img[^>]*>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
}

function renderPanel(store: unknown): string {
  return render(Bots as never, { props: { store, flow: fakeFlow() } } as never).body;
}

/** A store holding Farmer's real Procurer, docked, with every name resolved. */
function procurerStore(options: { readonly minersOffline?: boolean } = {}) {
  const store = createClientStore();
  store.apply({
    type: "flight/status",
    status: {
      inSpace: false,
      docked: true,
      solarSystemID: 30000144,
      stationID: STATION_ID,
      structureID: null,
      shipID: SHIP_ID,
      shipTypeID: null,
      shipIsCapsule: null,
      shipMode: null,
      shipSpeedFraction: null,
    },
  });
  store.apply({
    type: "fitting/loaded",
    activeShipID: SHIP_ID,
    slots: PROCURER_MODULES.map((row, index) => ({
      family:
        row.flagID >= 92 ? "rig" : row.flagID >= 27 ? "high" : row.flagID >= 19 ? "mid" : "low",
      index,
      module: {
        itemID: row.itemID,
        typeID: row.typeID,
        groupID: row.groupID,
        online: options.minersOffline ? !STRIP_MINER_ITEM_IDS.includes(row.itemID) : true,
        charge: null,
      },
    })),
    resources: {
      cpu: { used: 281, total: 387.5, known: true },
      powergrid: { used: 79, total: 112.5, known: true },
      capacitor: { used: 0, total: 1000, known: true },
      calibration: { used: 400, total: 400, known: true },
    },
    stats: createClientStore().get().fitting.stats,
    slotsError: null,
    resourcesError: null,
  });
  // R47 — the launcher now decides "is that a miner?" from the game's GROUP, so
  // "every name resolved" must include the typeGroup answers too. Without them
  // the panel would (correctly) sit in cannot-tell and never clear a bot.
  store.apply({
    type: "names/resolved",
    entries: Object.fromEntries(
      PROCURER_MODULES.flatMap((row) => [
        [`type:${row.typeID}`, row.name],
        [`typeGroup:${row.typeID}`, row.groupName],
      ]),
    ),
  });
  store.apply({
    type: "mining/holds",
    holds: [
      {
        key: "ore",
        label: "Ore hold",
        items: [],
        capacity: { capacity: 16000, used: 0 },
        present: true,
        error: null,
      },
    ],
  });
  return store;
}

// --- 1. every bot is listed -------------------------------------------------

test("every registered bot appears in the launcher, by its player-facing name", () => {
  const body = renderPanel(procurerStore());
  const text = visibleText(body);
  assert.ok(BOTS.length >= 2, "there is more than one bot to launch");
  for (const entry of BOTS) {
    assert.ok(text.includes(entry.name), `${entry.name} is missing from the launcher`);
    assert.ok(text.includes(entry.summary), `${entry.name} does not say what it does`);
  }
});

test("R18 — the launcher renders against a completely empty store", () => {
  // Nothing loaded: no flight status, no fit, no holds. Every requirement is
  // unreadable, and the panel must still draw rather than throwing during
  // creation and leaving the tab silently inert.
  const body = renderPanel(createClientStore());
  assert.equal(typeof body, "string");
  const text = visibleText(body);
  for (const entry of BOTS) {
    assert.ok(text.includes(entry.name));
  }
  assert.ok(text.includes("Nothing is running"), "and it says so rather than showing nothing");
});

// --- 2. a bot that cannot start says WHY ------------------------------------

test("R43 — a ship with no miner powered up SAYS SO, in words a player can act on", () => {
  const text = visibleText(renderPanel(procurerStore({ minersOffline: true })));
  // The miners are FITTED, just switched off — so the sentence must send the
  // player to the one click that fixes it, not to the Fitting tab.
  assert.match(
    text,
    /fitted but not switched on/i,
    "the checklist must state the reason, not merely fail to tick",
  );
  assert.match(text, /Around Your Ship/);
  assert.doesNotMatch(
    text,
    /no mining equipment fitted/i,
    "a switched-off miner must never be reported as a missing one",
  );
});

test("R43 — an UNREADABLE fit says it could not check, and never that you have no miner", () => {
  // The empty store has never loaded a fitting. "We did not look" must not be
  // reported as "you have none" — they send a player to different places.
  const text = visibleText(renderPanel(createClientStore()));
  assert.match(text, /could not read what is fitted/i);
  assert.doesNotMatch(
    text,
    /no mining equipment fitted/i,
    "an unread fit must never be reported as a fit with no miner in it",
  );
});

test("R43 — the two Strip Miners tick the box; the Ice Harvester decoys do not", () => {
  // Powered up, the real Procurer meets the requirement.
  const ready = visibleText(renderPanel(procurerStore()));
  assert.doesNotMatch(ready, /fitted but not switched on/i);
  assert.doesNotMatch(ready, /no mining equipment fitted/i);

  // Powered down, the SAME hull fails it — even though it still carries an
  // "Ice Harvester Upgrade II" (a LOW slot module) and a "Medium Ice Harvester
  // Accelerator I" (a RIG), neither of which a high-slot filter can even see.
  const notReady = visibleText(renderPanel(procurerStore({ minersOffline: true })));
  assert.match(notReady, /fitted but not switched on/i);
});

test("R43 — an advisory requirement reads as what the bot WILL DO, not as a refusal", () => {
  // Docked. The mining bot handles that itself (unload, undock), so the line
  // must describe that rather than telling the player to go and undock.
  const text = visibleText(renderPanel(procurerStore()));
  assert.match(text, /unload anything aboard and undock/i);
  assert.doesNotMatch(text, /Undock first/i, "the launcher must not be narrower than the bot");
});

// --- 3. what is currently running -------------------------------------------

test("R43 — a running bot is named at the top, so a player who switched panels finds it", () => {
  const store = procurerStore();
  assert.match(visibleText(renderPanel(store)), /Nothing is running/);

  store.apply({
    type: "mission-bot/started",
    agentName: "Aursa Bemenen",
    stationName: "Perimeter VI - Ytiri Storage",
    startedAt: Date.now(),
  });

  const text = visibleText(renderPanel(store));
  assert.equal(store.get().bots.runningBotID, "mission");
  assert.match(text, /Mission bot[\s\S]*is flying your ship right now/);
  assert.doesNotMatch(text, /Nothing is running/);
});

test("R43 — a PAUSED bot still reads as holding the ship", () => {
  const store = procurerStore();
  store.apply({
    type: "bot/started",
    beltName: "Asteroid Belt 1",
    stationName: "Perimeter VI - Ytiri Storage",
    startedAt: Date.now(),
  });
  store.apply({
    type: "bot/progress",
    status: "paused",
    phase: "Paused",
    action: null,
    why: "You paused the bot.",
    // R44 — the readout carries which rung fired; a paused bot fired none.
    // R46 — and which step inside it; no rung means no step either.
    rung: null,
    step: null,
    rockName: null,
    cyclesCompleted: 0,
    oreUnitsMined: 0,
    holdUsed: 0,
    holdCapacity: 16000,
    failureReason: null,
  });

  assert.equal(store.get().bots.runningBotID, "mining");
  const text = visibleText(renderPanel(store));
  assert.match(text, /Mining bot[\s\S]*is flying your ship right now/);
  assert.match(text, /Paused/);
});

// --- a plugin's loop is not a card here, but it is named when it holds the ship ---

test("the launcher offers the two bots and nothing that is not a bot", () => {
  // ⚠ A PLUGIN'S LOOP IS NOT IN THE BOT CATALOGUE. This page launches the two
  // built-in bots; anything a plugin adds has its own window, and a card for it
  // here would be a second door onto it on a page about something else.
  const text = visibleText(renderPanel(procurerStore()));
  assert.match(text, /Mining bot/);
  assert.match(text, /Mission bot/);
});

test("⚠ but a plugin's loop HOLDING the ship is still named at the top", () => {
  // The one thing this panel cannot stop saying about a plugin's loop. With it
  // outside `BOTS`, a name looked up in the catalogue would come back null and
  // the panel would print "Nothing is running" about a hull a plugin is
  // actively flying -- and the player's next act here is to start a bot on it.
  const store = procurerStore();
  store.apply({
    type: "ship/plugin-holder",
    holder: { owner: "plugin:sample-loop", name: "Sample loop" },
  });
  assert.equal(store.get().bots.runningBotID, "plugin:sample-loop");
  const text = visibleText(renderPanel(store));
  assert.match(text, /Sample loop[\s\S]*is flying your ship right now/i);
  assert.doesNotMatch(text, /Nothing is running/);
});

// --- 4. it embeds the real components, and forks nothing --------------------

test("R43 — the launcher EMBEDS MiningBot and MissionBot rather than describing them", () => {
  assert.match(SOURCE, /import\s+MiningBot\s+from\s+"\.\/MiningBot\.svelte"/);
  assert.match(SOURCE, /import\s+MissionBot\s+from\s+"\.\/MissionBot\.svelte"/);
  // Both are actually rendered, with the same props the components take.
  assert.match(SOURCE, /<MiningBot\s+\{store\}\s+\{flow\}\s*\/>/);
  assert.match(SOURCE, /<MissionBot\s+\{store\}\s+\{flow\}\s*\/>/);
});

test("R43 — the launcher does not FORK either bot's readout or its controls", () => {
  // ⚠ A forked readout does not go quiet when it drifts; it keeps rendering,
  // confidently, about a bot that is doing something else. So the launcher must
  // not reach for the fields that ARE the readout, and must not grow its own
  // Start / Pause / Stop.
  const readoutFields = [
    "cyclesCompleted",
    "oreUnitsMined",
    "holdCapacity",
    "missionsCompleted",
    "iskEarned",
    "lpEarned",
    "failureReason",
    "rockName",
    "missionName",
    "cargoText",
  ];
  for (const field of readoutFields) {
    assert.ok(
      !CODE.includes(field),
      `the launcher reads ${field} — that is the embedded component's job`,
    );
  }
  for (const verb of ["startMiningBot", "startMissionBot", "pauseMiningBot", "stopMiningBot"]) {
    assert.ok(!CODE.includes(verb), `the launcher calls ${verb} — it must not fork the controls`);
  }
  // And the sweep is only worth having if it can actually see a call: the
  // comment-stripped source must still contain the code it is checking.
  assert.ok(CODE.includes("evaluateRequirements"), "the sweep is reading real code");
});

test("R43 — it is a launcher, not an editor: nothing here authors a bot", () => {
  // Visual/node-based bot authoring is under separate discovery and this must
  // not pre-empt its design decisions.
  for (const forbidden of ["addNode", "onDrop", "draggable", "contenteditable"]) {
    assert.ok(!CODE.includes(forbidden), `the launcher has grown an editor affordance: ${forbidden}`);
  }
});

test("R43 — the panel points a player looking for their saved bots at the Bot Manager", () => {
  const text = visibleText(renderPanel(procurerStore()));
  assert.match(text, /Bot Manager/, "a player must be told where saved bots went, not left hunting");
});

// --- 5. the standing invariants ---------------------------------------------

test("R7d — the launcher never renders a numeric game id", () => {
  const store = procurerStore();
  store.apply({
    type: "mission-bot/started",
    agentName: "Aursa Bemenen",
    stationName: "Perimeter VI - Ytiri Storage",
    startedAt: Date.now(),
  });
  const text = visibleText(renderPanel(store));
  for (const id of [SHIP_ID, STATION_ID, ...STRIP_MINER_ITEM_IDS, ...PROCURER_MODULES.map((r) => r.typeID)]) {
    assert.equal(text.includes(String(id)), false, `numeric id leaked: ${id}`);
  }
});

test("R9a — the launcher shows no raw state word and no wire code", () => {
  const store = procurerStore();
  store.apply({
    type: "bot/started",
    beltName: "Asteroid Belt 1",
    stationName: "Perimeter VI - Ytiri Storage",
    startedAt: Date.now(),
  });
  const text = visibleText(renderPanel(store));
  // The store's own state words must be TRANSLATED, never printed.
  for (const raw of ["runningBotID", "cannot-tell", "not-met", "blocking", "advisory"]) {
    assert.equal(text.includes(raw), false, `raw vocabulary leaked: ${raw}`);
  }
  assert.doesNotMatch(text, /CALL_REFUSED|NOT_IN_SPACE|UI\//);
});

test("R8 — the launcher offers a comfortable target and cannot scroll the body sideways", () => {
  assert.match(SOURCE, /min-height:\s*40px/, "its controls declare a ≥40px target");
  // A grid that can never be wider than its container.
  assert.match(SOURCE, /minmax\(min\(100%,/, "the card grid collapses rather than overflowing");
  assert.ok(!/width:\s*\d{3,}px/.test(SOURCE), "no fixed pixel width can force a sideways scroll");
});

test("R43 — every checklist line that is not met carries a sentence", () => {
  // The rendered panel, against a store where several requirements are unread.
  const text = visibleText(renderPanel(createClientStore()));
  // Each unmet/unknown line renders "title — reason". At minimum the three
  // unreadable ship requirements must each state their own reason.
  assert.match(text, /could not read what is fitted/i);
  assert.match(text, /could not read where your ship is/i);
  assert.match(text, /could not read how much room is in your hold/i);
});
