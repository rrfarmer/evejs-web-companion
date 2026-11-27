import { isListValue, readKeyVal, unwrapLong } from "./wire.ts";

export interface FirstPartySkin {
  readonly skinID: number;
  readonly materialID: number;
  readonly materialSetID: number | null;
  readonly nameID: number;
  readonly visible: boolean;
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
  const rows = isListValue(answer) ? answer.items : Array.isArray(answer) ? answer : null;
  if (!rows) throw new Error("The SKIN licenses could not be read.");
  const ids = rows.map(row => Number(unwrapLong(readKeyVal(row, "skinID")) ?? 0n));
  return new Set(ids.filter(id => Number.isSafeInteger(id) && id > 0));
}
