// The salvager's lap (salvage-bookmarked-sites): folders taken up, a site picked from one folder, flown to,
// looted and salvaged, its bookmark filed in the other; home to unload when full, and a bounded wait docked when
// no site is left.

import test from "node:test";
import assert from "node:assert/strict";
import type { MacroStep } from "../bots/botScript.ts";
import type { FlightStatus } from "../store/types.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { MacroMemory, ScriptBoard } from "./scriptDecide.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";

const NB: ScriptBoard = {};
const salvager = SCRIPT_MACROS["salvage-bookmarked-sites"]!;

const FROM = 7000001;
const DONE = 7000002;
const HOME = 60000004;
const HERE = 30000142;
const ELSEWHERE = 30000144;
const NEAR_SITE = 9000011;
const FAR_SITE = 9000005;

const step: MacroStep = {
  id: "salvager", kind: "macro", macro: "salvage-bookmarked-sites",
  args: {
    fromFolder: { kind: "bookmarkFolder", folderID: null, name: "To Salvage" },
    doneFolder: { kind: "bookmarkFolder", folderID: null, name: "Salvaged" },
    station: { kind: "station", ref: { entity: "station", id: HOME, name: "Home", systemName: null } },
  },
} as never;

function flight(over: Partial<FlightStatus> = {}): FlightStatus {
  return { inSpace: true, docked: false, solarSystemID: HERE, stationID: null, structureID: null, shipID: 9001, shipTypeID: null, shipIsCapsule: null, shipMode: null, shipSpeedFraction: null, ...over };
}
const dockedHome = flight({ inSpace: false, docked: true, stationID: HOME });

const bothOn = {
  known: [
    { folderID: FROM, name: "To Salvage", isPersonal: false, isActive: true },
    { folderID: DONE, name: "Salvaged", isPersonal: false, isActive: true },
  ],
  addable: [],
};
const sites = [
  { bookmarkID: FAR_SITE, name: "Site", folderID: FROM, solarSystemID: ELSEWHERE },
  { bookmarkID: NEAR_SITE, name: "Site", folderID: FROM, solarSystemID: HERE },
  { bookmarkID: 9000099, name: "Old", folderID: DONE, solarSystemID: HERE },
];

const SHIP = { itemID: 9001, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, activeModuleIDs: [], activeModuleTargets: [], moduleRanges: [] };

function obs(over: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    inSpace: true, docked: false, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    flightStatus: flight(),
    bookmarkFolders: bothOn,
    bookmarks: sites,
    snapshot: { ship: SHIP, entities: [] } as never,
    salvageModuleIDs: [501],
    ...over,
  } as ScriptObservation;
}
const ready: MacroMemory = { foldersReady: true, fromID: FROM, doneID: DONE, unloadChecked: true };

test("salvager: takes its folders up first, by the folder block's own rule", () => {
  const t = salvager(step, obs({ bookmarkFolders: { known: [], addable: [
    { folderID: FROM, name: "To Salvage", isPersonal: false }, { folderID: DONE, name: "Salvaged", isPersonal: false },
  ] } }), {}, NB);
  assert.deepEqual(t.action, { kind: "addKnownFolder", folderID: FROM });
  // Both on: the folders are remembered by their numbers.
  const on = salvager(step, obs(), {}, NB);
  assert.equal(on.nextMem["foldersReady"], true);
  assert.deepEqual([on.nextMem["fromID"], on.nextMem["doneID"]], [FROM, DONE]);
});

test("salvager: takes the OLDEST bookmark first, wherever it is, and warps to it by its number", () => {
  // The far one is older: it goes first, though the near one is in this system.
  const older = [{ ...sites[0]!, ageMs: 900_000 }, { ...sites[1]!, ageMs: 300_000 }, sites[2]!];
  assert.deepEqual(salvager(step, obs({ bookmarks: older }), ready, NB).action, { kind: "startSystemRoute", systemID: ELSEWHERE });
  // The near one older: warped to.
  const nearOlder = [{ ...sites[0]!, ageMs: 300_000 }, { ...sites[1]!, ageMs: 900_000 }, sites[2]!];
  const t = salvager(step, obs({ bookmarks: nearOlder }), ready, NB);
  assert.deepEqual(t.action, { kind: "warpBookmark", bookmarkID: NEAR_SITE });
  assert.equal(t.nextMem["site"], NEAR_SITE);
  // No ages said: by the bookmark's number, made in order.
  assert.equal(salvager(step, obs(), ready, NB).nextMem["site"], FAR_SITE);
});

