import type { FactoryStorage } from "./factory.ts";
import { trainingPilotKey, trainingPilotRef, type TrainingPilotRef } from "./settings.ts";

// Training data must not follow the browser to another EveJS world.
export function trainingWorldStorage(storage: FactoryStorage, worldID: () => string | null): FactoryStorage {
  function key(name: string): string | null {
    const id = worldID();
    return id ? `uoc-restored:pilot-training:world:${encodeURIComponent(id)}:${name}` : null;
  }
  return {
    getItem(name) {
      const scoped = key(name);
      return scoped ? storage.getItem(scoped) : null;
    },
    setItem(name, value) {
      const scoped = key(name);
      if (!scoped) throw new Error("Current EveJS world identity is unavailable. Training settings cannot be saved.");
      storage.setItem(scoped, value);
    },
  };
}

const selectedTraineeKey = "pilot-training:selected-trainee:v1";

export function readSelectedTrainee(storage: FactoryStorage): TrainingPilotRef | null {
  try { return trainingPilotRef(storage.getItem(selectedTraineeKey) ?? ""); }
  catch { return null; }
}

export function rememberSelectedTrainee(storage: FactoryStorage, pilot: TrainingPilotRef): void {
  try { storage.setItem(selectedTraineeKey, trainingPilotKey(pilot.account, pilot.characterID)); }
  catch { /* The current selection remains available when browser storage is blocked. */ }
}

export function trainingPendingStorage(storage: FactoryStorage & { removeItem(key: string): void },
  worldID: () => string | null) {
  const scoped = trainingWorldStorage(storage, worldID);
  return {
    ...scoped,
    removeItem(name: string) {
      const id = worldID();
      if (!id) throw new Error("Current EveJS world identity is unavailable. Training settings cannot be saved.");
      storage.removeItem(`uoc-restored:pilot-training:world:${encodeURIComponent(id)}:${name}`);
    },
  };
}
