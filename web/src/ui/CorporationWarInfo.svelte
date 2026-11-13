<script lang="ts">
  // corporation/war/warLandingPage.py WarLandingPage (Wars > War Info / Laws of War): a ScrollContainer of six
  // LandingPageConts - Wars, War Bills, Allies, Mutual Wars, War Eligibility, Peace - each the "?" icon (its tooltip text),
  // the header (TextHeader, highlighted), the description (TextBody) and the current status (TextBody, "..." cycling
  // while loading; hidden where empty: a war bill status for a non-accountant), 32 apart, 36 in; the Declare War button
  // at the bottom. The statuses as GetCurrentWarStatus ... GetCurrentPeaceTimeInfo choose their labels from
  // GetLandingPageInfo. (Declare War shown, not acting: the declaration window is not on the page.)
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, WarLandingInfo } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import CorporationDeclareWar from "./CorporationDeclareWar.svelte";
  import { linkFollowerOf, LINK_WORDS } from "./linkFollowers.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const W = "UI/Corporations/Wars/";
  const SECTIONS = [
    { key: "wars", head: "LandingPageWarsHeader", desc: "LandingPageWarsDesc", tip: "LandingPageWarsTooltip" },
    { key: "bills", head: "LandingPageWarBillsHeader", desc: "LandingPageWarBillsDesc", tip: "LandingPageWarBillsTooltip" },
    { key: "allies", head: "LandingPageAlliesHeader", desc: "LandingPageAlliesDesc", tip: "LandingPageAlliesTooltip" },
    { key: "mutual", head: "LandingPageMutualWarsHeader", desc: "LandingPageMutualWarsDesc", tip: "LandingPageMutualWarsTooltip" },
    { key: "eligibility", head: "LandingPageWarEligibilityHeader", desc: "LandingPageWarEligibilityDesc", tip: "LandingPageWarEligibilityTooltip" },
    { key: "peace", head: "LandingPagePeaceHeader", desc: "LandingPagePeaceDesc", tip: "LandingPagePeaceTooltip" },
  ] as const;
  const STATUS_LABELS = ["LandingPageWarStatusCurrentAndPendingWars", "LandingPageWarStatusCurrentWars", "LandingPageWarStatusPendingWars", "LandingPageWarStatusNoWars",
    "LandingPageWarBillStatusWithBills", "LandingPageWarBillStatusWithoutBills", "ViewBills", "LandingPagAllyStatusAllyAndAllied", "LandingPagAllyStatusAlly",
    "LandingPagAllyStatusAllied", "LandingPagAllyStatusNoAllies", "LandingPageMutualWarsExist", "LandingPageMutualWarsNoWar",
    "LandingPageEligibilityStatusWarPermitAndWarHq", "LandingPageEligibilityStatusWarPermitAndNoHq", "LandingPageEligibilityStatusNoPermit",
    "LandingPageForcedPeaceTreaties", "LandingPageNoForcedPeace"];
  const DECLARE = "UI/Corporations/CorporationWindow/Alliances/Rankings/DeclareWar";
  const raw = (label: string, values: Record<string, unknown> = {}) =>
    formatTemplate($words.templates[label] ?? "", values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => plainText($words.templates[label] ?? LINK_WORDS[label] ?? ""), text);
  let info = $state<WarLandingInfo | null>(null), error = $state(""), dots = $state("."), declaring = $state(false);
  onMount(() => {
    flow.requestWords([...SECTIONS.flatMap((s) => [W + s.head, W + s.desc, W + s.tip]), ...STATUS_LABELS.map((l) => W + l), DECLARE, ...Object.keys(LINK_WORDS)]);
    void flow.warLandingInfo().then((i) => { info = i; }).catch((e) => { error = e instanceof Error ? e.message : String(e); });
    // LoadingUpdate_thread: ".", "..", "..." every 500 ms until the status comes
    const cycle = setInterval(() => { dots = dots.length >= 3 ? "." : dots + "."; }, 500);
    return () => clearInterval(cycle);
  });
  function statusOf(key: string, i: WarLandingInfo): string {
    const link = `<url=showinfo:${i.ownerTypeID}//${i.ownerID}>${i.ownerName}</url>`;
    const v = { corpOrAllianceLink: link };
    switch (key) {
      case "wars": return raw(W + (i.currentWars ? (i.pendingWars ? "LandingPageWarStatusCurrentAndPendingWars" : "LandingPageWarStatusCurrentWars") : i.pendingWars ? "LandingPageWarStatusPendingWars" : "LandingPageWarStatusNoWars"),
        { ...v, numActiveWars: i.currentWars, numPendingWars: i.pendingWars });
      case "bills":
        if (i.unpaidWarBills === null) return "";
        // the bills link (localsvc ShowPayableCorpBills) is shown as its words
        return `${i.unpaidWarBills ? raw(W + "LandingPageWarBillStatusWithBills", { numBills: i.unpaidWarBills }) : raw(W + "LandingPageWarBillStatusWithoutBills")} ${raw(W + "ViewBills")}`;
      case "allies": return raw(W + (i.numAllyWars ? (i.numAllies ? "LandingPagAllyStatusAllyAndAllied" : "LandingPagAllyStatusAlly") : i.numAllies ? "LandingPagAllyStatusAllied" : "LandingPagAllyStatusNoAllies"),
        { ...v, numAllyWars: i.numAllyWars, numAllies: i.numAllies });
      case "mutual": return raw(W + (i.nonFinishedMutualWars ? "LandingPageMutualWarsExist" : "LandingPageMutualWarsNoWar"), { ...v, numMutualWars: i.nonFinishedMutualWars });
      case "eligibility": return raw(W + (i.warPermit ? (i.validWarHQs ? "LandingPageEligibilityStatusWarPermitAndWarHq" : "LandingPageEligibilityStatusWarPermitAndNoHq") : "LandingPageEligibilityStatusNoPermit"),
        { ...v, numHq: i.validWarHQs });
      default: return raw(W + (i.numWarTreaties ? "LandingPageForcedPeaceTreaties" : "LandingPageNoForcedPeace"), { ...v, numWarTreaties: i.numWarTreaties });
    }
  }
