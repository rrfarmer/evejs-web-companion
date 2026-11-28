<script lang="ts">
  import { loadStationStatic, type MapLocationInfo } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { npcStationServices, NPC_STATION_SERVICE_LABELS } from "../bridge/npcStationServices.ts";
  import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import type { StationStatic } from "../store/types.ts";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, itemID }: { store: ClientStore; flow: AppFlow; itemID: number } = $props();
  const words = $derived(store.words), names = $derived(store.names), station = $derived(store.station);
  const ownerLogos = $derived(flow.ownerLogos);
  type Tab = "description" | "location" | "services";
  const tabs = {
    description: ["UI/InfoWindow/TabNames/Description", "Description"],
    location: ["UI/InfoWindow/TabNames/Location", "Location"],
    services: ["UI/InfoWindow/TabNames/Services", "Services"],
  } as const;
  const placeLabels = { 3: ["UI/Common/Region", "Region"], 4: ["UI/Common/Constellation", "Constellation"], 5: ["UI/Common/SolarSystem", "Solar System"] } as const;
  const destination = "UI/Inflight/SetDestination";
  const clickForCorp = "UI/InfoWindow/ClickForCorpInfo";
  const standing = "UI/Standings/StationServiceStandingsRequired";
  const word = (path: string, fallback: string) => plainText($words.templates[path] ?? fallback);
  let details = $state.raw<StationStatic | null>(null);
  let location = $state.raw<MapLocationInfo | null>(null);
  let restrictions = $state.raw<Awaited<ReturnType<AppFlow["stationStandingsRestrictions"]>>>({});
  let tab = $state<Tab>("description");
  let loading = $state(true);
  const currentSystem = $derived($station.online?.solarSystemID ?? null);
  let pilotSecurity = $state<number | null>(null);
  const serviceSecurity = $derived($station.station?.security ?? pilotSecurity);
  const serviceRows = $derived(details?.serviceIDs ? [...npcStationServices(details, serviceSecurity, restrictions)]
    .sort((a, b) => word(a.label, a.fallback).localeCompare(word(b.label, b.fallback))) : []);
  const owner = $derived(details?.ownerID ?? null);
  const ownerLogo = $derived(owner === null ? null : $ownerLogos?.corporations[String(owner)] ?? null);
  const description = $derived(details && (details.descriptionID
    ? word(`#${details.descriptionID}`, details.description ?? details.stationName)
    : details.description ?? details.stationName));

  $effect(() => {
    const system = currentSystem;
    pilotSecurity = null;
    if (!system) return;
    let active = true;
    void flow.loadStarMap().then(map => {
      if (active) pilotSecurity = map.systems.find(row => row[0] === system)?.[8] ?? null;
    }).catch(() => {});
    return () => { active = false; };
  });

  $effect(() => {
    const id = itemID;
    details = null;
    location = null;
    restrictions = {};
    tab = "description";
    loading = true;
    flow.loadOwnerLogos();
    flow.requestWords([destination, clickForCorp, standing, ...Object.values(tabs).map(([label]) => label),
      ...Object.values(placeLabels).map(([label]) => label), ...NPC_STATION_SERVICE_LABELS.map(([label]) => label)]);
    let active = true;
    void loadStationStatic(id, flow.requestOptions(), true).then(read => {
      if (!active || !read) return;
      details = read;
      if (read.descriptionID) flow.requestWords([`#${read.descriptionID}`]);
      if (read.ownerID) flow.requestNames([{ kind: "corporation", id: read.ownerID }]);
      if (read.solarSystemID) {
        void flow.mapLocationShowInfo(read.solarSystemID).then(result => { if (active) location = result; }).catch(() => {});
      }
      if (read.serviceIDs) {
        void flow.stationStandingsRestrictions().then(read => {
          if (!active) return;
          restrictions = read;
          const owners = Object.keys(read).map(Number).filter(id => id === details?.ownerID || id === details?.systemFactionID);
          if (owners.length) flow.requestNames(owners.map(id => ({ kind: "owner", id })));
        }).catch(() => {});
      }
    }).catch(() => {}).finally(() => { if (active) loading = false; });
    return () => { active = false; };
  });

  function restrictionHint(owner: number, required: number): string {
    const name = resolvedName($names.resolved, "owner", owner, "");
    const template = $words.templates[standing];
    return template ? plainText(formatTemplate(template, { from_id: owner, required_standing: required }, { nameOf: () => name }))
      : `Requires ${required} standings${name ? " with " + name : ""}`;
  }
