import assert from "node:assert/strict";
import test from "node:test";
import { CHARACTER_DRAG_MIME, dragCharacter, droppedCharacter } from "./characterDrag.ts";

test("a character drag identifies the pilot without using the display text as a target ID", () => {
  const payload = new Map<string, string>();
  const event = { dataTransfer: {
    setData(type: string, value: string) { payload.set(type, value); },
    getData(type: string) { return payload.get(type) ?? ""; },
  } } as unknown as DragEvent;
  payload.set("text/plain", "140000002");
  assert.equal(droppedCharacter(event), null);
  dragCharacter(event, 140_000_002, "Test Two");
  assert.equal(droppedCharacter(event), 140_000_002);
  assert.equal(payload.get("text/plain"), "Test Two");
  for (const invalid of ["0", "-2", "140000002.5", "9007199254740992"]) {
    payload.set(CHARACTER_DRAG_MIME, invalid);
    assert.equal(droppedCharacter(event), null);
  }
});
