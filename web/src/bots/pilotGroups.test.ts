// PILOT GROUPS — the Bot Manager's view over the hangar's squads.
//
// The things worth pinning here are the ones a reader would otherwise have to
// trust: that a member already flying is SKIPPED rather than queued to refuse,
// and that "Run here" and "Run on server" reach different sets of pilots.
import test from "node:test";
import assert from "node:assert/strict";

import type { ServerBot } from "../app/api.ts";
import {
  addSquad,
  EMPTY_PREFS,
  type HangarPrefs,
} from "../app/hangarPrefs.ts";
import {
  groupMemberStates,
  groupStartEmptyWords,
  groupStatusWords,
  pilotGroups,
  planGroupLaunch,
  planGroupStop,
  groupCanStop,
  groupRosterWords,
  groupRunStatusWords,
  type GroupMemberState,
} from "./pilotGroups.ts";

// Synthetic throughout: 90000001-and-up mirrors ESI's documented example id.
const PILOT_A = 90000001;
const PILOT_B = 90000002;
const PILOT_C = 90000003;

function serverBot(over: Partial<ServerBot> = {}): ServerBot {
  return {
    botID: "bot-1",
    characterID: PILOT_A,
    characterName: "Sample Pilot One",
    scriptID: "script-1",
    scriptName: "Belt loop",
    scriptRev: 1,
    scriptHash: "hash-1",
    restartSafe: true,
    riskClasses: [],
    maxRuntimeMinutes: 60,
    expiresAt: null,
    status: "running",
    phase: null,
    why: null,
    stepPath: null,
    pauseReason: null,
    note: null,
    startedAt: "2026-09-02T11:00:00.000Z",
    endedAt: null,
    resumedAt: null,
    lastAlert: null,
    kind: "script",
    ...over,
  };
}

function withSquad(
  prefs: HangarPrefs,
  id: string,
  name: string,
  members: readonly number[],
): HangarPrefs {
  return addSquad(prefs, { id, name, color: "#52d9a3" }, members);
}

const NO_ONE_HERE = {
  serverBots: [] as readonly ServerBot[],
  heldCharacterIDs: [] as readonly number[],
  busyHereCharacterIDs: [] as readonly number[],
  nameOf: () => null,
};

// --- the group list ---------------------------------------------------------

test("with no squads there are no groups", () => {
  assert.deepEqual(pilotGroups(EMPTY_PREFS), []);
});

test("every squad becomes a group, in the order the player made them", () => {
  let prefs = withSquad(EMPTY_PREFS, "squad-1", "Mining Op", [PILOT_A, PILOT_B]);
  prefs = withSquad(prefs, "squad-2", "Scout Net", [PILOT_C]);
  const groups = pilotGroups(prefs);
  assert.deepEqual(
    groups.map((group) => group.name),
    ["Mining Op", "Scout Net"],
  );
  assert.deepEqual(groups[0]?.members, [PILOT_A, PILOT_B]);
  assert.equal(groups[0]?.kind, "squad");
});

test("a squad group carries the chip colour", () => {
  const prefs = withSquad(EMPTY_PREFS, "squad-1", "Mining Op", [PILOT_A]);
  const groups = pilotGroups(prefs);
  assert.equal(groups[0]?.color, "#52d9a3");
});

// --- what each member is doing ----------------------------------------------

test("the server's claim wins over a tab that merely holds the login", () => {
  const states = groupMemberStates([PILOT_A], {
    ...NO_ONE_HERE,
    serverBots: [serverBot({ characterID: PILOT_A })],
    heldCharacterIDs: [PILOT_A],
  });
  assert.equal(states[0]?.where, "running-server");
  assert.equal(states[0]?.botName, "Belt loop");
});

test("an ENDED server run is not a claim on the pilot", () => {
  // A finished run keeps appearing in the roster so its last readout stays
  // visible; reading it as a claim would shadow the pilot for ever.
  const states = groupMemberStates([PILOT_A], {
    ...NO_ONE_HERE,
    serverBots: [serverBot({ characterID: PILOT_A, endedAt: "2026-09-02T12:00:00.000Z" })],
  });
  assert.equal(states[0]?.where, "free");
});

test("held, busy-here and free are told apart", () => {
  const states = groupMemberStates([PILOT_A, PILOT_B, PILOT_C], {
    ...NO_ONE_HERE,
    heldCharacterIDs: [PILOT_A, PILOT_B],
    busyHereCharacterIDs: [PILOT_B],
  });
  assert.deepEqual(
    states.map((state) => state.where),
    ["held", "running-here", "free"],
  );
});

test("a pilot this browser has never seen is named, never printed as an id", () => {
  const states = groupMemberStates([PILOT_A], NO_ONE_HERE);
  assert.equal(states[0]?.name, "Unknown pilot");
  assert.doesNotMatch(states[0]!.name, /\d/);
});

// --- what a start would do --------------------------------------------------

function states(
  rows: readonly [number, GroupMemberState["where"]][],
): readonly GroupMemberState[] {
  return rows.map(([characterID, where]) => ({
    characterID,
    name: `Pilot ${characterID % 10}`,
    where,
    botName: null,
  }));
}

test("A PILOT ALREADY FLYING IS SKIPPED, NOT QUEUED TO REFUSE", () => {
  const plan = planGroupLaunch(
    states([
      [PILOT_A, "running-server"],
      [PILOT_B, "free"],
      [PILOT_C, "running-here"],
    ]),
  );
  assert.deepEqual(plan.onServer, [PILOT_B]);
  assert.deepEqual(plan.busy, [PILOT_A, PILOT_C]);
});

