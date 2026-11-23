export const CLONE_GRADE_ALPHA = 0;
export const CLONE_GRADE_OMEGA = 1;

export function cloneGradeOf(value: unknown): 0 | 1 | null {
  return value === CLONE_GRADE_ALPHA || value === CLONE_GRADE_OMEGA ? value : null;
}

export function skillPointsForLevel(rank: number, level: number): number {
  if (level <= 0) return 0;
  return Math.ceil(rank * 250 * 2 ** (2.5 * (Math.min(level, 5) - 1)));
}

export const skillPointsPerMinute = (primary: number, secondary: number): number => primary + secondary / 2;
