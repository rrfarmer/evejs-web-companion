// C3 — the palette's view of the macros: the plain name, a one-line "what it
// does", a one-line "what it needs", and which picker each parameter uses. Pure
// UI metadata — the Svelte palette and inspector read it, and a test proves every
// macro has an entry and that none of this copy carries an id or engineering word
// (R7d / R9a).
//
// The parameters are DERIVED from the shared `macroSpecs.ts`, so the palette can
// never offer a control for an argument the codec/validator don't know about.

import { MACRO_IDS, type Arg, type MacroID } from "./botScript.ts";
import { MACRO_SPECS, type MacroArgSpec } from "./macroSpecs.ts";
import { macroName } from "./scriptText.ts";

/** Which inspector widget fills a parameter — one per Arg kind (kept in step). */
export type ParamPicker = Arg["kind"];

// ─── Categories ──────────────────────────────────────────────────────────────
//
// The play LOOP a block belongs to — a mining bot's author filters to Mining, a
// ratter to Combat. One primary category per block (a search box catches the
// cross-overs). The palette shows a chip per category that actually HAS a block,
// so a category with no shipped block yet (Market, Fleet) simply does not appear
// until its blocks land.

export type BlockCategory =
  | "movement"
  | "combat"
  | "mining"
  | "hauling"
  | "industry"
  | "market"
  | "missions"
  | "ship"
  | "planets"
  | "exploration"
  | "fleet"
  | "social"
  | "flow";

/** The chip label for each category (R9a — play language, never a slug). */
export const CATEGORY_LABEL: Readonly<Record<BlockCategory, string>> = {
  movement: "Movement",
  combat: "Combat",
  mining: "Mining",
  hauling: "Cargo & Hauling",
  industry: "Industry",
  market: "Market",
  missions: "Missions",
  ship: "Ship & Fitting",
  planets: "Planets",
  exploration: "Exploration",
  fleet: "Fleet",
  social: "Social",
  flow: "Flow & Timing",
};

/** The order categories read in the filter — the loops a player thinks in. */
export const CATEGORY_ORDER: readonly BlockCategory[] = [
  "movement",
  "mining",
  "combat",
  "hauling",
  "market",
  "missions",
  "industry",
  "ship",
  "planets",
  "exploration",
  "fleet",
  "social",
  "flow",
];

export interface MacroParamView {
  readonly key: string;
  readonly label: string;
  readonly picker: ParamPicker;
  readonly required: boolean;
}

export interface MacroCatalogEntry {
  readonly id: MacroID;
  readonly name: string;
  /** The play loop this block belongs to — drives the palette's category filter. */
  readonly category: BlockCategory;
  /** What it does, one line. */
  readonly does: string;
  /** What it needs before it can start, one line — or null when it needs nothing. */
  readonly needs: string | null;
  readonly params: readonly MacroParamView[];
  /** Whether an `until` is required (mine-at-belt) — the inspector makes it mandatory. */
  readonly untilRequired: boolean;
}

const PARAM_LABEL: Readonly<Record<string, string>> = {
  belt: "Belt",
  station: "Station",
  equipment: "Equipment",
  agent: "Agent",
  level: "Agent level",
  maxJumps: "Longest trip (jumps)",
  corporation: "Corporation",
  seconds: "Seconds",
  fitting: "Saved fitting",
  item: "Item",
  from: "From",
  to: "To",
  amount: "How many",
  bookmark: "Saved spot",
  quantity: "How many",
  price: "Price each (ISK)",
  who: "Pilot",
  only: "Only this pilot",
  range: "Scanner reach (AU)",
  channel: "Channel",
  message: "Message",
  destination: "Destination",
  pick: "Which rock first",
  into: "Unload into",
  ores: "Ore priority",
  support: "Support pilot",
  // The drone boat's two overrides. Both say their unit or their choice in the
  // label, because both are things a player only reaches for when the block's
  // own answer looked wrong on screen.
  holdRangeKm: "Hold this far off (km)",
  propulsion: "Prop mod",
  fullPercent: "Launch once this full (%)",
  anyAmount: "Launch any amount",
  planets: "Only these colonies",
};

