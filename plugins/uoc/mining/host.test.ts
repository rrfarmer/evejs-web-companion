import test from "node:test";
import assert from "node:assert/strict";
import { createNativeMiningRun } from "./host.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { bindCivilianScope } from "../civilian/recovery.ts";
import { runControlRoutes } from "../runControl.ts";
import { miningAcceptedMission } from "./history.ts";

type Handoff = {
  action: "stop" | "continue";
  botID: string;
  stop?: boolean;
  absent?: boolean;
  lostComplete?: boolean;
  terminal?: boolean;
  replacement?: boolean;
  changedJournal?: boolean;
};
type OtherMission = {
  state: 1 | 2;
  blocks?: boolean;
  selected?: 1 | 2;
  eligible?: boolean;
  acceptRace?: boolean;
  referral?: true | "generic label";
};
async function missionScenario(
  mode:
    | "success"
    | "remote-two-trips"
    | "depleted-first"
    | "wrong-target"
    | "empty-effects"
    | "bad-module-identity"
    | "unknown-ack"
    | "post-ack-read"
    | "stop-before-dispatch"
    | "retained-stale-objective"
    | "retained-legacy-partial"
    | "retained-ok"
    | "retained-missing-owner"
    | "retained-active-owner"
    | "retained-foreign-mission"
    | "retained-foreign-module"
    | "retained-active-effect"
    | "retained-null-target"
    | "retained-undocked"
    | "retained-invalid-end"
    | "retained-running-ended"
    | "retained-foreign-row"
    | "retained-no-current-lease"
    | "retained-competing-owner"
    | "retained-current-paused"
    | "retained-current-expired"
    | "retained-old-id-foreign" = "success",
  initial?: unknown,
  count = 1,
  auto = false,
  timed = false,
  recoveryCheck = false,
  foreignMission?: OtherMission,
  handoff?: Handoff,
) {
  const { MINING_MISSION_CONTENT } = await import("./catalog.ts"),
    content = (
      mode === "retained-legacy-partial"
        ? MINING_MISSION_CONTENT.find((c) => c.contentID === 4800)
        : MINING_MISSION_CONTENT[0]
    )!;
  let completedMissions = 0,
    mission = foreignMission?.selected ?? 0,
    foreign = foreignMission?.state ?? 0,
    docked = true,
    warped = false,
    locked = false,
    cycle = false,
    cycleReads = 0,
    lockReads = 0,
    lockRequests = 0,
    lockedTargetID = 0,
    activations = 0,
    deactivations = 0,
    routeStarts = 0,
    q = 0,
    cachedQ = 0,
    invalidations = 0,
    refreshAfterYield = 0,
    bank = 0,
    saved: any = initial === undefined ? null : structuredClone(initial),
    waitFailed = false,
    readFailed = false,
    botReads = 0;
  let handle: any;
  const retained = mode.startsWith("retained-");
  const started = Date.now() - 10000,
    issued = started + 3000,
    finished = started + 8000;
  const calls: string[] = [],
    reports: any[] = [],
    records: any[] = [],
    lockIDs: number[] = [],
    actions: (number | null)[] = [],
    levels: number[] = [];
  const remote = mode === "remote-two-trips",
    siteSystem = remote ? 3002 : 3001,
    yieldPerTrip = remote ? content.quantity / 2 : content.quantity;
  let systemID = 3001,
    systemRoutes: number[] = [],
    warpCalls = 0;
  const rockID = mode === "depleted-first" || remote ? 778 : 777;
  const list = (...items: any[]) => ({ type: "list", items }),
    tuple = (...items: any[]) => ({ type: "tuple", items }),
    dict = (value: any): any => ({ type: "dict", entries: Object.entries(value) });
  const originalTime =
    handoff?.action === "continue" || foreignMission?.selected === 2
      ? saved?.mission?.acceptTimestamp
      : null;
  const acceptedTime = () =>
    String(
      BigInt(
        originalTime ?? (initial === undefined ? "134385096029600000" : "134385096029700000"),
      ) +
        BigInt(completedMissions) +
        (handoff?.replacement ? 1n : 0n),
    );
  const journalRow = (state: number) => [
    state,
    0,
    "UI/Agents/MissionTypes/Mining",
    1234,
    42,
    handoff?.changedJournal ? "134400000000000001" : "134400000000000000",
    0,
    0,
    0,
    content.contentID,
  ];
  const journal = () =>
    tuple(
      list(
        ...(foreign
          ? [
              [
                foreign,
                0,
                foreignMission?.referral === true
                  ? "UI/Agents/MissionTypes/TalkToAgent"
                  : "UI/Agents/MissionTypes/Courier",
                "Corporate Documents",
                41,
                "134400000000000000",
                0,
                0,
                0,
                900,
              ],
            ]
          : []),
        ...(mission
          ? [journalRow(mission)]
          : handoff?.terminal && completedMissions
            ? [journalRow(4)]
            : []),
      ),
      list(tuple(12, 45, 1, 1, 1, 1, 1)),
    );
  const brief = () =>
    dict({
      contentID: content.contentID,
      missionState: mission,
      completionStatus: q + bank >= content.quantity ? 1 : 0,
      importantStandings: 0,
      acceptTimestamp: mission === 2 ? { type: "long", value: acceptedTime() } : null,
      agentGift: list(),
      objectives: list(
        tuple(
          "fetch",
          tuple(
            1001,
            dict({ typeID: 1531, locationID: 6001, solarsystemID: 3001 }),
            dict({
              typeID: content.typeID,
              quantity: content.quantity,
              volume: content.quantity * content.unitVolume,
              hasCargo: false,
            }),
          ),
        ),
      ),
      dungeons: list(
        dict({
          dungeonID: content.dungeonID,
          optional: false,
          location: dict({
            typeID: 5,
            locationType: "dungeon",
            agentID: 42,
            locationNumber: 0,
            locationID: siteSystem,
            solarsystemID: siteSystem,
            coords: tuple(1, 2, 3),
          }),
        }),
      ),
    });
  const agent = {
    agentID: 42,
    stationID: 6001,
    solarSystemID: 3001,
    divisionID: 23,
    agentTypeID: 2,
    corporationID: 1000064,
    level: auto ? 1 : 2,
  };
  const row = (itemID: number, typeID: number, quantity: number) => ({
    type: "packedrow",
    fields: { itemID, typeID, quantity, singleton: 0 },
  });
  const shipInfo = {
    type: "dict",
    entries: [
      [
        99,
        {
          type: "object",
          name: "util.KeyVal",
          args: dict({
            itemID: 99,
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
  const run = {
    botID: handoff?.botID ?? "native-shaped-mining",
    characterID: 123,
    held: { characterID: 123 },
    setup: {
      missionCount: count,
      ...(timed ? { durationMinutes: 1 } : {}),
      agent: auto
        ? {
            mode: "auto",
            levelRule: "max",
            level: 4,
            corporationID: foreignMission ? 1000064 : null,
            maxJumps: 10,
          }
        : { mode: "manual", agentID: 42 },
    },
    baseUrl: "http://example.test",
    resumed: false,
    report(r: any) {
      reports.push(r);
      if (
        (handoff?.action === "stop" && r.phase === "Entering mission") ||
        (handoff?.stop && r.phase === "Continuing")
      ) {
        void runControlRoutes["POST /runs/:botID/stop"]({
          params: { botID: run.botID },
          account: { username: "TestOnly", accountID: 1 },
          method: "POST",
          path: "",
          query: {},
          body: {},
        });
      }
    },
    fetch: async (input: any, init: any) => {
      const url = new URL(String(input)),
        body = init?.body ? JSON.parse(init.body) : null;
      calls.push(url.pathname + (body?.method ? ":" + body.method : ""));
      let data: any = {};
      switch (url.pathname) {
        case "/api/pilot-training/characters":
          data = { account: "TestOnly", characters: [{ characterID: 123 }] };
          break;
        case "/api/bots": {
          botReads++;
          const current = {
            botID: run.botID,
            characterID: 123,
            status: mode === "retained-current-paused" && botReads > 1 ? "paused" : "running",
            endedAt: null,
            startedAt: new Date(Date.now() - 500).toISOString(),
            expiresAt: new Date(
              Date.now() + (mode === "retained-current-expired" && botReads > 1 ? -1000 : 1800000),
            ).toISOString(),
            plugin: { pluginID: "uoc", run: "civilian-mining" },
          };
          const old = {
            botID: "old-run",
            characterID: mode === "retained-old-id-foreign" ? 124 : 123,
            startedAt: new Date(started).toISOString(),
            endedAt:
              mode === "retained-active-owner"
                ? null
                : mode === "retained-invalid-end"
                  ? "not-a-date"
                  : new Date(finished).toISOString(),
            status: mode === "retained-running-ended" ? "running" : "stopped",
            plugin: { pluginID: "uoc", run: "civilian-mining" },
          };
          data = {
            bots: [
              ...(mode === "retained-no-current-lease" && botReads > 1 ? [] : [current]),
              ...(retained && mode !== "retained-missing-owner" ? [old] : []),
              ...(mode === "retained-competing-owner"
                ? [
                    {
                      botID: "other-run",
                      characterID: 123,
                      status: "running",
                      endedAt: null,
                      startedAt: new Date(started).toISOString(),
                      plugin: { pluginID: "uoc", run: "civilian-mining" },
                    },
                  ]
                : []),
            ],
          };
          break;
        }
        case "/api/bridge/flight/status":
          data = {
            flight: {
              shipID: 99,
              solarSystemID: mode === "retained-undocked" ? 3002 : systemID,
              stationID: docked ? 6001 : null,
              docked,
              inSpace: !docked,
              shipMode: "STOP",
              transition: { phase: "ready" },
            },
          };
          break;
        case "/api/bridge/agents/41/record":
          data = {
            agent: {
              ...agent,
              agentID: 41,
              corporationID: foreignMission?.eligible ? agent.corporationID : 1000084,
            },
          };
          break;
        case "/api/bridge/agents/41/briefing":
          data = {
            objective: dict({
              objectives: foreignMission?.referral
                ? list(tuple("agent", tuple(42, dict({ locationID: 6001 }))))
                : list(tuple("transport", tuple())),
            }),
            errors: { objective: null },
          };
          break;
        case "/api/bridge/agents/42/record":
          data = { agent };
          break;
        case "/api/bridge/agents/42/briefing":
          data = {
            briefing: dict({
              AcceptTimestamp: mission === 2 ? { type: "long", value: acceptedTime() } : null,
            }),
            objective: brief(),
            errors: { briefing: null, objective: null },
          };
          break;
        case "/api/bridge/fitting":
          data = {
            activeShipID: 99,
            slots: list({
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
            }),
            shipInfo,
            online: list(55),
            errors: { slots: null, shipInfo: null, online: null, chargeFits: null },
            chargeFits: null,
          };
          break;
        case "/api/types/dogma":
          data = { attributes: { 483: { 73: 10, 77: 100 } } };
          break;
        case "/api/bridge/ship/ore-hold":
          data = {
            activeShipID: 99,
            holds: [
              {
                key: "cargo",
                present: true,
                error: null,
                capacity: { capacity: 350, used: 0 },
                items: [],
              },
              {
                key: "ore",
                present: true,
                error: null,
                capacity: { capacity: remote ? yieldPerTrip * 0.1 : 48000, used: cachedQ * 0.1 },
                items: cachedQ ? [{ itemID: 888, typeID: content.typeID, quantity: cachedQ }] : [],
              },
              {
                key: "asteroid",
                present: false,
                error: null,
                capacity: { capacity: 0, used: 0 },
                items: [],
              },
            ],
          };
          break;
        case "/api/bridge/space/snapshot":
          data = {
            space: {
              stateValid: true,
              shipID: 99,
              solarSystemID: systemID,
              inSpace: !docked,
              sampledAtMs: Date.now(),
              ship: {
                itemID: 99,
                typeID: 17480,
                position: { x: 0, y: 0, z: 0 },
                velocity: { x: 0, y: 0, z: 0 },
                radius: 10,
                activeModuleIDs: [],
                activeModuleTargets: [],
              },
              entities: [
                {
                  itemID: 777,
                  typeID: content.typeID,
                  groupID: content.resourceGroupID,
                  categoryID: 25,
                  position: { x: 100, y: 0, z: 0 },
                  velocity: { x: 0, y: 0, z: 0 },
                  radius: 10,
                  ...(remote ? { remainingQuantity: 0 } : {}),
                },
                ...(rockID === 778
                  ? [
                      {
                        itemID: 778,
                        typeID: content.typeID,
                        groupID: content.resourceGroupID,
                        categoryID: 25,
                        position: { x: 200, y: 0, z: 0 },
                        velocity: { x: 0, y: 0, z: 0 },
                        radius: 10,
                      },
                    ]
                  : []),
              ],
            },
          };
          break;
        case "/api/bridge/targets":
          data = { targetIDs: locked && ++lockReads > 35 ? [lockedTargetID] : [] };
          break;
        case "/api/bridge/inventory":
          data = {
            stationID: 6001,
            activeShipID: 99,
            hangar: { error: null, list: list(...(bank ? [row(889, content.typeID, bank)] : [])) },
          };
          break;
        case "/api/bridge/ship/ore-hold/unload":
          assert.deepEqual(body.itemIDs, [888]);
          bank += q;
          q = 0;
          data = { moved: [888] };
          break;
        case "/api/bridge/call":
          if (body.method === "GetMyJournalDetails") data = { result: journal() };
          else if (body.method === "DoAction") {
            const action = body.args[0];
            actions.push(action);
            if (body.of === 41) {
              assert.ok(foreignMission?.blocks);
              if (action === 379) {
                assert.equal(foreign, 1);
                foreign = 0;
              } else assert.equal(action, null);
              data = {
                result: tuple(
                  tuple(tuple("Agent"), list(tuple(379, 9))),
                  dict({ missionDeclined: action === 379 }),
                ),
              };
              break;
            }
            assert.equal(body.of, 42);
            if (action === 2) {
              assert.equal(mission, 0);
              if (foreign && foreignMission?.blocks)
                return Response.json(
                  {
                    ok: false,
                    error: "CALL_REFUSED",
                    message: "You must decline your existing mission first.",
                  },
                  { status: 409 },
                );
              mission = 1;
            }
            if (action === 3) {
              assert.equal(mission, 1);
              mission = 2;
            }
            if (action === 6) {
              assert.equal(bank, content.quantity);
              mission = 0;
              bank = 0;
              completedMissions++;
              warped = false;
              locked = false;
              cycleReads = 0;
              if (handoff?.lostComplete) throw Error("completion response lost");
            }
            data = {
              result: tuple(
                tuple(
                  tuple("Agent"),
                  list(
                    ...(mission === 0
                      ? [tuple(2, 2)]
                      : mission === 1
                        ? [tuple(3, 3)]
                        : [tuple(6, 6)]),
                  ),
                ),
                dict({
                  missionCompleted:
                    action === 6
                      ? true
                      : action === 3 && !foreignMission?.acceptRace
                        ? false
                        : null,
                }),
              ),
            };
          } else if (body.method === "GetCurrentDungeonForCharacter")
            data = { result: warped ? tuple(content.dungeonID, 0, 77, dict({})) : null };
          else if (body.method === "IsInActiveDungeonID") data = { result: warped };
          else if (body.service === "invCache" && body.method === "InvalidateLocationCache") {
            assert.deepEqual(body.args, [99]);
            invalidations++;
            if (q > 0) refreshAfterYield++;
            cachedQ = q;
            data = { result: null };
          } else if (body.service === "invbroker" && body.method === "List") {
            assert.equal(body.of, 99);
            assert.equal(body.args.length, 1);
            assert.ok([5, 134, 135, 181, 182].includes(body.args[0]));
            if (remote)
              assert.ok([5, 134].includes(body.args[0]), "Native List only for installed holds");
            data = {
              result: list(
                ...(body.args[0] === 134 && cachedQ
                  ? [
                      {
                        type: "packedrow",
                        fields: {
                          itemID: 888,
                          typeID: content.typeID,
                          ownerID: mode === "retained-foreign-row" ? 124 : 123,
                          locationID: 99,
                          flagID: 134,
                          quantity: cachedQ,
                          categoryID: 25,
                        },
                      },
                    ]
                  : []),
              ),
            };
          } else if (body.method === "ItemGetInfo") {
            assert.deepEqual(body.args, [55]);
            if (mode === "post-ack-read" && cycle && !readFailed) {
              readFailed = true;
              throw Error("post-ack read lost");
            }
            if (cycle && cycleReads++ > 0) {
              cycle = false;
              q = Math.min(yieldPerTrip, content.quantity - bank);
            }
            const long = (value: string) => ({ type: "long", value }),
              effect = (id: number, target: number | null) => [
                55,
                123,
                99,
                target,
                null,
                [],
                id,
                long("134385165369120001"),
                id === 16 ? -1 : 60000,
                1,
              ];
            data = {
              result: {
                type: "object",
                name: "util.KeyVal",
                args: dict({
                  itemID: 55,
                  invItem: {
                    type: "packedrow",
                    fields: {
                      itemID: 55,
                      typeID: 483,
                      ownerID: mode === "bad-module-identity" ? 124 : 123,
                      locationID: 99,
                      flagID: 27,
                    },
                  },
                  attributes: {
                    type: "dict",
                    entries: [
                      [54, 15000],
                      [73, 10],
                    ],
                  },
                  activeEffects: {
                    type: "dict",
                    entries:
                      mode === "empty-effects"
                        ? []
                        : [
                            [16, effect(16, null)],
                            ...(cycle
                              ? [
                                  [
                                    67,
                                    effect(
                                      67,
                                      mode === "retained-null-target"
                                        ? null
                                        : mode === "wrong-target"
                                          ? 778
                                          : rockID,
                                    ),
                                  ],
                                ]
                              : []),
                          ],
                  },
                  time: long("134385165369180001"),
                  wallclockTime: long("134385165369179999"),
                }),
              },
            };
          } else if (body.method === "QueryAttributeValue")
            data = { result: 0 }; // Stale client Dogma must not replace native ItemGetInfo.
          else throw Error("Unexpected native method " + body.method);
          break;
        default:
          throw Error("Unexpected native endpoint " + url.pathname);
      }
      return Response.json({ ok: true, ...data });
    },
  } as unknown as PluginRunContext;
  let finder: any = {};
  const session: any = {
    store: {
      live: { get: () => ({ questions: [] }), subscribe: () => () => {} },
      finder: { get: () => finder },
      targeting: {
        get: () => ({ lockedTargetIDs: locked ? [lockedTargetID] : [], acquiringTargetIDs: [] }),
      },
    },
    flow: {
      requestOptions: () => ({ baseUrl: run.baseUrl, fetch: run.fetch }),
      abortRoute: () => {},
      setLivePush: () => {},
      undock: async () => {
        docked = false;
      },
      warpToMissionBookmark: async (
        spot: { agentID: number; locationType: string; locationNumber: number },
        range: number,
      ) => {
        assert.equal(systemID, siteSystem);
        assert.equal(docked, false);
        assert.deepEqual(
          [spot.agentID, spot.locationType, spot.locationNumber, range],
          [42, "dungeon", 0, 0],
        );
        warped = true;
        warpCalls++;
      },
      startRoute: async (destination: number) => {
        if (remote) {
          systemRoutes.push(destination);
          if (destination === siteSystem) {
            docked = false;
            systemID = siteSystem;
          } else {
            assert.equal(destination, 6001);
            docked = true;
            systemID = 3001;
            warped = false;
            locked = false;
            cycleReads = 0;
          }
        } else docked = true;
        routeStarts++;
        return { started: true };
      },
      lockTarget: async () => {
        locked = true;
      },
      findAgents: async ({ level }: { level: number }) => {
        levels.push(level);
        const free = { ...agent, missionKind: "mining", jumps: 0 };
        const agents =
          level === 1
            ? [...(foreignMission?.eligible ? [{ ...free, agentID: 41 }] : []), free]
            : [];
        finder = { loaded: true, error: null, capped: false, total: agents.length, agents };
      },
      flying: {
        sessionGeneration: () => 1,
        isSessionClosing: () => false,
        autopilotProgress: () => null,
        bridgeDo: async (service: string, method: string, args: any[]) => {
          assert.equal(service, "dogmaIM");
          if (method === "AddTarget") {
            lockRequests++;
            lockIDs.push(args[0]);
            if (mode === "depleted-first" && args[0] === 777)
              throw Object.assign(new Error("TargetingAttemptCancelled"), {
                code: "CALL_REFUSED",
                status: 409,
                refusal: { key: "TargetingAttemptCancelled", values: null },
              });
            assert.equal(args[0], rockID);
            locked = true;
            lockedTargetID = args[0];
            return [true];
          }
          if (method === "Activate") {
            assert.deepEqual(args, [55, "", rockID, 0]);
            activations++;
            assert.equal(locked, true);
            if (mode === "unknown-ack") throw Error("activation response lost");
            cycle = true;
            return null;
          }
          if (method === "Deactivate") {
            assert.equal(args[0], 55);
            deactivations++;
            cycle = false;
            return null;
          }
          throw Error("Unexpected bridge command " + method);
        },
        switchModuleOn: async () => {
          throw Error("Use direct Activate");
        },
        switchModuleOff: async () => {
          cycle = false;
        },
      },
    },
  };
  if (retained) {
    const { decodeMiningObjective } = await import("./objective.ts"),
      { decodeCivilianMiningSetup } = await import("./setup.ts"),
      { createHash } = await import("node:crypto");
    mission = 2;
    q = 3;
    if (mode === "retained-active-effect" || mode === "retained-null-target") cycle = true;
    if (mode === "retained-undocked") docked = false;
    const objective = decodeMiningObjective(
      dict({ AcceptTimestamp: { type: "long", value: "134385096029600000" } }),
      brief(),
      123,
      42,
    ).objective;
    assert.ok(objective);
    const mid = JSON.stringify([
      objective.characterID,
      objective.agentID,
      objective.content.contentID,
      objective.content.dungeonID,
      objective.acceptTimestamp,
      objective.systemID,
      objective.position,
    ]);
    const targetMission = mode === "retained-foreign-mission" ? "foreign" : mid,
      moduleID = mode === "retained-foreign-module" ? 66 : 55;
    const attempt = {
      characterID: 123,
      shipID: 99,
      moduleID,
      targetID: 777,
      mission: targetMission,
      lockOrdinal: issued - 1,
      lockIssuedAt: issued - 1,
      ordinal: 9,
      issuedAt: issued,
    };
    saved = {
      version: 1,
      characterID: 123,
      setupKey: createHash("sha256")
        .update(JSON.stringify(decodeCivilianMiningSetup(run.setup)))
        .digest("hex"),
      shipID: 99,
      agentID: 42,
      mission: objective,
      acceptedByRun: "old-run",
      pending: {
        kind: "mining-cycle",
        issuedAt: issued,
        ownerRunID: "old-run",
        attempt,
        details: { moduleID, targetID: 777, before: 0, cycleMs: 60000, mission: targetMission },
      },
      completed: false,
      completedCount: 0,
      nextActivationOrdinal: 10,
    };
    if (mode === "retained-stale-objective")
      saved.mission = { ...objective, acceptTimestamp: "historical-objective" };
    if (mode === "retained-legacy-partial") {
      q = 1500;
      bank = 10955;
      saved.pending = null;
      saved.legacy = {
        characterID: 123,
        shipID: 99,
        agentID: 42,
        objective,
        cycle: {
          moduleID: 55,
          typeID: 483,
          targetID: 777,
          status: "accepted",
          quantityBefore: 1500,
          deadlineMs: 1,
        },
      };
    }
  }
  const host = createNativeMiningRun({
    now: () => Date.now() + (timed && completedMissions >= 2 ? 61000 : 0),
    attach: async () => session,
    document: () => ({
      read: () => saved,
      write: (v: any) => {
        saved = structuredClone(v);
        records.push(structuredClone(v));
        if (
          (mode === "stop-before-dispatch" && saved.pending?.kind === "mining-cycle") ||
          (retained &&
            mode !== "retained-legacy-partial" &&
            saved.cycleSettlements?.length &&
            !saved.pending)
        )
          void handle.stop();
      },
    }),
    wait: async () => {
      if ((mode === "wrong-target" || mode === "empty-effects") && q > 0 && !waitFailed) {
        waitFailed = true;
        throw Error("bounded observation");
      }
    },
  });
  if (recoveryCheck)
    (run.setup as any).parking = {
      mode: "selected",
      kind: "station",
      destinationID: 6002,
      systemID: 3001,
    };
  const recoveryRow = {
    worldID: "synthetic-mining",
    owner: "testonly",
    characterID: 123,
    botID: run.botID,
    kind: "mining" as const,
    status: "paused",
    phase: "Docked",
    pending: "mining-cycle",
    firstFailure: null,
    resolved: false,
    updatedAt: Date.now(),
  };
  if (recoveryCheck || handoff) bindCivilianScope(run, () => recoveryRow);
  if (handoff?.action === "continue") {
    const accepted = miningAcceptedMission(saved);
    assert.ok(accepted);
    Object.assign(run.setup as object, {
      missionCount: 1,
      continuation: { ...accepted, botID: saved.civilian.botID },
    });
    mission = handoff.absent ? 0 : 2;
    bank = Math.floor(content.quantity / 2);
    q = Math.floor(content.quantity / 4);
  }
  handle = await host.start(run);
  for (
    let i = 0;
    i < 150 && !reports.some((r) => ["stopped", "paused", "error"].includes(r.status));
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  let recovery: any = null;
  if (recoveryCheck) {
    const { inspectCivilianOwner } = await import("../civilian/recovery.ts");
    await new Promise((r) => setImmediate(r));
    const firstRecovery = await inspectCivilianOwner(recoveryRow);
    assert.equal(firstRecovery.nativeReconciled, true);
    docked = true;
    const readStart = calls.length,
      routesBefore = routeStarts;
    recovery = await inspectCivilianOwner(recoveryRow);
    assert.equal(routeStarts, routesBefore);
    assert.ok(
      !calls
        .slice(readStart)
        .some((p) => p.startsWith("/api/map") || p === "/api/plugins/uoc/world"),
      "Recovery must not call the Parking path",
    );
    assert.equal(reports.at(-1).status, "paused");
  }
  const snapshot = {
    recovery,
    saved: structuredClone(saved),
    reports: [...reports],
    calls: [...calls],
    records: [...records],
    actions,
    lockRequests,
    lockReads,
    lockIDs,
    activations,
    deactivations,
    routeStarts,
    invalidations,
    refreshAfterYield,
    levels,
    foreign,
    systemRoutes,
    warpCalls,
  };
  await handle.stop();
  return snapshot;
}
test("standalone controller crosses real-shaped native offer, cycle, delivery and completion boundaries", async () => {
  const f = await missionScenario();
  assert.equal(
    f.saved.completed,
    true,
    JSON.stringify({ failure: f.saved.lastFailure, report: f.reports.at(-1) }),
  );
  assert.equal(f.saved.completedCount, 1);
  assert.equal(f.saved.pending, null);
  assert.equal(f.lockRequests, 1);
  assert.equal(f.lockReads, 5);
  assert.equal(f.activations, 1);
  assert.ok(f.invalidations > 0);
  assert.ok(f.refreshAfterYield > 0, "fresh hold must follow invalidation after native yield");
  assert.ok(
    f.records.some((r) => r.pending?.activeProof),
    "exact active proof must be durable before settlement",
  );
  assert.equal(f.calls.filter((x) => x.endsWith(":DoAction")).length, 6);
  assert.equal(f.reports.at(-1).readout.parking.stationID, 6001);
});

const handoffMining = (handoff: Handoff, saved?: unknown) =>
  missionScenario("success", saved, 1, false, false, false, undefined, handoff);
test("Mining Continue after Stop and restart mines the remainder, unloads and completes only the accepted mission", async () => {
  const first = await handoffMining({ action: "stop", botID: "original" });
  assert.equal(first.reports.at(-1).phase, "Docked");
  assert.ok(first.reports.at(-1).readout.acceptedMission);
  assert.deepEqual(
    first.actions.filter((x) => x !== null),
    [2, 3],
  );
  const second = await missionScenario(
    "success",
    JSON.parse(JSON.stringify(first.saved)),
    1,
    false,
    false,
    false,
    { state: 2 },
    { action: "continue", botID: "resumed" },
  );
  assert.equal(second.foreign, 2);
  assert.deepEqual(
    second.actions.filter((x) => x !== null),
    [6],
  );
  assert.equal(second.activations, 1);
  assert.equal(second.calls.filter((x) => x === "/api/bridge/ship/ore-hold/unload").length, 1);
  assert.equal(second.reports.at(-1).phase, "Completed", JSON.stringify(second.reports.at(-1)));
  assert.equal(second.reports.at(-1).readout.completedCount, 1);
});

test("Mining can Stop again during Continue and keeps the exact accepted mission", async () => {
  const original = await handoffMining({ action: "stop", botID: "original" });
  const interrupted = await handoffMining(
    { action: "continue", botID: "resumed", stop: true },
    original.saved,
  );
  assert.equal(interrupted.reports.at(-1).phase, "Docked");
  assert.deepEqual(
    interrupted.reports.at(-1).readout.acceptedMission,
    original.reports.at(-1).readout.acceptedMission,
  );
  assert.equal(interrupted.activations, 0);
  assert.deepEqual(interrupted.actions, []);
  const second = await handoffMining(
    { action: "continue", botID: "resumed-again" },
    interrupted.saved,
  );
  assert.deepEqual(
    second.actions.filter((x) => x !== null),
    [6],
  );
  assert.equal(second.reports.at(-1).phase, "Completed");
});

test("Mining Continue refuses an absent mission and reconciles a confirmed native Complete without replay", async () => {
  const original = await handoffMining({ action: "stop", botID: "original" });
  const absent = await handoffMining(
    { action: "continue", botID: "expired", absent: true },
    original.saved,
  );
  assert.equal(absent.reports.at(-1).phase, "Needs attention");
  assert.match(absent.reports.at(-1).why, /no longer accepted/);
  assert.equal(absent.reports.at(-1).readout.continuationUnavailable, true);
  assert.equal(absent.reports.at(-1).readout.acceptedMission, null);
  assert.deepEqual(absent.actions, []);
  assert.equal(absent.routeStarts, 0);
  const completed = await handoffMining(
    { action: "continue", botID: "resumed", lostComplete: true, terminal: true },
    original.saved,
  );
  assert.equal(completed.reports.at(-1).phase, "Completed");
  assert.deepEqual(
    completed.actions.filter((x) => x !== null),
    [6],
  );
});

test("Mining follows the accepted dungeon into another system, banks two loads, and hands in once", async () => {
  const f = await missionScenario("remote-two-trips");
  assert.equal(f.saved.completed, true, JSON.stringify(f.reports.at(-1)));
  assert.deepEqual(f.systemRoutes, [3002, 6001, 3002, 6001]);
  assert.equal(f.warpCalls, 2);
  assert.deepEqual(f.lockIDs, [778, 778]);
  assert.equal(f.activations, 2);
  assert.equal(f.calls.filter((path) => path === "/api/bridge/ship/ore-hold/unload").length, 2);
  assert.deepEqual(
    f.actions.filter((action) => action !== null),
    [2, 3, 6],
  );
  assert.equal(f.saved.pending, null);
  assert.equal(f.saved.completionReceipt.native.completed, true);
});
test("automatic up-to-four falls back to a reachable eligible level-one Mining agent", async () => {
  const f = await missionScenario("success", undefined, 1, true);
  assert.deepEqual(f.levels, [4, 3, 2, 1]);
  assert.equal(f.saved.completed, true, JSON.stringify(f.reports.at(-1)));
  assert.equal(f.saved.agentID, 42);
  assert.equal(f.actions.filter((x) => x === 2).length, 1);
});
for (const state of [1, 2] as const)
  test(`Mining skips an eligible occupied agent with a foreign ${state === 1 ? "offer" : "accepted mission"}`, async () => {
    const f = await missionScenario("success", undefined, 2, true, false, false, {
      state,
      eligible: true,
    });
    assert.equal(f.reports.at(-1).status, "stopped", JSON.stringify(f.reports.at(-1)));
    assert.equal(f.saved.agentID, 42);
    assert.equal(f.reports.at(-1).readout.completedCount, 2);
    assert.deepEqual(
      f.actions.filter((a) => a !== null),
      [2, 3, 6, 2, 3, 6],
    );
    assert.equal(f.activations, 2);
    assert.equal(f.foreign, state);
  });
for (const state of [1, 2] as const)
  test(`Mining leaves another agent's state-${state} mission alone even if Request is refused`, async () => {
    const f = await missionScenario("success", undefined, 1, true, false, false, {
      state,
      blocks: true,
    });
    assert.equal(f.foreign, state);
    assert.deepEqual(
      f.actions.filter((a) => a !== null),
      [2],
    );
    assert.match(f.saved.lastFailure, /Agent 42 refused Request/);
  });
for (const selected of [1, 2] as const)
  test(`manually selected Mining agent with an unowned state-${selected} mission is left for the player`, async () => {
    const f = await missionScenario("success", undefined, 1, false, false, false, {
      state: 2,
      selected,
    });
    assert.deepEqual(f.actions, []);
    assert.equal(f.activations, 0);
    assert.match(f.saved.lastFailure, /agent 42.*free agent/i);
    assert.equal(f.reports.at(-1).readout.acceptedMission, null);
  });
test("Mining can use a manually selected free agent alongside an accepted player mission", async () => {
  const f = await missionScenario("success", undefined, 1, false, false, false, { state: 2 });
  assert.deepEqual(
    f.actions.filter((a) => a !== null),
    [2, 3, 6],
  );
  assert.equal(f.foreign, 2);
});
test("a regular Mining Start requires recorded acceptance even when the live objective matches exactly", async () => {
  const first = await handoffMining({ action: "stop", botID: "original" }),
    legacy = structuredClone(first.saved);
  delete legacy.acceptedByRun;
  const unowned = await missionScenario("success", legacy, 1, false, false, false, {
    state: 2,
    selected: 2,
  });
  assert.deepEqual(unowned.actions, []);
  assert.equal(unowned.reports.at(-1).readout.acceptedMission, null);
  assert.match(unowned.reports.at(-1).why, /agent 42.*free agent/i);
  const owned = await missionScenario("success", first.saved, 1, false, false, false, {
    state: 2,
    selected: 2,
  });
  assert.deepEqual(
    owned.actions.filter((a) => a !== null),
    [6],
  );
  assert.equal(owned.foreign, 2);
});
for (const referral of [true, "generic label"] as const)
  test(`Mining avoids a referral turn-in on contact (journal label: ${referral})`, async () => {
    const f = await missionScenario("success", undefined, 1, true, false, false, {
      state: 2,
      referral,
    });
    assert.deepEqual(f.actions, []);
    assert.match(f.saved.lastFailure, /would turn in Corporate Documents/);
  });
test("Mining does not claim an already-accepted reply to its Accept", async () => {
  const f = await missionScenario("success", undefined, 1, false, false, false, {
    state: 2,
    acceptRace: true,
  });
  assert.deepEqual(
    f.actions.filter((a) => a !== null),
    [2, 3],
  );
  assert.equal(f.reports.at(-1).readout.acceptedMission, null);
});
test("Mining Continue rejects a replacement at the same agent even with the same content", async () => {
  const first = await handoffMining({ action: "stop", botID: "original" });
  for (const changed of [{ replacement: true }, { changedJournal: true }]) {
    const f = await handoffMining(
      { action: "continue", botID: "resumed", ...changed },
      first.saved,
    );
    assert.deepEqual(f.actions, []);
    assert.equal(f.reports.at(-1).readout.continuationUnavailable, true);
  }
});
test("time mode continues past the count field and stops at its clock limit", async () => {
  const f = await missionScenario("success", undefined, 1, false, true);
  assert.equal(f.actions.filter((a) => a === 6).length, 2);
  assert.equal(f.reports.at(-1).status, "stopped");
  assert.equal(f.reports.at(-1).readout.completedCount, 2);
});
test("two missions complete sequentially with durable prior receipt and no duplicate actions", async () => {
  const f = await missionScenario("success", undefined, 2);
  assert.equal(f.saved.completed, true, JSON.stringify(f.reports.at(-1)));
  assert.equal(f.reports.at(-1).readout.completedCount, 2);
  assert.equal(f.saved.history.length, 1);
  assert.deepEqual(
    [2, 3, 6].map((a) => f.actions.filter((x) => x === a).length),
    [2, 2, 2],
  );
  assert.notEqual(f.saved.history[0].completionReceipt.mission, f.saved.completionReceipt.mission);
});
test("a completed run preserves its receipt and reward while the next distinct mission consumes stale legacy", async () => {
  const first = await missionScenario();
  assert.equal(first.saved.completed, true);
  assert.ok(first.saved.reward);
  assert.equal(first.actions.filter((a) => a === 6).length, 1);
  const seed = structuredClone(first.saved);
  seed.legacy = { objective: structuredClone(first.saved.mission) };
  const second = await missionScenario("success", seed);
  assert.equal(second.saved.completed, true, JSON.stringify(second.reports.at(-1)));
  assert.equal(second.actions.filter((a) => a === 2).length, 1);
  assert.equal(second.actions.filter((a) => a === 6).length, 1);
  assert.notEqual(second.saved.completionReceipt.mission, first.saved.completionReceipt.mission);
  assert.equal(second.saved.legacy, null);
  assert.equal(second.saved.history.length, 1);
  assert.deepEqual(second.saved.history[0].completionReceipt, first.saved.completionReceipt);
  assert.deepEqual(second.saved.history[0].reward, first.saved.reward);
  assert.deepEqual(second.saved.history[0].legacy, seed.legacy);
});
test("a definitively depleted target is retired and the next native resource is mined", async () => {
  const f = await missionScenario("depleted-first");
  assert.equal(
    f.saved.completed,
    true,
    JSON.stringify({ failure: f.saved.lastFailure, report: f.reports.at(-1) }),
  );
  assert.equal(f.saved.completedCount, 1);
  assert.equal(f.activations, 1);
  assert.deepEqual(f.lockIDs, [777, 778]);
  assert.equal(f.saved.pending, null);
});
test("ore gain without exact module-target observation stays pending", async () => {
  const f = await missionScenario("wrong-target");
  assert.equal(f.activations, 1);
  assert.equal(f.saved.completed, false);
  assert.equal(f.saved.pending?.kind, "mining-cycle");
  assert.equal(
    f.records.some((r) => r.pending?.activeProof),
    false,
  );
  assert.equal(f.reports.at(-1).status, "paused");
  assert.match(f.saved.lastFailure, /bounded observation/);
  assert.equal(f.calls.includes("/api/bridge/ship/ore-hold/unload"), false);
});
test("known empty native effect map cannot invent earlier active proof", async () => {
  const f = await missionScenario("empty-effects");
  assert.equal(f.activations, 1);
  assert.equal(f.saved.pending?.kind, "mining-cycle");
  assert.equal(
    f.records.some((r) => r.pending?.activeProof),
    false,
  );
  assert.equal(f.saved.completed, false);
  assert.match(f.saved.lastFailure, /bounded observation/);
});
test("wrong ItemGetInfo ownership is unknown and cannot settle", async () => {
  const f = await missionScenario("bad-module-identity");
  assert.equal(f.activations, 0);
  assert.equal(f.saved.pending, null);
  assert.equal(
    f.records.some((r) => r.pending?.activeProof),
    false,
  );
  assert.equal(f.saved.completed, false);
  assert.match(f.saved.lastFailure, /module snapshot is incomplete/);
  assert.equal(f.reports.at(-1).phase, "Parking blocked");
  assert.equal(f.deactivations, 0);
});
test("unknown activation outcome is retained without replay", async () => {
  const f = await missionScenario("unknown-ack");
  assert.equal(f.activations, 1);
  assert.equal(f.saved.pending?.kind, "mining-cycle");
  assert.equal(f.saved.completed, false);
  assert.match(f.saved.lastFailure, /activation response lost/);
  assert.equal(f.reports.at(-1).status, "paused");
});
test("a post-ack read failure retains the attempt without replay", async () => {
  const f = await missionScenario("post-ack-read");
  assert.equal(f.activations, 1);
  assert.equal(f.saved.pending?.kind, "mining-cycle");
  assert.equal(f.saved.completed, false);
  assert.match(f.saved.lastFailure, /post-ack read lost/);
  assert.equal(f.reports.at(-1).status, "paused");
  assert.equal(f.deactivations, 1);
});
test("stop before native dispatch restores the parent lock intent", async () => {
  const f = await missionScenario("stop-before-dispatch");
  assert.equal(f.activations, 0);
  assert.equal(f.saved.completed, false);
  assert.equal(f.saved.lastActivationNotDispatched?.reason, "STOP_BEFORE_DISPATCH");
  assert.equal(f.saved.pending?.kind, "target-lock");
});

test("ended original run with inactive exact module retires only physical custody", async () => {
  const f = await missionScenario("retained-ok"),
    settlement = f.saved.cycleSettlements?.[0];
  assert.ok(settlement);
  assert.equal(settlement.ownerRunID, "old-run");
  assert.equal(settlement.outcome, "NATIVE_EFFECT_SETTLED");
  assert.equal(settlement.yieldOutcome, "NOT_ATTRIBUTED");
  assert.equal(settlement.intent.attempt.ordinal, 9);
  assert.equal(f.saved.quantity, 3);
  assert.equal(f.saved.completedCount, 0);
  assert.equal(f.saved.completed, false);
  assert.equal(f.saved.pending, null);
  assert.equal(f.activations, 0);
  assert.ok(f.refreshAfterYield > 0);
});
test("missing old history permits only physical retirement under the current exclusive lease", async () => {
  const f = await missionScenario("retained-missing-owner"),
    settlement = f.saved.cycleSettlements?.[0];
  assert.ok(settlement);
  assert.equal(settlement.intent.ownerRunID, "old-run");
  assert.equal(settlement.outcome, "NATIVE_EFFECT_SETTLED");
  assert.equal(settlement.yieldOutcome, "NOT_ATTRIBUTED");
  assert.equal(f.saved.quantity, 3);
  assert.equal(f.saved.completedCount, 0);
  assert.equal(f.saved.pending, null);
  assert.equal(f.activations, 0);
});
for (const mode of [
  "retained-competing-owner",
  "retained-active-owner",
  "retained-foreign-module",
  "retained-active-effect",
  "retained-null-target",
  "retained-foreign-row",
] as const) {
  test(`${mode} cannot retire the unknown cycle`, async () => {
    const f = await missionScenario(mode);
    assert.equal(f.saved.pending?.kind, "mining-cycle");
    assert.equal(f.saved.cycleSettlements?.length ?? 0, 0);
    assert.equal(f.saved.completedCount, 0);
    assert.equal(f.activations, 0);
  });
}

function fixture(pending: any = null, short = false) {
  let value: any = pending
    ? {
        version: 1,
        characterID: 123,
        setupKey: "",
        shipID: 99,
        agentID: 42,
        mission: null,
        pending,
        completed: false,
        completedCount: 0,
      }
    : null;
  const reports: any[] = [],
    requests: string[] = [],
    setup = { missionCount: 1, agent: { mode: "manual", agentID: 42 } };
  const run = {
    botID: "fixture-" + Math.random(),
    characterID: 123,
    held: { characterID: 123 },
    setup,
    baseUrl: "http://example.test",
    resumed: false,
    report: (r: any) => reports.push(r),
    fetch: async (input: any) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname === "/api/pilot-training/characters")
        return Response.json({ ok: true, account: "TestOnly", characters: [{ characterID: 123 }] });
      if (url.pathname === "/api/bots")
        return Response.json({
          ok: true,
          bots: [
            {
              botID: run.botID,
              characterID: 123,
              expiresAt: new Date(Date.now() + (short ? 120000 : 1800000)).toISOString(),
            },
          ],
        });
      if (url.pathname === "/api/bridge/flight/status")
        return Response.json({
          ok: true,
          flight: {
            shipID: 99,
            solarSystemID: 3001,
            stationID: 6001,
            docked: true,
            inSpace: false,
          },
        });
      throw Error("Unexpected native request " + url.pathname);
    },
  } as unknown as PluginRunContext;
  const session: any = {
    store: {},
    flow: {
      requestOptions: () => ({}),
      abortRoute: () => {},
      setLivePush: () => {},
      flying: { sessionGeneration: () => 1, isSessionClosing: () => false },
    },
  };
  return {
    run,
    session,
    reports,
    requests,
    read: () => value,
    write: (v: any) => {
      value = structuredClone(v);
    },
  };
}
test("verified host deadline winds down without requesting a mission and confirms docked location", async () => {
  const f = fixture(null, true),
    host = createNativeMiningRun({
      attach: async () => f.session,
      document: () => ({ read: f.read, write: f.write }),
    });
  const handle = await host.start(f.run);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await handle.stop();
  assert.equal(f.requests.includes("/api/bridge/call"), false);
  const end = f.reports.at(-1);
  assert.equal(end.status, "stopped");
  assert.equal(end.readout.completedCount, 0);
  assert.equal(end.readout.parking.stationID, 6001);
  assert.equal(end.readout.parking.release, "PENDING_CORE");
});
test("existing uncertain native action is never dispatched again or counted completed", async () => {
  const f = fixture({ kind: "complete", details: { agentID: 42 } });
  const { createHash } = await import("node:crypto");
  f.read().setupKey = createHash("sha256")
    .update(JSON.stringify({ agent: { mode: "manual", agentID: 42 }, missionCount: 1 }))
    .digest("hex");
  const host = createNativeMiningRun({
    attach: async () => f.session,
    document: () => ({ read: f.read, write: f.write }),
  });
  const handle = await host.start(f.run);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.requests.includes("/api/bridge/call"), false);
  assert.equal(f.read().pending.kind, "complete");
  assert.equal(f.reports.at(-1).status, "paused");
  assert.equal(f.reports.at(-1).readout.completedCount, 0);
  await handle.stop();
});

test("existing-owner read-only cycle reconciliation records native inactive effects without crediting an unknown Activate or completing the mission", async () => {
  const f = await missionScenario("unknown-ack", undefined, 1, false, false, true);
  assert.equal(f.activations, 1);
  assert.equal(f.saved.pending, null);
  assert.equal(f.saved.cycleSettlements.at(-1).outcome, "NATIVE_EFFECT_SETTLED");
  assert.equal(f.saved.cycleSettlements.at(-1).yieldOutcome, "NOT_ATTRIBUTED");
  assert.equal(f.recovery.nativeReconciled, false);
  assert.equal(f.recovery.missionSettled, false);
  assert.match(f.recovery.reason, /does not verify the selected Parking/);
  assert.equal(f.saved.completed, false);
  assert.equal(f.reports.at(-1).readout.completedCount, 0);
});

test("current inactive cycle plus 10955 banked and 1500 aboard continues Claimjumpers from native inventory, without replaying the old Activate", async () => {
  const f = await missionScenario("retained-legacy-partial");
  assert.equal(f.saved.completed, true, JSON.stringify(f.reports.at(-1)));
  assert.equal(f.saved.pending, null);
  assert.equal(f.saved.legacy.cycle, null);
  assert.equal(f.saved.cycleSettlements[0].yieldOutcome, "NOT_ATTRIBUTED");
  assert.equal(f.saved.cycleSettlements[0].intent.deadlineMs, 1);
  assert.equal(
    f.activations,
    1,
    "one fresh mining cycle after native inactive proof, never the retained Activate",
  );
  assert.equal(
    f.actions.filter((a) => a === 2 || a === 3).length,
    0,
    "no Request or Accept repeated",
  );
  assert.equal(f.actions.filter((a) => a === 6).length, 1);
  assert.equal(f.saved.banked, 18000);
});
for (const mode of [
  "retained-foreign-mission",
  "retained-current-expired",
  "retained-no-current-lease",
  "retained-current-paused",
  "retained-old-id-foreign",
  "retained-invalid-end",
  "retained-running-ended",
  "retained-undocked",
] as const)
  test(`${mode}: missing/stale historical roster cannot overrule the current held native session`, async () => {
    const f = await missionScenario(mode);
    assert.equal(f.saved.pending, null, JSON.stringify(f.reports.at(-1)));
    assert.equal(f.saved.cycleSettlements[0].yieldOutcome, "NOT_ATTRIBUTED");
    assert.equal(f.activations, 0);
  });

test("a replacement Mining objective cannot take over an earlier run's unresolved cycle", async () => {
  const f = await missionScenario("retained-stale-objective");
  assert.equal(f.saved.mission.acceptTimestamp, "historical-objective");
  assert.equal(f.saved.pending.kind, "mining-cycle");
  assert.deepEqual(f.actions, []);
  assert.equal(f.activations, 0);
});
