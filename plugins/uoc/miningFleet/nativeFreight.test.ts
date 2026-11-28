import { memoryFleetDocuments, memoryOperationStore } from "./operationStoreFixture.ts";
import { officeList, corporationRow } from "./corporateOfficeFixture.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createNativeHauler,
  HAULER_OWN_DEPOSIT_PREFIX,
  waitForHaulerDockSettlement,
} from "./nativeHauler.ts";
import { createNativeRawObserver } from "./nativeMiner.ts";
import { createNativeBeltNavigation } from "./nativeBelt.ts";
import {
  createRawMembers,
  FreightGridUnavailable,
  HaulStoppedBeforePickup,
} from "./memberLoops.ts";
import { createOperation, haulOwner, type Manifest } from "./operation.ts";
import { fleetOperationStore, fleetRunResult, summarizeFleetRun } from "./operationStore.ts";
import { deleteFleetExecution } from "./executionDocuments.ts";
import { fleetHaulDocumentKey } from "./runtime.ts";
import { createTargetBoard } from "./targetBoard.ts";
import { unloadParkingFreight } from "./parkingUnload.ts";
import { UnconfirmedHaulerUnload } from "./dockedRawDeposit.ts";
import { FleetObservationUnavailable } from "./stopSignal.ts";
const loc = { x: 0, y: 0, z: 0 };
const list = (rows: unknown[]) => ({
  type: "list",
  items: rows.map((fields) => ({ type: "packedrow", fields })),
});
const ore = {
  itemID: 20,
  typeID: 30,
  ownerID: 1,
  locationID: 100,
  flagID: 0,
  quantity: 10,
  categoryID: 25,
};
const item = { itemID: 20, typeID: 30, quantity: 10, freightKind: "RAW" as const, unitVolumeM3: 1 };
const manifest = {
  source: "native-jetcan" as const,
  operationID: "op",
  runID: "run",
  targetKey: "belt",
  claimGeneration: 1,
  characterID: 1,
  shipID: 11,
  systemID: 300,
  containerID: 100,
  intentGeneration: 1,
  observedAt: 1,
  items: [item],
  capacityM3: 100,
  category: "RAW" as const,
  volumeM3: 10,
  delivered: false,
};
const claim = {
  key: "belt",
  operationID: "op",
  runID: "run",
  generation: 1,
  expiresAt: 9999999999999,
};
const target = { kind: "BELT" as const, systemID: 300, name: "belt" };
type FreightWorld = { source: (typeof ore)[]; corp: (typeof ore)[] };
function simulator(
  characterID: number,
  shipID: number,
  world: FreightWorld = { source: [{ ...ore }], corp: [] },
) {
  const { source, corp } = world;
  let canX = 100,
    docked = false,
    held: any[] = [],
    removedReadFails = false,
    keepCanVisible = false,
    lagSamples = 0,
    deliveryLost = false,
    pickupLost = false,
    jumped = false,
    sample = 1000,
    cargoCapacity = 100,
    oreCapacity = 0,
    fleetCapacity = 0,
    iceCapacity = 0,
    asteroidCapacity = 0,
    raw = true,
    family = "ore",
    volume = 1,
    docValue: unknown = null,
    mergeHeld = false,
    splitPickup = false,
    multiAddLimit = Infinity,
    readsLostAfterPickup = 0,
    sourceReadFailures = 0;
  let personal = false,
    division = 1,
    depositLimit = Infinity,
    readsLostAfterDeposit = 0,
    depositReadFailures = 0;
  const calls: unknown[] = [],
    routes: number[] = [],
    reads: { method: string; of: number; docked: boolean }[] = [];
  const used = (flag: number) =>
    held
      .filter((x) => x.flagID === flag)
      .reduce((n, x) => n + x.quantity * (x.typeID === 31 ? 0.1 : volume), 0);
  const snapshot = () => ({
    inSpace: true,
    solarSystemID: 300,
    shipID,
    sampledAtMs: ++sample,
    ship: {
      itemID: shipID,
      characterID,
      mode: "STOP",
      position: jumped && !source.length ? { x: 10000, y: 0, z: 0 } : loc,
      radius: 10,
    },
    entities: [
      ...new Set([
        ...source.map((r) => r.locationID),
        ...(keepCanVisible || lagSamples-- > 0 ? [100] : []),
      ]),
    ].map((id) => ({
      kind: "container",
      itemID: id,
      ownerID: source.find((r) => r.locationID === id)?.ownerID ?? 1,
      typeID: 23,
      position: { x: canX, y: 0, z: 0 },
      radius: 10,
    })),
  });
  const flow: any = {
    requestOptions: () => ({}),
    startRoute: async (id: number) => {
      routes.push(id);
      docked = true;
      return { started: true };
    },
    flying: {
      sessionGeneration: () => 1,
      isSessionClosing: () => false,
      autopilotProgress: () => ({ status: "arrived" }),
      abortAutopilot() {},
      dockStep: async () => {},
      readFlightNow: async () => ({ inSpace: !docked, shipID }),
      approachShip: async () => {
        canX = 100;
      },
      bridgeAsk: async (
        service: string,
        method: string,
        _args: unknown,
        kwargs: any,
        of: number | string,
      ) => {
        if (service === "corpRegistry")
          return corporationRow(method, characterID, 77, 1048576n << BigInt(division - 1));
        if (service === "officeManager")
          return { list: [{ fields: { stationID: 600, officeID: 700 } }] };
        if (service !== "invbroker" || method !== "List") throw Error("unexpected read");
        if (of === (personal ? "hangar" : 700)) return list(corp);
        if (of === shipID) return list(held.filter((r) => r.flagID === kwargs?.flag));
        if (sourceReadFailures > 0) {
          sourceReadFailures--;
          throw Object.assign(Error("Can read timed out"), { code: "CALL_TIMEOUT" });
        }
        return list(source.filter((r) => r.locationID === of));
      },
      bridgeDo: async (
        service: string,
        method: string,
        args: any[],
        kwargs: any,
        of: number | string,
      ) => {
        calls.push({ service, method, args, kwargs, of });
        if (service === "invCache") return null;
        if (service === "ship" && method === "Undock") {
          docked = false;
          return null;
        }
        if (
          service === "invbroker" &&
          (method === "Add" || method === "MultiAdd") &&
          of === shipID
        ) {
          for (const id of method === "MultiAdd" ? args[0].slice(0, multiAddLimit) : [args[0]]) {
            const row = source.find((r) => r.itemID === id && r.locationID === args[1]),
              qty = method === "MultiAdd" ? row?.quantity : kwargs.qty;
            if (!row || !qty || qty > row.quantity) throw Error("missing source");
            const combined =
              mergeHeld && held.find((r) => r.typeID === row.typeID && r.flagID === kwargs.flag);
            if (splitPickup && qty > 1) {
              splitPickup = false;
              const base = {
                ...row,
                ownerID: characterID,
                locationID: shipID,
                flagID: kwargs.flag,
              };
              held.push(
                { ...base, itemID: row.itemID, quantity: 1 },
                { ...base, itemID: row.itemID + 100000, quantity: qty - 1 },
              );
            } else if (combined) combined.quantity += qty;
            else
              held.push({
                ...row,
                itemID: qty === row.quantity ? row.itemID : row.itemID + sample,
                quantity: qty,
                ownerID: characterID,
                locationID: shipID,
                flagID: kwargs.flag,
              });
            row.quantity -= qty;
            if (!row.quantity) source.splice(source.indexOf(row), 1);
          }
          if (readsLostAfterPickup) {
            sourceReadFailures = readsLostAfterPickup;
            readsLostAfterPickup = 0;
          }
          if (pickupLost) throw Error("pickup acknowledgement lost");
          return null;
        }
        if (
          service === "invbroker" &&
          (method === "Add" || method === "MultiAdd") &&
          of === (personal ? "hangar" : 700)
        ) {
          assert.equal(kwargs.flag, personal ? 4 : 114 + division);
          assert.equal(args[1], shipID);
          for (const id of method === "MultiAdd" ? args[0].slice(0, depositLimit) : [args[0]]) {
            const row = held.find((r) => r.itemID === id),
              qty = method === "MultiAdd" ? row?.quantity : kwargs.qty;
            if (!row || !qty || qty > row.quantity) throw Error("missing ship cargo");
            const prior = corp.find((x) => x.typeID === row.typeID);
            if (prior) prior.quantity += qty;
            else
              corp.push({
                ...row,
                quantity: qty,
                ownerID: personal ? characterID : 77,
                locationID: personal ? 600 : 700,
                flagID: kwargs.flag,
              });
            row.quantity -= qty;
            if (!row.quantity) held = held.filter((r) => r !== row);
          }
          depositLimit = Infinity;
          if (readsLostAfterDeposit) {
            depositReadFailures = readsLostAfterDeposit;
            readsLostAfterDeposit = 0;
          }
          if (deliveryLost) throw Error("delivery acknowledgement lost");
          return null;
        }
        throw Error("unexpected write");
      },
    },
  };
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    let body: unknown;
    if (path === "/api/bridge/corp-offices") body = officeList();
    else if (path === "/api/client-data/dogma-types")
      body = {
        available: true,
        types: {
          23: { attributes: [[38, 27500]] },
          30: { categoryID: 25 },
          31: { categoryID: 25 },
          32: { categoryID: 25 },
        },
      };
    else if (path === "/api/mining-operations/resources")
      body = {
        resources: [
          { typeID: raw ? 30 : 31, family, name: "resource" },
          { typeID: 32, family, name: "other ore" },
        ],
      };
    else if (path === "/api/types/compressed")
      body = { compressedTypeIDs: { 31: 30, 30: 31 }, capped: false };
    else if (path === "/api/types/volumes")
      body = { volumes: { 30: volume, 31: 0.1, 32: volume }, capped: false };
    else if (path === "/api/bridge/ship/ore-hold")
      body = {
        activeShipID: shipID,
        holds: [
          {
            key: "ore",
            present: oreCapacity > 0,
            error: null,
            capacity: { capacity: oreCapacity, used: used(134) },
          },
          {
            key: "cargo",
            present: true,
            error: null,
            capacity: { capacity: cargoCapacity, used: used(5) },
          },
        ],
      };
    else if (path === `/api/bridge/ship/${shipID}/bays`) {
      const keys = new URL(String(input)).searchParams.get("keys")!.split(",");
      const bays = [
        ["ore", 134, oreCapacity],
        ["cargo", 5, cargoCapacity],
        ["fleet", 155, fleetCapacity],
        ["ice", 181, iceCapacity],
        ["asteroid", 182, asteroidCapacity],
        ["gas", 135, 0],
      ] as const;
      body = {
        activeShipID: shipID,
        shipID,
        bays: bays
          .filter(([key]) => keys.includes(key))
          .map(([key, flag, capacity]) => ({
            key,
            present: capacity > 0,
            error: null,
            capacity: { capacity, used: used(flag) },
            items: capacity > 0 ? held.filter((row) => row.flagID === flag) : null,
          })),
      };
    } else if (path === "/api/bridge/space/snapshot") body = { space: snapshot() };
    else if (path === "/api/bridge/flight/status")
      body = {
        flight: {
          inSpace: !docked,
          docked,
          solarSystemID: 300,
          stationID: docked ? 600 : null,
          shipID,
          shipMode: "STOP",
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
    else throw Error(`unexpected ${path}`);
    return new Response(JSON.stringify({ ok: true, ...(body as object) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const ask = flow.flying.bridgeAsk;
  flow.flying.bridgeAsk = async (...args: any[]) => {
    const [, method, , , of] = args;
    reads.push({ method, of, docked });
    if (docked && method === "List" && depositReadFailures > 0) {
      depositReadFailures--;
      throw Object.assign(Error("Deposit inventory unavailable"), { status: 502 });
    }
    assert.notEqual(method, "ListByFlags", "WC rejects invbroker.ListByFlags on a named inventory");
    if (removedReadFails && method === "List" && of === 100 && !source.length)
      throw Error("container removed");
    return ask(...(args as [string, string, unknown, any, number]));
  };
  const run: any = { characterID, baseUrl: "http://bff", fetch: fetcher },
    session: any = {
      flow,
      store: { station: { get: () => ({ online: { characterID, corporationID: 77 } }) } },
    };
  return {
    run,
    session,
    calls,
    routes,
    reads,
    getSource: () => structuredClone(source),
    setDivision: (n: number) => {
      division = n;
    },
    getDivision: () => division,
    setPersonal: () => {
      personal = true;
    },
    isPersonal: () => personal,
    limitDeposit: (n: number) => {
      depositLimit = n;
    },
    loseDepositReads: (n: number) => {
      readsLostAfterDeposit = n;
    },
    failAfterPickup: (count: number) => {
      readsLostAfterPickup = count;
    },
    mergeCargo: () => {
      mergeHeld = true;
    },
    splitNextPickup: () => {
      splitPickup = true;
    },
    limitMultiAdd: (n: number) => {
      multiAddLimit = n;
    },
    tripDocument: () => ({
      read: () => docValue,
      write: (v: unknown) => {
        docValue = structuredClone(v);
      },
    }),
    setCanDistance: (x: number) => {
      canX = x;
    },
    setSource: (x: (typeof ore)[]) => {
      source.splice(0, source.length, ...x);
    },
    setHeld: (x: any[]) => {
      held = x;
    },
    getHeld: () => structuredClone(held),
    setInSpace: () => {
      docked = false;
    },
    setDocked: () => {
      docked = true;
    },
    setRemovedReadFails: () => {
      removedReadFails = true;
    },
    setKeepCanVisible: () => {
      keepCanVisible = true;
    },
    setVisibilityLag: (n: number) => {
      lagSamples = n;
    },
    setPostPickupJump: () => {
      jumped = true;
    },
    getDoc: () => docValue,
    setDeliveryLost: () => {
      deliveryLost = true;
    },
    clearDeliveryLost: () => {
      deliveryLost = false;
    },
    setPickupLost: () => {
      pickupLost = true;
    },
    setCapacities: (cargo: number, ore: number, fleet = 0, ice = 0, asteroid = 0) => {
      cargoCapacity = cargo;
      oreCapacity = ore;
      fleetCapacity = fleet;
      iceCapacity = ice;
      asteroidCapacity = asteroid;
    },
    setRaw: (value: boolean) => {
      raw = value;
    },
    setFamily: (v: string, n: number) => {
      family = v;
      volume = n;
    },
    getCorp: () => corp,
  };
}
for (const [family, preferred] of [
  ["ore", 182],
  ["ice", 181],
] as const) {
  test(
    family + " uses its specialized hold before the general mining hold or fleet hangar",
    async () => {
      const sim = simulator(3, 13);
      sim.setFamily(family, 1);
      sim.setCapacities(10, 10, 10, 10, 10);
      const site =
        family === "ice"
          ? {
              kind: "ICE" as const,
              systemID: 300,
              name: "ice",
              siteID: 55,
              instanceID: 89,
              position: loc,
            }
          : target;
      const key = family === "ice" ? "ICE:300:site:55:instance:89" : claim.key;
      const freight = { ...manifest, targetKey: key };
      const native = createNativeHauler(sim.run, sim.session, {
        shipID: 13,
        corporationID: 77,
        division: 1,
        current() {},
        tripDocument: sim.tripDocument,
      });
      await native.navigateAndVerify(freight, site, { ...claim, key });
      const receipt = await native.transferAndDeliver(freight, 2, 600);
      assert.equal(receipt.destinationAfter[0]?.quantity, 10);
      assert.deepEqual(
        sim.calls
          .filter((c: any) => c.method === "Add" && c.of === 13)
          .map((c: any) => c.kwargs.flag),
        [preferred],
      );
    },
  );
}

test("an absent fleet hangar and a panel for another ship cannot authorize a pickup", async () => {
  const sim = simulator(3, 13),
    native = createNativeHauler(sim.run, sim.session, {
      shipID: 13,
      corporationID: 77,
      division: 1,
      current() {},
      tripDocument: sim.tripDocument,
    });
  sim.setCapacities(1, 0, 0);
  sim.setHeld([
    {
      ...ore,
      itemID: 81,
      typeID: 800,
      categoryID: 7,
      flagID: 5,
      quantity: 1,
      ownerID: 3,
      locationID: 13,
    },
  ]);
  await assert.rejects(native.navigateAndVerify(manifest, target, claim), /capacity/);
  sim.setCapacities(1, 0, 100);
  const fetch = sim.run.fetch;
  sim.run.fetch = async (input: URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (!new URL(String(input)).pathname.endsWith("/bays")) return response;
    return Response.json({ ...(await response.json()), activeShipID: 14 });
  };
  await assert.rejects(native.navigateAndVerify(manifest, target, claim), /unreadable/);
  assert.equal(
    sim.calls.some((c: any) => c.method === "Add" || c.method === "MultiAdd"),
    false,
  );
});

test("full cargo and mining hold leave a verified fleet hangar available for a new trip", async () => {
  const sim = simulator(3, 13);
  const equipment = {
    ...ore,
    itemID: 70,
    typeID: 800,
    categoryID: 7,
    ownerID: 3,
    locationID: 13,
    flagID: 5,
    quantity: 1,
  };
  const carried = { ...ore, itemID: 80, ownerID: 3, locationID: 13, flagID: 134, quantity: 50 };
  sim.setHeld([equipment, carried]);
  sim.setCapacities(1, 50, 10);
  const h = batchedHaul(sim, [ore], 1);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(
    sim.calls
      .filter((c: any) => c.of === 13 && ["Add", "MultiAdd"].includes(c.method))
      .map((c: any) => c.kwargs.flag),
    [155],
  );
  assert.equal(h.totals()?.deliveredUnits, 60);
  assert.equal(h.receipts()[0]?.deliveryBatches?.[0]?.item.quantity, 10);
  assert.deepEqual(sim.getHeld(), [equipment]);
});

test("a lost unload reply for merged fleet-hangar ore recovers 60 delivered units once", async () => {
  const sim = simulator(3, 13);
  const equipment = {
    ...ore,
    itemID: 71,
    typeID: 800,
    categoryID: 7,
    ownerID: 3,
    locationID: 13,
    flagID: 5,
    quantity: 1,
  };
  sim.setHeld([
    equipment,
    { ...ore, itemID: 80, ownerID: 3, locationID: 13, flagID: 155, quantity: 50 },
  ]);
  sim.setCapacities(1, 0, 60);
  sim.mergeCargo();
  const h = batchedHaul(sim, [ore], 1);
  sim.setDeliveryLost();
  sim.loseDepositReads(2);
  await assert.rejects(h.haul(), /Deposit inventory unavailable/);
  assert.deepEqual(sim.getHeld(), [equipment]);
  assert.equal(sim.getCorp()[0]?.quantity, 60);
  sim.clearDeliveryLost();
  h.restart();
  assert.equal(await h.haul(), "delivered");
  h.restart();
  assert.equal(h.totals()?.deliveredUnits, 60);
  assert.equal(h.totals()?.trips, 1);
  assert.equal(h.state().manifests[0]?.items[0]?.quantity, 10);
  assert.equal(
    sim.calls.filter((c: any) => c.of === 700 && ["Add", "MultiAdd"].includes(c.method)).length,
    1,
  );
});

test("a relocated item labelled flag 155 on a hull without a fleet hangar cannot be unloaded", async () => {
  const sim = simulator(3, 13);
  sim.setSource([]);
  sim.setHeld([{ ...ore, ownerID: 3, locationID: 13, flagID: 155 }]);
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
  });
  await assert.rejects(native.recoverHeldAndDeliver(manifest, 2, 600), /source stack|not proven/);
  assert.equal(
    sim.calls.some((c: any) => c.method === "Add" || c.method === "MultiAdd"),
    false,
  );
});

test("native hauler transfers exact published can into cargo then selected corporation division", async () => {
  const sim = simulator(3, 13);
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  const result = await native.transferAndDeliver(manifest, 2, 600);
  assert.equal(result.destinationAfter[0]?.quantity, 10);
  assert.equal(sim.getCorp()[0]?.ownerID, 77);
  const writes = sim.calls.filter((x: any) => x.method === "Add") as any[];
  assert.deepEqual(
    writes.map((x) => [x.of, x.args, x.kwargs]),
    [
      [13, [20, 100], { qty: 10, flag: 5 }],
      [700, [20, 13], { qty: 10, flag: 115 }],
    ],
  );
});
test("docked transition waits through ten seconds and missing reads without claiming success", async () => {
  let time = 0,
    reads = 0;
  const pending = { docked: true, stationID: 600, transition: { phase: "session-changing" } };
  const result = await waitForHaulerDockSettlement(
    pending,
    600,
    async () => {
      reads++;
      return reads === 2
        ? null
        : reads < 11
          ? pending
          : { ...pending, transition: { phase: "ready" } };
    },
    {
      timeoutMs: 90000,
      pollMs: 1000,
      now: () => time,
      wait: async (n) => {
        time += n;
      },
    },
  );
  assert.equal(time, 11000);
  assert.equal(result.transition.phase, "ready");
});
test("docked transition rejects a wrong destination and times out unknown", async () => {
  const pending = { docked: true, stationID: 600, transition: { phase: "accepted" } };
  await assert.rejects(
    waitForHaulerDockSettlement({ ...pending, stationID: 601 }, 600, async () => pending, {
      timeoutMs: 10,
      pollMs: 1,
    }),
    /identity/,
  );
  let time = 0;
  await assert.rejects(
    waitForHaulerDockSettlement(pending, 600, async () => null, {
      timeoutMs: 10,
      pollMs: 5,
      now: () => time,
      wait: async (n) => {
        time += n;
      },
    }),
    /remains unknown/,
  );
});
test("relocated delivery waits for destination transition before the sole deposit", async () => {
  const sim = simulator(3, 13);
  sim.setSource([]);
  sim.setHeld([{ ...ore, ownerID: 3, locationID: 13, flagID: 134 }]);
  let pendingReads = 0;
  const fetch = sim.run.fetch;
  sim.run.fetch = async (input: unknown, init: unknown) => {
    const response = await fetch(input, init);
    if (new URL(String(input)).pathname !== "/api/bridge/flight/status") return response;
    const body = await response.json();
    if (body.flight.docked && pendingReads++ < 3) {
      assert.equal(
        sim.calls.some((x: any) => x.method === "Add"),
        false,
      );
      body.flight.transition.phase = "session-changing";
    }
    return Response.json(body);
  };
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.recoverHeldAndDeliver(manifest, 2, 600);
  assert.ok(pendingReads >= 4);
  assert.equal(sim.calls.filter((x: any) => x.method === "Add").length, 1);
});
test("a ship change during dock settlement blocks deposit", async () => {
  const sim = simulator(3, 13);
  sim.setSource([]);
  sim.setHeld([{ ...ore, ownerID: 3, locationID: 13, flagID: 134 }]);
  let reads = 0;
  const fetch = sim.run.fetch;
  sim.run.fetch = async (input: unknown, init: unknown) => {
    const response = await fetch(input, init);
    if (new URL(String(input)).pathname !== "/api/bridge/flight/status") return response;
    const body = await response.json();
    if (body.flight.docked) {
      reads++;
      body.flight.transition.phase = "session-changing";
      if (reads > 1) body.flight.shipID = 14;
    }
    return Response.json(body);
  };
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await assert.rejects(native.recoverHeldAndDeliver(manifest, 2, 600), /ship changed/);
  assert.equal(
    sim.calls.some((x: any) => x.method === "Add"),
    false,
  );
});
test("Miasmos-sized ore bay loads more than ordinary cargo and delivers from flag 134", async () => {
  const sim = simulator(3, 13);
  sim.setCapacities(550, 66000);
  sim.setSource([{ ...ore, quantity: 1000 }]);
  const m = {
    ...manifest,
    items: [{ ...item, quantity: 1000 }],
    volumeM3: 1000,
    capacityM3: 66000,
  };
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(m, target, claim);
  const proof = await native.transferAndDeliver(m, 2, 600);
  assert.equal(proof.destinationAfter[0]?.quantity, 1000);
  const writes = sim.calls.filter((x: any) => x.method === "Add") as any[];
  assert.deepEqual(
    writes.map((x) => [x.of, x.kwargs.flag, x.kwargs.qty]),
    [
      [13, 134, 1000],
      [700, 115, 1000],
    ],
  );
});
test("partial ore pickups retain claim through two checked delivery trips", async () => {
  const sim = simulator(3, 13);
  sim.setCapacities(2, 6);
  let releases = 0;
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    afterPickup: async () => {
      releases++;
    },
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  const proof = await native.transferAndDeliver(manifest, 2, 600);
  assert.equal(proof.destinationAfter[0]?.quantity, 10);
  assert.deepEqual(
    proof.deliveryBatches?.map((b) => b.item.quantity),
    [6, 4],
  );
  assert.deepEqual(
    proof.deliveryBatches?.map((b) => [
      b.destinationBefore.reduce((n, r) => n + r.quantity, 0),
      b.destinationAfter.reduce((n, r) => n + r.quantity, 0),
    ]),
    [
      [0, 6],
      [6, 10],
    ],
  );
  assert.equal(releases, 1);
  const writes = sim.calls.filter((x: any) => x.method === "Add") as any[];
  assert.deepEqual(
    writes.map((x) => [x.of, x.kwargs.flag, x.kwargs.qty]),
    [
      [13, 134, 6],
      [700, 115, 6],
      [13, 134, 4],
      [700, 115, 4],
    ],
  );
});
test("Return Home finishes an issued partial load without picking up the rest of its can", async () => {
  const sim = simulator(3, 13);
  sim.setCapacities(2, 6);
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    stopBeforePickup: () => sim.getCorp().length > 0,
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  await assert.rejects(native.transferAndDeliver(manifest, 2, 600), HaulStoppedBeforePickup);
  assert.equal(sim.getCorp()[0]?.quantity, 6);
  assert.deepEqual(
    sim.calls.filter((x: any) => x.method === "Add").map((x: any) => x.of),
    [13, 700],
  );
  assert.equal((sim.getDoc() as any).pending, null);
  assert.deepEqual(
    (sim.getDoc() as any).events.map((e: any) => e.kind),
    ["pickup", "delivery"],
  );
});
test("unknown or unsupported resource is refused before pickup", async () => {
  const sim = simulator(3, 13);
  sim.setCapacities(550, 66000);
  sim.setRaw(false);
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await assert.rejects(native.navigateAndVerify(manifest, target, claim), /not verified raw ore/);
  assert.equal(
    sim.calls.some((x: any) => x.method === "Add"),
    false,
  );
});
test("removed empty jetcan is proved by fresh grid absence and exact cargo", async () => {
  const sim = simulator(3, 13);
  sim.setRemovedReadFails();
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  const result = await native.transferAndDeliver(manifest, 2, 600);
  assert.equal(result.destinationAfter[0]?.quantity, 10);
});
test("unreadable jetcan still visible on grid remains unresolved", async () => {
  const sim = simulator(3, 13);
  sim.setRemovedReadFails();
  sim.setKeepCanVisible();
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  await assert.rejects(native.transferAndDeliver(manifest, 2, 600), /container removed/);
  assert.equal(sim.getCorp().length, 0);
});
test("hauler refuses a claimed can whose contents differ before any inventory move", async () => {
  const sim = simulator(3, 13);
  sim.setSource([{ ...ore, quantity: 9 }]);
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await assert.rejects(native.navigateAndVerify(manifest, target, claim), /differs/);
  assert.equal(
    sim.calls.some((x: any) => x.method === "Add"),
    false,
  );
});
test("native miner reads holds and verifies a newly owned can and exact source removal", async () => {
  const sim = simulator(1, 11);
  sim.setSource([]);
  sim.setHeld([{ ...ore, locationID: 11, flagID: 5 }]);
  const obs = createNativeRawObserver(sim.run, sim.session, {
    shipID: 11,
    current() {},
    assertAtTarget: async () => {},
    typeFacts: async () => ({ 30: { categoryID: 25, freightKind: "RAW", unitVolumeM3: 1 } }),
    capacityM3: 100,
    pollMs: 1,
  });
  const before = await obs.observeHolds(target, claim);
  assert.equal(before.items.length, 1);
  sim.setHeld([]);
  sim.setSource([{ ...ore }]);
  const can = await obs.observeCreatedCan(before, target, claim);
  assert.equal(can.containerID, 100);
  assert.equal(can.sourceAfter.items.length, 0);
});

test("miner refuses compressed cargo before jettison", async () => {
  const sim = simulator(1, 11);
  sim.setSource([]);
  sim.setHeld([{ ...ore, locationID: 11, flagID: 5 }]);
  const obs = createNativeRawObserver(sim.run, sim.session, {
    shipID: 11,
    current() {},
    assertAtTarget: async () => {},
    typeFacts: async () => ({ 30: { categoryID: 25, freightKind: "COMPRESSED", unitVolumeM3: 1 } }),
    capacityM3: 100,
  });
  await assert.rejects(obs.observeHolds(target, claim), /Only verified raw/);
});
test("miner refuses a newly seen can with different physical contents", async () => {
  const sim = simulator(1, 11);
  sim.setSource([]);
  sim.setHeld([{ ...ore, locationID: 11, flagID: 5 }]);
  const obs = createNativeRawObserver(sim.run, sim.session, {
    shipID: 11,
    current() {},
    assertAtTarget: async () => {},
    typeFacts: async () => ({ 30: { categoryID: 25, freightKind: "RAW", unitVolumeM3: 1 } }),
    capacityM3: 100,
    pollMs: 1,
  });
  const before = await obs.observeHolds(target, claim);
  sim.setHeld([]);
  sim.setSource([{ ...ore, quantity: 9 }]);
  await assert.rejects(obs.observeCreatedCan(before, target, claim), /content is uncertain/);
});
for (const [name, capacity, batches] of [
  [
    "single-can collection delivers 50 carry-in plus 10 collected units and credits the can with 10",
    60,
    [10],
  ],
  ["two single-can trips unload the carry-in once and credit the remaining four units", 56, [6, 4]],
] as const) {
  test(name, async () => {
    const sim = simulator(3, 13),
      stock = { ...ore, itemID: 22, ownerID: 3, locationID: 13, flagID: 5, quantity: 50 };
    sim.mergeCargo();
    const equipment = { ...stock, itemID: 70, typeID: 800, categoryID: 7, quantity: 1 };
    const outsideHaulerHolds = { ...stock, itemID: 71, flagID: 135, quantity: 2 };
    sim.setHeld([{ ...stock }, equipment, outsideHaulerHolds]);
    sim.setCapacities(capacity + 1, 0);
    const fleet = batchedHaul(sim, [ore], 1),
      can = fleet.state().manifests[0]!;
    const haul = fleet.op().claimContainer(3, can.containerID);
    assert.ok(haul);
    const native = createNativeHauler(sim.run, sim.session, {
      shipID: 13,
      corporationID: 77,
      division: 1,
      current() {},
      tripDocument: fleet.tripDocument,
      pollMs: 1,
    });
    await native.navigateAndVerify(can, target, fleet.claim);
    assert.ok(fleet.op().dispatchHaul(3, can.containerID, haul.generation));
    const result = await native.transferAndDeliver(can, haul.generation, 600);
    assert.deepEqual(
      result.deliveryBatches?.map((b) => b.item.quantity),
      batches,
    );
    assert.deepEqual(sim.getHeld(), [equipment, outsideHaulerHolds]);
    assert.deepEqual(sim.getCorp(), [
      { ...stock, ownerID: 77, locationID: 700, flagID: 115, quantity: 60 },
    ]);
    assert.ok(fleet.op().markDelivered(3, result));
    assert.deepEqual(fleet.receipts()[0]?.sourceProof?.kind, "native-batches");
    assert.deepEqual(
      fleet.state().manifests[0]?.items.map((i) => i.quantity),
      [10],
    );
    assert.equal(fleet.totals()?.deliveredUnits, 60);
    assert.equal(fleet.totals()?.trips, batches.length);
    fleet.restart();
    assert.equal(fleet.totals()?.deliveredUnits, 60);
  });
}

for (const change of ["unrelated module", "extra ore", "two receiving ore stacks"] as const) {
  test("a retained partial-stack transfer reconciles after a lost reply: " + change, async () => {
    const sim = simulator(3, 13);
    sim.mergeCargo();
    sim.setHeld([{ ...ore, itemID: 22, ownerID: 3, locationID: 13, flagID: 5, quantity: 50 }]);
    sim.setDeliveryLost();
    const native = createNativeHauler(sim.run, sim.session, {
      shipID: 13,
      corporationID: 77,
      division: 1,
      current() {},
      tripDocument: sim.tripDocument,
      pollMs: 1,
    });
    await native.navigateAndVerify(manifest, target, claim);
    // Command collection also produces the partial receipts written by earlier Haulers.
    await assert.rejects(
      native.transferAndDeliver(manifest, 2, 600, "COMMAND"),
      /delivery acknowledgement lost/,
    );
    const pending = structuredClone(sim.getDoc());
    sim.clearDeliveryLost();

    const division = sim.getCorp(),
      delivered = division[0]!;
    assert.equal(delivered.quantity, 10);
    if (change === "two receiving ore stacks") delivered.quantity -= 1;
    division.push({
      ...delivered,
      itemID: 80,
      quantity: 1,
      ...(change === "unrelated module" ? { typeID: 800, categoryID: 7 } : {}),
    });
    const reconcile = () => native.reconcileReturnHome(manifest, 2, 600);
    if (change === "unrelated module") {
      await reconcile();
      await reconcile();
      const journal = sim.getDoc() as {
        pending: unknown;
        events: { kind: string; before: { item?: unknown } }[];
      };
      assert.equal(journal.pending, null);
      assert.deepEqual(
        journal.events.filter((e) => e.kind === "delivery").map((e) => e.before.item),
        [{ itemID: 22, typeID: 30, quantity: 10 }],
      );
    } else {
      await assert.rejects(reconcile(), /unknown; no replay/);
      await assert.rejects(reconcile(), /unknown; no replay/);
      assert.deepEqual(sim.getDoc(), pending);
    }
    const unloads = sim.calls.filter(
      (c: any) => c.of === 700 && ["Add", "MultiAdd"].includes(c.method),
    );
    assert.deepEqual(
      unloads.map((c: any) => [c.method, c.args, c.kwargs.qty]),
      [["Add", [22, 13], 10]],
    );
    assert.equal(sim.getHeld()[0]?.quantity, 50);
  });
}

for (const change of ["module", "same ore"] as const) {
  test(
    "a whole Hauler unload reconciles 60 units after timeout with concurrent " + change,
    async () => {
      const sim = simulator(3, 13),
        prior = { ...ore, itemID: 80, ownerID: 77, locationID: 700, flagID: 115, quantity: 100 };
      sim.mergeCargo();
      sim.getCorp().push({ ...prior });
      sim.setHeld([{ ...ore, itemID: 22, ownerID: 3, locationID: 13, flagID: 5, quantity: 50 }]);
      const h = batchedHaul(sim, [ore], 1),
        can = h.state().manifests[0]!,
        claim = h.op().claimContainer(3, can.containerID)!;
      const native = createNativeHauler(sim.run, sim.session, {
        shipID: 13,
        corporationID: 77,
        division: 1,
        current() {},
        tripDocument: h.tripDocument,
        pollMs: 1,
      });
      await native.navigateAndVerify(can, target, h.claim);
      assert.ok(h.op().dispatchHaul(3, can.containerID, claim.generation));
      sim.setDeliveryLost();
      sim.loseDepositReads(2);
      await assert.rejects(
        native.transferAndDeliver(can, claim.generation, 600),
        /Deposit inventory unavailable/,
      );
      assert.deepEqual(sim.getHeld(), []);
      assert.equal(sim.getCorp()[0]?.quantity, 160);
      assert.equal(h.totals()?.deliveredUnits, 0);
      sim
        .getCorp()
        .push({
          ...prior,
          itemID: 81,
          quantity: 1,
          ...(change === "module" ? { typeID: 800, categoryID: 7 } : {}),
        });
      sim.clearDeliveryLost();
      h.restart();
      if (change === "same ore") {
        await assert.rejects(h.haul(), /unknown; no replay/);
        assert.equal(h.totals()?.deliveredUnits, 0);
        sim.getCorp().pop();
      }
      assert.equal(await h.haul(), "delivered");
      assert.equal(h.receipts()[0]?.deliveryBatches?.[0]?.item.quantity, 10);
      assert.equal(h.totals()?.deliveredUnits, 60);
      assert.equal(h.totals()?.trips, 1);
      h.restart();
      assert.equal(h.totals()?.deliveredUnits, 60);
      assert.deepEqual(
        sim.calls
          .filter((c: any) => c.of === 700 && ["Add", "MultiAdd"].includes(c.method))
          .map((c: any) => [c.method, c.args, c.kwargs.qty]),
        [["Add", [22, 13], 60]],
      );
    },
  );
}

for (const extra of [0, 4])
  test(
    "resuming a legacy partial receipt unloads the other 50 with " + extra + " units of other ore",
    async () => {
      const sim = simulator(3, 13);
      sim.mergeCargo();
      const stock = { ...ore, itemID: 22, ownerID: 3, locationID: 13, flagID: 5, quantity: 50 };
      sim.setHeld([
        stock,
        ...(extra ? [{ ...stock, itemID: 23, typeID: 32, quantity: extra }] : []),
      ]);
      const h = batchedHaul(sim, [ore], 1),
        can = h.state().manifests[0]!,
        claim = h.op().claimContainer(3, 100)!;
      const old = createNativeHauler(sim.run, sim.session, {
        shipID: 13,
        corporationID: 77,
        division: 1,
        current() {},
        tripDocument: h.tripDocument,
        pollMs: 1,
      });
      await old.navigateAndVerify(can, target, h.claim);
      assert.ok(h.op().dispatchHaul(3, 100, claim.generation));
      sim.setDeliveryLost();
      await assert.rejects(
        old.transferAndDeliver(can, claim.generation, 600, "COMMAND"),
        /delivery acknowledgement lost/,
      );
      assert.equal(sim.getHeld()[0]?.quantity, 50);
      h.restart();
      sim.clearDeliveryLost();
      assert.equal(await h.haul(), "delivered");
      assert.deepEqual(sim.getHeld(), []);
      assert.equal(h.receipts()[0]?.deliveryBatches?.[0]?.item.quantity, 10);
      assert.equal(h.totals()?.deliveredUnits, 60 + extra);
      assert.equal(h.totals()?.trips, 1);
      assert.deepEqual(
        sim.calls.filter((c: any) => c.of === 700).map((c: any) => [c.method, c.kwargs.qty]),
        [["Add", 10], extra ? ["MultiAdd", undefined] : ["Add", 50]],
      );
      h.restart();
      assert.equal(h.totals()?.deliveredUnits, 60 + extra);
    },
  );

test("resumed original can items in the asteroid hold and other ore share one dock visit", async () => {
  const sim = simulator(3, 13),
    h = batchedHaul(sim, [ore], 1);
  const claim = h.op().claimContainer(3, 100)!;
  assert.ok(h.op().dispatchHaul(3, 100, claim.generation));
  sim.setSource([]);
  const original = { ...ore, ownerID: 3, locationID: 13, flagID: 182 };
  sim.setHeld([original, { ...original, itemID: 22, typeID: 32, flagID: 5, quantity: 50 }]);
  h.restart();
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.getHeld(), []);
  const receipt = h.receipts()[0]!;
  assert.equal(receipt.sourceProof?.kind, "relocated-manifest-items");
  assert.equal(receipt.deliveryBatches?.[0]?.item.quantity, 10);
  assert.deepEqual(h.totals()?.unitsByType, { "30": 10, "32": 50 });
  assert.equal(h.totals()?.trips, 1);
  h.restart();
  assert.equal(h.totals()?.deliveredUnits, 60);
});

test("personal delivery unloads all eligible ore while crediting the can only for its share", async () => {
  const sim = simulator(3, 13);
  sim.setPersonal();
  sim.mergeCargo();
  sim.setCapacities(64, 0);
  const stock = { ...ore, itemID: 22, ownerID: 3, locationID: 13, flagID: 5, quantity: 50 };
  const equipment = { ...stock, itemID: 70, typeID: 800, categoryID: 7, quantity: 1 };
  sim.setHeld([stock, equipment, { ...stock, itemID: 23, typeID: 32, quantity: 3, flagID: 182 }]);
  const h = batchedHaul(sim, [ore], 1);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.getHeld(), [equipment]);
  assert.deepEqual(
    sim.getCorp().map((r) => [r.typeID, r.quantity, r.ownerID, r.locationID, r.flagID]),
    [
      [30, 60, 3, 600, 4],
      [32, 3, 3, 600, 4],
    ],
  );
  assert.deepEqual(h.receipts()[0]?.deliveryBatches?.[0]?.items, [
    { itemID: 22, typeID: 30, quantity: 10 },
  ]);
  assert.deepEqual(h.totals()?.unitsByType, { "30": 60, "32": 3 });
  assert.equal(h.totals()?.trips, 1);
});

test("jettison refuses a configured can capacity above the native type capacity before any write", async () => {
  const sim = simulator(1, 11);
  sim.setSource([]);
  sim.setHeld([{ ...ore, locationID: 11, flagID: 5 }]);
  const obs = createNativeRawObserver(sim.run, sim.session, {
    shipID: 11,
    current() {},
    assertAtTarget: async () => {},
    typeFacts: async () => ({ 30: { categoryID: 25, freightKind: "RAW", unitVolumeM3: 1 } }),
    capacityM3: 27501,
  });
  await assert.rejects(obs.observeHolds(target, claim), /exceeds the native/);
  assert.equal(
    sim.calls.some((x: any) => x.method === "Jettison"),
    false,
  );
});
test("empty-hold stop remains available when can-capacity metadata is unavailable", async () => {
  const sim = simulator(1, 11);
  sim.setSource([]);
  let capacityReads = 0;
  const original = sim.run.fetch;
  sim.run.fetch = async (input: unknown, ...args: unknown[]) => {
    if (new URL(String(input)).pathname === "/api/client-data/dogma-types") {
      capacityReads++;
      throw Error("metadata unavailable");
    }
    return original(input, ...args);
  };
  const obs = createNativeRawObserver(sim.run, sim.session, {
    shipID: 11,
    current() {},
    assertAtTarget: async () => {},
    typeFacts: async () => ({}),
    capacityM3: 100,
  });
  const reading = await obs.observeHolds(target, claim);
  assert.deepEqual(reading.items, []);
  assert.equal(capacityReads, 0);
});

test("post-pickup scene lag is polled without a second pickup", async () => {
  const sim = simulator(3, 13);
  sim.setRemovedReadFails();
  sim.setVisibilityLag(4);
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  const proof = await native.transferAndDeliver(manifest, 2, 600);
  assert.equal(proof.sourceProof.kind, "native-batches");
  if (proof.sourceProof.kind === "native-batches")
    assert.equal(proof.sourceProof.batches[0]?.canAbsence?.containerID, 100);
  assert.equal(sim.calls.filter((x: any) => x.method === "Add" && x.of === 13).length, 1);
});
test("relocated exact original item recovers to corp without any pickup write", async () => {
  const sim = simulator(3, 13);
  sim.setSource([]);
  sim.setHeld([{ ...ore, ownerID: 3, locationID: 13, flagID: 134 }]);
  sim.setCapacities(100, 100);
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  const proof = await native.recoverHeldAndDeliver(manifest, 2, 600);
  assert.equal(proof.sourceProof.kind, "relocated-manifest-items");
  assert.deepEqual(proof.sourceProof.items, [
    { itemID: 20, typeID: 30, quantity: 10, ownerID: 3, locationID: 13, flagID: 134 },
  ]);
  assert.equal(sim.getCorp()[0]?.quantity, 10);
  assert.equal(
    sim.calls.some((x: any) => x.method === "Add" && x.of === 13),
    false,
  );
});
test("relocation rejects merged, partial or wrong-flag items before any write", async () => {
  for (const row of [
    { ...ore, itemID: 21 },
    { ...ore, quantity: 9 },
    { ...ore, flagID: 87 },
  ]) {
    const sim = simulator(3, 13);
    sim.setSource([]);
    sim.setHeld([{ ...row, ownerID: 3, locationID: 13, flagID: row.flagID === 87 ? 87 : 5 }]);
    const native = createNativeHauler(sim.run, sim.session, {
      shipID: 13,
      corporationID: 77,
      division: 1,
      current() {},
      tripDocument: sim.tripDocument,
      pollMs: 1,
    });
    await assert.rejects(native.recoverHeldAndDeliver(manifest, 2, 600), /not proven/);
    assert.equal(
      sim.calls.some((x: any) => x.method === "Add"),
      false,
    );
  }
});
test("relocated ore with a lost Add reply is credited once when the original Item ID reaches the office", async () => {
  const sim = simulator(3, 13);
  sim.setSource([]);
  sim.setHeld([{ ...ore, ownerID: 3, locationID: 13, flagID: 5 }]);
  const open = () =>
    createNativeHauler(sim.run, sim.session, {
      shipID: 13,
      corporationID: 77,
      division: 1,
      current() {},
      tripDocument: sim.tripDocument,
      pollMs: 1,
    });
  sim.setDeliveryLost();
  await assert.rejects(open().recoverHeldAndDeliver(manifest, 2, 600), /acknowledgement lost/);
  sim.getCorp()[0]!.quantity += 7;
  const native = open();
  await native.reconcileReturnHome(manifest, 2, 600);
  const receipt = await native.recoverHeldAndDeliver(manifest, 2, 600);
  assert.equal(receipt.sourceProof.kind, "relocated-manifest-items");
  assert.deepEqual(
    receipt.deliveryBatches?.map((b) => [b.item.quantity, b.acknowledged]),
    [[10, false]],
  );
  assert.equal((sim.getDoc() as any).pending, null);
  assert.equal(sim.calls.filter((x: any) => x.method === "Add").length, 1);
});
test("a lost single-stack delivery with a recorded pickup can finish from its original trip", async () => {
  const sim = simulator(3, 13);
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  sim.setDeliveryLost();
  await assert.rejects(native.transferAndDeliver(manifest, 2, 600), /acknowledgement lost/);
  sim.getCorp().push({ ...sim.getCorp()[0]!, itemID: 81, quantity: 7 });
  const receipt = await native.recoverHeldAndDeliver(manifest, 2, 600);
  assert.equal(receipt.sourceProof.kind, "native-batches");
  assert.deepEqual(
    receipt.deliveryBatches?.map((b) => [b.item.quantity, b.acknowledged]),
    [[10, false]],
  );
  assert.equal(sim.calls.filter((c: any) => c.of === 700 && c.method === "Add").length, 1);
});

test("missing durable journal fences the first pickup", async () => {
  const sim = simulator(3, 13),
    native = createNativeHauler(sim.run, sim.session, {
      shipID: 13,
      corporationID: 77,
      division: 1,
      current() {},
      pollMs: 1,
    });
  await native.navigateAndVerify(manifest, target, claim);
  await assert.rejects(native.transferAndDeliver(manifest, 2, 600), /journal is required/);
  assert.equal(
    sim.calls.some((x: any) => x.method === "Add"),
    false,
  );
});

test("a vanished can is not accepted after the hauler leaves the transfer grid", async () => {
  const sim = simulator(3, 13);
  sim.setRemovedReadFails();
  sim.setPostPickupJump();
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  await assert.rejects(native.transferAndDeliver(manifest, 2, 600), /left the transfer grid/);
  assert.equal(sim.calls.filter((x: any) => x.method === "Add" && x.of === 13).length, 1);
  assert.equal(sim.getCorp().length, 0);
});
test("pickup and delivery persist acknowledged intents plus post-evidence", async () => {
  const sim = simulator(3, 13);
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  await native.transferAndDeliver(manifest, 2, 600);
  const journal = sim.getDoc() as any;
  assert.deepEqual(
    journal.events.map((x: any) => [x.kind, x.acknowledged]),
    [
      ["pickup", true],
      ["delivery", true],
    ],
  );
  assert.ok(journal.events.every((x: any) => x.before && x.after));
  assert.equal(journal.pending, null);
});

test("unknown pickup acknowledgement reconciles only exact original whole items without replay", async () => {
  const sim = simulator(3, 13);
  sim.setPickupLost();
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(manifest, target, claim);
  await assert.rejects(native.transferAndDeliver(manifest, 2, 600), /pickup acknowledgement lost/);
  assert.equal((sim.getDoc() as any).pending.kind, "pickup");
  const proof = await native.recoverHeldAndDeliver(manifest, 2, 600);
  assert.equal(proof.sourceProof.kind, "relocated-manifest-items");
  assert.equal(sim.calls.filter((x: any) => x.method === "Add" && x.of === 13).length, 1);
  assert.equal(sim.getCorp()[0]?.quantity, 10);
});

test("failed durable intent prevents native pickup", async () => {
  const sim = simulator(3, 13),
    native = createNativeHauler(sim.run, sim.session, {
      shipID: 13,
      corporationID: 77,
      division: 1,
      current() {},
      tripDocument: () => ({
        read: () => null,
        write: () => {
          throw Error("storage failed");
        },
      }),
      pollMs: 1,
    });
  await native.navigateAndVerify(manifest, target, claim);
  await assert.rejects(native.transferAndDeliver(manifest, 2, 600), /storage failed/);
  assert.equal(
    sim.calls.some((x: any) => x.method === "Add"),
    false,
  );
});

test("raw ice uses Miasmos general mining hold and reaches the corporation division", async () => {
  const sim = simulator(3, 13);
  sim.setFamily("ice", 2.5);
  sim.setCapacities(0, 100);
  const key = "ICE:300:site:55:instance:89",
    m = { ...manifest, targetKey: key, items: [{ ...item, unitVolumeM3: 2.5 }], volumeM3: 25 },
    t = {
      kind: "ICE" as const,
      systemID: 300,
      name: "ice",
      siteID: 55,
      instanceID: 89,
      position: loc,
    },
    c = { ...claim, key };
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(m, t, c);
  const proof = await native.transferAndDeliver(m, 2, 600);
  assert.equal(proof.destinationAfter[0]?.quantity, 10);
  const writes = sim.calls.filter((x: any) => x.method === "Add") as any[];
  assert.deepEqual(
    writes.map((x) => [x.of, x.kwargs.flag, x.kwargs.qty]),
    [
      [13, 134, 10],
      [700, 115, 10],
    ],
  );
});
test("ICE target cannot publish ore held in a miner's general mining hold", async () => {
  const sim = simulator(1, 11);
  sim.setSource([]);
  sim.setHeld([{ ...ore, locationID: 11, flagID: 134 }]);
  const obs = createNativeRawObserver(sim.run, sim.session, {
    shipID: 11,
    current() {},
    assertAtTarget: async () => {},
    typeFacts: async () => ({
      30: { categoryID: 25, freightKind: "RAW", resourceFamily: "ore", unitVolumeM3: 1 },
    }),
    capacityM3: 100,
  });
  await assert.rejects(
    obs.observeHolds(
      { kind: "ICE", systemID: 300, name: "ice", siteID: 55, instanceID: 89, position: loc },
      { ...claim, key: "ICE:300:site:55:instance:89" },
    ),
    /Only verified raw/,
  );
});

test("a visible can during warp is only approached after fresh ready own-flight and scene", async () => {
  let flightReads = 0,
    approaches = 0,
    shipX = 0;
  const transition = {
      phase: "ready",
      sessionStable: true,
      locationReady: true,
      sceneReady: true,
      egoReady: true,
      shipReady: true,
      boundContextReady: true,
    },
    run: any = {
      characterID: 3,
      baseUrl: "http://bff",
      fetch: async (input: unknown) => {
        const p = new URL(String(input)).pathname;
        let body: any;
        if (p === "/api/bridge/flight/status") {
          flightReads++;
          body = {
            flight: {
              inSpace: true,
              shipID: 13,
              solarSystemID: 300,
              shipMode: flightReads < 3 ? "WARP" : "STOP",
              transition,
            },
          };
        } else if (p === "/api/bridge/space/snapshot")
          body = {
            space: {
              stateValid: true,
              inSpace: true,
              solarSystemID: 300,
              shipID: 13,
              sampledAtMs: Date.now(),
              ship: {
                itemID: 13,
                characterID: 3,
                mode: flightReads < 3 ? "WARP" : "STOP",
                position: { x: shipX, y: 0, z: 0 },
                radius: 10,
              },
              entities: [
                {
                  kind: "container",
                  itemID: 100,
                  ownerID: 1,
                  typeID: 23,
                  position: { x: 5000, y: 0, z: 0 },
                  radius: 10,
                },
              ],
            },
          };
        else if (p === "/api/client-data/dogma-types")
          body = { available: true, types: { 30: { categoryID: 25 } } };
        else if (p === "/api/mining-operations/resources")
          body = { resources: [{ typeID: 30, family: "ore", name: "ore" }] };
        else if (p === "/api/types/volumes") body = { volumes: { 30: 1 }, capped: false };
        else if (p === "/api/bridge/ship/13/bays")
          body = {
            activeShipID: 13,
            shipID: 13,
            bays: [
              { key: "ore", present: false, error: null, capacity: { capacity: 0, used: 0 } },
              { key: "cargo", present: true, error: null, capacity: { capacity: 100, used: 0 } },
            ],
          };
        else throw Error(`unexpected ${p}`);
        return Response.json({ ok: true, ...body });
      },
    };
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 3, corporationID: 77 } }) } },
    flow: {
      requestOptions: () => ({}),
      flying: {
        bridgeDo: async () => null,
        bridgeAsk: async (_s: string, _m: string, _args: unknown, _kw: unknown, of: number) =>
          of === 100 ? list([ore]) : list([]),
        approachShip: async (id: number) => {
          assert.equal(id, 100);
          assert.ok(flightReads >= 5, "a WARP read must not permit approach");
          approaches++;
          shipX = 4000;
        },
      },
    },
  };
  const native = createNativeHauler(run, session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    pollMs: 1,
    timeoutMs: 500,
  });
  await native.navigateAndVerify(manifest, target, claim);
  assert.equal(approaches, 1);
  assert.ok(flightReads >= 5);
});

