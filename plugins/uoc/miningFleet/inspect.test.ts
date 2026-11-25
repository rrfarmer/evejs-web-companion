import test from "node:test";
import assert from "node:assert/strict";
import { miningFleetInspectRun, qualifyFleetFitHolds } from "./inspect.ts";
import { titlesRowset } from "./corporateOfficeFixture.ts";

function fixture(
  options: {
    docked?: boolean;
    inSpace?: boolean;
    named?: boolean;
    scanner?: "empty" | "site";
    targetSystem?: number;
    displayNames?: boolean;
    fleet?: "ready" | "unreadable";
    burst?: "mining" | "other" | "unreadable" | "badcharge" | "offline" | "empty";
    ice?: boolean;
  } = {},
) {
  const reports: any[] = [],
    calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    let body: any;
    if (path === "/api/bridge/flight/status")
      body = {
        flight: {
          docked: options.docked !== false && !options.inSpace,
          inSpace: options.inSpace === true,
          stationID: options.inSpace ? null : 600,
          solarSystemID: 300,
          shipID: 11,
          shipTypeID: 626,
        },
      };
    else if (path === "/api/bridge/call") {
      const request = JSON.parse(String(init?.body));
      if (request.service === "scanMgr") {
        const dict = (entries: any[] = []) => ({ type: "dict", entries });
        const kv = (entries: any[]) => ({
          type: "object",
          name: "util.KeyVal",
          args: dict(entries),
        });
        if (!options.scanner) throw Error("scanner unavailable");
        body = {
          result: [
            dict(
              options.scanner === "site"
                ? [
                    [
                      5800000300001,
                      kv([
                        ["instanceID", 89],
                        ["targetID", "ore-site"],
                        ["dungeonID", 1345],
                        ["archetypeID", options.ice ? 28 : 27],
                        ["scanStrengthAttribute", 211],
                        ["position", [1, 2, 3]],
                      ]),
                    ],
                  ]
                : [],
            ),
            dict(),
            dict(),
            dict(),
          ],
        };
      } else {
        assert.equal(request.service, "officeManager");
        assert.equal(request.method, "GetMyCorporationsOffices");
        body = { result: { list: [{ fields: { stationID: 600, officeID: 700 } }] } };
      }
    } else if (path === "/api/bridge/bound-fleet") {
      const kv = (entries: any[]) => ({
        type: "object",
        name: "util.KeyVal",
        args: { type: "dict", entries },
      });
      body =
        options.fleet === "ready"
          ? {
              fleetID: 90,
              reads: {
                GetInitState: {
                  result: kv([
                    ["fleetID", 90],
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
                  ]),
                },
              },
            }
          : options.fleet === "unreadable"
            ? { fleetID: null, reads: {} }
            : {
                characterID: 1,
                fleetID: null,
                reads: Object.fromEntries(
                  [
                    "GetInitState",
                    "GetWings",
                    "GetMotd",
                    "GetJoinRequests",
                    "GetFleetComposition",
                  ].map((k) => [k, { error: "CALL_REFUSED", message: "FleetNotFound" }]),
                ),
              };
    } else if (path === "/api/bridge/fitting") {
      if (!options.burst || options.burst === "unreadable") throw Error("unavailable");
      const list = (...items: any[]) => ({ type: "list", items }),
        dict = (value: any) => ({ type: "dict", entries: Object.entries(value) });
      body = {
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
          ...(options.burst === "empty"
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
        shipInfo: {
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
        },
        online: options.burst === "offline" ? list() : list(55),
        errors: { slots: null, shipInfo: null, online: null, chargeFits: null },
        chargeFits: null,
      };
    } else if (path === `/api/client-data/system-objects/${options.targetSystem ?? 300}`)
      body = {
        available: true,
        objects: [{ itemID: 123, groupID: 9, name: options.named === false ? null : "Belt I" }],
      };
    else if (path === "/api/names") {
      const q = JSON.parse(String(init?.body));
      body = {
        names: q.items.some((x: any) => x.id === 123)
          ? { "evelocation:123": options.named === false ? null : "Belt I" }
          : options.displayNames
            ? {
                "evelocation:600": "Moon Station",
                "evelocation:300": "Niyabainen",
                "owner:77": "Example Corporation",
                "type:626": "Vexor",
              }
            : {},
        capped: false,
      };
    } else if (path === "/api/client-data/dogma-types")
      body = String(input).includes("typeIDs=42830")
        ? {
            available: true,
            types: {
              42830: {
                groupID: options.burst === "badcharge" ? 999 : 1771,
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
          }
        : String(input).includes("typeIDs=66")
          ? {
              available: true,
              types: { 66: { groupID: 1770, defaultEffectID: 99 } },
              effects: {
                99: {
                  name:
                    options.burst === "other"
                      ? "moduleBonusWarfareLinkShield"
                      : "moduleBonusWarfareLinkMining",
                },
              },
            }
          : { available: true, types: { 23: { attributes: [[38, 55000]] } } };
    else throw Error(`Unexpected ${path}`);
    return Response.json({ ok: true, ...body });
  };
  const run: any = {
    setup: options.targetSystem ? { systemID: options.targetSystem } : {},
    characterID: 1,
    held: { characterID: 1, character: { characterID: 1, corporationID: 77 } },
    resumed: false,
    baseUrl: "http://bff",
    fetch: fetcher,
    report: (r: any) => reports.push(r),
  };
  return { run, reports, calls };
}
async function wait(reports: any[]) {
  for (let i = 0; i < 100 && !reports.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(reports.length);
  return reports[0];
}
const divisionNames = Array.from({ length: 7 }, (_, i) => ({
  division: i + 1,
  name: `Division ${i + 1}`,
}));
function officeFixture(
  config: {
    setup?: unknown;
    stationIDs?: unknown;
    officeError?: string;
    member?: Record<string, unknown>;
    titles?: unknown;
    inSpace?: boolean;
  } = {},
) {
  const x = fixture({ inSpace: config.inSpace });
  x.run.setup = config.setup ?? {
    corporateDestinations: [{ locationID: 700, corporationID: 77, division: 7 }],
  };
  const original = x.run.fetch as typeof fetch;
  const officeCalls: string[] = [];
  x.run.fetch = async (input: URL, init?: RequestInit) => {
    if (input.pathname === "/api/bridge/corp-offices") {
      assert.equal(input.search, "");
      officeCalls.push("office list");
      return Response.json({
        ok: true,
        stationIDs: config.stationIDs ?? [700, 800],
        divisions: divisionNames,
        error: config.officeError ?? null,
      });
    }
    if (input.pathname === "/api/bridge/call") {
      const request = JSON.parse(String(init?.body));
      if (request.service === "corpRegistry") {
        assert.equal(request.pilot, true);
        officeCalls.push(request.method);
        if (request.method === "GetCorporation") {
          assert.deepEqual(request.args, []);
          return Response.json({
            ok: true,
            result: {
              type: "object",
              name: "util.Row",
              args: {
                type: "dict",
                entries: [
                  ["header", { type: "list", items: ["corporationID", "stationID"] }],
                  ["line", { type: "list", items: [77, 700] }],
                ],
              },
            },
          });
        }
        if (request.method === "GetTitles") {
          assert.deepEqual(request.args, []);
          return Response.json({ ok: true, result: config.titles ?? titlesRowset([]) });
        }
        assert.equal(request.method, "GetMember");
        assert.deepEqual(request.args, [1]);
        return Response.json({
          ok: true,
          result: {
            type: "packedrow",
            fields: {
              characterID: 1,
              corporationID: 77,
              baseID: 800,
              titleMask: 0,
              roles: "0",
              rolesAtHQ: { type: "long", value: "67108864" },
              rolesAtBase: "8388608",
              rolesAtOther: "0",
              ...config.member,
            },
          },
        });
      }
    }
    return original(input, init);
  };
  return { ...x, officeCalls };
}

test("office inspection uses the Farmer list and confirms Query for the exact pilot and remote dock", async () => {
  const x = officeFixture({ setup: { officeLocationID: 700 } });
  await miningFleetInspectRun.start(x.run);
  const report = await wait(x.reports);
  assert.equal(report.phase, "Corporate delivery access inspected");
  assert.equal(report.readout.characterID, 1);
  assert.equal(report.readout.corporationID, 77);
  assert.equal(report.readout.locationID, 700);
  assert.equal(report.readout.officeAvailable, true);
  assert.equal(report.readout.divisions.length, 7);
  assert.deepEqual(
    report.readout.divisions.filter((row: { query: boolean }) => row.query),
    [{ division: 7, name: "Division 7", query: true, take: false }],
  );
  assert.deepEqual(x.officeCalls, ["office list", "GetCorporation", "GetMember"]);
});

test("full MCC inspection accepts verified Query at both HQ and base with one role read", async () => {
  const x = officeFixture({
    setup: {
      corporateDestinations: [
        { locationID: 700, corporationID: 77, division: 7 },
        { locationID: 800, corporationID: 77, division: 4 },
      ],
    },
  });
  await miningFleetInspectRun.start(x.run);
  const report = await wait(x.reports);
  assert.equal(report.phase, "Fleet pilot inspected");
  assert.equal(
    report.readout.stationID,
    600,
    "The pilot need not be docked at the office being checked.",
  );
  assert.deepEqual(x.officeCalls, ["office list", "GetCorporation", "GetMember"]);
});

test("Start rechecks held ship and corporate Query without rereading static belt data", async () => {
  const setup = {
    systemID: 300,
    equipmentReview: false,
    commandModules: false,
    corporateDestinations: [{ locationID: 700, corporationID: 77, division: 7 }],
  };
  const review = officeFixture({ setup }),
    start = officeFixture({ setup: { ...setup, refreshOnly: true } });
  for (const x of [review, start]) {
    const fetch = x.run.fetch;
    x.run.fetch = (url: URL, init?: RequestInit) => {
      if (url.pathname === "/api/bridge/bound-fleet")
        assert.equal(url.searchParams.get("view"), "menu");
      return fetch(url, init);
    };
    await miningFleetInspectRun.start(x.run);
    assert.equal((await wait(x.reports)).readout.shipID, 11);
  }
  assert.deepEqual(start.officeCalls, review.officeCalls);
  assert.deepEqual(start.calls, ["/api/bridge/flight/status", "/api/bridge/bound-fleet"]);
  assert.ok(review.calls.includes("/api/client-data/system-objects/300"));
  assert.ok(review.calls.includes("/api/names"));
  const denied = officeFixture({
    setup: { ...setup, refreshOnly: true },
    member: { rolesAtHQ: "0" },
  });
  await miningFleetInspectRun.start(denied.run);
  assert.equal((await wait(denied.reports)).status, "error");
});

test("an empty office list is a confirmed absence, not a permissions read error", async () => {
  const x = officeFixture({ setup: { officeLocationID: 700 }, stationIDs: [] });
  await miningFleetInspectRun.start(x.run);
  const report = await wait(x.reports);
  assert.equal(report.phase, "Corporate delivery access inspected");
  assert.deepEqual(report.readout, {
    characterID: 1,
    corporationID: 77,
    locationID: 700,
    officeAvailable: false,
    divisions: [],
  });
  assert.deepEqual(x.officeCalls, ["office list"]);
});

test("an office at another station does not qualify the configured MCC destination", async () => {
  const x = officeFixture({ stationIDs: [800] });
  await miningFleetInspectRun.start(x.run);
  assert.match((await wait(x.reports)).why, /no office at dock 700/);
  assert.deepEqual(x.officeCalls, ["office list"]);
  assert.deepEqual(x.calls, []);
});

test("full MCC inspection refuses Take without Query and selects HQ roles ahead of Base", async () => {
  const x = officeFixture({
    member: { baseID: 700, rolesAtHQ: "524288", rolesAtBase: "67108864" },
  });
  await miningFleetInspectRun.start(x.run);
  const report = await wait(x.reports);
  assert.equal(report.status, "error");
  assert.match(report.why, /lacks verified Query access to corporation division 7 at dock 700/);
  assert.deepEqual(x.calls, []);
});

test("office inspection uses Other roles at a station outside HQ and base", async () => {
  const x = officeFixture({
    setup: { officeLocationID: 900 },
    stationIDs: [900],
    member: { rolesAtOther: "2097152" },
  });
  await miningFleetInspectRun.start(x.run);
  const report = await wait(x.reports);
  assert.deepEqual(
    report.readout.divisions.filter((row: { query: boolean }) => row.query),
    [{ division: 2, name: "Division 2", query: true, take: false }],
  );
});

test("office inspection confirms director access without needing to resolve assigned titles", async () => {
  const x = officeFixture({ setup: { officeLocationID: 700 }, member: { roles: 1, titleMask: 1 } });
  await miningFleetInspectRun.start(x.run);
  const report = await wait(x.reports);
  assert.ok(
    report.readout.divisions.every(
      (row: { query: boolean; take: boolean }) => row.query && row.take,
    ),
  );
});

test("full MCC inspection accepts direct Query even with an assigned title", async () => {
  const x = officeFixture({ member: { titleMask: 1 } });
  await miningFleetInspectRun.start(x.run);
  assert.equal((await wait(x.reports)).phase, "Fleet pilot inspected");
  assert.deepEqual(x.officeCalls, ["office list", "GetCorporation", "GetMember", "GetTitles"]);
});

test("inspection combines direct and assigned title roles at HQ, base and other offices", async () => {
  const titles = titlesRowset([
    {
      titleID: 1,
      corporationID: 77,
      rolesAtHQ: "1048576",
      rolesAtBase: "2097152",
      rolesAtOther: "4194304",
    },
    { titleID: 4, corporationID: 77, rolesAtHQ: "33554432", rolesAtOther: "67108864" },
  ]);
  const x = officeFixture({
    stationIDs: [700, 800, 900],
    member: { titleMask: 1 },
    titles,
    setup: {
      corporateDestinations: [
        { locationID: 700, corporationID: 77, division: 1 },
        { locationID: 700, corporationID: 77, division: 7 },
        { locationID: 800, corporationID: 77, division: 2 },
        { locationID: 900, corporationID: 77, division: 3 },
      ],
    },
  });
  await miningFleetInspectRun.start(x.run);
  assert.equal((await wait(x.reports)).phase, "Fleet pilot inspected");
  assert.equal(x.officeCalls.filter((method) => method === "GetTitles").length, 1);

  const denied = officeFixture({
    stationIDs: [900],
    member: { titleMask: 1 },
    titles,
    setup: { corporateDestinations: [{ locationID: 900, corporationID: 77, division: 7 }] },
  });
  await miningFleetInspectRun.start(denied.run);
  assert.match(
    (await wait(denied.reports)).why,
    /lacks verified Query access to corporation division 7 at dock 900/,
  );
});

test("assigned title masks combine without granting unassigned Take or HQ permissions at Base", async () => {
  const titles = titlesRowset([
    { titleID: 1, corporationID: 77, rolesAtHQ: "1048576", rolesAtBase: "2097152" },
    { titleID: 4, corporationID: 77, rolesAtBase: "4194304" },
    { titleID: 8, corporationID: 77, rolesAtBase: "67108864" },
  ]);
  const x = officeFixture({ titles, member: { titleMask: 5 }, setup: { officeLocationID: 800 } });
  await miningFleetInspectRun.start(x.run);
  const granted = (await wait(x.reports)).readout.divisions
    .filter((row: { query: boolean }) => row.query)
    .map((row: { division: number }) => row.division);
  assert.deepEqual(granted, [2, 3, 4]);

  const take = officeFixture({
    member: { titleMask: 1, rolesAtHQ: 0 },
    titles: titlesRowset([{ titleID: 1, corporationID: 77, rolesAtHQ: "524288" }]),
  });
  await miningFleetInspectRun.start(take.run);
  assert.match((await wait(take.reports)).why, /lacks verified Query access/);
});

test("corporate office inspection rejects unreadable office and membership data", async () => {
  for (const [config, why] of [
    [{ officeError: "READ_FAILED" }, /office list or division names are unreadable/],
    [{ stationIDs: ["700"] }, /office list or division names are unreadable/],
    [{ member: { characterID: 2 } }, /pilot or corporation did not match/],
    [{ member: { corporationID: 78 } }, /pilot or corporation did not match/],
    [{ member: { rolesAtHQ: 9_223_372_036_854_775_000 } }, /Corporation roles are unreadable/],
    [{ member: { titleMask: 65536 } }, /Corporation title assignments are unreadable/],
    [
      { member: { titleMask: 1 }, titles: { type: "list", items: [] } },
      /Corporation title definitions are unreadable/,
    ],
    [
      { member: { titleMask: 1 }, titles: titlesRowset([{ titleID: 1, corporationID: 78 }]) },
      /Assigned corporation title does not match/,
    ],
    [
      {
        member: { titleMask: 1 },
        titles: titlesRowset([{ titleID: 1, corporationID: 77, rolesAtHQ: "bad" }]),
      },
      /Corporation title roles are unreadable/,
    ],
  ] as const) {
    const x = officeFixture(config);
    await miningFleetInspectRun.start(x.run);
    assert.match((await wait(x.reports)).why, why);
    assert.deepEqual(x.calls, []);
  }
});
test("inspection reports the actual held ship, station, office, named belt and native can capacity", async () => {
  const x = fixture({ displayNames: true });
  await miningFleetInspectRun.start(x.run);
  const report = await wait(x.reports);
  assert.equal(report.phase, "Fleet pilot inspected");
  assert.equal(report.readout.defender.qualified, false);
  assert.equal(report.readout.defender.evidence, null);
  const { defender, supplies, ...rest } = report.readout;
  assert.equal(supplies, null);
  assert.deepEqual(
    { ...rest, observedAt: 0 },
    {
      characterID: 1,
      shipID: 11,
      shipTypeID: 626,
      shipTypeName: "Vexor",
      stationID: 600,
      dockKind: "station",
      stationName: "Moon Station",
      systemID: 300,
      systemName: "Niyabainen",
      corporationID: 77,
      corporationName: "Example Corporation",
      officeID: 700,
      belts: [{ itemID: 123, name: "Belt I" }],
      oreSites: null,
      moonSites: null,
      iceSites: null,
      unknownSites: null,
      miningBursts: null,
      industrialCores: null,
      compressors: null,
      tractors: null,
      fitHoldQualification: null,
      fleet: { state: "not-in-fleet" },
      canCapacityM3: 55000,
      targetSystemID: 300,
      observedAt: 0,
    },
  );
  assert.ok(x.calls.every((p) => !p.includes("/select")));
});
test("missing display names remain unknown and do not block inspection", async () => {
  const x = fixture();
  await miningFleetInspectRun.start(x.run);
  const r = await wait(x.reports);
  assert.equal(r.phase, "Fleet pilot inspected");
  assert.equal(r.readout.shipTypeName, null);
  assert.equal(r.readout.stationName, null);
  assert.equal(r.readout.corporationName, null);
});
test("inspection refuses an unverified pilot location and does not invent unnamed belt names", async () => {
  const x = fixture({ docked: false });
  await miningFleetInspectRun.start(x.run);
  assert.equal((await wait(x.reports)).status, "error");
  const y = fixture({ named: false });
  await miningFleetInspectRun.start(y.run);
  assert.deepEqual((await wait(y.reports)).readout.belts, []);
});

test("in-space Review and Start keep the actual ship and verify the configured corporate office", async () => {
  const setup = {
    systemID: 300,
    equipmentReview: false,
    commandModules: false,
    corporateDestinations: [{ locationID: 700, corporationID: 77, division: 7 }],
  };
  const review = officeFixture({ inSpace: true, setup }),
    start = officeFixture({ inSpace: true, setup: { ...setup, refreshOnly: true } });
  for (const x of [review, start]) {
    await miningFleetInspectRun.start(x.run);
    const report = await wait(x.reports);
    assert.equal(report.phase, "Fleet pilot inspected", report.why);
    assert.equal(report.readout.inSpace, true);
    assert.equal(report.readout.shipID, 11);
    assert.equal(report.readout.systemID, 300);
    assert.equal(report.readout.stationID, null);
    assert.equal(report.readout.dockKind, undefined);
    assert.equal(report.readout.officeID, null);
    assert.deepEqual(x.officeCalls, ["office list", "GetCorporation", "GetMember"]);
  }
  assert.deepEqual(start.calls, ["/api/bridge/flight/status", "/api/bridge/bound-fleet"]);
  const denied = officeFixture({ inSpace: true, setup, member: { rolesAtHQ: "0" } });
  await miningFleetInspectRun.start(denied.run);
  assert.match((await wait(denied.reports)).why, /lacks verified Query/);
});

test("local scanner results from a held ship in space qualify for Review without a dock", async () => {
  const x = fixture({ inSpace: true, scanner: "site", displayNames: true });
  x.run.setup = { equipmentReview: false, commandModules: false };
  await miningFleetInspectRun.start(x.run);
  const report = await wait(x.reports);
  assert.equal(report.phase, "Fleet pilot inspected", report.why);
  assert.equal(report.readout.stationName, null);
  assert.equal(report.readout.oreSites?.length, 1);
  assert.deepEqual(report.readout.belts, [{ itemID: 123, name: "Belt I" }]);
  assert.equal(x.calls.filter((path) => path === "/api/bridge/call").length, 1);
});

test("inspection distinguishes valid empty scanner and a native ore site from unavailable scanner", async () => {
  const e = fixture({ scanner: "empty" });
  await miningFleetInspectRun.start(e.run);
  assert.deepEqual((await wait(e.reports)).readout.oreSites, []);
  const s = fixture({ scanner: "site" });
  await miningFleetInspectRun.start(s.run);
  const rows = (await wait(s.reports)).readout.oreSites;
  assert.equal(rows[0].scannerKey, 5800000300001);
  assert.equal(rows[0].instanceID, 89);
});

test("inspection preserves complete native fleet identity and rejects unreadable membership", async () => {
  const a = fixture({ fleet: "ready" });
  await miningFleetInspectRun.start(a.run);
  assert.deepEqual((await wait(a.reports)).readout.fleet, {
    state: "ready",
    fleetID: 90,
    memberIDs: [1, 2],
  });
  const b = fixture({ fleet: "unreadable" });
  await miningFleetInspectRun.start(b.run);
  assert.equal((await wait(b.reports)).status, "error");
});

test("inspection separates ice sites and reports only native mining bursts with their loaded charge", async () => {
  const x = fixture({ scanner: "site", ice: true, burst: "mining" });
  await miningFleetInspectRun.start(x.run);
  const r = (await wait(x.reports)).readout;
  assert.deepEqual(r.oreSites, []);
  assert.equal(r.iceSites[0].target.kind, "ICE");
  assert.deepEqual(r.miningBursts, [
    {
      moduleID: 55,
      typeID: 66,
      name: null,
      online: true,
      chargeTypeID: 42830,
      chargeQuantity: 10,
      chargeSupported: true,
    },
  ]);
  const y = fixture({ burst: "other" });
  await miningFleetInspectRun.start(y.run);
  assert.deepEqual((await wait(y.reports)).readout.miningBursts, []);
  const z = fixture({ burst: "unreadable" });
  await miningFleetInspectRun.start(z.run);
  assert.equal((await wait(z.reports)).readout.miningBursts, null);
});

test("burst inspection does not present unready charge or offline modules as supported and online", async () => {
  for (const [kind, field, value] of [
    ["badcharge", "chargeSupported", false],
    ["offline", "online", false],
    ["empty", "chargeQuantity", null],
  ] as const) {
    const x = fixture({ burst: kind });
    await miningFleetInspectRun.start(x.run);
    assert.equal((await wait(x.reports)).readout.miningBursts[0][field], value);
  }
});

test("fleet qualification requires exact resource-family module and a readable eligible hold", () => {
  const hold = (key: string, capacity: number, used = 0) => ({
      key,
      present: true,
      error: null,
      capacity: { capacity, used },
      items: [],
    }),
    panel = { activeShipID: 11, holds: [hold("ore", 100)] };
  assert.deepEqual(
    qualifyFleetFitHolds(11, [{ family: "ice", range: 1000, cycleMs: 100 }], panel, []),
    { ORE: { miner: false, hauler: true }, ICE: { miner: true, hauler: true } },
  );
  assert.equal(
    qualifyFleetFitHolds(11, [{ family: "ore", range: 0, cycleMs: 100 }], panel, []).ORE.miner,
    false,
  );
  assert.equal(
    qualifyFleetFitHolds(
      11,
      [{ family: "ore", range: 1, cycleMs: 100 }],
      { activeShipID: 11, holds: [hold("ore", 100, 100)] },
      [],
    ).ORE.miner,
    false,
  );
  assert.throws(() => qualifyFleetFitHolds(12, [], panel, []), /unreadable/);
  assert.throws(
    () =>
      qualifyFleetFitHolds(
        11,
        [],
        { activeShipID: 11, holds: [{ ...hold("ore", 100), error: "unknown" }] },
        [],
      ),
    /unreadable/,
  );
});

test("remote anchor inspection reads anchor map while keeping actual dock identity and scanner unknown", async () => {
  const x = fixture({ targetSystem: 301, scanner: "site" });
  await miningFleetInspectRun.start(x.run);
  const r = await wait(x.reports);
  assert.equal(r.readout.systemID, 300);
  assert.equal(r.readout.targetSystemID, 301);
  assert.deepEqual(r.readout.belts, [{ itemID: 123, name: "Belt I" }]);
  assert.equal(r.readout.oreSites, null);
  assert.ok(x.calls.includes("/api/client-data/system-objects/301"));
});
