// THE PLUGIN API — the only part of core a plugin may import.
//
// A plugin adds to the client; it never edits core. It can add a global window,
// a bot builder block and a backend, and core reads what each plugin registers.
// This module has the types a plugin needs to add them, so a plugin that builds
// against it keeps building when core's internals move.
//
// ⚠ A PLUGIN IMPORTS FROM HERE AND FROM ITS OWN FOLDER, NOTHING ELSE.
// web/src/plugins/pluginBoundary.test.ts enforces it, and it also holds core to
// its half: core never imports a plugin, it only reads the build's plugin list
// (plugins/index.ts, plugins/views.ts).
//
// ⚠ `PLUGIN_API_VERSION` IS A PROMISE. Bump it when anything exported here
// changes in a way a built plugin would break on; a plugin declares the version
// it was built for, and the host refuses one built for another.

import type { GlobalWindowView } from "../ui/pluginWindowViews.ts";
import type { PluginMacro } from "../bots/pluginMacros.ts";

export const PLUGIN_API_VERSION = 1;

/** A plugin's id: lowercase words joined by hyphens, as "pi-manager". */
export type PluginID = string;

/**
 * A global window: about every pilot rather than the one on screen, opened
 * from a launcher beside the brand (ui/globalWindow.ts). Its id is
 * `plugin:<plugin id>` or `plugin:<plugin id>.<name>`.
 */
export interface PluginWindow {
  readonly id: `plugin:${string}`;
  /** The word on its launcher. Short: it shares a header with the brand. */
  readonly label: string;
  /** The window's full name. */
  readonly title: string;
  /** What it is for, as a tooltip. */
  readonly hint: string;
  /** Its glyph: SVG path data in a 24x24 box, stroked (ui/neocomIcons.ts). */
  readonly glyph: readonly string[];
}

/** Everything about a plugin that is not a Svelte component: core reads it in the browser and the BFF alike. */
export interface PluginManifest {
  readonly id: PluginID;
  readonly name: string;
  readonly version: string;
  /** The PLUGIN_API_VERSION it was built for. */
  readonly apiVersion: number;
  /** One line: what it adds. */
  readonly description: string;
  /**
   * The word on the plugin's launcher when the whole plugin is pinned beside the
   * brand; its first window's label when absent.
   */
  readonly label?: string;
  /**
   * The plugin's own icon: on its row in the Plugins menu and on its launcher
   * when the whole plugin is pinned. Its first window's glyph when absent. SVG
   * path data in a 24x24 box, stroked, as a window's glyph is.
   */
  readonly glyph?: readonly string[];
  readonly windows?: readonly PluginWindow[];
  /** Blocks for the bot builder; each id is "<plugin id>:<block>". */
  readonly macros?: readonly PluginMacro[];
  /**
   * The plugin's backend, a module path relative to plugins/<id>/, run by the
   * BFF in a process of its own (src/pluginHost.js). Absent: none.
   */
  readonly backend?: string;
}

/** What a plugin's windows draw, keyed by window id. Kept apart from the manifest so the BFF never loads Svelte. */
export interface PluginViews {
  readonly id: PluginID;
  readonly windows: Readonly<Record<`plugin:${string}`, GlobalWindowView>>;
}

/** A plugin in the build's list (plugins/index.ts): its module runs only when loaded. */
export interface PluginEntry {
  readonly id: PluginID;
  readonly load: () => Promise<{ readonly default: PluginManifest }>;
}

/** A plugin's views in the build's list (plugins/views.ts), for the browser only. */
export interface PluginViewsEntry {
  readonly id: PluginID;
  readonly load: () => Promise<{ readonly default: PluginViews }>;
}

export function definePlugin(manifest: PluginManifest): PluginManifest {
  return Object.freeze({ ...manifest });
}

export function definePluginViews(views: PluginViews): PluginViews {
  return Object.freeze({ ...views });
}

// ─── What a plugin's additions are made of ───────────────────────────────────

