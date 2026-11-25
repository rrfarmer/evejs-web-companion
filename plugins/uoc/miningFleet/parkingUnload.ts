import { decodeFlightStatus, getFlightStatus } from "../../../web/src/plugin-api/flying.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { readNativeShipHolds } from "../shared/nativeInventory.ts";
import { createRawTypeFacts } from "./typeFacts.ts";
import { depositOwnShipRaw, type OwnShipRawSource } from "./dockedRawDeposit.ts";
import type { HaulDocument } from "./haulJournal.ts";
import { decodeFleetDelivery, type FleetDelivery } from "./delivery.ts";
export type ParkingFreightRemaining = { units: number; volumeM3: number };
/** WC74 RETURN_HOME_UNLOAD_DOCK: exact own stacks only, after native arrival. */
export async function unloadParkingFreight(
  run: Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">,
  session: PilotSession,
  config: {
    operationID: string;
    runID: string;
    shipID: number;
    delivery: FleetDelivery;
    document: HaulDocument;
    current: () => void;
    wholeStacks?: boolean;
    reconcileParking?: boolean;
    onRemaining?: (freight: ParkingFreightRemaining) => void;
  },
) {
  const { current, delivery } = config,
    options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch };
  const flight = async () => {
    current();
    const f = decodeFlightStatus((await getFlightStatus(options)).flight);
    current();
    if (
      !f.docked ||
      f.inSpace ||
      f.shipID !== config.shipID ||
      f.solarSystemID !== delivery.systemID ||
      (delivery.kind === "station"
        ? f.stationID !== delivery.destinationID
        : f.structureID !== delivery.destinationID) ||
      (f.transition && f.transition.phase !== "ready")
    )
      throw Error("Parking unload requires the exact native dock and ship.");
  };
  async function readFreight() {
    const rows = await readNativeShipHolds(session, current, run.characterID, config.shipID);
    const facts = rows.length
      ? await createRawTypeFacts(run, current)([...new Set(rows.map((r) => r.typeID))])
      : {};
    current();
    await flight();
    const freight = rows.filter((r) => {
      const f = facts[r.typeID];
      if (!f || (r.categoryID !== null && r.categoryID !== f.categoryID))
        throw Error("Parking hold type is unknown.");
      if (f.categoryID !== 25) return false;
      if (
        !(f.freightKind === "RAW" || f.freightKind === "COMPRESSED") ||
        !Number.isFinite(f.unitVolumeM3) ||
        f.unitVolumeM3 <= 0 ||
        ![5, 134, 181, 182].includes(r.flagID)
      )
        throw Error("Parking freight is not qualified for unload.");
      return true;
    });
    config.onRemaining?.(
      freight.reduce(
        (totals, row) => ({
          units: totals.units + row.quantity,
          volumeM3: totals.volumeM3 + row.quantity * facts[row.typeID]!.unitVolumeM3,
        }),
        { units: 0, volumeM3: 0 },
      ),
    );
    return freight;
  }
  await flight();
  const freight = await readFreight();
  const saved = config.document.read() as { identity?: unknown } | null;
  let source: OwnShipRawSource = {
    kind: "own-ship-freight",
    operationID: config.operationID,
    runID: config.runID,
    characterID: run.characterID,
    shipID: config.shipID,
    items: freight.map((r) => ({ itemID: r.itemID, typeID: r.typeID, quantity: r.quantity })),
  };
  if (saved !== null) {
    if (typeof saved?.identity !== "string") throw Error("Parking unload journal is unreadable.");
    let parts: unknown;
    try {
      parts = JSON.parse(saved.identity);
    } catch {
      throw Error("Parking unload identity is unreadable.");
    }
    if (
      !Array.isArray(parts) ||
      parts.length !== 6 ||
      !parts[0] ||
      parts[0].kind !== "own-ship-freight" ||
      parts[0].operationID !== config.operationID ||
      parts[0].runID !== config.runID ||
      parts[0].characterID !== run.characterID ||
      parts[0].shipID !== config.shipID ||
      JSON.stringify(parts[5]) !== JSON.stringify(decodeFleetDelivery(delivery))
    )
      throw Error("Parking unload journal belongs to another custody scope.");
    source = parts[0] as OwnShipRawSource;
  }
  if (!source.items.length) return null;
  let receipt;
  try {
    receipt = await depositOwnShipRaw(run, session, {
      source,
      freightKind: "ANY",
      destinationID: delivery.destinationID,
      ...(delivery.corporationID === null
        ? {}
        : { corporationID: delivery.corporationID, division: delivery.division! }),
      delivery,
      current,
      document: config.document,
      wholeStacks: config.wholeStacks,
      reconcileParking: config.reconcileParking,
    });
  } catch (error) {
    if (config.onRemaining) await readFreight().catch(() => {}); // Preserve the write or verification error.
    throw error;
  }
  if ((await readFreight()).length) throw Error("Parking unload resource hold is not empty.");
  return receipt;
}
