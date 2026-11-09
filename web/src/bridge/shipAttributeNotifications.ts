// The server's word of an item's attribute changing, read for one item: the pilot's own ship, whose attributes the
// Fitting window's figures are made of.
//
// godma keeps the ship's attributes as the server tells of each change (godma.OnModuleAttributeChange and its batch,
// OnModuleAttributeChanges; and the changes riding an OnMultiEvent, which godma's OnMultiEvent scatters one by one),
// and the client's windows read them from there. A module fitted and put online docked is a change of the ship's
// cpuLoad and powerLoad the server sends at its next tick, in an OnMultiEvent, after the call that onlined it has
// been answered: the page's re-read of the fit, made on that answer, comes before it (2026-10-16, a Damage Control
// fitted on the game port: the re-read said CPU 19 and the push that followed said 19 to 44).
//
// Wire shape of one change (attributeChangeNotification.js buildAttributeChange; godma's OnModuleAttributeChange):
//
//   ["OnModuleAttributeChange", ownerID, itemID, attributeID, time, newValue, oldValue, time]
//
// OnModuleAttributeChange carries it as its arguments; OnModuleAttributeChanges as a list in its first; an
// OnMultiEvent as entries of its first, each [the change, when it was made].

import { unwrapLong, unwrapReal } from "./wire.ts";

function itemsOf(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: unknown[] }).items;
  }
  return null;
}

/** A whole number or a real off the wire, as a number; null for anything else. */
function numberOf(value: unknown): number | null {
  const real = unwrapReal(value);
  if (real !== null) return real;
  const whole = unwrapLong(value);
  return whole === null ? null : Number(whole);
}

/**
 * The attribute changes a notice tells of for one item, by attribute: its new value each, the last told where one
 * is told twice. Null where the notice tells of none for that item.
 */
export function decodeItemAttributeChanges(
  method: string | null,
  args: readonly unknown[],
  itemID: number,
): ReadonlyMap<number, number> | null {
  const found = new Map<number, number>();
  const take = (change: readonly unknown[] | null) => {
    if (!change || change[0] !== "OnModuleAttributeChange") return;
    const item = unwrapLong(change[2]);
    if (item === null || Number(item) !== itemID) return;
    const attributeID = unwrapLong(change[3]);
    const value = numberOf(change[5]);
    if (attributeID === null || value === null) return;
    found.set(Number(attributeID), value);
  };
  if (method === "OnModuleAttributeChange") {
    take(["OnModuleAttributeChange", ...args]);
  } else if (method === "OnModuleAttributeChanges") {
    for (const change of itemsOf(args[0]) ?? []) take(itemsOf(change));
  } else if (method === "OnMultiEvent") {
    for (const entry of itemsOf(args[0]) ?? []) {
      const told = itemsOf(itemsOf(entry)?.[0]);
      if (!told) continue;
      if (told[0] === "OnModuleAttributeChange") take(told);
      else if (told[0] === "OnModuleAttributeChanges") for (const change of itemsOf(told[1]) ?? []) take(itemsOf(change));
    }
  } else {
    return null;
  }
  return found.size > 0 ? found : null;
}

/** One change of an item's attribute, as the server tells of it. */
export interface AttributeChange {
  readonly itemID: number;
  readonly attributeID: number;
  readonly value: number;
}

/**
 * The changes the client's dogma location hears (clientDogmaLocation.OnModuleAttributeChanges), in the order it takes
 * them: an OnModuleAttributeChanges batch, sorted by the changes' times; and those riding an OnMultiEvent, which godma
 * takes a moment at a time (OnMultiEvent: grouped by when they were made) and passes on as a batch of the last change
 * of each owner, item and attribute, sorted by time (BroadcastFilteredMAC). An OnModuleAttributeChange alone is
 * godma's only. A change of a sublocation (a charge in a slot) is left out.
 */
