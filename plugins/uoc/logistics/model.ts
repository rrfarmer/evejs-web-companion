import { preferredBays } from "../compat/flying.ts";
import type { ParkingDestination } from "../shared/parking.ts";

export type Office = ParkingDestination & { division: number; name?: string };
export type Mode = "MANUAL" | "COLLECTION" | "SUPPLY";
export type Freight = { typeID: number; quantity: number };
export type Config = {
  name: string;
  mode: Mode;
  corporationID: number | null;
  source: Office;
  destination: Office;
  items: (Freight & { name?: string })[];
  allItems?: boolean;
  fillPercent: number;
  waitMinutes: number;
};
export type Carrier = {
  characterID: number;
  account: string;
  name: string;
  shipName?: string;
  corporationID?: number;
  corporationName?: string;
};
export type Stack = Freight & { itemID: number };
export type Stock = Stack & { singleton: boolean; categoryID: number; groupID: number };
export type Volumes = Record<number, { packaged: number | null; assembled: number | null }>;
export type Bay = { key: string; capacity: number; used: number };
export type Load = Stack & { bay: string; singleton: boolean; unitVolumeM3?: number };
export type Unshipped = Freight & { reason: string };
export type FreightBlock = Stack & {
  kind: "unsupported" | "volume" | "oversized" | "space" | "refused";
  reason: string;
};
export type Execution = {
  id: string;
  state: "RUNNING" | "STOPPING" | "STOPPED" | "COMPLETED" | "INCOMPLETE";
  delivered: Record<number, number>;
  trips: number;
  deliveredVolumeM3?: number;
  unshipped?: Unshipped[];
  sourceFinished?: true;
};
export type Operation = { id: string; config: Config; execution: Execution | null };

export const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 160) : undefined;
const nonnegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const sameOffice = (a: Office, b: Office) =>
  a.destinationID === b.destinationID && a.division === b.division;
export const active = (o: Operation) =>
  o.execution?.state === "RUNNING" || o.execution?.state === "STOPPING";

function readOffice(v: unknown): Office {
  if (
    !record(v) ||
    !positive(v.destinationID) ||
    !positive(v.systemID) ||
    (v.kind !== "station" && v.kind !== "structure") ||
    !positive(v.division) ||
    v.division > 7
  )
    throw Error("Choose a docking location and a corporation division from 1 to 7.");
  return {
    kind: v.kind,
    destinationID: v.destinationID,
    systemID: v.systemID,
    division: v.division,
    name: text(v.name),
  };
}

export function readConfig(v: unknown): Config {
  if (!record(v)) throw Error("An operation is required.");
  const { mode, corporationID, fillPercent, waitMinutes } = v;
  const name = text(v.name);
  if (
    !name ||
    (mode !== "MANUAL" && mode !== "COLLECTION" && mode !== "SUPPLY") ||
    (corporationID !== null && !positive(corporationID)) ||
    !Array.isArray(v.items) ||
    !nonnegative(fillPercent) ||
    fillPercent > 100 ||
    !nonnegative(waitMinutes)
  )
    throw Error("Enter a name, mode and valid loading preferences.");
  const source = readOffice(v.source),
    destination = readOffice(v.destination);
  if (sameOffice(source, destination))
    throw Error("Source and destination must be different divisions or docks.");
  const allItems = mode !== "SUPPLY" && v.allItems === true;
  const items = (allItems && mode === "MANUAL" ? [] : v.items).map((item: unknown) => {
    if (
      !record(item) ||
      !positive(item.typeID) ||
      !(positive(item.quantity) || (mode === "COLLECTION" && item.quantity === 0))
    )
      throw Error("Choose items and enter valid whole quantities.");
    return { typeID: item.typeID, quantity: item.quantity, name: text(item.name) };
  });
  if (
    (!allItems && !items.length) ||
    new Set(items.map((item) => item.typeID)).size !== items.length
  )
    throw Error("Choose at least one item from the catalog and enter each item only once.");
  return {
    name,
    mode,
    corporationID,
    source,
    destination,
    items,
    fillPercent,
    waitMinutes,
    ...(allItems ? { allItems } : {}),
  };
}

export function readCarrier(v: unknown): Carrier {
  if (!record(v) || !positive(v.characterID)) throw Error("Choose a saved WC pilot.");
  const account = text(v.account),
    name = text(v.name);
  if (!account || !name) throw Error("The pilot account is unavailable.");
  return {
    characterID: v.characterID,
    account: account.toLowerCase(),
    name,
    shipName: text(v.shipName),
    corporationID: positive(v.corporationID) ? v.corporationID : undefined,
    corporationName: text(v.corporationName),
  };
}

export function counts(rows: readonly Freight[]): Record<number, number> {
  const quantities: Record<number, number> = {};
  for (const row of rows) quantities[row.typeID] = (quantities[row.typeID] ?? 0) + row.quantity;
  return quantities;
}

