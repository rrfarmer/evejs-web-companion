// Read division names beside running server bots, through each pilot's own
// account. The PI window has no account session of its own.
import { loadBotCorpDivisionNames, login, logout, type ApiOptions } from "../../../web/src/plugin-api/index.ts";
import type { DivisionName } from "./piHaulPrefs.ts";

export interface PiDivisionNamesRead {
  readonly characterID: number;
  readonly corporationID: number | null;
  readonly divisions: readonly DivisionName[];
}

interface NamesDeps {
  signIn(accountName: string): Promise<string>;
  signOut(token: string): Promise<void>;
  read(characterID: number, options: ApiOptions): Promise<Omit<PiDivisionNamesRead, "characterID">>;
}

const LIVE_DEPS: NamesDeps = {
  async signIn(accountName) {
    const result = await login(accountName, "", { token: null, priority: "user" });
    if (result.sessionToken === null) throw new Error("No account session token was returned.");
    return result.sessionToken;
  },
  signOut: (token) => logout({ token }),
  read: loadBotCorpDivisionNames,
};

/** One short-lived sign-in per account; a failed bot read leaves remembered names intact. */
export async function readBotDivisionNames(
  pilots: readonly { readonly characterID: number; readonly accountName: string }[],
  deps: NamesDeps = LIVE_DEPS,
): Promise<PiDivisionNamesRead[]> {
  const reads: PiDivisionNamesRead[] = [];
  const byAccount = new Map<string, number[]>();
  for (const pilot of pilots) {
    const ids = byAccount.get(pilot.accountName) ?? [];
    if (!ids.includes(pilot.characterID)) ids.push(pilot.characterID);
    byAccount.set(pilot.accountName, ids);
  }
  for (const [accountName, characterIDs] of byAccount) {
    let token: string;
    try {
      token = await deps.signIn(accountName);
    } catch {
      continue;
    }
    try {
      for (const characterID of characterIDs) {
        try {
          const read = await deps.read(characterID, { token, priority: "user" });
          reads.push({ characterID, ...read });
        } catch {
          // The run ended, the session was lost, or the read was refused.
        }
      }
    } finally {
      await deps.signOut(token).catch(() => {});
    }
  }
  return reads;
}
