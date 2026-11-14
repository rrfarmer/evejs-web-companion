<script lang="ts">
  // agencyNew/ui/agencyWnd.AgencyWndNew (UI/Agency/Caption, 1188 x 694): the header's tabs - the home group and the
  // IsTabGroup groups in contentGroupConst.agencyTabSortOrder - back and forward through the history, the breadcrumb
  // (the group's ancestors from home), and the content group browser showing the group's page:
  //   home (HomeContentGroupPage): a left column of the Missions, Encounters, Exploration and Resource Harvesting
  //     horizontal cards (400 x 98, their description shown on hover), the right column (632) a carousel (300 high,
  //     every 8 s) of the Homefront, Heraldry and Corp cards and below it the Help card (632 x 132);
  //   a group (BaseContentGroupPage): its visible children's vertical cards (200 x 333: the card texture, the name,
  //     the description);
  //   Agent Finder (contentGroupAgentFinder): the agent finder;
  //   the agent groups (Security, Distribution, Mining, Research, Locator, Heraldry): ContentPageAgents;
  //   Career Agents: ContentPageCareerAgents; Storyline Agents: ContentPageStorylineAgents;
  //   Combat Anomalies, Ore Anomalies, Ice Belts: ContentPageCombatAnomalies, ContentPageOreAnomalies, ContentPageIceBelts;
  //   Cosmic Signatures: ContentPageSignatures; Epic Arcs: ContentPageEpicArcs;
  //   Homefront operations: ContentPageHomefrontSites; Escalations: ContentPageEscalations; Incursions: ContentPageIncursions, and an incursion's ContentPageIncursion;
  //   Planetary Production: ContentPagePlanetaryProduction; Mercenary Dens: ContentPageMercDen;
  //   Colony Resources: ContentPageColonyResourcesAgency (part 1).
  // A card is disabled (UI/Agency/currentlyUnavailable, UnavailableInWormholes outside known space) where the group is
  // not in contentGroupsEnabledInWormholes and the pilot is not in known space.
  // OpenAndShowContentGroup (agencyRequests): the window on the asked group.
  // Not here (later parts): the other groups' own content pages (the other sites, the systems), the new content labels,
  // the cards' scale and fade animations, the bookmarks bar, the seasons and dynamic new-feature cards.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { AGENCY_GROUPS, AGENCY_TAB_ORDER, AGENCY_WORMHOLE_GROUPS, agencyPath, type AgencyGroup } from "./agencyContentGroups.ts";
  import { agencyRequests, serveAgencyRequest } from "./agencyRequests.ts";
  import AgentFinder from "./AgentFinder.svelte";
  import AgencyAgentsPage from "./AgencyAgentsPage.svelte";
  import AgencyCareerAgentsPage from "./AgencyCareerAgentsPage.svelte";
  import AgencyStorylineAgentsPage from "./AgencyStorylineAgentsPage.svelte";
  import AgencySitesPage from "./AgencySitesPage.svelte";
  import AgencyEpicArcsPage from "./AgencyEpicArcsPage.svelte";
  import AgencyIncursionsPage from "./AgencyIncursionsPage.svelte";
  import AgencyIncursionPage from "./AgencyIncursionPage.svelte";
  import AgencyPlanetaryProductionPage from "./AgencyPlanetaryProductionPage.svelte";
  import AgencyMercDensPage from "./AgencyMercDensPage.svelte";
  import AgencyColonyResourcesPage from "./AgencyColonyResourcesPage.svelte";
  import { resolvedName } from "../store/names.ts";
  import { DEFAULT_SITE_FILTERS, type AgencySiteFilters, type SiteTrackerKind } from "../bridge/agencySites.ts";
  import { AGENT_PROVIDERS, DEFAULT_AGENT_FILTERS, type AgencyAgentFilters } from "../bridge/agencyAgents.ts";

  let { store, flow, showTravel, onOpenTab }: { store: ClientStore; flow: AppFlow; showTravel?: () => void; onOpenTab?: (tab: string) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const HOME = 1, AGENT_FINDER = 28, CAREER_AGENTS = 21, STORYLINE_AGENTS = 51, COMBAT_ANOMALIES = 38, ORE_ANOMALIES = 48, ICE_BELTS = 41, COSMIC_SIGNATURES = 39, EPIC_ARCS = 33, ESCALATIONS = 45, INCURSIONS = 72, INCURSION = 50, PLANETARY_PRODUCTION = 42, MERC_DENS = 85, COLONY_RESOURCES = 84, HELP = 69, HOMEFRONT = 78, HERALDRY = 71, CORP = 62, SEASONS = 34;
  const HOME_LEFT = [11, 12, 13, 14];
  const CAROUSEL = [HOMEFRONT, HERALDRY, CORP];
  // carousel_* textures for the home page's carousel cards (their texturePath), else the group's own card.
  const CAROUSEL_CARDS: Record<number, string> = {
    [HOMEFRONT]: "res:/UI/Texture/Classes/Agency/navigationCards/carousel_homefront_operations.png",
    [HERALDRY]: "res:/UI/Texture/Classes/Agency/navigationCards/carousel_AgentsHeraldry.png",
  };

  let history = $state<number[]>([HOME]), at = $state(0);
  // Each history step's item (a content group's itemID: the incursion's constellation), where it has one.
  let items = $state<(number | null)[]>([null]);
  // agencyFilters by content group (the character's settings in the client; the window's life here).
  let agentFilters = $state<Record<number, AgencyAgentFilters>>({});
  let siteFilters = $state<Record<number, AgencySiteFilters>>({});
  const SITE_PAGES: Record<number, SiteTrackerKind | "signature" | "escalation"> = { [COMBAT_ANOMALIES]: "combat", [ORE_ANOMALIES]: "ore", [ICE_BELTS]: "ice", [COSMIC_SIGNATURES]: "signature", [ESCALATIONS]: "escalation", [HOMEFRONT]: "homefront" };
  const groupID = $derived(history[at] ?? HOME);
  const itemID = $derived(items[at] ?? null);
  const group = $derived(AGENCY_GROUPS[groupID] ?? AGENCY_GROUPS[HOME]!);
  // IncursionContentGroup (contentGroupIncursion 50) is no group of the tree: its parent the Incursions group.
  const path = $derived(groupID === INCURSION ? [...agencyPath(INCURSIONS), INCURSION] : agencyPath(groupID));
  /** AgencyWndNew.OpenAndShowContentGroup / the history's append: forward steps dropped, the group added. */
  function show(id: number, item: number | null = null): void {
    if (!AGENCY_GROUPS[id] && id !== INCURSION) id = HOME;
    if (id === groupID && item === itemID) return;
    history = [...history.slice(0, at + 1), id];
    items = [...items.slice(0, at + 1), item];
    at = history.length - 1;
  }
  /** A crumb's name: the group's, or IncursionContentGroup.GetName (UI/Agency/IncursionIn, the constellation's). */
  const crumbName = (id: number) => (id === INCURSION ? plainText(formatTemplate($words.templates["UI/Agency/IncursionIn"] ?? "", { constellationName: itemID ? resolvedName($names.resolved, "constellation", itemID, "") : "" } as never, { nameOf: () => "" })) : word(AGENCY_GROUPS[id]!.name));
  $effect(() => agencyRequests.subscribe((asked) => { if (asked) { serveAgencyRequest(asked.n); show(asked.contentGroupID); } }));

  const systemID = $derived($flight.status?.solarSystemID ?? $station.online?.solarSystemID ?? null);
  const knownSpace = $derived(systemID === null || systemID < 31000000);
  const wormhole = $derived(systemID !== null && systemID >= 31000000 && systemID < 32000000);
  const disabled = (g: AgencyGroup) => !knownSpace && !AGENCY_WORMHOLE_GROUPS.includes(g.id);
  // IsVisible: the seasons group without a season (none in this build's data); HomefrontSitesContentGroup while its
  // provider has any site (GetAllDungeonInstances).
  let homefrontSites = $state(false);
  $effect(() => { void flow.agencyTrackerSites("homefront", DEFAULT_SITE_FILTERS).then((list) => { homefrontSites = !!list?.length; }); });
  const visible = (id: number) => id !== SEASONS && (id !== HOMEFRONT || homefrontSites);
  const tabs = $derived([HOME, ...AGENCY_TAB_ORDER.filter((id) => AGENCY_GROUPS[id]?.tab)]);
  const children = $derived(group.children.filter(visible).map((id) => AGENCY_GROUPS[id]).filter((g): g is AgencyGroup => !!g));

  const word = (label: string | null) => (label ? plainText(formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: () => "" })) : "");
  $effect(() => {
    flow.requestWords(["UI/Agency/IncursionIn", "UI/Agency/Caption", "UI/Agency/currentlyUnavailable", "UI/Agency/UnavailableInWormholes", "UI/Commands/Back", "UI/Commands/Forward",
      ...Object.values(AGENCY_GROUPS).flatMap((g) => [g.name, g.description]).filter((x): x is string => !!x)]);
  });

  // Carousel: every 8 s to the next card (paused while the pointer is on it).
  let slide = $state(0), hold = $state(false);
  const slides = $derived(CAROUSEL.filter(visible));
  $effect(() => { const t = setInterval(() => { if (!hold && groupID === HOME) slide = (slide + 1) % Math.max(1, slides.length); }, 8000); return () => clearInterval(t); });
