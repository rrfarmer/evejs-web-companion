// The probe scanner's results, as the retail client keeps them and lists them.
//
// THE NOTICE. scanSvc.OnSystemScanStopped(probes, results, absentTargets) (253 to 259) hands it to the scan handler of
// the session's solar system (scanHandlerBySystem, one for each system the session has been in): each probe idle,
// the scan over, the results registered in its ResultsHistory, the absent targets' results cleared
// (probescanning/scanHandler.py 46 to 58). Each result is a KeyVal: id, scanGroupID, groupID, typeID,
// strengthAttributeID, dungeonID, dungeonNameID, archetypeID, factionID, itemID, difficulty, certainty, data (the
// place where it is perfect, a tuple; else a deviation, a float, with pos the guess) and pos. EveJS sends these.
// Tranquility's recordings have no probe scan.
//
// THE HISTORY (probescanning/results.py). Each scan counts one. A result takes what an entry says, unless it is
// cached: an exploration site (a signature or an anomaly) once perfect stays as it was. Its certainty is kept by the
// scan it came in; its place is the data where that is a tuple, the pos where the data is a float. It is shown while
// it came in the last scan, or always where it is an exploration site (at nought where the last scan missed it).
// A result with a certainty of 0.25 is identified from then on.
//
// THE LIST (ui/inflight/scannerFiles/scanResults.py, scannerListEntries.ScanResultNew): distance from the ship, ID,
// name, group, signal strength (the certainty to a tenth of a per cent, cut down), by ID unless another column is
// chosen; "no results" where there are none. The name is the type's (an exploration site's: its dungeon's name)
// else the group's else the scan group's; the group is an exploration site's kind (scanSvc.GetGroupName,
// explorationSites.get_exploration_site_group_name) or the type group's name.
//
// Here it is plain text: no icon, no colour by certainty, no bar of the change, no tooltip; a perfect result in warp
// range has no Warp To button yet, and shows its 100%.

import { readKeyVal, type JsonValue } from "./wire.ts";

/** probescanning/const.py. */
export const PROBE_RESULT_PERFECT = 1.0;
export const PROBE_RESULT_GOOD = 0.25;
export const SCAN_GROUP = Object.freeze({
  starBase: 0, scrap: 1, fighters: 2, signatures: 3, ships: 4, structures: 5, drones: 6, celestials: 7, anomalies: 8,
  charges: 9, npcs: 10, orbitals: 11, deployable: 12, sovereignty: 13, abyssalTraces: 14,
});
const EXPLORATION_SITES: readonly number[] = [SCAN_GROUP.signatures, SCAN_GROUP.anomalies];

/** scanSvc.NAME_BY_SCANGROUPID. */
export const SCAN_GROUP_LABELS: Readonly<Record<number, string>> = Object.freeze({
  [SCAN_GROUP.anomalies]: "UI/Inflight/Scanner/CosmicAnomaly",
  [SCAN_GROUP.signatures]: "UI/Inflight/Scanner/CosmicSignature",
  [SCAN_GROUP.ships]: "UI/Inflight/Scanner/Ship",
  [SCAN_GROUP.structures]: "UI/Inflight/Scanner/Structure",
  [SCAN_GROUP.drones]: "UI/Inflight/Scanner/Drone",
  [SCAN_GROUP.charges]: "UI/Inflight/Scanner/Charge",
  [SCAN_GROUP.npcs]: "UI/Inflight/Scanner/NPC",
  [SCAN_GROUP.fighters]: "UI/Inflight/Scanner/Fighter",
  [SCAN_GROUP.starBase]: "UI/Inflight/Scanner/StarBase",
  [SCAN_GROUP.orbitals]: "UI/Inflight/Scanner/Orbital",
  [SCAN_GROUP.deployable]: "UI/Inflight/Scanner/Deployable",
  [SCAN_GROUP.sovereignty]: "UI/Inflight/Scanner/Sovereignty",
  [SCAN_GROUP.abyssalTraces]: "UI/Inflight/Scanner/AbyssalTrace",
});

