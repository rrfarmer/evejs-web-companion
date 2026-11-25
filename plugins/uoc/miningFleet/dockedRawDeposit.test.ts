import test from "node:test";
import assert from "node:assert/strict";
import {
  depositOwnShipRaw,
  createDockedRawDepositIO,
  UnconfirmedHaulerUnload,
  type OwnShipRawSource,
} from "./dockedRawDeposit.ts";
import { officeList, corporationRow, titlesRowset } from "./corporateOfficeFixture.ts";
const source: OwnShipRawSource = {
  kind: "own-ship-raw",
  operationID: "op",
  runID: "run",
  characterID: 3,
  shipID: 13,
  items: [{ itemID: 20, typeID: 30, quantity: 10 }],
};
const list = (rows: unknown[]) => ({
  type: "list",
  items: rows.map((fields) => ({ type: "packedrow", fields })),
});
function fixture() {
  let held: any[] = [
      { itemID: 20, typeID: 30, ownerID: 3, locationID: 13, flagID: 134, quantity: 10 },
    ],
    destination: any[] = [];
  let doc: unknown = null,
    lost = false,
    lostBeforeMove = false,
    docked = true,
    raw = true,
    ice = false,
    corpID = 77,
    failSave = false,
    personal = false,
    structure = false;
  let query = true,
    throughTitle = false,
    hasOffice = true,
    missingDivision = false,
    officeID: number | null = 700,
    refused = false;
  let writes = 0;
  const calls: string[] = [],
    cacheKeys: number[] = [];
  const flow = {
    requestOptions: () => ({}),
    flying: {
      async bridgeDo(
        service: string,
        method: string,
        args: any[],
        kwargs: any,
        of: number | string,
      ) {
        if (service === "invCache") {
          cacheKeys.push(args[0]);
          return null;
        }
        assert.equal(service, "invbroker");
        assert.equal(of, personal ? "hangar" : 700);
        assert.equal(kwargs.flag, personal ? 4 : 115);
        assert.equal(args[1], 13);
        writes++;
        calls.push(method);
        if (lostBeforeMove) throw Error("reply unavailable before the item moved");
        if (refused)
          throw Object.assign(Error("Not enough hangar space"), {
            code: "CALL_REFUSED",
            status: 409,
            refusal: { key: "NotEnoughCargoSpace" },
          });
        for (const id of method === "MultiAdd" ? args[0] : [args[0]]) {
          const row = held.find((r) => r.itemID === id);
          assert.ok(row);
          if (method === "Add") assert.equal(kwargs.qty, row.quantity);
          held = held.filter((r) => r !== row);
          destination.push({
            ...row,
            ownerID: personal ? 3 : 77,
            locationID: personal ? 600 : 700,
            flagID: kwargs.flag,
          });
        }
        if (lost) throw Error("reply lost");
        return null;
      },
      async bridgeAsk(
        service: string,
        method: string,
        args: any[],
        kwargs: any,
        of: number | string,
      ) {
        if (service === "corpRegistry") {
          calls.push(method);
          if (method === "GetTitles")
            return titlesRowset([{ titleID: 1, corporationID: 77, rolesAtOther: "1048576" }]);
          const response = corporationRow(method, 3, 77, query && !throughTitle ? 1048576n : 0n);
          if (method === "GetMember") {
            assert.deepEqual(args, [3]);
            response.fields!.titleMask = throughTitle ? 1 : 0;
          }
          return response;
        }
        if (service === "officeManager")
          return {
            type: "objectex2",
            list:
              officeID === null
                ? []
                : [{ type: "packedrow", fields: { stationID: 600, officeID } }],
          };
        assert.equal(service, "invbroker");
        assert.equal(method, "List");
        if (of === 13) return list(held.filter((r) => r.flagID === kwargs?.flag));
        assert.equal(of, personal ? "hangar" : 700);
        return list(destination);
      },
    },
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    let body;
    switch (url.pathname) {
      case "/api/bridge/corp-offices": {
        assert.equal(url.search, "");
        const offices = officeList(hasOffice ? [600] : []);
        if (missingDivision) offices.divisions.shift();
        return Response.json(offices);
      }
      case "/api/bridge/flight/status":
        body = {
          flight: {
            docked,
            inSpace: !docked,
            shipID: 13,
            solarSystemID: 300,
            stationID: docked && !structure ? 600 : null,
            structureID: docked && structure ? 600 : null,
          },
        };
        break;
      case "/api/mining-operations/resources":
        body = {
          resources: [{ typeID: raw ? 30 : 31, family: ice ? "ice" : "ore", name: "resource" }],
        };
        break;
      case "/api/client-data/dogma-types":
        body = { available: true, types: { 30: { categoryID: 25 }, 31: { categoryID: 25 } } };
        break;
      case "/api/types/compressed":
        body = { compressedTypeIDs: { 30: 31 }, capped: false };
        break;
      case "/api/types/volumes":
        body = { volumes: { 30: 1, 31: 0.1 }, capped: false };
        break;
      default:
        throw Error("Unexpected request " + url.pathname);
    }
    return Response.json({ ok: true, ...body });
  };
  const run = { characterID: 3, baseUrl: "http://bff", fetch: fetcher };
  const session = {
    flow,
    store: { station: { get: () => ({ online: { characterID: 3, corporationID: corpID } }) } },
  } as any;
  const document = {
    read: () => doc,
    write: (v: unknown) => {
      if (failSave) throw Error("disk failed");
      doc = structuredClone(v);
    },
  };
  const call = () =>
    depositOwnShipRaw(run, session, {
      source,
      destinationID: 600,
      ...(personal
        ? {
            delivery: {
              kind: structure ? ("structure" as const) : ("station" as const),
              destinationID: 600,
              systemID: 300,
              corporationID: null,
              division: null,
            },
          }
        : { corporationID: 77, division: 1 }),
      current() {},
      document,
    });
  return {
    run,
    session,
    document,
    call,
    calls,
    cacheKeys,
    setQuery: (v: boolean) => {
      query = v;
    },
    useTitle: () => {
      throughTitle = true;
    },
    removeOffice: () => {
      hasOffice = false;
    },
    loseOfficeID: () => {
      officeID = null;
    },
    removeDivision: () => {
      missingDivision = true;
    },
    setRefused: (v: boolean) => {
      refused = v;
    },
    getWrites: () => writes,
    getDoc: () => doc,
    setDoc: (v: unknown) => {
      doc = structuredClone(v);
    },
    getCorp: () => destination,
    setLost: (v: boolean) => {
      lost = v;
    },
    setLostBeforeMove: (v: boolean) => {
      lostBeforeMove = v;
    },
    setDocked: (v: boolean) => {
      docked = v;
    },
    setRaw: (v: boolean) => {
      raw = v;
    },
    setIce: () => {
      ice = true;
    },
    setCorpID: (v: number) => {
      corpID = v;
    },
    setFailSave: (v: boolean) => {
      failSave = v;
    },
    setPersonal: () => {
      personal = true;
    },
    setStructure: () => {
      structure = true;
    },
    setHeld: (v: any[]) => {
      held = v;
    },
    setCorp: (v: any[]) => {
      destination = v;
    },
  };
}
test("docked own-ship raw ore reaches the exact corporation division once and durable receipt is reusable", async () => {
  const f = fixture(),
    r = await f.call();
  assert.equal(r.source.kind, "own-ship-raw");
  assert.equal(r.officeID, 700);
  assert.equal(r.batches[0]?.destinationAfter[0]?.quantity, 10);
  assert.equal(f.getWrites(), 1);
  const saved = f.getDoc() as any;
  assert.equal(saved.receipt.batches, undefined);
  assert.deepEqual(saved.batches, r.batches);
  f.setDoc({ ...saved, receipt: r });
  assert.deepEqual(await f.call(), r);
  assert.equal((f.getDoc() as any).receipt.batches, undefined);
  assert.equal(f.getWrites(), 1);
});
test("lost acknowledgement is reconciled by exact fresh source and corp deltas without another Add", async () => {
  const f = fixture();
  f.setLost(true);
  await assert.rejects(f.call(), /reply lost/);
  assert.equal((f.getDoc() as any).pending.acknowledged, false);
  f.setLost(false);
  const r = await f.call();
  assert.equal(r.batches[0]?.acknowledged, false);
  assert.equal(f.getWrites(), 1);
});
test("unknown intent with unchanged inventories remains fenced", async () => {
  const f = fixture();
  f.setLost(true);
  await assert.rejects(f.call(), /reply lost/);
  f.setHeld([{ itemID: 20, typeID: 30, ownerID: 3, locationID: 13, flagID: 134, quantity: 10 }]);
  f.setCorp([]);
  await assert.rejects(f.call(), /unknown; no replay/);
  assert.equal(f.getWrites(), 1);
});
test("wrong dock, corporation, raw metadata and failed intent persistence issue no Add", async () => {
  for (const setup of [
    (x: any) => x.setDocked(false),
    (x: any) => x.setCorpID(99),
    (x: any) => x.setRaw(false),
    (x: any) => x.setFailSave(true),
  ]) {
    const f = fixture();
    setup(f);
    await assert.rejects(f.call());
    assert.equal(f.getWrites(), 0);
  }
});

