<script lang="ts">
  import { untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { getShipTreeCatalogue } from "../app/api.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ShipSkinrDesign } from "../bridge/shipSkinr.ts";
  import type { ShipSkinrBrowseQuery } from "../bridge/shipSkinrMarket.ts";
  import type { ShipTreeHull } from "../bridge/shipTree.ts";
  import { formatDuration } from "../bridge/skills.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import ShipSkinrBuy from "./ShipSkinrBuy.svelte";
  import ShipSkinrPreview from "./ShipSkinrPreview.svelte";
  import ShipSkinrShare from "./ShipSkinrShare.svelte";
  import ShipSkinrMyListings from "./ShipSkinrMyListings.svelte";

  let { store, flow, linked }: { store: ClientStore; flow: AppFlow; linked: ReturnType<AppFlow["takeShipSkinrListingLink"]> } = $props();
  type Row = Awaited<ReturnType<AppFlow["browseShipSkinrListings"]>>["listings"][number] & { design: ShipSkinrDesign | null };
  const prefix = "UI/Personalization/ShipSkins/SKINR/";
  const labels = {
    active: ["Studio/ActiveShipSKINs", "{shipName} SKINs"],
    all: ["Studio/AllSKINs", "All SKINs"],
    corporation: ["Store/CorpSkins", "Corporation SKINs"],
    alliance: ["Store/AllianceSkins", "Alliance SKINs"],
    targeted: ["Store/TargetedAtMe", "Exclusive Listings"],
    owned: ["Store/MyListings", "Listed By Me"],
    sooner: ["Store/TimeLeft", "Time Left"],
    later: ["Store/TimeLeftReversed", "Time Left (highest first)"],
    listedBy: ["Store/ListedBy", "Listed By"],
    anyone: ["Store/ListedByAnyone", "Anyone"],
    corpBrand: ["Store/ListedByBrandManager", "Corporation Brand Manager"],
    corpMember: ["Store/ListedByCorpMember", "Corporation Member"],
    allianceBrand: ["Store/ListedByAnyBrandManager", "Alliance Brand Manager"],
    allianceMember: ["Store/ListedByAllianceMember", "Alliance Member"],
    buy: ["Studio/BuySkin", "Buy SKIN"],
  } as const;
  const sections = ["active", "all", "corporation", "alliance", "targeted", "owned"] as const;
  type Section = typeof sections[number];
  const targets = { active: "public", all: "public", corporation: "my_corporation",
    alliance: "my_alliance", targeted: "my_character" } as const;
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const characters = $derived(store.character);
  const pilot = $derived($station.online?.characterID);
  const owner = $derived($characters.characters.find(row => row.characterID === pilot));
  const sessionAlliance = $derived($station.online?.allianceID);
  const alliance = $derived(sessionAlliance === undefined ? owner?.allianceID : sessionAlliance);
  const activeHull = $derived($flight.status?.shipTypeID ?? owner?.shipTypeID);
  const word = (key: keyof typeof labels) => {
    const template = $words.templates[prefix + labels[key][0]] ?? labels[key][1];
    if (key !== "active") return plainText(template);
    const ship = catalogue.find(row => row.typeID === activeHull);
    const shipName = ship ? hullName(ship) : "Active Ship";
    return plainText(formatTemplate(template, { shipName }, { nameOf: () => "" }));
  };
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, String(id));
  const hullName = (hull: ShipTreeHull) => plainText($words.templates[`#${hull.nameID}`] ?? typeName(hull.typeID));
  const skinName = (row: Row) => row.design?.name || "Design unavailable";
  const price = (row: Row) => `${row.amount.toLocaleString()} ${row.currency}`;
  let section = $state<Section>("all");
  let hull = $state(0);
  let membership = $state<0 | 1 | 2>(0);
  let ascending = $state(false);
  let catalogue = $state.raw<readonly ShipTreeHull[]>([]);
  const hulls = $derived([...catalogue].sort((a, b) => hullName(a).localeCompare(hullName(b))));
  const membershipFilter = $derived(section === "corporation" || section === "alliance");
  const allowHull = $derived(section === "all" || membershipFilter);
  const query = $derived<ShipSkinrBrowseQuery | null>(section === "owned" || (section === "active" && !activeHull) ||
    (section === "alliance" && !alliance) ? null : {
    target: targets[section], hull: section === "active" ? activeHull : allowHull ? hull : undefined,
    membership: membershipFilter && membership ? membership : undefined, ascending,
  });
  let cursors = $state.raw<readonly (string | undefined)[]>([undefined]);
  let nextToken = $state<string | undefined>();
  let rows = $state.raw<readonly Row[]>([]);
  let pinned = $state.raw<Row | null>(null);
  let selected = $state<string | undefined>();
  let purchasing = $state.raw<Row | null>(null);
  let purchaseNotice = $state("");
  const pinnedRow = $derived(section === "all" && !hull && cursors.length === 1 ? pinned : null);
  const shown = $derived(pinnedRow ? [pinnedRow, ...rows.filter(row => row.id !== pinnedRow?.id)] : rows);
  const detail = $derived(shown.find(row => row.id === (selected ?? pinnedRow?.id)));
  let refresh = $state(0);
  let loading = $state(false);
  let error = $state("");
  let hullError = $state("");
  let lastQuery: ShipSkinrBrowseQuery | null = null;
  let lastPilot: number | undefined;

  $effect(() => { pinned = linked; });
  $effect(() => {
    if (section === "alliance" && !alliance) choose("all");
  });

  $effect(() => {
    flow.requestWords(Object.values(labels).map(([path]) => prefix + path));
    let current = true;
    void getShipTreeCatalogue(flow.requestOptions()).then(data => {
      if (!current) return;
      if (!data) throw new Error("Ship hulls unavailable.");
      catalogue = data.ships.filter(row => !row.academy);
      flow.requestWords(catalogue.flatMap(row => row.nameID ? [`#${row.nameID}`] : []));
      flow.requestNames(catalogue.filter(row => !row.nameID).map(row => ({ kind: "type", id: row.typeID })));
    }).catch(cause => { if (current) hullError = panelErrorWords(cause); });
    return () => { current = false; };
  });

  $effect(() => {
    const character = pilot;
    const terms = query;
    void refresh;
    const reset = terms !== lastQuery || character !== lastPilot;
    if (character !== lastPilot) {
      if (lastPilot !== undefined) pinned = null;
      purchasing = null;
      purchaseNotice = "";
    }
    lastQuery = terms;
    lastPilot = character;
    const token = reset ? undefined : untrack(() => cursors.at(-1));
    if (reset) cursors = [undefined];
    selected = undefined;
    nextToken = undefined;
    error = "";
    rows = [];
    loading = !!character && !!terms;
    if (!character || !terms) return;
    let current = true;
    void flow.browseShipSkinrListings({ ...terms, token }).then(async result => {
      if (!current) return;
      const designs = await Promise.all([...new Set(result.listings.map(row => row.hex))].map(async hex =>
        [hex, await flow.loadShipSkinrDesign(hex).catch(() => null)] as const));
      if (!current) return;
      const byHex = new Map(designs);
      rows = result.listings.map(row => ({ ...row, design: byHex.get(row.hex) ?? null }));
      nextToken = result.token;
    }).catch(cause => { if (current) error = panelErrorWords(cause); }).finally(() => {
      if (current) loading = false;
    });
    return () => { current = false; };
  });

  function choose(next: Section) {
    if (section === next) return;
    pinned = null;
    section = next;
    hull = 0;
    membership = 0;
  }

  function move(delta: -1 | 1) {
    if (loading) return;
    if (delta < 0 && cursors.length > 1) cursors = cursors.slice(0, -1);
    else if (delta > 0 && nextToken) cursors = [...cursors, nextToken];
    else return;
    refresh++;
  }

  function purchased(quantity: number, name: string) {
    if (pinned && pinned.id === purchasing?.id) {
      pinned = pinned.quantity > quantity ? { ...pinned, quantity: pinned.quantity - quantity } : null;
    }
    purchasing = null;
    purchaseNotice = `Added ${quantity.toLocaleString()} × ${name} to Collection.`;
    refresh++;
  }
