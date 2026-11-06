// WHAT A BOT NEEDS BEFORE IT WILL START (goal R43).
//
// Every case here is pure: the requirements are functions over injected reads,
// so nothing in this file needs a server, a session or a clock. That is the
// whole reason they were built that way.
//
// The three properties worth the file:
//
//   1. CANNOT-TELL DOES NOT PASS. A failed read is not a read that said yes.
//   2. A MINING MODULE IS A HIGH-SLOT MODULE. Pinned against Farmer's real
//      Procurer, whose two Strip Miner Is sit at flags 27 and 28 and whose two
//      decoys — an Ice Harvester Upgrade (LOW slot) and an Ice Harvester
//      Accelerator (RIG) — are unreachable from a high-slot filter.
//   3. BLOCKING vs ADVISORY is the difference between a launcher and a
//      launcher that is narrower than the bot it launches.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BOTS,
  BOT_IDS,
  MINING_BOT_REQUIREMENTS,
  MISSION_BOT_REQUIREMENTS,
  createShipClaim,
  evaluateRequirements,
  holdsTheShip,
  type BotID,
  type MiningBotReads,
  type MissionBotReads,
} from "./botRegistry.ts";
import {
  activatableModules,
  highSlotMiningModules,
  miningModules,
  ungroupedHighSlotModules,
} from "../space/rowActions.ts";
import { BOT_ADVISORY_TEXTS, isPlainPlayerLanguage } from "../bridge/refusals.ts";
import { PROCURER_MODULES, STRIP_MINER_ITEM_IDS } from "../app/botFixtures.ts";

// --- The reads a healthy world produces -------------------------------------

const READY_TO_MINE: MiningBotReads = {
  inSpace: true,
  minersFitted: 2,
  minersOnline: 2,
  beltChosen: true,
  stationChosen: true,
  holdHasRoom: true,
};

const READY_FOR_MISSIONS: MissionBotReads = {
  docked: true,
  agentChosen: true,
  agentStationKnown: true,
};

function miningRow(id: string, reads: MiningBotReads) {
  const row = evaluateRequirements(MINING_BOT_REQUIREMENTS, reads).rows.find((r) => r.id === id);
  assert.ok(row, `no requirement called ${id}`);
  return row;
}

// --- 1. the happy path ------------------------------------------------------

test("a ship that meets everything can start, and no requirement wears a reason", () => {
  const mining = evaluateRequirements(MINING_BOT_REQUIREMENTS, READY_TO_MINE);
  assert.equal(mining.canStart, true);
  assert.deepEqual(mining.blockers, []);
  assert.equal(mining.blockedBy, null);
  for (const row of mining.rows) {
    assert.equal(row.verdict, "met", `${row.id} should be met`);
    assert.equal(row.reason, null, `${row.id} should carry no reason when met`);
  }

  const mission = evaluateRequirements(MISSION_BOT_REQUIREMENTS, READY_FOR_MISSIONS);
  assert.equal(mission.canStart, true);
});

// --- 2. cannot-tell must not pass -------------------------------------------

test("an UNREADABLE fit blocks the start — cannot-tell is not permission", () => {
  const preflight = evaluateRequirements(MINING_BOT_REQUIREMENTS, {
    ...READY_TO_MINE,
    minersFitted: null,
    minersOnline: null,
  });
  assert.equal(preflight.canStart, false, "a fit nobody could read must not start a bot");
  const row = preflight.rows.find((r) => r.id === "mining-equipment")!;
  assert.equal(row.verdict, "cannot-tell");
  assert.match(String(row.reason), /could not read what is fitted/i);
});

