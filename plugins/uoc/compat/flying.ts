import type { JsonValue } from "../../../web/src/plugin-api/index.ts";
import type { SpaceEntity } from "../../../web/src/plugin-api/blocks.ts";
import type { Ask } from "../../../web/src/plugin-api/flying.ts";
import { isListValue, readDictPairs, readKeyVal, readRowField, unwrapLong } from "../shared/wire.ts";

// These reads require Farmer to guard the held session and arm its deadline after lane admission.
export { bridgeAsk, getScriptObservation } from "../../../web/src/app/api.ts";

function record(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function preferredBays({ groupID, categoryID }: { groupID: number; categoryID: number }): readonly string[] {
  switch (groupID) {
    case 465: return ["ice", "ore"];
    case 423: case 1136: return ["fuel"];
    case 711: return ["gas", "ore"];
    case 18: return ["mineral"];
    case 754: return ["salvage"];
    case 1027: return ["commandCenter"];
  }
  switch (categoryID) {
    case 8: return ["ammo"];
    case 42: case 43: return ["planetary"];
    case 25: return ["ore", "asteroid"];
    default: return [];
  }
}

export function unwrapCachedResult(result: JsonValue): JsonValue {
  if (!record(result) || result.type !== "object") return result;
  const name = record(result.name) ? result.name.value : result.name;
  if (typeof name !== "string" || !name.endsWith("objectCaching.CachedMethodCallResult")) return result;
  const carrier = Array.isArray(result.args) ? result.args[1] : null;
  return record(carrier) && carrier.type === "substream" ? carrier.value ?? null : null;
}

export function decodeCorpAssetItems(raw: JsonValue) {
  const rows = unwrapCachedResult(raw);
  if (!record(rows) || !Array.isArray(rows.list)) return [];
  return rows.list.flatMap(row => {
    function number(key: string) {
      const value = readRowField(row, key);
      return typeof value === "number" && Number.isFinite(value) ? value : Number(unwrapLong(value) ?? 0);
    }
    const itemID = number("itemID");
    if (itemID <= 0) return [];
    const singleton = number("singleton") === 1, stacksize = number("stacksize"), quantity = number("quantity");
    const customInfo = readRowField(row, "customInfo");
    return [{ itemID, typeID: number("typeID"), ownerID: number("ownerID"), locationID: number("locationID"),
      flagID: number("flagID"), quantity, singleton, stacksize, units: singleton ? 1 : Math.max(0, stacksize || quantity),
      groupID: number("groupID"), categoryID: number("categoryID"), customInfo: typeof customInfo === "string" ? customInfo : "" }];
  });
}

export function isSessionChangeSettling(error: unknown): boolean {
  return record(error) && error.code === "SESSION_CHANGE_IN_PROGRESS";
}

export function droneRoleForGroup(group: string | null | undefined) {
  if (group == null) return null;
  switch (group.toLowerCase()) {
    case "combat drone": return "combat";
    case "mining drone": return "mining";
    case "salvage drone": return "salvage";
    case "logistic drone": return "logistic";
    default: return "other";
  }
}

type LootPilot = { characterID: number | null; corporationID: number | null; fleetID?: number | null; fleetMemberIDs?: readonly number[] | null };
type Container = SpaceEntity & { lootAbandoned?: boolean | null; protectedPropertyCorporationID?: number | null;
  protectedPropertyCorporationMarkerPresent?: boolean | null; lootRightCorpID?: number | null };

function positive(id: number | null | undefined): id is number {
  return typeof id === "number" && Number.isFinite(id) && id > 0;
}
// EveJS loot entitlement uses the owner ranges from idCheckers.IsNPC.
function playerCorp(id: number | null | undefined): id is number {
  return positive(id) && (id <= 10_000 || id >= 90_000_000);
}

export function lootRightsGrant(can: SpaceEntity, pilot: LootPilot): boolean {
  const rights = can.lootRights;
  if (!rights) return false;
  return rights.abandoned || (positive(pilot.characterID) && rights.ownerID === pilot.characterID)
    || (playerCorp(pilot.corporationID) && (rights.corpID === pilot.corporationID || rights.ownerID === pilot.corporationID))
    || (positive(pilot.fleetID) && rights.fleetID === pilot.fleetID);
}

export function isLootableContainer(can: Container, pilot: LootPilot): boolean {
  if (can.kind !== "container") return false;
  if (can.lootAbandoned === true) return true;
  const marked = can.protectedPropertyCorporationID, corp = pilot.corporationID;
  if (can.protectedPropertyCorporationMarkerPresent || positive(marked)) return playerCorp(marked) && marked === corp;
  const owner = can.ownerID;
  if (!positive(owner)) return false;
  const grantCorp = positive(can.lootRightCorpID) ? can.lootRightCorpID : can.corporationID;
  return owner === pilot.characterID || owner < 90_000_000 || (playerCorp(corp) && (owner === corp || grantCorp === corp))
    || lootRightsGrant(can, pilot) || !!pilot.fleetMemberIDs?.some(id => id === owner || (positive(can.characterID) && id === can.characterID));
}

// MCC repairs the quoted hull only. Quotes can also contain fitted modules and bay drones.
export async function quoteHullRepair(ask: Ask, shipID: number): Promise<{ cost: number | null } | null> {
  const raw = await ask("repairSvc", "GetRepairQuotes", [[shipID]]);
  for (const [key, value] of readDictPairs(raw)) {
    if (Number(key) !== shipID) continue;
    const nested = readKeyVal(value, "items") ?? (record(value) ? value.items : null);
    const rows = Array.isArray(value) || isListValue(value) ? value : nested;
    for (const row of Array.isArray(rows) ? rows : isListValue(rows) ? rows.items : []) {
      const field = (key: string) => readRowField(row, key) ?? (record(row) ? row[key] : undefined);
      const id = Number(field("itemID"));
      if (Number.isSafeInteger(id) && id > 0 && id !== shipID) continue;
      const damage = field("damage"), cost = field("cost"), unit = field("costToRepairOneUnitOfDamage");
      const numeric = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
      if (numeric(damage) && Math.ceil(damage) <= 0) continue;
      return { cost: numeric(cost) ? cost : numeric(damage) && numeric(unit) ? Math.ceil(damage) * unit : null };
    }
  }
  return null;
}

export async function repairQuotedHull(act: Ask, shipID: number, cost: number | null, dock: { stationID: number | null; structureID: number | null }) {
  if (dock.stationID !== null) {
    if (cost === null) throw Error("The repair shop did not say what that costs, so nothing was paid.");
    await act("repairSvc", "RepairItemsInStation", [[shipID], cost]);
  } else if (dock.structureID !== null) {
    await act("repairSvc", "RepairItemsInStructure", [[shipID]]);
  } else throw Error("You must be docked to use the repair shop.");
}
