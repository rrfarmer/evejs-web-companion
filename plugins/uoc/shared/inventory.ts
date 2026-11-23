// Strict inventory proof from WC75 web/src/bridge/inventoryShip.ts; presentation decoding uses the stable plugin API.
import { decodeInventoryRows } from "../../../web/src/plugin-api/flying.ts";
import { isListValue, type JsonValue } from "./wire.ts";
import type { InventoryItemRow } from "./types.ts";
function unwrapRowList(result: JsonValue): JsonValue {
 if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
 const obj = result as {type?:unknown;header?:unknown;args?:unknown};
 if (obj.type === "objectex1" && Array.isArray(obj.header)) { const header = obj.header as readonly JsonValue[]; const token = header[0] as {value?:unknown} | undefined; if (token && token.value === "__builtin__.set" && Array.isArray(header[1])) return (header[1] as readonly JsonValue[])[0] ?? {type:"list",items:[]}; }
 if (obj.type === "object" && Array.isArray(obj.args)) return (obj.args as readonly JsonValue[])[0] ?? {type:"list",items:[]};
 return result;
}
export function decodeInventoryRowsChecked(result: JsonValue, volumes?: Readonly<Record<string, number>>): InventoryItemRow[] | null {
 const list = unwrapRowList(result); if (!isListValue(list)) return null;
 if (list !== result && typeof result === "object" && result !== null && !Array.isArray(result)) {
  const raw = result as Record<string, JsonValue>;
  if (raw.type === "objectex1" && (!Array.isArray(raw.header) || !Array.isArray(raw.header[1]) || raw.header[1].length !== 1)) return null;
  if (raw.type === "object" && (!Array.isArray(raw.args) || raw.args.length !== 1)) return null;
 }
 const rows = decodeInventoryRows(result, volumes);
 return rows.length === list.items.length && rows.every(row => Number.isSafeInteger(row.itemID) && row.itemID > 0 && Number.isSafeInteger(row.typeID) && row.typeID > 0 && Number.isSafeInteger(row.quantity) && row.quantity > 0) ? rows : null;
}
