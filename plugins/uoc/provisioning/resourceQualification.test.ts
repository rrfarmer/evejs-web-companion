import test from "node:test";
import assert from "node:assert/strict";
import {
  simulatePilotResources,
  decodeNativeFittingResources,
  supportedBrain,
} from "./resourceQualification.ts";
const dict = (entries: any[]) => ({ type: "dict", entries }),
  long = (value: string) => ({ type: "long", value });
const effect = (value: number) => ({
  type: "objectex1",
  header: [
    null,
    null,
    dict([
      ["modifierType", "M"],
      ["toAttribID", 48],
      ["operation", 6],
      ["value", value],
      ["extras", []],
      ["skills", { type: "list", items: [3426] }],
    ]),
  ],
});
const fitting = [
  { typeID: 483, flagID: 27, quantity: 1 },
  { typeID: 483, flagID: 28, quantity: 1 },
  { typeID: 399, flagID: 19, quantity: 1 },
  { typeID: 2046, flagID: 11, quantity: 1 },
];
const light = { typeID: 2203, flagID: 87, quantity: 10 },
  medium = { typeID: 2173, flagID: 87, quantity: 5 };
const resourcePairs = { cpu: { used: 170, total: 288 }, powergrid: { used: 7, total: 54 } };
function fixture({
  shipTypeID = 32880,
  drones = [] as typeof fitting,
  droneBay = undefined as unknown,
  bayCapacity = undefined as number | undefined,
  volumes = undefined as Record<number, unknown> | undefined,
  targetHullID = null as number | null,
  observedBay = undefined as unknown,
  observedShipID = undefined as number | undefined,
} = {}) {
  const factTypes = [shipTypeID, 1373, 483, 399, 2046];
  let brain: any = {
      characterID: 7,
      character: { typeID: 1373 },
      charBrain: [1, [], [effect(20)], []],
    },
    simulation: any = null,
    metadata: any = {
      available: true,
      types: Object.fromEntries(factTypes.map((id) => [id, { attributes: [], effects: [16] }])),
      effects: { 16: { modifiers: null } },
    };
  const calls: string[] = [],
    current = () => {};
  const session: any = {
    store: { dogma: { get: () => ({ allInfo: brain }) }, fitting: { get: () => ({ simulation }) } },
    flow: {
      requestOptions: () => ({
        baseUrl: "http://test",
        fetch: async (url: string) => {
          assert.equal(url, `http://test/api/bridge/ship/${targetHullID}/bays?keys=drone`);
          calls.push("native bay");
          return Response.json({
            ok: true,
            shipID: observedShipID ?? targetHullID,
            bays: observedBay ? [observedBay] : [],
          });
        },
      }),
      loadFitting: async () => {
        calls.push("loadFitting");
      },
      loadDogma: async () => {
        calls.push("loadDogma");
      },
      simulateFitting: async (f: any) => {
        calls.push("simulate");
        assert.equal(f.shipTypeID, shipTypeID);
        assert.deepEqual(f.fitData, fitting);
        assert.equal(brain.characterID, 7);
        simulation = {
          shipTypeID,
          slots: [
            { family: "high", index: 0, module: { typeID: 483 } },
            { family: "high", index: 1, module: { typeID: 483 } },
            { family: "mid", index: 0, module: { typeID: 399 } },
            { family: "low", index: 0, module: { typeID: 2046 } },
          ],
          moduleStates: { 27: 1, 28: 1, 19: 1, 11: 1 },
          drones: [],
          resources: {
            cpu: { known: true, ...resourcePairs.cpu },
            powergrid: { known: true, ...resourcePairs.powergrid },
          },
          stats: {
            bays: {
              droneCapacity:
                bayCapacity === undefined ? { known: false } : { known: true, value: bayCapacity },
            },
          },
        };
      },
    },
  };
  const review = { droneBay, context: { shipID: 99 }, plan: { mode: "NEW_HULL", targetHullID } };
  const input = {
    session,
    characterID: 7,
    shipTypeID,
    fitData: [...fitting, ...drones],
    review,
    current,
    read: async (path: string) => {
      if (path.startsWith("/api/types/volumes?")) {
        assert.equal(
          path,
          `/api/types/volumes?typeIDs=${[...new Set(drones.map((drone) => drone.typeID))].join(",")}`,
        );
        calls.push("type volumes");
        if (!volumes) throw Error("Type volumes unavailable");
        return { volumes };
      }
      assert.equal(path, `/api/client-data/dogma-types?typeIDs=${factTypes.join(",")}`);
      return metadata;
    },
  };
  return {
    input,
    calls,
    factTypes,
    setBrain: (value: any) => (brain = value),
    setMetadata: (value: any) => (metadata = value),
    afterSim: (f: (v: any) => void) => {
      const previous = session.flow.simulateFitting;
      session.flow.simulateFitting = async (x: any) => {
        await previous(x);
        f(simulation);
      };
    },
  };
}
test("simulates an ordinary ship's exact module fit with the held pilot brain", async () => {
  const f = fixture(),
    r = await simulatePilotResources(f.input);
  assert.deepEqual(r, {
    state: "SIMULATED",
    characterID: 7,
    shipTypeID: 32880,
    ...resourcePairs,
    fits: true,
    source: "PILOT_BRAIN_CLIENT_SIMULATION",
  });
  assert.deepEqual(f.calls, ["loadFitting", "loadDogma", "simulate"]);
});
test("the same Dragoon fit preserves CPU/PG with zero, light-only, and mixed stored drones", async () => {
  for (const { drones, droneBay } of [
    { drones: [], droneBay: undefined },
    { drones: [light], droneBay: { required: 50, capacity: 150 } },
    { drones: [light, medium], droneBay: { required: 100, capacity: 150 } },
  ]) {
    const f = fixture({ shipTypeID: 32874, drones, droneBay }),
      r = await simulatePilotResources(f.input);
    assert.deepEqual(r, {
      state: "SIMULATED",
      characterID: 7,
      shipTypeID: 32874,
      ...resourcePairs,
      fits: true,
      source: "PILOT_BRAIN_CLIENT_SIMULATION",
      ...(droneBay ? { droneBay: { ...droneBay, reason: null } } : {}),
    });
  }
});
test("unavailable or insufficient native storage remains independent of the Dragoon's CPU/PG", async () => {
  for (const [capacity, reason] of [
    [null, /unavailable/],
    [75, /exceed/],
    [0, /exceed/],
  ] as const) {
    const f = fixture({
      shipTypeID: 32874,
      drones: [light, medium],
      droneBay: { required: 100, capacity },
    });
    const r = await simulatePilotResources(f.input);
    assert.equal(r.state, "SIMULATED");
    assert.deepEqual(r.cpu, resourcePairs.cpu);
    assert.deepEqual(r.powergrid, resourcePairs.powergrid);
    assert.equal(r.droneBay?.capacity, capacity);
    assert.match(r.droneBay?.reason ?? "", reason);
  }
});

