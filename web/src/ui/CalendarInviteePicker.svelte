<script lang="ts">
  import { tick } from "svelte";
  import type { CharacterMatch } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { isAllianceOwner, isCorporationOwner } from "../bridge/mail.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { flow, store, added, add, close }: {
    flow: AppFlow; store: ClientStore; added: readonly CharacterMatch[];
    add: (pilots: readonly CharacterMatch[]) => void; close: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const { station, words } = store;
  const WORD = {
    caption: "UI/Calendar/FindInviteesWindow/Caption", add: "UI/Calendar/FindInviteesWindow/Add",
    close: "UI/Generic/Close", search: "UI/Mail/Search", contacts: "UI/Mail/AllContacts", searchBy: "UI/Common/SearchBy",
    typeIn: "UI/Common/TypeInSearch", noResult: "UI/Market/NothingFoundWithSearch", noContacts: "UI/Calendar/EventWindow/NoCharacter",
    added: "UI/Calendar/Hints/CharacterAdded", short: "dialog:PartialSearchLessThanMinLength/body",
  } as const;
  const MATCH = [
    ["PartialTerms", "Partial Terms"], ["ExactTerms", "Exact Terms"], ["ExactPhrase", "Exact Phrase"], ["OnlyExactPhrase", "Exact phrase only"],
  ] as const;
  const searchWord = (name: string): string => `UI/Search/UniversalSearch/${name}`;
  const word = (key: string, fallback: string, values: Record<string, string | number> = {}): string =>
    plainText(formatTemplate($words.templates[key] ?? "", values, { nameOf: () => "" })) || fallback;

  const id = $props.id();
  type Read = { readonly rows: readonly CharacterMatch[]; readonly note?: string };
  let tab = $state<"search" | "contacts">("search");
  let input: HTMLInputElement | undefined = $state();
  let query = $state("");
  // svelte-ignore state_referenced_locally
  let matchBy = $state(flow.ownersSearchBy());
  let selected = $state<number[]>([]);
  let searching = $state(false);
  let searchRead = $state<Read>({ rows: [] });
  let contactsRead = $state<Read | null>(null);
  let contactsLoading = $state(false);

  $effect(() => {
    flow.requestWords([...Object.values(WORD), ...MATCH.map(([name]) => searchWord(name))]);
  });
  $effect(() => {
    if (tab === "search") void tick().then(() => input?.focus());
  });
  const read = $derived(tab === "search" ? searchRead : contactsRead);
  const rows = $derived((read?.rows ?? []).filter(row => row.characterID !== $station.online?.characterID)
    .sort((left, right) => left.name.localeCompare(right.name)));
  const addedIDs = $derived(new Set(added.map(row => row.characterID)));
  const selectedRows = $derived(rows.filter(row => selected.includes(row.characterID) && !addedIDs.has(row.characterID)));

  async function search(): Promise<void> {
    if (searching) return;
    const text = query.replace(/[%?*]/g, "").trim();
    selected = [];
    if (!text) {
      searchRead = { rows: [] };
      return;
    }
    if (matchBy === 0 && !text.split(/\s+/).some(term => term.length >= 3)) {
      searchRead = { rows: [], note: word(WORD.short, "Enter at least three characters for a partial search.", { minChars: 3 }) };
      return;
    }
    searching = true;
    try {
      const pilots = await flow.searchCharacters(text, matchBy);
      searchRead = { rows: pilots, note: word(WORD.noResult, `No characters found for “${text}”.`, { search: text }) };
    } catch (error) {
      searchRead = { rows: [], note: error instanceof Error ? error.message : "Character search is unavailable." };
    } finally {
      searching = false;
    }
  }

  async function showContacts(): Promise<void> {
    tab = "contacts";
    selected = [];
    if (contactsLoading || contactsRead) return;
    contactsLoading = true;
    try {
      const book = await flow.addressBook();
      contactsRead = { rows: book.contacts.filter(({ contactID }) =>
        contactID >= 90_000_000 && !isCorporationOwner(contactID) && !isAllianceOwner(contactID))
        .map(({ contactID, name }) => ({ characterID: contactID, name })) };
    } catch (error) {
      contactsRead = { rows: [], note: error instanceof Error ? error.message : "Contacts could not be read." };
    } finally {
      contactsLoading = false;
    }
  }
  function choose(): void {
    add(selectedRows);
    selected = [];
  }
