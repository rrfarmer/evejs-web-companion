// Dispatch from the PI board (R108 slice 4): restart a pilot's ended extractors
// by starting a SERVER bot for that pilot.
//
// ⚠ THROUGH THE BOT HOST, NEVER A SELECT HERE. Acting on a colony needs the
// character online, and the only thing in this system that arbitrates who is
// flying a hull is the server bot host: it refuses a pilot a web session holds
// (CHARACTER_IN_USE) or another bot is flying (BOT_ALREADY_RUNNING), in its own
// words, and those words are what the board shows. So this signs the pilot's
// account in on a THROWAWAY token — the hangar's pattern (startCompanionFor.ts)
// — asks the host to start the run, and signs out. It never selects.
//
// ⚠ AN ORDINARY SAVED BOT. The host starts only saved bots, so the board keeps
// one in the (platform-wide) library, named PI_RESTART_BOT_NAME: found by name,
// saved once if missing, visible and editable in the Bot Manager like any
// other. A copy someone CHANGED is no longer the board's — it is neither
// started blind nor quietly overwritten; the board says so and stops.
//
// ⚠ THE RISK IS DERIVED FROM THE SAVED DOCUMENT, by the same policy analysis
// every other start uses, and the board states it on the row before the button
// rather than in a dialog after the click.
//
// The macro walks EVERY colony the pilot owns (scriptMacros.ts): it cannot be
// aimed at one planet, so dispatch is per pilot, and the row says "all".

import { createBotScript as apiCreateBotScript, updateBotScript as apiUpdateBotScript, getBotScript as apiGetBotScript, listBotScripts as apiListBotScripts, login as apiLogin, logout as apiLogout, startServerBot as apiStartServerBot } from "../../../web/src/plugin-api/index.ts";
import { BridgeCallError } from "../../../web/src/plugin-api/index.ts";
import { piHaulStages, type PiRunStage } from "./piRunProgress.ts";
import {
  SCRIPT_FORMAT,
  SCRIPT_VERSION,
  startingStation,
  type BotScript,
  type MacroStep,
  type WorldRef,
} from "../../../web/src/plugin-api/index.ts";
import { decodeScriptValue } from "../../../web/src/plugin-api/index.ts";
import {
  analyzeBotRunPolicy,
  createBotLaunchGrant,
  type BotLaunchGrant,
} from "../../../web/src/plugin-api/index.ts";

/** The library name the board's bot goes by. */
export const PI_RESTART_BOT_NAME = "Planetary: restart extractors";

/**
 * How long the run may last. The macro stops by itself once every extractor is
 * running ("Every extractor is running"), so this is only a ceiling for a run
 * whose restarts keep not landing.
 */
export const PI_RESTART_RUNTIME_MINUTES = 60;

/** The board's bot: one Restart extractors step, no watches, the usual home. */
export function piRestartBotDoc(): BotScript {
  return {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: PI_RESTART_BOT_NAME,
    notes:
      "Saved by the Planetary Industry window. Restarts every extractor whose program has ended, " +
      "on every colony of the pilot it runs for, each on the resource it last extracted, then stops.",
    home: startingStation(),
    interrupts: [],
    program: [{ id: "restart-extractors", kind: "macro", macro: "pi-manager:restart-extractors", args: {} }],
  };
}

/** Is this still the board's bot, exactly — one step, nothing watching? */
export function isPiRestartBot(doc: BotScript): boolean {
  const [only] = doc.program;
  return doc.program.length === 1
    && only !== undefined
    && only.kind === "macro"
    && only.macro === "pi-manager:restart-extractors"
    && doc.interrupts.length === 0;
}

export type PiDispatchOutcome =
  // `stages` rides on a haul's start: the route of the lap that was started,
  // for the board's stepper. Absent on a restart.
  | { readonly kind: "started"; readonly stages?: readonly PiRunStage[] }
  | { readonly kind: "refused"; readonly sentence: string };

/** What dispatch needs from the outside world; tests supply their own. */
export interface PiDispatchDeps {
  signIn(accountName: string): Promise<string>;
  signOut(token: string): Promise<void>;
  listScripts(token: string): Promise<readonly { scriptID: string; name: string; rev: number }[]>;
  getScript(scriptID: string, token: string): Promise<{ scriptID: string; rev: number; doc: unknown } | null>;
  createScript(doc: BotScript, token: string): Promise<{ scriptID: string; rev: number }>;
  updateScript(scriptID: string, doc: BotScript, baseRev: number, token: string): Promise<{ rev: number }>;
  startServerBot(characterID: number, scriptID: string, grant: BotLaunchGrant, token: string): Promise<void>;
}

