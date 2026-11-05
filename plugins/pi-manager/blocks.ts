// The PI Manager's bot blocks: restart the extractors, launch from the command
// centres, collect launches and customs offices, and board a planetary hauler.
//
// Each block decides one tick at a time from what the bot sees and returns one
// of core's actions (restart an extractor, launch, warp, loot, board a ship):
// every game call is core's, the choices are the plugin's. They run in the
// page for a bot the page flies, and in this plugin's own process for a bot the
// BFF hosts (src/pluginHost.js), so they use no DOM and no Node API.
//
// Moved from core (nav/scriptMacros.ts), where they were the blocks
// "restart-extractors", "launch-commodities", "collect-launches",
// "collect-customs" and "board-planetary-hauler"; a script saved with those ids
// is read as these (`formerly`).

import {
  ACTING,
  LOOT_RANGE_M,
  MAX_BLOCK_ATTEMPTS,
  STALL_REORDER_WHY,
  STALL_STUCK_REASON,
  STALL_STUCK_WHY,
  STALL_UNSTICK_WHY,
  WAIT,
  boardParkedShip,
  clearCloseInStall,
  closeInStall,
  distanceMeters,
  dockedAt,
  flag,
  holdsFreeM3,
  isUnreachable,
  measureSpace,
  nearest,
  num,
  pilotCannotPay,
  recallBeforeLeaving,
  scriptTravelHome,
  shipHasNoRoom,
  shouldSetAside,
  tick,
  warpIssuedMem,
  warpLanded,
  without,
  type SpaceEntity,
  type SpaceSnapshot,
} from "../../web/src/plugin-api/blocks.ts";
import type { Arg, MacroDecider, MacroMemory, MacroStep, PluginMacro, ScriptObservation } from "../../web/src/plugin-api/index.ts";

/** How full a command centre must get before the launch block fires. */
export const LAUNCH_FULL_PERCENT_DEFAULT = 80;

