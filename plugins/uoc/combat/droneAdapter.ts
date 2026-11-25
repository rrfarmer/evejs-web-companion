import { unwrapLong, unwrapReal } from "../shared/wire.ts";
/** Native drone writes are issued once; a timed-out call retains custody. */
export class DroneDispatchUnknown extends Error {}
export async function boundedDroneWrite<T>(
  dispatch: () => Promise<T>,
  timeoutMs: number,
  onUnknown: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dispatch(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DroneDispatchUnknown("Drone command is still in flight; custody is retained."),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    onUnknown();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const idOf = (value: unknown): number | null => {
  const n = unwrapLong(value);
  return n !== null && n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
};
const sequence = (v: any): any[] | null =>
  Array.isArray(v)
    ? v
    : v && (v.type === "list" || v.type === "tuple") && Array.isArray(v.items)
      ? v.items
      : null;
function reason(value: any, depth = 0): string | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 2 && ["notify", "info"].includes(value[0]) && typeof value[1] === "string")
      return value[1];
    for (const v of value) {
      const r = reason(v, depth + 1);
      if (r) return r;
    }
  } else if (typeof value === "object") {
    for (const v of Object.values(value)) {
      const r = reason(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}
/** Frozen native droneRuntime pre-action rejection: every selected drone must carry the exact refusal. */
export function allDronesTargetUnavailable(result: unknown, ids: readonly number[]): boolean {
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    return false;
  const x = result as any;
  if (!x || x.type !== "dict" || !Array.isArray(x.entries) || x.entries.length !== ids.length)
    return false;
  const seen = new Set<number>();
  for (const row of x.entries) {
    if (!Array.isArray(row) || row.length !== 2) return false;
    const id = idOf(row[0]),
      error = row[1];
    if (
      id === null ||
      !ids.includes(id) ||
      seen.has(id) ||
      !Array.isArray(error) ||
      error.length !== 2 ||
      error[0] !== "CustomNotify"
    )
      return false;
    seen.add(id);
    const body = error[1];
    if (
      !body ||
      body.type !== "dict" ||
      !Array.isArray(body.entries) ||
      body.entries.length !== 1 ||
      !Array.isArray(body.entries[0]) ||
      body.entries[0].length !== 2 ||
      body.entries[0][0] !== "notify" ||
      body.entries[0][1] !== "That target cannot be engaged by drones."
    )
      return false;
  }
  return seen.size === ids.length;
}
/** Exact full pre-action target refusal, distinguishable from a partial or unreadable response. */
export class DroneOrderRefused extends Error {}
export class DroneTargetUnavailableRefusal extends DroneOrderRefused {}
/** A native CmdEngage dictionary contains one error entry per refused drone. */
export function checkDroneEngage(result: unknown, ids: readonly number[]): void {
  const x = result as any;
  if (!x || x.type !== "dict" || !Array.isArray(x.entries))
    throw Error("Drone engagement result is unreadable.");
  const seen = new Set<number>(),
    errors: string[] = [];
  for (const row of x.entries) {
    const id = Array.isArray(row) ? idOf(row[0]) : null;
    if (!Array.isArray(row) || row.length !== 2 || id === null || !ids.includes(id) || seen.has(id))
      throw Error("Drone engagement result is malformed.");
    seen.add(id);
    errors.push(`${id}: ${reason(row[1]) ?? "Native drone order refused"}`);
  }
  if (errors.length) {
    const message = `Drone order refused: ${errors.join("; ")}`;
    if (allDronesTargetUnavailable(result, ids)) throw new DroneTargetUnavailableRefusal(message);
    throw new DroneOrderRefused(message);
  }
}
/** Require exactly the requested number from every native launch stack. */
export function launchedDroneIDs(
  result: unknown,
  stacks: readonly { itemID: number; quantity: number }[],
): number[] {
  const x = result as any;
  if (!x || x.type !== "dict" || !Array.isArray(x.entries))
    throw Error("Drone launch result is unreadable.");
  const seen = new Set<number>(),
    ids: number[] = [];
  for (const entry of x.entries) {
    const stackID = Array.isArray(entry) ? idOf(entry[0]) : null;
    const stack = stacks.find((s) => s.itemID === stackID);
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      stackID === null ||
      !stack ||
      seen.has(stackID)
    )
      throw Error("Drone launch result is malformed.");
    seen.add(stackID);
    const items = sequence(entry[1]);
    if (!items || items.length !== stack.quantity)
      throw Error("Drone launch count differs from request.");
    for (const raw of items) {
      const id = idOf(raw);
      if (id === null || ids.includes(id))
        throw Error(`Drone launch refused or unreadable: ${reason(raw) ?? "unknown"}`);
      ids.push(id);
    }
  }
  if (seen.size !== stacks.length || !ids.length) throw Error("Drone launch was not confirmed.");
  return ids;
}

type CombatDroneStack = { itemID: number; typeID: number; quantity: number };

/** The server charges bandwidth for every controlled drone, including noncombat drones. */
export function planCombatDroneLaunch(
  bay: readonly CombatDroneStack[],
  deployed: readonly { typeID: number }[],
  limits: { maxActiveDrones: number; droneBandwidth: number },
  costs: Readonly<Record<number, number | null | undefined>>,
): CombatDroneStack[] {
  const cost = (id: number) => {
    const value = costs[id];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
      throw Error("Native drone bandwidth cost is unavailable for type " + id + ".");
    return value;
  };
  let count = Math.max(0, limits.maxActiveDrones - deployed.length);
  let bandwidth =
    limits.droneBandwidth - deployed.reduce((total, drone) => total + cost(drone.typeID), 0);
  const ordered = bay
    .map((stack) => ({ stack, cost: cost(stack.typeID) }))
    .sort((a, b) => b.cost - a.cost || a.stack.itemID - b.stack.itemID);
  const launch: CombatDroneStack[] = [];
  for (const { stack, cost: needed } of ordered) {
    const quantity = Math.min(stack.quantity, count, Math.max(0, Math.floor(bandwidth / needed)));
    if (quantity === 0) continue;
    launch.push({ ...stack, quantity });
    count -= quantity;
    bandwidth -= quantity * needed;
  }
  return launch;
}

const launchRefusals = new Set([
  "Maximum active drones already in space.",
  "Not enough drone bandwidth to launch that drone.",
  "That drone is not available in the active ship drone bay.",
  "The requested drone stack is no longer available.",
]);

/** The native launch reply is per stack and may contain successes followed by a refusal. */
export function readCombatDroneLaunch(
  result: unknown,
  stacks: readonly { itemID: number; quantity: number }[],
) {
  const x = result as any;
  if (x?.type !== "dict" || !Array.isArray(x.entries) || x.entries.length !== stacks.length)
    throw Error("Drone launch result is unreadable.");
  const ids: number[] = [],
    refusals: string[] = [],
    seen = new Set<number>();
  for (const row of x.entries) {
    const id = Array.isArray(row) ? idOf(row[0]) : null,
      stack = stacks.find((s) => s.itemID === id),
      items = sequence(row?.[1]);
    if (
      !stack ||
      seen.has(stack.itemID) ||
      row.length !== 2 ||
      !items?.length ||
      items.length > stack.quantity
    )
      throw Error("Drone launch stack result is unreadable.");
    seen.add(stack.itemID);
    for (const [index, item] of items.entries()) {
      const launched = idOf(item);
      if (launched !== null && !ids.includes(launched)) {
        ids.push(launched);
        continue;
      }
      const body =
        Array.isArray(item) && item.length === 2 && item[0] === "CustomNotify" ? item[1] : null;
      const row = body?.type === "dict" && body.entries?.length === 1 ? body.entries[0] : null;
      const refusal =
        Array.isArray(row) && row.length === 2 && row[0] === "notify" && typeof row[1] === "string"
          ? row[1]
          : null;
      if (index !== items.length - 1 || !refusal || !launchRefusals.has(refusal))
        throw Error("Drone launch outcome is unknown: " + (refusal ?? "unreadable result"));
      refusals.push(refusal);
    }
    if (items.length < stack.quantity && idOf(items.at(-1)) !== null)
      throw Error("Drone launch result omitted part of the requested stack.");
  }
  return { ids, refusals: [...new Set(refusals)] };
}

/** Read-only requests may time out without leaving a gameplay write in flight. */
export async function boundedDroneRead<T>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Drone observation timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Called only for a previously acknowledged return; progress resets the observation window. */
export function stalledReturn(
  prior: { at: number; distance: number; rearmed: boolean },
  distance: number,
  at: number,
  activity: string | null,
  target: number | null,
  shipID: number,
): boolean {
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(at))
    throw Error("Drone return distance is unreadable.");
  if (prior.rearmed) return false;
  if (distance < prior.distance - 100) {
    prior.distance = distance;
    prior.at = at;
    return false;
  }
  return at - prior.at >= 15000 && activity?.toLowerCase() === "returning" && target === shipID;
}

/** Unlike ShipGetInfo and the pilot item, the native fitted-ship query includes
 * attribute 352 as used by LaunchDrones, including effective hull overrides. */
export function effectiveDroneLimits(raw: unknown) {
  const value = raw as { type?: unknown; entries?: unknown[] } | null;
  const get = (attribute: number) => {
    const rows =
      value?.type === "dict" && Array.isArray(value.entries)
        ? value.entries.filter((row) => Array.isArray(row) && row[0] === attribute)
        : [];
    const n = rows.length === 1 ? unwrapReal((rows[0] as unknown[])[1]) : null;
    return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const count = get(352);
  return { maxActiveDrones: Number.isSafeInteger(count) ? count : null, droneBandwidth: get(1271) };
}
