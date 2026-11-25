import { verifyCombatFleet } from "./roster.ts";
import { registerCombatRun } from "./control.ts";
import path from "node:path";
import { createRequire } from "node:module";
import {
  pluginDataDir,
  type BackendRun,
  type PluginRunContext,
} from "../../../web/src/plugin-api/backend.ts";
import { createPilotSession, type PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import {
  loadBoundFleet,
  decodeFleetCenter,
  authoritativeFleetMemberCharacterIDs,
  getFlightStatus,
  decodeFlightStatus,
  decodeSpaceSnapshot,
  warpToFleetMember,
  leaveFleet,
} from "../../../web/src/plugin-api/flying.ts";
import { createFleetAssembly, type FleetAssemblyPeer } from "../miningFleet/fleetAssembly.ts";
import type { Identity } from "./security.ts";
import { createNativeSecurityRun, type SecurityFleetHooks } from "./host.ts";
import {
  createFleetCombatAuthority,
  decodeFleetCombatSetup,
  FleetRoomRetired,
  type FleetCombatSetup,
} from "./fleetAuthority.ts";
import { securityDungeon } from "./native.ts";
import type { SecurityStorage } from "./journal.ts";
import {
  createPilotFighter,
  SecurityTargetUnobserved,
  type PilotFighterState,
} from "./pilotFighter.ts";
import { readCombatShipClass, readHeldCombatAnchor, selectCombatAnchor } from "./anchor.ts";
import { DroneTargetUnavailableRefusal } from "./droneAdapter.ts";
import { createFleetTelemetry } from "./fleetTelemetry.ts";
import { createFleetNavigation } from "./fleetNavigation.ts";
import { isSecurityTarget } from "./securityTargets.ts";
import { decodeOwnShipLocation } from "../shared/nativeShipLocation.ts";
import { parkNearest, parkWithPolicy } from "../shared/parking.ts";
import { runOwner, registerRun } from "../runControl.ts";
import { openCombatStore } from "../operations/combatStore.ts";
const require = createRequire(import.meta.url),
  { createDocumentStore } = require("../documentStore.cjs");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Doc = { read(): unknown; write(v: unknown): void };
export interface FleetSecurityDeps {
  openRegistry?: typeof openCombatStore;
  ownerDocument?: (run: PluginRunContext) => SecurityStorage;
  document?: (name: string) => Doc;
  attach?: typeof createPilotSession;
  sleep?: (ms: number) => Promise<void>;
  park?: typeof parkNearest;
}
type Entry = {
  run: PluginRunContext;
  shipID: number;
  session: PilotSession;
  current: () => void;
  settle: () => Promise<void>;
  generation: number;
  record: (kind: string, data: unknown) => void;
  lastFleetAt: number;
  registryFinish?: (receipt: unknown) => void;
};
/** One operation, one mission owner, independently hosted assistants. */
export function createFleetSecurityRuns(deps: FleetSecurityDeps = {}) {
  const db = deps.document
    ? null
    : createDocumentStore(path.join(pluginDataDir(), "fleet-security.sqlite"));
  const document = deps.document ?? ((name: string) => db.document(name) as Doc),
    groups = new Map<string, ReturnType<typeof makeGroup>>();
  function makeGroup(setup: FleetCombatSetup) {
    const key = JSON.stringify([setup.operationID, setup.operationRunID]),
      signature = JSON.stringify(setup),
      index = document(`fleet-security-index:${setup.operationID}`),
      saved = index.read() as any;
    if (saved !== null && (saved.runID !== setup.operationRunID || saved.signature !== signature)) {
      if (
        saved.terminal !== true ||
        !Array.isArray(saved.finished) ||
        !Array.isArray(saved.memberIDs) ||
        saved.finished.length !== saved.memberIDs.length ||
        saved.memberIDs.some((id: number) => !saved.finished.includes(id))
      )
        throw Error("Another fleet Security operation retains custody.");
      document(`fleet-security-archive:${JSON.stringify([setup.operationID, saved.runID])}`).write(
        saved,
      );
      index.write({
        runID: setup.operationRunID,
        signature,
        memberIDs: setup.members.map((m) => m.characterID),
        finished: [],
        terminal: false,
      });
    } else if (saved === null)
      index.write({
        runID: setup.operationRunID,
        signature,
        memberIDs: setup.members.map((m) => m.characterID),
        finished: [],
        terminal: false,
      });
    else if (saved.terminal === true)
      throw Error("This fleet Security operation is already terminal.");
    const authority = createFleetCombatAuthority(
        setup,
        Date.now,
        document(`fleet-security-roster:${key}`),
      ),
      entries = new Map<number, Entry>();
    let assembly: ReturnType<typeof createFleetAssembly> | null = null,
      step: Promise<boolean> | null = null,
      stopping = false,
      assembled = false,
      anchor: { characterID: number; shipID: number; size: number } | null = null;
    function add(e: Entry) {
      const member = setup.members.find((m) => m.characterID === e.run.characterID);
      if (
        !member ||
        e.shipID !== member.shipID ||
        entries.has(member.characterID) ||
        e.run.held.characterID !== member.characterID
      )
        throw Error("Fleet pilot ownership differs.");
      authority.register(member.characterID, e.run.botID, e.generation, e.current, e.settle);
      entries.set(member.characterID, e);
    }
    const ordered = () => [
      setup.members.find((m) => m.characterID === (setup.anchorID ?? setup.missionOwnerID))!,
      ...setup.members.filter((m) => m.characterID !== (setup.anchorID ?? setup.missionOwnerID)),
    ];
    async function electAnchor() {
      if (setup.anchorID === undefined) return;
      if (anchor && authority.memberActive(anchor.characterID)) return;
      const classes = await Promise.all(
        authority.activeMembers().map(async (m) => {
          const e = entries.get(m.characterID)!;
          try {
            return await readHeldCombatAnchor(e.run, e.session, m, e.current, anchor !== null);
          } catch (error) {
            if (
              authority.retire(
                m.characterID,
                error instanceof Error ? error.message : String(error),
              ) === "STOP_OPERATION"
            )
              throw error;
            return { ...m, shipClass: null };
          }
        }),
      );

      const selected = selectCombatAnchor(classes, anchor?.size ?? Infinity);
      if (
        !selected ||
        selected.shipClass === null ||
        (!anchor && selected.characterID !== setup.anchorID)
      )
        throw Error("No exact qualified same-or-smaller fleet anchor is available.");
      const previous = anchor;
      anchor = {
        characterID: selected.characterID,
        shipID: selected.shipID,
        size: selected.shipClass,
      };
      document(`fleet-security-anchor:${key}`).write({
        version: 1,
        operationID: setup.operationID,
        runID: setup.operationRunID,
        anchor,
        previous,
        observedAt: Date.now(),
      });
      for (const e of entries.values())
        if (authority.memberActive(e.run.characterID))
          e.record("anchor-elected", { anchor, previous });
    }
    async function ready() {
      if (stopping) throw Error("Fleet Security stopped.");
      if (entries.size !== setup.members.length) return false;
      if (step) return step;
      step = (async () => {
        authority.all();
        await electAnchor();
        if (assembled && authority.activeMembers().length !== setup.members.length) {
          await verifyCombatFleet(
            authority.activeMembers().map((m) => entries.get(m.characterID)!),
            setup.members,
          );
          return true;
        }

        if (!assembly) {
          const peers: FleetAssemblyPeer[] = ordered().map((m) => {
            const e = entries.get(m.characterID)!;
            return {
              characterID: m.characterID,
              shipID: m.shipID,
              botID: e.run.botID,
              current: e.current,
              async read() {
                e.current();
                const options = {
                    ...e.session.flow.requestOptions(),
                    baseUrl: e.run.baseUrl,
                    fetch: e.run.fetch,
                  },
                  [bound, flight] = await Promise.all([
                    loadBoundFleet(options),
                    getFlightStatus(options),
                  ]);
                e.current();
                if (decodeFlightStatus(flight.flight).shipID !== m.shipID)
                  throw Error("Fleet ship changed.");
                const f = decodeFleetCenter(bound);
                if (f.availability === "not-in-fleet") return { state: "not-in-fleet" as const };
                const ids = authoritativeFleetMemberCharacterIDs(f),
                  fleetID = Number(f.fleet.initState.value.fleetID);
                if (
                  f.availability !== "ready" ||
                  !ids ||
                  !ids.includes(m.characterID) ||
                  f.fleet.initState.value.members.length !== ids.length ||
                  !Number.isSafeInteger(fleetID) ||
                  fleetID <= 0
                )
                  throw Error("Native fleet roster is unreadable.");
                return { state: "ready" as const, fleetID, memberIDs: ids };
              },
              invitation() {
                e.current();
                return e.session.store.fleet.get().pendingInvite;
              },
              async create() {
                e.current();
                await e.session.flow.flying.bridgeDo("fleetObjectHandler", "CreateFleet", []);
                e.current();
              },
              async invite(id, fleetID) {
                e.current();
                await e.session.flow.flying.bridgeDo(
                  "fleetObjectHandler",
                  "Invite",
                  [id, null, null, null],
                  null,
                  fleetID,
                );
                e.current();
              },
              async accept(fleetID) {
                e.current();
                await e.session.flow.flying.bridgeDo(
                  "fleetObjectHandler",
                  "AcceptInvite",
                  [],
                  null,
                  fleetID,
                );
                e.current();
              },
              async leave() {
                e.current();
                await leaveFleet(e.session.flow.flying.bridgeDo);
                e.current();
              },
            };
          });
          assembly = createFleetAssembly(
            document(`fleet-security-assembly:${key}`),
            setup.operationID,
            setup.operationRunID,
            peers,
            Date.now,
            setup.fleetMoves,
          );
        }
        const ready = (await assembly.step()) === "ready";
        if (ready) {
          assembled = true;
          const snap = assembly.snapshot(),
            at = Date.now(),
            memberIDs = setup.members.map((m) => m.characterID).sort((a, b) => a - b);
          if (!snap.fleetID) throw Error("Verified native fleet ID is missing.");
          for (const e of entries.values())
            if (at - e.lastFleetAt >= 2000) {
              e.record("native-fleet", { fleetID: snap.fleetID, memberIDs, observedAt: at });
              e.lastFleetAt = at;
            }
        }
        return ready;
      })().finally(() => {
        step = null;
      });
      return step;
    }
    function finished(id: number, receipt: unknown) {
      const raw = index.read() as any,
        ids = setup.members.map((m) => m.characterID);
      if (
        !raw ||
        raw.runID !== setup.operationRunID ||
        raw.signature !== signature ||
        !Array.isArray(raw.memberIDs) ||
        JSON.stringify(raw.memberIDs) !== JSON.stringify(ids) ||
        !Array.isArray(raw.finished) ||
        raw.finished.some((n: number) => !ids.includes(n))
      )
        throw Error("Fleet Security terminal record changed.");
      const done = [...new Set([...raw.finished, id])];
      if (!ids.includes(id)) throw Error("Unselected pilot cannot finish the fleet.");
      index.write({
        ...raw,
        finished: done,
        terminal: done.length === ids.length,
        updatedAt: Date.now(),
      });
      entries.get(id)?.registryFinish?.(receipt);
    }
    return {
      setup,
      authority,
      add,
      ready,
      finished,
      retire(id: number, reason: string) {
        const decision = authority.retire(id, reason);
        if (decision === "STOP_OPERATION") stopping = true;
        return decision;
      },
      anchor: () => anchor,
      stop() {
        stopping = true;
        authority.stop();
      },
      isStopping: () => stopping,
    };
  }
  function group(setup: FleetCombatSetup) {
    const key = JSON.stringify([setup.operationID, setup.operationRunID]);
    let g = groups.get(key);
    if (g) {
      const index = document(`fleet-security-index:${setup.operationID}`).read() as any;
      if (
        JSON.stringify(g.setup) !== JSON.stringify(setup) ||
        !index ||
        index.runID !== setup.operationRunID ||
        index.signature !== JSON.stringify(setup) ||
        index.terminal === true
      )
        throw Error("Fleet operation setup or retained epoch changed.");
    }
    if (!g) {
      g = makeGroup(setup);
      groups.set(key, g);
    }
    return g;
  }
  async function bindRegistry(run: PluginRunContext, setup: FleetCombatSetup, account: string) {
    if (!setup.registry) return undefined;
    const member = setup.members.find((m) => m.characterID === run.characterID);
    if (!member) throw Error("Saved fleet member is unavailable.");
    const response = await run.fetch(new URL("/api/plugins/uoc/world", run.baseUrl)),
      body = await response.json();
    if (!response.ok || body?.ok !== true || typeof body.worldID !== "string" || !body.worldID)
      throw Error("Saved fleet world is unavailable.");
    const world = body.worldID;
    const registry = (deps.openRegistry ?? openCombatStore)();
    try {
      registry.bindMember(
        world,
        setup.operationID,
        setup.operationRunID,
        account,
        run.characterID,
        member.shipID,
        setup,
        run.botID,
      );
    } finally {
      registry.close();
    }
    return (receipt: unknown) => {
      const registry = (deps.openRegistry ?? openCombatStore)();
      try {
        registry.finishMember(
          world,
          setup.operationID,
          setup.operationRunID,
          account,
          run.characterID,
          run.botID,
          receipt,
        );
      } finally {
        registry.close();
      }
    };
  }
  const check = (v: unknown) => {
    const setup = decodeFleetCombatSetup(v);
    return setup
      ? {
          ok: true as const,
          setup: setup as any,
          name: "Security fleet (drone combat)",
          policy: {
            riskClasses: ["inventory", "fleet", "combat", "mission"] as (
              "inventory" | "fleet" | "combat" | "mission"
            )[],
            restartSafe: false,
          },
        }
      : {
          ok: false as const,
          refusal: "Select an exact mission owner and two to eight distinct fleet pilots.",
        };
  };
  const owner: BackendRun = {
    check,
    async start(run) {
      const setup = decodeFleetCombatSetup(run.setup);
      if (!setup || setup.missionOwnerID !== run.characterID || run.resumed)
        throw Error("Fleet mission owner is invalid.");
      const registryFinish = setup.registry
        ? await bindRegistry(run, setup, await runOwner(run))
        : undefined;
      const g = group(setup);
      let generation = 0,
        telemetry: ReturnType<typeof createFleetTelemetry> | null = null,
        lastRoom = "",
        lastTarget = "",
        lastTargetGeneration = -1;
      const fleet: SecurityFleetHooks = {
        friendlyMembers: setup.members,
        anchor: g.anchor,
        memberActive: g.authority.memberActive,
        memberDecisions: g.authority.memberDecisions,
        control: (_r, account, stop) =>
          registerCombatRun(
            run,
            account,
            stop,
            () => {
              g.stop();
              stop();
            },
            () => ({
              anchor: g.anchor(),
              memberDecisions: g.authority.memberDecisions(),
              ...g.authority.snapshot(),
            }),
          ),
        register(r, session, current, settle, shipID, account) {
          generation = session.flow.flying.sessionGeneration();
          telemetry = createFleetTelemetry(document, {
            operationID: setup.operationID,
            operationRunID: setup.operationRunID,
            botID: r.botID,
            characterID: r.characterID,
            shipID,
            sessionGeneration: generation,
            account,
          });
          g.add({
            run: r,
            shipID,
            session,
            current,
            settle,
            generation,
            record: (kind, data) => telemetry!.record(kind, data),
            lastFleetAt: 0,
            ...(registryFinish ? { registryFinish } : {}),
          });
        },
        ready: g.ready,
        publish(id, anchor) {
          g.authority.publish(run.characterID, run.botID, generation, id, anchor);
          const room = JSON.stringify([id.acceptedKey, id.instanceID, id.roomID]);
          if (room !== lastRoom) {
            lastRoom = room;
            telemetry!.record("room-published", {
              acceptedKey: id.acceptedKey,
              dungeonID: id.dungeonID,
              instanceID: id.instanceID,
              roomID: id.roomID,
              anchor,
            });
          }
        },
        everyoneArrived: () => g.authority.everyoneArrived(),
        selectTarget: (targets) => {
          const selected = g.authority.selectTarget(
              run.characterID,
              run.botID,
              generation,
              targets,
            ),
            p = g.authority.target(run.characterID, run.botID, generation),
            fingerprint = JSON.stringify([selected, p.generation]);
          lastTargetGeneration = p.generation;
          if (fingerprint !== lastTarget) {
            lastTarget = fingerprint;
            telemetry!.record("primary-selected", {
              targetID: selected,
              targetGeneration: p.generation,
            });
          }
          return selected;
        },
        assertTarget: (target) =>
          g.authority.assertTarget(run.characterID, run.botID, generation, target),
        settle: () => g.authority.settleRoom(run.characterID, run.botID, generation),
        stop: g.stop,
        finished: (receipt) => g.finished(run.characterID, receipt),
        diagnostic: (kind, data) =>
          telemetry?.record(
            kind,
            kind.startsWith("engage-") && data && typeof data === "object" && !Array.isArray(data)
              ? { ...data, primaryTargetGeneration: lastTargetGeneration }
              : data,
          ),
      };
      return createNativeSecurityRun({
        fleet,
        attach: deps.attach,
        sleep: deps.sleep,
        document: deps.ownerDocument,
      }).start({
        ...run,
        setup: {
          ...("agentID" in setup ? { agentID: setup.agentID } : { agent: setup.agent }),
          missionCount: setup.missionCount,
          ...(setup.rewardPolicy !== undefined ? { rewardPolicy: setup.rewardPolicy } : {}),
          ...(setup.resumeExpected ? { resumeExpected: setup.resumeExpected } : {}),
          ...(setup.stopAfterMinutes !== undefined
            ? { stopAfterMinutes: setup.stopAfterMinutes }
            : {}),
          ...(setup.level !== undefined ? { level: setup.level } : {}),
          ...(setup.levelRule !== undefined ? { levelRule: setup.levelRule } : {}),
          ...(setup.agentScope ? { agentScope: setup.agentScope } : {}),
          ...(setup.parking ? { parking: setup.parking } : {}),
        },
      });
    },
  };
  const assistant: BackendRun = {
    check,
    async start(run) {
      const setup = decodeFleetCombatSetup(run.setup),
        member = setup?.members.find((m) => m.characterID === run.characterID);
      if (
        !setup ||
        !member ||
        run.characterID === setup.missionOwnerID ||
        run.resumed ||
        run.held.characterID !== run.characterID
      )
        throw Error("Fleet assistant identity is invalid.");
      const nav = createFleetNavigation(
        document(
          `fleet-security-nav:${JSON.stringify([setup.operationID, setup.operationRunID, run.characterID, member.shipID])}`,
        ),
        JSON.stringify([setup.operationID, setup.operationRunID, run.characterID, member.shipID]),
      );
      const owner = await runOwner(run),
        registryFinish = await bindRegistry(run, setup, owner),
        g = group(setup),
        session = await (deps.attach ?? createPilotSession)(run),
        generation = session.flow.flying.sessionGeneration(),
        pause = deps.sleep ?? sleep;
      let active = true,
        ended = false,
        stopping = false,
        busy: Promise<void> | null = null;
      const current = () => {
        if (
          !active ||
          session.flow.flying.isSessionClosing() ||
          session.flow.flying.sessionGeneration() !== generation ||
          session.store.station.get().online?.characterID !== run.characterID
        )
          throw Error("Assistant held session changed.");
      };
      const guard = () => {
        current();
        if (stopping || g.isStopping()) throw Error("Fleet Security stopped.");
      };
      const request = async (url: string, body?: unknown) => {
        current();
        const response = await run.fetch(
            new URL(url, run.baseUrl),
            body === undefined
              ? undefined
              : {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                },
          ),
          data = await response.json();
        current();
        if (!response.ok || data.ok === false)
          throw Error(data.message ?? data.error ?? "Assistant native read failed.");
        return data;
      };
      const ask = async (service: string, method: string, args: unknown[] = [], of?: number) =>
        (
          await request("/api/bridge/call", {
            service,
            method,
            args,
            pilot: true,
            confirm: true,
            ...(of === undefined ? {} : { of }),
          })
        ).result;
      const flight = async () => {
        const f = (await request("/api/bridge/flight/status")).flight;
        if (!f || f.shipID !== member.shipID) throw Error("Assistant ship changed.");
        return f;
      };
      const scene = async () => {
        const raw = (await request("/api/bridge/space/snapshot")).space;
        if (!raw || !Array.isArray(raw.entities)) throw Error("Assistant scene is unreadable.");
        const s = decodeSpaceSnapshot(raw);
        if (
          !s.inSpace ||
          !s.ship ||
          s.shipID !== member.shipID ||
          !s.ship.geometryAvailable ||
          s.stateValid === false
        )
          throw Error("Assistant scene is unavailable.");
        return s;
      };
      const dungeon = async () =>
        securityDungeon(await ask("keeper", "GetCurrentDungeonForCharacter"));
      const state: PilotFighterState = {
        currentIdentity: null,
        entryAnchor: null,
        droneUnresolved: false,
      };
      let lastScope: Identity | null = null,
        epoch = 0,
        primaryGeneration = -1,
        lastArrival = -1,
        lastPrimary = "",
        missingPrimary: { id: number; generation: number; since: number } | null = null;
      const fenceCombat = async (target: number | null) => {
        guard();
        if (!(await g.ready())) throw Error("Native combat fleet roster is not verified.");
        guard();
        const authority = g.authority.read(run.characterID, run.botID, generation),
          id = authority.room.identity;
        const [f, d, s] = await Promise.all([flight(), dungeon(), scene()]);
        guard();
        g.authority.assert(run.characterID, run.botID, generation, authority.serial);
        if (
          !f.inSpace ||
          /warp/i.test(f.shipMode ?? "warp") ||
          !d ||
          d.dungeonID !== id.dungeonID ||
          d.instanceID !== id.instanceID ||
          d.roomID !== id.roomID ||
          !s.ship
        )
          throw Error("Assistant is outside the exact mission room.");
        const a = authority.room.anchor;
        if (
          Math.hypot(s.ship.position.x - a.x, s.ship.position.y - a.y, s.ship.position.z - a.z) >
          250000
        )
          throw Error("Assistant is outside the room grid.");
        if (target !== null)
          g.authority.assertTarget(
            run.characterID,
            run.botID,
            generation,
            target,
            primaryGeneration,
          );
        if (target !== null && !s.entities.some((e) => e.itemID === target))
          throw new SecurityTargetUnobserved("Target absent before native engage.");
        if (
          target !== null &&
          !s.entities.some(
            (e) =>
              e.itemID === target &&
              isSecurityTarget(id, e) &&
              Math.hypot(e.position.x - a.x, e.position.y - a.y, e.position.z - a.z) <= 500000,
          )
        )
          throw Error("Assistant target is not a fresh mission NPC.");
        state.currentIdentity = id;
        state.entryAnchor = a;
        epoch = authority.serial;
      };
      const fenceFriendly = async (characterID: number, shipID: number) => {
        if (
          characterID === run.characterID ||
          !g.authority.memberActive(characterID) ||
          !setup.members.some((m) => m.characterID === characterID && m.shipID === shipID)
        )
          throw Error("Fleet repair recipient is not selected.");
        await fenceCombat(null);
        const s = await scene();
        guard();
        const anchor = state.entryAnchor;
        if (
          !anchor ||
          !s.entities.some(
            (e) =>
              e.itemID === shipID &&
              e.kind === "ship" &&
              e.ownerID === characterID &&
              e.geometryAvailable &&
              Math.hypot(
                e.position.x - anchor.x,
                e.position.y - anchor.y,
                e.position.z - anchor.z,
              ) <= 500000,
          )
        )
          throw Error("Fleet repair recipient is not present in the current room.");
      };
      const mission = async () => {
        const a = g.authority.read(run.characterID, run.botID, generation);
        return {
          objective: {
            offer: { key: a.room.identity.acceptedKey, status: "accepted" },
            objectiveComplete: false,
            dungeonComplete: false,
          },
        };
      };
      const telemetry = createFleetTelemetry(document, {
        operationID: setup.operationID,
        operationRunID: setup.operationRunID,
        botID: run.botID,
        characterID: run.characterID,
        shipID: member.shipID,
        sessionGeneration: generation,
        account: owner,
      });
      const diagnostic = (kind: string, data: unknown) =>
        telemetry.record(
          kind,
          data && typeof data === "object" && !Array.isArray(data)
            ? { ...data, primaryTargetGeneration: primaryGeneration }
            : data,
        );
      const droneSample = (
        s: ReturnType<typeof decodeSpaceSnapshot>,
        ids: readonly number[],
        targetID: number | null,
      ) => {
        const rat =
          targetID === null
            ? null
            : (s.entities.find((e) => e.itemID === targetID && e.kind === "ship") ?? null);
        return {
          sampledAt: s.sampledAtMs,
          shipID: s.shipID,
          targetID,
          npc: rat
            ? {
                itemID: rat.itemID,
                typeID: rat.typeID,
                groupID: rat.groupID,
                shield: rat.shieldRatio,
                armor: rat.armorRatio,
                hull: rat.hullRatio,
                position: rat.position,
              }
            : null,
          drones: ids.map((id) => {
            const d = s.entities.find((e) => e.itemID === id && e.kind === "drone");
            return d
              ? {
                  itemID: id,
                  ownerID: d.ownerID,
                  controllerID: d.controllerID,
                  targetID: d.targetEntityID,
                  activity: d.droneActivity,
                  distanceToShip:
                    d.geometryAvailable && s.ship?.geometryAvailable
                      ? Math.hypot(
                          d.position.x - s.ship.position.x,
                          d.position.y - s.ship.position.y,
                          d.position.z - s.ship.position.z,
                        )
                      : null,
                  distanceToTarget:
                    d.geometryAvailable && rat?.geometryAvailable
                      ? Math.hypot(
                          d.position.x - rat.position.x,
                          d.position.y - rat.position.y,
                          d.position.z - rat.position.z,
                        )
                      : null,
                }
              : { itemID: id, missing: true };
          }),
        };
      };
      const fighter = createPilotFighter({
        run,
        session: () => session,
        state,
        current,
        guard,
        flight,
        scene,
        ask,
        dungeon,
        mission,
        diagnostic,
        droneSample,
        fenceCombat,
        friendlyMembers: setup.members,
        fenceFriendly,
        sleep: pause,
        ...(db
          ? {
              moduleDocuments: {
                locks: document(`fleet-security-module-lock:${run.botID}`),
                actions: document(`fleet-security-module-action:${run.botID}`),
                reloads: document(`fleet-security-module-reload:${run.botID}`),
              },
            }
          : {}),
        checkBeforeEngage: (target) => {
          guard();
          g.authority.assert(run.characterID, run.botID, generation, epoch);
          g.authority.assertTarget(
            run.characterID,
            run.botID,
            generation,
            target,
            primaryGeneration,
          );
        },
        selectTargets: (targets) => {
          const primary = g.authority.target(run.characterID, run.botID, generation);
          primaryGeneration = primary.generation;
          const fingerprint = JSON.stringify([primary.targetID, primary.generation]);
          if (fingerprint !== lastPrimary) {
            lastPrimary = fingerprint;
            diagnostic("primary-observed", {
              targetID: primary.targetID,
              targetGeneration: primary.generation,
            });
          }
          return targets.filter((t) => t.itemID === primary.targetID);
        },
      });
      let observedShip: any;
      try {
        observedShip = await flight();
        if (observedShip.shipID !== member.shipID)
          throw Error("Assistant ship differs from selected setup.");
      } catch (error) {
        g.stop();
        session.flow.setLivePush(false);
        throw error;
      }
      const settle = async () => {
        if (busy)
          try {
            await busy;
          } catch (error) {
            if (
              !(
                error instanceof FleetRoomRetired || error instanceof DroneTargetUnavailableRefusal
              ) ||
              state.droneUnresolved
            )
              throw error;
          }
        await fighter.settle(current);
      };
      g.add({
        run,
        shipID: observedShip.shipID,
        session,
        current,
        settle,
        generation,
        record: diagnostic,
        lastFleetAt: 0,
        ...(registryFinish ? { registryFinish } : {}),
      });
      let settlementWork: Promise<void> | null = null,
        parking = false,
        parkingAttempted = false;
      async function reconcileNavigation() {
        current();
        const f = await flight();
        if (!f.inSpace || f.docked || typeof f.shipMode !== "string" || /warp/i.test(f.shipMode))
          return;
        const s = await scene();
        if (
          s.shipID !== member!.shipID ||
          s.solarSystemID !== f.solarSystemID ||
          !Number.isFinite(s.sampledAtMs)
        )
          return;
        current();
        const start = Date.now(),
          raw = await ask("dogmaIM", "ItemGetInfo", [member!.shipID]),
          finish = Date.now();
        current();
        const after = await flight();
        if (
          !after.inSpace ||
          after.docked ||
          after.shipID !== f.shipID ||
          after.solarSystemID !== f.solarSystemID ||
          typeof after.shipMode !== "string" ||
          /warp/i.test(after.shipMode)
        )
          return;
        const nativeProof = decodeOwnShipLocation(
          raw,
          { characterID: run.characterID, shipID: member!.shipID, systemID: f.solarSystemID },
          start,
          finish,
          s.sampledAtMs!,
        );
        const keeper = nav.pending?.kind === "fleet-warp" ? await dungeon() : null,
          keeperObservedAt = Date.now();
        current();
        nav.reconcile(
          {
            characterID: run.characterID,
            shipID: f.shipID,
            observedAt: Date.now(),
            inSpace: true,
            docked: false,
            inWarp: false,
            systemID: f.solarSystemID,
            scene: { shipID: s.shipID!, systemID: s.solarSystemID!, sampledAt: s.sampledAtMs! },
            keeper,
            nativeProof,
            keeperObservedAt,
          },
          { characterID: run.characterID, shipID: member!.shipID, mission: lastScope },
          current,
        );
      }
      async function attemptSettlement() {
        if (ended) return;
        if (settlementWork) return settlementWork;
        settlementWork = (async () => {
          if (nav.pending) {
            const deadline = Date.now() + 180000;
            do {
              current();
              try {
                await reconcileNavigation();
              } catch {
                current();
              }
              if (!nav.pending) break;
              await pause(500);
            } while (Date.now() < deadline);
          }
          if (nav.pending) throw Error("Assistant navigation remains unresolved; no replay.");
          await settle();
          if (parkingAttempted) {
            const observed = await flight();
            if (!observed.docked)
              throw Error("Prior parking outcome is unresolved; no parking replay.");
          }
          parkingAttempted = true;
          parking = true;
          let parked: Awaited<ReturnType<typeof parkNearest>>;
          try {
            parked = await (deps.park
              ? deps.park(run, session, () => {}, current)
              : parkWithPolicy(
                  run,
                  session,
                  () => {},
                  current,
                  setup!.parking ?? { mode: "nearest" },
                ));
          } finally {
            parking = false;
          }
          g.finished(run.characterID, {
            phase: "DONE",
            parking: parked,
            memberDecisions: g.authority.memberDecisions(),
            reason: "Member retired after native settlement.",
          });
          ended = true;
          unregister();
          run.report({
            status: "stopped",
            phase: "Docked",
            readout: { destinationID: parked.destinationID } as any,
          });
        })().finally(() => {
          settlementWork = null;
        });
        return settlementWork;
      }
      async function retrySettlement() {
        await task;
        if (!ended) await attemptSettlement();
      }
      const requestRetirement = () => {
        g.retire(run.characterID, "Hosted member Stop requested.");
        if (!stopping) {
          stopping = true;
          if (!parking) session.flow.abortRoute();
        }
        void retrySettlement().catch((error) =>
          run.report({
            status: "paused",
            phase: "Assistant settlement blocked",
            why: error instanceof Error ? error.message : String(error),
          }),
        );
      };
      const unregister = registerCombatRun(
        run,
        owner,
        requestRetirement,
        () => {
          g.stop();
          requestRetirement();
        },
        () => ({
          anchor: g.anchor(),
          memberDecisions: g.authority.memberDecisions(),
          ...g.authority.snapshot(),
        }),
      );
      const task = (async () => {
        try {
          while (active && !stopping && !g.isStopping()) {
            if (!(await g.ready())) {
              await pause(1000);
              continue;
            }
            let scope;
            try {
              scope = g.authority.read(run.characterID, run.botID, generation);
            } catch (error) {
              if (!(error instanceof FleetRoomRetired)) throw error;
              await pause(1000);
              continue;
            }
            const id = scope.room.identity;
            lastScope = structuredClone(id);
            if (nav.pending) {
              try {
                await reconcileNavigation();
              } catch {
                guard();
              }
              if (nav.pending) {
                guard();
                if (!Number.isFinite(nav.pending.at) || Date.now() - nav.pending.at >= 180000)
                  throw Error("Assistant navigation remains unresolved; no replay.");
                await pause(1000);
                continue;
              }
            }
            const f = await flight(),
              d = f.inSpace ? await dungeon() : null;
            guard();
            g.authority.assert(run.characterID, run.botID, generation, scope.serial);
            const roomMatches =
              !!d &&
              d.dungeonID === id.dungeonID &&
              d.instanceID === id.instanceID &&
              d.roomID === id.roomID &&
              f.inSpace &&
              !/warp/i.test(f.shipMode ?? "warp");
            if (roomMatches) await fenceCombat(null);
            if (
              !roomMatches &&
              (g.anchor()?.characterID ?? setup.missionOwnerID) !== setup.missionOwnerID &&
              run.characterID !== (g.anchor()?.characterID ?? setup.missionOwnerID) &&
              !g.authority.memberArrived(g.anchor()!.characterID)
            ) {
              await pause(1000);
              continue;
            }
            const action = await nav.step(
              {
                docked: f.docked === true,
                inSpace: f.inSpace === true,
                inWarp: /warp/i.test(f.shipMode ?? "warp"),
                systemID: f.solarSystemID,
                roomMatches,
                mission: id,
              },
              {
                guard: () => {
                  guard();
                  g.authority.assert(run.characterID, run.botID, generation, scope.serial);
                },
                undock: () => session.flow.undock(),
                route: async (systemID) => {
                  const r = await session.flow.startRoute(systemID);
                  if (!r.started) throw Error(r.reason);
                },
                warp: () =>
                  warpToFleetMember(
                    session.flow.flying.bridgeDo,
                    session.flow.flying.readFlightNow,
                    setup.missionOwnerID,
                  ),
              },
            );
            if (action === "arrived") {
              g.authority.arrived(run.characterID, run.botID, generation, epoch);
              const fresh = await scene();
              guard();
              g.authority.assert(run.characterID, run.botID, generation, epoch);
              if (lastArrival !== epoch) {
                lastArrival = epoch;
                diagnostic("room-arrival", {
                  acceptedKey: id.acceptedKey,
                  dungeonID: id.dungeonID,
                  instanceID: id.instanceID,
                  roomID: id.roomID,
                  roomGeneration: epoch,
                  keeper: d,
                  shipID: fresh.shipID,
                  sceneSampledAt: fresh.sampledAtMs,
                });
              }
              const primary = g.authority.target(run.characterID, run.botID, generation);
              if (
                !primary.targetID ||
                !fresh.entities.some(
                  (e) => e.itemID === primary.targetID && isSecurityTarget(id, e),
                )
              ) {
                if (!primary.targetID) missingPrimary = null;
                else {
                  if (
                    !missingPrimary ||
                    missingPrimary.id !== primary.targetID ||
                    missingPrimary.generation !== primary.generation
                  )
                    missingPrimary = {
                      id: primary.targetID,
                      generation: primary.generation,
                      since: Date.now(),
                    };
                  if (Date.now() - missingPrimary.since >= 90000)
                    throw Error("The shared primary remained unavailable before dispatch.");
                }
                await pause(1000);
                continue;
              }
              missingPrimary = null;
              busy = fighter
                .tick(id, () => {
                  guard();
                  g.authority.assert(run.characterID, run.botID, generation, epoch);
                })
                .then(() => {});
              try {
                await busy;
              } catch (error) {
                if (!(error instanceof FleetRoomRetired) || state.droneUnresolved) throw error;
              } finally {
                busy = null;
              }
            }
            await pause(1000);
          }
        } catch (error) {
          g.retire(run.characterID, error instanceof Error ? error.message : String(error));
          run.report({
            status: "paused",
            phase: "Fleet Security member needs attention",
            why: error instanceof Error ? error.message : String(error),
          });
        } finally {
          try {
            await attemptSettlement();
          } catch (error) {
            run.report({
              status: "paused",
              phase: "Assistant settlement blocked",
              why: error instanceof Error ? error.message : String(error),
            });
          }
        }
      })();
      return {
        async stop() {
          g.retire(run.characterID, "Hosted member retirement.");
          if (!stopping) {
            stopping = true;
            if (!parking) session.flow.abortRoute();
          }
          await retrySettlement();
          if (!ended) throw Error("Assistant custody remains unresolved.");
          active = false;
          session.flow.setLivePush(false);
        },
      };
    },
  };
  return { owner, assistant };
}
