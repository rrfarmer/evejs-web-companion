<script lang="ts">
  import { errorWords, type AppFlow } from "../app/flow.ts";
  import { linkBudgetError, linkUsage, MAX_LINK_LEVEL, pathUsesLink, type PlanetLinkFacts } from "../bridge/planetLinks.ts";
  import type { PiRecipeBook } from "../bridge/piRecipes.ts";
  import { pinDesignator, routeBandwidth, type PlanetRouteFacts } from "../bridge/planetRouting.ts";
  import type { Colony, ColonyLink } from "../store/types.ts";

  let { colony, link, recipes, facts, factsError, disabled, flow, close, upgrade, remove, highlight }: {
    colony: Colony; link: ColonyLink; recipes: PiRecipeBook; facts: PlanetLinkFacts; factsError: string;
    disabled: boolean; flow: AppFlow;
    close: () => void; upgrade: () => void; remove: () => void;
    highlight: (path: readonly number[]) => void;
  } = $props();

  let bandwidthFacts = $state.raw<PlanetRouteFacts | null>(null);
  let bandwidthError = $state("");
  let decommission = $state(false);
  const from = $derived(colony.pins.find(pin => pin.pinID === link.endpoint1));
  const to = $derived(colony.pins.find(pin => pin.pinID === link.endpoint2));
  const routes = $derived(colony.routes.filter(route => pathUsesLink(route.path, link)));
  const current = $derived(from && to ? linkUsage(colony.radius, from, to, link.level, facts) : null);
  const next = $derived(from && to && link.level < MAX_LINK_LEVEL ? linkUsage(colony.radius, from, to, link.level + 1, facts) : null);
  const problem = $derived(link.level >= MAX_LINK_LEVEL ? "Maximum upgrade level reached."
    : factsError || (current && next ? linkBudgetError(colony, { ...link, level: link.level + 1 }, facts) : "Reading CPU and power…"));
  const capacity = $derived(current?.bandwidth ?? (bandwidthFacts ? bandwidthFacts.baseLinkBandwidth * 2 ** link.level : null));
  const rates = $derived(routes.map(route => bandwidthFacts ? routeBandwidth(colony, route, recipes, bandwidthFacts) : null));
  const used = $derived(rates.every(rate => rate !== null) ? rates.reduce<number>((sum, rate) => sum + (rate ?? 0), 0) : null);
  const amount = (value: number | null) => value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 1 });

  $effect(() => {
    const types = routes.map(route => route.commodityTypeID);
    let active = true;
    bandwidthFacts = null;
    bandwidthError = "";
    void flow.readPlanetRouteFacts(types).then(facts => {
      if (active) bandwidthFacts = facts;
    }).catch(cause => { if (active) bandwidthError = errorWords(cause); });
    return () => { active = false; };
  });
</script>

<section class="link-details" aria-label="Planetary Link">
  <header>
    <strong>Planetary Link</strong>
    <button type="button" aria-label="Close link details" onclick={close}>×</button>
  </header>
  <p>{from?.typeName} · {pinDesignator(link.endpoint1)}<br>{to?.typeName} · {pinDesignator(link.endpoint2)}</p>
  <dl>
    <div><dt>Upgrade level</dt><dd>{link.level}</dd></div>
    {#if current}<div><dt>Distance</dt><dd>{amount(current.km)} km</dd></div>{/if}
    <div><dt>Capacity used</dt><dd>{amount(used)} / {amount(capacity)} m³/h</dd></div>
  </dl>
  {#if capacity && used !== null}
    <meter min="0" max={capacity} value={Math.min(capacity, used)} aria-label="Link capacity used"></meter>
  {/if}
  <table aria-label="Link upgrade">
    <thead><tr><th></th><th scope="col">Capacity</th><th scope="col">CPU</th><th scope="col">Power</th></tr></thead>
    <tbody>
      <tr><th scope="row">Current</th><td>{amount(capacity)}</td><td>{amount(current?.cpu ?? null)}</td><td>{amount(current?.power ?? null)}</td></tr>
      {#if current && next}
        <tr><th scope="row">Level {link.level + 1}</th><td>{amount(next.bandwidth)}</td><td>{amount(next.cpu)}</td><td>{amount(next.power)}</td></tr>
        <tr><th scope="row">Change</th><td>+{amount(next.bandwidth - current.bandwidth)}</td><td>+{amount(next.cpu - current.cpu)}</td><td>+{amount(next.power - current.power)}</td></tr>
      {/if}
      <tr class="units"><td></td><td>m³/h</td><td>tf</td><td>MW</td></tr>
    </tbody>
  </table>
  {#if problem}<p role="status">{problem}</p>{/if}
  <div class="actions">
    <button type="button" disabled={disabled || Boolean(problem)} onclick={upgrade}>Upgrade</button>
    <button type="button" disabled={disabled} aria-expanded={decommission} onclick={() => { decommission = !decommission; }}>Decommission</button>
  </div>
  {#if decommission}
    <p>{routes.length ? `Removing this link will also remove ${routes.length} ${routes.length === 1 ? "route" : "routes"}.` : "Remove this link?"}</p>
    <button type="button" disabled={disabled} onclick={remove}>Proceed</button>
  {/if}
  <details>
    <summary>Routes ({routes.length})</summary>
    {#if bandwidthError}<p role="status">{bandwidthError}</p>{/if}
    {#each routes as route, index (route.routeID)}
      <button type="button" class="link-route" onclick={() => highlight(route.path)}>
        {route.commodityTypeName ?? "Commodity"} · {route.commodityQuantity.toLocaleString()} · {amount(rates[index] ?? null)} m³/h
      </button>
    {:else}
      <p>No routes through this link.</p>
    {/each}
  </details>
</section>

<style>
  .link-details { display: grid; gap: 8px; }
  header, .actions, dl div { display: flex; align-items: center; gap: 8px; }
  header button, dd { margin-inline-start: auto; }
  header strong { font-size: 1rem; }
  p, dl, dd { margin: 0; }
  dl div { padding: 2px 0; }
  dt, .units { color: #a0b8c4; }
  meter { width: 100%; height: .65rem; }
  meter::-webkit-meter-optimum-value { background: #80c2d2; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 4px; text-align: end; }
  thead th { background: #263642; }
  th:first-child { text-align: start; }
  tbody tr { border-bottom: 1px solid #819fad44; }
  button { border: 1px solid #536673; background: #283643; color: inherit; font: inherit; padding: 5px 8px; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .link-route { display: block; width: 100%; margin-block: 4px; text-align: start; }
  summary { cursor: pointer; }
</style>
