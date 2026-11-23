import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { render } from "svelte/server";

test("the Mining overview separates observed ore, confirmed freight and the pilot requiring attention", async () => {
  register("../../../web/src/ui/svelteSsrHook.ts", import.meta.url);
  const { default: Overview } = await import("../restored/ui/MiningOperationOverview.svelte");
  const at = Date.parse("2026-11-21T23:31:00Z");
  const runtime = {
    state: "ACTIVE", observedAt: new Date(at).toISOString(),
    currentTarget: { targetName: "Mista IX Belt 4", systemName: "Mista", state: "ACTIVE" },
    members: [
      { characterID: 1, characterName: "FixtureMiner1", hosted: true, runtimeState: "running", phase: "Mining",
        oreLogisticsWork: { observedAtMs: at - 100, rawUnits: 7, compressedUnits: 4 } },
      { characterID: 2, characterName: "FixtureCargo1", hosted: true, runtimeState: "paused", phase: "Needs attention",
        reason: "Container access denied", oreLogisticsWork: { observedAtMs: at - 120_000, rawUnits: 500, compressedUnits: 0 } },
    ],
    history: [{ kind: "FREIGHT_PUBLISHED", evidence: { items: [{ quantity: 90 }] } },
      { kind: "FREIGHT_DELIVERED", evidence: { items: [{ quantity: 40 }] } }],
  };
  const active = render(Overview, { props: { runtime } }).body;
  assert.match(active, /Mista IX Belt 4/);
  assert.match(active, /2 \/ 2 hosted/);
  assert.match(active, /40 units.*Confirmed container deliveries/s);
  assert.match(active, /Ore in observed holds.*11 units/s);
  assert.match(active, /Needs attention · 1 pilot.*FixtureCargo1.*Container access denied/s);
  assert.doesNotMatch(active, /90 units|500 units/);
  const draft = render(Overview, { props: { runtime: { ...runtime, state: "DRAFT", currentTarget: null,
    lastRun: { deliveredUnits: 58, trips: 2 } } } }).body;
  assert.match(draft, /2 assigned.*Last run delivered.*58 units.*2 trips/s);
  assert.doesNotMatch(draft, /Needs attention|Ore in observed holds/);
});
