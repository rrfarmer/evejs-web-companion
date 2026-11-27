import { parse } from "yaml";
import type { Ask } from "./ask.ts";
import { readKeyVal } from "./wire.ts";

export const FLEET_BROADCAST_SETTINGS_DRAG = "application/x-evejs-fleet-broadcast-settings";
const SETTING_TYPE = 3;
export const BROADCAST_SETTING_FLAGS = {
  EnemySpotted: 22, Target: 23, HealShield: 24, HealArmor: 25, HealCapacitor: 26,
  WarpTo: 27, NeedBackup: 28, AlignTo: 29, JumpTo: 30, InPosition: 31, HoldPosition: 32,
  TravelTo: 33, JumpBeacon: 34, Location: 35, HealTarget: 69, Event: -1, ShowOwnBroadcasts: "ShowOwnBroadcasts",
} as const;
type BroadcastFlag = typeof BROADCAST_SETTING_FLAGS[keyof typeof BROADCAST_SETTING_FLAGS];
export type BroadcastColor = readonly [number, number, number];
export type BroadcastSettingRow = readonly [BroadcastFlag, boolean, BroadcastColor | null];
const flags = new Set<unknown>(Object.values(BROADCAST_SETTING_FLAGS));
type SettingKey = [string, number, typeof SETTING_TYPE];

function keyOf(hash: unknown, sequence: unknown, kind: unknown): SettingKey | null {
  return typeof hash === "string" && /^[0-9a-f]{40}$/.test(hash) &&
    typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0 && kind === SETTING_TYPE
    ? [hash, sequence, SETTING_TYPE] : null;
}

export function parseFleetBroadcastSettingsUrl(url: string): SettingKey | null {
  const match = /^sharedSetting:([0-9a-f]{40})\/\/(\d+)\/\/3$/i.exec(url.trim());
  return match ? keyOf(match[1]?.toLowerCase(), Number(match[2]), SETTING_TYPE) : null;
}

function broadcastRows(value: unknown): BroadcastSettingRow[] | null {
  if (!Array.isArray(value) || !value.length || value.length > flags.size) return null;
  const seen = new Set();
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 3 || !flags.has(row[0]) || seen.has(row[0]) || typeof row[1] !== "boolean") return null;
    const color = row[2];
    if (color !== null && (row[0] === "ShowOwnBroadcasts" || !Array.isArray(color) || color.length !== 3 ||
        !color.every(channel => typeof channel === "number" && Number.isFinite(channel) && channel >= 0 && channel <= 1))) return null;
    seen.add(row[0]);
  }
  return value;
}

export function fleetBroadcastDragOf(raw: string | undefined): { text: string; rows: BroadcastSettingRow[] } | null {
  if (!raw || raw.length > 4096) return null;
  try {
    const data = JSON.parse(raw) as { text?: unknown; rows?: unknown } | null;
    const rows = broadcastRows(data?.rows);
    const text = typeof data?.text === "string" ? data.text.trim().slice(0, 60) : "";
    return text && rows ? { text, rows } : null;
  } catch { return null; }
}

export async function storeFleetBroadcastSettings(act: Ask, rows: readonly BroadcastSettingRow[]): Promise<string> {
  const wireRows = rows.map(([flag, checked, color]) => [flag, checked, color ? [...color] : null]);
  const reply = await act("sharedSettingsMgr", "StoreSettingLinkAndGetID", [SETTING_TYPE, wireRows]);
  const key = keyOf(readKeyVal(reply, "hashvalue"), readKeyVal(reply, "sqID"), readKeyVal(reply, "settingTypeID"));
  if (!key) throw new Error("The broadcast settings could not be shared.");
  return `sharedSetting:${key.join("//")}`;
}

export async function readFleetBroadcastSettings(ask: Ask, url: string): Promise<BroadcastSettingRow[]> {
  const key = parseFleetBroadcastSettingsUrl(url);
  if (!key) throw new Error("Enter an EVE broadcast settings link.");
  const answer = await ask("sharedSettingsMgr", "GetStoredSharedSetting", [key]);
  const payload: unknown = typeof answer === "string" ? parse(answer, { version: "1.1", maxAliasCount: 0 }) : null;
  const rows = Array.isArray(payload) ? payload.find(row => Array.isArray(row) && row[0] === "broadcastSettings")?.[1] : null;
  const decoded = broadcastRows(rows);
  if (!decoded) throw new Error("The broadcast settings could not be read.");
  return decoded;
}
