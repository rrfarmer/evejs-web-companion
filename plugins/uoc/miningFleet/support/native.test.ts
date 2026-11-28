import test from "node:test";
import assert from "node:assert/strict";
import { createNativeBurst } from "./native.ts";
const list = (...items: any[]) => ({ type: "list", items }),
  dict = (value: any) => ({ type: "dict", entries: Object.entries(value) });
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
test("native adapter rejects a non-mining shared-group burst before a dogma write", async () => {
  let writes = 0;
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    let data: any;
    if (path === "/api/bridge/fitting")
      data = {
        activeShipID: 11,
        slots: list(
          {
            type: "packedrow",
            fields: {
              itemID: 55,
              typeID: 66,
              groupID: 1770,
              categoryID: 7,
              flagID: 27,
              quantity: 1,
              singleton: 1,
            },
          },
          {
            type: "packedrow",
            fields: {
              itemID: 77,
              typeID: 42830,
              categoryID: 8,
              flagID: 27,
              locationID: 11,
              quantity: 10,
            },
          },
        ),
        shipInfo,
        online: list(55),
        errors: { slots: null, shipInfo: null, online: null, chargeFits: null },
        chargeFits: null,
      };
    else if (path === "/api/client-data/dogma-types")
      data = {
        available: true,
        types: { 66: { groupID: 1770, defaultEffectID: 99 } },
        effects: { 99: { name: "moduleBonusWarfareLinkShield" } },
      };
    else throw Error(`unexpected ${path}`);
    return Response.json({ ok: true, ...data });
  };
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
    flow: {
      requestOptions: () => ({}),
      flying: {
        bridgeDo: async () => {
          writes++;
        },
        bridgeAsk: async () => {
          throw Error("unexpected ask");
        },
      },
    },
  };
  const recipient: any = {
    run: { characterID: 2, baseUrl: "http://bff", fetch: fetcher },
    shipID: 12,
    current() {},
    session: { ...session, store: { station: { get: () => ({ online: { characterID: 2 } }) } } },
  };
  const commander: any = {
    run: { characterID: 1, baseUrl: "http://bff", fetch: fetcher },
    shipID: 11,
    current() {},
    session,
  };
  const native = createNativeBurst({
    operationID: "op",
    runID: "run",
    commander,
    recipients: [recipient],
    moduleID: 55,
    typeID: 66,
    document: { read: () => null, write() {} },
  });
  await assert.rejects(native.activate(), /not a native mining burst/);
  assert.equal(writes, 0);
});

