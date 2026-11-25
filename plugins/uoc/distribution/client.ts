import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import { capacity, checkedJournal, conversation, courier } from "./native.ts";
import { checkedInventory, type NativeInventoryRow } from "../shared/nativeInventory.ts";
import { readDictPairs, unwrapLong } from "../shared/wire.ts";
import type { DistributionEvidence } from "./fence.ts";

function quantityOf(rows: NativeInventoryRow[], typeID: number) {
  const quantity = rows.filter((r) => r.typeID === typeID).reduce((n, r) => n + r.quantity, 0);
  if (!Number.isSafeInteger(quantity)) throw new Error("Inventory quantity overflow.");
  return quantity;
}

/** Ordinary existing BFF bridge calls; run.fetch binds them to the held pilot. */
export function createNativeCourier(
  run: PluginRunContext,
  current: () => boolean,
  read: <T>(request: () => Promise<T>) => Promise<T>,
) {
  const get = async (path: string, init?: RequestInit): Promise<any> => {
    if (!current()) throw new Error("Distribution custody retired.");
    const response = await run.fetch(`${run.baseUrl}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.json().catch((error) => {
      if (response.ok) throw error;
      return null;
    });
    if (!current()) throw new Error("Distribution custody retired.");
    if (!response.ok || !body || body.ok === false)
      throw Object.assign(
        new Error(
          body?.message ??
            body?.refusal?.key ??
            body?.error ??
            `Distribution bridge read or action failed (${response.status}).`,
        ),
        { status: response.status, data: body },
      );
    return body;
  };
  const post = (path: string, body: unknown) =>
    get(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ask = async (service: string, method: string, args: unknown[], of?: number | "hangar") => {
    const response = await post("/api/bridge/call", {
      service,
      method,
      args,
      kwargs: null,
      pilot: true,
      ...(method === "DoAction" || (service === "invCache" && method === "InvalidateLocationCache")
        ? { confirm: true }
        : {}),
      ...(of === undefined ? {} : { of }),
    });
    if (response.ok !== true || response.service !== service || response.method !== method)
      throw new Error("Unexpected native call response.");
    return response.result ?? null;
  };
  async function flight() {
    const result = await read(() => get("/api/bridge/flight/status")),
      f = result.flight;
    if (
      !f ||
      typeof f !== "object" ||
      typeof f.docked !== "boolean" ||
      !Number.isSafeInteger(f.shipID) ||
      f.shipID <= 0 ||
      !Number.isSafeInteger(f.solarSystemID) ||
      f.solarSystemID <= 0 ||
      (f.docked &&
        !(Number.isSafeInteger(f.stationID) && f.stationID > 0) &&
        !(Number.isSafeInteger(f.structureID) && f.structureID > 0))
    )
      throw new Error("Pilot flight status is unreadable.");
    return {
      docked: f.docked,
      stationID: typeof f.stationID === "number" ? f.stationID : null,
      structureID: typeof f.structureID === "number" ? f.structureID : null,
      shipID: f.shipID as number,
      systemID: f.solarSystemID as number,
    };
  }
  async function shipCargoQuantity(f: Awaited<ReturnType<typeof flight>>, typeID: number) {
    await read(() => ask("invCache", "InvalidateLocationCache", [f.shipID]));
    const rows = checkedInventory(await read(() => ask("invbroker", "List", [5], f.shipID)));
    if (
      rows.some((r) => r.ownerID !== run.characterID || r.locationID !== f.shipID || r.flagID !== 5)
    )
      throw new Error("Inventory owner, location or row identity changed.");
    if ((await flight()).shipID !== f.shipID)
      throw new Error("Active ship changed during observation.");
    return quantityOf(rows, typeID);
  }
  async function journal() {
    const result = checkedJournal(
      await read(() => ask("agentMgr", "GetMyJournalDetails", [])),
      "missions",
    );
    if (!result) throw new Error("Native mission journal is unreadable.");
    return result;
  }
  async function dialogue(agentID: number, action: number | null = null) {
    const result = conversation(await ask("agentMgr", "DoAction", [action], agentID));
    if (!result) throw new Error("Agent conversation is unreadable.");
    return result;
  }
  async function agentBriefing(agentID: number) {
    return read(() => get(`/api/bridge/agents/${agentID}/briefing`));
  }
  async function briefing(agentID: number) {
    const result = await agentBriefing(agentID);
    if (!result.errors || Object.values(result.errors).some((e) => e !== null))
      throw new Error("Mission briefing is unreadable.");
    const value = courier(result.objective);
    if (!value) throw new Error("The mission is not a verified ordinary courier delivery.");
    if (value.missionState === 2) {
      const when = unwrapLong(
        readDictPairs(result.briefing).find(([key]) => key === "AcceptTimestamp")?.[1],
      );
      if (when === null || when <= 0n)
        throw Error("The accepted Delivery mission has no verifiable acceptance time.");
      value.acceptedAt = String(when);
    }
    return value;
  }
  async function agentRecord(agentID: number) {
    return (await read(() => get(`/api/bridge/agents/${agentID}/record`))).agent;
  }
  async function record(agentID: number) {
    const r = await agentRecord(agentID);
    if (
      !r ||
      r.agentID !== agentID ||
      r.divisionID !== 22 ||
      r.agentTypeID !== 2 ||
      !Number.isSafeInteger(r.level) ||
      r.level < 1 ||
      r.level > 4 ||
      !Number.isSafeInteger(r.stationID) ||
      r.stationID <= 0 ||
      !Number.isSafeInteger(r.solarSystemID) ||
      r.solarSystemID <= 0
    )
      throw Object.assign(new Error("Ordinary Distribution agent authority is unavailable."), {
        code: "AGENT_NOT_ORDINARY",
      });
    return r as {
      agentID: number;
      stationID: number;
      solarSystemID: number;
      level: number;
      corporationID: number;
    };
  }
  async function evidence(
    typeID?: number,
    {
      source,
      itemID,
      includeCapacity = false,
    }: { source?: "cargo" | "hangar"; itemID?: number; includeCapacity?: boolean } = {},
  ) {
    const j = await journal(),
      f = await flight();
    if (!f.docked || !f.stationID) throw new Error("Pilot is not docked at a known station.");
    let cargoQuantity: number | null = null,
      hangarQuantity: number | null = null,
      sourceItem: DistributionEvidence["sourceItem"] = null,
      hold: null | { capacity: number; used: number } = null;
    let cargo: NativeInventoryRow[] | null = null,
      hangar: NativeInventoryRow[] | null = null;
    if (typeID !== undefined) {
      // Client cache keys are (shipID,None) and (containerHangar,None), not stationID.
      await read(() => ask("invCache", "InvalidateLocationCache", [f.shipID]));
      await read(() => ask("invCache", "InvalidateLocationCache", [[10004, null]]));
      const [rawCargo, rawHangar, panel] = await Promise.all([
        read(() => ask("invbroker", "List", [5], f.shipID)),
        read(() => ask("invbroker", "List", [4], "hangar")),
        includeCapacity ? read(() => get("/api/bridge/inventory")) : null,
      ]);
      if (
        panel &&
        (panel.stationID !== f.stationID ||
          panel.activeShipID !== f.shipID ||
          panel.cargo?.shipID !== f.shipID ||
          panel.cargo?.error !== null)
      )
        throw new Error("Inventory owner or station is unreadable.");
      cargo = checkedInventory(rawCargo);
      hangar = checkedInventory(rawHangar);
      hold = panel ? capacity(panel.cargo.capacity) : null;
      const ids = new Set<number>();
      for (const [rows, location, flag] of [
        [cargo, f.shipID, 5],
        [hangar, f.stationID, 4],
      ] as const)
        for (const row of rows) {
          if (
            row.ownerID !== run.characterID ||
            row.locationID !== location ||
            row.flagID !== flag ||
            ids.has(row.itemID)
          )
            throw new Error("Inventory owner, location or row identity changed.");
          ids.add(row.itemID);
        }
      const after = await flight();
      if (
        !after.docked ||
        after.shipID !== f.shipID ||
        after.stationID !== f.stationID ||
        after.systemID !== f.systemID
      )
        throw new Error("Inventory scope changed during observation.");
      cargoQuantity = quantityOf(cargo, typeID);
      hangarQuantity = quantityOf(hangar, typeID);
      sourceItem = (source === "cargo" ? cargo : hangar).find((r) => r.itemID === itemID) ?? null;
    }
    return {
      proof: {
        journal: j,
        shipID: f.shipID,
        stationID: f.stationID,
        typeID: typeID ?? null,
        cargoQuantity,
        hangarQuantity,
        sourceItem,
      } satisfies DistributionEvidence,
      flight: f,
      cargo,
      hangar,
      hold,
    };
  }
  async function transfer(
    itemID: number,
    from: "cargo" | "hangar",
    to: "cargo" | "hangar",
    quantity: number,
  ) {
    const result = await post("/api/bridge/inventory/transfer", {
      itemIDs: [itemID],
      from: { kind: from },
      to: { kind: to },
      qty: quantity,
    });
    if (result.applied !== true) throw new Error("Transfer was not positively applied.");
  }
  return {
    flight,
    shipCargoQuantity,
    journal,
    dialogue,
    briefing,
    record,
    agentRecord,
    agentBriefing,
    evidence,
    transfer,
  };
}