/** explorationSites.EXPLORATION_SITE_TYPES, by the site's strength attribute (dogma/const.py). */
const SITE_TYPE = Object.freeze({ ore: 211, gas: 209, relic: 210, data: 208, wormhole: 1908, combat: 1136 });
export const SITE_TYPE_LABELS: Readonly<Record<number, string>> = Object.freeze({
  [SITE_TYPE.ore]: "UI/Inflight/Scanner/OreSite",
  [SITE_TYPE.gas]: "UI/Inflight/Scanner/GasSite",
  [SITE_TYPE.relic]: "UI/Inflight/Scanner/RelicSite",
  [SITE_TYPE.data]: "UI/Inflight/Scanner/DataSite",
  [SITE_TYPE.wormhole]: "UI/Inflight/Scanner/Wormhole",
  [SITE_TYPE.combat]: "UI/Inflight/Scanner/CombatSite",
});
/** explorationSites.COMBAT_GROUP_NAMES_BY_ARCHETYPE (eve/common/lib/appConst.py's archetypes). */
const COMBAT_GROUP_LABELS: Readonly<Record<number, string>> = Object.freeze({
  70: "UI/Inflight/Scanner/HomefrontOperationSite",
  33: "UI/Inflight/Scanner/FactionalWarfareSite", 34: "UI/Inflight/Scanner/FactionalWarfareSite",
  35: "UI/Inflight/Scanner/FactionalWarfareSite", 36: "UI/Inflight/Scanner/FactionalWarfareSite",
  68: "UI/Inflight/Scanner/FactionalWarfareSite",
  72: "UI/Inflight/Scanner/InsurgencySite", 73: "UI/Inflight/Scanner/InsurgencySite", 74: "UI/Inflight/Scanner/InsurgencySite",
  75: "UI/Inflight/Scanner/InsurgencySite", 76: "UI/Inflight/Scanner/InsurgencySite", 77: "UI/Inflight/Scanner/InsurgencySite",
  78: "UI/Inflight/Scanner/InsurgencySite", 79: "UI/Inflight/Scanner/InsurgencySite",
});

export const PROBE_RESULT_LABELS = Object.freeze({
  distance: "UI/Common/Distance",
  id: "UI/Common/ID",
  name: "UI/Common/Name",
  group: "UI/Common/Group",
  signalStrength: "UI/Inflight/Scanner/SignalStrength",
  /** Takes percentage. */
  percentage: "UI/Common/Percentage",
  noResults: "UI/Inflight/Scanner/NoScanResults",
  /** The filter row's caption and the row's warp button (probeScannerPalette.py 214; ScanResultNew.Load). */
  scanResults: "UI/Inflight/Scanner/ScanResults",
  warpTo: "UI/Commands/WarpTo",
  // The results' own menu and the ignored box (scanResults.result_menu, 188 and 189; probeScannerPalette.py 215 and
  // 492 to 537; scannerToolsUIComponents.IgnoredBox, 121 to 129). The first is spelt as the client spells it.
  ignoreResult: "UI/Inflight/Scanner/IngoreResult",
  ignoreOtherResults: "UI/Inflight/Scanner/IgnoreOtherResults",
  /** Takes noIgnored. */
  ignored: "UI/Inflight/Scanner/Ignored",
  resetIgnored: "UI/Inflight/Scanner/ResetIgnoredResults",
  clearAllIgnored: "UI/Inflight/Scanner/ClearAllIgnoredResults",
  /** Takes id and desc. */
  resultIdAndDesc: "UI/Inflight/Scanner/ResultIdAndDesc",
  // An accurate result's warp (movementFunctions.GetDefaultWarpToLabel, 628 to 630; menusvc.GetWarpOptions and
  // WarpToMenu): the default, the list's own heading and each of its seven. Each takes distance.
  warpToWithinDistance: "UI/Inflight/WarpToWithinDistance",
  warpToWithinMenu: "UI/Inflight/Submenus/WarpToWithin",
  warpToWithin: "UI/Inflight/WarpToWithin",
  /** scanSvc.GetAlignToMenu (704 to 707). */
  alignTo: "UI/Inflight/AlignTo",
  /** scanSvc.GetScannedDownMenu (696 to 701). */
  bookmarkLocation: "UI/Inflight/BookmarkLocation",
  // The filtered box and its panel (probeScannerPalette.py 217, 445 to 480, 816 to 818). Filtered takes noFiltered.
  filtered: "UI/Inflight/Scanner/Filtered",
  showResultsFor: "UI/Inflight/Scanner/ShowResultsFor",
  anomalies: "UI/Inflight/Scanner/AnomalySiteFilterLabel",
  // The pilot's own filters: the panel's button, and the editor (scannerfiltereditor.py 39 to 113, 169 to 176).
  createNewFilter: "UI/Inflight/Scanner/CreateNewFilter",
  filterEditor: "UI/Inflight/Scanner/ScannerFilterEditor",
  filterName: "UI/Inflight/Scanner/FilterName",
  selectGroupsToFilter: "UI/Inflight/Scanner/SelectGroupsToFilter",
  save: "UI/Common/Buttons/Save",
  cancel: "UI/Common/Buttons/Cancel",
  yes: "UI/Common/Buttons/Yes",
  no: "UI/Common/Buttons/No",
  selectAll: "UI/Common/SelectAll",
  deselectAll: "UI/Common/DeselectAll",
  showAll: "UI/Common/Show all",
  pleaseNameFilter: "UI/Inflight/Scanner/PleaseNameFilter",
  cannotNameFilter: "UI/Inflight/Scanner/CannotNameFilter",
  selectGroupsForFilter: "UI/Inflight/Scanner/SelectGroupsForFilter",
  filterAlreadyExists: "UI/Inflight/Scanner/FilterAlreadyExists",
});
export const PROBE_RESULT_WORD_LABELS: readonly string[] = [
  ...new Set([...Object.values(PROBE_RESULT_LABELS), ...Object.values(SCAN_GROUP_LABELS), ...Object.values(SITE_TYPE_LABELS), ...Object.values(COMBAT_GROUP_LABELS)]),
];

