import test from "node:test";
import assert from "node:assert/strict";
import { listCivilianHosted, checkMiningMissionRecovery } from "./api.ts";
import { installPageContext } from "./context.ts";
import { civilianSessionStore, civilianScope, currentCivilianWorker } from "./civilianSession.ts";
import type { ServerBot } from "./api.ts";

let serial = 0;
test("Civilian workspace and worker names survive reload while old tab tokens are discarded", () => {
  const key = "uoc:restored:civilian-accounts:v1";
  const values = new Map([
    [
      key,
      JSON.stringify({
        control: { name: "Control", token: "old-token" },
        workers: [{ name: "Worker", token: "old-worker-token" }],
      }),
    ],
  ]);
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
    removeItem: (k: string) => {
      values.delete(k);
    },
  };
  const original = { control: "Control", workers: ["Worker"] };
  const restored = civilianSessionStore(() => storage).load();
  assert.deepEqual(restored, original);
  assert.deepEqual(JSON.parse(values.get(key)!), original);
  assert.deepEqual(civilianScope("Control", restored).workers, ["Worker"]);
  assert.deepEqual(civilianScope("Other", restored).workers, []);
  civilianSessionStore(() => storage).save({ control: "Control", workers: ["Worker", "Next"] });
  assert.deepEqual(civilianSessionStore(() => storage).load()?.workers, ["Worker", "Next"]);
});
test("restores a released Miner from durable scoped evidence after host loss; F5 hydrates names and retains Recovery", async () => {
  const world = "civilian-fixture-" + ++serial,
    requests: string[] = [];
  let offline = false,
    foreign = false,
    legacy = false;
  const worker = {
    worldID: world,
    owner: "fixtureminer1",
    characterID: 141100100,
    botID: "retained",
    kind: "mining",
    status: "paused",
    phase: "Docked",
    pending: null,
    firstFailure: "Accepted cycle unresolved; no Activate replay.",
    resolved: false,
    updatedAt: 1735689600000,
    ownerAvailable: false,
    worker: {
      startedAt: "2025-01-01T00:00:00Z",
      expiresAt: "2025-01-04T00:00:00Z",
      characterName: null,
      why: "Docking confirmed",
      readout: {
        agentID: 51,
        mission: 4800,
        completedCount: 0,
        pending: null,
        legacyCycle: true,
        recoveryRequired: true,
        firstFailure: "Accepted cycle unresolved; no Activate replay.",
        parking: { state: "DOCKED", destinationID: 60000021, kind: "station" },
        parkingPolicy: { mode: "nearest" },
      },
    },
  };
  installPageContext({
    fetch: async (input, init) => {
      const u = new URL(String(input), "http://fixture");
      requests.push((init?.method ?? "GET") + " " + u.pathname);
      let body: any;
      if (u.pathname === "/api/plugins/uoc/world") body = { ok: true, worldID: world };
      else if (u.pathname === "/api/bots") body = { ok: true, bots: [] };
      else if (u.pathname === "/api/pilot-training/characters")
        body = {
          ok: true,
          account: "FixtureMiner1",
          characters: [{ characterID: 141100100, name: "FixtureMiner1" }],
        };
      else if (u.pathname === "/api/pilot-training/ownership")
        body = {
          ok: true,
          ownership: {
            characterID: 141100100,
            owner: offline ? "OFF" : "UNKNOWN",
            online: !offline,
          },
        };
      else if (u.pathname === "/api/plugins/uoc/civilian/checkpoints")
        body = {
          ok: true,
          history: [
            {
              ...worker,
              worldID: foreign ? "foreign" : world,
              ...(legacy ? { worker: undefined } : {}),
            },
          ],
          recovery: [{ pin: "retained", characterID: 141100100, idle: false }],
          legacyNotice: "Unscoped legacy custody retained.",
        };
      else if (u.pathname === "/api/agents/find")
        body = {
          ok: true,
          agents: [
            {
              agentID: 51,
              name: "Fixture Agent",
              corporationID: 1000061,
              corporationName: "Fixture Corporation",
            },
          ],
        };
      else if (u.pathname === "/api/map/resolve/60000021")
        body = {
          ok: true,
          kind: "station",
          stationName: "Verified dock",
          systemName: "Verified system",
        };
      else if (u.pathname.endsWith("/retained/check"))
        body = {
          ok: true,
          recovery: {
            pin: "retained",
            characterID: 141100100,
            scope: "STORED_ONLY",
            nativeReconciled: false,
            cycle: "UNKNOWN",
            reason: "Exact owner unavailable; no login or replay.",
          },
        };
      else throw Error("Unexpected request " + u.pathname);
      return Response.json(body);
    },
  });
  try {
    let b = (await listCivilianHosted()).bots[0]!;
    assert.equal(b.characterName, "FixtureMiner1");
    assert.equal(b.missionProgress?.agentName, "Fixture Agent");
    assert.equal(b.missionProgress?.corporationName, "Fixture Corporation");
    assert.equal(b.missionProgress?.missionName, "Claimjumpers");
    assert.equal(b.missionProgress?.completedCount, 0);
    assert.equal(b.parking?.phase, "RELEASING");
    assert.equal(b.ownerRelease, "UNCONFIRMED");
    assert.equal(b.civilianView, "RECOVERY");
    offline = true;
    b = (await listCivilianHosted()).bots[0]!;
    assert.equal(b.ownerRelease, "VERIFIED");
    assert.equal(b.parking?.phase, "PARKED");
    assert.equal(b.civilianView, "RECOVERY");
    assert.equal(b.lastMissionReward, null);
    assert.match(b.missionRecovery ?? "", /unresolved/);
    const checked = await checkMiningMissionRecovery(
      { pin: "retained", characterID: 141100100, idle: false },
      false,
    );
    assert.equal(checked.cycle, "UNKNOWN");
    assert.equal(checked.nativeReconciled, false);
    assert.ok(!requests.some((r) => /login|\/start|bridge|select/.test(r)));
    assert.equal(b.parkingDestination?.name, "Verified dock");
    assert.equal(requests.filter((r) => r.endsWith("/api/map/resolve/60000021")).length, 1);
    legacy = true;
    b = (await listCivilianHosted()).bots[0]!;
    assert.equal(b.characterName, "FixtureMiner1");
    assert.equal(b.missionProgress?.completedCount, null);
    assert.equal(b.civilianView, "RECOVERY");
    foreign = true;
    await assert.rejects(listCivilianHosted(), /identity differs/);
  } finally {
    installPageContext({});
  }
});

