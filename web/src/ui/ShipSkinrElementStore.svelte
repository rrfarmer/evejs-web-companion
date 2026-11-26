<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ShipSkinrComponentOffer } from "../bridge/shipSkinrMarket.ts";
  import type { ShipSkinrSequenceComponent } from "../bridge/shipSkinrSequencing.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import ShipSkinrBuy from "./ShipSkinrBuy.svelte";
  import ShipSkinrElementPreview from "./ShipSkinrElementPreview.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const prefix = "UI/Personalization/ShipSkins/SKINR/";
  const labels = {
    title: [prefix + "Studio/DesignElements", "Design Elements"],
    nanocoatings: [prefix + "Studio/Nanocoatings", "Basic Nanocoatings"],
    metallics: [prefix + "Studio/Metallics", "Metallic Nanocoatings"],
    patterns: [prefix + "Studio/Patterns", "Patterns"],
    finish: ["UI/Personalization/ShipSkins/Finish", "Finish"],
    any: ["UI/Common/Any", "Any"],
    matte: [prefix + "FinishMatte", "Matte"],
    satin: [prefix + "FinishSatin", "Satin"],
    gloss: [prefix + "FinishGloss", "Gloss"],
    sort: ["UI/Common/SortBy", "Sort By"],
    name: ["UI/Common/Name", "Name"],
    nameReverse: ["UI/Inventory/NameReversed", "Name Reversed"],
    price: ["UI/Market/Marketbase/Price", "Price"],
    priceReverse: ["UI/Market/Marketbase/PriceReversed", "Price Reversed"],
    shade: ["UI/Common/ColorShade", "Color Shade"],
    shadeReverse: ["UI/Common/ColorShadeReversed", "Color Shade Reversed"],
    buy: [prefix + "Studio/BuyElement", "Buy Element"],
    market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
  } as const;
  const sections = ["nanocoatings", "metallics", "patterns"] as const;
  const finishes = ["any", "matte", "satin", "gloss"] as const;
  const orders = ["name", "nameReverse", "price", "priceReverse", "shade", "shadeReverse"] as const;
  const pageSize = 20;
  const limitedMs = 60 * 24 * 60 * 60 * 1000;
  type Section = typeof sections[number];
  type Row = ShipSkinrComponentOffer & {
    section: Section; nameID: number; shade: number | null; finish: "matte" | "satin" | "gloss" | null;
    component: ShipSkinrSequenceComponent & { bundle: number; uses: number }; image?: string;
  };
  const station = $derived(store.station);
  const words = $derived(store.words);
  const pilot = $derived($station.online?.characterID);
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const name = (row: Row) => plainText($words.templates[`#${row.nameID}`] ?? String(row.typeID));
  const price = (row: Row) => `${row.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${row.currency}`;
  let rows = $state.raw<readonly Row[]>([]);
  let section = $state<Section>("nanocoatings");
  let finish = $state<typeof finishes[number]>("any");
  let sort = $state<typeof orders[number]>("name");
  let page = $state(1);
  let refresh = $state(0);
  let loading = $state(false);
  let error = $state("");
  let notice = $state("");
  let selected = $state<string | null>(null);
  let buying = $state.raw<Row | null>(null);
  const visible = $derived.by(() => {
    const time = Date.now();
    const rank = (row: Row) => row.discount > 0 ? 1 : row.expires - time < limitedMs ? 0 : 2;
    return rows.filter(row => row.section === section && (finish === "any" || row.finish === finish)).sort((a, b) => {
      const priority = rank(a) - rank(b);
      if (priority) return priority;
      if (sort === "price" || sort === "priceReverse") return (a.amount - b.amount) * (sort === "price" ? 1 : -1);
      if (sort === "shade" || sort === "shadeReverse") {
        const left = a.shade ?? Number.MAX_SAFE_INTEGER, right = b.shade ?? Number.MAX_SAFE_INTEGER;
        return (left - right) * (sort === "shade" ? 1 : -1);
      }
      return name(a).localeCompare(name(b)) * (sort === "name" ? 1 : -1);
    });
  });
  const pageCount = $derived(Math.max(1, Math.ceil(visible.length / pageSize)));
  const pageRows = $derived(visible.slice((page - 1) * pageSize, page * pageSize));
  const detail = $derived(pageRows.find(row => row.id === selected));
  let lastPilot: number | undefined;

  $effect(() => { flow.requestWords(Object.values(labels).map(([path]) => path)); });
  $effect(() => {
    const character = pilot;
    void refresh;
    if (lastPilot !== character) {
      lastPilot = character;
      buying = null;
      notice = "";
    }
    rows = [];
    error = "";
    loading = !!character;
    if (!character) return;
    let current = true;
    void Promise.all([flow.loadShipSkinrComponentOffers(), import("../bridge/shipSkinrStoreItems.ts"),
      import("../bridge/shipSkinrCoatingsData.ts"), import("../bridge/shipSkinrPatternsData.ts"),
      import("../bridge/shipSkinrElementMarketData.ts")]).then(([offers, { SHIP_SKINR_STORE_ITEMS },
        { SHIP_SKINR_COATINGS }, { SHIP_SKINR_PATTERNS }, { SHIP_SKINR_ELEMENT_MARKET }]) => {
      if (!current) return;
      const items = new Map(Object.entries(SHIP_SKINR_STORE_ITEMS).flatMap(([id, [finish, products]]) =>
        products.map(([typeID, uses]) => [typeID, { id: Number(id), finish, uses }] as const)));
      const coatings = new Map(SHIP_SKINR_COATINGS.components.map(row => [row.id, row]));
      const patterns = new Map(SHIP_SKINR_PATTERNS.components.map(row => [row.id, row]));
      rows = offers.flatMap(offer => {
        const item = items.get(offer.typeID);
        if (!item) return [];
        const coating = coatings.get(item.id);
        const pattern = patterns.get(item.id);
        if (!coating && !pattern) return [];
        const section: Section = pattern ? "patterns" : coating?.category === 3 ? "metallics" : "nanocoatings";
        return [{ ...offer, section, finish: item.finish, nameID: pattern?.nameID ?? coating?.nameID ?? 0,
          shade: SHIP_SKINR_ELEMENT_MARKET[item.id]?.[0] ?? null,
          image: pattern?.icon ?? coating?.swatch,
          component: { id: item.id, kind: pattern ? "pattern" : "coating", bundle: offer.bundle, uses: item.uses } }];
      });
      flow.requestWords([...new Set(rows.map(row => `#${row.nameID}`))]);
    }).catch(cause => { if (current) error = panelErrorWords(cause); }).finally(() => {
      if (current) loading = false;
    });
    return () => { current = false; };
  });

  function choose(next: Section) {
    section = next;
    finish = "any";
    firstPage();
  }

  function firstPage() {
    page = 1;
    selected = null;
  }

  function purchased(quantity: number, title: string, activated: boolean) {
    if (!buying) return;
    const copies = (quantity * buying.bundle).toLocaleString();
    notice = activated ? `Activated ${title} in Collection.` : `Delivered ${copies} × ${title} to your item hangar.`;
    buying = null;
    firstPage();
    refresh++;
  }