function paramView(arg: MacroArgSpec): MacroParamView {
  return {
    key: arg.key,
    label: PARAM_LABEL[arg.key] ?? arg.key,
    picker: arg.kind,
    required: arg.required,
  };
}

function entry(id: MacroID, category: BlockCategory, does: string, needs: string | null): MacroCatalogEntry {
  const spec = MACRO_SPECS[id];
  return {
    id,
    name: macroName(id),
    category,
    does,
    needs,
    params: spec.args.map(paramView),
    untilRequired: spec.untilRequired,
  };
}

/** Exhaustive by the Record type — a new macro cannot compile without an entry. */
const ENTRIES: Readonly<Record<MacroID, MacroCatalogEntry>> = {
  undock: entry("undock", "movement", "Undocks your ship.", null),
  "travel-to-station": entry(
    "travel-to-station",
    "movement",
    "Flies to a station, through gates if it needs to, and docks.",
    "A station to go to",
  ),
  "travel-to-system": entry(
    "travel-to-system",
    "movement",
    "Flies to a solar system, through gates if it needs to, and only finishes once you have arrived. Put this before any block that works on something in another system: Set the destination and fly hands the ship to the autopilot and then finishes straight away, so whatever comes next starts while you are still on your way there.",
    "A solar system to go to",
  ),
  "travel-to-belt": entry(
    "travel-to-belt",
    "movement",
    "Warps to a belt — a pinned one, or whichever is nearest — and stops once you are there. No mining, no locking: just the trip, for a hauler heading to pick up a jetcan a mining loop dropped on a belt it never sat down on itself.",
    "Being in space, in the belt's system",
  ),
  "mine-at-belt": entry(
    "mine-at-belt",
    "mining",
    "Warps to wherever you tell it — the nearest belt, a belt you name, or the scanner's ore sites — locks rocks, and runs your mining equipment. On a belt it moves belt to belt as each one runs dry; sent to the scanner's ore sites it tours those instead and never sits down on a belt at all. Follows an ore priority list when you set one.",
    "Somewhere to mine, and mining equipment fitted",
  ),
  "fleet-mine": entry(
    "fleet-mine", "mining",
    "Mines visible resources while staying within the selected fleet pilot's mining bursts. Moves only where both mining reach and support coverage are satisfied; waits when support is unavailable.",
    "A joined fleet, a visible support pilot maintaining mining bursts, and mining equipment fitted",
  ),
  "mining-support": entry("mining-support", "mining", "Maintains the operation's support services and follows its mining target using its chosen support policies.", "A Standard Command pilot in a Mining Operation"),
  "deliver-ore": entry(
    "deliver-ore",
    "hauling",
    "Flies to a station and unloads the ore into your hangar — or into one of your corporation's hangars there, when you pick one and the corporation rents an office.",
    "A station to unload at",
  ),
  "defend-with-drones": entry(
    "defend-with-drones",
    "combat",
    "Launches your combat drones, targets the pirates, and sets them attacking.",
    "Combat drones in the bay",
  ),
  // ── The distribution-mission set. Wire them in order (usually inside a Repeat
  // loop): find an agent → ask for work → accept → load → deliver → turn in →
  // fly back. Later blocks use the agent and mission the earlier ones found.
  "find-distribution-agent": entry(
    "find-distribution-agent",
    "missions",
    "Searches for a delivery (distribution) agent by level, distance and corporation, and remembers the best match for the blocks after it.",
    null,
  ),
  "request-mission": entry(
    "request-mission",
    "missions",
    "Flies to the agent's station, docks, and asks for a mission.",
    "An agent — picked here, or found by the block before",
  ),
  "accept-mission": entry(
    "accept-mission",
    "missions",
    "Checks the offer (trip length, whether the cargo fits your ship) and accepts it — or turns it down and asks again.",
    null,
  ),
  "load-mission-cargo": entry(
    "load-mission-cargo",
    "missions",
    "Moves the mission cargo from the pickup hangar into your ship, and checks it is really aboard.",
    "An accepted mission",
  ),
  "travel-to-dropoff": entry(
    "travel-to-dropoff",
    "missions",
    "Sets the destination to the mission's drop-off station and flies there, gate to gate, and docks.",
    "An accepted mission with cargo aboard",
  ),
  "turn-in-mission": entry(
    "turn-in-mission",
    "missions",
    "Unloads the cargo at the drop-off and tells the agent the job is done.",
    "Being docked at the drop-off station",
  ),
  "return-to-agent": entry(
    "return-to-agent",
    "missions",
    "Flies back to the agent's station and docks, ready to ask for the next mission.",
    "An agent found or picked earlier in the run",
  ),
  wait: entry(
    "wait",
    "flow",
    "Does nothing for a set number of seconds — a breather between blocks. Give it a \"stop when\" to wait for something instead (like shields recovering).",
    null,
  ),
  "unload-cargo": entry(
    "unload-cargo",
    "hauling",
    "Moves everything in your ship's cargo hold into the station hangar, or into one of your corporation's hangars there when you pick one, and checks the hold really is empty. Handy before accepting a delivery, so the cargo is sure to fit.",
    "Being docked",
  ),
  "load-cargo": entry(
    "load-cargo",
    "hauling",
    "Takes what you name out of the station hangar and puts each stack where it belongs — command centres into the command centre hold, planetary goods into the planetary hold, ore into the mining hold, everything else into cargo. It loads as much as will fit and leaves the rest for the next trip, so a loop of this, a flight and an unload moves a whole hangar a shipload at a time.",
    "Being docked, with room somewhere aboard",
  ),
  "haul-all": entry("haul-all", "hauling", "Carries selected corporation cargo to the exact destination division and verifies both inventories.", "Corporation offices at both ends"),
  "route-hauler": entry("route-hauler", "hauling", "Repeats a corporation route with optional return freight. Only cargo loaded by this run is delivered.", "Corporation offices at both ends"),
  "salvage-wrecks": entry(
    "salvage-wrecks",
    "hauling",
    "Works through the wrecks around you: salvage drones sweep on their own, and fitted salvagers are run on each wreck in turn. Finishes when nothing salvageable is left, drones home. A ship with no way to salvage skips this step with a warning rather than stopping.",
    "Salvage drones in the bay, or salvagers fitted",
  ),
  "loot-wrecks": entry(
    "loot-wrecks",
    "hauling",
    "Flies to each of YOUR OWN wrecks in turn and takes what's inside. It never touches anyone else's wreck, so it can never get you flagged as a thief.",
    "Wrecks of yours on the grid",
  ),
  "loot-containers": entry(
    "loot-containers",
    "hauling",
    "Flies to each container on the grid in turn — jetcans included — and takes what's inside. Handy for a hauler working a belt behind miners jettisoning ore.",
    "Containers on the grid",
  ),
  "refine-ore": entry(
    "refine-ore",
    "industry",
    "Runs every ore stack in the station hangar through the refinery. The station takes its cut in tax; anything it cannot be sure is ore is left alone.",
    "Being docked, with ore in the hangar",
  ),
  "hardeners-on": entry(
    "hardeners-on",
    "combat",
    "Switches every fitted hardener on — one block at the top of a fight or a mining trip. Finishes once they are all running. An ordinary damage control is left alone: it works the moment it is online, so there is nothing to switch. A ship with no hardener at all is not stopped — the block says so once and the bot carries on.",
    "Nothing — a ship with no hardener carries on without one",
  ),
  "fight-the-rats": entry(
    "fight-the-rats",
    "combat",
    "Locks the nearest pirate, runs your guns on it and sets the drones on it too, then moves to the next. Finishes when the grid is clear and the drones are back aboard.",
    "Guns fitted, or combat drones in the bay",
  ),
  // The drone boat's own block, beside Fight the rats rather than replacing it:
  // that one is the gunship's ladder and never moves the ship, which is the one
  // thing a drone boat has to do.
  "fight-with-drones": entry(
    "fight-with-drones",
    "combat",
    "Fights a pirate den the way a drone boat has to. Puts your combat drones out, holds the ship at a stand-off distance worked out from what the pirates on grid can actually reach you with, and moves the drones from one target to the next. It pulls a drone that has started taking damage and sends it back out, burns in on a wave that lands too far away to lock onto, and walks away from a den that will not die rather than grinding at it. Finishes when the grid is clear and the drones are back aboard.",
    "Combat drones in the bay",
  ),
  "warp-to-anomaly": entry(
    "warp-to-anomaly",
    "combat",
    "Reads your ship's scanner and warps to the next pirate den it shows, skipping ore sites and the dens this run has already visited. Pair it with Fight the rats in a repeat loop.",
    "Being in space, with a den on the scanner",
  ),
  "warp-to-ore-anomaly": entry(
    "warp-to-ore-anomaly",
    "mining",
    "Reads your ship's scanner and warps to the next ore site it shows — asteroid clusters and ice belts, never a pirate den — skipping the ones this run has already visited. Pair it with Mine at a belt or an ore site in a repeat loop.",
    "Being in space, with an ore site on the scanner",
  ),
  "refit-ship": entry(
    "refit-ship",
    "ship",
    "Boards the right hull from your hangar if you are flying something else, then applies the saved fitting you picked (yours or your corporation's) — modules pulled from this station's hangar.",
    "Being docked, the saved fitting, and its modules in the hangar",
  ),
  "board-planetary-hauler": entry(
    "board-planetary-hauler",
    "ship",
    "Gets into a ship parked here that has a planetary commodities hold, such as an Epithal, as it is fitted. Nothing to pick: it reads each hull's holds. Back into the earlier ship takes you back to the ship you left.",
    "Being docked where a ship with a planetary hold is parked",
  ),
  "board-previous-ship": entry(
    "board-previous-ship",
    "ship",
    "Gets back into the ship you were flying before Refit from a saved fitting swapped it out earlier in this run. Put it at the end of a hauling lap, back at the station where you reshipped. Does nothing if no refit in this run changed ships.",
    "Being docked where the earlier ship is parked",
  ),
  "move-items": entry(
    "move-items",
    "hauling",
    "Moves an item you pick between the station hangar and your ship's holds — a set amount, or every last one — and checks the move really landed.",
    "Being docked, with the item where you said it is",
  ),
  "warp-to-bookmark": entry(
    "warp-to-bookmark",
    "movement",
    "Warps to one of your saved spots — a mission site, a safe spot, a mining perch. Finishes when the warp lands.",
    "Being in space, in the saved spot's system",
  ),
  "salvage-bookmarked-sites": entry(
    "salvage-bookmarked-sites",
    "hauling",
    "A dedicated salvager: flies to each site bookmarked in one folder, loots your corporation's wrecks, salvages every wreck, and files the bookmark in another folder. Unloads at your station when the hold is full, and docks there to wait when no site is left.",
    "A ship with salvagers or salvage drones",
  ),
  "use-bookmark-folders": entry(
    "use-bookmark-folders",
    "movement",
    "Adds the bookmark folders you name to the pilot's list and switches them on, so their bookmarks can be seen and warped to. When three shared folders are already on, it switches off one you did not name.",
    null,
  ),
  "find-combat-agent": entry(
    "find-combat-agent",
    "missions",
    "Searches for a combat (security) agent by level, distance and corporation, and remembers the best match for the blocks after it.",
    null,
  ),
  "fly-to-mission-site": entry(
    "fly-to-mission-site",
    "missions",
    "Warps to the site of the mission you accepted — the spot the agent marked for you. Finishes when the warp lands. Put Fight the rats right after it.",
    "An accepted mission, in the mission's system",
  ),
  "restart-extractors": entry(
    "restart-extractors",
    "planets",
    "Checks every planet colony you own and restarts each extractor whose program has run out, on the same resource it was already pulling. Works from anywhere.",
    "A planet colony with extractors",
  ),
  "launch-commodities": entry(
    "launch-commodities",
    "planets",
    "Watches the command centre of every colony you own and launches what it is holding once the centre is full enough, dropping a container in space beside the planet for a hauler to collect. The server charges planetary export tax for the launch.",
    "A planet colony whose command centre is holding goods",
  ),
  "collect-launches": entry(
    "collect-launches",
    "planets",
    "Flies to each container your command centres launched in this system and takes what is inside, each into the right hold (an Epithal's planetary hold takes planetary goods). It finds them from your launch list, so there is no scanning. Finishes when every launch here is collected, or when the ship is full.",
    "Being in space in the system of your launches",
  ),
  "collect-customs": entry(
    "collect-customs",
    "planets",
    "Flies to each customs office in this system that is holding planetary goods of yours and takes what is inside, each into the right hold (an Epithal's planetary hold takes planetary goods). The Planetary Industry window's Haul button puts the goods there; this block brings them home. Finishes when every office here is empty, or when the ship is full.",
    "Being in space in the system of your colonies",
  ),
  "repair-ship": entry(
    "repair-ship",
    "ship",
    "Asks the station's repair shop what is damaged on your ship and its fitted modules, fixes it, and checks the shop agrees there is nothing left to fix. The station charges your wallet.",
    "Being docked, with money for the shop",
  ),
  "buy-item": entry(
    "buy-item",
    "market",
    "Places a buy order at this station's market for the item you pick, at your price per unit or less. Spends ISK and pays the broker fee — the server asks before it goes through.",
    "Being docked, with money in your wallet",
  ),
  "sell-item": entry(
    "sell-item",
    "market",
    "Lists every stack of the item you pick from your hangar onto this station's market, at your price per unit or more. Pays the broker fee on each — the server asks before it goes through.",
    "Being docked, with the item in your hangar",
  ),
  "remote-rep": entry(
    "remote-rep",
    "fleet",
    "Finds the most hurt friendly ship on your grid, locks it, and runs your remote shield or armor repairers on it — moving to the next when one recovers. Finishes once everyone on grid is at full health.",
    "Being in space, with a remote repairer fitted",
  ),
  "orbit-and-boost": entry(
    "orbit-and-boost",
    "fleet",
    "Orbits the nearest friendly ship up close and keeps your remote repairers running on whoever is hurt — the stay-with-the-fleet logistics loop. Keeps going for as long as it is left on; a watch or your own hand stops it.",
    "Being in space, with a remote repairer fitted",
  ),
  "orbit-fleet-mate": entry(
    "orbit-fleet-mate",
    "fleet",
    "Orbits the fleet-mate you name, close enough to stay with them wherever the fight moves - a designated pairing rather than whoever is nearest. Keeps going for as long as it is left on; a watch or your own hand stops it.",
    "Being in space, in a fleet with the pilot you pick",
  ),
  "follow-fleet-mate": entry(
    "follow-fleet-mate",
    "fleet",
    "Holds a set distance off the fleet-mate you name, instead of circling them - the stand-off escort for a ship that should not be turning through their firing arc. Keeps going for as long as it is left on; a watch or your own hand stops it.",
    "Being in space, in a fleet with the pilot you pick",
  ),
  "fleet-tag-target": entry(
    "fleet-tag-target",
    "fleet",
    "Marks the top-priority hostile with a fleet target tag, so a tagged fleet can see the primary without a broadcast. Only works while you are the fleet's boss or one of its wing or squad commanders - on any other seat it does nothing and keeps fighting anyway. It only tracks its own tag, so running this on more than one pilot at once will have them fight each other's tags.",
    "Being in space, in a fleet, as its commander",
  ),
  "create-fleet": entry(
    "create-fleet",
    "fleet",
    "Forms a new fleet with you as the boss, so you can invite your other pilots into it. Does nothing if you are already in a fleet. The server asks before it goes through.",
    null,
  ),
  "invite-to-fleet": entry(
    "invite-to-fleet",
    "fleet",
    "Invites one of your known pilots into the fleet you are in — the other half of forming up your own characters. You have to be in a fleet already (form one first). The server asks before it goes through.",
    "Being in a fleet, and a pilot to invite",
  ),
  "join-fleet": entry(
    "join-fleet",
    "fleet",
    "Waits for a fleet invitation and accepts it, so your other pilots can pull this one into their fleet. Finishes once you are in a fleet. The server asks before it goes through.",
    null,
  ),
  "join-support-fleet": entry("join-support-fleet", "fleet",
    "Joins the selected support pilot's fleet under the operation's managed policy. Waits for fresh membership and never leaves a different fleet. Outside an operation, checks existing membership without joining.",
    "A selected support pilot and fresh fleet membership"),
  "join-advertised-fleet": entry(
    "join-advertised-fleet",
    "fleet",
    "Joins the fleet with the name you type, if somebody has it listed in the fleet finder. Does nothing at all when you are already in a fleet, or when no fleet by that name is listed - it simply finishes and the next block runs - so it is safe at the top of a loop that should carry on alone while nobody has formed up yet. The server asks before it goes through.",
    null,
  ),
  "set-destination": entry(
    "set-destination",
    "movement",
    "Sets your destination — a station, or a whole solar system — and starts the autopilot flying there, gate by gate. Finishes as soon as the trip is under way rather than waiting for the arrival, so you can follow it with your own checks. Use Fly to a station and dock instead when you just want to arrive and dock.",
    "Somewhere to go",
  ),
  "dock-at-nearest": entry(
    "dock-at-nearest",
    "movement",
    "Finds the closest station in view and docks there — the get-inside-now block. Works out which one is nearest when it runs, so it is right wherever the ship happens to be.",
    "Being in space with a station in view",
  ),
  "remote-cap": entry(
    "remote-cap",
    "fleet",
    "Finds the fleet-mate on your grid with the emptiest capacitor, locks them, and runs your remote capacitor transmitters into them — the other half of keeping a fleet alive. Finishes when everyone on grid has a healthy capacitor.",
    "Being in space, with a remote capacitor transmitter fitted",
  ),
  "jettison-cargo": entry(
    "jettison-cargo",
    "hauling",
    "Dumps your cargo hold into space as a floating container — the jetcan a miner fills instead of flying home. Pick one item to dump just that, or leave it and the whole hold goes. Anything you jettison is out in the open where another pilot could take it.",
    "Being in space with something in the cargo hold",
  ),
  "jettison-ore": entry(
    "jettison-ore",
    "mining",
    "Dumps your ore hold into space as a floating container — the jetcan a mining loop fills for a hauler to pick up, without ever touching your cargo hold. Pick one item to dump just that, or leave it and the whole hold goes.",
    "Being in space with something in the ore hold",
  ),
  "tidy-hangar": entry(
    "tidy-hangar",
    "hauling",
    "Stacks everything loose in the station hangar into neat piles, so a long run does not leave you with fifty little heaps of the same thing.",
    "Being docked",
  ),
  "compress-ore": entry(
    "compress-ore",
    "mining",
    "Squeezes the ore in your hold down to a fraction of the room it took, using a mining support ship on your grid — your own, or a fleet-mate's, running its industrial core and compression gear. Flies into range first if it has to, then works through your hold one stack at a time. A hold that fits one trip's ore fits a whole session's once it is compressed.",
    "Being in space, with ore aboard and a support ship on grid running its compression gear",
  ),
  "launch-scan-probes": entry(
    "launch-scan-probes",
    "exploration",
    "Launches the probes EveJS reports as loaded and safe for your current ship, stopping when probes are active.",
    "Being in space, with an online probe launcher loaded",
  ),
  "analyze-signatures": entry(
    "analyze-signatures",
    "exploration",
    "Runs one signature analysis using the exact current probe positions and ranges reported by EveJS.",
    "Active scan probes in a formation",
  ),
  "recover-scan-probes": entry(
    "recover-scan-probes",
    "exploration",
    "Recovers every active probe belonging to this session back to the ship.",
    "Active scan probes in space",
  ),
};

export const MACRO_CATALOG: Readonly<Record<MacroID, MacroCatalogEntry>> = ENTRIES;

/** The palette list, in menu order. */
export const MACRO_CATALOG_LIST: readonly MacroCatalogEntry[] = MACRO_IDS.map((id) => ENTRIES[id]);

export function macroEntry(id: MacroID): MacroCatalogEntry {
  return ENTRIES[id];
}

/**
 * The categories that actually have at least one block, in CATEGORY_ORDER — the
 * chips the palette filter shows. A category with no shipped block yet (Market,
 * Fleet before their blocks land) is simply absent, so the filter never offers
 * an empty bucket.
 */
export function categoriesInUse(): readonly BlockCategory[] {
  const present = new Set(MACRO_CATALOG_LIST.map((e) => e.category));
  return CATEGORY_ORDER.filter((c) => present.has(c));
}
