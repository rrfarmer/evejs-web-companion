// The structural spec of each macro — which arguments it takes and whether it
// must carry an `until`. Shared so the codec (which REFUSES a bad file) and the
// editor's validator (which LISTS a draft's fixable problems) can never disagree
// about what a macro needs. The runtime behaviour of each macro is separate
// (nav/macros, slice B).

import type { Arg, MacroID } from "./botScript.ts";

export interface MacroArgSpec {
  readonly key: string;
  readonly kind: Arg["kind"];
  readonly required: boolean;
  /** Station-shaped argument which also accepts a dockable player structure. */
  readonly dockable?: boolean;
}

export interface MacroSpec {
  readonly args: readonly MacroArgSpec[];
  /** mine-at-belt has no end of its own; it is invalid without an `until`. */
  readonly untilRequired: boolean;
}

export const MACRO_SPECS: Readonly<Record<MacroID, MacroSpec>> = {
  undock: { args: [], untilRequired: false },
  "travel-to-station": {
    args: [{ key: "station", kind: "station", required: true, dockable: true }],
    untilRequired: false,
  },
  // Same belt arg as mine-at-belt (a pinned one, or "nearest") — just the trip,
  // no mining. For a hauler heading to a belt to pick up a jetcan a mining
  // loop dropped there, without ever sitting down to mine itself.
  "travel-to-belt": {
    args: [{ key: "belt", kind: "belt", required: true }],
    untilRequired: false,
  },
  // The arrival-waiting twin of set-destination: the same shared autopilot, but
  // the block does not finish until the ship IS in the system. Its argument is
  // its own `system` kind rather than `destination` so a station can never end
  // up in the slot — this block has no way to dock, and a station sitting here
  // would read as a trip it silently could not make.
  "travel-to-system": {
    args: [{ key: "system", kind: "system", required: true }],
    untilRequired: false,
  },
  "mine-at-belt": {
    args: [
      { key: "belt", kind: "belt", required: true },
      // Optional: left unset, the bot runs every mining module fitted, so the
      // player never has to pick equipment (belt auto-resolves to nearest too).
      { key: "equipment", kind: "equipment", required: false },
      // Optional: absent = "nearest", the shipped behaviour.
      { key: "pick", kind: "rockPick", required: false },
      // Optional: an ordered ore priority list (families by type group). Absent
      // or empty = any rock.
      { key: "ores", kind: "oreList", required: false },
    ],
    untilRequired: true,
  },
  "fleet-mine": {
    args: [
      { key: "support", kind: "character", required: true },
      { key: "belt", kind: "belt", required: false },
      { key: "equipment", kind: "equipment", required: false },
      { key: "pick", kind: "rockPick", required: false },
      { key: "ores", kind: "oreList", required: false },
    ],
    untilRequired: true,
  },
  "mining-support": { args: [], untilRequired: false },
  "join-support-fleet": { args: [{ key: "support", kind: "character", required: true }], untilRequired: false },
  "deliver-ore": {
    args: [
      { key: "station", kind: "station", required: true, dockable: true },
      // Optional: absent = the pilot's own hangar, the shipped behaviour. Set,
      // the load is aimed at that corporation division — and still lands in the
      // pilot's own hangar if the office or the role is not there when the ship
      // docks, because a hauler that cannot unload cannot fly another lap.
      { key: "into", kind: "corpDivision", required: false },
    ],
    untilRequired: false,
  },
  "defend-with-drones": { args: [], untilRequired: false },
  // ── The distribution-mission set. Every arg is OPTIONAL by design: the find
  // block defaults to level 1 / no lower-level fallback / any corp / any distance, and the later blocks
  // default to the agent/mission the find block published on the run's board —
  // so a bare wired-up chain of blocks is valid out of the box.
  "find-distribution-agent": {
    args: [
      { key: "level", kind: "count", required: false },
      { key: "fallback", kind: "toggle", required: false },
      { key: "maxJumps", kind: "count", required: false },
      { key: "corporation", kind: "corp", required: false },
    ],
    untilRequired: false,
  },
  "request-mission": {
    args: [{ key: "agent", kind: "agent", required: false }],
    untilRequired: false,
  },
  "accept-mission": {
    args: [{ key: "maxJumps", kind: "count", required: false }],
    untilRequired: false,
  },
  "load-mission-cargo": { args: [], untilRequired: false },
  "travel-to-dropoff": { args: [], untilRequired: false },
  "turn-in-mission": { args: [], untilRequired: false },
  "return-to-agent": { args: [], untilRequired: false },
  // A plain delay between blocks (defaults to 10 s when unset). The `until`
  // stays optional: "wait until shields are back above X" is `wait` + until.
  wait: { args: [{ key: "seconds", kind: "count", required: false }], untilRequired: false },
  // Docked: move EVERYTHING in the ship's cargo hold into the station hangar —
  // clears room before an accept-mission, tidies up after a lap.
  // `exceptBays` keeps named bays out of the unload — the ammo hold on a combat
  // hull, the fuel bay on a jump-capable one. Optional: absent means empty
  // everything, which is what the block says on the tin.
  "unload-cargo": {
    args: [
      { key: "exceptBays", kind: "bayList", required: false },
      { key: "keepItems", kind: "itemList", required: false },
      // Optional, as on deliver-ore: absent = the station hangar, the shipped
      // behaviour. Set, the unload is aimed at that corporation division.
      { key: "into", kind: "corpDivision", required: false },
    ],
    untilRequired: false,
  },
  // Docked: the mirror of unload-cargo. Take the named items OUT of the station
  // hangar and put each stack in whichever bay this hull wants it in — the
  // command centre hold, the planetary hold, the mining hold — falling back to
  // the cargo hold only for a stack no bay on this hull claims. It takes what
  // FITS and leaves the rest for the next lap, which is what makes a ten-trip
  // haul a loop rather than ten hand-written blocks.
  //
  // ⚠ `items` IS REQUIRED, UNLIKE unload-cargo's `keepItems`. The two blocks
  // default in opposite directions because their safe readings are opposite: an
  // unload with nothing named empties the ship into a hangar (recoverable), but
  // a load with nothing named would carry a station hangar's entire contents —
  // ships, modules, everything — off to another system. One entry can still say
  // "everything of this kind" (a group) or "everything called this" (a pattern),
  // so requiring it costs a player one click, not a dozen.
  "load-cargo": {
    args: [
      { key: "items", kind: "itemList", required: true },
      // Same meaning as on unload-cargo, and it has to be here for the same
      // reason: a bay a bot must not EMPTY is one it must not FILL either.
      { key: "exceptBays", kind: "bayList", required: false },
    ],
    untilRequired: false,
  },
  "haul-all": {
    args: [
      { key: "pickupStation", kind: "station", dockable: true, required: true },
      { key: "pickupCorpDivision", kind: "corpDivision", required: true },
      { key: "deliveryStation", kind: "station", dockable: true, required: true },
      { key: "deliveryCorpDivision", kind: "corpDivision", required: true },
      { key: "item", kind: "itemType", required: false },
      { key: "transportBay", kind: "place", required: false },
    ], untilRequired: false,
  },
  "route-hauler": {
    args: [
      { key: "stationA", kind: "station", dockable: true, required: true },
      { key: "stationB", kind: "station", dockable: true, required: true },
      { key: "pickupDivisionA", kind: "corpDivision", required: true },
      { key: "deliveryDivisionB", kind: "corpDivision", required: true },
      { key: "itemsAToB", kind: "itemList", required: false },
      { key: "returnCargo", kind: "toggle", required: false },
      { key: "pickupDivisionB", kind: "corpDivision", required: false },
      { key: "deliveryDivisionA", kind: "corpDivision", required: false },
      { key: "itemsBToA", kind: "itemList", required: false },
      { key: "transportBay", kind: "place", required: false },
    ], untilRequired: false,
  },
  // Sweep the grid's wrecks with salvage drones and/or fitted salvagers; done
  // when nothing salvageable is left. Loot only touches YOUR OWN wrecks.
  "salvage-wrecks": { args: [], untilRequired: false },
  "loot-wrecks": { args: [], untilRequired: false },
  // Empties every container on the grid — jetcans included. No ownership check.
  "loot-containers": { args: [], untilRequired: false },
  // Docked: run every ore stack in the station hangar through the refinery.
  "refine-ore": { args: [], untilRequired: false },
  // One press at the top of a fight/mine: switch on every fitted hardener that
  // has a cycle (an ordinary damage control has none — it works the moment it
  // is online). Done when they are all running.
  "hardeners-on": { args: [], untilRequired: false },
  // Guns + drones on the rat the priority list ranks first, next rat when it
  // dies; done when the grid is clear and the drones are home. Its own end, so
  // no until required. `targets` is OPTIONAL by design: unset, the block runs
  // the shipped ladder (tackle, then ewar, then logi, then everything else,
  // nearest first inside a class) — which is what it always did, plus a reason.
  "fight-the-rats": {
    args: [
      { key: "targets", kind: "targetList", required: false },
      { key: "squad", kind: "squadRole", required: false },
    ],
    untilRequired: false,
  },
  // The drone boat's combat block. EVERY argument is optional by design and a
  // bare block is valid: unset, it runs the shipped target ladder, flies alone,
  // computes its own stand-off band from what the pirates on grid can reach, and
  // uses a prop mod only to close a gap. The two overrides exist for the pilot
  // whose fit the read cannot describe — `holdRangeKm` because drone control
  // range is skill-derived and frequently unreadable, `propulsion` because a
  // burner's signature bloom is sometimes a worse trade than the distance.
  //
  // ⚠ `holdRangeKm` IS KILOMETRES. The block's decision core takes metres; the
  // adapter multiplies. See the arg kind's own comment in botScript.ts.
  "fight-with-drones": {
    args: [
      { key: "targets", kind: "targetList", required: false },
      { key: "squad", kind: "squadRole", required: false },
      { key: "holdRangeKm", kind: "distanceKm", required: false },
      { key: "propulsion", kind: "propMode", required: false },
    ],
    untilRequired: false,
  },
  // Warp to the next unvisited COMBAT anomaly in this system (the scanner's own
  // list, filtered by the site's scan-strength attribute). Done on arrival;
  // blocked when the system has none left this run.
  "warp-to-anomaly": { args: [], untilRequired: false },
  // The same block for ORE anomalies — asteroid clusters, ice belts. Argless
  // for the same reason: which site is "next" can only be answered at run time.
  "warp-to-ore-anomaly": { args: [], untilRequired: false },
  // Docked: board a hull of the fitting's ship type if needed, then apply the
  // saved fitting — the "reship and go" block.
  "refit-ship": {
    args: [{ key: "fitting", kind: "fitting", required: true }],
    untilRequired: false,
  },
  // Docked: board the hull refit-ship swapped out earlier in this run. No
  // args: the hull is whatever this run was flying, read off the run's board.
  "board-previous-ship": { args: [], untilRequired: false },
  // Docked: board a ship parked here that has a planetary hold, as fitted.
  // No args: the hold is read off each hull, never picked by the player.
  "board-planetary-hauler": { args: [], untilRequired: false },
  // Docked: move an item between the hangar and the ship's holds. `amount`
  // absent = move ALL of that item.
  "move-items": {
    args: [
      { key: "item", kind: "itemType", required: true },
      { key: "from", kind: "place", required: true },
      { key: "to", kind: "place", required: true },
      { key: "amount", kind: "count", required: false },
    ],
    untilRequired: false,
  },
  // In space, in the bookmark's system: warp to a saved spot (a mission site, a
  // safe spot). Done once the warp lands.
  "warp-to-bookmark": {
    args: [{ key: "bookmark", kind: "bookmark", required: true }],
    untilRequired: false,
  },
  // Anywhere: take up and switch on the bookmark folders a bot works from, by
  // name. Done when every one is on.
  "use-bookmark-folders": {
    args: [
      { key: "folder", kind: "bookmarkFolder", required: true },
      { key: "alsoFolder", kind: "bookmarkFolder", required: false },
    ],
    untilRequired: false,
  },
  // The salvager's lap: sites from one folder, finished sites filed in
  // another, the hold emptied at a station, and a wait docked there when no
  // site is left. Never finishes on its own.
  "salvage-bookmarked-sites": {
    args: [
      { key: "fromFolder", kind: "bookmarkFolder", required: true },
      { key: "doneFolder", kind: "bookmarkFolder", required: true },
      { key: "station", kind: "station", required: true, dockable: true },
      { key: "into", kind: "corpDivision", required: false },
      { key: "keepItems", kind: "itemList", required: false },
    ],
    untilRequired: false,
  },
  // The combat twin of find-distribution-agent: same criteria, security agents.
  "find-combat-agent": {
    args: [
      { key: "level", kind: "count", required: false },
      { key: "maxJumps", kind: "count", required: false },
      { key: "corporation", kind: "corp", required: false },
    ],
    untilRequired: false,
  },
  // Warp to the accepted mission's own site (the journal's marked spot, asked of the mission's agent).
  "fly-to-mission-site": { args: [], untilRequired: false },
  // Restart every EXPIRED extractor program across all colonies, reusing each
  // extractor's own last resource. Runs from anywhere (PI is remote).
  "restart-extractors": { args: [], untilRequired: false },
  // Goods leave a colony only through its command centre. `fullPercent` is
  // OPTIONAL: left unset, the block waits for the centre to reach the shipped
  // default (80) before it launches what it is holding.
  "launch-commodities": {
    args: [
      { key: "fullPercent", kind: "count", required: false },
      // Explicitly bypass the fill threshold for an immediate haul. Empty
      // centres and launch cooldowns still keep their usual guards.
      { key: "anyAmount", kind: "toggle", required: false },
      // Optional: absent = every colony, the shipped behaviour. The Haul
      // button sets it to the colonies the player ticked.
      { key: "planets", kind: "planetList", required: false },
    ],
    untilRequired: false,
  },
  // In space: empty every launch container of yours in THIS system into the
  // ship. No args: the server's own launch list says where each one is.
  "collect-launches": { args: [], untilRequired: false },
  // In space: empty every customs office in THIS system that holds goods of
  // yours into the ship. No args: an office is found by its group, and what it
  // lists is this pilot's own, so there is nothing to name.
  "collect-customs": { args: [], untilRequired: false },
  // Docked: quote the active ship + its fitted modules at the repair shop and
  // fix whatever is damaged (the station charges the wallet).
  "repair-ship": { args: [], untilRequired: false },
  // ── The market set (docked). Every arg is REQUIRED: an order with no item,
  // no price or (for a buy) no quantity is meaningless, so the block will not
  // start until they are set. Prices are ISK per unit; the server confirm-gates
  // every order and charges the broker fee.
  "buy-item": {
    args: [
      { key: "item", kind: "itemType", required: true },
      { key: "quantity", kind: "qty", required: true },
      { key: "price", kind: "isk", required: true },
    ],
    untilRequired: false,
  },
  "sell-item": {
    args: [
      { key: "item", kind: "itemType", required: true },
      { key: "price", kind: "isk", required: true },
    ],
    untilRequired: false,
  },
  // ── The fleet-support set (in space). Both argless: they read the grid and the
  // fitted remote reps, so there is nothing to pick.
  //   • remote-rep is reactive — done once no friendly on grid is hurt.
  //   • orbit-and-boost is sustained — it stays on the fleet and never ends on
  //     its own (stopped by a watch or by hand), so no `until` is forced.
  "remote-rep": { args: [], untilRequired: false },
  "orbit-and-boost": { args: [], untilRequired: false },
  // orbit-and-boost's named-target twin. `who` is REQUIRED — "orbit nobody" is
  // not a meaningful step, unlike orbit-and-boost's argless "whoever is nearest".
  "orbit-fleet-mate": {
    args: [{ key: "who", kind: "character", required: true }],
    untilRequired: false,
  },
  // Same shape as orbit-fleet-mate — a named pilot, required for the same reason.
  "follow-fleet-mate": {
    args: [{ key: "who", kind: "character", required: true }],
    untilRequired: false,
  },
  // Argless: it picks its own target off the same priority ladder the combat
  // blocks use (targetPriorityOf's default when unset) and reads its own
  // commander status off the fleet roster — nothing here for a player to pick.
  // Sustained like orbit-and-boost: never finishes on its own.
  "fleet-tag-target": { args: [], untilRequired: false },
  // ── The fleet-management set (multibox alt-fleeting). create/join are argless;
  // invite names WHO to bring in (a character from your known-pilots roster).
  "create-fleet": { args: [], untilRequired: false },
  "invite-to-fleet": {
    args: [{ key: "who", kind: "character", required: true }],
    untilRequired: false,
  },
  "join-fleet": { args: [], untilRequired: false },
  // The fleet-finder twin of join-fleet: instead of waiting to be invited, it
  // looks the fleet up by NAME in the advert listing and applies. Opportunistic
  // by design (see the decider) - the name is the whole argument, a plain `text`
  // rather than an id, because an advert's fleetID is minted fresh every time the
  // boss forms up and could never be saved in a script.
  "join-advertised-fleet": {
    args: [{ key: "fleetName", kind: "text", required: true }],
    untilRequired: false,
  },
  // ── Movement extras.
  // set-destination points the autopilot at a station OR a whole system and is
  // done once the trip is under way — it does not wait for the arrival, so a
  // player can follow it with their own checks. The destination is required:
  // there is nothing to set without one.
  "set-destination": {
    args: [{ key: "destination", kind: "destination", required: true }],
    untilRequired: false,
  },
  // Argless: "nearest" is computed from the grid at run time, which is the whole
  // point (a station picked now would not be the nearest one later).
  "dock-at-nearest": { args: [], untilRequired: false },
  // ── Fleet support: same shape as remote-rep, argless for the same reason.
  "remote-cap": { args: [], untilRequired: false },
  // ── Cargo extras. Jettison takes an OPTIONAL item filter: absent = the whole
  // cargo hold goes into the can, set = only that item type.
  // `keepItems` matters more here than anywhere: a jettisoned stack goes into a
  // can that despawns, so this is the one block where getting it wrong cannot
  // be undone.
  "jettison-cargo": {
    args: [
      { key: "item", kind: "itemType", required: false },
      { key: "keepItems", kind: "itemList", required: false },
    ],
    untilRequired: false,
  },
  // Same optional item filter as jettison-cargo, but empties the ORE hold (or
  // whichever specialty hold — ice, gas — the ship has) instead of the cargo
  // hold: a mining ship's hold, not its otherwise-empty cargo bay.
  "jettison-ore": {
    args: [{ key: "item", kind: "itemType", required: false }],
    untilRequired: false,
  },
  "tidy-hangar": { args: [], untilRequired: false },
  // ── Mining extra. Argless: the facility is whatever support ship is on grid
  // (its range is the server's check, and "which one" can only be answered at run
  // time), and the ore is whatever is in the hold.
  "compress-ore": { args: [], untilRequired: false },
  "launch-scan-probes": { args: [], untilRequired: false },
  "analyze-signatures": { args: [], untilRequired: false },
  "recover-scan-probes": { args: [], untilRequired: false },
};

/** How full a command centre must get before `launch-commodities` fires. */
export const LAUNCH_FULL_PERCENT_DEFAULT = 80;

/**
 * The launch threshold this step will actually use, as a percentage.
 *
 * ⚠ ONE CLAMP, TWO READERS. The block's sentence in the editor and the decider
 * that fires the launch must agree, and nothing stops a player typing 0 or 500
 * into a `count` arg — validateScript bounds loop repeats and nothing else. Two
 * separate clamps would drift, and the way that shows up is a bot doing
 * something its own description said it would not.
 */
export function launchFullPercent(arg: Arg | undefined, anyAmount: Arg | undefined = undefined): number {
  if (anyAmount?.kind === "toggle" && anyAmount.enabled) {
    return 0;
  }
  if (arg === undefined || arg.kind !== "count" || !Number.isFinite(arg.value)) {
    return LAUNCH_FULL_PERCENT_DEFAULT;
  }
  return Math.min(100, Math.max(1, Math.round(arg.value)));
}
