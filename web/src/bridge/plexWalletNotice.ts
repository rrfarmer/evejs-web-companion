import type { JsonValue } from "./wire.ts";

export const PLEX_WALLET_NOTICE = "eve_public.plex.vault.api.BalanceChangedNotice";

function record(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue> : null;
}

function cents(value: JsonValue | undefined): number | null {
  const amount = record(value);
  if (!amount) return null;
  const raw = amount.total_in_cents ?? 0;
  if (typeof raw !== "number" && (typeof raw !== "string" || !/^-?\d+$/.test(raw))) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** PlexRepository._on_balance_changed converts the protobuf integer cents with Python 2 integer division. */
export function decodePlexWalletNotice(payload: JsonValue): { balance: number; difference: number } | null {
  const attributes = record(record(payload)?.attributes);
  const balance = cents(attributes?.resulting_balance);
  const difference = cents(attributes?.amount_transferred);
  if (balance === null || balance < 0 || difference === null) return null;
  return { balance: Math.floor(balance / 100), difference: Math.floor(difference / 100) };
}
