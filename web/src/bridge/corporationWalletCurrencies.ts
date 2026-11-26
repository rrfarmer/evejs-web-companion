export const EVERMARK_ISSUER = 1000419;
export const CORPORATION_EVERMARK_MIN_DAYS = 30;

/** walletUtil.HaveAccessToCorpLPWallet and HaveAccessToCorpEMWallet. */
export function canUseCorporationWalletCurrency(role: string | null | undefined, currency: "loyalty" | "evermarks"): boolean {
  const required = currency === "loyalty" ? 1n : 34359738368n;
  try { return (BigInt(role ?? "0") & required) !== 0n; }
  catch { return false; }
}
