// THE GLOBAL WINDOWS — the windows that do not belong to a pilot.
//
// Every other panel is a view of ONE character's store, so it is right that
// switching pilots tears it down: App mounts a Workspace per active pilot under
// a `{#key active.id}`, and the desktop, its windows and their saved layout all
// live inside that. Three windows are the exception, and none by preference:
//
//   • THE BOT MANAGER. Its pilots region is a table of EVERY held session plus
//     every character with a server bot and no session here — it is a view of
//     the roster, not of a pilot; its library is the account-wide saved-bot
//     list, the same rows whichever pilot is active; and a bot it is watching
//     keeps flying while you switch away. Being torn down mid-run is not a
//     cosmetic loss: the roster refetches from scratch, the search box empties,
//     an open export box closes, and — because the poll restarts — a server
//     bot's alert can go unseen through the gap.
//
//   • FLEET COMPANIONS. A companion is not a bot and is not set up against one
//     ship: the window is a roster of every pilot signed in here (plus every
//     companion the server is flying for this account), because the question it
//     answers — "who is following whom, and who has stopped" — is a question
//     about the whole squad. Tearing it down on a pilot switch would be worse
//     here than for the Manager: the very act of checking on another pilot is
//     what would destroy the view you were checking with.
//
//   • PLANETARY INDUSTRY (R108). Every assigned pilot's colonies on one board,
//     read with no character selected. It is about all of them, and the read it
//     is part-way through would be lost to a switch like the Manager's poll.
//
// So they are hoisted ABOVE that key, into App, onto their own layer over
// whichever workspace is showing. This module is that layer's model: which tabs
// get the treatment, where a new one lands, and how the layer is persisted.
//
// ⚠ A LIST, NOT ONE WINDOW. It held exactly one until the companion arrived,
// and a second member would have made the two windows evict each other — open
// the companions roster and the Bot Manager you were reading vanishes. So the
// reducers below take and return a list, the same `WinState[]` shape the
// desktop model uses, and App drives moves, closes, focus and put-away through
// desktop.ts's own generic reducers. Only OPENING is here, because only opening
// needs to know which tabs are global and where a global window belongs.
//
// ⚠ DESKTOP ONLY. A phone has no floating windows at all — MobileWorkspace is
// one panel at a time — so there is nothing for this layer to hold there and
// App does not mount it. On mobile a global tab is a panel selection like any
// other; see App.svelte.

// ⚠ A TYPE-ONLY IMPORT FROM desktop.ts, AND IT HAS TO STAY ONE. desktop.ts
// imports `isGlobalTab` from here, so the two modules form a cycle; a type is
// erased and cannot participate in one, but a VALUE read at module init could —
// pulling desktop.ts's `DEFAULT_W` into the constants below would evaluate it
// before desktop.ts had finished initialising whenever that module loads first.
// Hence the sizes below are written out rather than derived from its defaults.
import type { WinState } from "./desktop.ts";
import { registerTab, type PluginTabID, type TabID } from "./tabs.ts";

/** One door onto a global window, as the brand strip draws it. */
export interface GlobalLauncher {
  readonly id: TabID;
  /** The word beside the glyph. Short: it shares a header with the brand. */
  readonly label: string;
  /** The window's full name, for the accessible label. */
  readonly title: string;
  /** What the window is for, as a tooltip. */
  readonly hint: string;
}

/**
 * Core's global windows, as the brand strip's doors (GlobalLaunchers.svelte)
 * draw them, in the order drawn. Plugins' follow (`registerGlobalWindow`).
 *
 * ⚠ A WINDOW IS GLOBAL BECAUSE IT HAS A DOOR HERE, AND FOR NO OTHER REASON.
 * These windows are out of the rail (tabs.ts `launchable: false`), so this list
 * is their only door; `isGlobalTab` reads it, so a global tab without a door
 * cannot exist. The rule "is this tab global?" is asked in four places (the
 * rail's open-state, both open paths in Workspace, and desktop.ts's guard),
 * which is why it is one list rather than a comparison spelled out four times.
 */