</script>

<nav class="store-sections" aria-label="Paragon Hub sections">
  {#each sections as key (key)}
    {#if (key !== "alliance" || alliance) && (key !== "active" || activeHull)}
      <button type="button" aria-pressed={section === key} onclick={() => choose(key)}>{word(key)}</button>
    {/if}
  {/each}
</nav>
{#if purchaseNotice}<p class="purchase-notice" role="status">{purchaseNotice}</p>{/if}
{#if section === "owned"}
  <ShipSkinrMyListings {store} {flow} />
{:else}
  <section class="store-listings" aria-label={word(section)}>
    <div class="filters">
      {#if allowHull}
        <label>Ship <select bind:value={hull} disabled={!hulls.length}>
          <option value={0}>All Ships</option>
          {#each hulls as ship (ship.typeID)}<option value={ship.typeID}>{hullName(ship)}</option>{/each}
        </select></label>
      {/if}
      {#if membershipFilter}
        <label>{word("listedBy")} <select bind:value={membership}>
          <option value={1}>{word(section === "corporation" ? "corpBrand" : "allianceBrand")}</option>
          <option value={2}>{word(section === "corporation" ? "corpMember" : "allianceMember")}</option>
          <option value={0}>{word("anyone")}</option>
        </select></label>
      {/if}
      <label>Sort By <select bind:value={ascending}>
        <option value={false}>{word("later")}</option>
        <option value={true}>{word("sooner")}</option>
      </select></label>
      <button type="button" disabled={loading || !query} onclick={() => { pinned = null; cursors = [undefined]; refresh++; }}>Refresh</button>
    </div>
    {#if allowHull && hullError}<p role="status">{hullError}</p>{/if}
    {#if loading}<p>Loading listings…</p>
    {:else if error}<p role="alert">{error}</p>
    {:else if !shown.length}<p>{section === "active" && !activeHull ? "No active ship." : "No listings."}</p>{/if}
    <div class="browse-body">
      <ul>
        {#each shown as row (row.id)}
          <li><button type="button" aria-pressed={detail?.id === row.id} onclick={() => { selected = row.id; }}>
            <strong>{skinName(row)}</strong>
            <span>{row.design ? typeName(row.design.shipTypeID) : "—"} · {price(row)}</span>
          </button></li>
        {/each}
      </ul>
      {#if detail}
        <article aria-label={skinName(detail)}>
          <h4>{skinName(detail)}</h4>
          {#if detail.design}<ShipSkinrPreview {flow} design={detail.design} active={!purchasing} />{/if}
          <dl>
            {#if detail.design}<dt>Ship</dt><dd>{typeName(detail.design.shipTypeID)}</dd>
              <dt>Tier</dt><dd>{detail.design.tier}</dd>{/if}
            {#if detail.seller}<dt>{word("listedBy")}</dt>
              <dd>{resolvedName($names.resolved, "character", detail.seller, String(detail.seller))}</dd>{/if}
            <dt>Price per SKIN</dt><dd>{price(detail)}</dd>
            <dt>Quantity remaining</dt><dd>{detail.quantity.toLocaleString()}</dd>
            <dt>{word("sooner")}</dt>
            <dd>{Number.isFinite(detail.expires) ? formatDuration(Math.max(0, detail.expires - Date.now())) : "—"}</dd>
          </dl>
          {#if detail.seller === pilot}
            <button type="button" onclick={() => choose("owned")}>{word("owned")}</button>
          {:else}
            <button type="button" disabled={!detail.design} onclick={() => {
              purchaseNotice = "";
              purchasing = detail;
            }}>{word("buy")}</button>
          {/if}
          {#key detail.id}<ShipSkinrShare {store} {flow} id={detail.id} name={skinName(detail)} />{/key}
        </article>
      {/if}
    </div>
    {#if cursors.length > 1 || nextToken}
      <nav class="pages" aria-label="Listing pages">
        <button type="button" disabled={cursors.length < 2 || loading} onclick={() => move(-1)}>Previous</button>
        <span>Page {cursors.length}</span>
        <button type="button" disabled={!nextToken || loading} onclick={() => move(1)}>Next</button>
      </nav>
    {/if}
  </section>
{/if}
{#if purchasing?.design}
  <ShipSkinrBuy {store} {flow} listing={purchasing} name={skinName(purchasing)} tier={purchasing.design.tier}
    onClose={() => { purchasing = null; }} onPurchased={purchased} />
{/if}

<style>
  .store-sections, .filters, .pages { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .store-sections { padding: 10px 18px 0; }
  .store-listings { padding: 10px 18px 18px; }
  .filters { gap: 10px; margin-bottom: 10px; }
  label { display: flex; align-items: center; gap: 5px; }
  button[aria-pressed="true"] { border-color: #94b8c2; }
  .browse-body { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; }
  ul { flex: 1 1 205px; list-style: none; padding: 0; margin: 0; max-height: 360px; overflow: auto; }
  li { margin-bottom: 4px; }
  li button { display: grid; width: 100%; text-align: start; gap: 3px; }
  li span, dt { color: #a4bfc6; }
  article { flex: 1 1 220px; border: 1px solid #344952; padding: 12px; }
  h4, dl, dd { margin: 0; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 6px; padding-top: 12px; }
  dd { text-align: end; }
  article > button { margin-top: 10px; }
  .purchase-notice { margin: 10px 18px 0; }
  .pages { margin-top: 8px; justify-content: center; }
</style>
