// The nav tab model (goal R50): which tabs exist, when each is visible, and
// which one is selected — all as data + pure functions so App.svelte stays a
// thin renderer and the rules are unit-testable without a DOM.
//
// Tab visibility is driven by ONE thing: is the character DOCKED or IN SPACE.
// To move a tab between docked-only / in-space-only / both, change its `where`
// on its one line in TABS below — nothing else needs touching (item 1). The
// selected tab derives from the same flag (item 4): the first paint matches
// where the character actually is, and docking / undocking that hides the
// chosen tab falls back to that state's default.

import type { FlightStatus, OnlineCharacterState } from "../store/types.ts";

export type CoreTabID =
  | "fitting"
  | "provisioning"
  | "flight"
  | "mining"
  | "drones"
  | "shots"
  | "equipment"
  | "travel"
  | "bots"
  | "botBuilder"
  | "botManager"
  | "companion"
  | "pluginManager"
  | "inventory"
  | "market"
  | "industry"
  | "contracts"
  | "assets"
  | "compare"
  | "agents"
  | "finder"
  | "skills"
  | "planets"
  | "industryManager"
  | "miningOperations"
  | "activity"
  | "fleet"
  | "watchlist"
  | "scanner"
  | "mail"
  | "contacts"
  | "locations"
  | "chat"
  | "wallet"
  | "corpWallet"
  | "redeem"
  | "loginRewards"
  | "characterSheet"
  | "corporation"
  | "memberDetails"
  | "medalDesigner"
  | "routeWindow"
  | "missionTracker"
  | "log"
  | "settings";

/**
 * A window a plugin contributes. Namespaced so it can never take a core
 * panel's id, and open-ended because core does not know which plugins a build
 * carries: a plugin registers its tab (`registerTab`) while plugins load.
 */
export type PluginTabID = `plugin:${string}`;

export type TabID = CoreTabID | PluginTabID;

/** True for a plugin's tab, false for one of core's. */
export function isPluginTab(id: TabID): id is PluginTabID {
  return id.startsWith("plugin:");
}

/** Where a tab may appear: only DOCKED, only IN SPACE, or in BOTH. */
export type Where = "docked" | "in-space" | "both";

export interface TabDef {
  readonly id: TabID;
  readonly label: string;
  readonly where: Where;
  /**
   * False for a CONTEXTUAL panel — one that only ever opens because something
   * was clicked, and so must not sit in the launcher rail waiting to be opened
   * empty.
   *
   * ⚠ Absent means TRUE. Every tab that existed before this flag is launchable,
   * so the default has to be the one that leaves them alone; only the exception
   * writes it down. Read it with `isLaunchable`, never `tab.launchable` — an
   * `undefined` is a yes here and a bare truthiness test gets that backwards.
   */
  readonly launchable?: boolean;
  /**
   * A plugin tab's Neocom glyph, as neocomIcons.ts draws one. Core tabs leave it
   * out: theirs are in `NEOCOM_GLYPHS`, which is exhaustive over `CoreTabID`.
   */
  readonly glyph?: readonly string[];
}

/** One of core's own tabs, which TABS lists. */
export interface CoreTabDef extends TabDef {
  readonly id: CoreTabID;
}

