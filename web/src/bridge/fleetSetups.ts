import { parse } from "yaml";
import type { FleetWing } from "./boundFleet.ts";

export const FLEET_SETUPS_KEY = "fleetSetups";
export const FLEET_SETUP_NAME_LENGTH = 15;
export const FLEET_MAX_SIZE = 256;

export interface FleetSetupOptions {
  readonly motd: boolean;
  readonly freeMove: boolean;
  readonly maxSize: boolean;
  readonly defaultSquad: boolean;
}

export interface FleetSetupSource {
  readonly fleetID: number;
  readonly motd: string;
  readonly freeMove: boolean;
  readonly maxSize: number;
  readonly wingsInfo: Readonly<Record<string, { wingName: string; wingIdx: number; squadNames: string[] }>>;
  readonly defaultSquad: readonly [wing: string, index: number, squad: string] | null;
}

/** fleetSvc.StoreFleetSetup orders wing and squad IDs and stores the default squad by its position. */
export function fleetSetupHierarchy(wings: readonly FleetWing[], defaultSquadID: number | null): Pick<FleetSetupSource, "wingsInfo" | "defaultSquad"> | null {
  const names = new Set<string>();
  const entries: Array<[string, { wingName: string; wingIdx: number; squadNames: string[] }]> = [];
  let defaultSquad: FleetSetupSource["defaultSquad"] = null;
  for (const [wingIdx, wing] of [...wings].sort((a, b) => Number(a.wingID) - Number(b.wingID)).entries()) {
    const key = wing.name.toLowerCase();
    const normalized = key.trim();
    if (!normalized || names.has(normalized)) return null;
    names.add(normalized);
    const squads = [...wing.squads].sort((a, b) => Number(a.squadID) - Number(b.squadID));
    const index = squads.findIndex(squad => defaultSquadID !== null && Number(squad.squadID) === defaultSquadID);
    if (index >= 0) defaultSquad = [wing.name, index, squads[index]!.name];
    entries.push([key, { wingIdx, wingName: wing.name, squadNames: squads.map(squad => squad.name) }]);
  }
  return { wingsInfo: Object.fromEntries(entries), defaultSquad };
}

export function writeFleetSetup(previous: string | null, name: string, source: FleetSetupSource, include: FleetSetupOptions): string {
  const setups: unknown = previous === null ? [] : parse(previous, { schema: "core" });
  if (!Array.isArray(setups)) throw new Error("Stored fleet setups could not be read.");
  const index = setups.findIndex(setup => setup?.setupName === name);
  const next = { ...(index < 0 ? {} : setups[index]), setupName: name, wingsInfo: source.wingsInfo };
  for (const key of ["motd", "isFreeMove", "maxFleetSize", "defaultSquad"]) delete next[key];
  if (include.motd) next.motd = source.motd;
  if (include.freeMove) next.isFreeMove = source.freeMove;
  if (include.maxSize) next.maxFleetSize = source.maxSize;
  if (include.defaultSquad && source.defaultSquad !== null) next.defaultSquad = source.defaultSquad;
  if (index < 0) setups.push(next);
  else setups[index] = next;
  // JSON is accepted by the client's YAML reader and EveJS's fleet setup reader.
  return JSON.stringify(setups);
}
