import { FILTER_FIELD as F, type InventoryFilterFacts } from "../bridge/inventoryFilters.ts";
import { fetchTypeDogma, getTypeMeta, loadTypeEffects, type ApiOptions } from "./api.ts";

const POWER_ATTRIBUTE = 30;
const CPU_ATTRIBUTE = 50;
export const TYPE_FILTER_FIELDS: ReadonlySet<number> = new Set([F.slot, F.metaGroup, F.metaLevel, F.power, F.cpu]);

/** Inventory FilterSvc.GetValue reads static dogma and the type's meta records for ordinary items. */
export async function loadInventoryFilterFacts(
  typeIDs: readonly number[], fields: ReadonlySet<number>, options: ApiOptions,
): Promise<ReadonlyMap<number, InventoryFilterFacts>> {
  const result = new Map<number, InventoryFilterFacts>();
  const attributes = [...(fields.has(F.power) ? [POWER_ATTRIBUTE] : []), ...(fields.has(F.cpu) ? [CPU_ATTRIBUTE] : [])];
  for (let start = 0; start < typeIDs.length; start += 100) {
    const ids = typeIDs.slice(start, start + 100);
    const [effects, meta, dogma] = await Promise.all([
      fields.has(F.slot) ? loadTypeEffects(ids, options) : null,
      fields.has(F.metaGroup) || fields.has(F.metaLevel) ? getTypeMeta(ids, options) : null,
      attributes.length ? fetchTypeDogma(ids, attributes, options) : null,
    ]);
    for (const typeID of ids) {
      const type = meta?.types.get(typeID);
      const values = dogma?.[typeID];
      const typeEffects = effects?.[typeID];
      const facts: Record<number, InventoryFilterFacts[number]> = {};
      if (typeEffects) facts[F.slot] = typeEffects;
      if (type) {
        const tech = Math.trunc(type.techLevel || 1);
        facts[F.metaGroup] = Math.trunc(type.metaGroupID || (tech === 3 ? 14 : tech));
        facts[F.metaLevel] = Math.trunc(type.metaLevel || 0);
      }
      if (values) {
        if (fields.has(F.power)) facts[F.power] = Math.trunc(values[POWER_ATTRIBUTE] ?? 0);
        if (fields.has(F.cpu)) facts[F.cpu] = Math.trunc(values[CPU_ATTRIBUTE] ?? 0);
      }
      result.set(typeID, facts);
    }
  }
  return result;
}