test("held native commander reads fitted charge, fleet, own effects and recipient notification around one burst", async () => {
  let active = false,
    writes = 0,
    clock = Date.now(),
    doc: unknown = null,
    depleted = false,
    cacheMissing = false,
    dogmaReads = 0,
    recipientOnline = true;
  const kv = (entries: any[]) => ({
      type: "object",
      name: "util.KeyVal",
      args: { type: "dict", entries },
    }),
    long = (value: string) => ({ type: "long", value }),
    flt = (shipID: number) => ({
      inSpace: true,
      docked: false,
      shipID,
      solarSystemID: 300,
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
    });
  const roster = kv([
    ["fleetID", 900],
    [
      "members",
      {
        type: "dict",
        entries: [
          [1, kv([["charID", 1]])],
          [2, kv([["charID", 2]])],
        ],
      },
    ],
  ]);
  const fetcher =
    (characterID: number, shipID: number): typeof fetch =>
    async (input) => {
      const path = new URL(String(input)).pathname;
      let data: any;
      if (path === "/api/bridge/fitting")
        data = {
          activeShipID: 11,
          slots: list(
            {
              type: "packedrow",
              fields: {
                itemID: 55,
                typeID: 66,
                groupID: 1770,
                categoryID: 7,
                flagID: 27,
                quantity: 1,
                singleton: 1,
              },
            },
            ...(depleted || cacheMissing
              ? []
              : [
                  {
                    type: "packedrow",
                    fields: {
                      itemID: 77,
                      typeID: 42830,
                      categoryID: 8,
                      flagID: 27,
                      locationID: 11,
                      quantity: 10,
                    },
                  },
                ]),
          ),
          shipInfo,
          online: list(55),
          errors: { slots: null, shipInfo: null, online: null, chargeFits: null },
          chargeFits: null,
        };
      else if (path === "/api/bridge/bound-dogma") {
        dogmaReads++;
        assert.equal(characterID, 1);
        const charge = kv([
            ["itemID", [11, 27, 42830]],
            [
              "invItem",
              {
                type: "packedrow",
                fields: {
                  itemID: [11, 27, 42830],
                  typeID: 42830,
                  ownerID: 1,
                  locationID: 11,
                  flagID: 27,
                },
              },
            ],
            ["attributes", { type: "dict", entries: [[805, 9]] }],
          ]),
          character = kv([
            ["itemID", 1],
            ["invItem", { type: "packedrow", fields: { itemID: 1 } }],
          ]);
        data = {
          reads: {
            GetAllInfo: {
              result: kv([
                ["activeShipID", 11],
                ["shipInfo", { type: "dict", entries: [[[11, 27, 42830], charge]] }],
                ["charInfo", [{ type: "dict", entries: [[1, character]] }, null]],
              ]),
            },
          },
        };
      } else if (path === "/api/client-data/dogma-types")
        data = {
          available: true,
          types: {
            66: { groupID: 1770, defaultEffectID: 99 },
            42830: {
              groupID: 1771,
              defaultEffectID: 6737,
              attributes: [
                [2468, 24],
                [2470, 2474],
                [2472, 0],
                [2536, 0],
                [2596, -15],
                [2597, 2],
                [2598, 0],
                [2599, 0],
              ],
            },
          },
          effects: { 99: { name: "moduleBonusWarfareLinkMining" } },
        };
      else if (path === "/api/bridge/flight/status") data = { flight: flt(shipID) };
      else if (path === "/api/bridge/bound-fleet")
        data = { fleetID: 900, reads: { GetInitState: { result: roster } } };
      else if (path === "/api/bridge/space/snapshot")
        data = {
          space: {
            stateValid: true,
            inSpace: true,
            shipID,
            solarSystemID: 300,
            sampledAtMs: clock,
            ship: {
              itemID: shipID,
              characterID,
              mode: "STOP",
              position: { x: 0, y: 0, z: 0 },
              radius: 10,
            },
            entities: [
              {
                itemID: 12,
                characterID: 2,
                kind: "ship",
                position: { x: 200, y: 0, z: 0 },
                radius: 10,
              },
            ],
          },
        };
      else throw Error(`unexpected ${path}`);
      return Response.json({ ok: true, ...data });
    };
  const commanderFetch = fetcher(1, 11),
    recipientFetch = fetcher(2, 12);
  const effect = (effectID: number) => [
    55,
    1,
    11,
    null,
    null,
    [],
    effectID,
    long("134385165369120001"),
    effectID === 16 ? -1 : 60000,
    1,
  ];
  const commanderSession: any = {
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
    flow: {
      requestOptions: () => ({}),
      flying: {
        bridgeAsk: async () =>
          kv([
            ["itemID", 55],
            [
              "invItem",
              {
                type: "packedrow",
                fields: { itemID: 55, typeID: 66, ownerID: 1, locationID: 11, flagID: 27 },
              },
            ],
            [
              "attributes",
              {
                type: "dict",
                entries: [
                  [54, 10000],
                  [73, 60000],
                ],
              },
            ],
            [
              "activeEffects",
              { type: "dict", entries: [[16, effect(16)], ...(active ? [[99, effect(99)]] : [])] },
            ],
            ["time", long("134385165369180001")],
            ["wallclockTime", long("134385165369179999")],
          ]),
        bridgeDo: async (_s: string, m: string) => {
          writes++;
          if (m === "Activate") active = true;
          else if (m === "Deactivate") active = false;
          else throw Error("unexpected action");
          clock++;
        },
      },
    },
  };
  const recipientSession: any = {
    store: { station: { get: () => ({ online: { characterID: 2 } }) } },
    flow: {
      requestOptions: () => ({}),
      buffBar: {
        get: () => ({
          clockOffsetMs: 0,
          incoming: active
            ? new Map([[24, { value: 2, expiresMs: Date.now() + 50000 }]])
            : new Map(),
        }),
      },
    },
  };
  const commander: any = {
      run: { characterID: 1, baseUrl: "http://bff", fetch: commanderFetch },
      session: commanderSession,
      shipID: 11,
      current() {},
    },
    recipient: any = {
      run: { characterID: 2, baseUrl: "http://bff", fetch: recipientFetch },
      session: recipientSession,
      shipID: 12,
      current() {
        if (!recipientOnline) throw Error("recipient disconnected");
      },
    };
  const native = createNativeBurst({
    operationID: "op",
    runID: "run",
    commander,
    recipients: [recipient],
    moduleID: 55,
    typeID: 66,
    document: {
      read: () => doc,
      write(v) {
        doc = structuredClone(v);
      },
    },
  });
  const before = await native.observe(),
    receipt = await native.activate();
  assert.equal(receipt?.after.active, true);
  cacheMissing = true;
  const after = await native.observe();
  assert.equal(dogmaReads, 1);
  assert.equal(after.chargeTypeID, 42830);
  assert.equal(after.chargeQuantity, 9);
  assert.equal(after.chargeItemID, null);
  assert.deepEqual(after.effectCollections, [24, 2474]);
  assert.deepEqual((await import("./controller.ts")).confirmedRecipients(before, after), [
    { characterID: 2, shipID: 12 },
  ]);
  depleted = true;
  recipientOnline = false;
  await native.settle();
  assert.equal(writes, 2);
  assert.equal((native.snapshot().history[0]?.intent.before as any).chargeTypeID, 42830);
  assert.equal("chargeQuantity" in native.snapshot().history[1]!.after, false);
});

