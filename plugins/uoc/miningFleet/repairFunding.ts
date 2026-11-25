import { randomUUID } from "node:crypto";
import type { Ask } from "../../../web/src/plugin-api/flying.ts";
import { cents, rowsOf, scalar } from "../training/funding.ts";
import { readAfterTimeout } from "../shared/progressDeadline.ts";

function isk(value: unknown) {
  const amount = scalar(value);
  if (typeof amount !== "number" || amount < 0)
    throw Error("The native wallet amount is unavailable.");
  return cents(amount);
}

function fundsRefusal(error: unknown) {
  const e = error as {
    code?: string;
    status?: number;
    refusal?: { key?: string; values?: unknown };
  } | null;
  return e?.code === "CALL_REFUSED" && e.status === 409 && e.refusal?.key === "NotEnoughMoney"
    ? e.refusal
    : null;
}

/** The native refusal contains the actual charge, including any structure tax. */
export function refusedRepairCharge(error: unknown): number | null {
  const refusal = fundsRefusal(error);
  if (!refusal) return null;
  const values = refusal.values as { type?: string; entries?: [string, unknown][] } | null;
  if (values?.type !== "dict" || !Array.isArray(values.entries)) return null;
  const { amount, balance } = Object.fromEntries(values.entries);
  try {
    const charge = isk(amount);
    return charge > isk(balance) ? charge : null;
  } catch {
    return null;
  }
}

export async function fundHullRepair({
  bridgeAsk,
  bridgeDo,
  characterID,
  corporationID,
  amount,
  verifyDock,
  beforeWrite,
}: {
  bridgeAsk: Ask;
  bridgeDo: Ask;
  characterID: number;
  corporationID: number;
  amount: number;
  verifyDock(): Promise<unknown>;
  beforeWrite(): void;
}) {
  const balance = () =>
    readAfterTimeout(() => bridgeAsk("account", "GetCashBalance", [0])).then(isk);
  await verifyDock();
  const shortfall = amount - (await balance());
  if (shortfall <= 0) return;
  const reason = "MCC hull repair " + randomUUID();
  beforeWrite();
  let failure: unknown;
  try {
    await bridgeDo(
      "account",
      "GiveCashFromCorpAccount",
      [characterID, shortfall / 100, 1000],
      { toAccountKey: null, reason },
      corporationID,
    );
  } catch (error) {
    if (fundsRefusal(error))
      throw Error("Corporation Master Wallet has insufficient ISK for the repair.", {
        cause: error,
      });
    const refusal = error as { code?: string; status?: number; refusal?: { key?: string } } | null;
    if (refusal?.code === "CALL_REFUSED" && refusal.status === 409 && refusal.refusal?.key)
      throw error;
    failure = error;
  }
  // The native transfer can return null even if refused. Match its own wallet
  // journal entry before enabling a repair, including after an uncertain reply.
  try {
    const journal = await readAfterTimeout(() =>
      bridgeAsk("account", "GetTransactions", [1000, null, null, false]),
    );
    const receipts = rowsOf(journal).filter(
      (row) =>
        scalar(row.description) === reason &&
        Number(scalar(row.ownerID1)) === corporationID &&
        Number(scalar(row.ownerID2)) === characterID &&
        Number.isSafeInteger(Number(scalar(row.transactionID))) &&
        Number(scalar(row.transactionID)) > 0 &&
        isk(row.amount) === shortfall,
    );
    if (receipts.length === 1 && (await balance()) >= amount) return;
  } catch (error) {
    failure ??= error;
  }
  throw Error(
    "Corporation repair funding was not confirmed in the pilot's wallet. No second withdrawal was sent.",
    { cause: failure },
  );
}
