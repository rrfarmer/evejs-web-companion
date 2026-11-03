// What a global window draws (globalWindow.ts), by tab.
//
// Apart from globalWindow.ts on purpose: desktop.ts reads that module, and a
// Svelte component imported there would be pulled into every pure test of the
// desktop model. Only the two hosts read this one: GlobalPanel on the desktop's
// global layer, PanelHost on a phone, where a global tab is an ordinary panel.

import BotManager from "./BotManager.svelte";
import FleetCompanions from "./FleetCompanions.svelte";
import IndustryManager from "./IndustryManager.svelte";
import PluginManager from "./PluginManager.svelte";
import { pluginWindowView, type GlobalWindowView } from "./pluginWindowViews.ts";
import type { TabID } from "./tabs.ts";

export { registerGlobalWindowView, type GlobalWindowProps, type GlobalWindowView } from "./pluginWindowViews.ts";

const CORE_VIEWS: ReadonlyMap<TabID, GlobalWindowView> = new Map<TabID, GlobalWindowView>([
  ["botManager", BotManager as GlobalWindowView],
  ["companion", FleetCompanions as GlobalWindowView],
  ["industryManager", IndustryManager as GlobalWindowView],
  ["pluginManager", PluginManager as GlobalWindowView],
]);

/** What this global window draws, core's or a plugin's, or null for a tab that is not one. */
export function globalWindowView(id: TabID): GlobalWindowView | null {
  return CORE_VIEWS.get(id) ?? pluginWindowView(id);
}
