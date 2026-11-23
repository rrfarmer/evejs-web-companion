// The radial menu's two settings in the system menu's Gameplay > Inflight section (systemmenu.py
// ConstructInflightMenuData): Expand Action Menu, settings.user.ui actionmenuBtn - the mouse button held to open it
// (GetMouseButtonOptions: uiconst MOUSELEFT 0, MOUSEMIDDLE 2, MOUSERIGHT 1, MOUSEXBUTTON1 3, MOUSEXBUTTON2 4; left by
// default) - and the delay, actionMenuExpandTime, 0 to 450 ms (radialMenuSvc RADIAL_MENU_EXPAND_DELAY_MIN / MAX,
// 150 by default; clamped as _ClampActionMenuExpandTime clamps it; 0 opens it at the press).
export const RADIAL_DELAY_MIN = 0, RADIAL_DELAY_MAX = 450, RADIAL_DELAY_DEFAULT = 150;
/** GetMouseButtonOptions, in its order: the label and the client's button. */
export const RADIAL_BUTTON_OPTIONS: readonly (readonly [string, number])[] = [
  ["UI/Common/Input/Mouse/LeftMouseButton", 0], ["UI/Common/Input/Mouse/MiddleMouseButton", 2],
  ["UI/Common/Input/Mouse/RightMouseButton", 1], ["UI/Common/Input/Mouse/ExtraMouseButton1", 3],
  ["UI/Common/Input/Mouse/ExtraMouseButton2", 4],
];
export const RADIAL_SETTING_WORDS: readonly string[] = [
  "UI/SystemMenu/GeneralSettings/Inflight/ExpandActionMenu", "UI/SystemMenu/GeneralSettings/Inflight/RadialMenuDelay",
  "UI/SystemMenu/GeneralSettings/Inflight/BracketListDelay", "UI/SystemMenu/GeneralSettings/Inflight/CompactBracketListWhenSnapped",
  "UI/SystemMenu/GeneralSettings/Inflight/CompactBracketListWhenNotSnapped", "UI/SystemMenu/GeneralSettings/Inflight/DisableEmergencyWarp", "UI/Crimewatch/Duel/EscMenuSectionHeader", "UI/Crimewatch/Duel/AutoRejectDuelInvites", "UI/SystemMenu/GeneralSettings/Inflight/NoBracketListDelay", "UI/SystemMenu/GeneralSettings/Inflight/LongBracketListDelay",
  ...RADIAL_BUTTON_OPTIONS.map((o) => o[0]),
];
const BTN = "evejs.play.actionmenuBtn", DELAY = "evejs.play.actionMenuExpandTime";
const readNum = (k: string): number | null => { try { const v = localStorage.getItem(k); return v === null ? null : Number(v); } catch { return null; } };
const writeNum = (k: string, v: number): void => { try { localStorage.setItem(k, String(v)); } catch { /* not kept */ } };

/** The client's button (uiconst), left where the kept one is not one of the five. */
export function radialButton(): number {
  const v = readNum(BTN);
  return v !== null && RADIAL_BUTTON_OPTIONS.some((o) => o[1] === v) ? v : 0;
}
export function setRadialButton(v: number): void { writeNum(BTN, v); }
/** The DOM PointerEvent.button of the client's button. */
export function radialDomButton(): number { return [0, 2, 1, 3, 4][radialButton()] ?? 0; }
/** The delay in ms, clamped. */
export function radialDelay(): number {
  const v = readNum(DELAY);
  return v === null || !Number.isFinite(v) ? RADIAL_DELAY_DEFAULT : Math.min(RADIAL_DELAY_MAX, Math.max(RADIAL_DELAY_MIN, Math.round(v)));
}
export function setRadialDelay(v: number): void { writeNum(DELAY, v); }
/** The Inflight section's Bracket List Delay (tooltipHandler TOOLTIP_SETTINGS_BRACKET tooltipDelayBracket, 5 to 3005 ms, 50 by
 *  default: TOOLTIP_DELAY_MIN / MAX / BRACKET): what InSpaceBracket.GetTooltipDelay gives the overlapping brackets' list. */
export const BRACKET_DELAY_MIN = 5, BRACKET_DELAY_MAX = 3005, BRACKET_DELAY_DEFAULT = 50;
const BRACKET = "evejs.play.tooltipDelayBracket";
/** The User Interface section's General Tooltips Delay (systemmenu GetTooltipSection: tooltipHandler TOOLTIP_SETTINGS_GENERIC
 *  tooltipDelayGeneric, TOOLTIP_DELAY_MIN 5 to TOOLTIP_DELAY_MAX 3005, TOOLTIP_DELAY_GENERIC 250 by default): the wait before a
 *  hint or a tooltip panel shows (_GetSleepTime; a fifth of it while one shows or just closed). */
export const GENERIC_DELAY_DEFAULT = 250;
const GENERIC = "evejs.play.tooltipDelayGeneric";
export function genericTooltipDelay(): number {
  const v = readNum(GENERIC);
  return v === null || !Number.isFinite(v) ? GENERIC_DELAY_DEFAULT : Math.min(BRACKET_DELAY_MAX, Math.max(BRACKET_DELAY_MIN, Math.round(v)));
}
export function setGenericTooltipDelay(v: number): void { writeNum(GENERIC, v); }
export function bracketListDelay(): number {
  const v = readNum(BRACKET);
  return v === null || !Number.isFinite(v) ? BRACKET_DELAY_DEFAULT : Math.min(BRACKET_DELAY_MAX, Math.max(BRACKET_DELAY_MIN, Math.round(v)));
}
export function setBracketListDelay(v: number): void { writeNum(BRACKET, v); }
/** Compact Bracket List When Snapped / Not Snapped (bracketmenu_docked False, bracketmenu_floating True): the list of a
 *  bracket at the layer's edge (InSpaceBracket.IsFloating false) or inside it is the compact one (icons, names beside). */
const DOCKED = "evejs.play.bracketmenu_docked", FLOATING = "evejs.play.bracketmenu_floating";
const readBool = (k: string, d: boolean): boolean => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch { return d; } };
export function bracketListCompact(floating: boolean): boolean { return floating ? readBool(FLOATING, true) : readBool(DOCKED, false); }
export function setBracketListCompact(floating: boolean, v: boolean): void { try { localStorage.setItem(floating ? FLOATING : DOCKED, v ? "1" : "0"); } catch { /* not kept */ } }
