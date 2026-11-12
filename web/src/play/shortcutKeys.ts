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

const TABLE = CLIENT_SHORTCUTS.flatMap((c) => {
  const parsed = parseShortcut(c.keys);
  return parsed ? [{ cmd: c.cmd, ...parsed }] : [];
});

/** The client command a key press is the shortcut of (its modifiers exactly), or null. */
export function commandForKey(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string | null {
  if (e.metaKey) return null;
  const hit = TABLE.find((s) => s.code === e.code && s.ctrl === e.ctrlKey && s.alt === e.altKey && s.shift === e.shiftKey);
  return hit?.cmd ?? null;
}

/** A command's default shortcut as the client writes it ("Alt-C"), "" where it has none. */
export function shortcutOf(cmd: string): string {
  return CLIENT_SHORTCUTS.find((c) => c.cmd === cmd)?.keys ?? "";
}