test("a nearby can during warp cannot admit inventory reads before fresh ready flight", async () => {
  let flightReads = 0,
    approaches = 0,
    shipX = 4000;
  const transition = {
      phase: "ready",
      sessionStable: true,
      locationReady: true,
      sceneReady: true,
      egoReady: true,
      shipReady: true,
      boundContextReady: true,
    },
    run: any = {
      characterID: 3,
      baseUrl: "http://bff",
      fetch: async (input: unknown) => {
        const p = new URL(String(input)).pathname;
        let body: any;
        if (p === "/api/bridge/flight/status") {
          flightReads++;
          body = {
            flight: {
              inSpace: true,
              shipID: 13,
              solarSystemID: 300,
              shipMode: flightReads < 3 ? "WARP" : "STOP",
              transition,
            },
          };
        } else if (p === "/api/bridge/space/snapshot")
          body = {
            space: {
              stateValid: true,
              inSpace: true,
              solarSystemID: 300,
              shipID: 13,
              sampledAtMs: Date.now(),
              ship: {
                itemID: 13,
                characterID: 3,
                mode: flightReads < 3 ? "WARP" : "STOP",
                position: { x: shipX, y: 0, z: 0 },
                radius: 10,
              },
              entities: [
                {
                  kind: "container",
                  itemID: 100,
                  ownerID: 1,
                  typeID: 23,
                  position: { x: 5000, y: 0, z: 0 },
                  radius: 10,
                },
              ],
            },
          };
        else if (p === "/api/client-data/dogma-types")
          body = { available: true, types: { 30: { categoryID: 25 } } };
        else if (p === "/api/mining-operations/resources")
          body = { resources: [{ typeID: 30, family: "ore", name: "ore" }] };
        else if (p === "/api/types/volumes") body = { volumes: { 30: 1 }, capped: false };
        else if (p === "/api/bridge/ship/13/bays")
          body = {
            activeShipID: 13,
            shipID: 13,
            bays: [
              { key: "ore", present: false, error: null, capacity: { capacity: 0, used: 0 } },
              { key: "cargo", present: true, error: null, capacity: { capacity: 100, used: 0 } },
            ],
          };
        else throw Error(`unexpected ${p}`);
        return Response.json({ ok: true, ...body });
      },
    };
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 3, corporationID: 77 } }) } },
    flow: {
      requestOptions: () => ({}),
      flying: {
        bridgeDo: async () => null,
        bridgeAsk: async (_s: string, _m: string, _args: unknown, _kw: unknown, of: number) =>
          of === 100
            ? (assert.ok(flightReads >= 5, "can List must not run while WARP is observable"),
              list([ore]))
            : list([]),
        approachShip: async (id: number) => {
          assert.equal(id, 100);
          assert.ok(flightReads >= 5, "a WARP read must not permit approach");
          approaches++;
          shipX = 4000;
        },
      },
    },
  };
  const native = createNativeHauler(run, session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    pollMs: 1,
    timeoutMs: 500,
  });
  await native.navigateAndVerify(manifest, target, claim);
  assert.equal(approaches, 0);
  assert.ok(flightReads >= 5);
});

