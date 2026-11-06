// What a plugin draws in the Pilot Hangar (docs/plugins.md, "In the Pilot Hangar"): a
// control on each squad, and a setting under a pilot in each squad it is in. Core
// reads these and knows nothing of what they do.

import type { Component } from "svelte";
import type { ApiOptions } from "../app/api.ts";
import type { Squad } from "../app/hangarPrefs.ts";
import type { PluginID } from "../plugin-api/index.ts";

/** Everything a squad control is given. */
export interface SquadControlProps {
  readonly squad: Squad;
  /** The pilots in this squad. */
  readonly memberIDs: readonly number[];
  /** A pilot's name, for what the control says. */
  readonly pilotNameFor: (characterID: number) => string;
  /** A pilot's own session options if it is signed in to this tab, or null if not. */
  readonly optionsFor: (characterID: number) => ApiOptions | null;
  /** The account a pilot is on, for a control acting on a pilot not signed in here. */
  readonly accountNameFor: (characterID: number) => string;
  /** Tell the tab the server now flies this pilot, so it lets go of the hull. */
  readonly onHandedOver: (characterID: number) => Promise<void>;
  /** Have the Hangar read the server's roster again now. */
  readonly onChanged: () => void;
  /** Lines to show under the squads, or null to clear them. */
  readonly say: (lines: readonly string[] | null) => void;
}

/** Everything a squad member setting is given. */
export interface SquadMemberSettingProps {
  readonly squad: Squad;
  readonly characterID: number;
}

export type SquadControlView = Component<SquadControlProps>;
export type SquadMemberSettingView = Component<SquadMemberSettingProps>;

const squadControls = new Map<PluginID, SquadControlView>();
const memberSettings = new Map<PluginID, SquadMemberSettingView>();

/** Add what a plugin draws in the Hangar. Called while plugins load. */
export function registerHangarViews(
  pluginID: PluginID,
  views: { readonly squadControl?: SquadControlView; readonly squadMemberSetting?: SquadMemberSettingView },
): void {
  if (views.squadControl) squadControls.set(pluginID, views.squadControl);
  if (views.squadMemberSetting) memberSettings.set(pluginID, views.squadMemberSetting);
}

export function pluginSquadControls(): readonly { readonly pluginID: PluginID; readonly view: SquadControlView }[] {
  return [...squadControls].map(([pluginID, view]) => ({ pluginID, view }));
}

export function pluginMemberSettings(): readonly { readonly pluginID: PluginID; readonly view: SquadMemberSettingView }[] {
  return [...memberSettings].map(([pluginID, view]) => ({ pluginID, view }));
}
