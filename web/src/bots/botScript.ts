// The Bot Builder document — the shape a player-authored bot is SAVED, IMPORTED
// and EXPORTED in, plus the pure structural helpers that read it.
//
// ⚠ THIS FILE IS THE FORMAT AND NOTHING ELSE. It holds no player-facing strings
// (those live in scriptText.ts, one R9a register), issues no calls, and decides
// nothing (the runner's decide function does that). It is the single source of
// truth for what a valid document can CONTAIN — the codec validates against these
// types and these bounds, the editor builds them, the runner reads them.
//
// ─── WHY THE SHAPE IS WHAT IT IS ─────────────────────────────────────────────
//
// The design (docs/bot-builder-brainstorm.md) settled a Human-Resource-Machine
// program: an ordered list of INTERRUPTS checked every tick, above an ordered
// list of STEPS run top to bottom. Two safety properties are STRUCTURAL here —
// unrepresentable rather than validated — so no import can strip them:
//
//   • A CYCLE IS UNDRAWABLE. Order is an array index and a step has no outgoing
//     edge, so the only backward edge in the whole format is a loop block
//     re-entering its own body, counted against `repeat`. There is nowhere to
//     express "jump to step 2".
//   • TWO CALLS IN ONE TICK IS UNREPRESENTABLE. A step names exactly one macro;
//     a macro decides exactly one action. The format cannot ask for two.
//
// And the pieces the operator's decisions pinned (see the doc's "Operator
// decisions"): a loop repeats a bounded count OR forever (decision 1); a belt is
// a runtime "nearest" binding or a chosen one (decision 2); decision 3 (a
// non-deletable, auto-injected safety-floor watch) was REVERSED on 2026-07-23 —
// watches are entirely the player's now, and the codec no longer injects one
// (docs/bot-builder-progress.md:148); a hostile interrupt lets the player pick
// drones-or-run (decision 5).

// ─── Format identity ─────────────────────────────────────────────────────────

/** The tag every document carries; the first thing the codec checks. */
export const SCRIPT_FORMAT = "evejs-bot-script" as const;

/**
 * The format version. A lone integer so a NEWER file is detectable and refused
 * before anything else is read (a document from a newer app may contain shapes
 * this one cannot validate). Older files migrate on read; saves re-write this.
 */
export const SCRIPT_VERSION = 1 as const;

// ─── Shared bounds ───────────────────────────────────────────────────────────
//
// ⚠ ONE SOURCE OF TRUTH FOR EVERY LIMIT. The codec clamps to these, the editor
// offers these, the runner trusts these. A range that lived in two places would
// let an import store a value the editor could never produce.

/** A loop's bounded count runs 1..500; above it a player wants "forever" instead. */
export const MIN_REPEAT_TIMES = 1;
export const MAX_REPEAT_TIMES = 500;

/**
 * The ore-hold "nearly full" ceiling. 0.9 is load-bearing: the mining bot never
 * asks "does one more unit fit" (mixed-hold average-volume trap), it hauls at a
 * fraction with headroom to spare — so a player cannot ask for 100% and reopen
 * that bug.
 */
export const MAX_ORE_HOLD_FRACTION = 0.9;

/** Health/shield thresholds run 0.05..0.95 — never 0 (an interrupt that can never fire). */
export const MIN_CONDITION_FRACTION = 0.05;
export const MAX_CONDITION_FRACTION = 0.95;

/** Structural size caps — the shape of the document, independent of byte length. */
export const MAX_PROGRAM_NODES = 32;
export const MAX_TOTAL_STEPS = 64;
export const MAX_INTERRUPTS = 8;
export const MAX_NAME_LEN = 60;
export const MAX_NOTES_LEN = 2000;

/**
 * Raw-byte ceiling, checked BEFORE JSON.parse so a hostile 10 MB file never
 * reaches the parser. One number under the BFF's 64 KB express.json limit.
 */
export const MAX_DOC_BYTES = 49152;

// ─── World references ────────────────────────────────────────────────────────

/** Which kind of world thing a slot points at. */
export type WorldEntity = "station" | "structure" | "belt" | "agent" | "system";

/**
 * A reference to a place in the world.
 *
 * ⚠ THE ID IS A HINT, NEVER TRUSTED. It makes a same-world re-import exact, but
 * an imported document lands on another character's world where the same number
 * may name a different thing — so on import every ref is UNBOUND until the id
 * resolves to the stored `name` for this character's world. `name`/`systemName`
 * are display hints only; once bound the screen re-resolves through names.ts, so
 * a number never reaches a player (R7d). A null id is an unbound slot on purpose
 * (templates, cross-world imports) and blocks the start until the player picks.
 */
export interface WorldRef {
  readonly entity: WorldEntity;
  readonly id: number | null;
  readonly name: string | null;
  readonly systemName: string | null;
  /**
   * STATION ONLY. True means "wherever the ship started" — resolved at run time
   * to the station the bot began at, the same way a belt's "nearest" resolves.
   * It is the most portable choice: a saved script that unloads / docks at the
   * starting station stays valid on any character, in any system. When true, `id`
   * is null and no picking is needed; when absent/false, a null id is an unbound
   * slot the player must still fill. Omitted (not `false`) when not a starting ref.
   */
  readonly starting?: boolean;
  /**
   * STATION ONLY. A NAMED BOARD SLOT — "the station an earlier block found",
   * resolved at run time from the run's board instead of being pinned now. Same
   * idea as `starting` (and as a belt's "nearest"): a runtime binding, so a bot
   * adapts to whatever agent/mission it picked up rather than a baked-in id, and
   * stays portable across characters. When set, `id` is null and no picking is
   * needed. Omitted (not null) when the ref is not a slot.
   */
  readonly slot?: BoardSlot;
}

/**
 * The facts a block can point at instead of a fixed station. Each maps to one
 * key an earlier block publishes on the run board; a closed vocabulary so the
 * codec can validate it and the editor can list it.
 */
export type BoardSlot = "agent-station" | "pickup-station" | "dropoff-station";

export const BOARD_SLOTS: readonly BoardSlot[] = Object.freeze<BoardSlot[]>([
  "agent-station",
  "pickup-station",
  "dropoff-station",
]);

/** The run-board key each slot reads. */
export const BOARD_SLOT_KEY: Readonly<Record<BoardSlot, string>> = {
  "agent-station": "agentStationID",
  "pickup-station": "pickupStationID",
  "dropoff-station": "dropoffStationID",
};

/** True when a station ref means "wherever the ship started". */
export function isStartingStation(ref: WorldRef): boolean {
  return ref.starting === true;
}

/** The board slot a station ref points at, or null when it is not a slot ref. */
export function refBoardSlot(ref: WorldRef): BoardSlot | null {
  return ref.slot ?? null;
}

