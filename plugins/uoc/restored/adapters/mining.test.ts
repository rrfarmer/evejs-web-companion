import test from "node:test";
import assert from "node:assert/strict";
import { installPageContext } from "../app/context.ts";
import { createRestoredMiningHost, loadMiningOperations } from "./mining.ts";
import { createFleetLaunchJournal } from "../../operations/miningLaunchJournal.ts";
import type { SavedDefinition } from "../../operations/miningStore.ts";

for (const needsNativeBeltNames of [false, true])
  test(
    needsNativeBeltNames
      ? "MCC discovers unnamed Mista belts, skips unavailable targets and starts on an unlisted belt"
      : "one-click MCC plans exact hull IDs from the account roster and starts only the productive runs",
    async () => {
      const members = [
        {
          characterID: 1,
          characterName: "Miner",
          accountName: "miner",
          role: "MINER",
          automationID: "",
          preparation: { fittingID: 42 },
        },
        {
          characterID: 2,
          characterName: "Hauler",
          accountName: "hauler",
          role: "HAULER",
          automationID: "",
        },
      ];
      const systemID = needsNativeBeltNames ? 30003482 : 300;
      const belts = needsNativeBeltNames
        ? [40220948, 40220958, 40220961, 40220955, 40220960].map((itemID, index) => ({
            itemID,
            name: `Mista IX - Asteroid Belt ${index + 1}`,
          }))
        : [{ itemID: 99, name: "Ore belt" }];
      const targetBoard = needsNativeBeltNames
        ? belts
            .slice(0, 3)
            .map(({ name }, index) => ({
              targetKey: `BELT:${systemID}:${name}`,
              state: index === 2 ? "ACTIVE" : "DEPLETED",
            }))
        : [];
      const expectedBelt = belts[needsNativeBeltNames ? 3 : 0]!;
      const definition: SavedDefinition = {
        operationID: "op",
        revision: 1,
        createdAt: "a",
        updatedAt: "a",
        name: "Fleet",
        area: {
          anchorSystemID: systemID,
          anchorSystemName: needsNativeBeltNames ? "Mista" : null,
          reach: "CURRENT_SYSTEM",
          targetClasses: ["BELT"],
        },
        targetPolicy: "ANY_ELIGIBLE",
        unloadPolicy: "HAULER_SERVICE",
        unloadDestination: { stationID: 600, corporationDivision: null },
        members,
      };
      let stored: unknown = null;
      const journal = createFleetLaunchJournal({
        read: () => stored,
        write: (value) => {
          stored = value;
        },
      });
      const started: string[] = [],
        released: string[] = [],
        prepared: string[] = [],
        inspected: number[] = [];
      let inspection: object | null = null;
      const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(String(input), "http://fixture"),
          path = url.pathname,
          token = new Headers(init?.headers).get("authorization");
        const request = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        let body: object;
        if (path.endsWith("/mining-operations"))
          body = {
            operations: [{ definition, runtime: { state: "DRAFT", operationRunID: null } }],
            targetBoard,
            targetBoardAvailable: true,
            capabilities: {},
          };
        else if (path === "/api/bots")
          body = {
            bots: inspection && token === "Bearer authorized-1" ? [inspection] : [],
            hostedRunPolicy: {
              maxRuntimeMinutes: 720,
              defaultRuntimeMinutes: 60,
              durationChoices: [60, 720],
            },
          };
        else if (path === "/api/plugins/uoc/world") body = { worldID: "mista-fixture" };
        else if (path === "/api/pilot-training/login") {
          const member = members.find((m) => m.accountName === request.username)!;
          assert.equal(token, null);
          body = {
            sessionToken: "roster-" + member.characterID,
            account: { username: member.accountName },
            characters: [
              {
                characterID: member.characterID,
                stationID: 600,
                solarSystemID: 300,
                corporationID: 77,
                raw: { shipID: 100 + member.characterID, shipTypeID: 2000 + member.characterID },
              },
            ],
          };
        } else if (path === "/api/logout") {
          released.push(token!);
          body = {};
        } else if (path === `/api/client-data/system-objects/${systemID}`)
          body = {
            available: true,
            objects: belts.map(({ itemID, name }) =>
              needsNativeBeltNames
                ? { itemID, groupID: 9, typeID: 15 }
                : { itemID, groupID: 9, name },
            ),
          };
        else if (path === "/api/names") {
          assert.equal(token, "Bearer operator");
          assert.deepEqual(
            request.items,
            belts.map(({ itemID }) => ({ kind: "evelocation", id: itemID })),
          );
          const unresolved = belts.map(({ itemID }) => `evelocation:${itemID}`);
          body = { names: Object.fromEntries(unresolved.map((key) => [key, null])), unresolved };
        } else if (path === "/api/client-data/dogma-types")
          body = { available: true, types: { 23: { attributes: [[38, 100]] } } };
        else if (path === "/api/map/resolve/600")
          body = { kind: "station", stationID: 600, solarSystemID: 300 };
        else if (path.endsWith("/check")) {
          const run = path.split("/").at(-2)!;
          if (run !== "mcc-inspect") prepared.push(run);
          body = {
            setup: request.setup,
            policy: { riskClasses: ["inventory"], restartSafe: true },
          };
        } else if (path.endsWith("/launch-plan")) {
          assert.equal(request.setup.beltID, expectedBelt.itemID);
          body = { planHash: "hash", candidateSupported: true };
        } else if (path.endsWith("/launch")) body = { receipt: journal.read() };
        else if (path.endsWith("/launch/begin"))
          body = {
            receipt: journal.begin({
              operationID: "op",
              operationRunID: "run",
              revision: 1,
              planHash: "hash",
              setupHash: "setup",
              members: request.members,
            }),
          };
        else if (path.endsWith("/launch/dispatch"))
          body = { receipt: journal.dispatch(request.characterID) };
        else if (path.endsWith("/launch/accept"))
          body = { receipt: journal.accept(request.characterID, request.botID) };
        else if (path.endsWith("/launch/end")) body = {};
        else if (path === "/api/bots/start" && request.run === "mcc-inspect") {
          assert.equal(token, "Bearer authorized-1");
          assert.deepEqual(request.setup, {
            systemID,
            equipmentReview: false,
            commandModules: false,
          });
          inspected.push(request.characterID);
          inspection = {
            botID: "inspection-1",
            kind: "plugin",
            characterID: 1,
            phase: "Fleet pilot inspected",
            status: "stopped",
            endedAt: "2026-11-22T00:00:00Z",
            plugin: {
              pluginID: "uoc",
              run: request.run,
              readout: {
                characterID: 1,
                systemID: 300,
                targetSystemID: systemID,
                shipID: 101,
                belts,
              },
            },
          };
          body = { bot: inspection };
        } else if (path === "/api/bots/start") {
          started.push(request.run);
          assert.equal(token, "Bearer authorized-" + request.characterID);
          assert.equal(request.setup.beltID, expectedBelt.itemID);
          assert.equal(request.setup.beltName, expectedBelt.name);
          assert.deepEqual(
            request.setup.members.map((m: { shipID: number }) => m.shipID),
            [101, 102],
          );
          assert.equal(request.setup.startupPreparation[0].preparation.fittingID, 42);
          body = {
            bot: {
              botID: "hosted-" + request.characterID,
              kind: "plugin",
              characterID: request.characterID,
              plugin: { pluginID: "uoc", run: request.run },
            },
          };
        } else throw Error("Unexpected fixture request " + path);
        return Response.json({ ok: true, ...body });
      };
      installPageContext({
        fetch: fetcher,
        readAccounts: () =>
          members.map((m) => ({
            accountID: m.characterID,
            username: m.accountName,
            options: {
              token: "authorized-" + m.characterID,
              baseUrl: "http://fixture",
              fetch: fetcher,
            },
          })),
      });
      const host = createRestoredMiningHost(
        { baseUrl: "http://fixture", token: "operator", fetch: fetcher },
        async () => assert.fail("No fleet move is approved by account planning."),
      );
      const review = await host.prepare("op", "run", true);
      assert.deepEqual(inspected, needsNativeBeltNames ? [1] : []);
      assert.equal(review.setup.beltID, expectedBelt.itemID);
      assert.deepEqual(
        review.setup.beltCandidates,
        belts.map(({ itemID, name }) => ({ beltID: itemID, beltName: name })),
      );
      assert.equal(review.launchPlan.preparation?.state, "PENDING");
      assert.deepEqual(started, []);
      assert.deepEqual(
        (await host.start(review, 720))?.members.map((row) => row.status),
        ["ACCEPTED", "ACCEPTED"],
      );
      assert.deepEqual(started.sort(), ["mcc-hauler", "mcc-miner"]);
      assert.deepEqual(prepared.sort(), started);
      assert.deepEqual(released.sort(), ["Bearer roster-1", "Bearer roster-2"]);
    },
  );

