// The use-bookmark-folders block: a shared folder a pilot may use is seen only once the pilot has added it and
// switched it on (bridge/bookmarkFolders.ts), so the block adds, switches on, and makes room under the limit.

import test from "node:test";
import assert from "node:assert/strict";
import type { MacroStep } from "../bots/botScript.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import type { ScriptBoard } from "./scriptDecide.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";

const NB: ScriptBoard = {};
const use = SCRIPT_MACROS["use-bookmark-folders"]!;

const TO_SALVAGE = 7000001;
const SALVAGED = 7000002;
const OTHER = 7000003;
const ANOTHER = 7000004;
const THIRD = 7000005;
const PERSONAL = 7000009;

function obs(bookmarkFolders: ScriptObservation["bookmarkFolders"]): ScriptObservation {
  return {
    inSpace: false, docked: true, inWarp: false,
    shieldRatio: 1, armorRatio: 1, hullRatio: 1, health: 1,
    oreHoldFraction: 0, holdEmpty: true, hostileOnGrid: false, dronesOut: false,
    bookmarkFolders,
  } as ScriptObservation;
}

const folder = (name: string, folderID: number | null = null) => ({ kind: "bookmarkFolder" as const, folderID, name });
function step(args: Record<string, unknown>): MacroStep {
  return { id: "folders", kind: "macro", macro: "use-bookmark-folders", args } as never;
}
const both = step({ folder: folder("To Salvage"), alsoFolder: folder("Salvaged") });

const known = (folderID: number, name: string, isActive: boolean, isPersonal = false) => ({ folderID, name, isPersonal, isActive });
const addable = (folderID: number, name: string, isPersonal = false) => ({ folderID, name, isPersonal });

test("use-bookmark-folders: a named folder not yet added is added, asked for on", () => {
  const t = use(both, obs({
    known: [known(PERSONAL, "Personal Locations", true, true)],
    addable: [addable(PERSONAL, "Personal Locations", true), addable(TO_SALVAGE, "To Salvage"), addable(SALVAGED, "Salvaged")],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "addKnownFolder", folderID: TO_SALVAGE });
  assert.equal(t.outcome.kind, "acting");
});

test("use-bookmark-folders: an added folder that is off is switched on where the limit leaves room", () => {
  const t = use(both, obs({
    known: [known(TO_SALVAGE, "To Salvage", true), known(SALVAGED, "Salvaged", false), known(OTHER, "Old haul", true)],
    addable: [],
  }), {}, NB);
  assert.deepEqual(t.action, { kind: "setFolderActive", folderID: SALVAGED, active: true });
});

test("use-bookmark-folders: at the limit, a shared folder that is on and not named is switched off first", () => {
  const atLimit = obs({
    known: [known(TO_SALVAGE, "To Salvage", false), known(SALVAGED, "Salvaged", true), known(OTHER, "Old haul", true), known(ANOTHER, "Scouting", true),
      // Personal folders count against their own limit, never the shared one.
      known(PERSONAL, "Personal Locations", true, true)],
    addable: [],
  });
  const t = use(both, atLimit, {}, NB);
  assert.deepEqual(t.action, { kind: "setFolderActive", folderID: OTHER, active: false });
  assert.match(t.why, /Old haul.*To Salvage/);
});

test("use-bookmark-folders: done once every named folder is on, and changes nothing", () => {
  const t = use(both, obs({
    known: [known(TO_SALVAGE, "To Salvage", true), known(SALVAGED, "Salvaged", true), known(OTHER, "Old haul", true)],
    addable: [],
  }), {}, NB);
  assert.equal(t.outcome.kind, "done");
  assert.equal(t.action.kind, "wait");
});

test("use-bookmark-folders: unread folders are waited for, never read as none", () => {
  const t = use(both, obs(null), {}, NB);
  assert.equal(t.outcome.kind, "acting");
  assert.equal(t.action.kind, "wait");
});

test("use-bookmark-folders: a name the pilot cannot find, or two folders sharing it, stops the bot with a sentence", () => {
  const missing = use(both, obs({ known: [], addable: [addable(SALVAGED, "Salvaged")] }), {}, NB);
  assert.equal(missing.outcome.kind, "blocked");
  assert.match(missing.outcome.kind === "blocked" ? missing.outcome.reason : "", /no bookmark folder called To Salvage/);
  const twice = use(both, obs({ known: [known(TO_SALVAGE, "To Salvage", true)], addable: [addable(THIRD, "To Salvage")] }), {}, NB);
  assert.equal(twice.outcome.kind, "blocked");
  // The saved id settles which of two is meant.
  const meant = use(step({ folder: folder("To Salvage", THIRD) }), obs({ known: [known(TO_SALVAGE, "To Salvage", true)], addable: [addable(THIRD, "To Salvage")] }), {}, NB);
  assert.deepEqual(meant.action, { kind: "addKnownFolder", folderID: THIRD });
});

test("use-bookmark-folders: changes that keep not taking stop the bot rather than loop", () => {
  const off = obs({ known: [known(TO_SALVAGE, "To Salvage", false), known(SALVAGED, "Salvaged", true)], addable: [] });
  let mem = {};
  for (let i = 0; i < 8; i++) {
    const t = use(both, off, mem, NB);
    assert.equal(t.action.kind, "setFolderActive");
    mem = t.nextMem;
  }
  assert.equal(use(both, off, mem, NB).outcome.kind, "blocked");
});

test("use-bookmark-folders: no folder picked is a blocked step", () => {
  assert.equal(use(step({}), obs({ known: [], addable: [] }), {}, NB).outcome.kind, "blocked");
});
