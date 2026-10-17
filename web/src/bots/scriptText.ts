// A3 — every sentence a player reads about a VALID program, in one place.
//
// ⚠ THIS IS THE R9a REGISTER FOR THE PROGRAM VIEW. The codec owns the sentences
// for a REJECTED file (scriptCodec's SAY); this owns the sentences for a good
// one — a step, a condition, a repeat, an interrupt — so the editor and the run
// readout speak with one voice and a test can sweep them all.
//
// ⚠ R7d LIVES HERE TOO. Nothing in this file renders a numeric id. A world slot
// shows the NAME the reference carries, and when it has none it says "a station
// you pick" — never the number. The exhaustiveness switches carry no `default`,
// so a new macro or condition that arrives without a sentence fails to compile
// rather than reaching a player as a raw kind slug.

import type {
  BeltArg,
  BoardSlot,
  BranchBlock,
  Condition,
  ConditionKind,
  InterruptResponse,
  InterruptRow,
  MacroID,
  MacroStep,
  PropModeArg,
  Repeat,
  TargetClassArg,
  SquadRoleArg,
  WorldRef,
} from "./botScript.ts";
import { launchFullPercent } from "./macroSpecs.ts";

/** A percentage a player reads — always with its unit, never a bare number. */
function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * An ISK amount a player reads — grouped with its unit. Grouping is pinned to
 * en-US so a big amount always breaks into runs of three digits (never a bare
 * 5+-digit run, which R7d treats as a leaked id), whatever the runtime locale.
 */
function isk(amount: number): string {
  return `${amount.toLocaleString("en-US")} ISK`;
}

/** A world reference as words — its name, or a "you pick" phrase; never its id (R7d). */
function worldRefPhrase(ref: WorldRef | null, pickNoun: string): string {
  if (ref !== null && ref.slot !== undefined) {
    return boardSlotPhrase(ref.slot);
  }
  if (ref !== null && ref.starting === true) {
    return "your starting station";
  }
  if (ref !== null && ref.name !== null && ref.name.length > 0) {
    return ref.name;
  }
  return `a ${pickNoun} you pick`;
}

/**
 * A corporation hangar division as words: the corporation's own name for it
 * when the script carries one, and "division N" when it does not.
 *
 * The ordinal IS a name here, not an id leaking into the sentence (R7d): it is
 * what the division is called in an office nobody has renamed, and it is what
 * the player picked it by. A script written on one account and read on another
 * — where the office has never been opened, so no name was ever learned — has
 * to read as something, and "division 3" is the honest something.
 */
function corpDivisionPhrase(division: number, name: string | null): string {
  return name !== null && name.length > 0 ? name : `division ${division}`;
}

function beltPhrase(belt: BeltArg): string {
  if (belt.mode === "nearest") {
    return "the nearest belt";
  }
  // ⚠ THE WORD "BELT" NEVER APPEARS BELOW THIS LINE. "site" mode exists because
  // "nearest" silently toured the system's asteroid BELTS the moment the ore
  // anomaly a mining bot was parked in ran dry (see `BeltArg`'s own comment in
  // botScript.ts) — a bot whose blurb read "the scanner's ore sites, not the
  // belts" was a belt bot in practice, and a repair trip that relocated it to
  // its highsec home system killed the run outright. A sentence that let
  // "belt" slip back in here would hide the exact confusion that cost a run.
  if (belt.mode === "site") {
    return "the ore site the scanner shows";
  }
  if (belt.mode === "ice-site") return "the ice site the scanner shows";
  return worldRefPhrase(belt.ref, "belt");
}

