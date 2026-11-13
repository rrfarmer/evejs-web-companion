<script lang="ts">
  // corporation/war/warWindows.py WarSurrenderWnd (BaseNegotiationWnd, 450 x 282; caption Surrender): the header - the
  // surrender icon 32, SurrenderOffer (EveCaptionSmall) with its MoreInfoSurrender icon, InWarAvsB (both links) -, the
  // requester's logo 32 with OffersSurrender {requesterName} and, for an offer received, OfferAmountInISK {amount}; the
  // reason (400, hint Reasonforoffer) over the ISK offered (hint OfferInISK). A request (Offer Surrender, the
  // requester the pilot's alliance or corporation): Submit / Cancel - CreateSurrenderNegotiation(warID, isk, message).
  // An offer: the reason read-only, no amount field; the offerer sees Close (and RetractAllyOffer, a base-class button
  // that acts on an ally offer), the other side Accept Offer / Decline Offer - AcceptSurrender / DeclineSurrender.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, WarNegotiation } from "../app/flow.ts";
  import type { CorpWar } from "../bridge/corpWars.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { NUMERIC_WORD_LABELS, iskWords } from "../bridge/questions.ts";
  import { resolvedName } from "../store/names.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow, war, negotiation = null, onClose }: { store: ClientStore; flow: AppFlow; war: CorpWar; negotiation?: WarNegotiation | null; onClose: (done: boolean) => void } = $props();
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
  // svelte-ignore state_referenced_locally
  const ownerLogos = flow.ownerLogos;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  const W = "UI/Corporations/Wars/";
  const LABELS = ["Surrender", "SurrenderOffer", "MoreInfoSurrender", "InWarAvsB", "OffersSurrender", "OfferAmountInISK", "Reasonforoffer", "OfferInISK", "RetractAllyOffer",
    "AcceptOffer", "DeclineOffer"].map((k) => W + k).concat(["UI/Common/Buttons/Submit", "UI/Common/Buttons/Cancel", "UI/Common/Buttons/Close", ...Object.keys(LINK_WORDS), ...NUMERIC_WORD_LABELS]);
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, ""),
      // (OfferAmountInISK's {[numeric]amount.isk, decimalPlaces=0}: FmtISK)
      writeIsk: (amount, places) => iskWords(amount, places, $words.templates, (kind, id) => resolvedName($names.resolved, kind, id, "")) });
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  const isAlliance = (id: number) => id >= 99_000_000 && id < 100_000_000;
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || resolvedName($names.resolved, isAlliance(id) ? "alliance" : "corporation", id, String(id));
  const link = (id: number) => `<url=showinfo:${isAlliance(id) ? 16159 : 2}//${id}>${nameOf(id)}</url>`;
  const me = $derived($station.online?.allianceID ?? $station.online?.corporationID ?? 0);
  // a request's requester is the pilot's own; an offer's, its ownerID1
  const requesterID = $derived(negotiation ? negotiation.ownerID1 : me);
  // svelte-ignore state_referenced_locally
  let message = $state(negotiation?.description ?? ""), isk = $state(0), busy = $state(false);
  onMount(() => { flow.requestWords(LABELS); flow.loadOwnerLogos(); flow.loadImageServer(); if (!isAlliance(requesterID)) flow.requestCorpLogos([requesterID]); });
  async function act(kind: "offer" | "accept" | "decline"): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      // SubmitRequest / AcceptOffer / DeclineOffer: the window closes whatever the call answered (try ... finally)
      const ok = kind === "offer" ? await flow.surrenderAct({ kind, warID: war.warID, isk: Math.max(0, Math.trunc(isk)), message })
        : await flow.surrenderAct({ kind, warNegotiationID: negotiation!.warNegotiationID });
      onClose(ok);
    } catch { onClose(false); } finally { busy = false; }
  }
  const logo = $derived.by(() => {
    const id = requesterID;
    const l = isAlliance(id) ? null : $corpLogos[String(id)] ?? null;
    if (l && l.shapes.some((s) => s !== null)) return { kind: "corp" as const, l };
    const url = isAlliance(id) ? allianceLogoUrl($imageServer, id) : (() => { const t = $ownerLogos?.corporations[String(id)]; return t ? clientTexture(t) : null; })();
    return { kind: "img" as const, url };
  });
