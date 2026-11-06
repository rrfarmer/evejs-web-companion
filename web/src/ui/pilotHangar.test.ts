// The Pilot Hangar renders (goal R18 — a component that dies during creation
// takes its whole screen down silently, and this one IS the whole screen).
//
// Rendered with Svelte's server generator, like panelFirstMount.test.ts — no DOM
// needed. `$effect` and `onMount` do not run there, so this pins RENDER-time
// correctness: nothing here signs in, refreshes the roster or launches a pilot.
//
// Both states matter and fail for different reasons. First run has no roster at
// all and must reach the "No pilots yet" copy rather than an empty page; a
// populated hangar must group by account and print every column, and it is the
// one that would break on a roster row written by an older build with none of
// the hangar's fields on it.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./svelteSsrHook.ts", import.meta.url);

const { render } = await import("svelte/server");
const { setKnownCharacterStorage } = await import("../app/knownCharacters.ts");
const { setHangarPrefsStorage } = await import("../app/hangarPrefs.ts");
const PilotHangar = (await import("./PilotHangar.svelte")).default;
const HangarPilotRow = (await import("./HangarPilotRow.svelte")).default;
const HangarSquadAssign = (await import("./HangarSquadAssign.svelte")).default;
const HangarSquadPicker = (await import("./HangarSquadPicker.svelte")).default;

const ROSTER_KEY = "evejs-web-known-characters:v1";
import { DEFAULT_COMPANION_SETUP } from "../nav/fleetCompanionLoop.ts";

const PREFS_KEY = "evejs-web-hangar-prefs:v1";

