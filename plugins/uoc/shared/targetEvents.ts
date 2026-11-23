import { unwrapLong } from "./wire.ts";

// Both notifications invalidate a specific pending or previously held target.
export function lostLockTarget(method: string, args: readonly unknown[]): number | null {
  const raw = method === "FailLockTarget" ? args[0] :
    method === "OnTarget" && typeof args[0] === "string" && args[0].trim() === "lost" ? args[1] : null;
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : unwrapLong(raw);
  return value !== null && value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}
