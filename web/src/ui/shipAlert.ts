// Ship health alerts from the 24.02 client's hud/client/ship_alert/shipAlertController.py:
// the shield, armour and hull each alerting while below its threshold and taking damage, the capacitor while below its
// own and draining. What is shown of an alert is the red bars at the screen's top and bottom and the glow of the
// layer's gauge, with the layers above it (DoShieldAnimation, DoArmorAnimation, DoHullAnimation); the capacitor pulses
// (OnCapacitorFlash).

import { HEALTH_NOTIFICATIONS, type HealthNotificationSetting } from "../store/notifySettings.ts";

export const SHIELD = 0;
export const ARMOR = 1;
export const HULL = 2;
export const CAPACITOR = 3;

/** animDuration: an alert lasts this long after the last damage that raised it. */
export const ALERT_DURATION_MS = 2000;
/** Each level's animation's length (DoShieldAnimation 2.0, DoArmorAnimation 1.0, DoHullAnimation 0.6). */
export const ALERT_ANIMATION_MS: readonly number[] = [2000, 1000, 600];

export interface ShipAlertState {
  /** oldDamageState: each level's last amount, reset to full when the active ship changes. */
  readonly oldDamage: readonly number[];
  /** alertStartTimes: when each level last took damage while it was below its threshold; null where it was let go. */
  readonly startTimes: readonly (number | null)[];
}

export function initialShipAlertState(): ShipAlertState {
  return { oldDamage: [1, 1, 1, 1, 1], startTimes: [null, null, null, null, null] };
}

type Settings = Readonly<Record<string, HealthNotificationSetting>>;

/**
 * IsLevelActive (165 to 171): the level's alert on (settings.user.notifications <name>NotificationEnabled, 1 where not
 * set) and the amount below its threshold (<name>Threshold, the notification's default where not set).
 */
export function isLevelActive(level: number, amount: number, settings: Settings): boolean {
  const notification = HEALTH_NOTIFICATIONS[level];
  if (!notification) return false;
  const kept = settings[notification.name];
  const enabled = kept?.enabled ?? true;
  const threshold = kept?.threshold ?? notification.defaultThreshold;
  return enabled && amount < threshold;
}

function moved(old: number, amount: number): number {
  return amount < old ? -1 : amount > old ? 1 : 0;
}

/**
 * NewDamageState (150 to 163), the hull, the armour and the shield in turn: a level that dropped raises the alert of
 * every level after it that is active (activateHigher), a level that is active and dropped its own; the hull's let go
 * where it rose. `damage` is the shield, armour and hull as shares of their whole.
 */
export function damageStateChanged(state: ShipAlertState, damage: readonly [number, number, number], nowMs: number, settings: Settings): ShipAlertState {
  const oldDamage = [...state.oldDamage];
  const startTimes = [...state.startTimes];
  let activateHigher = false;
  for (const level of [HULL, ARMOR, SHIELD]) {
    const amount = damage[level]!;
    const active = isLevelActive(level, amount, settings);
    const direction = moved(oldDamage[level]!, amount);
    oldDamage[level] = amount;
    if (direction < 0) activateHigher = true;
    if (active && (direction < 0 || activateHigher)) startTimes[level] = nowMs;
    else if (direction > 0 && level === HULL) startTimes[HULL] = null;
  }
  return { oldDamage, startTimes };
}

/** OnCapacitorChange (138 to 141): the capacitor's alert raised where it is below its threshold and fell. */
export function capacitorChanged(state: ShipAlertState, level: number, nowMs: number, settings: Settings): ShipAlertState {
  const oldDamage = [...state.oldDamage];
  const startTimes = [...state.startTimes];
  const active = isLevelActive(CAPACITOR, level, settings);
  const direction = moved(oldDamage[CAPACITOR]!, level);
  oldDamage[CAPACITOR] = level;
  if (active && direction < 0) startTimes[CAPACITOR] = nowMs;
  return { oldDamage, startTimes };
}

/**
 * GetActiveAlertLevel (219 to 230): of the shield, armour and hull, the last (the most grave) whose alert was raised
 * within the alert's length and is still active; null where none.
 */
export function activeAlertLevel(state: ShipAlertState, nowMs: number, settings: Settings): number | null {
  let highest: number | null = null;
  for (let level = SHIELD; level <= HULL; level += 1) {
    const start = state.startTimes[level];
    if (start === null || start === undefined) continue;
    if (!isLevelActive(level, state.oldDamage[level]!, settings)) continue;
    if (start < 0 || nowMs - start < ALERT_DURATION_MS) highest = level;
  }
  return highest;
}

/** DoCapacitorAnimation_Thread (232 to 243): the capacitor pulses while its alert was raised within the alert's length. */
export function capacitorAlerting(state: ShipAlertState, nowMs: number): boolean {
  const start = state.startTimes[CAPACITOR];
  return start !== null && start !== undefined && nowMs - start < ALERT_DURATION_MS;
}
