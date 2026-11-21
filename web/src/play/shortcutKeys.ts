// The play page's keys as the client's: a key press matched against the client's default shortcuts
// (clientShortcuts.ts, CommandMapping's shortcut: its modifiers and its one key, matched exactly as the command
// service's GetCommandByShortcut does), so what the Shortcuts panel lists is what the page does.

import { CLIENT_SHORTCUTS } from "./clientShortcuts.ts";

/** The client's key names (GetKeyName) as KeyboardEvent.code. */
const CODE_BY_NAME: Record<string, string> = {
  Space: "Space", Enter: "Enter", Esc: "Escape", Tab: "Tab", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
  "Num +": "NumpadAdd", "Num -": "NumpadSubtract", "Num *": "NumpadMultiply", "Num /": "NumpadDivide", Backspace: "Backspace",
  Home: "Home", End: "End", "Page Up": "PageUp", "Page Down": "PageDown", Insert: "Insert", Delete: "Delete", Pause: "Pause",
  ".": "Period", ",": "Comma", "-": "Minus", "=": "Equal", ";": "Semicolon", "/": "Slash", "`": "Backquote", "[": "BracketLeft",
  "\\": "Backslash", "]": "BracketRight", "'": "Quote",
};

export interface ParsedShortcut { readonly ctrl: boolean; readonly alt: boolean; readonly shift: boolean; readonly code: string }

/** "Ctrl-Alt-W" as the modifiers and the key's code; null for a shortcut without a key of its own ("Alt", "Ctrl"). */
export function parseShortcut(keys: string): ParsedShortcut | null {
  if (!keys) return null;
  // the names are joined by "-", and "Num -" / "-" are names themselves
  const parts = keys.match(/Num [-+*/]|[^-]+|-(?=$)/g) ?? [];
  let ctrl = false, alt = false, shift = false, code: string | null = null;
  for (const part of parts) {
    if (part === "Ctrl") ctrl = true;
    else if (part === "Alt") alt = true;
    else if (part === "Shift") shift = true;
    else if (/^[A-Z]$/.test(part)) code = `Key${part}`;
    else if (/^[0-9]$/.test(part)) code = `Digit${part}`;
    else if (/^F\d{1,2}$/.test(part)) code = part;
    else if (/^Num \d$/.test(part)) code = `Numpad${part.slice(4)}`;
    else if (part in CODE_BY_NAME) code = CODE_BY_NAME[part]!;
    else return null; // a mouse button, Prnt Scrn, Win: not a key the page is given
  }
  return code === null ? null : { ctrl, alt, shift, code };
}

// settings.user.cmd.customCmds: the pilot's own shortcuts (CommandMap.RemapCommand), each command's keys as the client
// writes them, "" where cleared; a command not in it has its default.
const CUSTOM_KEY = "evejs-play-customCmds";
let custom: Record<string, string> = (() => {
  try { const v = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "{}") as unknown; return v && typeof v === "object" ? v as Record<string, string> : {}; } catch { return {}; }
})();
const listeners = new Set<() => void>();
/** Told when a shortcut is mapped, cleared or the defaults restored (OnMapShortcut / OnRestoreDefaultShortcuts). */
export function onShortcutsChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function keep(next: Record<string, string>): void {
  custom = next;
  try { if (Object.keys(next).length) localStorage.setItem(CUSTOM_KEY, JSON.stringify(next)); else localStorage.removeItem(CUSTOM_KEY); } catch { /* lasts the page */ }
  table = null;
  for (const l of [...listeners]) l();
}
/** CommandMap.RemapCommand(cmd, keys): "" clears it (ClearMappedCmd). */
export function remapShortcut(cmd: string, keys: string): void { keep({ ...custom, [cmd]: keys }); }
/** RestoreDefaults: settings.user.cmd.customCmds = {}. */
export function restoreDefaultShortcuts(): void { keep({}); }

