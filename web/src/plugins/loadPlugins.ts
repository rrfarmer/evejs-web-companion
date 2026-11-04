// Running each plugin's modules, one plugin at a time, in the page and the BFF.
//
// ⚠ A DYNAMIC IMPORT PER PLUGIN, AND THAT IS THE POINT. A plugin's code runs when
// its module loads. Imported statically by the entry point, one throw there stops
// the entry point itself: the page mounts nothing and has no overlay yet to say
// why. So the build's lists (plugins/index.ts, plugins/views.ts) hold a loader per
// plugin, and each is run here on its own, so one that throws, rejects or never
// finishes is reported against its id and the others load regardless.
//
// What this cannot contain: a module stuck in a synchronous loop holds the thread
// it is on, in the page as anywhere else (docs/plugins.md).
//
// No imports of core at runtime: the BFF and the uninstall script read this file
// without the rest of the client.

import type { PluginEntry, PluginManifest, PluginViews, PluginViewsEntry } from "../plugin-api/index.ts";
import type { PluginStatus } from "./pluginHost.ts";

/** The page draws nothing until plugins are in, so one that stalls is given up on. */
export const PAGE_LOAD_TIMEOUT_MS = 20_000;

export interface LoadedPlugins {
  /** The manifests that loaded, in the list's order. */
  readonly manifests: readonly PluginManifest[];
  readonly views: readonly PluginViews[];
  /** One per plugin that did not load, saying why. */
  readonly failures: readonly PluginStatus[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

/** Run one loader, however it fails: a throw, a rejection, or never finishing. */
function loadInTime<T>(load: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`it did not finish loading within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    Promise.resolve()
      .then(load)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

function failedToLoad(id: string, error: unknown): PluginStatus {
  return {
    id,
    // Its manifest is what names it, and that is what could not be had.
    name: id,
    version: "",
    description: "",
    apiVersion: 0,
    state: "failed",
    error: `It could not be loaded: ${reasonOf(error)}`,
    windows: 0,
    macros: 0,
    hasBackend: false,
  };
}

/**
 * Load every plugin in the list. Never rejects. A plugin is wholly in or wholly
 * out: one whose views fail is out, manifest and all. `viewEntries` is null in
 * the BFF, which draws nothing; views of a plugin switched off are not loaded.
 */
export async function loadPluginModules(
  entries: readonly PluginEntry[],
  viewEntries: readonly PluginViewsEntry[] | null,
  options: { readonly disabled?: ReadonlySet<string>; readonly timeoutMs?: number } = {},
): Promise<LoadedPlugins> {
  const timeoutMs = options.timeoutMs ?? PAGE_LOAD_TIMEOUT_MS;
  const outcomes = await Promise.all(entries.map(async (entry) => {
    try {
      const manifest = (await loadInTime(entry.load, timeoutMs)).default;
      if (!manifest || typeof manifest !== "object") throw new Error("its module exports no manifest as its default");
      if (manifest.id !== entry.id) throw new Error(`the list calls it "${entry.id}" but its manifest says "${String(manifest.id)}"`);
      const viewEntry = options.disabled?.has(entry.id) ? undefined : viewEntries?.find((candidate) => candidate.id === entry.id);
      const views = viewEntry === undefined ? null : (await loadInTime(viewEntry.load, timeoutMs)).default;
      return { manifest, views };
    } catch (error) {
      return { failure: failedToLoad(entry.id, error) };
    }
  }));
  const manifests: PluginManifest[] = [];
  const views: PluginViews[] = [];
  const failures: PluginStatus[] = [];
  for (const outcome of outcomes) {
    if ("failure" in outcome) {
      failures.push(outcome.failure!);
      continue;
    }
    manifests.push(outcome.manifest!);
    if (outcome.views) views.push(outcome.views);
  }
  return { manifests, views, failures };
}
