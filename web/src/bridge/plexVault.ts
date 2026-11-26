import { publicGatewayRequest, type ApiOptions } from "../app/api.ts";

export async function readPlexVaultBalance(options: ApiOptions): Promise<bigint> {
  const answer = await publicGatewayRequest("eve_public.plex.vault.api.BalanceRequest", {}, options);
  const payload = answer.payload;
  if (answer.statusCode !== 200 || !payload || typeof payload !== "object" || !("balance" in payload)) {
    throw new Error("The PLEX balance is unavailable.");
  }
  const currency = payload.balance;
  if (!currency || typeof currency !== "object" || Array.isArray(currency)) throw new Error("The PLEX balance is unavailable.");
  // Protobuf omits the scalar when the balance is zero.
  const cents = ("total_in_cents" in currency ? currency.total_in_cents : null) ?? "0";
  if ((typeof cents === "number" && Number.isSafeInteger(cents) && cents >= 0) ||
      (typeof cents === "string" && /^\d+$/.test(cents))) return BigInt(cents);
  throw new Error("The PLEX balance is unavailable.");
}
