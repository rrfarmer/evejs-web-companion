<script lang="ts">
  // THE PLUGINS WINDOW — what this client adds beyond the game's own windows.
  //
  // One row per plugin this build carries: what it adds, whether it loaded into
  // this page and, when it did not, why. A plugin is switched on or off here,
  // for this browser; the switch takes effect when the page next loads, because
  // a plugin's windows and blocks are registered before the first paint and a
  // running bot must never lose a block under it.
  //
  // ⚠ A FAILED PLUGIN IS SAID, NEVER HIDDEN. Its reason is printed on its row
  // (web/src/plugins/pluginHost.ts), and everything else carries on.
  //
  // Its backend's state, where it has one, is the BFF's word (GET /api/plugins):
  // whether its process is running, and how often it has been restarted. It is
  // asked on the session of a pilot already signed in here, and never by
  // signing anybody in: a sign-in closes the account's other clients.
  import { onMount } from "svelte";
  import { loadDisabledPlugins, pagePluginStatuses, saveDisabledPlugin, type PluginStatus } from "../plugins/pluginHost.ts";
  import { listPluginBackends, type PluginBackendStatus } from "../app/api.ts";
  import type { GlobalWindowProps } from "./pluginWindowViews.ts";

  let { sessions = [] }: GlobalWindowProps = $props();

  const statuses: readonly PluginStatus[] = pagePluginStatuses();
  let switchedOff = $state(new Set(loadDisabledPlugins()));
  let backends = $state<readonly PluginBackendStatus[] | null>(null);
  let backendError = $state<string | null>(null);

  const STATE_WORDS: Readonly<Record<PluginStatus["state"], string>> = {
    active: "On",
    disabled: "Off",
    incompatible: "Needs an update",
    failed: "Did not load",
  };

  const BACKEND_WORDS: Readonly<Record<string, string>> = {
    running: "Running",
    starting: "Starting",
    restarting: "Restarting",
    failed: "Stopped after failing",
    stopped: "Stopped",
  };

  function toggle(id: string, on: boolean): void {
    saveDisabledPlugin(id, !on);
    switchedOff = loadDisabledPlugins();
  }

  function pending(status: PluginStatus): boolean {
    const off = switchedOff.has(status.id);
    return (status.state === "disabled") !== off && (status.state === "active" || status.state === "disabled");
  }

  function addsWords(status: PluginStatus): string {
    // A plugin switched off was not run, so what it adds is not known here.
    if (status.state === "disabled") return "";
    const parts: string[] = [];
    if (status.windows > 0) parts.push(status.windows === 1 ? "1 window" : `${status.windows} windows`);
    if (status.macros > 0) parts.push(status.macros === 1 ? "1 bot block" : `${status.macros} bot blocks`);
    if (status.hasBackend) parts.push("a server part");
    return parts.length === 0 ? "Adds nothing yet." : `Adds ${parts.join(", ")}.`;
  }

  onMount(() => {
    // Only when a plugin has a server part: otherwise there is nothing to ask.
    if (!statuses.some((status) => status.hasBackend)) return;
    const online = sessions.find((session) => session.store.station.get().online !== null) ?? null;
    if (online === null) {
      backendError = "shown once a pilot is signed in here.";
      return;
    }
    listPluginBackends(online.flow.requestOptions())
      .then((rows) => {
        backends = rows;
      })
      .catch(() => {
        backendError = "could not be read just now.";
      });
  });
</script>

<section class="panel plugin-manager">
  {#if statuses.length === 0}
    <p class="empty">This client carries no plugins. It is the game's own windows and the bot builder.</p>
  {:else}
    <p class="note">Plugins add to the client; they never change the game's own windows. A plugin that fails stops only itself.</p>
    <ul class="plugin-list">
      {#each statuses as status (status.id)}
        {@const backend = backends?.find((entry) => entry.id === status.id) ?? null}
        <li class="plugin-row">
          <div class="plugin-head">
            <span class="plugin-name">{status.name}</span>
            <span class="plugin-version">{status.version}</span>
            <span class={`plugin-state ${status.state}`}>{STATE_WORDS[status.state]}</span>
            {#if status.state === "active" || status.state === "disabled"}
              <label class="plugin-switch">
                <input
                  type="checkbox"
                  checked={!switchedOff.has(status.id)}
                  onchange={(event) => toggle(status.id, (event.currentTarget as HTMLInputElement).checked)}
                />
                Use in this browser
              </label>
            {/if}
          </div>
          <p class="plugin-does">{status.description} {addsWords(status)}</p>
          {#if status.error !== null}
            <p class="plugin-error">{status.error}</p>
          {/if}
          {#if pending(status)}
            <p class="note">Takes effect the next time this page loads.</p>
          {/if}
          {#if status.hasBackend}
            {#if backend !== null}
              <p class="plugin-backend">
                Server part: {BACKEND_WORDS[backend.state] ?? backend.state}{backend.restarts > 0 ? `, restarted ${backend.restarts} ${backend.restarts === 1 ? "time" : "times"}` : ""}{backend.error ? `. ${backend.error}` : "."}
              </p>
            {:else if backendError !== null}
              <p class="plugin-backend">Server part: {backendError}</p>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .plugin-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .plugin-row {
    border: 1px solid var(--line, #2a3440);
    padding: 0.5rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .plugin-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
  }
  .plugin-name {
    font-weight: 600;
  }
  .plugin-version,
  .plugin-backend,
  .plugin-does {
    opacity: 0.8;
    margin: 0;
  }
  .plugin-state.failed,
  .plugin-state.incompatible,
  .plugin-error {
    color: var(--bad, #e07a6a);
  }
  .plugin-error {
    margin: 0;
  }
  .plugin-switch {
    margin-left: auto;
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
  }
</style>
