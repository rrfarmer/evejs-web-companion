// R25 slice A: the drone panel's decoders — the bay, the two limits the server
// enforces on a launch, and the plain-language wording for what a drone is
// doing.
//
// Decoder rule (docs/bridge-wire-contract.md): numeric IDs decode with
// unwrapLong — never the `typeof === "number" ? … : 0` pattern, which silently
// zeroes a {type:"long"} wrapper.
//
// The rule that matters most here is the difference between ZERO and UNKNOWN,
// and it matters more for drones than anywhere else in this client. "You have
// no drones in space" and "we could not look" are the same pixels and opposite
// facts: the first invites a player to launch, the second invites them to
// launch a SECOND set on top of the flight already out there. Every read below
// keeps them apart, and null always means unknown.

import { unwrapLong, type JsonValue } from "./wire.ts";
import { decodeShipAttributes } from "./fitting.ts";
import type { DroneBayStack, DroneInSpace, DroneLimits } from "../store/types.ts";

function asObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

/** A positive game ID (long-aware), or null. */
function idOrNull(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const long = unwrapLong(value);
  if (long === null) {
    return null;
  }
  const numeric = Number(long);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

/** A finite number, or null. Zero is a real answer and survives. */
function numberOrNull(value: JsonValue | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const long = unwrapLong(value);
  const numeric = Number(long === null ? value : long);
  return Number.isFinite(numeric) ? numeric : null;
}

function ratioOrNull(value: JsonValue | undefined): number | null {
  const numeric = numberOrNull(value);
  return numeric === null ? null : Math.min(1, Math.max(0, numeric));
}

/**
 * Dogma attribute IDs for the two limits the SERVER enforces on a launch.
 *
 * They are read here rather than computed anywhere: 352 is how many drones may
 * be in space at once, 1271 is the hull's drone bandwidth in Mbit/sec, and each
 * drone type draws its own bandwidth against it. The client shows both and then
 * LETS THE SERVER REFUSE — pre-guessing a refusal here would mean
 * re-implementing the launch rules in the browser, and a browser that guesses
 * wrong either blocks a legal launch or promises an illegal one.
 */
const ATTR_MAX_ACTIVE_DRONES = 352;
const ATTR_DRONE_BANDWIDTH = 1271;

/**
 * The launch limits, read out of the ship's ordinary attribute map (the same
 * dogmaIM.ShipGetInfo result the fitting panel decodes — no new server call).
 *
 * Both are null when the ship has no such attribute, which is the honest answer
 * for a hull with no drone bay at all. A zero would read as "this ship may
 * carry no drones", which is TRUE for such a hull but indistinguishable from a
 * read that failed — so the panel is told "unknown" and says so.
 */
export function decodeDroneLimits(shipInfo: JsonValue | undefined): DroneLimits {
  if (shipInfo === undefined || shipInfo === null) {
    return { maxActiveDrones: null, droneBandwidth: null };
  }
  const attributes = decodeShipAttributes(shipInfo);
  const max = attributes.get(ATTR_MAX_ACTIVE_DRONES);
  const bandwidth = attributes.get(ATTR_DRONE_BANDWIDTH);
  return {
    maxActiveDrones: max === undefined || max === null ? null : Math.max(0, Math.trunc(max)),
    droneBandwidth:
      bandwidth === undefined || bandwidth === null ? null : Math.max(0, bandwidth),
  };
}

/**
 * The drone bay's stacks. `null` means the bay could not be read — NOT that it
 * is empty.
 */
export function decodeDroneBay(raw: JsonValue | undefined): readonly DroneBayStack[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const stacks: DroneBayStack[] = [];
  // The panel keys its rows by itemID, and a keyed `{#each}` given the same key
  // twice throws instead of rendering — which freezes the page, not just the
  // list (see distinctIDs in bridge/space.ts). One stack, one row.
  const seen = new Set<number>();
  for (const entry of raw as JsonValue[]) {
    const row = asObject(entry);
    const itemID = idOrNull(row.itemID);
    const typeID = idOrNull(row.typeID);
    if (itemID === null || typeID === null || seen.has(itemID)) {
      continue;
    }
    seen.add(itemID);
    stacks.push({ itemID, typeID, quantity: numberOrNull(row.quantity) ?? 1 });
  }
  return stacks;
}

/**
 * The drones actually in space, as the SERVER reports them. `null` means the
 * snapshot could not be read.
 */
export function decodeDronesInSpace(raw: JsonValue | undefined): readonly DroneInSpace[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const drones: DroneInSpace[] = [];
  // One drone, one row — same reason as the bay above.
  const seen = new Set<number>();
  for (const entry of raw as JsonValue[]) {
    const row = asObject(entry);
    const itemID = idOrNull(row.itemID);
    if (itemID === null || seen.has(itemID)) {
      continue;
    }
    seen.add(itemID);
    drones.push({
      itemID,
      typeID: idOrNull(row.typeID),
      name: typeof row.name === "string" && row.name.length > 0 ? row.name : null,
      // null stays null: "we could not tell what it is doing" is not "idle".
      activity: typeof row.activity === "string" && row.activity.length > 0 ? row.activity : null,
      targetID: idOrNull(row.targetID),
      shieldRatio: ratioOrNull(row.shieldRatio),
      armorRatio: ratioOrNull(row.armorRatio),
      hullRatio: ratioOrNull(row.hullRatio),
      // Absent reads as NOT controlled, which is the safe way round: it offers
      // recovery on a drone that may not need it, rather than offering Recall
      // on one that cannot hear the order.
      controlled: row.controlled === true,
    });
  }
  return drones;
}

// --- R34: the reason the server already wrote, per drone ---------------------
//
// ⚠ THE SERVER WAS NEVER SILENT. `droneRuntime.js` refuses a drone order one
// drone at a time and writes its reason into the call RESULT dict as it goes —
// `appendDroneError(response, droneID, "<sentence>")`, thirteen distinct
// sentences across engage / mine / salvage / scoop / recall, every one of them
// already plain player language. The BFF used to forward only the
// notifications, so all thirteen were thrown away before the browser ever saw
// them. R33's client-side prediction exists because of that loss, not because
// the server had nothing to say.
//
// The wire shape, captured live from the running emulator:
//
//   result: {"entries":[[9988400023314,["CustomNotify",{"entries":[["notify",
//      "That drone is not currently under this ship's control."]]}]]]}
//
// — a marshal dict keyed by droneID, each value the `["CustomNotify", {notify}]`
// tuple `buildDroneErrorTuple` makes.
//
// ⚠ WHAT THIS DECODER DOES NOT DO: it does not interpret, match, rank or
// reword. It hands the server's sentence back verbatim. Turning it into what
// the player reads is `describeRefusal`'s job (R31 — the one seam where a
// refusal becomes words), and the sentences pass through it untouched because
// they are already prose. A THIRTEEN-ENTRY LOOKUP TABLE HERE WOULD BE A BUG:
// it would silently swallow the fourteenth sentence the server adds.

/** One drone the server refused, and the exact words it refused with. */
export interface DroneOrderRefusal {
  /**
   * ⚠ FOR ATTRIBUTION ONLY, NEVER FOR DISPLAY (R7d). This is how a sentence is
   * tied back to the drone it belongs to; `flow.ts` resolves it to a NAME
   * immediately and the id does not travel any further than that.
   */
  readonly droneID: number;
  /** The server's own words, untouched. Rendered via `describeRefusal`. */
  readonly raw: string;
}

/** Marshal dict keys that carry a UserError's prose (the gateway reads both). */
const NOTIFY_KEYS: ReadonlySet<string> = new Set(["notify", "info"]);

/**
 * Pull the sentence out of one drone's error value.
 *
 * Deliberately a search rather than a fixed path: the runtime writes a bare
 * tuple for the three in-space orders and a LIST of tuples on the launch path
 * (`appendLaunchError`), and a decoder that hard-coded `value[1].entries[0][1]`
 * would decode one and silently return nothing for the other. Depth is capped
 * so a malformed payload cannot spin.
 */
function findNotifyText(value: JsonValue | undefined, depth = 0): string | null {
  if (depth > 6 || value === undefined || value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    const pair = value as JsonValue[];
    if (pair.length === 2 && typeof pair[0] === "string" && NOTIFY_KEYS.has(pair[0])) {
      const text = typeof pair[1] === "string" ? pair[1].trim() : "";
      if (text !== "") {
        return text;
      }
    }
    for (const item of pair) {
      const found = findNotifyText(item, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value as Record<string, JsonValue>)) {
      const found = findNotifyText(nested, depth + 1);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Every drone the server refused, in the order it refused them.
 *
 * ⚠ ONE ENTRY PER DRONE, AND NO DEDUPLICATION. This is R30's finding applied to
 * a fan-out that happens server-side instead of client-side: a drone order acts
 * on several drones and each one gets its own answer, so collapsing them —
 * whether into one message or by merging two drones that share a name — is the
 * exact failure R30 measured with two Strip Miner Is, where a later success
 * cleared a shared slot and hid an earlier refusal.
 *
 * A drone that is ABSENT from this list was not refused. That is not the same
 * as "it worked": the re-read of what is actually in space is still the only
 * authority on what the order did, and the caller still checks it.
 */
export function decodeDroneOrderRefusals(
  raw: JsonValue | undefined,
): readonly DroneOrderRefusal[] {
  const entries = asObject(raw).entries;
  if (!Array.isArray(entries)) {
    return [];
  }
  const refusals: DroneOrderRefusal[] = [];
  for (const entry of entries as JsonValue[]) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const droneID = idOrNull(entry[0]);
    if (droneID === null) {
      continue;
    }
    const raw = findNotifyText(entry[1]);
    if (raw === null) {
      continue;
    }
    refusals.push({ droneID, raw });
  }
  return refusals;
}

export interface DroneEngageOutcome {
  readonly status: "accepted" | "refused" | "uncertain";
  readonly acceptedDroneIDs: readonly number[];
  readonly refusedDroneIDs: readonly number[];
  readonly uncertainDroneIDs: readonly number[];
  readonly refusals: readonly DroneEngageRefusal[];
}

export interface DroneEngageRefusal extends DroneOrderRefusal {
  readonly errorKey: string;
}

function droneResultEntries(raw: JsonValue | undefined): readonly JsonValue[] | null {
  const result = asObject(raw);
  return (result.type === undefined || result.type === "dict") && Array.isArray(result.entries)
    ? result.entries : null;
}

/**
 * CmdEngage returns a dict containing only per-drone UserError tuples. An
 * omitted drone is confirmed only when the post-call read also shows this
 * ship controlling it on the requested target. Preserve partial outcomes so
 * a caller can retry refused drones without replaying accepted or unknown ones.
 */
export function decodeDroneEngageOutcome(
  result: JsonValue | undefined,
  inSpace: JsonValue | undefined,
  requestedDroneIDs: readonly number[],
  targetID: number,
): DroneEngageOutcome {
  const requested = new Set(requestedDroneIDs);
  const entries = droneResultEntries(result);
  const requestValid = requested.size === requestedDroneIDs.length &&
    requestedDroneIDs.length > 0 && requestedDroneIDs.every((id) => Number.isSafeInteger(id) && id > 0) &&
    Number.isSafeInteger(targetID) && targetID > 0;
  let readable = entries !== null && requestValid;
  const refused = new Set<number>();
  const reasons = new Map<number, DroneEngageRefusal>();
  const seen = new Set<number>();
  const malformed = new Set<number>();
  for (const entry of entries ?? []) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      readable = false;
      continue;
    }
    const droneID = idOrNull(entry[0]);
    if (droneID === null || !Number.isSafeInteger(droneID) || !requested.has(droneID)) {
      readable = false;
      continue;
    }
    if (seen.has(droneID)) {
      readable = false;
      malformed.add(droneID);
      continue;
    }
    seen.add(droneID);
    const value = entry[1];
    const args = Array.isArray(value) ? droneResultEntries(value[1]) : null;
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" ||
        value[0].trim() === "" || args === null ||
        args.some((arg) => !Array.isArray(arg) || arg.length !== 2)) {
      readable = false;
      malformed.add(droneID);
      continue;
    }
    refused.add(droneID);
    reasons.set(droneID, { droneID, errorKey: value[0], raw: findNotifyText(value) ?? value[0] });
  }
  for (const id of malformed) refused.delete(id);

  const observed = decodeDronesInSpace(inSpace);
  const flightReadable = Array.isArray(inSpace) && observed !== null && observed.length === inSpace.length &&
    inSpace.every((row) => typeof asObject(row).controlled === "boolean");
  const acceptedDroneIDs: number[] = [], refusedDroneIDs: number[] = [], uncertainDroneIDs: number[] = [];
  for (const id of requestedDroneIDs) {
    if (refused.has(id)) {
      refusedDroneIDs.push(id);
    } else if (readable && flightReadable && observed.some((drone) =>
      drone.itemID === id && drone.controlled && drone.targetID === targetID)) {
      acceptedDroneIDs.push(id);
    } else {
      uncertainDroneIDs.push(id);
    }
  }
  return {
    status: !requestValid || uncertainDroneIDs.length > 0 ? "uncertain"
      : refusedDroneIDs.length > 0 ? "refused" : "accepted",
    acceptedDroneIDs, refusedDroneIDs, uncertainDroneIDs,
    refusals: [...reasons.values()].filter((reason) => refused.has(reason.droneID)),
  };
}

