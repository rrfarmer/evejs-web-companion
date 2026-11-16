export const TARGET_LOCKED_LABEL = "UI/Inflight/Brackets/TargetLocked";

/** Type attributes used by bracketMgr.GetScanSpeed. */
export interface TargetLockRadii {
  readonly signatureRadius: number | null;
  readonly typeRadius: number | null;
}

export function targetLockDurationMs(
  scanResolution: number | null,
  signatureRadius: number | null,
  ballRadius: number | null,
  typeRadius: number | null,
): number {
  if (scanResolution === null || !Number.isFinite(scanResolution) || scanResolution <= 0) return 2000;
  const radius = [signatureRadius, ballRadius, typeRadius]
    .find((value): value is number => value !== null && Number.isFinite(value) && value > 0) ?? 1;
  return Math.min(180_000, 40_000_000 / scanResolution / Math.asinh(radius) ** 2);
}

/** inSpaceBracket.CountDown preserves the elapsed fraction when scan resolution changes. */
export function retimeTargetLockStart(startedAt: number, now: number, oldDuration: number, newDuration: number): number {
  return now - (now - startedAt) / oldDuration * newDuration;
}
