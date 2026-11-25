import { decodeSpaceSnapshot } from "../../../web/src/plugin-api/flying.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { createMiningDefender, prepareHeldDefender, isMiningDefenderTarget } from "./defender.ts";
import { FleetObservationUnavailable } from "./stopSignal.ts";
import { TransportQueueError } from "../../../web/src/app/transport.ts";
import { BridgeCallError } from "../../../web/src/bridge/callMethod.ts";
test("defender selects only visibly identified hostile NPC ships", () => {
  const npc: any = {
    itemID: 90,
    kind: "ship",
    categoryID: 11,
    geometryAvailable: true,
    isNpc: true,
    isSelf: false,
    npcEntityType: "npc",
  };
  assert.equal(isMiningDefenderTarget(npc), true);
  for (const row of [
    { ...npc, isNpc: false },
    { ...npc, isSelf: true },
    { ...npc, npcEntityType: "concord" },
    { ...npc, npcEntityType: null },
    { ...npc, kind: "structure" },
    { ...npc, categoryID: 6 },
    { ...npc, geometryAvailable: false },
  ])
    assert.equal(isMiningDefenderTarget(row), false);
});
import { createPilotTiming } from "./timing.ts";
test("defender proactively engages a hostile with no current target at its exact claimed belt", async () => {
  const events: string[] = [],
    docState = new Map<string, unknown>([
      [
        "mining-fleet-defender:" + JSON.stringify(["op", "run", "bot", 1, 11, "BELT:300:Belt", 1]),
        { events: new Array(5000) },
      ],
    ]),
    timing: string[] = [];
  let drone = false,
    engaged = 0,
    time = 1000,
    locked = false;
  const target = { kind: "BELT" as const, systemID: 300, name: "Belt" },
    claim = {
      key: "BELT:300:Belt",
      operationID: "op",
      runID: "run",
      generation: 1,
      expiresAt: Date.now() + 60000,
    },
    position = { x: 0, y: 0, z: 0 },
    transition = {
      phase: "ready",
      sessionStable: true,
      locationReady: true,
      sceneReady: true,
      egoReady: true,
      shipReady: true,
      boundContextReady: true,
    };
  const run: any = {
    botID: "bot",
    characterID: 1,
    held: { characterID: 1 },
    baseUrl: "http://bff",
    fetch: async (input: any, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      let body: any;
      if (path === "/api/bridge/flight/status")
        body = {
          flight: {
            shipID: 11,
            solarSystemID: 300,
            inSpace: true,
            docked: false,
            shipMode: "STOP",
            transition,
          },
        };
      else if (path === "/api/bridge/space/snapshot")
        body = {
          space: {
            stateValid: true,
            inSpace: true,
            shipID: 11,
            solarSystemID: 300,
            sampledAtMs: ++time,
            ship: { itemID: 11, characterID: 1, position, radius: 10, mode: "STOP", hullRatio: 1 },
            entities: [
              { itemID: 12, kind: "ship", characterID: 2, position, radius: 10 },
              {
                itemID: 77,
                kind: "asteroidBelt",
                groupID: 9,
                name: "Belt",
                position: { x: 100, y: 0, z: 0 },
                radius: 10,
              },
              {
                itemID: 90,
                kind: "ship",
                categoryID: 11,
                isNpc: true,
                npcEntityType: "npc",
                position: { x: 1000, y: 0, z: 0 },
                radius: 10,
                shieldRatio: 1,
                armorRatio: 1,
                hullRatio: 1,
              },
              ...(drone
                ? [
                    {
                      itemID: 8,
                      kind: "drone",
                      ownerID: 1,
                      controllerID: 11,
                      targetEntityID: engaged || null,
                      position,
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
      else if (path === "/api/bridge/targets") body = { targetIDs: locked ? [90] : [] };
      else if (path === "/api/bridge/drones")
        body = { activeShipID: 11, shipInfo: null, errors: { shipInfo: null } };
      else if (path === "/api/bridge/call") {
        const q = JSON.parse(String(init?.body));
        events.push(q.method);
        if (q.method === "QueryAllAttributesForItem")
          body = {
            result: {
              type: "dict",
              entries: [
                [352, 10],
                [1271, 50],
              ],
            },
          };
        else if (q.method === "InvalidateLocationCache") body = { result: null };
        else if (q.method === "List")
          body = {
            result: {
              type: "list",
              items: drone
                ? []
                : [
                    {
                      itemID: 7,
                      typeID: 2454,
                      ownerID: 1,
                      locationID: 11,
                      flagID: 87,
                      quantity: 1,
                    },
                  ],
            },
          };
        else if (q.method === "LaunchDrones") {
          drone = true;
          body = { result: { type: "dict", entries: [[7, { type: "list", items: [8] }]] } };
        } else if (q.method === "CmdEngage") {
          engaged = q.args[1];
          body = { result: { type: "dict", entries: [] } };
        } else throw Error(q.method);
      } else throw Error(path);
      return Response.json({ ok: true, ...body });
    },
  };
  const session: any = {
    store: {
      station: { get: () => ({ online: { characterID: 1 } }) },
      fitting: { get: () => ({ activeShipID: 11, slotsError: null, slots: [], chargeFits: {} }) },
    },
    flow: {
      requestOptions: () => ({}),
      flying: {
        sessionGeneration: () => 1,
        isSessionClosing: () => false,
        bridgeAsk: async () => 45000,
        bridgeDo: async () => {
          locked = true;
          return [0];
        },
        readFit: async () => true,
        resolveDefenseModuleIDs: () => ({
          weapons: [],
          shield: [],
          armor: [],
          hull: [],
          hardeners: [],
        }),
        resolveRemoteRepModuleIDs: () => ({ shield: [], armor: [], hull: [], cap: [] }),
        fittedModuleActivation: () => null,
        resolveDroneControlRange: async () => 45000,
        withPilotDroneCap: () => ({ maxActiveDrones: 5, droneBandwidth: 25 }),
        attributesOfTypes: async () => ({ 2454: { 1272: 5 } }),
        classifyDroneRoles: async () => ({
          bay: { combat: drone ? [] : [7] },
          out: { combat: drone ? [8] : [] },
        }),
      },
    },
  };
  const defender = createMiningDefender({
    run,
    session,
    shipID: 11,
    target,
    claim,
    beltID: 77,
    repairMembers: [{ characterID: 2, shipID: 12, role: "MINER" }],
    document: (key) => ({
      read: () => docState.get(key) ?? null,
      write: (v) => {
        docState.set(key, structuredClone(v));
      },
    }),
    timing: createPilotTiming(
      { operationID: "op", operationRunID: "run", characterID: 1, shipID: 11, role: "DEFENDER" },
      (line) => timing.push(JSON.parse(line.slice(13)).event),
    ),
    current() {},
    stopRequested: () => false,
    authority: () => ({ state: "ACTIVE", target, claim }),
    wait: async () => {},
  });
  assert.equal(await defender.readyToEscort(), true);
  await defender.tick();
  assert.equal(engaged, 90);
  assert.equal(events.filter((x) => x === "LaunchDrones").length, 1);
  assert.equal(events.filter((x) => x === "CmdEngage").length, 1);
  assert.equal(timing.includes("defender-engage-confirmed"), false);
  assert.equal(await defender.tick(), "responding");
  assert.ok(timing.includes("defender-engage-confirmed"));
});

function escortFixture(writeTiming?: (line: string) => void) {
  const docs = new Map<string, unknown>(),
    events: string[] = [],
    currentFire = new Map<number, number>();
  const traces = new Map<number, { action: string; at: number }[]>();
  const target = { kind: "BELT" as const, systemID: 300, name: "Belt" };
  const claim = {
    key: "BELT:300:Belt",
    operationID: "mixed-escort",
    runID: "run",
    generation: 1,
    expiresAt: Date.now() + 60000,
  };
  const point = (x: number, y = 0) => ({ x, y, z: 0 });
  const transition = {
    phase: "ready",
    sessionStable: true,
    locationReady: true,
    sceneReady: true,
    egoReady: true,
    shipReady: true,
    boundContextReady: true,
  };
  const dict = (entries: unknown[]) => ({ type: "dict", entries }),
    kv = (fields: Record<string, unknown>) => ({
      type: "object",
      name: "util.KeyVal",
      args: dict(Object.entries(fields)),
    });
  let sample = 1000;
  const controls = {
    refuseTarget: null as number | null,
    ackWithoutEffect: false,
    loseWeaponResponse: false,
    loseDroneResponse: false,
    dropOnLock: false,
    refuseLock: null as number | null,
    smallX: 7000,
    largeShield: 1,
    stopping: false,
    sceneAvailable: true,
    weaponTargetsAvailable: true,
    nativeLockReply: true,
    pendingLock: false,
    beforeWeaponReply: undefined as ((moduleID: number) => Promise<void>) | undefined,
    onDroneOrder: undefined as (() => void) | undefined,
    beforeLockRead: undefined as ((id: number) => Promise<void>) | undefined,
    heldLocks: undefined as number[] | undefined,
    beforeLaunchReply: undefined as (() => Promise<void>) | undefined,
    hostiles: null as { id: number; x: number; hull?: number }[] | null,
    dronesInBay: false,
    showLaunchedDrones: false,
    refuseWeaponLock: false,
    lockReadUnavailable: false,
    beforeFitRead: undefined as ((id: number) => Promise<void>) | undefined,
    beforeDroneBayRead: undefined as (() => Promise<void>) | undefined,
    beforeDronePanelRead: undefined as (() => Promise<void>) | undefined,
    beforeLockRangeRead: undefined as (() => Promise<void>) | undefined,
    beforeDroneRangeRead: undefined as (() => Promise<void>) | undefined,
    beforeSignatureRead: undefined as (() => Promise<void>) | undefined,
    beforeModuleRead: undefined as ((moduleID: number) => Promise<void>) | undefined,
    beforePropulsionReply: undefined as ((on: boolean) => Promise<void>) | undefined,
    shieldRatio: 1,
    armorRatio: 1,
    hullRatio: 1,
    capacitorRatio: 1,
    scrammed: false,
    beforeLock: undefined as (() => void) | undefined,
    onLock: undefined as (() => void) | undefined,
    ammoFit: false,
    reloadObserved: false,
    onReload: undefined as ((moduleID: number) => void | Promise<void>) | undefined,
    sceneSampledAtMs: null as number | null,
    droneBayCapacity: null as number | null,
    firstChargeType: 101,
    lockLimit: null as number | null,
    defenderIDs: [] as number[],
    noJams: false,
    beforeLockReply: undefined as ((targetID: number) => Promise<void>) | undefined,
  };
  const reads = { targets: 0, grid: 0 };
  const members = [
    { characterID: 1, shipID: 11, role: "MINER" },
    { characterID: 2, shipID: 12, role: "MINER" },
    { characterID: 7, shipID: 17, role: "HAULER" },
  ] as const;
  const peerPositions = new Map<number, number>([[11, 0]]),
    activePeers = new Set<number>([11]);
  const pilotPositions = new Map<number, number>(),
    following = new Map<number, number>(),
    throttle = new Map<number, number>();
  const tackle = {
    sourceBallID: 901,
    moduleID: 401,
    jammingType: "warpScramblerMWD",
    receivedAtMs: Date.now(),
    durationMs: 60000,
  };
  const defenders = new Map<number, ReturnType<typeof createMiningDefender>>();
  function pilot(
    id: number,
    large: boolean,
    withDrone = false,
    secondWeapon = false,
    equipment: {
      repair?: boolean;
      propulsion?: "afterburner" | "microwarpdrive";
      wait?(ms: number): Promise<void>;
    } = {},
  ) {
    const trace: { action: string; at: number }[] = [];
    traces.set(id, trace);
    const mark = (action: string) => trace.push({ action, at: performance.now() });
    const shipID = 100 + id,
      weaponID = 200 + id,
      typeID = large ? 310 : 311,
      locked = new Set<number>();
    const weaponIDs = secondWeapon ? [weaponID, 1000 + weaponID] : [weaponID];
    const local = equipment.repair
      ? [
          { kind: "shield", itemID: 703, family: "mid", index: 0, flagID: 19 },
          { kind: "armor", itemID: 704, family: "low", index: 0, flagID: 11 },
          { kind: "hull", itemID: 705, family: "low", index: 1, flagID: 12 },
          { kind: "hardener", itemID: 706, family: "mid", index: 1, flagID: 20 },
        ]
      : [];
    const propulsion = equipment.propulsion
      ? { itemID: 707, typeID: 712, kind: equipment.propulsion }
      : null;
    const activeAuxiliary = new Set<number>();
    const operatePropulsion = async (method: string, args: readonly unknown[]) => {
      assert.ok(propulsion);
      const effect =
        propulsion.kind === "afterburner" ? "moduleBonusAfterburner" : "moduleBonusMicrowarpdrive";
      const on = method === "Activate";
      assert.equal(method, on ? "Activate" : "Deactivate");
      assert.deepEqual(
        args,
        on ? [propulsion.itemID, effect, null, -1] : [propulsion.itemID, effect],
      );
      events.push("propulsion:" + (on ? "on" : "off"));
      await controls.beforePropulsionReply?.(on);
      if (on) activeAuxiliary.add(propulsion.itemID);
      else activeAuxiliary.delete(propulsion.itemID);
    };
    const secondaryTargets = new Map<number, number>();
    const firing = (moduleID: number) =>
      moduleID === weaponID ? currentFire.get(id) : secondaryTargets.get(moduleID);
    const setFiring = (moduleID: number, targetID: number | null) => {
      const [effects, key] =
        moduleID === weaponID ? [currentFire, id] : [secondaryTargets, moduleID];
      if (targetID === null) effects.delete(key);
      else effects.set(key, targetID);
    };
    const droneID = 400 + id,
      bayID = 500 + id;
    const pendingTargets = new Set<number>();
    let droneTarget: number | null = null,
      launched = false;
    const droneOnGrid = () =>
      withDrone && (!controls.dronesInBay || (launched && controls.showLaunchedDrones));
    const row = (moduleID: number) => ({
      itemID: moduleID,
      typeID: propulsion?.itemID === moduleID ? propulsion.typeID : typeID,
      ownerID: id,
      locationID: shipID,
      flagID:
        local.find((m) => m.itemID === moduleID)?.flagID ??
        (propulsion?.itemID === moduleID ? 21 : 27 + weaponIDs.indexOf(moduleID)),
      quantity: 1,
      categoryID: 7,
    });
    const flight = {
      shipID,
      inSpace: true,
      docked: false,
      solarSystemID: 300,
      shipMode: "STOP",
      transition,
    };
    function nativeGrid() {
      const position = point(pilotPositions.get(id) ?? 0),
        follow = following.get(id);
      const activeModuleTargets = weaponIDs.flatMap((id) => {
        const target = firing(id);
        return target ? [[id, target] as const] : [];
      });
      const hostile = (itemID: number, x: number, hullRatio = 1) => ({
        itemID,
        typeID: 501,
        kind: "ship",
        categoryID: 11,
        isNpc: true,
        npcEntityType: "npc",
        position: point(x),
        velocity: point(0),
        radius: 35,
        shieldRatio: 1,
        armorRatio: 1,
        hullRatio,
      });
      return {
        stateValid: true,
        inSpace: true,
        shipID,
        solarSystemID: 300,
        sampledAtMs: controls.sceneSampledAtMs ?? ++sample,
        ship: {
          itemID: shipID,
          characterID: id,
          position,
          radius: 10,
          mode: follow ? "FOLLOW" : "STOP",
          velocity: point(0),
          shieldRatio: controls.shieldRatio,
          armorRatio: controls.armorRatio,
          hullRatio: controls.hullRatio,
          capacitorRatio: controls.capacitorRatio,
          speedFraction: throttle.get(id) ?? null,
          activeModuleIDs: [...activeModuleTargets.map(([item]) => item), ...activeAuxiliary],
          activeModuleTargets: controls.weaponTargetsAvailable ? activeModuleTargets : null,
        },
        entities: [
          { itemID: 77, groupID: 9, name: "Belt", position: point(100), radius: 10 },
          {
            itemID: shipID,
            kind: "ship",
            characterID: id,
            position,
            radius: 10,
            targetEntityID: follow ?? null,
          },
          ...(droneOnGrid()
            ? [
                {
                  itemID: droneID,
                  typeID: 2454,
                  kind: "drone",
                  ownerID: id,
                  controllerID: shipID,
                  targetEntityID: droneTarget,
                  position,
                  radius: 1,
                },
              ]
            : []),
          ...members.flatMap((m) =>
            peerPositions.has(m.shipID)
              ? [
                  {
                    itemID: m.shipID,
                    kind: "ship",
                    characterID: m.characterID,
                    position: point(peerPositions.get(m.shipID)!),
                    radius: 10,
                  },
                ]
              : [],
          ),
          ...(controls.hostiles
            ? controls.hostiles.map((r) => hostile(r.id, r.x, r.hull))
            : [
                { ...hostile(901, controls.smallX), velocity: point(0, 280) },
                {
                  ...hostile(902, 8500),
                  typeID: 502,
                  velocity: point(0, 8),
                  radius: 220,
                  shieldRatio: controls.largeShield,
                },
                { ...hostile(903, 4000), velocity: point(0, 180) },
              ]),
        ],
      };
    }
    const run: any = {
      botID: "mixed-" + id,
      characterID: id,
      held: { characterID: id },
      baseUrl: "http://bff",
      async fetch(input: URL, init?: RequestInit) {
        const path = new URL(String(input)).pathname;
        if (path === "/api/bridge/flight/status")
          return Response.json({
            ok: true,
            flight: { ...flight, shipMode: following.has(id) ? "FOLLOW" : "STOP" },
          });
        if (path === "/api/bridge/targets") {
          mark("targets");
          reads.targets++;
          await controls.beforeLockRead?.(id);
          if (controls.lockReadUnavailable) {
            controls.lockReadUnavailable = false;
            return Response.json({ ok: false, error: "EVE_GATEWAY_UNREACHABLE" }, { status: 502 });
          }
          if (!controls.pendingLock) {
            for (const target of pendingTargets) locked.add(target);
            pendingTargets.clear();
          }
          return Response.json({ ok: true, targetIDs: [...locked] });
        }
        if (path === "/api/bridge/drones") {
          mark("drone-panel");
          await controls.beforeDronePanelRead?.();
          return Response.json({
            ok: true,
            activeShipID: shipID,
            bay: [],
            inSpace: [],
            errors: { bay: null, inSpace: null, shipInfo: null },
          });
        }
        if (path === "/api/bridge/space/snapshot") {
          mark("snapshot");
          reads.grid++;
          if (!controls.sceneAvailable)
            return Response.json({ ok: false, error: "EVE_GATEWAY_UNREACHABLE" }, { status: 502 });
          return Response.json({ ok: true, space: nativeGrid() });
        }
        if (path !== "/api/bridge/call") throw Error(path);
        const { method, args } = JSON.parse(String(init?.body));
        mark(method);
        let result: unknown = null;
        if (method === "List") {
          if (args[0] === 87) await controls.beforeDroneBayRead?.();
          result = {
            type: "list",
            items:
              args[0] === 87 && controls.dronesInBay && !launched
                ? [
                    {
                      itemID: bayID,
                      typeID: 2454,
                      ownerID: id,
                      locationID: shipID,
                      flagID: 87,
                      quantity: 1,
                    },
                  ]
                : args[0] === 5 && controls.ammoFit
                  ? [
                      {
                        itemID: 600 + id,
                        typeID: 101,
                        ownerID: id,
                        locationID: shipID,
                        flagID: 5,
                        quantity: 20,
                        groupID: 9,
                        categoryID: 8,
                      },
                    ]
                  : [
                      ...weaponIDs,
                      ...local.map((m) => m.itemID),
                      ...(propulsion ? [propulsion.itemID] : []),
                    ]
                      .map(row)
                      .filter((item) => item.flagID === args[0]),
          };
        } else if (method === "QueryAllAttributesForItem")
          result = dict([
            [352, 10],
            [1271, 50],
          ]);
        else if (method === "LaunchDrones") {
          assert.equal(launched, false);
          launched = true;
          await controls.beforeLaunchReply?.();
          result = dict([[bayID, { type: "list", items: [droneID] }]]);
        } else if (method === "ItemGetInfo") {
          const stamp = {
            type: "long",
            value: String(134385165369000000n + BigInt(++sample) * 10000n),
          };
          const moduleID = Number(args[0]),
            active = firing(moduleID);
          if (controls.beforeModuleRead) await controls.beforeModuleRead(moduleID);
          const effects = [[16, [moduleID, id, shipID, null, null, [], 16, stamp, -1, 1]]];
          if (active)
            effects.push([67, [moduleID, id, shipID, active, null, [], 67, stamp, 10000, 1]]);
          if (activeAuxiliary.has(moduleID))
            effects.push([99, [moduleID, id, shipID, null, null, [], 99, stamp, 10000, 1]]);
          result = kv({
            itemID: moduleID,
            invItem: { type: "packedrow", fields: row(moduleID) },
            activeEffects: dict(effects),
            attributes: dict([
              [54, 9000],
              [158, 1000],
              [160, large ? 0.6 : 80],
              [620, 40000],
            ]),
            time: stamp,
            wallclockTime: stamp,
          });
        } else if (method === "Deactivate") {
          const module = local.find((m) => m.itemID === args[0]);
          if (module) {
            events.push("off:" + module.kind);
            activeAuxiliary.delete(module.itemID);
          } else if (propulsion && propulsion.itemID === args[0])
            await operatePropulsion(method, args);
          else {
            assert.ok(weaponIDs.includes(args[0]));
            events.push("deactivate:" + id + ":" + firing(args[0]));
            setFiring(args[0], null);
          }
        } else if (method === "CmdEngage") {
          assert.deepEqual(args[0], [droneID]);
          events.push("engage:" + id + ":" + args[1]);
          controls.onDroneOrder?.();
          if (controls.loseDroneResponse) throw Error("Drone response lost");
          droneTarget = args[1];
          result = dict([]);
        } else if (method !== "InvalidateLocationCache") throw Error(method);
        return Response.json({ ok: true, result });
      },
    };
    const session: any = {
      store: {
        station: { get: () => ({ online: { characterID: id } }) },
        space: { get: () => ({ jams: controls.scrammed ? [tackle] : [] }) },
        get targeting() {
          return controls.heldLocks || controls.lockLimit !== null
            ? {
                get: () => ({
                  lockedTargetIDs: controls.heldLocks ?? [...locked],
                  acquiringTargetIDs: [...pendingTargets],
                  loaded: true,
                }),
              }
            : undefined;
        },
        dogma: {
          get: () => ({
            allInfo:
              controls.lockLimit === null
                ? null
                : { character: { attributes: [{ attributeID: 192, value: controls.lockLimit }] } },
          }),
        },
        fitting: {
          get: () => ({
            activeShipID: shipID,
            slotsError: null,
            stats: {
              targeting: { maxTargetRange: { known: !controls.beforeLockRangeRead, value: 12000 } },
              bays: {
                droneCapacity: {
                  known: controls.droneBayCapacity !== null,
                  value: controls.droneBayCapacity,
                },
              },
            },
            chargeFits: { [typeID]: { size: large ? 3 : 1, groups: controls.ammoFit ? [9] : [] } },
            slots: [
              ...weaponIDs.map((itemID, index) => ({
                family: "high",
                index,
                module: {
                  itemID,
                  typeID,
                  online: true,
                  charge:
                    controls.ammoFit && (index === 0 || controls.reloadObserved)
                      ? { typeID: index === 0 ? controls.firstChargeType : 101, quantity: 5 }
                      : null,
                },
              })),
              ...local.map(({ family, index, itemID }) => ({
                family,
                index,
                module: { itemID, typeID, online: true, charge: null },
              })),
              ...(propulsion
                ? [
                    {
                      family: "mid",
                      index: 2,
                      module: { ...propulsion, online: true, charge: null },
                    },
                  ]
                : []),
            ],
          }),
        },
      },
      flow: {
        requestOptions: () => ({}),
        async stopShip() {
          events.push("stop:" + id);
          following.delete(id);
        },
        async approach(targetID: number, range: number) {
          events.push("move:" + id + ":" + targetID + ":" + range);
          following.set(id, targetID);
        },
        flying: {
          sessionGeneration: () => 1,
          isSessionClosing: () => false,
          readFit: async () => {
            mark("fit");
            await controls.beforeFitRead?.(id);
            return true;
          },
          fittedModuleActivation: () => "activatable",
          resolveDefenseModuleIDs: () => ({
            weapons: weaponIDs,
            shield: local.filter((m) => m.kind === "shield").map((m) => m.itemID),
            armor: local.filter((m) => m.kind === "armor").map((m) => m.itemID),
            hull: local.filter((m) => m.kind === "hull").map((m) => m.itemID),
            hardeners: local.filter((m) => m.kind === "hardener").map((m) => m.itemID),
            propulsion: propulsion ? [propulsion] : [],
          }),
          resolveRemoteRepModuleIDs: () => ({ shield: [], armor: [], hull: [], cap: [] }),
          attributesOfTypes: async (_types: number[], attrs: number[]) => {
            if (attrs.includes(552)) {
              mark("signature");
              await controls.beforeSignatureRead?.();
            }
            return {
              101: { 128: large ? 3 : 1 },
              102: { 128: large ? 3 : 1 },
              501: { 552: 40 },
              502: { 552: 300 },
              2454: { 1272: 5 },
            };
          },
          classifyDroneRoles: async (bay: readonly { itemID: number }[] | null) => ({
            bay: { combat: bay?.map((d) => d.itemID) ?? [] },
            out: { combat: droneOnGrid() ? [droneID] : [] },
          }),
          withPilotDroneCap: () => ({ maxActiveDrones: 5, droneBandwidth: 25 }),
          lockLimit: () => controls.lockLimit,
          resolveDroneControlRange: async () => {
            await controls.beforeDroneRangeRead?.();
            return 12000;
          },
          loadAmmoFrom: async (ids: number[], items: number[], source: string) => {
            assert.deepEqual([ids, items, source], [[weaponIDs[1]], [600 + id], "cargo"]);
            await controls.onReload?.(ids[0]!);
          },
          bridgeAsk: async () => {
            mark("lock-range");
            await controls.beforeLockRangeRead?.();
            return 12000;
          },
          async bridgeDo(
            _service: string,
            method: string,
            args: readonly (number | string | null)[],
          ) {
            mark(method);
            assert.equal(controls.stopping, false);
            const itemID = Number(args[0]),
              targetID = Number(args[2]);
            if (method === "CmdSetSpeedFraction") {
              assert.equal(_service, "beyonce");
              assert.deepEqual(args, [1]);
              events.push("throttle:" + id);
              throttle.set(id, itemID);
              return;
            }
            if (method === "InvalidateLocationCache") return;
            if (method === "AddTarget") {
              controls.beforeLock?.();
              if (itemID === controls.refuseLock) {
                events.push("lock-refused:" + id + ":" + itemID);
                throw Object.assign(Error("TargetingAttemptCancelled"), {
                  code: "CALL_REFUSED",
                  status: 409,
                  refusal: { key: "TargetingAttemptCancelled" },
                });
              }
              if (controls.lockLimit !== null) {
                const occupied = new Set([...locked, ...pendingTargets]);
                assert.ok(!occupied.has(itemID), "Already locked or pending");
                assert.ok(occupied.size < controls.lockLimit, "Native target cap");
              }
              if (controls.pendingLock) pendingTargets.add(itemID);
              else locked.add(itemID);
              events.push("lock:" + id + ":" + itemID);
              controls.onLock?.();
              if (controls.dropOnLock) {
                controls.dropOnLock = false;
                controls.hostiles = controls.hostiles?.filter((row) => row.id !== itemID) ?? null;
              }
              await controls.beforeLockReply?.(itemID);
              return controls.nativeLockReply
                ? [controls.pendingLock ? 1 : 0, { type: "list", items: [...locked] }]
                : [0];
            }
            if (propulsion?.itemID === itemID) {
              assert.equal(_service, "dogmaIM");
              return operatePropulsion(method, args);
            }
            const module = local.find((m) => m.itemID === itemID);
            if (module) {
              assert.equal(method, "Activate");
              assert.deepEqual(args, [module.itemID, "", null, -1]);
              events.push("on:" + module.kind);
              activeAuxiliary.add(module.itemID);
              return;
            }
            assert.equal(method, "Activate");
            assert.ok(locked.has(targetID));
            assert.equal(firing(itemID), undefined);
            if (
              targetID === controls.refuseTarget ||
              (controls.hostiles &&
                !controls.hostiles.some((row) => row.id === targetID && row.hull !== 0))
            ) {
              mark("target-not-present");
              events.push("refused:" + id + ":" + targetID);
              throw Object.assign(Error("DeniedActivateTargetNotPresent"), {
                code: "CALL_REFUSED",
                status: 409,
                refusal: { key: "DeniedActivateTargetNotPresent" },
              });
            }
            if (controls.refuseWeaponLock) {
              controls.refuseWeaponLock = false;
              throw Object.assign(Error("That target is not locked."), {
                code: "CALL_REFUSED",
                status: 409,
                refusal: {
                  key: "CustomNotify",
                  values: dict([["notify", "That target is not locked."]]),
                },
              });
            }
            events.push("fire:" + id + ":" + targetID);
            await controls.beforeWeaponReply?.(itemID);
            if (controls.loseWeaponResponse) throw Error("Weapon response lost");
            if (!controls.ackWithoutEffect) setFiring(itemID, targetID);
          },
        },
      },
    };
    const timing = writeTiming
      ? createPilotTiming(
          {
            operationID: claim.operationID,
            operationRunID: claim.runID,
            characterID: id,
            shipID,
            role: "DEFENDER",
          },
          writeTiming,
          false,
        )
      : undefined;
    const preparation = prepareHeldDefender(run, session, shipID, () => {});
    const repairMembers = [
      ...members,
      ...controls.defenderIDs.map((characterID) => ({
        characterID,
        shipID: 100 + characterID,
        role: "DEFENDER",
      })),
    ];
    const defender = createMiningDefender({
      run,
      session,
      shipID,
      target,
      claim,
      beltID: 77,
      protectedShips: [11],
      repairMembers,
      timing,
      preparation,
      escortEligible: (m) => activePeers.has(m.shipID),
      threatJams: () => (controls.noJams ? [] : [tackle]),
      fleetFocus: () =>
        [...defenders.values()]
          .filter((peer) => peer !== defender)
          .flatMap((peer) => (peer.focus() ? [peer.focus()!] : [])),
      document: (key) => ({
        read: () => docs.get(key) ?? null,
        write: (value) => {
          docs.set(key, structuredClone(value));
        },
      }),
      current() {},
      stopRequested: () => controls.stopping,
      authority: () => ({ state: "ACTIVE", target, claim }),
      wait:
        equipment.wait ??
        (async () =>
          assert.fail("Defender combat should use the next native tick instead of sleeping")),
    });
    defenders.set(id, defender);
    let prepared = false;
    const warm = async () => {
      if (prepared) return;
      prepared = true;
      preparation.refresh(decodeSpaceSnapshot(JSON.parse(JSON.stringify(nativeGrid()))));
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    return {
      ...defender,
      warm,
      rawTick: defender.tick,
      landLock(id: number) {
        pendingTargets.delete(id);
        locked.add(id);
      },
      loseLock(id: number) {
        pendingTargets.delete(id);
        locked.delete(id);
      },
      async tick() {
        await warm();
        return defender.tick();
      },
    };
  }
  return {
    pilot,
    controls,
    events,
    currentFire,
    peerPositions,
    activePeers,
    pilotPositions,
    following,
    throttle,
    docs,
    reads,
    traces,
  };
}

for (const kind of ["afterburner", "microwarpdrive"] as const) {
  test(
    `Defender manages its fitted ${kind} through the closing maneuver`,
    { timeout: 1500 },
    async () => {
      const x = escortFixture(),
        defender = x.pilot(3, false, true, false, { propulsion: kind });
      x.controls.hostiles = [{ id: 90, x: 30_000 }];
      x.controls.capacitorRatio = 0.25;
      assert.equal(await defender.tick(), "approaching");
      await defender.tick();
      assert.equal(x.events.includes("propulsion:on"), false);
      x.controls.capacitorRatio = 0.8;
      x.controls.scrammed = true;
      await defender.tick();
      assert.equal(x.events.includes("propulsion:on"), kind === "afterburner");
      x.controls.scrammed = false;
      await defender.tick();
      await defender.tick();
      assert.equal(x.events.filter((event) => event === "propulsion:on").length, 1);

      x.pilotPositions.set(3, 26_000);
      x.controls.pendingLock = true;
      let release!: () => void;
      const delayedOff = new Promise<void>((resolve) => {
        release = resolve;
      });
      x.controls.beforePropulsionReply = async (on) => {
        if (!on) await delayedOff;
      };
      try {
        await defender.tick();
        assert.ok(x.events.includes("propulsion:off"));
        assert.ok(x.events.includes("lock:3:90"));
        assert.ok(x.events.includes("engage:3:90"));
        await defender.tick();
        assert.equal(x.events.filter((event) => event === "propulsion:off").length, 1);
      } finally {
        release();
      }
    },
  );
}

test(
  "Defender Stop shuts off a cycling microwarpdrive by its native effect name",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, false, false, {
        propulsion: "microwarpdrive",
        wait: async () => {},
      });
    x.controls.hostiles = [{ id: 90, x: 30_000 }];
    assert.equal(await defender.tick(), "approaching");
    await defender.tick();
    assert.deepEqual(
      x.events.filter((event) => event.startsWith("propulsion:")),
      ["propulsion:on"],
    );
    await defender.stop(true);
    assert.deepEqual(
      x.events.filter((event) => event.startsWith("propulsion:")),
      ["propulsion:on", "propulsion:off"],
    );
  },
);

test(
  "Defender stops local repair on capacitor floor or recovered HP and keeps the hardener",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, true, false, { repair: true });
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    x.controls.hostiles = [{ id: 90, x: 2800 }];
    x.controls.shieldRatio = 0.7;
    x.controls.armorRatio = 0.85;
    x.controls.hullRatio = 0.98;
    await defender.tick();
    await flush();
    assert.deepEqual(
      x.events.filter((event) => event.startsWith("on:")),
      ["on:shield", "on:armor", "on:hull", "on:hardener"],
    );
    x.controls.capacitorRatio = 0.19;
    await defender.tick();
    await flush();
    assert.deepEqual(
      x.events.filter((event) => event.startsWith("off:")),
      ["off:shield", "off:armor", "off:hull"],
    );
    await defender.tick();
    await flush();
    assert.equal(x.events.filter((event) => event === "on:shield").length, 1);
    x.controls.capacitorRatio = 0.25;
    await defender.tick();
    await flush();
    assert.equal(x.events.filter((event) => event === "on:shield").length, 2);
    x.controls.hostiles = [];
    x.controls.shieldRatio = 0.9;
    x.controls.armorRatio = 0.9;
    x.controls.hullRatio = 0.99;
    await defender.tick();
    await flush();
    assert.deepEqual(
      x.events.filter((event) => event.startsWith("off:")),
      ["off:shield", "off:armor", "off:hull", "off:shield", "off:armor", "off:hull"],
    );
  },
);

test(
  "Defender sends AddTarget and CmdEngage while a local repair read is in flight",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, true, false, { repair: true });
    x.controls.hostiles = [{ id: 90, x: 2800 }];
    x.controls.shieldRatio = 0.7;
    let release!: () => void, started!: () => void;
    const delayedRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    x.controls.beforeModuleRead = async (id) => {
      if (id === 703) {
        started();
        await delayedRead;
      }
    };
    const turn = defender.tick();
    try {
      await pending;
      await turn;
      assert.ok(x.events.includes("lock:3:90"));
      assert.ok(x.events.includes("engage:3:90"));
      assert.equal(x.events.includes("on:shield"), false);
    } finally {
      release();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(x.events.includes("on:shield"));
  },
);

test("mixed fitted Defenders focus a tackler together while the heavy turret engages a suitable target", async () => {
  const { pilot, controls, events, currentFire } = escortFixture();
  const first = pilot(3, false),
    second = pilot(4, false),
    heavy = pilot(5, true);
  for (const defender of [first, second, heavy]) {
    assert.equal(await defender.tick(), "combat-wait");
    assert.equal(await defender.tick(), "responding");
  }
  assert.deepEqual(
    [...currentFire],
    [
      [3, 901],
      [4, 901],
      [5, 902],
    ],
  );
  assert.equal(first.focus(), 901);
  assert.equal(heavy.focus(), 902);
  const initialWrites = events.length;
  controls.largeShield = 0.85;
  await heavy.tick();
  assert.equal(events.length, initialWrites);
  controls.smallX = 17000;
  for (let i = 0; i < 5; i++) await first.tick();
  assert.ok(events.includes("deactivate:3:901"));
  assert.equal(events.filter((e) => e === "deactivate:3:901").length, 1);
  assert.equal(currentFire.get(3), 903);
  assert.equal(currentFire.get(5), 902);
  controls.stopping = true;
  const beforeStop = events.length;
  await assert.rejects(first.tick(), /stopping/);
  assert.equal(events.length, beforeStop);
});

test("Defender switches in the same pass when a lock target disappears or EveJS refuses the stale target", async () => {
  for (const failure of ["gone", "lock-refusal", "weapon-refusal"] as const) {
    const x = escortFixture(),
      defender = x.pilot(3, false);
    x.controls.hostiles = [
      { id: 901, x: 2800 },
      { id: 903, x: 5300 },
    ];
    x.controls.dropOnLock = failure === "gone";
    x.controls.refuseLock = failure === "lock-refusal" ? 901 : null;
    x.controls.refuseTarget = failure === "weapon-refusal" ? 901 : null;
    assert.equal(await defender.tick(), "combat-wait");
    assert.equal(x.currentFire.get(3), 903);
    const first =
      failure === "lock-refusal" ? ["lock-refused:3:901"] : ["lock:3:901", "refused:3:901"];
    assert.deepEqual(x.events, [...first, "lock:3:903", "fire:3:903"]);
  }
});

test("Defender selects a newly visible NPC instead of the expired backup after a native lock refusal", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [
    { id: 901, x: 2800 },
    { id: 902, x: 5300 },
  ];
  x.controls.refuseLock = 901;
  x.controls.nativeLockReply = true;
  x.controls.beforeLock = () => {
    x.controls.hostiles = [
      { id: 903, x: 4600 },
      { id: 904, x: 121_000 },
    ];
  };

  await defender.tick();
  assert.deepEqual(x.events, ["lock-refused:3:901", "lock:3:903", "fire:3:903"]);
  assert.equal(x.reads.targets, 0);
});

test("Defender does not let an earlier lock confirmation hold up targeting on a new grid", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [
    { id: 901, x: 2800 },
    { id: 902, x: 5300 },
  ];
  x.controls.pendingLock = true;
  let unblock!: () => void;
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  x.controls.beforeLockRead = () => wait;
  try {
    assert.equal(await defender.tick(), "waiting-lock");
    assert.equal(x.reads.targets, 0);
    await defender.tick();
    assert.equal(x.reads.targets, 1);
    x.controls.hostiles = [{ id: 903, x: 4600 }];
    x.controls.pendingLock = false;
    await defender.tick();
    assert.deepEqual(x.events, ["lock:3:901", "lock:3:903", "fire:3:903"]);
  } finally {
    unblock();
  }
});

