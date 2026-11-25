import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import {
  decodeDroneBay,
  decodeDroneLimits,
  decodeSpaceSnapshot,
  getDrones,
  type PropulsionModule,
} from "../../../web/src/plugin-api/flying.ts";
import type { ApiOptions } from "../../../web/src/plugin-api/index.ts";
import { checkedInventory } from "../shared/nativeInventory.ts";
import { decodeModuleObservation } from "../shared/moduleObservation.ts";
import { unwrapReal } from "../shared/wire.ts";
import type { EscortWeapon } from "../miningFleet/defenderTargets.ts";
import { boundedDroneRead, effectiveDroneLimits, planCombatDroneLaunch } from "./droneAdapter.ts";
import { assertScopedWeaponCharge, combatFitModules, type CombatFitModule } from "./moduleFit.ts";

type Scene = ReturnType<typeof decodeSpaceSnapshot>;
type Fitting = ReturnType<PilotSession["store"]["fitting"]["get"]>;
type DroneBay = NonNullable<ReturnType<typeof decodeDroneBay>>;
type DroneLimits = { maxActiveDrones: number; droneBandwidth: number };
type PreparedWeapon = CombatFitModule & EscortWeapon;
type PreparedPropulsion = PropulsionModule & {
  effect: "moduleBonusAfterburner" | "moduleBonusMicrowarpdrive";
};
type TypeFacts = Readonly<Record<number, Readonly<Record<number, number>>>>;
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const read = <T>(work: () => Promise<T>) => boundedDroneRead(work, 90_000);
const hardwareOf = (fit: Fitting) =>
  JSON.stringify(
    fit.slots.map(({ family, index, module }) => [
      family,
      index,
      module && [module.itemID, module.typeID, module.online],
    ]),
  );
const ammoOf = (module: NonNullable<Fitting["slots"][number]["module"]>) =>
  JSON.stringify([module.charge?.typeID, (module.charge?.quantity ?? 0) > 0]);

export function combatWeaponRange(
  attributes: Readonly<Record<number, number>> | null,
  charge: Readonly<Record<number, number>> | undefined,
) {
  const tracking = attributes?.[160],
    optimal = attributes?.[54],
    falloff = attributes?.[158],
    velocity = charge?.[37],
    duration = charge?.[281];
  if (
    positive(tracking) &&
    positive(optimal) &&
    typeof falloff === "number" &&
    Number.isFinite(falloff) &&
    falloff >= 0
  )
    return optimal + falloff;
  return positive(velocity) && positive(duration) ? (velocity * duration) / 1000 : null;
}

