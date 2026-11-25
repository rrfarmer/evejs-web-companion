import { memoryFleetDocuments, memoryOperationStore } from "./operationStoreFixture.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createFleetMiningCycle, iceCycleTiming, miningCycleDocument } from "./miningCycle.ts";
import { createRequire } from "node:module";
import { createMiningFleetRuntime, type FleetSetup } from "./runtime.ts";
import { settleFleetMember } from "./settle.ts";
import { createNativeBeltNavigation, type MiningReadiness } from "./nativeBelt.ts";
import { createNativeMiner } from "./nativeMember.ts";
import { createRawMembers } from "./memberLoops.ts";
import { createOperation, type ManifestItem } from "./operation.ts";
import { createTargetBoard } from "./targetBoard.ts";
import { createRawTypeFacts } from "./typeFacts.ts";
import { createTravelAssist, type MiningTravelAssist } from "./travelAssist.ts";
import { createPilotTiming, type MccTiming } from "./timing.ts";
import { TransportQueueError } from "../../../web/src/app/transport.ts";
import { FleetObservationUnavailable } from "./stopSignal.ts";
const setup = {
  operationID: "op",
  operationRunID: "epoch",
  systemID: 300,
  beltID: 99,
  canCapacityM3: 55000,
  members: [{ characterID: 1, shipID: 11, role: "MINER" }],
};
const identity = JSON.stringify(["op", "epoch", 1, 11, 300, 99, "bot"]);
function store(initial: unknown) {
  let value = structuredClone(initial);
  return {
    read: () => structuredClone(value),
    write: (v: unknown) => {
      value = structuredClone(v);
    },
  };
}
const session: any = { flow: { requestOptions: () => ({}) } };
const run: any = { botID: "bot", characterID: 1, setup, baseUrl: "http://bff", fetch: fetch };
test("unknown durable lock or activation is never replayed on reattach", async () => {
  for (const kind of ["target-lock", "mining-cycle"]) {
    const document = store({
      version: 1,
      identity,
      nextOrdinal: 2,
      pending: { kind },
      closed: false,
      retired: [],
    });
    await assert.rejects(
      createFleetMiningCycle(
        run,
        session,
        () => {},
        () => false,
        { document },
      ),
      /reconciliation.*no replay/,
    );
  }
});
test("a released Miner starts a fresh generation without the old ship, station or cycle history", async () => {
  const previous = { operationID: "unknown-operation", operationRunID: "previous-epoch" };
  const historical = {
    version: 1,
    identity: JSON.stringify([
      previous.operationID,
      previous.operationRunID,
      1,
      19,
      299,
      98,
      "ended-bot",
    ]),
    nextOrdinal: 1,
    pending: null,
    closed: false,
    retired: [],
  };
  const legacy = store(historical),
    scoped = new Map<string, ReturnType<typeof store>>([["pilot:1", legacy]]);
  const documents = (key: string) => {
    if (!scoped.has(key)) scoped.set(key, store(null));
    return scoped.get(key)!;
  };
  const current = miningCycleDocument(1, setup, documents);
  let reads = 0;
  const cycle = await createFleetMiningCycle(
    {
      ...run,
      fetch: async () => {
        reads++;
        throw Error("No historical native action expected during startup");
      },
    },
    session,
    () => {},
    () => false,
    { document: current },
  );
  assert.equal((current.read() as typeof historical).identity, identity);
  assert.equal(reads, 0);
  await cycle.release!();
  assert.deepEqual(miningCycleDocument(1, previous, documents).read(), historical);
  assert.deepEqual(legacy.read(), historical);
});
test("legacy readback keeps an uncertain cycle fenced in its own generation", async () => {
  const historical = {
    version: 1,
    identity,
    nextOrdinal: 2,
    pending: { kind: "mining-cycle" },
    closed: false,
    retired: [],
  };
  const legacy = store(historical),
    scoped = store(null),
    document = miningCycleDocument(1, setup, (key) => (key === "pilot:1" ? legacy : scoped));
  await assert.rejects(
    createFleetMiningCycle(
      run,
      session,
      () => {},
      () => false,
      { document },
    ),
    /reconciliation.*no replay/,
  );
  await assert.rejects(
    createFleetMiningCycle(
      { ...run, botID: "different-bot" },
      session,
      () => {},
      () => false,
      { document },
    ),
    /this fleet generation/,
  );
  assert.deepEqual(document.read(), historical);
  assert.equal(scoped.read(), null);
});
test("a hosted restart reopens the exact same saved belt cycle with its new Bot Host ID", async () => {
  const old = {
    version: 1,
    identity,
    nextOrdinal: 3,
    pending: null,
    closed: false,
    retired: [777],
    lastCycle: { gain: 42 },
  };
  const document = store(old),
    resumed = { ...run, botID: "restored", resumed: true };
  await assert.rejects(
    createFleetMiningCycle(
      { ...resumed, setup: { ...setup, beltID: 100 } },
      session,
      () => {},
      () => false,
      { document },
    ),
    /different mining identity/,
  );
  assert.deepEqual(document.read(), old);
  await createFleetMiningCycle(
    resumed,
    session,
    () => {},
    () => false,
    { document },
  );
  assert.deepEqual(document.read(), {
    ...old,
    identity: JSON.stringify(["op", "epoch", 1, 11, 300, 99, "restored"]),
  });
});
function settler(drones: unknown, active: unknown) {
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    const body = path.endsWith("/status")
      ? { flight: { shipID: 11, inSpace: true, solarSystemID: 300 } }
      : path.endsWith("/drones")
        ? {
            activeShipID: 11,
            bay: [],
            inSpace: drones,
            errors: { bay: null, shipInfo: null, inSpace: null },
          }
        : {
            space: {
              inSpace: true,
              shipID: 11,
              solarSystemID: 300,
              ship: { itemID: 11, characterID: 1, activeModuleIDs: active },
              entities: [],
            },
          };
    return new Response(JSON.stringify({ ok: true, ...body }), {
      headers: { "content-type": "application/json" },
    });
  };
  return { ...run, fetch: fetcher };
}
test("settlement requires exact ship, readable empty drones and inactive native modules", async () => {
  const ok = await settleFleetMember(settler([], []) as any, session, () => {});
  assert.equal(ok.modulesInactive, true);
  await assert.rejects(
    settleFleetMember(settler(null, []) as any, session, () => {}),
    /Drone/,
  );
  await assert.rejects(
    settleFleetMember(settler([{ itemID: 7 }], []) as any, session, () => {}),
    /Drone/,
  );
  await assert.rejects(
    settleFleetMember(settler([], null) as any, session, () => {}),
    /module/,
  );
  await assert.rejects(
    settleFleetMember(settler([], [55]) as any, session, () => {}),
    /module/,
  );
});
const iceTarget = {
    kind: "ICE" as const,
    systemID: 300,
    name: "ore-site",
    siteID: 55,
    instanceID: 89,
    position: { x: 0, y: 0, z: 0 },
  },
  iceClaim = {
    key: "ICE:300:site:55:instance:89",
    operationID: "op",
    runID: "epoch",
    generation: 1,
    expiresAt: Date.now() + 300000,
  };
const anomaly = {
    kind: "ORE_ANOMALY" as const,
    systemID: 300,
    name: "ore-site",
    siteID: 55,
    instanceID: 89,
    position: { x: 0, y: 0, z: 0 },
  },
  anomalyClaim = {
    key: "ORE_ANOMALY:300:site:55:instance:89",
    operationID: "op",
    runID: "epoch",
    generation: 1,
    expiresAt: Date.now() + 300000,
  };
async function cycleFixture(
  loseAck: boolean,
  depleted = false,
  siteMode = false,
  iceMode = false,
  wrongFamily = false,
  fullHold = false,
  shortCycle = false,
  boostedCycle = false,
  movementAdmission?: () => Promise<void>,
  movementArrived?: () => boolean,
  logistics?: { enabled: boolean; compress: (id: number) => Promise<any>; support: () => any },
) {
  let clockShort = shortCycle,
    q = 0,
    cached = 0,
    cycle = false,
    reads = 0,
    locked = false,
    activations = 0,
    last: any = null,
    stopping = false,
    stopOnVolume = false,
    stopOnPending = false,
    warping = false,
    warpRefusal = false,
    unknownLock = false,
    failRefusal = false,
    locks = 0,
    far = false,
    follow = false,
    approaches = 0,
    approachFailure: unknown = null,
    sceneExtra = 0,
    clockOffset = 0,
    stopOnApproach = false,
    targetVisible = true,
    goto = false,
    interruptAfterEffect = false,
    failedHoldRead = false;
  const records: any[] = [];
  const list = (...items: any[]) => ({ type: "list", items }),
    dict = (value: any) => ({ type: "dict", entries: Object.entries(value) }),
    long = (value: string) => ({ type: "long", value });
  const ownSetup = siteMode
      ? {
          operationID: "op",
          operationRunID: "epoch",
          systemID: 300,
          canCapacityM3: 55000,
          members: setup.members,
          site: {
            scannerKey: 55,
            instanceID: 89,
            label: "ore-site",
            archetypeID: iceMode ? 28 : 27,
            observedAt: 1,
            target: iceMode ? iceTarget : anomaly,
          },
        }
      : { ...setup, beltName: "belt" },
    ctx: any = {
      ...run,
      setup: logistics
        ? {
            ...ownSetup,
            canCapacityM3: 100,
            oreLogistics: {
              version: 1,
              remoteCompression: logistics.enabled,
              compressedJettisonFraction: 0.5,
            },
          }
        : ownSetup,
    };
  const effect = (id: number, target: number | null, moduleID = 55) => [
    moduleID,
    1,
    11,
    target,
    null,
    [],
    id,
    long("134385165369120001"),
    id === 16 ? -1 : 10,
    1,
  ];
  const module = (moduleID = 55) => ({
    type: "object",
    name: "util.KeyVal",
    args: dict({
      itemID: moduleID,
      invItem: {
        type: "packedrow",
        fields: {
          itemID: moduleID,
          typeID: moduleID === 56 ? 484 : 483,
          ownerID: 1,
          locationID: 11,
          flagID: moduleID === 56 ? 28 : 27,
        },
      },
      attributes: {
        type: "dict",
        entries: [
          [54, 15000],
          [73, boostedCycle ? 20 : 10],
        ],
      },
      activeEffects: {
        type: "dict",
        entries: [
          [16, effect(16, null, moduleID)],
          ...(cycle ? [[67, effect(67, 777, moduleID)]] : []),
        ],
      },
      time: long(clockShort ? "134385165369180001" : "134385165369240001"),
      wallclockTime: long("134385165369179999"),
    }),
  });
  const shipInfo = {
    type: "dict",
    entries: [
      [
        11,
        {
          type: "object",
          name: "util.KeyVal",
          args: dict({
            itemID: 11,
            attributes: {
              type: "dict",
              entries: [
                [14, 1],
                [13, 0],
                [12, 0],
                [1137, 0],
              ],
            },
          }),
        },
      ],
    ],
  };
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    let body: any;
    if (path === "/api/bridge/fitting")
      body = {
        activeShipID: 11,
        slots: list(
          {
            type: "packedrow",
            fields: {
              itemID: 55,
              typeID: 483,
              groupID: 54,
              categoryID: 7,
              flagID: 27,
              quantity: 1,
              singleton: 1,
            },
          },
          ...(iceMode
            ? [
                {
                  type: "packedrow",
                  fields: {
                    itemID: 56,
                    typeID: 484,
                    groupID: 54,
                    categoryID: 7,
                    flagID: 28,
                    quantity: 1,
                    singleton: 1,
                  },
                },
              ]
            : []),
        ),
        shipInfo,
        online: list(55, ...(iceMode ? [56] : [])),
        errors: { slots: null, shipInfo: null, online: null, chargeFits: null },
        chargeFits: null,
      };
    else if (path === "/api/types/dogma")
      body = { attributes: { 483: { 73: 10, 77: 100 }, 484: { 73: 10, 77: 1, 182: 16281 } } };
    else if (path === "/api/bridge/ship/ore-hold") {
      if (interruptAfterEffect && last?.pending?.activeProof && !failedHoldRead) {
        failedHoldRead = true;
        throw Error("Hold read interrupted");
      }
      body = {
        activeShipID: 11,
        holds: [
          {
            key: "ore",
            present: true,
            error: null,
            capacity: {
              capacity: logistics ? 100 : 1000,
              used: fullHold ? (logistics ? 100 : 1000) : q * 0.1,
            },
            items: q ? [{ itemID: 888, typeID: 30, quantity: q, categoryID: 25 }] : [],
          },
        ],
      };
    } else if (path === "/api/bridge/flight/status")
      body = {
        flight: {
          inSpace: true,
          docked: false,
          shipID: 11,
          solarSystemID: 300,
          shipMode: warping ? "WARP" : "STOP",
          transition: {
            phase: "ready",
            sessionStable: true,
            locationReady: true,
            sceneReady: true,
            egoReady: true,
            shipReady: true,
            boundContextReady: true,
          },
        },
      };
    else if (path === "/api/bridge/space/snapshot")
      body = {
        space: {
          stateValid: true,
          inSpace: true,
          shipID: 11,
          solarSystemID: 300,
          ship: {
            itemID: 11,
            characterID: 1,
            mode: warping ? "WARP" : follow ? "FOLLOW" : "STOP",
            followRange: follow ? 10500 : null,
            position: { x: 0, y: 0, z: 0 },
            radius: 10,
          },
          sampledAtMs: Date.now() + sceneExtra,
          entities: [
            {
              itemID: 11,
              characterID: 1,
              categoryID: 6,
              mode: follow ? "FOLLOW" : goto ? "GOTO" : "STOP",
              targetEntityID: follow ? 777 : null,
              position: { x: 0, y: 0, z: 0 },
              radius: 10,
            },
            ...(siteMode
              ? []
              : [
                  {
                    itemID: 99,
                    groupID: 9,
                    categoryID: 2,
                    name: "belt",
                    position: { x: 0, y: 0, z: 0 },
                    radius: 2000,
                  },
                ]),
            ...(targetVisible
              ? [
                  {
                    itemID: 777,
                    typeID: 30,
                    groupID: 18,
                    categoryID: 25,
                    beltID: null,
                    position: { x: far ? 30000 : 100, y: 0, z: 0 },
                    radius: 10,
                  },
                ]
              : []),
          ],
        },
      };
    else if (path === "/api/mining-operations/resources")
      body = {
        resources: [{ typeID: 30, name: "ore", family: iceMode && !wrongFamily ? "ice" : "ore" }],
      };
    else if (path === "/api/client-data/dogma-types")
      body = { available: true, types: { 30: { categoryID: 25 } } };
    else if (path === "/api/types/volumes") {
      body = { volumes: { 30: 0.1 }, capped: false };
      if (stopOnVolume) stopping = true;
    } else if (path === "/api/bridge/targets") body = { targetIDs: locked ? [777] : [] };
    else throw Error(`unexpected ${path}`);
    return new Response(JSON.stringify({ ok: true, ...body }), {
      headers: { "content-type": "application/json" },
    });
  };
  ctx.fetch = fetcher;
  const s: any = {
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
    flow: {
      requestOptions: () => ({ baseUrl: ctx.baseUrl, fetch: fetcher }),
      flying: {
        sessionGeneration: () => 1,
        approachShip: async () => {
          approaches++;
          if (approachFailure) throw approachFailure;
        },
        bridgeAsk: async (service: string, method: string, _args: any[], kwargs: any) => {
          if (service === "scanMgr" && method === "GetFullState")
            return [
              {
                type: "dict",
                entries: [
                  [
                    55,
                    {
                      type: "object",
                      name: "util.KeyVal",
                      args: {
                        type: "dict",
                        entries: [
                          ["instanceID", 89],
                          ["targetID", "ore-site"],
                          ["archetypeID", iceMode ? 28 : 27],
                          ["scanStrengthAttribute", 211],
                          ["position", [0, 0, 0]],
                        ],
                      },
                    },
                  ],
                ],
              },
              { type: "dict", entries: [] },
              { type: "dict", entries: [] },
              { type: "dict", entries: [] },
            ];
          if (service === "dogmaIM" && method === "ItemGetInfo") {
            if (cycle && reads++ > 0) {
              cycle = false;
              q = iceMode ? 1 : 100;
            }
            return module(_args[0]);
          }
          if (service === "invbroker" && method === "List")
            return list(
              ...(kwargs.flag === 134 && cached
                ? [
                    {
                      type: "packedrow",
                      fields: {
                        itemID: 888,
                        typeID: 30,
                        ownerID: 1,
                        locationID: 11,
                        flagID: 134,
                        quantity: cached,
                        categoryID: 25,
                      },
                    },
                  ]
                : []),
            );
          throw Error("unexpected ask");
        },
        bridgeDo: async (service: string, method: string) => {
          if (service === "invCache") {
            cached = q;
            return null;
          }
          if (method === "AddTarget") {
            locks++;
            if (unknownLock) throw Error("transport disconnected");
            if (warpRefusal)
              throw Object.assign(Error("warping"), {
                code: "CALL_REFUSED",
                status: 409,
                refusal: { key: "DeniedTargetSelfWarping" },
              });
            if (depleted)
              throw Object.assign(Error("depleted"), {
                code: "CALL_REFUSED",
                status: 409,
                refusal: { key: "TargetingAttemptCancelled" },
              });
            locked = true;
            return [true];
          }
          if (method === "Activate") {
            activations++;
            if (loseAck) throw Error("activation acknowledgement lost");
            cycle = true;
            return null;
          }
          throw Error(`unexpected ${service}.${method}`);
        },
      },
    },
  };
  const document = {
    read: () => last,
    write: (v: unknown) => {
      if (failRefusal && (v as any)?.lockRefusals?.length)
        throw Error("durable refusal write failed");
      last = structuredClone(v);
      records.push(structuredClone(v));
      if (stopOnPending && last?.pending?.kind === "mining-cycle") stopping = true;
      if (stopOnApproach && last?.approach?.status === "pending") stopping = true;
    },
  };
  const open = (context = ctx) =>
    createFleetMiningCycle(
      context,
      s,
      () => {},
      () => stopping,
      {
        document,
        movementAdmission,
        movementArrived,
        ...(logistics
          ? {
              compressionDocument: store(null),
              compressionFactory: (() => ({
                snapshot: () => ({ pending: null, receipts: [] }),
                compress: logistics.compress,
                reconcile: async () => null,
              })) as any,
              commandSupport: logistics.support,
            }
          : {}),
        wait: async () => {},
        now: () => Date.now() + clockOffset,
        authority: () => ({
          state: "ACTIVE",
          target: siteMode ? (iceMode ? iceTarget : anomaly) : belt,
          claim: siteMode ? (iceMode ? iceClaim : anomalyClaim) : beltClaim,
        }),
      },
    );
  const controller = await open();
  return {
    controller,
    reopen: (botID: string) => open({ ...ctx, botID, resumed: true }),
    records,
    interruptAfterEffect: () => {
      interruptAfterEffect = true;
    },
    last: () => last,
    approaches: () => approaches,
    setFar: () => {
      far = true;
    },
    setNear: () => {
      far = false;
      sceneExtra = 2000;
    },
    advanceApproach: () => {
      clockOffset = 5000;
      sceneExtra = 2000;
    },
    setNativeSceneOffset: (ms: number) => {
      sceneExtra = ms;
    },
    stopAfterApproachIntent: () => {
      stopOnApproach = true;
    },
    hideTarget: () => {
      targetVisible = false;
    },
    gotoLate: () => {
      follow = false;
      goto = true;
      clockOffset = 31000;
      sceneExtra = 2000;
    },
    follow: () => {
      follow = true;
      sceneExtra = 1000;
    },
    stopFollowing: () => {
      follow = false;
      sceneExtra = 2000;
    },
    failApproach: (v: unknown) => {
      approachFailure = v;
    },
    activations: () => activations,
    locks: () => locks,
    setWarp: (v: boolean) => {
      warping = v;
    },
    refuseWarp: () => {
      warpRefusal = true;
    },
    loseLock: () => {
      unknownLock = true;
    },
    failRefusalSave: () => {
      failRefusal = true;
    },
    requestStop: () => {
      stopping = true;
    },
    advanceClock: () => {
      clockShort = false;
    },
    stopDuringRead: () => {
      stopOnVolume = true;
    },
    stopAfterPending: () => {
      stopOnPending = true;
    },
  };
}
const belt = { kind: "BELT" as const, systemID: 300, name: "belt" },
  beltClaim = {
    key: "BELT:300:belt",
    operationID: "op",
    runID: "epoch",
    generation: 1,
    expiresAt: Date.now() + 30000,
  };
