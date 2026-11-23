// WC74 server worker labels @ 213da333, unchanged Civilian status logic.
import type {ServerBot} from "../app/api.ts";
const COMPANION_NAME="Fleet companion",COMPANION_ELSEWHERE="Managed in Fleet Companions";
type PilotRunState={mode:"server";botName:string|null;statusWords:string;detail:string|null;isCompanion:boolean};
function serverStatusWords(status: string): string {
  if (status === "starting") {
    return "Starting";
  }
  if (status === "running") {
    return "Running";
  }
  if (status === "paused") {
    return "Paused";
  }
  if (status === "error") {
    return "Stopped after a problem";
  }
  // Anything else (a clean stop, a runtime cap) reads as "Finished" — the same
  // wording ServerBots.svelte already uses for the same case.
  return "Finished";
}

/**
 * One line worth showing under the status word, picked from whichever of
 * phase / why / pause-reason is present. Pause reason wins when several are
 * set, because it is the most actionable of the three: it is the thing
 * stopping the bot from doing anything else right now, and a player reading
 * one line wants that before a stage name or a rung's own reasoning.
 */
function oneLineDetail(fields: {
  readonly phase: string | null;
  readonly why: string | null;
  readonly pauseReason: string | null;
}): string | null {
  return fields.pauseReason ?? fields.phase ?? fields.why ?? null;
}


export function serverRunState(bot: ServerBot): PilotRunState {
  const isCompanion = false;
  let statusWords = serverStatusWords(bot.status);
  if (bot.civilianView && bot.status === "stopped") {
    const completed = bot.missionProgress?.completedCount ?? 0;
    statusWords = bot.endedAt === null ? "Stopping"
      : bot.civilianSafetyReason ? "Stopped after a problem"
      : completed > 0 ? `Completed ${completed} mission${completed === 1 ? "" : "s"}` : "Stopped · no confirmed missions";
  }
  return {
    mode: "server",
    // ⚠ `kind`, NOT `scriptName`. A headless companion is not a saved script
    // and its name on the wire is whatever the host called the run; calling it
    // by the thing it IS is the only reading that survives the host renaming it.
    botName: isCompanion ? COMPANION_NAME : bot.scriptName,
    statusWords,
    detail: isCompanion ? COMPANION_ELSEWHERE : oneLineDetail({phase:bot.phase??null,why:bot.why??null,pauseReason:bot.pauseReason??null}),
    isCompanion,
  };
}
