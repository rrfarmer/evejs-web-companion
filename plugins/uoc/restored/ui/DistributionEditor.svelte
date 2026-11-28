<script lang="ts">
  import { untrack } from "svelte";
  import { positive, readConfig, type Config, type Office } from "../../logistics/model.ts";

  type Item = { typeID: number; name: string; groupName?: string };
  type DockChoice = Omit<Office, "division"> & { name: string; solarSystemName?: string | null };
  let {
    initial,
    corporations,
    busy,
    onSearchDocks,
    onSearchItems,
    onSave,
    onCancel,
  }: {
    initial?: Config;
    corporations: { id: number; name: string }[];
    busy: boolean;
    onSearchDocks: (
      query: string,
      corporationID: number | null,
    ) => Promise<{ matches: DockChoice[]; note?: string }>;
    onSearchItems: (query: string) => Promise<Item[]>;
    onSave: (config: Config) => void;
    onCancel: () => void;
  } = $props();

  const emptyOffice = (): Office => ({
    destinationID: 0,
    systemID: 0,
    kind: "station",
    division: 1,
  });
  let draft = $state<Config>(
    untrack(() =>
      initial
        ? structuredClone(initial)
        : {
            name: "",
            mode: "MANUAL",
            corporationID: corporations.length === 1 ? corporations[0]!.id : null,
            source: emptyOffice(),
            destination: emptyOffice(),
            items: [],
            fillPercent: 0,
            waitMinutes: 0,
          },
    ),
  );
  type Place = "source" | "destination";
  type DockSearch = { query: string; matches: DockChoice[]; note: string; working: boolean };
  const emptySearch = (): DockSearch => ({ query: "", matches: [], note: "", working: false });
  let docks = $state<Record<Place, DockSearch>>({
    source: emptySearch(),
    destination: emptySearch(),
  });
  let query = $state(""),
    itemMatches = $state<Item[]>([]),
    itemNote = $state(""),
    searching = $state(false),
    issue = $state("");
  let allItems = $state(untrack(() => initial?.allItems === true));
  const takeAll = $derived(draft.mode !== "SUPPLY" && allItems);
  const savedReserves = $derived(
    initial?.mode === "COLLECTION" && initial.allItems ? initial.items : [],
  );
  const quantity = $derived(
    draft.mode === "COLLECTION"
      ? "Leave at source"
      : draft.mode === "SUPPLY"
        ? "Keep at destination"
        : "Quantity to deliver",
  );

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  async function findDock(place: Place) {
    const field = docks[place],
      value = field.query.trim();
    if (field.working || value.length < 2) return;
    field.working = true;
    field.matches = [];
    field.note = "";
    try {
      const result = await onSearchDocks(value, draft.corporationID);
      if (field.query.trim() !== value) return;
      field.matches = result.matches;
      field.note = result.note ?? (result.matches.length ? "" : "No matching docks.");
    } catch (error) {
      field.note = message(error);
    } finally {
      field.working = false;
    }
  }

  function chooseDock(place: Place, dock: DockChoice) {
    draft[place] = {
      name: dock.name,
      destinationID: dock.destinationID,
      systemID: dock.systemID,
      kind: dock.kind,
      division: draft[place].division,
    };
    docks[place] = emptySearch();
  }

  async function findItems() {
    const value = query.trim();
    if (searching || value.length < 2) return;
    searching = true;
    itemMatches = [];
    itemNote = "";
    try {
      const result = await onSearchItems(value);
      if (query.trim() !== value) return;
      itemMatches = result;
      if (!result.length) itemNote = "No matching catalog items.";
    } catch (error) {
      itemNote = message(error);
    } finally {
      searching = false;
    }
  }

  function addItem(item: Item) {
    if (draft.items.some((row) => row.typeID === item.typeID)) return;
    draft.items.push({
      typeID: item.typeID,
      name: item.name,
      quantity: draft.mode === "COLLECTION" ? 0 : 1,
    });
    query = "";
    itemMatches = [];
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    issue = "";
    try {
      const items = takeAll ? (draft.mode === "COLLECTION" ? savedReserves : []) : draft.items;
      onSave(
        readConfig({
          ...draft,
          allItems: takeAll,
          items,
          corporationID:
            draft.corporationID ?? (corporations.length === 1 ? corporations[0]!.id : null),
        }),
      );
    } catch (error) {
      issue = message(error);
    }
  }
</script>

