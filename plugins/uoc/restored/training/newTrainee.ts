import {
  trainingAccount,
  loginFactoryAccount,
  loadTrainingCharacters,
  type ApiOptions,
  type TrainingAccountOutcome,
} from "../adapters/training.ts";
import { BridgeCallError } from "../../../../web/src/plugin-api/index.ts";
import { readAsFarmerAccount, UocRequestError } from "../app/context.ts";

export interface PendingTrainee {
  username: string;
}
export interface TraineeInput extends PendingTrainee {
  password: string;
  confirmation: string;
}
export interface PendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export const pendingTraineeKey = "pilot-training:pending-account:v1";
export function readPendingTrainee(storage: PendingStorage): PendingTrainee | null {
  const raw = storage.getItem(pendingTraineeKey);
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingTrainee;
  if (
    !value ||
    typeof value.username !== "string" ||
    !/^[A-Za-z0-9_.@-]{1,64}$/.test(value.username)
  )
    throw new Error(
      "Pending account recovery is unreadable. Contact the server operator before creating another account.",
    );
  return { username: value.username };
}
export function validateTrainee(input: TraineeInput): PendingTrainee {
  const username = input.username.trim();
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(username))
    throw new Error("Use 1–64 letters, digits, _ . @ or - for the account name.");
  if (!input.password || input.password !== input.confirmation)
    throw new Error("Enter a password and matching confirmation.");
  return { username };
}
const defaults = {
  create: (name: string) => trainingAccount("create", name),
  recover: (name: string) => trainingAccount("recover", name),
  async login(name: string, password: string) {
    try {
      return await readAsFarmerAccount(name, async (options) => {
        const roster = await loadTrainingCharacters(options);
        if (roster.account !== name || !options.token)
          throw Error("The authenticated trainee account changed.");
        return { account: roster.account, token: options.token };
      });
    } catch (error) {
      if (!(error instanceof UocRequestError) || error.code !== "FARMER_ACCOUNT_REQUIRED")
        throw error;
    }
    return loginFactoryAccount(name, {}, password);
  },
  roster: (options: ApiOptions) => loadTrainingCharacters(options),
};
export async function continueNewTrainee(
  input: TraineeInput,
  storage: PendingStorage,
  deps = defaults,
) {
  const requested = validateTrainee(input),
    existing = readPendingTrainee(storage);
  if (existing && existing.username !== requested.username)
    throw new Error("Recover the pending account before starting a different one.");
  const pending = existing || requested;
  storage.setItem(pendingTraineeKey, JSON.stringify(pending)); // Account name only.
  let outcome: TrainingAccountOutcome;
  try {
    outcome = existing ? await deps.recover(pending.username) : await deps.create(pending.username);
  } catch (cause) {
    if (
      cause instanceof BridgeCallError &&
      [
        "ACCOUNT_EXISTS",
        "ACCOUNT_INVALID",
        "ACCOUNT_CREATE_DISABLED",
        "ACCOUNT_READ_UNAVAILABLE",
        "CONFIRMATION_REQUIRED",
      ].includes(cause.code)
    ) {
      storage.removeItem(pendingTraineeKey);
      throw cause;
    }
    // A lost POST response permits only a read. Never resend the create.
    try {
      outcome = await deps.recover(pending.username);
    } catch {
      throw new Error(
        "Account creation is unconfirmed. Check creation status again; no automatic retry.",
      );
    }
  }
  if (
    !outcome.account ||
    outcome.status === "RECOVERY_REQUIRED" ||
    outcome.account.username !== pending.username
  )
    throw new Error(
      "Account creation is unconfirmed. Check creation status again; no automatic retry.",
    );
  const auth = await deps.login(outcome.account.username, input.password);
  if (auth.account !== outcome.account.username)
    throw new Error("Account authentication changed identity.");
  const requestOptions: ApiOptions = { token: auth.token };
  const roster = await deps.roster(requestOptions);
  if (roster.account !== auth.account)
    throw new Error("Account identity changed during roster read.");
  storage.removeItem(pendingTraineeKey);
  return { ...roster, requestOptions };
}
