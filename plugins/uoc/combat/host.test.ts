import test from "node:test";
import assert from "node:assert/strict";
import { createNativeSecurityRun } from "./host.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import type { SecurityStorage } from "./journal.ts";
import { createSignal } from "../../../web/src/store/signals.ts";
import type { ClientQuestion, QuestionAnswer } from "../../../web/src/store/types.ts";
const list = (...items: unknown[]) => ({ type: "list", items });
const tuple = (...items: unknown[]) => ({ type: "tuple", items });
const dict = (x: Record<string, unknown>) => ({ type: "dict", entries: Object.entries(x) });
function answer() {
  return tuple(tuple(tuple("Agent", null), list(tuple(11, 2))), dict({ missionCompleted: false }));
}
test("solo host uses held native request once then parks without reselecting", async () => {
  let row: any = null,
    writes = 0,
    settlements = 0,
    releaseSleep: () => void = () => {},
    reached: () => void = () => {};
  const paused = new Promise<void>((r) => {
    reached = r;
  });
  const storage: SecurityStorage = {
    read: () => row,
    write: (v) => {
      row = structuredClone(v);
    },
  };
  const paths: string[] = [],
    reports: any[] = [];
  const run = {
    botID: "security-test",
    characterID: 141100100,
    held: { characterID: 141100100, character: { characterID: 141100100 } },
    baseUrl: "http://held.test",
    setup: { agentID: 4, missionCount: 1 },
    resumed: false,
    report: (r: any) => reports.push(r),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(String(input)).pathname;
      paths.push(p);
      let body: any = { ok: true };
      if (p === "/api/pilot-training/characters")
        body = { ok: true, account: "Test20", characters: [{ characterID: 141100100 }] };
      else if (p === "/api/bots")
        body = {
          ok: true,
          bots: [
            {
              botID: "security-test",
              characterID: 141100100,
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
            },
          ],
        };
      else if (p === "/api/bridge/flight/status")
        body = {
          ok: true,
          flight: { docked: true, inSpace: false, shipID: 3, stationID: 5, solarSystemID: 6 },
        };
      else if (p === "/api/bridge/agents/4/record")
        body = {
          ok: true,
          agent: {
            agentID: 4,
            level: 1,
            divisionID: 24,
            agentTypeID: 2,
            stationID: 5,
            solarSystemID: 6,
          },
        };
      else if (p === "/api/bridge/call") {
        const q = JSON.parse(String(init?.body));
        assert.equal(q.pilot, true);
        if (q.method === "GetMyJournalDetails") body = { ok: true, result: tuple(list(), list()) };
        else if (q.method === "DoAction") {
          if (q.args[0] === 11) writes++;
          body = { ok: true, result: answer() };
        } else if (q.method === "GetCurrentDungeonForCharacter") body = { ok: true, result: null };
        else if (q.method === "IsInActiveDungeonID") body = { ok: true, result: false };
        else if (q.method === "InvalidateLocationCache") body = { ok: true, result: null };
        else throw Error(`unexpected ${q.method}`);
      } else throw Error(`unexpected ${p}`);
      return Response.json(body);
    },
  };
  const session = {
    flow: {
      flying: {
        sessionGeneration: () => 1,
        isSessionClosing: () => false,
        abortAutopilot: () => {},
        autopilotProgress: () => null,
      },
      abortRoute: () => {},
      prepareHostedBotStop: async () => {
        settlements++;
      },
      setLivePush: () => {},
    },
  } as unknown as PilotSession;
  const sleep = async () => {
    reached();
    await new Promise<void>((r) => {
      releaseSleep = r;
    });
  };
  const backend = createNativeSecurityRun({
    attach: async () => session,
    document: () => storage,
    sleep,
  });
  const handle = await backend.start(run as never);
  await paused;
  assert.equal(writes, 1);
  assert.equal(row.active.pending.kind, "REQUEST");
  assert.equal(row.active.pending.status, "ACKNOWLEDGED");
  const stopping = Promise.resolve(handle.stop());
  releaseSleep();
  await assert.rejects(stopping, /unresolved/);
  assert.equal(writes, 1);
  assert.equal(settlements, 0);
  assert.equal(paths.includes("/api/bridge/select"), false);
  assert.ok(
    reports.some((r) => r.status === "paused" && r.phase === "Docked — reconciliation pending"),
  );
});
test("host completes two distinct native missions and retires room authority between them", async () => {
  let row: any = null,
    index = 0,
    state: 0 | 1 | 2 = 0,
    docked = true,
    landed = false,
    done = false,
    drone = false,
    returned = false,
    droneTarget: number | null = null,
    moduleActive = false,
    engages = 0,
    settles = 0,
    completed = false;
  const writes: string[] = [];
  const live = createSignal<{ questions: ClientQuestion[] }>({ questions: [] });
  let receiveRewardAnswer: (answer: QuestionAnswer) => void = () => {};
  const rewardAnswers: QuestionAnswer[] = [];
  const label = (name: string) => ({
    label: "UI/Agents/StandardMission/" + name,
    parameters: null,
    text: null,
  });
  const ids = [2504, 2925],
    dungeons = [875, 1940],
    pos = () => index * 1000000 + 100,
    missionID = () => ids[index]!,
    dungeonID = () => dungeons[index]!;
  const response = (button: number | null, complete = false) =>
    tuple(
      tuple(tuple("Agent", null), list(...(button === null ? [] : [tuple(button, button)]))),
      dict({ missionCompleted: complete }),
    );
  const storage: SecurityStorage = {
    read: () => row,
    write: (v) => {
      row = structuredClone(v);
    },
  };
  const run = {
    botID: "security-two",
    characterID: 141100100,
    held: { characterID: 141100100, character: { characterID: 141100100 } },
    baseUrl: "http://held.test",
    setup: { agentID: 4, missionCount: 2, rewardPolicy: "SHARE" },
    resumed: false,
    report: (r: any) => {
      if (r.status === "stopped") completed = true;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(String(input)).pathname;
      let body: any = { ok: true };
      if (p === "/api/pilot-training/characters")
        body = { ok: true, account: "Test20", characters: [{ characterID: 141100100 }] };
      else if (p === "/api/bots")
        body = {
          ok: true,
          bots: [
            {
              botID: "security-two",
              characterID: 141100100,
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
            },
          ],
        };
      else if (p === "/api/bridge/flight/status")
        body = {
          ok: true,
          flight: {
            docked,
            inSpace: !docked,
            shipID: 3,
            stationID: docked ? 5 : null,
            solarSystemID: 6,
            shipMode: "STOP",
          },
        };
      else if (p === "/api/bridge/agents/4/record")
        body = {
          ok: true,
          agent: {
            agentID: 4,
            level: 1,
            divisionID: 24,
            agentTypeID: 2,
            stationID: 5,
            solarSystemID: 6,
            corporationID: 44,
          },
        };
      else if (p === "/api/bridge/agents/4/briefing")
        body = {
          ok: true,
          errors: { objective: null },
          objective: dict({
            contentID: missionID(),
            missionState: state,
            completionStatus: done ? 1 : 0,
            objectives: list(),
            normalRewards: list(tuple(29, 100, null)),
            dungeons: list(
              dict({
                dungeonID: dungeonID(),
                optional: false,
                location: dict({
                  solarsystemID: 6,
                  locationNumber: 0,
                  agentID: 4,
                  locationType: "dungeon",
                  coords: tuple(pos(), 2, 3),
                }),
                objectiveCompleted: done ? 1 : 0,
              }),
            ),
          }),
        };
      else if (p === "/api/bridge/space/snapshot")
        body = {
          ok: true,
          space: {
            inSpace: true,
            stateValid: true,
            shipID: 3,
            solarSystemID: 6,
            ship: {
              itemID: 3,
              position: { x: pos(), y: 2, z: 3 },
              radius: 10,
              hullRatio: 1,
              activeModuleIDs: [],
            },
            entities: [
              ...(done
                ? []
                : [
                    {
                      itemID: 70,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: 26727,
                      groupID: 319,
                      categoryID: 11,
                      position: { x: pos() + 20, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                    {
                      itemID: 90 + index,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: index === 0 ? 16087 : 16981,
                      groupID: index === 0 ? 818 : 615,
                      categoryID: 11,
                      position: { x: pos() + 100, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                    {
                      itemID: 9999,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: index === 0 ? 16087 : 16981,
                      groupID: index === 0 ? 818 : 615,
                      categoryID: 11,
                      position: { x: pos() + 57000, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                  ]),
              ...(drone
                ? [
                    {
                      itemID: 8,
                      kind: "drone",
                      ownerID: 141100100,
                      controllerID: 3,
                      targetEntityID: droneTarget,
                      position: { x: pos(), y: 2, z: 3 },
                      radius: 1,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                  ]
                : []),
            ],
          },
        };
      else if (p === "/api/bridge/drones")
        body = {
          ok: true,
          activeShipID: 3,
          bay: drone ? [] : [{ itemID: 7, typeID: 8, quantity: 1 }],
          inSpace: drone
            ? [
                {
                  itemID: 8,
                  controlled: true,
                  targetID: null,
                  shieldRatio: 1,
                  armorRatio: 1,
                  hullRatio: 1,
                },
              ]
            : [],
        };
      else if (p === "/api/bridge/call") {
        const q = JSON.parse(String(init?.body));
        if (q.method === "GetMyJournalDetails") {
          const entry = tuple(state, 0, 0, 70, 4, String(1000 + index), 0, 0, 0, missionID());
          body = {
            ok: true,
            result: tuple(
              list(...(state === 2 ? [entry] : [])),
              list(...(state === 1 ? [entry] : [])),
            ),
          };
        } else if (q.method === "DoAction") {
          const id = q.args[0];
          if (id === null)
            body = { ok: true, result: response(state === 0 ? 2 : state === 1 ? 3 : 6) };
          else if (id === 2) {
            writes.push(`request:${index}`);
            state = 1;
            body = { ok: true, result: response(3) };
          } else if (id === 3) {
            writes.push(`accept:${index}`);
            state = 2;
            body = { ok: true, result: response(6) };
          } else if (id === 6) {
            writes.push(`complete:${index}`);
            if (index === 1) {
              const reply = new Promise<QuestionAnswer>((resolve) => {
                receiveRewardAnswer = resolve;
              });
              live.set({
                questions: [
                  {
                    id: "fleet-reward",
                    kind: "choice",
                    service: "agents",
                    method: "SingleChoiceBox",
                    suppressID: "AgtShare",
                    agentID: 4,
                    contentID: missionID(),
                    title: { label: null, parameters: null, text: "" },
                    body: label("CompleteShareWithFleetMessage"),
                    choices: [label("ShareWithFleetYes"), label("ShareWithFleetNo")],
                    askedAtMs: Date.now(),
                    expiresAtMs: Date.now() + 5000,
                    quantity: null,
                  },
                ],
              });
              assert.deepEqual(await reply, { confirmed: true, index: 0 });
            }
            state = 0;
            body = { ok: true, result: response(null, true) };
            index++;
            done = false;
            landed = false;
            returned = false;
          } else throw Error(`button ${id}`);
        } else if (q.method === "GetCurrentDungeonForCharacter")
          body = { ok: true, result: landed ? tuple(dungeonID(), 0, 200 + index) : null };
        else if (q.method === "IsInActiveDungeonID") body = { ok: true, result: landed };
        else if (q.method === "InvalidateLocationCache") body = { ok: true, result: null };
        else if (q.method === "List")
          body = {
            ok: true,
            result: list(
              ...(q.args[0] === 87 && !drone
                ? [
                    {
                      type: "packedrow",
                      fields: {
                        itemID: returned ? 8 : 7,
                        typeID: 8,
                        ownerID: 141100100,
                        locationID: 3,
                        flagID: 87,
                        quantity: 1,
                        stacksize: 1,
                        categoryID: 18,
                      },
                    },
                  ]
                : q.args[0] === 27
                  ? [
                      {
                        type: "packedrow",
                        fields: {
                          itemID: 55,
                          typeID: 66,
                          ownerID: 141100100,
                          locationID: 3,
                          flagID: 27,
                          quantity: -1,
                          stacksize: 1,
                          categoryID: 7,
                        },
                      },
                    ]
                  : []),
            ),
          };
        else if (q.method === "ItemGetInfo") {
          const lng = { type: "long", value: "134385165369120001" };
          body = {
            ok: true,
            result: {
              type: "object",
              name: "util.KeyVal",
              args: dict({
                itemID: 55,
                invItem: {
                  type: "packedrow",
                  fields: { itemID: 55, typeID: 66, ownerID: 141100100, locationID: 3, flagID: 27 },
                },
                activeEffects: {
                  type: "dict",
                  entries: [
                    [16, [55, 141100100, 3, null, null, [], 16, lng, -1, 1]],
                    ...(moduleActive
                      ? [[67, [55, 141100100, 3, 90 + index, null, [], 67, lng, 1000, 1]]]
                      : []),
                  ],
                },
                time: lng,
                wallclockTime: lng,
              }),
            },
          };
        } else if (q.method === "Deactivate") {
          writes.push(`module-stop:${index}`);
          moduleActive = false;
          body = { ok: true, result: null };
        } else if (q.method === "LaunchDrones") {
          writes.push(`launch:${index}`);
          drone = true;
          body = { ok: true, result: { type: "dict", entries: [[7, list(8)]] } };
        } else if (q.method === "CmdReturnBay") {
          writes.push(`recall:${index}`);
          returned = true;
          drone = false;
          droneTarget = null;
          settles++;
          body = { ok: true, result: { type: "dict", entries: [] } };
        } else if (q.method === "CmdEngage") {
          assert.equal(q.args[1], 90 + index);
          writes.push(`engage:${index}`);
          engages++;
          droneTarget = q.args[1];
          done = true;
          moduleActive = true;
          body = { ok: true, result: { type: "dict", entries: [] } };
        } else if (q.method === "GetCashBalance") body = { ok: true, result: 100 };
        else if (
          q.method === "GetAllMyCharacterWalletLPBalances" ||
          q.method === "GetAllMyCorporationWalletLPBalances"
        )
          body = {
            ok: true,
            result: {
              type: "objectex2",
              list: [{ type: "packedrow", fields: { issuerCorpID: 44, loyaltyPoints: index * 5 } }],
            },
          };
        else if (q.method === "GetCorporation")
          body = {
            ok: true,
            result: {
              type: "object",
              name: "util.KeyVal",
              args: dict({ corporationID: 99000001 }),
            },
          };
        else if (q.method === "GetTransactions")
          body = {
            ok: true,
            result: list(
              ...Array.from({ length: index }, (_, i) => ({
                type: "packedrow",
                fields: {
                  transactionID: 100 + i,
                  transactionDate: 999,
                  referenceID: 4,
                  entryTypeID: 33,
                  ownerID1: 4,
                  ownerID2: 141100100,
                  amount: 0,
                  balance: 100,
                  description: "93: [99000001, 100]",
                },
              })),
            ),
          };
        else body = { ok: false, error: "reward unavailable" };
      } else throw Error(`unexpected ${p}`);
      return Response.json(body);
    },
  };
  const session = {
    store: { live, fitting: { get: () => ({}) } },
    flow: {
      answerQuestion: async (id: string, answer: QuestionAnswer) => {
        assert.equal(id, "fleet-reward");
        rewardAnswers.push(answer);
        live.set({ questions: [] });
        receiveRewardAnswer(answer);
      },
      flying: {
        sessionGeneration: () => 1,
        isSessionClosing: () => false,
        abortAutopilot: () => {},
        autopilotProgress: () => null,
        readFit: async () => true,
        resolveDroneControlRange: async () => 45000,
        classifyDroneRoles: async () => ({
          bay: { combat: drone ? [] : [7] },
          out: { combat: drone ? [8] : [] },
        }),
        launchedThenRead: async () => {
          drone = true;
        },
        engageDronesConfirmed: async (_ids: unknown, target: number) => {
          assert.equal(target, 90 + index);
          engages++;
          done = true;
          moduleActive = true;
        },
      },
      abortRoute: () => {},
      prepareHostedBotStop: async () => {
        settles++;
        if (drone) returned = true;
        drone = false;
        droneTarget = null;
      },
      setLivePush: () => {},
      undock: async () => {
        docked = false;
      },
      warpToMissionBookmark: async () => {
        landed = true;
      },
      startRoute: async () => {
        docked = true;
        landed = false;
        return { started: true };
      },
    },
  } as unknown as PilotSession;
  const backend = createNativeSecurityRun({
    attach: async () => session,
    document: () => storage,
    sleep: async () => {
      await new Promise((r) => setImmediate(r));
    },
  });
  assert.equal((await backend.check({ agentID: 4, missionCount: 2 })).ok, true);
  const handle = await backend.start(run as never);
  for (let n = 0; n < 500 && !completed; n++) await new Promise((r) => setImmediate(r));
  assert.equal(
    completed,
    true,
    `phase ${row?.active?.phase} pending ${row?.active?.pending?.kind}`,
  );
  await handle.stop();
  assert.deepEqual(writes, [
    "request:0",
    "accept:0",
    "launch:0",
    "engage:0",
    "recall:0",
    "module-stop:0",
    "complete:0",
    "request:1",
    "accept:1",
    "launch:1",
    "engage:1",
    "recall:1",
    "module-stop:1",
    "complete:1",
  ]);
  assert.equal(engages, 2);
  assert.deepEqual(rewardAnswers, [{ confirmed: true, index: 0 }]);
  assert.ok(settles >= 2);
  const receipts = row.active.completed;
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].identity.acceptedKey, receipts[1].identity.acceptedKey);
  assert.equal(receipts[0].isk, null);
  assert.equal(receipts[1].isk, null);
  for (const receipt of receipts) {
    assert.equal(receipt.reward?.confirmedIsk, "0.00");
    assert.equal(receipt.reward?.withheldIsk, "100.00");
    assert.equal(receipt.reward?.observedLpChange, "5");
    assert.equal(receipt.reward?.observedCorporationLpChange, "5");
    assert.equal(receipt.reward?.missionKey, receipt.identity.acceptedKey);
  }
});

for (const initiallyDocked of [true, false])
  test(`host resumes exact accepted ${initiallyDocked ? "docked" : "in-space"} mission then completes two distinct missions`, async () => {
    const key = JSON.stringify([4, 2504, 70, "1000"]),
      offer = {
        agentID: 4,
        missionID: 2504,
        titleID: 70,
        expirationTime: "1000",
        key,
        status: "offered",
        contentID: 2504,
        dungeonID: 875,
        dungeonCount: 1,
        otherObjectives: 0,
        shipRestricted: false,
        destinationSystemID: 6,
        locationNumber: 0,
        expectedISK: 100,
      };
    let telemetryValue: any = {
      runID: "security-two",
      events: Array.from({ length: 64 }, (_, n) => ({
        kind: "sample",
        at: n,
        data: { large: "x".repeat(4000) },
      })),
    };
    let record: any = { readout: null, status: "running" },
      deliveries = Promise.resolve(),
      stopRace: Promise<void> | null = null,
      handleRef: any = null;
    let row: any = {
        version: 1,
        revision: 3,
        runID: "old-security",
        accountID: "test20",
        characterID: 141100100,
        shipID: 3,
        agentID: 4,
        agentStationID: 5,
        agentSystemID: 6,
        deadlineMs: 1,
        missionLimit: 2,
        phase: "COMBAT",
        reason: null,
        offer,
        identity: {
          agentID: 4,
          missionID: 2504,
          titleID: 70,
          acceptedKey: key,
          contentID: 2504,
          dungeonID: 875,
          destinationSystemID: 6,
          locationNumber: 0,
          instanceID: 200,
          roomID: 0,
        },
        pending: null,
        before: null,
        completed: [],
      },
      index = 0,
      state: 0 | 1 | 2 = 2,
      docked = initiallyDocked,
      landed = !initiallyDocked,
      done = false,
      drone = false,
      returned = false,
      droneTarget: number | null = null,
      moduleActive = false,
      engages = 0,
      settles = 0,
      completed = false;
    const writes: string[] = [];
    const ids = [2504, 2925],
      dungeons = [875, 1940],
      pos = () => index * 1000000 + 100,
      missionID = () => ids[index]!,
      dungeonID = () => dungeons[index]!;
    const response = (button: number | null, complete = false) =>
      tuple(
        tuple(tuple("Agent", null), list(...(button === null ? [] : [tuple(button, button)]))),
        dict({ missionCompleted: complete }),
      );
    const storage: SecurityStorage = {
      read: () => row,
      write: (v) => {
        row = structuredClone(v);
      },
    };
    const run = {
      botID: "security-two",
      characterID: 141100100,
      held: { characterID: 141100100, character: { characterID: 141100100 } },
      baseUrl: "http://held.test",
      setup: { agentID: 4, missionCount: 2 },
      resumed: false,
      report: (r: any) => {
        if (r.status === "running" && r.readout && row?.active)
          assert.equal(r.readout.completedCount, row.active.completed.length);
        const report = structuredClone(r);
        if (report.status === "stopped" && handleRef) stopRace = Promise.resolve(handleRef.stop());
        deliveries = deliveries.then(async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (
            report.readout !== undefined &&
            Buffer.byteLength(JSON.stringify(report.readout)) <= 16384
          )
            record.readout = report.readout;
          if (record.status !== "stopped") record.status = report.status;
          if (report.status === "stopped") completed = true;
        });
      },
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const p = new URL(String(input)).pathname;
        let body: any = { ok: true };
        if (p === "/api/pilot-training/characters")
          body = { ok: true, account: "Test20", characters: [{ characterID: 141100100 }] };
        else if (p === "/api/bots")
          body = {
            ok: true,
            bots: [
              {
                botID: "security-two",
                characterID: 141100100,
                expiresAt: new Date(Date.now() + 1800000).toISOString(),
              },
            ],
          };
        else if (p === "/api/bridge/flight/status")
          body = {
            ok: true,
            flight: {
              docked,
              inSpace: !docked,
              shipID: 3,
              stationID: docked ? 5 : null,
              solarSystemID: 6,
              shipMode: "STOP",
            },
          };
        else if (p === "/api/bridge/agents/4/record")
          body = {
            ok: true,
            agent: {
              agentID: 4,
              level: 1,
              divisionID: 24,
              agentTypeID: 2,
              stationID: 5,
              solarSystemID: 6,
            },
          };
        else if (p === "/api/bridge/agents/4/briefing")
          body = {
            ok: true,
            errors: { objective: null },
            objective: dict({
              contentID: missionID(),
              missionState: state,
              completionStatus: done ? 1 : 0,
              objectives: list(),
              normalRewards: list(tuple(29, 100, null)),
              dungeons: list(
                dict({
                  dungeonID: dungeonID(),
                  optional: false,
                  location: dict({
                    solarsystemID: 6,
                    locationNumber: 0,
                    agentID: 4,
                    locationType: "dungeon",
                    coords: tuple(pos(), 2, 3),
                  }),
                  objectiveCompleted: done ? 1 : 0,
                }),
              ),
            }),
          };
        else if (p === "/api/bridge/space/snapshot")
          body = {
            ok: true,
            space: {
              inSpace: true,
              stateValid: true,
              shipID: 3,
              solarSystemID: 6,
              ship: {
                itemID: 3,
                position: { x: pos(), y: 2, z: 3 },
                radius: 10,
                hullRatio: 1,
                activeModuleIDs: [],
              },
              entities: [
                ...(done
                  ? []
                  : [
                      {
                        itemID: 70,
                        kind: "ship",
                        isNpc: true,
                        npcEntityType: "npc",
                        typeID: 26727,
                        groupID: 319,
                        categoryID: 11,
                        position: { x: pos() + 20, y: 2, z: 3 },
                        radius: 10,
                        shieldRatio: 1,
                        armorRatio: 1,
                        hullRatio: 1,
                      },
                      {
                        itemID: 90 + index,
                        kind: "ship",
                        isNpc: true,
                        npcEntityType: "npc",
                        typeID: index === 0 ? 16087 : 16981,
                        groupID: index === 0 ? 818 : 615,
                        categoryID: 11,
                        position: { x: pos() + 100, y: 2, z: 3 },
                        radius: 10,
                        shieldRatio: 1,
                        armorRatio: 1,
                        hullRatio: 1,
                      },
                      {
                        itemID: 9999,
                        kind: "ship",
                        isNpc: true,
                        npcEntityType: "npc",
                        typeID: index === 0 ? 16087 : 16981,
                        groupID: index === 0 ? 818 : 615,
                        categoryID: 11,
                        position: { x: pos() + 57000, y: 2, z: 3 },
                        radius: 10,
                        shieldRatio: 1,
                        armorRatio: 1,
                        hullRatio: 1,
                      },
                    ]),
                ...(drone
                  ? [
                      {
                        itemID: 8,
                        kind: "drone",
                        ownerID: 141100100,
                        controllerID: 3,
                        targetEntityID: droneTarget,
                        position: { x: pos(), y: 2, z: 3 },
                        radius: 1,
                        shieldRatio: 1,
                        armorRatio: 1,
                        hullRatio: 1,
                      },
                    ]
                  : []),
              ],
            },
          };
        else if (p === "/api/bridge/drones")
          body = {
            ok: true,
            activeShipID: 3,
            bay: drone ? [] : [{ itemID: 7, typeID: 8, quantity: 1 }],
            inSpace: drone
              ? [
                  {
                    itemID: 8,
                    controlled: true,
                    targetID: null,
                    shieldRatio: 1,
                    armorRatio: 1,
                    hullRatio: 1,
                  },
                ]
              : [],
          };
        else if (p === "/api/bridge/call") {
          const q = JSON.parse(String(init?.body));
          if (q.method === "GetMyJournalDetails") {
            const entry = tuple(state, 0, 0, 70, 4, String(1000 + index), 0, 0, 0, missionID());
            body = {
              ok: true,
              result: tuple(
                list(...(state === 2 ? [entry] : [])),
                list(...(state === 1 ? [entry] : [])),
              ),
            };
          } else if (q.method === "DoAction") {
            const id = q.args[0];
            if (id === null)
              body = { ok: true, result: response(state === 0 ? 2 : state === 1 ? 3 : 6) };
            else if (id === 2) {
              writes.push(`request:${index}`);
              state = 1;
              body = { ok: true, result: response(3) };
            } else if (id === 3) {
              writes.push(`accept:${index}`);
              state = 2;
              body = { ok: true, result: response(6) };
            } else if (id === 6) {
              writes.push(`complete:${index}`);
              state = 0;
              body = { ok: true, result: response(null, true) };
              index++;
              done = false;
              landed = false;
              returned = false;
            } else throw Error(`button ${id}`);
          } else if (q.method === "GetCurrentDungeonForCharacter")
            body = { ok: true, result: landed ? tuple(dungeonID(), 0, 200 + index) : null };
          else if (q.method === "IsInActiveDungeonID") body = { ok: true, result: landed };
          else if (q.method === "InvalidateLocationCache") body = { ok: true, result: null };
          else if (q.method === "List")
            body = {
              ok: true,
              result: list(
                ...(q.args[0] === 87 && !drone
                  ? [
                      {
                        type: "packedrow",
                        fields: {
                          itemID: returned ? 8 : 7,
                          typeID: 8,
                          ownerID: 141100100,
                          locationID: 3,
                          flagID: 87,
                          quantity: 1,
                          stacksize: 1,
                          categoryID: 18,
                        },
                      },
                    ]
                  : q.args[0] === 27
                    ? [
                        {
                          type: "packedrow",
                          fields: {
                            itemID: 55,
                            typeID: 66,
                            ownerID: 141100100,
                            locationID: 3,
                            flagID: 27,
                            quantity: -1,
                            stacksize: 1,
                            categoryID: 7,
                          },
                        },
                      ]
                    : []),
              ),
            };
          else if (q.method === "ItemGetInfo") {
            const lng = { type: "long", value: "134385165369120001" };
            body = {
              ok: true,
              result: {
                type: "object",
                name: "util.KeyVal",
                args: dict({
                  itemID: 55,
                  invItem: {
                    type: "packedrow",
                    fields: {
                      itemID: 55,
                      typeID: 66,
                      ownerID: 141100100,
                      locationID: 3,
                      flagID: 27,
                    },
                  },
                  activeEffects: {
                    type: "dict",
                    entries: [
                      [16, [55, 141100100, 3, null, null, [], 16, lng, -1, 1]],
                      ...(moduleActive
                        ? [[67, [55, 141100100, 3, 90 + index, null, [], 67, lng, 1000, 1]]]
                        : []),
                    ],
                  },
                  time: lng,
                  wallclockTime: lng,
                }),
              },
            };
          } else if (q.method === "Deactivate") {
            writes.push(`module-stop:${index}`);
            moduleActive = false;
            body = { ok: true, result: null };
          } else if (q.method === "LaunchDrones") {
            writes.push(`launch:${index}`);
            drone = true;
            body = { ok: true, result: { type: "dict", entries: [[7, list(8)]] } };
          } else if (q.method === "CmdReturnBay") {
            writes.push(`recall:${index}`);
            returned = true;
            drone = false;
            droneTarget = null;
            settles++;
            body = { ok: true, result: { type: "dict", entries: [] } };
          } else if (q.method === "CmdEngage") {
            assert.equal(q.args[1], 90 + index);
            writes.push(`engage:${index}`);
            engages++;
            droneTarget = q.args[1];
            done = true;
            moduleActive = true;
            body = { ok: true, result: { type: "dict", entries: [] } };
          } else body = { ok: false, error: "reward unavailable" };
        } else throw Error(`unexpected ${p}`);
        return Response.json(body);
      },
    };
    const session = {
      store: { live: createSignal({ questions: [] }), fitting: { get: () => ({}) } },
      flow: {
        flying: {
          sessionGeneration: () => 1,
          isSessionClosing: () => false,
          abortAutopilot: () => {},
          autopilotProgress: () => null,
          readFit: async () => true,
          resolveDroneControlRange: async () => 45000,
          classifyDroneRoles: async () => ({
            bay: { combat: drone ? [] : [7] },
            out: { combat: drone ? [8] : [] },
          }),
          launchedThenRead: async () => {
            drone = true;
          },
          engageDronesConfirmed: async (_ids: unknown, target: number) => {
            assert.equal(target, 90 + index);
            engages++;
            done = true;
            moduleActive = true;
          },
        },
        abortRoute: () => {},
        prepareHostedBotStop: async () => {
          settles++;
          if (drone) returned = true;
          drone = false;
          droneTarget = null;
        },
        setLivePush: () => {},
        undock: async () => {
          docked = false;
        },
        warpToMissionBookmark: async () => {
          landed = true;
        },
        startRoute: async () => {
          docked = true;
          landed = false;
          return { started: true };
        },
      },
    } as unknown as PilotSession;
    const backend = createNativeSecurityRun({
      attach: async () => session,
      document: () => storage,
      telemetry: () => ({
        read: () => telemetryValue,
        write: (v) => {
          telemetryValue = structuredClone(v);
        },
      }),
      sleep: async () => {
        await new Promise((r) => setImmediate(r));
      },
    });
    assert.equal((await backend.check({ agentID: 4, missionCount: 2 })).ok, true);
    const handle = await backend.start(run as never);
    handleRef = handle;
    for (let n = 0; n < 500 && !completed; n++) await new Promise((r) => setImmediate(r));
    assert.equal(
      completed,
      true,
      `phase ${row?.active?.phase} pending ${row?.active?.pending?.kind}`,
    );
    await handle.stop();
    await stopRace;
    await deliveries;
    assert.equal(record.status, "stopped");
    assert.equal(record.readout.completedCount, 2);
    assert.deepEqual(record.readout.latestReceipt, {
      commandID: row.active.completed[1].commandID,
      missionKey: row.active.completed[1].identity.acceptedKey,
    });
    assert.equal("completions" in record.readout, false);
    assert.ok(Buffer.byteLength(JSON.stringify(record.readout)) <= 16384);
    assert.ok(Buffer.byteLength(JSON.stringify(telemetryValue)) > 16384);
    assert.deepEqual(writes, [
      "launch:0",
      "engage:0",
      "recall:0",
      "module-stop:0",
      "complete:0",
      "request:1",
      "accept:1",
      "launch:1",
      "engage:1",
      "recall:1",
      "module-stop:1",
      "complete:1",
    ]);
    assert.equal(engages, 2);
    assert.ok(settles >= 2);
    assert.equal(row.history[0].runID, "old-security");
    assert.equal(row.history[0].identity.acceptedKey, key);
    assert.ok(telemetryValue.events.some((e: any) => e.kind === "launch-response"));
    assert.ok(
      telemetryValue.events.some(
        (e: any) => e.kind === "engage-response" && e.data.result.type === "dict",
      ),
    );
    const sample = telemetryValue.events.find((e: any) => e.kind === "engage-observation");
    assert.equal(sample.data.drones[0].ownerID, 141100100);
    assert.equal(sample.data.drones[0].controllerID, 3);
    assert.equal(sample.data.drones[0].targetID, sample.data.target);
    assert.ok(sample.data.scope.acceptedKey);
    const receipts = row.active.completed;
    assert.equal(receipts.length, 2);
    assert.notEqual(receipts[0].identity.acceptedKey, receipts[1].identity.acceptedKey);
    assert.equal(receipts[0].isk, null);
    assert.equal(receipts[1].isk, null);
  });

test("host rejects a different accepted mission key before issuing work", async () => {
  const key = JSON.stringify([4, 2504, 70, "1000"]),
    offer = {
      agentID: 4,
      missionID: 2504,
      titleID: 70,
      expirationTime: "1000",
      key,
      status: "offered",
      contentID: 2504,
      dungeonID: 875,
      dungeonCount: 1,
      otherObjectives: 0,
      shipRestricted: false,
      destinationSystemID: 6,
      locationNumber: 0,
      expectedISK: 100,
    };
  let row: any = {
      version: 1,
      revision: 3,
      runID: "old-security",
      accountID: "test20",
      characterID: 141100100,
      shipID: 3,
      agentID: 4,
      agentStationID: 5,
      agentSystemID: 6,
      deadlineMs: 1,
      missionLimit: 2,
      phase: "COMBAT",
      reason: null,
      offer,
      identity: {
        agentID: 4,
        missionID: 2504,
        titleID: 70,
        acceptedKey: "wrong-key",
        contentID: 2504,
        dungeonID: 875,
        destinationSystemID: 6,
        locationNumber: 0,
        instanceID: 200,
        roomID: 0,
      },
      pending: null,
      before: null,
      completed: [],
    },
    index = 0,
    state: 0 | 1 | 2 = 2,
    docked = true,
    landed = false,
    done = false,
    drone = false,
    returned = false,
    droneTarget: number | null = null,
    moduleActive = false,
    engages = 0,
    settles = 0,
    completed = false;
  const writes: string[] = [];
  const ids = [2504, 2925],
    dungeons = [875, 1940],
    pos = () => index * 1000000 + 100,
    missionID = () => ids[index]!,
    dungeonID = () => dungeons[index]!;
  const response = (button: number | null, complete = false) =>
    tuple(
      tuple(tuple("Agent", null), list(...(button === null ? [] : [tuple(button, button)]))),
      dict({ missionCompleted: complete }),
    );
  const storage: SecurityStorage = {
    read: () => row,
    write: (v) => {
      row = structuredClone(v);
    },
  };
  const run = {
    botID: "security-two",
    characterID: 141100100,
    held: { characterID: 141100100, character: { characterID: 141100100 } },
    baseUrl: "http://held.test",
    setup: { agentID: 4, missionCount: 2 },
    resumed: false,
    report: (r: any) => {
      if (r.status === "stopped") completed = true;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(String(input)).pathname;
      let body: any = { ok: true };
      if (p === "/api/pilot-training/characters")
        body = { ok: true, account: "Test20", characters: [{ characterID: 141100100 }] };
      else if (p === "/api/bots")
        body = {
          ok: true,
          bots: [
            {
              botID: "security-two",
              characterID: 141100100,
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
            },
          ],
        };
      else if (p === "/api/bridge/flight/status")
        body = {
          ok: true,
          flight: {
            docked,
            inSpace: !docked,
            shipID: 3,
            stationID: docked ? 5 : null,
            solarSystemID: 6,
            shipMode: "STOP",
          },
        };
      else if (p === "/api/bridge/agents/4/record")
        body = {
          ok: true,
          agent: {
            agentID: 4,
            level: 1,
            divisionID: 24,
            agentTypeID: 2,
            stationID: 5,
            solarSystemID: 6,
          },
        };
      else if (p === "/api/bridge/agents/4/briefing")
        body = {
          ok: true,
          errors: { objective: null },
          objective: dict({
            contentID: missionID(),
            missionState: state,
            completionStatus: done ? 1 : 0,
            objectives: list(),
            normalRewards: list(tuple(29, 100, null)),
            dungeons: list(
              dict({
                dungeonID: dungeonID(),
                optional: false,
                location: dict({
                  solarsystemID: 6,
                  locationNumber: 0,
                  agentID: 4,
                  locationType: "dungeon",
                  coords: tuple(pos(), 2, 3),
                }),
                objectiveCompleted: done ? 1 : 0,
              }),
            ),
          }),
        };
      else if (p === "/api/bridge/space/snapshot")
        body = {
          ok: true,
          space: {
            inSpace: true,
            stateValid: true,
            shipID: 3,
            solarSystemID: 6,
            ship: {
              itemID: 3,
              position: { x: pos(), y: 2, z: 3 },
              radius: 10,
              hullRatio: 1,
              activeModuleIDs: [],
            },
            entities: [
              ...(done
                ? []
                : [
                    {
                      itemID: 70,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: 26727,
                      groupID: 319,
                      categoryID: 11,
                      position: { x: pos() + 20, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                    {
                      itemID: 90 + index,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: index === 0 ? 16087 : 16981,
                      groupID: index === 0 ? 818 : 615,
                      categoryID: 11,
                      position: { x: pos() + 100, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                    {
                      itemID: 9999,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: index === 0 ? 16087 : 16981,
                      groupID: index === 0 ? 818 : 615,
                      categoryID: 11,
                      position: { x: pos() + 57000, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                  ]),
              ...(drone
                ? [
                    {
                      itemID: 8,
                      kind: "drone",
                      ownerID: 141100100,
                      controllerID: 3,
                      targetEntityID: droneTarget,
                      position: { x: pos(), y: 2, z: 3 },
                      radius: 1,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                  ]
                : []),
            ],
          },
        };
      else if (p === "/api/bridge/drones")
        body = {
          ok: true,
          activeShipID: 3,
          bay: drone ? [] : [{ itemID: 7, typeID: 8, quantity: 1 }],
          inSpace: drone
            ? [
                {
                  itemID: 8,
                  controlled: true,
                  targetID: null,
                  shieldRatio: 1,
                  armorRatio: 1,
                  hullRatio: 1,
                },
              ]
            : [],
        };
      else if (p === "/api/bridge/call") {
        const q = JSON.parse(String(init?.body));
        if (q.method === "GetMyJournalDetails") {
          const entry = tuple(state, 0, 0, 70, 4, String(1000 + index), 0, 0, 0, missionID());
          body = {
            ok: true,
            result: tuple(
              list(...(state === 2 ? [entry] : [])),
              list(...(state === 1 ? [entry] : [])),
            ),
          };
        } else if (q.method === "DoAction") {
          const id = q.args[0];
          if (id === null)
            body = { ok: true, result: response(state === 0 ? 2 : state === 1 ? 3 : 6) };
          else if (id === 2) {
            writes.push(`request:${index}`);
            state = 1;
            body = { ok: true, result: response(3) };
          } else if (id === 3) {
            writes.push(`accept:${index}`);
            state = 2;
            body = { ok: true, result: response(6) };
          } else if (id === 6) {
            writes.push(`complete:${index}`);
            state = 0;
            body = { ok: true, result: response(null, true) };
            index++;
            done = false;
            landed = false;
            returned = false;
          } else throw Error(`button ${id}`);
        } else if (q.method === "GetCurrentDungeonForCharacter")
          body = { ok: true, result: landed ? tuple(dungeonID(), 0, 200 + index) : null };
        else if (q.method === "IsInActiveDungeonID") body = { ok: true, result: landed };
        else if (q.method === "InvalidateLocationCache") body = { ok: true, result: null };
        else if (q.method === "List")
          body = {
            ok: true,
            result: list(
              ...(q.args[0] === 87 && !drone
                ? [
                    {
                      type: "packedrow",
                      fields: {
                        itemID: returned ? 8 : 7,
                        typeID: 8,
                        ownerID: 141100100,
                        locationID: 3,
                        flagID: 87,
                        quantity: 1,
                        stacksize: 1,
                        categoryID: 18,
                      },
                    },
                  ]
                : q.args[0] === 27
                  ? [
                      {
                        type: "packedrow",
                        fields: {
                          itemID: 55,
                          typeID: 66,
                          ownerID: 141100100,
                          locationID: 3,
                          flagID: 27,
                          quantity: -1,
                          stacksize: 1,
                          categoryID: 7,
                        },
                      },
                    ]
                  : []),
            ),
          };
        else if (q.method === "ItemGetInfo") {
          const lng = { type: "long", value: "134385165369120001" };
          body = {
            ok: true,
            result: {
              type: "object",
              name: "util.KeyVal",
              args: dict({
                itemID: 55,
                invItem: {
                  type: "packedrow",
                  fields: { itemID: 55, typeID: 66, ownerID: 141100100, locationID: 3, flagID: 27 },
                },
                activeEffects: {
                  type: "dict",
                  entries: [
                    [16, [55, 141100100, 3, null, null, [], 16, lng, -1, 1]],
                    ...(moduleActive
                      ? [[67, [55, 141100100, 3, 90 + index, null, [], 67, lng, 1000, 1]]]
                      : []),
                  ],
                },
                time: lng,
                wallclockTime: lng,
              }),
            },
          };
        } else if (q.method === "Deactivate") {
          writes.push(`module-stop:${index}`);
          moduleActive = false;
          body = { ok: true, result: null };
        } else if (q.method === "LaunchDrones") {
          writes.push(`launch:${index}`);
          drone = true;
          body = { ok: true, result: { type: "dict", entries: [[7, list(8)]] } };
        } else if (q.method === "CmdReturnBay") {
          writes.push(`recall:${index}`);
          returned = true;
          drone = false;
          droneTarget = null;
          settles++;
          body = { ok: true, result: { type: "dict", entries: [] } };
        } else if (q.method === "CmdEngage") {
          assert.equal(q.args[1], 90 + index);
          writes.push(`engage:${index}`);
          engages++;
          droneTarget = q.args[1];
          done = true;
          moduleActive = true;
          body = { ok: true, result: { type: "dict", entries: [] } };
        } else body = { ok: false, error: "reward unavailable" };
      } else throw Error(`unexpected ${p}`);
      return Response.json(body);
    },
  };
  const session = {
    store: { live: createSignal({ questions: [] }), fitting: { get: () => ({}) } },
    flow: {
      flying: {
        sessionGeneration: () => 1,
        isSessionClosing: () => false,
        abortAutopilot: () => {},
        autopilotProgress: () => null,
        readFit: async () => true,
        resolveDroneControlRange: async () => 45000,
        classifyDroneRoles: async () => ({
          bay: { combat: drone ? [] : [7] },
          out: { combat: drone ? [8] : [] },
        }),
        launchedThenRead: async () => {
          drone = true;
        },
        engageDronesConfirmed: async (_ids: unknown, target: number) => {
          assert.equal(target, 90 + index);
          engages++;
          done = true;
          moduleActive = true;
        },
      },
      abortRoute: () => {},
      prepareHostedBotStop: async () => {
        settles++;
        if (drone) returned = true;
        drone = false;
        droneTarget = null;
      },
      setLivePush: () => {},
      undock: async () => {
        docked = false;
      },
      warpToMissionBookmark: async () => {
        landed = true;
      },
      startRoute: async () => {
        docked = true;
        landed = false;
        return { started: true };
      },
    },
  } as unknown as PilotSession;
  const backend = createNativeSecurityRun({
    attach: async () => session,
    document: () => storage,
    sleep: async () => {
      await new Promise((r) => setImmediate(r));
    },
  });
  await assert.rejects(
    Promise.resolve(backend.start(run as never)),
    /does not match native custody/,
  );
  assert.deepEqual(writes, []);
  assert.equal(row.runID, "old-security");
});

test("host retires an all-drone native refusal only after fresh exact target absence", async () => {
  let telemetryValue: any = null,
    absentFirst = false,
    sceneTick = 0;
  let row: any = null,
    index = 0,
    state: 0 | 1 | 2 = 0,
    docked = true,
    landed = false,
    done = false,
    drone = false,
    returned = false,
    droneTarget: number | null = null,
    moduleActive = false,
    engages = 0,
    settles = 0,
    completed = false;
  const writes: string[] = [];
  const ids = [2504, 2925],
    dungeons = [875, 1940],
    pos = () => index * 1000000 + 100,
    missionID = () => ids[index]!,
    dungeonID = () => dungeons[index]!;
  const response = (button: number | null, complete = false) =>
    tuple(
      tuple(tuple("Agent", null), list(...(button === null ? [] : [tuple(button, button)]))),
      dict({ missionCompleted: complete }),
    );
  const storage: SecurityStorage = {
    read: () => row,
    write: (v) => {
      row = structuredClone(v);
    },
  };
  const run = {
    botID: "security-two",
    characterID: 141100100,
    held: { characterID: 141100100, character: { characterID: 141100100 } },
    baseUrl: "http://held.test",
    setup: { agentID: 4, missionCount: 2 },
    resumed: false,
    report: (r: any) => {
      if (r.status === "stopped") completed = true;
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(String(input)).pathname;
      let body: any = { ok: true };
      if (p === "/api/pilot-training/characters")
        body = { ok: true, account: "Test20", characters: [{ characterID: 141100100 }] };
      else if (p === "/api/bots")
        body = {
          ok: true,
          bots: [
            {
              botID: "security-two",
              characterID: 141100100,
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
            },
          ],
        };
      else if (p === "/api/bridge/flight/status")
        body = {
          ok: true,
          flight: {
            docked,
            inSpace: !docked,
            shipID: 3,
            stationID: docked ? 5 : null,
            solarSystemID: 6,
            shipMode: "STOP",
          },
        };
      else if (p === "/api/bridge/agents/4/record")
        body = {
          ok: true,
          agent: {
            agentID: 4,
            level: 1,
            divisionID: 24,
            agentTypeID: 2,
            stationID: 5,
            solarSystemID: 6,
          },
        };
      else if (p === "/api/bridge/agents/4/briefing")
        body = {
          ok: true,
          errors: { objective: null },
          objective: dict({
            contentID: missionID(),
            missionState: state,
            completionStatus: done ? 1 : 0,
            objectives: list(),
            normalRewards: list(tuple(29, 100, null)),
            dungeons: list(
              dict({
                dungeonID: dungeonID(),
                optional: false,
                location: dict({
                  solarsystemID: 6,
                  locationNumber: 0,
                  agentID: 4,
                  locationType: "dungeon",
                  coords: tuple(pos(), 2, 3),
                }),
                objectiveCompleted: done ? 1 : 0,
              }),
            ),
          }),
        };
      else if (p === "/api/bridge/space/snapshot")
        body = {
          ok: true,
          space: {
            inSpace: true,
            stateValid: true,
            sampledAtMs: ++sceneTick,
            shipID: 3,
            solarSystemID: 6,
            ship: {
              itemID: 3,
              position: { x: pos(), y: 2, z: 3 },
              radius: 10,
              hullRatio: 1,
              activeModuleIDs: [],
            },
            entities: [
              ...(done
                ? []
                : [
                    {
                      itemID: 70,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: 26727,
                      groupID: 319,
                      categoryID: 11,
                      position: { x: pos() + 20, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                    {
                      itemID: 90 + index,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: index === 0 ? 16087 : 16981,
                      groupID: index === 0 ? 818 : 615,
                      categoryID: 11,
                      position: { x: pos() + 100, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                    {
                      itemID: 9999,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: index === 0 ? 16087 : 16981,
                      groupID: index === 0 ? 818 : 615,
                      categoryID: 11,
                      position: { x: pos() + 57000, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                  ].filter((e) => !(absentFirst && index === 0 && e.itemID === 90))),
              ...(drone
                ? [
                    {
                      itemID: 8,
                      kind: "drone",
                      ownerID: 141100100,
                      controllerID: 3,
                      targetEntityID: droneTarget,
                      position: { x: pos(), y: 2, z: 3 },
                      radius: 1,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                  ]
                : []),
            ],
          },
        };
      else if (p === "/api/bridge/drones")
        body = {
          ok: true,
          activeShipID: 3,
          bay: drone ? [] : [{ itemID: 7, typeID: 8, quantity: 1 }],
          inSpace: drone
            ? [
                {
                  itemID: 8,
                  controlled: true,
                  targetID: null,
                  shieldRatio: 1,
                  armorRatio: 1,
                  hullRatio: 1,
                },
              ]
            : [],
        };
      else if (p === "/api/bridge/call") {
        const q = JSON.parse(String(init?.body));
        if (q.method === "GetMyJournalDetails") {
          const entry = tuple(state, 0, 0, 70, 4, String(1000 + index), 0, 0, 0, missionID());
          body = {
            ok: true,
            result: tuple(
              list(...(state === 2 ? [entry] : [])),
              list(...(state === 1 ? [entry] : [])),
            ),
          };
        } else if (q.method === "DoAction") {
          const id = q.args[0];
          if (id === null)
            body = { ok: true, result: response(state === 0 ? 2 : state === 1 ? 3 : 6) };
          else if (id === 2) {
            writes.push(`request:${index}`);
            state = 1;
            body = { ok: true, result: response(3) };
          } else if (id === 3) {
            writes.push(`accept:${index}`);
            state = 2;
            body = { ok: true, result: response(6) };
          } else if (id === 6) {
            writes.push(`complete:${index}`);
            state = 0;
            body = { ok: true, result: response(null, true) };
            index++;
            done = false;
            landed = false;
            returned = false;
          } else throw Error(`button ${id}`);
        } else if (q.method === "GetCurrentDungeonForCharacter")
          body = { ok: true, result: landed ? tuple(dungeonID(), 0, 200 + index) : null };
        else if (q.method === "IsInActiveDungeonID") body = { ok: true, result: landed };
        else if (q.method === "InvalidateLocationCache") body = { ok: true, result: null };
        else if (q.method === "List")
          body = {
            ok: true,
            result: list(
              ...(q.args[0] === 87 && !drone
                ? [
                    {
                      type: "packedrow",
                      fields: {
                        itemID: returned ? 8 : 7,
                        typeID: 8,
                        ownerID: 141100100,
                        locationID: 3,
                        flagID: 87,
                        quantity: 1,
                        stacksize: 1,
                        categoryID: 18,
                      },
                    },
                  ]
                : q.args[0] === 27
                  ? [
                      {
                        type: "packedrow",
                        fields: {
                          itemID: 55,
                          typeID: 66,
                          ownerID: 141100100,
                          locationID: 3,
                          flagID: 27,
                          quantity: -1,
                          stacksize: 1,
                          categoryID: 7,
                        },
                      },
                    ]
                  : []),
            ),
          };
        else if (q.method === "ItemGetInfo") {
          const lng = { type: "long", value: "134385165369120001" };
          body = {
            ok: true,
            result: {
              type: "object",
              name: "util.KeyVal",
              args: dict({
                itemID: 55,
                invItem: {
                  type: "packedrow",
                  fields: { itemID: 55, typeID: 66, ownerID: 141100100, locationID: 3, flagID: 27 },
                },
                activeEffects: {
                  type: "dict",
                  entries: [
                    [16, [55, 141100100, 3, null, null, [], 16, lng, -1, 1]],
                    ...(moduleActive
                      ? [[67, [55, 141100100, 3, 90 + index, null, [], 67, lng, 1000, 1]]]
                      : []),
                  ],
                },
                time: lng,
                wallclockTime: lng,
              }),
            },
          };
        } else if (q.method === "Deactivate") {
          writes.push(`module-stop:${index}`);
          moduleActive = false;
          body = { ok: true, result: null };
        } else if (q.method === "LaunchDrones") {
          writes.push(`launch:${index}`);
          drone = true;
          body = { ok: true, result: { type: "dict", entries: [[7, list(8)]] } };
        } else if (q.method === "CmdReturnBay") {
          writes.push(`recall:${index}`);
          returned = true;
          drone = false;
          droneTarget = null;
          settles++;
          body = { ok: true, result: { type: "dict", entries: [] } };
        } else if (q.method === "CmdEngage") {
          assert.equal(q.args[1], index === 0 && absentFirst ? 9999 : 90 + index);
          writes.push(`engage:${index}:${q.args[1]}`);
          engages++;
          if (index === 0 && !absentFirst) {
            absentFirst = true;
            droneTarget = null;
            body = {
              ok: true,
              result: {
                type: "dict",
                entries: [
                  [
                    8,
                    [
                      "CustomNotify",
                      {
                        type: "dict",
                        entries: [["notify", "That target cannot be engaged by drones."]],
                      },
                    ],
                  ],
                ],
              },
            };
          } else {
            droneTarget = q.args[1];
            done = true;
            moduleActive = true;
            body = { ok: true, result: { type: "dict", entries: [] } };
          }
        } else body = { ok: false, error: "reward unavailable" };
      } else throw Error(`unexpected ${p}`);
      return Response.json(body);
    },
  };
  const session = {
    store: { live: createSignal({ questions: [] }), fitting: { get: () => ({}) } },
    flow: {
      flying: {
        sessionGeneration: () => 1,
        isSessionClosing: () => false,
        abortAutopilot: () => {},
        autopilotProgress: () => null,
        readFit: async () => true,
        resolveDroneControlRange: async () => 100000,
        classifyDroneRoles: async () => ({
          bay: { combat: drone ? [] : [7] },
          out: { combat: drone ? [8] : [] },
        }),
        launchedThenRead: async () => {
          drone = true;
        },
        engageDronesConfirmed: async (_ids: unknown, target: number) => {
          assert.equal(target, 90 + index);
          engages++;
          done = true;
          moduleActive = true;
        },
      },
      abortRoute: () => {},
      prepareHostedBotStop: async () => {
        settles++;
        if (drone) returned = true;
        drone = false;
        droneTarget = null;
      },
      setLivePush: () => {},
      undock: async () => {
        docked = false;
      },
      warpToMissionBookmark: async () => {
        landed = true;
      },
      startRoute: async () => {
        docked = true;
        landed = false;
        return { started: true };
      },
    },
  } as unknown as PilotSession;
  const backend = createNativeSecurityRun({
    attach: async () => session,
    document: () => storage,
    telemetry: () => ({
      read: () => telemetryValue,
      write: (v) => {
        telemetryValue = structuredClone(v);
      },
    }),
    sleep: async () => {
      await new Promise((r) => setImmediate(r));
    },
  });
  assert.equal((await backend.check({ agentID: 4, missionCount: 2 })).ok, true);
  const handle = await backend.start(run as never);
  for (let n = 0; n < 500 && !completed; n++) await new Promise((r) => setImmediate(r));
  assert.equal(
    completed,
    true,
    `phase ${row?.active?.phase} pending ${row?.active?.pending?.kind}`,
  );
  await handle.stop();
  assert.deepEqual(writes, [
    "request:0",
    "accept:0",
    "launch:0",
    "engage:0:90",
    "engage:0:9999",
    "recall:0",
    "module-stop:0",
    "complete:0",
    "request:1",
    "accept:1",
    "launch:1",
    "engage:1:91",
    "recall:1",
    "module-stop:1",
    "complete:1",
  ]);
  assert.equal(engages, 3);
  assert.ok(
    telemetryValue.events.some(
      (e: any) => e.kind === "engage-target-absent" && e.data.target === 90,
    ),
  );
  assert.ok(settles >= 2);
  const receipts = row.active.completed;
  assert.equal(receipts.length, 2);
  assert.notEqual(receipts[0].identity.acceptedKey, receipts[1].identity.acceptedKey);
  assert.equal(receipts[0].isk, null);
  assert.equal(receipts[1].isk, null);
});

test("fleet owner waits for every held peer and native fleet before requesting a mission", async () => {
  let row: any = null,
    writes = 0,
    release: () => void = () => {},
    reached: () => void = () => {};
  const waiting = new Promise<void>((r) => {
    reached = r;
  });
  const reports: any[] = [];
  const storage: SecurityStorage = {
    read: () => row,
    write: (v) => {
      row = structuredClone(v);
    },
  };
  const run = {
    botID: "fleet-owner",
    characterID: 1,
    held: { characterID: 1, character: { characterID: 1 } },
    baseUrl: "http://held.test",
    setup: { agentID: 4, missionCount: 1 },
    resumed: false,
    report: (v: any) => reports.push(v),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(String(input)).pathname;
      let b: any = { ok: true };
      if (p === "/api/pilot-training/characters")
        b = { ok: true, account: "one", characters: [{ characterID: 1 }] };
      else if (p === "/api/bots")
        b = {
          ok: true,
          bots: [
            {
              botID: "fleet-owner",
              characterID: 1,
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
            },
          ],
        };
      else if (p === "/api/bridge/flight/status")
        b = {
          ok: true,
          flight: { docked: true, inSpace: false, shipID: 3, stationID: 5, solarSystemID: 6 },
        };
      else if (p === "/api/bridge/agents/4/record")
        b = {
          ok: true,
          agent: {
            agentID: 4,
            level: 1,
            divisionID: 24,
            agentTypeID: 2,
            stationID: 5,
            solarSystemID: 6,
          },
        };
      else if (p === "/api/bridge/call") {
        const q = JSON.parse(String(init?.body));
        if (q.method === "GetCurrentDungeonForCharacter") b = { ok: true, result: null };
        else if (q.method === "IsInActiveDungeonID") b = { ok: true, result: false };
        else if (q.method === "InvalidateLocationCache") b = { ok: true, result: null };
        else if (q.method === "DoAction") {
          writes++;
          b = { ok: true, result: answer() };
        } else throw Error(q.method);
      } else throw Error(p);
      return Response.json(b);
    },
  };
  const session = {
    store: { station: { get: () => ({ online: { characterID: 1 } }) } },
    flow: {
      flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
      abortRoute: () => {},
      prepareHostedBotStop: async () => {},
      setLivePush: () => {},
    },
  } as unknown as PilotSession;
  let registered = false,
    stopped = false;
  const fleet = {
    register() {
      registered = true;
    },
    async ready() {
      return false;
    },
    publish() {
      throw Error("unexpected combat");
    },
    everyoneArrived: () => false,
    selectTarget: () => null,
    assertTarget() {},
    async settle() {},
    stop() {
      stopped = true;
    },
    finished() {},
    diagnostic() {},
  };
  const backend = createNativeSecurityRun({
    attach: async () => session,
    document: () => storage,
    fleet,
    sleep: async () => {
      reached();
      await new Promise<void>((r) => {
        release = r;
      });
    },
  });
  const h = await backend.start(run as never);
  await waiting;
  assert.equal(registered, true);
  assert.equal(writes, 0);
  const stop = h.stop();
  release();
  await stop;
  assert.equal(stopped, true);
  assert.equal(writes, 0);
  assert.ok(reports.some((r) => r.status === "stopped"));
});

test("Security setup preserves an explicitly selected parking destination and legacy nearest default", async () => {
  const backend = createNativeSecurityRun(),
    parking = { mode: "selected", kind: "station", destinationID: 600, systemID: 300 },
    manual = { agentID: 4, missionCount: 2 },
    auto = { agent: { mode: "auto", maxJumps: 10, corporationID: null }, missionCount: 2, parking };
  assert.deepEqual(((await backend.check(manual)) as any).setup, manual);
  assert.deepEqual(((await backend.check(auto)) as any).setup, auto);
  assert.equal((await backend.check({ ...auto, parking: { ...parking, systemID: 0 } })).ok, false);
  assert.equal(
    (await backend.check({ ...manual, agent: { mode: "auto", maxJumps: 1, corporationID: null } }))
      .ok,
    false,
  );
});

test("host auto-selects verified nearest Security agent before first request", async () => {
  let row: any = null,
    release: () => void = () => {},
    reached: () => void = () => {},
    requests = 0;
  const paused = new Promise<void>((r) => {
      reached = r;
    }),
    responses: string[] = [];
  const agents = [
    {
      agentID: 5,
      name: "Far",
      level: 1,
      missionKind: "encounter",
      stationID: 5,
      solarSystemID: 6,
      corporationID: 44,
      jumps: 2,
    },
    {
      agentID: 4,
      name: "Near",
      level: 1,
      missionKind: "encounter",
      stationID: 5,
      solarSystemID: 6,
      corporationID: 44,
      jumps: 1,
    },
  ];
  const run = {
    botID: "auto",
    characterID: 1,
    held: { characterID: 1, character: { characterID: 1 } },
    baseUrl: "http://held.test",
    setup: { agent: { mode: "auto", maxJumps: 4, corporationID: 44 }, missionCount: 1 },
    resumed: false,
    report() {},
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const p = new URL(String(input)).pathname;
      let body: any;
      if (p === "/api/pilot-training/characters")
        body = { account: "Test1", characters: [{ characterID: 1 }] };
      else if (p === "/api/bots")
        body = {
          bots: [
            {
              botID: "auto",
              characterID: 1,
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
            },
          ],
        };
      else if (p === "/api/bridge/flight/status")
        body = {
          flight: { docked: true, inSpace: false, shipID: 11, stationID: 5, solarSystemID: 6 },
        };
      else if (p === "/api/bridge/agents/4/record")
        body = {
          agent: {
            agentID: 4,
            level: 1,
            divisionID: 24,
            agentTypeID: 2,
            stationID: 5,
            solarSystemID: 6,
            corporationID: 44,
          },
        };
      else if (p === "/api/bridge/call") {
        const q = JSON.parse(String(init?.body));
        responses.push(`${q.method}:${q.of ?? ""}`);
        if (q.method === "GetMyJournalDetails") body = { result: tuple(list(), list()) };
        else if (q.method === "DoAction") {
          if (q.args[0] === 11) requests++;
          body = { result: answer() };
        } else if (q.method === "GetCurrentDungeonForCharacter") body = { result: null };
        else if (q.method === "IsInActiveDungeonID") body = { result: false };
        else if (q.method === "InvalidateLocationCache") body = { result: null };
        else throw Error(q.method);
      } else throw Error(p);
      return Response.json({ ok: true, ...body });
    },
  } as any;
  const session = {
    store: {
      finder: { get: () => ({ loaded: true, error: null, capped: false, total: 2, agents }) },
    },
    flow: {
      findAgents: async (x: any) =>
        assert.deepEqual(x, { kind: "encounter", level: 1, limit: 5000 }),
      flying: {
        sessionGeneration: () => 1,
        isSessionClosing: () => false,
        abortAutopilot: () => {},
        autopilotProgress: () => null,
      },
      abortRoute() {},
      setLivePush() {},
    },
  } as any;
  const handle = await createNativeSecurityRun({
    attach: async () => session,
    document: () => ({ read: () => row, write: (v) => (row = structuredClone(v)) }),
    sleep: async () => {
      reached();
      await new Promise<void>((r) => (release = r));
    },
  }).start(run);
  await paused;
  assert.equal(row.active.agentID, 4);
  assert.equal(requests, 1);
  assert.ok(responses.some((x) => x === "DoAction:4"));
  const stop = Promise.resolve(handle.stop());
  release();
  await assert.rejects(stop, /unresolved/);
  assert.equal(requests, 1);
});