{#snippet dockFields(place: Place, caption: string, letter: string)}
  <fieldset class="dock">
    <legend><span class="letter">{letter}</span> {caption}</legend>
    {#if positive(draft[place].destinationID)}
      <div class="chosen">
        <div><strong>{draft[place].name ?? (draft[place].kind === "station" ? "Saved NPC station" : "Saved Upwell structure")}</strong>
          <small>{draft[place].kind === "station" ? "NPC station" : "Upwell structure"}</small></div>
        <button type="button" class="quiet" disabled={busy} onclick={() => { draft[place] = { ...emptyOffice(), division: draft[place].division }; }}>Change</button>
      </div>
    {:else}
      <label>Dock
        <span class="search">
          <input type="search" aria-label={caption + " dock search"} placeholder="Station or Upwell name" bind:value={docks[place].query} disabled={busy}
            onkeydown={event => { if (event.key === "Enter") { event.preventDefault(); void findDock(place); } }} />
          <button type="button" disabled={busy || docks[place].working || docks[place].query.trim().length < 2}
            onclick={() => void findDock(place)}>{docks[place].working ? "Searching…" : "Search"}</button>
        </span>
      </label>
      {#if docks[place].matches.length}
        <ul class="matches" aria-label={caption + " search results"}>
          {#each docks[place].matches as dock (dock.destinationID)}
            <li><button type="button" onclick={() => chooseDock(place, dock)} disabled={busy}>
              <strong>{dock.name}</strong><small>{dock.kind === "station" ? "NPC station" : "Upwell"}{dock.solarSystemName ? " · " + dock.solarSystemName : ""}</small>
            </button></li>
          {/each}
        </ul>
      {/if}
      {#if docks[place].note}<p role="status">{docks[place].note}</p>{/if}
    {/if}
    <label>Corporation division
      <select bind:value={draft[place].division} disabled={busy}>
        {#each [1, 2, 3, 4, 5, 6, 7] as number}<option value={number}>Division {number}</option>{/each}
      </select>
    </label>
  </fieldset>
{/snippet}

<form onsubmit={save} aria-label={initial ? "Edit operation" : "New operation"}>
  <div class="section-heading"><h2>{initial ? "Edit operation" : "New operation"}</h2><button type="button" class="quiet" onclick={onCancel} disabled={busy}>Cancel</button></div>
  <div class="fields">
    <label>Name <input bind:value={draft.name} placeholder="e.g. Mineral restock" required maxlength="160" disabled={busy} /></label>
    <label>Mode
      <select bind:value={draft.mode} disabled={busy}>
        <option value="MANUAL">Manual Delivery</option><option value="COLLECTION">Collection</option><option value="SUPPLY">Supply</option>
      </select>
    </label>
    {#if corporations.length > 1 || corporations.length && draft.corporationID !== null && !corporations.some(row => row.id === draft.corporationID)}
      <label>Corporation
        <select bind:value={draft.corporationID} disabled={busy}>
          <option value={null}>Choose the corporation</option>
          {#each corporations as corporation (corporation.id)}<option value={corporation.id}>{corporation.name}</option>{/each}
        </select>
      </label>
    {/if}
  </div>

  <div class="route">
    {@render dockFields("source", "Source", "A")}
    {@render dockFields("destination", "Destination", "B")}
  </div>

  <fieldset>
    <legend>Freight</legend>
    {#if draft.mode !== "SUPPLY"}
      <label class="cargo-choice">Cargo selection
        <select bind:value={allItems} disabled={busy}>
          <option value={false}>Selected items</option>
          <option value={true}>All items in source division</option>
        </select>
      </label>
    {/if}
    {#if takeAll}
      <p>{draft.mode === "MANUAL" ? "Carry everything that can be shipped from the source division." :
        "Collect new stock as it arrives in the source division."}</p>
      {#if draft.mode === "COLLECTION" && savedReserves.length}
        <p>The saved per-item source reserves still apply.</p>
      {/if}
    {:else}
      <label>Item catalog
        <span class="search"><input type="search" placeholder="Find an item by name" bind:value={query} disabled={busy}
          onkeydown={event => { if (event.key === "Enter") { event.preventDefault(); void findItems(); } }} />
          <button type="button" disabled={busy || searching || query.trim().length < 2} onclick={() => void findItems()}>
            {searching ? "Searching…" : "Search"}
          </button>
        </span>
      </label>
      {#if itemMatches.length}
        <ul class="matches" aria-label="Item catalog results">
          {#each itemMatches as item (item.typeID)}
            <li><button type="button" aria-label={"Add " + item.name} onclick={() => addItem(item)}
              disabled={busy || draft.items.some(row => row.typeID === item.typeID)}>
              <strong>{item.name}</strong>{#if item.groupName}<small>{item.groupName}</small>{/if}
            </button></li>
          {/each}
        </ul>
      {/if}
      {#if itemNote}<p role="status">{itemNote}</p>{/if}
      {#each draft.items as item (item.typeID)}
        <div class="freight">
          <strong>{item.name ?? "Saved catalog item"}</strong>
          <label>{quantity}
            <input type="number" bind:value={item.quantity} min={draft.mode === "COLLECTION" ? 0 : 1} step="1" required disabled={busy} />
          </label>
          <button type="button" class="quiet" aria-label={"Remove " + (item.name ?? "item")}
            onclick={() => { draft.items = draft.items.filter(row => row.typeID !== item.typeID); }} disabled={busy}>Remove</button>
        </div>
      {:else}
        <p>Choose the items this route should carry.</p>
      {/each}
    {/if}
  </fieldset>

  <fieldset>
    <legend>Loading</legend>
    <div class="fields">
      <label>Minimum load (% of free hold space)
        <input type="number" bind:value={draft.fillPercent} min="0" max="100" step="any" required disabled={busy} />
      </label>
      <label>Maximum wait (minutes)
        <input type="number" bind:value={draft.waitMinutes} min="0" step="any" required disabled={busy} />
      </label>
    </div>
    <p>After the wait, a hauler can depart with a partial load. Set wait to zero to send it as soon as freight is available.</p>
  </fieldset>

  {#if issue}<p class="error" role="alert">{issue}</p>{/if}
  <footer><button type="submit" class="primary" disabled={busy}>Save operation</button></footer>
</form>

<style>
  form {
    display: grid;
    gap: 1.1rem;
  }
  .section-heading,
  .chosen,
  .freight {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
  }
  h2 {
    margin: 0;
    font:
      650 1.22rem/1.3 system-ui,
      sans-serif;
    letter-spacing: 0;
  }
  .fields,
  .route {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.8rem;
  }
  fieldset {
    min-width: 0;
    margin: 0;
    border: 1px solid #2a3c48;
    border-radius: 0.65rem;
    padding: 0.8rem 1rem 1rem;
  }
  legend {
    padding-inline: 0.35rem;
    color: #deedf3;
    font-weight: 650;
  }
  .dock {
    background: #0d1820;
  }
  .letter {
    display: inline-grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    margin-right: 0.16rem;
    border: 1px solid #386477;
    color: #9be4e4;
    border-radius: 0.35rem;
    font-size: 0.82rem;
  }
  .chosen {
    align-items: start;
    margin-bottom: 0.6rem;
  }
  label {
    display: grid;
    gap: 0.28rem;
    min-width: 0;
    color: #c9d7e0;
    font-size: 0.87rem;
  }
  .cargo-choice {
    margin-bottom: 0.65rem;
  }
  input:not([type="checkbox"]),
  select {
    min-width: 0;
    width: 100%;
  }
  button {
    white-space: nowrap;
  }
  .search {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.4rem;
  }
  .matches {
    display: grid;
    gap: 0.25rem;
    padding: 0.35rem 0 0;
    margin: 0;
    list-style: none;
    max-height: 13rem;
    overflow-y: auto;
  }
  .matches button {
    display: block;
    width: 100%;
    text-align: left;
    white-space: normal;
  }
  small {
    display: block;
    color: #a8bdcc;
    font-size: 0.82rem;
  }
  .freight {
    border-top: 1px solid #2a3c48;
    margin-top: 0.65rem;
    padding-top: 0.65rem;
  }
  .freight strong {
    flex: 1;
  }
  .freight label {
    width: 10rem;
  }
  p {
    margin: 0.5rem 0 0;
    font-size: 0.86rem;
    color: #aebfcb;
  }
  p.error {
    color: #ffc2a0;
  }
  footer {
    display: flex;
    justify-content: flex-end;
  }
  @media (max-width: 50rem) {
    .route {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 34rem) {
    .fields {
      grid-template-columns: 1fr;
    }
    .freight {
      flex-wrap: wrap;
    }
  }
</style>
