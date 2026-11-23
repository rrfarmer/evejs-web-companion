<script lang="ts">
  import { onMount } from "svelte";
  import { continueNewTrainee, readPendingTrainee } from "../training/newTrainee.ts";
  import { factoryError } from "../training/factory.ts";
  import { trainingPendingStorage } from "../training/worldStorage.ts";
  let { onContinue, onCancel, onBusy, externalBusy = false, worldID = null }: {
    onContinue: (result: Awaited<ReturnType<typeof continueNewTrainee>>) => void;
    onCancel: () => void; onBusy: (value: boolean) => void; externalBusy?: boolean; worldID?: string | null;
  } = $props();
  const pendingStorage = trainingPendingStorage({
    getItem: (key) => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: (key) => sessionStorage.removeItem(key),
  }, () => worldID);
  let username = $state(""), password = $state(""), confirmation = $state("");
  let busy = $state(false), recovery = $state(false), error = $state(""), recoveryUnreadable = $state(false);
  const locked = $derived(busy || externalBusy);
  onMount(() => {
    try { const pending = readPendingTrainee(pendingStorage); if (pending) {
      username = pending.username; recovery = true;
    } } catch (cause) { recoveryUnreadable = true; error = String(cause); }
  });
  async function submit(event: SubmitEvent) {
    event.preventDefault(); if (locked || recoveryUnreadable) return;
    busy = true; onBusy(true); error = "";
    try {
      const result = await continueNewTrainee({ username, password, confirmation }, pendingStorage);
      password = ""; confirmation = ""; onContinue(result);
    } catch (cause) {
      error = factoryError(cause);
      try { recovery = !!readPendingTrainee(pendingStorage); } catch { recoveryUnreadable = true; }
    } finally { password = ""; confirmation = ""; busy = false; onBusy(false); }
  }
</script>
<section class="new-trainee"><h2>Create EveJS account</h2>
  <p>Create the account here, then create its character in Pilot Hangar.</p>
  {#if !worldID}<p role="status">A verified world identity is required to preserve account-creation recovery.</p>{/if}
  <form onsubmit={submit}>
    <label>Account name <input bind:value={username} required maxlength="64" autocomplete="off" disabled={locked || recovery} /></label>
    <label>Password <input type="password" bind:value={password} required autocomplete="new-password" disabled={locked} /></label>
    <label>Confirm password <input type="password" bind:value={confirmation} required autocomplete="new-password" disabled={locked} /></label>
    <p>Current EveJS account creation uses its development account policy and does not store a login password. Normal WC authentication is reused. These password fields are cleared after every attempt and are never saved in Pilot Training preferences.</p>
    {#if recovery}<p role="status">A previous creation needs confirmation. This action only checks its result and authenticates; it will not create again.</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <button disabled={locked || recoveryUnreadable || !username.trim() || !password || password !== confirmation}>{busy ? "Checking account…" : recovery ? "Check account status" : "Create account"}</button>
    <button type="button" class="minor" disabled={locked} onclick={() => { password = ""; confirmation = ""; onCancel(); }}>Cancel</button>
  </form>
</section>
<style>.new-trainee { border:1px solid #455569; padding:1rem; margin:1rem 0; max-width:48rem; } form { display:grid; gap:.8rem; } label { display:grid; gap:.3rem; } input { background:#16202e; color:#e4edf7; padding:.5rem; border:1px solid #455569; } p { margin:.3rem 0; } [role="alert"] { color:#fda4af; }</style>
