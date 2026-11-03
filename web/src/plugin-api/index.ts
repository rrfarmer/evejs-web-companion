// THE PLUGIN API — the only part of core a plugin may import.
//
// A plugin adds to the client; it never edits core. Core owns a small set of
// contribution points (a global window, a bot builder block, a backend) and
// reads what each plugin registers for them. This module is where a plugin
// finds those points and the types it needs to fill them, so a plugin that
// builds against it keeps building when core's internals move.
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
 * from a door beside the brand (ui/globalWindow.ts). Its id is
 * `plugin:<plugin id>` or `plugin:<plugin id>.<name>`.
 */
export interface PluginWindow {
  readonly id: `plugin:${string}`;
  /** The word on its door. Short: it shares a header with the brand. */
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

export function definePlugin(manifest: PluginManifest): PluginManifest {
  return Object.freeze({ ...manifest });
}

export function definePluginViews(views: PluginViews): PluginViews {
  return Object.freeze({ ...views });
}

// ─── What a contribution point is made of ────────────────────────────────────

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