test("Defender uses a pushed lock during a delayed targets read and switches off a destroyed NPC in one pass", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [
    { id: 901, x: 2800 },
    { id: 902, x: 4600 },
    { id: 903, x: 5600 },
  ];
  x.controls.heldLocks = [];
  x.controls.pendingLock = true;
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  x.controls.beforeLockRead = () => delayed;
  try {
    await defender.tick();
    assert.ok(x.events.includes("lock:3:901"));
    assert.ok(x.events.includes("engage:3:901"));
    t.mock.timers.tick(1500);
    await defender.tick();
    assert.equal(x.reads.targets, 1);
    defender.landLock(901);
    x.controls.heldLocks = [901];
    t.mock.timers.tick(100);
    const heldAt = performance.now();
    await defender.tick();
    assert.ok(x.events.includes("fire:3:901"));
    const trace = x.traces.get(3)!;
    const since = (action: string, from: number) =>
      (trace.filter((row) => row.action === action).at(-1)!.at - from).toFixed(2);
    const fired = since("Activate", heldAt);

    x.controls.hostiles[0]!.hull = 0;
    x.controls.heldLocks = [];
    x.controls.pendingLock = false;
    t.mock.timers.tick(100);
    const destroyed = performance.now();
    await defender.tick();
    assert.ok(x.events.includes("lock:3:902"));
    assert.ok(x.events.includes("engage:3:902"));
    assert.equal(x.events.filter((event) => event === "lock:3:901").length, 1);
    t.diagnostic(
      `Pushed lock → Activate ${fired} ms during blocked GetTargets, switch AddTarget +${since("AddTarget", destroyed)} ms / CmdEngage +${since("CmdEngage", destroyed)} ms from observed destruction`,
    );
  } finally {
    release();
  }
});

