// WC74 web/src/bots/hostedRunPolicy.ts @ 213da333; imports adapted for UOC plugin.
/** Shared finite hosting policy. Only the BFF reads deployment configuration;
 * browsers display the policy returned by their existing control-plane reads. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
export const MAX_TIMER_SAFE_RUN_HOURS = Math.floor(MAX_TIMER_DELAY_MS / 3_600_000);
// Match Farmer's hosted grant bound (runPolicy.ts) and the 73-hour token
// lifetime, which reserves the remaining hour for bounded cleanup.
export const DEFAULT_MAX_HOSTED_RUN_HOURS = 72;
export const DEFAULT_HOSTED_RUN_MINUTES = 12 * 60;

export interface HostedRunPolicy {
  readonly maxRuntimeMinutes: number;
  readonly defaultRuntimeMinutes: number;
  readonly durationChoices: readonly number[];
}

export function hostedRunPolicy(hours: unknown = DEFAULT_MAX_HOSTED_RUN_HOURS): HostedRunPolicy {
  const value = Number(hours);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_SAFE_RUN_HOURS) {
    throw new Error(`MAX_HOSTED_RUN_HOURS must be a whole number from 1 to ${MAX_TIMER_SAFE_RUN_HOURS}; direct expiry timers must not overflow.`);
  }
  const maxRuntimeMinutes = value * 60;
  return Object.freeze({
    maxRuntimeMinutes,
    defaultRuntimeMinutes: Math.min(DEFAULT_HOSTED_RUN_MINUTES, maxRuntimeMinutes),
    durationChoices: Object.freeze([...new Set([1, 4, 12, 24, 48, 72, value])]
      .filter(choice => choice <= value).sort((a, b) => a - b).map(choice => choice * 60)),
  });
}

export function hostedDurationLabel(minutes: number): string {
  return minutes === 7 * 24 * 60 ? "7 days" : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
}
