import type { UocBackendRequest } from "../shared/backendScope.ts";
import { setupHash } from "./miningRecovery.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createMiningDefinitionStore, type SyncDocument } from "./miningStore.ts";
import { createMiningOperationRoutes, currentExecutorGaps } from "./miningRoutes.ts";
const definition = () => ({
  name: "Fleet",
  area: {
    anchorSystemID: 300,
    anchorSystemName: "System",
    reach: "CURRENT_SYSTEM",
    targetClasses: ["BELT"],
  },
  targetPolicy: "ANY_ELIGIBLE",
  unloadPolicy: "HAULER_SERVICE",
  unloadDestination: {
    stationID: 600,
    stationName: "Station",
    corporationDivision: 1,
    corporationID: 77,
  },
  members: [
    {
      characterID: 1,
      characterName: "One",
      accountName: "one",
      role: "MINER",
      routineMode: "STANDARD",
      automationID: "",
    },
    {
      characterID: 2,
      characterName: "Two",
      accountName: "two",
      role: "MINER",
      routineMode: "STANDARD",
      automationID: "",
    },
    {
      characterID: 3,
      characterName: "Three",
      accountName: "three",
      role: "HAULER",
      routineMode: "STANDARD",
      automationID: "",
    },
  ],
  policies: {
    version: 1,
    parking: {
      mode: "STAY_IN_PLACE",
      destination: null,
      corporationDivision: null,
      corporationID: null,
    },
    travelAssist: { mode: "AUTO" },
    resourcePolicy: { mode: "ANY_ELIGIBLE", source: "MANUAL", typeIDs: [] },
  },
  preparation: { source: { kind: "hangar" }, suppliesRequired: false },
  oreLogistics: { version: 1, remoteCompression: false, compressedJettisonFraction: 0.5 },
});
function docs() {
  const rows = new Map<string, unknown>();
  return (key: string): SyncDocument => ({
    read: () => (rows.has(key) ? structuredClone(rows.get(key)) : null),
    write: (v) => {
      rows.set(key, structuredClone(v));
    },
  });
}
function req(username: string, params: Record<string, string> = {}, body: unknown = null): any {
  return { account: { username, accountID: 1 }, method: "POST", path: "", params, query: {}, body };
}
test("definitions preserve original policies and enforce revision conflicts", () => {
  const store = createMiningDefinitionStore(
      docs()("one"),
      () => "2026-01-01T00:00:00.000Z",
      () => "op1",
    ),
    original = definition(),
    saved = store.save(original);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.policies, original.policies);
  assert.deepEqual(saved.oreLogistics, original.oreLogistics);
  const edited = store.save({ ...saved, name: "Renamed" });
  assert.equal(edited.revision, 2);
  assert.throws(() => store.save({ ...saved, name: "Lost update" }), /changed since editing/);
  assert.throws(() => store.remove("op1", 1), /changed since review/);
  assert.equal(store.remove("op1", 2), true);
  assert.equal(store.list().length, 0);
});
test("invalid nested types and duplicate pilot identity are refused", () => {
  const store = createMiningDefinitionStore(docs()("one"));
  const d = definition();
  assert.throws(() => store.save({ ...d, members: [...d.members, d.members[0]] }), /roster/);
  assert.throws(
    () =>
      store.save({
        ...d,
        oreLogistics: { version: 1, remoteCompression: "yes", compressedJettisonFraction: 0.5 },
      }),
    /logistics/,
  );
  assert.throws(
    () =>
      store.save({
        ...d,
        preparation: {
          source: { kind: "hangar" },
          suppliesRequired: false,
          supplies: [
            { typeID: 1, target: 1, mode: "TOTAL_ABOARD", eligibleFlags: ["5"], required: true },
          ],
        },
      }),
    /preparation/,
  );
});
test("all accounts in one world share create, edit, delete and the same launch review", async () => {
  const document = docs(),
    routes = createMiningOperationRoutes({
      document,
      getWorldScope: () => "world-A",
      isOperationActive: () => false,
    });
  const save = routes["POST /mining-operations"]!,
    list = routes["GET /mining-operations"]!,
    plan = routes["GET /mining-operations/:operationID/launch-plan"]!;
  const created: any = await save(req("Alice", {}, definition())),
    id = created.body.savedOperationID;
  const listed: any = await list(req("Bob"));
  assert.deepEqual(
    listed.body.operations.map((row: any) => row.definition),
    [created.body.operations[0].definition],
  );
  const reopened = createMiningOperationRoutes({
    document,
    getWorldScope: () => "world-A",
    isOperationActive: () => false,
  });
  const fromOtherAccount: any = await reopened["GET /mining-operations"]!({
    ...req("Bob"),
    account: { accountID: 2, username: "Bob" },
  });
  assert.deepEqual(
    fromOtherAccount.body.operations[0].definition.members.map(
      (m: { accountName: string }) => m.accountName,
    ),
    ["one", "two", "three"],
  );
  assert.equal(fromOtherAccount.body.operations[0].definition.operationID, id);
  const p: any = await plan(req("Bob", { operationID: id }));
  assert.equal(p.body.executorReady, false);
  assert.equal(p.body.preparation.state, "PENDING");
  assert.deepEqual(p.body, (await plan(req("Alice", { operationID: id }))).body);
  assert.ok(
    p.body.warnings.includes(
      "Start verifies pilot readiness in each hosted session before departure.",
    ),
  );
  const edited: any = await save(
    req("Bob", {}, { ...listed.body.operations[0].definition, name: "Edited by Bob" }),
  );
  assert.equal(edited.body.operations[0].definition.revision, 2);
  assert.equal(
    ((await list(req("Alice"))).body as any).operations[0].definition.name,
    "Edited by Bob",
  );
  const deleted: any = await routes["POST /mining-operations/:operationID/delete"]!(
    req("Alice", { operationID: id }, { revision: 2 }),
  );
  assert.deepEqual(deleted.body.operations, []);
  assert.deepEqual(((await list(req("Bob"))).body as any).operations, []);
});
test("setup checks bind saved roster and use the injected native executor validator", async () => {
  const doc = docs();
  let checked = 0;
  const routes = createMiningOperationRoutes({
      document: doc,
      getWorldScope: () => "world-A",
      isOperationActive: () => false,
      checkSetup: () => {
        checked++;
        return { ok: false, refusal: "exact physical proof missing" };
      },
    }),
    saved: any = await routes["POST /mining-operations"]!(req("Alice", {}, definition())),
    id = saved.body.savedOperationID,
    plan = routes["POST /mining-operations/:operationID/launch-plan"]!;
  const setup = {
    operationID: id,
    systemID: 300,
    beltID: 99,
    beltName: "Native belt",
    oreLogistics: definition().oreLogistics,
    travelAssist: "AUTO",
    destinationID: 600,
    corporationID: 77,
    division: 1,
    parking: { mode: "STAY_IN_PLACE" },
    members: definition().members.map(({ characterID, role }) => ({
      characterID,
      role,
      shipID: characterID + 10,
    })),
  };
  const response: any = await plan(req("Alice", { operationID: id }, { revision: 1, setup }));
  assert.equal(checked, 1);
  assert.ok(response.body.warnings.includes("exact physical proof missing"));
  assert.equal(response.body.executorReady, false);
  const mismatch: any = await plan(
    req("Alice", { operationID: id }, { revision: 1, setup: { ...setup, systemID: 301 } }),
  );
  assert.equal(mismatch.status, 400);
  assert.equal(checked, 1);
  assert.ok(
    !currentExecutorGaps({
      ...saved.body.operations[0].definition,
      members: [
        ...definition().members,
        {
          characterID: 4,
          characterName: "Four",
          accountName: "four",
          role: "DEFENDER",
          automationID: "",
        },
      ],
    }).some((x) => x.includes("Defender")),
  );
});
test("a changed saved revision changes immutable launch-review hash", async () => {
  const doc = docs(),
    routes = createMiningOperationRoutes({
      document: doc,
      getWorldScope: () => "world-A",
      isOperationActive: () => false,
    }),
    save = routes["POST /mining-operations"]!,
    plan = routes["GET /mining-operations/:operationID/launch-plan"]!;
  const saved: any = await save(req("Alice", {}, definition())),
    d = saved.body.operations[0].definition,
    id = d.operationID,
    p1: any = await plan(req("Alice", { operationID: id }));
  const changed: any = await save(req("Alice", {}, { ...d, name: "new revision" }));
  assert.equal(changed.body.operations[0].definition.revision, 2);
  const p2: any = await plan(req("Alice", { operationID: id }));
  assert.notEqual(p1.body.planHash, p2.body.planHash);
});