test("cannot-tell and not-met are DIFFERENT sentences — they send a player to different places", () => {
  const unreadable = miningRow("mining-equipment", {
    ...READY_TO_MINE,
    minersFitted: null,
    minersOnline: null,
  });
  const none = miningRow("mining-equipment", {
    ...READY_TO_MINE,
    minersFitted: 0,
    minersOnline: 0,
  });

  assert.equal(unreadable.verdict, "cannot-tell");
  assert.equal(none.verdict, "not-met");
  assert.notEqual(
    unreadable.reason,
    none.reason,
    "'we could not look' must never be reported as 'you have none'",
  );
  // The not-met sentence names the remedy: nothing is fitted, so it is a
  // FITTING problem, and it says so rather than sending them to power something
  // up that does not exist.
  assert.match(String(none.reason), /no mining equipment fitted/i);
  assert.match(String(none.reason), /Fitting/);
  // The cannot-tell sentence claims nothing about the ship.
  assert.doesNotMatch(String(unreadable.reason), /no mining equipment fitted/i);
});

test("a cannot-tell on an ADVISORY requirement does not block — it has nothing to block", () => {
  // Where the ship is cannot stop a start that the ladder resolves itself, so
  // failing to read it cannot either. It is still SHOWN as unknown rather than
  // quietly rendered as met.
  const preflight = evaluateRequirements(MINING_BOT_REQUIREMENTS, {
    ...READY_TO_MINE,
    inSpace: null,
    holdHasRoom: null,
  });
  assert.equal(preflight.canStart, true);
  assert.equal(preflight.rows.find((r) => r.id === "in-space")!.verdict, "cannot-tell");
  assert.equal(preflight.rows.find((r) => r.id === "hold-room")!.verdict, "cannot-tell");
});

// --- 3. each blocking requirement actually blocks ---------------------------

test("every BLOCKING requirement, on its own, stops the start and says which one failed", () => {
  const cases: ReadonlyArray<readonly [string, MiningBotReads]> = [
    ["mining-equipment", { ...READY_TO_MINE, minersFitted: 0, minersOnline: 0 }],
    ["mining-equipment-on", { ...READY_TO_MINE, minersFitted: 2, minersOnline: 0 }],
    ["belt", { ...READY_TO_MINE, beltChosen: false }],
    ["station", { ...READY_TO_MINE, stationChosen: false }],
  ];
  for (const [id, reads] of cases) {
    const preflight = evaluateRequirements(MINING_BOT_REQUIREMENTS, reads);
    assert.equal(preflight.canStart, false, `${id} should have blocked the start`);
    assert.equal(preflight.blockers.length, 1, `${id} should be the ONLY blocker`);
    const row = preflight.rows.find((r) => r.id === id)!;
    assert.equal(row.verdict, "not-met");
    assert.equal(preflight.blockedBy, row.reason, "the control wears that requirement's own words");
  }
});

test("the mission bot blocks on a missing agent, not on where the ship happens to be", () => {
  const noAgent = evaluateRequirements(MISSION_BOT_REQUIREMENTS, {
    ...READY_FOR_MISSIONS,
    agentChosen: false,
  });
  assert.equal(noAgent.canStart, false);
  assert.match(String(noAgent.blockedBy), /pick the agent/i);

  // ⚠ THE ONE THAT WOULD HAVE BEEN A BUG. missionBotLoop.ts:552 flies the ship
  // to the station it needs, so refusing to start an undocked mission bot would
  // make the launcher narrower than the bot — the exact failure MissionBot.svelte
  // records having fixed once already.
  const inSpace = evaluateRequirements(MISSION_BOT_REQUIREMENTS, {
    ...READY_FOR_MISSIONS,
    docked: false,
  });
  assert.equal(inSpace.canStart, true, "the bot flies there itself; the launcher must not refuse");
  const row = inSpace.rows.find((r) => r.id === "docked")!;
  assert.equal(row.verdict, "not-met");
  assert.equal(row.severity, "advisory");
  assert.match(String(row.reason), /will fly to the station/i);
});

