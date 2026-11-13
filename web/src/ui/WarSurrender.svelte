<script lang="ts">
  // corporation/war/warWindows.py BaseNegotiationWnd (450 x 282) - WarSurrenderWnd (kind "surrender", caption Surrender)
  // and WarAssistanceOfferWnd (kind "ally", caption Allies): the header - the window's icon 32, its title (EveCaptionSmall:
  // SurrenderOffer; OfferAssistance for a request, AllyOffer for an offer) with its MoreInfo icon (MoreInfoSurrender /
  // MoreInfoAlly), InWarAvsB (both links) -, the requester's logo 32 with its line (OffersSurrender {requesterName};
  // an ally's: RequestsAnAlly where the requester is in the war, OffersToAlly for a request, else the name as a link)
  // and, for an offer, its amount (OfferAmountInISK; an ally's for its defender: AllyOfferWithFee {concordFee, iskTotal}
  // where the CONCORD fee - GetAllyCostToConcord: the ally base cost * 2^min(active allies - 1, 20), none without an
  // active ally - is due, else MercenaryOfferDetailed {amount}); the reason (400, hint Reasonforoffer) over the ISK
  // (hint OfferInISK; the ally's starts at the war's reward). A request: Submit / Cancel - CreateSurrenderNegotiation(
  // warID, isk, message) or CreateWarAllyOffer(warID, isk, defenderID, message). An offer: the reason read-only, no
  // amount field; the offerer sees Close and RetractAllyOffer (RetractWarAllyOffer - an ally offer's), the other side
  // Accept Offer / Decline Offer - AcceptSurrender / DeclineSurrender, AcceptAllyNegotiation / DeclineAllyOffer.
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
  let { store, flow, war = null, negotiation = null, kind = "surrender", onClose }: { store: ClientStore; flow: AppFlow; war?: CorpWar | null; negotiation?: WarNegotiation | null;
    kind?: "surrender" | "ally"; onClose: (done: boolean) => void } = $props();
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
    "AcceptOffer", "DeclineOffer", "Allies", "OfferAssistance", "AllyOffer", "MoreInfoAlly", "RequestsAnAlly", "OffersToAlly", "AllyOfferWithFee", "MercenaryOfferDetailed"].map((k) => W + k)
    .concat(["UI/Common/Buttons/Submit", "UI/Common/Buttons/Cancel", "UI/Common/Buttons/Close", ...Object.keys(LINK_WORDS), ...NUMERIC_WORD_LABELS]);
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const isk = (value: number, places: number) => iskWords(value, places, $words.templates, nameAny) ?? `${value.toLocaleString("en-US")} ISK`;
  const fill = (label: string, values: Record<string, unknown> = {}) =>
    formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny, writeIsk: (value, places) => isk(value, places) });
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  const isAlliance = (id: number) => id >= 99_000_000 && id < 100_000_000;
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || resolvedName($names.resolved, isAlliance(id) ? "alliance" : "corporation", id, String(id));
  const link = (id: number) => `<url=showinfo:${isAlliance(id) ? 16159 : 2}//${id}>${nameOf(id)}</url>`;
  const me = $derived($station.online?.allianceID ?? $station.online?.corporationID ?? 0);
  // the war's sides: a request's from the war, an offer's from the negotiation
  const attackerID = $derived(negotiation ? negotiation.declaredByID : war?.declaredByID ?? 0);
  const defenderID = $derived(negotiation ? negotiation.againstID : war?.againstID ?? 0);
  // a request's requester is the pilot's own; an offer's, its ownerID1
  const requesterID = $derived(negotiation ? negotiation.ownerID1 : me);
  // svelte-ignore state_referenced_locally
  let message = $state(negotiation?.description ?? ""), amount = $state(0), busy = $state(false), concordFee = $state(0);
  onMount(() => {
    flow.requestWords(LABELS); flow.loadOwnerLogos(); flow.loadImageServer();
    if (!isAlliance(requesterID)) flow.requestCorpLogos([requesterID]);
    // WarAssistanceOfferWnd.GetOfferText for the defender: the CONCORD fee of one more ally
    if (kind === "ally" && negotiation && me === negotiation.ownerID2) {
      const now = BigInt(Date.now()) * 10000n + 116444736000000000n;
      const active = (war?.allies ?? []).filter((a) => a.timeFinished !== null && now < a.timeFinished).length;
      if (active > 0) void flow.allyBaseCost().then((base) => { concordFee = base * 2 ** Math.min(active - 1, 20); }).catch(() => {});
    }
  });
  async function act(what: "offer" | "accept" | "decline" | "retract"): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      // the window closes whatever the call answered (try ... finally)
      const warID = war?.warID ?? negotiation?.warID ?? 0;
      const id = negotiation?.warNegotiationID ?? 0;
      const value = Math.max(0, Math.trunc(amount));
      const ok = what === "retract" ? await flow.allyAct({ kind: "retract", warNegotiationID: id })
        : kind === "ally" ? await flow.allyAct(what === "offer" ? { kind: "offer", warID, isk: value, defenderID, message } : { kind: what, warNegotiationID: id })
        : what === "offer" ? await flow.surrenderAct({ kind: "offer", warID, isk: value, message })
        : await flow.surrenderAct({ kind: what, warNegotiationID: id });
      onClose(ok);
    } catch { onClose(false); } finally { busy = false; }
  }
  const caption = $derived(plainText(fill(W + (kind === "ally" ? "Allies" : "Surrender"))) || (kind === "ally" ? "Allies" : "Surrender"));
  const title = $derived(plainText(fill(W + (kind === "ally" ? (negotiation ? "AllyOffer" : "OfferAssistance") : "SurrenderOffer"))));
  const requesterLine = $derived(kind === "surrender" ? fill(W + "OffersSurrender", { requesterName: link(requesterID) })
    : [attackerID, defenderID].includes(requesterID) ? fill(W + "RequestsAnAlly", { requesterName: link(requesterID) })
    : !negotiation ? fill(W + "OffersToAlly", { requesterName: link(requesterID) }) : link(requesterID));
  const offerLine = $derived(!negotiation ? "" : kind === "surrender" ? plainText(fill(W + "OfferAmountInISK", { amount: negotiation.iskValue }))
    : me === negotiation.ownerID2 && concordFee > 0 ? plainText(fill(W + "AllyOfferWithFee", { concordFee: isk(concordFee, 2), iskTotal: isk(concordFee + negotiation.iskValue, 2) }))
    : plainText(fill(W + "MercenaryOfferDetailed", { amount: negotiation.iskValue })));
  const logo = $derived.by(() => {
    const id = requesterID;
    const l = isAlliance(id) ? null : $corpLogos[String(id)] ?? null;
    if (l && l.shapes.some((s) => s !== null)) return { kind: "corp" as const, l };
    const url = isAlliance(id) ? allianceLogoUrl($imageServer, id) : (() => { const t = $ownerLogos?.corporations[String(id)]; return t ? clientTexture(t) : null; })();
    return { kind: "img" as const, url };
  });
