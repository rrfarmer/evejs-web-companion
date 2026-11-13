<script lang="ts">
  // corporation/corp_ui_structure_design.py CorpStructureDesignPanel - Brand Management's Structure SKINR card,
  // Details, in the brand panel's overlay (PanelOverlayCont: Back, the colour icon, ColorPalette - the overlay is made
  // once with that label). The top row (64 high): the corporation's logo, CorpNamePlaceholder, an info icon; then a
  // LicenseLoadingContainer 40 below: _fetch_data - structureDirectory.GetCorporationStructures and the corporation's
  // licences (GetAllOwnedByCorporationRequest), a structure without one left out. A failure: the SKINR header
  // (skinr_banner.png, TrySKINRTitle, TrySKINRDescription, Open SKINR) over GetAllLicensesLoadingErrorTitle (upper case,
  // orange), its description and Retry. No structure: CorpStructureDesignNoLicensesPanel - skinr.png scaled to the
  // height, and at the bottom on black at 70% the caption, the description and Open SKINR. Else
  // CorpStructureDesignHaveLicensesPanel: the SKINR header, YourLicenses, the filters (LicenseListFilters: the structure
  // type combo - StructureTypeFilterShowAll and PAINT_ELIGIBLE_STRUCTURE_TYPE_IDS' names; the text filter on the name;
  // reload, ReloadLicenses) and one LicenseScrollEntry per structure (64 high, gunmetal: the name; the days left -
  // LicenseDurationHint, LowPowerHaveLicense or AbandonedHaveLicense - in warning colour with the low-power icon under
  // 7 days or at low power / abandoned, the LowPowerLicenseRowHint hint for those two; the trash button,
  // RevokeLicenseHint) or NoStructuresFound. Revoke: ConfirmRevokeWnd (CancelLicenseTitle, CancelLicenseBody, Revoke
  // License / Cancel; RevokeRequestErrorDescription when it fails), the row then dropped (all gone: the no-licences
  // panel). The filters outlive a reload.
  // Not here: Open SKINR (the paint tool window).
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import { PAINT_ELIGIBLE_STRUCTURE_TYPE_IDS, type AppFlow, type CorporationStructureLicense } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import CorpLogo from "./CorpLogo.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, corpID, onBack, openPaintTool }: { store: ClientStore; flow: AppFlow; corpID: number; onBack: () => void; openPaintTool?: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const corpLogos = flow.corpLogos;
  // svelte-ignore state_referenced_locally
  const corpLogoLibrary = flow.corpLogoLibrary;
  const P = "UI/Personalization/PaintTool/";
  const LABELS = ["UI/Commands/Back", "UI/Corporations/BaseCorporationUI/ColorPalette", "UI/Corporations/CorpUIHome/CorpNamePlaceholder", P + "OpenSKINR", P + "TrySKINRTitle",
    P + "TrySKINRDescription", P + "GetAllLicensesLoadingErrorTitle", P + "GetAllLicensesLoadingErrorDescription", P + "ErrorRetry", P + "YourLicenses",
    P + "StructureTypeFilterShowAll", P + "StructureTypeFilterNoSelection", P + "ReloadLicenses", P + "RevokeLicenseHint", P + "StructureStates/LowPowerLicenseRowHint",
    P + "StructureStates/LowPowerHaveLicense", P + "StructureStates/AbandonedHaveLicense", P + "StructureStates/LicenseDurationHint", P + "CancelLicenseTitle",
    P + "CancelLicenseBody", P + "RevokeLicense", P + "RevokeRequestErrorDescription", "UI/Common/Buttons/Cancel", "UI/Structures/Browser/NoStructuresFound", ...Object.keys(LINK_WORDS)];
  const nameOf = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const text = (label: string, args: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", args as never, { nameOf });
  const followerOf = (url: string, t: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), t);

  let rows = $state<CorporationStructureLicense[] | null>(null), loading = $state(true), failed = $state(false);
  let typeFilter = $state<number | null>(null), textFilter = $state("");
  let revoking = $state<CorporationStructureLicense | null>(null), revokeBusy = $state(false), revokeError = $state("");
  async function load(): Promise<void> {
    loading = true; failed = false;
    try { rows = [...await flow.corporationStructureLicenses()]; } catch { failed = true; } finally { loading = false; }
  }
  onMount(() => {
    flow.requestWords(LABELS);
    if (corpID) { flow.requestCorpLogos([corpID]); flow.requestNames([{ kind: "owner", id: corpID }]); }
    void load();
  });
  // _populate_list: the type combo, then the text in the name (lower case).
  const shown = $derived((rows ?? []).filter((r) => (typeFilter === null || r.typeID === typeFilter) && (!textFilter || r.name.toLowerCase().includes(textFilter.toLowerCase()))));
  // LicenseScrollEntry._load_duration_container.
  const days = (r: CorporationStructureLicense) => Math.trunc(Math.max(0, r.remainingSeconds) / 86400);
  const lowPower = (r: CorporationStructureLicense) => r.upkeepState === 2, abandoned = (r: CorporationStructureLicense) => r.upkeepState === 3;
  const durationText = (r: CorporationStructureLicense) => plainText(text(P + (lowPower(r) ? "StructureStates/LowPowerHaveLicense" : abandoned(r) ? "StructureStates/AbandonedHaveLicense" : "StructureStates/LicenseDurationHint"), { numDays: days(r) }));
  const warning = (r: CorporationStructureLicense) => days(r) < 7 || lowPower(r) || abandoned(r);
  async function revoke(): Promise<void> {
    const r = revoking;
    if (!r || revokeBusy) return;
    revokeBusy = true; revokeError = "";
    try {
      await flow.revokeStructureLicense(r.licenseID);
      // on_license_revoked: the row dropped.
      rows = (rows ?? []).filter((x) => x.structureID !== r.structureID);
      revoking = null;
    } catch { revokeError = plainText(text(P + "RevokeRequestErrorDescription")); } finally { revokeBusy = false; }
  }