test("Continue appears only for the latest accepted worker with the account released", async () => {
  let occupied = false,
    resolved = false;
  const acceptedMission = { agentID: 42, missionID: 901, key: "accepted-delivery" };
  const row = {
    botID: "current",
    worldID: "continue-fixture",
    owner: "pilot",
    characterID: 7,
    kind: "distribution",
    status: "stopped",
    phase: "Docked",
    ownerAvailable: false,
    acceptedMission,
    setup: { missionCount: 6 },
    updatedAt: 60,
  };
  installPageContext({
    fetch: async (input) => {
      const p = new URL(String(input), "http://fixture").pathname;
      if (p === "/api/bots")
        return Response.json({
          ok: true,
          bots: occupied ? [{ botID: "other", characterID: 8, endedAt: null }] : [],
        });
      if (p.endsWith("/world")) return Response.json({ ok: true, worldID: row.worldID });
      if (p.endsWith("/characters"))
        return Response.json({
          ok: true,
          account: "Pilot",
          characters: [{ characterID: 7, name: "Pilot" }],
        });
      if (p.endsWith("/ownership"))
        return Response.json({
          ok: true,
          ownership: { characterID: 7, owner: "OFF", online: false },
        });
      if (p.endsWith("/checkpoints"))
        return Response.json({
          ok: true,
          recovery: [],
          history: [
            {
              ...row,
              resolved,
              acceptedMission: resolved ? null : acceptedMission,
              phase: resolved ? "Completed" : "Docked",
            },
            { ...row, botID: "previous", updatedAt: 30, resolved: false },
          ],
        });
      throw Error(p);
    },
  });
  try {
    let [current, previous] = (await listCivilianHosted()).bots;
    assert.equal(current?.canContinue, true);
    assert.equal(current?.civilianStatus, "Stopped · Mission accepted");
    assert.equal(current?.missionID, 901);
    assert.equal(previous?.canContinue, false);
    occupied = true;
    [current] = (await listCivilianHosted()).bots;
    assert.equal(current?.canContinue, false);
    occupied = false;
    resolved = true;
    [current] = (await listCivilianHosted()).bots;
    assert.equal(current?.canContinue, false);
    assert.equal(current?.civilianStatus, "Completed");
  } finally {
    installPageContext({});
  }
});

test("the saved pilot card keeps the active or stopped accepted run ahead of a newer history row", () => {
  const worker = (botID: string, endedAt: string | null, hasAcceptedMission = false) => ({
    bot: {
      botID,
      characterID: 7,
      endedAt,
      startedAt: "2026-11-22T12:00:00Z",
      hasAcceptedMission,
    } as ServerBot,
  });
  const active = worker("running", null),
    accepted = worker("accepted", "2026-11-22T13:00:00Z", true),
    prior = worker("closed", "2026-11-22T14:00:00Z");
  assert.equal(currentCivilianWorker([prior, active, accepted]), active);
  assert.equal(currentCivilianWorker([prior, accepted]), accepted);
  assert.equal(currentCivilianWorker([prior]), prior);
});