export const CORE_GLOBAL_LAUNCHERS: readonly GlobalLauncher[] = [
  {
    id: "botManager",
    label: "Bots",
    title: "Bot Manager",
    hint: "Bot Manager — start and watch bots on every pilot and squad",
  },
  {
    id: "piManager",
    label: "PI",
    title: "Planetary Industry",
    hint: "Planetary Industry — every pilot's colonies on one board",
  },
  {
    id: "industryManager",
    label: "Build",
    title: "Industry Manager",
    hint: "Industry Manager — a blueprint's whole build tree, down to raw materials",
  },
  {
    id: "companion",
    label: "Companions",
    title: "Fleet companions",
    hint: "Fleet companions — every pilot flying with a fleet",
  },
  {
    id: "pluginManager",
    label: "Plugins",
    title: "Plugins",
    hint: "Plugins — what this client adds beyond the game's own windows",
  },
];

// The global windows plugins added, in the order they registered.
const pluginLaunchers: GlobalLauncher[] = [];

/** A plugin's global window: its door, and the glyph the door and its chip draw. */
export interface PluginGlobalWindow extends GlobalLauncher {
  readonly id: PluginTabID;
  readonly glyph: readonly string[];
}

/**
 * Add a plugin's global window: a tab of its own (tabs.ts `registerTab`), out of
 * the rail like every global window, and a door beside the brand. Called while
 * plugins load, before the first paint. Its body is registered apart
 * (globalWindowViews.ts), because this module is read by desktop.ts and must
 * not pull a Svelte component into it.
 */
export function registerGlobalWindow(window: PluginGlobalWindow): void {
  registerTab({ id: window.id, label: window.title, where: "both", launchable: false, glyph: window.glyph });
  pluginLaunchers.push({ id: window.id, label: window.label, title: window.title, hint: window.hint });
}

/** Every door beside the brand: core's, then the plugins'. */
export function globalLaunchers(): readonly GlobalLauncher[] {
  return pluginLaunchers.length === 0 ? CORE_GLOBAL_LAUNCHERS : [...CORE_GLOBAL_LAUNCHERS, ...pluginLaunchers];
}

/** True when this tab opens as a global window, not a workspace window. */
export function isGlobalTab(id: TabID): boolean {
  return globalLaunchers().some((launcher) => launcher.id === id);
}

/**
 * The Bot Builder, which floats on this layer but is not a global tab.
 *
 * It is reached only from the Bot Manager's Edit and New bot, and the Manager
 * is a window on this layer. A builder on a pilot's desktop sits UNDER every
 * window here, so it opened behind the very window whose button opened it, and
 * moving it clear to the right only helped on a screen wide enough to hold both.
 * So it floats here too, on top of the Manager, bound to the pilot it was opened
 * for (or to nobody, from the Pilot Hangar: HangarBotBuilder.svelte).
 *
 * ⚠ NOT A GLOBAL TAB. That would demand a launcher in the brand strip it has
 * never had. Nor is it restored from storage (`readWin` drops it): which pilot
 * it reads is decided by the button that opened it, and a reload is not that.
 */
export const BUILDER_TAB: TabID = "botBuilder";

/** True when this tab floats on the global layer: a global tab, or the Bot Builder. */
export function isGlobalWindow(id: TabID): boolean {
  return isGlobalTab(id) || id === BUILDER_TAB;
}

/**
 * Where a global window first appears: offset from the top-left of its layer,
 * and roomier than a default workspace window because both of these lead with a
 * multi-column table of pilots.
 */
export const DEFAULT_GLOBAL_POS = { x: 64, y: 48 };
export const DEFAULT_GLOBAL_W = 720;
export const DEFAULT_GLOBAL_H = 520;

/** The second window lands clear of the first rather than exactly on it. */
const GLOBAL_CASCADE_STEP = 32;

/** The highest z on the layer (0 when it is empty). */
function topGlobalZ(wins: readonly WinState[]): number {
  return wins.reduce((max, w) => (w.z > max ? w.z : max), 0);
}

/**
 * Open `id` on the global layer, or bring it forward if it is already there.
 *
 * Reopening what is already open never MOVES it — the button that opens a
 * global window is a way back onto a window that may simply be put away, and a
 * window that jumped back to its default corner every time you pressed that
 * would be a window you could not keep anywhere. So an existing one is raised
 * and un-put-away where it stands; only a genuinely new one is placed.
 *
 * A tab that is not global is refused rather than placed here: it belongs to a
 * pilot's desktop, and drawing it on this layer would put a character-scoped
 * panel above the character bar that switches characters. The one exception is
 * `BUILDER_TAB`, which App binds to one pilot (or nobody) when it opens it.
 */
