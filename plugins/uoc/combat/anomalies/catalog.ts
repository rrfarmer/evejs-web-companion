import fs from "node:fs";
import { createHash } from "node:crypto";
import type { CombatCatalogEntry } from "./discovery.ts";
const QUALIFIED_SHA256 = "8eb08f50bf38dda1a83d76e2dc08651065ffe3c2650d463ac6eff6beeb28259b";
const SHA256 = "3fa914b94d0a490b27deace7744a6f94426ce59d67ad4affcebe5a8b5eb08d1f";
/** The natural 2226 profile is source-qualified; this does not assert ship suitability or live completion. */
export function bundledCombatCatalog(): readonly CombatCatalogEntry[] {
  // Hash JSON content so a normal Windows CRLF checkout preserves the source pin.
  const raw = JSON.parse(fs.readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
  if (createHash("sha256").update(JSON.stringify(raw)).digest("hex") !== SHA256)
    throw Error("Anomaly source catalog integrity differs.");
  if (
    raw.dungeonID !== 5579 ||
    raw.archetypeID !== 24 ||
    raw.enabled !== false ||
    !raw.typeGroups ||
    typeof raw.typeGroups !== "object" ||
    Object.entries(raw.typeGroups).some(
      ([k, v]) => !/^\d+$/.test(k) || !Number.isSafeInteger(v) || Number(v) <= 0,
    )
  )
    throw Error("Anomaly source catalog is malformed.");
  const n = raw.natural2226;
  if (
    !n ||
    n.dungeonID !== 2226 ||
    n.archetypeID !== 24 ||
    n.entryRoomID !== 0 ||
    n.enabled !== true ||
    JSON.stringify(n.typeGroups) !== JSON.stringify({ 16981: 615, 16996: 615, 17006: 615 })
  )
    throw Error("Natural combat source catalog is malformed.");
  const typeGroups = Object.freeze({ ...raw.typeGroups }),
    naturalTypes = Object.freeze({ ...n.typeGroups });
  const qualified = JSON.parse(
    fs.readFileSync(new URL("./qualifiedCatalog.json", import.meta.url), "utf8"),
  );
  if (
    createHash("sha256").update(JSON.stringify(qualified)).digest("hex") !== QUALIFIED_SHA256 ||
    qualified.version !== 1 ||
    !Array.isArray(qualified.entries) ||
    qualified.entries.length !== 89
  )
    throw Error("Qualified anomaly catalog integrity differs.");
  const ids = new Set<number>();
  const entries: CombatCatalogEntry[] = qualified.entries.map((v: any) => {
    if (
      !Number.isSafeInteger(v?.dungeonID) ||
      v.dungeonID <= 0 ||
      ids.has(v.dungeonID) ||
      !Number.isSafeInteger(v.difficulty) ||
      v.difficulty < 1 ||
      v.difficulty > 5 ||
      !v.typeGroups ||
      typeof v.typeGroups !== "object" ||
      !Object.keys(v.typeGroups).length ||
      Object.entries(v.typeGroups).some(
        ([k, g]) => !/^\d+$/.test(k) || !Number.isSafeInteger(g) || Number(g) <= 0,
      )
    )
      throw Error("Qualified anomaly catalog is malformed.");
    ids.add(v.dungeonID);
    return Object.freeze({
      dungeonID: v.dungeonID,
      enabled: true,
      entryRoomID: 0,
      difficulty: v.difficulty,
      typeGroups: Object.freeze({ ...v.typeGroups }),
    });
  });
  const burrow = entries.find((v) => v.dungeonID === 2226);
  if (
    !burrow ||
    burrow.difficulty !== 1 ||
    JSON.stringify(burrow.typeGroups) !== JSON.stringify(naturalTypes)
  )
    throw Error("Natural anomaly source differs.");
  return Object.freeze([
    { dungeonID: raw.dungeonID, enabled: false, entryRoomID: 0, typeGroups },
    { dungeonID: 8589, enabled: false, entryRoomID: 0, typeGroups },
    ...entries,
  ]);
}
