// MapViewMarkersHandler.FindOverlaps and MarkerSpaceObject.GetOverlapSortValue.
const CELESTIAL_GROUP_ORDER = [10, 9, 15, 479, 7, 8, 310, 2020, 6];

export interface ProjectedMarker {
  x: number;
  y: number;
  cameraDistance: number;
  kind: "result" | "celestial" | "probe";
  groupID?: number;
  name: string;
  highlighted: boolean;
}

function groupPriority(marker: ProjectedMarker): number {
  if (marker.groupID === undefined) return 0;
  const index = CELESTIAL_GROUP_ORDER.indexOf(marker.groupID);
  if (index === -1) return CELESTIAL_GROUP_ORDER.length + marker.groupID;
  return marker.highlighted ? index - CELESTIAL_GROUP_ORDER.length : index;
}

const MARKER_ID = { result: 5, celestial: 6, probe: 7 };

function compareMarkers(a: ProjectedMarker, b: ProjectedMarker): number {
  return MARKER_ID[a.kind] - MARKER_ID[b.kind]
    || groupPriority(a) - groupPriority(b)
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function intersect(a: ProjectedMarker, b: ProjectedMarker): boolean {
  // GetBoundaries gives a 12 px box centered on the projected bracket. Touching edges do not overlap.
  return Math.abs(a.x - b.x) < 12 && Math.abs(a.y - b.y) < 12;
}

export function markerStacks<M extends ProjectedMarker>(markers: readonly M[]) {
  const sorted = [...markers].sort((a, b) => compareMarkers(a, b) || a.cameraDistance - b.cameraDistance);
  const covered = new Set<M>();
  const stacks = new Map<M, M[]>();
  for (let i = 0; i < sorted.length; i++) {
    const leader = sorted[i]!;
    if (covered.has(leader)) continue;
    const members: M[] = [];
    for (let j = i + 1; j < sorted.length; j++) {
      const marker = sorted[j]!;
      if (covered.has(marker) || !intersect(leader, marker)) continue;
      covered.add(marker);
      members.push(marker);
    }
    if (members.length) stacks.set(leader, members);
  }
  return { covered, stacks };
}

/** The tooltip queries the owner's intersections again, including members of neighboring stacks. */
export function markerTooltipRows<M extends ProjectedMarker>(owner: M, markers: readonly M[]): M[] {
  return markers.filter((marker) => intersect(owner, marker)).sort((a, b) => compareMarkers(b, a));
}
