// Typed chat commands (fleet-companion phase 2 groundwork) — turning one
// fleet-chat line into a typed order this pilot can act on, or nothing.
//
// PURE PARSER ONLY. No store, no I/O, no wiring into `flow.ts` or the
// companion loop — that happens later, once this shape is settled. Mirrors
// `web/src/bridge/fleetBroadcasts.ts` in spirit: a small set of legal
// command kinds, a strict decoder that returns `null` rather than guess, and
// a companion predicate (there, freshness; here, who may command at all).
//
// ─── WHY A CHAT COMMAND, AND WHY IT LOOKS LIKE A BROADCAST ──────────────────
//
// `docs/fleet-companion-plan.md`'s precedence list puts chat commands below
// FC broadcasts and above this pilot's own ladder: a fleet-mate who is not
// the FC can still say "target this" in fleet chat and be obeyed, the same
// way `decideFleetOrders` (`web/src/nav/fleetCompanionLoop.ts`) already obeys
// a `Target` or `AlignTo` broadcast. So the command set below is not
// invented — it is restricted to the rungs `decideFleetOrders` genuinely has
// TODAY: `target`/`primary` (mirrors the `Target` broadcast, rung c),
// `align` (mirrors `AlignTo`, rung d), `travel` (mirrors `TravelTo`, rung e —
// the carried id is a solar SYSTEM id, not an on-grid object, same as the
// broadcast it mirrors) and `jump` (mirrors `JumpTo`, rung f — an honest
// partial: gets the ship to the named gate and holds, never fires the jump,
// exactly like the broadcast rung it mirrors).
//
// ⚠ THE HEAL FAMILY (`HealShield`/`HealArmor`/`HealCapacitor`/`HealTarget`,
// rung a) IS DELIBERATELY NOT A CHAT VERB HERE. `decideFleetOrders` keys the
// four apart by broadcast NAME alone — which remote-rep list it draws from is
// entirely determined by which of the four names it saw. A single chat verb
// ("heal", "rep") is ambiguous across all four, and any sub-verb grammar to
// disambiguate ("heal shield <link>" vs "heal armor <link>" vs plain "heal
// <link>" for the third-party case) is a genuinely new design decision this
// task's brief never specified — not a mirror of an existing rung's grammar
// the way `target`/`align`/`travel`/`jump` are. Guessing that grammar here
// risks exactly the failure mode this module exists to avoid: a chat command
// firing the WRONG repairer at the wrong ship. Left for the integrator to
// decide alongside the store wiring.
//
// The fleet-tag rung (b) is not a chat verb either, for an unrelated reason:
// it reads `obs.fleetTargetTags`, server-authoritative FLEET STATE pushed by
// `OnFleetStateChange`, never a chat line at all — there is nothing here to
// parse a verb for.
//
// `JumpBeacon`, `EnemySpotted`, `NeedBackup`, `HoldPosition`, `InPosition` and
// `Location` are the remaining broadcast names, and `decideFleetOrders` has NO
// rung at all for any of them (see `fleetBroadcasts.ts`'s
// `FLEET_BROADCAST_CLASSIFICATION`: they are `act: false`, announcements or
// server-driven, never something a follower acts on itemID for) — so none of
// them gets a chat verb either.
//
// ⚠ `warp` IS THE EXCEPTION THAT USED TO BE IN THAT LIST. It was excluded on
// the same reasoning, and the reasoning went stale: `WarpTo` was classified
// `act: false` "because the fleet warp is executed server-side once the
// broadcast lands", which is false — `sendBroadcast` (fleetRuntime.js) only
// notifies, and a companion told to warp sat still. `decideFleetOrders` grew
// rung e2 for it, so `warp <link>` now mirrors a rung that genuinely exists,
// exactly like the four verbs above it.
//
// ⚠ AND IT IS THE ONE VERB WHOSE LINK MAY NAME SOMETHING NOT ON THIS GRID. A
// warp is the only order in this set that is USEFUL at a distance — "come to
// me" is the whole point of asking for one — and the server has a call for
// precisely that: `CmdWarpToStuff("char", <characterID>)` resolves a FLEET
// MEMBER's position itself (`resolveFleetMemberWarpTarget`, beyonceService.js),
// requiring only that both pilots are in the same fleet and online. A character
// link carries a character id, an object link carries an object id, and this
// parser does not try to tell them apart: which one it is, is a question about
// the reader's own world (is that id on my grid? is it a fleet-mate?) and is
// answered where that world is known — see `decideFleetOrders`. Here it is one
// verb with one id, as every other link verb is.
//
// ─── THE LINK FORMAT DECIDES THE GRAMMAR ────────────────────────────────────
//
// See docs/fleet-companion-plan.md, "The chat link format, read out of the
// client" (search "showinfo"). Settled from the decompiled client
// (`chat/client/window.py:381`, `show_info/parse.py:22`), not guessed:
//
//   <url=showinfo:TYPEID//ITEMID>Display text</url>
//
// and — because other client surfaces (mail, notifications) emit it too, and
// being liberal about accepting it costs nothing — the anchor form as well:
//
//   <a href="showinfo:TYPEID//ITEMID">Display text</a>
//
// Two rules follow straight from the doc and shape every regex below:
//
// 1. LINKS CONTAIN SPACES (the display text is an object's name — station
//    and bookmark names routinely have them), so THIS PARSER NEVER
//    WHITESPACE-SPLITS THE WHOLE MESSAGE. It splits once on the verb — an
//    ANCHORED match at the start of the (trimmed) message, never a search
//    inside it, so an ordinary chat line that merely MENTIONS a verb ("did
//    you see the target that guy warped off with?") never fires a command —
//    and only then runs a tag regex over what is left.
//
// 2. The numeric id is AUTHORITATIVE. `TYPEID` is matched only to keep the
//    tag shape strict; it is never read back. `ITEMID` — the second number —
//    is the whole of what a command carries. Display text is matched with
//    `[^<]*` and thrown away unread, which is safe because `<`, `>` and `&`
//    inside it are always entity-escaped (`editPlainText.py:320`) and so can
//    never smuggle in a fake `</url>`/`</a>` close.
//
// A message is hard-truncated at 2048 chars with a trailing " ..."
// (`chat/client/util.py:51`), which CAN cut a link mid-tag. Both tag
// patterns below require their own closing tag, so a truncated tag simply
// fails to match — the message decodes to `null`, never to a guessed,
// possibly-wrong id built from a fragment.
//
// ─── `salvage` AND `loot`: THE FIRST VERBS WITH NO LINK AT ALL ─────────────
//
// ⚠ Every verb above names an OBJECT ("target this ship", "align to this
// structure") and the link is how that object is identified — no link, no
// object, no command. `salvage` and `loot` are different in kind, not just
// missing a link by accident: they name an AREA ("salvage the wrecks in
// vicinity", "loot the wrecks and containers in vicinity"), and there is
// nothing in a fleet-mate's chat line that could name a specific wreck or
// container even in principle — a wreck has no bookmark-able name a human
// would paste as a showinfo link the way a ship or gate does. The operator
// explicitly rejected a link-taking form of these two verbs. So
// `{ kind: "salvage" }` and `{ kind: "loot" }` carry no `itemID` at all —
// the first command kinds in this module that are a command in full on the
// verb alone, and `parseChatCommand` below branches to return them BEFORE
// the link-extraction loop runs, never through it. The existing "a verb
// matched but no usable link followed it -> null" rule stays exactly as it
// was for the four link verbs; it is not loosened or reused for these two,
// because these two never ask a link to follow them in the first place.
//
// The two verbs also have different REACH, on purpose, not by omission:
// salvaging any wreck is legal regardless of who owned it, but looting is
// ownership-gated — `isOwnWreck` (`web/src/nav/scriptMacros.ts:1715`) opens
// a wreck only when its owner reads back as this character or this
// corporation (a wreck whose owner cannot be read is never opened), while
// loot containers carry no ownership check at all. That gating lives in the
// script-macro layer this module does not import — recorded here only so a
// reader does not mistake `loot` and `salvage` for the same action under two
// names.
//
// TRAILING CHATTER, DECIDED: a bare `salvage` or `loot` is followed by
// whatever a human fleet-mate naturally types next — "salvage the wrecks in
// vicinity", "loot the wrecks and containers in vicinity" — and the task's
// own phrasing of what these commands mean IS a verb plus trailing words.
// Demanding an exact, nothing-else-follows match would make that natural
// phrasing fail to parse, which is worse than the alternative risk (some
// unrelated sentence that happens to start with the bare word "loot" or
// "salvage" firing a command it didn't mean). This also keeps the two verbs
// mechanically consistent with the four link verbs above, which already
// tolerate arbitrary trailing text before their link (e.g. "target that guy
// <link>" matches today — `extractShowInfoItemID` searches the remainder,
// it does not anchor to it). So: matched by the same anchored,
// word-bounded `^verb\b` pattern as every other verb, and ANYTHING may
// follow — trailing whitespace, trailing chatter, or nothing at all. Only
// the anchoring and word-boundary discipline (unchanged from the rest of
// this file) keeps "salvaged", "looting", "salvager" and a mid-sentence
// mention ("did you loot that wreck?") from matching.
//
// ─── `follow` AND `destination`: VERBS THAT CARRY A VALUE ───────────────────
//
// ⚠ A THIRD FAMILY, AND IT IS NOT EITHER OF THE FIRST TWO. The four link verbs
// carry an id they read out of a showinfo tag and are `null` without one; the
// two area verbs carry nothing at all and are complete on the verb alone.
// `follow <N> km` and `destination <link|id>` carry a NUMBER that is part of
// the order rather than a link that identifies an object — which the
// `AREA_COMMAND_VERBS` table cannot express, since every entry there returns a
// bare `{ kind }` with no room for a value, and which `COMMAND_VERBS` cannot
// express either, since every entry there is answered by the one shared
// link-extraction step. So they get their own table, `VALUE_COMMAND_VERBS`,
// whose entries carry a READER over the text after the verb instead of a kind.
// The anchoring discipline is identical (`^verb\b`), and the table is checked
// before the link-extraction loop for the same reason the area verbs are: a
// verb that never asks a link to follow it must not fall into the rule that
// returns `null` when none does.
//
// The two readers differ on what "nothing usable followed the verb" means, and
// the difference is a property of the orders, not an inconsistency:
//
//   • `follow` ALWAYS parses. Its value has a default, and every natural way a
//     human writes this order — "follow me", "follow the fc", a bare "follow" —
//     is the same order at the default range. There is nothing a `follow` could
//     be missing that would make it not an order.
//   • `destination` returns `null` without a system, exactly like the four link
//     verbs: "go somewhere" with no somewhere named is not a trip.
//
// ─── `targets called|all`: A MODE, NOT AN ORDER ─────────────────────────────
//
// ⚠ `targets` IS THE SECOND TOGGLE IN THE VOCABULARY, after `props on|off`, and
// it is parsed the same way: a value verb whose word is MANDATORY. It sets a
// companion's TARGET MODE:
//
//   • `called` (the default) -- shoot only what the fleet calls: a fleet tag, a
//     `Target` broadcast, a `target`/`primary` chat line.
//   • `all` -- free fire: kill every hostile by the kill order. Fleet tags still
//     shoot first; the mode only widens what is allowed AFTER them.
//
// It is a standing toggle rather than an order because nothing about it is done
// once or finishes: it is a preference about how the companion chooses targets,
// in force until somebody flips it back. That is also why both halves are
// required -- a commander who can only say "all" has no way back to "called"
// short of restarting the companion -- and why a bare `targets`, or one followed
// by any other word, is NOT a command: there is no obvious half of a toggle, and
// reading a bare mention as either half would flip the mode on a casual remark.
//
// ⚠ `stop` DOES NOT RESET IT, for the reason it does not reset `props`: `stop`
// cancels standing ORDERS (the follow, the trip, the area job) and halts the
// hull, and a mode is not an order. An FC who types `stop` to halt a trip has not
// said "and stop shooting the rats I told you were free", and a companion that
// quietly went back to `called` on every `stop` would make free fire impossible
// to keep while also steering the ship. Reset it the way it was set: `targets
// called`.
//
// ⚠ `targets` IS NOT `target`. The link verb's `^target\b` already refuses
// "targets" (no word boundary inside the word), so the two cannot collide; this
// verb's own pattern is `^targets\b`, and "target" with no `s` is not this verb.
//
// ⚠ `destination` ACCEPTS A BARE NUMBER AND `travel` DOES NOT. That is an
// ADDITION, not a mirror of the `travel` verb it otherwise matches: both carry
// a solar SYSTEM id rather than an on-grid object, but a system id is a number
// a player can read off the map and type, where an on-grid item id is not.
// Accepting it costs nothing (the same `parseItemID` bound runs over it) and
// spares an operator pasting a link for the one order they are most likely to
// be typing from a route plan. `travel` is left alone rather than widened to
// match, because nothing asked for it and every change to a verb that is
// already obeyed is a chance to change what it obeys.

