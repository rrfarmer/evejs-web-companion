import { combatWorkDeadline } from "../timePolicy.ts";
import { registerCombatRun } from "../control.ts";
import path from "node:path";
import { createRequire } from "node:module";
import {
  pluginDataDir,
  type BackendRun,
  type PluginRunContext,
} from "../../../../web/src/plugin-api/backend.ts";
import {
  createPilotSession,
  type PilotSession,
} from "../../../../web/src/plugin-api/pilotSession.ts";
import { decodeFlightStatus, getFlightStatus } from "../../../../web/src/plugin-api/flying.ts";
import { decodeParkingPolicy, parkWithPolicy, type ParkingPolicy } from "../../shared/parking.ts";
import { settleFleetMember } from "../../miningFleet/settle.ts";
import { registerRun, runOwner, runExpiry } from "../../runControl.ts";
import { openCombatStore } from "../../operations/combatStore.ts";
import { createNativePatrolPeer } from "./nativePeer.ts";
import { createPatrolOperation, type PatrolPeer } from "./operation.ts";
import type { PatrolWaypoint } from "./navigation.ts";
import { readCombatShipClass, readHeldCombatAnchor, selectCombatAnchor } from "../anchor.ts";
type Doc = { read(): unknown; write(v: unknown): void };
type Member = { characterID: number; shipID: number; required?: boolean };
type Setup = {
  operationID: string;
  operationRunID: string;
  leaderID: number;
  systemID: number;
  mode: "BELT_PATROL" | "GATE_PATROL";
  observationSeconds: number;
  parking?: ParkingPolicy;
  fleetMoves?: readonly { characterID: number; shipID: number; fromFleetID: number }[];
  members: readonly Member[];
  registry?: true;
};
const positive = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0,
  require = createRequire(import.meta.url),
  { createDocumentStore } = require("../../documentStore.cjs");