</script>

<div class="invitee-picker" role="dialog" aria-labelledby={`${id}-heading`} tabindex="-1"
  onkeydown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
  <b id={`${id}-heading`}>{word(WORD.caption, "Find Invitees")}</b>
  <div class="tabs" role="tablist" aria-labelledby={`${id}-heading`}>
    <button type="button" role="tab" id={`${id}-search`} aria-controls={`${id}-results`}
      aria-selected={tab === "search"} onclick={() => { tab = "search"; selected = []; }}>{word(WORD.search, "Search")}</button>
    <button type="button" role="tab" id={`${id}-contacts`} aria-controls={`${id}-results`}
      aria-selected={tab === "contacts"} onclick={showContacts}>{word(WORD.contacts, "All Contacts")}</button>
  </div>
  {#if tab === "search"}
    <div class="search">
      <input type="search" maxlength="50" aria-label={word(WORD.search, "Search")} bind:this={input} bind:value={query}
        onkeydown={event => { if (event.key === "Enter") { event.preventDefault(); void search(); } }} />
      <button type="button" disabled={searching} onclick={search}>{word(WORD.search, "Search")}</button>
      <label>{word(WORD.searchBy, "Search By")}
        <select bind:value={matchBy} onchange={() => flow.keepOwnersSearchBy(matchBy)}>
          {#each MATCH as [name, fallback], value (name)}<option {value}>{word(searchWord(name), fallback)}</option>{/each}
        </select>
      </label>
    </div>
  {/if}
  <div class="results" role="tabpanel" id={`${id}-results`} aria-labelledby={`${id}-${tab}`}>
    {#if tab === "search" ? searching : contactsLoading}
      <p role="status">Loading…</p>
    {:else}
      {#each rows as pilot (pilot.characterID)}
        {@const exists = addedIDs.has(pilot.characterID)}
        <label ondblclick={() => { if (!exists) add([pilot]); }}>
          <input type="checkbox" value={pilot.characterID} bind:group={selected} disabled={exists} />
          {pilot.name}
          {#if exists}<small>{word(WORD.added, "Already added")}</small>{/if}
        </label>
      {:else}
        <p role="status">{read?.note ?? (tab === "search" ? word(WORD.typeIn, "Enter a name, then search.") : word(WORD.noContacts, "No characters"))}</p>
      {/each}
    {/if}
  </div>
  <div class="actions">
    <button type="button" disabled={selectedRows.length === 0} onclick={choose}>{word(WORD.add, "Add")}</button>
    <button type="button" onclick={close}>{word(WORD.close, "Close")}</button>
  </div>
</div>

<style>
  .invitee-picker { position: absolute; inset: 8px; z-index: 1; display: flex; flex-direction: column; min-height: 0; gap: 4px;
    max-width: 420px; margin-inline: auto; padding: 8px; border: 1px solid #ffffff32; background: var(--panel, #1b2230); }
  .tabs, .actions, .search { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .tabs button[aria-selected="true"] { border-bottom-color: var(--accent, #8eafc8); background: #ffffff16; }
  .search input { min-width: 100px; flex: 1; }
  .search label { display: flex; align-items: center; gap: 3px; }
  .results { flex: 1; min-height: 0; overflow: auto; border: 1px solid #ffffff20; }
  .results label { display: flex; align-items: center; gap: 4px; padding: 2px 4px; }
  .results input { flex: none; width: auto; }
  .results label:hover { background: #fff1; }
  small { margin-left: auto; }
  .actions { justify-content: center; }
  p { margin: 4px; }
</style>
