// The fleet companion's hurt-drone rotation: pull every drone that is being
// shot, and put the fight back together without handing the rats the same
// drone again.
//
// The drone-boat block keeps its own one-at-a-time machine (droneRotation.ts,
// spec §4); this is the companion's, and it differs from that one in the three
// places live fights showed it losing drones (2026-10-16, 2026-10-19):
//
// ⚠ 1. EVERY HURT DRONE IN ONE CALL. One at a time made a second drone that the
// rats picked wait out the first one's whole round trip, shield already going.
// The server's recall takes a list and scoops them together
// (`commandReturnDrones`, droneRuntime.js), so a hurt pair costs one call.
// The cost the old rule was protecting against -- two drones in transit at
// once -- is smaller than the cost of the second one dying.
//
// ⚠ 2. THE SAME DRONE GOES STRAIGHT BACK ON THE RAT'S LIST. On this server a
// rat records whoever damaged it as its preferred and retaliation target, BY
// ENTITY ID, for 60 s (`noteIncomingAggression`, `NPC_RETALIATION_MEMORY_MS`
// in npcBehaviorLoop.js), and a scooped drone keeps its item id when it is
// relaunched. So relaunching the drone the rat was shooting put it back in
// front of a rat that was still looking for it: seen 2026-10-16 20:35, one drone
// pulled three times in 29 s and then, its rotations spent, left to die.
// Two ways out, in order:
//   - a SPARE: another drone of the same type from the bay, whose id no rat
//     has. The hurt one stays aboard (its armour damage stays with it; only the
//     shield comes back on a scoop) and becomes a spare itself later.
//   - no spare: HOLD the drone aboard until every rat seen on it at the recall
//     has visibly taken a NEW target (its orbit or follow now names someone
//     else) or left the grid. A rat that has a current target keeps it while it
//     stays valid, so a relaunch then is no longer its business. Bounded:
//     `RETARGET_HOLD_MAX_MS` with attackers seen, `BLIND_HOLD_MS` without any
//     (a sentry, or a rat that keeps at range and names no ball).
//
// ⚠ 3. THE ROTATION CAP IS PER DRONE ID, AND A SPARE IS A NEW ID. Booked at the
// recall, as before, so a recall that fails is still bounded.
//
// What it keeps from the block's machine, for the same reasons written there:
// the trigger is the SHIELD below full and only the shield (armour does not
// come back, so it would be a permanent trigger); an unreadable shield is not
// a low one; death is inferred only from ticks that could see both space and
// the bay; and an order that never lands is given up on, never waited on for
// ever.
//
// PURE. Plain data in, plain data out: the clock is an argument, and the
// record is plain JSON so it survives the ladder memory as-is.

import { MAX_DRONE_ROTATIONS } from "../../../web/src/plugin-api/flying.ts";

/** How long a drone that was shot waits aboard for its rats to pick someone else. */
export const RETARGET_HOLD_MAX_MS = 12_000;
/**
 * How long it waits when no rat was seen on it. A rat that names no ball
 * cannot be watched retargeting; a few seconds is what a rat with a few
 * controllers ahead of it in the server's think round needs to notice the
 * drone is gone and choose again.
 */
export const BLIND_HOLD_MS = 3_000;
/**
 * The server's retaliation memory. A drone recalled for being shot is "hot" for
 * this long and is not picked as somebody else's spare.
 */
export const HOT_MS = 60_000;
/** How long a recall may take to bring a drone aboard before it is given up on. */
export const RECALL_GIVE_UP_MS = 30_000;
/** How long a launch may take to show in space before it is given up on. */
export const RELAUNCH_WAIT_MS = 6_000;
/** Readable ticks a rotating drone must be absent from space AND bay to be written off. */
export const DEAD_DRONE_TICKS = 2;

/** One of this ship's drones in space, with what the rotation needs to know. */
export interface RotationDroneRow {
  readonly itemID: number;
  readonly typeID: number | null;
  readonly shieldRatio: number | null;
  /** Hostile ships whose orbit or follow names this drone. Empty is "none seen". */
  readonly attackers: readonly number[];
}

