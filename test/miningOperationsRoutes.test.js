"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { once } = require("events");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-mining-operation-routes-"));
process.env.EVEJS_WEB_POC_DATA_DIR = dataDir;

const webAuth = require("../src/webAuth");
const { createApp } = require("../src/server");
const { createBeltMemory } = require("../src/beltMemory");
const { createMiningOperationStore } = require("../src/miningOperationStore");
const { createMiningTargetBoard } = require("../src/miningTargetBoard");
const { createMiningOperations } = require("../src/miningOperations");

const account = { username: "miner-account", accountID: 4001, role: "0", banned: false };
const character = { characterID: 7001, accountID: 4001, characterName: "Miner One" };
const crew = [character, { characterID: 7002, accountID: 4001, characterName: "Miner Two" }, { characterID: 7003, accountID: 4001, characterName: "Cargo One" }];
const script = {
  scriptID: "mining-script",
  name: "Operation miner",
  rev: 1,
  doc: {
    format: "evejs-bot-script",
    program: [
      { id: "mine", kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "nearest" } } } },
      { id: "deliver", kind: "macro", macro: "deliver-ore", args: {} },
    ],
  },
};
const pinnedScript = {
  scriptID: "pinned-belt-script", name: "Fixed Belt I", rev: 1,
  doc: { program: [
    { kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "chosen", name: "Belt I" } } } },
    { kind: "macro", macro: "deliver-ore", args: {} },
  ] },
};
const crewMinerScript = { scriptID: "crew-miner", name: "Operation jetcan miner", rev: 1, doc: {
  program: [
    { kind: "macro", macro: "mine-at-belt", args: { belt: { kind: "belt", belt: { mode: "nearest" } } } },
    { kind: "macro", macro: "jettison-ore", args: {} },
  ],
} };
const crewHaulerScript = { scriptID: "crew-hauler", name: "Operation hauler", rev: 1, doc: {
  program: [
    { kind: "macro", macro: "travel-to-belt", args: { belt: { kind: "belt", belt: { mode: "nearest" } } } },
    { kind: "macro", macro: "loot-containers", args: {} },
    { kind: "macro", macro: "deliver-ore", args: {} },
  ],
} };

function fakeHost(heldSessions = new Map()) {
  const rows = [];
  const stops = [];
  const inputs = [];
  const extensions = [];
  const failures = new Map();
  const events = [];
  return {
    rows,
    stops,
    inputs,
    extensions,
    failures,
    events,
    async start(input) {
      inputs.push(input);
      if (failures.has(input.characterID)) return { ok: false, ...failures.get(input.characterID) };
      if ([...heldSessions].some(([sessionID, held]) => Number(held.characterID) === input.characterID && sessionID !== input.callerSessionID)) {
        return { ok: false, code: "CHARACTER_IN_USE", message: "Another browser session controls this pilot." };
      }
      if (rows.some((row) => row.characterID === input.characterID && row.endedAt === null)) {
        return { ok: false, code: "CHARACTER_IN_USE", message: "Pilot already controlled." };
      }
      if (input.beforeStart) await input.beforeStart();
      const bot = {
        botID: `bot-${input.characterID}`,
        accountID: input.account.accountID,
        characterID: input.characterID,
        characterName: character.characterName,
        operationID: input.operationID,
        operationRole: input.operationRole,
        operationRunID: input.operationRunID,
        preparation: input.operationPreparation ? { state: "VERIFIED", equipment: "VERIFIED", supplies: "FULL", targets: [] } : null,
        deferMain: input.deferMain,
        preparationOwnerAvailable: true,
        status: "running",
        phase: "Starting",
        why: null,
        startedAt: "2026-09-24T00:00:00.000Z",
        endedAt: null,
      };
      rows.push(bot);
      events.push({ kind: "acquired", characterID: input.characterID, operationRunID: input.operationRunID });
      return { ok: true, bot };
    },
    async activateOperationMember(botID, accountID, operationID, operationRunID) {
      const row = rows.find(b => b.botID === botID && b.accountID === accountID && b.operationID === operationID && b.operationRunID === operationRunID && !b.endedAt);
      if (!row) return { ok: false, code: "BOT_NOT_FOUND" };
      events.push({ kind: "activated", characterID: row.characterID, operationRunID });
      row.deferMain = false;
      return { ok: true, bot: row };
    },
    async stop(botID) {
      stops.push(botID);
      const row = rows.find((candidate) => candidate.botID === botID && candidate.endedAt === null);
      if (!row) return { ok: false, code: "BOT_NOT_FOUND" };
      row.endedAt = "2026-09-24T01:00:00.000Z";
      row.status = "stopped";
      return { ok: true, bot: row };
    },
    async extendOperationGrant(...args) { extensions.push(args); return { ok: true, bot: { expiresAt: "2026-09-25T00:00:00Z" } }; },
    async prepareOperationStop(botID, accountID, operationID) {
      return { ok: rows.some(row => row.botID === botID && row.endedAt === null && row.operationID === operationID && row.accountID === accountID) };
    },
    async parkOperationMember(botID) { return this.stop(botID); },
    listAll: () => rows.map((row) => ({ ...row })),
    list: () => rows.map((row) => ({ ...row })),
    claimedBy: characterID => rows.find(row => row.characterID === characterID && !row.endedAt)?.botID || null,
    authorizesClaim: () => false,
    operationForClaim: () => null,
    activeCharacterIDs: () => [],
    activeBots: () => [],
    sampleAllVitals: async () => {},
    resume: async () => {},
    stopAll: async () => {},
  };
}

