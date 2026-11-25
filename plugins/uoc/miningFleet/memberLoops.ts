import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { haulOwner, type createOperation, type ManifestItem, type Manifest } from "./operation.ts";
import type { Claim, Target } from "./targetBoard.ts";
import { fleetReadFailed, FleetObservationUnavailable } from "./stopSignal.ts";
import type { MiningReadiness } from "./nativeBelt.ts";
import { bridgeCallQueueTimeout, transientNativeRead } from "../shared/progressDeadline.ts";
import type { MccTiming } from "./timing.ts";

type Operation = ReturnType<typeof createOperation>;
type Source = import("./operation.ts").JetcanSource;
type Facts = Parameters<Operation["prepareJetcan"]>[3];
type Delivery = Parameters<Operation["markDelivered"]>[1];
type FreightAdmission = (items: readonly ManifestItem[]) => Promise<boolean>;
type JettisonSelection = {
  holdObservedAtMs: number;
  selectedAtMs: number;
  sceneSampledAtMs: number | null;
  holdUsedM3?: number;
  holdCapacityM3?: number;
};
export class FreightGridUnavailable extends Error {}
export class GlobalLootClaimHeld extends FreightGridUnavailable {}
export class HaulStoppedBeforePickup extends Error {
  constructor() {
    super("Stop ended the haul before the next pickup.");
  }
}
export interface RawHoldObservation {
  readonly source: Source;
  readonly items: readonly ManifestItem[];
  readonly facts: Facts;
  readonly capacityM3: number;
  readonly existingContainerIDs: readonly number[];
  readonly sceneSampledAt: number;
  readonly miningContinues?: true;
}
export interface RawCanObservation {
  readonly containerID: number;
  readonly ownerID: number;
  readonly shipID: number;
  readonly systemID: number;
  readonly targetKey: string;
  readonly claimGeneration: number;
  readonly observedAt: number;
  readonly items: readonly ManifestItem[];
  readonly sourceAfter: Source;
}
/** Native implementations must reject incomplete or malformed source/scene rows, not project them away. */
export interface RawMinerNative {
  current(): void;
  navigate(
    target: Target,
    claim: Claim,
    onArrival?: (observed: MiningReadiness) => void,
  ): Promise<void>;
  mineCycle(
    target: Target,
    claim: Claim,
    jettisonReady?: boolean,
    arrival?: MiningReadiness,
    jettison?: (items: readonly ManifestItem[], selection?: JettisonSelection) => Promise<boolean>,
  ): Promise<"yield" | "hold-full" | "blocked" | "depleted">;
  observeHolds(target: Target, claim: Claim, flush?: boolean): Promise<RawHoldObservation>;
  holdEmpty?(): Promise<boolean>;
  jettison(itemIDs: readonly number[], selection?: JettisonSelection): Promise<void>;
  observeCreatedCan(
    before: RawHoldObservation,
    target: Target,
    claim: Claim,
  ): Promise<RawCanObservation>;
}
export interface HaulWork {
  manifest: Manifest;
  generation: number;
  dispatched: boolean;
  target: Target;
  claim: Claim;
  dispatch(): boolean;
  waitForMore(): boolean;
  cancel(): void;
  closePickup(): void;
  missing(): void;
  complete(proof: Delivery): void;
}
export type PickupGridObservation = { grid: MiningReadiness["space"]; observedAt: number };
export interface RawHaulerNative {
  haulTrip?(
    owned: readonly HaulWork[],
    next: (
      eligible: (manifest: Manifest) => Promise<boolean>,
      rank?: (manifests: readonly Manifest[]) => Promise<readonly Manifest[]>,
    ) => Promise<HaulWork | null>,
    destinationID: number,
    collectingFinalFreight?: boolean,
  ): Promise<"idle" | "waiting" | "missing" | "delivered">;
  waitAtBelt?(
    target: Target,
    claim: Claim,
    current: () => void,
  ): Promise<PickupGridObservation | void>;
  observeGridJetcans?(
    target: Target,
    claim: Claim,
    excluded: ReadonlySet<number>,
    pendingOwners: ReadonlySet<number>,
    available: (canID: number, ownerID: number) => boolean,
    publish: (can: import("./operation.ts").GridJetcan) => unknown,
    final?: boolean,
    arrival?: PickupGridObservation | void,
  ): Promise<void>;
  reconcileReturnHome?(
    manifest: Manifest,
    haulGeneration: number,
    destinationID: number,
  ): Promise<void>;
  hasPendingOwnFreight?(): boolean;
  hasUnfinishedOwnFreight?(): boolean;
  unloadInitialFreight?(destinationID: number): Promise<boolean>;
  reconcileOwnFreight?(destinationID: number): Promise<void>;
  getFreightStatus?: () => import("./freightPolicy.ts").FreightStatus | null;
  canCarryFreight?(items: readonly ManifestItem[]): Promise<boolean>;
  current(): void;
  /** Must verify exact claimed can, its full raw manifest, and ship capacity before returning. */
  navigateAndVerify(
    manifest: Manifest,
    target: Target,
    claim: Claim,
    allowMissing?: boolean,
  ): Promise<void | "missing">;
  /** One bounded freight transaction; uncertainty is retained and never automatically retried. */
  transferAndDeliver(
    manifest: Manifest,
    haulGeneration: number,
    destinationID: number,
  ): Promise<Delivery>;
  /** Read-only reconciliation first; must never issue another pickup for dispatched custody. */
  recoverHeldAndDeliver?(
    manifest: Manifest,
    haulGeneration: number,
    destinationID: number,
  ): Promise<Delivery>;
}
/** A member's mining or hauling work has one turn at a time. */
export function createRawMembers(op: Operation) {
  const active = new Set<number>();
  const cooldownUntil = new Map<number, number>();
  const lastUnansweredDrop = new Map<number, readonly ManifestItem[]>();
  async function serial<T>(id: number, work: () => Promise<T>): Promise<T> {
    if (active.has(id)) throw Error("Member step is already active.");
    active.add(id);
    try {
      return await work();
    } finally {
      active.delete(id);
    }
  }
  async function publishCan(
    characterID: number,
    shipID: number,
    native: RawMinerNative,
    before: RawHoldObservation,
    target: Target,
    claim: Claim,
    generation: number,
  ) {
    const can = await native.observeCreatedCan(before, target, claim).catch((error) => {
      native.current();
      const reason =
        "Jettison " +
        generation +
        ": " +
        (error instanceof Error ? error.message : String(error)) +
        " No replay.";
      if (error instanceof FleetObservationUnavailable)
        throw new FleetObservationUnavailable(reason, { cause: error });
      const { code, status } = (error as { code?: unknown; status?: unknown } | null) ?? {};
      return fleetReadFailed(Object.assign(Error(reason, { cause: error }), { code, status }));
    });
    native.current();
    if (
      before.existingContainerIDs.includes(can.containerID) ||
      can.ownerID !== characterID ||
      can.shipID !== shipID ||
      can.systemID !== target.systemID ||
      can.targetKey !== claim.key ||
      can.claimGeneration !== claim.generation ||
      can.observedAt < before.source.observedAt ||
      can.sourceAfter.source !== "checked-ship-holds" ||
      can.sourceAfter.characterID !== characterID ||
      can.sourceAfter.shipID !== shipID ||
      can.sourceAfter.systemID !== target.systemID ||
      can.sourceAfter.targetKey !== claim.key ||
      can.sourceAfter.claimGeneration !== claim.generation ||
      can.sourceAfter.observedAt < before.source.observedAt ||
      before.items.some((i) => can.sourceAfter.items.some((row) => row.itemID === i.itemID))
    )
      throw Error(
        "Created can identity or source removal is uncertain; reconciliation is required.",
      );
    if (
      !op.registerJetcan(
        {
          source: "native-jetcan",
          operationID: claim.operationID,
          runID: claim.runID,
          targetKey: claim.key,
          claimGeneration: claim.generation,
          characterID,
          shipID: shipID,
          systemID: target.systemID,
          containerID: can.containerID,
          intentGeneration: generation,
          observedAt: can.observedAt,
          items: can.items,
          capacityM3: before.capacityM3,
        },
        before.facts,
      )
    )
      throw Error("Created can manifest is uncertain; reconciliation is required.");
    return "published" as const;
  }
  async function mineStep(
    characterID: number,
    native: RawMinerNative,
    flush: boolean,
    canPublish: boolean | FreightAdmission = true,
  ) {
    return serial(characterID, async () => {
      native.current();
      let a = op.assignment(characterID);
      if (
        !a ||
        !(
          a.member.role === "MINER" ||
          (a.member.role === "COMMAND" && op.snapshot().commandCapabilities?.selfMining)
        ) ||
        !a.targetGranted ||
        !a.claim ||
        !a.target
      )
        return "idle" as const;
      const { claim, target } = a;
      const miner = a.member.role === "MINER";
      const stopJettison = () => op.jettisonStopped(characterID);
      const retained = op.snapshot().jetcanIntents[String(characterID)];
      if (retained?.dispatched) {
        if (!retained.before)
          throw Error("Original Jettison has no pre-dispatch scene evidence; no replay.");
        return publishCan(
          characterID,
          a.member.shipID,
          native,
          retained.before,
          target,
          claim,
          retained.generation,
        );
      }
      if (retained && !op.cancelPreparedJetcan(characterID, retained.generation))
        throw Error("Prepared Jettison could not be canceled before dispatch.");
      if (stopJettison()) return "empty" as const;
      if (flush && op.jetcanCooldownRemaining(characterID) > 0) {
        const empty = await native.holdEmpty?.().catch(fleetReadFailed);
        native.current();
        return empty || stopJettison() ? ("empty" as const) : ("waiting" as const);
      }
      let arrival: MiningReadiness | undefined;
      await native.navigate(
        target,
        claim,
        flush
          ? undefined
          : (observed) => {
              arrival = observed;
            },
      );
      native.current();
      a = op.assignment(characterID);
      if (!a?.targetGranted || a.claim?.generation !== claim.generation) return "idle" as const;
      if (miner && stopJettison()) return "empty" as const;
      if (miner && !flush) {
        const ready =
          Date.now() >= (cooldownUntil.get(characterID) ?? 0) &&
          op.jetcanCooldownRemaining(characterID) <= 0;
        return native.mineCycle(target, claim, ready, arrival, async (items, selection) => {
          native.current();
          if (!op.minerMayJettison(claim)) return false;
          const previous = lastUnansweredDrop.get(characterID);
          lastUnansweredDrop.delete(characterID);
          // Give the first unchanged read after a lost answer to mining. A later turn
          // can try its own fresh hold even if the first request never reached EveJS.
          if (
            previous?.length === items.length &&
            items.every((item) =>
              previous.some(
                (row) =>
                  row.itemID === item.itemID &&
                  row.typeID === item.typeID &&
                  row.quantity === item.quantity,
              ),
            )
          )
            return false;
          const at = Date.now();
          try {
            await native.jettison(
              items.map((item) => item.itemID),
              selection,
            );
          } catch (error) {
            native.current();
            if (bridgeCallQueueTimeout(error)) return false;
            if (jettisonCooldownRefusal(error)) cooldownUntil.set(characterID, at + 180_000);
            else if (
              transientNativeRead(error) ||
              ["BRIDGE_NETWORK_ERROR", "BRIDGE_BAD_RESPONSE", "ECONNRESET"].includes(
                String((error as { code?: unknown } | null)?.code),
              )
            )
              lastUnansweredDrop.set(characterID, items);
            else throw error;
            return true;
          }
          cooldownUntil.set(characterID, at + 180_000);
          return true;
        });
      }
      if (!flush) {
        const jettisonReady = op.jetcanCooldownRemaining(characterID) <= 0;
        const result = await native.mineCycle(target, claim, jettisonReady, arrival);
        native.current();
        if (result !== "hold-full") return result;
        if (!jettisonReady) return "waiting" as const;
      }
      const before = await native.observeHolds(target, claim, flush).catch(fleetReadFailed);
      native.current();
      if (stopJettison()) return "empty" as const;
      if (!before.items.length && flush) return "empty" as const;
      if (flush && typeof canPublish === "function") {
        if (!(await canPublish(before.items))) return "empty" as const;
        native.current();
        if (stopJettison()) return "empty" as const;
      }
      if (flush && canPublish === false)
        throw Error(
          "No original hauler is available for a new Jettison. Keep this ore aboard and reconcile it at the original delivery dock.",
        );
      if (
        !before.items.length ||
        before.items.some((i) => i.freightKind !== before.items[0]!.freightKind) ||
        new Set(before.existingContainerIDs).size !== before.existingContainerIDs.length
      )
        throw Error("Unverified raw hold or scene.");
      const intent = op.prepareJetcan(
        characterID,
        before.items,
        before.capacityM3,
        before.facts,
        before.source,
        before,
      );
      if (!intent) throw Error("Raw jetcan preparation refused.");
      try {
        native.current();
      } catch (error) {
        op.cancelPreparedJetcan(characterID, intent.generation);
        throw error;
      }
      if (!op.dispatchJetcan(characterID, intent.generation)) {
        op.cancelPreparedJetcan(characterID, intent.generation);
        return "idle" as const;
      }
      try {
        await native.jettison(before.items.map((i) => i.itemID));
      } catch (error) {
        native.current();
        if (jettisonCooldownRefusal(error)) {
          if (!op.refuseJetcanCooldown(characterID, intent.generation))
            throw Error("Native cooldown receipt could not be recorded.");
          return miner && stopJettison() ? ("empty" as const) : ("waiting" as const);
        }
        // A lost response may have created the can. Only the original source and
        // destination observations can publish it; never issue another Jettison.
      }
      native.current();
      return publishCan(
        characterID,
        a.member.shipID,
        native,
        intent.before ?? before,
        target,
        claim,
        intent.generation,
      );
    });
  }
  async function discover(
    characterID: number,
    native: RawHaulerNative,
    final = false,
    collect?: (containerID: number) => Promise<void>,
    selectedSite?: { target: Target; claim: Claim },
  ) {
    const assignment = selectedSite ? null : op.assignment(characterID);
    const site =
      selectedSite ??
      (assignment?.targetGranted && assignment.target && assignment.claim
        ? { target: assignment.target, claim: assignment.claim }
        : null);
    if (!site || !native.waitAtBelt) return;
    const { target, claim } = site;
    const check = () => {
      native.current();
      if (op.canDiscoverGridFreight(characterID, claim, final)) return;
      if (op.snapshot().stopRequested) throw new HaulStoppedBeforePickup();
      throw new FreightGridUnavailable(
        "The freight scan is no longer current. Rechecking the assigned pickup grid.",
      );
    };
    check();
    const arrival = await native.waitAtBelt(target, claim, check);
    check();
    const state = op.snapshot();
    const excluded = new Set(state.manifests.map((m) => m.containerID));
    const currentSite = (snapshot: typeof state) =>
      snapshot.claim?.key === claim.key && snapshot.claim.generation === claim.generation;
    const pendingOwners = new Set(
      currentSite(state)
        ? Object.entries(state.jetcanIntents)
            .filter(([, i]) => i.dispatched)
            .map(([id]) => Number(id))
        : [],
    );
    const available = (canID: number, ownerID: number) => {
      const row = op.snapshot();
      return (
        op.canDiscoverGridFreight(characterID, claim, final) &&
        !row.manifests.some((m) => m.containerID === canID) &&
        (!currentSite(row) || !row.jetcanIntents[String(ownerID)]?.dispatched)
      );
    };
    await native.observeGridJetcans?.(
      target,
      claim,
      excluded,
      pendingOwners,
      available,
      (can) => {
        if (op.registerGridJetcan(characterID, claim, can, final))
          return collect?.(can.containerID);
      },
      final,
      arrival,
    );
    check();
  }
  async function hauler(
    characterID: number,
    native: RawHaulerNative,
    choose?: (characterID: number, manifests: readonly Manifest[]) => Promise<number | null>,
    finalFreightReady = false,
  ) {
    return serial(characterID, async () => {
      native.current();
      const snapshot = op.snapshot(),
        claims = snapshot.haulClaims;
      if (
        snapshot.stopFreight === "RETURN_HOME" &&
        snapshot.members.some((m) => m.characterID === characterID && m.role === "HAULER")
      ) {
        await native.reconcileOwnFreight?.(snapshot.destinationID);
        native.current();
        for (const manifest of snapshot.manifests) {
          const claim = haulOwner(snapshot, manifest),
            container = manifest.containerID;
          if (manifest.delivered || claim?.characterID !== characterID || !claim.dispatched)
            continue;
          if (!native.reconcileReturnHome)
            throw Error(
              `Cannot verify the retained transfer for can ${container} before Return Home.`,
            );
          await native.reconcileReturnHome(manifest, claim.generation, snapshot.destinationID);
          native.current();
          if (!op.stopRemainingHaul(characterID, manifest.containerID, claim.generation))
            throw Error(
              `The retained freight claim for can ${container} changed during Return Home.`,
            );
        }
        return "idle" as const;
      }
      const a = op.assignment(characterID);
      if (
        !a ||
        !(
          a.member.role === "HAULER" ||
          (a.member.role === "COMMAND" && snapshot.commandCapabilities?.collect)
        )
      )
        return "idle" as const;
      const finishingOwnFreight = a.member.role === "HAULER" && native.hasUnfinishedOwnFreight?.();
      if (!a.targetGranted && !a.deliverOnly && !finishingOwnFreight) return "idle" as const;
      // Resume this hauler's retained custody first. Other haulers may own the first
      // manifest, so acquire the next free can synchronously before any movement.
      if (native.haulTrip && a.member.role === "HAULER") {
        const work = (
          manifest: Manifest,
          h: NonNullable<ReturnType<Operation["claimContainer"]>>,
        ): HaulWork => {
          const { containerID } = manifest,
            { generation } = h,
            scope = op.haulTarget(manifest);
          if (!scope) throw Error("Published freight target authority is unavailable.");
          const currentClaim = () => op.snapshot().haulClaims[String(containerID)];
          return {
            manifest,
            generation,
            dispatched: h.dispatched,
            target: scope.target,
            claim: scope.claim,
            dispatch: () => {
              const c = currentClaim();
              return (
                !!c &&
                c.characterID === characterID &&
                c.generation === generation &&
                !!op.haulTarget(manifest) &&
                op.snapshot().stopFreight !== "RETURN_HOME" &&
                (c.dispatched || op.dispatchHaul(characterID, containerID, generation))
              );
            },
            waitForMore: () => {
              const snapshot = op.snapshot();
              // While the current site can still publish final freight, an empty queue is temporary.
              return (
                scope.target.kind === "BELT" &&
                snapshot.state === "ACTIVE" &&
                snapshot.claim?.key === manifest.targetKey &&
                snapshot.claim.generation === manifest.claimGeneration &&
                !snapshot.relocation &&
                (!snapshot.stopRequested ||
                  (snapshot.stopFreight === "COLLECT_FREIGHT" && !finalFreightReady))
              );
            },
            cancel: () => {
              op.cancelUndispatchedHaul(characterID, containerID, generation);
            },
            closePickup: () => {
              if (!op.closePickup(characterID, containerID, generation))
                throw Error("Verified freight pickup scope changed.");
            },
            missing: () => {
              if (!op.forgetMissingContainer(characterID, containerID, generation, true))
                throw Error("Missing freight scope changed.");
            },
            complete: (proof) => {
              if (!op.markDelivered(characterID, proof))
                throw Error("Freight delivery evidence could not be recorded.");
            },
          };
        };
        const trip = (onlyCan?: number) => {
          const retained = op.snapshot();
          const owned =
            op.assignment(characterID)?.manifests.flatMap((m) => {
              const claim = haulOwner(retained, m);
              return claim?.characterID === characterID && claim.purpose !== "tractor"
                ? [work(m, claim)]
                : [];
            }) ?? [];
          return native.haulTrip!(
            owned,
            async (eligible, rank) => {
              const fresh = op.assignment(characterID);
              if (!fresh) return null;
              const snapshot = op.snapshot();
              if (snapshot.stopFreight === "RETURN_HOME") return null;
              const available = fresh.manifests.filter(
                (m) =>
                  (onlyCan === undefined || m.containerID === onlyCan) && !haulOwner(snapshot, m),
              );
              const candidates = rank && available.length > 1 ? await rank(available) : available;
              for (const manifest of candidates) {
                if (!(await eligible(manifest))) continue;
                native.current();
                const claim = op.claimContainer(
                  characterID,
                  manifest.containerID,
                  "haul",
                  undefined,
                  true,
                );
                if (claim) return work(manifest, claim);
              }
              return null;
            },
            snapshot.destinationID,
            finalFreightReady ||
              !!snapshot.relocation ||
              (snapshot.state === "DRAINING" && snapshot.stopFreight === "COLLECT_FREIGHT"),
          );
        };
        let result: "idle" | "waiting" | "missing" | "delivered" = "idle";
        if (a.manifests.length || finishingOwnFreight) result = await trip();
        else if (a.targetGranted && (await native.unloadInitialFreight?.(snapshot.destinationID)))
          result = "delivered";
        const belt =
          (result === "idle" || result === "waiting") && native.waitAtBelt
            ? op.assignment(characterID)
            : null;
        const { target, claim } = belt ?? {};
        if (
          belt?.targetGranted &&
          target &&
          (target.kind === "BELT" || !!native.observeGridJetcans) &&
          claim &&
          native.waitAtBelt &&
          op.canDiscoverGridFreight(characterID, claim, false)
        ) {
          try {
            await discover(characterID, native, false, async (containerID) => {
              const collected = await trip(containerID);
              if (collected !== "idle") result = collected;
            });
            return result === "idle" ? ("on-grid" as const) : result;
          } catch (error) {
            if (!(error instanceof HaulStoppedBeforePickup)) throw error;
          }
        }
        return result;
      }
      let candidates = a.manifests
        .filter((m) => m.category === "RAW" || m.category === "COMPRESSED")
        .sort(
          (x, y) =>
            Number(claims[String(y.containerID)]?.characterID === characterID) -
            Number(claims[String(x.containerID)]?.characterID === characterID),
        );
      if (
        choose &&
        !candidates.some((m) => claims[String(m.containerID)]?.characterID === characterID)
      ) {
        const containerID = await choose(characterID, candidates);
        native.current();
        candidates = candidates.filter((m) => m.containerID === containerID);
      }
      let selected: {
        manifest: Manifest;
        haul: NonNullable<ReturnType<Operation["claimContainer"]>>;
      } | null = null;
      for (const manifest of candidates) {
        const haul = op.claimContainer(characterID, manifest.containerID);
        if (haul) {
          selected = { manifest, haul };
          break;
        }
      }
      if (!selected) return "idle" as const;
      const { manifest, haul: h } = selected;
      if (h.dispatched) {
        if (!native.recoverHeldAndDeliver) throw Error("Prior haul requires reconciliation.");
        const proof = await native.recoverHeldAndDeliver(
          manifest,
          h.generation,
          op.snapshot().destinationID,
        );
        native.current();
        if (!op.markDelivered(characterID, proof))
          throw Error("Recovered freight delivery is uncertain; reconciliation is required.");
        return "delivered" as const;
      }
      try {
        const scope = op.haulTarget(manifest);
        if (!scope) throw Error("Published freight target authority is unavailable.");
        const snapshot = op.snapshot();
        const result = await native.navigateAndVerify(
          manifest,
          scope.target,
          scope.claim,
          snapshot.stopFreight === "COLLECT_FREIGHT" ||
            !!scope.oldBeltID ||
            !!snapshot.relocation?.oldBeltID,
        );
        native.current();
        if (result === "missing") {
          if (!op.forgetMissingContainer(characterID, manifest.containerID, h.generation))
            throw Error("Missing freight scope changed.");
          return "missing" as const;
        }
      } catch (error) {
        op.cancelUndispatchedHaul(characterID, manifest.containerID, h.generation);
        throw error;
      }
      if (!op.dispatchHaul(characterID, manifest.containerID, h.generation)) return "idle" as const;
      let proof: Delivery;
      try {
        proof = await native.transferAndDeliver(
          manifest,
          h.generation,
          op.snapshot().destinationID,
        );
      } catch (error) {
        if (
          !(error instanceof HaulStoppedBeforePickup) ||
          !op.stopRemainingHaul(characterID, manifest.containerID, h.generation)
        )
          throw error;
        return "idle" as const;
      }
      native.current();
      if (!op.markDelivered(characterID, proof))
        throw Error("Freight delivery is uncertain; reconciliation is required.");
      return "delivered" as const;
    });
  }
  return {
    miner: (characterID: number, native: RawMinerNative) => mineStep(characterID, native, false),
    flush: (
      characterID: number,
      native: RawMinerNative,
      canPublish: boolean | FreightAdmission = true,
    ) => mineStep(characterID, native, true, canPublish),
    hauler,
    scanFinalFreight: (
      characterID: number,
      native: RawHaulerNative,
      selectedSite?: { target: Target; claim: Claim },
    ) => serial(characterID, () => discover(characterID, native, true, undefined, selectedSite)),
  };
}
/** EveJS Ship.Jettison maps its pre-mutation cooldown to this exact native user error. */
export function jettisonCooldownRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; status?: unknown; refusal?: { key?: unknown } };
  return e.code === "CALL_REFUSED" && e.status === 409 && e.refusal?.key === "ShpJettisonPending";
}
/** The stock ship command. Subsequent turns decide from the current physical hold. */
export function createShipJettison(session: PilotSession, current: () => void, timing?: MccTiming) {
  return async (itemIDs: readonly number[], selection?: JettisonSelection) => {
    if (
      !itemIDs.length ||
      new Set(itemIDs).size !== itemIDs.length ||
      itemIDs.some((id) => !Number.isSafeInteger(id) || id <= 0)
    )
      throw Error("Invalid exact jettison selection.");
    current();
    const send = () => session.flow.flying.bridgeDo("ship", "Jettison", [[...itemIDs]]);
    await (timing?.command(
      "Jettison",
      { ...selection, stackCount: itemIDs.length, firstItemID: itemIDs[0] },
      send,
    ) ?? send());
    current();
  };
}
