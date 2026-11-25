// 3698585 securityOfficeSvc and crimewatch.const.
export function hasSecurityOffice(ownerID: number | null, security: number | null): boolean {
  return (ownerID === 1000125 || ownerID === 1000137) &&
    security !== null && security > 0 && security < 0.45;
}

export const SECURITY_PROCESSING_FEE = 1904;
export const SECURITY_TAGS = [
  { typeID: 33138, below: -8, name: "Clone Soldier Trainer Tag" },
  { typeID: 33139, below: -5, name: "Clone Soldier Recruiter Tag" },
  { typeID: 33140, below: -2, name: "Clone Soldier Transporter Tag" },
  { typeID: 33141, below: 0, name: "Clone Soldier Negotiator Tag" },
] as const;

/** Each selectable point is one more tag along the native 0.5-status ladder. */
export function securityTagSteps(current: number): readonly { readonly status: number; readonly typeID: number }[] {
  if (!Number.isFinite(current) || current < -10) return [];
  const steps: { status: number; typeID: number }[] = [];
  let status = current;
  for (const tag of SECURITY_TAGS) {
    while (status < tag.below) {
      status += 0.5;
      steps.push({ status, typeID: tag.typeID });
    }
  }
  return steps;
}