test("Defender holds up to two secondary targets and switches to a preconfirmed lock on the first new grid", async (t) => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  x.controls.lockLimit = 5;
  x.controls.pendingLock = true;
  x.controls.hostiles = [
    { id: 901, x: 3000 },
    { id: 902, x: 3500 },
    { id: 903, x: 4000 },
    { id: 904, x: 4500 },
  ];
  await defender.tick();
  await flush();
  assert.deepEqual(
    x.events.filter((event) => event.startsWith("lock:")),
    ["lock:3:901", "lock:3:902"],
  );
  assert.ok(x.events.indexOf("engage:3:901") < x.events.indexOf("lock:3:902"));
  await defender.tick();
  await flush();
  assert.deepEqual(
    x.events.filter((event) => event.startsWith("lock:")),
    ["lock:3:901", "lock:3:902", "lock:3:903"],
  );
  assert.equal(
    x.events.some((event) => event.startsWith("fire:")),
    false,
  );

  for (const id of [901, 902, 903]) defender.landLock(id);
  await defender.tick();
  await flush();
  assert.ok(x.events.includes("fire:3:901"));
  assert.equal(
    x.events.includes("lock:3:904"),
    false,
    "Never hold more than the selected target and two backups",
  );

  const trace = x.traces.get(3)!;
  trace.length = 0;
  const eventIndex = x.events.length;
  x.controls.hostiles[0]!.hull = 0;
  defender.loseLock(901);
  x.currentFire.clear(); // EveJS has already ended the destroyed target's weapon effect.
  await defender.tick();
  await flush();
  const since = (action: string) =>
    trace.find((row) => row.action === action)!.at -
    trace.find((row) => row.action === "snapshot")!.at;
  assert.ok(x.events.slice(eventIndex).includes("engage:3:902"));
  assert.ok(x.events.slice(eventIndex).includes("fire:3:902"));
  assert.equal(x.events.filter((event) => event === "lock:3:902").length, 1);
  assert.equal(x.events.filter((event) => event === "lock:3:901").length, 1);
  assert.equal(trace.filter((row) => row.action === "snapshot").length, 1);
  assert.ok(
    trace.findIndex((row) => row.action === "Activate") <
      trace.findIndex((row) => row.action === "AddTarget"),
  );
  t.diagnostic(
    `First new grid after destruction → CmdEngage +${since("CmdEngage").toFixed(2)} ms / Activate +${since("Activate").toFixed(2)} ms`,
  );
});