/** A "use the station an earlier block found" station ref. */
export function boardSlotStation(slot: BoardSlot): WorldRef {
  return { entity: "station", id: null, name: null, systemName: null, slot };
}

/** A "return to where you started" station ref — the portable default. */
export function startingStation(): WorldRef {
  return { entity: "station", id: null, name: null, systemName: null, starting: true };
}

// ─── Macro arguments ─────────────────────────────────────────────────────────

/**
 * Where to mine. "nearest" is bound at RUNTIME from a fresh snapshot — it is the
 * operator's "warp to nearest asteroid belt", and it is what lets a script be
 * written while docked (no grid to read) and shared across worlds (no baked id).
 * "chosen" pins one belt for a player who is out in space and wants that one.
 *
 * ⚠ "site" IS THE ANOMALY MINER'S MODE, AND IT EXISTS BECAUSE THE OTHER TWO
 * COST A NIGHT'S MINING. An anomaly script has only one mining block to reach
 * for, and that block's "nearest" rotation tours the system's asteroid BELTS
 * the moment the grid it is standing on runs out of the wanted ore — so a bot
 * told to mine the scanner's ore sites quietly became a belt bot, then a
 * repair trip moved that belt tour into the home system, where the wanted ore
 * cannot spawn at all, and every pilot stopped. "site" tours the scanner's ore
 * sites instead and never looks at a belt: a barren site is a cue to fly to the
 * next one, and a system whose sites are all barren ends the run the way the
 * player asked for — home, docked, stopped.
 */
export type BeltArg =
  | { readonly mode: "nearest" }
  | { readonly mode: "site" }
  | { readonly mode: "ice-site" }
  | { readonly mode: "chosen"; readonly ref: WorldRef };

/**
 * Which fitted modules are the miners — identified by their type GROUP, never a
 * name regex (R47: 17482 → "Strip Miner"). `label` is the display hint.
 */
export interface EquipmentArg {
  readonly groupID: number;
  readonly label: string;
}

/**
 * One filled-in parameter of a macro step. A discriminated union so the codec can
 * validate each against the macro's declared parameter spec, and the editor can
 * pick the right widget, without the format growing a field per macro.
 */
/** Bounded small-integer argument (an agent level, a jump ceiling). */
export const MIN_COUNT_ARG = 1;
export const MAX_COUNT_ARG = 500;

/**
 * An ISK amount a player sets — a buy ceiling, a sell floor, a wallet threshold.
 * Capped at 100 billion: far above any sane per-unit price, far under the 2^53
 * point where a number stops being exact (so a comparison never lies).
 */
export const MIN_ISK_ARG = 1;
export const MAX_ISK_ARG = 100_000_000_000;

/** A market quantity (units to buy) — past the small-count cap, still exact. */
export const MIN_QTY_ARG = 1;
export const MAX_QTY_ARG = 10_000_000;

/**
 * A short free-text argument a player writes (a fleet name). One line, capped
 * well under the document byte ceiling; the codec strips control characters the
 * same way it does for names.
 */
export const MAX_TEXT_ARG_LEN = 200;

/**
 * A stand-off distance a player types, IN KILOMETRES.
 *
 * ⚠ THE UNIT IS IN THE KIND'S NAME BECAUSE THE MIX-UP IS A THOUSANDFOLD ERROR.
 * Every range inside the runtime is in METRES — `maxTargetRangeM`,
 * `droneControlRangeM`, `kiteBand`'s whole arithmetic — and a player types
 * kilometres, because that is the number the overview shows them. One `* 1000`
 * lives between the two, in the block's adapter (`nav/scriptMacros.ts`), and a
 * value that skips it parks the ship a thousand times too far out: the drones
 * go deaf, nothing dies, and the give-up ledger blames the site for it.
 *
 * 1..300 km. The floor is 1 because zero is "sit on top of it", which is what
 * NOT setting this already means; the ceiling is comfortably past any hull's
 * lock range, so it bounds a typo without ever refusing a real fit.
 */
export const MIN_DISTANCE_KM_ARG = 1;
export const MAX_DISTANCE_KM_ARG = 300;

/**
 * What a block does about a fitted afterburner or microwarpdrive.
 *
 *   • "auto" — the shipped behaviour, and the default: light it to close a gap,
 *              and kill it the moment the gap is closed. Holding station with a
 *              burner lit is pure signature bloom for no distance gained.
 *   • "off"  — never LIGHT one. It does not mean "ignore the rack": a module
 *              already running must always remain stoppable, or a burner lit by
 *              an earlier block burns capacitor and signature for the rest of
 *              the site.
 *
 * A closed vocabulary, like the place and rock ones above, so the codec can
 * refuse anything else rather than carry a third state nothing knows how to fly.
 */
export type PropModeArg = "auto" | "off";
export const PROP_MODE_ARGS: readonly PropModeArg[] = Object.freeze<PropModeArg[]>(["auto", "off"]);

