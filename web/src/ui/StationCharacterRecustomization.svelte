<script lang="ts">
  import { onMount } from "svelte";
  import { dockedApparelSlots, readCapturePortrait, type PortraitHairTints } from "../app/api.ts";
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
  let currentImage = $state<string | null>(null);
  const imageUrl = $derived(characterID === null ? null : portraitUrl($imageServer, characterID, 256));
  const urls = $derived([
    ...(currentImage ? [currentImage] : []),
    ...(imageUrl ? [imageUrl] : []),
    clientTexture(portraitDefaultPath(256)),
  ]);
  let options = $state.raw<Awaited<ReturnType<AppFlow["readDockedPortraitOptions"]>> | null>(null);
  let selected = $state<number | undefined>();
  let fieldOfView = $state(0.3);
  let skinToneID = $state(0);
  let hairID = $state(0);
  let primaryID = $state(0);
  let secondaryID = $state(0);
  let selection = $state({ outer: 0, topmiddle: 0, bottomouter: 0, feet: 0 });
  const slotLabels = { outer: "Jacket", topmiddle: "Shirt", bottomouter: "Trousers", feet: "Footwear" };
  let showOutfit = $state(false);
  let preview = $state<"backdrop" | "female" | "male">("backdrop");
  let failed = $state(false);
  let saving = $state(false);
  let publishing = $state(false);
  let portraitView = $state<ReturnType<typeof PortraitBaseHead>>();
  let saveStatus = $state("");
  const backdrop = $derived(options?.backgrounds.find(entry => entry.id === selected));
  const url = $derived(backdrop ? `/client-res/portrait-background/${backdrop.id}` : "");
  const initial = $derived(options?.state === 2);
  const canPublish = $derived(options?.state === 0 && options.backgroundID !== null);
  const canSave = $derived(canPublish || (initial && pilotHead !== null));
  const zoomChanged = $derived(Boolean(pilotHead && options?.framing && fieldOfView !== options.framing.fieldOfView));
  const skinTone = $derived(options?.skinTones.find(tone => tone.id === skinToneID));
  const hasSkinTones = $derived(Boolean(pilotHead && options?.skinTones.length));
  const skinChanged = $derived(hasSkinTones && skinToneID !== options?.skinToneID);
  const chosenHair = $derived(options?.hairstyles.find(style => style.id === hairID));
  const hairChanged = $derived(Boolean(options?.hairstyles.length && hairID !== options.hairID));
  const hairColorChanged = $derived(Boolean(options && (options.hairColor.primaryID !== primaryID || options.hairColor.secondaryID !== secondaryID)));
  const primary = $derived(options?.hairColors.primary.find(color => color.id === primaryID));
  const secondary = $derived(options?.hairColors.secondary.find(color => color.id === secondaryID));
  const hairTints = $derived<PortraitHairTints | undefined>(primary || secondary
    ? { primary: primary?.colors[0], secondary: secondary && [secondary.colors[1], secondary.colors[2]] } : undefined);
  const acceptsHairColor = $derived(Boolean(chosenHair && !chosenHair.style.startsWith("hair_implant_")));
  const apparelChoices = $derived(dockedApparelSlots.flatMap(slot => {
    const group = options?.clothing?.slots[slot];
    return group?.choices.length ? [{ slot, group, choice: group.choices.find(row => row.id === selection[slot]) }] : [];
  }));
  const apparelIDs = $derived(Object.fromEntries(apparelChoices.flatMap(({ slot, group, choice }) =>
    choice && choice.id !== group.id ? [[slot, choice.id]] : [])));
  const apparel = $derived({ ...options?.clothing?.apparel, ...Object.fromEntries(apparelChoices.flatMap(({ slot, choice }) =>
    slot !== "outer" && choice ? [[slot, choice.asset]] : [])) });
  const jacket = $derived(apparelChoices.find(({ slot }) => slot === "outer")?.choice?.asset ?? options?.clothing?.outfit);
  const outfit = $derived(jacket ?? apparel.topmiddle);
  const hasChanges = $derived(initial || selected !== options?.backgroundID || zoomChanged || skinChanged || hairChanged ||
    hairColorChanged || Object.keys(apparelIDs).length > 0);
  const busy = $derived(saving || publishing);

  onMount(() => {
    if (characterID !== null) {
      void readCapturePortrait(characterID, 256, null, flow.requestOptions()).then(({ image }) => {
        if (image && currentImage === null) currentImage = `data:${image.contentType};base64,${image.base64}`;
      }).catch(() => {});
    }
    void flow.readDockedPortraitOptions().then(data => {
      options = data;
      selected = data.backgrounds.find(entry => entry.id === data.backgroundID)?.id ?? data.backgrounds[0]?.id;
      fieldOfView = data.framing?.fieldOfView ?? 0.3;
      skinToneID = data.skinToneID;
      hairID = data.hairID;
      primaryID = data.hairColor.primaryID;
      secondaryID = data.hairColor.secondaryID;
      for (const slot of dockedApparelSlots) selection[slot] = data.clothing?.slots[slot].id ?? 0;
    }).catch(() => { failed = true; });
  });

  async function savePortrait(): Promise<void> {
    if (!options || !canSave || !backdrop || busy || !hasChanges) return;
    const backgroundID = backdrop.id;
    const initialFrame = initial ? portraitView?.readPortraitFrame() : undefined;
    if (initial && !initialFrame) {
      saveStatus = "Wait for the portrait preview to finish loading.";
      return;
    }
    const framing = initialFrame ? { ...initialFrame, fieldOfView } :
      options.framing && zoomChanged ? { ...options.framing, fieldOfView } : options.framing;
    saving = true;
    saveStatus = "";
    try {
      await flow.saveDockedPortrait({ backgroundID, fieldOfView: initialFrame || zoomChanged ? fieldOfView : null,
        skinToneID: skinChanged ? skinToneID : null, hairID: hairChanged ? hairID : null,
        hairColor: hairColorChanged ? { primaryID, secondaryID } : null, apparelIDs,
        initialFrame: initialFrame ?? undefined });
      const clothing = options.clothing;
      if (clothing) {
        const slots = { ...clothing.slots };
        for (const slot of dockedApparelSlots) slots[slot] = { ...slots[slot], id: apparelIDs[slot] ?? slots[slot].id };
        options = { ...options, clothing: { ...clothing, slots, apparel, outfit: jacket ?? null } };
      }
      options = { ...options, state: 0, backgroundID, framing, skinToneID, hairID, hairColor: { primaryID, secondaryID } };
      saveStatus = initialFrame ? "Appearance saved. You can now publish your portrait." : "Portrait settings saved.";
    } catch (error) {
      saveStatus = error instanceof Error ? error.message : "The portrait settings could not be saved.";
    } finally {
      saving = false;
    }
  }

  async function publishPortrait(): Promise<void> {
    if (!portraitView || !canPublish || busy || hasChanges || (hairID !== 0 && !chosenHair)) return;
    publishing = true;
    saveStatus = "";
    try {
      const jpeg = portraitView.capturePortrait();
      await flow.publishDockedPortraitImage(jpeg);
      currentImage = `data:image/jpeg;base64,${jpeg}`;
      saveStatus = "Portrait published.";
    } catch (error) {
      saveStatus = error instanceof Error ? error.message : "The portrait could not be published.";
    } finally {
      publishing = false;
    }
  }
