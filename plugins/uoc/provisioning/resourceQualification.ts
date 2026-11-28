import { getShipBays, slotFlagOf, isSlotFlag } from "../../../web/src/plugin-api/flying.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { readKeyVal, readRowField, unwrapReal, type JsonValue } from "../shared/wire.ts";
import { exactInt } from "../shared/dogma.ts";

type FitItem = { typeID: number; flagID: number; quantity: number };
type Pair = { used: number; total: number };
const DRONE_BAY_FLAG = 87;
export type DroneBayQualification = {
  required: number | null;
  capacity: number | null;
  reason: string | null;
  simulated?: true;
};
export type ResourceQualification = (
  | {
      state: "SIMULATED";
      characterID: number;
      shipTypeID: number;
      cpu: Pair;
      powergrid: Pair;
      fits: boolean;
      source: "PILOT_BRAIN_CLIENT_SIMULATION";
    }
  | { state: "UNKNOWN"; reason: string }
) & { droneBay?: DroneBayQualification };
type DroneBayReview = {
  droneBay?: unknown;
  context: { shipID: number };
  plan: { mode: string; targetHullID: number | null };
};
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const obj = (x: unknown): x is Record<string, any> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const allowedFunctions = new Set([
  "ItemModifier",
  "LocationModifier",
  "LocationGroupModifier",
  "LocationRequiredSkillModifier",
  "OwnerRequiredSkillModifier",
]);
const allowedDomains = new Set([null, "itemID", "shipID", "charID", "otherID"]);
const number = (x: any) =>
  typeof x === "number" ? x : obj(x) && ["long", "real"].includes(x.type) ? Number(x.value) : NaN;
const items = (x: any): unknown[] | null =>
  Array.isArray(x) ? x : obj(x) && x.type === "list" && Array.isArray(x.items) ? x.items : null;