function storage(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed };
  return {
    getItem: (key: string) => data[key] ?? null,
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

function renderHangar(): string {
  return render(PilotHangar as never, {
    props: {
      onlineIDs: new Set<number>([90000002]),
      onLaunch: async () => {},
      onShowPilot: () => {},
      onClose: null,
    },
  } as never).body;
}

const ROSTER = JSON.stringify([
  {
    accountName: "Test Account",
    characterID: 90000001,
    characterName: "Ore Farmer",
    shipName: "Venture",
    skillPoints: 134_900_000,
    balance: 4.82e9,
    lastSeen: 2,
    locationName: "Jita IV - Moon 4",
    trainingSkillName: "Mining Barge",
    trainingToLevel: 5,
    trainingEndsAtMs: null,
  },
  {
    accountName: "Test Account",
    characterID: 90000002,
    characterName: "Hauler",
    shipName: "Bestower",
    skillPoints: 10_000_000,
    balance: 1.14e9,
    lastSeen: 2,
  },
  {
    accountName: "Other Account",
    characterID: 90000003,
    characterName: "Scout",
    shipName: "Velator",
    skillPoints: 400_000,
    balance: 1.2e6,
    lastSeen: 1,
  },
]);

test.afterEach(() => {
  setKnownCharacterStorage(null);
  setHangarPrefsStorage(null);
});

test("first run renders the empty state rather than a blank page", () => {
  setKnownCharacterStorage(storage());
  setHangarPrefsStorage(storage());
  const body = renderHangar();
  assert.match(body, /No pilots yet/);
  assert.match(body, /Add your first account/);
});

test("a populated hangar groups by account and prints every pilot column", () => {
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(storage());
  const body = renderHangar();

  // Accounts are the grouping, BY NAME — the roster's own order is `lastSeen`
  // descending and the hangar's refresh rewrites that account by account, so
  // ordering by it shuffled the sections on every open of the screen.
  assert.match(body, /Test Account/);
  assert.match(body, /Other Account/);
  assert.ok(body.indexOf("Other Account") < body.indexOf("Test Account"));

  // Every column the screen exists to show.
  assert.match(body, /Ore Farmer/);
  assert.match(body, /Venture/);
  assert.match(body, /Jita IV - Moon 4/);
  assert.match(body, /4\.82b ISK/);
  assert.match(body, /134\.9m SP/);
  assert.match(body, /Mining Barge V/);

  // A pilot already in the client carries the badge, with its word.
  assert.match(body, />ON</);
  // A pilot with an empty queue says so twice — the badge and the stat line.
  assert.match(body, />IDLE</);
  assert.match(body, /not training/);

  // The summary counts the whole roster, and nothing is filtered yet.
  assert.match(body, /All pilots, grouped by account/);
  assert.match(body, /3 shown/);
  // The header carries no "N in client" counter: the In client filter chip
  // already shows that count, and the header's room is the launchers'.
  assert.doesNotMatch(body, /in client</);
});

test("a roster row written before the hangar existed renders dashes, not ids", () => {
  // R7d: an unresolved place or skill is an em dash. The row below has neither
  // a locationName nor a trainingSkillName — exactly what an upgrade from an
  // older build looks like.
  setKnownCharacterStorage(
    storage({
      [ROSTER_KEY]: JSON.stringify([
        {
          accountName: "Legacy",
          characterID: 90000009,
          characterName: "Old Row",
          shipName: null,
          skillPoints: null,
          balance: null,
          lastSeen: 1,
        },
      ]),
    }),
  );
  setHangarPrefsStorage(storage());
  const body = renderHangar();
  assert.match(body, /Old Row/);
  assert.match(body, /—/);
  assert.doesNotMatch(body, /90000009/, "a raw character id must never reach the player");
});

test("accounts with room offer their empty slots", () => {
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(storage());
  const body = renderHangar();
  // Other Account has one pilot of three; Test Account has two of three. Three slots.
  assert.equal(body.split("+ Add character").length - 1, 3);
  assert.match(body, /slot 3\/3/);
});

test("a squad puts its colour on the chip row and a dot on its pilots", () => {
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(
    storage({
      [PREFS_KEY]: JSON.stringify({
        squads: [{ id: "s1", name: "Mining Op", color: "#52d9a3" }],
        members: { s1: [90000001, 90000003] },
        pinnedSquads: ["s1"],
        pinnedPilots: [],
        collapsedAccounts: [],
      }),
    }),
  );
  const body = renderHangar();
  assert.match(body, /Mining Op/);
  // Both members carry a titled dot, so the colour is never the only signal.
  assert.equal(body.split('title="Mining Op"').length - 1, 2);
});

test("an unpinned squad is still a chip, not only a row in the dropdown", () => {
  // The regression this pins: squads used to reach the chip row only once
  // pinned, and nothing pins itself — so on a fresh install every squad the
  // player made was reachable ONLY through "All squads ▼", which is the one
  // control on the screen they had no reason to open.
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(
    storage({
      [PREFS_KEY]: JSON.stringify({
        squads: [
          { id: "s1", name: "Mining Op", color: "#52d9a3" },
          { id: "s2", name: "Scout Net", color: "#6fb4e8" },
        ],
        members: { s1: [90000001], s2: [90000003] },
        pinnedSquads: ["s2"],
        pinnedPilots: [],
        collapsedAccounts: [],
      }),
    }),
  );
  const body = renderHangar();
  const chiprow = body.slice(
    body.indexOf('class="hangar-chiprow"'),
    body.indexOf('class="hangar-summary"'),
  );
  assert.match(chiprow, /Mining Op/, "the unpinned squad is on the row too");
  // Pinned first: a squad kept at the front stays at the front.
  assert.ok(
    chiprow.indexOf("Scout Net") < chiprow.indexOf("Mining Op"),
    "pinning decides the order the chips come in",
  );
});

test("a collapsed account shows its header and hides its pilots", () => {
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(
    storage({
      [PREFS_KEY]: JSON.stringify({
        squads: [],
        members: {},
        pinnedSquads: [],
        pinnedPilots: [],
        collapsedAccounts: ["Other Account"],
      }),
    }),
  );
  const body = renderHangar();
  assert.match(body, /Other Account/);
  assert.doesNotMatch(body, /Scout/);
  assert.match(body, /Ore Farmer/, "the other account is unaffected");
});

// --- the squad picker -------------------------------------------------------

function renderPicker(squads: unknown[], open = true): string {
  return render(HangarSquadPicker as never, {
    props: {
      squads,
      prefs: { squads, members: {}, pinnedSquads: [], pinnedPilots: [], collapsedAccounts: [] },
      knownIDs: new Set<number>(),
      open,
      onToggleOpen: () => {},
      onSelect: () => {},
      onTogglePin: () => {},
      onLaunch: () => {},
      onEdit: () => {},
      onNew: () => {},
    },
  } as never).body;
}

test("every squad in the picker offers the editor, which is where Delete lives", () => {
  // The gap this pins: a squad could be made from three places and unmade from
  // none of them, unless the player pressed Manage and noticed that the chips'
  // "▶ ALL" had quietly turned into an "edit". The picker already lists every
  // squad by name, so the way out of one lives there too.
  const body = renderPicker([
    { id: "s1", name: "Mining Op", color: "#52d9a3" },
    { id: "s2", name: "Scout Net", color: "#6fb4e8" },
  ]);
  assert.equal(
    body.split('class="hangar-chip-edit is-picker"').length - 1,
    2,
    "both squads, not just a pinned or selected one",
  );
  assert.match(body, /Rename, recolour or delete Mining Op/);
  assert.match(body, /Rename, recolour or delete Scout Net/);
});

test("a closed picker is a chip and nothing else", () => {
  const body = renderPicker([{ id: "s1", name: "Mining Op", color: "#52d9a3" }], false);
  assert.match(body, /All squads \(1\)/);
  assert.doesNotMatch(body, /Mining Op/, "the list belongs to the open popover");
});

test("an empty picker says so rather than showing an empty box", () => {
  assert.match(renderPicker([]), /No squads yet\./);
});

// --- the row on its own -----------------------------------------------------

/** The same pilot `renderRow` builds by default, for tests that vary it. */
function basePilot() {
  return {
    characterID: 90000001,
    name: "Ore Farmer",
    accountName: "Test Account",
    shipName: "Venture",
    locationName: "Jita",
    skillPoints: 134_900_000,
    balance: 4.82e9,
    training: "Mining Barge V - 4d 6h",
    online: false,
    pinned: false,
    squads: [] as { id: string; name: string; color: string }[],
  };
}

function renderRow(overrides: Record<string, unknown> = {}): string {
  const pilot = {
    characterID: 90000001,
    name: "Ore Farmer",
    accountName: "Test Account",
    shipName: "Venture",
    locationName: "Jita",
    skillPoints: 134_900_000,
    balance: 4.82e9,
    training: "Mining Barge V · 4d 6h",
    online: false,
    pinned: false,
    squads: [],
  };
  return render(HangarPilotRow as never, {
    props: {
      pilot,
      selected: false,
      manage: false,
      tapSelects: false,
      squads: [],
      squadMenuOpen: false,
      onActivate: () => {},
      onToggleSelect: () => {},
      onTogglePin: () => {},
      onRemove: () => {},
      onToggleSquadMenu: () => {},
      onToggleSquad: () => {},
      ...overrides,
    },
  } as never).body;
}

test("manage mode hides every way to launch or select a pilot by accident", () => {
  const normal = renderRow();
  assert.match(normal, /type="checkbox"/);
  assert.match(normal, /role="button"/);

  const managing = renderRow({ manage: true });
  assert.doesNotMatch(managing, /type="checkbox"/, "no selection while managing");
  assert.doesNotMatch(managing, /role="button"/, "the row itself is inert while managing");
  assert.match(managing, /Squads \(0\)/, "and the squad checklist appears instead");
});

// --- the server-bot row -----------------------------------------------------
//
// ⚠ THE BUG THESE PIN. A server bot keeps flying after the tab that started it
// is gone, so the screen the player comes back to is this one — and the BFF
// refuses to select a character a bot is flying. Until the row carried a Stop,
// a browser whose pilots were ALL bot-flown had no reachable way to stop any of
// them: every row refused, and the app's only Stop was behind the "Add
// character" overlay you had to already know about.

/** One row of /api/bots/active, with only the fields the row reads. */
function activeBot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    characterID: 90000001,
    status: "running",
    phase: "Mining",
    why: "belt is not dry yet",
    note: null,
    vitals: null,
    ...over,
  };
}

