<script lang="ts">
  // The fleet window's History (fleetbroadcast.py BroadcastHistoryPanel): a choice of All, Broadcast History, Member
  // History and Loot History (the last kept by the pilot's settings, Broadcast History at first), a Clear, and the
  // events newest first, each in the client's words: "Event", the time and the event's own label (fleetSvc.AddBroadcast
  // makes a broadcast's). WantBroadcast grants the own-broadcast override before checking the type preference.
  import { getContext, onDestroy } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { assetSearchTextForType } from "../bridge/assetSearch.ts";
  import { QUANTITY_AND_ITEM, formatTemplate, plainText, templateNameRefs } from "../bridge/clientWords.ts";
  import { COMPARE_CATEGORIES } from "../bridge/dogmaAttributeGroups.ts";
  import { broadcastHistoryLabel, fleetTravelDestination, type FleetBroadcast } from "../bridge/fleetBroadcasts.ts";
  import { fleetLootTime, type FleetLootEntry } from "../bridge/fleetLoot.ts";
  import { memberHistoryLabel, type FleetMemberHistoryEntry } from "../bridge/fleetMemberHistory.ts";
  import { FLEET_POINTERS } from "../play/uiPointer.ts";
  import { ContextMenu, type ContextEntry } from "../play/contextMenu.ts";
  import { fleetBroadcastColor, fleetBroadcastPreferences, listensToBroadcastRow, saveFleetBroadcastPreferences, wantsFleetBroadcast } from "./fleetBroadcastPreferences.ts";
  import { findInPersonalAssets } from "./assetsSearch.ts";
  import { findInContracts } from "./contractsSearch.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import { showInfo } from "./showInfo.ts";
  import { compareType } from "./typeCompare.ts";
  import { notify } from "./notices.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import type { JsonValue } from "../bridge/wire.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const fleet = store.fleet;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const space = store.space;
  const flight = $derived(store.flight);
  const targeting = $derived(store.targeting);
  // svelte-ignore state_referenced_locally
  const session = store.session;
  const preferences = $derived(fleetBroadcastPreferences($session.accountID));
  const memberMenu = getContext<((flow: AppFlow, characterID: number) => ContextEntry | null) | undefined>("fleetHistoryMemberMenu");
  const openIndustry = getContext<(() => void) | undefined>("openFleetHistoryIndustry");
  const menu = new ContextMenu();
  let menuRequest = 0;
  onDestroy(() => { menuRequest++; menu.close(); });

  const WORDS = {
    all: "UI/Common/All",
    broadcasts: "UI/Fleet/FleetBroadcast/BroadcastHistory",
    members: "UI/Fleet/FleetBroadcast/MemberHistory",
    loot: "UI/Fleet/FleetBroadcast/LootHistory",
    clear: "UI/Accessories/Calculator/Clear",
    none: "UI/Fleet/FleetBroadcast/NoEventsYet",
    event: "UI/Fleet/FleetBroadcast/Event",
    targetWithType: "UI/Fleet/FleetBroadcast/BroadcastEventTargetWithType",
    healTargetWithType: "UI/Fleet/FleetBroadcast/BroadcastEventHealTargetWithType",
    lootEvent: "UI/Fleet/FleetBroadcast/BroadcastEventLoot",
  } as const;
  const MENU_WORDS = {
    info: ["UI/Commands/ShowInfo", "Show Info"],
    industry: ["UI/Industry/ViewInIndustry", "View in Industry"],
    market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
    contracts: ["UI/Inventory/ItemActions/FindInContracts", "Find in Contracts"],
    assets: ["UI/Inventory/ItemActions/FindPersonalAssets", "Find in Personal Assets"],
    compare: ["UI/Compare/CompareButton", "Compare"],
    destination: ["UI/Inflight/SetDestination", "Set Destination"],
    add: ["UI/Inflight/AddWaypoint", "Add Waypoint"],
    remove: ["UI/Inflight/RemoveWaypoint", "Remove Waypoint"],
    distance: ["UI/Fleet/FleetSubmenus/ShowDistance", "Show Distance"],
    ignore: ["UI/Fleet/FleetBroadcast/IgnoreBroadcast", "Ignore Broadcast"],
    unignore: ["UI/Fleet/FleetBroadcast/UnignoreBroadcast", "Unignore Broadcast"],
    lock: ["UI/Inflight/LockTarget", "Lock Target"],
    align: ["UI/Inflight/AlignTo", "Align To"],
    warp: ["UI/Inflight/WarpToBookmark", "Warp To"],
    within: ["UI/Inflight/Submenus/WarpToWithin", "Warp to Within"],
  } as const;
  const EXACT = "UI/Inventory/AssetSearch/KeywordTypeExact";
  const CELESTIAL_CATEGORIES = new Set([2, 23, 3, 6, 11, 18, 25, 22, 40, 65, 87, 46]);
  const WARP_RANGES = [0, 10_000, 20_000, 30_000, 50_000, 70_000, 100_000];
  type Filter = "all" | "broadcasthistory" | "memberhistory" | "loothistory";
  /** settings.user.ui 'fleetHistoryFilter' (PostStartup, 51): the choice kept, Broadcast History at first. */
  const FILTER_KEY = "evejs.fleet.historyFilter";
  function keptFilter(): Filter {
    try {
      const kept = localStorage.getItem(FILTER_KEY);
      return kept === "all" || kept === "memberhistory" || kept === "loothistory" ? kept : "broadcasthistory";
    } catch {
      return "broadcasthistory";
    }
  }
  let filter = $state<Filter>(keptFilter());
  function choose(value: Filter): void {
    menuRequest++;
    menu.close();
    filter = value;
    try {
      localStorage.setItem(FILTER_KEY, value);
    } catch {
      // A browser that keeps nothing: the choice lasts as long as the window.
    }
  }

  function word(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" ? template : own;
  }
  function nameOf(kind: NameKind, id: number): string {
    return resolvedName($names.resolved, kind, id, "");
  }

  const me = $derived($station.online?.characterID ?? null);
  const heard = $derived(($fleet.broadcastHistory ?? []).filter(broadcast => wantsFleetBroadcast($preferences, broadcast, me)));
  const shown = $derived.by(() => {
    const broadcasts = filter === "broadcasthistory" || filter === "all" ? heard.map(broadcast => ({
      broadcast, at: broadcast.receivedAtMs, key: `${broadcast.receivedAtMs}:${broadcast.name}:${broadcast.senderCharID}`,
    })) : [];
    const loot = filter === "loothistory" || filter === "all" ? $fleet.lootHistory.map(entry => ({
      entry, at: entry.atMs, key: `loot:${entry.characterID}:${entry.typeID}:${entry.solarSystemID}`,
    })) : [];
    const members = filter === "memberhistory" || filter === "all" ? $fleet.memberHistory.map(member => ({
      member, at: member.atMs, key: member,
    })) : [];
    return [...broadcasts, ...members, ...loot].sort((a, b) => filter === "all" ? b.at - a.at : 0);
  });

  function clear(): void {
    menuRequest++;
    menu.close();
    if (filter === "broadcasthistory" || filter === "all") flow.clearFleetBroadcastHistory();
    if (filter === "loothistory" || filter === "all") flow.clearFleetLootHistory();
    if (filter === "memberhistory" || filter === "all") flow.clearFleetMemberHistory();
  }

  /** The thing a broadcast names, as the pilot's ballpark has it (_GetTargetNameAndType, _GetTypeNameTextFromBroadcastedItemID). */
  function ballOf(itemID: number | null) {
    const snapshot = $space.snapshot;
    if (itemID === null || snapshot === null || !snapshot.inSpace) return null;
    return snapshot.entities.find((entity) => entity.itemID === itemID) ?? null;
  }

  function action(key: keyof typeof MENU_WORDS, run: () => void): ContextEntry {
    const [path, fallback] = MENU_WORDS[key];
    return { path, label: plainText(word(path, fallback)), run };
  }

  function report(pending: Promise<unknown>): void {
    void pending.catch(error => {
      if (error?.code !== "SESSION_REQUEST_RETIRED" && error?.code !== "SESSION_LOST") {
        notify({ kind: "danger", title: "Fleet History", detail: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  function routeMenu(placeID: number): ContextEntry[] {
    return [
      action("destination", () => flow.setDestination(placeID)),
      flow.waypoints.get().includes(placeID)
        ? action("remove", () => flow.clearWaypoints(placeID))
        : action("add", () => flow.addWaypoint(placeID)),
    ];
  }

  function locationMenu(itemID: number | null): ContextEntry[] {
    if (itemID === null || !$flight.status?.inSpace) return [];
    const warp = (range: number) => () => report(flow.warpTo(itemID, range));
    const [, fallback] = MENU_WORDS.within;
    return [
      action("warp", warp(flow.warpDistance.get() || 0)),
      { label: plainText(word(MENU_WORDS.within[0], fallback)), path: MENU_WORDS.within[0],
        sub: WARP_RANGES.map(range => ({ label: `${range / 1000} km`, run: warp(range) })) },
      action("align", () => report(flow.alignTo(itemID))),
    ];
  }

  function eventMenu(broadcast: FleetBroadcast): ContextEntry[] {
    const { name, itemID, senderSolarSystemID: systemID, senderCharID } = broadcast;
    const inSpace = $flight.status?.inSpace === true;
    const here = $flight.status?.solarSystemID ?? $station.online?.solarSystemID;
    switch (name) {
      case "TravelTo": {
        const destination = fleetTravelDestination(broadcast);
        return destination === null ? [] : routeMenu(destination);
      }
      case "JumpBeacon":
        return systemID === null ? [] : routeMenu(systemID);
      case "Location":
        if (systemID === here) return locationMenu(itemID);
        return systemID === null ? [] : [...routeMenu(systemID), action("distance", () => report(flow.showFleetLocationDistance(systemID)))];
      case "EnemySpotted": case "NeedBackup": case "InPosition":
        if (inSpace && (systemID === null || systemID === here) && senderCharID !== null) {
          const memberActions = memberMenu?.(flow, senderCharID)?.sub ?? [];
          return memberActions.filter((entry): entry is ContextEntry => entry !== null && /^Warp\b/i.test(entry.label));
        }
        return itemID === null && systemID === null ? [] : routeMenu(itemID ?? systemID!);
      case "WarpTo": case "AlignTo": case "JumpTo":
        return locationMenu(itemID);
      case "Target": case "HealArmor": case "HealCapacitor": case "HealShield": case "HealTarget":
        return itemID !== null && !$targeting.lockedTargetIDs.includes(itemID) && !$targeting.acquiringTargetIDs.includes(itemID)
          ? [action("lock", () => { if (ballOf(itemID)) report(flow.lockTarget(itemID)); })] : [];
      default: return [];
    }
  }

  async function lootMenu(typeID: number): Promise<ContextEntry[]> {
    const facts = (await flow.typeFacts([typeID]).catch(() => null))?.get(typeID);
    const entries: ContextEntry[] = [{ ...action("info", () => showInfo({ kind: "type", typeID })), info: true }];
    const category = facts?.categoryID;
    if (openIndustry && (category === 9 || category === 34)) entries.push(action("industry", () => {
      flow.requestIndustryBlueprintPreview(typeID, category !== 34);
      openIndustry();
    }));
    const celestial = category != null && CELESTIAL_CATEGORIES.has(category);
    if (facts?.marketGroupID != null && (!celestial || facts.published)) entries.push(action("market", () => showMarketDetails(typeID)));
    if (facts?.published) entries.push(
      action("contracts", () => findInContracts(typeID)),
      action("assets", () => {
        const name = nameOf("type", typeID);
        if (name) findInPersonalAssets(assetSearchTextForType(word(EXACT, "typeExact"), name));
      }));
    if (celestial ? facts?.published : category != null && COMPARE_CATEGORIES.includes(category)) {
      entries.push(action("compare", () => compareType(typeID)));
    }
    return entries;
  }

  async function openRow(event: MouseEvent | KeyboardEvent, characterID: number | null, broadcast?: FleetBroadcast, typeID?: number): Promise<void> {
    if (event instanceof KeyboardEvent && event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = event.currentTarget as HTMLElement;
    const rect = anchor.getBoundingClientRect();
    const x = event instanceof MouseEvent && event.button !== 0 ? event.clientX : rect.left;
    const y = event instanceof MouseEvent && event.button !== 0 ? event.clientY : rect.bottom;
    const request = ++menuRequest;
    const fleetID = $fleet.authoritativeFleetID;
    menu.close();
    const primary = typeID === undefined ? broadcast ? eventMenu(broadcast) : [] : await lootMenu(typeID);
    if (request !== menuRequest || !anchor.isConnected || fleetID !== $fleet.authoritativeFleetID) return;
    const member = characterID === null ? null : memberMenu?.(flow, characterID) ?? null;
    const entries: (ContextEntry | null)[] = [...primary, ...(primary.length && member ? [null] : []), ...(member ? [member] : [])];
    if (broadcast) {
      const name = broadcast.name;
      const enabled = listensToBroadcastRow($preferences, name);
      if (entries.length) entries.push(null);
      entries.push(action(enabled ? "ignore" : "unignore", () => {
        saveFleetBroadcastPreferences($session.accountID, { ...$preferences, listen: { ...$preferences.listen, [name]: !enabled } });
      }));
    }
    if (entries.length) menu.open(x, y, entries);
  }

  /** The broadcast's own label and its arguments, with what the ballpark adds (AddBroadcast). */
  function labelled(broadcast: FleetBroadcast): { label: string; args: Record<string, JsonValue>; after: string } {
    const { label, args } = broadcastHistoryLabel(broadcast);
    const ball = ballOf(broadcast.itemID);
    const typeName = ball !== null && ball.typeID !== null ? nameOf("type", ball.typeID) : "";
    if ((broadcast.name === "Target" || broadcast.name === "HealTarget") && ball !== null && typeName !== "") {
      return {
        label: broadcast.name === "Target" ? WORDS.targetWithType : WORDS.healTargetWithType,
        args: { targetName: ball.name ?? typeName, targetTypeName: typeName },
        after: "",
      };
    }
    const heal = broadcast.name === "HealArmor" || broadcast.name === "HealShield" || broadcast.name === "HealCapacitor";
    return { label, args: { ...args }, after: heal && typeName !== "" ? ` (${typeName})` : "" };
  }

  function entryText(broadcast: FleetBroadcast): string {
    const { label, args, after } = labelled(broadcast);
    const sender = broadcast.senderCharID === null ? "" : nameOf("character", broadcast.senderCharID);
    const eventLabel = plainText(formatTemplate(word(label, `${sender || "A pilot"}: ${broadcast.name}`), args, { nameOf })) + after;
    const time = String(BigInt(Math.trunc(broadcast.receivedAtMs)) * 10_000n + 116_444_736_000_000_000n);
    return plainText(formatTemplate(word(WORDS.event, "{[datetime]time, date=none, time=medium} · {eventLabel}"), { time, eventLabel }, { nameOf }));
  }

  function lootText(entry: FleetLootEntry): string {
    const time = String(BigInt(Math.trunc(entry.atMs)) * 10_000n + 116_444_736_000_000_000n);
    const itemName = nameOf("type", entry.typeID) || String(entry.typeID);
    const quantityName = formatTemplate(word(QUANTITY_AND_ITEM, `${entry.quantity} × ${itemName}`),
      { quantity: entry.quantity, item: entry.typeID }, { nameOf: () => itemName });
    const fallback = `${fleetLootTime(entry.atMs)} · ${nameOf("character", entry.characterID) || "A pilot"} looted ${quantityName}`;
    return plainText(formatTemplate(word(WORDS.lootEvent, fallback), { time, charID: entry.characterID, item: entry.typeID, itemQuantity: entry.quantity },
      { nameOf: (kind, id) => kind === "type" && id === entry.typeID ? quantityName : nameOf(kind, id) }));
  }

  function memberText(entry: FleetMemberHistoryEntry): string {
    const charID = entry.characterID;
    const role = entry.rank ? word(entry.rank, entry.rank.split("/").at(-1) ?? "") : "";
    const fallback = {
      Joined: "{[character]charID} joined as {role}",
      Left: "{[character]charID} left fleet",
      ChangedRole: "{[character]charID} now has role {role}",
      IsBoss: "{[character]charID} is now fleet boss",
      IsNotBoss: "{[character]charID} is no longer fleet boss",
    };
    const eventLabel = formatTemplate(word(memberHistoryLabel(entry.event), fallback[entry.event]), { charID, role }, { nameOf });
    const time = String(BigInt(Math.trunc(entry.atMs)) * 10_000n + 116_444_736_000_000_000n);
    return plainText(formatTemplate(word(WORDS.event, "{[datetime]time, date=none, time=medium} · {eventLabel}"), { time, eventLabel }, { nameOf }));
  }

  $effect(() => {
    flow.requestWords([...Object.values(WORDS), ...Object.values(MENU_WORDS).map(([path]) => path), EXACT, QUANTITY_AND_ITEM,
      "UI/Fleet/Ranks/FleetMember", "UI/Fleet/KickFleetMember", "UI/Fleet/MakeFleetLeader", "UI/Fleet/AddPilotToWatchlist",
      "UI/Fleet/RemovePilotFromWatchlist", "UI/Fleet/LeaveMyFleet", "UI/Fleet/FleetSubmenus/MoveFleetMember",
      "UI/Fleet/FleetBroadcast/Commands/BroadcastTravelToMe", "UI/Menusvc/ConfirmMenuOption",
      ...heard.map((broadcast) => broadcastHistoryLabel(broadcast).label)]);
  });
  $effect(() => {
    const refs = heard.flatMap((broadcast) => {
      const { label, args } = labelled(broadcast);
      const template = $words.templates[label];
      return typeof template === "string" ? templateNameRefs(template, args) : [];
    });
    if (refs.length > 0) flow.requestNames(refs);
  });
  $effect(() => {
    flow.requestNames($fleet.lootHistory.flatMap(row => [{ kind: "character" as const, id: row.characterID }, { kind: "type" as const, id: row.typeID }]));
  });
  $effect(() => {
    const members = $fleet.memberHistory;
    flow.requestWords(members.flatMap(row => row.rank ? [memberHistoryLabel(row.event), row.rank] : [memberHistoryLabel(row.event)]));
    flow.requestNames(members.map(row => ({ kind: "character" as const, id: row.characterID })));
  });
</script>

<section class="fleet-history" aria-label="Fleet history">
  <div class="history-top">
    <select value={filter} data-ui-pointer={FLEET_POINTERS.historyFilter}
      onchange={(event) => choose((event.currentTarget as HTMLSelectElement).value as Filter)}>
      <option value="all">{word(WORDS.all, "Everything")}</option>
      <option value="broadcasthistory">{word(WORDS.broadcasts, "Broadcasts")}</option>
      <option value="memberhistory">{word(WORDS.members, "Members")}</option>
      <option value="loothistory">{word(WORDS.loot, "Loot")}</option>
    </select>
    <button type="button" class="minor" onclick={clear}>{word(WORDS.clear, "Empty")}</button>
  </div>
  {#if shown.length === 0}
    <p class="empty">{word(WORDS.none, "Nothing has happened yet.")}</p>
  {:else}
    <ul>
      {#each shown as row (row.key)}
        {#if "broadcast" in row}
          {@const broadcast = row.broadcast}
          <li data-broadcast={broadcast.name} style:background-color={fleetBroadcastColor($preferences, broadcast.name)}>
            <button type="button" class="history-entry" aria-haspopup="menu"
              onclick={event => void openRow(event, broadcast.senderCharID, broadcast)}
              oncontextmenu={event => void openRow(event, broadcast.senderCharID, broadcast)}
              onkeydown={event => void openRow(event, broadcast.senderCharID, broadcast)}>{entryText(broadcast)}</button>
          </li>
        {:else if "member" in row}
          <li data-fleet-history-member={row.member.characterID} data-fleet-history-event={row.member.event}>
            <button type="button" class="history-entry" aria-haspopup="menu" onclick={event => void openRow(event, row.member.characterID)}
              oncontextmenu={event => void openRow(event, row.member.characterID)}
              onkeydown={event => void openRow(event, row.member.characterID)}>{memberText(row.member)}</button>
          </li>
        {:else}
          <li data-fleet-loot={row.entry.typeID}>
            <button type="button" class="history-entry" aria-haspopup="menu" onclick={event => void openRow(event, row.entry.characterID, undefined, row.entry.typeID)}
              oncontextmenu={event => void openRow(event, row.entry.characterID, undefined, row.entry.typeID)}
              onkeydown={event => void openRow(event, row.entry.characterID, undefined, row.entry.typeID)}>{lootText(row.entry)}</button>
          </li>
        {/if}
      {/each}
    </ul>
  {/if}
</section>

<style>
  .fleet-history { display: flex; flex-direction: column; gap: 0.4rem; }
  .history-top { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .empty { margin: 0; opacity: 0.75; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.15rem; max-height: 14rem; overflow-y: auto; }
  li { font-size: 0.85rem; }
  .history-entry { display: block; width: 100%; border: 0; padding: 0; background: none; color: inherit; font: inherit; text-align: left; }
</style>