/** A stack in the bay. `quantity` below 1 is a singleton (the server writes -1). */
export interface RotationBayStack {
  readonly itemID: number;
  /** Null where the type did not read: such a stack is never anybody's spare. */
  readonly typeID: number | null;
  readonly quantity: number;
}

/** A hostile on grid, and the ball it is orbiting or following (null: none named). */
export interface RotationHostile {
  readonly itemID: number;
  readonly targetEntityID: number | null;
}

export interface RotationInputs {
  /** This role's drones in space; null/undefined is "nobody looked". */
  readonly drones: readonly RotationDroneRow[] | null | undefined;
  /** This role's bay stacks; null/undefined is "nobody looked". */
  readonly bay: readonly RotationBayStack[] | null | undefined;
  /** The hostiles on grid; null/undefined is "nobody looked". */
  readonly hostiles: readonly RotationHostile[] | null | undefined;
  readonly memory: unknown;
  readonly nowMs: number;
}

/** A drone recalled for its shield, on its way home. */
export type HomewardDrone = {
  readonly itemID: number;
  readonly typeID: number | null;
  readonly recalledAtMs: number;
  readonly attackers: readonly number[];
  readonly missingTicks: number;
};

/** A drone aboard after a rotation recall, waiting to be replaced or relaunched. */
export type AboardDrone = {
  readonly itemID: number;
  readonly typeID: number | null;
  readonly aboardAtMs: number;
  readonly attackers: readonly number[];
  /** A spare was sent for it and never left the bay: it goes out itself now. */
  readonly spareTried: boolean;
};

/** A launch issued by the rotation, waiting to show in space. */
export type RotationLaunch = {
  /** The hurt drone this launch replaces (spare) or is (same). */
  readonly hurtID: number;
  readonly typeID: number | null;
  /** "same": the hurt drone itself; "spare": a drone of its type from another stack. */
  readonly via: "same" | "spare";
  /** The bay stack launched from (the hurt drone's own id for "same"). */
  readonly stackID: number;
  readonly sentAtMs: number;
  /** How many the launched stack held when it was sent (a singleton: 1). */
  readonly stackQuantityAtSend: number;
};

/** The record the ladder carries. A `type`, not an `interface`: it lives in memory slots. */
export type CompanionDroneRotationMemory = {
  readonly homeward: readonly HomewardDrone[];
  readonly aboard: readonly AboardDrone[];
  readonly launching: readonly RotationLaunch[];
  /** Rotations booked per drone item id (string keys: plain JSON). */
  readonly rotations: Readonly<Record<string, number>>;
  /** When each drone was last recalled for being shot (string keys). */
  readonly recalledAtMs: Readonly<Record<string, number>>;
};

export function emptyCompanionDroneRotation(): CompanionDroneRotationMemory {
  return { homeward: [], aboard: [], launching: [], rotations: {}, recalledAtMs: {} };
}

/** Whether a rotation is under way: something flying home, held aboard, or launching. */
export function rotationBusy(memory: CompanionDroneRotationMemory): boolean {
  return memory.homeward.length > 0 || memory.aboard.length > 0 || memory.launching.length > 0;
}

/** The drones flying home for their shield, which no new order may name. */
export function homewardIDs(memory: CompanionDroneRotationMemory): readonly number[] {
  return memory.homeward.map((row) => row.itemID);
}

export type RotationReason =
  | "idle"
  | "unreadable"
  /** Hurt drones were recalled this tick. */
  | "recalling"
  /** Drones are flying home, held aboard, or a launch is landing; nothing to send. */
  | "waiting"
  /** A replacement or the drone itself was launched this tick. */
  | "relaunching"
  /** A hurt drone has spent its rotations and fights on. */
  | "capped";