test("fleet cycle persists native target and effect then settles on fresh positive yield", async () => {
  const x = await cycleFixture(false, false, true);
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "yield");
  assert.equal(x.activations(), 1);
  assert.ok(x.records.some((r) => r.pending?.kind === "target-lock"));
  assert.ok(x.records.some((r) => r.pending?.activeProof));
  assert.equal(x.last().pending, null);
  assert.equal(x.last().lastCycle.gain, 100);
});
test("fleet cycle retains a lost activation acknowledgement and never sends it twice", async () => {
  const x = await cycleFixture(true, false, true);
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /acknowledgement lost/);
  assert.equal(x.last().pending.kind, "mining-cycle");
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /no replay/);
  assert.equal(x.activations(), 1);
});
test("Stop before any dispatch emits the trusted graceful signal and leaves no pending mutation", async () => {
  const x = await cycleFixture(false);
  x.requestStop();
  await assert.rejects(
    x.controller.tick(belt, beltClaim),
    (e: any) => e.name === "FleetStopBeforeDispatch",
  );
  assert.equal(x.last().pending, null);
  assert.equal(x.activations(), 0);
  await x.controller.stop();
});
test("Stop arriving during a native preflight read does not issue a target lock", async () => {
  const x = await cycleFixture(false);
  x.stopDuringRead();
  await assert.rejects(
    x.controller.tick(belt, beltClaim),
    (e: any) => e.name === "FleetStopBeforeDispatch",
  );
  assert.equal(
    x.records.some((r) => r.pending?.kind === "target-lock"),
    false,
  );
  assert.equal(x.activations(), 0);
  await x.controller.stop();
});
test("Stop after a cycle intent is persisted retains that intent for reconciliation", async () => {
  const x = await cycleFixture(false, false, true);
  x.stopAfterPending();
  await assert.rejects(
    x.controller.tick(anomaly, anomalyClaim),
    (e: any) => e.name !== "FleetStopBeforeDispatch" && /reconciliation/.test(e.message),
  );
  assert.equal(x.last().pending.kind, "mining-cycle");
  assert.equal(x.activations(), 0);
  await assert.rejects(x.controller.stop(), /reconciliation/);
});
test("Stop never turns a lost activation acknowledgement into a safe pre-dispatch stop", async () => {
  const x = await cycleFixture(true, false, true);
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /acknowledgement lost/);
  x.requestStop();
  await assert.rejects(
    x.controller.tick(anomaly, anomalyClaim),
    (e: any) => e.name !== "FleetStopBeforeDispatch" && /reconciliation/.test(e.message),
  );
  assert.equal(x.last().pending.kind, "mining-cycle");
  assert.equal(x.activations(), 1);
  await assert.rejects(x.controller.stop(), /reconciliation/);
});
test("the exact native cancelled-target refusal retires the depleted asteroid before activation", async () => {
  const x = await cycleFixture(false, true, true);
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.activations(), 0);
  assert.deepEqual(x.last().retired, [777]);
  assert.equal(x.last().pending, null);
});

test("no target dispatch occurs while fresh flight and scene report warp", async () => {
  const x = await cycleFixture(false);
  x.setWarp(true);
  assert.equal(await x.controller.tick(belt, beltClaim), "blocked");
  assert.equal(x.locks(), 0);
  assert.equal(x.last().pending, null);
});
test("exact native warp refusal persists negative receipt and original intent without retiring the rock", async () => {
  const x = await cycleFixture(false, false, true);
  x.refuseWarp();
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.locks(), 1);
  assert.equal(x.activations(), 0);
  assert.equal(x.last().pending, null);
  assert.deepEqual(x.last().retired, []);
  assert.equal(x.last().lockRefusals[0].intent.details.targetID, 777);
  assert.equal(x.last().lockRefusals[0].evidence.error.refusal.key, "DeniedTargetSelfWarping");
});
test("unknown target-lock failure retains original intent without retry", async () => {
  const x = await cycleFixture(false, false, true);
  x.loseLock();
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /transport disconnected/);
  assert.equal(x.last().pending.kind, "target-lock");
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /no replay/);
  assert.equal(x.locks(), 1);
});

test("failed refusal persistence preserves the in-memory and durable lock fence", async () => {
  const x = await cycleFixture(false, false, true);
  x.refuseWarp();
  x.failRefusalSave();
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /durable refusal write failed/);
  assert.equal(x.last().pending.kind, "target-lock");
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /no replay/);
  assert.equal(x.locks(), 1);
});

test("ore anomaly uses the existing mining cycle and exact native site identity", async () => {
  const x = await cycleFixture(false, false, true);
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "yield");
  assert.equal(x.activations(), 1);
  assert.equal(x.last().lastCycle.gain, 100);
  assert.deepEqual(JSON.parse(x.last().identity)[5], anomaly);
});

test("ICE site selects ice module from mixed fit and observes one whole full-cycle unit in general mining hold", async () => {
  const x = await cycleFixture(false, false, true, true);
  assert.equal(await x.controller.tick(iceTarget, iceClaim), "yield");
  assert.equal(x.last().lastCycle.gain, 1);
  assert.equal(x.last().lastCycle.details.moduleID, 56);
});
test("ICE rejects ore-family rock and reports full general hold before any activation", async () => {
  const wrong = await cycleFixture(false, false, true, true, true);
  await assert.rejects(wrong.controller.tick(iceTarget, iceClaim), /No source-qualified/);
  assert.equal(wrong.activations(), 0);
  const full = await cycleFixture(false, false, true, true, false, true);
  assert.equal(await full.controller.tick(iceTarget, iceClaim), "hold-full");
  assert.equal(full.activations(), 0);
});

test("ICE gain without a full native effect duration remains fenced", async () => {
  const x = await cycleFixture(false, false, true, true, false, false, true);
  await assert.rejects(x.controller.tick(iceTarget, iceClaim), /Full native ice cycle/);
  assert.equal(x.last().pending.kind, "mining-cycle");
  assert.equal(x.activations(), 1);
});

test("native ice quote reports the exact effective module, ship, bot, generation and scene time", async () => {
  const x = await cycleFixture(false, false, true, true),
    q = await x.controller.quote!();
  assert.deepEqual(
    [
      q.characterID,
      q.shipID,
      q.botID,
      q.sessionGeneration,
      q.moduleID,
      q.typeID,
      q.family,
      q.cycleMs,
    ],
    [1, 11, "bot", 1, 56, 484, "ice", 10],
  );
  assert.ok(q.sceneSampledAtMs > 0);
  assert.match(q.timeFiletime, /^\d+$/);
});

test("boosted ICE uses the original native active effect duration, not the longer module attribute", async () => {
  const x = await cycleFixture(false, false, true, true, false, false, false, true);
  assert.equal(await x.controller.tick(iceTarget, iceClaim), "yield");
  assert.equal(x.last().lastCycle.details.cycleMs, 20);
  assert.equal(x.last().lastCycle.iceTiming.durationMs, 10);
});
test("Stop read-only reconciles the original proven ICE cycle after native time and exact gain", async () => {
  const x = await cycleFixture(false, false, true, true, false, false, true);
  await assert.rejects(x.controller.tick(iceTarget, iceClaim), /Full native ice cycle/);
  assert.equal(x.last().pending.kind, "mining-cycle");
  await assert.rejects(x.controller.stop(), /reconciliation/);
  x.advanceClock();
  await x.controller.stop();
  assert.equal(x.last().pending, null);
  assert.equal(x.last().lastCycle.reconciledReadOnly, true);
  assert.equal(x.last().lastCycle.gain, 1);
  assert.equal(x.activations(), 1);
});

