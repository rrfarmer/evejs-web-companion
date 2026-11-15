import { parse, stringify } from "yaml";
import type { InventoryItemRow } from "../store/types.ts";
import type { Ask } from "./ask.ts";
import { readKeyVal } from "./wire.ts";

export const INVENTORY_FILTERS_SETTING = "inventoryFilters";

// filterSvc.py ITEM_*, CRIT_* and RESULT_* values are persisted by the retail client.
export const FILTER_FIELD = {
  category: 1, group: 2, volume: 4, size: 5, assembled: 6, name: 7, price: 8,
  slot: 9, metaGroup: 10, metaLevel: 11, power: 12, cpu: 13, blueprintCopy: 14, clone: 15,
} as const;
export const FILTER_OP = {
  is: 3, isnt: 4, less: 5, equal: 6, greater: 7, starts: 8, notStarts: 9, contains: 10, notContains: 11,
} as const;
export const FILTER_MATCH = { all: 1, any: 2 } as const;
export type FilterComparison = string | number | boolean;
export type InventoryCondition = readonly [field: number, operator: number, value: FilterComparison];
export type InventoryFilter = readonly [name: string, match: 1 | 2, conditions: readonly InventoryCondition[]];

const F = FILTER_FIELD;
const O = FILTER_OP;

export const DEFAULT_INVENTORY_FILTERS = [
  ["UI/Inventory/FilterAmmunition", "Ammunition", 1, [[F.category, O.is, 8]]],
  ["UI/Inventory/FilterOreAndMaterials", "Ore and Materials", 2, [[F.category, O.is, 4], [F.category, O.is, 25], [F.group, O.is, 711], [F.group, O.is, 4918]]],
  ["UI/Inventory/FilterShipModules", "Ship Modules", 1, [[F.category, O.is, 7]]],
  ["UI/Inventory/FilterSkillbooks", "Skillbooks", 1, [[F.category, O.is, 16]]],
  ["UI/Inventory/FilterValuableItems", "Valuable Items", 1, [[F.price, O.greater, 100_000]]],
] as const;

function isCondition(row: unknown): row is InventoryCondition {
  if (!Array.isArray(row) || row.length !== 3 || !Number.isSafeInteger(row[0]) || !Number.isSafeInteger(row[1])) return false;
  const value = row[2];
  return typeof value === "string" || typeof value === "boolean" || Number.isFinite(value);
}

function isInventoryFilter(row: unknown): row is InventoryFilter {
  return Array.isArray(row) && row.length === 3 && typeof row[0] === "string" &&
    (row[1] === 1 || row[1] === 2) && Array.isArray(row[2]) && row[2].every(isCondition);
}

export function readInventoryFilters(text: string): readonly InventoryFilter[] {
  const rows: unknown = parse(text, { version: "1.1" });
  if (!Array.isArray(rows) || !rows.every(isInventoryFilter)) {
    throw new Error("Inventory filters could not be read.");
  }
  return rows;
}

export function writeInventoryFilters(filters: readonly InventoryFilter[]): string {
  return stringify(filters, { version: "1.1", directives: false, aliasDuplicateObjects: false });
}

const SHARED_ITEM_FILTER = 2;
type ItemFilterSettingKey = readonly [hash: string, sequence: number, type: typeof SHARED_ITEM_FILTER];

function itemFilterSettingKey(hash: unknown, sequence: unknown, type: unknown): ItemFilterSettingKey | null {
  return typeof hash === "string" && /^[0-9a-f]{40}$/.test(hash) && typeof sequence === "number" &&
    Number.isSafeInteger(sequence) && sequence > 0 && type === SHARED_ITEM_FILTER ? [hash, sequence, type] : null;
}

/** sharedSettings/client/link.py registers one scheme for settings. Inventory filters use type 2. */
export function parseInventoryFilterLink(url: string): ItemFilterSettingKey | null {
  const match = /^sharedSetting:([0-9a-f]{40})\/\/([0-9]+)\/\/2$/i.exec(url.trim());
  return match ? itemFilterSettingKey(match[1]?.toLowerCase(), Number(match[2]), SHARED_ITEM_FILTER) : null;
}

