import { fleetOperationStore, type FleetOperationDocuments } from "./operationStore.ts";

export function memoryFleetDocuments(values = new Map<string, unknown>()): FleetOperationDocuments {
  return {
    document: (name) => ({
      read: () => structuredClone(values.get(name) ?? null),
      write: (value) => {
        values.set(name, structuredClone(value));
      },
    }),
    documentNames: (prefix) => [...values.keys()].filter((name) => name.startsWith(prefix)),
    deleteDocuments(names, prefixes) {
      for (const name of names) values.delete(name);
      for (const name of values.keys())
        if (prefixes.some((prefix) => name.startsWith(prefix))) values.delete(name);
    },
    transaction(action) {
      const previous = new Map(values);
      try {
        return action();
      } catch (error) {
        values.clear();
        for (const [name, value] of previous) values.set(name, value);
        throw error;
      }
    },
  };
}

export function memoryOperationStore(operationID = "op", runID = "run") {
  return fleetOperationStore(memoryFleetDocuments(), operationID, runID);
}
