import test from "node:test";
import assert from "node:assert/strict";
import { reservedPluginPage } from "./pageRoute.ts";

test("retired center paths remain unavailable to plugins", () => {
  for (const id of ["mining-command-center", "pilot-training", "goblin-factory", "ship-provisioning"]) {
    assert.equal(reservedPluginPage(id), true);
  }
  assert.equal(reservedPluginPage("uoc"), false);
});
