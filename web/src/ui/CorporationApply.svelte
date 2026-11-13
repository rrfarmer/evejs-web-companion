<script lang="ts">
  // corporation/corp_ui_applications.py ApplyToCorpWnd (500 x 450, modal, OK / Cancel): the corporation's logo 64 and
  // ApplyForMembership ("Apply for membership in {corporation}", EveLabelLarge); CorporationApplicationText over the
  // application text (EditPlainText, 1000); at the bottom (TOBOTTOM, so from the top down) the war permit
  // (WarPermitWithStatus), the friendly fire (FriendlyFireStatus), the ISK and LP tax rates (CurrentISKTaxRateForCorporation,
  // CurrentLPTaxRateForCorporation), and lowest - idx 0 - RecruitmentMayBeClosed where the corporation is not recruiting. OK: Confirm - the text over
  // crpApplicationMaxSize said, else InsertApplication. (A box over the page here; the More Info icons' hints as titles.)
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, MembershipApplicationStart } from "../app/flow.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { friendlyFireAt, friendlyFireLabel, warPermitLabel } from "../bridge/ownerInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  type Form = Extract<MembershipApplicationStart, { kind: "form" }>;
  let { store, flow, corporationID, form, onClose }: { store: ClientStore; flow: AppFlow; corporationID: number; form: Form; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const corpLogos = flow.corpLogos;
  // svelte-ignore state_referenced_locally
  const corpLogoLibrary = flow.corpLogoLibrary;
  // svelte-ignore state_referenced_locally
  const ownerLogos = flow.ownerLogos;
  const B = "UI/Corporations/BaseCorporationUI/";
  // svelte-ignore state_referenced_locally
  const LABELS = [B + "JoinCorporation", B + "ApplyForMembership", B + "CorporationApplicationText", B + "RecruitmentMayBeClosed", B + "CurrentISKTaxRateForCorporation",
    B + "CurrentLPTaxRateForCorporation", B + "ISKTaxRateDescription", B + "LPTaxRateDescription", "UI/Corporations/FriendlyFire/FriendlyFireStatus",
    "UI/Corporations/FriendlyFire/Description", "UI/WarPermit/WarPermitWithStatus", "UI/WarPermit/WarPermitExplanation", warPermitLabel(form.allowWar),
    "UI/Corporations/FriendlyFire/Legal", "UI/Corporations/FriendlyFire/Illegal", "UI/Corporations/FriendlyFire/LegalWithChangeTime",
    "UI/Corporations/FriendlyFire/LegalWithChangeTimeTomorrow", "UI/Corporations/FriendlyFire/IllegalWithChangeTime",
    "UI/Corporations/FriendlyFire/IllegalWithChangeTimeTomorrow", DATE_LABELS.ns!, DATE_LABELS.xn!, "UI/Common/Buttons/OK", "UI/Common/Buttons/Cancel"];
  const fill = (label: string, fallback: string, values: Record<string, unknown> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? fallback, values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  const corpName = $derived(resolvedName($names.resolved, "owner", corporationID, ""));
  const playerLogo = $derived(corporationID >= 1_000_000 && corporationID < 2_000_000 ? null : ($corpLogos[String(corporationID)] ?? null));
  const npcLogo = $derived($ownerLogos?.corporations[String(corporationID)] ?? null);
  const friendlyFire = $derived.by(() => {
    const { settings, readAt } = form.aggression;
    if (!settings) return "";
    const { legal, changeAt } = friendlyFireAt(settings, readAt);
    const date = (t: bigint, f: "ns" | "xn") => fill(DATE_LABELS[f]!, "", { datetime: { type: "long", value: t.toString() } });
    const tomorrow = changeAt !== null && date(changeAt, "xn") !== date(readAt, "xn");
    return fill(friendlyFireLabel(legal, changeAt, tomorrow), legal ? "Allowed" : "Not allowed", changeAt === null ? {} : { time: date(changeAt, "ns") });
  });
  let text = $state(""), sending = $state(false);
  onMount(() => { flow.requestWords(LABELS); flow.requestCorpLogos([corporationID]); flow.loadOwnerLogos(); });
  async function confirm(): Promise<void> {
    if (sending) return;
    sending = true;
    try { if (await flow.insertCorporationApplication(corporationID, text)) onClose(); } finally { sending = false; }
  }
</script>

<div class="apply-back">
  <div class="apply" role="dialog" aria-modal="true" aria-label={fill(B + "JoinCorporation", "Join Corporation")} aria-busy={sending}>
    <header>{fill(B + "JoinCorporation", "Join Corporation")}<button type="button" class="x" aria-label="Close" onclick={onClose}>×</button></header>
    <div class="apply-corp">
      <span class="apply-logo">
        {#if playerLogo && $corpLogoLibrary && playerLogo.shapes.some((s) => s !== null)}<CorpLogo library={$corpLogoLibrary} logo={playerLogo} name={corpName} />
        {:else}<OwnerPicture name={corpName} urls={npcLogo ? [clientTexture(npcLogo)] : []} size={64} />{/if}
      </span>
      <span class="apply-title">{fill(B + "ApplyForMembership", "Apply for membership in {corporation}", { corporation: corpName })}</span>
    </div>
    <div class="apply-body">
      <span class="small">{fill(B + "CorporationApplicationText", "Application text")}</span>
      <textarea bind:value={text} maxlength="1000"></textarea>
      <span class="small" title={fill("UI/WarPermit/WarPermitExplanation", "")}>{fill("UI/WarPermit/WarPermitWithStatus", "War permit: {warPermitStatus}", { warPermitStatus: fill(warPermitLabel(form.allowWar), "") })}</span>
      <span class="small" title={fill("UI/Corporations/FriendlyFire/Description", "")}>{fill("UI/Corporations/FriendlyFire/FriendlyFireStatus", "Friendly fire: {ffStatus}", { ffStatus: friendlyFire })}</span>
      <span class="small" title={fill(B + "ISKTaxRateDescription", "", { min_isk_amount: "100,000.00 ISK" })}>{fill(B + "CurrentISKTaxRateForCorporation", "{corporation} ISK tax rate: {taxRate}%", { corporation: corpName, taxRate: form.taxRate * 100 })}</span>
      <span class="small" title={fill(B + "LPTaxRateDescription", "")}>{fill(B + "CurrentLPTaxRateForCorporation", "{corporation} LP tax rate: {taxRate}%", { corporation: corpName, taxRate: form.loyaltyPointTaxRate * 100 })}</span>
      {#if !form.isRecruiting}<span class="small">{fill(B + "RecruitmentMayBeClosed", "This corporation may not be recruiting.")}</span>{/if}
    </div>
    <div class="apply-buttons">
      <button type="button" disabled={sending} onclick={confirm}>{fill("UI/Common/Buttons/OK", "OK")}</button>
      <button type="button" onclick={onClose}>{fill("UI/Common/Buttons/Cancel", "Cancel")}</button>
    </div>
  </div>
</div>

<style>
  .apply-back { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.35); display: grid; place-items: center; }
  .apply { width: 500px; height: 450px; display: flex; flex-direction: column; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  header { display: flex; justify-content: space-between; padding: 4px 6px; font-weight: bold; }
  .x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .apply-corp { height: 68px; display: flex; gap: 4px; padding: 4px; }
  .apply-logo { width: 64px; height: 64px; display: grid; flex: none; }
  .apply-logo :global(.corp-logo) { width: 64px; height: 64px; }
  .apply-title { padding-top: 12px; font-size: 15px; width: 270px; }
  .apply-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 3px; padding: 0 8px 4px; }
  .apply-body textarea { flex: 1; min-height: 0; resize: none; margin-bottom: 4px; }
  .small { font-size: 11px; }
  .apply-buttons { display: flex; gap: 4px; justify-content: center; padding: 6px; }
</style>
