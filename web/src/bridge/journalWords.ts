// A mission in the journal, worded as the retail client's journal words it.
//
// The client's agent tab (eve/client/script/ui/shared/neocom/journal.py,
// ShowAgentTab) shows one line for each mission:
//
//   its state · the agent · the mission's name · the mission's type · when it expires
//
// The name is a message's number (localization.GetByMessageID, with nothing to
// fill it), the type a label (GetByLabel), marked "important" through another
// label when the server says so, and the state and the expiry are chosen by
// agentUtil.GetMissionExpirationAndStateText.
//
// ⚠ THAT FUNCTION'S RULES HERE ARE MEASURED, NOT READ. The decompiled source
// has its second half at the wrong depth, and reads as if every expiry ended
// up "expires in". The client's own compiled function, run in the client's own
// Python with stand-ins for what it reaches for, gives for a mission that is
// offered (states 0 and 1; the labels' names begin "Offer") or accepted or
// failed (2 and 3; "Mission"):
//
//   more than a week and a minute away   ExpiresAt, with the time
//   more than a day away                 ExpiresAtExact, with the time
//   no time at all (None)                UndefinedExpiration
//   a time of zero                       DoesNotExpire
//   otherwise, the time left, cut down to whole minutes:
//     none (under a minute left)         DoesNotExpire  (so the client says)
//     some                               ExpiresIn, with the time left
//     less than none                     Expired, and the state reads as
//                                        StateOfferExpired / StateMissionExpired
//
// and nothing at all for any other state. The labels live under
// UI/Journal/JournalWindow/Agents/.

import type { JournalMission, QuestionWords } from "../store/types.ts";
import type { JsonValue } from "./wire.ts";

const FOLDER = "UI/Journal/JournalWindow/Agents/";
const SECOND = 10_000_000n;
const MINUTE = 60n * SECOND;
const DAY = 24n * 60n * MINUTE;
const WEEK = 7n * DAY;

/** agentMissionState*: allocated, offered, accepted, failed. */
const OFFERED_STATES = [0, 1];
const ACCEPTED_STATES = [2, 3];
const STATE_LABEL: Readonly<Record<number, string>> = { 0: "StateOffered", 1: "StateOffered", 2: "StateAccepted", 3: "StateFailed" };

/** The label that marks a mission's type as important. Its one parameter, missionType, is the type's own text. */
export const IMPORTANT_MISSION = `${FOLDER}ImportantMission`;

const label = (name: string, entries: Array<[string, JsonValue]> = []): QuestionWords => ({
  label: `${FOLDER}${name}`,
  parameters: entries.length > 0 ? { type: "dict", entries } : null,
  text: null,
});
const long = (value: bigint): JsonValue => ({ type: "long", value: value.toString() });

