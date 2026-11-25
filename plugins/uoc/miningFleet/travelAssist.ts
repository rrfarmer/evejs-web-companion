import {
  buildSlots,
  decodeFlightStatus,
  decidePropulsionModule,
  getFlightStatus,
  loadFitting,
  scrammedByWarpScrambler,
  slotFlagOf,
} from "../../../web/src/plugin-api/flying.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { decodeModuleObservation } from "../shared/moduleObservation.ts";
import { readMiningReadiness } from "./nativeBelt.ts";
import type { SynchronousStore } from "./targetBoard.ts";

type Module = {
  itemID: number;
  typeID: number;
  flagID: number;
  effectID: number;
  effect: string;
  kind: "afterburner" | "microwarpdrive";
};
type Owned = { module: Module; scope: string };
type Pending = Owned & { kind: "on" | "off"; issuedAt: number; acknowledged: boolean };
type State = {
  version: 1;
  identity: string;
  pending: Pending | null;
  owned: Owned | null;
  history: unknown[];
};
type EffectState = "active" | "inactive" | "unavailable";
const id = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const validModule = (m: Module) =>
  !!m &&
  [m.itemID, m.typeID, m.flagID, m.effectID].every(id) &&
  ((m.kind === "afterburner" && m.effect === "moduleBonusAfterburner") ||
    (m.kind === "microwarpdrive" && m.effect === "moduleBonusMicrowarpdrive"));

export interface MiningTravelAssist {
  beforeApproach(scope: string, distance: number, range: number, targetID?: number): Promise<void>;
  settle(scope?: string): Promise<void>;
}
export class TravelAssistPending extends Error {}

