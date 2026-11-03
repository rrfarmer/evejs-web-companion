// THE PLUGINS THIS BUILD CARRIES: every plugin's manifest, in load order.
//
// The one file core reads to find plugins (web/src/plugins/pluginHost.ts in
// the browser, src/botHost.js and src/pluginHost.js in the BFF). A plugin is
// added to a build by importing its manifest here and listing it; nothing in
// core changes. Its windows' Svelte views are listed apart, in views.ts, so the
// BFF can read this file without loading Svelte.

import type { PluginManifest } from "../web/src/plugin-api/index.ts";
import piManager from "./pi-manager/plugin.ts";

export const PLUGINS: readonly PluginManifest[] = [piManager];