/** The palette/menu name of a macro. */
export function macroName(macro: MacroID): string {
  switch (macro) {
    case "undock":
      return "Leave the station";
    case "travel-to-station":
      return "Fly to a station and dock";
    case "travel-to-system":
      return "Fly to a solar system";
    case "travel-to-belt":
      return "Fly to a belt";
    case "mine-at-belt":
      // Three ways to pick where, now that BeltArg has grown a "site" mode
      // beside "nearest" and a belt named by hand — the nearest asteroid belt,
      // one the player typed, or the scanner's ore sites — so the palette
      // name can no longer promise just a belt (see `beltPhrase` above).
      return "Mine at a belt or an ore site";
    case "fleet-mine":
      return "Fleet Miner";
    case "join-support-fleet": return "Join the support fleet";
    case "mining-support":
      return "Mining Support";
    case "deliver-ore":
      return "Haul the ore home";
    case "defend-with-drones":
      return "Fight off rats with drones";
    case "find-distribution-agent":
      return "Find a delivery agent";
    case "request-mission":
      return "Ask the agent for work";
    case "accept-mission":
      return "Accept the mission";
    case "load-mission-cargo":
      return "Load the mission cargo";
    case "travel-to-dropoff":
      return "Fly the delivery";
    case "turn-in-mission":
      return "Turn the mission in";
    case "return-to-agent":
      return "Fly back to the agent";
    case "wait":
      return "Wait a while";
    case "unload-cargo":
      return "Empty the ship";
    case "load-cargo":
      return "Load the ship";
    case "haul-all":
      return "Haul selected corporation cargo";
    case "route-hauler":
      return "Run a corporation cargo route";
    case "salvage-wrecks":
      return "Salvage the wrecks";
    case "loot-wrecks":
      return "Loot your wrecks";
    case "loot-containers":
      return "Loot the containers";
    case "refine-ore":
      return "Refine the ore";
    case "hardeners-on":
      return "Hardeners on";
    case "fight-the-rats":
      return "Fight the rats";
    case "fight-with-drones":
      return "Fight with drones";
    case "warp-to-anomaly":
      return "Fly to a pirate den";
    case "warp-to-ore-anomaly":
      return "Fly to an ore site";
    case "refit-ship":
      return "Refit from a saved fitting";
    case "board-previous-ship":
      return "Back into the earlier ship";
    case "board-planetary-hauler":
      return "Board a planetary hauler";
    case "move-items":
      return "Move items";
    case "warp-to-bookmark":
      return "Fly to a saved spot";
    case "use-bookmark-folders":
      return "Use bookmark folders";
    case "salvage-bookmarked-sites":
      return "Salvage bookmarked sites";
    case "find-combat-agent":
      return "Find a combat agent";
    case "fly-to-mission-site":
      return "Fly to the mission site";
    case "restart-extractors":
      return "Restart the planet extractors";
    case "launch-commodities":
      return "Launch from the command centre";
    case "collect-launches":
      return "Collect your planet launches";
    case "collect-customs":
      return "Collect from the customs offices";
    case "repair-ship":
      return "Repair the ship";
    case "buy-item":
      return "Buy from the market";
    case "sell-item":
      return "Sell to the market";
    case "remote-rep":
      return "Remote-repair the fleet";
    case "orbit-and-boost":
      return "Orbit and boost a fleet-mate";
    case "orbit-fleet-mate":
      return "Orbit a fleet-mate by name";
    case "follow-fleet-mate":
      return "Hold range off a fleet-mate by name";
    case "fleet-tag-target":
      return "Tag the top target for the fleet";
    case "create-fleet":
      return "Form a fleet";
    case "invite-to-fleet":
      return "Invite a pilot to your fleet";
    case "join-fleet":
      return "Join a fleet";
    case "join-advertised-fleet":
      return "Join a fleet from the fleet finder";
    case "set-destination":
      return "Set the destination and fly";
    case "dock-at-nearest":
      return "Dock at the nearest station";
    case "remote-cap":
      return "Feed a fleet-mate's capacitor";
    case "jettison-cargo":
      return "Jettison the cargo into space";
    case "jettison-ore":
      return "Jettison the ore hold into space";
    case "tidy-hangar":
      return "Tidy the hangar";
    case "compress-ore":
      return "Compress the ore on grid";
    case "launch-scan-probes":
      return "Launch scan probes";
    case "analyze-signatures":
      return "Analyze signatures";
    case "recover-scan-probes":
      return "Recover scan probes";
  }
}

/** A named board slot, as a player reads it — never a key, never an id. */
export function boardSlotPhrase(slot: BoardSlot): string {
  switch (slot) {
    case "agent-station":
      return "the agent's station";
    case "pickup-station":
      return "the mission's pickup station";
    case "dropoff-station":
      return "the mission's drop-off station";
  }
}

/** A place, as a player reads it. */
/**
 * What a player reads for a bay key. The keys are the bridge's vocabulary, not
 * words anybody chose to show — R9a says the screen gets language, so a key with
 * no entry here falls back to itself rather than having a name invented for it.
 */
