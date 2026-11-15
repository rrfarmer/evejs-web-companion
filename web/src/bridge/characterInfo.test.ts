import assert from "node:assert/strict";
import test from "node:test";
import type { Ask } from "./ask.ts";
import { readCharacterBloodline, readCharacterInfoHeader } from "./characterInfo.ts";
import type { JsonValue } from "./wire.ts";

const CHARACTER_ID = 140000003;
const START = "134391964704280000";
const rowset: JsonValue = {
  type: "objectex2", list: [
    { type: "packedrow", fields: {
      startDateTime: { type: "long", value: START },
      description: { type: "wstring", value: "A public biography." },
      bloodlineID: 8, militiaFactionID: 500002,
    } },
  ],
};

test("the 24.02 header and bloodline use the first public row with the named character", async () => {
  const publicTargets: JsonValue[] = [];
  const ask: Ask = async (service, method, args) => {
    const pair = service + "." + method;
    if (pair === "charMgr.GetPublicInfo3") {
      assert.deepEqual(args, [CHARACTER_ID]);
      publicTargets.push(args[0]!);
      return rowset;
    }
    if (pair === "crimewatch.GetCharacterSecurityStatus") return 0;
    throw new Error("Corporation record unavailable");
  };
  const header = await readCharacterInfoHeader(ask, CHARACTER_ID);
  assert.deepEqual(header, {
    description: "A public biography.", bloodlineID: 8, startDateTime: BigInt(START),
    militiaFactionID: 500002, corporationID: null, allianceID: null, titles: [], securityStatus: 0,
  });
  assert.equal(await readCharacterBloodline(ask, CHARACTER_ID), 8);
  assert.deepEqual(publicTargets, [CHARACTER_ID, CHARACTER_ID]);
});