import type { ChatMessage } from "../store/types.ts";
// ⚠ Not `../bridge/chat.ts`, even though that is the module that PRODUCES a
// `ChatMessage` (`decodeMessageEntry` et al.) and the one this task's brief
// names — `ChatMessage` itself is DECLARED in `store/types.ts` and only
// imported, re-used, by `chat.ts`. Importing the type from its actual home
// avoids a needless dependency on the whole decoder module for a type that
// module does not own.

/** The chat-command kinds this parser recognises. */
export type ChatCommandKind =
  | "target"
  | "align"
  | "travel"
  | "jump"
  | "salvage"
  | "loot"
  | "stop"
  | "follow"
  | "destination"
  | "warp"
  | "props"
  | "targets"
  | "flight"
  | "status"
  | "repair";

/**
 * Which pilots a `status` or `repair` line is addressed to.
 *
 * ⚠ NAMES AND LINKS BOTH, BECAUSE A COMMANDER WRITES EITHER. Dragging a pilot
 * into chat makes a showinfo link that carries the character id, and that id is
 * the reliable half; typing the name is the quick half, and is matched as a
 * whole word against what is left once the links are taken out. Nothing here
 * knows the fleet's names, so the parser keeps both and `selectsPilot` asks each
 * pilot whether it is one of them.
 *
 * ⚠ A LINE THAT NAMES NOBODY WE KNOW IS NOBODY, NEVER EVERYONE. Only an empty
 * remainder (or `all` / `everyone` / `everybody`) addresses the whole fleet. So a
 * misspelt name sends no ship to a station, which is the safe way to be wrong
 * for an order that spends ISK and leaves the fight.
 */
