<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { shipSkinrRecord } from "../bridge/shipSkinrCoatings.ts";
  import type { ShipSkinrDesign } from "../bridge/shipSkinr.ts";
  import { formatDuration } from "../bridge/skills.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import ShipSkinrShare from "./ShipSkinrShare.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  type Listing = Awaited<ReturnType<AppFlow["loadShipSkinrOwnedListings"]>>[number];
  type Row = Listing & { design: ShipSkinrDesign | null };
  const prefix = "UI/Personalization/ShipSkins/SKINR/";
  const labels = {
    heading: [prefix + "Store/MyListings", "My Listings"],
    listedTo: [prefix + "Store/ListedTo", "Listed To"],
    specific: [prefix + "Store/ListedToSpecific", "Listed to Specific"],
    corporation: [prefix + "Collection/SellAvailability/MyCorporation", "My Corporation"],
    alliance: [prefix + "Collection/SellAvailability/MyAlliance", "My Alliance"],
    anyone: [prefix + "Store/ListedByAnyone", "Anyone"],
    public: [prefix + "Collection/SellAvailability/Public", "Public"],
    limit: [prefix + "Store/MaxListingsTooltip", "Learn SKIN trading skills to increase your listing limit."],
    expiry: [prefix + "Store/TimeLeft", "Time Left"],
    expiryReverse: [prefix + "Store/TimeLeftReversed", "Time Left Reversed"],
    name: ["UI/Common/Name", "Name"],
    nameReverse: ["UI/Inventory/NameReversed", "Name Reversed"],
    sort: ["UI/Common/SortBy", "Sort By"],
    remove: [prefix + "Store/RemoveListing", "Remove Listing"],
  } as const;
  const targets = ["anyone", "specific", "corporation", "alliance"] as const;
  const orders = ["expiry", "expiryReverse", "name", "nameReverse"] as const;
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
  const characters = $derived(store.character);
  const pilot = $derived($station.online?.characterID ?? null);
  const owner = $derived($characters.characters.find(character => character.characterID === pilot));
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const hullName = (id: number) => resolvedName($names.resolved, "type", id, String(id));
  const skinName = (row: Row) => row.design?.name || "Design unavailable";
  const price = (row: Row) => `${row.amount.toLocaleString()} ${row.currency}`;
  const targetID = (row: Row, kind: string) => Number(shipSkinrRecord(row.target[kind])?.sequential ?? 0);
  function audience(row: Row) {
    for (const kind of ["character", "corporation", "alliance"] as const) {
      const id = targetID(row, kind);
      if (id) return resolvedName($names.resolved, kind, id, String(id));
    }
    return word("public");
  }

  let rows = $state.raw<readonly Row[]>([]);
  let limit = $state<number | null>(null);
  let selected = $state<string | null>(null);
  let target = $state<typeof targets[number]>("anyone");
  let order = $state<typeof orders[number]>("expiryReverse");
  let hull = $state(0);
  let revision = $state(0);
  let busy = $state(false);
  let loading = $state(false);
  let loadError = $state("");
  let actionError = $state("");
  let notice = $state("");
  const hulls = $derived([...new Set(rows.flatMap(row => row.design ? [row.design.shipTypeID] : []))]
    .sort((a, b) => hullName(a).localeCompare(hullName(b))));
  const visible = $derived(rows.filter(row => {
    if (hull && row.design?.shipTypeID !== hull) return false;
    if (target === "specific") return !row.target.public;
    if (target === "corporation") return !!owner?.corporationID && targetID(row, target) === owner.corporationID;
    if (target === "alliance") return !!owner?.allianceID && targetID(row, target) === owner.allianceID;
    return true;
  }).sort((a, b) => {
    if (order === "name") return skinName(a).localeCompare(skinName(b));
    if (order === "nameReverse") return skinName(b).localeCompare(skinName(a));
    return order === "expiry" ? a.expires - b.expires : b.expires - a.expires;
  }));
  const detail = $derived(visible.find(row => row.id === selected));
  let active = false;
  let loadedFor: number | null = null;

  $effect(() => {
    active = true;
    flow.requestWords(Object.values(labels).map(label => label[0]));
    return () => { active = false; };
  });
  $effect(() => {
    const character = pilot;
    void revision;
    selected = null;
    loadError = "";
    loading = !!character;
    if (loadedFor !== character) {
      loadedFor = character;
      rows = [];
      limit = null;
      actionError = "";
      notice = "";
    }
    if (!character) return;
    let current = true;
    void Promise.all([flow.loadShipSkinrOwnedListings(), flow.loadShipSkinrListingLimit()]).then(async ([listings, capacity]) => {
      const designs = await Promise.all([...new Set(listings.map(row => row.hex))].map(async hex =>
        [hex, await flow.loadShipSkinrDesign(hex).catch(() => null)] as const));
      if (!current) return;
      const byHex = new Map(designs);
      rows = listings.map(row => ({ ...row, design: byHex.get(row.hex) ?? null }));
      limit = capacity;
      if (!designs.some(([, design]) => design?.shipTypeID === hull)) hull = 0;
      flow.requestNames(listings.flatMap(row => (["character", "corporation", "alliance"] as const).flatMap(kind => {
        const id = targetID(row, kind);
        return id ? [{ kind, id }] : [];
      })));
    }).catch(error => {
      if (current) loadError = panelErrorWords(error);
    }).finally(() => {
      if (current) loading = false;
    });
    return () => { current = false; };
  });

  async function remove(row: Row) {
    const character = pilot;
    if (!character || busy || loading) return;
    busy = true;
    actionError = "";
    notice = "";
    try {
      const confirmed = await flow.askClientDialogWith("ConfirmRemoveSkinListing", {}, "Remove this listing?");
      if (!confirmed || !active || pilot !== character) return;
      await flow.cancelShipSkinrListing(row.id);
      if (!active || pilot !== character) return;
      rows = rows.filter(listing => listing.id !== row.id);
      notice = "Listing removed.";
      revision++;
    } catch (error) {
      if (active && pilot === character) actionError = panelErrorWords(error);
    } finally {
      if (active) busy = false;
    }
  }
