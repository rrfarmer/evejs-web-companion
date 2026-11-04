// Loading the build's plugins into the page (and into the BFF's bot host,
// which runs this same code without the views).
//
// Each plugin is checked before anything of it is registered, so a plugin is
// either wholly in or wholly out: one whose window id is not its own, whose
// block names another plugin, or that was built for another API version is
// refused with the reason, and every other plugin loads as if it were absent.
//
// ⚠ A FAILED PLUGIN FAILS ONLY ITSELF. Nothing here throws out of
// `activatePlugins`; what went wrong is kept against that plugin and shown in
// the Plugins window (ui/PluginManager.svelte).

import { PLUGIN_API_VERSION, type PluginEntry, type PluginManifest, type PluginViews, type PluginViewsEntry } from "../plugin-api/index.ts";
import { loadPluginModules } from "./loadPlugins.ts";
import { registerGlobalWindow, isGlobalTab } from "../ui/globalWindow.ts";
import { registerGlobalWindowView } from "../ui/pluginWindowViews.ts";
import { allTabs } from "../ui/tabs.ts";
import { pluginMacro, registerPluginMacro } from "../bots/pluginMacros.ts";

/**
 * - `active`        loaded: its windows and blocks are in
 * - `disabled`      switched off in this browser; nothing of it is loaded
 * - `incompatible`  built for another PLUGIN_API_VERSION
 * - `failed`        refused or threw while loading; `error` says why
 */
export type PluginLoadState = "active" | "disabled" | "incompatible" | "failed";

export interface PluginStatus {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly apiVersion: number;
  readonly state: PluginLoadState;
  readonly error: string | null;
  readonly windows: number;
  readonly macros: number;
  readonly hasBackend: boolean;
}

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Why this plugin cannot load, or null when it may. Pure: registers nothing. */
export function pluginProblem(manifest: PluginManifest, views: PluginViews | null): string | null {
  if (!PLUGIN_ID.test(manifest.id)) return `"${manifest.id}" is not a plugin id: lowercase words joined by hyphens.`;
  // Seen within this manifest too: a second window or block of the same id is
  // refused here, not when registering it, by which time the first is in.
  const windowsSeen = new Set<string>();
  for (const window of manifest.windows ?? []) {
    if (window.id !== `plugin:${manifest.id}` && !window.id.startsWith(`plugin:${manifest.id}.`)) {
      return `The window "${window.id}" is not this plugin's: its id must be plugin:${manifest.id} or start with plugin:${manifest.id}.`;
    }
    if (windowsSeen.has(window.id) || isGlobalTab(window.id) || allTabs().some((tab) => tab.id === window.id)) return `There is already a window called "${window.id}".`;
    windowsSeen.add(window.id);
    if (views !== null && views.windows[window.id] === undefined) return `The window "${window.id}" has nothing to draw.`;
  }
  const blocksSeen = new Set<string>();
  for (const macro of manifest.macros ?? []) {
    if (!macro.id.startsWith(`${manifest.id}:`) || macro.id.length === manifest.id.length + 1) return `The block "${macro.id}" is not this plugin's: its id must start with ${manifest.id}:.`;
    if (blocksSeen.has(macro.id) || pluginMacro(macro.id) !== null) return `There is already a block called "${macro.id}".`;
    blocksSeen.add(macro.id);
  }
  return null;
}

/**
 * Load every plugin of the build that is not switched off, and say how each
 * one went. `views` is null in the BFF, which draws nothing.
 */
export function activatePlugins(
  manifests: readonly PluginManifest[],
  views: readonly PluginViews[] | null,
  disabled: ReadonlySet<string> = new Set(),
): readonly PluginStatus[] {
  const statuses: PluginStatus[] = [];
  const seen = new Set<string>();
  for (const manifest of manifests) {
    const base = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      apiVersion: manifest.apiVersion,
      windows: manifest.windows?.length ?? 0,
      macros: manifest.macros?.length ?? 0,
      hasBackend: manifest.backend !== undefined,
    };
    const say = (state: PluginLoadState, error: string | null = null) => statuses.push({ ...base, state, error });
    if (seen.has(manifest.id)) {
      say("failed", `Another plugin in this build is called "${manifest.id}".`);
      continue;
    }
    seen.add(manifest.id);
    if (manifest.apiVersion !== PLUGIN_API_VERSION) {
      say("incompatible", `Built for plugin API ${manifest.apiVersion}; this client offers ${PLUGIN_API_VERSION}.`);
      continue;
    }
    if (disabled.has(manifest.id)) {
      say("disabled");
      continue;
    }
    const pluginViews = views === null ? null : views.find((entry) => entry.id === manifest.id) ?? { id: manifest.id, windows: {} };
    try {
      // Inside the try: a malformed manifest makes this throw, and it is one plugin's failure.
      const problem = pluginProblem(manifest, pluginViews);
      if (problem !== null) {
        say("failed", problem);
        continue;
      }
      for (const window of manifest.windows ?? []) {
        registerGlobalWindow({
          ...window,
          plugin: { id: manifest.id, name: manifest.name, label: manifest.label ?? manifest.windows![0]!.label, ...(manifest.glyph ? { glyph: manifest.glyph } : {}) },
        });
        const view = pluginViews?.windows[window.id];
        if (view !== undefined) registerGlobalWindowView(window.id, view);
      }
      for (const macro of manifest.macros ?? []) registerPluginMacro(macro);
      say("active");
    } catch (error) {
      say("failed", error instanceof Error && error.message.length > 0 ? error.message : "It failed while loading.");
    }
  }
  return statuses;
}

// ─── Switched off in this browser ────────────────────────────────────────────

const DISABLED_KEY = "evejs-web-plugins-disabled:v1";

/** The plugins switched off in this browser. Read once, before the first paint. */
export function loadDisabledPlugins(): Set<string> {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(DISABLED_KEY);
    const parsed = raw === null ? [] : (JSON.parse(raw) as unknown);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Switch a plugin on or off in this browser. It takes effect when the page next loads. */
export function saveDisabledPlugin(id: string, disabled: boolean): void {
  const next = loadDisabledPlugins();
  if (disabled) next.add(id);
  else next.delete(id);
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...next].sort()));
  } catch {
    // Storage blocked: the switch lasts for this page only.
  }
}

// What the page's own load came to, for the Plugins window.
let pageStatuses: readonly PluginStatus[] = [];

/**
 * Load the build's plugins into this page. Called once by main.ts, before App
 * mounts. Never rejects: a plugin that cannot be loaded is a row saying why in
 * the Plugins window.
 */
export async function activatePagePlugins(entries: readonly PluginEntry[], viewEntries: readonly PluginViewsEntry[]): Promise<readonly PluginStatus[]> {
  const disabled = loadDisabledPlugins();
  const loaded = await loadPluginModules(entries, viewEntries, { disabled });
  pageStatuses = [...activatePlugins(loaded.manifests, loaded.views, disabled), ...loaded.failures];
  for (const failure of loaded.failures) console.error(`Plugin ${failure.id}: ${failure.error}`);
  return pageStatuses;
}

/** How each of this build's plugins loaded into this page. */
export function pagePluginStatuses(): readonly PluginStatus[] {
  return pageStatuses;
}
