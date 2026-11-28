import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import {
  buildSlots,
  slotFlagOf,
  loadFitting,
  getFlightStatus,
  decodeFlightStatus,
  getSpaceSnapshot,
  decodeSpaceSnapshot,
  getTargets,
  decodeTargetIDs,
} from "../../../../web/src/plugin-api/flying.ts";
import { decodeOwnShipLocation, type OwnShipProof } from "../../shared/nativeShipLocation.ts";
import { decodeModuleObservation } from "../../shared/moduleObservation.ts";
import type { Manifest } from "../operation.ts";
import type { SynchronousStore } from "../targetBoard.ts";
import { createTractorController, type TractorRead } from "./tractor.ts";

export type NativeTractorConfig = {
  run: PluginRunContext;
  session: PilotSession;
  shipID: number;
  moduleID: number;
  typeID: number;
  manifest: Manifest;
  claimGeneration: number;
  targetGeneration: number;
  document: SynchronousStore;
  current: () => void;
  claimCurrent: () => void;
  beforeAction: () => void;
};
export type TractorDiagnostic = {
  startedAt: number;
  completedAt: number;
  simulationSampledAt: number;
  nativeProof: OwnShipProof;
  surfaceDistance: number;
  moduleID: number;
  canID: number;
};
type Dependencies = {
  loadFitting: typeof loadFitting;
  buildSlots: typeof buildSlots;
  getFlightStatus: typeof getFlightStatus;
  decodeFlightStatus: typeof decodeFlightStatus;
  getSpaceSnapshot: typeof getSpaceSnapshot;
  decodeSpaceSnapshot: typeof decodeSpaceSnapshot;
  getTargets: typeof getTargets;
  decodeTargetIDs: typeof decodeTargetIDs;
  now: () => number;
};
const defaults: Dependencies = {
  loadFitting,
  buildSlots,
  getFlightStatus,
  decodeFlightStatus,
  getSpaceSnapshot,
  decodeSpaceSnapshot,
  getTargets,
  decodeTargetIDs,
  now: Date.now,
};
const id = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const point = (p: any) => !!p && [p.x, p.y, p.z].every(Number.isFinite);
/** Public held-pilot reads and ordinary Dogma calls; no session acquisition or inventory mutation. */
export async function createNativeTractor(
  c: NativeTractorConfig,
  overrides: Partial<Dependencies> = {},
) {
  const d = { ...defaults, ...overrides },
    m = structuredClone(c.manifest),
    { run, session } = c,
    generation = session.flow.flying.sessionGeneration(),
    options = () => ({ ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch });
  if (
    !run.botID ||
    !id(run.characterID) ||
    run.held.characterID !== run.characterID ||
    ![
      c.shipID,
      c.moduleID,
      c.typeID,
      c.claimGeneration,
      c.targetGeneration,
      m.containerID,
      m.characterID,
      m.shipID,
      m.systemID,
      m.claimGeneration,
    ].every(id) ||
    !m.operationID ||
    !m.runID ||
    m.source !== "native-jetcan" ||
    !m.targetKey ||
    !id(m.intentGeneration) ||
    m.delivered ||
    !Array.isArray(m.items) ||
    m.items.length === 0 ||
    m.items.some((x) => !id(x.itemID) || !id(x.typeID) || !id(x.quantity)) ||
    new Set(m.items.map((x) => x.itemID)).size !== m.items.length ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    throw Error("Tractor manifest or held identity is invalid.");
  const heldGuard = () => {
    c.current();
    if (
      session.flow.flying.isSessionClosing() ||
      session.flow.flying.sessionGeneration() !== generation ||
      session.store.station.get().online?.characterID !== run.characterID
    )
      throw Error("Tractor held pilot changed.");
  };
  const guard = () => {
    heldGuard();
    c.claimCurrent();
  };
  const flight = async () => {
    guard();
    const f = d.decodeFlightStatus((await d.getFlightStatus(options())).flight);
    guard();
    if (
      !f.inSpace ||
      f.docked ||
      f.shipID !== c.shipID ||
      f.solarSystemID !== m.systemID ||
      f.stationID !== null ||
      f.structureID !== null ||
      (f.transition && f.transition.phase !== "ready")
    )
      throw Error("Tractor flight scope is unavailable.");
    return f;
  };
  const fitted = async () => {
    guard();
    const raw = await d.loadFitting(options());
    guard();
    if (
      raw.activeShipID !== c.shipID ||
      raw.errors.slots !== null ||
      raw.errors.shipInfo !== null ||
      raw.errors.online !== null
    )
      throw Error("Tractor fitting is unreadable.");
    const slots = d.buildSlots(raw.slots, raw.shipInfo, raw.online),
      hits = slots.filter(
        (s) =>
          s.family === "high" && s.module?.itemID === c.moduleID && s.module.typeID === c.typeID,
      ),
      all = slots
        .filter((s) => s.module)
        .map((s) => ({ id: s.module!.itemID, flag: slotFlagOf(s.family, s.index) }));
    if (
      hits.length !== 1 ||
      !hits[0]!.module?.online ||
      hits[0]!.module?.groupID !== 650 ||
      all.some((x) => !id(x.id) || !id(x.flag)) ||
      new Set(all.map((x) => x.id)).size !== all.length ||
      new Set(all.map((x) => x.flag)).size !== all.length
    )
      throw Error("Exact online tractor fitting is not verified.");
    const flag = slotFlagOf(hits[0]!.family, hits[0]!.index);
    if (!id(flag)) throw Error("Tractor slot is unavailable.");
    return flag;
  };
  guard();
  const flagID = await fitted();
  guard();
  const response = await run.fetch(
      new URL(`/api/client-data/dogma-types?typeIDs=${c.typeID}`, run.baseUrl),
    ),
    body = await response.json();
  guard();
  const type = body?.types?.[c.typeID];
  if (
    !response.ok ||
    body?.available !== true ||
    type?.categoryID !== 7 ||
    type?.groupID !== 650 ||
    !Array.isArray(type.effects)
  )
    throw Error("Tractor native type metadata is unavailable.");
  const effects = type.effects.filter(
    (x: unknown) => id(x) && body.effects?.[x]?.name === "tractorBeamCan",
  );
  if (effects.length !== 1) throw Error("Tractor native effect is not uniquely qualified.");
  const effectID = effects[0] as number;
  let last: TractorDiagnostic | null = null;
  async function observe(): Promise<TractorRead> {
    const startedAt = d.now();
    guard();
    const before = await flight();
    if ((await fitted()) !== flagID) throw Error("Tractor slot changed.");
    guard();
    const s = d.decodeSpaceSnapshot((await d.getSpaceSnapshot(options())).space);
    guard();
    if (
      s.stateValid === false ||
      !s.inSpace ||
      s.shipID !== c.shipID ||
      s.solarSystemID !== m.systemID ||
      s.ship?.itemID !== c.shipID ||
      s.ship.ownerID !== run.characterID ||
      s.ship.characterID !== run.characterID ||
      !s.ship.geometryAvailable ||
      !point(s.ship.position) ||
      !Number.isFinite(s.ship.radius) ||
      s.ship.radius < 0 ||
      !Number.isFinite(s.sampledAtMs) ||
      s.sampledAtMs! <= 0
    )
      throw Error("Tractor own-ship scene is unavailable.");
    const cans = s.entities.filter((e) => e.itemID === m.containerID);
    if (
      cans.length !== 1 ||
      cans[0]!.kind !== "container" ||
      cans[0]!.ownerID !== m.characterID ||
      !cans[0]!.geometryAvailable ||
      !point(cans[0]!.position) ||
      !Number.isFinite(cans[0]!.radius) ||
      cans[0]!.radius < 0
    )
      throw Error("Exact operation can geometry is unavailable.");
    const proofStart = d.now();
    guard();
    const shipRaw = await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [c.shipID]);
    const proofEnd = d.now();
    guard();
    const nativeProof = decodeOwnShipLocation(
      shipRaw,
      { characterID: run.characterID, shipID: c.shipID, systemID: m.systemID },
      proofStart,
      proofEnd,
      s.sampledAtMs!,
    );
    guard();
    const module = await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [c.moduleID]);
    guard();
    const nativeModule = decodeModuleObservation(module, {
      moduleID: c.moduleID,
      typeID: c.typeID,
      ownerID: run.characterID,
      shipID: c.shipID,
      flagID,
    });
    if (!nativeModule.online) throw Error("Native tractor online effect is unavailable.");
    const targets = await d.getTargets(options());
    guard();
    if (!Array.isArray(targets.targetIDs)) throw Error("Native locked-target list is unreadable.");
    const lockedTargetIDs = d.decodeTargetIDs(targets.targetIDs);
    if (lockedTargetIDs.length !== targets.targetIDs.length)
      throw Error("Native locked-target list is malformed.");
    if ((await fitted()) !== flagID) throw Error("Tractor slot changed.");
    const after = await flight(),
      completedAt = d.now();
    guard();
    if (
      after.shipID !== before.shipID ||
      after.solarSystemID !== before.solarSystemID ||
      !Number.isSafeInteger(startedAt) ||
      !Number.isSafeInteger(completedAt) ||
      completedAt < startedAt ||
      completedAt - startedAt > 90000
    )
      throw Error("Tractor held observation exceeded its scope or budget.");
    const can = cans[0]!,
      distance = Math.max(
        0,
        Math.hypot(
          s.ship.position.x - can.position.x,
          s.ship.position.y - can.position.y,
          s.ship.position.z - can.position.z,
        ) -
          s.ship.radius -
          can.radius,
      );
    last = {
      startedAt,
      completedAt,
      simulationSampledAt: s.sampledAtMs!,
      nativeProof,
      surfaceDistance: distance,
      moduleID: c.moduleID,
      canID: m.containerID,
    };
    return {
      module,
      observedAt: completedAt,
      shipID: c.shipID,
      systemID: m.systemID,
      canID: m.containerID,
      inSpace: true,
      shipPosition: s.ship.position,
      canPosition: can.position,
      shipRadius: s.ship.radius,
      canRadius: can.radius,
      lockedTargetIDs,
    };
  }
  const controller = createTractorController({
    identity: {
      operationID: m.operationID,
      runID: m.runID,
      botID: run.botID,
      sessionGeneration: generation,
      characterID: run.characterID,
      shipID: c.shipID,
      moduleID: c.moduleID,
      typeID: c.typeID,
      flagID,
      canID: m.containerID,
      systemID: m.systemID,
      claimGeneration: c.claimGeneration,
      targetGeneration: c.targetGeneration,
    },
    qualification: { typeID: c.typeID, effectID, effectName: "tractorBeamCan" },
    document: c.document,
    current: guard,
    heldCurrent: heldGuard,
    readOwn: async () => {
      heldGuard();
      const before = d.decodeFlightStatus((await d.getFlightStatus(options())).flight);
      heldGuard();
      if (
        before.shipID !== c.shipID ||
        before.solarSystemID !== m.systemID ||
        before.docked === before.inSpace
      )
        throw Error("Own tractor flight identity is unavailable.");
      const module = await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [c.moduleID]);
      heldGuard();
      const after = d.decodeFlightStatus((await d.getFlightStatus(options())).flight);
      heldGuard();
      if (
        after.shipID !== before.shipID ||
        after.solarSystemID !== before.solarSystemID ||
        after.docked !== before.docked ||
        after.inSpace !== before.inSpace
      )
        throw Error("Own tractor flight identity changed.");
      return { module, observedAt: d.now() };
    },
    beforeAction: c.beforeAction,
    read: observe,
    lock: (targetID) => session.flow.flying.bridgeDo("dogmaIM", "AddTarget", [targetID]),
    activate: (moduleID, targetID) =>
      session.flow.flying.bridgeDo("dogmaIM", "Activate", [
        moduleID,
        "tractorBeamCan",
        targetID,
        0,
      ]),
    deactivate: (moduleID) =>
      session.flow.flying.bridgeDo("dogmaIM", "Deactivate", [moduleID, "tractorBeamCan"]),
    now: d.now,
  });
  return { ...controller, observe, diagnostic: () => (last ? structuredClone(last) : null) };
}
