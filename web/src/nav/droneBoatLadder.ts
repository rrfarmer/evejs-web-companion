// Fight with drones — the decision core of the drone-boat combat block
// (docs/drone-boat-block-spec.md §§1-7, §12, §13).
//
// `fight-the-rats` is a GUN ladder that also happens to send drones. Three of
// its assumptions are wrong for a drone boat and none of them can be changed in
// place without breaking the gunship it was written for:
//
//   • IT NEVER MOVES THE SHIP. There is no approach, orbit or keep-at-range
//     anywhere in it, and a drone boat's whole tactic is RANGE. A block that
//     cannot express range cannot fly one.
//   • "DONE WHEN THE GRID IS CLEAR" MEANS "CLEAR INSIDE LOCK RANGE", so a wave
//     landing at 50 km reads as an empty grid: the block finishes and the bot
//     starts looting with rats inbound. That filter is load-bearing — it is what
//     stops a lock-retry spin on a rat parked 300 km out — so the answer is a
//     rung that CLOSES, not a removed filter. See the finishing section below.
//   • ITS TARGET LADDER IS INERT AGAINST RATS. `tackle`/`ewar`/`logi` match
//     PLAYER hull group names; every NPC is an "Asteroid Serpentis Frigate" and
//     falls through to `other`, so the real order is nearest-first wearing a
//     priority list. `nav/ratThreat.ts` + `pickPrimary`'s dogma reader is the
//     other half of that answer and this block passes both.
//
// ─── THIS FILE COMPOSES, IT DOES NOT DECIDE ──────────────────────────────────
//
// Every hard question already has a module that owns it, and each of them is
// pure, tested and committed. Nothing here re-derives any of their arithmetic:
//
//   nav/kiteBand.ts      the stand-off band (floor, ceiling, the empty band)
//   nav/ratThreat.ts     what a rat TYPE does, read from its own dogma
//   nav/targetPriority.ts which hostile to shoot first, live jams included
//   nav/propulsion.ts    when a prop mod goes on and — harder — when it comes off
//   nav/droneRotation.ts pulling a drone that has started losing shield
//   nav/siteProgress.ts  the give-up ledger: effort without progress
//
// What is left for this file is the LADDER: one action per tick, first rung with
// something to do wins, and every rung written so it has something to do only
// while the world disagrees with what is wanted — the `decidePropulsionModule`
// idiom, "issues one call and then falls through".
//
// ⚠ A RUNG THAT RETURNS AN ACTION EVERY TICK STARVES EVERY RUNG BELOW IT. That
// is not a style note, it is the failure mode of the whole design: a block that
// re-issues its keep-at-range every tick because the band wobbled 200 m is a
// block that never fires a gun, and from the outside it looks like a bot that
// has decided to fly in circles. `shouldReissueHold`, `dronesOn`, `lockIssued`,
// `preLocked` and the propulsion policy's own "the rack already agrees" answer
// are each one half of that guarantee, and none of them is optional.
//
// ─── TRI-STATE, AND THE NULL ALWAYS WINS ─────────────────────────────────────
//
// Unreadable is `null`, and a null never decides. Where the spec and a null
// disagree the null wins and the block does the SAFE thing — which for this
// block means, over and over: do not shoot, do not burn, do not pre-lock, do not
// count the tick as damage going in. Every one of those refusals costs the
// player a few seconds. Every one of the opposite guesses costs them a hull, an
// anomaly, or a diagnosis they will never make.
//
// This module is PURE. No store, no bridge, no loop, no clock, no randomness —
// an observation and a memory record in, one `MacroTick` out. The adapter that
// registers it as a macro lives in `nav/scriptMacros.ts` and is a few lines.

import type { SquadRoleArg } from "../bots/botScript.ts";
import { hostileRows, type OverviewRow } from "../space/overview.ts";
import type { SpaceSnapshot, SpaceVector } from "../store/types.ts";
import {
  kiteBand,
  resolveDroneLeash,
  shouldReissueHold,
  THREAT_BUFFER_M,
  type BandThreat,
  type KiteBand,
} from "./kiteBand.ts";
import {
  droneRoster,
  launchRoleDrones,
  launchStalled,
  type DroneRoster,
} from "./droneLaunch.ts";
import {
  clearCloseInStall,
  closeInStall,
  hullMode,
  STALL_REORDER_WHY,
  STALL_UNSTICK_WHY,
} from "./closeInStall.ts";
import { decidePropulsionModule } from "./propulsion.ts";
import type { RatThreat } from "./ratThreat.ts";
import {
  decideDroneRotation,
  readRotationMemory,
  type DroneRotationStep,
} from "./droneRotation.ts";
import type { MacroMemory, MacroTick, ScriptAction, ScriptBoard } from "./scriptDecide.ts";
import type { ScriptObservation } from "./scriptConditions.ts";
import {
  decodeLedger,
  describeVerdict,
  encodeLedger,
  forgetSite,
  observeTick,
  type SiteLedger,
  type SiteVerdict,
} from "./siteProgress.ts";
import { DEFAULT_TARGET_PRIORITY, pickPrimary, type TargetClass } from "./targetPriority.ts";
import { combatReload, weaponUseful } from "./combatWeapons.ts";
import { combatOwnership, ownCombatAction, settleCombat } from "./combatOwnership.ts";
import { combatCapSustain, decideCombatUtilities } from "./combatUtilities.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Is this rat one the band would anchor on at all — something that can hold the
 * ship or slow it?
 *
 * ⚠ IT MUST AGREE WITH `bandThreats`, because the sticky anchor uses it to
 * decide whether the rat it is holding station off STILL counts. Two different
 * answers to "is that a threat" would let the anchor be kept on a rat the band
 * itself no longer considers one, which is a ship holding range off a hauler.
 */
function isBandThreat(dogma: RatThreat | null): boolean {
  return dogma !== null && (dogma.scram || dogma.web);
}

/**
 * How long to wait for ONE lock before giving up on that target and re-picking.
 *
 * Eight ticks, ~16 s — the same bound `fight-the-rats` uses, and the same number
 * on purpose: a target that will not lock is the same problem in both blocks and
 * two different answers to it would only ever mean one of them is wrong.
 */
const MAX_LOCK_WAIT_TICKS = 8;

/**
 * How long the block may spend CLOSING on a wave that landed outside lock range
 * before it writes the site off and leaves.
 *
 * ⚠ THIS BUDGET IS THE ONLY THING BETWEEN THE FIX AND A NEW BUG. Approaching an
 * out-of-reach grid is what stops the block finishing on a wave inbound at 50 km
 * — but a rat that is FLEEING at 400 m/s will happily tow a 315 m/s Tristan
 * across the system for as long as the block is willing to chase it, and a bot
 * that leaves the grid it was sent to is worse than a bot that finished early.
 *
 * 60 ticks is about two minutes at the 2 s cadence. A frigate closing at its
 * base speed covers roughly 38 km in that time, which catches the wave the wave
 * fix exists for (a spawn landing at 30-50 km) with room to spare, and a chase
 * that has not closed in two minutes is a chase, not an approach.
 */
const MAX_CLOSE_TICKS = 60;

/**
 * Consecutive empty grid reads before "there is nothing here" is believed.
 *
 * ⚠ THREE, AND THE TICK IT EXISTS FOR IS THE ONE JUST AFTER A WARP LANDS — the
 * grid has not populated, the read succeeds, and it LIES. Same shape as the
 * scanner's own empty-state lie and answered with the same three reads
 * (`EMPTY_SCAN_CONFIRM_READS`, scriptMacros.ts). Six seconds at the end of a
 * finished fight against losing the entire site.
 */
export const EMPTY_GRID_CONFIRM_TICKS = 3;

/**
 * How big the gap between where the ship IS and where it wants to be has to get
 * before lighting a prop mod is worth the signature.
 *
 * §5's number, and the reasoning is the signature bloom: a microwarpdrive
 * multiplies signature radius, and on a Tristan (sig 600) that turns the hull
 * into a much easier target for exactly the rat guns it is trying to outrange.
 * So the burner is for CLOSING A GAP and nothing else — five kilometres of gap
 * is worth a few seconds of being easy to hit; two hundred metres of drift is
 * not.
 */
const PROP_GAP_M = 5000;