test("ICE timing refuses short, active, wrong-owner, wrong-target, zero-gain and missing-duration proof", async () => {
  const x = await cycleFixture(false, false, true, true, false, false, true);
  await assert.rejects(x.controller.tick(iceTarget, iceClaim), /Full native ice cycle/);
  const active = x.last().pending.activeProof,
    after = { ...active, activeTargets: [], timeFiletime: "134385165369240001" };
  assert.ok(iceCycleTiming(active, after, 777, 1));
  for (const [a, b, target, gain] of [
    [active, { ...after, ownerID: 2 }, 777, 1],
    [active, { ...after, activeTargets: active.activeTargets }, 777, 1],
    [active, after, 778, 1],
    [active, after, 777, 0],
    [active, { ...after, timeFiletime: active.activeTargets[0].startFiletime }, 777, 1],
    [{ ...active, activeTargets: [{ ...active.activeTargets[0], durationMs: 0 }] }, after, 777, 1],
  ] as any[])
    assert.equal(iceCycleTiming(a, b, target, gain), null);
});

test("acknowledged asteroid approach waits for native follow instead of repeating inside the settle window", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  x.follow();
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.approaches(), 1);
  assert.equal(x.last().approach.status, "observed");
});
test("unknown asteroid approach remains fenced without a second order", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  x.failApproach(Error("transport lost"));
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /transport lost/);
  assert.equal(x.last().approach.status, "pending");
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.approaches(), 1);
});

test("exact native approach throttle is a durable negative, reconciled by own fresh matching FOLLOW", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  x.failApproach(
    Object.assign(Error("throttled"), {
      code: "CALL_REFUSED",
      status: 409,
      refusal: { key: "ThrottleGeneric", params: { remainingTime: 2000000 } },
    }),
  );
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.last().approach.status, "refused");
  assert.equal(x.last().approach.refusal.detail.key, "ThrottleGeneric");
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  x.follow();
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.last().approach.status, "observed");
  assert.equal(x.approaches(), 1);
});
test("unknown approach and changed target authority never authorize a second movement or release", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  x.failApproach(Error("connection lost"));
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /connection lost/);
  await assert.rejects(
    x.controller.tick(anomaly, { ...anomalyClaim, generation: 2 }),
    /claim (changed|was lost)/,
  );
  await assert.rejects(x.controller.stop(), /approach outcome remains unresolved/);
  await assert.rejects(x.controller.release!(), /approach outcome remains unresolved/);
  assert.equal(x.approaches(), 1);
});

test("a fresh stopped ship can reissue after the current approach was observed", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  x.failApproach(
    Object.assign(Error("throttled"), {
      code: "CALL_REFUSED",
      status: 409,
      refusal: { key: "ThrottleGeneric" },
    }),
  );
  await x.controller.tick(anomaly, anomalyClaim);
  x.follow();
  await x.controller.tick(anomaly, anomalyClaim);
  assert.equal(x.last().approach.status, "observed");
  assert.equal(x.last().approach.refusal.detail.key, "ThrottleGeneric");
  x.stopFollowing();
  x.failApproach(null);
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.approaches(), 2);
  assert.equal(x.last().approach.status, "acknowledged");
});

test("fresh stopped ship within original target range resolves original approach without FOLLOW", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  await x.controller.tick(anomaly, anomalyClaim);
  x.setNear();
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "yield");
  assert.equal(x.last().lastCycle.gain, 100);
  assert.equal(x.last().approach.observedVia, "within-range");
  assert.equal(x.approaches(), 1);
});
test("acknowledged approach fresh STOP after stock settle allows Stop without claiming arrival", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  await x.controller.tick(anomaly, anomalyClaim);
  await assert.rejects(x.controller.stop(), /approach outcome remains unresolved/);
  x.advanceApproach();
  await x.controller.stop();
  assert.equal(x.last().approach.observedVia, "stopped-after-settle");
  assert.equal(x.approaches(), 1);
});
test("unknown approach cannot settle by elapsed time plus STOP alone", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  x.failApproach(Error("lost"));
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /lost/);
  x.advanceApproach();
  await assert.rejects(x.controller.stop(), /approach outcome remains unresolved/);
  assert.equal(x.last().approach.status, "pending");
  assert.equal(x.approaches(), 1);
});
test("Stop before approach dispatch clears the current intent", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  x.stopAfterApproachIntent();
  await assert.rejects(
    x.controller.tick(anomaly, anomalyClaim),
    (e: any) => e.name === "FleetStopBeforeDispatch",
  );
  assert.equal(x.approaches(), 0);
  assert.equal(x.last().approach, null);
  await x.controller.stop();
});

test("missing original target cannot create a within-range approach proof", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  await x.controller.tick(anomaly, anomalyClaim);
  x.setNear();
  x.hideTarget();
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.last().approach.status, "acknowledged");
  assert.equal(x.approaches(), 1);
});
test("observed follow that later becomes unresolved GOTO is bounded without a repeat", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  await x.controller.tick(anomaly, anomalyClaim);
  x.follow();
  await x.controller.tick(anomaly, anomalyClaim);
  x.gotoLate();
  await assert.rejects(
    x.controller.tick(anomaly, anomalyClaim),
    /approach outcome remains unresolved/,
  );
  assert.equal(x.approaches(), 1);
});

test("movement admission runs only before an actual approach, never for in-range mining", async () => {
  let calls = 0;
  const gate = async () => {
    calls++;
    throw Error("Core still active");
  };
  const near = await cycleFixture(false, false, true, false, false, false, false, false, gate);
  assert.equal(await near.controller.tick(anomaly, anomalyClaim), "yield");
  assert.equal(calls, 0);
  const far = await cycleFixture(false, false, true, false, false, false, false, false, gate);
  far.setFar();
  await assert.rejects(far.controller.tick(anomaly, anomalyClaim), /Core still active/);
  assert.equal(calls, 1);
  assert.equal(far.approaches(), 0);
  assert.equal(far.last().approach ?? null, null);
});

test("fresh in-range position yields control before locking so support may restart", async () => {
  let pending = true;
  const x = await cycleFixture(
    false,
    false,
    true,
    false,
    false,
    false,
    false,
    false,
    undefined,
    () => {
      if (!pending) return false;
      pending = false;
      return true;
    },
  );
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.locks(), 0);
  assert.equal(x.activations(), 0);
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "yield");
  assert.equal(x.locks(), 1);
});

test("remote compression follows explicit enable policy after a native RAW increment", async () => {
  for (const enabled of [false, true]) {
    let calls = 0;
    const x = await cycleFixture(
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      undefined,
      undefined,
      {
        enabled,
        compress: async (id) => {
          assert.equal(id, 888);
          calls++;
          return { observedAt: Date.now() };
        },
        support: () => ({}),
      },
    );
    assert.equal(await x.controller.tick(anomaly, anomalyClaim), "yield");
    if (enabled) {
      const next = await x.controller.tick(anomaly, anomalyClaim);
      assert.equal(next, "blocked");
    }
    assert.equal(calls, enabled ? 1 : 0);
  }
});

test("freight status is a synchronous timestamped native hold observation", async () => {
  const x = await cycleFixture(false);
  assert.equal(x.controller.getFreightStatus?.(), null);
  assert.equal(await x.controller.tick(belt, beltClaim), "blocked");
  const status = x.controller.getFreightStatus?.();
  assert.equal(status?.source, "native-ship-holds");
  assert.ok(status!.observedAt <= Date.now());
  assert.equal(status?.primaryHoldFlagID, 134);
  assert.equal(status?.holds[0]?.flagID, 134);
  assert.equal(status?.holds[0]?.rawQuantity, 0);
  assert.equal(status?.pendingCompression, null);
  assert.equal(status?.facility, null);
});

test("Stop accepts a fresh observed approach on a slower native scene clock", async () => {
  const x = await cycleFixture(false, false, true);
  x.setFar();
  x.setNativeSceneOffset(-45000);
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.last().approach.status, "acknowledged");
  x.requestStop();
  x.follow();
  x.setNativeSceneOffset(-42000);
  await x.controller.stop();
  assert.equal(x.last().approach.observedVia, "follow");
  assert.ok(x.last().approach.observedSampledAt < x.last().approach.issuedAt);
  await x.controller.release!();
  assert.equal(x.approaches(), 1);
});

test("Stop closes a dispatched target-lock from the native list without replaying it", async () => {
  const x = await cycleFixture(false, false, true);
  x.loseLock();
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /transport disconnected/);
  x.requestStop();
  await x.controller.stop();
  assert.equal(x.last().pending, null);
  assert.equal(x.last().lastStoppedLock.intent.details.targetID, 777);
  assert.equal(x.locks(), 1);
});

test("Stop uses current cargo and inactivity to reconcile the exact observed ore Activate", async () => {
  const x = await cycleFixture(false, false, true);
  x.interruptAfterEffect();
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /Hold read interrupted/);
  assert.ok(x.last().pending.activeProof);
  x.requestStop();
  await x.controller.stop();
  assert.equal(x.last().pending, null);
  assert.equal(x.last().lastCycle.reconciledReadOnly, true);
  assert.equal(x.last().lastCycle.gain, 100);
  assert.equal(x.activations(), 1);
});

test("temporary hold read failure resumes by observing the original ore cycle before any new write", async () => {
  const x = await cycleFixture(false, false, true);
  x.interruptAfterEffect();
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /Hold read interrupted/);
  assert.equal(await x.controller.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.last().pending, null);
  assert.equal(x.last().lastCycle.reconciledReadOnly, true);
  assert.equal(x.activations(), 1);
});

test("a restored mining cycle reconciles old native proof before taking ownership", async () => {
  const x = await cycleFixture(false, false, true);
  x.interruptAfterEffect();
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /Hold read interrupted/);
  const old = structuredClone(x.last());
  const restored = await x.reopen("restored");
  assert.equal(x.last().identity, old.identity);
  assert.deepEqual(x.last().pending, old.pending);
  assert.equal(await restored.tick(anomaly, anomalyClaim), "blocked");
  assert.equal(x.activations(), 1);
  assert.equal(x.last().lastCycle.ownerRunID, "bot");
  assert.equal(x.last().lastCycle.gain, 100);
  assert.equal(x.last().pending, null);
  assert.equal(JSON.parse(x.last().identity)[6], "restored");
});

test("Stop under a new hosted ID verifies the old target lock and does not send it again", async () => {
  const x = await cycleFixture(false, false, true);
  x.loseLock();
  await assert.rejects(x.controller.tick(anomaly, anomalyClaim), /transport disconnected/);
  const old = structuredClone(x.last().pending);
  const restored = await x.reopen("restored");
  x.requestStop();
  await restored.stop();
  assert.equal(x.last().pending, null);
  assert.deepEqual(x.last().lastStoppedLock.intent, old);
  assert.equal(JSON.parse(x.last().identity)[6], "restored");
  assert.equal(x.locks(), 1);
});

