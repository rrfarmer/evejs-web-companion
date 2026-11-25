import test from "node:test";
import assert from "node:assert/strict";
import { createFleetSecurityRuns } from "./fleetHost.ts";
import { createFleetSecurityProgressRoute } from "./fleetTelemetry.ts";
import { createRequire } from "node:module";
import { createCombatStore } from "../operations/combatStore.ts";
import { runControlRoutes } from "../runControl.ts";
import { createSignal } from "../../../web/src/store/signals.ts";
import type { ClientQuestion, QuestionAnswer } from "../../../web/src/store/types.ts";
const list = (...items: unknown[]) => ({ type: "list", items }),
  tuple = (...items: unknown[]) => ({ type: "tuple", items }),
  dict = (v: Record<string, unknown>) => ({ type: "dict", entries: Object.entries(v) }),
  kv = (entries: unknown[]) => ({
    type: "object",
    name: "util.KeyVal",
    args: { type: "dict", entries },
  });
test("two hosted pilots verify exact existing native fleet and only owner may request", async () => {
  const docs = new Map<string, unknown>();
  let ownerDoc: unknown = null,
    requests = 0,
    assistantAgentCalls = 0;
  const reports: any[] = [];
  const setup = {
    operationID: "op",
    operationRunID: "run",
    missionOwnerID: 1,
    agentID: 4,
    missionCount: 1,
    members: [
      { characterID: 1, shipID: 11 },
      { characterID: 2, shipID: 12 },
    ],
  };
  const factory = createFleetSecurityRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => {
        docs.set(name, structuredClone(v));
      },
    }),
    ownerDocument: () => ({
      read: () => ownerDoc,
      write: (v) => {
        ownerDoc = structuredClone(v);
      },
    }),
    sleep: () => new Promise((r) => setTimeout(r, 3)),
    attach: async (run) =>
      ({
        store: {
          station: { get: () => ({ online: { characterID: run.held.characterID } }) },
          fleet: { get: () => ({ pendingInvite: null }) },
        },
        flow: {
          requestOptions: () => ({}),
          abortRoute() {},
          setLivePush() {},
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            bridgeDo: async () => {
              throw Error("unexpected fleet mutation");
            },
          },
        },
      }) as any,
  });
  const fetchFor =
    (id: number): typeof fetch =>
    async (input, init) => {
      const p = new URL(String(input)).pathname;
      let body: any;
      if (p === "/api/pilot-training/characters")
        body = { account: `p${id}`, characters: [{ characterID: id }] };
      else if (p === "/api/bots")
        body = {
          bots: [
            {
              botID: `b${id}`,
              characterID: id,
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
            },
          ],
        };
      else if (p === "/api/bridge/flight/status")
        body = {
          flight: { docked: true, inSpace: false, shipID: id + 10, stationID: 5, solarSystemID: 6 },
        };
      else if (p === "/api/bridge/bound-fleet")
        body = {
          fleetID: 90,
          reads: {
            GetInitState: {
              result: kv([
                ["fleetID", 90],
                ["members", { type: "dict", entries: [1, 2].map((i) => [i, kv([["charID", i]])]) }],
              ]),
            },
          },
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
          },
        };
      else if (p === "/api/bridge/call") {
        const q = JSON.parse(String(init?.body));
        if (q.service === "agentMgr" && id === 2) assistantAgentCalls++;
        if (q.method === "GetCurrentDungeonForCharacter") body = { result: null };
        else if (q.method === "IsInActiveDungeonID") body = { result: false };
        else if (q.method === "InvalidateLocationCache") body = { result: null };
        else if (q.method === "GetMyJournalDetails") body = { result: tuple(list(), list()) };
        else if (q.method === "DoAction") {
          if (q.args[0] === 11) requests++;
          body = {
            result: tuple(
              tuple(tuple("Agent", null), list(tuple(11, 2))),
              dict({ missionCompleted: false }),
            ),
          };
        } else throw Error(q.method);
      } else throw Error(p);
      return Response.json({ ok: true, ...body });
    };
  const run = (id: number) =>
    ({
      botID: `b${id}`,
      characterID: id,
      held: { characterID: id, character: { characterID: id } },
      setup,
      baseUrl: "http://bff",
      resumed: false,
      fetch: fetchFor(id),
      report: (r: any) => reports.push({ id, ...r }),
    }) as any;
  const a = await factory.owner.start(run(1));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(requests, 0);
  const b = await factory.assistant.start(run(2));
  for (let i = 0; i < 100 && requests === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(requests, 1, JSON.stringify(reports));
  assert.equal(assistantAgentCalls, 0);
  const stopping = Promise.allSettled([a.stop(), b.stop()]);
  await stopping;
  assert.equal(requests, 1);
  assert.equal(assistantAgentCalls, 0);
});