export type Vec3 = readonly [number, number, number];

/** One result as the server sends it. */
export interface ProbeResultEntry {
  readonly id: string;
  readonly scanGroupID: number | null;
  readonly groupID: number | null;
  readonly typeID: number | null;
  readonly strengthAttributeID: number | null;
  readonly dungeonID: number | null;
  readonly dungeonNameID: number | null;
  readonly archetypeID: number | null;
  readonly factionID: number | null;
  readonly itemID: number | null;
  readonly difficulty: number | null;
  readonly certainty: number;
  /** A tuple: the place; a float: the deviation; a list of places; null for anything else. */
  readonly data: Vec3 | number | readonly Vec3[] | null;
  readonly pos: Vec3 | null;
}

export interface ScanStopped {
  readonly probeIDs: readonly number[];
  readonly results: readonly ProbeResultEntry[];
  readonly absentTargets: readonly string[];
}

const numberOf = (value: JsonValue | undefined): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const wrapped = value as { type?: unknown; value?: unknown };
    if ((wrapped.type === "long" || wrapped.type === "real" || wrapped.type === "float") && wrapped.value !== undefined) {
      const read = Number(wrapped.value);
      return Number.isFinite(read) ? read : null;
    }
  }
  return null;
};
const itemsOf = (value: JsonValue | undefined): readonly JsonValue[] | null => {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && (value as { type?: unknown }).type === "list" && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: JsonValue[] }).items;
  }
  return null;
};
const vectorOf = (value: JsonValue | undefined): Vec3 | null => {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value.map((part) => numberOf(part));
  return x === null || x === undefined || y === null || y === undefined || z === null || z === undefined ? null : [x, y, z];
};

function dataOf(value: JsonValue | undefined): ProbeResultEntry["data"] {
  // A tuple (an array on the page's side) is a place; a list is places; a float is a deviation.
  if (Array.isArray(value)) return vectorOf(value);
  const list = itemsOf(value);
  if (list !== null) {
    const places = list.map((item) => vectorOf(item)).filter((place): place is Vec3 => place !== null);
    return places;
  }
  return numberOf(value);
}

/** A result's KeyVal; null for one with no id. */
export function decodeProbeResult(value: JsonValue): ProbeResultEntry | null {
  const field = (key: string) => readKeyVal(value, key);
  const idValue = field("id");
  const id = typeof idValue === "string" ? idValue : typeof idValue === "number" ? String(idValue) : null;
  if (id === null || id === "") return null;
  const optional = (key: string) => numberOf(field(key));
  return {
    id,
    scanGroupID: optional("scanGroupID"),
    groupID: optional("groupID"),
    typeID: optional("typeID"),
    strengthAttributeID: optional("strengthAttributeID"),
    dungeonID: optional("dungeonID"),
    dungeonNameID: optional("dungeonNameID"),
    archetypeID: optional("archetypeID"),
    factionID: optional("factionID"),
    itemID: optional("itemID"),
    difficulty: optional("difficulty"),
    certainty: optional("certainty") ?? 0,
    data: dataOf(field("data")),
    pos: vectorOf(field("pos")),
  };
}