/** The client's brain decoder silently drops malformed/unsupported modifiers; don't report those as a complete simulation. */
export function supportedBrain(raw: unknown): boolean {
  if (!Array.isArray(raw) || raw.length < 4 || !Number.isSafeInteger(number(raw[0]))) return false;
  for (const part of [raw[1], raw[2]]) {
    const effects = items(part);
    if (!effects) return false;
    for (const effect of effects) {
      if (
        !obj(effect) ||
        !Array.isArray(effect.header) ||
        !obj(effect.header[2]) ||
        effect.header[2].type !== "dict" ||
        !Array.isArray(effect.header[2].entries)
      )
        return false;
      const entries = effect.header[2].entries;
      if (
        entries.some((e: any) => !Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string") ||
        new Set(entries.map((e: any) => e[0])).size !== entries.length
      )
        return false;
      const f = Object.fromEntries(entries) as Record<string, any>,
        op = number(f.operation),
        target = number(f.toAttribID),
        value = number(f.value);
      if (
        !["M", "L", "LG", "LRS", "ORS"].includes(f.modifierType) ||
        !Number.isInteger(op) ||
        op < -1 ||
        op > 8 ||
        !positive(target) ||
        !finite(value)
      )
        return false;
      if (["LG", "LRS", "ORS"].includes(f.modifierType)) {
        const extra = items(f.extras);
        if (!extra || !positive(number(extra[0]))) return false;
      }
    }
  }
  return true;
}
/** Reject type facts or modifier kinds the ordinary client simulation cannot represent. */
export function supportedDogmaFacts(value: unknown, typeIDs: readonly number[]): boolean {
  if (!obj(value) || value.available !== true || !obj(value.types) || !obj(value.effects))
    return false;
  for (const id of typeIDs) {
    const type = value.types[id];
    if (!obj(type) || !Array.isArray(type.attributes) || !Array.isArray(type.effects)) return false;
    for (const effectID of type.effects) {
      const effect = value.effects[effectID];
      if (!obj(effect) || !(effect.modifiers === null || Array.isArray(effect.modifiers)))
        return false;
      for (const m of effect.modifiers ?? []) {
        if (
          !obj(m) ||
          !allowedFunctions.has(m.func) ||
          !allowedDomains.has(m.domain) ||
          !positive(m.modifiedAttributeID) ||
          !positive(m.modifyingAttributeID) ||
          !Number.isInteger(m.operation) ||
          m.operation < -1 ||
          m.operation > 8 ||
          (["LocationGroupModifier"].includes(m.func) && !positive(m.groupID)) ||
          (["LocationRequiredSkillModifier", "OwnerRequiredSkillModifier"].includes(m.func) &&
            !positive(m.skillTypeID))
        )
          return false;
      }
    }
  }
  return true;
}
function droneBayQualification(
  required: number | null,
  capacity: number | null,
  simulated = false,
): DroneBayQualification {
  const reason =
    required === null
      ? "The storage volume of the selected drones is unavailable."
      : capacity === null
        ? "Drone bay capacity is unavailable for the reviewed hull."
        : required > capacity + 1e-6
          ? "The selected drones exceed the reviewed hull’s drone bay capacity."
          : null;
  return { required, capacity, reason, ...(simulated ? { simulated: true as const } : {}) };
}

type SimulationInput = {
  session: PilotSession;
  characterID: number;
  shipTypeID: number;
  fitData: readonly FitItem[];
  review: DroneBayReview;
  read: (path: string) => Promise<unknown>;
  current: () => void;
};

async function readDroneBay(
  input: SimulationInput,
  drones: readonly FitItem[],
): Promise<DroneBayQualification> {
  const { review, read, current, session } = input;
  const native = obj(review.droneBay) ? review.droneBay : null;
  let required = finite(native?.required) && native.required > 0 ? native.required : null;
  let capacity = finite(native?.capacity) && native.capacity >= 0 ? native.capacity : null;
  current();
  if (required === null) {
    const typeIDs = [...new Set(drones.map((drone) => drone.typeID))];
    const result = await read(`/api/types/volumes?typeIDs=${typeIDs.join(",")}`).catch(() => null);
    current();
    if (obj(result) && obj(result.volumes)) {
      let total = 0;
      for (const drone of drones) {
        const volume = result.volumes[drone.typeID];
        if (!finite(volume) || volume <= 0) {
          total = NaN;
          break;
        }
        total += volume * drone.quantity;
      }
      if (finite(total) && total > 0) required = total;
    }
  }
  // The current ship is only the reviewed hull when the fitting is already satisfied.
  const shipID =
    review.plan.mode === "ALREADY_SATISFIED" ? review.context.shipID : review.plan.targetHullID;
  if (capacity === null && positive(shipID)) {
    const result = await getShipBays(shipID, session.flow.requestOptions(), ["drone"]).catch(
      () => null,
    );
    current();
    const bays = Array.isArray(result?.bays)
      ? result.bays.filter((bay) => obj(bay) && bay.key === "drone")
      : [];
    const bay = bays.length === 1 && obj(bays[0]) ? bays[0] : null;
    // The panel can report used space without reporting capacity. Keep that distinct from a known zero.
    const value = obj(bay?.capacity) ? bay.capacity.capacity : null;
    if (
      result?.shipID === shipID &&
      finite(value) &&
      ((bay?.present === true && value > 0) || (bay?.present === false && value === 0))
    )
      capacity = value;
  }
  return droneBayQualification(required, capacity);
}

/** Before assembly: simulate only in the selected pilot's client store, with that pilot's loaded native brain. */
export async function simulatePilotResources(
  input: SimulationInput,
): Promise<ResourceQualification> {
  let droneBay: DroneBayQualification | undefined;
  const unknown = (reason: string): ResourceQualification => ({
    state: "UNKNOWN",
    reason,
    ...(droneBay ? { droneBay } : {}),
  });
  try {
    const { session, characterID, shipTypeID, fitData, current } = input;
    if (
      !positive(characterID) ||
      !positive(shipTypeID) ||
      !Array.isArray(fitData) ||
      !fitData.length ||
      fitData.some((i) => !positive(i.typeID) || !positive(i.flagID) || !positive(i.quantity))
    )
      return unknown("The selected fitting is incomplete.");
    const modules = fitData.filter((i) => isSlotFlag(i.flagID));
    if (
      fitData.some(
        (i) => !(isSlotFlag(i.flagID) || i.flagID === DRONE_BAY_FLAG || i.flagID === 5),
      ) ||
      modules.some((i) => i.quantity !== 1) ||
      new Set(modules.map((i) => i.flagID)).size !== modules.length
    )
      return unknown("The fitting contains unsupported or ambiguous equipment.");
    // Stored drones do not consume fitting resources. Qualify their volume separately.
    const simulatedFit = fitData.filter((i) => i.flagID !== DRONE_BAY_FLAG);
    if (simulatedFit.length !== fitData.length)
      droneBay = await readDroneBay(
        input,
        fitData.filter((i) => i.flagID === DRONE_BAY_FLAG),
      );
    current();
    await session.flow.loadFitting();
    current();
    await session.flow.loadDogma();
    current();
    const brain = session.store.dogma.get().allInfo;
    if (
      !brain ||
      Number(brain.characterID) !== characterID ||
      !positive(brain.character?.typeID) ||
      !supportedBrain(brain.charBrain)
    )
      return unknown("The held pilot's native skill/implant brain is incomplete or unsupported.");
    const typeIDs = [
      ...new Set([shipTypeID, brain.character.typeID, ...simulatedFit.map((i) => i.typeID)]),
    ];
    if (typeIDs.length > 50) return unknown("The fitting exceeds the simulation data limit.");
    const metadata = await input.read(`/api/client-data/dogma-types?typeIDs=${typeIDs.join(",")}`);
    current();
    if (!supportedDogmaFacts(metadata, typeIDs))
      return unknown("A fitting modifier or type is unsupported or unreadable.");
    await session.flow.simulateFitting({ shipTypeID, fitData: simulatedFit, name: null });
    current();
    const fitting = session.store.fitting.get(),
      sim = fitting.simulation;
    if (!sim || sim.shipTypeID !== shipTypeID)
      return unknown("The selected hull was not simulated.");
    for (const item of modules) {
      const found = sim.slots.find((slot) => slotFlagOf(slot.family, slot.index) === item.flagID);
      if (
        !found ||
        found.present === false ||
        found.module?.typeID !== item.typeID ||
        !Number.isInteger(sim.moduleStates[item.flagID]) ||
        sim.moduleStates[item.flagID]! < 1
      )
        return unknown("The complete selected module fit was not online in simulation.");
    }
    const cpu = sim.resources.cpu,
      powergrid = sim.resources.powergrid;
    if (
      !cpu?.known ||
      !powergrid?.known ||
      ![cpu.used, cpu.total, powergrid.used, powergrid.total].every(finite) ||
      cpu.used < 0 ||
      cpu.total <= 0 ||
      powergrid.used < 0 ||
      powergrid.total <= 0
    )
      return unknown("CPU or powergrid simulation is unreadable.");
    if (
      droneBay?.capacity === null &&
      ((input.review.plan.mode === "NEW_HULL" && input.review.plan.targetHullID === null) ||
        (input.review.plan.mode === "EXISTING_HULL" && positive(input.review.plan.targetHullID)))
    ) {
      // A packaged or unboarded candidate may not expose a live bay. The exact
      // pilot/hull/fit simulation reports the same attribute for that candidate.
      const bay = sim.stats?.bays.droneCapacity;
      if (bay?.known && finite(bay.value) && bay.value >= 0)
        droneBay = droneBayQualification(droneBay.required, bay.value, true);
    }
    return {
      state: "SIMULATED",
      characterID,
      shipTypeID,
      cpu: { used: cpu.used, total: cpu.total },
      powergrid: { used: powergrid.used, total: powergrid.total },
      fits: cpu.used <= cpu.total + 1e-6 && powergrid.used <= powergrid.total + 1e-6,
      source: "PILOT_BRAIN_CLIENT_SIMULATION",
      ...(droneBay ? { droneBay } : {}),
    };
  } catch (error) {
    input.current();
    return unknown(
      error instanceof Error ? error.message : "Pilot fitting simulation is unavailable.",
    );
  }
}

/** The native review authorizes Apply. Missing fitting-service display data is informational. */
export function nativeApplyBlockers(review: {
  canApply?: boolean;
  fittingService?: string;
  plan: {
    mode: string;
    shortages: readonly string[];
    unsupported: readonly string[];
    requiresFitting?: boolean;
  };
}): string[] {
  const alreadySatisfied = review.plan.mode === "ALREADY_SATISFIED";
  const reasons =
    alreadySatisfied && review.canApply === true
      ? []
      : [...review.plan.unsupported, ...review.plan.shortages];
  if (review.canApply !== true && !reasons.length)
    reasons.push("WC did not authorize the reviewed equipment plan.");
  if (
    !alreadySatisfied &&
    review.plan.requiresFitting !== false &&
    review.fittingService === "UNAVAILABLE"
  )
    reasons.push("Fitting service is unavailable at this dock.");
  return reasons;
}
/** Fresh ItemGetInfo after boarding: identity-bound native attributes; never substitute the simulation. */
export function decodeNativeFittingResources(
  raw: JsonValue,
  expected: { shipID: number; shipTypeID: number; characterID: number },
) {
  if (![expected.shipID, expected.shipTypeID, expected.characterID].every(positive)) return null;
  const inv = readKeyVal(raw, "invItem");
  if (
    readKeyVal(raw, "itemID") !== expected.shipID ||
    readRowField(inv, "itemID") !== expected.shipID ||
    readRowField(inv, "typeID") !== expected.shipTypeID ||
    readRowField(inv, "ownerID") !== expected.characterID
  )
    return null;
  const stamp = (v: JsonValue | undefined) => {
    if (typeof v === "number" && !Number.isSafeInteger(v)) return null;
    const wire: any = v;
    if (
      obj(wire) &&
      wire.type === "long" &&
      typeof wire.value === "number" &&
      !Number.isSafeInteger(wire.value)
    )
      return null;
    const n = exactInt(v);
    if (n === null || !/^\d+$/.test(n)) return null;
    const t = BigInt(n);
    return t > 116444736000000000n && t <= 9223372036854775807n ? n : null;
  };
  const timeFiletime = stamp(readKeyVal(raw, "time")),
    wallclockFiletime = stamp(readKeyVal(raw, "wallclockTime"));
  if (!timeFiletime || !wallclockFiletime) return null;
  const attr: any = readKeyVal(raw, "attributes");
  if (!obj(attr) || attr.type !== "dict" || !Array.isArray(attr.entries)) return null;
  const get = (id: number) => {
    const rows = attr.entries.filter(
      (entry: any) => Array.isArray(entry) && entry.length === 2 && number(entry[0]) === id,
    );
    if (rows.length !== 1) return null;
    const n = unwrapReal(rows[0][1]);
    return n !== null && finite(n) && n >= 0 ? n : null;
  };
  const cpuUsed = get(49),
    cpuTotal = get(48),
    gridUsed = get(15),
    gridTotal = get(11);
  if (
    cpuUsed === null ||
    cpuTotal === null ||
    gridUsed === null ||
    gridTotal === null ||
    cpuTotal <= 0 ||
    gridTotal <= 0
  )
    return null;
  return {
    state: "NATIVE" as const,
    shipID: expected.shipID,
    shipTypeID: expected.shipTypeID,
    characterID: expected.characterID,
    timeFiletime,
    wallclockFiletime,
    cpu: { used: cpuUsed, total: cpuTotal },
    powergrid: { used: gridUsed, total: gridTotal },
    fits: cpuUsed <= cpuTotal + 1e-6 && gridUsed <= gridTotal + 1e-6,
  };
}