export interface PilotSelector {
  /** True when the line named nobody, or said `all`: every pilot answers. */
  readonly everyone: boolean;
  /** Character ids read out of showinfo links after the verb. */
  readonly characterIDs: readonly number[];
  /** The rest of the line with the links removed, entities decoded, lower-cased. */
  readonly text: string;
}

/**
 * One parsed chat command. The four link verbs carry exactly the resolved
 * numeric item id the `decideFleetOrders` rung each mirrors expects — never
 * a name, never the raw link — so a caller can hand `itemID` straight to the
 * same rung logic that already handles the broadcast it mirrors.
 *
 * `salvage` and `loot` carry no `itemID` — see this file's header, "the
 * first verbs with no link at all". They name an area ("the wrecks in
 * vicinity"), not an object, so there is nothing for a link to identify and
 * nothing for a caller to read off the command beyond which of the two it
 * was.
 *
 * `follow` and `destination` carry a VALUE rather than an object — see the
 * header's third section. The field names say which: `rangeM` is a stand-off
 * distance in METRES (already defaulted and already clamped — a caller never
 * has to re-check it), `systemID` is a solar system, never an on-grid object.
 */
export type ChatCommand =
  | { readonly kind: "target"; readonly itemID: number }
  | { readonly kind: "align"; readonly itemID: number }
  | { readonly kind: "travel"; readonly itemID: number }
  | { readonly kind: "jump"; readonly itemID: number }
  /**
   * `warp <link>`. The id is whatever the link named — an object on the grid,
   * or a CHARACTER, which a reader that can see its own fleet turns into the
   * server's own fleet-member warp. See the header's note on this verb.
   */
  | { readonly kind: "warp"; readonly itemID: number }
  | { readonly kind: "salvage" }
  | { readonly kind: "loot" }
  | { readonly kind: "stop" }
  | { readonly kind: "follow"; readonly rangeM: number }
  | { readonly kind: "destination"; readonly systemID: number }
  /**
   * `props on` / `props off` — run the fitted afterburner/MWD, or stand it down.
   *
   * ⚠ THE ONLY VERB HERE THAT IS A TOGGLE RATHER THAN AN ORDER, which is why it
   * carries a boolean instead of an id or a range. Every other command names a
   * thing to do once (`target`, `jump`) or a behaviour with a value attached
   * (`follow 10km`); this one flips a standing preference that the pilot would
   * otherwise decide for itself from whether it is travelling. Both halves are
   * therefore REQUIRED: an FC who can only say "on" has no way back to the
   * automatic behaviour except by restarting the companion, which is the same
   * gap `follow` closed by doubling as its own resume.
   *
   * ⚠ AND "OFF" IS NOT "STOP". `stop` cancels standing ORDERS (it suspends the
   * follow, clears the trip); `props off` says nothing about any of them. They
   * are kept apart deliberately — folding propulsion into `stop` would mean a
   * commander could not halt a trip without also stripping the speed off a ship
   * that may need it to get out.
   */
  | { readonly kind: "props"; readonly on: boolean }
  /**
   * `targets called` / `targets all` -- the companion's target mode. A standing
   * toggle like `props`, not an order, and `stop` does not reset it. See the
   * header's "a mode, not an order".
   */
  | { readonly kind: "targets"; readonly mode: "called" | "all" }
  /**
   * `flight follow` / `flight auto` -- the companion's flight mode. A standing
   * toggle like `targets`, not an order, and `stop` does not reset it. See the
   * table entry's section comment.
   */
  | { readonly kind: "flight"; readonly mode: "follow" | "auto" }
  /**
   * `status [pilots]` -- each named pilot (every pilot when none is named) says
   * in chat how much ammunition and how many drones it has left. A question, not
   * an order: it moves nothing and `stop` has nothing to cancel.
   */
  | { readonly kind: "status"; readonly who: PilotSelector }
  /**
   * `repair [pilots]` -- each named pilot (every pilot when none is named) docks
   * in this system, pays the station to repair the ship and comes back to the
   * fleet commander.
   */
  | { readonly kind: "repair"; readonly who: PilotSelector };

