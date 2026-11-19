<script lang="ts">
  import type { Session } from "../app/sessions.ts";
  import { resolvedName } from "../store/names.ts";
  import TypeIcon from "./TypeIcon.svelte";

  let { session, inFront }: { session: Session; inFront: boolean } = $props();
  const scans = $derived(session.flow.cargoScans);
  const names = $derived(session.store.names);
  const typeName = (typeID: number) => resolvedName($names.resolved, "type", typeID, `Type ${typeID}`);
</script>

{#if inFront && $scans.length}
  <div class="cargo-scan-layer">
    {#each $scans as scan (scan.targetID)}
      {@const target = scan.targetName?.trim() || (scan.targetTypeID === null ? `Target ${scan.targetID}` : typeName(scan.targetTypeID))}
      <section class="cargo-scan" data-scan-target={scan.targetID} aria-label={`Cargo scan of ${target}`}>
        <header>
          <div><h2>Cargo Scan</h2><p>{target}</p></div>
          <button type="button" aria-label={`Close cargo scan of ${target}`} onclick={() => session.flow.closeCargoScan(scan.targetID)}>×</button>
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
  .cargo-scan { background: #111820; border: 1px solid #4a6575; color: #e3ebef; box-shadow: 0 6px 22px #0009; }
  header { display: flex; align-items: start; justify-content: space-between; gap: 1rem; padding: 0.65rem 0.8rem; border-bottom: 1px solid #344752; }
  h2, p { margin: 0; }
  h2 { font-size: 0.95rem; }
  header p { margin-top: 0.2rem; color: #aec4d0; font-size: 0.8rem; overflow-wrap: anywhere; }
  button { background: transparent; border: 0; color: inherit; font-size: 1.2rem; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  th, td { padding: 0.35rem 0.75rem; border-bottom: 1px solid #293641; text-align: left; }
  th { color: #aec4d0; }
  th:last-child, .quantity { text-align: right; }
  .item { display: flex; align-items: center; gap: 0.5rem; overflow-wrap: anywhere; }
  .quantity { font-variant-numeric: tabular-nums; }
  .empty { padding: 0.8rem; color: #aec4d0; }
</style>
