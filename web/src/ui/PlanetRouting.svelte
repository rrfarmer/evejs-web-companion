<script lang="ts">
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import { formatDuration } from "../bridge/planets.ts";
  import { pinDesignator, planetProduct, quotePlanetRoute, type PlanetRouteFacts } from "../bridge/planetRouting.ts";
  import type { NewRoute } from "../bridge/planetWrites.ts";
  import type { PiRecipeBook } from "../bridge/piRecipes.ts";
  import type { Colony, ColonyPin, ColonyRoute } from "../store/types.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { pin, colony, recipes, flow, routes, removing, path, routing, waypointError, disabled, sourceChanging,
    start, addWaypoint, close, highlight, stage, toggleRemoval }: {
    pin: ColonyPin; colony: Colony; recipes: PiRecipeBook; flow: AppFlow;
    routes: readonly ColonyRoute[]; removing: ReadonlySet<number>;
    path: readonly number[]; routing: boolean; waypointError: string; disabled: boolean; sourceChanging: boolean;
    start: () => void; addWaypoint: (id: number) => void; close: () => void;
    highlight: (path: readonly number[]) => void; stage: (route: NewRoute) => void;
    toggleRemoval: (route: ColonyRoute) => void;
  } = $props();

  let tab = $state<"products" | "routes" | null>(null);
  let inspected = $state<number | null>(null);
  let facts = $state.raw<PlanetRouteFacts | null>(null);
  let failure = $state("");
  let retry = $state(0);
  let amount = $state<number | undefined>(undefined);
  const product = $derived(planetProduct(colony, pin, recipes));
  const shownTab = $derived(tab ?? (product ? "products" : "routes"));
  const pins = $derived(new Map(colony.pins.map(pin => [pin.pinID, pin])));
  const involving = $derived(routes.filter(route => route.path.includes(pin.pinID)));
  const selected = $derived(involving.find(route => route.routeID === inspected));
  const types = $derived([...new Set(product ? [product.typeID, ...colony.routes.map(route => route.commodityTypeID)] : [])].sort((a,b) => a - b).join(","));
  const quote = $derived(routing && product && facts ? quotePlanetRoute(colony, recipes, facts, path, product.typeID) : null);
  const quantity = $derived(amount ?? quote?.max ?? 0);
  const canStage = $derived(!disabled && !sourceChanging && quote && !waypointError && !quote.error &&
    Number.isSafeInteger(quantity) && quantity > 0 && quantity <= quote.max);

  $effect(() => {
    path;
    amount = undefined;
  });

  $effect(() => {
    retry;
    facts = null;
    failure = "";
    if (!routing || !types) return;
    let current = true;
    void flow.readPlanetRouteFacts(types.split(",").map(Number)).then(value => {
      if (current) facts = value;
    }).catch(cause => {
      if (current) failure = errorWords(cause);
    });
    return () => { current = false; };
  });

  function selectTab(next: "products" | "routes"): void {
    close();
    tab = next;
    inspected = null;
    highlight([]);
  }

  function inspect(route: ColonyRoute): void {
    inspected = route.routeID;
    highlight(route.path);
  }

  export function stageRoute(): void {
    if (!canStage || !product) return;
    stage({ path: [...path], typeID: product.typeID, quantity });
    tab = "routes";
  }

  const name = (id: number) => `${pins.get(id)?.typeName ?? "Installation"} · ${pinDesignator(id)}`;
  const fmt = (units: number) => units.toLocaleString(undefined, { maximumFractionDigits: 4 });
</script>