/**
 * Verb -> command kind, each with its own anchored, case-insensitive
 * pattern. `target` and `primary` are aliases for the SAME kind — both mean
 * "engage this ship", matching this task's own "target / primary -> engage
 * that ship" and `decideFleetOrders` rung c, which answers to a single
 * `Target` broadcast name regardless of which word a human fleet-mate
 * reaches for.
 *
 * Each pattern is anchored (`^`) and word-bounded (`\b`) so "targeting" or
 * "targets" never matches the `target` verb, and matches only at the very
 * START of the trimmed message — see the header above for why a search
 * anywhere in the message would be wrong.
 */
const COMMAND_VERBS: ReadonlyArray<{
  readonly verb: string;
  readonly pattern: RegExp;
  // ⚠ THE FOUR LINK KINDS, NOT `ChatCommandKind`. This used to be the whole
  // union and only compiled by accident: every other kind then carried NO
  // fields besides `kind`, so `{ kind, itemID }` was assignable to each of them
  // with `itemID` as a harmless extra. The value verbs ended that -- a
  // `{ kind: "follow", itemID }` is missing `rangeM` and the build said so --
  // which is the tripwire working. Naming the four kinds this table actually
  // holds is both the fix and what the table always meant, and it matches how
  // `AREA_COMMAND_VERBS` below has always been typed.
  readonly kind: "target" | "align" | "travel" | "jump" | "warp";
}> = [
  { verb: "target", pattern: /^target\b/i, kind: "target" },
  { verb: "primary", pattern: /^primary\b/i, kind: "target" },
  { verb: "align", pattern: /^align\b/i, kind: "align" },
  { verb: "travel", pattern: /^travel\b/i, kind: "travel" },
  { verb: "jump", pattern: /^jump\b/i, kind: "jump" },
  // ⚠ `warp` MUST NOT MATCH "warping" OR A MID-SENTENCE MENTION, and the `\b`
  // it shares with every other verb here is what stops it. "warp to me" is the
  // phrase a fleet actually types, and it parses: the verb matches, the link
  // that follows is the whole of what is read, and the trailing words are
  // ignored the same way they are for every link verb.
  { verb: "warp", pattern: /^warp\b/i, kind: "warp" },
];

/**
 * `salvage` and `loot` — the area verbs, checked separately from
 * `COMMAND_VERBS` above because they never look for a link at all (see this
 * file's header). Same anchoring and word-boundary discipline as every
 * other verb (`^verb\b`), so "salvaged", "looting" and "salvager" do not
 * match and a mid-sentence mention never fires — but unlike the four link
 * verbs, whatever follows the verb (nothing, whitespace, or trailing
 * chatter) is irrelevant: the verb alone IS the whole command.
 */
const AREA_COMMAND_VERBS: ReadonlyArray<{
  readonly verb: string;
  readonly pattern: RegExp;
  readonly kind: "salvage" | "loot" | "stop";
}> = [
  { verb: "salvage", pattern: /^salvage\b/i, kind: "salvage" },
  { verb: "loot", pattern: /^loot\b/i, kind: "loot" },
  // ⚠ `stop` CANCELS EVERY STANDING ORDER THIS PARSER CAN PRODUCE, AND HALTS
  // THE SHIP. `salvage`, `loot`, `follow` and `destination` all LATCH -- they
  // are jobs and standing behaviours that run until they are done, not instants
  // -- so there has to be one word that calls them all off. It was smaller than
  // this once: it cancelled the area job alone, and the comment here said in so
  // many words that it did not stop the ship. That stopped being true when
  // `destination` and the standing `follow` arrived, because both leave the hull
  // MOVING, and an operator who types "stop" at a companion flying a route means
  // the ship, not a bookkeeping flag. The operator's own words for this order
  // are "it stops where it is".
  //
  // It still does NOT stop the bot, and it still has no effect on a broadcast or
  // a target call: those carry their own freshness and their own authority, and
  // a companion that went deaf to its fleet because somebody typed one word
  // would be a worse pilot than one that kept flying. Anchored and word-bounded
  // like the rest, so "stopped" never fires it.
  //
  // What `stop` MEANS to each latch lives in `fleetCompanionLoop.ts`; this table
  // only says the word was typed.
  { verb: "stop", pattern: /^stop\b/i, kind: "stop" },
];

