<script lang="ts">
  import { onMount } from "svelte";
  import { bridgeAsk } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { decodeStoreOffers, IN_GAME_STORE_ID, storeEntries, storeEntryID, storeFieldText } from "../bridge/newEdenStore.ts";
  import { isListValue, readDictEntry } from "../bridge/wire.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  type StoreRequest = { tag: "gametime" | "plex" } | { typeID: number };
  let { store, flow, categoryRequest = null, openParagonHub }: { store: ClientStore; flow: AppFlow;
    categoryRequest?: StoreRequest | null; openParagonHub?: () => void } = $props();
  const words = $derived(store.words);
  const station = $derived(store.station);
  const ribbon = "UI/VirtualGoodsStore/SKINR/Ribbon";
  const description = "UI/VirtualGoodsStore/SKINR/Description";
  const shipSkinsRoot = 1; // ROOT_CATEGORY_SHIP_SKINS in aurumStoreContainer.py.
  type Category = { id: number; parentID: number | null; name: string; tags: string[] };
  let catalogue = $state<{ offers: ReturnType<typeof decodeStoreOffers>; categories: Category[] } | null>(null);
  let selectedCategory = $state<number | null>(null);
  let loading = $state(false);
  let error = $state("");
  let appliedRequest: typeof categoryRequest = null;
  let categoryUnavailable = $state(false);
  let selectedProduct = $state<number | null>(null);
  const offers = $derived(catalogue?.offers.filter(offer => (selectedCategory === null || offer.categories.includes(selectedCategory)) &&
    (selectedProduct === null || offer.productTypes.includes(selectedProduct))) ?? []);
  const selected = $derived(catalogue?.categories.find(row => row.id === selectedCategory));
  const parent = $derived(catalogue?.categories.find(row => row.id === selected?.parentID));
  const isSkinCategory = (category: Category | undefined) => category?.id === shipSkinsRoot || category?.tags.includes("skins");
  const showSkinrBanner = $derived(!!openParagonHub && !!$station.online?.characterID && !!catalogue &&
    (isSkinCategory(selected) || isSkinCategory(parent) || (selectedCategory === null && selectedProduct === null && !categoryUnavailable)));
  $effect(() => { if (openParagonHub) flow.requestWords([ribbon, description]); });

  $effect(() => {
    const requested = categoryRequest;
    if (requested === appliedRequest || !catalogue) return;
    appliedRequest = requested;
    const tag = requested && "tag" in requested ? requested.tag : null;
    const category = tag ? catalogue.categories.find(row => row.tags.includes(tag)) : null;
    selectedCategory = category?.id ?? null;
    selectedProduct = requested && "typeID" in requested ? requested.typeID : null;
    categoryUnavailable = !!tag && !category;
  });

  async function load() {
    if (loading) return;
    loading = true;
    error = "";
    try {
      const read = bridgeAsk(flow.requestOptions());
      const [rawCategories, rawOffers] = await Promise.all([
        read("storeManager", "get_categories", [IN_GAME_STORE_ID]),
        read("storeManager", "get_offers", [IN_GAME_STORE_ID]),
      ]);
      if (!isListValue(rawCategories) || !isListValue(rawOffers)) throw new Error("The store catalogue could not be read.");
      const categories = rawCategories.items.flatMap((entry) => {
        const categoryID = storeEntryID(entry), title = storeFieldText(entry, "name");
        const tags = storeEntries(readDictEntry(entry, "tags")).filter(tag => typeof tag === "string");
        const parent = readDictEntry(entry, "parentId");
        const parentID = typeof parent === "number" && Number.isSafeInteger(parent) && parent > 0 ? parent :
          storeEntryID(readDictEntry(entry, "parent"));
        return categoryID === null || !title ? [] : [{ id: categoryID, parentID, name: title, tags }];
      });
      catalogue = { offers: decodeStoreOffers(rawOffers), categories };
      if (selectedCategory !== null && !categories.some(category => category.id === selectedCategory)) selectedCategory = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  onMount(() => { void load(); });
</script>

<div class="new-eden-store" data-store-product={selectedProduct}>
  <div class="store-controls">
    {#if catalogue?.categories.length}
      <label>Category <select bind:value={selectedCategory} onchange={() => { categoryUnavailable = false; selectedProduct = null; }}>
        <option value={null}>All offers</option>
        {#each catalogue.categories as category (category.id)}
          <option value={category.id}>{category.name}</option>
        {/each}
      </select></label>
    {/if}
    {#if selectedProduct !== null}<button type="button" onclick={() => (selectedProduct = null)}>Show all offers</button>{/if}
    <button type="button" disabled={loading} onclick={() => void load()}>Refresh catalogue</button>
  </div>
  {#if showSkinrBanner}
    <button type="button" class="paragon-banner" onclick={openParagonHub}>
      <img src={clientTexture("res:/UI/texture/classes/paintTool/paragon_logo.png")} alt="" width="34" height="32" />
      <span><strong>{plainText($words.templates[ribbon] || "Paragon Hub")}</strong>
        {#if $words.templates[description]}<span>{plainText($words.templates[description])}</span>{/if}
      </span>
    </button>
  {/if}
  {#if loading && catalogue === null}<p role="status">Loading store catalogue…</p>{/if}
  {#if categoryUnavailable}<p role="status">{categoryRequest && "tag" in categoryRequest && categoryRequest.tag === "plex" ? "PLEX offers are unavailable in this catalogue." : "Game time is unavailable in this catalogue."}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if catalogue !== null && offers.length === 0}
    <p role="status">{selectedProduct === 63188 ? "No Multiple Character Training offers are available." :
      selectedProduct !== null ? "No offers for this item are available." :
        selectedCategory === null ? "No offers are available from this server." : "No offers in this category."}</p>
  {/if}
  <ul class="offers" aria-label="Store offers">
    {#each offers as offer (offer.id)}
      <li data-offer-id={offer.id}>
        <h2>{offer.name}</h2>
        {#if offer.description}<p>{offer.description}</p>{/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .new-eden-store { padding: 16px; }
  .store-controls { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin-bottom: 14px; }
  .paragon-banner { width: 100%; display: flex; align-items: center; gap: 14px; margin-bottom: 14px; padding: 14px; text-align: start; border-color: #5c9da8; background: #5c9da81a; }
  .paragon-banner img { flex: none; }
  .paragon-banner strong, .paragon-banner span { display: block; }
  .paragon-banner strong + span { margin-top: 4px; }
  .offers { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); padding: 0; margin: 0; gap: 10px; }
  .offers li { padding: 12px; border: 1px solid var(--line, #39444b); }
  h2 { font-size: 1rem; margin: 0; }
  li p { margin: 6px 0 0; }
  [role="alert"] { color: #fc9c95; }
</style>