// ⚠ THE TAB TABLE — the one place tab visibility is decided. Render order is the
// order of this list (state-specific tabs first, then the shared ones).
export const TABS: readonly CoreTabDef[] = [
  { id: "provisioning", label: "Ready Fit", where: "both" },
  // The Fitting window opens in space as well as docked, as the client's does
  // (eveCommands._OpenNewFittingWnd: `session.stationid is None or
  // HasServiceAccess('fitting')`): in space it shows the ship's figures as the
  // client reckons them (flow.reckonActiveShip) and simulates. (Station services +
  // guests are NOT a Neocom tab: they live as a tab INSIDE the docked Inventory &
  // Ship dock panel, next to the hangars, so the station never duplicates itself
  // into a separate window.)
  { id: "fitting", label: "Fitting", where: "both" },
  // ⚠ TRAVEL IS REACHABLE IN SPACE NOW, and that is a restored capability
  // rather than a new one. The old cockpit's overview list ended in a synthetic
  // "Somewhere else…" row: a way to set a destination that is NOT on this grid,
  // over `searchDestinations`. The redesigned overview panel is a list of what
  // is around the ship and has no such row — so when the cockpit went, a flying
  // pilot lost every way to route themselves anywhere off-grid, with Travel
  // sitting one tab away and marked docked-only. It reads no docked state at
  // all; it was only ever labelled that way because route planning was assumed
  // to happen before undocking.
  { id: "travel", label: "Travel", where: "both" },
  // The two BUILT-IN bots (mining, mission): their live requirement checklists
  // and their setup forms. Runs in space, so it stays available in both states.
  //
  // ⚠ NOT LAUNCHABLE — reached from the Bot Manager, the one door onto bots.
  // The Manager's pilot rows offer the built-ins in the same picker as the saved
  // scripts and open this panel to set one up. It could not simply be DELETED
  // along with its entry: the Manager can start a saved script on any pilot
  // because a script has an id to hand to a runner, but a built-in is code in
  // nav/botRegistry.ts with no id and a setup form of its own (which belt, which
  // agent), read against one pilot's fitting and holds. That does not compress
  // into a row of a multi-pilot table, so it stays a panel and the Manager
  // points at it.
  { id: "bots", label: "Bots", where: "both", launchable: false },
  // ⚠ NOT LAUNCHABLE — reached from the Bot Manager, which is the ONE door onto
  // bots. It is not contextual in Show Info's sense (it opens perfectly well on
  // nothing: a new, empty bot), so this is a grouping decision rather than a
  // structural one: four bot entries in the rail was three too many, and the
  // Builder is the one a player reaches for AFTER deciding to write or change a
  // bot — which is a decision made while looking at the library. The Manager
  // offers "New bot" and an Edit on every saved row; those are the two ways in.
  { id: "botBuilder", label: "Bot Builder", where: "both", launchable: false },
  // ⚠ THERE IS NO "Server Bots" ENTRY, AND THAT IS NOT AN OVERSIGHT. Server-side
  // bots keep flying with the tab closed, so a readout that watches them must be
  // reachable from anywhere — and the Bot Manager IS that readout: its pilots
  // region lists every server bot beside the tab runs and the pilots that could
  // take one. A second entry for the same rows only ever meant two ways into one
  // subject in a rail that already has too many. `ServerBots.svelte` still
  // exists, mounted on character select, which has no Manager to hold it.
  //
  // ⚠ NOT IN THE RAIL ANY MORE. Its door is beside the brand
  // (GlobalLaunchers.svelte), on the character bar AND the Pilot Hangar, so it
  // opens with nobody in the client — which a rail inside a pilot's workspace
  // can never offer.
  { id: "botManager", label: "Bot Manager", where: "both", launchable: false },
  // ⚠ NOT A BOT, AND NOT IN THE RAIL. The fleet companion is a GLOBAL window
  // (globalWindow.ts) over every pilot at once, and the one door onto it is the
  // button beside the brand in the character bar — which is the only chrome
  // that is on screen whichever pilot is active, and so the only honest place
  // to hang a window that is about all of them. A rail entry would be a second
  // door onto one window in a rail this file has already twice trimmed, and a
  // per-pilot door onto a panel that is not per-pilot.
  //
  // It is still a TabID because every window is: the id keys the window, the
  // title comes from `tabLabel`, and `NEOCOM_GLYPHS` is exhaustive over the
  // union whether or not a glyph is ever rendered in the strip.
  { id: "companion", label: "Fleet companions", where: "both", launchable: false },
  // A GLOBAL window too: what this client adds beyond the game's own windows,
  // which is about the client, not a pilot. Its door is beside the brand.
  { id: "pluginManager", label: "Plugins", where: "both", launchable: false },
  // In space only — flying, what's around the ship.
  { id: "flight", label: "Flight", where: "in-space" },
  // ⚠ BOTH, THOUGH MINING IS DONE IN SPACE. The window is the mining loop's
  // dockside half as much as its belt half: its unloading and its refining are
  // a docked pilot's (their routes refuse a pilot in space), and for as long as
  // it was offered in space only, no window of the page refined anything for
  // anyone. In space it shows the holds, compressing and dumping; docked, the
  // holds, unloading and refining.
  { id: "mining", label: "Mining", where: "both" },
  // Two sections of the old overview cockpit, now windows of their own. Both
  // are LAUNCHABLE on purpose: "where are my drones" and "what just hit me" are
  // questions a pilot asks without anything having been clicked first.
  { id: "drones", label: "Drones", where: "in-space" },
  { id: "shots", label: "Shots Fired", where: "in-space" },
  // ⚠ IN-SPACE ONLY, AND NOT A DUPLICATE OF FITTING. Docked, Fitting is the
  // place you change what your hull carries. In space nothing may be refitted —
  // but a module still has to be able to be POWERED UP, and Fitting is not
  // reachable out here. See the header of `EquipmentPanel.svelte`.
  { id: "equipment", label: "Equipment", where: "in-space" },
  { id: "scanner", label: "Scanner", where: "in-space" },
  // Both — reachable docked or undocked.
  { id: "inventory", label: "Inventory & Ship", where: "both" },
  { id: "market", label: "Market", where: "both" },
  { id: "industry", label: "Industry", where: "both" },
  { id: "contracts", label: "Contracts", where: "both" },
  { id: "assets", label: "Personal Assets", where: "both" },
  // The client's Compare Tool (comparisonWindow.py), which its Neocom offers too: types side by side, attribute by
  // attribute. A type's menu (Compare) adds one to it.
  { id: "compare", label: "Compare Tool", where: "both" },
  { id: "agents", label: "Agents & Missions", where: "both" },
  { id: "finder", label: "Agent Finder", where: "both" },
  { id: "skills", label: "Skills", where: "both" },
  { id: "planets", label: "Planets", where: "both" },
  // R109 — a GLOBAL window: a blueprint expanded into its whole build tree,
  // across every signed-in pilot's blueprints. Out of the rail, like the Bot Manager.
  { id: "industryManager", label: "Industry Manager", where: "both", launchable: false },
  { id: "miningOperations", label: "Mining Command Center", where: "both", launchable: false },
  { id: "activity", label: "Activity", where: "both" },
  { id: "fleet", label: "Fleet", where: "both" },
  // The fleet's watch list (fleetWatchList.py WatchListPanel): opened where it is wanted, as the client opens it on an
  // add to it (fleetSvc.AddFavorite, 676), so not offered in the rail.
  { id: "watchlist", label: "Watch List", where: "both", launchable: false },
  { id: "mail", label: "Mail", where: "both" },
  // The client's People & Places (AddressBookWindow), titled Contacts: the pilot's own contacts and blocked owners.
  { id: "contacts", label: "Contacts", where: "both" },
  // The client's Locations window (neocom/locations/window.py): the pilot's bookmarks.
  { id: "locations", label: "Locations", where: "both" },
  { id: "chat", label: "Chat", where: "both" },
  { id: "wallet", label: "Wallet", where: "both" },
  { id: "corpWallet", label: "Corp Wallet", where: "both" },
  // The client's Redeem Items (redeemsvc.py, the neocom's redeem button): what the account may redeem.
  { id: "redeem", label: "Redeem Items", where: "both" },
  // The client's login rewards window (loginCampaignService.py): the account's daily login campaign.
  { id: "loginRewards", label: "Daily Login Rewards", where: "both" },
  // The client's Neocom offers Character Sheet and Corporation, with standings inside each
  // (btnDataRaw.py BTNDATARAW_BY_ID); there is no separate Standings window.
  { id: "characterSheet", label: "Character Sheet", where: "both" },
  { id: "corporation", label: "Corporation", where: "both" },
  // R76 — Show Info. A window like any other (draggable, resizable, remembered),
  // but CONTEXTUAL: it opens on the thing you clicked, so it is not offered in
  // the rail, where it could only ever open onto nothing.
  { id: "memberDetails", label: "Member Details", where: "both", launchable: false },
  { id: "medalDesigner", label: "Create Decoration", where: "both", launchable: false },
  // The client's route window (autopilotSettings.py AutopilotSettings): the waypoints in their order and the avoidance
  // list. Contextual: the client opens it from the route panel's Manage Route (infoPanelRoute.py 123), and so does
  // the page, from Travel.
  { id: "routeWindow", label: "Route and avoidance", where: "both", launchable: false },
  // The client's job board's tracker (InfoPanelJobBoard): each accepted mission and the objective it is on, with its one
  // button. The client keeps it on screen among its info panels; here it is a window the rail opens.
  { id: "missionTracker", label: "Opportunities", where: "both" },
  // R80 — the notice log. Launchable on purpose, unlike Show Info: "what did I
  // miss?" is a question a player asks without anything having been clicked.
  { id: "log", label: "Log", where: "both" },
  // The local client's own settings (icon cache, …) — reachable anywhere.
  { id: "settings", label: "Settings", where: "both" },
];