</script>

<div class="ws-back">
  <div class="ws" role="dialog" aria-modal="true" aria-label={plainText(fill(W + "Surrender")) || "Surrender"}>
    <header>{plainText(fill(W + "Surrender")) || "Surrender"}<button type="button" class="ws-x" aria-label="Close" onclick={() => onClose(false)}>×</button></header>
    <div class="ws-head">
      <span class="ws-icon">🏳</span>
      <span><span class="ws-title">{plainText(fill(W + "SurrenderOffer"))} <span class="ws-more" title={plainText(fill(W + "MoreInfoSurrender"))}>ⓘ</span></span><br />
        <LabelText markup={fill(W + "InWarAvsB", { attackerName: link(war.declaredByID), defenderName: link(war.againstID) })} {followerOf} /></span>
    </div>
    <div class="ws-war">
      <span class="ws-logo">{#if logo.kind === "corp" && $corpLogoLibrary}<CorpLogo library={$corpLogoLibrary} logo={logo.l} name={nameOf(requesterID)} />{:else if logo.kind === "img"}<OwnerPicture name={nameOf(requesterID)} urls={logo.url ? [logo.url] : []} size={32} />{/if}</span>
      <span class:ws-request={!negotiation}>
        <LabelText markup={fill(W + "OffersSurrender", { requesterName: link(requesterID) })} {followerOf} />
        {#if negotiation}<br />{plainText(fill(W + "OfferAmountInISK", { amount: negotiation.iskValue }))}{/if}
      </span>
    </div>
    <div class="ws-mine">
      <textarea bind:value={message} maxlength="400" readonly={!!negotiation} placeholder={plainText(fill(W + "Reasonforoffer"))}></textarea>
      {#if !negotiation}<input type="number" min="0" max="100000000000" step="1" bind:value={isk} placeholder={plainText(fill(W + "OfferInISK"))} />{/if}
    </div>
    <div class="ws-buttons">
      {#if !negotiation}
        <button type="button" disabled={busy} onclick={() => void act("offer")}>{plainText(fill("UI/Common/Buttons/Submit"))}</button>
        <button type="button" onclick={() => onClose(false)}>{plainText(fill("UI/Common/Buttons/Cancel"))}</button>
      {:else if me === negotiation.ownerID1}
        <button type="button" onclick={() => onClose(false)}>{plainText(fill("UI/Common/Buttons/Close"))}</button>
        <button type="button" disabled title="An ally offer's: not a surrender's">{plainText(fill(W + "RetractAllyOffer"))}</button>
      {:else if me === negotiation.ownerID2}
        <button type="button" disabled={busy} onclick={() => void act("accept")}>{plainText(fill(W + "AcceptOffer"))}</button>
        <button type="button" disabled={busy} onclick={() => void act("decline")}>{plainText(fill(W + "DeclineOffer"))}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .ws-back { position: fixed; inset: 0; z-index: 1001; display: grid; place-items: center; background: rgba(0, 0, 0, 0.35); }
  .ws { width: 450px; height: 282px; display: flex; flex-direction: column; padding: 0 4px; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  header { display: flex; justify-content: space-between; padding: 4px; font-weight: bold; }
  .ws-x { background: none; border: 0; color: inherit; font-size: 16px; cursor: pointer; }
  .ws-head { height: 45px; display: flex; gap: 6px; }
  .ws-icon { width: 32px; padding-top: 4px; font-size: 24px; }
  .ws-title { font-size: 15px; }
  .ws-more { cursor: help; opacity: 0.7; }
  .ws-war { height: 40px; display: flex; gap: 4px; padding-top: 6px; }
  .ws-logo { width: 32px; height: 32px; display: grid; margin: 2px; }
  .ws-logo :global(.corp-logo) { width: 32px; height: 32px; }
  .ws-request { padding-top: 6px; }
  .ws-mine { flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 0 2px; min-height: 0; }
  .ws-mine textarea { flex: 1; resize: none; }
  .ws-buttons { display: flex; gap: 4px; justify-content: center; padding: 6px; }
</style>
