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

export type TabID =
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
  | "inventory"
  | "market"
  | "industry"
  | "contracts"
  | "assets"
  | "agents"
  | "finder"
  | "skills"
  | "planets"
  | "piManager"
  | "industryManager"
  | "miningOperations"
  | "activity"
  | "fleet"
  | "scanner"
  | "mail"
  | "chat"
  | "wallet"
  | "corpWallet"
  | "standings"
  | "characterSheet"
  | "showInfo"
  | "log"
  | "settings";

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
}

// ⚠ THE TAB TABLE — the one place tab visibility is decided. Render order is the
// order of this list (state-specific tabs first, then the shared ones).
export const TABS: readonly TabDef[] = [
  { id: "provisioning", label: "Готовый фит", where: "both" },
  // Docked only — fitting needs a station; route planning is set up while
  // docked. (Station services + guests are NOT a Neocom tab: they live as a
  // tab INSIDE the docked Inventory & Ship dock panel, next to the hangars,
  // so the station never duplicates itself into a separate window.)
  { id: "fitting", label: "Fitting", where: "docked" },
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
  // In space only — flying, what's around the ship, mining.
  { id: "flight", label: "Flight", where: "in-space" },
  { id: "mining", label: "Mining", where: "in-space" },
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
  { id: "agents", label: "Agents & Missions", where: "both" },
  { id: "finder", label: "Agent Finder", where: "both" },
  { id: "skills", label: "Skills", where: "both" },
  { id: "planets", label: "Planets", where: "both" },
  // R108 slice 3 — a GLOBAL window (globalWindow.ts): every assigned pilot's
  // colonies on one board, read with no character selected. Out of the rail
  // like the Bot Manager: its door is beside the brand (GlobalLaunchers.svelte).
  { id: "piManager", label: "Planetary Industry", where: "both", launchable: false },
  // R109 — a GLOBAL window: a blueprint expanded into its whole build tree,
  // across every signed-in pilot's blueprints. Out of the rail, like PI.
  { id: "industryManager", label: "Industry Manager", where: "both", launchable: false },
  { id: "miningOperations", label: "Mining Command Center", where: "both", launchable: false },
  { id: "activity", label: "Activity", where: "both" },
  { id: "fleet", label: "Fleet", where: "both" },
  { id: "mail", label: "Mail", where: "both" },
  { id: "chat", label: "Chat", where: "both" },
  { id: "wallet", label: "Wallet", where: "both" },
  { id: "corpWallet", label: "Corp Wallet", where: "both" },
  { id: "standings", label: "Standings", where: "both" },
  { id: "characterSheet", label: "Character Sheet", where: "both" },
  // R76 — Show Info. A window like any other (draggable, resizable, remembered),
  // but CONTEXTUAL: it opens on the thing you clicked, so it is not offered in
  // the rail, where it could only ever open onto nothing.
  { id: "showInfo", label: "Show Info", where: "both", launchable: false },
  // R80 — the notice log. Launchable on purpose, unlike Show Info: "what did I
  // miss?" is a question a player asks without anything having been clicked.
  { id: "log", label: "Log", where: "both" },
  // The local client's own settings (icon cache, …) — reachable anywhere.
  { id: "settings", label: "Settings", where: "both" },
];

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
  return TABS.filter((tab) => tab.where === "both" || tab.where === state);
}

/** The display label for a tab id (falls back to the id if somehow unknown). */
export function tabLabel(id: TabID): string {
  return TABS.find((tab) => tab.id === id)?.label ?? id;
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
  return TABS.filter((tab) => tab.where === "both");
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