async function repeatingBelt(
  moduleCount = 2,
  {
    rockIDs = [777, 778],
    droneTypes = [] as number[],
    shipLimit = 3,
    pilotLimit = 3,
    characterID = 1,
    operationID = "op",
    travelAssist,
    freight = false,
    haulMode,
    timing,
    dogmaReply,
    nativeDroneRange,
    droneCap = 1,
    dronesEnabled = true,
    sceneEffects = false,
  }: {
    rockIDs?: number[];
    droneTypes?: number[];
    shipLimit?: number;
    pilotLimit?: number;
    characterID?: number;
    operationID?: string;
    travelAssist?: MiningTravelAssist;
    freight?: boolean;
    haulMode?: FleetSetup["haulMode"];
    timing?: MccTiming;
    dogmaReply?: () => Response | undefined;
    nativeDroneRange?: number;
    droneCap?: number;
    dronesEnabled?: boolean;
    sceneEffects?: boolean;
  } = {},
) {
  const shipID = characterID + 10;
  const lasers = [55, 56].slice(0, moduleCount),
    rocks = new Set(rockIDs),
    active = new Map<number, number>();
  const locked = new Set<number>(),
    writes: { method: string; args: number[] }[] = [];
  const bay = new Map(
    droneTypes.map((typeID) => [typeID + 600, { itemID: typeID + 600, typeID, quantity: 1 }]),
  );
  const out = new Map<
    number,
    {
      itemID: number;
      typeID: number;
      controlled: boolean;
      activity: string;
      targetID: number | null;
    }
  >();
  const reports: { phase: string; why: string }[] = [];
  let clock = Date.now(),
    sample = clock,
    quantity = 0,
    sceneValid = true,
    hostile: number | null = null,
    stopping = false,
    waits = 0;
  let delayReturn = false,
    refuseEngage = false,
    rockOffset = 0,
    following: number | null = null;
  let hostileID = 90,
    droneRead: Promise<void> | null = null,
    droneReconnect: Promise<void> | null = null,
    targetsRead: Promise<void> | null = null,
    holdRead: Promise<void> | null = null;
  const requests: string[] = [];
  let oreCapacityReadable = true,
    otherHoldUnreadable = false;
  let rockTypeID = 30,
    oreAtHoldList: number | undefined;
  let can: {
    itemID: number;
    typeID: number;
    ownerID: number;
    locationID: number;
    flagID: number;
    quantity: number;
  } | null = null;
  let jettisonResult: "ack" | "lost" | "not-applied" | "cooldown" = "ack";
  let oreItemID = 888,
    oreBeforeJettison = 0,
    oreAfterJettison = 0;
  const oreRow = () => ({
    itemID: oreItemID,
    typeID: 30,
    ownerID: characterID,
    locationID: shipID,
    flagID: 134,
    quantity,
  });
  function finishReturn(id: number) {
    const drone = out.get(id)!;
    out.delete(id);
    bay.set(id, { itemID: id, typeID: drone.typeID, quantity: -1 });
  }
  const dict = (entries: unknown[]) => ({ type: "dict", entries });
  const kv = (fields: Record<string, unknown>) => ({
    type: "object",
    name: "util.KeyVal",
    args: dict(Object.entries(fields)),
  });
  const row = (fields: Record<string, unknown>) => ({ type: "packedrow", fields });
  const list = (items: unknown[]) => ({ type: "list", items });
  const position = (x: number) => ({ x, y: 0, z: 0 });
  const ship = {
    itemID: shipID,
    characterID,
    mode: "STOP",
    position: position(0),
    radius: 10,
    followRange: null as number | null,
  };
  const transition = {
    phase: "ready",
    sessionStable: true,
    locationReady: true,
    sceneReady: true,
    egoReady: true,
    shipReady: true,
    boundContextReady: true,
  };
  const fitted = (id: number) => ({
    itemID: id,
    typeID: 483,
    groupID: 54,
    categoryID: 7,
    flagID: 27 + lasers.indexOf(id),
    quantity: 1,
    singleton: 1,
  });
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    let body: object;
    switch (path) {
      case "/api/bridge/fitting":
        body = {
          activeShipID: shipID,
          slots: list(lasers.map((id) => row(fitted(id)))),
          online: list(lasers),
          shipInfo: dict([
            [
              shipID,
              kv({
                itemID: shipID,
                attributes: dict([
                  [14, lasers.length],
                  [13, 0],
                  [12, 0],
                  [1137, 0],
                ]),
              }),
            ],
          ]),
          errors: { slots: null, shipInfo: null, online: null, chargeFits: null },
          chargeFits: null,
        };
        break;
      case "/api/types/dogma": {
        const response = dogmaReply?.();
        if (response) return response;
        body = { attributes: { 483: { 73: 60000, 77: 100 } } };
        break;
      }
      case "/api/bridge/flight/status":
        body = {
          flight: {
            inSpace: true,
            docked: false,
            shipID,
            solarSystemID: 300,
            shipMode: ship.mode,
            transition,
          },
        };
        break;
      case "/api/bridge/space/snapshot":
        body = {
          space: {
            stateValid: sceneValid,
            inSpace: true,
            shipID,
            solarSystemID: 300,
            ship: {
              ...ship,
              activeModuleIDs: [...active.keys()],
              ...(sceneEffects
                ? {
                    activeModuleTargets: [...active],
                    moduleRanges: lasers.map((id) => [id, 15000]),
                  }
                : {}),
            },
            sampledAtMs: ++sample,
            entities: [
              ...[...out.values()].map((d) => ({
                itemID: d.itemID,
                typeID: d.typeID,
                kind: "drone",
                ownerID: characterID,
                controllerID: d.controlled ? shipID : null,
                droneActivity: d.controlled ? d.activity : null,
                targetEntityID: d.controlled ? d.targetID : null,
                position: position(0),
                radius: 1,
              })),
              { ...ship, categoryID: 6, targetEntityID: following },
              {
                itemID: 99,
                groupID: 9,
                categoryID: 2,
                name: "belt",
                position: position(0),
                radius: 2000,
              },
              ...[...rocks].map((id) => ({
                itemID: id,
                typeID: rockTypeID,
                groupID: 18,
                categoryID: 25,
                beltID: 99,
                position: position(rockOffset + id - 700),
                radius: 10,
              })),
              ...(can
                ? [
                    {
                      itemID: can.locationID,
                      kind: "container",
                      ownerID: characterID,
                      typeID: 23,
                      position: position(275),
                      radius: 10,
                    },
                  ]
                : []),
              ...(hostile !== null
                ? [
                    {
                      itemID: hostileID,
                      kind: "ship",
                      categoryID: 11,
                      isNpc: true,
                      npcEntityType: "npc",
                      position: position(hostile),
                      radius: 10,
                    },
                  ]
                : []),
            ],
          },
        };
        break;
      case "/api/bridge/ship/ore-hold":
        if (holdRead) await holdRead;
        body = {
          activeShipID: shipID,
          holds: [
            {
              key: "ore",
              present: oreCapacityReadable,
              error: null,
              capacity: oreCapacityReadable
                ? { capacity: freight ? 15000 : 1000, used: quantity * 0.1 }
                : null,
              items: quantity ? [{ itemID: oreItemID, typeID: 30, quantity, categoryID: 25 }] : [],
            },
            ...(otherHoldUnreadable
              ? [{ key: "gas", present: false, error: "READ_FAILED", capacity: null, items: null }]
              : []),
            ...(freight
              ? [
                  {
                    key: "cargo",
                    present: true,
                    error: null,
                    capacity: { capacity: 50, used: 0 },
                    items: [],
                  },
                ]
              : []),
          ],
        };
        break;
      case "/api/mining-operations/resources":
        body = { resources: [{ typeID: 30, name: "Ore", family: "ore" }] };
        break;
      case "/api/client-data/dogma-types":
        body = {
          available: true,
          types: { 23: { attributes: [[38, 55000]] }, 30: { categoryID: 25 } },
        };
        break;
      case "/api/types/volumes":
        body = { volumes: { 30: 0.1 }, capped: false };
        break;
      case "/api/bridge/targets":
        if (targetsRead) await targetsRead;
        body = { targetIDs: [...locked] };
        break;
      case "/api/bridge/drones":
        if (droneRead) await droneRead;
        body = {
          activeShipID: shipID,
          bay: [...bay.values()],
          inSpace: [...out.values()],
          errors: { bay: null, inSpace: null, shipInfo: null },
        };
        break;
      default:
        throw Error("Unexpected read " + path);
    }
    return Response.json({ ok: true, ...body });
  };
  const f = {
    sessionGeneration: () => 1,
    readFit: async () => true,
    resolveDroneControlRange: async () => 10000,
    resolveNamesNow: async () => {},
    attributesOfTypes: async () => ({ 101: { 1272: 5 }, 102: { 1272: 5 } }),
    withPilotDroneCap: () => ({ maxActiveDrones: 1 }),
    async approachShip(targetID: number, range: number) {
      writes.push({ method: "Approach", args: [targetID, range] });
    },
    bridgeAsk: async (
      service: string,
      method: string,
      args: number[],
      opts: { flag: number },
      containerID?: number,
    ) => {
      if (service === "invbroker") {
        if (args[0] === 87) {
          requests.push("drone-bay");
          if (droneRead) await droneRead;
          return list(
            [...bay.values()].map((d) => ({
              ...d,
              quantity: Math.abs(d.quantity),
              ownerID: characterID,
              locationID: shipID,
              flagID: 87,
              categoryID: 18,
            })),
          );
        }
        if (can && containerID === can.locationID) return list([row(can)]);
        requests.push("hold-list");
        if (opts?.flag === 134 && oreAtHoldList !== undefined) {
          quantity = oreAtHoldList;
          oreAtHoldList = undefined;
        }
        return list(opts?.flag === 134 && quantity ? [row(oreRow())] : []);
      }
      if (method === "QueryAttributeValue")
        return args[1] === 192 ? (args[0] === shipID ? shipLimit : pilotLimit) : 10000;
      if (method === "QueryAllAttributesForItem")
        return dict([
          [352, droneCap],
          [1271, droneCap * 5],
        ]);
      assert.equal(method, "ItemGetInfo");
      requests.push(`module:${args[0]}`);
      const id = args[0]!,
        time = { type: "long", value: String(134385165369000001n + BigInt(++clock) * 10000n) };
      const effect = (effectID: number, targetID: number | null, duration: number) => [
        id,
        characterID,
        shipID,
        targetID,
        null,
        [],
        effectID,
        time,
        duration,
        1,
      ];
      return kv({
        itemID: id,
        invItem: row({ ...fitted(id), ownerID: characterID, locationID: shipID }),
        attributes: dict([
          [54, 15000],
          [73, 60000],
        ]),
        activeEffects: dict([
          [16, effect(16, null, -1)],
          ...(active.has(id) ? [[67, effect(67, active.get(id)!, 60000)]] : []),
        ]),
        time,
        wallclockTime: time,
      });
    },
    bridgeDo: async (service: string, method: string, args: any[]) => {
      if (service === "invCache") {
        if (args[0] === shipID) requests.push("hold-invalidate");
        return null;
      }
      writes.push({ method, args });
      if (method === "AddTarget") {
        assert.ok(locked.size < Math.min(shipLimit, pilotLimit));
        locked.add(args[0]);
        return [true];
      }
      if (method === "Activate") {
        assert.ok(locked.has(args[2]));
        active.set(args[0], args[2]);
        return null;
      }
      if (method === "Deactivate") return null;
      if (method === "Jettison") {
        assert.equal(active.size, lasers.length);
        assert.deepEqual(args, [[oreItemID]]);
        assert.ok(quantity > 0);
        if (jettisonResult === "cooldown")
          throw Object.assign(Error("Native cooldown"), {
            code: "CALL_REFUSED",
            status: 409,
            refusal: { key: "ShpJettisonPending" },
          });
        if (jettisonResult === "not-applied")
          throw Object.assign(Error("Gateway reply lost"), { status: 502 });
        quantity += oreBeforeJettison;
        can = { ...oreRow(), locationID: 100, flagID: 0 };
        oreItemID++;
        quantity = oreAfterJettison;
        if (jettisonResult === "lost")
          throw Object.assign(Error("Jettison response lost"), { status: 502 });
        return [[can.itemID], []];
      }
      if (method === "LaunchDrones") {
        const [[id]] = args[0];
        const drone = bay.get(id)!;
        assert.ok(drone);
        assert.ok(out.size < droneCap);
        bay.delete(id);
        out.set(id, {
          itemID: id,
          typeID: drone.typeID,
          controlled: true,
          activity: "idle",
          targetID: null,
        });
        return dict([[id, list([id])]]);
      }
      if (method === "CmdReturnBay") {
        for (const id of args[0]) {
          if (delayReturn) out.get(id)!.activity = "returning";
          else finishReturn(id);
        }
        return dict([]);
      }
      if (method === "CmdReconnectToDrones") {
        if (droneReconnect) await droneReconnect;
        for (const id of args[0]) {
          const drone = out.get(id)!;
          assert.equal(drone.controlled, false);
          drone.controlled = true;
          drone.activity = "idle";
          drone.targetID = null;
        }
        return dict([]);
      }
      if (method === "CmdEngage" || method === "CmdMineRepeatedly") {
        if (method === "CmdEngage") {
          assert.equal(args[1], hostileID);
          if (nativeDroneRange !== undefined && hostile !== null && hostile - 20 > nativeDroneRange)
            return dict(
              args[0].map((id: number) => [
                id,
                ["CustomNotify", dict([["notify", "That target is out of drone control range."]])],
              ]),
            );
          if (refuseEngage) {
            refuseEngage = false;
            throw Object.assign(Error("Engage temporarily refused"), {
              code: "CALL_REFUSED",
              status: 409,
            });
          }
        }
        for (const id of args[0]) {
          const drone = out.get(id)!;
          drone.activity = method === "CmdEngage" ? "fighting" : "mining";
          drone.targetID = args[1];
        }
        return dict([]);
      }
      throw Error("Unexpected write " + method);
    },
  };
  const s = {
    store: {
      station: { get: () => ({ online: { characterID, corporationID: 77 } }) },
      names: {
        get: () => ({
          resolved: { "typeGroup:101": "Mining Drone", "typeGroup:102": "Combat Drone" },
        }),
      },
      fitting: { get: () => ({}) },
    },
    flow: {
      requestOptions: () => ({}),
      setLivePush() {},
      flying: { ...f, isSessionClosing: () => false },
    },
  };
  const document = store(null);
  const context = {
    ...run,
    characterID,
    setup: {
      ...setup,
      operationID,
      beltName: "belt",
      haulMode,
      ...(freight
        ? {
            oreLogistics: { version: 1, remoteCompression: false, compressedJettisonFraction: 0.5 },
          }
        : {}),
      members: [{ characterID, shipID, role: "MINER" }],
    },
    fetch: fetcher,
  };
  const create = (resume: boolean) =>
    createFleetMiningCycle(
      { ...context, resumed: resume },
      s as any,
      () => {},
      () => stopping,
      {
        document,
        now: () => clock,
        travelAssist,
        timing,
        reportDrones: dronesEnabled
          ? (phase, why) => {
              reports.push({ phase, why });
            }
          : undefined,
        wait: async (ms) => {
          waits++;
          clock += ms;
          for (const w of writes.filter((w) => w.method === "Deactivate"))
            active.delete(w.args[0]!);
        },
      },
    );
  let controller = await create(false);
  return {
    context,
    session: s,
    get cycle() {
      return controller;
    },
    active,
    locked,
    rocks,
    writes,
    bay,
    out,
    reports,
    requests,
    tick: async (jettisonReady?: boolean) => {
      const result = await controller.tick(belt, beltClaim, jettisonReady);
      await new Promise<void>((r) => setImmediate(r));
      return result;
    },
    waits: () => waits,
    resume: async () => {
      controller = await create(true);
    },
    ore: (n: number) => {
      quantity = n;
    },
    oreAtNextList: (n: number) => {
      oreAtHoldList = n;
    },
    rockType: (id: number) => {
      rockTypeID = id;
    },
    holdFault: (required: boolean, other: boolean) => {
      oreCapacityReadable = !required;
      otherHoldUnreadable = other;
    },
    completeLaserCycles: () => {
      for (const w of writes.filter((w) => w.method === "Deactivate")) active.delete(w.args[0]!);
    },
    jettisonResult: (result: typeof jettisonResult) => {
      jettisonResult = result;
    },
    jettisonYield: (before: number, after: number) => {
      oreBeforeJettison = before;
      oreAfterJettison = after;
    },
    readCan: () => (can ? { ...can } : null),
    laserYield: () => {
      const firing = [...active.values()].filter((id) => rocks.has(id) && locked.has(id)).length;
      assert.ok(firing);
      quantity += 100 * firing;
      return quantity;
    },
    freight: () => controller.getFreightStatus?.()?.holds[0]?.rawQuantity,
    moveRock: (meters: number) => {
      rockOffset = meters;
    },
    followRock: (targetID: number, range: number, meters: number) => {
      following = targetID;
      ship.mode = "FOLLOW";
      ship.followRange = range;
      ship.position = position(meters);
    },
    scene: (valid: boolean) => {
      sceneValid = valid;
    },
    threat: (meters: number | null, id = 90) => {
      if (meters === null || id !== hostileID) locked.delete(hostileID);
      hostile = meters;
      hostileID = id;
    },
    stallDroneRead: () => {
      let release!: () => void;
      droneRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        droneRead = null;
        release();
      };
    },
    stallDroneReconnect: () => {
      let release!: () => void;
      droneReconnect = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        droneReconnect = null;
        release();
      };
    },
    stallTargetsRead: () => {
      let release!: () => void;
      targetsRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        targetsRead = null;
        release();
      };
    },
    stallHoldRead: () => {
      let release!: () => void;
      holdRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        holdRead = null;
        release();
      };
    },
    delayReturn: () => {
      delayReturn = true;
    },
    finishReturn: (id: number) => {
      delayReturn = false;
      finishReturn(id);
    },
    refuseEngage: () => {
      refuseEngage = true;
    },
    async stop() {
      stopping = true;
      await controller.stop();
      return settleFleetMember(context, s as any, () => {}, {
        expectedDrones: controller.droneIDs?.(),
      });
    },
  };
}

