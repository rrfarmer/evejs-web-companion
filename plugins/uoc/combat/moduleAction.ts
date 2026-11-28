import { targetNotLockedRefusal } from "../mining/activation.ts";
import type { SecurityStorage } from "./journal.ts";

/** One module command in one exact room and target generation. A new generation
 * must have a new key; a transport failure never authorizes another dispatch. */
export interface CombatModuleAction {
  key: string;
  characterID: number;
  shipID: number;
  moduleID: number;
  typeID: number;
  targetID: number | null;
  kind: "weapon" | "local-defense" | "remote-repair";
}
type Entry = {
  action: CombatModuleAction;
  status:
    | "DISPATCHED"
    | "ACKNOWLEDGED"
    | "CONFIRMED"
    | "LOCK_REFUSED"
    | "REFUSED"
    | "SETTLED_ABSENT"
    | "SETTLED_INACTIVE";
  issuedAt: number;
  refusalReason?: string;
};
type Doc = { version: 1; entries: Entry[] };
export interface CombatModuleActionDeps {
  document: SecurityStorage;
  current(): void;
  /** Revalidates the room, selected NPC or selected fleet recipient immediately before the native write. */
  fence(action: CombatModuleAction): Promise<void>;
  /** Must read the exact module's native ItemGetInfo; ACK is not evidence of an effect. */
  observed(action: CombatModuleAction): Promise<boolean>;
  activate(action: CombatModuleAction): Promise<unknown>;
  /** After an ACK only: same room, fresh absence and this module physically inactive. */
  targetAbsent?(action: CombatModuleAction, error: unknown): Promise<boolean>;
  /** Defender weapons reconcile on the next normal module observation. */
  observeWeapon?(action: CombatModuleAction): Promise<"active" | "inactive" | null>;
  /** Receipt writes after a native answer only require the original held owner. */
  receiptCurrent?(): void;
  reacquireLock?: boolean;
  optionalRefusal?(error: unknown): string | null;
  sleep(ms: number): Promise<void>;
  now(): number;
}
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export function alreadyActiveRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const refusal = error as {
    code?: string;
    status?: number;
    refusal?: { key?: string };
    message?: string;
  };
  return (
    refusal.code === "CALL_REFUSED" &&
    refusal.status === 409 &&
    (refusal.refusal?.key === "EffectAlreadyActive2" ||
      refusal.message === "EffectAlreadyActive2" ||
      refusal.message?.endsWith(": EffectAlreadyActive2") === true)
  );
}
const same = (a: CombatModuleAction, b: CombatModuleAction) =>
  JSON.stringify(a) === JSON.stringify(b);
function valid(a: CombatModuleAction) {
  return (
    typeof a.key === "string" &&
    a.key.length > 0 &&
    [a.characterID, a.shipID, a.moduleID, a.typeID].every(positive) &&
    (a.targetID === null || positive(a.targetID)) &&
    ["weapon", "local-defense", "remote-repair"].includes(a.kind) &&
    (a.kind === "local-defense" ? a.targetID === null : a.targetID !== null)
  );
}

/** The caller owns target selection, locking and module settlement. This helper
 * only journals and confirms a single action; it is not another combat loop. */
export async function executeCombatModuleAction(
  action: CombatModuleAction,
  d: CombatModuleActionDeps,
): Promise<
  void | "target-absent" | "lock-lost" | "already-active" | "inactive" | "unavailable" | "pending"
