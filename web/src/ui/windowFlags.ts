// The desktop windows' own window actions, as the client's Window keeps them (carbonui window/control/action.py):
// LockWindowAction (no moving or resizing), LightBackgroundWindowAction (the light background turned off) and
// CollapseWindowAction (folded to the header). Kept per window id; applied as classes on the window's element.

export type WindowFlag = "locked" | "nolight" | "light" | "collapsed" | "compact";
export const WINDOW_ACTION_WORDS: readonly string[] = ["/Carbon/UI/Controls/Window/Lock", "/Carbon/UI/Controls/Window/Unlock",
  "/Carbon/UI/Controls/Window/EnableLightBackground", "/Carbon/UI/Controls/Window/DisableLightBackground",
  "/Carbon/UI/Controls/Window/Collapse", "/Carbon/UI/Controls/Window/Expand",
  "/Carbon/UI/Controls/Window/EnableCompactMode", "/Carbon/UI/Controls/Window/DisableCompactMode"];

const key = (id: string) => `evejs-desktop-window-flags:${id}`;

export function windowFlags(id: string): Record<WindowFlag, boolean> {
  try {
    const f = JSON.parse(globalThis.localStorage?.getItem(key(id)) ?? "{}") as Partial<Record<WindowFlag, boolean>>;
    return { locked: !!f.locked, nolight: !!f.nolight, light: !!f.light, collapsed: !!f.collapsed, compact: !!f.compact };
  } catch {
    return { locked: false, nolight: false, light: false, collapsed: false, compact: false };
  }
}

/** The window's element (`.win[data-win=id]`) given its kept flags as classes (win-locked, win-nolight, win-light, win-collapsed). */
export function applyWindowFlags(id: string): void {
  const el = globalThis.document?.querySelector<HTMLElement>(`.win[data-win="${id}"]`);
  if (!el) return;
  const f = windowFlags(id);
  el.classList.toggle("win-locked", f.locked);
  el.classList.toggle("win-nolight", f.nolight);
  el.classList.toggle("win-light", f.light);
  el.classList.toggle("win-collapsed", f.collapsed);
  el.classList.toggle("win-compact", f.compact);
}

export function setWindowFlag(id: string, flag: WindowFlag, on: boolean): void {
  const f = { ...windowFlags(id), [flag]: on };
  try { globalThis.localStorage?.setItem(key(id), JSON.stringify(f)); } catch { /* this visit only */ }
  applyWindowFlags(id);
}