for (const mode of ["deferred shutdown", "unavailable assist"] as const)
  test("asteroid approach resumes productive mining with " + mode, async () => {
    const module = {
      itemID: 50,
      typeID: 439,
      flagID: 19,
      effectID: 6731,
      effect: "moduleBonusAfterburner",
      kind: "afterburner" as const,
    };
    const calls: boolean[] = [];
    let propulsion = false;
    const assist = createTravelAssist({
      identity: { operationID: "op", runID: "epoch", characterID: 1, shipID: 11, botID: "bot" },
      document: store(null),
      current() {},
      beforeAction() {},
      read: async () => {
        if (mode === "unavailable assist") throw Error("Native propulsion fitting is unavailable");
        return { modules: [{ ...module, active: propulsion }], capacitorRatio: 1, scrammed: false };
      },
      observe: async () => propulsion,
      change: async (_module, on) => {
        calls.push(on);
        if (on) propulsion = true;
      },
    });
    const x = await repeatingBelt(1, { rockIDs: [777], travelAssist: assist });
    const beltNavigation = createNativeBeltNavigation(x.context, x.session as any, {
      shipID: 11,
      beltID: 99,
      current() {},
      travelAssist: assist,
    });
    x.moveRock(25000);
    await beltNavigation.navigate(belt, beltClaim);
    await x.tick();
    assert.deepEqual(
      x.writes.filter((w) => w.method === "Approach").map((w) => w.args),
      [[777, 10500]],
    );
    x.followRock(777, 10500, 1000);
    await beltNavigation.navigate(belt, beltClaim);
    await x.tick();
    assert.deepEqual(calls, mode === "deferred shutdown" ? [true] : []);
    assert.equal(x.writes.filter((w) => w.method === "Approach").length, 1);
    assert.equal(x.active.size, 0);
    x.followRock(777, 10500, 14000);
    await beltNavigation.navigate(belt, beltClaim);
    await x.tick();
    await x.tick();
    assert.equal(x.active.get(55), 777);
    assert.equal(x.laserYield(), 100);
    assert.equal(await x.tick(), "yield");
    assert.equal(x.freight(), 100);
    if (mode === "deferred shutdown") {
      assert.equal(assist.snapshot().pending?.kind, "off");
      assert.equal(propulsion, true);
      propulsion = false;
      await x.tick();
      assert.equal(assist.snapshot().pending, null);
      assert.deepEqual(calls, [true, false]);
    } else assert.deepEqual(calls, []);
  });

test("a permanent fitting refusal stays a configuration error before any laser order", async () => {
  const x = await repeatingBelt(1, {
    dogmaReply: () =>
      Response.json(
        { ok: false, error: "AUTH_FORBIDDEN", message: "Fitting data access denied." },
        { status: 403 },
      ),
  });
  await assert.rejects(
    x.tick(),
    (error) =>
      !(error instanceof FleetObservationUnavailable) &&
      (error as { code?: string }).code === "AUTH_FORBIDDEN" &&
      /access denied/.test(String(error)),
  );
  assert.equal(
    x.writes.some((write) => write.method === "AddTarget" || write.method === "Activate"),
    false,
  );
});

test("an ordinary Miner reads one hold panel and recovers from a temporary primary capacity failure", async () => {
  const x = await repeatingBelt(2, { dronesEnabled: false });
  x.holdFault(false, true);
  await x.tick();
  x.requests.length = 0;
  await x.tick();
  assert.equal(x.active.size, 2);
  assert.deepEqual(
    x.requests.filter((p) => p.includes("hold-") || p.endsWith("ore-hold")),
    ["/api/bridge/ship/ore-hold"],
  );
  x.holdFault(true, true);
  await assert.rejects(
    x.tick(),
    (e: Error) => e.constructor.name === "FleetObservationUnavailable",
  );
  assert.equal(x.active.size, 2);
  x.holdFault(false, true);
  x.ore(10);
  assert.equal(await x.tick(), "yield");
  assert.equal(x.active.size, 2);
});
test("running laser effects on the held grid replace Dogma reads while an idle laser is still verified", async () => {
  const x = await repeatingBelt(2, { droneTypes: [], dronesEnabled: false, sceneEffects: true });
  await x.tick();
  await x.tick();
  await x.tick();
  assert.equal(x.active.size, 2);
  x.requests.length = 0;
  await x.tick();
  assert.equal(x.requests.filter((r) => r.startsWith("module:")).length, 0);
  x.active.delete(55);
  x.requests.length = 0;
  await x.tick();
  assert.deepEqual(
    x.requests.filter((r) => r.startsWith("module:")),
    ["module:55"],
  );
  assert.equal(x.active.size, 2);
});
test("self-unload uses the same hold panel to leave at 90 percent of the effective bay", async () => {
  const x = await repeatingBelt(2, { dronesEnabled: false, haulMode: "SELF_UNLOAD" });
  x.ore(8_999);
  assert.equal(await x.tick(), "blocked");
  x.ore(9_000);
  x.requests.length = 0;
  assert.equal(await x.tick(), "hold-full");
  assert.deepEqual(
    x.requests.filter((p) => p.includes("hold-") || p.endsWith("ore-hold")),
    ["/api/bridge/ship/ore-hold"],
  );
});
for (const count of [1, 2])
  test(
    "belt keeps " + count + " native mining modules cycling and measures ore between passes",
    async () => {
      const x = await repeatingBelt(count);
      await x.tick();
      await x.tick();
      assert.equal(x.active.size, count);
      assert.deepEqual(
        x.writes.filter((w) => w.method === "Activate").map((w) => w.args.slice(2)),
        [
          [777, -1],
          [778, -1],
        ].slice(0, count),
      );
      assert.equal(x.waits(), 0);
      const targetReads = () => x.requests.filter((url) => url === "/api/bridge/targets").length;
      const readsWhileStarting = targetReads();
      assert.equal(readsWhileStarting, 2);
      await x.resume();
      x.ore(100);
      await x.tick();
      x.ore(200);
      assert.equal(await x.tick(), "yield");
      assert.equal(targetReads(), readsWhileStarting);
      assert.equal(x.writes.filter((w) => w.method === "Activate").length, count);
      if (count === 2) {
        x.rocks.delete(777);
        x.active.delete(55);
        await x.tick();
        assert.equal(targetReads(), readsWhileStarting + 1);
        assert.deepEqual(
          [...x.active],
          [
            [56, 778],
            [55, 778],
          ],
        );
        assert.equal(x.writes.filter((w) => w.method === "Activate" && w.args[0] === 56).length, 1);
      }
      await x.stop();
      assert.equal(x.active.size, 0);
      assert.equal(x.waits(), 1);
      assert.equal(x.writes.filter((w) => w.method === "Deactivate").length, count);
    },
  );

test("an ordinary Miner starts its belt cycle using the verified arrival scene without a second grid read", async () => {
  const x = await repeatingBelt(1),
    op = createOperation(memoryOperationStore("op", "epoch"), createTargetBoard(store(null)), {
      operationID: "op",
      runID: "epoch",
      systemID: 300,
      destinationID: 600,
      members: [...x.context.setup.members, { characterID: 3, shipID: 13, role: "HAULER" }],
    });
  const claim = op.reserve(1, belt)!;
  assert.ok(op.activate(1));
  const miner = createNativeMiner(x.context, x.session as any, {
    shipID: 11,
    beltID: 99,
    current() {},
    capacityM3: 55000,
    typeFacts: createRawTypeFacts(x.context, () => {}),
    mineCycle: x.cycle.tick,
  });
  const loops = createRawMembers(op),
    scenes = () => x.requests.filter((path) => path === "/api/bridge/space/snapshot").length;
  const before = scenes();
  await loops.miner(1, miner);
  assert.equal(scenes() - before, 1);
  await loops.miner(1, miner);
  assert.equal(scenes() - before, 2);
  assert.equal(x.active.size, 1);
  let arrival: MiningReadiness | undefined;
  await miner.navigate(belt, claim, (observed) => {
    arrival = observed;
  });
  assert.ok(arrival);
  const after = scenes();
  await miner.mineCycle(belt, claim, true, { ...arrival, observedAt: performance.now() - 1600 });
  assert.equal(scenes() - after, 1);
});

for (const outcome of ["ack", "lost", "cooldown"] as const)
  test("raw freight at 90% keeps lasers running with " + outcome, async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const x = await repeatingBelt(2, { freight: true });
    const members = [
      ...x.context.setup.members,
      { characterID: 2, shipID: 12, role: "MINER" as const },
      { characterID: 3, shipID: 13, role: "HAULER" as const },
    ];
    const op = createOperation(
      memoryOperationStore("op", "epoch"),
      createTargetBoard(store(null)),
      {
        operationID: "op",
        runID: "epoch",
        systemID: 300,
        destinationID: 600,
        members,
      },
    );
    assert.ok(op.reserve(1, belt));
    assert.ok(op.activate(1));
    const loops = createRawMembers(op);
    const miner = createNativeMiner(x.context, x.session as any, {
      shipID: 11,
      beltID: 99,
      current() {},
      capacityM3: 55000,
      oreLogistics: x.context.setup.oreLogistics,
      typeFacts: createRawTypeFacts(x.context, () => {}),
      mineCycle: x.cycle.tick,
    });
    const count = (method: string) => x.writes.filter((w) => w.method === method).length;
    const sample = () => loops.miner(1, miner);

    x.ore(120000);
    await sample();
    await sample();
    assert.equal(x.active.size, 2);
    assert.equal(count("Jettison"), 0);
    assert.equal(count("Deactivate"), 0);
    x.ore(outcome === "cooldown" ? 150000 : 135000);
    x.jettisonYield(outcome === "cooldown" ? 0 : 1000, 100);
    x.jettisonResult(outcome);
    if (outcome === "cooldown") {
      assert.equal(await sample(), "hold-full");
      assert.equal(op.snapshot().jetcanIntents["1"], undefined);
      await sample();
      assert.equal(count("Jettison"), 1);
      x.jettisonResult("ack");
      for (let i = 0; i < 19; i++) {
        t.mock.timers.tick(10000);
        assert.equal(op.heartbeat(), true);
      }
      assert.equal(await loops.miner(1, miner), "hold-full");
    } else assert.equal(await sample(), "hold-full");
    assert.equal(count("Jettison"), outcome === "cooldown" ? 2 : 1);
    const quantity = outcome === "cooldown" ? 150000 : 136000;
    assert.equal(count("Deactivate"), 0);
    assert.equal(count("Activate"), 2);
    assert.equal(x.readCan()?.quantity, quantity);
    assert.equal(op.snapshot().jetcanIntents["1"], undefined);
    assert.deepEqual(op.assignment(3)?.manifests, []);

    await loops.miner(1, miner);
    assert.equal(x.active.size, 2);
    assert.equal(x.laserYield(), 300);
    assert.equal(await loops.miner(1, miner), "yield");
    assert.equal(x.freight(), 300);
    assert.equal(count("Jettison"), outcome === "cooldown" ? 2 : 1);
  });

test("eight Miners continue on the same belt when a Jettison response is lost", async () => {
  const pilots = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      repeatingBelt(1, { characterID: index + 1, freight: true }),
    ),
  );
  const members = pilots.flatMap((pilot) => pilot.context.setup.members);
  const op = createOperation(memoryOperationStore("op", "epoch"), createTargetBoard(store(null)), {
    operationID: "op",
    runID: "epoch",
    systemID: 300,
    destinationID: 600,
    members: [...members, { characterID: 9, shipID: 19, role: "HAULER" }],
  });
  assert.ok(op.reserve(1, belt) && op.activate(1));
  const loops = createRawMembers(op);
  const miners = pilots.map((pilot) =>
    createNativeMiner(pilot.context, pilot.session as any, {
      shipID: pilot.context.characterID + 10,
      beltID: 99,
      current() {},
      capacityM3: 55000,
      typeFacts: createRawTypeFacts(pilot.context, () => {}),
      mineCycle: pilot.cycle.tick,
    }),
  );
  const turn = () => Promise.all(miners.map((miner, index) => loops.miner(index + 1, miner)));
  const drops = (index: number) =>
    pilots[index]!.writes.filter((write) => write.method === "Jettison");
  await turn();
  await turn();
  assert.ok(pilots.every((pilot) => pilot.active.size === 1));
  pilots[0]!.jettisonResult("not-applied");
  pilots[1]!.jettisonResult("lost");
  for (const pilot of pilots) pilot.ore(135000);
  await turn();
  assert.deepEqual(
    drops(0).map((write) => write.args),
    [[[888]]],
  );
  assert.deepEqual(
    drops(1).map((write) => write.args),
    [[[888]]],
  );
  await turn();
  assert.equal(
    drops(0).length,
    1,
    "the unchanged stack does not trigger another Jettison on the next turn",
  );
  assert.equal(drops(1).length, 1, "an empty hold resumes mining");
  pilots[0]!.ore(136000);
  pilots[0]!.jettisonResult("ack");
  pilots[1]!.ore(135000);
  pilots[1]!.jettisonResult("ack");
  await turn();
  assert.deepEqual(
    drops(0).map((write) => write.args),
    [[[888]], [[888]]],
    "growth of the same stack is eligible",
  );
  assert.deepEqual(
    drops(1).map((write) => write.args),
    [[[888]], [[889]]],
    "a new stack with the old quantity is eligible",
  );
  assert.ok(
    pilots.every(
      (pilot) =>
        pilot.active.size === 1 && !pilot.writes.some((write) => write.method === "Deactivate"),
    ),
  );
  assert.deepEqual(op.snapshot().jetcanIntents, {});
  assert.deepEqual(op.snapshot().manifests, []);
});

test("a full mining bay still requests unload when ordinary cargo is empty", async () => {
  const x = await repeatingBelt(2, { freight: true, haulMode: "SELF_UNLOAD" });
  x.ore(134999);
  await x.tick();
  await x.tick();
  assert.equal(x.active.size, 2);
  assert.equal(x.writes.filter((w) => w.method === "Deactivate").length, 0);
  x.ore(150000);
  assert.equal(await x.tick(), "blocked");
  assert.equal(x.writes.filter((w) => w.method === "Deactivate").length, 2);
  x.completeLaserCycles();
  assert.equal(await x.tick(), "hold-full");
});

