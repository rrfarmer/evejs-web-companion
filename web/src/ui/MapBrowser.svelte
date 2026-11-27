<script lang="ts">
  import type { StarMapData, SystemObjectRow } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, request, onClose, onShowSystem }: {
    store: ClientStore; flow: AppFlow; request: { systemID: number };
    onClose: () => void; onShowSystem: (systemID: number) => void;
  } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const labelBase = "UI/Map/MapBrowser/";
  const universeLabel = "UI/Common/LocationTypes/Universe";
  const sectionLabels = ["ListRegions", "ListConstellations", "ListSolarSystems", "ListCelestials"] as const;
  type Point = { id: number; name: string; x: number; z: number; typeID: number; station?: boolean; groupID?: number | null };
  let data = $state.raw<StarMapData | null>(null);
  let objects = $state.raw<readonly SystemObjectRow[]>([]);
  let selection = $state<readonly number[]>([]);
  let shownList = $state<number | null>(null);
  let error = $state(false);
  const label = (key: string, fallback: string, name = "") =>
    plainText(formatTemplate($words.templates[key] ?? fallback, { name }, { nameOf: () => name }));

  $effect(() => {
    let current = true;
    error = false;
    void flow.loadStarMap().then(result => {
      if (current) { data = result; error = result.systems.length === 0; }
    }).catch(() => { if (current) error = true; });
    flow.requestWords([universeLabel, ...["MapBrowser", "CloseMapBrowser", "ShowInWorldMap", "NameRegion", "NameConstellation", "NameSolarSystem", ...sectionLabels].map(key => labelBase + key)]);
    return () => { current = false; };
  });
  $effect(() => {
    const system = data?.systems.find(row => row[0] === request.systemID);
    selection = system ? [system[5], system[6], system[0]] : [];
    shownList = null;
  });
  $effect(() => {
    const selectedSystem = selection[2];
    let current = true;
    objects = [];
    if (selectedSystem !== undefined) void flow.mapSystemObjects(selectedSystem, true).then(result => {
      if (!current) return;
      objects = result.objects;
      flow.requestNames(result.objects.map(row => row.itemID >= 60_000_000 && row.itemID < 64_000_000
        ? { kind: "station", id: row.itemID } : { kind: "type", id: row.typeID }));
    }).catch(() => {});
    return () => { current = false; };
  });

  const region = $derived(data?.regions?.find(row => row[0] === selection[0]));
  const constellation = $derived(data?.constellations?.find(row => row[0] === selection[1]));
  const system = $derived(data?.systems.find(row => row[0] === selection[2]));
  const panels = $derived.by(() => {
    const result: { name: string; title: string; id: number; selected?: number; points: Point[] }[] = [];
    if (!data) return result;
    result.push({
      name: label(universeLabel, "Universe"), title: label(labelBase + sectionLabels[0], "List Regions"),
      id: 9, selected: selection[0], points: (data.regions ?? []).map(([id, x, , z, name]) => ({ id, x, z, name, typeID: 3 })),
    });
    if (region) result.push({
      name: label(labelBase + "NameRegion", "Region: {name}", region[4]),
      title: label(labelBase + sectionLabels[1], "List Constellations", region[4]), id: region[0], selected: selection[1],
      points: (data.constellations ?? []).filter(row => row[5] === region[0]).map(([id, x, , z, name]) => ({ id, x, z, name, typeID: 4 })),
    });
    if (constellation) result.push({
      name: label(labelBase + "NameConstellation", "Constellation: {name}", constellation[4]),
      title: label(labelBase + sectionLabels[2], "List Solar Systems", constellation[4]), id: constellation[0], selected: selection[2],
      points: data.systems.filter(row => row[6] === constellation[0]).map(([id, x, , z, , , , name]) => ({ id, x, z, name: name ?? String(id), typeID: 5 })),
    });
    if (system) {
      const name = system[7] ?? String(system[0]);
      const points = objects.flatMap(row => {
        if (!row.position) return [];
        const station = row.itemID >= 60_000_000 && row.itemID < 64_000_000;
        const objectName = row.name ?? (station ? resolvedName($names.resolved, "station", row.itemID, "")
          : resolvedName($names.resolved, "type", row.typeID, ""));
        const detail = row.groupID === 10 && row.destinationID
          ? data?.systems.find(other => other[0] === row.destinationID)?.[7] : row.celestialIndex ?? null;
        return [{ id: row.itemID, typeID: row.typeID, name: `${objectName || row.itemID}${!row.name && detail ? ` · ${detail}` : ""}`,
          station, groupID: row.groupID, x: row.position[0], z: row.position[2] }];
      });
      result.push({ name: label(labelBase + "NameSolarSystem", "Solar System: {name}", name),
        title: label(labelBase + sectionLabels[3], "List Celestials", name), id: system[0], points });
    }
    return result;
  });

  function project(points: readonly Point[]) {
    if (points.length === 0) return [];
    const xs = points.map(point => point.x), zs = points.map(point => point.z);
    const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...zs), top = Math.max(...zs);
    const range = Math.max(right - left, top - bottom, 1);
    return points.map(point => ({ ...point,
      left: 50 + 76 * (point.x - (right + left) / 2) / range,
      top: 54 - 76 * (point.z - (top + bottom) / 2) / range,
    }));
  }
  // Map2D.DrawSolarsystem puts the sun at the origin and fills 80% of the square at the furthest object.
  function solarGeometry(points: readonly Point[]) {
    const extent = Math.max(1, ...points.map(point => Math.hypot(point.x, point.z)));
    const scale = 40 / extent;
    return {
      points: points.map(point => ({
        ...point,
        left: point.groupID === 6 ? 50 : 50 - point.x * scale,
        top: point.groupID === 6 ? 50 : 50 - point.z * scale,
      })),
      orbits: points.filter(point => point.groupID === 7).map(point => ({
        id: point.id, diameter: 2 * Math.hypot(point.x, point.z) * scale,
      })),
    };
  }
  function select(index: number, point: Point): void {
    if (index < 3) selection = [...selection.slice(0, index), point.id];
    else showInfo({ kind: "spaceObject", itemID: point.id, typeID: point.typeID });
    shownList = null;
  }