test("a docked mining bot is not refused either — it unloads and undocks itself", () => {
  // miningBotLoop.ts:422. The live-proven restart-while-docked path.
  const preflight = evaluateRequirements(MINING_BOT_REQUIREMENTS, {
    ...READY_TO_MINE,
    inSpace: false,
    holdHasRoom: false,
  });
  assert.equal(preflight.canStart, true);
  assert.match(
    String(preflight.rows.find((r) => r.id === "in-space")!.reason),
    /unload anything aboard and undock/i,
  );
});

// --- 4. A MINER IS A HIGH-SLOT MODULE ---------------------------------------

/** Farmer's real Procurer as decoded slots, with power state per module. */
function procurerSlots(online: (itemID: number) => boolean = () => true) {
  return PROCURER_MODULES.map((row) => ({
    // The real flag ranges from bridge/fitting.ts: high 27-34, mid 19-26,
    // low 11-18, rig 92-99.
    family:
      row.flagID >= 92 ? "rig" : row.flagID >= 27 ? "high" : row.flagID >= 19 ? "mid" : "low",
    module: { itemID: row.itemID, typeID: row.typeID, online: online(row.itemID) },
  }));
}

const procurerName = (typeID: number): string | null =>
  PROCURER_MODULES.find((row) => row.typeID === typeID)?.name ?? null;

// R47 — the GAME'S GROUP for each module, as /api/names (typeGroup) resolves it.
// The Strip Miners are group "Strip Miner"; the decoys are "Mining Upgrade" and
// "Rig Resource Processing", neither a mining group.
const procurerGroup = (typeID: number): string | null =>
  PROCURER_MODULES.find((row) => row.typeID === typeID)?.groupName ?? null;

test("R43/R47 — a mining module is a HIGH SLOT module in a MINING GROUP", () => {
  const miners = highSlotMiningModules(procurerSlots(), procurerName, procurerGroup);
  assert.deepEqual(
    [...miners].map((row) => row.itemID).sort(),
    [...STRIP_MINER_ITEM_IDS].sort(),
    "only the two Strip Miner Is, both high-slot, count",
  );
  // Farmer's live Procurer puts them at flags 27 and 28 — both high. This is
  // the real measurement the rule rests on, not an assumption.
  for (const id of STRIP_MINER_ITEM_IDS) {
    const flag = PROCURER_MODULES.find((row) => row.itemID === id)!.flagID;
    assert.ok(flag >= 27 && flag <= 34, `a Strip Miner sat at flag ${flag}, which is not a high slot`);
  }
});

test("R43/R47 — the decoys vanish BY CONSTRUCTION, by slot AND by group", () => {
  const miners = highSlotMiningModules(procurerSlots(), procurerName, procurerGroup);

  // Both decoys carry a mining-family WORD in their name — exactly what the old
  // name guess tripped on...
  for (const decoy of ["Ice Harvester Upgrade II", "Medium Ice Harvester Accelerator I"]) {
    assert.match(decoy, /harvester/i);
    assert.equal(
      miners.some((row) => row.label === decoy),
      false,
      `${decoy} must not count as a miner`,
    );
  }
  // ...and each is excluded TWICE over now. By SLOT: one is a LOW slot module,
  // the other a RIG, so neither is reachable from a high-slot filter. And by
  // GROUP: the game files them as "Mining Upgrade" and "Rig Resource
  // Processing", neither of which is a mining group.
  const upgrade = PROCURER_MODULES.find((r) => r.name === "Ice Harvester Upgrade II")!;
  const rig = PROCURER_MODULES.find((r) => r.name === "Medium Ice Harvester Accelerator I")!;
  assert.ok(upgrade.flagID >= 11 && upgrade.flagID <= 18, "the Upgrade is a low slot module");
  assert.ok(rig.flagID >= 92 && rig.flagID <= 99, "the Accelerator is a rig");
  assert.equal(upgrade.groupName, "Mining Upgrade");
  assert.equal(rig.groupName, "Rig Resource Processing");
});

