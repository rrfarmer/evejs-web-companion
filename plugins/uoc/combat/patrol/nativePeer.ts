import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import {
  decodeFlightStatus,
  decodeSpaceSnapshot,
  getFlightStatus,
  getSpaceSnapshot,
} from "../../../../web/src/plugin-api/flying.ts";
import { createAnomalyFleetPeer } from "../anomalies/nativePeer.ts";
import { createPilotFighter, type PilotFighterState } from "../pilotFighter.ts";
import { parkWithPolicy, type ParkingPolicy } from "../../shared/parking.ts";
import { createPatrolNavigation, type PatrolWaypoint } from "./navigation.ts";
import { isQualifiedPatrolNpc } from "./targets.ts";
import type { PatrolIdentity, PatrolPeer } from "./operation.ts";
type Doc = { read(): unknown; write(v: unknown): void };
type Authority = {
  authority(): {
    state: string;
    waypoint: PatrolWaypoint;
    identity: PatrolIdentity;
    primary: number | null;
    primaryGeneration: number;
  };
  fence(characterID: number, target: number | null, epoch: number): Promise<void>;
};
/** Actual held pilot adapter for the shared fleet assembly and fighter. */
export function createNativePatrolPeer(c: {
  run: PluginRunContext;
  session: PilotSession;
  shipID: number;
  systemID: number;
  members: readonly { characterID: number; shipID: number }[];
  parking: ParkingPolicy;
  document: (name: string) => Doc;
  operation: () => Authority;
  current(): void;
  sleep(ms: number): Promise<void>;
}): PatrolPeer {
  const { run, session, shipID } = c,
    generation = session.flow.flying.sessionGeneration(),
    guard = () => {
      c.current();
      if (
        session.flow.flying.isSessionClosing() ||
        session.flow.flying.sessionGeneration() !== generation ||
        session.store.station.get().online?.characterID !== run.characterID
      )
        throw Error("Patrol held pilot changed.");
    },
    options = () => ({ ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch });
  const flight = async () => {
    guard();
    const f = decodeFlightStatus((await getFlightStatus(options())).flight);
    guard();
    if (f.shipID !== shipID || f.solarSystemID !== c.systemID)
      throw Error("Patrol pilot ship or system changed.");
    return f;
  };
  const scene = async () => {
    guard();
    const s = decodeSpaceSnapshot((await getSpaceSnapshot(options())).space);
    guard();
    if (
      !s.inSpace ||
      s.stateValid === false ||
      s.shipID !== shipID ||
      s.solarSystemID !== c.systemID ||
      !s.ship?.geometryAvailable ||
      s.sampledAtMs === null
    )
      throw Error("Patrol scene is unavailable.");
    return s;
  };
  const ask = async (service: string, method: string, args: unknown[] = [], of?: number) => {
    guard();
    const response = await run.fetch(new URL("/api/bridge/call", run.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service,
          method,
          args,
          pilot: true,
          confirm: true,
          ...(of === undefined ? {} : { of }),
        }),
      }),
      body = await response.json();
    guard();
    if (!response.ok || body?.ok === false)
      throw Error(body?.message ?? body?.error ?? "Patrol native read failed.");
    return body.result;
  };
  const navigators = new Map<number, ReturnType<typeof createPatrolNavigation>>(),
    nav = (w: PatrolWaypoint) => {
      let n = navigators.get(w.itemID);
      if (!n) {
        n = createPatrolNavigation(run, session, {
          shipID,
          waypoint: w,
          current: guard,
          sleep: c.sleep,
          document: c.document(`patrol-nav:${JSON.stringify([run.botID, w.systemID, w.itemID])}`),
        });
        navigators.set(w.itemID, n);
      }
      return n;
    };
  const state: PilotFighterState<PatrolIdentity> = {
    currentIdentity: null,
    entryAnchor: null,
    droneUnresolved: false,
  };
  let selectedEpoch = -1;
  const fence = async (target: number | null) => {
    guard();
    await c.operation().fence(run.characterID, target, selectedEpoch);
    guard();
  };
  const friendly = async (characterID: number, targetShipID: number) => {
    if (
      characterID === run.characterID ||
      !c.members.some((m) => m.characterID === characterID && m.shipID === targetShipID)
    )
      throw Error("Patrol repair recipient is not selected.");
    await fence(null);
    const s = await scene();
    guard();
    if (
      !s.entities.some(
        (e) =>
          e.itemID === targetShipID &&
          e.kind === "ship" &&
          e.ownerID === characterID &&
          e.geometryAvailable,
      )
    )
      throw Error("Patrol repair recipient is not on this waypoint.");
  };
  const parkingDocument = c.document(`patrol-parking:${run.botID}`),
    parkingIdentity = JSON.stringify([run.botID, run.characterID, shipID, c.parking]),
    saved = parkingDocument.read() as any;
  if (
    saved !== null &&
    (!saved ||
      saved.version !== 1 ||
      saved.identity !== parkingIdentity ||
      typeof saved.pending !== "boolean" ||
      !(
        saved.destinationID === null ||
        (Number.isSafeInteger(saved.destinationID) && saved.destinationID > 0)
      ))
  )
    throw Error("Patrol parking journal is unreadable.");
  let parking = saved ?? {
    version: 1,
    identity: parkingIdentity,
    pending: false,
    destinationID: null,
  };
  async function parkOnce() {
    guard();
    let f = decodeFlightStatus((await getFlightStatus(options())).flight);
    guard();
    let destination = f.stationID ?? f.structureID;
    if (
      f.docked &&
      !f.inSpace &&
      f.shipID === shipID &&
      typeof destination === "number" &&
      destination > 0 &&
      (c.parking.mode === "nearest" ||
        (destination === c.parking.destinationID && f.solarSystemID === c.parking.systemID))
    ) {
      if (parking.destinationID !== null && parking.destinationID !== destination)
        throw Error("Patrol parking destination changed.");
      parking = { ...parking, pending: false, destinationID: destination };
      parkingDocument.write(parking);
      return { characterID: run.characterID, shipID, docked: true, destinationID: destination };
    }
    if (parking.pending || parking.destinationID !== null)
      throw Error("Patrol parking remains unresolved; no route replay.");
    parking = { ...parking, pending: true };
    parkingDocument.write(parking);
    guard();
    const p = await parkWithPolicy(run, session, () => {}, guard, c.parking);
    guard();
    f = decodeFlightStatus((await getFlightStatus(options())).flight);
    destination = f.stationID ?? f.structureID;
    if (
      !f.docked ||
      f.inSpace ||
      f.shipID !== shipID ||
      destination !== p.destinationID ||
      (c.parking.mode === "selected" &&
        (destination !== c.parking.destinationID || f.solarSystemID !== c.parking.systemID))
    )
      throw Error("Patrol parking is not confirmed.");
    parking = { ...parking, pending: false, destinationID: destination };
    parkingDocument.write(parking);
    return { characterID: run.characterID, shipID, docked: true, destinationID: destination };
  }
  const fighter = createPilotFighter<PatrolIdentity>({
    run,
    session: () => session,
    state,
    current: guard,
    guard,
    flight,
    scene,
    ask,
    mission: async () => {
      throw Error("Patrol has no mission.");
    },
    dungeon: async () => null,
    diagnostic() {},
    droneSample: () => null,
    fenceCombat: fence,
    friendlyMembers: c.members,
    fenceFriendly: friendly,
    sleep: c.sleep,
    moduleDocuments: {
      locks: c.document(`patrol-lock:${run.botID}`),
      actions: c.document(`patrol-action:${run.botID}`),
      reloads: c.document(`patrol-reload:${run.botID}`),
    },
    isQualifiedTarget: (_id, row) => isQualifiedPatrolNpc(row),
    confirmTargetAbsent: async ({ target, ids, preEngage }) => {
      await fence(null);
      const fresh = await scene();
      guard();
      if (
        !ids.length ||
        !ids.every((id) =>
          fresh.entities.some(
            (e) =>
              e.itemID === id &&
              e.kind === "drone" &&
              e.ownerID === run.characterID &&
              e.controllerID === shipID,
          ),
        )
      )
        throw Error("Patrol drone custody is unavailable.");
      return (
        preEngage.sampledAtMs !== null &&
        fresh.sampledAtMs !== null &&
        fresh.sampledAtMs > preEngage.sampledAtMs &&
        !fresh.entities.some((e) => e.itemID === target)
      );
    },
    selectTargets: (targets) => {
      const a = c.operation().authority();
      selectedEpoch = a.primaryGeneration;
      return targets.filter((t) => t.itemID === a.primary);
    },
    checkBeforeEngage: (target) => {
      const a = c.operation().authority();
      if (a.primary !== target || a.primaryGeneration !== selectedEpoch)
        throw Error("Patrol primary changed.");
    },
  });
  return {
    ...createAnomalyFleetPeer({ run, session, shipID, systemID: c.systemID, current: guard }),
    async navigate(w) {
      state.entryAnchor = null;
      await nav(w).navigate();
    },
    async assertAtWaypoint(w) {
      await nav(w).assertAtWaypoint();
    },
    async view() {
      const s = await scene();
      const a = c.operation().authority(),
        entry = s.entities.find(
          (e) =>
            e.itemID === a.waypoint.itemID &&
            e.groupID === a.waypoint.groupID &&
            e.geometryAvailable,
        );
      if (!entry || !s.ship) throw Error("Patrol waypoint is not on the held scene.");
      return {
        characterID: run.characterID,
        shipID,
        systemID: c.systemID,
        shipPosition: s.ship.position,
        waypointPosition: entry.position,
        entities: s.entities,
      };
    },
    fighter: {
      async tick(id, current) {
        const a = c.operation().authority();
        selectedEpoch = a.primaryGeneration;
        const s = await scene(),
          entry = s.entities.find(
            (e) =>
              e.itemID === a.waypoint.itemID &&
              e.groupID === a.waypoint.groupID &&
              e.geometryAvailable,
          );
        if (!entry) throw Error("Patrol waypoint anchor is unavailable.");
        state.entryAnchor = entry.position;
        await fighter.tick(id, current);
      },
    },
    async settle(current) {
      await fighter.settle(current);
      return { characterID: run.characterID, shipID, modulesInactive: true, dronesSafe: true };
    },
    park: parkOnce,
  };
}
