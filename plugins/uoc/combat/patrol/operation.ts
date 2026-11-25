import { createCombatRoster, CombatRosterChanged } from "../roster.ts";
import {
  createFleetAssembly,
  type FleetAssemblyPeer,
  type FleetMoveAuthorization,
} from "../../miningFleet/fleetAssembly.ts";
import { isQualifiedPatrolNpc } from "./targets.ts";
import { SecurityTargetUnobserved } from "../pilotFighter.ts";
import type { PatrolWaypoint } from "./navigation.ts";
type Doc = { read(): unknown; write(v: unknown): void };
type Position = { x: number; y: number; z: number };
export type PatrolIdentity = {
  kind: "patrol";
  operationID: string;
  operationRunID: string;
  systemID: number;
  waypointID: number;
  waypointGeneration: number;
};
export type PatrolEntity = {
  itemID: number;
  kind: string | null;
  categoryID: number | null;
  isNpc: boolean;
  isSelf: boolean;
  geometryAvailable?: boolean;
  npcEntityType?: string | null;
  typeID: number | null;
  groupID: number | null;
  position: Position;
};
export interface PatrolPeer extends FleetAssemblyPeer {
  required?: boolean;
  view(): Promise<{
    characterID: number;
    shipID: number;
    systemID: number;
    shipPosition: Position;
    waypointPosition: Position;
    entities: readonly PatrolEntity[];
  }>;
  navigate(waypoint: PatrolWaypoint): Promise<void>;
  assertAtWaypoint(waypoint: PatrolWaypoint): Promise<void>;
  fighter: { tick(identity: PatrolIdentity, current: () => void): Promise<void> };
  settle(
    current: () => void,
  ): Promise<{
    characterID: number;
    shipID: number;
    modulesInactive: boolean;
    dronesSafe: boolean;
  }>;
  park(): Promise<{ characterID: number; shipID: number; docked: boolean; destinationID: number }>;
}
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
/** Patrol objective controller: it reuses the fleet assembly, navigator and
 * shared fighter. Empty grids only advance a timed patrol; they are not kills
 * or dungeon completion. Every movement is settled before the next waypoint. */
