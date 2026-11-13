<script lang="ts">
  // corporation/brand_management/brandManagementPanel.py BrandManagementPanel (Administration > General > Brand
  // Management, a brand manager's) and brandManagementCards.py: cards (196 high, at most 700 wide, 16 apart) - the
  // Logo card (the corporation's logo, 96, and its name; Edit Logo, disabled with AccessibleWithRole for one without
  // Brand Manager), the Color Palette card where the corporation_palettes_enabled flag is on (default on: here) - one
  // ColorPickerCont per colour (each its colour at 100%, 60% and 20%), DesignedBy <owner link> and the date
  // (%Y.%m.%d), Edit Colors - and the Structure SKINR card (TrySKINRTitle, StructureSKINRDescription, Details, Open
  // SKINR). Not here yet: what Edit Logo, Edit Colors, Details and Open SKINR open.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import CorpLogo from "./CorpLogo.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
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
    B + "StructureSKINRDescription", "UI/Common/Details", "UI/Personalization/PaintTool/OpenSKINR", "UI/Corporations/CorporationWindow/AccessibleWithRole", ...Object.keys(LINK_WORDS)];
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
  const palette = $derived(colors ? [colors.primary, colors.color2, colors.color3].filter((c): c is readonly [number, number, number] => c !== null) : []);
</script>

{#snippet card(title: string, icon: string)}
  <div class="bm-top"><span class="bm-icon">{icon}</span><span>{plainText(text(title))}</span></div>
{/snippet}

<div class="bm">
  {#if error}<p class="error">{error}</p>{/if}
  <div class="bm-card">
    {@render card("UI/Corporations/CorporationWindow/Alliances/Members/Logo", "★")}
    <div class="bm-main bm-logo">
      <span class="bm-logo-img">{#if $corpLogoLibrary && $corpLogos[String(corpID)]}<CorpLogo library={$corpLogoLibrary} logo={$corpLogos[String(corpID)]!} name={nameOf("owner", corpID)} />{/if}</span>
      <span class="bm-headline">{nameOf("owner", corpID)}</span>
    </div>
    <div class="bm-bottom"><button disabled={!brandManager} title={brandManager ? "" : plainText(text("UI/Corporations/CorporationWindow/AccessibleWithRole", { role_name: "Brand Manager" }))}>✎ {plainText(text(B + "EditLogo"))}</button></div>
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
      <button>✎ {plainText(text(B + "EditColors"))}</button>
    </div>
  </div>
  <div class="bm-card">
    {@render card("UI/Personalization/PaintTool/TrySKINRTitle", "✦")}
    <div class="bm-main bm-skinr">
      <span class="bm-skinr-icon">🖌</span>
      <span class="bm-skinr-text"><span class="bm-headline">{plainText(text("UI/Personalization/PaintTool/TrySKINRTitle"))}</span><span class="bm-body">{plainText(text(B + "StructureSKINRDescription"))}</span></span>
    </div>
    <div class="bm-bottom"><button>{plainText(text("UI/Common/Details"))}</button><button>{plainText(text("UI/Personalization/PaintTool/OpenSKINR"))}</button></div>
  </div>
</div>

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
</style>
