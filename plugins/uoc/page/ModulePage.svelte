<script lang="ts">
  import { untrack } from "svelte";
  import type { GlobalWindowProps, PluginPagePilot } from "../../../web/src/plugin-api/index.ts";
  import type { AccountPass } from "../compat/accounts.ts";
  import { resolveUocPage, type UocPage } from "./route.ts";
  import UnifiedOperations from "../restored/ui/UnifiedOperations.svelte";
  import MiningCommandCenter from "../restored/ui/MiningCommandCenter.svelte";
  import CenterHeading from "../restored/ui/CenterHeading.svelte";
  import CenterStatus from "../restored/ui/CenterStatus.svelte";
  import GoblinFactory from "../restored/ui/GoblinFactory.svelte";
  import DistributionCenter from "../restored/ui/DistributionCenter.svelte";
  import ProvisioningCenter from "../restored/ui/ProvisioningCenter.svelte";
  import {
    installPageContext,
    authenticatedJson,
    runHosted,
    worldID,
    type AuthenticatedAccount,
  } from "../restored/app/context.ts";
  import { removeLegacyControllerToken } from "../restored/app/sessionToken.ts";
  import { installTrainingAdapter } from "../restored/adapters/training.ts";
  import "../restored/theme.css";
  let {
    page,
    sessions = [],
    readSessions,
    readAccounts,
    readPagePilots,
    accountPass,
    operatorAccount,
  }: {
    page: UocPage;
    sessions?: GlobalWindowProps["sessions"];
    readSessions?: () => GlobalWindowProps["sessions"];
    readAccounts?: () => readonly AuthenticatedAccount[];
    readPagePilots?: () => readonly PluginPagePilot[];
    accountPass?: AccountPass;
    operatorAccount?: string;
  } = $props();
  let activePage = $state(untrack(() => page));
  const operatorToken = $derived(
    readPagePilots?.().find((p) => p.accountName === operatorAccount)?.token,
  );
  const screen = $derived([activePage, operatorAccount, operatorToken]);
  let observation = new AbortController();
  function renewObservation() {
    observation.abort();
    observation = new AbortController();
  }
  $effect(() => {
    activePage = page;
  });
  const standalone =
    typeof location !== "undefined" && resolveUocPage(location.pathname, location.search) !== null;
  function navigate(event: MouseEvent) {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (
      !anchor ||
      anchor.target ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    )
      return;
    const url = new URL(anchor.href, location.href),
      target = resolveUocPage(url.pathname, url.search);
    if (url.origin !== location.origin || !target) return;
    event.preventDefault();
    if (standalone && url.href !== location.href) history.pushState(null, "", url.href);
    activePage = target;
  }
  function restorePage() {
    if (standalone) activePage = resolveUocPage(location.pathname, location.search) ?? page;
  }
  removeLegacyControllerToken();
  installTrainingAdapter({ authenticatedJson, runHosted, worldID });
  function install() {
    installPageContext({
      sessions: readSessions ?? (() => sessions),
      readAccounts,
      readPagePilots,
      accountPass,
      observationSignal: () => observation.signal,
    });
  }
  untrack(install);
  $effect.pre(() => {
    void screen;
    install();
    if (observation.signal.aborted) renewObservation();
    return () => observation.abort();
  });
</script>

<svelte:window
  onpopstate={restorePage}
  onpagehide={(event) => {
    if (!event.persisted) observation.abort();
  }}
/>
<div class="uoc-wc74" role="presentation" onclick={navigate}>
  {#key screen}
    {#if activePage === "home"}
      <UnifiedOperations />
    {:else if activePage === "mining-operations" || activePage === "civilian"}
      <MiningCommandCenter
        initialSection={activePage === "civilian" ? "civilian" : "operations"}
        {operatorAccount}
      />
    {:else if activePage === "combat-in-development"}
      <main class="uoc-center">
        <CenterHeading title="Combat Operations Center" />
        <CenterStatus state="In development" />
      </main>
    {:else if activePage === "training"}
      <GoblinFactory onTraineeChange={renewObservation} />
    {:else if activePage === "distribution"}
      <DistributionCenter {operatorAccount} />
    {:else}
      <ProvisioningCenter />
    {/if}
  {/key}
</div>