</script>

<aside class="map-browser" aria-label={label(labelBase + "MapBrowser", "Map Browser")}>
  <button class="map-browser-close" type="button" aria-label={label(labelBase + "CloseMapBrowser", "Close Map Browser")}
    title={label(labelBase + "CloseMapBrowser", "Close Map Browser")} onclick={onClose}>×</button>
  {#if error}<p role="status">Map data unavailable.</p>
  {:else if !data}<p role="status">Loading map…</p>
  {:else}
    {#each panels as panel, index (panel.id)}
      {@const solar = index === 3 ? solarGeometry(panel.points) : null}
      <section class="map-browser-panel" aria-label={panel.name} data-location={panel.id}>
        <button class="map-browser-list" type="button" title={panel.title} aria-expanded={shownList === index}
          onclick={() => { shownList = shownList === index ? null : index; }}>{panel.name}</button>
        {#if index === 3}
          <button class="map-browser-world" type="button" title={label(labelBase + "ShowInWorldMap", "Show in World Map")}
            aria-label={label(labelBase + "ShowInWorldMap", "Show in World Map")} onclick={() => onShowSystem(panel.id)}>↗</button>
        {/if}
        <div class="map-browser-plot" class:solar={solar !== null}>
          {#each solar?.orbits ?? [] as orbit (orbit.id)}
            <div class="map-browser-orbit" data-orbit={orbit.id} style:width={`${orbit.diameter}%`} aria-hidden="true"></div>
          {/each}
          {#each solar?.points ?? project(panel.points) as point (point.id)}
            <button type="button" class="map-browser-point" class:selected={panel.selected === point.id} class:station={point.station} class:sun={point.groupID === 6}
              style:left={`${point.left}%`} style:top={`${point.top}%`} title={point.name} aria-label={point.name}
              aria-pressed={index < 3 ? panel.selected === point.id : undefined} data-map-item={point.id} onclick={() => select(index, point)}></button>
          {/each}
        </div>
        {#if shownList === index}
          <ul class="map-browser-choices">
            {#each [...panel.points].sort((a, b) => a.name.localeCompare(b.name)) as point (point.id)}
              <li><button type="button" onclick={() => select(index, point)}>{point.name}</button></li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  {/if}
</aside>

<style>
  .map-browser { position: fixed; inset: 0 0 0 auto; width: min(calc(25dvh + 5px), 90vw); z-index: 18;
    box-sizing: border-box; overflow: auto; background: #101619ee; color: var(--color-text, white); border-left: 1px solid #ffffff35; }
  .map-browser-panel { height: 25dvh; position: relative; box-sizing: border-box; border-bottom: 1px solid #ffffff30; overflow: hidden; }
  .map-browser-plot { position: absolute; inset: 1.5rem 0 0; background: radial-gradient(ellipse at center, #33586555, #0c171c55 65%, transparent); }
  .map-browser-plot.solar { inset: 0 0 auto; aspect-ratio: 1; }
  .map-browser-orbit { position: absolute; left: 50%; top: 50%; aspect-ratio: 1; box-sizing: border-box;
    border: 1px solid #a7b7c370; border-radius: 50%; transform: translate(-50%, -50%); pointer-events: none; }
  .map-browser-close, .map-browser-list, .map-browser-world { position: absolute; z-index: 2; background: #101619; border: 1px solid #ffffff30; }
  .map-browser-close { right: 4px; top: 4px; z-index: 4; }
  .map-browser-list { left: 4px; top: 4px; max-width: calc(100% - 48px); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .map-browser-world { right: 4px; top: 4px; }
  .map-browser-point { position: absolute; padding: 0; min-height: 0; width: 7px; height: 7px; border: 1px solid #d6e6eb;
    background: #82b4bc; border-radius: 50%; transform: translate(-50%, -50%); }
  .map-browser-point.station { border-radius: 0; background: #af995c; }
  .map-browser-point.sun { background: #fff0c4; border-color: #fff5d8; box-shadow: 0 0 6px #f4cd8266; }
  .map-browser-point.selected, .map-browser-point:focus-visible, .map-browser-point:hover {
    background: #ffce57; border-color: #fff3b4; box-shadow: 0 0 0 3px #efb33b63; z-index: 1;
  }
  .map-browser-choices { position: absolute; inset: 2rem 4px 0; z-index: 3; background: #101619f8; margin: 0; padding: 4px;
    list-style: none; overflow: auto; }
  .map-browser-choices button { width: 100%; text-align: left; background: transparent; border: 0; }
</style>