export type { GlobalWindowProps, GlobalWindowView } from "../ui/pluginWindowViews.ts";
export type { PluginMacro } from "../bots/pluginMacros.ts";
export type { MacroSpec, MacroArgSpec } from "../bots/macroSpecs.ts";
export type { MacroRunPolicy, BotRiskClass } from "../bots/runPolicy.ts";
export type { BlockCategory } from "../bots/macroCatalogView.ts";
export type { ObservationRead } from "../bots/macroReads.ts";
export type { Arg, MacroStep, PluginMacroID } from "../bots/botScript.ts";
export type { MacroDecider, MacroMemory, MacroTick, ScriptAction, ScriptBoard } from "../nav/scriptDecide.ts";
export type { ScriptObservation } from "../nav/scriptConditions.ts";
export type { TabID } from "../ui/tabs.ts";

// ─── What core offers a plugin to read and do ────────────────────────────────
//
// The reads and helpers a plugin builds on: the game's own reads (colonies,
// recipes, holdings, the map), the bot library and its server runs, and the
// words core says things with. A plugin calls these; it never reaches past
// them into core's internals. Svelte components are in ./ui.ts.

export {
  createBotScript,
  findMapLocations,
  getBotScript,
  getPiSchematics,
  getPlanetRichness,
  getPlanetsNear,
  listActiveServerBots,
  listBotScripts,
  listServerBots,
  loadBotCorpDivisionNames,
  loadRosterPlanets,
  login,
  logout,
  pluginGetJson,
  pluginPostJson,
  startServerBot,
  updateBotScript,
  ROSTER_PLANETS_MAX_IDS,
} from "../app/api.ts";
export type { ActiveServerBot, ApiOptions, ServerBot } from "../app/api.ts";
export { readCorpStock } from "../app/corpStockRead.ts";
export type { BotPilot, CorpItemFilter, OnlinePilot } from "../app/corpStockRead.ts";
export type { AppFlow } from "../app/flow.ts";
export { loadHangarPrefs } from "../app/hangarPrefs.ts";
export { loadKnownCharacters } from "../app/knownCharacters.ts";
export type { KnownCharacter } from "../app/knownCharacters.ts";
export type { Session } from "../app/sessions.ts";
export { skipWhileBusy } from "../app/skipWhileBusy.ts";
export { stopServerBotFor } from "../app/stopBotFor.ts";
export { SCRIPT_FORMAT, SCRIPT_VERSION, startingStation } from "../bots/botScript.ts";
export type { BotScript, WorldRef } from "../bots/botScript.ts";
export { analyzeBotRunPolicy, createBotLaunchGrant } from "../bots/runPolicy.ts";
export type { BotLaunchGrant } from "../bots/runPolicy.ts";
export { decodeScriptValue } from "../bots/scriptCodec.ts";
export { decodePlanetResourceInfo } from "../bridge/boundPlanets.ts";
export { BridgeCallError } from "../bridge/callMethod.ts";
export {
  attentionByColony,
  bySeverityThenTime,
  colonyAttentionWords,
  colonyLineWords,
  pinFill,
} from "../bridge/colonyAttention.ts";
export type { ColonyAttention, ColonyFindingUrgency } from "../bridge/colonyAttention.ts";
export { extractorReroute } from "../bridge/colonyRoutes.ts";
export { commodityName, decodeRecipeBook, madeThings, recipeFor, tierOf } from "../bridge/piRecipes.ts";
export type { PiRecipeBook, PiSchematic, PiTier } from "../bridge/piRecipes.ts";
export { colonyPlaceWords, decodeColonyReport, formatDuration, serverNow, summarizeColony } from "../bridge/planets.ts";
export {
  compareHoldings,
  countWords,
  decodeStockStack,
  holdingsFromCorpReads,
  isPlayerCorporation,
  stationWords,
} from "../bridge/stockHoldings.ts";
export type { CorpStockRead, Holding, HoldingSource, PilotStockStack } from "../bridge/stockHoldings.ts";
export type { JsonValue } from "../bridge/wire.ts";
export { PROGRAM_DONE_PHASE } from "../nav/scriptDecide.ts";
export type { Colony, ColonyPin, ColonyPinKind, ColonyReport } from "../store/types.ts";
