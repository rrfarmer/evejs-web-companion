// The process a plugin with bot blocks and no backend of its own decides its
// blocks in, for bots the BFF hosts (src/pluginHost.js). It loads the plugin's
// manifest (plugins/<id>/plugin.ts) and answers nothing but the channel.

import { pathToFileURL } from "node:url";
import { startBackend } from "./backend.ts";
import type { PluginManifest } from "./index.ts";

const manifestPath = process.env.EVEJS_PLUGIN_MANIFEST;
if (!manifestPath) throw new Error("This process was not started by the BFF's plugin host.");
const module = (await import(pathToFileURL(manifestPath).href)) as { default?: PluginManifest };
if (!module.default) throw new Error(`${manifestPath} exports no plugin manifest as its default.`);
startBackend({ manifest: module.default, routes: {}, cleanup: () => {} });