test("native hauler delivers exact recipe-qualified compressed freight", async () => {
  const sim = simulator(3, 13);
  sim.setRaw(false);
  const compressed = {
    ...manifest,
    category: "COMPRESSED" as const,
    items: [{ ...item, freightKind: "COMPRESSED" as const }],
  };
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
  });
  await native.navigateAndVerify(compressed, target, claim);
  const receipt = await native.transferAndDeliver(compressed, 2, 600);
  assert.equal(receipt.destinationAfter[0]?.quantity, 10);
  assert.equal(sim.getCorp()[0]?.typeID, 30);
  assert.equal((sim.calls as any[]).filter((x) => x.method === "Add").length, 2);
});

test("miner selects homogeneous compressed can at configured native volume threshold", async () => {
  const sim = simulator(1, 11);
  sim.setSource([]);
  sim.setCapacities(20, 0);
  sim.setHeld([
    { ...ore, itemID: 20, typeID: 30, locationID: 11, flagID: 5 },
    { ...ore, itemID: 21, typeID: 31, quantity: 100, locationID: 11, flagID: 5 },
  ]);
  const obs = createNativeRawObserver(sim.run, sim.session, {
    shipID: 11,
    current() {},
    assertAtTarget: async () => {},
    typeFacts: async () => ({
      30: { categoryID: 25, freightKind: "RAW", resourceFamily: "ore", unitVolumeM3: 1 },
      31: { categoryID: 25, freightKind: "COMPRESSED", resourceFamily: "ore", unitVolumeM3: 0.1 },
    }),
    capacityM3: 100,
    oreLogistics: { version: 1, remoteCompression: true, compressedJettisonFraction: 0.5 },
  });
  const picked = await obs.observeHolds(target, claim);
  assert.deepEqual(
    picked.items.map((i) => [i.itemID, i.freightKind]),
    [[21, "COMPRESSED"]],
  );
  assert.equal(picked.source.items.length, 2);
});

