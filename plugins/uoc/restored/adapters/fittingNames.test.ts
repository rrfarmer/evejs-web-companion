import test from "node:test";
import assert from "node:assert/strict";
import { fittingNames } from "./fittingNames.ts";
test("saved fitting filters use native type/group metadata without a demonstration hull list", async () => {
  const calls: string[] = [],
    fit = { goalTypeID: 592, fingerprint: "exact", fittingID: 3 };
  const rows = await fittingNames([fit], { token: "own" }, async (p, _o, b) => {
    calls.push(p);
    return p.includes("type-meta")
      ? { available: true, types: { 592: { groupID: 25 } } }
      : { names: { "type:592": "Incursus", "group:25": "Frigate" } };
  });
  assert.equal(rows[0].hullName, "Incursus");
  assert.equal(rows[0].hullGroupID, 25);
  assert.equal(rows[0].hullGroupName, "Frigate");
  assert.equal(rows[0].fingerprint, "exact");
  assert.deepEqual(calls, ["/api/client-data/type-meta?typeIDs=592", "/api/names"]);
});
test("missing metadata remains unknown and cannot become an invented group", async () => {
  const rows = await fittingNames([{ goalTypeID: 592 }], {}, async () => {
    throw Error("unavailable");
  });
  assert.equal(rows[0].hullGroupID, null);
  assert.equal(rows[0].hullGroupName, null);
  assert.equal(rows[0].hullName, "Ship 592");
});
