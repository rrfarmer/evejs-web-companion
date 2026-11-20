// `OnChargeBeingLoadedToModule` — the server saying a reload has started.
//
// Wire shape (dogmaService.js `_notifyChargeBeingLoadedToModule`, the same
// three positional args the retail client gets):
//
//   [ list of module itemIDs, chargeTypeID or null, reload time in ms ]
//
// In space the server QUEUES a load for the module's reload time instead of
// moving the charges in the call, and this push is the only word that it did.
// It arrives in the LoadAmmo response's own drained notifications, so it is
// already in the store by the time the call returns.

import { isListValue, unwrapLong, unwrapReal } from "./wire.ts";
import { slotFlagOf } from "./fitting.ts";
import type { FittingSlot } from "../store/types.ts";

export interface ChargeLoadEvent {
  readonly moduleIDs: readonly number[];
  readonly chargeTypeID: number | null;
  readonly durationMs: number;
}

function positiveID(value: unknown): number | null {
  const unwrapped = unwrapLong(value);
  return unwrapped !== null && unwrapped > 0n && unwrapped <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(unwrapped)
    : null;
}

export function decodeChargeLoadNotification(
  method: string | null,
  args: readonly unknown[],
): ChargeLoadEvent | null {
  if (method !== "OnChargeBeingLoadedToModule") {
    return null;
  }
  const rawList = isListValue(args[0]) ? args[0].items : Array.isArray(args[0]) ? args[0] : [];
  const moduleIDs = rawList.map(positiveID).filter((id): id is number => id !== null);
  const duration = Number(unwrapLong(args[2]) ?? Number.NaN);
  if (moduleIDs.length === 0 || !(duration > 0)) {
    return null;
  }
  return { moduleIDs, chargeTypeID: positiveID(args[1]), durationMs: duration };
}

// `OnModuleAttributeChanges` carrying a loaded charge's QUANTITY — the round
// count going down as a gun fires.
//
// Wire shape (attributeChangeNotification.js `buildAttributeChange`, sent per
// shot by loadedChargeState.js `notifyChargeQuantityChangeToSession`):
//
//   [ list of [ "OnModuleAttributeChange", charID, itemID, attributeID,
//               time, newValue, oldValue, time ] ]
//
// where a loaded charge's itemID is the (shipID, slot flagID, chargeTypeID)
// tuple and attribute 805 is quantity. Nothing else in the client re-reads the
// fit while guns are firing, so without this the rack's counts froze at the
// last reload.

const ATTRIBUTE_QUANTITY = 805;

export interface ChargeQuantityChange {
  readonly shipID: number;
  readonly flagID: number;
  readonly chargeTypeID: number;
  readonly quantity: number;
}

function itemsOf(value: unknown): readonly unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { items?: unknown }).items)
  ) {
    return (value as { items: unknown[] }).items;
  }
  return null;
}

/**
 * The events of an OnMultiEvent, each `[name, ...args]`, in the order of the
 * times they are paired with (godma.OnMultiEvent_ takes them a moment at a
 * time); those of one moment in the order sent.
 */
function multiEventEvents(args: readonly unknown[]): readonly (readonly unknown[])[] {
  const timed: { readonly when: bigint; readonly event: readonly unknown[] }[] = [];
  for (const entry of itemsOf(args[0]) ?? []) {
    const pair = itemsOf(entry);
    const event = itemsOf(pair?.[0]);
    if (event) timed.push({ when: unwrapLong(pair?.[1]) ?? 0n, event });
  }
  return timed
    .map((each, at) => ({ ...each, at }))
    .sort((left, right) => (left.when < right.when ? -1 : left.when > right.when ? 1 : left.at - right.at))
    .map((each) => each.event);
}

/**
 * The OnGodmaShipEffect notices inside an OnMultiEvent, each as its arguments,
 * in the order godma takes them. In space the server sends a module's effect
 * starting and stopping this way (runtime/dogmaEvents.js): riding a destiny
 * update, or alone when the tick has none.
 */