// A drone recall can span several existing mining passes. Advance only the
// timers used by the native adapter, then let its readback promises settle.
async function flushFlight(t: TestContext, ms = 1000) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(ms);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("both lasers produce ore while combat drones fight and through both drone swaps", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const x = await repeatingBelt(2, { rockIDs: [777], droneTypes: [101, 102] });
  const lasers = [
    [55, 777],
    [56, 777],
  ];
  await x.tick();
  await x.tick();
  assert.deepEqual([...x.active], lasers);
  assert.equal(x.out.get(701)?.activity, "mining");
  x.delayReturn();
  x.threat(300);
  await x.tick();
  await flushFlight(t);
  assert.equal(x.out.get(701)?.activity, "returning");
  assert.equal(x.bay.has(701), false);
  assert.equal(x.out.has(702), false);
  const duringRecall = x.laserYield();
  assert.equal(await x.tick(), "yield");
  assert.equal(x.freight(), duringRecall);
  assert.deepEqual([...x.active], lasers);

  x.finishReturn(701);
  await flushFlight(t);
  x.refuseEngage();
  for (let i = 0; i < 6 && x.out.get(702)?.activity !== "fighting"; i++) {
    await x.tick();
    await flushFlight(t, 6000);
  }
  assert.deepEqual([...x.locked], [777]);
  assert.equal(x.out.get(702)?.targetID, 90);
  assert.equal(x.out.get(702)?.activity, "fighting");
  assert.equal(x.writes.filter((w) => w.method === "CmdEngage").length, 2);
  const resumeDroneRead = x.stallDroneRead();
  const whileFighting = x.laserYield();
  assert.equal(await x.tick(), "yield");
  assert.equal(x.freight(), whileFighting);
  assert.equal(x.waits(), 0);
  assert.ok(whileFighting > duringRecall);
  assert.deepEqual([...x.active], lasers);
  assert.equal(x.out.get(702)?.activity, "fighting");
  const whileDroneReadWaits = x.laserYield();
  assert.equal(await x.tick(), "yield");
  assert.equal(x.freight(), whileDroneReadWaits);
  resumeDroneRead();
  x.threat(300, 91);
  for (let i = 0; i < 6 && x.out.get(702)?.targetID !== 91; i++) await x.tick();
  assert.equal(x.out.get(702)?.targetID, 91);
  assert.equal(x.out.get(702)?.activity, "fighting");
  assert.deepEqual([...x.active], lasers);
  assert.equal(await x.tick(), "blocked");
  const afterRetarget = x.laserYield();
  assert.equal(await x.tick(), "yield");
  assert.equal(x.freight(), afterRetarget);

  x.threat(null);
  for (let i = 0; i < 8 && x.out.get(701)?.activity !== "mining"; i++) {
    await x.tick();
    await flushFlight(t);
  }
  assert.ok(x.bay.has(702));
  assert.equal(x.out.get(701)?.targetID, 777);
  assert.equal(x.out.get(701)?.activity, "mining");
  assert.deepEqual([...x.active], lasers);
  assert.deepEqual(
    x.writes.filter((w) => w.method === "Activate").map((w) => w.args.slice(2)),
    [
      [777, -1],
      [777, -1],
    ],
  );
  assert.equal(
    x.writes.some((w) => w.method === "Deactivate" || w.method === "RemoveTarget"),
    false,
  );
  const stopped = x.stop();
  await flushFlight(t);
  await flushFlight(t);
  assert.equal((await stopped).dronesSafe, true);
  assert.ok(x.bay.has(701));
  assert.equal(x.out.size, 0);
  assert.equal(x.active.size, 0);
  assert.equal(x.writes.filter((w) => w.method === "Deactivate").length, 2);
});

test("a working asteroid stays selected inside actual laser range without a correction approach", async () => {
  const x = await repeatingBelt(2, { rockIDs: [777] });
  await x.tick();
  await x.tick();
  x.moveRock(14200);
  const ore = x.laserYield();
  assert.equal(await x.tick(), "yield");
  assert.equal(x.freight(), ore);
  assert.deepEqual(
    [...x.active],
    [
      [55, 777],
      [56, 777],
    ],
  );
  assert.equal(
    x.writes.some((w) => w.method === "Approach" || w.method === "Deactivate"),
    false,
  );
});

test("lasers and combat drones keep working above the Jettison threshold while cooldown is active", async () => {
  const x = await repeatingBelt(2, { rockIDs: [777], droneTypes: [102], freight: true });
  await x.tick();
  await x.tick();
  x.threat(300);
  for (let i = 0; i < 6 && x.out.get(702)?.activity !== "fighting"; i++) await x.tick();
  assert.equal(x.out.get(702)?.activity, "fighting");
  x.ore(136000);
  await x.tick(false);
  const ore = x.laserYield();
  assert.equal(await x.tick(false), "yield");
  assert.equal(x.freight(), ore);
  assert.deepEqual(
    [...x.active],
    [
      [55, 777],
      [56, 777],
    ],
  );
  assert.equal(
    x.writes.some((w) => w.method === "Deactivate" || w.method === "Jettison"),
    false,
  );
});

test("a fresh hostile and a stalled drone panel do not delay belt Jettison", async () => {
  const x = await repeatingBelt(2, { rockIDs: [777], droneTypes: [102], freight: true });
  const members = [
    ...x.context.setup.members,
    { characterID: 2, shipID: 12, role: "MINER" as const },
    { characterID: 3, shipID: 13, role: "HAULER" as const },
  ];
  const op = createOperation(memoryOperationStore("op", "epoch"), createTargetBoard(store(null)), {
    operationID: "op",
    runID: "epoch",
    systemID: 300,
    destinationID: 600,
    members,
  });
  assert.ok(op.reserve(1, belt) && op.activate(1));
  const miner = createNativeMiner(x.context, x.session as any, {
    shipID: 11,
    beltID: 99,
    current() {},
    capacityM3: 55000,
    oreLogistics: x.context.setup.oreLogistics,
    typeFacts: createRawTypeFacts(x.context, () => {}),
    mineCycle: x.cycle.tick,
  });
  await x.tick();
  await x.tick();
  assert.equal(x.active.size, 2);
  x.ore(135000);
  x.threat(300);
  const release = x.stallDroneRead(),
    trip = createRawMembers(op).miner(1, miner);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(x.writes.filter((w) => w.method === "Jettison").length, 1);
    assert.equal(x.active.size, 2);
  } finally {
    release();
    await trip;
  }
  assert.equal(await trip, "hold-full");
  assert.equal(op.snapshot().manifests.length, 0);
  assert.equal(
    x.writes.some((w) => w.method === "Deactivate"),
    false,
  );
});

test("a timed-out spare drone bay read leaves mining drones, lasers and Jettison productive", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const x = await repeatingBelt(2, {
    rockIDs: [777],
    droneTypes: [101],
    freight: true,
    droneCap: 2,
  });
  const members = [
    ...x.context.setup.members,
    { characterID: 2, shipID: 12, role: "MINER" as const },
    { characterID: 3, shipID: 13, role: "HAULER" as const },
  ];
  const op = createOperation(memoryOperationStore("op", "epoch"), createTargetBoard(store(null)), {
    operationID: "op",
    runID: "epoch",
    systemID: 300,
    destinationID: 600,
    members,
  });
  assert.ok(op.reserve(1, belt) && op.activate(1));
  const miner = createNativeMiner(x.context, x.session as any, {
    shipID: 11,
    beltID: 99,
    current() {},
    capacityM3: 55000,
    oreLogistics: x.context.setup.oreLogistics,
    typeFacts: createRawTypeFacts(x.context, () => {}),
    mineCycle: x.cycle.tick,
  });
  const loop = createRawMembers(op);
  await x.tick();
  await x.tick();
  const lasers = [
    [55, 777],
    [56, 777],
  ];
  assert.deepEqual([...x.active], lasers);
  assert.equal(x.out.get(701)?.activity, "mining");
  await flushFlight(t, 6000);

  const release = x.stallDroneRead();
  try {
    const reads = x.requests.filter((r) => r === "drone-bay").length;
    await x.tick();
    assert.equal(x.requests.filter((r) => r === "drone-bay").length, reads + 1);
    await flushFlight(t, 12001);
    assert.ok(
      x.reports.some(
        (r) =>
          r.phase === "Drone observation unavailable" && r.why === "Drone observation timed out.",
      ),
    );

    x.ore(135000);
    assert.equal(await loop.miner(1, miner), "hold-full");
    assert.equal(x.readCan()?.quantity, 135000);
    assert.deepEqual([...x.active], lasers);
    assert.equal(x.out.get(701)?.activity, "mining");
    assert.equal(x.writes.filter((w) => w.method === "LaunchDrones").length, 1);
    assert.equal(x.laserYield(), 200);
    assert.equal(await x.tick(), "yield");
  } finally {
    release();
    await flushFlight(t);
  }
});

test("a resumed Miner keeps both lasers and Jettison running during a delayed drone reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const x = await repeatingBelt(2, { rockIDs: [777], droneTypes: [101], freight: true });
  const op = createOperation(memoryOperationStore("op", "epoch"), createTargetBoard(store(null)), {
    operationID: "op",
    runID: "epoch",
    systemID: 300,
    destinationID: 600,
    members: [...x.context.setup.members, { characterID: 3, shipID: 13, role: "HAULER" }],
  });
  assert.ok(op.reserve(1, belt) && op.activate(1));
  await x.tick();
  await x.tick();
  const lasers = [
    [55, 777],
    [56, 777],
  ];
  assert.deepEqual([...x.active], lasers);
  const drone = x.out.get(701)!;
  assert.equal(drone.activity, "mining");
  drone.controlled = false;
  await x.resume();
  const miner = createNativeMiner(x.context, x.session as any, {
    shipID: 11,
    beltID: 99,
    current() {},
    capacityM3: 55000,
    oreLogistics: x.context.setup.oreLogistics,
    typeFacts: createRawTypeFacts(x.context, () => {}),
    mineCycle: x.cycle.tick,
  });
  const loops = createRawMembers(op),
    count = (method: string) => x.writes.filter((w) => w.method === method).length;
  const release = x.stallDroneReconnect();
  try {
    await x.tick();
    assert.equal(count("CmdReconnectToDrones"), 1);
    await flushFlight(t, 12001);
    assert.ok(x.reports.some((r) => /Drone command is still in flight/.test(r.why)));
    x.ore(135000);
    assert.equal(await loops.miner(1, miner), "hold-full");
    assert.equal(x.readCan()?.quantity, 135000);
    assert.deepEqual([...x.active], lasers);
    assert.equal(x.laserYield(), 200);
    assert.equal(count("CmdReconnectToDrones"), 1);
  } finally {
    release();
    await flushFlight(t);
  }
  await x.tick();
  assert.equal(drone.activity, "mining");
  assert.equal(count("LaunchDrones"), 1);
  assert.equal(count("Deactivate"), 0);
});

test("Jettison uses the growing exact stack while approach and new asteroid metadata are still outstanding", async () => {
  const x = await repeatingBelt(2, { rockIDs: [777], freight: true, dronesEnabled: false });
  await x.tick();
  await x.tick();
  x.moveRock(18000);
  await x.tick();
  assert.ok(x.writes.some((w) => w.method === "Approach"));
  x.rockType(31);
  x.ore(135000);
  x.oreAtNextList(136000);
  x.requests.length = 0;
  let selected: readonly { quantity: number }[] = [];
  const jettison = async (items: readonly ManifestItem[]) => {
    selected = items;
    await x.session.flow.flying.bridgeDo("ship", "Jettison", [items.map((item) => item.itemID)]);
    return true;
  };
  assert.equal(await x.cycle.tick(belt, beltClaim, true, undefined, jettison), "hold-full");
  assert.equal(selected[0]?.quantity, 136000);
  assert.equal(x.readCan()?.quantity, 136000);
  assert.equal(x.active.size, 2);
  assert.equal(
    x.requests.some((p) => p === "/api/types/volumes" || p === "/api/client-data/dogma-types"),
    false,
  );
  assert.deepEqual(
    x.requests.filter((p) => p.startsWith("hold-")),
    ["hold-invalidate", "hold-list"],
  );
});

test("Jettison reselects on a later pass if the exact stack shrank below the threshold", async () => {
  const x = await repeatingBelt(2, { rockIDs: [777], freight: true, dronesEnabled: false });
  await x.tick();
  await x.tick();
  x.ore(136000);
  x.oreAtNextList(134999);
  const unexpected = async () => assert.fail("The old selection changed before Jettison");
  await x.cycle.tick(belt, beltClaim, true, undefined, unexpected);
  await x.cycle.tick(belt, beltClaim, true, undefined, unexpected);
  assert.equal(x.readCan(), null);
  assert.equal(x.active.size, 2);
});

test("Miner orders its combat drone while the idle laser is still reading locks", async () => {
  const x = await repeatingBelt(2, { rockIDs: [777], droneTypes: [102] });
  x.locked.add(777);
  x.active.set(55, 777);
  x.bay.delete(702);
  x.out.set(702, { itemID: 702, typeID: 102, controlled: true, activity: "idle", targetID: null });
  x.threat(300);
  const release = x.stallTargetsRead(),
    tick = x.tick();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(x.requests.includes("/api/bridge/targets"));
    assert.equal(x.out.get(702)?.targetID, 90);
    assert.deepEqual([...x.active], [[55, 777]]);
  } finally {
    release();
    await tick;
  }
  assert.deepEqual(
    [...x.active],
    [
      [55, 777],
      [56, 777],
    ],
  );
});