test("saved operation documents are isolated by world and refuse unknown world", async () => {
  const document = docs(),
    a = createMiningOperationRoutes({
      document,
      getWorldScope: () => "A",
      isOperationActive: () => false,
    }),
    b = createMiningOperationRoutes({
      document,
      getWorldScope: () => "B",
      isOperationActive: () => false,
    }),
    unknown = createMiningOperationRoutes({ document });
  await a["POST /mining-operations"]!(req("Alice", {}, definition()));
  const other: any = await b["GET /mining-operations"]!(req("Alice"));
  assert.equal(other.body.operations.length, 0);
  const refused: any = await unknown["GET /mining-operations"]!(req("Alice"));
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /world/);
});
test("review rejects stale revision and mismatched delivery or target before executor validation", async () => {
  const document = docs();
  let checks = 0;
  const routes = createMiningOperationRoutes({
      document,
      getWorldScope: () => "world",
      isOperationActive: () => false,
      checkSetup: () => {
        checks++;
        return { ok: false, refusal: "not ready" };
      },
    }),
    saved: any = await routes["POST /mining-operations"]!(req("Alice", {}, definition())),
    id = saved.body.savedOperationID,
    post = routes["POST /mining-operations/:operationID/launch-plan"]!,
    setup = {
      operationID: id,
      systemID: 300,
      beltID: 99,
      beltName: "Native belt",
      oreLogistics: definition().oreLogistics,
      travelAssist: "AUTO",
      destinationID: 600,
      corporationID: 77,
      division: 1,
      parking: { mode: "STAY_IN_PLACE" },
      members: definition().members.map(({ characterID, role }) => ({
        characterID,
        role,
        shipID: characterID + 10,
      })),
    };
  for (const bad of [
    { revision: 2, setup },
    { revision: 1, setup: { ...setup, destinationID: 601 } },
    { revision: 1, setup: { ...setup, beltID: null } },
  ]) {
    const r: any = await post(req("Alice", { operationID: id }, bad));
    assert.equal(r.status, 400);
  }
  assert.equal(checks, 0);
});
test("saved definition round-trips defender, custom routines and advanced command settings without truncation", () => {
  const store = createMiningDefinitionStore(
      docs()("one"),
      () => "2026-01-01T00:00:00Z",
      () => "complex",
    ),
    d = definition(),
    members = [
      { ...d.members[0]!, routineMode: "CUSTOM", automationID: "script-1" },
      ...d.members.slice(1),
      {
        characterID: 4,
        characterName: "Defender",
        accountName: "four",
        role: "DEFENDER",
        routineMode: "STANDARD",
        automationID: "",
      },
      {
        characterID: 5,
        characterName: "Command",
        accountName: "five",
        role: "COMMAND",
        routineMode: "STANDARD",
        automationID: "",
      },
    ],
    support = {
      version: 1,
      characterID: 5,
      fleetPolicy: "MANAGED",
      maintainBursts: true,
      useIndustrialCore: true,
      coreRequirement: "requireCore",
      enableCompression: true,
      selfMining: true,
      tractor: true,
      collection: "TRACTOR_AND_COLLECT",
      compressCollectedOre: true,
      supportLoss: "STOP",
    },
    value = {
      ...d,
      members,
      support,
      oreLogistics: { version: 1, remoteCompression: true, compressedJettisonFraction: 0.7 },
      policies: {
        ...d.policies,
        resourcePolicy: { mode: "PREFER_LIST", source: "MANUAL", typeIDs: [123, 456] },
      },
    },
    saved = store.save(value);
  assert.deepEqual(saved.members, members);
  assert.deepEqual(saved.support, support);
  assert.deepEqual(saved.oreLogistics, value.oreLogistics);
  assert.deepEqual(saved.policies, value.policies);
  assert.ok(currentExecutorGaps(saved).some((x) => x.includes("Custom routines")));
});
test("saved rosters accept role-derived miner and hauler counts without executor claims", () => {
  for (const count of [1, 3, 5, 12]) {
    const store = createMiningDefinitionStore(docs()(String(count))),
      d = definition(),
      miners = Array.from({ length: count }, (_, i) => ({
        characterID: 100 + i,
        characterName: `Miner ${i}`,
        accountName: `a${i}`,
        role: "MINER",
        routineMode: "STANDARD",
        automationID: "",
      })),
      haulers = Array.from({ length: count }, (_, i) => ({
        characterID: 1000 + i,
        characterName: `Hauler ${i}`,
        accountName: `h${i}`,
        role: "HAULER",
        routineMode: "STANDARD",
        automationID: "",
      }));
    const saved = store.save({ ...d, members: [...miners, ...haulers] });
    assert.equal(saved.members.length, count * 2);
    assert.ok(!currentExecutorGaps(saved).some((x) => x.includes("exactly two miners")));
  }
});
test("capability projection reports engine-supported families separately from blocked launch", async () => {
  const routes = createMiningOperationRoutes({
      document: docs(),
      getWorldScope: () => "world",
      isOperationActive: () => false,
    }),
    res: any = await routes["GET /mining-operations"]!(req("Alice"));
  assert.equal(res.body.capabilities.targetClasses.BELT.executable, true);
  assert.equal(res.body.capabilities.targetClasses.ORE_ANOMALY.executable, true);
  assert.equal(res.body.capabilities.targetClasses.ICE.executable, true);
  assert.equal(res.body.capabilities.targetClasses.GAS.executable, false);
  assert.match(res.body.capabilities.targetClasses.BELT.note, /fresh native/);
});
test("launch route journals each exact dispatch before a host call and fences repeat", async () => {
  const document = docs(),
    routes = createMiningOperationRoutes({
      document,
      getWorldScope: () => "world",
      isOperationActive: () => false,
      checkSetup: (setup: any) => ({
        ok: true,
        setup,
        name: "fleet",
        policy: { riskClasses: ["fleet"], restartSafe: false },
      }),
    }),
    d = definition();
  d.policies.travelAssist.mode = "DISABLED";
  const saved: any = await routes["POST /mining-operations"]!(req("Alice", {}, d)),
    id = saved.body.savedOperationID,
    setup = {
      operationID: id,
      operationRunID: "epoch",
      systemID: 300,
      beltID: 99,
      beltName: "Native belt",
      oreLogistics: definition().oreLogistics,
      travelAssist: "DISABLED",
      destinationID: 600,
      corporationID: 77,
      division: 1,
      parking: { mode: "STAY_IN_PLACE" },
      members: d.members.map(({ characterID, role }, i) => ({ characterID, role, shipID: i + 11 })),
    },
    plan: any = await routes["POST /mining-operations/:operationID/launch-plan"]!(
      req("Alice", { operationID: id }, { revision: 1, setup }),
    );
  assert.equal(plan.body.candidateSupported, true);
  assert.equal(plan.body.executorReady, false);
  const members = d.members.map((m) => ({
      characterID: m.characterID,
      accountName: m.accountName,
      role: m.role,
      kind: `mcc-${m.role.toLowerCase()}`,
      beforeIDs: [],
    })),
    begun: any = await routes["POST /mining-operations/:operationID/launch/begin"]!(
      req(
        "Alice",
        { operationID: id },
        { revision: 1, setup, planHash: plan.body.planHash, members },
      ),
    );
  assert.equal(begun.body.receipt.members[0].status, "PREPARED");
  const dispatched: any = await routes["POST /mining-operations/:operationID/launch/dispatch"]!(
    req("Alice", { operationID: id }, { characterID: 1 }),
  );
  assert.equal(dispatched.body.receipt.members[0].status, "DISPATCHED");
  const replay: any = await routes["POST /mining-operations/:operationID/launch/dispatch"]!(
    req("Alice", { operationID: id }, { characterID: 1 }),
  );
  assert.equal(replay.status, 400);
});
test("saved cards track exact durable fleet state, fence stale active ownership, and archive a settled generation", async () => {
  const document = docs();
  let active = false,
    snapshot: any = null;
  const routes = createMiningOperationRoutes({
      document,
      getWorldScope: () => "world",
      isOperationActive: () => active,
      operationSnapshot: () => snapshot,
      checkSetup: (setup: any) => ({
        ok: true,
        setup,
        name: "fleet",
        policy: { riskClasses: ["fleet"], restartSafe: false },
      }),
    }),
    d = definition();
  d.policies.travelAssist.mode = "DISABLED";
  const saved: any = await routes["POST /mining-operations"]!(req("Alice", {}, d)),
    id = saved.body.savedOperationID,
    params = { operationID: id },
    setup = {
      operationID: id,
      operationRunID: "old",
      systemID: 300,
      beltID: 99,
      beltName: "Native belt",
      oreLogistics: definition().oreLogistics,
      travelAssist: "DISABLED",
      destinationID: 600,
      corporationID: 77,
      division: 1,
      parking: { mode: "STAY_IN_PLACE" },
      members: d.members.map(({ characterID, role }, i) => ({ characterID, role, shipID: i + 11 })),
    },
    members = d.members.map((m) => ({
      characterID: m.characterID,
      accountName: m.accountName,
      role: m.role,
      kind: `mcc-${m.role.toLowerCase()}`,
      beforeIDs: [],
    }));
  async function begin(s: any) {
    const plan: any = await routes["POST /mining-operations/:operationID/launch-plan"]!(
      req("Alice", params, { revision: 1, setup: s }),
    );
    return routes["POST /mining-operations/:operationID/launch/begin"]!(
      req("Alice", params, { revision: 1, setup: s, planHash: plan.body.planHash, members }),
    );
  }
  await begin(setup);
  for (const m of members) {
    await routes["POST /mining-operations/:operationID/launch/dispatch"]!(
      req("Alice", params, { characterID: m.characterID }),
    );
    await routes["POST /mining-operations/:operationID/launch/accept"]!(
      req("Alice", params, { characterID: m.characterID, botID: `bot-${m.characterID}` }),
    );
  }
  snapshot = { operationID: id, runID: "old", members: setup.members, state: "ACTIVE" };
  active = true;
  let state: any = await routes["GET /mining-operations"]!(req("Alice"));
  assert.equal(state.body.operations[0].runtime.state, "ACTIVE");
  active = false;
  state = await routes["GET /mining-operations"]!(req("Alice"));
  assert.equal(state.body.operations[0].runtime.state, "UNKNOWN");
  const blocked: any = await begin({ ...setup, operationRunID: "new" });
  assert.equal(blocked.status, 400);
  snapshot = {
    ...snapshot,
    state: "STOPPED",
    settled: [1, 2, 3],
    parked: [],
    stayed: [1, 2, 3],
    claim: null,
    manifests: [],
    jetcanIntents: {},
  };
  state = await routes["GET /mining-operations"]!(req("Alice"));
  assert.equal(state.body.operations[0].runtime.state, "STOPPED");
  const fresh: any = await begin({ ...setup, operationRunID: "new" });
  assert.equal(fresh.body.receipt.operationRunID, "new");
  const archive = document(
    `mining-launch-history:${JSON.stringify([JSON.stringify(["world"]), id, "old"])}`,
  ).read() as any;
  assert.equal(archive.operationRunID, "old");
});