/**
 * The default `follow` stand-off, in metres, used by a bare `follow` and by
 * any `follow` whose trailing text is not a distance.
 *
 * ⚠ DELIBERATELY THE SAME NUMBER AS `FLEET_MATE_ESCORT_RANGE_M`
 * (`web/src/nav/scriptMacros.ts`), AND DELIBERATELY NOT THE SAME CONSTANT. That
 * one's comment carries the reasoning for the value and it holds here unchanged:
 * close enough to stay on the anchor's grid interaction -- inside a web or
 * scram's own reach, should either carry one -- without literally sitting on top
 * of them. What does NOT follow is a dependency. This module is a standalone
 * parser whose only import is a type (see the header), on purpose, and reaching
 * into the DSL's macro file for a number would couple the chat grammar to the
 * block editor it exists not to be part of. Two constants, one reason; if either
 * value ever moves it is a separate decision made with its own reason.
 *
 * Exported because the companion ladder needs a starting value for the range it
 * latches, before anybody has typed `follow` at all.
 */
export const COMPANION_FOLLOW_RANGE_M = 2000;

/**
 * The band a `follow` distance is clamped into.
 *
 * ⚠ CLAMPED, NEVER REJECTED, and the difference matters. A distance outside the
 * band is an UNAMBIGUOUS ORDER with a wrong magnitude -- "follow 100000 km" is
 * still somebody saying "follow", who meant kilometres and a smaller number --
 * so the order stands and only the number is corrected. Rejecting it would drop
 * an order that was perfectly clear; returning `null` would make a typo silently
 * un-follow a companion that was already following.
 *
 * The floor is 500 m because a stand-off tighter than that is an orbit in all
 * but name: the ship ends up bumping the anchor it is trying to hold station
 * off, which is what `keepAtRange` exists to avoid. The ceiling is 250 km
 * because past that a hold-at-range order stops describing anything a fleet
 * flies -- it is already far outside the grid a fight happens on -- and because
 * a typo'd unit ("follow 100000 km") must not be able to become a real order.
 */
const FOLLOW_RANGE_FLOOR_M = 500;
const FOLLOW_RANGE_CEILING_M = 250_000;

/**
 * A `follow` distance: digits, an optional decimal part, and an optional unit,
 * with NOTHING else after it.
 *
 * ⚠ ANCHORED AT BOTH ENDS ON PURPOSE. A pattern that matched a leading number
 * and ignored the rest would read "follow 10 km behind the fc and stay there" as
 * 10 km and "follow 2 of us" as 2 km -- confidently, from a sentence that was
 * never a distance. Demanding that the distance be the WHOLE of what follows the
 * verb means anything else falls to the default, which is the right answer for
 * every such line: they are all still "follow".
 *
 * ⚠ THE LONGER UNIT SPELLINGS COME FIRST IN THE ALTERNATION, because `m` would
 * otherwise match the first letter of "metres" and then fail the end anchor,
 * throwing away a distance that was written out in full.
 */
const FOLLOW_DISTANCE = /^(\d+(?:\.\d+)?)\s*(kilometres?|kilometers?|km|metres?|meters?|m)?$/i;

/** A `follow` distance held inside the band above. */
function clampFollowRange(metres: number): number {
  return Math.min(FOLLOW_RANGE_CEILING_M, Math.max(FOLLOW_RANGE_FLOOR_M, metres));
}

/**
 * The stand-off a `follow` line asks for, in whole metres.
 *
 * ⚠ A BARE NUMBER IS KILOMETRES, AND THAT IS A JUDGMENT CALL RATHER THAN A
 * DERIVATION. Nothing in the game or in this codebase says what unit an
 * undecorated number in chat means. It is read as km because the order the
 * operator asked for is written `follow <N> km`, because a player typing a
 * follow distance in a hurry types "follow 10" and means ten kilometres, and
 * because the alternative reading -- ten metres -- clamps to the floor and gives
 * them a companion glued to the anchor, which is the worse of the two ways to
 * be wrong.
 *
 * ⚠ NEVER `null`. Every return here is a real distance: an unparsable trailing
 * phrase ("follow me", "follow the fc") is not a broken order, it is the SAME
 * order said in English, and a `follow` that decoded to nothing would leave a
 * companion standing still while somebody with authority told it to come along.
 *
 * An absurd digit run (`follow 9999...9 km`) reads back as `Infinity` rather
 * than as `NaN` -- the regex guarantees digits -- and the clamp turns that into
 * the ceiling, which is the same answer any other over-large number gets.
 */
