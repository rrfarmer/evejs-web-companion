import { definiteStartRefusal } from "../shared/activeRoster.ts";
import type { SyncDocument } from "./miningStore.ts";
export interface FleetLaunchMember {
  readonly characterID: number;
  readonly accountName: string;
  readonly role: "MINER" | "HAULER" | "COMMAND" | "DEFENDER";
  readonly kind: "mcc-miner" | "mcc-hauler" | "mcc-command" | "mcc-defender";
  readonly beforeIDs: readonly string[];
  readonly status: "PREPARED" | "DISPATCHED" | "ACCEPTED";
  readonly botID: string | null;
  readonly refusal?: string;
}
export interface FleetLaunchReceipt {
  readonly version: 1;
  readonly operationID: string;
  readonly operationRunID: string;
  readonly revision: number;
  readonly planHash: string;
  readonly setupHash: string;
  readonly shiftEndsAt?: number;
  readonly members: readonly FleetLaunchMember[];
}
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200;
const validID = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
/** BOT_START_FAILED is returned after Bot Host finalized the failed acquisition.
 * A bare HTTP 502 or lost response does not establish that result. */
export function confirmedFleetStartFailure(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown } | null;
  return definiteStartRefusal(error) || (e?.code === "BOT_START_FAILED" && e.status === 502);
}
/** A dispatch fence, not a substitute for native readiness or current run ownership. */
export function createFleetLaunchJournal(document: SyncDocument) {
  function read(): FleetLaunchReceipt | null {
    const x = document.read() as FleetLaunchReceipt | null;
    if (x === null) return null;
    if (
      !x ||
      x.version !== 1 ||
      !nonempty(x.operationID) ||
      !nonempty(x.operationRunID) ||
      !validID(x.revision) ||
      !nonempty(x.planHash) ||
      !nonempty(x.setupHash) ||
      (x.shiftEndsAt !== undefined &&
        (!validID(x.shiftEndsAt) || !Number.isFinite(new Date(x.shiftEndsAt).getTime()))) ||
      !Array.isArray(x.members) ||
      !x.members.length ||
      new Set(x.members.map((m) => m.characterID)).size !== x.members.length ||
      x.members.some(
        (m) =>
          !validID(m.characterID) ||
          !nonempty(m.accountName) ||
          !(["MINER", "HAULER", "COMMAND", "DEFENDER"] as string[]).includes(m.role) ||
          m.kind !== `mcc-${m.role.toLowerCase()}` ||
          !Array.isArray(m.beforeIDs) ||
          m.beforeIDs.some((id: unknown) => !nonempty(id)) ||
          new Set(m.beforeIDs).size !== m.beforeIDs.length ||
          !(["PREPARED", "DISPATCHED", "ACCEPTED"] as string[]).includes(m.status) ||
          (m.refusal !== undefined && (m.status !== "PREPARED" || !nonempty(m.refusal))) ||
          (m.status === "ACCEPTED" ? !nonempty(m.botID) : m.botID !== null),
      ) ||
      new Set(x.members.filter((m) => m.botID !== null).map((m) => m.botID)).size !==
        x.members.filter((m) => m.botID !== null).length
    )
      throw Error("Fleet launch journal requires reconciliation.");
    return structuredClone(x);
  }
  function begin(
    input: Omit<FleetLaunchReceipt, "version" | "members"> & {
      members: readonly Omit<FleetLaunchMember, "status" | "botID">[];
    },
  ) {
    const existing = read(),
      next: FleetLaunchReceipt = {
        version: 1,
        ...structuredClone(input),
        members: input.members.map((m) => ({
          ...structuredClone(m),
          status: "PREPARED",
          botID: null,
        })),
      };
    if (existing) {
      if (
        JSON.stringify({
          ...existing,
          members: existing.members.map(({ status, botID, refusal, ...m }) => m),
        }) !==
        JSON.stringify({
          ...next,
          members: next.members.map(({ status, botID, refusal, ...m }) => m),
        })
      )
        throw Error("Another fleet launch generation requires reconciliation.");
      return existing;
    }
    createFleetLaunchJournal({ read: () => next, write: () => {} }).read();
    document.write(next);
    return read()!;
  }
  function dispatch(characterID: number) {
    const x = read();
    if (!x) throw Error("Fleet launch intent is missing.");
    const m = x.members.find((m) => m.characterID === characterID);
    if (!m || m.status !== "PREPARED")
      throw Error("Fleet Start was already dispatched or the member is unknown; no replay.");
    const next = {
      ...x,
      members: x.members.map(({ refusal, ...row }) =>
        row.characterID === characterID
          ? { ...row, status: "DISPATCHED" as const }
          : { ...row, ...(refusal ? { refusal } : {}) },
      ),
    };
    document.write(next);
    return read()!;
  }
  function accept(characterID: number, botID: string) {
    const x = read();
    if (!x || !nonempty(botID)) throw Error("Fleet Start receipt is invalid.");
    const m = x.members.find((m) => m.characterID === characterID);
    if (
      !m ||
      m.status !== "DISPATCHED" ||
      m.beforeIDs.includes(botID) ||
      x.members.some((row) => row.botID === botID)
    )
      throw Error("Fleet Start receipt does not match its original dispatch.");
    const next = {
      ...x,
      members: x.members.map((row) =>
        row.characterID === characterID ? { ...row, status: "ACCEPTED" as const, botID } : row,
      ),
    };
    document.write(next);
    return read()!;
  }
  // Called by a verified Bot Host resume. The browser's original Start receipt still uses accept().
  function rebind(
    operationRunID: string,
    characterID: number,
    previousBotID: string,
    botID: string,
  ) {
    const x = read(),
      member = x?.members.find((m) => m.characterID === characterID);
    if (
      x?.operationRunID !== operationRunID ||
      member?.status !== "ACCEPTED" ||
      member.botID !== previousBotID ||
      !nonempty(botID)
    )
      throw Error("The accepted fleet launch changed during hosted resume.");
    if (previousBotID === botID) return;
    if (member.beforeIDs.includes(botID) || x.members.some((m) => m.botID === botID))
      throw Error("The resumed Bot Host identity conflicts with the accepted fleet roster.");
    document.write({
      ...x,
      members: x.members.map((m) => (m.characterID === characterID ? { ...m, botID } : m)),
    });
  }
  function refuse(
    operationRunID: string,
    characterID: number,
    evidence: { code: unknown; status: unknown; message?: unknown },
  ) {
    const x = read();
    if (
      !x ||
      x.operationRunID !== operationRunID ||
      !confirmedFleetStartFailure(evidence) ||
      !x.members.some((m) => m.characterID === characterID && m.status === "DISPATCHED")
    )
      throw Error("Hosted Start failure is not confirmed.");
    const refusal =
      typeof evidence.message === "string" && evidence.message.trim()
        ? evidence.message.trim().slice(0, 200)
        : String(evidence.code);
    document.write({
      ...x,
      members: x.members.map((m) =>
        m.characterID === characterID ? { ...m, status: "PREPARED", refusal } : m,
      ),
    });
    return read()!;
  }
  return { read, begin, dispatch, accept, rebind, refuse };
}
