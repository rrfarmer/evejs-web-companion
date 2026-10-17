// The page's own calls for a shared bookmark folder (bridge/bookmarkFolders.ts), as they leave the page.

import test from "node:test";
import assert from "node:assert/strict";
import { bridgeAsk, bridgeDo } from "../app/api.ts";
import { addToKnownFolders, moveBookmarks, readFoldersWithAdminAccess, updateKnownFolderState } from "./bookmarkFolders.ts";

function recording(result: unknown, method: string) {
  const sent: [string, unknown][] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push([String(input), JSON.parse(String(init?.body))]);
    return Response.json({ ok: true, service: "accessGroupBookmarkMgr", method, result, notifications: [] });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

test("a shared folder is taken up and switched on and off as a pilot's writes, meant: the folder and its state by position", async () => {
  const add = recording([null, { type: "list", items: [] }, { type: "list", items: [] }], "AddToKnownFolders");
  await addToKnownFolders(bridgeDo({ token: "a-pilot's", fetch: add.fetch }), 7000001, true);
  assert.deepEqual(add.sent, [["/api/bridge/call", { service: "accessGroupBookmarkMgr", method: "AddToKnownFolders", args: [7000001, true], kwargs: null, pilot: true, confirm: true }]]);

  const state = recording([null, { type: "list", items: [] }, { type: "list", items: [] }], "UpdateKnownFolderState");
  await updateKnownFolderState(bridgeDo({ token: "a-pilot's", fetch: state.fetch }), 7000003, false);
  assert.deepEqual(state.sent, [["/api/bridge/call", { service: "accessGroupBookmarkMgr", method: "UpdateKnownFolderState", args: [7000003, false], kwargs: null, pilot: true, confirm: true }]]);
});

test("no folder is no call", async () => {
  const none = recording(null, "AddToKnownFolders");
  for (const bad of [0, -1, 1.5]) {
    await assert.rejects(addToKnownFolders(bridgeDo({ token: "a-pilot's", fetch: none.fetch }), bad, true), /That is no bookmark folder\./);
    await assert.rejects(updateKnownFolderState(bridgeDo({ token: "a-pilot's", fetch: none.fetch }), bad, true), /That is no bookmark folder\./);
  }
  assert.equal(none.sent.length, 0);
});

test("the folders a pilot administers are read by the search, with nothing sent, and decoded", async () => {
  const row = { type: "object", name: "util.KeyVal", args: { type: "dict", entries: [
    ["folderID", 7000001], ["folderName", { type: "wstring", value: "To Salvage" }], ["isPersonal", false], ["isActive", false], ["accessLevel", 8],
  ] } };
  const read = recording({ type: "list", items: [row] }, "SearchFoldersWithAdminAccess");
  const folders = await readFoldersWithAdminAccess(bridgeAsk({ token: "a-pilot's", fetch: read.fetch }));
  assert.equal(read.sent.length, 1);
  const body = read.sent[0]![1] as { service: string; method: string; args: unknown[] };
  assert.deepEqual([body.service, body.method, body.args], ["accessGroupBookmarkMgr", "SearchFoldersWithAdminAccess", []]);
  assert.deepEqual(folders.map((f) => [f.folderID, f.folderName, f.isPersonal]), [[7000001, "To Salvage", false]]);
});

test("a finished site's bookmark is moved as a pilot's write, meant: from, to, no subfolder, and the bookmarks", async () => {
  const move = recording([{ type: "list", items: [] }, null], "MoveBookmarksToFolderAndSubfolder");
  await moveBookmarks(bridgeDo({ token: "a-pilot's", fetch: move.fetch }), 7000001, 7000002, [9000011]);
  assert.deepEqual(move.sent, [["/api/bridge/call", { service: "accessGroupBookmarkMgr", method: "MoveBookmarksToFolderAndSubfolder", args: [7000001, 7000002, null, [9000011]], kwargs: null, pilot: true, confirm: true }]]);
  const none = recording(null, "MoveBookmarksToFolderAndSubfolder");
  await assert.rejects(moveBookmarks(bridgeDo({ token: "a-pilot's", fetch: none.fetch }), 7000001, 7000002, []), /There is no bookmark to move\./);
  await assert.rejects(moveBookmarks(bridgeDo({ token: "a-pilot's", fetch: none.fetch }), 0, 7000002, [9000011]), /That is no bookmark folder\./);
  assert.equal(none.sent.length, 0);
});
