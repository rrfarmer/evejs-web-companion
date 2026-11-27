import type { StarMapData } from "../app/api.ts";

export type MapBrowserConnection = readonly [from: number, to: number, group: 0 | 1 | 2];

/** Map2D groups links by whether they cross a region, cross a constellation, or stay in one constellation. */
export function mapBrowserConnections(data: StarMapData) {
  const systems = new Map(data.systems.map(row => [row[0], row]));
  const universe = new Map<string, MapBrowserConnection>();
  const regions = new Map<number, Map<string, MapBrowserConnection>>();
  const constellations = new Map<number, Map<string, MapBrowserConnection>>();
  function record(edges: Map<string, MapBrowserConnection>, from: number, to: number, group: 0 | 1 | 2) {
    const low = Math.min(from, to), high = Math.max(from, to);
    edges.set(`${low}:${high}`, [low, high, group]);
  }
  function forArea(areas: Map<number, Map<string, MapBrowserConnection>>, area: number) {
    let edges = areas.get(area);
    if (!edges) areas.set(area, edges = new Map());
    return edges;
  }
  for (const [from, to] of data.jumps) {
    const a = systems.get(from), b = systems.get(to);
    if (!a || !b) continue;
    const crossesRegion = a[5] !== b[5], crossesConstellation = a[6] !== b[6];
    if (crossesRegion) record(universe, a[5], b[5], 0);
    if (crossesConstellation) {
      record(forArea(regions, a[5]), a[6], b[6], crossesRegion ? 0 : 1);
      if (crossesRegion) record(forArea(regions, b[5]), a[6], b[6], 0);
    }
    const group = crossesRegion ? 0 : crossesConstellation ? 1 : 2;
    record(forArea(constellations, a[6]), from, to, group);
    if (crossesConstellation) record(forArea(constellations, b[6]), from, to, group);
  }
  return { universe, regions, constellations };
}
