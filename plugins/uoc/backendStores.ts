import { createRequire } from "node:module";
import path from "node:path";
import { pluginDataDir } from "../../web/src/plugin-api/backend.ts";

type StoreFile =
  | "distribution.sqlite"
  | "mining-preparation.sqlite"
  | "missions.sqlite"
  | "mining-fleet.sqlite"
  | "mining-fleet-cycles.sqlite"
  | "restored-mining-definitions.sqlite"
  | "mining-definitions.sqlite"
  | "training-onboarding.sqlite";

interface DocumentStore {
  document(name: string): { read(): unknown; write(value: unknown): void };
  transaction<T>(action: () => T): T;
  documentNames(prefix: string): string[];
  deleteDocuments(names: readonly string[], prefixes: readonly string[]): void;
  close(): void;
}

const { createDocumentStore } = createRequire(import.meta.url)("./documentStore.cjs") as {
  createDocumentStore(path: string): DocumentStore;
};
const stores = new Map<string, DocumentStore>();

/** These writers belong to the UOC backend. Pilots borrow documents from them. */
export function uocStore(file: StoreFile) {
  const filename = path.join(pluginDataDir(), file);
  let store = stores.get(filename);
  if (!store) {
    store = createDocumentStore(filename);
    stores.set(filename, store);
  }
  return store;
}

export function closeBackendStores() {
  const failures: unknown[] = [];
  for (const [file, store] of stores) {
    try {
      store.close();
      stores.delete(file);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Could not close all UOC databases.");
}
