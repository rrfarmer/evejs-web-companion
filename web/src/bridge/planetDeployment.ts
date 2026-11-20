import type { Colony, FlightStatus, ShipBay } from "../store/types.ts";
import { linkKey } from "./planetRouting.ts";
import { decodeColonyReport } from "./planets.ts";
import type { JsonValue } from "./wire.ts";
import type { SurfaceCoordinates } from "./planetConstruction.ts";

export const COMMAND_CENTER_BAYS = ["commandCenter", "colony", "cargo"] as const;
export const INTERPLANETARY_CONSOLIDATION = 2495;
export const OMNIPOTENT = 19430;

export interface CommandCenterSource {
  readonly itemID: number;
  readonly typeID: number;
  readonly shipID: number;
  readonly hold: string;
}

export interface CommandCenterQuote {
  readonly typeName: string | null;
  readonly source: CommandCenterSource | null;
  readonly reason: string;
}

export interface CommandCenterPlacement extends SurfaceCoordinates {
  readonly source: CommandCenterSource;
}

export function emptyPlanetSurface(planet: Colony): Colony {
  return { ...planet, pins: [], links: [], routes: [], linkCount: 0, commandCenterLevel: 0, lastSimulatedAtMs: null, resources: null };
}

export function localPlanetSurface(raw: JsonValue, planetID: number, systemID: number): Colony | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("planets" in raw) || !Array.isArray(raw.planets)) return undefined;
  return decodeColonyReport({ coloniesReadable: true, colonies: raw.planets }, 0).colonies
    .find(planet => planet.planetID === planetID && planet.solarSystemID === systemID && planet.planetTypeID > 0);
}

export function deploymentLocationError(flight: FlightStatus, solarSystemID: number): string {
  if (!flight.inSpace || flight.docked || flight.shipID === null || flight.shipIsCapsule === true) {
    return "You must be in space aboard a ship to deploy a command centre.";
  }
  return flight.solarSystemID !== solarSystemID ? "You must be in this planet's solar system." : "";
}

/** ClientPlanet.CreateCommandPin reads these inventories in this order. */
export function findCommandCenterSource(typeID: number, shipID: number, bays: readonly ShipBay[]): CommandCenterSource | null {
  for (const key of COMMAND_CENTER_BAYS) {
    const bay = bays.find(bay => bay.key === key);
    const item = bay?.present === true ? bay.items?.find(item => item.typeID === typeID && item.quantity > 0) : undefined;
    if (item) return { itemID: item.itemID, typeID, shipID, hold: bay!.label };
  }
  return null;
}

/** Describe the reviewed network without volatile simulation times or stock levels. */
export function abandonmentBasis(colony: Colony): string {
  const pins = colony.pins.map(pin => [pin.pinID, pin.typeID, pin.latitude, pin.longitude, pin.schematicID]).sort((a, b) => Number(a[0]) - Number(b[0]));
  const links = colony.links.map(link => `${linkKey(link.endpoint1, link.endpoint2)}:${link.level}`).sort();
  const routes = [...colony.routes].sort((a, b) => a.routeID - b.routeID)
    .map(route => [route.routeID, route.path, route.commodityTypeID, route.commodityQuantity]);
  return JSON.stringify([colony.planetID, colony.commandCenterLevel, pins, links, routes]);
}
