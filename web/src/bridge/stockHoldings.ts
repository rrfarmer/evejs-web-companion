// What a pilot or a corporation holds, and where, as pure functions.
//
// Shared by every view that counts goods across pilots (the Industry Manager's
// build tree, the PI Manager's stock): a holding is so much of one type, in one
// place, owned by one pilot or corporation. A total alone cannot be planned
// with, so a holding is never merged across places.
//
// Corporation hangars are read through a pilot of that corporation who is
// online (app/corpStockRead.ts), because corp-owned goods are in no pilot's
// snapshot.

import type { JsonValue } from "./wire.ts";

/** Where a holding sits, in the three kinds that plan differently. */
export type HoldingSource = "colony" | "hangar" | "corp";

/** So much of one type, in one place. */
export interface Holding {
  readonly typeID: number;
  readonly typeName: string | null;
  readonly quantity: number;
  readonly source: HoldingSource;
  /** "Alpha III launchpad", "Alpha VI - Moon 1 - Station, in Hauler One". */
  readonly placeWords: string;
  /** The pilot, or the corporation, it belongs to. */
  readonly ownerWords: string;
  /** The planet a colony holding sits on; null for a hangar or a corp office. */
  readonly planetID: number | null;
  /**
   * True for what sits in a factory's input buffer: it is held, but already
   * committed to the recipe that factory runs, so the planner does not count it.
   */
  readonly inFactory?: boolean;
  /** When it was read, on the server's clock; null when unknown. */
  readonly readAtMs: number | null;
  /** The server's clock minus the browser's, for this holding's read. */
  readonly clockOffsetMs: number;
}

/** One corporation-owned stack, from the corp asset read. */
export interface CorpStockItem {
  readonly typeID: number;
  readonly quantity: number;
  readonly locationID: number;
  /** Null when the place could not be named — never the id (R7d). */
  readonly locationName: string | null;
  /** The hangar division, 1 to 7; null when the flag is not a division. */
  readonly division: number | null;
}

/** What reading one corporation's hangars came to. */
export interface CorpStockRead {
  readonly corporationID: number;
  readonly corporationName: string | null;
  /**
   * - `read`         a pilot of it answered; `items` is the whole answer
   * - `failed`       every pilot of it online here or flown by a server bot
   *                  was tried and refused
   * - `unreachable`  none of its pilots is online in this tab or flown by a
   *                  server bot
   */
  readonly state: "read" | "failed" | "unreachable";
  /** The pilot whose session read it. */
  readonly viaCharacterID: number | null;
  /** True when that session was a server bot's, not this tab's. */
  readonly viaBot: boolean;
  /** The browser's clock when the read landed. */
  readonly readAtMs: number | null;
  readonly items: readonly CorpStockItem[];
  /** Pilots tried before one answered (or all of them, when none did). */
  readonly refusals: readonly { readonly characterID: number; readonly reason: string }[];
}

// flagCorpSAG1..7 are flags 115..121: division N is flag 114 + N (the same
// mapping src/server.js keeps for the corp hangar routes).
const CORP_DIVISION_FLAG_BASE = 114;

/** The corp hangar division a flag names, or null for any other flag. */
export function corpDivisionOfFlag(flagID: number): number | null {
  const division = flagID - CORP_DIVISION_FLAG_BASE;
  return Number.isSafeInteger(division) && division >= 1 && division <= 7 ? division : null;
}

// NPC corporations own no hangars a player plans with: EVE's documented id
// range for them is 1,000,000 to 1,999,999 (as standings.ts reads it).
const NPC_CORP_MIN = 1_000_000;
const NPC_CORP_MAX = 1_999_999;

/** A player corporation, whose hangars are worth reading. */
export function isPlayerCorporation(corporationID: number | null | undefined): corporationID is number {
  return typeof corporationID === "number"
    && Number.isSafeInteger(corporationID)
    && corporationID > 0
    && (corporationID < NPC_CORP_MIN || corporationID > NPC_CORP_MAX);
}

/** Whole numbers the way the rest of the app writes them. */
export function countWords(value: number): string {
  return Math.round(Math.max(0, value)).toLocaleString("en-US");
}

/** What holds a stack inside the station: nothing (the hangar), a ship, a container. */
export type StockHolder = "hangar" | "ship" | "container";

/** So much of one good, in one place, owned by the pilot. */
export interface PilotStockStack {
  readonly typeID: number;
  readonly typeName: string | null;
  readonly quantity: number;
  /** The station it is docked at; null when the read could not place it. */
  readonly locationID: number | null;
  /** Null when the static map does not name the place — never the id (R7d). */
  readonly locationName: string | null;
  readonly holder: StockHolder;
  /** The ship's or container's name; null in the hangar. */
  readonly holderName: string | null;
}

const HOLDERS: readonly StockHolder[] = ["hangar", "ship", "container"];

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

export function decodeStockStack(value: JsonValue): PilotStockStack | null {
  const record = asRecord(value);
  const typeID = Number(record.typeID);
  const quantity = Number(record.quantity);
  if (!Number.isSafeInteger(typeID) || typeID <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  const locationID = Number(record.locationID);
  const holder = HOLDERS.find((entry) => entry === record.holder) ?? "hangar";
  const name = (field: JsonValue | undefined): string | null =>
    typeof field === "string" && field.length > 0 ? field : null;
  return {
    typeID,
    typeName: name(record.typeName),
    quantity,
    locationID: Number.isSafeInteger(locationID) && locationID > 0 ? locationID : null,
    locationName: name(record.locationName),
    holder,
    holderName: holder === "hangar" ? null : name(record.holderName),
  };
}

export function stationWords(stack: PilotStockStack): string {
  const place = stack.locationName ?? "a place this map does not name";
  if (stack.holder === "ship") {
    return stack.holderName ? `${place}, in ${stack.holderName}'s cargo` : `${place}, in a ship's cargo`;
  }
  if (stack.holder === "container") {
    return stack.holderName ? `${place}, in ${stack.holderName}` : `${place}, in a container`;
  }
  return `${place} hangar`;
}

/**
 * Corporation hangar holdings, for the corps that were read. `typeName` names
 * a type when the caller has a name book; without one the view names it.
 */
export function holdingsFromCorpReads(
  reads: readonly CorpStockRead[],
  typeName: ((typeID: number) => string | null) | null,
): Holding[] {
  const holdings: Holding[] = [];
  for (const read of reads) {
    if (read.state !== "read") continue;
    const ownerWords = read.corporationName ?? "Your corporation";
    for (const item of read.items) {
      const place = item.locationName ?? "a station this map does not name";
      holdings.push({
        typeID: item.typeID,
        typeName: typeName ? typeName(item.typeID) : null,
        quantity: item.quantity,
        source: "corp",
        placeWords: item.division === null ? `${place} office` : `${place} office, division ${item.division}`,
        ownerWords,
        planetID: null,
        // The corp read is stamped on the browser's clock, so no correction.
        readAtMs: read.readAtMs,
        clockOffsetMs: 0,
      });
    }
  }
  return holdings;
}

const SOURCE_ORDER: Readonly<Record<HoldingSource, number>> = Object.freeze({ colony: 0, hangar: 1, corp: 2 });

/** Colony first, then hangars, then corp; largest first within each. */
export function compareHoldings(left: Holding, right: Holding): number {
  return SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source] || right.quantity - left.quantity;
}
