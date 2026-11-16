import test from "node:test";
import assert from "node:assert/strict";
import { bracketIcon } from "./brackets.ts";

test("the hacking security state overrides the default bracket texture", () => {
  const collection = { typeID: 85231, groupID: 306, categoryID: 2 };
  const directory = "/client-res/ui/texture/shared/brackets";
  assert.equal(bracketIcon(collection), null);
  assert.equal(bracketIcon({ ...collection, hackingSecurityState: 0 }), `${directory}/scattercontainerunopened.png`);
  assert.equal(bracketIcon({ ...collection, hackingSecurityState: 1 }), `${directory}/scattercontainerbeinghacked.png`);
  for (const hackingSecurityState of [2, 3]) {
    assert.equal(bracketIcon({ ...collection, hackingSecurityState }), `${directory}/scattercontainerempty.png`);
  }
});