/**
 * The launch threshold this step will actually use, as a percentage.
 *
 * ⚠ ONE CLAMP, TWO READERS. The block's sentence in the editor and the decider
 * that fires the launch must agree, and nothing stops a player typing 0 or 500
 * into a `count` arg. Two separate clamps would drift, and the way that shows
 * up is a bot doing something its own description said it would not.
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

// ── restart-extractors ───────────────────────────────────────────────────────
// Walk every colony and restart each extractor whose program has EXPIRED — on
// the SAME resource it was already pulling, over the SAME drill area (never a
// guess — the area is what sets how long the program runs). One restart per
// tick, confirmed by the next colonies re-read (the expiry moves into the
// future); a pin with no known last resource or area is left alone and said so.
//
// ⚠ A RESTART THAT DID NOT TAKE ENDS THE RUN BLOCKED, NOT DONE. Each pin is
// tried once per run, so after the walk every tried pin must read as running
// again. One still expired was refused — and a run that tried four extractors,
// had all four refused and then said "Every extractor is running." is exactly
// what this used to do.
export const restartExtractors: MacroDecider = (_step, obs, mem) => {
  const colonies = obs.colonies ?? null;
  if (colonies === null) {
    return tick(WAIT, "Reading your planet colonies.", "Restarting extractors", ACTING, false, mem);
  }
  if (colonies.length === 0) {
    return tick(WAIT, "You have no planet colonies.", "Restarting extractors", { kind: "done" });
  }
  const now = Date.now();
  // ⚠ THE CAP IS SIZED TO THE ROSTER. Restarts and reroutes share one count of
  // actions, and each extractor can take at most one of each per run (both
  // are tried once per pin). A fixed cap stopped a roster of twelve expired
  // extractors on its 21st action with every edit having landed; this one
  // only ever stops a run that is somehow repeating itself.
  const budget = 2 * colonies.reduce((total, colony) => total + colony.extractors.length, 0) + MAX_BLOCK_ATTEMPTS;
  const doneRaw = mem["restarted"];
  const restarted = new Set<number>(Array.isArray(doneRaw) ? (doneRaw as number[]) : []);
  let skippedUnknown = 0;
  for (const colony of colonies) {
    for (const pin of colony.extractors) {
      if (restarted.has(pin.pinID)) {
        continue;
      }
      const expired = pin.expiresAtMs !== null && pin.expiresAtMs <= now;
      const neverRan = pin.expiresAtMs === null;
      if (!expired && !neverRan) {
        continue; // still running — leave it be
      }
      if (pin.resourceTypeID === null) {
        skippedUnknown += 1;
        continue; // no last resource to reuse — never guess what to pull
      }
      const headRadius = pin.headRadius ?? null;
      if (headRadius === null) {
        skippedUnknown += 1;
        continue; // no last drill area — never guess how long it should run
      }
      const attempts = (num(mem, "attempts") ?? 0) + 1;
      if (attempts > budget) {
        return tick(WAIT, "The restarts kept not landing.", "Restarting extractors", {
          kind: "blocked",
          reason: "The extractor restarts kept not taking, so the bot stopped.",
        });
      }
      return tick(
        {
          kind: "restartExtractor",
          planetID: colony.planetID,
          pinID: pin.pinID,
          resourceTypeID: pin.resourceTypeID,
          headRadius,
        },
        colony.planetName !== null ? `Restarting an extractor at ${colony.planetName}.` : "Restarting an extractor.",
        "Restarting extractors",
        ACTING,
        false,
        { ...mem, attempts, restarted: [...restarted, pin.pinID] },
      );
    }
  }
  // Every tried pin must now read as running. This read is the one taken
  // AFTER the last restart, so a pin still expired here was refused.
  let notTaken = 0;
  for (const colony of colonies) {
    for (const pin of colony.extractors) {
      if (restarted.has(pin.pinID) && (pin.expiresAtMs === null || pin.expiresAtMs <= now)) {
        notTaken += 1;
      }
    }
  }
  if (notTaken > 0) {
    const noun = notTaken === 1 ? "restart" : "restarts";
    return tick(WAIT, `${notTaken} extractor ${noun} did not take.`, "Restarting extractors", {
      kind: "blocked",
      reason: `${notTaken} of ${restarted.size} extractor ${restarted.size === 1 ? "restart" : "restarts"} did not take - the server refused ${notTaken === 1 ? "it" : "them"}. The bot log names the reason.`,
    });
  }
  // ── Then the routes. A new program yields a different maximum cycle, and the
  // server never grows routes to fit it; the retail client re-sizes them in the
  // same edit as the install. So, once the restarts have landed and the new
  // maxima are stated, every extractor whose storage routes reserve less gets
  // them removed and recreated at the retail split - restarted this run or an
  // earlier one, since both leave the colony flagged in the game. Same rules
  // as the restarts: one per tick, each pin tried once, and one still short
  // after its edit was refused.
  const reroutedRaw = mem["rerouted"];
  const rerouted = new Set<number>(Array.isArray(reroutedRaw) ? (reroutedRaw as number[]) : []);
  for (const colony of colonies) {
    for (const plan of colony.reroutes ?? []) {
      if (rerouted.has(plan.pinID)) continue;
      const attempts = (num(mem, "attempts") ?? 0) + 1;
      if (attempts > budget) {
        return tick(WAIT, "The reroutes kept not landing.", "Rerouting extractors", {
          kind: "blocked",
          reason: "The extractor reroutes kept not taking, so the bot stopped.",
        });
      }
      return tick(
        {
          kind: "rerouteExtractor",
          planetID: plan.planetID,
          pinID: plan.pinID,
          removeRouteIDs: plan.removeRouteIDs,
          create: plan.create,
        },
        colony.planetName !== null
          ? `Re-sizing an extractor's routes at ${colony.planetName}.`
          : "Re-sizing an extractor's routes.",
        "Rerouting extractors",
        ACTING,
        false,
        { ...mem, attempts, rerouted: [...rerouted, plan.pinID] },
      );
    }
  }
  let rerouteNotTaken = 0;
  for (const colony of colonies) {
    for (const plan of colony.reroutes ?? []) {
      if (rerouted.has(plan.pinID)) rerouteNotTaken += 1;
    }
  }
  if (rerouteNotTaken > 0) {
    const noun = rerouteNotTaken === 1 ? "reroute" : "reroutes";
    return tick(WAIT, `${rerouteNotTaken} extractor ${noun} did not take.`, "Rerouting extractors", {
      kind: "blocked",
      reason: `${rerouteNotTaken} extractor ${noun} did not take - the server refused ${rerouteNotTaken === 1 ? "it" : "them"}, so those routes still carry less than the program yields. The bot log names the reason.`,
    });
  }
  if (skippedUnknown > 0) {
    return tick(
      WAIT,
      `Done - ${skippedUnknown} extractor${skippedUnknown === 1 ? "" : "s"} had no previous programme to reuse and ${skippedUnknown === 1 ? "was" : "were"} left alone.`,
      "Restarting extractors",
      { kind: "done" },
    );
  }
  return tick(WAIT, "Every extractor is running.", "Restarting extractors", { kind: "done" });
};

// ── launch-commodities ───────────────────────────────────────────────────────
// Walk every colony and launch what its command centre is holding into orbit,
// one launch per tick. ONLY a "command" pin is ever targeted - the emulator
// refuses every other pin with CanOnlyLaunchFromCommandCenters, so a
// launchpad or storage pin sitting full of goods is left alone by design, no
// matter how full it reads. A centre inside 60s of its own last launch is
// refused with CannotLaunchCommandPinNotReady; that is not a block failure,
// just a "not yet" for this tick, so it is skipped without stopping the run.
// Fired centres are remembered in mem so the same one is not fired again
// before a fresh colonies re-read shows it emptied - exactly the guard
// restartExtractors keeps for restarted pins.
export const launchCommodities: MacroDecider = (step, obs, mem) => {
  const colonies = obs.colonies ?? null;
  if (colonies === null) {
    return tick(WAIT, "Reading your planet colonies.", "Launching commodities", ACTING, false, mem);
  }
  if (colonies.length === 0) {
    return tick(WAIT, "You have no planet colonies.", "Launching commodities", { kind: "done" });
  }
  const now = Date.now();
  // ⚠ THE EDITOR'S OWN SENTENCE READS THIS SAME FUNCTION. The block's
  // description says "once it is N% full", and nothing bounds a count arg, so
  // a second clamp here would eventually drift from the one on screen - and a
  // bot doing something its own description denied is the defect that matters.
  const fullPercent = launchFullPercent(step.args["fullPercent"], step.args["anyAmount"]);
  const doneRaw = mem["launched"];
  const launched = new Set<number>(Array.isArray(doneRaw) ? (doneRaw as number[]) : []);
  // Limited to the colonies the step names, when it names any (the PI
  // window's Haul button does); absent, every colony, as it always was.
  const planetsArg = step.args["planets"];
  const only = planetsArg !== undefined && planetsArg.kind === "planetList" && planetsArg.planets.length > 0
    ? new Set(planetsArg.planets.map((planet) => planet.planetID))
    : null;
  let waitingOnCooldown = 0;
  for (const colony of colonies) {
    if (only !== null && !only.has(colony.planetID)) {
      continue;
    }
    for (const pin of colony.pins) {
      if (pin.kind !== "command") {
        continue; // goods reach orbit ONLY from the command centre - never a launchpad or storage pin
      }
      if (launched.has(pin.pinID)) {
        continue;
      }
      if (pin.contents.length === 0) {
        continue; // nothing aboard to launch
      }
      // ⚠ Both volumes may be null (bridge/planets.ts) - never divide then.
      // The contents check above already established "holding something",
      // which is the fallback answer when the fill fraction can't be stated.
      const ready =
        pin.capacityM3 !== null && pin.capacityM3 > 0 && pin.usedM3 !== null
          ? pin.usedM3 / pin.capacityM3 >= fullPercent / 100
          : true;
      if (!ready) {
        continue;
      }
      if (pin.lastLaunchAtMs !== null && now - pin.lastLaunchAtMs < 60_000) {
        waitingOnCooldown += 1;
        continue; // CannotLaunchCommandPinNotReady - not yet, not a block
      }
      const attempts = (num(mem, "attempts") ?? 0) + 1;
      if (attempts > MAX_BLOCK_ATTEMPTS * 4) {
        return tick(WAIT, "The launches kept not landing.", "Launching commodities", {
          kind: "blocked",
          reason: "The commodity launches kept not taking, so the bot stopped.",
        });
      }
      const commodities: Record<number, number> = {};
      for (const item of pin.contents) {
        commodities[item.typeID] = item.quantity;
      }
      return tick(
        { kind: "launchCommodities", planetID: colony.planetID, commandPinID: pin.pinID, commodities },
        colony.planetName !== null ? `Launching commodities from ${colony.planetName}.` : "Launching commodities.",
        "Launching commodities",
        ACTING,
        false,
        { ...mem, attempts, launched: [...launched, pin.pinID] },
      );
    }
  }
  if (waitingOnCooldown > 0) {
    return tick(
      WAIT,
      `Waiting on ${waitingOnCooldown} command centre${waitingOnCooldown === 1 ? "" : "s"} to clear ${waitingOnCooldown === 1 ? "its" : "their"} launch cooldown.`,
      "Launching commodities",
      ACTING,
      false,
      mem,
    );
  }
  return tick(WAIT, "Every command centre is empty or below the launch threshold.", "Launching commodities", { kind: "done" });
};

// ── collect-launches ─────────────────────────────────────────────────────────
// The hauler's half of launch-commodities. A launch leaves a Planetary Launch
// Container (type 2263) in space, owned by the launching pilot, for five days.
// This block takes the pilot's own launch list, keeps the ones in THIS system,
// and for each one: warps to the container, closes inside loot range, and
// empties it into the ship (bay routing puts planetary goods in an Epithal's
// planetary hold). The dispatch then deletes the launch record once a re-read
// shows the container empty, so the next tick's list no longer carries it.
//
// ⚠ THE CONTAINER IS NOT ON THE PLANET'S GRID. The server puts it 2,500 km
// past the planet's surface (never under 10,000 km from its centre), in a
// direction hashed from the launch, so "warp to the planet" lands nowhere
// near it. The block warps to the container ITSELF: the server resolves a
// warp target system-wide (warpCommands.js warpToEntity), no grid needed.
//
// ⚠ A LAUNCH NOT FOUND WHERE IT SHOULD BE IS SET ASIDE, NOT A STOP. A launch
// that burned up, or a container the server never spawned, must not keep the
// rest of the system's launches from being collected.
const PI_LAUNCH_DECAY_MS = 5 * 24 * 60 * 60 * 1000;
// Retail will not warp to something this close; inside it, fly there.
const LAUNCH_WARP_MIN_M = 150_000;
// Ticks to keep looking for a container after landing on it before believing
// it is not there. Snapshots can trail a landing by a tick or two.
const LAUNCH_LANDED_SETTLE_TICKS = 10;

export const collectLaunches: MacroDecider = (step, obs, mem) => {
  const phase = "Collecting launches";
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked - launches are collected in space.", phase, {
      kind: "blocked",
      reason: "Undock first - put a Leave-the-station block before this one.",
    });
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp to a launch.", phase, ACTING, false, { ...mem, sawWarp: true });
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", phase, ACTING, false, mem);
  }
  // A full ship is a finished trip, exactly as on the loot blocks: go unload.
  const freeM3 = holdsFreeM3(obs.holds ?? null);
  if (freeM3 !== null && freeM3 <= 0) {
    return tick(WAIT, "The ship is full, so it is time to unload.", phase, { kind: "done" });
  }
  if (shipHasNoRoom(obs.refusals, step.id, "collectLaunch")) {
    return tick(WAIT, "Nothing aboard will take any more, so it is time to unload.", phase, { kind: "done" });
  }
  const launches = obs.piLaunches ?? null;
  if (launches === null) {
    const blindChecks = (num(mem, "blindChecks") ?? 0) + 1;
    if (blindChecks > MAX_BLOCK_ATTEMPTS * 2) {
      return tick(WAIT, "Your planet launches could not be read.", phase, {
        kind: "blocked",
        reason: "Your planet launches could not be read, so the bot cannot tell what there is to collect.",
      });
    }
    return tick(WAIT, "Reading your planet launches.", phase, ACTING, false, { ...mem, blindChecks });
  }
  const here = snapshot.solarSystemID;
  const now = Date.now();
  const missingRaw = mem["missing"];
  const missing = new Set<number>(Array.isArray(missingRaw) ? (missingRaw as number[]) : []);
  const candidates = launches.filter(
    (launch) =>
      launch.solarSystemID === here &&
      launch.itemID > 0 &&
      !missing.has(launch.itemID) &&
      (launch.launchedAtMs === null || now - launch.launchedAtMs < PI_LAUNCH_DECAY_MS) &&
      !shouldSetAside(obs.refusals, step.id, "collectLaunch", launch.itemID, MAX_BLOCK_ATTEMPTS),
  );
  if (candidates.length === 0) {
    const elsewhere = launches.filter((launch) => launch.solarSystemID !== here).length;
    return tick(
      WAIT,
      elsewhere > 0
        ? `Every launch in this system is collected (${elsewhere} more in other systems).`
        : "Every launch in this system is collected.",
      phase,
      { kind: "done" },
    );
  }
  // Nearest first, by the server's own coordinates for each container.
  const origin = snapshot.ship?.position ?? null;
  const away = (launch: (typeof candidates)[number]): number =>
    origin === null ? 0 : distanceMeters(origin, { x: launch.x, y: launch.y, z: launch.z });
  const target = [...candidates].sort((a, b) => away(a) - away(b))[0]!;
  const measurement = measureSpace(snapshot);
  const onGrid = snapshot.entities.some((entity) => entity.itemID === target.itemID);
  const dist = onGrid
    ? (measurement?.distances.get(target.itemID) ?? away(target))
    : away(target);

  if (!onGrid || dist > LAUNCH_WARP_MIN_M) {
    if (num(mem, "warpingTo") === target.itemID && flag(mem, "issued")) {
      if (warpLanded(obs, mem)) {
        // Landed on it and still cannot see it: give the snapshot a moment,
        // then set this launch aside and go on to the next.
        const landedChecks = (num(mem, "landedChecks") ?? 0) + 1;
        if (landedChecks > LAUNCH_LANDED_SETTLE_TICKS) {
          return tick(WAIT, "That launch container is not where the list says - skipping it.", phase, ACTING, false, {
            missing: [...missing, target.itemID],
          });
        }
        return tick(WAIT, "Looking for the launch container.", phase, ACTING, false, { ...mem, landedChecks });
      }
      const waited = (num(mem, "waited") ?? 0) + 1;
      if (waited > 10) {
        return tick(WAIT, "The warp to that launch never started - skipping it.", phase, ACTING, false, {
          missing: [...missing, target.itemID],
        });
      }
      return tick(WAIT, "Waiting for the warp to start.", phase, ACTING, false, { ...mem, waited });
    }
    // Never warp off with drones still out.
    const recall = recallBeforeLeaving(obs, mem, phase, null);
    if (recall !== null) {
      return recall;
    }
    // As the client's journal warps to a launch: by the launch's own ID. A row
    // with no launch ID has only its container to name.
    return tick(
      target.launchID > 0 ? { kind: "warpLaunch", launchID: target.launchID } : { kind: "warp", targetID: target.itemID },
      "Warping to a launch container.",
      phase,
      ACTING,
      false,
      { missing: [...missing], warpingTo: target.itemID, ...warpIssuedMem(obs) },
    );
  }
  const memBase: MacroMemory = { missing: [...missing], approaching: num(mem, "approaching") };
  // The server's range check beats our arithmetic, as on loot-containers.
  const unreachable = isUnreachable(obs.refusals, step.id, "collectLaunch", target.itemID);
  if (dist > LOOT_RANGE_M || unreachable) {
    if (!unreachable && num(mem, "approaching") === target.itemID) {
      const stall = closeInStall(measurement?.shipMode ?? null, { ...mem, ...memBase });
      if (stall.step === "reorder") {
        return tick({ kind: "approach", targetID: target.itemID }, STALL_REORDER_WHY, phase, ACTING, true, stall.mem);
      }
      if (stall.step === "unstick") {
        return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, phase, ACTING, true, stall.mem);
      }
      if (stall.step === "stuck") {
        return tick(WAIT, STALL_STUCK_WHY, phase, { kind: "blocked", reason: STALL_STUCK_REASON });
      }
      return tick(WAIT, "Flying to the launch container.", phase, ACTING, true, stall.mem);
    }
    return tick(
      { kind: "approach", targetID: target.itemID },
      unreachable ? "Too far to reach it, closing in." : "Heading for the launch container.",
      phase,
      ACTING,
      true,
      clearCloseInStall({ ...memBase, approaching: target.itemID }),
    );
  }
  return tick(
    { kind: "collectLaunch", containerID: target.itemID, launchID: target.launchID },
    "Taking the goods out of the launch container.",
    phase,
    ACTING,
    true,
    { ...memBase, approaching: null },
  );
};


// ── collect-customs ──────────────────────────────────────────────────────────
// The hauler's half of the customs-office export. A colony's launchpad goods go
// up into the planet's own customs office (this block sends them up at the
// office, on the pilot's own session, as the client's customs window does),
// and this block empties every office in THIS system that holds goods of the
// pilot's into the ship.
//
// ⚠ AN OFFICE IS NOT A LAUNCH CONTAINER, which is why this is its own block.
// A launch container is spawned per launch, is listed by the server
// (GetMyLaunchesDetails), despawns when its record is deleted and decays in five
// days. An office is a STRUCTURE: there is one per planet, it is never listed as
// "something to collect", it does not vanish when emptied, and nothing says
// whether it holds anything without reading it. So "done" here is a READ saying
// every office in this system is empty, not a list running out.
//
// ⚠ EVERY OFFICE IN THE SYSTEM, NOT THE TICKED ONES. The block takes no args on
// purpose. The offices that hold anything are the ones something was exported
// into, and an office still holding goods from a lap that was interrupted is
// exactly what a hauler arriving here should pick up - naming colonies would
// walk past it. The office's own storage is partitioned by depositor server-side,
// so what it lists is this pilot's and nobody else's.
//
// ⚠ THE OFFICE IS FOUND BY GROUP, NEVER BY NAME OR POSITION. Group 1025 is
// Planetary Customs Offices, both the synthesized InterBus office every
// uncolonised planet carries and an anchored POCO; a gantry or a construction
// platform is a different group and holds nothing.
const GROUP_PLANETARY_CUSTOMS_OFFICES = 1025;
/**
 * Ticks to keep looking for an office before believing a system has none.
 *
 * ⚠ AN EMPTY GRID READ IS NOT AN EMPTY SYSTEM. A customs office is a static
 * entity and arrives in every snapshot of its system, but the tick that lands
 * after a gate jump can still see a sparse one - and "there is no office here"
 * finishes the block, which would walk the hauler straight past a full office.
 * Generous on purpose: the block has nothing better to do than wait.
 */
