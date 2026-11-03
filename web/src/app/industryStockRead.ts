// Reading what the pilots and their corporations hold of one build tree
// (goal R109 slice 4) — with NO character selected.
//
// ⚠ A SIGN-IN, NEVER A SELECT, exactly as the PI roster read (app/piRosterRead.ts).
// A pilot's stock is in the gateway snapshot, which answers for any pilot the
// signed-in account owns. So each account is signed in on a throwaway token,
// asked about its pilots, and signed out. A sign-in claims no hull; a bot
// flying one of these pilots keeps flying.
//
// ⚠ ONE ACCOUNT AT A TIME, for the hangar refresh's reason: a browser allows
// about six connections per origin, and a dozen sign-ins at once queue the
// player's own clicks behind them.
//
// ⚠ CORP HANGARS NEED A PILOT OF THAT CORP ONLINE, here or flown by a server
// bot (app/corpStockRead.ts), because corp goods are in no pilot's snapshot. A
// corp nobody can read through says so; it is not reported as empty.

import { loadRosterStock as apiLoadRosterStock, login as apiLogin, logout as apiLogout, ROSTER_PLANETS_MAX_IDS } from "./api.ts";
import type { JsonValue } from "../bridge/wire.ts";
import { readCorpStock, type BotPilot, type OnlinePilot } from "./corpStockRead.ts";
import { holdingsFromCorpReads, type CorpStockRead, type Holding, type PilotStockStack } from "../bridge/stockHoldings.ts";
import { decodeRosterStock } from "../bridge/industryStock.ts";

/** A hangar pilot whose stock counts. */
export interface StockPilot {
  readonly characterID: number;
  readonly characterName: string;
  /** The account to sign in as to read it. */
  readonly accountName: string;
}

/** How one pilot's read went. */
export type PilotStockState = "read" | "unanswered" | "no-sign-in";

export interface PilotStockOutcome {
  readonly characterID: number;
  readonly characterName: string;
  readonly state: PilotStockState;
}

export interface IndustryStock {
  readonly holdings: readonly Holding[];
  readonly pilots: readonly PilotStockOutcome[];
  readonly corps: readonly CorpStockRead[];
  /** Each read pilot's own stacks, with where they sit (for where a job can start). */
  readonly hangars: ReadonlyMap<number, readonly PilotStockStack[]>;
}

export interface IndustryStockDeps {
  signIn(accountName: string): Promise<string>;
  signOut(token: string): Promise<void>;
  loadRosterStock(characterIDs: readonly number[], typeIDs: readonly number[], token: string): Promise<JsonValue>;
  readCorpStock(
    corporationIDs: readonly number[],
    online: readonly OnlinePilot[],
    bots: readonly BotPilot[],
    keep: (item: { readonly typeID: number }) => boolean,
  ): Promise<CorpStockRead[]>;
  now(): number;
}

export const LIVE_INDUSTRY_STOCK_DEPS: IndustryStockDeps = {
  async signIn(accountName) {
    const result = await apiLogin(accountName, "", { token: null });
    if (result.sessionToken === null) throw new Error("The server did not return a session token.");
    return result.sessionToken;
  },
  async signOut(token) {
    await apiLogout({ token });
  },
  loadRosterStock: (characterIDs, typeIDs, token) =>
    apiLoadRosterStock(characterIDs, typeIDs, { token, priority: "user" }) as Promise<JsonValue>,
  readCorpStock: (corporationIDs, online, bots, keep) => readCorpStock(corporationIDs, online, bots, keep),
  now: () => Date.now(),
};

export interface IndustryStockRequest {
  readonly pilots: readonly StockPilot[];
  readonly typeIDs: readonly number[];
  /** Pilots online in this tab, for the corp read. */
  readonly online: readonly OnlinePilot[];
  /**
   * Pilots a server bot is flying. A corp with nobody online here is read
   * through one of these, once its own stock read has said which corp it is in.
   */
  readonly botCharacterIDs: ReadonlySet<number>;
}

/** Every pilot's stock of these types, then every reachable corp's. */
export async function readIndustryStock(
  request: IndustryStockRequest,
  deps: IndustryStockDeps = LIVE_INDUSTRY_STOCK_DEPS,
): Promise<IndustryStock> {
  const types = [...new Set(request.typeIDs)].filter((typeID) => typeID > 0);
  const names = new Map(request.pilots.map((pilot) => [pilot.characterID, pilot.characterName]));
  const byAccount = new Map<string, StockPilot[]>();
  for (const pilot of request.pilots) {
    const list = byAccount.get(pilot.accountName) ?? [];
    if (!list.some((entry) => entry.characterID === pilot.characterID)) list.push(pilot);
    byAccount.set(pilot.accountName, list);
  }

  const holdings: Holding[] = [];
  const outcomes: PilotStockOutcome[] = [];
  const corpOf = new Map<number, number>();
  const hangars = new Map<number, readonly PilotStockStack[]>();
  const corporations = new Set<number>(
    request.online.map((pilot) => pilot.corporationID).filter((id): id is number => id !== null),
  );

  if (types.length > 0) {
    for (const [accountName, pilots] of byAccount) {
      let token: string;
      try {
        token = await deps.signIn(accountName);
      } catch {
        for (const pilot of pilots) {
          outcomes.push({ characterID: pilot.characterID, characterName: pilot.characterName, state: "no-sign-in" });
        }
        continue;
      }
      const answered = new Set<number>();
      try {
        for (let start = 0; start < pilots.length; start += ROSTER_PLANETS_MAX_IDS) {
          const chunk = pilots.slice(start, start + ROSTER_PLANETS_MAX_IDS).map((pilot) => pilot.characterID);
          try {
            const decoded = decodeRosterStock(await deps.loadRosterStock(chunk, types, token), deps.now(), names);
            holdings.push(...decoded.holdings);
            for (const pilot of decoded.pilots) {
              answered.add(pilot.characterID);
              hangars.set(pilot.characterID, pilot.stock);
              if (pilot.corporationID !== null) {
                corporations.add(pilot.corporationID);
                corpOf.set(pilot.characterID, pilot.corporationID);
              }
            }
          } catch {
            // This chunk is unanswered; the rest of the account is still asked.
          }
        }
      } finally {
        await deps.signOut(token).catch(() => {});
      }
      for (const pilot of pilots) {
        outcomes.push({
          characterID: pilot.characterID,
          characterName: pilot.characterName,
          state: answered.has(pilot.characterID) ? "read" : "unanswered",
        });
      }
    }
  }

  const wanted = new Set(types);
  let corps: CorpStockRead[] = [];
  if (types.length > 0 && corporations.size > 0) {
    try {
      const bots: BotPilot[] = request.pilots
        .filter((pilot) => request.botCharacterIDs.has(pilot.characterID) && corpOf.has(pilot.characterID))
        .map((pilot) => ({
          characterID: pilot.characterID,
          corporationID: corpOf.get(pilot.characterID) ?? null,
          accountName: pilot.accountName,
        }));
      corps = await deps.readCorpStock([...corporations], request.online, bots, (item) => wanted.has(item.typeID));
    } catch {
      corps = [];
    }
  }
  holdings.push(...holdingsFromCorpReads(corps, null));
  return { holdings, pilots: outcomes, corps, hangars };
}
