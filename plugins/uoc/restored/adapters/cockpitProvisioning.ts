import type { Session, ApiOptions } from "../../../../web/src/plugin-api/index.ts";
import {
  simulatePilotResources,
  decodeNativeFittingResources,
  nativeApplyBlockers,
} from "../../provisioning/resourceQualification.ts";
import {
  reviewPreviousShipStorage,
  storePreviousShip,
  type StoragePlan,
} from "../../provisioning/previousShip.ts";
import {
  applyExistingHull,
  reviewExistingHull,
  verifyPersonalHull,
  type ExistingHull,
} from "../../provisioning/existingHull.ts";
import { trainingTargets } from "../../shared/trainingTargets.ts";
import { decodeModuleObservation } from "../../shared/moduleObservation.ts";
import { loadFitting, buildSlots, slotFlagOf } from "../../../../web/src/plugin-api/flying.ts";
type Read = (path: string, options: ApiOptions, body?: unknown) => Promise<any>;
const reviews = new Map<
  string,
  {
    session: Session;
    input: any;
    review: any;
    storage: StoragePlan | null;
    selection: ExistingHull | null;
  }
>();

/** Uses the actual page-owned flow and keeps the reviewed plan on that session. */
export async function cockpitProvisioning(session: Session, kind: string, setup: any, read: Read) {
  const characterID = session.store.get().station.online?.characterID,
    options = session.flow.requestOptions(),
    token = session.flow.sessionToken();
  if (!characterID || !token) throw Error("The selected Cockpit session has ended.");
  const current = () => {
    if (
      session.store.get().station.online?.characterID !== characterID ||
      session.flow.sessionToken() !== token
    )
      throw Error("The selected Cockpit pilot changed.");
  };
  const json = async (path: string, body?: unknown) => {
    current();
    const value = await read(path, options, body);
    current();
    return value;
  };
  const [owner, bots, flight] = await Promise.all([
    json(`/api/pilot-training/ownership?characterID=${characterID}`),
    json("/api/bots"),
    json("/api/bridge/flight/status"),
  ]);
  if (
    owner.ownership?.characterID !== characterID ||
    owner.ownership.owner !== "BROWSER" ||
    owner.ownership.online !== true
  )
    throw Error("Use the actual page-owned Cockpit session for this pilot.");
  if (
    !Array.isArray(bots.bots) ||
    bots.bots.some((b: any) => b.characterID === characterID && !b.endedAt)
  )
    throw Error("Equipment changes are unavailable during an active operation.");
  if (flight.flight?.docked !== true)
    throw Error("Dock this pilot before inspecting or changing its equipment.");
  const finish = (phase: string, readout: any) => ({
    botID: session.id,
    phase,
    status: "stopped",
    why: null,
    readout: { ...readout, onlineCockpit: true },
  });
  const input = {
    providerCharacterID: setup.providerCharacterID ?? characterID,
    corporationID: setup.corporationID,
    fittingID: setup.fittingID,
    ...(setup.hullItemID ? { hullItemID: setup.hullItemID } : {}),
    ...(setup.savedFittingSupplies === true
      ? { supplyPolicy: { supplies: [], savedFittingSupplies: true } }
      : {}),
    source:
      setup.sourceKind === "hangar"
        ? { kind: "hangar" }
        : {
            kind: "corp",
            corporationID: setup.sourceCorporationID ?? setup.corporationID,
            division: setup.division,
          },
  };
  const key = (hash: string) =>
    JSON.stringify([session.id, characterID, hash, setup.oldShipDivision ?? 0]);
  const physical = async (r: any) => {
    const shipID = r.context.shipID,
      shipTypeID = r.context.shipTypeID;
    const raw = await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [shipID]);
    current();
    const resources = decodeNativeFittingResources(raw, { shipID, shipTypeID, characterID });
    if (!resources) throw Error("Actual pilot CPU/PG readback is unavailable.");
    const fitting = await loadFitting(options);
    current();
    if (fitting.activeShipID !== shipID || Object.values(fitting.errors).some((e) => e !== null))
      throw Error("Actual fitted module identities are unavailable.");
    const slots = buildSlots(fitting.slots, fitting.shipInfo, fitting.online);
    const rows = r.contract.structural as number[][];
    const offline: number[] = [];
    for (const [flagID, typeID] of rows) {
      const module = slots.find((s) => slotFlagOf(s.family, s.index) === flagID)?.module;
      if (!module || module.typeID !== typeID)
        throw Error("The exact fitted module changed during verification.");
      const m = decodeModuleObservation(
        await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [module.itemID]),
        { moduleID: module.itemID, typeID: typeID!, ownerID: characterID, shipID, flagID: flagID! },
      );
      current();
      if (!m.online) offline.push(flagID!);
    }
    return { ...resources, allModulesOnline: offline.length === 0, offlineSlots: offline };
  };
  const qualify = async (r: any) => {
    const shipTypeID = r.contract.shipTypeID;
    const types = [
      ...new Set<number>([shipTypeID, ...r.contract.equipment.map((e: number[]) => e[1])]),
    ];
    const graph = await json(`/api/client-data/required-skills?typeIDs=${types.join(",")}`),
      sheet = (await json("/api/bridge/skills")).skills;
    if (
      graph.available !== true ||
      sheet?.characterID !== characterID ||
      !Array.isArray(sheet.skills)
    )
      throw Error("Current pilot requirements are unreadable.");
    const missing = trainingTargets(types, graph.required).filter(
      (t) => !sheet.skills.some((s: any) => s.typeID === t.typeID && s.level >= t.toLevel),
    );
    const resources = await simulatePilotResources({
      session,
      characterID,
      shipTypeID,
      fitData: [
        ...r.contract.equipment.map(([flagID, typeID, quantity]: number[]) => ({
          flagID: flagID!,
          typeID: typeID!,
          quantity: quantity!,
        })),
        ...(r.plan.retainedRigs ?? []),
      ],
      current,
      review: r,
      read: json,
    });
    const nativeResources = r.plan.mode === "ALREADY_SATISFIED" ? await physical(r) : null;
    const capacity =
      (resources.state === "SIMULATED" && resources.fits) ||
      (nativeResources?.fits && nativeResources.allModulesOnline);
    const droneBayReason = r.plan.mode === "ALREADY_SATISFIED" ? null : resources.droneBay?.reason;
    const applyBlockers = [
      ...nativeApplyBlockers(r),
      ...(!capacity ? ["Exact pilot CPU/PG qualification is unavailable or insufficient."] : []),
      ...(droneBayReason ? [droneBayReason] : []),
      ...(missing.length ? ["The pilot is missing required skills."] : []),
    ];
    return { resources, nativeResources, missing, applyBlockers };
  };
  if (kind === "provision-inspect") {
    const native = await json("/api/bridge/provisioning/ship-review", input);
    if (
      native.context?.characterID !== characterID ||
      native.contract?.definition?.fingerprint !== setup.fingerprint ||
      native.contract?.shipTypeID !== setup.goalTypeID ||
      native.plan?.targetHullTypeID !== setup.goalTypeID
    )
      throw Error("The selected fitting changed.");
    const { review: r, selection } = await reviewExistingHull(json, native);
    const { resources, nativeResources, missing, applyBlockers } = await qualify(r);
    const replacing =
      r.plan.mode === "NEW_HULL" || (selection !== null && selection.itemID !== r.context.shipID);
    const storage = await reviewPreviousShipStorage(
      json,
      r.context,
      replacing,
      setup.oldShipDivision,
    );
    if (storage.reason) applyBlockers.push(storage.reason);
    const canApply = applyBlockers.length === 0;
    const fingerprint = selection
      ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join("")
      : r.reviewHash;
    for (const [id, entry] of reviews) if (entry.review.expiresAt <= Date.now()) reviews.delete(id);
    if (canApply)
      reviews.set(key(fingerprint), {
        session,
        input,
        review: r,
        storage: storage.plan,
        selection,
      });
    else reviews.delete(key(fingerprint));
    return finish("Provisioning inspected", {
      characterID,
      corporationID: setup.corporationID,
      fittingID: setup.fittingID,
      fingerprint: setup.fingerprint,
      shipID: r.context.shipID,
      currentShipTypeID: r.context.shipTypeID,
      stationID: r.context.locationID,
      plan: r.plan,
      reviewedPlanFingerprint: fingerprint,
      nativeReviewID: r.reviewID,
      expiresAt: r.expiresAt,
      resources,
      nativeResources,
      skills: { missing },
      rawReview: r,
      sourceRead: r.source,
      status: r.status,
      fittingService: r.fittingService ?? "UNKNOWN",
      canApply,
      applyBlockers,
    });
  }
  if (kind !== "provision-apply") throw Error("Unsupported selected-session provisioning action.");
  const keyOfReview = key(setup.reviewedPlanFingerprint),
    saved = reviews.get(keyOfReview);
  if (!saved || saved.session !== session)
    throw Error("Inspect the exact native plan again before Apply.");
  reviews.delete(keyOfReview);
  const originalShipID = saved.review.context.shipID,
    operationID = saved.review.reviewID;
  let result: any = null,
    targetHullID: number;
  if (saved.selection) {
    if (Date.now() >= saved.review.expiresAt)
      throw Error("The reviewed plan expired. Inspect the ship again.");
    const { review: fresh, selection } = await reviewExistingHull(
      json,
      await json("/api/bridge/provisioning/ship-review", saved.input),
    );
    if (
      fresh.reviewHash !== saved.review.reviewHash ||
      fresh.canApply !== true ||
      JSON.stringify(selection) !== JSON.stringify(saved.selection)
    )
      throw Error("The reviewed hull, fitting or stock changed. Inspect the ship again.");
    const { applyBlockers } = await qualify(fresh);
    if (applyBlockers.length) throw Error(applyBlockers.join(" "));
    targetHullID = saved.selection.itemID;
    const applied = await applyExistingHull(json, fresh, saved.selection);
    if (!applied.ok) {
      await session.flow.loadInventory();
      current();
      await session.flow.loadFlightStatus();
      current();
      return {
        ...finish("Existing ship Apply incomplete", {
          characterID,
          operationID,
          originalShipID,
          targetHullID,
          activeShipID: applied.activeShipID,
        }),
        status: "error",
        why: applied.reason,
      };
    }
  } else {
    result = await json("/api/bridge/provisioning/provision-ship", {
      reviewID: operationID,
      reviewHash: saved.review.reviewHash,
      confirm: true,
    });
    if (result.operationID !== operationID || result.manifest?.originalShipID !== originalShipID)
      throw Error("The native receipt identity could not be verified.");
    if (result.state !== "COMPLETE" || result.result?.equipment !== "VERIFIED")
      throw Error(
        `Native provisioning ${result.operationID} remains ${result.state}: ${result.reason ?? "review its original receipt"}. No Apply was replayed.`,
      );
    targetHullID = result.manifest.targetHullID;
  }
  const finalInput = { ...saved.input };
  delete finalInput.hullItemID;
  const final = await json("/api/bridge/provisioning/ship-review", finalInput);
  if (
    final.context.characterID !== characterID ||
    final.context.corporationID !== saved.review.context.corporationID ||
    final.context.shipID !== targetHullID ||
    final.context.locationID !== saved.review.context.locationID ||
    final.status.equipment !== "VERIFIED" ||
    final.contract.definition.fingerprint !== saved.review.contract.definition.fingerprint
  )
    throw Error("Actual final fitted equipment is not verified.");
  const nativeResources = await physical(final);
  if (!nativeResources.fits || !nativeResources.allModulesOnline)
    throw Error("Actual final CPU/PG or online module state is not verified.");
  const stored = saved.storage
    ? await storePreviousShip(json, saved.storage, final.context.shipID)
    : saved.selection && targetHullID !== originalShipID
      ? await verifyPersonalHull(
          json,
          saved.review.context,
          originalShipID,
          saved.review.context.shipTypeID,
        ).then(
          () => null,
          (error) => ({ proof: null, reason: String(error?.message ?? error) }),
        )
      : null;
  // The executor boarded through native RPC. Refresh the existing Cockpit's ordinary views, as its own Board action does.
  await session.flow.loadInventory();
  current();
  await session.flow.openShipBays(final.context.shipID);
  current();
  await session.flow.loadFitting();
  current();
  await session.flow.loadFlightStatus();
  current();
  return finish(stored?.reason ? "Previous ship storage incomplete" : "Provisioning verified", {
    characterID,
    shipID: final.context.shipID,
    equipment: "VERIFIED",
    operationID,
    originalShipID,
    ...(saved.selection ? { existingHull: true } : { nativeReceipt: result }),
    finalStatus: final.status,
    nativeResources,
    previousShipStorage: stored?.proof ?? null,
    previousShipStorageReason: stored?.reason ?? null,
  });
}