/**
 * What a drone is doing, in the words a player uses (R9a).
 *
 * The gateway already turned the runtime's activity enum into a token; this
 * turns the token into a sentence fragment. An UNKNOWN token is rendered as
 * "Unknown", never silently as "Idle" — a player who is told their drones are
 * idle when nobody looked will not launch the ones that would have saved them.
 */
export function droneActivityLabel(activity: string | null): string {
  // dronesConst.DRONE_STATES (3698585's words, through gridcheck): each state's label, "-" for none, Incapacitated for one it does not know
  switch (activity) {
    case "idle":
      return "Idle";
    case "fighting":
      return "Fighting";
    case "mining":
      return "Mining";
    case "approaching":
      return "Approaching";
    case "returning":
      return "Returning";
    case "chasing":
      return "Following";
    case "fleeing":
      return "Fleeing";
    case "operating":
      return "Operating";
    case "repairing":
      return "Repairing";
    case "salvaging":
      return "Salvaging";
    case null:
      return "-";
    default:
      // DRONE_STATES.get(state, 'UI/Inflight/Drone/Incapacitated')
      return "Incapacitated";
  }
}

/** dronesConst.COLOR_BY_STATE: the state's colour in the drones window (none for no state). */
export function droneActivityColor(activity: string | null): string | null {
  switch (activity) {
    case "idle":
    case "repairing":
      return "#8DC169"; // SUCCESS_GREEN
    case "fighting":
    case "mining":
    case "operating":
    case "salvaging":
      return "#FF454B"; // DANGER_RED
    case "approaching":
    case "returning":
    case "chasing":
    case "fleeing":
      return "#FFB845"; // SAND_YELLOW
    default:
      return null;
  }
}

/**
 * Is a drone busy, as far as the server is concerned? Used only to sort the
 * working drones above the waiting ones. An unknown activity counts as NOT
 * busy, so it sorts with the drones a player might want to give a job to.
 */
export function droneIsBusy(activity: string | null): boolean {
  return (
    activity === "fighting" ||
    activity === "mining" ||
    activity === "approaching" ||
    activity === "chasing" ||
    activity === "salvaging"
  );
}