/** Read-only equipment for the held ship. Belt changes keep this data with the hosted pilot. */
export function createDefenderPreparation({
  session,
  characterID,
  shipID,
  current,
  ask,
  options,
}: {
  session: PilotSession;
  characterID: number;
  shipID: number;
  current(): void;
  ask(service: string, method: string, args?: unknown[], of?: number): Promise<unknown>;
  options(): ApiOptions;
}) {
  const { flying } = session.flow,
    { fitting } = session.store;
  const ownFit = () => {
    const f = fitting.get();
    return f.activeShipID === shipID && f.slotsError === null ? f : null;
  };
  let fitLoaded = false,
    fitWork: Promise<void> | undefined,
    fitRetry = 0,
    hardwareKey: string | undefined;
  let modules: CombatFitModule[] = [];
  let propulsion: PreparedPropulsion[] = [];
  const guns = new Map<number, PreparedWeapon>(),
    ammo = new Map<number, string>();
  let gunWork: Promise<void> | undefined,
    gunRetry = 0;
  let sensorRange: number | null = null,
    droneRange: number | null = null,
    limits: DroneLimits | undefined;
  let sensorWork: Promise<void> | undefined,
    rangeWork: Promise<void> | undefined,
    limitWork: Promise<void> | undefined;
  let sensorRetry = 0,
    rangeRetry = 0,
    limitRetry = 0;
  let hardwareRevision = 0;
  let bay: DroneBay | undefined,
    bayWork: Promise<void> | undefined,
    bayRevision = 0,
    bayRetry = 0,
    lastOwn = "";
  let owned: Scene["entities"] = [];
  let rolesWork: Promise<void> | undefined,
    rolesRetry = 0,
    costWork: Promise<void> | undefined,
    costRetry = 0;
  const droneRoles = new Map<number, boolean>(),
    launched = new Set<number>(),
    costs: Record<number, number> = {};

  const fitStat = (name: "sensor" | "drone") => {
    const f = ownFit(),
      stat =
        name === "sensor" ? f?.stats?.targeting?.maxTargetRange : f?.stats?.bays?.droneControlRange;
    return stat?.known && positive(stat.value) ? stat.value : null;
  };
  const noDroneBay = () => {
    const cap = ownFit()?.stats?.bays?.droneCapacity;
    return cap?.known && cap.value === 0;
  };
  const readSensor = async () => {
    const value = unwrapReal(
      await flying.bridgeAsk("dogmaIM", "QueryAttributeValue", [shipID, 76]),
    );
    current();
    return positive(value) ? value : null;
  };
  const readLimits = async () => {
    const live = await read(() => ask("dogmaIM", "QueryAllAttributesForItem", [shipID])).then(
      effectiveDroneLimits,
      () => null,
    );
    current();
    if (live?.maxActiveDrones != null && live.droneBandwidth != null) {
      return { maxActiveDrones: live.maxActiveDrones, droneBandwidth: live.droneBandwidth };
    }
    const panel = await getDrones(options());
    current();
    if (panel.activeShipID !== shipID) return;
    const ship = decodeDroneLimits(panel.errors.shipInfo === null ? panel.shipInfo : undefined);
    const maxActiveDrones =
      live?.maxActiveDrones ??
      ship.maxActiveDrones ??
      flying.withPilotDroneCap(ship).maxActiveDrones;
    const droneBandwidth = live?.droneBandwidth ?? ship.droneBandwidth;
    return maxActiveDrones !== null && droneBandwidth !== null
      ? { maxActiveDrones, droneBandwidth }
      : undefined;
  };
  const recordRoles = (
    rows: readonly { itemID: number; typeID: number | null }[],
    roles: Awaited<ReturnType<typeof flying.classifyDroneRoles>>["out"],
  ) => {
    if (!roles) return;
    const classified = new Set(Object.values(roles).flat());
    for (const row of rows)
      if (row.typeID !== null && classified.has(row.itemID))
        droneRoles.set(row.typeID, roles.combat.includes(row.itemID));
  };
  const readBay = async () => {
    const revision = bayRevision;
    await ask("invCache", "InvalidateLocationCache", [shipID]);
    current();
    const rows = checkedInventory(await ask("invbroker", "List", [87], shipID));
    current();
    if (rows.some((r) => r.ownerID !== characterID || r.locationID !== shipID || r.flagID !== 87))
      throw Error("Defender drone bay identity is unreadable.");
    const observed = decodeDroneBay(
      rows.map((r) => ({ itemID: r.itemID, typeID: r.typeID, quantity: r.quantity })),
    );
    if (!observed) throw Error("Defender drone bay is unreadable.");
    const { bay: roles } = await flying.classifyDroneRoles(observed, null, shipID);
    current();
    if (revision !== bayRevision) return;
    recordRoles(observed, roles);
    if (observed.every((row) => droneRoles.has(row.typeID))) bay = observed;
  };
  const prepareGuns = async (
    fit: Fitting,
    hardware: string,
    candidates: readonly CombatFitModule[],
  ) => {
    const mounted = new Map(
      fit.slots.flatMap((s) => (s.module ? [[s.module.itemID, s.module] as const] : [])),
    );
    const chargeTypes = [
      ...new Set(
        candidates.flatMap((m) => {
          const charge = mounted.get(m.itemID)?.charge;
          return charge ? [charge.typeID] : [];
        }),
      ),
    ];
    const facts: Promise<TypeFacts> = chargeTypes.length
      ? read(() => flying.attributesOfTypes(chargeTypes, [1455, 37, 281, 653, 654, 1353, 1354]))
      : Promise.resolve({});
    await Promise.allSettled(
      candidates.map(async (module) => {
        const [raw, attrs] = await Promise.all([
          read(() => ask("dogmaIM", "ItemGetInfo", [module.itemID])),
          facts,
        ]);
        current();
        const slot = mounted.get(module.itemID),
          currentFit = ownFit();
        const currentModule = currentFit?.slots.find(
          (s) => s.module?.itemID === module.itemID,
        )?.module;
        if (
          !slot ||
          !currentFit ||
          !currentModule ||
          hardwareKey !== hardware ||
          hardwareOf(currentFit) !== hardware ||
          ammoOf(slot) !== ammoOf(currentModule)
        )
          return;
        const item = decodeModuleObservation(raw, {
          moduleID: module.itemID,
          typeID: module.typeID,
          ownerID: characterID,
          shipID,
          flagID: module.flagID,
        });
        const charge = slot.charge;
        assertScopedWeaponCharge(charge?.typeID ?? null, attrs);
        const missile = charge ? attrs[charge.typeID] : undefined,
          a = item.attributes;
        const range = combatWeaponRange(a, missile);
        if (!item.online || !positive(range)) return;
        const size = fit.chargeFits?.[module.typeID]?.size,
          tracking = a?.[160],
          optimal = a?.[54],
          falloff = a?.[158],
          resolution = a?.[620];
        const radius = missile?.[654],
          velocity = missile?.[653],
          factor = missile?.[1353] ?? 1,
          sensitivity = missile?.[1354] ?? 5.5;
        guns.set(module.itemID, {
          ...module,
          range,
          ...(positive(size) ? { chargeSize: size } : {}),
          ...(positive(tracking) && positive(optimal) && typeof falloff === "number" && falloff >= 0
            ? {
                turret: {
                  tracking,
                  optimal,
                  falloff,
                  resolution: positive(resolution) ? resolution : 40000,
                },
              }
            : positive(radius) && positive(velocity)
              ? {
                  missile: {
                    explosionRadius: radius,
                    explosionVelocity: velocity,
                    exponent:
                      factor > 1
                        ? Math.log(factor) / Math.log(Math.max(1.000001, sensitivity))
                        : Math.max(0.000001, factor),
                  },
                }
              : {}),
        });
      }),
    );
  };
  function invalidateBay() {
    bay = undefined;
    bayRevision++;
    bayRetry = 0;
  }
  function combatDrone(row: Scene["entities"][number]) {
    return launched.has(row.itemID) || (row.typeID !== null && droneRoles.get(row.typeID) === true);
  }
  function refresh(view?: Scene) {
    current();
    const now = Date.now(),
      fit = ownFit();
    const hardware = fit ? hardwareOf(fit) : undefined;
    if (hardware !== hardwareKey) {
      if (hardwareKey !== undefined) {
        hardwareRevision++;
        sensorRange = null;
        droneRange = null;
        limits = undefined;
        sensorRetry = 0;
        rangeRetry = 0;
        limitRetry = 0;
        fitLoaded = false;
        fitRetry = 0;
      }
      hardwareKey = hardware;
      modules = [];
      propulsion = [];
      guns.clear();
      ammo.clear();
      gunRetry = 0;
    }
    const revision = hardwareRevision;
    for (const { module } of fit?.slots ?? []) {
      if (!module) continue;
      const key = ammoOf(module);
      if (ammo.get(module.itemID) === key) continue;
      ammo.set(module.itemID, key);
      guns.delete(module.itemID);
      gunRetry = 0;
    }
    if (!fitWork && (!fitLoaded || !fit) && now >= fitRetry) {
      fitWork = read(() => flying.readFit())
        .then(
          (ok) => {
            current();
            fitLoaded = ok;
          },
          () => {},
        )
        .catch(() => {})
        .finally(() => {
          fitWork = undefined;
          fitRetry = Date.now() + 3000;
        });
      void fitWork
        .then(() => {
          if (fitLoaded) refresh();
        })
        .catch(() => {});
    }
    if (fit && hardware && fitLoaded && !gunWork && now >= gunRetry) {
      try {
        const defense = flying.resolveDefenseModuleIDs();
        modules = combatFitModules(fit.slots, defense, flying.resolveRemoteRepModuleIDs(), (m) =>
          flying.fittedModuleActivation(m),
        );
        propulsion = (defense.propulsion ?? []).flatMap((m) =>
          m.kind === null
            ? []
            : [
                {
                  ...m,
                  effect:
                    m.kind === "afterburner"
                      ? "moduleBonusAfterburner"
                      : "moduleBonusMicrowarpdrive",
                },
              ],
        );
        const missing = modules.filter(
          (m) =>
            m.kind === "weapon" &&
            !guns.has(m.itemID) &&
            (!fit.chargeFits?.[m.typeID]?.size ||
              !fit.chargeFits[m.typeID]?.groups.length ||
              (fit.slots.find((s) => s.module?.itemID === m.itemID)?.module?.charge?.quantity ??
                0) > 0),
        );
        if (missing.length)
          gunWork = prepareGuns(fit, hardware, missing)
            .catch(() => {})
            .finally(() => {
              gunWork = undefined;
              gunRetry = Date.now() + 3000;
            });
      } catch {
        gunRetry = now + 3000;
      }
    }
    if (fitStat("sensor") === null && sensorRange === null && !sensorWork && now >= sensorRetry)
      sensorWork = read(readSensor)
        .then((value) => {
          if (hardwareRevision === revision) sensorRange = value;
        })
        .catch(() => {})
        .finally(() => {
          sensorWork = undefined;
          sensorRetry = hardwareRevision === revision ? Date.now() + 3000 : 0;
        });
    const own =
      view?.entities.filter(
        (row) => row.kind === "drone" && row.ownerID === characterID && row.controllerID === shipID,
      ) ?? owned;
    if (view) owned = own;
    if (noDroneBay() && !own.length) return;
    if (fitStat("drone") === null && droneRange === null && !rangeWork && now >= rangeRetry)
      rangeWork = read(() => flying.resolveDroneControlRange(fitting.get()))
        .then((range) => {
          current();
          if (hardwareRevision === revision && positive(range)) droneRange = range;
        })
        .catch(() => {})
        .finally(() => {
          rangeWork = undefined;
          rangeRetry = hardwareRevision === revision ? Date.now() + 3000 : 0;
        });
    if (view) {
      const signature = own
        .map((d) => d.itemID)
        .sort((a, b) => a - b)
        .join(",");
      if (lastOwn && lastOwn !== signature) invalidateBay();
      lastOwn = signature;
      if (
        !rolesWork &&
        now >= rolesRetry &&
        own.some((d) => !launched.has(d.itemID) && (d.typeID === null || !droneRoles.has(d.typeID)))
      )
        rolesWork = read(() => flying.classifyDroneRoles(null, view, shipID))
          .then((x) => {
            current();
            recordRoles(own, x.out);
            for (const id of x.out?.combat ?? []) launched.add(id);
          })
          .catch(() => {})
          .finally(() => {
            rolesWork = undefined;
            rolesRetry = Date.now() + 3000;
          });
    }
    if (own.some(combatDrone)) return;
    if (!bay && !bayWork && now >= bayRetry) {
      bayWork = read(readBay)
        .catch(() => {})
        .finally(() => {
          bayWork = undefined;
          bayRetry = Date.now() + 3000;
        });
      void bayWork
        .then(() => {
          if (bay) refresh();
        })
        .catch(() => {});
    }
    if (!limits && !limitWork && now >= limitRetry)
      limitWork = read(readLimits)
        .then((value) => {
          if (hardwareRevision === revision) limits = value;
        })
        .catch(() => {})
        .finally(() => {
          limitWork = undefined;
          limitRetry = hardwareRevision === revision ? Date.now() + 3000 : 0;
        });
    const types = [
      ...new Set(
        [...(bay ?? []).filter((d) => droneRoles.get(d.typeID) === true), ...own].flatMap((d) =>
          d.typeID === null ? [] : [d.typeID],
        ),
      ),
    ].filter((id) => !Object.hasOwn(costs, id));
    if (types.length && !costWork && now >= costRetry)
      costWork = read(() => flying.attributesOfTypes(types, [1272]))
        .then((facts) => {
          current();
          for (const id of types) {
            const cost = facts[id]?.[1272];
            if (positive(cost)) costs[id] = cost;
          }
        })
        .catch(() => {})
        .finally(() => {
          costWork = undefined;
          costRetry = Date.now() + 3000;
        });
  }
  return {
    refresh,
    wakeFit() {
      fitLoaded = false;
      fitRetry = 0;
    },
    invalidateBay,
    noteLaunch(ids: readonly number[]) {
      for (const id of ids) launched.add(id);
    },
    invalidateLimits() {
      limits = undefined;
      limitRetry = 0;
    },
    combatDrone,
    get fit() {
      return ownFit();
    },
    get modules() {
      return modules;
    },
    get propulsion() {
      return propulsion;
    },
    get weapons() {
      return [...guns.values()];
    },
    get sensorRange() {
      return fitStat("sensor") ?? sensorRange;
    },
    get lockLimit() {
      const fit = ownFit(),
        allInfo = session.store.dogma?.get().allInfo;
      const pilot =
        (allInfo?.shipModifiedCharAttributes?.attributes ?? []).find((a) => a.attributeID === 192)
          ?.value ?? allInfo?.character?.attributes.find((a) => a.attributeID === 192)?.value;
      // The stock helper can fall back to the hull alone. Keep that fallback
      // out of speculative locks until the held pilot's attribute is known.
      if (!fit || typeof pilot !== "number" || !Number.isSafeInteger(pilot) || pilot < 1)
        return null;
      const limit = flying.lockLimit(fit);
      return limit !== null && Number.isSafeInteger(limit) && limit > 0 ? limit : null;
    },
    get droneRange() {
      return fitStat("drone") ?? droneRange;
    },
    get pending() {
      return (
        !fitLoaded ||
        !!gunWork ||
        (!noDroneBay() && (!bay || !!rolesWork || !!costWork || !!limitWork || !!rangeWork))
      );
    },
    async readFit() {
      refresh();
      await fitWork;
      current();
      return fitLoaded && ownFit() !== null;
    },
    async ready(view: Scene) {
      refresh(view);
      await fitWork;
      refresh(view);
      await Promise.all([gunWork, bayWork, rangeWork, rolesWork, limitWork]);
      refresh(view);
      await costWork;
    },
    plan(deployed: readonly Scene["entities"][number][]) {
      const stacks = bay?.filter((d) => droneRoles.get(d.typeID) === true);
      if (
        !stacks?.length ||
        !limits ||
        deployed.some((d) => d.typeID === null || !costs[d.typeID]) ||
        stacks.some((d) => !costs[d.typeID])
      )
        return [];
      return planCombatDroneLaunch(
        stacks,
        deployed.map((d) => ({ typeID: d.typeID! })),
        limits,
        costs,
      );
    },
  };
}
export type DefenderPreparation = ReturnType<typeof createDefenderPreparation>;
