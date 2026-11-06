// A companion the server flies: a run on a pilot core holds (docs/plugins.md, "A run"). Core
// keeps the claim, the roster, Stop and the recall if this process stays down. What flies is
// the same as in a tab (lib/companionFlow.ts).

import { startBackend, type BackendRun, type PluginRunContext } from "../../web/src/plugin-api/backend.ts";
import { createPilotSession } from "../../web/src/plugin-api/pilotSession.ts";
import type { JsonValue } from "../../web/src/plugin-api/index.ts";
import { createCompanionFlow } from "./lib/companionFlow.ts";
import { companionState, type FleetCompanionState } from "./lib/companionState.ts";
import {
  analyzeCompanionRunPolicy,
  decodeCompanionAbandonmentValue,
  decodeCompanionSetupValue,
} from "./lib/companionRunPolicy.ts";
import type { CompanionAbandonmentRecord, CompanionSetup, CompanionStandingOrders } from "./lib/fleetCompanionLoop.ts";
import type { ServerCompanionFacts } from "./lib/companionReadout.ts";
import manifest from "./plugin.ts";

const ENDED = new Set(["idle", "stopped", "error"]);

/** The Bot Manager's and the Companions window's facts about a run on the server. */
export function readoutOf(state: FleetCompanionState): ServerCompanionFacts {
  return {
    inFleet: state.inFleet,
    followingOrderFrom: state.followingOrderFrom,
    lastOrderHeard: state.lastOrderHeard,
    targetMode: state.targetMode,
    canTag: state.canTag,
    fitWarnings: state.fitWarnings,
  };
}

/** The clock an interrupted run was on, whether this plugin kept it or core did before it was a plugin. */
export function abandonmentToResume(resumeData: JsonValue): CompanionAbandonmentRecord | null {
  if (resumeData === null || typeof resumeData !== "object" || Array.isArray(resumeData)) return null;
  const kept = resumeData as Record<string, JsonValue>;
  const former = kept.formerRow as Record<string, JsonValue> | null | undefined;
  const raw = kept.abandonment ?? former?.abandonment ?? null;
  const decoded = decodeCompanionAbandonmentValue(raw, Date.now());
  return decoded.ok ? decoded.abandonment : null;
}

/** How long what the commander last said is taken to stand through a restart. Longer, and nobody may be there to say otherwise. */
export const STANDING_ORDERS_KEPT_MS = 10 * 60_000;

/** The standing orders a restart finds, if they were kept recently enough and read as they should. */
export function keptStandingOrders(resumeData: JsonValue, nowMs: number): CompanionStandingOrders | null {
  if (resumeData === null || typeof resumeData !== "object" || Array.isArray(resumeData)) return null;
  const kept = resumeData as Record<string, JsonValue>;
  const orders = kept.standingOrders as Record<string, JsonValue> | null | undefined;
  if (orders === null || orders === undefined || typeof kept.ordersKeptAtMs !== "number") return null;
  // A stamp from the future is a row that cannot be trusted, as the abandonment's clock is refused for it.
  const age = nowMs - kept.ordersKeptAtMs;
  if (age < 0 || age > STANDING_ORDERS_KEPT_MS) return null;
  const { targetMode, flightMode, followRangeM, propsHeld } = orders;
  if ((targetMode !== "called" && targetMode !== "all") || (flightMode !== "follow" && flightMode !== "auto")) return null;
  if (typeof followRangeM !== "number" || !Number.isFinite(followRangeM) || followRangeM < 0) return null;
  if (propsHeld !== null && typeof propsHeld !== "boolean") return null;
  return { targetMode, flightMode, followRangeM, propsHeld };
}

export const flyRun: BackendRun = {
  check(setup) {
    const decoded = decodeCompanionSetupValue(setup);
    if (!decoded.ok) return { ok: false, refusal: decoded.refusal };
    const policy = analyzeCompanionRunPolicy(decoded.setup);
    return {
      ok: true,
      setup: decoded.setup as unknown as JsonValue,
      name: "Fleet companion",
      policy: { riskClasses: policy.riskClasses, restartSafe: policy.restartSafe },
    };
  },
  async start(run: PluginRunContext) {
    const { store, flow } = await createPilotSession(run);
    const companion = createCompanionFlow(store, flow);
    const state = companionState(store);
    let stopping = false;
    let kept = "";
    let flew = false;
    const stopListening = state.subscribe((now: FleetCompanionState) => {
      if (stopping) return;
      if (now.status !== "idle") flew = true;
      // Before it first flies, idle is only the state it starts in, and a refusal is start's to answer.
      if (!flew) return;
      // The clock and who may invite it back, and nothing about a warp that is over the moment this process dies.
      const abandonment = now.abandonment === null ? null : { abandonedAtMs: now.abandonment.abandonedAtMs, supervisorCharacterIDs: now.abandonment.supervisorCharacterIDs };
      const whatChanges = JSON.stringify({ abandonment, standingOrders: now.standingOrders });
      const same = whatChanges === kept;
      kept = whatChanges;
      // Stamped only as they change: an order is as old as the last word from the commander or a restart.
      const resumeData = { abandonment, standingOrders: now.standingOrders, ordersKeptAtMs: Date.now() } as unknown as JsonValue;
      run.report({
        status: ENDED.has(now.status) ? (now.startError !== null || now.failureReason !== null ? "error" : "stopped") : now.status === "paused" ? "paused" : "running",
        phase: now.phase,
        why: now.why ?? now.failureReason,
        startError: now.startError,
        readout: readoutOf(now) as unknown as JsonValue,
        ...(same ? {} : { resumeData }),
      });
    });
    let refusal: string | null = null;
    try {
      await companion.startFleetCompanion(run.setup as unknown as CompanionSetup, abandonmentToResume(run.resumeData), keptStandingOrders(run.resumeData, Date.now()), run.resumed);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    refusal ??= state.get().startError;
    // Thrown rather than reported, so whoever pressed FLY is told why instead of "started".
    if (refusal !== null) {
      stopping = true;
      stopListening();
      companion.stopFleetCompanion();
      flow.setLivePush(false);
      throw new Error(refusal);
    }
    return {
      async stop() {
        stopping = true;
        stopListening();
        // Stop new work and let the tick already issuing an order settle, before core brings the drones home.
        await companion.beginGracefulStop();
        companion.stopFleetCompanion();
        await flow.flying.log.flush();
        flow.setLivePush(false);
      },
    };
  },
};

// Started by the BFF's plugin host only; a test imports the functions above.
if (typeof process.send === "function") {
  startBackend({
    manifest,
    routes: {},
    // It keeps nothing of its own on disk: what a run needs is in its resumeData, on core's roster.
    cleanup: () => {},
    runs: { fly: flyRun },
  });
}
