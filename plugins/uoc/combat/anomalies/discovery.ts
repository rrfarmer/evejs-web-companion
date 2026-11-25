import { unwrapLong, unwrapReal } from "../../shared/wire.ts";
export interface CombatCatalogEntry {
  readonly dungeonID: number;
  readonly enabled: boolean;
  readonly entryRoomID: number;
  readonly difficulty?: number;
  readonly typeGroups: Readonly<Record<string, number>>;
}
export interface CombatSite {
  readonly systemID: number;
  readonly scannerKey: number;
  readonly instanceID: number;
  readonly dungeonID: number;
  readonly label: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly observedAt: number;
}
const integer = (v: unknown): number | null => {
  const n = unwrapLong(v as never);
  return n !== null && n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
};
const number = (v: unknown) => {
  const n = unwrapReal(v as never);
  return n !== null && Number.isFinite(n) ? n : null;
};
function dict(v: any) {
  if (!v || v.type !== "dict" || !Array.isArray(v.entries))
    throw Error("Native scanner dictionary is unreadable.");
  const result = new Map<unknown, unknown>();
  for (const row of v.entries) {
    if (!Array.isArray(row) || row.length !== 2 || result.has(row[0]))
      throw Error("Native scanner dictionary is ambiguous.");
    result.set(row[0], row[1]);
  }
  return result;
}
function keyval(v: any) {
  if (!v || v.type !== "object" || v.name !== "util.KeyVal")
    throw Error("Native site entry is unreadable.");
  return dict(v.args);
}
function seq(v: any) {
  return Array.isArray(v)
    ? v
    : v && (v.type === "list" || v.type === "tuple") && Array.isArray(v.items)
      ? v.items
      : null;
}
function position(v: unknown) {
  const a = seq(v);
  if (!a || a.length !== 3) throw Error("Native site position is unreadable.");
  const [x, y, z] = a.map(number);
  if (
    x === null ||
    y === null ||
    z === null ||
    x === undefined ||
    y === undefined ||
    z === undefined
  )
    throw Error("Native site position is unreadable.");
  return { x, y, z };
}
/** Scanner identifies a candidate; only the post-warp keeper can prove its native instance. */
export function decodeCombatSites(
  scan: unknown,
  systemID: number,
  observedAt: number,
  catalog: readonly CombatCatalogEntry[],
): CombatSite[] {
  if (
    !integer(systemID) ||
    !Number.isFinite(observedAt) ||
    observedAt <= 0 ||
    !Array.isArray(scan) ||
    scan.length !== 4
  )
    throw Error("Scanner state is unreadable.");
  const catalogIDs = new Set<number>();
  for (const entry of catalog) {
    if (
      !integer(entry.dungeonID) ||
      catalogIDs.has(entry.dungeonID) ||
      typeof entry.enabled !== "boolean" ||
      !Number.isSafeInteger(entry.entryRoomID) ||
      entry.entryRoomID < 0 ||
      !entry.typeGroups ||
      typeof entry.typeGroups !== "object" ||
      Object.entries(entry.typeGroups).some(([key, value]) => !/^\d+$/.test(key) || !integer(value))
    )
      throw Error("Combat source catalog is malformed.");
    catalogIDs.add(entry.dungeonID);
  }
  const slots = scan.map(dict);
  for (const slot of slots) {
    const ids = new Set<number>();
    for (const [key, row] of slot) {
      const id = integer(key);
      if (!id || ids.has(id)) throw Error("Scanner key is unreadable or repeated.");
      ids.add(id);
      keyval(row);
    }
  }
  const result: CombatSite[] = [],
    keys = new Set<number>(),
    instances = new Set<number>(),
    labels = new Set<string>();
  for (const [rawKey, raw] of slots[0]!) {
    const row = keyval(raw),
      archetype = integer(row.get("archetypeID"));
    if (archetype !== 24) continue;
    const dungeonID = integer(row.get("dungeonID")),
      spec = catalog.find((c) => c.enabled && c.dungeonID === dungeonID);
    if (!spec) continue;
    const scannerKey = integer(rawKey),
      instanceID = integer(row.get("instanceID")),
      label = row.get("targetID"),
      rowSystem = integer(row.get("solarSystemID")),
      place = position(row.get("position"));
    if (
      !scannerKey ||
      !instanceID ||
      integer(row.get("siteID")) !== instanceID ||
      !dungeonID ||
      rowSystem !== systemID ||
      typeof label !== "string" ||
      !label.trim() ||
      keys.has(scannerKey) ||
      instances.has(instanceID) ||
      labels.has(label)
    )
      throw Error("Combat site identity is ambiguous.");
    keys.add(scannerKey);
    instances.add(instanceID);
    labels.add(label);
    result.push({
      systemID,
      scannerKey,
      instanceID,
      dungeonID,
      label,
      position: place,
      observedAt,
    });
  }
  return result;
}
/** Only an enabled, reviewed source catalog can turn a fresh NPC row into an eligible target. */
export function isQualifiedAnomalyNpc(
  site: CombatSite,
  row: {
    kind: string | null;
    itemID: number;
    typeID: number | null;
    groupID: number | null;
    categoryID: number | null;
    isNpc: boolean;
    isSelf: boolean;
    geometryAvailable?: boolean;
    npcEntityType?: string | null;
  },
  catalog: readonly CombatCatalogEntry[],
): boolean {
  const matches = catalog.filter((c) => c.enabled && c.dungeonID === site.dungeonID);
  if (
    matches.length !== 1 ||
    !integer(row.itemID) ||
    !integer(row.typeID) ||
    !integer(row.groupID) ||
    row.kind !== "ship" ||
    row.categoryID !== 11 ||
    row.isNpc !== true ||
    row.isSelf ||
    row.geometryAvailable !== true ||
    row.npcEntityType === "concord"
  )
    return false;
  return matches[0]!.typeGroups[String(row.typeID)] === row.groupID;
}