test("Defender counts the native roster and pending locks, and does not reacquire a dead pending NPC", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  x.controls.lockLimit = 2;
  x.controls.pendingLock = true;
  x.controls.hostiles = [
    { id: 901, x: 3000 },
    { id: 902, x: 3500 },
    { id: 903, x: 4000 },
    { id: 904, x: 16000 },
  ];
  defender.landLock(77); // An existing native lock consumes one of the pilot's two slots.
  await defender.tick();
  await flush();
  assert.deepEqual(
    x.events.filter((event) => event.startsWith("lock:")),
    ["lock:3:901"],
  );

  defender.loseLock(77);
  await defender.tick();
  await flush();
  assert.deepEqual(
    x.events.filter((event) => event.startsWith("lock:")),
    ["lock:3:901", "lock:3:902"],
  );
  x.controls.hostiles[1]!.hull = 0;
  defender.loseLock(902);
  await defender.tick();
  await flush();
  assert.deepEqual(
    x.events.filter((event) => event.startsWith("lock:")),
    ["lock:3:901", "lock:3:902", "lock:3:903"],
  );

  defender.loseLock(903);
  x.controls.hostiles[2]!.hull = 0;
  await defender.tick();
  await flush();
  assert.equal(
    x.events.some((event) => event.endsWith(":904")),
    false,
    "Sensor range still applies to spare targets",
  );
  assert.equal(
    x.events.some((event) => event.startsWith("fire:")),
    false,
  );
  assert.ok(x.events.includes("engage:3:901"));
});

test("a slow secondary AddTarget response does not hold fire or CmdEngage on the primary", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.lockLimit = 5;
  x.controls.pendingLock = true;
  x.controls.hostiles = [
    { id: 901, x: 3000 },
    { id: 902, x: 3500 },
  ];
  let started!: () => void, release!: () => void;
  const sent = new Promise<void>((resolve) => {
      started = resolve;
    }),
    reply = new Promise<void>((resolve) => {
      release = resolve;
    });
  x.controls.beforeLockReply = async (id) => {
    if (id === 902) {
      started();
      await reply;
    }
  };
  try {
    await defender.tick();
    await sent;
    assert.ok(x.events.includes("engage:3:901"));
    defender.landLock(901);
    await defender.tick();
    assert.ok(x.events.includes("fire:3:901"));
  } finally {
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test("the four Defenders spread equal light NPCs and focus on a single or disabling threat", async () => {
  for (const scenario of ["one", "light", "tackler"] as const) {
    const x = escortFixture(),
      ids = [3, 4, 5, 6];
    x.controls.defenderIDs = ids;
    x.controls.noJams = scenario !== "tackler";
    x.controls.hostiles = (scenario === "one" ? [901] : [901, 902, 903, 904]).map((id) => ({
      id,
      x: 3200,
    }));
    const defenders = ids.map((id) => x.pilot(id, false, true));
    await Promise.all(defenders.map((defender) => defender.tick()));
    const targets = ids.map((id) =>
      Number(x.events.find((value) => value.startsWith(`engage:${id}:`))!.split(":")[2]),
    );
    assert.deepEqual(targets, scenario === "light" ? [901, 902, 903, 904] : [901, 901, 901, 901]);
  }
});

test("Defender takes the next hostile after a clear grid without waiting for an earlier fitting read", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  x.controls.nativeLockReply = true;
  let finishFitting!: () => void;
  const fitting = new Promise<void>((resolve) => {
    finishFitting = resolve;
  });
  x.controls.beforeFitRead = () => fitting;
  await defender.tick();
  assert.ok(x.events.includes("lock:3:901"));

  x.controls.hostiles = [];
  assert.equal(await defender.tick(), "checking-grid");
  const regroup = defender.tick();
  try {
    assert.equal(
      await Promise.race([
        regroup,
        new Promise((resolve) => setImmediate(() => resolve("pending"))),
      ]),
      "watching",
    );
    x.controls.hostiles = [{ id: 903, x: 4600 }];
    await defender.tick();
    assert.ok(x.events.includes("lock:3:903"));
    assert.ok(x.events.includes("engage:3:903"));
  } finally {
    finishFitting();
    await regroup;
  }
});

test("an unreadable weapon-effect summary leaves the next Defender pass free to find a new NPC", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [
    { id: 901, x: 2800 },
    { id: 902, x: 5300 },
  ];
  x.controls.nativeLockReply = true;
  await defender.tick();
  assert.equal(await defender.tick(), "responding");
  const trace = x.traces.get(3)!;
  trace.length = 0;
  x.controls.weaponTargetsAvailable = false;

  const phase = await defender.tick();
  assert.equal(trace.filter((call) => call.action === "ItemGetInfo").length, 0);
  assert.equal(phase, "combat-wait");

  x.controls.hostiles.shift();
  x.currentFire.clear();
  await defender.tick();
  assert.deepEqual(x.events, ["lock:3:901", "fire:3:901", "lock:3:902", "fire:3:902"]);
});

test("Defender sends the drone order while weapon effect is pending and reuses the gun after the target disappears", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  x.controls.ackWithoutEffect = true;
  assert.equal(await defender.tick(), "combat-wait");
  assert.deepEqual(x.events.slice().sort(), ["engage:3:901", "fire:3:901", "lock:3:901"]);
  x.controls.hostiles = [{ id: 903, x: 5300 }];
  x.controls.ackWithoutEffect = false;
  assert.equal(await defender.tick(), "combat-wait");
  assert.deepEqual(x.events.slice(3).sort(), ["engage:3:903", "fire:3:903", "lock:3:903"]);
  const statuses = () => {
    const actions = [...x.docs].find(([key]) =>
      key.startsWith("mining-fleet-defender-actions:"),
    )?.[1] as { entries: { status: string }[] };
    return actions.entries.map((e) => e.status);
  };
  assert.deepEqual(statuses(), ["SETTLED_INACTIVE", "ACKNOWLEDGED"]);
  assert.equal(await defender.tick(), "responding");
  assert.deepEqual(statuses(), ["SETTLED_INACTIVE", "CONFIRMED"]);
});

