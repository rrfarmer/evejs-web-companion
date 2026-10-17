// The pure planner for a DEDICATED SALVAGER working a grid of many wrecks and
// loot cans scattered over tens of kilometres: ONE action per tick, from the
// ship's position, the wrecks, and the state of its tractor beams, salvagers
// and target locks. No I/O, no clock, no memory of its own -- the coordinator
// (flow.ts / scriptMacros.ts) observes, calls `planSalvageTick`, dispatches the
// action, and echoes `committedAnchor` back next tick.
//
// ─── THE TECHNIQUE THIS IS BASED ON (not invented) ───────────────────────────
//
// EVE University, "Salvaging" (https://wiki.eveuniversity.org/Salvaging) and
// "Noctis" (https://wiki.eveuniversity.org/Noctis):
//
//   * The standard hull is a balanced rack: as many tractor beams as salvagers
//     (4+4 on eight highs), "so four wrecks are salvaged while four more are
//     pulled in". More tractors (5+3) when salvaging while moving; more
//     salvagers when the field is dense / a Mobile Tractor Unit is down.
//   * The field is worked FROM ONE SPOT: "bookmark a wreck near the centre of
//     the field -- the one with the most wrecks within tractor range -- warp or
//     fly there and stop." Then tractors pull distant wrecks to within 2,500 m,
//     each tractor is switched off and retargeted when its wreck arrives, one
//     salvager sits on each nearby wreck, and you LOOT WHILE THE SALVAGERS
//     CYCLE. Salvaging a wreck that still holds loot leaves a container.
//   * Ranges: Tractor Beam I ~20 km; Salvager I 5 km, II 6 km, 10 s cycle;
//     looting needs <= 2,500 m. The Noctis' bonuses let it pull a whole field
//     from one spot, and it may need no propulsion module: it can stay put.
//   * Targeting skills cap simultaneous locks.
//
// ─── SERVER FACTS THIS PLANNER IS WRITTEN AGAINST (from the eve.js source) ───
//
//   * A TRACTOR NEEDS NO LOCK; it is activated on the wreck/can by id, within
//     its range, and is refused without LOOT RIGHTS. So only `tractorable`
//     items (we hold loot rights) are ever tractored -- a wreck we may only
//     salvage is not.
//   * A tractor pulls to a 500 m hold distance and then CYCLES FOREVER. It
//     never frees itself on arrival, so the planner DEACTIVATES a tractor whose
//     target has settled (inside loot range, or inside salvage range for an
//     already-looted wreck), and the module goes on to the next wreck. It stops
//     by itself only if the target vanishes or leaves range.
//   * A SALVAGER NEEDS A LOCK, and a salvage that succeeds stops the module and
//     removes the wreck (or, if it held loot, swaps it for a new container).
//     So locks are a budget for SALVAGERS ONLY. A wreck still holding loot is
//     salvaged as soon as it is locked, not after it is looted: its loot goes
//     into the can that takes its place, with the wreck's own loot rights
//     (salvagerRuntime.js, buildReplacementContainerLootCustomInfo), and the
//     can is looted in the ticks between like any other. Waiting for the loot
//     first made the wrecks ready one at a time, and every salvager piled onto
//     the one that was (seen live 2026-10-16).
//
// ─── THE DECISION RULES, IN PRIORITY ORDER ───────────────────────────────────
//
//   D. DONE: nothing left that needs work -> `{ done: true }`.
//   1. LOOT IN THE GAPS: any lootable, unlooted wreck/can within `lootRangeM`
//      is looted (needs no lock, no module) once the modules have their work.
//      Every wreck goes to a salvager, looted or not.
//   2. FREE TRACTORS: a tractor on a settled target is deactivated.
//   3. SALVAGERS: each idle salvager gets a DISTINCT locked salvageable wreck
//      within salvage range (already-locked first, then nearest).
//   4. TRACTORS: each idle tractor gets a DISTINCT tractorable item within
//      tractor range that is not yet where it is wanted (a lootable beyond loot
//      range, or a salvageable wreck beyond salvage range), nearest first. No
//      lock, no budget.
//   5. LOCKS, AHEAD: every salvageable wreck in salvage reach is locked, nearest
//      first, whether or not a salvager is free for it yet, so a salvager that
//      finishes has its next wreck already locked. `maxLockedTargets` counts
//      pending locks. At the cap, ONE lock on nothing in reach is released for
//      a wreck an idle salvager wants; if all are useful, wait.
//   5b. DOUBLING UP: a salvager still idle goes on the locked wreck with the
//      fewest salvagers on it, but only once no wreck in reach is waiting for a
//      lock: spreading over wrecks beats piling onto one.
//   6. POSITIONING (the user: "one needs to position ship just right"). Only
//      when NOTHING servable is in reach from here and no module is active,
//      pending, or being pulled in. The rule is the wiki's "most wrecks within
//      tractor range": candidate stations are every outstanding item (stood
//      off `standOffM` short) and the centroid of every item's neighbourhood;
//      each is scored by how many outstanding items it would put inside
//      (reach - reachMarginM); best count wins, nearest travel breaks ties,
//      lowest itemID the rest. Reach is tractor range for tractorable items
//      when tractors are fitted, else salvage range (salvage-only) or loot
//      range (lootable). HYSTERESIS: (a) it never moves while work is in
//      reach, so one cluster is exhausted before the next is chosen and two
//      equal clusters are taken in turn, never flipped between; (b) the chosen
//      station is COMMITTED (`committedAnchor`, echoed back) and the planner
//      waits en route rather than re-scoring from a moving position; (c) the
//      commitment drops only on arrival or when nothing is left in reach of it.
//      Deliberately no "relocate early for a denser spot" rule: a pull or a
//      salvage in progress is worth more, and an early-move rule is what
//      oscillates.
//
// ─── UNKNOWN MODULE TARGETS ──────────────────────────────────────────────────
//
// A cycling module's target may be unobserved (`targetID: null` while
// `active`). Such a module is BUSY. An unknown tractor claims the nearest
// unclaimed item visibly moving toward the ship (a pulled wreck's velocity
// points at us) so two tractors are not put on one wreck; it cannot be
// deactivated by the planner (its target is unknown). An unknown salvager
// claims nothing.
//
// Complexity: O(n^2) in the number of items (station scoring), n ~ 100.

