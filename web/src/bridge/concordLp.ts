import { isListValue, unwrapLong, unwrapReal } from "./wire.ts";

export const CONCORD_LP_ISSUER = 1000125;

export function decodeConcordLpRates(reply: unknown): ReadonlyMap<number, number> {
  if (!isListValue(reply)) throw new Error("The CONCORD exchange rates could not be read.");
  const rates = new Map<number, number>();
  for (const row of reply.items) {
    const pair = Array.isArray(row) ? row : isListValue(row) ? row.items : [];
    const issuer = Number(unwrapLong(pair[0]));
    const rate = unwrapReal(pair[1]);
    if (pair.length === 2 && Number.isSafeInteger(issuer) && issuer > 0 && rate !== null && rate > 0) {
      rates.set(issuer, rate);
    }
  }
  return rates;
}

export function maximumConcordExchange(source: number, target: number, rate: number): number {
  return Math.max(0, Math.min(Math.floor(source * rate), 0x7fffffff - target));
}
