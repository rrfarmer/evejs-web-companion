<script lang="ts">
  import type { StarMapData, WarzonePositions } from "../app/api.ts";
  import { WARZONE_FACTION_COLORS, type MilitiaSystem } from "../bridge/militiaEnlistment.ts";
  import { clientTexture } from "../play/window.ts";

  let { positions, jumps, occupations, focusID, focusName = "", controls }: {
    positions: WarzonePositions;
    jumps: StarMapData["jumps"];
    occupations: readonly MilitiaSystem[];
    focusID: number | null;
    focusName?: string;
    controls?: {
      zoomedOut: boolean;
      viewingFaction: number;
      selectedID: number | null;
      showNames: boolean;
      showStatus: boolean;
      systemName: (id: number) => string;
      markers: ReadonlyMap<number, readonly { label: string; icon: string }[]>;
      select: (id: number) => void;
      zoom: (out: boolean) => void;
    };
  } = $props();

  const viewSize = $derived(controls ? 1800 : 3000);
  const zoom = $derived(controls?.zoomedOut ? 0.6 : 1);
  const opacity: Readonly<Record<string, number>> = { FL: 1, SL: 0.8, BL: 0.4 };
  const star = clientTexture("res:/UI/Texture/classes/frontlines/star.png");
  const statusIcons: Readonly<Record<string, string>> = { FL: "front_icon", SL: "hq_icon", BL: "support_icon" };
  let width = $state(0);
  let height = $state(0);
  let panX = $state(0), panY = $state(0);
  let drag: { id: number; x: number; y: number; left: number; top: number } | null = null;
  let dragging = $state(false);
  const systemState = $derived(new Map(occupations.map((system) => [system.systemID, system])));
  const scaleX = $derived(viewSize * zoom / positions.mapWidth);
  const scaleY = $derived(viewSize * zoom / positions.mapHeight);
  const focus = $derived(focusID === null ? null : positions.systems[focusID]);
  const originX = $derived((focus?.xpos ?? positions.mapWidth / 2) * viewSize / positions.mapWidth);
  const originY = $derived((focus?.ypos ?? positions.mapHeight / 2) * viewSize / positions.mapHeight);
  const left = $derived(width / 2 + (panX - originX) * zoom);
  const top = $derived(height / 2 + (panY - originY) * zoom);
  const stars = $derived(new Map(Object.entries(positions.systems).flatMap(([id, position]) => position.isVisible ? [[Number(id), {
    x: left + position.xpos * scaleX,
    y: top + position.ypos * scaleY,
    sprite: position.territorySprite,
  }] as const] : [])));
  const warzoneJumps = $derived(jumps.filter(([from, to]) => positions.systems[from]?.isVisible && positions.systems[to]?.isVisible));
  const links = $derived(warzoneJumps.flatMap(([from, to]) => {
    const a = stars.get(from), b = stars.get(to);
    if (!a || !b || Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > width || Math.max(a.y, b.y) < 0 || Math.min(a.y, b.y) > height) return [];
    return [{ from, to, x: a.x, y: a.y, length: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) }];
  }));

  function startPan(event: PointerEvent) {
    if (!controls || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: panX, top: panY };
  }

  function movePan(event: PointerEvent & { currentTarget: HTMLElement }) {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!dragging && Math.hypot(dx, dy) < 4) return;
    if (!dragging) event.currentTarget.setPointerCapture(drag.id);
    dragging = true;
    panX = Math.min(originX, Math.max(originX - viewSize, drag.left + dx / zoom));
    panY = Math.min(originY, Math.max(originY - viewSize, drag.top + dy / zoom));
  }

  function stopPan(event: PointerEvent) {
    if (event.pointerId !== drag?.id) return;
    drag = null;
    dragging = false;
  }

  function handleWheel(event: WheelEvent) {
    if (!controls || event.deltaY === 0) return;
    event.preventDefault();
    controls.zoom(event.deltaY > 0);
  }
</script>

