// A pushed session change (OnSessionChanged), for the windows that listen for one.
//
// Both transports push it as { kind: "sessionchange", method: "OnSessionChanged", args: [change] },
// where `change` has an entry for each session variable that changed: its name, and the old value and
// the new. The retail client hands the same dict to every window's OnSessionChanged(isRemote, sess,
// change), and most of them only ask which names are in it.

import { readDictPairs } from "./wire.ts";

/** The names of the session variables that changed, or null if the notification is not a session change. */
export function sessionChangeNames(method: string | null, args: readonly unknown[]): readonly string[] | null {
  if (method !== "OnSessionChanged") {
    return null;
  }
  const change = args[0];
  if (change === null || typeof change !== "object") {
    return [];
  }
  // A dict as the wire spells one, or the plain object both transports send today.
  if ((change as { type?: unknown }).type === "dict") {
    return readDictPairs(change).map(([name]) => name).filter((name): name is string => typeof name === "string");
  }
  return Array.isArray(change) ? [] : Object.keys(change);
}

/**
 * What one session variable became, where the change has it: the second of its (old, new) pair, as a list, a tuple
 * or the plain array both transports send; undefined where the change does not name it.
 */
export function sessionChangeValue(method: string | null, args: readonly unknown[], name: string): unknown {
  if (method !== "OnSessionChanged") {
    return undefined;
  }
  const change = args[0];
  if (change === null || typeof change !== "object" || Array.isArray(change)) {
    return undefined;
  }
  const pair = (change as { type?: unknown }).type === "dict"
    ? readDictPairs(change).find(([key]) => key === name)?.[1]
    : Object.hasOwn(change, name) ? (change as Record<string, unknown>)[name] : undefined;
  if (Array.isArray(pair)) {
    return pair[1] ?? null;
  }
  if (pair !== null && typeof pair === "object" && Array.isArray((pair as { items?: unknown }).items)) {
    return (pair as { items: unknown[] }).items[1] ?? null;
  }
  return undefined;
}

/** Session numbers can be JSON numbers, gateway decimal strings, or marshaled longs. */
export function wholeDigits(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return value;
  }
  if (typeof value === "bigint" && value >= 0n) {
    return value.toString();
  }
  if (value !== null && typeof value === "object" && (value as { type?: unknown }).type === "long") {
    const digits = (value as { value?: unknown }).value;
    return typeof digits === "string" && /^\d+$/.test(digits) ? digits : null;
  }
  return null;
}