test("R43 — a hull with ONLY the decoys reports NO miner, and cannot start the bot", () => {
  const slots = procurerSlots().filter(
    (slot) => !STRIP_MINER_ITEM_IDS.includes(slot.module.itemID),
  );
  const fitted = highSlotMiningModules(slots, procurerName, procurerGroup).length;
  assert.equal(fitted, 0, "an Ice Harvester Upgrade and an Ice Harvester rig are not miners");

  const preflight = evaluateRequirements(MINING_BOT_REQUIREMENTS, {
    ...READY_TO_MINE,
    minersFitted: fitted,
    minersOnline: 0,
  });
  assert.equal(preflight.canStart, false);
  assert.match(String(preflight.blockedBy), /no mining equipment fitted/i);
});

test("R43 — FITTED but SWITCHED OFF is a different answer from NOT FITTED", () => {
  // The same hull, miners powered down. They are still fitted, so the player is
  // one click away — and the sentence must send them to that click rather than
  // to the Fitting tab.
  const slots = procurerSlots((id) => !STRIP_MINER_ITEM_IDS.includes(id));
  const miners = highSlotMiningModules(slots, procurerName, procurerGroup);
  assert.equal(miners.length, 2, "they are still fitted");
  assert.equal(miners.filter((row) => row.online).length, 0, "and both are off");

  const preflight = evaluateRequirements(MINING_BOT_REQUIREMENTS, {
    ...READY_TO_MINE,
    minersFitted: 2,
    minersOnline: 0,
  });
  assert.equal(preflight.canStart, false);
  assert.match(String(preflight.blockedBy), /fitted but not switched on/i);
  assert.doesNotMatch(
    String(preflight.blockedBy),
    /no mining equipment fitted/i,
    "a switched-off miner must never be reported as a missing one",
  );
  // And only ONE of the two requirements fails: the "is it fitted" line is met,
  // so the player is given one problem rather than two contradictory ones.
  assert.equal(preflight.blockers.length, 1);
  assert.equal(preflight.rows.find((r) => r.id === "mining-equipment")!.verdict, "met");
});

test("R43/R47 — an UNRESOLVED-GROUP high-slot module poisons the count rather than reading as 'not a miner'", () => {
  // Nobody has resolved the GROUP of what is in the high slots. Any one of them
  // could be a Strip Miner, so the honest answer is "cannot tell" — and
  // cannot-tell does not start a bot. (The name may be known; the group is what
  // decides now, so an unresolved group alone is enough to poison the count.)
  const ungrouped = ungroupedHighSlotModules(procurerSlots(), procurerName, () => null);
  assert.equal(ungrouped.length, 2, "both high-slot modules have no resolved group");
  assert.equal(highSlotMiningModules(procurerSlots(), procurerName, () => null).length, 0);

  const preflight = evaluateRequirements(MINING_BOT_REQUIREMENTS, {
    ...READY_TO_MINE,
    minersFitted: null,
    minersOnline: null,
  });
  assert.equal(preflight.canStart, false);
  assert.match(String(preflight.blockedBy), /could not read what is fitted/i);
});

test("R43 — the preflight can never be MORE OPTIMISTIC than the bot's own module list", () => {
  // ⚠ THE PROPERTY THAT MATTERS. The loop switches on
  // `miningModules(activatableModules(...))`; this check clears a start on
  // `highSlotMiningModules(...)`. If the second could ever be non-empty while
  // the first was empty, the preflight would wave through a hull the bot cannot
  // mine with — it would start and immediately pause. Intersecting with the
  // loop's own predicate makes it a strict subset by construction.
  const slots = procurerSlots();
  const botWouldRun = miningModules(activatableModules(slots, procurerName, procurerGroup)).map(
    (r) => r.itemID,
  );
  const preflightCounts = highSlotMiningModules(slots, procurerName, procurerGroup)
    .filter((row) => row.online)
    .map((r) => r.itemID);
  for (const id of preflightCounts) {
    assert.ok(
      botWouldRun.includes(id),
      "the preflight counted a module the bot would not switch on",
    );
  }
});

// --- 5. the exclusion machinery ---------------------------------------------

