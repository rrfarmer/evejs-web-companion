import type { JsonValue } from "../../../web/src/plugin-api/index.ts";

export const TRAINING_FUNDING_POLICIES = [
  "CHARACTER_WALLET_ONLY",
  "CHARACTER_PLUS_CORPORATION_SHORTFALL",
  "CORPORATION_WALLET_ONLY",
] as const;
export type FundingPolicy = (typeof TRAINING_FUNDING_POLICIES)[number];

export function isTrainingFundingPolicy(value: unknown): value is FundingPolicy {
  return TRAINING_FUNDING_POLICIES.some((policy) => policy === value);
}

export function resolveTrainingFundingPolicy(
  policy?: FundingPolicy,
  legacy = false,
): FundingPolicy {
  return policy ?? (legacy ? "CHARACTER_PLUS_CORPORATION_SHORTFALL" : "CHARACTER_WALLET_ONLY");
}

export function trainingTransferAmount(
  policy: FundingPolicy,
  total: number,
  personalBalance: number,
): number {
  if (policy === "CHARACTER_WALLET_ONLY") return 0;
  return policy === "CORPORATION_WALLET_ONLY" ? total : Math.max(0, total - personalBalance);
}

export type WalletCall = (
  service: string,
  method: string,
  args?: JsonValue[],
  kwargs?: Record<string, JsonValue> | null,
  write?: boolean,
  of?: number,
) => Promise<unknown>;

export type TrainingTransfer = {
  corporationID: number;
  shortfall: number;
  balance: number;
  reason: string;
  journalBefore?: { personal: number | null; corporate: number | null };
};

export type TrainingTransferReceipt = {
  personalTransactionID: number;
  corporateTransactionID: number;
  shortfall: number;
  corporationID: number;
};

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
export const scalar = (value: unknown) =>
  object(value) && Object.hasOwn(value, "value") ? value.value : value;

export function cents(value: unknown): number {
  const n = Number(scalar(value)),
    rounded = Math.round(n * 100);
  if (!Number.isFinite(n) || !Number.isSafeInteger(rounded) || Math.abs(n * 100 - rounded) > 0.001)
    throw Error("Wallet value cannot be verified exactly.");
  return rounded;
}

export function fields(value: any): Record<string, any> {
  if (value?.type === "packedrow" && object(value.fields)) return value.fields;
  if (
    value?.type === "object" &&
    value.args?.type === "dict" &&
    Array.isArray(value.args.entries)
  ) {
    const row = Object.fromEntries(value.args.entries);
    const names = row.header?.items,
      values = row.line?.items;
    if (Array.isArray(names) && Array.isArray(values) && names.length === values.length)
      return Object.fromEntries(names.map((name: string, i: number) => [name, values[i]]));
    return row;
  }
  throw Error("Native identity is unreadable.");
}

export function rowsOf(value: unknown): Record<string, any>[] {
  if (!object(value) || value.type !== "list" || !Array.isArray(value.items))
    throw Error("Native wallet journal is unreadable.");
  return value.items.map((row) => {
    const f = fields(row),
      names = f.header?.items,
      values = f.line?.items;
    if (Array.isArray(names) && Array.isArray(values) && names.length === values.length)
      return Object.fromEntries(names.map((name: string, i: number) => [name, values[i]]));
    return f;
  });
}

const journal = (call: WalletCall, corporate: boolean) =>
  call("account", "GetTransactions", [1000, null, null, corporate]);

export async function readTrainingPersonalBalance(call: WalletCall): Promise<number> {
  const balance = scalar(await call("account", "GetCashBalance", [0]));
  if (typeof balance !== "number" || balance < 0)
    throw Error("The trainee's personal wallet balance could not be read.");
  return cents(balance);
}

export async function readTrainingWallet(
  call: WalletCall,
  characterID: number,
  corporationID: number,
): Promise<number> {
  const corp = fields(await call("corpRegistry", "GetCorporation"));
  const member = fields(await call("corpRegistry", "GetMember", [characterID]));
  const roleValue = scalar(member.roles),
    roleText = String(roleValue);
  if (
    Number(scalar(corp.corporationID)) !== corporationID ||
    Number(scalar(member.characterID)) !== characterID ||
    Number(scalar(member.corporationID)) !== corporationID ||
    (typeof roleValue === "number" && !Number.isSafeInteger(roleValue)) ||
    !/^\d+$/.test(roleText) ||
    (BigInt(roleText) & (1n | 134217728n)) === 0n
  )
    throw Error(
      "CORPORATION_WALLET_TAKE_DENIED: The pilot does not have current authority to take from corporation Master Wallet Division 1.",
    );
  const balance = scalar(await call("account", "GetCashBalance", [1, 1000]));
  if (typeof balance !== "number" || balance < 0)
    throw Error("Corporation Master Wallet balance is unavailable.");
  return cents(balance);
}

