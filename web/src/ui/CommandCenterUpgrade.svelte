<script lang="ts">
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import { COMMAND_CENTER_LEVELS, MAX_COMMAND_CENTER_LEVEL, commandCenterLevelName, commandCenterUpgradeCost, commandCenterUpgradeError,
    type CommandCenterUpgradeQuote } from "../bridge/commandCenterUpgrade.ts";

  let { level, pendingCost, flow, disabled, refresh, stage, close }: {
    level: number; pendingCost: number; flow: AppFlow; disabled: boolean; refresh: number;
    stage: (level: number) => void; close: () => void;
  } = $props();

  let selected = $state<number | null>(null);
  let quote = $state.raw<CommandCenterUpgradeQuote | null>(null);
  let readError = $state("");
  const current = $derived(COMMAND_CENTER_LEVELS[level]);
  const targetLevel = $derived(selected !== null && selected > level ? selected : null);
  const target = $derived(targetLevel === null ? undefined : COMMAND_CENTER_LEVELS[targetLevel]);
  const max = COMMAND_CENTER_LEVELS[MAX_COMMAND_CENTER_LEVEL]!;
  const refusal = $derived(quote && targetLevel !== null ? commandCenterUpgradeError(level, targetLevel, quote, pendingCost) : "");

  $effect(() => {
    refresh;
    let active = true;
    quote = null;
    readError = "";
    void flow.readCommandCenterUpgrade().then(result => {
      if (active) quote = result;
    }).catch(cause => { if (active) readError = errorWords(cause); });
    return () => { active = false; };
  });
</script>

<section class="command-upgrade" aria-label="Command Centre Upgrade">
  <header>
    <strong>Upgrade Command Centre</strong>
    <button type="button" aria-label="Close upgrade panel" onclick={close}>×</button>
  </header>
  <div class="levels" role="group" aria-label="Upgrade level">
    {#each COMMAND_CENTER_LEVELS as _, index}
      <button type="button" disabled={index <= level || disabled} aria-label={`Select upgrade level ${commandCenterLevelName(index)}`}
        aria-pressed={targetLevel === index} class:current={index <= level}
        class:proposed={targetLevel !== null && index > level && index <= targetLevel}
        class:untrained={quote && index > quote.skillLevel && index > level}
        onclick={() => { selected = index; }}>{commandCenterLevelName(index)}</button>
    {/each}
  </div>
  {#if readError}<p role="alert">{readError}</p>
  {:else if level >= MAX_COMMAND_CENTER_LEVEL}<p role="status">Maximum upgrade level reached.</p>
  {:else if !quote}<p role="status">Checking skill level and wallet…</p>
  {:else if refusal}<p role="status">{refusal}</p>
  {:else if targetLevel !== null}<p role="status">Upgrade from {commandCenterLevelName(level)} to {commandCenterLevelName(targetLevel)}</p>
  {:else}<p role="status">No upgrade selected.</p>{/if}
  {#if current}
    <div class="outputs">
      {#each [{ name: "Power Output", unit: "MW", key: "power" }, { name: "CPU Output", unit: "tf", key: "cpu" }] as topic (topic.key)}
        {@const key = topic.key === "power" ? "power" : "cpu"}
        {@const value = target?.[key] ?? current[key]}
        <div class:cpu={key === "cpu"}>
          <span>{topic.name}</span>
          <div class="gauge" role="meter" aria-label={topic.name} aria-valuemin={0} aria-valuemax={max[key]} aria-valuenow={value}>
            <i style:width={`${100 * current[key] / max[key]}%`}></i>
            <i class="gain" style:width={`${100 * (value - current[key]) / max[key]}%`}></i>
          </div>
          <span>{value.toLocaleString()} {topic.unit}</span>
          {#if target}<small>+{(value - current[key]).toLocaleString()} {topic.unit}</small>{/if}
        </div>
      {/each}
    </div>
  {/if}
  <footer>
    <span>Cost <strong>{targetLevel === null ? "—" : `${commandCenterUpgradeCost(level, targetLevel).toLocaleString()} ISK`}</strong></span>
    <button type="button" disabled={disabled || !quote || targetLevel === null || Boolean(refusal)}
      onclick={() => { if (targetLevel !== null) stage(targetLevel); }}>Upgrade</button>
  </footer>
</section>

<style>
  .command-upgrade { display: grid; gap: 8px; padding: 9px; border: 1px solid #819fad44; }
  header, footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .levels { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 3px; }
  button { border: 1px solid #536673; background: #283643; color: inherit; font: inherit; padding: 5px 7px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .levels .current { opacity: 1; background: #436975; }
  .levels .untrained { border-color: #775451; background: #38282b; }
  .levels .proposed:not(.untrained) { background: #467655; }
  .levels .proposed.untrained { border-color: #ef9487; }
  p { margin: 0; }
  [role=alert] { color: #ffca83; }
  .outputs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .outputs > div { display: grid; gap: 3px; }
  .gauge { height: 6px; display: flex; background: #30434d; }
  .gauge i { display: block; height: 100%; background: #bb7458; }
  .cpu .gauge i { background: #679caf; }
  .gauge .gain, .cpu .gauge .gain { background: #83c691; }
  small { color: #b4ddb8; }
</style>