</script>

<section class="element-store" aria-label={word("title")}>
  <nav aria-label={word("title")}>
    {#each sections as entry (entry)}
      <button type="button" aria-pressed={section === entry} onclick={() => choose(entry)}>{word(entry)}</button>
    {/each}
  </nav>
  <div class="filters">
    {#if section === "nanocoatings"}
      <label>{word("finish")} <select bind:value={finish} onchange={firstPage}>
        {#each finishes as entry (entry)}<option value={entry}>{word(entry)}</option>{/each}
      </select></label>
    {/if}
    <label>{word("sort")} <select bind:value={sort} onchange={firstPage}>
      {#each orders as entry (entry)}<option value={entry}>{word(entry)}</option>{/each}
    </select></label>
    <button type="button" disabled={loading || !pilot} onclick={() => { firstPage(); refresh++; }}>Refresh</button>
  </div>
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if loading}<p>Loading offers…</p>
  {:else if error}<p role="alert">{error}</p>
  {:else if !visible.length}<p>No design elements for sale.</p>{/if}
  <div class="element-offers">
    <ul>
      {#each pageRows as row (row.id)}
        <li><button type="button" data-element-type={row.typeID} aria-pressed={detail?.id === row.id}
          onclick={() => { selected = row.id; notice = ""; }}>
          {#if row.image}<img src={row.image} alt="" />{/if}
          <span><strong>{name(row)}</strong>
            <small>{row.component.uses < 0 ? "Unlimited use" : "Limited use"} · {price(row)}</small>
          </span>
        </button></li>
      {/each}
    </ul>
    {#if detail}
      <article aria-label={name(detail)}>
        <h4>{name(detail)}</h4>
        <ShipSkinrElementPreview {store} {flow} element={detail.component} active={!buying} />
        <dl>
          <dt>License</dt><dd>{detail.component.uses < 0 ? "Unlimited use" : "Limited use"}</dd>
          <dt>Bundle size</dt><dd>{detail.bundle.toLocaleString()}</dd>
          <dt>{word("price")}</dt><dd>{price(detail)}</dd>
          {#if detail.discount > 0}<dt>Discount</dt><dd>{detail.discount}%</dd>{/if}
        </dl>
        <div class="actions">
          <button type="button" onclick={() => showMarketDetails(detail?.typeID ?? 0)}>{word("market")}</button>
          <button type="button" onclick={() => { buying = detail ?? null; }}>{word("buy")}</button>
        </div>
      </article>
    {/if}
  </div>
  {#if pageCount > 1}
    <nav class="pages" aria-label="Design element pages">
      <button type="button" disabled={page === 1} onclick={() => { page--; selected = null; }}>Previous</button>
      <span>Page {page} of {pageCount}</span>
      <button type="button" disabled={page === pageCount} onclick={() => { page++; selected = null; }}>Next</button>
    </nav>
  {/if}
</section>
{#if buying}
  <ShipSkinrBuy {store} {flow} name={name(buying)} listing={{ ...buying, quantity: 5000 }} component={buying.component}
    onClose={() => { buying = null; }} onPurchased={purchased} />
{/if}

<style>
  .element-store { padding: 10px 18px 18px; }
  nav, .filters, .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .filters { margin: 10px 0; gap: 10px; }
  label, li button { display: flex; align-items: center; gap: 6px; }
  button[aria-pressed="true"] { border-color: #94b8c2; }
  .element-offers { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; }
  ul { flex: 1 1 205px; list-style: none; padding: 0; margin: 0; max-height: 360px; overflow: auto; }
  li { margin-bottom: 4px; }
  li button { width: 100%; text-align: start; }
  li img { width: 28px; height: 28px; object-fit: contain; }
  small { display: block; }
  small, dt { color: #a4bfc6; }
  article { flex: 1 1 220px; border: 1px solid #344952; padding: 12px; }
  h4, dl, dd { margin: 0; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 6px; padding: 12px 0; }
  dd { text-align: end; }
  .pages { justify-content: center; margin-top: 8px; }
</style>