export type Arg =
  | { readonly kind: "belt"; readonly belt: BeltArg }
  | { readonly kind: "station"; readonly ref: WorldRef }
  | { readonly kind: "toggle"; readonly enabled: boolean }
  | { readonly kind: "equipment"; readonly equipment: EquipmentArg }
  /** A specific agent (WorldRef entity "agent"). Optional on mission blocks — left
   * unset, the block uses the agent the find block published on the run's board. */
  | { readonly kind: "agent"; readonly ref: WorldRef }
  /** A bounded small integer: an agent LEVEL (1–5) or a max-jumps ceiling. */
  | { readonly kind: "count"; readonly value: number }
  /** A corporation filter for the agent finder; null id = any corporation. */
  | { readonly kind: "corp"; readonly id: number | null; readonly name: string | null }
  /** A saved fitting from the character's fitting library. The id is a same-world
   * hint; the NAME is what the block matches at run time, so an imported script
   * refits correctly wherever a fitting of that name exists. */
  | { readonly kind: "fitting"; readonly fittingID: number | null; readonly name: string | null }
  /** A kind of ITEM, by type. Type ids are static world data (portable); the name
   * is the display hint. null typeID = an unbound slot the player must fill. */
  | { readonly kind: "itemType"; readonly typeID: number | null; readonly name: string | null }
  /** A PLACE items can sit while docked: the station hangar, the ship's cargo
   * hold, or its ore hold. A closed vocabulary, validated by the codec. */
  | { readonly kind: "place"; readonly place: ItemPlace }
  /**
   * A CORPORATION HANGAR DIVISION to deliver into, addressed by its ordinal
   * (1-7) and labelled by the corporation's own name for it.
   *
   * The ORDINAL is what travels: a director can rename a division at any time,
   * and a script that named "Ore Buffer" would then deliver nowhere. The name
   * is a display hint, exactly as it is for `corp`, `fitting` and `bookmark` —
   * saved so the sentence still reads in words after a session where no office
   * has been read yet, and re-labelled from the live office when one has.
   *
   * ⚠ IT IS A REQUEST, NOT A DESTINATION. Whether this division can be
   * delivered into is decided by the server at the office, per pilot, at the
   * moment of the deposit — so a block carrying one still has to be able to
   * finish its lap when the answer is no. See `deliver-ore`.
   */
  | { readonly kind: "corpDivision"; readonly division: number; readonly name: string | null }
  /** A saved BOOKMARK. The id is a same-world hint; the NAME (its label) is what
   * the block matches at run time, so an imported script still finds "Safe spot". */
  | { readonly kind: "bookmark"; readonly bookmarkID: number | null; readonly name: string | null }
  /** A BOOKMARK FOLDER, personal or shared. The id is a same-world hint; the NAME is what the block matches at run
   * time, as it is for `bookmark`. */
  | { readonly kind: "bookmarkFolder"; readonly folderID: number | null; readonly name: string | null }
  /** An ISK amount the player sets — a buy ceiling or a sell floor (per unit). */
  | { readonly kind: "isk"; readonly value: number }
  /** A market quantity — how many units a buy order is for. */
  | { readonly kind: "qty"; readonly value: number }
  /** A character to act on (invite to a fleet). null charID = an unbound slot to pick. */
  | { readonly kind: "character"; readonly charID: number | null; readonly name: string | null }
  /**
   * WHERE TO GO: a station or a whole solar system. Distinct from the `station`
   * kind because the autopilot can be pointed at a system (arrive in space, no
   * dock), and because a system id and a station id are different things that
   * must never be swapped by a hand-edited file.
   */
  | { readonly kind: "destination"; readonly ref: WorldRef }
  /**
   * A SOLAR SYSTEM and nothing else — where `travel-to-system` goes. Kept apart
   * from `destination` (which is a station OR a system) because a block that
   * only ever means a system must not be able to hold a station: the picker for
   * this kind searches systems alone, and the codec refuses any other entity, so
   * "fly to a system" cannot quietly become "fly to a station and dock" through
   * a hand-edited file.
   */
  | { readonly kind: "system"; readonly ref: WorldRef }
  /** Which rock a mining step reaches for first. */
  | { readonly kind: "rockPick"; readonly pick: RockPick }
  /** A short line of text the player writes (a fleet name). Never empty at run
   * time — the validator flags a blank one before the bot can start. */
  | { readonly kind: "text"; readonly text: string }
  /** An ORDERED ore priority list for the mine block (first = most wanted).
   * Empty or absent = any rock, the shipped behaviour. */
  | { readonly kind: "oreList"; readonly ores: readonly OreFamilyArg[] }
  /**
   * An ORDERED target priority list for the combat blocks (first = shot first).
   * Empty or absent = the shipped ladder (tackle, ewar, logi, everything else).
   *
   * ⚠ UNLIKE THE ORE LIST, THIS RANKS RATHER THAN FILTERS. The mine block mines
   * only the ores it names; a combat block that shot only the classes it named
   * would sit still while the battleship it had no line for killed it. A class
   * left off ranks last, never unshootable (nav/targetPriority.ts).
   */
  | { readonly kind: "targetList"; readonly classes: readonly TargetClassArg[] }
  /** Whether this block calls the fleet's primary, follows it, or neither. */
  | { readonly kind: "squadRole"; readonly role: SquadRoleArg }
  /**
   * A distance the player types, in KILOMETRES — the drone boat's hold-range
   * override. Absent = the block computes the band for itself, which is the
   * shipped behaviour and the one a player should normally leave alone.
   *
   * ⚠ `value` IS KILOMETRES AND EVERYTHING DOWNSTREAM IS METRES. The field is
   * called `value` (not `km`) so it shares the shape of every other numeric arg
   * and the editor's one number widget can edit it; the UNIT lives in the kind's
   * name and in `MIN/MAX_DISTANCE_KM_ARG` above. The conversion happens exactly
   * once, in the block's adapter.
   */
  | { readonly kind: "distanceKm"; readonly value: number }
  /** Whether a block may light a prop mod at all — a closed vocabulary. */
  | { readonly kind: "propMode"; readonly mode: PropModeArg }
  /**
   * Bays the block must LEAVE ALONE. Empty or absent = leave nothing alone,
   * which is the shipped behaviour.
   *
   * The case it exists for: a combat ship's ammo hold and a jump-capable hull's
   * fuel bay are freight on a hauler and the ship's own kit on everything else,
   * and nothing about the bay says which. Naming one here keeps it out of BOTH
   * directions — neither filled with loot nor emptied at the station — because
   * a bay a bot fills but will not empty jams after one load.
   */
  | { readonly kind: "bayList"; readonly bays: readonly string[] }
  /**
   * Items the block must LEAVE ABOARD. Empty or absent = leave nothing, which is
   * the shipped behaviour.
   *
   * The case it exists for: spare mining crystals in the cargo hold, beside the
   * ore and salvage the trip was for. No bay rule can separate those, because
   * they are all in the same bay.
   */
  | { readonly kind: "itemList"; readonly items: readonly ItemMatchArg[] }
  /**
   * Planet colonies a planetary block is limited to, by planet id. The name is
   * kept beside each id so the step still reads in words on a machine that has
   * never read the colony (R7d: the id is never printed). Set by the
   * Planetary Industry window's Haul button, which writes the step itself.
   */
  | { readonly kind: "planetList"; readonly planets: readonly PlanetPickArg[] };

/** One colony a `planetList` names. */
export interface PlanetPickArg {
  readonly planetID: number;
  readonly name: string | null;
}

/**
 * One thing to leave aboard, matched on the game's own classification and never
 * on a name (R47, the same rule as OreFamilyArg): names are localised, renamed
 * and ambiguous.
 *
 * A `group` match is the one worth reaching for — every grade and variant of a
 * mining crystal shares a group, where a type list would need a dozen entries
 * and would silently miss the thirteenth. `name` is the display hint; for a
 * group it names an EXEMPLAR ("items like Simple Veldspar Mining Crystal II"),
 * because the client has no group-name table and inventing one would be worse
 * than showing the player something they can recognise.
 */
export type ItemMatchArg =
  | { readonly match: "type"; readonly typeID: number; readonly name: string }
  | { readonly match: "group"; readonly groupID: number; readonly name: string }
  /**
   * A NAME PATTERN — "everything whose name contains this", matched
   * case-insensitively against the name the client resolved for the row's type.
   *
   * ⚠ THE ONE MATCH THAT IS NOT THE GAME'S OWN CLASSIFICATION, and the one that
   * can go stale: names are localised and renamed, so a pattern is a rule a
   * patch can quietly empty where a group rule holds. It exists because a group
   * is not always the line a player wants to draw, and listing a dozen types by
   * hand is the alternative. `name` carries what the player typed so the
   * sentence can read it back; `pattern` is what is matched.
   */
  | { readonly match: "name"; readonly pattern: string; readonly name: string };