test("operation read exposes only the actual authenticated host policy", async () => {
  const paths: string[] = [];
  installPageContext({
    fetch: async (input) => {
      const path = new URL(String(input), "http://bff").pathname;
      paths.push(path);
      return Response.json(
        path === "/api/bots"
          ? {
              ok: true,
              hostedRunPolicy: {
                maxRuntimeMinutes: 120,
                defaultRuntimeMinutes: 60,
                durationChoices: [60, 120],
              },
            }
          : {
              ok: true,
              operations: [],
              targetBoard: [],
              capabilities: {
                targetClasses: {},
                reach: {},
                defender: {},
                operationOwnedContainers: {},
              },
            },
      );
    },
  });
  const value = await loadMiningOperations({ token: "test" });
  assert.equal(value.capabilities.hostedRunPolicy?.maxRuntimeMinutes, 120);
  assert.ok(paths.includes("/api/bots"));
});
test("operation read refuses an absent or malformed host policy", async () => {
  installPageContext({
    fetch: async (input) =>
      Response.json(
        new URL(String(input), "http://bff").pathname === "/api/bots"
          ? { ok: true, hostedRunPolicy: null }
          : { ok: true, operations: [], targetBoard: [], capabilities: {} },
      ),
  });
  await assert.rejects(loadMiningOperations({ token: "test" }), /policy is unavailable/);
});

