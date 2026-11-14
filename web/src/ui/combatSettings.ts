// The client's combat message settings (shared/uilog.py): the Log window's combat settings menu
// (LoggerWindow._get_combat_message_menu) and what godma / the logger / CombatMessage read from them.
//  - Combat Messages To Display: SHOW_INFLIGHT_MESSAGE_SETTINGS, eleven ShowDamageMessageSettings (true by default;
//    the miss / inflicted / incurred ones usable only while damage notifications are on, the remote assistance
//    incoming / outgoing only while remote assistance is). godma.OnDamageMessage drops a damage message where
//    damageMessages is off, a miss (damage 0) where damageMessagesNoDamage is, a shot at us (owner or source in its
//    args) where damageMessagesEnemy is, one of ours where damageMessagesMine is - the log's line too.
//  - In-space Notifications (ExtraInfoHeader): show (damageMessageShowInspaceNotifications, true), the ship type,
//    the ticker, the weapon (false) and the hit quality (true); each usable only while the ones above it are on; then
//    Enter / Exit Message Moving Mode (logger.MoveNotifications).
//  - Font Size: dmgnotifictions_fontsize 10 / 12 / 14 (12). Font Alignment: dmgnotifictions_alignment auto / left /
//    right / center (auto), then Reset Alignment (the box's place forgotten, the alignment auto).
//  - The box's place: damageMessages_config (align, text alignment, left, topOffset), saved as it is dragged.
import { get, writable } from "svelte/store";

export interface CombatSetting {
  readonly key: string;
  readonly label: string;
  readonly hint?: string;
  /** The settings it is usable only while on (ShowDamageMessageSetting's depends_on, DependentCheckbox's). */
  readonly dependsOn: readonly string[];
  readonly fallback: boolean;
}

const L = "UI/SystemMenu/GeneralSettings/Inflight/";
/** SHOW_INFLIGHT_MESSAGE_SETTINGS, in the menu's order. */
export const COMBAT_DISPLAY_SETTINGS: readonly CombatSetting[] = [
  { key: "notifyMessagesEnabled", label: `${L}ShowTacticalNotifications`, hint: `${L}ShowTacticalNotificationTooltip`, dependsOn: [], fallback: true },
  { key: "damageMessages", label: `${L}DamageNotifications`, dependsOn: [], fallback: true },
  { key: "energyWarfareMessages", label: `${L}ShowEnergyWarfareNotifications`, dependsOn: [], fallback: true },
  { key: "remoteAssistanceMessages", label: `${L}ShowRemoteAssistanceNotifications`, dependsOn: [], fallback: true },
  { key: "actionMessagesBounty", label: `${L}ShowBountyNotifications`, dependsOn: [], fallback: true },
  { key: "actionMessagesMining", label: `${L}ShowMiningNotification`, dependsOn: [], fallback: true },
  { key: "damageMessagesNoDamage", label: `${L}MissedHitNotifications`, dependsOn: ["damageMessages"], fallback: true },
  { key: "damageMessagesMine", label: `${L}ShowInflictedDamageNotifications`, dependsOn: ["damageMessages"], fallback: true },
  { key: "damageMessagesEnemy", label: `${L}ShowIncurredDamageNotification`, dependsOn: ["damageMessages"], fallback: true },
  { key: "remoteAssistanceMessagesMine", label: `${L}ShowIncomingRemoteAssistanceNotifications`, dependsOn: ["remoteAssistanceMessages"], fallback: true },
  { key: "remoteAssistanceMessagesOthers", label: `${L}ShowOutgoingRemoteAssistanceNotifications`, dependsOn: ["remoteAssistanceMessages"], fallback: true },
];
const A = "UI/Accessories/Log/";
/** The In-space Notifications submenu's checkboxes (DependentCheckboxMenuEntryData), separated after the first. */
export const COMBAT_INSPACE_SETTINGS: readonly CombatSetting[] = [
  { key: "damageMessageShowInspaceNotifications", label: `${A}ShowInspaceNotifications`, dependsOn: ["damageMessages"], fallback: true },
  { key: "damageMessagesShowShip", label: `${A}DmgNotificationsShowShip`, dependsOn: ["damageMessageShowInspaceNotifications", "damageMessages"], fallback: false },
  { key: "damageMessagesShowTicker", label: `${A}DmgNotificationsShowTicker`, dependsOn: ["damageMessageShowInspaceNotifications", "damageMessages"], fallback: false },
  { key: "damageMessagesShowWeapon", label: `${A}DmgNotificationsShowWeapon`, dependsOn: ["damageMessageShowInspaceNotifications", "damageMessages"], fallback: false },
  { key: "damageMessagesShowQuality", label: `${A}DmgNotificationsShowQuality`, dependsOn: ["damageMessageShowInspaceNotifications", "damageMessages"], fallback: true },
];
export const COMBAT_FONT_SIZES: readonly number[] = [10, 12, 14];
export type CombatAlignment = "auto" | "left" | "right" | "center";
export const COMBAT_ALIGNMENTS: readonly CombatAlignment[] = ["auto", "left", "right", "center"];
/** CAPTION_LABEL_BY_INFLIGHT_MESSAGE_ALIGNMENT. */
export const COMBAT_ALIGNMENT_LABELS: Readonly<Record<CombatAlignment, string>> = {
  auto: `${A}AlignmentAuto`, left: `${A}AlignmentLeft`, right: `${A}AlignmentRight`, center: `${A}AlignmentCenter`,
};
/** The menu's words. */
export const COMBAT_MENU_WORDS: readonly string[] = [
  `${A}CombatSettings`, `${A}CombatMessagesToDisplay`, `${A}ExtraInfoHeader`, `${A}EnterMessageMovingMode`, `${A}ExitMessageMovingMode`,
  `${A}FontSize`, `${A}InspaceNotificationFontAlignment`, `${A}ResetAlignment`, `${A}ExampleText`,
  ...COMBAT_DISPLAY_SETTINGS.flatMap((s) => (s.hint ? [s.label, s.hint] : [s.label])), ...COMBAT_INSPACE_SETTINGS.map((s) => s.label),
  ...Object.values(COMBAT_ALIGNMENT_LABELS),
];

