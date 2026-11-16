import type { CurrentDungeon } from "./dungeonTracking.ts";

// Graph 669's Failure branch stops the objectives after its default delay.
export function observatoryFailureObjectiveDelay(previous: CurrentDungeon | null, current: CurrentDungeon): number | null {
  if (current.dungeonID !== 12260 || current.values?.dungeon_state !== "Failure") return null;
  if (previous?.instanceID === current.instanceID && previous?.dungeonID === current.dungeonID &&
      previous.values?.dungeon_state === "Failure") return null;
  return 3_000;
}

/** Graphs 882 and 669 bind these state and room transitions to ShowConversation. */
export function observatoryConversationPhase(previous: CurrentDungeon | null, current: CurrentDungeon) {
  const lobby = current.values?.lobby_room_id;
  if (current.dungeonID !== 12260 || typeof lobby !== "number" || current.roomID === null) return null;
  const sameInstance = previous?.dungeonID === current.dungeonID && previous.instanceID === current.instanceID;
  const state = current.values?.dungeon_state;
  if (current.roomID === lobby && (!sameInstance || previous.roomID !== lobby)) {
    return state === "Success" ? "complete" : state === "Failure" ? null : "lobby";
  }
  if (current.roomID !== lobby && state === "Failure" && sameInstance &&
      previous.values?.dungeon_state !== "Failure") return "failure";
  return null;
}