test("a new fleet epoch requires every prior actor to have parked, and archives terminal evidence", async () => {
  const docs = new Map<string, unknown>(),
    old = {
      operationID: "op",
      operationRunID: "old",
      missionOwnerID: 1,
      agentID: 4,
      missionCount: 1,
      members: [
        { characterID: 1, shipID: 11 },
        { characterID: 2, shipID: 12 },
      ],
    },
    fresh = { ...old, operationRunID: "new" },
    store = (name: string) => ({
      read: () => docs.get(name) ?? null,
      write: (v: unknown) => {
        docs.set(name, structuredClone(v));
      },
    });
  const key = "fleet-security-index:op";
  const factory = createFleetSecurityRuns({ document: store });
  const run = {
    botID: "b1",
    characterID: 1,
    held: { characterID: 1, character: { characterID: 1 } },
    setup: fresh,
    baseUrl: "http://bff",
    resumed: false,
    fetch: async () => {
      throw Error("intentional preflight stop");
    },
    report() {},
  } as any;
  docs.set(key, {
    runID: "old",
    signature: JSON.stringify(old),
    memberIDs: [1, 2],
    finished: [1],
    terminal: false,
  });
  await assert.rejects(async () => await factory.owner.start(run), /retains custody/);
  assert.equal((docs.get(key) as any).runID, "old");
  docs.set(key, {
    runID: "old",
    signature: JSON.stringify(old),
    memberIDs: [1, 2],
    finished: [1, 2],
    terminal: true,
  });
  await assert.rejects(async () => await factory.owner.start(run), /intentional preflight stop/);
  assert.equal((docs.get(key) as any).runID, "new");
  assert.deepEqual(
    (docs.get(`fleet-security-archive:${JSON.stringify(["op", "old"])}`) as any).finished,
    [1, 2],
  );
});

test("assistant rejects the wrong selected ship before fleet registration or action", async () => {
  let released = false,
    calls = 0;
  const setup = {
    operationID: "other",
    operationRunID: "run",
    missionOwnerID: 1,
    agentID: 4,
    missionCount: 1,
    members: [
      { characterID: 1, shipID: 11 },
      { characterID: 2, shipID: 12 },
    ],
  };
  const docs = new Map<string, unknown>();
  const factory = createFleetSecurityRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => {
        docs.set(name, v);
      },
    }),
    attach: async () =>
      ({
        store: { station: { get: () => ({ online: { characterID: 2 } }) } },
        flow: {
          setLivePush(v: boolean) {
            released = !v;
          },
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
        },
      }) as any,
  });
  const run = {
    botID: "b2",
    characterID: 2,
    held: { characterID: 2, character: { characterID: 2 } },
    setup,
    baseUrl: "http://bff",
    resumed: false,
    report() {},
    fetch: async (input: unknown) => {
      const p = new URL(String(input)).pathname;
      if (p === "/api/pilot-training/characters")
        return Response.json({ ok: true, account: "p2", characters: [{ characterID: 2 }] });
      if (p === "/api/bridge/flight/status")
        return Response.json({
          ok: true,
          flight: { docked: true, inSpace: false, shipID: 999, stationID: 5, solarSystemID: 6 },
        });
      calls++;
      throw Error(p);
    },
  } as any;
  await assert.rejects(async () => await factory.assistant.start(run), /ship changed/);
  assert.equal(calls, 0);
  assert.equal(released, true);
});