test("corrupted persisted receipts or missing exact source stacks never authorize writes", async () => {
  const f = fixture(),
    receipt = await f.call(),
    data = structuredClone(f.getDoc()) as any;
  data.receipt = receipt;
  data.receipt.batches[0].destinationAfter[0].quantity = 11;
  f.setDoc(data);
  await assert.rejects(f.call(), /receipt requires reconciliation/);
  assert.equal(f.getWrites(), 1);
  const g = fixture();
  g.setHeld([{ itemID: 21, typeID: 30, ownerID: 3, locationID: 13, flagID: 134, quantity: 10 }]);
  await assert.rejects(g.call(), /source stack is not available/);
  assert.equal(g.getWrites(), 0);
});

test("docked raw ice is accepted from the Procurer general mining hold", async () => {
  const f = fixture();
  f.setIce();
  const r = await f.call();
  assert.equal(r.batches[0]?.sourceBefore[0]?.flagID, 134);
  assert.equal(r.batches[0]?.destinationAfter[0]?.quantity, 10);
  assert.equal(f.getWrites(), 1);
});
test("concurrent haulers each prove the exact office delta", async () => {
  let corp: any[] = [],
    writes = 0;
  const actor = (characterID: number, shipID: number, itemID: number) => {
    let held: any[] = [
      { itemID, typeID: 30, ownerID: characterID, locationID: shipID, flagID: 134, quantity: 10 },
    ];
    const flow: any = {
      requestOptions: () => ({}),
      flying: {
        bridgeDo: async (s: string, m: string, _a: any, kw: any, of: number) => {
          if (s === "invCache") return;
          if (s === "invbroker" && m === "Add" && of === 700) {
            writes++;
            const row = held[0];
            held = [];
            corp.push({ ...row, ownerID: 77, locationID: 700, flagID: kw.flag });
            return;
          }
          throw Error("unexpected write");
        },
        bridgeAsk: async (s: string, m: string, _a: any, kw: any, of: number) => {
          if (s === "corpRegistry") return corporationRow(m, characterID, 77);
          if (s === "officeManager")
            return { list: [{ fields: { stationID: 600, officeID: 700 } }] };
          if (m === "List" && of === shipID) return list(held.filter((r) => r.flagID === kw?.flag));
          if (m === "List" && of === 700) {
            const snapshot = structuredClone(corp);
            await new Promise((r) => setTimeout(r, 5));
            return list(snapshot);
          }
          throw Error("unexpected read");
        },
      },
    };
    const run: any = {
      characterID,
      baseUrl: "http://bff",
      fetch: async (input: unknown) => {
        const p = new URL(String(input)).pathname;
        let x: any;
        if (p === "/api/bridge/corp-offices") x = officeList();
        else if (p === "/api/bridge/flight/status")
          x = {
            flight: { docked: true, inSpace: false, shipID, solarSystemID: 300, stationID: 600 },
          };
        else if (p === "/api/mining-operations/resources")
          x = { resources: [{ typeID: 30, family: "ore", name: "resource" }] };
        else if (p === "/api/client-data/dogma-types")
          x = { available: true, types: { 30: { categoryID: 25 }, 31: { categoryID: 25 } } };
        else if (p === "/api/types/volumes") x = { volumes: { 30: 1 }, capped: false };
        else throw Error(p);
        return Response.json({ ok: true, ...x });
      },
    };
    const session: any = {
      flow,
      store: { station: { get: () => ({ online: { characterID, corporationID: 77 } }) } },
    };
    return { run, session, item: { itemID, typeID: 30, quantity: 10 }, characterID, shipID };
  };
  const a = actor(3, 13, 20),
    b = actor(4, 14, 21),
    io = await Promise.all(
      [a, b].map((x) =>
        createDockedRawDepositIO(x.run, x.session, {
          characterID: x.characterID,
          shipID: x.shipID,
          destinationID: 600,
          corporationID: 77,
          division: 1,
          current() {},
        }),
      ),
    );
  const fence = () => ({
    begin() {},
    acknowledge() {},
    refuseDelivery() {
      assert.fail("Unexpected refusal");
    },
    settle() {},
  });
  const results = await Promise.all(io.map((x, i) => x.deposit([a, b][i]!.item, fence())));
  assert.equal(writes, 2);
  assert.deepEqual(
    results.map((x) => [
      x.destinationBefore.reduce((n, r) => n + r.quantity, 0),
      x.destinationAfter.reduce((n, r) => n + r.quantity, 0),
    ]),
    [
      [0, 10],
      [10, 20],
    ],
  );
});