for (const [ship, shipTypeID, bayCapacity, drones] of [
  ["Pioneer", 89240, 50, [light]],
  ["Hauler (FixtureHauler)", 2100000919, 0, []],
  ["Omen", 2006, 40, [{ ...light, quantity: 5 }]],
  ["Covetor", 17476, 100, [light, medium]],
] as const) {
  test(`${ship} review reads selected drone volumes and the candidate Dogma bay without native review fields`, async () => {
    const f = fixture({
      shipTypeID,
      bayCapacity,
      drones: [...drones],
      volumes: { [light.typeID]: 5, [medium.typeID]: 10 },
    });
    const r = await simulatePilotResources(f.input);
    assert.equal(r.state, "SIMULATED");
    assert.equal(r.shipTypeID, shipTypeID);
    assert.equal(r.fits, true);
    assert.deepEqual(
      r.droneBay,
      drones.length
        ? {
            required: drones.reduce(
              (n, d) => n + d.quantity * (d.typeID === light.typeID ? 5 : 10),
              0,
            ),
            capacity: bayCapacity,
            reason: null,
            simulated: true,
          }
        : undefined,
    );
    assert.equal(f.calls.filter((call) => call === "type volumes").length, drones.length ? 1 : 0);
    assert.equal(f.calls.includes("native bay"), false);
  });
}

test("a partial or unreadable volume response never qualifies a mixed drone load", async () => {
  for (const volumes of [
    undefined,
    { [light.typeID]: 5, [medium.typeID]: null },
    { [light.typeID]: 5, [medium.typeID]: 0 },
  ]) {
    const f = fixture({ drones: [light, medium], bayCapacity: 150, volumes });
    const r = await simulatePilotResources(f.input);
    assert.equal(r.state, "SIMULATED");
    assert.deepEqual(r.droneBay, {
      required: null,
      capacity: 150,
      reason: "The storage volume of the selected drones is unavailable.",
      simulated: true,
    });
  }
});

test("unknown, zero and insufficient candidate drone capacity remain blockers", async () => {
  for (const bayCapacity of [undefined, 0, 45]) {
    const f = fixture({ drones: [light], bayCapacity, volumes: { [light.typeID]: 5 } });
    const r = await simulatePilotResources(f.input);
    assert.equal(r.state, "SIMULATED");
    assert.equal(r.droneBay?.required, 50);
    assert.equal(r.droneBay?.capacity, bayCapacity ?? null);
    assert.match(r.droneBay?.reason ?? "", bayCapacity === undefined ? /unavailable/ : /exceed/);
  }
});

