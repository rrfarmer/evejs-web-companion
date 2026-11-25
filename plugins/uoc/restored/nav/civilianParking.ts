import type { DockableLocation } from "./dockableLocation.ts";

export type CivilianParkingChoice =
  | { readonly mode: "NEAREST" }
  | { readonly mode: "SELECTED"; readonly destination: Pick<DockableLocation, "kind" | "id"> };
export type CivilianParkingPolicy =
  | { readonly mode: "NEAREST" }
  | { readonly mode: "SELECTED"; readonly destination: DockableLocation };

type Position = { readonly x: number; readonly y: number; readonly z: number };
export interface CivilianDockCandidate extends DockableLocation {
  readonly position?: Position | null;
}

/** Compare only eligible routes. Within this system, use physical distance. */
export function nearestCivilianDock(
  candidates: readonly CivilianDockCandidate[],
  systemID: number,
  origin: Position | null,
  jumps: ReadonlyMap<number, number | null>,
): CivilianDockCandidate | null {
  const local = candidates.filter((dock) => dock.solarSystemID === systemID);
  if (local.length === 1) return local[0]!;
  if (local.length > 1) {
    const measured = (point: Position | null | undefined): point is Position =>
      !!point && [point.x, point.y, point.z].every(Number.isFinite);
    if (!measured(origin) || local.some((dock) => !measured(dock.position)))
      throw new Error("The distances to local docking destinations could not be verified.");
    const distance = (dock: CivilianDockCandidate) => {
      const { x, y, z } = dock.position!;
      return Math.hypot(origin.x - x, origin.y - y, origin.z - z);
    };
    return local.sort((a, b) => distance(a) - distance(b) || a.id - b.id)[0]!;
  }
  return (
    candidates
      .filter((dock) => jumps.get(dock.solarSystemID) != null)
      .sort(
        (a, b) =>
          jumps.get(a.solarSystemID)! - jumps.get(b.solarSystemID)! ||
          a.solarSystemID - b.solarSystemID ||
          a.id - b.id,
      )[0] ?? null
  );
}
