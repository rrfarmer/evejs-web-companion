// Jam notifications: who is holding this ship down, and with what.
//
// The server pushes `OnJamStart` to the VICTIM'S OWN SESSION the moment a
// hostile module cycle lands on it, and `OnJamEnd` when the effect drops
// (`space/runtime.js:13127` — `notifyHudJamStateToSession`, reached only via
// `notifyHostileHudStateToSession(targetSession, …)`, i.e. the session of the
// entity being jammed). So the aggressor NAMES ITSELF, on the victim's own
// wire, which is exactly the read "tackle → tag" needs and which no space
// snapshot carries: an earlier pass looked only at `space.ts`, found nothing,
// and wrongly concluded the only signal available was the reactive warp
// refusal.
//
// Wire contract, read off `space/runtime.js:13155` and `:13173`:
//   OnJamStart args = [sourceBallID, moduleID, targetBallID, jammingType,
//                      fileTime, durationMs]   — six positional elements
//   OnJamEnd   args = [sourceBallID, moduleID, targetBallID, jammingType]
//                                              — the same first four, no more
//
// All three ids are `toInt`-normalized server-side before they are sent (unlike
// a broadcast's `itemID`, which is passed through opaquely), and the server
// refuses to send at all unless every one of them is positive and the
// `jammingType` is a non-empty string. They still go through the same
// `positiveSafeID` coercer every bridge decoder uses rather than being trusted
// blind — cheap, and it keeps one shape of id handling across this directory.
//
// ⚠ IT ALREADY REACHES THE BROWSER. The web gateway's notification stub
// suppresses exactly ONE method, `DoDestinyUpdate`
// (`evejsWebGatewayRuntime.js:4031,4357`), and captures every other
// `sendNotification` onto the push stream. `OnJamStart` is not suppressed, so
// this needs no BFF route and no gateway patch — only a decoder, the same
// shape as `fleetBroadcasts.ts`.
//
// ⚠ `args[4]` IS A SERVER FILETIME, NOT A CLIENT CLOCK. It is run through
// `resolveVisibleSessionNotificationFileTime` on the way out, which is the
// retail client's own time base. Nothing here reads it: a jam is stamped with
// the moment the BROWSER received it, the same discipline
// `decodeFleetBroadcastNotification` follows with `receivedAtMs`, so every
// freshness answer in this client comes from one clock.

import { unwrapLong } from "./wire.ts";

// --- the tackle allowlist -------------------------------------------------

/**
 * The two `jammingType` strings that mean "this ship cannot warp out".
 * `warpScramblerMWD` is a Warp Scrambler and `warpScrambler` is a Warp
 * Disruptor — the names are the server's and they are, unhelpfully, the wrong
 * way round from how a player says them
 * (`space/modules/hostileModuleRuntime.js:191,203`; the `scram` definition is
 * the one that also carries `blocksMicrowarpdrive`).
 *
 * ⚠ AN ALLOWLIST, NEVER A BLACKLIST. The same notification carries webs
 * (`webify`), target painters, damps, neuts, vampires, tracking and guidance
 * disruptors — nine other types in that one file, and a future server drop may
 * add more. A blacklist would silently start treating some new ewar type as
 * tackle the day it shipped; this fails safe in the other direction, and a
 * missing type shows up as "did not tag" rather than as a fleet-wide letter
 * stamped on a ship nothing is holding.
 */
export const TACKLE_JAMMING_TYPES = ["warpScramblerMWD", "warpScrambler"] as const;

export type TackleJammingType = (typeof TACKLE_JAMMING_TYPES)[number];

export function isTackleJammingType(value: unknown): value is TackleJammingType {
  return (
    typeof value === "string" && (TACKLE_JAMMING_TYPES as readonly string[]).includes(value)
  );
}

// --- decoding -------------------------------------------------------------

