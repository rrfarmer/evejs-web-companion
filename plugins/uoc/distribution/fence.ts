import fs from "node:fs";
import path from "node:path";
import type { CivilianIndexRow } from "../civilian/index.ts";
import {
  CivilianMissionCompleted,
  CivilianMissionMismatch,
  readAcceptedMission,
  sameAcceptedMission,
  type MissionContinuation,
} from "../civilian/acceptedMission.ts";
import type { DistributionCompletionReceipt } from "./progress.ts";

export type DistributionIntent =
  | { readonly kind: "request"; readonly agentID: number }
  | { readonly kind: "decline"; readonly agentID: number; readonly missionKey: string }
  | { readonly kind: "quit"; readonly agentID: number; readonly missionKey: string }
  | { readonly kind: "accept"; readonly agentID: number; readonly missionKey: string }
  | {
      readonly kind: "load" | "unload";
      readonly agentID: number;
      readonly missionKey: string;
      readonly shipID: number;
      readonly stationID: number;
      readonly typeID: number;
      readonly itemID: number;
      readonly itemQuantity: number;
      readonly quantity: number;
      readonly cargoBefore: number;
      readonly hangarBefore: number;
    }
  | {
      readonly kind: "complete";
      readonly agentID: number;
      readonly missionKey: string;
      readonly runnerID: string;
      readonly invocationID: number;
      readonly stepPath: string;
      readonly actionID: number;
    };
export function completionReceipt(
  intent: Extract<DistributionIntent, { kind: "complete" }>,
): DistributionCompletionReceipt {
  return {
    kind: "missionCompletion",
    runID: intent.runnerID,
    invocationID: intent.invocationID,
    stepPath: intent.stepPath,
    agentID: intent.agentID,
    actionID: intent.actionID,
    missionKey: intent.missionKey,
    completed: true,
  };
}
export interface DistributionEvidence {
  /** Checked native journal, exact current scope and strictly decoded inventory when cargo is relevant. */
  readonly journal: {
    readonly active: readonly { readonly agentID: number; readonly missionKey: string }[];
    readonly offered: readonly { readonly agentID: number; readonly missionKey: string }[];
    readonly completed?: readonly { readonly agentID: number; readonly missionKey: string }[];
  };
  readonly shipID: number | null;
  readonly stationID: number | null;
  readonly typeID: number | null;
  readonly cargoQuantity: number | null;
  readonly hangarQuantity: number | null;
  readonly sourceItem?: {
    readonly itemID: number;
    readonly typeID: number;
    readonly quantity: number;
  } | null;
  readonly acceptedAt?: string;
  readonly completed?: DistributionCompletionReceipt;
}
export interface DistributionFenceRow {
  readonly accountID: number;
  readonly characterID: number;
  readonly runID: string;
  readonly done: boolean;
  readonly civilian?: CivilianIndexRow;
  readonly accepted?: true;
  readonly acceptedAt?: string;
  readonly mission: { readonly agentID: number; readonly missionKey: string } | null;
  readonly mutated: boolean;
  readonly completion?: DistributionCompletionReceipt;
  readonly reward?: import("../shared/rewards/index.ts").MissionRewardReadout;
  /** The existing transfer's settled proof, retained until the native hand-in. */
  readonly unloaded?: Extract<DistributionIntent, { kind: "load" | "unload" }>;
  readonly pending: { readonly intent: DistributionIntent; readonly acknowledged: boolean } | null;
}
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const quantity = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const validIntent = (i: DistributionIntent) =>
  !!i &&
  ["request", "accept", "load", "unload", "complete", "decline", "quit"].includes(i.kind) &&
  positive(i.agentID) &&
  (i.kind === "request" || (typeof i.missionKey === "string" && i.missionKey.length > 0)) &&
  (i.kind !== "complete" ||
    (!!i.runnerID && positive(i.invocationID) && !!i.stepPath && positive(i.actionID))) &&
  ((i.kind !== "load" && i.kind !== "unload") ||
    (positive(i.shipID) &&
      positive(i.stationID) &&
      positive(i.typeID) &&
      positive(i.itemID) &&
      positive(i.itemQuantity) &&
      positive(i.quantity) &&
      i.itemQuantity >= i.quantity &&
      quantity(i.cargoBefore) &&
      quantity(i.hangarBefore) &&
      (i.kind === "load"
        ? i.hangarBefore >= i.quantity && Number.isSafeInteger(i.cargoBefore + i.quantity)
        : i.cargoBefore >= i.quantity && Number.isSafeInteger(i.hangarBefore + i.quantity))));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function sameOfferIdentity(offered: string, accepted: string): boolean {
  try {
    const a = JSON.parse(offered),
      b = JSON.parse(accepted);
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === 4 &&
      b.length === 4 &&
      a[0] === b[0] &&
      a[1] === b[1] &&
      a[2] === b[2]
    );
  } catch {
    return false;
  }
}
function forAgent(journal: DistributionEvidence["journal"], agentID: number) {
  return {
    active: journal.active.filter((row) => row.agentID === agentID),
    offered: journal.offered.filter((row) => row.agentID === agentID),
  };
}