function followRangeFrom(remainder: string): number {
  const trimmed = remainder.trim();
  const match = trimmed.length === 0 ? null : FOLLOW_DISTANCE.exec(trimmed);
  const digits = match?.[1];
  if (digits === undefined) {
    return COMPANION_FOLLOW_RANGE_M;
  }
  const unit = (match?.[2] ?? "").toLowerCase();
  // Every metre spelling starts with "m" and no kilometre spelling does, so one
  // test covers both lists -- and the empty unit (a bare number) falls to the
  // kilometre branch, which is the decision above.
  const metres = unit.startsWith("m") ? Number(digits) : Number(digits) * 1000;
  return clampFollowRange(Math.round(metres));
}

/**
 * The solar system a `destination` line names: a showinfo link's id, or a bare
 * number, or `null`.
 *
 * The link branch is `travel`'s own, unchanged -- the same tag shapes, the same
 * `parseItemID` bound. The bare-number branch is the addition (see the header),
 * and it is run through that same bound rather than trusted: the digits are
 * player-typed chat text either way.
 *
 * ⚠ THE BARE NUMBER MUST BE THE WHOLE REMAINDER. "destination 30000142" is an
 * order; "destination 3 jumps out" is a sentence, and reading a system id out of
 * its first number would send a companion somewhere nobody named.
 */
function destinationSystemFrom(remainder: string): number | null {
  const linked = extractShowInfoItemID(remainder);
  if (linked !== null) {
    return linked;
  }
  const bare = /^\s*(\d+)\s*$/.exec(remainder);
  const digits = bare?.[1];
  return digits === undefined ? null : parseItemID(digits);
}

/**
 * `follow` and `destination` — the verbs that carry a VALUE. See this file's
 * header, "verbs that carry a value", for why neither of the two tables above
 * could hold them.
 *
 * Each entry carries a READER over the text after the verb instead of a bare
 * kind, which is the whole of the difference: the reader decides both what the
 * value is and whether the line is an order at all. Same anchored,
 * word-bounded `^verb\b` discipline as every other verb, so "following" and a
 * mid-sentence "follow" never fire one.
 */
const VALUE_COMMAND_VERBS: ReadonlyArray<{
  readonly verb: string;
  readonly pattern: RegExp;
  readonly read: (remainder: string) => ChatCommand | null;
}> = [
  {
    verb: "follow",
    pattern: /^follow\b/i,
    read: (remainder) => ({ kind: "follow", rangeM: followRangeFrom(remainder) }),
  },
  {
    verb: "destination",
    pattern: /^destination\b/i,
    read: (remainder) => {
      const systemID = destinationSystemFrom(remainder);
      return systemID === null ? null : { kind: "destination", systemID };
    },
  },
  {
    // ⚠ `props` AND `prop` BOTH, because a commander typing at combat speed
    // writes either and the two cannot mean different things. `\b` after the
    // optional `s` keeps the anchor honest: "proposal" and "propulsion" are not
    // this verb.
    verb: "props",
    pattern: /^props?\b/i,
    // ⚠ THE VALUE IS MANDATORY AND HAS NO DEFAULT. A bare "props" is not an
    // order, and reading it as "on" would let the single most common thing a
    // human types about their prop mod — mentioning it — light one. Same rule
    // `destination` follows for a remainder that is not a system: no value, no
    // command, `null` rather than a guess.
    //
    // ⚠ `follow`'s DEFAULTING IS NOT THE PRECEDENT IT LOOKS LIKE. A bare
    // "follow" is a complete order with an obvious range; a bare "props" is an
    // incomplete one, because there is no obvious half of a toggle.
    read: (remainder) => {
      const said = /^\s*(on|off)\s*$/i.exec(remainder);
      const word = said?.[1];
      return word === undefined ? null : { kind: "props", on: word.toLowerCase() === "on" };
    },
  },
  {
    // ⚠ `targets`, PLURAL ONLY. `\b` after the `s` keeps "targeting" and
    // "targetsss" out, and the link verb's `^target\b` already refuses
    // "targets", so the two never both match one line.
    verb: "targets",
    pattern: /^targets\b/i,
    // ⚠ BOTH WORDS ARE MANDATORY AND NOTHING MAY FOLLOW THEM, exactly as for
    // `props`: no default half of a toggle, and trailing chatter ("targets all
    // please") is a sentence, not a mode switch. See the header.
    read: (remainder) => {
      const said = /^\s*(called|all)\s*$/i.exec(remainder);
      const word = said?.[1];
      return word === undefined
        ? null
        : { kind: "targets", mode: word.toLowerCase() === "all" ? "all" : "called" };
    },
  },
  // ─── `flight follow|auto`: A MODE, NOT AN ORDER ───────────────────────────
  //
  // ⚠ `flight` IS THE THIRD TOGGLE IN THE VOCABULARY, after `props on|off` and
  // `targets called|all`, and it is parsed the same way: a value verb whose word
  // is MANDATORY. It sets the companion's FLIGHT MODE:
  //
  //   • `follow` (the default) -- the fleet commander leads the flight and the
  //     companion holds station on them.
  //   • `auto` -- the companion flies itself into weapon range of its target
  //     while it fights.
  //
  // It is a standing mode like `targets`, not a one-off order, for the same
  // reason: it is a preference about how the companion flies, in force until
  // somebody flips it back. Both halves are required, and a bare `flight`, or
  // one followed by any other word, is NOT a command.
  //
  // ⚠ `flight` IS NOT `follow`. The two cannot collide: `^follow\b` does not
  // match a line that starts with "flight", and `^flight\b` does not match a
  // line that starts with "follow". A line starting with `follow` still parses
  // as the escort order, and `flight follow` is this mode, not that order.
  {
    verb: "flight",
    pattern: /^flight\b/i,
    // ⚠ BOTH WORDS ARE MANDATORY AND NOTHING MAY FOLLOW THEM, exactly as for
    // `targets`: no default half of a mode, and trailing chatter is a sentence.
    read: (remainder) => {
      const said = /^\s*(follow|auto)\s*$/i.exec(remainder);
      const word = said?.[1];
      return word === undefined
        ? null
        : { kind: "flight", mode: word.toLowerCase() === "auto" ? "auto" : "follow" };
    },
  },
  // ─── `status` and `repair`: VERBS ADDRESSED TO PILOTS ─────────────────────
  //
  // ⚠ THEIR VALUE IS WHO, NOT HOW MUCH. Both always parse -- a bare verb is the
  // whole fleet -- and what follows the verb only narrows which pilots answer.
  // See `PilotSelector` for why a line naming nobody we know reaches nobody.
  // `^status\b` and `^repair\b` keep "statuses", "repairs" and "repaired" out.
  {
    verb: "status",
    pattern: /^status\b/i,
    read: (remainder) => ({ kind: "status", who: pilotSelectorFrom(remainder) }),
  },
  {
    verb: "repair",
    pattern: /^repair\b/i,
    read: (remainder) => ({ kind: "repair", who: pilotSelectorFrom(remainder) }),
  },
];