export interface SalvageVec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A wreck on grid. */
export interface SalvageWreck {
  readonly itemID: number;
  readonly position: SalvageVec;
  /** Metres/second; omit when unobserved (a wreck nobody pulls is still). */
  readonly velocity?: SalvageVec;
  /** True when this wreck holds loot we are allowed (and want) to take. */
  readonly lootable: boolean;
  /** True once its loot has been taken (or it is known empty). */
  readonly looted: boolean;
  /** True when we hold loot rights, so a tractor may be put on it. Salvage-only wrecks: false. */
  readonly tractorable: boolean;
  /** True when set aside: never touched, never counted. */
  readonly setAside: boolean;
}

/** A loot container. It is looted (the lootWreck action), never salvaged. */
export interface SalvageCan {
  readonly itemID: number;
  readonly position: SalvageVec;
  readonly velocity?: SalvageVec;
  readonly lootable: boolean;
  readonly looted: boolean;
  /** Loot rights held (tractor allowed). */
  readonly tractorable: boolean;
  readonly setAside?: boolean;
}

/** One fitted tractor beam or salvager. `targetID` null while `active` means "target not observed". */
export interface SalvageModule {
  readonly moduleID: number;
  readonly active: boolean;
  readonly targetID: number | null;
}

export interface SalvagePlanInput {
  readonly ship: { readonly position: SalvageVec; readonly velocity: SalvageVec };
  readonly wrecks: readonly SalvageWreck[];
  readonly containers: readonly SalvageCan[];
  readonly tractors: readonly SalvageModule[];
  readonly salvagers: readonly SalvageModule[];
  /** Targets currently locked (finished locks only). */
  readonly lockedTargetIDs: readonly number[];
  /** Locks started but not finished; they hold budget but cannot be used yet. */
  readonly pendingLockIDs?: readonly number[];
  readonly maxLockedTargets: number;
  readonly lockRangeM: number;
  readonly tractorRangeM: number;
  readonly salvageRangeM: number;
  /** 2,500 in EVE. */
  readonly lootRangeM: number;
  /** Shaved off every range when choosing a station. Default 1,000. */
  readonly reachMarginM?: number;
  /** How far short of the chosen item the ship stops. Default 500. */
  readonly standOffM?: number;
  /** The station the planner last sent the ship to, echoed back by the coordinator; null/absent when none. */
  readonly committedAnchor?: SalvageVec | null;
  /**
   * Tractor beams whose target has not come any closer for a while (the coordinator watches the distance). Each is
   * switched off, to be taken again: a beam that runs and never pulls was seen live, and a fresh one pulled at once.
   */
  readonly stalledTractorIDs?: readonly number[];
  /** Within this of the committed station counts as arrived. Default 400. */
  readonly anchorArrivalM?: number;
}