test(
  "two Miners exchange drone roles before hold reads with room for either flight",
  { timeout: 1500 },
  async (t) => {
    const miners = await Promise.all(
      [1, 2].map((characterID) =>
        repeatingBelt(2, { characterID, rockIDs: [777], droneTypes: [101, 102], droneCap: 2 }),
      ),
    );
    for (let i = 0; i < 2; i++) await Promise.all(miners.map((x) => x.tick()));
    for (const x of miners) {
      assert.equal(x.out.get(701)?.activity, "mining");
      assert.equal(x.active.size, 2);
    }
    const transitions = [
      { threat: 300, returning: 701, working: 702, order: "CmdEngage" },
      { threat: null, returning: 702, working: 701, order: "CmdMineRepeatedly" },
    ] as const;
    for (const change of transitions) {
      const before = miners.map((x) => ({ writes: x.writes.length, reads: x.requests.length }));
      const unblock = miners.map((x) => x.stallHoldRead());
      const passes = miners.map((x) => {
        x.delayReturn();
        x.threat(change.threat);
        return x.tick();
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (const [i, x] of miners.entries()) {
          assert.equal(x.out.get(change.returning)?.activity, "returning");
          assert.equal(x.out.get(change.working)?.activity, change.threat ? "fighting" : "mining");
          assert.equal(x.active.size, 2);
          assert.deepEqual(
            x.writes.slice(before[i]!.writes).map((w) => w.method),
            ["CmdReturnBay", "LaunchDrones", change.order],
          );
          assert.equal(
            x.requests.slice(before[i]!.reads).filter((r) => r === "drone-bay").length,
            1,
          );
          x.finishReturn(change.returning);
        }
      } finally {
        for (const release of unblock) release();
        await Promise.all(passes);
      }
      t.diagnostic(
        change.order +
          " in one pass per Miner, one drone panel and three native writes, with hold read blocked",
      );
    }
  },
);

test("both lasers and the combat flight work with the only target slot occupied by an asteroid", async () => {
  const x = await repeatingBelt(2, {
    rockIDs: [777, 778],
    droneTypes: [102],
    pilotLimit: 1,
    nativeDroneRange: 20000,
  });
  x.session.flow.flying.resolveDroneControlRange = async () => 20_000;
  x.threat(18000);
  x.locked.add(778);
  x.active.set(55, 778);
  await x.tick();
  assert.deepEqual(
    [...x.active],
    [
      [55, 778],
      [56, 778],
    ],
  );
  for (let i = 0; i < 4 && x.out.get(702)?.activity !== "fighting"; i++) await x.tick();
  assert.equal(x.out.get(702)?.targetID, 90);
  assert.equal(x.out.get(702)?.activity, "fighting");
  assert.equal(
    x.writes.some((w) => ["AddTarget", "RemoveTarget", "Deactivate"].includes(w.method)),
    false,
  );
  const ore = x.laserYield();
  assert.equal(await x.tick(), "yield");
  assert.equal(x.freight(), ore);
});

test("Venture engages a hostile while ore continues, with or without timing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const events: Record<string, unknown>[] = [];
  const timing = createPilotTiming(
    { operationID: "op", operationRunID: "epoch", characterID: 1, shipID: 11, role: "MINER" },
    (line) => events.push(JSON.parse(line.slice("[mcc-timing] ".length))),
  );
  async function runTrace(trace?: MccTiming) {
    const x = await repeatingBelt(2, { rockIDs: [777], droneTypes: [102], timing: trace });
    const navigation = createNativeBeltNavigation(x.context, x.session as any, {
      shipID: 11,
      beltID: 99,
      current() {},
      timing: trace,
    });
    await navigation.navigate(belt, beltClaim);
    await x.tick();
    await x.tick();
    x.threat(300);
    await x.tick();
    await x.tick();
    assert.equal(
      x.writes.some((w) => w.method === "AddTarget" && w.args[0] === 90),
      false,
    );
    x.laserYield();
    assert.equal(await x.tick(), "yield");
    assert.deepEqual(
      [...x.active],
      [
        [55, 777],
        [56, 777],
      ],
    );
    for (let i = 0; i < 4 && x.out.get(702)?.activity !== "fighting"; i++) await x.tick();
    assert.equal(x.out.get(702)?.activity, "fighting");
    x.laserYield();
    assert.equal(await x.tick(), "yield");
    return { writes: x.writes, requests: x.requests };
  }
  assert.deepEqual(await runTrace(timing), await runTrace());
  const names = events.map((e) => e.event);
  for (const name of [
    "belt-arrival",
    "mining-cycle.snapshot",
    "mining-add-target-rpc",
    "mining-activate-rpc",
    "miner-combat-flight-observed",
    "miner-cmd-engage-rpc",
    "miner-engage-observed",
    "mining-first-ore-increase",
  ])
    assert.ok(names.includes(name), name);
  assert.equal(events.filter((e) => e.event === "mining-cycle.snapshot").length, 1);
  assert.ok(
    events.every(
      (e) => e.operationRunID === "epoch" && e.characterID === 1 && typeof e.at === "string",
    ),
  );
});

for (const { label, meters, droneTypes, reason } of [
  {
    label: "a native drone range refusal",
    meters: 25000,
    droneTypes: [101, 102],
    reason: /out of drone control range/,
  },
  {
    label: "no combat drones",
    meters: 300,
    droneTypes: [101],
    reason: /no usable combat drone flight/,
  },
])
  test(label + " preserves the asteroid lock and native ore yield", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const x = await repeatingBelt(2, { rockIDs: [777], droneTypes, nativeDroneRange: 20000 });
    if (droneTypes.length > 1) x.session.flow.flying.resolveDroneControlRange = async () => 30_000;
    await x.tick();
    await x.tick();
    x.threat(meters);
    for (let i = 0; i < 5; i++) {
      await x.tick();
      await flushFlight(t);
    }
    assert.ok(x.reports.some((r) => reason.test(r.why)));
    assert.deepEqual([...x.locked], [777]);
    assert.deepEqual(
      x.writes.filter((w) => w.method === "AddTarget").map((w) => w.args[0]),
      [777],
    );
    assert.deepEqual(
      [...x.active],
      [
        [55, 777],
        [56, 777],
      ],
    );
    assert.equal(
      x.writes.some((w) => w.method === "Deactivate" || w.method === "RemoveTarget"),
      false,
    );
    assert.equal(
      x.writes.filter((w) => w.method === "CmdEngage").length,
      droneTypes.length === 1 ? 0 : 1,
    );
    const ore = x.laserYield();
    assert.equal(await x.tick(), "yield");
    assert.equal(x.freight(), ore);
    assert.equal(x.out.get(701)?.activity, "mining");
  });

test("confirmed asteroid depletion still advances during active drone combat", async () => {
  const x = await repeatingBelt(2, { rockIDs: [777], droneTypes: [102] });
  await x.tick();
  await x.tick();
  x.threat(300);
  for (let i = 0; i < 4 && x.out.get(702)?.activity !== "fighting"; i++) await x.tick();
  assert.equal(x.out.get(702)?.activity, "fighting");
  x.rocks.clear();
  x.active.clear();
  x.locked.delete(777);
  assert.equal(await x.tick(), "blocked");
  assert.equal(await x.tick(), "blocked");
  assert.equal(await x.tick(), "depleted");
  assert.equal(x.out.get(702)?.activity, "fighting");
});

test("belt depletion requires three valid empty grids after unreadable native evidence", async () => {
  const x = await repeatingBelt();
  await x.tick();
  x.rocks.clear();
  assert.equal(await x.tick(), "blocked");
  x.scene(false);
  await assert.rejects(x.tick(), /scene identity is temporarily unreadable/);
  x.scene(true);
  assert.equal(await x.tick(), "blocked");
  assert.equal(await x.tick(), "blocked");
  assert.equal(await x.tick(), "depleted");
});

