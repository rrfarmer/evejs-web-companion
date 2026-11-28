import test from "node:test";
import assert from "node:assert/strict";
import {
  civilianSetup,
  inspectCivilianCheckpoint,
  startCivilianRun,
  type CivilianReview,
} from "./civilian.ts";
import { decodeCivilianMiningSetup } from "../../mining/setup.ts";
import { decodeDistributionSetup } from "../../distribution/plan.ts";
const plan: CivilianReview = {
  pilot: { characterID: 3 } as any,
  agent: null,
  mode: "mining",
  runtime: 4320,
  maxJumps: 4,
  searchJumps: 6,
  limit: 500,
  policy: "COUNT",
  automatic: true,
  corporationID: null,
  level: 4,
  fallback: true,
  parking: { mode: "NEAREST" },
};
test("original count and up-to-level controls reach the existing hosted decoders without changing the independent runtime", () => {
  for (let level = 1; level <= 4; level++) {
    const setup = civilianSetup({ ...plan, level });
    const native = decodeCivilianMiningSetup(setup);
    assert.equal(native?.missionCount, 500);
    assert.equal(native?.durationMinutes, undefined);
    assert.deepEqual(native?.agent, {
      mode: "auto",
      levelRule: "max",
      level,
      corporationID: null,
      maxJumps: 6,
    });
  }
  assert.throws(() => civilianSetup({ ...plan, limit: 501 }), /500/);
  assert.equal(
    decodeCivilianMiningSetup({ ...(civilianSetup(plan) as any), missionCount: 501 }),
    null,
  );
});
test("manual Distribution keeps delivery jumps separate and exact selected parking", () => {
  const setup = civilianSetup({
    ...plan,
    mode: "distribution",
    automatic: false,
    agent: { agentID: 7, stationID: 8 } as any,
    parking: {
      mode: "SELECTED",
      destination: {
        id: 9,
        kind: "structure",
        name: "Fixture Upwell",
        solarSystemID: 10,
        solarSystemName: "Fixture System",
      },
    },
  });
  const native = decodeDistributionSetup(setup);
  assert.equal(native?.maxJumps, 4);
  assert.deepEqual(native?.agent, { mode: "manual", agentID: 7, stationID: 8 });
  assert.deepEqual(native?.parking, {
    mode: "selected",
    kind: "structure",
    destinationID: 9,
    systemID: 10,
  });
  assert.equal(native?.missionCount, 500);
  assert.equal(decodeDistributionSetup({ ...(setup as any), missionCount: 501 }), null);
});
test("time policy uses the existing time executor and does not inherit the previous count", () => {
  for (const mode of ["mining", "distribution"] as const) {
    const setup = civilianSetup({ ...plan, mode, policy: "TIME", runtime: 120, limit: 999 });
    const native =
      mode === "mining" ? decodeCivilianMiningSetup(setup) : decodeDistributionSetup(setup);
    assert.equal(native?.durationMinutes, 120);
    assert.equal(native?.missionCount, 1);
  }
  assert.throws(() => civilianSetup({ ...plan, runtime: 4321 }), /runtime/);
});

test("checkpoint adapter keeps stored evidence distinct from native reconciliation and checks exact pilot", async () => {
  const { installTrainingAdapter } = await import("./training.ts");
  installTrainingAdapter({
    authenticatedJson: async () => ({}),
    runHosted: async (id, kind) => ({
      botID: "read",
      phase: "Civilian checkpoint inspected",
      status: "stopped",
      why: null,
      readout: {
        characterID: id,
        scope: "STORED_ONLY",
        nativeReconciled: false,
        mining: { pending: "complete" },
        distribution: null,
      },
    }),
  });
  const r = await inspectCivilianCheckpoint(3, {});
  assert.equal(r.mining.pending, "complete");
  assert.equal(r.nativeReconciled, false);
  await assert.rejects(inspectCivilianCheckpoint(0, {}), /pilot/);
});

test("fresh Start refuses an active owner and changed selected Upwell access before any hosted dispatch", async () => {
  let online = true;
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const u = new URL(String(input));
    requests.push(u.pathname);
    if (u.pathname === "/api/pilot-training/characters")
      return Response.json({ account: "Fixture", characters: [{ characterID: 3 }] });
    if (u.pathname === "/api/pilot-training/ownership")
      return Response.json({
        ownership: { characterID: 3, owner: online ? "COCKPIT" : "OFF", online },
      });
    if (u.pathname === "/api/bots") return Response.json({ bots: [] });
    if (u.pathname.startsWith("/api/dockable-structures/"))
      return Response.json({ location: { id: 9, kind: "structure", solarSystemID: 999 } });
    throw Error("Unexpected dispatch " + u.pathname);
  };
  const reviewed = {
    ...plan,
    pilot: { ...plan.pilot, accountName: "Fixture" },
    parking: {
      mode: "SELECTED" as const,
      destination: { id: 9, kind: "structure" as const, name: "Fixture", solarSystemID: 10 },
    },
  };
  await assert.rejects(
    startCivilianRun(reviewed as any, { baseUrl: "http://fixture", fetch: fetcher }),
    /offline and free/,
  );
  online = false;
  await assert.rejects(
    startCivilianRun(reviewed as any, { baseUrl: "http://fixture", fetch: fetcher }),
    /Upwell access changed/,
  );
  assert.ok(!requests.some((r) => /start|\/check$/.test(r)));
});