test("an assembled target uses its own actual bay and never borrows the current or simulated hull's capacity", async () => {
  for (const [observedShipID, value, expected] of [
    [55, 45, 45],
    [99, 45, null],
    [55, null, null],
  ] as const) {
    const f = fixture({
      drones: [light],
      bayCapacity: 150,
      volumes: { [light.typeID]: 5 },
      targetHullID: 55,
      observedShipID,
      observedBay: { key: "drone", present: true, capacity: { capacity: value, used: 0 } },
    });
    const r = await simulatePilotResources(f.input);
    assert.equal(r.state, "SIMULATED");
    assert.equal(r.droneBay?.capacity, expected);
    assert.match(r.droneBay?.reason ?? "", expected === null ? /unavailable/ : /exceed/);
    assert.deepEqual(
      f.calls.filter((call) => call === "native bay"),
      ["native bay"],
    );
  }
});

test("a known native zero is authoritative even for a packaged candidate", async () => {
  const f = fixture({ drones: [light], droneBay: { required: 50, capacity: 0 }, bayCapacity: 150 });
  const r = await simulatePilotResources(f.input);
  assert.equal(r.droneBay?.capacity, 0);
  assert.match(r.droneBay?.reason ?? "", /exceed/);
  assert.equal(f.calls.includes("type volumes"), false);
});
test("a reviewed existing hull uses its exact fitted Dogma capacity if the unboarded bay is unreadable", async () => {
  for (const [reported, capacity] of [
    [null, 150],
    [45, 45],
  ] as const) {
    const f = fixture({
      drones: [light],
      bayCapacity: 150,
      volumes: { [light.typeID]: 5 },
      targetHullID: 55,
      observedShipID: 55,
      observedBay: { key: "drone", present: true, capacity: { capacity: reported, used: 0 } },
    });
    f.input.review.plan.mode = "EXISTING_HULL";
    const r = await simulatePilotResources(f.input);
    assert.equal(r.droneBay?.capacity, capacity);
    assert.equal(r.droneBay?.simulated ?? false, reported === null);
    if (reported === null) assert.equal(r.droneBay?.reason, null);
    else assert.match(r.droneBay?.reason ?? "", /exceed.*bay capacity/);
  }
});
test("unknown brain or unsupported modifier never becomes a qualified simulation", async () => {
  const f = fixture();
  f.setBrain({ characterID: 8, charBrain: [1, [], [], []] });
  assert.equal((await simulatePilotResources(f.input)).state, "UNKNOWN");
  const g = fixture();
  g.setMetadata({
    available: true,
    types: Object.fromEntries(g.factTypes.map((id) => [id, { attributes: [], effects: [16] }])),
    effects: {
      16: {
        modifiers: [
          {
            func: "UnhandledModifier",
            domain: "shipID",
            modifiedAttributeID: 48,
            modifyingAttributeID: 6,
            operation: 6,
          },
        ],
      },
    },
  });
  assert.equal((await simulatePilotResources(g.input)).state, "UNKNOWN");
  assert.equal(supportedBrain([1, [], [effect(20), { type: "objectex1", header: [] }], []]), false);
});
test("omitted, offline and wrong-slot modules remain unknown", async () => {
  for (const edit of [
    (v: any) => v.slots.pop(),
    (v: any) => (v.moduleStates[27] = 0),
    (v: any) => (v.slots[0].module.typeID = 9),
  ]) {
    const f = fixture();
    f.afterSim(edit);
    assert.equal((await simulatePilotResources(f.input)).state, "UNKNOWN");
  }
});
test("fresh native ship ItemGetInfo measures the same pilot's actual CPU and powergrid", () => {
  const raw: any = {
    type: "object",
    name: "util.KeyVal",
    args: dict([
      ["itemID", 99],
      ["invItem", { type: "packedrow", fields: { itemID: 99, typeID: 32880, ownerID: 7 } }],
      ["time", long("134385165369180001")],
      ["wallclockTime", long("134385165369179999")],
      [
        "attributes",
        dict([
          [49, 170],
          [48, 288],
          [15, 7],
          [11, 54],
        ]),
      ],
    ]),
  };
  assert.deepEqual(
    decodeNativeFittingResources(raw, { shipID: 99, shipTypeID: 32880, characterID: 7 }),
    {
      state: "NATIVE",
      shipID: 99,
      shipTypeID: 32880,
      characterID: 7,
      timeFiletime: "134385165369180001",
      wallclockFiletime: "134385165369179999",
      cpu: { used: 170, total: 288 },
      powergrid: { used: 7, total: 54 },
      fits: true,
    },
  );
  assert.equal(
    decodeNativeFittingResources(raw, { shipID: 99, shipTypeID: 32880, characterID: 8 }),
    null,
  );
  const unsafe = structuredClone(raw);
  unsafe.args.entries[2][1].value = 134385165369180000;
  assert.equal(
    decodeNativeFittingResources(unsafe, { shipID: 99, shipTypeID: 32880, characterID: 7 }),
    null,
  );
  raw.args.entries[4][1].entries.push([49, 171]);
  assert.equal(
    decodeNativeFittingResources(raw, { shipID: 99, shipTypeID: 32880, characterID: 7 }),
    null,
  );
});
