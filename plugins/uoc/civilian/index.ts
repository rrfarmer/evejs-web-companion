import { worldForRequest } from "../shared/backendScope.ts";
import path from "node:path";
import { createRequire } from "node:module";
import { pluginDataDir, type BackendRoute } from "../../../web/src/plugin-api/backend.ts";
import { inspectCivilianOwner, civilianOwnerAvailable, continueCivilianOwner } from "./recovery.ts";
import { readCivilianOrphans } from "./records.ts";
import { readAcceptedMission } from "./acceptedMission.ts";
import { createCivilianProfileRoutes } from "./profiles.ts";
const require = createRequire(import.meta.url),
  { createDocumentStore } = require("../documentStore.cjs");
export type CivilianIndexRow = {
  worldID: string;
  owner: string;
  characterID: number;
  botID: string;
  kind: "mining" | "distribution";
  status: string;
  phase: string | null;
  pending: string | null;
  firstFailure: string | null;
  resolved: boolean;
  updatedAt: number;
  worker?: {
    startedAt: string;
    expiresAt: string | null;
    characterName: string | null;
    why: string | null;
    readout: unknown;
  };
  setup?: unknown;
};
type Store = { read(): unknown; write(value: unknown): void };
const validText = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= 256;
export const validCivilianRow = (r: any): r is CivilianIndexRow =>
  !!r &&
  validText(r.worldID) &&
  validText(r.owner) &&
  Number.isSafeInteger(r.characterID) &&
  r.characterID > 0 &&
  validText(r.botID) &&
  ["mining", "distribution"].includes(r.kind) &&
  validText(r.status) &&
  typeof r.resolved === "boolean" &&
  Number.isFinite(r.updatedAt) &&
  (r.phase === null || typeof r.phase === "string") &&
  (r.pending === null || typeof r.pending === "string") &&
  (r.firstFailure === null || typeof r.firstFailure === "string") &&
  (!r.worker ||
    (typeof r.worker.startedAt === "string" &&
      (r.worker.expiresAt === null || typeof r.worker.expiresAt === "string") &&
      (r.worker.characterName === null || typeof r.worker.characterName === "string") &&
      (r.worker.why === null || typeof r.worker.why === "string")));
