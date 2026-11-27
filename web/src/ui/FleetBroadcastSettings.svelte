<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { BROADCAST_NAME_LABELS } from "../bridge/fleetBroadcasts.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import {
    BROADCAST_FILTER_ROWS, BROADCAST_PALETTE, fleetBroadcastPreferences, listensToBroadcastRow,
    saveFleetBroadcastPreferences, type BroadcastFilterRow,
  } from "./fleetBroadcastPreferences.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const { session, words } = store;
  const L = "UI/Fleet/FleetBroadcast/";
  const extra = {
    help: L + "BroadcastSettingsHelp", recipient: L + "RecipientRange", global: L + "BroadcastRangeGlobal",
    system: L + "BroadcastRangeSystem", bubble: L + "BroadcastRangeBubble",
    own: L + "Commands/ShowOwnBroadcasts", event: L + "FleetEvent",
  };
  const bubble = new Set<BroadcastFilterRow>(["Target", "HealTarget", "HealArmor", "HealShield", "HealCapacitor"]);
  const system = new Set<BroadcastFilterRow>(["WarpTo", "AlignTo", "JumpTo"]);
  const account = $derived($session.accountID);
  const prefs = $derived(fleetBroadcastPreferences(account));

  $effect(() => { flow.requestWords([...Object.values(extra), ...Object.values(BROADCAST_NAME_LABELS)]); });
  function word(label: string, fallback: string): string {
    const text = $words.templates[label];
    return typeof text === "string" && text ? plainText(formatTemplate(text, {}, { nameOf: () => "" })) : fallback;
  }
  function title(name: BroadcastFilterRow): string {
    if (name === "ShowOwnBroadcasts") return word(extra.own, "Always Show My Own Broadcasts");
    if (name === "Event") return word(extra.event, "Fleet Event");
    return word(BROADCAST_NAME_LABELS[name], name.replace(/([a-z])([A-Z])/g, "$1 $2"));
  }
  function range(name: BroadcastFilterRow): string {
    if (name === "ShowOwnBroadcasts") return "";
    const caption = word(extra.recipient, "Recipient range");
    if (name === "Event") return `${caption}:`;
    const where = bubble.has(name) ? word(extra.bubble, "Proximity") :
      system.has(name) ? word(extra.system, "System") : word(extra.global, "Global");
    return `${caption}: ${where}`;
  }
  function setListen(name: BroadcastFilterRow, checked: boolean): void {
    saveFleetBroadcastPreferences(account, { ...$prefs, listen: { ...$prefs.listen, [name]: checked } });
  }
  function setColor(name: BroadcastFilterRow, value: string): void {
    const colors = { ...$prefs.colors };
    if (value === "") delete colors[name];
    else colors[name] = Number(value);
    saveFleetBroadcastPreferences(account, { ...$prefs, colors });
  }
</script>

<div class="broadcast-settings">
  <p>{word(extra.help, "Choose the fleet broadcasts to display and the color used in Broadcast History.")}</p>
  <ul>
    {#each BROADCAST_FILTER_ROWS as name (name)}
      {@const label = title(name)}
      {@const color = $prefs.colors[name]}
      <li data-broadcast-filter={name} title={range(name) || undefined}>
        <label><input type="checkbox" checked={listensToBroadcastRow($prefs, name)}
          onchange={event => setListen(name, event.currentTarget.checked)} />{label}</label>
        {#if name !== "ShowOwnBroadcasts"}
          <select aria-label={`${label} color`} value={color ?? ""}
            style:color={color === undefined ? undefined : `rgb(${BROADCAST_PALETTE[color]?.[1]})`}
            onchange={event => setColor(name, event.currentTarget.value)}>
            <option value="">No color</option>
            {#each BROADCAST_PALETTE as [name, rgb], index}
              <option value={index} style:color={`rgb(${rgb})`}>{name}</option>
            {/each}
          </select>
        {/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .broadcast-settings { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: .25rem; }
  p { margin: .25rem 0 .5rem; }
  ul { list-style: none; padding: 0; margin: 0; overflow: auto; }
  li { display: flex; min-height: 26px; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px; }
  li:nth-child(odd) { background: var(--color-row); }
  label { display: flex; gap: 6px; align-items: center; }
  select { width: 7rem; flex: none; }
</style>