test("Defender retargets a live NPC when the chased NPC is destroyed but still in the grid snapshot", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [{ id: 901, x: 18000 }];
  assert.equal(await defender.tick(), "approaching");
  assert.equal(x.following.get(3), 901);
  x.controls.hostiles = [
    { id: 901, x: 18000, hull: 0 },
    { id: 903, x: 5300 },
  ];
  assert.equal(await defender.tick(), "combat-wait");
  assert.equal(x.events[1], "stop:3");
  assert.deepEqual(x.events.slice(2).sort(), ["engage:3:903", "fire:3:903", "lock:3:903"]);
});

test("four Defenders engage three successive NPCs in the first tick that sees each target", async (t) => {
  const x = escortFixture(),
    ids = [3, 4, 5, 6];
  const defenders = ids.map((id) => x.pilot(id, false, true));
  x.controls.nativeLockReply = true;
  await Promise.all(defenders.map((d) => d.warm()));
  const targets = [901, 903, 904];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    x.controls.hostiles = [
      { id: target, x: 3500 },
      ...targets.slice(i + 1).map((id) => ({ id, x: 6500 })),
    ];
    x.currentFire.clear(); // Native Dogma has ended the previous effects.
    for (const trace of x.traces.values()) trace.length = 0;
    const start = performance.now(),
      writes = x.events.length;
    assert.deepEqual(
      await Promise.all(defenders.map((d) => d.tick())),
      ids.map(() => "combat-wait"),
    );
    let gunMs = 0,
      droneMs = 0;
    for (const id of ids) {
      const trace = x.traces.get(id)!;
      const detected = trace[0]!;
      assert.equal(detected.action, "snapshot");
      const gun = trace.find((call) => call.action === "Activate")!,
        drone = trace.find((call) => call.action === "CmdEngage")!;
      gunMs = Math.max(gunMs, gun.at - (i === 0 ? detected.at : start));
      droneMs = Math.max(droneMs, drone.at - (i === 0 ? detected.at : start));
      assert.equal(x.currentFire.get(id), target);
      for (const action of ["AddTarget", "Activate", "CmdEngage"]) {
        assert.equal(trace.filter((call) => call.action === action).length, 1);
      }
      assert.equal(trace.filter((call) => call.action === "ItemGetInfo").length, 0);
      assert.equal(
        trace.some((call) => call.action === "List" || call.action === "InvalidateLocationCache"),
        false,
      );
      assert.equal(
        trace.some((call) => call.action === "fit" || call.action === "targets"),
        false,
      );
      assert.equal(
        trace.some((call) => call.action === "lock-range"),
        false,
      );
    }
    assert.equal(x.events.length - writes, 12);
    t.diagnostic(
      `${i === 0 ? "detection" : "kill"} → gun ${gunMs.toFixed(1)} ms, drones ${droneMs.toFixed(1)} ms (max of four, mocked transport)`,
    );
    const lockReads = x.reads.targets;
    assert.deepEqual(
      await Promise.all(defenders.map((d) => d.tick())),
      ids.map(() => "responding"),
    );
    assert.equal(x.events.length - writes, 12);
    assert.equal(x.reads.targets, lockReads);
  }
});

test(
  "Defender fires during a delayed drone launch and orders the drones as soon as the grid shows them",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, true);
    x.controls.dronesInBay = true;
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    let releaseLaunch!: () => void, launchSent!: () => void, weaponSent!: () => void;
    const launchResponse = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const launchDispatch = new Promise<void>((resolve) => {
      launchSent = resolve;
    });
    const weaponDispatch = new Promise<void>((resolve) => {
      weaponSent = resolve;
    });
    x.controls.beforeLaunchReply = async () => {
      launchSent();
      await launchResponse;
    };
    x.controls.beforeWeaponReply = async () => {
      weaponSent();
    };
    const attack = defender.tick();
    try {
      await Promise.all([launchDispatch, weaponDispatch]);
      assert.deepEqual(x.events, ["lock:3:901", "fire:3:901"]);
    } finally {
      releaseLaunch();
    }
    assert.equal(await attack, "combat-wait");
    await defender.tick();
    assert.equal(x.traces.get(3)!.filter((call) => call.action === "LaunchDrones").length, 1);
    x.controls.showLaunchedDrones = true;
    await defender.tick();
    assert.deepEqual(x.events, ["lock:3:901", "fire:3:901", "engage:3:901"]);
  },
);

test(
  "Defender launches at three passive NPCs using effective Dogma while the drone panel and fitting are blocked",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, true);
    x.controls.dronesInBay = true;
    x.controls.hostiles = [
      { id: 901, x: 2800 },
      { id: 902, x: 3200 },
      { id: 903, x: 4000 },
    ];
    let releaseReads!: () => void, launchSent!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const launch = new Promise<true>((resolve) => {
      launchSent = () => resolve(true);
    });
    x.controls.beforeFitRead = () => blocked;
    x.controls.beforeDronePanelRead = () => blocked;
    x.controls.beforeLaunchReply = async () => {
      launchSent();
    };
    const turn = defender.tick();
    try {
      assert.equal(
        await Promise.race([
          launch,
          new Promise<false>((resolve) => setImmediate(() => resolve(false))),
        ]),
        true,
      );
      assert.equal(
        x.traces.get(3)!.some((call) => call.action === "drone-panel"),
        false,
      );
    } finally {
      releaseReads();
      await turn;
    }
    x.controls.showLaunchedDrones = true;
    await defender.tick();
    assert.ok(x.events.includes("engage:3:901"));
    assert.equal(x.traces.get(3)!.filter((call) => call.action === "LaunchDrones").length, 1);
  },
);

test(
  "Defender orders newly launched drones at three NPCs before reading back the pending lock",
  { timeout: 1500 },
  async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const x = escortFixture(),
      defender = x.pilot(3, false, true);
    x.controls.dronesInBay = true;
    x.controls.showLaunchedDrones = true;
    x.controls.hostiles = [
      { id: 901, x: 2800 },
      { id: 902, x: 3200 },
      { id: 903, x: 4000 },
    ];
    x.controls.nativeLockReply = true;
    x.controls.pendingLock = true;
    let releaseFit!: () => void, releaseLock!: () => void, releaseLaunch!: () => void;
    const fit = new Promise<void>((resolve) => {
      releaseFit = resolve;
    });
    const lock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const launch = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    x.controls.beforeFitRead = () => fit;
    x.controls.beforeLockRead = () => lock;
    x.controls.beforeLaunchReply = () => launch;
    const startedAt = Date.now(),
      orders: number[] = [];
    let lockAt: number | undefined;
    x.controls.onLock = () => {
      lockAt = Date.now() - startedAt;
    };
    x.controls.onDroneOrder = () => orders.push(Date.now() - startedAt);
    const turn = defender.tick();
    let beforeLock: number[] = [];
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.ok(x.traces.get(3)!.some((call) => call.action === "LaunchDrones"));
      assert.deepEqual(orders, []);
      t.mock.timers.tick(1500);
      releaseLaunch();
      await new Promise<void>((resolve) => setImmediate(resolve));
      beforeLock = [...orders];
      assert.equal(lockAt, 0);
      assert.equal(x.reads.targets, 0);
    } finally {
      t.mock.timers.tick(20000);
      releaseLaunch();
      releaseLock();
      releaseFit();
      await turn;
    }
    await defender.tick();
    t.diagnostic(
      `LaunchDrones acknowledged at +1500 ms, AddTarget at +${lockAt} ms, CmdEngage at +${orders[0]} ms`,
    );
    assert.deepEqual(beforeLock, [1500]);
    assert.deepEqual(orders, [1500]);
    assert.equal(lockAt, 0);
    assert.equal(x.traces.get(3)!.filter((call) => call.action === "LaunchDrones").length, 1);
    assert.ok(x.events.includes("engage:3:901"));
  },
);

test("Defender checks the target's range again after launching combat drones", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.dronesInBay = true;
  x.controls.showLaunchedDrones = true;
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  x.controls.beforeLaunchReply = async () => {
    x.controls.hostiles = [{ id: 901, x: 13000 }];
  };

  await defender.tick();
  assert.ok(x.traces.get(3)!.some((call) => call.action === "LaunchDrones"));
  assert.equal(
    x.traces.get(3)!.some((call) => call.action === "CmdEngage"),
    false,
  );

  x.controls.hostiles = [{ id: 901, x: 2800 }];
  await defender.tick();
  assert.equal(x.traces.get(3)!.filter((call) => call.action === "LaunchDrones").length, 1);
  assert.deepEqual(
    x.events.filter((event) => event.startsWith("engage:")),
    ["engage:3:901"],
  );
});

test("prepared Defender dispatches AddTarget and CmdEngage while redundant native reads are stalled", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [];
  await defender.warm?.();
  x.controls.hostiles = [
    { id: 901, x: 2800 },
    { id: 902, x: 3200 },
    { id: 903, x: 4000 },
  ];
  x.controls.nativeLockReply = true;
  x.controls.pendingLock = true;
  const start = Date.now(),
    readsBefore = x.traces.get(3)!.length;
  t.mock.method(performance, "now", () => Date.now() - start);
  let releaseLock!: () => void, releaseDrone!: () => void, releaseFit!: () => void;
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const drone = new Promise<void>((resolve) => {
    releaseDrone = resolve;
  });
  const fit = new Promise<void>((resolve) => {
    releaseFit = resolve;
  });
  x.controls.beforeLockRead = () => lock;
  x.controls.beforeDroneRangeRead = () => drone;
  x.controls.beforeFitRead = () => fit;
  x.controls.beforeModuleRead = () => fit;
  let addAt: number | undefined, engageAt: number | undefined;
  x.controls.onLock = () => {
    addAt ??= Date.now() - start;
  };
  x.controls.onDroneOrder = () => {
    engageAt ??= Date.now() - start;
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const first = defender.tick();
  let gridActions: string[] = [];
  try {
    await flush();
    gridActions = x.traces
      .get(3)!
      .slice(readsBefore)
      .map((row) => row.action);
    t.mock.timers.tick(6000);
    releaseLock();
    await flush();
    t.mock.timers.tick(2000);
    releaseDrone();
    await flush();
    await first;
    await defender.tick();
  } finally {
    releaseLock();
    releaseDrone();
    releaseFit();
    await first;
  }
  t.diagnostic(
    `First AddTarget +${addAt} ms, first CmdEngage +${engageAt} ms, mocked delays 6000/8000 ms`,
  );
  assert.deepEqual([addAt, engageAt], [0, 0]);
  const lastOrder = Math.max(
    gridActions.lastIndexOf("AddTarget"),
    gridActions.lastIndexOf("CmdEngage"),
  );
  assert.deepEqual(gridActions.slice(0, lastOrder + 1).sort(), [
    "AddTarget",
    "CmdEngage",
    "snapshot",
  ]);
  assert.deepEqual(x.events.slice().sort(), ["engage:3:901", "lock:3:901"]);
});

test("Defender refreshes the gun whose charge changed and keeps the other prepared data", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true, true);
  x.controls.ammoFit = true;
  x.controls.reloadObserved = true;
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  const observations: number[] = [];
  x.controls.beforeModuleRead = async (id) => {
    observations.push(id);
  };

  await defender.warm();
  assert.deepEqual(
    observations.slice().sort((a, b) => a - b),
    [203, 1203],
  );
  observations.length = 0;
  const trace = x.traces.get(3)!;
  trace.length = 0;
  await defender.tick();
  assert.deepEqual(observations, []);

  x.controls.firstChargeType = 102;
  x.controls.hostiles = [{ id: 903, x: 4200 }];
  x.currentFire.clear();
  await defender.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await defender.tick();

  assert.deepEqual(observations, [203]);
  assert.equal(
    trace.some((row) =>
      ["fit", "List", "QueryAllAttributesForItem", "lock-range"].includes(row.action),
    ),
    false,
  );
  assert.equal(x.events.filter((event) => event === "engage:3:903").length, 1);
  assert.equal(x.events.filter((event) => event === "fire:3:903").length, 2);
});