test("personal hangar accepts a different corporation and reconciles a lost response without replay", async () => {
  const f = fixture();
  f.setPersonal();
  f.setCorpID(99);
  f.setLost(true);
  await assert.rejects(f.call(), /reply lost/);
  f.setLost(false);
  const receipt = await f.call();
  assert.equal(receipt.delivery?.kind, "station");
  assert.equal(receipt.corporationID, null);
  assert.equal(receipt.batches[0]?.destinationAfter[0]?.ownerID, 3);
  assert.equal(f.getWrites(), 1);
  assert.ok(f.cacheKeys.includes(10004));
});

test("personal Upwell hangar uses exact structure flight identity", async () => {
  const f = fixture();
  f.setPersonal();
  f.setStructure();
  const receipt = await f.call();
  assert.equal(receipt.delivery?.kind, "structure");
  assert.equal(receipt.batches[0]?.destinationAfter[0]?.flagID, 4);
  assert.equal(f.getWrites(), 1);
  assert.ok(f.cacheKeys.includes(600));
});

test("personal destination mismatch and incomplete corp scope refuse before transfer", async () => {
  const f = fixture();
  f.setPersonal();
  f.setStructure();
  for (const delivery of [
    {
      kind: "station" as const,
      destinationID: 600,
      systemID: 300,
      corporationID: null,
      division: null,
    },
    {
      kind: "structure" as const,
      destinationID: 600,
      systemID: 301,
      corporationID: null,
      division: null,
    },
    {
      kind: "structure" as const,
      destinationID: 600,
      systemID: 300,
      corporationID: 77,
      division: null,
    },
  ])
    await assert.rejects(
      createDockedRawDepositIO(f.run, f.session, {
        characterID: 3,
        shipID: 13,
        destinationID: 600,
        delivery,
        current() {},
      }),
    );
  assert.equal(f.getWrites(), 0);
});