test("partial host preparation history cannot replace durable preparation for the rest of the exact roster", async () => {
  const policy = { maxRuntimeMinutes: 60, defaultRuntimeMinutes: 60, durationChoices: [60] },
    members = [1, 2].map((characterID) => ({
      characterID,
      role: "MINER",
      accountName: "closure-" + characterID,
      kind: "mcc-miner",
      status: "ACCEPTED",
      botID: "old-" + characterID,
      beforeIDs: [],
    })),
    preparation = {
      historical: true,
      state: "DEGRADED",
      members: members.map((m) => ({
        characterID: m.characterID,
        role: m.role,
        state: "DEGRADED",
        equipment: "VERIFIED",
        targets: [],
        reason: "Durable " + m.characterID,
      })),
    };
  const fetcher: typeof fetch = async (input) => {
    const p = new URL(String(input), "http://fixture").pathname;
    let body: any;
    if (p === "/api/bots")
      body = {
        bots: [
          {
            botID: "prepared-1",
            characterID: 1,
            kind: "plugin",
            plugin: {
              pluginID: "uoc",
              run: "mcc-prepare",
              readout: {
                operationID: "op",
                operationRunID: "run",
                characterID: 1,
                state: "DEGRADED",
                equipment: "VERIFIED",
                targets: [],
                observedAt: 1,
              },
            },
            endedAt: "2026-01-01",
            phase: "Mining member prepared",
          },
        ],
        hostedRunPolicy: policy,
      };
    else if (p.endsWith("/launch"))
      body = { receipt: { operationID: "op", operationRunID: "run", members } };
    else if (p.endsWith("/runs/current")) body = { runs: [] };
    else if (p.endsWith("/mining-operations"))
      body = {
        operations: [
          {
            definition: { operationID: "op", members },
            runtime: { operationRunID: "run", state: "WAITING_FOR_HOST", members, preparation },
          },
        ],
        targetBoard: [],
        capabilities: {},
      };
    else throw Error(p);
    return Response.json({ ok: true, ...body });
  };
  installPageContext({
    fetch: fetcher,
    readAccounts: () =>
      members.map((m) => ({
        accountID: m.characterID,
        username: m.accountName,
        options: { token: "fixture-" + m.characterID, fetch: fetcher },
      })),
  });
  const r = await loadMiningOperations({ token: "fixture" });
  assert.equal(r.operations[0]?.runtime.state, "WAITING_FOR_HOST");
  assert.equal(r.operations[0]?.runtime.preparation?.members?.length, 2);
  assert.equal(r.operations[0]?.runtime.preparation?.members?.[1]?.reason, "Durable 2");
  assert.equal(r.operations[0]?.runtime.preparation?.historical, true);
});

