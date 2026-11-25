import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { unwrapLong } from "../shared/wire.ts";

type Live = PilotSession["store"]["live"];
export interface SiteIdentity {
  characterID: number;
  shipID: number;
  systemID: number;
  dungeonID: number;
  instanceID: number;
  roomID: number;
}
export interface SiteOwnerScope {
  operationID: string;
  operationRunID: string;
  botID: string;
  sessionGeneration: number;
}
export interface SiteKeeper {
  dungeonID: number;
  instanceID: number;
  roomID: number;
}
export interface SiteCompletionReceipt {
  source: "native-dungeon-completed";
  scope: SiteOwnerScope;
  site: SiteIdentity;
  baseline: { epoch: string; sequence: number; observedAt: number };
  event: {
    epoch: string;
    sequence: number;
    method: "OnDungeonCompleted";
    args: readonly unknown[];
    receivedAtMs: number;
  };
  keeperBefore: { value: SiteKeeper; observedAt: number };
  keeperAfter: { value: SiteKeeper; observedAt: number };
}
export type SiteCompletionResult =
  | { state: "pending" }
  | { state: "unknown"; reason: string }
  | { state: "confirmed"; receipt: SiteCompletionReceipt };
export interface SiteCompletionDependencies {
  live: Live;
  scope: SiteOwnerScope;
  site: SiteIdentity;
  assertCurrent(): void;
  readKeeper(): Promise<SiteKeeper | null>;
  saveReceipt(receipt: SiteCompletionReceipt): void;
  now?: () => number;
}
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const same = (k: SiteKeeper | null, s: SiteIdentity) =>
  !!k && k.dungeonID === s.dungeonID && k.instanceID === s.instanceID && k.roomID === s.roomID;