/** A name pattern past this is not a pattern, it is a paragraph. */
export const MAX_ITEM_PATTERN_LEN = 60;

/**
 * One ORE FAMILY the mine block prefers — Veldspar, Kernite, … — identified by
 * its type GROUP, never a name pattern (R47, the same rule as EquipmentArg):
 * every grade of an ore (0-Grade, plain, II-, III-, IV-Grade) shares one group,
 * and a rock in the space snapshot carries its groupID. `name` is the display
 * hint. Which GRADE to reach for first inside a family is the runtime's job
 * (`SpaceEntity.oreGrade`, highest first), not something the player lists.
 */
export interface OreFamilyArg {
  readonly groupID: number;
  readonly name: string;
}

/** How long an ore priority list may be. Past ten a player is not prioritising. */
export const MAX_ORE_LIST = 10;

/** A hull has a couple of dozen bays; a list longer than this is not a choice. */
export const MAX_BAY_LIST = 12;

/** Past a dozen kept items a player is describing a loadout, not an exception. */
export const MAX_ITEM_LIST = 12;
/** How many colonies one `planetList` may name. EVE caps a pilot at six. */
export const MAX_PLANET_LIST = 12;

/** The move block's place vocabulary. */
export type ItemPlace = "hangar" | "cargo" | "ore-hold";
export const ITEM_PLACES: readonly ItemPlace[] = Object.freeze<ItemPlace[]>(["hangar", "cargo", "ore-hold"]);

/**
 * A corporation office has exactly seven hangar divisions, always — it is the
 * shape of an office, not a per-corporation setting, so the bounds are a
 * constant here rather than something read off a live office.
 */
export const MIN_CORP_DIVISION = 1;
export const MAX_CORP_DIVISION = 7;

/**
 * Which rock the mine block reaches for first.
 *
 *   • "nearest" — the shipped behaviour, and still the default: least flying.
 *   • "biggest" — the most ore left first, from the amount the snapshot already
 *     reports per rock (`remainingQuantity`). Fewer rock changes per hold, which
 *     is what a strip miner wants. Rocks whose amount is UNKNOWN sort last rather
 *     than being treated as empty — a null is not a zero.
 *   • "valuable" — the richest ore per cubic metre first (`oreValuePerM3`, the
 *     number behind the client's own Ore Value gradient). A hold is a VOLUME, so
 *     when two rocks are both in reach the one worth more per m³ is worth more
 *     per trip — this is the pick that makes a bot mine the Kernite instead of
 *     the nearer Veldspar. Unpriced ore sorts last, the same way an unknown
 *     amount does.
 */
export type RockPick = "nearest" | "biggest" | "valuable";
export const ROCK_PICKS: readonly RockPick[] = Object.freeze<RockPick[]>([
  "nearest",
  "biggest",
  "valuable",
]);

/**
 * Which hostile a combat block shoots FIRST, by the job the hull was built for.
 *
 * A closed vocabulary, like the place and rock ones above: these four are all a
 * grid read can tell apart, and the runtime decides which hull is which from
 * the game's own ship-group name (nav/targetPriority.ts, which owns the mapping
 * and the shipped default order). The format only carries the player's
 * ORDERING of them — never the group names behind it, which are the game's to
 * change.
 */
export type TargetClassArg = "tackle" | "ewar" | "logi" | "other";
export const TARGET_CLASS_ARGS: readonly TargetClassArg[] = Object.freeze<TargetClassArg[]>([
  "tackle",
  "ewar",
  "logi",
  "other",
]);

/** Four classes exist, so a list longer than four is a repeat, not a choice. */
export const MAX_TARGET_LIST = 4;

/**
 * What a combat block does about the FLEET's call — the squad board (the BFF's
 * shared, in-process call board, src/squadBoard.js).
 *
 *   • "off"    — the shipped behaviour, and still the default: this pilot picks
 *                for itself and says nothing.
 *   • "call"   — pick as normal, and TELL the fleet what this pilot is on, so
 *                the followers converge on it. Costs one tick per new primary.
 *   • "follow" — shoot what the fleet has called, whenever that ship is on this
 *                pilot's own grid and in reach; otherwise pick as normal. A
 *                follower is never stuck: no call, or a call for a ship that is
 *                not here, is simply its own ladder again.
 *
 * A fleet with nobody calling is every pilot on "off" with extra steps, and a
 * fleet where everyone calls is last-call-wins — both are the player's to
 * arrange, and neither can wedge a bot.
 */
export type SquadRoleArg = "off" | "call" | "follow";
export const SQUAD_ROLE_ARGS: readonly SquadRoleArg[] = Object.freeze<SquadRoleArg[]>([
  "off",
  "call",
  "follow",
]);

// ─── Conditions ──────────────────────────────────────────────────────────────

/**
 * A player-checkable test over the world. Evaluated tri-state at runtime
 * (met / not-met / cannot-tell) from that tick's FRESH reads — never the store —
 * with cannot-tell never passing. Here it is only the shape + its threshold.
 *
 * ⚠ `hostile-on-grid` IS A GRID READ. It is false-or-unknowable while the ship
 * is still in warp, so it belongs in an interrupt (always-armed, fails safe by
 * not firing), never in a step's `until` where "DO WHILE no hostiles" would be
 * trivially true mid-warp — the belt-empty-on-tick-one trap in another costume.
 * `conditionSites()` below is the machine-checkable statement of that rule.
 */
