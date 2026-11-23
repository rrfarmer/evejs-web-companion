<script lang="ts">
  import { onDestroy } from "svelte";
  import type { PluginPageProps } from "../../../web/src/plugin-api/index.ts";
  import { createTrainingAccountPass } from "../training/accountPass.ts";
  import "./page.css";
  import ModulePage from "./ModulePage.svelte";
  import { resolveUocPage } from "./route.ts";

  let { sessions, activeSession }: PluginPageProps = $props();
  const page = resolveUocPage(location.pathname, location.search);
  // Account-only authorization keeps a UOC action from taking the launching tab's held pilot.
  const readPageAccounts = () => [
    ...(activeSession ? [activeSession.accountName] : []),
    ...sessions.map(session => session.accountName),
  ];
  const accountPass = createTrainingAccountPass();
  onDestroy(() => { void accountPass.release(); });
</script>

<div class="standalone-uoc">
  {#if page}
    <ModulePage {page} {accountPass} {readPageAccounts} />
  {:else}
    <p>Operations Center page unavailable. <a href="/uoc/">Open UOC</a></p>
  {/if}
</div>

<style>
  .standalone-uoc { min-height: 100vh; background: #05080d; }
</style>
