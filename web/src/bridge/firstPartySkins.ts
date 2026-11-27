import { isListValue, readKeyVal, unwrapBool, unwrapLong } from "./wire.ts";

export interface FirstPartySkin {
  readonly skinID: number;
  readonly materialID: number;
  readonly materialSetID: number | null;
  readonly nameID: number;
  readonly visible: boolean;
}

export interface CharacterSkin extends FirstPartySkin {
  readonly types: readonly number[];
}

export interface CharacterSkinLicense {
  readonly expires: bigint | null;
  readonly singleUse: boolean;
}

interface SkinLicenseType {
  readonly typeID: number;
  readonly days: number;
  readonly singleUse: boolean;
  readonly nameID: number;
  readonly hulls: readonly number[];
}

let licenseTypes: Promise<ReadonlyMap<number, SkinLicenseType>> | undefined;

export function loadSkinLicenseTypes(): Promise<ReadonlyMap<number, SkinLicenseType>> {
  return licenseTypes ??= fetch("/client-assets/firstPartySkins/licenses.json").then(async response => {
    if (!response.ok) throw new Error("The SKIN license types could not be loaded.");
    const rows = await response.json() as SkinLicenseType[];
    return new Map(rows.map(row => [row.typeID, row]));
  }).catch(error => {
    licenseTypes = undefined;
    throw error;
  });
}

let collection: Promise<readonly CharacterSkin[]> | undefined;

export function loadCharacterSkinCatalog(): Promise<readonly CharacterSkin[]> {
  return collection ??= fetch("/client-assets/firstPartySkins/all.json").then(response => {
    if (!response.ok) throw new Error("The SKIN collection could not be loaded.");
    return response.json() as Promise<CharacterSkin[]>;
  }).catch(error => {
    collection = undefined;
    throw error;
  });
}

const catalogs = new Map<number, Promise<readonly FirstPartySkin[]>>();

export function loadFirstPartySkinCatalog(typeID: number): Promise<readonly FirstPartySkin[]> {
  let pending = catalogs.get(typeID);
  if (!pending) {
    pending = fetch(`/client-assets/firstPartySkins/${typeID}.json`).then(response => {
      if (!response.ok) throw new Error("The ship's SKIN catalog could not be loaded.");
      return response.json() as Promise<FirstPartySkin[]>;
    }).catch(error => {
      catalogs.delete(typeID);
      throw error;
    });
    catalogs.set(typeID, pending);
  }
  return pending;
}

export function decodeFirstPartySkinLicenses(answer: unknown): Set<number> {
  return new Set(decodeCharacterSkinLicenses(answer).keys());
}

export function decodeCharacterSkinLicenses(answer: unknown): Map<number, CharacterSkinLicense> {
  const rows = isListValue(answer) ? answer.items : Array.isArray(answer) ? answer : null;
  if (!rows) throw new Error("The SKIN licenses could not be read.");
  const licenses = new Map<number, CharacterSkinLicense>();
  for (const row of rows) {
    const id = Number(unwrapLong(readKeyVal(row, "skinID")) ?? 0n);
    if (Number.isSafeInteger(id) && id > 0) licenses.set(id, {
      expires: unwrapLong(readKeyVal(row, "expires")),
      singleUse: unwrapBool(readKeyVal(row, "isSingleUse")) === true,
    });
  }
  return licenses;
}