// The tabs plugins added, in the order they registered. Empty in a build that
// carries no plugin, which is why every reader below goes through `allTabs`.
const pluginTabs: TabDef[] = [];

/**
 * Add a plugin's tab. Called while plugins load, before the first paint; an id
 * that is already a tab is refused, so two plugins can never share a window.
 */
export function registerTab(def: TabDef & { readonly id: PluginTabID }): void {
  if (!isPluginTab(def.id)) throw new Error(`A plugin tab id starts with "plugin:", not "${def.id}".`);
  if (allTabs().some((tab) => tab.id === def.id)) throw new Error(`There is already a tab called "${def.id}".`);
  pluginTabs.push(def);
}

/** Every tab: core's, then the plugins'. */
export function allTabs(): readonly TabDef[] {
  return pluginTabs.length === 0 ? TABS : [...TABS, ...pluginTabs];
}

/**
 * May this tab be opened from the launcher rail?
 *
 * ⚠ `tab.launchable !== false`, NOT `tab.launchable`. The flag is absent on every
 * pre-existing tab and absent means yes; a truthiness test would empty the rail.
 */
export function isLaunchable(tab: TabDef): boolean {
  return tab.launchable !== false;
}

/** The tabs the launcher rail offers in the current state. */
export function launchableTabsFor(isDocked: boolean): readonly TabDef[] {
  return visibleTabsFor(isDocked).filter(isLaunchable);
}

