// Reading corporation hangars, for every view that counts goods across
// pilots (the PI board, R108 slice 5; the Industry Manager, R109).
//
// ⚠ THE ONE READ THAT NEEDS A PILOT ONLINE. Colonies and personal hangars come
// from each pilot's gateway snapshot with nobody selected (piRosterRead.ts),
// but corp-owned goods are in no pilot's snapshot: the snapshot is filtered to
// the character as owner. The corp asset read (corpmgr) runs on a HELD session,
// so it is made through a pilot of that corporation who is ALREADY online:
//
//   • online in this tab — riding that pilot's own session
//     (GET /api/bridge/corp-assets);
//   • flown by a server bot of the player's — on the bot's session, through a
//     read-only route that never selects, releases or stops anything
//     (GET /api/bots/corp-assets). The call itself is made as the pilot's
//     ACCOUNT on a throwaway sign-in, the roster read's pattern, signed in only
//     when a bot is actually tried and signed out when the read ends.
//
// Nobody is selected and nobody is brought online. A corp with neither is
// reported as such; the board says so beside the numbers and offers no sign-in.
//
// ⚠ ONE PILOT PER CORPORATION, TRIED IN TURN, THIS TAB'S FIRST. Every member
// reads the same hangars, so the first pilot that answers is the answer. A
// pilot that is refused (no hangar access, a stale session, a bot that just
// ended) is recorded against that pilot and the next one is tried: in a game
// where roles differ, one pilot's refusal must not hide goods another can see.
//
// ⚠ ONE OFFICE AT A TIME, for the reason piRosterRead.ts reads one account at
// a time: the browser allows about six connections per origin, and the player's
// own clicks must not queue behind a sweep.

import {
  loadBotCorpAssets as apiLoadBotCorpAssets,
  loadCorpAssets as apiLoadCorpAssets,
  login as apiLogin,
  logout as apiLogout,
  resolveNames as apiResolveNames,
  type ApiOptions,
  type ResolveNamesResult,
} from "./api.ts";
import type { JsonValue } from "../bridge/wire.ts";
import type { NameRef } from "../store/names.ts";
import { decodeCorpAssetItems, decodeCorpAssetLocations } from "../bridge/corpAssets.ts";
import { corpDivisionOfFlag, isPlayerCorporation, type CorpStockItem, type CorpStockRead } from "../bridge/stockHoldings.ts";

/** A pilot online in this tab, as the corp read needs it. */
export interface OnlinePilot {
  readonly characterID: number;
  readonly corporationID: number | null;
  /** The pilot's own session: every call here rides it. */
  readonly options: ApiOptions;
}

/** A roster pilot a server bot is flying, as the corp read needs it. */
export interface BotPilot {
  readonly characterID: number;
  readonly corporationID: number | null;
  /** The account the throwaway sign-in is made as. */
  readonly accountName: string;
}

export interface CorpStockReadDeps {
  loadCorpAssets(locationID: number | null, options: ApiOptions): Promise<Record<string, JsonValue>>;
  loadBotCorpAssets(characterID: number, locationID: number | null, options: ApiOptions): Promise<Record<string, JsonValue>>;
  resolveNames(items: readonly NameRef[], options: ApiOptions): Promise<ResolveNamesResult>;
  /** A throwaway session token for this account. Throws when refused. */
  signIn(accountName: string): Promise<string>;
  signOut(token: string): Promise<void>;
  /** The browser's clock. */
  now(): number;
}

const LIVE_DEPS: CorpStockReadDeps = {
  loadCorpAssets: (locationID, options) => apiLoadCorpAssets(locationID, options),
  loadBotCorpAssets: (characterID, locationID, options) => apiLoadBotCorpAssets(characterID, locationID, options),
  resolveNames: (items, options) => apiResolveNames(items, options),
  async signIn(accountName) {
    // As the roster read signs in: `token: null` keeps the tab's own session
    // untouched, and a sign-in claims no hull.
    const result = await apiLogin(accountName, "", { token: null });
    if (result.sessionToken === null) throw new Error("The server did not return a session token.");
    return result.sessionToken;
  },
  async signOut(token) {
    await apiLogout({ token });
  },
  now: () => Date.now(),
};

/** One pilot a corp can be read through, whichever session it rides. */
interface Reader {
  readonly characterID: number;
  readonly viaBot: boolean;
  /** Options for the calls; a bot's are its account's throwaway sign-in. */
  options(): Promise<ApiOptions>;
  load(locationID: number | null, options: ApiOptions): Promise<Record<string, JsonValue>>;
}

/**
 * Which corp stacks a read keeps. Every caller says: the PI board keeps
 * planetary goods, the Industry Manager (R109) the types of one build tree.
 */
export type CorpItemFilter = (item: { readonly typeID: number; readonly categoryID: number }) => boolean;

function refusalWords(error: unknown): string {
  const message = error instanceof Error && error.message.length > 0 ? error.message : null;
  return message ?? "the read failed";
}

