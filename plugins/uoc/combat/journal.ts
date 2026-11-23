import type { Journal, State } from "./security.ts";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export interface SecurityStorage { read(): unknown; write(value: unknown): void }
/** Pass a dedicated SQLite FULL document from createDocumentStore; one coordinator owns each document. */
export function createSecurityJournal(storage: SecurityStorage, scope: { accountID: number | string; characterID: number; runID: string }): Journal {
  if (!(typeof scope.accountID === "string" ? scope.accountID.length > 0 : Number.isSafeInteger(scope.accountID) && scope.accountID > 0) || !Number.isSafeInteger(scope.characterID) || scope.characterID <= 0 || !scope.runID) throw new Error("Invalid Security journal scope.");
  function read(): State | null {
    const raw = storage.read();
    if (raw === null) return null;
    const s = raw as State;
    if (!s || s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 1 || s.accountID !== scope.accountID || s.characterID !== scope.characterID || s.runID !== scope.runID ||
        !Number.isSafeInteger(s.shipID) || s.shipID <= 0 || !Number.isSafeInteger(s.agentID) || s.agentID <= 0 || !Number.isSafeInteger(s.agentStationID) || s.agentStationID <= 0 || !Number.isSafeInteger(s.agentSystemID) || s.agentSystemID <= 0 ||
        (s.agentLevel!==undefined&&s.agentLevel!==1&&s.agentLevel!==2) || (s.unqualifiedOffer!=null&&(!Number.isSafeInteger(s.unqualifiedOffer.agentID)||s.unqualifiedOffer.agentID!==s.agentID||!Number.isSafeInteger(s.unqualifiedOffer.missionID)||s.unqualifiedOffer.missionID<=0||typeof s.unqualifiedOffer.missionKey!=="string"||!s.unqualifiedOffer.missionKey)) || (s.missionLimit!==null&&(!Number.isSafeInteger(s.missionLimit)||s.missionLimit < 1)) || !Number.isFinite(s.deadlineMs) || !Array.isArray(s.completed) ||
        !["AGENT", "OFFER", "ACCEPT", "MISSION_SYSTEM", "ENTRY", "COMBAT", "SETTLE", "PROGRESS", "RETURN", "COMPLETE", "DONE", "BLOCKED"].includes(s.phase) ||
        (s.pending !== null && (!s.pending || !s.pending.id || !["DISPATCHED", "ACKNOWLEDGED"].includes(s.pending.status) || s.pending.characterID !== s.characterID || s.pending.shipID !== s.shipID || s.pending.agentID !== s.agentID)))
      throw new Error("Invalid or foreign Security journal; recovery evidence retained.");
    return clone(s);
  }
  return {
    async read() { return read(); },
    async save(expectedRevision, next) {
      const current = read();
      if ((current?.revision ?? null) !== expectedRevision || next.revision !== (expectedRevision ?? 0) + 1 || next.accountID !== scope.accountID || next.characterID !== scope.characterID || next.runID !== scope.runID) throw new Error("Stale or foreign Security journal write.");
      storage.write(clone(next));
    },
  };
}
