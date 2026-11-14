<script lang="ts">
  // agencyNew/ui/contentGroupPages/triglavianSpaceContentGroupPage (group 63): on the left (0.5) the Overview
  // (OverviewDescription, a scroll) over Station Access (260 high: StationAccessDescription, then the Standings
  // SubSection - the Triglavian Collective's standing with the pilot (GetStandingWithSkillBonus) and, in a player
  // corporation, with the corporation, each the owner's icon (28) and the value - and its DescriptionIcon, the
  // StandingsRestrictionTooltip: StationAccessSection and each of get_all_station_standings_restrictions(Triglavian)
  // sorted by value, '{:6.2f}' and the service's label); on the right (10 in) Travel (Conduit Loop, Wormholes,
  // Filaments: each a large header and its text) over Take Me To with the Filaments card.
  // contentPages/contentPageTriglavianFilaments (group 64): Inbound Filaments (500 wide) and Outbound Filaments (500
  // wide, 5 apart): each its description, then its two FilamentGroups (140 high: the group's icon 40, its title, its
  // description, its DescriptionIcon with FilamentGroupTooltip - the group's title and each filament type), and Open
  // Market (ShowMarketGroupWithTypes of market group 2757 / 2756).
  // Not here: Open Market's market group (the page's market has no request for a group: the window opens on its
  // browse); FilamentListItem's drag and its own info icon.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { AGENCY_GROUPS } from "./agencyContentGroups.ts";
  import { LINK_WORDS, linkFollowerOf } from "./linkFollowers.ts";
  import { STATION_SERVICE_LABELS } from "./standingsThresholds.ts";
  import LabelText from "./LabelText.svelte";

  let { store, flow, page, onShow, onOpenTab }: { store: ClientStore; flow: AppFlow; page: "space" | "filaments"; onShow?: (groupID: number) => void; onOpenTab?: (tab: string) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const T = "UI/Agency/TriglavianSpace/";
  const TRIGLAVIAN = 500026;
  const nameOf = (kind: "owner" | "type", id: number) => resolvedName($names.resolved, kind as never, id, "");
  const markup = (label: string) => formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: nameOf as never });
  const word = (label: string) => plainText(markup(label));
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => word(label), text);
  const GROUPS = {
    minor: { title: `${T}MinorVictoryFilamentsTitle`, description: `${T}MinorVictoryFilamentsDescription`, icon: "FilamentTSpace1", types: [56065, 56066, 56067] },
    local: { title: `${T}LocalFilamentsTitle`, description: `${T}LocalFilamentsDescription`, icon: "FilamentTSpace2", types: [56068, 56069] },
    clade: { title: `${T}CladeFilamentsTitle`, description: `${T}CladeFilamentsDescription`, icon: "FilamentTSpace2", types: [56070, 56071, 56072, 56073, 56074, 56075] },
    system: { title: `${T}SystemTypeFilamentsTitle`, description: `${T}SystemTypeFilamentsDescription`, icon: "FilamentTSpace3", types: [56076, 56077, 56078, 56079, 56080, 56081] },
  } as const;
  type Group = (typeof GROUPS)[keyof typeof GROUPS];
  let standing = $state<Awaited<ReturnType<AppFlow["agencyTriglavianStandings"]>> | null>(null);
  let restrictions = $state<readonly [number, number][]>([]);
  $effect(() => {
    if (page !== "space") return;
    void flow.agencyTriglavianStandings().then((s) => { standing = s; });
    void flow.stationStandingsRestrictions().then((all) => { restrictions = Object.entries(all[String(TRIGLAVIAN)] ?? {}).map(([k, v]) => [Number(k), v] as [number, number]).sort((a, b) => a[1] - b[1]); }).catch(() => {});
  });
  $effect(() => {
    flow.requestWords([...Object.keys(LINK_WORDS), "UI/Overview/Overview", "UI/InfoWindow/TabNames/Standings", "UI/Agency/takeMeTo", "UI/Commands/OpenMarket",
      ...["StationAccessSection", "StationAccessDescription", "OverviewDescription", "TravelSection", "ConduitLoopTitle", "ConduitLoopDescription", "WormholesTitle",
        "WormholesDescription", "FilamentsTitle", "FilamentsDescription", "OutboundFilamentsSection", "OutboundFilamentsDescription", "InboundFilamentsSection",
        "InboundFilamentsDescription"].map((k) => `${T}${k}`),
      ...Object.values(GROUPS).flatMap((g) => [g.title, g.description]), ...Object.values(STATION_SERVICE_LABELS), AGENCY_GROUPS[64]?.name ?? "", AGENCY_GROUPS[64]?.description ?? ""].filter(Boolean));
  });
  $effect(() => { if (page === "filaments") flow.requestNames(Object.values(GROUPS).flatMap((g) => g.types.map((id) => ({ kind: "type" as const, id })))); });
  const restrictionHint = $derived([word(`${T}StationAccessSection`), ...restrictions.map(([service, value]) => `${value.toFixed(2).padStart(6, " ")}  ${word(STATION_SERVICE_LABELS[service] ?? "")}`)].join("\n"));
  const filaments = $derived(AGENCY_GROUPS[64]);
  const fmt = (v: number) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
</script>

