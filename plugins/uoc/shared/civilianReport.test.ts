import test from "node:test";
import assert from "node:assert/strict";
import { withCivilianPolicy } from "./civilianReport.ts";
import {
  createCivilianIndex,
  createCivilianCheckpointsRoute,
  type CivilianIndexRow,
} from "../civilian/index.ts";
import { createNativeMiningRun } from "../mining/host.ts";
import { createCivilianDistributionRun } from "../distribution/backend.ts";
import { CivilianMissionCompleted, CivilianMissionMismatch } from "../civilian/acceptedMission.ts";
import { listCivilianHosted, continueCivilianMission } from "../restored/app/api.ts";

for (const kind of ["mining", "distribution"] as const) {
  test(
    kind + " Continue keeps the original accepted checkpoint after a failed connection",
    async () => {
      const setup =
        kind === "mining"
          ? { agent: { mode: "manual", agentID: 42 }, missionCount: 1 }
          : {
              agent: { mode: "manual", agentID: 42, stationID: 600 },
              missionCount: 1,
              maxJumps: 4,
            };
      const mission = { agentID: 42, missionID: 901, key: "original-mission" };
      const original: CivilianIndexRow = {
        worldID: "world",
        owner: "pilot",
        characterID: 7,
        botID: "original",
        kind,
        status: "stopped",
        phase: "Docked",
        pending: null,
        firstFailure: null,
        resolved: false,
        updatedAt: 1,
        setup,
        worker: {
          startedAt: "",
          expiresAt: null,
          characterName: "Pilot",
          why: null,
          readout: { acceptedMission: mission },
        },
      };
      let data: unknown = null,
        connecting = false;
      const doc = {
        read: () => structuredClone(data),
        write: (v: unknown) => {
          data = structuredClone(v);
        },
      };
      const index = createCivilianIndex(doc);
      index.put(original);
      const route = createCivilianCheckpointsRoute(
        () => ({ doc, close() {} }),
        () => [original],
      );
      let submitted: any;
      const baseUrl = "http://fixture",
        fetch: typeof globalThis.fetch = async (input, init) => {
          const path = new URL(String(input), baseUrl).pathname;
          if (path.endsWith("/checkpoints"))
            return Response.json(
              (await route({ worldID: "world", account: { username: "Pilot" } } as any)).body,
            );
          if (path.endsWith("/world")) return Response.json({ ok: true, worldID: "world" });
          if (path.endsWith("/characters"))
            return Response.json({
              ok: true,
              account: "Pilot",
              characters: [{ characterID: 7, name: "Pilot" }],
            });
          if (path.endsWith("/ownership"))
            return Response.json({
              ok: true,
              ownership: { characterID: 7, owner: "OFF", online: false },
            });
          if (path.endsWith("/check"))
            return Response.json({
              ok: true,
              setup: JSON.parse(String(init?.body)).setup,
              policy: { riskClasses: [], restartSafe: false },
            });
          if (path.endsWith("/bots/start")) {
            submitted = JSON.parse(String(init?.body));
            return Response.json({ ok: true, bot: { botID: "next", characterID: 7 } });
          }
          if (path.endsWith("/bots"))
            return Response.json({
              ok: true,
              hostedRunPolicy: { maxRuntimeMinutes: 60 },
              bots: connecting
                ? [
                    {
                      botID: "attempt",
                      characterID: 7,
                      expiresAt: new Date(Date.now() + 600_000).toISOString(),
                    },
                  ]
                : [],
            });
          throw Error("Unexpected request " + path);
        };
      const controls = async () =>
        (await listCivilianHosted({ baseUrl, fetch })).bots
          .filter((b) => b.canContinue)
          .map((b) => b.civilianCheckpointID);
      assert.deepEqual(await controls(), ["original"]);
      const unavailable = async () => {
        throw Error("Temporary pilot connection failure");
      };
      const worker =
        kind === "mining"
          ? createNativeMiningRun({ attach: unavailable })
          : createCivilianDistributionRun({ attach: unavailable });
      connecting = true;
      for (const attemptSetup of [
        setup,
        { ...setup, continuation: { ...mission, botID: "original" } },
      ]) {
        await assert.rejects(
          async () =>
            withCivilianPolicy(worker, kind, { write: (row) => index.put(row) }).start({
              setup: attemptSetup,
              botID: "attempt",
              characterID: 7,
              held: { characterID: 7 },
              fetch,
              baseUrl,
              report() {},
            } as any),
          /Temporary pilot connection failure/,
        );
      }
      connecting = false;
      assert.deepEqual(await controls(), ["original"]);
      const card = (await listCivilianHosted({ baseUrl, fetch })).bots.find((b) => b.canContinue)!;
      await continueCivilianMission(card, { baseUrl, fetch });
      assert.equal(submitted.characterID, 7);
      assert.equal(submitted.run, "civilian-" + kind);
      assert.equal(submitted.setup.missionCount, 1);
      assert.deepEqual(submitted.setup.continuation, { ...mission, botID: "original" });

      const afterFailure = doc.read();
      for (const terminal of [
        new CivilianMissionCompleted("already handed in"),
        new CivilianMissionMismatch("mission changed"),
      ]) {
        doc.write(afterFailure);
        const verified = {
          check: worker.check,
          start: async () => {
            throw terminal;
          },
        };
        const start = () =>
          withCivilianPolicy(verified, kind, { write: (row) => index.put(row) }).start({
            setup: submitted.setup,
            botID: "next",
            characterID: 7,
            held: { characterID: 7 },
            baseUrl,
            fetch,
            report() {},
          } as any);
        if (terminal instanceof CivilianMissionCompleted) await start();
        else await assert.rejects(async () => start(), /mission changed/);
        assert.deepEqual(await controls(), []);
        await assert.rejects(
          continueCivilianMission(card, { baseUrl, fetch }),
          /newer Civilian run/,
        );
      }
    },
  );
}
test("checked parking policy survives readout without inventing dock or release state", async () => {
  let result: any;
  const executor = withCivilianPolicy({
    check: (v) => ({
      ok: true,
      setup: v as any,
      name: "Fixture",
      policy: { riskClasses: [], restartSafe: false },
    }),
    start: async (run) => {
      run.report({
        status: "paused",
        phase: "Mining",
        readout: { pending: "COMPLETE", completedCount: 0 },
      });
      return { stop() {} };
    },
  });
  await executor.start({
    setup: { parking: { mode: "selected", destinationID: 9, kind: "station", systemID: 10 } },
    report: (v: any) => (result = v),
  } as any);
  assert.equal(result.status, "paused");
  assert.deepEqual(result.readout, {
    pending: "COMPLETE",
    completedCount: 0,
    parkingPolicy: { mode: "selected", destinationID: 9, kind: "station", systemID: 10 },
  });
  assert.equal(result.readout.parking, undefined);
});
test("verified world and owner are indexed on the first report and pending survives a later bare report", async () => {
  const rows: any[] = [];
  let reports = 0;
  const executor = withCivilianPolicy(
    {
      check: (v) => ({
        ok: true,
        setup: v as any,
        name: "Fixture",
        policy: { riskClasses: [], restartSafe: false },
      }),
      start: async (run) => {
        run.report({ status: "paused", phase: "Pending", readout: { pending: "complete" } });
        run.report({ status: "paused", phase: "Still pending" });
        return { stop() {} };
      },
    },
    "mining",
    { owner: async () => "Pilot", write: (r) => rows.push(structuredClone(r)) },
  );
  await executor.start({
    botID: "bot",
    characterID: 3,
    held: { characterID: 3 },
    baseUrl: "http://bff",
    setup: {},
    fetch: async () => Response.json({ ok: true, worldID: "world-a" }),
    report() {
      reports++;
    },
  } as any);
  assert.equal(rows[0].owner, "pilot");
  assert.equal(rows[0].worldID, "world-a");
  assert.equal(rows.at(-1).pending, "complete");
  assert.equal(rows.at(-1).resolved, false);
  assert.equal(reports, 2);
});