test("hauler AUTO assist observes long can approach then settles before inventory pickup", async () => {
  const sim = simulator(3, 13);
  sim.setCanDistance(25000);
  const events: string[] = [],
    native = createNativeHauler(sim.run, sim.session, {
      shipID: 13,
      corporationID: 77,
      division: 1,
      current() {},
      pollMs: 1,
      travelAssist: {
        beforeApproach: async (_scope, distance, range) => {
          assert.ok(distance > range + 10000);
          events.push("assist");
        },
        settle: async () => {
          events.push("settle");
        },
      },
    });
  await native.navigateAndVerify(manifest, target, claim);
  assert.deepEqual(events, ["assist", "settle"]);
  assert.equal(
    (sim.calls as any[]).some((x) => x.method === "Add"),
    false,
  );
});

test("collected raw stack may be converted once before exact compressed delivery", async () => {
  const sim = simulator(3, 13);
  sim.setCapacities(100, 0, 100);
  let conversions = 0;
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
    convertFreight: async (original) => {
      conversions++;
      const before = { ...ore, ownerID: 3, locationID: 13, flagID: 5 },
        after = { ...before, typeID: 31 };
      sim.setHeld([after]);
      return {
        item: { itemID: 20, typeID: 30, quantity: 10, flagID: 5 },
        output: { itemID: 20, typeID: 31, quantity: 10, flagID: 5 },
        before: [before],
        after: [after],
        rawUnitVolumeM3: 1,
        compressedUnitVolumeM3: 0.1,
        issuedAt: 1,
        observedAt: 2,
        acknowledged: true,
        response: null,
        facility: {
          operationID: "op",
          runID: "run",
          claimKey: "belt",
          claimGeneration: 1,
          commanderCharacterID: 3,
          commanderShipID: 13,
          minerCharacterID: 3,
          minerShipID: 13,
          systemID: 300,
          observedAt: 1,
          sceneSampledAt: 1,
          facilityTypeListIDs: [1],
          matchingTypeListIDs: [1],
          rangeMeters: 100,
          surfaceDistanceMeters: 0,
          sourceTypeID: 30,
          compressedTypeID: 31,
          coreModuleID: 10,
          compressorModuleID: 11,
          compressorEffectID: 12,
        },
      };
    },
  });
  await native.navigateAndVerify(manifest, target, claim);
  const receipt = await native.transferAndDeliver(manifest, 2, 600);
  assert.equal(conversions, 1);
  assert.equal(receipt.deliveryBatches?.[0]?.conversion?.item.typeID, 30);
  assert.equal(receipt.destinationAfter[0]?.typeID, 31);
  assert.equal(receipt.destinationAfter[0]?.quantity, 10);
});

test("lost collected-compression reply reconciles converted custody without replay", async () => {
  const sim = simulator(3, 13);
  let conversions = 0,
    receipt: any = null;
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    tripDocument: sim.tripDocument,
    pollMs: 1,
    convertFreight: async (original) => {
      conversions++;
      const before = { ...ore, ownerID: 3, locationID: 13, flagID: 5 },
        after = { ...before, typeID: 31 };
      sim.setHeld([after]);
      receipt = {
        item: { itemID: 20, typeID: 30, quantity: 10, flagID: 5 },
        output: { itemID: 20, typeID: 31, quantity: 10, flagID: 5 },
        before: [before],
        after: [after],
        rawUnitVolumeM3: 1,
        compressedUnitVolumeM3: 0.1,
        issuedAt: 1,
        observedAt: 2,
        acknowledged: true,
        response: null,
        facility: {
          operationID: "op",
          runID: "run",
          claimKey: "belt",
          claimGeneration: 1,
          commanderCharacterID: 3,
          commanderShipID: 13,
          minerCharacterID: 3,
          minerShipID: 13,
          systemID: 300,
          observedAt: 1,
          sceneSampledAt: 1,
          facilityTypeListIDs: [1],
          matchingTypeListIDs: [1],
          rangeMeters: 100,
          surfaceDistanceMeters: 0,
          sourceTypeID: 30,
          compressedTypeID: 31,
          coreModuleID: 10,
          compressorModuleID: 11,
          compressorEffectID: 12,
        },
      };
      throw Error("compression reply lost");
    },
    recoverConversion: async () => receipt,
  });
  await native.navigateAndVerify(manifest, target, claim);
  await assert.rejects(native.transferAndDeliver(manifest, 2, 600), /reply lost/);
  const recovered = await native.recoverHeldAndDeliver(manifest, 2, 600);
  assert.equal(conversions, 1);
  assert.equal(recovered.deliveryBatches?.[0]?.conversion?.item.typeID, 30);
  assert.equal(recovered.destinationAfter[0]?.typeID, 31);
  assert.equal(recovered.destinationAfter[0]?.quantity, 10);
});

function batchedHaul(
  sim: ReturnType<typeof simulator>,
  rows: readonly (typeof ore)[],
  unitVolumeM3: number,
  navigation?: Pick<
    Parameters<typeof createNativeHauler>[2],
    | "navigateToTarget"
    | "claimPickup"
    | "releasePickup"
    | "afterPickup"
    | "gridLootFleet"
    | "timeoutMs"
  >,
  peer?: ReturnType<typeof simulator>,
  third?: ReturnType<typeof simulator>,
) {
  const memory = () => {
    let value: unknown = null;
    return {
      read: () => structuredClone(value),
      write: (next: unknown) => {
        value = structuredClone(next);
      },
    };
  };
  const storage = memoryFleetDocuments();
  const board = createTargetBoard(memory()),
    opDoc = fleetOperationStore(storage, "op", "run"),
    definition = {
      operationID: "op",
      runID: "run",
      systemID: 300,
      destinationID: 600,
      delivery: {
        kind: "station" as const,
        systemID: 300,
        destinationID: 600,
        corporationID: sim.isPersonal() ? null : 77,
        division: sim.isPersonal() ? null : sim.getDivision(),
      },
      members: [
        { characterID: 1, shipID: 11, role: "MINER" as const },
        { characterID: 3, shipID: 13, role: "HAULER" as const },
        ...(peer ? [{ characterID: 4, shipID: 14, role: "HAULER" as const }] : []),
        ...(third ? [{ characterID: 5, shipID: 15, role: "HAULER" as const }] : []),
      ],
    };
  let op = createOperation(opDoc, board, definition);
  const c = op.reserve(1, target);
  assert.ok(c);
  assert.ok(op.activate(1));
  const fact = { categoryID: 25, freightKind: "RAW" as const, unitVolumeM3 };
  function publish(rows: readonly (typeof ore)[]) {
    const claim = op.snapshot().claim;
    assert.ok(claim);
    for (const containerID of new Set(rows.map((r) => r.locationID))) {
      const items = rows
        .filter((r) => r.locationID === containerID)
        .map((r) => ({
          itemID: r.itemID,
          typeID: r.typeID,
          quantity: r.quantity,
          freightKind: "RAW" as const,
          unitVolumeM3,
        }));
      const scope: Pick<
        Extract<Manifest, { source: "native-jetcan" }>,
        | "operationID"
        | "runID"
        | "characterID"
        | "shipID"
        | "systemID"
        | "targetKey"
        | "claimGeneration"
        | "observedAt"
      > = {
        operationID: "op",
        runID: "run",
        characterID: 1,
        shipID: 11,
        systemID: 300,
        targetKey: claim.key,
        claimGeneration: claim.generation,
        observedAt: Date.now(),
      };
      const facts = Object.fromEntries(items.map((i) => [i.typeID, fact])),
        intent = op.prepareJetcan(1, items, 55000, facts, {
          source: "checked-ship-holds",
          ...scope,
          items: items.map((i) => ({ ...i, ownerID: 1, locationID: 11, flagID: 134 })),
        });
      assert.ok(intent);
      assert.ok(op.dispatchJetcan(1, intent.generation));
      assert.ok(
        op.registerJetcan(
          {
            source: "native-jetcan",
            ...scope,
            containerID,
            intentGeneration: intent.generation,
            capacityM3: 55000,
            items,
          },
          facts,
        ),
      );
    }
  }
  publish(rows);
  const documentFor = (m: Manifest, shipID: number, characterID: number, generation: number) =>
    storage.document(
      fleetHaulDocumentKey(m.operationID, m.runID, m.containerID, generation, characterID, shipID),
    );
  const make = (s = sim, shipID = 13) =>
    createNativeHauler(s.run, s.session, {
      shipID,
      ...(sim.isPersonal() ? {} : { corporationID: 77, division: sim.getDivision() }),
      delivery: definition.delivery,
      current() {},
      tripDocument: (m, generation) => documentFor(m, shipID, s.run.characterID, generation),
      pollMs: 1,
      ownFreight: {
        operationID: "op",
        runID: "run",
        document: storage.document(
          HAULER_OWN_DEPOSIT_PREFIX + JSON.stringify(["op", "run", s.run.characterID, shipID]),
        ),
      },
      returnHome: () => op.snapshot().stopFreight === "RETURN_HOME",
      ...(s === sim ? navigation : undefined),
    });
  const other = peer ? make(peer, 14) : null;
  const thirdNative = third ? make(third, 15) : null;
  let native = make(),
    loops = createRawMembers(op);
  return {
    state: () => op.snapshot(),
    receipts: () =>
      op.snapshot().manifests.flatMap((m) => {
        const delivery = m.delivered ? opDoc.readDelivery(m.containerID) : null;
        return delivery ? [delivery.receipt] : [];
      }),
    haul: () => loops.hauler(3, native),
    peerHaul: () => loops.hauler(4, other!),
    thirdHaul: () => loops.hauler(5, thirdNative!),
    parkingDocument: storage.document(
      "mining-fleet-finish-parking-unload:" + JSON.stringify(["op", "run", 3, 13]),
    ),
    op: () => op,
    claim: c,
    tripDocument: (m: Manifest, generation = 1) => documentFor(m, 13, 3, generation),
    publish,
    scanFinal: () => loops.scanFinalFreight(3, native),
    totals: () => summarizeFleetRun(storage, "op", "run", op.snapshot(), null),
    retire: () => {
      deleteFleetExecution(storage, "op", "run");
      return fleetRunResult(storage, "op", "run");
    },
    nextRun: () =>
      createOperation(fleetOperationStore(storage, "op", "next"), board, {
        ...definition,
        runID: "next",
      }),
    restart: () => {
      op = createOperation(opDoc, board, definition);
      native = make();
      loops = createRawMembers(op);
    },
  };
}

for (const delayed of [false, true])
  test(
    "an unpublished distant Jettison is reserved and hauled by its owner ID " +
      (delayed ? "after a slow read" : "with a fresh scan"),
    async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 10000 });
      let now = 0;
      t.mock.method(performance, "now", () => now);
      const sim = simulator(3, 13),
        legal = { ...ore, ownerID: 141100100 },
        unrelated = { ...ore, itemID: 21, locationID: 101, ownerID: 141100101 };
      sim.setSource([legal, unrelated]);
      sim.setCanDistance(11000);
      sim.setCapacities(100, 100);
      let sourceSeen = false,
        pickupStarted = false;
      const rangeReads: string[] = [];
      const fetch = sim.run.fetch;
      sim.run.fetch = async (input: unknown) => {
        const response = await fetch(input);
        const path = new URL(String(input)).pathname;
        if (
          sourceSeen &&
          !pickupStarted &&
          ["/api/bridge/flight/status", "/api/bridge/space/snapshot"].includes(path)
        )
          rangeReads.push(path);
        if (path !== "/api/bridge/space/snapshot") return response;
        const body = await response.json();
        body.space.entities[0].lootRights = {
          ownerID: legal.ownerID,
          corpID: null,
          fleetID: null,
          abandoned: true,
        };
        return Response.json(body);
      };
      const ask = sim.session.flow.flying.bridgeAsk,
        approach = sim.session.flow.flying.approachShip,
        actions: string[] = [];
      let reached = false,
        reserved = false;
      sim.session.flow.flying.bridgeAsk = async (...args: any[]) => {
        if ([100, 101].includes(args[4])) {
          assert.equal(args[4], 100);
          assert.ok(reached);
          actions.push("read:100");
          sourceSeen = true;
          if (delayed) now += 1501;
        }
        return ask(...args);
      };
      sim.session.flow.flying.approachShip = async (id: number) => {
        assert.ok(reserved);
        assert.equal(id, 100);
        actions.push("approach:100");
        reached = true;
        await approach(id);
      };
      const write = sim.session.flow.flying.bridgeDo;
      sim.session.flow.flying.bridgeDo = async (...args: any[]) => {
        if (args[0] === "invbroker" && ["Add", "MultiAdd"].includes(args[1]) && args[4] === 13)
          pickupStarted = true;
        return write(...args);
      };
      const h = batchedHaul(sim, [], 1, {
        navigateToTarget: async () => {},
        claimPickup: async (m) => {
          assert.equal(m.containerID, 100);
          assert.equal(reserved, false);
          reserved = true;
          actions.push("claim:100");
        },
        releasePickup: async () => {
          assert.ok(reserved);
          reserved = false;
          actions.push("release:100");
        },
      });
      assert.equal(await h.haul(), "waiting");
      assert.deepEqual(actions, ["claim:100", "approach:100", "read:100", "release:100"]);
      assert.deepEqual(
        rangeReads,
        delayed ? ["/api/bridge/space/snapshot"] : [],
        "only stale range needs a fresh grid",
      );
      assert.equal(h.state().manifests[0]?.source, "observed-jetcan");
      assert.equal(h.state().manifests[0]?.characterID, legal.ownerID);
      assert.equal(h.state().manifests[0]?.shipID, null);
      assert.equal(h.state().jetcanGeneration, 0);
      assert.equal(await h.haul(), "waiting");
      assert.equal(sim.getHeld()[0]?.quantity, 10);
      assert.equal(h.state().haulClaims["100"], undefined);
      assert.equal(h.state().manifests[0]?.closedPickup?.characterID, 3);
      h.op().noteStopRequest("COLLECT_FREIGHT");
      h.op().requestStop();
      assert.equal(await h.haul(), "delivered");
      assert.equal(sim.getCorp()[0]?.quantity, 10);
      assert.deepEqual(sim.getSource(), [unrelated]);
      assert.equal(h.totals()?.deliveredUnits, 10);
      assert.deepEqual(h.state().haulClaims, {});
    },
  );

test("a temporary can read keeps the existing Follow and picks that can before a closer one", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const sim = simulator(3, 13);
  sim.setSource([{ ...ore }, { ...ore, itemID: 21, locationID: 101 }]);
  sim.setCanDistance(11000);
  let following: number | null = null,
    retrying = false,
    samples = 0,
    readFails = true;
  const approaches: number[] = [];
  const fetch = sim.run.fetch,
    ask = sim.session.flow.flying.bridgeAsk,
    approach = sim.session.flow.flying.approachShip;
  sim.run.fetch = async (input: unknown) => {
    const response = await fetch(input);
    if (new URL(String(input)).pathname !== "/api/bridge/space/snapshot") return response;
    const body = await response.json();
    if (retrying) samples++;
    for (const can of body.space.entities)
      if (can.itemID === 101) can.position.x = retrying ? 3000 : 14000;
      else if (retrying && samples <= 3) can.position.x = 6000;
    if (following !== null) {
      body.space.ship.mode = "FOLLOW";
      body.space.entities.push({ ...body.space.ship, kind: "ship", targetEntityID: following });
    }
    return Response.json(body);
  };
  sim.session.flow.flying.approachShip = async (id: number) => {
    approaches.push(id);
    following = id;
    await approach(id);
  };
  sim.session.flow.flying.bridgeAsk = async (...args: any[]) => {
    if (args[1] === "List" && args[4] === 100 && readFails) {
      readFails = false;
      throw Object.assign(Error("Can inventory read timed out"), { code: "CALL_TIMEOUT" });
    }
    return ask(...args);
  };
  const h = batchedHaul(sim, [], 1, {
    navigateToTarget: async () => {},
    claimPickup: async () => {},
  });
  await assert.rejects(h.haul(), FreightGridUnavailable);
  assert.deepEqual(approaches, [100]);
  assert.equal(sim.getHeld().length, 0);
  retrying = true;
  t.mock.timers.tick(5001);
  assert.equal(await h.haul(), "waiting");
  assert.deepEqual(approaches, [100]);
  assert.deepEqual(
    sim.getSource().map((row) => row.locationID),
    [101],
  );
  assert.equal(sim.getHeld()[0]?.quantity, 10);
});

test("Return Home never approaches new Jettison observed on its active grid", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const sim = simulator(3, 13);
  const h = batchedHaul(sim, [], 1, {
    navigateToTarget: async () => {},
    claimPickup: async () => assert.fail("new pickup after Stop"),
  });
  assert.equal(await h.haul(), "on-grid");
  t.mock.timers.tick(5001);
  h.op().noteStopRequest("RETURN_HOME");
  assert.equal(await h.haul(), "idle");
  assert.deepEqual(h.state().manifests, []);
  assert.equal(sim.getSource()[0]?.quantity, 10);
});

for (const close of ["Collect Freight", "belt change"] as const)
  test(close + " discovers fresh ordinary Jettison before draining the grid", async () => {
    const sim = simulator(3, 13),
      rows = [{ ...ore }, { ...ore, itemID: 21, locationID: 101 }];
    sim.setSource([]);
    const h = batchedHaul(sim, [], 1, {
      navigateToTarget: async () => {},
      gridLootFleet: () => ({ memberIDs: [1], fleetID: 555 }),
    });
    assert.equal(await h.haul(), "on-grid");
    sim.setSource(rows);
    const op = h.op();
    if (close === "Collect Freight") op.noteStopRequest("COLLECT_FREIGHT");
    else assert.ok(op.prepareRelocation(1, h.claim, { ...target, name: "next belt" }, 99, [1]));
    await h.scanFinal();
    assert.deepEqual(
      h.state().manifests.map((row) => [row.source, row.containerID]),
      [
        ["observed-jetcan", 100],
        ["observed-jetcan", 101],
      ],
    );
    assert.deepEqual(h.state().jetcanIntents, {});
    if (close === "Collect Freight") op.requestStop();
    assert.equal(await h.haul(), "delivered");
    assert.deepEqual(sim.getSource(), []);
    assert.equal(
      sim.getCorp().reduce((total, row) => total + row.quantity, 0),
      20,
    );
    assert.deepEqual(h.state().haulClaims, {});
  });

for (const lost of [false, true])
  test(
    "Hauler MultiAdd accepts native stack placement and delivers the exact delta " +
      (lost ? "after lost ACK" : "in one pickup"),
    async () => {
      const sim = simulator(3, 13),
        rows = [
          { ...ore, quantity: 12 },
          { ...ore, itemID: 21, quantity: 9 },
        ];
      sim.setSource(rows.map((r) => ({ ...r })));
      sim.setHeld([{ ...ore, itemID: 500, locationID: 13, ownerID: 3, flagID: 5, quantity: 70 }]);
      sim.mergeCargo();
      const h = batchedHaul(sim, rows, 1);
      if (lost) {
        sim.setPickupLost();
        await assert.rejects(h.haul(), /pickup acknowledgement lost/);
        h.restart();
      }
      assert.equal(await h.haul(), "delivered");
      assert.deepEqual(sim.getHeld(), []);
      assert.equal(sim.getCorp()[0]?.quantity, 91);
      assert.equal(sim.calls.filter((c: any) => c.method === "MultiAdd" && c.of === 13).length, 1);
      assert.ok(
        !sim.calls.some((c: any) => ["Merge", "MultiMerge", "StackAll"].includes(c.method)),
      );
      const receipt = h.receipts()[0];
      assert.equal(
        receipt?.deliveryBatches?.reduce((sum, b) => sum + b.item.quantity, 0),
        21,
      );
      assert.equal(h.totals()?.deliveredUnits, 91);
      assert.equal(h.totals()?.trips, 1);
      assert.deepEqual(h.state().haulClaims, {});
    },
  );

