<script lang="ts">
  // corporation/war/warAllyEntry.py AllyEntry (36 high): the ally's logo 32 at the right of a 110 wide column (hint
  // "<name><br>Ally", click Show Info), its line (the name as a link; AllyEntryAssistanceOffered {allyID, ally} for an
  // offer - hint AllyEntryAssistanceOfferedHint {ally, description, iskValue}; AllyEntryNotStarted {ally, timeToFight}
  // before its fighting starts - hint AllyEntryNotStartedHint; AllyEntryStartedHint {startTime, endTime} while it
  // fights), and the ally button at the right (24): an offer's Mercenary_Attention (OfferedHelp; a director's click
  // opens the offer - WarAssistanceOfferWnd), an ally's Mercenary_Ally (HelpAccepted, disabled). The ally's time is
  // max(its start, the war's start) to min(its finish, the war's finish).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, WarNegotiation } from "../app/flow.ts";
  import type { WarAlly } from "../bridge/corpWars.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo } from "./showInfo.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow, allyID, ally = null, negotiation = null, warStarted = null, warFinished = null, director = false, onOpen }: {
    store: ClientStore; flow: AppFlow; allyID: number; ally?: WarAlly | null; negotiation?: WarNegotiation | null; warStarted?: bigint | null; warFinished?: bigint | null;
    director?: boolean; onOpen?: (n: WarNegotiation) => void } = $props();
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
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  const W = "UI/Corporations/Wars/";
  const ALLY_ENTRY_LABELS = ["Ally", "AllyEntryAssistanceOffered", "AllyEntryAssistanceOfferedHint", "AllyEntryNotStarted", "AllyEntryNotStartedHint", "AllyEntryStartedHint",
    "OfferedHelp", "HelpAccepted"].map((k) => W + k).concat([DATE_LABELS.sn!, ...Object.keys(LINK_WORDS)]);
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const fill = (label: string, values: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny });
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  const isAlliance = (id: number) => id >= 99_000_000 && id < 100_000_000;
  const nameOf = (id: number) => resolvedName($names.resolved, "owner", id, "") || resolvedName($names.resolved, isAlliance(id) ? "alliance" : "corporation", id, String(id));
  const link = (id: number) => `<url=showinfo:${isAlliance(id) ? 16159 : 2}//${id}>${nameOf(id)}</url>`;
  const date = (t: bigint | null) => (t === null ? "" : plainText(fill(DATE_LABELS.sn!, { datetime: { type: "long", value: t.toString() } })));
  const now = () => BigInt(Date.now()) * 10000n + 116444736000000000n;
  const timeStarted = $derived(ally === null ? null : ally.timeStarted !== null && warStarted !== null ? (ally.timeStarted > warStarted ? ally.timeStarted : warStarted) : ally.timeStarted ?? warStarted);
  const timeFinished = $derived(ally === null ? null : warFinished !== null && ally.timeFinished !== null ? (ally.timeFinished < warFinished ? ally.timeFinished : warFinished) : ally.timeFinished);
  // UpdateText
  const text = $derived.by(() => {
    void $words; void $names;
    const t = now();
    let line = link(allyID), hint = "";
    if (negotiation) {
      line = fill(W + "AllyEntryAssistanceOffered", { allyID, ally: link(allyID) });
      hint = plainText(fill(W + "AllyEntryAssistanceOfferedHint", { ally: nameOf(allyID), description: negotiation.description, iskValue: negotiation.iskValue }));
    }
    if (timeStarted !== null && t < timeStarted) {
      line = fill(W + "AllyEntryNotStarted", { allyID, ally: link(allyID), timeToFight: { type: "long", value: (timeStarted - t).toString() } });
      hint = plainText(fill(W + "AllyEntryNotStartedHint", { startTime: date(timeStarted), endTime: date(timeFinished) }));
    } else if (timeFinished !== null && t < timeFinished) {
      line = link(allyID);
      hint = plainText(fill(W + "AllyEntryStartedHint", { startTime: date(timeStarted), endTime: date(timeFinished) }));
    }
    return { line, hint };
  });
  const logo = $derived.by(() => {
    const l = isAlliance(allyID) ? null : $corpLogos[String(allyID)] ?? null;
    if (l && l.shapes.some((s) => s !== null)) return { kind: "corp" as const, l };
    const url = isAlliance(allyID) ? allianceLogoUrl($imageServer, allyID) : (() => { const t = $ownerLogos?.corporations[String(allyID)]; return t ? clientTexture(t) : null; })();
    return { kind: "img" as const, url };
  });
  $effect(() => { flow.requestWords(ALLY_ENTRY_LABELS); flow.loadOwnerLogos(); flow.loadImageServer(); if (!isAlliance(allyID)) flow.requestCorpLogos([allyID]); });
</script>

<div class="ae" title={text.hint}>
  <span class="ae-icon">
    <button type="button" class="ae-logo" title={`${nameOf(allyID)}\n${plainText(fill(W + "Ally"))}`} onclick={() => showInfo(isAlliance(allyID) ? { kind: "alliance", allianceID: allyID } : { kind: "corporation", corporationID: allyID })}>
      {#if logo.kind === "corp" && $corpLogoLibrary}<CorpLogo library={$corpLogoLibrary} logo={logo.l} name={nameOf(allyID)} />{:else if logo.kind === "img"}<OwnerPicture name={nameOf(allyID)} urls={logo.url ? [logo.url] : []} size={32} />{/if}
    </button>
  </span>
  <span class="ae-text"><LabelText markup={text.line} {followerOf} /></span>
  {#if negotiation}
    <button type="button" class="ae-btn" title={plainText(fill(W + "OfferedHelp"))} disabled={!director} onclick={() => negotiation && onOpen?.(negotiation)}>❗</button>
  {:else}
    <button type="button" class="ae-btn" title={plainText(fill(W + "HelpAccepted"))} disabled>🛡</button>
  {/if}
</div>

<style>
  .ae { height: 36px; display: flex; align-items: center; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  .ae-icon { width: 110px; display: flex; justify-content: flex-end; }
  .ae-logo { width: 32px; height: 32px; margin-top: 2px; padding: 0; border: 0; background: none; cursor: pointer; display: grid; }
  .ae-logo :global(.corp-logo) { width: 32px; height: 32px; }
  .ae-text { flex: 1; min-width: 30px; padding-left: 7px; overflow: hidden; white-space: nowrap; }
  .ae-btn { width: 24px; margin-right: 2px; background: none; border: 0; color: inherit; cursor: pointer; }
  .ae-btn:disabled { cursor: default; opacity: 0.7; }
</style>
