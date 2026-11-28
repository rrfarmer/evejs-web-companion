import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import { buildSlots, loadFitting, slotFlagOf } from "../../../../web/src/plugin-api/flying.ts";
import { decodeModuleObservation } from "../../shared/moduleObservation.ts";
import type { SynchronousStore } from "../targetBoard.ts";
import {
  createCompressorController,
  CompressorNotDispatched,
  type CompressorObservation,
} from "./compressor.ts";
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
/** Observe and drive only the selected commander's exact fitted compressor. */
export async function createNativeCompressor(config: {
  operationID: string;
  runID: string;
  run: PluginRunContext;
  session: PilotSession;
  shipID: number;
  moduleID: number;
  typeID: number;
  sessionGeneration: number;
  document: SynchronousStore;
  current: () => void;
  coreReady: () => Promise<boolean>;
  beforeActivate: () => void;
}) {
  const { run, session, current } = config;
  current();
  const response = await run.fetch(
      new URL(`/api/client-data/dogma-types?typeIDs=${config.typeID}`, run.baseUrl),
    ),
    data = await response.json();
  current();
  const type = data?.types?.[config.typeID],
    effects = Array.isArray(type?.effects)
      ? type.effects.filter(
          (x: unknown) =>
            id(x) && data.effects?.[x]?.name?.toLowerCase() === "industrialitemcompression",
        )
      : [];
  if (
    !response.ok ||
    data?.ok !== true ||
    data.available !== true ||
    type?.categoryID !== 7 ||
    !Array.isArray(type.attributes) ||
    type.attributes.filter((x: unknown) => Array.isArray(x) && x[0] === 3255 && id(x[1])).length !==
      1 ||
    type.attributes.filter((x: unknown) => Array.isArray(x) && x[0] === 3265 && x[1] === 1)
      .length !== 1 ||
    effects.length !== 1
  )
    throw Error("Selected native compressor type or effect is unsupported.");
  const effectID = effects[0] as number,
    effectName = data.effects[effectID].name as string;
  const identity = {
    operationID: config.operationID,
    runID: config.runID,
    botID: run.botID,
    sessionGeneration: config.sessionGeneration,
    characterID: run.characterID,
    shipID: config.shipID,
    moduleID: config.moduleID,
    typeID: config.typeID,
    effectID,
  };
  const observe = async (): Promise<CompressorObservation> => {
    current();
    if (
      session.flow.flying.sessionGeneration() !== config.sessionGeneration ||
      session.flow.flying.isSessionClosing() ||
      session.store.station.get().online?.characterID !== run.characterID
    )
      throw Error("Held compressor owner changed.");
    const fit = await loadFitting({
      ...session.flow.requestOptions(),
      baseUrl: run.baseUrl,
      fetch: run.fetch,
    });
    current();
    if (
      fit.activeShipID !== config.shipID ||
      fit.errors.slots !== null ||
      fit.errors.shipInfo !== null ||
      fit.errors.online !== null
    )
      throw Error("Compressor fitting is unavailable.");
    const slots = buildSlots(fit.slots, fit.shipInfo, fit.online),
      matches = slots.filter(
        (s) =>
          s.family === "high" &&
          s.module?.itemID === config.moduleID &&
          s.module.typeID === config.typeID,
      );
    if (matches.length !== 1 || !matches[0]?.module?.online)
      throw Error("Exact online compressor is unavailable.");
    const slot = matches[0]!,
      flagID = slotFlagOf(slot.family, slot.index);
    if (!id(flagID)) throw Error("Compressor slot is unavailable.");
    const module = decodeModuleObservation(
      await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [config.moduleID]),
      {
        moduleID: config.moduleID,
        typeID: config.typeID,
        ownerID: run.characterID,
        shipID: config.shipID,
        flagID,
      },
    );
    current();
    return { identity, module, observedAt: Date.now() };
  };
  const controller = createCompressorController({
    identity,
    document: config.document,
    current,
    observe,
    coreReady: config.coreReady,
    activate: () => {
      try {
        config.beforeActivate();
      } catch (error) {
        throw new CompressorNotDispatched(error instanceof Error ? error.message : String(error));
      }
      return session.flow.flying.bridgeDo("dogmaIM", "Activate", [
        config.moduleID,
        effectName,
        null,
        0,
      ]);
    },
    deactivate: () =>
      session.flow.flying.bridgeDo("dogmaIM", "Deactivate", [config.moduleID, effectName]),
  });
  return { ...controller, effectID };
}