/** The default landing tab for each state (item 4). */
export const DOCKED_DEFAULT: TabID = "inventory";
/**
 * ⚠ NOT "overview" ANY MORE — that tab no longer exists.
 *
 * "Around Your Ship" was the in-space landing panel while the cockpit was a
 * window. The overview is FIXED CHROME now (the dock panel on the right, and
 * the whole screen on mobile), so it is never something to land on: it is
 * already there. Flight is the panel a pilot most often opens next.
 */
export const IN_SPACE_DEFAULT: TabID = "flight";

/**
 * Docked vs in space, from the AUTHORITATIVE flag. Once a flight-status read has
 * landed, `flightStatus.docked` is the truth. Before that first read (the
 * instant after character select), fall back to the station context the
 * character came online in — a station ID means docked. Never a hardcoded guess
 * (the login-default bug this replaces).
 */
export function deriveDocked(
  flightStatus: FlightStatus | null,
  online: OnlineCharacterState | null,
): boolean {
  if (flightStatus !== null) {
    return flightStatus.docked;
  }
  return online !== null && online.stationID !== null;
}

/** The tabs visible in the current state: every "both" tab plus the matching ones. */
export function visibleTabsFor(isDocked: boolean): readonly TabDef[] {
  const state: Where = isDocked ? "docked" : "in-space";
  return allTabs().filter((tab) => tab.where === "both" || tab.where === state);
}

/** The display label for a tab id (falls back to the id if somehow unknown). */
export function tabLabel(id: TabID): string {
  return allTabs().find((tab) => tab.id === id)?.label ?? id;
}

/** Whether a tab id is openable in the current state (used to filter windows). */
export function isTabVisible(id: TabID, isDocked: boolean): boolean {
  return visibleTabsFor(isDocked).some((tab) => tab.id === id);
}

/**
 * The STATIC tabs — reachable in BOTH states, so they persist regardless of
 * docked/undocked. These fill the Neocom rail; the docked/in-space SHELL is the
 * state-specific part beside them. Deliberately state-independent (no argument):
 * that the set never changes with dock/undock is the point.
 */
export function staticTabs(): readonly TabDef[] {
  return allTabs().filter((tab) => tab.where === "both");
}

/** The default landing tab for the current state. */
export function defaultTabFor(isDocked: boolean): TabID {
  return isDocked ? DOCKED_DEFAULT : IN_SPACE_DEFAULT;
}

/**
 * The effective page: the player's explicit choice while it is still visible,
 * otherwise the current state's default. `selected` is null to follow the
 * default. So a chosen tab that a dock/undock hides falls back sanely instead of
 * rendering a blank or the wrong panel.
 */
export function resolvePage(selected: TabID | null, isDocked: boolean): TabID {
  const visible = visibleTabsFor(isDocked);
  if (selected !== null && visible.some((tab) => tab.id === selected)) {
    return selected;
  }
  return defaultTabFor(isDocked);
}
