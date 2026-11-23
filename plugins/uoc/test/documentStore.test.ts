import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMiningMissionRuns } from "../mining/checkpoint.ts";
import type { MiningMissionState } from "../shared/missionTypes.ts";

const require = createRequire(import.meta.url);
const { createDocumentStore } = require("../documentStore.cjs");
const root = fileURLToPath(new URL("../../../", import.meta.url));

test("durable document commits work under the actual plugin permissions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uoc-permissions-"));
  try {
    const script = `
      const assert = require("node:assert/strict");
      const { createDocumentStore } = require(process.argv[1]);
      const db = createDocumentStore(process.argv[2]);
      db.document("intent").write({ dispatched: true });
      db.close();
      const reopened = createDocumentStore(process.argv[2]);
      assert.deepEqual(reopened.document("intent").read(), { dispatched: true });
      reopened.close();
    `;
    const result = spawnSync(process.execPath, [
      "--permission", "--allow-addons",
      `--allow-fs-read=${path.join(root, "plugins", "uoc")}`,
      `--allow-fs-read=${path.join(root, "node_modules")}`,
      `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`,
      "-e", script, path.join(root, "plugins", "uoc", "documentStore.cjs"), path.join(dir, "journal.sqlite"),
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy Mining custody is retained when SQLite takes over and replay stays fenced", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uoc-journal-migration-"));
  const filePath = path.join(dir, "mining.json");
  const database = path.join(dir, "missions.sqlite");
  const scope = { accountID: 1, characterID: 2, scriptHash: "same", epoch: "run", assertCurrent: () => true };
  const state = { version: 2, revision: 1, epoch: "run", characterID: 2, phase: "request",
    pending: { id: "request-1", kind: "request" } } as MiningMissionState;
  let db = createDocumentStore(database);
  try {
    const legacy = createMiningMissionRuns({ filePath }).open(scope);
    await legacy.save(state);
    await legacy.dispatch("request-1");
    const original = fs.readFileSync(filePath, "utf8");
    const migrated = createMiningMissionRuns({ filePath, storage: db.document("mining") }).open(scope);
    assert.equal(migrated.read().receipt?.acknowledged, false);
    await migrated.acknowledge("request-1");
    assert.equal(fs.readFileSync(filePath, "utf8"), original);
    db.close();
    db = createDocumentStore(database);
    const restored = createMiningMissionRuns({ filePath, storage: db.document("mining") }).open(scope);
    assert.equal(restored.read().receipt?.acknowledged, true);
    await assert.rejects(restored.dispatch("request-1"), /no replay/);
  } finally {
    db.close();
    assert.equal(path.dirname(dir), os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