</script>

{#if loading}
  <p role="status">Reading…</p>
{:else if details === null}
  <p role="status">Station information is unavailable.</p>
{:else}
  {#if owner !== null}
    {@const corporationID = owner}
    <button type="button" class="station-owner" aria-label={word(clickForCorp, "Show Corporation Information")}
      data-station-owner={corporationID} onclick={() => showInfo({ kind: "corporation", corporationID })}>
      {#if ownerLogo}<img alt="" src={clientTexture(ownerLogo)} />{/if}
      <span>{resolvedName($names.resolved, "corporation", corporationID, "")}</span>
    </button>
  {/if}
  <nav aria-label="Station information">
    {#each ["description", "location", "services"] as key (key)}
      {@const current = key as Tab}
      {#if current === "description" || (current === "location" && location) || (current === "services" && serviceRows.length)}
        <button type="button" aria-pressed={tab === current} onclick={() => tab = current}>{word(...tabs[current])}</button>
      {/if}
    {/each}
  </nav>
  {#if tab === "location" && location}
    <dl class="kv" aria-label={word(...tabs.location)}>
      {#each [...location.parents, location] as place (place.itemID)}
        <dt>{word(...placeLabels[place.typeID])}</dt>
        <dd>
          <button class="evelink" type="button" data-station-place={place.itemID}
            onclick={() => showInfo({ kind: "mapLocation", typeID: place.typeID, itemID: place.itemID })}>
            {#if place.typeID === 5 && place.securityStatus != null}
              {@const security = shownSecurity(place.securityStatus)}
              <span style:color={securityStatusColor(security)}>{security.toFixed(1)}</span>
            {/if}
            {place.name}
          </button>
        </dd>
      {/each}
    </dl>
  {:else if tab === "services"}
    <ul aria-label={word(...tabs.services)}>
      {#each serviceRows as service (service.label)}
        <li data-station-service={service.label}>
          <img alt="" src={clientTexture(`res:/UI/Texture/WindowIcons/${service.icon}.png`)} />
          <span>{word(service.label, service.fallback)}</span>
          {#if service.restriction}
            {@const hint = restrictionHint(service.restriction.owner, service.restriction.required)}
            <img class="standing" title={hint} alt={hint} src={clientTexture("res:/UI/Texture/Classes/Standings/Actions/derivedAgentInFaction.png")} />
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="info-description">{description}</p>
  {/if}
  <footer>
    <button type="button" onclick={() => flow.setDestination(itemID)}>{word(destination, "Set Destination")}</button>
  </footer>
{/if}

<style>
  .station-owner { display: flex; align-items: center; gap: 8px; border: 0; background: transparent; }
  .station-owner img { width: 64px; height: 64px; object-fit: contain; }
  nav { display: flex; flex-wrap: wrap; gap: 3px; margin: 8px 0; border-bottom: 1px solid #ffffff30; }
  nav button { padding: 5px 8px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; }
  nav button:hover, nav button[aria-pressed="true"] { background: #ffffff12; }
  nav button[aria-pressed="true"] { border-bottom-color: #9ec2da; }
  ul { list-style: none; margin: 0; padding: 0 4px; }
  li { display: flex; align-items: center; gap: 8px; min-height: 28px; }
  li img { width: 24px; height: 24px; }
  li img.standing { margin-inline-start: auto; }
  footer { display: flex; justify-content: flex-end; margin-top: 8px; }
</style>