export type Condition =
  | { readonly kind: "ore-hold-at-least"; readonly fraction: number }
  | { readonly kind: "hold-empty" }
  | { readonly kind: "shield-below"; readonly fraction: number }
  | { readonly kind: "armor-below"; readonly fraction: number }
  | { readonly kind: "hull-below"; readonly fraction: number }
  | { readonly kind: "health-below"; readonly fraction: number }
  | { readonly kind: "capacitor-below"; readonly fraction: number }
  /** Wallet thresholds carry an absolute ISK amount, not a 0..1 fraction. */
  | { readonly kind: "wallet-below"; readonly isk: number }
  | { readonly kind: "wallet-above"; readonly isk: number }
  | { readonly kind: "hostile-on-grid" }
  /**
   * The ship's ordinary CARGO hold (not the ore hold `ore-hold-at-least` watches)
   * — for a hauler, a looter, a salvager, anything whose hold is not ore.
   */
  | { readonly kind: "cargo-full"; readonly fraction: number }
  /** A player's ship on this grid has THIS ship locked — you are being hunted. */
  | { readonly kind: "targeted-by-player" }
  /** One of your drones out in space has dropped below this health. */
  | { readonly kind: "drone-health-below"; readonly fraction: number }
  /**
   * SOMETHING ON THIS GRID IS HOLDING THE SHIP SO IT CANNOT WARP.
   *
   * ⚠ IT EXISTS BECAUSE A HEALTH THRESHOLD CANNOT SAY "GO WHILE YOU STILL CAN".
   * A run was lost on 2026-09-14 to the most sensible watch a player can write:
   * `armor-below 0.25 -> dock-and-repair`. It fired exactly when it was asked
   * to, called the drones in, aligned, set course — and the warp was REFUSED,
   * because by then a rat had the ship scrammed. The bot fought to break free
   * and died doing it. Armour is a LAGGING indicator of whether leaving is
   * still possible: by the time it moves, the moment that decided the question
   * has already gone. Being pointed is the fact that decides it, and it is
   * knowable the instant it becomes true.
   *
   * It takes no threshold, like `hostile-on-grid`: "held" is not a quantity.
   *
   * ⚠ THE RESPONSE THAT HELPS IS `fight-back`, NOT A DOCK. A tackled ship
   * cannot dock-and-pause or dock-and-repair — the warp is the very thing being
   * prevented — so `tackled -> dock-and-pause` is a watch that can only ever
   * fail. Killing the thing holding the ship is what frees it. The FORMAT does
   * not police that (no condition here forbids a response, and none should
   * start: a player may legitimately want an `alert`, and a row that merely
   * tries and fails costs a tick, not a ship). The steering is done where it
   * belongs — in the words the player reads (`scriptText.ts`).
   */
  | { readonly kind: "tackled" };

export type ConditionKind = Condition["kind"];

/** Every condition kind — for exhaustive iteration in menus and tests. */
export const CONDITION_KINDS: readonly ConditionKind[] = Object.freeze<ConditionKind[]>([
  "ore-hold-at-least",
  "hold-empty",
  "shield-below",
  "armor-below",
  "hull-below",
  "health-below",
  "capacitor-below",
  "wallet-below",
  "wallet-above",
  "hostile-on-grid",
  "cargo-full",
  "targeted-by-player",
  "drone-health-below",
  "tackled",
]);

/** Where a condition may legally appear. */
export type ConditionSite = "until" | "interrupt";

/**
 * The legal sites for a condition kind — the structural guard on the belt-empty
 * class. A grid read (`hostile-on-grid`) is interrupt-only; every own-ship read
 * is fine in both places. The codec refuses a condition used off-site.
 */
export function conditionSites(kind: ConditionKind): readonly ConditionSite[] {
  // ⚠ EVERY GRID / SURROUNDINGS READ IS INTERRUPT-ONLY, for the reason spelled out
  // above `Condition`: out in the world these are false-or-unknowable while the
  // ship is still in warp, so as a step's `until` they read "true" at exactly the
  // wrong moment (the belt-empty-on-tick-one trap). As an always-armed watch they
  // fail safe by simply not firing.
  //   • hostile-on-grid / targeted-by-player / drone-health-below — grid reads.
  //   • tackled — a grid read too, and the sharpest case of the trap: nothing can
  //     hold a ship that is already in warp, so "do this step until I am tackled"
  //     would read not-met for the whole flight and the one tick it matters would
  //     arrive with the program on a step that never asked. It is a watch, and
  //     only a watch, exactly like the pirate it is usually about.
  return kind === "hostile-on-grid" ||
    kind === "targeted-by-player" ||
    kind === "drone-health-below" ||
    kind === "tackled"
    ? ["interrupt"]
    : ["until", "interrupt"];
}

/** True when `kind` may be used at `site`. */
export function conditionAllowedAt(kind: ConditionKind, site: ConditionSite): boolean {
  return conditionSites(kind).includes(site);
}

// ─── Interrupts ("Always watching") ──────────────────────────────────────────

/**
 * What a fired interrupt does.
 *
 * ⚠ NOTHING HERE EVER COMES TO REST IN SPACE. A stopped bot is an unattended
 * ship with its guns off, and a mining bot that stopped in a belt is food, so
 * every stop happens FROM A STATION: the runner flies home first and pauses on
 * arrival, carrying the reason with it (nav/scriptDecide `stopSafely`). The same
 * rule covers the runner's own faults — a blocked block, the livelock guard, the
 * step-tick cap — which are not responses at all and so are not listed here.
 *
 *   • "pause"          — stop and say why, from a station. In space that means
 *                        flying home first, which reads the same as
 *                        "dock-and-pause"; docked, it stops on the spot.
 *   • "dock-and-pause" — break off, dock at home, pause (the safety-floor
 *                        response, and the hostile "run for the station" pick).
 *   • "dock-and-repair"— break off, dock at home, PATCH THE SHIP UP, and then
 *                        CARRY ON from where the program left off. The one
 *                        response that flies the ship home without ending the
 *                        run: it is "go and lick your wounds", not "stop".
 *
 *                        The stay is the repair. Docking restores the shields
 *                        and the capacitor, and the station's repair shop fixes
 *                        the two layers that do NOT come back on their own
 *                        (armor and hull) — the same shop, through the same
 *                        block, that a Repair-ship step uses. Then it undocks
 *                        (only if the watch fired out in space; a watch that
 *                        fired in station leaves it docked) and the program
 *                        resumes at the very step it was interrupted on.
 *
 *                        ⚠ IT IS TRIP-CAPPED. A response that goes home and
 *                        comes back is a loop, and a loop whose condition the
 *                        trip never fixes is a bot flying laps: after a few
 *                        round trips with the watched reading still bad, it
 *                        stops from the station like any other watch instead of
 *                        commuting forever (nav/scriptDecide `MAX_RECOVER_TRIPS`).
 *   • "launch-drones"  — put drones out and KEEP WORKING (the hostile "use
 *                        drones" pick). Bounded by the existing three-attempt
 *                        launch rule, which heads home if it cannot.
 *   • "fight-back"     — TANK UP AND ACTUALLY FIGHT the pirate, then keep
 *                        working. Every fitted hardener that HAS a cycle goes
 *                        on first (an ordinary damage control has none — it is
 *                        already working, and is never reached for) — one tick
 *                        each, the instant self-targeted
 *                        move a player makes before they touch the guns — and
 *                        then the fight: drones out, lock the nearest hostile
 *                        inside targeting range, drones onto it, every idle gun
 *                        onto it — the same ladder the Fight-the-rats block
 *                        runs, borrowed rather than copied. It is what
 *                        "launch-drones" is usually mistaken for: launching
 *                        drones tells them to defend, it does not point them at
 *                        anything.
 *
 *                        When the pirate is gone the watch STANDS THE SHIP DOWN
 *                        — the drones it committed come home, then the hardeners
 *                        it switched on go back off, so the next lap starts cold
 *                        instead of burning capacitor on an empty grid. It undoes
 *                        only its OWN work: a hardener the player's Hardeners-on
 *                        block lit is never claimed and never switched off.
 *
 *                        ⚠ IT MUST NEVER OWN THE SHIP FOREVER. An interrupt
 *                        that keeps returning an action starves the step under
 *                        it, so the ladder hands control back the moment there
 *                        is nothing left to fight — grid clear, nothing inside
 *                        targeting range, or no way to fight at all — and the
 *                        program carries on from where it was. The stand-down is
 *                        bounded the same way: one action per rung, never a wait.
 */