test("Stop choice is scoped to the original run and projects after refresh", async () => {
  const document = docs(),
    id = "stop-mode",
    identity = JSON.stringify(["world"]),
    params = { operationID: id };
  const roster = definition().members;
  document("mining-definitions:" + identity).write({
    version: 1,
    definitions: [
      { ...definition(), operationID: id, revision: 1, createdAt: "x", updatedAt: "x" },
    ],
  });
  document("mining-launch:" + JSON.stringify([identity, id])).write({
    version: 1,
    operationID: id,
    operationRunID: "run",
    revision: 1,
    planHash: "h",
    setupHash: "s",
    members: roster.map((m) => ({
      characterID: m.characterID,
      accountName: m.accountName,
      role: m.role,
      kind: "mcc-" + m.role.toLowerCase(),
      beforeIDs: [],
      status: "ACCEPTED",
      botID: "b" + m.characterID,
    })),
  });
  let mode: import("../miningFleet/operation.ts").StopFreightMode | undefined;
  const routes = createMiningOperationRoutes({
    document,
    getWorldScope: () => "world",
    isOperationActive: () => true,
    requestStop: (run, choice) => {
      assert.deepEqual(run, { operationID: id, operationRunID: "run" });
      mode ??= choice;
      return { mode, live: true };
    },
    operationSnapshot: () => ({
      operationID: id,
      runID: "run",
      state: "ACTIVE",
      members: roster.map((m) => ({
        characterID: m.characterID,
        role: m.role,
        shipID: 10 + m.characterID,
      })),
      stopRequested: !!mode,
      stopFreight: mode,
    }),
  });
  const post = routes["POST /mining-operations/:operationID/stop"]!,
    body = { operationRunID: "run", mode: "COLLECT_FREIGHT" };
  assert.equal((await post(req("Alice", params, { ...body, operationRunID: "old" }))).status, 400);
  assert.equal(mode, undefined);
  assert.equal((await post(req("Bob", params, body))).status, 202);
  const refresh = await routes["GET /mining-operations"]!(req("Alice"));
  const { runtime } = (refresh.body as any).operations[0];
  assert.equal(runtime.state, "STOPPING");
  assert.equal(runtime.stopFreight, "COLLECT_FREIGHT");
});