export async function prepareTrainingTransfer(
  call: WalletCall,
  characterID: number,
  corporationID: number,
  balance: number,
  shortfall: number,
  reason: string,
): Promise<TrainingTransfer> {
  const corporateBalance = await readTrainingWallet(call, characterID, corporationID);
  if (corporateBalance < shortfall)
    throw Error(
      "INSUFFICIENT_CORPORATION_FUNDS: The corporation Master Wallet cannot cover the required funding.",
    );
  const [personalBefore, corporateBefore] = await Promise.all([
    journal(call, false),
    journal(call, true),
  ]);
  const latestID = (value: unknown) => {
    let latest: number | null = null;
    for (const row of rowsOf(value)) {
      const id = Number(scalar(row.transactionID));
      if (!positive(id)) throw Error("Native wallet journal identity is unreadable.");
      if (scalar(row.description) === reason)
        throw Error("This training transfer reference is already in the wallet journal.");
      latest = Math.max(latest ?? 0, id);
    }
    return latest;
  };
  return {
    corporationID,
    shortfall,
    balance,
    reason,
    journalBefore: { personal: latestID(personalBefore), corporate: latestID(corporateBefore) },
  };
}

export function sendTrainingTransfer(
  call: WalletCall,
  characterID: number,
  transfer: TrainingTransfer,
) {
  return call(
    "account",
    "GiveCashFromCorpAccount",
    [characterID, transfer.shortfall / 100, 1000],
    { toAccountKey: null, reason: transfer.reason },
    true,
    transfer.corporationID,
  );
}

export async function inspectTrainingTransfer(
  call: WalletCall,
  characterID: number,
  transfer: TrainingTransfer,
) {
  const [personal, corporate] = await Promise.all([journal(call, false), journal(call, true)]);
  const personalRows = rowsOf(personal),
    corporateRows = rowsOf(corporate);
  const matches = (rows: Record<string, any>[]) =>
    rows.filter((row) => {
      const description = scalar(row.description);
      if (
        !positive(Number(scalar(row.transactionID))) ||
        (description !== null && typeof description !== "string")
      )
        throw Error("A wallet journal entry is unreadable.");
      return description === transfer.reason;
    });
  const credit = matches(personalRows),
    debit = matches(corporateRows);
  if (!credit.length && !debit.length) {
    const retains = (rows: Record<string, any>[], id: number | null) =>
      id === null || rows.some((row) => Number(scalar(row.transactionID)) === id);
    const before = transfer.journalBefore;
    const rolledOff =
      before &&
      (!retains(personalRows, before.personal) || !retains(corporateRows, before.corporate));
    return { status: rolledOff ? "incomplete" : "absent" } as const;
  }
  const entryID = (matches: Record<string, any>[], amount: number) => {
    const row = matches[0];
    if (
      !row ||
      matches.length !== 1 ||
      cents(row.amount) !== amount ||
      Number(scalar(row.ownerID1)) !== transfer.corporationID ||
      Number(scalar(row.ownerID2)) !== characterID
    )
      return null;
    return Number(scalar(row.transactionID));
  };
  const personalTransactionID = entryID(credit, transfer.shortfall);
  const corporateTransactionID = entryID(debit, -transfer.shortfall);
  if (personalTransactionID === null || corporateTransactionID === null)
    return { status: "conflict" } as const;
  return {
    status: "matched",
    receipt: {
      personalTransactionID,
      corporateTransactionID,
      shortfall: transfer.shortfall,
      corporationID: transfer.corporationID,
    },
  } as const;
}

export async function readTrainingTransfer(
  call: WalletCall,
  characterID: number,
  transfer: TrainingTransfer,
) {
  const result = await inspectTrainingTransfer(call, characterID, transfer);
  return result.status === "matched" ? result.receipt : null;
}
