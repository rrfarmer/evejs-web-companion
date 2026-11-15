<script lang="ts">
  // The fleet window's History (fleetbroadcast.py BroadcastHistoryPanel): a choice of All, Broadcast History, Member
  // History and Loot History (the last kept by the pilot's settings, Broadcast History at first), a Clear, and the
  // events newest first, each in the client's words: "Event", the time and the event's own label (fleetSvc.AddBroadcast
  // makes a broadcast's). A broadcast of the pilot's own is not among them unless the pilot asks for its own
  // (WantBroadcast: BROADCAST_SHOW_OWN, off at first). Nothing is asked of the server.
  // Not here yet: the member history (AddToMemberHistory) and the loot history (OnFleetLootEvent), which list
  // nothing; the other entries' menus and colour; the broadcast settings that leave a kind of broadcast out.
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText, templateNameRefs } from "../bridge/clientWords.ts";
  import { broadcastHistoryLabel, fleetTravelDestination, type FleetBroadcast } from "../bridge/fleetBroadcasts.ts";
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
  /** GetBroadcastHistory: the pilot's own left out (WantBroadcast). */
  const heard = $derived(($fleet.broadcastHistory ?? []).filter((broadcast) => broadcast.senderCharID !== me));
  const shown = $derived(filter === "broadcasthistory" || filter === "all" ? heard : []);

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

  $effect(() => {
    flow.requestWords([...Object.values(WORDS), ...heard.map((broadcast) => broadcastHistoryLabel(broadcast).label)]);
  });
  $effect(() => {
    const refs = heard.flatMap((broadcast) => {
      const { label, args } = labelled(broadcast);
      const template = $words.templates[label];
      return typeof template === "string" ? templateNameRefs(template, args) : [];
    });
    if (refs.length > 0) flow.requestNames(refs);
  });
</script>

<section class="fleet-history" aria-label="Fleet history">
  <div class="history-top">
    <select value={filter} onchange={(event) => choose((event.currentTarget as HTMLSelectElement).value as Filter)}>
      <option value="all">{word(WORDS.all, "Everything")}</option>
      <option value="broadcasthistory">{word(WORDS.broadcasts, "Broadcasts")}</option>
      <option value="memberhistory">{word(WORDS.members, "Members")}</option>
      <option value="loothistory">{word(WORDS.loot, "Loot")}</option>
    </select>
    <button type="button" class="minor" onclick={() => flow.clearFleetBroadcastHistory()}>{word(WORDS.clear, "Empty")}</button>
  </div>
  {#if shown.length === 0}
    <p class="empty">{word(WORDS.none, "Nothing has happened yet.")}</p>
  {:else}
    <ul>
      {#each shown as broadcast (broadcast.receivedAtMs + ":" + broadcast.name + ":" + broadcast.senderCharID)}
        {@const destination = fleetTravelDestination(broadcast)}
        <li data-broadcast={broadcast.name}>
          {#if destination !== null}
            <PlaceRouteMenu {store} {flow} placeID={destination} travelBroadcast={entryText(broadcast)} />
          {:else}
            {entryText(broadcast)}
          {/if}
        </li>
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