test("a bot-flown row says a bot has it, what it is doing, and offers Stop", () => {
  const body = renderRow({ bot: activeBot(), onStopBot: () => {} });
  assert.match(body, />BOT</, "the badge carries a word, not a colour (R9a)");
  assert.match(body, /Mining — belt is not dry yet/, "what the bot is doing right now");
  assert.match(body, /Stop bot/, "and the remedy is on the row itself");
});

test("a row with no bot on it is exactly the row it was before", () => {
  const body = renderRow();
  assert.doesNotMatch(body, />BOT</);
  assert.doesNotMatch(body, /Stop bot/);
});

test("the ship readout appears only once the host has sampled it", () => {
  const unsampled = renderRow({ bot: activeBot(), onStopBot: () => {} });
  assert.doesNotMatch(unsampled, /Shield/, "no bars before the first ~15s sample");

  const sampled = renderRow({
    bot: activeBot({
      vitals: {
        sampledAt: "2026-09-02T13:00:00.000Z",
        docked: false,
        shield: 0.92,
        armor: 1,
        hull: 1,
        holds: [{ label: "Ore hold", used: 3, capacity: 4 }],
      },
    }),
    onStopBot: () => {},
  });
  assert.match(sampled, /Shield 92%/);
  assert.match(sampled, /Ore hold 75%/);
});