</script>

{#snippet skinrHeader()}
  <div class="sd-header" style:background-image={`url("${clientTexture("res:/UI/Texture/classes/StructureDesign/background/skinr_banner.png")}")`}>
    <div class="sd-header-text"><span class="sd-caption-large">{plainText(text(P + "TrySKINRTitle"))}</span><span>{plainText(text(P + "TrySKINRDescription"))}</span></div>
    <button class="sd-primary" onclick={() => openPaintTool?.()}>🖌 {plainText(text(P + "OpenSKINR"))}</button>
  </div>
{/snippet}

<div class="sd">
  <div class="sd-overlay-head"><button class="sd-ghost" onclick={onBack}>{plainText(text("UI/Commands/Back")) || "Back"}</button><span class="sd-secondary">◐ {plainText(text("UI/Corporations/BaseCorporationUI/ColorPalette"))}</span></div>
  <div class="sd-content">
    <div class="sd-top">
      <span class="sd-logo">{#if $corpLogoLibrary && $corpLogos[String(corpID)]}<CorpLogo library={$corpLogoLibrary} logo={$corpLogos[String(corpID)]!} name={nameOf("owner", corpID)} />{/if}</span>
      <span class="sd-caption">{plainText(text("UI/Corporations/CorpUIHome/CorpNamePlaceholder", { corpName: nameOf("owner", corpID) }))}</span>
      <LabelText markup={`<url=showinfo:2//${corpID}>ⓘ</url>`} {followerOf} />
    </div>
    <div class="sd-main" aria-busy={loading}>
      {#if loading}
        <div class="sd-loading">…</div>
      {:else if failed}
        {@render skinrHeader()}
        <div class="sd-failure">
          <span class="sd-error">{plainText(text(P + "GetAllLicensesLoadingErrorTitle")).toUpperCase()}</span>
          <span class="sd-large">{plainText(text(P + "GetAllLicensesLoadingErrorDescription"))}</span>
          <button class="sd-ghost" onclick={() => void load()}>⟳ {plainText(text(P + "ErrorRetry"))}</button>
        </div>
      {:else if (rows ?? []).length === 0}
        <div class="sd-none" style:background-image={`url("${clientTexture("res:/UI/Texture/classes/StructureDesign/background/skinr.png")}")`}>
          <div class="sd-none-content">
            <span class="sd-caption-large">{plainText(text(P + "TrySKINRTitle"))}</span>
            <span>{plainText(text(P + "TrySKINRDescription"))}</span>
            <button class="sd-primary" onclick={() => openPaintTool?.()}>🖌 {plainText(text(P + "OpenSKINR"))}</button>
          </div>
        </div>
      {:else}
        <div class="sd-with">
          {@render skinrHeader()}
          <div class="sd-list">
            <span class="sd-caption">{plainText(text(P + "YourLicenses"))}</span>
            <div class="sd-filters">
              <select value={typeFilter === null ? "" : String(typeFilter)} onchange={(e) => { const v = e.currentTarget.value; typeFilter = v ? Number(v) : null; }}>
                <option value="">{plainText(text(P + "StructureTypeFilterShowAll"))}</option>
                {#each PAINT_ELIGIBLE_STRUCTURE_TYPE_IDS as id (id)}<option value={String(id)}>{nameOf("type", id) || String(id)}</option>{/each}
              </select>
              <input class="sd-text-filter" type="search" bind:value={textFilter} />
              <button class="sd-icon" title={plainText(text(P + "ReloadLicenses"))} onclick={() => void load()}>⟳</button>
            </div>
            <div class="sd-scroll">
              {#each shown as r (r.structureID)}
                <div class="sd-entry">
                  <div class="sd-entry-text">
                    <span class="sd-entry-name">{r.name}</span>
                    <span class="sd-duration" class:sd-warning={warning(r)} title={lowPower(r) || abandoned(r) ? plainText(text(P + "StructureStates/LowPowerLicenseRowHint")) : ""}>
                      {#if warning(r)}<img src={clientTexture("res:/UI/Texture/classes/paintTool/low_power.png")} alt="" />{/if}{durationText(r)}</span>
                  </div>
                  <button class="sd-icon sd-trash" title={plainText(text(P + "RevokeLicenseHint"))} onclick={() => { revoking = r; revokeError = ""; }}>🗑</button>
                </div>
              {:else}
                <p class="sd-hint">{plainText(text("UI/Structures/Browser/NoStructuresFound"))}</p>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
  {#if revoking}
    {@const r = revoking}
    <div class="sd-modal-back">
      <div class="sd-modal" role="dialog" aria-label={plainText(text(P + "CancelLicenseTitle"))}>
        <header><img src={clientTexture("res:/UI/Texture/classes/paintTool/low_power.png")} alt="" /><span>{plainText(text(P + "CancelLicenseTitle"))}</span></header>
        <div class="sd-modal-body">
          {#if revokeError}<p>{revokeError}</p>{:else if revokeBusy}<p class="sd-loading">…</p>{:else}<p class="sd-large">{plainText(text(P + "CancelLicenseBody", { structureName: r.name, numDays: days(r) }))}</p>{/if}
        </div>
        <footer>
          <button disabled={revokeBusy} onclick={() => void revoke()}>{plainText(text(P + "RevokeLicense"))}</button>
          <button disabled={revokeBusy} onclick={() => { revoking = null; }}>{plainText(text("UI/Common/Buttons/Cancel"))}</button>
        </footer>
      </div>
    </div>
  {/if}
</div>

<style>
  .sd { position: relative; display: flex; flex-direction: column; height: 100%; padding: 0 8px 8px; box-sizing: border-box; }
  .sd-overlay-head { display: flex; gap: 8px; align-items: center; padding-top: 8px; min-height: 32px; }
  .sd-secondary { opacity: 0.65; font-size: 11px; }
  .sd-ghost { background: none; border: 1px solid rgba(255, 255, 255, 0.2); }
  .sd-content { flex: 1; min-height: 0; display: flex; flex-direction: column; padding-top: 16px; }
  .sd-top { height: 64px; display: flex; align-items: center; gap: 8px; }
  .sd-logo { width: 64px; height: 64px; display: inline-flex; }
  .sd-logo :global(.corp-logo) { width: 64px; height: 64px; }
  .sd-caption { font-size: 16px; }
  .sd-caption-large { font-size: 22px; }
  .sd-large { font-size: 14px; }
  .sd-main { flex: 1; min-height: 0; margin-top: 40px; display: flex; flex-direction: column; overflow: hidden; }
  .sd-loading { margin: auto; opacity: 0.65; }
  .sd-header { position: relative; height: 200px; flex: none; overflow: hidden; background-size: max(100%, 1600px) auto; background-position: center; background-repeat: no-repeat; }
  .sd-header-text { display: flex; flex-direction: column; gap: 10px; padding: 20px 20px 0; max-width: 60%; }
  .sd-header .sd-primary { position: absolute; right: 20px; bottom: 20px; }
  .sd-primary { background: rgba(88, 166, 220, 0.35); border: 1px solid rgba(88, 166, 220, 0.8); }
  .sd-failure { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; }
  .sd-error { color: #f39058; }
  .sd-none { flex: 1; position: relative; display: flex; flex-direction: column; justify-content: flex-end; background-size: auto 100%; background-position: center; background-repeat: no-repeat; overflow: hidden; }
  .sd-none-content { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 50px 0; background: rgba(0, 0, 0, 0.7); text-align: center; }
  .sd-none-content span:nth-child(2) { margin-bottom: 30px; }
  .sd-with { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .sd-list { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 20px 16px 0; }
  .sd-filters { height: 32px; margin-top: 20px; display: flex; gap: 20px; align-items: center; }
  .sd-text-filter { flex: 1; }
  .sd-icon { all: unset; cursor: pointer; width: 30px; text-align: center; }
  .sd-scroll { flex: 1; min-height: 0; overflow: auto; margin-top: 20px; }
  .sd-entry { height: 64px; display: flex; align-items: stretch; margin-bottom: 8px; background: #3b3f45; }
  .sd-entry-text { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 8px 0 0 16px; gap: 2px; }
  .sd-entry-name { font-size: 14px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sd-duration { display: flex; align-items: center; gap: 6px; opacity: 0.65; }
  .sd-duration img { width: 16px; height: 16px; object-fit: cover; }
  .sd-warning { color: #f39058; opacity: 1; }
  .sd-trash { width: 32px; margin-right: 4px; }
  .sd-hint { text-align: center; opacity: 0.65; }
  .sd-modal-back { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); z-index: 5; }
  .sd-modal { width: 420px; min-height: 280px; display: flex; flex-direction: column; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .sd-modal header { display: flex; gap: 8px; align-items: center; padding: 8px; font-weight: bold; }
  .sd-modal header img { width: 24px; height: 24px; }
  .sd-modal-body { flex: 1; padding: 20px 16px; border-bottom: 1px solid rgba(255, 255, 255, 0.15); margin-bottom: 20px; }
  .sd-modal footer { display: flex; justify-content: flex-end; gap: 6px; padding: 0 8px 8px; }
</style>
