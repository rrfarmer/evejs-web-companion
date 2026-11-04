// board-ship: the client's hangar pick and Board, as one block. A ship is named
// the way the pilot knows it - the name they gave it, its type, or both - and
// boarding leaves a note of the hull left behind, so board-previous-ship can
// go back to it.

import test from "node:test";
import assert from "node:assert/strict";

import type { BotScript, MacroStep } from "../bots/botScript.ts";
import { stepSentence } from "../bots/scriptText.ts";
import { validateScript } from "../bots/validateScript.ts";
import type { InventoryItemRow } from "../store/types.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import { SCRIPT_MACROS } from "./scriptMacros.ts";

const FLOWN = 1000;
const TENGU = 29984;
const VENTURE = 32880;

function ship(itemID: number, typeID: number): InventoryItemRow {
  return { itemID, typeID, groupID: 963, categoryID: 6, flagID: 4, quantity: 1, singleton: true };
}

function step(args: MacroStep["args"]): MacroStep {
  return { id: "board", kind: "macro", macro: "board-ship", args };
}

function docked(overrides: Partial<ScriptObservation> = {}): ScriptObservation {
  return {
    flightStatus: { docked: true, shipTypeID: VENTURE },
    activeShipID: FLOWN,
    stationHangar: [ship(1003, TENGU), ship(1002, TENGU), ship(1004, VENTURE)],
    shipNames: { [FLOWN]: "Rock Eater", 1002: "Spare", 1003: "My Tengu sucks", 1004: null },
    ...overrides,
  } as unknown as ScriptObservation;
}

const boardShip = SCRIPT_MACROS["board-ship"];
const byName = step({ shipName: { kind: "text", text: "  my tengu SUCKS " } });
const byType = step({ shipType: { kind: "itemType", typeID: TENGU, name: "Tengu" } });

test("by name, the ship the pilot named is boarded, whatever the case and spacing", () => {
  const result = boardShip(byName, docked(), {}, {});
  assert.deepEqual(result.action, { kind: "boardShip", shipID: 1003 });
  assert.equal(result.boardPatch?.["shipBeforeRefit"], FLOWN, "the hull left behind is noted for board-previous-ship");
});

test("by type, of several that match, the one parked longest is boarded, every run the same", () => {
  assert.deepEqual(boardShip(byType, docked(), {}, {}).action, { kind: "boardShip", shipID: 1002 });
});

test("by name and type together, both must match", () => {
  const both = step({ shipName: { kind: "text", text: "Spare" }, shipType: { kind: "itemType", typeID: VENTURE, name: "Venture" } });
  const result = boardShip(both, docked(), {}, {});
  assert.equal(result.outcome.kind, "blocked");
  assert.match(result.outcome.kind === "blocked" ? result.outcome.reason : "", /No Venture named "Spare" is parked at this station/);
});

test("already flying the named ship is done, and nothing is boarded", () => {
  const flown = step({ shipName: { kind: "text", text: "Rock Eater" } });
  const result = boardShip(flown, docked(), {}, {});
  assert.equal(result.outcome.kind, "done");
  assert.equal(result.action.kind, "wait");
});

test("names not read yet are waited for, never guessed", () => {
  const result = boardShip(byName, docked({ shipNames: null }), {}, {});
  assert.equal(result.action.kind, "wait");
  assert.equal(result.outcome.kind, "acting");
});

test("⚠ names that never come stop the block and say so, rather than waiting for good", () => {
  let mem = {};
  let result = boardShip(byName, docked({ shipNames: null }), mem, {});
  for (let ticks = 0; ticks < 50 && result.outcome.kind === "acting"; ticks++) {
    mem = result.nextMem;
    result = boardShip(byName, docked({ shipNames: null }), mem, {});
  }
  assert.equal(result.outcome.kind, "blocked");
  assert.match(result.outcome.kind === "blocked" ? result.outcome.reason : "", /could not be read/);
});

test("in space, ships are not changed: the block says to dock first", () => {
  const result = boardShip(byType, docked({ flightStatus: { docked: false } } as Partial<ScriptObservation>), {}, {});
  assert.equal(result.outcome.kind, "blocked");
});

test("a step naming no ship is a problem the editor lists, and its sentence says what it boards", () => {
  const doc = (s: MacroStep): BotScript => ({
    format: "evejs-bot-script", version: 1, name: "Reship", notes: "",
    home: { entity: "station", id: 60003760, name: "Home", systemName: "Jita" }, interrupts: [], program: [s],
  });
  assert.deepEqual(validateScript(doc(step({}))).map((p) => p.sentence), ["Say which ship to board: its name, its type, or both."]);
  assert.deepEqual(validateScript(doc(byName)), []);
  assert.equal(stepSentence(byName), 'Board the ship named "my tengu SUCKS"');
  assert.equal(stepSentence(byType), "Board a Tengu parked here");
});
