// What each plugin's windows draw, for the browser only (see index.ts).

import type { PluginViewsEntry } from "../web/src/plugin-api/index.ts";

export const PLUGIN_VIEWS: readonly PluginViewsEntry[] = [
  { id: "pi-manager", load: () => import("./pi-manager/views.ts") },
  { id: "fleet-companion", load: () => import("./fleet-companion/views.ts") },
];