<span class="preview" class:interactive={controls} class:dragging role="presentation" aria-hidden={controls ? undefined : "true"}
  bind:clientWidth={width} bind:clientHeight={height} onpointerdown={startPan} onpointermove={movePan}
  onpointerup={stopPan} onpointercancel={stopPan} onlostpointercapture={stopPan} onpointerleave={stopPan} onwheel={handleWheel}>
  {#each stars as [id, { sprite }] (id)}
    {@const state = systemState.get(id)}
    {@const color = state?.occupierID && WARZONE_FACTION_COLORS[state.occupierID]}
    {#if sprite && state && color}
      {@const x = left + sprite.xOffset * scaleX}
      {@const y = top + sprite.yOffset * scaleY}
      {@const w = sprite.imageWidth * (viewSize + 17) * zoom / positions.mapWidth}
      {@const h = sprite.imageHeight * (viewSize + 17) * zoom / positions.mapHeight}
      {#if width && height && x < width && y < height && x + w > 0 && y + h > 0}
        <span class="territory" class:opposed={controls && controls.viewingFaction !== state.occupierID}
          style:left={`${x}px`} style:top={`${y}px`} style:width={`${w}px`} style:height={`${h}px`}
          style:background-color={color} style:opacity={opacity[state.adjacency] ?? 1}
          style:mask-image={`url("${clientTexture(sprite.territoryIconFile.replaceAll("\\", "/"))}")`}></span>
      {/if}
    {/if}
  {/each}
  {#each links as link (`${link.from}:${link.to}`)}
    <span class="link" style:left={`${link.x}px`} style:top={`${link.y}px`}
      style:width={`${link.length}px`} style:transform={`rotate(${link.angle}rad)`}></span>
  {/each}
  {#each stars as [id, { x, y, sprite }] (id)}
    {#if width && height && x >= 0 && x <= width && y >= 0 && y <= height}
      {#if controls}
        {@const state = sprite ? systemState.get(id) : null}
        {@const icon = !controls.zoomedOut && controls.showStatus && state ? statusIcons[state.adjacency] : null}
        {@const name = controls.systemName(id)}
        <button type="button" class="star pickable" class:occupied={state} class:focus={id === controls.selectedID}
          style:left={`${x}px`} style:top={`${y}px`} aria-label={name} aria-pressed={id === controls.selectedID}
          title={name} onclick={() => controls?.select(id)}>
          <img alt="" src={icon ? clientTexture(`res:/UI/Texture/classes/frontlines/${icon}.png`) : star} class:status-icon={icon} draggable="false" />
          {#if !controls.zoomedOut && controls.showNames}<span>{name}</span>{/if}
        </button>
        {#each controls.markers.get(id) ?? [] as marker, index (marker.icon)}
          <img class="marker" src={marker.icon} alt={marker.label} title={marker.label} draggable="false"
            style:left={`${x + index * 17}px`} style:top={`${y - 18}px`} />
        {/each}
      {:else}
        <span class="star" class:occupied={sprite && systemState.has(id)} class:focus={id === focusID} style:left={`${x}px`} style:top={`${y}px`}>
          <img alt="" src={star} />
          {#if id === focusID}<span>{focusName}</span>{/if}
        </span>
      {/if}
    {/if}
  {/each}
</span>

<style>
  .preview { display: block; width: 100%; height: 164px; position: relative; overflow: hidden; background: #101519; }
  .preview.interactive { height: 100%; min-height: 360px; background: #080a0c; cursor: grab; touch-action: none; user-select: none; }
  .preview.dragging, .preview.dragging button { cursor: grabbing; }
  .territory, .link, .star { position: absolute; pointer-events: none; }
  .territory { mask-repeat: no-repeat; mask-size: 100% 100%; }
  .territory.opposed { filter: saturate(.3) brightness(.5); }
  .link { height: 1px; background: #ffffff44; transform-origin: left center; }
  .star { transform: translate(-50%, -50%); color: #fff; text-shadow: 0 1px 4px #000; }
  .star img { display: block; width: 7px; height: 7px; }
  .star.occupied img { width: 12px; height: 12px; }
  .star.focus img { width: 17px; height: 17px; }
  .star span { position: absolute; top: 0; left: 100%; margin-left: 4px; white-space: nowrap; }
  .star.pickable { display: grid; place-items: center; padding: 1px; border: 1px solid transparent; background: transparent; pointer-events: auto; cursor: pointer; font: inherit; }
  .star.pickable:is(:hover, :focus-visible, .focus) { border-color: #c7ebf3; background: #152b35; z-index: 2; }
  .star.pickable .status-icon { width: 15px; height: 15px; }
  .marker { position: absolute; width: 15px; height: 15px; transform: translateX(-50%); }
</style>
