// Which costly reads a block needs while it is the step being run.
//
// The runner's observe pass (app/flow.ts) reads only what the running block
// will look at: a colony read is a round trip per planet, and a mining bot
// should never pay for one. That choice used to be a chain of
// `macro === "…"` tests inside observe, which the compiler cannot check and a
// plugin cannot extend. It is a table now: core's blocks below, a plugin's
// block from its own definition (pluginMacros.ts).

import { isPluginMacro, type CoreMacroID } from "./botScript.ts";
import { pluginMacro } from "./pluginMacros.ts";

/**
 * A read core makes for a block that asks for it.
 *
 * - `colonies`        the pilot's colonies, pins and extractor programs
 * - `piLaunches`      the pilot's commodity launches still in space
 * - `customsOffices`  the customs offices in the system, and what is in them
 * - `shipNames`       the names the pilot gave the ship flown and the ships
 *                     parked here (the client's cfg.evelocations)
 * - `holds`           the ship's holds and, docked, the station hangar (the
 *                     inventory panel's one read)
 * - `planetaryHolds`  which hulls here, the one flown among them, have a
 *                     planetary commodities hold (a capacity read per hull)
 */
export type ObservationRead = "colonies" | "piLaunches" | "customsOffices" | "shipNames" | "holds" | "planetaryHolds";

const CORE_MACRO_READS: Readonly<Partial<Record<CoreMacroID, readonly ObservationRead[]>>> = {
  "board-ship": ["shipNames"],
};

/** True when `macro`, while it runs, needs `read` made each tick. */
export function macroReads(macro: string | null, read: ObservationRead): boolean {
  if (macro === null) return false;
  const reads = isPluginMacro(macro) ? pluginMacro(macro)?.reads : CORE_MACRO_READS[macro as CoreMacroID];
  return reads?.includes(read) ?? false;
}