test("essential Defender timing follows individual NPCs and reports native command calls and replies once", async () => {
  const timing: Record<string, unknown>[] = [];
  const x = escortFixture((line) => timing.push(JSON.parse(line.slice("[mcc-timing] ".length)))),
    defender = x.pilot(3, false, true);
  const events = (name: string, id = 901) =>
    timing.filter((row) => row.event === name && row.targetID === id);
  x.controls.hostiles = [
    { id: 901, x: 2800 },
    { id: 902, x: 121000 },
  ];
  x.controls.dronesInBay = true;
  x.controls.nativeLockReply = true;
  x.controls.pendingLock = true;
  x.controls.beforeLock = () => {
    assert.equal(events("defender-lock-call").length, 1);
    assert.equal(events("command-timing").length, 0);
  };
  x.controls.beforeLaunchReply = async () => {
    assert.equal(events("defender-drone-launch-call").length, 1);
    assert.equal(events("defender-drone-launch-rpc").length, 0);
  };
  x.controls.onDroneOrder = () => {
    assert.equal(events("defender-cmd-engage-call").length, 1);
    assert.equal(events("defender-cmd-engage-rpc").length, 0);
  };
  x.controls.beforeWeaponReply = async () => {
    assert.equal(events("defender-activate-call").length, 1);
    assert.equal(events("defender-activate-rpc").length, 0);
  };

  await defender.tick();
  assert.equal(events("command-timing")[0]?.nativeLockPending, true);
  assert.equal(events("defender-lock-confirmed").length, 0);
  x.controls.showLaunchedDrones = true;
  await defender.tick();
  assert.equal(events("defender-cmd-engage-rpc")[0]?.outcome, "returned");
  assert.equal(events("defender-lock-confirmed").length, 0);
  x.controls.pendingLock = false;
  await defender.tick();
  await defender.tick();

  const names = [
    "defender-npc-observed",
    "defender-npc-eligible",
    "defender-target-selected",
    "defender-lock-call",
    "command-timing",
    "defender-lock-confirmed",
    "defender-drone-launch-call",
    "defender-drone-launch-rpc",
    "defender-cmd-engage-call",
    "defender-cmd-engage-rpc",
    "defender-activate-call",
    "defender-activate-rpc",
  ];
  for (const name of names) {
    const rows = events(name);
    assert.equal(rows.length, 1, name);
    assert.equal(rows[0]!.characterID, 3);
    assert.equal(rows[0]!.shipID, 103);
    assert.ok(Number.isFinite(Date.parse(String(rows[0]!.at))), name);
  }
  const order = (name: string) => timing.indexOf(events(name)[0]!);
  assert.ok(order("defender-npc-observed") < order("defender-npc-eligible"));
  assert.ok(order("defender-npc-eligible") < order("defender-target-selected"));
  assert.ok(order("defender-target-selected") < order("defender-lock-call"));
  assert.ok(order("defender-lock-call") < order("command-timing"));
  assert.ok(order("command-timing") < order("defender-lock-confirmed"));
  assert.ok(order("defender-lock-confirmed") < order("defender-activate-call"));
  assert.equal(events("defender-activate-rpc")[0]?.outcome, "returned");
  assert.equal(events("defender-npc-observed", 902).length, 1);
  assert.equal(events("defender-npc-eligible", 902).length, 0);
});

test("Defender weapon timing separates range and lock waits without repeating unchanged decisions", async () => {
  const timing: Record<string, unknown>[] = [];
  const x = escortFixture((line) => timing.push(JSON.parse(line.slice("[mcc-timing] ".length)))),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [{ id: 901, x: 11000 }];
  x.controls.pendingLock = true;
  x.controls.nativeLockReply = true;
  const decisions = (reason: string) =>
    timing.filter((row) => row.event === "defender-target-preparation" && row.reason === reason);
  await defender.tick();
  await defender.tick();
  assert.equal(decisions("outside-weapon-range").length, 1);
  assert.equal(decisions("outside-weapon-range")[0]?.meters, 10955);
  assert.equal(decisions("outside-weapon-range")[0]?.weaponRangeM, 10000);
  assert.equal(decisions("outside-weapon-range")[0]?.lockConfirmed, false);
  assert.ok(x.events.includes("engage:3:901"));
  assert.ok(!x.events.includes("fire:3:901"));

  x.controls.hostiles = [{ id: 901, x: 9000 }];
  await defender.tick();
  await defender.tick();
  assert.equal(decisions("lock-not-confirmed").length, 1);
  assert.equal(decisions("lock-not-confirmed")[0]?.meters, 8955);
  assert.equal(decisions("lock-not-confirmed")[0]?.lockConfirmed, false);
  assert.ok(!x.events.includes("fire:3:901"));

  x.controls.pendingLock = false;
  await defender.tick();
  await defender.tick();
  assert.equal(decisions("lock-and-range-ready")[0]?.lockConfirmed, true);
  assert.equal(x.events.filter((row) => row === "fire:3:901").length, 1);
});

test(
  "Defender uses the confirmed native lock and one shared firing grid while weapon and drone orders run concurrently",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, true);
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    x.controls.nativeLockReply = true;
    let releaseWeapon!: () => void, weaponSent!: () => void, droneSent!: () => void;
    const weaponResponse = new Promise<void>((resolve) => {
      releaseWeapon = resolve;
    });
    const weaponDispatch = new Promise<void>((resolve) => {
      weaponSent = resolve;
    });
    const droneDispatch = new Promise<void>((resolve) => {
      droneSent = resolve;
    });
    x.controls.beforeWeaponReply = async () => {
      weaponSent();
      await weaponResponse;
    };
    x.controls.onDroneOrder = droneSent;
    const attack = defender.tick();
    try {
      await Promise.all([weaponDispatch, droneDispatch]);
      assert.equal(x.currentFire.size, 0);
      assert.equal(x.reads.targets, 0);
      await assert.rejects(defender.tick(), /already in flight/);
    } finally {
      releaseWeapon();
    }
    assert.equal(await attack, "combat-wait");
    assert.equal(x.reads.grid, 1); // one grid for selection and both commands
    assert.equal(await defender.tick(), "responding");
    assert.equal(x.reads.grid, 2); // the next ordinary observation confirms the order
  },
);

test(
  "Defender sends both fitted guns' activations without waiting for the first reply",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, false, true);
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    x.controls.nativeLockReply = true;
    const sent: number[] = [];
    let release!: () => void, bothSent!: () => void;
    const reply = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatches = new Promise<void>((resolve) => {
      bothSent = resolve;
    });
    x.controls.beforeWeaponReply = async (id) => {
      sent.push(id);
      if (sent.length === 2) bothSent();
      if (id === 203) await reply;
    };
    const attack = defender.tick();
    try {
      await dispatches;
      assert.deepEqual(
        sent.slice().sort((a, b) => a - b),
        [203, 1203],
      );
      assert.equal(x.currentFire.has(3), false);
      assert.equal(x.reads.targets, 0);
    } finally {
      release();
    }
    assert.equal(await attack, "combat-wait");
    assert.equal(await defender.tick(), "responding");
    assert.equal(sent.length, 2);
  },
);

test(
  "Defender fires a ready gun before an empty gun's reload is confirmed",
  { timeout: 2500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, false, true),
      activations: number[] = [];
    x.controls.ammoFit = true;
    x.controls.nativeLockReply = true;
    let releaseFit = () => {},
      reloadIssued = () => {},
      reloads = 0;
    const fitGate = new Promise<void>((resolve) => {
      releaseFit = resolve;
    });
    const issued = new Promise<void>((resolve) => {
      reloadIssued = resolve;
    });
    x.controls.onReload = () => {
      reloads++;
      reloadIssued();
    };
    x.controls.beforeFitRead = async () => {
      if (reloads && !x.controls.reloadObserved) await fitGate;
    };
    x.controls.beforeWeaponReply = async (moduleID) => {
      activations.push(moduleID);
    };
    const first = defender.tick();
    try {
      await issued;
      for (let attempt = 0; attempt < 6 && !activations.length; attempt++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      const fittingReads = x.traces.get(3)?.filter((record) => record.action === "fit").length;
      assert.deepEqual(
        { activations: [...activations], fittingReads },
        { activations: [203], fittingReads: 1 },
      );
      const record = [...x.docs.entries()].find(([key]) => key.includes("reloads"))?.[1] as any;
      assert.ok(["DISPATCHED", "ACKNOWLEDGED"].includes(record?.rows?.[0]?.status));
    } finally {
      x.controls.reloadObserved = true;
      releaseFit();
      await first;
    }
    await defender.tick();
    await defender.tick();
    assert.deepEqual(
      [...new Set(activations)].sort((a, b) => a - b),
      [203, 1203],
    );
    assert.equal(reloads, 1);
    const record = [...x.docs.entries()].find(([key]) => key.includes("reloads"))?.[1] as any;
    assert.equal(record?.rows?.[0]?.status, "CONFIRMED");
  },
);

test("unknown reload stays scoped to its empty gun while the ready gun and drones keep attacking", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true, true),
    activations: number[] = [];
  let reloads = 0;
  x.controls.ammoFit = true;
  x.controls.nativeLockReply = true;
  x.controls.onReload = async () => {
    reloads++;
    throw Error("Reload response lost");
  };
  x.controls.beforeWeaponReply = async (moduleID) => {
    activations.push(moduleID);
  };
  for (let step = 0; step < 4; step++) {
    await defender.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(activations.length);
  assert.deepEqual([...new Set(activations)], [203]);
  assert.ok(x.events.some((event) => event.startsWith("engage:3:")));
  assert.equal(reloads, 1);
  const record = [...x.docs.entries()].find(([key]) => key.includes("reloads"))?.[1] as any;
  assert.equal(record?.rows?.[0]?.status, "DISPATCHED");
});

test("a pending native lock delays the gun while Defender drones engage in the same pass", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  x.controls.nativeLockReply = true;
  x.controls.pendingLock = true;
  assert.equal(await defender.tick(), "waiting-lock");
  assert.deepEqual(x.events.slice().sort(), ["engage:3:901", "lock:3:901"]);
  assert.equal(x.reads.targets, 0);
  x.controls.pendingLock = false;
  await defender.tick(); // read back the pending native acquisition
  assert.equal(await defender.tick(), "responding");
  assert.equal(x.reads.targets, 1);
  assert.deepEqual(x.events.slice().sort(), ["engage:3:901", "fire:3:901", "lock:3:901"]);
});

test(
  "controlled Defender drones attack before a blocked fitting read finishes",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, true),
      peer = x.pilot(4, false, true);
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    let release!: () => void, entered!: () => void, engaged!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reading = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      order = new Promise<void>((resolve) => {
        engaged = resolve;
      });
    x.controls.beforeFitRead = async (id) => {
      if (id === 3) {
        entered();
        await gate;
      }
    };
    x.controls.onDroneOrder = engaged;
    const first = defender.tick();
    try {
      await Promise.all([reading, order]);
      assert.equal(await first, "waiting-lock");
      assert.equal(x.currentFire.has(3), false);
      assert.equal(await peer.tick(), "combat-wait");
    } finally {
      release();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await defender.tick();
    assert.equal(x.currentFire.get(3), 901);
    assert.equal(x.events.filter((e) => e === "engage:3:901").length, 1);
  },
);

test(
  "a Defender with one qualified target locks while a weapon read is stalled",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, true);
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    let release!: () => void, locked!: () => void, enter!: () => void;
    const slow = new Promise<void>((resolve) => {
        release = resolve;
      }),
      sent = new Promise<void>((resolve) => {
        locked = resolve;
      }),
      reading = new Promise<void>((resolve) => {
        enter = resolve;
      });
    x.controls.beforeModuleRead = async () => {
      enter();
      await slow;
    };
    x.controls.onLock = locked;
    const turn = defender.tick();
    try {
      await Promise.all([reading, sent]);
      assert.ok(x.events.includes("lock:3:901"));
      assert.equal(x.currentFire.has(3), false);
    } finally {
      release();
    }
    await turn;
    await defender.tick();
    assert.equal(x.currentFire.get(3), 901);
    assert.equal(x.events.filter((e) => e === "lock:3:901").length, 1);
  },
);