/** OnSystemScanStopped's three arguments. */
export function decodeScanStopped(args: readonly JsonValue[]): ScanStopped {
  const probeIDs = (itemsOf(args[0]) ?? []).map((id) => numberOf(id)).filter((id): id is number => id !== null);
  const results = (itemsOf(args[1]) ?? []).map((entry) => decodeProbeResult(entry)).filter((entry): entry is ProbeResultEntry => entry !== null);
  const absentTargets = (itemsOf(args[2]) ?? []).map((id) => (typeof id === "string" ? id : typeof id === "number" ? String(id) : null)).filter((id): id is string => id !== null);
  return { probeIDs, results, absentTargets };
}

const isExplorationSite = (scanGroupID: number | null): boolean => scanGroupID !== null && EXPLORATION_SITES.includes(scanGroupID);
/** util.IsPerfectResult: perfect, and its data a place. */
const isPerfectEntry = (entry: ProbeResultEntry): boolean => entry.certainty >= PROBE_RESULT_PERFECT && entry.data !== null && typeof entry.data !== "number" && entry.data.length === 3 && typeof entry.data[0] === "number";

/** One result as the history holds it (results.Result). */
interface HeldResult {
  readonly entry: ProbeResultEntry;
  readonly pos: Vec3 | null;
  /** (scan number, certainty), in the order they came. */
  readonly certainties: ReadonlyArray<readonly [number, number]>;
  readonly scanNumberPerfect: number | null;
  readonly isPerfect: boolean;
  readonly isIdentified: boolean;
}

export interface ResultsHistory {
  readonly scanNumber: number;
  readonly results: ReadonlyMap<string, HeldResult>;
}

export const EMPTY_RESULTS_HISTORY: ResultsHistory = Object.freeze({ scanNumber: 0, results: new Map() });

/** Result._GetPosition. */
function placeOf(entry: ProbeResultEntry): Vec3 | null {
  const data = entry.data;
  if (typeof data === "number") return entry.pos;
  if (data === null) return null;
  if (data.length === 3 && typeof data[0] === "number") return data as Vec3;
  const places = data as readonly Vec3[];
  if (places.length === 0) return [0, 0, 0];
  const sum = places.reduce<[number, number, number]>((acc, place) => [acc[0] + place[0], acc[1] + place[1], acc[2] + place[2]], [0, 0, 0]);
  return [sum[0] / places.length, sum[1] / places.length, sum[2] / places.length];
}

/** Result.AddEntry: the persistable attributes are kept where the entry says nothing of them. */
function withEntry(held: HeldResult | undefined, entry: ProbeResultEntry, scanNumber: number): HeldResult {
  if (held !== undefined && held.scanNumberPerfect !== null) return held;
  const before = held?.entry;
  const keep = <K extends keyof ProbeResultEntry>(key: K): ProbeResultEntry[K] => (entry[key] ?? before?.[key] ?? null) as ProbeResultEntry[K];
  const merged: ProbeResultEntry = {
    ...entry,
    itemID: keep("itemID"), typeID: keep("typeID"), groupID: keep("groupID"), strengthAttributeID: keep("strengthAttributeID"),
    dungeonNameID: keep("dungeonNameID"), dungeonID: keep("dungeonID"), archetypeID: keep("archetypeID"), factionID: keep("factionID"),
  };
  const perfect = isPerfectEntry(entry);
  return {
    entry: merged,
    pos: placeOf(entry),
    certainties: [...(held?.certainties ?? []), [scanNumber, entry.certainty]],
    scanNumberPerfect: isExplorationSite(entry.scanGroupID) && perfect ? scanNumber : null,
    isPerfect: perfect,
    isIdentified: held?.isIdentified === true || entry.certainty >= PROBE_RESULT_GOOD,
  };
}

/** ResultsHistory.RegisterResults: one more scan, and what it found. */
export function registerResults(history: ResultsHistory, entries: readonly ProbeResultEntry[]): ResultsHistory {
  const scanNumber = history.scanNumber + 1;
  const results = new Map(history.results);
  for (const entry of entries) results.set(entry.id, withEntry(results.get(entry.id), entry, scanNumber));
  return { scanNumber, results };
}

/** ResultsHistory.ClearResults. */
export function clearResults(history: ResultsHistory, targetIDs: readonly string[]): ResultsHistory {
  if (targetIDs.length === 0) return history;
  const results = new Map(history.results);
  for (const id of targetIDs) results.delete(id);
  return { scanNumber: history.scanNumber, results };
}

/** What the list shows of one result (Result.GetAsDict). */
export interface ShownResult extends ProbeResultEntry {
  readonly prevCertainty: number;
  readonly pos: Vec3 | null;
  readonly isPerfect: boolean;
  readonly isIdentified: boolean;
}