test("two hosted pilots enter one mission room and attack the owner-selected NPC", async () => {
  const docs = new Map<string, unknown>(),
    reports: any[] = [],
    writes: string[] = [];
  let journal: any = null,
    missionState = 0,
    done = false,
    assistantSceneReads = 0,
    disappeared = false;
  const dock = [false, true, true],
    land = [false, false, false],
    drone = [false, false, false],
    target = [0, 0, 0],
    returned = [false, false, false],
    engaged = new Set<number>();
  const live = createSignal<{ questions: ClientQuestion[] }>({ questions: [] });
  const rewardAnswers: QuestionAnswer[] = [];
  let answerReward: (answer: QuestionAnswer) => void = () => {};
  const label = (name: string) => ({
    label: "UI/Agents/StandardMission/" + name,
    parameters: null,
    text: null,
  });
  const setup = {
    operationID: "combat",
    operationRunID: "epoch",
    missionOwnerID: 1,
    agentID: 4,
    missionCount: 1,
    members: [
      { characterID: 1, shipID: 11 },
      { characterID: 2, shipID: 12 },
    ],
  };
  const factory = createFleetSecurityRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => {
        docs.set(name, structuredClone(v));
      },
    }),
    ownerDocument: () => ({
      read: () => journal,
      write: (v) => {
        journal = structuredClone(v);
      },
    }),
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    attach: async (run) => {
      const id = run.held.characterID,
        ship = id + 10;
      return {
        store: {
          live,
          station: { get: () => ({ online: { characterID: id } }) },
          fleet: { get: () => ({ pendingInvite: null }) },
          fitting: { get: () => ({}) },
        },
        flow: {
          answerQuestion: async (questionID: string, answer: QuestionAnswer) => {
            assert.equal(id, 1);
            assert.equal(questionID, "reward");
            rewardAnswers.push(answer);
            live.set({ questions: [] });
            answerReward(answer);
          },
          requestOptions: () => ({}),
          abortRoute() {},
          setLivePush() {},
          undock: async () => {
            dock[id] = false;
          },
          warpToMissionBookmark: async () => {
            land[id] = true;
          },
          startRoute: async () => {
            dock[id] = true;
            land[id] = false;
            return { started: true };
          },
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            readFlightNow: async () => ({ inSpace: !dock[id] }),
            readFit: async () => true,
            resolveDroneControlRange: async () => 45000,
            classifyDroneRoles: async () => ({
              bay: { combat: drone[id] ? [] : [id * 100 + 7] },
              out: { combat: drone[id] ? [id * 100 + 8] : [] },
            }),
            bridgeDo: async (_svc: string, method: string) => {
              if (method === "CmdWarpToStuff") {
                land[id] = true;
                return null;
              }
              throw Error(`unexpected ${method}`);
            },
          },
        },
      } as any;
    },
  });
  const fetchFor =
    (id: number): typeof fetch =>
    async (input, init) => {
      const p = new URL(String(input)).pathname,
        ship = id + 10;
      let body: any;
      if (p === "/api/pilot-training/characters")
        body = { account: `p${id}`, characters: [{ characterID: id }] };
      else if (p === "/api/bots")
        body = {
          bots: [
            {
              botID: `combat${id}`,
              characterID: id,
              expiresAt: new Date(Date.now() + 1800000).toISOString(),
            },
          ],
        };
      else if (p === "/api/bridge/flight/status")
        body = {
          flight: {
            docked: dock[id],
            inSpace: !dock[id],
            shipID: ship,
            stationID: dock[id] ? 5 : null,
            solarSystemID: 6,
            shipMode: "STOP",
          },
        };
      else if (p === "/api/bridge/bound-fleet")
        body = {
          fleetID: 90,
          reads: {
            GetInitState: {
              result: kv([
                ["fleetID", 90],
                ["members", { type: "dict", entries: [1, 2].map((i) => [i, kv([["charID", i]])]) }],
              ]),
            },
          },
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
          },
        };
      else if (p === "/api/bridge/agents/4/briefing")
        body = {
          errors: { objective: null },
          objective: dict({
            contentID: 2925,
            missionState,
            completionStatus: done ? 1 : 0,
            objectives: list(),
            normalRewards: list(tuple(29, 0, null)),
            dungeons: list(
              dict({
                dungeonID: 1940,
                optional: false,
                location: dict({
                  solarsystemID: 6,
                  locationNumber: 0,
                  agentID: 4,
                  locationType: "dungeon",
                  coords: tuple(100, 2, 3),
                }),
                objectiveCompleted: done ? 1 : 0,
              }),
            ),
          }),
        };
      else if (p === "/api/bridge/space/snapshot") {
        const hide = id === 2 && drone[2] && !engaged.has(2) && ++assistantSceneReads === 8;
        if (hide) disappeared = true;
        body = {
          space: {
            inSpace: true,
            stateValid: true,
            shipID: ship,
            solarSystemID: 6,
            sampledAtMs: Date.now() - 1634000,
            ship: { itemID: ship, position: { x: 100, y: 2, z: 3 }, radius: 10, hullRatio: 1 },
            entities: [
              ...(!done && !hide
                ? [
                    {
                      itemID: 90,
                      kind: "ship",
                      isNpc: true,
                      npcEntityType: "npc",
                      typeID: 16981,
                      groupID: 615,
                      categoryID: 11,
                      position: { x: 200, y: 2, z: 3 },
                      radius: 10,
                      shieldRatio: 1,
                      armorRatio: 1,
                      hullRatio: 1,
                    },
                  ]
                : []),
              ...(drone[id]
                ? [
                    {
                      itemID: id * 100 + 8,
                      kind: "drone",
                      ownerID: id,
                      controllerID: ship,
                      targetEntityID: target[id] || null,
                      position: { x: 100, y: 2, z: 3 },
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
      } else if (p === "/api/bridge/call") {
        const q = JSON.parse(String(init?.body));
        if (q.method === "GetCurrentDungeonForCharacter")
          body = { result: land[id] ? tuple(1940, 0, 200) : null };
        else if (q.method === "IsInActiveDungeonID") body = { result: land[id] };
        else if (q.method === "InvalidateLocationCache") body = { result: null };
        else if (q.method === "ItemGetInfo" && q.args[0] === ship)
          body = {
            result: kv([
              ["itemID", ship],
              [
                "invItem",
                {
                  type: "packedrow",
                  fields: { itemID: ship, ownerID: id, locationID: 6, flagID: 0 },
                },
              ],
              ["time", { type: "long", value: "134385676761330000" }],
              ["wallclockTime", { type: "long", value: "134385676761330001" }],
            ]),
          };
        else if (q.method === "GetMyJournalDetails") {
          assert.equal(id, 1);
          const entry = tuple(missionState, 0, 0, 70, 4, "1000", 0, 0, 0, 2925);
          body = {
            result: tuple(
              list(...(missionState === 2 ? [entry] : [])),
              list(...(missionState === 1 ? [entry] : [])),
            ),
          };
        } else if (q.method === "DoAction") {
          assert.equal(id, 1);
          const button = q.args[0];
          if (button === 2) {
            missionState = 1;
            writes.push("request");
          }
          if (button === 3) {
            missionState = 2;
            writes.push("accept");
          }
          if (button === 6) {
            const reply = new Promise<QuestionAnswer>((resolve) => {
              answerReward = resolve;
            });
            live.set({
              questions: [
                {
                  id: "reward",
                  kind: "choice",
                  service: "agents",
                  method: "SingleChoiceBox",
                  suppressID: "AgtShare",
                  agentID: 4,
                  contentID: 2925,
                  title: { label: null, parameters: null, text: "" },
                  body: label("CompleteShareWithFleetMessage"),
                  choices: [label("ShareWithFleetYes"), label("ShareWithFleetNo")],
                  askedAtMs: Date.now(),
                  expiresAtMs: Date.now() + 5000,
                  quantity: null,
                },
              ],
            });
            assert.deepEqual(await reply, { confirmed: true, index: 1 });
            missionState = 0;
            writes.push("complete");
          }
          const action = missionState === 0 ? 2 : missionState === 1 ? 3 : 6;
          body = {
            result: tuple(
              tuple(tuple("Agent", null), list(tuple(action, action))),
              dict({ missionCompleted: button === 6 }),
            ),
          };
        } else if (q.method === "List")
          body = {
            result: list(
              ...(q.args[0] === 87 && !drone[id]
                ? [
                    {
                      type: "packedrow",
                      fields: {
                        itemID: id * 100 + (returned[id] ? 8 : 7),
                        typeID: 8,
                        ownerID: id,
                        locationID: ship,
                        flagID: 87,
                        quantity: 1,
                        stacksize: 1,
                        categoryID: 18,
                      },
                    },
                  ]
                : []),
            ),
          };
        else if (q.method === "LaunchDrones") {
          drone[id] = true;
          writes.push(`launch:${id}`);
          body = { result: { type: "dict", entries: [[id * 100 + 7, list(id * 100 + 8)]] } };
        } else if (q.method === "CmdEngage") {
          assert.equal(q.args[1], 90);
          target[id] = 90;
          engaged.add(id);
          writes.push(`engage:${id}`);
          body = { result: { type: "dict", entries: [] } };
        } else if (q.method === "CmdReturnBay") {
          returned[id] = true;
          drone[id] = false;
          target[id] = 0;
          writes.push(`recall:${id}`);
          body = { result: { type: "dict", entries: [] } };
        } else body = { error: "reward unavailable", ok: false };
      } else throw Error(p);
      return Response.json({ ok: true, ...body });
    };
  const run = (id: number) =>
    ({
      botID: `combat${id}`,
      characterID: id,
      held: { characterID: id, character: { characterID: id } },
      setup,
      baseUrl: "http://bff",
      resumed: false,
      fetch: fetchFor(id),
      report: (r: any) => reports.push({ id, ...r }),
    }) as any;
  const first = await factory.owner.start(run(1)),
    second = await factory.assistant.start(run(2));
  for (let i = 0; i < 200 && engaged.size < 2; i++) await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(
    [...engaged].sort(),
    [1, 2],
    JSON.stringify({ writes, reports: reports.slice(-5), journal }),
  );
  assert.equal(disappeared, true);
  assert.deepEqual(
    writes.filter((x) => x.startsWith("engage:")),
    ["engage:1", "engage:2"],
  );
  const route = createFleetSecurityProgressRoute(() => ({
    read: (key) => structuredClone(docs.get(key) ?? null),
    close() {},
  }));
  const progress = async (id: number) =>
    (await route({
      params: { characterID: String(id) },
      query: { operationID: "combat", operationRunID: "epoch", botID: `combat${id}` },
      account: { username: `p${id}` },
    } as any)) as any;
  for (let i = 0; i < 200; i++) {
    const a = await progress(1),
      b = await progress(2);
    if (a.body.milestones?.["engage-confirmed"] && b.body.milestones?.["engage-confirmed"]) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  const own = await progress(1),
    help = await progress(2);
  assert.equal(own.body.milestones["native-fleet"].data.fleetID, 90);
  assert.equal(own.body.milestones["primary-selected"].data.targetID, 90);
  assert.equal(help.body.milestones["room-arrival"].data.instanceID, 200);
  assert.ok(help.body.events.some((e: any) => e.kind === "engage-not-dispatched"));
  assert.equal(help.body.milestones["engage-confirmed"].data.drones[0].targetID, 90);
  assert.equal(help.body.milestones["engage-confirmed"].data.drones[0].ownerID, 2);
  for (const actor of [own, help]) {
    assert.equal(actor.body.milestones["engage-confirmed"].data.npc.typeID, 16981);
    assert.equal(actor.body.milestones["engage-confirmed"].data.npc.groupID, 615);
  }
  assert.equal(
    own.body.milestones["engage-confirmed"].data.primaryTargetGeneration,
    help.body.milestones["engage-confirmed"].data.primaryTargetGeneration,
  );
  done = true;
  for (let i = 0; i < 200 && !writes.includes("complete"); i++)
    await new Promise((r) => setTimeout(r, 1));
  assert.deepEqual(rewardAnswers, [{ confirmed: true, index: 1 }]);
  assert.ok(writes.includes("complete"), JSON.stringify({ writes, reports: reports.slice(-5) }));
  assert.ok(writes.indexOf("recall:1") < writes.indexOf("complete"));
  assert.ok(writes.indexOf("recall:2") < writes.indexOf("complete"));
  for (let i = 0; i < 200; i++) {
    if ((await progress(1)).body.milestones?.["complete-confirmed"]) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  const receipt = await progress(1);
  assert.equal(receipt.body.milestones["complete-dispatch"].data.objectiveComplete, true);
  assert.equal(receipt.body.milestones["complete-dispatch"].data.dungeonComplete, true);
  assert.equal(receipt.body.milestones["complete-response"].data.completed, true);
  assert.equal(
    receipt.body.milestones["complete-confirmed"].data.commandID,
    receipt.body.milestones["complete-dispatch"].data.commandID,
  );
  await Promise.allSettled([first.stop(), second.stop()]);
});

test("Stop reconciles prior undock with fresh held flight and scene before parking", async () => {
  const docs = new Map<string, unknown>(),
    reports: any[] = [],
    now = Date.now(),
    setup = {
      operationID: "stop-reconcile",
      operationRunID: "epoch",
      missionOwnerID: 1,
      agentID: 4,
      missionCount: 1,
      members: [
        { characterID: 1, shipID: 11 },
        { characterID: 2, shipID: 12 },
      ],
    };
  const navIdentity = JSON.stringify([setup.operationID, setup.operationRunID, 2, 12]);
  docs.set(`fleet-security-nav:${navIdentity}`, {
    version: 1,
    identity: navIdentity,
    pending: { kind: "undock", at: now - 1000 },
  });
  let reads = 0,
    orders = 0,
    sceneReads = 0;
  const factory = createFleetSecurityRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => {
        docs.set(name, structuredClone(v));
      },
    }),
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    attach: async () =>
      ({
        store: {
          station: { get: () => ({ online: { characterID: 2 } }) },
          fleet: { get: () => ({ pendingInvite: null }) },
        },
        flow: {
          requestOptions: () => ({}),
          abortRoute() {},
          setLivePush() {},
          flying: {
            sessionGeneration: () => 1,
            isSessionClosing: () => false,
            bridgeDo: async () => {
              orders++;
            },
          },
        },
      }) as any,
  });
  const fetcher = async (input: unknown, init?: RequestInit) => {
    const p = new URL(String(input)).pathname;
    let body: any;
    if (p === "/api/pilot-training/characters")
      body = { account: "p2", characters: [{ characterID: 2 }] };
    else if (p === "/api/bridge/flight/status") {
      reads++;
      const docked = reads >= 12;
      body = {
        flight: {
          docked,
          inSpace: !docked,
          shipID: 12,
          stationID: docked ? 5 : null,
          solarSystemID: 300,
          shipMode: "STOP",
        },
      };
    } else if (p === "/api/bridge/space/snapshot") {
      if (++sceneReads === 1) throw Error("transient scene read");
      body = {
        space: {
          inSpace: true,
          stateValid: true,
          shipID: 12,
          solarSystemID: 300,
          sampledAtMs: Date.now() - 1634000,
          ship: { itemID: 12, position: { x: 0, y: 0, z: 0 }, radius: 10, hullRatio: 1 },
          entities: [],
        },
      };
    } else if (p === "/api/bridge/call") {
      const q = JSON.parse(String(init?.body));
      if (q.method === "InvalidateLocationCache") body = { result: null };
      else if (q.method === "ItemGetInfo")
        body = {
          result: kv([
            ["itemID", 12],
            [
              "invItem",
              { type: "packedrow", fields: { itemID: 12, ownerID: 2, locationID: 300, flagID: 0 } },
            ],
            ["time", { type: "long", value: "134385676761330000" }],
            ["wallclockTime", { type: "long", value: "134385676761330001" }],
          ]),
        };
      else if (q.method === "List") body = { result: list() };
      else throw Error(q.method);
    } else throw Error(p);
    return Response.json({ ok: true, ...body });
  };
  const run = {
    botID: "stop-actor",
    characterID: 2,
    held: { characterID: 2, character: { characterID: 2 } },
    setup,
    baseUrl: "http://bff",
    resumed: false,
    fetch: fetcher,
    report: (r: any) => reports.push(r),
  } as any;
  const handle = await factory.assistant.start(run);
  try {
    await handle.stop();
  } catch (error) {
    throw Error(`${String(error)} reports=${JSON.stringify(reports)} reads=${reads}`);
  }
  const journal = docs.get(`fleet-security-nav:${navIdentity}`) as any;
  assert.equal(journal.pending, null);
  assert.equal(journal.retired[0].intent.kind, "undock");
  assert.equal(journal.retired[0].outcome, "PHYSICALLY_OBSERVED");
  assert.equal(orders, 0);
  assert.ok(sceneReads >= 2);
  assert.ok(reports.some((r) => r.status === "stopped"));
});

test("assistant stop retries an aborted parking route on the same held session", async () => {
  const docs = new Map<string, unknown>(),
    reports: any[] = [],
    setup = {
      operationID: "park-retry",
      operationRunID: "epoch",
      missionOwnerID: 1,
      agentID: 4,
      missionCount: 1,
      members: [
        { characterID: 1, shipID: 11 },
        { characterID: 2, shipID: 12 },
      ],
    };
  let attempts = 0,
    aborts = 0;
  const factory = createFleetSecurityRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => {
        docs.set(name, structuredClone(v));
      },
    }),
    park: async () => {
      attempts++;
      if (attempts === 1) throw Error("Parking route stopped: aborted");
      return { destinationID: 5, kind: "station", systemID: 300 };
    },
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    attach: async () =>
      ({
        store: {
          station: { get: () => ({ online: { characterID: 2 } }) },
          fleet: { get: () => ({ pendingInvite: null }) },
        },
        flow: {
          requestOptions: () => ({}),
          abortRoute() {
            aborts++;
          },
          setLivePush() {},
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
        },
      }) as any,
  });
  const fetcher = async (input: unknown, init?: RequestInit) => {
    const p = new URL(String(input)).pathname;
    if (p === "/api/pilot-training/characters")
      return Response.json({
        ok: true,
        account: "park-retry-account",
        characters: [{ characterID: 2 }],
      });
    if (p === "/api/bridge/flight/status")
      return Response.json({
        ok: true,
        flight: { docked: true, inSpace: false, shipID: 12, stationID: 5, solarSystemID: 300 },
      });
    if (p === "/api/bridge/call") {
      const q = JSON.parse(String(init?.body));
      if (q.method === "InvalidateLocationCache") return Response.json({ ok: true, result: null });
      throw Error(q.method);
    }
    throw Error(p);
  };
  const handle = await factory.assistant.start({
    botID: "park-retry-actor",
    characterID: 2,
    held: { characterID: 2, character: { characterID: 2 } },
    setup,
    baseUrl: "http://bff",
    resumed: false,
    fetch: fetcher,
    report: (r: any) => reports.push(r),
  } as any);
  const response = (await runControlRoutes["POST /runs/:botID/stop"]({
    params: { botID: "park-retry-actor" },
    account: { username: "park-retry-account" },
  } as any)) as any;
  assert.equal(response.status, 202);
  for (let i = 0; i < 100 && !reports.some((r) => r.status === "stopped"); i++)
    await new Promise((r) => setTimeout(r, 1));
  await handle.stop();
  assert.equal(attempts, 2);
  assert.equal(aborts, 1);
  assert.ok(reports.some((r) => r.phase === "Assistant settlement blocked"));
  assert.ok(reports.some((r) => r.status === "stopped"));
});