export function distributionAcceptedMission(row: DistributionFenceRow | null) {
  // Older runs also marked manually inherited journal entries as accepted.
  if (
    !row?.mission ||
    row.done ||
    !row.accepted ||
    typeof row.acceptedAt !== "string" ||
    !/^[1-9]\d*$/.test(row.acceptedAt)
  )
    return null;
  try {
    const key = JSON.parse(row.mission.missionKey);
    return Array.isArray(key) && key[0] === row.mission.agentID
      ? readAcceptedMission({ agentID: key[0], missionID: key[1], key: row.mission.missionKey })
      : null;
  } catch {
    return null;
  }
}
function matches(i: DistributionIntent, e: DistributionEvidence): boolean {
  if (!e || !e.journal || !Array.isArray(e.journal.active) || !Array.isArray(e.journal.offered))
    return false;
  const { active, offered } = forAgent(e.journal, i.agentID);
  if (i.kind === "decline" || i.kind === "quit") return active.length === 0 && offered.length === 0;
  if (i.kind === "complete")
    return (
      active.length === 0 &&
      offered.length === 0 &&
      e.completed?.completed === true &&
      e.completed.agentID === i.agentID &&
      e.completed.missionKey === i.missionKey &&
      e.completed.kind === "missionCompletion" &&
      e.completed.runID === i.runnerID &&
      e.completed.invocationID === i.invocationID &&
      e.completed.stepPath === i.stepPath &&
      e.completed.actionID === i.actionID
    );
  const rows = [...active, ...offered];
  if (rows.length !== 1 || !rows[0]?.missionKey) return false;
  if (i.kind === "request") return offered.length === 1;
  if (i.kind === "accept")
    return active.length === 1 && sameOfferIdentity(i.missionKey, rows[0].missionKey);
  if (rows[0].missionKey !== i.missionKey) return false;
  if (
    active.length !== 1 ||
    e.shipID !== i.shipID ||
    e.stationID !== i.stationID ||
    e.typeID !== i.typeID ||
    !quantity(e.cargoQuantity) ||
    !quantity(e.hangarQuantity)
  )
    return false;
  const direction = i.kind === "load" ? 1 : -1;
  return (
    e.cargoQuantity === i.cargoBefore + direction * i.quantity &&
    e.hangarQuantity === i.hangarBefore - direction * i.quantity
  );
}
function matchesBefore(i: DistributionIntent, e: DistributionEvidence): boolean {
  if (!e || !e.journal || !Array.isArray(e.journal.active) || !Array.isArray(e.journal.offered))
    return false;
  const { active, offered } = forAgent(e.journal, i.agentID),
    rows = [...active, ...offered];
  if (i.kind === "request") return rows.length === 0;
  if (rows.length !== 1 || rows[0]?.agentID !== i.agentID || rows[0]?.missionKey !== i.missionKey)
    return false;
  if (i.kind === "accept" || i.kind === "decline") return offered.length === 1;
  if (active.length !== 1) return false;
  if (i.kind === "complete" || i.kind === "quit") return true;
  return (
    e.shipID === i.shipID &&
    e.stationID === i.stationID &&
    e.typeID === i.typeID &&
    e.cargoQuantity === i.cargoBefore &&
    e.hangarQuantity === i.hangarBefore &&
    e.sourceItem?.itemID === i.itemID &&
    e.sourceItem.typeID === i.typeID &&
    e.sourceItem.quantity === i.itemQuantity
  );
}
function validRow(row: DistributionFenceRow): boolean {
  return (
    !!row &&
    positive(row.accountID) &&
    positive(row.characterID) &&
    typeof row.runID === "string" &&
    !!row.runID &&
    typeof row.done === "boolean" &&
    typeof row.mutated === "boolean" &&
    (row.accepted === undefined || row.accepted === true) &&
    (row.mission === null ||
      (!!row.mission &&
        positive(row.mission.agentID) &&
        typeof row.mission.missionKey === "string" &&
        !!row.mission.missionKey)) &&
    (row.unloaded === undefined ||
      (row.unloaded?.kind === "unload" &&
        validIntent(row.unloaded) &&
        row.unloaded.agentID === row.mission?.agentID &&
        row.unloaded.missionKey === row.mission.missionKey)) &&
    (row.pending === null ||
      (!!row.pending &&
        typeof row.pending.acknowledged === "boolean" &&
        !!row.pending.intent &&
        validIntent(row.pending.intent))) &&
    !(row.done && row.pending !== null)
  );
}
function compactCompleted(row: DistributionFenceRow): DistributionFenceRow {
  const proof = row.completion;
  if (
    !row.done ||
    row.unloaded === undefined ||
    proof?.kind !== "missionCompletion" ||
    proof.completed !== true ||
    proof.runID !== row.runID ||
    proof.agentID !== row.mission?.agentID ||
    proof.missionKey !== row.mission.missionKey
  )
    return row;
  const { unloaded, ...result } = row;
  return result;
}

