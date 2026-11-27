<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { BROADCAST_NAME_LABELS } from "../bridge/fleetBroadcasts.ts";
  import { FLEET_BROADCAST_SETTINGS_DRAG } from "../bridge/fleetBroadcastSettingsLink.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import {
    BROADCAST_FILTER_ROWS, BROADCAST_PALETTE, broadcastColorCss, broadcastColorValue, broadcastShareName,
    fleetBroadcastPreferences, listensToBroadcastRow, saveBroadcastShareName, saveFleetBroadcastPreferences, sharedBroadcastRows, type BroadcastFilterRow,
  } from "./fleetBroadcastPreferences.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const { session, station, words } = store;
  const L = "UI/Fleet/FleetBroadcast/";
  const extra = {
    help: L + "BroadcastSettingsHelp", recipient: L + "RecipientRange", global: L + "BroadcastRangeGlobal",
    system: L + "BroadcastRangeSystem", bubble: L + "BroadcastRangeBubble",
    own: L + "Commands/ShowOwnBroadcasts", event: L + "FleetEvent",
    share: L + "SharedBroadcastSettings", shareHint: L + "ShareBroadcastSettingsHint",
  };
  const bubble = new Set<BroadcastFilterRow>(["Target", "HealTarget", "HealArmor", "HealShield", "HealCapacitor"]);
  const system = new Set<BroadcastFilterRow>(["WarpTo", "AlignTo", "JumpTo"]);
  const account = $derived($session.accountID);
  const prefs = $derived(fleetBroadcastPreferences(account));
  const pilot = $derived($station.online);
  let shareName = $state("");
  $effect(() => { shareName = pilot ? broadcastShareName(pilot.characterID) : ""; });
  const defaultShareName = $derived(pilot ? plainText(formatTemplate(
    typeof $words.templates[extra.share] === "string" ? $words.templates[extra.share] : "{charID}'s Broadcast Settings",
    { charID: pilot.characterID }, { nameOf: () => pilot.characterName },
  )) : "Broadcast Settings");
  onMount(() => {
    const received = (event: Event) => {
      if (pilot && (event as CustomEvent<{ character: number }>).detail?.character === pilot.characterID) {
        shareName = broadcastShareName(pilot.characterID);
      }
    };
    window.addEventListener("evejs:fleet-broadcast-settings", received);
    return () => window.removeEventListener("evejs:fleet-broadcast-settings", received);
  });

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
    else if (value !== "shared") colors[name] = Number(value);
    saveFleetBroadcastPreferences(account, { ...$prefs, colors });
  }
  function startShare(event: DragEvent): void {
    if (!event.dataTransfer || !pilot) return;
    const text = (shareName.trim() || defaultShareName).slice(0, 60);
    event.dataTransfer.setData(FLEET_BROADCAST_SETTINGS_DRAG, JSON.stringify({ text, rows: sharedBroadcastRows($prefs) }));
    event.dataTransfer.effectAllowed = "copy";
  }
</script>

<div class="broadcast-settings">
  <p>{word(extra.help, "Choose the fleet broadcasts to display and the color used in Broadcast History.")}</p>
  <ul>
    {#each BROADCAST_FILTER_ROWS as name (name)}
      {@const label = title(name)}
      {@const color = $prefs.colors[name]}
      {@const rgb = broadcastColorValue(color)}
      <li data-broadcast-filter={name} title={range(name) || undefined}>
        <label><input type="checkbox" checked={listensToBroadcastRow($prefs, name)}
          onchange={event => setListen(name, event.currentTarget.checked)} />{label}</label>
        {#if name !== "ShowOwnBroadcasts"}
          <select aria-label={`${label} color`} value={typeof color === "number" ? color : color ? "shared" : ""}
            style:color={rgb ? `rgb(${broadcastColorCss(rgb)})` : undefined}
            onchange={event => setColor(name, event.currentTarget.value)}>
            <option value="">No color</option>
            {#if Array.isArray(color)}<option value="shared">Shared color</option>{/if}
            {#each BROADCAST_PALETTE as [name, rgb], index}
              <option value={index} style:color={`rgb(${broadcastColorCss(rgb)})`}>{name}</option>
            {/each}
          </select>
        {/if}
      </li>
    {/each}
  </ul>
  {#if pilot}
    <div class="broadcast-share">
      <input aria-label="Broadcast settings link name" maxlength="60" placeholder={defaultShareName} bind:value={shareName}
        onchange={() => { if (pilot) saveBroadcastShareName(pilot.characterID, shareName); }} />
      <button type="button" draggable="true" title={word(extra.shareHint, "Drag into chat or mail to share these settings.")}
        ondragstart={startShare}>Share</button>
    </div>
  {/if}
</div>

<style>
  .broadcast-settings { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: .25rem; }
  p { margin: .25rem 0 .5rem; }
  ul { list-style: none; padding: 0; margin: 0; overflow: auto; }
  li { display: flex; min-height: 26px; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px; }
  li:nth-child(odd) { background: var(--color-row); }
  label { display: flex; gap: 6px; align-items: center; }
  select { width: 7rem; flex: none; }
  .broadcast-share { display: flex; gap: 6px; justify-content: flex-end; margin-top: auto; }
  .broadcast-share input { flex: 1; min-width: 0; }
</style>