</script>

<div class="recustomization" data-window="characterRecustomization" data-appearance-state={options?.state}>
  <div class="identity">
    <h2>Current portrait</h2>
    <OwnerPicture name="Current pilot" {urls} size={152} />
    {#if options?.backgroundID != null}<p>Saved backdrop {options.backgroundID}</p>{/if}
    {#if initial}<p>Choose your appearance and save it before publishing a portrait.</p>{/if}
  </div>
  <div class="preview">
    <label>Preview
      <select bind:value={preview} disabled={busy}>
        <option value="backdrop">{pilotHead ? "Portrait preview" : "Portrait backdrops"}</option>
        <option value="female">Female base head</option>
        <option value="male">Male base head</option>
      </select>
    </label>
    {#if preview !== "backdrop"}
      <div class="image"><PortraitBaseHead model={preview} /></div>
    {:else if options?.backgrounds.length}
      <label>Portrait backdrop
        <select bind:value={selected} disabled={busy} onchange={() => { saveStatus = ""; }}>
          {#each options.backgrounds as entry (entry.id)}
            <option value={entry.id}>Backdrop {entry.id}</option>
          {/each}
        </select>
      </label>
      {#if pilotHead && outfit && !initial}
        <button class="appearance-choice" type="button" disabled={busy} onclick={() => { showOutfit = !showOutfit; }}>
          {showOutfit ? "Show portrait" : "Show outfit"}
        </button>
      {/if}
      <div class="image" class:outfit-preview={showOutfit}>
        {#if showOutfit && pilotHead && outfit}
          <PortraitBaseHead model={pilotHead} bloodlineID={options.bloodlineID} {outfit} {apparel}
            hairstyle={chosenHair?.style} {hairTints} {hasSkinTones} skinColors={skinTone?.colors} />
        {:else if pilotHead && backdrop}
          <PortraitBaseHead bind:this={portraitView} model={pilotHead} backdropUrl={url} backdropIsDds={backdrop.isDds}
            bloodlineID={options.bloodlineID} framing={options.framing} {fieldOfView}
            {hasSkinTones} skinColors={skinTone?.colors} hairstyle={chosenHair?.style} {hairTints} />
        {:else if backdrop?.isDds}
          <PortraitBackdrop {url} />
        {:else if url}
          <img src={url} alt="Selected portrait backdrop" />
        {/if}
      </div>
      {#if canSave}
        {#each apparelChoices as { slot, group } (slot)}
          <label class="appearance-choice">{slotLabels[slot]}
            <select bind:value={selection[slot]} disabled={busy} onchange={() => { saveStatus = ""; }}>
              {#if !group.choices.some(choice => choice.id === group.id)}
                <option value={group.id}>{group.id ? "Saved selection" : "No saved selection"}</option>
              {/if}
              {#each group.choices as choice (choice.id)}<option value={choice.id}>{choice.name}</option>{/each}
            </select>
          </label>
        {/each}
        {#if pilotHead && options.hairstyles.length}
          <label class="appearance-choice">Hairstyle
            <select bind:value={hairID} disabled={busy} onchange={() => { saveStatus = ""; }}>
              <option value={0}>Default</option>
              {#if options.hairID !== 0 && !options.hairstyles.some(style => style.id === options?.hairID)}
                <option value={options.hairID}>Saved hairstyle</option>
              {/if}
              {#each options.hairstyles as style (style.id)}<option value={style.id}>{style.name}</option>{/each}
            </select>
          </label>
        {/if}
        {#if acceptsHairColor && options.hairColors.primary.length}
          <label class="appearance-choice">Hair color
            <select bind:value={primaryID} disabled={busy} onchange={() => { saveStatus = ""; }}>
              <option value={0}>Default</option>
              {#if primaryID && !primary}<option value={primaryID}>Saved color</option>{/if}
              {#each options.hairColors.primary as color (color.id)}
                <option value={color.id}>{color.name}</option>
              {/each}
            </select>
            {#if primary}<span class="hair-color-sample" aria-hidden="true"
              style:background-color={`rgb(${primary.colors[0].map(value => value * 255).join(" ")})`}></span>{/if}
          </label>
        {/if}
        {#if acceptsHairColor && options.hairColors.secondary.length}
          <label class="appearance-choice">Hair accent
            <select bind:value={secondaryID} disabled={busy} onchange={() => { saveStatus = ""; }}>
              <option value={0}>Default</option>
              {#if secondaryID && !secondary}<option value={secondaryID}>Saved accent</option>{/if}
              {#each options.hairColors.secondary as color (color.id)}
                <option value={color.id}>{color.name}</option>
              {/each}
            </select>
            {#if secondary}<span class="hair-color-sample" aria-hidden="true"
              style:background-color={`rgb(${secondary.colors[1].map(value => value * 255).join(" ")})`}></span>{/if}
          </label>
        {/if}
        {#if hasSkinTones}
          <label class="skin-tone">Skin tone
            <select bind:value={skinToneID} disabled={busy} onchange={() => { saveStatus = ""; }}>
              <option value={0}>Bloodline base</option>
              {#each options.skinTones as tone (tone.id)}<option value={tone.id}>{tone.name}</option>{/each}
            </select>
          </label>
        {/if}
        {#if pilotHead && (initial || options.framing)}
          <label class="zoom">Zoom
            <input type="range" min="-1.5" max="-0.2" step="0.001" value={-fieldOfView} disabled={busy}
              oninput={event => { fieldOfView = -event.currentTarget.valueAsNumber; saveStatus = ""; }} />
          </label>
        {/if}
        <div class="portrait-actions">
          <button type="button" disabled={busy || !backdrop || !hasChanges} onclick={savePortrait}>
            {saving ? "Saving…" : initial ? "Save appearance" : "Save portrait"}
          </button>
          {#if pilotHead && canPublish}
            <button type="button" disabled={busy || hasChanges || !portraitView || (hairID !== 0 && !chosenHair)} onclick={publishPortrait}>
              {publishing ? "Publishing…" : "Publish portrait"}
            </button>
          {/if}
        </div>
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
  .outfit-preview { aspect-ratio: 4 / 5; }
  img { width: 100%; aspect-ratio: 1; object-fit: contain; }
  .portrait-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .zoom, .skin-tone, .appearance-choice { margin-top: 10px; }
  .hair-color-sample { width: 16px; height: 16px; border: 1px solid var(--border); }
  .zoom input { flex: 1; min-width: 0; }
  @media (max-width: 520px) { .recustomization { gap: 12px; padding: 10px; } }
</style>