/** Every showinfo link in a line, either tag form, for stripping and reading ids. */
const SHOWINFO_LINKS =
  /<url=showinfo:\d+\/\/(\d+)>[^<]*<\/url>|<a href="showinfo:\d+\/\/(\d+)">[^<]*<\/a>/g;

/** The entities the chat client escapes in message text, decoded for name matching. */
function decodeChatEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Who the text after a `status` or `repair` verb names. See `PilotSelector`. */
function pilotSelectorFrom(remainder: string): PilotSelector {
  const characterIDs: number[] = [];
  for (const match of remainder.matchAll(SHOWINFO_LINKS)) {
    const digits = match[1] ?? match[2];
    const id = digits === undefined ? null : parseItemID(digits);
    if (id !== null && !characterIDs.includes(id)) {
      characterIDs.push(id);
    }
  }
  // Punctuation at the ends is not part of anybody's name: "status?" and
  // "repair, Test Two!" are the same lines without it.
  const text = decodeChatEntities(remainder.replace(SHOWINFO_LINKS, " "))
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const everyone = characterIDs.length === 0 && (text === "" || /^(all|everyone|everybody)$/.test(text));
  return { everyone, characterIDs, text };
}

/**
 * Whether the pilot `characterID` / `characterName` is one a `status` or `repair`
 * line addressed.
 *
 * A typed name counts only as a WHOLE WORD of the line, case-insensitively, so
 * "Test" does not answer for "Test Two" and "Al" does not answer for "all". A
 * pilot whose own name could not be read answers only to a link or to everyone.
 */
export function selectsPilot(
  who: PilotSelector,
  characterID: number | null,
  characterName: string | null,
): boolean {
  if (who.everyone) {
    return true;
  }
  if (characterID !== null && who.characterIDs.includes(characterID)) {
    return true;
  }
  const name = characterName?.trim().toLowerCase() ?? "";
  if (name === "") {
    return false;
  }
  const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);
  for (let at = who.text.indexOf(name); at !== -1; at = who.text.indexOf(name, at + 1)) {
    if (!isWordChar(who.text[at - 1]) && !isWordChar(who.text[at + name.length])) {
      return true;
    }
  }
  return false;
}

/**
 * One row of the human-facing command help: what to type, and what it does.
 *
 * ⚠ HAND-WRITTEN, NOT DERIVED FROM THE VERB TABLES, because a verb table knows
 * a pattern and not the syntax a human types after it (a link, a range, a
 * word). The test beside this file ties the two together instead: every
 * `ChatCommandKind` must show up in some row, so a new kind without help fails
 * there. `does` is one short plain-ASCII line.
 */
export const CHAT_COMMAND_HELP: readonly { readonly usage: string; readonly does: string }[] =
  Object.freeze([
    // Orders on an object.
    { usage: "target|primary <link>", does: "Shoot this ship first" },
    { usage: "align <link>", does: "Align toward this object" },
    { usage: "warp <link>", does: "Warp to this object or fleet member" },
    // Trips.
    { usage: "travel <link>", does: "Fly to this solar system" },
    { usage: "destination <link|id>", does: "Set the route to this system" },
    { usage: "jump <link>", does: "Go to this gate and hold" },
    // Standing behaviours with a value.
    { usage: "follow [range]", does: "Escort the FC; range in km, default 2 km" },
    // Area jobs.
    { usage: "salvage", does: "Salvage the wrecks in vicinity" },
    { usage: "loot", does: "Loot your wrecks and containers in vicinity" },
    // Toggles.
    { usage: "props on|off", does: "Run the afterburner or MWD, or stand it down" },
    { usage: "targets called|all", does: "Shoot only called targets, or free fire" },
    { usage: "flight follow|auto", does: "Hold station on the FC, or fly into range by itself" },
    // Addressed to pilots: none named is everyone.
    { usage: "status [names]", does: "Say ammo and drones left in local" },
    { usage: "repair [names]", does: "Dock in this system, repair, come back to the FC" },
    // Cancel.
    { usage: "stop", does: "Cancel orders, a repair trip included, and halt the ship" },
  ]);

/**
 * The chat verbs this parser recognises (`target`/`primary` alias to the
 * same kind; `salvage`/`loot`/`stop` are the link-free area verbs and
 * `follow`/`destination` the value verbs — see this file's header).
 *
 * Assembled from the three tables rather than written out, so a verb can only
 * be missing from this list by being missing from the parser too.
 */
