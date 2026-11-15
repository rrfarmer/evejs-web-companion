export interface FittingFileProfile {
  readonly name: string;
  readonly description: string;
  readonly hull: string;
  readonly hardware: readonly { readonly type: string; readonly slot: string; readonly qty: string | null }[];
}

export interface FittingFileType {
  readonly hullID: number | null;
  readonly typeID: number | null;
  readonly fittable: boolean;
  readonly obsolete: boolean;
}

export interface FittingFileEntry {
  readonly name: string;
  readonly description: string;
  readonly hull: string;
  readonly shipTypeID: number | null;
  readonly fitData: readonly (readonly [number, number, number])[];
  readonly unknownTypes: readonly string[];
  readonly invalidSlots: readonly string[];
  readonly obsoleteModules: readonly string[];
}

/** ImportFittingsWindow.OnFileSelected reads the XML profiles without writing anything. */
export function parseFittingFile(text: string): readonly FittingFileProfile[] {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.doctype || document.querySelector("parsererror") || document.documentElement.tagName !== "fittings") {
    throw new Error("This file is not a valid EVE fittings export.");
  }
  const profiles = Array.from(document.getElementsByTagName("fitting"), fitting => ({
    name: fitting.getAttribute("name") ?? "",
    description: fitting.querySelector("description")?.getAttribute("value") ?? "",
    hull: fitting.querySelector("shipType")?.getAttribute("value") ?? "",
    hardware: Array.from(fitting.getElementsByTagName("hardware"), item => ({
      type: item.getAttribute("type") ?? "",
      slot: item.getAttribute("slot") ?? "",
      qty: item.getAttribute("qty"),
    })),
  }));
  if (!profiles.length) throw new Error("This file contains no fittings.");
  return profiles;
}

const bayFlags = new Map([["cargo", 5], ["drone bay", 87], ["fighter bay", 158]]);
const slotFlags = new Map<string, readonly [start: number, count: number]>([
  ["low", [11, 8]], ["med", [19, 8]], ["hi", [27, 8]], ["rig", [92, 3]],
  ["subsystem", [125, 4]], ["service", [164, 8]],
]);

function fittingFlag(slot: string): number | null {
  const bay = bayFlags.get(slot);
  if (bay !== undefined) return bay;
  const match = /^(\w+) slot (\d)$/.exec(slot);
  const range = match && slotFlags.get(match[1]!);
  const index = Number(match?.[2]);
  return range && index < range[1] ? range[0] + index : null;
}

/** GetFittingImportData keeps one row per (typeID, flag), taking the last row in the file. */
export function resolveFittingFileProfile(profile: FittingFileProfile, types: ReadonlyMap<string, FittingFileType>): FittingFileEntry {
  const shipTypeID = types.get(profile.hull)?.hullID ?? null;
  const unknownTypes = new Set<string>();
  const invalidSlots = new Set<string>();
  const obsoleteModules = new Set<string>();
  const fitData = new Map<string, readonly [number, number, number]>();
  if (shipTypeID === null) unknownTypes.add(profile.hull || "Missing ship type");
  else for (const item of profile.hardware) {
    const type = types.get(item.type);
    const flag = fittingFlag(item.slot);
    if (!type?.typeID) { unknownTypes.add(item.type || "Missing item type"); continue; }
    if (flag === null) { invalidSlots.add(item.type); continue; }
    const fitted = type.fittable && flag !== 5;
    if (!fitted && type.obsolete) { obsoleteModules.add(item.type); continue; }
    const qty = fitted ? 1 : item.qty && /^\s*\+?\d+\s*$/.test(item.qty) ? Number(item.qty) : NaN;
    if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error(`Invalid quantity for ${item.type} in ${profile.name}.`);
    fitData.set(`${type.typeID}:${flag}`, [type.typeID, flag, qty]);
  }
  const { name, description, hull } = profile;
  return { name, description, hull, shipTypeID, fitData: [...fitData.values()],
    unknownTypes: [...unknownTypes], invalidSlots: [...invalidSlots], obsoleteModules: [...obsoleteModules] };
}

/** ImportForOwner tries _0 through _99 against all the chosen owner's fitting names. */
export function reserveImportedFittingName(given: string, used: Set<string>): string {
  const name = given.trim().slice(0, 50);
  let unique = name;
  if (used.has(name.toLowerCase())) for (let index = 0; index < 100; index++) {
    const suffix = `_${index}`;
    const candidate = name.slice(0, 50 - suffix.length) + suffix;
    if (!used.has(candidate.toLowerCase())) { unique = candidate; break; }
  }
  used.add(unique.toLowerCase());
  return unique;
}