let table: { cmd: string; ctrl: boolean; alt: boolean; shift: boolean; code: string }[] | null = null;
function lookup() {
  table ??= CLIENT_SHORTCUTS.flatMap((c) => {
    const parsed = parseShortcut(shortcutOf(c.cmd));
    return parsed ? [{ cmd: c.cmd, ...parsed }] : [];
  });
  return table;
}

/** The client command a key press is the shortcut of (its modifiers exactly), or null. */
export function commandForKey(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  if (e.metaKey) return null;
  const hit = lookup().find((s) => s.code === e.code && s.ctrl === e.ctrlKey && s.alt === e.altKey && s.shift === e.shiftKey);
  return hit?.cmd ?? null;
}

/** CommandMap.GetCommandByShortcut: the command this shortcut ("Ctrl-K") is mapped to now, or null. */
export function commandWithShortcut(keys: string): string | null {
  if (!keys) return null;
  return CLIENT_SHORTCUTS.find((c) => shortcutOf(c.cmd) === keys)?.cmd ?? null;
}

const NAME_BY_CODE: Record<string, string> = Object.fromEntries(Object.entries(CODE_BY_NAME).map(([n, c]) => [c, n]));
/**
 * MapCmdWindow.Apply: the modifiers held and the key let go, as the client writes them ("Ctrl-Shift-K"); null for a
 * modifier alone or a key the page does not know.
 */
export function shortcutFromKey(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey">): string | null {
  const code = e.code;
  if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)) return null;
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F\d{1,2}$/.test(code) ? code
    : /^Numpad\d$/.test(code) ? `Num ${code.slice(6)}` : NAME_BY_CODE[code] ?? null;
  if (key === null) return null;
  return [e.ctrlKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", key].filter(Boolean).join("-");
}

/**
 * The client's combat commands (eveCommands.py: each LoadCombatCommand(movementFunctions.X / menu function, cmd)) - not
 * run as their key is pressed: loaded while it is held, the next click on an object running it on that object.
 * The modifier-only ones (Ctrl lock, Ctrl+Shift unlock, Shift select, Alt look at) are a click with the modifiers held.
 */
export const COMBAT_COMMANDS = [
  "CmdApproachItem", "CmdOrbitItem", "CmdKeepItemAtRange", "CmdWarpToItem", "CmdDockOrJumpOrActivateGate", "CmdAlignToItem",
  "CmdShowItemInfo", "CmdLockTargetItem", "CmdUnlockTargetItem", "CmdSelectTargetItem", "CmdToggleLookAtItem",
] as const;
export type CombatCommand = (typeof COMBAT_COMMANDS)[number];
export const isCombatCommand = (cmd: string): cmd is CombatCommand => (COMBAT_COMMANDS as readonly string[]).includes(cmd);

/** The combat command a click with these modifiers held is (its shortcut only modifiers), or null. */
export function combatForModifiers(m: { ctrl: boolean; shift: boolean; alt: boolean }): CombatCommand | null {
  for (const cmd of COMBAT_COMMANDS) {
    const keys = shortcutOf(cmd);
    if (!keys || parseShortcut(keys) !== null) continue;
    const parts = keys.split("-");
    if (parts.includes("Ctrl") === m.ctrl && parts.includes("Shift") === m.shift && parts.includes("Alt") === m.alt) return cmd;
  }
  return null;
}

/** The labels the combat commands' indication shows (their names, and UI/Commands/ClickTarget). */
export const COMBAT_WORDS: readonly string[] = [
  ...COMBAT_COMMANDS.map((cmd) => CLIENT_SHORTCUTS.find((c) => c.cmd === cmd)?.label ?? null).filter((l): l is string => l !== null),
  "UI/Commands/ClickTarget",
];
/** A command's name label, or null. */
export function labelOf(cmd: string): string | null {
  return CLIENT_SHORTCUTS.find((c) => c.cmd === cmd)?.label ?? null;
}

/** A command's shortcut as the client writes it ("Alt-C"): the pilot's own where mapped, else the default; "" for none. */
export function shortcutOf(cmd: string): string {
  if (cmd in custom) return custom[cmd]!;
  return CLIENT_SHORTCUTS.find((c) => c.cmd === cmd)?.keys ?? "";
}