test("relocation admits the shared world operation and exact live target generation", async () => {
  const document = docs(),
    id = "relocation-op",
    identity = JSON.stringify(["world"]);
  let state: any = {
      operationID: id,
      runID: "run",
      state: "ACTIVE",
      members: definition().members.map((m) => ({
        characterID: m.characterID,
        role: m.role,
        shipID: 10 + m.characterID,
      })),
      claim: { key: "BELT:300:Old", generation: 4 },
    },
    calls = 0;
  const routes = createMiningOperationRoutes({
    document,
    getWorldScope: () => "world",
    isOperationActive: () => true,
    operationSnapshot: () => state,
    relocate: async (intent) => {
      assert.equal(intent.claimKey, "BELT:300:Old");
      calls++;
      state = { ...state, state: "DRAINING" };
      return true;
    },
  });
  document("mining-definitions:" + identity).write({
    version: 1,
    definitions: [
      { ...definition(), operationID: id, revision: 1, createdAt: "x", updatedAt: "x" },
    ],
  });
  document("mining-launch:" + JSON.stringify([identity, id])).write({
    version: 1,
    operationID: id,
    operationRunID: "run",
    revision: 1,
    planHash: "h",
    setupHash: "s",
    members: definition().members.map((m) => ({
      characterID: m.characterID,
      accountName: m.accountName,
      role: m.role,
      kind: "mcc-" + m.role.toLowerCase(),
      beforeIDs: [],
      status: "ACCEPTED",
      botID: "b" + m.characterID,
    })),
  });
  const call = routes["POST /mining-operations/:operationID/relocate"]!,
    body = { operationRunID: "run", claimKey: "BELT:300:Old", claimGeneration: 4 };
  assert.equal(
    (await call(req("Alice", { operationID: id }, { ...body, claimGeneration: 3 }))).status,
    400,
  );
  assert.equal(calls, 0);
  assert.equal((await call(req("Bob", { operationID: id }, body))).status, 202);
  assert.equal(calls, 1);
  assert.equal((await call(req("Alice", { operationID: id }, body))).status, 400);
  assert.equal(calls, 1);
});

