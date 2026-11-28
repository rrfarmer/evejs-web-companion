import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pluginDataDir, type BackendRun } from "../../../web/src/plugin-api/backend.ts";
const require = createRequire(import.meta.url),
  Database = require("better-sqlite3");
type Reader = { read(file: string, key: string): unknown; close(): void };
function openReader(): Reader {
  const opened = new Map<string, any>();
  return {
    read(file, key) {
      const filename = path.join(pluginDataDir(), file);
      if (!fs.existsSync(filename)) return null;
      let db = opened.get(file);
      if (!db) {
        db = new Database(filename, { readonly: true, fileMustExist: true });
        opened.set(file, db);
      }
      const row = db.prepare("SELECT value FROM documents WHERE name = ?").get(key);
      return row ? JSON.parse(row.value) : null;
    },
    close() {
      for (const db of opened.values()) db.close();
    },
  };
}
const positive = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
/** Exposes stored evidence for the pilot core already holds. It never reconciles or dispatches a mission action. */
export function createCivilianCheckpointRun(open: () => Reader = openReader): BackendRun {
  return {
    check(value) {
      return value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
        ? {
            ok: true,
            setup: {},
            name: "Inspect civilian checkpoint",
            policy: { riskClasses: [], restartSafe: false },
          }
        : { ok: false, refusal: "Choose the pilot whose checkpoint to inspect." };
    },
    async start(run) {
      if (run.resumed || !positive(run.characterID) || run.held.characterID !== run.characterID)
        throw Error("Civilian checkpoint owner is unavailable.");
      const reader = open();
      try {
        const m: any = reader.read("missions.sqlite", `native-mining:${run.characterID}`),
          d: any = reader.read("distribution.sqlite", "distribution-missions");
        if (
          m !== null &&
          (!m ||
            m.version !== 1 ||
            m.characterID !== run.characterID ||
            typeof m.completed !== "boolean" ||
            !Object.hasOwn(m, "pending") ||
            !(
              m.pending === null ||
              (m.pending &&
                typeof m.pending === "object" &&
                typeof m.pending.kind === "string" &&
                m.pending.kind)
            ) ||
            (m.history !== undefined && !Array.isArray(m.history)))
        )
          throw Error("Mining checkpoint is unreadable.");
        if (
          d !== null &&
          (!d ||
            d.version !== 1 ||
            !d.records ||
            typeof d.records !== "object" ||
            Array.isArray(d.records) ||
            (d.history !== undefined && !Array.isArray(d.history)))
        )
          throw Error("Distribution checkpoint is unreadable.");
        const row = d?.records?.[`1:${run.characterID}`] ?? null;
        if (
          row !== null &&
          (row.characterID !== run.characterID ||
            row.accountID !== 1 ||
            typeof row.done !== "boolean" ||
            typeof row.runID !== "string" ||
            !row.runID ||
            !Object.hasOwn(row, "pending") ||
            !(
              row.pending === null ||
              (row.pending &&
                typeof row.pending === "object" &&
                typeof row.pending.intent?.kind === "string" &&
                row.pending.intent.kind)
            ))
        )
          throw Error("Distribution checkpoint is unreadable.");
        const mining = m
          ? {
              completed: m.completed,
              pending: typeof m.pending?.kind === "string" ? m.pending.kind : null,
              legacyPending: !!(m.legacy?.pending || m.legacy?.cycle),
              agentID: positive(m.agentID) ? m.agentID : null,
              contentID: positive(m.mission?.content?.contentID)
                ? m.mission.content.contentID
                : null,
              historyCount: Array.isArray(m.history) ? m.history.length : 0,
            }
          : null;
        const distribution = row
          ? {
              done: row.done,
              runID: row.runID,
              pending:
                typeof row.pending?.intent?.kind === "string" ? row.pending.intent.kind : null,
              agentID: positive(row.mission?.agentID) ? row.mission.agentID : null,
              missionKey:
                typeof row.mission?.missionKey === "string" ? row.mission.missionKey : null,
            }
          : null;
        run.report({
          status: "stopped",
          phase: "Civilian checkpoint inspected",
          readout: {
            characterID: run.characterID,
            mining,
            distribution,
            scope: "STORED_ONLY",
            nativeReconciled: false,
          } as any,
        });
      } finally {
        reader.close();
      }
      return { async stop() {} };
    },
  };
}
export const civilianCheckpointRun = createCivilianCheckpointRun();