test("createShipClaim stops every OTHER bot and never the one claiming", () => {
  const stopped: string[] = [];
  const claim = createShipClaim({
    mining: () => stopped.push("mining"),
    mission: () => stopped.push("mission"),
    custom: () => stopped.push("custom"),
  });

  claim("mining");
  assert.deepEqual(
    stopped,
    ["mission", "custom"],
    "claiming for mining stops every other controller",
  );

  stopped.length = 0;
  claim("mission");
  assert.deepEqual(
    stopped,
    ["mining", "custom"],
    "and the reverse — the property is symmetric by construction",
  );

  stopped.length = 0;
  claim("custom");
  assert.deepEqual(
    stopped,
    ["mining", "mission"],
    "a player-authored bot owns the same exclusive ship claim",
  );
});

test("the claim walks the REGISTRY, so a bot added to it is stopped without touching the claim", () => {
  // A stand-in for the fourth bot: the same generic machinery, one more id.
  // This is the property the two hand-written lines could not have.
  const stopped: string[] = [];
  const stop: Record<string, () => void> = {};
  const ids = ["mining", "mission", "hauling"];
  for (const id of ids) {
    stop[id] = () => stopped.push(id);
  }
  const claimAll = (claimant: string): void => {
    for (const other of ids) {
      if (other !== claimant) stop[other]!();
    }
  };
  claimAll("hauling");
  assert.deepEqual(stopped.sort(), ["mining", "mission"], "a new bot stops both existing ones");
});

test("a PAUSED bot still holds the ship", () => {
  assert.equal(holdsTheShip("running"), true);
  assert.equal(holdsTheShip("paused"), true, "paused is one press from issuing orders again");
  assert.equal(holdsTheShip("idle"), false);
  assert.equal(holdsTheShip("stopped"), false);
  assert.equal(holdsTheShip("error"), false);
});

// --- 6. the catalogue itself ------------------------------------------------

test("every registered bot is in the catalogue exactly once, described in player language", () => {
  assert.deepEqual(
    BOTS.map((row) => row.id).sort(),
    [...BOT_IDS].sort(),
    "the catalogue and the id union cannot drift apart",
  );
  const names = new Set<string>();
  for (const bot of BOTS) {
    assert.ok(bot.name.trim().length > 0);
    assert.equal(names.has(bot.name), false, `two bots share the name ${bot.name}`);
    names.add(bot.name);
    assert.ok(bot.requirementTitles.length > 0, `${bot.id} declares no requirements`);
    // R7d — nothing in the catalogue may carry a numeric id.
    assert.doesNotMatch(`${bot.name} ${bot.summary}`, /\d{4,}/);
  }
});

test("R9a — every requirement sentence is plain player language", () => {
  const sentences = [
    ...MINING_BOT_REQUIREMENTS,
    ...MISSION_BOT_REQUIREMENTS,
  ].flatMap((row) => [row.title, row.unmet, row.cannotTell]);
  assert.ok(sentences.length > 0);
  for (const sentence of [...sentences, ...BOT_ADVISORY_TEXTS]) {
    assert.ok(
      isPlainPlayerLanguage(sentence),
      `not something a player can read: ${sentence}`,
    );
    // R7d — and no numeric id ever reaches one.
    assert.doesNotMatch(sentence, /\d{4,}/, `numeric id leaked: ${sentence}`);
  }
});

test("each bot's requirements have distinct ids and at least one that can block", () => {
  const lists: ReadonlyArray<readonly [BotID, readonly { id: string; severity: string }[]]> = [
    ["mining", MINING_BOT_REQUIREMENTS],
    ["mission", MISSION_BOT_REQUIREMENTS],
  ];
  for (const [id, requirements] of lists) {
    const ids = requirements.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, `${id} declares a duplicate requirement id`);
    assert.ok(
      requirements.some((row) => row.severity === "blocking"),
      `${id} has no blocking requirement — nothing could ever refuse a start`,
    );
  }
});