const BAY_LABELS: Readonly<Record<string, string>> = {
  cargo: "cargo hold",
  ore: "ore hold",
  gas: "gas hold",
  ice: "ice hold",
  asteroid: "asteroid hold",
  mineral: "mineral hold",
  salvage: "salvage hold",
  ammo: "ammo hold",
  fuel: "fuel bay",
  planetary: "planetary hold",
  commandCenter: "command centre hold",
  fleet: "fleet hangar",
  drone: "drone bay",
};

/**
 * " of Planet II and Planet IX", or "" when the step covers every colony. A
 * colony with no name is counted rather than printed by id (R7d).
 */
function launchPlanetsPhrase(step: MacroStep): string {
  const arg = step.args["planets"];
  if (arg === undefined || arg.kind !== "planetList" || arg.planets.length === 0) {
    return "";
  }
  const named = arg.planets.map((planet) => planet.name).filter((name): name is string => name !== null);
  const unnamed = arg.planets.length - named.length;
  const parts = unnamed > 0 ? [...named, unnamed === 1 ? "1 more colony" : `${unnamed} more colonies`] : named;
  const list = parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return ` of ${list}`;
}

/** "the ore hold and the fuel bay", or "" when nothing is named. */
function keptItemsPhrase(step: MacroStep): string {
  const arg = step.args["keepItems"];
  if (arg === undefined || arg.kind !== "itemList" || arg.items.length === 0) {
    return "";
  }
  const names = arg.items.map((item) => item.name).filter((name) => name.length > 0);
  return names.length === 0 ? "" : `, keeping ${names.join(" and ")} aboard`;
}

/** What a load step was told to take: "Command Centers and Nanite Repair Paste". */
function loadedItemsPhrase(step: MacroStep): string {
  const arg = step.args["items"];
  if (arg === undefined || arg.kind !== "itemList" || arg.items.length === 0) {
    return "what you pick";
  }
  const names = arg.items.map((item) => item.name).filter((name) => name.length > 0);
  return names.length === 0 ? "what you pick" : names.join(" and ");
}

export function placePhrase(place: string): string {
  switch (place) {
    case "hangar":
      return "the station hangar";
    case "cargo":
      return "the cargo hold";
    case "ore-hold":
      return "the ore hold";
    default:
      return "somewhere";
  }
}

/** A condition as a clause that reads after "until" or "if". */
export function conditionSentence(condition: Condition): string {
  switch (condition.kind) {
    case "ore-hold-at-least":
      return `the ore hold is ${pct(condition.fraction)} full`;
    case "hold-empty":
      return "the hold is empty";
    case "shield-below":
      return `shields drop below ${pct(condition.fraction)}`;
    case "armor-below":
      return `armor drops below ${pct(condition.fraction)}`;
    case "hull-below":
      return `the hull drops below ${pct(condition.fraction)}`;
    case "health-below":
      return `ship health drops below ${pct(condition.fraction)}`;
    case "capacitor-below":
      return `the capacitor drops below ${pct(condition.fraction)}`;
    case "wallet-below":
      return `your wallet drops below ${isk(condition.isk)}`;
    case "wallet-above":
      return `your wallet rises above ${isk(condition.isk)}`;
    case "hostile-on-grid":
      return "a pirate shows up";
    case "cargo-full":
      return `the cargo hold is ${pct(condition.fraction)} full`;
    case "targeted-by-player":
      return "another player locks onto your ship";
    case "drone-health-below":
      return `one of your drones drops below ${pct(condition.fraction)} health`;
    // ⚠ THE CLAUSE SAYS "AND IT CANNOT WARP OUT" ON PURPOSE, AND THAT IS THE
    // WHOLE STEER. A watch reads back as one sentence ("If <this>, <that>"), so
    // naming the consequence inside the condition makes the wrong pairing
    // audible the moment a player picks it: "If something has your ship
    // scrambled and it cannot warp out, dock at home and stop" contradicts
    // itself out loud, while "...harden up, fight back, and stand down when it
    // is over" reads like the answer it is. Nothing is forbidden — the format
    // does not police which response goes with which condition and must not
    // start — the words simply stop hiding the contradiction.
    //
    // "something", not "a pirate": the jam pushes this rides name whoever is
    // holding the ship, and in low-sec that is as likely to be another player.
    case "tackled":
      return "something has your ship scrambled and it cannot warp out";
  }
}