test(
  "a completed early lock releases the pass while the optional fitting read is still pending",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false);
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    x.controls.nativeLockReply = true;
    let finishFitting!: () => void;
    const fitting = new Promise<void>((resolve) => {
      finishFitting = resolve;
    });
    x.controls.beforeFitRead = () => fitting;
    const turn = defender.tick();
    try {
      const result = await Promise.race([
        turn,
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      assert.equal(result, "waiting-lock");
      assert.deepEqual(x.events, ["lock:3:901"]);
    } finally {
      finishFitting();
      await turn;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await defender.tick();
    assert.deepEqual(x.events, ["lock:3:901", "fire:3:901"]);
  },
);

test(
  "a known sensor range starts a single NPC lock while both capability reads are pending",
  { timeout: 1500 },
  async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const x = escortFixture(),
      defender = x.pilot(3, false);
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    x.controls.nativeLockReply = true;
    x.controls.pendingLock = true;
    let releaseReads!: () => void;
    const reads = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    x.controls.beforeFitRead = () => reads;
    x.controls.beforeDroneBayRead = () => reads;
    const startedAt = Date.now();
    let sentAt: number | undefined;
    x.controls.onLock = () => {
      sentAt = Date.now();
    };
    const turn = defender.tick();
    let beforeReadback: Awaited<typeof turn> | "pending";
    try {
      beforeReadback = await Promise.race([
        turn,
        new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
      ]);
      t.mock.timers.tick(6000);
    } finally {
      releaseReads();
      await turn;
    }
    assert.equal((sentAt ?? 0) - startedAt, 0);
    assert.equal(beforeReadback, "waiting-lock");
    assert.deepEqual(x.events, ["lock:3:901"]);
    assert.equal(x.reads.targets, 0);
    x.controls.pendingLock = false;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await defender.tick();
    await defender.tick();
    assert.deepEqual(x.events, ["lock:3:901", "fire:3:901"]);
  },
);

for (const [scenario, control, tacklerX, expectedTarget] of [
  ["fitting is pending", "beforeFitRead", 7200, 901],
  ["weapon Dogma is pending", "beforeModuleRead", 7200, 901],
  ["the tackler is outside sensor range", "beforeFitRead", 20000, 903],
] as const) {
  test(
    `Defender locks the highest ranked reachable NPC in a three-target grid when ${scenario}`,
    { timeout: 1500 },
    async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      const x = escortFixture(),
        defender = x.pilot(3, false);
      x.controls.hostiles = [
        { id: 903, x: 2800 },
        { id: 902, x: 5300 },
        { id: 901, x: tacklerX },
        { id: 904, x: 121000 },
      ];
      x.controls.nativeLockReply = true;
      x.controls.pendingLock = true;
      let releaseReads!: () => void;
      const reads = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      x.controls[control] = () => reads;
      x.controls.beforeDroneBayRead = () => reads;
      const startedAt = Date.now();
      let sentAt: number | undefined;
      x.controls.onLock = () => {
        sentAt ??= Date.now();
      };
      const turn = defender.tick();
      let beforeReadback: Awaited<typeof turn> | "pending";
      try {
        beforeReadback = await Promise.race([
          turn,
          new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
        ]);
        t.mock.timers.tick(6000);
      } finally {
        releaseReads();
        await turn;
      }
      const delayMs = sentAt === undefined ? null : sentAt - startedAt;
      t.diagnostic(
        `first AddTarget at +${delayMs} ms, capability reads released at +6000 ms (mock clock)`,
      );
      assert.equal(delayMs, 0);
      assert.equal(beforeReadback, "waiting-lock");
      assert.deepEqual(x.events, [`lock:3:${expectedTarget}`]);
      assert.equal(x.reads.targets, 0);

      x.controls.pendingLock = false;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await defender.tick();
      await defender.tick();
      assert.deepEqual(x.events, [`lock:3:${expectedTarget}`, `fire:3:${expectedTarget}`]);
    },
  );
}

test(
  "Defender with a verified zero drone bay locks during a pending fit refresh without inventory reads",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false);
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    x.controls.nativeLockReply = true;
    x.controls.droneBayCapacity = 0;
    let release!: () => void;
    const fitting = new Promise<void>((resolve) => {
      release = resolve;
    });
    x.controls.beforeFitRead = () => fitting;
    x.controls.beforeDroneBayRead = async () =>
      assert.fail("A verified absent bay needs no native List.");
    const pass = defender.tick();
    try {
      assert.equal(await pass, "waiting-lock");
      assert.deepEqual(x.events, ["lock:3:901"]);
      assert.equal(
        x.traces.get(3)!.some((call) => ["List", "InvalidateLocationCache"].includes(call.action)),
        false,
      );
    } finally {
      release();
      await pass;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await defender.tick();
    assert.deepEqual(x.events, ["lock:3:901", "fire:3:901"]);
  },
);

test("AddTarget uses the ranked grid and does not read the target roster first", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const x = escortFixture(),
    defender = x.pilot(3, false);
  await defender.warm();
  x.controls.hostiles = [
    { id: 901, x: 2800 },
    { id: 902, x: 4000 },
  ];
  x.controls.nativeLockReply = true;
  x.controls.beforeModuleRead = async () => {
    now += 2000;
  };
  x.controls.beforeLockRead = async () => {
    now += 2000;
  };
  x.controls.onLock = () => {
    const beforeCommand = x.traces.get(3)!.map((call) => call.action);
    assert.equal(beforeCommand.filter((action) => action === "snapshot").length, 1);
    assert.equal(beforeCommand.includes("targets"), false);
  };
  await defender.tick();
  assert.deepEqual(x.events, ["lock:3:901", "fire:3:901"]);
});

test("a transient observation failure on one gun leaves the other gun and drones available", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true, true);
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  x.controls.beforeModuleRead = async (moduleID) => {
    if (moduleID === 1203)
      throw Object.assign(new Error("Module observation timed out"), { code: "CALL_TIMEOUT" });
  };
  await defender.tick();
  assert.equal(x.currentFire.get(3), 901);
  assert.equal(x.events.filter((e) => e === "fire:3:901").length, 1);
  assert.equal(x.events.filter((e) => e === "engage:3:901").length, 1);
});
test("completed weapon records do not block Defender drones during a fitting read failure", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  const key =
    "mining-fleet-defender-actions:" +
    JSON.stringify(["mixed-escort", "run", "mixed-3", 3, 103, "BELT:300:Belt", 1]);
  const history = {
    version: 1,
    entries: [
      {
        action: {
          key: "old-effect",
          characterID: 3,
          shipID: 103,
          moduleID: 203,
          typeID: 311,
          targetID: 900,
          kind: "weapon",
        },
        status: "CONFIRMED",
        issuedAt: 1,
      },
    ],
  };
  x.docs.set(key, history);
  x.controls.beforeFitRead = async () => {
    throw Object.assign(new Error("Fitting observation timed out"), { code: "CALL_TIMEOUT" });
  };
  await defender.tick();
  assert.equal(x.events.filter((e) => e === "engage:3:901").length, 1);
  assert.deepEqual(x.docs.get(key), history);
});

test(
  "Defender guns attack before a blocked drone bay read finishes",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, true);
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    x.controls.dronesInBay = true;
    let release!: () => void, entered!: () => void, fired!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reading = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      shot = new Promise<void>((resolve) => {
        fired = resolve;
      });
    x.controls.beforeDroneBayRead = async () => {
      entered();
      await gate;
    };
    x.controls.beforeWeaponReply = async () => {
      fired();
    };
    const first = defender.tick();
    try {
      await Promise.all([reading, shot]);
      await first;
      assert.equal(x.currentFire.get(3), 901);
      assert.equal(
        x.traces.get(3)!.some((e) => e.action === "LaunchDrones"),
        false,
      );
    } finally {
      release();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await defender.tick();
    assert.equal(x.traces.get(3)!.filter((e) => e.action === "LaunchDrones").length, 1);
    assert.equal(x.events.filter((e) => e === "fire:3:901").length, 1);
  },
);

for (const [read, control, orders] of [
  ["native lock range", "beforeLockRangeRead", ["engage:3:901"]],
  ["drone control range", "beforeDroneRangeRead", ["fire:3:901", "lock:3:901"]],
  ["optional NPC signature", "beforeSignatureRead", ["engage:3:901", "fire:3:901", "lock:3:901"]],
] as const)
  test(`ready Defender actions proceed before ${read} returns`, { timeout: 1500 }, async () => {
    const x = escortFixture(),
      defender = x.pilot(3, false, true);
    x.controls.hostiles = [
      { id: 901, x: 2800 },
      { id: 903, x: 5300 },
    ];
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    x.controls[control] = () => {
      entered();
      return gate;
    };
    try {
      await Promise.all([defender.tick(), reading]);
      assert.deepEqual(x.events.slice().sort(), orders);
    } finally {
      release();
    }
  });

test(
  "Another Defender and the current drone order proceed during a blocked lock confirmation",
  { timeout: 1500 },
  async () => {
    const x = escortFixture(),
      slow = x.pilot(3, false, true),
      peer = x.pilot(4, false, true);
    x.controls.hostiles = [{ id: 901, x: 2800 }];
    x.controls.pendingLock = true;
    let release!: () => void;
    const response = new Promise<void>((resolve) => {
      release = resolve;
    });
    x.controls.beforeLockRead = (id) => (id === 3 ? response : Promise.resolve());
    try {
      await slow.tick();
      assert.deepEqual(x.events.slice().sort(), ["engage:3:901", "lock:3:901"]);
      await slow.tick();
      assert.equal(x.reads.targets, 1);
      x.controls.pendingLock = false;
      await peer.tick();
      assert.equal(x.currentFire.get(4), 901);
      assert.equal(x.currentFire.has(3), false);
    } finally {
      release();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    await slow.tick();
    assert.equal(x.currentFire.get(3), 901);
  },
);

test("a transient targets read failure preserves drone work and a pending native acquisition", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  x.controls.pendingLock = true;
  x.controls.lockReadUnavailable = true;
  assert.equal(await defender.tick(), "waiting-lock");
  assert.deepEqual(x.events.slice().sort(), ["engage:3:901", "lock:3:901"]);
  await defender.tick();
  assert.equal(x.reads.targets, 1);
  x.controls.pendingLock = false;
  await defender.tick();
  await defender.tick();
  assert.deepEqual(x.events.slice().sort(), ["engage:3:901", "fire:3:901", "lock:3:901"]);
});

test("Defender orders drones at their range and closes into gun range for the first shot", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [{ id: 901, x: 11_000 }];
  assert.equal(await defender.tick(), "approaching");
  assert.deepEqual(x.events.slice().sort(), ["engage:3:901", "lock:3:901", "move:3:901:8000"]);
  x.pilotPositions.set(3, 3000);
  assert.equal(await defender.tick(), "responding");
  assert.deepEqual(x.events.slice(3), ["fire:3:901"]);
});

test("a definite weapon lock refusal yields to a fresh native lock read on the next tick", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [{ id: 901, x: 4000 }];
  x.controls.refuseWeaponLock = true;
  assert.equal(await defender.tick(), "waiting-lock");
  await defender.tick(); // the earlier acquisition is still present
  assert.equal(await defender.tick(), "combat-wait");
  assert.equal(await defender.tick(), "responding");
  assert.deepEqual(x.events, ["lock:3:901", "fire:3:901"]);
});

test("Defender retires a lock rejected by the transport queue and can lock on the next observation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [{ id: 901, x: 4000 }];
  x.controls.beforeLock = () => {
    const cause = new TransportQueueError("/api/bridge/call", 20_000, {
      inFlight: 4,
      queued: 1,
      oldestOutstandingMs: 6000,
      verdict: "All 4 request lanes were busy.",
    });
    throw new BridgeCallError("BRIDGE_NETWORK_ERROR", cause.message, 0, cause.diagnosis.verdict);
  };
  assert.equal(await defender.tick(), "waiting-lock");
  const lockDoc = [...x.docs.keys()].find((key) => key.startsWith("mining-fleet-defender-locks:"))!;
  assert.equal(
    (x.docs.get(lockDoc) as { entries: { status: string }[] }).entries[0]!.status,
    "REFUSED",
  );
  assert.deepEqual(x.events, []);
  x.controls.beforeLock = undefined;
  t.mock.timers.tick(1501);
  await defender.tick();
  assert.deepEqual(x.events, ["lock:3:901", "fire:3:901"]);
});

test("Defender Stop checks native shutdown with a previously unresolved target acquisition", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [{ id: 901, x: 4000 }];
  x.controls.onLock = () => {
    throw Error("Target-lock response lost");
  };
  assert.equal(await defender.tick(), "waiting-lock");
  assert.match(defender.warning() ?? "", /Target-lock response lost/);
  const lockDoc = [...x.docs.keys()].find((key) => key.startsWith("mining-fleet-defender-locks:"))!;
  const unresolved = x.docs.get(lockDoc) as { entries: { status: string }[] };
  assert.equal(unresolved.entries[0]!.status, "DISPATCHED");
  x.controls.stopping = true;
  const trace = x.traces.get(3)!;
  const priorReads = trace.length;
  await defender.stop(true);
  assert.ok(trace.slice(priorReads).some((row) => row.action === "ItemGetInfo"));
  assert.deepEqual(x.docs.get(lockDoc), unresolved);
  assert.deepEqual(x.events, ["lock:3:901"]);
});

