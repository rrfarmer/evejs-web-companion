// What a rat type resists, from the static data: what a loop picks its ammunition by.

/** A damage multiplier for each damage type (1 = no resist). */
export interface Resonances {
  readonly em: number;
  readonly thermal: number;
  readonly kinetic: number;
  readonly explosive: number;
}

/** Shield, armour and hull resonances, em/thermal/kinetic/explosive each. */
export const RAT_RESONANCE_ATTRIBUTE_IDS: readonly number[] = Object.freeze([
  271, 274, 273, 272,
  267, 270, 269, 268,
  113, 110, 109, 111,
]);

/** A hostile type's damage multipliers by layer (1 = no resist). */
export interface RatResonances {
  readonly shield: Resonances;
  readonly armor: Resonances;
  readonly hull: Resonances;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A type's resonances from its dogma row; null for a row the tables did not know. */
export function ratResonancesFromAttributes(
  row: Readonly<Record<number, number>> | undefined,
): RatResonances | null {
  if (row === undefined || Object.keys(row).length === 0) {
    return null;
  }
  // Absent is the SDE default, 1.0 (no resist); a nonsense value is clamped.
  const r = (id: number): number => {
    const value = finite(row[id]);
    return value === null ? 1 : Math.max(0, value);
  };
  return {
    shield: { em: r(271), thermal: r(274), kinetic: r(273), explosive: r(272) },
    armor: { em: r(267), thermal: r(270), kinetic: r(269), explosive: r(268) },
    hull: { em: r(113), thermal: r(110), kinetic: r(109), explosive: r(111) },
  };
}