<section class="planet-routing" aria-label="Installation routing">
  <div class="routing-tabs">
    {#if product}
      <button type="button" aria-pressed={shownTab === "products"} onclick={() => selectTab("products")}>Products</button>
    {/if}
    <button type="button" aria-pressed={shownTab === "routes"} onclick={() => selectTab("routes")}>Routes</button>
  </div>
  {#if routing && product}
    <section class="route-composer" aria-label="Create commodity route">
      <div class="route-product"><TypeIcon typeID={product.typeID} name={product.name} /><strong>{product.name}</strong></div>
      <label>Waypoint or destination
        <select value="" onchange={(event) => {
          if (event.currentTarget.value) addWaypoint(Number(event.currentTarget.value));
          event.currentTarget.value = "";
        }}>
          <option value="">Choose an installation</option>
          {#each colony.pins as target (target.pinID)}
            <option value={target.pinID}>{name(target.pinID)}{target.pinID === pin.pinID ? " (origin)" : ""}</option>
          {/each}
        </select>
      </label>
      <ol class="route-path" aria-label="Route path">
        {#each path as id (id)}
          <li><button type="button" onclick={() => addWaypoint(id)}>{name(id)}</button></li>
        {/each}
      </ol>
      {#if failure}
        <p role="alert">{failure}</p><button type="button" onclick={() => { retry += 1; }}>Retry link data</button>
      {:else if waypointError}
        <p role="alert">{waypointError}</p>
      {:else if !facts}
        <p role="status">Reading link bandwidth…</p>
      {:else if quote?.error}
        <p role="status">{quote.error}</p>
      {:else if quote}
        <label>Quantity per cycle
          <input type="number" min="1" max={quote.max} step="1" value={quantity}
            oninput={(event) => { amount = event.currentTarget.valueAsNumber; }} />
        </label>
        <dl>
          <div><dt>Maximum</dt><dd>{fmt(quote.max)} units</dd></div>
          <div><dt>Cycle time</dt><dd>{formatDuration(quote.cycle * 1000)}</dd></div>
          <div><dt>Route bandwidth</dt><dd>{fmt(Number.isFinite(quantity) ? quantity * quote.perUnit : 0)} m³/h</dd></div>
          <div><dt>Available bandwidth</dt><dd>{fmt(quote.freeBandwidth)} m³/h</dd></div>
        </dl>
      {/if}
      <footer>
        <button type="button" disabled={!canStage} onclick={stageRoute}>Create Route</button>
        <button type="button" onclick={close}>Cancel Route</button>
      </footer>
    </section>
  {:else if shownTab === "products" && product}
    <div class="route-product"><TypeIcon typeID={product.typeID} name={product.name} /><strong>{product.name}</strong></div>
    <p>{fmt(product.routed)} routed · {fmt(product.available)} available per cycle</p>
    <button type="button" disabled={disabled || sourceChanging || !product.available} onclick={start}>Create Route</button>
    {#if sourceChanging}<p>Submit the extractor program to route its output.</p>{/if}
  {:else}
    {#if involving.length}
      <ul class="route-list">
        {#each involving as route (route.routeID)}
          {@const from = route.path[0]!}
          {@const to = route.path.at(-1)!}
          <li>
            <button type="button" aria-pressed={inspected === route.routeID} data-route-id={route.routeID}
              onmouseenter={() => highlight(route.path)} onmouseleave={() => highlight(selected?.path ?? [])}
              onclick={() => inspect(route)}>
              <strong>{route.commodityTypeName ?? "Commodity"} <span>{fmt(route.commodityQuantity)} per cycle</span></strong>
              <small>{from === pin.pinID ? "Outgoing" : to === pin.pinID ? "Incoming" : "Transiting"} · {name(from)} → {name(to)}</small>
              {#if removing.has(route.routeID)}<small>Pending removal</small>
              {:else if route.routeID < 0}<small>Pending creation</small>{/if}
            </button>
          </li>
        {/each}
      </ul>
      {#if selected}
        <button type="button" disabled={disabled} onclick={() => {
          toggleRemoval(selected);
          if (selected.routeID < 0) inspected = null;
        }}>
          {removing.has(selected.routeID) ? "Keep Route" : "Remove Route"}
        </button>
      {/if}
    {:else}<p>No routes through this installation.</p>{/if}
  {/if}
</section>

<style>
  .planet-routing, .route-composer { display: grid; gap: .4rem; }
  .planet-routing { border-top: 1px solid #46606a; padding-top: .35rem; }
  .routing-tabs, footer, .route-product, dl div { display: flex; align-items: center; gap: .35rem; flex-wrap: wrap; }
  p, dl, dd, ol { margin: 0; }
  dl div { justify-content: space-between; }
  dt, small { color: #b5cad4; }
  .route-path { padding-inline-start: 1.4rem; }
  .route-path li { padding-block: .06rem; }
  .route-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .2rem; }
  .route-list button { width: 100%; text-align: start; display: grid; gap: .12rem; }
  .route-list strong span { font-weight: 400; }
  label { display: grid; gap: .12rem; }
  button, select, input { color: inherit; background: #1a2b35; border: 1px solid #536874; padding: .24rem .42rem; font: inherit; }
  button { cursor: pointer; }
  button:disabled { cursor: default; opacity: .5; }
  button[aria-pressed=true], button:hover:enabled { border-color: #9de9df; }
  input, select { min-width: 0; }
  [role=alert] { color: #ffca83; }
</style>
