import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import {
  authoritativeFleetMemberCharacterIDs,
  decodeFleetCenter,
  loadBoundFleet,
} from "../../../../web/src/plugin-api/flying.ts";
import { readMiningReadiness } from "../nativeBelt.ts";
import type { Claim } from "../targetBoard.ts";
import type { IndustrialCoreRead } from "./industrialObservation.ts";
import type { ModuleObservation } from "../../shared/moduleObservation.ts";
import { createSelfCompressionFacilityObserver } from "./selfCompressionFacility.ts";

type Held = {
  run: Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">;
  session: PilotSession;
  shipID: number;
  current: () => void;
};
export type CompressionFacilityProof = {
  fleetID?: number;
  minerSessionGeneration?: number;
  commanderSessionGeneration?: number;
  operationID: string;
  runID: string;
  claimKey: string;
  claimGeneration: number;
  commanderCharacterID: number;
  commanderShipID: number;
  minerCharacterID: number;
  minerShipID: number;
  systemID: number;
  observedAt: number;
  sceneSampledAt: number;
  facilityTypeListIDs: readonly number[];
  matchingTypeListIDs: readonly number[];
  rangeMeters: number;
  surfaceDistanceMeters: number;
  sourceTypeID: number;
  compressedTypeID: number;
  coreModuleID: number;
  compressorModuleID: number;
  compressorEffectID: number;
};
const id = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
/** Read both held pilots and the caller's actual facility projection; never issue movement or compression. */
export function createCompressionFacilityObserver(config: {
  operationID: string;
  runID: string;
  systemID: number;
  commander: Held;
  miner: Held;
  claim: () => Claim | null;
  observeSupport: () => Promise<{
    core: IndustrialCoreRead;
    compressor: ModuleObservation;
    compressorEffectID: number;
    observedAt: number;
  }>;
}) {
  const { commander, miner } = config;
  if (
    !config.operationID ||
    !config.runID ||
    !id(config.systemID) ||
    ![commander.shipID, commander.run.characterID, miner.shipID, miner.run.characterID].every(id)
  )
    throw Error("Compression facility scope is invalid.");
  if (commander.shipID === miner.shipID || commander.run.characterID === miner.run.characterID) {
    if (
      commander.shipID !== miner.shipID ||
      commander.run.characterID !== miner.run.characterID ||
      commander.session !== miner.session
    )
      throw Error("Compression facility scope is invalid.");
    return createSelfCompressionFacilityObserver({
      operationID: config.operationID,
      runID: config.runID,
      systemID: config.systemID,
      commander,
      claim: config.claim,
      observeSupport: config.observeSupport,
    });
  }
  const current = () => {
    commander.current();
    miner.current();
    if (
      commander.session.store.station.get().online?.characterID !== commander.run.characterID ||
      miner.session.store.station.get().online?.characterID !== miner.run.characterID
    )
      throw Error("Compression held owner changed.");
  };
  const claim = () => {
    const c = config.claim();
    if (
      !c ||
      c.operationID !== config.operationID ||
      c.runID !== config.runID ||
      !id(c.generation) ||
      typeof c.key !== "string" ||
      !c.key ||
      c.expiresAt <= Date.now()
    )
      throw Error("Compression target claim is unavailable.");
    return c;
  };
  const fleet = async (h: Held) => {
    current();
    const f = decodeFleetCenter(
      await loadBoundFleet({
        ...h.session.flow.requestOptions(),
        baseUrl: h.run.baseUrl,
        fetch: h.run.fetch,
      }),
    );
    current();
    const ids = authoritativeFleetMemberCharacterIDs(f),
      fleetID = Number(f.fleet.initState.value.fleetID);
    if (
      f.availability !== "ready" ||
      !id(fleetID) ||
      !ids ||
      f.fleet.initState.value.members.length !== ids.length ||
      !ids.includes(commander.run.characterID) ||
      !ids.includes(miner.run.characterID)
    )
      throw Error("Compression native fleet is unavailable.");
    return fleetID;
  };
  return async (sourceTypeID: number): Promise<CompressionFacilityProof> => {
    const started = Date.now();
    if (!id(sourceTypeID)) throw Error("Compression source type is invalid.");
    current();
    const before = claim();
    const [commanderReady, minerReady, commanderFleet, minerFleet] = await Promise.all([
      readMiningReadiness(
        commander.run,
        commander.session,
        commander.shipID,
        config.systemID,
        current,
      ),
      readMiningReadiness(miner.run, miner.session, miner.shipID, config.systemID, current),
      fleet(commander),
      fleet(miner),
    ]);
    current();
    if (!commanderReady.ready || !minerReady.ready || commanderFleet !== minerFleet)
      throw Error("Compression held flight or fleet is not ready.");
    const scene = minerReady.space,
      ship = scene.ship,
      entities = scene.entities.filter((x) => x.itemID === commander.shipID),
      facility = entities[0];
    if (
      entities.length !== 1 ||
      !ship?.geometryAvailable ||
      facility?.kind !== "ship" ||
      facility.characterID !== commander.run.characterID ||
      facility.isNpc !== false ||
      !facility.geometryAvailable ||
      !facility.compressionFacility
    )
      throw Error("Live exact compression facility is unavailable.");
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
      throw Error("Compression facility types or range are unreadable.");
    const a = ship.position,
      b = facility.position,
      distance = Math.max(
        0,
        Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - ship.radius - facility.radius,
      );
    if (!Number.isFinite(distance) || distance > range)
      throw Error("Compression facility is outside native range.");
    current();
    const response = await miner.run.fetch(
        new URL(
          `/api/mining/compression-compatibility?typeIDs=${sourceTypeID}&typeListIDs=${lists.join(",")}`,
          miner.run.baseUrl,
        ),
      ),
      body = await response.json();
    current();
    const rows = body?.compatibility;
    if (
      !response.ok ||
      body?.ok !== true ||
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      rows[0]?.typeID !== sourceTypeID ||
      rows[0]?.availability !== "available" ||
      !id(rows[0]?.compressedTypeID) ||
      rows[0].compressedTypeID === sourceTypeID ||
      !Array.isArray(rows[0].matchingTypeListIDs) ||
      rows[0].matchingTypeListIDs.length !== lists.length ||
      new Set(rows[0].matchingTypeListIDs).size !== lists.length ||
      lists.some((x) => !rows[0].matchingTypeListIDs.includes(x))
    )
      throw Error("Exact facility compatibility or matching range is unavailable.");
    const support = await config.observeSupport();
    current();
    const core = support.core,
      compressor = support.compressor;
    if (
      core.availability !== "available" ||
      core.scope.operationID !== config.operationID ||
      core.scope.runID !== config.runID ||
      core.scope.characterID !== commander.run.characterID ||
      core.scope.shipID !== commander.shipID ||
      core.scope.sessionGeneration !== commander.session.flow.flying.sessionGeneration() ||
      !id(core.scope.moduleID) ||
      !core.core.online ||
      !core.core.active ||
      !core.core.effect ||
      core.core.effect.effectID !== core.core.effectID ||
      !id(core.core.effectID) ||
      !Number.isFinite(core.effectObservedAt) ||
      !compressor ||
      compressor.ownerID !== commander.run.characterID ||
      compressor.shipID !== commander.shipID ||
      !compressor.online ||
      !id(compressor.moduleID) ||
      !id(compressor.typeID) ||
      !id(support.compressorEffectID) ||
      !Array.isArray(compressor.effects) ||
      compressor.effects.filter(
        (e) => e.effectID === support.compressorEffectID && e.durationMs > 0,
      ).length !== 1 ||
      !Number.isFinite(support.observedAt) ||
      core.effectObservedAt > support.observedAt ||
      support.observedAt > Date.now() ||
      Date.now() - support.observedAt >= 60000 ||
      Date.now() - core.effectObservedAt >= 60000
    )
      throw Error("Fresh own Core and compressor effects are unavailable.");
    const effect = compressor.effects.find((e) => e.effectID === support.compressorEffectID)!;
    if (
      !/^\d+$/.test(compressor.timeFiletime) ||
      !/^\d+$/.test(effect.startFiletime) ||
      BigInt(effect.startFiletime) > BigInt(compressor.timeFiletime) ||
      compressor.moduleID === core.scope.moduleID
    )
      throw Error("Compressor effect timing is unavailable.");
    const typeResponse = await commander.run.fetch(
        new URL(`/api/client-data/dogma-types?typeIDs=${compressor.typeID}`, commander.run.baseUrl),
      ),
      typeBody = await typeResponse.json();
    current();
    const type = typeBody?.types?.[compressor.typeID],
      attrs = type?.attributes;
    if (
      !typeResponse.ok ||
      typeBody?.ok !== true ||
      typeBody?.available !== true ||
      type?.categoryID !== 7 ||
      !Array.isArray(type.effects) ||
      !type.effects.includes(support.compressorEffectID) ||
      typeBody.effects?.[support.compressorEffectID]?.name?.toLowerCase() !==
        "industrialitemcompression" ||
      !Array.isArray(attrs) ||
      attrs.filter(
        (v: unknown) =>
          Array.isArray(v) &&
          v[0] === 3255 &&
          id(v[1]) &&
          rows[0].matchingTypeListIDs.includes(v[1]),
      ).length !== 1
    )
      throw Error("Compressor type or effect metadata is unavailable.");
    const latest = await readMiningReadiness(
      miner.run,
      miner.session,
      miner.shipID,
      config.systemID,
      current,
    );
    current();
    if (!latest.ready) throw Error("Compression caller flight is not ready.");
    const again = latest.space.entities.filter((x) => x.itemID === commander.shipID),
      last = again[0],
      own = latest.space.ship;
    if (
      again.length !== 1 ||
      !own?.geometryAvailable ||
      last?.kind !== "ship" ||
      last.characterID !== commander.run.characterID ||
      last.isNpc !== false ||
      !last.geometryAvailable ||
      !last.compressionFacility ||
      last.compressionFacility.rangeMeters !== range ||
      JSON.stringify([...last.compressionFacility.typeListIDs].sort((a, b) => a - b)) !==
        JSON.stringify([...lists].sort((a, b) => a - b)) ||
      !Number.isFinite(latest.space.sampledAtMs) ||
      latest.space.sampledAtMs! < scene.sampledAtMs!
    )
      throw Error("Compression facility changed during observation.");
    const v = own.position,
      w = last.position,
      finalDistance = Math.max(
        0,
        Math.hypot(v.x - w.x, v.y - w.y, v.z - w.z) - own.radius - last.radius,
      );
    if (!Number.isFinite(finalDistance) || finalDistance > range)
      throw Error("Compression facility is outside native range.");
    const after = claim();
    if (
      after.key !== before.key ||
      after.generation !== before.generation ||
      Date.now() - started >= 60000
    )
      throw Error("Compression claim or observation scope changed.");
    const sampled = latest.space.sampledAtMs;
    return {
      fleetID: commanderFleet,
      minerSessionGeneration: miner.session.flow.flying.sessionGeneration?.(),
      commanderSessionGeneration: commander.session.flow.flying.sessionGeneration?.(),
      operationID: config.operationID,
      runID: config.runID,
      claimKey: after.key,
      claimGeneration: after.generation,
      commanderCharacterID: commander.run.characterID,
      commanderShipID: commander.shipID,
      minerCharacterID: miner.run.characterID,
      minerShipID: miner.shipID,
      systemID: config.systemID,
      observedAt: Date.now(),
      sceneSampledAt: sampled!,
      facilityTypeListIDs: [...lists],
      matchingTypeListIDs: [...rows[0].matchingTypeListIDs],
      rangeMeters: range,
      surfaceDistanceMeters: finalDistance,
      sourceTypeID,
      compressedTypeID: rows[0].compressedTypeID,
      coreModuleID: core.scope.moduleID,
      compressorModuleID: compressor.moduleID,
      compressorEffectID: support.compressorEffectID,
    };
  };
}