const CUSTOMS_SETTLE_TICKS = 15;

/** Every customs office in this snapshot, nearest first. */
function customsOfficesOnGrid(snapshot: SpaceSnapshot): readonly SpaceEntity[] {
  const origin = snapshot.ship?.position ?? null;
  const away = (entity: SpaceEntity): number =>
    origin === null ? 0 : distanceMeters(origin, entity.position);
  return snapshot.entities
    .filter((entity) => entity.groupID === GROUP_PLANETARY_CUSTOMS_OFFICES && entity.itemID > 0)
    .sort((left, right) => away(left) - away(right));
}

/**
 * The launchpads of the colony on an office's planet that hold goods and have
 * not been given up on: what the retail client's customs window would send up
 * from that office, less what the colony's factories are fed. None where the
 * office does not say its planet (the web gateway's snapshot), or where the
 * colonies were not read.
 */
function launchpadsToSendUp(
  office: SpaceEntity,
  obs: ScriptObservation,
  stepID: string,
): readonly { readonly pinID: number; readonly commodities: Readonly<Record<number, number>>; readonly leftAlone: boolean }[] {
  // An office that does not say its planet is no colony's: null matches none.
  const planetID = office.planetID ?? null;
  const pads: { pinID: number; commodities: Record<number, number>; leftAlone: boolean }[] = [];
  for (const colony of obs.colonies ?? []) {
    if (colony.planetID !== planetID) {
      continue;
    }
    // ⚠ ONLY WHAT THE COLONY MAKES. A launchpad can be a colony's only store,
    // holding the imports its factories run on beside their output. A route
    // into a factory says which is which, and an input stays on the planet.
    const inputs = new Set(colony.factoryInputTypeIDs ?? []);
    for (const pin of colony.pins) {
      if (pin.kind !== "launchpad") {
        continue; // only a spaceport's goods go up through an office
      }
      const commodities: Record<number, number> = {};
      for (const item of pin.contents) {
        if (!inputs.has(item.typeID)) {
          commodities[item.typeID] = item.quantity;
        }
      }
      if (Object.keys(commodities).length === 0) {
        continue;
      }
      pads.push({
        pinID: pin.pinID,
        commodities,
        leftAlone: shouldSetAside(obs.refusals, stepID, "exportCustoms", pin.pinID, MAX_BLOCK_ATTEMPTS),
      });
    }
  }
  return pads;
}