test("own-ship freight deposits RAW and recipe-qualified COMPRESSED stacks with independent exact receipts", async () => {
  const f = fixture();
  f.setHeld([
    { itemID: 20, typeID: 30, ownerID: 3, locationID: 13, flagID: 134, quantity: 10 },
    { itemID: 21, typeID: 31, ownerID: 3, locationID: 13, flagID: 134, quantity: 4 },
  ]);
  const mixed: OwnShipRawSource = {
    kind: "own-ship-freight",
    operationID: "op",
    runID: "run",
    characterID: 3,
    shipID: 13,
    items: [
      { itemID: 20, typeID: 30, quantity: 10 },
      { itemID: 21, typeID: 31, quantity: 4 },
    ],
  };
  const receipt = await depositOwnShipRaw(f.run, f.session, {
    source: mixed,
    freightKind: "ANY",
    destinationID: 600,
    corporationID: 77,
    division: 1,
    current() {},
    document: f.document,
  });
  assert.equal(receipt.source.kind, "own-ship-freight");
  assert.deepEqual(
    receipt.batches.map((b) => b.item.typeID),
    [30, 31],
  );
  assert.equal(f.getWrites(), 2);
  assert.deepEqual(
    f.getCorp().map((r) => r.typeID),
    [30, 31],
  );
});

test("a visible office without division Query is rejected before an inventory write", async () => {
  const f = fixture();
  f.setQuery(false);
  await assert.rejects(f.call(), /lacks verified Query access/);
  assert.equal(f.getWrites(), 0);
});

