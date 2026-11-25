<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { cloneBayAvailable, jumpCloneLocationKind, type JumpClone } from "../bridge/jumpClones.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { deriveDocked } from "./tabs.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const names = $derived(store.names);
  const place = $derived.by(() => {
    const online = $station.online;
    const status = $flight.status;
    if (!deriveDocked(status, online)) return null;
    const structureID = status ? status.structureID : online?.structureID;
    if (structureID) return cloneBayAvailable($station.structureServiceIDs, true) ? structureID : null;
    const stationID = status ? status.stationID : online?.stationID;
    const current = $station.station;
    return current && current.stationID === stationID && cloneBayAvailable(current.serviceIDs, false)
      ? current.stationID : null;
  });
  const label = (row: JumpClone) => resolvedName($names.resolved, jumpCloneLocationKind(row.locationID), row.locationID, "Location " + row.locationID);
  const isk = (price: number) => price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ISK";
  let rows = $state.raw<readonly JumpClone[] | null>(null);
  let review = $state<{ kind: "install"; place: number; price: number } | { kind: "rename" | "destroy"; clone: JumpClone } | null>(null);
  let newName = $state("");
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

  function quote(): void {
    const location = place;
    if (!location) return;
    void run(async () => {
      const price = await flow.quoteJumpCloneInstall(location);
      review = { kind: "install", place: location, price };
    });
  }

  function confirm(): void {
    const action = review;
    if (!action || busy) return;
    review = null;
    void run(async () => {
      if (action.kind === "install") {
        await flow.installJumpClone(action.place, action.price);
        status = "Jump clone installed.";
      } else if (action.kind === "rename") {
        await flow.renameJumpClone(action.clone.id, newName);
        status = "Jump clone renamed.";
      } else {
        await flow.destroyJumpClone(action.clone.id);
        status = "Jump clone destroyed.";
      }
      rows = null;
      rows = await flow.loadJumpClones();
    });
  }

  onMount(() => { void run(async () => { rows = await flow.loadJumpClones(); }); });
</script>

<section class="jump-clones" data-window="jumpClones" aria-label="Jump Clones" aria-busy={busy}>
  <header>
    <h3>Jump Clones</h3>
    <button type="button" disabled={busy || !place || review !== null} onclick={quote}>Install Jump Clone</button>
    <button type="button" disabled={busy || review !== null} onclick={() => run(async () => { rows = await flow.loadJumpClones(); })}>Refresh</button>
  </header>
  {#if !place}<p>Dock at a station or structure with a Clone Bay to install a jump clone.</p>{/if}
  {#if error || status}<p role="status">{status}{status && error ? " " : ""}{error}</p>{/if}
  {#if review}
    <div class="clone-review">
      {#if review.kind === "install"}
        <strong>Install a jump clone here for {isk(review.price)}?</strong>
      {:else if review.kind === "rename"}
        <label>Clone name <input type="text" maxlength="100" bind:value={newName} /></label>
      {:else}
        <strong>Destroy {review.clone.name || "this jump clone"} at {label(review.clone)}?</strong>
        {#if review.clone.implants.length}<span>Its installed implants will also be destroyed.</span>{/if}
      {/if}
      <div>
        <button type="button" disabled={busy || (review.kind === "install" && place !== review.place)} onclick={confirm}>Confirm</button>
        <button type="button" onclick={() => (review = null)}>Cancel</button>
      </div>
    </div>
  {/if}
  {#if rows}
    {#each rows as row (row.id)}
      <article data-clone-id={row.id}>
        <div>
          <strong>{row.name || "Jump clone"}</strong>
          <div>{label(row)}{row.locationID === place ? " · Here" : ""}</div>
          {#each row.implants as implant, i (i)}
            <div>{resolvedName($names.resolved, "type", implant, "Implant " + implant)}</div>
          {/each}
        </div>
        <div>
          <button type="button" disabled={busy || review !== null}
            onclick={() => { newName = row.name; review = { kind: "rename", clone: row }; }}>Rename</button>
          <button type="button" disabled={busy || review !== null} onclick={() => (review = { kind: "destroy", clone: row })}>Destroy</button>
        </div>
      </article>
    {:else}
      <p>No jump clones installed.</p>
    {/each}
  {/if}
</section>

<style>
  .jump-clones { display: grid; gap: 6px; }
  header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  h3 { margin: 0 auto 0 0; }
  p { margin: 0; }
  article, .clone-review { padding: 8px; background: rgb(255 255 255 / .06); }
  article { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
  .clone-review { display: grid; gap: 6px; }
</style>
