// Chat channel decoder (goal R7). The BFF /api/bridge/chat/:channel route
// returns a plain-JSON `chat` object the gateway already shaped (roster =
// buildCharacterSummary rows, messages = backlog entries). This decodes it into
// the typed ChatChannelState the store holds, tolerating malformed rows (a bad
// row is skipped, never a throw) and decoding every numeric long-aware.

import { readPlainJsonField, unwrapLong, type JsonValue } from "./wire.ts";
import type {
  ChatChannel,
  ChatChannelState,
  ChatMember,
  ChatMessage,
} from "../store/types.ts";

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

/** Long-or-number -> number|null (IDs stay within safe-int range here). */
function numOrNull(value: JsonValue | undefined): number | null {
  const long = unwrapLong(value ?? null);
  if (long !== null) {
    return Number(long);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: JsonValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function decodeMember(value: JsonValue): ChatMember | null {
  const row = asRecord(value);
  const characterID = numOrNull(row.characterID);
  if (!characterID || characterID <= 0) {
    return null;
  }
  return {
    characterID,
    name: asString(row.name, `Character ${characterID}`),
    role: row.role === "moderator" || row.role === "participant" || row.role === "visitor" || row.role === "none" ? row.role : null,
    corporationID: numOrNull(row.corporationID),
    allianceID: numOrNull(row.allianceID),
    solarSystemID: numOrNull(row.solarSystemID),
  };
}

function decodeMessage(value: JsonValue): ChatMessage | null {
  const row = asRecord(value);
  const message = asString(row.message);
  if (!message) {
    return null;
  }
  const characterID = numOrNull(row.characterID) ?? 0;
  return {
    characterID,
    characterName: asString(row.characterName, "Unknown"),
    message,
    createdAtMs: numOrNull(row.createdAtMs) ?? 0,
  };
}

/** Decode the raw `chat` object from a /api/bridge/chat/:channel read. */
export function decodeChatChannel(raw: JsonValue | undefined): ChatChannelState {
  const chat = asRecord(raw);
  // One member, one row. The roster is rendered by a keyed `{#each ...
  // (member.characterID)}`, which THROWS rather than draws when the same key
  // arrives twice — and the throw aborts the render flush, so a roster the
  // gateway happens to repeat someone in would freeze the page on every poll.
  const seenMembers = new Set<number>();
  const roster = Array.isArray(chat.roster)
    ? chat.roster
        .map(decodeMember)
        .filter((m): m is ChatMember => m !== null)
        .filter((m) => (seenMembers.has(m.characterID) ? false : (seenMembers.add(m.characterID), true)))
    : [];
  const messages = Array.isArray(chat.messages)
    ? chat.messages.map(decodeMessage).filter((m): m is ChatMessage => m !== null)
    : [];
  return {
    roomName: typeof chat.roomName === "string" ? chat.roomName : null,
    corporationID: numOrNull(chat.corporationID),
    solarSystemID: numOrNull(chat.solarSystemID),
    roster,
    messages,
    loaded: chat.loaded !== false,
  };
}

/** The channel a raw read is for (defaults to the requested channel). */
export function decodeChatChannelName(
  raw: JsonValue | undefined,
  fallback: ChatChannel,
): ChatChannel {
  const chat = asRecord(raw);
  return chat.channel === "corp" || chat.channel === "local"
    ? chat.channel
    : fallback;
}

/** Decode the `entry` a /chat/send response echoes (null when absent). */
export function decodeSentMessage(raw: JsonValue | undefined): ChatMessage | null {
  const chat = asRecord(raw);
  return chat.entry ? decodeMessage(chat.entry) : null;
}

/**
 * Decode one backlog entry on its own (goal R10). The live channel pushes the
 * same entry shape the backlog read returns, so a pushed message and a polled
 * one decode identically — which is what lets the store dedupe across them.
 */
export function decodeMessageEntry(raw: JsonValue | undefined): ChatMessage | null {
  return raw === undefined || raw === null ? null : decodeMessage(raw);
}

// --- R88 write ack ----------------------------------------------------------
//
// The Phase-3 LSC.SendMessage WRITE. FAST-MODE educated-guess decoder reading
// the small JSON ack the confirm-gated BFF route emits. SendMessage returns null
// server-side (the message is broadcast / handled as a command), so this only
// reads the uniform `applied` flag. ⚠ SendMessage sends an OUTWARD chat message
// and is NEVER fired live in the plumbing pass. EDUCATED GUESS from client +
// server code, not captured bytes.

/** The uniform ack the confirm-gated chat send route returns. */
export interface ChatSendAck {
  readonly ok: boolean;
  readonly applied: boolean;
}

/** Decode the LSC.SendMessage write ack. */
export function decodeChatSendAck(response: JsonValue): ChatSendAck {
  return {
    ok: readPlainJsonField(response, "ok") === true,
    applied: readPlainJsonField(response, "applied") === true,
  };
}