export const DEFAULT_PI_DISPATCH_DEPS: PiDispatchDeps = {
  async signIn(accountName) {
    const result = await apiLogin(accountName, "", { token: null, priority: "user" });
    if (result.sessionToken === null) throw new Error("The server did not return a session token.");
    return result.sessionToken;
  },
  async signOut(token) {
    await apiLogout({ token });
  },
  listScripts: (token) => apiListBotScripts({ token, priority: "user" }),
  getScript: (scriptID, token) => apiGetBotScript(scriptID, { token, priority: "user" }),
  createScript: (doc, token) => apiCreateBotScript(doc, { token, priority: "user" }),
  updateScript: (scriptID, doc, baseRev, token) => apiUpdateBotScript(scriptID, doc, baseRev, { token, priority: "user" }),
  async startServerBot(characterID, scriptID, grant, token) {
    await apiStartServerBot(characterID, scriptID, grant, { token, priority: "user" });
  },
};

const refused = (sentence: string): PiDispatchOutcome => ({ kind: "refused", sentence });

/** The board's saved bot, saved now if it is missing. */
async function boardBot(
  deps: PiDispatchDeps,
  token: string,
): Promise<{ scriptID: string; rev: number; doc: BotScript } | PiDispatchOutcome> {
  const named = (await deps.listScripts(token)).filter((row) => row.name === PI_RESTART_BOT_NAME);
  if (named.length === 0) {
    const doc = piRestartBotDoc();
    const created = await deps.createScript(doc, token);
    return { scriptID: created.scriptID, rev: created.rev, doc };
  }
  for (const row of named) {
    const record = await deps.getScript(row.scriptID, token);
    const decoded = record ? decodeScriptValue(record.doc) : null;
    if (record && decoded?.ok && isPiRestartBot(decoded.doc)) {
      return { scriptID: record.scriptID, rev: record.rev, doc: decoded.doc };
    }
  }
  return refused(
    `The saved bot "${PI_RESTART_BOT_NAME}" has been changed, so this window will not start it. ` +
      "Put it back to a single Restart extractors step, or rename it and this window will save a fresh one.",
  );
}

/** Restart every ended extractor of this pilot's colonies, as a server run. */
export async function restartExtractorsFor(
  accountName: string,
  characterID: number,
  deps: PiDispatchDeps = DEFAULT_PI_DISPATCH_DEPS,
): Promise<PiDispatchOutcome> {
  let token: string;
  try {
    token = await deps.signIn(accountName);
  } catch {
    return refused("Could not sign in to this pilot's account just now.");
  }
  try {
    const bot = await boardBot(deps, token);
    if ("kind" in bot) return bot;
    const grant = createBotLaunchGrant(bot.rev, analyzeBotRunPolicy(bot.doc), PI_RESTART_RUNTIME_MINUTES);
    await deps.startServerBot(characterID, bot.scriptID, grant, token);
    return { kind: "started" };
  } catch (error) {
    // The server's own sentence when it answered; ours when it never did.
    if (error instanceof BridgeCallError && error.status > 0 && error.message) {
      return refused(error.message);
    }
    return refused("The server could not be reached just now.");
  } finally {
    await deps.signOut(token).catch(() => {});
  }
}

// ── Haul (the PI window's Haul button) ───────────────────────────────────────
//
// ⚠ THE BOARD OWNS THIS BOT AND REWRITES IT ON EVERY CLICK. Unlike the restart
// bot, a haul depends on what the player ticked, so the saved document is the
// plan for THIS haul: written, then started. It is still an ordinary saved bot,
// visible in the Bot Manager, so a player can see exactly what ran.
//
// The lap: board a ship parked here with a planetary hold, launch what the
// ticked colonies hold (any amount), fly to each ticked colony's system and
// collect the launches there, fly to the delivery station (the station the run
// started at, unless one is picked), unload there (into the picked corporation
// division, else the pilot's own hangar), and get back into the ship the pilot
// was in. With a picked delivery station the hauler first flies back to where
// it started, because that is where the earlier ship is parked - and where the
// hauler should be waiting for the next haul.

/** The library name the board's haul bot goes by. */
export const PI_HAUL_BOT_NAME = "Planetary: haul";

/** A ceiling only: the lap stops by itself once it is back and unloaded. */
export const PI_HAUL_RUNTIME_MINUTES = 120;

/** One ticked colony, as the board knows it. */
export interface PiHaulColony {
  readonly planetID: number;
  readonly planetName: string | null;
  readonly solarSystemID: number;
  readonly solarSystemName: string | null;
}

/** Where the goods are unloaded: a corporation division, or null for the pilot's own hangar. */
export type PiHaulDivision = { readonly division: number; readonly name: string | null } | null;

/** A delivery station that is not "where the run starts", or null. */
function pickedStation(deliverTo: WorldRef | null): WorldRef | null {
  return deliverTo !== null && deliverTo.starting !== true && deliverTo.id !== null ? deliverTo : null;
}

