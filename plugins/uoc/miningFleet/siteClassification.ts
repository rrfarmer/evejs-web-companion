/** Source-scoped scanner identity classification for EveJS and
 * moonOreAnomalies 0.5.4 moonOreSiteRules.json v1.
 * Sources: dungeonUniverseRuntime.js:54,1486; mod moonOreSiteRules.json
 * siteIDBases and lifecycleRetirement.js:36-45; scanMgrService.js:630. Scanner dictionary keys are site
 * entity IDs, not the value's instanceID. Unknown namespaces stay unknown. */
export type MiningSiteFamily = "ORE" | "MOON" | "ICE" | "UNKNOWN";
export type ScannerIdentity = {
  systemID: number;
  scannerKey: number;
  instanceID: number;
  archetypeID: number;
  scanStrengthAttribute: number;
  dungeonID: number | null;
  dungeonNameID?: number | null;
};
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const MOON_BASES = [
  5910000000000, 5920000000000, 5930000000000, 5940000000000, 5950000000000,
] as const;
const MOON_NAME_IDS = [289412, 289416, 289546, 289559, 289689] as const;
const ORE_BASE = 5800000000000;
function inSystemNamespace(key: number, system: number, base: number) {
  const n = key - base - system * 1000 - 1;
  return Number.isSafeInteger(n) && n >= 0 && n < 999;
}
export function classifyMiningSite(row: ScannerIdentity): MiningSiteFamily {
  if (
    !row ||
    ![
      row.systemID,
      row.scannerKey,
      row.instanceID,
      row.archetypeID,
      row.scanStrengthAttribute,
    ].every(positive) ||
    !(row.dungeonID === null || Number.isSafeInteger(row.dungeonID)) ||
    row.scanStrengthAttribute !== 211
  )
    return "UNKNOWN";
  if (row.archetypeID === 28)
    return row.dungeonID !== null && row.dungeonID < 0 ? "UNKNOWN" : "ICE";
  if (row.archetypeID !== 27) return "UNKNOWN";
  const moon = MOON_BASES.filter((base) => inSystemNamespace(row.scannerKey, row.systemID, base));
  const ore = inSystemNamespace(row.scannerKey, row.systemID, ORE_BASE);
  if (moon.length === 1 && !ore) {
    if (row.dungeonID === 0) return "MOON";
    const index = MOON_BASES.indexOf(moon[0]!);
    if (
      row.dungeonID !== null &&
      row.dungeonID < 0 &&
      row.dungeonNameID === MOON_NAME_IDS[index] &&
      row.dungeonID + index >= -1999999999 &&
      row.dungeonID + index <= -100000000
    )
      return "MOON";
  }
  if (!moon.length && ore && positive(row.dungeonID)) return "ORE";
  return "UNKNOWN";
}
