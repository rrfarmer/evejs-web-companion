<!-- WC74 web/src/ui/MiningCommandCenter.svelte @ 213da333; plugin routing adapted. -->
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { openPageAccount } from "../app/api.ts";
  import { whilePageVisible } from "../app/pageVisibility.ts";
  import { workspacePreference } from "../app/sessionToken.ts";
  import MiningOperations from "./MiningOperations.svelte";
  import CivilianMissions from "./CivilianMissions.svelte";
  import CenterHeading from "./CenterHeading.svelte";

  let {
    initialSection,
    operatorAccount,
  }: { initialSection?: "civilian" | "operations"; operatorAccount?: string } = $props();
  let section = $state(
    untrack(
      () =>
        initialSection ??
        (typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("section") === "civilian"
          ? "civilian"
          : "operations"),
    ),
  );

  const preference = workspacePreference("uoc:restored:mining-workspace:v1");
  type Workspace = NonNullable<Awaited<ReturnType<typeof openPageAccount>>>;
  let workspace = $state.raw<Workspace | null>(null);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let operationBusy = $state(false);
  let sessionExpired = $state(false);

  let visible: AbortSignal | undefined;
  onMount(() => {
    if (section === "operations")
      return whilePageVisible((signal) => {
        visible = signal;
        if (!workspace) void connect();
        return () => {
          busy = false;
        };
      });
  });

  async function connect(): Promise<void> {
    const signal = visible;
    if (!signal || signal.aborted) return;
    busy = true;
    error = null;
    try {
      const selected = await openPageAccount(operatorAccount, preference.read(), signal);
      if (!selected || signal.aborted) return;
      workspace = selected;
      preference.remember(selected.account);
      sessionExpired = false;
    } catch (cause) {
      if (!signal.aborted)
        error = cause instanceof Error ? cause.message : "The WC Account could not be verified.";
    } finally {
      if (!signal.aborted) busy = false;
    }
  }
</script>

<svelte:head><title>Mining Command Center · EveJS Web Companion</title></svelte:head>
<main class="uoc-center">
  <CenterHeading title="Mining Command Center" />
  <nav class="center-tabs" aria-label="Mining Command Center sections">
    <a
      href="/uoc/mining-command-center/"
      aria-current={section === "operations" ? "page" : undefined}>Mining Operations</a
    >
    <a
      href="/uoc/mining-command-center/?section=civilian"
      aria-current={section === "civilian" ? "page" : undefined}>Civilian Missions</a
    >
  </nav>
  {#if section === "civilian"}
    <CivilianMissions {operatorAccount} />
  {:else}
    {#if !workspace || sessionExpired || error}<section class="workspace-account center-panel">
        {#if sessionExpired}<p>Showing the last known fleet status.</p>{/if}
        {#if !workspace || sessionExpired}
          <p>Fleet access uses the saved WC accounts in this browser.</p>
          <button type="button" disabled={busy || operationBusy} onclick={() => void connect()}
            >Refresh access</button
          >
        {/if}
        {#if error}<p class="center-message" role="alert">{error}</p>{/if}
      </section>{/if}
    {#if workspace}
      {#key workspace}
        <MiningOperations
          accountName={workspace.account}
          access={workspace.options}
          onBusyChange={(busy) => {
            operationBusy = busy;
          }}
          onAuthExpired={() => {
            sessionExpired = true;
          }}
        />
      {/key}
    {/if}
  {/if}
</main>

<style>
  p {
    margin: 0.2rem 0 0.6rem;
  }
  .workspace-account {
    margin-bottom: 1rem;
  }
</style>
