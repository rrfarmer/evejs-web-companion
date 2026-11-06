// What the server tells the player unasked, as a dialog of the client's (gameui.py OnRemoteMessage).

import test from "node:test";
import assert from "node:assert/strict";

import { REMOTE_MESSAGE, remoteDialogOf } from "./serverDialogs.ts";
import type { JsonValue } from "./wire.ts";

const dict = (entries: readonly (readonly [string, JsonValue])[]): JsonValue => ({ type: "dict", entries: entries as JsonValue });

test("a Custom* dialog is put up with its dict, and the page's words for it are the server's own sentence", () => {
  assert.equal(REMOTE_MESSAGE, "OnRemoteMessage");
  const values = dict([["notify", "Test server notice."]]);
  assert.deepEqual(remoteDialogOf(["CustomNotify", values]), { dialog: "CustomNotify", values, fallback: "Test server notice.", fallbackType: "notify" });
  const wrapped = dict([["notify", { type: "wstring", value: "Sites spawned." }]]);
  assert.equal(remoteDialogOf(["CustomNotify", wrapped])?.fallback, "Sites spawned.");
  assert.equal(remoteDialogOf(["CustomError", dict([["error", "Nope."]])])?.fallback, "Nope.");
  // A Custom* with nothing to say is nothing.
  assert.equal(remoteDialogOf(["CustomNotify", dict([["notify", "  "]])]), null);
  assert.equal(remoteDialogOf(["CustomInfo", null]), null);
});

test("the client's own dialogs go up by name with their dict; the page has words for the ones this server sends", () => {
  const values = dict([["leader", 90000001]]);
  assert.deepEqual(remoteDialogOf(["FleetWarp", values]), { dialog: "FleetWarp", values, fallback: "Following your fleet in warp.", fallbackType: "notify" });
  assert.deepEqual(remoteDialogOf(["ShipInWarp", null]), { dialog: "ShipInWarp", values: null, fallback: "You cannot do that while warping.", fallbackType: "notify" });
  assert.equal(remoteDialogOf(["SomeOtherDialog", dict([])])?.fallback, "The server says something this page has no words for (SomeOtherDialog).");
});

test("a failed salvage cycle passes in the strip: it comes every cycle, so it must not stop the player with a box", () => {
  const values = dict([["itemID", 90000001]]);
  assert.deepEqual(remoteDialogOf(["SalvagingFailure", values]), {
    dialog: "SalvagingFailure", values, fallback: "Salvaging failed: nothing was recovered this cycle.", fallbackType: "notify",
  });
});

for (const [dialog, key, fallbackType] of [
  ["CustomInfo", "info", "info"], ["CustomError", "error", "error"], ["CustomWarning", "warning", "warning"],
] as const) {
  test(`${dialog} carries its known box presentation when client data is unavailable`, () => {
    assert.equal(remoteDialogOf([dialog, dict([[key, "Test message."]])])?.fallbackType, fallbackType);
  });
}

test("what names no dialog is nothing", () => {
  for (const args of [[], [7], ["has spaces"], [null, dict([])]] as unknown[][]) {
    assert.equal(remoteDialogOf(args), null, JSON.stringify(args));
  }
});