export const collectCustoms: MacroDecider = (step, obs, mem) => {
  const phase = "Collecting from the customs offices";
  if (obs.flightStatus?.docked === true) {
    return tick(WAIT, "Docked - an office is emptied from space.", phase, {
      kind: "blocked",
      reason: "Undock first - put a Leave-the-station block before this one.",
    });
  }
  const snapshot = obs.snapshot ?? null;
  if (obs.inWarp === true) {
    return tick(WAIT, "In warp to a customs office.", phase, ACTING, false, { ...mem, sawWarp: true });
  }
  if (obs.inSpace !== true || snapshot === null) {
    return tick(WAIT, "Waiting for the ship to be out in space.", phase, ACTING, false, mem);
  }
  // A full ship is a finished trip, exactly as on the loot blocks: go unload.
  const freeM3 = holdsFreeM3(obs.holds ?? null);
  if (freeM3 !== null && freeM3 <= 0) {
    return tick(WAIT, "The ship is full, so it is time to unload.", phase, { kind: "done" });
  }
  if (shipHasNoRoom(obs.refusals, step.id, "collectCustoms")) {
    return tick(WAIT, "Nothing aboard will take any more, so it is time to unload.", phase, { kind: "done" });
  }
  // ⚠ THE TAX IS PAID FROM THE PILOT'S WALLET, AND ONE REFUSAL IS THE ANSWER.
  // Every launchpad's export is charged from the same balance, so asking again,
  // or at the next office, only repeats the refusal. The run stops and says so.
  if (pilotCannotPay(obs.refusals, step.id, "exportCustoms")) {
    return tick(WAIT, "Not enough ISK to pay the customs office's export tax.", phase, {
      kind: "blocked",
      reason: "This pilot does not have enough ISK to pay the customs office's export tax. Add ISK to its wallet and start the haul again.",
    });
  }
  const offices = customsOfficesOnGrid(snapshot);
  if (offices.length === 0) {
    const looked = (num(mem, "looked") ?? 0) + 1;
    if (looked <= CUSTOMS_SETTLE_TICKS) {
      return tick(WAIT, "Looking for this system's customs offices.", phase, ACTING, false, { ...mem, looked });
    }
    return tick(WAIT, "There is no customs office in this system.", phase, { kind: "done" });
  }
  // ⚠ NULL IS "NOBODY HAS READ THEM YET", NEVER "THEY ARE EMPTY". The read is
  // paid for only while this block is active (flow.ts), so the first tick in a
  // system always lands here.
  const contents = obs.customsOffices ?? null;
  if (contents === null) {
    return tick(WAIT, "Reading the customs offices.", phase, ACTING, false, mem);
  }
  const unitsIn = new Map(contents.map((office) => [office.officeID, office.units]));
  // What each office's planet still has on its launchpads: sent up at the
  // office, as the retail client's customs window does, before anything is taken.
  const padsAt = new Map(offices.map((office) => [office.itemID, launchpadsToSendUp(office, obs, step.id)]));
  const toSendUp = (office: SpaceEntity) => (padsAt.get(office.itemID) ?? []).filter((pad) => !pad.leftAlone);
  const holding = offices.filter(
    (office) =>
      toSendUp(office).length > 0 ||
      ((unitsIn.get(office.itemID) ?? 0) > 0 &&
        !shouldSetAside(obs.refusals, step.id, "collectCustoms", office.itemID, MAX_BLOCK_ATTEMPTS)),
  );
  if (holding.length === 0) {
    const stubborn = offices.filter((office) => (unitsIn.get(office.itemID) ?? 0) > 0).length;
    const leftAlone = [...padsAt.values()].flat().filter((pad) => pad.leftAlone).length;
    const ended = stubborn > 0
      ? `${stubborn} customs office${stubborn === 1 ? "" : "s"} would not give up ${stubborn === 1 ? "its" : "their"} goods.`
      : "Every customs office in this system is emptied.";
    return tick(
      WAIT,
      leftAlone > 0
        ? `${ended} ${leftAlone} launchpad${leftAlone === 1 ? "" : "s"} would not send ${leftAlone === 1 ? "its" : "their"} goods up.`
        : ended,
      phase,
      { kind: "done" },
    );
  }
  const target = holding[0]!;
  const measurement = measureSpace(snapshot);
  const dist = measurement?.distances.get(target.itemID) ?? null;
  if (dist === null) {
    // On the overview but not measurable: the ship's own geometry has not
    // arrived yet. Wait rather than warp blind.
    return tick(WAIT, "Waiting for the office's range to be readable.", phase, ACTING, false, mem);
  }
  if (dist > LAUNCH_WARP_MIN_M) {
    if (num(mem, "warpingTo") === target.itemID && flag(mem, "issued")) {
      if (warpLanded(obs, mem)) {
        // Landed: fall through to the close-in below on the next tick, which is
        // what a landing inside warp range means.
        return tick(WAIT, "Landed at the customs office.", phase, ACTING, false, { ...mem, warpingTo: null, issued: false });
      }
      const waited = (num(mem, "waited") ?? 0) + 1;
      if (waited > 10) {
        return tick(WAIT, "The warp to that office never started - trying it again.", phase, ACTING, false, {});
      }
      return tick(WAIT, "Waiting for the warp to start.", phase, ACTING, false, { ...mem, waited });
    }
    // Never warp off with drones still out.
    const recall = recallBeforeLeaving(obs, mem, phase, null);
    if (recall !== null) {
      return recall;
    }
    return tick(
      { kind: "warp", targetID: target.itemID },
      "Warping to a customs office.",
      phase,
      ACTING,
      false,
      { warpingTo: target.itemID, ...warpIssuedMem(obs) },
    );
  }
  // The server's range check beats our arithmetic, as on the loot blocks.
  const unreachable = isUnreachable(obs.refusals, step.id, "collectCustoms", target.itemID);
  if (dist > LOOT_RANGE_M || unreachable) {
    if (!unreachable && num(mem, "approaching") === target.itemID) {
      const stall = closeInStall(measurement?.shipMode ?? null, mem);
      if (stall.step === "reorder") {
        return tick({ kind: "approach", targetID: target.itemID }, STALL_REORDER_WHY, phase, ACTING, true, stall.mem);
      }
      if (stall.step === "unstick") {
        return tick({ kind: "stopShip" }, STALL_UNSTICK_WHY, phase, ACTING, true, stall.mem);
      }
      if (stall.step === "stuck") {
        return tick(WAIT, STALL_STUCK_WHY, phase, { kind: "blocked", reason: STALL_STUCK_REASON });
      }
      return tick(WAIT, "Flying to the customs office.", phase, ACTING, true, stall.mem);
    }
    return tick(
      { kind: "approach", targetID: target.itemID },
      unreachable ? "Too far to reach it, closing in." : "Heading for the customs office.",
      phase,
      ACTING,
      true,
      clearCloseInStall({ approaching: target.itemID }),
    );
  }
  const [pad] = toSendUp(target);
  if (pad !== undefined) {
    return tick(
      { kind: "exportCustoms", officeID: target.itemID, pinID: pad.pinID, commodities: pad.commodities },
      "Sending a launchpad's goods up into the customs office.",
      phase,
      ACTING,
      true,
      { approaching: null },
    );
  }
  return tick(
    { kind: "collectCustoms", officeID: target.itemID },
    "Taking the goods out of the customs office.",
    phase,
    ACTING,
    true,
    { approaching: null },
  );
};