const certaintyAt = (held: HeldResult, scanNumber: number): number => held.certainties.find(([scan]) => scan === scanNumber)?.[1] ?? 0;

// ── The results' filter (probescanning/resultFilter.py; scanHandler.GetResults, 133 to 153) ─────────────────────────
//
// ⚠ THE NUMBERS ARE THE COMPILED MODULES', NOT THE DECOMPILED SOURCE'S. probeScanGroups (probescanning/const.py) and
// the cosmic signature attributes were run out of the client's own .pyc files in its own python27 (inventorycommon,
// dogma and probescanning const executed in turn); _defaultFilterSet was read from resultFilter.pyc's bytecode: it
// is built of the constants -1 to -5, where the decompiled source has [0, 6, 8, 10, 12] (the constants' places).

/** probescanning/const.py probeScanGroups: each scan group's inventory groups. */
export const PROBE_SCAN_GROUPS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  0: [311, 363, 365, 397, 404, 413, 416, 417, 426, 430, 438, 439, 440, 441, 443, 444, 449, 471, 707, 709, 837, 838, 839, 1212, 1282],
  1: [12, 14, 186, 340, 448, 649],
  2: [1537, 1652, 1653, 4777, 4778, 4779],
  3: [502],
  4: [25, 26, 27, 28, 29, 30, 31, 237, 324, 358, 380, 381, 419, 420, 463, 485, 513, 540, 541, 543, 547, 659, 830, 831, 832, 833, 834, 883, 893, 894, 898, 900, 902, 906, 941, 963, 1022, 1201, 1202, 1283, 1305, 1527, 1534, 1538, 1972, 4594, 4902, 5087, 5120],
  5: [1404, 1406, 1408, 1657, 1924, 2016, 2017, 4744],
  6: [100, 101, 544, 639, 640, 641, 1159],
  7: [6, 7, 8, 9, 10, 15, 411],
  8: [885],
  9: [479, 492, 548],
  10: [1530, 1764, 1765, 1766, 1767, 1803, 1813, 1814, 1878, 1879, 1880, 4028, 4034, 4035, 4036, 4037, 4053, 4637, 4638, 4909, 4917, 4949, 5032],
  11: [1025, 1106, 4736],
  12: [361, 364, 1246, 1247, 1249, 1250, 1275, 1276, 4093, 4107, 4810, 4913],
  13: [1003, 1012],
  14: [1991],
});
/** inventorycommon.const.groupCosmicSignature. */
const GROUP_COSMIC_SIGNATURE = 502;
/** probescanning/const.py probeScanCosmicSignatureAttributes: a signature's strengths. */
const COSMIC_SIGNATURE_ATTRIBUTES: readonly number[] = [208, 209, 210, 211, 1136, 1908];
/** A filter's group, as the filter holds it: a group's number, or a cosmic signature's group and strength. */
const groupKey = (groupID: number, strengthAttributeID: number | null = null): string =>
  strengthAttributeID === null ? String(groupID) : `${groupID}:${strengthAttributeID}`;
const groupsOf = (...scanGroups: number[]): readonly string[] => scanGroups.flatMap((scanGroup) => (PROBE_SCAN_GROUPS[scanGroup] ?? []).map((groupID) => groupKey(groupID)));

/**
 * resultFilter._defaultFilters, less Show all (the panel has no box for it, filterID 0): each standard filter's ID,
 * its label and its groups (GetCosmicSignatureGroups, GetDroneFighterAndChargeGroups, GetShipGroups,
 * GetStructureGroups, GetDeployableGroups; probescanning/const.py 260 to 277).
 */
export const STANDARD_RESULT_FILTERS: ReadonlyArray<{ readonly id: number; readonly label: string; readonly groups: readonly string[] }> = Object.freeze([
  { id: -1, label: "UI/Inflight/Scanner/CosmicSignatures", groups: COSMIC_SIGNATURE_ATTRIBUTES.map((attributeID) => groupKey(GROUP_COSMIC_SIGNATURE, attributeID)) },
  { id: -2, label: "UI/Inflight/Scanner/DronesAndCharges", groups: groupsOf(6, 2, 9) },
  { id: -3, label: "UI/Inflight/Scanner/Ships", groups: groupsOf(4, 10) },
  { id: -4, label: "UI/Inflight/Scanner/Structures", groups: groupsOf(5, 13, 0, 11) },
  { id: -5, label: "UI/Inflight/Scanner/Deployables", groups: groupsOf(12) },
]);
/** resultFilter._defaultFilterSet: the five standard filters. */
export const DEFAULT_ACTIVE_RESULT_FILTERS: readonly number[] = Object.freeze([-1, -2, -3, -4, -5]);