test("an unacknowledged partial MultiAdd stays fenced without another move", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 12 },
      { ...ore, itemID: 21, quantity: 9 },
    ];
  sim.setSource(rows.map((r) => ({ ...r })));
  sim.limitMultiAdd(1);
  sim.setPickupLost();
  const h = batchedHaul(sim, rows, 1);
  await assert.rejects(h.haul(), /pickup acknowledgement lost/);
  h.restart();
  await assert.rejects(h.haul(), /transfer is uncertain/);
  assert.equal(
    sim.calls.filter((c: any) => ["Add", "MultiAdd"].includes(c.method) && c.of === 13).length,
    1,
  );
  assert.equal(sim.getHeld()[0]?.quantity, 12);
  assert.equal(sim.getSource()[0]?.quantity, 9);
  assert.equal(h.state().haulClaims["100"]?.dispatched, true);
});

test("a partial MultiAdd and split native stacks publish only what really moved", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 12 },
      { ...ore, itemID: 21, quantity: 9 },
    ];
  sim.setSource(rows.map((r) => ({ ...r })));
  sim.limitMultiAdd(1);
  sim.splitNextPickup();
  const h = batchedHaul(sim, rows, 1);
  assert.equal(await h.haul(), "waiting");
  assert.deepEqual(
    sim.getHeld().map((r) => r.quantity),
    [1, 11],
  );
  assert.deepEqual(
    sim.getSource().map((r) => r.quantity),
    [9],
  );
  h.restart();
  h.op().noteStopRequest("COLLECT_FREIGHT");
  h.op().requestStop();
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 21);
  assert.deepEqual(
    sim.calls.filter((c: any) => c.method === "MultiAdd").map((c: any) => c.of),
    [13, 700],
  );
  assert.deepEqual(sim.getHeld(), []);
});

for (const source of ["empty", "absent"] as const)
  test(`verified ${source} source closes a partial pickup and Collect Freight delivers only what was aboard`, async () => {
    const sim = simulator(3, 13),
      rows = [
        { ...ore, quantity: 12 },
        { ...ore, itemID: 21, quantity: 9 },
      ];
    sim.setSource(structuredClone(rows));
    sim.limitMultiAdd(1);
    const h = batchedHaul(sim, rows, 1, { navigateToTarget: async () => {} });
    assert.equal(await h.haul(), "waiting");
    assert.equal(h.state().haulClaims["100"]?.dispatched, true);
    assert.equal(sim.getSource()[0]?.quantity, 9);
    sim.setSource([]);
    if (source === "empty") sim.setKeepCanVisible();
    h.restart();
    assert.equal(await h.haul(), "waiting");
    assert.deepEqual(h.state().haulClaims, {});
    assert.equal(h.state().manifests[0]?.closedPickup?.characterID, 3);
    assert.equal(sim.getHeld()[0]?.quantity, 12);

    h.restart();
    h.op().noteStopRequest("COLLECT_FREIGHT");
    h.op().requestStop();
    assert.equal(await h.haul(), "delivered");
    assert.equal(sim.getCorp()[0]?.quantity, 12);
    assert.equal(sim.calls.filter((x: any) => x.service === "invbroker" && x.of === 13).length, 1);
    assert.deepEqual(h.state().manifests, []);
    assert.equal(h.totals()?.deliveredUnits, 12);
    assert.equal(h.totals()?.trips, 1);
  });

test("a partial first unload counts carry-in before the can closes and survives Collect Freight retirement", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 21 },
      { ...ore, itemID: 21, quantity: 15 },
    ];
  sim.setSource(structuredClone(rows));
  sim.setHeld([{ ...ore, itemID: 500, locationID: 13, ownerID: 3, flagID: 5, quantity: 70 }]);
  const h = batchedHaul(sim, rows, 1);
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 91);
  assert.equal(h.state().haulClaims["100"]?.dispatched, true);
  assert.deepEqual(h.receipts(), []);
  assert.equal(h.totals()?.deliveredUnits, 91);
  assert.equal(h.totals()?.trips, 1);

  h.restart();
  assert.equal(h.totals()?.deliveredUnits, 91);
  assert.equal(await h.haul(), "waiting");
  assert.equal(sim.getHeld()[0]?.quantity, 15);
  assert.deepEqual(h.state().haulClaims, {});
  assert.equal(h.state().manifests[0]?.closedPickup?.characterID, 3);
  h.op().noteStopRequest("COLLECT_FREIGHT");
  h.op().requestStop();
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 106);
  assert.equal(h.receipts().length, 1);
  assert.equal(h.totals()?.deliveredUnits, 106);
  assert.equal(h.totals()?.trips, 2);
  assert.equal(await h.haul(), "idle");
  assert.equal(sim.calls.filter((x: any) => x.service === "invbroker" && x.of === 13).length, 2);

  const op = h.op();
  for (const { characterID, shipID } of h.state().members) {
    assert.ok(
      op.settleMember(characterID, {
        source: "native-settlement",
        runID: "run",
        shipID,
        modulesInactive: true,
        dronesSafe: true,
        observedAt: Date.now(),
      }),
    );
  }
  for (const { characterID, shipID } of h.state().members) {
    assert.ok(
      op.parkMember(characterID, {
        source: "native-flight",
        runID: "run",
        shipID,
        locationID: 600,
        docked: true,
        observedAt: Date.now(),
      }),
    );
  }
  assert.equal(h.state().state, "STOPPED");
  const result = h.retire();
  assert.equal(result?.deliveredUnits, 106);
  assert.equal(result?.trips, 2);
  const next = h.nextRun();
  assert.ok(next.reserve(1, target));
  assert.ok(next.activate(1));
  assert.deepEqual(next.snapshot().haulClaims, {});
  assert.deepEqual(next.snapshot().manifests, []);
});

test("a verified pickup still marked dispatched is closed on restart and a shared delivery is counted once", async () => {
  const sim = simulator(3, 13),
    first = { ...ore, quantity: 13000 },
    second = { ...ore, itemID: 21, locationID: 101, quantity: 12000 };
  sim.setFamily("ore", 3);
  sim.setCapacities(1100, 189000);
  sim.mergeCargo();
  sim.setSource([first]);
  sim.setHeld([{ ...ore, itemID: 500, locationID: 13, ownerID: 3, flagID: 134, quantity: 32363 }]);
  const h = batchedHaul(sim, [first], 3);
  h.op().closePickup = () => {
    throw Error("Interrupted before pickup closure");
  };
  await assert.rejects(h.haul(), /Interrupted before pickup closure/);
  assert.equal(h.state().haulClaims["100"]?.dispatched, true);
  assert.deepEqual(sim.getSource(), []);
  h.restart();
  assert.equal(await h.haul(), "waiting");
  assert.deepEqual(h.state().haulClaims, {});
  assert.deepEqual(h.state().manifests[0]?.closedPickup, { characterID: 3, generation: 1 });
  assert.equal(sim.getHeld()[0]?.quantity, 45363);
  assert.equal(h.totals()?.deliveredUnits, 0);
  assert.deepEqual(sim.routes, []);
  h.restart();
  sim.setSource([second]);
  h.publish([second]);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.routes, [600]);
  assert.equal(sim.getCorp()[0]?.quantity, 57363);
  assert.deepEqual(sim.getHeld(), []);
  assert.deepEqual(
    h.state().manifests.map((m) => m.delivered),
    [true, true],
  );
  assert.ok(h.state().manifests.every((m) => !m.closedPickup));
  assert.equal(h.totals()?.deliveredUnits, 57363);
  assert.equal(h.totals()?.trips, 1);
  const moves = sim.calls.filter((x: any) => x.method === "Add") as any[];
  assert.deepEqual(
    moves.map((x) => [x.of, x.kwargs.qty]),
    [
      [13, 13000],
      [13, 12000],
      [700, 57363],
    ],
  );
});

test("Collect Freight drains matching pre-existing ore and preserves exact can credit after lost pickup ACK", async () => {
  const sim = simulator(3, 13);
  sim.mergeCargo();
  sim.setHeld([{ ...ore, itemID: 500, locationID: 13, ownerID: 3, flagID: 5, quantity: 35 }]);
  sim.setPickupLost();
  const h = batchedHaul(sim, [ore], 1);
  h.op().noteStopRequest("COLLECT_FREIGHT");
  h.op().requestStop();
  await assert.rejects(h.haul(), /acknowledgement lost/);
  assert.equal(sim.getHeld()[0]?.quantity, 45);
  assert.equal(h.state().haulClaims["100"]?.dispatched, true);
  h.restart();
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.calls.filter((x: any) => x.method === "Add" && x.of === 13).length, 1);
  assert.equal(sim.calls.filter((x: any) => x.method === "Add" && x.of === 700).length, 1);
  assert.equal(sim.getCorp()[0]?.quantity, 45);
  assert.deepEqual(sim.getHeld(), []);
  assert.equal(h.state().manifests[0]?.delivered, true);
  assert.deepEqual(h.state().haulClaims, {});
  assert.equal(h.totals()?.deliveredUnits, 45);
  assert.equal(h.totals()?.trips, 1);
  assert.deepEqual(
    (h.tripDocument(h.state().manifests[0]!).read() as any).events.map((e: any) =>
      e.kind === "pickup" ? e.after.batch.quantity : e.before.item.quantity,
    ),
    [10, 10],
  );
});

for (const mode of ["COLLECT_FREIGHT", "RETURN_HOME"] as const)
  test(
    "a lost deposit reply for pre-existing ore is read back without replay during " + mode,
    async () => {
      const sim = simulator(3, 13);
      sim.setHeld([{ ...ore, itemID: 500, locationID: 13, ownerID: 3, flagID: 5, quantity: 95 }]);
      sim.setDeliveryLost();
      const h = batchedHaul(sim, [ore], 1);
      await assert.rejects(h.haul(), /delivery acknowledgement lost/);
      assert.equal(sim.getCorp()[0]?.quantity, 95);
      assert.deepEqual(sim.getHeld(), []);
      assert.equal(h.state().manifests[0]?.delivered, false);
      assert.deepEqual(h.state().haulClaims, {});
      h.op().noteStopRequest(mode);
      h.op().requestStop();
      h.restart();
      sim.clearDeliveryLost();
      assert.equal(await h.haul(), mode === "RETURN_HOME" ? "idle" : "delivered");
      assert.deepEqual(
        sim.calls.filter((x: any) => x.method === "Add").map((x: any) => [x.of, x.kwargs.qty]),
        mode === "RETURN_HOME"
          ? [[700, 95]]
          : [
              [700, 95],
              [13, 10],
              [700, 10],
            ],
      );
      assert.deepEqual(sim.routes, mode === "RETURN_HOME" ? [600] : [600, 600]);
      assert.deepEqual(sim.getHeld(), []);
      assert.equal(h.totals()?.deliveredUnits, mode === "RETURN_HOME" ? 95 : 105);
      assert.equal(h.totals()?.trips, mode === "RETURN_HOME" ? 1 : 2);
      if (mode === "RETURN_HOME") assert.equal(sim.getSource()[0]?.quantity, 10);
      else assert.equal(h.state().manifests[0]?.delivered, true);
    },
  );

test("Collect Freight reports an impossible capacity without moving, claiming or discarding the can", async () => {
  const sim = simulator(3, 13);
  sim.setCapacities(0, 0);
  const h = batchedHaul(sim, [ore], 1);
  h.op().noteStopRequest("COLLECT_FREIGHT");
  h.op().requestStop();
  await assert.rejects(h.haul(), /No whole ore unit from can 100 fits/);
  assert.deepEqual(sim.routes, []);
  assert.deepEqual(h.state().haulClaims, {});
  assert.equal(h.state().manifests[0]?.delivered, false);
  assert.equal(
    sim.calls.some((x: any) => x.method === "Add"),
    false,
  );
});

test("empty ACTIVE Hauler undocks and waits on the assigned belt before the first can", async () => {
  const sim = simulator(3, 13),
    first = { ...ore, quantity: 3563 },
    beltID = 99;
  sim.setDocked();
  sim.setSource([]);
  sim.setCapacities(1100, 189000);
  sim.setFamily("ore", 3);
  const fetch = sim.run.fetch;
  let position = { x: 1000000, y: 0, z: 0 },
    warps = 0,
    claims = 0;
  sim.run.fetch = async (input: string | URL) => {
    const response = await fetch(input);
    if (new URL(input).pathname !== "/api/bridge/space/snapshot") return response;
    const body = await response.json();
    body.space.ship.position = position;
    body.space.entities.push({
      itemID: beltID,
      kind: "celestial",
      groupID: 9,
      name: target.name,
      position: loc,
      radius: 10,
    });
    return Response.json(body);
  };
  sim.session.flow.flying.warpAsTheAutopilot = async (id: number) => {
    assert.equal(id, beltID);
    warps++;
    position = loc;
  };
  const h = batchedHaul(sim, [], 3, {
    navigateToTarget: (target, claim, current = () => {}) =>
      createNativeBeltNavigation(sim.run, sim.session, {
        shipID: 13,
        beltID,
        current,
        pollMs: 1,
        timeoutMs: 1000,
      }).navigate(target, claim),
    claimPickup: async () => {
      claims++;
    },
  });
  assert.equal(await h.haul(), "on-grid");
  assert.equal(await h.haul(), "on-grid");
  const { flight } = await (
    await sim.run.fetch(new URL("http://bff/api/bridge/flight/status"))
  ).json();
  assert.equal(flight.inSpace, true);
  assert.deepEqual(position, loc);
  assert.equal(warps, 1);
  assert.deepEqual(
    sim.calls.map((call: any) => call.method),
    ["Undock"],
  );
  assert.equal(claims, 0);
  assert.deepEqual(sim.routes, []);
  sim.setSource([structuredClone(first)]);
  h.publish([first]);
  assert.equal(await h.haul(), "waiting");
  assert.equal(claims, 1);
  assert.equal(sim.getHeld()[0]?.quantity, 3563);
  assert.deepEqual(sim.routes, []);
});

for (const mode of ["RETURN_HOME", "COLLECT_FREIGHT"] as const)
  test(`${mode} supersedes travel to an empty belt`, async () => {
    const sim = simulator(3, 13);
    sim.setSource([]);
    sim.setDocked();
    let planned = 0;
    const h = batchedHaul(sim, [], 1, {
      async navigateToTarget(_target, _claim, current) {
        planned++;
        h.op().noteStopRequest(mode);
        current!();
        assert.fail("Stop must end staging before departure");
      },
    });
    assert.equal(await h.haul(), "idle");
    assert.equal(await h.haul(), "idle");
    assert.equal(planned, 1);
    assert.deepEqual(sim.calls, []);
    assert.deepEqual(sim.routes, []);
  });

test("MCC claim remains cancellable when stale range requires a fresh scene before pickup", async (t) => {
  const sim = simulator(3, 13);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let readyToPickup = false,
    observedDispatch: boolean | undefined;
  let h!: ReturnType<typeof batchedHaul>;
  const fetch = sim.run.fetch;
  sim.run.fetch = async (input: string | URL) => {
    if (readyToPickup && new URL(input).pathname === "/api/bridge/space/snapshot") {
      observedDispatch = h.state().haulClaims["100"]?.dispatched;
      throw Error("Pickup scene unavailable");
    }
    return fetch(input);
  };
  h = batchedHaul(sim, [ore], 1, {
    claimPickup: async () => {
      now += 1501;
      readyToPickup = true;
    },
    navigateToTarget: async () => {},
  });
  await assert.rejects(h.haul(), /Pickup scene unavailable/);
  assert.equal(observedDispatch, false);
  assert.deepEqual(h.state().haulClaims, {});
  assert.equal(
    sim.calls.some((c: any) => c.method === "Add"),
    false,
  );
  assert.equal(sim.getSource()[0]?.quantity, 10);
  readyToPickup = false;
  sim.setSource([]);
  assert.equal(await h.haul(), "missing");
  assert.deepEqual(h.state().manifests, []);
  assert.deepEqual(h.state().haulClaims, {});
  assert.equal(
    sim.calls.some((c: any) => c.method === "Add"),
    false,
  );
});

