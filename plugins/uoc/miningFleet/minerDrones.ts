import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import {
  decodeDroneBay,
  decodeDroneLimits,
  decodeSpaceSnapshot,
  getSpaceSnapshot,
  nameKey,
  returnDronesToBay,
} from "../../../web/src/plugin-api/flying.ts";
import { droneRoleForGroup } from "../compat/flying.ts";
import {
  boundedDroneRead,
  boundedDroneWrite,
  checkDroneEngage,
  DroneOrderRefused,
  effectiveDroneLimits,
  planCombatDroneLaunch,
  readCombatDroneLaunch,
} from "../combat/droneAdapter.ts";
import { readFleetDronePanel } from "./droneRecall.ts";
import { isMiningDefenderTarget } from "./defender.ts";
import { timed, type MccTiming } from "./timing.ts";
import { checkedInventory } from "./nativeInventory.ts";
import { fleetReadFailed, FleetObservationUnavailable } from "./stopSignal.ts";

type Scene = ReturnType<typeof decodeSpaceSnapshot>;
type SceneObservation = { space: Scene; observedAt: number };
type Entity = Scene["entities"][number];
type DroneBay = NonNullable<ReturnType<typeof decodeDroneBay>>;
type Geometry = Pick<Entity, "position" | "radius">;
const centerDistance = (a: Geometry, b: Geometry) =>
  Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z);
const distance = (a: Geometry, b: Geometry) =>
  Math.max(0, centerDistance(a, b) - a.radius - b.radius);
const escortLimitM = 120_000;
const sceneFreshMs = 1500;
const bayFingerprint = (bay: DroneBay, types?: ReadonlySet<number>) =>
  JSON.stringify(
    bay
      .filter((drone) => !types || types.has(drone.typeID))
      .map((drone) => [drone.itemID, drone.quantity])
      .sort((a, b) => a[0]! - b[0]!),
  );

function localHostiles(scene: Scene) {
  if (!scene.inSpace || scene.stateValid === false || !scene.ship?.geometryAvailable) return [];
  const ship = scene.ship;
  // The held Miner is the active escort center for this flight.
  return scene.entities
    .filter(
      (e) =>
        isMiningDefenderTarget(e) &&
        e.hullRatio !== 0 &&
        e.mode?.toUpperCase() !== "WARP" &&
        centerDistance(ship, e) <= escortLimitM,
    )
    .sort(
      (a, b) =>
        Number(b.targetEntityID === scene.shipID) - Number(a.targetEntityID === scene.shipID) ||
        distance(ship, a) - distance(ship, b) ||
        a.itemID - b.itemID,
    );
}

