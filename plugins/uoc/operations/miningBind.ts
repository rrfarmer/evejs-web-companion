import { planFleetMoves } from "../miningFleet/fleetMoves.ts";
import type { FleetDelivery } from "../miningFleet/delivery.ts";
import type { FleetSetup } from "../miningFleet/runtime.ts";
import type { SavedDefinition } from "./miningStore.ts";
import { currentExecutorGaps } from "./miningCapabilities.ts";
import type { MiningPreparation } from "./miningPreparationHost.ts";

type Fleet =
  { state: "not-in-fleet" } | { state: "ready"; fleetID: number; memberIDs: readonly number[] };
export type FleetInspection = {
  characterID: number;
  shipID: number;
  systemID: number;
  targetSystemID?: number;
  shipTypeName?: string | null;
  stationID: number | null;
  inSpace?: boolean;
  dockKind?: "station" | "structure";
  corporationID: number;
  officeID: number | null;
  canCapacityM3: number;
  observedAt: number;
  belts: readonly { itemID: number; name: string }[];
  fleet: Fleet | null;
  /** Equipment readiness comes from the held pilot. Account roster reads only identify the intended ship. */
  miningBursts?: readonly { moduleID: number; typeID: number; online: boolean }[] | null;
  industrialCores?: readonly { moduleID: number; typeID: number; online: boolean }[] | null;
  compressors?: readonly { moduleID: number; typeID: number; online: boolean }[] | null;
  tractors?: readonly { moduleID: number; typeID: number; online: boolean }[] | null;
  preparation?: {
    state: string;
    shipID?: number;
    equipment?: string;
    supplies?: string;
    definitionFingerprint?: string;
    fittingID?: number;
    providerCharacterID?: number;
    targets?: import("../restored/mining/preparationTypes.ts").SupplyResult[];
    fittingName?: string | null;
    reason?: string | null;
    sourceLabel?: string;
  };
  defender?: { qualified: boolean; reason?: string | null };
  fitHoldQualification?: {
    ORE: { miner: boolean; hauler: boolean };
    ICE: { miner: boolean; hauler: boolean };
  } | null;
};
export type VerifiedParking = {
  destinationID: number;
  kind: "station" | "structure";
  systemID: number;
};
export type BoundCandidate = {
  setup: FleetSetup;
  requiredMoves: readonly { characterID: number; shipID: number; fromFleetID: number }[];
};
export type FleetStartupPreparation = readonly {
  characterID: number;
  preparation: MiningPreparation;
}[];
export function fleetStartupPreparation(
  d: SavedDefinition,
  observedCorporationID?: number,
): FleetStartupPreparation {
  const common: MiningPreparation = d.preparation ?? {
    source: { kind: "hangar" },
    suppliesRequired: false,
  };
  const source =
    common.source.kind === "corp" &&
    common.source.corporationID === undefined &&
    observedCorporationID !== undefined
      ? { ...common.source, corporationID: observedCorporationID }
      : common.source;
  return d.members.flatMap((member) => {
    const fittingID = member.preparation?.fittingID;
    if (!fittingID) return [];
    return [
      {
        characterID: member.characterID,
        preparation: {
          ...common,
          source,
          fittingID,
          providerCharacterID: member.preparation?.providerCharacterID ?? member.characterID,
        },
      },
    ];
  });
}
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
/** Translate only a fully represented WC74 definition; no saved selection is silently discarded. */
export function bindFleetDefinition(
  d: SavedDefinition,
  observations: readonly FleetInspection[],
  options: {
    operationRunID: string;
    beltID?: number;
    parking?: VerifiedParking;
    delivery?: FleetDelivery;
    now?: number;
    maxAgeMs?: number;
    deferFleetObservation?: boolean;
  },
): BoundCandidate {
  const gaps = currentExecutorGaps(d);
  if (gaps.length) throw Error(gaps.join(" "));
  const now = options.now ?? Date.now(),
    age = options.maxAgeMs ?? 1800000;
  if (
    !options.operationRunID ||
    !Number.isFinite(now) ||
    !Number.isFinite(age) ||
    age <= 0 ||
    observations.length !== d.members.length ||
    new Set(observations.map((x) => x.characterID)).size !== observations.length
  )
    throw Error("Exact fresh fleet inspection is required.");
  const byID = new Map(observations.map((x) => [x.characterID, x]));
  const wanted = d.members.map((m) => {
    const x = byID.get(m.characterID);
    const located =
      x?.inSpace === true
        ? x.stationID === null && x.dockKind === undefined
        : positive(x?.stationID);
    if (
      !x ||
      !positive(x.shipID) ||
      !positive(x.systemID) ||
      !located ||
      (x.targetSystemID ?? x.systemID) !== d.area.anchorSystemID ||
      !positive(x.corporationID) ||
      !Number.isFinite(x.canCapacityM3) ||
      x.canCapacityM3 <= 0 ||
      !Number.isFinite(x.observedAt) ||
      x.observedAt > now ||
      now - x.observedAt > age ||
      !Array.isArray(x.belts) ||
      (!x.fleet && !options.deferFleetObservation)
    )
      throw Error(
        `Pilot ${m.characterID} inspection is unavailable, stale or outside the saved system.`,
      );
    return x;
  });
  if (
    new Set(wanted.map((x) => x.shipID)).size !== wanted.length ||
    new Set(d.members.map((x) => x.accountName.toLowerCase())).size !== d.members.length ||
    wanted.some((x) => x.canCapacityM3 !== wanted[0]!.canCapacityM3)
  )
    throw Error("Inspected ships, accounts or container capacities are inconsistent.");
  const lead = d.members.find((m) => m.role === "MINER")!,
    destination = d.unloadDestination;
  if (!destination) throw Error("Choose a verified delivery destination.");
  const destinationID = destination.kind === "structure" ? destination.id : destination.stationID;
  const actors = d.members.filter(
    (m) =>
      (d.unloadPolicy === "SELF_UNLOAD" ? m.role === "MINER" : m.role === "HAULER") ||
      (m.role === "COMMAND" &&
        (d.unloadPolicy === "SELF_UNLOAD"
          ? d.support?.selfMining
          : d.support?.collection === "TRACTOR_AND_COLLECT")),
  );
  let delivery = options.delivery;
  if (!delivery) {
    const first = byID.get(actors[0]!.characterID)!;
    if (destination.kind === "structure" || first.stationID !== destinationID)
      throw Error("A remote delivery destination needs current map/access verification.");
    delivery = {
      kind: "station",
      destinationID: destinationID as number,
      systemID: first.systemID,
      corporationID:
        destination.corporationDivision == null ? null : (destination.corporationID as number),
      division: destination.corporationDivision as number | null,
    };
  }
  if (
    !positive(destinationID) ||
    delivery.destinationID !== destinationID ||
    delivery.kind !== (destination.kind === "structure" ? "structure" : "station") ||
    !positive(delivery.systemID) ||
    delivery.division !== (destination.corporationDivision ?? null) ||
    delivery.corporationID !==
      (destination.corporationDivision == null ? null : destination.corporationID)
  )
    throw Error("The verified delivery differs from the saved destination.");
  if (
    delivery.corporationID !== null &&
    actors.some((m) => byID.get(m.characterID)!.corporationID !== delivery!.corporationID)
  )
    throw Error("Corporate delivery requires each delivering pilot’s verified corporation.");
  let target: Pick<FleetSetup, "beltID" | "beltName" | "siteSearch">;
  const family = d.area.targetClasses[0];
  if (family === "BELT") {
    const matches = byID
      .get(lead.characterID)!
      .belts.filter(
        (b) =>
          b.itemID === options.beltID &&
          positive(b.itemID) &&
          typeof b.name === "string" &&
          b.name.trim(),
      );
    if (matches.length !== 1)
      throw Error("The exact native belt must be selected from the inspected leader.");
    target = { beltID: matches[0]!.itemID, beltName: matches[0]!.name };
  } else if (family === "ORE_ANOMALY" || family === "ICE")
    target = {
      siteSearch: {
        family: family === "ICE" ? "ICE" : d.area.anomalyFamily === "MOON" ? "MOON" : "ORE",
      },
    };
  else throw Error("The saved target family is unsupported.");
  const parking = d.policies?.parking;
  let boundParking: FleetSetup["parking"];
  if (parking?.mode === "STAY_IN_PLACE") boundParking = { mode: "STAY_IN_PLACE" };
  else if (parking?.mode === "RETURN_HOME_DOCK" || parking?.mode === "RETURN_HOME_UNLOAD_DOCK") {
    const x = options.parking,
      original = parking.destination;
    const id = original?.kind === "structure" ? original.id : original?.stationID;
    if (
      !x ||
      !positive(id) ||
      x.destinationID !== id ||
      !positive(x.systemID) ||
      (original?.kind === "structure" ? "structure" : "station") !== x.kind
    )
      throw Error("The saved parking destination requires exact current map/access verification.");
    boundParking =
      parking.mode === "RETURN_HOME_UNLOAD_DOCK"
        ? {
            mode: "RETURN_HOME_UNLOAD_DOCK",
            ...x,
            corporationID: parking.corporationDivision == null ? null : parking.corporationID,
            division: parking.corporationDivision ?? null,
          }
        : { mode: "RETURN_HOME_DOCK", ...x };
  } else if (parking) throw Error("The saved unload-at-parking policy is not connected.");
  let support: Pick<FleetSetup, "command" | "supportPolicy" | "fleetPolicy"> = {};
  const commander = d.members.find((m) => m.role === "COMMAND");
  if (commander) {
    const p = d.support;
    if (!p || p.characterID !== commander.characterID)
      throw Error("Configure the selected COMMAND capabilities.");
    const x = byID.get(commander.characterID)!;
    const online = (rows: typeof x.miningBursts) =>
      rows
        ?.filter((m) => m.online && positive(m.moduleID) && positive(m.typeID))
        .map(({ moduleID, typeID }) => ({ moduleID, typeID })) ?? [];
    const unique = (rows: typeof x.miningBursts) => {
      const matches = online(rows);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const bursts = p.maintainBursts ? online(x.miningBursts) : [],
      core = p.useIndustrialCore ? unique(x.industrialCores) : undefined;
    const compressor = p.enableCompression && core ? unique(x.compressors) : undefined,
      tractor = p.tractor ? unique(x.tractors) : undefined;
    const command = {
      ...(bursts.length ? { bursts } : {}),
      ...(core ? { core } : {}),
      ...(compressor ? { compressor } : {}),
      ...(tractor ? { tractor } : {}),
    };
    const { version, characterID, fleetPolicy, ...policy } = p;
    support = { command, supportPolicy: policy, fleetPolicy };
  }
  const existingOnly = support.fleetPolicy === "EXISTING_ONLY";
  const verified = wanted.flatMap((x) =>
    x.fleet ? [{ characterID: x.characterID, shipID: x.shipID, fleet: x.fleet }] : [],
  );
  if (existingOnly && !options.deferFleetObservation) {
    const first = verified[0]?.fleet;
    if (
      first?.state !== "ready" ||
      verified.some(
        (x) =>
          x.fleet.state !== "ready" ||
          x.fleet.fleetID !== first.fleetID ||
          wanted.some(
            (y) => x.fleet.state !== "ready" || !x.fleet.memberIDs.includes(y.characterID),
          ),
      )
    )
      throw Error(
        "Use existing fleet requires a confirmed common fleet containing every selected pilot.",
      );
  }
  const moves =
    existingOnly || options.deferFleetObservation ? [] : planFleetMoves(verified, lead.characterID);
  const setup: FleetSetup = {
    operationID: d.operationID,
    operationRunID: options.operationRunID,
    systemID: d.area.anchorSystemID,
    destinationID: delivery.destinationID,
    ...(delivery.corporationID === null
      ? {}
      : { corporationID: delivery.corporationID, division: delivery.division! }),
    delivery,
    ...target,
    ...(family === "BELT"
      ? {
          beltCandidates: byID
            .get(lead.characterID)!
            .belts.map((b) => ({ beltID: b.itemID, beltName: b.name })),
        }
      : {}),
    ...support,
    ...(d.policies?.travelAssist ? { travelAssist: d.policies.travelAssist.mode } : {}),
    ...(d.oreLogistics ? { oreLogistics: d.oreLogistics } : {}),
    canCapacityM3: wanted[0]!.canCapacityM3,
    ...(d.policies?.resourcePolicy ? { resourcePolicy: d.policies.resourcePolicy } : {}),
    ...(boundParking ? { parking: boundParking } : {}),
    ...(d.unloadPolicy === "SELF_UNLOAD" ? { haulMode: "SELF_UNLOAD" as const } : {}),
    ...(moves.length ? { fleetMoves: moves } : {}),
    members: d.members.map((m) => ({
      characterID: m.characterID,
      shipID: byID.get(m.characterID)!.shipID,
      role: m.role as "MINER" | "HAULER" | "COMMAND" | "DEFENDER",
    })),
  };
  return { setup, requiredMoves: moves };
}