</script>

  <section class="listings" aria-label={word("heading")}>
    <header>
      <h3>{word("heading")} {#if limit !== null}<span title={word("limit")}>{rows.length}/{limit}</span>{/if}</h3>
      <button type="button" disabled={loading || busy || !pilot} onclick={() => { revision++; }}>Refresh</button>
    </header>
    <div class="filters">
      <label>{word("listedTo")} <select bind:value={target}>
        {#each targets as key (key)}<option value={key}>{word(key)}</option>{/each}
      </select></label>
      <label>Ship <select bind:value={hull}>
        <option value={0}>All Ships</option>
        {#each hulls as id (id)}<option value={id}>{hullName(id)}</option>{/each}
      </select></label>
      <label>{word("sort")} <select bind:value={order}>
        {#each orders as key (key)}<option value={key}>{word(key)}</option>{/each}
      </select></label>
    </div>
    {#if loadError || actionError}<p role="alert">{loadError || actionError}</p>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if loading}
      <p>Loading listings…</p>
    {:else if !loadError && !visible.length}
      <p>No listings.</p>
    {/if}
    <div class="listing-body">
      <ul>
        {#each visible as row (row.id)}
          <li><button type="button" aria-pressed={detail?.id === row.id} onclick={() => { selected = row.id; actionError = ""; }}>
            <strong>{skinName(row)}</strong>
            <span>{row.design ? hullName(row.design.shipTypeID) : "—"} · {price(row)}</span>
          </button></li>
        {/each}
      </ul>
      {#if detail}
        <article aria-label={skinName(detail)}>
          <h4>{skinName(detail)}</h4>
          <dl>
            <dt>{word("listedTo")}</dt><dd>{audience(detail)}</dd>
            <dt>Price per SKIN</dt><dd>{price(detail)}</dd>
            <dt>Quantity remaining</dt><dd>{detail.quantity.toLocaleString()}</dd>
            <dt>{word("expiry")}</dt>
            <dd>{#if Number.isFinite(detail.expires)}<time datetime={new Date(detail.expires).toISOString()}>{formatDuration(Math.max(0, detail.expires - Date.now()))}</time>{:else}—{/if}</dd>
          </dl>
          <button type="button" disabled={busy || loading} onclick={() => { if (detail) void remove(detail); }}>{word("remove")}</button>
          {#key detail.id}<ShipSkinrShare {store} {flow} id={detail.id} name={skinName(detail)} />{/key}
        </article>
      {/if}
    </div>
  </section>

<style>
  .listings { padding: 12px 18px 18px; }
  header, .filters { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
  header { justify-content: space-between; }
  h3, h4, dl { margin: 0; }
  h3 span { margin-left: 6px; color: #a4bfc6; font-size: .85em; }
  label { display: flex; align-items: center; gap: 5px; }
  .listing-body { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; }
  ul { flex: 1 1 205px; list-style: none; padding: 0; margin: 0; max-height: 360px; overflow: auto; }
  li { margin-bottom: 4px; }
  li button { display: grid; width: 100%; text-align: start; gap: 3px; }
  li button[aria-pressed="true"] { border-color: #94b8c2; }
  li span, dt { color: #a4bfc6; }
  article { flex: 1 1 220px; border: 1px solid #344952; padding: 12px; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 6px; padding: 12px 0; }
  dd { margin: 0; text-align: end; }
</style>