/** Optional on approach. Stop still requires native confirmation for an owned effect. */
export function createTravelAssist(config: {
  identity: {
    operationID: string;
    runID: string;
    characterID: number;
    shipID: number;
    botID: string;
  };
  document: SynchronousStore;
  current: () => void;
  beforeAction: () => void;
  enabled?: () => boolean;
  timing?: MccTiming;
  read: () => Promise<{
    modules: readonly (Module & { active: boolean })[];
    capacitorRatio: number | null;
    scrammed: boolean | null;
    followingTargetID?: number | null;
  }>;
  observe: (module: Module) => Promise<boolean>;
  change: (module: Module, on: boolean) => Promise<void>;
}) {
  const key = JSON.stringify(config.identity),
    raw = config.document.read() as State | null;
  let state: State = raw ?? { version: 1, identity: key, pending: null, owned: null, history: [] };
  if (
    state.version !== 1 ||
    state.identity !== key ||
    !Array.isArray(state.history) ||
    !(
      state.pending === null ||
      (state.pending &&
        ["on", "off"].includes(state.pending.kind) &&
        validModule(state.pending.module) &&
        typeof state.pending.scope === "string" &&
        id(state.pending.issuedAt) &&
        typeof state.pending.acknowledged === "boolean")
    ) ||
    !(
      state.owned === null ||
      (state.owned && validModule(state.owned.module) && typeof state.owned.scope === "string")
    )
  )
    throw Error("Travel assist custody requires reconciliation.");

  const save = (next: State) => {
    config.current();
    config.document.write(structuredClone(next));
    state = next;
  };
  const close = (
    record: Pending | Owned,
    outcome: "ACTIVE" | "INACTIVE" | "NOT_DISPATCHED" | "REFUSED",
    owned: Owned | null,
  ) => {
    save({
      ...state,
      pending: null,
      owned,
      history: [...state.history, { ...record, outcome, observedAt: Date.now() }].slice(-128),
    });
    config.timing?.note("travel-assist-effect", {
      outcome,
      scope: record.scope,
      moduleID: record.module.itemID,
      command: "kind" in record ? record.kind : undefined,
      commandAtMs: "issuedAt" in record ? record.issuedAt : undefined,
    });
  };
  async function observe(module: Module): Promise<EffectState> {
    config.current();
    try {
      const active = await timed(
        config.timing,
        "travel-assist-effect-read",
        () => config.observe(module),
        { moduleID: module.itemID },
        15000,
      );
      config.current();
      return active === true ? "active" : active === false ? "inactive" : "unavailable";
    } catch {
      config.current();
      config.timing?.change("travel-assist-wait", "effect-unreadable", {
        reason: "effect-unreadable",
        moduleID: module.itemID,
      });
      return "unavailable";
    }
  }
  async function reconcile(pending: Pending) {
    const seen = await observe(pending.module);
    if (seen === "inactive") close(pending, "INACTIVE", null);
    if (seen === "active" && pending.kind === "on")
      close(pending, "ACTIVE", { module: pending.module, scope: pending.scope });
    return seen;
  }
  async function send(kind: "on" | "off", module: Module, scope: string) {
    if (state.pending) throw Error("Travel assist outcome is unknown; no replay.");
    if (kind === "on") config.beforeAction();
    let pending: Pending = { kind, module, scope, issuedAt: Date.now(), acknowledged: false };
    save({ ...state, pending });
    if (kind === "on")
      try {
        config.beforeAction();
      } catch (error) {
        close(pending, "NOT_DISPATCHED", state.owned);
        throw error;
      }
    try {
      await timed(
        config.timing,
        kind === "on" ? "travel-assist-activate-rpc" : "travel-assist-deactivate-rpc",
        () => config.change(module, kind === "on"),
        { scope, moduleID: module.itemID },
      );
    } catch (error) {
      config.current();
      const native = error as { code?: unknown; status?: unknown } | null;
      if (kind === "on" && native?.code === "CALL_REFUSED" && native.status === 409) {
        // In particular, an already-active refusal does not grant ownership of that effect.
        close(pending, "REFUSED", null);
        return null;
      }
      return reconcile(pending);
    }
    config.current();
    pending = { ...pending, acknowledged: true };
    save({ ...state, pending });
    return reconcile(pending);
  }
  async function settleEffect(scope?: string): Promise<EffectState> {
    config.current();
    const original = state.pending ?? state.owned;
    if (!original || (scope !== undefined && original.scope !== scope)) return "inactive";
    let seen: EffectState | undefined;
    if (state.pending) {
      seen = await reconcile(state.pending);
      if (state.pending || !state.owned) {
        if (state.pending && seen === "active")
          config.timing?.change("travel-assist-wait", state.pending.issuedAt, {
            reason: "effect-finishing",
            scope: state.pending.scope,
            moduleID: state.pending.module.itemID,
          });
        return seen;
      }
    }
    const owned = state.owned;
    if (!owned) return "inactive";
    seen ??= await observe(owned.module);
    if (seen === "inactive") close(owned, "INACTIVE", null);
    if (seen !== "active") return seen;
    return (await send("off", owned.module, owned.scope)) ?? "unavailable";
  }

  return {
    snapshot: () => structuredClone(state),
    async settle(scope?: string) {
      await settleEffect(scope);
    },
    async settleForStop() {
      const seen = await settleEffect();
      if (seen === "active")
        throw new TravelAssistPending(
          "The original Travel Assist effect is still active. Waiting for native cycle shutdown.",
        );
      if (seen === "unavailable")
        throw new TravelAssistPending(
          "The original Travel Assist effect is unreadable. Waiting for native module readback.",
        );
    },
    async beforeApproach(scope: string, distance: number, range: number, targetID?: number) {
      config.current();
      if (config.enabled?.() === false) {
        await settleEffect();
        return;
      }
      if (
        !scope ||
        !Number.isFinite(distance) ||
        !Number.isFinite(range) ||
        distance < 0 ||
        range < 0
      )
        throw Error("Travel approach scope is invalid.");
      if (state.pending) {
        await reconcile(state.pending);
        if (state.pending) return;
      }
      if (state.owned) {
        if (state.owned.scope !== scope) await settleEffect();
        return;
      }
      // Native absence settles the physical state but cannot tell us whether an unobserved activation ever ran.
      const attempted = state.history.some((record) => {
        const receipt = record as (Partial<Pending> & { outcome?: string }) | null;
        return (
          receipt?.kind === "on" &&
          receipt.scope === scope &&
          ["INACTIVE", "REFUSED"].includes(receipt.outcome ?? "")
        );
      });
      if (distance - range <= 10000 || attempted) return;
      let read;
      try {
        read = await timed(config.timing, "travel-assist-probe", config.read, { scope }, 15000);
      } catch {
        config.current();
        return;
      }
      config.current();
      if (
        (targetID !== undefined && read.followingTargetID === targetID) ||
        read.modules.some((m) => m.active)
      )
        return;
      const decision = decidePropulsionModule({
        modules: read.modules,
        activeModuleIDs: new Set(),
        capacitorRatio: read.capacitorRatio,
        scrammed: read.scrammed,
        wantBurn: true,
        capFloor: 0.3,
      });
      if (decision.kind === "light")
        await send(
          "on",
          read.modules.find((m) => m.itemID === decision.module.itemID)!,
          scope,
        );
    },
  } satisfies MiningTravelAssist & { snapshot(): State; settleForStop(): Promise<void> };
}