test("MCC refresh asks UOC to retire a generation after its last hosted row ends", async () => {
  const policy = { maxRuntimeMinutes: 60, defaultRuntimeMinutes: 60, durationChoices: [60] };
  const members = [1, 2].map((characterID) => ({
    characterID,
    role: characterID === 1 ? "MINER" : "HAULER",
    accountName: "pilot-" + characterID,
    kind: characterID === 1 ? "mcc-miner" : "mcc-hauler",
    status: "ACCEPTED",
    botID: "bot-" + characterID,
    beforeIDs: [],
  }));
  const receipt = { operationID: "op", operationRunID: "run", members };
  const definition = { operationID: "op", members },
    target = { targetKey: "BELT:300:Ore", state: "ACTIVE" };
  let hosted = true,
    ownershipReadable = true;
  const observations: unknown[] = [];
  const list = (running: boolean) => ({
    operations: [
      {
        definition,
        runtime: {
          state: running ? "WAITING_FOR_HOST" : "DRAFT",
          operationRunID: running ? "run" : null,
          members,
        },
      },
    ],
    targetBoard: running ? [target] : [],
    capabilities: {},
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://fixture"),
      token = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/api/bots") {
      if (token === "Bearer auth-1" && !ownershipReadable)
        return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
      return Response.json({
        bots:
          hosted && token === "Bearer auth-2"
            ? [{ botID: "bot-2", characterID: 2, endedAt: null }]
            : [],
        hostedRunPolicy: policy,
      });
    }
    if (url.pathname.endsWith("/runs/current")) return Response.json({ runs: [] });
    if (url.pathname.endsWith("/launch")) return Response.json({ receipt });
    if (url.pathname === "/api/pilot-training/ownership")
      return Response.json({
        ownership: {
          characterID: Number(url.searchParams.get("characterID")),
          owner: "OFF",
          online: false,
        },
      });
    if (url.pathname.endsWith("/mining-operations")) return Response.json(list(true));
    assert.equal(url.pathname, "/api/plugins/uoc/mining-operations/observe");
    observations.push(JSON.parse(String(init?.body)));
    return Response.json(list(false));
  };
  installPageContext({
    fetch: fetcher,
    readAccounts: () =>
      members.map((m) => ({
        accountID: m.characterID,
        username: m.accountName,
        options: { token: "auth-" + m.characterID, fetch: fetcher },
      })),
  });
  const options = { token: "commander", fetch: fetcher };
  assert.equal(
    (await loadMiningOperations(options)).operations[0]?.runtime.state,
    "WAITING_FOR_HOST",
  );
  hosted = false;
  ownershipReadable = false;
  assert.equal(
    (await loadMiningOperations(options)).operations[0]?.runtime.state,
    "WAITING_FOR_HOST",
  );
  assert.equal(observations.length, 0);
  ownershipReadable = true;
  const ready = await loadMiningOperations(options);
  assert.deepEqual(observations, [{ generations: [{ operationID: "op", operationRunID: "run" }] }]);
  assert.equal(ready.operations[0]?.runtime.state, "DRAFT");
  assert.equal(ready.operations[0]?.runtime.operationRunID, null);
  assert.deepEqual(ready.operations[0]?.definition, definition);
  assert.deepEqual(ready.targetBoard, []);
});

test("a verified stopped fleet stays stopped without per-pilot access or a page observation", async () => {
  const member = {
    characterID: 1,
    role: "MINER",
    accountName: "miner",
    kind: "mcc-miner",
    status: "ACCEPTED",
    botID: "bot-1",
    beforeIDs: [],
  };
  const receipt = { operationID: "op", operationRunID: "run", members: [member] };
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input), "http://fixture").pathname;
    if (path === "/api/bots")
      return Response.json({
        bots: [],
        hostedRunPolicy: {
          maxRuntimeMinutes: 60,
          defaultRuntimeMinutes: 60,
          durationChoices: [60],
        },
      });
    if (path.endsWith("/launch")) return Response.json({ ok: true, receipt });
    assert.ok(path.endsWith("/mining-operations"), path);
    const runtime = {
      operationID: "op",
      operationRunID: "run",
      state: "STOPPED",
      members: [member],
      stopFreight: "RETURN_HOME",
      stopFailures: [],
    };
    return Response.json({
      ok: true,
      operations: [{ definition: { operationID: "op", members: [member] }, runtime }],
      capabilities: {},
      targetBoard: [],
    });
  };
  installPageContext({ fetch: fetcher, readAccounts: () => [] });
  const { runtime } = (await loadMiningOperations({ token: "operator", fetch: fetcher }))
    .operations[0]!;
  assert.equal(runtime.state, "STOPPED");
  assert.deepEqual(runtime.stopFailures, []);
});

