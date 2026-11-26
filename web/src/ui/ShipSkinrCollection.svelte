<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { SHIP_SKINR_GATEWAY } from "../bridge/shipSkinr.ts";
  import type { ShipSkinrOwnedComponent, ShipSkinrOwnedSkin } from "../bridge/shipSkinrCollection.ts";
  import type { ShipSkinrSequenceLicense } from "../bridge/shipSkinrSequencing.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { typeIconUrl } from "./typeIcons.ts";
  import { showMarketDetails } from "./marketDetails.ts";
  import ShipSkinrSell from "./ShipSkinrSell.svelte";
  import ShipSkinrPreview from "./ShipSkinrPreview.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const station = $derived(store.station);
  const flight = $derived(store.flight);
  const fitting = $derived(store.fitting);
  const characters = $derived(store.character);
  const applied = $derived(flow.shipSkinrApplied);
  const activeShip = $derived($flight.status?.shipID ?? $fitting.activeShipID);
  const activeType = $derived($flight.status?.shipTypeID ?? $characters.characters.find(row => row.characterID === $station.online?.characterID)?.shipTypeID);
  const pilot = $derived($station.online?.characterID ?? null);
  const prefix = "UI/Personalization/ShipSkins/SKINR/";
  const labels = {
    title: [prefix + "Collection/Title", "Collection"],
    skins: [prefix + "Studio/SKINs", "SKINs"],
    elements: [prefix + "Studio/DesignElements", "Design Elements"],
    activated: [prefix + "Collection/ActivatedSkins", "Activated SKINs"],
    unactivated: [prefix + "Collection/UnactivatedSkins", "Unactivated SKINs"],
    nanocoatings: [prefix + "Studio/Nanocoatings", "Basic Nanocoatings"],
    metallics: [prefix + "Studio/Metallics", "Metallic Nanocoatings"],
    patterns: [prefix + "Studio/Patterns", "Patterns"],
    activate: [prefix + "Collection/Activate", "Activate"],
    apply: [prefix + "Collection/Apply", "Apply"],
    remove: [prefix + "Collection/UnApply", "Remove from Ship"],
    activateApply: [prefix + "Collection/ActivateAndApply", "Activate and Apply"],
    wrongHull: [prefix + "Collection/SkinApplyDisabledHint", "SKINs can only be applied to your active ship"],
    view: ["UI/Common/ViewAll", "View All"],
    back: ["UI/Common/Buttons/Back", "Back"],
    sort: ["UI/Common/SortBy", "Sort By"],
    name: ["UI/Common/Name", "Name"],
    reverse: ["UI/Inventory/NameReversed", "Name Reversed"],
    shade: ["UI/Common/ColorShade", "Color Shade"],
    shadeReversed: ["UI/Common/ColorShadeReversed", "Color Shade Reversed"],
    market: ["UI/Inventory/ItemActions/ViewTypesMarketDetails", "View Market Details"],
    sell: [prefix + "Collection/Sell", "Sell"],
  } as const;
  const skinSections = ["activated", "unactivated"] as const;
  const elementSections = ["nanocoatings", "metallics", "patterns"] as const;
  type Section = typeof skinSections[number] | typeof elementSections[number];
  type ElementRow = ShipSkinrOwnedComponent & { category: Section; nameID: number; swatch?: string; icon?: string;
    shade: number | null; marketTypeID: number | null };
  const elementOrders = ["name", "reverse", "shade", "shadeReversed"] as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const hullName = (id: number) => resolvedName($names.resolved, "type", id, String(id));
  const skinName = (row: ShipSkinrOwnedSkin) => row.design?.name || "Design unavailable";
  const elementName = (row: ElementRow) => plainText($words.templates[`#${row.nameID}`] ?? "") || String(row.id);
  const elementKey = (row: ShipSkinrOwnedComponent) => `${row.kind}:${row.id}`;
  let tab = $state<"skins" | "elements">("skins");
  let section = $state<Section | null>(null);
  let skins = $state.raw<readonly ShipSkinrOwnedSkin[] | null>(null);
  let elements = $state.raw<readonly ElementRow[] | null>(null);
  let selected = $state<string | null>(null);
  let selectedSkinSection = $state<"activated" | "unactivated">("activated");
  let hull = $state(0);
  let reverse = $state(false);
  let elementOrder = $state<typeof elementOrders[number]>("name");
  let revision = $state(0);
  let loading = $state(false);
  let error = $state("");
  let detailError = $state("");
  let activating = $state(false);
  let rights = $state.raw<ShipSkinrSequenceLicense | null>(null);
  let selling = $state.raw<ShipSkinrOwnedSkin | null>(null);
  let listed = $state(false);
  const selectedSkin = $derived(tab === "skins" ? skins?.find(row => row.hex === selected) : undefined);
  const matchesActive = $derived(activeShip !== null && selectedSkin?.design?.shipTypeID === activeType);
  const currentlyApplied = $derived($applied && $applied.shipID === activeShip && $applied.skin?.hex === selected);
  const selectedElement = $derived(tab === "elements" ? elements?.find(row => elementKey(row) === selected) : undefined);
  const hulls = $derived([...new Set(skins?.flatMap(row => row.design ? [row.design.shipTypeID] : []) ?? [])]
    .sort((a, b) => hullName(a).localeCompare(hullName(b))));
  const sortedSkins = $derived((skins ?? []).filter(row => !hull || row.design?.shipTypeID === hull)
    .sort((a, b) => (reverse ? -1 : 1) * skinName(a).localeCompare(skinName(b))));
  const sortedElements = $derived([...(elements ?? [])].sort((a, b) => {
    if (elementOrder === "shade" || elementOrder === "shadeReversed") {
      const left = a.shade ?? Number.POSITIVE_INFINITY;
      const right = b.shade ?? Number.POSITIVE_INFINITY;
      return left === right ? 0 : (left < right ? -1 : 1) * (elementOrder === "shadeReversed" ? -1 : 1);
    }
    return (elementOrder === "reverse" ? -1 : 1) * elementName(a).localeCompare(elementName(b));
  }));

  function choose(next: typeof tab, category: Section | null = null) {
    tab = next;
    section = category;
    selected = null;
    selling = null;
    listed = false;
    hull = 0;
  }

  async function collectElements(): Promise<ElementRow[]> {
    const [owned, { SHIP_SKINR_COATINGS }, { SHIP_SKINR_PATTERNS }, { SHIP_SKINR_ELEMENT_MARKET }] = await Promise.all([
      flow.loadShipSkinrCollectionComponents(), import("../bridge/shipSkinrCoatingsData.ts"), import("../bridge/shipSkinrPatternsData.ts"),
      import("../bridge/shipSkinrElementMarketData.ts"),
    ]);
    const coatings = new Map(SHIP_SKINR_COATINGS.components.map(row => [row.id, row]));
    const patterns = new Map(SHIP_SKINR_PATTERNS.components.map(row => [row.id, row]));
    return owned.map(row => {
      const [shade, marketTypeID] = SHIP_SKINR_ELEMENT_MARKET[row.id] ?? [null, null];
      if (row.kind === "pattern") {
        const pattern = patterns.get(row.id);
        return { ...row, category: "patterns", nameID: pattern?.nameID ?? 0, icon: pattern?.icon, shade, marketTypeID };
      }
      const coating = coatings.get(row.id);
      return { ...row, category: coating?.category === 3 ? "metallics" : "nanocoatings",
        nameID: coating?.nameID ?? 0, swatch: coating?.swatch, shade, marketTypeID };
    });
  }

  $effect(() => { flow.requestWords(Object.values(labels).map(([path]) => path)); });
  $effect(() => {
    if (tab === "skins" && activeShip) void flow.loadShipSkinrApplied(activeShip).catch(() => {});
  });
  $effect(() => {
    void pilot;
    skins = null;
    elements = null;
    selected = null;
    selling = null;
    listed = false;
  });
  $effect(() => {
    void revision;
    if (!pilot) return;
    let current = true;
    loading = true;
    error = "";
    const done = () => { if (current) loading = false; };
    const failure = (cause: unknown) => { if (current) error = panelErrorWords(cause); };
    if (tab === "skins") {
      void flow.loadShipSkinrCollectionSkins().then(rows => { if (current) skins = rows; }, failure).finally(done);
    } else {
      void collectElements().then(rows => {
        if (!current) return;
        elements = rows;
        flow.requestWords(rows.filter(row => row.nameID).map(row => `#${row.nameID}`));
      }, failure).finally(done);
    }
    return () => { current = false; };
  });
  $effect(() => {
    void revision;
    const row = selectedElement;
    rights = null;
    detailError = "";
    if (!row) return;
    let current = true;
    void flow.loadShipSkinrComponentLicense(row).then(value => { if (current) rights = value; },
      cause => { if (current) detailError = panelErrorWords(cause); });
    return () => { current = false; };
  });
  onMount(() => {
    const notices = flow.gatewayNotices;
    let previous = notices.get();
    return notices.subscribe(notice => {
      if (notice === previous) return;
      previous = notice;
      const type = notice?.typeName;
      if (tab === "skins" ? type?.startsWith(SHIP_SKINR_GATEWAY + "license.api.") :
        type?.startsWith(SHIP_SKINR_GATEWAY + "component.license.api.") ||
          type?.startsWith(SHIP_SKINR_GATEWAY + "sequencing.job.api.")) revision++;
    });
  });

  async function changeSkin(row: ShipSkinrOwnedSkin, action: "activate" | "activateApply" | "apply" | "remove") {
    if (activating || (action !== "activate" && !matchesActive)) return;
    const owner = pilot;
    const ship = activeShip;
    const activates = action === "activate" || action === "activateApply";
    activating = true;
    detailError = "";
    try {
      if (activates) {
        const dialog = action === "activate" ? "ActivateSkin" : "ActivateAndApply";
        const confirmed = await flow.askClientDialogWith(dialog, {}, `${word(action)} this SKIN?`);
        if (!confirmed || owner !== pilot || (action === "activateApply" && ship !== activeShip)) return;
        await flow.activateShipSkinrLicense(row.hex);
        if (owner !== pilot) return;
        revision++;
      }
      if (ship && ship === activeShip && action !== "activate") await flow.applyShipSkinrLicense(row.hex, ship, action === "remove");
      if (owner === pilot && action === "activateApply") {
        section = null;
        selectedSkinSection = "activated";
      }
    } catch (cause) {
      if (owner === pilot) detailError = panelErrorWords(cause);
    } finally {
      activating = false;
    }
  }
