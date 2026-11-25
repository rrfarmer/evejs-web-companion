<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import PortraitBackdrop from "./PortraitBackdrop.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const station = $derived(store.station);
  const imageServer = $derived(flow.imageServer);
  const characterID = $derived($station.online?.characterID ?? null);
  const urls = $derived([
    ...(characterID === null ? [] : [portraitUrl($imageServer, characterID, 256)].filter((url): url is string => url !== null)),
    clientTexture(portraitDefaultPath(256)),
  ]);
  let options = $state.raw<Awaited<ReturnType<AppFlow["readDockedPortraitOptions"]>> | null>(null);
  let selected = $state<number | undefined>();
  let failed = $state(false);
  const backdrop = $derived(options?.backgrounds.find(entry => entry.id === selected));
  const url = $derived(backdrop ? `/client-res/portrait-background/${backdrop.id}` : "");

  onMount(() => {
    void flow.readDockedPortraitOptions().then(data => {
      options = data;
      selected = data.backgrounds.find(entry => entry.id === data.backgroundID)?.id ?? data.backgrounds[0]?.id;
    }).catch(() => { failed = true; });
  });
</script>

<div class="recustomization" data-window="characterRecustomization" data-appearance-state={options?.state}>
  <div class="identity">
    <h2>Current portrait</h2>
    <OwnerPicture name="Current pilot" {urls} size={152} />
    {#if options?.backgroundID != null}<p>Saved backdrop {options.backgroundID}</p>{/if}
    {#if options?.state === 2}<p>This pilot has no saved appearance yet.</p>{/if}
    <p>Use the desktop EVE client to edit and save your character’s appearance.</p>
  </div>
  <div class="preview">
    {#if options?.backgrounds.length}
      <label>Portrait backdrop
        <select bind:value={selected}>
          {#each options.backgrounds as entry (entry.id)}
            <option value={entry.id}>Backdrop {entry.id}</option>
          {/each}
        </select>
      </label>
      <div class="image">
        {#if backdrop?.isDds}
          <PortraitBackdrop {url} />
        {:else if url}
          <img src={url} alt="Selected portrait backdrop" />
        {/if}
      </div>
    {:else}
      <p role="status">{failed || options ? "Portrait backdrops are unavailable." : "Reading portrait backdrops…"}</p>
    {/if}
  </div>
</div>

<style>
  .recustomization { display: grid; grid-template-columns: minmax(160px, 0.8fr) minmax(175px, 1.2fr); gap: 20px; padding: 16px; }
  .identity, .preview { min-width: 0; }
  h2 { margin: 0 0 12px; font-size: 14px; }
  p { margin: 10px 0; color: #abb8b3; font-size: 13px; line-height: 1.45; }
  label { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 13px; }
  select { min-width: 0; max-width: 100%; flex: 1; }
  .image { display: grid; background: #101716; aspect-ratio: 1; width: 100%; max-width: 332px; }
  img { width: 100%; aspect-ratio: 1; object-fit: contain; }
  @media (max-width: 520px) { .recustomization { gap: 12px; padding: 10px; } }
</style>
