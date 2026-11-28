import test from "node:test";
import assert from "node:assert/strict";
import { createPatrolRuns } from "./host.ts";
test("host resolves exact gate catalogue, starts one shared patrol, and reports only after native dock proof", async () => {
  const docs = new Map<string, unknown>(),
    reports: any[] = [],
    seen: any[] = [];
  const document = (name: string) => ({
      read: () => docs.get(name) ?? null,
      write: (v: unknown) => {
        docs.set(name, structuredClone(v));
      },
    }),
    session: any = {
      store: { station: { get: () => ({ online: { characterID: 1 } }) } },
      flow: {
        requestOptions: () => ({}),
        setLivePush() {},
        flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
      },
    };
  const setup = {
    operationID: "op",
    operationRunID: "epoch",
    leaderID: 1,
    systemID: 30000143,
    mode: "GATE_PATROL",
    observationSeconds: 30,
    parking: { mode: "nearest" },
    members: [{ characterID: 1, shipID: 3 }],
  };
  const run: any = {
    botID: "patrol-host-test",
    characterID: 1,
    held: { characterID: 1 },
    setup,
    baseUrl: "http://test",
    report: (v: any) => reports.push(v),
    fetch: async (input: any) => {
      const p = new URL(String(input)).pathname;
      if (p === "/api/pilot-training/characters")
        return Response.json({ ok: true, account: "Test1", characters: [{ characterID: 1 }] });
      if (p === "/api/bots")
        return Response.json({
          ok: true,
          bots: [
            {
              botID: run.botID,
              characterID: 1,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            },
          ],
        });
      if (p === "/api/client-data/type-prices")
        return Response.json({ ok: true, groupID: { 645: 27 }, categoryID: { 645: 6 } });
      if (p === "/api/bridge/flight/status")
        return Response.json({
          ok: true,
          flight: {
            shipID: 3,
            shipTypeID: 645,
            solarSystemID: 30000143,
            docked: true,
            inSpace: false,
            stationID: 600,
          },
        });
      if (p === "/api/client-data/system-objects/30000143")
        return Response.json({
          ok: true,
          available: true,
          objects: [
            { itemID: 8, typeID: 16, groupID: 10, destinationID: 30000142 },
            { itemID: 9, typeID: 17, groupID: 9 },
          ],
        });
      if (p === "/api/names")
        return Response.json({ ok: true, names: { "evelocation:30000142": "Destination" } });
      throw Error(`Unexpected ${p}`);
    },
  };
  let stopped = false;
  const host = createPatrolRuns({
      document,
      attach: async () => session,
      peer: (() => ({
        characterID: 1,
        shipID: 3,
        botID: run.botID,
        sessionGeneration: 1,
        current() {},
      })) as any,
      operation: ((c: any) => {
        seen.push(c.waypoints);
        return {
          tick: async () => {
            stopped = true;
          },
          stop: async () => {},
          snapshot: () => ({ state: stopped ? "STOPPED" : "FORMING" }),
        };
      }) as any,
      sleep: async () => {},
    }),
    check: any = host.member.check(setup);
  assert.equal(check.ok, true);
  const handle = await host.member.start(run);
  for (let i = 0; i < 20 && !reports.some((r) => r.status === "stopped"); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [
    [{ systemID: 30000143, itemID: 8, groupID: 10, name: "Stargate (Destination)" }],
  ]);
  const stoppedReport = reports.find((r) => r.status === "stopped" && r.phase === "Patrol docked");
  assert.ok(stoppedReport);
  assert.deepEqual(stoppedReport.readout.anchor, { characterID: 1, shipID: 3, size: 5 });
  assert.equal(
    reports.some((r) => r.readout?.completion),
    false,
  );
  await handle.stop();
});
