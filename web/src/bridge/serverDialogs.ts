// What the SERVER tells the player unasked, as a dialog of the client's.
//
// The server sends OnRemoteMessage(msgID, dict) and the retail client puts up the dialog of that name with the dict's
// values (gameui.py OnRemoteMessage, 347 to 356: prompt_player_fsd_dialog(msgID, dict)): a notify dialog as the
// passing strip, an info or an error one as a box (ClientDialogs.svelte). Most of what this server sends is
// CustomNotify, whose dialog is the dict's own sentence ({notify}); the rest are dialogs of the client's own (a mining
// drone's asteroid emptied, a fleet warp followed, a ship already in warp, a ship's self-destruct).
//
// The page puts it up the same way (the flow's sayDialog), with the client's own text where the BFF has an install to
// read. Where it has not, the page's own words below are said in its place: the sentence the server wrote for a
// Custom* dialog, and this client's words for the dialogs this server sends.

import type { JsonValue } from "./wire.ts";

/** The server's notice of a message for the player. */
export const REMOTE_MESSAGE = "OnRemoteMessage";

/** A known presentation to use only while the local dialog's type is unavailable. */
export type RemoteDialogFallbackType = "notify" | "info" | "error" | "warning";

export interface RemoteDialog {
  /** The dialog's name, as the client's dialogs are named. */
  readonly dialog: string;
  /** The dict sent with it, as it came. */
  readonly values: JsonValue | null;
  /** What the page says where the install has not the dialog. */
  readonly fallback: string;
  readonly fallbackType?: RemoteDialogFallbackType;
}

/** A dialog's name, as the server sends one. */
const DIALOG_NAME = /^\w{1,100}$/;

/** The Custom* dialogs, each its dict's one sentence under the key the dialog's text names. */
const CUSTOM_KEYS: Readonly<Record<string, string>> = Object.freeze({
  CustomNotify: "notify",
  CustomInfo: "info",
  CustomError: "error",
  CustomWarning: "warning",
});

/** Presentation known from the message contract; an installed dialog remains authoritative. */
const FALLBACK_TYPES: Readonly<Record<string, RemoteDialogFallbackType>> = Object.freeze({
  CustomNotify: "notify",
  CustomInfo: "info",
  CustomError: "error",
  CustomWarning: "warning",
  FleetWarp: "notify",
  ShipInWarp: "notify",
  SalvagingFailure: "notify",
});

/** This client's words for the client's own dialogs this server sends. */
const OWN_WORDS: Readonly<Record<string, string>> = Object.freeze({
  MiningDronesDeactivatedAsteroidEmpty: "A mining drone stops: the resource it was harvesting is gone.",
  FleetWarp: "Following your fleet in warp.",
  ShipInWarp: "You cannot do that while warping.",
  SalvagingFailure: "Salvaging failed: nothing was recovered this cycle.",
  SelfDestructInitiatedOther: "A ship nearby has begun to self-destruct.",
  SelfDestructImmediateOther: "A ship nearby has self-destructed.",
  SelfDestructAbortedOther2: "A ship nearby has stopped its self-destruct.",
});

/** A dict's text under `key`: a string, or a wstring's. */
function textIn(values: JsonValue | null, key: string): string | null {
  const entries = values && typeof values === "object" && !Array.isArray(values) ? (values as { entries?: unknown }).entries : null;
  const entry = Array.isArray(entries) ? entries.find((one) => Array.isArray(one) && one[0] === key) : undefined;
  const held = Array.isArray(entry) ? entry[1] : null;
  const text = typeof held === "string" ? held
    : held && typeof held === "object" && (held as { type?: unknown }).type === "wstring" && typeof (held as { value?: unknown }).value === "string"
      ? (held as { value: string }).value
      : null;
  return text !== null && text.trim() !== "" ? text.trim() : null;
}

/** OnRemoteMessage's arguments as the dialog to put up; null for what names no dialog, or a Custom* with nothing to say. */
export function remoteDialogOf(args: readonly unknown[]): RemoteDialog | null {
  const dialog = typeof args[0] === "string" ? args[0] : null;
  if (dialog === null || !DIALOG_NAME.test(dialog)) return null;
  const values = (args[1] ?? null) as JsonValue | null;
  const fallbackType = Object.hasOwn(FALLBACK_TYPES, dialog) ? FALLBACK_TYPES[dialog] : undefined;
  const presentation = fallbackType === undefined ? {} : { fallbackType };
  const customKey = CUSTOM_KEYS[dialog];
  if (customKey !== undefined) {
    const text = textIn(values, customKey);
    return text === null ? null : { dialog, values, fallback: text, ...presentation };
  }
  return { dialog, values, fallback: OWN_WORDS[dialog] ?? `The server says something this page has no words for (${dialog}).`, ...presentation };
}
