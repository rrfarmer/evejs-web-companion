import type { JsonValue } from "./wire.ts";

export const COMMAND_CENTER_UPGRADES_SKILL = 2505;

// planetCommon.commandCenterInfoPerLevel in build 3698585. Costs are cumulative.
export const COMMAND_CENTER_LEVELS = [
  { cpu: 1675, power: 6000, cost: 0 },
  { cpu: 7057, power: 9000, cost: 580000 },
  { cpu: 12136, power: 12000, cost: 1510000 },
  { cpu: 17215, power: 15000, cost: 2710000 },
  { cpu: 21315, power: 17000, cost: 4210000 },
  { cpu: 25415, power: 19000, cost: 6310000 },
] as const;
export const MAX_COMMAND_CENTER_LEVEL = COMMAND_CENTER_LEVELS.length - 1;

export interface CommandCenterUpgradeQuote {
  readonly skillLevel: number;
  readonly wallet: number;
}

export interface CommandCenterUpgrade {
  readonly pinID: number;
  readonly previousLevel: number;
  readonly level: number;
}

export function commandCenterLevelName(level: number): string {
  return ["I", "II", "III", "IV", "V", "VI"][level] ?? "—";
}

export function commandCenterUpgradeCost(from: number, to: number): number {
  return COMMAND_CENTER_LEVELS[to]!.cost - COMMAND_CENTER_LEVELS[from]!.cost;
}

export function commandCenterUpgradeError(from: number, to: number, quote: CommandCenterUpgradeQuote, pendingCost: number): string {
  if (!COMMAND_CENTER_LEVELS[from] || !COMMAND_CENTER_LEVELS[to] || to <= from) {
    return "Choose a higher command centre level.";
  }
  if (to > quote.skillLevel) return "Your Command Center Upgrades skill does not allow this level.";
  if (pendingCost + commandCenterUpgradeCost(from, to) > quote.wallet) {
    return "There is insufficient ISK for the pending colony changes.";
  }
  return "";
}

/** ClientPlanet.UpgradeCommandCenter adds one command for the selected destination level. */
export function commandCenterUpgradeCommand(pinID: number, level: number): JsonValue {
  return [9, [pinID, level]];
}