/** Milliseconds since 1970 as the server's clock counts: 100 ns ticks since 1601. */
export function filetimeOf(ms: number): bigint {
  return (BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n;
}

/** A mission's expiry as the journal row carries it: a decimal string, or null for none. */
function expiryOf(text: string | null): bigint | null {
  return typeof text === "string" && /^-?\d+$/.test(text) ? BigInt(text) : null;
}

export interface JournalStateWords {
  readonly state: QuestionWords | null;
  readonly expiration: QuestionWords | null;
  /** Whether the client would show the state as expired (in red). */
  readonly expired: boolean;
}

/** The state and the expiry of a mission as the client's journal chooses them, at `now` on the server's clock. */
export function journalStateWords(missionState: number | null, expirationTime: string | null, now: bigint): JournalStateWords {
  const offered = missionState !== null && OFFERED_STATES.includes(missionState);
  if (missionState === null || !(offered || ACCEPTED_STATES.includes(missionState))) {
    return { state: null, expiration: null, expired: false };
  }
  const kind = offered ? "Offer" : "Mission";
  const state = label(STATE_LABEL[missionState] as string);
  const expiry = expiryOf(expirationTime);
  if (expiry === null) {
    return { state, expiration: label(`${kind}UndefinedExpiration`), expired: false };
  }
  if (expiry > now + WEEK + MINUTE) {
    return { state, expiration: label(`${kind}ExpiresAt`, [["expirationTime", long(expiry)]]), expired: false };
  }
  if (expiry > now + DAY) {
    return { state, expiration: label(`${kind}ExpiresAtExact`, [["expirationTime", long(expiry)]]), expired: false };
  }
  if (expiry === 0n) {
    return { state, expiration: label(`${kind}DoesNotExpire`), expired: false };
  }
  // The client cuts the time left down to whole minutes, rounding down: any time ago at all is less than none.
  const left = expiry - now;
  if (left < 0n) {
    return { state: label(`State${kind}Expired`), expiration: label(`${kind}Expired`), expired: true };
  }
  const minutes = left / MINUTE;
  if (minutes === 0n) {
    return { state, expiration: label(`${kind}DoesNotExpire`), expired: false };
  }
  return { state, expiration: label(`${kind}ExpiresIn`, [["expirationTime", long(minutes * MINUTE)]]), expired: false };
}

export interface JournalRowWords extends JournalStateWords {
  /** The mission's name: a message by its number, or the text the server sent in its place. */
  readonly name: QuestionWords | null;
  /** The mission's type: a label. */
  readonly type: QuestionWords | null;
  readonly important: boolean;
}

/** Everything the client's journal line says about one mission, as words still to be turned into text. */
export function journalRowWords(mission: JournalMission, now: bigint): JournalRowWords {
  const name: QuestionWords | null = typeof mission.missionTitle === "string" && mission.missionTitle !== ""
    ? { label: null, parameters: null, text: mission.missionTitle }
    : mission.missionTitleID !== null && mission.missionTitleID > 0
      ? { label: null, parameters: null, text: null, messageID: mission.missionTitleID }
      : null;
  const type: QuestionWords | null = mission.missionTypeLabel
    ? { label: mission.missionTypeLabel, parameters: null, text: null }
    : null;
  return { ...journalStateWords(mission.missionState, mission.expirationTime, now), name, type, important: mission.importantMission === true };
}

/** The words a journal line needs the client's text for: its own, and the "important" label when it is used. */
export function journalRowAsks(row: JournalRowWords): QuestionWords[] {
  const asks = [row.state, row.name, row.type, row.expiration].filter((words): words is QuestionWords => words !== null);
  if (row.important && row.type !== null) {
    asks.push({ label: IMPORTANT_MISSION, parameters: null, text: null });
  }
  return asks;
}

export interface JournalRowText {
  readonly state: string;
  readonly name: string;
  readonly type: string;
  readonly expiration: string;
}

/** Scroll falls back to the chosen cell plus the cells after it, then the whole row. */
export function sortJournalRows<T>(rows: readonly T[], column: number, reversed: boolean,
    cellsOf: (row: T) => readonly string[]): T[] {
  const ordered = rows.map(row => {
    const cells = cellsOf(row);
    return { row, key: (cells[column] ?? "").toLowerCase() + cells.slice(column + 1).join(""), full: cells.join("<t>").toLowerCase() };
  });
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  ordered.sort((a, b) => compare(a.key, b.key) || compare(a.full, b.full));
  if (reversed) ordered.reverse();
  return ordered.map(({ row }) => row);
}

/**
 * A journal line's four texts. `say` turns words into text (the page's
 * questionText); `has` says whether the page holds the client's text for a
 * words key.
 *
 * Without the client's text a name that is only a number is left out (a bare
 * message number tells a player nothing), and a type is the last part of its
 * label, which is how this page has always shown it.
 */
export function journalRowText(row: JournalRowWords, say: (words: QuestionWords) => string, has: (key: string) => boolean): JournalRowText {
  const name = row.name === null
    ? ""
    : row.name.text !== null || (typeof row.name.messageID === "number" && has(`#${row.name.messageID}`))
      ? say(row.name)
      : "";
  let type = "";
  if (row.type !== null && row.type.label !== null) {
    type = has(row.type.label) ? say(row.type) : row.type.label.split("/").pop() ?? "";
    if (row.important && type !== "") {
      type = say({ label: IMPORTANT_MISSION, parameters: { type: "dict", entries: [["missionType", type]] }, text: null });
    }
  }
  return {
    state: row.state === null ? "" : say(row.state),
    name,
    type,
    expiration: row.expiration === null ? "" : say(row.expiration),
  };
}
