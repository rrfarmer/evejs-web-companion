type SolarPoint = { id: number; x: number; y?: number; z: number; groupID?: number | null; orbitID?: number | null };
type PlotPosition = { left: number; top: number };
type Orbit = { id: number; distance: number; radius: number };

/** Physical and abstract layouts for the solar-system panel. */
export function solarGeometry<T extends SolarPoint>(points: readonly T[], width: number, abstract: boolean) {
  const extent = Math.max(1, ...points.map(point => Math.hypot(point.x, point.z)));
  const physicalScale = 40 / extent;
  const size = Math.max(1, width);
  const separation = width > 0 ? Math.max(1, Math.floor(4096 / width)) : 1;
  const byID = new Map(points.map(point => [point.id, point]));
  const satellites = new Map<number, T[]>();
  const parents = new Map<number, T>();
  for (const point of points) {
    const planet = orbitingPlanet(point, byID);
    if (!planet) continue;
    parents.set(point.id, planet);
    const group = satellites.get(planet.id) ?? [];
    group.push(point);
    satellites.set(planet.id, group);
  }

  const planets = points.filter(point => point.groupID === 7);
  // Keep the inner-to-outer ordering when stretching the radial axis.
  if (abstract) planets.sort((a, b) => distance(a) - distance(b) || a.id - b.id);
  const positions = new Map<number, PlotPosition>();
  const orbits = planets.map((planet, index) => {
    const distance = Math.hypot(planet.x, planet.z);
    const radius = abstract ? 40 * (index + 1) / planets.length : distance * physicalScale;
    const position = project(planet.x, planet.z, abstract && distance > 0 ? radius / distance : physicalScale);
    positions.set(planet.id, position);
    if (abstract) stackSatellites(positions, satellites.get(planet.id) ?? [], planet, position, size);
    const center = Math.floor(size / 2);
    const pixelRadius = radius * center / 50;
    const radialX = distance > 0 ? -planet.x * pixelRadius / distance : 0;
    const radialZ = distance > 0 ? planet.z * pixelRadius / distance : 0;
    return { id: planet.id, distance, radius, gateRadius: Math.floor(Math.hypot(radialX, size - 2 * center - radialZ)) };
  });
  const gateOrbits = abstract
    ? orbits.map(orbit => ({ ...orbit, radius: orbit.gateRadius })).sort((a, b) => a.distance - b.distance)
    : [];

  return {
    points: points.map(point => {
      const parent = parents.get(point.id);
      return { ...point, planetID: parent?.id,
        ...positionOf(point, parent, positions, gateOrbits, size, physicalScale, separation) };
    }),
    orbits: orbits.map(({ id, radius }) => ({ id, diameter: 2 * radius })),
  };
}

function distance(point: SolarPoint, origin?: SolarPoint): number {
  return Math.hypot(point.x - (origin?.x ?? 0), (point.y ?? 0) - (origin?.y ?? 0), point.z - (origin?.z ?? 0));
}

function orbitingPlanet<T extends SolarPoint>(point: T, byID: ReadonlyMap<number, T>): T | undefined {
  if (point.groupID === 6 || point.groupID === 7 || point.groupID === 10) return;
  let orbitID = point.orbitID;
  const seen = new Set([point.id]);
  while (orbitID != null && !seen.has(orbitID)) {
    const parent = byID.get(orbitID);
    if (parent?.groupID === 7) return parent;
    seen.add(orbitID);
    orbitID = parent?.orbitID;
  }
}

function project(x: number, z: number, scale: number): PlotPosition {
  return { left: 50 - x * scale, top: 50 - z * scale };
}

function stackSatellites(positions: Map<number, PlotPosition>, children: readonly SolarPoint[], planet: SolarPoint,
  position: PlotPosition, size: number): void {
  const step = 1000 / size;
  const planetRadius = 100 / size;
  let row = 1;
  let column = 0;
  for (const child of [...children].sort((a, b) => distance(a, planet) - distance(b, planet) || a.id - b.id)) {
    const top = position.top - planetRadius - row * step;
    positions.set(child.id, { left: position.left + column * step, top });
    if (top < step) { column++; row = 0; }
    row++;
  }
}

function abstractRadius(distance: number, orbits: readonly Orbit[]): number {
  let inner = { distance: 0, radius: 0 };
  for (const orbit of orbits) {
    if (distance === orbit.distance) return orbit.radius;
    if (distance < orbit.distance) {
      return inner.radius + (orbit.radius - inner.radius) * (distance - inner.distance) / (orbit.distance - inner.distance);
    }
    inner = orbit;
  }
  return inner.radius;
}

function positionOf(point: SolarPoint, parent: SolarPoint | undefined, positions: ReadonlyMap<number, PlotPosition>,
  gateOrbits: readonly Orbit[], size: number, scale: number, separation: number): PlotPosition {
  const position = positions.get(point.id);
  if (position) return position;
  if (point.groupID === 6) return { left: 50, top: 50 };
  if (point.groupID === 10 && gateOrbits.length) {
    const distance = Math.hypot(point.x, point.z);
    const factor = distance > 0 ? abstractRadius(distance, gateOrbits) / distance : 0;
    const center = Math.floor(size / 2);
    return { left: (center + Math.trunc(-point.x * factor) + 6) * 100 / size,
      top: (size - center - Math.trunc(point.z * factor)) * 100 / size };
  }
  return project(parent ? point.x + (point.x - parent.x) * separation : point.x,
    parent ? point.z + (point.z - parent.z) * separation : point.z, scale);
}