/**
 *   • "repair"         — switch the matching repairers ON while the condition
 *                        holds and the capacitor allows, and back OFF when it
 *                        clears — the "keep the ship repaired" watch. The step
 *                        keeps working; repairs ride the watching layer.
 *   • "alert"          — TELL THE PLAYER and keep working: a notification, a
 *                        sound, and a line in the bot's readout. It changes
 *                        nothing about the ship, so it is the one response that
 *                        is safe to put above a real one.
 *
 * ⚠ TWO PROPERTIES MAKE "alert" BEHAVE, and both live in the orchestrator
 * (nav/scriptDecide), not here:
 *   • IT FIRES ONCE PER EPISODE. A condition that stays met would otherwise
 *     alert every tick — thirty notifications a minute, which is how an alert
 *     trains a player to ignore it. The row is marked spent on the first alert
 *     and un-spent only when its condition reads not-met again.
 *   • A SPENT ALERT ROW IS TRANSPARENT. Interrupts are first-match-wins, so an
 *     alert row sitting above a dock-and-pause row would silence it forever.
 *     Once spent, the scan skips the row and carries on down the ladder — so
 *     "tell me, AND dock" is two rows that both work.
 *
 * ⚠ AND THAT TRANSPARENCY IS NOT THE ALERT ROW'S PRIVILEGE — it is the rule for
 * ANY row that fires and then turns out to have no work this tick: a repair
 * watch for a layer with no repairer fitted (or whose repairers are all already
 * running), a launch-drones watch whose drones are out, a fight-back watch with
 * nothing in reach to shoot. Such a row hands the tick on DOWN THE LADDER rather
 * than to the program, so the rows under it still fire (nav/scriptDecide
 * `fallThrough`). Without that, the most ordinary safety layout a player writes
 * —
 *
 *     shield-below 0.10 -> repair          (on an armour boat: no shield booster)
 *     armor-below  0.45 -> dock-and-pause
 *
 * — is a flee rule that never fires, because the row above it wins every tick
 * and does nothing with the win. A row only holds the ship while it is acting
 * on it.
 */
export type InterruptResponse =
  | "pause"
  | "dock-and-pause"
  | "dock-and-repair"
  | "launch-drones"
  | "fight-back"
  | "repair"
  | "alert";

/** Every interrupt response — for exhaustive iteration in menus and tests. */
export const INTERRUPT_RESPONSES: readonly InterruptResponse[] = Object.freeze<InterruptResponse[]>([
  "pause",
  "dock-and-pause",
  "dock-and-repair",
  "launch-drones",
  "fight-back",
  "repair",
  "alert",
]);

/** One "always watching" row. Every interrupt is player-made and player-deletable. */
export interface InterruptRow {
  readonly id: string;
  readonly when: Condition;
  readonly respond: InterruptResponse;
  /**
   * FIGHT-BACK ONLY: how this watch fights, exactly as a combat BLOCK would.
   *
   * ⚠ THE WATCH IS WHERE A FIGHT ACTUALLY HAPPENS, so it is where these belong.
   * A combat block only looks at the grid while it is the ACTIVE STEP, and a
   * working bot is almost never on that step — it is mining until the hold is
   * full, or hauling, or flying somewhere. Rats arrive during THAT, which is
   * why the response to "a pirate shows up" is a watch in the first place.
   * Leaving the fleet ordering on blocks alone meant the one handler that fires
   * in time was the one that could not call or follow: caught live, 2026-09-08,
   * with two fleeted miners sitting through a Guristas spawn inside a wait
   * block until their shield watch pulled them home, never having fought.
   *
   * Both are optional and mean exactly what they mean on a block: `squad` calls
   * the fleet's primary or shoots the one it called, `targets` orders which
   * kind of hostile dies first. Absent = fly alone, shipped ladder.
   */
  readonly squad?: SquadRoleArg;
  readonly targets?: readonly TargetClassArg[];
}

// ─── Program nodes ───────────────────────────────────────────────────────────

/**
 * Which macros the format knows. The first five are the mining set; the seven
 * `*-mission` / agent blocks are the DISTRIBUTION-MISSION set — each one step of
 * the courier loop the proven mission bot already runs (find the agent, ask for
 * work, accept, load the package, fly the delivery, turn it in, fly back), cut
 * into blocks a player wires up — usually inside a Repeat loop.
 */