test("salvager: a bookmark made while it works a site never takes it off that site", () => {
  const working = { ...ready, site: NEAR_SITE, stage: "site", work: { looted: [] } };
  const newer = [{ ...sites[1]!, ageMs: 600_000 }, { bookmarkID: 9000500, name: "New", folderID: FROM, solarSystemID: HERE, ageMs: 10_000 },
    { bookmarkID: 9000001, name: "Even older", folderID: FROM, solarSystemID: ELSEWHERE, ageMs: 5_000_000 }];
  const wreck = { itemID: 4201, kind: "wreck", ownerID: 90000001, corporationID: null, position: { x: 1_000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
  const t = salvager(step, obs({ bookmarks: newer, myCharacterID: 90000001, snapshot: { ship: SHIP, entities: [wreck] } as never }), working, NB);
  assert.equal(t.nextMem["site"], NEAR_SITE);
  assert.deepEqual(t.action, { kind: "lock", targetID: 4201 });
});

test("salvager: already at the site (as after a restart on it), it goes straight to work instead of warping", () => {
  // Seen live 2026-10-16: a restart on the site warped to its own bookmark, refused as too close, over and over.
  const onIt = [{ ...sites[1]!, position: { x: 20_000, y: 0, z: 0 } }];
  const t = salvager(step, obs({ bookmarks: onIt }), ready, NB);
  assert.notEqual(t.action.kind, "warpBookmark");
  assert.equal(t.nextMem["stage"] === "site" || t.action.kind === "moveBookmarks", true);
  // From farther than a warp's least distance, it warps.
  const far = [{ ...sites[1]!, position: { x: 400_000, y: 0, z: 0 } }];
  assert.deepEqual(salvager(step, obs({ bookmarks: far }), ready, NB).action, { kind: "warpBookmark", bookmarkID: NEAR_SITE });
});

test("salvager: a site in another system is travelled to first", () => {
  const t = salvager(step, obs({ bookmarks: [sites[0]!] }), ready, NB);
  assert.deepEqual(t.action, { kind: "startSystemRoute", systemID: ELSEWHERE });
});

test("salvager: on grid with nothing to loot or salvage, the site is finished and its bookmark filed", () => {
  const landed = { ...ready, site: NEAR_SITE, stage: "warp", warp: { issued: true, sawWarp: true } };
  const t = salvager(step, obs(), landed, NB);
  assert.deepEqual(t.action, { kind: "moveBookmarks", fromFolderID: FROM, toFolderID: DONE, bookmarkIDs: [NEAR_SITE] });
  // Still in the from-folder on the next read: wait, then ask again, then stop.
  let mem = t.nextMem;
  const kinds: string[] = [];
  for (let i = 0; i < 9; i++) {
    const again = salvager(step, obs(), mem, NB);
    kinds.push(again.outcome.kind === "blocked" ? "blocked" : again.action.kind);
    if (again.outcome.kind === "blocked") break;
    mem = again.nextMem;
  }
  assert.deepEqual(kinds, ["wait", "wait", "moveBookmarks", "wait", "wait", "moveBookmarks", "wait", "wait", "blocked"]);
});

test("salvager: once the bookmark has left the folder, the next site is picked", () => {
  const filed = { ...ready, site: NEAR_SITE, stage: "file", filing: NEAR_SITE, fileWaits: 0, fileTries: 1 };
  const t = salvager(step, obs({ bookmarks: [sites[0]!, sites[2]!] }), filed, NB);
  assert.deepEqual(t.action, { kind: "startSystemRoute", systemID: ELSEWHERE });
  assert.equal(t.nextMem["site"], FAR_SITE);
});

test("salvager: a hold with no room after looting goes home to unload, keeping the site", () => {
  const looting = { ...ready, site: NEAR_SITE, stage: "site" };
  const full = obs({ holds: [{ key: "cargo", present: true, capacity: { capacity: 100, used: 100 } }] as never });
  const t = salvager(step, full, looting, NB);
  assert.equal(t.nextMem["returning"], true);
  assert.equal(t.nextMem["site"], null);
  const home = salvager(step, full, t.nextMem, NB);
  assert.deepEqual(home.action, { kind: "startRoute", stationID: HOME });
});

test("salvager: no site left in space flies home; docked there it waits, and after a long wait finishes for the next pass", () => {
  const none = obs({ bookmarks: [sites[2]!] });
  assert.deepEqual(salvager(step, none, ready, NB).action, { kind: "startRoute", stationID: HOME });
  const waiting = salvager(step, obs({ bookmarks: [sites[2]!], flightStatus: dockedHome }), ready, NB);
  assert.equal(waiting.action.kind, "wait");
  assert.equal(waiting.outcome.kind, "acting");
  const long = salvager(step, obs({ bookmarks: [sites[2]!], flightStatus: dockedHome }), { ...ready, idle: 749 }, NB);
  assert.equal(long.outcome.kind, "done");
});

test("salvager: a site bookmarked while it flies home with nothing to do turns it round; a trip home to unload does not", () => {
  // Seen live 2026-10-16: a bookmark made seconds after the salvager left was flown home, docked, and only then gone back for.
  const none = obs({ bookmarks: [sites[2]!] });
  const leaving = salvager(step, none, ready, NB);
  assert.deepEqual(leaving.action, { kind: "startRoute", stationID: HOME });
  assert.equal(leaving.nextMem["idleHome"], true);
  const homeward = { status: "running", destinationStationID: HOME, destinationSystemID: null, failureReason: null };
  // The autopilot still has it: stopped first, the site in this system then warped to from here.
  const turn = salvager(step, obs({ bookmarks: [sites[1]!], travel: homeward as never }), leaving.nextMem, NB);
  assert.deepEqual(turn.action, { kind: "stopRoute" });
  assert.equal(turn.nextMem["returning"], false);
  const onward = salvager(step, obs({ bookmarks: [sites[1]!] }), turn.nextMem, NB);
  assert.notDeepEqual(onward.action, { kind: "startRoute", stationID: HOME });
  assert.equal(onward.nextMem["site"], NEAR_SITE);
  // Full: home it goes, whatever is bookmarked meanwhile.
  const full = obs({ holds: [{ key: "cargo", present: true, capacity: { capacity: 100, used: 100 } }] as never });
  const unloadTrip = salvager(step, full, { ...ready, site: NEAR_SITE, stage: "site" }, NB);
  const stillHome = salvager(step, obs({ ...full, travel: homeward as never }), salvager(step, full, unloadTrip.nextMem, NB).nextMem, NB);
  assert.deepEqual(stillHome.action.kind === "stopRoute", false);
  assert.equal(stillHome.nextMem["returning"], true);
});

test("salvager: docked at its station it empties the hold first, then leaves for a site", () => {
  const atHome = obs({ flightStatus: dockedHome, cargo: { rows: [] } as never, shipBays: [] });
  const first = salvager(step, atHome, { ...ready, unloadChecked: false }, NB);
  assert.equal(first.nextMem["unloading"], true);
  const unloaded = salvager(step, atHome, first.nextMem, NB);
  assert.deepEqual(unloaded.action, { kind: "undock" });
  // Cargo aboard: unloaded into the hangar first.
  const laden = obs({ flightStatus: dockedHome, cargo: { rows: [{ itemID: 77, typeID: 25590, quantity: 3, groupID: 754 }] } as never, shipBays: [] });
  const unload = salvager(step, laden, first.nextMem, NB);
  assert.equal(unload.action.kind, "unloadHolds");
});

test("salvager: a ship with wrecks before it and no way to salvage stops with a sentence", () => {
  // Another player's wreck: ours to salvage, not to loot, and nothing aboard salvages.
  const wreck = { itemID: 4001, kind: "wreck", ownerID: 90000555, corporationID: 98999955, position: { x: 0, y: 0, z: 0 } };
  const t = salvager(step, obs({ salvageModuleIDs: [], snapshot: { ship: SHIP, entities: [wreck] } as never }), { ...ready, site: NEAR_SITE, stage: "site" }, NB);
  assert.equal(t.outcome.kind, "blocked");
});

test("salvager: the same folder twice is refused", () => {
  const same: MacroStep = { ...step, args: { ...step.args, doneFolder: step.args["fromFolder"]! } } as never;
  const t = salvager(same, obs({ bookmarkFolders: { known: [bothOn.known[0]!], addable: [] } }), {}, NB);
  assert.equal(t.outcome.kind, "blocked");
});

test("loot: a wreck left by a member of the pilot's PLAYER corporation is the pilot's to open; in an NPC corporation it is not", () => {
  const loot = SCRIPT_MACROS["loot-wrecks"]!;
  const lootStep: MacroStep = { id: "loot", kind: "macro", macro: "loot-wrecks", args: {} } as never;
  const PLAYER_CORP = 98999901;
  const NPC_CORP = 1000044;
  const mate = (corporationID: number) => ({ itemID: 4002, kind: "wreck", ownerID: 90000002, corporationID, position: { x: 0, y: 0, z: 0 } });
  const seen = (myCorporationID: number, corporationID: number) =>
    loot(lootStep, obs({ myCharacterID: 90000001, myCorporationID, snapshot: { ship: null, entities: [mate(corporationID)] } as never }), {}, NB).outcome.kind;
  assert.notEqual(seen(PLAYER_CORP, PLAYER_CORP), "done");
  assert.equal(seen(NPC_CORP, NPC_CORP), "done");
  assert.equal(seen(PLAYER_CORP, 98999902), "done");
});

test("salvager: a bookmark made just now is set out for at once; only the warp to it waits for it to open", () => {
  const young = [{ bookmarkID: NEAR_SITE, name: "Site", folderID: FROM, solarSystemID: HERE, ageMs: 30_000 }];
  // Docked: leaves at once.
  assert.deepEqual(salvager(step, obs({ bookmarks: young, flightStatus: dockedHome }), ready, NB).action, { kind: "undock" });
  // In another system: travels at once.
  assert.deepEqual(salvager(step, obs({ bookmarks: [{ ...young[0]!, solarSystemID: ELSEWHERE }] }), ready, NB).action, { kind: "startSystemRoute", systemID: ELSEWHERE });
  // In its system: waits for it to open, neither warping nor going home.
  const waits = salvager(step, obs({ bookmarks: young }), ready, NB);
  assert.equal(waits.action.kind, "wait");
  assert.match(waits.why, /opens to this pilot/);
  // Open: warped to.
  const opened = salvager(step, obs({ bookmarks: [{ ...young[0]!, ageMs: 200_000 }] }), waits.nextMem, NB);
  assert.deepEqual(opened.action, { kind: "warpBookmark", bookmarkID: NEAR_SITE });
});

test("on site: a far wreck of ours gets a tractor beam (no lock); one in reach is locked, looted while the lock lands, then salvaged", () => {
  const TRACTOR = 601;
  const SALVAGER = 602;
  const onSite = { ...ready, site: NEAR_SITE, stage: "site" };
  const wreck = (itemID: number, x: number) => ({ itemID, kind: "wreck", ownerID: 90000001, corporationID: null, position: { x, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
  const grid = (entities: unknown[], ship = SHIP, over: Partial<ScriptObservation> = {}) => obs({
    myCharacterID: 90000001, myCorporationID: 98999901, tractorModuleIDs: [TRACTOR], salvageModuleIDs: [SALVAGER], maxLockedTargets: 3, maxTargetRangeM: 30_000,
    lockedTargetIDs: [], snapshot: { ship: { ...ship, moduleRanges: [{ moduleID: TRACTOR, rangeM: 40_000 }, { moduleID: SALVAGER, rangeM: 6_000 }] }, entities } as never, ...over,
  });

  const far = salvager(step, grid([wreck(4101, 15_000)]), onSite, NB);
  assert.deepEqual(far.action, { kind: "activate", moduleID: TRACTOR, targetID: 4101 });

  const lock = salvager(step, grid([wreck(4102, 1_500)]), onSite, NB);
  assert.deepEqual(lock.action, { kind: "lock", targetID: 4102 });
  // The lock on its way: looted meanwhile.
  const loot = salvager(step, grid([wreck(4102, 1_500)]), lock.nextMem, NB);
  assert.deepEqual(loot.action, { kind: "lootWreck", wreckID: 4102 });
  // Locked: the salvager goes on it (a wreck still holding loot leaves a can with it).
  const salvage = salvager(step, grid([wreck(4102, 1_500)], SHIP, { lockedTargetIDs: [4102] }), loot.nextMem, NB);
  assert.deepEqual(salvage.action, { kind: "activate", moduleID: SALVAGER, targetID: 4102 });
});

test("on site: a wreck whose lock never takes is left after three tries, and the rest of the site goes on", () => {
  // Seen live 2026-10-16: one wreck's lock refused (TargetingAttemptCancelled) every few seconds for minutes.
  const wreck = (itemID: number, x: number) => ({ itemID, kind: "wreck", ownerID: 90000001, corporationID: null, position: { x, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
  const stubborn = wreck(4401, 1_000);
  const grid = (entities: unknown[], locked: number[] = []) => obs({
    myCharacterID: 90000001, salvageModuleIDs: [602], tractorModuleIDs: [], maxLockedTargets: 3, maxTargetRangeM: 30_000,
    lockedTargetIDs: locked, snapshot: { ship: SHIP, entities } as never,
  });
  let mem: MacroMemory = { ...ready, site: NEAR_SITE, stage: "site", work: { looted: [4401] } };
  for (let k = 0; k < 3; k++) {
    const t = salvager(step, grid([stubborn]), { ...mem, work: { ...(mem["work"] as MacroMemory), pending: {} } }, NB);
    assert.deepEqual(t.action, { kind: "lock", targetID: 4401 }, `try ${k + 1}`);
    mem = t.nextMem;
  }
  // The fourth time it is let be: another wreck is locked instead, and with none the site is finished.
  const other = salvager(step, grid([stubborn, wreck(4402, 1_200)]), { ...mem, work: { ...(mem["work"] as MacroMemory), pending: {} } }, NB);
  assert.deepEqual(other.action, { kind: "lock", targetID: 4402 });
  const alone = salvager(step, grid([stubborn]), { ...mem, work: { ...(mem["work"] as MacroMemory), pending: {} } }, NB);
  assert.deepEqual(alone.action, { kind: "moveBookmarks", fromFolderID: FROM, toFolderID: DONE, bookmarkIDs: [NEAR_SITE] });
});

test("on site: a beam whose can never comes nearer is switched off and taken again; after a second stall the ship goes to the can", () => {
  // Seen live 2026-10-16: a beam cycled on a can for five minutes, the can never moved, and the salvager held position.
  const TRACTOR = 601;
  const can = { itemID: 4501, kind: "container", ownerID: 90000001, corporationID: null, position: { x: 3_300, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
  const grid = (beamOn: boolean) => obs({
    myCharacterID: 90000001, tractorModuleIDs: [TRACTOR], salvageModuleIDs: [], maxLockedTargets: 3, maxTargetRangeM: 30_000, lockedTargetIDs: [],
    snapshot: { ship: { ...SHIP, activeModuleIDs: beamOn ? [TRACTOR] : [], activeModuleTargets: beamOn ? [{ moduleID: TRACTOR, targetID: 4501 }] : [],
      moduleRanges: [{ moduleID: TRACTOR, rangeM: 40_000 }] }, entities: [can] } as never,
  });
  let mem: MacroMemory = { ...ready, site: NEAR_SITE, stage: "site", work: { looted: [] } };
  const run = (beamOn: boolean) => { const t = salvager(step, grid(beamOn), mem, NB); mem = t.nextMem; return t; };
  assert.deepEqual(run(false).action, { kind: "activate", moduleID: TRACTOR, targetID: 4501 });
  // Running, the can not moving: a few ticks of patience, then off and on again.
  const untilActs = () => {
    for (let k = 0; k < 10; k++) {
      const t = run(true);
      if (t.action.kind !== "wait") return { t, waited: k };
    }
    throw new Error("the beam was never switched off");
  };
  const first = untilActs();
  assert.equal(first.waited, 5);
  assert.deepEqual(first.t.action, { kind: "salvageBatch", steps: [{ kind: "deactivate", moduleID: TRACTOR }, { kind: "activate", moduleID: TRACTOR, targetID: 4501 }] });
  // A second stall: the can is not tractored again, and the ship goes to it.
  const second = untilActs();
  assert.deepEqual(second.t.action, { kind: "deactivate", moduleID: TRACTOR });
  const after = run(false);
  assert.equal(after.action.kind, "gotoPoint");
});

test("on site: a tractor beam whose wreck has arrived is switched off, so it can take the next", () => {
  const TRACTOR = 601;
  const onSite = { ...ready, site: NEAR_SITE, stage: "site", work: { looted: [4103] } };
  const arrived = { itemID: 4103, kind: "wreck", ownerID: 90000001, corporationID: null, position: { x: 600, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
  const t = salvager(step, obs({
    myCharacterID: 90000001, tractorModuleIDs: [TRACTOR], salvageModuleIDs: [602], maxLockedTargets: 3, maxTargetRangeM: 30_000, lockedTargetIDs: [],
    snapshot: { ship: { ...SHIP, activeModuleIDs: [TRACTOR], activeModuleTargets: [{ moduleID: TRACTOR, targetID: 4103 }], moduleRanges: [{ moduleID: TRACTOR, rangeM: 40_000 }] }, entities: [arrived] } as never,
  }), onSite, NB);
  // Looted already and inside salvage reach: the beam is let go, and in the same tick the wreck is locked for the salvager.
  assert.deepEqual(t.action, { kind: "salvageBatch", steps: [{ kind: "deactivate", moduleID: TRACTOR }, { kind: "lock", targetID: 4103 }] });
});

test("on site: a corp-mate's wreck, ours by its loot rights with no fleet, is looted while its lock lands", () => {
  const onSite = { ...ready, site: NEAR_SITE, stage: "site", work: { looted: [] } };
  const mates = { itemID: 4301, kind: "wreck", ownerID: 90000002, corporationID: 98999901, lootRights: { ownerID: 90000002, corpID: 98999901, fleetID: null, abandoned: false },
    position: { x: 1_000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } };
  const mine = obs({ myCharacterID: 90000001, myCorporationID: 98999901, snapshot: { ship: SHIP, entities: [mates] } as never });
  const t = salvager(step, mine, onSite, NB);
  assert.deepEqual(t.action, { kind: "lock", targetID: 4301 });
  assert.deepEqual(salvager(step, mine, t.nextMem, NB).action, { kind: "lootWreck", wreckID: 4301 });
  // A stranger's (another player corporation's) is salvaged, never opened.
  const strangers = { ...mates, itemID: 4302, ownerID: 90000777, corporationID: 98999977, lootRights: { ownerID: 90000777, corpID: 98999977, fleetID: null, abandoned: false } };
  const s = salvager(step, obs({ myCharacterID: 90000001, myCorporationID: 98999901, lockedTargetIDs: [], snapshot: { ship: SHIP, entities: [strangers] } as never }), onSite, NB);
  assert.notEqual(s.action.kind, "lootWreck");
});

test("on site: every idle tractor beam is put on its own far wreck in ONE tick, as a pilot clicks them", () => {
  const onSite = { ...ready, site: NEAR_SITE, stage: "site", work: { looted: [] } };
  const far = (itemID: number, x: number) => ({ itemID, kind: "wreck", ownerID: 90000001, corporationID: null, position: { x, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } });
  const t = salvager(step, obs({
    myCharacterID: 90000001, tractorModuleIDs: [601, 602, 603], salvageModuleIDs: [], maxLockedTargets: 5, maxTargetRangeM: 30_000, lockedTargetIDs: [],
    snapshot: { ship: { ...SHIP, moduleRanges: [601, 602, 603].map((moduleID) => ({ moduleID, rangeM: 40_000 })) }, entities: [far(4401, 8_000), far(4402, 9_000), far(4403, 10_000)] } as never,
  }), onSite, NB);
  assert.deepEqual(t.action, { kind: "salvageBatch", steps: [
    { kind: "activate", moduleID: 601, targetID: 4401 }, { kind: "activate", moduleID: 602, targetID: 4402 }, { kind: "activate", moduleID: 603, targetID: 4403 }] });
});
