<script lang="ts">
  import { onMount } from "svelte";
  import { bridgeAsk } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { isListValue, readDictEntry, type JsonValue } from "../bridge/wire.ts";

  let { flow }: { flow: AppFlow } = $props();
  const storeID = 4;
  type Category = { id: number; name: string };
  type Offer = { id: number; name: string; description: string; categories: number[] };
  let catalogue = $state<{ offers: Offer[]; categories: Category[] } | null>(null);
  let selectedCategory = $state<number | null>(null);
  let loading = $state(false);
  let error = $state("");
  const offers = $derived(catalogue?.offers.filter(offer => selectedCategory === null || offer.categories.includes(selectedCategory)) ?? []);

  const entries = (value: unknown): readonly JsonValue[] => isListValue(value) ? value.items : [];
  const name = (value: unknown, key: string): string => {
    const field = readDictEntry(value, key);
    return typeof field === "string" ? plainText(field).trim() : "";
  };
  const id = (value: unknown): number | null => {
    const field = readDictEntry(value, "id");
    return typeof field === "number" && Number.isSafeInteger(field) && field > 0 ? field : null;
  };

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
        return categoryID === null || !title ? [] : [{ id: categoryID, name: title }];
      });
      const listed = rawOffers.items.flatMap((entry) => {
        const offerID = id(entry), title = name(entry, "name");
        if (offerID === null || !title || entries(readDictEntry(entry, "products")).length === 0) return [];
        const groups = entries(readDictEntry(entry, "categories")).map(id);
        return [{ id: offerID, name: title, description: name(entry, "description"), categories: groups.filter(group => group !== null) }];
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
      <label>Category <select bind:value={selectedCategory}>
        <option value={null}>All offers</option>
        {#each catalogue.categories as category (category.id)}
          <option value={category.id}>{category.name}</option>
        {/each}
      </select></label>
    {/if}
    <button type="button" disabled={loading} onclick={() => void load()}>Refresh catalogue</button>
  </div>
  {#if loading && catalogue === null}<p role="status">Loading store catalogue…</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if catalogue !== null && offers.length === 0}
    <p role="status">{selectedCategory === null ? "No offers are available from this server." : "No offers in this category."}</p>
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
