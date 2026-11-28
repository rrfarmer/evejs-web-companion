/** A tab-local hint only; current authenticated host and controller reads remain authority. */
export type ActivePointer = {
  accountName: string;
  characterID: number;
  botID: string | null;
  operationID: string;
  operationRunID: string;
  runKind?: string;
  refused?: true;
};
type Pilot = { characterID: number; name: string; accountName: string };
type Registry = { botID: string; characterID: number; operationID: string; operationRunID: string };
type Bot = {
  botID: string;
  characterID: number;
  endedAt: string | null;
  kind: string;
  plugin: { pluginID: string; run: string } | null;
};
type Storage = Pick<StorageInterface, "getItem" | "setItem">;
interface StorageInterface {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const DEFAULT_KEY = "uoc.anomaly.active-runs.v1";
/** Accessing the browser storage getter itself can be denied. */
export function safeActiveRosterStorage(
  get: () => Storage = () => globalThis.sessionStorage,
): Storage | null {
  try {
    return get();
  } catch {
    return null;
  }
}
/** These codes are returned before botHost creates a record, with exact response status. */
export function definiteStartRefusal(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null;
  return (
    !!e &&
    typeof e.code === "string" &&
    (
      {
        INVALID_CHARACTER: 400,
        CHARACTER_NOT_FOUND: 404,
        PLUGIN_RUN_INVALID: 400,
        BOT_GRANT_REQUIRED: 400,
        BOT_GRANT_INVALID: 400,
        BOT_GRANT_STALE: 409,
        BOT_GRANT_EXPIRED: 409,
        BOT_SCRIPT_CHANGED: 409,
      } as Record<string, number>
    )[e.code] === e.status
  );
}
const valid = (x: unknown): x is ActivePointer => {
  const p = x as ActivePointer;
  return (
    !!p &&
    typeof p === "object" &&
    typeof p.accountName === "string" &&
    !!p.accountName.trim() &&
    Number.isSafeInteger(p.characterID) &&
    p.characterID > 0 &&
    (p.botID === null || (typeof p.botID === "string" && !!p.botID)) &&
    typeof p.operationID === "string" &&
    !!p.operationID &&
    typeof p.operationRunID === "string" &&
    !!p.operationRunID &&
    (p.runKind === undefined || (typeof p.runKind === "string" && !!p.runKind))
  );
};
export function createActiveRoster(
  storage: Storage | null,
  config: { storageKey?: string; allowedRunKinds?: readonly string[] } = {},
) {
  const key = config.storageKey ?? DEFAULT_KEY,
    allowed = config.allowedRunKinds ?? ["anomaly-fleet-member"];
  if (!key || !allowed.length || allowed.some((x) => typeof x !== "string" || !x))
    throw Error("Active roster configuration is invalid.");
  let persistent = storage !== null,
    loaded = false,
    memory: ActivePointer[] = [];
  const read = (): ActivePointer[] => {
    if (!loaded) {
      loaded = true;
      try {
        const raw = storage?.getItem(key) ?? null;
        if (raw !== null) {
          const x: unknown = JSON.parse(raw);
          if (!Array.isArray(x) || !x.every(valid)) throw Error("invalid pointer storage");
          memory = x;
        }
      } catch {
        persistent = false;
        memory = [];
      }
    }
    return structuredClone(memory);
  };
  const write = (rows: readonly ActivePointer[]) => {
    memory = structuredClone([...rows]);
    loaded = true;
    if (persistent)
      try {
        storage!.setItem(key, JSON.stringify(memory));
      } catch {
        persistent = false;
      }
  };
  return {
    read,
    persistent: () => persistent,
    markRefused(p: ActivePointer) {
      const rows = read(),
        index = rows.findIndex(
          (x) =>
            x.botID === null &&
            x.accountName === p.accountName &&
            x.characterID === p.characterID &&
            x.operationID === p.operationID &&
            x.operationRunID === p.operationRunID,
        );
      if (index >= 0) {
        rows[index] = { ...rows[index]!, refused: true };
        write(rows);
      }
    },
    begin(p: ActivePointer) {
      if (
        !valid(p) ||
        p.botID !== null ||
        (p.runKind !== undefined && !allowed.includes(p.runKind))
      )
        throw Error("Active fleet pointer is invalid.");
      const rows = read();
      if (rows.some((x) => x.characterID === p.characterID))
        throw Error("A prior fleet start remains unresolved.");
      write([...rows, p]);
    },
    bind(p: ActivePointer, botID: string) {
      if (!botID) throw Error("Hosted run identity is unavailable.");
      const rows = read(),
        index = rows.findIndex(
          (x) =>
            x.botID === null &&
            x.accountName === p.accountName &&
            x.characterID === p.characterID &&
            x.operationID === p.operationID &&
            x.operationRunID === p.operationRunID,
        );
      if (index < 0) throw Error("Original fleet start pointer is unavailable.");
      rows[index] = { ...p, botID };
      write(rows);
    },
    async restore(
      readAccount: (
        account: string,
      ) => Promise<{ account: string; pilots: Pilot[]; registry: Registry[]; bots: Bot[] }>,
    ) {
      const rows = read(),
        remaining: ActivePointer[] = [],
        pilots: Pilot[] = [],
        unresolved: ActivePointer[] = [];
      const cache = new Map<string, Promise<Awaited<ReturnType<typeof readAccount>>>>();
      for (const p of rows) {
        try {
          const key = p.accountName.toLowerCase();
          let promise = cache.get(key);
          if (!promise) {
            promise = readAccount(p.accountName);
            cache.set(key, promise);
          }
          const a = await promise;
          if (
            typeof a.account !== "string" ||
            a.account.toLowerCase() !== key ||
            !Array.isArray(a.pilots) ||
            !Array.isArray(a.registry) ||
            !Array.isArray(a.bots) ||
            a.pilots.some(
              (x) =>
                !x ||
                !Number.isSafeInteger(x.characterID) ||
                x.characterID <= 0 ||
                typeof x.name !== "string" ||
                !x.name ||
                typeof x.accountName !== "string" ||
                x.accountName.toLowerCase() !== key,
            ) ||
            new Set(a.pilots.map((x) => x.characterID)).size !== a.pilots.length ||
            a.registry.some(
              (x) =>
                !x ||
                typeof x.botID !== "string" ||
                !x.botID ||
                !Number.isSafeInteger(x.characterID) ||
                x.characterID <= 0 ||
                typeof x.operationID !== "string" ||
                !x.operationID ||
                typeof x.operationRunID !== "string" ||
                !x.operationRunID,
            ) ||
            new Set(a.registry.map((x) => x.botID)).size !== a.registry.length ||
            a.bots.some(
              (x) =>
                !x ||
                typeof x.botID !== "string" ||
                !x.botID ||
                !Number.isSafeInteger(x.characterID) ||
                x.characterID <= 0 ||
                typeof x.kind !== "string" ||
                !(x.endedAt === null || typeof x.endedAt === "string"),
            ) ||
            new Set(a.bots.map((x) => x.botID)).size !== a.bots.length
          )
            throw Error("Account evidence is unavailable.");
          const matches = a.registry.filter(
            (x) =>
              x.characterID === p.characterID &&
              x.operationID === p.operationID &&
              x.operationRunID === p.operationRunID &&
              (p.botID === null || x.botID === p.botID),
          );
          const host =
            matches.length === 1
              ? a.bots.filter(
                  (b) =>
                    b.botID === matches[0]!.botID &&
                    b.characterID === p.characterID &&
                    !b.endedAt &&
                    b.kind === "plugin" &&
                    b.plugin?.pluginID === "uoc" &&
                    allowed.includes(b.plugin.run) &&
                    (p.runKind === undefined || b.plugin.run === p.runKind),
                )
              : [];
          const owners = a.pilots.filter(
            (x) => x.characterID === p.characterID && x.accountName.toLowerCase() === key,
          );
          if (matches.length === 1 && host.length === 1 && owners.length === 1) {
            remaining.push({ ...p, botID: matches[0]!.botID });
            pilots.push(owners[0]!);
            continue;
          }
          if (
            p.botID === null &&
            p.refused === true &&
            !a.registry.some((x) => x.characterID === p.characterID) &&
            !a.bots.some((x) => x.characterID === p.characterID && !x.endedAt)
          )
            continue;
          const hostPresent =
            p.botID !== null && a.bots.some((b) => b.botID === p.botID && !b.endedAt);
          const registered = p.botID !== null && a.registry.some((x) => x.botID === p.botID);
          if (p.botID !== null && !hostPresent && !registered) continue;
          remaining.push(p);
          unresolved.push(p);
        } catch {
          remaining.push(p);
          unresolved.push(p);
        }
      }
      const identity = (p: ActivePointer) =>
          JSON.stringify([p.accountName, p.characterID, p.operationID, p.operationRunID]),
        original = new Map(rows.map((p) => [identity(p), p])),
        outcomes = new Map(remaining.map((p) => [identity(p), p])),
        unchanged = new Set<string>();
      const merged: ActivePointer[] = [];
      for (const current of read()) {
        const id = identity(current),
          before = original.get(id);
        if (!before || JSON.stringify(before) !== JSON.stringify(current)) {
          merged.push(current);
          continue;
        }
        unchanged.add(id);
        const outcome = outcomes.get(id);
        if (outcome) merged.push(outcome);
      }
      write(merged);
      return {
        pilots: pilots.filter((p) =>
          rows.some(
            (x) =>
              x.characterID === p.characterID &&
              x.accountName.toLowerCase() === p.accountName.toLowerCase() &&
              unchanged.has(identity(x)),
          ),
        ),
        unresolved: unresolved.filter((p) => unchanged.has(identity(p))),
      };
    },
  };
}