test("two native-shaped MCC haulers split cans and batch to separate 90% thresholds", async () => {
  const x = { ...ore, quantity: 4 },
    y = { ...ore, itemID: 21, locationID: 101, quantity: 8 };
  const world: FreightWorld = { source: [{ ...x }], corp: [] };
  const a = simulator(3, 13, world),
    b = simulator(4, 14, world);
  a.setCapacities(100, 10);
  b.setCapacities(100, 20);
  a.setCanDistance(4000);
  let approaching!: () => void,
    resume!: () => void,
    approachesA = 0,
    approachesB = 0;
  const started = new Promise<void>((resolve) => {
    approaching = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  a.session.flow.flying.approachShip = async (id: number) => {
    assert.equal(id, 100);
    approachesA++;
    approaching();
    await proceed;
    a.setCanDistance(100);
  };
  b.session.flow.flying.approachShip = async () => {
    approachesB++;
  };
  const h = batchedHaul(a, [x], 1, undefined, b),
    first = h.haul();
  try {
    await Promise.race([
      started,
      first.then(() => assert.fail("A never approached the claimed can")),
    ]);
    assert.equal(h.state().haulClaims["100"]?.characterID, 3);
    assert.equal(await h.peerHaul(), "idle");
    assert.equal(
      b.calls.some((c: any) => c.method === "Add"),
      false,
    );
    assert.equal(approachesB, 0);
    world.source.push({ ...y });
    h.publish([y]);
    assert.equal(await h.peerHaul(), "waiting");
    assert.equal(h.state().haulClaims["101"], undefined);
    assert.equal(
      h.state().manifests.find((m) => m.containerID === 101)?.closedPickup?.characterID,
      4,
    );
    assert.equal(b.getHeld()[0]?.quantity, 8);
  } finally {
    resume();
  }
  assert.equal(await first, "waiting");
  assert.equal(a.getHeld()[0]?.quantity, 4);
  assert.equal(approachesA, 1);
  assert.equal(approachesB, 0);
  assert.equal(world.corp.length, 0);
  const aTail = { ...ore, itemID: 22, locationID: 102, quantity: 5 };
  world.source.push({ ...aTail });
  h.publish([aTail]);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(a.routes, [600]);
  assert.deepEqual(b.routes, []);
  assert.equal(world.corp[0]?.quantity, 9);
  const bTail = { ...ore, itemID: 23, locationID: 103, quantity: 10 };
  world.source.push({ ...bTail });
  h.publish([bTail]);
  assert.equal(await h.peerHaul(), "delivered");
  assert.deepEqual(b.routes, [600]);
  const pickups = (sim: ReturnType<typeof simulator>, shipID: number) =>
    sim.calls.filter((c: any) => c.method === "Add" && c.of === shipID).map((c: any) => c.args[1]);
  assert.deepEqual(pickups(a, 13), [100, 102]);
  assert.deepEqual(pickups(b, 14), [101, 103]);
  assert.equal(world.corp[0]?.quantity, 27);
  assert.equal(world.source.length, 0);
  assert.deepEqual(a.getHeld(), []);
  assert.deepEqual(b.getHeld(), []);
  assert.equal(h.receipts().length, 4);
  assert.deepEqual(h.state().haulClaims, {});
});

test("Hauler drains its nearby cans before crossing to the other group", async () => {
  const rows = [
    { ...ore, quantity: 2 },
    { ...ore, itemID: 21, locationID: 101, quantity: 2 },
    { ...ore, itemID: 22, locationID: 102, quantity: 2 },
    { ...ore, itemID: 23, locationID: 103, quantity: 2 },
  ];
  const sim = simulator(3, 13, { source: structuredClone(rows), corp: [] });
  const distances = new Map([
    [100, 100],
    [101, 35000],
    [102, 500],
    [103, 35500],
  ]);
  const passes: number[] = [],
    fetch = sim.run.fetch;
  let shipX = 0,
    capacityReads = 0,
    staticReads = 0;
  sim.run.fetch = async (input: unknown) => {
    const path = new URL(String(input)).pathname,
      response = await fetch(input);
    if (path === "/api/bridge/ship/13/bays") capacityReads++;
    if (path === "/api/types/volumes") staticReads++;
    if (path !== "/api/bridge/space/snapshot") return response;
    const body = await response.json();
    body.space.ship.position.x = shipX;
    for (const entity of body.space.entities) entity.position.x = distances.get(entity.itemID);
    return Response.json(body);
  };
  sim.session.flow.flying.approachShip = async (id: number) => {
    passes.push(id);
    shipX = distances.get(id)!;
  };
  const h = batchedHaul(sim, rows, 1);
  assert.equal(await h.haul(), "waiting");
  const pickups = sim.calls
    .filter((c: any) => c.method === "Add" && c.of === 13)
    .map((c: any) => c.args[1]);
  assert.deepEqual(pickups, [100, 102, 101, 103]);
  assert.deepEqual(passes, [101]);
  assert.equal(capacityReads, 4, "one hold panel per pickup, including the selection");
  assert.equal(staticReads, 1, "same ore type facts are reused");
  assert.equal(
    sim.getHeld().reduce((n, r) => n + r.quantity, 0),
    8,
  );
  assert.deepEqual(sim.routes, []);
});

test("Hauler keeps the verified pickup grid when the visible belt is over 20 km away", async () => {
  const sim = simulator(3, 13);
  const fetch = sim.run.fetch;
  sim.run.fetch = async (input: URL) => {
    const response = await fetch(input);
    if (new URL(String(input)).pathname !== "/api/bridge/space/snapshot") return response;
    const view = await response.json();
    view.space.entities.push({
      itemID: 99,
      kind: "asteroidBelt",
      groupID: 9,
      name: target.name,
      position: { x: 40_000, y: 0, z: 0 },
      radius: 10,
    });
    return Response.json(view);
  };
  let arrivals = 0;
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
    async navigateToTarget() {
      arrivals++;
    },
  });
  await native.waitAtBelt!(target, claim, () => {});
  await native.waitAtBelt!(target, claim, () => {});
  assert.equal(arrivals, 1);
  await native.waitAtBelt!(target, { ...claim, generation: 2 }, () => {});
  assert.equal(arrivals, 2);
});

test("an already reachable can reuses the native flight and scene before opening its inventory", async () => {
  const sim = simulator(3, 13),
    fetch = sim.run.fetch,
    checks: string[] = [];
  sim.run.fetch = async (input: URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/bridge/flight/status" || path === "/api/bridge/space/snapshot")
      checks.push(path);
    return fetch(input);
  };
  const native = createNativeHauler(sim.run, sim.session, {
    shipID: 13,
    corporationID: 77,
    division: 1,
    current() {},
  });
  await native.navigateAndVerify(manifest, target, claim);
  assert.deepEqual(checks, ["/api/bridge/flight/status", "/api/bridge/space/snapshot"]);
  assert.deepEqual(
    sim.reads.filter((read) => read.of === 100).map((read) => read.method),
    ["List"],
  );
});

test("an unloaded Hauler verifies the pickup site again and serves a new can in the same operation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const sim = simulator(3, 13);
  sim.setCapacities(10, 0);
  let atPickup = false,
    siteChecks = 0;
  const fetch = sim.run.fetch;
  sim.run.fetch = async (input: unknown) => {
    const response = await fetch(input);
    if (new URL(String(input)).pathname !== "/api/bridge/space/snapshot") return response;
    const body = await response.json();
    if (!atPickup) body.space.entities = [];
    body.space.entities.push({
      itemID: 99,
      groupID: 9,
      name: target.name,
      position: { x: atPickup ? 0 : 40000, y: 0, z: 0 },
      radius: 10,
    });
    return Response.json(body);
  };
  const h = batchedHaul(sim, [], 1, {
    claimPickup: async () => {},
    async navigateToTarget() {
      siteChecks++;
      sim.setInSpace();
      atPickup = true;
    },
  });
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 10);
  assert.deepEqual(h.state().haulClaims, {});

  // The same named belt is still visible from outside the original pickup grid.
  sim.setSource([{ ...ore, itemID: 21, locationID: 101 }]);
  sim.setInSpace();
  atPickup = false;
  t.mock.timers.tick(5001);
  assert.equal(await h.haul(), "delivered");
  assert.equal(siteChecks, 2);
  assert.equal(sim.getCorp()[0]?.quantity, 20);
  assert.deepEqual(h.state().haulClaims, {});
});

test("two in-range cans use stock ship hold reads and never reopen an emptied can", async () => {
  const rows = [
    { ...ore, quantity: 2 },
    { ...ore, itemID: 21, locationID: 101, quantity: 3 },
  ];
  const sim = simulator(3, 13, { source: structuredClone(rows), corp: [] });
  sim.session.flow.flying.approachShip = async () => assert.fail("already in pickup range");
  const haul = batchedHaul(sim, rows, 1);
  assert.equal(await haul.haul(), "waiting");
  assert.deepEqual(
    sim.reads.filter((r) => r.of === 13).map((r) => r.method),
    Array(18).fill("List"),
  );
  assert.deepEqual(
    sim.reads.filter((r) => r.method === "List" && [100, 101].includes(r.of)).map((r) => r.of),
    [100, 101],
  );
  assert.equal(
    sim.getHeld().reduce((sum, row) => sum + row.quantity, 0),
    5,
  );
  assert.deepEqual(sim.routes, []);
});

test("three concurrent Haulers reserve and pick up different nearby cans discovered on grid", async () => {
  const rows = [
    ore,
    { ...ore, itemID: 21, locationID: 101 },
    { ...ore, itemID: 22, locationID: 102 },
  ];
  const world: FreightWorld = { source: structuredClone(rows), corp: [] };
  const a = simulator(3, 13, world),
    b = simulator(4, 14, world),
    c = simulator(5, 15, world);
  for (const sim of [a, b, c]) sim.setCapacities(100, 10);
  const h = batchedHaul(
    a,
    [],
    1,
    { navigateToTarget: async () => {}, gridLootFleet: () => ({ memberIDs: [1], fleetID: 555 }) },
    b,
    c,
  );
  h.op().noteStopRequest("COLLECT_FREIGHT");
  await h.scanFinal();
  assert.equal(h.state().manifests.filter((row) => row.source === "observed-jetcan").length, 3);
  h.op().requestStop();
  assert.deepEqual(await Promise.all([h.haul(), h.peerHaul(), h.thirdHaul()]), [
    "delivered",
    "delivered",
    "delivered",
  ]);
  const picked = [a, b, c].flatMap((sim, i) =>
    sim.calls.filter((x: any) => x.method === "Add" && x.of === 13 + i).map((x: any) => x.args[1]),
  );
  assert.deepEqual(picked.sort(), [100, 101, 102]);
  assert.equal(
    world.corp.reduce((n, r) => n + r.quantity, 0),
    30,
  );
  assert.deepEqual(h.state().haulClaims, {});
});

test("a second MCC hauler cannot replay a pickup with a lost response", async () => {
  const x = { ...ore, quantity: 9 },
    world: FreightWorld = { source: [{ ...x }], corp: [] };
  const a = simulator(3, 13, world),
    b = simulator(4, 14, world);
  a.setCapacities(100, 10);
  a.setPickupLost();
  const h = batchedHaul(a, [x], 1, undefined, b);
  await assert.rejects(h.haul(), /pickup acknowledgement lost/);
  assert.equal(h.state().haulClaims["100"]?.dispatched, true);
  assert.equal(a.getHeld()[0]?.quantity, 9);
  assert.equal(world.source.length, 0);
  assert.equal(await h.peerHaul(), "idle");
  assert.equal(
    b.calls.some((c: any) => c.method === "Add"),
    false,
  );
  assert.equal(await h.haul(), "delivered");
  assert.equal(a.calls.filter((c: any) => c.method === "Add" && c.of === 13).length, 1);
  assert.equal(world.corp[0]?.quantity, 9);
  assert.deepEqual(h.state().haulClaims, {});
  assert.equal(await h.peerHaul(), "idle");
});

test("ACTIVE Hauler waits below 90% across reattach, then delivers at 170,100 m3", async () => {
  const sim = simulator(3, 13),
    first = { ...ore, quantity: 3563 };
  sim.setSource([structuredClone(first)]);
  sim.setCapacities(1100, 189000);
  sim.setFamily("ore", 3);
  const h = batchedHaul(sim, [first], 3);
  assert.equal(await h.haul(), "waiting");
  assert.deepEqual(sim.routes, []);
  assert.equal(sim.getCorp().length, 0);
  assert.equal(sim.getSource().length, 0);
  assert.deepEqual(h.state().haulClaims, {});
  assert.equal(h.state().manifests[0]?.closedPickup?.characterID, 3);
  h.restart();
  assert.equal(await h.haul(), "waiting");

  const next = [18000, 18000, 17136].map((quantity, i) => ({
    ...ore,
    itemID: 21 + i,
    locationID: 101 + i,
    quantity,
  }));
  sim.setSource(structuredClone(next));
  h.publish(next);
  assert.equal(await h.haul(), "waiting");
  assert.deepEqual(sim.routes, []);
  assert.equal(sim.getCorp().length, 0);
  assert.equal(
    sim.calls
      .filter((x: any) => x.method === "Add" && x.of === 13)
      .reduce<number>((n, x: any) => n + x.kwargs.qty, 0) * 3,
    170097,
  );

  const last = { ...ore, itemID: 24, locationID: 104, quantity: 1 };
  sim.setSource([structuredClone(last)]);
  h.publish([last]);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.routes, [600]);
  assert.equal(sim.getCorp()[0]?.quantity, 56700);
  assert.equal(h.receipts().length, 5);
  assert.deepEqual(h.state().haulClaims, {});
});

for (const mode of ["RETURN_HOME", "COLLECT_FREIGHT"] as const)
  test("Stop " + mode + " settles a waiting partial load", async () => {
    const sim = simulator(3, 13),
      first = { ...ore, quantity: 4 };
    sim.setSource([structuredClone(first)]);
    sim.setCapacities(100, 100);
    const h = batchedHaul(sim, [first], 1);
    assert.equal(await h.haul(), "waiting");
    const last = { ...ore, itemID: 21, locationID: 101, quantity: 3 };
    sim.setSource([structuredClone(last)]);
    h.publish([last]);
    h.op().noteStopRequest(mode);
    if (mode === "COLLECT_FREIGHT") {
      assert.deepEqual(sim.routes, []);
    }
    h.op().requestStop();
    if (mode === "RETURN_HOME") {
      assert.equal(await h.haul(), "idle");
      assert.deepEqual(sim.routes, []);
      assert.equal(sim.getCorp().length, 0);
      assert.equal(sim.getHeld()[0]?.quantity, 4);
      assert.deepEqual(h.receipts(), []);
      // The saved parking policy owns the only remaining unload, using the actual ship hold.
      await sim.session.flow.startRoute(600);
      const receipt = await unloadParkingFreight(sim.run, sim.session, {
        operationID: "op",
        runID: "run",
        shipID: 13,
        delivery: {
          kind: "station",
          systemID: 300,
          destinationID: 600,
          corporationID: 77,
          division: 1,
        },
        document: sim.tripDocument(),
        current() {},
      });
      assert.equal(receipt?.source.items[0]?.quantity, 4);
      assert.deepEqual(sim.getHeld(), []);
    } else assert.equal(await h.haul(), "delivered");
    assert.deepEqual(sim.routes, [600]);
    assert.equal(sim.getCorp()[0]?.quantity, mode === "RETURN_HOME" ? 4 : 7);
    assert.equal(sim.getSource().length, mode === "RETURN_HOME" ? 1 : 0);
    assert.deepEqual(h.state().haulClaims, {});
  });

test("failed loot-memory cleanup does not prevent delivery of verified cargo", async () => {
  const sim = simulator(3, 13),
    rows = [{ ...ore, quantity: 6 }];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(1, 6);
  let releaseAttempts = 0,
    markAttempts = 0;
  const h = batchedHaul(sim, rows, 1, {
    claimPickup: async () => {},
    releasePickup: async () => {
      releaseAttempts++;
      throw new Error("The stale claim was already released.");
    },
    afterPickup: async () => {
      markAttempts++;
      throw new Error("Loot memory unavailable.");
    },
  });
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 6);
  assert.equal(sim.getSource().length, 0);
  assert.equal(releaseAttempts, 1);
  assert.equal(markAttempts, 1);
  assert.equal(sim.calls.filter((c: any) => c.method === "Add" && c.of === 13).length, 1);
});

test("spare ore hold batches compatible cans and verifies exact portions of a merged stack", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, locationID: 101, quantity: 5 },
    ];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(300, 10);
  sim.mergeCargo();
  const h = batchedHaul(sim, rows, 1);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.routes, [600]);
  assert.deepEqual(
    sim.calls
      .filter((x: any) => x.method === "Add")
      .map((x: any) => [x.of, x.args[0], x.kwargs.qty]),
    [
      [13, 20, 4],
      [13, 21, 5],
      [700, 20, 9],
    ],
  );
  assert.equal(sim.getCorp()[0]?.quantity, 9);
  assert.deepEqual(
    h.state().manifests.map((m) => m.delivered),
    [true, true],
  );
  assert.equal(await h.haul(), "idle");
});

test("two Hauler trips unload mixed ore into the selected division with one MultiAdd each", async () => {
  const sim = simulator(3, 13),
    first = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, typeID: 32, quantity: 5 },
    ];
  const tools = {
    ...ore,
    itemID: 500,
    typeID: 90,
    categoryID: 7,
    ownerID: 3,
    locationID: 13,
    flagID: 5,
    quantity: 1,
  };
  sim.setDivision(3);
  sim.setCapacities(100, 10);
  sim.setSource(structuredClone(first));
  sim.setHeld([tools]);
  const h = batchedHaul(sim, first, 1);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.getHeld(), [tools]);
  assert.deepEqual(
    sim.reads.filter((r) => r.docked && r.method === "List").map((r) => r.of),
    [13, 13, 13, 13, 13, 13, 700, 700, 13, 13, 13, 13, 13, 13],
  );
  const second = [
    { ...first[0]!, itemID: 23, locationID: 101 },
    { ...first[1]!, itemID: 24, locationID: 101 },
  ];
  sim.setSource(structuredClone(second));
  h.publish(second);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.routes, [600, 600]);
  assert.deepEqual(sim.getHeld(), [tools]);
  assert.deepEqual(
    sim.calls.filter((x: any) => x.of === 700).map((x: any) => [x.method, x.args, x.kwargs]),
    [
      ["MultiAdd", [[20, 21], 13], { flag: 117 }],
      ["MultiAdd", [[23, 24], 13], { flag: 117 }],
    ],
  );
  assert.deepEqual(
    sim.getCorp().map((r) => [r.typeID, r.quantity, r.flagID]),
    [
      [30, 8, 117],
      [32, 10, 117],
    ],
  );
  assert.deepEqual(
    h.receipts().map((r) => r.deliveryBatches?.[0]?.items?.map((i) => i.quantity)),
    [
      [4, 5],
      [4, 5],
    ],
  );
  const trips = h.receipts().map((r) => r.deliveryBatches?.[0]?.tripID);
  assert.ok(trips.every(Boolean));
  assert.equal(new Set(trips).size, 2);
});

test("MCC captures the division delta before another pilot takes stacked ore during the ship readback", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, typeID: 32, quantity: 5 },
    ];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(9, 0);
  const existing = { ...ore, itemID: 800, ownerID: 77, locationID: 700, flagID: 115, quantity: 20 };
  const division = sim.getCorp();
  division.push(existing);
  const { bridgeDo, bridgeAsk } = sim.session.flow.flying;
  let unloaded = false,
    withdrew = false;
  sim.session.flow.flying.bridgeDo = async (...args: any[]) => {
    const result = await bridgeDo(...args);
    if (args[0] === "invbroker" && args[1] === "MultiAdd" && args[4] === 700) unloaded = true;
    return result;
  };
  sim.session.flow.flying.bridgeAsk = async (...args: any[]) => {
    if (unloaded && !withdrew && args[0] === "invbroker" && args[1] === "List" && args[4] === 13) {
      existing.quantity -= 7;
      withdrew = true;
    }
    return bridgeAsk(...args);
  };
  const haul = batchedHaul(sim, rows, 1);
  assert.equal(await haul.haul(), "delivered");
  assert.ok(withdrew);
  assert.equal(existing.quantity, 17);
  assert.equal(haul.totals()?.deliveredUnits, 9);
  assert.equal(haul.totals()?.trips, 1);
  assert.equal(sim.calls.filter((c: any) => c.of === 700 && c.method === "MultiAdd").length, 1);
  assert.deepEqual(sim.getHeld(), []);
});

for (const movement of ["deposit", "withdrawal", "empty division after restart"] as const) {
  test("acknowledged Hauler unload survives a concurrent " + movement, async () => {
    const sim = simulator(3, 13),
      rows = [
        { ...ore, quantity: 4 },
        { ...ore, itemID: 21, quantity: 6 },
      ];
    sim.setSource(structuredClone(rows));
    sim.setCapacities(10, 0);
    const division = sim.getCorp();
    if (movement !== "empty division after restart")
      division.push({
        ...ore,
        itemID: 80,
        ownerID: 77,
        locationID: 700,
        flagID: 115,
        quantity: 100,
      });
    else sim.loseDepositReads(2);
    const act = sim.session.flow.flying.bridgeDo;
    sim.session.flow.flying.bridgeDo = async (...args: any[]) => {
      const result = await act(...args);
      if (args[1] === "MultiAdd" && args[4] === 700) {
        if (movement === "empty division after restart") division.splice(0);
        else division[0]!.quantity += movement === "deposit" ? 8 : -17;
      }
      return result;
    };
    const h = batchedHaul(sim, rows, 1);
    if (movement === "empty division after restart") {
      await assert.rejects(h.haul(), /Deposit inventory unavailable/);
      assert.equal(
        (h.tripDocument(h.state().manifests[0]!).read() as any).pending.acknowledged,
        true,
      );
      assert.equal(h.totals()?.deliveredUnits, 0);
      h.restart();
    }
    assert.equal(await h.haul(), "delivered");
    assert.deepEqual(sim.getHeld(), []);
    assert.deepEqual(
      division.map((row) => row.quantity),
      movement === "deposit" ? [118] : movement === "withdrawal" ? [93] : [],
    );
    assert.equal(h.totals()?.deliveredUnits, 10);
    assert.equal(h.receipts().length, 1);
    h.restart();
    assert.equal(h.totals()?.trips, 1);
    assert.equal(h.totals()?.deliveredUnits, 10);
    assert.equal(sim.calls.filter((c: any) => c.of === 700 && c.method === "MultiAdd").length, 1);
  });
}