/** damageMessages_config: (align, textAlign, left, topOffset); null for the default (GetDefaultAlignmentValues). */
export interface CombatBoxConfig { readonly align: "CENTERTOP" | "TOPLEFT" | "TOPRIGHT"; readonly textAlign: "left" | "right" | "center"; readonly left: number; readonly topOffset: number }

const key = (name: string) => `evejs.play.${name}`;
const read = (name: string): string | null => { try { return localStorage.getItem(key(name)); } catch { return null; } };
const write = (name: string, value: string | null): void => {
  try { if (value === null) localStorage.removeItem(key(name)); else localStorage.setItem(key(name), value); } catch { /* not kept */ }
};

const ALL = [...COMBAT_DISPLAY_SETTINGS, ...COMBAT_INSPACE_SETTINGS];
export const combatFlags = writable<Readonly<Record<string, boolean>>>(Object.fromEntries(ALL.map((s) => {
  const v = read(s.key);
  return [s.key, v === null ? s.fallback : v === "1"];
})));
export const combatFontSize = writable<number>((() => { const v = Number(read("dmgnotifictions_fontsize")); return COMBAT_FONT_SIZES.includes(v) ? v : 12; })());
export const combatAlignment = writable<CombatAlignment>((() => { const v = read("dmgnotifictions_alignment") as CombatAlignment | null; return v && COMBAT_ALIGNMENTS.includes(v) ? v : "auto"; })());
export const combatBoxConfig = writable<CombatBoxConfig | null>((() => {
  try { const v = JSON.parse(read("damageMessages_config") ?? "null"); return v && typeof v.topOffset === "number" ? v as CombatBoxConfig : null; } catch { return null; }
})());
/** logger.inMovingMode (MoveNotifications). */
export const combatMovingMode = writable(false);

/** A setting's value (its default where unset). */
export function combatFlag(name: string): boolean {
  const flags = get(combatFlags);
  return flags[name] ?? ALL.find((s) => s.key === name)?.fallback ?? true;
}
/** Whether its menu entry is usable: all its dependencies on. */
export function combatSettingEnabled(setting: CombatSetting, flags: Readonly<Record<string, boolean>>): boolean {
  return setting.dependsOn.every((d) => flags[d] !== false);
}
export function setCombatFlag(name: string, on: boolean): void {
  combatFlags.update((f) => ({ ...f, [name]: on }));
  write(name, on ? "1" : "0");
}
export function setCombatFontSize(size: number): void {
  if (!COMBAT_FONT_SIZES.includes(size)) return;
  combatFontSize.set(size);
  write("dmgnotifictions_fontsize", String(size));
}
export function setCombatAlignment(alignment: CombatAlignment): void {
  combatAlignment.set(alignment);
  write("dmgnotifictions_alignment", alignment);
}
export function saveCombatBoxConfig(config: CombatBoxConfig): void {
  combatBoxConfig.set(config);
  write("damageMessages_config", JSON.stringify(config));
}
/** ResetDmgNotificationAlignment: the saved place deleted, the alignment setting reset. */
export function resetCombatAlignment(): void {
  combatBoxConfig.set(null);
  write("damageMessages_config", null);
  setCombatAlignment("auto");
  write("dmgnotifictions_alignment", null);
}

/** godma.OnDamageMessage's gates: whether a damage message is let through at all (the log's line and the Say). */
export function damageMessageShown(direction: "dealt" | "taken", amount: number): boolean {
  if (!combatFlag("damageMessages")) return false;
  if (amount === 0 && !combatFlag("damageMessagesNoDamage")) return false;
  return direction === "taken" ? combatFlag("damageMessagesEnemy") : combatFlag("damageMessagesMine");
}