> {
  if (!valid(action)) throw Error("Combat module action identity is incomplete.");
  const observeWeapon = d.observeWeapon;
  const load = () => {
    const x = d.document.read(),
      doc = x === null ? { version: 1 as const, entries: [] as Entry[] } : (x as Doc);
    if (!doc || doc.version !== 1 || !Array.isArray(doc.entries))
      throw Error("Combat module journal is unreadable; custody retained.");
    const entries = observeWeapon
      ? doc.entries.filter(
          (row) => row?.action?.key === action.key || row?.action?.moduleID === action.moduleID,
        )
      : doc.entries;
    if (
      entries.some(
        (e) =>
          !e?.action ||
          !valid(e.action) ||
          ![
            "DISPATCHED",
            "ACKNOWLEDGED",
            "CONFIRMED",
            "LOCK_REFUSED",
            "REFUSED",
            "SETTLED_ABSENT",
            "SETTLED_INACTIVE",
          ].includes(e.status) ||
          !Number.isSafeInteger(e.issuedAt),
      ) ||
      new Set(entries.map((e) => e.action.key)).size !== entries.length
    )
      throw Error("Combat module journal is unreadable; custody retained.");
    return { doc, entries };
  };
  const save = (entry: Entry) => {
    const { doc } = load(),
      i = doc.entries.findIndex((e) => e?.action?.key === entry.action.key);
    if (i >= 0 && !same(doc.entries[i]!.action, entry.action))
      throw Error("Combat module action key has a different identity.");
    if (i < 0) doc.entries.push(entry);
    else doc.entries[i] = entry;
    d.document.write(doc);
  };
  const settleWeapon = async (entry: Entry) => {
    const effect = await observeWeapon!(entry.action);
    d.current();
    if (effect === "active") {
      save({ ...entry, status: "CONFIRMED" });
      return;
    }
    // The next native read may show that an acknowledged activation ended
    // between samples. Inactivity alone cannot settle a lost write response.
    if (effect === "inactive" && entry.status === "ACKNOWLEDGED") {
      save({ ...entry, status: "SETTLED_INACTIVE" });
      return "inactive" as const;
    }
    return "pending" as const;
  };
  d.current();
  const { entries } = load(),
    previous = entries.find((e) => e.action.key === action.key);
  if (previous && !same(previous.action, action))
    throw Error("Combat module action key has a different identity.");
  const otherPending = entries.find(
    (e) =>
      e.action.moduleID === action.moduleID &&
      e.action.key !== action.key &&
      (e.status === "DISPATCHED" || e.status === "ACKNOWLEDGED"),
  );
  if (otherPending) {
    if (!observeWeapon)
      throw Error("Another command for this module remains unresolved; custody retained.");
    if ((await settleWeapon(otherPending)) !== "inactive") return "pending";
  }
  if (previous?.status === "CONFIRMED") {
    if (d.reacquireLock && !(await d.observed(action))) return "inactive";
    return;
  }
  if (previous?.status === "SETTLED_ABSENT") return "target-absent";
  if (previous?.status === "SETTLED_INACTIVE") return "inactive";
  // A prior invocation may have lost the original lock's custody. Even a
  // definite refusal is retried only inside the invocation that owns that lock.
  if (previous?.status === "LOCK_REFUSED") {
    if (d.reacquireLock) return "lock-lost";
    throw Error("Original target lock invocation ended; no activation replay.");
  }
  if (previous?.status === "REFUSED") {
    if (previous.refusalReason) return "unavailable";
    if (d.reacquireLock) return "already-active";
    throw Error("Original combat module activation was refused.");
  }
  const receiptCurrent = d.receiptCurrent ?? d.current;
  if (previous) {
    if (observeWeapon) return settleWeapon(previous);
    await d.fence(action);
    d.current();
    if (await d.observed(action)) {
      d.current();
      save({ ...previous, status: "CONFIRMED" });
      return;
    }
    throw Error("Combat module dispatch remains unresolved; no replay.");
  }
  const deadline = d.now() + 200_000;
  for (let attempts = 0; attempts <= 100; attempts++) {
    d.current();
    if (!observeWeapon) await d.fence(action);
    d.current();
    if (await d.observed(action)) {
      d.current();
      save({ action, status: "CONFIRMED", issuedAt: d.now() });
      return;
    }
    if (observeWeapon) await d.fence(action);
    d.current();
    const entry: Entry = { action, status: "DISPATCHED", issuedAt: d.now() };
    save(entry);
    d.current();
    try {
      await d.activate(action);
    } catch (error) {
      if (alreadyActiveRefusal(error)) {
        receiptCurrent();
        save({ ...entry, status: "REFUSED" });
        if (await d.observed(action)) {
          receiptCurrent();
          save({ ...entry, status: "CONFIRMED" });
          return;
        }
        if (d.reacquireLock) return "already-active";
        throw error;
      }
      if (action.targetID !== null && targetNotLockedRefusal(error)) {
        receiptCurrent();
        save({ ...entry, status: "LOCK_REFUSED" });
        if (d.reacquireLock) return "lock-lost";
        if (d.now() >= deadline) throw Error("Original target lock did not become usable.");
        await d.sleep(Math.min(2000, deadline - d.now()));
        continue;
      }
      const refusalReason = d.optionalRefusal?.(error);
      if (refusalReason) {
        receiptCurrent();
        save({ ...entry, status: "REFUSED", refusalReason });
        return "unavailable";
      }
      if (observeWeapon) {
        d.current();
        return "pending";
      }
      throw error;
    }
    const acknowledged: Entry = { ...entry, status: "ACKNOWLEDGED" };
    receiptCurrent();
    save(acknowledged);
    if (observeWeapon) return "pending";
    const observationDeadline = d.now() + 90_000;
    for (let reads = 0; reads <= 90; reads++) {
      d.current();
      try {
        await d.fence(action);
      } catch (error) {
        d.current();
        if (d.targetAbsent && (await d.targetAbsent(action, error))) {
          d.current();
          save({ ...entry, status: "SETTLED_ABSENT" });
          return "target-absent";
        }
        throw error;
      }
      d.current();
      if (await d.observed(action)) {
        d.current();
        save({ ...entry, status: "CONFIRMED" });
        return;
      }
      if (d.now() >= observationDeadline) break;
      await d.sleep(1000);
    }
    throw Error("Combat module effect was not observed; no replay.");
  }
  throw Error("Original target lock did not become usable.");
}
