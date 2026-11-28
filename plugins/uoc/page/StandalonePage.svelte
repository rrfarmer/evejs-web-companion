<script lang="ts">
  import { onDestroy } from "svelte";
  import type { PluginPageProps } from "../../../web/src/plugin-api/index.ts";
  import { createTrainingAccountPass } from "../training/accountPass.ts";
  import "./page.css";
  import ModulePage from "./ModulePage.svelte";
  import { resolveUocPage } from "./route.ts";

  let { sessions, activeSession }: PluginPageProps = $props();
  const page = resolveUocPage(location.pathname, location.search);
  const operatorAccount = $derived(activeSession?.accountName ?? sessions[0]?.accountName);
  let linked = $state(false);
  const disconnected = $derived(linked && !operatorAccount);
  $effect.pre(() => {
    if (operatorAccount) linked = true;
  });
  function useSavedAccounts() {
    linked = false;
  }
  const readPagePilots = () => sessions;
  const accountPass = createTrainingAccountPass();
  onDestroy(() => {
    void accountPass.release();
  });
</script>

<div class="standalone-uoc">
  {#if !page}
    <p>Operations Center page unavailable. <a href="/uoc/">Open UOC</a></p>
  {:else if disconnected}
    <p role="status">The linked Web Companion account disconnected.</p>
    <button type="button" onclick={useSavedAccounts}>Use saved WC accounts</button>
  {:else}
    <ModulePage {page} {accountPass} {readPagePilots} {operatorAccount} />
  {/if}
</div>

<style>
  .standalone-uoc {
    min-height: 100vh;
    background: #05080d;
  }
</style>
