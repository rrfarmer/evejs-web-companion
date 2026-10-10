// Whether one item's move is the drone bay's business.
//
// The server tells of one item's move by OnItemChange: the item as it now is, and
// what it was before, by column. The client's drones window reads its drones
// again on some of these and not on the rest (dronesWindow.OnItemChange, 254 to
// 260):
//
//   if item.locationID == session.shipid:
//       the item is in the drone bay, or was       -> read again
//   elif it was in this ship, and in the drone bay -> read again
//
// which is a drone landed, a drone launched, and a drone put into or taken out
// of the bay by hand. A charge loaded or ore come into the hold is neither.
//
// ⚠ WHAT CANNOT BE READ IS READ AGAIN. A re-read costs three calls; a window
// left saying a landed drone is still coming home costs the pilot's trust in
// it. So a row without its fields, a change that is no dict, or a ship not yet
// known, is taken for the bay's business.

const FLAG_DRONE_BAY = 87;
// const.ixLocationID and const.ixFlag: the columns a change is keyed by.
const IX_LOCATION_ID = 3;
const IX_FLAG = 4;

type Fields = { readonly [key: string]: unknown };

function fieldsOf(item: unknown): Fields | null {
  if (typeof item !== "object" || item === null) return null;
  const fields = (item as { readonly fields?: unknown }).fields;
  return typeof fields === "object" && fields !== null ? (fields as Fields) : null;
}

/** What the item was, by column; null where it is not a dict of pairs. */
function changeOf(change: unknown): ReadonlyMap<number, unknown> | null {
  if (typeof change !== "object" || change === null) return null;
  const entries = (change as { readonly entries?: unknown }).entries;
  if (!Array.isArray(entries)) return null;
  const was = new Map<number, unknown>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "number") return null;
    was.set(entry[0], entry[1]);
  }
  return was;
}

/**
 * Whether an OnItemChange with these arguments is one the drones are read again
 * on, for a pilot whose ship (the one whose bay the window shows) is `shipID`.
 */
export function itemChangeTouchesDroneBay(args: readonly unknown[], shipID: number | null): boolean {
  const item = fieldsOf(args[0]);
  const was = changeOf(args[1]);
  if (shipID === null || item === null || was === null) {
    return true;
  }
  if (item.locationID === shipID) {
    return item.flagID === FLAG_DRONE_BAY || was.get(IX_FLAG) === FLAG_DRONE_BAY;
  }
  return was.get(IX_LOCATION_ID) === shipID && was.get(IX_FLAG) === FLAG_DRONE_BAY;
}
