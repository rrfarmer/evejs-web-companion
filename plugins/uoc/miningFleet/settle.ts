import {
  buildSlots,
  slotFlagOf,
  loadFitting,
  decodeDroneLimits,
  decodeFlightStatus,
  decodeSpaceSnapshot,
  getDrones,
  getFlightStatus,
  getSpaceSnapshot,
} from "../../../web/src/plugin-api/flying.ts";
import { getScriptObservation } from "../compat/flying.ts";
import type { PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import type { FleetSetup } from "./runtime.ts";
import { assertFleetDroneDeparture, recallFleetDrones } from "./droneRecall.ts";
export type FleetSettlementOptions = {
  expectedDrones?: readonly number[];
  report?: (message: string) => void;
  parkAfterRecallFailure?: () => Promise<void>;
  verifyRetainedModules?: () => Promise<void>;
};
import { decodeModuleObservation } from "../shared/moduleObservation.ts";
/** Strict no-active-module/no-drones proof for the raw slice; unsafe flights pause for native recovery. */
export async function settleFleetMember(
  run: PluginRunContext,
  session: PilotSession,
  current: () => void,
  droneOptions?: FleetSettlementOptions,
): Promise<{ modulesInactive: true; dronesSafe: true; observedAt: number }> {
  const setup = run.setup as unknown as FleetSetup,
    member = setup.members?.find((m) => m.characterID === run.characterID);
  if (!member) throw Error("Fleet pilot is outside the operation roster.");
  const options = { ...session.flow.requestOptions(), baseUrl: run.baseUrl, fetch: run.fetch };
  current();
  const flight = decodeFlightStatus((await getFlightStatus(options)).flight);
  current();
  const retained = droneOptions?.verifyRetainedModules;
  const observation = retained && flight.inSpace ? await getScriptObservation(options) : null;
  const drones = observation ?? (await getDrones(options));
  current();
  if (
    flight.shipID !== member.shipID ||
    drones.activeShipID !== member.shipID ||
    !Array.isArray(drones.bay) ||
    !Array.isArray(drones.inSpace) ||
    (!droneOptions && drones.inSpace.length !== 0) ||
    ["bay", "shipInfo", "inSpace"].some(
      (key) => !Object.hasOwn(drones.errors, key) || drones.errors[key] !== null,
    )
  )
    throw Error("Drone or held-ship settlement is unknown; recall/reconciliation is required.");
  if (retained) {
    if (flight.transition && flight.transition.phase !== "ready")
      throw Object.assign(Error("The held ship is still changing location."), {
        code: "SESSION_CHANGE_IN_PROGRESS",
      });
    if (observation) {
      const scene = decodeSpaceSnapshot(observation.space);
      if (
        !scene.inSpace ||
        scene.shipID !== member.shipID ||
        scene.solarSystemID !== flight.solarSystemID ||
        (scene.ship &&
          (scene.ship.itemID !== member.shipID ||
            (scene.ship.characterID != null && scene.ship.characterID !== run.characterID)))
      )
        throw Error("The drone scene does not match the held pilot, ship and system.");
      const noDroneCapacity =
        decodeDroneLimits(drones.shipInfo).droneBandwidth === 0 &&
        drones.bay.length === 0 &&
        drones.inSpace.length === 0;
      if ((scene.stateValid === false || !scene.ship) && !noDroneCapacity)
        throw Object.assign(
          Error("The held ship's drone scene is not ready; drone disposition is unverified."),
          { code: "SESSION_CHANGE_IN_PROGRESS" },
        );
    } else if (!flight.docked || !(flight.stationID ?? flight.structureID) || drones.inSpace.length)
      throw Error("A stable native dock and no in-space drones are required to settle this ship.");
  }
  let parkAfterRecall = false;
  if (droneOptions && (drones.inSpace.length > 0 || droneOptions.expectedDrones?.length)) {
    const result = await recallFleetDrones(run, session, member.shipID, current, {
      pendingLaunch: droneOptions.expectedDrones,
      onProgress: droneOptions.report,
    });
    parkAfterRecall = result.stillControlled.length > 0 && !!droneOptions.parkAfterRecallFailure;
    const warning = parkAfterRecall
      ? "Drone return did not finish. Leaving drone IDs " +
        result.unrecovered.join(", ") +
        " behind for Stop."
      : assertFleetDroneDeparture(result);
    if (warning) droneOptions.report?.(warning);
  }
  if (retained) {
    await retained();
    current();
    const after = decodeFlightStatus((await getFlightStatus(options)).flight);
    current();
    if (
      after.shipID !== flight.shipID ||
      after.solarSystemID !== flight.solarSystemID ||
      after.inSpace !== flight.inSpace ||
      after.docked !== flight.docked ||
      after.stationID !== flight.stationID ||
      after.structureID !== flight.structureID ||
      (after.transition && after.transition.phase !== "ready")
    )
      throw Object.assign(
        Error("The held ship's location changed during settlement; it will be checked again."),
        { code: "SESSION_CHANGE_IN_PROGRESS" },
      );
  } else if (flight.inSpace) {
    const space = decodeSpaceSnapshot((await getSpaceSnapshot(options)).space);
    current();
    if (
      space.stateValid === false ||
      space.shipID !== member.shipID ||
      space.ship?.itemID !== member.shipID ||
      (space.ship.characterID != null && space.ship.characterID !== run.characterID)
    )
      throw Error("Native module shutdown is unknown; settlement is required.");
    if (Array.isArray(space.ship.activeModuleIDs)) {
      if (space.ship.activeModuleIDs.length)
        throw Error("Native module shutdown is unknown; settlement is required.");
    } else {
      const fit = await loadFitting(options);
      current();
      if (fit.activeShipID !== member.shipID || Object.values(fit.errors).some((x) => x !== null))
        throw Error("Native module fitting is unknown.");
      const raw = fit.slots as { type?: unknown; items?: unknown[] } | null;
      if (!raw || raw.type !== "list" || !Array.isArray(raw.items))
        throw Error("Native fitted module list is unreadable.");
      const rawModules: number[] = [];
      for (const entry of raw.items) {
        const e = entry as {
          type?: unknown;
          fields?: unknown;
          categoryID?: unknown;
          itemID?: unknown;
        };
        const row = (e?.type === "packedrow" ? e.fields : e) as {
          categoryID?: unknown;
          itemID?: unknown;
        } | null;
        if (!row || ![7, 8].includes(Number(row.categoryID)))
          throw Error("A fitted item category is unknown.");
        if (row.categoryID === 7) {
          if (
            typeof row.itemID !== "number" ||
            !Number.isSafeInteger(row.itemID) ||
            row.itemID <= 0 ||
            rawModules.includes(row.itemID)
          )
            throw Error("A fitted module identity is unknown.");
          rawModules.push(row.itemID);
        }
      }
      const slots = buildSlots(fit.slots, fit.shipInfo, fit.online),
        modules = slots.flatMap((s) => (s.module ? [s.module.itemID] : []));
      if (modules.length !== rawModules.length || rawModules.some((id) => !modules.includes(id)))
        throw Error("The native fitting projection omitted a module.");
      for (const slot of slots) {
        if (!slot.module) continue;
        const flagID = slotFlagOf(slot.family, slot.index);
        if (!flagID) throw Error("A fitted module slot is unknown.");
        const module = slot.module,
          raw = await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [module.itemID]);
        current();
        const observed = decodeModuleObservation(raw, {
          moduleID: module.itemID,
          typeID: module.typeID,
          ownerID: run.characterID,
          shipID: member.shipID,
          flagID,
        });
        if (observed.effects.some((effect) => effect.effectID !== 16))
          throw Error("A native fitted module remains active; settlement is required.");
      }
    }
  } else if (!flight.docked || (flight.stationID ?? flight.structureID) === null)
    throw Error("The pilot's physical location is unknown.");
  if (parkAfterRecall) {
    await droneOptions!.parkAfterRecallFailure!();
    current();
    const [dock, after] = await Promise.all([getFlightStatus(options), getDrones(options)]);
    current();
    const observed = decodeFlightStatus(dock.flight);
    if (
      !observed.docked ||
      observed.shipID !== member.shipID ||
      !(observed.stationID ?? observed.structureID) ||
      after.activeShipID !== member.shipID ||
      after.errors?.inSpace !== null ||
      !Array.isArray(after.inSpace) ||
      after.inSpace.some((row) => (row as { controlled?: unknown })?.controlled !== false)
    )
      throw Error("The held ship's docking or controlled-drone disposition is still unknown.");
  }
  return { modulesInactive: true, dronesSafe: true, observedAt: Date.now() };
}
