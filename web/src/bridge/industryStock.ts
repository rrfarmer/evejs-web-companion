// What the pilots and their corporations hold of one build tree, and what a
// plan still lacks (goal R109 slice 4). Pure; the reads are app/industryStockRead.ts.
//
// ---------------------------------------------------------------------------
// THE SAME HOLDINGS AS PLANETARY INDUSTRY.
//
// A unit held is a `Holding` (bridge/stockHoldings.ts): so much of one type, in one
// place, belonging to one pilot or corporation, read at one instant. Holdings
// are never merged across places; the resolver is handed the per-type sum, and
// the screen keeps every place so a unit is always said with where it sits.
//
// ---------------------------------------------------------------------------
// CORP STOCK ALWAYS COUNTS. A solo player's corporation hangar is theirs; there
// is no switch to leave it out. It is shown apart from personal hangars, but it
// is in the sum.
//
// ---------------------------------------------------------------------------
// SEVERAL READS ARE SEVERAL MOMENTS. Pilots are read one account at a time and
// the corp through whoever answers; when those instants are far apart the plan
// says so, rather than presenting the sum as one moment.

import type { JsonValue } from "./wire.ts";
import type { IndustryChain, IndustryLine } from "./industryChain.ts";
import { compareHoldings, decodeStockStack, stationWords, type Holding, type PilotStockStack } from "./stockHoldings.ts";

/** One pilot's answer to a stock read. */
export interface PilotStockAnswer {
  readonly characterID: number;
  readonly corporationID: number | null;
  /** On the server's clock. */
  readonly readAtMs: number;
  /** Every stack, with its station and holder: where a job could draw it from. */
  readonly stock: readonly PilotStockStack[];
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, JsonValue>) : {};
}

/**
 * One `POST /api/roster/stock` answer into holdings. `names` names the pilots;
 * a pilot the hangar no longer knows is still counted, under a plain
 * description. A pilot the answer left out is simply not here: the caller
 * tells "not answered" from "holds none" by `pilots`.
 */
export function decodeRosterStock(
  envelope: JsonValue,
  browserNowMs: number,
  names: ReadonlyMap<number, string>,
): { readonly pilots: PilotStockAnswer[]; readonly holdings: Holding[] } {
  const body = asRecord(envelope);
  const serverNowMs = Number(body.serverNowMs);
  const clockOffsetMs = Number.isFinite(serverNowMs) ? serverNowMs - browserNowMs : 0;
  const pilots: PilotStockAnswer[] = [];
  const holdings: Holding[] = [];
  for (const raw of Array.isArray(body.pilots) ? body.pilots : []) {
    const entry = asRecord(raw);
    const characterID = Number(entry.characterID);
    const readAtMs = Number(entry.readAtMs);
    if (!Number.isSafeInteger(characterID) || characterID <= 0 || !Number.isFinite(readAtMs)) {
      continue;
    }
    const corporationID = Number(entry.corporationID);
    const stacks: PilotStockStack[] = [];
    pilots.push({
      characterID,
      corporationID: Number.isSafeInteger(corporationID) && corporationID > 0 ? corporationID : null,
      readAtMs,
      stock: stacks,
    });
    const ownerWords = names.get(characterID) ?? "A pilot no longer in the hangar";
    for (const value of Array.isArray(entry.stock) ? entry.stock : []) {
      const stack = decodeStockStack(value);
      if (stack === null) continue;
      stacks.push(stack);
      holdings.push({
        typeID: stack.typeID,
        // Named from the recipe book on screen; the wire name may be a fallback.
        typeName: null,
        quantity: stack.quantity,
        source: "hangar",
        placeWords: stationWords(stack),
        ownerWords,
        planetID: null,
        readAtMs,
        clockOffsetMs,
      });
    }
  }
  return { pilots, holdings };
}

/** Units held per type, every place added up: what the resolver nets against. */
export function heldByType(holdings: readonly Holding[]): Map<number, number> {
  const held = new Map<number, number>();
  for (const holding of holdings) {
    if (holding.inFactory || holding.quantity <= 0) continue;
    held.set(holding.typeID, (held.get(holding.typeID) ?? 0) + holding.quantity);
  }
  return held;
}

/** Every place each type is held, personal hangars before corp, largest first. */
export function holdingsByType(holdings: readonly Holding[]): Map<number, Holding[]> {
  const byType = new Map<number, Holding[]>();
  for (const holding of holdings) {
    const list = byType.get(holding.typeID) ?? [];
    list.push(holding);
    byType.set(holding.typeID, list);
  }
  for (const list of byType.values()) {
    list.sort(compareHoldings);
  }
  return byType;
}

/** "3 minutes", "2 hours". Plain words for an age. */
export function ageWords(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/** Reads further apart than this are called out as different moments. */
export const STALE_SPREAD_MS = 2 * 60_000;

/**
 * Null when every holding was read at about the same moment; otherwise the
 * sentence that says how old the oldest one is.
 */
export function staleWords(holdings: readonly Holding[], browserNowMs: number): string | null {
  let oldest: number | null = null;
  let newest: number | null = null;
  for (const holding of holdings) {
    if (holding.readAtMs === null) continue;
    // Back on the browser's clock, so all reads compare on one clock.
    const at = holding.readAtMs - holding.clockOffsetMs;
    oldest = oldest === null ? at : Math.min(oldest, at);
    newest = newest === null ? at : Math.max(newest, at);
  }
  if (oldest === null || newest === null || newest - oldest < STALE_SPREAD_MS) {
    return null;
  }
  return `Read at different times - the oldest is ${ageWords(browserNowMs - oldest)} old.`;
}

/**
 * The buy list as the game's multibuy box takes it: one "Name quantity" line
 * per item. A line with no name cannot be pasted and is counted instead.
 */
export function multibuyText(
  lines: readonly Pick<IndustryLine, "name" | "short">[],
): { readonly text: string; readonly unnamed: number } {
  const rows: string[] = [];
  let unnamed = 0;
  for (const line of lines) {
    if (line.short <= 0) continue;
    if (line.name === null) {
      unnamed += 1;
      continue;
    }
    rows.push(`${line.name} ${Math.round(line.short)}`);
  }
  return { text: rows.join("\n"), unnamed };
}

export type StandingTone = "ok" | "act" | "bad";

/** How a plan stands against what is held, for its card and its verdict. */
export interface PlanStanding {
  /** Things to buy that are not held in full. */
  readonly missing: number;
  /** Things the plan buys at all. */
  readonly buys: number;
  /** 0..1: the share of bought things already held in full. */
  readonly share: number;
  readonly tone: StandingTone;
  readonly words: string;
}

/**
 * Covered when nothing to buy is short; otherwise how many things are.
 * Building is work, not a gap: a component that still has to be built is not
 * "missing" when everything it is built from is held.
 */
export function planStanding(chain: IndustryChain): PlanStanding {
  let buys = 0;
  let missing = 0;
  for (const line of chain.lines.values()) {
    if (line.obtain !== "buy" || line.needed <= 0) continue;
    buys += 1;
    if (line.short > 0) missing += 1;
  }
  const share = buys === 0 ? 1 : (buys - missing) / buys;
  if (missing === 0) {
    return { missing, buys, share, tone: "ok", words: "covered" };
  }
  return {
    missing,
    buys,
    share,
    tone: share >= 0.5 ? "act" : "bad",
    words: `${missing} missing`,
  };
}
