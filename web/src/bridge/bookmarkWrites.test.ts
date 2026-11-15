// A place in space bookmarked by the page itself (bridge/bookmarkWrites.ts).

import test from "node:test";
import assert from "node:assert/strict";

import { bridgeDo } from "../app/api.ts";
import type { Ask } from "./ask.ts";
import { BOOKMARK_EXPIRY, bookmarkLocation, updateBookmark } from "./bookmarkWrites.ts";
import type { JsonValue } from "./wire.ts";

/** A stand-in for the page's asking: what was asked, and `answer` (or what it throws) for each. */
function asking(answer: JsonValue | Error = null) {
  const asked: unknown[] = [];
  const act: Ask = async (service, method, args, kwargs, of) => {
    asked.push([service, method, args, kwargs ?? null, of ?? null]);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { act, asked };
}

test("the times a bookmark is kept for are the client's four", () => {
  // bookmarkConst: BOOKMARK_EXPIRY_NONE 0, _4HOURS 1, _2DAYS 2, _24HOURS 3.
  assert.deepEqual(BOOKMARK_EXPIRY, { none: 0, fourHours: 1, twoDays: 2, oneDay: 3 });
});

test("a 24.02 bookmark edit distinguishes leaving, setting and removing its expiry", async () => {
  const { act, asked } = asking();
  for (const expiry of [null, BOOKMARK_EXPIRY.fourHours, BOOKMARK_EXPIRY.none]) {
    await updateBookmark(act, 900001, 7000001, "A\tspot", "note", null, 7000002, expiry);
  }
  const prefix = [900001, 7000001, "A spot", "note", null, 7000002];
  assert.deepEqual(asked, [[false, null], [true, 1], [true, 0]].map(suffix =>
    ["accessGroupBookmarkMgr", "UpdateBookmark", [...prefix, ...suffix], null, null]));
  await assert.rejects(updateBookmark(act, 900001, 7000001, "A spot", "", null, 7000002, 14), /Choose a bookmark expiry option/);
  assert.equal(asked.length, 3);
});

test("a place is bookmarked by one call of beyonce: the thing, the folder, the name, the note and the time, with the subfolder by keyword; and answers the bookmark's number", async () => {
  const { act, asked } = asking([900001, null, 5, 1.5, 2.5, 3.5, 30000142, null]);

  const made = await bookmarkLocation(act, 1000000012345, 7000001, "A spot", "a note", BOOKMARK_EXPIRY.twoDays);

  // bookmarkSvc.py 617: bp.BookmarkLocation(itemID, folderID, name, comment, expiry, subfolderID=subfolderID).
  assert.deepEqual(asked, [["beyonce", "BookmarkLocation", [1000000012345, 7000001, "A spot", "a note", 2], { subfolderID: null }, null]]);
  assert.equal(made, 900001);

  // A subfolder said goes by keyword; and a tab in the name is a space, as the client's window makes it (215).
  const within = asking([900002, null, 5, 0, 0, 0, 30000142, null]);
  assert.equal(await bookmarkLocation(within.act, 1000000012345, 7000001, "A\tspot", "", BOOKMARK_EXPIRY.none, 8000001), 900002);
  assert.deepEqual(within.asked, [["beyonce", "BookmarkLocation", [1000000012345, 7000001, "A spot", "", 0], { subfolderID: 8000001 }, null]]);

  // An answer that names no bookmark is none: the wire's long is that number, anything else nothing.
  const answers: Array<[JsonValue, number | null]> = [[[{ type: "long", value: "900003" }, null], 900003], [null, null], [[], null], [[0], null], ["900004", null], [{ bookmarkID: 900005 }, null]];
  for (const [answer, expected] of answers) {
    assert.equal(await bookmarkLocation(asking(answer).act, 1000000012345, 7000001, "A spot", "", 0), expected, JSON.stringify(answer));
  }
});

test("nothing is asked for what the client asks nothing for: no thing, no folder, no name, a time it has not, a place that is bookmarked another way", async () => {
  const refused = async (words: RegExp, itemID: number, folderID: number, name: string, comment: string, expiry: number, subfolderID: number | null = null) => {
    const { act, asked } = asking();
    const given = JSON.stringify([itemID, folderID, name, comment, expiry, subfolderID]);
    await assert.rejects(bookmarkLocation(act, itemID, folderID, name, comment, expiry, subfolderID), words, given);
    assert.deepEqual(asked, [], given);
  };
  for (const thing of [0, -5, 1.5, Number.NaN, 2 ** 53]) await refused(/^Error: There is nothing there to bookmark\.$/, thing, 7000001, "A spot", "", 0);
  for (const folder of [0, -7000001, 1.5, Number.NaN]) await refused(/^Error: That is no bookmark folder\.$/, 1000000012345, folder, "A spot", "", 0);
  // bookmarkLocationWindow.Confirm (212): a name of nothing is no name.
  for (const name of ["", "   ", "\t", " \t "]) await refused(/^Error: A bookmark needs a name\.$/, 1000000012345, 7000001, name, "", 0);
  for (const expiry of [4, -1, 1.5, Number.NaN]) await refused(/^Error: That is no time to keep a bookmark for\.$/, 1000000012345, 7000001, "A spot", "", expiry);
  for (const subfolder of [0, -1, 1.5]) await refused(/^Error: That is no bookmark subfolder\.$/, 1000000012345, 7000001, "A spot", "", 0, subfolder);
  // bookmarkSvc.py 611 to 613: a region, a constellation, a system or a station is bookmarked by another call, of another service.
  for (const place of [10000000, 10000002, 20000020, 30000142, 39999999, 60000000, 60003760, 63999999]) {
    await refused(/^Error: A station, a system, a constellation or a region is not bookmarked this way\.$/, place, 7000001, "A place", "", 0);
  }
  // Either side of those is a thing like any other.
  for (const thing of [9999999, 40000000, 59999999, 64000000]) {
    const { act, asked } = asking([1]);
    await bookmarkLocation(act, thing, 7000001, "A thing", "", 0);
    assert.equal(asked.length, 1, String(thing));
  }
  await assert.rejects(bookmarkLocation(asking(new Error("FolderAccessDenied")).act, 1000000012345, 7000001, "A spot", "", 0), /FolderAccessDenied/);
});

// The same, as it leaves the page: by the page's own asking of a write (app/api.ts, bridgeDo), which is the
// generic route's call said to be a pilot's and meant. Until 2026-10-11 no test of the page's made this write, so
// the game-port audit never looked at what the page sends for it.
test("a place bookmarked leaves the page as a pilot's write, meant: the client's five by position and the subfolder by keyword, on no object the page names", async () => {
  const sent: [string, unknown][] = [];
  const act = bridgeDo({ token: "a-pilot's", fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push([String(input), JSON.parse(String(init?.body))]);
    return Response.json({ ok: true, service: "beyonce", method: "BookmarkLocation", result: [7000042, 7000001, null, null], notifications: [] });
  }) as typeof globalThis.fetch });
  assert.equal(await bookmarkLocation(act, 1000000012345, 7000001, "A\tspot", "seen here", BOOKMARK_EXPIRY.twoDays), 7000042);
  assert.deepEqual(sent, [["/api/bridge/call", { service: "beyonce", method: "BookmarkLocation", args: [1000000012345, 7000001, "A spot", "seen here", 2],
    kwargs: { subfolderID: null }, pilot: true, confirm: true }]]);
  // With a subfolder: by its keyword still, and the rest as it was.
  await bookmarkLocation(act, 1000000012345, 7000001, "Another", "", BOOKMARK_EXPIRY.none, 7000009);
  assert.deepEqual(sent[1], ["/api/bridge/call", { service: "beyonce", method: "BookmarkLocation", args: [1000000012345, 7000001, "Another", "", 0],
    kwargs: { subfolderID: 7000009 }, pilot: true, confirm: true }]);
});