/** One `OnJamStart` / `OnJamEnd` push, decoded. */
export interface JamEvent {
  /** True for `OnJamStart`, false for `OnJamEnd`. */
  readonly active: boolean;
  /** The AGGRESSOR's entity id — the ball that wants tagging. */
  readonly sourceBallID: number;
  /**
   * The aggressor's module. Part of the identity of a jam: one ship may hold
   * another with two.
   */
  readonly moduleID: number;
  /**
   * The victim's entity id. Always this ship — the push goes to the victim's
   * session alone.
   */
  readonly targetBallID: number;
  /**
   * The server's own effect name. Not narrowed here; `isTackleJammingType` is
   * the caller's gate.
   */
  readonly jammingType: string;
  /** When the BROWSER saw this, never the server's `fileTime`. See the ⚠ in the header. */
  readonly receivedAtMs: number;
  /**
   * How long the cycle that landed this jam runs for, per the server
   * (`Math.max(1, …)`, so never zero when it is readable at all). `null` when
   * the payload did not carry a readable one — see `JAM_ASSUMED_DURATION_MS`.
   * Always null on an end event, which needs no duration.
   */
  readonly durationMs: number | null;
}

/**
 * A positive game id as a Number, accepting the `{type:"long"}` wrapper, a bare
 * integer, or a bare decimal string. Every bridge decoder keeps its own copy of
 * this coercer rather than sharing one (see `fleetBroadcasts.ts`'s note).
 */
function positiveSafeID(value: unknown): number | null {
  const unwrapped = unwrapLong(value);
  if (unwrapped !== null && unwrapped > 0n && unwrapped <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(unwrapped);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  }
  return null;
}

/** A positive whole number of milliseconds, or null. */
function positiveDurationMs(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.trunc(numeric);
}

/**
 * Decode one `OnJamStart` / `OnJamEnd` push, or null when this is a different
 * method or the payload is unusable.
 *
 * ⚠ A JAM WITH NO READABLE SOURCE IS DROPPED, NOT KEPT ANONYMOUS. The whole
 * point of this read is that the aggressor names itself; a record whose
 * `sourceBallID` failed to decode names nothing, and keeping it would let a
 * caller believe it is tackled by something it can never tag or shoot. The
 * server refuses to send one of these unless all three ids are positive, so an
 * unreadable id here means we are decoding garbage.
 */
export function decodeJamNotification(
  method: string | null,
  args: readonly unknown[],
  receivedAtMs: number,
): JamEvent | null {
  if (method !== "OnJamStart" && method !== "OnJamEnd") {
    return null;
  }
  const sourceBallID = positiveSafeID(args[0]);
  const moduleID = positiveSafeID(args[1]);
  const targetBallID = positiveSafeID(args[2]);
  const jammingType = args[3];
  if (
    sourceBallID === null ||
    moduleID === null ||
    targetBallID === null ||
    typeof jammingType !== "string" ||
    jammingType.trim() === ""
  ) {
    return null;
  }
  const active = method === "OnJamStart";
  return {
    active,
    sourceBallID,
    moduleID,
    targetBallID,
    jammingType: jammingType.trim(),
    receivedAtMs: Number.isFinite(receivedAtMs) && receivedAtMs > 0 ? receivedAtMs : Date.now(),
    durationMs: active ? positiveDurationMs(args[5]) : null,
  };
}

// --- the standing set -----------------------------------------------------

/** One jam currently held on this ship. The fold of every event seen so far. */
export interface ActiveJam {
  readonly sourceBallID: number;
  readonly moduleID: number;
  readonly jammingType: string;
  /**
   * When the most recent cycle of this jam was received. Refreshed on every
   * re-cycle.
   */
  readonly receivedAtMs: number;
  readonly durationMs: number | null;
}

/**
 * What a jam whose payload carried no readable duration is assumed to run for.
 *
 * Used only as the input to the safety-net expiry below, and deliberately on
 * the generous side: the server sends `OnJamEnd` the moment the effect drops
 * and again from the destiny tick's own expiry sweep
 * (`tickHudIconStateExpiries`, `space/runtime.js:13325`), so the end event is
 * both authoritative and prompt and this fallback only ever matters when a push
 * was LOST. Erring long keeps a tackler in the set a few seconds after it let
 * go — which costs a redundant letter on a ship that was holding us moments
 * ago. Erring short would drop a live tackler and silently stop the fleet being
 * told about it, which is the failure this read exists to prevent.
 */
export const JAM_ASSUMED_DURATION_MS = 20_000;

/**
 * How long past a cycle's own end a jam is still believed.
 *
 * Every cycle of a running module re-sends `OnJamStart` with a fresh
 * `startTimeMs` and `durationMs` (`space/runtime.js:5665` for tackle modules,
 * `:13033` for jammers — `refreshTimerOnly` governs only the buff-bar refresh,
 * never whether the notification is sent), so a jam that is still held is
 * re-stamped once per cycle. The grace covers the gap between one cycle ending
 * and the next one's push landing; without it a scram would flicker out of the
 * set between every cycle.
 */
