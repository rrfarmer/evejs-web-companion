<script lang="ts">
  import { getShipInfoOverview, loadTypeListsHolding, type ShipInfoOverview } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, type TemplateArguments } from "../bridge/clientWords.ts";
  import type { InfoSubject } from "../bridge/infoWindow.ts";
  import { bracketIcon, loadBrackets } from "../play/brackets.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import type { ReadableSignal } from "../store/signals.ts";
  import { formatIsk } from "./isk.ts";
  import InfoShipRequirements from "./InfoShipRequirements.svelte";
  import LabelText from "./LabelText.svelte";
  import { LINK_WORDS, linkFollowerOf } from "./linkFollowers.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import ShipInfoAttributes from "./ShipInfoAttributes.svelte";
  import ShipInfoPreview from "./ShipInfoPreview.svelte";
  import ShipTraits from "./ShipTraits.svelte";
  import ShowInfo from "./ShowInfo.svelte";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, subject, typeID, expanded, active, height, requirementsRequest }: {
    store: ClientStore; flow: AppFlow; subject: ReadableSignal<InfoSubject | null>;
    typeID: number; expanded: boolean; active: boolean; height: number; requirementsRequest?: number;
  } = $props();
  // svelte-ignore state_referenced_locally
  const { words, names, space } = store;
  // svelte-ignore state_referenced_locally
  const traits = flow.shipTraits;
  const NAV = [
    { id: "overview", label: "UI/InfoWindow/TabNames/Overview", title: "Overview", icon: "info" },
    { id: "attributes", label: "UI/InfoWindow/TabNames/Attributes", title: "Attributes", icon: "attributes" },
    { id: "skills", label: "UI/InfoWindow/TabNames/Skills", title: "Skills", icon: "skill_book" },
  ] as const;
  const MARKET = "UI/Inventory/ItemActions/ViewTypesMarketDetails";
  const PRICE = "UI/Inventory/EstPrice";
  const LICENSE = "UI/AcademyShips/WindowButton";
  const TRY = "UI/AcademyShips/TryForFree";
  const HINT = "UI/AcademyShips/ServiceInfoHint";
  const FACTION_FONT: Readonly<Record<number, string>> = {
    500003: "Ship Info Amarr", 500001: "Ship Info Caldari", 500004: "Ship Info Gallente", 500002: "Ship Info Minmatar",
  };
  let tab = $state<typeof NAV[number]["id"]>("overview");
  $effect(() => { if (requirementsRequest !== undefined) tab = "skills"; });
  let overview = $state<ShipInfoOverview | null | undefined>(undefined);
  let academy = $state(false);
  let bracketsReady = $state(false);
  let price = $state<number | null>(null);
  let showDescription = $state(false);
  let tallDescription = $state(false);
  let descriptionBox = $state<HTMLElement | undefined>(undefined);
  const title = $derived(resolvedName($names.resolved, "type", typeID, ""));
  const itemID = $derived($subject?.kind === "spaceObject" || $subject?.kind === "ship" ? $subject.itemID : null);
  const customName = $derived(itemID === null ? null :
    $space.snapshot?.entities.find(ship => ship.itemID === itemID)?.name ??
    resolvedName($names.resolved, "evelocation", itemID, ""));
  const classIcon = $derived(bracketsReady && overview ? bracketIcon({ typeID, groupID: overview.groupID, categoryID: 6 }) : null);
  const shipTraits = $derived($traits.traits.get(typeID) ?? null);
  const visibleTabs = $derived(NAV.filter(item => item.id !== "skills" || overview?.groupID !== 29));

  $effect(() => {
    const id = typeID;
    const options = flow.requestOptions();
    let current = true;
    flow.requestNames([{ kind: "type", id }, ...($subject?.kind === "ship" ? [{ kind: "evelocation" as const, id: $subject.itemID }] : [])]);
    flow.requestWords([...NAV.map(item => item.label), ...Object.keys(LINK_WORDS), MARKET, PRICE, TRY, LICENSE, HINT]);
    void flow.requestShipTraits([id]);
    void loadBrackets().then(() => { if (current) bracketsReady = true; }).catch(() => {});
    void getShipInfoOverview(id, options).then(profile => {
      if (!current) return;
      overview = profile;
      if (!profile) return;
      const ids = [profile.classNameID, profile.descriptionID, profile.quoteID, profile.quoteAuthorID, profile.tierNameID];
      flow.requestWords(ids.flatMap(value => value === null ? [] : [`#${value}`]));
      if (profile.groupID !== null && profile.classNameID === null) flow.requestNames([{ kind: "group", id: profile.groupID }]);
    }).catch(() => { if (current) overview = null; });
    void loadTypeListsHolding([id], [992], options).then(lists => { if (current) academy = lists[id]?.includes(992) === true; }).catch(() => {});
    void flow.cfgAveragePrices().then(prices => { if (current) price = prices?.get(id) ?? null; }).catch(() => {});
    return () => { current = false; };
  });
  $effect(() => {
    const node = descriptionBox;
    if (!node) return;
    const observer = new ResizeObserver(() => { tallDescription = node.offsetHeight > 78; });
    observer.observe(node);
    return () => observer.disconnect();
  });

  function markup(label: string, fallback = "", args: TemplateArguments = {}): string {
    return formatTemplate($words.templates[label] || fallback, args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") });
  }
  const word = (label: string, fallback = "") => plainText(markup(label, fallback));
  const messageMarkup = (id: number | null | undefined) => id ? ($words.templates[`#${id}`] ?? "") : "";
  const message = (id: number | null | undefined) => plainText(messageMarkup(id));
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, label => word(label, LINK_WORDS[label]), text, link => { void flow.followInventoryFilterLink(link); });
</script>