test("an interrupted in-space parking attempt is retained without a second route", async () => {
  const docs = new Map<string, unknown>(),
    setup = {
      operationID: "park-unknown",
      operationRunID: "epoch",
      missionOwnerID: 1,
      agentID: 4,
      missionCount: 1,
      members: [
        { characterID: 1, shipID: 11 },
        { characterID: 2, shipID: 12 },
      ],
    };
  let attempts = 0,
    docked = true;
  const factory = createFleetSecurityRuns({
    document: (name) => ({
      read: () => docs.get(name) ?? null,
      write: (v) => docs.set(name, structuredClone(v)),
    }),
    park: async () => {
      attempts++;
      docked = false;
      throw Error("Parking route stopped: aborted");
    },
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    attach: async () =>
      ({
        store: {
          station: { get: () => ({ online: { characterID: 2 } }) },
          fleet: { get: () => ({ pendingInvite: null }) },
        },
        flow: {
          requestOptions: () => ({}),
          abortRoute() {},
          setLivePush() {},
          flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
        },
      }) as any,
  });
  const fetcher = async (input: unknown, init?: RequestInit) => {
    const p = new URL(String(input)).pathname;
    if (p === "/api/pilot-training/characters")
      return Response.json({
        ok: true,
        account: "park-unknown-account",
        characters: [{ characterID: 2 }],
      });
    if (p === "/api/bridge/flight/status")
      return Response.json({
        ok: true,
        flight: {
          docked,
          inSpace: !docked,
          shipID: 12,
          stationID: docked ? 5 : null,
          solarSystemID: 300,
          shipMode: "STOP",
        },
      });
    if (p === "/api/bridge/call") {
      const q = JSON.parse(String(init?.body));
      if (q.method === "InvalidateLocationCache") return Response.json({ ok: true, result: null });
      if (q.method === "List") return Response.json({ ok: true, result: list() });
      throw Error(q.method);
    }
    if (p === "/api/bridge/space/snapshot")
      return Response.json({
        ok: true,
        space: {
          inSpace: true,
          stateValid: true,
          shipID: 12,
          solarSystemID: 300,
          ship: { itemID: 12, position: { x: 0, y: 0, z: 0 }, radius: 1, hullRatio: 1 },
          entities: [],
        },
      });
    throw Error(p);
  };
  const handle = await factory.assistant.start({
    botID: "park-unknown-actor",
    characterID: 2,
    held: { characterID: 2, character: { characterID: 2 } },
    setup,
    baseUrl: "http://bff",
    resumed: false,
    fetch: fetcher,
    report() {},
  } as any);
  await assert.rejects(async () => await handle.stop(), /parking outcome is unresolved/i);
  assert.equal(attempts, 1);
});

