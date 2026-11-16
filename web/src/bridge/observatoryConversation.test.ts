import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentDungeon } from "./dungeonTracking.ts";
import { observatoryConversationPhase as phase, observatoryObjectiveRemovalDelay as objectiveDelay } from "./observatoryConversation.ts";

function room(roomID: number, state: string, instanceID = 636): CurrentDungeon {
  return { dungeonID: 12260, roomID, instanceID, values: { lobby_room_id: 30594, dungeon_state: state } };
}

test("the Observatory greeting starts on lobby arrival and completion waits for lobby re-entry", () => {
  const lobby = room(30594, "Default"), vault = room(30563, "Default");
  const won = room(30563, "Success"), wonLobby = room(30594, "Success");
  assert.equal(phase(null, lobby), "lobby");
  assert.equal(phase(lobby, room(30594, "Lockdown")), null);
  assert.equal(phase(lobby, vault), null);
  assert.equal(phase(vault, won), null);
  assert.equal(phase(won, wonLobby), "complete");
  assert.equal(phase(wonLobby, wonLobby), null);
  assert.equal(phase(wonLobby, room(30594, "Default", 637)), "lobby");
});

test("only a new vault failure in the same Observatory instance starts the failure line", () => {
  const lockdown = room(30563, "Lockdown"), failure = room(30563, "Failure");
  assert.equal(phase(lockdown, failure), "failure");
  assert.equal(phase(failure, failure), null);
  assert.equal(phase(lockdown, room(30563, "Failure", 637)), null);
  assert.equal(phase(room(30594, "Lockdown"), room(30594, "Failure")), null);
  assert.equal(phase(null, { ...room(30594, "Default"), dungeonID: 5533 }), null);
  assert.equal(phase(null, { dungeonID: 12260, roomID: 30594, instanceID: 636 }), null);
});

test("Observatory objectives close three seconds after Success or Failure", () => {
  const vault = room(30563, "Default"), lockdown = room(30563, "Lockdown");
  assert.equal(objectiveDelay(vault, lockdown), null);
  for (const state of ["Success", "Failure"]) {
    const terminal = room(30563, state);
    assert.equal(objectiveDelay(lockdown, terminal), 3_000);
    assert.equal(objectiveDelay(null, terminal), 3_000);
    assert.equal(objectiveDelay(terminal, { ...terminal, values: { ...terminal.values, containers_hacked_current: 3 } }), null);
    assert.equal(objectiveDelay(terminal, room(30594, state)), null);
    assert.equal(objectiveDelay(terminal, room(30563, state, 637)), 3_000);
    assert.equal(objectiveDelay(null, { ...terminal, dungeonID: 5533 }), null);
  }
});
