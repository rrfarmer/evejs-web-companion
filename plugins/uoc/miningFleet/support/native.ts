import { chargeEffectCollections } from "./chargeEffects.ts";
import type { PluginRunContext } from "../../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import {
  buildSlots,
  slotFlagOf,
  loadFitting,
  boundDogma,
  loadBoundFleet,
  decodeFleetCenter,
  authoritativeFleetMemberCharacterIDs,
  decodeFlightStatus,
  getFlightStatus,
} from "../../../../web/src/plugin-api/flying.ts";
import { resolveDogmaCharge } from "./dogmaCharge.ts";
import { decodeModuleObservation } from "../../shared/moduleObservation.ts";
import { readMiningReadiness } from "../nativeBelt.ts";
import {
  createBurstController,
  type BurstObservation,
  type OwnBurstObservation,
} from "./controller.ts";
import type { SynchronousStore } from "../targetBoard.ts";
type Held = {
  run: Pick<PluginRunContext, "characterID" | "baseUrl" | "fetch">;
  session: PilotSession;
  shipID: number;
  current: () => void;
};
const id = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
/** Stock held-session reads and public dogma calls only; no login, movement, core or compression. */
export function createNativeBurst(config: {
  operationID: string;
  runID: string;
  commander: Held;
  moduleID: number;
  typeID: number;
  recipients: readonly Held[];
  document: SynchronousStore;
}) {
  const { commander: c, recipients } = config;
  if (
    !id(c.run.characterID) ||
    !id(c.shipID) ||
    !id(config.moduleID) ||
    !id(config.typeID) ||
    !recipients.length ||
    new Set([c.run.characterID, ...recipients.map((r) => r.run.characterID)]).size !==
      recipients.length + 1 ||
    new Set([c.shipID, ...recipients.map((r) => r.shipID)]).size !== recipients.length + 1
  )
    throw Error("Burst roster is invalid.");
  const opts = (h: Held) => ({
    ...h.session.flow.requestOptions(),
    baseUrl: h.run.baseUrl,
    fetch: h.run.fetch,
  });
  const guard = (h: Held) => {
    h.current();
    if (h.session.store.station.get().online?.characterID !== h.run.characterID)
      throw Error("Held burst pilot changed.");
  };
  const json = async (path: string) => {
    guard(c);
    const r = await c.run.fetch(new URL(path, c.run.baseUrl)),
      x = await r.json();
    guard(c);
    if (!r.ok || x?.ok !== true) throw Error("Burst static type read failed.");
    return x;
  };
  const observeOwn = async (): Promise<OwnBurstObservation> => {
    guard(c);
    const raw = await loadFitting(opts(c));
    guard(c);
    if (
      raw.activeShipID !== c.shipID ||
      raw.errors.slots !== null ||
      raw.errors.shipInfo !== null ||
      raw.errors.online !== null
    )
      throw Error("Own burst fitting is unreadable.");
    const slots = buildSlots(raw.slots, raw.shipInfo, raw.online),
      matches = slots.filter(
        (s) =>
          s.family === "high" &&
          s.module?.itemID === config.moduleID &&
          s.module.typeID === config.typeID,
      );
    if (matches.length !== 1 || !matches[0]!.module)
      throw Error("Exact own burst module is not fitted.");
    const slot = matches[0]!,
      m = slot.module!,
      flagID = slotFlagOf(slot.family, slot.index);
    if (!flagID || m.groupID !== 1770) throw Error("Own burst module is unreadable.");
    const data = await json(`/api/client-data/dogma-types?typeIDs=${config.typeID}`),
      type = data.types?.[config.typeID],
      effectID = type?.defaultEffectID,
      effectName = data.effects?.[effectID]?.name;
    if (
      data.available !== true ||
      type?.groupID !== 1770 ||
      !id(effectID) ||
      typeof effectName !== "string" ||
      effectName.toLowerCase() !== "modulebonuswarfarelinkmining"
    )
      throw Error("Own mining burst effect is unreadable.");
    guard(c);
    const module = decodeModuleObservation(
      await c.session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [m.itemID]),
      {
        moduleID: m.itemID,
        typeID: m.typeID,
        ownerID: c.run.characterID,
        shipID: c.shipID,
        flagID,
      },
    );
    guard(c);
    return {
      characterID: c.run.characterID,
      shipID: c.shipID,
      moduleID: m.itemID,
      typeID: m.typeID,
      flagID,
      effectID,
      online: m.online && module.online,
      active: module.effects.some((e) => e.effectID === effectID),
      observedAt: Date.now(),
    };
  };
  const observe = async (): Promise<BurstObservation> => {
    guard(c);
    const raw = await loadFitting(opts(c));
    guard(c);
    if (raw.activeShipID !== c.shipID || Object.values(raw.errors).some((v) => v !== null))
      throw Error("Burst fitting is unreadable.");
    const slots = buildSlots(raw.slots, raw.shipInfo, raw.online),
      matches = slots.filter(
        (s) =>
          s.family === "high" &&
          s.module?.itemID === config.moduleID &&
          s.module.typeID === config.typeID,
      );
    if (matches.length !== 1 || !matches[0]!.module)
      throw Error("Exact burst module is not fitted.");
    const slot = matches[0]!,
      m = slot.module!,
      flagID = slotFlagOf(slot.family, slot.index);
    if (!flagID || m.groupID !== 1770) throw Error("Burst module identity or slot is unreadable.");
    let charge = m.charge;
    if (!charge) {
      try {
        guard(c);
        const before = decodeFlightStatus((await getFlightStatus(opts(c))).flight);
        guard(c);
        const dogma = await boundDogma(opts(c));
        guard(c);
        const after = decodeFlightStatus((await getFlightStatus(opts(c))).flight);
        guard(c);
        charge = resolveDogmaCharge({
          before,
          after,
          dogma,
          characterID: c.run.characterID,
          shipID: c.shipID,
          flagID,
        });
      } catch (error) {
        guard(c);
        if (error instanceof Error && error.message.startsWith("Cached charge unavailable;"))
          throw error;
        throw Error("Cached charge unavailable; native dogma or flight read failed.");
      }
    }
    if (
      !charge ||
      !id(charge.typeID) ||
      !Number.isSafeInteger(charge.quantity) ||
      charge.quantity < 0
    )
      throw Error("Burst charge type or quantity is unreadable.");
    const staticData = await json(
        `/api/client-data/dogma-types?typeIDs=${config.typeID},${charge.typeID}`,
      ),
      type = staticData.types?.[config.typeID],
      effectID = type?.defaultEffectID,
      effectName = staticData.effects?.[effectID]?.name;
    if (
      staticData.available !== true ||
      type?.groupID !== 1770 ||
      !id(effectID) ||
      typeof effectName !== "string" ||
      effectName.toLowerCase() !== "modulebonuswarfarelinkmining"
    )
      throw Error("Fitted module is not a native mining burst.");
    const effectCollections = chargeEffectCollections(staticData.types?.[charge.typeID]);
    guard(c);
    const module = decodeModuleObservation(
      await c.session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [m.itemID]),
      {
        moduleID: m.itemID,
        typeID: m.typeID,
        ownerID: c.run.characterID,
        shipID: c.shipID,
        flagID,
      },
    );
    guard(c);
    const range = module.attributes?.[54],
      cycle = module.attributes?.[73];
    if (!Number.isFinite(range) || !Number.isFinite(cycle) || range! <= 0 || cycle! <= 0)
      throw Error("Effective burst range or cycle is unreadable.");
    const flight = decodeFlightStatus((await getFlightStatus(opts(c))).flight);
    guard(c);
    if (!flight.inSpace || flight.shipID !== c.shipID || !id(flight.solarSystemID))
      throw Error("Commander flight scope changed.");
    const scene = await readMiningReadiness(
      c.run,
      c.session,
      c.shipID,
      flight.solarSystemID,
      c.current,
    );
    guard(c);
    if (!scene.ready) throw Error("Commander flight is not ready.");
    const emitter = scene.space.ship!,
      services = emitter.miningBurstServices,
      active = module.effects.some((e) => e.effectID === effectID),
      facts =
        services?.bursts.filter((x) => x.moduleID === m.itemID && x.typeID === m.typeID) ?? [];
    if (
      services &&
      active &&
      (!services.activeModuleIDs.includes(m.itemID) ||
        facts.length !== 1 ||
        facts[0]!.effectID !== effectID ||
        facts[0]!.effectName?.toLowerCase() !== "modulebonuswarfarelinkmining")
    )
      throw Error("Native burst effect is uncertain.");
    const fleet = async (h: Held) => {
      guard(h);
      const f = decodeFleetCenter(await loadBoundFleet(opts(h)));
      guard(h);
      const ids = authoritativeFleetMemberCharacterIDs(f),
        fleetID = Number(f.fleet.initState.value.fleetID);
      if (
        f.availability !== "ready" ||
        !id(fleetID) ||
        !ids ||
        f.fleet.initState.value.members.length !== ids.length
      )
        throw Error("Native fleet roster is unreadable.");
      return { fleetID, ids };
    };
    const expected = [c.run.characterID, ...recipients.map((r) => r.run.characterID)].sort(
        (a, b) => a - b,
      ),
      fleets = await Promise.all([c, ...recipients].map(fleet));
    if (
      fleets.some(
        (f) => f.fleetID !== fleets[0]!.fleetID || expected.some((n) => !f.ids.includes(n)),
      )
    )
      throw Error("Native fleet does not contain the selected roster.");
    const rows = [];
    for (const h of recipients) {
      guard(h);
      const f = decodeFlightStatus((await getFlightStatus(opts(h))).flight);
      guard(h);
      if (!f.inSpace || f.shipID !== h.shipID || f.solarSystemID !== flight.solarSystemID)
        throw Error("Burst recipient flight changed.");
      const recipientScene = await readMiningReadiness(
        h.run,
        h.session,
        h.shipID,
        flight.solarSystemID,
        h.current,
      );
      guard(h);
      if (!recipientScene.ready) throw Error("Burst recipient flight is not ready.");
      const entity = scene.space.entities.find((e) => e.itemID === h.shipID);
      if (!entity || !entity.geometryAvailable || entity.characterID !== h.run.characterID)
        throw Error("Burst recipient grid identity is unreadable.");
      const d = Math.max(
        0,
        Math.hypot(
          entity.position.x - emitter.position.x,
          entity.position.y - emitter.position.y,
          entity.position.z - emitter.position.z,
        ) -
          entity.radius -
          emitter.radius,
      );
      const buffBar = h.session.flow.buffBar.get();
      if (!Number.isFinite(buffBar.clockOffsetMs))
        throw Error("Recipient buff clock is unreadable.");
      const incoming = buffBar.incoming;
      rows.push({
        characterID: h.run.characterID,
        shipID: h.shipID,
        inFleet: true,
        distanceMeters: d,
        buffs: [...incoming].map(([collectionID, v]) => ({
          collectionID,
          value: v.value,
          expiresMs: v.expiresMs === null ? null : v.expiresMs - buffBar.clockOffsetMs,
        })),
      });
      guard(h);
    }
    return {
      characterID: c.run.characterID,
      shipID: c.shipID,
      moduleID: m.itemID,
      typeID: m.typeID,
      flagID,
      effectID,
      chargeTypeID: charge.typeID,
      chargeItemID: typeof charge.itemID === "number" ? charge.itemID : null,
      chargeQuantity: charge.quantity,
      cycleMs: cycle!,
      rangeMeters: range!,
      online: m.online && module.online,
      active,
      observedAt: Date.now(),
      recipients: rows,
      effectCollections,
    };
  };
  const current = () => guard(c),
    activationCurrent = () => {
      guard(c);
      for (const h of recipients) guard(h);
    };
  const controller = createBurstController({
    identity: {
      operationID: config.operationID,
      runID: config.runID,
      characterID: c.run.characterID,
      shipID: c.shipID,
      moduleID: config.moduleID,
      typeID: config.typeID,
    },
    document: config.document,
    current,
    activationCurrent,
    observe,
    observeOwn,
    activate: () =>
      c.session.flow.flying.bridgeDo("dogmaIM", "Activate", [
        config.moduleID,
        "moduleBonusWarfareLinkMining",
        null,
        0,
      ]),
    deactivate: () =>
      c.session.flow.flying.bridgeDo("dogmaIM", "Deactivate", [
        config.moduleID,
        "moduleBonusWarfareLinkMining",
      ]),
  });
  return { ...controller, observe, observeOwn };
}
