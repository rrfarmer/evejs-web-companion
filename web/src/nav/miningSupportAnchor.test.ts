import test from "node:test";
import assert from "node:assert/strict";
import { decodeMiningSupportAnchorRead } from "../bridge/miningSupportAnchor.ts";

test("read decoder distinguishes none/unknown/stale and rejects cross-fleet or malformed records", () => {
  const fleet = { fleetID: "9007199254740993123", readerCharacterID: 2, observedAtMs: 100_000,
    expiresAtMs: 110_000, members: [{ characterID: 2, solarSystemID: 30000142 }] };
  const publication = { characterID: 1, shipID: 1001, fleetID: fleet.fleetID, solarSystemID: 30000142,
    sessionEpoch: "epoch", sampledAtMs: 400, observedAtMs: 100_000, publishedAtMs: 100_000,
    expiresAtMs: 110_000, ageMs: 0, freshness: "fresh", reason: null, services: {} };
  const wire = (anchors: unknown[]) => JSON.parse(JSON.stringify({ availability: "available", readAtMs: 100_000, fleet, anchors }));
  assert.deepEqual(decodeMiningSupportAnchorRead(wire([])).anchors, []);
  assert.equal(decodeMiningSupportAnchorRead({ availability: "unknown", reason: "READ_FAILED" }).availability, "unknown");
  assert.equal(decodeMiningSupportAnchorRead(wire([{ ...publication, freshness: "stale", ageMs: 10_000 }])).anchors[0]?.freshness, "stale");
  assert.equal(decodeMiningSupportAnchorRead(wire([{ ...publication, fleetID: "2" }])).availability, "unknown");
  assert.equal(decodeMiningSupportAnchorRead(wire([{ ...publication, shipID: null }])).availability, "unknown");
});