export function createMinerDroneFlight(
  run: PluginRunContext,
  session: PilotSession,
  shipID: number,
  held: () => void,
  active: () => void,
  report: (phase: string, why: string) => void,
  timing?: MccTiming,
) {
  const f = session.flow.flying,
    options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch };
  let combat = false;
  let launchInDoubt: {
    done: boolean;
    bay: string;
    out: Set<number>;
    types: Set<number>;
    combatBayOnly: boolean;
  } | null = null;
  let reconnectAttempt: {
    signature: string;
    ids: ReadonlySet<number>;
    sampledAtMs: number;
    inFlight: boolean;
  } | null = null;
  type PendingOrder = { targetID: number | null; sampledAt: number | null };
  const ordersInFlight = new Map<number, PendingOrder>();
  let bayRead: Promise<ReturnType<typeof checkedInventory>> | undefined;
  let sceneRead: ReturnType<typeof getSpaceSnapshot> | undefined;
  let launchLimitsRead: Promise<ReturnType<typeof effectiveDroneLimits>> | undefined;
  let launchLimitsSample:
    { value: NonNullable<ReturnType<typeof effectiveDroneLimits>>; expires: number } | undefined;
  let activeDroneCap: number | null = null;
  let combatInBay: boolean | undefined;
  let combatBayBeforeRecall: { stacks: DroneBay; expires: number } | undefined;
  let blockedLaunch = "",
    retryLaunchAt = 0;
  type TargetRefusal = { retryAt: number } | { distanceM: number; controlRangeM: number };
  const launched = new Set<number>(),
    unavailableTargets = new Map<number, TargetRefusal>();
  let rangeRefusalSample: { sampledAtMs: number | null; observedAt: number } | null = null;
  const combatShields = new Map<number, { ratio: number; recalls: number }>();
  let droneRangeSample: { meters: number; expires: number } | null = null;
  const cachedDroneRange = () =>
    droneRangeSample && Date.now() < droneRangeSample.expires ? droneRangeSample.meters : null;
  let droneRangeRead: ReturnType<typeof f.resolveDroneControlRange> | undefined;
  const combatWait = (reason: string, targetID?: number) =>
    timing?.change("miner-combat-decision", reason + ":" + targetID, { reason, targetID });

  const definitelyRefused = (error: unknown) => {
    const refusal = error as { code?: string; status?: number } | null;
    return refusal?.code === "CALL_REFUSED" && refusal.status === 409;
  };
  function observeThreat(scene: Scene) {
    const hostile = localHostiles(scene)[0] ?? null;
    timing?.change(
      "miner-hostile-observation",
      hostile?.itemID ?? "none",
      {
        targetID: hostile?.itemID,
        reason: hostile ? "qualified-hostile" : "no-qualified-hostile",
        sceneSampledAtMs: scene.sampledAtMs,
      },
      undefined,
      "essential",
    );
    return hostile;
  }
  function launchLimits() {
    if (launchLimitsSample && Date.now() < launchLimitsSample.expires)
      return Promise.resolve(launchLimitsSample.value);
    return (launchLimitsRead ??= f
      .bridgeAsk("dogmaIM", "QueryAllAttributesForItem", [shipID])
      .then((raw) => {
        const value = effectiveDroneLimits(raw);
        if (value?.maxActiveDrones != null && value.droneBandwidth != null)
          launchLimitsSample = { value, expires: Date.now() + 45_000 };
        return value;
      })
      .finally(() => {
        launchLimitsRead = undefined;
      }));
  }
  const prepareCombatLaunch = () => {
    void launchLimits().catch(() => {});
  };
  async function readDroneRange() {
    const cached = cachedDroneRange();
    if (cached !== null) return cached;
    const read = (droneRangeRead ??= f
      .resolveDroneControlRange(session.store.fitting.get())
      .finally(() => {
        droneRangeRead = undefined;
      }));
    const meters = await timed(
      timing,
      "miner-drone-control-range",
      () => boundedDroneRead(() => read, 8000),
      undefined,
      15000,
    ).catch(fleetReadFailed);
    held();
    if (meters === null || !Number.isFinite(meters) || meters <= 0)
      throw new FleetObservationUnavailable("Native drone control range is unavailable.");
    droneRangeSample = { meters, expires: Date.now() + 15000 };
    return meters;
  }
  const reconnectCandidate = (d: Entity) =>
    d.kind === "drone" && d.ownerID === run.characterID && d.controllerID === null;
  const sceneDrones = (scene: Scene) =>
    scene.entities
      .filter(
        (d) => d.kind === "drone" && (d.ownerID === run.characterID || d.controllerID === shipID),
      )
      .map((d) => ({
        itemID: d.itemID,
        typeID: d.typeID,
        controlled: d.ownerID === run.characterID && d.controllerID === shipID,
        activity: d.droneActivity,
        targetID: d.targetEntityID,
        shieldRatio: d.shieldRatio,
      }));
  const awaitingReconnect = (sampledAtMs: number | null) =>
    reconnectAttempt !== null &&
    (reconnectAttempt.inFlight ||
      sampledAtMs === null ||
      sampledAtMs <= reconnectAttempt.sampledAtMs);
  const launchKey = (fighting: boolean, drones: ReturnType<typeof sceneDrones>) =>
    JSON.stringify([
      fighting,
      [...drones]
        .sort((a, b) => a.itemID - b.itemID)
        .map((d) => [d.itemID, d.typeID, d.activity === "returning"]),
    ]);
  const launchDeferred = (key: string) => blockedLaunch === key && Date.now() < retryLaunchAt;
  async function readFlightPanel(scene?: Scene) {
    let panel: Awaited<ReturnType<typeof readFleetDronePanel>>;
    if (scene) {
      // The caller already read the held ship and its controlled drones. Only
      // the bay is missing; do not fetch a second space/ship-info panel.
      bayRead ??= Promise.resolve()
        .then(async () => {
          await f.bridgeDo("invCache", "InvalidateLocationCache", [shipID]);
          active();
          return checkedInventory(await f.bridgeAsk("invbroker", "List", [87], undefined, shipID));
        })
        .finally(() => {
          bayRead = undefined;
        });
      const work = bayRead;
      const rows = await boundedDroneRead(() => work, 12000).catch(fleetReadFailed);
      held();
      if (
        rows.some(
          (r) => r.ownerID !== run.characterID || r.locationID !== shipID || r.flagID !== 87,
        )
      )
        throw Error("Drone bay identity changed.");
      const bay = decodeDroneBay(
        rows.map((r) => ({ itemID: r.itemID, typeID: r.typeID, quantity: r.quantity })),
      );
      if (!bay) throw Error("Drone bay observation is unreadable.");
      panel = { bay, out: sceneDrones(scene), shipInfo: null };
    } else panel = await readFleetDronePanel(run, session, shipID, held);
    const bayKey = bayFingerprint(panel.bay);
    for (const [id, order] of ordersInFlight) {
      const d = panel.out.find((d) => d.itemID === id);
      if (
        panel.bay.some((d) => d.itemID === id) ||
        ((!scene || scene.sampledAtMs !== order.sampledAt) &&
          d?.controlled &&
          (order.targetID === null ? d.activity === "returning" : d.targetID === order.targetID))
      )
        ordersInFlight.delete(id);
    }
    for (const d of panel.bay) launched.delete(d.itemID);
    const pending = launchInDoubt;
    if (pending) {
      const deployed = panel.out.filter(
        (d) =>
          d.controlled &&
          !pending.out.has(d.itemID) &&
          d.typeID !== null &&
          pending.types.has(d.typeID),
      );
      const matchingBay = pending.combatBayOnly ? bayFingerprint(panel.bay, pending.types) : bayKey;
      if (deployed.length || (pending.done && matchingBay === pending.bay)) {
        for (const d of deployed) launched.add(d.itemID);
        launchInDoubt = null;
      }
    }
    return { ...panel, bayKey };
  }
  async function settle() {
    if (launchInDoubt || ordersInFlight.size) await readFlightPanel();
    if (launchInDoubt || ordersInFlight.size)
      throw Object.assign(Error("Mining drone command is awaiting native readback."), {
        code: "MCC_MODULE_SHUTDOWN_PENDING",
      });
  }
  async function order(
    ids: number[],
    target: Entity | null,
    fighting: boolean,
    scene: Scene,
    combatRange: number | null = null,
  ) {
    ids = ids.filter((id) => !ordersInFlight.has(id));
    if (!ids.length) return;
    active();
    const pending = { targetID: target?.itemID ?? null, sampledAt: scene.sampledAtMs };
    for (const id of ids) ordersInFlight.set(id, pending);
    const clear = () => {
      for (const id of ids) if (ordersInFlight.get(id) === pending) ordersInFlight.delete(id);
    };
    const dispatch = async () => {
      try {
        const result = target
          ? await f.bridgeDo("entity", fighting ? "CmdEngage" : "CmdMineRepeatedly", [
              ids,
              target.itemID,
            ])
          : await returnDronesToBay(f.bridgeDo, ids);
        checkDroneEngage(result, ids);
      } catch (error) {
        if (error instanceof DroneOrderRefused || definitelyRefused(error)) {
          if (fighting && target && ids.some((id) => ordersInFlight.get(id) === pending)) {
            if (
              combatRange !== null &&
              error instanceof Error &&
              error.message.includes("That target is out of drone control range.")
            ) {
              unavailableTargets.set(target.itemID, {
                distanceM: distance(scene.ship!, target),
                controlRangeM: combatRange,
              });
              rangeRefusalSample = {
                sampledAtMs: scene.sampledAtMs,
                observedAt: performance.now(),
              };
              droneRangeSample = null;
            } else unavailableTargets.set(target.itemID, { retryAt: Date.now() + 5000 });
          }
          clear();
        }
        throw error;
      }
      // A successful return order can leave the drone on the old grid until
      // native movement catches up. Keep it pending until that flight changes.
      if (target) clear();
    };
    try {
      await timed(
        timing,
        target
          ? fighting
            ? "miner-cmd-engage-rpc"
            : "miner-cmd-mine-rpc"
          : "miner-drone-recall-rpc",
        () => boundedDroneWrite(dispatch, 12000, () => {}),
        { targetID: target?.itemID, droneCount: ids.length },
        0,
        !target || fighting ? "essential" : "verbose",
      );
    } catch (error) {
      if (fighting && target) {
        const refused = error instanceof DroneOrderRefused || definitelyRefused(error);
        combatWait(refused ? "native-engage-refused" : "native-engage-unconfirmed", target.itemID);
      }
      throw error;
    }
  }

  async function tick(
    initial: Scene,
    observedThreat: Entity | null,
    rock: Entity | null,
    observedAt = performance.now(),
    latestMiningScene?: () => SceneObservation | undefined,
  ) {
    let scene = initial,
      controlRange: number | null = null,
      combatRange: number | null = null;
    let combatTargets: Entity[] = [];
    if (scene.stateValid === false || !scene.inSpace || !scene.ship?.geometryAvailable)
      return { available: false, combat, controlRange };
    const afterRangeRefusal = (view: Scene, at: number) =>
      !rangeRefusalSample ||
      (at >= rangeRefusalSample.observedAt &&
        view.sampledAtMs !== null &&
        (rangeRefusalSample.sampledAtMs === null ||
          view.sampledAtMs > rangeRefusalSample.sampledAtMs));
    const useScene = (fresh: Scene, at: number) => {
      if (
        !fresh.inSpace ||
        fresh.stateValid === false ||
        fresh.shipID !== shipID ||
        fresh.solarSystemID !== initial.solarSystemID ||
        fresh.ship?.itemID !== shipID ||
        (fresh.ship.characterID !== null && fresh.ship.characterID !== run.characterID) ||
        !fresh.ship.geometryAvailable ||
        fresh.ship.warp ||
        fresh.ship.mode?.toUpperCase() === "WARP" ||
        fresh.sampledAtMs === null ||
        (scene.sampledAtMs !== null && fresh.sampledAtMs < scene.sampledAtMs) ||
        !afterRangeRefusal(fresh, at)
      )
        return false;
      active();
      scene = fresh;
      observedAt = at;
      rangeRefusalSample = null;
      return true;
    };
    const useMiningScene = () => {
      const latest = latestMiningScene?.();
      return (
        latest &&
        latest.observedAt > observedAt &&
        performance.now() - latest.observedAt <= sceneFreshMs &&
        useScene(latest.space, latest.observedAt)
      );
    };
    const refreshIfStale = async () => {
      if (useMiningScene()) return;
      if (performance.now() - observedAt <= sceneFreshMs && afterRangeRefusal(scene, observedAt)) {
        rangeRefusalSample = null;
        return;
      }
      // Ending this pass's wait does not cancel the transport request.
      const read = (sceneRead ??= getSpaceSnapshot(options).finally(() => {
        sceneRead = undefined;
      }));
      try {
        const { space: raw } = await timed(
          timing,
          "miner-drone-grid",
          () => boundedDroneRead(() => read, 8000),
          undefined,
          15000,
        );
        if (useMiningScene()) return;
        if (
          !raw ||
          !Array.isArray((raw as { entities?: unknown }).entities) ||
          !useScene(decodeSpaceSnapshot(raw), performance.now())
        )
          throw new FleetObservationUnavailable("Mining drone grid is temporarily unreadable.");
      } catch (error) {
        if (!useMiningScene()) fleetReadFailed(error);
      }
    };
    const refreshCombatTargets = async () => {
      await refreshIfStale();
      let nearby = localHostiles(scene);
      if (nearby.length) {
        combatRange = await readDroneRange();
        const before = scene;
        await refreshIfStale();
        if (scene !== before) nearby = localHostiles(scene);
      }
      const visibleIDs = new Set(nearby.map((e) => e.itemID));
      for (const id of unavailableTargets.keys())
        if (!visibleIDs.has(id)) unavailableTargets.delete(id);
      combatTargets = nearby.filter((e) => {
        const meters = distance(scene.ship!, e),
          refusal = unavailableTargets.get(e.itemID);
        // An unchanged range and position do not invalidate a native refusal.
        return (
          combatRange !== null &&
          meters <= combatRange &&
          (!refusal ||
            "retryAt" in refusal ||
            meters < refusal.distanceM ||
            combatRange > refusal.controlRangeM)
        );
      });
      const hostile = combatTargets[0];
      combatWait(
        hostile ? "hostile-in-control-range" : "no-hostile-in-control-range",
        hostile?.itemID,
      );
    };
    const chooseCombatTarget = (drones: readonly { targetID: number | null }[]) => {
      const eligible = combatTargets.filter((e) => {
        const refusal = unavailableTargets.get(e.itemID);
        return !refusal || !("retryAt" in refusal) || refusal.retryAt <= Date.now();
      });
      return (
        eligible.find((e) => drones.some((d) => d.targetID === e.itemID)) ?? eligible[0] ?? null
      );
    };
    if ((rock || observedThreat || combat) && scene.entities.some(reconnectCandidate))
      await refreshIfStale();
    if (observedThreat || combat || rangeRefusalSample || scene !== initial)
      await refreshCombatTargets();
    let hostile = combatTargets[0] ?? null;
    let visible = sceneDrones(scene),
      deployed = visible.filter((d) => d.controlled);
    let reconnectable = scene.entities.filter(reconnectCandidate),
      sampledAt = scene.sampledAtMs;
    if (reconnectAttempt && sampledAt !== null && sampledAt > reconnectAttempt.sampledAtMs) {
      for (const d of deployed) if (reconnectAttempt.ids.has(d.itemID)) launched.add(d.itemID);
      if (!reconnectable.length && !reconnectAttempt.inFlight) reconnectAttempt = null;
    }
    for (const [id, order] of ordersInFlight) {
      if (
        order.sampledAt !== null &&
        (scene.sampledAtMs === null || scene.sampledAtMs <= order.sampledAt)
      )
        continue;
      const d = visible.find((d) => d.itemID === id);
      const targetGone =
        order.targetID !== null && !scene.entities.some((e) => e.itemID === order.targetID);
      if (
        !d ||
        targetGone ||
        (d.controlled &&
          (order.targetID === null ? d.activity === "returning" : d.targetID === order.targetID))
      )
        ordersInFlight.delete(id);
      else combatWait("awaiting-native-order-readback", order.targetID ?? undefined);
    }
    if (launchInDoubt) {
      const pending = launchInDoubt;
      const deployed = visible.filter(
        (d) =>
          d.controlled &&
          !pending.out.has(d.itemID) &&
          d.typeID !== null &&
          pending.types.has(d.typeID),
      );
      if (deployed.length) {
        for (const d of deployed) launched.add(d.itemID);
        launchInDoubt = null;
      }
    }
    const earlyRecalled = new Set<number>();
    const knownRoles = session.store.names.get().resolved;
    const knownRole = (typeID: number | null) =>
      droneRoleForGroup(typeID === null ? null : knownRoles[nameKey("typeGroup", typeID)]);
    let visibleCombat = deployed.filter((d) => knownRole(d.typeID) === "combat");
    const freshScene = performance.now() - observedAt <= sceneFreshMs;
    const earlyCommands: Promise<void>[] = [];
    if (freshScene) {
      const recall = (
        hostile && (visibleCombat.length || combatInBay)
          ? visible.filter((d) => d.controlled && knownRole(d.typeID) === "mining")
          : !hostile
            ? visibleCombat
            : []
      )
        .filter((d) => d.activity !== "returning" && !ordersInFlight.has(d.itemID))
        .map((d) => d.itemID);
      if (recall.length) {
        combat = true;
        if (hostile) combatWait("recalling-mining-drones", hostile.itemID);
        earlyCommands.push(order(recall, null, false, scene));
        if (hostile && combatInBay === true) prepareCombatLaunch();
        for (const id of recall) earlyRecalled.add(id);
      }
    }
    const earlyOrdered = new Set<number>();
    let earlyTarget: number | null = null;
    if (freshScene && hostile && visibleCombat.length) {
      const target = chooseCombatTarget(visibleCombat);
      if (target) {
        const idle = visibleCombat
          .filter(
            (d) =>
              d.activity !== "returning" &&
              !ordersInFlight.has(d.itemID) &&
              (d.targetID !== target.itemID ||
                !["fighting", "chasing", "approaching"].includes(d.activity ?? "")),
          )
          .map((d) => d.itemID);
        if (idle.length) {
          earlyCommands.push(order(idle, target, true, scene, combatRange));
          for (const id of idle) earlyOrdered.add(id);
          earlyTarget = target.itemID;
        }
      }
    }
    await Promise.all(earlyCommands);
    if (useMiningScene()) {
      await refreshCombatTargets();
      hostile = combatTargets[0] ?? null;
      visible = sceneDrones(scene);
      deployed = visible.filter((d) => d.controlled);
      visibleCombat = deployed.filter((d) => knownRole(d.typeID) === "combat");
      reconnectable = scene.entities.filter(reconnectCandidate);
      sampledAt = scene.sampledAtMs;
    }
    const needsFlight = !!(rock || hostile);
    if (!hostile) combatInBay = undefined;
    if (!hostile || visibleCombat.length) combatBayBeforeRecall = undefined;
    if (hostile && combat && (combatInBay === true || visibleCombat.length)) {
      const miningOut = deployed.filter((d) => knownRole(d.typeID) === "mining").length;
      timing?.change(
        "miner-mining-flight-observed",
        miningOut,
        { controlledMiningDrones: miningOut, targetID: hostile.itemID },
        undefined,
        "essential",
      );
    }
    if (
      needsFlight &&
      reconnectable.length &&
      sampledAt !== null &&
      scene.shipID === shipID &&
      scene.ship?.itemID === shipID &&
      (scene.ship.characterID === null || scene.ship.characterID === run.characterID) &&
      !scene.ship.warp &&
      scene.ship.mode?.toUpperCase() !== "WARP" &&
      performance.now() - observedAt <= sceneFreshMs &&
      !launchInDoubt &&
      !reconnectAttempt?.inFlight &&
      (!reconnectAttempt || sampledAt > reconnectAttempt.sampledAtMs) &&
      (activeDroneCap === null || deployed.length < activeDroneCap)
    ) {
      // GamePort can omit the state of an owned ball. EveJS checks ownership,
      // free control and bandwidth; only a later scene confirms a reconnect.
      const ids = reconnectable
        .map((d) => d.itemID)
        .sort((a, b) => a - b)
        .slice(0, 25);
      const signature = JSON.stringify([ids, deployed.map((d) => d.itemID).sort((a, b) => a - b)]);
      if (reconnectAttempt?.signature !== signature) {
        active();
        const attempt = { signature, ids: new Set(ids), sampledAtMs: sampledAt, inFlight: true };
        reconnectAttempt = attempt;
        await timed(
          timing,
          "miner-drone-reconnect-rpc",
          () =>
            boundedDroneWrite(
              async () => {
                try {
                  await f.bridgeDo("entity", "CmdReconnectToDrones", [ids]);
                } finally {
                  attempt.inFlight = false;
                }
              },
              12000,
              () => {},
            ),
          { droneCount: ids.length },
        );
      }
    }
    const working = (d: (typeof deployed)[number], id: number, fighting: boolean) =>
      (earlyTarget === id && earlyOrdered.has(d.itemID)) ||
      (d.targetID === id &&
        (fighting ? ["fighting", "chasing", "approaching"] : ["mining", "approaching"]).includes(
          d.activity ?? "",
        ));
    const miningRock = () =>
      rock
        ? scene.entities.find(
            (e) =>
              e.itemID === rock.itemID &&
              e.categoryID === rock.categoryID &&
              e.typeID === rock.typeID &&
              e.geometryAvailable &&
              e.remainingQuantity !== 0,
          )
        : undefined;
    const ore = hostile ? undefined : miningRock();
    // Command already deployed Mining Drones first; an optional top-up can wait one pass.
    const assignMiningFirst =
      !!ore &&
      deployed.some(
        (d) =>
          knownRole(d.typeID) === "mining" &&
          d.activity !== "returning" &&
          !ordersInFlight.has(d.itemID) &&
          !working(d, ore.itemID, false),
      );
    const limit = activeDroneCap ?? f.withPilotDroneCap(decodeDroneLimits(null)).maxActiveDrones;
    const atCap = limit !== null && limit > 0 && deployed.length >= limit;
    const awaitingRecall =
      activeDroneCap === null &&
      deployed.length > 0 &&
      deployed.every(
        (d) =>
          d.activity === "returning" ||
          earlyRecalled.has(d.itemID) ||
          ordersInFlight.get(d.itemID)?.targetID === null,
      );
    const plannedCombat = !!hostile && (visibleCombat.length > 0 || combatInBay === true);
    const controlUnconfirmed = reconnectable.length > 0 || awaitingReconnect(sampledAt);
    if (controlUnconfirmed && !deployed.length && !launchInDoubt && needsFlight)
      throw new FleetObservationUnavailable(
        "Waiting for native control observation of drones in space.",
      );
    const needsBay =
      !assignMiningFirst &&
      (!!launchInDoubt ||
        (!controlUnconfirmed &&
          !atCap &&
          !awaitingRecall &&
          needsFlight &&
          !launchDeferred(launchKey(plannedCombat, deployed))) ||
        (!!hostile && combatInBay === undefined && !visibleCombat.length));
    if (needsBay && hostile && plannedCombat && !atCap && !controlUnconfirmed)
      prepareCombatLaunch();
    // Returning Mining Drones change the mining stacks, not the combat stacks
    // already verified in this drone bay. Reuse them once, with free slots
    // confirmed on the current grid and no unconfirmed drone control or launch.
    const preparedBay =
      hostile &&
      combat &&
      !deployed.length &&
      !controlUnconfirmed &&
      !launchInDoubt &&
      combatBayBeforeRecall &&
      Date.now() < combatBayBeforeRecall.expires
        ? combatBayBeforeRecall.stacks
        : null;
    const { bay, out, bayKey, shipInfo } = needsBay
      ? preparedBay
        ? { bay: preparedBay, out: visible, bayKey: "", shipInfo: null }
        : await timed(timing, "miner-drone-panel", () => readFlightPanel(scene), undefined, 15000)
      : { bay: [], out: visible, bayKey: "", shipInfo: null };
    active();
    const controlled = out.filter((row) => row.controlled);
    const known = session.store.names.get().resolved;
    const missing = [
      ...new Set(
        [...bay, ...controlled].flatMap((d) =>
          d.typeID === null || known[nameKey("typeGroup", d.typeID)] ? [] : [d.typeID],
        ),
      ),
    ];
    if (missing.length)
      await boundedDroneRead(
        () => f.resolveNamesNow(missing.map((id) => ({ kind: "typeGroup", id }))),
        12000,
      ).catch(fleetReadFailed);
    const groups = missing.length ? session.store.names.get().resolved : known;
    const roleOf = (typeID: number | null) =>
      droneRoleForGroup(typeID === null ? null : groups[nameKey("typeGroup", typeID)]);
    const combatOut = controlled.filter((d) => roleOf(d.typeID) === "combat");
    if (needsBay && hostile) {
      const bayRoles = bay.map((d) => roleOf(d.typeID));
      // A partial type lookup cannot establish that a full mining flight has
      // no replacements. Keep checking the bay while the hostile is reachable.
      combatInBay = bayRoles.includes("combat")
        ? true
        : bayRoles.includes(null)
          ? undefined
          : false;
      if (!preparedBay) {
        combatBayBeforeRecall =
          combatInBay &&
          controlled.length &&
          controlled.every((drone) => roleOf(drone.typeID) === "mining")
            ? {
                stacks: bay.filter((drone) => roleOf(drone.typeID) === "combat"),
                expires: Date.now() + 45_000,
              }
            : undefined;
      }
    }
    const hasCombat = combatOut.length > 0 || combatInBay === true;

    const wanted = hostile && hasCombat ? "combat" : "mining";
    const fighting = wanted === "combat";
    const ready = controlled.filter(
      (d) => d.activity !== "returning" && roleOf(d.typeID) === wanted,
    );
    const available = bay.filter((d) => roleOf(d.typeID) === wanted);
    // Keep the recovery pass eligible for early service until mining resumes.
    combat =
      fighting ||
      combatOut.length > 0 ||
      (combat && !hostile && (ready.length > 0 || available.length > 0));
    let takingFire: (typeof ready)[number] | undefined;
    if (!fighting) combatShields.clear();
    else
      for (const drone of combatOut) {
        const ratio = drone.shieldRatio;
        if (ratio === null) continue;
        const prior = combatShields.get(drone.itemID);
        combatShields.set(drone.itemID, { ratio, recalls: prior?.recalls ?? 0 });
        if (
          prior &&
          ratio < prior.ratio &&
          prior.recalls < 3 &&
          drone.activity !== "returning" &&
          ratio < (takingFire?.shieldRatio ?? Infinity)
        )
          takingFire = drone;
      }
    const status = () => ({
      available: ready.length > 0 || available.length > 0,
      combat,
      controlRange,
    });
    if (hostile) {
      timing?.change(
        "miner-combat-flight-observed",
        combatOut.length,
        { controlledCombatDrones: combatOut.length, targetID: hostile.itemID },
        undefined,
        "essential",
      );
      if (!hasCombat) {
        const unresolved =
          combatInBay === undefined || controlled.some((drone) => roleOf(drone.typeID) === null);
        combatWait(
          unresolved ? "combat-drone-types-unavailable" : "no-classified-combat-drones",
          hostile.itemID,
        );
        report(
          "Escort needed",
          unresolved
            ? "A hostile is on grid. Combat drone types are temporarily unavailable."
            : "A hostile is on grid. This miner has no usable combat drone flight.",
        );
      }
    }

    const targetOnGrid = () => {
      if (!fighting) {
        if (combatTargets.length && (hasCombat || assignMiningFirst)) return null;
        return miningRock() ?? null;
      }
      return chooseCombatTarget(ready);
    };
    const recallCandidate = (d: (typeof controlled)[number]) =>
      d.controlled &&
      !earlyRecalled.has(d.itemID) &&
      !ordersInFlight.has(d.itemID) &&
      d.activity !== "returning" &&
      roleOf(d.typeID) === (fighting ? "mining" : "combat");
    if (controlled.some(recallCandidate)) {
      await refreshCombatTargets();
      const currentHostile = combatTargets[0];
      if (fighting !== !!(currentHostile && hasCombat)) return status();
      const recall = sceneDrones(scene)
        .filter(recallCandidate)
        .map((d) => d.itemID);
      if (recall.length) {
        if (fighting) combatWait("recalling-mining-drones", currentHostile?.itemID);
        const recalled = order(recall, null, false, scene);
        if (fighting && combatInBay === true) prepareCombatLaunch();
        await recalled;
      }
    }
    if (!ready.length && !available.length) {
      if (controlUnconfirmed && needsFlight)
        throw new FleetObservationUnavailable(
          "Waiting for native control observation of drones in space.",
        );
      return status();
    }
    let target = targetOnGrid();
    if (!target) return status();
    const signature = launchKey(fighting, controlled);
    const deferLaunch = () => {
      blockedLaunch = signature;
      retryLaunchAt = Date.now() + 5000;
    };
    // A confirmed absence of a spare flight uses the same retry window as a launch limit.
    if (
      needsBay &&
      !available.length &&
      ready.length &&
      bay.every((d) => groups[nameKey("typeGroup", d.typeID)])
    )
      deferLaunch();
    const needsOrder = ready.some(
      (d) => !working(d, target!.itemID, fighting) && !ordersInFlight.has(d.itemID),
    );
    const canLaunch =
      available.length > 0 &&
      !controlUnconfirmed &&
      !launchInDoubt &&
      !controlled.some((d) => d.typeID === null) &&
      !launchDeferred(signature);
    if (!fighting && (needsOrder || canLaunch)) {
      controlRange = await readDroneRange();
      if (distance(scene.ship!, target) > controlRange) return status();
    } else if (!fighting) controlRange = cachedDroneRange();
    if (needsOrder) {
      await refreshCombatTargets();
      target = targetOnGrid();
      if (!target || (controlRange !== null && distance(scene.ship!, target) > controlRange))
        return status();
      const id = target.itemID;
      const idle = sceneDrones(scene)
        .filter(
          (d) =>
            d.controlled &&
            d.activity !== "returning" &&
            roleOf(d.typeID) === wanted &&
            !working(d, id, fighting) &&
            !ordersInFlight.has(d.itemID),
        )
        .map((d) => d.itemID);
      if (idle.length) await order(idle, target, fighting, scene, combatRange);
    } else if (ready.length && ready.every((d) => working(d, target!.itemID, fighting))) {
      if (fighting)
        timing?.change("miner-engage-observed", target.itemID, {
          targetID: target.itemID,
          engagedDroneCount: ready.length,
        });
      report(
        fighting ? "Defending miner" : "Mining with drones",
        fighting
          ? "Controlled combat drones are engaging a hostile NPC on this grid."
          : "Native scene confirms the mining drone order.",
      );
    }
    if (!fighting && ready.length && !combatOut.length) combat = false;
    const rotateDamagedDrone = async () => {
      if (
        takingFire &&
        ready.length > 1 &&
        !ordersInFlight.has(takingFire.itemID) &&
        ready.every((d) => working(d, target!.itemID, fighting))
      ) {
        await refreshCombatTargets();
        if (
          !combatTargets.length ||
          !sceneDrones(scene).some(
            (d) => d.itemID === takingFire!.itemID && d.controlled && d.activity !== "returning",
          )
        )
          return status();
        const sample = combatShields.get(takingFire.itemID)!;
        sample.recalls++;
        await order([takingFire.itemID], null, false, scene);
      }
      return status();
    };
    if (!canLaunch) return rotateDamagedDrone();
    // A full mining flight still occupies the slots while flying home. Its
    // recall is already out, so leave the capacity read running for the next grid.
    if (
      fighting &&
      atCap &&
      controlled.every(
        (d) => d.activity === "returning" || ordersInFlight.get(d.itemID)?.targetID === null,
      )
    )
      return status();
    const base = decodeDroneLimits(shipInfo);
    const live = await timed(
      timing,
      "miner-drone-launch-limits",
      () => boundedDroneRead(launchLimits, 12000),
      undefined,
      15000,
    ).catch(fleetReadFailed);
    active();
    const maxActive = live?.maxActiveDrones ?? f.withPilotDroneCap(base).maxActiveDrones;
    const droneBandwidth = live?.droneBandwidth ?? base.droneBandwidth;
    if (maxActive === null || droneBandwidth === null)
      throw new FleetObservationUnavailable(
        "Native drone launch capacity is temporarily unavailable.",
      );
    activeDroneCap = maxActive;
    if (controlled.length >= maxActive) {
      deferLaunch();
      return rotateDamagedDrone();
    }
    const launchOccupants = controlled.map((d) => ({ typeID: d.typeID! }));
    const types = [...new Set([...available, ...launchOccupants].map((d) => d.typeID))];
    const facts = await boundedDroneRead(() => f.attributesOfTypes(types, [1272]), 12000).catch(
      fleetReadFailed,
    );
    const stacks = planCombatDroneLaunch(
      available.map((d) => ({ ...d, quantity: d.quantity === -1 ? 1 : d.quantity })),
      launchOccupants,
      { maxActiveDrones: maxActive, droneBandwidth },
      Object.fromEntries(types.map((id) => [id, facts[id]?.[1272]])),
    );
    if (!stacks.length) {
      deferLaunch();
      return rotateDamagedDrone();
    }

    await refreshCombatTargets();
    target = targetOnGrid();
    if (!target || (controlRange !== null && distance(scene.ship!, target) > controlRange))
      return status();
    if (scene.entities.some(reconnectCandidate) || awaitingReconnect(scene.sampledAtMs))
      return status();
    const stillDeployed = sceneDrones(scene).filter((d) => d.controlled);
    if (
      stillDeployed.length !== controlled.length ||
      !stillDeployed.every((drone) =>
        controlled.some(
          (previous) => previous.itemID === drone.itemID && previous.typeID === drone.typeID,
        ),
      )
    )
      return status();
    active();
    const typesLaunched = new Set(stacks.map((d) => d.typeID)),
      combatBayOnly = !!preparedBay;
    const pending = {
      done: false,
      bay: combatBayOnly ? bayFingerprint(bay, typesLaunched) : bayKey,
      out: new Set(controlled.map((d) => d.itemID)),
      types: typesLaunched,
      combatBayOnly,
    };
    combatBayBeforeRecall = undefined;
    launchInDoubt = pending;
    let receipt: ReturnType<typeof readCombatDroneLaunch>;
    try {
      const result = await timed(
        timing,
        "miner-drone-launch-rpc",
        () =>
          boundedDroneWrite(
            () =>
              f
                .bridgeDo("ship", "LaunchDrones", [
                  stacks.map((d) => [d.itemID, d.quantity]),
                  null,
                  false,
                ])
                .finally(() => {
                  pending.done = true;
                }),
            12000,
            () => {},
          ),
        {
          flight: wanted,
          targetID: target.itemID,
          plannedDrones: stacks.reduce((n, d) => n + d.quantity, 0),
        },
        0,
        fighting ? "essential" : "verbose",
      );
      receipt = readCombatDroneLaunch(result, stacks);
    } catch (error) {
      if (definitelyRefused(error)) {
        launchInDoubt = null;
        deferLaunch();
      }
      throw error;
    }
    launchInDoubt = null;
    for (const id of receipt.ids) launched.add(id);
    timing?.note(
      "miner-drone-launch-response",
      {
        flight: wanted,
        targetID: target.itemID,
        accepted: receipt.ids.length,
        refused: receipt.refusals.length,
      },
      fighting ? "essential" : "verbose",
    );
    if (receipt.refusals.length) {
      deferLaunch();
      report("Drone launch limited", receipt.refusals.join(" "));
    }
    if (receipt.ids.length) {
      await refreshCombatTargets();
      target = targetOnGrid();
      if (target && (controlRange === null || distance(scene.ship!, target) <= controlRange)) {
        await order(receipt.ids, target, fighting, scene, combatRange);
        if (!fighting && !combatOut.length) combat = false;
      }
    }
    return status();
  }
  return {
    tick,
    settle,
    observeThreat,
    get combat() {
      return combat;
    },
    get launchedIDs() {
      return [...launched];
    },
  };
}