/**
 * The extra line a condition needs a player to read BEFORE they pick a response
 * — null for every kind that needs none, which is nearly all of them.
 *
 * ⚠ IT EXISTS FOR EXACTLY ONE PROBLEM: A WATCH THAT CAN ONLY EVER FAIL. Most
 * conditions pair sensibly with most responses, so the editor rightly offers
 * every combination. `tackled` is the exception a run was lost to on
 * 2026-09-14: the obvious response to trouble is "go home", and going home is
 * the one thing a held ship cannot do, because the warp is what is being
 * prevented. A player who wires `tackled -> dock-and-pause` has written a row
 * that will fire on time, try the impossible, and change nothing.
 *
 * ⚠ IT ADVISES, IT DOES NOT REFUSE. A blocking rule here would be the codec's
 * job and the codec has no business ranking responses: `alert` on a tackle is a
 * perfectly sane row for a player watching their screen, and a row that tries
 * and fails costs a tick, not a ship. So this is a sentence, not a gate.
 */
export function conditionAdvice(kind: ConditionKind): string | null {
  switch (kind) {
    case "tackled":
      return (
        "A scrambled ship cannot warp, so it cannot reach home either - the trip a dock response asks for " +
        "is the exact thing being prevented. Fight back is the response that frees it: it kills what is " +
        "holding you, and it shoots the tackler first. Once you are loose, a health watch can take you home."
      );
    default:
      return null;
  }
}

/**
 * A "run another saved bot" row, in plain words. Deliberately not possessive:
 * the library is platform-wide, so the bot this points at may well have been
 * saved by someone else.
 */
export function subBotSentence(node: { readonly name: string | null }): string {
  return node.name !== null && node.name.length > 0
    ? `Run the saved bot "${node.name}"`
    : "Run a saved bot you pick";
}

/** A branch's header line: the fork it makes, in plain words. */
export function branchSentence(branch: BranchBlock): string {
  const thenPart = branch.then.length === 0 ? "do nothing" : "do the first steps";
  const elsePart = branch.else.length === 0 ? "do nothing" : "do the other steps";
  return `If ${conditionSentence(branch.when)}, ${thenPart}; otherwise ${elsePart}`;
}

/** How a loop's repeat reads on its header row. */
export function repeatSentence(repeat: Repeat): string {
  if (repeat.kind === "forever") {
    return "Repeat forever";
  }
  return repeat.count === 1 ? "Repeat once" : `Repeat up to ${repeat.count} times`;
}

/** What a fired interrupt does, as a clause that reads after the condition. */
export function responseSentence(response: InterruptResponse): string {
  switch (response) {
    case "pause":
      return "get to a station and stop";
    case "dock-and-pause":
      return "dock at home and stop";
    case "dock-and-repair":
      return "dock at home, repair, and carry on";
    case "launch-drones":
      return "send out drones and keep going";
    case "fight-back":
      return "harden up, fight back, and stand down when it is over";
    case "repair":
      return "run the repairers until it recovers";
    case "alert":
      return "let me know and keep going";
  }
}

/** The words an "alert me" watch shows when it fires — a whole sentence a player
 * reads on a phone notification, so it names the check, not the row. */
export function alertSentence(row: InterruptRow): string {
  return `Your bot noticed: ${conditionSentence(row.when)}.`;
}

/**
 * How a fight-back watch fights, when the player has said: which hostile first,
 * and what it does about the fleet's call. Empty for every other response and
 * for a watch left at the shipped ladder, so an ordinary row reads exactly as
 * it always did.
 */
function watchFightPhrase(row: InterruptRow): string {
  if (row.respond !== "fight-back") {
    return "";
  }
  const classes = row.targets ?? [];
  const order = classes.length === 0 ? "" : `, ${classes.map((cls) => TARGET_CLASS_WORD[cls]).join(" then ")} first`;
  const squad = row.squad === undefined || row.squad === "off" ? "" : `, ${SQUAD_ROLE_WORD[row.squad]}`;
  return `${order}${squad}`;
}

/** A whole "always watching" row: "If shields drop below 30%, dock at home and stop". */
export function interruptSentence(row: InterruptRow): string {
  return `If ${conditionSentence(row.when)}, ${responseSentence(row.respond)}${watchFightPhrase(row)}`;
}

/** A whole step: its macro, its bound slots, and its "until" when it carries one. */
export function stepSentence(step: MacroStep): string {
  const base = macroPhrase(step);
  if (step.until !== undefined) {
    return `${base} until ${conditionSentence(step.until)}`;
  }
  return base;
}

/** What each target class is CALLED to a player — never the stored token (R9a). */
const TARGET_CLASS_WORD: Readonly<Record<TargetClassArg, string>> = {
  tackle: "tacklers",
  ewar: "jammers",
  logi: "logistics",
  other: "everything else",
};

