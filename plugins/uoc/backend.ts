import { finished } from "node:stream";
import { ReadableStream } from "node:stream/web";
import {
  startBackend,
  type BackendDefinition,
  type BackendRoute,
  type BackendRun,
  type PluginRunContext,
  type PluginRunHandle,
} from "../../web/src/plugin-api/backend.ts";
import { uocStore, closeBackendStores } from "./backendStores.ts";
import { wrapRunFetch } from "./shared/runFetch.ts";
import manifest from "./plugin.ts";
import { createDistributionStore } from "./logistics/store.ts";
import { civilianCheckpointRoutes } from "./civilian/index.ts";
import { civilianCheckpointRun } from "./civilian/checkpoint.ts";
import { withCivilianPolicy } from "./shared/civilianReport.ts";
import { worldRoute } from "./shared/backendScope.ts";
import { createOwnerTrainingServices } from "./training/ownerServices.ts";
import { pilotServiceOwner, runControlRoutes } from "./runControl.ts";

export { decodeCivilianMiningSetup, civilianMiningPlan } from "./mining/setup.ts";

function lazyRun(load: (setup: unknown) => Promise<BackendRun>): BackendRun {
  return {
    async check(setup) {
      return (await load(setup)).check(setup);
    },
    async start(run) {
      return (await load(run.setup)).start(run);
    },
  };
}

const miningRun = (shutdown?: AbortSignal) =>
  lazyRun(async () => (await import("./mining/host.ts")).createNativeMiningRun({ shutdown }));
export const civilianMiningRun = miningRun();

const miningRouteNames = [
  "POST /mining-targets/mark-safe",
  "POST /mining-targets/reset-depleted",
  "GET /mining-operations",
  "GET /mining-operations/:operationID/delivery-receipts",
  "POST /mining-operations",
  "POST /mining-operations/observe",
  "POST /mining-operations/:operationID/stop",
  "GET /mining-operations/:operationID/recovery",
  "POST /mining-operations/:operationID/recovery/dispatch",
  "POST /mining-operations/:operationID/recovery/accept",
  "POST /mining-operations/:operationID/recovery/finalize",
  "POST /mining-operations/:operationID/relocate",
  "POST /mining-operations/:operationID/delete",
  "GET /mining-operations/:operationID/launch-plan",
  "POST /mining-operations/:operationID/launch-plan",
  "POST /mining-operations/:operationID/launch/begin",
  "POST /mining-operations/:operationID/launch/dispatch",
  "POST /mining-operations/:operationID/launch/accept",
  "POST /mining-operations/:operationID/launch/refuse",
  "POST /mining-operations/:operationID/launch/end",
  "GET /mining-operations/:operationID/launch",
];