export type SalvageAction =
  | { readonly kind: "lootWreck"; readonly wreckID: number; /** true when the id is a container (same lootWreck call, no claim) */ readonly isContainer: boolean }
  | { readonly kind: "lock"; readonly targetID: number }
  | { readonly kind: "unlock"; readonly targetID: number }
  | { readonly kind: "activate"; readonly moduleID: number; readonly targetID: number }
  | { readonly kind: "deactivate"; readonly moduleID: number }
  /** The coordinator wraps it with shipID and solarSystemID; `anchor` marks a committed station move. */
  | { readonly kind: "gotoPoint"; readonly position: SalvageVec; readonly anchor: true };

export type SalvagePlan =
  | { readonly action: SalvageAction; readonly why: string }
  | { readonly done: true; readonly why: string }
  | { readonly wait: true; readonly why: string };

const MOVING_SPEED_MPS = 5;

interface Item {
  readonly id: number;
  readonly isCan: boolean;
  readonly pos: SalvageVec;
  readonly needsLoot: boolean;
  /** A wreck a salvager may be given now (nothing of ours left to loot, a salvager is fitted). */
  readonly salvageNow: boolean;
  readonly tractorable: boolean;
  readonly d: number;
  readonly towardShip: boolean;
}

function dist(a: SalvageVec, b: SalvageVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** The point `by` metres from `from` along the line to `to` (clamped). */
function stepToward(from: SalvageVec, to: SalvageVec, by: number): SalvageVec {
  const d = dist(from, to);
  if (d <= 0 || by <= 0) return from;
  const t = Math.min(by, d) / d;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
}

export function planSalvageTick(input: SalvagePlanInput): SalvagePlan {
  const { ship } = input;
  const margin = input.reachMarginM ?? 1000;
  const standOff = input.standOffM ?? 500;
  const arrival = input.anchorArrivalM ?? 400;
  const shipSpeed = Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z);
  const haveSalvagers = input.salvagers.length > 0;
  const haveTractors = input.tractors.length > 0;

  // ── Items ──────────────────────────────────────────────────────────────────
  const towardShip = (pos: SalvageVec, vel: SalvageVec | undefined, d: number): boolean => {
    if (vel === undefined || d <= 0) return false;
    const speed = Math.hypot(vel.x, vel.y, vel.z);
    if (speed < MOVING_SPEED_MPS) return false;
    const dot = vel.x * (ship.position.x - pos.x) + vel.y * (ship.position.y - pos.y) + vel.z * (ship.position.z - pos.z);
    return dot / (speed * d) > 0.8;
  };
  const all: Item[] = [];
  const outstanding: Item[] = [];
  for (const w of input.wrecks) {
    const d = dist(ship.position, w.position);
    const needsLoot = !w.setAside && w.lootable && !w.looted;
    const it: Item = { id: w.itemID, isCan: false, pos: w.position, needsLoot, salvageNow: !w.setAside && haveSalvagers, tractorable: w.tractorable && !w.setAside, d, towardShip: towardShip(w.position, w.velocity, d) };
    all.push(it);
    // A wreck with nothing for us to loot and no salvager fitted is not work for this ship.
    if (!w.setAside && (needsLoot || haveSalvagers)) outstanding.push(it);
  }
  for (const c of input.containers) {
    const d = dist(ship.position, c.position);
    const needsLoot = c.setAside !== true && c.lootable && !c.looted;
    const it: Item = { id: c.itemID, isCan: true, pos: c.position, needsLoot, salvageNow: false, tractorable: c.tractorable && c.setAside !== true, d, towardShip: towardShip(c.position, c.velocity, d) };
    all.push(it);
    if (needsLoot) outstanding.push(it);
  }
  const byID = new Map<number, Item>(all.map((i) => [i.id, i]));

  // D. done
  if (outstanding.length === 0) {
    return { done: true, why: "No wreck is left to work and no lootable can is left to empty." };
  }

  // 1. What to loot, if a tick is left for it. ⚠ LOOTING COMES AFTER STARTING MODULES. It is one call and done,
  // while a tractor or a salvager left idle loses whole cycles: with the loot first, a fast tractor's wreck was in
  // range again every tick, so the same one beam pulled, the wreck was looted, the beam was let go and taken again,
  // and the other beams and every salvager waited for a tick that never came (seen live 2026-10-14). Modules are
  // started first; the loot goes in the ticks between.
  let lootNow: Item | null = null;
  for (const it of outstanding) {
    if (it.needsLoot && it.d <= input.lootRangeM && (lootNow === null || it.d < lootNow.d)) lootNow = it;
  }
  const lootIt = (it: Item): SalvagePlan => ({
    action: { kind: "lootWreck", wreckID: it.id, isContainer: it.isCan },
    why: `Looting ${it.isCan ? "a can" : "a wreck"} ${Math.round(it.d)} m away, inside the ${input.lootRangeM} m loot range.`,
  });

  // 2. a tractor whose target has settled is freed (it would otherwise cycle on it forever)
  const settled = (it: Item): boolean => (it.needsLoot ? it.d <= input.lootRangeM : it.d <= Math.max(input.lootRangeM, input.salvageRangeM - margin));
  for (const m of input.tractors) {
    if (!m.active || m.targetID === null) continue;
    const it = byID.get(m.targetID);
    if (it !== undefined && settled(it)) {
      return { action: { kind: "deactivate", moduleID: m.moduleID }, why: `Tractor target ${Math.round(it.d)} m away has arrived; freeing the beam for the next wreck.` };
    }
  }

  // 2b. a tractor whose pull has stalled is freed, to be taken again (or, once the coordinator gives the item up as
  // not tractorable, for another)
  const stalled = new Set(input.stalledTractorIDs ?? []);
  for (const m of input.tractors) {
    if (!m.active || !stalled.has(m.moduleID)) continue;
    return { action: { kind: "deactivate", moduleID: m.moduleID }, why: "A tractor beam has not brought its target any closer; switching it off to take it again." };
  }

  // ── Module bookkeeping ─────────────────────────────────────────────────────
  const claimedTract = new Set<number>();
  let unknownTractors = 0;
  for (const m of input.tractors) {
    if (!m.active) continue;
    if (m.targetID !== null) claimedTract.add(m.targetID);
    else unknownTractors++;
  }
  if (unknownTractors > 0) {
    const pulled = all.filter((i) => i.towardShip && !claimedTract.has(i.id)).sort((a, b) => a.d - b.d || a.id - b.id);
    for (let k = 0; k < unknownTractors && k < pulled.length; k++) claimedTract.add(pulled[k]!.id);
  }
  const claimedSalv = new Set<number>();
  for (const m of input.salvagers) if (m.active && m.targetID !== null) claimedSalv.add(m.targetID);
  const idleTractors = input.tractors.filter((m) => !m.active);
  const idleSalvagers = input.salvagers.filter((m) => !m.active);
  const anyActive = input.tractors.some((m) => m.active) || input.salvagers.some((m) => m.active);

  const locked = new Set(input.lockedTargetIDs);
  const pending = new Set((input.pendingLockIDs ?? []).filter((id) => !locked.has(id)));
  const order = (a: Item, b: Item): number => {
    const la = locked.has(a.id) ? 0 : 1;
    const lb = locked.has(b.id) ? 0 : 1;
    return la - lb || a.d - b.d || a.id - b.id;
  };
  const salvReach = Math.min(input.salvageRangeM, input.lockRangeM);

  const salvWants = outstanding
    .filter((i) => i.salvageNow && !i.isCan && i.d <= salvReach && !claimedSalv.has(i.id))
    .sort(order)
    .slice(0, idleSalvagers.length);
  const tractWants = outstanding
    .filter((i) => i.tractorable && !claimedTract.has(i.id) && i.d <= input.tractorRangeM && ((i.needsLoot && i.d > input.lootRangeM) || (i.salvageNow && i.d > input.salvageRangeM)))
    .sort((a, b) => a.d - b.d || a.id - b.id)
    .slice(0, idleTractors.length);

  // 3. salvagers on locked wrecks
  for (let k = 0; k < salvWants.length; k++) {
    const it = salvWants[k]!;
    if (locked.has(it.id)) {
      return { action: { kind: "activate", moduleID: idleSalvagers[k]!.moduleID, targetID: it.id }, why: `Salvager on a locked wreck ${Math.round(it.d)} m away.` };
    }
  }
  // 4. tractors: no lock needed
  for (let k = 0; k < tractWants.length; k++) {
    const it = tractWants[k]!;
    return { action: { kind: "activate", moduleID: idleTractors[k]!.moduleID, targetID: it.id }, why: `Tractor beam on ${it.isCan ? "a can" : "a wreck"} ${Math.round(it.d)} m away, to bring it in.` };
  }

  // 5. locks (salvagers only), AHEAD: every salvageable wreck in reach, not only the ones an idle salvager wants now.
  const inReach = outstanding
    .filter((i) => i.salvageNow && !i.isCan && i.d <= salvReach && !claimedSalv.has(i.id))
    .sort(order);
  const used = locked.size + pending.size;
  const lockAhead = inReach.filter((i) => !locked.has(i.id) && !pending.has(i.id));
  if (lockAhead.length > 0 && used < input.maxLockedTargets) {
    const target = lockAhead[0]!;
    return { action: { kind: "lock", targetID: target.id }, why: `Locking a wreck ${Math.round(target.d)} m away for the salvagers (${used + 1} of ${input.maxLockedTargets} locks).` };
  }
  const needLock = salvWants.filter((i) => !locked.has(i.id) && !pending.has(i.id));
  if (needLock.length > 0) {
    const keep = new Set<number>([...claimedSalv, ...inReach.map((i) => i.id)]);
    const spare = input.lockedTargetIDs.find((id) => !keep.has(id));
    if (spare !== undefined) {
      return { action: { kind: "unlock", targetID: spare }, why: "At the lock cap with a lock on nothing in reach; freeing it for a wanted wreck." };
    }
  }

  // 5b. Spare salvagers double up, once no wreck in reach is waiting for a lock (spreading beats piling onto one):
  // a salvager left idle goes on the locked wreck in reach with the FEWEST salvagers on it, nearest first, so five
  // salvagers on three wrecks run 2/2/1. Each salvager rolls its own chance a cycle, so a wreck worked twice goes
  // about twice as fast; when one succeeds the wreck is gone and the others on it stop by themselves
  // (salvagerRuntime).
  // (A lock on its way, that is. At the cap with more wrecks than locks, none is coming, and doubling is the best left.)
  const waitingForLock = inReach.some((i) => pending.has(i.id));
  const spareSalvagers = idleSalvagers.slice(salvWants.filter((i) => locked.has(i.id)).length);
  if (spareSalvagers.length > 0 && !waitingForLock) {
    const onWreck = new Map<number, number>();
    for (const m of input.salvagers) if (m.active && m.targetID !== null) onWreck.set(m.targetID, (onWreck.get(m.targetID) ?? 0) + 1);
    const doubled = outstanding
      .filter((i) => i.salvageNow && !i.isCan && i.d <= salvReach && locked.has(i.id))
      .sort((a, b) => (onWreck.get(a.id) ?? 0) - (onWreck.get(b.id) ?? 0) || a.d - b.d || a.id - b.id)[0];
    if (doubled !== undefined) {
      const already = onWreck.get(doubled.id) ?? 0;
      return { action: { kind: "activate", moduleID: spareSalvagers[0]!.moduleID, targetID: doubled.id },
        why: `A spare salvager onto a wreck ${Math.round(doubled.d)} m away (${already + 1} on it now).` };
    }
  }
  if (needLock.length > 0 && lootNow === null) {
    return { wait: true, why: `Every one of the ${input.maxLockedTargets} locks is in use or wanted; waiting for a salvager to finish.` };
  }

  if (lootNow !== null) return lootIt(lootNow);

  // 6. in reach or in progress means wait, never move
  const reachOf = (it: Item): number => (haveTractors && it.tractorable ? input.tractorRangeM : it.needsLoot ? input.lootRangeM : salvReach);
  const servableHere = outstanding.some((i) => i.d <= reachOf(i));
  const pulling = all.some((i) => i.towardShip);
  if (anyActive || pending.size > 0 || pulling) {
    return { wait: true, why: "Modules are working or a pull is in progress; holding position so no cycle loses range." };
  }
  if (servableHere) {
    return { wait: true, why: "Work is in reach but every module and lock is already spoken for; waiting." };
  }

  // Nothing in reach, nothing running: choose (or keep) a station.
  const eff = (it: Item): number => Math.max(reachOf(it) - margin, reachOf(it) * 0.5);
  const score = (p: SalvageVec): number => {
    let n = 0;
    for (const it of outstanding) if (dist(p, it.pos) <= eff(it)) n++;
    return n;
  };
  const committed = input.committedAnchor ?? null;
  if (committed !== null && dist(ship.position, committed) > arrival && score(committed) > 0 && shipSpeed >= MOVING_SPEED_MPS) {
    return { wait: true, why: "Flying to the chosen station; it is kept until reached." };
  }
  // (stopped short of an unreached station: re-plan; the coordinator watches for repeats)

  const candidates: { p: SalvageVec; id: number }[] = [];
  for (const it of outstanding) {
    candidates.push({ p: stepToward(it.pos, ship.position, standOff), id: it.id });
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const o of outstanding) {
      if (dist(it.pos, o.pos) <= eff(o)) {
        sx += o.pos.x; sy += o.pos.y; sz += o.pos.z; n++;
      }
    }
    if (n > 1) candidates.push({ p: { x: sx / n, y: sy / n, z: sz / n }, id: it.id });
  }
  let best: { p: SalvageVec; id: number; score: number; travel: number } | null = null;
  for (const c of candidates) {
    const travel = dist(ship.position, c.p);
    if (travel <= arrival) continue; // standing there already put nothing in reach
    const s = score(c.p);
    if (best === null || s > best.score || (s === best.score && (travel < best.travel || (travel === best.travel && c.id < best.id)))) {
      best = { p: c.p, id: c.id, score: s, travel };
    }
  }
  if (best === null || best.score === 0) {
    return { wait: true, why: "Work remains but no station would put any of it in reach." };
  }
  return {
    action: { kind: "gotoPoint", position: best.p, anchor: true },
    why: `Nothing in reach; moving ${Math.round(best.travel)} m to the station that puts ${best.score} of ${outstanding.length} outstanding items within range.`,
  };
}