test("a cancelled intermediate lock does not leave the gun cycling on the first NPC", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [
    { id: 901, x: 2800 },
    { id: 902, x: 3500 },
    { id: 903, x: 5300 },
  ];
  assert.equal(await defender.tick(), "combat-wait");
  x.controls.hostiles.shift();
  x.controls.refuseLock = 902;
  assert.equal(await defender.tick(), "combat-wait");
  assert.ok(x.events.includes("lock-refused:3:902"));
  assert.ok(x.events.includes("deactivate:3:901"));
  assert.ok(x.events.includes("engage:3:903"));
  assert.equal(await defender.tick(), "responding");
  assert.equal(x.currentFire.get(3), 903);
});

test("a native target absence retargets weapons and drones to an existing lock without rereading a fresh grid", async (t) => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [
    { id: 901, x: 2800 },
    { id: 903, x: 5300 },
  ];
  x.controls.refuseTarget = 901;
  x.controls.heldLocks = [901, 903];
  defender.landLock(901);
  defender.landLock(903);
  await defender.tick();
  const trace = x.traces.get(3)!;
  const refusedAt = trace.find((row) => row.action === "target-not-present")!.at;
  const since = (action: string) =>
    (trace.find((row) => row.action === action && row.at >= refusedAt)!.at - refusedAt).toFixed(2);
  t.diagnostic(
    `Native target absence → CmdEngage +${since("CmdEngage")} ms / Activate +${since("Activate")} ms`,
  );
  assert.ok(x.events.includes("refused:3:901"));
  assert.ok(x.events.includes("engage:3:903"));
  assert.equal(x.currentFire.get(3), 903);
  assert.equal(x.reads.grid, 1);
  assert.equal(
    x.events.some((event) => event.startsWith("lock:")),
    false,
  );
  await defender.tick(); // The old target still appears on the grid.
  assert.equal(x.events.filter((event) => event === "refused:3:901").length, 1);
  assert.equal(
    x.events.some((event) => event === "lock:3:901"),
    false,
  );
});

test("lost drone response during a parallel attack does not replay either native command", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false, true);
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  x.controls.loseDroneResponse = true;
  await assert.rejects(defender.tick(), /Drone response lost/);
  x.controls.loseDroneResponse = false;
  assert.equal(await defender.tick(), "responding");
  assert.deepEqual(x.events.slice().sort(), ["engage:3:901", "fire:3:901", "lock:3:901"]);
});

test("a Defender can regroup after an unknown weapon response while that gun remains fenced", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [{ id: 901, x: 2800 }];
  x.controls.loseWeaponResponse = true;
  assert.equal(await defender.tick(), "combat-wait");
  x.controls.hostiles = [];
  assert.equal(await defender.tick(), "checking-grid");
  assert.equal(await defender.tick(), "watching");
  x.controls.hostiles = [{ id: 903, x: 5300 }];
  x.controls.loseWeaponResponse = false;
  assert.equal(await defender.tick(), "combat-wait");
  assert.deepEqual(x.events, ["lock:3:901", "fire:3:901", "lock:3:903"]);
  x.controls.stopping = true;
  await assert.rejects(defender.stop(true), /A combat module command remains unresolved/);
});

test("120 km target eligibility uses any active Miner and excludes 121 km from the group", async () => {
  const x = escortFixture(),
    first = x.pilot(3, false);
  x.controls.hostiles = [{ id: 90, x: 121000 }];
  assert.equal(await first.tick(), "watching");
  assert.deepEqual(x.events, []);
  x.controls.hostiles = [{ id: 90, x: 119000 }];
  assert.equal(await first.tick(), "approaching");
  assert.equal(x.following.get(3), 90);

  x.peerPositions.set(12, 160000);
  x.activePeers.add(12);
  const second = x.pilot(4, false);
  x.controls.hostiles = [{ id: 91, x: 245000 }];
  assert.equal(await second.tick(), "approaching");
  assert.equal(x.following.get(4), 91);

  x.activePeers.delete(12);
  const third = x.pilot(5, false);
  const before = x.events.length;
  assert.equal(await third.tick(), "watching");
  assert.equal(x.events.length, before);
});

test("a chase does not cross the uncovered gap between separated Miners", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.peerPositions.set(12, 300000);
  x.activePeers.add(12);
  x.controls.hostiles = [{ id: 90, x: 305000 }];
  assert.equal(await defender.tick(), "watching");
  assert.deepEqual(x.events, []);
  assert.match(defender.warning() ?? "", /would leave the 120 km escort area/);
});

test("Defender cancels the old chase and regroups before combat, then follows relocated Miners", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.pilotPositions.set(3, 10000);
  x.controls.hostiles = [{ id: 90, x: 30000 }];
  assert.equal(await defender.tick(), "approaching");
  assert.equal(x.following.get(3), 90);

  x.pilotPositions.set(3, 100000);
  x.controls.hostiles = [{ id: 90, x: 121000 }];
  assert.equal(await defender.tick(), "regrouping");
  assert.deepEqual(x.events.slice(-2), ["stop:3", "move:3:11:5000"]);
  assert.equal(x.following.get(3), 11);

  const outside = x.pilot(4, false);
  x.pilotPositions.set(4, 180000);
  x.controls.hostiles = [{ id: 91, x: 119000 }];
  assert.equal(await outside.tick(), "regrouping");
  assert.equal(x.following.get(4), 11);
  assert.equal(
    x.events.some((event) => event.startsWith("lock:4:")),
    false,
  );

  x.peerPositions.set(11, 710000);
  x.pilotPositions.set(3, 704000);
  x.controls.hostiles = [{ id: 92, x: 708000 }];
  assert.equal(await defender.tick(), "combat-wait");
  assert.equal(x.currentFire.get(3), 92);

  x.peerPositions.delete(11);
  assert.equal(await defender.tick(), "regroup-wait");
  x.peerPositions.set(11, 710000);
  assert.equal(await defender.tick(), "responding");
  assert.equal(x.events.filter((event) => event === "fire:3:92").length, 1);
});

test("Defender engages beside relocated Miners while the Hauler stays at the old belt", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.peerPositions.set(17, 0);
  x.activePeers.add(17);
  x.controls.hostiles = [];
  assert.equal(await defender.tick(), "watching");
  x.peerPositions.delete(11);
  x.controls.hostiles = [{ id: 90, x: 8000 }];
  assert.equal(await defender.tick(), "regroup-wait");
  assert.deepEqual(x.events, []);
  x.peerPositions.set(11, 500000);
  x.pilotPositions.set(3, 499000);
  assert.equal(await defender.tick(), "watching");
  assert.deepEqual(x.events, []);
  x.controls.hostiles.push({ id: 91, x: 506000 });
  assert.equal(await defender.tick(), "combat-wait");
  assert.equal(x.currentFire.get(3), 91);
  assert.deepEqual(x.events, ["lock:3:91", "fire:3:91"]);
});

test("Defender closes to an active Miner on a clear grid even with a closer Hauler", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [];
  x.pilotPositions.set(3, 25_000);
  x.peerPositions.set(17, 24_000);
  x.activePeers.add(17);
  assert.equal(await defender.tick(), "regrouping");
  assert.deepEqual(x.events, ["move:3:11:5000"]);
});

test("Defender can regroup with the same Miner after a stalled follow is stopped", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [];
  x.pilotPositions.set(3, 25000);
  assert.equal(await defender.tick(), "regrouping");

  t.mock.timers.tick(30000);
  assert.equal(await defender.tick(), "regroup-wait");
  assert.deepEqual(x.events, ["move:3:11:5000", "stop:3"]);
  assert.match(defender.warning() ?? "", /no native progress/);

  t.mock.timers.tick(1);
  assert.equal(await defender.tick(), "regrouping");
  assert.deepEqual(x.events, ["move:3:11:5000", "stop:3", "move:3:11:5000"]);
  x.pilotPositions.set(3, 4000);
  assert.equal(await defender.tick(), "watching");
  assert.equal(x.events.filter((event) => event.startsWith("move:")).length, 2);
});

test("Defender reopens a zero throttle while keeping the native Follow to an active Miner", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [];
  x.pilotPositions.set(3, 125_000);
  x.following.set(3, 11);
  x.throttle.set(3, 0);

  assert.equal(await defender.tick(), "regrouping");
  assert.deepEqual(x.events, ["throttle:3"]);
  assert.equal(x.following.get(3), 11);
  assert.equal(x.throttle.get(3), 1);
  x.pilotPositions.set(3, 4_500);
  assert.equal(await defender.tick(), "checking-grid");
  assert.equal(await defender.tick(), "watching");
  assert.deepEqual(x.events, ["throttle:3"]);
});

test("Defender opens the throttle before starting a regroup Follow from standstill", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [];
  x.pilotPositions.set(3, 25_000);
  x.throttle.set(3, 0);

  assert.equal(await defender.tick(), "regrouping");
  assert.deepEqual(x.events, ["throttle:3", "move:3:11:5000"]);
  x.pilotPositions.set(3, 20_000);
  assert.equal(await defender.tick(), "regrouping");
  assert.equal(x.events.length, 2);
});

test("Defender keeps the regroup Miner when another Miner becomes closer", async () => {
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [];
  x.pilotPositions.set(3, 25_000);
  x.peerPositions.set(12, 60_000);
  x.activePeers.add(12);
  assert.equal(await defender.tick(), "regrouping");

  x.pilotPositions.set(3, 20_000);
  x.peerPositions.set(12, 28_000);
  assert.equal(await defender.tick(), "regrouping");
  assert.deepEqual(x.events, ["move:3:11:5000"]);
  x.activePeers.delete(11);
  assert.equal(await defender.tick(), "regrouping");
  assert.deepEqual(x.events, ["move:3:11:5000", "move:3:12:5000"]);
});

test("Defender stays with a Miner at the 5 km Follow standoff without cycling Stop and Follow", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [];
  x.pilotPositions.set(3, 25_000);
  assert.equal(await defender.tick(), "regrouping");

  x.pilotPositions.set(3, 5_070); // 5,050 m measured from hull to hull.
  assert.equal(await defender.tick(), "watching");
  t.mock.timers.tick(30_000);
  assert.equal(await defender.tick(), "watching");
  assert.deepEqual(x.events, ["move:3:11:5000"]);
  assert.equal(x.following.get(3), 11);
});

test("Defender measures recent closing progress after the Miner moves away", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [];
  x.pilotPositions.set(3, 25_000);
  assert.equal(await defender.tick(), "regrouping");

  x.peerPositions.set(11, -15_000);
  t.mock.timers.tick(15_000);
  assert.equal(await defender.tick(), "regrouping");
  x.pilotPositions.set(3, 22_000);
  t.mock.timers.tick(16_000);
  assert.equal(await defender.tick(), "regrouping");
  assert.deepEqual(x.events, ["move:3:11:5000"]);
});

test("Defender does not stop an active regroup Follow based on a repeated snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [];
  x.controls.sceneSampledAtMs = 1_000;
  x.pilotPositions.set(3, 25_000);
  assert.equal(await defender.tick(), "regrouping");

  t.mock.timers.tick(30_000);
  assert.equal(await defender.tick(), "regrouping");
  x.controls.sceneSampledAtMs = 2_000;
  x.pilotPositions.set(3, 21_000);
  assert.equal(await defender.tick(), "regrouping");
  assert.deepEqual(x.events, ["move:3:11:5000"]);
});

test("Defender cancels pursuit when the grid read fails and stops reporting a stalled follow", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 100000 });
  const x = escortFixture(),
    defender = x.pilot(3, false);
  x.controls.hostiles = [{ id: 90, x: 30000 }];
  assert.equal(await defender.tick(), "approaching");
  x.controls.sceneAvailable = false;
  await assert.rejects(defender.tick(), FleetObservationUnavailable);
  assert.equal(x.events.at(-1), "stop:3");
  assert.equal(x.following.has(3), false);

  x.controls.sceneAvailable = true;
  assert.equal(await defender.tick(), "approaching");
  t.mock.timers.tick(30000);
  assert.equal(await defender.tick(), "watching");
  assert.equal(x.events.at(-1), "stop:3");
  assert.equal(x.following.has(3), false);
  assert.match(defender.warning() ?? "", /no native progress/);
});