export type Need = { stock: Stock; available: number };
export function needs(
  config: Config,
  stock: readonly Stock[],
  atDestination: Record<number, number>,
  reserved: Record<number, number>,
): Need[] {
  const remaining = counts(stock);
  const target = Object.fromEntries(config.items.map((item) => [item.typeID, item.quantity]));
  for (const typeID of Object.keys(remaining).map(Number)) {
    const wanted = target[typeID];
    if (config.mode === "COLLECTION") {
      remaining[typeID] =
        wanted !== undefined || config.allItems ? remaining[typeID]! - (wanted ?? 0) : 0;
    } else if (!config.allItems) {
      remaining[typeID] = Math.min(
        remaining[typeID]!,
        (wanted ?? 0) - (atDestination[typeID] ?? 0) - (reserved[typeID] ?? 0),
      );
    }
  }
  return [...stock]
    .sort((a, b) => Number(a.singleton) - Number(b.singleton) || a.itemID - b.itemID)
    .flatMap((row) => {
      const available = Math.min(remaining[row.typeID] ?? 0, row.quantity);
      if (!positive(available)) return [];
      remaining[row.typeID] = remaining[row.typeID]! - available;
      return [{ stock: row, available }];
    });
}

export const candidateBays = (stock: Stock) => [...preferredBays(stock), "cargo"];
export const freightBays = (stock: readonly Stock[]) => [...new Set(stock.flatMap(candidateBays))];
export const freightVolume = (stock: Stock, volumes: Volumes) =>
  stock.singleton ? volumes[stock.typeID]?.assembled : volumes[stock.typeID]?.packaged;
export const canFitUnit = (space: number, m3: number) => space + 1e-8 >= m3;

export function loadFor(
  needs: readonly Need[],
  bays: readonly Bay[],
  volumes: Volumes,
  unreadable: readonly string[] = [],
  otherSpecializedBays: readonly Bay[] = [],
) {
  const room = new Map(bays.map((bay) => [bay.key, Math.max(0, bay.capacity - bay.used)]));
  const lines: Load[] = [];
  const blocked: FreightBlock[] = [];
  const cargo: { stock: Stock; remaining: number; m3: number; priority: number }[] = [];
  function loadInto(stock: Stock, available: number, m3: number, keys: readonly string[]) {
    let remaining = available;
    for (const bay of keys) {
      const free = room.get(bay);
      if (free === undefined) continue;
      const quantity = m3 === 0 ? remaining : Math.min(remaining, Math.floor((free + 1e-8) / m3));
      if (!quantity) continue;
      lines.push({
        itemID: stock.itemID,
        typeID: stock.typeID,
        quantity,
        singleton: stock.singleton,
        bay,
        unitVolumeM3: m3,
      });
      room.set(bay, Math.max(0, free - quantity * m3));
      remaining -= quantity;
      if (!remaining) break;
    }
    return remaining;
  }

  for (const { stock, available } of needs) {
    const m3 = freightVolume(stock, volumes);
    const item = { itemID: stock.itemID, typeID: stock.typeID, quantity: stock.quantity };
    // The game's ordinary cargo hold refuses assembled hulls. Fleet and
    // maintenance bays are outside Distribution's freight holds.
    if (stock.categoryID === 6 && stock.singleton) {
      blocked.push({
        ...item,
        kind: "unsupported",
        reason: "Assembled ships cannot use the freight holds supported by Distribution.",
      });
      continue;
    }
    if (!(typeof m3 === "number" && Number.isFinite(m3) && m3 >= 0)) {
      blocked.push({
        ...item,
        kind: "volume",
        reason: "The game has no verified volume for this item.",
      });
      continue;
    }
    const keys = candidateBays(stock),
      compatible = bays.filter((bay) => keys.includes(bay.key));
    if (
      compatible.every((bay) => !canFitUnit(bay.capacity, m3)) &&
      !keys.some((key) => unreadable.includes(key))
    ) {
      blocked.push({
        ...item,
        kind: "oversized",
        reason: "One unit does not fit in this hauler's compatible holds.",
      });
      continue;
    }
    if (compatible.every((bay) => !canFitUnit(bay.capacity - bay.used, m3))) {
      blocked.push({
        ...item,
        kind: "space",
        reason: "This hauler has no verified free space for one unit.",
      });
      continue;
    }
    const specialized = preferredBays(stock);
    const remaining = loadInto(stock, available, m3, specialized);
    if (!remaining) continue;
    // Save general cargo space for freight that has nowhere else to go.
    // Any space left after that can still carry ore and other specialized freight.
    const priority = !specialized.length
      ? 0
      : otherSpecializedBays.some(
            (bay) => specialized.includes(bay.key) && canFitUnit(bay.capacity, m3),
          )
        ? 2
        : 1;
    cargo.push({ stock, remaining, m3, priority });
  }
  for (const item of cargo.sort((a, b) => a.priority - b.priority))
    loadInto(item.stock, item.remaining, item.m3, ["cargo"]);
  const fill = Math.max(
    0,
    ...bays
      .filter((bay) => lines.some((line) => line.bay === bay.key))
      .map((bay) => {
        const free = bay.capacity - bay.used;
        return free > 0 ? (100 * (free - (room.get(bay.key) ?? 0))) / free : 0;
      }),
  );
  return { lines, fill, blocked };
}

export const minimumFill = (config: Config, since: number, now: number) =>
  now - since >= config.waitMinutes * 60_000 ? 0 : config.fillPercent;
