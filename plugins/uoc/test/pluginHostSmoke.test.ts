import assert from "node:assert/strict";
import { fork, type ForkOptions } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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
  const startChild = (module: string | URL, args: readonly string[], options: ForkOptions) => {
    const child = fork(module, args, options);
    exits.push(once(child, "exit"));
    return child;
  };
  const host = createPluginHost({ rootDir, dataDir, activateWebStack: true, fork: startChild });
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
  const mcc = await read("/mining-operations");
  assert.equal(mcc.status, 200);
  assert.equal(mcc.body.ok, true);
});