export function shipEffectsInMultiEvent(
  method: string | null,
  args: readonly unknown[],
): readonly (readonly unknown[])[] {
  if (method !== "OnMultiEvent") {
    return [];
  }
  return multiEventEvents(args).filter((event) => event[0] === "OnGodmaShipEffect").map((event) => event.slice(1));
}

/**
 * The round counts a notice tells of: an OnModuleAttributeChanges batch, one
 * OnModuleAttributeChange, or the changes inside an OnMultiEvent. In space the
 * server sends them the last way (runtime/dogmaEvents.js, each change its own
 * event), so a page that read only the batch saw no shot fired.
 */
export function decodeChargeQuantityChanges(
  method: string | null,
  args: readonly unknown[],
): readonly ChargeQuantityChange[] {
  let told: readonly unknown[];
  if (method === "OnModuleAttributeChanges") {
    told = itemsOf(args[0]) ?? [];
  } else if (method === "OnModuleAttributeChange") {
    told = [["OnModuleAttributeChange", ...args]];
  } else if (method === "OnMultiEvent") {
    told = multiEventEvents(args).flatMap((event) =>
      event[0] === "OnModuleAttributeChanges" ? itemsOf(event[1]) ?? [] : [event]);
  } else {
    return [];
  }
  const changes: ChargeQuantityChange[] = [];
  for (const entry of told) {
    const change = itemsOf(entry);
    if (!change || change[0] !== "OnModuleAttributeChange" || Number(unwrapLong(change[3])) !== ATTRIBUTE_QUANTITY) {
      continue;
    }
    // Only the charge tuple: a quantity change on a real item id is some
    // other stack, not the rounds in a gun.
    const tuple = itemsOf(change[2]);
    if (!tuple || tuple.length !== 3) {
      continue;
    }
    const [shipID, flagID, chargeTypeID] = tuple.map(positiveID);
    const quantity = unwrapReal(change[5]) ?? Number(unwrapLong(change[5]) ?? Number.NaN);
    if (shipID === null || flagID === null || chargeTypeID === null || !Number.isFinite(quantity) || quantity < 0) {
      continue;
    }
    changes.push({ shipID: shipID!, flagID: flagID!, chargeTypeID: chargeTypeID!, quantity: Math.trunc(quantity) });
  }
  return changes;
}

/**
 * The fit's slots with those round counts applied, or the SAME array when
 * nothing changed (so a push about another ship costs no redraw).
 *
 * A count of 0 empties the gun. A count for a type the slot does not hold is a
 * charge that has just gone in, and is recorded as loaded. A change for
 * another ship, or a slot with no module, is ignored.
 */
export function applyChargeQuantityChanges(
  slots: readonly FittingSlot[],
  activeShipID: number | null,
  changes: readonly ChargeQuantityChange[],
): readonly FittingSlot[] {
  let next: FittingSlot[] | null = null;
  for (const change of changes) {
    if (activeShipID === null || change.shipID !== activeShipID) {
      continue;
    }
    const current = next ?? slots;
    const at = current.findIndex((slot) => slotFlagOf(slot.family, slot.index) === change.flagID);
    const slot = at >= 0 ? current[at]! : null;
    if (!slot?.module) {
      continue;
    }
    const held = slot.module.charge;
    let charge = held;
    if (change.quantity === 0) {
      // Only empty the gun of the type that ran out: a swap sends the old
      // type to 0 and the new one up, in either order.
      charge = held && held.typeID === change.chargeTypeID ? null : held;
    } else if (!held || held.typeID !== change.chargeTypeID || held.quantity !== change.quantity) {
      charge = {
        itemID: [change.shipID, change.flagID, change.chargeTypeID],
        typeID: change.chargeTypeID,
        quantity: change.quantity,
      };
    }
    if (charge === held) {
      continue;
    }
    next ??= [...slots];
    next[at] = { ...slot, module: { ...slot.module, charge } };
  }
  return next ?? slots;
}
