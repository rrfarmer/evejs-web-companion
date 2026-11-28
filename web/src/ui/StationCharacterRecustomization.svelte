<script lang="ts">
  import { onMount } from "svelte";
  import { dockedApparelSlots, readCapturePortrait, supportedSculptRegions, type BodySculptSliders, type PortraitSculptEdit,
    type PortraitHairTints, type PortraitMakeup } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import PortraitBackdrop from "./PortraitBackdrop.svelte";
  import PortraitBaseHead from "./PortraitBaseHead.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const station = $derived(store.station);
  const characters = $derived(store.character);
  const words = $derived(store.words);
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
  let hairDarkness = $state<number | null>(null);
  let beardID = $state(0);
  let faceRegionID = $state(0);
  let faceEdits = $state.raw<Record<string, PortraitSculptEdit>>({});
  let bodyRegionEdits = $state.raw<Record<string, PortraitSculptEdit>>({});
  let bodyRegionID = $state(0);
  let outfitCatalog = $state.raw<{ key: string; names: ReadonlySet<string> } | null>(null);
  let bodyEdits = $state.raw<Partial<BodySculptSliders>>({});
  let selection = $state({ outer: 0, topouter: 0, topmiddle: 0, bottomouter: 0, feet: 0, "accessories/glasses": 0, "accessories/masks": 0 });
  let robeHood = $state(0);
  const slotLabels = { outer: "Outerwear", topouter: "Overshirt", topmiddle: "Shirt", bottomouter: "Trousers", feet: "Footwear",
    "accessories/glasses": "Eyewear", "accessories/masks": "Masks" };
  const optionalApparelSlots = ["outer", "topouter", "accessories/glasses", "accessories/masks"] as const;
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
  const resculpt = $derived(options?.state === 1);
  const faceRegion = $derived(options?.faceSculpts.find(region => region.id === faceRegionID));
  const faceSculpts = $derived(Object.values(faceEdits));
  const bodySculpts = $derived(Object.values(bodyRegionEdits));
  const morphs = $derived.by(() => {
    if (!options) return [];
    if (!faceSculpts.length && !bodySculpts.length && !Object.keys(bodyEdits).length) return options.morphs;
    const result = new Map(options.morphs.map(morph => [morph.name, morph]));
    for (const edit of [...faceSculpts, ...bodySculpts]) {
      const region = options.faceSculpts.find(region => region.id === edit.locationID);
      const body = !region;
      const axis = (region ?? options.bodyRegions.find(region => region.id === edit.locationID))?.axes.find(axis => axis.axis === edit.axis);
      if (!axis) continue;
      result.delete(axis.negative);
      result.delete(axis.positive);
      if (edit.value !== 0) {
        const name = edit.value < 0 ? axis.negative : axis.positive;
        result.set(name, { name, weight: Math.abs(edit.value), ...(body ? { body: true } : {}) });
      }
    }
    const limits = options.bodySculpt?.limits;
    if (limits) {
      const setBodyMorph = (name: string, weight: number) => {
        if (weight > 0) result.set(name, { name, weight, body: true });
        else result.delete(name);
      };
      if (bodyEdits.weight !== undefined) {
        setBodyMorph("thinshape", Math.max(0, 1 - 2 * bodyEdits.weight) * limits.thin);
        setBodyMorph("fatshape", Math.max(0, 2 * bodyEdits.weight - 1) * limits.fat);
      }
      if (bodyEdits.muscularity !== undefined) setBodyMorph("muscularshape", bodyEdits.muscularity * limits.muscular);
    }
    return [...result.values()];
  });
  const faceAxisLabels = ["Vertical", "Horizontal", "Depth"];
  const faceRegionLabel = (prefix: string) => prefix.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase());
  const faceEditKey = (locationID: number, axis: number) => `${locationID}:${axis}`;
  function editRegion(body: boolean, locationID: number, axis: number, value: number, saved: number): void {
    const key = faceEditKey(locationID, axis);
    const next = { ...(body ? bodyRegionEdits : faceEdits) };
    if (value === saved) delete next[key];
    else next[key] = { locationID, axis, value };
    if (body) bodyRegionEdits = next;
    else faceEdits = next;
    saveStatus = "";
  }
  function editBody(slider: keyof BodySculptSliders, value: number, saved: number): void {
    const next = { ...bodyEdits };
    if (value === saved) delete next[slider];
    else next[slider] = value;
    bodyEdits = next;
    showOutfit = true;
    saveStatus = "";
  }
  const canPublish = $derived(options?.state === 0 && options.backgroundID !== null);
  const canSave = $derived(canPublish || ((initial || resculpt) && pilotHead !== null));
  const needsFrame = $derived(initial || (resculpt && !options?.framing));
  const reviewPortrait = $derived(needsFrame && showOutfit);
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
  const hairDarknessChanged = $derived(hairDarkness !== null && hairDarkness !== options?.hairDarkness);
  const beardStyle = $derived(beardID === 0 ? null
    : options?.beards.find(style => style.id === beardID)?.style ?? options?.beardStyle);
  const beardChanged = $derived(Boolean(options?.beards.length && beardID !== options.beardID));
  const facialHairScale = $derived(hairDarkness === null ? undefined : 0.2 + 0.8 * hairDarkness);
  const facialHair = $derived.by<readonly PortraitMakeup[] | undefined>(() => {
    if (!pilotHead) return;
    const root = `/client-assets/portrait-head/${pilotHead}/makeup`;
    const palette = `hair_${primary?.key ?? "default"}${secondary ? `~${secondary.key}` : ""}`;
    const layers: PortraitMakeup[] = [];
    if (options?.browStyle && acceptsHairColor) {
      layers.push({ asset: `${root}/eyebrows/${options.browStyle}/${palette}.json`, weight: 1, gloss: null });
    }
    if (pilotHead === "male" && beardStyle) {
      const painted = beardStyle.startsWith("beard_");
      layers.push({ asset: `${root}/beard/${painted ? "stubble" : beardStyle}/default.json`, weight: 1, gloss: null });
      if (painted) layers.push({ asset: `${root}/beard/${beardStyle}/${palette}.json`, weight: 1, gloss: null });
    }
    return layers.length ? layers : undefined;
  });
  const eyebrowsLabel = "UI/Login/CharacterCreation/AssetMenu/EyebrowsColor";
  const facialHairLabel = "UI/Login/CharacterCreation/AssetMenu/FacialHairColor";
  const beardLabel = "UI/Login/CharacterCreation/AssetMenu/ModifierNames/FacialHair";
  const bodyLabels = {
    weight: "UI/Login/CharacterCreation/AssetMenu/ModifierNames/Weight",
    muscularity: "UI/Login/CharacterCreation/AssetMenu/ModifierNames/Muscularity",
  };
  const darknessLabel = $derived(pilotHead === "female"
    ? plainText($words.templates[eyebrowsLabel] ?? "") || "Eyebrows Color"
    : plainText($words.templates[facialHairLabel] ?? "") || "Facial Hair Color");
  const apparelChoices = $derived(dockedApparelSlots.flatMap(slot => {
    const group = options?.clothing?.slots[slot];
    const optional = optionalApparelSlots.some(optionalSlot => optionalSlot === slot);
    return group && (group.choices.length || (optional && group.id))
      ? [{ slot, group, optional, choice: group.choices.find(row => row.id === selection[slot]) }] : [];
  }));
  const apparelIDs = $derived(Object.fromEntries(apparelChoices.flatMap(({ slot, group, optional, choice }) => {
    const id = optional && selection[slot] === 0 ? 0 : choice?.id;
    return id !== undefined && id !== group.id ? [[slot, id]] : [];
  })));
  const apparel = $derived.by(() => {
    const layers = { ...options?.clothing?.apparel };
    for (const { slot, choice } of apparelChoices) {
      if (slot !== "outer" && choice) layers[slot] = choice.asset;
    }
    for (const slot of optionalApparelSlots) {
      if (slot !== "outer" && selection[slot] === 0) delete layers[slot];
    }
    return layers;
  });
  const jacket = $derived(selection.outer === 0 ? null
    : apparelChoices.find(({ slot }) => slot === "outer")?.choice?.asset ?? options?.clothing?.outfit);
  const adjustableHood = $derived(Boolean(jacket?.startsWith("/client-assets/portrait-outfit/male/robeam01/")));
  const hoodChanged = $derived(adjustableHood && robeHood !== (options?.clothing?.robeHood ?? 0));
  const outfit = $derived(jacket ?? apparel.topouter ?? apparel.topmiddle);
  const outfitCatalogKey = $derived(JSON.stringify([outfit, apparel, robeHood]));
  const bodyRegions = $derived(outfitCatalog?.key === outfitCatalogKey && options
    ? supportedSculptRegions(options.bodyRegions, outfitCatalog.names) : []);
  const bodyRegion = $derived(bodyRegions.find(region => region.id === bodyRegionID) ?? bodyRegions[0]);
  function receiveOutfitMorphs(names: ReadonlySet<string>): void {
    outfitCatalog = { key: outfitCatalogKey, names };
  }
  const hasChanges = $derived(initial || selected !== options?.backgroundID || zoomChanged || skinChanged || hairChanged ||
    hairColorChanged || hairDarknessChanged || beardChanged || hoodChanged || faceSculpts.length > 0 ||
    bodySculpts.length > 0 || Object.keys(bodyEdits).length > 0 || Object.keys(apparelIDs).length > 0);
  const busy = $derived(saving || publishing);

  onMount(() => {
    flow.requestWords([eyebrowsLabel, facialHairLabel, beardLabel, ...Object.values(bodyLabels)]);
    if (characterID !== null) {
      void readCapturePortrait(characterID, 256, null, flow.requestOptions()).then(({ image }) => {
        if (image && currentImage === null) currentImage = `data:${image.contentType};base64,${image.base64}`;
      }).catch(() => {});
    }
    void flow.readDockedPortraitOptions().then(data => {
      options = data;
      faceRegionID = data.faceSculpts[0]?.id ?? 0;
      selected = data.backgrounds.find(entry => entry.id === data.backgroundID)?.id ?? data.backgrounds[0]?.id;
      fieldOfView = data.framing?.fieldOfView ?? 0.3;
      skinToneID = data.skinToneID;
      hairID = data.hairID;
      primaryID = data.hairColor.primaryID;
      secondaryID = data.hairColor.secondaryID;
      hairDarkness = data.hairDarkness;
      beardID = data.beardID;
      for (const slot of dockedApparelSlots) selection[slot] = data.clothing?.slots[slot].id ?? 0;
      robeHood = data.clothing?.robeHood ?? 0;
    }).catch(() => { failed = true; });
  });

  async function savePortrait(): Promise<void> {
    if (!options || !canSave || !backdrop || busy || (!hasChanges && !resculpt)) return;
    const paid = resculpt;
    const savedMorphs = morphs;
    const backgroundID = backdrop.id;
    if (reviewPortrait) {
      showOutfit = false;
      saveStatus = "";
      return;
    }
    const initialFrame = needsFrame ? portraitView?.readPortraitFrame() : undefined;
    if (needsFrame && !initialFrame) {
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
        hairColor: hairColorChanged ? { primaryID, secondaryID } : null,
        hairDarkness: hairDarknessChanged ? hairDarkness : null, beardID: beardChanged ? beardID : null, apparelIDs,
        robeHood: adjustableHood && (hoodChanged || apparelIDs.outer) ? robeHood : null,
        initialFrame: initialFrame ?? undefined, resculpt: paid, faceSculpts, bodySculpts,
        bodySliders: Object.keys(bodyEdits).length ? bodyEdits : null });
      const clothing = options.clothing;
      if (clothing) {
        const slots = { ...clothing.slots };
        for (const slot of dockedApparelSlots) slots[slot] = { ...slots[slot], id: apparelIDs[slot] ?? slots[slot].id };
        options = { ...options, clothing: { ...clothing, slots, apparel, outfit: jacket ?? null,
          robeHood: adjustableHood ? robeHood : null } };
      }
      options = { ...options, state: 0, backgroundID, framing, skinToneID, hairID, hairColor: { primaryID, secondaryID },
        hairDarkness, beardID, beardStyle: beardStyle ?? null, morphs: savedMorphs };
      faceEdits = {};
      bodyEdits = {};
      bodyRegionEdits = {};
      saveStatus = paid ? "Resculpt saved. You can now publish your portrait." :
        initialFrame ? "Appearance saved. You can now publish your portrait." : "Portrait settings saved.";
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
    {#if resculpt}<p>Saving your resculpt completes the certificate. You can close the editor and resume later.</p>{/if}
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
      {#if pilotHead && outfit}
        <button class="appearance-choice" type="button" disabled={busy} onclick={() => { showOutfit = !showOutfit; }}>
          {showOutfit ? "Show portrait" : "Show outfit"}
        </button>
      {/if}
      <div class="image" class:outfit-preview={showOutfit}>
        {#if showOutfit && pilotHead && outfit}
          <PortraitBaseHead model={pilotHead} bloodlineID={options.bloodlineID} {outfit} {apparel} robeHood={adjustableHood ? robeHood : 0}
            hairstyle={chosenHair?.style} {hairTints} {hasSkinTones} skinColors={skinTone?.colors}
            makeup={facialHair} {facialHairScale} {morphs}
            onOutfitMorphs={(initial || resculpt) ? receiveOutfitMorphs : undefined} />
        {:else if pilotHead && backdrop}
          <PortraitBaseHead bind:this={portraitView} model={pilotHead} backdropUrl={url} backdropIsDds={backdrop.isDds}
            bloodlineID={options.bloodlineID} framing={options.framing} {fieldOfView}
            {hasSkinTones} skinColors={skinTone?.colors} hairstyle={chosenHair?.style} {hairTints} {apparel}
            makeup={facialHair} {facialHairScale} {morphs} />
        {:else if backdrop?.isDds}
          <PortraitBackdrop {url} />
        {:else if url}
          <img src={url} alt="Selected portrait backdrop" />
        {/if}
      </div>
      {#if canSave}
        {#if (initial || resculpt) && faceRegion}
          <fieldset class="sculpt-controls face-sculpt">
            <legend>Face sculpt</legend>
            <label>Face region
              <select bind:value={faceRegionID} disabled={busy}>
                {#each options.faceSculpts as region (region.id)}
                  <option value={region.id}>{faceRegionLabel(region.prefix)}</option>
                {/each}
              </select>
            </label>
            {#each faceRegion.axes as axis (axis.axis)}
              {@const regionID = faceRegion.id}
              <label>{faceAxisLabels[axis.axis]}
                <input type="range" min={axis.min} max={axis.max} step="any" disabled={busy}
                  data-face-axis={axis.axis} value={faceEdits[faceEditKey(regionID, axis.axis)]?.value ?? axis.value}
                  onchange={event => editRegion(false, regionID, axis.axis, event.currentTarget.valueAsNumber, axis.value)} />
              </label>
            {/each}
          </fieldset>
        {/if}
        {#if (initial || resculpt) && options.bodySculpt && outfit}
          {@const body = options.bodySculpt}
          <fieldset class="sculpt-controls body-sculpt">
            <legend>Body shape</legend>
            {#each (["muscularity", "weight"] as const) as slider (slider)}
              <label>{plainText($words.templates[bodyLabels[slider]] ?? "") || (slider === "weight" ? "Weight" : "Muscularity")}
                <input type="range" min="0" max="1" step="any" disabled={busy} data-body-slider={slider}
                  value={bodyEdits[slider] ?? body[slider]}
                  onchange={event => editBody(slider, event.currentTarget.valueAsNumber, body[slider])} />
              </label>
            {/each}
          </fieldset>
        {/if}
        {#if (initial || resculpt) && showOutfit && bodyRegion}
          <fieldset class="sculpt-controls body-regions">
            <legend>Body sculpt</legend>
            <label>Body region
              <select value={bodyRegion.id} disabled={busy} onchange={event => { bodyRegionID = Number(event.currentTarget.value); }}>
                {#each bodyRegions as region (region.id)}
                  <option value={region.id}>{faceRegionLabel(region.prefix)}</option>
                {/each}
              </select>
            </label>
            {#each bodyRegion.axes as axis (axis.axis)}
              {@const regionID = bodyRegion.id}
              <label>{faceAxisLabels[axis.axis]}
                <input type="range" min={axis.min} max={axis.max} step="any" disabled={busy}
                  data-body-axis={axis.axis} value={bodyRegionEdits[faceEditKey(regionID, axis.axis)]?.value ?? axis.value}
                  onchange={event => editRegion(true, regionID, axis.axis, event.currentTarget.valueAsNumber, axis.value)} />
              </label>
            {/each}
          </fieldset>
        {/if}
        {#each apparelChoices as { slot, group, optional } (slot)}
          <label class="appearance-choice">{slotLabels[slot]}
            <select bind:value={selection[slot]} disabled={busy} onchange={event => {
              if (slot === "outer") robeHood = Number(event.currentTarget.value) === group.id ? options?.clothing?.robeHood ?? 0 : 0;
              saveStatus = "";
            }}>
              {#if optional}<option value={0}>None</option>{/if}
              {#if (!optional || group.id) && !group.choices.some(choice => choice.id === group.id)}
                <option value={group.id}>{group.id ? "Saved selection" : "No saved selection"}</option>
              {/if}
              {#each group.choices as choice (choice.id)}<option value={choice.id}>{choice.name}</option>{/each}
            </select>
          </label>
        {/each}
        {#if adjustableHood}
          <label class="appearance-choice">Hood
            <select bind:value={robeHood} disabled={busy} onchange={() => { saveStatus = ""; }}>
              <option value={0}>Down</option>
              <option value={1}>Up</option>
              <option value={2}>Covered</option>
            </select>
          </label>
        {/if}
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
        {#if options.beards.length}
          <label class="appearance-choice">{plainText($words.templates[beardLabel] ?? "") || "Facial Hair"}
            <select bind:value={beardID} disabled={busy} onchange={() => { saveStatus = ""; }}>
              <option value={0}>None</option>
              {#if options.beardID && !options.beards.some(style => style.id === options?.beardID)}
                <option value={options.beardID}>Saved facial hair</option>
              {/if}
              {#each options.beards as style (style.id)}<option value={style.id}>{style.name}</option>{/each}
            </select>
          </label>
        {/if}
        {#if (acceptsHairColor || beardStyle?.startsWith("beard_")) && hairDarkness !== null}
          <label class="appearance-choice">{darknessLabel}
            <input type="range" min="0" max="1" step="any" value={hairDarkness} disabled={busy}
              oninput={event => { hairDarkness = event.currentTarget.valueAsNumber; saveStatus = ""; }} />
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
        {#if pilotHead && (initial || resculpt || options.framing)}
          <label class="zoom">Zoom
            <input type="range" min="-1.5" max="-0.2" step="0.001" value={-fieldOfView} disabled={busy}
              oninput={event => { fieldOfView = -event.currentTarget.valueAsNumber; saveStatus = ""; }} />
          </label>
        {/if}
        <div class="portrait-actions">
          <button type="button" disabled={busy || !backdrop || (!hasChanges && !resculpt)} onclick={savePortrait}>
            {saving ? "Saving…" : reviewPortrait ? "Review portrait" : resculpt ? "Save resculpt" : initial ? "Save appearance" : "Save portrait"}
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
  .sculpt-controls { min-width: 0; margin: 10px 0; padding: 8px 10px 0; border: 1px solid var(--border); }
  label input[type="range"] { flex: 1; min-width: 0; }
  @media (max-width: 520px) { .recustomization { gap: 12px; padding: 10px; } }
</style>
