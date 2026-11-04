// WHICH PLUGIN LAUNCHERS SIT BESIDE THE BRAND — the player's pins.
//
// Every plugin window is in the Plugins menu (PluginMenu.svelte). The strip
// carries only what the player pinned there, so ten plugins cost the strip no
// more than the two the player uses:
//
//   • A WHOLE PLUGIN, pinned: one launcher; a click lists its windows. A plugin
//     with one window has no list, and its launcher opens that window.
//   • ONE WINDOW, pinned: a launcher that opens it. A window of a plugin pinned
//     whole is already listed by that plugin's launcher, so it is not pinned twice.
//
// A plugin the player has not seen before pins itself, whole, while fewer than
// AUTO_PIN_LIMIT launchers are pinned: the first plugins show up without anyone
// setting anything, and the tenth pushes nothing out.
//
// ⚠ UNPINNED MEANS NO LAUNCHER, EVEN WITH ITS WINDOW OPEN. A launcher that stayed while
// its window was open made Unpin look like it did nothing (seen live). An open
// window is still reached from the Plugins menu, and from the window itself.
//
// Per browser, like switching a plugin off (plugins/pluginHost.ts): a
// convenience of this player's, not a fact the server keeps.

import type { PluginWindowGroup } from "./globalWindow.ts";
import type { TabID } from "./tabs.ts";

export type Pin =
  | { readonly kind: "plugin"; readonly pluginID: string }
  | { readonly kind: "window"; readonly windowID: TabID };

export interface PinState {
  /** In the order the player pinned them, which is the order the strip draws. */
  readonly pins: readonly Pin[];
  /** Plugins this browser has met, so a plugin pins itself only on first sight. */
  readonly seen: readonly string[];
}

export const AUTO_PIN_LIMIT = 3;

export const NO_PINS: PinState = Object.freeze({ pins: [], seen: [] });

export function isPluginPinned(state: PinState, pluginID: string): boolean {
  return state.pins.some((pin) => pin.kind === "plugin" && pin.pluginID === pluginID);
}

export function isWindowPinned(state: PinState, windowID: TabID): boolean {
  return state.pins.some((pin) => pin.kind === "window" && pin.windowID === windowID);
}

/**
 * Meet the plugins this page loaded: one never seen before pins itself, whole,
 * while there is room. A pin of a plugin that is not loaded now (switched off,
 * or out of the build) is kept, so it is back where it was when the plugin is.
 */
export function meetPlugins(state: PinState, groups: readonly PluginWindowGroup[]): PinState {
  let pins = [...state.pins];
  const seen = [...state.seen];
  for (const group of groups) {
    if (seen.includes(group.plugin.id)) continue;
    seen.push(group.plugin.id);
    if (pins.length < AUTO_PIN_LIMIT && !isPluginPinned({ pins, seen }, group.plugin.id)) {
      pins = [...pins, { kind: "plugin", pluginID: group.plugin.id }];
    }
  }
  return pins.length === state.pins.length && seen.length === state.seen.length ? state : { pins, seen };
}

/** Pin a plugin whole, or unpin it. Pinning it whole takes back its windows' own pins. */
export function togglePlugin(state: PinState, group: PluginWindowGroup): PinState {
  if (isPluginPinned(state, group.plugin.id)) {
    return { ...state, pins: state.pins.filter((pin) => !(pin.kind === "plugin" && pin.pluginID === group.plugin.id)) };
  }
  const own = new Set<TabID>(group.windows.map((window) => window.id));
  return {
    ...state,
    pins: [...state.pins.filter((pin) => !(pin.kind === "window" && own.has(pin.windowID))), { kind: "plugin", pluginID: group.plugin.id }],
  };
}

/** Pin one window, or unpin it. A window of a plugin pinned whole is left as it is. */
export function toggleWindow(state: PinState, group: PluginWindowGroup, windowID: TabID): PinState {
  if (isPluginPinned(state, group.plugin.id)) return state;
  if (isWindowPinned(state, windowID)) {
    return { ...state, pins: state.pins.filter((pin) => !(pin.kind === "window" && pin.windowID === windowID)) };
  }
  return { ...state, pins: [...state.pins, { kind: "window", windowID }] };
}

/** One launcher the strip draws for plugins. */
export interface PluginLauncher {
  readonly key: string;
  /** `plugin`: a click lists `windows`. `window`: a click opens `windowID`. */
  readonly kind: "plugin" | "window";
  readonly label: string;
  readonly title: string;
  readonly hint: string;
  /** The tab whose glyph the launcher draws. */
  readonly glyphOf: TabID;
  readonly windowID: TabID | null;
  readonly windows: PluginWindowGroup["windows"];
  /** One of its windows is open (put away counts as open). */
  readonly open: boolean;
}

/** The plugin launchers the player pinned, in pin order. */
export function pluginLaunchers(
  state: PinState,
  groups: readonly PluginWindowGroup[],
  openIds: ReadonlySet<TabID>,
): PluginLauncher[] {
  const launchers: PluginLauncher[] = [];
  const covered = new Set<TabID>();
  const windowLauncher = (window: PluginWindowGroup["windows"][number]): PluginLauncher => ({
    key: `window:${window.id}`,
    kind: "window",
    label: window.label,
    title: window.title,
    hint: window.hint,
    glyphOf: window.id,
    windowID: window.id,
    windows: [window],
    open: openIds.has(window.id),
  });
  for (const pin of state.pins) {
    if (pin.kind === "plugin") {
      const group = groups.find((entry) => entry.plugin.id === pin.pluginID);
      if (!group || group.windows.length === 0) continue;
      group.windows.forEach((window) => covered.add(window.id));
      if (group.windows.length === 1) {
        launchers.push(windowLauncher(group.windows[0]!));
        continue;
      }
      launchers.push({
        key: `plugin:${group.plugin.id}`,
        kind: "plugin",
        label: group.plugin.label,
        title: group.plugin.name,
        hint: `${group.plugin.name}: ${group.windows.map((window) => window.title).join(", ")}`,
        glyphOf: group.windows[0]!.id,
        windowID: null,
        windows: group.windows,
        open: group.windows.some((window) => openIds.has(window.id)),
      });
    } else {
      const window = groups.flatMap((group) => group.windows).find((entry) => entry.id === pin.windowID);
      if (!window || covered.has(window.id)) continue;
      covered.add(window.id);
      launchers.push(windowLauncher(window));
    }
  }
  return launchers;
}

// ─── Kept in this browser ────────────────────────────────────────────────────

const STORAGE_KEY = "evejs-web-plugin-pins:v1";

function readPin(value: unknown): Pin | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (entry.kind === "plugin" && typeof entry.pluginID === "string") return { kind: "plugin", pluginID: entry.pluginID };
  if (entry.kind === "window" && typeof entry.windowID === "string") return { kind: "window", windowID: entry.windowID as TabID };
  return null;
}

/** This browser's pins; none when nothing is kept or it cannot be read. */
export function loadPins(): PinState {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    if (raw === null) return NO_PINS;
    const parsed = JSON.parse(raw) as { pins?: unknown; seen?: unknown };
    const pins = Array.isArray(parsed.pins) ? parsed.pins.map(readPin).filter((pin): pin is Pin => pin !== null) : [];
    const seen = Array.isArray(parsed.seen) ? parsed.seen.filter((id): id is string => typeof id === "string") : [];
    return { pins, seen };
  } catch {
    return NO_PINS;
  }
}

/** Keep the pins in this browser. Best effort: blocked storage keeps them for this page only. */
export function savePins(state: PinState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ pins: state.pins, seen: state.seen }));
  } catch {
    // storage blocked
  }
}
