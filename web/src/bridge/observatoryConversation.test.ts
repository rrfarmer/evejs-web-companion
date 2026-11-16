import assert from "node:assert/strict";
import test from "node:test";
import type { CurrentDungeon } from "./dungeonTracking.ts";
import { observatoryConversationPhase as phase, observatoryFailureObjectiveDelay as objectiveDelay } from "./observatoryConversation.ts";

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

test("the native Failure objective closes after three seconds only once per state transition", () => {
  const lockdown = room(30563, "Lockdown"), failure = room(30563, "Failure");
  assert.equal(objectiveDelay(lockdown, failure), 3_000);
  assert.equal(objectiveDelay(failure, room(30594, "Failure")), null);
  assert.equal(objectiveDelay(failure, room(30563, "Failure", 637)), 3_000);
  assert.equal(objectiveDelay(lockdown, room(30563, "Success")), null);
  assert.equal(objectiveDelay(null, { ...failure, dungeonID: 5533 }), null);
});
