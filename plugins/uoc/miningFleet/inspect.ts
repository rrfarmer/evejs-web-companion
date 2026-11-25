import { decodeSupplyTargets, inspectSupplies, type SupplyTarget } from "./supplyInspect.ts";
import {
  freightHoldFlags,
  resourceBays,
  generalFreightBays,
  haulerBaysPath,
  haulerInventoryFlags,
} from "../shared/freightHolds.ts";
import { inspectDefenderCapability } from "../combat/defenderCapability.ts";
import { miningMissionFit } from "../mining/miningMission.ts";
import { readNativeShipHolds, type NativeInventoryRow } from "../shared/nativeInventory.ts";
import { decodeModuleObservation } from "../shared/moduleObservation.ts";
import { chargeEffectCollections } from "./support/chargeEffects.ts";
import type { BackendRun, PluginRunContext } from "../../../web/src/plugin-api/backend.ts";
import {
  decodeFlightStatus,
  officeAt,
  decodeFleetCenter,
  authoritativeFleetMemberCharacterIDs,
  loadFitting,
  buildSlots,
  fetchTypeDogma,
  slotFlagOf,
} from "../../../web/src/plugin-api/flying.ts";
import { readJettisonCapacity } from "./canCapacity.ts";
import { decodeNativeSites } from "./siteDiscovery.ts";
import { createPilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { createIndustrialCoreObservation } from "./support/industrialObservation.ts";
import { readMiningOfficeAccess, requireMiningOfficeQuery } from "./corporateOffice.ts";

const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
type CorporateDestination = { locationID: number; corporationID: number; division: number };
function isCorporateDestination(value: unknown): value is CorporateDestination {
  const v = value as Partial<CorporateDestination> | null;
  return (
    !!v &&
    positive(v.locationID) &&
    positive(v.corporationID) &&
    positive(v.division) &&
    v.division <= 7
  );
}
export function inspectFleet(
  raw: unknown,
  characterID: number,
): { state: "not-in-fleet" } | { state: "ready"; fleetID: number; memberIDs: readonly number[] } {
  const state = decodeFleetCenter(raw as Parameters<typeof decodeFleetCenter>[0]);
  if (state.availability === "not-in-fleet") return { state: "not-in-fleet" as const };
  const memberIDs = authoritativeFleetMemberCharacterIDs(state),
    fleetID = Number(state.fleet.initState.value.fleetID);
  if (
    state.availability !== "ready" ||
    !positive(fleetID) ||
    !memberIDs ||
    !memberIDs.includes(characterID) ||
    state.fleet.initState.value.members.length !== memberIDs.length ||
    new Set(memberIDs).size !== memberIDs.length
  )
    throw Error("Native fleet membership is unreadable.");
  return { state: "ready" as const, fleetID, memberIDs };
}
export function splitMiningSites(sites: ReturnType<typeof decodeNativeSites>) {
  return {
    oreSites: sites.filter((s) => s.siteFamily === "ORE"),
    moonSites: sites.filter((s) => s.siteFamily === "MOON"),
    iceSites: sites.filter((s) => s.siteFamily === "ICE"),
    unknownSites: sites.filter((s) => s.siteFamily === "UNKNOWN"),
  };
}
export type FleetFitHoldQualification = {
  ORE: { miner: boolean; hauler: boolean };
  ICE: { miner: boolean; hauler: boolean };
};
/** Module family comes from the native dogma classifier; holds and owner rows must agree. */
export function qualifyFleetFitHolds(
  shipID: number,
  modules: readonly { family: "ore" | "ice"; range: number; cycleMs: number }[],
  panel: unknown,
  rows: readonly NativeInventoryRow[],
): FleetFitHoldQualification {
  const data = panel as any,
    flags = freightHoldFlags;
  const invalid = () => Error("Native fleet hold observations are unreadable.");
  if (
    !data ||
    data.shipID !== shipID ||
    data.activeShipID !== shipID ||
    !Array.isArray(data.bays) ||
    !data.bays.length ||
    new Set(data.bays.map((h: any) => h?.key)).size !== data.bays.length
  )
    throw invalid();
  const free = new Set<string>();
  for (const h of data.bays) {
    if (!h || !Object.hasOwn(flags, h.key)) throw invalid();
    // An unreadable optional fleet hangar cannot disqualify the ship's verified mining or cargo hold.
    if (h.key === "fleet" && (h.present === null || h.error)) continue;
    if (
      typeof h.present !== "boolean" ||
      h.error !== null ||
      !h.capacity ||
      !Number.isFinite(h.capacity.capacity) ||
      !Number.isFinite(h.capacity.used) ||
      h.capacity.capacity < 0 ||
      h.capacity.used < 0 ||
      h.capacity.used > h.capacity.capacity ||
      (h.present
        ? !Array.isArray(h.items)
        : h.items != null && (!Array.isArray(h.items) || h.items.length > 0)) ||
      (!h.present && rows.some((r) => r.flagID === flags[h.key]))
    )
      throw invalid();
    if (h.present && h.capacity.capacity > h.capacity.used) free.add(h.key);
  }
  const space = (family: "ore" | "ice", hauler: boolean) => {
    const keys = [...resourceBays(family), ...(hauler ? generalFreightBays : ["cargo"])];
    return keys.some((key) => free.has(key));
  };
  const fit = (family: "ore" | "ice") =>
    modules.some(
      (m) =>
        m.family === family &&
        Number.isFinite(m.range) &&
        m.range > 0 &&
        Number.isFinite(m.cycleMs) &&
        m.cycleMs > 0,
    );
  return {
    ORE: { miner: fit("ore") && space("ore", false), hauler: space("ore", true) },
    ICE: { miner: fit("ice") && space("ice", false), hauler: space("ice", true) },
  };
}
/** Read-only, host-selected pilot inspection. No fleet, inventory or movement writes. */
export const miningFleetInspectRun: BackendRun = {
  check(input) {
    const x =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as {
            systemID?: unknown;
            supplies?: unknown;
            officeLocationID?: unknown;
            corporateDestinations?: unknown;
            equipmentReview?: unknown;
            commandModules?: unknown;
            refreshOnly?: unknown;
          })
        : null;
    if (x && Object.keys(x).length === 1 && positive(x.officeLocationID))
      return {
        ok: true,
        setup: { officeLocationID: x.officeLocationID },
        name: "Inspect corporate delivery access",
        policy: { riskClasses: [], restartSafe: false },
      };
    const destinations = x?.corporateDestinations;
    return x &&
      Object.keys(x).every(
        (k) =>
          k === "systemID" ||
          k === "supplies" ||
          k === "corporateDestinations" ||
          k === "equipmentReview" ||
          k === "commandModules" ||
          k === "refreshOnly",
      ) &&
      (x.systemID === undefined || positive(x.systemID)) &&
      (x.supplies === undefined || decodeSupplyTargets(x.supplies) !== null) &&
      [x.equipmentReview, x.commandModules, x.refreshOnly].every(
        (v) => v === undefined || typeof v === "boolean",
      ) &&
      (destinations === undefined ||
        (Array.isArray(destinations) &&
          destinations.length <= 2 &&
          destinations.every(isCorporateDestination)))
      ? {
          ok: true,
          setup: {
            ...(x.systemID === undefined ? {} : { systemID: x.systemID }),
            ...(x.supplies === undefined ? {} : { supplies: decodeSupplyTargets(x.supplies)! }),
            ...(x.equipmentReview === undefined ? {} : { equipmentReview: x.equipmentReview }),
            ...(x.commandModules === undefined ? {} : { commandModules: x.commandModules }),
            ...(x.refreshOnly === true ? { refreshOnly: true } : {}),
            ...(destinations
              ? {
                  corporateDestinations: destinations.map(
                    ({ locationID, corporationID, division }) => ({
                      locationID,
                      corporationID,
                      division,
                    }),
                  ),
                }
              : {}),
          } as any,
          name: "Inspect fleet pilot",
          policy: { riskClasses: [], restartSafe: false },
        }
      : { ok: false, refusal: "Choose a valid target system for fleet inspection." };
  },
  async start(run: PluginRunContext) {
    if (run.resumed || !positive(run.characterID) || run.held.characterID !== run.characterID)
      throw Error("Pilot inspection ownership is unavailable.");
    let active = true;
    const current = () => {
      if (!active) throw Error("Pilot inspection stopped.");
    };
    const json = async (route: string, body?: unknown) => {
      current();
      const response = await run.fetch(
        new URL(route, run.baseUrl),
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      const data = await response.json();
      current();
      if (!response.ok || data?.ok === false)
        throw Error(data?.message || data?.error || "Fleet inspection read failed.");
      return data;
    };
    const work = async () => {
      const character = run.held.character;
      const ask = async (service: string, method: string, args: readonly unknown[] = []) =>
        (await json("/api/bridge/call", { service, method, args, kwargs: null, pilot: true }))
          .result;
      const {
        officeLocationID,
        corporateDestinations = [],
        refreshOnly = false,
      } = (run.setup ?? {}) as {
        officeLocationID?: number;
        corporateDestinations?: CorporateDestination[];
        refreshOnly?: boolean;
      };
      if (positive(officeLocationID) || corporateDestinations.length) {
        if (character.characterID !== run.characterID || !positive(character.corporationID))
          throw Error("The held pilot and corporation must be known for office inspection.");
        const destinations = positive(officeLocationID)
          ? [officeLocationID]
          : corporateDestinations.map((d) => d.locationID);
        const readOffice = await readMiningOfficeAccess(
          { characterID: run.characterID, corporationID: character.corporationID },
          destinations,
          json,
          (method, args) => ask("corpRegistry", method, args),
        );
        if (positive(officeLocationID)) {
          run.report({
            status: "stopped",
            phase: "Corporate delivery access inspected",
            readout: readOffice(officeLocationID),
          });
          return;
        }
        for (const { locationID, corporationID, division } of corporateDestinations)
          requireMiningOfficeQuery(readOffice(locationID), corporationID, division);
      }
      const flight = decodeFlightStatus((await json("/api/bridge/flight/status")).flight),
        dockID = flight.stationID ?? flight.structureID;
      const located = flight.docked
        ? !flight.inSpace && positive(dockID)
        : flight.inSpace && dockID === null;
      if (
        character.characterID !== run.characterID ||
        !positive(character.corporationID) ||
        !positive(flight.shipID) ||
        flight.shipIsCapsule === true ||
        !positive(flight.solarSystemID) ||
        !located
      )
        throw Error("The held pilot's ship, corporation or location could not be verified.");
      const sameLocation = (after: typeof flight) =>
        after.shipID === flight.shipID &&
        after.solarSystemID === flight.solarSystemID &&
        after.docked === flight.docked &&
        after.inSpace === flight.inSpace &&
        after.stationID === flight.stationID &&
        after.structureID === flight.structureID;
      const requestedSystem =
        (run.setup as { systemID?: number } | undefined)?.systemID ?? flight.solarSystemID;
      let oreSites: ReturnType<typeof decodeNativeSites> | null = null,
        moonSites: ReturnType<typeof decodeNativeSites> | null = null;
      let iceSites: ReturnType<typeof decodeNativeSites> | null = null,
        unknownSites: ReturnType<typeof decodeNativeSites> | null = null;
      if (!refreshOnly && requestedSystem === flight.solarSystemID)
        try {
          const raw = await ask("scanMgr", "GetFullState"),
            after = decodeFlightStatus((await json("/api/bridge/flight/status")).flight);
          if (sameLocation(after))
            ({ oreSites, moonSites, iceSites, unknownSites } = splitMiningSites(
              decodeNativeSites(raw, flight.solarSystemID, Date.now()),
            ));
        } catch {
          /* Scanner data is optional at inspection. */
        }
      const [office, objects, canCapacityM3, boundFleet] = await Promise.all([
        refreshOnly || dockID === null ? null : officeAt(ask, dockID),
        refreshOnly ? null : json(`/api/client-data/system-objects/${requestedSystem}`),
        refreshOnly ? null : readJettisonCapacity(run, current),
        json("/api/bridge/bound-fleet?view=menu"),
      ]);
      const fleet = inspectFleet(boundFleet, run.characterID);
      const { equipmentReview = true, commandModules = true } = run.setup as {
        equipmentReview?: boolean;
        commandModules?: boolean;
      };
      let miningBursts:
        | {
            moduleID: number;
            typeID: number;
            name: string | null;
            online: boolean;
            chargeTypeID: number | null;
            chargeQuantity: number | null;
            chargeSupported: boolean;
          }[]
        | null = null;
      if (commandModules)
        try {
          const fit = await loadFitting({ baseUrl: run.baseUrl, fetch: run.fetch });
          current();
          if (
            fit.activeShipID !== flight.shipID ||
            Object.values(fit.errors).some((v) => v !== null)
          )
            throw Error("Fitting unavailable.");
          const modules = buildSlots(fit.slots, fit.shipInfo, fit.online)
            .filter((s) => s.family === "high" && s.module?.groupID === 1770)
            .map((s) => s.module!);
          miningBursts = [];
          for (const m of modules) {
            if (!positive(m.itemID) || !positive(m.typeID))
              throw Error("Fitting identity unavailable.");
            const data = await json(`/api/client-data/dogma-types?typeIDs=${m.typeID}`),
              type = data.types?.[m.typeID],
              effect = type?.defaultEffectID;
            if (
              data.available !== true ||
              type?.groupID !== 1770 ||
              !positive(effect) ||
              typeof data.effects?.[effect]?.name !== "string"
            )
              throw Error("Burst effect unavailable.");
            if (data.effects[effect].name.toLowerCase() !== "modulebonuswarfarelinkmining")
              continue;
            const charge = m.charge;
            if (
              charge &&
              (!positive(charge.typeID) ||
                !Number.isSafeInteger(charge.quantity) ||
                charge.quantity < 0)
            )
              throw Error("Burst charge unavailable.");
            let chargeSupported = false;
            if (charge) {
              const facts = await json(`/api/client-data/dogma-types?typeIDs=${charge.typeID}`),
                t = facts.types?.[charge.typeID];
              if (facts.available !== true || !t || !Array.isArray(t.attributes))
                throw Error("Burst charge type unavailable.");
              try {
                chargeSupported = chargeEffectCollections(t).length > 0;
              } catch {
                chargeSupported = false;
              }
            }
            let name: string | null = null;
            try {
              const named = await json("/api/names", { items: [{ kind: "type", id: m.typeID }] });
              const v = named.names?.[`type:${m.typeID}`];
              if (typeof v === "string" && v.trim()) name = v.trim();
            } catch {}
            miningBursts.push({
              moduleID: m.itemID,
              typeID: m.typeID,
              name,
              online: m.online,
              chargeTypeID: charge?.typeID ?? null,
              chargeQuantity: charge?.quantity ?? null,
              chargeSupported,
            });
          }
        } catch {
          miningBursts = null;
        }
      let industrialCores:
        | {
            moduleID: number;
            typeID: number;
            online: boolean;
            availability: "available" | "unknown";
            fuel: {
              availability: "available" | "unknown";
              requiredQuantity?: number;
              availableQuantity?: number;
              sufficient?: boolean;
            } | null;
          }[]
        | null = null;
      if (commandModules)
        try {
          const fit = await loadFitting({ baseUrl: run.baseUrl, fetch: run.fetch });
          current();
          if (
            fit.activeShipID !== flight.shipID ||
            fit.errors.slots !== null ||
            fit.errors.shipInfo !== null ||
            fit.errors.online !== null
          )
            throw Error("Core fitting unavailable.");
          const modules = buildSlots(fit.slots, fit.shipInfo, fit.online)
            .filter((s) => s.family === "high" && s.module?.groupID === 515)
            .map((s) => s.module!);
          if (modules.some((m) => !positive(m.itemID) || !positive(m.typeID)))
            throw Error("Core fitting identity unavailable.");
          industrialCores = [];
          if (modules.some((m) => m.online)) {
            const session = await createPilotSession(run);
            try {
              for (const m of modules) {
                if (!m.online) {
                  industrialCores.push({
                    moduleID: m.itemID,
                    typeID: m.typeID,
                    online: false,
                    availability: "unknown",
                    fuel: null,
                  });
                  continue;
                }
                const observed = await createIndustrialCoreObservation({
                  operationID: "inspection",
                  runID: run.botID,
                  run,
                  session,
                  shipID: flight.shipID!,
                  moduleID: m.itemID,
                  typeID: m.typeID,
                  sessionGeneration: session.flow.flying.sessionGeneration(),
                  current,
                }).observe();
                current();
                industrialCores.push({
                  moduleID: m.itemID,
                  typeID: m.typeID,
                  online: true,
                  availability: observed.availability,
                  fuel: observed.availability === "available" ? observed.fuel : null,
                });
              }
            } finally {
              session.flow.setLivePush(false);
            }
          } else
            for (const m of modules)
              industrialCores.push({
                moduleID: m.itemID,
                typeID: m.typeID,
                online: false,
                availability: "unknown",
                fuel: null,
              });
        } catch {
          current();
          industrialCores = null;
        }
      let compressors: { moduleID: number; typeID: number; online: boolean }[] | null = null,
        tractors: { moduleID: number; typeID: number; online: boolean }[] | null = null;
      if (commandModules)
        try {
          const fit = await loadFitting({ baseUrl: run.baseUrl, fetch: run.fetch });
          current();
          if (
            fit.activeShipID !== flight.shipID ||
            fit.errors.slots !== null ||
            fit.errors.shipInfo !== null ||
            fit.errors.online !== null
          )
            throw Error("Support fitting unavailable.");
          const modules = buildSlots(fit.slots, fit.shipInfo, fit.online)
            .filter(
              (s) =>
                s.family === "high" &&
                s.module &&
                (s.module.groupID === 4174 || s.module.groupID === 650),
            )
            .map((s) => s.module!);
          compressors = [];
          tractors = [];
          for (const m of modules) {
            if (!positive(m.itemID) || !positive(m.typeID))
              throw Error("Support module identity unavailable.");
            const data = await json(`/api/client-data/dogma-types?typeIDs=${m.typeID}`),
              type = data.types?.[m.typeID];
            if (data.available !== true || type?.categoryID !== 7 || !Array.isArray(type.effects))
              throw Error("Support module metadata unavailable.");
            const names = type.effects.map((id: number) => data.effects?.[id]?.name?.toLowerCase());
            if (m.groupID === 4174) {
              if (
                !names.includes("industrialitemcompression") ||
                !Array.isArray(type.attributes) ||
                !type.attributes.some(
                  (x: any) => Array.isArray(x) && x[0] === 3255 && positive(x[1]),
                ) ||
                !type.attributes.some((x: any) => Array.isArray(x) && x[0] === 3265 && x[1] === 1)
              )
                throw Error("Compressor type is unavailable.");
              compressors.push({ moduleID: m.itemID, typeID: m.typeID, online: m.online });
            } else if (names.includes("tractorbeamcan"))
              tractors.push({ moduleID: m.itemID, typeID: m.typeID, online: m.online });
          }
        } catch {
          current();
          compressors = null;
          tractors = null;
        }
      let fitHoldQualification: FleetFitHoldQualification | null = null;
      if (equipmentReview)
        try {
          const session = await createPilotSession(run);
          try {
            const fitting = await loadFitting({ baseUrl: run.baseUrl, fetch: run.fetch });
            current();
            if (
              fitting.activeShipID !== flight.shipID ||
              Object.values(fitting.errors).some((v) => v !== null)
            )
              throw Error("Native fitting is unreadable.");
            const slots = buildSlots(fitting.slots, fitting.shipInfo, fitting.online),
              high = slots.flatMap((slot) =>
                slot.family === "high" && slot.module ? [slot.module] : [],
              ),
              facts = await fetchTypeDogma(
                high.map((m) => m.typeID),
                [73, 77, 182, 183, 184, 1285, 1289, 1290],
                { baseUrl: run.baseUrl, fetch: run.fetch },
              );
            current();
            const selected = miningMissionFit(high, facts),
              modules: { family: "ore" | "ice"; range: number; cycleMs: number }[] = [];
            for (const m of selected) {
              const slot = slots.find((x) => x.module?.itemID === m.itemID),
                flagID = slot ? slotFlagOf(slot.family, slot.index) : null;
              if (!flagID) throw Error("Mining module slot is unknown.");
              const native = await decodeModuleObservation(
                await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [m.itemID]),
                {
                  moduleID: m.itemID,
                  typeID: m.typeID,
                  ownerID: run.characterID,
                  shipID: flight.shipID!,
                  flagID,
                },
              );
              current();
              const range = native.attributes?.[54],
                cycleMs = native.attributes?.[73];
              if (typeof range !== "number" || typeof cycleMs !== "number")
                throw Error("Native module range or cycle is unreadable.");
              modules.push({ family: m.family, range, cycleMs });
            }
            const rows = await readNativeShipHolds(
                session,
                current,
                run.characterID,
                flight.shipID!,
                haulerInventoryFlags,
              ),
              panel = await json(haulerBaysPath(flight.shipID!)),
              after = decodeFlightStatus((await json("/api/bridge/flight/status")).flight);
            if (!sameLocation(after)) throw Error("Fleet inspection flight scope changed.");
            fitHoldQualification = qualifyFleetFitHolds(flight.shipID!, modules, panel, rows);
          } finally {
            session.flow.setLivePush(false);
          }
        } catch {
          current();
          fitHoldQualification = null;
        }
      let defender: { qualified: boolean; reason: string | null; evidence: unknown } = {
        qualified: false,
        reason: "Native defender inspection unavailable.",
        evidence: null,
      };
      if (equipmentReview)
        try {
          const session = await createPilotSession(run);
          try {
            defender = await inspectDefenderCapability(run, session, current, {
              weaponExecutionEnabled: true,
              repairExecutionEnabled: true,
            });
          } finally {
            session.flow.setLivePush(false);
          }
        } catch {
          current();
        }
      let supplies: Awaited<ReturnType<typeof inspectSupplies>> | null = null;
      const requested = (run.setup as { supplies?: SupplyTarget[] } | undefined)?.supplies;
      if (requested) {
        try {
          const session = await createPilotSession(run);
          try {
            supplies = await inspectSupplies(run, session, flight.shipID!, requested, current);
          } finally {
            session.flow.setLivePush(false);
          }
        } catch {
          current();
          supplies = requested.map((t) => ({
            typeID: t.typeID,
            target: t.target,
            mode: t.mode,
            required: t.required,
            state: "UNKNOWN" as const,
            quantity: null,
            reason: "Supply inspection is unavailable.",
          }));
        }
      }
      if (supplies?.length)
        try {
          const names = await json("/api/names", {
            items: [...new Set(supplies.map((s) => s.typeID))].map((id) => ({ kind: "type", id })),
          });
          supplies = supplies.map((row) => {
            const value = names.names?.[`type:${row.typeID}`];
            return typeof value === "string" && value.trim() ? { ...row, name: value.trim() } : row;
          });
        } catch {
          current();
        }
      // Presentation names are best-effort native/client data; missing names never
      // change custody, inspection eligibility, or the reviewed setup.
      let stationName: string | null = null,
        systemName: string | null = null,
        corporationName: string | null = null,
        shipTypeName: string | null = null;
      if (!refreshOnly)
        try {
          const refs = [
              ...(dockID === null ? [] : [{ kind: "evelocation", id: dockID }]),
              { kind: "evelocation", id: flight.solarSystemID },
              { kind: "owner", id: character.corporationID },
              ...(positive(flight.shipTypeID) ? [{ kind: "type", id: flight.shipTypeID }] : []),
            ],
            named = await json("/api/names", { items: refs });
          if (named?.names && typeof named.names === "object" && !Array.isArray(named.names)) {
            const get = (key: string) => {
              const value = named.names[key];
              return typeof value === "string" && value.trim() ? value.trim() : null;
            };
            stationName = dockID === null ? null : get(`evelocation:${dockID}`);
            systemName = get(`evelocation:${flight.solarSystemID}`);
            corporationName = get(`owner:${character.corporationID}`);
            if (positive(flight.shipTypeID)) shipTypeName = get(`type:${flight.shipTypeID}`);
          }
        } catch {
          /* Names are optional and must not prevent the operation. */
        }
      if (!refreshOnly && (!objects?.available || !Array.isArray(objects.objects)))
        throw Error("System belt catalogue is unavailable.");
      const beltIDs = refreshOnly
        ? []
        : objects.objects
            .filter((r: any) => r?.groupID === 9 && positive(r.itemID))
            .map((r: any) => r.itemID as number);
      const belts: { itemID: number; name: string }[] = [];
      // The map gives belt IDs; the held pilot's public cfg.evelocations read
      // supplies the world's actual item names (not client-formatted guesses).
      for (let i = 0; i < beltIDs.length; i += 50) {
        const ids = beltIDs.slice(i, i + 50),
          named = await json("/api/names", {
            items: ids.map((id: number) => ({ kind: "evelocation", id })),
          });
        if (!named.names || typeof named.names !== "object" || named.capped === true)
          throw Error("Native belt names are unavailable.");
        for (const id of ids) {
          const name = named.names[`evelocation:${id}`];
          if (typeof name === "string" && name.trim())
            belts.push({ itemID: id, name: name.trim() });
        }
      }
      if (new Set(belts.map((b: { itemID: number }) => b.itemID)).size !== belts.length)
        throw Error("System belt identities are ambiguous.");
      current();
      run.report({
        status: "stopped",
        phase: "Fleet pilot inspected",
        readout: {
          characterID: run.characterID,
          shipID: flight.shipID,
          shipTypeID: flight.shipTypeID,
          shipTypeName,
          stationID: dockID,
          ...(dockID === null
            ? { inSpace: true }
            : { dockKind: flight.structureID ? "structure" : "station" }),
          stationName,
          systemID: flight.solarSystemID,
          systemName,
          corporationID: character.corporationID,
          corporationName,
          officeID: office,
          belts,
          oreSites: oreSites as any,
          moonSites: moonSites as any,
          iceSites: iceSites as any,
          unknownSites: unknownSites as any,
          miningBursts,
          industrialCores,
          compressors,
          tractors,
          fitHoldQualification,
          defender: defender as any,
          supplies,
          fleet,
          canCapacityM3,
          targetSystemID: requestedSystem,
          observedAt: Date.now(),
        },
      });
    };
    const running = work().catch((e) => {
      if (active)
        run.report({
          status: "error",
          phase: "Fleet inspection failed",
          why: e instanceof Error ? e.message : String(e),
        });
    });
    return {
      async stop() {
        active = false;
        await running;
      },
    };
  },
};