function open(name = "runs") {
  const db = createDocumentStore(path.join(pluginDataDir(), "civilian-index.sqlite"));
  return { doc: db.document(name) as Store, close: () => db.close() };
}
export function createCivilianIndex(doc: Store) {
  const read = (): CivilianIndexRow[] => {
    const raw: any = doc.read();
    if (raw === null) return [];
    if (
      raw?.version !== 1 ||
      !Array.isArray(raw.rows) ||
      raw.rows.some((r: any) => !validCivilianRow(r))
    )
      throw Error("Civilian owner index is unreadable.");
    return raw.rows;
  };
  return {
    put(row: CivilianIndexRow) {
      if (!validCivilianRow(row)) throw Error("Civilian owner identity is invalid.");
      const rows = read(),
        previous = rows.find((r) => r.botID === row.botID);
      if (
        previous &&
        (previous.worldID !== row.worldID ||
          previous.owner !== row.owner ||
          previous.characterID !== row.characterID ||
          previous.kind !== row.kind)
      )
        throw Error("Civilian owner identity changed.");
      doc.write({ version: 1, rows: [...rows.filter((r) => r.botID !== row.botID), row] });
    },
    list(worldID: string, owner: string) {
      if (!validText(worldID) || !validText(owner)) return [];
      return read()
        .filter((r) => r.worldID === worldID && r.owner === owner.toLowerCase())
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    workerAccounts(worldID: string) {
      return [
        ...new Set(
          read()
            .filter((row) => row.worldID === worldID)
            .map((row) => row.owner),
        ),
      ];
    },
  };
}
export function createCivilianCheckpointsRoute(
  opener = open,
  orphans: (world: string, owner: string) => CivilianIndexRow[] = () => [],
): BackendRoute {
  return (request) => {
    const world = worldForRequest(request),
      owner = request.account?.username;
    if (!validText(world) || !validText(owner))
      return { status: 503, body: { ok: false, error: "CIVILIAN_WORLD_UNAVAILABLE" } };
    const storage = opener();
    try {
      const index = createCivilianIndex(storage.doc);
      let rows = index.list(world, owner),
        notice =
          "Legacy checkpoints without exact world/account provenance remain withheld. No pilot is acquired by this read.";
      const stored = new Map<string, CivilianIndexRow>();
      try {
        for (const row of orphans(world, owner)) {
          stored.set(row.botID, row);
          if (!rows.some((r) => r.botID === row.botID)) {
            index.put(row);
            rows.push(row);
          }
        }
      } catch {
        notice +=
          " Some original checkpoint evidence could not be read; its custody remains retained.";
      }
      rows = rows.sort((a, b) => b.updatedAt - a.updatedAt);
      const recovery = rows
        .filter((r) => !r.resolved)
        .map((r) => ({
          pin: r.botID,
          characterID: r.characterID,
          idle: false,
          reason:
            r.firstFailure ??
            (r.pending
              ? `Stored ${r.kind} action ${r.pending} requires review.`
              : `Stored ${r.kind} mission/cargo checkpoint has not been independently reconciled.`),
          scope: "STORED_ONLY",
          kind: r.kind,
          botID: r.botID,
        }));
      return {
        body: {
          ok: true,
          recovery,
          history: rows.map((row) => {
            const readout = row.worker?.readout as
              { acceptedMission?: unknown; continuationUnavailable?: boolean } | null | undefined;
            const checkpoint = stored.get(row.botID)?.worker?.readout as
              { acceptedMission?: unknown } | undefined;
            // The mission executor writes its journal before the next progress report.
            // A stale null (for example in an "Accepting" report) cannot hide that write.
            const unavailable =
              readout?.continuationUnavailable === true ||
              (row.status === "error" && readout?.acceptedMission === null);
            const acceptedMission =
              row.resolved || unavailable
                ? null
                : readAcceptedMission(
                    checkpoint && Object.hasOwn(checkpoint, "acceptedMission")
                      ? checkpoint.acceptedMission
                      : readout?.acceptedMission,
                  );
            return { ...row, acceptedMission, ownerAvailable: civilianOwnerAvailable(row) };
          }),
          legacyUnindexed: true,
          legacyNotice: notice,
        },
      };
    } catch {
      return { status: 503, body: { ok: false, error: "CIVILIAN_INDEX_UNAVAILABLE" } };
    } finally {
      storage.close();
    }
  };
}
export function createCivilianRecoveryRoute(opener = open): BackendRoute {
  return async (request) => {
    const storage = opener();
    try {
      const row = createCivilianIndex(storage.doc)
        .list(worldForRequest(request) ?? "", request.account.username)
        .find((r) => r.botID === request.params.botID);
      if (!row) return { status: 404, body: { ok: false, error: "CIVILIAN_CHECKPOINT_NOT_FOUND" } };
      const checked = await inspectCivilianOwner(row);
      return {
        body: {
          ok: true,
          recovery: {
            ...row,
            ...((row.worker?.readout as object) ?? {}),
            pin: row.botID,
            idle: false,
            ...checked,
          },
        },
      };
    } catch (error) {
      return {
        status: 409,
        body: {
          ok: false,
          error: "CIVILIAN_RECOVERY_RETAINED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      storage.close();
    }
  };
}
export const civilianContinueRoute: BackendRoute = async (request) => {
  const storage = open();
  try {
    const rows = createCivilianIndex(storage.doc).list(
      worldForRequest(request) ?? "",
      request.account.username,
    );
    const row = rows.find((r) => r.botID === request.params.botID);
    if (
      !row ||
      row.kind !== "mining" ||
      row.status !== "paused" ||
      row.resolved ||
      rows.find((r) => r.characterID === row.characterID && r.kind === row.kind)?.botID !==
        row.botID
    )
      return {
        status: 409,
        body: {
          ok: false,
          error: "MINING_CONTINUATION_UNAVAILABLE",
          message: "The selected Mining worker no longer has a paused mission to continue.",
        },
      };
    return { body: { ok: true, ...(await continueCivilianOwner(row)) } };
  } catch (error) {
    return {
      status: 409,
      body: {
        ok: false,
        error: "MINING_CONTINUATION_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    storage.close();
  }
};
export const civilianCheckpointRoutes = {
  ...createCivilianProfileRoutes(
    (world) => open("profiles:" + world),
    (world) => {
      const storage = open();
      try {
        return createCivilianIndex(storage.doc).workerAccounts(world);
      } finally {
        storage.close();
      }
    },
  ),
  "POST /civilian/checkpoints/:botID/continue": civilianContinueRoute,
  "GET /civilian/checkpoints": createCivilianCheckpointsRoute(open, readCivilianOrphans),
  "POST /civilian/checkpoints/:botID/check": createCivilianRecoveryRoute(),
};
export function writeCivilianIndex(row: CivilianIndexRow) {
  const storage = open();
  try {
    createCivilianIndex(storage.doc).put(row);
  } finally {
    storage.close();
  }
}
