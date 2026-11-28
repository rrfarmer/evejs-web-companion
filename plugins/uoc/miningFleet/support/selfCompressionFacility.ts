import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import { readMiningReadiness } from "../nativeBelt.ts";
import type { Claim } from "../targetBoard.ts";
import type { IndustrialCoreRead } from "./industrialObservation.ts";
import type { ModuleObservation } from "../../shared/moduleObservation.ts";
import type { CompressionFacilityProof } from "./compressionFacility.ts";
type Held = {
  run: Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">;
  session: PilotSession;
  shipID: number;
  current: () => void;
};
const id = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
/** Same-ship native facility path: stock server explicitly permits facilityBallID === own ship ID. */
export function createSelfCompressionFacilityObserver(c: {
  operationID: string;
  runID: string;
  systemID: number;
  commander: Held;
  claim: () => Claim | null;
  observeSupport: () => Promise<{
    core: IndustrialCoreRead;
    compressor: ModuleObservation;
    compressorEffectID: number;
    observedAt: number;
  }>;
}) {
  const h = c.commander;
  if (!c.operationID || !c.runID || ![c.systemID, h.shipID, h.run.characterID].every(id))
    throw Error("Self compression scope is invalid.");
  const generation = h.session.flow.flying.sessionGeneration();
  const current = () => {
    h.current();
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      h.session.flow.flying.isSessionClosing() ||
      h.session.flow.flying.sessionGeneration() !== generation ||
      h.session.store.station.get().online?.characterID !== h.run.characterID
    )
      throw Error("Self compression held owner changed.");
  };
  const claim = () => {
    const x = c.claim();
    if (
      !x ||
      x.operationID !== c.operationID ||
      x.runID !== c.runID ||
      !id(x.generation) ||
      !x.key ||
      x.expiresAt <= Date.now()
    )
      throw Error("Compression target claim is unavailable.");
    return x;
  };
  const nativeService = async () => {
    current();
    const result = await readMiningReadiness(h.run, h.session, h.shipID, c.systemID, current);
    current();
    const ship = result.space.ship,
      entities = result.space.entities.filter((e) => e.itemID === h.shipID),
      facility = entities[0];
    if (
      !result.ready ||
      ship?.itemID !== h.shipID ||
      (ship.characterID != null && ship.characterID !== h.run.characterID) ||
      (ship.ownerID != null && ship.ownerID !== h.run.characterID) ||
      !ship.geometryAvailable ||
      entities.length !== 1 ||
      facility?.kind !== "ship" ||
      facility.characterID !== h.run.characterID ||
      facility.isNpc !== false ||
      !facility.geometryAvailable ||
      !facility.compressionFacility ||
      !Number.isFinite(result.space.sampledAtMs)
    )
      throw Error("Own compression facility is unavailable.");
    const lists = facility.compressionFacility.typeListIDs,
      range = facility.compressionFacility.rangeMeters;
    if (
      !Array.isArray(lists) ||
      !lists.length ||
      lists.length > 16 ||
      lists.some((x) => !id(x)) ||
      new Set(lists).size !== lists.length ||
      !Number.isFinite(range) ||
      range <= 0
    )
      throw Error("Own compression type lists are unreadable.");
    return { lists: [...lists], range, sampled: result.space.sampledAtMs! };
  };
  const json = async (path: string) => {
    current();
    const response = await h.run.fetch(new URL(path, h.run.baseUrl)),
      v = (await response.json()) as any;
    current();
    if (!response.ok || v?.ok !== true) throw Error("Native compression metadata is unavailable.");
    return v;
  };
  return async (sourceTypeID: number): Promise<CompressionFacilityProof> => {
    if (!id(sourceTypeID)) throw Error("Compression source type is invalid.");
    const start = Date.now();
    current();
    const before = claim(),
      first = await nativeService();
    const compatible = await json(
        `/api/mining/compression-compatibility?typeIDs=${sourceTypeID}&typeListIDs=${first.lists.join(",")}`,
      ),
      rows = compatible.compatibility;
    if (
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      rows[0]?.typeID !== sourceTypeID ||
      rows[0]?.availability !== "available" ||
      !id(rows[0]?.compressedTypeID) ||
      rows[0].compressedTypeID === sourceTypeID ||
      !Array.isArray(rows[0].matchingTypeListIDs) ||
      rows[0].matchingTypeListIDs.length !== first.lists.length ||
      new Set(rows[0].matchingTypeListIDs).size !== first.lists.length ||
      first.lists.some((x) => !rows[0].matchingTypeListIDs.includes(x))
    )
      throw Error("Exact own facility compatibility is unavailable.");
    const support = await c.observeSupport();
    current();
    const core = support.core,
      module = support.compressor,
      now = Date.now();
    if (
      core.availability !== "available" ||
      core.scope.operationID !== c.operationID ||
      core.scope.runID !== c.runID ||
      core.scope.characterID !== h.run.characterID ||
      core.scope.shipID !== h.shipID ||
      core.scope.sessionGeneration !== generation ||
      !id(core.scope.moduleID) ||
      !core.core.online ||
      !core.core.active ||
      !core.core.effect ||
      core.core.effect.effectID !== core.core.effectID ||
      !id(core.core.effectID) ||
      !Number.isFinite(core.effectObservedAt) ||
      !module ||
      module.ownerID !== h.run.characterID ||
      module.shipID !== h.shipID ||
      !module.online ||
      !id(module.moduleID) ||
      !id(module.typeID) ||
      !id(support.compressorEffectID) ||
      !Array.isArray(module.effects) ||
      module.effects.filter((x) => x.effectID === support.compressorEffectID && x.durationMs > 0)
        .length !== 1 ||
      !Number.isFinite(support.observedAt) ||
      core.effectObservedAt > support.observedAt ||
      support.observedAt > now ||
      now - support.observedAt >= 60000 ||
      now - core.effectObservedAt >= 60000
    )
      throw Error("Fresh own Core and compressor effects are unavailable.");
    const effect = module.effects.find((x) => x.effectID === support.compressorEffectID)!;
    if (
      !/^\d+$/.test(module.timeFiletime) ||
      !/^\d+$/.test(effect.startFiletime) ||
      BigInt(effect.startFiletime) > BigInt(module.timeFiletime) ||
      module.moduleID === core.scope.moduleID
    )
      throw Error("Compressor effect timing is unavailable.");
    const meta = await json(`/api/client-data/dogma-types?typeIDs=${module.typeID}`),
      type = meta?.types?.[module.typeID];
    if (
      meta.available !== true ||
      type?.categoryID !== 7 ||
      !Array.isArray(type.effects) ||
      !type.effects.includes(support.compressorEffectID) ||
      meta.effects?.[support.compressorEffectID]?.name?.toLowerCase() !==
        "industrialitemcompression" ||
      !Array.isArray(type.attributes) ||
      type.attributes.filter(
        (v: unknown) =>
          Array.isArray(v) &&
          v[0] === 3255 &&
          id(v[1]) &&
          rows[0].matchingTypeListIDs.includes(v[1]),
      ).length !== 1
    )
      throw Error("Compressor type or effect metadata is unavailable.");
    const last = await nativeService(),
      after = claim();
    if (
      last.range !== first.range ||
      JSON.stringify([...last.lists].sort((a, b) => a - b)) !==
        JSON.stringify([...first.lists].sort((a, b) => a - b)) ||
      after.key !== before.key ||
      after.generation !== before.generation ||
      Date.now() - start >= 60000
    )
      throw Error("Own compression facility or target changed.");
    return {
      operationID: c.operationID,
      runID: c.runID,
      claimKey: after.key,
      claimGeneration: after.generation,
      commanderCharacterID: h.run.characterID,
      commanderShipID: h.shipID,
      minerCharacterID: h.run.characterID,
      minerShipID: h.shipID,
      systemID: c.systemID,
      observedAt: Date.now(),
      sceneSampledAt: last.sampled,
      facilityTypeListIDs: [...first.lists],
      matchingTypeListIDs: [...rows[0].matchingTypeListIDs],
      rangeMeters: first.range,
      surfaceDistanceMeters: 0,
      sourceTypeID,
      compressedTypeID: rows[0].compressedTypeID,
      coreModuleID: core.scope.moduleID,
      compressorModuleID: module.moduleID,
      compressorEffectID: support.compressorEffectID,
    };
  };
}
