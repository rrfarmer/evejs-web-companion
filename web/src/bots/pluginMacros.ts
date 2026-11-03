// The blocks plugins add to the bot builder.
//
// Core's own blocks are described in tables that are exhaustive over
// `CoreMacroID` (macroSpecs.ts, runPolicy.ts, macroCatalogView.ts,
// scriptText.ts, nav/scriptMacros.ts), so a core block missing any part of its
// description is a compile error. A plugin's block cannot be in those tables:
// core does not know which plugins a build carries. So a plugin hands over ONE
// definition carrying every part, and each table's lookup reads it here when
// the id is a plugin's.
//
// ⚠ ONE DEFINITION, NOT A ROW PER TABLE. A block whose spec is registered but
// whose run policy is not would be a block the codec accepts and the launch
// grant cannot price. Taking the whole definition at once is what keeps a
// plugin block as complete as the exhaustive tables keep core's.
//
// ⚠ TYPES ONLY FROM THE MODULES THAT READ THIS ONE. macroSpecs.ts,
// runPolicy.ts and macroCatalogView.ts all import the lookups below, so a value
// imported back from any of them would be a cycle evaluated at load.

import type { Arg, MacroStep, PluginMacroID } from "./botScript.ts";
import type { BlockCategory } from "./macroCatalogView.ts";
import type { MacroSpec } from "./macroSpecs.ts";
import type { MacroRunPolicy } from "./runPolicy.ts";
import type { MacroDecider, MacroMemory, MacroTick, ScriptBoard } from "../nav/scriptDecide.ts";
import type { ScriptObservation } from "../nav/scriptConditions.ts";
import type { ObservationRead } from "./macroReads.ts";

/** Everything core needs to offer, check, price, run and describe a plugin's block. */
export interface PluginMacro {
  readonly id: PluginMacroID;
  /** The palette name: "Restart the planet extractors". */
  readonly name: string;
  /** The palette's category; the plugin picks one of core's. */
  readonly category: BlockCategory;
  /** What it does, one line. */
  readonly does: string;
  /** What it needs before it can start, one line, or null. */
  readonly needs: string | null;
  /** Its arguments and whether it must carry an `until`, as the codec checks them. */
  readonly spec: MacroSpec;
  /** What starting it risks, and whether a restarted run may re-enter it. */
  readonly runPolicy: MacroRunPolicy;
  /** The reads it needs each tick while it is the step being run (macroReads.ts). */
  readonly reads: readonly ObservationRead[];
  /** What it does next, given what the bot sees. */
  readonly decide: MacroDecider;
  /** The arguments a newly added step starts with; none when absent. */
  readonly newArgs?: () => Readonly<Record<string, Arg>>;
  /** The step as one sentence; the palette name when absent. */
  readonly sentence?: (step: MacroStep) => string;
}

const registered = new Map<PluginMacroID, PluginMacro>();

/** The plugin that owns a block: the part of its id before the colon. */
export function pluginOfMacro(id: PluginMacroID): string {
  return id.slice(0, id.indexOf(":"));
}

/**
 * Add a plugin's block. Called while plugins load, before any script is read;
 * an id already registered is refused, so two plugins can never share a block.
 */
export function registerPluginMacro(macro: PluginMacro): void {
  if (registered.has(macro.id)) throw new Error(`There is already a block called "${macro.id}".`);
  registered.set(macro.id, Object.freeze({ ...macro }));
}

/** A plugin's block, or null when no plugin in this build registered it. */
export function pluginMacro(id: PluginMacroID): PluginMacro | null {
  return registered.get(id) ?? null;
}

/** Every plugin block, in the order they registered. */
export function pluginMacros(): readonly PluginMacro[] {
  return [...registered.values()];
}

/** Every plugin block's decider, to sit beside core's in the runner's registry. */
export function pluginDeciders(): Readonly<Record<PluginMacroID, MacroDecider>> {
  return Object.fromEntries(pluginMacros().map((macro) => [macro.id, macro.decide]));
}

// ─── Deciding in the plugin's own process ──────────────────────────────────────
//
// In the browser a plugin block decides in the page, as core's do. For a bot the
// BFF hosts, its next step is asked of the plugin's own process
// (src/pluginHost.js), so a plugin that hangs or throws stops its own bots and
// never the BFF. The BFF sets this once at startup; the runner then asks it for
// every plugin block's tick (nav/scriptRunner.ts).

export type RemotePluginDecider = (
  macro: PluginMacroID,
  step: MacroStep,
  obs: ScriptObservation,
  mem: MacroMemory,
  board: ScriptBoard,
) => Promise<{ readonly tick: MacroTick } | { readonly error: string }>;

let remote: RemotePluginDecider | null = null;

/** Decide plugin blocks elsewhere (the BFF's plugin processes); null decides them here. */
export function setRemotePluginDecider(decider: RemotePluginDecider | null): void {
  remote = decider;
}

export function remotePluginDecider(): RemotePluginDecider | null {
  return remote;
}
