<script module lang="ts">
  export type Section = "operations" | "fleet";
  export type Availability = {
    label: string;
    available: boolean;
    botID?: string;
    issue?: string;
    shipName?: string;
  };
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { active, type Office, type Operation } from "../../logistics/model.ts";
  import type { DistributionView, FleetRow } from "../../logistics/store.ts";
  import CenterHeading from "./CenterHeading.svelte";
  import CenterStatus from "./CenterStatus.svelte";

  let {
    view,
    section,
    selected,
    availability,
    busy,
    names,
    docks,
    issue,
    adding = false,
    addPilot,
    editor,
    onSection,
    onSelect,
    onNew,
    onEdit,
    onStart,
    onStop,
    onAdd,
    onRefresh,
    onConnect,
    onDisconnect,
    onRemove,
  }: {
    view: DistributionView;
    section: Section;
    selected: Operation | undefined;
    availability: Record<number, Availability>;
    names: Record<number, string | null>;
    docks: Record<number, string | null>;
    busy: boolean;
    issue: string;
    adding?: boolean;
    addPilot?: Snippet;
    editor?: Snippet;
    onSection: (section: Section) => void;
    onSelect: (id: string) => void;
    onNew: () => void;
    onEdit: (op: Operation) => void;
    onStart: (op: Operation) => void;
    onStop: (op: Operation) => void;
    onAdd: () => void;
    onRefresh: () => void;
    onConnect: (pilot: FleetRow) => void;
    onDisconnect: (pilot: FleetRow) => void;
    onRemove: (pilot: FleetRow) => void;
  } = $props();

  const modes = { MANUAL: "Manual Delivery", COLLECTION: "Collection", SUPPLY: "Supply" };
  const states = {
    RUNNING: "Running",
    STOPPING: "Finishing freight",
    STOPPED: "Stopped",
    COMPLETED: "Completed",
    INCOMPLETE: "Finished with items left",
  };
  const operationStatus = (op: Operation) =>
    op.execution?.state === "RUNNING" && op.execution.sourceFinished
      ? states.STOPPING
      : op.execution
        ? states[op.execution.state]
        : "Saved";
  const routeName = (office: Office) =>
    office.name ??
    docks[office.destinationID] ??
    (office.kind === "station" ? "NPC station" : "Upwell structure");
  const amount = new Intl.NumberFormat();
  const volume = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });
  const job = (pilot: FleetRow) =>
    view.operations.find((op) => op.id === (pilot.trip?.operationID ?? pilot.hosted?.operationID));
  const rosterFor = (op: Operation) => view.roster.filter((row) => job(row)?.id === op.id);
  const ready = $derived(
    view.roster.filter((row) => row.hosted?.phase === "Idle" && !row.trip).length,
  );
  const enRoute = $derived(
    view.roster.filter(
      (row) => row.hosted && row.hosted.phase !== "Idle" && row.hosted.phase !== "Attention",
    ).length,
  );
  const canStop = (row: FleetRow) => !row.trip && (!row.hosted || row.hosted.phase === "Idle");
  const isHosted = (row: FleetRow) => !!row.hosted || !!availability[row.characterID]?.botID;
  const pilotStatus = (row: FleetRow) =>
    row.hosted?.phase === "Attention" || row.trip?.issue
      ? "Needs attention"
      : row.hosted?.phase === "Idle"
        ? "Idle"
        : row.hosted
          ? "On a trip"
          : row.trip
            ? "Freight on board"
            : "Off duty";
  const ship = (row: FleetRow) => {
    const observed =
      (row.hosted?.shipTypeID ? names[row.hosted.shipTypeID] : null) ??
      availability[row.characterID]?.shipName;
    return observed ?? (row.shipName ? row.shipName + " · last seen" : "Ship unavailable");
  };
</script>

