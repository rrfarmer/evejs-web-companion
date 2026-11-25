import {
  decodeFlightStatus,
  getFlightStatus,
  undock,
} from "../../../../web/src/plugin-api/flying.ts";
import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import { readMiningReadiness } from "../../miningFleet/nativeBelt.ts";
type Doc = { read(): unknown; write(value: unknown): void };
export interface PatrolWaypoint {
  systemID: number;
  itemID: number;
  groupID: 9 | 10;
  name: string;
}
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
/** Same stock held-pilot navigator and bracketed flight/scene read used by MCC,
 * generalized to exact belt or gate identity. The journal records movement
 * before dispatch and never repeats a pending order. */
export function createPatrolNavigation(
  run: PluginRunContext,
  session: PilotSession,
  config: {
    shipID: number;
    waypoint: PatrolWaypoint;
    document: Doc;
    current(): void;
    sleep(ms: number): Promise<void>;
    now?: () => number;
  },
) {
  const { waypoint: w, shipID, current } = config,
    now = config.now ?? Date.now;
  if (
    ![shipID, w.systemID, w.itemID, run.characterID].every(positive) ||
    ![9, 10].includes(w.groupID) ||
    typeof w.name !== "string" ||
    !w.name.trim()
  )
    throw Error("Patrol waypoint identity is invalid.");
  const identity = JSON.stringify([
      run.botID,
      run.characterID,
      shipID,
      w.systemID,
      w.itemID,
      w.groupID,
      w.name,
    ]),
    old = config.document.read() as any;
  if (
    old !== null &&
    (!old ||
      old.version !== 1 ||
      old.identity !== identity ||
      !(
        old.pending === null ||
        (old.pending &&
          ["undock", "warp", "approach"].includes(old.pending.kind) &&
          typeof old.pending.acknowledged === "boolean" &&
          Number.isFinite(old.pending.issuedAt))
      ))
  )
    throw Error("Patrol movement journal differs; custody retained.");
  let state = old ?? { version: 1, identity, pending: null, arrivedAt: null };
  const save = () => config.document.write(structuredClone(state));
  if (old === null) save();
  const options = () => ({
    ...session.flow.requestOptions(),
    baseUrl: run.baseUrl,
    fetch: run.fetch,
  });
  const flight = async () => {
    current();
    const f = decodeFlightStatus((await getFlightStatus(options())).flight);
    current();
    if (f.shipID !== shipID || f.solarSystemID !== w.systemID)
      throw Error("Patrol ship or system changed.");
    return f;
  };
  const observe = async () => {
    current();
    const v = await readMiningReadiness(run, session, shipID, w.systemID, current),
      matches = v.space.entities.filter((e) => e.itemID === w.itemID);
    if (
      matches.length !== 1 ||
      matches[0]!.groupID !== w.groupID ||
      !matches[0]!.geometryAvailable ||
      !v.space.ship?.geometryAvailable
    )
      throw Error("Exact patrol waypoint is not observed.");
    const t = matches[0]!,
      s = v.space.ship,
      distance = Math.max(
        0,
        Math.hypot(
          t.position.x - s.position.x,
          t.position.y - s.position.y,
          t.position.z - s.position.z,
        ) -
          t.radius -
          s.radius,
      );
    if (!Number.isFinite(distance)) throw Error("Patrol waypoint distance is unavailable.");
    return { ready: v.ready, distance, shipRadius: s.radius, targetRadius: t.radius };
  };
  const reconcile = async () => {
    current();
    if (!state.pending) return;
    const f = await flight();
    if (state.pending.kind === "undock" && f.inSpace && !f.docked) {
      state.pending = null;
      save();
      return;
    }
    if (state.pending.kind !== "undock" && f.inSpace && !f.docked) {
      const v = await observe();
      if (v.ready && v.distance <= 20000) {
        state.pending = null;
        state.arrivedAt = now();
        save();
      }
    }
  };
  const dispatch = async (kind: "undock" | "warp" | "approach", work: () => Promise<unknown>) => {
    if (state.pending) throw Error("Patrol movement remains unresolved; no replay.");
    current();
    state.pending = { kind, issuedAt: now(), acknowledged: false };
    save();
    current();
    await work();
    current();
    state.pending.acknowledged = true;
    save();
  };
  return {
    async navigate() {
      const end = now() + 180000;
      for (;;) {
        current();
        if (state.pending) {
          try {
            await reconcile();
          } catch {
            current();
          }
          if (state.pending) {
            if (now() >= end) throw Error("Patrol movement remains unresolved; no replay.");
            await config.sleep(1000);
            continue;
          }
        }
        const f = await flight();
        if (f.docked) {
          await dispatch("undock", () =>
            undock(session.flow.flying.bridgeDo, session.flow.flying.readFlightNow, false),
          );
          continue;
        }
        if (!f.inSpace) throw Error("Patrol pilot is not in space.");
        const v = await observe();
        if (v.ready && v.distance <= 20000) {
          state.arrivedAt = now();
          save();
          return;
        }
        if (!v.ready) {
          if (now() >= end) throw Error("Patrol flight did not settle.");
          await config.sleep(1000);
          continue;
        }
        if (v.distance < Math.max(0, 152500 + v.shipRadius - v.targetRadius))
          await dispatch("approach", () => session.flow.flying.approachShip(w.itemID, 10000));
        else await dispatch("warp", () => session.flow.flying.warpAsTheAutopilot(w.itemID));
      }
    },
    async assertAtWaypoint() {
      const v = await observe();
      if (!v.ready || v.distance > 20000)
        throw Error("Exact patrol waypoint arrival is not confirmed.");
    },
    async reconcile() {
      await reconcile();
    },
    snapshot() {
      return structuredClone(state);
    },
  };
}
