<script lang="ts">
  import { untrack } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import {
    loadShipEmblemCatalog, SHIP_EMBLEM_TYPES, type ReleasedShipEmblem, type ShipEmblemImages, type ShipEmblemKind, type ShipEmblemState,
  } from "../bridge/shipEmblems.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { openAgencyGroup } from "./agencyRequests.ts";
  import { AGENCY_SCREEN_GROUPS } from "./agencyContentGroups.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import CorpLogo from "./CorpLogo.svelte";
  import ShipInfoPreview from "./ShipInfoPreview.svelte";
  import ShipSkinrPreview from "./ShipSkinrPreview.svelte";
  import { loadFirstPartySkinCatalog } from "../bridge/firstPartySkins.ts";

  let { store, flow, shipID, shipTypeID }: { store: ClientStore; flow: AppFlow; shipID: number; shipTypeID: number } = $props();
  const station = $derived(store.station);
  const words = $derived(store.words);
  const names = $derived(store.names);
  const changed = $derived(flow.shipEmblemsChanged);
  const applied = $derived(flow.shipSkinrApplied);
  const corpLogos = $derived(flow.corpLogos);
  const library = $derived(flow.corpLogoLibrary);
  const imageServer = $derived(flow.imageServer);
  const pilot = $derived($station.online?.characterID);
  const corporation = $derived($station.online?.corporationID ?? null);
  const alliance = $derived($station.online?.allianceID ?? null);
  const corpLogo = $derived(corporation ? $corpLogos[String(corporation)] : null);
  const allianceLogo = $derived(alliance ? allianceLogoUrl($imageServer, alliance) : null);
  const prefix = "UI/ShipCosmetics/";
  const labels = {
    alliance: "Available Alliance Emblems",
    corporation: "Available Corporation Emblems",
    released: "Emblem not yet released for this ship.",
    missingAlliance: "Emblem unavailable as your corporation is not part of a capsuleer-run alliance.",
    ownedNoAlliance: "Emblem unlocked but unavailable as your corporation is not in a capsuleer-run alliance.",
  };
  const word = (path: string, fallback: string) => plainText($words.templates[path] ?? fallback);
  const ownerName = (id: number, kind: ShipEmblemKind) =>
    resolvedName($names.resolved, "owner", id, "") || resolvedName($names.resolved, kind, id, String(id));
  let catalog = $state.raw<readonly ReleasedShipEmblem[]>([]);
  let state = $state.raw<ShipEmblemState | null>(null);
  let emblemImages = $state.raw<ShipEmblemImages>({});
  let materialSet = $state<number | null>(null);
  const skin = $derived($applied?.shipID === shipID && $applied.characterID === pilot ? $applied : null);
  const design = $derived(skin?.skin ? { layout: skin.skin.layout, shipTypeID } : null);
  let pending = $state<ShipEmblemKind | null>(null);
  let error = $state("");
  let readError = $state("");
  let revision = $state(0);
  const kinds = ["alliance", "corporation"] as const;
  $effect(() => {
    flow.requestWords([prefix + "AvailableAllianceEmblems", prefix + "AvailableCorporationEmblems", prefix + "EmblemNotReleased",
      prefix + "EmblemNoAllianceNotEligible", prefix + "EmblemNoAllianceEligible", "UI/Agents/ParagonAgent"]);
  });
  $effect(() => {
    const refs = [alliance, corporation].flatMap(id => id ? [{ kind: "owner" as const, id }] : []);
    if (refs.length) flow.requestNames(refs);
    if (corporation) flow.requestCorpLogos([corporation]);
  });
  $effect(() => {
    if (!pilot) return;
    void $changed;
    void revision;
    const id = shipID;
    const hull = shipTypeID;
    const reads = untrack(() => Promise.all([loadShipEmblemCatalog(), flow.loadShipEmblems(id, hull)]));
    let current = true;
    readError = "";
    void reads.then(([rows, live]) => {
      if (!current) return;
      catalog = rows;
      state = live;
    }, cause => { if (current) readError = panelErrorWords(cause); });
    return () => { current = false; };
  });

  $effect(() => {
    if (pilot) void flow.loadShipSkinrApplied(shipID).catch(() => {});
  });
  $effect(() => {
    const skinID = skin?.firstPartySkinID;
    const hull = shipTypeID;
    materialSet = null;
    if (!skinID) return;
    let current = true;
    void loadFirstPartySkinCatalog(hull).then(rows => {
      if (current) materialSet = rows.find(row => row.skinID === skinID)?.materialSetID ?? null;
    }).catch(() => {});
    return () => { current = false; };
  });
  $effect(() => {
    // Owner changes can change the banner even when the same slot remains occupied.
    void alliance;
    void corporation;
    const enabled = [...state?.enabled.keys() ?? []];
    let current = true;
    void untrack(() => flow.loadShipEmblemImages(enabled)).then(images => {
      if (current) emblemImages = images;
    }).catch(() => { if (current) emblemImages = {}; });
    return () => { current = false; };
  });

  async function toggle(kind: ShipEmblemKind, slot: number, enabled: boolean) {
    if (pending) return;
    pending = kind;
    error = "";
    try {
      await flow.setShipEmblem(shipID, slot, kind, enabled);
      state = await flow.loadShipEmblems(shipID, shipTypeID);
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally {
      pending = null;
    }
  }
</script>

<div class="emblems">
  <div class="fitting-emblem-preview">
    {#if design}
      <ShipSkinrPreview {flow} {design} emblems={emblemImages} />
    {:else}
      <ShipInfoPreview typeID={shipTypeID} factionID={null} skinMaterialSetID={materialSet} emblems={emblemImages} active expanded />
    {/if}
  </div>
  {#if readError}
    <p role="alert">{readError}</p>
    <button type="button" onclick={() => revision++}>Retry</button>
  {:else if !state}
    <p role="status">Loading emblems…</p>
  {:else}
    {#each kinds as kind}
      {@const release = catalog.find(([hull, type]) => hull === shipTypeID && type === SHIP_EMBLEM_TYPES[kind])}
      {@const id = kind === "alliance" ? alliance : corporation}
      {@const owned = state.owned.has(kind)}
      {@const equippedSlot = state.enabled.get(kind)}
      <section data-emblem-kind={kind}>
        <h4>{word(prefix + (kind === "alliance" ? "AvailableAllianceEmblems" : "AvailableCorporationEmblems"), labels[kind])}</h4>
        {#if !release}
          <p>{word(prefix + "EmblemNotReleased", labels.released)}</p>
        {:else if kind === "alliance" && !alliance}
          <p>{owned ? word(prefix + "EmblemNoAllianceEligible", labels.ownedNoAlliance)
            : word(prefix + "EmblemNoAllianceNotEligible", labels.missingAlliance)}</p>
        {:else if !owned}
          <p>Unlock this emblem with a Paragon agent.</p>
          <button type="button" onclick={() => openAgencyGroup(AGENCY_SCREEN_GROUPS.HERALDRY_AGENTS!)}>
            {word("UI/Agents/ParagonAgent", "Paragon Agent")}
          </button>
        {:else if id}
          {@const name = ownerName(id, kind)}
          <div class="emblem-entry">
            {#if kind === "corporation" && corpLogo && $library}
              <div class="logo"><CorpLogo library={$library} logo={corpLogo} {name} /></div>
            {:else if kind === "alliance" && allianceLogo}
              <OwnerPicture {name} urls={[allianceLogo]} size={40} />
            {/if}
            <span>{name}</span>
            <button type="button" disabled={pending !== null} aria-pressed={equippedSlot !== undefined}
              onclick={() => void toggle(kind, equippedSlot ?? release[2], equippedSlot === undefined)}>
              {equippedSlot === undefined ? "Display emblem" : "Remove emblem"}
            </button>
          </div>
        {/if}
      </section>
    {/each}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</div>

<style>
  .emblems { display: grid; gap: 12px; padding: 12px 18px; }
  .fitting-emblem-preview { height: clamp(10rem, 26vh, 17rem); background: #000; }
  .fitting-emblem-preview :global(.skinr-preview) { height: 100%; }
  section { padding: 12px; background: #ffffff08; }
  h4 { margin: 0 0 8px; }
  p { margin: 0 0 8px; }
  .emblem-entry { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .logo { width: 40px; height: 40px; }
</style>
