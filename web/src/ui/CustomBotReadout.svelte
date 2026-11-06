<script lang="ts">
  // The running player-bot's readout, driven entirely by `store.customBot` — so
  // it shows the SAME thing whether you are docked (Bots launcher) or in space
  // (the HUD), and survives the shell switch that lost it in the first cut. It
  // renders nothing when no player bot is running.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { refusalLines } from "../nav/refusalLedger.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const customBot = store.customBot;

  const STATUS_WORD: Record<string, string> = {
    running: "Running",
    paused: "Paused",
    stopped: "Stopped",
    error: "Stopped after a problem",
  };
  const active = $derived($customBot.status === "running" || $customBot.status === "paused");

  // A clock of its own: a bot waiting out a backoff emits nothing, and its old
  // lines must still go.
  let now = $state(Date.now());
  $effect(() => {
    if ($customBot.status !== "running") return;
    now = Date.now();
    const clock = setInterval(() => { now = Date.now(); }, 5000);
    return () => clearInterval(clock);
  });
  const lines = $derived(refusalLines($customBot.refusals, $customBot.status === "running" ? now : null));

  // The manual override: stop the bot, bring the drones home, dock at the nearest
  // station. Its own busy flag (never the bot's status) so a slow dock does not
  // freeze the button, and re-clicking is harmless.
  let docking = $state(false);
  async function recallAndDock(): Promise<void> {
    if (docking) return;
    docking = true;
    try {
      await flow.panicRecallAndDock();
    } finally {
      docking = false;
    }
  }
</script>

{#if $customBot.status !== "idle"}
  <section class="panel custombot">
    <div class="panel-head">
      <h2>{$customBot.name ?? "Your bot"}</h2>
      <div class="controls">
        {#if active}
          {#if $customBot.status === "paused"}
            <button class="primary" onclick={() => flow.resumeCustomBot()}>Resume</button>
          {:else}
            <button onclick={() => flow.pauseCustomBot()}>Pause</button>
          {/if}
          <button class="danger" onclick={() => flow.stopCustomBot()}>Stop</button>
          <button class="override" disabled={docking} title="Stop the bot, bring drones home, dock at the nearest station" onclick={recallAndDock}>
            {docking ? "Docking…" : "Recall drones & dock"}
          </button>
        {/if}
        <span class="badge">{STATUS_WORD[$customBot.status] ?? $customBot.status}</span>
      </div>
    </div>
    {#if $customBot.phase}<p class="phase">{$customBot.phase}</p>{/if}
    {#if $customBot.note}<p class="why">{$customBot.note}</p>{/if}
    {#if $customBot.why}<p class="why">Why: {$customBot.why}</p>{/if}
    {#if $customBot.pauseReason}<p class="pause">{$customBot.pauseReason}</p>{/if}
    {#if lines.length > 0}
      <!-- What the server keeps turning down. THIS IS THE LINE THAT WAS
           MISSING: a bot answered 227 refusals over twelve hours while this
           panel showed nothing but "Taking what's inside." Worst first, and in
           the server's own words via describeRefusal — never a code. -->
      <div class="refusals">
        {#each lines as line (line.words)}
          <p class="refusal">
            {line.words}
            <span class="tally">({line.count} {line.count === 1 ? "time" : "times"})</span>
          </p>
        {/each}
      </div>
    {/if}
    {#if $customBot.lastAlert}
      <!-- The last "alert me" watch. Stays on screen after the notification has
           gone, so a player who missed the pop-up still sees what happened. -->
      <p class="alert">⚠ {$customBot.lastAlert.message}</p>
    {/if}
  </section>
{/if}

<style>
  .custombot .phase {
    color: var(--color-text-bright);
    font-weight: 600;
    margin: 0.3rem 0 0;
  }
  .custombot .why {
    color: var(--color-text);
    font-size: 0.9rem;
    margin: 0.2rem 0 0;
  }
  .custombot .pause {
    color: var(--color-warn);
    margin: 0.3rem 0 0;
  }
  .custombot .refusals {
    max-height: 7rem;
    overflow-y: auto;
  }
  .custombot .refusal {
    color: var(--color-warn);
    font-size: 0.9rem;
    margin: 0.2rem 0 0;
  }
  .custombot .refusal .tally {
    color: var(--color-muted);
    margin-left: 0.3rem;
  }
  .custombot .alert {
    color: var(--color-accent);
    border-left: 2px solid var(--color-accent);
    padding-left: 0.4rem;
    margin: 0.3rem 0 0;
  }
  .custombot button {
    min-height: 40px;
  }
  .custombot button.override {
    border-color: var(--color-warn);
    color: var(--color-warn);
  }
</style>