// ── board-planetary-hauler ───────────────────────────────────────────────────
// Docked: get into a hull parked here that has a planetary commodities hold.
// The hold is READ off each hull (obs.planetaryHaulerShipIDs, one capacity
// read per parked ship while this block runs), never picked by the player -
// the hull's own bays say what it is for. The hull it leaves is noted on the
// run's board exactly as refit-ship notes it, so board-previous-ship goes back.
export const boardPlanetaryHauler: MacroDecider = (step, obs, mem, board) => {
  const phase = "Changing ships";
  const activeShipID = obs.activeShipID ?? null;
  const haulers = obs.planetaryHaulerShipIDs ?? null;
  // ⚠ IN SPACE, THE SHIP FLOWN DECIDES. A hauler already out hauls from where
  // it is; any other hull flies home and docks, and the hauler parked there is
  // boarded on the tick after. Home is the run's (flow.ts resolves a run that
  // starts in space to the bot's home or the character's home station).
  if (obs.flightStatus?.docked !== true) {
    if (activeShipID === null || haulers === null) {
      const blindChecks = (num(mem, "blindChecks") ?? 0) + 1;
      if (blindChecks > MAX_BLOCK_ATTEMPTS * 2) {
        return tick(WAIT, "The ship's holds could not be read.", phase, {
          kind: "blocked",
          reason: "The ship's holds could not be read, so the bot cannot tell whether it is a planetary hauler.",
        });
      }
      return tick(WAIT, "Reading the ship's holds.", phase, ACTING, false, { ...mem, blindChecks });
    }
    if (haulers.includes(activeShipID)) {
      return tick(WAIT, "This ship has a planetary hold, so it hauls from here.", phase, { kind: "done" });
    }
    const boardingStationID = num(mem, "boardingStationID") ?? obs.homeStationID ?? null;
    const boardingDockableKind = mem["boardingDockableKind"] === "structure" || mem["boardingDockableKind"] === "station"
      ? mem["boardingDockableKind"] : obs.homeDockableKind ?? "station";
    const homeMem = (mem["home"] as MacroMemory | undefined) ?? {};
    const home = scriptTravelHome({ ...obs, homeStationID: boardingStationID, homeDockableKind: boardingDockableKind }, homeMem, step.id);
    if (home.outcome.kind === "done") {
      // Stopped short of a station: travel says so only when there is nothing to fly.
      return tick(WAIT, "Not docked - ships are changed in a station.", phase, {
        kind: "blocked",
        reason: "Dock where your planetary hauler is parked first.",
      });
    }
    return { ...home, phase: home.outcome.kind === "blocked" ? home.phase : "Flying home to board the hauler", nextMem: {
      ...mem, boardingStationID, boardingDockableKind, home: home.nextMem,
    } };
  }
  // A failed trip may take an emergency dock elsewhere. That makes the ship
  // safe, but boarding there would leave the original hull away from home.
  // Only a run that flew here needs this check; a run starting docked boards here.
  const boardingStationID = num(mem, "boardingStationID");
  if (boardingStationID !== null && !dockedAt(obs.flightStatus, {
    kind: mem["boardingDockableKind"] === "structure" ? "structure" : "station", id: boardingStationID,
  })) {
    return tick(WAIT, "Docked safely, but the boarding destination could not be reached.", phase, {
      kind: "blocked",
      reason: "The trip home failed and the ship docked elsewhere for safety. Dock at home before boarding the planetary hauler.",
    });
  }
  const unread = "The ships parked here could not be read, so the bot cannot tell which one has a planetary hold.";
  if (haulers === null) {
    // Counted with the hangar's own unread ticks (boardParkedShip), on the same key.
    const blindChecks = (num(mem, "blindChecks") ?? 0) + 1;
    if (blindChecks > MAX_BLOCK_ATTEMPTS * 2) {
      return tick(WAIT, "The parked ships could not be read.", phase, { kind: "blocked", reason: unread });
    }
    return tick(WAIT, "Reading the ships parked here.", phase, ACTING, false, { ...mem, blindChecks });
  }
  // The hull is chosen by its hold; the boarding is every block's (boardParkedShip).
  return boardParkedShip(obs, mem, board, phase, (parked, flown) => {
    if (haulers.includes(flown)) return { kind: "already", words: "This ship has a planetary hold." };
    const candidate = parked.find((row) => haulers.includes(row.itemID));
    return candidate === undefined
      ? {
          kind: "blocked",
          words: "No ship with a planetary hold is parked here.",
          reason: "No ship with a planetary commodities hold (an Epithal) is parked at this station.",
        }
      : { kind: "board", shipID: candidate.itemID, words: "Boarding the planetary hauler." };
  }, unread);
};