for (const method of ["Add", "MultiAdd"] as const)
  test(
    "a retained " + method + " credits exact office items after unrelated cargo changes",
    async () => {
      const sim = simulator(3, 13);
      const rows =
        method === "Add"
          ? [ore]
          : [
              { ...ore, quantity: 4 },
              { ...ore, itemID: 21, typeID: 32, quantity: 6 },
            ];
      sim.setSource(structuredClone(rows));
      sim.setCapacities(10, 0);
      sim.setDeliveryLost();
      const h = batchedHaul(sim, rows, 1);
      if (method === "Add") {
        const can = h.state().manifests[0]!,
          owner = h.op().claimContainer(3, can.containerID)!;
        const native = createNativeHauler(sim.run, sim.session, {
          shipID: 13,
          corporationID: 77,
          division: 1,
          current() {},
          tripDocument: h.tripDocument,
          pollMs: 1,
        });
        await native.navigateAndVerify(can, target, h.claim);
        assert.ok(h.op().dispatchHaul(3, can.containerID, owner.generation));
        await assert.rejects(
          native.transferAndDeliver(can, owner.generation, 600),
          /acknowledgement lost/,
        );
      } else {
        sim.loseDepositReads(2);
        await assert.rejects(h.haul(), /Deposit inventory unavailable/);
      }
      assert.deepEqual(sim.getHeld(), []);
      assert.deepEqual(
        sim.getCorp().map((r) => [r.itemID, r.ownerID, r.locationID, r.flagID]),
        rows.map((r) => [r.itemID, 77, 700, 115]),
      );
      assert.equal(h.totals()?.deliveredUnits, 0);
      const equipment = {
        ...ore,
        itemID: 82,
        typeID: 800,
        categoryID: 7,
        ownerID: 3,
        locationID: 13,
        flagID: 5,
        quantity: 1,
      };
      sim.setHeld([equipment]);
      h.restart();
      const ask = sim.session.flow.flying.bridgeAsk;
      let divisionReads = 0;
      sim.session.flow.flying.bridgeAsk = async (...args: any[]) => {
        if (args[1] === "List" && args[4] === 700 && ++divisionReads === 1)
          throw Object.assign(Error("Temporary division read failure"), { status: 502 });
        return ask(...args);
      };
      assert.equal(await h.haul(), "delivered");
      assert.equal(divisionReads, 2);
      assert.deepEqual(sim.getHeld(), [equipment]);
      assert.deepEqual(
        h.receipts().map((r) => r.deliveryBatches?.[0]?.acknowledged),
        [false],
      );
      h.restart();
      assert.equal(h.totals()?.deliveredUnits, 10);
      assert.equal(h.totals()?.trips, 1);
      assert.deepEqual(
        sim.calls
          .filter((c: any) => c.of === 700 && ["Add", "MultiAdd"].includes(c.method))
          .map((c: any) => c.method),
        [method],
      );
    },
  );

test("a refused MultiAdd keeps its game reason until both can journals confirm zero movement", async () => {
  const sim = simulator(3, 13);
  const rows = [{ ...ore, quantity: 4 }, { ...ore, locationID: 101, itemID: 21, quantity: 6 }];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(10, 0);
  const flying = sim.session.flow.flying;
  const act = flying.bridgeDo, ask = flying.bridgeAsk;
  let attempts = 0, unavailable = false;
  flying.bridgeDo = async (...args: any[]) => {
    if (args[1] === "MultiAdd" && args[4] === 700 && ++attempts === 1) {
      unavailable = true;
      throw Object.assign(Error("Not enough hangar space"), {
        status: 409, code: "CALL_REFUSED", refusal: { key: "NotEnoughCargoSpace" },
      });
    }
    return act(...args);
  };
  flying.bridgeAsk = async (...args: any[]) => {
    if (unavailable && args[1] === "List")
      throw Object.assign(Error("Unload inventory unavailable"), { status: 503 });
    return ask(...args);
  };

  const h = batchedHaul(sim, rows, 1);
  await assert.rejects(h.haul(), /Unload inventory unavailable/);
  const state = h.state();
  const docs = state.manifests.map((m) => h.tripDocument(m, haulOwner(state, m)!.generation));
  assert.equal(docs.length, 2);
  assert.ok(docs.every((doc) => (doc.read() as any).pending.refusalReason === "Not enough hangar space"));
  unavailable = false;
  h.restart();
  await assert.rejects(h.haul(), /Not enough hangar space/);
  assert.ok(docs.every((doc) => (doc.read() as any).pending === null));
  assert.equal(attempts, 1);
  assert.equal(h.totals()?.deliveredUnits, 0);
  assert.deepEqual(sim.getCorp(), []);
  assert.equal(await h.haul(), "delivered");
  assert.equal(attempts, 2);
  assert.equal(h.totals()?.deliveredUnits, 10);
});

for (const returnHome of [false, true]) {
  const phase = returnHome ? "during Return Home" : "during delivery";
  test("Check and release frees one shared MultiAdd after restart " + phase, async () => {
    const sim = simulator(3, 13);
    const rows = [{ ...ore, quantity: 4 }, { ...ore, locationID: 101, itemID: 21, quantity: 6 }];
    sim.setSource(structuredClone(rows));
    sim.setCapacities(10, 0);
    const act = sim.session.flow.flying.bridgeDo;
    let attempts = 0;
    sim.session.flow.flying.bridgeDo = async (...args: any[]) => {
      if (args[1] === "MultiAdd" && args[4] === 700 && ++attempts === 1)
        throw Object.assign(Error("Response timed out"), { code: "CALL_TIMEOUT" });
      return act(...args);
    };
    const h = batchedHaul(sim, rows, 1);
    await assert.rejects(h.haul(), FleetObservationUnavailable);
    h.restart();
    if (returnHome) h.op().noteStopRequest("RETURN_HOME");
    const state = h.state();
    const docs = state.manifests.map((m) => h.tripDocument(m, haulOwner(state, m)!.generation));
    const blocked = await h.haul().catch((error: unknown) => error);
    assert.ok(blocked instanceof UnconfirmedHaulerUnload);
    const held = structuredClone(sim.getHeld());
    assert.equal(held.length, 2);
    assert.equal(docs.length, 2);
    assert.ok(docs.every((doc) => (doc.read() as any).pending?.kind === "delivery"));
    sim.setHeld(held.slice(1));
    await assert.rejects(blocked.checkAndRelease(), /no replay/);
    assert.ok(docs.every((doc) => (doc.read() as any).pending));
    assert.equal(attempts, 1);
    sim.setHeld(held);
    await blocked.checkAndRelease();
    assert.ok(docs.every((doc) => (doc.read() as any).pending === null));
    assert.equal(h.totals()?.deliveredUnits, 0);
    assert.equal(attempts, 1);
    if (returnHome) {
      assert.equal(await h.haul(), "idle");
      assert.equal(attempts, 1);
      assert.equal(h.totals()?.deliveredUnits, 0);
      assert.deepEqual(sim.getHeld(), held);
    } else {
      assert.equal(await h.haul(), "delivered");
      assert.equal(attempts, 2);
      assert.equal(h.totals()?.deliveredUnits, 10);
    }
  });
}

test("a late unacknowledged unload is rechecked once and never sent again from unchanged evidence", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, quantity: 6 },
    ];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(10, 0);
  const act = sim.session.flow.flying.bridgeDo;
  let attempts = 0;
  sim.session.flow.flying.bridgeDo = async (...args: any[]) => {
    if (args[1] === "MultiAdd" && args[4] === 700) {
      attempts++;
      throw Object.assign(Error("Response timed out"), { code: "CALL_TIMEOUT" });
    }
    return act(...args);
  };
  const h = batchedHaul(sim, rows, 1),
    doc = h.tripDocument(h.state().manifests[0]!);
  await assert.rejects(h.haul(), FleetObservationUnavailable);
  assert.equal((doc.read() as any).pending.acknowledged, false);
  h.restart();
  const blocked = await h.haul().catch((error: unknown) => error);
  assert.ok(blocked instanceof UnconfirmedHaulerUnload);
  assert.match(blocked.message, /Check item IDs 20, 21 in ship 13 and corporation division 1 at dock 600/);
  assert.equal(h.totals()?.deliveredUnits, 0);
  assert.equal(attempts, 1);
  // Empty holds alone cannot locate a timed-out move.
  sim.setHeld([]);
  await assert.rejects(
    h.haul(),
    (e: Error) =>
      !(e instanceof FleetObservationUnavailable) && /unknown; no replay/.test(e.message),
  );
  assert.equal(attempts, 1);
  assert.equal(h.totals()?.deliveredUnits, 0);
  // The delayed transfer and another pilot's same-type deposit become visible in the original division.
  sim.getCorp().push(...rows.map((r) => ({ ...r, ownerID: 77, locationID: 700, flagID: 115 })));
  sim.getCorp()[0]!.quantity += 8;
  await blocked.checkAndRelease();
  assert.ok((doc.read() as any).pending, "a late delivery still needs its original receipt");
  assert.equal(attempts, 1);
  assert.equal(await h.haul(), "delivered");
  assert.equal(attempts, 1);
  assert.equal(h.receipts()[0]?.deliveryBatches?.[0]?.acknowledged, false);
  h.restart();
  assert.equal(h.totals()?.deliveredUnits, 10);
  assert.equal(h.totals()?.trips, 1);
});

test("an acknowledged partial MultiAdd credits only the departed stacks during a concurrent withdrawal", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, quantity: 6 },
    ];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(10, 0);
  sim.limitDeposit(1);
  const stock = { ...ore, itemID: 90, quantity: 40, ownerID: 77, locationID: 700, flagID: 115 };
  sim.getCorp().push(stock);
  const act = sim.session.flow.flying.bridgeDo;
  sim.session.flow.flying.bridgeDo = async (...args: any[]) => {
    const result = await act(...args);
    if (args[1] === "MultiAdd" && args[4] === 700) stock.quantity -= 12;
    return result;
  };
  const h = batchedHaul(sim, rows, 1);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(
    sim.calls.filter((c: any) => c.of === 700).map((c: any) => [c.method, c.args[0]]),
    [
      ["MultiAdd", [20, 21]],
      ["Add", 21],
    ],
  );
  assert.deepEqual(
    h.receipts()[0]?.deliveryBatches?.map((b) => b.item.quantity),
    [4, 6],
  );
  assert.equal(stock.quantity, 38);
  assert.deepEqual(sim.getHeld(), []);
  h.restart();
  assert.equal(h.totals()?.deliveredUnits, 10);
  assert.equal(h.totals()?.trips, 1);
});

test("a delivery keeps progressing beyond the old whole-route timeout", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, typeID: 32, quantity: 5 },
    ];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(100, 10);
  let routing = false,
    reads = 0;
  const fetch = sim.run.fetch;
  sim.session.flow.startRoute = async () => {
    routing = true;
    return { started: true };
  };
  sim.session.flow.flying.autopilotProgress = () => ({
    status: "running",
    remainingJumps: Math.max(0, 4 - reads),
  });
  sim.run.fetch = async (input: unknown, init?: RequestInit) => {
    if (routing && new URL(String(input)).pathname === "/api/bridge/flight/status") {
      t.mock.timers.tick(20);
      if (++reads === 5) {
        sim.setDocked();
        routing = false;
      }
    }
    return fetch(input, init);
  };
  const h = batchedHaul(sim, rows, 1, { timeoutMs: 35 });
  assert.equal(await h.haul(), "delivered");
  assert.equal(reads, 5);
  assert.equal(sim.getCorp().length, 2);
  assert.equal(sim.calls.filter((x: any) => x.method === "MultiAdd" && x.of === 13).length, 1);
});

test("a stalled delivery resumes after WC restart from its current dock and hold without repeating pickup", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, typeID: 32, quantity: 5 },
    ];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(100, 10);
  let routing = false;
  const fetch = sim.run.fetch;
  sim.session.flow.startRoute = async () => {
    routing = true;
    return { started: true };
  };
  sim.session.flow.flying.autopilotProgress = () => ({ status: "running" });
  sim.run.fetch = async (input: unknown, init?: RequestInit) => {
    if (routing && new URL(String(input)).pathname === "/api/bridge/flight/status")
      t.mock.timers.tick(36);
    return fetch(input, init);
  };
  const h = batchedHaul(sim, rows, 1, { timeoutMs: 35 });
  await assert.rejects(h.haul(), FleetObservationUnavailable);
  assert.equal(sim.getSource().length, 0);
  assert.equal(sim.getCorp().length, 0);
  assert.equal(
    sim.getHeld().reduce((sum: number, row: { quantity: number }) => sum + row.quantity, 0),
    9,
  );
  sim.setDocked();
  routing = false;
  h.restart();
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.calls.filter((x: any) => x.method === "MultiAdd" && x.of === 13).length, 1);
  assert.equal(sim.calls.filter((x: any) => x.method === "MultiAdd" && x.of === 700).length, 1);
  assert.equal(Object.keys(h.state().haulClaims).length, 0);
});

test("a transient route origin failure keeps the cause and resumes with the ore already aboard", async () => {
  const sim = simulator(3, 13),
    rows = [{ ...ore, quantity: 10 }];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(1, 6);
  const start = sim.session.flow.startRoute;
  const cause = Object.assign(Error("Gateway timeout after jump"), { code: "CALL_TIMEOUT" });
  sim.session.flow.startRoute = async () => ({
    started: false,
    reason: "Could not read your location",
    cause,
  });
  const h = batchedHaul(sim, rows, 1);
  await assert.rejects(
    h.haul(),
    (error: Error) =>
      error instanceof FleetObservationUnavailable && (error.cause as Error)?.cause === cause,
  );
  assert.equal(sim.getHeld()[0]?.quantity, 6);
  assert.equal(sim.getCorp().length, 0);
  sim.session.flow.startRoute = start;
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 6);
  assert.equal(sim.calls.filter((c: any) => c.method === "Add" && c.of === 13).length, 1);
});

for (const phase of ["pickup", "unload"] as const)
  test(`a confirmed lane refusal before ${phase} allows the next pass without a duplicate transfer`, async () => {
    const sim = simulator(3, 13);
    const rows = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, typeID: 32, quantity: 5 },
    ];
    sim.setSource(structuredClone(rows));
    sim.setCapacities(9, 0);
    const write = sim.session.flow.flying.bridgeDo;
    let refused = false;
    sim.session.flow.flying.bridgeDo = async (...args: any[]) => {
      if (
        !refused &&
        args[0] === "invbroker" &&
        args[1] === "MultiAdd" &&
        args[4] === (phase === "pickup" ? 13 : 700)
      ) {
        refused = true;
        throw Object.assign(
          Error(
            "/api/bridge/call never got a connection: it waited 20s for one of the browser's 4 request lanes.",
          ),
          { code: "BRIDGE_NETWORK_ERROR", status: 0 },
        );
      }
      return write(...args);
    };
    const h = batchedHaul(sim, rows, 1);
    await assert.rejects(h.haul(), FleetObservationUnavailable);
    assert.ok(refused);
    assert.equal(sim.getCorp().length, 0);
    const saved = h.tripDocument(h.state().manifests[0]!).read() as { pending: unknown };
    assert.equal(saved.pending, null);
    assert.equal(await h.haul(), "delivered");
    assert.equal(
      sim.getCorp().reduce((n, r) => n + r.quantity, 0),
      9,
    );
    assert.deepEqual(
      sim.calls.filter((c: any) => c.method === "MultiAdd").map((c: any) => c.of),
      [13, 700],
    );
  });

test("a temporary read failure after an applied unload reconciles without repeating MultiAdd", async () => {
  const sim = simulator(3, 13);
  const rows = [
    { ...ore, quantity: 4 },
    { ...ore, itemID: 21, typeID: 32, quantity: 5 },
  ];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(9, 0);
  sim.loseDepositReads(2);
  const h = batchedHaul(sim, rows, 1);
  await assert.rejects(h.haul(), /Deposit inventory unavailable/);
  assert.equal(sim.getHeld().length, 0);
  assert.equal(
    sim.getCorp().reduce((n, r) => n + r.quantity, 0),
    9,
  );
  assert.equal(h.totals()?.deliveredUnits, 0);
  // A second pilot deposits a module before the Hauler reads back the lost unload.
  sim
    .getCorp()
    .push({
      ...ore,
      itemID: 6003,
      typeID: 90,
      categoryID: 7,
      ownerID: 77,
      locationID: 700,
      flagID: 115,
      quantity: 1,
    });
  h.restart();
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(
    sim.calls.filter((c: any) => c.method === "MultiAdd").map((c: any) => c.of),
    [13, 700],
  );
  assert.equal(h.totals()?.deliveredUnits, 9);
  assert.equal(h.totals()?.trips, 1);
});

test("Collect Freight reads back a partial MultiAdd after a lost reply and only moves the residue", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, typeID: 32, quantity: 5 },
    ];
  sim.setSource(structuredClone(rows));
  sim.limitDeposit(1);
  sim.setDeliveryLost();
  sim.loseDepositReads(1);
  const h = batchedHaul(sim, rows, 1);
  h.op().noteStopRequest("COLLECT_FREIGHT");
  h.op().requestStop();
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(
    sim.calls.filter((x: any) => x.of === 700).map((x: any) => [x.method, x.args[0]]),
    [
      ["MultiAdd", [20, 21]],
      ["Add", 21],
    ],
  );
  assert.equal(sim.reads.filter((r) => r.docked && r.method === "List").length, 22);
  assert.deepEqual(sim.getHeld(), []);
  assert.deepEqual(
    h.receipts()[0]?.deliveryBatches?.map((b) => b.item.quantity),
    [4, 5],
  );
});

test("a resumed corporation unload empties surplus ore after its can contribution was already moved", async () => {
  const sim = simulator(3, 13),
    rows = [{ ...ore, quantity: 9 }];
  sim.setSource(structuredClone(rows));
  sim.limitDeposit(1);
  sim.loseDepositReads(2);
  // The ore bay is scanned after cargo. A pre-existing ore-bay stack remains
  // after the first move of the can stack in cargo.
  sim.setCapacities(10, 0);
  sim.setHeld([
    { ...ore, itemID: 21, typeID: 32, quantity: 5, ownerID: 3, locationID: 13, flagID: 182 },
  ]);
  const h = batchedHaul(sim, rows, 1);
  await assert.rejects(h.haul(), /Deposit inventory unavailable/);
  assert.deepEqual(
    sim.getHeld().map((r: any) => r.itemID),
    [21],
  );
  h.restart();
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.routes, [600]);
  assert.deepEqual(sim.getHeld(), []);
  assert.deepEqual(
    sim.calls.filter((x: any) => x.of === 700).map((x: any) => [x.method, x.args[0]]),
    [
      ["MultiAdd", [20, 21]],
      ["Add", 21],
    ],
  );
  assert.deepEqual(
    h.receipts()[0]?.deliveryBatches?.map((b) => b.item.quantity),
    [9],
  );
  assert.deepEqual(h.totals()?.unitsByType, { "30": 9, "32": 5 });
  assert.equal(h.totals()?.trips, 1);
});