export async function shareInventoryFilter(act: Ask, filter: InventoryFilter): Promise<string> {
  const keyVal = await act("sharedSettingsMgr", "StoreSettingLinkAndGetID", [SHARED_ITEM_FILTER, filter]);
  const key = itemFilterSettingKey(readKeyVal(keyVal, "hashvalue"), readKeyVal(keyVal, "sqID"), readKeyVal(keyVal, "settingTypeID"));
  if (!key) throw new Error("The shared item filter could not be stored.");
  return `sharedSetting:${key.join("//")}`;
}

export async function readSharedInventoryFilter(ask: Ask, link: string): Promise<InventoryFilter> {
  const key = parseInventoryFilterLink(link);
  if (!key) throw new Error("Enter an EVE item-filter link.");
  const answer = await ask("sharedSettingsMgr", "GetStoredSharedSetting", [key]);
  const data: unknown = typeof answer === "string" ? parse(answer, { version: "1.1" }) : null;
  const filter: unknown = Array.isArray(data) ? data.find(row => Array.isArray(row) && row.length === 2 && row[0] === "filter")?.[1] : null;
  if (!isInventoryFilter(filter)) throw new Error("The shared item filter could not be read.");
  return filter;
}

export function addInventoryFilterTypes(conditions: readonly InventoryCondition[], names: readonly string[]): readonly InventoryCondition[] {
  const included = new Set(conditions.flatMap(([field, operator, value]) =>
    field === F.name && operator === O.is && typeof value === "string" ? [value] : []));
  const added: InventoryCondition[] = [];
  for (const name of names) {
    if (name && !included.has(name)) {
      included.add(name);
      added.push([F.name, O.is, name]);
    }
  }
  return [...conditions, ...added];
}

type FilterValue = FilterComparison | readonly number[] | null;

/** Extra type or item values use the same numeric ITEM_* keys as the saved criteria. */
export type InventoryFilterFacts = Readonly<Record<number, FilterValue>>;

/** eveFormat.RoundISK: the nearest three significant digits, capped to cents and millions. */
export function roundInventoryFilterPrice(price: number): number {
  if (price < 10) return Math.round(price * 100) / 100;
  const magnitude = Math.min(6, Math.floor(Math.log10(price)) - 2);
  const increment = 10 ** magnitude;
  return Number((Math.round(price / increment) * increment).toFixed(Math.max(0, -magnitude)));
}

function matchesCondition(own: FilterValue, operator: number, wanted: FilterComparison): boolean {
  if (typeof own === "string" && typeof wanted === "string") {
    const text = own.toLowerCase();
    const value = wanted.toLowerCase();
    switch (operator) {
      case O.is: return text === value;
      case O.isnt: return text !== value;
      case O.starts: return text.startsWith(value);
      case O.notStarts: return !text.startsWith(value);
      case O.contains: return text.includes(value);
      case O.notContains: return !text.includes(value);
      default: return false;
    }
  }
  const equal = Array.isArray(own) ? own.includes(wanted) : own === wanted;
  switch (operator) {
    case O.is:
    case O.equal: return equal;
    case O.isnt: return !equal;
    case O.less: return typeof own === "number" && typeof wanted === "number" && own < wanted;
    case O.greater: return typeof own === "number" && typeof wanted === "number" && own > wanted;
    default: return false;
  }
}

/** Undefined facts leave a condition pending. Null is a known missing value, such as a type with no average price. */
export function matchInventoryFilter(
  row: InventoryItemRow, name: string, filter: InventoryFilter, facts: InventoryFilterFacts = {},
): boolean | undefined {
  const values: InventoryFilterFacts = {
    [F.category]: row.categoryID, [F.group]: row.groupID, [F.size]: row.quantity,
    // The client's boolean test treats singleton 1 as true. A copy carries 2 and uses its own condition.
    [F.assembled]: row.singleton && row.blueprintCopy !== true, [F.blueprintCopy]: row.blueprintCopy === true,
    [F.name]: name, [F.volume]: row.volume == null ? null : row.volume * row.quantity, ...facts,
  };
  const matchAll = filter[1] === FILTER_MATCH.all;
  let pending = false;
  for (const [field, operator, wanted] of filter[2]) {
    const value = values[field];
    if (value === undefined) pending = true;
    else if (matchesCondition(value, operator, wanted) !== matchAll) return !matchAll;
  }
  return pending ? undefined : matchAll;
}