</script>

{#snippet card(g: AgencyGroup, kind: "h" | "v" | "home-v", texture: string | null = null)}
  {@const off = disabled(g)}
  <button type="button" class={`ag-card ag-${kind}`} class:off disabled={off} onclick={() => show(g.id)} title={word(g.name)}>
    {#if texture ?? g.card}<img class="ag-bg" alt="" src={clientTexture((texture ?? g.card)!)} />{/if}
    <span class="ag-title">{word(g.name)}</span>
    {#if g.description}<span class="ag-desc">{word(g.description)}</span>{/if}
    {#if off}<span class="ag-unavailable">⚠ {word(wormhole ? "UI/Agency/UnavailableInWormholes" : "UI/Agency/currentlyUnavailable")}</span>{/if}
  </button>
{/snippet}

<div class="ag">
  <header class="ag-head">
    <button type="button" class="ag-nav" disabled={at === 0} title={word("UI/Commands/Back")} onclick={() => (at = Math.max(0, at - 1))}>‹</button>
    <button type="button" class="ag-nav" disabled={at >= history.length - 1} title={word("UI/Commands/Forward")} onclick={() => (at = Math.min(history.length - 1, at + 1))}>›</button>
    <nav class="ag-tabs">
      {#each tabs as id (id)}
        <button type="button" class="ag-tab" class:on={id === HOME ? groupID === HOME : path.includes(id)} onclick={() => show(id)}>{word(AGENCY_GROUPS[id]!.name)}</button>
      {/each}
    </nav>
  </header>
  {#if groupID !== HOME}
    <div class="ag-crumbs">
      {#each path as id, i (id)}
        {#if i}<span class="ag-sep">/</span>{/if}
        {#if i < path.length - 1}<button type="button" onclick={() => show(id)}>{crumbName(id)}</button>{:else}<b>{crumbName(id)}</b>{/if}
      {/each}
    </div>
  {/if}
  <div class="ag-body">
    {#if groupID === HOME}
      <div class="ag-home">
        <div class="ag-home-left">
          {#each HOME_LEFT as id (id)}{@render card(AGENCY_GROUPS[id]!, "h")}{/each}
        </div>
        <div class="ag-home-right">
          <div class="ag-carousel" role="group" onmouseenter={() => (hold = true)} onmouseleave={() => (hold = false)}>
            {#each slides as id, i (id)}
              <div class="ag-slide" class:on={i === slide % slides.length}>{@render card(AGENCY_GROUPS[id]!, "home-v", CAROUSEL_CARDS[id] ?? null)}</div>
            {/each}
            <div class="ag-dots">{#each slides as id, i (id)}<button type="button" class:on={i === slide % slides.length} aria-label={word(AGENCY_GROUPS[id]!.name)} onclick={() => (slide = i)}></button>{/each}</div>
          </div>
          <div class="ag-help">{@render card(AGENCY_GROUPS[HELP]!, "home-v")}</div>
        </div>
      </div>
    {:else if groupID === AGENT_FINDER}
      <div class="ag-page"><AgentFinder {store} {flow} {showTravel} /></div>
    {:else if groupID === INCURSION && itemID}
      {#key itemID}<div class="ag-page"><AgencyIncursionPage {store} {flow} constellationID={itemID} /></div>{/key}
    {:else if groupID === COLONY_RESOURCES}
      <div class="ag-page"><AgencyColonyResourcesPage {store} {flow} bind:filters={() => siteFilters[groupID] ?? DEFAULT_SITE_FILTERS, (f) => (siteFilters = { ...siteFilters, [groupID]: f })} /></div>
    {:else if groupID === MERC_DENS}
      <div class="ag-page"><AgencyMercDensPage {store} {flow} {onOpenTab} /></div>
    {:else if groupID === PLANETARY_PRODUCTION}
      <div class="ag-page"><AgencyPlanetaryProductionPage {store} {flow} bind:filters={() => siteFilters[groupID] ?? DEFAULT_SITE_FILTERS, (f) => (siteFilters = { ...siteFilters, [groupID]: f })} /></div>
    {:else if groupID === INCURSIONS}
      <div class="ag-page"><AgencyIncursionsPage {store} {flow} onOpen={(c) => show(INCURSION, c)} bind:filters={() => siteFilters[groupID] ?? DEFAULT_SITE_FILTERS, (f) => (siteFilters = { ...siteFilters, [groupID]: f })} /></div>
    {:else if groupID === EPIC_ARCS}
      <div class="ag-page"><AgencyEpicArcsPage {store} {flow} /></div>
    {:else if SITE_PAGES[groupID]}
      <div class="ag-page"><AgencySitesPage {store} {flow} kind={SITE_PAGES[groupID]} bind:filters={() => siteFilters[groupID] ?? DEFAULT_SITE_FILTERS, (f) => (siteFilters = { ...siteFilters, [groupID]: f })} /></div>
    {:else if groupID === STORYLINE_AGENTS}
      <div class="ag-page"><AgencyStorylineAgentsPage {store} {flow} /></div>
    {:else if groupID === CAREER_AGENTS}
      <div class="ag-page"><AgencyCareerAgentsPage {store} {flow} /></div>
    {:else if AGENT_PROVIDERS[groupID]}
      <div class="ag-page"><AgencyAgentsPage {store} {flow} {groupID} bind:filters={() => agentFilters[groupID] ?? DEFAULT_AGENT_FILTERS, (f) => (agentFilters = { ...agentFilters, [groupID]: f })} /></div>
    {:else if children.length}
      <div class="ag-cards">
        {#each children as g (g.id)}{@render card(g, "v")}{/each}
      </div>
    {:else}
      <div class="ag-leaf">
        {#if group.card}<img alt="" src={clientTexture(group.card)} />{/if}
        <h2>{word(group.name)}</h2>
        {#if group.description}<p>{word(group.description)}</p>{/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .ag { display: flex; flex-direction: column; height: 100%; min-height: 0; color: rgb(255 255 255 / 0.85); }
  .ag-head { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-bottom: 1px solid rgb(255 255 255 / 0.1); }
  .ag-nav { all: unset; cursor: pointer; width: 22px; text-align: center; font-size: 18px; opacity: 0.8; }
  .ag-nav:disabled { opacity: 0.25; cursor: default; }
  .ag-tabs { display: flex; gap: 2px; margin-left: 8px; flex-wrap: wrap; }
  .ag-tab { all: unset; cursor: pointer; padding: 6px 12px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; border-bottom: 2px solid transparent; }
  .ag-tab:hover { opacity: 1; }
  .ag-tab.on { opacity: 1; border-bottom-color: #58a7bf; }
  .ag-crumbs { display: flex; align-items: center; gap: 6px; padding: 6px 16px; font-size: 13px; }
  .ag-crumbs button { all: unset; cursor: pointer; opacity: 0.7; }
  .ag-crumbs button:hover { opacity: 1; text-decoration: underline; }
  .ag-sep { opacity: 0.4; }
  .ag-body { flex: 1; min-height: 0; overflow: auto; padding: 20px; }
  .ag-home { display: flex; gap: 20px; justify-content: center; }
  .ag-home-left { display: flex; flex-direction: column; gap: 20px; width: 400px; flex: none; }
  .ag-home-right { display: flex; flex-direction: column; gap: 20px; width: 632px; flex: none; }
  .ag-carousel { position: relative; height: 300px; }
  .ag-slide { position: absolute; inset: 0; opacity: 0; transition: opacity 1s; pointer-events: none; }
  .ag-slide.on { opacity: 1; pointer-events: auto; }
  .ag-dots { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; z-index: 2; }
  .ag-dots button { all: unset; cursor: pointer; width: 8px; height: 8px; border-radius: 50%; background: rgb(255 255 255 / 0.35); }
  .ag-dots button.on { background: #fff; }
  .ag-help { height: 132px; }
  .ag-cards { display: flex; flex-wrap: wrap; gap: 20px; justify-content: center; }
  .ag-card { all: unset; box-sizing: border-box; cursor: pointer; position: relative; overflow: hidden; display: flex; flex-direction: column; background: #0d0f11; border: 1px solid rgb(255 255 255 / 0.15); }
  .ag-card:hover:not(.off) { border-color: rgb(255 255 255 / 0.5); }
  .ag-card:hover:not(.off) .ag-bg { transform: scale(1.05); }
  .ag-card.off { cursor: default; border-color: rgb(255 255 255 / 0.08); }
  .ag-card.off .ag-bg { opacity: 0.3; }
  .ag-h { width: 400px; height: 98px; justify-content: flex-start; }
  .ag-v { width: 200px; height: 333px; justify-content: flex-end; }
  .ag-home-v { width: 100%; height: 100%; justify-content: flex-start; }
  .ag-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s; }
  .ag-title { position: relative; padding: 10px 12px 4px; font-size: 15px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; text-shadow: 0 1px 3px #000; }
  .ag-desc { position: relative; padding: 6px 12px 10px; font-size: 12px; line-height: 1.35; background: rgb(0 0 0 / 0.5); }
  .ag-v .ag-desc { text-align: center; min-height: 82px; }
  .ag-h .ag-desc { width: 170px; opacity: 0; transition: opacity 0.3s; margin-left: auto; position: absolute; right: 0; top: 0; bottom: 0; }
  .ag-home-v .ag-desc { opacity: 0; transition: opacity 0.3s; position: absolute; left: 0; right: 0; bottom: 0; min-height: 60px; }
  .ag-card:hover .ag-desc { opacity: 1; }
  .ag-v .ag-title { order: -1; margin-bottom: auto; }
  .ag-unavailable { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -60%); padding: 8px 14px; background: #000; border: 1px solid #7a7a7a; color: #9a9a9a; font-size: 13px; white-space: nowrap; }
  .ag-page { height: 100%; }
  .ag-leaf { max-width: 640px; margin: 0 auto; text-align: center; }
  .ag-leaf img { width: 200px; height: 333px; object-fit: cover; }
  .ag-leaf p { font-size: 14px; line-height: 1.45; }
</style>
