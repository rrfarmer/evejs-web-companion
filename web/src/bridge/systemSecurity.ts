// A solar system's security, as the retail client shows and classes it.
//
// The client keeps each system's security with its static data and uses it three ways:
//
//   pseudoSecurity   the level it works with: the system's own, except that anything above nought and
//                    below 0.05 counts as 0.05 (eveCfg.SolarSystem, 1092 to 1097)
//   the rating shown that level rounded to one decimal place, with a "minus nought" shown as nought
//                    (eveformat/client/location.py round_security_status)
//   its class        null security at nought or below, low below 0.45, high below 0.95, and above that
//                    "safe" (eveuniverse/security.py SecurityClassFromLevel). The client classes the
//                    level it works with; that is the same class as the system's own, since what is
//                    raised to 0.05 was above nought and stays below 0.45
//
// A server can also change a system's level for a time (security/client/securitySvc.py
// modified_security_levels). That is not done here: these are the levels the systems were made with.

export const SECURITY_CLASS = Object.freeze({ zero: 0, low: 1, high: 2, safe: 3 } as const);
export type SecurityClass = (typeof SECURITY_CLASS)[keyof typeof SECURITY_CLASS];

/** The level the client works with for a system of this security. */
export function pseudoSecurity(security: number): number {
  return security > 0 && security < 0.05 ? 0.05 : security;
}

/** The rating the client shows: one decimal place, and never "-0.0". */
export function shownSecurity(security: number): number {
  const rounded = Number(pseudoSecurity(security).toFixed(1));
  return rounded === 0 ? 0 : rounded;
}

export function securityClass(level: number): SecurityClass {
  if (level <= 0) {
    return SECURITY_CLASS.zero;
  }
  if (level < 0.45) {
    return SECURITY_CLASS.low;
  }
  return level < 0.95 ? SECURITY_CLASS.high : SECURITY_CLASS.safe;
}

/**
 * The client's colour for a rating it shows (security/client/securityColor.py get_security_status_color, by way of
 * eveFormat.FmtSystemSecStatus, 225 to 233: the level rounded to one decimal place first): its curve's entry for each
 * tenth, nought and below the first. The curve's values were read from the client's compiled module by its own
 * Python, since the decompiled source prints them wrongly.
 */
const SECURITY_STATUS_COLORS: readonly (readonly [number, number, number])[] = Object.freeze([
  [0.553, 0.196, 0.392], [0.451, 0.125, 0.125], [0.737, 0.067, 0.09], [0.808, 0.267, 0.059], [0.863, 0.427, 0.027],
  [0.961, 1.0, 0.514], [0.447, 0.906, 0.333], [0.38, 0.859, 0.643], [0.306, 0.808, 0.973], [0.227, 0.604, 0.922],
  [0.173, 0.459, 0.886],
]);

/** A system's colour as the client draws it for a level, 0..1 each. */
export function securityStatusRgb(level: number): readonly [number, number, number] {
  const rounded = Number(level.toFixed(1));
  const index = Math.min(SECURITY_STATUS_COLORS.length - 1, Math.trunc(Math.max(rounded, 0) * 10));
  return SECURITY_STATUS_COLORS[index] ?? SECURITY_STATUS_COLORS[0]!;
}

/** A system's colour as the client draws it for a level, as CSS. */
export function securityStatusColor(level: number): string {
  const [r, g, b] = securityStatusRgb(level);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

/** is_low_sec_or_lower: where the client warns before sending a pilot. */
export function isLowSecOrLower(security: number): boolean {
  return securityClass(security) <= SECURITY_CLASS.low;
}
