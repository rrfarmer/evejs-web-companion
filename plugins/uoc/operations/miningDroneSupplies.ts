import { decodeDroneBay, decodeFlightStatus } from "../../../web/src/plugin-api/flying.ts";
import { fleetDronesInSpace } from "../miningFleet/droneRecall.ts";
import { stockSource } from "../provisioning/existingHull.ts";
import type { MiningSupplySource } from "../restored/mining/miningPreparation.ts";
import { checkedInventory } from "../shared/nativeInventory.ts";
import { readDictPairs, readRowField, unwrapLong, unwrapReal } from "../shared/wire.ts";

const droneFlag = 87;
const droneCapacityAttribute = 283;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const number = (value: unknown) => unwrapReal(value) ?? Number(unwrapLong(value) ?? NaN);

type Read = (path: string, body?: unknown) => Promise<any>;
type DroneTarget = { typeID: number; target: number };

function fittingDrones(operational: unknown): DroneTarget[] {
  if (!Array.isArray(operational)) return [];
  return operational.flatMap(([flag, typeID, quantity]) => {
    if (flag !== droneFlag) return [];
    if (!positive(typeID) || !positive(quantity))
      throw Error("Saved fitting drone quantities are unreadable.");
    return [{ typeID, target: quantity }];
  });
}