function errorCode(body: Record<string, JsonValue>, field: string): string | null {
  const errors = body.errors;
  if (errors === null || typeof errors !== "object" || Array.isArray(errors)) return null;
  const code = (errors as Record<string, JsonValue>)[field];
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** Every stack `keep` wants in the corp's offices, through one pilot. Throws when refused. */
async function readThrough(
  reader: Reader,
  corporationID: number,
  deps: CorpStockReadDeps,
  keep: CorpItemFilter,
): Promise<{ items: CorpStockItem[]; name: string | null }> {
  const options = await reader.options();
  const first = await reader.load(null, options);
  const refused = errorCode(first, "inventory");
  if (refused !== null) {
    throw new Error(`the server refused the corporation asset read (${refused})`);
  }
  const locations = decodeCorpAssetLocations(first.inventory ?? null);
  const raw: { locationID: number; typeID: number; quantity: number; division: number | null }[] = [];
  for (const location of locations) {
    const body = await reader.load(location.locationID, options);
    const code = errorCode(body, "locationInventory");
    if (code !== null) {
      throw new Error(`the server refused to list an office (${code})`);
    }
    for (const item of decodeCorpAssetItems(body.locationInventory ?? null)) {
      if (!keep(item) || item.units <= 0) continue;
      raw.push({
        locationID: location.locationID,
        typeID: item.typeID,
        quantity: item.units,
        division: corpDivisionOfFlag(item.flagID),
      });
    }
  }

  // Names in one round trip: the offices' stations and the corporation itself.
  // A name that does not come back is left null and worded by the board.
  const refs: NameRef[] = [
    { kind: "corporation", id: corporationID },
    ...[...new Set(raw.map((entry) => entry.locationID))].map((id) => ({ kind: "station" as const, id })),
  ];
  let names: Readonly<Record<string, string | null>> = {};
  try {
    names = (await deps.resolveNames(refs, options)).names;
  } catch {
    // Unnamed is still counted: the quantities are the point.
  }

  // One line per type, office and division.
  const merged = new Map<string, CorpStockItem>();
  for (const entry of raw) {
    const key = `${entry.typeID}:${entry.locationID}:${entry.division ?? ""}`;
    const known = merged.get(key);
    merged.set(key, known
      ? { ...known, quantity: known.quantity + entry.quantity }
      : {
          typeID: entry.typeID,
          quantity: entry.quantity,
          locationID: entry.locationID,
          locationName: names[`station:${entry.locationID}`] ?? null,
          division: entry.division,
        });
  }
  return { items: [...merged.values()], name: names[`corporation:${corporationID}`] ?? null };
}

/**
 * Read the hangars of every player corporation in `corporationIDs`, each
 * through the first of its pilots that answers: those online in this tab
 * first, then those a server bot is flying.
 */
export async function readCorpStock(
  corporationIDs: readonly number[],
  online: readonly OnlinePilot[],
  bots: readonly BotPilot[],
  keep: CorpItemFilter,
  deps: CorpStockReadDeps = LIVE_DEPS,
): Promise<CorpStockRead[]> {
  // One throwaway sign-in per account, made the first time one of its bots is
  // tried, and every one of them signed out when the read ends.
  const signIns = new Map<string, Promise<string>>();
  const botOptions = (accountName: string): Promise<ApiOptions> => {
    let token = signIns.get(accountName);
    if (token === undefined) {
      token = deps.signIn(accountName);
      signIns.set(accountName, token);
    }
    return token.then(
      (value): ApiOptions => ({ token: value, priority: "user" }),
      () => {
        throw new Error("could not sign in to this pilot's account");
      },
    );
  };

  const reads: CorpStockRead[] = [];
  try {
    for (const corporationID of [...new Set(corporationIDs)].filter(isPlayerCorporation)) {
      const inTab = online.filter((pilot) => pilot.corporationID === corporationID);
      const held = new Set(inTab.map((pilot) => pilot.characterID));
      const candidates: Reader[] = [
        ...inTab.map((pilot): Reader => ({
          characterID: pilot.characterID,
          viaBot: false,
          options: async () => pilot.options,
          load: (locationID, options) => deps.loadCorpAssets(locationID, options),
        })),
        ...bots
          .filter((bot) => bot.corporationID === corporationID && !held.has(bot.characterID))
          .map((bot): Reader => ({
            characterID: bot.characterID,
            viaBot: true,
            options: () => botOptions(bot.accountName),
            load: (locationID, options) => deps.loadBotCorpAssets(bot.characterID, locationID, options),
          })),
      ];
      if (candidates.length === 0) {
        reads.push({
          corporationID,
          corporationName: null,
          state: "unreachable",
          viaCharacterID: null,
          viaBot: false,
          readAtMs: null,
          items: [],
          refusals: [],
        });
        continue;
      }
      const refusals: { characterID: number; reason: string }[] = [];
      let done: CorpStockRead | null = null;
      for (const reader of candidates) {
        try {
          const { items, name } = await readThrough(reader, corporationID, deps, keep);
          done = {
            corporationID,
            corporationName: name,
            state: "read",
            viaCharacterID: reader.characterID,
            viaBot: reader.viaBot,
            readAtMs: deps.now(),
            items,
            refusals: [...refusals],
          };
          break;
        } catch (error) {
          refusals.push({ characterID: reader.characterID, reason: refusalWords(error) });
        }
      }
      reads.push(done ?? {
        corporationID,
        corporationName: null,
        state: "failed",
        viaCharacterID: null,
        viaBot: false,
        readAtMs: null,
        items: [],
        refusals,
      });
    }
  } finally {
    for (const token of signIns.values()) {
      await token.then((value) => deps.signOut(value)).catch(() => {});
    }
  }
  return reads;
}