/**
 * The capacitor floor below which a prop mod is not LIT (it may always be
 * stopped — see `decidePropulsionModule`, which is emphatic about the
 * asymmetry).
 *
 * An MWD eats roughly ninety per cent of a frigate's capacitor per cycle, so a
 * boat that lights one at a fifth of its cap is a boat that caps itself out and
 * then cannot warp. 0.3 leaves enough in the bank for the align-and-go a watch
 * is about to ask for. A constant rather than an arg: §13's argument applies
 * here too — a player asked to tune this is being asked to guess at a number
 * whose right value is "enough to leave on".
 */
const PROP_CAP_FLOOR = 0.3;

/**
 * How many ids the pre-lock rung remembers having already asked for.
 *
 * ⚠ THE CAP IS WHAT MAKES THE RUNG BOUNDED. Pre-locking has no bounded wait of
 * its own (see the rung), so "we have already asked for this one" is the entire
 * stop condition, and an unbounded list in step memory is a leak on a grid that
 * keeps spawning. Sixteen is comfortably more than any hull's lock count and
 * small enough that the record stays a handful of numbers.
 */
const MAX_PRELOCK_MEMORY = 16;

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface DroneBoatInputs {
  readonly obs: ScriptObservation;
  readonly mem: MacroMemory;
  readonly board: ScriptBoard;
  /** The player's ordered class list, or the shipped default. */
  readonly targets: readonly TargetClass[];
  /** The player's hold override in METRES, null when unset. */
  readonly holdRangeM: number | null;
  readonly propMode: "auto" | "off";
  readonly squad: SquadRoleArg;
  /**
   * The ship the FLEET has called, when this block is set to follow one.
   *
   * ⚠ RESOLVED BY THE ADAPTER, NOT HERE, AND THAT IS DELIBERATE. Which ship the
   * fleet called is a three-source question — the in-game target tags first
   * (provably a commander's, because the server refuses the write to anybody
   * else), then a `Target` broadcast, then the shared squad board — and
   * `scriptMacros.ts` already owns that precedence in `calledOnGrid`, along with
   * the rule that a source naming a ship this pilot cannot shoot falls through
   * to the NEXT source rather than to null. Re-deriving it here would be a
   * second copy of a precedence that has already been argued out once, and the
   * two would drift the first time somebody added a fourth source.
   *
   * So the adapter passes `calledOnGrid(obs, rows, ...)?.itemID ?? null` and
   * this block only obeys. Absent or null means "nobody called", which is what
   * every `squad: "off"` caller passes and what a follower with a silent fleet
   * gets — and a follower with a silent fleet picks for itself, which is a
   * working bot rather than a stopped one.
   */
  readonly calledTargetID?: number | null;
}

// ─── Tick plumbing (the shape every block in this tree returns) ──────────────

const WAIT: ScriptAction = { kind: "wait" };
const ACTING: MacroTick["outcome"] = { kind: "acting" };
const PHASE_FIGHT = "Fighting";
const PHASE_CLOSE = "Closing";

function tick(
  action: MacroTick["action"],
  why: string,
  phase: string,
  outcome: MacroTick["outcome"],
  armed = true,
  nextMem: MacroMemory = {},
): MacroTick {
  return { action, why, phase, armed, outcome, nextMem };
}

