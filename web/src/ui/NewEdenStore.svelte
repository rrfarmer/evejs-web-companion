<script lang="ts">
  import { onMount } from "svelte";
  import { bridgeAsk } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { isListValue, readDictEntry, type JsonValue } from "../bridge/wire.ts";

  type StoreRequest = { tag: "gametime" | "plex" } | { typeID: number };
  let { flow, categoryRequest = null }: { flow: AppFlow; categoryRequest?: StoreRequest | null } = $props();
  const storeID = 4;
  type Category = { id: number; name: string; tags: string[] };
  type Offer = { id: number; name: string; description: string; categories: number[]; productTypes: number[] };
  let catalogue = $state<{ offers: Offer[]; categories: Category[] } | null>(null);
  let selectedCategory = $state<number | null>(null);
  let loading = $state(false);
  let error = $state("");
  let appliedRequest: typeof categoryRequest = null;
  let categoryUnavailable = $state(false);
  let selectedProduct = $state<number | null>(null);
  const offers = $derived(catalogue?.offers.filter(offer => (selectedCategory === null || offer.categories.includes(selectedCategory)) &&
    (selectedProduct === null || offer.productTypes.includes(selectedProduct))) ?? []);

  const entries = (value: unknown): readonly JsonValue[] => isListValue(value) ? value.items : [];
  const name = (value: unknown, key: string): string => {
    const field = readDictEntry(value, key);
    return typeof field === "string" ? plainText(field).trim() : "";
  };
  const id = (value: unknown): number | null => {
    const field = readDictEntry(value, "id");
    return typeof field === "number" && Number.isSafeInteger(field) && field > 0 ? field : null;
  };
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
        read("storeManager", "get_categories", [storeID]),
        read("storeManager", "get_offers", [storeID]),
      ]);
      if (!isListValue(rawCategories) || !isListValue(rawOffers)) throw new Error("The store catalogue could not be read.");
      const categories = rawCategories.items.flatMap((entry) => {
        const categoryID = id(entry), title = name(entry, "name");
        const tags = entries(readDictEntry(entry, "tags")).filter(tag => typeof tag === "string");
        return categoryID === null || !title ? [] : [{ id: categoryID, name: title, tags }];
      });
      const listed = rawOffers.items.flatMap((entry) => {
        const offerID = id(entry), title = name(entry, "name");
        const products = entries(readDictEntry(entry, "products"));
        if (offerID === null || !title || products.length === 0) return [];
        const groups = entries(readDictEntry(entry, "categories")).map(id);
        const productTypes = products.flatMap(product => {
          const typeID = readDictEntry(product, "typeId");
          return typeof typeID === "number" && Number.isSafeInteger(typeID) ? [typeID] : [];
        });
        return [{ id: offerID, name: title, description: name(entry, "description"), categories: groups.filter(group => group !== null), productTypes }];
      });
      catalogue = { offers: listed, categories };
      if (selectedCategory !== null && !categories.some(category => category.id === selectedCategory)) selectedCategory = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  onMount(() => { void load(); });
</script>

<div class="new-eden-store">
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
  {#if loading && catalogue === null}<p role="status">Loading store catalogue…</p>{/if}
  {#if categoryUnavailable}<p role="status">{categoryRequest && "tag" in categoryRequest && categoryRequest.tag === "plex" ? "PLEX offers are unavailable in this catalogue." : "Game time is unavailable in this catalogue."}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if catalogue !== null && offers.length === 0}
    <p role="status">{selectedProduct !== null ? "No Multiple Character Training offers are available." : selectedCategory === null ? "No offers are available from this server." : "No offers in this category."}</p>
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
  .offers { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); padding: 0; margin: 0; gap: 10px; }
  .offers li { padding: 12px; border: 1px solid var(--line, #39444b); }
  h2 { font-size: 1rem; margin: 0; }
  li p { margin: 6px 0 0; }
  [role="alert"] { color: #fc9c95; }
</style>
