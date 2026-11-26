// walletSvc.GetCorpWealth/GetCorpWealthCached1Min/_OnCorpAccountChange156-175/99-113.
// Fresh window reads do not fill the notice cache. The native cache is per key,
// survives ordinary corporation changes, and resets on character logoff/reset.
import type { Ask } from "./ask.ts";
import { BridgeCallError } from "./callMethod.ts";
import { toAmountString } from "./rewards.ts";
import type { JsonValue } from "./wire.ts";

export interface CorporationWealthChange {
  readonly corporationID: number;
  readonly balance: number;
  readonly accountKey: number;
  readonly difference: number;
}

export interface CorporationWealthScope {
  readonly corporationID: number;
  readonly ask: Ask;
  /** A pending read/event still belongs to this pilot and corporation. */
  current(): void;
}

const TAKE_FIRST = 134217728n;
const ACCOUNTANTS = 256n | 4503599627370496n;
const TAKE_ALL = 127n * TAKE_FIRST;
const KEPT_MS = 60_000;
const accountNames = ["cash", "cash2", "cash3", "cash4", "cash5", "cash6", "cash7"];

export function corporationWalletKey(accountName: unknown): number | null {
  const index = accountNames.indexOf(String(accountName));
  return index < 0 ? null : 1000 + index;
}

/** walletUtil.HaveAccessToCorpWallet, then HaveReadAccessToCorpWalletDivision.
 * The latter uses take bits, even for an Accountant/Junior who can RPC-read all.
 */
export function canReceiveCorporationWealth(corpRole: string | null | undefined, key: number): boolean {
  if (!Number.isInteger(key) || key < 1000 || key > 1006) return false;
  try {
    const roles = BigInt(corpRole ?? "0");
    return (roles & (ACCOUNTANTS | TAKE_ALL)) !== 0n && (roles & (TAKE_FIRST << BigInt(key - 1000))) !== 0n;
  } catch { return false; }
}

function balanceNumber(value: JsonValue): number {
  const digits = toAmountString(value), balance = digits === null ? Number.NaN : Number(digits);
  if (!Number.isFinite(balance)) throw new Error("The corporation wallet returned no balance.");
  return balance;
}

export function createCorporationWealth(deps: {
  readonly capture: () => CorporationWealthScope;
  readonly changed: (change: CorporationWealthChange) => void;
  readonly now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const kept = new Map<number, { readonly balance: number; readonly at: number }>();
  let generation = 0;

  async function fresh(scope: CorporationWealthScope, key: number | null): Promise<number> {
    scope.current();
    try {
      const value = await scope.ask("account", "GetCashBalance", [1], { accountKey: key });
      scope.current();
      return balanceNumber(value);
    } catch (error) {
      scope.current();
      // Native catches UserError only. Transport/session/decoding failures propagate.
      if (error instanceof BridgeCallError && error.refusal !== null) return 0;
      throw error;
    }
  }

  async function cached(scope: CorporationWealthScope, key: number): Promise<number> {
    scope.current();
    const held = kept.get(key);
    // Original compiled method uses > MIN, not >=, and timestamps after the read.
    if (held !== undefined && now() - held.at <= KEPT_MS) return held.balance;
    const readingGeneration = generation, balance = await fresh(scope, key);
    scope.current();
    if (generation === readingGeneration) kept.set(key, { balance, at: now() });
    return balance;
  }

  return {
    /** Fresh None/explicit-key read, independent of the one-minute notice cache. */
    fresh(key: number | null = null): Promise<number> { return fresh(deps.capture(), key); },
    cached(key: number): Promise<number> { return cached(deps.capture(), key); },
    async accountChanged(accountName: unknown, ownerID: unknown, value: JsonValue, whose: {
      readonly corporationID: number | null;
      readonly corpRole: string | null | undefined;
    }): Promise<void> {
      if (value === null || value === undefined || Number(ownerID) !== whose.corporationID) return;
      const key = corporationWalletKey(accountName);
      if (key === null || !canReceiveCorporationWealth(whose.corpRole, key)) return;
      const scope = deps.capture(), eventGeneration = generation;
      if (scope.corporationID !== whose.corporationID) return;
      const balance = balanceNumber(value), previous = await cached(scope, key);
      scope.current();
      if (eventGeneration !== generation) return;
      kept.set(key, { balance, at: now() });
      deps.changed({ corporationID: scope.corporationID, balance, accountKey: key, difference: balance - previous });
    },
    forget(): void { generation++; kept.clear(); },
  };
}