</script>

<div class="war-info">
  <div class="wi-scroll">
    {#if error}<p class="error">{error}</p>{/if}
    {#each SECTIONS as s, n (s.key)}
      {@const status = info ? statusOf(s.key, info) : dots}
      <section class="wi-section" class:first={n === 0}>
        <span class="wi-help" title={plainText($words.templates[W + s.tip] ?? "")}>?</span>
        <div class="wi-head">{plainText($words.templates[W + s.head] ?? "")}</div>
        <div class="wi-desc"><LabelText markup={$words.templates[W + s.desc] ?? ""} /></div>
        {#if status}<div class="wi-status"><LabelText markup={status} {followerOf} /></div>{/if}
      </section>
    {/each}
  </div>
  <div class="wi-buttons"><button type="button" onclick={() => (declaring = true)}>{plainText($words.templates[DECLARE] ?? "Declare War")}</button></div>
  {#if declaring}<CorporationDeclareWar {store} {flow} onClose={() => { declaring = false; void flow.warLandingInfo().then((i) => { info = i; }); }} />{/if}
</div>

<style>
  .war-info { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .wi-scroll { flex: 1; overflow: auto; }
  .wi-section { position: relative; padding: 32px 0 0 36px; min-height: 30px; }
  .wi-section.first { padding-top: 4px; }
  .wi-help { position: absolute; left: 4px; margin-top: 4px; width: 16px; height: 16px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.5); font-size: 11px; line-height: 16px; text-align: center; cursor: help; }
  .wi-head { font-size: 16px; color: #fff; }
  .wi-desc { padding-top: 2px; opacity: 0.8; }
  .wi-status { padding-top: 2px; }
  .wi-buttons { display: flex; justify-content: center; padding-top: 8px; }
  .error { color: #e06666; }
</style>
