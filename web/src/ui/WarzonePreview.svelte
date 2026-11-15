<script lang="ts">
  import type { StarMapData, WarzonePositions } from "../app/api.ts";
  import type { MilitiaSystem } from "../bridge/militiaEnlistment.ts";
  import { clientTexture } from "../play/window.ts";

  let { positions, jumps, occupations, focusID, focusName }: {
    positions: WarzonePositions;
    jumps: StarMapData["jumps"];
    occupations: readonly MilitiaSystem[];
    focusID: number | null;
    focusName: string;
  } = $props();

  const viewSize = 3000;
  const colors: Readonly<Record<number, string>> = { 500001: "#00acd1", 500002: "#fe3743", 500003: "#e7b815", 500004: "#40aa5e" };
  const opacity: Readonly<Record<string, number>> = { FL: 1, SL: 0.8, BL: 0.4 };
  const star = clientTexture("res:/UI/Texture/classes/frontlines/star.png");
  let width = $state(0);
  let height = $state(0);
  const systemState = $derived(new Map(occupations.map((system) => [system.systemID, system])));
  const scaleX = $derived(viewSize / positions.mapWidth);
  const scaleY = $derived(viewSize / positions.mapHeight);
  const focus = $derived(focusID === null ? null : positions.systems[focusID]);
  const left = $derived(width / 2 - (focus?.xpos ?? positions.mapWidth / 2) * scaleX);
  const top = $derived(height / 2 - (focus?.ypos ?? positions.mapHeight / 2) * scaleY);
  const stars = $derived(new Map(Object.entries(positions.systems).flatMap(([id, position]) => position.isVisible ? [[Number(id), {
    x: left + position.xpos * scaleX,
    y: top + position.ypos * scaleY,
    sprite: position.territorySprite,
  }] as const] : [])));
  const links = $derived(jumps.flatMap(([from, to]) => {
    const a = stars.get(from), b = stars.get(to);
    if (!a || !b || Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > width || Math.max(a.y, b.y) < 0 || Math.min(a.y, b.y) > height) return [];
    return [{ from, to, x: a.x, y: a.y, length: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) }];
  }));
</script>

<span class="preview" aria-hidden="true" bind:clientWidth={width} bind:clientHeight={height}>
  {#each stars as [id, { sprite }] (id)}
    {@const state = systemState.get(id)}
    {@const color = state?.occupierID && colors[state.occupierID]}
    {#if sprite && state && color}
      {@const x = left + sprite.xOffset * scaleX}
      {@const y = top + sprite.yOffset * scaleY}
      {@const w = sprite.imageWidth * (viewSize + 17) / positions.mapWidth}
      {@const h = sprite.imageHeight * (viewSize + 17) / positions.mapHeight}
      {#if width && height && x < width && y < height && x + w > 0 && y + h > 0}
        <span class="territory" style:left={`${x}px`} style:top={`${y}px`} style:width={`${w}px`} style:height={`${h}px`}
          style:background-color={color} style:opacity={opacity[state.adjacency] ?? 0.4}
          style:mask-image={`url("${clientTexture(sprite.territoryIconFile.replaceAll("\\", "/"))}")`}></span>
      {/if}
    {/if}
  {/each}
  {#each links as link (`${link.from}:${link.to}`)}
    <span class="link" style:left={`${link.x}px`} style:top={`${link.y}px`}
      style:width={`${link.length}px`} style:transform={`rotate(${link.angle}rad)`}></span>
  {/each}
  {#each stars as [id, { x, y, sprite }] (id)}
    {#if x >= 0 && x <= width && y >= 0 && y <= height}
      <span class="star" class:occupied={sprite && systemState.has(id)} class:focus={id === focusID} style:left={`${x}px`} style:top={`${y}px`}>
        <img alt="" src={star} />
        {#if id === focusID}<span>{focusName}</span>{/if}
      </span>
    {/if}
  {/each}
</span>

<style>
  .preview { display: block; width: 100%; height: 164px; position: relative; overflow: hidden; background: #101519; }
  .territory, .link, .star { position: absolute; pointer-events: none; }
  .territory { mask-repeat: no-repeat; mask-size: 100% 100%; }
  .link { height: 1px; background: #ffffff44; transform-origin: left center; }
  .star { transform: translate(-50%, -50%); color: #fff; text-shadow: 0 1px 4px #000; }
  .star img { display: block; width: 7px; height: 7px; }
  .star.occupied img { width: 12px; height: 12px; }
  .star.focus img { width: 17px; height: 17px; }
  .star span { position: absolute; top: 0; left: 100%; margin-left: 4px; white-space: nowrap; }
</style>