export type RotationStep = {
  readonly action:
    | { readonly kind: "none" }
    | { readonly kind: "recall"; readonly droneIDs: readonly number[] }
    | {
      readonly kind: "launch";
      readonly droneItemIDs: readonly number[];
      /** Per stack, how many to take: one per drone replaced from it, one for a drone itself. */
      readonly quantities: Readonly<Record<number, number>>;
      /** How many go out as spares, and how many are the shot drone itself. */
      readonly spares: number;
      readonly relaunched: number;
    };
  readonly reason: RotationReason;
  readonly memory: CompanionDroneRotationMemory;
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function idList(value: unknown): number[] {
  return Array.isArray(value) ? value.map(finite).filter((id): id is number => id !== null) : [];
}

function countRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value !== null && typeof value === "object") {
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const n = finite(raw);
      if (n !== null && n > 0) out[key] = n;
    }
  }
  return out;
}

/** Rebuild the record from whatever the memory slot held; a wrong shape is an empty record, never a throw. */
export function readCompanionDroneRotation(value: unknown): CompanionDroneRotationMemory {
  if (value === null || typeof value !== "object") return emptyCompanionDroneRotation();
  const raw = value as Record<string, unknown>;
  const rows = (list: unknown): Record<string, unknown>[] =>
    Array.isArray(list) ? list.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object") : [];
  const homeward: HomewardDrone[] = [];
  for (const row of rows(raw.homeward)) {
    const itemID = finite(row.itemID);
    const recalledAtMs = finite(row.recalledAtMs);
    if (itemID === null || recalledAtMs === null) continue;
    homeward.push({ itemID, typeID: finite(row.typeID), recalledAtMs, attackers: idList(row.attackers), missingTicks: finite(row.missingTicks) ?? 0 });
  }
  const aboard: AboardDrone[] = [];
  for (const row of rows(raw.aboard)) {
    const itemID = finite(row.itemID);
    const aboardAtMs = finite(row.aboardAtMs);
    if (itemID === null || aboardAtMs === null) continue;
    aboard.push({ itemID, typeID: finite(row.typeID), aboardAtMs, attackers: idList(row.attackers), spareTried: row.spareTried === true });
  }
  const launching: RotationLaunch[] = [];
  for (const row of rows(raw.launching)) {
    const hurtID = finite(row.hurtID);
    const stackID = finite(row.stackID);
    const sentAtMs = finite(row.sentAtMs);
    if (hurtID === null || stackID === null || sentAtMs === null || (row.via !== "same" && row.via !== "spare")) continue;
    launching.push({ hurtID, typeID: finite(row.typeID), via: row.via, stackID, sentAtMs, stackQuantityAtSend: finite(row.stackQuantityAtSend) ?? 1 });
  }
  return { homeward, aboard, launching, rotations: countRecord(raw.rotations), recalledAtMs: countRecord(raw.recalledAtMs) };
}

function ratio(value: number | null): number | null {
  const n = finite(value);
  if (n === null) return null;
  return Math.min(1, Math.max(0, n));
}

/**
 * Whether the rats seen on a drone have all moved on: each one gone from the
 * grid, or orbiting or following somebody else. `null` from a rat is "it names
 * no ball", which is not a new target -- a rat with no current target is the
 * one whose retaliation memory would put it straight back on the drone.
 */
function attackersMovedOn(attackers: readonly number[], droneID: number, hostiles: readonly RotationHostile[]): boolean {
  for (const attackerID of attackers) {
    const rat = hostiles.find((row) => row.itemID === attackerID);
    if (rat === undefined) continue;
    if (rat.targetEntityID === null || rat.targetEntityID === droneID) return false;
  }
  return true;
}