test("saved recovery is world scoped, generation pinned and admits only exact FINISH co-owners", async () => {
  const document = docs(),
    identity = JSON.stringify(["world"]),
    id = "retained",
    setup = { operationID: id, operationRunID: "old" },
    definitionValue = {
      ...definition(),
      operationID: id,
      revision: 1,
      createdAt: "x",
      updatedAt: "x",
    };
  let admitted = false;
  document("mining-definitions:" + identity).write({ version: 1, definitions: [definitionValue] });
  document("mining-launch:" + JSON.stringify([identity, id])).write({
    version: 1,
    operationID: id,
    operationRunID: "old",
    revision: 1,
    planHash: "p",
    setupHash: setupHash(setup),
    members: definition().members.map((m) => ({
      characterID: m.characterID,
      accountName: m.accountName,
      role: m.role,
      kind: "mcc-" + m.role.toLowerCase(),
      beforeIDs: [],
      status: "ACCEPTED",
      botID: "original-" + m.characterID,
    })),
  });
  const routes = createMiningOperationRoutes({
      document,
      getWorldScope: () => "world",
      isOperationActive: () => true,
      canFinish: () => admitted,
      retainedSetup: () => setup,
    }),
    read = routes["GET /mining-operations/:operationID/recovery"]!,
    dispatch = routes["POST /mining-operations/:operationID/recovery/dispatch"]!;
  const review: any = await read(req("Bob", { operationID: id }));
  assert.equal(review.body.recovery.operationRunID, "old");
  const body = { recoveryHash: review.body.recovery.recoveryHash, characterID: 1, beforeIDs: [] };
  assert.equal((await dispatch(req("Alice", { operationID: id }, body))).status, 400);
  admitted = true;
  assert.equal((await dispatch(req("Alice", { operationID: id }, body))).status, undefined);
  assert.equal((await dispatch(req("Alice", { operationID: id }, body))).status, 400);
});

test("FINISH dispatch pins original launch authority and prevents a never-dispatched member from continuing Start", async () => {
  const document = docs(),
    identity = JSON.stringify(["world"]),
    id = "partial-assembly",
    setup = { operationID: id, operationRunID: "old" };
  let granted: any = null;
  document("mining-definitions:" + identity).write({
    version: 1,
    definitions: [
      { ...definition(), operationID: id, revision: 1, createdAt: "x", updatedAt: "x" },
    ],
  });
  const original = {
    version: 1,
    operationID: id,
    operationRunID: "old",
    revision: 1,
    planHash: "p",
    setupHash: setupHash(setup),
    members: definition().members.map((m, i) => ({
      characterID: m.characterID,
      accountName: m.accountName,
      role: m.role,
      kind: "mcc-" + m.role.toLowerCase(),
      beforeIDs: [],
      status: i === 2 ? "PREPARED" : "ACCEPTED",
      botID: i === 2 ? null : "original-" + m.characterID,
    })),
  };
  document("mining-launch:" + JSON.stringify([identity, id])).write(original);
  const routes = createMiningOperationRoutes({
      document,
      getWorldScope: () => "world",
      isOperationActive: () => false,
      canFinish: () => true,
      retainedSetup: () => setup,
      authorizeFinish: (receipt) => {
        granted = structuredClone(receipt);
      },
    }),
    params = { operationID: id };
  const review: any = await routes["GET /mining-operations/:operationID/recovery"]!(
    req("Alice", params),
  );
  const result = await routes["POST /mining-operations/:operationID/recovery/dispatch"]!(
    req("Alice", params, {
      recoveryHash: review.body.recovery.recoveryHash,
      characterID: 1,
      beforeIDs: [],
    }),
  );
  assert.equal(result.status, undefined);
  assert.deepEqual(granted, original);
  const refused: any = await routes["POST /mining-operations/:operationID/launch/dispatch"]!(
    req("Alice", params, { characterID: 3 }),
  );
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /FINISH owns this generation/);
});

test("durable preparation and final native FINISH status survive absent host rows, with exact pilot/ship scope", async () => {
  const document = docs(),
    identity = JSON.stringify(["world"]),
    id = "durable-readouts",
    members = definition().members.map((m) => ({ ...m, shipID: m.characterID + 10 }));
  let wrongShip = false;
  document("mining-definitions:" + identity).write({
    version: 1,
    definitions: [
      { ...definition(), operationID: id, revision: 1, createdAt: "x", updatedAt: "x" },
    ],
  });
  document("mining-launch:" + JSON.stringify([identity, id])).write({
    version: 1,
    operationID: id,
    operationRunID: "old",
    revision: 1,
    planHash: "p",
    setupHash: "s",
    members: members.map((m) => ({
      characterID: m.characterID,
      accountName: m.accountName,
      role: m.role,
      kind: "mcc-" + m.role.toLowerCase(),
      beforeIDs: [],
      status: "ACCEPTED",
      botID: "old-" + m.characterID,
    })),
  });
  const routes = createMiningOperationRoutes({
    document,
    getWorldScope: () => "world",
    isOperationActive: () => false,
    operationSnapshot: () => ({
      operationID: id,
      runID: "old",
      members,
      state: "STOPPED",
      claim: null,
      manifests: [],
      jetcanIntents: {},
      settled: [1, 2, 3],
      parked: [],
      stayed: [1, 2, 3],
    }),
    preparationSnapshot: (world, op, run, characterID) => ({
      version: 1,
      world,
      botID: "old-prepare",
      readout: {
        operationID: op,
        operationRunID: run,
        characterID,
        shipID: characterID + (wrongShip ? 99 : 10),
        role: members.find((m) => m.characterID === characterID)!.role,
        state: "DEGRADED",
        equipment: "VERIFIED",
        targets: [],
        observedAt: 1000,
      },
    }),
    finishSnapshot: (op, run, characterID) => ({
      version: 1,
      operationID: op,
      runID: run,
      characterID,
      shipID: characterID + 10,
      observedAt: 2000,
      report: {
        phase: "Settled in place; retained freight settled",
        readout: { groupCompleted: true },
      },
    }),
  });
  const list = routes["GET /mining-operations"]!,
    result: any = await list(req("Alice")),
    r = result.body.operations[0].runtime;
  assert.equal(r.state, "STOPPED");
  assert.equal(r.preparation.historical, true);
  assert.equal(r.members[0].preparation.equipment, "VERIFIED");
  assert.match(r.members[0].lastHostReason, /Last native FINISH/);
  assert.equal(r.stoppedAt, new Date(2000).toISOString());
  wrongShip = true;
  const changed: any = await list(req("Alice"));
  assert.equal(changed.body.operations[0].runtime.preparation, undefined);
  assert.deepEqual(
    ((await list(req("Bob"))) as any).body.operations[0].definition,
    changed.body.operations[0].definition,
  );
});

