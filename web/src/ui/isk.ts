// ISK amount formatting for the wallet panels (goal R50, R9a "plain player
// language" + R7d "a currency amount is fine, an ID is not").
//
// The amount arrives as a bigint-safe decimal string (the decoder rule keeps
// ISK exact past 2^53). This formats it WITHOUT going through Number, so a
// balance larger than 2^53 groups exactly rather than rounding — the same
// invariant the mission-bot panel test pins ("ISK is formatted without going
// through Number").

/**
 * Group an ISK amount for display: thousands-separated whole part, up to two
 * fractional digits, a trailing " ISK". "—" for a null (not-yet-read) amount.
 * A value that is not a plain decimal string is returned verbatim rather than
 * invented into something else.
 */
export function formatIsk(value: string | null): string {
  if (value === null) {
    return "—";
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    return value;
  }
  const sign = match[1] ?? "";
  // BigInt, never Number — a >2^53 balance must stay exact.
  const whole = BigInt(match[2] ?? "0").toLocaleString("en-US");
  const frac = (match[3] ?? "").slice(0, 2).replace(/0+$/, "");
  return `${sign}${whole}${frac ? `.${frac}` : ""} ISK`;
}

/**
 * A wallet amount in whole ISK, as the client shows one while its "show cents" wallet setting is off, the default
 * (walletConst.py 16, walletShowCents False).
 *
 * - "truncate": the wallet's own figures, walletUtil.FmtWalletCurrency (walletUtil.py 26 to 31): an amount past one
 *   ISK is cut to its whole part (`int(amt)`), so 1,939,882,211.6 shows 1,939,882,211.
 * - "round": the Neocom wallet's tooltip, FmtISK(wealth, showFractions) with showFractions off
 *   (neocomTooltips.py 17 to 18), which is FmtCurrency's `int(round(amount))` (eveFormat.py 71 to 72).
 *
 * The same bigint-safe decimal string and the same "—" and verbatim rules as formatIsk.
 */
export function formatWholeIsk(value: string | null, mode: "truncate" | "round"): string {
  if (value === null) {
    return "—";
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) {
    return value;
  }
  let whole = BigInt(match[2] ?? "0");
  const frac = match[3] ?? "";
  // Python 2's round goes half away from zero; FmtWalletCurrency rounds too below one ISK, where int() is not taken.
  if ((mode === "round" || whole === 0n) && frac !== "" && frac.charCodeAt(0) >= 53) {
    whole += 1n;
  }
  return `${whole === 0n ? "" : match[1] ?? ""}${whole.toLocaleString("en-US")} ISK`;
}

/** Wallet currency with two decimal places, preserving the exact decimal string returned for balances. */
export function formatWalletCents(value: string | number | null, currency = "ISK"): string {
  if (value === null) return "—";
  if (typeof value === "number") {
    return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const fraction = (match[3] ?? "").padEnd(3, "0");
  let cents = BigInt(match[2] ?? "0") * 100n + BigInt(fraction.slice(0, 2));
  if (fraction.charAt(2) >= "5") cents += 1n;
  return `${match[1]}${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")} ${currency}`;
}