// ─── The blocks, as the bot builder offers them ──────────────────────────────

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

export const PI_BLOCKS: readonly PluginMacro[] = [
  {
    id: "pi-manager:restart-extractors",
    formerly: ["restart-extractors"],
    name: "Restart the planet extractors",
    category: "planets",
    does: "Checks every planet colony you own and restarts each extractor whose program has run out, on the same resource it was already pulling. Works from anywhere.",
    needs: "A planet colony with extractors",
    spec: { args: [], untilRequired: false },
    runPolicy: { risks: ["colony"], restartSafe: true },
    reads: ["colonies"],
    decide: restartExtractors,
    sentence: () => "Restart every expired extractor on your planets",
  },
  {
    id: "pi-manager:launch-commodities",
    formerly: ["launch-commodities"],
    name: "Launch from the command centre",
    category: "planets",
    does: "Watches the command centre of every colony you own and launches what it is holding once the centre is full enough, dropping a container in space beside the planet for a hauler to collect. The server charges planetary export tax for the launch.",
    needs: "A planet colony whose command centre is holding goods",
    spec: {
      args: [
        // OPTIONAL: left unset, the block waits for the centre to reach the
        // default (80) before it launches what it is holding.
        { key: "fullPercent", kind: "count", required: false, label: "Launch once this full (%)" },
        // Bypass the fill threshold for an immediate haul. Empty centres and
        // launch cooldowns keep their usual guards.
        { key: "anyAmount", kind: "toggle", required: false, label: "Launch any amount" },
        // Absent = every colony. The Haul button sets the colonies ticked.
        { key: "planets", kind: "planetList", required: false, label: "Only these colonies" },
      ],
      untilRequired: false,
    },
    // A launch charges export tax and drops a container: starting over could do both twice.
    runPolicy: { risks: ["colony", "financial"], restartSafe: false },
    reads: ["colonies"],
    decide: launchCommodities,
    sentence: (step) => {
      // The SAME clamp the decider fires on, so the sentence cannot promise a
      // threshold the block will not use.
      const fullPercent = launchFullPercent(step.args["fullPercent"], step.args["anyAmount"]);
      return fullPercent === 0
        ? `Launch whatever the command centre${launchPlanetsPhrase(step)} holds`
        : `Launch from the command centre${launchPlanetsPhrase(step)} once it is ${fullPercent}% full`;
    },
  },
  {
    id: "pi-manager:collect-launches",
    formerly: ["collect-launches"],
    name: "Collect your planet launches",
    category: "planets",
    does: "Flies to each container your command centres launched in this system and takes what is inside, each into the right hold (an Epithal's planetary hold takes planetary goods). It finds them from your launch list, so there is no scanning. Finishes when every launch here is collected, or when the ship is full.",
    needs: "Being in space in the system of your launches",
    spec: { args: [], untilRequired: false },
    runPolicy: { risks: ["inventory", "colony"], restartSafe: true },
    reads: ["piLaunches"],
    decide: collectLaunches,
    sentence: () => "Collect every launch container of yours in this system",
  },
  {
    id: "pi-manager:collect-customs",
    formerly: ["collect-customs"],
    name: "Collect from the customs offices",
    category: "planets",
    does: "At each customs office in this system, sends your colony's launchpad goods up into it, then takes what it holds of yours, each into the right hold (an Epithal's planetary hold takes planetary goods). Finishes when every office here is empty, or when the ship is full.",
    needs: "Being in space in the system of your colonies",
    spec: { args: [], untilRequired: false },
    // Sending a launchpad up charges the office's export tax. Restart-safe all the
    // same: each tick re-reads the pads, and what already went up is not on them.
    runPolicy: { risks: ["inventory", "colony", "financial"], restartSafe: true },
    reads: ["colonies", "customsOffices"],
    decide: collectCustoms,
    sentence: () => "Empty every customs office in this system that holds your goods",
  },
  {
    id: "pi-manager:board-hauler",
    formerly: ["board-planetary-hauler"],
    name: "Board a planetary hauler",
    category: "ship",
    does: "Gets into a ship parked here that has a planetary commodities hold, such as an Epithal, as it is fitted. Nothing to pick: it reads each hull's holds. Back into the earlier ship takes you back to the ship you left.",
    needs: "Being docked where a ship with a planetary hold is parked",
    spec: { args: [], untilRequired: false },
    runPolicy: { risks: ["inventory"], restartSafe: true },
    reads: ["holds", "planetaryHolds"],
    decide: boardPlanetaryHauler,
    sentence: () => "Get into a ship parked here that has a planetary hold",
  },
];