</script>

<div class="ws-back">
  <div class="ws" role="dialog" aria-modal="true" aria-label={caption}>
    <header>{caption}<button type="button" class="ws-x" aria-label="Close" onclick={() => onClose(false)}>×</button></header>
    <div class="ws-head">
      <span class="ws-icon">{kind === "ally" ? "🛡" : "🏳"}</span>
      <span><span class="ws-title">{title} <span class="ws-more" title={plainText(fill(W + (kind === "ally" ? "MoreInfoAlly" : "MoreInfoSurrender")))}>ⓘ</span></span><br />
        <LabelText markup={fill(W + "InWarAvsB", { attackerName: link(attackerID), defenderName: link(defenderID) })} {followerOf} /></span>
    </div>
    <div class="ws-war">
      <span class="ws-logo">{#if logo.kind === "corp" && $corpLogoLibrary}<CorpLogo library={$corpLogoLibrary} logo={logo.l} name={nameOf(requesterID)} />{:else if logo.kind === "img"}<OwnerPicture name={nameOf(requesterID)} urls={logo.url ? [logo.url] : []} size={32} />{/if}</span>
      <span class:ws-request={!negotiation}>
        <LabelText markup={requesterLine} {followerOf} />
        {#if negotiation}<br />{offerLine}{/if}
      </span>
    </div>
    <div class="ws-mine">
      <textarea bind:value={message} maxlength="400" readonly={!!negotiation} placeholder={plainText(fill(W + "Reasonforoffer"))}></textarea>
      {#if !negotiation}<input type="number" min="0" max="100000000000" step="1" bind:value={amount} placeholder={plainText(fill(W + "OfferInISK"))} />{/if}
    </div>
    <div class="ws-buttons">
      {#if !negotiation}
        <button type="button" disabled={busy} onclick={() => void act("offer")}>{plainText(fill("UI/Common/Buttons/Submit"))}</button>
        <button type="button" onclick={() => onClose(false)}>{plainText(fill("UI/Common/Buttons/Cancel"))}</button>
      {:else if me === negotiation.ownerID1}
        <button type="button" onclick={() => onClose(false)}>{plainText(fill("UI/Common/Buttons/Close"))}</button>
        <button type="button" disabled={busy || kind !== "ally"} title={kind !== "ally" ? "An ally offer's: not a surrender's" : undefined} onclick={() => void act("retract")}>{plainText(fill(W + "RetractAllyOffer"))}</button>
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
