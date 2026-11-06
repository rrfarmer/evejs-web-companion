// Fleet companion — the WORDS a readout uses, in one place.
//
// Two surfaces now describe one running companion: the pilot's own panel
// (`ui/FleetCompanion.svelte`) and the roster of the Companions window
// (`ui/FleetCompanions.svelte`). They must not tell different
// stories about the same run — `src/botHost.js` states the same principle
// where it folds a bot's progress onto its roster row ("same words the in-tab
// readout shows, so the phone and a tab never tell different stories").
//
// ⚠ ROLE AND ORDER-SOURCE LABELS ARE GONE, AND THAT IS NOT A TRIM OF THIS
// MODULE — IT IS THE CONFIGURATION SURFACE THEY DESCRIBED DISAPPEARING.
// `docs/fleet-companion-simplification.md` deleted `FleetCompanionRole` and
// `FleetCompanionOrderSource` from `nav/fleetCompanionLoop.ts` entirely: a role
// picked exactly one field (`fleeHealthFloor`, in the now-deleted
// `companionRolePresets.ts`) that no decision rung ever read, and the order
// sources were checkboxes in front of channels that are simply always on now.
// There is nothing left keyed by either, so there is nothing left to keep two
// copies of in agreement — the duplication risk this module used to exist to
// close (`COMPANION_ROLE_LABELS` in `src/botHost.js` and `roleLabels` in
// FleetCompanion.svelte, nothing to fail if they drifted) is moot because both
// sides of that duplication are gone. What remains below (`inFleetWords`,
// `canTagWords`, `orderFromWords`) still serves both surfaces from one place,
// for the same reason.
//
// PURE, AND DELIBERATELY SO. No store, no I/O, no Svelte. A phrase is a fact
// about the run, so it is testable without a DOM.

import type { CompanionOrderAuthority } from "./fleetCompanionLoop.ts";

/** Whether this pilot is in a fleet. Three states; null is "not read yet". */
export function inFleetWords(value: boolean | null): string {
  if (value === null) {
    return "not known";
  }
  return value ? "yes" : "no";
}

/**
 * Which authority the last decision came from.
 *
 * ⚠ THIS NAMES A CHANNEL, NEVER A PILOT. `FleetCompanionProgress` carries the
 * KIND of authority and not who exercised it; the broadcast's own
 * `senderCharID` is on the fleet slice if a future readout wants the name, but
 * nothing here invents one out of the channel.
 *
 * ⚠ `squad-board` IS GONE, AND IT WAS NEVER REAL. It used to be a case here,
 * naming an order source a player could tick on the settings screen — but
 * `obeys` was read at four places in the loop (`fleetCompanionLoop.ts:2466`,
 * `:2479`, `:3337`, `:3346`, before the simplification) and not one of them
 * was squad-board, so this readout could name an authority no decision could
 * ever emit. The BFF's squad board itself (`src/squadBoard.js`) is untouched
 * and still serves the scripted bots; only the companion's readout lost the
 * member. Do not restore it on the strength of this comment being about a
 * deletion — there is still nothing that produces it.
 *
 * ⚠ THIS SWITCH IS EXHAUSTIVE OVER `CompanionOrderAuthority` ON PURPOSE.
 * `null` (never decided yet) is handled before the switch so the switch itself
 * only has to cover the authority union, and the `default` arm assigns to a
 * `never` rather than returning a fallback string — so a fifth authority added
 * to the union without a case here fails the BUILD instead of quietly reading
 * as "nothing yet".
 *
 * ⚠ `chat` IS LOCAL CHAT, AND SAYING "FLEET" HERE WOULD BE A LIE THE UI ONCE
 * TOLD. `makeFleetCompanionDeps` in `app/flow.ts` reads LOCAL deliberately —
 * the gateway's chat service hardcodes its channels to local and corp, so a
 * fleet room is never delivered, and `companionFlow.test.ts` pins that the
 * companion must ask local and nothing else. The operator accepted that trade
 * knowingly (docs/fleet-companion-handoff.md, "Fleet chat is not happening");
 * this used to be said on `COMPANION_ORDER_SOURCE_LABELS`, the settings
 * screen's own label for the channel, before that whole export went with the
 * checkboxes it named (docs/fleet-companion-simplification.md, "What it
 * listens to" — chat is always on now, nothing left to label). The word
 * "local" still has to survive here because a channel a player cannot toggle
 * off is exactly the one whose reach they most need named correctly.
 */
export function orderFromWords(value: CompanionOrderAuthority | null): string {
  if (value === null) {
    return "nothing yet";
  }
  switch (value) {
    case "broadcast":
      return "a fleet broadcast";
    case "tag":
      return "a target tag";
    case "chat":
      return "a local chat command";
    case "own-ladder":
      return "its own judgement";
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/**
 * HOW this pilot calls out a target: by writing a letter, or by broadcasting.
 *
 * ⚠ THIS USED TO REPORT A DEFICIENCY AND NOW REPORTS A METHOD, and the change
 * is a correction, not a softening. The old "no - not a fleet commander" was
 * accurate about the LETTER and left a false impression about the PILOT: a
 * plain member cannot write a fleet tag (fleetRuntime.js:1317 refuses one) but
 * can broadcast a `Target` call perfectly well (fleetRuntime.js:2521 gates on
 * membership alone), and rung 4 now does exactly that. A companion alt is a
 * plain member in every ordinary fleet and will never be promoted, so the old
 * wording described the normal case as a standing fault.
 *
 * ⚠ STILL THREE STATES, AND THE THIRD IS STILL THE POINT. "Not known" is an
 * unreadable roster. It must never flatten into either answer, because a pilot
 * that could not look is not a pilot that looked and found something.
 */
export function canTagWords(value: boolean | null): string {
  if (value === null) {
    return "not known";
  }
  return value ? "tags targets" : "broadcasts targets";
}

/** What a companion on the server says about itself, for the Companions window. */
export interface ServerCompanionFacts {
  readonly inFleet: boolean | null;
  readonly followingOrderFrom: CompanionOrderAuthority | null;
  readonly lastOrderHeard: string | null;
  readonly targetMode: "called" | "all" | null;
  /** False: this pilot's tag write would be dropped. Null: the roster has not been read. Never the same thing. */
  readonly canTag: boolean | null;
  readonly fitWarnings: readonly string[];
}

/**
 * A server run's facts off its readout. Every field fails to null, never to a confident value: a
 * field that cannot be read is one the row must report as not known, not "not in a fleet".
 */
export function serverCompanionFacts(bot: { readonly plugin?: { readonly readout?: unknown } | null }): ServerCompanionFacts | null {
  const row = bot.plugin?.readout;
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const facts = row as Record<string, unknown>;
  return {
    inFleet: typeof facts.inFleet === "boolean" ? facts.inFleet : null,
    followingOrderFrom: typeof facts.followingOrderFrom === "string" ? (facts.followingOrderFrom as CompanionOrderAuthority) : null,
    lastOrderHeard: typeof facts.lastOrderHeard === "string" ? facts.lastOrderHeard : null,
    targetMode: facts.targetMode === "called" || facts.targetMode === "all" ? facts.targetMode : null,
    canTag: typeof facts.canTag === "boolean" ? facts.canTag : null,
    fitWarnings: Array.isArray(facts.fitWarnings) ? facts.fitWarnings.filter((line): line is string => typeof line === "string") : [],
  };
}
