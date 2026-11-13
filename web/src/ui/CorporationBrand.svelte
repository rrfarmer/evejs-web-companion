<script lang="ts">
  // corporation/brand_management/brandManagementPanel.py BrandManagementPanel (Administration > General > Brand
  // Management, a brand manager's) and brandManagementCards.py: cards (196 high, at most 700 wide, 16 apart) - the
  // Logo card (the corporation's logo, 96, and its name; Edit Logo, disabled with AccessibleWithRole for one without
  // Brand Manager), the Color Palette card where the corporation_palettes_enabled flag is on (default on: here) - one
  // ColorPickerCont per colour (each its colour at 100%, 60% and 20%), DesignedBy <owner link> and the date
  // (%Y.%m.%d), Edit Colors - and the Structure SKINR card (TrySKINRTitle, StructureSKINRDescription, Details, Open
  // SKINR). Edit Colors opens EditColorsPanel over the cards (PanelOverlayCont, ColorPalette, with its back arrow): Color
  // Set and Randomize, the Primary / Color 2 / Color 3 cards (each its ColorPickerCont or "+ Add Color", a colour picker
  // on a click, the hex field, Remove on the optional two; Color 3 shown only with a Color 2, a Color 3 alone moved up),
  // the Preview (CorpColorBannerWithLogo: banner_bg_large in the primary at 20%, one thick stripe or two / three thin ones
  // in the colours, the logo above), Update (set_colors: SetRequest; 403 UnableToSetCorpColorsRoleMissing, else
  // CannotConnectToServer) and Cancel; leaving with changes asks PromptSaveCorpColorChanges (Yes updates).
  // Details: CorpStructureDesignPanel in the same overlay (CorporationStructureDesign.svelte). Edit Logo:
  // EditCorpDetails. Open SKINR: uicore.cmd.OpenPaintToolWindow (PaintToolWindow.svelte).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import CorpLogo from "./CorpLogo.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import CorporationCreate from "./CorporationCreate.svelte";
  import CorporationStructureDesign from "./CorporationStructureDesign.svelte";
  let { store, flow, openPaintTool }: { store: ClientStore; flow: AppFlow; openPaintTool?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const corpLogos = flow.corpLogos;
  // svelte-ignore state_referenced_locally
  const corpLogoLibrary = flow.corpLogoLibrary;
  const B = "UI/Corporations/BaseCorporationUI/";
  const LABELS = ["UI/Corporations/CorporationWindow/Alliances/Members/Logo", B + "EditLogo", B + "ColorPalette", B + "EditColors", B + "DesignedBy", "UI/Personalization/PaintTool/TrySKINRTitle",
    B + "StructureSKINRDescription", B + "ColorSet", B + "PrimaryColor", B + "Color2", B + "Color3", B + "AddColor", B + "Preview", B + "UnableToSetCorpColorsRoleMissing",
    "UI/CharacterCreation/Randomize", "UI/Common/Update", "UI/Common/Cancel", "UI/Common/CannotConnectToServer", "UI/Commands/Remove", "UI/Common/Details", "UI/Personalization/PaintTool/OpenSKINR", "UI/Corporations/CorporationWindow/AccessibleWithRole", ...Object.keys(LINK_WORDS)];
  const nameOf = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const text = (label: string, args: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", args as never, { nameOf });
  const followerOf = (url: string, t: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), t);
  const corpID = $derived($station.online?.corporationID ?? 0);
  const brandManager = $derived((BigInt($station.online?.corpRole ?? "0") & 34359738368n) !== 0n);
  let colors = $state<Awaited<ReturnType<AppFlow["ownCorporationColors"]>> | null>(null), error = $state("");
  onMount(() => {
    flow.requestWords(LABELS);
    if (corpID) { flow.requestCorpLogos([corpID]); flow.requestNames([{ kind: "owner", id: corpID }]); }
    void flow.ownCorporationColors().then((c) => { colors = c; }, (e) => { error = e instanceof Error ? e.message : String(e); });
  });
  const css = (rgb: readonly [number, number, number], alpha: number) => `rgba(${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255)).join(", ")}, ${alpha})`;
  // last_authored_datetime.strftime('%Y.%m.%d')
  const ymd = (d: Date) => `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
  type RGB = readonly [number, number, number];
  // EditColorsPanel: the colours being edited, from the palette as it was read.
  // LogoCard.on_edit_btn: EditCorpDetails.Open().
  let editingDetails = $state(false);
  // on_structure_skinr_details_button: show_structure_skinr_overlay_panel.
  let skinrDetails = $state(false);
  let editing = $state<{ primary: RGB; color2: RGB | null; color3: RGB | null } | null>(null), updating = $state(false);
  const same = (a: RGB | null, b: RGB | null) => (a === null || b === null ? a === b : a.every((c, i) => Math.round(c * 255) === Math.round(b[i]! * 255)));
  function openEdit(): void { if (colors) editing = { primary: colors.primary, color2: colors.color2, color3: colors.color3 }; }
  // enforce_card_visibility_and_restrictions: a Color 3 with no Color 2 becomes Color 2.
  function setSlot(slot: "primary" | "color2" | "color3", rgb: RGB | null): void {
    if (!editing) return;
    let next = { ...editing, [slot]: rgb } as { primary: RGB; color2: RGB | null; color3: RGB | null };
    if (next.color3 && !next.color2) next = { ...next, color2: next.color3, color3: null };
    editing = next;
  }
  function randomize(): void {
    // on_randomize_button: a primary; a second three times in four; a third half the time there is a second.
    const r = (): RGB => [Math.random(), Math.random(), Math.random()];
    const color2 = Math.random() > 0.25 ? r() : null;
    editing = { primary: r(), color2, color3: color2 && Math.random() > 0.5 ? r() : null };
  }
  async function update(): Promise<boolean> {
    if (!editing) return false;
    updating = true;
    try {
      const status = await flow.setOwnCorporationColors(editing.primary, editing.color2, editing.color3);
      if (status === 403) error = plainText(text(B + "UnableToSetCorpColorsRoleMissing"));
      else if (status !== 200) error = plainText(text("UI/Common/CannotConnectToServer"));
    } catch { error = plainText(text("UI/Common/CannotConnectToServer")); } finally { updating = false; }
    editing = null;
    try { colors = await flow.ownCorporationColors(); } catch { /* the card keeps what it had */ }
    return true;
  }
  // is_allowed_to_close: changed colours ask PromptSaveCorpColorChanges; Yes updates. Either way it closes.
  async function leave(): Promise<void> {
    if (!editing || !colors) { editing = null; return; }
    const changed = !same(editing.primary, colors.primary) || !same(editing.color2, colors.color2) || !same(editing.color3, colors.color3);
    if (changed && await flow.askClientDialog("PromptSaveCorpColorChanges", "Do you want to save the changes to your corporation's colours?")) { await update(); return; }
    editing = null;
  }
  // ColorHexInputField: "#RRGGBB" (upper case), "#" for none.
  const hexOf = (rgb: RGB | null) => (rgb ? "#" + rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase() : "#");
  const fromHex = (value: string): RGB | null => { const m = /^#?([0-9a-f]{6})$/i.exec(value.trim()); return m ? [parseInt(m[1]!.slice(0, 2), 16) / 255, parseInt(m[1]!.slice(2, 4), 16) / 255, parseInt(m[1]!.slice(4, 6), 16) / 255] : null; };
  const BANNER = "res:/UI/Texture/classes/corp/colors/";
  const palette = $derived(colors ? [colors.primary, colors.color2, colors.color3].filter((c): c is readonly [number, number, number] => c !== null) : []);
</script>

{#snippet card(title: string, icon: string)}
  <div class="bm-top"><span class="bm-icon">{icon}</span><span>{plainText(text(title))}</span></div>
{/snippet}

{#snippet editCard(slot: "primary" | "color2" | "color3", caption: string, optional: boolean)}
  {@const rgb = editing ? editing[slot] : null}
  <div class="bm-edit-card">
    <div class="bm-edit-top"><span>{plainText(text(caption))}</span>
      {#if rgb && optional}<button class="bm-icon-btn" title={plainText(text("UI/Commands/Remove"))} onclick={() => setSlot(slot, null)}>🗑</button>{/if}</div>
    <label class="bm-edit-content">
      {#if rgb}
        <div class="bm-picker">
          <div class="bm-swatch bm-full" style:background={css(rgb, 1)}><span>100%</span></div>
          <div class="bm-lower"><div class="bm-swatch" style:background={css(rgb, 0.6)}><span>60%</span></div><div class="bm-swatch" style:background={css(rgb, 0.2)}><span>20%</span></div></div>
        </div>
      {:else}
        <div class="bm-add"><span>+</span><span class="bm-add-label">{plainText(text(B + "AddColor"))}</span></div>
      {/if}
      <!-- OnClick: the colour picker, from the colour or white. -->
      <input class="bm-color-input" type="color" value={hexOf(rgb ?? [1, 1, 1]).toLowerCase()} oninput={(e) => setSlot(slot, fromHex(e.currentTarget.value))} />
    </label>
    <input class="bm-hex" value={hexOf(rgb)} onchange={(e) => { const c = fromHex(e.currentTarget.value); if (c) setSlot(slot, c); else e.currentTarget.value = hexOf(rgb); }} />
  </div>
{/snippet}

{#if editingDetails}
  <div class="bm-details"><CorporationCreate {store} {flow} edit onClose={() => { editingDetails = false; if (corpID) flow.requestCorpLogos([corpID]); }} /></div>
{/if}
{#if editing}
  {@const e = editing}
  {@const n = e.color2 ? (e.color3 ? 3 : 2) : 1}
  <div class="bm-overlay">
    <div class="bm-overlay-head"><button class="bm-icon-btn" onclick={() => void leave()}>←</button><span>◐ {plainText(text(B + "ColorPalette"))}</span></div>
    <div class="bm-overlay-body">
      <div class="bm-edit-main">
        <div class="bm-edit-header"><span>{plainText(text(B + "ColorSet"))}</span><button class="bm-icon-btn" title={plainText(text("UI/CharacterCreation/Randomize"))} onclick={randomize}>🎲</button></div>
        <div class="bm-edit-cards">
          {@render editCard("primary", B + "PrimaryColor", false)}
          {@render editCard("color2", B + "Color2", true)}
          {#if e.color2}{@render editCard("color3", B + "Color3", true)}{/if}
        </div>
      </div>
      <div class="bm-preview">
        <span>{plainText(text(B + "Preview"))}</span>
        <div class="bm-preview-frame">
          <div class="bm-preview-logo">{#if $corpLogoLibrary && $corpLogos[String(corpID)]}<CorpLogo library={$corpLogoLibrary} logo={$corpLogos[String(corpID)]!} name={nameOf("owner", corpID)} />{/if}</div>
          <div class="bm-banner">
            <div class="bm-banner-bg" style:background={css(e.primary, 0.2)} style={`-webkit-mask-box-image: url("${clientTexture(BANNER + "banner_bg_large.png")}") 60 fill / 60px;`}></div>
            {#each (n === 1 ? [e.primary] : [e.primary, e.color2, e.color3].slice(0, n)) as c, i (i)}
              {@const tex = n === 1 ? BANNER + "banner_stripe_thick_large.png" : BANNER + `banner_stripe_thin_large_${i + (n === 3 ? 1 : 2)}.png`}
              <div class="bm-stripe" style:background={css(c!, 1)} style={`mask-image: url("${clientTexture(tex)}"); -webkit-mask-image: url("${clientTexture(tex)}");`}></div>
            {/each}
          </div>
        </div>
      </div>
    </div>
    <div class="bm-overlay-buttons"><button disabled={updating} onclick={() => void update()}>{plainText(text("UI/Common/Update"))}</button><button onclick={() => void leave()}>{plainText(text("UI/Common/Cancel"))}</button></div>
  </div>
{:else if skinrDetails}
  <CorporationStructureDesign {store} {flow} {corpID} onBack={() => { skinrDetails = false; }} {openPaintTool} />
{:else}
<div class="bm">
  {#if error}<p class="error">{error}</p>{/if}
  <div class="bm-card">
    {@render card("UI/Corporations/CorporationWindow/Alliances/Members/Logo", "★")}
    <div class="bm-main bm-logo">
      <span class="bm-logo-img">{#if $corpLogoLibrary && $corpLogos[String(corpID)]}<CorpLogo library={$corpLogoLibrary} logo={$corpLogos[String(corpID)]!} name={nameOf("owner", corpID)} />{/if}</span>
      <span class="bm-headline">{nameOf("owner", corpID)}</span>
    </div>
    <div class="bm-bottom"><button disabled={!brandManager} onclick={() => { editingDetails = true; }} title={brandManager ? "" : plainText(text("UI/Corporations/CorporationWindow/AccessibleWithRole", { role_name: "Brand Manager" }))}>✎ {plainText(text(B + "EditLogo"))}</button></div>
  </div>
  <div class="bm-card">
    {@render card(B + "ColorPalette", "◐")}
    <div class="bm-main bm-colors" style:grid-template-columns={`repeat(${Math.max(1, palette.length)}, 1fr)`}>
      {#each palette as rgb, i (i)}
        <!-- ColorPickerCont: the colour at 100% over half its height, then 60% and 20% side by side. -->
        <div class="bm-picker">
          <div class="bm-swatch bm-full" style:background={css(rgb, 1)}><span>100%</span></div>
          <div class="bm-lower">
            <div class="bm-swatch" style:background={css(rgb, 0.6)}><span>60%</span></div>
            <div class="bm-swatch" style:background={css(rgb, 0.2)}><span>20%</span></div>
          </div>
        </div>
      {/each}
    </div>
    <div class="bm-bottom bm-between">
      <span class="bm-detail">
        {#if colors?.lastAuthoredBy}<LabelText markup={text(B + "DesignedBy", { owner_link: `<url=showinfo:1377//${colors.lastAuthoredBy}>${nameOf("owner", colors.lastAuthoredBy)}</url>` })} {followerOf} />{/if}
        {#if colors?.lastAuthored}<span>{ymd(colors.lastAuthored)}</span>{/if}
      </span>
      <button onclick={openEdit} disabled={!colors}>✎ {plainText(text(B + "EditColors"))}</button>
    </div>
  </div>
  <div class="bm-card">
    {@render card("UI/Personalization/PaintTool/TrySKINRTitle", "✦")}
    <div class="bm-main bm-skinr">
      <span class="bm-skinr-icon">🖌</span>
      <span class="bm-skinr-text"><span class="bm-headline">{plainText(text("UI/Personalization/PaintTool/TrySKINRTitle"))}</span><span class="bm-body">{plainText(text(B + "StructureSKINRDescription"))}</span></span>
    </div>
    <div class="bm-bottom"><button onclick={() => { skinrDetails = true; }}>{plainText(text("UI/Common/Details"))}</button><button onclick={() => openPaintTool?.()}>{plainText(text("UI/Personalization/PaintTool/OpenSKINR"))}</button></div>
  </div>
</div>
{/if}

<style>
  .bm { display: flex; flex-wrap: wrap; gap: 16px; padding: 8px; overflow: auto; height: 100%; align-content: flex-start; }
  .bm-card { flex: 1 1 320px; max-width: 700px; height: 196px; display: flex; flex-direction: column; padding: 16px; box-sizing: border-box; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); }
  .bm-top { height: 16px; display: flex; gap: 4px; align-items: center; font-size: 11px; opacity: 0.65; }
  .bm-icon { width: 16px; text-align: center; }
  .bm-main { flex: 1; min-height: 0; overflow: hidden; display: flex; align-items: center; }
  .bm-logo { gap: 16px; }
  .bm-logo-img { width: 96px; height: 96px; display: inline-flex; }
  .bm-logo-img :global(.corp-logo) { width: 96px; height: 96px; }
  .bm-headline { font-size: 18px; }
  .bm-bottom { height: 32px; display: flex; justify-content: flex-end; align-items: flex-end; gap: 6px; }
  .bm-between { justify-content: space-between; }
  .bm-detail { display: flex; flex-direction: column; gap: 2px; font-size: 11px; opacity: 0.65; }
  .bm-colors { display: grid; padding: 16px 0; align-items: stretch; }
  .bm-picker { display: flex; flex-direction: column; height: 100%; }
  .bm-full { flex: 1; }
  .bm-lower { flex: 1; display: flex; }
  .bm-lower .bm-swatch { flex: 1; }
  .bm-swatch { position: relative; }
  .bm-swatch span { position: absolute; right: 8px; bottom: 8px; font-size: 11px; }
  .bm-skinr { gap: 18px; }
  .bm-skinr-icon { font-size: 48px; width: 64px; text-align: center; }
  .bm-skinr-text { display: flex; flex-direction: column; gap: 4px; }
  .bm-body { opacity: 0.65; }
  .bm-details { position: absolute; inset: 0; z-index: 6; }
  .bm-overlay { display: flex; flex-direction: column; height: 100%; padding: 0 8px 8px; box-sizing: border-box; }
  .bm-overlay-head { display: flex; gap: 8px; align-items: center; padding: 6px 0; font-weight: bold; }
  .bm-overlay-body { flex: 1; min-height: 0; display: flex; gap: 32px; overflow: auto; background: rgba(255, 255, 255, 0.03); padding: 16px 8px 0; }
  .bm-edit-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  .bm-edit-header { display: flex; justify-content: space-between; }
  .bm-edit-cards { display: flex; flex-wrap: wrap; gap: 16px; }
  .bm-edit-card { flex: 1 1 200px; max-width: 500px; height: 196px; display: flex; flex-direction: column; padding: 16px 8px 8px; box-sizing: border-box; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); }
  .bm-edit-top { height: 16px; display: flex; justify-content: space-between; font-size: 11px; opacity: 0.8; margin-bottom: 16px; }
  .bm-edit-content { flex: 1; min-height: 0; position: relative; cursor: pointer; display: flex; }
  .bm-edit-content .bm-picker { flex: 1; }
  .bm-color-input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%; }
  .bm-add { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
  .bm-add-label { font-size: 11px; opacity: 0; }
  .bm-edit-content:hover .bm-add-label { opacity: 0.65; }
  .bm-hex { margin-top: 8px; width: 160px; }
  .bm-icon-btn { all: unset; cursor: pointer; padding: 0 4px; }
  .bm-preview { width: 300px; display: flex; flex-direction: column; gap: 16px; }
  .bm-preview-frame { position: relative; height: 450px; border: 1px solid rgba(255, 255, 255, 0.1); display: flex; align-items: center; justify-content: center; }
  .bm-preview-logo { position: absolute; top: 50%; left: 50%; width: 132px; height: 132px; transform: translate(-50%, -138px); z-index: 1; }
  .bm-preview-logo :global(.corp-logo) { width: 132px; height: 132px; }
  .bm-banner { position: relative; width: 176px; height: 384px; margin-top: 8px; overflow: hidden; }
  .bm-banner-bg { position: absolute; inset: 0; }
  .bm-stripe { position: absolute; right: 0; bottom: 0; width: 128px; height: 128px; mask-size: 100% 100%; -webkit-mask-size: 100% 100%; }
  .bm-overlay-buttons { display: flex; justify-content: flex-end; gap: 6px; padding: 16px 0; }
</style>
