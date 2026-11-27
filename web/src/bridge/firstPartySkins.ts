import { isListValue, readKeyVal, unwrapLong } from "./wire.ts";

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

export function decodeCharacterSkinLicenses(answer: unknown): Map<number, bigint | null> {
  const rows = isListValue(answer) ? answer.items : Array.isArray(answer) ? answer : null;
  if (!rows) throw new Error("The SKIN licenses could not be read.");
  const licenses = new Map<number, bigint | null>();
  for (const row of rows) {
    const id = Number(unwrapLong(readKeyVal(row, "skinID")) ?? 0n);
    if (Number.isSafeInteger(id) && id > 0) licenses.set(id, unwrapLong(readKeyVal(row, "expires")));
  }
  return licenses;
}