/** One tick: at most one call (a recall OR a launch), and the record to carry. */
export function decideCompanionDroneRotation(inputs: RotationInputs): RotationStep {
  const memory = readCompanionDroneRotation(inputs.memory);
  const nowMs = inputs.nowMs;
  const spaceReadable = Array.isArray(inputs.drones);
  const bayReadable = Array.isArray(inputs.bay);
  const drones = spaceReadable ? (inputs.drones as readonly RotationDroneRow[]) : [];
  const bay = bayReadable ? (inputs.bay as readonly RotationBayStack[]) : [];
  const hostiles = Array.isArray(inputs.hostiles) ? (inputs.hostiles as readonly RotationHostile[]) : null;
  const inSpace = new Map(drones.map((row) => [row.itemID, row]));
  const inBay = new Set(bay.map((stack) => stack.itemID));
  const stackSize = (itemID: number): number | null => {
    const stack = bay.find((row) => row.itemID === itemID);
    return stack === undefined ? null : Math.max(1, stack.quantity);
  };

  // --- flying home: aboard, dead, or given up on ---------------------------
  const homeward: HomewardDrone[] = [];
  const aboard: AboardDrone[] = [...memory.aboard];
  for (const row of memory.homeward) {
    const here = inSpace.has(row.itemID);
    const home = inBay.has(row.itemID);
    if (home) {
      if (!aboard.some((held) => held.itemID === row.itemID)) {
        aboard.push({ itemID: row.itemID, typeID: row.typeID, aboardAtMs: nowMs, attackers: row.attackers, spareTried: false });
      }
      continue;
    }
    if (spaceReadable && bayReadable && !here) {
      // Absent from both: dead, once it has been absent long enough to be sure.
      if (row.missingTicks + 1 >= DEAD_DRONE_TICKS) continue;
      homeward.push({ ...row, missingTicks: row.missingTicks + 1 });
      continue;
    }
    // The recall never landed (a full bay, a lost order): the drone is still
    // out and still shooting, which is survivable. Let it go.
    if (nowMs - row.recalledAtMs >= RECALL_GIVE_UP_MS) continue;
    // A rat that takes it on while it flies home is one more to wait out.
    const seen = inSpace.get(row.itemID)?.attackers ?? [];
    const attackers = [...row.attackers, ...seen.filter((id) => !row.attackers.includes(id))];
    homeward.push({ ...row, attackers, missingTicks: here ? 0 : row.missingTicks });
  }

  // --- launches landing ----------------------------------------------------
  const launching: RotationLaunch[] = [];
  for (const row of memory.launching) {
    // Landed once the stack it came from gave a drone up: the bay is where a
    // launch shows first, and it does not depend on which ids the server gave
    // the drones it put out, or on other drones coming and going meanwhile.
    const left = stackSize(row.stackID);
    const landed = (row.via === "same" && inSpace.has(row.hurtID)) ||
      (bayReadable && (left === null || left < row.stackQuantityAtSend));
    if (landed) continue;
    if (nowMs - row.sentAtMs < RELAUNCH_WAIT_MS) {
      launching.push(row);
      continue;
    }
    // Not out after the wait. A spare that did not land falls back to the
    // drone itself, which is still aboard; a drone that did not land is left
    // in the bay for the launch branch -- bandwidth, most likely, which
    // waiting does not mend.
    if (row.via === "spare" && inBay.has(row.hurtID)) {
      aboard.push({ itemID: row.hurtID, typeID: row.typeID, aboardAtMs: nowMs - RETARGET_HOLD_MAX_MS, attackers: [], spareTried: true });
    }
  }

  let rotations = memory.rotations;
  let recalledAtMs = Object.fromEntries(
    Object.entries(memory.recalledAtMs).filter(([, at]) => nowMs - at < HOT_MS),
  );

  // --- new hurt drones: all of them, in one call ---------------------------
  if (!spaceReadable) {
    return {
      action: { kind: "none" },
      reason: homeward.length + aboard.length + launching.length > 0 ? "waiting" : "unreadable",
      memory: { homeward, aboard, launching, rotations, recalledAtMs },
    };
  }
  // ⚠ THE BAY IS AHEAD OF THE SNAPSHOT AFTER A SCOOP. For a second or so a
  // scooped drone is in the bay read AND still in the space snapshot, shield
  // still short. Seen live 2026-10-19 09:24-09:29, every rotation: read as a
  // fresh hit, it was recalled two or three times more -- each booking a
  // rotation, so one hit spent a drone's whole cap -- and landed aboard once per
  // recall, so one hit sent out two spares, or a spare and the drone itself.
  // A drone in the bay, held aboard, or flying home is never a new hit.
  const settled = new Set<number>([
    ...homeward.map((row) => row.itemID),
    ...aboard.map((row) => row.itemID),
    ...inBay,
  ]);
  const hurt: RotationDroneRow[] = [];
  let capped = false;
  for (const row of drones) {
    const shield = ratio(row.shieldRatio);
    if (shield === null || shield >= 1 || settled.has(row.itemID)) continue;
    if ((rotations[String(row.itemID)] ?? 0) >= MAX_DRONE_ROTATIONS) {
      capped = true;
      continue;
    }
    hurt.push(row);
  }
  if (hurt.length > 0) {
    hurt.sort((a, b) => a.itemID - b.itemID);
    const nextRotations: Record<string, number> = { ...rotations };
    const nextRecalled: Record<string, number> = { ...recalledAtMs };
    for (const row of hurt) {
      const key = String(row.itemID);
      nextRotations[key] = (nextRotations[key] ?? 0) + 1;
      nextRecalled[key] = nowMs;
      homeward.push({ itemID: row.itemID, typeID: row.typeID, recalledAtMs: nowMs, attackers: [...row.attackers], missingTicks: 0 });
    }
    rotations = nextRotations;
    recalledAtMs = nextRecalled;
    return {
      action: { kind: "recall", droneIDs: hurt.map((row) => row.itemID) },
      reason: "recalling",
      memory: { homeward, aboard, launching, rotations, recalledAtMs },
    };
  }

  // --- drones aboard: a spare now, or the drone itself once its rats moved on
  const ids: number[] = [];
  const quantities: Record<number, number> = {};
  const held: AboardDrone[] = [];
  const sent: RotationLaunch[] = [];
  const taken = new Map<number, number>();
  const aboardIDs = new Set(aboard.map((row) => row.itemID));
  let spares = 0;
  let same = 0;
  for (const row of aboard) {
    if (bayReadable && !inBay.has(row.itemID)) {
      // Gone from the bay without our launch: someone else put it out, or it
      // was moved. Not ours to relaunch any more.
      continue;
    }
    const spare = row.typeID === null || row.spareTried ? undefined : bay.find((stack) => {
      if (stack.typeID !== row.typeID || aboardIDs.has(stack.itemID)) return false;
      if (recalledAtMs[String(stack.itemID)] !== undefined) return false;
      const left = Math.max(1, stack.quantity) - (taken.get(stack.itemID) ?? 0);
      return left > 0;
    });
    if (spare !== undefined) {
      taken.set(spare.itemID, (taken.get(spare.itemID) ?? 0) + 1);
      if (!ids.includes(spare.itemID)) ids.push(spare.itemID);
      quantities[spare.itemID] = taken.get(spare.itemID) as number;
      sent.push({ hurtID: row.itemID, typeID: row.typeID, via: "spare", stackID: spare.itemID, sentAtMs: nowMs, stackQuantityAtSend: Math.max(1, spare.quantity) });
      spares += 1;
      continue;
    }
    const waited = nowMs - row.aboardAtMs;
    const release = row.attackers.length === 0
      ? waited >= BLIND_HOLD_MS
      : waited >= RETARGET_HOLD_MAX_MS || (hostiles !== null && attackersMovedOn(row.attackers, row.itemID, hostiles));
    if (!release) {
      held.push(row);
      continue;
    }
    if (!ids.includes(row.itemID)) ids.push(row.itemID);
    quantities[row.itemID] = 1;
    sent.push({ hurtID: row.itemID, typeID: row.typeID, via: "same", stackID: row.itemID, sentAtMs: nowMs, stackQuantityAtSend: stackSize(row.itemID) ?? 1 });
    same += 1;
  }
  if (ids.length > 0) {
    return {
      action: { kind: "launch", droneItemIDs: ids, quantities, spares, relaunched: same },
      reason: "relaunching",
      memory: { homeward, aboard: held, launching: [...launching, ...sent], rotations, recalledAtMs },
    };
  }
  const busy = homeward.length + held.length + launching.length > 0;
  return {
    action: { kind: "none" },
    reason: busy ? "waiting" : capped ? "capped" : "idle",
    memory: { homeward, aboard: held, launching, rotations, recalledAtMs },
  };
}