export const CHAT_COMMAND_VERBS: readonly string[] = Object.freeze([
  ...COMMAND_VERBS.map((c) => c.verb),
  ...AREA_COMMAND_VERBS.map((c) => c.verb),
  ...VALUE_COMMAND_VERBS.map((c) => c.verb),
]);

/**
 * Both legal showinfo tag forms in one alternation, so "the first tag in the
 * remainder" is well-defined regardless of which form a client surface
 * happened to emit. Capture group 1 is the `url=` form's ITEMID, group 2 the
 * anchor form's — exactly one is ever set on a match. TYPEID is matched with
 * a plain `\d+` and deliberately not captured: this module never reads it.
 *
 * Display text is `[^<]*` — safe because `<`/`>`/`&` are always
 * entity-escaped inside it, so it can never contain a literal `<` that would
 * let it swallow past its own closing tag.
 */
const SHOWINFO_LINK =
  /<url=showinfo:\d+\/\/(\d+)>[^<]*<\/url>|<a href="showinfo:\d+\/\/(\d+)">[^<]*<\/a>/;

/**
 * A positive game item id out of a regex capture that is already known to be
 * all ASCII digits. Still bounded against `Number.MAX_SAFE_INTEGER` via
 * `BigInt` rather than trusted outright — the digits come from player-typed
 * (or pasted) chat TEXT, not from a server-normalized field, so an absurdly
 * long digit run is exactly the kind of input this must not silently coerce
 * into the wrong number.
 */
function parseItemID(digits: string): number | null {
  const value = BigInt(digits);
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

/** The first showinfo link's ITEMID in `text`, or `null` if none parses cleanly. */
function extractShowInfoItemID(text: string): number | null {
  const match = SHOWINFO_LINK.exec(text);
  if (match === null) {
    return null;
  }
  const digits = match[1] ?? match[2];
  return digits === undefined ? null : parseItemID(digits);
}

/**
 * Parse one fleet-chat line into a typed command, or `null` for anything
 * that is not confidently one of the recognised verbs with a well-formed
 * link attached.
 *
 * Deliberately returns `null`, never a best guess, for: an unrecognised
 * verb, a recognised verb with no link at all, a link that does not parse
 * (including one truncated mid-tag by the 2048-char message cap), or an
 * item id out of the safe-integer range. A wrong target is far worse than no
 * target — see this module's own header.
 *
 * Takes the whole `ChatMessage` (rather than just its `.message` text) so a
 * caller wiring this in later never has to juggle two different values for
 * "the chat line" — the same reason `isChatCommandSenderAllowed` below also
 * takes the whole message.
 *
 * Checks the area verbs (`salvage`, `loot`, `stop`) and then the value verbs
 * (`follow`, `destination`) FIRST, returning straight away on a match and
 * deliberately before the link-extraction loop below ever runs — none of those
 * five verbs enters it, so the "matched but no usable link followed" -> `null`
 * rule further down cannot apply to them and is not being loosened to
 * accommodate them. See this file's header.
 *
 * ⚠ A VALUE VERB MAY STILL DECODE TO `null`, AND THAT IS ITS OWN READER'S
 * ANSWER, not this loop's rule leaking into it. `destination` with nothing
 * usable after it is not an order, the same way `travel` with no link is not;
 * `follow` has no such case at all and always decodes. The two readers state
 * their own reasons.
 */
export function parseChatCommand(message: ChatMessage): ChatCommand | null {
  const trimmed = message.message.trim();
  for (const { pattern, kind } of AREA_COMMAND_VERBS) {
    if (pattern.test(trimmed)) {
      return { kind };
    }
  }
  for (const { pattern, read } of VALUE_COMMAND_VERBS) {
    const verbMatch = pattern.exec(trimmed);
    if (verbMatch !== null) {
      return read(trimmed.slice(verbMatch[0].length));
    }
  }
  for (const { pattern, kind } of COMMAND_VERBS) {
    const verbMatch = pattern.exec(trimmed);
    if (verbMatch === null) {
      continue;
    }
    const remainder = trimmed.slice(verbMatch[0].length);
    const itemID = extractShowInfoItemID(remainder);
    if (itemID === null) {
      // This verb matched but no usable link followed it (missing, malformed,
      // or truncated mid-tag) — no command, never a guess.
      return null;
    }
    return { kind, itemID };
  }
  return null;
}

/**
 * Whether `message`'s sender may issue fleet-chat commands, gated on
 * `characterID` ALONE.
 *
 * That field is the one part of a chat entry a player cannot spoof: the chat
 * backend fills it in server-side from the authenticated session
 * (`chatRuntime.js:87` — `session.characterID || session.charid ||
 * session.userid`), never from anything in the message TEXT, so no amount of
 * crafting the message body changes who it is attributed to — which is the
 * entire basis for gating on it at all. Gating on `characterName` instead
 * would be gating on display text a player can rename at will, worthless as
 * an allowlist key.
 *
 * `chatCommandSenders` mirrors `FleetCompanionRequest.chatCommandSenders`
 * (`web/src/nav/fleetCompanionLoop.ts`) — an operator-controlled allowlist,
 * never populated from chat text itself. Taken by shape here rather than by
 * importing that type, so this module stays a standalone parser with no
 * dependency on the loop that will eventually consume it.
 *
 * An empty list allows nobody. That is
 * `DEFAULT_FLEET_COMPANION_REQUEST.chatCommandSenders`'s own default: a
 * companion nobody has explicitly authorized obeys no one over chat.
 */
export function isChatCommandSenderAllowed(
  message: ChatMessage,
  chatCommandSenders: readonly number[],
): boolean {
  return chatCommandSenders.includes(message.characterID);
}
