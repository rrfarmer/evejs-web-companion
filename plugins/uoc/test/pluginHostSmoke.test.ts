import assert from "node:assert/strict";
import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { createPluginHost } = createRequire(import.meta.url)("../../../src/pluginHost.js");
const rootDir = fileURLToPath(new URL("../../../", import.meta.url));

test("Farmer's Plugin Host registers UOC and serves its data routes from a temporary directory", { timeout: 20_000 }, async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "wc77-uoc-smoke-"));
  const exits: Promise<unknown>[] = [];
  let uoc:ChildProcess|undefined;
  const startChild = (module: string | URL, args: readonly string[], options: ForkOptions) => {
    const child = fork(module, args, options);
    if(path.basename(options.env?.EVEJS_PLUGIN_DATA_DIR??"")==="uoc")uoc=child;
    exits.push(once(child, "exit"));
    return child;
  };
  const host = createPluginHost({ rootDir, dataDir, activateWebStack: true, fork: startChild, backoffMs: [10] });
  t.after(async () => {
    host.stop();
    await Promise.allSettled(exits);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  });

  await host.start();
  assert.equal(host.has("uoc"), true);
  const account = { accountID: 1, username: "fixture" };
  const read = (requestPath: string) => host.request("uoc", { method: "GET", path: requestPath, query: {}, body: null, account });
  const world = await read("/world");
  assert.equal(world.status, 200);
  assert.match(world.body.worldID, /^wc-install:[a-f0-9]{64}$/);
  const civilian = await read("/civilian/profiles");
  assert.equal(civilian.status, 200);
  assert.deepEqual(civilian.body.profiles, []);
  const distribution = await read("/logistics");
  assert.equal(distribution.status, 200);
  assert.equal(distribution.body.ok, true);
  await t.test("MCC retries in the same backend after its SQLite file becomes available", async () => {
    const child = uoc;
    assert.ok(child);
    const definitions = path.join(dataDir, "plugins", "uoc", "restored-mining-definitions.sqlite");
    mkdirSync(definitions);
    try {
      const failed = await read("/mining-operations");
      assert.equal(failed.status, 500);
      assert.equal(failed.body.error, "PLUGIN_ERROR");
      assert.match(failed.body.message, /open.*database/i);
    } finally {
      rmdirSync(definitions);
    }

    const recovered = await read("/mining-operations");
    assert.equal(recovered.status, 200, recovered.body.message);
    assert.equal(recovered.body.ok, true);
    assert.deepEqual(recovered.body.operations, []);
    assert.equal(uoc, child);
  });

  await t.test("signed-in requests cannot reach Combat Operations Center routes", async () => {
    const root = "/combat-operations";
    const op = root + "/fixture-op";
    const definition = {
      name: "Security", mode: "SECURITY_MISSION", durationMinutes: 60,
      members: [{ accountName: account.username, characterID: 1, role: "AUTO", required: true, preparation: {} }],
      objective: { ownerCharacterID: 1, agentID: 123, level: 1, levelRule: "EXACT", stopRule: "COUNT", missionCount: 1 },
      parking: { mode: "NEAREST" },
    };
    const requests: [string, string, object?][] = [
      ["GET", root], ["POST", root, definition], ["POST", root, { ...definition, operationID: "fixture-op", revision: 1 }],
      ["POST", op + "/review"], ["POST", op + "/start"], ["POST", op + "/group/start"],
      ["POST", op + "/group/fixture-epoch/1/dispatch"], ["POST", op + "/stop"], ["POST", op + "/delete"],
      ["GET", "/security/1/progress"], ["GET", "/security/1/history"], ["GET", "/security/1/receipts"],
      ["GET", "/fleet-security/1/progress"],
    ];
    for (const [method, path, body] of requests) {
      const result = await host.request("uoc", { method, path, query: {}, body: body ?? null, account });
      assert.equal(result.status, 404, method + " " + path);
      assert.equal(result.body.error, "NOT_FOUND", method + " " + path);
    }
  });

  const start = (run: string, setup: unknown, resumed = false) => host.startRun("uoc", {
    run, botID: "fixture-" + run, characterID: 1, held: { characterID: 1 }, setup,
    resumed, resumeData: null, baseUrl: "http://fixture.invalid",
  });
  await t.test("Plugin Host refuses to check, start or resume every Combat Operations Center run", async () => {
    for (const run of ["coc-security", "coc-fleet-inspect", "security-fleet-owner", "security-fleet-assistant",
      "anomaly-fleet-inspect", "anomaly-fleet-member", "combat-patrol-member"]) {
      const refusal = `This plugin has no run called "${run}".`;
      assert.deepEqual(await host.checkRun("uoc", run, {}), { ok: false, code: "PLUGIN_RUN_INVALID", refusal });
      assert.equal(await start(run, {}), refusal);
      assert.equal(await start(run, {}, true), refusal);
    }
  });

  await t.test("Combat preparation is unavailable while MCC Defender and its preparation remain registered", async () => {
    const prep = {
      operationID: "fixture-op", operationRunID: "fixture-epoch", role: "COMBAT",
      reviewOnly: true, verifyEquipment: true, preparation: { source: { kind: "hangar" }, suppliesRequired: false },
    };
    const refusal = "Combat Operations Center is in development.";
    assert.deepEqual(await host.checkRun("uoc", "mcc-prepare", prep), { ok: false, code: "PLUGIN_RUN_INVALID", refusal });
    assert.equal(await start("mcc-prepare", prep), refusal);
    assert.equal((await host.checkRun("uoc", "mcc-prepare", { ...prep, role: "DEFENDER" })).ok, true);
    const defender = await host.checkRun("uoc", "mcc-defender", {
      operationID: "fixture-op", operationRunID: "fixture-epoch", systemID: 300, destinationID: 600,
      corporationID: 77, division: 1, beltID: 99, beltName: "belt", canCapacityM3: 100,
      members: [{ characterID: 1, shipID: 11, role: "MINER" }, { characterID: 2, shipID: 12, role: "HAULER" },
        { characterID: 3, shipID: 13, role: "DEFENDER" }],
    });
    assert.equal(defender.ok, true);
    assert.ok(defender.policy.riskClasses.includes("combat"));
  });

  await t.test("Plugin Host restarts UOC after cleanup and reads the same transport roster",async()=>{
    await host.request("uoc",{method:"POST",path:"/logistics/roster",query:{},account,
      body:{characterID:3,name:"Carrier",account:account.username,shipName:"Hauler",corporationID:77,corporationName:"Test corp"}});
    const before=await read("/logistics");
    assert.equal(before.body.roster[0]?.characterID,3);
    assert.ok(uoc);
    const child=uoc;
    const cleaned=new Promise<void>((resolve,reject)=>{
      const onReply=(reply:any)=>{
        if(reply?.type!=="done"||reply.id!==-1)return;
        child.off("message",onReply);
        if(reply.error)reject(new Error(reply.error));else resolve();
      };
      child.on("message",onReply);
    });
    child.send({type:"cleanup",id:-1});
    await cleaned;
    const exited=once(child,"exit");
    child.kill(); // End only this fixture child. The running Plugin Host starts its replacement.
    await exited;
    assert.deepEqual((await read("/logistics")).body,before.body);
    assert.notEqual(uoc,child);
    assert.equal((await read("/mining-operations")).status,200);
  });
});
