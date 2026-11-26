<script lang="ts">
  import { plainText } from "../bridge/clientWords.ts";
  import { CONCORD_LP_ISSUER } from "../bridge/concordLp.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { resolveDestination } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { WalletLPBalance } from "../store/types.ts";
  import { resolvedName, type NameKind, type NameRef } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import ConcordLpExchange from "./ConcordLpExchange.svelte";

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
    exchange: ["UI/Journal/JournalWindow/Agents/ConvertConcordLoyaltyPoints", "Convert CONCORD loyalty points to…"],
    actions: ["UI/Common/Actions", "Actions"],
    fob: ["UI/TheatersOfWar/InsurgencyPirateFob", "Pirate FOB"],
    unavailable: ["UI/Generic/Unavailable", "Unavailable"],
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
  const npcStation = $derived($station.online?.stationID === location && !$flight.status?.structureID ? location : null);
  const concord = $derived(Number(funded.find(row => row.issuerCorpID === CONCORD_LP_ISSUER)?.loyaltyPoints ?? "0"));
  let rates = $state.raw<ReadonlyMap<number, number> | null>(null);
  let rateError = $state("");
  let menu = $state<number | null>(null);
  let exchange = $state<number | null>(null);
  const exchangeRate = $derived(exchange === null ? 0 : rates?.get(exchange) ?? 0);
  const exchangeTarget = $derived(Number(funded.find(row => row.issuerCorpID === exchange)?.loyaltyPoints ?? "0"));

  $effect(() => {
    if (npcStation == null || concord <= 0) return;
    let current = true;
    rateError = "";
    void flow.concordLpExchangeRates().then(table => { if (current) rates = table; })
      .catch(cause => { if (current) rateError = panelErrorWords(cause); });
    return () => { current = false; };
  });

  $effect(() => {
    if (npcStation == null || concord <= 0) {
      menu = null;
      exchange = null;
    }
  });

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
        if (row.stationID !== null) refs.push({ kind: row.fob ? "structure" : "station", id: row.stationID });
        if (row.fob) refs.push({ kind: "system", id: row.fob.systemID });
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
    {#if placesError || stationError || rateError}<p role="alert">{placesError || stationError || rateError}</p>{/if}
    <table class="guests">
      <thead><tr><th>{word("corporation")}</th><th>{word("points")}</th><th>{word("closest")}</th></tr></thead>
      <tbody>
        {#each shown as row (row.issuerCorpID)}
          {@const place = locations?.get(row.issuerCorpID)}
          {@const nearest = place?.stationID ?? null}
          {@const canExchange = npcStation != null && concord > 0 && (rates?.get(row.issuerCorpID) ?? 0) > 0}
          <tr data-lp-issuer={row.issuerCorpID}>
            <td>
              <div class="loyalty-row-actions" role="group" aria-label={name("corporation", row.issuerCorpID) || word("corporation")}
                oncontextmenu={(event) => { if (canExchange) { event.preventDefault(); menu = row.issuerCorpID; } }}
                onfocusout={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) menu = null; }}>
                <button type="button" class="evelink"
                  onclick={() => showInfo({ kind: "corporation", corporationID: row.issuerCorpID })}>{name("corporation", row.issuerCorpID) || "Corporation"}</button>
                {#if canExchange}
                  <button type="button" class="loyalty-actions" aria-label={word("actions")} aria-expanded={menu === row.issuerCorpID}
                    onkeydown={(event) => { if (event.key === "Escape") menu = null; }}
                    onclick={() => (menu = menu === row.issuerCorpID ? null : row.issuerCorpID)}>⋯</button>
                  {#if menu === row.issuerCorpID}
                    <button type="button" class="loyalty-exchange-action"
                      onkeydown={(event) => { if (event.key === "Escape") menu = null; }}
                      onclick={() => { exchange = row.issuerCorpID; menu = null; }}>{word("exchange")}</button>
                  {/if}
                {/if}
              </div>
            </td>
            <td>{Number(row.loyaltyPoints).toLocaleString("en-US")}</td>
            <td>
              {#if nearest !== null && place?.fob}
                {@const fob = place.fob}
                <button type="button" class="evelink" data-lp-fob={nearest}
                  onclick={() => showInfo({ kind: "spaceObject", itemID: nearest, typeID: fob.typeID })}>
                  {name("structure", nearest) || [name("system", fob.systemID), word("fob")].filter(Boolean).join(" · ")}
                </button>
              {:else if nearest !== null}
                <button type="button" class="evelink" onclick={() => void openStation(nearest)}>
                  {name("station", nearest) || "Station"}
                </button>
              {:else if place?.unavailable}{word("unavailable")}
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
{#if exchange !== null && npcStation != null && exchangeRate > 0}
  <ConcordLpExchange {store} {flow} stationID={npcStation} issuerID={exchange} rate={exchangeRate}
    source={concord} target={exchangeTarget} close={() => (exchange = null)} exchanged={refresh} />
{/if}

<style>
  .loyalty-overview { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding-top: 10px; }
  table { width: 100%; }
  .evelink { padding: 0; border: 0; background: transparent; color: var(--theme-focus, #91bfd7); text-align: left; }
  .loyalty-row-actions { display: flex; align-items: center; gap: 6px; position: relative; }
  .loyalty-actions { padding: 0 4px; min-height: 0; line-height: 1.1; }
  .loyalty-exchange-action { position: absolute; top: 100%; left: 0; z-index: 1; white-space: nowrap;
    background: var(--win-bg, #161b20); }
</style>