test("Stop stays reachable in manage mode, unlike every other row control", () => {
  // Manage mode makes the row inert on purpose — but it is where you remove
  // pilots and shuffle squads, and a hull out mining unattended must not need
  // you to leave a mode before you can stop it.
  const body = renderRow({ manage: true, bot: activeBot(), onStopBot: () => {} });
  assert.doesNotMatch(body, /role="button"/, "the row itself is still inert");
  assert.match(body, /Stop bot/);
});

test("a stop in flight says so on its own row and locks every other one", () => {
  const mine = renderRow({ bot: activeBot(), onStopBot: () => {}, stopping: true, stopBusy: true });
  assert.match(mine, /Stopping…/);
  assert.match(mine, /disabled/);

  const other = renderRow({ bot: activeBot(), onStopBot: () => {}, stopBusy: true });
  assert.match(other, /Stop bot/, "a different pilot's button keeps its own word");
  assert.match(other, /disabled/, "but cannot be pressed while a stop is in flight");
});

// --- "Save as squad" --------------------------------------------------------

function renderAssign(squads: unknown[]): string {
  return render(HangarSquadAssign as never, {
    props: {
      pilotCount: 2,
      squads,
      prefs: { squads, members: {}, pinnedSquads: [], pinnedPilots: [], collapsedAccounts: [] },
      knownIDs: new Set<number>(),
      suggestedName: "New squad 1",
      suggestedColor: "#52d9a3",
      onConfirm: () => {},
      onCancel: () => {},
    },
  } as never).body;
}

test("with squads to choose from, the chooser offers them before a new one", () => {
  const body = renderAssign([{ id: "s1", name: "Mining Op", color: "#52d9a3" }]);
  assert.match(body, /Mining Op/, "the existing squad is a choice");
  assert.match(body, /Create a new squad/);
  assert.match(body, /Add 2 pilots/, "and the button says what confirming will do");
});

test("with no squads yet the chooser is straight to naming a new one", () => {
  const body = renderAssign([]);
  assert.doesNotMatch(body, /Create a new squad/, "nothing to choose between");
  assert.match(body, /Squad name/);
  assert.match(body, /Create squad with 2 pilots/);
});


// --- starting a squad's companions on the server ----------------------------

const SQUAD = { id: "s-fly", name: "Strike Wing", color: "#52d9a3" };

function prefsWithSquad(configured: boolean): string {
  return JSON.stringify({
    squads: [SQUAD],
    members: { [SQUAD.id]: [90000001] },
    pinnedSquads: [SQUAD.id],
    pinnedPilots: [],
    collapsedAccounts: [],
    companionConfigs: configured ? { [SQUAD.id]: { "90000001": DEFAULT_COMPANION_SETUP } } : {},
  });
}

