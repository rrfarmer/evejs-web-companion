<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { ShipSkinrSequenceComponent } from "../bridge/shipSkinrSequencing.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { shipSkinrElementPreviewDesign } from "../three/shipSkinrModel.ts";
  import ShipSkinrPreview from "./ShipSkinrPreview.svelte";

  let { store, flow, element, active = true }: { store: ClientStore; flow: AppFlow; element: ShipSkinrSequenceComponent; active?: boolean } = $props();
  const { flight, station, character } = $derived(store);
  const pilot = $derived($station.online);
  const typeID = $derived($flight.status?.shipTypeID ?? $character.characters.find(row => row.characterID === pilot?.characterID)?.shipTypeID ?? null);
  let design = $state.raw<Awaited<ReturnType<typeof shipSkinrElementPreviewDesign>>>(null);
  let failed = $state(false);

  $effect(() => {
    const type = typeID;
    const race = pilot?.raceID ?? 0;
    const component = { id: element.id, kind: element.kind };
    const options = flow.requestOptions();
    let current = true;
    design = null;
    failed = false;
    void import("../three/shipSkinrModel.ts").then(({ shipSkinrElementPreviewDesign }) => shipSkinrElementPreviewDesign(type, race, component, options))
      .then(result => { if (current) { design = result; failed = !result; } })
      .catch(() => { if (current) failed = true; });
    return () => { current = false; };
  });
</script>

{#if design}
  <ShipSkinrPreview {flow} {design} {active} />
{:else}
  <p role="status">{failed ? "Design element preview unavailable" : "Loading design element preview…"}</p>
{/if}