{#snippet filamentGroup(g: Group)}
  <div class="atf-group">
    <img alt="" src={clientTexture(`res:/UI/Texture/Icons/Inventory/${g.icon}.png`)} />
    <div class="atf-group-text"><b>{word(g.title)}</b><div class="atf-group-desc"><LabelText markup={markup(g.description)} {followerOf} /></div></div>
    <span class="atf-more" title={`${word(g.title)}\n${g.types.map((t) => nameOf("type", t)).join("\n")}`}>ⓘ</span>
  </div>
{/snippet}

{#if page === "space"}
<div class="ats">
  <div class="ats-left">
    <section class="ats-sec ats-grow"><h4>{word("UI/Overview/Overview")}</h4><div class="ats-scroll"><LabelText markup={markup(`${T}OverviewDescription`)} {followerOf} /></div></section>
    <section class="ats-sec ats-access"><h4>{word(`${T}StationAccessSection`)}</h4>
      <div class="ats-scroll"><LabelText markup={markup(`${T}StationAccessDescription`)} {followerOf} /></div>
      <div class="ats-standings"><small>{word("UI/InfoWindow/TabNames/Standings")}</small>
        {#if standing?.characterID}<div class="ats-standing"><span>{nameOf("owner", standing.characterID)}</span><b>{fmt(standing.character)}</b></div>{/if}
        {#if standing?.corporationID && standing.corporation !== null}<div class="ats-standing"><span>{nameOf("owner", standing.corporationID)}</span><b>{fmt(standing.corporation)}</b></div>{/if}
        <span class="ats-more" title={restrictionHint}>ⓘ</span>
      </div>
    </section>
  </div>
  <div class="ats-right">
    <section class="ats-sec ats-grow"><h4>{word(`${T}TravelSection`)}</h4>
      <div class="ats-scroll">
        {#each [["ConduitLoopTitle", "ConduitLoopDescription"], ["WormholesTitle", "WormholesDescription"], ["FilamentsTitle", "FilamentsDescription"]] as [title, desc], i (title)}
          <p class="ats-title" class:first={i === 0}>{word(`${T}${title}`)}</p><LabelText markup={markup(`${T}${desc}`)} {followerOf} />
        {/each}
      </div>
    </section>
    <section class="ats-sec"><h4>{word("UI/Agency/takeMeTo")}</h4>
      {#if filaments}<button type="button" class="ats-card" onclick={() => onShow?.(64)}>{#if filaments.card}<img alt="" src={clientTexture(filaments.card)} />{/if}<span><b>{word(filaments.name ?? "")}</b><small>{filaments.description ? word(filaments.description) : ""}</small></span></button>{/if}
    </section>
  </div>
</div>
{:else}
<div class="atf">
  {#each [["InboundFilamentsSection", "InboundFilamentsDescription", GROUPS.system, GROUPS.clade], ["OutboundFilamentsSection", "OutboundFilamentsDescription", GROUPS.local, GROUPS.minor]] as const as [section, desc, first, second] (section)}
    <section class="ats-sec atf-col"><h4>{word(`${T}${section}`)}</h4>
      <div class="ats-scroll"><LabelText markup={markup(`${T}${desc}`)} {followerOf} /></div>
      {@render filamentGroup(second)}
      {@render filamentGroup(first)}
      <div class="atf-market"><button type="button" onclick={() => onOpenTab?.("market")}><img alt="" src={clientTexture("res:/UI/Texture/WindowIcons/market.png")} />{word("UI/Commands/OpenMarket")}</button></div>
    </section>
  {/each}
</div>
{/if}

<style>
  .ats, .atf { display: flex; gap: 10px; height: 100%; min-height: 0; font-size: 13px; }
  .ats-left { width: 50%; flex: none; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .ats-right { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .ats-sec { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 6px 10px 10px; display: flex; flex-direction: column; min-height: 0; box-sizing: border-box; }
  .ats-sec h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; opacity: 0.8; }
  .ats-grow { flex: 1; }
  .ats-access { height: 260px; flex: none; }
  .ats-scroll { flex: 1; min-height: 0; overflow: auto; }
  .ats-standings { position: relative; margin: 12px 36px 0 0; padding: 10px 6px; border: 1px solid rgb(255 255 255 / 0.1); display: flex; flex-direction: column; gap: 12px; }
  .ats-standings small { opacity: 0.7; }
  .ats-standing { display: flex; justify-content: space-between; height: 22px; align-items: center; }
  .ats-more { position: absolute; right: -28px; bottom: 6px; cursor: help; }
  .ats-title { margin: 8px 0 2px; font-size: 16px; color: #fff; }
  .ats-title.first { margin-top: 0; }
  .ats-card { all: unset; cursor: pointer; display: flex; gap: 10px; align-items: center; margin: 0 auto; padding: 6px; border: 1px solid rgb(255 255 255 / 0.12); }
  .ats-card img { width: 120px; height: 70px; object-fit: cover; }
  .ats-card span { display: flex; flex-direction: column; gap: 4px; }
  .atf-col { width: 500px; flex: none; }
  .atf-group { position: relative; display: flex; gap: 8px; height: 140px; box-sizing: border-box; padding-bottom: 8px; }
  .atf-group img { width: 40px; height: 40px; }
  .atf-group-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .atf-group-text b { margin-top: 4px; font-size: 15px; }
  .atf-group-desc { flex: 1; overflow: auto; margin-top: 8px; }
  .atf-more { position: absolute; right: 0; top: 0; cursor: help; }
  .atf-market { display: flex; justify-content: flex-end; height: 28px; }
  .atf-market button { display: inline-flex; align-items: center; gap: 6px; }
  .atf-market img { width: 16px; height: 16px; }
</style>