export function createPatrolOperation(c: {
  operationID: string;
  operationRunID: string;
  leaderID: number;
  waypoints: readonly PatrolWaypoint[];
  peers: readonly PatrolPeer[];
  fleetMoves?: readonly FleetMoveAuthorization[];
  document: Doc;
  assemblyDocument: Doc;
  observationMs: number;
  deadline: number;
  now?: () => number;
  successor?: (ids: readonly number[]) => Promise<number | null>;
}) {
  const now = c.now ?? Date.now,
    original = [...c.peers];
  let peers = [...original],
    leader = peers.find((p) => p.characterID === c.leaderID),
    waypoints = [...c.waypoints];
  if (
    !c.operationID ||
    !c.operationRunID ||
    !leader ||
    !peers.length ||
    new Set(peers.map((p) => p.characterID)).size !== peers.length ||
    new Set(peers.map((p) => p.shipID)).size !== peers.length ||
    !waypoints.length ||
    new Set(waypoints.map((w) => w.itemID)).size !== waypoints.length ||
    waypoints.some(
      (w) =>
        !positive(w.systemID) || !positive(w.itemID) || ![9, 10].includes(w.groupID) || !w.name,
    ) ||
    new Set(waypoints.map((w) => w.systemID)).size !== 1 ||
    !Number.isFinite(c.observationMs) ||
    c.observationMs <= 0 ||
    !Number.isFinite(c.deadline)
  )
    throw Error("Patrol operation identity is invalid.");
  if (c.document.read() !== null)
    throw Error("Patrol operation already retains custody; no replay.");
  let ordered = [leader, ...peers.filter((p) => p !== leader)];
  const roster = createCombatRoster(original),
    retiredParks = new Map<number, unknown>();
  const initialOrder = ordered,
    assembly =
      initialOrder.length > 1
        ? createFleetAssembly(
            c.assemblyDocument,
            c.operationID,
            c.operationRunID,
            ordered,
            now,
            c.fleetMoves,
          )
        : null;
  let fleetWork: Promise<boolean> | null = null;
  function ensureFleet() {
    if (roster.snapshot().length) {
      return (async () => {
        const rows = await Promise.all(peers.map((p) => p.read()));
        for (const r of rows)
          if (
            r.state !== "ready" ||
            peers.some((p) => !r.memberIDs.includes(p.characterID)) ||
            r.memberIDs.some((id) => !original.some((p) => p.characterID === id)) ||
            rows.some(
              (v) =>
                v.state !== "ready" ||
                v.fleetID !== r.fleetID ||
                JSON.stringify([...v.memberIDs].sort()) !== JSON.stringify([...r.memberIDs].sort()),
            )
          )
            throw Error("Remaining patrol fleet is not verified.");
        return true;
      })();
    }
    if (!assembly) return Promise.resolve(true);
    if (fleetWork) return fleetWork;
    fleetWork = assembly
      .step()
      .then((x) => x === "ready")
      .finally(() => {
        fleetWork = null;
      });
    return fleetWork;
  }
  let state: "FORMING" | "TRAVEL" | "OBSERVING" | "SETTLING" | "STOPPED" | "BLOCKED" = "FORMING",
    index = 0,
    generation = 1,
    primary: number | null = null,
    primaryGeneration = 0,
    idleSince: number | null = null,
    inflight: Promise<void> | null = null,
    stopping = false,
    retiring = false;
  const settlements: unknown[] = [],
    parks: unknown[] = [];
  const save = () =>
    c.document.write({
      version: 1,
      operationID: c.operationID,
      operationRunID: c.operationRunID,
      state,
      index,
      generation,
      primary,
      primaryGeneration,
      settlements,
      parks,
      memberDecisions: roster.snapshot(),
      retiredParks: [...retiredParks.values()],
      updatedAt: now(),
    });
  save();
  const current = () => {
    if (stopping) throw Error("Patrol stopped.");
    if (retiring) throw new CombatRosterChanged("Member retirement is settling original actions.");
    roster.check((id) => original.find((p) => p.characterID === id)!.current());
    peers = original.filter((p) => roster.active(p.characterID));
    if (!roster.active(leader!.characterID))
      throw new CombatRosterChanged("Patrol anchor needs a qualified successor.");
    ordered = [leader!, ...peers.filter((p) => p !== leader)];
  };
  const waypoint = () => waypoints[index]!;
  const identity = (): PatrolIdentity => ({
    kind: "patrol",
    operationID: c.operationID,
    operationRunID: c.operationRunID,
    systemID: waypoint().systemID,
    waypointID: waypoint().itemID,
    waypointGeneration: generation,
  });
  async function checkedView(p: PatrolPeer) {
    current();
    await p.assertAtWaypoint(waypoint());
    const v = await p.view();
    current();
    if (
      v.characterID !== p.characterID ||
      v.shipID !== p.shipID ||
      v.systemID !== waypoint().systemID ||
      !v.shipPosition ||
      !v.waypointPosition ||
      ![
        v.shipPosition.x,
        v.shipPosition.y,
        v.shipPosition.z,
        v.waypointPosition.x,
        v.waypointPosition.y,
        v.waypointPosition.z,
      ].every(Number.isFinite) ||
      !Array.isArray(v.entities)
    )
      throw Error("Patrol physical view is unavailable.");
    return v;
  }
  async function settleForMovement() {
    settlements.length = 0;
    for (const p of peers) {
      p.current();
      const x = await p.settle(() => p.current());
      p.current();
      if (
        x.characterID !== p.characterID ||
        x.shipID !== p.shipID ||
        !x.modulesInactive ||
        !x.dronesSafe
      )
        throw Error("Patrol member is not settled.");
      settlements.push(x);
    }
    save();
  }
  async function finish() {
    stopping = true;
    state = "SETTLING";
    save();
    await settleForMovement();
    for (const p of peers) {
      const x = await p.park();
      p.current();
      if (
        x.characterID !== p.characterID ||
        x.shipID !== p.shipID ||
        x.docked !== true ||
        !positive(x.destinationID)
      )
        throw Error("Patrol parking is unconfirmed.");
      parks.push(x);
    }
    if (roster.snapshot().some((m) => !retiredParks.has(m.characterID)))
      throw Error("Retired patrol custody remains unresolved; healthy Parking is retained.");
    state = "STOPPED";
    save();
  }
  async function one() {
    if (state === "STOPPED" || state === "BLOCKED") return;
    if (!roster.active(leader!.characterID)) {
      const id = await c.successor?.(roster.members().map((m) => m.characterID));
      const next = original.find((p) => p.characterID === id && roster.active(p.characterID));
      if (!next) throw Error("No qualified same-or-smaller patrol successor.");
      leader = next;
      peers = original.filter((p) => roster.active(p.characterID));
      ordered = [leader, ...peers.filter((p) => p !== leader)];
      save();
    }
    current();
    if (roster.snapshot().length && ["FORMING", "TRAVEL"].includes(state))
      throw Error(
        "Retained patrol assembly or waypoint movement requires reconciliation before changing its roster.",
      );
    if (now() >= c.deadline) {
      await finish();
      return;
    }
    if (state === "FORMING") {
      if (!(await ensureFleet())) return;
      state = "TRAVEL";
      save();
    }
    if (state === "TRAVEL") {
      for (const p of ordered) {
        current();
        await p.navigate(waypoint());
        await p.assertAtWaypoint(waypoint());
      }
      state = "OBSERVING";
      idleSince = null;
      save();
      return;
    }
    if (state !== "OBSERVING") throw Error("Patrol requires reconciliation.");
    if (!(await ensureFleet())) throw Error("Patrol native fleet is unavailable.");
    const combatOrder = [...ordered],
      views = await Promise.all(
        combatOrder.map(async (p) => {
          try {
            return await checkedView(p);
          } catch (e) {
            if (e instanceof CombatRosterChanged || roster.required(p.characterID)) throw e;
            roster.retire(p.characterID, e instanceof Error ? e.message : String(e));
            peers = original.filter((p) => roster.active(p.characterID));
            save();
            return null;
          }
        }),
      );
    if (!views[0]) throw new CombatRosterChanged("Patrol anchor read failed.");
    const origin = views[0]!.shipPosition,
      anchor = views[0]!.waypointPosition,
      targets = views[0]!.entities
        .filter(
          (e) =>
            isQualifiedPatrolNpc(e) &&
            !!e.position &&
            [e.position.x, e.position.y, e.position.z].every(Number.isFinite) &&
            Math.hypot(e.position.x - anchor.x, e.position.y - anchor.y, e.position.z - anchor.z) <=
              500000,
        )
        .sort(
          (a, b) =>
            Math.hypot(a.position.x - origin.x, a.position.y - origin.y, a.position.z - origin.z) -
              Math.hypot(
                b.position.x - origin.x,
                b.position.y - origin.y,
                b.position.z - origin.z,
              ) || a.itemID - b.itemID,
        ),
      chosen =
        primary !== null && targets.some((t) => t.itemID === primary)
          ? primary
          : (targets[0]?.itemID ?? null);
    if (primary !== chosen) {
      primary = chosen;
      primaryGeneration++;
      save();
    }
    if (primary === null) {
      idleSince ??= now();
      if (now() - idleSince >= c.observationMs) {
        await settleForMovement();
        index = (index + 1) % waypoints.length;
        generation++;
        state = "TRAVEL";
        idleSince = null;
        save();
      }
      return;
    }
    idleSince = null;
    const target = primary,
      epoch = primaryGeneration;
    const results = await Promise.allSettled(
      combatOrder.map(async (p, i) => {
        if (
          !views[i] ||
          !roster.active(p.characterID) ||
          !views[i]!.entities.some((e) => e.itemID === target && isQualifiedPatrolNpc(e))
        )
          return;
        await p.fighter.tick(identity(), () => {
          current();
          if (primary !== target || primaryGeneration !== epoch)
            throw Error("Patrol target changed.");
        });
      }),
    );
    const failed = results.find((x): x is PromiseRejectedResult => x.status === "rejected");
    if (failed) {
      const id = combatOrder[results.indexOf(failed)]!.characterID;
      if (roster.required(id)) throw failed.reason;
      roster.retire(
        id,
        failed.reason instanceof Error ? failed.reason.message : String(failed.reason),
      );
      peers = original.filter((p) => roster.active(p.characterID));
      ordered = [leader!, ...peers.filter((p) => p !== leader)];
      save();
    }
  }
  async function fence(characterID: number, target: number | null, epoch: number) {
    current();
    if (
      state !== "OBSERVING" ||
      !primary ||
      epoch !== primaryGeneration ||
      (target !== null && target !== primary)
    )
      throw Error("Patrol target authority changed.");
    if (!(await ensureFleet())) throw Error("Patrol native fleet is unavailable.");
    const peer = peers.find((p) => p.characterID === characterID);
    if (!peer) throw Error("Patrol pilot is not selected.");
    const v = await checkedView(peer);
    current();
    if (epoch !== primaryGeneration || (target !== null && target !== primary))
      throw Error("Patrol target authority changed.");
    if (target !== null && !v.entities.some((e) => e.itemID === target))
      throw new SecurityTargetUnobserved("Patrol target is absent.");
    if (
      target !== null &&
      !v.entities.some(
        (e) =>
          e.itemID === target &&
          isQualifiedPatrolNpc(e) &&
          !!e.position &&
          [e.position.x, e.position.y, e.position.z].every(Number.isFinite) &&
          Math.hypot(
            e.position.x - v.waypointPosition.x,
            e.position.y - v.waypointPosition.y,
            e.position.z - v.waypointPosition.z,
          ) <= 500000,
      )
    )
      throw Error("Patrol target is not a current qualified NPC at the selected waypoint.");
  }
  async function retire(id: number, reason: string) {
    const p = original.find((p) => p.characterID === id);
    if (!p || roster.required(id)) return null;
    if (state !== "OBSERVING")
      throw Error(
        "Independent patrol retirement requires a settled waypoint, not assembly or native movement.",
      );
    roster.retire(id, reason);
    peers = original.filter((p) => roster.active(p.characterID));
    retiring = true;
    try {
      if (inflight) await inflight.catch(() => {});
      p.current();
      const settled = await p.settle(p.current);
      p.current();
      if (
        settled.characterID !== id ||
        settled.shipID !== p.shipID ||
        !settled.modulesInactive ||
        !settled.dronesSafe
      )
        throw Error("Retiring patrol member is not settled.");
      const parking = await p.park();
      p.current();
      if (
        parking.characterID !== id ||
        parking.shipID !== p.shipID ||
        !parking.docked ||
        !positive(parking.destinationID)
      )
        throw Error("Retiring patrol Parking is unconfirmed.");
      retiredParks.set(id, parking);
      save();
      return parking;
    } finally {
      retiring = false;
    }
  }

  return {
    retire,
    authority: () => ({
      state,
      waypoint: waypoint(),
      identity: identity(),
      primary,
      primaryGeneration,
    }),
    fence,
    tick() {
      if (inflight) return inflight;
      inflight = one()
        .catch((e) => {
          if (e instanceof CombatRosterChanged) return;
          if (!stopping) {
            state = "BLOCKED";
            save();
          }
          throw e;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    async stop() {
      stopping = true;
      if (inflight) await inflight.catch(() => {});
      if (state !== "STOPPED") await finish();
    },
    snapshot: () => ({
      state,
      index,
      generation,
      primary,
      primaryGeneration,
      parks,
      memberDecisions: roster.snapshot(),
    }),
  };
}
