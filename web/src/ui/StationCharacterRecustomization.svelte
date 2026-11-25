<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import PortraitBackdrop from "./PortraitBackdrop.svelte";
  import PortraitBaseHead from "./PortraitBaseHead.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const station = $derived(store.station);
  const characters = $derived(store.character);
  const imageServer = $derived(flow.imageServer);
  const characterID = $derived($station.online?.characterID ?? null);
  const gender = $derived($characters.characters.find(character => character.characterID === characterID)?.gender);
  const pilotHead = $derived(gender === 0 ? "female" : gender === 1 ? "male" : null);
  const urls = $derived([
    ...(characterID === null ? [] : [portraitUrl($imageServer, characterID, 256)].filter((url): url is string => url !== null)),
    clientTexture(portraitDefaultPath(256)),
  ]);
  let options = $state.raw<Awaited<ReturnType<AppFlow["readDockedPortraitOptions"]>> | null>(null);
  let selected = $state<number | undefined>();
  let preview = $state<"backdrop" | "female" | "male">("backdrop");
  let failed = $state(false);
  let saving = $state(false);
  let saveStatus = $state("");
  const backdrop = $derived(options?.backgrounds.find(entry => entry.id === selected));
  const url = $derived(backdrop ? `/client-res/portrait-background/${backdrop.id}` : "");
  const canSave = $derived(options?.state === 0 && options.backgroundID !== null);

  onMount(() => {
    void flow.readDockedPortraitOptions().then(data => {
      options = data;
      selected = data.backgrounds.find(entry => entry.id === data.backgroundID)?.id ?? data.backgrounds[0]?.id;
    }).catch(() => { failed = true; });
  });

  async function saveBackdrop(): Promise<void> {
    if (!options || !canSave || !backdrop || saving || options.backgroundID === backdrop.id) return;
    const backgroundID = backdrop.id;
    saving = true;
    saveStatus = "";
    try {
      await flow.saveDockedPortraitBackdrop(backgroundID);
      options = { ...options, backgroundID };
      saveStatus = "Backdrop saved.";
    } catch (error) {
      saveStatus = error instanceof Error ? error.message : "The backdrop could not be saved.";
    } finally {
      saving = false;
    }
  }
</script>

<div class="recustomization" data-window="characterRecustomization" data-appearance-state={options?.state}>
  <div class="identity">
    <h2>Current portrait</h2>
    <OwnerPicture name="Current pilot" {urls} size={152} />
    {#if options?.backgroundID != null}<p>Saved backdrop {options.backgroundID}</p>{/if}
    {#if options?.state === 2}<p>This pilot has no saved appearance yet.</p>{/if}
  </div>
  <div class="preview">
    <label>Preview
      <select bind:value={preview}>
        <option value="backdrop">{pilotHead ? "Base head with backdrop" : "Portrait backdrops"}</option>
        <option value="female">Female base head</option>
        <option value="male">Male base head</option>
      </select>
    </label>
    {#if preview !== "backdrop"}
      <div class="image"><PortraitBaseHead model={preview} /></div>
    {:else if options?.backgrounds.length}
      <label>Portrait backdrop
        <select bind:value={selected} disabled={saving} onchange={() => { saveStatus = ""; }}>
          {#each options.backgrounds as entry (entry.id)}
            <option value={entry.id}>Backdrop {entry.id}</option>
          {/each}
        </select>
      </label>
      <div class="image">
        {#if pilotHead && backdrop}
          <PortraitBaseHead model={pilotHead} backdropUrl={url} backdropIsDds={backdrop.isDds} />
        {:else if backdrop?.isDds}
          <PortraitBackdrop {url} />
        {:else if url}
          <img src={url} alt="Selected portrait backdrop" />
        {/if}
      </div>
      {#if canSave}
        <button type="button" disabled={saving || !backdrop || selected === options.backgroundID} onclick={saveBackdrop}>
          {saving ? "Saving…" : "Save backdrop"}
        </button>
        {#if saveStatus}<p role="status">{saveStatus}</p>{/if}
      {/if}
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
  button { margin-top: 10px; }
  @media (max-width: 520px) { .recustomization { gap: 12px; padding: 10px; } }
</style>
