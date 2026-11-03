// How a PI run the board was watching ended, read as its OWNER.
//
// The board watches runs on /api/bots/active, which is public and so lists only
// live runs: a run that ends simply drops off it. How it ended (finished, or
// stopped and why) is on /api/bots, behind requireAuth and scoped to the
// account, which keeps an ended run listed so its last readout stays visible.
// So this signs the pilot's account in on a THROWAWAY token, reads that list
// and signs out again: stopBotFor.ts's pattern, and like it, it never selects
// a character.

import {
  listServerBots,
  login as apiLogin,
  logout as apiLogout,
  type ApiOptions,
  type ServerBot,
} from "./api.ts";
import type { PiRunEnd } from "../bridge/piRunProgress.ts";
import { PROGRAM_DONE_PHASE } from "../nav/scriptDecide.ts";

/** Transport only — the token is this function's to mint, never the caller's. */
export type PiRunOutcomeOptions = Pick<ApiOptions, "fetch" | "baseUrl">;

/** The pilot's most recent ENDED run in the owner's list, or null when none is. */
export function lastEndedRun(bots: readonly ServerBot[], characterID: number): PiRunEnd | null {
  let latest: ServerBot | null = null;
  for (const bot of bots) {
    if (bot.characterID !== characterID || bot.endedAt === null) continue;
    if (latest === null || Date.parse(bot.endedAt) > Date.parse(latest.endedAt!)) latest = bot;
  }
  if (latest === null) return null;
  return {
    status: latest.status,
    why: latest.pauseReason ?? latest.why,
    // ⚠ A FINISHED PROGRAM ENDS "stopped", AS A STOP CLICK DOES. The runner leaves a run that reached its program's
    // end stopped, in the done phase (nav/scriptRunner.ts, scriptDecide.ts done); only that phase tells the two apart.
    finished: latest.status === "stopped" && latest.phase === PROGRAM_DONE_PHASE,
  };
}

/**
 * How the pilot's last run ended. Resolves null when the account's list has no
 * ended run for the pilot; THROWS on a sign-in or network failure, whose words
 * are the caller's.
 */
export async function readPiRunOutcome(
  accountName: string,
  characterID: number,
  options: PiRunOutcomeOptions = {},
): Promise<PiRunEnd | null> {
  // "poll": nobody clicked for this, and it must never jump a player's click.
  const result = await apiLogin(accountName, "", { ...options, token: null, priority: "poll" });
  const token = result.sessionToken;
  if (token === null) {
    throw new Error("The server did not return a session token.");
  }
  const asOwner = { ...options, token, priority: "poll" as const };
  try {
    return lastEndedRun(await listServerBots(asOwner), characterID);
  } finally {
    await apiLogout(asOwner).catch(() => {});
  }
}