/** What each fleet-fire role is called on screen. */
const SQUAD_ROLE_WORD: Readonly<Record<SquadRoleArg, string>> = {
  off: "on its own",
  call: "calling the primary for the fleet",
  follow: "on the fleet's primary",
};

/** The role words, for the picker. "off" is the default and says nothing. */
export function squadRoleWord(role: SquadRoleArg): string {
  return SQUAD_ROLE_WORD[role];
}

/** ", calling the primary for the fleet" — empty when the block flies alone. */
function squadPhrase(step: MacroStep): string {
  const arg = step.args["squad"];
  if (arg === undefined || arg.kind !== "squadRole" || arg.role === "off") {
    return "";
  }
  return `, ${SQUAD_ROLE_WORD[arg.role]}`;
}

/** What one target class is called on screen — the picker reads it from here. */
export function targetClassWord(cls: TargetClassArg): string {
  return TARGET_CLASS_WORD[cls];
}

/** What each prop-mod setting is called on screen. */
const PROP_MODE_WORD: Readonly<Record<PropModeArg, string>> = {
  auto: "using the prop mod to close the distance",
  off: "leaving the prop mod alone",
};

/** The prop-mod words, for the picker. "auto" is the default and says nothing. */
export function propModeWord(mode: PropModeArg): string {
  return PROP_MODE_WORD[mode];
}

/**
 * ", leaving the prop mod alone" — empty on the default, so an untouched drone
 * boat still reads as one plain sentence.
 *
 * ⚠ "off" NEVER READS AS "IGNORES THE PROP MOD". It means the block will not
 * LIGHT one; a burner an earlier block left running is still shut down, because
 * a ship holding station with its signature bloomed is being shot for nothing.
 * "Leaving it alone" is the honest short way to say "will not reach for it".
 */
function propPhrase(step: MacroStep): string {
  const arg = step.args["propulsion"];
  if (arg === undefined || arg.kind !== "propMode" || arg.mode === "auto") {
    return "";
  }
  return `, ${PROP_MODE_WORD[arg.mode]}`;
}

/**
 * ", holding at 25 km off" — empty when the block works its own band out, which
 * is the case a player should normally be in.
 *
 * ⚠ THE NUMBER IS PRINTED IN THE UNIT IT WAS TYPED IN. The stored value is
 * kilometres; nothing here converts, because a sentence that quietly showed
 * metres would teach the player the wrong unit for the box they typed into.
 */
function holdRangePhrase(step: MacroStep): string {
  const arg = step.args["holdRangeKm"];
  if (arg === undefined || arg.kind !== "distanceKm") {
    return "";
  }
  return `, holding at ${arg.value} km off`;
}

/**
 * ", tacklers then jammers first" — the same shape the ore priority reads in,
 * and empty when the step leaves the ladder at its default, so an untouched
 * combat step still reads as the one plain sentence it always did.
 */
function targetPhrase(step: MacroStep): string {
  const arg = step.args["targets"];
  const classes = arg !== undefined && arg.kind === "targetList" ? arg.classes : [];
  if (classes.length === 0) {
    return "";
  }
  return `, ${classes.map((cls) => TARGET_CLASS_WORD[cls]).join(" then ")} first`;
}

