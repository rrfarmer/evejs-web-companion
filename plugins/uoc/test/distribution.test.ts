import test from "node:test";
import assert from "node:assert/strict";
import { civilianDistributionPlan, decodeDistributionSetup } from "../distribution/plan.ts";
import { createDistributionProgress } from "../distribution/progress.ts";
import { createCivilianDistributionRun } from "../distribution/backend.ts";
const auto = {
  agent: { mode: "auto", levelRule: "max", level: 3, corporationID: null, maxJumps: 8 },
  maxJumps: 12,
  missionCount: 1,
} as const;
test("distribution setup accepts a bounded mission count and requires a known manual station", () => {
  assert.ok(decodeDistributionSetup(auto));
  assert.equal(decodeDistributionSetup({ ...auto, missionCount: 2 })?.missionCount, 2);
  assert.equal(decodeDistributionSetup({ ...auto, missionCount: 501 }), null);
  assert.equal(decodeDistributionSetup({ ...auto, agent: { mode: "manual", agentID: 99 } }), null);
  assert.equal(
    decodeDistributionSetup({ ...auto, agent: { mode: "manual", agentID: 99, stationID: 100 } })
      ?.agent.mode,
    "manual",
  );
  assert.equal(decodeDistributionSetup({ ...auto, maxJumps: 31 }), null);
});
test("distribution plan keeps an unsuitable offer, requests a single exact completion", () => {
  const plan = civilianDistributionPlan(decodeDistributionSetup(auto)!);
  assert.deepEqual(
    plan.program.map((n) => (n.kind === "macro" ? n.macro : n.kind)),
    [
      "find-distribution-agent",
      "request-mission",
      "accept-mission",
      "load-mission-cargo",
      "travel-to-dropoff",
      "turn-in-mission",
    ],
  );
  const accept = plan.program[2]!;
  assert.equal(accept.kind, "macro");
  if (accept.kind === "macro")
    assert.deepEqual(accept.args.decline, { kind: "toggle", enabled: false });
});
test("completion counts only an exact bound native receipt once", () => {
  const progress = createDistributionProgress();
  const receipt = {
    kind: "missionCompletion" as const,
    runID: "run-1",
    invocationID: 1,
    stepPath: "complete",
    agentID: 99,
    actionID: 8,
    missionKey: "mission-a",
    completed: true as const,
  };
  assert.throws(() => progress.confirm(receipt));
  progress.bindAccepted("run-1", 99, "mission-a");
  for (const patch of [
    { runID: "old" },
    { agentID: 100 },
    { missionKey: "mission-b" },
    { stepPath: "other" },
    { invocationID: 0 },
  ])
    assert.throws(() => progress.confirm({ ...receipt, ...patch }));
  assert.equal(progress.snapshot().completedCount, 0);
  progress.confirm(receipt);
  assert.equal(progress.snapshot().completedCount, 1);
  assert.throws(() => progress.confirm(receipt));
  assert.throws(() => progress.bindAccepted("run-1", 99, "mission-a"));
  progress.bindAccepted("run-1", 99, "mission-b");
  progress.confirm({ ...receipt, invocationID: 2, missionKey: "mission-b" });
  assert.equal(progress.snapshot().completedCount, 2);
});
test("backend is disabled without verified admission and receipt hooks", async () => {
  const checked = await createCivilianDistributionRun().check(auto);
  assert.equal(checked.ok, false);
  if (!checked.ok) assert.match(checked.refusal, /verification/);
});

test("hosted adapter reports only verified receipt, never missing or mismatched proof", async () => {
  let hooks: any,
    stops = 0,
    started = 0;
  const reports: any[] = [];
  const host = {
    async attach(_run: any, options: any) {
      hooks = options;
      return {
        async start() {
          started++;
        },
        async stop() {
          stops++;
        },
      };
    },
  };
  const backend = createCivilianDistributionRun(host);
  const run: any = {
    baseUrl: "http://bff",
    fetch: async (input: any) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("/api/bots")
            ? {
                ok: true,
                bots: [
                  {
                    botID: "run-1",
                    characterID: 2,
                    expiresAt: new Date(Date.now() + 600000).toISOString(),
                  },
                ],
              }
            : { ok: true, account: "tester", characters: [{ characterID: 2 }] },
        ),
      ),
    setup: auto,
    resumed: false,
    accountID: 1,
    characterID: 2,
    held: { characterID: 2 },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    botID: "run-1",
    report: (v: any) => reports.push(v),
  };
  const handle = await backend.start(run);
  assert.equal(started, 1);
  hooks.bindAccepted("run-1", 99, "mission-a");
  const receipt = {
    kind: "missionCompletion",
    runID: "run-1",
    invocationID: 1,
    stepPath: "complete",
    agentID: 99,
    actionID: 8,
    missionKey: "mission-a",
    completed: true,
  };
  assert.throws(() => hooks.confirmed({ ...receipt, missionKey: "wrong" }));
  assert.equal(reports.length, 0);
  hooks.confirmed(receipt);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].readout.completedCount, 1);
  assert.equal(reports[0].status, "running");
  hooks.parked("verified dock");
  assert.equal(reports.at(-1).status, "stopped");
  hooks.stopped("later");
  assert.equal(reports.length, 2);
  await Promise.all([handle.stop(), handle.stop()]);
  assert.equal(stops, 1);
});

test("first failure remains visible after a separately verified Upwell dock", async () => {
  let hooks: any;
  const reports: any[] = [];
  const host = {
    async attach(_run: any, options: any) {
      hooks = options;
      return { async start() {}, async stop() {} };
    },
  };
  const run: any = {
    baseUrl: "http://bff",
    fetch: async (input: any) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("/api/bots")
            ? {
                ok: true,
                bots: [
                  {
                    botID: "failure-test",
                    characterID: 2,
                    expiresAt: new Date(Date.now() + 600000).toISOString(),
                  },
                ],
              }
            : { ok: true, account: "tester", characters: [{ characterID: 2 }] },
        ),
      ),
    setup: auto,
    resumed: false,
    characterID: 2,
    held: { characterID: 2 },
    botID: "failure-test",
    report: (v: any) => reports.push(v),
  };
  const handle = await createCivilianDistributionRun(host).start(run);
  hooks.missionObserved(99, 900);
  hooks.stopped("native transfer uncertain");
  hooks.parked("dock verified", { destinationID: 123, systemID: 300, kind: "structure" });
  const end = reports.at(-1);
  assert.equal(end.readout.firstFailure, "native transfer uncertain");
  assert.equal(end.readout.agentID, 99);
  assert.equal(end.readout.mission, 900);
  assert.deepEqual(end.readout.parking, {
    state: "DOCKED",
    destinationID: 123,
    systemID: 300,
    kind: "structure",
    release: "PENDING_CORE",
  });
  await handle.stop();
});
