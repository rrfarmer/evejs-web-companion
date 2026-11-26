import { isListValue, readDictEntry, unwrapReal, type JsonValue } from "./wire.ts";
import { plainText } from "./clientWords.ts";

export const IN_GAME_STORE_ID = 4;

export function storeEntries(value: unknown): readonly JsonValue[] {
  return isListValue(value) ? value.items : [];
}

export function storeFieldText(value: unknown, key: string): string {
  const field = readDictEntry(value, key);
  return typeof field === "string" ? plainText(field).trim() : "";
}

export function storeEntryID(value: unknown): number | null {
  const id = readDictEntry(value, "id");
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function decodeStoreOffers(value: unknown) {
  return storeEntries(value).flatMap(entry => {
    const id = storeEntryID(entry);
    const name = storeFieldText(entry, "name");
    const products = storeEntries(readDictEntry(entry, "products"));
    if (id === null || !name || products.length === 0) return [];
    const categories = storeEntries(readDictEntry(entry, "categories")).map(storeEntryID).filter(id => id !== null);
    const productTypes = products.flatMap(product => {
      const typeID = readDictEntry(product, "typeId");
      return typeof typeID === "number" && Number.isSafeInteger(typeID) ? [typeID] : [];
    });
    const plex = storeEntries(readDictEntry(entry, "offerPricings")).find(price => readDictEntry(price, "currency") === "PLX");
    const plexPrice = unwrapReal(readDictEntry(plex, "price"));
    return [{ id, name, description: storeFieldText(entry, "description"), categories, productTypes,
      plexPrice: plexPrice !== null && plexPrice >= 0 ? plexPrice : null }];
  });
}