test("a squad with nobody set up offers no FLY control at all", () => {
  // ⚠ THE CONTROL IS GATED ON THERE BEING SOMETHING TO START. A squad start
  // works from the saved per-pilot setups; a squad with none would start
  // nothing, and a button that does nothing is worse than no button.
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(storage({ [PREFS_KEY]: prefsWithSquad(false) }));
  const body = renderHangar();
  assert.match(body, /Strike Wing/, "the squad chip is there either way");
  assert.doesNotMatch(body, />FLY</);
});

test("a squad with a configured pilot offers FLY, and says how it differs from ALL", () => {
  // ⚠ TWO DIFFERENT THINGS, ONE CHIP ROW. "ALL" signs pilots into THIS TAB and
  // they stop when it closes. "FLY" starts their companions on the bot host,
  // which keeps flying with the tab shut and does not need them signed in here
  // at all. A player who cannot tell those apart will close the tab on a fleet.
  setKnownCharacterStorage(storage({ [ROSTER_KEY]: ROSTER }));
  setHangarPrefsStorage(storage({ [PREFS_KEY]: prefsWithSquad(true) }));
  const body = renderHangar();
  assert.match(body, />FLY</);
  assert.match(body, />. ALL</, "the tab launch is still there");
  assert.match(
    body,
    /keep flying when this tab closes/,
    "the difference must be stated on the control itself",
  );
});


// --- the per-pilot companion setup, in the squad popover --------------------
//
// ⚠ THERE IS NO ROLE PICKER ANY MORE, AND NO SEPARATE TAGGING CHECKBOX.
// docs/fleet-companion-simplification.md removes the role entirely and makes
// the PRESENCE of a companion setup the only marker that a pilot is a
// companion in a squad -- see `companionConfigFor`'s own comment in
// hangarPrefs.ts. What used to be a role select plus a tagging checkbox is now
// one plain "Flies as companion" toggle.

test("a ticked squad offers a companion toggle; only that squad does", () => {
  // ⚠ ONLY THE SQUADS THIS PILOT IS IN GROW A SECOND LINE. Growing EVERY row
  // was tried before and rejected: at eleven squads it made each row about
  // 230px tall (docs/pilot-hangar.md). A pilot is typically in one or two.
  const inOne = renderRow({
    manage: true,
    squadMenuOpen: true,
    squads: [SQUAD, { id: "s-other", name: "Scout Net", color: "#6fb4e8" }],
    pilot: { ...basePilot(), squads: [SQUAD] },
  });
  assert.match(inOne, /Flies as companion/, "the squad it is in offers the toggle");
  assert.equal(
    (inOne.match(/Flies as companion/g) ?? []).length,
    1,
    "and only that one does",
  );
});

test("the tick and the companion toggle are SEPARATE controls", () => {
  // ⚠ A CONTROL NESTED IN THE TICK WOULD BE INVALID HTML AND WOULD FIRE THE
  // MEMBERSHIP TOGGLE ON EVERY CLICK. The row is a <button>; the companion
  // toggle is its sibling. This asserts the checkbox is not inside the button
  // element.
  const body = renderRow({
    manage: true,
    squadMenuOpen: true,
    squads: [SQUAD],
    pilot: { ...basePilot(), squads: [SQUAD] },
  });
  const rowStart = body.indexOf('class="hangar-squadmenu-row');
  assert.ok(rowStart >= 0, "the membership button is there");
  const rowEnd = body.indexOf("</button>", rowStart);
  const checkboxAt = body.indexOf('type="checkbox"', rowStart);
  assert.ok(checkboxAt > rowEnd, "the companion toggle must sit AFTER the button closes");
});

test("a pilot with no companion setup shows the toggle unticked", () => {
  const body = renderRow({
    manage: true,
    squadMenuOpen: true,
    squads: [SQUAD],
    pilot: { ...basePilot(), squads: [SQUAD] },
    companionEnabledFor: () => false,
  });
  assert.match(body, /Flies as companion/);
  assert.doesNotMatch(body, /checked/, "nothing on this row is ticked");
});

test("a pilot set up as a companion shows the toggle ticked", () => {
  const body = renderRow({
    manage: true,
    squadMenuOpen: true,
    squads: [SQUAD],
    pilot: { ...basePilot(), squads: [SQUAD] },
    companionEnabledFor: () => true,
  });
  assert.match(body, /Flies as companion/);
  assert.match(body, /checked/, "the toggle reflects what is stored");
});

