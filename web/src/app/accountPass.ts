// Speaking as an ACCOUNT from a window that belongs to no pilot.
//
// The Bot Manager and the plugins' windows are global: they open from
// the brand strip on the Pilot Hangar as well as over a cockpit, and a player
// with nobody in the client still has bots to watch and squads to start. Every
// call they make is behind requireAuth and scoped to `req.account.accountID`
// (/api/bots, /api/bots/start, /api/bots/:id/stop, /api/botscripts), so each
// one has to be made BY THE ACCOUNT IT IS ABOUT. All this browser has for an
// account nobody is flying here is its name — and on a server whose login
// takes any password, the name is the credential.
//
// app/stopBotFor.ts does this per call: sign in,
// act, sign out. That is right for a click. It is wrong for a window that polls
// the roster every three seconds across every account the browser knows — a
// sign-in and a sign-out per account per beat. So this holds ONE throwaway
// token per account for as long as the window is open, mints it on first use,
// and signs every one of them out when the window lets go.
//
// ⚠ A SIGN-IN, NEVER A SELECT. A token minted here selects no character, so it
// undocks nothing and claims no hull (the PI Manager plugin's roster read, plugins/pi-manager/lib/piRosterRead.ts, has the full
// argument). The bot host mints its own session for a start; this token only
// names the account that asks.
//
// ⚠ NOT FOR A PILOT THIS TAB IS FLYING. /api/bots/start releases the CALLER's
// held session as part of the start; a throwaway token holds nothing, so a
// start for a pilot signed in HERE must ride that pilot's own session or the
// host refuses with "A web session is flying this character". The callers make
// that fork — `ownerOptions` in the Bot Manager — and fall back to this only
// for a pilot no session here holds.

import {
  login as apiLogin,
  logout as apiLogout,
  type ApiOptions,
} from "./api.ts";

/** What the pass needs from the outside world; tests supply their own. */
export interface AccountPassDeps {
  /** A throwaway session token for this account. Throws when refused. */
  signIn(accountName: string): Promise<string>;
  signOut(token: string): Promise<void>;
}

export interface AccountPass {
  /**
   * Call options that speak as `accountName`, signing it in on first use.
   *
   * A sign-in already in flight is SHARED: two rows asking for the same
   * account in the same tick get one token, not two, and neither is leaked.
   * A refused sign-in is not remembered — the next ask tries again.
   */
  optionsFor(accountName: string): Promise<ApiOptions>;
  /**
   * Drop an account's token without signing it out — for a call that came
   * back 401, whose token the server has already let go of. The next ask
   * signs in afresh.
   */
  forget(accountName: string): void;
  /** Sign every token this pass minted out. Safe to call more than once. */
  release(): Promise<void>;
}

const liveDeps: AccountPassDeps = {
  async signIn(accountName) {
    // `token: null` keeps the tab's own stored token untouched (api.ts login);
    // "user", because the first read of a window someone just opened is a click.
    const result = await apiLogin(accountName, "", { token: null, priority: "user" });
    if (result.sessionToken === null) {
      throw new Error("The server did not return a session token.");
    }
    return result.sessionToken;
  },
  async signOut(token) {
    await apiLogout({ token });
  },
};

export function createAccountPass(deps: AccountPassDeps = liveDeps): AccountPass {
  const tokens = new Map<string, Promise<string>>();
  let released = false;

  return {
    async optionsFor(accountName) {
      if (accountName.length === 0) {
        // A pilot the browser no longer knows an account for. Refused here
        // rather than signed in as "", which the BFF would answer with a
        // sentence about an unknown account that names nothing the player did.
        throw new Error("This browser no longer knows which account that pilot is on.");
      }
      if (released) {
        throw new Error("This window has been closed.");
      }
      let pending = tokens.get(accountName);
      if (pending === undefined) {
        pending = deps.signIn(accountName);
        tokens.set(accountName, pending);
        pending.catch(() => {
          // Only forget THIS attempt: a retry may already have replaced it.
          if (tokens.get(accountName) === pending) tokens.delete(accountName);
        });
      }
      const token = await pending;
      return { token };
    },
    forget(accountName) {
      tokens.delete(accountName);
    },
    async release() {
      released = true;
      const pending = [...tokens.values()];
      tokens.clear();
      await Promise.all(
        pending.map(async (entry) => {
          try {
            await deps.signOut(await entry);
          } catch {
            // A sign-in that never succeeded has nothing to sign out, and a
            // sign-out that fails leaves a token that expires on its own.
          }
        }),
      );
    },
  };
}

/** One account's answer to a roster read. */
export interface AccountRead<T> {
  readonly accountName: string;
  readonly rows: readonly T[];
}

export interface AcrossAccounts<T> {
  /** Every row every account answered with, in account order. */
  readonly rows: readonly T[];
  /** The accounts whose read failed, so a window can say which it cannot see. */
  readonly failed: readonly string[];
}

/**
 * Read one list from every account in turn and merge the answers.
 *
 * ⚠ ONE ACCOUNT AT A TIME, for the PI roster read's reason (plugins/pi-manager/lib/piRosterRead.ts): a browser allows
 * about six connections per origin, and a dozen reads at once queue the
 * player's own clicks behind them.
 *
 * ⚠ A FAILED ACCOUNT IS NAMED, NOT DROPPED. A roster missing one account's bots
 * reads exactly like a roster where that account has none running, and a
 * player acts on "nothing running". The caller says which accounts it could not
 * read; a read where EVERY account failed is the caller's error state.
 */
export async function readAcrossAccounts<T>(
  accountNames: readonly string[],
  read: (accountName: string) => Promise<readonly T[]>,
): Promise<AcrossAccounts<T>> {
  const rows: T[] = [];
  const failed: string[] = [];
  for (const accountName of accountNames) {
    try {
      rows.push(...(await read(accountName)));
    } catch {
      failed.push(accountName);
    }
  }
  return { rows, failed };
}