function num(mem: MacroMemory, key: string): number | null {
  const value = mem[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flag(mem: MacroMemory, key: string): boolean {
  return mem[key] === true;
}

/** A list of ids out of untyped step memory, defensively — anything else is []. */
function idList(mem: MacroMemory, key: string): readonly number[] {
  const value = mem[key];
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is number => typeof id === "number" && Number.isFinite(id));
}

/** Metres for a readout, in the units a player thinks in. Plain ASCII. */
function km(metres: number): string {
  return `${Math.round(metres / 100) / 10} km`;
}

// ─── Drones by role ──────────────────────────────────────────────────────────
//
// `nav/droneLaunch.ts` owns the roster and the launch for every block that puts
// drones out, this one and the gun ladders in `nav/scriptMacros.ts` alike. This
// file used to carry its own copy of both, because `scriptMacros.ts` imports
// `decideDroneBoat` from here and so cannot be imported back; the leaf is what
// broke that cycle. `roster.roleRows` is the half this block alone reads — the
// rotation machine's per-drone rows, three-state, and a null there means NOBODY
// LOOKED rather than no drones are out.

// ─── The grid, and what each rat on it does ──────────────────────────────────

/** The rat's own dogma for a type, or null when nobody has read it. */
function threatReader(obs: ScriptObservation): (typeID: number) => RatThreat | null {
  const map = obs.threatByTypeID ?? null;
  return (typeID) => (map === null ? null : (map[typeID] ?? null));
}

/** The game's own group name for a type, for the PLAYER half of the classifier. */
function groupReader(obs: ScriptObservation): (typeID: number) => string | null {
  const groups = obs.targetGroupNames ?? null;
  return (typeID) => (groups === null ? null : (groups[typeID] ?? null));
}

/**
 * The ids the server says are holding THIS ship right now, or `undefined` when
 * no jam fold was read.
 *
 * ⚠ THE UNDEFINED MATTERS. `pickPrimary` takes the promotion set as an optional
 * argument and skips the whole comparison when it is absent; handing it an empty
 * Set instead would be the claim "we looked and nothing is on us", which is a
 * different and stronger statement than "nobody looked". An empty ARRAY on the
 * observation is the first of those and is passed through as an empty Set.
 */
function jamSources(obs: ScriptObservation): ReadonlySet<number> | undefined {
  const ids = obs.jammingSourceIDs;
  return ids === undefined ? undefined : new Set(ids);
}

/**
 * The grid as the stand-off band reads it: every hostile ON GRID, crossed with
 * what its type's dogma says it does.
 *
 * ⚠ ON GRID, NOT IN REACH. The floor answers "how far out does the thing that
 * can hold me reach?", and a scrammer that is on the grid but currently outside
 * this hull's lock range will still be inside its own scram range in twenty
 * seconds. Computing the band off the in-reach rows would let the floor rise
 * under the ship exactly when it was too late to act on it.
 *
 * A type missing from the map contributes nothing rather than a guess: no scram
 * range, no web. That is `UNKNOWN_THREAT`'s own rule — "the dogma said nothing,
 * ask something else" — and it is the safe direction only because the band's
 * other half (the leash) is computed from the fit and not from the grid.
 */
function bandThreats(rows: readonly OverviewRow[], threat: (typeID: number) => RatThreat | null): readonly BandThreat[] {
  return rows.map((row) => {
    const dogma = row.typeID === null ? null : threat(row.typeID);
    return {
      itemID: row.itemID,
      distanceM: row.distance,
      // Only a rat that ACTUALLY scrams carries a reach. `threatFromAttributes`
      // already reports `scramRangeM: null` for a type whose chance is 0 (the
      // `Pithum Silencer` case, which carries the range and never uses it), so
      // the `scram` test here is belt and braces rather than a second opinion.
      scramRangeM: dogma !== null && dogma.scram ? dogma.scramRangeM : null,
      webs: dogma?.web === true,
    };
  });
}

/**
 * The band, in one sentence the player can act on. §2 insists on this.
 *
 * `issuedHoldM` is the range the block is ACTUALLY asking for, which is not
 * always `band.holdM`: when the band's answer sits inside the scram and the ship
 * is already further out than that, the hold rung pins the ship where it is
 * instead (see `holdInsideTheScram` below). A readout that reported the band's
 * number there would describe a manoeuvre the block deliberately did not make —
 * and "brawling at 17 km" while sitting at 25.5 km is exactly the sentence that
 * made the live loss look like correct behaviour in the log.
 *
 * ⚠ THE GUESSED-LEASH HALF OF THE SENTENCE IS THE PLAYER'S ONLY WAY OUT. When
 * the ceiling is the 20 km no-skills guess (`reason: "fallback"`), the block has
 * no route to a better number: control range is skill-derived and nothing on the
 * wire carries it. The fix is the hold override, and the player cannot reach for
 * it if the readout never says the leash was invented. Plain ASCII, because this
 * is a player-facing string.
 */
function bandWhy(band: KiteBand, issuedHoldM: number): string {
  // The general form, not `band.empty` — see the hold rung's own warning. An
  // override is excluded here for the same reason it is excluded there: a player
  // who typed a brawling range is not being told their own number is a mistake.
  if (band.holdM < band.floorM && band.reason !== "override") {
    const scramM = Math.max(0, band.floorM - THREAT_BUFFER_M);
    const room =
      `There is no room to kite here: my drones reach about ${km(band.ceilingM)} and the worst thing on grid` +
      ` scrams at ${km(scramM)}.`;
    const where =
      issuedHoldM > band.holdM
        ? ` I am already ${km(issuedHoldM)} out, so I am staying here and fighting what I can reach rather than` +
          ` burning into that scram.`
        : ` So I am fighting at ${km(issuedHoldM)} instead.`;
    const fix =
      band.reason === "fallback"
        ? ` I could not read your drone control range, so that ${km(band.ceilingM)} is only the no-skills guess:` +
          ` set the hold range and I will use your number instead.`
        : "";
    return room + where + fix;
  }
  switch (band.reason) {
    case "fallback":
      return (
        `I could not read your drone control range, so I assumed the no-skills 20 km and am holding at` +
        ` ${km(band.holdM)}. Set the hold range if that is wrong.`
      );
    case "override":
      return `Holding at the ${km(band.holdM)} you asked for.`;
    case "no-tackle":
      return `Nothing here can point me, so I am sitting at the far end of my leash, ${km(band.holdM)}.`;
    case "no-threat":
      return `Nothing on grid to stand off from — holding at ${km(band.holdM)}.`;
    case "ceiling":
      return `Holding at ${km(band.holdM)} — that is as far out as my leash goes.`;
    default:
      return `Holding at ${km(band.holdM)}, just outside what can hold me here.`;
  }
}

// ─── The ledger (§13) ────────────────────────────────────────────────────────

/** The board patch for a ledger that moved, or null when nothing changed. */
function ledgerPatch(before: SiteLedger, after: SiteLedger): ScriptBoard | null {
  const next = encodeLedger(after);
  const prev = encodeLedger(before);
  for (const key of Object.keys(next)) {
    if (prev[key] !== next[key]) return next;
  }
  return null;
}

/**
 * ⚠ IS THIS BLOCK ACTUALLY APPLYING DAMAGE RIGHT NOW? — the one input
 * `nav/siteProgress.ts` refuses to compute for itself, and the single thing here
 * most likely to be got wrong.
 *
 * The dangerous version of the give-up feature blames the SITE for faults at OUR
 * end: drones sitting in the bay, drones ordered on nothing, a lock that never
 * landed, a rat parked outside the drone leash, guns chattering with an empty
 * charge bay, a kite flown at a distance the drones cannot work in. Every one of
 * those reads as "nothing is dying" and NOT ONE of them means the den is
 * unwinnable — the honest answer to each is to fix the position or the fit. A
 * stall counter that ticked through them would throw away good anomalies AND
 * hide the real bug behind a plausible verdict, because a pilot told "this den
 * is too hard" never goes looking for the drones that were 40 km out doing
 * nothing.
 *
 * So every clause below is something this block can positively SEE, and all of
 * them must hold:
 *
 *   1. There is a primary we have been holding (`targetID` in step memory) and
 *      it is still on the REACHABLE grid. A target that died or drifted out of
 *      lock range leaves here.
 *   2. This block's own COMBAT drones are out — `roleOut`, not `out`: a flight
 *      of salvage drones is not damage.
 *   3. They were ordered onto THIS primary (`dronesOn`), not onto the last one.
 *      The tick that ISSUES the engage therefore does not count — it has ordered
 *      damage, not applied any — because `dronesOn` is written into the NEXT
 *      tick's memory and this evidence is read off the memory as it arrived.
 *   4. The primary is LOCKED. Waiting on a lock is our problem, not the site's,
 *      and §13 names it explicitly.
 *   5. The primary is inside the DRONE leash — a different and usually shorter
 *      leash than the lock range in clause 1.
 *
 * ⚠ THIS BLOCK CAN BE PRECISE WHERE `fight-the-rats` CANNOT, AND IT STILL
 * GUESSES LOW. Unlike the gun ladder, this one knows its own hold range and its
 * own control range — but an unreadable control range still falls back to the
 * 20 km no-skills base and never to infinity, for the reason `kiteBand` gives:
 * control range is skill-derived, rides a fitting read a bot run does not force,
 * and so null is the COMMON case. An assumed-short leash only ever refuses to
 * count ticks, so the stall fires late or not at all, which costs the player
 * minutes. Guessing high costs them the anomaly AND the diagnosis. When in
 * doubt, false.
 *
 * ⚠ GUNS ARE DELIBERATELY NOT A CLAUSE. This block cannot see a turret's
 * optimal, its falloff, its tracking, or whether the shot landed, so the only
 * honest thing it could say about a gun is "I pressed the button" — and a site
 * abandoned on the strength of a pressed button is exactly the verdict §13
 * forbids. A gun boat flying this block accrues no stall, which is the
 * conservative half of being wrong.
 */
function boatEvidence(
  obs: ScriptObservation,
  mem: MacroMemory,
  inReach: readonly OverviewRow[],
  onGrid: readonly OverviewRow[],
  roster: DroneRoster,
  leashM: number,
  siteLabel: string | null,
) {
  const held = num(mem, "targetID");
  const primary = held === null ? undefined : inReach.find((row) => row.itemID === held);
  const applying =
    held !== null &&
    primary !== undefined &&
    roster.roleOut.length > 0 &&
    num(mem, "dronesOn") === held &&
    (obs.lockedTargetIDs ?? []).includes(held) &&
    primary.distance <= leashM;
  return {
    applying,
    // The health rows are facts about the RAT and are handed over whether or not
    // we are applying: the ledger keeps the lowest reading ever seen, and a
    // reading taken while the drones were flying home is still a reading.
    primaryID: primary?.itemID ?? null,
    primaryShieldRatio: primary?.shieldRatio ?? null,
    primaryArmorRatio: primary?.armorRatio ?? null,
    primaryHullRatio: primary?.hullRatio ?? null,
    // ⚠ THE ON-GRID COUNT, NOT THE IN-REACH ONE, AND THIS BLOCK DIFFERS FROM
    // `fight-the-rats` HERE ON PURPOSE. That block finishes on an empty in-reach
    // grid, so the in-reach count is the count it acts on. This one CLOSES on an
    // out-of-reach wave instead, so an in-reach count would read a wave landing
    // at 50 km as an empty grid — the very bug the closing rung exists to fix,
    // reintroduced in the ledger where nobody would look for it.
    hostileCount: onGrid.length,
    siteLabel,
  };
}

// ─── The fleet's call ────────────────────────────────────────────────────────
//
// Two small halves of the same rule, reproduced from `fight-the-rats`: a call
// costs the tick's one action, so it is sent only when the primary CHANGES, and
// it is stood DOWN before the block leaves. A call outlives the ship it named
// for as long as its ttl, and a follower obeying a stale one is a follower
// holding its guns on a wreck.

function callPrimary(
  role: SquadRoleArg,
  mem: MacroMemory,
  targetID: number,
  why: string,
  phase: string,
): MacroTick | null {
  if (role !== "call" || num(mem, "calledTargetID") === targetID) return null;
  return tick({ kind: "callPrimary", targetID }, why, phase, ACTING, true, {
    ...mem,
    calledTargetID: targetID,
  });
}

function standCallDown(role: SquadRoleArg, mem: MacroMemory, why: string, phase: string): MacroTick | null {
  if (role !== "call" || num(mem, "calledTargetID") === null) return null;
  return tick({ kind: "callPrimary", targetID: null }, why, phase, ACTING, true, {
    ...mem,
    calledTargetID: null,
  });
}

/**
 * Leave this grid: stand the call down, call the drones home, then `done`.
 *
 * ⚠ NEVER LEAVE DRONES IN SPACE, whatever the reason for leaving — a cleared
 * grid, a spent chase budget, or a site the ledger has given up on. Abandoned
 * drones answer a recall with a 200 and do not move, so a flight left behind is
 * a flight lost, and §13 is explicit that giving up on a site must never do it.
 */
function leaveGrid(
  role: SquadRoleArg,
  mem: MacroMemory,
  roster: DroneRoster,
  sentence: string,
  phase: string,
): MacroTick {
  return tick(WAIT, sentence, phase, ACTING, false, { ...mem, combatSettling: true, combatFinishWhy: sentence });
}

/**
 * How many targets this hull can hold at once, or null when nothing said.
 *
 * ⚠ READ OFF THE OBSERVATION DEFENSIVELY BECAUSE THE FIELD IS NOT PLUMBED YET.
 * `maxLockedTargets` is dogma attribute 192 and `bridge/shipStats.ts` already
 * reads it, but it does not reach `ScriptObservation` — so today this always
 * answers null and the pre-lock rung never fires. That is the correct behaviour
 * for an unreadable count and not a placeholder: §7's tri-state rule is that
 * unreadable means DO NOT, and a pre-lock rung that guessed "five, everything
 * holds five" would spend a lock slot a Tristan has and a destroyer does not,
 * every tick, on a hull nobody had measured. When the field is plumbed this
 * function starts returning a number and the rung starts working, with no other
 * change.
 */
function maxLocksOf(obs: ScriptObservation): number | null {
  const raw = (obs as { readonly maxLockedTargets?: unknown }).maxLockedTargets;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : null;
}

// ─── The ladder ──────────────────────────────────────────────────────────────

/**
 * One tick of the drone boat.
 *
 * The rungs, in order, each with the one thing it is allowed to do:
 *
 *   0. GUARDS — docked, in warp, not in space.
 *   -. FINISHING — an empty grid, a site given up on, or a wave out of reach
 *      that has to be CLOSED rather than finished on.
 *   1. DRONES OUT (combat role only).
 *   2. HOLD THE RANGE — the stand-off band, past the hysteresis.
 *   3. PROPULSION — on to close a gap, off the moment the gap is closed.
 *   4. PRIMARY — pick by dogma and live jam, lock it, bounded wait.
 *   5. DRONES ONTO THE PRIMARY, once per target.
 *   6. ROTATE A HURT DRONE — below the engage rung, never at the cost of the
 *      primary being unattended.
 *   7. PRE-LOCK the next targets, so the next primary is already locked.
 *   8. GUNS — every idle gun that is actually loaded.
 *
 * ⚠ THE ORDER IS THE DESIGN. Rung 6 above rung 5 would pull a drone off a
 * primary nobody else is shooting; rung 2 below rung 4 would fight from a
 * distance the drones cannot work in and then blame the site for it; rung 8
 * above rung 5 would spend the opening seconds of every fight on guns while the
 * drones sat idle. None of these is a preference.
 */
export function decideDroneBoat(inputs: DroneBoatInputs): MacroTick {
  const owned = combatOwnership(inputs.mem, inputs.obs);
  const memory: MacroMemory = { ...inputs.mem, combatOwned: owned };
  if (memory.combatSettling === true) return settleCombat(inputs.obs, memory);
  const active = inputs.obs.snapshot?.ship?.activeModuleIDs;
  const obs = { ...inputs.obs, propulsionModules: inputs.obs.propulsionModules?.filter(module =>
    !active?.includes(module.itemID) || owned.modules[module.itemID] !== undefined) };
  const result = decideDroneBoatCore({ ...inputs, obs, mem: memory });
  const merged: MacroMemory = { ...result.nextMem, reloadAttempts: result.nextMem.reloadAttempts ?? memory.reloadAttempts,
    combatOwned: ownCombatAction(owned, result.action, inputs.obs) };
  return merged.combatSettling === true ? { ...settleCombat(inputs.obs, merged), boardPatch: result.boardPatch } : { ...result, nextMem: merged };
}

function decideDroneBoatCore(inputs: DroneBoatInputs): MacroTick {
  const { obs, board, targets, holdRangeM, propMode, squad } = inputs;
  const mem = inputs.mem;

  // ─── Rung 0: guards ───────────────────────────────────────────────────────
  if (obs.docked === true) {
    return tick(WAIT, "Docked.", PHASE_FIGHT, {
      kind: "blocked",
      reason: "Undock first — this block fights on a grid.",
    }, false, mem);
  }
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp — nothing decided mid-warp.", PHASE_FIGHT, ACTING, false, mem);
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", PHASE_FIGHT, ACTING, false, mem);
  }

  // ─── The grid, read once ──────────────────────────────────────────────────
  const origin: SpaceVector = snapshot.ship?.position ?? { x: 0, y: 0, z: 0 };
  const onGrid = hostileRows(snapshot, origin);
  const lockRangeM = obs.maxTargetRangeM ?? null;
  // ⚠ THE IN-REACH FILTER STAYS, AND IT IS NOT THE BUG. Without it one rat
  // parked 300 km out is still "the nearest hostile", so the ladder locks it,
  // waits out `MAX_LOCK_WAIT_TICKS`, gives up, picks the same rat again, for
  // ever. The bug was FINISHING on an empty in-reach grid; the fix is the
  // closing rung below, not a removed filter.
  const inReach = lockRangeM === null ? onGrid : onGrid.filter((row) => row.distance <= lockRangeM);
  const roster = droneRoster(obs, "combat");
  const threat = threatReader(obs);
  const leashM = resolveDroneLeash(obs.droneControlRangeM ?? null, holdRangeM).leashM;

  // ─── §13: is this site worth another minute? ──────────────────────────────
  //
  // The verdict is computed BEFORE the ladder runs and from the state the ladder
  // is standing in at the top of the tick (the primary the LAST tick's orders
  // were aimed at), so every rung below is judged by what it actually achieved
  // rather than by what it is about to order.
  //
  // WHICH SITE THIS IS comes off the board and is never guessed here:
  // `warp-to-anomaly` publishes the label on the tick it commits to a site,
  // being the only block that KNOWS an arrival happened. A fight that is not at
  // a scanned site at all — a belt spawn, a gate camp — has a null label, which
  // `siteProgress.ts` already handles: the stall counter still runs, there is
  // simply no per-site count to keep.
  const ledger = decodeLedger(board);
  const verdict: SiteVerdict = observeTick(
    ledger,
    boatEvidence(obs, mem, inReach, onGrid, roster, leashM, ledger.siteLabel),
  );

  // ⚠ A CLEARED GRID IS A SUCCESS AND WIPES THIS LABEL'S TALLY. An empty grid is
  // the strongest evidence obtainable that the den was winnable after all, so it
  // outranks anything the ledger was about to say — including a stall whose
  // budget ran out on this very tick. And it is the TRUE grid here, not the
  // in-reach one: this block does not finish on a wave it can still see.
  const after = onGrid.length === 0 ? forgetSite(verdict.ledger, verdict.ledger.siteLabel) : verdict.ledger;
  const patch = ledgerPatch(ledger, after);
  const decided = droneBoatLadder({
    obs,
    mem,
    snapshot,
    onGrid,
    inReach,
    roster,
    threat,
    targets,
    holdRangeM,
    propMode,
    squad,
    calledTargetID: inputs.calledTargetID ?? null,
    verdict,
  });
  return patch === null ? decided : { ...decided, boardPatch: patch };
}