{#snippet routeCards(op: Operation)}
  <div class="route">
    <div class="endpoint"><span class="marker" aria-hidden="true">A</span><div><span class="caption">Source</span><strong>{routeName(op.config.source)}</strong>
      <small>Division {op.config.source.division} · {op.config.source.kind === "station" ? "NPC station" : "Upwell"}</small></div></div>
    <span class="direction" aria-hidden="true">→</span>
    <div class="endpoint"><span class="marker" aria-hidden="true">B</span><div><span class="caption">Destination</span><strong>{routeName(op.config.destination)}</strong>
      <small>Division {op.config.destination.division} · {op.config.destination.kind === "station" ? "NPC station" : "Upwell"}</small></div></div>
  </div>
{/snippet}

{#snippet onBoard(pilot: FleetRow)}
  {#if pilot.trip?.cargo.length}
    <ul class="load" aria-label={"Freight aboard " + pilot.name}>
      {#each pilot.trip.cargo as item (item.typeID)}
        <li>{amount.format(item.quantity)} {names[item.typeID] ?? job(pilot)?.config.items.find(row => row.typeID === item.typeID)?.name ?? "units of freight"} aboard</li>
      {/each}
    </ul>
  {/if}
  {#if pilot.trip?.checking}
    <small>Checking {amount.format(pilot.trip.checking.quantity)} {names[pilot.trip.checking.typeID] ?? "units of freight"}</small>
  {/if}
{/snippet}

<main class="uoc-center">
  <CenterHeading title="Distribution Center" description="Move goods between corporation hangars with one shared fleet." />
  <nav class="center-tabs" aria-label="Distribution Center sections">
    <button type="button" aria-pressed={section === "operations"} onclick={() => onSection("operations")}>Operations</button>
    <button type="button" aria-pressed={section === "fleet"} onclick={() => onSection("fleet")}>Fleet</button>
  </nav>
  {#if issue}<p class="center-message" role="alert">{issue}</p>{/if}

  {#if section === "fleet"}
    <section aria-labelledby="fleet-heading">
      <div class="heading"><div><h2 id="fleet-heading">Transport fleet</h2>
        <p>{view.roster.length} in fleet <span aria-hidden="true">·</span> {ready} ready <span aria-hidden="true">·</span> {enRoute} on a trip</p></div>
        <div class="actions"><button type="button" disabled={busy || !view.roster.length} onclick={onRefresh}>Refresh availability</button>
          <button type="button" class="primary" disabled={busy} onclick={onAdd}>{adding ? "Close pilot picker" : "Add hauler"}</button></div>
      </div>
      {#if adding && addPilot}<div class="panel picker">{@render addPilot()}</div>{/if}
      {#if view.roster.length}
        <div class="panel table-panel">
          <table>
            <thead><tr><th scope="col">Pilot / ship</th><th scope="col">Bot Host</th><th scope="col">Current work</th><th scope="col">Actions</th></tr></thead>
            <tbody>
              {#each view.roster as pilot (pilot.characterID)}
                {@const operation = job(pilot)}
                {@const check = availability[pilot.characterID]}
                {@const status = pilotStatus(pilot)}
                <tr>
                  <th scope="row"><strong>{pilot.name}</strong><small>{ship(pilot)}</small></th>
                  <td><strong>{pilot.hosted ? "Connected" : check?.label ?? "Not connected"}</strong>
                    <CenterStatus state={status} />
                    {#if check?.issue && !pilot.hosted}<small class="warning">{check.issue}</small>{/if}
                  </td>
                  <td>
                    {#if operation}
                      <strong>{operation.config.name}</strong>
                      <small>{routeName(operation.config.source)} → {routeName(operation.config.destination)}</small>
                    {/if}
                    <small class:warning={status === "Needs attention"}>{pilot.trip?.issue ?? pilot.hosted?.detail ?? (pilot.trip ? "Connect this pilot to finish delivery." : "—")}</small>
                    {@render onBoard(pilot)}
                  </td>
                  <td><div class="actions">
                    {#if isHosted(pilot)}
                      <button type="button" disabled={busy || !canStop(pilot)} onclick={() => onDisconnect(pilot)}>Disconnect</button>
                    {:else}
                      <button type="button" disabled={busy || check?.available === false} onclick={() => onConnect(pilot)}>Connect</button>
                      <button type="button" class="quiet" disabled={busy || !!pilot.trip} onclick={() => onRemove(pilot)}>Remove</button>
                    {/if}
                  </div></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <div class="panel empty"><h3>Your fleet is empty</h3><p>Add existing pilots from Pilot Hangar. The fleet serves every compatible operation.</p></div>
      {/if}
    </section>
  {:else}
    <section aria-labelledby="operations-heading">
      <div class="heading">
        <div><h2 id="operations-heading">Operations</h2>
          <p>{view.operations.filter(row => row.execution?.state === "RUNNING").length} running <span aria-hidden="true">·</span> {view.operations.length} saved</p></div>
        <button type="button" class="primary" disabled={busy} onclick={onNew}>New operation</button>
      </div>
      <div class="operations">
        <aside aria-label="Saved operations">
          {#each view.operations as op (op.id)}
            <button type="button" class="operation" aria-pressed={selected?.id === op.id && !editor} disabled={busy} onclick={() => onSelect(op.id)}>
              <span><strong>{op.config.name}</strong><small>{modes[op.config.mode]}</small></span>
              <span><CenterStatus state={op.execution?.state === "INCOMPLETE" ? "INCOMPLETE" : operationStatus(op)} label={operationStatus(op)} /></span>
              <small>{routeName(op.config.source)} → {routeName(op.config.destination)}</small>
              {#if op.execution}<small>{amount.format(op.execution.trips)} confirmed trips · {rosterFor(op).length} assigned</small>{/if}
              {#if rosterFor(op).some(pilot => pilotStatus(pilot) === "Needs attention")}<small class="warning">Needs attention</small>{/if}
            </button>
          {:else}
            <div class="panel empty"><p>No saved operations.</p></div>
          {/each}
        </aside>
        <div class="panel detail">
          {#if editor}
            {@render editor()}
          {:else if selected}
            {@const op = selected}
            {@const assigned = rosterFor(op)}
            <div class="heading operation-heading">
              <div><h3>{op.config.name}</h3><small>{modes[op.config.mode]}</small>
                <CenterStatus state={op.execution?.state === "INCOMPLETE" ? "INCOMPLETE" : operationStatus(op)} label={operationStatus(op)} /></div>
              <div class="actions">
                {#if active(op)}
                  {#if op.execution?.state === "RUNNING"}<button type="button" class="stop" disabled={busy} onclick={() => onStop(op)}>Stop</button>{/if}
                {:else}
                  <button type="button" disabled={busy} onclick={() => onEdit(op)}>Edit</button>
                  <button type="button" class="primary" disabled={busy || !view.roster.length} onclick={() => onStart(op)}>Start</button>
                {/if}
              </div>
            </div>
            {@render routeCards(op)}
            <p class="loading-summary">{op.config.fillPercent}% minimum load · {op.config.waitMinutes ? op.config.waitMinutes + " min max wait" : "Depart when freight is available"}</p>
            <h4>Freight <span>{amount.format(op.execution?.trips ?? 0)} confirmed trips</span></h4>
            {#if op.config.allItems}
              <p>All eligible items in the source division, including containers and their contents.</p>
              {#if op.execution}
                <p>{amount.format(Object.values(op.execution.delivered).reduce((sum, count) => sum + count, 0))} units delivered
                  {#if op.execution.deliveredVolumeM3 !== undefined} · {volume.format(op.execution.deliveredVolumeM3)} m³{/if}
                </p>
              {/if}
            {/if}
            <ul class="progress">
              {#each op.config.allItems ? [] : op.config.items as item (item.typeID)}
                {@const delivered = op.execution?.delivered[item.typeID] ?? 0}
                <li><strong>{item.name ?? names[item.typeID] ?? "Catalog item"}</strong>
                  {#if op.config.mode === "MANUAL"}
                    <progress aria-label={"Delivered " + (item.name ?? "freight")} value={Math.min(delivered, item.quantity)} max={item.quantity}></progress>
                    <span>{amount.format(delivered)} / {amount.format(item.quantity)} delivered</span>
                  {:else}
                    <span>{amount.format(delivered)} delivered · {op.config.mode === "COLLECTION" ? "Leave " : "Keep "}{amount.format(item.quantity)}</span>
                  {/if}</li>
              {:else}
                {#each Object.entries(op.execution?.delivered ?? {}) as [id, count] (id)}
                  <li><strong>{names[Number(id)] ?? "Eligible stock"}</strong><span>{amount.format(count)} delivered</span></li>
                {/each}
              {/each}
            </ul>
            {#if op.execution?.unshipped?.length}
              <h4>Items left at source</h4>
              <ul class="work">
                {#each op.execution.unshipped as item}
                  <li><strong>{amount.format(item.quantity)} × {names[item.typeID] ?? op.config.items.find(row => row.typeID === item.typeID)?.name ?? "Unidentified item"}</strong>
                    <small class="warning">{item.reason}</small></li>
                {/each}
              </ul>
            {/if}
            <h4>Haulers <span>{assigned.length} assigned</span></h4>
            {#if assigned.length}
              <ul class="work">
                {#each assigned as pilot (pilot.characterID)}
                  <li><strong>{pilot.name}</strong><small class:warning={pilotStatus(pilot) === "Needs attention"}>
                    {pilot.trip?.issue ?? pilot.hosted?.detail ?? (pilot.trip ? "Connect to finish delivery." : pilotStatus(pilot))}
                  </small>{@render onBoard(pilot)}</li>
                {/each}
              </ul>
            {:else}
              <p>{op.execution?.state === "RUNNING" ? "Waiting for a compatible hauler from Fleet." :
                !view.roster.length ? "Add a hauler to Fleet before starting." : "No haulers assigned."}</p>
            {/if}
          {:else}
            <div class="empty"><h3>Create a delivery route</h3><p>Choose where the freight comes from, what to carry and where it goes.</p></div>
          {/if}
        </div>
      </div>
    </section>
  {/if}
</main>

<style>
  h2,
  h3,
  h4 {
    margin: 0;
  }
  h2 {
    font-size: 1.3rem;
    font-weight: 650;
  }
  h3 {
    font-size: 1.16rem;
  }
  h4 {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 1rem;
    border-bottom: 1px solid #2a3c49;
    padding-bottom: 0.45rem;
    margin-top: 1.2rem;
  }
  h4 span {
    font-weight: 400;
    color: #afc1cf;
    font-size: 0.85rem;
  }
  p {
    margin: 0.28rem 0 0;
    color: #afc1cf;
  }
  strong,
  small {
    display: block;
    overflow-wrap: anywhere;
  }
  small {
    color: #afc1cf;
    font-size: 0.84rem;
    line-height: 1.4;
  }
  nav button {
    min-width: 7.3rem;
    justify-content: center;
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8rem;
    flex-wrap: wrap;
    margin-bottom: 0.8rem;
  }
  .operation-heading {
    align-items: start;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }
  .panel {
    border: 1px solid var(--center-border);
    background: var(--center-panel);
    border-radius: 0.7rem;
  }
  .empty,
  .picker,
  .detail {
    padding: 1rem;
  }
  .picker {
    margin-bottom: 0.75rem;
  }
  .operations {
    display: grid;
    grid-template-columns: minmax(14rem, 1fr) minmax(0, 2.5fr);
    gap: 1rem;
    align-items: start;
  }
  aside {
    display: grid;
    gap: 0.55rem;
  }
  button.operation {
    display: grid;
    gap: 0.35rem;
    padding: 0.75rem;
    width: 100%;
    text-align: left;
    background: var(--center-panel);
  }
  .operation[aria-pressed="true"] {
    border-color: #7acbc9;
    background: #18313c;
  }
  .route {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: 0.6rem;
    align-items: center;
  }
  .endpoint {
    display: flex;
    align-items: start;
    gap: 0.55rem;
    height: 100%;
    padding: 0.7rem;
    border: 1px solid #2a4656;
    border-radius: 0.5rem;
    background: #0e1820;
  }
  .marker {
    display: grid;
    place-items: center;
    flex: 0 0 1.65rem;
    height: 1.65rem;
    margin-top: 0.15rem;
    border: 1px solid #456e80;
    color: #aee7e9;
    border-radius: 0.35rem;
    font-size: 0.85rem;
  }
  .direction {
    color: #97d9dc;
  }
  .caption {
    display: block;
    color: #abbdc9;
    font-size: 0.82rem;
  }
  .loading-summary {
    font-size: 0.86rem;
  }
  .progress,
  .work,
  .load {
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .progress li {
    display: grid;
    grid-template-columns: minmax(6rem, 1fr) auto;
    align-items: center;
    gap: 0.4rem 0.85rem;
    padding: 0.58rem 0;
    border-bottom: 1px solid #223540;
  }
  .progress li:has(progress) {
    grid-template-columns: minmax(6rem, 1fr) minmax(5rem, 0.8fr) auto;
  }
  progress {
    width: 100%;
    accent-color: #89d8d4;
  }
  .progress span,
  .load {
    font-size: 0.85rem;
    color: #adc9d7;
    font-variant-numeric: tabular-nums;
  }
  .work li {
    padding-block: 0.45rem;
  }
  .load li {
    padding-block: 0.08rem;
  }
  .warning {
    color: #ffc3a3;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
  }
  thead {
    background: #162733;
    color: #bdcdd8;
    font-size: 0.85rem;
  }
  th,
  td {
    padding: 0.72rem 0.9rem;
    vertical-align: top;
    text-align: left;
  }
  tbody th,
  tbody td {
    border-top: 1px solid #2a3c49;
    font-weight: 400;
  }
  td:last-child {
    width: 11rem;
  }
  @media (max-width: 55rem) {
    .operations {
      grid-template-columns: minmax(0, 1fr);
    }
    aside {
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
    }
  }
  @media (max-width: 43rem) {
    table,
    tbody {
      display: block;
    }
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    tr {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid #2a3c49;
    }
    tbody th,
    tbody td {
      border: 0;
      padding: 0.55rem 0.7rem;
    }
    td:last-child {
      width: auto;
    }
  }
  @media (max-width: 35rem) {
    .route {
      grid-template-columns: minmax(0, 1fr);
    }
    .direction {
      display: none;
    }
    .progress li:has(progress) {
      grid-template-columns: 1fr auto;
    }
    progress {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
</style>