async function request(baseUrl, route, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test("Mining Operations routes persist definitions, launch through botHost, project status, and stop gracefully", async (t) => {
  const operationStore = createMiningOperationStore({ dataDir, resolveSystem: (id) => ({ 30000142: { solarSystemID: 30000142, solarSystemName: "Jita" }, 30004504: { solarSystemID: 30004504, solarSystemName: "4C-B7X" } })[Number(id)] || null,
    resolveStation: (id) => Number(id) === 60003760 ? { stationID: 60003760, stationName: "Jita IV - Moon 4", solarSystemID: 30000142 } : null });
  const board = createMiningTargetBoard();
  const operations = createMiningOperations({ store: operationStore, targetBoard: board, beltMemory: createBeltMemory() });
  const heldSessions = new Map();
  const host = fakeHost(heldSessions);
  let structureAccessAllowed = true;
  let preparationPlanAwait = null;
  let defenderPreparationBlocked = false;
  const structureAccessCalls = [];
  const app = createApp({
    eveStore: {
      getAccount: async (username) => username === account.username ? { ...account } : null,
      getCharacterForAccount: async (accountID, characterID) =>
        Number(accountID) === account.accountID ? crew.find((row) => row.characterID === Number(characterID)) || null : null,
      listCharactersForAccount: async () => crew.map((row) => ({ ...row })),
    },
    eveGatewayClient: { async callMethod(service, method, args, kwargs, sessionFields) {
      structureAccessCalls.push({ service, method, args, sessionFields });
      const allowed = typeof structureAccessAllowed === "function" ? structureAccessAllowed(sessionFields.characterID) : structureAccessAllowed;
      return { result: { type: "list", items: allowed ? [1030000000001] : [] }, notifications: [] };
    } },
    webAuth,
    botHost: host,
    bridgeSessionStore: heldSessions,
    botScriptStore: {
      get: (scriptID) => [script, pinnedScript, crewMinerScript, crewHaulerScript].find((row) => row.scriptID === scriptID) || null,
      list: () => [script, pinnedScript, crewMinerScript, crewHaulerScript],
    },
    staticData: {
      listMiningResources: () => [{ typeID: 1230, name: "Veldspar", family: "ore" }, { typeID: 16265, name: "White Glaze", family: "ice" }],
      getStation: (id) => Number(id) === 60003760 ? { stationID: 60003760, stationName: "Jita IV - Moon 4", solarSystemID: 30000142 } : null,
      getSolarSystem: (id) => ({ 30000142: { solarSystemID: 30000142, solarSystemName: "Jita" }, 30004504: { solarSystemID: 30004504, solarSystemName: "4C-B7X" } })[Number(id)] || null,
      getSolarSystemName: (id) => ({ 30000142: "Jita", 30004504: "4C-B7X" })[Number(id)] || `System ${id}`,
      findMapLocations: ({ q }) => {
        const matches = [{ id: 30000142, name: "Jita", kind: "system", solarSystemID: 30000142, solarSystemName: "Jita" }, { id: 30004504, name: "4C-B7X", kind: "system", solarSystemID: 30004504, solarSystemName: "4C-B7X" }]
          .filter((row) => row.name.toLowerCase().includes(String(q).toLowerCase()));
        return { q, kind: "system", total: matches.length, capped: false, limit: 50, matches };
      },
    },
    miningOperationStore: operationStore,
    miningTargetBoard: board,
    miningOperations: operations,
    // This legacy routing fixture has no authoritative fitting/inventory
    // projection. Real preparation engines are covered in miningPreparation.test.
    miningPreparation: {
      ready: value => ["VERIFIED", "DEGRADED"].includes(value?.state),
      unresolved: () => false,
      plan: async definition => {
        const accepted = { state: "READY", planHash: JSON.stringify(definition),
          members: definition.members.map(member => ({
            characterID: member.characterID, role: member.role, state: "PENDING", intent: { fixture: true, characterID: member.characterID },
          })) };
        if (defenderPreparationBlocked && definition.members.some(m => m.role === "DEFENDER")) {
          accepted.state = "BLOCKED";
          Object.assign(accepted.members.find(m => m.role === "DEFENDER"), {state:"BLOCKED",reason:"Defender skills NOT_READY"});
        }
        if (preparationPlanAwait) await preparationPlanAwait(definition);
        return accepted;
      },
    },
    errorLogger(error) { throw error; },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const directPage = await fetch(`${baseUrl}/mining-command-center`);
  assert.equal(directPage.status, 200);
  assert.match(directPage.headers.get("content-type"), /text\/html/);
  const login = await request(baseUrl, "/api/login", {
    method: "POST",
    body: { username: account.username, password: "local" },
  });
  const token = login.payload.sessionToken;
  const resources = await request(baseUrl, "/api/mining-operations/resources", { token });
  assert.equal(resources.payload.resources.length, 2);

  const search = await request(baseUrl, "/api/map/find?kind=system&q=4C-B", { token });
  assert.deepEqual(search.payload.matches.map((row) => [row.name, row.id]), [["4C-B7X", 30004504]]);
  const resolved = await request(baseUrl, "/api/map/resolve/30004504", { token });
  assert.equal(resolved.payload.systemName, "4C-B7X");
  const unresolved = await request(baseUrl, "/api/map/resolve/99999999", { token });
  assert.equal(unresolved.payload.kind, "unknown");
  const pilots = await request(baseUrl, `/api/mining-operations/accounts/${account.username}/pilots`, { token });
  assert.equal(pilots.payload.pilots[0].characterID, character.characterID);
  const routineList = await request(baseUrl, "/api/mining-operations/routines?classes=BELT&unloadPolicy=SELF_UNLOAD", { token });
  assert.equal(routineList.payload.routines.find((row) => row.scriptID === script.scriptID).roles.MINER.compatible, true);
  assert.equal(routineList.payload.routines.find((row) => row.scriptID === pinnedScript.scriptID).roles.MINER.compatible, false);

  const operationInput = {
    name: "Route operation",
    area: { anchorSystemID: 30000142, anchorSystemName: "Jita", reach: "CURRENT_SYSTEM", targetClasses: ["BELT"] },
    targetPolicy: "ANY_ELIGIBLE",
    unloadPolicy: "SELF_UNLOAD",
    members: [{ ...character, accountName: account.username, role: "MINER", automationID: script.scriptID }],
  };
  for (const area of [
    { ...operationInput.area, anchorSystemID: 99999999 },
    { ...operationInput.area, anchorSystemName: "Not a system" },
    { ...operationInput.area, anchorSystemID: 30004504 },
  ]) {
    const invalid = await request(baseUrl, "/api/mining-operations", { method: "POST", token, body: { ...operationInput, area } });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.error, "MINING_OPERATION_INVALID");
  }
  const canonical = await request(baseUrl, "/api/mining-operations", { method: "POST", token, body: { ...operationInput, name: "Canonical", area: { ...operationInput.area, anchorSystemID: 30004504, anchorSystemName: null } } });
  assert.equal(canonical.payload.definition.area.anchorSystemName, "4C-B7X");
  const badPreference = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
    body: { ...operationInput, policies: { resourcePolicy: { mode: "PREFER_LIST", typeIDs: [16265] } } } });
  assert.equal(badPreference.response.status, 400);
  const preference = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
    body: { ...operationInput, policies: { resourcePolicy: { mode: "PREFER_LIST", source: "MANUAL", typeIDs: [1230] } } } });
  assert.deepEqual(preference.payload.definition.policies.resourcePolicy.typeIDs, [1230]);

  const incompatible = await request(baseUrl, "/api/mining-operations", { method: "POST", token, body: { ...operationInput, name: "Pinned", members: [{ ...operationInput.members[0], automationID: pinnedScript.scriptID }] } });
  const refused = await request(baseUrl, `/api/mining-operations/${incompatible.payload.definition.operationID}/start`, { method: "POST", token, body: { grants: {} } });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.payload.error, "INCOMPATIBLE_OPERATION_ROUTINE");
  assert.match(refused.payload.message, /pinned belt/);
  assert.equal(host.inputs.length, 0);

  const saved = await request(baseUrl, "/api/mining-operations", {
    method: "POST",
    token,
    body: operationInput,
  });
  assert.equal(saved.response.status, 200);
  const operationID = saved.payload.definition.operationID;

  const missingCustomPin = await request(baseUrl, `/api/mining-operations/${operationID}/start`, {
    method: "POST", token, body: { grants: {} },
  });
  assert.equal(missingCustomPin.payload.error, "OPERATION_LAUNCH_PLAN_STALE", "custom routines also require the combined preparation pin");
  assert.equal(host.inputs.length, 0);

  // The accepted plan still matches the request, but configuration can change
  // while its authoritative preparation reads await. Start must recheck the
  // saved definition before acquisition or crossing the productive barrier.
  const beforeEditPlan = await request(baseUrl, `/api/mining-operations/${operationID}/launch-plan`, { token });
  let editedDuringPlan = false;
  preparationPlanAwait = async acceptedDefinition => {
    preparationPlanAwait = null;
    assert.equal(acceptedDefinition.preparation.suppliesRequired, false);
    const edited = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
      body: { ...acceptedDefinition, preparation: { ...acceptedDefinition.preparation, suppliesRequired: true } } });
    assert.equal(edited.response.status, 200);
    editedDuringPlan = true;
  };
  const editedStart = await request(baseUrl, `/api/mining-operations/${operationID}/start`, { method: "POST", token,
    body: { planHash: beforeEditPlan.payload.planHash,
      grants: { [character.characterID]: { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 60 } } } });
  assert.equal(editedDuringPlan, true);
  assert.equal(editedStart.response.status, 409);
  assert.equal(editedStart.payload.error, "OPERATION_LAUNCH_PLAN_STALE");
  assert.match(editedStart.payload.message, /configuration changed during preflight/);
  assert.equal(operationStore.get(operationID).preparation.suppliesRequired, true);
  assert.equal(operations.runtimeFor(operationID).state, "DRAFT");
  assert.equal(host.inputs.length, 0, "stale accepted preparation never acquires a host owner");
  assert.deepEqual(host.events, [], "stale accepted preparation never activates a member");

  const started = await request(baseUrl, `/api/mining-operations/${operationID}/start`, {
    method: "POST",
    token,
    body: { planHash: (await request(baseUrl, `/api/mining-operations/${operationID}/launch-plan`, { token })).payload.planHash,
      grants: { [character.characterID]: { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 60 } } },
  });
  assert.equal(started.response.status, 200);
  assert.equal(started.payload.operations.find((row) => row.definition.operationID === operationID).runtime.state, "SELECTING");
  assert.equal(host.rows[0].operationID, operationID);
  assert.equal(host.rows[0].operationRole, "MINER");
  assert.equal(host.inputs[0].callerSessionID, null);
  assert.equal(host.inputs[0].operationControllerAccountID, account.accountID);
  const extend = await request(baseUrl, `/api/mining-operations/${operationID}/extend`, { method: "POST", token,
    body: { minutes: 60, botID: "foreign", controllerAccountID: 999 } });
  assert.equal(extend.payload.extension.ok, true);
  assert.deepEqual(host.extensions, [[host.rows[0].botID, operationID, account.accountID, 60]], "body cannot redirect ownership/member selection");
  const runningBeforeAuthLoss = JSON.stringify(host.rows);
  const disconnected = await request(baseUrl, "/api/mining-operations", { token: "expired-token" });
  assert.equal(disconnected.response.status, 401);
  const reconnected = await request(baseUrl, "/api/login", { method: "POST", body: { username: account.username, password: "" } });
  const reread = await request(baseUrl, "/api/mining-operations", { token: reconnected.payload.sessionToken });
  assert.equal(reread.response.status, 200); assert.equal(JSON.stringify(host.rows), runningBeforeAuthLoss); assert.equal(host.stops.length, 0);

  const viewed = await request(baseUrl, "/api/mining-operations", { token });
  assert.equal(viewed.response.status, 200);
  assert.deepEqual(viewed.payload.capabilities.hostedRunPolicy, require("../src/config").hostedRunPolicy);
  const botsPolicy = await request(baseUrl, "/api/bots", { token });
  assert.deepEqual(botsPolicy.payload.hostedRunPolicy, viewed.payload.capabilities.hostedRunPolicy);
  assert.equal(viewed.payload.operations.find((row) => row.definition.operationID === operationID).runtime.members[0].runtimeState, "running");

  const stopped = await request(baseUrl, `/api/mining-operations/${operationID}/stop`, {
    method: "POST",
    token,
    body: {},
  });
  assert.equal(stopped.response.status, 200);
  assert.equal(stopped.payload.operations.find((row) => row.definition.operationID === operationID).runtime.state, "STOPPED");
  assert.deepEqual(host.stops, [`bot-${character.characterID}`]);

  const standardInput = {
    ...operationInput, name: "Standard belts", unloadPolicy: "HAULER_SERVICE",
    unloadDestination: { stationID: 60003760, stationName: "Jita IV - Moon 4", corporationDivision: 1, corporationID: 98000001 },
    members: crew.map((pilot, index) => ({ ...pilot, accountName: account.username,
      role: index === 2 ? "HAULER" : "MINER", routineMode: "STANDARD", automationID: "" })),
  };
  const noDestination = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
    body: { ...standardInput, name: "Missing delivery", unloadDestination: null } });
  assert.equal(noDestination.response.status, 200);
  const noDestinationPlan = await request(baseUrl, `/api/mining-operations/${noDestination.payload.definition.operationID}/launch-plan`, { token });
  assert.equal(noDestinationPlan.response.status, 409);
  assert.equal(noDestinationPlan.payload.error, "STANDARD_UNLOAD_DESTINATION_REQUIRED");
  const noDestinationStart = await request(baseUrl, `/api/mining-operations/${noDestination.payload.definition.operationID}/start`, { method: "POST", token, body: { grants: {} } });
  assert.equal(noDestinationStart.response.status, 409);
  assert.equal(host.inputs.length, 1);
  const invalidDestination = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
    body: { ...standardInput, unloadDestination: { stationID: 999999, corporationDivision: 1 } } });
  assert.equal(invalidDestination.response.status, 400);
  const standardSaved = await request(baseUrl, "/api/mining-operations", { method: "POST", token, body: standardInput });
  assert.equal(standardSaved.response.status, 200);
  const standardID = standardSaved.payload.definition.operationID;
  assert.equal(standardSaved.payload.definition.unloadDestination.stationName, "Jita IV - Moon 4");
  assert.deepEqual(standardSaved.payload.definition.members.map((member) => member.automationID), ["", "", ""]);
  const standardPlan = await request(baseUrl, `/api/mining-operations/${standardID}/launch-plan`, { token });
  assert.equal(standardPlan.response.status, 200);
  assert.deepEqual(standardPlan.payload.members.map((member) => member.script.scriptID), [
    "mcc.belt.hauler-service.miner", "mcc.belt.hauler-service.miner", "mcc.belt.hauler-service.hauler",
  ]);
  assert.deepEqual(standardPlan.payload.members.map((member) => member.script.rev), [2, 2, 1]);
  assert.equal(standardPlan.payload.members[0].script.doc.program[0].body[1].args.drones, undefined, "shared Batch 6 controller owns drones");
  assert.equal(standardPlan.payload.members[2].script.doc.program[0].body[0].then[0].args.station.ref.id, 60003760);
  const stalePlan = await request(baseUrl, `/api/mining-operations/${standardID}/start`, { method: "POST", token,
    body: { grants: {}, planHash: "not-the-reviewed-plan" } });
  assert.equal(stalePlan.response.status, 409);
  assert.equal(stalePlan.payload.error, "OPERATION_LAUNCH_PLAN_STALE");
  const standardStart = await request(baseUrl, `/api/mining-operations/${standardID}/start`, { method: "POST", token,
    body: { planHash: standardPlan.payload.planHash,
      grants: Object.fromEntries(crew.map((pilot, index) => [pilot.characterID, { scriptRev: standardPlan.payload.members[index].script.rev, riskClasses: [], maxRuntimeMinutes: 60 }])) } });
  assert.equal(standardStart.response.status, 200);
  assert.equal(standardStart.payload.results.filter((row) => row.ok).length, 3);
  assert.equal(host.inputs.at(-1).callerSessionID, null, "the in-space hauler needs no selected browser workspace");
  assert.equal(host.inputs.at(-1).scriptID, "mcc.belt.hauler-service.hauler");
  assert.equal(host.inputs.at(-1).doc.program[0].body.at(-1).args.seconds.value, 3);
  await request(baseUrl, `/api/mining-operations/${standardID}/stop`, { method: "POST", token, body: {} });

  for (const [family, profileFamily] of [["BELT", "belt"], ["ORE_ANOMALY", "ore-anomaly"], ["ICE", "ice"]]) {
    const selfInput = { ...standardInput, name: `${family} self`, unloadPolicy: "SELF_UNLOAD",
      area: { ...standardInput.area, targetClasses: [family] }, members: standardInput.members.slice(0, 2) };
    const missing = await request(baseUrl, "/api/mining-operations", { method: "POST", token, body: { ...selfInput, unloadDestination: null } });
    assert.equal(missing.response.status, 200);
    const blocked = await request(baseUrl, `/api/mining-operations/${missing.payload.definition.operationID}/start`, { method: "POST", token, body: {} });
    assert.equal(blocked.payload.error, "STANDARD_UNLOAD_DESTINATION_REQUIRED");
    const invalid = await request(baseUrl, "/api/mining-operations", { method: "POST", token, body: { ...selfInput, unloadDestination: { stationID: 999999, corporationDivision: 1 } } });
    assert.equal(invalid.response.status, 400);
    const saved = await request(baseUrl, "/api/mining-operations", { method: "POST", token, body: selfInput });
    assert.equal(saved.response.status, 200);
    const plan = await request(baseUrl, `/api/mining-operations/${saved.payload.definition.operationID}/launch-plan`, { token });
    assert.equal(plan.response.status, 200);
    assert.ok(plan.payload.members.every(member => member.script.scriptID === `mcc.${profileFamily}.self-unload.miner`));
    assert.equal(plan.payload.members.length, 2, "no hauler needed");
  }

  const withDefender = await request(baseUrl, "/api/mining-operations", { method: "POST", token, body: {
    ...operationInput,
    name: "Standard guard",
    unloadDestination: {stationID:60003760,stationName:"Jita IV - Moon 4",systemName:"Jita"},
    members: [...operationInput.members, { characterID: 7002, characterName: "Guard", accountName: account.username, role: "DEFENDER", automationID: "" }],
  } });
  assert.equal(withDefender.response.status, 200);
  const defenderPlan = await request(baseUrl, `/api/mining-operations/${withDefender.payload.definition.operationID}/launch-plan`, { token });
  assert.deepEqual(defenderPlan.payload.warnings, []);
  assert.equal(defenderPlan.payload.members.find(m=>m.characterID===7002).script.scriptID, "mcc.standard.defender");
  await t.test("NOT_READY Defender refuses public MCC start before any hosted acquisition", async () => {
    defenderPreparationBlocked = true;
    const blockedPlan = await request(baseUrl, `/api/mining-operations/${withDefender.payload.definition.operationID}/launch-plan`, {token});
    const before = host.inputs.length;
    const blocked = await request(baseUrl, `/api/mining-operations/${withDefender.payload.definition.operationID}/start`, {method:"POST",token,body:{planHash:blockedPlan.payload.planHash}});
    assert.equal(blocked.response.status,409);assert.match(blocked.payload.message,/equipment\/source/i);
    assert.equal(host.inputs.length,before);defenderPreparationBlocked=false;
  });
  const defenderStart = await request(baseUrl, `/api/mining-operations/${withDefender.payload.definition.operationID}/start`, {
    method: "POST", token,
    body: { planHash: defenderPlan.payload.planHash, grants: Object.fromEntries([7001,7002].map(id=>[id,{scriptRev:1,riskClasses:[],maxRuntimeMinutes:60}])) },
  });
  assert.equal(defenderStart.response.status, 200);
  await t.test("READY Standard Defender enters normal hosted preparation and operation lifecycle", () => {
    assert.equal(defenderStart.payload.operations.find((row) => row.definition.operationID === withDefender.payload.definition.operationID).runtime.state, "SELECTING");
    assert.equal(defenderStart.payload.results.find(row=>row.characterID===7002).ok,true);
    const input=host.inputs.findLast(row=>row.characterID===7002);
    assert.equal(input.scriptID,"mcc.standard.defender");assert.equal(input.operationRole,"DEFENDER");assert.ok(input.operationPreparation);
    assert.ok(host.events.some(row=>row.kind==="activated"&&row.characterID===7002));
  });
  await t.test("MCC Stop includes Standard Defender in existing release lifecycle",async()=>{
    const stopped=await request(baseUrl, `/api/mining-operations/${withDefender.payload.definition.operationID}/stop`, { method: "POST", token, body: {} });
    assert.equal(stopped.response.status,200);assert.equal(host.claimedBy(7002),null);assert.ok(host.stops.includes("bot-7002"));
  });
  await t.test("busy Defender cannot bypass hosted ownership and blocks the MAIN barrier",async()=>{
    host.failures.set(7002,{code:"CHARACTER_IN_USE",message:"Pilot already held"});
    const started=await request(baseUrl, `/api/mining-operations/${withDefender.payload.definition.operationID}/start`, {method:"POST",token,body:{planHash:defenderPlan.payload.planHash}});
    assert.equal(started.payload.results.find(row=>row.characterID===7002).error,"CHARACTER_IN_USE");
    assert.ok(host.rows.findLast(row=>row.characterID===7001).deferMain);host.failures.delete(7002);
    await request(baseUrl, `/api/mining-operations/${withDefender.payload.definition.operationID}/stop`,{method:"POST",token,body:{}});
  });

  const crewOperation = await request(baseUrl, "/api/mining-operations", { method: "POST", token, body: {
    ...operationInput,
    name: "Jetcan crew",
    unloadPolicy: "HAULER_SERVICE",
    members: crew.map((row, index) => ({ ...row, accountName: account.username, role: index === 2 ? "HAULER" : "MINER", automationID: index === 2 ? crewHaulerScript.scriptID : crewMinerScript.scriptID })),
  } });
  assert.equal(crewOperation.response.status, 200);
  heldSessions.set("other-browser", { characterID: 7003, accountID: account.accountID, bridgeSessionID: "held-cargo", droneRecoveryReady: true });
  const heldStart = await request(baseUrl, `/api/mining-operations/${crewOperation.payload.definition.operationID}/start`, { method: "POST", token, body: {
    planHash: (await request(baseUrl, `/api/mining-operations/${crewOperation.payload.definition.operationID}/launch-plan`, { token })).payload.planHash,
    grants: Object.fromEntries(crew.map((row) => [row.characterID, { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 60 }])),
  } });
  assert.equal(heldStart.payload.operations.find((row) => row.definition.operationID === crewOperation.payload.definition.operationID).runtime.state, "DEGRADED");
  assert.equal(heldStart.payload.results.find((row) => row.characterID === 7003).error, "CHARACTER_IN_USE");
  const heldFailure = heldStart.payload.operations.find((row) => row.definition.operationID === crewOperation.payload.definition.operationID)
    .runtime.members.find((row) => row.characterID === 7003);
  assert.equal(heldFailure.failureCode, "CHARACTER_IN_USE");
  assert.match(heldFailure.reason, /browser session/);
  assert.equal(host.inputs.find((input) => input.characterID === 7003).callerSessionID, null);
  assert.equal(heldSessions.has("other-browser"), true);
  assert.equal(host.events.filter(event => event.kind === "activated" && event.operationRunID === host.inputs.at(-1).operationRunID).length, 0,
    "a missing acquired member holds all productive activation behind the real server barrier");
  await request(baseUrl, `/api/mining-operations/${crewOperation.payload.definition.operationID}/stop`, { method: "POST", token, body: {} });
  heldSessions.delete("other-browser");
  host.failures.set(7002, { code: "BOT_START_FAILED", message: "Gateway selection refused: session limit" });
  const failedMinerStart = await request(baseUrl, `/api/mining-operations/${crewOperation.payload.definition.operationID}/start`, { method: "POST", token, body: {
    planHash: (await request(baseUrl, `/api/mining-operations/${crewOperation.payload.definition.operationID}/launch-plan`, { token })).payload.planHash,
    grants: Object.fromEntries(crew.map((row) => [row.characterID, { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 60 }])),
  } });
  const failedMiner = failedMinerStart.payload.operations.find((row) => row.definition.operationID === crewOperation.payload.definition.operationID)
    .runtime.members.find((row) => row.characterID === 7002);
  assert.equal(failedMinerStart.payload.results.find((row) => row.characterID === 7002).message, "Gateway selection refused: session limit");
  assert.equal(failedMiner.failureCode, "BOT_START_FAILED");
  assert.equal(failedMiner.reason, "Gateway selection refused: session limit");
  assert.equal(failedMinerStart.payload.operations.find((row) => row.definition.operationID === crewOperation.payload.definition.operationID).runtime.state, "DEGRADED");
  await request(baseUrl, `/api/mining-operations/${crewOperation.payload.definition.operationID}/stop`, { method: "POST", token, body: {} });
  host.failures.delete(7002);
  const crewStart = await request(baseUrl, `/api/mining-operations/${crewOperation.payload.definition.operationID}/start`, { method: "POST", token, body: {
    planHash: (await request(baseUrl, `/api/mining-operations/${crewOperation.payload.definition.operationID}/launch-plan`, { token })).payload.planHash,
    grants: Object.fromEntries(crew.map((row) => [row.characterID, { scriptRev: 1, riskClasses: [], maxRuntimeMinutes: 60 }])),
  } });
  assert.equal(crewStart.response.status, 200);
  assert.equal(crewStart.payload.results.filter((row) => row.ok).length, 3);
  assert.ok(host.inputs.slice(-3).every((input) => input.callerSessionID === null));
  const runEvents = host.events.filter(event => event.operationRunID === host.inputs.at(-1).operationRunID);
  assert.deepEqual(runEvents.map(event => event.kind), ["acquired", "acquired", "acquired", "activated", "activated", "activated"],
    "production route acquires and prepares every member before first MAIN activation");

  // Stopping this fleet must not sweep unrelated hosted/recovered pilots or
  // browser-held sessions, even when they belong to the same account.
  const outsiders = [7004, 7005, 7006];
  for (const [index, characterID] of outsiders.entries()) {
    host.rows.push({
      botID: `unrelated-${characterID}`, accountID: account.accountID, characterID,
      operationID: index === 0 ? null : "another-operation",
      resumedAt: index === 2 ? "2026-09-24T00:30:00.000Z" : null,
      status: "running", endedAt: null,
    });
    heldSessions.set(`unrelated-session-${characterID}`, {
      characterID, accountID: account.accountID, bridgeSessionID: `held-${characterID}`,
    });
  }
  const stoppedBefore = host.stops.length;
  const crewStopped = await request(baseUrl, `/api/mining-operations/${crewOperation.payload.definition.operationID}/stop`, {
    method: "POST", token, body: {},
  });
  assert.equal(crewStopped.response.status, 200);
  assert.deepEqual(host.stops.slice(stoppedBefore).sort(), crew.map((row) => `bot-${row.characterID}`).sort());
  assert.ok(outsiders.every((characterID) => host.rows.find((row) => row.botID === `unrelated-${characterID}`).endedAt === null));
  assert.ok(outsiders.every((characterID) => heldSessions.has(`unrelated-session-${characterID}`)));

  const parking = { mode: "RETURN_HOME_UNLOAD_DOCK", destination: { stationID: 60003760 }, corporationDivision: 1, corporationID: 98000001 };
  const invalidParking = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
    body: { ...standardInput, policies: { parking: { ...parking, destination: { stationID: 1 } } } } });
  assert.equal(invalidParking.response.status, 400);
  const parkedDef = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
    body: { ...standardInput, policies: { parking } } });
  assert.equal(parkedDef.response.status, 200);
  assert.equal(parkedDef.payload.capabilities.targetClasses.ORE_ANOMALY.executable, true);
  assert.equal(parkedDef.payload.capabilities.targetClasses.ICE.executable, true);
  assert.equal(parkedDef.payload.capabilities.targetClasses.GAS.executable, false);
  assert.equal(parkedDef.payload.capabilities.profileFamilies.length, 4);
  const parkID = parkedDef.payload.definition.operationID;
  const parkPlan = await request(baseUrl, `/api/mining-operations/${parkID}/launch-plan`, { token });
  assert.match(parkPlan.payload.warnings.join(" "), /manual Stop.*remaining run grant/);
  const parkingStart = await request(baseUrl, `/api/mining-operations/${parkID}/start`, { method: "POST", token, body: {
    planHash: parkPlan.payload.planHash,
    grants: Object.fromEntries(crew.map((pilot, index) => [pilot.characterID, { scriptRev: parkPlan.payload.members[index].script.rev, riskClasses: [], maxRuntimeMinutes: 60 }])) } });
  assert.equal(parkingStart.response.status, 200);
  const parkingStop = await request(baseUrl, `/api/mining-operations/${parkID}/stop`, { method: "POST", token, body: {} });
  assert.equal(parkingStop.response.status, 202, "parking is asynchronous control-plane work");
  const completed = await request(baseUrl, "/api/mining-operations", { token });
  assert.equal(completed.payload.operations.find(row => row.definition.operationID === parkID).runtime.state, "STOPPED");
  assert.ok(outsiders.every(id => host.rows.find(row => row.characterID === id).endedAt === null));
  const repeated = await request(baseUrl, `/api/mining-operations/${parkID}/stop`, { method: "POST", token, body: {} });
  assert.equal(repeated.response.status, 202);
  for (const [family, profileID] of [["ORE_ANOMALY", "ore-anomaly"], ["ICE", "ice"]]) {
    const savedFamily = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
      body: { ...standardInput, area: { ...standardInput.area, targetClasses: [family] } } });
    assert.equal(savedFamily.response.status, 200);
    const familyPlan = await request(baseUrl, `/api/mining-operations/${savedFamily.payload.definition.operationID}/launch-plan`, { token });
    assert.equal(familyPlan.response.status, 200, JSON.stringify(familyPlan.payload));
    assert.ok(familyPlan.payload.members.every(row => row.script.scriptID.startsWith(`mcc.${profileID}.hauler-service.`)));
  }
  const structure = { kind: "structure", id: 1030000000001, name: "My Astrahus", solarSystemID: 30000142, solarSystemName: "Jita" };
  const structureDef = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
    body: { ...standardInput, name: "Structure parking", policies: { parking: { mode: "RETURN_HOME_DOCK", destination: structure } } } });
  assert.equal(structureDef.response.status, 200);
  const structurePlan = await request(baseUrl, `/api/mining-operations/${structureDef.payload.definition.operationID}/launch-plan`, { token });
  assert.equal(structurePlan.response.status, 200);
  const structureStart = await request(baseUrl, `/api/mining-operations/${structureDef.payload.definition.operationID}/start`, { method: "POST", token,
    body: { planHash: structurePlan.payload.planHash,
      grants: Object.fromEntries(crew.map((pilot, index) => [pilot.characterID,
        { scriptRev: structurePlan.payload.members[index].script.rev, riskClasses: [], maxRuntimeMinutes: 60 }])) } });
  assert.equal(structureStart.response.status, 200);
  assert.equal(structureAccessCalls.filter((call) => call.method === "CheckMyDockingAccessToStructures").length, 3);
  assert.ok(host.inputs.slice(-3).every(input => input.parkingStructureID === structure.id));
  await request(baseUrl, `/api/mining-operations/${structureDef.payload.definition.operationID}/stop`, { method: "POST", token, body: {} });
  structureAccessAllowed = false;
  const deniedDef = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
    body: { ...standardInput, name: "Structure access lost", policies: { parking: { mode: "RETURN_HOME_DOCK", destination: structure } } } });
  const deniedPlan = await request(baseUrl, `/api/mining-operations/${deniedDef.payload.definition.operationID}/launch-plan`, { token });
  const startsBefore = host.inputs.length;
  const deniedStart = await request(baseUrl, `/api/mining-operations/${deniedDef.payload.definition.operationID}/start`, { method: "POST", token,
    body: { planHash: deniedPlan.payload.planHash, grants: Object.fromEntries(crew.map((pilot, index) => [pilot.characterID,
      { scriptRev: deniedPlan.payload.members[index].script.rev, riskClasses: [], maxRuntimeMinutes: 60 }])) } });
  assert.equal(deniedStart.response.status, 409);
  assert.equal(deniedStart.payload.error, "PARKING_STRUCTURE_ACCESS_DENIED");
  assert.equal(host.inputs.length, startsBefore, "no member starts when structure preflight fails");
  await t.test("Defender emergency structure home needs its own docking access before any acquisition", async () => {
    structureAccessAllowed = characterID => characterID !== 7002;
    const saved = await request(baseUrl, "/api/mining-operations", { method: "POST", token,
      body: { ...withDefender.payload.definition, operationID: undefined, name: "Guard structure home", unloadDestination: structure } });
    assert.equal(saved.response.status, 200);
    const plan = await request(baseUrl, `/api/mining-operations/${saved.payload.definition.operationID}/launch-plan`, { token });
    const before = host.inputs.length;
    const start = await request(baseUrl, `/api/mining-operations/${saved.payload.definition.operationID}/start`, { method: "POST", token,
      body: { planHash: plan.payload.planHash } });
    assert.equal(start.response.status, 409);
    assert.equal(start.payload.error, "DELIVERY_STRUCTURE_ACCESS_DENIED");
    assert.match(start.payload.message, /Guard/);
    assert.equal(host.inputs.length, before);
  });
});