export type MacroID =
  | "undock"
  | "travel-to-station"
  | "travel-to-system"
  | "travel-to-belt"
  | "mine-at-belt"
  | "fleet-mine"
  | "mining-support"
  | "deliver-ore"
  | "defend-with-drones"
  | "find-distribution-agent"
  | "request-mission"
  | "accept-mission"
  | "load-mission-cargo"
  | "travel-to-dropoff"
  | "turn-in-mission"
  | "return-to-agent"
  | "wait"
  | "unload-cargo"
  // unload-cargo's mirror image: fill the ship from the station hangar, each
  // stack into whichever bay this hull wants it in. The two are a pair by
  // design — the bays a bot may FILL are exactly the ones it can EMPTY — and a
  // hauler that had only the emptying half could unload a command centre hold
  // it had no way to fill.
  | "load-cargo"
  | "haul-all"
  | "route-hauler"
  | "salvage-wrecks"
  | "loot-wrecks"
  | "loot-containers"
  | "refine-ore"
  | "hardeners-on"
  | "fight-the-rats"
  // The drone boat's own combat block, beside `fight-the-rats` rather than a
  // switch on it (docs/drone-boat-block-spec.md §1). That block is a GUN ladder:
  // it never moves the ship, it finishes on a grid that is merely out of LOCK
  // range, and its target classes match player hull groups no NPC ever carries.
  // A drone boat's whole tactic is range, so the block that cannot express range
  // cannot fly one — and none of those three could be changed in place without
  // breaking the gunship `fight-the-rats` was written for.
  | "fight-with-drones"
  | "warp-to-anomaly"
  // The mining twin of warp-to-anomaly: the same scanner list, filtered to ore
  // sites instead of dens. Two blocks rather than one with a switch, because
  // "fly to a pirate den" and "fly to an ore site" are two different intentions.
  | "warp-to-ore-anomaly"
  | "refit-ship"
  // The other half of refit-ship's "reship and go": board the hull this run
  // was flying before refit-ship swapped it out. Nothing to do when no
  // refit-ship in this run boarded anything.
  | "board-previous-ship"
  // Docked: board whichever ship parked here has a planetary commodities hold
  // (an Epithal), as it is fitted, noting the hull it leaves for
  // board-previous-ship. Done at once when the active ship already has one.
  | "board-planetary-hauler"
  | "move-items"
  | "warp-to-bookmark"
  // Take up and switch on the bookmark folders a bot works from (a shared folder is
  // seen only once a pilot has added it and switched it on). Done when every one is on.
  | "use-bookmark-folders"
  // The dedicated salvager's lap: work through the sites bookmarked in one
  // folder (loot your corporation's wrecks, salvage every wreck), file each
  // finished site's bookmark in another, unload at a station when the hold is
  // full, and dock there to wait when no site is left. Never finishes.
  | "salvage-bookmarked-sites"
  | "find-combat-agent"
  | "fly-to-mission-site"
  | "restart-extractors"
  // Goods leave a colony ONLY from its command centre pin — the emulator
  // refuses every other pin with CanOnlyLaunchFromCommandCenters. Watches
  // each colony's command centre and launches what it holds once the centre
  // is at least `fullPercent` full (default 80 when unset), dropping a
  // container in space beside the planet for a hauler to collect. The server
  // charges planetary export tax for the launch.
  | "launch-commodities"
  // The hauler's half of launch-commodities: in space, fly to each of your
  // planetary launch containers in this system and take what is inside,
  // using the server's own launch list (GetMyLaunchesDetails) to find them.
  | "collect-launches"
  // The hauler's half of the CUSTOMS-OFFICE export (src/piCustomsExport.js):
  // in space, empty every customs office in this system that holds goods of
  // yours into the ship. An office is a structure, not a listed launch, so the
  // block reads each one to find out whether it holds anything.
  | "collect-customs"
  | "repair-ship"
  // ── The market set. Place orders at the station's market (server confirm-gated).
  | "buy-item"
  | "sell-item"
  // ── The fleet-support set. Remote-repair friendly ships on grid (logistics).
  | "remote-rep"
  | "orbit-and-boost"
  // orbit-and-boost's named-target twin: orbits the fleet-mate the player
  // PICKS rather than whichever friendly is nearest. Plain escort, no remote
  // module required — see the decider (nav/scriptMacros.ts) for why it carries
  // no rep logic of its own.
  | "orbit-fleet-mate"
  // orbit-fleet-mate's stand-off twin: holds a set distance off the named
  // fleet-mate (keepAtRange, bridge/movementWrites.ts) instead of circling them — the escort a ship
  // wants when it should NOT be turning through the mate's own firing arc.
  | "follow-fleet-mate"
  // Set a fleet target tag on the top-priority hostile — a SINGLE-LETTER,
  // SINGLE-PILOT capability, not squad-wide "smart" tagging (see the decider's
  // header in nav/scriptMacros.ts for why). Skips outright on a pilot who is
  // not the fleet's commander; the gate is client-side because the server
  // drops a non-commander's write silently (bridge/fleetCommand.ts).
  | "fleet-tag-target"
  // ── The fleet-management set. Form up / invite / join (multibox alt-fleeting).
  | "create-fleet"
  | "invite-to-fleet"
  | "join-fleet"
  | "join-support-fleet"
  | "join-advertised-fleet"
  // ── Movement extras. Point the autopilot somewhere; run for the nearest dock.
  | "set-destination"
  | "dock-at-nearest"
  // ── Fleet support extra: feed a mate's capacitor.
  | "remote-cap"
  // ── Cargo extras: dump a can into space; tidy the hangar.
  | "jettison-cargo"
  | "jettison-ore"
  | "tidy-hangar"
  // ── Mining extra: squeeze the ore down against a support ship on grid.
  | "compress-ore"
  // ── Exploration: a safe probe sweep driven by EveJS's current authority.
  | "launch-scan-probes"
  | "analyze-signatures"
  | "recover-scan-probes";

/** Every macro id — for exhaustive iteration in menus and tests. */
export const MACRO_IDS: readonly MacroID[] = Object.freeze<MacroID[]>([
  "undock",
  "travel-to-station",
  "travel-to-system",
  "travel-to-belt",
  "mine-at-belt",
  "fleet-mine",
  "mining-support",
  "deliver-ore",
  "defend-with-drones",
  "find-distribution-agent",
  "request-mission",
  "accept-mission",
  "load-mission-cargo",
  "travel-to-dropoff",
  "turn-in-mission",
  "return-to-agent",
  "wait",
  "unload-cargo",
  "load-cargo",
  "haul-all",
  "route-hauler",
  "salvage-wrecks",
  "loot-wrecks",
  "loot-containers",
  "refine-ore",
  "hardeners-on",
  "fight-the-rats",
  "fight-with-drones",
  "warp-to-anomaly",
  "warp-to-ore-anomaly",
  "refit-ship",
  "board-previous-ship",
  "board-planetary-hauler",
  "move-items",
  "warp-to-bookmark",
  "use-bookmark-folders",
  "salvage-bookmarked-sites",
  "find-combat-agent",
  "fly-to-mission-site",
  "restart-extractors",
  "launch-commodities",
  "collect-launches",
  "collect-customs",
  "repair-ship",
  "buy-item",
  "sell-item",
  "remote-rep",
  "orbit-and-boost",
  "orbit-fleet-mate",
  "follow-fleet-mate",
  "fleet-tag-target",
  "create-fleet",
  "invite-to-fleet",
  "join-fleet",
  "join-support-fleet",
  "join-advertised-fleet",
  "set-destination",
  "dock-at-nearest",
  "remote-cap",
  "jettison-cargo",
  "jettison-ore",
  "tidy-hangar",
  "compress-ore",
  "launch-scan-probes",
  "analyze-signatures",
  "recover-scan-probes",
]);

/**
 * One macro step. `until` is the player's DO-UNTIL — the step runs until the
 * condition is met (DO-WHILE is the same wearing the negated condition; the UI
 * offers both words, the file stores `until`). A macro with no natural end of
 * its own (mine-at-belt) requires an `until`; the codec enforces that.
 */
export interface MacroStep {
  readonly id: string;
  readonly kind: "macro";
  readonly macro: MacroID;
  readonly args: Readonly<Record<string, Arg>>;
  readonly until?: Condition;
}

/**
 * A loop block: repeat its body a set number of times OR forever (decision 1),
 * with an optional `until` of its own. Forever is safe because every ACTION
 * inside a lap is bounded (macro counters, the per-step tick cap); only the lap
 * count is open, and it is shown on the row. One nesting level: the body holds
 * macro steps only, so a loop can never contain a loop.
 */
export type Repeat =
  | { readonly kind: "forever" }
  | { readonly kind: "times"; readonly count: number };