/** Top up only the drones specified by the reviewed fit of the currently held hull. */
export async function prepareMiningDroneSupplies(
  read: Read,
  review: any,
  source: MiningSupplySource,
  beforeTransfer?: () => void,
) {
  const targets = fittingDrones(review.contract?.operational);
  const scope: { shipID: number; shipTypeID: number; locationID: number } = review.context;
  if (!targets.length || scope.shipTypeID !== review.contract.shipTypeID)
    return { targets: [], issues: [] };

  async function dock() {
    const { flight } = await read("/api/bridge/flight/status");
    const state = decodeFlightStatus(flight);
    if (
      state.shipID !== scope.shipID ||
      state.docked !== true ||
      state.stationID !== scope.locationID ||
      !positive(state.solarSystemID) ||
      (state.transition && state.transition.phase !== "ready")
    )
      throw Error("The active ship or preparation station changed.");
  }

  const invalidate = (locationID: number) =>
    read("/api/bridge/call", {
      service: "invCache",
      method: "InvalidateLocationCache",
      args: [locationID],
      pilot: true,
      confirm: true,
    });

  async function drones(refresh = false) {
    if (refresh) await invalidate(scope.shipID);
    const raw = await read("/api/bridge/drones");
    const bay = decodeDroneBay(raw.bay);
    const out = fleetDronesInSpace(raw.inSpace);
    if (
      raw.activeShipID !== scope.shipID ||
      raw.errors?.bay !== null ||
      raw.errors?.inSpace !== null ||
      !Array.isArray(raw.bay) ||
      !bay ||
      bay.length !== raw.bay.length ||
      raw.bay.some((row: { quantity?: unknown } | null) => {
        const quantity = number(row?.quantity);
        return !positive(quantity) && ![-1, -2].includes(quantity);
      }) ||
      !out
    )
      throw Error("The held ship's drones could not be verified.");

    const inside = new Set(bay.map((row) => row.itemID));
    const aboard = bay.map(({ typeID, quantity }) => ({
      typeID,
      quantity: quantity < 0 ? 1 : quantity,
    }));
    for (const drone of out) {
      if (!drone.controlled || inside.has(drone.itemID)) continue;
      if (drone.typeID === null)
        throw Error("A drone controlled by the held ship has no verified type.");
      aboard.push({ typeID: drone.typeID, quantity: 1 });
    }

    const ship = readDictPairs(raw.shipInfo).find(([id]) => number(id) === scope.shipID)?.[1];
    const attributes = readDictPairs(readRowField(ship, "attributes"));
    const capacity = number(attributes.find(([id]) => number(id) === droneCapacityAttribute)?.[1]);
    return { aboard, capacity };
  }

  const count = (aboard: Awaited<ReturnType<typeof drones>>["aboard"], typeID: number) =>
    aboard.reduce((total, row) => total + (row.typeID === typeID ? row.quantity : 0), 0);
  await dock();
  let state = await drones();
  if (targets.every((target) => count(state.aboard, target.typeID) >= target.target))
    return { targets: [], issues: [] };

  const typeIDs = [...new Set([...targets, ...state.aboard].map((row) => row.typeID))];
  const { names } = await read("/api/names", {
    items: targets.map(({ typeID }) => ({ kind: "type", id: typeID })),
  });
  const label = (typeID: number) => names?.["type:" + typeID] ?? "Type " + typeID;
  const { pin } = review.source;
  const from = stockSource(review);
  const office = from.kind === "corp" ? /^corpOffice:(\d+)$/.exec(pin.office)?.[1] : undefined;
  const inventory = from.kind === "hangar" ? "hangar" : Number(office);
  if (
    from.kind !== source.kind ||
    (from.kind === "corp" &&
      (source.kind !== "corp" ||
        source.division !== from.division ||
        source.corporationID !== pin.ownerID ||
        !positive(inventory)))
  )
    throw Error("The stock location differs from the selected drone supply source.");
  if (typeof inventory === "number") await invalidate(inventory);
  else if (positive(pin.locationID)) await invalidate(pin.locationID);
  const rawStock = await read("/api/bridge/call", {
    service: "invbroker",
    method: "List",
    args: [],
    kwargs: { flag: pin.flag },
    of: inventory,
    pilot: true,
  });
  const stock = checkedInventory(rawStock.result);
  if (stock.some((row) =>
    row.ownerID !== pin.ownerID || row.locationID !== pin.locationID || row.flagID !== pin.flag,
  ))
    throw Error("The drone stock inventory scope could not be verified.");
  const available = new Map(targets.map(({ typeID }) => [typeID, count(stock, typeID)]));
  const issues: string[] = [];

  if (
    beforeTransfer &&
    review.canApply === true &&
    review.source.access.take === true &&
    targets.some(({ typeID, target }) => count(state.aboard, typeID) < target && available.get(typeID))
  ) {
    const facts = await read("/api/types/volumes?typeIDs=" + typeIDs.join(","));
    const volume = (id: number) => {
      const value = facts.volumes?.[id];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
        throw Error("The volume of " + label(id) + " could not be verified.");
      return value;
    };
    async function freeRoom() {
      // Use the held hull's Dogma attribute. The bays API can fall back to type
      // data for capacity, but its usage read still limits what we can move.
      if (!Number.isFinite(state.capacity) || state.capacity < 0 || facts.capped)
        throw Error("The active ship's effective Drone Bay capacity could not be verified.");
      const result = await read(`/api/bridge/ship/${scope.shipID}/bays?keys=drone`);
      const bay = Array.isArray(result.bays)
        ? result.bays.find((row: { key?: unknown } | null) => row?.key === "drone")
        : null;
      const used = number(bay?.capacity?.used);
      if (
        result.shipID !== scope.shipID ||
        result.activeShipID !== scope.shipID ||
        bay?.error !== null ||
        !Number.isFinite(used) ||
        used < 0
      )
        throw Error("The active ship's Drone Bay usage could not be verified.");
      // GetCapacity can already include the returning flight. Count its volume
      // only once, and keep any reservation that the bay read reports.
      const reserved = state.aboard.reduce((used, row) => used + row.quantity * volume(row.typeID), 0);
      return Math.max(0, state.capacity - Math.max(reserved, used));
    }
    state = await drones(true);
    for (const target of targets) {
      for (const stack of stock.filter((row) => row.typeID === target.typeID)) {
        const current = count(state.aboard, target.typeID);
        if (current >= target.target) break;
        const fit = Math.floor(await freeRoom() / volume(target.typeID) + 1e-7);
        const wanted = Math.min(target.target - current, stack.quantity);
        const qty = Math.min(wanted, fit);
        if (qty <= 0) {
          issues.push("Drone Bay has no room for more " + label(target.typeID) + ".");
          break;
        }
        if (qty < wanted)
          issues.push("Drone Bay has room for only " + qty + " more " + label(target.typeID) + ".");
        await dock();
        beforeTransfer();
        let failure: unknown, applied: boolean | undefined;
        try {
          // This is the same docked transfer used by Ship Provisioning. The
          // route's expectedScope option requires a ship in space.
          applied = (await read("/api/bridge/inventory/transfer", {
            itemIDs: [stack.itemID], qty, from,
            to: { kind: "shipBay", bay: "drone" },
          })).applied;
        } catch (error) {
          failure = error;
        }
        await dock();
        state = await drones(true);
        const gained = count(state.aboard, target.typeID) - current;
        const refusal = failure as { code?: string; status?: number } | undefined;
        const stackGone = refusal?.status === 409 && refusal.code === "ITEMS_NOT_AT_SOURCE";
        if (gained === 0 && (applied === false || stackGone)) {
          if (stackGone) available.set(target.typeID, (available.get(target.typeID) ?? 0) - stack.quantity);
          else issues.push("The inventory declined the transfer of " + label(target.typeID) + ".");
          continue;
        }
        if (gained !== qty)
          throw Error("The transfer of " + label(target.typeID) + " could not be confirmed. Check the Drone Bay.", {
            cause: failure,
          });
        available.set(target.typeID, (available.get(target.typeID) ?? 0) - gained);
        if (qty < wanted) break;
      }
    }
  }

  return {
    targets: targets.map(({ typeID, target }) => {
      const current = count(state.aboard, typeID);
      const deficit = Math.max(0, target - current);
      return {
        typeID, name: label(typeID), target, current, deficit, available: available.get(typeID) ?? 0,
        mode: "TOTAL_ABOARD" as const, eligibleFlags: [droneFlag], required: false,
        state: deficit === 0 ? "FULL" : current === 0 ? "MISSING" : "LOW",
      };
    }),
    issues,
  };
}