/** One of the pilot's own filters (resultFilter.filters): its number (1 and up), its name and its groups. */
export interface CustomResultFilter {
  readonly id: number;
  readonly name: string;
  readonly groups: readonly string[];
}

/** What the pilot's results are filtered by: the active filters, whether anomalies are shown, and the pilot's own filters (resultFilter). */
export interface ResultFilterSettings {
  readonly active: readonly number[];
  readonly showingAnomalies: boolean;
  readonly custom: readonly CustomResultFilter[];
}

/** probeScannerPalette.AddFilter (45 to 52): no more of the pilot's own filters than this (TooManyFilters). */
export const MAX_CUSTOM_RESULT_FILTERS = 25;
/** scannerfiltereditor: the filter's name field (maxLength, 50). */
export const RESULT_FILTER_NAME_MAX = 64;

/** scannerfiltereditor.SCAN_GROUP_NAMES (21 to 32): the scan groups the editor lists (not scrap, celestials or anomalies). */
const EDITOR_SCAN_GROUP_LABELS: Readonly<Record<number, string>> = Object.freeze({
  [SCAN_GROUP.signatures]: "UI/Inflight/Scanner/CosmicSignature",
  [SCAN_GROUP.ships]: "UI/Inflight/Scanner/Ship",
  [SCAN_GROUP.structures]: "UI/Inflight/Scanner/Structure",
  [SCAN_GROUP.drones]: "UI/Inflight/Scanner/Drone",
  [SCAN_GROUP.charges]: "UI/Inflight/Scanner/Charge",
  [SCAN_GROUP.npcs]: "UI/Inflight/Scanner/NPC",
  [SCAN_GROUP.fighters]: "UI/Inflight/Scanner/Fighter",
  [SCAN_GROUP.starBase]: "UI/Inflight/Scanner/StarBase",
  [SCAN_GROUP.orbitals]: "UI/Inflight/Scanner/Orbital",
  [SCAN_GROUP.deployable]: "UI/Inflight/Scanner/Deployable",
  [SCAN_GROUP.sovereignty]: "UI/Inflight/Scanner/Sovereignty",
  [SCAN_GROUP.abyssalTraces]: "UI/Inflight/Scanner/AbyssalTrace",
});

/** One box of the editor: the filter's group as it holds it, the inventory group, and a signature's site type's label where it is one. */
export interface FilterEditorItem {
  readonly key: string;
  readonly groupID: number;
  readonly siteTypeLabel: string | null;
}

/**
 * The editor's list (scannerfiltereditor.LoadTypes, 116 to 167): each listed scan group, its label and its boxes. A
 * cosmic signature is a box for each of its six site types (EXPLORATION_SITE_TYPES, by strength); any other group is
 * a box named by the inventory group's name (evetypes.GetGroupNameByGroup).
 */
export const FILTER_EDITOR_CATEGORIES: ReadonlyArray<{ readonly scanGroup: number; readonly label: string; readonly items: readonly FilterEditorItem[] }> =
  Object.freeze(Object.entries(EDITOR_SCAN_GROUP_LABELS).map(([scanGroup, label]) => ({
    scanGroup: Number(scanGroup),
    label,
    items: (PROBE_SCAN_GROUPS[Number(scanGroup)] ?? []).flatMap((groupID): FilterEditorItem[] =>
      groupID === GROUP_COSMIC_SIGNATURE
        ? COSMIC_SIGNATURE_ATTRIBUTES.map((attributeID) => ({ key: groupKey(groupID, attributeID), groupID, siteTypeLabel: SITE_TYPE_LABELS[attributeID] ?? null }))
        : [{ key: groupKey(groupID), groupID, siteTypeLabel: null }]),
  })));

/** The results the list shows, and what it leaves out: scanHandler.GetResults (133 to 153). */
export interface SplitResults {
  readonly shown: readonly ShownResult[];
  readonly ignored: number;
  readonly filtered: number;
  readonly anomaliesFiltered: number;
}

/**
 * scanHandler.GetResults with resultFilter.IsFilteredOut (127 to 142): an ignored result left out and counted; an
 * anomaly left out where anomalies are not shown; any other filtered out where no filter is active, where it is
 * identified and its group (a cosmic signature's, with its strength) is in no active filter, or where it is not
 * identified and its scan group holds none of their groups (GetMasterGroupsForActiveFilterSet).
 */
