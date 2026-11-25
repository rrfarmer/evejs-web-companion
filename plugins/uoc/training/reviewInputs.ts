import { cloneGradeOf } from "./skillMath.ts";
import { cents, readTrainingWallet, scalar, type WalletCall } from "./funding.ts";

export async function readTrainingReviewInputs(
  call: WalletCall,
  characterID: number,
  corporationID: number,
) {
  const [cash, corporate, attributes, grade] = await Promise.allSettled([
    call("account", "GetCashBalance", [0]),
    readTrainingWallet(call, characterID, corporationID),
    call("skillHandler", "GetAttributes"),
    call("subscriptionMgr", "GetCloneGrade"),
  ]);
  let balanceISK: number | null = null;
  if (
    cash.status === "fulfilled" &&
    typeof scalar(cash.value) === "number" &&
    scalar(cash.value) >= 0
  ) {
    try {
      balanceISK = cents(cash.value) / 100;
    } catch {
      /* Missing exact balance is reported in Review. */
    }
  }
  const raw =
    attributes.status === "fulfilled"
      ? (attributes.value as { type?: string; entries?: [unknown, unknown][] })
      : null;
  const characterAttributes: Record<number, number> = {};
  if (raw?.type === "dict" && Array.isArray(raw.entries)) {
    for (const [key, value] of raw.entries) {
      const id = Number(scalar(key)),
        amount = scalar(value);
      if (
        Number.isSafeInteger(id) &&
        id > 0 &&
        typeof amount === "number" &&
        Number.isFinite(amount)
      )
        characterAttributes[id] = amount;
    }
  }
  return {
    balanceISK,
    characterAttributes,
    cloneGrade: grade.status === "fulfilled" ? cloneGradeOf(scalar(grade.value)) : null,
    corporateWallet:
      corporate.status === "fulfilled"
        ? { balanceISK: corporate.value / 100, reason: null }
        : {
            balanceISK: null,
            reason: String(corporate.reason?.message ?? "").startsWith(
              "CORPORATION_WALLET_TAKE_DENIED",
            )
              ? "The trainee lacks Take permission for the corporation Master Wallet."
              : "The trainee's corporation Master Wallet balance or authority could not be read.",
          },
  };
}
