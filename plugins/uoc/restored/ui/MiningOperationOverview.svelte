<script lang="ts">
  import type { MiningOperationRuntime } from "../adapters/mining.ts";
  import { operationTime } from "../mining/miningOperationRunView.ts";

  let { runtime, stale = false }: { runtime: MiningOperationRuntime; stale?: boolean } = $props();
  const editable = $derived(["DRAFT", "STOPPED"].includes(runtime.state));
  const hosted = $derived(runtime.members.filter((member) => member.hosted));
  const expiresAt = $derived(hosted.flatMap((member) => member.expiresAt ?? []).sort()[0]);
  const issues = $derived(
    editable
      ? []
      : runtime.members.filter(
          (member) =>
            member.failureCode ||
            (runtime.state === "ACTIVE" && !member.hosted) ||
            ["FAILED", "error"].includes(member.runtimeState) ||
            member.parkingState === "PARKING_FAILED" ||
            member.phase === "Needs attention",
        ),
  );
  const target = $derived(runtime.currentTarget);
  const onBoard = $derived.by(() => {
    const cutoff = Date.parse(runtime.observedAt ?? "") - 60_000;
    const observations =
      stale || editable
        ? []
        : runtime.members.flatMap((member) => {
            const work = member.oreLogisticsWork;
            return work &&
              work.observedAtMs >= cutoff &&
              work.observedAtMs <= cutoff + 60_000 &&
              work.rawUnits !== null &&
              work.compressedUnits !== null
              ? [work.rawUnits + work.compressedUnits]
              : [];
          });
    return observations.length ? observations.reduce((sum, quantity) => sum + quantity, 0) : null;
  });
  const delivered = $derived.by(() => {
    if (editable) return runtime.lastRun?.deliveredUnits ?? null;
    const quantities = runtime.history.flatMap((row) => {
      const proof = row.evidence as { items?: { quantity: number }[] } | null;
      return row.kind === "FREIGHT_DELIVERED" && Array.isArray(proof?.items)
        ? proof.items
            .map((item) => item.quantity)
            .filter((quantity) => Number.isSafeInteger(quantity) && quantity > 0)
        : [];
    });
    return quantities.length ? quantities.reduce((sum, quantity) => sum + quantity, 0) : null;
  });
  const units = (quantity: number | null) =>
    quantity === null ? "—" : `${quantity.toLocaleString()} units`;
</script>

<dl class="metrics">
  <div
    ><dt>Current target</dt><dd
      >{target?.targetName ?? "—"}
      {#if target}<small
          >{target.systemName ?? ""}{target.systemName ? " · " : ""}{target.state.replaceAll(
            "_",
            " ",
          )}</small
        >{/if}</dd
    ></div
  >
  <div
    ><dt>{editable ? "Fleet" : "Bot Host"}</dt><dd
      >{editable
        ? `${runtime.members.length} assigned`
        : `${hosted.length} / ${runtime.members.length} hosted`}
      {#if expiresAt}<small>Expires {operationTime(expiresAt)}</small>{/if}
      {#if runtime.rendezvous}<small
          >{runtime.rendezvous.ready.length} / {runtime.rendezvous.required.length} Miners ready</small
        >{/if}</dd
    ></div
  >
  <div
    ><dt>{editable ? "Last run delivered" : "Delivered"}</dt><dd
      >{units(delivered)}
      {#if editable && runtime.lastRun?.trips != null}<small>{runtime.lastRun.trips} trips</small>
      {:else if !editable && delivered !== null}<small>Confirmed container deliveries</small
        >{/if}</dd
    ></div
  >
  {#if !editable}<div><dt>Ore in observed holds</dt><dd>{units(onBoard)}</dd></div>{/if}
</dl>

{#if issues.length}
  <div class="fleet-issues" role="status">
    <strong>Needs attention · {issues.length} {issues.length === 1 ? "pilot" : "pilots"}</strong>
    <ul>
      {#each issues as member (member.characterID)}
        <li
          ><strong>{member.characterName}</strong> · {member.reason ??
            member.lastHostReason ??
            member.phase ??
            (member.hosted ? "Check pilot status" : "No active Bot Host session")}</li
        >
      {/each}
    </ul>
  </div>
{/if}

<style>
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(13rem, 100%), 1fr));
    gap: 0.65rem;
    margin: 0.8rem 0;
  }
  .metrics div {
    min-width: 0;
    padding: 0.65rem 0.8rem;
    border: 1px solid #2a3e4b;
    border-radius: 0.5rem;
    background: #0e1820;
  }
  dt,
  small {
    color: #afc1cf;
    font-size: 0.84rem;
  }
  dd {
    margin: 0.15rem 0;
    font-weight: 650;
    overflow-wrap: anywhere;
  }
  small {
    display: block;
    font-weight: 400;
  }
  .fleet-issues {
    padding: 0.65rem 0.8rem;
    border-left: 3px solid #e0ad68;
    border-radius: 0.3rem;
    background: #302621;
    color: #ffdcac;
  }
  ul {
    margin: 0.3rem 0 0;
    padding-left: 1.2rem;
  }
</style>
