// Which token a global window's call rides — one answer, shared by every window
// that is about ALL the pilots rather than the one on screen (the Bot Manager,
// the plugins' windows).
//
// ⚠ NEVER THE ACTIVE PILOT'S. These windows open from the Pilot Hangar with
// nobody in the client, and over a cockpit they are about every pilot. Every
// call they make is scoped server-side to the CALLING account, so each one is
// made by the account it is about:
//
//   • a pilot this tab is flying rides its OWN session. /api/bots/start
//     releases the caller's held session as part of the start, so for a hull
//     this tab holds only that pilot's session can hand it over;
//   • anyone else is reached as their ACCOUNT, through a throwaway sign-in held
//     for as long as the window is open (app/accountPass.ts).
//
// Riding one pilot's token for everybody — what these windows used to do — lists
// one account's bots, and refuses every member of a group on any other account
// with "Character does not belong to the supplied account".

import { listServerBots, type ApiOptions, type ServerBot } from "./api.ts";
import { createAccountPass, readAcrossAccounts, type AccountPass } from "./accountPass.ts";

/** The slice of a held session this module reads. */
export interface HeldPilot {
  readonly store: { readonly station: { get(): { readonly online: { readonly characterID: number } | null } } };
  readonly flow: { requestOptions(): ApiOptions };
}

/** The slice of a known-character row this module reads. */
export interface KnownPilot {
  readonly characterID: number;
  readonly accountName: string;
}

export interface PilotReachDeps {
  /** Every pilot this tab holds, read at call time. */
  held(): readonly HeldPilot[];
  /** Every pilot this browser knows an account for, read at call time. */
  known(): readonly KnownPilot[];
  /** Every account this browser knows, read at call time. */
  accounts(): readonly string[];
  /** Defaults to a live pass; tests supply their own. */
  pass?: AccountPass;
  /** Defaults to GET /api/bots; tests supply their own. */
  listServerBots?: (options: ApiOptions) => Promise<readonly ServerBot[]>;
}

/** What one roster read across every account found. */
export interface ServerRosterRead {
  readonly bots: readonly ServerBot[];
  /** Accounts whose read failed while others answered. */
  readonly missing: readonly string[];
  /** True when there were accounts to read and not one answered. */
  readonly allFailed: boolean;
}

export interface PilotReach {
  /** Options for a call ABOUT this pilot. */
  ownerOptions(characterID: number): Promise<ApiOptions>;
  /** Options for a call as this account. */
  accountOptions(accountName: string): Promise<ApiOptions>;
  /**
   * Options for the shared bot library (any signed-in account reads the same
   * rows, so the first that answers will do). THROWS when none can.
   */
  libraryOptions(): Promise<ApiOptions>;
  /** Every account's server bots, read one account at a time. */
  readServerBots(): Promise<ServerRosterRead>;
  /** Sign every throwaway token out. Call when the window closes. */
  release(): Promise<void>;
}

export function createPilotReach(deps: PilotReachDeps): PilotReach {
  const pass = deps.pass ?? createAccountPass();
  const list = deps.listServerBots ?? ((options: ApiOptions) => listServerBots(options));

  const characterOf = (pilot: HeldPilot): number | null =>
    pilot.store.station.get().online?.characterID ?? null;

  const accountOf = (characterID: number): string =>
    deps.known().find((row) => row.characterID === characterID)?.accountName ?? "";

  async function accountOptions(accountName: string): Promise<ApiOptions> {
    const held = deps.held().find((pilot) => {
      const id = characterOf(pilot);
      return id !== null && accountOf(id) === accountName;
    });
    if (held !== undefined) return held.flow.requestOptions();
    return pass.optionsFor(accountName);
  }

  return {
    async ownerOptions(characterID) {
      const held = deps.held().find((pilot) => characterOf(pilot) === characterID);
      if (held !== undefined) return held.flow.requestOptions();
      return pass.optionsFor(accountOf(characterID));
    },
    accountOptions,
    async libraryOptions() {
      const held = deps.held()[0];
      if (held !== undefined) return held.flow.requestOptions();
      for (const accountName of deps.accounts()) {
        try {
          return await pass.optionsFor(accountName);
        } catch {
          // Try the next account; one refusing says nothing about the rest.
        }
      }
      throw new Error("No account this browser knows could be signed in.");
    },
    async readServerBots() {
      const accounts = deps.accounts();
      // /api/bots answers for the CALLER's account only, so one read shows one
      // account's bots — and a running bot on any other account would simply
      // not be listed.
      const read = await readAcrossAccounts(accounts, async (accountName) => {
        try {
          return await list({ ...(await accountOptions(accountName)), priority: "poll" });
        } catch (error) {
          // A token the server let go of (a BFF restart) fails every beat
          // until it is minted again.
          pass.forget(accountName);
          throw error;
        }
      });
      const allFailed = accounts.length > 0 && read.failed.length === accounts.length;
      return { bots: read.rows, missing: allFailed ? [] : read.failed, allFailed };
    },
    release: () => pass.release(),
  };
}