export function locationAttributeChanges(method: string | null, args: readonly unknown[]): readonly AttributeChange[] {
  type Told = { readonly owner: string; readonly change: AttributeChange; readonly time: bigint };
  const told = (change: readonly unknown[] | null): Told | null => {
    if (!change || change[0] !== "OnModuleAttributeChange") return null;
    const item = unwrapLong(change[2]);
    const attributeID = unwrapLong(change[3]);
    const value = numberOf(change[5]);
    if (item === null || attributeID === null || value === null) return null;
    return {
      owner: String(unwrapLong(change[1])),
      change: { itemID: Number(item), attributeID: Number(attributeID), value },
      time: unwrapLong(change[4]) ?? 0n,
    };
  };
  const byTime = (left: Told, right: Told): number => (left.time < right.time ? -1 : left.time > right.time ? 1 : 0);
  if (method === "OnModuleAttributeChanges") {
    const batch = (itemsOf(args[0]) ?? []).map((change) => told(itemsOf(change))).filter((change) => change !== null);
    return batch.sort(byTime).map((entry) => entry.change);
  }
  if (method !== "OnMultiEvent") return [];
  const moments: { readonly when: bigint; readonly change: Told }[] = [];
  for (const entry of itemsOf(args[0]) ?? []) {
    const pair = itemsOf(entry);
    const change = told(itemsOf(pair?.[0]));
    if (change) moments.push({ when: unwrapLong(pair?.[1]) ?? 0n, change });
  }
  moments.sort((left, right) => (left.when < right.when ? -1 : left.when > right.when ? 1 : 0));
  const heard: AttributeChange[] = [];
  for (let start = 0; start < moments.length; ) {
    let end = start;
    while (end < moments.length && moments[end]!.when === moments[start]!.when) end += 1;
    const last = new Map<string, Told>();
    for (const { change } of moments.slice(start, end).sort((left, right) => byTime(left.change, right.change))) {
      last.set(`${change.owner}|${change.change.itemID}|${change.change.attributeID}`, change);
    }
    heard.push(...[...last.values()].sort(byTime).map((entry) => entry.change));
    start = end;
  }
  return heard;
}

/**
 * The effects' starts and stops riding an OnMultiEvent, as godma hands them on: a moment at a time (OnMultiEvent:
 * grouped by when they were made, oldest first), and of each moment only the last told for each item's effect,
 * sorted by the effect's own time (BroadcastFilteredGSF), each scattered as an OnGodmaShipEffect of its own. Each is
 * that notice's arguments: [itemID, effectID, when, isStart, ...].
 */
export function multiEventShipEffects(args: readonly unknown[]): readonly (readonly unknown[])[] {
  const moments = new Map<bigint, (readonly unknown[])[]>();
  for (const entry of itemsOf(args[0]) ?? []) {
    const pair = itemsOf(entry);
    const event = itemsOf(pair?.[0]);
    if (!pair || pair.length < 2 || !event || event[0] !== "OnGodmaShipEffect") continue;
    const when = unwrapLong(pair[pair.length - 1]) ?? 0n;
    if (!moments.has(when)) moments.set(when, []);
    moments.get(when)!.push(event);
  }
  const time = (event: readonly unknown[]): bigint => unwrapLong(event[3]) ?? 0n;
  const out: (readonly unknown[])[] = [];
  for (const when of [...moments.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const last = new Map<string, readonly unknown[]>();
    for (const event of moments.get(when)!.sort((a, b) => (time(a) < time(b) ? -1 : time(a) > time(b) ? 1 : 0))) {
      last.set(`${String(unwrapLong(event[1]))}:${String(unwrapLong(event[2]))}`, event);
    }
    for (const event of last.values()) out.push(event.slice(1));
  }
  return out;
}

/**
 * The damage messages riding an OnMultiEvent, as godma hands them on: a moment at a time (oldest first), every one in
 * the order told (OnMultiEvent_ gathers them, OnDamageMessages takes each as an OnDamageMessage of its own). Each is
 * that notice's arguments.
 */
export function multiEventDamageMessages(args: readonly unknown[]): readonly (readonly unknown[])[] {
  const moments = new Map<bigint, (readonly unknown[])[]>();
  for (const entry of itemsOf(args[0]) ?? []) {
    const pair = itemsOf(entry);
    const event = itemsOf(pair?.[0]);
    if (!pair || pair.length < 2 || !event || event[0] !== "OnDamageMessage") continue;
    const when = unwrapLong(pair[pair.length - 1]) ?? 0n;
    if (!moments.has(when)) moments.set(when, []);
    moments.get(when)!.push(event.slice(1));
  }
  return [...moments.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).flatMap((when) => moments.get(when)!);
}