test("stopped fleet reads every offline pilot and ends without requiring ended controllers", async () => {
  const policy = { maxRuntimeMinutes: 720, defaultRuntimeMinutes: 60, durationChoices: [60, 720] };
  const members = Array.from({ length: 14 }, (_, i) => ({
    characterID: i + 1,
    accountName: "offline-" + (i + 1),
    role: i < 8 ? "MINER" : i < 10 ? "HAULER" : "DEFENDER",
    status: i >= 12 ? "DISPATCHED" : "ACCEPTED",
    botID: i >= 12 ? null : "ended-" + (i + 1),
    kind: i < 8 ? "mcc-miner" : i < 10 ? "mcc-hauler" : "mcc-defender",
    beforeIDs: [],
    parkingState: i === 8 || i >= 12 ? "UNVERIFIED" : "DOCK_VERIFIED",
  }));
  let hosted = true,
    broken = false,
    online = false;
  const observed: any[] = [],
    ownership: number[] = [];
  const list = (ended = false) => ({
    operations: [
      {
        definition: { operationID: "op", members },
        runtime: {
          operationRunID: ended ? null : "run",
          state: ended ? "DRAFT" : "WAITING_FOR_HOST",
          stopFreight: "COLLECT_FREIGHT",
          members,
        },
      },
    ],
    targetBoard: [],
    capabilities: {},
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://fixture");
    if (url.pathname === "/api/bots")
      return Response.json({
        hostedRunPolicy: policy,
        bots: hosted ? [{ botID: "ended-10", characterID: 10, endedAt: null }] : [],
      });
    if (url.pathname.endsWith("/runs/current")) return Response.json({ runs: [] });
    if (url.pathname.endsWith("/launch"))
      return Response.json({ receipt: { operationID: "op", operationRunID: "run", members } });
    if (url.pathname.endsWith("/mining-operations")) return Response.json(list());
    if (url.pathname === "/api/pilot-training/ownership") {
      const id = Number(url.searchParams.get("characterID"));
      ownership.push(id);
      if (broken && id === 9) return Response.json({ error: "unavailable" }, { status: 503 });
      if (online && id === 9)
        return Response.json({ ownership: { characterID: id, owner: "BROWSER", online: true } });
      return Response.json({ ownership: { characterID: id, owner: "OFF", online: false } });
    }
    assert.ok(url.pathname.endsWith("/observe"));
    const body = JSON.parse(String(init?.body));
    observed.push(body);
    return Response.json(list(body.generations[0].endStopped === true));
  };
  installPageContext({
    fetch: fetcher,
    readAccounts: () =>
      members.map((m) => ({
        accountID: m.characterID,
        username: m.accountName,
        options: { token: "offline-" + m.characterID, fetch: fetcher },
      })),
  });
  const options = { token: "test", fetch: fetcher };
  const partial = await loadMiningOperations(options);
  assert.equal(partial.operations[0]?.runtime.members[0]?.parkingState, "RELEASED");
  assert.equal(observed.length, 0, "a remaining hosted pilot prevents logical ending");
  hosted = false;
  broken = true;
  const unreadable = await loadMiningOperations(options);
  assert.equal(unreadable.operations[0]?.runtime.state, "WAITING_FOR_HOST");
  assert.equal(observed[0].generations[0].endStopped, undefined);
  broken = false;
  online = true;
  assert.equal(
    (await loadMiningOperations(options)).operations[0]?.runtime.state,
    "WAITING_FOR_HOST",
  );
  assert.equal(observed.at(-1).generations[0].endStopped, undefined);
  online = false;
  ownership.length = 0;
  const ended = await loadMiningOperations(options);
  assert.deepEqual(
    ownership.sort((a, b) => a - b),
    members.map((m) => m.characterID),
  );
  assert.equal(observed.at(-1).generations[0].endStopped, true);
  assert.equal(ended.operations[0]?.runtime.state, "DRAFT");
  assert.equal(ended.operations[0]?.runtime.operationRunID, null);
  assert.equal(ended.operations[0]?.definition.members.length, 14);
  const before = observed.length;
  await createRestoredMiningHost(options, async () => false).stop("op");
  assert.equal(
    observed.length,
    before + 1,
    "all fourteen Stop checks share one current operation read",
  );
});

test("Retry Stop rechecks offline release before requesting an exact incomplete close", async (t) => {
  const scope = { operationID: "retained-fleet", operationRunID: "stopped-shift" };
  const roster = ["Miner", "Freight Pilot"].map((characterName, index) => ({
    characterID: index + 1,
    characterName,
    accountName: characterName.toLowerCase(),
    role: index ? "HAULER" : "MINER",
    status: "ACCEPTED",
    botID: "original-" + index,
    beforeIDs: [],
  }));
  const definition = { operationID: scope.operationID, members: roster };
  const unverifiedStop = {
    operationRunID: scope.operationRunID,
    closedAt: Date.now(),
    unconfirmedDeliveries: 8,
    unverifiedPilots: [2],
  };
  const policy = { maxRuntimeMinutes: 720, defaultRuntimeMinutes: 60, durationChoices: [60, 720] };
  let busy = false,
    closed = false,
    unavailable = false,
    launchUnavailable = false;
  const mutations: unknown[] = [];
  const list = () => ({
    operations: [
      {
        definition,
        runtime: {
          operationRunID: closed ? null : scope.operationRunID,
          state: closed ? "DRAFT" : "PARKING_FAILED",
          ...(closed
            ? { unverifiedStop }
            : { stopFreight: "COLLECT_FREIGHT", canCloseOfflineStop: true }),
          members: roster,
        },
      },
    ],
    targetBoard: [],
    capabilities: {},
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), "http://fixture");
    if (url.pathname === "/api/bots")
      return Response.json({
        hostedRunPolicy: policy,
        bots: busy ? [{ botID: "original-1", characterID: 2, endedAt: null }] : [],
      });
    if (url.pathname.endsWith("/runs/current")) return Response.json({ runs: [] });
    if (url.pathname.endsWith("/launch"))
      return Response.json({ receipt: launchUnavailable ? null : { ...scope, members: roster } });
    if (url.pathname.endsWith("/mining-operations")) return Response.json(list());
    if (url.pathname === "/api/pilot-training/ownership") {
      const characterID = Number(url.searchParams.get("characterID"));
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer account-" + characterID,
      );
      if (unavailable && characterID === 2)
        return Response.json({ ok: false, error: "Unavailable" }, { status: 503 });
      return Response.json({ ownership: { characterID, owner: "OFF", online: false } });
    }
    assert.ok(url.pathname.endsWith("/observe"), url.pathname);
    const body = JSON.parse(String(init?.body));
    if (body.generations[0].closeOfflineStop === true) {
      mutations.push(body);
      closed = true;
    }
    return Response.json(list());
  };
  installPageContext({
    fetch: fetcher,
    readAccounts: () =>
      roster.map((m) => ({
        accountID: m.characterID,
        username: m.accountName,
        options: { token: "account-" + m.characterID, fetch: fetcher },
      })),
  });
  t.after(() => installPageContext({}));
  const options = { token: "operator", fetch: fetcher };
  launchUnavailable = true;
  assert.equal(
    (await loadMiningOperations(options)).operations[0]?.runtime.canCloseOfflineStop,
    false,
  );
  launchUnavailable = false;
  const preview = await loadMiningOperations(options);
  assert.equal(preview.operations[0]?.runtime.canCloseOfflineStop, true);
  assert.equal(mutations.length, 0);
  busy = true;
  await assert.rejects(loadMiningOperations(options, scope), /Offline release.*Freight Pilot/);
  busy = false;
  unavailable = true;
  await assert.rejects(loadMiningOperations(options, scope), /Offline release.*Freight Pilot/);
  unavailable = false;
  await assert.rejects(
    loadMiningOperations(options, { ...scope, operationRunID: "another" }),
    /changed or still has/,
  );
  assert.equal(mutations.length, 0);
  const stopped = await loadMiningOperations(options, scope);
  assert.equal(stopped.operations[0]?.runtime.state, "DRAFT");
  assert.deepEqual(stopped.operations[0]?.runtime.unverifiedStop, unverifiedStop);
  assert.deepEqual(mutations, [
    { generations: [{ ...scope, endStopped: true, closeOfflineStop: true }] },
  ]);
  assert.equal(
    (await loadMiningOperations(options, scope)).operations[0]?.runtime.operationRunID,
    null,
  );
  assert.equal(mutations.length, 1);
});