test("unresolved and owned operations reject roster edits and preserve their original launch", async () => {
  const document = docs(),
    identity = JSON.stringify(["world"]),
    id = "legacy";
  const d = {
    ...definition(),
    operationID: id,
    revision: 1,
    createdAt: "before",
    updatedAt: "before",
  };
  const members = d.members.map((m) => ({ ...m, shipID: 10 + m.characterID }));
  const receipt = {
    version: 1,
    operationID: id,
    operationRunID: "original",
    revision: 1,
    planHash: "old",
    setupHash: "old-setup",
    members: members.map((m) => ({
      characterID: m.characterID,
      accountName: m.accountName,
      role: m.role,
      kind: "mcc-" + m.role.toLowerCase(),
      status: "ACCEPTED",
      botID: "bot-" + m.characterID,
      beforeIDs: [],
    })),
  };
  const scope = JSON.stringify([identity, id, receipt.operationRunID]);
  const launch = document("mining-launch:" + JSON.stringify([identity, id]));
  const setup = document("mining-launch-setup:" + scope),
    finish = document("mining-finish:" + scope);
  const originalSetup = { members, parking: d.policies.parking };
  const originalFinish = { attempts: [{ characterID: 2, botID: "finish-2", dispatchedAt: 123 }] };
  document("mining-definitions:" + identity).write({ version: 1, definitions: [d] });
  launch.write(receipt);
  setup.write(originalSetup);
  const snapshot = {
    operationID: id,
    runID: "original",
    state: "ACTIVE",
    members,
    settled: [1],
    parked: [1],
  };
  let active = false;
  const routes = createMiningOperationRoutes({
    document,
    getWorldScope: () => "world",
    isOperationActive: () => active,
    operationSnapshot: () => snapshot,
  });
  const save = routes["POST /mining-operations"]!,
    get = routes["GET /mining-operations"]!;
  for (const state of ["UNKNOWN", "RECOVERED_UNKNOWN", "ACTIVE"]) {
    if (state === "RECOVERED_UNKNOWN") finish.write(originalFinish);
    active = state === "ACTIVE";
    const { definition: current, runtime } = ((await get(req("Alice"))) as any).body.operations[0];
    assert.equal(runtime.state, active ? "ACTIVE" : "UNKNOWN");
    assert.equal(runtime.recoveryRequired, !active);
    const nextRoster = [
      d.members[0],
      { ...d.members[1], characterID: 8, accountName: "eight" },
      d.members[2],
    ];
    const result: any = await save(
      req("Alice", {}, { ...current, name: state, members: nextRoster }),
    );
    assert.equal(result.body.ok, false);
    assert.match(result.body.message, /stop|finish/i);
    const after = ((await get(req("Alice"))) as any).body.operations[0];
    assert.deepEqual(after.definition, d);
    assert.deepEqual(
      after.runtime.members.map((m: any) => [m.characterID, m.role, m.botID]),
      receipt.members.map((m) => [m.characterID, m.role, m.botID]),
    );
    assert.deepEqual(launch.read(), receipt);
    assert.deepEqual(setup.read(), originalSetup);
    assert.deepEqual(finish.read(), state === "UNKNOWN" ? null : originalFinish);
  }
});

test("only idle and verified stopped fleets allow changes to their saved definition", async () => {
  for (const state of [
    "DRAFT",
    "OWNED_WITHOUT_RECEIPT",
    "PREPARED",
    "DISPATCHED",
    "ACTIVE",
    "DRAINING",
    "PARKING",
    "STOPPED_WITH_OWNER",
    "STOPPED_WITH_FREIGHT",
    "STOPPED",
    "FAILED",
    "UNKNOWN_OWNER",
  ]) {
    const document = docs(),
      live = [
        "OWNED_WITHOUT_RECEIPT",
        "ACTIVE",
        "DRAINING",
        "PARKING",
        "STOPPED_WITH_OWNER",
      ].includes(state);
    const d = definition(),
      members = d.members.map((m) => ({ ...m, shipID: 10 + m.characterID }));
    const routes = createMiningOperationRoutes({
      document,
      getWorldScope: () => "world",
      ...(state === "UNKNOWN_OWNER" ? {} : { isOperationActive: () => live }),
      operationSnapshot: (operationID) =>
        state === "DISPATCHED"
          ? null
          : {
              operationID,
              runID: "run",
              state: state.startsWith("STOPPED") || state === "UNKNOWN_OWNER" ? "STOPPED" : state,
              haulClaims: state === "STOPPED_WITH_FREIGHT" ? { "55": { dispatched: true } } : {},
              members,
              claim: null,
              manifests: [],
              jetcanIntents: {},
              settled: [1, 2, 3],
              parked: [1, 2, 3],
            },
    });
    const save = routes["POST /mining-operations"]!,
      remove = routes["POST /mining-operations/:operationID/delete"]!;
    const created: any = await save(req("Alice", {}, d)),
      id = created.body.savedOperationID,
      original = created.body.operations[0].definition;
    const launch = document("mining-launch:" + JSON.stringify([JSON.stringify(["world"]), id]));
    if (state !== "DRAFT" && state !== "OWNED_WITHOUT_RECEIPT")
      launch.write({
        version: 1,
        operationID: id,
        operationRunID: "run",
        revision: 1,
        planHash: "plan",
        setupHash: "setup",
        members: members.map((m) => ({
          characterID: m.characterID,
          accountName: m.accountName,
          role: m.role,
          kind: "mcc-" + m.role.toLowerCase(),
          status: state === "PREPARED" || state === "DISPATCHED" ? state : "ACCEPTED",
          beforeIDs: [],
          botID: state === "PREPARED" || state === "DISPATCHED" ? null : "bot-" + m.characterID,
        })),
      });
    const receipt = launch.read(),
      params = { operationID: id };
    const edited: any = await save(
      req(
        "Bob",
        {},
        {
          ...original,
          name: "Edited",
          unloadDestination: { ...d.unloadDestination, corporationDivision: 3 },
        },
      ),
    );
    if (state === "DRAFT" || state === "PREPARED" || state === "STOPPED") {
      assert.equal(edited.body.operations[0].definition.revision, 2, state);
      if (state === "PREPARED") {
        const late = await routes["POST /mining-operations/:operationID/launch/dispatch"]!(
          req("Alice", params, { operationRunID: "run", characterID: 1 }),
        );
        assert.equal(late.status, 400);
        assert.deepEqual(launch.read(), receipt);
      }
      assert.deepEqual(
        ((await remove(req("Bob", params, { revision: 2 }))).body as any).operations,
        [],
        state,
      );
    } else {
      assert.equal(edited.status, 409, state);
      assert.equal((await remove(req("Bob", params, { revision: 1 }))).status, 409, state);
      assert.deepEqual(
        ((await routes["GET /mining-operations"]!(req("Alice"))).body as any).operations[0]
          .definition,
        original,
        state,
      );
      assert.deepEqual(launch.read(), receipt, state);
    }
  }
});