<div class="ship-info" class:expanded style:--content-height={`${Math.max(240, height)}px`}>
  <nav aria-label="Ship information">
    {#each visibleTabs as item (item.id)}
      <button type="button" aria-pressed={tab === item.id} onclick={() => tab = item.id}>
        <img src={clientTexture(`res:/UI/Texture/eveicon/system_icons/${item.icon}_16px.png`)} alt="" width="16" height="16" />
        {word(item.label, item.title)}
      </button>
    {/each}
    {#if overview?.marketGroupID}
      <button type="button" class="market" onclick={() => showMarketDetails(typeID)}>
        <img src={clientTexture("res:/UI/Texture/eveicon/system_icons/market_details_16px.png")} alt="" width="16" height="16" />
        {word(MARKET, "View Market Details")}
      </button>
    {/if}
  </nav>
  <div class="scene">
    <ShipInfoPreview {typeID} factionID={overview === undefined ? undefined : overview?.factionID ?? null} {expanded} {active} />
  </div>
  {#if tab === "overview"}
    <header class="basic">
      <div class="classification">
        {#if classIcon}<img src={classIcon} alt="" width="16" height="16" />{/if}
        <span>{message(overview?.classNameID) || resolvedName($names.resolved, "group", overview?.groupID ?? null, "")}</span>
        {#if overview?.tierIcon && message(overview.tierNameID)}
          <span class="tier"><img src={clientTexture(overview.tierIcon)} alt="" width="16" height="16" />
            {message(overview?.tierNameID)}
          </span>
        {/if}
      </div>
      {#if title || customName}
        <h2 style:font-family={overview?.factionID ? FACTION_FONT[overview.factionID] : undefined}>{customName || title}</h2>
        {#if customName && title && customName !== title}<p class="type-name">{title}</p>{/if}
      {/if}
      {#if academy}<p class="academy-free">{word(TRY, "Try For Free")}</p>{/if}
      {#if price !== null && price > 0}<p class="price">{word(PRICE, "Est. Price")} {formatIsk(price.toFixed(2))}</p>{/if}
    </header>
  {/if}
  <section class="ship-details" aria-label={word(NAV.find(item => item.id === tab)!.label, NAV.find(item => item.id === tab)!.title)}>
    {#if tab === "attributes"}
      <ShipInfoAttributes {typeID} {itemID} {flow} {store} />
    {:else if tab === "skills"}
      <InfoShipRequirements {store} {flow} {typeID} includeNavigation={false} />
    {:else}
      {#if overview === undefined}<p role="status">Reading ship information…</p>{/if}
      {#if message(overview?.quoteID)}
        <blockquote><LabelText markup={messageMarkup(overview?.quoteID)} {followerOf} /></blockquote>
      {/if}
      {#if message(overview?.quoteAuthorID)}<p class="quote-author">– {message(overview?.quoteAuthorID)}</p>{/if}
      {#if messageMarkup(overview?.descriptionID)}
        <div class="description" class:collapsed={!showDescription}>
          <div bind:this={descriptionBox}><LabelText markup={messageMarkup(overview?.descriptionID)} {followerOf} /></div>
        </div>
        {#if tallDescription}
          <button type="button" class="description-toggle" aria-expanded={showDescription} onclick={() => showDescription = !showDescription}>
            {showDescription ? "Show less" : "Show more"}
          </button>
        {/if}
      {/if}
      {#if shipTraits}
        <div class="ship-traits-section">
          <ShipTraits {store} {flow} traits={shipTraits} unitNameIDs={$traits.unitNameIDs} />
        </div>
      {/if}
      {#if academy}
        <section class="academy">
          <h3>{word(LICENSE, "Academy Ships")}</h3>
          <LabelText markup={markup(HINT, "", { color: "dce6ec" })} {followerOf} />
        </section>
      {/if}
      {#if $subject?.kind === "spaceObject"}<ShowInfo {store} {flow} {subject} shipLiveOnly />{/if}
    {/if}
  </section>
</div>

<style>
  @font-face { font-family: "Ship Info Amarr"; src: url('/client-res/ui/fonts/factions/amarr/cinzel-regular.ttf') format('truetype'); font-display: swap; }
  @font-face { font-family: "Ship Info Caldari"; src: url('/client-res/ui/fonts/factions/caldari/iceberg-regular.ttf') format('truetype'); font-display: swap; }
  @font-face { font-family: "Ship Info Gallente"; src: url('/client-res/ui/fonts/factions/gallente/afacadflux-regular.ttf') format('truetype'); font-display: swap; }
  @font-face { font-family: "Ship Info Minmatar"; src: url('/client-res/ui/fonts/factions/minmatar/spacemono-regular.ttf') format('truetype'); font-display: swap; }
  .ship-info { display: grid; grid-template-columns: minmax(0, 1fr); background: #090d14; color: #eef2f6; }
  .ship-info.expanded { grid-template-columns: 105px minmax(0, 1fr) minmax(240px, 44%); grid-template-rows: var(--content-height); }
  nav { display: flex; flex-wrap: wrap; gap: 3px; padding: 6px; background: #0c121a; z-index: 1; }
  nav button { display: flex; align-items: center; gap: 5px; text-align: left; padding: 6px; background: transparent; border: 1px solid transparent; }
  nav button:hover, nav button[aria-pressed="true"] { background: #8eb6d324; border-color: #8eb6d361; }
  .expanded nav { grid-row: 1; grid-column: 1; flex-direction: column; flex-wrap: nowrap; align-items: stretch; }
  .expanded .market { margin-top: auto; }
  .scene { grid-row: 2; height: 220px; min-width: 0; }
  .expanded .scene { grid-row: 1; grid-column: 2; height: var(--content-height); }
  .basic { padding: 10px 12px; }
  .expanded .basic { grid-row: 1; grid-column: 2; align-self: end; pointer-events: none; z-index: 1; padding: 36px 16px 22px; background: linear-gradient(transparent, #090d14ef 40%); }
  .basic h2 { margin: 4px 0 0; font-size: clamp(22px, 3.8vw, 34px); line-height: 1.08; text-transform: uppercase; overflow-wrap: anywhere; font-weight: 500; }
  .classification { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: #c2ceda; }
  .tier { display: inline-flex; align-items: center; gap: 3px; padding: 0 4px 0 0; background: #8ea4be2e; color: #ecf2f8; }
  .type-name, .price, .academy-free { margin: 5px 0 0; }
  .price { color: #b7c6d5; }
  .academy-free { color: #85d8a1; }
  .ship-details { min-width: 0; padding: 10px 12px; }
  .expanded .ship-details { grid-row: 1; grid-column: 3; overflow-y: auto; background: linear-gradient(90deg, #121e2c, #0a1019 40%); }
  blockquote { margin: 6px 0; font-size: 17px; line-height: 1.28; }
  .quote-author { margin: 4px 0 8px 18px; color: #b7c6d5; }
  .description { padding-top: 8px; border-top: 1px solid #ffffff21; color: #cbd6df; }
  .description.collapsed { max-height: 86px; overflow: hidden; }
  .description-toggle { margin-top: 5px; padding: 4px 8px; }
  .ship-traits-section, .academy { margin-top: 12px; }
  .academy h3 { margin: 0 0 4px; font-size: 13px; color: #4fd0ca; }
</style>
