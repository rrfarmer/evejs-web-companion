import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import {
  decodeSpaceSnapshot,
  decodeDroneBay,
  decodeTargetIDs,
  getTargets,
  REPAIR_CAP_FLOOR,
} from "../../../web/src/plugin-api/flying.ts";
import { createSecurityFighter, type FighterFrame, type FighterTarget } from "./fighter.ts";
import { isSecurityTarget } from "./securityTargets.ts";
import { confirmAbsentTarget } from "./targetAbsence.ts";
import {
  boundedDroneRead,
  boundedDroneWrite,
  allDronesTargetUnavailable,
  checkDroneEngage,
  DroneOrderRefused,
  launchedDroneIDs,
  readCombatDroneLaunch,
  stalledReturn,
} from "./droneAdapter.ts";
import { checkedInventory } from "../shared/nativeInventory.ts";
import { decodeModuleObservation } from "../shared/moduleObservation.ts";
import { FleetRoomRetired } from "./fleetAuthority.ts";
import type { Identity } from "./security.ts";
import type { SecurityStorage } from "./journal.ts";
import {
  combatFitModules,
  assertScopedWeaponCharge,
  isRemoteRepair,
  type CombatFitModule,
} from "./moduleFit.ts";
import { executeCombatTargetLock } from "./moduleLock.ts";
import { alreadyActiveRefusal, executeCombatModuleAction } from "./moduleAction.ts";
import { isListValue, unwrapLong, unwrapReal, type JsonValue } from "../shared/wire.ts";
import { lostLockTarget } from "../shared/targetEvents.ts";
import { targetNotLockedRefusal } from "../mining/activation.ts";
import type { EscortWeapon } from "../miningFleet/defenderTargets.ts";
import { combatWeaponRange, type DefenderPreparation } from "./defenderPreparation.ts";
import { chooseCombatAmmo, executeCombatReload, observeCombatReloads } from "./moduleReload.ts";
import { timed, type MccTiming } from "../miningFleet/timing.ts";
import { fleetReadFailed, FleetObservationUnavailable } from "../miningFleet/stopSignal.ts";
import { bridgeCallQueueTimeout, transientNativeRead } from "../shared/progressDeadline.ts";
type Scene = ReturnType<typeof decodeSpaceSnapshot>;
export interface PilotFighterState<I = Identity> {
  currentIdentity: I | null;
  entryAnchor: { x: number; y: number; z: number } | null;
  droneUnresolved: boolean;
}
export interface PilotFighterDeps<I = Identity> {
  run: PluginRunContext;
  session: () => PilotSession;
  state: PilotFighterState<I>;
  current: () => void;
  guard: () => void;
  flight: () => Promise<any>;
  mission: () => Promise<any>;
  dungeon: () => Promise<any>;
  scene: () => Promise<Scene>;
  ask: (service: string, method: string, args?: unknown[], of?: number) => Promise<any>;
  diagnostic: (kind: string, data: unknown) => void;
  droneSample: (scene: Scene, ids: readonly number[], target: number | null) => unknown;
  fenceCombat: (target: number | null) => Promise<void>;
  selectTargets?: (targets: readonly FighterTarget[]) => readonly FighterTarget[];
  checkBeforeEngage?: (target: number) => void;
  isQualifiedTarget?: (identity: I | null, entity: Scene["entities"][number]) => boolean;
  confirmTargetAbsent?: (input: {
    identity: I;
    ids: readonly number[];
    target: number;
    preEngage: Scene;
    observed?: Scene;
  }) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  moduleStops?: Set<number>;
  moduleDocuments?: { locks: SecurityStorage; actions: SecurityStorage; reloads?: SecurityStorage };
  friendlyMembers?: readonly { characterID: number; shipID: number }[];
  fenceFriendly?: (characterID: number, shipID: number) => Promise<void>;
  fenceRoomForAbsence?: () => Promise<void>;
  defender?: {
    protectedShips: readonly number[];
    recall?: (ids: readonly number[]) => Promise<boolean>;
    timing?: MccTiming;
    preparation: DefenderPreparation;
    approach(target: number, range: number, view: Scene): Promise<boolean | void>;
    checkTarget?(target: number, view: Scene): Promise<void>;
    filterTargets?(scene: Scene, targets: Scene["entities"][number][]): Scene["entities"][number][];
    rankTargets(input: {
      ship: NonNullable<Scene["ship"]>;
      targets: readonly Scene["entities"][number][];
      weapons: readonly EscortWeapon[];
      signatureByType: Readonly<Record<number, Readonly<Record<number, number>>>>;
      lockRange: number | null;
      droneRange: number | null;
    }): readonly FighterTarget[];
    supportCapable?: () => boolean;
  };
}
const DRONE_NATIVE_IO_TIMEOUT_MS = 90_000;
const DRONE_OBSERVATION_TIMEOUT_MS = 90_000;
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
/** The checked scene does not contain this target; no outcome is inferred. */
export class SecurityTargetUnobserved extends Error {}
/** Per-pilot drone custody and native effect settlement. */
export function createPilotFighter<I = Identity>(env: PilotFighterDeps<I>) {
  const {
    run,
    session,
    state,
    current,
    guard,
    flight,
    mission,
    dungeon,
    scene,
    ask,
    diagnostic,
    droneSample,
    fenceCombat,
    sleep,
  } = env;
  const preparation = env.defender?.preparation;
  const defenderRead = <T>(read: Promise<T>) => (env.defender ? read.catch(fleetReadFailed) : read);
  if (Boolean(env.isQualifiedTarget) !== Boolean(env.confirmTargetAbsent))
    throw Error("Non-Security combat requires both target qualification and absence authority.");
  const qualified =
    env.isQualifiedTarget ??
    ((identity: I | null, entity: Scene["entities"][number]) =>
      isSecurityTarget(identity as Identity | null, entity));
  const moduleStops = env.moduleStops ?? new Set<number>(),
    droneCustody = new Set<number>(),
    droneReturns = new Map<number, { at: number; distance: number; rearmed: boolean }>();
  let weapons: CombatFitModule[] = [],
    fitModules: CombatFitModule[] = [],
    weaponRevision = 0;
  const weaponRanges = new Map<number, number>(),
    defenseOrdinals = new Map<number, number>(),
    supportOrdinals = new Map<number, number>(),
    reloadOrdinals = new Map<number, number>();
  type WeaponEffects = { online: boolean; active: boolean; targets: readonly number[] };
  const defenderWeaponStates = new Map<number, WeaponEffects>();
  let defenderReloadWork: Promise<void> | undefined;
  let defenderReloadPending = false,
    defenderReloadRetryAt = 0;
  type Fitting = ReturnType<PilotSession["store"]["fitting"]["get"]>;
  const observeReloads = (document: SecurityStorage, shipID: number, fit: Fitting) =>
    observeCombatReloads(document, { characterID: run.characterID, shipID }, (identity) =>
      fit.slots.some(
        ({ module }) =>
          module?.itemID === identity.moduleID &&
          module.typeID === identity.moduleTypeID &&
          module.charge?.typeID === identity.chargeTypeID &&
          module.charge.quantity > 0,
      ),
    );
  const reloadWeapon = async (
    m: CombatFitModule,
    shipID: number,
    chargeFit: { size: number | null; groups: readonly number[] },
    document: SecurityStorage,
  ) => {
    const flying = session().flow.flying,
      native = await moduleObservation(m, shipID);
    if (native.effects.some((e) => e.effectID !== 16)) return false;
    await fenceCombat(null);
    guard();
    await defenderRead(
      boundedDroneRead(
        () => ask("invCache", "InvalidateLocationCache", [shipID]),
        DRONE_NATIVE_IO_TIMEOUT_MS,
      ),
    );
    const raw = await defenderRead(
        boundedDroneRead(() => ask("invbroker", "List", [5], shipID), DRONE_NATIVE_IO_TIMEOUT_MS),
      ),
      cargo = checkedInventory(raw);
    if (
      cargo.some((r) => r.ownerID !== run.characterID || r.locationID !== shipID || r.flagID !== 5)
    )
      throw Error("Combat ammunition cargo is not owned by the held ship.");
    let list: any = raw;
    if (
      list?.type === "objectex1" &&
      list.header?.[0]?.value === "__builtin__.set" &&
      Array.isArray(list.header?.[1])
    )
      list = list.header[1][0];
    if (list?.type !== "list" || !Array.isArray(list.items))
      throw Error("Combat ammunition cargo is unreadable.");
    const rows = cargo.map((r, i) => {
      const item = list.items[i]?.type === "packedrow" ? list.items[i].fields : list.items[i];
      return { ...r, groupID: positive(item?.groupID) ? item.groupID : null };
    });
    const types = [...new Set(rows.map((r) => r.typeID))];
    const ammoFacts = types.length
      ? await defenderRead(
          boundedDroneRead(
            () => flying.attributesOfTypes(types, [128, 1455]),
            DRONE_NATIVE_IO_TIMEOUT_MS,
          ),
        )
      : {};
    const choice = chooseCombatAmmo(rows, chargeFit, ammoFacts);
    guard();
    if (!choice) return false;
    const ordinal = (reloadOrdinals.get(m.itemID) ?? 0) + 1;
    reloadOrdinals.set(m.itemID, ordinal);
    const identity = {
      key: JSON.stringify([run.botID, run.characterID, shipID, m.itemID, "reload", ordinal]),
      characterID: run.characterID,
      shipID,
      moduleID: m.itemID,
      moduleTypeID: m.typeID,
      cargoItemID: choice.itemID,
      chargeTypeID: choice.typeID,
    };
    await executeCombatReload(identity, {
      document,
      current: guard,
      fence: () => fenceCombat(null),
      deferConfirmation: !!env.defender,
      load: () => {
        if (env.defender) defenderReloadPending = true;
        return boundedDroneWrite(
          () => flying.loadAmmoFrom([m.itemID], [choice.itemID], "cargo"),
          DRONE_NATIVE_IO_TIMEOUT_MS,
          () => {
            if (!env.defender) state.droneUnresolved = true;
          },
        );
      },
      loaded: async () => {
        await ask("invCache", "InvalidateLocationCache", [shipID]);
        if (!(await flying.readFit())) return false;
        guard();
        const after = session().store.fitting.get();
        const module =
          after.activeShipID === shipID && after.slotsError === null
            ? after.slots.find((s) => s.module?.itemID === m.itemID)?.module
            : null;
        return (
          !!module &&
          module.typeID === m.typeID &&
          module.charge?.typeID === choice.typeID &&
          module.charge.quantity > 0
        );
      },
      sleep,
      now: env.now ?? Date.now,
    });
    return true;
  };
  const readWeapons = async (shipID: number): Promise<CombatFitModule[]> => {
    if (!env.moduleDocuments) return [];
    const {
      flow: { flying },
      store: { fitting },
    } = session();
    if (!(await boundedDroneRead(() => flying.readFit(), DRONE_NATIVE_IO_TIMEOUT_MS)))
      throw Error("Combat fitting is unavailable.");
    guard();
    const fit = fitting.get();
    if (fit.activeShipID !== shipID || fit.slotsError !== null)
      throw Error("Combat fitting does not match the held ship.");
    fitModules = combatFitModules(
      fit.slots,
      flying.resolveDefenseModuleIDs(),
      flying.resolveRemoteRepModuleIDs(),
      (m) => flying.fittedModuleActivation(m),
    );
    const guns = fitModules.filter((m) => m.kind === "weapon"),
      reloads = env.moduleDocuments.reloads;
    if (reloads)
      for (const module of guns) {
        const charge = fit.slots.find((s) => s.module?.itemID === module.itemID)?.module?.charge,
          chargeFit = fit.chargeFits?.[module.typeID];
        if (
          !charge &&
          chargeFit?.size &&
          chargeFit.groups.length &&
          (await reloadWeapon(module, shipID, chargeFit, reloads))
        ) {
          weaponRevision++;
          return readWeapons(shipID);
        }
      }
    const charges = [
      ...new Set(
        fit.slots.flatMap((slot) =>
          slot.module?.charge && guns.some((m) => m.itemID === slot.module!.itemID)
            ? [slot.module.charge.typeID]
            : [],
        ),
      ),
    ];
    const facts = charges.length
      ? await boundedDroneRead(
          () => flying.attributesOfTypes(charges, [1455, 37, 281]),
          DRONE_NATIVE_IO_TIMEOUT_MS,
        )
      : {};
    guard();
    for (const typeID of charges) assertScopedWeaponCharge(typeID, facts);
    weaponRanges.clear();
    for (const gun of guns) {
      const native = await moduleObservation(gun, shipID);
      guard();
      const charge = fit.slots.find((s) => s.module?.itemID === gun.itemID)?.module?.charge;
      const range = combatWeaponRange(native.attributes, charge ? facts[charge.typeID] : undefined);
      if (!range || !Number.isFinite(range))
        throw Error("Native combat weapon range or loaded charge is unavailable.");
      weaponRanges.set(gun.itemID, range);
    }
    return guns;
  };
  const maintainDefenderAmmo = (shipID: number) => {
    const fit = preparation?.fit,
      reloads = env.moduleDocuments?.reloads;
    if (!fit || !reloads || defenderReloadWork) return;
    const empty = fitModules.flatMap((module) => {
      if (module.kind !== "weapon") return [];
      const charge = fit.slots.find((s) => s.module?.itemID === module.itemID)?.module?.charge,
        chargeFit = fit.chargeFits?.[module.typeID];
      return (charge?.quantity ?? 0) === 0 && chargeFit?.size && chargeFit.groups.length
        ? [{ module, chargeFit }]
        : [];
    });
    if (!empty.length && !defenderReloadPending) return;
    try {
      const observed = observeReloads(reloads, shipID, fit);
      defenderReloadPending = observed.pending.size > 0;
      if (observed.confirmed) weaponRevision++;
      const reloadable = empty.filter((row) => !observed.pending.has(row.module.itemID));
      if (!reloadable.length || Date.now() < defenderReloadRetryAt) return;
      defenderReloadWork = (async () => {
        for (const { module, chargeFit } of reloadable) {
          guard();
          try {
            if (await reloadWeapon(module, shipID, chargeFit, reloads)) preparation?.wakeFit();
          } catch (error) {
            guard();
            diagnostic("weapon-unavailable", { moduleID: module.itemID, reason: String(error) });
          }
        }
      })()
        .catch(() => {
          /* Stop fences the next write. */
        })
        .finally(() => {
          defenderReloadWork = undefined;
          defenderReloadRetryAt = Date.now() + 15000;
        });
    } catch (error) {
      diagnostic("weapon-unavailable", { reason: String(error) });
    }
  };
  const optionalRefusal = (error: unknown) => {
    if (!env.defender || !error || typeof error !== "object") return null;
    const e = error as {
      status?: number;
      code?: string;
      refusal?: { key?: string; values?: { entries?: unknown[] } };
      message?: string;
    };
    if (e.status !== 409 || e.code !== "CALL_REFUSED") return null;
    const key = e.refusal?.key;
    const notify = e.refusal?.values?.entries?.find(
      (row) => Array.isArray(row) && row[0] === "notify",
    );
    const cap =
      Array.isArray(notify) &&
      notify[1] === "You do not have enough capacitor to activate that module.";
    return cap ? String(notify[1]) : (e.message ?? key ?? "Native module activation was refused.");
  };
  const defenseRefused = new Set<number>();
  type LockAttempt = {
    ordinal: number;
    confirmed: boolean;
    retryAt: number;
    requestedAt: number;
    sampledAtMs: number | null;
    seenInStore?: boolean;
    unknown?: boolean;
    retryAllowed?: boolean;
    work?: Promise<void>;
  };
  const defenderLocks = new Map<number, LockAttempt>();
  let lockWork: Promise<void> | undefined, lockConfirmation: Promise<void> | undefined;
  let lockRoster: Set<number> | undefined;
  let prelockPlan:
    | { primary: number; view: Scene; targets: FighterFrame["targets"]; observedAt: number }
    | undefined;
  const definiteRefusal = (error: unknown) => {
    const e = error as { code?: unknown; status?: unknown } | null;
    return e?.code === "CALL_REFUSED" && e.status === 409;
  };
  const surfaceDistance = (
    a: { position: { x: number; y: number; z: number }; radius: number },
    b: typeof a,
  ) =>
    Math.max(
      0,
      Math.hypot(
        a.position.x - b.position.x,
        a.position.y - b.position.y,
        a.position.z - b.position.z,
      ) -
        a.radius -
        b.radius,
    );
  let droneLaunchWarning: string | undefined,
    launchObservation = "",
    refusedLaunchObservation = "",
    defenderDroneRange: number | null = null;
  let launchUnknown = false;
  let pendingLaunch: { ids: readonly number[]; deadline: number } | null = null;
  let defenderEngagement: { ids: readonly number[]; target: number } | undefined;
  let defenderWeaponRevision = 0,
    defenderWeaponsInRange = "",
    defenderTargetRevision = 0;
  let observedFocusAt = 0,
    observedFocus: number | null = null,
    defenderLockRange: number | null = null;
  const retiredWeaponTargets = new Set<number>();
  const defenderSignatures: Record<number, Readonly<Record<number, number>>> = {};
  let newSignatureTypes: number[] = [];
  const timing = env.defender?.timing;
  const checkTarget = (target: number, view: Scene) =>
    absentTargets.has(target)
      ? Promise.reject(
          new SecurityTargetUnobserved("The target is absent from the verified escort grid."),
        )
      : (env.defender?.checkTarget?.(target, view) ?? fenceCombat(target));
  const retiringWeapons = new Set<number>();
  const absentTargets = new Map<number, { retryAt: number; sampledAtMs: number | null }>();
  let defenderFrame: Scene | undefined;
  let defenderFireGrid: { read: Promise<Scene>; observedAt?: number } | undefined;
  const retireAbsentTarget = (target: number, view: Scene) => {
    const destroyed = view.entities.some((row) => row.itemID === target && row.hullRatio === 0);
    absentTargets.set(target, {
      retryAt: destroyed ? Infinity : (env.now ?? Date.now)() + 5000,
      sampledAtMs: view.sampledAtMs,
    });
    const attempt = defenderLocks.get(target);
    if (attempt) {
      attempt.confirmed = false;
      attempt.seenInStore = false;
      attempt.retryAllowed = true;
    }
    if (destroyed || !view.entities.some((row) => row.itemID === target)) {
      lockRoster?.delete(target);
      session().store.apply?.({ type: "targeting/lock-failed", targetID: target });
    }
    if (defenderEngagement?.target === target) defenderEngagement = undefined;
  };
  const weaponTimingFields = (
    targetID: number,
    view: Scene | undefined,
    weaponRangeM: number | null,
  ) => {
    const rat = view?.entities.find((e) => e.itemID === targetID);
    return {
      targetID,
      lockConfirmed: defenderLocks.get(targetID)?.confirmed === true,
      weaponRangeM,
      meters:
        view?.ship?.geometryAvailable && rat?.geometryAvailable
          ? Math.round(surfaceDistance(view.ship, rat))
          : null,
      sceneSampledAtMs: view?.sampledAtMs,
    };
  };
  const reportWeaponPreparation = (
    targetID: number,
    reason: string,
    view: Scene | undefined,
    weaponRangeM: number | null,
    lockRangeM = defenderLockRange,
    droneRangeM = defenderDroneRange,
    lockConfirmed?: boolean,
  ) => {
    if (!timing) return;
    const fields = weaponTimingFields(targetID, view, weaponRangeM);
    lockConfirmed ??= fields.lockConfirmed;
    timing.change(
      "defender-target-preparation",
      `${targetID}:${reason}:${lockConfirmed}`,
      { ...fields, reason, lockConfirmed, lockRangeM, droneRangeM },
      undefined,
      "essential",
    );
  };
  const readDefenderFireGrid = () => {
    if (
      !defenderFireGrid ||
      (defenderFireGrid.observedAt !== undefined &&
        performance.now() - defenderFireGrid.observedAt > 1500)
    ) {
      const frame: { read: Promise<Scene>; observedAt?: number } = {
        read: defenderRead(boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS)).then((observed) => {
          frame.observedAt = performance.now();
          return observed;
        }),
      };
      defenderFireGrid = frame;
    }
    return defenderFireGrid.read;
  };
  const requestOptions = () => ({
    ...session().flow.requestOptions(),
    baseUrl: run.baseUrl,
    fetch: run.fetch,
  });
  let pendingLockRead: ReturnType<typeof getTargets> | undefined;
  const readLocks = async () => {
    const work = (pendingLockRead ??= getTargets(requestOptions()).finally(() => {
      pendingLockRead = undefined;
    }));
    const result = await timed(
      timing,
      "defender-lock-read",
      () => defenderRead(boundedDroneRead(() => work, DRONE_NATIVE_IO_TIMEOUT_MS)),
      undefined,
      15000,
    ).catch((error) => {
      guard();
      if (error instanceof FleetObservationUnavailable) return null;
      throw error;
    });
    guard();
    if (!result) return null;
    const raw = result.targetIDs;
    if (!Array.isArray(raw) || raw.some((id) => !positive(id)))
      throw Error("Native target locks are unreadable.");
    // The normal flow also folds these events into its acquiring-target list.
    // Keep the exact result event for transports/fixtures that return it here.
    for (const value of result.notifications) {
      const n = value as { method?: string; args?: readonly unknown[] } | null;
      if (!n?.method || !Array.isArray(n.args)) continue;
      const id = lostLockTarget(n.method, n.args);
      if (id !== null) {
        session().store.apply?.({ type: "targeting/lock-failed", targetID: id });
        const attempt = defenderLocks.get(id);
        if (attempt) {
          attempt.confirmed = false;
          attempt.retryAt = 0;
          attempt.retryAllowed = true;
          attempt.seenInStore = false;
        }
      }
    }
    return decodeTargetIDs(raw);
  };
  const confirmLock = (target: number, attempt: LockAttempt, source: string) => {
    if (defenderLocks.get(target) !== attempt || absentTargets.has(target)) return;
    if (!attempt.confirmed) {
      timing?.note(
        "defender-lock-confirmed",
        {
          targetID: target,
          source,
          lockAttempt: attempt.ordinal,
          sinceRequestMs: (env.now ?? Date.now)() - attempt.requestedAt,
        },
        "essential",
      );
      defenderWeaponRevision++;
    }
    attempt.confirmed = true;
  };
  const observeLockedRoster = (ids: readonly number[], source: string) => {
    lockRoster = new Set(ids);
    for (const id of ids) {
      const attempt = defenderLocks.get(id);
      if (attempt) confirmLock(id, attempt, source);
    }
  };
  const observePendingLocks = () => {
    if (lockConfirmation) return;
    lockConfirmation = readLocks()
      .then((locks) => {
        if (!locks) return;
        observeLockedRoster(locks, "targets-read");
        const now = (env.now ?? Date.now)(),
          acquiring = session().store.targeting?.get().acquiringTargetIDs;
        for (const [id, attempt] of defenderLocks)
          if (
            !attempt.work &&
            !attempt.confirmed &&
            !attempt.unknown &&
            now >= attempt.retryAt &&
            acquiring?.includes(id) === false
          )
            attempt.retryAllowed = true;
      })
      .catch((error) => diagnostic("weapon-unavailable", { reason: String(error) }))
      .finally(() => {
        lockConfirmation = undefined;
      });
  };
  const occupiedLocks = (view: Scene) => {
    const native = session().store.targeting?.get();
    const ids = new Set([
      ...(native?.lockedTargetIDs ?? []),
      ...(native?.acquiringTargetIDs ?? []),
    ]);
    if (!native?.loaded) for (const id of lockRoster ?? []) ids.add(id);
    for (const [id, attempt] of defenderLocks)
      if (attempt.work || attempt.confirmed || attempt.unknown || !attempt.retryAllowed)
        ids.add(id);
    for (const id of ids)
      if (
        absentTargets.has(id) &&
        !view.entities.some((row) => row.itemID === id && row.hullRatio !== 0)
      )
        ids.delete(id);
    return ids;
  };
  const defenderLock = (view: Scene, target: number, range: number, prelock = false) => {
    const now = env.now ?? Date.now,
      existing = defenderLocks.get(target);
    if (absentTargets.has(target)) return;
    const native = session().store.targeting?.get();
    if (native?.lockedTargetIDs?.includes(target)) {
      const attempt = existing ?? {
        ordinal: 0,
        requestedAt: now(),
        confirmed: false,
        retryAt: now() + 1500,
        sampledAtMs: view.sampledAtMs,
      };
      defenderLocks.set(target, attempt);
      attempt.seenInStore = true;
      confirmLock(target, attempt, "held-targeting");
      return attempt;
    }
    if (existing?.seenInStore) {
      // A pushed loss retires the old confirmation. Only reacquire on a newer grid.
      existing.seenInStore = false;
      existing.confirmed = false;
      existing.retryAllowed = true;
      lockRoster?.delete(target);
    }
    if (!native?.loaded && lockRoster?.has(target)) {
      const attempt = existing ?? {
        ordinal: 0,
        requestedAt: now(),
        confirmed: false,
        retryAt: now() + 1500,
        sampledAtMs: view.sampledAtMs,
      };
      defenderLocks.set(target, attempt);
      confirmLock(target, attempt, "native-roster");
      return attempt;
    }
    if (existing?.confirmed || lockWork) return existing;
    if (existing) {
      if (!existing.retryAllowed || existing.unknown) {
        observePendingLocks();
        return existing;
      }
      if (now() < existing.retryAt || view.sampledAtMs === existing.sampledAtMs) return existing;
    } else {
      if (native?.acquiringTargetIDs.includes(target)) {
        defenderLocks.set(target, {
          ordinal: 0,
          requestedAt: now(),
          confirmed: false,
          retryAt: now() + 1500,
          sampledAtMs: view.sampledAtMs,
        });
        return;
      }
    }
    const limit = preparation?.lockLimit;
    if (limit != null && occupiedLocks(view).size >= limit) return existing;
    // The first request needs the current grid and sensor range. Read the native
    // lock roster only to confirm or reconcile a request already in progress.
    const next: LockAttempt = {
      ordinal: (existing?.ordinal ?? 0) + 1,
      requestedAt: now(),
      confirmed: false,
      retryAt: now() + 1500,
      sampledAtMs: view.sampledAtMs,
    };
    defenderLocks.set(target, next);
    const shipID = view.shipID!,
      scope = JSON.stringify([run.botID, run.characterID, shipID, state.currentIdentity, target]);
    let targetGone = false;
    lockWork = executeCombatTargetLock(
      {
        key: JSON.stringify([scope, next.ordinal]),
        characterID: run.characterID,
        shipID,
        targetID: target,
      },
      {
        document: env.moduleDocuments!.locks,
        current: guard,
        receiptCurrent: current,
        now,
        fence: async () => {
          await checkTarget(target, view);
          const rat = view.entities.find((e) => e.itemID === target);
          if (!view.ship || !rat || surfaceDistance(view.ship, rat) > range)
            throw new SecurityTargetUnobserved("The target moved out of native lock range.");
        },
        definiteRefusal(error) {
          if (bridgeCallQueueTimeout(error)) return true;
          if (!definiteRefusal(error)) return false;
          targetGone =
            (error as { refusal?: { key?: string } }).refusal?.key === "TargetingAttemptCancelled";
          return true;
        },
        lock: async () => {
          session().store.apply?.({ type: "targeting/acquiring", targetID: target });
          const evidence = {
            targetID: target,
            lockAttempt: next.ordinal,
            sceneSampledAtMs: view.sampledAtMs,
            selectedAtMs: next.requestedAt,
            timeDilation: view.timeDilation,
            prelock,
            nativeLockPending: undefined as boolean | undefined,
            nativeLockConfirmed: undefined as boolean | undefined,
          };
          const send = async () => {
            timing?.note("defender-lock-call", evidence, "essential");
            const reply = await session().flow.flying.bridgeDo("dogmaIM", "AddTarget", [target]);
            current();
            const tuple = reply as { type?: unknown; items?: JsonValue[] } | null;
            const pair: readonly JsonValue[] = Array.isArray(reply)
              ? reply
              : tuple?.type === "tuple" && Array.isArray(tuple.items)
                ? tuple.items
                : [];
            const flag = typeof pair[0] === "boolean" ? (pair[0] ? 1n : 0n) : unwrapLong(pair[0]);
            const roster = Array.isArray(pair[1])
              ? pair[1]
              : isListValue(pair[1])
                ? pair[1].items
                : undefined;
            if (roster && (flag === 0n || flag === 1n)) {
              const ids = decodeTargetIDs(roster);
              if (ids.length === roster.length) {
                evidence.nativeLockPending = flag === 1n;
                evidence.nativeLockConfirmed = flag === 0n && ids.includes(target);
                observeLockedRoster(ids, "add-target-reply");
              }
            }
            return reply;
          };
          const reply = await boundedDroneWrite(
            () => timing?.command("AddTarget", evidence, send) ?? send(),
            DRONE_NATIVE_IO_TIMEOUT_MS,
            () => {},
          );
          timing?.note("defender-lock-native-reply", {
            targetID: target,
            pending: evidence.nativeLockPending,
            locked: evidence.nativeLockConfirmed,
          });
          if (evidence.nativeLockConfirmed) confirmLock(target, next, "add-target-reply");
          return reply;
        },
      },
    )
      .then((result) => {
        next.retryAt = now() + 1500;
        if (result !== "refused") return;
        session().store.apply?.({ type: "targeting/lock-failed", targetID: target });
        next.retryAllowed = true;
        if (targetGone) retireAbsentTarget(target, view);
        diagnostic("defender-lock-refused", {
          target,
          reason: "Native target lock was refused; checking again from the current grid.",
        });
      })
      .catch((error) => {
        if (error instanceof SecurityTargetUnobserved) {
          retireAbsentTarget(target, view);
          return;
        }
        next.unknown = true;
        diagnostic("weapon-unavailable", { target, reason: String(error) });
      })
      .finally(() => {
        lockWork = undefined;
        next.work = undefined;
      });
    next.work = lockWork;
    return next;
  };
  const prepareNextLock = () => {
    const { lockLimit: limit, sensorRange: range } = preparation!;
    const plan = prelockPlan;
    if (
      !plan ||
      lockWork ||
      limit == null ||
      limit < 2 ||
      range === null ||
      performance.now() - plan.observedAt > 1500
    )
      return;
    const { view, primary, targets } = plan;
    if (!view.ship || targets.length < 2 || absentTargets.has(primary)) return;
    if (!lockRoster && !session().store.targeting?.get().loaded) {
      observePendingLocks();
      return;
    }
    const taken = occupiedLocks(view);
    if (!taken.has(primary) || taken.size >= limit) return;
    const liveNpcIDs = new Set(
      view.entities
        .filter((e) => qualified(state.currentIdentity, e) && e.hullRatio !== 0)
        .map((e) => e.itemID),
    );
    if ([...taken].filter((id) => liveNpcIDs.has(id)).length >= 3) return;
    const next = targets.find(
      (row) =>
        row.itemID !== primary &&
        !taken.has(row.itemID) &&
        !absentTargets.has(row.itemID) &&
        view.entities.some(
          (entity) =>
            entity.itemID === row.itemID &&
            liveNpcIDs.has(entity.itemID) &&
            surfaceDistance(view.ship!, entity) < range,
        ),
    );
    // Only one native AddTarget write may await a reply in the existing lock
    // journal. Acknowledged pending locks can then coexist in EveJS.
    if (next) defenderLock(view, next.itemID, range, true);
  };
  const prepareDefenderTarget = async (target: number, frame: FighterFrame) => {
    const view = await readDefenderFireGrid();
    guard();
    if (absentTargets.has(target)) return "target-absent" as const;
    try {
      await checkTarget(target, view);
    } catch (error) {
      if (error instanceof SecurityTargetUnobserved) {
        reportWeaponPreparation(target, "target-or-escort-scope-changed", view, null);
        return "target-absent" as const;
      }
      throw error;
    }
    const rat = view.entities.find((e) => e.itemID === target),
      ship = view.ship;
    if (!ship || !positive(view.shipID) || !rat || !qualified(state.currentIdentity, rat)) {
      reportWeaponPreparation(target, "target-unavailable", view, null);
      return "target-absent" as const;
    }
    const meters = surfaceDistance(ship, rat),
      lockRange = defenderLockRange;
    const droneRange =
      frame.combatOut.length || frame.droneLaunch?.length ? defenderDroneRange : null;
    const weaponReach = Math.max(
      0,
      ...(frame.weaponIDs ?? []).map((id) => weaponRanges.get(id) ?? 0),
    );
    const lockable = lockRange !== null && meters <= lockRange;
    const lock = lockable ? defenderLock(view, target, lockRange) : undefined;
    prelockPlan = lockable
      ? {
          primary: target,
          view,
          targets: frame.targets,
          observedAt: defenderFireGrid?.observedAt ?? performance.now(),
        }
      : undefined;
    const gunReach = Math.min(lockRange ?? 0, weaponReach),
      reach = Math.max(gunReach, droneRange ?? 0);
    // A prepared gun can use the reply to its own write. Drone dispatch runs in
    // parallel with this branch and confirmation reads never hold this pass.
    if (gunReach > 0 && meters <= gunReach && lock?.work && !lock.confirmed) {
      await lock.work;
      guard();
      if (absentTargets.has(target)) {
        defenderFireGrid = undefined;
        return "target-absent" as const;
      }
    }
    const locked = lock?.confirmed === true;
    const reason = !weaponReach
      ? preparation?.pending
        ? "fit-pending"
        : "no-verified-weapons"
      : lockRange === null
        ? "lock-range-unavailable"
        : !lockable
          ? "outside-lock-range"
          : meters > weaponReach
            ? "outside-weapon-range"
            : locked
              ? "lock-and-range-ready"
              : "lock-not-confirmed";
    reportWeaponPreparation(
      target,
      reason,
      view,
      weaponReach || null,
      lockRange,
      droneRange,
      locked,
    );
    if (reach > 0 && (meters > reach || (gunReach > 0 && meters > gunReach))) {
      const moving = await env.defender!.approach(
        target,
        Math.floor((gunReach || reach) * 0.8),
        view,
      );
      guard();
      return moving === false && meters > reach
        ? ("not-dispatched" as const)
        : ("approaching" as const);
    }
    const inRange = (frame.weaponIDs ?? [])
      .filter((id) => lockable && meters <= (weaponRanges.get(id) ?? 0))
      .join(",");
    if (inRange !== defenderWeaponsInRange) {
      defenderWeaponsInRange = inRange;
      defenderWeaponRevision++;
    }
    frame.weaponRevision = weaponRevision + defenderWeaponRevision;
    return lockable && !locked ? ("waiting-lock" as const) : ("ready" as const);
  };
  const moduleObservation = async (module: CombatFitModule, shipID: number) =>
    decodeModuleObservation(
      await defenderRead(
        boundedDroneRead(
          () => ask("dogmaIM", "ItemGetInfo", [module.itemID]),
          DRONE_NATIVE_IO_TIMEOUT_MS,
        ),
      ),
      {
        moduleID: module.itemID,
        typeID: module.typeID,
        ownerID: run.characterID,
        shipID,
        flagID: module.flagID,
      },
    );
  const weaponActivity = async (ids: readonly number[], target: number) => {
    if (env.defender) {
      if (ids.some((id) => defenderWeaponStates.get(id)?.targets.includes(target))) return true;
      // The end-of-pass status only needs effects already observed on this pass.
      return (
        defenderFrame?.ship?.activeModuleTargets?.some(
          (effect) => ids.includes(effect.moduleID) && effect.targetID === target,
        ) ?? false
      );
    }
    const f = await boundedDroneRead(flight, DRONE_NATIVE_IO_TIMEOUT_MS);
    guard();
    if (!positive(f.shipID)) throw Error("Combat weapon ship is unavailable.");
    const selected = weapons.filter((m) => ids.includes(m.itemID));
    if (selected.length !== ids.length) throw Error("Combat weapons changed during engagement.");
    for (const m of selected) {
      const observed = await moduleObservation(m, f.shipID);
      guard();
      if (observed.online && observed.activeTargets.some((e) => e.targetID === target)) return true;
    }
    return false;
  };
  const maintainDefense = async (
    shipID: number,
    ship: NonNullable<Scene["ship"]>,
    modules = fitModules,
    identity = state.currentIdentity,
    fighting = true,
  ) => {
    if (!env.moduleDocuments || !identity) return;
    const capLow =
      !!env.defender && ship.capacitorRatio !== null && ship.capacitorRatio < REPAIR_CAP_FLOOR;
    for (const m of modules) {
      const active = ship.activeModuleIDs?.includes(m.itemID);
      if (env.defender && active === false) moduleStops.delete(m.itemID);
      const repair = m.kind === "shield" || m.kind === "armor" || m.kind === "hull";
      const ratio =
        m.kind === "shield"
          ? ship.shieldRatio
          : m.kind === "armor"
            ? ship.armorRatio
            : ship.hullRatio;
      const threshold = m.kind === "hull" ? 0.99 : 0.9;
      const recovered = ratio !== null && ratio >= threshold;
      const turnOff = !!env.defender && repair && (recovered || capLow);
      if (turnOff) {
        if (active === false || moduleStops.has(m.itemID)) continue;
      } else if (
        !fighting ||
        !(m.kind === "hardener" || (repair && ratio !== null && !recovered)) ||
        defenseRefused.has(m.itemID) ||
        (env.defender && active)
      )
        continue;
      await fenceCombat(null);
      guard();
      const before = await moduleObservation(m, shipID);
      guard();
      const cycling = before.effects.some((e) => e.effectID !== 16);
      if (turnOff) {
        if (!cycling) continue;
        moduleStops.add(m.itemID);
        try {
          await boundedDroneWrite(
            () => ask("dogmaIM", "Deactivate", [m.itemID, null]),
            DRONE_NATIVE_IO_TIMEOUT_MS,
            () => {},
          );
        } catch (error) {
          if (definiteRefusal(error) || bridgeCallQueueTimeout(error)) moduleStops.delete(m.itemID);
          diagnostic("defense-unavailable", { moduleID: m.itemID, reason: String(error) });
        }
        continue;
      }
      if (!before.online) {
        if (!env.defender) throw Error("Combat defense module is offline.");
        defenseRefused.add(m.itemID);
        diagnostic("defense-unavailable", {
          moduleID: m.itemID,
          reason: "Combat defense module is offline.",
        });
        continue;
      }
      // A pre-existing non-online effect could already be running; do not issue a
      // second activation on an effect whose exact state is not distinguishable.
      if (cycling) continue;
      if (env.defender) moduleStops.delete(m.itemID);
      const ordinal = (defenseOrdinals.get(m.itemID) ?? 0) + 1;
      defenseOrdinals.set(m.itemID, ordinal);
      const key = JSON.stringify([
        run.botID,
        run.characterID,
        shipID,
        identity,
        "defense",
        m.itemID,
        ordinal,
      ]);
      const result = await executeCombatModuleAction(
        {
          key,
          characterID: run.characterID,
          shipID,
          moduleID: m.itemID,
          typeID: m.typeID,
          targetID: null,
          kind: "local-defense",
        },
        {
          document: env.moduleDocuments.actions,
          current: guard,
          fence: () => fenceCombat(null),
          observed: async () => {
            const after = await moduleObservation(m, shipID);
            if (!after.online) throw Error("Combat defense module went offline.");
            return after.effects.some((e) => e.effectID !== 16);
          },
          activate: async () => {
            try {
              return await boundedDroneWrite(
                () =>
                  session().flow.flying.bridgeDo("dogmaIM", "Activate", [m.itemID, "", null, -1]),
                DRONE_NATIVE_IO_TIMEOUT_MS,
                () => {},
              );
            } catch (error) {
              if (!alreadyActiveRefusal(error) && !optionalRefusal(error))
                state.droneUnresolved = true;
              throw error;
            }
          },
          optionalRefusal: (error) => {
            const reason = optionalRefusal(error);
            if (reason) diagnostic("defense-unavailable", { moduleID: m.itemID, reason });
            return reason;
          },
          receiptCurrent: env.defender ? current : undefined,
          reacquireLock: !!env.defender,
          sleep,
          now: env.now ?? Date.now,
        },
      );
      if (result === "unavailable" || result === "already-active") defenseRefused.add(m.itemID);
    }
  };
  const maintainSupport = async (view: Scene) => {
    if (
      !env.moduleDocuments ||
      !env.fenceFriendly ||
      !env.friendlyMembers ||
      !state.currentIdentity ||
      !view.ship ||
      !positive(view.shipID)
    )
      return false;
    const support = fitModules.filter((m) => isRemoteRepair(m) || m.kind === "remote-cap");
    for (const m of support) {
      const field =
          m.kind === "remote-shield"
            ? "shieldRatio"
            : m.kind === "remote-armor"
              ? "armorRatio"
              : m.kind === "remote-hull"
                ? "hullRatio"
                : "capacitorRatio",
        threshold = m.kind === "remote-cap" ? 0.5 : 0.9;
      const candidates = env.friendlyMembers
        .filter((member) => member.characterID !== run.characterID)
        .flatMap((member) => {
          const entity = view.entities.find(
            (e) =>
              e.itemID === member.shipID && e.kind === "ship" && e.ownerID === member.characterID,
          );
          const ratio = entity?.[field];
          return entity &&
            entity.geometryAvailable &&
            typeof ratio === "number" &&
            Number.isFinite(ratio) &&
            ratio >= 0 &&
            ratio < threshold
            ? [{ member, entity, ratio }]
            : [];
        })
        .sort((a, b) => a.ratio - b.ratio || a.member.characterID - b.member.characterID);
      const choice = candidates[0];
      if (!choice) continue;
      const info = await moduleObservation(m, view.shipID);
      guard();
      if (!info.online) throw Error("Fleet repair module is offline.");
      if (info.activeTargets.some((e) => e.targetID === choice.member.shipID)) continue;
      if (info.effects.some((e) => e.effectID !== 16)) continue;
      const range = info.attributes?.[54];
      if (typeof range !== "number" || !Number.isFinite(range) || range <= 0) continue;
      const fence = () => env.fenceFriendly!(choice.member.characterID, choice.member.shipID);
      let spatial = view,
        approached = false;
      const deadline = Date.now() + 120000;
      for (;;) {
        await fence();
        guard();
        const peer = spatial.entities.find(
          (e) =>
            e.itemID === choice.member.shipID &&
            e.kind === "ship" &&
            e.ownerID === choice.member.characterID,
        );
        if (!spatial.ship?.geometryAvailable || !peer?.geometryAvailable)
          throw Error("Fleet repair recipient geometry is unavailable.");
        const distance = Math.max(
          0,
          Math.hypot(
            peer.position.x - spatial.ship.position.x,
            peer.position.y - spatial.ship.position.y,
            peer.position.z - spatial.ship.position.z,
          ) -
            peer.radius -
            spatial.ship.radius,
        );
        if (!Number.isFinite(distance)) throw Error("Fleet repair recipient range is unavailable.");
        if (distance <= range) break;
        if (!approached) {
          approached = true;
          await boundedDroneWrite(
            () =>
              session().flow.approach(
                choice.member.shipID,
                Math.max(1000, Math.floor(range * 0.8)),
              ),
            DRONE_NATIVE_IO_TIMEOUT_MS,
            () => {
              state.droneUnresolved = true;
            },
          );
        }
        if (Date.now() >= deadline)
          throw Error("Fleet repair recipient did not enter native module range.");
        await sleep(1000);
        spatial = await boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS);
        guard();
      }
      const lockKey = JSON.stringify([
        run.botID,
        run.characterID,
        view.shipID,
        state.currentIdentity,
        "friendly",
        choice.member.characterID,
        choice.member.shipID,
      ]);
      await executeCombatTargetLock(
        {
          key: lockKey,
          characterID: run.characterID,
          shipID: view.shipID,
          targetID: choice.member.shipID,
        },
        {
          document: env.moduleDocuments.locks,
          current: guard,
          fence,
          lock: () =>
            boundedDroneWrite(
              () => session().flow.flying.bridgeDo("dogmaIM", "AddTarget", [choice.member.shipID]),
              DRONE_NATIVE_IO_TIMEOUT_MS,
              () => {
                state.droneUnresolved = true;
              },
            ),
          now: env.now ?? Date.now,
        },
      );
      const ordinal = (supportOrdinals.get(m.itemID) ?? 0) + 1;
      supportOrdinals.set(m.itemID, ordinal);
      const key = JSON.stringify([lockKey, m.itemID, ordinal]);
      await executeCombatModuleAction(
        {
          key,
          characterID: run.characterID,
          shipID: view.shipID,
          moduleID: m.itemID,
          typeID: m.typeID,
          targetID: choice.member.shipID,
          kind: "remote-repair",
        },
        {
          document: env.moduleDocuments.actions,
          current: guard,
          fence,
          observed: async () => {
            const current = await moduleObservation(m, view.shipID!);
            if (!current.online) throw Error("Fleet repair module went offline.");
            if (current.activeTargets.some((e) => e.targetID !== choice.member.shipID))
              throw Error("Fleet repair module has a different recipient.");
            return current.activeTargets.some((e) => e.targetID === choice.member.shipID);
          },
          activate: async () => {
            try {
              return await boundedDroneWrite(
                () =>
                  session().flow.flying.bridgeDo("dogmaIM", "Activate", [
                    m.itemID,
                    "",
                    choice.member.shipID,
                    -1,
                  ]),
                DRONE_NATIVE_IO_TIMEOUT_MS,
                () => {},
              );
            } catch (error) {
              if (!targetNotLockedRefusal(error)) state.droneUnresolved = true;
              throw error;
            }
          },
          sleep,
          now: env.now ?? Date.now,
        },
      );
    }
    return support.length > 0;
  };
  const combatDrones = async (s: Scene) => {
    await boundedDroneRead(
      () => ask("invCache", "InvalidateLocationCache", [s.shipID]),
      DRONE_NATIVE_IO_TIMEOUT_MS,
    );
    const rows = checkedInventory(
      await boundedDroneRead(
        () => ask("invbroker", "List", [87], s.shipID!),
        DRONE_NATIVE_IO_TIMEOUT_MS,
      ),
    );
    if (
      rows.some(
        (r) => r.ownerID !== run.characterID || r.locationID !== s.shipID || r.flagID !== 87,
      )
    )
      throw Error("Security drone bay identity is unreadable.");
    const bay = decodeDroneBay(
      rows.map((r) => ({ itemID: r.itemID, typeID: r.typeID, quantity: r.quantity })),
    );
    if (!bay) throw Error("Security drone bay is unreadable.");
    const roles = await session().flow.flying.classifyDroneRoles(bay, s, s.shipID);
    if (!roles.bay || !roles.out) throw Error("Security drone roles are unreadable.");
    return { bay, roles: { bay: roles.bay, out: roles.out } };
  };
  async function readyToEscort() {
    guard();
    const view = await defenderRead(boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS));
    guard();
    if (!preparation || !positive(view.shipID)) return false;
    await preparation.ready(view);
    guard();
    const owned = view.entities.filter(
      (e) => e.kind === "drone" && e.ownerID === run.characterID && e.controllerID === view.shipID,
    );
    return (
      preparation.weapons.length > 0 ||
      owned.some(preparation.combatDrone) ||
      preparation.plan(owned).length > 0
    );
  }
  let defenseWork: Promise<void> | undefined;
  const serviceDefense = (id: I, view: Scene, fighting: boolean) => {
    if (!preparation || defenseWork || !view.ship || !positive(view.shipID)) return;
    const modules = preparation.modules;
    if (
      modules.some(
        (m) =>
          m.kind === "shield" || m.kind === "armor" || m.kind === "hull" || m.kind === "hardener",
      )
    )
      defenseWork = maintainDefense(view.shipID, view.ship, modules, id, fighting)
        .catch((error) => {
          diagnostic("defense-unavailable", { reason: String(error) });
        })
        .finally(() => {
          defenseWork = undefined;
        });
  };
  const fighterDrone = (row: Scene["entities"][number], shipID: number | null) => ({
    itemID: row.itemID,
    controlled: row.ownerID === run.characterID && row.controllerID === shipID,
    targetID: row.targetEntityID,
    shieldRatio: row.shieldRatio,
    armorRatio: row.armorRatio,
    hullRatio: row.hullRatio,
  });
  const readLaunchedDrones = async () => {
    const launch = pendingLaunch;
    defenderDroneRange = preparation?.droneRange ?? null;
    if (!launch || defenderDroneRange === null) return [];
    // A launch response can precede the scene update. The next ordinary grid
    // confirms the flight if it is still missing from this observation.
    defenderFireGrid = undefined;
    try {
      const view = await readDefenderFireGrid();
      guard();
      const drones = view.entities
        .filter((row) => row.kind === "drone" && launch.ids.includes(row.itemID))
        .map((row) => fighterDrone(row, view.shipID));
      return launch.ids.every((id) =>
        drones.some((drone) => drone.itemID === id && drone.controlled),
      )
        ? drones
        : [];
    } catch (error) {
      guard();
      if (error instanceof FleetObservationUnavailable) return [];
      throw error;
    }
  };
  async function readFrame(id: I, lostTarget?: number): Promise<FighterFrame> {
    state.currentIdentity = id;
    await boundedDroneRead(() => fenceCombat(null), DRONE_NATIVE_IO_TIMEOUT_MS);
    const refreshing = lostTarget !== undefined;
    const s = refreshing
      ? await readDefenderFireGrid()
      : (defenderFrame ?? (await boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS)));
    guard();
    if (!positive(s.shipID) || !s.ship || (env.defender && !s.ship.geometryAvailable))
      throw new FleetObservationUnavailable("Combat ship identity is unreadable.");
    const shipID = s.shipID;
    const deployed = s.entities.filter(
      (e) => e.kind === "drone" && (e.ownerID === run.characterID || e.controllerID === shipID),
    );
    const drones = deployed.map((e) => fighterDrone(e, shipID));
    for (const drone of drones) droneCustody.add(drone.itemID);
    if (!preparation || !env.defender) {
      const { bay, roles } = await combatDrones(s);
      let fitAvailable = false;
      try {
        weapons = await readWeapons(shipID);
        fitAvailable = true;
      } catch (error) {
        guard();
        const docs = env.moduleDocuments,
          untouched =
            !!docs &&
            [docs.locks, docs.actions, ...(docs.reloads ? [docs.reloads] : [])].every(
              (d) => d.read() === null,
            );
        if (
          !untouched ||
          state.droneUnresolved ||
          (!roles.bay.combat.length && !roles.out.combat.length)
        )
          throw error;
        fitModules = [];
        weapons = [];
        diagnostic("combat-fit-unavailable", {
          reason: error instanceof Error ? error.message : String(error),
          fallback: "classified-drones-only",
        });
      }
      if (fitAvailable) await maintainDefense(shipID, s.ship);
      const supportCapable = fitAvailable && (await maintainSupport(s));
      if (s.ship.hullRatio !== null && s.ship.hullRatio < 0.99)
        throw Error("Security ship hull is damaged; recalling before parking.");
      const targets = s.entities
        .filter(
          (e) =>
            qualified(id, e) &&
            state.entryAnchor &&
            Math.hypot(
              e.position.x - state.entryAnchor.x,
              e.position.y - state.entryAnchor.y,
              e.position.z - state.entryAnchor.z,
            ) <= 500000,
        )
        .sort(
          (a, b) =>
            surfaceDistance(s.ship!, a) - surfaceDistance(s.ship!, b) || a.itemID - b.itemID,
        )
        .map((e) => ({
          itemID: e.itemID,
          shieldRatio: e.shieldRatio,
          armorRatio: e.armorRatio,
          hullRatio: e.hullRatio,
        }));
      return {
        bay,
        combatBay: roles.bay.combat,
        drones,
        combatOut: roles.out.combat.filter((id) =>
          drones.some((d) => d.itemID === id && d.controlled),
        ),
        targets: env.selectTargets ? env.selectTargets(targets) : targets,
        weaponIDs: weapons.map((m) => m.itemID),
        weaponRevision,
        supportCapable,
      };
    }
    if (refreshing) {
      defenderFrame = s;
      preparation.refresh(s);
    }
    if (pendingLaunch) {
      const { ids, deadline } = pendingLaunch;
      if (ids.every((id) => drones.some((d) => d.itemID === id && d.controlled))) {
        diagnostic("launch-confirmed", droneSample(s, ids, null));
        pendingLaunch = null;
      } else if (Date.now() >= deadline) {
        launchUnknown = true;
        throw Error("Launched drones lack observed owner and controller; no launch replay.");
      }
    }
    const order = defenderEngagement;
    if (
      order &&
      order.ids.every((id) =>
        drones.some((d) => d.itemID === id && d.controlled && d.targetID === order.target),
      )
    ) {
      diagnostic("engage-confirmed", droneSample(s, order.ids, order.target));
      defenderEngagement = undefined;
    }
    const owned = deployed.filter(
      (e) => e.ownerID === run.characterID && e.controllerID === shipID,
    );
    const combatOut = pendingLaunch
      ? []
      : owned.filter(preparation.combatDrone).map((e) => e.itemID);
    const planned = !pendingLaunch && !combatOut.length ? preparation.plan(owned) : [];
    if (planned.length)
      launchObservation = JSON.stringify([
        planned,
        owned.map((e) => e.itemID).sort((a, b) => a - b),
      ]);
    const droneLaunch = launchObservation !== refusedLaunchObservation ? planned : [];
    defenderLockRange = preparation.sensorRange;
    defenderDroneRange = preparation.droneRange;
    const guns = preparation.weapons,
      ship = s.ship;
    weapons = guns;
    fitModules = preparation.modules;
    weaponRanges.clear();
    for (const gun of guns) weaponRanges.set(gun.itemID, gun.range);
    if (!refreshing) maintainDefenderAmmo(shipID);
    const now = (env.now ?? Date.now)();
    for (const [id, attempt] of defenderLocks) {
      if (absentTargets.has(id)) continue;
      const row = s.entities.find((row) => row.itemID === id);
      if (
        row?.hullRatio === 0 ||
        (!row &&
          s.sampledAtMs !== null &&
          (attempt.sampledAtMs === null || s.sampledAtMs > attempt.sampledAtMs))
      )
        retireAbsentTarget(id, s);
    }
    for (const [id, absent] of absentTargets)
      if (
        absent.retryAt <= now &&
        s.sampledAtMs !== null &&
        (absent.sampledAtMs === null || s.sampledAtMs > absent.sampledAtMs) &&
        s.entities.some((row) => row.itemID === id && row.hullRatio !== 0)
      )
        absentTargets.delete(id);
    const candidates = s.entities.filter(
      (e) =>
        e.itemID !== lostTarget &&
        qualified(id, e) &&
        e.hullRatio !== 0 &&
        !absentTargets.has(e.itemID),
    );
    const eligible = env.defender.filterTargets?.(s, candidates) ?? candidates;
    const ranked = env.defender.rankTargets({
      ship,
      targets: eligible,
      weapons: guns,
      signatureByType: defenderSignatures,
      lockRange: defenderLockRange,
      droneRange: combatOut.length || droneLaunch.length ? defenderDroneRange : null,
    });
    const sensorRange = defenderLockRange;
    const lockable =
      sensorRange === null
        ? []
        : eligible.filter((row) => surfaceDistance(ship, row) <= sensorRange);
    const preferred = ranked[0];
    const earlyTarget = preferred?.engageable
      ? undefined
      : ranked.find((row) => lockable.some((e) => e.itemID === row.itemID));
    const targets = earlyTarget
      ? [earlyTarget, ...ranked.filter((row) => row !== earlyTarget)]
      : ranked;
    const confirmed = [
      ...(ship.activeModuleTargets ?? [])
        .filter((m) => guns.some((g) => g.itemID === m.moduleID))
        .map((m) => m.targetID),
      ...drones.filter((d) => d.controlled && combatOut.includes(d.itemID)).map((d) => d.targetID),
    ];
    observedFocus =
      targets.find((t) => t.engageable !== false && confirmed.includes(t.itemID))?.itemID ?? null;
    observedFocusAt = Date.now();
    newSignatureTypes =
      guns.length && eligible.length > 1
        ? [...new Set(eligible.map((e) => e.typeID).filter(positive))].filter(
            (typeID) => !Object.hasOwn(defenderSignatures, typeID),
          )
        : [];
    return {
      bay: [],
      combatBay: [],
      drones: drones.filter((d) => d.controlled),
      combatOut,
      targets,
      weaponIDs: guns.map((m) => m.itemID),
      canPrepareLock: lockable.length > 0,
      weaponRevision,
      supportCapable: env.defender.supportCapable?.(),
      droneLaunch,
      dronesDeploying: !!pendingLaunch,
      droneWarning: droneLaunchWarning,
      capabilitiesPending: preparation.pending || !!defenderReloadWork || defenderReloadPending,
    };
  }
  const fighter = createSecurityFighter<I>({
    now: env.defender ? (env.now ?? Date.now) : Date.now,
    read: readFrame,
    readLaunchedDrones: env.defender ? readLaunchedDrones : undefined,
    refreshTargets: env.defender?.rankTargets
      ? async (id, lostTarget) => {
          try {
            const frame = await readFrame(id, lostTarget);
            timing?.change("defender-target-refresh", lostTarget + ":" + frame.targets[0]?.itemID, {
              lostTargetID: lostTarget,
              targetID: frame.targets[0]?.itemID,
              sceneSampledAtMs: defenderFrame?.sampledAtMs,
            });
            return frame;
          } catch (error) {
            guard();
            if (error instanceof FleetObservationUnavailable) return null;
            throw error;
          }
        }
      : undefined,
    prepareTarget: env.defender ? prepareDefenderTarget : undefined,
    targetSelected: timing
      ? (targetID) =>
          timing.change(
            "defender-target-selected",
            `${defenderTargetRevision}:${targetID}`,
            { targetID, sceneSampledAtMs: defenderFrame?.sampledAtMs },
            undefined,
            "essential",
          )
      : undefined,
    weaponFitPending: timing
      ? (targetID) => reportWeaponPreparation(targetID, "fit-pending", defenderFrame, null)
      : undefined,
    targetChanged: env.defender?.rankTargets
      ? (prior, next) => {
          retiredWeaponTargets.add(prior);
          if (
            defenderFrame &&
            !defenderFrame.entities.some((row) => row.itemID === prior && row.hullRatio !== 0)
          )
            retireAbsentTarget(prior, defenderFrame);
          if (next !== null) retiredWeaponTargets.delete(next);
          if (defenderEngagement?.target === prior) defenderEngagement = undefined;
          defenderTargetRevision++;
          observedFocus = null;
        }
      : undefined,
    engageWeapons: async (ids, target) => {
      const documents = env.moduleDocuments;
      if (!documents) throw Error("Combat module custody is unavailable.");
      const identity = state.currentIdentity;
      if (!identity) throw Error("Combat room authority is unavailable.");
      const f = defenderFrame ?? (await boundedDroneRead(flight, DRONE_NATIVE_IO_TIMEOUT_MS));
      guard();
      if (!positive(f.shipID)) throw Error("Combat weapon ship is unavailable.");
      const reaches = ids.map((id) => weaponRanges.get(id));
      if (reaches.some((v) => typeof v !== "number" || !Number.isFinite(v) || v <= 0))
        throw Error("Combat weapon range is unavailable.");
      const reach = Math.min(...(reaches as number[])),
        deadline = Date.now() + 120000;
      let approached = false,
        preSample: number | null = null;
      let defenderDistance = 0,
        fireView: Scene | undefined;
      const fireFence = async () =>
        env.defender ? checkTarget(target, await readDefenderFireGrid()) : fenceCombat(target);
      for (;;) {
        const view = env.defender
          ? await readDefenderFireGrid()
          : await boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS);
        guard();
        try {
          await checkTarget(target, view);
        } catch (error) {
          if (env.defender && error instanceof SecurityTargetUnobserved) {
            reportWeaponPreparation(
              target,
              "target-or-escort-scope-changed",
              view,
              Math.max(...(reaches as number[])),
            );
            return "target-absent" as const;
          }
          throw error;
        }
        const rat = view.entities.find((e) => e.itemID === target);
        if (
          !view.ship?.geometryAvailable ||
          !rat?.geometryAvailable ||
          !qualified(state.currentIdentity, rat)
        ) {
          if (env.defender) {
            reportWeaponPreparation(
              target,
              "target-unavailable",
              view,
              Math.max(...(reaches as number[])),
            );
            return "target-absent" as const;
          }
          throw Error("Combat weapon target geometry is unavailable.");
        }
        const distance = Math.max(
          0,
          Math.hypot(
            rat.position.x - view.ship.position.x,
            rat.position.y - view.ship.position.y,
            rat.position.z - view.ship.position.z,
          ) -
            rat.radius -
            view.ship.radius,
        );
        if (!Number.isFinite(distance)) throw Error("Combat weapon target range is unavailable.");
        if (env.defender) {
          defenderDistance = distance;
          preSample = view.sampledAtMs;
          fireView = view;
          break;
        }
        if (distance <= reach) {
          preSample = view.sampledAtMs;
          break;
        }
        if (!approached) {
          approached = true;
          await boundedDroneWrite(
            () => session().flow.approach(target, Math.max(1000, Math.floor(reach * 0.8))),
            DRONE_NATIVE_IO_TIMEOUT_MS,
            () => {
              state.droneUnresolved = true;
            },
          );
        }
        if (Date.now() >= deadline) throw Error("Combat target did not enter weapon range.");
        await sleep(1000);
        guard();
      }
      const scope = JSON.stringify([run.botID, run.characterID, f.shipID, identity, target]);
      const lock = env.defender ? defenderLocks.get(target) : undefined;
      const lockOrdinal = env.defender ? (lock?.confirmed ? lock.ordinal : null) : 0;
      if (lockOrdinal === null) {
        reportWeaponPreparation(
          target,
          "lock-not-confirmed",
          fireView,
          Math.max(...(reaches as number[])),
          defenderLockRange,
          defenderDroneRange,
          false,
        );
        return "waiting-lock" as const;
      }
      const actionScope = env.defender
        ? JSON.stringify([scope, weaponRevision, lockOrdinal, defenderTargetRevision])
        : JSON.stringify([scope, weaponRevision]);
      if (!env.defender)
        await executeCombatTargetLock(
          { key: scope, characterID: run.characterID, shipID: f.shipID, targetID: target },
          {
            document: documents.locks,
            current: guard,
            fence: () => fenceCombat(target),
            lock: () =>
              boundedDroneWrite(
                () => session().flow.flying.bridgeDo("dogmaIM", "AddTarget", [target]),
                DRONE_NATIVE_IO_TIMEOUT_MS,
                () => {
                  state.droneUnresolved = true;
                },
              ),
            now: env.now ?? Date.now,
          },
        );
      const engageWeapon = async (id: number) => {
        const module = weapons.find((m) => m.itemID === id);
        if (!module) throw Error("Combat weapon identity changed.");
        let requested = false,
          targetRefused = false,
          before: WeaponEffects | undefined;
        const readNativeEffect = async () => {
          const info = await moduleObservation(module, f.shipID);
          guard();
          return {
            online: info.online,
            active: info.effects.some((effect) => effect.effectID !== 16),
            targets: info.activeTargets.flatMap((effect) =>
              effect.targetID !== null ? [effect.targetID] : [],
            ),
          };
        };
        const weaponRangeM = weaponRanges.get(id) ?? 0;
        const evidence = timing
          ? { ...weaponTimingFields(target, fireView, weaponRangeM), moduleID: id }
          : undefined;
        const report = (outcome: string, reason = outcome) =>
          timing?.change(
            "defender-weapon-result",
            `${target}:${reason}:${requested}:${evidence?.lockConfirmed}`,
            { ...evidence, outcome, reason, requested },
            `defender-weapon:${id}`,
            "essential",
          );
        if (env.defender) {
          if (defenderDistance > weaponRangeM) {
            report("unavailable", "outside-weapon-range");
            return "unavailable" as const;
          }
          const ship = fireView?.ship;
          if (ship?.activeModuleIDs && ship.activeModuleTargets) {
            const targets = ship.activeModuleTargets
              .filter((effect) => effect.moduleID === id)
              .map((effect) => effect.targetID);
            before = {
              online: true,
              active: targets.length > 0 || ship.activeModuleIDs.includes(id),
              targets,
            };
          } else before = defenderWeaponStates.get(id) ?? (await readNativeEffect());
          guard();
          defenderWeaponStates.set(id, before);
          const previous = before.targets.filter((id) => id !== target);
          if (
            before.online &&
            previous.length &&
            previous.every((id) => retiredWeaponTargets.has(id))
          ) {
            if (!retiringWeapons.has(id)) {
              try {
                await fireFence();
              } catch (error) {
                if (error instanceof SecurityTargetUnobserved) {
                  report("target-absent");
                  return "target-absent" as const;
                }
                throw error;
              }
              guard();
              retiringWeapons.add(id);
              try {
                await boundedDroneWrite(
                  () => ask("dogmaIM", "Deactivate", [id, null]),
                  DRONE_NATIVE_IO_TIMEOUT_MS,
                  () => {},
                );
              } catch (error) {
                current();
                diagnostic("weapon-unavailable", {
                  moduleID: id,
                  target,
                  reason:
                    "Waiting for the prior weapon effect to become inactive. " +
                    (error instanceof Error ? error.message : String(error)),
                });
              }
            }
            report("settling", "previous-target-effect-active");
            return "settling" as const;
          }
          retiringWeapons.delete(id);
          if (
            !before.online ||
            (before.active && !before.targets.includes(target)) ||
            previous.length > 0
          ) {
            diagnostic("weapon-unavailable", {
              moduleID: id,
              target,
              reason: before.online ? "Module is active on another target." : "Module is offline.",
            });
            report(
              "unavailable",
              before.online ? "weapon-active-on-other-target" : "weapon-offline",
            );
            return "unavailable" as const;
          }
        }
        let outcome;
        const readEffect = async () => {
          const info = !requested && before ? before : await readNativeEffect();
          if (env.defender) defenderWeaponStates.set(id, info);
          return info;
        };
        try {
          outcome = await executeCombatModuleAction(
            {
              key: JSON.stringify([actionScope, id]),
              characterID: run.characterID,
              shipID: f.shipID,
              moduleID: id,
              typeID: module.typeID,
              targetID: target,
              kind: "weapon",
            },
            {
              document: documents.actions,
              current: guard,
              fence: fireFence,
              observed: async () => {
                const info = await readEffect();
                if (!info.online) throw Error("Combat weapon is offline.");
                if (!env.defender && info.targets.some((id) => id !== target))
                  throw Error("Combat weapon is still active on another target.");
                return info.targets.includes(target);
              },
              observeWeapon: before
                ? async (prior) => {
                    if (
                      prior.characterID !== run.characterID ||
                      prior.shipID !== f.shipID ||
                      prior.typeID !== module.typeID ||
                      prior.kind !== "weapon"
                    )
                      throw Error("Combat weapon action identity changed.");
                    let info;
                    try {
                      info = await readEffect();
                    } catch (error) {
                      guard();
                      if (error instanceof FleetObservationUnavailable) return null;
                      throw error;
                    }
                    if (prior.targetID !== null && info.targets.includes(prior.targetID))
                      return "active";
                    return info.active ? null : "inactive";
                  }
                : undefined,
              targetAbsent: env.defender
                ? undefined
                : async (_action, error) => {
                    if (!(error instanceof SecurityTargetUnobserved) || preSample === null)
                      return false;
                    const until = Date.now() + 90000;
                    for (;;) {
                      await (env.fenceRoomForAbsence?.() ?? fenceCombat(null));
                      guard();
                      const [fresh, info] = await Promise.all([
                        scene(),
                        moduleObservation(module, f.shipID),
                      ]);
                      guard();
                      if (
                        fresh.sampledAtMs !== null &&
                        fresh.sampledAtMs > preSample &&
                        !fresh.entities.some((e) => e.itemID === target) &&
                        !info.activeTargets.some((e) => e.targetID === target)
                      ) {
                        diagnostic("weapon-target-absent", {
                          target,
                          moduleID: id,
                          scope: identity,
                          sampledAt: fresh.sampledAtMs,
                        });
                        return true;
                      }
                      if (Date.now() >= until) return false;
                      await sleep(500);
                    }
                  },
              activate: async () => {
                requested = true;
                timing?.note("defender-activate-call", evidence, "essential");
                try {
                  return await timed(
                    timing,
                    "defender-activate-rpc",
                    () =>
                      boundedDroneWrite(
                        () =>
                          session().flow.flying.bridgeDo("dogmaIM", "Activate", [
                            id,
                            "",
                            target,
                            -1,
                          ]),
                        DRONE_NATIVE_IO_TIMEOUT_MS,
                        () => {},
                      ),
                    evidence,
                    0,
                    "essential",
                  );
                } catch (error) {
                  if (
                    !env.defender &&
                    !targetNotLockedRefusal(error) &&
                    !alreadyActiveRefusal(error) &&
                    !optionalRefusal(error)
                  )
                    state.droneUnresolved = true;
                  throw error;
                }
              },
              optionalRefusal: (error) => {
                const reason = optionalRefusal(error);
                targetRefused =
                  !!env.defender &&
                  definiteRefusal(error) &&
                  (error as { refusal?: { key?: string } }).refusal?.key ===
                    "DeniedActivateTargetNotPresent";
                if (reason)
                  diagnostic(targetRefused ? "weapon-target-refused" : "weapon-unavailable", {
                    moduleID: id,
                    target,
                    reason,
                  });
                return reason;
              },
              receiptCurrent: env.defender ? current : undefined,
              reacquireLock: !!env.defender,
              sleep,
              now: env.now ?? Date.now,
            },
          );
        } catch (error) {
          if (env.defender && error instanceof SecurityTargetUnobserved) {
            report("target-absent");
            return "target-absent" as const;
          }
          throw error;
        }
        report(outcome ?? "effect-confirmed");
        if (targetRefused) {
          // EveJS has already confirmed this target left. The shared firing grid
          // can still qualify the others until its ordinary freshness limit.
          retireAbsentTarget(target, fireView!);
          return "target-absent" as const;
        }
        if (outcome === "pending") return "settling" as const;
        if (outcome === "already-active" || outcome === "inactive") {
          diagnostic("weapon-unavailable", {
            moduleID: id,
            target,
            reason:
              outcome === "inactive"
                ? "The recorded weapon effect is no longer active."
                : "EffectAlreadyActive2 without a matching target effect.",
          });
          return "unavailable" as const;
        }
        return outcome;
      };
      if (!env.defender) {
        for (const id of ids)
          if ((await engageWeapon(id)) === "target-absent") return "target-absent" as const;
        return;
      }
      const outcomes = (await Promise.allSettled(ids.map(engageWeapon))).map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      if (outcomes.includes("target-absent")) return "target-absent" as const;
      const lockLost = outcomes.includes("lock-lost");
      if (lockLost) {
        const entry = defenderLocks.get(target);
        if (entry) {
          entry.confirmed = false;
          entry.ordinal++;
          entry.unknown = false;
          entry.retryAllowed = false;
          entry.retryAt = 0;
        }
        lockRoster?.delete(target);
        defenderWeaponRevision++;
      }
      if (outcomes.includes("settling")) return "settling" as const;
      if (!outcomes.includes(undefined))
        return lockLost ? ("waiting-lock" as const) : ("unavailable" as const);
    },
    canReacquire: env.defender
      ? async (target) => defenderLocks.get(target)?.confirmed !== true
      : undefined,
    weaponsActive: weaponActivity,
    launch: async (stacks, context) => {
      if (launchUnknown)
        throw Error("Combat drones did not launch with a known result; no launch replay.");
      await boundedDroneRead(() => fenceCombat(null), DRONE_NATIVE_IO_TIMEOUT_MS);
      diagnostic("launch-dispatch", { stacks, scope: state.currentIdentity });
      let result: unknown;
      const launchEvidence = timing
        ? {
            targetID: context?.targetID ?? null,
            targetSelected: context?.selected,
            droneCount: stacks.reduce((total, stack) => total + stack.quantity, 0),
          }
        : undefined;
      timing?.note("defender-drone-launch-call", launchEvidence, "essential");
      try {
        result = await timed(
          timing,
          "defender-drone-launch-rpc",
          () =>
            boundedDroneWrite(
              () =>
                ask("ship", "LaunchDrones", [
                  stacks.map((s) => [s.itemID, s.quantity]),
                  null,
                  false,
                ]),
              DRONE_NATIVE_IO_TIMEOUT_MS,
              () => {},
            ),
          launchEvidence,
          0,
          "essential",
        );
      } catch (error) {
        if (!env.defender || !definiteRefusal(error)) {
          launchUnknown = true;
          state.droneUnresolved = true;
          throw error;
        }
        guard();
        refusedLaunchObservation = launchObservation;
        preparation?.invalidateBay();
        preparation?.invalidateLimits();
        droneLaunchWarning = String((error as Error).message ?? error);
        diagnostic("drone-engage-refused", { reason: droneLaunchWarning });
        return droneLaunchWarning;
      }
      diagnostic("launch-response", { stacks, result });
      let ids: number[];
      try {
        if (env.defender) {
          const outcome = readCombatDroneLaunch(result, stacks);
          ids = outcome.ids;
          if (outcome.refusals.length) {
            refusedLaunchObservation = launchObservation;
            preparation?.invalidateBay();
            preparation?.invalidateLimits();
            droneLaunchWarning = outcome.refusals.join(" ");
            diagnostic("launch-refused", { reason: droneLaunchWarning, confirmedIDs: ids });
          }
          if (!ids.length) return droneLaunchWarning ?? "No drone launch was confirmed.";
        } else ids = launchedDroneIDs(result, stacks);
      } catch (error) {
        launchUnknown = true;
        state.droneUnresolved = true;
        throw error;
      }
      const deadline = Date.now() + DRONE_OBSERVATION_TIMEOUT_MS;
      for (const id of ids) droneCustody.add(id);
      if (env.defender) {
        pendingLaunch = { ids, deadline };
        preparation?.noteLaunch(ids);
        return;
      }
      for (;;) {
        guard();
        const s = await boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS);
        diagnostic("launch-observation", droneSample(s, ids, null));
        if (
          ids.every((id) =>
            s.entities.some(
              (e) =>
                e.itemID === id &&
                e.kind === "drone" &&
                e.ownerID === run.characterID &&
                e.controllerID === s.shipID,
            ),
          )
        ) {
          diagnostic("launch-confirmed", droneSample(s, ids, null));
          return;
        }
        if (Date.now() >= deadline) {
          launchUnknown = true;
          throw new Error("Launched drones lack observed owner and controller; no launch replay.");
        }
        await sleep(500);
      }
    },
    engage: async (ids, target, dispatched) => {
      const targetFence = async () => {
        try {
          await boundedDroneRead(() => fenceCombat(target), DRONE_NATIVE_IO_TIMEOUT_MS);
          return true;
        } catch (error) {
          if (error instanceof SecurityTargetUnobserved || error instanceof FleetRoomRetired) {
            guard();
            diagnostic("engage-not-dispatched", {
              target,
              scope: state.currentIdentity,
              reason: error.message,
            });
            return false;
          }
          throw error;
        }
      };
      if (!env.defender && !(await targetFence())) return "not-dispatched" as const;
      if (!env.defender && !(await session().flow.flying.readFit()))
        throw new Error("Security drone range fitting is unreadable.");
      const range = env.defender
        ? defenderDroneRange
        : await session().flow.flying.resolveDroneControlRange(session().store.fitting.get());
      if (typeof range !== "number" || !Number.isFinite(range) || range <= 0) {
        if (env.defender) return "not-dispatched" as const;
        throw new Error("Native drone control range is unreadable.");
      }
      let moved = false;
      const approachDeadline = Date.now() + 120000;
      while (!env.defender) {
        guard();
        if (!(await targetFence())) return "not-dispatched" as const;
        const view = await boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS),
          rat = view.entities.find((e) => e.itemID === target);
        if (!view.ship) throw new Error("Security ship geometry is unavailable.");
        if (!rat) {
          await boundedDroneRead(() => fenceCombat(null), DRONE_NATIVE_IO_TIMEOUT_MS);
          guard();
          diagnostic("engage-not-dispatched", {
            target,
            scope: state.currentIdentity,
            reason: "Target absent before native engage.",
            sceneSampledAt: view.sampledAtMs,
          });
          return "not-dispatched" as const;
        }
        if (!qualified(state.currentIdentity, rat))
          throw new Error("Security target identity is not qualified.");
        const distance = Math.max(
          0,
          Math.hypot(
            rat.position.x - view.ship.position.x,
            rat.position.y - view.ship.position.y,
            rat.position.z - view.ship.position.z,
          ) -
            rat.radius -
            view.ship.radius,
        );
        if (distance <= range) break;
        if (env.defender) return "not-dispatched" as const;
        if (!moved) {
          moved = true;
          await session().flow.approach(target, Math.max(1000, Math.floor(range * 0.8)));
        }
        if (Date.now() >= approachDeadline)
          throw new Error("Security target did not enter drone range.");
        await sleep(1000);
      }
      if (!env.defender && !(await targetFence())) return "not-dispatched" as const;
      const preEngage = await (env.defender
        ? readDefenderFireGrid()
        : boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS));
      if (env.defender && absentTargets.has(target)) return "target-absent" as const;
      const finalTarget = preEngage.entities.find((e) => e.itemID === target);
      if (!finalTarget) {
        if (env.defender) {
          guard();
          return "target-absent" as const;
        }
        await boundedDroneRead(() => fenceCombat(null), DRONE_NATIVE_IO_TIMEOUT_MS);
        guard();
        diagnostic("engage-not-dispatched", {
          target,
          scope: state.currentIdentity,
          reason: "Target absent at final scene before native engage.",
          sceneSampledAt: preEngage.sampledAtMs,
        });
        return "not-dispatched" as const;
      }
      if (env.defender) {
        try {
          await checkTarget(target, preEngage);
        } catch (error) {
          if (error instanceof SecurityTargetUnobserved) return "target-absent" as const;
          throw error;
        }
        if (
          !ids.every((id) =>
            preEngage.entities.some(
              (e) =>
                e.itemID === id &&
                e.kind === "drone" &&
                e.ownerID === run.characterID &&
                e.controllerID === preEngage.shipID,
            ),
          )
        )
          return "not-dispatched" as const;
      } else if (!qualified(state.currentIdentity, finalTarget))
        throw Error("Security target identity is not qualified.");
      if (!preEngage.ship?.geometryAvailable) throw Error("Security ship geometry is unavailable.");
      const finalDistance = Math.max(
        0,
        Math.hypot(
          finalTarget.position.x - preEngage.ship.position.x,
          finalTarget.position.y - preEngage.ship.position.y,
          finalTarget.position.z - preEngage.ship.position.z,
        ) -
          finalTarget.radius -
          preEngage.ship.radius,
      );
      if (!Number.isFinite(finalDistance)) throw Error("Security target range is unreadable.");
      if (finalDistance > range) {
        guard();
        diagnostic("engage-not-dispatched", {
          target,
          scope: state.currentIdentity,
          reason: "Target outside native drone control range before engage.",
          distance: finalDistance,
          range,
          sceneSampledAt: preEngage.sampledAtMs,
        });
        return "not-dispatched" as const;
      }
      try {
        guard();
        env.checkBeforeEngage?.(target);
      } catch (error) {
        if (error instanceof FleetRoomRetired) {
          guard();
          diagnostic("engage-not-dispatched", {
            target,
            scope: state.currentIdentity,
            reason: error.message,
          });
          return "not-dispatched" as const;
        }
        throw error;
      }
      diagnostic("engage-dispatch", {
        ids,
        target,
        scope: state.currentIdentity,
        range,
        sceneSampledAt: preEngage.sampledAtMs,
      });
      let result: unknown;
      dispatched?.();
      const engageEvidence = {
        targetID: target,
        droneCount: ids.length,
        sceneSampledAtMs: preEngage.sampledAtMs,
      };
      timing?.note("defender-cmd-engage-call", engageEvidence, "essential");
      try {
        result = await timed(
          timing,
          "defender-cmd-engage-rpc",
          () =>
            boundedDroneWrite(
              () => ask("entity", "CmdEngage", [[...ids], target]),
              DRONE_NATIVE_IO_TIMEOUT_MS,
              () => {
                state.droneUnresolved = true;
              },
            ),
          engageEvidence,
          0,
          "essential",
        );
      } catch (error) {
        if (!env.defender || !definiteRefusal(error)) throw error;
        guard();
        diagnostic("drone-engage-refused", {
          target,
          reason: String((error as Error).message ?? error),
        });
        return "unavailable" as const;
      }
      diagnostic("engage-response", { ids, target, result });
      const confirmAbsent = async (observed?: Scene) => {
        const id = state.currentIdentity;
        if (!id) throw new Error("Security target scope was retired.");
        if (env.defender && !observed) {
          defenderFireGrid = undefined;
          observed = await readDefenderFireGrid();
        }
        if (env.confirmTargetAbsent) {
          const absent = await boundedDroneRead(
            () => env.confirmTargetAbsent!({ identity: id, ids, target, preEngage, observed }),
            DRONE_NATIVE_IO_TIMEOUT_MS,
          );
          guard();
          if (absent) {
            diagnostic("engage-target-absent", { target, scope: id });
            return true;
          }
        } else {
          const [f, m, d, fresh] = await boundedDroneRead(
            () => Promise.all([flight(), mission(), dungeon(), scene()]),
            DRONE_NATIVE_IO_TIMEOUT_MS,
          );
          guard();
          const absent = confirmAbsentTarget({
            identity: id as unknown as Identity,
            mission: m.objective
              ? { acceptedKey: m.objective.offer.key, status: m.objective.offer.status }
              : null,
            dungeon: d,
            flight: f,
            scene: fresh,
            anchor: state.entryAnchor,
            ownerID: run.characterID,
            ids,
            target,
          });
          if (
            absent &&
            preEngage.sampledAtMs !== null &&
            fresh.sampledAtMs !== null &&
            fresh.sampledAtMs > preEngage.sampledAtMs
          ) {
            diagnostic("engage-target-absent", {
              target,
              scope: id,
              objectiveComplete: m.objective?.objectiveComplete,
              dungeonComplete: m.objective?.dungeonComplete,
              sampledAt: fresh.sampledAtMs,
            });
            return true;
          }
        }
        return false;
      };
      if (allDronesTargetUnavailable(result, ids)) {
        const now = env.now ?? Date.now,
          refusalDeadline = now() + 5000;
        for (;;) {
          if (await confirmAbsent()) return "target-absent" as const;
          if (env.defender || now() >= refusalDeadline) break;
          await sleep(500);
          guard();
        }
        if (env.defender) {
          diagnostic("drone-engage-refused", {
            target,
            reason: "That target cannot be engaged by drones.",
          });
          return "unavailable" as const;
        }
      }
      let awaiting = ids;
      try {
        checkDroneEngage(result, ids);
      } catch (error) {
        if (!env.defender || !(error instanceof DroneOrderRefused)) throw error;
        const { entries } = result as { entries: readonly [unknown, unknown][] };
        const refused = new Set(entries.map(([id]) => Number(unwrapLong(id))));
        awaiting = ids.filter((id) => !refused.has(id));
        diagnostic("drone-engage-refused", { target, reason: error.message });
        if (!awaiting.length) return "unavailable" as const;
      }
      if (env.defender) {
        defenderEngagement = { ids: awaiting, target };
        return "pending" as const;
      }
      const deadline = Date.now() + DRONE_OBSERVATION_TIMEOUT_MS;
      for (;;) {
        guard();
        const s = await boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS);
        diagnostic("engage-observation", droneSample(s, awaiting, target));
        if (
          awaiting.every((id) =>
            s.entities.some(
              (e) =>
                e.itemID === id &&
                e.kind === "drone" &&
                e.ownerID === run.characterID &&
                e.controllerID === s.shipID &&
                e.targetEntityID === target,
            ),
          )
        ) {
          diagnostic("engage-confirmed", droneSample(s, awaiting, target));
          return;
        }
        if (!s.entities.some((e) => e.itemID === target) && (await confirmAbsent()))
          return "target-absent" as const;
        if (Date.now() >= deadline)
          throw new Error("Drone engagement activity was not observed; no order replay.");
        await sleep(500);
      }
    },
    settle: async (regrouping) => {
      observedFocus = null;
      if (regrouping && env.defender) {
        for (const effect of defenderFrame?.ship?.activeModuleTargets ?? []) {
          const id = effect.moduleID;
          if (!weapons.some((m) => m.itemID === id) || retiringWeapons.has(id)) continue;
          guard();
          retiringWeapons.add(id);
          try {
            await boundedDroneWrite(
              () => ask("dogmaIM", "Deactivate", [id, null]),
              DRONE_NATIVE_IO_TIMEOUT_MS,
              () => {},
            );
          } catch (error) {
            guard();
            if (!definiteRefusal(error) && !transientNativeRead(error)) throw error;
          }
        }
        return;
      }
      if (env.defender?.recall) {
        if (await env.defender.recall([...droneCustody])) {
          droneCustody.clear();
          droneReturns.clear();
          pendingLaunch = null;
          preparation?.invalidateBay();
        }
      } else if (state.droneUnresolved)
        throw new Error("A drone command remains in flight; custody is retained.");
      // A pending target acquisition cannot activate a module. MCC still checks
      // the ship's effects and drones before moving, even with an older lock record.
      if (env.moduleDocuments) {
        const { locks, actions } = env.moduleDocuments;
        for (const document of env.defender ? [actions] : [locks, actions]) {
          const doc = document.read() as {
            version?: number;
            entries?: { status?: string }[];
          } | null;
          if (
            doc !== null &&
            (doc.version !== 1 ||
              !Array.isArray(doc.entries) ||
              doc.entries.some((entry) => {
                if (entry.status === "ACKNOWLEDGED") return document === actions && !env.defender;
                return entry.status === "DISPATCHED";
              }))
          )
            throw Error(
              env.defender
                ? "A combat module command remains unresolved; custody is retained."
                : "A combat module or target-lock command remains unresolved; custody is retained.",
            );
        }
      }
      const beforeStop = await boundedDroneRead(flight, DRONE_NATIVE_IO_TIMEOUT_MS);
      const reloads = env.moduleDocuments?.reloads;
      if (reloads) {
        const unresolved = () => {
          const doc = reloads.read() as { version?: number; rows?: { status?: string }[] } | null;
          return (
            doc !== null &&
            (doc.version !== 1 ||
              !Array.isArray(doc.rows) ||
              doc.rows.some((r) => r.status !== "CONFIRMED"))
          );
        };
        if (env.defender && unresolved() && positive(beforeStop.shipID)) {
          const {
            flow: { flying },
            store: { fitting },
          } = session();
          if (await boundedDroneRead(() => flying.readFit(), DRONE_NATIVE_IO_TIMEOUT_MS)) {
            const fit = fitting.get();
            current();
            if (fit.activeShipID === beforeStop.shipID && fit.slotsError === null)
              observeReloads(reloads, beforeStop.shipID, fit);
          }
        }
        if (unresolved())
          throw Error("A combat ammunition reload remains unresolved; custody is retained.");
      }
      await boundedDroneRead(
        () => ask("invCache", "InvalidateLocationCache", [beforeStop.shipID]),
        DRONE_NATIVE_IO_TIMEOUT_MS,
      );
      if (beforeStop.docked && droneCustody.size === 0) return;
      // Scene and fresh bay are independent of the panel's cached-bay filter.
      const recallDeadline = Date.now() + 90000;
      while (!env.defender?.recall) {
        current();
        const f = await boundedDroneRead(flight, DRONE_NATIVE_IO_TIMEOUT_MS);
        if (!positive(f.shipID)) throw new Error("Drone custody ship is unreadable.");
        await boundedDroneRead(
          () => ask("invCache", "InvalidateLocationCache", [f.shipID]),
          DRONE_NATIVE_IO_TIMEOUT_MS,
        );
        const bay = checkedInventory(
          await boundedDroneRead(
            () => ask("invbroker", "List", [87], f.shipID),
            DRONE_NATIVE_IO_TIMEOUT_MS,
          ),
        );
        if (
          bay.some(
            (r) => r.ownerID !== run.characterID || r.locationID !== f.shipID || r.flagID !== 87,
          )
        )
          throw new Error("Drone bay custody is unreadable.");
        const inBay = new Set(bay.map((r) => r.itemID));
        const s = f.inSpace ? await boundedDroneRead(scene, DRONE_NATIVE_IO_TIMEOUT_MS) : null;
        const out =
          s?.entities.filter(
            (e) =>
              e.kind === "drone" && (e.ownerID === run.characterID || e.controllerID === f.shipID),
          ) ?? [];
        for (const d of out) {
          if (d.ownerID !== run.characterID || d.controllerID !== f.shipID)
            throw new Error("An uncontrolled drone retains custody.");
          droneCustody.add(d.itemID);
        }
        if (
          [...droneCustody].every((id) => inBay.has(id)) &&
          !out.some((d) => !inBay.has(d.itemID))
        ) {
          droneCustody.clear();
          droneReturns.clear();
          break;
        }
        if (!f.inSpace || !s) throw new Error("Drone return custody is unresolved.");
        const distance = (d: (typeof out)[number]) => {
          if (!s.ship || !d.geometryAvailable || !s.ship.geometryAvailable)
            throw new Error("Drone return distance is unreadable.");
          return Math.max(
            0,
            Math.hypot(
              d.position.x - s.ship.position.x,
              d.position.y - s.ship.position.y,
              d.position.z - s.ship.position.z,
            ) -
              d.radius -
              s.ship.radius,
          );
        };
        const toRecall = out.filter((d) => !inBay.has(d.itemID) && !droneReturns.has(d.itemID));
        if (toRecall.length) {
          const ids = toRecall.map((d) => d.itemID);
          const result = await boundedDroneWrite(
            () => ask("entity", "CmdReturnBay", [ids]),
            DRONE_NATIVE_IO_TIMEOUT_MS,
            () => {
              state.droneUnresolved = true;
            },
          );
          try {
            checkDroneEngage(result, ids);
          } catch (error) {
            state.droneUnresolved = true;
            throw error;
          }
          for (const d of toRecall)
            droneReturns.set(d.itemID, { at: Date.now(), distance: distance(d), rearmed: false });
        }
        const stalled: number[] = [];
        for (const d of out) {
          const prior = droneReturns.get(d.itemID);
          if (!prior || prior.rearmed || inBay.has(d.itemID)) continue;
          const dist = distance(d);
          if (stalledReturn(prior, dist, Date.now(), d.droneActivity, d.targetEntityID, f.shipID))
            stalled.push(d.itemID);
        }
        if (stalled.length) {
          for (const id of stalled) droneReturns.get(id)!.rearmed = true;
          const result = await boundedDroneWrite(
            () => ask("entity", "CmdReturnBay", [stalled]),
            DRONE_NATIVE_IO_TIMEOUT_MS,
            () => {
              state.droneUnresolved = true;
            },
          );
          try {
            checkDroneEngage(result, stalled);
          } catch (error) {
            state.droneUnresolved = true;
            throw error;
          }
        }
        if (Date.now() >= recallDeadline)
          throw new Error("Drones did not return before timeout; custody is retained.");
        await sleep(1000);
      }
      // Retire the client inventory cache, enumerate every fitted slot, then use
      // native ItemGetInfo for the full effect map, including untargeted cycles.
      const f = await flight();
      if (f.docked) return;
      if (!f.inSpace) throw new Error("Security module settlement location is unreadable.");
      await ask("invCache", "InvalidateLocationCache", [f.shipID]);
      const flags = [
        ...Array.from({ length: 24 }, (_, i) => 11 + i),
        ...Array.from({ length: 8 }, (_, i) => 92 + i),
        ...Array.from({ length: 8 }, (_, i) => 125 + i),
      ];
      const fit = await Promise.all(
        flags.map(async (flag) => ({
          flag,
          rows: checkedInventory(await ask("invbroker", "List", [flag], f.shipID)),
        })),
      );
      const modules: { itemID: number; typeID: number; flagID: number }[] = [],
        seen = new Set<number>();
      for (const { flag, rows } of fit) {
        let count = 0;
        for (const row of rows) {
          if (
            row.ownerID !== run.characterID ||
            row.locationID !== f.shipID ||
            row.flagID !== flag ||
            row.categoryID === null ||
            seen.has(row.itemID)
          )
            throw new Error("Security fitted inventory is unreadable.");
          seen.add(row.itemID);
          if (row.categoryID === 7) {
            if (++count > 1) throw new Error("Security fitting contains duplicate slot modules.");
            modules.push(row);
          }
        }
      }
      const deadline = Date.now() + 90000;
      for (;;) {
        current();
        const currentFlight = await flight();
        if (!currentFlight.inSpace || currentFlight.shipID !== f.shipID)
          throw new Error("Security ship changed during module settlement.");
        const active = [];
        for (const m of modules) {
          const info = decodeModuleObservation(await ask("dogmaIM", "ItemGetInfo", [m.itemID]), {
            moduleID: m.itemID,
            typeID: m.typeID,
            ownerID: run.characterID,
            shipID: f.shipID,
            flagID: m.flagID,
          });
          if (info.effects.some((effect) => effect.effectID !== 16)) active.push(m);
        }
        if (!active.length) {
          if (env.defender) moduleStops.clear();
          return;
        }
        for (const m of active)
          if (!moduleStops.has(m.itemID)) {
            const propulsion = preparation?.propulsion.find(
              (module) => module.itemID === m.itemID && module.typeID === m.typeID,
            );
            moduleStops.add(m.itemID);
            current();
            await ask("dogmaIM", "Deactivate", [m.itemID, propulsion?.effect ?? null]);
          }
        if (Date.now() >= deadline)
          throw new Error("Security modules did not settle before timeout.");
        await sleep(1000);
      }
    },
  });
  return {
    ...fighter,
    get dirty() {
      return fighter.dirty;
    },
    async tick(id: I, assertCurrent: () => void, observed?: Scene) {
      defenderFrame = env.defender ? observed : undefined;
      defenderFireGrid = defenderFrame
        ? { read: Promise.resolve(defenderFrame), observedAt: performance.now() }
        : undefined;
      prelockPlan = undefined;
      defenderWeaponStates.clear();
      try {
        const result = await fighter.tick(id, assertCurrent);
        if (prelockPlan) prepareNextLock();
        // Signature improves weapon ranking for later samples. The current grid
        // already has enough information to select a target and send the orders.
        const types = newSignatureTypes;
        if (types.length) {
          for (const typeID of types) defenderSignatures[typeID] = {};
          void session()
            .flow.flying.attributesOfTypes(types, [552])
            .then(
              (facts) => {
                for (const typeID of types) {
                  const row = facts[typeID];
                  if (row) defenderSignatures[typeID] = row;
                  else delete defenderSignatures[typeID];
                }
              },
              () => {
                for (const typeID of types) delete defenderSignatures[typeID];
              },
            );
        }
        return result;
      } finally {
        defenderFrame = undefined;
        defenderFireGrid = undefined;
        prelockPlan = undefined;
        newSignatureTypes = [];
      }
    },
    async settle(assertCurrent: () => void, regrouping = false, observed?: Scene) {
      if (!regrouping) {
        await defenseWork;
        await defenderReloadWork;
      }
      defenderFrame = observed;
      try {
        await fighter.settle(assertCurrent, regrouping);
      } finally {
        defenderFrame = undefined;
      }
    },
    serviceDefense,
    readyToEscort,
    focus: () => (Date.now() - observedFocusAt <= 15000 ? observedFocus : null),
    droneIDs: () => [...droneCustody],
  };
}
