// What each plugin's windows draw, for the browser only (see index.ts).

import type { PluginViews } from "../web/src/plugin-api/index.ts";
import piManager from "./pi-manager/views.ts";

export const PLUGIN_VIEWS: readonly PluginViews[] = [piManager];