const dungeonArg = (value: unknown) => {
  const n = unwrapLong(value);
  return n !== null && n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
};
/** Subscribe before entry; caller must fence movement/session for the entire observed site. */
export function createSiteCompletionObserver(deps: SiteCompletionDependencies) {
  const site = structuredClone(deps.site),
    scope = structuredClone(deps.scope),
    live = deps.live,
    now = deps.now ?? Date.now;
  if (
    ![scope.operationID, scope.operationRunID, scope.botID].every(
      (s) => typeof s === "string" && s.trim().length > 0 && s.length <= 200,
    ) ||
    !Number.isSafeInteger(scope.sessionGeneration) ||
    scope.sessionGeneration < 0
  )
    throw Error("Site owner scope is invalid.");
  if (
    !positive(site.characterID) ||
    !positive(site.shipID) ||
    !positive(site.systemID) ||
    !positive(site.dungeonID) ||
    !positive(site.instanceID) ||
    !Number.isSafeInteger(site.roomID) ||
    site.roomID < 0
  )
    throw Error("Site identity is invalid.");
  let armedSequence: number | null = null,
    prior = live.get(),
    baseline: SiteCompletionReceipt["baseline"] | null = null,
    before: SiteCompletionReceipt["keeperBefore"] | null = null,
    seen: SiteCompletionReceipt["event"] | null = null,
    reason: string | null = null,
    receipt: SiteCompletionReceipt | null = null,
    closed = false,
    checking: Promise<SiteCompletionResult> | null = null;
  function fail(message: string) {
    reason ??= message;
  }
  const unsubscribe = live.subscribe((next) => {
    if (closed) return;
    const previous = prior;
    prior = next;
    if (!baseline || reason || receipt) return;
    try {
      deps.assertCurrent();
      if (next.status !== "live") return fail("The live notification channel lost continuity.");
      if (next.epoch !== baseline.epoch) return fail("The notification epoch changed.");
      if (
        !Number.isSafeInteger(next.sequence) ||
        next.sequence < baseline.sequence ||
        next.sequence < previous.sequence
      )
        return fail("The notification cursor moved backwards.");
      if (next.notifications !== previous.notifications) {
        if (next.notifications.length === 0)
          return fail("The live notification history was reset.");
        const was = previous.notifications,
          overlap = Math.min(was.length, 49);
        if (
          next.notifications.length !== overlap + 1 ||
          was.slice(was.length - overlap).some((n, i) => next.notifications[i] !== n)
        )
          return fail("The live notification tail has a gap.");
        const n = next.notifications.at(-1);
        if (!n) return fail("The live notification is unreadable.");
        if (next.sequence <= previous.sequence)
          return fail("The notification cursor did not advance.");
        if (
          before &&
          armedSequence !== null &&
          next.sequence > armedSequence &&
          n.method === "OnDungeonCompleted" &&
          n.args.length === 1 &&
          dungeonArg(n.args[0]) === site.dungeonID
        ) {
          if (!Number.isFinite(n.receivedAtMs) || n.receivedAtMs < before.observedAt)
            return fail("The completion notification time is invalid.");
          seen = {
            epoch: baseline.epoch,
            sequence: next.sequence,
            method: "OnDungeonCompleted",
            args: structuredClone(n.args),
            receivedAtMs: n.receivedAtMs,
          };
        }
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });
  return {
    begin() {
      if (closed || baseline || reason) throw Error("Site observer cannot start.");
      deps.assertCurrent();
      const first = live.get();
      if (
        first.status !== "live" ||
        typeof first.epoch !== "string" ||
        !first.epoch ||
        !Number.isSafeInteger(first.sequence) ||
        first.sequence < 0
      )
        throw Error("A live notification baseline is unavailable.");
      const observedAt = now();
      if (!Number.isFinite(observedAt)) throw Error("Site observation time is invalid.");
      baseline = { epoch: first.epoch, sequence: first.sequence, observedAt };
      prior = first;
    },
    async arm() {
      if (closed || !baseline || before || reason) throw Error("Site observer cannot be armed.");
      deps.assertCurrent();
      const value = await deps.readKeeper();
      deps.assertCurrent();
      const last = live.get();
      if (
        reason ||
        last.status !== "live" ||
        last.epoch !== baseline.epoch ||
        last.sequence < baseline.sequence ||
        !same(value, site)
      )
        throw Error("Exact native site and notification baseline are unavailable.");
      const observedAt = now();
      if (!Number.isFinite(observedAt)) throw Error("Site observation time is invalid.");
      before = { value: structuredClone(value!), observedAt };
      armedSequence = last.sequence;
      prior = last;
    },
    check(): Promise<SiteCompletionResult> {
      if (checking) return checking;
      checking = (async () => {
        if (receipt) {
          try {
            if (closed) throw Error("The live notification observer is closed.");
            deps.assertCurrent();
            return { state: "confirmed", receipt: structuredClone(receipt) } as const;
          } catch (error) {
            return {
              state: "unknown",
              reason: error instanceof Error ? error.message : String(error),
            } as const;
          }
        }
        if (reason) return { state: "unknown", reason } as const;
        if (!baseline || !before || !seen) return { state: "pending" } as const;
        try {
          deps.assertCurrent();
          const value = await deps.readKeeper();
          deps.assertCurrent();
          if (reason) throw Error(reason);
          const last = live.get();
          if (
            last.status !== "live" ||
            last.epoch !== baseline.epoch ||
            last.sequence < seen.sequence ||
            !same(value, site)
          )
            throw Error("Exact site or continuous live channel cannot be verified.");
          const afterAt = now();
          if (!Number.isFinite(afterAt)) throw Error("Site observation time is invalid.");
          const candidate: SiteCompletionReceipt = {
            source: "native-dungeon-completed",
            scope: structuredClone(scope),
            site: structuredClone(site),
            baseline: structuredClone(baseline),
            event: structuredClone(seen),
            keeperBefore: structuredClone(before),
            keeperAfter: { value: structuredClone(value!), observedAt: afterAt },
          };
          deps.saveReceipt(structuredClone(candidate));
          receipt = structuredClone(candidate);
          return { state: "confirmed", receipt: structuredClone(receipt) } as const;
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
          return { state: "unknown", reason: reason! } as const;
        }
      })().finally(() => {
        checking = null;
      });
      return checking;
    },
    close() {
      if (!receipt) fail("The live notification observer was closed before confirmation.");
      closed = true;
      unsubscribe();
    },
  };
}
