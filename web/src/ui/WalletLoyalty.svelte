<script lang="ts">
  import { plainText } from "../bridge/clientWords.ts";
  import { resolveDestination } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { WalletLPBalance } from "../store/types.ts";
  import { resolvedName, type NameKind, type NameRef } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";

  let { store, flow, balances, error, refresh }: {
    store: ClientStore;
    flow: AppFlow;
    balances: readonly WalletLPBalance[] | null;
    error: string;
    refresh: () => void;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const location = $derived($flight.status?.structureID ?? $flight.status?.stationID ?? $flight.status?.solarSystemID ??
    $station.online?.structureID ?? $station.online?.stationID);
  const labels = {
    corporation: ["UI/Journal/JournalWindow/Agents/HeaderIssuingCorporation", "Issuing Corporation"],
    points: ["UI/Journal/JournalWindow/Agents/LoyaltyPoints", "Loyalty Points"],
    closest: ["UI/Wallet/WalletWindow/ClosestLPStore", "Closest LP Store"],
    all: ["UI/Wallet/WalletWindow/AllFactions", "All Factions"],
    empty: ["UI/Journal/JournalWindow/Agents/NoLP", "No loyalty points"],
    none: ["UI/Common/None", "None"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? "") || labels[key][1];
  const name = (kind: NameKind, id: number) => resolvedName($names.resolved, kind, id, "");
  const funded = $derived((balances ?? []).filter(row => Number(row.loyaltyPoints) > 0));
  type Locations = Awaited<ReturnType<AppFlow["walletLoyaltyLocations"]>>;
  let locations = $state.raw<Locations | null>(null);
  let placesError = $state("");
  let stationError = $state("");
  let faction = $state(0);
  const ordered = $derived([...funded].sort((a, b) =>
    name("corporation", a.issuerCorpID).localeCompare(name("corporation", b.issuerCorpID))));
  const factions = $derived([...new Set([...locations?.values() ?? []].flatMap(row => row.factionID === null ? [] : [row.factionID]))]
    .sort((a, b) => name("faction", a).localeCompare(name("faction", b))));
  const shown = $derived(ordered.filter(row => faction === 0 || locations?.get(row.issuerCorpID)?.factionID === faction));

  async function openStation(stationID: number) {
    stationError = "";
    try {
      const place = await resolveDestination(stationID, flow.requestOptions());
      if (place.stationTypeID === null) throw new Error("The station's type could not be read.");
      showInfo({ kind: "spaceObject", itemID: stationID, typeID: place.stationTypeID });
    } catch (cause) {
      stationError = cause instanceof Error ? cause.message : String(cause);
    }
  }

  $effect(() => { flow.requestWords(Object.values(labels).map(([path]) => path)); });
  $effect(() => {
    if (faction !== 0 && locations !== null && !factions.includes(faction)) faction = 0;
  });
  $effect(() => {
    const issuers = funded.map(row => row.issuerCorpID);
    const at = location;
    if (issuers.length === 0) {
      locations = null;
      placesError = "";
      return;
    }
    flow.requestNames(issuers.map(id => ({ kind: "corporation", id })));
    if (at == null) return;
    let current = true;
    placesError = "";
    void flow.walletLoyaltyLocations(issuers).then(latest => {
      if (!current) return;
      locations = latest;
      const refs: NameRef[] = [];
      for (const row of latest.values()) {
        if (row.factionID !== null) refs.push({ kind: "faction", id: row.factionID });
        if (row.stationID !== null) refs.push({ kind: "station", id: row.stationID });
      }
      if (refs.length > 0) flow.requestNames(refs);
    }).catch(cause => {
      if (!current) return;
      locations = null;
      placesError = cause instanceof Error ? cause.message : String(cause);
    });
    return () => { current = false; };
  });
</script>

<section class="loyalty-overview" aria-label={word("points")}>
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={refresh}>Refresh</button>
  {:else if !balances}
    <p role="status">Loading loyalty points…</p>
  {:else}
    <select aria-label="Faction" bind:value={faction}>
      <option value={0}>{word("all")}</option>
      {#each factions as id (id)}
        <option value={id}>{name("faction", id) || "Faction"}</option>
      {/each}
    </select>
    {#if placesError || stationError}<p role="alert">{placesError || stationError}</p>{/if}
    <table class="guests">
      <thead><tr><th>{word("corporation")}</th><th>{word("points")}</th><th>{word("closest")}</th></tr></thead>
      <tbody>
        {#each shown as row (row.issuerCorpID)}
          {@const nearest = locations?.get(row.issuerCorpID)?.stationID ?? null}
          <tr>
            <td><button type="button" class="evelink"
              onclick={() => showInfo({ kind: "corporation", corporationID: row.issuerCorpID })}>{name("corporation", row.issuerCorpID) || "Corporation"}</button></td>
            <td>{Number(row.loyaltyPoints).toLocaleString("en-US")}</td>
            <td>
              {#if nearest !== null}
                <button type="button" class="evelink" onclick={() => void openStation(nearest)}>
                  {name("station", nearest) || "Station"}
                </button>
              {:else if locations !== null}{word("none")}{:else}—{/if}
            </td>
          </tr>
        {:else}
          <tr><td colspan="3">{word("empty")}</td></tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .loyalty-overview { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding-top: 10px; }
  table { width: 100%; }
  .evelink { padding: 0; border: 0; background: transparent; color: var(--theme-focus, #91bfd7); text-align: left; }
</style>
