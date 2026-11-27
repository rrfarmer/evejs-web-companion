<script lang="ts">
  import { onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText, templateNameRefs } from "../bridge/clientWords.ts";
  import {
    BROADCAST_ICONS, BROADCAST_NAME_LABELS, FLEET_BAR_BROADCASTS, FLEET_SCOPE_LABELS,
    broadcastHistoryLabel, type FleetBarBroadcast,
  } from "../bridge/fleetBroadcasts.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import { FLEET_POINTERS } from "../play/uiPointer.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, onBroadcast }: {
    store: ClientStore;
    flow: AppFlow;
    onBroadcast: (name: FleetBarBroadcast) => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const scope = flow.broadcastScopeState;
  // svelte-ignore state_referenced_locally
  const { fleet, names, session, station, words } = store;
  const menu = new ContextMenu();
  const labels = {
    settings: "UI/Common/Settings",
    empty: "UI/Fleet/FleetBroadcast/NoBroadcasts",
    hint: "UI/Fleet/FleetBroadcast/BroadcastScopeHint",
    buttons: "UI/Fleet/FleetBroadcast/BroadcastButtonsToDisplay",
    recipients: "UI/Fleet/FleetBroadcast/WhoReceivesBroadcasts",
  } as const;
  const fallback = {
    EnemySpotted: "Enemy Spotted", HealArmor: "Need Armor", HealShield: "Need Shield", HealCapacitor: "Need Capacitor",
    InPosition: "In Position", NeedBackup: "Need Backup", HoldPosition: "Hold Position", Location: "Location",
  } satisfies Record<FleetBarBroadcast, string>;
  const scopeTexture = { 1: 28, 2: 27, 3: 29 } as const;
  const broadcasts = FLEET_BAR_BROADCASTS;
  const accountKey = $derived($session.accountID === null ? null : `evejs.user.${$session.accountID}.fleetFinderBroadcastsVisible`);
  const pilotKey = $derived($station.online ? `evejs.character.${$station.online.characterID}.fleetBroadcastHidden` : null);
  let expanded = $state(true);
  let hidden = $state<readonly FleetBarBroadcast[]>([]);
  let width = $state(0);
  const visible = $derived(broadcasts.filter(name => !hidden.includes(name)));
  const large = $derived(visible.length > 0 && width > visible.length * 40 + 50);
  const last = $derived($fleet.broadcastHistory?.[0] ?? null);
  const lastLabel = $derived(last ? broadcastHistoryLabel(last) : null);

  function word(label: string, own: string): string {
    const text = $words.templates[label];
    return typeof text === "string" && text ? text : own;
  }
  function labelOf(name: FleetBarBroadcast): string {
    return word(BROADCAST_NAME_LABELS[name], fallback[name]);
  }
  const scopeName = $derived(word(...FLEET_SCOPE_LABELS[$scope]));
  const scopeHint = $derived(plainText(formatTemplate(word(labels.hint, "Broadcast scope: {scope}"),
    { scope: scopeName }, { nameOf: () => "" })));
  const lastText = $derived(lastLabel ? plainText(formatTemplate(
    word(lastLabel.label, last ? BROADCAST_NAME_LABELS[last.name].split("/").at(-1) ?? "" : ""),
    lastLabel.args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") },
  )) : word(labels.empty, "No broadcasts"));

  $effect(() => {
    flow.requestWords([...Object.values(labels), ...Object.values(FLEET_SCOPE_LABELS).map(([label]) => label),
      ...broadcasts.map(name => BROADCAST_NAME_LABELS[name]), ...(lastLabel ? [lastLabel.label] : [])]);
  });
  $effect(() => {
    const template = lastLabel && $words.templates[lastLabel.label];
    if (lastLabel && typeof template === "string") {
      const refs = templateNameRefs(template, lastLabel.args);
      if (refs.length > 0) flow.requestNames(refs);
    }
  });
  $effect(() => {
    try {
      expanded = !accountKey || localStorage.getItem(accountKey) !== "true";
    } catch { expanded = true; }
  });
  $effect(() => {
    try {
      const saved: unknown = pilotKey ? JSON.parse(localStorage.getItem(pilotKey) ?? "[]") : [];
      hidden = Array.isArray(saved) ? broadcasts.filter(name => saved.includes(name)) : [];
    } catch { hidden = []; }
  });
  onDestroy(() => menu.close());

  function toggleBar(): void {
    expanded = !expanded;
    try { if (accountKey) localStorage.setItem(accountKey, String(!expanded)); } catch { /* Keep this session's choice. */ }
  }
  function toggleButton(name: FleetBarBroadcast): void {
    hidden = hidden.includes(name) ? hidden.filter(item => item !== name) : [...hidden, name];
    try { if (pilotKey) localStorage.setItem(pilotKey, JSON.stringify(hidden)); } catch { /* Keep this session's choice. */ }
  }
  function openSettings(event: MouseEvent): void {
    const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
    menu.open(rect.left, rect.bottom, [
      { label: word(labels.buttons, "Broadcast buttons to display"), caption: true },
      ...broadcasts.map(name => ({
        label: labelOf(name), checked: !hidden.includes(name), checkbox: true, run: () => toggleButton(name),
      })),
      null,
      { label: word(labels.recipients, "Who receives broadcasts"), caption: true },
      ...([3, 1, 2] as const).map(value => ({
        label: word(...FLEET_SCOPE_LABELS[value]), checked: $scope === value, run: () => flow.setBroadcastScope(value),
      })),
    ]);
  }
</script>

<div class="broadcast-bar">
  <div class="banner">
    <img src={clientTexture(last ? `res:/UI/Texture/${BROADCAST_ICONS[last.name]}` : "res:/UI/Texture/Icons/44_32_29.png")} alt="" />
    <span>{lastText}</span>
    <button type="button" data-ui-pointer={FLEET_POINTERS.broadcastToggle} aria-label="Show/hide fleet broadcasts"
      title="Show/hide fleet broadcasts" aria-expanded={expanded} onclick={toggleBar}>
      <img class:expanded src={clientTexture("res:/UI/Texture/classes/Neocom/arrowUp.png")} alt="" />
    </button>
  </div>
  {#if expanded}
    <div class="action-row" class:large data-ui-pointer={FLEET_POINTERS.broadcastIcons} bind:clientWidth={width}>
      {#each visible as name (name)}
        <button type="button" data-ui-pointer={name === "HealArmor" ? FLEET_POINTERS.needArmor : name === "HealShield" ? FLEET_POINTERS.needShield : undefined}
          aria-label={labelOf(name)} title={labelOf(name)} onclick={() => onBroadcast(name)}>
          <img src={clientTexture(`res:/UI/Texture/${large ? BROADCAST_ICONS[name].replace("/16/", "/32/") : BROADCAST_ICONS[name]}`)} alt="" />
        </button>
      {/each}
      <div class="options">
        <button type="button" data-ui-pointer={FLEET_POINTERS.broadcastScope} data-scope={$scope}
          aria-label={scopeHint} title={scopeHint} onclick={() => flow.cycleBroadcastScope()}>
          <img src={clientTexture(`res:/UI/Texture/Icons/73_16_${scopeTexture[$scope]}.png`)} alt="" />
        </button>
        <button type="button" class="broadcast-settings" aria-label={word(labels.settings, "Settings")}
          title={word(labels.settings, "Settings")} onclick={openSettings}>
          <img src={clientTexture("res:/UI/Texture/eveicon/system_icons/settings_wheel_16px.png")} alt="" />
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .broadcast-bar { position: sticky; bottom: 0; margin-top: 8px; padding: 3px 6px; border-top: 1px solid var(--color-row-line); background: #111b20; }
  .banner, .action-row, .options { display: flex; align-items: center; gap: 4px; }
  .banner { min-height: 18px; }
  .banner > span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .banner > img, .action-row img { width: 16px; height: 16px; }
  .banner button img { width: 7px; height: 7px; }
  .banner button img.expanded { transform: rotate(180deg); }
  .action-row { margin-top: 4px; flex-wrap: wrap; }
  .action-row.large > button > img { width: 32px; height: 32px; }
  .options { margin-left: auto; }
  button { box-sizing: border-box; display: grid; place-items: center; padding: 2px; border: 1px solid transparent; background: transparent; }
  button:hover, button:focus-visible { background: rgba(255, 255, 255, .1); border-color: rgba(255, 255, 255, .2); }
</style>