test("saved fleet host binds only its exact dispatched owner before native work", async () => {
  const require = createRequire(import.meta.url),
    Database = require("better-sqlite3"),
    store = createCombatStore(new Database(":memory:"));
  const definition = store.save("world-A", 1, {
    name: "Fleet",
    mode: "SECURITY_MISSION",
    systemID: null,
    homeStationID: null,
    durationMinutes: 60,
    members: [
      { accountName: "p1", characterID: 1, preparation: {} },
      { accountName: "p2", characterID: 2, preparation: {} },
    ],
  });
  const setup = {
    operationID: definition.operationID!,
    operationRunID: "8c0a2466-0293-412e-a456-7217e0d81f17",
    missionOwnerID: 1,
    agentID: 4,
    missionCount: 1,
    members: [
      { characterID: 1, shipID: 11 },
      { characterID: 2, shipID: 12 },
    ],
    registry: true,
  };
  store.beginGroup(
    "world-A",
    setup.operationID,
    setup.operationRunID,
    "p1",
    1,
    1,
    "a".repeat(64),
    setup,
    [
      { accountName: "p1", characterID: 1, shipID: 11 },
      { accountName: "p2", characterID: 2, shipID: 12 },
    ],
  );
  store.dispatchMember("world-A", setup.operationID, setup.operationRunID, "p1", 1);
  store.dispatchMember("world-A", setup.operationID, setup.operationRunID, "p2", 2);
  const docs = new Map<string, unknown>(),
    factory = createFleetSecurityRuns({
      document: (n) => ({ read: () => docs.get(n) ?? null, write: (v) => docs.set(n, v) }),
      openRegistry: () => ({ ...store, close() {} }),
    });
  const run = (id: number, name: string) =>
    ({
      botID: `bot-${id}`,
      characterID: id,
      held: { characterID: id, character: { characterID: id } },
      setup,
      baseUrl: "http://bff",
      resumed: false,
      report() {},
      fetch: async (input: unknown) => {
        const p = new URL(String(input)).pathname;
        if (p === "/api/pilot-training/characters")
          return Response.json({ ok: true, account: name, characters: [{ characterID: id }] });
        if (p === "/api/plugins/uoc/world") return Response.json({ ok: true, worldID: "world-A" });
        throw Error("preflight stop");
      },
    }) as any;
  await assert.rejects(
    async () => await factory.assistant.start(run(2, "wrong")),
    /does not match/,
  );
  assert.equal(
    store.members("world-A", setup.operationID, setup.operationRunID)[1].status,
    "DISPATCHED",
  );
  await assert.rejects(async () => await factory.owner.start(run(1, "p1")), /preflight stop/);
  const members = store.members("world-A", setup.operationID, setup.operationRunID);
  assert.equal(members[0].status, "RUNNING");
  assert.equal(members[0].bot_id, "bot-1");
  assert.equal(store.runs("world-A", setup.operationID)[0].status, "GROUP_INTENT");
  store.close();
});