for (const mode of [
  "exact IDs",
  "exact IDs and more ore",
  "merged",
  "merged into a new stack",
  "ambiguous merge",
  "offsetting changes",
  "two possible merge targets",
] as const) {
  test("whole-stack readback with concurrent division activity: " + mode, async () => {
    const f = fixture(),
      ore = { typeID: 30, ownerID: 3, locationID: 13, flagID: 134, quantity: 10 };
    const ship = [20, 21].map((itemID) => ({ ...ore, itemID }));
    const inOffice = { ...ore, ownerID: 77, locationID: 700, flagID: 115 };
    f.setHeld(ship);
    f.setCorp([{ ...inOffice, itemID: 40, quantity: 70 }]);
    if (mode === "merged into a new stack") f.setCorp([]);
    if (mode === "two possible merge targets")
      f.getCorp().push({ ...inOffice, itemID: 41, quantity: 20 });
    const io = await createDockedRawDepositIO(f.run, f.session, {
      characterID: 3,
      shipID: 13,
      destinationID: 600,
      corporationID: 77,
      division: 1,
      current() {},
    });
    const before = await io.cargo(),
      stock = await io.corp();
    const act = f.session.flow.flying.bridgeDo;
    f.session.flow.flying.bridgeDo = async (...args: any[]) => {
      const result = await act(...args);
      if (args[1] === "MultiAdd") {
        if (mode === "exact IDs and more ore")
          f.getCorp().push({ ...inOffice, itemID: 50, quantity: 4 });
        if (mode === "merged" || mode === "ambiguous merge")
          f.setCorp([{ ...inOffice, itemID: 40, quantity: mode === "merged" ? 90 : 91 }]);
        if (mode === "merged into a new stack")
          f.setCorp([{ ...inOffice, itemID: 50, quantity: 20 }]);
        if (mode === "two possible merge targets")
          f.setCorp([
            { ...inOffice, itemID: 40, quantity: 75 },
            { ...inOffice, itemID: 41, quantity: 35 },
          ]);
        if (mode === "offsetting changes")
          f.setCorp([
            { ...inOffice, itemID: 40, quantity: 65 },
            { ...inOffice, itemID: 50, quantity: 25 },
          ]);
        else f.getCorp().push({ ...inOffice, itemID: 60, typeID: 800, quantity: 1 });
      }
      return result;
    };
    const check = (acknowledged: boolean) =>
      io.reconcileDelivery(
        {
          officeID: io.officeID,
          flag: io.flag,
          item: before[0]!,
          items: before,
          requestedIDs: before.map((row) => row.itemID),
          sourceBefore: before,
          destinationBefore: stock,
        },
        acknowledged,
      );
    const result = await io.depositWhole(before, before, stock);
    assert.equal(result.acknowledged, true);
    assert.deepEqual([...result.movedIDs], [20, 21]);
    assert.deepEqual(
      (await check(true)).items?.map((row) => row.itemID),
      [20, 21],
    );
    if (
      mode === "exact IDs" ||
      mode === "exact IDs and more ore" ||
      mode === "merged" ||
      mode === "merged into a new stack"
    )
      assert.deepEqual(
        (await check(false)).items?.map((row) => row.itemID),
        [20, 21],
      );
    else await assert.rejects(check(false), /unknown; no replay/);
    assert.deepEqual(await io.cargo(), []);
    assert.equal(f.getWrites(), 1);
  });
}

test("an acknowledged command still requires departure from the assigned ship and the original division", async () => {
  const f = fixture(),
    io = await createDockedRawDepositIO(f.run, f.session, {
      characterID: 3,
      shipID: 13,
      destinationID: 600,
      corporationID: 77,
      division: 1,
      current() {},
    });
  const before = await io.cargo(),
    item = before[0]!;
  const pending = {
    officeID: io.officeID,
    flag: io.flag,
    destinationOwner: 77,
    item,
    items: [item],
    requestedIDs: [item.itemID],
    sourceBefore: before,
    destinationBefore: [],
  };
  f.setHeld([{ ...item, flagID: 5 }]);
  await assert.rejects(io.reconcileDelivery(pending, true), /unknown; no replay/);
  f.setHeld([]);
  for (const wrong of [{ officeID: 701 }, { flag: 116 }, { destinationOwner: 78 }])
    await assert.rejects(
      io.reconcileDelivery({ ...pending, ...wrong }, true),
      /destination changed/,
    );
  await assert.rejects(
    io.reconcileDelivery({ ...pending, sourceBefore: [{ ...item, ownerID: 4 }] }, true),
    /ship or hold changed/,
  );
  assert.deepEqual((await io.reconcileDelivery(pending, true)).items, [item]);
  assert.equal(f.getWrites(), 0);
});