test("legacy definitions merge by exact ID, preserving revisions, roster and other worlds", async () => {
  const { createDocumentStore } = createRequire(import.meta.url)("../documentStore.cjs"),
    db = createDocumentStore(":memory:");
  try {
    const key = (...scope: string[]) => "mining-definitions:" + JSON.stringify(scope);
    const first = {
      ...definition(),
      operationID: "one",
      revision: 3,
      createdAt: "first",
      updatedAt: "revised",
    };
    const second = {
      ...first,
      operationID: "two",
      name: "Second",
      unloadDestination: { ...first.unloadDestination, corporationDivision: 2 },
    };
    const other = { ...first, name: "Other world" };
    db.document(key("world", "alice")).write({ version: 1, definitions: [first] });
    db.document(key("world", "bob")).write({ version: 1, definitions: [second, first] });
    db.document(key("world-next", "alice")).write({ version: 1, definitions: [other] });
    const routes = () =>
      createMiningOperationRoutes(
        {
          document: db.document,
          getWorldScope: (req) => req.worldID ?? null,
          isOperationActive: () => false,
        },
        db,
      );
    const read = async (worldID: string, account: string) =>
      (await routes()["GET /mining-operations"]!({ ...req(account), worldID } as UocBackendRequest))
        .body as any;
    const loaded = await read("world", "carol");
    assert.deepEqual(
      loaded.operations.map((row: any) => row.definition),
      [first, second],
    );
    assert.deepEqual(
      (await read("world", "bob")).operations.map((row: any) => row.definition),
      [first, second],
    );
    assert.deepEqual(db.document(key("world")).read(), {
      version: 1,
      definitions: [first, second],
    });
    assert.equal(db.document(key("world", "alice")).read(), null);
    assert.equal(db.document(key("world", "bob")).read(), null);
    assert.equal(db.document(key("world-next")).read(), null);
    assert.deepEqual(
      (await read("world-next", "alice")).operations.map((row: any) => row.definition),
      [other],
    );
  } finally {
    db.close();
  }
});

for (const incompatible of [false, true])
  test(
    incompatible
      ? "invalid legacy definition reports the source without writing"
      : "conflicting legacy operation ID names both sources without overwriting",
    async () => {
      const { createDocumentStore } = createRequire(import.meta.url)("../documentStore.cjs"),
        db = createDocumentStore(":memory:");
      try {
        const key = (...scope: string[]) => "mining-definitions:" + JSON.stringify(scope);
        const first = {
          ...definition(),
          operationID: "conflicting-id",
          revision: 1,
          createdAt: "saved",
          updatedAt: "saved",
        };
        const second = { ...first, name: "Different", revision: incompatible ? 0 : 1 };
        const original = { version: 1, definitions: [first] },
          legacy = { version: 1, definitions: [second] };
        db.document(key("world")).write(original);
        db.document(key("world", "bob")).write(legacy);
        const routes = createMiningOperationRoutes(
          { document: db.document, getWorldScope: () => "world" },
          db,
        );
        const result = await routes["GET /mining-operations"]!(req("Alice"));
        assert.equal(result.status, 400);
        const message = (result.body as any).message;
        assert.ok(message.includes(key("world", "bob")));
        assert.match(
          message,
          incompatible
            ? /Cannot import MCC definitions/
            : /Conflicting MCC operation conflicting-id/,
        );
        assert.deepEqual(db.document(key("world")).read(), original);
        assert.deepEqual(db.document(key("world", "bob")).read(), legacy);
      } finally {
        db.close();
      }
    },
  );

