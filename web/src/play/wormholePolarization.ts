import { filetimeToUnixMs } from "../bridge/activity.ts";
import { isListValue, unwrapLong } from "../bridge/wire.ts";

export const POLARIZED_LABEL = "UI/Inflight/SpaceComponents/JumpPolarization/Polarized";

// Types with the jumpPolarization component in build 3698585's spacecomponentsbytype.
const POLARIZED_TYPES = new Set([
  30579, 30583, 30584, 30642, 30643, 30644, 30645, 30646, 30647, 30648, 30649,
  30657, 30658, 30659, 30660, 30661, 30662, 30663, 30664, 30665, 30666, 30667, 30668,
  30669, 30670, 30671, 30672, 30673, 30674, 30675, 30676, 30677, 30678, 30679, 30680,
  30681, 30682, 30683, 30684, 30685, 30686, 30687, 30688, 30689, 30690, 30691, 30692,
  30693, 30694, 30695, 30696, 30697, 30698, 30699, 30700, 30701, 30702, 30703, 30704,
  30705, 30706, 30707, 30708, 30709, 30710, 30711, 30712, 30713, 30714, 30715, 30831,
  32894, 32895, 34134, 34135, 34136, 34137, 34138, 34139, 34140, 34338, 34366, 34367,
  34368, 34369, 34370, 34371, 34372, 34439, 35650, 35651, 35652, 35653, 35654, 56026,
  56535, 56536, 56537, 56538, 56539, 56540, 56541, 56542, 56543, 56544, 56545, 56546,
  56547, 56548, 56549, 56550, 56551, 56552, 56553, 56554, 56555, 56556, 56557, 56558,
  56559, 56560, 56561, 56562, 56563, 56564, 56565, 73748, 73749, 87827, 92287, 92288,
  92289, 97881, 97882,
]);

export function hasJumpPolarization(typeID: number | null): boolean {
  return typeID !== null && POLARIZED_TYPES.has(typeID);
}

export interface WormholePolarization {
  readonly expiresAt: number;
  readonly durationMs: number;
}

export function readWormholePolarization(reply: unknown): WormholePolarization | null {
  const fields = Array.isArray(reply) ? reply : isListValue(reply) ? reply.items : [];
  const expiresAt = filetimeToUnixMs(unwrapLong(fields[0]));
  const duration = unwrapLong(fields[1]);
  const durationMs = duration === null ? 0 : Number(duration) * 1000;
  return expiresAt !== null && Number.isSafeInteger(durationMs) && durationMs > 0
    ? { expiresAt, durationMs } : null;
}

export function polarizationTime(remainingMs: number): string {
  const seconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const withinMinute = String(seconds % 60).padStart(2, "0");
  if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${withinMinute}`;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${withinMinute}`;
}
