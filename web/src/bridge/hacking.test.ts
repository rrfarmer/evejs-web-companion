import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyHackTurn, hackCalls, hackNeighbours } from "./hacking.ts";

const dict = (fields: Record<string, unknown>) => ({ type: "dict", entries: Object.entries(fields) });
const keyed = (eventID: number, data: Record<string, unknown> = {}) =>
  ({ type: "object", name: "util.KeyVal", args: dict({ eventID, eventData: dict(data) }) });
const list = (items: readonly unknown[]) => ({ type: "list", items });
const node = (coord: readonly [number, number], type: number, fields: Record<string, unknown> = {}) =>
  ({ coord, type, hidden: type < 0, blocked: false, strength: 0, coherence: 0, ...fields });

test("the start marker follows the board and virus, and a later start replaces the attempt", () => {
  const board = applyHackTurn(null, [[
    keyed(5, { style: 1 }),
    keyed(101, node([1, 1], 0)), keyed(101, node([2, 0], -1)),
    keyed(3, { coherence: 110, strength: 35, inventory: list([dict({ subtype: -1 })]) }),
    keyed(2, { moduleTypeID: 30832, targetID: 9988400001513 }),
  ]]);
  assert.ok(board);
  assert.equal(board.style, 1);
  assert.equal(board.coherence, 110);
  assert.equal(board.strength, 35);
  assert.equal(board.start.targetID, 9988400001513);
  assert.equal(board.tiles.size, 2);
  assert.equal(board.tiles.get("2,0")?.hidden, true);
  assert.deepEqual(board.utilities, [{ subtype: -1, inUse: false, remaining: null, amount: null, totalDuration: null }]);
  assert.ok(hackNeighbours([1, 1]).some(coord => String(coord) === "2,0"));
  assert.ok(hackNeighbours([2, 0]).some(coord => String(coord) === "1,1"));
  const replacement = applyHackTurn(board, [list([keyed(2, { moduleTypeID: 22177, targetID: 456 })])]);
  assert.equal(replacement?.tiles.size, 0);
  assert.equal(replacement?.start.targetID, 456);
  assert.notEqual(replacement?.start, board.start);
});

test("the next turns merge partial clues, inventory, combat, expiry and a durable win", () => {
  const initial = applyHackTurn(null, [[
    keyed(101, node([2, 2], -1)), keyed(101, node([2, 1], 5)),
    keyed(3, { coherence: 100, strength: 30, inventory: list([dict({ subtype: -1 })]) }),
    keyed(2, { moduleTypeID: 30832 }),
  ]]);
  const mid = applyHackTurn(initial, [[
    keyed(100, node([2, 2], 0)), keyed(308, { coord: [2, 2], distanceIndicator: 2 }),
    keyed(200, { replacementObject: dict(node([2, 1], 0)), inventory: list([dict({ subtype: 0, info: 15, totalDuration: 3 })]) }),
    keyed(202, { index: 0, value: true }),
    keyed(303, { index: 0, durationRemaining: 2, target: dict({ type: 1, coherence: 105, strength: 30 }) }),
  ]]);
  assert.equal(mid?.tiles.get("2,2")?.distance, 2);
  assert.equal(mid?.tiles.get("2,1")?.type, 0);
  assert.equal(mid?.coherence, 105);
  assert.deepEqual(mid?.utilities, [{ subtype: 0, inUse: true, remaining: 2, amount: 15, totalDuration: 3 }]);
  const won = applyHackTurn(mid, [[
    keyed(301, { attackerResult: dict({ type: 1, coherence: 98, strength: 30 }),
      defenderResult: dict(node([2, 3], 2, { coherence: 0, strength: 10 })) }),
    keyed(4, node([2, 3], 2)),
    keyed(201, { index: 0, inventory: dict({ inventory: list([dict({ subtype: -1 })]) }) }),
    keyed(400, { coord: [2, 3], contentsList: list([[25595, 5]]) }),
    keyed(1, {}),
  ]]);
  assert.equal(won?.coherence, 98);
  assert.equal(won?.tiles.get("2,3")?.type, 0);
  assert.deepEqual(won?.tiles.get("2,3")?.contents, [[25595, 5]]);
  assert.equal(won?.utilities[0]?.subtype, -1);
  assert.equal(won?.outcome, "won");
  assert.equal(won?.start, initial?.start);
  assert.equal(applyHackTurn(won, [[keyed(0)]]), won);
  assert.equal(applyHackTurn(null, [[keyed(0)]]), null);
});

test("button actions use the native coordinate tuple and targeted utility sequence", () => {
  const coord = { type: "tuple", items: [2, 4] };
  assert.deepEqual(hackCalls({ type: "tile", coord: [2, 4], utility: null }), [["ClickedOnTile", [coord]]]);
  assert.deepEqual(hackCalls({ type: "tile", coord: [2, 4], utility: 1 }), [
    ["UsedUtilityElement", [1, coord]], ["ClickedOnTile", [coord]],
  ]);
  assert.deepEqual(hackCalls({ type: "virus", utility: 2 }), [["UsedUtilityElementOnVirus", [2]]]);
  assert.deepEqual(hackCalls({ type: "quit" }), [["QuitHackingAttempt", []]]);
});
