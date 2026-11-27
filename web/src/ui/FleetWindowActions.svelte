<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { BROADCAST_ICONS, BROADCAST_NAME_LABELS, FLEET_BAR_BROADCASTS, type FleetBarBroadcast } from "../bridge/fleetBroadcasts.ts";
  import { FLEET_CMDR_ROLES, isFleetCommander } from "../bridge/fleetCommand.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { FLEET_POINTERS } from "../play/uiPointer.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { noticeBoard } from "./notices.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { applyWindowFlags, setWindowFlag, windowFlags, WINDOW_ACTION_WORDS, type WindowFlag } from "./windowFlags.ts";

  let { store, flow, flat, onFlat, docked, onBroadcast, onBroadcastSettings, onWatchlist, onComposition }: {
    store: ClientStore;
    flow: AppFlow;
    flat: boolean;
    onFlat: (flat: boolean) => void;
    docked: boolean;
    onBroadcast: (name: FleetBarBroadcast) => void;
    onBroadcastSettings: () => void;
    onWatchlist: () => void;
    onComposition: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const { fleet, station, words } = store;
  const menu = new ContextMenu();
  const W = "/Carbon/UI/Controls/Window/";
  const F = "UI/Fleet/FleetWindow/";
  const participation = [
    ["acceptsFleetWarp", F + "AcceptFleetWarp", "Accept Fleet Warps"],
    ["acceptsConduitJumps", F + "AcceptConduitJumps", "Accept Conduit Jumps"],
    ["acceptsFleetRegroups", F + "AcceptRegroup", "Accept Fleet Regroups"],
  ] as const;
  let participationBusy = $state(false);
  const labels = {
    more: "UI/Common/More",
    form: F + "FormFleet",
    leave: "UI/Fleet/LeaveMyFleet",
    regroup: F + "Regroup",
    broadcasts: F + "Broadcasts",
    broadcastSettings: "UI/Fleet/FleetBroadcast/BroadcastSettings",
    travel: "UI/Fleet/FleetBroadcast/Commands/BroadcastTravelToMe",
    hierarchy: F + "ViewAsHierarchy",
    flat: F + "ViewAsFlatList",
    composition: F + "ShowFleetComposition",
    watchlist: F + "OpenFleetWatchlist",
  };
  function word(label: string, fallback: string): string {
    const text = $words.templates[label];
    return typeof text === "string" && text ? plainText(formatTemplate(text, {}, { nameOf: () => "" })) : fallback;
  }
  function action(label: string, fallback: string, run: () => void, icon?: string): ContextEntry {
    return { label: word(label, fallback), path: label, run, icon };
  }
  function run(work: Promise<unknown>): void {
    void work.catch(error => noticeBoard.post({ kind: "warn", title: "Fleet", detail: error instanceof Error ? error.message : String(error) }));
  }
  function show(event: MouseEvent): void {
    const flags = windowFlags("fleet");
    const option = (flag: WindowFlag, label: string, fallback: string, icon: string) =>
      action(W + label, fallback, () => setWindowFlag("fleet", flag, !flags[flag]),
        `res:/UI/Texture/eveicon/system_icons/${icon}_16px.png`);
    const rows: Array<ContextEntry | null> = [
      flags.locked ? option("locked", "Unlock", "Unlock window size and position", "locked") : option("locked", "Lock", "Lock window size and position", "unlocked"),
      flags.compact ? option("compact", "DisableCompactMode", "Disable compact mode", "uncompact") : option("compact", "EnableCompactMode", "Enable compact mode", "compact"),
      flags.nolight ? option("nolight", "EnableLightBackground", "Enable Light Background", "light_background_off") : option("nolight", "DisableLightBackground", "Disable Light Background", "light_background_on"),
      flags.collapsed ? option("collapsed", "Expand", "Expand", "expand") : option("collapsed", "Collapse", "Collapse", "collapse"),
    ];
    if ($fleet.availability === "not-in-fleet") {
      rows.push(null, action(labels.form, "Form Fleet", () => run(flow.formFleet())));
    } else if ($fleet.authoritativeFleetID !== null) {
      const fleetID = $fleet.authoritativeFleetID;
      const own = $fleet.fleet?.initState.value.members.find(member => Number(member.charID) === $station.online?.characterID);
      const commandRole = own && FLEET_CMDR_ROLES.includes(own.role);
      const broadcast = FLEET_BAR_BROADCASTS.map(name => action(
        BROADCAST_NAME_LABELS[name], name, () => onBroadcast(name), `res:/UI/Texture/${BROADCAST_ICONS[name]}`));
      if (commandRole) broadcast.push(action(labels.travel, "Broadcast: Travel To Me", () => run(flow.fleetMenuAction({ kind: "travelToMe" })),
        `res:/UI/Texture/${BROADCAST_ICONS.TravelTo}`));
      rows.push(null);
      if (commandRole) rows.push(action(labels.regroup, "Regroup", () => { if (!docked) run(flow.regroupFleet()); }));
      rows.push({ label: word(labels.broadcasts, "Broadcasts"), sub: broadcast }, null,
        action(labels.broadcastSettings, "Broadcast Settings", onBroadcastSettings),
        flat ? action(labels.hierarchy, "View as Hierarchy", () => onFlat(false)) :
          action(labels.flat, "View as Flat List", () => onFlat(true)), null);
      if (own && $fleet.availability === "ready") {
        rows.push(...participation.map(([key, label, fallback]) => {
          const checked = own.memberOptOuts[key];
          return {
            ...action(label, fallback, () => {
              if (participationBusy) return;
              participationBusy = true;
              run(flow.setFleetParticipation(fleetID, key, !checked).finally(() => { participationBusy = false; }));
            }),
            checkbox: true, checked, disabled: participationBusy ? "Updating fleet participation" : null,
          };
        }), null);
      }
      if (own && isFleetCommander(own)) rows.push(action(labels.composition, "Show Fleet Composition", onComposition));
      rows.push(action(labels.watchlist, "Open Fleet Watch List", onWatchlist),
        null, action(labels.leave, "Leave Fleet", () => run(flow.fleetMenuAction({ kind: "leave" }))));
    }
    const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
    menu.open(rect.left, rect.bottom, rows);
  }
  onMount(() => {
    applyWindowFlags("fleet");
    flow.requestWords([...WINDOW_ACTION_WORDS, ...Object.values(labels), ...participation.map(([, label]) => label),
      ...FLEET_BAR_BROADCASTS.map(name => BROADCAST_NAME_LABELS[name])]);
  });
  onDestroy(() => menu.close());
</script>

<button type="button" class="win-btn fleet-window-actions" data-ui-pointer={FLEET_POINTERS.settings}
  aria-label={word(labels.more, "More")} title={word(labels.more, "More")} aria-haspopup="menu"
  onpointerdown={(event) => event.stopPropagation()} onclick={show}>
  <img src={clientTexture("res:/UI/Texture/eveicon/system_icons/more_vertical_16px.png")} alt="" />
</button>

<style>
  .fleet-window-actions { display: grid; place-items: center; padding: 0; }
  img { width: 16px; height: 16px; }
</style>
