"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createApp } = require("../src/server");
const { createBridgeSessionJournal } = require("../src/bridgeSessionJournal");

function tempJournal(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-journal-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "bridge-sessions.json");
}

function records(filePath) {
  const files = fs.existsSync(filePath) ? [filePath] : [];
  if (fs.existsSync(`${filePath}.owners`)) files.push(...fs.readdirSync(`${filePath}.owners`)
    .filter((name) => name.endsWith(".json")).map((name) => path.join(`${filePath}.owners`, name)));
  return files.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")).sessions);
}

function appFixture(filePath, gateway) {
  const app = createApp({ bridgeSessionJournalPath: filePath,
    eveStore: { async getCharacterForAccount(accountID, characterID) { return { accountID, characterID }; } },
    eveGatewayClient: gateway, errorLogger() {},
    staticData: { getStation() { return {}; }, getTypeName() { return null; } },
  });
  const select = app.router.stack.find((layer) => layer.route?.path === "/api/bridge/select").route.stack.at(-1).handle;
  return { app, async select(characterID) {
    let payload, failure;
    await select({ body: { characterID }, account: { accountID: 4, username: "synthetic" },
      webSessionID: "synthetic-tab", get() { return undefined; } },
    { status() { return this; }, json(value) { payload = value; } }, (error) => { failure = error; });
    if (failure) throw failure;
    assert.equal(payload.ok, true);
  } };
}

test("a failed release while switching pilots retains both exact recovery handles", async (t) => {
  const filePath = tempJournal(t);
  const releases = [];
  const gateway = {
    async selectCharacter([characterID]) {
      return { bridgeSessionID: `bridge-${characterID}`, session: { characterID, stationID: 60000001 }, notifications: [] };
    },
    async releaseBridgeSession(handle) {
      releases.push(handle);
      throw Object.assign(new Error("offline before dispatch"), { code: "EVE_GATEWAY_UNREACHABLE" });
    },
  };
  const fixture = appFixture(filePath, gateway);
  await fixture.select(7);
  fixture.app.locals.bridgeSessions.get("synthetic-tab").droneRecoveryReady = true;
  await fixture.select(8);
  assert.deepEqual(releases, ["bridge-7"]);
  assert.equal(fixture.app.locals.bridgeSessions.get("synthetic-tab").characterID, 8, "best-effort switching still works");
  assert.deepEqual(records(filePath).map((row) => [row.bridgeSessionID, row.accountID, row.characterID]).sort(),
    [["bridge-7", 4, 7], ["bridge-8", 4, 8]]);
});

test("a selected session outside the browser map can be released after its process exits", async (t) => {
  const filePath = tempJournal(t);
  const sourceRoot = path.resolve(__dirname, "..");
  // A real child PID exits with a selected session, exactly as a process crash
  // would. Only its synthetic gateway and private journal are involved.
  const program = `
    const {createBridgeSessionJournal}=require(process.argv[1]+'/src/bridgeSessionJournal');
    const {journaledPilotTransport}=require(process.argv[1]+'/src/journaledPilotTransport');
    const filePath=process.argv[2];
    const gateway = { async selectCharacter([characterID]) {
      return { bridgeSessionID: 'selected-9', session: { characterID } };
    } };
    const tracked = journaledPilotTransport(gateway, createBridgeSessionJournal({ filePath }));
    tracked.selectCharacter([9, null, true], null, { userid: 4 }).then(() => {
      require('node:fs').writeSync(1, 'session-acquired');
      process.exit(0);
    }).catch(error=>{console.error(error);process.exit(1);});
  `;
  const result = execFileSync(process.execPath, ["-e", program, sourceRoot, filePath], {
    encoding: "utf8", env: { ...process.env }, timeout: 10000,
  });
  assert.match(result, /session-acquired/);
  assert.deepEqual(records(filePath).map((row) => row.bridgeSessionID), ["selected-9"]);
  const calls = [];
  const restarted = createBridgeSessionJournal({ filePath });
  const outcome = await restarted.releaseOrphans(async (handle, fields) => {
    calls.push([handle, fields.userid]); return { released: true };
  });
  assert.deepEqual(calls, [["selected-9", 4]]);
  assert.equal(outcome.released, 1);
  assert.deepEqual(records(filePath), []);
});
