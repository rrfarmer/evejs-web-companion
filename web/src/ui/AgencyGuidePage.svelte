<script lang="ts">
  // agencyNew/ui/contentPages/baseGuide.BaseContentGuide (20 padding): the topic browser (a Section TOLEFT_PROP 0.25,
  // UI/Agency/PirateIncursions/Guides/GuideBrowserSectionTitle; a QuickFilterEdit 24 high, padTop 5; the topics' scroll,
  // each TopicScrollEntry 30 high its TextBody label, padding 5) and, 20 to its right, the chosen topic's panel - each a
  // GuideContainer (bgColor black 0.25; its Header centred, the panel's body scrolling: AddHeader top 16 padBottom 8,
  // AddImage centred top 8 padBottom 8, AddNormalText TextBody padded 8 either side).
  // _get_filtered_topics: under three letters every topic; else the topics whose label, or one of whose panel's
  // get_searchable_strings, holds the text. EnlistmentPanel's strings name _label2 and _extraHeader1, which it never sets,
  // so a search its label does not match raises there and the scroll stays flushed: the page shows no topics then.
  // The guides: contentPageFactionWarfareGuide (Topics: overview, war zones, enlistment, advantage, system capture, loyalty
  // points, missions; the panels contentPagesUI/factionWarfare/panels).
  // Not here (later parts): the Faction Warfare window (cmd.OpenMilitia) and the war zones map (OpenMap STARMODE_MILITIA
  // on the faction's HQ system), whose windows the page has not; the nearest militia office (facwar
  // GetNearestFactionWarfareStationData over map.GetStationInfo).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { AGENCY_GROUPS } from "./agencyContentGroups.ts";
  import { LINK_WORDS, linkFollowerOf } from "./linkFollowers.ts";
  import LabelText from "./LabelText.svelte";

  type Block =
    | { readonly h: string }
    | { readonly t: string }
    | { readonly img: string; readonly w: number; readonly hgt: number; readonly top?: number }
    | { readonly btn: string; readonly icon: string; readonly open: (() => void) | null; readonly top: number }
    | { readonly advantage: true }
    | { readonly enlist: true }
    | { readonly card: number };
  interface Topic { readonly id: string; readonly label: string; readonly header: string; readonly blocks: readonly Block[]; readonly strings: readonly string[] | null }

  let { store, flow, guide, onOpenTab, onShow }: { store: ClientStore; flow: AppFlow; guide: "factionWarfare"; onOpenTab?: (tab: string) => void; onShow?: (groupID: number) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const markup = (label: string) => formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  const word = (label: string) => plainText(markup(label));
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, (label) => word(label), text);
  const F = "UI/Agency/FactionWarfare/", G = `${F}Guides/`;

  /** contentPageFactionWarfareGuide.Topics.ORDERED and its panels, as their _construct_layout builds them. */
  function factionWarfare(): readonly Topic[] {
    return [
      // OverviewPanel: the image 802 x 177 at top 0, the text, the Faction Warfare window's button (35 high, top 10).
      { id: "overview", label: `${F}TopicOverview`, header: `${G}OverviewTitle`, strings: [`${G}OverviewTitle`, `${G}OverviewText`], blocks: [
        { img: "res:/UI/Texture/classes/agency/factionWarfare/overview.png", w: 802, hgt: 177, top: 0 }, { t: `${G}OverviewText` },
        { btn: `${F}openFactionWarfareWindow`, icon: "res:/UI/Texture/WindowIcons/factionalwarfare.png", open: null, top: 10 }] },
      // WarZonePanel: the text, the map's button (top 8), the frontlines header and text.
      { id: "war_zoneS", label: `${F}TopicWarZones`, header: `${G}WarZoneTitle`, strings: [`${G}WarZoneTitle`, `${G}WarZonesText`, `${G}WarZonesFrontlinesText`], blocks: [
        { t: `${G}WarZonesText` }, { btn: `${G}viewWarzonesOnMap`, icon: "res:/UI/Texture/WindowIcons/map.png", open: null, top: 8 },
        { h: `${G}WarZonesFrontlinesTitle` }, { t: `${G}WarZonesFrontlinesText` }] },
      // EnlistmentPanel: the text, the warning line, the standings grid (the nearest militia office is a later part).
      { id: "enlistment", label: `${F}TopicEnlistment`, header: `${G}EnlistmentTitle`, strings: null, blocks: [{ t: `${G}EnlistmentText` }, { enlist: true }] },
      // AdvantagePanel: the text, the advantage widget (top 32), the system upgrades header and text.
      { id: "advantage", label: `${F}TopicAdvantage`, header: `${G}AdvantageTitle`,
        strings: [`${G}AdvantageTitle`, `${G}AdvantageText`, `${G}SystemUpgradesText`, `${G}AdvantageTrackerTitle`, `${G}AdvantageTrackerText`, `${G}SystemUpgradesTitle`],
        blocks: [{ t: `${G}AdvantageText` }, { advantage: true }, { h: `${G}SystemUpgradesTitle` }, { t: `${G}SystemUpgradesText` }] },
      // CapturePanel: the complexes text, the system header and text.
      { id: "system_capture", label: `${F}TopicSystemCapture`, header: `${G}CaptureComplexesTitle`, strings: [`${G}CaptureComplexesTitle`, `${G}CaptureComplexesText`, `${G}CaptureSystemText`],
        blocks: [{ t: `${G}CaptureComplexesText` }, { h: `${G}CaptureSystemTitle` }, { t: `${G}CaptureSystemText` }] },
      // LoyaltyPointPanel: the text, the image 807 x 166 (top 8).
      { id: "loyalty", label: `${F}TopicLoyaltyPoints`, header: `${G}LoyaltyPointTitle`, strings: [`${G}LoyaltyPointTitle`, `${G}LoyaltyPointText`],
        blocks: [{ t: `${G}LoyaltyPointText` }, { img: "res:/UI/Texture/classes/agency/factionWarfare/loyaltyPoints.png", w: 807, hgt: 166 }] },
      // MissionsPanel: the image 807 x 185 at top 0, the text, the FW agents' HorizontalContentGroupCard (top 8).
      { id: "missions", label: `${F}TopicMissions`, header: `${G}MissionsTitle`, strings: [`${G}MissionsTitle`, `${G}MissionsText`],
        blocks: [{ img: "res:/UI/Texture/classes/agency/factionWarfare/missions.png", w: 807, hgt: 185, top: 0 }, { t: `${G}MissionsText` }, { card: 47 }] },
    ];
  }
  const topics = $derived(guide === "factionWarfare" ? factionWarfare() : []);
  let chosen = $state("overview"), search = $state("");
  const labelsOf = (b: Block): string[] => ("h" in b ? [b.h] : "t" in b ? [b.t] : "btn" in b ? [b.btn] : "card" in b ? [AGENCY_GROUPS[b.card]?.name ?? "", AGENCY_GROUPS[b.card]?.description ?? ""] : []);
  $effect(() => {
    flow.requestWords(["UI/Agency/PirateIncursions/Guides/GuideBrowserSectionTitle", ...Object.keys(LINK_WORDS),
      ...topics.flatMap((t) => [t.label, t.header, ...(t.strings ?? []), ...t.blocks.flatMap(labelsOf)]),
      `${G}EnlistmentWarningsText`, `${G}EnlistSoloAlliance`, `${G}EnlistmentEnlistingSoloTitle`, `${G}EnlistmentEnlistingCorpTitle`,
      `${G}EnlistmentEnlistingSoloText`, `${G}EnlistmentEnlistingCorpText`, `${G}EnlistmentOpenCharacterStandings`, `${G}EnlistmentCorporationStandings`,
      "UI/FactionWarfare/frontlinesDashboard/advantageTitleLabel", "UI/FactionWarfare/frontlinesDashboard/objectives/advantageTrackerDescription",
      "UI/FactionWarfare/OneSideHasAdvantageBonus"].filter(Boolean));
  });
  /** _get_filtered_topics, the enlistment panel's raise included (an empty list). */
  const shown = $derived.by(() => {
    const text = search.toLowerCase();
    if (text.length < 3) return topics;
    const out: Topic[] = [];
    for (const t of topics) {
      if (word(t.label).toLowerCase().includes(text)) { out.push(t); continue; }
      if (t.strings === null) return [];
      if (t.strings.some((s) => word(s).toLowerCase().includes(text))) out.push(t);
    }
    return out;
  });
  const topic = $derived(topics.find((t) => t.id === chosen) ?? null);
  // AdvantagePanel.ConstructAdvantageWidget: Amarr (attacker, AMARR_GOLD) 0.3, Minmatar (defender, MINMATAR_RED) 0.1, the
  // delta gauge 0.2 to the Amarr (its flat logo, OneSideHasAdvantageBonus as its hint).
  const AMARR = 500003;
  const deltaHint = $derived(plainText(formatTemplate($words.templates["UI/FactionWarfare/OneSideHasAdvantageBonus"] ?? "", { factionName: resolvedName($names.resolved, "owner", AMARR, ""), percentageText: "20%" } as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") })));
  $effect(() => { flow.requestNames([{ kind: "owner", id: AMARR }]); });
</script>

<div class="agp">
  <section class="agp-section agp-topics">
    <h3>{word("UI/Agency/PirateIncursions/Guides/GuideBrowserSectionTitle")}</h3>
    <input class="agp-search" type="search" value={search} oninput={(e) => (search = e.currentTarget.value)} />
    <div class="agp-scroll">
      {#each shown as t (t.id)}
        <button type="button" class="agp-topic" class:on={chosen === t.id} onclick={() => (chosen = t.id)}>{word(t.label)}</button>
      {/each}
    </div>
  </section>
  {#if topic}
    <section class="agp-guide">
      <h3 class="agp-header">{word(topic.header)}</h3>
      <div class="agp-main">
        {#each topic.blocks as b, n (n)}
          {#if "h" in b}<h3 class="agp-header agp-sub">{word(b.h)}</h3>
          {:else if "t" in b}<div class="agp-text"><LabelText markup={markup(b.t)} {followerOf} /></div>
          {:else if "img" in b}<div class="agp-img" style:margin-top={`${b.top ?? 8}px`}><img alt="" src={clientTexture(b.img)} style:width={`${b.w}px`} style:height={`${b.hgt}px`} /></div>
          {:else if "btn" in b}
            <div class="agp-btn" style:margin-top={`${b.top}px`}><button type="button" disabled={!b.open} onclick={() => b.open?.()}><img alt="" src={clientTexture(b.icon)} />{word(b.btn)}</button></div>
          {:else if "advantage" in b}
            <div class="agp-adv">
              <div class="agp-adv-text">
                <p class="agp-hl">{word(`${G}AdvantageTrackerTitle`)}</p>
                <div class="agp-tt"><LabelText markup={markup(`${G}AdvantageTrackerText`)} {followerOf} /></div>
              </div>
              <div class="agp-adv-gauges">
                <div class="agp-adv-title">{word("UI/FactionWarfare/frontlinesDashboard/advantageTitleLabel")} <span class="agp-info" title={word("UI/FactionWarfare/frontlinesDashboard/objectives/advantageTrackerDescription")}>ⓘ</span></div>
                <div class="agp-adv-row">
                  <div class="agp-bars">
                    <div class="agp-bar"><span style:width="30%" style:background="#E7B815"></span></div>
                    <div class="agp-bar"><span style:width="10%" style:background="#FE3743"></span></div>
                  </div>
                  <div class="agp-delta" title={deltaHint}>
                    <svg viewBox="0 0 58 58" width="58" height="58"><circle cx="29" cy="29" r="27" fill="none" stroke="rgb(255 255 255 / 0.15)" stroke-width="3.5" />
                      <circle cx="29" cy="29" r="27" fill="none" stroke="#fff" stroke-width="3.5" stroke-dasharray={`${0.2 * 2 * Math.PI * 27} ${2 * Math.PI * 27}`} transform="rotate(-90 29 29)" /></svg>
                    <span class="agp-logo" style:mask-image={`url(${clientTexture("res:/UI/Texture/Classes/Enlistment/logos/amarr.png")})`} style:-webkit-mask-image={`url(${clientTexture("res:/UI/Texture/Classes/Enlistment/logos/amarr.png")})`}></span>
                    <small>20%</small>
                  </div>
                </div>
              </div>
            </div>
          {:else if "enlist" in b}
            <div class="agp-warn"><img alt="" src={clientTexture("res:/UI/Texture/Icons/attention_icon.png")} title={word(`${G}EnlistmentWarningsText`)} /><div><LabelText markup={markup(`${G}EnlistSoloAlliance`)} {followerOf} /></div></div>
            <div class="agp-grid">
              <div class="agp-cell"><p>{word(`${G}EnlistmentEnlistingSoloTitle`)}</p><div><LabelText markup={markup(`${G}EnlistmentEnlistingSoloText`)} {followerOf} /></div>
                <button type="button" onclick={() => onOpenTab?.("characterSheet")}><img alt="" src={clientTexture("res:/UI/Texture/WindowIcons/charactersheet.png")} />{word(`${G}EnlistmentOpenCharacterStandings`)}</button></div>
              <div class="agp-cell"><p>{word(`${G}EnlistmentEnlistingCorpTitle`)}</p><div><LabelText markup={markup(`${G}EnlistmentEnlistingCorpText`)} {followerOf} /></div>
                <button type="button" onclick={async () => { if (await flow.agencyCorpStandings()) onOpenTab?.("corporation"); }}><img alt="" src={clientTexture("res:/UI/Texture/WindowIcons/corporation.png")} />{word(`${G}EnlistmentCorporationStandings`)}</button></div>
            </div>
          {:else if "card" in b}
            {@const g = AGENCY_GROUPS[b.card]}
            {#if g}
              <button type="button" class="agp-card" onclick={() => onShow?.(g.id)}>
                {#if g.card}<img alt="" src={clientTexture(g.card)} />{/if}
                <span><b>{word(g.name ?? "")}</b>{#if g.description}<small>{word(g.description)}</small>{/if}</span>
              </button>
            {/if}
          {/if}
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .agp { display: flex; gap: 20px; height: 100%; min-height: 0; box-sizing: border-box; }
  .agp-section { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.08); padding: 8px 10px; display: flex; flex-direction: column; min-height: 0; }
  .agp-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
  .agp-topics { width: 25%; flex: none; box-sizing: border-box; }
  .agp-search { height: 24px; box-sizing: border-box; margin-top: 5px; }
  .agp-scroll { flex: 1; min-height: 0; overflow: auto; margin-top: 5px; }
  .agp-topic { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; width: 100%; height: 30px; padding: 5px; font-size: 13px; white-space: pre; }
  .agp-topic:hover { background: rgb(255 255 255 / 0.06); }
  .agp-topic.on { background: rgb(255 255 255 / 0.12); }
  .agp-guide { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; background: rgb(0 0 0 / 0.25); }
  .agp-header { margin: 0 0 8px; padding: 6px 0; text-align: center; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid rgb(255 255 255 / 0.12); }
  .agp-sub { margin-top: 16px; }
  .agp-main { flex: 1; min-height: 0; overflow: auto; }
  .agp-text { padding: 0 8px; font-size: 13px; line-height: 1.35; }
  .agp-img { display: flex; justify-content: center; margin-bottom: 8px; }
  .agp-img img { max-width: 100%; height: auto !important; object-fit: contain; }
  .agp-btn { display: flex; align-items: center; min-height: 35px; padding-left: 8px; }
  .agp-btn button, .agp-cell button { display: inline-flex; align-items: center; gap: 6px; }
  .agp-btn img, .agp-cell img { width: 16px; height: 16px; }
  .agp-adv { display: flex; margin-top: 32px; min-height: 58px; }
  .agp-adv-text { flex: 1; padding: 0 96px 0 24px; font-size: 13px; }
  .agp-hl { margin: 5px; color: #fff; font-weight: 600; }
  .agp-tt { padding: 5px; }
  .agp-adv-gauges { width: 224px; flex: none; margin-left: 50px; }
  .agp-adv-title { height: 20px; font-size: 13px; }
  .agp-info { opacity: 0.7; cursor: help; }
  .agp-adv-row { display: flex; height: 58px; align-items: center; }
  .agp-bars { flex: 1; display: flex; flex-direction: column; justify-content: space-between; height: 34px; }
  .agp-bar { height: 8px; background: rgb(255 255 255 / 0.1); }
  .agp-bar span { display: block; height: 100%; }
  .agp-delta { position: relative; width: 54px; height: 58px; flex: none; }
  .agp-delta svg { position: absolute; left: -5px; top: 0; }
  .agp-logo { position: absolute; left: 7px; top: 6px; width: 32px; height: 32px; background: #E7B815; mask-size: contain; -webkit-mask-size: contain; }
  .agp-delta small { position: absolute; left: 0; right: 8px; bottom: 9px; text-align: center; font-size: 10px; }
  .agp-warn { display: flex; align-items: center; gap: 8px; margin-top: 16px; padding: 0 8px; font-size: 13px; }
  .agp-warn img { width: 16px; height: 16px; flex: none; cursor: help; }
  .agp-grid { display: flex; justify-content: center; gap: 128px; margin-top: 16px; font-size: 13px; }
  .agp-cell { min-width: 230px; max-width: 300px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
  .agp-cell p { margin: 0; }
  .agp-card { all: unset; cursor: pointer; display: flex; gap: 10px; align-items: center; margin: 8px 8px 0; padding: 6px; border: 1px solid rgb(255 255 255 / 0.12); background: rgb(0 0 0 / 0.3); max-width: 420px; }
  .agp-card:hover { border-color: rgb(255 255 255 / 0.3); }
  .agp-card img { width: 120px; height: 70px; object-fit: cover; }
  .agp-card span { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
</style>