test("deleting a recovered generation clears its saved records and survives a SQLite reopen and late callbacks", async () => {
  const { createDocumentStore } = createRequire(import.meta.url)("../documentStore.cjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uoc-mcc-delete-")),
    file = path.join(dir, "definitions.sqlite");
  let db = createDocumentStore(file);
  try {
    const identity = JSON.stringify(["world", "alice"]),
      otherIdentity = JSON.stringify(["other-world", "bob"]),
      id = "legacy_%",
      otherID = id + "-other";
    const d = definition();
    d.policies.travelAssist.mode = "DISABLED";
    const saved = { ...d, operationID: id, revision: 1, createdAt: "before", updatedAt: "before" };
    const neighbor = { ...saved, operationID: otherID, name: "Neighbor" };
    db.document("mining-definitions:" + identity).write({
      version: 1,
      definitions: [saved, neighbor],
    });
    db.document("mining-definitions:" + otherIdentity).write({ version: 1, definitions: [saved] });
    db.document("settings").write({ example: "preserved" });
    const key = (kind: string, owner: string, op: string, run?: string) =>
      kind + ":" + JSON.stringify(run ? [owner, op, run] : [owner, op]);
    const setup = {
      operationID: id,
      operationRunID: "original",
      systemID: 300,
      beltID: 99,
      beltName: "Native belt",
      oreLogistics: d.oreLogistics,
      travelAssist: "DISABLED",
      destinationID: 600,
      corporationID: 77,
      division: 1,
      parking: { mode: "STAY_IN_PLACE" },
      members: d.members.map(({ characterID, role }) => ({
        characterID,
        role,
        shipID: characterID + 10,
      })),
    };
    const launchMembers = d.members.map((m) => ({
      characterID: m.characterID,
      accountName: m.accountName,
      role: m.role,
      kind: "mcc-" + m.role.toLowerCase(),
      beforeIDs: [],
    }));
    const launch = {
      version: 1,
      operationID: id,
      operationRunID: "original",
      revision: 1,
      planHash: "old",
      setupHash: setupHash(setup),
      members: launchMembers.map((m) => ({
        ...m,
        status: "ACCEPTED",
        botID: "bot-" + m.characterID,
      })),
    };
    const owned = [
      key("mining-launch", identity, id),
      ...["mining-launch-setup", "mining-launch-history", "mining-finish"].flatMap((kind) =>
        ["original", "earlier"].map((run) => key(kind, identity, id, run)),
      ),
    ];
    const otherRecords = [
      key("mining-launch-setup", identity, otherID, "original"),
      key("mining-finish", otherIdentity, id, "original"),
      key("mining-launch", otherIdentity, id),
    ];
    db.document(owned[0]).write(launch);
    db.document(owned[1]).write(setup);
    for (const name of owned.slice(2)) db.document(name).write({ unsettled: true });
    for (const name of otherRecords) db.document(name).write({ unrelated: true });
    const runtime = {
      operationID: id,
      runID: "original",
      state: "ACTIVE",
      members: setup.members,
      settled: [1, 3],
      parked: [1, 3],
      claim: null,
      manifests: [],
      jetcanIntents: {},
    };
    let pilotCalls = 0,
      delay = false,
      release!: () => void,
      entered!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const makeRoutes = () =>
      createMiningOperationRoutes(
        {
          document: db.document,
          getWorldScope: () => "world",
          isOperationActive: () => false,
          operationSnapshot: (op) => (op === id ? runtime : null),
          authorizeFinish() {
            pilotCalls++;
          },
          async finalizeRetainedStop() {
            pilotCalls++;
            return false;
          },
          async relocate() {
            pilotCalls++;
            return false;
          },
          async checkSetup(candidate) {
            if (delay) {
              entered();
              await gate;
            }
            return {
              ok: true,
              name: "fleet",
              setup: candidate as any,
              policy: { riskClasses: ["fleet"], restartSafe: false },
            };
          },
        },
        db,
      );
    let routes = makeRoutes();
    const params = { operationID: id },
      reviewBody = { revision: 1, setup };
    const before: any = await routes["GET /mining-operations"]!(req("Alice"));
    assert.equal(before.body.operations[0].runtime.state, "UNKNOWN");
    assert.equal(before.body.operations[0].runtime.recoveryRequired, true);
    const plan: any = await routes["POST /mining-operations/:operationID/launch-plan"]!(
      req("Alice", params, reviewBody),
    );
    assert.equal(plan.body.candidateSupported, true);
    delay = true;
    const late = routes["POST /mining-operations/:operationID/launch/begin"]!(
      req("Alice", params, { ...reviewBody, planHash: plan.body.planHash, members: launchMembers }),
    );
    await pending;
    assert.equal(
      (
        await routes["POST /mining-operations/:operationID/delete"]!(
          req("Alice", params, { revision: 1 }),
        )
      ).status,
      409,
    );
    assert.deepEqual(db.document(owned[0]).read(), launch);
    Object.assign(runtime, { state: "STOPPED", settled: [1, 2, 3], parked: [1, 2, 3] });
    const removed: any = await routes["POST /mining-operations/:operationID/delete"]!(
      req("Alice", params, { revision: 1 }),
    );
    assert.deepEqual(
      removed.body.operations.map((row: any) => row.definition),
      [neighbor],
    );
    release();
    const stale: any = await late;
    assert.equal(stale.status, 400);
    assert.match(stale.body.message, /deleted or changed during review/);
    for (const [route, body] of [
      ["POST /mining-operations/:operationID/launch/accept", { characterID: 2, botID: "late" }],
      [
        "POST /mining-operations/:operationID/recovery/accept",
        { characterID: 2, botID: "late-finish" },
      ],
      ["POST /mining-operations", saved],
    ] as const)
      assert.equal((await routes[route]!(req("Alice", params, body))).status, 400);
    assert.equal(pilotCalls, 0);
    db.close();
    db = createDocumentStore(file);
    routes = makeRoutes();
    const refreshed: any = await routes["GET /mining-operations"]!(req("Alice"));
    assert.deepEqual(
      refreshed.body.operations.map((row: any) => row.definition),
      [neighbor],
    );
    assert.equal(
      (await routes["GET /mining-operations/:operationID/recovery"]!(req("Alice", params))).status,
      400,
    );
    for (const name of owned) assert.equal(db.document(name).read(), null, name);
    for (const name of otherRecords)
      assert.deepEqual(db.document(name).read(), { unrelated: true });
    assert.deepEqual(db.document("mining-definitions:" + otherIdentity).read().definitions, [
      saved,
    ]);
    assert.deepEqual(db.document("settings").read(), { example: "preserved" });
  } finally {
    db.close();
    for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(file + suffix, { force: true });
    fs.rmdirSync(dir);
  }
});
