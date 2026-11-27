<script lang="ts">
  // The fleet window's History (fleetbroadcast.py BroadcastHistoryPanel): a choice of All, Broadcast History, Member
  // History and Loot History (the last kept by the pilot's settings, Broadcast History at first), a Clear, and the
  // events newest first, each in the client's words: "Event", the time and the event's own label (fleetSvc.AddBroadcast
  // makes a broadcast's). WantBroadcast grants the own-broadcast override before checking the type preference.
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { QUANTITY_AND_ITEM, formatTemplate, plainText, templateNameRefs } from "../bridge/clientWords.ts";
  import { broadcastHistoryLabel, fleetTravelDestination, type FleetBroadcast } from "../bridge/fleetBroadcasts.ts";
  import { fleetLootTime, type FleetLootEntry } from "../bridge/fleetLoot.ts";
  import { memberHistoryLabel, type FleetMemberHistoryEntry } from "../bridge/fleetMemberHistory.ts";
  import { FLEET_POINTERS } from "../play/uiPointer.ts";
  import { fleetBroadcastColor, fleetBroadcastPreferences, wantsFleetBroadcast } from "./fleetBroadcastPreferences.ts";
  import PlaceRouteMenu from "./PlaceRouteMenu.svelte";
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
  // svelte-ignore state_referenced_locally
  const session = store.session;
  const preferences = $derived(fleetBroadcastPreferences($session.accountID));

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
    flow.requestWords([...Object.values(WORDS), QUANTITY_AND_ITEM, ...heard.map((broadcast) => broadcastHistoryLabel(broadcast).label)]);
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
          {@const destination = fleetTravelDestination(broadcast)}
          <li data-broadcast={broadcast.name} style:background-color={fleetBroadcastColor($preferences, broadcast.name)}>
            {#if destination !== null}
              <PlaceRouteMenu {store} {flow} placeID={destination} travelBroadcast={entryText(broadcast)} />
            {:else}
              {entryText(broadcast)}
            {/if}
          </li>
        {:else if "member" in row}
          <li data-fleet-history-member={row.member.characterID} data-fleet-history-event={row.member.event}>{memberText(row.member)}</li>
        {:else}
          <li data-fleet-loot={row.entry.typeID}>{lootText(row.entry)}</li>
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
</style>
