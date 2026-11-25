<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import type { HomeStationCandidate } from "../bridge/characterSheet.ts";
  import { isStation } from "../bridge/placeChanges.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const sheet = $derived(store.characterSheet);
  const names = $derived(store.names);
  const name = (id: number) => resolvedName($names.resolved, isStation(id) ? "station" : "structure", id, "Unknown station");
  const reasons: Readonly<Record<number, string>> = {
    1: "A station in wormhole space cannot be your home.",
    2: "This is already your home station.",
    3: "Your remote home station change is on cooldown.",
    4: "This station is unavailable to your militia.",
    5: "This station is no longer available.",
    6: "A station in Triglavian space cannot be your home.",
  };
  const groups = [
    { label: "Current Station", matches: (row: HomeStationCandidate) => row.isCurrent },
    { label: "School Headquarters", matches: (row: HomeStationCandidate) => !row.isCurrent && row.isSchool },
    { label: "Corporation Offices", matches: (row: HomeStationCandidate) => !row.isCurrent && !row.isSchool },
  ];
  let choosing = $state(false);
  let choices = $state.raw<readonly HomeStationCandidate[] | null>(null);
  let review = $state<HomeStationCandidate | null>(null);
  let busy = $state(false);
  let error = $state("");
  let status = $state("");

  async function run(task: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    status = "";
    try { await task(); }
    catch (cause) { error = panelErrorWords(cause); }
    finally { busy = false; }
  }

  function choose(): void {
    choosing = true;
    choices = null;
    void run(async () => { choices = await flow.loadHomeStationCandidates(); });
  }

  function confirm(): void {
    const selected = review;
    if (!selected) return;
    review = null;
    void run(async () => {
      await flow.setHomeStation(selected);
      choosing = false;
      status = "Home station changed.";
    });
  }
</script>

<section class="home-panel" data-window="homeStation" aria-label="Home Station" aria-busy={busy}>
  {#if choosing}
    <header><h3>Change Home Station</h3><button type="button" disabled={busy} onclick={() => {
      choosing = false; review = null; error = "";
    }}>Back</button></header>
    {#if busy && !choices}<p>Reading available stations…</p>{/if}
    {#if review}
      <div class="home-review">
        <strong>Set {name(review.id)} as your home station?</strong>
        {#if !review.isCurrent && !review.isSchool}<span>Remote home station changes are available once a year.</span>{/if}
        <div><button type="button" disabled={busy} onclick={confirm}>Confirm</button>
          <button type="button" onclick={() => (review = null)}>Cancel</button></div>
      </div>
    {/if}
    {#each groups as group (group.label)}
      {@const candidates = choices?.filter(group.matches) ?? []}
      {#if candidates.length}
        <h4>{group.label}</h4>
        {#each candidates as row (row.id)}
          <article data-station-id={row.id}>
            <div><strong>{name(row.id)}</strong>
              {#each row.errors as reason, i (i)}<div>{reasons[reason] ?? "This station choice is unavailable."}</div>{/each}
            </div>
            <button type="button" disabled={busy || review !== null || row.errors.length > 0} onclick={() => (review = row)}>Set Home Station</button>
          </article>
        {/each}
      {/if}
    {/each}
    {#if choices?.length === 0}<p>No eligible stations were returned.</p>{/if}
    {#if error}<button type="button" disabled={busy} onclick={choose}>Refresh Choices</button>{/if}
  {:else}
    <header><h3>Home Station</h3><button type="button" disabled={busy} onclick={choose}>Select New Home Station</button></header>
    {#if $sheet.homeStationError}<p>{$sheet.homeStationError}</p>
    {:else if $sheet.homeStationID === null}<p>Reading your home station…</p>
    {:else}<p data-home-station-id={$sheet.homeStationID}>{name($sheet.homeStationID)}</p>{/if}
  {/if}
  {#if status || error}<p role="status">{status || error}</p>{/if}
</section>

<style>
  .home-panel { display: grid; gap: 8px; }
  header, article { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  h3, h4, p { margin: 0; }
  h4 { margin-top: 8px; }
  article, .home-review { padding: 8px; background: rgb(255 255 255 / .06); }
  .home-review { display: grid; gap: 8px; }
</style>
