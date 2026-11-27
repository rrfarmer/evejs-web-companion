// What the agent's window says of a mission's time, under what the agent says.
//
// agentDialogueWindow.GetMissionTimeText (326 to 337) reads two things from the mission's briefing
// (agentMgr GetMissionBriefingInfo):
//
//   "Decline Time"     None for a mission that is not on offer. -1 for an offer with no decline timer
//                      running: the client's general words about declining. Otherwise the time LEFT on
//                      the timer, in the game's 100 ns ticks, written out with FmtTimeInterval: down to
//                      minutes when more than a minute is left, to seconds when not.
//   "Expiration Time"  read only when there is no decline time: when the mission expires.
//
// With neither there is no line. The window shows the line only beside a mission's briefing, and not
// when the agent has answered "not yet" (a replay timer takes its place) or offers one of its special
// interactions (GetBriefingHTML, GetExtraMissionInfoHTML, 232 to 289).
//
// Tranquility's own answers (recorded sessions) carry all three forms of the decline time: None, -1,
// and a remainder never longer than four hours.
//
// The labels' text is the client's and is read from its install at run time (the words store).

import { formatTemplate, plainText } from "./clientWords.ts";
import { BLUE_TIME, fmtTimeInterval } from "./timeInterval.ts";
import { readDictEntry, unwrapLong, type JsonValue } from "./wire.ts";
import type { AgentConversation, AgentConversationLayout } from "../store/types.ts";

export const MISSION_TIME_LABELS = Object.freeze({
  declineGeneric: "UI/Agents/StandardMission/DeclineMessageGeneric",
  /** Its one argument is timeRemaining, already written out. */
  declineTimeLeft: "UI/Agents/StandardMission/DeclineMessageTimeLeft",
  /** Its one argument is expireTime, a time. */
  expiresAt: "UI/Agents/Dialogue/ThisMissionExpiresAt",
});
export const MISSION_TIME_WORD_LABELS: readonly string[] = Object.values(MISSION_TIME_LABELS);

/** What a briefing says of time. Each is null when the briefing has none. */
export interface MissionTimes {
  /** -1n for the general message; otherwise the ticks left on the decline timer. */
  readonly declineTime: bigint | null;
  /** When the mission expires, in the game's time. */
  readonly expirationTime: bigint | null;
}

/** Reads the two times from GetMissionBriefingInfo's answer. Null when there is no briefing. */
export function decodeMissionTimes(briefingResult: JsonValue | undefined): MissionTimes | null {
  if (briefingResult === null || briefingResult === undefined) {
    return null;
  }
  return {
    declineTime: unwrapLong(readDictEntry(briefingResult, "Decline Time")),
    expirationTime: unwrapLong(readDictEntry(briefingResult, "Expiration Time")),
  };
}

/**
 * Whether the window shows the mission's time at all (GetBriefingHTML, 232 to 250): not when the agent
 * has answered "not yet", where a replay timer takes its place, and not beside one of the agent's
 * special interactions.
 */
export function missionTimeShown(conversation: AgentConversation | null): boolean {
  return conversation !== null && !conversation.lastActionInfo.missionCantReplay && conversation.specialInteractions !== true;
}

type Templates = Readonly<Record<string, string | null | undefined>>;

const REPLAY_LABELS = {
  regular: ["UI/Agents/DefaultMessages/NoMission1", "UI/Agents/DefaultMessages/NoMission2"],
  heraldry: "UI/Agents/DefaultMessages/NoMissionHeraldryTimer",
  timer: "UI/Agents/DefaultMessages/MissionCantReplay",
} as const;
export const MISSION_REPLAY_WORD_LABELS = [...REPLAY_LABELS.regular, REPLAY_LABELS.heraldry, REPLAY_LABELS.timer];
const HERALDRY_DIVISION_ID = 37;

export function agentConversationIsSinglePane(layout: AgentConversationLayout): boolean {
  return !layout.conversation.lastActionInfo.missionCompleted && !layout.objectives && !layout.briefing;
}

/** AgentDialogueWindow.GetBriefingHTML: the replacement message and the formatted replay time. */
export function missionReplayText(
  timeLeft: number, divisionID: number | null, alternative: 0 | 1, templates: Templates,
): { message: string; timer: string | null } | null {
  if (!Number.isSafeInteger(timeLeft) || timeLeft <= 0) return null;
  const label = divisionID === HERALDRY_DIVISION_ID ? REPLAY_LABELS.heraldry : REPLAY_LABELS.regular[alternative];
  const ticks = BigInt(timeLeft);
  const amount = fmtTimeInterval(ticks, ticks > BLUE_TIME.MIN ? "min" : "sec", templates);
  const timer = templates[REPLAY_LABELS.timer];
  return {
    message: plainText(templates[label] ?? "I have no missions for you right now."),
    timer: amount === null || typeof timer !== "string" ? null
      : formatTemplate(timer, { timeLeft: amount, timerColor: "#FF8DC169" }, { nameOf: () => "" }),
  };
}

/**
 * GetMissionTimeText: the line for a mission's time, or null when there is none to show or the client's
 * words for it are not to hand.
 */
export function missionTimeText(times: MissionTimes | null, templates: Templates): string | null {
  if (times === null) {
    return null;
  }
  const words = (label: string, args: Record<string, string> = {}): string | null => {
    const template = templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf: () => "" })) : null;
  };
  if (times.declineTime !== null) {
    if (times.declineTime === -1n) {
      return words(MISSION_TIME_LABELS.declineGeneric);
    }
    const left = fmtTimeInterval(times.declineTime, times.declineTime > BLUE_TIME.MIN ? "min" : "sec", templates);
    return left === null ? null : words(MISSION_TIME_LABELS.declineTimeLeft, { timeRemaining: left });
  }
  if (times.expirationTime !== null) {
    return words(MISSION_TIME_LABELS.expiresAt, { expireTime: times.expirationTime.toString() });
  }
  return null;
}