test("EveJS refuses both stacks of a MultiAdd: verified unchanged cargo releases the attempt and preserves the refusal", async () => {
  const f = fixture();
  const items = [...source.items, { ...source.items[0]!, itemID: 21 }];
  const held = items.map((row) => ({ ...row, ownerID: 3, locationID: 13, flagID: 134 }));
  f.setHeld(held);
  const unload = () => depositOwnShipRaw(f.run, f.session, {
    source: { ...source, items }, destinationID: 600, corporationID: 77, division: 1,
    wholeStacks: true, current() {}, document: f.document,
  });
  f.setRefused(true);
  await assert.rejects(unload(), { message: "Not enough hangar space", code: "CALL_REFUSED" });
  assert.equal(f.getWrites(), 1);
  assert.equal((f.getDoc() as any).pending, null);
  assert.deepEqual((f.getDoc() as any).batches, []);
  assert.deepEqual(f.getCorp(), []);
  f.setRefused(false);
  assert.equal((await unload()).batches[0]?.items?.length, 2);
  assert.equal(f.getWrites(), 2);
});

test("a MultiAdd refusal survives an unavailable first readback and a new deposit reader", async () => {
  const f = fixture();
  const items = [...source.items, { ...source.items[0]!, itemID: 21 }];
  f.setHeld(items.map((row) => ({ ...row, ownerID: 3, locationID: 13, flagID: 134 })));
  f.setRefused(true);
  const ask = f.session.flow.flying.bridgeAsk;
  let unavailable = true;
  f.session.flow.flying.bridgeAsk = async (...args: any[]) => {
    if (unavailable && f.getWrites() && args[1] === "List")
      throw Object.assign(Error("Inventory temporarily unavailable"), { status: 503 });
    return ask(...args);
  };
  const unload = () => depositOwnShipRaw(f.run, f.session, {
    source: { ...source, items }, destinationID: 600, corporationID: 77, division: 1,
    wholeStacks: true, current() {}, document: f.document,
  });
  await assert.rejects(unload(), /Inventory temporarily unavailable/);
  assert.equal((f.getDoc() as any).pending.refusalReason, "Not enough hangar space");
  unavailable = false;
  await assert.rejects(unload(), /Not enough hangar space/);
  assert.equal((f.getDoc() as any).pending, null);
  assert.equal(f.getWrites(), 1);
});

test("a lost Add needs an explicit fresh check at the original dock before an unchanged stack can be released", async () => {
  const f = fixture();
  f.setLostBeforeMove(true);
  await assert.rejects(f.call(), /reply unavailable/);
  const pending = await f.call().catch((error: unknown) => error);
  assert.ok(pending instanceof UnconfirmedHaulerUnload);
  f.setDocked(false);
  await assert.rejects(pending.checkAndRelease(), /docked pilot/);
  assert.ok((f.getDoc() as any).pending);
  f.setDocked(true);
  await pending.checkAndRelease();
  assert.equal((f.getDoc() as any).pending, null);
  assert.equal(f.getWrites(), 1);
  assert.deepEqual(f.getCorp(), []);
  f.setLostBeforeMove(false);
  assert.equal((await f.call()).batches.length, 1);
  assert.equal(f.getWrites(), 2);
});

test("a partial MultiAdd refusal never releases the intent as an undispatched batch", async () => {
  const f = fixture(),
    item = source.items[0]!,
    second = { ...item, itemID: 21 },
    rows = [item, second];
  f.setHeld(rows.map((row) => ({ ...row, ownerID: 3, locationID: 13, flagID: 134 })));
  const io = await createDockedRawDepositIO(f.run, f.session, {
    characterID: 3,
    shipID: 13,
    destinationID: 600,
    corporationID: 77,
    division: 1,
    current() {},
  });
  const before = await io.cargo(),
    stock = await io.corp();
  let calls = 0;
  const act = f.session.flow.flying.bridgeDo;
  f.session.flow.flying.bridgeDo = async (...args: any[]) => {
    if (args[1] !== "MultiAdd") return act(...args);
    calls++;
    f.setHeld([before[1]]);
    f.setCorp([{ ...item, ownerID: 77, locationID: 700, flagID: 115 }]);
    throw Object.assign(Error("Second stack refused"), {
      status: 409,
      code: "CALL_REFUSED",
      refusal: { key: "NotEnoughCargoSpace" },
    });
  };
  const result = await io.depositWhole(before, before, stock, {
    acknowledge() {
      assert.fail("No success reply");
    },
    refuseDelivery() {
      assert.fail("The first stack already moved");
    },
  });
  assert.equal(result.acknowledged, false);
  assert.deepEqual([...result.movedIDs], [item.itemID]);
  assert.equal(calls, 1);
});