type LadderInputs = {
  readonly obs: ScriptObservation;
  readonly mem: MacroMemory;
  readonly snapshot: SpaceSnapshot;
  readonly onGrid: readonly OverviewRow[];
  readonly inReach: readonly OverviewRow[];
  readonly roster: DroneRoster;
  readonly threat: (typeID: number) => RatThreat | null;
  readonly targets: readonly TargetClass[];
  readonly holdRangeM: number | null;
  readonly propMode: "auto" | "off";
  readonly squad: SquadRoleArg;
  readonly calledTargetID: number | null;
  readonly verdict: SiteVerdict;
};

/**
 * The ladder itself, split out only so the caller can wrap whatever it decides
 * in the ledger's board patch without every rung having to know the ledger
 * exists.
 */
function droneBoatLadder(input: LadderInputs): MacroTick {
  const { obs, snapshot, onGrid, inReach, roster, threat, squad, verdict } = input;
  let mem = input.mem;
  const role = squad;

  // ─── FINISHING, PART ONE: the grid really is empty ────────────────────────
  //
  // ⚠ AN EMPTY GRID IS READ THREE TIMES BEFORE IT IS BELIEVED, and the tick this
  // protects is the one right after a warp lands. Caught live on 2026-09-14: the
  // block arrived in a den, read a grid that had not populated yet, declared it
  // clear, and the loop warped straight on to the next site — three dens in a row
  // in ninety seconds, while the pilot watched the ship take shield damage from
  // the rats it had just decided were not there.
  //
  // It is the same lie the scanner tells, answered the same way (see
  // `EMPTY_SCAN_CONFIRM_READS` in scriptMacros.ts): a grid that has not arrived
  // yet is byte-identical to a grid with nothing on it, so the first empty read
  // is not evidence. Believing it costs the whole site; re-reading costs six
  // seconds at the end of a fight that is already over.
  //
  // Consecutive is the whole of it — one hostile row resets the count, so a
  // fight that is genuinely still going never creeps toward finishing, and the
  // counter cannot accumulate across a lull.
  if (onGrid.length === 0) {
    const emptyReads = (num(mem, "emptyGridReads") ?? 0) + 1;
    if (emptyReads < EMPTY_GRID_CONFIRM_TICKS) {
      return tick(
        WAIT,
        "Nothing on the grid yet — reading it again before calling this done.",
        PHASE_FIGHT,
        ACTING,
        false,
        { ...mem, emptyGridReads: emptyReads },
      );
    }
    return leaveGrid(role, mem, roster, "The grid is clear.", PHASE_FIGHT);
  }
  mem = num(mem, "emptyGridReads") === null ? mem : { ...mem, emptyGridReads: 0 };

  // ─── Can this hull fight at all? ──────────────────────────────────────────
  //
  // ⚠ THIS COMES BEFORE THE GIVE-UP VERDICT, DELIBERATELY. A hull with no guns
  // and no combat drones is a FIT fault at our end, and §13's whole argument is
  // that our own faults must never be reported as the site's. The player needs
  // that sentence, not a tour of dens being "given up on" by a ship that could
  // never have cleared any of them.
  const weapons = obs.combatWeapons?.weapons.map(weapon => weapon.itemID) ?? obs.weaponModuleIDs ?? [];
  if (weapons.length === 0 && roster.roleOut.length === 0 && roster.roleBay.length === 0) {
    return tick(WAIT, "No way to fight.", PHASE_FIGHT, {
      kind: "blocked",
      reason: "This ship has no guns fitted and no combat drones in the bay.",
    }, true, mem);
  }

  // Ordinary continuous hardeners only; the observation excludes passive/burst families.
  const active = snapshot.ship?.activeModuleIDs;
  if (active != null && obs.capacitorRatio != null && obs.capacitorRatio > 0) {
    const idle = (obs.combatHardenerModuleIDs ?? obs.hardenerModuleIDs)?.find(id => !active.includes(id));
    if (idle !== undefined) return tick({ kind: "activate", moduleID: idle, targetID: 0 },
      "Hardening for combat.", PHASE_FIGHT, ACTING, true, mem);
  }

  // ─── FINISHING, PART TWO: §13 says leave ──────────────────────────────────
  //
  // ⚠ `done`, NEVER `blocked`. This is a verdict about ONE site and not about
  // the run: pausing here would strand a bot that has another five perfectly
  // good dens on the scanner. `warp-to-anomaly` is the block that decides when
  // the whole SYSTEM has run out.
  if (verdict.abandon) {
    const leaving = describeVerdict(verdict) ?? "I am leaving this site.";
    return leaveGrid(role, mem, roster, leaving, PHASE_FIGHT);
  }

  // ─── FINISHING, PART THREE: THE WAVE FIX ──────────────────────────────────
  //
  // Hostiles on grid, none of them inside lock range. `fight-the-rats` reads
  // this as an empty grid and FINISHES, which is how a bot ends up looting with
  // a wave inbound at 50 km. A drone boat can move, so it closes instead.
  //
  // ⚠ AND IT IS BOUNDED, BECAUSE THE FIX HAS ITS OWN FAILURE MODE. A rat
  // fleeing at 400 m/s will tow a 315 m/s frigate across the system for as long
  // as the block is willing to follow; `MAX_CLOSE_TICKS` is what turns "close on
  // the wave" into something other than "leave the grid you were sent to".
  //
  // ⚠ THE DRONES STAY IN THE BAY WHILE CLOSING (this rung sits above the launch
  // rung). A flight launched at a wave outside its own leash flies out of
  // control range chasing it, which is the one position from which drones stop
  // answering — and drones already in space are left alone, because they are
  // shooting and pulling them in costs the only damage on the grid.
  if (inReach.length === 0) {
    const closeTicks = (num(mem, "closeTicks") ?? 0) + 1;
    if (closeTicks > MAX_CLOSE_TICKS) {
      return leaveGrid(
        role,
        mem,
        roster,
        "I have been chasing this lot for two minutes without getting in range, so I am leaving them.",
        PHASE_CLOSE,
      );
    }
    // `hostileRows` is nearest-first, so row 0 is the nearest hostile — and
    // `approach` is a STANDING order, so it is issued once per target and then
    // this rung waits rather than re-issuing it every tick.
    const nearest = onGrid[0]!;
    if (num(mem, "approachID") !== nearest.itemID) {
      return tick(
        { kind: "approach", targetID: nearest.itemID },
        `Nothing is in lock range yet — closing on the nearest, ${km(nearest.distance)} out.`,
        PHASE_CLOSE,
        ACTING,
        true,
        clearCloseInStall({ ...mem, approachID: nearest.itemID, closeTicks }),
      );
    }
    // ⚠ "ONCE PER TARGET" HOLDS ONLY FOR AN ORDER THE SERVER ACTUALLY TOOK, and
    // the whole point of this block is that it arrives by WARP — which is
    // exactly when eve.js has the hull `landingPending` and throws the first
    // approach of the site away without saying so. `closeInStall.ts` carries
    // the deadlock in full; the short version is that the stop below is the one
    // order that frees it.
    //
    // ⚠ THE TWO-MINUTE BUDGET ABOVE IS NOT A SUBSTITUTE FOR THIS RUNG. It does
    // end the wait, but it ends it by LEAVING THE GRID — and leaving means
    // warping, which the same pending landing refuses, so the run stops on a
    // problem one `CmdStop` would have cleared.
    const stall = closeInStall(hullMode(snapshot), mem);
    if (stall.step === "reorder") {
      return tick(
        { kind: "approach", targetID: nearest.itemID },
        STALL_REORDER_WHY,
        PHASE_CLOSE,
        ACTING,
        true,
        { ...stall.mem, closeTicks },
      );
    }
    if (stall.step === "unstick") {
      return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, PHASE_CLOSE, ACTING, true, { ...stall.mem, closeTicks });
    }
    const active = snapshot.ship?.activeModuleIDs;
    if (active != null && obs.capacitorRatio != null) {
      const capBlockedProp = (obs.propulsionModules ?? []).some(module => !active.includes(module.itemID) &&
        !(obs.scrammed === true && module.kind !== "afterburner"));
      if (input.propMode === "auto" && capBlockedProp && obs.capacitorRatio < PROP_CAP_FLOOR) {
        const sustain = combatCapSustain(obs, mem, PROP_CAP_FLOOR);
        mem = sustain.memory;
        if (sustain.action) return tick(sustain.action, sustain.why, PHASE_CLOSE, ACTING, true, { ...stall.mem, ...mem, closeTicks });
      }
      const prop = decidePropulsionModule({ modules: obs.propulsionModules ?? [],
        activeModuleIDs: new Set(active), capacitorRatio: obs.capacitorRatio,
        scrammed: obs.scrammed ?? null, wantBurn: input.propMode === "auto", capFloor: PROP_CAP_FLOOR });
      if (prop.kind === "light") return tick({ kind: "activate", moduleID: prop.module.itemID,
        typeID: prop.module.typeID, targetID: 0 }, "Using propulsion to close on the distant wave.",
        PHASE_CLOSE, ACTING, true, { ...stall.mem, closeTicks });
      if (prop.kind === "stop") return tick({ kind: "deactivate", moduleID: prop.module.itemID,
        typeID: prop.module.typeID }, "Stopping propulsion while the close cannot use it safely.",
        PHASE_CLOSE, ACTING, true, { ...stall.mem, closeTicks });
    }
    return tick(
      WAIT,
      `Closing on the wave — ${km(nearest.distance)} to go.`,
      PHASE_CLOSE,
      ACTING,
      true,
      // "stuck" restarts the ladder rather than ending the block: the budget
      // above already owns "give up on this wave", and it is the rung that
      // knows what leaving costs.
      { ...(stall.step === "stuck" ? clearCloseInStall(stall.mem) : stall.mem), closeTicks },
    );
  }

  // Something is in reach: the chase is over and the budget goes back, so a
  // SECOND wave later in the same site gets its own full allowance. A budget
  // that only ever counted down would retire a site the ship is winning.
  mem = { ...mem, closeTicks: 0, approachID: null };

  // ─── Rung 1: the combat drones out ────────────────────────────────────────
  //
  // ⚠ NOT WHILE A ROTATION IS IN FLIGHT. Rung 6 recalls one drone at a time, so
  // mid-rotation the bay holds a combat stack and space may hold none of them —
  // which is exactly the shape this rung fires on. Launching then would put the
  // whole bay out on top of the rotation's own relaunch, spending bandwidth the
  // returning drone needs and leaving the rotation waiting for a launch it can
  // no longer tell apart from ours. The rotation owns the bay until it is done,
  // and every one of its phases is bounded, so this can never wedge.
  const rotating = readRotationMemory(mem["rotation"]).active !== null;
  if (!rotating) {
    const launch = launchRoleDrones(
      obs,
      mem,
      PHASE_FIGHT,
      "combat",
      "Launching the combat drones.",
      roster,
    );
    if (launch.tick !== null) return launch.tick;
    mem = launch.mem;
    if (weapons.length === 0 && roster.roleOut.length === 0 && launchStalled(mem)) {
      return tick(WAIT, "No way to fight.", PHASE_FIGHT, {
        kind: "blocked",
        reason: "The combat drones could not be launched, and there are no guns to fall back on.",
      }, true, mem);
    }
  }

  // ─── Rung 2: hold the range ───────────────────────────────────────────────
  //
  // The band is recomputed every tick from the grid as it is, so a fresh wave
  // carrying a longer-ranged scrammer moves the floor under the block's feet
  // mid-fight — and `shouldReissueHold` is what stops that becoming an order
  // every tick. Re-issue only when the ANCHOR changed (the old order measures
  // against a different object, so the distance it maintains is nobody's) or
  // when the wanted hold moved more than the hysteresis.
  //
  // ⚠ THE ANCHOR IS ONE ROCK IN A FIELD OF THEM. Holding 25 km off the nearest
  // scrammer says precisely nothing about the scrammer behind you. This is an
  // approximation and it is the same approximation a player makes at the
  // keyboard; nothing here maintains a distance from the whole grid.
  const band = kiteBand({
    threats: bandThreats(onGrid, threat),
    droneControlRangeM: obs.droneControlRangeM ?? null,
    maxTargetRangeM: obs.maxTargetRangeM ?? null,
    overrideHoldM: input.holdRangeM,
  });
  // ⚠ THE ANCHOR IS STICKY, AND WITHOUT THAT THE SHIP NEVER HOLDS ANYTHING.
  // `kiteBand` answers "the nearest thing that can grab you", which is a fresh
  // answer every tick — and on a live grid the nearest rat changes constantly as
  // they die and close. Caught live on 2026-09-14: the log is five consecutive
  // cycles of "keep range off 225 / 226 / 227 / 228 / 229 at 17000m", each one a
  // fresh keepAtRange at a different rat. Every re-aim stops the ship, turns it
  // and burns it somewhere new, so it never settles at any range at all and the
  // drones are dragged along behind it — the pilot's words were "it constantly
  // loses target and needs to reapproach".
  //
  // This is the same lesson the PRIMARY already carries two rungs down ("fire is
  // CONCENTRATED — spread damage kills nothing"): a decision re-taken every tick
  // is not a decision. So the anchor is kept while it is still worth keeping and
  // re-picked only when it stops being:
  //
  //   • it left the grid (died, warped, despawned), or
  //   • it is no longer a threat at all, or
  //   • the band now names a SCRAMMER and the one being held is not one — the
  //     only upgrade worth paying a re-aim for, because a scram is what stops
  //     the ship leaving and a web is not.
  //
  // Anything else — a closer rat, a new wave, a shuffled sort order — leaves the
  // anchor exactly where it is.
  const heldAnchorID = num(mem, "anchorID");
  const heldAnchorRow =
    heldAnchorID === null ? undefined : onGrid.find((row) => row.itemID === heldAnchorID);
  const heldIsThreat =
    heldAnchorRow !== undefined && heldAnchorRow.typeID !== null
      ? isBandThreat(threat(heldAnchorRow.typeID))
      : false;
  const bandNamesAScrammer =
    band.anchorID !== null &&
    onGrid.some(
      (row) =>
        row.itemID === band.anchorID && row.typeID !== null && threat(row.typeID)?.scram === true,
    );
  const heldIsScrammer =
    heldAnchorRow !== undefined &&
    heldAnchorRow.typeID !== null &&
    threat(heldAnchorRow.typeID)?.scram === true;
  const keepHeldAnchor =
    heldAnchorRow !== undefined && heldIsThreat && !(bandNamesAScrammer && !heldIsScrammer);
  const anchorID = keepHeldAnchor ? heldAnchorID : band.anchorID;
  const anchorRow = anchorID === null ? undefined : onGrid.find((row) => row.itemID === anchorID);
  const currentRangeM = anchorRow === undefined ? null : Math.round(anchorRow.distance);

  // ⚠ A HOLD THAT SITS INSIDE THE WORST SCRAM ON GRID IS NEVER SOMETHING TO
  // CLOSE TOWARD. THIS COST A SHIP ON 2026-09-14 AND IT IS THE REASON THIS
  // GUARD EXISTS.
  //
  // What happened, in the order it happened: the fit did not report a drone
  // control range, so the band fell back to the no-skills 20 km guess and the
  // ceiling came out at 17 km. The rats scrammed at 20 km, so the floor was
  // 25 km and the band was EMPTY — and §2 as written answered an empty band
  // with "hold at the ceiling and say so". The ship was already 25.5 km out,
  // OUTSIDE the scram, so "hold at the ceiling" was an order to close 8.5 km.
  // It spent its prop mod doing exactly that, crossed into the scram, got
  // pointed, and could not warp when the armour watch fired. The watch worked;
  // the readout was truthful ("Burning to close 8.5 km of gap"); the ship died
  // because the block flew it into a point on purpose.
  //
  // THE GENERAL FORM, AND WHY THE TEST IS NOT `band.empty`. Burning toward a
  // hold that lies inside the reach of the worst scrammer on grid is wrong
  // whenever it happens — an empty band is simply the ordinary way to arrive
  // there, not a special case deserving its own rule. In a band that is NOT
  // empty the floor already guarantees it cannot happen: with a scrammer on
  // grid the wanted hold IS the floor (scram reach plus `THREAT_BUFFER_M`) and
  // the ceiling is above it, so `holdM < floorM` is unreachable. Writing the
  // test as the thing that is actually wrong means a future change to how the
  // band is clamped cannot quietly reopen this by producing some other hold
  // below the floor.
  //
  // ⚠ AN OVERRIDE IS EXCLUDED, AND THAT IS NOT A LOOPHOLE. §2 is explicit that
  // a player who types a hold range may deliberately brawl inside scram range;
  // the override is also the one fix offered by the readout below, and a guard
  // that refused to fly to the player's own number would make that advice a
  // lie. What the block must never do is fly into a point of its OWN accord.
  const holdInsideTheScram = band.holdM < band.floorM && band.reason !== "override";

  // Where to actually ask to sit. Normally the band's answer; under the guard,
  // never nearer than where the ship already is. Further out is the one
  // direction that is always safe here, so:
  //
  //   • the ship OUTSIDE the band's hold is pinned where it is — the order stops
  //     the inward burn (a standing `approach` from the closing rung above, or a
  //     hold issued before a new wave raised the floor) without asking for a
  //     single metre of closing;
  //   • the ship INSIDE the ceiling still gets the ceiling, because opening out
  //     to it moves AWAY from the scram;
  //   • an anchor whose distance cannot be read issues nothing at all. The null
  //     wins: if the block cannot tell which way the order would move the ship,
  //     it does not give the order, and the rungs below still fight.
  //
  // The hysteresis does the rest — a pin re-issued only when the ship has been
  // dragged more than `RANGE_HYSTERESIS_M` off it, never below where it is.
  const holdTargetM = holdInsideTheScram
    ? currentRangeM === null
      ? null
      : Math.max(band.holdM, currentRangeM)
    : band.holdM;

  if (anchorID !== null && holdTargetM !== null) {
    const anchorChanged = num(mem, "anchorID") !== anchorID;
    if (shouldReissueHold(num(mem, "holdM"), holdTargetM, anchorChanged)) {
      return tick(
        { kind: "keepAtRange", targetID: anchorID, range: holdTargetM },
        bandWhy(band, holdTargetM),
        PHASE_FIGHT,
        ACTING,
        true,
        { ...mem, holdM: holdTargetM, anchorID },
      );
    }
  }

  // ─── Rung 3: propulsion ───────────────────────────────────────────────────
  //
  // `wantBurn` is this block's ONE contribution to the shared policy; everything
  // else (the scram rule, the capacitor floor gating only the lighting, the
  // unknown kind treated as a microwarpdrive, which module to name) belongs to
  // `decidePropulsionModule` and is not re-decided here.
  //
  // §5: light it ONLY to close a gap, and kill it the moment the ship is inside
  // the band — holding station with a burner lit is pure signature for no
  // distance, and on a Tristan (sig 600) that signature is what the rat guns are
  // tracking. One threshold does both halves: the burner is wanted while the gap
  // is bigger than `PROP_GAP_M` and unwanted as soon as it is not, which is well
  // inside the band's own 2 km hysteresis.
  //
  // ⚠ `propMode: "off"` MEANS NEVER LIGHT ONE — IT DOES NOT MEAN IGNORE THE
  // RACK. A module already running must always be stoppable (that is the
  // asymmetry the policy's capacitor rule is built on), so "off" is expressed as
  // `wantBurn: false` and the policy's stop half still runs. Skipping the rung
  // entirely would strand a burner lit by the previous block, burning signature
  // and capacitor for the rest of the site.
  //
  // ⚠ AN UNREADABLE ACTIVE-MODULE LIST SKIPS THE RUNG ENTIRELY. `activeModuleIDs`
  // is null for "the read could not answer", and `decidePropulsionModule` says in
  // as many words that a caller whose snapshot cannot say must not call at all:
  // reading null as "nothing is running" re-activates a lit burner every tick for
  // as long as the read stays down, and every one of those is a refusal in the
  // ledger.
  const activeModuleIDs = snapshot.ship?.activeModuleIDs ?? null;
  const props = obs.propulsionModules ?? [];
  if (activeModuleIDs !== null && props.length > 0) {
    // A null gap never decides: with no anchor, or no measurable distance to it,
    // the block does not know whether it is closing, so it does not burn. It can
    // still STOP, which is the half that is always safe.
    //
    // ⚠ THE GAP IS MEASURED AGAINST THE HOLD THE BLOCK ACTUALLY ASKED FOR, NOT
    // AGAINST `band.holdM`. Under the guard above those two differ, and it is
    // this line that turned the guard's live counterpart into a dead ship: the
    // hold rung's order and the burner's reason for lighting have to come from
    // one number, or the block declines to close and then burns to close anyway.
    const gapM =
      currentRangeM === null || holdTargetM === null ? null : Math.abs(currentRangeM - holdTargetM);
    // Which way the burn would take the ship. Opening is always allowed — it is
    // the direction away from whatever can hold us.
    const closingTheGap = currentRangeM !== null && holdTargetM !== null && currentRangeM > holdTargetM;
    // The second clause is belt and braces rather than a second opinion: pinning
    // the hold at the current range already leaves no closing gap to burn. It is
    // written out at the burn site anyway because "Burning to close 8.5 km of
    // gap" is the line the 2026-09-14 log ended on, and the rule that forbids it
    // should be legible exactly where that line is produced.
    const wantBurn =
      obs.capacitorRatio != null &&
      input.propMode === "auto" &&
      gapM !== null &&
      gapM > PROP_GAP_M &&
      !(closingTheGap && holdInsideTheScram);
    const decision = decidePropulsionModule({
      modules: props,
      activeModuleIDs: new Set(activeModuleIDs),
      capacitorRatio: obs.capacitorRatio ?? null,
      scrammed: obs.scrammed ?? null,
      wantBurn,
      capFloor: PROP_CAP_FLOOR,
    });
    if (wantBurn && obs.capacitorRatio != null && obs.capacitorRatio < PROP_CAP_FLOOR &&
        props.some(module => !activeModuleIDs.includes(module.itemID) && !(obs.scrammed === true && module.kind !== "afterburner"))) {
      const sustain = combatCapSustain(obs, mem, PROP_CAP_FLOOR);
      mem = sustain.memory;
      if (sustain.action) return tick(sustain.action, sustain.why, PHASE_FIGHT, ACTING, true, mem);
    }
    if (decision.kind === "light") {
      // `targetID: 0` is this tree's "no target" for a self-activating module —
      // the same call the hardener rung makes.
      return tick(
        { kind: "activate", moduleID: decision.module.itemID, typeID: decision.module.typeID, targetID: 0 },
        closingTheGap
          ? `Burning to close ${km(gapM ?? 0)} of gap.`
          : `Burning to open ${km(gapM ?? 0)} of gap.`,
        PHASE_FIGHT,
        ACTING,
        true,
        mem,
      );
    }
    if (decision.kind === "stop") {
      // ⚠ THE ISSUER MUST NAME THE PROPULSION EFFECT ON THIS DEACTIVATE. The
      // server infers a prop mod's default effect on ACTIVATE and not on
      // deactivate, so a bare Deactivate returns success with the burner still
      // cycling (see `PropulsionModule.typeID`, which exists for this reason).
      // `ScriptAction`'s deactivate carries only the module id, so the effect
      // name has to be resolved from the fit at the issue site — the adapter
      // parcel owns that, and a stop that silently does nothing is what it costs
      // to get wrong.
      return tick(
        { kind: "deactivate", moduleID: decision.module.itemID },
        input.propMode === "off"
          ? "Shutting the prop mod down — you asked me not to use one."
          : "In the band now, so the prop mod goes out rather than blooming my signature for nothing.",
        PHASE_FIGHT,
        ACTING,
        true,
        mem,
      );
    }
  }

  // ─── Rung 4: the primary ──────────────────────────────────────────────────
  //
  // What the FLEET called when this block follows one and that ship is here,
  // otherwise the hostile the ladder ranks first. Remembered either way so fire
  // is CONCENTRATED — spread damage kills nothing, which is the whole reason
  // both halves of this exist.
  const called =
    role === "follow" && input.calledTargetID !== null
      ? (inReach.find((row) => row.itemID === input.calledTargetID) ?? null)
      : null;
  let targetID = num(mem, "targetID");
  if (targetID !== null && !inReach.some((row) => row.itemID === targetID)) {
    targetID = null; // it died, or it drifted out of reach — next
  }
  if (called !== null && targetID !== called.itemID) {
    // The fleet called something else. Switching mid-fight is the POINT of
    // following: an FC re-calls when the first primary stops being the problem.
    targetID = null;
  }
  if (targetID === null) {
    const primary =
      called ??
      pickPrimary(
        inReach,
        (row) => row.typeID,
        (row) => row.distance,
        groupReader(obs),
        input.targets.length > 0 ? input.targets : DEFAULT_TARGET_PRIORITY,
        // Tags are resolved one rung up, by the adapter, and are never passed
        // into `pickPrimary` as well — two mechanisms ranking the same thing is
        // how one of them silently stops mattering.
        undefined,
        threat,
        jamSources(obs),
      ) ??
      inReach[0]!;
    return tick(
      { kind: "lock", targetID: primary.itemID },
      called !== null ? "Locking what the fleet called." : "Locking the one at the top of the list.",
      PHASE_FIGHT,
      ACTING,
      true,
      { ...mem, targetID: primary.itemID, lockIssued: true, waited: 0, dronesOn: null },
    );
  }
  const call = callPrimary(role, mem, targetID, "Calling it for the fleet.", PHASE_FIGHT);
  if (call !== null) return call;

  const lockedIDs = obs.lockedTargetIDs ?? [];
  if (!lockedIDs.includes(targetID)) {
    if (!flag(mem, "lockIssued")) {
      return tick({ kind: "lock", targetID }, "Locking it.", PHASE_FIGHT, ACTING, true, {
        ...mem,
        lockIssued: true,
        waited: 0,
      });
    }
    const waited = (num(mem, "waited") ?? 0) + 1;
    if (waited > MAX_LOCK_WAIT_TICKS) {
      // ⚠ THE WHOLE MEMORY GOES, not just the target: the launch budget, the
      // standing hold and the rotation record all belong to a fight that is
      // being restarted, and carrying a spent lock wait into the next pick is
      // how a block gives up on every target in turn after the first bad one.
      return tick(WAIT, "That one would not lock — picking another.", PHASE_FIGHT, ACTING, true, {});
    }
    return tick(WAIT, "Waiting for the lock.", PHASE_FIGHT, ACTING, true, { ...mem, waited });
  }

  // ─── Rung 5: the drones onto it ───────────────────────────────────────────
  //
  // Once per target, which is what `dronesOn` is for. Re-issuing an engage every
  // tick would starve every rung below and buy nothing: the order is standing.
  if (roster.roleOut.length > 0 && num(mem, "dronesOn") !== targetID) {
    return tick(
      { kind: "engageDrones", droneIDs: roster.roleOut, targetID },
      "Setting the drones on it.",
      PHASE_FIGHT,
      ACTING,
      true,
      { ...mem, dronesOn: targetID },
    );
  }

  // ─── Rung 6: rotate a hurt drone ──────────────────────────────────────────
  //
  // ⚠ BELOW THE ENGAGE RUNG, AND THAT PLACEMENT IS HALF THE RULE. §4: never at
  // the cost of the primary being unattended. Reaching here means the primary is
  // locked and the flight is already on it, so a rotation costs one drone's
  // flight time and nothing else.
  //
  // ⚠ THE OTHER HALF IS EXPLICIT, BECAUSE PLACEMENT ALONE DOES NOT COVER IT. A
  // boat with ONE combat drone out has a flight of one; pulling it leaves the
  // primary completely unattended however far down the ladder the rung sits. So
  // a rotation is not STARTED with a single drone out — but one already in
  // flight is always allowed to finish, or the recall that emptied the flight
  // would wedge the machine for the rest of the site.
  //
  // ⚠ THE MACHINE ONLY TICKS ON THE TICKS THIS RUNG IS REACHED, and its wait
  // counters are therefore counted in those ticks. That is the right semantics:
  // every bound it carries is about an ORDER THAT NEVER LANDED, and an order
  // cannot fail to land on a tick where the block was doing something else.
  // Advancing it from a higher rung would mean recording a recall we never
  // issued, which is the one input that can wedge it.
  const rotationMemory = readRotationMemory(mem["rotation"]);
  const rotationAllowed = rotationMemory.active !== null || roster.roleOut.length > 1;
  if (rotationAllowed) {
    const step: DroneRotationStep = decideDroneRotation({
      dronesInSpace: roster.roleRows,
      droneIDsInBay: obs.combatDroneBayItemIDs ?? null,
      memory: mem["rotation"],
    });
    // A completed rotation puts a drone back in space with no orders, so the
    // engage rung has to be told to run again — that is what droneRotation's own
    // header means by "the block's engage rung picks it up again".
    mem = {
      ...mem,
      rotation: step.memory,
      ...(step.reason === "complete" ? { dronesOn: null } : {}),
    };
    if (step.action === "recall" && step.itemID !== null) {
      return tick(
        { kind: "recallDrones", droneIDs: [step.itemID] },
        "That drone has started losing shield — pulling it before the rats finish it.",
        PHASE_FIGHT,
        ACTING,
        true,
        mem,
      );
    }
    if (step.action === "relaunch" && step.itemID !== null) {
      return tick(
        { kind: "launchDrones", droneItemIDs: [step.itemID] },
        "Sending the repaired drone back out.",
        PHASE_FIGHT,
        ACTING,
        true,
        mem,
      );
    }
  }

  // ─── Rung 7: pre-lock the next ones ───────────────────────────────────────
  //
  // Tristan holds five targets; `fight-the-rats` uses one and pays a fresh lock
  // every kill, which is 8-16 s of a dead grid after every rat dies. Filling the
  // spare slots in priority order means the next primary is already locked when
  // this one dies.
  //
  // ⚠ UNREADABLE MEANS DO NOT PRE-LOCK, NOT "GUESS A NUMBER". A hull's lock
  // count is a real limit and the server refuses the lock past it — a refusal
  // booked in the ledger, where enough on one key end the run. Guessing five
  // because a Tristan holds five would spend that refusal on every destroyer.
  //
  // ⚠ AND IT ASKS FOR EACH TARGET AT MOST ONCE. This rung has no bounded wait of
  // its own (a bounded wait here would have to compete with the primary's, and
  // whichever lost would spin), so "we have already asked for this one" is the
  // entire stop condition. A pre-lock that does not land is simply not retried:
  // it is an optimisation, and the target gets a proper bounded lock the moment
  // it becomes the primary.
  const maxLocks = maxLocksOf(obs);
  const locksReadable = obs.lockedTargetIDs !== undefined && obs.lockedTargetIDs !== null;
  if (maxLocks !== null && locksReadable && lockedIDs.length < maxLocks) {
    const asked = idList(mem, "preLocked");
    const spare = inReach.filter((row) => !lockedIDs.includes(row.itemID) && !asked.includes(row.itemID));
    if (spare.length > 0) {
      const next =
        pickPrimary(
          spare,
          (row) => row.typeID,
          (row) => row.distance,
          groupReader(obs),
          input.targets.length > 0 ? input.targets : DEFAULT_TARGET_PRIORITY,
          undefined,
          threat,
          jamSources(obs),
        ) ?? spare[0]!;
      return tick(
        { kind: "lock", targetID: next.itemID },
        "Locking the next one up while this one dies.",
        PHASE_FIGHT,
        ACTING,
        true,
        { ...mem, preLocked: [...asked, next.itemID].slice(-MAX_PRELOCK_MEMORY) },
      );
    }
  }

  const utility = decideCombatUtilities(obs, mem, targetID);
  mem = utility.memory;
  if (utility.action) return tick(utility.action, utility.why, PHASE_FIGHT,
    utility.blocked ? { kind: "blocked", reason: utility.blocked } : ACTING, true, mem);

  // ─── Rung 8: guns ─────────────────────────────────────────────────────────
  //
  // ⚠ AN UNLOADED GUN IS NEVER ACTIVATED. A gun with no charge will not fire,
  // and the attempt is booked in the refusal ledger. Fresh combat-fit facts
  // must prove the loaded charge and individual useful reach before firing.
  // Unknown charge/range/bank metadata cannot authorize activation.
  //
  // A drone boat whose guns are ALL empty fights with its drones and says so,
  // rather than stopping. That is §7, and it is why this rung falls through
  // instead of blocking.
  if (activeModuleIDs !== null) {
    const running = new Set(activeModuleIDs);
    const reload = combatReload(obs.combatWeapons, mem);
    mem = reload.memory;
    if (reload.action !== null) return tick(reload.action, "Loading proven compatible ammunition.", PHASE_FIGHT, ACTING, true, mem);
    const target = inReach.find(row => row.itemID === targetID);
    const banks = snapshot.ship?.weaponBanks;
    const banked = new Set(Object.entries(banks ?? {}).flatMap(([master, slaves]) => [Number(master), ...slaves]));
    const idleGun = obs.combatWeapons?.weapons.find(weapon => !running.has(weapon.itemID) &&
      banks != null && !banked.has(weapon.itemID) &&
      weaponUseful(weapon, target?.distance ?? null));
    if (idleGun !== undefined) {
      return tick({ kind: "activate", moduleID: idleGun.itemID, typeID: idleGun.typeID, targetID }, "Guns on it within their proven reach.", PHASE_FIGHT, ACTING, true, mem);
    }
  }

  const allGunsEmpty = weapons.length > 0 && weapons.every((id) => (obs.unloadedWeaponIDs ?? []).includes(id));
  return tick(
    WAIT,
    allGunsEmpty ? "Fighting it with the drones — every gun aboard is empty." : "Fighting it.",
    PHASE_FIGHT,
    ACTING,
    true,
    mem,
  );
}
