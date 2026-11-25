import test from "node:test";
import assert from "node:assert/strict";
import { getMiningCompressionCompatibility } from "./api.ts";

test("static compatibility is bounded read-only and malformed identity/rules fail unknown", async () => {
  let calls = 0;
  const options = { token: "own", fetch: async (_path: unknown, init?: RequestInit) => {
    calls++; assert.equal(init?.method ?? "GET", "GET");
    return new Response(JSON.stringify({ ok: true, compatibility: [{ typeID: 999, compressedTypeID: 62516, matchingTypeListIDs: [334], availability: "available" }] }));
  } };
  assert.equal(await getMiningCompressionCompatibility([1230], [334], options), null);
  assert.equal(await getMiningCompressionCompatibility([], [334], options), null); assert.equal(calls, 1);
});