test("`here` is a SUBSET of `onServer`, not a disjoint half", () => {
  // A pilot this tab holds can go either way; the difference between the two
  // buttons is what happens when the tab closes, not which pilots they reach.
  const plan = planGroupLaunch(
    states([
      [PILOT_A, "held"],
      [PILOT_B, "free"],
    ]),
  );
  assert.deepEqual(plan.onServer, [PILOT_A, PILOT_B]);
  assert.deepEqual(plan.here, [PILOT_A]);
});

test("the status line counts the group, the busy and the free", () => {
  assert.equal(groupStatusWords([]), "No pilots");
  assert.equal(
    groupStatusWords(
      states([
        [PILOT_A, "running-server"],
        [PILOT_B, "free"],
      ]),
    ),
    "2 pilots - 1 already flying - 1 free",
  );
  assert.equal(groupStatusWords(states([[PILOT_A, "free"]])), "1 pilot - 1 free");
  assert.equal(
    groupStatusWords(states([[PILOT_A, "running-here"]])),
    "1 pilot - 1 already flying - none free",
  );
});

test("with Server unticked, the status says when Start reaches fewer pilots", () => {
  // ⚠ A DISABLED BUTTON WITH NO SENTENCE BESIDE IT READS AS BROKEN.
  const noTabs = planGroupLaunch(states([[PILOT_A, "free"]]));
  assert.equal(groupRunStatusWords(noTabs, false), "No tab open here");
  // Ticked, the server reaches everyone free: nothing to warn about.
  assert.equal(groupRunStatusWords(noTabs, true), "Idle");

  const some = planGroupLaunch(
    states([
      [PILOT_A, "held"],
      [PILOT_B, "free"],
    ]),
  );
  assert.equal(groupRunStatusWords(some, false), "1 of 2 here");
  assert.equal(groupRunStatusWords(planGroupLaunch(states([[PILOT_A, "held"]])), false), "Idle");
});

test("the status counts who is flying before anything else", () => {
  const plan = planGroupLaunch(
    states([
      [PILOT_A, "running-server"],
      [PILOT_B, "running-here"],
      [PILOT_C, "free"],
    ]),
  );
  assert.equal(groupRunStatusWords(plan, false), "2 flying");
});

test("a group Stop reaches only what is flying, whatever kind of server bot it is", () => {
  const bots = [
    serverBot({ botID: "bot-a", characterID: PILOT_A }),
    serverBot({ botID: "bot-b", characterID: PILOT_B, kind: "plugin" }),
  ];
  const rows = states([
    [PILOT_A, "running-server"],
    [PILOT_B, "running-server"],
    [PILOT_C, "running-here"],
  ]);
  const stop = planGroupStop(rows, bots);
  assert.deepEqual(stop.onServer, [
    { characterID: PILOT_A, botID: "bot-a" },
    { characterID: PILOT_B, botID: "bot-b" },
  ]);
  assert.deepEqual(stop.here, [PILOT_C]);
  assert.equal(groupCanStop(stop), true);

  // A plugin's server run is stopped from a group row like any other.
  const onlyPlugin = planGroupStop(states([[PILOT_B, "running-server"]]), bots);
  assert.equal(groupCanStop(onlyPlugin), true);

  // Idle members are not in the plan at all.
  assert.equal(groupCanStop(planGroupStop(states([[PILOT_A, "free"]]), bots)), false);
});

test("the group names its bot once, and per pilot only when they differ", () => {
  const row = (name: string, botName: string | null): GroupMemberState => ({
    characterID: PILOT_A,
    name,
    where: botName === null ? "free" : "running-server",
    botName,
  });
  const same = groupRosterWords([row("One", "Belt loop"), row("Two", "Belt loop"), row("Three", null)]);
  assert.equal(same.names, "One, Two, Three");
  assert.equal(same.commonBot, "Belt loop");

  const mixed = groupRosterWords([row("One", "Belt loop"), row("Two", "Ore haul")]);
  assert.equal(mixed.names, "One (Belt loop), Two (Ore haul)");
  assert.equal(mixed.commonBot, null);

  assert.equal(groupRosterWords([row("One", null)]).commonBot, null);
});

test("the empty sentence names what the player has to go and do", () => {
  // ⚠ AN EMPTY GROUP IS NOT FIXABLE HERE; the sentence says where to go.
  assert.match(groupStartEmptyWords("squad", 0), /no pilots/i);
  assert.match(groupStartEmptyWords("squad", 0), /Pilot Hangar/);
  // A group that HAS members but nobody startable is a third thing again.
  assert.match(groupStartEmptyWords("squad", 3), /already flying/i);
});

test("every sentence this module prints is plain ASCII", () => {
  const words = [
    groupStatusWords([]),
    groupStatusWords(states([[PILOT_A, "running-server"], [PILOT_B, "free"]])),
    groupStartEmptyWords("squad", 0),
    groupStartEmptyWords("squad", 2),
    groupRunStatusWords(planGroupLaunch(states([[PILOT_A, "free"]])), false),
    groupRunStatusWords(planGroupLaunch(states([[PILOT_A, "held"], [PILOT_B, "free"]])), false),
    groupRunStatusWords(planGroupLaunch(states([[PILOT_A, "running-here"]])), true),
  ];
  for (const line of words) {
    assert.match(line, /^[\x20-\x7e]*$/, `not plain ASCII: ${line}`);
  }
});