export function createNativeTravelAssist(
  run: PluginRunContext,
  session: PilotSession,
  config: {
    operationID: string;
    runID: string;
    shipID: number;
    systemID: number;
    document: SynchronousStore;
    current: () => void;
    beforeAction: () => void;
    enabled?: () => boolean;
    timing?: MccTiming;
  },
) {
  const f = session.flow.flying,
    generation = f.sessionGeneration(),
    options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch };
  const guard = () => {
    config.current();
    if (
      f.isSessionClosing() ||
      f.sessionGeneration() !== generation ||
      session.store.station.get().online?.characterID !== run.characterID
    )
      throw Error("Travel assist owner changed.");
  };
  const moduleInfo = async (m: Module) => {
    guard();
    const native = decodeModuleObservation(
      await f.bridgeAsk("dogmaIM", "ItemGetInfo", [m.itemID]),
      {
        moduleID: m.itemID,
        typeID: m.typeID,
        ownerID: run.characterID,
        shipID: config.shipID,
        flagID: m.flagID,
      },
    );
    guard();
    return native;
  };
  const observe = async (m: Module) => {
    try {
      return (await moduleInfo(m)).effects.some((effect) => effect.effectID === m.effectID);
    } catch (error) {
      guard();
      const flight = decodeFlightStatus((await getFlightStatus(options)).flight);
      guard();
      if (
        flight.shipID === config.shipID &&
        flight.docked &&
        !flight.inSpace &&
        (flight.stationID ?? flight.structureID) &&
        flight.transition?.phase === "ready"
      )
        return false;
      throw error;
    }
  };
  const read = async () => {
    guard();
    const ready = await readMiningReadiness(
      run,
      session,
      config.shipID,
      config.systemID,
      guard,
      config.timing,
      "travel-assist-readiness",
    );
    if (!ready.ready) throw Error("Travel assist flight is not ready.");
    const own = ready.space.entities.find(
      (e) => e.itemID === config.shipID && e.characterID === run.characterID,
    );
    const followingTargetID = own?.mode?.toUpperCase() === "FOLLOW" ? own.targetEntityID : null;
    const fit = await loadFitting(options);
    guard();
    if (fit.activeShipID !== config.shipID || Object.values(fit.errors).some((v) => v !== null))
      throw Error("Travel assist fitting is unreadable.");
    const modules: (Module & { active: boolean })[] = [];
    for (const slot of buildSlots(fit.slots, fit.shipInfo, fit.online)) {
      const m = slot.module;
      if (!m || !m.online || m.groupID !== 46) continue;
      const flagID = slotFlagOf(slot.family, slot.index);
      if (!id(flagID) || !id(m.itemID) || !id(m.typeID))
        throw Error("Travel module identity is unknown.");
      const response = await run.fetch(
          new URL("/api/client-data/dogma-types?typeIDs=" + m.typeID, run.baseUrl),
        ),
        body = await response.json();
      guard();
      const type = body?.types?.[m.typeID];
      if (!response.ok || body?.available !== true || !Array.isArray(type?.effects))
        throw Error("Travel effect metadata is unknown.");
      const effects = type.effects.flatMap((effectID: number) => {
        const name = body.effects?.[effectID]?.name;
        return name === "moduleBonusAfterburner" || name === "moduleBonusMicrowarpdrive"
          ? [
              {
                effectID,
                effect: name,
                kind:
                  name === "moduleBonusAfterburner"
                    ? ("afterburner" as const)
                    : ("microwarpdrive" as const),
              },
            ]
          : [];
      });
      if (effects.length !== 1 || !id(effects[0]!.effectID)) continue;
      const module = { itemID: m.itemID, typeID: m.typeID, flagID, ...effects[0]! };
      const native = await moduleInfo(module);
      if (native.online)
        modules.push({
          ...module,
          active: native.effects.some((effect) => effect.effectID === module.effectID),
        });
    }
    modules.sort(
      (a, b) =>
        Number(a.kind !== "afterburner") - Number(b.kind !== "afterburner") || a.itemID - b.itemID,
    );
    const ratio = ready.space.ship?.capacitorRatio;
    return {
      modules,
      followingTargetID,
      capacitorRatio: typeof ratio === "number" && Number.isFinite(ratio) ? ratio : null,
      scrammed: scrammedByWarpScrambler(session.store.space.get().jams, Date.now()),
    };
  };
  return createTravelAssist({
    identity: {
      operationID: config.operationID,
      runID: config.runID,
      characterID: run.characterID,
      shipID: config.shipID,
      botID: run.botID,
    },
    document: config.document,
    current: guard,
    beforeAction: config.beforeAction,
    enabled: config.enabled,
    timing: config.timing,
    read,
    observe,
    change: async (m, on) => {
      guard();
      await f.bridgeDo(
        "dogmaIM",
        on ? "Activate" : "Deactivate",
        on ? [m.itemID, m.effect, null, -1] : [m.itemID, m.effect],
      );
      guard();
    },
  });
}
import { timed, type MccTiming } from "./timing.ts";