export function splitResults(results: readonly ShownResult[], ignoredIDs: ReadonlySet<string>, filter: ResultFilterSettings): SplitResults {
  const filters = [...STANDARD_RESULT_FILTERS, ...filter.custom];
  const current = new Set(filters.filter((each) => filter.active.includes(each.id)).flatMap((each) => each.groups));
  const masterGroups = new Set<number>();
  for (const key of current) {
    const groupID = Number(key.split(":")[0]);
    for (const [scanGroup, groups] of Object.entries(PROBE_SCAN_GROUPS)) if (groups.includes(groupID)) masterGroups.add(Number(scanGroup));
  }
  const filteredOut = (result: ShownResult): boolean => {
    if (current.size === 0) return true;
    if (result.isIdentified) {
      return result.groupID === GROUP_COSMIC_SIGNATURE
        ? !current.has(groupKey(GROUP_COSMIC_SIGNATURE, result.strengthAttributeID))
        : !current.has(groupKey(result.groupID ?? -1));
    }
    return result.scanGroupID === null || !masterGroups.has(result.scanGroupID);
  };
  const shown: ShownResult[] = [];
  let ignored = 0;
  let filtered = 0;
  let anomaliesFiltered = 0;
  for (const result of results) {
    if (ignoredIDs.has(result.id)) ignored += 1;
    else if (result.scanGroupID === SCAN_GROUP.anomalies && !filter.showingAnomalies) anomaliesFiltered += 1;
    else if (result.scanGroupID !== SCAN_GROUP.anomalies && filteredOut(result)) filtered += 1;
    else shown.push(result);
  }
  return { shown, ignored, filtered, anomaliesFiltered };
}

/** appConst.minWarpDistance (1480): a place farther off than this is within warp distance (michelle.py 705 to 715). */
export const MIN_WARP_DISTANCE = 150_000;

/**
 * Whether a result's site is known exactly, so that its menu offers the warp, the align and the bookmark
 * (scanSvc.GetAccurateScannedDownMenu): sensorsuite's SiteDataFromScanResult (probescanner.py 52 to 64) makes an
 * anomaly's or a structure's site, which is always accurate (sitedata.py 19), and any other a signature's, accurate
 * at full signal (signatures.py 33 and 34).
 */
export function isAccurate(result: ShownResult): boolean {
  if (result.scanGroupID === SCAN_GROUP.anomalies || result.scanGroupID === SCAN_GROUP.structures) return true;
  return result.certainty >= 1.0;
}

/**
 * A held result as the list would show it, still valid or not: ResultsHistory.GetResult, as
 * scanSvc.GetIgnoredResultsDesc reads an ignored one for its name. Null for one not held.
 */
export function heldResult(history: ResultsHistory, id: string): ShownResult | null {
  const held = history.results.get(id);
  if (held === undefined) return null;
  const certainty = held.scanNumberPerfect !== null ? PROBE_RESULT_PERFECT : held.certainties.at(-1)?.[1] ?? 0;
  return { ...held.entry, certainty, prevCertainty: certainty, pos: held.pos, isPerfect: held.isPerfect, isIdentified: held.isIdentified };
}

/** ResultsHistory.LastResultIterator: the results still valid, as the list has them. */
export function lastResults(history: ResultsHistory): ShownResult[] {
  const shown: ShownResult[] = [];
  const scanNumber = history.scanNumber;
  for (const held of history.results.values()) {
    const lastScan = held.certainties.at(-1)?.[0] ?? null;
    if (!isExplorationSite(held.entry.scanGroupID) && lastScan !== scanNumber) continue;
    const [certainty, prevCertainty] = held.scanNumberPerfect !== null
      ? [PROBE_RESULT_PERFECT, held.scanNumberPerfect === scanNumber ? certaintyAt(held, scanNumber - 1) : PROBE_RESULT_PERFECT]
      : [certaintyAt(held, scanNumber), certaintyAt(held, scanNumber - 1)];
    shown.push({ ...held.entry, certainty, prevCertainty, pos: held.pos, isPerfect: held.isPerfect, isIdentified: held.isIdentified });
  }
  return shown;
}

/** The words a result's row is made of. */
export interface ResultRow {
  readonly id: string;
  readonly distance: number | null;
  readonly name: string;
  readonly group: string;
  readonly signal: string;
  readonly certainty: number;
  /** The certainty at the scan before, for the row's bar (ScanResultNew.Load: the base and the change). */
  readonly prevCertainty: number;
  /** A perfect result, which the client's row offers a warp to in place of its percentage. */
  readonly isPerfect: boolean;
  /**
   * The row's icon (mapMarkerUtil.GetResultTexturePath): the scan group's bracket (ICONS_BY_SCANGROUP) where the result
   * has one, else the result-location mark; res: path below res:/, lower-cased as the page serves the install.
   */
  readonly icon: string;
}

