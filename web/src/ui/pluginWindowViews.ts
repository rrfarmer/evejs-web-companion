// What a plugin's global window draws, registered while plugins load
// (plugins/pluginHost.ts). Apart from globalWindowViews.ts, which imports
// core's own windows, so the BFF's bot host can load plugins without Svelte.

import type { Component } from "svelte";
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

const pluginViews = new Map<PluginTabID, GlobalWindowView>();

/** Add what a plugin's global window draws. Called while plugins load. */
export function registerGlobalWindowView(id: PluginTabID, view: GlobalWindowView): void {
  if (pluginViews.has(id)) throw new Error(`The global window "${id}" already has a view.`);
  pluginViews.set(id, view);
}

/** What a plugin's global window draws, or null. */
export function pluginWindowView(id: TabID): GlobalWindowView | null {
  return pluginViews.get(id as PluginTabID) ?? null;
}
