<script lang="ts">
  // agencyNew/ui/contentPages/contentPageCampaigns.ContentPageCampaigns: two columns (CONTENT_PAGE_WIDTH_HALF each,
  // 500 high). The left: the Overview section (OverviewHeader, OverviewText), then 10 below it the Dashboard section
  // (DashboardHeader, DashboardText, Open Dashboard 10 below) and beside it the Opportunities section
  // (OpportunitiesHeader, OpportunitiesText, Open Campaign Opportunities 10 below), each half the column. The right:
  // Timeframe, Participation and Standings, 10 apart, each its header and its text 8 below. The texts with their links.
  // Open Dashboard: theatersOfWar open_campaigns (the Theaters of War dashboard, a window the page has not: drawn
  // disabled). Open Campaign Opportunities: the Job Board's browse page (JobBoardWindow.Open(page_id='browse',
  // content_tag_id=feature_campaigns); the page's Job Board has no content tag filter, and opens unfiltered).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { LINK_WORDS, linkFollowerOf } from "./linkFollowers.ts";
  import LabelText from "./LabelText.svelte";

  let { store, flow, onOpenTab }: { store: ClientStore; flow: AppFlow; onOpenTab?: (tab: string) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const C = "UI/Agency/Campaigns/";
  const markup = (label: string) => formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  const word = (label: string) => plainText(markup(label));
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => word(label), text);
  $effect(() => {
    flow.requestWords([...Object.keys(LINK_WORDS), ...["Overview", "Dashboard", "Opportunities", "Timeframe", "Participation", "Standings"].flatMap((k) => [`${C}${k}Header`, `${C}${k}Text`]),
      `${C}OpenDashboard`, `${C}OpenCampaignOpportunities`]);
  });
</script>

{#snippet section(key: string, top: number)}
  <section class="acp-sec" style:margin-top={`${top}px`}><h4>{word(`${C}${key}Header`)}</h4><div class="acp-text"><LabelText markup={markup(`${C}${key}Text`)} {followerOf} /></div></section>
{/snippet}

<div class="acp">
  <div class="acp-col">
    {@render section("Overview", 0)}
    <div class="acp-pair">
      <section class="acp-sec"><h4>{word(`${C}DashboardHeader`)}</h4><div class="acp-text"><LabelText markup={markup(`${C}DashboardText`)} {followerOf} /></div>
        <button type="button" class="acp-btn" disabled>{word(`${C}OpenDashboard`)}</button></section>
      <section class="acp-sec"><h4>{word(`${C}OpportunitiesHeader`)}</h4><div class="acp-text"><LabelText markup={markup(`${C}OpportunitiesText`)} {followerOf} /></div>
        <button type="button" class="acp-btn" onclick={() => onOpenTab?.("jobBoard")}>{word(`${C}OpenCampaignOpportunities`)}</button></section>
    </div>
  </div>
  <div class="acp-col">
    {@render section("Timeframe", 0)}
    {@render section("Participation", 10)}
    {@render section("Standings", 10)}
  </div>
</div>

<style>
  .acp { display: flex; gap: 0; height: 500px; max-height: 100%; font-size: 13px; }
  .acp-col { flex: 1; min-width: 0; overflow: auto; padding: 0 20px; display: flex; flex-direction: column; }
  .acp-sec { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 6px 10px 10px; display: flex; flex-direction: column; }
  .acp-sec h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .acp-text { line-height: 1.35; }
  .acp-pair { display: flex; gap: 10px; margin-top: 10px; }
  .acp-pair .acp-sec { flex: 1; min-width: 0; }
  .acp-btn { margin-top: 10px; width: 100%; }
</style>
