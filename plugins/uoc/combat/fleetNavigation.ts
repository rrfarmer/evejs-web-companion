import type { OwnShipProof } from "../shared/nativeShipLocation.ts";
import type { Identity } from "./security.ts";
interface Document {
  read(): unknown;
  write(v: unknown): void;
}
const nativeClock = (v: unknown) => {
  try {
    return (
      typeof v === "string" &&
      /^\d+$/.test(v) &&
      BigInt(v) > 116444736000000000n &&
      BigInt(v) <= 9223372036854775807n
    );
  } catch {
    return false;
  }
};
export interface NavigationSettlementObservation {
  characterID: number;
  shipID: number;
  observedAt: number;
  inSpace: boolean;
  docked: boolean;
  inWarp: boolean;
  systemID: number;
  scene: { shipID: number; systemID: number; sampledAt: number } | null;
  keeper: { dungeonID: number; instanceID: number; roomID: number } | null;
  nativeProof?: OwnShipProof;
  keeperObservedAt?: number;
}
/** Each dispatched navigation order stays pending until a fresh physical observation. */
export function createFleetNavigation(document: Document, identity: string) {
  let state = document.read() as any;
  if (
    state !== null &&
    (!state ||
      state.version !== 1 ||
      state.identity !== identity ||
      (state.retired !== undefined && !Array.isArray(state.retired)) ||
      !(
        state.pending === null ||
        (state.pending && ["undock", "route", "fleet-warp"].includes(state.pending.kind))
      ))
  )
    throw Error("Assistant navigation custody differs.");
  const save = (pending: unknown, retired?: unknown) => {
    const history = Array.isArray(state?.retired) ? state.retired : [];
    const next = {
      ...state,
      version: 1,
      identity,
      pending,
      ...(retired ? { retired: [...history, retired] } : {}),
    };
    document.write(structuredClone(next));
    state = next;
  };
  return {
    get pending() {
      return state?.pending ?? null;
    },
    reconcile(
      o: NavigationSettlementObservation,
      expected: { characterID: number; shipID: number; mission: Identity | null },
      current: () => void,
    ) {
      current();
      const p = state?.pending;
      if (!p) return "settled" as const;
      let owner: unknown;
      try {
        owner = JSON.parse(identity);
      } catch {
        return "pending" as const;
      }
      if (
        !Array.isArray(owner) ||
        owner.length !== 4 ||
        typeof owner[0] !== "string" ||
        !owner[0] ||
        typeof owner[1] !== "string" ||
        !owner[1] ||
        owner[2] !== expected.characterID ||
        owner[3] !== expected.shipID
      )
        return "pending" as const;
      if (
        !Number.isSafeInteger(expected.characterID) ||
        expected.characterID <= 0 ||
        !Number.isSafeInteger(expected.shipID) ||
        expected.shipID <= 0 ||
        o.characterID !== expected.characterID ||
        o.shipID !== expected.shipID ||
        !Number.isFinite(o.observedAt) ||
        !Number.isFinite(p.at) ||
        o.observedAt < p.at ||
        o.inSpace !== true ||
        o.docked !== false ||
        o.inWarp !== false ||
        !Number.isSafeInteger(o.systemID) ||
        o.systemID <= 0 ||
        !o.scene ||
        o.scene.shipID !== expected.shipID ||
        o.scene.systemID !== o.systemID ||
        !Number.isFinite(o.scene.sampledAt) ||
        !(o.nativeProof
          ? o.nativeProof.kind === "native-own-ship-location" &&
            o.nativeProof.characterID === expected.characterID &&
            o.nativeProof.shipID === expected.shipID &&
            o.nativeProof.systemID === o.systemID &&
            o.nativeProof.locationID === o.systemID &&
            o.nativeProof.simulationSampledAt === o.scene.sampledAt &&
            o.nativeProof.readStartedAt >= p.at &&
            o.nativeProof.readFinishedAt >= o.nativeProof.readStartedAt &&
            o.nativeProof.readFinishedAt <= o.observedAt &&
            o.observedAt - o.nativeProof.readFinishedAt <= 60000 &&
            nativeClock(o.nativeProof.timeFiletime) &&
            nativeClock(o.nativeProof.wallclockFiletime)
          : o.scene.sampledAt >= p.at &&
            o.scene.sampledAt <= o.observedAt &&
            o.observedAt - o.scene.sampledAt <= 15000)
      )
        return "pending" as const;
      if (p.kind === "route" && o.systemID !== p.systemID) return "pending" as const;
      if (p.kind === "fleet-warp") {
        if (
          o.nativeProof &&
          (!Number.isFinite(o.keeperObservedAt) ||
            o.keeperObservedAt! < o.nativeProof.readFinishedAt ||
            o.keeperObservedAt! > o.observedAt ||
            o.observedAt - o.keeperObservedAt! > 60000)
        )
          return "pending" as const;
        const m = expected.mission;
        if (
          !m ||
          p.missionKey !== m.acceptedKey ||
          p.instanceID !== m.instanceID ||
          p.roomID !== m.roomID ||
          o.systemID !== m.destinationSystemID ||
          !o.keeper ||
          o.keeper.dungeonID !== m.dungeonID ||
          o.keeper.instanceID !== m.instanceID ||
          o.keeper.roomID !== m.roomID
        )
          return "pending" as const;
      }
      if (!["undock", "route", "fleet-warp"].includes(p.kind)) return "pending" as const;
      current();
      save(null, {
        intent: structuredClone(p),
        outcome: "PHYSICALLY_OBSERVED",
        observation: structuredClone(o),
      });
      return "settled" as const;
    },
    async step(
      o: {
        docked: boolean;
        inSpace: boolean;
        inWarp: boolean;
        systemID: number;
        roomMatches: boolean;
        mission: Identity;
      },
      ops: {
        guard: () => void;
        undock: () => Promise<void>;
        route: (systemID: number) => Promise<void>;
        warp: () => Promise<void>;
      },
    ) {
      const p = state?.pending;
      if (o.roomMatches) {
        if (
          p?.kind === "fleet-warp" &&
          (p.missionKey !== o.mission.acceptedKey ||
            p.instanceID !== o.mission.instanceID ||
            p.roomID !== o.mission.roomID)
        )
          throw Error("A prior fleet warp belongs to another room.");
        if (p) save(null);
        return "arrived" as const;
      }
      if (p?.kind === "undock" && o.inSpace && !o.inWarp) save(null);
      else if (p?.kind === "route" && o.inSpace && !o.inWarp && o.systemID === p.systemID)
        save(null);
      else if (p) return "pending" as const;
      if (o.docked) {
        save({ kind: "undock", at: Date.now() });
        ops.guard();
        await ops.undock();
        return "dispatched" as const;
      }
      if (!o.inSpace || o.inWarp) return "waiting" as const;
      if (o.systemID !== o.mission.destinationSystemID) {
        save({ kind: "route", at: Date.now(), systemID: o.mission.destinationSystemID });
        ops.guard();
        await ops.route(o.mission.destinationSystemID);
        return "dispatched" as const;
      }
      save({
        kind: "fleet-warp",
        at: Date.now(),
        missionKey: o.mission.acceptedKey,
        instanceID: o.mission.instanceID,
        roomID: o.mission.roomID,
      });
      ops.guard();
      await ops.warp();
      return "dispatched" as const;
    },
  };
}