function verifyContinuation(
  row: DistributionFenceRow,
  mission: MissionContinuation,
  evidence: DistributionEvidence,
  runID: string,
  deferredTransfer = false,
): DistributionFenceRow {
  if (!sameAcceptedMission(mission, distributionAcceptedMission(row)))
    throw new CivilianMissionMismatch("The saved accepted Delivery mission no longer matches.");
  const { active, offered } = forAgent(evidence.journal, mission.agentID);
  const exact =
    active.length === 1 && active[0]?.missionKey === mission.key && offered.length === 0;
  const completed =
    !exact &&
    evidence.journal.completed?.some(
      (entry) => entry.agentID === mission.agentID && entry.missionKey === mission.key,
    );
  const intent = row.pending?.intent;
  if (intent?.kind === "complete") {
    if (completed || (row.pending?.acknowledged && active.length === 0 && offered.length === 0))
      return {
        ...row,
        done: true,
        pending: null,
        completion: completionReceipt({ ...intent, runnerID: runID }),
      };
    throw Error(
      "Delivery Complete was already sent, but its result is unconfirmed. It will not be sent again.",
    );
  }
  if (completed)
    throw new CivilianMissionCompleted(
      "The native journal confirms this Delivery mission was already completed.",
    );
  if (!exact)
    throw new CivilianMissionMismatch(
      "The saved Delivery mission is no longer accepted by this agent. It may have completed or expired.",
    );
  if (!intent) return row;
  if (deferredTransfer && (intent.kind === "load" || intent.kind === "unload")) return row;
  if ((intent.kind !== "load" && intent.kind !== "unload") || !matches(intent, evidence))
    throw Error(
      `The previous Delivery ${intent.kind} is still unconfirmed in native inventory. It will not be repeated.`,
    );
  return { ...row, pending: null, ...(intent.kind === "unload" ? { unloaded: intent } : {}) };
}
/** One backend process owns this journal. Unfinished records require native proof before continuation. */
export function createDistributionFence({
  filePath,
  storage,
}: {
  filePath?: string;
  storage?: { read(): unknown | null; write(value: unknown): void };
}) {
  if (!filePath && !storage) throw new Error("Distribution durable storage is required.");
  let records: Record<string, DistributionFenceRow> = {};
  let history: { row: DistributionFenceRow; oldRunStatus: "ended" | "not-listed" | "retired" }[] =
    [];
  try {
    const raw: unknown = storage ? storage.read() : JSON.parse(fs.readFileSync(filePath!, "utf8"));
    if (raw === null) return makeEmpty();
    if (
      !raw ||
      typeof raw !== "object" ||
      (raw as any).version !== 1 ||
      !(raw as any).records ||
      typeof (raw as any).records !== "object" ||
      Array.isArray((raw as any).records)
    )
      throw new Error("Invalid Distribution journal.");
    records = (raw as { records: Record<string, DistributionFenceRow> }).records;
    const savedHistory = (raw as any).history;
    if (savedHistory !== undefined && !Array.isArray(savedHistory))
      throw new Error("Invalid Distribution history.");
    history = savedHistory ?? [];
    for (const [key, row] of Object.entries(records))
      if (!validRow(row) || key !== `${row.accountID}:${row.characterID}`)
        throw new Error("Invalid Distribution journal record.");
    for (const entry of history)
      if (
        !entry ||
        typeof entry !== "object" ||
        !["ended", "not-listed", "retired"].includes(entry.oldRunStatus) ||
        !validRow(entry.row)
      )
        throw new Error("Invalid Distribution history.");
    records = Object.fromEntries(
      Object.entries(records).map(([key, row]) => [key, compactCompleted(row)]),
    );
    history = history.map((entry) => ({ ...entry, row: compactCompleted(entry.row) }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  function put(
    key: string,
    row: DistributionFenceRow,
    archive?: { row: DistributionFenceRow; oldRunStatus: "ended" | "not-listed" | "retired" },
  ) {
    const next = { ...records, [key]: clone(compactCompleted(row)) },
      nextHistory = archive ? [...history, clone(archive)] : history;
    if (storage) {
      storage.write({ version: 1, records: next, history: nextHistory });
      records = next;
      history = nextHistory;
      return;
    }
    fs.mkdirSync(path.dirname(filePath!), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`,
      fd = fs.openSync(temp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, records: next, history: nextHistory }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, filePath!);
    records = next;
    history = nextHistory;
  }
  return makeEmpty();
  function makeEmpty() {
    return {
      inspect(accountID: number, characterID: number) {
        const row = records[`${accountID}:${characterID}`];
        return row ? clone(row) : null;
      },
      completed(accountID: number, characterID: number, runID: string) {
        const current = records[`${accountID}:${characterID}`];
        return clone(
          [...history.map((entry) => entry.row), current].flatMap((row) =>
            row?.done &&
            row.accountID === accountID &&
            row.characterID === characterID &&
            row.runID === runID &&
            row.completion?.runID === runID
              ? [{ receipt: row.completion, reward: row.reward ?? null }]
              : [],
          ),
        );
      },
      recordReward({
        accountID,
        characterID,
        runID,
        current,
        receipt,
        reward,
      }: {
        accountID: number;
        characterID: number;
        runID: string;
        current: () => boolean;
        receipt: import("./progress.ts").DistributionCompletionReceipt;
        reward: import("../shared/rewards/index.ts").MissionRewardReadout;
      }) {
        const key = `${accountID}:${characterID}`,
          r = records[key];
        if (
          !current() ||
          !r ||
          r.runID !== runID ||
          !r.done ||
          r.pending !== null ||
          !r.completion ||
          JSON.stringify(r.completion) !== JSON.stringify(receipt) ||
          r.reward !== undefined
        )
          throw Error("Distribution reward does not match the exact completed receipt.");
        put(key, { ...r, reward });
      },
      continueMission({
        accountID,
        characterID,
        runID,
        current,
        journal,
        civilian,
        retainMission = false,
      }: {
        accountID: number;
        characterID: number;
        runID: string;
        current: () => boolean;
        journal: DistributionEvidence["journal"];
        civilian?: CivilianIndexRow;
        retainMission?: boolean;
      }) {
        const key = `${accountID}:${characterID}`,
          row = records[key];
        if (
          !positive(accountID) ||
          !positive(characterID) ||
          !runID ||
          !current() ||
          !row ||
          row.runID === runID ||
          row.done
        )
          throw new Error("A new held Distribution run is required.");
        const sameWorldAccount = row.civilian
          ? row.civilian.worldID === civilian?.worldID && row.civilian.owner === civilian.owner
          : !civilian;
        const intent = sameWorldAccount ? row.pending?.intent : null;
        // The new held run uses the ordinary native loop. The only historical
        // action that can affect its count is a sent Complete absent from the journal.
        const completion =
          intent?.kind === "complete" &&
          ![...journal.active, ...journal.offered].some(
            (entry) => entry.agentID === intent.agentID && entry.missionKey === intent.missionKey,
          )
            ? completionReceipt({ ...intent, runnerID: runID })
            : undefined;
        const mission = sameWorldAccount && retainMission ? row.mission : null;
        const matchesRow = (entry: { agentID: number; missionKey: string }) =>
          !!mission && entry.agentID === mission.agentID && entry.missionKey === mission.missionKey;
        const accepted = !!distributionAcceptedMission(row) && journal.active.some(matchesRow);
        const offered =
          !!mission &&
          row.mutated &&
          !row.accepted &&
          !row.pending &&
          journal.offered.some(matchesRow);
        put(
          key,
          {
            accountID,
            characterID,
            runID,
            civilian,
            done: !!completion,
            mutated: accepted || offered,
            mission: accepted || offered ? mission : null,
            pending: null,
            ...(accepted ? { accepted: true as const, acceptedAt: row.acceptedAt } : {}),
            ...(completion ? { completion } : {}),
          },
          { row, oldRunStatus: "retired" },
        );
        return lease(accountID, characterID, runID, current);
      },
      continueAccepted({
        accountID,
        characterID,
        runID,
        current,
        mission,
        evidence,
        civilian,
      }: {
        accountID: number;
        characterID: number;
        runID: string;
        current: () => boolean;
        mission: MissionContinuation;
        evidence: DistributionEvidence;
        civilian?: CivilianIndexRow;
      }) {
        const key = `${accountID}:${characterID}`,
          row = records[key];
        if (!current()) throw Error("The current Delivery owner is unavailable.");
        if (
          !row ||
          row.runID !== mission.botID ||
          row.runID === runID ||
          !row.civilian ||
          row.civilian.worldID !== civilian?.worldID ||
          row.civilian.owner !== civilian.owner
        )
          throw new CivilianMissionMismatch(
            "The original Delivery checkpoint no longer belongs to this pilot and account.",
          );
        if (row.done) {
          if (
            row.completion?.completed &&
            row.completion.agentID === mission.agentID &&
            row.completion.missionKey === mission.key
          )
            throw new CivilianMissionCompleted(
              "The agent already confirmed this Delivery mission.",
            );
          throw new CivilianMissionMismatch("The saved Delivery checkpoint has been retired.");
        }
        const verified = verifyContinuation(row, mission, evidence, runID, true);
        put(
          key,
          { ...verified, runID, civilian, accepted: true },
          { row, oldRunStatus: "retired" },
        );
        return lease(accountID, characterID, runID, current);
      },
      open({
        accountID,
        characterID,
        runID,
        current,
        resumed = false,
      }: {
        accountID: number;
        characterID: number;
        runID: string;
        current: () => boolean;
        resumed?: boolean;
      }) {
        if (!positive(accountID) || !positive(characterID) || !runID)
          throw new Error("Invalid Distribution custody.");
        const key = `${accountID}:${characterID}`,
          prior = records[key];
        if (resumed) {
          if (!current() || prior?.runID !== runID)
            throw new Error("The original Distribution journal owner changed.");
          return lease(accountID, characterID, runID, current);
        }
        if (prior && !prior.done)
          throw new Error(
            "RECOVERY_REQUIRED: An unfinished Distribution run needs reconciliation.",
          );
        const check = () => {
          if (current() !== true) throw new Error("Distribution custody changed.");
        };
        check();
        put(
          key,
          {
            accountID,
            characterID,
            runID,
            done: false,
            mutated: false,
            mission: null,
            pending: null,
          },
          prior ? { row: prior, oldRunStatus: "retired" } : undefined,
        );
        return lease(accountID, characterID, runID, current);
      },
    };
  }
  function lease(accountID: number, characterID: number, runID: string, current: () => boolean) {
    const key = `${accountID}:${characterID}`;
    const check = () => {
      if (current() !== true) throw new Error("Distribution custody changed.");
    };
    const row = () => {
      check();
      const r = records[key];
      if (!r || r.runID !== runID || r.done) throw new Error("Distribution run is stale.");
      return r;
    };
    function matchesUnacceptedOffer(
      r: DistributionFenceRow,
      intent: Extract<DistributionIntent, { kind: "decline" }>,
    ) {
      return (
        !r.accepted &&
        !r.unloaded &&
        r.mission?.agentID === intent.agentID &&
        r.mission.missionKey === intent.missionKey
      );
    }
    function settle(r: DistributionFenceRow, intent: DistributionIntent, e: DistributionEvidence) {
      const done = intent.kind === "complete",
        scoped = forAgent(e.journal, intent.agentID);
      const clearedOffer = intent.kind === "decline" && matchesUnacceptedOffer(r, intent);
      const mission = clearedOffer
        ? null
        : intent.kind === "request"
          ? { agentID: intent.agentID, missionKey: scoped.offered[0]!.missionKey }
          : intent.kind === "accept"
            ? { agentID: intent.agentID, missionKey: scoped.active[0]!.missionKey }
            : r.mission;
      put(key, {
        ...r,
        done,
        mission,
        pending: null,
        ...(clearedOffer ? { mutated: false } : {}),
        ...(intent.kind === "accept" ? { accepted: true as const } : {}),
        ...(intent.kind === "unload" ? { unloaded: intent } : {}),
        ...(done ? { completion: e.completed } : {}),
      });
    }
    return {
      read() {
        return clone(row());
      },
      annotateCivilian(civilian: CivilianIndexRow) {
        const r = row();
        if (
          civilian.characterID !== characterID ||
          civilian.botID !== runID ||
          civilian.kind !== "distribution" ||
          (r.civilian &&
            (r.civilian.worldID !== civilian.worldID || r.civilian.owner !== civilian.owner))
        )
          throw Error("Distribution owner provenance changed.");
        put(key, { ...r, civilian });
      },
      bindMission(agentID: number, missionKey: string) {
        const r = row();
        if (
          !positive(agentID) ||
          !missionKey ||
          (r.mission && (r.mission.agentID !== agentID || r.mission.missionKey !== missionKey))
        )
          throw new Error("RECOVERY_REQUIRED: Distribution mission changed.");
        if (!r.mission) put(key, { ...r, mission: { agentID, missionKey } });
      },
      leaveOffered(agentID: number, missionKey: string, evidence: DistributionEvidence) {
        const r = row(),
          intent = { kind: "decline" as const, agentID, missionKey };
        if (
          r.pending ||
          !matchesBefore(intent, evidence) ||
          (r.mission && !matchesUnacceptedOffer(r, intent))
        )
          throw Error(
            "RECOVERY_REQUIRED: The excluded courier offer is no longer an exact unaccepted mission.",
          );
        if (r.mission) put(key, { ...r, mission: null, mutated: false });
      },
      dispatch(intent: DistributionIntent, before: DistributionEvidence) {
        const r = row();
        if (intent.kind === "quit")
          throw Error("Civilian missions cannot quit an accepted mission.");
        if (
          r.pending ||
          !validIntent(intent) ||
          !matchesBefore(intent, before) ||
          (intent.kind === "request"
            ? r.mission !== null
            : intent.kind === "decline"
              ? !r.mutated || !matchesUnacceptedOffer(r, intent)
              : !r.mission ||
                r.mission.agentID !== intent.agentID ||
                r.mission.missionKey !== intent.missionKey)
        )
          throw new Error(
            "RECOVERY_REQUIRED: Distribution intent is unresolved or invalid; no replay.",
          );
        check();
        put(key, {
          ...r,
          mutated: r.mutated || intent.kind !== "decline",
          pending: { intent, acknowledged: false },
        });
      },
      refuse(before: DistributionEvidence) {
        const r = row(),
          intent = r.pending?.intent;
        if (
          !intent ||
          r.pending?.acknowledged ||
          !["request", "decline", "quit"].includes(intent.kind) ||
          !matchesBefore(intent, before)
        )
          throw Error(
            "RECOVERY_REQUIRED: Distribution refusal does not match current native state.",
          );
        put(key, { ...r, mutated: intent.kind === "request" ? false : r.mutated, pending: null });
      },
      abandonUntouched() {
        const r = row();
        if (r.mutated || r.pending || r.accepted)
          throw new Error("RECOVERY_REQUIRED: Distribution mission requires reconciliation.");
        check();
        put(key, { ...r, done: true, pending: null });
      },
      acknowledge(acceptedAt?: string) {
        const r = row();
        if (!r.pending || r.pending.acknowledged)
          throw new Error("Distribution intent is not dispatchable.");
        if (r.pending.intent.kind === "accept" && (!acceptedAt || !/^[1-9]\d*$/.test(acceptedAt)))
          throw Error("The Delivery acceptance time is missing.");
        check();
        put(key, {
          ...r,
          ...(acceptedAt ? { acceptedAt } : {}),
          pending: { ...r.pending, acknowledged: true },
        });
      },
      settle(e: DistributionEvidence) {
        const r = row(),
          intent = r.pending?.intent;
        if (!r.pending?.acknowledged || !intent || !matches(intent, e))
          throw new Error(
            "RECOVERY_REQUIRED: Distribution action lacks exact post-action evidence.",
          );
        settle(r, intent, e);
      },
      reconcile(e: DistributionEvidence, continuation?: MissionContinuation) {
        const r = row(),
          intent = r.pending?.intent;
        if (continuation) {
          const verified = verifyContinuation(r, continuation, e, runID);
          if (verified !== r) put(key, verified);
          return verified.completion ?? null;
        }
        if (intent?.kind === "accept" && (!r.pending?.acknowledged || !r.acceptedAt))
          throw Error("The previous Accept has no confirmed reply. Review this mission manually.");
        if (
          intent?.kind === "request" &&
          !r.pending?.acknowledged &&
          forAgent(e.journal, intent.agentID).offered.length
        )
          throw Error(
            "The previous Request has no confirmed reply. Review the outstanding offer manually.",
          );
        if (intent && intent.kind !== "complete" && matches(intent, e)) {
          settle(r, intent, e);
          return null;
        }
        const mission = r.mission ?? (intent && "missionKey" in intent ? intent : null);
        const matchesMission = (entry: { agentID: number; missionKey: string }) =>
          !!mission && entry.agentID === mission.agentID && entry.missionKey === mission.missionKey;
        // Older runs could bind an offered mission simply by reading the journal.
        const observedOffer = !r.mutated && e.journal.offered.some(matchesMission);
        const unowned =
          !intent &&
          (observedOffer ||
            (e.journal.active.some(matchesMission) &&
              (!distributionAcceptedMission(r) ||
                (e.acceptedAt !== undefined && e.acceptedAt !== r.acceptedAt))));
        if (
          mission &&
          (unowned || ![...e.journal.active, ...e.journal.offered].some(matchesMission))
        ) {
          // On hosted restart, disappearance after a sent Complete counts as a finished pass.
          const completion = intent?.kind === "complete" ? completionReceipt(intent) : undefined;
          put(key, {
            ...r,
            done: r.mission !== null,
            pending: null,
            ...(completion ? { completion } : {}),
          });
          return completion ?? null;
        }
        if (intent) {
          if (intent.kind !== "request" && !matchesBefore(intent, e))
            throw Error(
              `RECOVERY_REQUIRED: Dispatched ${intent.kind} at agent ${intent.agentID} does not match current mission or inventory.`,
            );
          put(key, { ...r, pending: null });
        }
        return null;
      },
    };
  }
}