/** mapMarkerUtil.ICONS_BY_SCANGROUP: the bracket of each signature kind, by its strength attribute. */
const ICONS_BY_SCANGROUP: Readonly<Record<number, string>> = Object.freeze({
  211: "ui/texture/shared/brackets/ore_site_16.png", 209: "ui/texture/shared/brackets/harvestablecloud.png",
  210: "ui/texture/shared/brackets/relic_site_16.png", 208: "ui/texture/shared/brackets/data_site_16.png",
  1908: "ui/texture/shared/brackets/wormhole.png", 1136: "ui/texture/shared/brackets/combatsite_16.png",
});

/** mapMarkerUtil.GetResultColor: red to a quarter, orange to three quarters, yellow below one, green at one. */
export function resultColor(certainty: number | null): string {
  if (certainty === null || certainty <= 0.25) return "#ff0000";
  if (certainty <= 0.75) return "#e68000";
  if (certainty < 1) return "#ffff1a";
  return "#00cc00";
}

export interface ResultWording {
  readonly words: (label: string, args?: Record<string, string | number>) => string | null;
  /** A type's name, a group's name (by its ID), a message's text; null where it cannot be had yet. */
  readonly typeName: (typeID: number) => string | null;
  readonly groupName: (groupID: number) => string | null;
  readonly messageText: (messageID: number) => string | null;
}

/** get_exploration_site_group_name. */
function siteGroupName(result: ShownResult, wording: ResultWording): string | null {
  const siteType = result.strengthAttributeID;
  if (siteType === null) return null;
  const combat = siteType === SITE_TYPE.combat && result.archetypeID !== null ? COMBAT_GROUP_LABELS[result.archetypeID] : undefined;
  if (combat !== undefined) {
    const first = wording.words(combat);
    const second = wording.words(SITE_TYPE_LABELS[SITE_TYPE.combat]!);
    return first === null || second === null ? null : `${first} - ${second}`;
  }
  const label = SITE_TYPE_LABELS[siteType];
  return label === undefined ? null : wording.words(label);
}

/** scanSvc.GetGroupName. */
function groupNameOf(result: ShownResult, wording: ResultWording): string {
  if (isExplorationSite(result.scanGroupID)) return siteGroupName(result, wording) ?? "";
  return result.groupID === null ? "" : wording.groupName(result.groupID) ?? "";
}

/** scanSvc.GetTypeName. */
function typeNameOf(result: ShownResult, wording: ResultWording): string {
  if (isExplorationSite(result.scanGroupID)) return result.dungeonNameID === null ? "" : wording.messageText(result.dungeonNameID) ?? "";
  return result.typeID === null ? "" : wording.typeName(result.typeID) ?? "";
}

/** The rows of the list, by ID (the client's default column, ascending). */
export function resultRows(results: readonly ShownResult[], myPosition: Vec3 | null, wording: ResultWording): ResultRow[] {
  return results.map((result) => {
    // scanSvc.GetDisplayName: the type's name, else the group's, else the scan group's.
    let name = result.typeID ? typeNameOf(result, wording) : "";
    if (name === "" && result.groupID) name = groupNameOf(result, wording);
    if (name === "") name = (result.scanGroupID === null ? null : SCAN_GROUP_LABELS[result.scanGroupID] ? wording.words(SCAN_GROUP_LABELS[result.scanGroupID]!) : null) ?? "";
    const distance = myPosition === null || result.pos === null ? null : Math.hypot(result.pos[0] - myPosition[0], result.pos[1] - myPosition[1], result.pos[2] - myPosition[2]);
    // ScanResultNew.Load: the certainty to a tenth of a per cent, cut down.
    const percentage = Math.floor(result.certainty * 1000) / 10;
    return {
      id: result.id,
      distance,
      name,
      group: groupNameOf(result, wording),
      signal: wording.words(PROBE_RESULT_LABELS.percentage, { percentage }) ?? `${percentage}%`,
      certainty: result.certainty,
      prevCertainty: result.prevCertainty,
      isPerfect: result.isPerfect,
      icon: (result.strengthAttributeID !== null ? ICONS_BY_SCANGROUP[result.strengthAttributeID] : undefined) ?? "ui/texture/classes/mapview/scanresultlocation.png",
    };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