function decode(v: unknown): Setup | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const x = v as Record<string, any>;
  if (
    Object.keys(x).some(
      (k) =>
        ![
          "operationID",
          "operationRunID",
          "leaderID",
          "systemID",
          "mode",
          "observationSeconds",
          "parking",
          "fleetMoves",
          "members",
          "registry",
        ].includes(k),
    ) ||
    typeof x.operationID !== "string" ||
    !x.operationID ||
    typeof x.operationRunID !== "string" ||
    !x.operationRunID ||
    !positive(x.leaderID) ||
    !positive(x.systemID) ||
    !["BELT_PATROL", "GATE_PATROL"].includes(x.mode) ||
    !Number.isSafeInteger(x.observationSeconds) ||
    x.observationSeconds < 5 ||
    x.observationSeconds > 120 ||
    !Array.isArray(x.members) ||
    !x.members.length ||
    x.members.some(
      (m: any) =>
        !m ||
        (m.required !== undefined && typeof m.required !== "boolean") ||
        !positive(m.characterID) ||
        !positive(m.shipID),
    ) ||
    new Set(x.members.map((m: any) => m.characterID)).size !== x.members.length ||
    new Set(x.members.map((m: any) => m.shipID)).size !== x.members.length ||
    !x.members.some((m: any) => m.characterID === x.leaderID) ||
    (x.registry !== undefined && x.registry !== true) ||
    (x.parking !== undefined && !decodeParkingPolicy(x.parking))
  )
    return null;
  if (
    x.fleetMoves !== undefined &&
    (!Array.isArray(x.fleetMoves) ||
      x.fleetMoves.some(
        (m: any) =>
          !m ||
          !positive(m.characterID) ||
          !positive(m.shipID) ||
          !positive(m.fromFleetID) ||
          !x.members.some((p: any) => p.characterID === m.characterID && p.shipID === m.shipID),
      ) ||
      new Set(x.fleetMoves.map((m: any) => m.characterID)).size !== x.fleetMoves.length)
  )
    return null;
  return structuredClone(v) as Setup;
}
type Entry = {
  run: PluginRunContext;
  session: PilotSession;
  current(): void;
  unregister(): void;
  active: boolean;
  expiry: number;
  shipClass: number | null;
  finish?: (receipt: unknown) => void;
};
/** Hosted members share the existing group assembly and fighter. */
export function createPatrolRuns(
  deps: {
    document?: (name: string) => Doc;
    attach?: typeof createPilotSession;
    sleep?: (ms: number) => Promise<void>;
    peer?: typeof createNativePatrolPeer;
    operation?: typeof createPatrolOperation;
  } = {},
) {
  const db = deps.document
      ? null
      : createDocumentStore(path.join(pluginDataDir(), "combat-patrol.sqlite")),
    document = deps.document ?? ((name: string) => db.document(name) as Doc),
    sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    groups = new Map<string, ReturnType<typeof makeGroup>>();
  function makeGroup(setup: Setup) {
    const key = JSON.stringify([setup.operationID, setup.operationRunID]),
      signature = JSON.stringify(setup),
      entries = new Map<number, Entry>();
    let operation: ReturnType<typeof createPatrolOperation> | null = null,
      loop: Promise<void> | null = null,
      ending: Promise<void> | null = null,
      stopping = false,
      ended = false,
      anchor: { characterID: number; shipID: number; size: number } | null = null;
    const report = (status: "running" | "paused", phase: string, why?: string) => {
      for (const e of entries.values())
        if (e.active)
          e.run.report({
            status,
            phase,
            ...(why ? { why } : {}),
            ...(anchor ? { readout: { anchor } as any } : {}),
          });
    };
    async function waypoints(e: Entry): Promise<PatrolWaypoint[]> {
      e.current();
      const response = await e.run.fetch(
          new URL(`/api/client-data/system-objects/${setup.systemID}`, e.run.baseUrl),
        ),
        body = await response.json();
      e.current();
      if (!response.ok || body?.available !== true || !Array.isArray(body.objects))
        throw Error("Native patrol waypoint catalogue is unavailable.");
      const groupID = setup.mode === "BELT_PATROL" ? 9 : 10,
        objects = body.objects.filter((o: any) => o?.groupID === groupID);
      if (
        !objects.length ||
        objects.some((o: any) => !positive(o.itemID) || !positive(o.typeID)) ||
        new Set(objects.map((o: any) => o.itemID)).size !== objects.length
      )
        throw Error("Patrol waypoint identities are incomplete.");
      const rows: PatrolWaypoint[] = [];
      for (let i = 0; i < objects.length; i += 25) {
        const chunk = objects.slice(i, i + 25),
          ids = [
            ...new Set(
              chunk.flatMap((o: any) => [
                o.itemID,
                ...(groupID === 10 && positive(o.destinationID) ? [o.destinationID] : []),
              ]),
            ),
          ],
          response = await e.run.fetch(new URL("/api/names", e.run.baseUrl), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ items: ids.map((id) => ({ kind: "evelocation", id })) }),
          }),
          named = await response.json();
        e.current();
        if (!response.ok || named?.capped === true || !named?.names)
          throw Error("Patrol waypoint names are unavailable.");
        for (const o of chunk) {
          const direct = named.names[`evelocation:${o.itemID}`],
            destination = groupID === 10 ? named.names[`evelocation:${o.destinationID}`] : null,
            name =
              typeof direct === "string" && direct.trim()
                ? direct
                : typeof destination === "string" && destination.trim()
                  ? `Stargate (${destination.trim()})`
                  : null;
          if (!name) throw Error("A patrol waypoint name is unavailable.");
          rows.push({ systemID: setup.systemID, itemID: o.itemID, groupID, name: name.trim() });
        }
      }
      return rows.sort((a, b) => a.itemID - b.itemID);
    }
    async function verifyDock(e: Entry) {
      e.current();
      const m = setup.members.find((x) => x.characterID === e.run.characterID)!,
        f = decodeFlightStatus(
          (
            await getFlightStatus({
              ...e.session.flow.requestOptions(),
              baseUrl: e.run.baseUrl,
              fetch: e.run.fetch,
            })
          ).flight,
        ),
        dest = f.stationID ?? f.structureID;
      e.current();
      if (
        !f.docked ||
        f.inSpace ||
        f.shipID !== m.shipID ||
        !positive(dest) ||
        (setup.parking?.mode === "selected" &&
          (dest !== setup.parking.destinationID || f.solarSystemID !== setup.parking.systemID))
      )
        throw Error("Patrol dock proof is unavailable.");
      return { destinationID: dest, systemID: f.solarSystemID };
    }
    async function parkBeforeOperation(e: Entry) {
      const policy = setup.parking ?? { mode: "nearest" as const },
        doc = document(`patrol-early-parking:${e.run.botID}`),
        identity = JSON.stringify([e.run.botID, e.run.characterID, policy]),
        prior = doc.read() as any;
      if (
        prior !== null &&
        (!prior ||
          prior.version !== 1 ||
          prior.identity !== identity ||
          typeof prior.pending !== "boolean")
      )
        throw Error("Patrol parking journal is unreadable.");
      await settleFleetMember(e.run, e.session, e.current);
      try {
        const proof = await verifyDock(e);
        doc.write({ version: 1, identity, pending: false, destinationID: proof.destinationID });
        return;
      } catch {
        e.current();
      }
      if (prior?.pending || prior?.destinationID)
        throw Error("Patrol parking remains unresolved; no route replay.");
      doc.write({ version: 1, identity, pending: true, destinationID: null });
      await parkWithPolicy(e.run, e.session, () => {}, e.current, policy);
      const proof = await verifyDock(e);
      doc.write({ version: 1, identity, pending: false, destinationID: proof.destinationID });
    }
    async function finish() {
      if (ended) return;
      if (ending) return ending;
      ending = (async () => {
        stopping = true;
        if (operation) {
          await operation.stop();
          if (loop) await loop;
          if (operation.snapshot().state !== "STOPPED")
            throw Error("Patrol settlement remains unresolved.");
        } else {
          if (loop) await loop;
          for (const e of entries.values()) if (e.active) await parkBeforeOperation(e);
        }
        for (const e of entries.values())
          if (e.active) {
            const parking = await verifyDock(e);
            e.current();
            e.finish?.({
              phase: "DONE",
              activity: "PATROL",
              completed: [],
              parking,
              anchor,
              patrolState: operation?.snapshot() ?? null,
              waypoint: operation?.authority().waypoint ?? null,
              reason: "Patrol stopped after settlement.",
            });
            e.run.report({
              status: "stopped",
              phase: "Patrol docked",
              readout: {
                operationID: setup.operationID,
                operationRunID: setup.operationRunID,
                parking,
                anchor,
              } as any,
            });
            e.unregister();
            e.active = false;
            e.session.flow.setLivePush(false);
          }
        ended = true;
      })().finally(() => {
        ending = null;
      });
      return ending;
    }
    async function retire(id: number) {
      const m = setup.members.find((m) => m.characterID === id),
        e = entries.get(id);
      if (!m || !e || !e.active) return;
      if (m.required !== false) return finish();
      if (loop && !operation)
        throw Error(
          "Patrol assembly is unresolved; independent retirement requires its original native state.",
        );
      const proof = operation
        ? await operation.retire(id, "Optional member retirement requested.")
        : null;
      if (operation && !proof) throw Error("Patrol member retirement is not qualified.");
      if (!operation) await parkBeforeOperation(e);
      const parking = await verifyDock(e);
      e.finish?.({
        phase: "DONE",
        retired: true,
        activity: "PATROL",
        completed: [],
        parking,
        anchor,
        reason: "Optional pilot retired after native settlement.",
      });
      e.run.report({
        status: "stopped",
        phase: "Patrol member docked",
        readout: { parking, anchor } as any,
      });
      e.unregister();
      e.active = false;
      e.session.flow.setLivePush(false);
    }
    function begin() {
      if (loop || entries.size !== setup.members.length) return;
      loop = (async () => {
        try {
          const selected = selectCombatAnchor(
            setup.members.map((m) => ({ ...m, shipClass: entries.get(m.characterID)!.shipClass })),
          );
          if (!selected || selected.characterID !== setup.leaderID || selected.shipClass === null)
            throw Error("Patrol anchor no longer matches the largest verified selected hull.");
          anchor = {
            characterID: selected.characterID,
            shipID: selected.shipID,
            size: selected.shipClass,
          };
          const chief = entries.get(setup.leaderID)!,
            points = await waypoints(chief),
            members = setup.members.map((m) => {
              const e = entries.get(m.characterID)!;
              return {
                ...(deps.peer ?? createNativePatrolPeer)({
                  run: e.run,
                  session: e.session,
                  shipID: m.shipID,
                  systemID: setup.systemID,
                  members: setup.members,
                  parking: setup.parking ?? { mode: "nearest" },
                  document,
                  operation: () => {
                    if (!operation) throw Error("Patrol authority is unavailable.");
                    return operation;
                  },
                  current: e.current,
                  sleep,
                }),
                ...(m.required !== undefined ? { required: m.required } : {}),
              };
            });
          operation = (deps.operation ?? createPatrolOperation)({
            operationID: setup.operationID,
            operationRunID: setup.operationRunID,
            leaderID: setup.leaderID,
            waypoints: points,
            peers: members,
            observationMs: setup.observationSeconds * 1000,
            successor: async (ids) => {
              const candidates = await Promise.all(
                ids.map(async (id) => {
                  const e = entries.get(id)!,
                    m = setup.members.find((m) => m.characterID === id)!;
                  return readHeldCombatAnchor(e.run, e.session, m, e.current, true);
                }),
              );
              const selected = selectCombatAnchor(candidates, anchor?.size ?? 0);
              if (!selected || selected.shipClass === null) return null;
              const previous = anchor;
              anchor = {
                characterID: selected.characterID,
                shipID: selected.shipID,
                size: selected.shipClass,
              };
              document(`patrol-anchor:${key}`).write({
                version: 1,
                operationID: setup.operationID,
                runID: setup.operationRunID,
                previous,
                anchor,
                observedAt: Date.now(),
              });
              return selected.characterID;
            },
            deadline: combatWorkDeadline(setup.members, (id) => entries.get(id)!.expiry),
            ...(setup.fleetMoves ? { fleetMoves: setup.fleetMoves } : {}),
            document: document(`patrol-operation:${key}`),
            assemblyDocument: document(`patrol-assembly:${key}`),
          });
          let last = "";
          while (!stopping && operation.snapshot().state !== "STOPPED") {
            await operation.tick();
            const s = operation.snapshot();
            if (s.state !== last) {
              last = s.state;
              report("running", `Patrol ${s.state.toLowerCase()}`);
            }
            if (!stopping && s.state !== "STOPPED") await sleep(1000);
          }
        } catch (error) {
          if (!stopping) {
            stopping = true;
            report(
              "paused",
              "Patrol needs attention",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();
      void loop.then(() => {
        if (operation?.snapshot().state === "STOPPED" && !ended)
          void finish().catch((e) =>
            report(
              "paused",
              "Patrol settlement blocked",
              e instanceof Error ? e.message : String(e),
            ),
          );
      });
    }
    return {
      signature,
      retire,
      add(e: Entry) {
        if (
          stopping ||
          ended ||
          entries.has(e.run.characterID) ||
          !setup.members.some((m) => m.characterID === e.run.characterID)
        )
          throw Error("Patrol member identity changed.");
        entries.set(e.run.characterID, e);
      },
      begin,
      finish,
      status: () => ({
        activity: "PATROL",
        anchor,
        memberDecisions: operation?.snapshot().memberDecisions ?? [],
        epoch: operation?.snapshot().generation ?? null,
        waypointIndex: operation?.snapshot().index ?? null,
        waypoint: operation?.authority().waypoint ?? null,
        primaryID: operation?.authority().primary ?? null,
        state: operation?.snapshot().state ?? "FORMING",
      }),
      get ended() {
        return ended;
      },
    };
  }
  const member: BackendRun = {
    check(v) {
      const setup = decode(v);
      return setup
        ? {
            ok: true,
            setup: setup as any,
            name: "Combat patrol",
            policy: { riskClasses: ["inventory", "fleet", "combat"], restartSafe: false },
          }
        : { ok: false, refusal: "Select a valid patrol system and held pilots." };
    },
    async start(run) {
      const setup = decode(run.setup),
        m = setup?.members.find((x) => x.characterID === run.characterID);
      if (!setup || !m || run.resumed || run.held.characterID !== run.characterID)
        throw Error("Patrol hosted identity is unavailable.");
      const [owner, expiry] = await Promise.all([runOwner(run), runExpiry(run)]);
      let finish: Entry["finish"];
      if (setup.registry) {
        const response = await run.fetch(new URL("/api/plugins/uoc/world", run.baseUrl)),
          body = await response.json();
        if (!response.ok || body?.ok !== true || typeof body.worldID !== "string" || !body.worldID)
          throw Error("Patrol world scope is unavailable.");
        const world = body.worldID,
          store = openCombatStore();
        try {
          store.bindMember(
            world,
            setup.operationID,
            setup.operationRunID,
            owner,
            run.characterID,
            m.shipID,
            setup,
            run.botID,
          );
        } finally {
          store.close();
        }
        finish = (receipt) => {
          const store = openCombatStore();
          try {
            store.finishMember(
              world,
              setup.operationID,
              setup.operationRunID,
              owner,
              run.characterID,
              run.botID,
              receipt,
            );
          } finally {
            store.close();
          }
        };
      }
      const session = await (deps.attach ?? createPilotSession)(run),
        generation = session.flow.flying.sessionGeneration();
      let active = true;
      const current = () => {
        if (
          !active ||
          session.flow.flying.isSessionClosing() ||
          session.flow.flying.sessionGeneration() !== generation ||
          session.store.station.get().online?.characterID !== run.characterID
        )
          throw Error("Patrol held session changed.");
      };
      try {
        current();
        const f = decodeFlightStatus(
          (
            await getFlightStatus({
              ...session.flow.requestOptions(),
              baseUrl: run.baseUrl,
              fetch: run.fetch,
            })
          ).flight,
        );
        if (!f.docked || f.shipID !== m.shipID || f.solarSystemID !== setup.systemID)
          throw Error("Patrol pilot must be docked in the selected ship and system.");
        const shipClass = await readCombatShipClass(run, f.shipTypeID ?? 0, current),
          key = JSON.stringify([setup.operationID, setup.operationRunID]);
        let g = groups.get(key);
        if (g && g.signature !== JSON.stringify(setup)) throw Error("Patrol group setup changed.");
        if (!g) {
          g = makeGroup(setup);
          groups.set(key, g);
        }
        const entry: Entry = {
          run,
          session,
          current,
          active: true,
          expiry,
          shipClass,
          unregister: () => {},
          ...(finish ? { finish } : {}),
        };
        const request = (whole: boolean) => {
          void (whole ? g!.finish() : g!.retire(run.characterID)).catch((error) =>
            run.report({
              status: "paused",
              phase: "Patrol settlement blocked",
              why: error instanceof Error ? error.message : String(error),
            }),
          );
        };
        entry.unregister = registerCombatRun(
          run,
          owner,
          () => request(false),
          () => request(true),
          () => g!.status(),
        );
        try {
          g.add(entry);
        } catch (error) {
          entry.unregister();
          throw error;
        }
        run.report({ status: "running", phase: "Waiting for patrol fleet" });
        g.begin();
        return {
          async stop() {
            await g!.retire(run.characterID);
            if (entry.active && !g!.ended) throw Error("Patrol custody remains unresolved.");
            active = false;
          },
        };
      } catch (error) {
        active = false;
        session.flow.setLivePush(false);
        throw error;
      }
    },
  };
  return { member };
}
