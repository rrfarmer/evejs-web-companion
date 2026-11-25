<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { CLONE_JUMP_COOLDOWN_ATTRIBUTE, cloneBayAvailable, cloneJumpCooldownEnd, jumpCloneLocationKind, type CloneJumpQuote, type JumpClone, type JumpCloneState } from "../bridge/jumpClones.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { deriveDocked } from "./tabs.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const dogma = $derived(store.dogma);
  const names = $derived(store.names);
  const docked = $derived(deriveDocked($flight.status, $station.online));
  const dockedAt = $derived(docked
    ? ($flight.status ?? $station.online)?.structureID ?? ($flight.status ?? $station.online)?.stationID ?? null
    : null);
  const place = $derived.by(() => {
    const online = $station.online;
    const status = $flight.status;
    if (!docked) return null;
    const structureID = status ? status.structureID : online?.structureID;
    if (structureID) return cloneBayAvailable($station.structureServiceIDs, true) ? structureID : null;
    const stationID = status ? status.stationID : online?.stationID;
    const current = $station.station;
    return current && current.stationID === stationID && cloneBayAvailable(current.serviceIDs, false)
      ? current.stationID : null;
  });
  const label = (row: JumpClone) => resolvedName($names.resolved, jumpCloneLocationKind(row.locationID), row.locationID, "Location " + row.locationID);
  const isk = (price: number) => price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ISK";
  let cloneState = $state.raw<JumpCloneState | null>(null);
  const rows = $derived(cloneState?.clones);
  let now = $state(Date.now());
  const cooldownEnd = $derived.by(() => {
    const lastJump = cloneState?.lastJumpMs;
    if (lastJump == null) return null;
    const allInfo = $dogma.allInfo;
    const matches = (attribute: { attributeID: number }) => attribute.attributeID === CLONE_JUMP_COOLDOWN_ATTRIBUTE;
    const hours = allInfo?.shipModifiedCharAttributes?.attributes.find(matches)?.value
      ?? allInfo?.character?.attributes.find(matches)?.value;
    return cloneJumpCooldownEnd(lastJump, hours);
  });
  const remaining = $derived(cooldownEnd === null ? 0 : Math.max(0, Math.ceil((cooldownEnd - now) / 60_000)));
  $effect(() => {
    if (cooldownEnd === null || cooldownEnd <= Date.now()) return;
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
      if (now >= (cooldownEnd ?? 0)) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  });
  let review = $state<{ kind: "install"; place: number; price: number } | { kind: "rename" | "destroy"; clone: JumpClone } |
    { kind: "jump"; quote: CloneJumpQuote; warning?: string } | null>(null);
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
      } else if (action.kind === "jump") {
        const warning = await flow.jumpToClone(action.quote, action.warning !== undefined);
        if (warning) {
          review = { kind: "jump", quote: warning.quote, warning: warning.message };
          return;
        }
        status = "Clone jump complete.";
      } else {
        await flow.destroyJumpClone(action.clone.id);
        status = "Jump clone destroyed.";
      }
      cloneState = null;
      cloneState = await flow.loadJumpClones();
    });
  }

  const refresh = () => run(async () => { cloneState = await flow.loadJumpClones(); });
  onMount(() => { void refresh(); });
</script>

<section class="jump-clones" data-window="jumpClones" aria-label="Jump Clones" aria-busy={busy}>
  <header>
    <h3>Jump Clones</h3>
    <button type="button" disabled={busy || !place || review !== null} onclick={quote}>Install Jump Clone</button>
    <button type="button" disabled={busy || review !== null} onclick={refresh}>Refresh</button>
  </header>
  {#if !place}<p>Dock at a station or structure with a Clone Bay to install a jump clone.</p>{/if}
  {#if remaining > 0}<p>Remote jumps available in {Math.floor(remaining / 60)}h {remaining % 60}m.</p>{/if}
  {#if error || status}<p role="status">{status}{status && error ? " " : ""}{error}</p>{/if}
  {#if review}
    <div class="clone-review">
      {#if review.kind === "install"}
        <strong>Install a jump clone here for {isk(review.price)}?</strong>
      {:else if review.kind === "rename"}
        <label>Clone name <input type="text" maxlength="100" bind:value={newName} /></label>
      {:else if review.kind === "jump"}
        <strong>Jump to {review.quote.clone.name || "this clone"} at {label(review.quote.clone)} for {isk(review.quote.price)}?</strong>
        {#if review.quote.leavesShip}<span>You will leave your current ship at this dock and jump from your capsule.</span>{/if}
        {#if review.warning}<span>{review.warning}</span>{/if}
      {:else}
        <strong>Destroy {review.clone.name || "this jump clone"} at {label(review.clone)}?</strong>
        {#if review.clone.implants.length}<span>Its installed implants will also be destroyed.</span>{/if}
      {/if}
      <div>
        <button type="button" disabled={busy || (review.kind === "install" && place !== review.place) ||
          (review.kind === "jump" && dockedAt !== review.quote.origin)} onclick={confirm}>Confirm</button>
        <button type="button" onclick={() => (review = null)}>Cancel</button>
      </div>
    </div>
  {/if}
  {#if rows}
    {#each rows as row (row.id)}
      <article data-clone-id={row.id}>
        <div>
          <strong>{row.name || "Jump clone"}</strong>
          <div>{label(row)}{row.locationID === dockedAt ? " · Here" : ""}</div>
          {#each row.implants as implant, i (i)}
            <div>{resolvedName($names.resolved, "type", implant, "Implant " + implant)}</div>
          {/each}
        </div>
        <div>
          <button type="button" disabled={busy || review !== null || !dockedAt || (remaining > 0 && row.locationID !== dockedAt)}
            onclick={() => run(async () => { review = { kind: "jump", quote: await flow.quoteCloneJump(row) }; })}>Jump</button>
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