test("a previously settled whole-stack receipt remains readable under its original proof", async () => {
  const f = fixture(),
    row = { typeID: 30, ownerID: 3, locationID: 13, flagID: 134, quantity: 10 };
  const rows = [20, 21].map((itemID) => ({ ...row, itemID }));
  f.setHeld(rows);
  f.setCorp([{ ...row, itemID: 40, ownerID: 77, locationID: 700, flagID: 115, quantity: 70 }]);
  const config = {
    source: {
      ...source,
      items: rows.map(({ itemID, typeID, quantity }) => ({ itemID, typeID, quantity })),
    },
    destinationID: 600,
    corporationID: 77,
    division: 1,
    wholeStacks: true,
    current() {},
    document: f.document,
  };
  await depositOwnShipRaw(f.run, f.session, config);
  const saved = structuredClone(f.getDoc()) as any,
    batch = saved.batches[0];
  // The old receipt was sealed on the full division delta, before per-stack changes were compared.
  batch.destinationAfter = [
    { ...batch.destinationBefore[0], quantity: 65 },
    { ...batch.destinationBefore[0], itemID: 90, quantity: 25 },
  ];
  f.setDoc(saved);
  assert.deepEqual((await depositOwnShipRaw(f.run, f.session, config)).batches, [batch]);
  assert.deepEqual(f.getDoc(), saved);
  assert.equal(f.getWrites(), 1);
});

test("assigned title grants Query without Take and two full stacks use one MultiAdd", async () => {
  const f = fixture();
  f.useTitle();
  f.setHeld([
    { itemID: 20, typeID: 30, ownerID: 3, locationID: 13, flagID: 134, quantity: 10 },
    { itemID: 21, typeID: 31, ownerID: 3, locationID: 13, flagID: 134, quantity: 4 },
  ]);
  const receipt = await depositOwnShipRaw(f.run, f.session, {
    source: {
      ...source,
      kind: "own-ship-freight",
      items: [...source.items, { itemID: 21, typeID: 31, quantity: 4 }],
    },
    freightKind: "ANY",
    destinationID: 600,
    corporationID: 77,
    division: 1,
    current() {},
    document: f.document,
    wholeStacks: true,
  });
  assert.deepEqual(f.calls, ["GetCorporation", "GetMember", "GetTitles", "MultiAdd"]);
  assert.equal(f.getWrites(), 1);
  assert.equal(receipt.batches[0]?.items?.length, 2);
  assert.deepEqual(
    f.getCorp().map((row) => row.typeID),
    [30, 31],
  );
});

test("missing office, missing bound office ID, and invalid division issue no transfer", async () => {
  const noOffice = fixture();
  noOffice.removeOffice();
  await assert.rejects(noOffice.call(), /no office at dock 600/);
  const noBinding = fixture();
  noBinding.loseOfficeID();
  await assert.rejects(noBinding.call(), /office is unavailable at the selected dock/);
  const noDivision = fixture();
  noDivision.removeDivision();
  await assert.rejects(noDivision.call(), /division names are unreadable/);
  const invalidDivision = fixture();
  await assert.rejects(
    createDockedRawDepositIO(invalidDivision.run, invalidDivision.session, {
      characterID: 3,
      shipID: 13,
      destinationID: 600,
      corporationID: 77,
      division: 8,
      current() {},
    }),
    /deposit scope is invalid/,
  );
  for (const f of [noOffice, noBinding, noDivision, invalidDivision])
    assert.equal(f.getWrites(), 0);
});

test("a pre-transfer location refusal clears the original whole-stack intent for a normal retry", async () => {
  const f = fixture(),
    items = [...source.items, { ...source.items[0]!, itemID: 21 }];
  f.setHeld(items.map((row) => ({ ...row, ownerID: 3, locationID: 13, flagID: 134 })));
  const unload = () =>
    depositOwnShipRaw(f.run, f.session, {
      source: { ...source, items },
      destinationID: 600,
      corporationID: 77,
      division: 1,
      wholeStacks: true,
      current() {},
      document: f.document,
    });
  const act = f.session.flow.flying.bridgeDo;
  let refused = false;
  f.session.flow.flying.bridgeDo = async (...args: any[]) => {
    if (args[1] === "MultiAdd" && !refused) {
      refused = true;
      throw Object.assign(Error("Location changed before transfer."), {
        code: "INVENTORY_LOCATION_CHANGED",
        status: 409,
      });
    }
    return act(...args);
  };
  await assert.rejects(unload(), /did not enter the transport/);
  assert.equal((f.getDoc() as any).pending, null);
  assert.equal(f.getWrites(), 0);
  const receipt = await unload();
  assert.equal(receipt.batches[0]?.items?.length, 2);
  assert.equal(f.getWrites(), 1);
});