test("a full Hauler batches different stacks already aboard before taking a can", async () => {
  const sim = simulator(3, 13);
  const held = [
    { ...ore, itemID: 81, quantity: 50 },
    { ...ore, itemID: 82, typeID: 32, quantity: 45 },
  ].map((r) => ({ ...r, ownerID: 3, locationID: 13, flagID: 5 }));
  sim.setHeld(held);
  const h = batchedHaul(sim, [ore], 1);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(
    sim.calls.filter((x: any) => x.of === 700).map((x: any) => [x.method, x.args]),
    [["MultiAdd", [[81, 82], 13]]],
  );
  assert.deepEqual(sim.getHeld(), []);
  assert.deepEqual(sim.getSource(), [ore]);
  assert.equal(h.state().manifests[0]?.delivered, false);
});

test("initial MultiAdd that timed out before dispatch can retry without a second deposit", async () => {
  const sim = simulator(3, 13);
  sim.setSource([]);
  sim.setHeld(
    [30, 32].map((typeID, i) => ({
      ...ore,
      itemID: 80 + i,
      typeID,
      quantity: 45,
      ownerID: 3,
      locationID: 13,
      flagID: 5,
    })),
  );
  const h = batchedHaul(sim, [], 1),
    act = sim.session.flow.flying.bridgeDo;
  let queued = true;
  sim.session.flow.flying.bridgeDo = async (...args: any[]) => {
    if (args[1] === "MultiAdd" && args[4] === 700 && queued) {
      queued = false;
      throw Object.assign(Error("No hosted slot"), { name: "TransportQueueError" });
    }
    return act(...args);
  };
  await assert.rejects(h.haul(), /did not enter the transport/);
  assert.equal(h.totals()?.deliveredUnits, 0);
  assert.equal(sim.getHeld().length, 2);
  h.restart();
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.getHeld(), []);
  assert.equal(sim.calls.filter((c: any) => c.method === "MultiAdd").length, 1);
  assert.equal(h.totals()?.deliveredUnits, 90);
  assert.equal(h.totals()?.trips, 1);
});

test("a new run unloads a full native hold with no current freight manifests", async () => {
  const sim = simulator(3, 13);
  sim.setSource([]);
  sim.setHeld([{ ...ore, itemID: 81, ownerID: 3, locationID: 13, flagID: 5, quantity: 91 }]);
  const h = batchedHaul(sim, [], 1);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.routes, [600]);
  assert.equal(sim.getCorp()[0]?.quantity, 91);
  assert.deepEqual(sim.getHeld(), []);
  assert.deepEqual(h.state().haulClaims, {});
  assert.deepEqual(h.receipts(), []);
  assert.equal(h.totals()?.deliveredUnits, 91);
  assert.equal(h.totals()?.deliveredVolumeM3, 91);
  assert.equal(h.totals()?.deliveredContainers, 0);
  h.restart();
  assert.equal(await h.haul(), "idle");
  assert.equal(h.totals()?.deliveredUnits, 91);
  // Another confirmed dock visit replaces the working journal without losing or duplicating the first.
  sim.setInSpace();
  sim.setHeld([{ ...ore, itemID: 82, ownerID: 3, locationID: 13, flagID: 5, quantity: 93 }]);
  h.restart();
  assert.equal(await h.haul(), "delivered");
  assert.equal(h.totals()?.trips, 2);
  assert.equal(h.totals()?.deliveredUnits, 184);
});

test("a Hauler already at its delivery dock unloads carry-in below threshold and keeps equipment", async () => {
  const sim = simulator(3, 13),
    equipment = {
      ...ore,
      itemID: 70,
      typeID: 800,
      categoryID: 7,
      ownerID: 3,
      locationID: 13,
      flagID: 5,
      quantity: 1,
    };
  sim.setDocked();
  sim.setSource([]);
  sim.setHeld([
    equipment,
    { ...ore, itemID: 22, ownerID: 3, locationID: 13, flagID: 5, quantity: 50 },
  ]);
  const h = batchedHaul(sim, [], 1);
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.getHeld(), [equipment]);
  assert.deepEqual(sim.routes, []);
  assert.deepEqual(h.totals()?.unitsByType, { "30": 50 });
  assert.equal(h.totals()?.deliveredContainers, 0);
});

test("a new run below the unload threshold keeps the native load without polling the hold", async () => {
  const sim = simulator(3, 13);
  sim.setHeld([{ ...ore, itemID: 81, ownerID: 3, locationID: 13, flagID: 5, quantity: 89 }]);
  let holdReads = 0;
  const fetch = sim.run.fetch;
  sim.run.fetch = async (url: unknown) => {
    if (new URL(String(url)).pathname === "/api/bridge/ship/13/bays") holdReads++;
    return fetch(url);
  };
  const h = batchedHaul(sim, [], 1);
  assert.equal(await h.haul(), "idle");
  assert.equal(await h.haul(), "idle");
  assert.equal(holdReads, 1);
  assert.equal(sim.getHeld()[0]?.quantity, 89);
  assert.deepEqual(sim.routes, []);
});

for (const remaining of [0, 9])
  test(`current can with ${remaining} units supersedes an old published snapshot`, async () => {
    const sim = simulator(3, 13);
    sim.setKeepCanVisible();
    const h = batchedHaul(sim, [ore], 1);
    sim.setSource(remaining ? [{ ...ore, quantity: remaining }] : []);
    assert.equal(await h.haul(), "missing");
    assert.deepEqual(h.state().manifests, []);
    assert.deepEqual(h.state().haulClaims, {});
    assert.equal(
      sim.calls.some((call: any) => call.method === "Add" || call.method === "MultiAdd"),
      false,
    );
    if (remaining) {
      assert.ok(
        h
          .op()
          .registerGridJetcan(3, h.claim, {
            containerID: 100,
            ownerID: 1,
            observedAt: Date.now(),
            capacityM3: 100,
            items: [{ ...item, quantity: remaining }],
          }),
      );
      assert.equal(await h.haul(), "waiting");
      assert.equal(sim.getHeld()[0]?.quantity, remaining);
    }
  });

for (const flagID of [5, 155])
  test(`Return Home settles an interrupted unload of carry-in ore from flag ${flagID}`, async () => {
    const sim = simulator(3, 13);
    sim.setCapacities(flagID === 5 ? 100 : 0, 0, flagID === 155 ? 100 : 0);
    sim.setHeld(
      [
        { ...ore, itemID: 81, quantity: 50 },
        { ...ore, itemID: 82, typeID: 32, quantity: 45 },
      ].map((r) => ({ ...r, ownerID: 3, locationID: 13, flagID })),
    );
    sim.limitDeposit(1);
    sim.loseDepositReads(2);
    const h = batchedHaul(sim, [ore], 1);
    await assert.rejects(h.haul(), /Deposit inventory unavailable/);
    h.restart();
    h.op().noteStopRequest("RETURN_HOME");
    h.op().requestStop();
    assert.equal(await h.haul(), "idle");
    assert.deepEqual(
      sim.calls.filter((x: any) => x.of === 700).map((x: any) => [x.method, x.args]),
      [["MultiAdd", [[81, 82], 13]]],
    );
    assert.deepEqual(
      sim.getHeld().map((r: any) => r.itemID),
      [82],
    );
    assert.deepEqual(sim.getSource(), [ore]);
    assert.deepEqual(h.totals()?.unitsByType, { "30": 50 });
    assert.equal(h.totals()?.trips, 1);
    await unloadParkingFreight(sim.run, sim.session, {
      operationID: "op",
      runID: "run",
      shipID: 13,
      current() {},
      delivery: {
        kind: "station",
        systemID: 300,
        destinationID: 600,
        corporationID: 77,
        division: 1,
      },
      document: h.parkingDocument,
      wholeStacks: true,
      reconcileParking: true,
    });
    assert.deepEqual(sim.getHeld(), []);
    assert.deepEqual(h.totals()?.unitsByType, { "30": 50, "32": 45 });
    h.restart();
    assert.equal(h.totals()?.deliveredUnits, 95);
  });

test("Return Home after partial corporation MultiAdd leaves the remaining stack for parking", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 4 },
      { ...ore, itemID: 21, typeID: 32, quantity: 5 },
    ];
  sim.setCapacities(100, 10);
  sim.setSource(structuredClone(rows));
  sim.limitDeposit(1);
  const h = batchedHaul(sim, rows, 1),
    write = sim.session.flow.flying.bridgeDo;
  sim.session.flow.flying.bridgeDo = async (...args: any[]) => {
    const result = await write(...args);
    if (args[1] === "MultiAdd" && args[4] === 700) {
      h.op().noteStopRequest("RETURN_HOME");
      h.op().requestStop();
    }
    return result;
  };
  await assert.rejects(h.haul(), HaulStoppedBeforePickup);
  assert.equal(await h.haul(), "idle");
  assert.deepEqual(
    sim.calls.filter((x: any) => x.of === 700).map((x: any) => x.method),
    ["MultiAdd"],
  );
  assert.deepEqual(
    sim.getHeld().map((r: any) => r.itemID),
    [21],
  );
  assert.deepEqual(h.state().haulClaims, {});
});

test("a capacity-limited 13,770 m3 can resumes from its 3,081 m3 remainder and batches the next can", async () => {
  const sim = simulator(3, 13),
    rows = [
      { ...ore, quantity: 3563 },
      { ...ore, itemID: 21, quantity: 1027 },
      { ...ore, itemID: 22, locationID: 101, quantity: 10 },
    ];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(1100, 10690);
  sim.setFamily("ore", 3);
  const h = batchedHaul(sim, rows, 3);
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 3563);
  assert.deepEqual(
    sim.getSource().map((r) => [r.locationID, r.quantity]),
    [
      [100, 1027],
      [101, 10],
    ],
  );
  assert.equal(h.state().manifests[0]?.delivered, false);
  h.restart();
  assert.equal(await h.haul(), "waiting");
  assert.deepEqual(sim.routes, [600]);
  h.op().noteStopRequest("COLLECT_FREIGHT");
  h.op().requestStop();
  assert.equal(await h.haul(), "delivered");
  assert.deepEqual(sim.routes, [600, 600]);
  assert.equal(sim.getCorp()[0]?.quantity, 4600);
  assert.deepEqual(
    h.state().manifests.map((m) => m.delivered),
    [true, true],
  );
  assert.deepEqual(
    h.receipts()[0]?.deliveryBatches?.map((b) => b.item.quantity),
    [3563, 1027],
  );
  assert.equal(await h.haul(), "idle");
});

for (const mode of ["RETURN_HOME", "COLLECT_FREIGHT"] as const)
  test(`retained first-stack delivery is preserved during ${mode}`, async () => {
    const sim = simulator(3, 13),
      rows = [
        { ...ore, quantity: 3563 },
        { ...ore, itemID: 21, quantity: 1027 },
      ];
    sim.setSource(structuredClone(rows));
    sim.setCapacities(1100, 189000);
    sim.setFamily("ore", 3);
    const h = batchedHaul(sim, rows, 3),
      m = h.state().manifests[0]!;
    const old = createNativeHauler(sim.run, sim.session, {
      shipID: 13,
      corporationID: 77,
      division: 1,
      current() {},
      tripDocument: h.tripDocument,
      pollMs: 1,
      stopBeforePickup: () => sim.getCorp().length > 0,
    });
    const local = h.op().claimContainer(3, m.containerID);
    assert.ok(local);
    await old.navigateAndVerify(m, target, h.claim);
    assert.ok(h.op().dispatchHaul(3, m.containerID, local.generation));
    await assert.rejects(old.transferAndDeliver(m, local.generation, 600), HaulStoppedBeforePickup);
    assert.equal(sim.getCorp()[0]?.quantity, 3563);
    h.restart();
    if (mode === "RETURN_HOME") {
      sim.setInSpace();
      const history = h.tripDocument(m).read(),
        calls = sim.calls.length;
      h.op().noteStopRequest(mode);
      h.op().requestStop();
      assert.equal(await h.haul(), "idle");
      assert.equal(sim.calls.length, calls);
      assert.deepEqual(sim.routes, [600]);
      assert.equal(sim.getSource()[0]?.quantity, 1027);
      assert.deepEqual(h.tripDocument(m).read(), history);
      assert.deepEqual(h.state().manifests, []);
      assert.deepEqual(h.receipts(), []);
      assert.deepEqual(h.state().haulClaims, {});
      return;
    }
    assert.equal(await h.haul(), "waiting");
    assert.equal(sim.getCorp()[0]?.quantity, 3563);
    h.op().noteStopRequest("COLLECT_FREIGHT");
    h.op().requestStop();
    assert.equal(await h.haul(), "delivered");
    assert.equal(sim.getCorp()[0]?.quantity, 4590);
    assert.deepEqual(
      h.receipts()[0]?.deliveryBatches?.map((b) => b.item.quantity),
      [3563, 1027],
    );
    assert.equal(
      sim.calls.filter((x: any) => x.method === "Add" && x.of === 13 && x.args[0] === 20).length,
      1,
    );
  });

test("Return Home retains an unknown deposit without another route or transfer", async () => {
  const sim = simulator(3, 13),
    rows = [{ ...ore, quantity: 10 }];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(1, 6);
  sim.setDeliveryLost();
  sim.loseDepositReads(2);
  const h = batchedHaul(sim, rows, 1);
  await assert.rejects(h.haul(), /Deposit inventory unavailable/);
  const m = h.state().manifests[0]!,
    history = h.tripDocument(m).read(),
    calls = sim.calls.length;
  sim.setInSpace();
  h.restart();
  h.op().noteStopRequest("RETURN_HOME");
  h.op().requestStop();
  await assert.rejects(h.haul(), /Return Home cannot reconcile.*Exact docked/);
  assert.deepEqual(sim.routes, [600]);
  assert.equal(sim.calls.length, calls);
  assert.deepEqual(h.tripDocument(m).read(), history);
  assert.equal(h.state().haulClaims["100"]?.dispatched, true);
});

test("Return Home during an active delivery prevents the next inventory write", async () => {
  const sim = simulator(3, 13),
    rows = [{ ...ore, quantity: 10 }];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(1, 6);
  const h = batchedHaul(sim, rows, 1),
    route = sim.session.flow.startRoute;
  sim.session.flow.startRoute = async (id: number) => {
    const result = await route(id);
    h.op().noteStopRequest("RETURN_HOME");
    h.op().requestStop();
    return result;
  };
  await assert.rejects(h.haul(), HaulStoppedBeforePickup);
  assert.equal(await h.haul(), "idle");
  assert.deepEqual(sim.routes, [600]);
  assert.equal(sim.getCorp().length, 0);
  assert.equal(sim.getHeld()[0]?.quantity, 6);
  assert.deepEqual(h.state().haulClaims, {});
});

for (const mode of ["RETURN_HOME", "COLLECT_FREIGHT"] as const)
  test("batch recovery honors " + mode + " after a lost delivery reply", async () => {
    const sim = simulator(3, 13),
      rows = [{ ...ore, quantity: 10 }];
    sim.setSource(structuredClone(rows));
    sim.setCapacities(1, 6);
    sim.setDeliveryLost();
    sim.loseDepositReads(2);
    const h = batchedHaul(sim, rows, 1);
    await assert.rejects(h.haul(), /Deposit inventory unavailable/);
    assert.equal(sim.getCorp()[0]?.quantity, 6);
    h.restart();
    h.op().noteStopRequest(mode);
    h.op().requestStop();
    // Later deposits get a normal native ACK. The original is resolved by
    // readback from the docked ship and corporate division.
    sim.clearDeliveryLost();
    assert.equal(await h.haul(), mode === "RETURN_HOME" ? "idle" : "delivered");
    assert.equal(sim.getCorp()[0]?.quantity, mode === "RETURN_HOME" ? 6 : 10);
    assert.equal(
      sim.calls.filter((x: any) => x.method === "Add" && x.of === 700).length,
      mode === "RETURN_HOME" ? 1 : 2,
    );
    assert.deepEqual(h.state().haulClaims, {});
  });

test("Hauler reads the hold again after connection reset and HTTP 502 without restarting its run", async () => {
  const sim = simulator(3, 13),
    rows = [{ ...ore, quantity: 10 }];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(1, 6);
  const fetch = sim.run.fetch;
  let faults = 0;
  sim.run.fetch = async (input: unknown, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/api/bridge/ship/13/bays" && faults < 2) {
      if (++faults === 1)
        throw new TypeError("fetch failed", {
          cause: Object.assign(Error("read ECONNRESET"), { code: "ECONNRESET" }),
        });
      return new Response("Bad Gateway", { status: 502 });
    }
    return fetch(input, init);
  };
  const h = batchedHaul(sim, rows, 1);
  for (const expected of [1, 2]) {
    await assert.rejects(h.haul(), FleetObservationUnavailable);
    assert.equal(faults, expected);
    assert.equal(
      sim.calls.some((c: any) => c.method === "Add" || c.method === "MultiAdd"),
      false,
    );
  }
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 6);
  assert.equal(h.state().stopRequested, undefined);
});

test("Hauler uses a readable compatible hold even when the preferred hold read fails", async () => {
  const sim = simulator(3, 13),
    rows = [{ ...ore }];
  sim.setCapacities(10, 10);
  const fetch = sim.run.fetch;
  sim.run.fetch = async (input: URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (!new URL(String(input)).pathname.endsWith("/bays")) return response;
    const panel = await response.json();
    Object.assign(panel.bays[0], { error: "CALL_TIMEOUT", capacity: null, present: false });
    return Response.json(panel);
  };
  const h = batchedHaul(sim, rows, 1);
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 10);
  const [pickup] = sim.calls.filter(
    (c: any) => c.of === 13 && ["Add", "MultiAdd"].includes(c.method),
  ) as any[];
  assert.equal(pickup?.kwargs.flag, 5);
});

test("Hauler retries when no compatible hold can be verified in a partial panel", async () => {
  const sim = simulator(3, 13),
    rows = [{ ...ore }];
  sim.setCapacities(0, 10);
  const fetch = sim.run.fetch;
  let panels = 0;
  sim.run.fetch = async (input: URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (!new URL(String(input)).pathname.endsWith("/bays")) return response;
    if (++panels !== 1) return response;
    const panel = await response.json();
    Object.assign(panel.bays[0], { error: "CALL_TIMEOUT", capacity: null, present: false });
    panel.bays[1].present = false;
    return Response.json(panel);
  };
  const h = batchedHaul(sim, rows, 1);
  await assert.rejects(h.haul(), FleetObservationUnavailable);
  assert.equal(panels, 1);
  assert.equal(sim.getSource()[0]?.quantity, 10);
  assert.deepEqual(h.state().haulClaims, {});
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 10);
  const writes = sim.calls.filter(
    (c: any) => c.of === 13 && ["Add", "MultiAdd"].includes(c.method),
  ) as any[];
  assert.deepEqual(
    writes.map((c) => c.kwargs.flag),
    [134],
  );
});

test("two transient post-pickup reads leave one mutation and recover from exact current inventory", async () => {
  const sim = simulator(3, 13),
    rows = [{ ...ore, quantity: 10 }];
  sim.setSource(structuredClone(rows));
  sim.setCapacities(1, 6);
  sim.failAfterPickup(2);
  const h = batchedHaul(sim, rows, 1);
  await assert.rejects(h.haul(), /Can read timed out/);
  assert.equal(sim.getSource()[0]?.quantity, 4);
  assert.equal(sim.getCorp().length, 0);
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 6);
  assert.equal(await h.haul(), "waiting");
  h.op().noteStopRequest("COLLECT_FREIGHT");
  h.op().requestStop();
  assert.equal(await h.haul(), "delivered");
  assert.equal(sim.getCorp()[0]?.quantity, 10);
  assert.deepEqual(
    sim.calls.filter((x: any) => x.method === "Add").map((x: any) => [x.of, x.kwargs.qty]),
    [
      [13, 6],
      [700, 6],
      [13, 4],
      [700, 4],
    ],
  );
  assert.deepEqual(h.state().haulClaims, {});
});
