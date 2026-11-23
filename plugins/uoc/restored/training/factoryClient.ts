import { loadTrainingCharacters, loadMinerTraining, trainingWorldIdentity, type ApiOptions } from "../adapters/training.ts";
import { openDefaultFarmerAccount } from "../app/api.ts";
import type { StageFittingSelection } from "./types.ts";
import { farmerSignInMessage, readAsFarmerAccount } from "../app/context.ts";

export async function readFactoryWorld(): Promise<string> {
  const current = await openDefaultFarmerAccount();
  if (!current) throw new Error(farmerSignInMessage);
  const worldID = trainingWorldIdentity(current.worldID);
  if (!worldID) throw new Error("WC could not verify the current world identity.");
  return worldID;
}

export async function readFactoryAccount(account: string, options: ApiOptions = {}) {
  async function read(requestOptions: ApiOptions) {
    const roster = await loadTrainingCharacters(requestOptions);
    if (roster.account.toLowerCase() !== account.trim().toLowerCase()) throw new Error("Account identity changed during roster read.");
    return { ...roster, requestOptions };
  }
  return options.token ? read(options) : readAsFarmerAccount(account, read);
}

export async function readFactoryPilot(characterID: number, selections: Readonly<Record<string, StageFittingSelection>>, options: ApiOptions, targetStage: string | null = null) {
  return loadMinerTraining(characterID, selections, options, targetStage);
}