export function createUocBackend(): BackendDefinition {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const runs = new Set<() => Promise<void>>();
  let cleaning: Promise<void> | undefined;

  function request<T>(call: () => T | Promise<T>): Promise<T> {
    lifetime.signal.throwIfAborted();
    const result = Promise.resolve(call());
    pending.add(result);
    return result.finally(() => pending.delete(result));
  }

  // The host sends cleanup independently of runStop. A run may still be attaching.
  function startRun(definition: BackendRun, run: PluginRunContext): Promise<PluginRunHandle> {
    lifetime.signal.throwIfAborted();
    const fetch = wrapRunFetch(run.fetch, (send) => async (input, init, priority) => {
      const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const source = caller ? AbortSignal.any([caller, lifetime.signal]) : lifetime.signal;
      source.throwIfAborted();
      const inFlight = new AbortController();
      const abort = () => inFlight.abort(source.reason);
      const release = () => source.removeEventListener("abort", abort);
      source.addEventListener("abort", abort, { once: true });
      try {
        const response = await send(input, { ...init, signal: inFlight.signal }, priority);
        // Headers can arrive before the body. Stop forwarding cancellation once the read ends.
        if (response.body instanceof ReadableStream) finished(response.body, release);
        else release();
        return response;
      } catch (error) {
        release();
        throw error;
      }
    });
    const handle = Promise.resolve(
      definition.start({
        ...run,
        fetch,
        report(value) {
          if (!lifetime.signal.aborted) run.report(value);
        },
      }),
    );
    let stopping: Promise<void> | undefined;
    function stop() {
      // An attachment that failed never returned a handle to stop.
      return (stopping ??= handle
        .then(
          (h) => h.stop(),
          () => {},
        )
        .finally(() => runs.delete(stop)));
    }
    runs.add(stop);
    return handle.then(
      () => ({ stop }),
      (error) => {
        runs.delete(stop);
        throw error;
      },
    );
  }

  let mining:
    Promise<ReturnType<typeof import("./miningFleet/backend.ts").createMiningBackend>> | undefined;
  function loadMining() {
    lifetime.signal.throwIfAborted();
    return (mining ??= import("./miningFleet/backend.ts")
      .then((m) => m.createMiningBackend())
      .catch((error) => {
        mining = undefined;
        throw error;
      }));
  }
  const miningRoutes: Record<string, BackendRoute> = {};
  for (const name of miningRouteNames) {
    miningRoutes[name] = async (request) => (await loadMining()).miningRoutes[name]!(request);
  }

  const logisticsDocument = (name: string) => uocStore("distribution.sqlite").document(name);
  const logistics = createDistributionStore(
    (world) => logisticsDocument("routes:" + world),
    logisticsDocument,
  );
  let distributionDriver: BackendRun | undefined;

  // The Combat Operations Center remains in development. Its routes and runs stay unregistered.
  const routes: Record<string, BackendRoute> = {
    "GET /world": worldRoute,
    ...logistics.routes,
    ...miningRoutes,
    ...civilianCheckpointRoutes,
    ...runControlRoutes,
    ...createOwnerTrainingServices({ owner: pilotServiceOwner }, startRun),
  };
  const drivers: Record<string, BackendRun> = {
    "distribution-carrier": lazyRun(async () => {
      const { createDistributionDriver } = await import("./logistics/host.ts");
      return (distributionDriver ??= createDistributionDriver(logistics, lifetime.signal));
    }),
    "civilian-checkpoint": civilianCheckpointRun,
    "civilian-mining": withCivilianPolicy(miningRun(lifetime.signal), "mining", {
      shutdown: lifetime.signal,
    }),
    "civilian-distribution": withCivilianPolicy(
      lazyRun(async () =>
        (await import("./distribution/host.ts")).createCourierRun(lifetime.signal),
      ),
      "distribution",
      { shutdown: lifetime.signal },
    ),
    "mcc-inspect": lazyRun(
      async () => (await import("./miningFleet/inspect.ts")).miningFleetInspectRun,
    ),
    "mcc-prepare": lazyRun(async (setup) => {
      if (
        typeof setup === "object" &&
        setup !== null &&
        "role" in setup &&
        setup.role === "COMBAT"
      ) {
        throw new Error("Combat Operations Center is in development.");
      }
      return (await import("./operations/miningPreparationHost.ts")).createMiningPreparationRun({
        shutdown: lifetime.signal,
      });
    }),
    "mcc-miner": lazyRun(async () => (await loadMining()).fleet.runs.MINER),
    "mcc-hauler": lazyRun(async () => (await loadMining()).fleet.runs.HAULER),
    "mcc-command": lazyRun(async () => (await loadMining()).fleet.runs.COMMAND),
    "mcc-defender": lazyRun(async () => (await loadMining()).fleet.runs.DEFENDER),
    "mcc-finish": lazyRun(async () => (await loadMining()).fleet.runs.FINISH),
    training: lazyRun(async () => (await import("./training/host.ts")).trainingRun),
    "training-inspect": lazyRun(
      async () => (await import("./training/host.ts")).trainingInspectRun,
    ),
    "training-hr": lazyRun(async () => (await import("./training/hr.ts")).trainingHRRun),
    "training-join": lazyRun(async () => (await import("./training/hr.ts")).trainingJoinRun),
    "provision-inspect": lazyRun(
      async () => (await import("./provisioning/host.ts")).provisioningInspectRun,
    ),
    "provision-apply": lazyRun(
      async () => (await import("./provisioning/host.ts")).provisioningApplyRun,
    ),
  };
  return {
    manifest,
    routes: Object.fromEntries(
      Object.entries(routes).map(([name, route]) => [
        name,
        (req: Parameters<BackendRoute>[0]) =>
          lifetime.signal.aborted
            ? { status: 503, body: { ok: false, message: "The UOC backend has stopped." } }
            : request(() => route(req)),
      ]),
    ),
    runs: Object.fromEntries(
      Object.entries(drivers).map(([name, run]) => [
        name,
        {
          check: (setup: unknown) => request(() => run.check(setup)),
          start: (ctx: PluginRunContext) => startRun(run, ctx),
        },
      ]),
    ),
    cleanup() {
      if (!cleaning) {
        lifetime.abort(new Error("The UOC backend has stopped."));
        const fleet = mining?.then(
          (m) => m.fleet.shutdown(),
          () => {},
        );
        cleaning = (async () => {
          const stopped = await Promise.allSettled([fleet, ...Array.from(runs, (stop) => stop())]);
          await Promise.allSettled(pending);
          closeBackendStores();
          const failure = stopped.find((result) => result.status === "rejected");
          if (failure) throw failure.reason;
        })();
      }
      return cleaning;
    },
  };
}

if (typeof process.send === "function") startBackend(createUocBackend());
