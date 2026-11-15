import type { StarMapActivityMode } from "../bridge/starMapFilters.ts";

interface MapPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ActivityPin {
  readonly systemID: number;
  readonly regionID: number;
  readonly constellationID: number;
  readonly sites: number;
  readonly position: MapPoint;
}

export type ClusterLevel = "constellation" | "region";

export interface ActivityCluster {
  readonly id: number;
  readonly level: ClusterLevel;
  readonly regionID: number;
  readonly members: readonly ActivityPin[];
  readonly value: number;
}

/** baseCamera.GetZoomProportionByZoomDistance. */
export function mapZoomValue(distance: number, near: number, far: number): number {
  return Math.min(1, Math.max(0, (distance - near) / (far - near))) ** (1 / 9);
}

/** The filter pins use MarkerFilter.GetGroupingId. Perspective distance is measured to each pin. */
export function groupActivityPins(pins: readonly ActivityPin[], mode: StarMapActivityMode, zoom: number,
  abstract: boolean, eye: MapPoint): ActivityCluster[] {
  // Vanguard Nemesis is a binary star filter. Ore and Phased Fields supply grouped pin classes.
  if (mode === "convoys" || (abstract && zoom <= 0.75)) return [];
  const byArea = new Map<number, {
    level: ClusterLevel; regionID: number; members: ActivityPin[]; value: number;
  }>();
  for (const pin of pins) {
    const distance = abstract ? 0 : Math.hypot(eye.x - pin.position.x, eye.y - pin.position.y, eye.z - pin.position.z);
    const level = distance > 25000 ? "region" : distance > 15000 ? "constellation"
      : zoom > 0.85 ? "region" : zoom > 0.75 ? "constellation" : null;
    if (!level) continue;
    const id = level === "region" ? pin.regionID : pin.constellationID;
    if (id <= 0) continue;
    let cluster = byArea.get(id);
    if (!cluster) {
      cluster = { level, regionID: pin.regionID, members: [], value: 0 };
      byArea.set(id, cluster);
    }
    cluster.members.push(pin);
    // MapFilterPhasedSites.GetAmountForSolarSystem inherits None. MarkerGroup.GetValue adds zero.
    if (mode === "ore") cluster.value += pin.sites;
  }
  return [...byArea].flatMap(([id, group]) => group.members.length > 1 ? [{ id, ...group }] : []);
}

/** mapMarkersHandler.GetMeanPosition uses each member position once, regardless of its site count. */
export function activityClusterCentroid(members: readonly ActivityPin[]): MapPoint {
  if (members.length === 0) return { x: 0, y: 0, z: 0 };
  let x = 0, y = 0, z = 0;
  for (const { position } of members) {
    x += position.x;
    y += position.y;
    z += position.z;
  }
  return { x: x / members.length, y: y / members.length, z: z / members.length };
}
