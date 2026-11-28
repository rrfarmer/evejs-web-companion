import path from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { pluginDataDir, type BackendRoute } from "../../../web/src/plugin-api/backend.ts";
const require = createRequire(import.meta.url),
  Database = require("better-sqlite3");
type Doc = { read(): unknown; write(v: unknown): void };
export interface FleetTelemetryIdentity {
  operationID: string;
  operationRunID: string;
  botID: string;
  characterID: number;
  shipID: number;
  sessionGeneration: number;
  account: string;
}
const key = (i: Omit<FleetTelemetryIdentity, "account">) =>
  `fleet-security-telemetry:${JSON.stringify([i.operationID, i.operationRunID, i.botID, i.characterID])}`;
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
function validEngageScope(s: any) {
  return (
    !!s &&
    typeof s === "object" &&
    !Array.isArray(s) &&
    typeof s.acceptedKey === "string" &&
    s.acceptedKey.length > 0 &&
    positive(s.dungeonID) &&
    positive(s.instanceID) &&
    Number.isSafeInteger(s.roomID) &&
    s.roomID >= 0
  );
}
function valid(i: FleetTelemetryIdentity) {
  return (
    [i.operationID, i.operationRunID, i.botID, i.account].every(
      (x) => typeof x === "string" && x.length > 0 && x.length <= 200,
    ) &&
    positive(i.characterID) &&
    positive(i.shipID) &&
    Number.isSafeInteger(i.sessionGeneration) &&
    i.sessionGeneration >= 0
  );
}
export function createFleetTelemetry(
  document: (name: string) => Doc,
  identity: FleetTelemetryIdentity,
) {
  const normalized = { ...identity, account: identity.account.toLowerCase() };
  if (!valid(normalized)) throw Error("Fleet telemetry identity is invalid.");
  const doc = document(key(normalized)),
    old = doc.read() as any;
  if (
    old !== null &&
    (!old ||
      old.version !== 1 ||
      JSON.stringify(old.identity) !== JSON.stringify(normalized) ||
      !Array.isArray(old.events) ||
      !old.pending ||
      typeof old.pending !== "object")
  )
    throw Error("Fleet telemetry identity or history differs.");
  let state = old ?? {
    version: 1,
    identity: normalized,
    events: [],
    pending: {},
    milestones: {},
    agentActions: [],
    agentActionsTruncated: false,
    nextSeq: 1,
  };
  return {
    record(kind: string, data: unknown) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind))
        throw Error("Fleet telemetry event kind is invalid.");
      let serialized: string;
      try {
        serialized = JSON.stringify(data ?? null);
      } catch {
        serialized = "null";
      }
      const safe =
        Buffer.byteLength(serialized, "utf8") <= 8192
          ? JSON.parse(serialized)
          : { truncated: true };
      const sequence =
        Number.isSafeInteger(state.nextSeq) && state.nextSeq > 0
          ? state.nextSeq
          : Math.max(
              0,
              ...state.events.map((e: any) => (Number.isSafeInteger(e.seq) ? e.seq : 0)),
            ) + 1;
      const event = { seq: sequence, kind, at: Date.now(), data: safe };
      const pending = { ...state.pending };
      if (kind === "complete-dispatch") pending.complete = event;
      if (kind === "complete-confirmed") delete pending.complete;
      if (kind === "launch-dispatch") pending.launch = event;
      if (kind === "engage-dispatch") {
        pending.engage = event;
        delete pending.engageResponse;
      }
      if (kind === "launch-confirmed") delete pending.launch;
      if (kind === "engage-confirmed") {
        delete pending.engage;
        delete pending.engageResponse;
      }
      const dispatch = pending.engage as any,
        matchResponse = (response: any) =>
          !!dispatch &&
          response?.kind === "engage-response" &&
          response.seq > dispatch.seq &&
          positive(dispatch.data?.target) &&
          response.data?.target === dispatch.data.target &&
          Array.isArray(dispatch.data?.ids) &&
          dispatch.data.ids.length > 0 &&
          isDeepStrictEqual(response.data?.ids, dispatch.data.ids);
      if (kind === "engage-response" && matchResponse(event)) pending.engageResponse = event;
      const response = pending.engageResponse ?? [...state.events].reverse().find(matchResponse);
      const exactAbsent =
        kind === "engage-target-absent" &&
        !!dispatch &&
        positive(dispatch.data?.target) &&
        safe?.target === dispatch.data.target &&
        validEngageScope(dispatch.data?.scope) &&
        validEngageScope(safe?.scope) &&
        isDeepStrictEqual(safe.scope, dispatch.data.scope) &&
        matchResponse(response);
      if (exactAbsent) {
        delete pending.engage;
        delete pending.engageResponse;
      }
      const keep = [
        "native-fleet",
        "room-published",
        "primary-selected",
        "primary-observed",
        "room-arrival",
        "launch-confirmed",
        "engage-confirmed",
        "complete-dispatch",
        "complete-response",
        "complete-confirmed",
        "mission-offered",
        "mission-accepted",
        "mission-empty",
        "agent-action-dispatch",
        "agent-action-response",
      ].includes(kind);
      let milestones = keep ? { ...state.milestones, [kind]: event } : state.milestones;
      if (exactAbsent)
        milestones = {
          ...milestones,
          "engage-absent-settlement": {
            seq: event.seq,
            kind: "engage-absent-settlement",
            at: event.at,
            data: { dispatch, response, absence: event },
          },
        };
      const actions = Array.isArray(state.agentActions) ? state.agentActions : [],
        isAction = kind === "agent-action-dispatch" || kind === "agent-action-response",
        agentActions = isAction ? [...actions, event].slice(-64) : actions;
      const next = {
        ...state,
        nextSeq: sequence + 1,
        pending,
        milestones,
        agentActions,
        agentActionsTruncated:
          state.agentActionsTruncated === true || (isAction && actions.length >= 64),
        events: [...state.events, event].slice(-128),
      };
      doc.write(next);
      state = next;
    },
    snapshot: () => structuredClone(state),
  };
}
type Reader = { read(name: string): unknown; close(): void };
function openReader(): Reader {
  const db = new Database(path.join(pluginDataDir(), "fleet-security.sqlite"), {
      readonly: true,
      fileMustExist: true,
    }),
    read = db.prepare("SELECT value FROM documents WHERE name = ?");
  return {
    read(name) {
      const row = read.get(name);
      return row ? JSON.parse(row.value) : null;
    },
    close() {
      db.close();
    },
  };
}
/** Account-scoped read of one exact hosted actor and generation; no pilot session is opened. */
export function createFleetSecurityProgressRoute(open: () => Reader = openReader): BackendRoute {
  return (request) => {
    const characterID = Number(request.params.characterID),
      { operationID, operationRunID, botID } = request.query,
      account = request.account?.username;
    if (
      !positive(characterID) ||
      ![operationID, operationRunID, botID, account].every(
        (v) => typeof v === "string" && v.length > 0 && v.length <= 200,
      )
    )
      return { status: 404, body: { ok: false, error: "FLEET_SECURITY_RUN_NOT_FOUND" } };
    const i = {
        operationID: operationID as string,
        operationRunID: operationRunID as string,
        botID: botID as string,
        characterID,
      },
      expectedAccount = (account as string).toLowerCase();
    let reader: Reader | null = null;
    try {
      reader = open();
      const value = reader.read(key(i as Omit<FleetTelemetryIdentity, "account">)) as any;
      if (
        !value ||
        value.version !== 1 ||
        value.identity?.operationID !== i.operationID ||
        value.identity?.operationRunID !== i.operationRunID ||
        value.identity?.botID !== i.botID ||
        value.identity?.characterID !== i.characterID ||
        value.identity?.account !== expectedAccount ||
        !positive(value.identity?.shipID) ||
        !Number.isSafeInteger(value.identity?.sessionGeneration) ||
        value.identity.sessionGeneration < 0 ||
        !Array.isArray(value.events) ||
        !value.pending ||
        typeof value.pending !== "object"
      )
        return { status: 404, body: { ok: false, error: "FLEET_SECURITY_RUN_NOT_FOUND" } };
      const events = value.events.slice(-32),
        body: any = {
          ok: true,
          ...i,
          shipID: value.identity.shipID,
          sessionGeneration: value.identity.sessionGeneration,
          pending: value.pending,
          milestones: structuredClone(value.milestones ?? {}),
          agentActions: Array.isArray(value.agentActions) ? value.agentActions : [],
          agentActionsTruncated: value.agentActionsTruncated === true,
          events,
          truncated: value.events.length > events.length,
        };
      while (Buffer.byteLength(JSON.stringify(body), "utf8") > 12000 && events.length) {
        events.shift();
        body.truncated = true;
      }
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > 12000) {
        const ordered = Object.entries(body.milestones as Record<string, { at: number }>).sort(
          (a, b) => a[1].at - b[1].at,
        );
        while (Buffer.byteLength(JSON.stringify(body), "utf8") > 12000 && ordered.length) {
          delete body.milestones[ordered.shift()![0]];
          body.truncated = true;
        }
      }
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > 12000)
        throw Error("Fleet progress is too large.");
      return { status: 200, body };
    } catch {
      return { status: 503, body: { ok: false, error: "FLEET_SECURITY_PROGRESS_UNAVAILABLE" } };
    } finally {
      reader?.close();
    }
  };
}
export const fleetSecurityProgressRoutes = {
  "GET /fleet-security/:characterID/progress": createFleetSecurityProgressRoute(),
};
