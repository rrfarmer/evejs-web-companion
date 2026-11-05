// Reading the PI roster's colonies (R108 slice 3) — with NO character selected.
//
// ⚠ A SIGN-IN, NEVER A SELECT. Reading a colony needs only ownership: the
// gateway's /snapshot is gated by validateOwnedCharacter and nothing else
// (proved live, see GET /api/roster/planets in src/server.js). So this does what
// the hangar's roster refresh does (app/rosterRefresh.ts): signs the account in
// on a THROWAWAY token, asks, and signs that token out. A sign-in claims no hull.
// A select would — it applies the character and undocks it, and a bot flying
// that pilot in another tab or on another device, which nothing here can see,
// would lose its ship without a word. Acting on a colony needs a select and so
// goes through the bot host; it never starts here.
//
// ⚠ ONE ACCOUNT AT A TIME, for the hangar refresh's reason: a browser allows
// about six connections per origin, and a dozen sign-ins at once queue the
// player's own clicks behind them.
//
// Every pilot comes back with its own outcome, so the board can say which pilot
// was read, which could not be, and which has no account to read with.

import { ROSTER_PLANETS_MAX_IDS, getPiSchematics as apiGetPiSchematics, loadRosterPlanets as apiLoadRosterPlanets, login as apiLogin, logout as apiLogout } from "../../../web/src/plugin-api/index.ts";
import type { JsonValue } from "../../../web/src/plugin-api/index.ts";
import { decodeRosterColonies } from "./piRoster.ts";
import type { PilotAttempt } from "./piBoard.ts";

/** What the read needs from the outside world; tests supply their own. */
export interface PiReadDeps {
  /** A throwaway session token for this account. Throws when refused. */
  signIn(accountName: string): Promise<string>;
  signOut(token: string): Promise<void>;
  loadRosterPlanets(characterIDs: readonly number[], token: string): Promise<JsonValue>;
  /** The browser's clock, for each answer's clock correction. */
  now(): number;
  /** The planetary recipe table (static; any signed-in caller may read it). */
  loadRecipes(token: string): Promise<JsonValue>;
}

export interface PiReadOptions {
  /**
   * Asked for, the recipe table is read ONCE, inside the first sign-in that
   * succeeds — the window has no token of its own to read it with. A failure
   * is silent: without the table a starved factory is judged by its routes.
   */
  readonly onRecipes?: (raw: JsonValue) => void;
}

export interface PiAnswer {
  readonly envelope: JsonValue;
  readonly browserNowMs: number;
}

export interface PiAccountRead {
  /** Null for the pilots the hangar no longer knows an account for. */
  readonly accountName: string | null;
  /** Every answer that came back, one per ask, in order. */
  readonly answers: readonly PiAnswer[];
  /** One outcome per pilot of this account, in roster order. */
  readonly attempts: ReadonlyMap<number, PilotAttempt>;
}

/** Who the hangar says each pilot belongs to. */
export interface PilotAccount {
  readonly characterID: number;
  readonly accountName: string;
}

export const DEFAULT_PI_READ_DEPS: PiReadDeps = {
  async signIn(accountName) {
    // Any password, as the hangar signs in: on this server the account name is
    // the credential. `token: null` keeps the tab's own session untouched.
    const result = await apiLogin(accountName, "", { token: null });
    if (result.sessionToken === null) {
      throw new Error("The server did not return a session token.");
    }
    return result.sessionToken;
  },
  async signOut(token) {
    await apiLogout({ token });
  },
  loadRosterPlanets(characterIDs, token) {
    return apiLoadRosterPlanets(characterIDs, { token, priority: "user" });
  },
  now: () => Date.now(),
  async loadRecipes(token) {
    return (await apiGetPiSchematics({ token, priority: "user" })).recipes;
  },
};

function chunks(ids: readonly number[]): number[][] {
  const out: number[][] = [];
  for (let index = 0; index < ids.length; index += ROSTER_PLANETS_MAX_IDS) {
    out.push(ids.slice(index, index + ROSTER_PLANETS_MAX_IDS));
  }
  return out;
}

async function readAccount(
  accountName: string,
  characterIDs: readonly number[],
  deps: PiReadDeps,
  whileSignedIn: (token: string) => Promise<void>,
): Promise<PiAccountRead> {
  const attempts = new Map<number, PilotAttempt>(characterIDs.map((id) => [id, "failed"]));
  const answers: PiAnswer[] = [];
  let token: string;
  try {
    token = await deps.signIn(accountName);
  } catch {
    return { accountName, answers, attempts };
  }
  try {
    await whileSignedIn(token);
    for (const ask of chunks(characterIDs)) {
      let envelope: JsonValue;
      try {
        envelope = await deps.loadRosterPlanets(ask, token);
      } catch {
        continue; // this chunk stays "failed"; the next may still answer
      }
      const browserNowMs = deps.now();
      answers.push({ envelope, browserNowMs });
      const answered = new Set(
        decodeRosterColonies(envelope, browserNowMs).map((reading) => reading.characterID),
      );
      for (const characterID of ask) {
        attempts.set(characterID, answered.has(characterID) ? "read" : "unanswered");
      }
    }
  } finally {
    await deps.signOut(token).catch(() => {});
  }
  return { accountName, answers, attempts };
}

/**
 * Read every roster pilot's colonies, account by account.
 *
 * `onAccountDone` fires as each account finishes, so the window can repaint
 * those pilots' rows while the rest are still being read.
 */
export async function readPiRoster(
  members: readonly number[],
  known: readonly PilotAccount[],
  deps: PiReadDeps = DEFAULT_PI_READ_DEPS,
  onAccountDone: (result: PiAccountRead) => void = () => {},
  options: PiReadOptions = {},
): Promise<PiAccountRead[]> {
  const accountOf = new Map(known.map((entry) => [entry.characterID, entry.accountName]));
  const byAccount = new Map<string, number[]>();
  const orphans: number[] = [];
  for (const characterID of members) {
    const accountName = accountOf.get(characterID);
    if (accountName === undefined) {
      orphans.push(characterID);
      continue;
    }
    const ids = byAccount.get(accountName) ?? [];
    if (!ids.includes(characterID)) ids.push(characterID);
    byAccount.set(accountName, ids);
  }

  const results: PiAccountRead[] = [];
  if (orphans.length > 0) {
    const orphaned: PiAccountRead = {
      accountName: null,
      answers: [],
      attempts: new Map(orphans.map((id) => [id, "no-account" as const])),
    };
    results.push(orphaned);
    onAccountDone(orphaned);
  }
  let recipesWanted = options.onRecipes !== undefined;
  const readRecipes = async (token: string): Promise<void> => {
    if (!recipesWanted) return;
    recipesWanted = false;
    try {
      options.onRecipes?.(await deps.loadRecipes(token));
    } catch {
      // Silent on purpose: the board judges starvation by routes without it.
    }
  };
  for (const [accountName, characterIDs] of byAccount) {
    const result = await readAccount(accountName, characterIDs, deps, readRecipes);
    results.push(result);
    onAccountDone(result);
  }
  return results;
}