/**
 * What may sit inside a loop body: a plain step, or a BRANCH (so a loop can fork
 * each pass — "mine; if the hold is full, haul home, else keep going"). A loop
 * still cannot contain another LOOP, and a branch's own sides stay step-only, so
 * the nesting is bounded at exactly two levels and stays cycle-free.
 */
export type LoopBodyNode = MacroStep | BranchBlock;

export interface LoopBlock {
  readonly id: string;
  readonly kind: "loop";
  readonly repeat: Repeat;
  readonly until?: Condition;
  readonly body: readonly LoopBodyNode[];
}

/**
 * A branch block: evaluate `when` ONCE on entry, then run the `then` steps if it
 * holds or the `else` steps if it does not, and carry on past the branch. The one
 * place the program forks — and it stays cycle-free: both sides are forward-only
 * `MacroStep` lists (no loops, no nested branches — one level, like a loop body),
 * so the only backward edge in the whole format is still a loop re-entering its
 * body. `when` is an own-ship test (the `until` site), never a grid read that
 * would be unreadable at an arbitrary point; a cannot-tell `when` waits rather
 * than pick a side blind. A side may be empty ("do nothing on that branch").
 */
export interface BranchBlock {
  readonly id: string;
  readonly kind: "branch";
  readonly when: Condition;
  readonly then: readonly MacroStep[];
  readonly else: readonly MacroStep[];
}

/**
 * "Run one of my other saved bots here" — composition without copy-paste.
 *
 * ⚠ IT IS EXPANDED (INLINED) BEFORE THE RUN STARTS, never resolved mid-run: the
 * runner only ever sees a plain program, so every safety property (the forward
 * scan, the livelock proof, the step caps) holds unchanged and needs no new
 * reasoning. A present scriptID is authoritative in the account that saved the
 * document. A portable/imported node without one may fall back to its name only
 * when that name identifies exactly one saved bot; duplicate names are refused,
 * never resolved by array order. Cycles and runaway nesting are refused at
 * expansion (a bot can never include itself, directly or through a chain).
 *
 * TOP-LEVEL ONLY: a sub-bot may carry loops of its own, and inlining one inside
 * a loop body would make a loop-in-a-loop, so the codec refuses it there.
 * The included bot's OWN watches and home are ignored — the bot you start
 * governs the run.
 */
export interface SubBotNode {
  readonly id: string;
  readonly kind: "sub-bot";
  /** Exact library identity when known; never fall back if this id is stale. */
  readonly scriptID: string | null;
  readonly name: string | null;
}

/** How deep a chain of included bots may go before expansion refuses. */
export const MAX_SUBBOT_DEPTH = 3;

export type ProgramNode = MacroStep | LoopBlock | BranchBlock | SubBotNode;

// ─── The document ────────────────────────────────────────────────────────────

/**
 * A whole player bot, as saved / imported / exported.
 *
 * `home` is required — every bot names the station it docks at when a
 * dock-and-pause (or dock-and-repair) response fires, so the safety floor always
 * has somewhere to go.
 * `interrupts` is ordered and first-match-wins each tick, before any step. The
 * program runs once top to bottom; "go again" is an explicit outer loop block.
 */
export interface BotScript {
  readonly format: typeof SCRIPT_FORMAT;
  readonly version: typeof SCRIPT_VERSION;
  readonly name: string;
  readonly notes: string;
  readonly home: WorldRef;
  readonly interrupts: readonly InterruptRow[];
  readonly program: readonly ProgramNode[];
}

// ─── Structural helpers ──────────────────────────────────────────────────────
//
// Pure reads over a document. They never throw — a readout or validator must not
// crash on a shape it does not like; it reports.

/** Narrow a node to a loop block. */
export function isLoop(node: ProgramNode): node is LoopBlock {
  return node.kind === "loop";
}

/** Narrow a node to a macro step. */
export function isMacroStep(node: ProgramNode): node is MacroStep {
  return node.kind === "macro";
}

/** Narrow a node to a branch block. */
export function isBranch(node: ProgramNode): node is BranchBlock {
  return node.kind === "branch";
}

/** Both sides of a branch as one list — the steps it can run. */
export function branchSteps(branch: BranchBlock): readonly MacroStep[] {
  return [...branch.then, ...branch.else];
}

/** Macro steps in one loop-body element: a branch counts BOTH its sides. */
export function countLoopBodyNode(node: LoopBodyNode): number {
  return node.kind === "branch" ? node.then.length + node.else.length : 1;
}

/** Macro steps contributed by one program node (a loop counts its whole body).
 * A sub-bot counts as ONE here — it is replaced by its real steps at expansion,
 * and the expanded program is re-checked against the caps then. */
export function countProgramNode(node: ProgramNode): number {
  if (node.kind === "loop") {
    let total = 0;
    for (const element of node.body) {
      total += countLoopBodyNode(element);
    }
    return total;
  }
  return node.kind === "branch" ? node.then.length + node.else.length : 1;
}

/**
 * Total macro steps in a program, counting loop bodies and BOTH sides of every
 * branch (including branches inside a loop). This is the count the
 * `MAX_TOTAL_STEPS` cap bounds — a loop of 3 steps is 3, and a branch of 2-then
 * + 1-else is 3, not 1.
 */
export function countSteps(program: readonly ProgramNode[]): number {
  let total = 0;
  for (const node of program) {
    total += countProgramNode(node);
  }
  return total;
}

/** Every macro step inside one loop-body element, in order. */
export function loopBodySteps(node: LoopBodyNode): readonly MacroStep[] {
  return node.kind === "branch" ? branchSteps(node) : [node];
}

/**
 * The macro step with this id, wherever it sits — top level or inside a loop
 * body — or null. Ids are unique within a document (the codec enforces it), so
 * the first match is the only match.
 */
export function findStep(script: BotScript, id: string): MacroStep | null {
  for (const node of script.program) {
    if (node.kind === "macro") {
      if (node.id === id) {
        return node;
      }
    } else if (node.kind === "loop") {
      for (const element of node.body) {
        for (const step of loopBodySteps(element)) {
          if (step.id === id) {
            return step;
          }
        }
      }
    } else if (node.kind === "branch") {
      for (const step of branchSteps(node)) {
        if (step.id === id) {
          return step;
        }
      }
    }
    // A sub-bot node holds no steps of its own (it is replaced before the run).
  }
  return null;
}

/** True when a bounded `times` count is inside the allowed range. Forever is always valid. */
export function repeatCountInRange(repeat: Repeat): boolean {
  if (repeat.kind === "forever") {
    return true;
  }
  return (
    Number.isInteger(repeat.count) &&
    repeat.count >= MIN_REPEAT_TIMES &&
    repeat.count <= MAX_REPEAT_TIMES
  );
}