export const JAM_REFRESH_GRACE_MS = 5_000;

/** When this jam stops being believed, absent an `OnJamEnd`. */
function jamExpiresAtMs(jam: ActiveJam): number {
  return jam.receivedAtMs + (jam.durationMs ?? JAM_ASSUMED_DURATION_MS) + JAM_REFRESH_GRACE_MS;
}

/**
 * Whether a jam is still believed at `nowMs`.
 *
 * ⚠ CHECKED AT READ TIME, NEVER ON A TIMER — the same discipline
 * `isFleetBroadcastFresh` follows. The store keeps what the wire said; deciding
 * whether it still holds is the reader's job, and a reader that asks gets one
 * consistent answer for the whole tick.
 */
export function isJamLive(jam: ActiveJam, nowMs: number): boolean {
  return nowMs < jamExpiresAtMs(jam);
}

/** The identity of a jam: ONE ship may hold another with two modules at once. */
function sameJam(
  a: { readonly sourceBallID: number; readonly moduleID: number },
  b: JamEvent,
): boolean {
  return a.sourceBallID === b.sourceBallID && a.moduleID === b.moduleID;
}

/**
 * Fold one event into the standing set: a start adds or REFRESHES, an end
 * removes. Pure, and returns the same array reference when nothing changed so a
 * store can skip a needless notify.
 */
export function applyJamEvent(
  jams: readonly ActiveJam[],
  event: JamEvent,
): readonly ActiveJam[] {
  if (!event.active) {
    const remaining = jams.filter((jam) => !sameJam(jam, event));
    return remaining.length === jams.length ? jams : remaining;
  }
  const refreshed: ActiveJam = {
    sourceBallID: event.sourceBallID,
    moduleID: event.moduleID,
    jammingType: event.jammingType,
    receivedAtMs: event.receivedAtMs,
    durationMs: event.durationMs,
  };
  const index = jams.findIndex((jam) => sameJam(jam, event));
  if (index < 0) {
    return [...jams, refreshed];
  }
  const next = [...jams];
  next[index] = refreshed;
  return next;
}

/**
 * The entity ids currently TACKLING this ship — deduplicated, in the order
 * their jams were first seen, and narrowed to the two tackle types.
 *
 * Deduplicated because one ship holding another with both a scrambler and a
 * disruptor is two jams and one tagging candidate; a caller that counted jams
 * would try to letter the same ship twice.
 */
export function tacklersHolding(
  jams: readonly ActiveJam[],
  nowMs: number,
): readonly number[] {
  const holding: number[] = [];
  for (const jam of jams) {
    if (!isTackleJammingType(jam.jammingType) || !isJamLive(jam, nowMs)) {
      continue;
    }
    if (!holding.includes(jam.sourceBallID)) {
      holding.push(jam.sourceBallID);
    }
  }
  return holding;
}

/**
 * Whether a live WARP SCRAMBLER is on this ship — the narrower half of
 * `tacklersHolding` above, and the only jam that turns a microwarpdrive off.
 *
 * ⚠ ONE OF THE TWO TACKLE TYPES, NOT BOTH, AND THE NAMES ARE THE WRONG WAY
 * ROUND. `warpScramblerMWD` is the SCRAM (the definition carrying
 * `blocksMicrowarpdrive`) and `warpScrambler` is the DISRUPTOR, which stops a
 * warp and leaves the prop mod alone — see `TACKLE_JAMMING_TYPES`'s own header.
 * Reusing `tacklersHolding` here would read a disruptor as an MWD kill and
 * stand a bot's propulsion down for a jam that never touched it.
 *
 * ⚠ AND IT SAYS NOTHING ABOUT AFTERBURNERS, which no jam in this vocabulary
 * stops. A caller must know which prop mod it is holding before it acts on
 * this; `propulsionEffect` (store/names.ts) is where that answer comes from.
 */
export function scrammedByWarpScrambler(
  jams: readonly ActiveJam[],
  nowMs: number,
): boolean {
  return jams.some((jam) => jam.jammingType === "warpScramblerMWD" && isJamLive(jam, nowMs));
}