test("missing own fitted module cannot prove inactivity or authorize settlement", async () => {
  let writes = 0;
  const fetcher: typeof fetch = async () =>
    Response.json({
      ok: true,
      activeShipID: 11,
      slots: list(),
      shipInfo,
      online: list(),
      errors: { slots: null, shipInfo: null, online: null, chargeFits: null },
      chargeFits: null,
    });
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
    flow: {
      requestOptions: () => ({}),
      flying: {
        bridgeDo: async () => {
          writes++;
        },
      },
    },
  };
  const native = createNativeBurst({
    operationID: "op",
    runID: "run",
    commander: {
      run: { characterID: 1, baseUrl: "http://bff", fetch: fetcher },
      session,
      shipID: 11,
      current() {},
    },
    recipients: [
      {
        run: { characterID: 2, baseUrl: "http://bff", fetch: fetcher },
        session,
        shipID: 12,
        current() {
          throw Error("recipient offline");
        },
      },
    ],
    moduleID: 55,
    typeID: 66,
    document: { read: () => null, write() {} },
  });
  await assert.rejects(native.settle(), /Exact own burst module is not fitted/);
  assert.equal(writes, 0);
});

test("unreadable own native effect map cannot prove inactive", async () => {
  let writes = 0;
  const fetcher: typeof fetch = async (input) => {
    const p = new URL(String(input)).pathname;
    const v =
      p === "/api/bridge/fitting"
        ? {
            activeShipID: 11,
            slots: list({
              type: "packedrow",
              fields: {
                itemID: 55,
                typeID: 66,
                groupID: 1770,
                categoryID: 7,
                flagID: 27,
                quantity: 1,
                singleton: 1,
              },
            }),
            shipInfo,
            online: list(55),
            errors: { slots: null, shipInfo: null, online: null, chargeFits: null },
            chargeFits: null,
          }
        : {
            available: true,
            types: { 66: { groupID: 1770, defaultEffectID: 99 } },
            effects: { 99: { name: "moduleBonusWarfareLinkMining" } },
          };
    return Response.json({ ok: true, ...v });
  };
  const session: any = {
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
    flow: {
      requestOptions: () => ({}),
      flying: {
        bridgeDo: async () => {
          writes++;
        },
        bridgeAsk: async () => null,
      },
    },
  };
  const native = createNativeBurst({
    operationID: "op",
    runID: "run",
    commander: {
      run: { characterID: 1, baseUrl: "http://bff", fetch: fetcher },
      session,
      shipID: 11,
      current() {},
    },
    recipients: [
      {
        run: { characterID: 2, baseUrl: "http://bff", fetch: fetcher },
        session,
        shipID: 12,
        current() {
          throw Error("recipient offline");
        },
      },
    ],
    moduleID: 55,
    typeID: 66,
    document: { read: () => null, write() {} },
  });
  await assert.rejects(native.settle(), /snapshot is incomplete/);
  assert.equal(writes, 0);
});