/** The haul lap for these colonies, as a saved bot document. */
export function piHaulBotDoc(
  colonies: readonly PiHaulColony[],
  division: PiHaulDivision,
  deliverTo: WorldRef | null = null,
): BotScript {
  const delivery = pickedStation(deliverTo);
  const systems: { id: number; name: string | null }[] = [];
  for (const colony of colonies) {
    if (!systems.some((system) => system.id === colony.solarSystemID)) {
      systems.push({ id: colony.solarSystemID, name: colony.solarSystemName });
    }
  }
  // ⚠ TWO WAYS OFF A COLONY, AND THE LAP USES BOTH. A LAUNCHPAD goes up into
  // the planet's own customs office at the office, on the pilot's own session
  // (collect-customs, as the client's customs window does it) - the only way
  // that moves the 10,000 m3 the factories actually fill. A COMMAND CENTRE cannot: the server
  // takes only a spaceport pin for a customs export, so the 500 m3 a centre
  // holds still leaves the old way, as a container in space. Dropping either
  // one strands goods, so each system gets both collectors below.
  //
  // ⚠ BOARD BEFORE LAUNCHING. A launch charges export tax and leaves a container
  // in space for five days. A pilot with no hauler must stop before paying that.
  const program: MacroStep[] = [
    { id: "board-hauler", kind: "macro", macro: "pi-manager:board-hauler", args: {} },
    {
      id: "launch",
      kind: "macro",
      macro: "pi-manager:launch-commodities",
      args: {
        // Hauls launch whatever is held, including less than one percent full.
        anyAmount: { kind: "toggle", enabled: true },
        planets: {
          kind: "planetList",
          planets: colonies.map((colony) => ({ planetID: colony.planetID, name: colony.planetName })),
        },
      },
    },
    { id: "undock", kind: "macro", macro: "undock", args: {} },
  ];
  systems.forEach((system, index) => {
    program.push(
      {
        id: `fly-${index + 1}`,
        kind: "macro",
        macro: "travel-to-system",
        args: { system: { kind: "system", ref: { entity: "system", id: system.id, name: system.name, systemName: system.name } } },
      },
      { id: `collect-${index + 1}`, kind: "macro", macro: "pi-manager:collect-customs", args: {} },
      { id: `launches-${index + 1}`, kind: "macro", macro: "pi-manager:collect-launches", args: {} },
    );
  });
  program.push(
    {
      id: "deliver",
      kind: "macro",
      macro: "travel-to-station",
      args: { station: { kind: "station", ref: delivery ?? startingStation() } },
    },
    {
      id: "unload",
      kind: "macro",
      macro: "unload-cargo",
      args: division === null ? {} : { into: { kind: "corpDivision", division: division.division, name: division.name } },
    },
  );
  if (delivery !== null) {
    program.push({
      id: "home",
      kind: "macro",
      macro: "travel-to-station",
      args: { station: { kind: "station", ref: startingStation() } },
    });
  }
  program.push({ id: "board-back", kind: "macro", macro: "board-previous-ship", args: {} });
  return {
    format: SCRIPT_FORMAT,
    version: SCRIPT_VERSION,
    name: PI_HAUL_BOT_NAME,
    notes:
      "Saved by the Planetary Industry window, and rewritten by its Haul button on every haul. This lap " +
      "boards a ship parked at the starting station that has a planetary hold, launches what the ticked colonies' " +
      "command centres hold, and in each colony's system sends the launchpads up into the customs office, empties it " +
      "and collects the launches. It flies back, unloads and gets back into the earlier ship.",
    // The Deliver-to station, when one is picked, is home: a run that starts in
    // space docks there to board, delivers there and comes back there (flow.ts
    // resolves the starting station to it). Without one, home is where the run
    // starts, and in space the character's home station.
    home: delivery ?? startingStation(),
    interrupts: [],
    program,
  };
}

/**
 * Haul these colonies of this pilot's, as a server run.
 *
 * The run itself sends each colony's launchpads up at its customs office, on
 * the pilot's own session, so nothing is sent before it starts.
 */
export async function haulFor(
  accountName: string,
  characterID: number,
  colonies: readonly PiHaulColony[],
  division: PiHaulDivision,
  deliverTo: WorldRef | null = null,
  deps: PiDispatchDeps = DEFAULT_PI_DISPATCH_DEPS,
): Promise<PiDispatchOutcome> {
  if (colonies.length === 0) {
    return refused("Tick the colonies to haul first.");
  }
  let token: string;
  try {
    token = await deps.signIn(accountName);
  } catch {
    return refused("Could not sign in to this pilot's account just now.");
  }
  try {
    const doc = piHaulBotDoc(colonies, division, deliverTo);
    const named = (await deps.listScripts(token)).find((row) => row.name === PI_HAUL_BOT_NAME) ?? null;
    let saved: { scriptID: string; rev: number };
    if (named === null) {
      saved = await deps.createScript(doc, token);
    } else {
      const updated = await deps.updateScript(named.scriptID, doc, named.rev, token);
      saved = { scriptID: named.scriptID, rev: updated.rev };
    }
    const grant = createBotLaunchGrant(saved.rev, analyzeBotRunPolicy(doc), PI_HAUL_RUNTIME_MINUTES);
    await deps.startServerBot(characterID, saved.scriptID, grant, token);
    return { kind: "started", stages: piHaulStages(doc) };
  } catch (error) {
    if (error instanceof BridgeCallError && error.status > 0 && error.message) {
      return refused(error.message);
    }
    return refused("The server could not be reached just now.");
  } finally {
    await deps.signOut(token).catch(() => {});
  }
}