// --- the squad start speaks as the pilot it is starting ---------------------
//
// ⚠ A SOURCE READ, NOT A RENDER, AND THAT IS THE HONEST SHAPE HERE. The squad
// start calls app/api.ts directly, so nothing on these props can observe which
// token it rode; the fact worth pinning is therefore in the source. It is worth
// pinning at all because the wrong token does not throw and does not look
// broken: under R107 every pilot in the tab authenticates as itself, a call made
// with no options falls back to the per-tab cookie, and a squad spanning
// accounts then comes back "Character does not belong to the supplied account"
// for every member but one — with that one refused too, as "A web session is
// flying this character", because /api/bots/start hands over the CALLER's held
// session and the caller was somebody else. Both sentences read like a server
// rule rather than a bug, which is exactly why a regression here would sit
// unnoticed.
test("the squad start speaks as the pilot it is starting, either way", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./PilotHangar.svelte", import.meta.url), "utf8");
  const start = source.match(/startCompanion: async \(characterID, setup\) => \{[\s\S]*?\n {10}\}/);
  assert.ok(start, "the squad start's startCompanion is gone");
  const body = start[0];
  // Signed in HERE: that session's own options, because the start hands that
  // session's hull over. There is no correct call with no options at all.
  assert.match(body, /const held = optionsFor\(characterID\)/);
  assert.match(body, /startServerCompanion\(characterID, setup, grant, held\)/);
  assert.doesNotMatch(body, /startServerCompanion\(characterID, setup, grant\)/);
  // NOT signed in here: sign in as that pilot's own account for the call.
  assert.match(body, /startCompanionFor\(\s*accountNameFor\(characterID\)/);
});

test("App hands the hangar the roster's tokens, not the tab's", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("./App.svelte", import.meta.url), "utf8");
  // `[\s\S]*?` rather than `[^>]*`: the tag's own props hold arrow functions.
  const mount = source.match(/<PilotHangar[\s\S]*?\/>/);
  assert.ok(mount, "App no longer mounts the hangar");
  assert.match(mount[0], /optionsFor=/, "the hangar is mounted without per-pilot tokens");
  assert.match(mount[0], /onHandedOver=/, "the tab would not let go of a handed-over hull");
});

// A slot that is not drawn, or a name its row forgot to import, only shows when it is drawn.
const WING = { id: "squad-1", name: "Wing", color: "#52d9a3" };

test("a plugin's member setting is drawn under a pilot in a squad it is in, and only there", async () => {
  const { registerHangarViews } = await import("./pluginHangarViews.ts");
  const fixture = (await import("./pluginSlotFixture.test-util.svelte")).default;
  registerHangarViews("trader", { squadMemberSetting: fixture as never });
  const open = { manage: true, squadMenuOpen: true, squads: [WING] };
  const pilot = { characterID: 90000001, name: "Ore Farmer", accountName: "Test Account", shipName: "Venture", locationName: "Jita",
    skillPoints: 1, balance: 1, training: "", online: false, pinned: false };
  const inSquad = renderRow({ ...open, pilot: { ...pilot, squads: [WING] } });
  assert.match(inSquad, /plugin-slot-fixture[^>]*>90000001</);
  assert.doesNotMatch(renderRow({ ...open, pilot: { ...pilot, squads: [] } }), /plugin-slot-fixture/);
});

test("a plugin's squad control is drawn on each squad, given its members", async () => {
  const { registerHangarViews } = await import("./pluginHangarViews.ts");
  const fixture = (await import("./pluginSlotFixture.test-util.svelte")).default;
  registerHangarViews("trader", { squadControl: fixture as never });
  setHangarPrefsStorage(storage({
    [PREFS_KEY]: JSON.stringify({ squads: [WING], members: { [WING.id]: [90000001] }, pinnedSquads: [WING.id] }),
  }));
  assert.match(renderHangar(), /plugin-slot-fixture[^>]*>\[90000001\]</);
});