test("hosted Miners and Defenders resume after transient reads through two hostile waves and Return Home", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: Date.now() });
  const { Park } = createRequire(import.meta.url)("../../../src/gamePort/destiny/park.js");
  const members = [1, 2, 3, 4].map((characterID) => ({
    characterID,
    shipID: 10 + characterID,
    role: characterID < 3 ? ("MINER" as const) : ("DEFENDER" as const),
  }));
  const groupSetup: FleetSetup = {
    ...setup,
    operationID: "two-wave-escort",
    beltName: "belt",
    members,
    destinationID: 600,
    haulMode: "SELF_UNLOAD",
    corporationID: 77,
    division: 1,
    canCapacityM3: 100,
  };
  const storage = memoryFleetDocuments(),
    document = storage.document;
  const point = (x: number) => ({ x, y: 0, z: 0 });
  const positions = new Map(members.map((m) => [m.shipID, m.characterID * 1000]));
  const modes = new Map(members.map((m) => [m.shipID, "STOP"]));
  const moves = new Map<number, { target: number; range: number }>();
  const events: string[] = [],
    reports: string[] = [],
    parked = new Set<number>();
  const hostedReports = new Map<number, { status?: string; phase?: string; why?: string }>();
  const transition = {
    phase: "ready",
    sessionStable: true,
    locationReady: true,
    sceneReady: true,
    egoReady: true,
    shipReady: true,
    boundContextReady: true,
  };
  let rat: { id: number; x: number } | null = null,
    health = 1,
    sample = 0,
    unrelatedFleetReads = 0;
  let defenderReadFailures = 0;
  const role = (m: (typeof members)[number]) => m.role === "MINER";
  const miners = await Promise.all(
    members.filter(role).map((m, index) => {
      let failed = false;
      return repeatingBelt(2, {
        characterID: m.characterID,
        operationID: groupSetup.operationID,
        rockIDs: [777],
        droneTypes: [101, 102],
        dogmaReply() {
          if (failed) return;
          failed = true;
          if (index === 0)
            return Response.json(
              { ok: false, error: "EVE_GATEWAY_TIMEOUT", message: "EveJS gateway timed out." },
              { status: 502 },
            );
          throw new TransportQueueError("/api/types/dogma", 20_000, {
            inFlight: 4,
            queued: 1,
            oldestOutstandingMs: 20_000,
            verdict: "All 4 request lanes were busy.",
          });
        },
      });
    }),
  );
  const runtime = createMiningFleetRuntime({
    storage,
    async createCycle() {
      throw Error("Unexpected fleet bootstrap");
    },
    async settle(run, session, current, options) {
      return settleFleetMember({ ...run, setup: groupSetup as any }, session, current, options);
    },
    async park(run) {
      const id = (run as any).characterID as number;
      parked.add(id);
      events.push("park:" + id);
      return { destinationID: 600, kind: "station", systemID: 300 };
    },
  });
  const group = runtime.getOrCreate(groupSetup);
  assert.ok(group.op.reserve(1, belt));
  assert.ok(group.op.activate(1));
  function register(m: (typeof members)[number], run: any, session: any, cycle: any) {
    const tracked = {
      ...run,
      report(value: { status?: string; phase?: string; why?: string }) {
        hostedReports.set(m.characterID, value);
        run.report(value);
      },
    };
    group.entries.set(m.characterID, {
      run: tracked,
      session,
      member: m,
      cycle,
      native: cycle
        ? {
            current() {},
            async navigate() {},
            mineCycle: cycle.tick,
          }
        : null,
      selfUnload: null,
      generation: 1,
      active: true,
      busy: false,
      failed: null,
      flushed: false,
      unregister() {},
      expiry: Date.now() + 600000,
      lease: null,
    } as any);
  }
  const fleetReply = () => {
    unrelatedFleetReads++;
    return Response.json({ ok: false, error: "CALL_TIMEOUT" }, { status: 504 });
  };
  for (const [index, m] of members.filter(role).entries()) {
    const x = miners[index]!;
    register(
      m,
      {
        ...x.context,
        setup: groupSetup,
        botID: "escort-" + m.characterID,
        report(r: { phase?: string; why?: string }) {
          reports.push(m.characterID + " " + r.phase + " " + r.why);
        },
        fetch: async (input: URL, init: RequestInit) =>
          new URL(String(input)).pathname === "/api/bridge/bound-fleet"
            ? fleetReply()
            : x.context.fetch(input, init),
      },
      x.session,
      x.cycle,
    );
  }
  const defenders = members
    .filter((m) => !role(m))
    .map((m) => {
      const { characterID: id, shipID } = m,
        droneID = 800 + id,
        weaponIDs = id === 3 ? [51, 52] : [];
      const active = new Map<number, number>(),
        locked = new Set<number>(),
        acquiring = new Set<number>();
      const park = new Park({ pilot: () => ({ charID: id, shipID }) });
      park.validState = true;
      let deployed = false,
        firstLock = true,
        wrongActive = true,
        refuseDroneOrder = id === 4,
        notifications: object[] = [];
      const list = (items: unknown[]) => ({ type: "list", items });
      const dict = (entries: unknown[]) => ({ type: "dict", entries });
      const kv = (fields: Record<string, unknown>) => ({
        type: "object",
        name: "util.KeyVal",
        args: dict(Object.entries(fields)),
      });
      const emit = (targetID: number | null) => {
        const stamp = BigInt(park.currentTime);
        park.doDestinyUpdate(
          list([
            [
              stamp,
              [
                Buffer.from("OnDroneStateChange"),
                list([
                  BigInt(droneID),
                  id,
                  BigInt(shipID),
                  targetID ? 1 : 0,
                  2454,
                  id,
                  targetID ? BigInt(targetID) : null,
                ]),
              ],
            ],
            [
              stamp,
              [
                Buffer.from("OnDroneActivityChange"),
                list([
                  BigInt(droneID),
                  targetID ? BigInt(targetID) : null,
                  targetID ? Buffer.from("fighting") : null,
                ]),
              ],
            ],
          ]),
          false,
          list([]),
        );
        park.doPreTick(park.currentTime);
      };
      const module = (itemID: number) => ({
        itemID,
        ownerID: id,
        locationID: shipID,
        typeID: 91,
        categoryID: 7,
        flagID: 27 + weaponIDs.indexOf(itemID),
        quantity: 1,
      });
      const scene = () => {
        const target = park.stateByDroneID.get(droneID)?.targetID ?? null;
        const ship = {
          itemID: shipID,
          characterID: id,
          mode: modes.get(shipID),
          position: point(positions.get(shipID)!),
          radius: 10,
          activeModuleIDs: [...active.keys()],
        };
        return {
          stateValid: true,
          inSpace: true,
          shipID,
          solarSystemID: 300,
          sampledAtMs: ++sample,
          ship,
          entities: [
            {
              itemID: 99,
              groupID: 9,
              categoryID: 2,
              name: "belt",
              position: point(0),
              radius: 100,
            },
            ...members.map((p) => ({
              itemID: p.shipID,
              kind: "ship",
              categoryID: 6,
              characterID: p.characterID,
              position: point(positions.get(p.shipID)!),
              radius: 10,
            })),
            ...(rat
              ? [
                  {
                    itemID: rat.id,
                    kind: "ship",
                    categoryID: 11,
                    isNpc: true,
                    npcEntityType: "npc",
                    position: point(rat.x),
                    radius: 10,
                    shieldRatio: health,
                    armorRatio: 1,
                    hullRatio: 1,
                  },
                ]
              : []),
            ...(deployed
              ? [
                  {
                    itemID: droneID,
                    kind: "drone",
                    ownerID: id,
                    controllerID: shipID,
                    typeID: 2454,
                    targetEntityID: target,
                    droneActivity: target ? "fighting" : "idle",
                    position: ship.position,
                    radius: 1,
                    shieldRatio: 1,
                    armorRatio: 1,
                    hullRatio: 1,
                  },
                ]
              : []),
          ],
        };
      };
      const activate = (itemID: number, target: number) => {
        assert.ok(locked.has(target));
        assert.ok(Math.abs(rat!.x - positions.get(shipID)!) - 20 <= 10000);
        events.push("weapon:" + id + ":" + itemID + ":" + target);
        if (itemID === 51 && wrongActive) {
          wrongActive = false;
          active.set(itemID, 999);
          throw Object.assign(Error("EffectAlreadyActive2"), {
            code: "CALL_REFUSED",
            status: 409,
            refusal: { key: "EffectAlreadyActive2" },
          });
        }
        active.set(itemID, target);
      };
      const fitted = () => ({
        activeShipID: shipID,
        slotsError: null,
        chargeFits: {},
        slots: weaponIDs.map((itemID, index) => ({
          family: "high",
          index,
          module: { itemID, typeID: 91, online: true },
        })),
      });
      const session = {
        store: {
          station: { get: () => ({ online: { characterID: id } }) },
          fitting: { get: fitted },
          targeting: { get: () => ({ acquiringTargetIDs: [...acquiring] }) },
          apply(e: { type: string; targetID: number }) {
            if (e.type === "targeting/acquiring") acquiring.add(e.targetID);
            else acquiring.delete(e.targetID);
          },
        },
        flow: {
          requestOptions: () => ({}),
          setLivePush() {},
          async stopShip() {
            moves.delete(shipID);
            modes.set(shipID, "STOP");
          },
          async approach(target: number, range: number) {
            events.push("follow:" + id + ":" + target + ":" + range);
            moves.set(shipID, { target, range });
            modes.set(shipID, "FOLLOW");
          },
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            readFit: async () => true,
            resolveDroneControlRange: async () => 10000,
            fittedModuleActivation: () => "activatable",
            resolveRemoteRepModuleIDs: () => ({ shield: [], armor: [], hull: [], cap: [] }),
            resolveDefenseModuleIDs: () => ({
              weapons: weaponIDs,
              shield: [],
              armor: [],
              hull: [],
              hardeners: [],
            }),
            withPilotDroneCap: () => ({ maxActiveDrones: 1 }),
            attributesOfTypes: async () => ({ 2454: { 1272: 5 } }),
            classifyDroneRoles: async () => ({
              bay: { combat: deployed ? [] : [droneID] },
              out: { combat: deployed ? [droneID] : [] },
            }),
            async bridgeAsk(_service: string, method: string, args: number[]) {
              assert.equal(method, "QueryAttributeValue");
              assert.deepEqual(args, [shipID, 76]);
              if (id === 3 && rat && defenderReadFailures === 0) {
                defenderReadFailures++;
                throw Object.assign(Error("EveJS gateway timed out."), {
                  code: "EVE_GATEWAY_TIMEOUT",
                  status: 502,
                });
              }
              return 12000;
            },
            async bridgeDo(_service: string, method: string, args: any[]) {
              if (method === "invCache" || method === "InvalidateLocationCache") return;
              if (method === "CmdReturnBay") {
                assert.deepEqual(args[0], [droneID]);
                deployed = false;
                emit(null);
                events.push("recall:" + id);
                return dict([]);
              }
              if (method === "Activate") return activate(args[0], args[2]);
              assert.equal(method, "AddTarget");
              const target = args[0] as number;
              assert.ok(rat);
              assert.equal(target, rat.id);
              assert.ok(Math.abs(rat.x - positions.get(shipID)!) - 20 <= 12000);
              events.push("lock:" + id + ":" + target);
              if (id === 3 && firstLock) {
                firstLock = false;
                notifications = [{ method: "FailLockTarget", args: [target] }];
                return [1];
              }
              locked.add(target);
              acquiring.delete(target);
              return [0];
            },
          },
        },
      };
      const run = {
        characterID: id,
        held: { characterID: id },
        botID: "escort-" + id,
        baseUrl: "http://bff",
        setup: groupSetup,
        report(r: { phase?: string; why?: string }) {
          reports.push(id + " " + r.phase + " " + r.why);
        },
        async fetch(input: URL, init?: RequestInit) {
          let body: object;
          const path = new URL(String(input)).pathname;
          switch (path) {
            case "/api/bridge/bound-fleet":
              return fleetReply();
            case "/api/bridge/flight/status":
              body = {
                flight: {
                  shipID,
                  inSpace: !parked.has(id),
                  docked: parked.has(id),
                  solarSystemID: 300,
                  stationID: parked.has(id) ? 600 : null,
                  shipMode: modes.get(shipID),
                  transition,
                },
              };
              break;
            case "/api/bridge/space/snapshot":
              body = { space: scene() };
              break;
            case "/api/bridge/targets":
              body = { targetIDs: [...locked], notifications };
              notifications = [];
              break;
            case "/api/bridge/drones":
              body = {
                activeShipID: shipID,
                shipInfo: null,
                bay: deployed ? [] : [{ itemID: droneID, typeID: 2454, quantity: -1 }],
                inSpace: deployed
                  ? [
                      {
                        itemID: droneID,
                        typeID: 2454,
                        controlled: true,
                        activity: rat ? "fighting" : "idle",
                      },
                    ]
                  : [],
                errors: { shipInfo: null, bay: null, inSpace: null },
              };
              break;
            case "/api/bridge/call": {
              const { method, args } = JSON.parse(String(init?.body));
              let result: unknown = null;
              if (method === "List")
                result = list(
                  args[0] === 87
                    ? deployed
                      ? []
                      : [
                          {
                            itemID: droneID,
                            typeID: 2454,
                            quantity: -1,
                            ownerID: id,
                            locationID: shipID,
                            flagID: 87,
                          },
                        ]
                    : weaponIDs.map(module).filter((m) => m.flagID === args[0]),
                );
              else if (method === "ItemGetInfo") {
                const item = module(args[0]),
                  time = {
                    type: "long",
                    value: String(134385165369000000n + BigInt(++sample) * 10000n),
                  };
                const effects = [[16, [item.itemID, id, shipID, null, null, [], 16, time, -1, 1]]];
                if (active.has(item.itemID))
                  effects.push([
                    67,
                    [
                      item.itemID,
                      id,
                      shipID,
                      active.get(item.itemID)!,
                      null,
                      [],
                      67,
                      time,
                      10000,
                      1,
                    ],
                  ]);
                result = kv({
                  itemID: item.itemID,
                  invItem: { type: "packedrow", fields: item },
                  attributes: dict([
                    [54, 9000],
                    [158, 1000],
                    [160, 1],
                  ]),
                  activeEffects: dict(effects),
                  time,
                  wallclockTime: time,
                });
              } else if (method === "QueryAllAttributesForItem")
                result = dict([
                  [352, 1],
                  [1271, 5],
                ]);
              else if (method === "LaunchDrones") {
                assert.deepEqual(args[0], [[droneID, 1]]);
                deployed = true;
                emit(null);
                result = dict([[droneID, list([droneID])]]);
              } else if (method === "CmdEngage") {
                assert.ok(Math.abs(rat!.x - positions.get(shipID)!) - 20 <= 10000);
                if (refuseDroneOrder) {
                  refuseDroneOrder = false;
                  events.push("drone-refused:" + id + ":" + args[1]);
                  result = dict([
                    [
                      droneID,
                      [
                        "CustomNotify",
                        dict([["notify", "That target is not visible to this drone."]]),
                      ],
                    ],
                  ]);
                } else {
                  emit(args[1]);
                  events.push("engage:" + id + ":" + args[1]);
                  result = dict([]);
                }
              } else if (method === "Deactivate") {
                active.delete(args[0]);
                events.push("shutdown:" + id + ":" + args[0]);
              } else assert.equal(method, "InvalidateLocationCache");
              body = { result };
              break;
            }
            default:
              assert.fail("Unexpected Defender request " + path);
          }
          return Response.json({ ok: true, ...body });
        },
      };
      register(m, run, session, null);
      return { id, shipID, active, locked, droneID, park, isDeployed: () => deployed };
    });
  const step = async () => {
    for (const [ship, move] of moves) {
      const target = rat?.id === move.target ? rat.x : positions.get(move.target);
      if (target !== undefined) {
        const p = positions.get(ship)!;
        positions.set(ship, target + Math.sign(p - target) * (move.range + 20));
      }
    }
    await flushFlight(t, 1500);
  };
  const until = async (test: () => boolean) => {
    for (let i = 0; i < 36 && !test(); i++) await step();
    assert.ok(test(), reports.slice(-28).join("\n") + " " + events.slice(-24).join(" "));
  };
  await until(() =>
    [1, 2].every((id) => hostedReports.get(id)?.phase === "Retrying native observation"),
  );
  assert.match(hostedReports.get(1)?.why ?? "", /gateway timed out/);
  assert.match(hostedReports.get(2)?.why ?? "", /4 request lanes/);
  const dogmaRequests = () =>
    miners.map((m) => m.requests.filter((p) => p === "/api/types/dogma").length);
  assert.deepEqual(dogmaRequests(), [1, 1]);
  assert.ok(
    [1, 2].every(
      (id) => group.entries.get(id)?.failed === null && hostedReports.get(id)?.status === "paused",
    ),
  );
  await step();
  assert.deepEqual(dogmaRequests(), [1, 1]);
  await until(() =>
    miners.every((m) => m.active.size === 2 && m.out.get(701)?.activity === "mining"),
  );
  assert.deepEqual(dogmaRequests(), [2, 2]);
  assert.ok([1, 2].every((id) => hostedReports.get(id)?.status === "running"));
  rat = { id: 90, x: 30000 };
  for (const m of miners) m.threat(30000);
  // The gun range fails once while the rest of the pilot's combat remains available.
  await until(() => defenderReadFailures === 1);
  assert.equal(group.entries.get(3)?.failed, null);
  const independentGain = miners[0]!.laserYield();
  await until(() => miners[0]!.freight() === independentGain);
  await until(
    () =>
      defenders.every((d) => d.park.stateByDroneID.get(d.droneID)?.targetID === 90) &&
      defenders[0]!.active.get(52) === 90,
  );
  assert.equal(hostedReports.get(3)?.status, "running");
  assert.equal(group.op.snapshot().stopRequested, undefined);
  assert.ok(defenders.every((d) => positions.get(d.shipID)! > 20000));
  assert.deepEqual(
    events.filter((e) => e === "lock:3:90"),
    ["lock:3:90", "lock:3:90"],
  );
  assert.equal(unrelatedFleetReads, 0);
  assert.ok(events.indexOf("drone-refused:4:90") < events.indexOf("engage:4:90"));
  assert.deepEqual(
    [...defenders[0]!.active],
    [
      [51, 999],
      [52, 90],
    ],
  );
  const weaponsKey = storage
    .documentNames("mining-fleet-defender-actions:")
    .find((key) => key.includes('"escort-3"'));
  assert.ok(weaponsKey);
  const weapons = document(weaponsKey).read() as {
    entries: { action: { moduleID: number }; status: string }[];
  };
  assert.deepEqual(
    weapons.entries.map((row) => [row.action.moduleID, row.status]),
    [
      [51, "REFUSED"],
      [52, "CONFIRMED"],
    ],
  );
  // Farmer projects the combat activity and target from the native drone state.
  for (const d of defenders) assert.equal(d.park.stateByDroneID.get(d.droneID)?.activityState, 1);
  const gains = miners.map((m) => m.laserYield());
  health = 0.7;
  await step();
  assert.deepEqual(
    miners.map((m) => m.freight()),
    gains,
  );
  assert.ok(defenders.every((d) => d.park.stateByDroneID.get(d.droneID)?.targetID === 90));
  assert.ok(
    miners.every(
      (m) =>
        m.active.size === 2 &&
        m.locked.has(777) &&
        m.writes.filter((w) => w.method === "Activate").length === 2,
    ),
  );

  rat = null;
  for (const d of defenders) d.locked.clear();
  for (const m of miners) m.threat(null);
  positions.set(11, 11000);
  positions.set(12, 12000);
  await until(
    () =>
      defenders.every(
        (d) => d.isDeployed() && Math.abs(positions.get(d.shipID)! - 12000) <= 5020,
      ) && miners.every((m) => m.out.get(701)?.activity === "mining"),
  );
  assert.ok(events.includes("follow:3:12:5000"));
  assert.ok(events.includes("follow:4:12:5000"));
  assert.equal(
    events.some((e) => e.startsWith("recall:")),
    false,
  );
  rat = { id: 91, x: 36000 };
  health = 1;
  for (const m of miners) m.threat(36000);
  await until(() => defenders.every((d) => d.park.stateByDroneID.get(d.droneID)?.targetID === 91));
  assert.deepEqual(
    miners.map((m) => m.active.size),
    [2, 2],
  );
  const followCount = events.filter((e) => e.startsWith("follow:")).length;
  assert.equal(
    runtime.requestOperationStop(
      { operationID: groupSetup.operationID, operationRunID: groupSetup.operationRunID },
      "RETURN_HOME",
    )?.mode,
    "RETURN_HOME",
  );
  await until(() => group.op.snapshot().state === "STOPPED");
  assert.ok(defenders.every((d) => !d.isDeployed() && d.active.size === 0));
  assert.ok(miners.every((m) => m.active.size === 0 && m.out.size === 0));
  assert.deepEqual([...parked].sort(), [1, 2, 3, 4]);
  assert.equal(events.filter((e) => e.startsWith("follow:")).length, followCount);
});
