import type { BackendRun } from "../../../../web/src/plugin-api/backend.ts";
import { createPilotSession } from "../../../../web/src/plugin-api/pilotSession.ts";
import {
  decodeFlightStatus,
  getFlightStatus,
  loadBoundFleet,
} from "../../../../web/src/plugin-api/flying.ts";
import { bundledCombatCatalog } from "./catalog.ts";
import { createCombatDiscovery } from "./nativeDiscovery.ts";
import { decodeNativeFittingResources } from "../../provisioning/resourceQualification.ts";
import { inspectFleet } from "../../miningFleet/inspect.ts";
import { checkedInventory } from "../../shared/nativeInventory.ts";
import { combatFitModules } from "../moduleFit.ts";
import { readCombatShipClass } from "../anchor.ts";
/** Inspection has no movement, fleet or combat writes; catalog qualification stays server-owned. */
export function createAnomalyInspectRun(
  deps: { attach?: typeof createPilotSession; catalog?: typeof bundledCombatCatalog } = {},
): BackendRun {
  return {
    check(input) {
      return input &&
        typeof input === "object" &&
        !Array.isArray(input) &&
        Object.keys(input).length === 0
        ? {
            ok: true,
            setup: {},
            name: "Inspect combat anomalies",
            policy: { riskClasses: [], restartSafe: false },
          }
        : { ok: false, refusal: "Combat anomaly inspection takes no setup." };
    },
    async start(run) {
      if (run.resumed || run.held.characterID !== run.characterID)
        throw Error("Held anomaly inspector identity is invalid.");
      let active = true;
      const session = await (deps.attach ?? createPilotSession)(run),
        generation = session.flow.flying.sessionGeneration();
      const current = () => {
        if (
          !active ||
          session.flow.flying.isSessionClosing() ||
          session.flow.flying.sessionGeneration() !== generation ||
          session.store.station.get().online?.characterID !== run.characterID
        )
          throw Error("Held anomaly inspector changed.");
      };
      const work = (async () => {
        current();
        const options = {
            ...session.flow.requestOptions(),
            baseUrl: run.baseUrl,
            fetch: run.fetch,
          },
          f = decodeFlightStatus((await getFlightStatus(options)).flight);
        current();
        const dockID = f.stationID ?? f.structureID,
          dockKind = f.structureID ? "structure" : "station";
        if (
          !f.shipID ||
          !f.solarSystemID ||
          !f.docked ||
          f.inSpace ||
          !dockID ||
          (f.transition && f.transition.phase !== "ready")
        )
          throw Error("Inspect a docked pilot in a known ship and system.");
        const catalog = (deps.catalog ?? bundledCombatCatalog)(),
          sites = await createCombatDiscovery(run, session, {
            shipID: f.shipID,
            systemID: f.solarSystemID,
            current,
            catalog,
          })();
        current();
        let nativeResources: ReturnType<typeof decodeNativeFittingResources> = null,
          droneBay: { itemID: number; typeID: number; quantity: number }[] | null = null;
        let nativeResourcesError: string | null = null,
          droneBayError: string | null = null;
        let fleet: ReturnType<typeof inspectFleet> | null = null;
        try {
          fleet = inspectFleet(await loadBoundFleet(options), run.characterID);
          current();
        } catch {
          current();
        }
        try {
          if (!f.shipTypeID) throw Error("Native ship type is unavailable.");
          nativeResources = decodeNativeFittingResources(
            (await session.flow.flying.bridgeAsk("dogmaIM", "ItemGetInfo", [f.shipID])) as any,
            { shipID: f.shipID, shipTypeID: f.shipTypeID, characterID: run.characterID },
          );
          current();
          if (!nativeResources) throw Error("Native CPU or powergrid snapshot is incomplete.");
        } catch (e) {
          current();
          nativeResourcesError = e instanceof Error ? e.message : String(e);
          nativeResources = null;
        }
        try {
          await session.flow.flying.bridgeDo("invCache", "InvalidateLocationCache", [f.shipID]);
          current();
          const rows = checkedInventory(
            await session.flow.flying.bridgeAsk("invbroker", "List", [87], undefined, f.shipID),
          );
          current();
          if (
            rows.some(
              (r) => r.ownerID !== run.characterID || r.locationID !== f.shipID || r.flagID !== 87,
            )
          )
            throw Error("Drone bay owner, ship or flag differs.");
          droneBay = rows.map((r) => ({
            itemID: r.itemID,
            typeID: r.typeID,
            quantity: r.quantity,
          }));
        } catch (e) {
          current();
          droneBayError = e instanceof Error ? e.message : String(e);
          droneBay = null;
        }
        let combatModules: { weapons: number; remoteRepair: number } | null = null;
        try {
          const flying = session.flow.flying;
          if (!(await flying.readFit())) throw Error("Fitting unavailable.");
          current();
          const fit = session.store.fitting.get();
          if (fit.activeShipID !== f.shipID || fit.slotsError !== null)
            throw Error("Fitting identity differs.");
          const modules = combatFitModules(
            fit.slots,
            flying.resolveDefenseModuleIDs(),
            flying.resolveRemoteRepModuleIDs(),
            (m) => flying.fittedModuleActivation(m),
          );
          combatModules = {
            weapons: modules.filter((m) => m.kind === "weapon").length,
            remoteRepair: modules.filter((m) => m.kind.startsWith("remote-")).length,
          };
        } catch {
          current();
        }
        let shipClass: number | null = null;
        try {
          shipClass = await readCombatShipClass(run, f.shipTypeID ?? 0, current);
        } catch {
          current();
        }

        // Frozen native dungeon authority identifies 8589 as Emerging Conduit; scanner
        // label remains the independently observed target designation in the setup.
        const siteNames: Record<string, string> = {};
        for (const site of sites)
          if (site.dungeonID === 8589) siteNames[String(site.instanceID)] = "Emerging Conduit";
        let pilotName: string | null = null,
          shipTypeName: string | null = null,
          stationName: string | null = null,
          systemName: string | null = null,
          droneNames: Record<string, string> = {};
        try {
          const refs = [
            { kind: "owner", id: run.characterID },
            { kind: "evelocation", id: dockID },
            { kind: "evelocation", id: f.solarSystemID },
            ...(f.shipTypeID ? [{ kind: "type", id: f.shipTypeID }] : []),
            ...[...new Set((droneBay ?? []).map((d) => d.typeID))].map((id) => ({
              kind: "type",
              id,
            })),
          ];
          const response = await run.fetch(new URL("/api/names", run.baseUrl), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ items: refs }),
            }),
            body = await response.json();
          current();
          if (
            response.ok &&
            body?.names &&
            typeof body.names === "object" &&
            !Array.isArray(body.names) &&
            body.capped !== true
          ) {
            const get = (key: string) => {
              const value = body.names[key];
              return typeof value === "string" && value.trim() ? value.trim() : null;
            };
            pilotName = get(`owner:${run.characterID}`);
            shipTypeName = f.shipTypeID ? get(`type:${f.shipTypeID}`) : null;
            stationName = dockKind === "station" ? get(`evelocation:${dockID}`) : null;
            systemName = get(`evelocation:${f.solarSystemID}`);
            for (const d of droneBay ?? []) {
              const name = get(`type:${d.typeID}`);
              if (name) droneNames[String(d.typeID)] = name;
            }
          }
        } catch {
          current(); /* Optional names never change the held identity or readiness. */
        }
        current();
        const after = decodeFlightStatus((await getFlightStatus(options)).flight);
        current();
        if (
          !after.docked ||
          after.inSpace ||
          after.shipID !== f.shipID ||
          after.solarSystemID !== f.solarSystemID ||
          after.stationID !== f.stationID ||
          after.structureID !== f.structureID ||
          (after.transition && after.transition.phase !== "ready")
        )
          throw Error("Anomaly inspection dock or ship changed.");
        run.report({
          status: "stopped",
          phase: "Combat anomaly inspection complete",
          readout: {
            characterID: run.characterID,
            shipID: f.shipID,
            shipTypeID: f.shipTypeID,
            shipClass,
            pilotName,
            shipTypeName,
            systemID: f.solarSystemID,
            systemName,
            stationID: dockID,
            dockID,
            dockKind,
            structureID: f.structureID,
            stationName,
            droneNames,
            siteNames,
            sites: sites as any,
            nativeResources: nativeResources as any,
            nativeResourcesError,
            droneBay,
            droneBayError,
            combatModules,
            fleet,
            qualification: "source-catalog",
            observedAt: Date.now(),
          },
        });
        active = false;
        session.flow.setLivePush(false);
      })().catch((e) => {
        if (active) {
          run.report({
            status: "error",
            phase: "Combat anomaly inspection failed",
            why: e instanceof Error ? e.message : String(e),
          });
          active = false;
          session.flow.setLivePush(false);
        }
      });
      return {
        async stop() {
          active = false;
          await work;
          session.flow.setLivePush(false);
        },
      };
    },
  };
}
export const anomalyInspectRun = createAnomalyInspectRun();