</script>

<section class="skinr-collection" aria-label={word("title")}>
  {#if selling}
    <ShipSkinrSell {store} {flow} skin={selling} onClose={() => selling = null}
      onListed={() => { selling = null; listed = true; revision++; }} />
  {:else}
  <nav aria-label={word("title")}>
    {#each (["skins", "elements"] as const) as option}
      <button type="button" aria-pressed={tab === option} onclick={() => choose(option)}>{word(option)}</button>
    {/each}
  </nav>
  {#if listed}<p role="status">Listing created.</p>{/if}
  {#if error}
    <p role="alert">{error}</p><button type="button" onclick={() => revision++}>Retry</button>
  {:else if loading && (tab === "skins" ? !skins : !elements)}
    <p role="status">Loading collection…</p>
  {:else}
    <div class="collection-filters">
      {#if section}<button type="button" onclick={() => choose(tab)}>{word("back")}</button>{/if}
      {#if tab === "skins" && hulls.length}
        <label>Hull <select bind:value={hull} onchange={() => selected = null}>
          <option value={0}>All Hulls</option>
          {#each hulls as id (id)}<option value={id}>{hullName(id)}</option>{/each}
        </select></label>
      {/if}
      {#if tab === "skins"}
        <label>{word("sort")} <select bind:value={reverse}><option value={false}>{word("name")}</option>
          <option value={true}>{word("reverse")}</option></select></label>
      {:else}
        <label>{word("sort")} <select bind:value={elementOrder}>
          {#each elementOrders as order (order)}<option value={order}>{word(order)}</option>{/each}
        </select></label>
      {/if}
    </div>
    {#if tab === "skins"}
      {#each skinSections.filter(category => !section || section === category) as category (category)}
        {@const rows = sortedSkins.filter(row => category === "activated" ? row.activated : row.unactivated > 0)}
        <section class="collection-section" aria-label={word(category)}>
          <header><h3>{word(category)} <span>{rows.length}</span></h3>
            {#if !section && rows.length}<button type="button" onclick={() => choose("skins", category)}>{word("view")}</button>{/if}
          </header>
          {#if !rows.length}<p>No SKINs in this section.</p>{/if}
          <div class="collection-rows">
            {#each section ? rows : rows.slice(0, 6) as row (row.hex)}
              {@const icon = row.design ? typeIconUrl(row.design.shipTypeID) : null}
              <button type="button" data-skin={row.hex} aria-pressed={selected === row.hex && selectedSkinSection === category}
                onclick={() => { selected = row.hex; selectedSkinSection = category; detailError = ""; }}>
                {#if icon}<img src={icon} alt="" width="32" height="32" loading="lazy" />{/if}
                <strong>{skinName(row)}</strong>
                {#if category === "unactivated"}<span>{row.unactivated}</span>{/if}
              </button>
            {/each}
          </div>
        </section>
      {/each}
    {:else}
      {#each elementSections.filter(category => !section || section === category) as category (category)}
        {@const rows = sortedElements.filter(row => row.category === category)}
        <section class="collection-section" aria-label={word(category)}>
          <header><h3>{word(category)} <span>{rows.length}</span></h3>
            {#if !section && rows.length}<button type="button" onclick={() => choose("elements", category)}>{word("view")}</button>{/if}
          </header>
          {#if !rows.length}<p>No design elements in this section.</p>{/if}
          <div class="collection-rows">
            {#each section ? rows : rows.slice(0, 6) as row (elementKey(row))}
              <button type="button" data-element={row.id} aria-pressed={selected === elementKey(row)} onclick={() => selected = elementKey(row)}>
                {#if row.icon}<img src={row.icon} alt="" width="32" height="32" loading="lazy" />
                {:else if row.swatch}<span class="swatch" style:background={row.swatch}></span>{/if}
                <strong>{elementName(row)}</strong>
              </button>
            {/each}
          </div>
        </section>
      {/each}
    {/if}
    {#if selectedSkin}
      <aside class="collection-details">
        <h3>{skinName(selectedSkin)}</h3>
        {#if selectedSkin.design}
          <ShipSkinrPreview {flow} design={selectedSkin.design} active={!selling} />
          {#if selectedSkin.design.lineName}<p>{selectedSkin.design.lineName}</p>{/if}
          <p>{hullName(selectedSkin.design.shipTypeID)} · Tier {selectedSkin.design.tier}</p>
        {/if}
        {#if selectedSkin.activated}<p>{word("activated")}</p>{/if}
        {#if selectedSkin.unactivated}<p>{word("unactivated")} · {selectedSkin.unactivated}</p>{/if}
        {#if selectedSkin.escrowed}<p>Listed · {selectedSkin.escrowed}</p>{/if}
        <div class="collection-actions">
          {#if selectedSkinSection === "activated" && selectedSkin.activated}
            {#if currentlyApplied}
              <button type="button" disabled={activating} onclick={() => void changeSkin(selectedSkin!, "remove")}>{word("remove")}</button>
            {:else}
              <button type="button" disabled={activating || !matchesActive} title={!matchesActive ? word("wrongHull") : undefined}
                onclick={() => void changeSkin(selectedSkin!, "apply")}>{word("apply")}</button>
            {/if}
          {:else if !selectedSkin.activated && selectedSkin.unactivated}
            <button type="button" disabled={activating} onclick={() => void changeSkin(selectedSkin!, "activate")}>{word("activate")}</button>
            {#if matchesActive}
              <button type="button" disabled={activating} onclick={() => void changeSkin(selectedSkin!, "activateApply")}>{word("activateApply")}</button>
            {/if}
          {/if}
          {#if selectedSkinSection === "unactivated" && selectedSkin.design && selectedSkin.unactivated > 0}
            <button type="button" disabled={activating} onclick={() => { listed = false; selling = selectedSkin ?? null; }}>{word("sell")}</button>
          {/if}
        </div>
      </aside>
    {:else if selectedElement}
      <aside class="collection-details">
        <h3>{elementName(selectedElement)}</h3>
        {#if rights}
          {#if rights.infinite}<p>Unlimited use</p>{/if}
          {#if rights.finite}
            <p>Limited uses · {rights.finite}</p>
            {#if selectedElement.marketTypeID}
              {@const typeID = selectedElement.marketTypeID}
              <button type="button" onclick={() => showMarketDetails(typeID)}>{word("market")}</button>
            {/if}
          {/if}
        {:else if !detailError}<p role="status">Loading license…</p>{/if}
      </aside>
    {/if}
    {#if detailError}<p role="alert">{detailError}</p>{/if}
  {/if}
  {/if}
</section>

<style>
  .skinr-collection { display: grid; gap: 12px; padding: 14px 18px 18px; }
  nav, header, .collection-filters, .collection-filters label { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  header { justify-content: space-between; }
  h3, p { margin: 0; }
  h3 span { color: #b8c3cc; font-size: .8em; }
  .collection-section, .collection-details { display: grid; gap: 8px; background: #ffffff08; padding: 12px; }
  .collection-details button { justify-self: start; }
  .collection-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .collection-rows { display: grid; gap: 6px; grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr)); }
  .collection-rows button { display: flex; align-items: center; text-align: left; gap: 8px; }
  button[aria-pressed="true"] { border-color: #94b8c2; }
  .swatch { display: inline-block; width: 24px; height: 24px; flex: 0 0 24px; border: 1px solid #ffffff32; }
</style>
