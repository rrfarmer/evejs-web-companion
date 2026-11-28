import { decodeFlightStatus, officeAt } from "../../../web/src/plugin-api/flying.ts";
import { decodeCorpAssetItems } from "../compat/flying.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { readMiningOfficeAccess } from "../miningFleet/corporateOffice.ts";
import { checkedInventory, corpDivisionFlag } from "../shared/nativeInventory.ts";
import type { JsonValue } from "../shared/wire.ts";
import {
  counts,
  positive,
  type Bay,
  type Load,
  type Office,
  type Stack,
  type Stock,
  type Volumes,
} from "./model.ts";
import type { Leg, TransferProof } from "./store.ts";

type NativeMove = {
  leg: Leg;
  office: Office;
  line: Load;
  source: Stack;
  shipID: number;
  corporationID: number;
};
type MoveResult =
  | { kind: "confirmed"; quantity: number; keptID: boolean }
  | { kind: "refused"; reason: string; unchanged?: true }
  | { kind: "unknown"; reason: string };
type TransferOutcome = {
  error?: string;
  transferStatus?: string;
  sourceChange?: number;
  totalSourceChange?: number;
  destinationChange?: number;
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

class NativeRefusal extends Error {
  readonly outcome: TransferOutcome;
  constructor(message: string, outcome: TransferOutcome) {
    super(message);
    this.outcome = outcome;
  }
}

export function proofBefore(
  source: Stack,
  allSource: readonly Stack[],
  target: readonly Stack[],
): TransferProof {
  return {
    sourceID: source.itemID,
    sourceStack: source.quantity,
    sourceTotal: counts(allSource)[source.typeID] ?? 0,
    targetRows: target
      .filter((row) => row.typeID === source.typeID)
      .map(({ itemID, typeID, quantity }) => ({ itemID, typeID, quantity })),
  };
}

export function addedToBay(
  before: TransferProof,
  after: readonly Stack[],
  line: Load,
  quantity: number,
) {
  const target = after.filter((row) => row.typeID === line.typeID);
  const added = target.filter(
    (row) =>
      row.quantity !== (before.targetRows.find((old) => old.itemID === row.itemID)?.quantity ?? 0),
  );
  if (
    added.length !== 1 ||
    before.targetRows.some(
      (old) => !target.some((row) => row.itemID === old.itemID && row.quantity >= old.quantity),
    )
  )
    return null;
  const row = added[0]!;
  const gain =
    row.quantity - (before.targetRows.find((old) => old.itemID === row.itemID)?.quantity ?? 0);
  return gain === quantity && (!line.singleton || row.itemID === before.sourceID)
    ? { itemID: row.itemID, quantity }
    : null;
}

export function observedTransfer(
  before: TransferProof,
  afterSource: readonly Stack[],
  afterTarget: readonly Stack[],
  line: Load,
) {
  const source = afterSource.find((row) => row.itemID === before.sourceID);
  const quantity = before.sourceStack - (source?.quantity ?? 0);
  if (
    (source && source.typeID !== line.typeID) ||
    !positive(quantity) ||
    quantity > line.quantity ||
    (counts(afterSource)[line.typeID] ?? 0) !== before.sourceTotal - quantity
  )
    return null;
  return addedToBay(before, afterTarget, line, quantity);
}

function officeAssetCount(result: JsonValue): number | null {
  const reply = result as {
    type?: string;
    name?: string | { value?: string };
    args?: unknown;
    list?: unknown;
  } | null;
  const name = typeof reply?.name === "string" ? reply.name : reply?.name?.value;
  let rowset: { list?: unknown } | null | undefined = reply;
  if (
    reply?.type === "object" &&
    typeof name === "string" &&
    name.endsWith("objectCaching.CachedMethodCallResult")
  ) {
    const carrier = (Array.isArray(reply.args) ? reply.args[1] : null) as {
      type?: string;
      value?: { list?: unknown };
    } | null;
    rowset = carrier?.type === "substream" ? carrier.value : null;
  }
  return Array.isArray(rowset?.list) ? rowset.list.length : null;
}

export function createDistributionNative(
  run: PluginRunContext,
  session: PilotSession,
  current: () => void,
) {
  const { flying } = session.flow;
  const json = async (path: string, body?: unknown) => {
    current();
    const response = await run.fetch(
      new URL(path, run.baseUrl),
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    const data = await response.json();
    current();
    if (!response.ok || data?.ok !== true)
      throw new NativeRefusal(
        data?.message ?? data?.error ?? "The game did not confirm this request.",
        data ?? {},
      );
    return data;
  };

  const flight = async () => {
    const raw = (await json("/api/bridge/flight/status")).flight;
    const f = decodeFlightStatus(raw),
      pilot = session.store.station.get().online;
    if (
      pilot?.characterID !== run.characterID ||
      !positive(pilot.corporationID) ||
      !positive(f.shipID) ||
      !positive(raw.shipTypeID) ||
      !positive(f.solarSystemID)
    )
      throw Error("The pilot's current ship, corporation or location is unavailable.");
    return {
      f,
      corporationID: pilot.corporationID,
      shipID: f.shipID,
      shipTypeID: raw.shipTypeID as number,
      locationID:
        f.docked && (!f.transition || f.transition.phase === "ready")
          ? (f.structureID ?? f.stationID)
          : null,
    };
  };

  const bays = async (shipID: number, keys: readonly string[]) => {
    const p = await json(
      "/api/bridge/ship/" + shipID + "/bays?keys=" + encodeURIComponent(keys.join(",")),
    );
    if (p.activeShipID !== shipID || p.shipID !== shipID || !Array.isArray(p.bays))
      throw Error("The hauler's current holds are unavailable.");
    const rows: Record<string, Stock[]> = {};
    const volumes: Bay[] = [];
    const unreadable = new Set(keys);
    for (const bay of p.bays) {
      if (bay.present === false && !bay.error) unreadable.delete(bay.key);
      if (
        bay.present !== true ||
        bay.error ||
        !keys.includes(bay.key) ||
        !Array.isArray(bay.items) ||
        !Number.isFinite(bay.capacity?.capacity) ||
        !Number.isFinite(bay.capacity?.used) ||
        bay.capacity.capacity <= 0 ||
        bay.capacity.used < 0 ||
        !bay.items.every(
          (row: Stack) => positive(row?.itemID) && positive(row.typeID) && positive(row.quantity),
        )
      )
        continue;
      rows[bay.key] = bay.items;
      volumes.push({ key: bay.key, capacity: bay.capacity.capacity, used: bay.capacity.used });
      unreadable.delete(bay.key);
    }
    if (!volumes.length) throw Error("The required ship holds could not be read.");
    return { rows, volumes, unreadable: [...unreadable] };
  };

  const officeIDAt = async (office: Office) => {
    current();
    const id = await officeAt(flying.bridgeAsk, office.destinationID);
    current();
    if (!positive(id))
      throw Error(
        "The corporation has no verified office at " + (office.name ?? "the selected dock") + ".",
      );
    return id;
  };

  const checkDock = async (office: Office, corporationID: number, shipID: number) => {
    const at = await flight();
    const dock = office.kind === "station" ? at.f.stationID : at.f.structureID;
    if (
      at.locationID !== office.destinationID ||
      dock !== office.destinationID ||
      at.f.solarSystemID !== office.systemID ||
      at.corporationID !== corporationID ||
      at.shipID !== shipID
    )
      throw Error(
        "The assigned ship must be docked at " +
          (office.name ?? "the selected location") +
          " to read freight.",
      );
  };
  const local = async (
    office: Office,
    corporationID: number,
    shipID: number,
    take: boolean,
  ): Promise<Stock[]> => {
    await checkDock(office, corporationID, shipID);
    const accessAt = await readMiningOfficeAccess(
      { characterID: run.characterID, corporationID },
      [office.destinationID],
      json,
      (method, args) => flying.bridgeAsk("corpRegistry", method, args ?? []),
    );
    const access = accessAt(office.destinationID);
    if (!access.officeAvailable)
      throw Error("The corporation has no office at " + (office.name ?? "the selected dock") + ".");
    if (
      !access.divisions.some(
        (division) =>
          division.division === office.division && division.query && (!take || division.take),
      )
    )
      throw Error(
        "Division " +
          office.division +
          " at " +
          (office.name ?? "the selected dock") +
          " requires " +
          (take ? "Query and Take" : "Query") +
          " access.",
      );

    const officeID = await officeIDAt(office),
      flag = corpDivisionFlag(office.division);
    await flying.bridgeDo("invCache", "InvalidateLocationCache", [officeID]);
    current();
    const raw = (await flying.bridgeAsk("invbroker", "List", [], { flag }, officeID)) as any;
    current();
    const rows = checkedInventory(raw);
    if (
      rows.some(
        (row) =>
          row.flagID !== flag || row.ownerID !== corporationID || row.locationID !== officeID,
      )
    )
      throw Error("The game returned a different division inventory.");
    const items = (raw.type === "objectex1" ? raw.header[1][0] : raw).items;
    return rows.map((row, index) => {
      const native = items[index]?.fields ?? items[index];
      return {
        itemID: row.itemID,
        typeID: row.typeID,
        quantity: row.quantity,
        categoryID: row.categoryID ?? 0,
        groupID: positive(native?.groupID) ? native.groupID : 0,
        singleton: native?.singleton === 1 || native?.singleton === true || native?.quantity < 0,
      };
    });
  };

  const remote = async (office: Office, corporationID: number): Promise<Stock[]> => {
    const officeID = await officeIDAt(office);
    const raw = await flying.bridgeAsk("corpmgr", "GetAssetInventoryForLocation", [
      corporationID,
      office.destinationID,
      "offices",
    ]);
    current();
    const length = officeAssetCount(raw),
      rows = decodeCorpAssetItems(raw);
    if (length === null || rows.length !== length)
      throw Error("The remote office inventory could not be verified.");
    return rows
      .filter(
        (row) =>
          row.locationID === officeID &&
          row.ownerID === corporationID &&
          row.flagID === corpDivisionFlag(office.division),
      )
      .map((row) => {
        if (!positive(row.itemID) || !positive(row.typeID) || !positive(row.units))
          throw Error("Corporate stack quantity is unreadable.");
        return {
          itemID: row.itemID,
          typeID: row.typeID,
          quantity: row.units,
          singleton: row.singleton,
          categoryID: row.categoryID,
          groupID: row.groupID,
        };
      });
  };

  const volumes = async (stock: readonly Stock[]): Promise<Volumes> => {
    const ids = [...new Set(stock.map((row) => row.typeID))],
      found: Volumes = {};
    for (let i = 0; i < ids.length; i += 40) {
      const group = ids.slice(i, i + 40),
        value = await json("/api/types/volumes?typeIDs=" + group.join(","));
      if (value.capped) throw Error("Item volumes could not be read.");
      for (const id of group) {
        const assembled = value.volumes?.[id],
          packaged = value.packaged?.[id];
        found[id] = {
          assembled:
            typeof assembled === "number" && Number.isFinite(assembled) && assembled >= 0
              ? assembled
              : null,
          packaged:
            typeof packaged === "number" && Number.isFinite(packaged) && packaged >= 0
              ? packaged
              : null,
        };
      }
    }
    return found;
  };

  const move = async (m: NativeMove): Promise<MoveResult> => {
    const corp = { kind: "corp", division: m.office.division };
    const ship = m.line.bay === "cargo" ? { kind: "cargo" } : { kind: "shipBay", bay: m.line.bay };
    // WC's expectedScope is for in-space transfers. At a dock the haul contract
    // pins the office and stack, and we verify the Bot Host ship before calling it.
    try {
      await checkDock(m.office, m.corporationID, m.shipID);
    } catch (error) {
      return { kind: "refused", reason: message(error) };
    }
    try {
      const result = await json("/api/bridge/inventory/transfer", {
        itemIDs: [m.source.itemID],
        qty: m.line.quantity,
        from: m.leg === "pickup" ? corp : ship,
        to: m.leg === "pickup" ? ship : corp,
        haulContract: {
          stationID: m.office.destinationID,
          locationKind: m.office.kind,
          corporationID: m.corporationID,
          division: m.office.division,
          typeID: m.line.typeID,
          sourceQuantity: m.source.quantity,
        },
      });
      if (result.transferStatus === "SUCCESS" && result.applied === true)
        return {
          kind: "confirmed",
          quantity: m.line.quantity,
          keptID: result.moved?.includes(m.source.itemID) === true,
        };
      return { kind: "unknown", reason: "The transfer response did not confirm the freight." };
    } catch (error) {
      if (error instanceof NativeRefusal) {
        const { transferStatus, sourceChange, totalSourceChange, destinationChange } =
          error.outcome;
        if (
          error.outcome.error === "HAUL_TRANSFER_UNCONFIRMED" &&
          transferStatus === "PARTIAL" &&
          positive(sourceChange) &&
          sourceChange < m.line.quantity &&
          sourceChange === totalSourceChange &&
          sourceChange === destinationChange
        )
          return { kind: "confirmed", quantity: sourceChange, keptID: false };
        if (error.outcome.error === "HAUL_TRANSFER_UNCONFIRMED" && transferStatus === "REFUSED")
          return { kind: "refused", reason: message(error), unchanged: true };
        if (
          [
            "INVALID_HAUL_CONTRACT",
            "HAUL_SOURCE_CHANGED",
            "ITEMS_NOT_AT_SOURCE",
            "INVENTORY_SHIP_CHANGED",
            "INVENTORY_LOCATION_CHANGED",
          ].some((code) => code === error.outcome.error)
        )
          return { kind: "refused", reason: message(error) };
      }
      return { kind: "unknown", reason: message(error) };
    }
  };

  return { flight, bays, local, remote, volumes, move };
}

export type DistributionNative = ReturnType<typeof createDistributionNative>;
