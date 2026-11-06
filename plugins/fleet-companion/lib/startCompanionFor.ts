// Starting a server companion for a pilot whose account is NOT this tab's.
//
// ⚠ THE SIBLING OF `stopBotFor.ts`, AND ITS HEADER IS THE ARGUMENT FOR BOTH.
// Read it first: /api/bots/* is behind requireAuth and scoped to
// `req.account.accountID`, all a Pilot Hangar row has is that pilot's account
// NAME, and on a server whose login takes any password the name IS the
// credential. Sign in on a throwaway per-session token, act, sign out.
//
// ⚠ WHAT IS DIFFERENT HERE IS WHO MAY USE IT. A stop is safe for any row: it
// never claims a hull. A START does claim one, so it must be used ONLY for a
// pilot that has no session in this tab. For a pilot signed in HERE the caller
// must be that pilot's OWN session instead, because /api/bots/start hands the
// CALLER's held bridge session to the run — a throwaway token holds nothing, so
// the hull would still be held by the tab and the host would refuse with "A web
// session is flying this character". ui/SquadFly.svelte is where that fork is
// made; this module is the arm that reaches another account.
//
// No character is ever selected on the throwaway session, so nothing undocks
// and no hull is claimed by it: the bot host mints its own session and selects
// the character itself.

import { login as apiLogin, logout as apiLogout, startPluginRun, type ApiOptions, type BotLaunchGrant, type JsonValue } from "../../../web/src/plugin-api/index.ts";
import type { CompanionSetup } from "./fleetCompanionLoop.ts";

/** Transport only — the token is this function's to mint, never the caller's. */
export type StartCompanionOptions = Pick<ApiOptions, "fetch" | "baseUrl">;

/**
 * Start a companion on the host for `characterID`, holding a web session only
 * for the length of the call.
 *
 * THROWS whatever the server refused with, unchanged: the squad start turns one
 * pilot's refusal into a sentence on that pilot's row and carries on with the
 * rest (bots/groupStart.ts), and a reworded refusal here would be a second
 * vocabulary for the same facts.
 */
export async function startCompanionFor(
  accountName: string,
  characterID: number,
  setup: CompanionSetup,
  grant: BotLaunchGrant,
  options: StartCompanionOptions = {},
): Promise<void> {
  // "user", not "poll": this is behind a click, and a click must never queue
  // behind the roster polls this screen also runs (app/transport.ts).
  const result = await apiLogin(accountName, "", { ...options, token: null, priority: "user" });
  const token = result.sessionToken;
  if (token === null) {
    throw new Error("The server did not return a session token.");
  }
  const asOwner = { ...options, token, priority: "user" as const };
  try {
    await startPluginRun(characterID, "fleet-companion", "fly", setup as unknown as JsonValue, grant, asOwner);
  } finally {
    await apiLogout(asOwner).catch(() => {});
  }
}