function macroPhrase(step: MacroStep): string {
  switch (step.macro) {
    case "join-support-fleet": {
      const support = step.args["support"];
      return `Join ${support?.kind === "character" ? support.name ?? "the selected pilot's" : "the selected pilot's"} support fleet`;
    }
    case "mining-support": return "Maintain the operation's mining support";
    case "fleet-mine": {
      const support = step.args["support"];
      return `Mine within ${support?.kind === "character" ? support.name ?? "the selected pilot's" : "a fleet pilot's"} support`;
    }
    case "undock":
      return "Leave the station";
    case "mine-at-belt": {
      const belt = step.args["belt"];
      const where = belt !== undefined && belt.kind === "belt" ? beltPhrase(belt.belt) : "a belt you pick";
      const pick = step.args["pick"];
      const order =
        pick === undefined || pick.kind !== "rockPick"
          ? ""
          : pick.pick === "biggest"
            ? ", biggest rocks first"
            : pick.pick === "valuable"
              ? ", most valuable ore first"
              : "";
      const ores = step.args["ores"];
      const oreNames = ores !== undefined && ores.kind === "oreList" ? ores.ores.map((ore) => ore.name).filter((name) => name.length > 0) : [];
      const oreWord = oreNames.length > 0 ? `, ${oreNames.join(" then ")} first` : "";
      return `Mine at ${where}${order}${oreWord}`;
    }
    case "travel-to-station": {
      const station = step.args["station"];
      const where =
        station !== undefined && station.kind === "station"
          ? worldRefPhrase(station.ref, "station")
          : "a station you pick";
      return `Fly to ${where} and dock`;
    }
    case "travel-to-system": {
      const system = step.args["system"];
      const where =
        system !== undefined && system.kind === "system"
          ? worldRefPhrase(system.ref, "system")
          : "a system you pick";
      return `Fly to ${where} and wait until you are there`;
    }
    case "travel-to-belt": {
      const belt = step.args["belt"];
      const where = belt !== undefined && belt.kind === "belt" ? beltPhrase(belt.belt) : "a belt you pick";
      return `Fly to ${where}`;
    }
    case "deliver-ore": {
      const station = step.args["station"];
      const where =
        station !== undefined && station.kind === "station"
          ? worldRefPhrase(station.ref, "station")
          : "a station you pick";
      const into = step.args["into"];
      const hangar =
        into !== undefined && into.kind === "corpDivision"
          ? ` and put it in the corporation's ${corpDivisionPhrase(into.division, into.name)}`
          : "";
      return `Haul the ore to ${where}${hangar}`;
    }
    case "defend-with-drones":
      return "Fight off rats with your combat drones";
    case "find-distribution-agent": {
      const level = step.args["level"];
      const levelWord = ` (preferred level ${level !== undefined && level.kind === "count" ? level.value : 1}`;
      const fallback = step.args["fallback"];
      const fallbackWord = fallback?.kind === "toggle" && fallback.enabled
        ? ", fallback to lower levels)" : ", no lower-level fallback)";
      const corp = step.args["corporation"];
      const corpWord =
        corp !== undefined && corp.kind === "corp" && corp.name !== null && corp.name.length > 0
          ? ` working for ${corp.name}`
          : "";
      return `Find a delivery agent${levelWord}${fallbackWord}${corpWord}`;
    }
    case "request-mission": {
      const agent = step.args["agent"];
      const who =
        agent !== undefined && agent.kind === "agent"
          ? worldRefPhrase(agent.ref, "agent")
          : "the agent you found";
      return `Ask ${who} for work`;
    }
    case "accept-mission": {
      const jumps = step.args["maxJumps"];
      const cap =
        jumps !== undefined && jumps.kind === "count"
          ? ` if it is ${jumps.value} ${jumps.value === 1 ? "jump" : "jumps"} or fewer`
          : "";
      return `Accept the mission${cap}`;
    }
    case "load-mission-cargo":
      return "Load the mission cargo into your ship";
    case "travel-to-dropoff":
      return "Fly the delivery to the drop-off station";
    case "turn-in-mission":
      return "Hand the cargo over and turn the mission in";
    case "return-to-agent":
      return "Fly back to the agent's station";
    case "wait": {
      const seconds = step.args["seconds"];
      const n = seconds !== undefined && seconds.kind === "count" ? seconds.value : 10;
      return `Wait ${n} ${n === 1 ? "second" : "seconds"}`;
    }
    case "unload-cargo": {
      const except = step.args["exceptBays"];
      const names =
        except !== undefined && except.kind === "bayList"
          ? except.bays.map((key) => BAY_LABELS[key] ?? key)
          : [];
      const kept = keptItemsPhrase(step);
      const into = step.args["into"];
      const hangar =
        into !== undefined && into.kind === "corpDivision"
          ? `the corporation's ${corpDivisionPhrase(into.division, into.name)}`
          : "the hangar";
      return names.length === 0
        ? `Empty the ship into ${hangar}${kept}`
        : `Empty the ship into ${hangar}, but leave the ${names.join(" and ")} alone${kept}`;
    }
    case "load-cargo": {
      const except = step.args["exceptBays"];
      const names =
        except !== undefined && except.kind === "bayList"
          ? except.bays.map((key) => BAY_LABELS[key] ?? key)
          : [];
      // "as much as fits" is the promise the block actually keeps, and saying it
      // here is what stops a player reading a half-loaded ship as a failure: the
      // rest is still in the hangar, waiting for the next lap of the loop.
      const load = `Load as much ${loadedItemsPhrase(step)} as fits, each into the right hold`;
      return names.length === 0
        ? load
        : `${load}, but leave the ${names.join(" and ")} alone`;
    }
    case "haul-all": return "Haul selected corporation cargo";
    case "route-hauler": return "Run a corporation cargo route";
    case "hardeners-on":
      // ⚠ "AND DAMAGE CONTROL" USED TO BE IN THIS LINE, AND IT PROMISED
      // SOMETHING THE BLOCK CANNOT DO. An ordinary damage control has no cycle:
      // it works the moment it is online and there is no switch to press, so a
      // player who read that line watched the block reach for it and reasonably
      // called that a bug. The block still runs a damage control that DOES
      // cycle (the assault kind) -- it just does not advertise a module most
      // fits carry as something it will switch on.
      return "Switch every hardener on";
    case "fight-the-rats":
      return `Fight the rats until the grid is clear${targetPhrase(step)}${squadPhrase(step)}`;
    // ⚠ THE SENTENCE SAYS "FROM A DISTANCE", WHICH IS THE WHOLE DIFFERENCE FROM
    // THE LINE ABOVE. Two combat blocks sitting side by side in the palette have
    // to be told apart by their sentences or a player picks the wrong one and
    // watches a drone boat sit inside a scram it could have stayed out of. The
    // band, the give-up verdict and the fit fault get their own sentences from
    // the block itself while it runs (nav/droneBoatLadder.ts); this line is the
    // STILL one, read in the editor before anything is on grid, so it says what
    // the block will do and never guesses a number it has not computed yet.
    case "fight-with-drones":
      return `Fight the rats with your drones from a distance${holdRangePhrase(step)}${propPhrase(step)}${targetPhrase(step)}${squadPhrase(step)}`;
    case "warp-to-anomaly":
      return "Warp to the next pirate den the scanner shows";
    case "warp-to-ore-anomaly":
      return "Warp to the next ore site the scanner shows";
    case "refit-ship": {
      const fit = step.args["fitting"];
      const name =
        fit !== undefined && fit.kind === "fitting" && fit.name !== null && fit.name.length > 0
          ? fit.name
          : "a fitting you pick";
      return `Refit the ship from ${name}`;
    }
    case "move-items": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? item.name
          : "an item you pick";
      const amount = step.args["amount"];
      const howMany = amount !== undefined && amount.kind === "count" ? `${amount.value} ` : "all the ";
      const from = step.args["from"];
      const to = step.args["to"];
      const fromWord = from !== undefined && from.kind === "place" ? placePhrase(from.place) : "somewhere";
      const toWord = to !== undefined && to.kind === "place" ? placePhrase(to.place) : "somewhere";
      return `Move ${howMany}${what} from ${fromWord} to ${toWord}`;
    }
    case "warp-to-bookmark": {
      const bm = step.args["bookmark"];
      const name =
        bm !== undefined && bm.kind === "bookmark" && bm.name !== null && bm.name.length > 0
          ? bm.name
          : "a spot you pick";
      return `Warp to ${name}`;
    }
    case "salvage-bookmarked-sites": {
      const from = step.args["fromFolder"];
      const name = from !== undefined && from.kind === "bookmarkFolder" && from.name !== null && from.name.length > 0 ? from.name : "a folder you pick";
      return `Salvage the sites bookmarked in ${name}`;
    }
    case "use-bookmark-folders": {
      const names = ["folder", "alsoFolder"]
        .map((key) => step.args[key])
        .flatMap((arg) => (arg !== undefined && arg.kind === "bookmarkFolder" && arg.name !== null && arg.name.length > 0 ? [arg.name] : []));
      return names.length === 0 ? "Switch on a bookmark folder you pick" : `Switch on the ${names.join(" and ")} bookmark folder${names.length > 1 ? "s" : ""}`;
    }
    case "find-combat-agent": {
      const level = step.args["level"];
      const levelWord = level !== undefined && level.kind === "count" ? ` (level ${level.value})` : "";
      return `Find a combat agent${levelWord}`;
    }
    case "fly-to-mission-site":
      return "Warp to the mission's own site";
    case "restart-extractors":
      return "Restart every expired extractor on your planets";
    case "launch-commodities": {
      // The SAME clamp the decider fires on, so the sentence cannot promise a
      // threshold the block will not use.
      const fullPercent = launchFullPercent(step.args["fullPercent"], step.args["anyAmount"]);
      return fullPercent === 0
        ? `Launch whatever the command centre${launchPlanetsPhrase(step)} holds`
        : `Launch from the command centre${launchPlanetsPhrase(step)} once it is ${fullPercent}% full`;
    }
    case "collect-launches":
      return "Collect every launch container of yours in this system";
    case "collect-customs":
      return "Empty every customs office in this system that holds your goods";
    case "board-previous-ship":
      return "Get back into the ship this run was flying before the refit";
    case "board-planetary-hauler":
      return "Get into a ship parked here that has a planetary hold";
    case "repair-ship":
      return "Repair the ship at the station";
    case "salvage-wrecks":
      return "Salvage the wrecks on this grid";
    case "loot-wrecks":
      return "Loot your own wrecks on this grid";
    case "loot-containers":
      return "Loot every container on this grid";
    case "refine-ore":
      return "Refine the ore in the hangar";
    case "buy-item": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? item.name
          : "an item you pick";
      const qty = step.args["quantity"];
      const howMany = qty !== undefined && qty.kind === "qty" ? qty.value.toLocaleString() : "some";
      const price = step.args["price"];
      const cap = price !== undefined && price.kind === "isk" ? ` at up to ${isk(price.value)} each` : "";
      return `Buy ${howMany} ${what}${cap}`;
    }
    case "sell-item": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? item.name
          : "an item you pick";
      const price = step.args["price"];
      const floor = price !== undefined && price.kind === "isk" ? ` at ${isk(price.value)} or more each` : "";
      return `Sell all your ${what}${floor}`;
    }
    case "remote-rep":
      return "Remote-repair the most hurt fleet-mate on grid";
    case "orbit-and-boost":
      return "Orbit a fleet-mate and keep the remote reps running";
    case "orbit-fleet-mate": {
      const who = step.args["who"];
      const name =
        who !== undefined && who.kind === "character" && who.name !== null && who.name.length > 0
          ? who.name
          : "a fleet-mate you pick";
      return `Orbit ${name}`;
    }
    case "follow-fleet-mate": {
      const who = step.args["who"];
      const name =
        who !== undefined && who.kind === "character" && who.name !== null && who.name.length > 0
          ? who.name
          : "a fleet-mate you pick";
      return `Hold range off ${name}`;
    }
    case "fleet-tag-target":
      return "Mark the top-priority hostile with a fleet target tag, while you are the fleet's commander";
    case "create-fleet":
      return "Form a fleet with you as the boss";
    case "invite-to-fleet": {
      const who = step.args["who"];
      const name =
        who !== undefined && who.kind === "character" && who.name !== null && who.name.length > 0
          ? who.name
          : "a pilot you pick";
      return `Invite ${name} to your fleet`;
    }
    case "join-fleet":
      return "Accept a fleet invitation when one arrives";
    case "join-advertised-fleet": {
      const named = step.args["fleetName"];
      const name = named !== undefined && named.kind === "text" ? named.text.trim() : "";
      return name.length > 0
        ? `Join the fleet "${name}" if it is in the fleet finder`
        : "Join a fleet you name if it is in the fleet finder";
    }
    case "set-destination": {
      const dest = step.args["destination"];
      const where =
        dest !== undefined && dest.kind === "destination"
          ? worldRefPhrase(dest.ref, dest.ref.entity === "system" ? "system" : "station")
          : "a place you pick";
      return `Set the destination to ${where} and start flying`;
    }
    case "dock-at-nearest":
      return "Dock at the nearest station";
    case "remote-cap":
      return "Feed the emptiest fleet-mate's capacitor";
    case "jettison-cargo": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? `all your ${item.name}`
          : "everything in the cargo hold";
      return `Jettison ${what} into space${keptItemsPhrase(step)}`;
    }
    case "jettison-ore": {
      const item = step.args["item"];
      const what =
        item !== undefined && item.kind === "itemType" && item.name !== null && item.name.length > 0
          ? `all your ${item.name}`
          : "everything in the ore hold";
      return `Jettison ${what} into space`;
    }
    case "tidy-hangar":
      return "Stack everything in the hangar into neat piles";
    case "compress-ore":
      return "Compress the ore in your hold at the support ship on grid";
    case "launch-scan-probes":
      return "Launch the scan probes from your current ship";
    case "analyze-signatures":
      return "Analyze signatures with the current probe formation";
    case "recover-scan-probes":
      return "Recover every active scan probe to the ship";
  }
}
