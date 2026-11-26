<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { ChatAccessOwnerKind } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { isAllianceOwner, isCorporationOwner } from "../bridge/mail.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, room, mutating = $bindable(false) }: { store: ClientStore; flow: AppFlow; room: string; mutating?: boolean } = $props();
  type Owner = { id: number; name: string };
  type Match = Owner & { kind: ChatAccessOwnerKind };
  const ownerTypes = [[2, "character"], [3, "corporation"], [4, "alliance"]] as const;
  const paths = {
    add: "UI/Chat/AddToAllowedList", remove: "UI/Chat/RemoveSelected", picker: "UI/Chat/SelectAllianceCorpChar",
    search: "UI/Common/Buttons/Search", ok: "UI/Common/Buttons/OK", cancel: "UI/Common/Buttons/Cancel",
  } as const;
  const words = $derived(store.words);
  const label = (key: keyof typeof paths, fallback: string) => plainText($words.templates[paths[key]] ?? "") || fallback;
  const selected = new SvelteSet<number>();
  const knownKinds = new Map<number, ChatAccessOwnerKind>();
  let current = true;
  let generation = 0;
  let entries = $state.raw<readonly Owner[]>([]);
  let matches = $state.raw<readonly Match[] | null>(null);
  let chosen = $state<number | null>(null);
  let query = $state("");
  let picker = $state(false);
  let busy = $state(true);
  let searching = $state(false);
  let error = $state("");

  function report(cause: unknown) {
    if (current) error = cause instanceof Error ? cause.message : "The allowed list is unavailable.";
  }
  onMount(() => {
    flow.requestWords(Object.values(paths));
    void flow.chatDirectoryChannelAllowed(room).then(rows => { if (current) entries = rows; })
      .catch(report).finally(() => { if (current) busy = false; });
    return () => { current = false; generation++; };
  });

  function closePicker() {
    generation++;
    searching = false;
    picker = false;
    query = "";
    matches = null;
    chosen = null;
  }
  async function find(event: SubmitEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text || searching || busy) return;
    const request = ++generation;
    error = "";
    chosen = null;
    searching = true;
    try {
      const found = await flow.searchOwners(text, ownerTypes.map(([type]) => type), 0);
      if (request !== generation) return;
      matches = ownerTypes.flatMap(([type, kind]) => (found.get(type) ?? []).map(owner => ({ ...owner, kind })))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (cause) {
      if (request === generation) report(cause);
    } finally {
      if (request === generation) searching = false;
    }
  }
  async function add() {
    const match = matches?.find(owner => owner.id === chosen);
    if (!match || busy) return;
    busy = true;
    mutating = true;
    error = "";
    try {
      const rows = await flow.chatDirectoryChannelAllowed(room, { ownerID: match.id, kind: match.kind, allowed: true });
      if (!current) return;
      entries = rows;
      knownKinds.set(match.id, match.kind);
      closePicker();
    } catch (cause) { report(cause); }
    finally { if (current) { busy = false; mutating = false; } }
  }
  async function accessKind(owner: Owner): Promise<ChatAccessOwnerKind> {
    const known = knownKinds.get(owner.id);
    if (known) return known;
    if (isCorporationOwner(owner.id)) return "corporation";
    if (isAllianceOwner(owner.id)) return "alliance";
    if (owner.id < 100_000_000) return "character";
    const found = await flow.searchOwners(owner.name, ownerTypes.map(([type]) => type), 3);
    const match = ownerTypes.find(([type]) => found.get(type)?.some(candidate => candidate.id === owner.id));
    if (!match) throw new Error(`Could not identify ${owner.name} as a character, corporation, or alliance.`);
    return match[1];
  }
  async function remove() {
    if (!selected.size || busy) return;
    busy = true;
    mutating = true;
    error = "";
    try {
      for (const owner of entries.filter(owner => selected.has(owner.id))) {
        const kind = await accessKind(owner);
        if (!current) return;
        const rows = await flow.chatDirectoryChannelAllowed(room, { ownerID: owner.id, kind, allowed: false });
        if (!current) return;
        entries = rows;
        selected.delete(owner.id);
      }
    } catch (cause) { report(cause); }
    finally { if (current) { busy = false; mutating = false; } }
  }
</script>

<section class="allowed-list" aria-label="Allowed">
  <div class="actions">
    <button type="button" disabled={busy || picker} onclick={() => { picker = true; }}>{label("add", "Add to Allowed List")}</button>
    <button type="button" disabled={busy || picker || !selected.size} onclick={remove}>{label("remove", "Remove Selected")}</button>
  </div>
  {#if entries.length}
    <ul>
      {#each entries as owner (owner.id)}
        <li data-allowed-owner={owner.id}>
          <label><input type="checkbox" checked={selected.has(owner.id)} disabled={busy || picker}
            onchange={(event) => { if (event.currentTarget.checked) selected.add(owner.id); else selected.delete(owner.id); }} />{owner.name}</label>
        </li>
      {/each}
    </ul>
  {:else if !busy}
    <p>No owners are on the allowed list.</p>
  {/if}
  {#if busy}<p role="status">Updating the allowed list…</p>{/if}
  {#if picker}
    <fieldset class="owner-picker" disabled={busy}>
      <legend>{label("picker", "Select Alliance, Corporation or Character")}</legend>
      <form class="actions" onsubmit={find}>
        <input type="search" aria-label={label("picker", "Select Alliance, Corporation or Character")} maxlength="37" value={query}
          oninput={(event) => { query = event.currentTarget.value; generation++; searching = false; matches = null; chosen = null; }} />
        <button type="submit" disabled={searching || !query.trim()}>{label("search", "Search")}</button>
      </form>
      {#if searching}<p role="status">Searching…</p>
      {:else if matches?.length}
        <ul>
          {#each matches as match (match.id)}
            <li><label><input type="radio" name="allowed-owner" checked={chosen === match.id} onchange={() => { chosen = match.id; }} />{match.name} <small>{match.kind}</small></label></li>
          {/each}
        </ul>
      {:else if matches}<p>No matching characters, corporations, or alliances.</p>{/if}
      <div class="actions">
        <button type="button" disabled={chosen === null || searching} onclick={add}>{label("ok", "OK")}</button>
        <button type="button" onclick={closePicker}>{label("cancel", "Cancel")}</button>
      </div>
    </fieldset>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .allowed-list { min-width: 0; }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  ul { margin: 0.5rem 0; padding: 0; list-style: none; max-height: 12rem; overflow: auto; }
  li label { display: flex; align-items: center; gap: 0.5rem; padding: 0.2rem 0; }
  .owner-picker { margin-top: 0.75rem; }
  input[type="search"] { flex: 1; min-width: 0; }
</style>