export function openGlobal(wins: readonly WinState[], id: TabID): WinState[] {
  if (!isGlobalWindow(id)) return wins.slice();
  const z = topGlobalZ(wins) + 1;
  const existing = wins.find((w) => w.id === id);
  if (existing) {
    return wins.map((w) => (w.id === id ? { ...w, z, minimized: false } : w));
  }
  const step = GLOBAL_CASCADE_STEP * wins.length;
  return [
    ...wins,
    {
      id,
      x: DEFAULT_GLOBAL_POS.x + step,
      y: DEFAULT_GLOBAL_POS.y + step,
      w: DEFAULT_GLOBAL_W,
      h: DEFAULT_GLOBAL_H,
      z,
      minimized: false,
    },
  ];
}

// ── persistence ────────────────────────────────────────────────────────────
//
// ⚠ NOT KEYED BY CHARACTER, AND THAT IS THE WHOLE POINT. desktop.ts stores a
// layout per characterID because a desktop belongs to a pilot. These windows do
// not belong to one, so a per-character key would give a player one Bot Manager
// position per pilot — the same window jumping around as they switch, which is
// exactly the behaviour being removed.

const STORAGE_KEY = "evejs-web-global-windows:v2";
/**
 * The key v2 replaced, holding ONE window object.
 *
 * ⚠ READ, NOT IGNORED. A player has a Bot Manager sitting where they put it,
 * and shipping a new key without reading the old one would silently throw that
 * away and reopen it in the default corner. It is migrated on the first load
 * and then removed, so this fallback cannot drift back into use.
 */
const LEGACY_STORAGE_KEY = "evejs-web-global-window:v1";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * One stored window, rebuilt field by field, or null when it is unusable.
 *
 * Rebuilt rather than spread, for desktop.ts's reason: a stale key that rides in
 * on a `{ ...parsed }` is written straight back out on the next save and lives
 * forever. An id that is no longer global is dropped — that is the migration
 * path if a tab ever stops being global.
 */
function readWin(v: unknown): WinState | null {
  if (!v || typeof v !== "object") return null;
  const w = v as Record<string, unknown>;
  if (typeof w.id !== "string" || !isGlobalTab(w.id as TabID)) return null;
  if (!isFiniteNumber(w.x) || !isFiniteNumber(w.y) || !isFiniteNumber(w.w) || !isFiniteNumber(w.h)) {
    return null;
  }
  return {
    id: w.id as TabID,
    x: w.x,
    y: w.y,
    w: w.w,
    h: w.h,
    // Absent in everything written while this layer held one window, where a
    // stack of one needed no order. One is a fine z for a returning window:
    // `openGlobal` raises whatever is opened next above it.
    z: isFiniteNumber(w.z) ? w.z : 1,
    minimized: w.minimized === true,
  };
}

/**
 * Read the saved global windows. Empty when there are none or none are usable.
 *
 * ⚠ ONE WINDOW PER TabID, ENFORCED ON THE WAY IN. That is this model's core
 * invariant and the reducers all keep it — but storage is not a reducer, and a
 * duplicate id makes App's keyed `{#each … (win.id)}` throw on every render
 * from then on, permanently, because the bad list is written straight back out.
 * First one wins; the rest are dropped.
 */
export function loadGlobalWindows(): WinState[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return migrateLegacy();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<TabID>();
    const wins: WinState[] = [];
    for (const entry of parsed) {
      const win = readWin(entry);
      if (win === null || seen.has(win.id)) continue;
      seen.add(win.id);
      wins.push(win);
    }
    return wins;
  } catch {
    return [];
  }
}

/** The v1 single-window key, read once and then cleared. */
function migrateLegacy(): WinState[] {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    const win = readWin(JSON.parse(raw) as unknown);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return win === null ? [] : [win];
  } catch {
    return [];
  }
}

/** Persist the global windows. Best-effort, never fatal. */
export function saveGlobalWindows(wins: readonly WinState[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (wins.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(wins));
    }
  } catch {
    // storage full or blocked — window persistence is best-effort.
  }
}
