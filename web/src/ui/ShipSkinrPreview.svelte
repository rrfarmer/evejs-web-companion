<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ShipSkinrDesign } from "../bridge/shipSkinr.ts";
  import type { shipSkinrPreviewPaint } from "../three/shipSkinrModel.ts";
  import ShipInfoPreview from "./ShipInfoPreview.svelte";
  import type { ShipEmblemImages } from "../bridge/shipEmblems.ts";

  let { design, flow, active = true, emblems }: {
    design: Pick<ShipSkinrDesign, "shipTypeID" | "layout">;
    flow: AppFlow;
    active?: boolean;
    emblems?: ShipEmblemImages;
  } = $props();
  let host = $state<HTMLDivElement>();
  let visible = $state(false);
  let failed = $state(false);
  let paint = $state.raw<Awaited<ReturnType<typeof shipSkinrPreviewPaint>> | null>(null);

  $effect(() => {
    const element = host;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; });
    observer.observe(element);
    return () => observer.disconnect();
  });

  $effect(() => {
    const { shipTypeID, layout } = design;
    const options = flow.requestOptions();
    let current = true;
    failed = false;
    paint = null;
    void import("../three/shipSkinrModel.ts").then(({ shipSkinrPreviewPaint }) => shipSkinrPreviewPaint(shipTypeID, layout, options))
      .then(result => { if (current) paint = result; })
      .catch(() => { if (current) failed = true; });
    return () => { current = false; };
  });
</script>

<div class="skinr-preview" bind:this={host}>
  {#if paint}
    <ShipInfoPreview typeID={design.shipTypeID} {...paint} {emblems} expanded active={active && visible} />
  {:else}
    <p role="status">{failed ? "Ship preview unavailable" : "Loading ship preview…"}</p>
  {/if}
</div>

<style>
  .skinr-preview { width: 100%; height: clamp(9rem, 22vh, 14rem); background: #000; }
  p { margin: 0; padding: 10px; }
</style>
