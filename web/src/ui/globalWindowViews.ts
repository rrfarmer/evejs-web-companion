// What a global window draws (globalWindow.ts), by tab.
//
// Apart from globalWindow.ts on purpose: desktop.ts reads that module, and a
// Svelte component imported there would be pulled into every pure test of the
// desktop model. Only the two hosts read this one: GlobalPanel on the desktop's
// global layer, PanelHost on a phone, where a global tab is an ordinary panel.

import type { Component } from "svelte";
import BotManager from "./BotManager.svelte";
import FleetCompanions from "./FleetCompanions.svelte";
import IndustryManager from "./IndustryManager.svelte";
import PiManager from "./PiManager.svelte";
import type { Session } from "../app/sessions.ts";
import type { PluginTabID, TabID } from "./tabs.ts";

/**
 * Everything a global window is given. None of it is a pilot's store or flow:
 * a global window is about every pilot, and reaches the ones it acts on through
 * their own sessions or their accounts.
 */
export interface GlobalWindowProps {
  /** Every pilot signed in here. */
  readonly sessions?: readonly Session[];
  /** Open a panel, on the given pilot's workspace or the active one. */
  readonly onOpen?: (tab: TabID, sessionID?: string) => void;
  /** Make a pilot the active cockpit. */
  readonly onGoToPilot?: (sessionID: string) => void;
}

export type GlobalWindowView = Component<GlobalWindowProps>;

const CORE_VIEWS: ReadonlyMap<TabID, GlobalWindowView> = new Map<TabID, GlobalWindowView>([
  ["botManager", BotManager as GlobalWindowView],
  ["companion", FleetCompanions as GlobalWindowView],
  ["piManager", PiManager as GlobalWindowView],
  ["industryManager", IndustryManager as GlobalWindowView],
]);

const pluginViews = new Map<PluginTabID, GlobalWindowView>();

/** Add what a plugin's global window draws. Called while plugins load. */
export function registerGlobalWindowView(id: PluginTabID, view: GlobalWindowView): void {
  if (pluginViews.has(id)) throw new Error(`The global window "${id}" already has a view.`);
  pluginViews.set(id, view);
}

/** What this global window draws, or null for a tab that is not one. */
export function globalWindowView(id: TabID): GlobalWindowView | null {
  return CORE_VIEWS.get(id) ?? pluginViews.get(id as PluginTabID) ?? null;
}
