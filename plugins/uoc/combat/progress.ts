import path from "node:path";
import { createRequire } from "node:module";
import { pluginDataDir, type BackendRoute } from "../../../web/src/plugin-api/backend.ts";
import { createSecurityJournal } from "./journal.ts";
import { securityReadout } from "./readout.ts";
const require = createRequire(import.meta.url),
  Database = require("better-sqlite3");
type Reader = { read(name: string): unknown; close(): void };
function openReader(): Reader {
  const db = new Database(path.join(pluginDataDir(), "missions.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  const select = db.prepare("SELECT value FROM documents WHERE name = ?");
  return {
    read(name) {
      const row = select.get(name);
      return row ? JSON.parse(row.value) : null;
    },
    close() {
      db.close();
    },
  };
}
/** Read an exact account-owned journal generation without changing pilot or mission state. */
export function createSecurityProgressRoute(open: () => Reader = openReader): BackendRoute {
  return async (request) => {
    const rawID = request.params.characterID,
      runID = request.query.runID,
      username = request.account?.username;
    if (
      !/^\d+$/.test(rawID ?? "") ||
      !Number.isSafeInteger(Number(rawID)) ||
      Number(rawID) <= 0 ||
      typeof runID !== "string" ||
      !runID ||
      runID.length > 200 ||
      typeof username !== "string" ||
      !username
    )
      return { status: 404, body: { ok: false, error: "SECURITY_RUN_NOT_FOUND" } };
    const characterID = Number(rawID);
    let reader: Reader | null = null;
    try {
      reader = open();
      const raw = reader.read(`security:${characterID}`) as any;
      const candidates =
        raw?.format === "security-history-v1"
          ? Array.isArray(raw.history)
            ? [...raw.history, raw.active]
            : null
          : [raw];
      if (!candidates) return { status: 404, body: { ok: false, error: "SECURITY_RUN_NOT_FOUND" } };
      const matches = candidates.filter((state: any) => state && state.runID === runID);
      if (
        matches.length !== 1 ||
        matches[0].characterID !== characterID ||
        matches[0].accountID !== username.toLowerCase()
      )
        return { status: 404, body: { ok: false, error: "SECURITY_RUN_NOT_FOUND" } };
      const state = await createSecurityJournal(
        {
          read: () => matches[0],
          write: () => {
            throw Error("Read-only route");
          },
        },
        { accountID: username.toLowerCase(), characterID, runID },
      ).read();
      if (!state) throw Error("Security journal is unavailable.");
      const stored = reader.read(`security-telemetry:${characterID}:${runID}`) as any;
      if (stored !== null && (stored.runID !== runID || !Array.isArray(stored.events)))
        throw Error("Security diagnostics are malformed.");
      const readout = securityReadout(state, stored ?? { runID, events: [] });
      return {
        status: 200,
        body: {
          ok: true,
          characterID,
          runID,
          phase: state.phase,
          identity: state.identity,
          readout,
          telemetryAvailable: stored !== null,
        },
      };
    } catch {
      return { status: 503, body: { ok: false, error: "SECURITY_PROGRESS_UNAVAILABLE" } };
    } finally {
      reader?.close();
    }
  };
}
/** The account-owned journal is durable even when the host's recent-run roster is empty. */
export function createSecurityHistoryRoute(open: () => Reader = openReader): BackendRoute {
  return async (request) => {
    const rawID = request.params.characterID,
      username = request.account?.username;
    if (
      !/^\d+$/.test(rawID ?? "") ||
      !Number.isSafeInteger(Number(rawID)) ||
      Number(rawID) <= 0 ||
      typeof username !== "string" ||
      !username
    )
      return { status: 404, body: { ok: false, error: "SECURITY_RUN_NOT_FOUND" } };
    const characterID = Number(rawID);
    let reader: Reader | null = null;
    try {
      reader = open();
      const raw = reader.read(`security:${characterID}`) as any;
      const candidates =
        raw?.format === "security-history-v1"
          ? Array.isArray(raw.history)
            ? [...raw.history, raw.active]
            : null
          : raw
            ? [raw]
            : null;
      if (
        !candidates ||
        candidates.some(
          (s: any) => !s || s.characterID !== characterID || s.accountID !== username.toLowerCase(),
        )
      )
        return { status: 404, body: { ok: false, error: "SECURITY_RUN_NOT_FOUND" } };
      const ids = new Set<string>();
      for (const s of candidates) {
        if (typeof s.runID !== "string" || !s.runID || s.runID.length > 200 || ids.has(s.runID))
          throw Error("Ambiguous journal run.");
        ids.add(s.runID);
      }
      const rows = [];
      for (const rawState of candidates.slice(-20).reverse()) {
        const state = await createSecurityJournal(
          {
            read: () => rawState,
            write: () => {
              throw Error("Read-only route");
            },
          },
          { accountID: username.toLowerCase(), characterID, runID: rawState.runID },
        ).read();
        if (!state) throw Error("Security journal is unavailable.");
        const latest = state.completed.at(-1);
        rows.push({
          characterID,
          runID: state.runID,
          phase: state.phase,
          completedCount: state.completed.length,
          latestReceipt: latest
            ? { missionKey: latest.identity.acceptedKey, commandID: latest.commandID }
            : null,
        });
      }
      const body = { ok: true, characterID, rows, truncated: candidates.length > 20 };
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > 12000)
        throw Error("Security history is too large.");
      return { status: 200, body };
    } catch {
      return { status: 503, body: { ok: false, error: "SECURITY_PROGRESS_UNAVAILABLE" } };
    } finally {
      reader?.close();
    }
  };
}
/** Paged exact native completion receipts; no cross-run aggregation or writes. */
export function createSecurityReceiptsRoute(open: () => Reader = openReader): BackendRoute {
  return async (request) => {
    const rawID = request.params.characterID,
      runID = request.query.runID,
      rawOffset = request.query.offset ?? "0",
      username = request.account?.username;
    if (
      !/^\d+$/.test(rawID ?? "") ||
      !Number.isSafeInteger(Number(rawID)) ||
      Number(rawID) <= 0 ||
      typeof runID !== "string" ||
      !runID ||
      runID.length > 200 ||
      typeof rawOffset !== "string" ||
      !/^\d+$/.test(rawOffset) ||
      !Number.isSafeInteger(Number(rawOffset)) ||
      typeof username !== "string" ||
      !username
    )
      return { status: 404, body: { ok: false, error: "SECURITY_RUN_NOT_FOUND" } };
    const characterID = Number(rawID),
      offset = Number(rawOffset);
    let reader: Reader | null = null;
    try {
      reader = open();
      const raw = reader.read(`security:${characterID}`) as any,
        candidates =
          raw?.format === "security-history-v1"
            ? Array.isArray(raw.history)
              ? [...raw.history, raw.active]
              : null
            : [raw];
      if (!candidates) return { status: 404, body: { ok: false, error: "SECURITY_RUN_NOT_FOUND" } };
      const matches = candidates.filter((s: any) => s && s.runID === runID);
      if (
        matches.length !== 1 ||
        matches[0].characterID !== characterID ||
        matches[0].accountID !== username.toLowerCase()
      )
        return { status: 404, body: { ok: false, error: "SECURITY_RUN_NOT_FOUND" } };
      const state = await createSecurityJournal(
        {
          read: () => matches[0],
          write: () => {
            throw Error("Read-only route");
          },
        },
        { accountID: username.toLowerCase(), characterID, runID },
      ).read();
      if (!state || offset > state.completed.length) throw Error("Receipt offset is unavailable.");
      const decimal = (v: unknown) =>
        typeof v === "string" && /^-?\d+(?:\.\d{1,2})?$/.test(v) && v.length <= 40
          ? v
          : typeof v === "number" && Number.isFinite(v)
            ? String(v)
            : null;
      const entries = state.completed.slice(offset, offset + 20).map((r) => {
        const reward = r.reward;
        return {
          missionKey: r.identity.acceptedKey,
          commandID: r.commandID,
          confirmedIsk: decimal(reward ? reward.confirmedIsk : r.isk),
          withheldIsk: decimal(reward ? reward.withheldIsk : r.taxISK),
          observedLpChange: decimal(reward ? reward.observedLpChange : r.lp),
          observedCorporationLpChange: decimal(reward?.observedCorporationLpChange),
        };
      });
      if (
        entries.some(
          (e) =>
            typeof e.missionKey !== "string" ||
            !e.missionKey ||
            e.missionKey.length > 1000 ||
            typeof e.commandID !== "string" ||
            !e.commandID ||
            e.commandID.length > 200,
        ) ||
        new Set(state.completed.map((r) => r.identity.acceptedKey)).size !== state.completed.length
      )
        throw Error("Receipt identity is ambiguous.");
      const nextOffset =
          offset + entries.length < state.completed.length ? offset + entries.length : null,
        body = {
          ok: true,
          characterID,
          runID,
          completedCount: state.completed.length,
          offset,
          nextOffset,
          entries,
        };
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > 12000)
        throw Error("Receipt page exceeds the readout limit.");
      return { status: 200, body };
    } catch {
      return { status: 503, body: { ok: false, error: "SECURITY_PROGRESS_UNAVAILABLE" } };
    } finally {
      reader?.close();
    }
  };
}
export const securityProgressRoutes = {
  "GET /security/:characterID/progress": createSecurityProgressRoute(),
  "GET /security/:characterID/history": createSecurityHistoryRoute(),
  "GET /security/:characterID/receipts": createSecurityReceiptsRoute(),
};
