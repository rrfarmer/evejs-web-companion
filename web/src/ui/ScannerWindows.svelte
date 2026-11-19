<script lang="ts">
  import type { Session } from "../app/sessions.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { session, inFront }: { session: Session; inFront: boolean } = $props();
  const cargoScans = $derived(session.flow.cargoScans);
  const shipScans = $derived(session.flow.shipScans);
  const names = $derived(session.store.names);
  const typeName = (typeID: number) => resolvedName($names.resolved, "type", typeID, `Type ${typeID}`);
  const capacitorFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
</script>

{#if inFront && ($cargoScans.length || $shipScans.length)}
  <div class="cargo-scan-layer">
    {#each $shipScans as scan (scan.targetID)}
      {@const target = scan.targetName?.trim() || (scan.targetTypeID === null ? `Target ${scan.targetID}` : typeName(scan.targetTypeID))}
      {@const percent = scan.capacitorCapacity > 0 ? 100 * Math.min(1, Math.max(0, scan.capacitorCharge / scan.capacitorCapacity)) : 100}
      {@const reading = `${capacitorFormat.format(scan.capacitorCharge)} / ${capacitorFormat.format(scan.capacitorCapacity)} GJ`}
      <section class="ship-scan" data-ship-scan-target={scan.targetID} aria-label={`Ship scan of ${target}`}>
        <header>
          <div><h2>Ship Scan</h2><p>{target}</p></div>
          <button type="button" class="close" aria-label={`Close ship scan of ${target}`} onclick={() => session.flow.closeShipScan(scan.targetID)}>×</button>
        </header>
        <div class="capacitor">
          <div><span>Capacitor</span><span class="quantity">{reading}</span></div>
          <meter min="0" max="100" value={percent} aria-label="Capacitor" aria-valuetext={reading}></meter>
        </div>
        {#if scan.groups.length === 0}
          <p class="empty">No modules detected.</p>
        {:else}
          <h3 class="modules">Fitted modules</h3>
          {#each scan.groups as group (group.name)}
            <div class="hardware-group" data-slot-group={group.name}>
              <h4>{group.name}</h4>
              <ul aria-label={group.name}>
                {#each group.rows.toSorted((a, b) => typeName(a.typeID).localeCompare(typeName(b.typeID))) as row (row.typeID)}
                  {@const name = typeName(row.typeID)}
                  <li data-type-id={row.typeID}>
                    <button type="button" class="module-info item" aria-label={`Show info for ${name}`} onclick={() => showInfo({ kind: "type", typeID: row.typeID })}>
                      <TypeIcon typeID={row.typeID} {name} size="sm" /><span>{name}</span>
                    </button>
                    {#if row.quantity !== null}<span class="quantity">×{row.quantity.toLocaleString()}</span>{/if}
                  </li>
                {/each}
              </ul>
            </div>
          {/each}
        {/if}
      </section>
    {/each}
    {#each $cargoScans as scan (scan.targetID)}
      {@const target = scan.targetName?.trim() || (scan.targetTypeID === null ? `Target ${scan.targetID}` : typeName(scan.targetTypeID))}
      <section class="cargo-scan" data-scan-target={scan.targetID} aria-label={`Cargo scan of ${target}`}>
        <header>
          <div><h2>Cargo Scan</h2><p>{target}</p></div>
          <button type="button" class="close" aria-label={`Close cargo scan of ${target}`} onclick={() => session.flow.closeCargoScan(scan.targetID)}>×</button>
        </header>
        {#if scan.rows.length === 0}
          <p class="empty">No cargo detected.</p>
        {:else}
          <table>
            <thead><tr><th scope="col">Item</th><th scope="col">Quantity</th></tr></thead>
            <tbody>
              {#each scan.rows as row}
                {@const name = typeName(row.typeID)}
                <tr data-type-id={row.typeID}>
                  <td><div class="item"><TypeIcon typeID={row.typeID} {name} size="sm" /><span>{name}{row.quantity === -2 ? " (Copy)" : ""}</span></div></td>
                  <td class="quantity">{row.quantity > 0 ? row.quantity.toLocaleString() : 1}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<style>
  .cargo-scan-layer { position: fixed; z-index: 1600; inset: 4.5rem 1rem auto auto; display: grid; gap: 0.6rem;
    width: min(24rem, calc(100vw - 2rem)); max-height: calc(100dvh - 6rem); overflow: auto; }
  .cargo-scan, .ship-scan { background: #111820; border: 1px solid #4a6575; color: #e3ebef; box-shadow: 0 6px 22px #0009; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; padding: 0.65rem 0.8rem; border-bottom: 1px solid #344752; }
  h2, p { margin: 0; }
  h2 { font-size: 0.95rem; }
  header p { margin-top: 0.2rem; color: #aec4d0; font-size: 0.8rem; overflow-wrap: anywhere; }
  .close { background: transparent; border: 0; color: inherit; font-size: 1.2rem; cursor: pointer; }
  .capacitor { padding: 0.65rem 0.8rem; font-size: 0.82rem; }
  .capacitor div { display: flex; justify-content: space-between; gap: 0.5rem; }
  meter { display: block; width: 100%; height: 0.65rem; margin-top: 0.25rem; accent-color: #60bfd6; }
  meter::-webkit-meter-optimum-value { background: #60bfd6; }
  .modules { margin: 0; padding: 0.4rem 0.8rem; font-size: 0.85rem; border-top: 1px solid #344752; }
  .hardware-group h4 { margin: 0; padding: 0.24rem 0.8rem; background: #22323e; color: #aec4d0; font-size: 0.78rem; }
  .hardware-group ul { list-style: none; margin: 0; padding: 0; }
  .hardware-group li { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
    padding: 0.2rem 0.8rem; border-bottom: 1px solid #293641; font-size: 0.82rem; }
  .module-info { background: transparent; border: 0; color: inherit; padding: 0; text-align: start; cursor: pointer; }
  .module-info:hover { color: #91d3e5; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th, td { padding: 0.35rem 0.75rem; border-bottom: 1px solid #293641; text-align: left; }
  th { color: #aec4d0; }
  th:last-child, .quantity { text-align: right; }
  .item { display: flex; align-items: center; gap: 0.5rem; overflow-wrap: anywhere; }
  .quantity { font-variant-numeric: tabular-nums; }
  .empty { padding: 0.8rem; color: #aec4d0; }
</style>