test("a native personal Add refusal preserves its reason and leaves no uncertain deposit", async () => {
  const f = fixture();
  f.setPersonal();
  f.setRefused(true);
  await assert.rejects(f.call(), { code: "CALL_REFUSED", message: "Not enough hangar space" });
  assert.equal((f.getDoc() as any).pending, null);
  assert.equal(f.getCorp().length, 0);
  f.setRefused(false);
  const receipt = await f.call();
  assert.equal(f.getWrites(), 2);
  assert.equal(receipt.batches[0]?.destinationAfter[0]?.ownerID, 3);
});

for (const acknowledged of [true, false])
  test(
    "parking confirms a verified ore stack after a later unload (acknowledged: " +
      acknowledged +
      ")",
    async () => {
      const f = fixture(),
        stack = { itemID: 20, typeID: 30, quantity: 40_200 };
      f.setHeld([{ ...stack, ownerID: 3, locationID: 13, flagID: 134 }]);
      f.setLost(true);
      const unload = {
        source: { ...source, kind: "own-ship-freight" as const, items: [stack] },
        freightKind: "ANY" as const,
        destinationID: 600,
        corporationID: 77,
        division: 1,
        current() {},
        document: f.document,
      };
      await assert.rejects(depositOwnShipRaw(f.run, f.session, unload), /reply lost/);
      const retained = f.getDoc() as { pending: object };
      f.setDoc({ ...retained, pending: { ...retained.pending, acknowledged } });
      f.getCorp().push({
        itemID: 21,
        typeID: 30,
        quantity: 150,
        ownerID: 77,
        locationID: 700,
        flagID: 115,
      });
      const receipt = await depositOwnShipRaw(f.run, f.session, {
        ...unload,
        reconcileParking: true,
      });
      assert.equal(receipt.batches[0]?.acknowledged, acknowledged);
      assert.deepEqual(receipt.batches[0]?.item, stack);
      assert.equal(f.getWrites(), 1);
    },
  );

test("parking retains a timed out Add until the original items can be located", async () => {
  const f = fixture(),
    unload = () =>
      depositOwnShipRaw(f.run, f.session, {
        source: { ...source, kind: "own-ship-freight" },
        freightKind: "ANY",
        destinationID: 600,
        corporationID: 77,
        division: 1,
        current() {},
        document: f.document,
        reconcileParking: true,
      });
  f.setLostBeforeMove(true);
  await assert.rejects(unload(), /stack is still in the ship's hold/);
  await assert.rejects(
    unload(),
    /Check item IDs 20 in ship 13 and corporation division 1 at dock 600/,
  );
  assert.equal(f.getWrites(), 1);
  assert.equal((f.getDoc() as any).pending.acknowledged, false);
  // The timed-out command becomes visible after those reads.
  f.setHeld([]);
  f.setCorp([{ itemID: 20, typeID: 30, quantity: 12, ownerID: 77, locationID: 700, flagID: 115 }]);
  const receipt = await unload();
  assert.equal(receipt.batches[0]?.acknowledged, false);
  assert.equal(receipt.batches[0]?.item.quantity, 10);
  assert.deepEqual(await unload(), receipt);
  assert.equal(f.getWrites(), 1);
});

test("parking retains an unresolved transfer when the stack cannot be confirmed at either end", async () => {
  const f = fixture(),
    unload = {
      source: { ...source, kind: "own-ship-freight" as const },
      freightKind: "ANY" as const,
      destinationID: 600,
      corporationID: 77,
      division: 1,
      current() {},
      document: f.document,
    };
  f.setLost(true);
  await assert.rejects(depositOwnShipRaw(f.run, f.session, unload), /reply lost/);
  f.setCorp([]);
  await assert.rejects(
    depositOwnShipRaw(f.run, f.session, { ...unload, reconcileParking: true }),
    /outcome remains unknown; no replay/,
  );
  assert.equal(f.getWrites(), 1);
});
