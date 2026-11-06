// THE PLUGINS THIS BUILD CARRIES: a loader for every plugin's manifest, in load order.
//
// The one file core reads to find plugins (web/src/main.ts in the browser,
// src/pluginHost.js in the BFF). A plugin is added to a build by listing it here;
// nothing in core changes. Its windows' Svelte views are listed apart, in
// views.ts, so the BFF can read this file without loading Svelte.
//
// LOADERS, NEVER STATIC IMPORTS. A plugin's code runs when its module loads, and
// a throw in a statically imported one would stop whoever imports this file
// before it could draw or say anything (web/src/plugins/loadPlugins.ts).

import type { PluginEntry } from "../web/src/plugin-api/index.ts";

export const PLUGINS: readonly PluginEntry[] = [
  { id: "pi-manager", load: () => import("./pi-manager/plugin.ts") },
  { id: "fleet-companion", load: () => import("./fleet-companion/plugin.ts") },
];
