<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { readPlexVaultBalance } from "../bridge/plexVault.ts";
  import { PLEX_WALLET_NOTICE } from "../bridge/plexWalletNotice.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { validShipSkinrName, type ShipSkinrEntry } from "../bridge/shipSkinr.ts";
  import { shipSkinrSequenceIdentifier, type ShipSkinrSequenceLicense, type ShipSkinrSequenceSlot } from "../bridge/shipSkinrSequencing.ts";
  import { formatDuration } from "../bridge/skills.ts";
  import type { JsonValue } from "../bridge/wire.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";

  let { flow, store, layout, tier, slots, initialName, initialLine, atCapacity, componentName, onBack, onBusy, onStarted }: {
    flow: AppFlow; store: ClientStore; layout: Record<string, JsonValue>; tier: number;
    slots: readonly ShipSkinrSequenceSlot[]; initialName: string; initialLine: string; atCapacity: boolean;
    componentName: (slot: ShipSkinrSequenceSlot) => string;
    onBack: () => void; onBusy: (busy: boolean) => void; onStarted: (job: ShipSkinrEntry) => void;
  } = $props();

  const words = $derived(store.words);
  const names = $derived(store.names);
  const inventory = $derived(store.inventory);
  const prefix = "UI/Personalization/ShipSkins/SKINR/Studio/";
  const labels = {
    finalize: ["FinalizeDesign", "Finalize Design"], create: ["CreateSKIN", "Create SKIN"],
    amount: ["SkinAmount", "SKIN amount"], costs: ["ConsumablesRequired", "Consumables required"],
    finite: ["LimitedDesignElement", "Limited-use design element"],
    infinite: ["UnlimitedDesignElement", "Unlimited-use design element"],
    name: ["SKINName", "SKIN Name"], line: ["SKINLineNameOptional", "SKIN Line Name (optional)"],
    time: ["SequencingTime", "Sequencing Time"], back: ["Back", "Back"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[prefix + labels[key][0]] ?? labels[key][1]);
  let name = $state("");
  let lineName = $state("");
  let quantity = $state<number | undefined>(1);
  let attempt = $state(0);
  let busy = $state(false);
  let error = $state("");
  let loadError = $state("");
  let terms = $state.raw<Awaited<ReturnType<AppFlow["loadShipSkinrStartTerms"]>> | null>(null);
  let balance = $state<bigint | null>(null);
  let licenses = $state.raw<ReadonlyMap<number, ShipSkinrSequenceLicense>>(new Map());
  let selections = $state.raw<ReadonlyMap<number, string>>(new Map());
  const uses = $derived.by(() => {
    const counts = new Map<number, { finite: number; infinite: number }>();
    const binders = new Map<number, number>();
    let missing = false;
    for (const slot of slots) {
      const license = licenses.get(slot.id);
      const choice = selections.get(slot.slot) ?? (license?.infinite ? "infinite" : "finite");
      const row = counts.get(slot.id) ?? { finite: 0, infinite: 0 };
      if (choice === "infinite") {
        row.infinite++;
        missing ||= !license?.infinite;
        binders.set(slot.binder, (binders.get(slot.binder) ?? 0) + slot.bindersPerUse * (quantity ?? 0));
      } else {
        row.finite += quantity ?? 0;
        missing ||= row.finite > (license?.finite ?? 0);
      }
      counts.set(slot.id, row);
    }
    return { counts, binders, missing };
  });
  const available = $derived.by(() => {
    const totals = new Map<number, number>();
    for (const row of $inventory.hangar.rows) {
      if (row.flagID === 4 || row.flagID === 5) totals.set(row.typeID, (totals.get(row.typeID) ?? 0) + row.quantity);
    }
    return totals;
  });
  const missingBinders = $derived([...uses.binders].some(([id, count]) => count > (available.get(id) ?? 0)));
  const total = $derived(terms ? terms.cents * (quantity ?? 0) : 0);
  const insufficient = $derived(balance !== null && Number(balance) < total);
  const ready = $derived(!busy && !loadError && terms && balance !== null && !atCapacity && !uses.missing && !missingBinders &&
    !insufficient && validShipSkinrName(name, lineName) && Number.isSafeInteger(quantity) && quantity! >= 1 && quantity! <= terms.maximum);

  $effect(() => { name = initialName; lineName = initialLine; });
  $effect(() => {
    let revision = 0;
    const notices = flow.gatewayNotices;
    let previous = notices.get();
    const stop = notices.subscribe(notice => {
      if (notice === previous) return;
      previous = notice;
      if (notice?.typeName !== PLEX_WALLET_NOTICE) return;
      const request = ++revision;
      void readPlexVaultBalance(flow.requestOptions()).then(current => {
        if (request === revision) balance = current;
      }).catch(() => {});
    });
    return () => { revision++; stop(); };
  });
  $effect(() => {
    void attempt;
    let current = true;
    const components = new Map(slots.map(slot => [slot.id, slot]));
    loadError = "";
    flow.requestWords(Object.values(labels).map(([key]) => prefix + key));
    flow.requestNames([...new Set(slots.map(slot => slot.binder))].filter(Boolean).map(id => ({ kind: "type", id })));
    void Promise.all([
      flow.loadShipSkinrStartTerms(tier), readPlexVaultBalance(flow.requestOptions()),
      Promise.all([...components.values()].map(async slot => [slot.id, await flow.loadShipSkinrComponentLicense(slot)] as const)),
      flow.loadInventory(),
    ]).then(([latest, wallet, owned]) => {
      if (!current) return;
      terms = latest;
      balance = wallet;
      licenses = new Map(owned);
    }, cause => { if (current) loadError = panelErrorWords(cause); });
    return () => { current = false; };
  });

  async function start(event: SubmitEvent) {
    event.preventDefault();
    if (!ready || quantity === undefined) return;
    const componentLicenses = [...new Map(slots.map(slot => [slot.id, slot])).values()].flatMap(slot => {
      const kind = uses.counts.get(slot.id)!;
      const component = shipSkinrSequenceIdentifier(slot);
      return [
        ...(kind.infinite ? [{ component, infinite: true }] : []),
        ...(kind.finite ? [{ component, finite: kind.finite }] : []),
      ];
    });
    busy = true;
    onBusy(true);
    error = "";
    try {
      const job = await flow.startShipSkinrJob({ name, lineName, layout }, quantity, componentLicenses);
      onStarted(job);
    } catch (cause) {
      const code = (cause as { statusCode?: number } | null)?.statusCode;
      const errors: Readonly<Record<number, string>> = {
        490: "All sequencing job slots are in use.", 491: "There are not enough design element licenses.",
        492: "There are not enough sequence binders.", 493: "Omega is required to sequence this hull.",
        494: "There is not enough PLEX.", 495: "This quantity exceeds your limit per sequencing job.",
      };
      error = errors[code ?? 0] ?? panelErrorWords(cause);
      attempt++;
    } finally {
      busy = false;
      onBusy(false);
    }
  }
</script>

<form class="ship-skinr-sequence" onsubmit={start}>
  <header><button type="button" disabled={busy} onclick={onBack}>{word("back")}</button><h3>{word("finalize")}</h3></header>
  {#if loadError}
    <p role="alert">{loadError}</p>
    <button type="button" onclick={() => attempt++}>Retry</button>
  {:else if !terms}
    <p role="status">Loading sequencing requirements…</p>
  {:else}
    <div class="fields">
      <label>{word("name")} <input bind:value={name} maxlength="20" required disabled={busy} /></label>
      <label>{word("line")} <input bind:value={lineName} maxlength="50" disabled={busy} /></label>
      <label>{word("amount")} <input type="number" min="1" max={terms.maximum} bind:value={quantity} required disabled={busy} /></label>
    </div>
    <h4>{word("costs")}</h4>
    <div class="consumables">
      {#each slots as slot (slot.slot)}
        {@const owned = licenses.get(slot.id)}
        <label>
          {componentName(slot)}
          <select aria-label={componentName(slot)} value={selections.get(slot.slot) ?? (owned?.infinite ? "infinite" : "finite")}
            disabled={busy || !owned?.infinite || !owned.finite}
            onchange={event => { selections = new Map(selections).set(slot.slot, event.currentTarget.value); }}>
            {#if owned?.infinite}<option value="infinite">{word("infinite")}</option>{/if}
            {#if owned?.finite || !owned?.infinite}<option value="finite">{word("finite")} · {owned?.finite ?? 0} available</option>{/if}
          </select>
        </label>
      {/each}
      {#each [...uses.binders] as [id, count] (id)}
        <p data-binder={id}>{resolvedName($names.resolved, "type", id, String(id))} · {count.toLocaleString()} required · {(available.get(id) ?? 0).toLocaleString()} available</p>
      {/each}
    </div>
    <p>{word("time")} · <span data-sequence-time>{formatDuration(terms.seconds * 1000)}</span></p>
    <p><strong data-sequence-cost>{(total / 100).toLocaleString()} PLEX</strong></p>
    {#if uses.missing}<p>There are not enough design element licenses.</p>{/if}
    {#if missingBinders}<p>There are not enough sequence binders.</p>{/if}
    {#if insufficient}<p>There is not enough PLEX.</p>{/if}
    {#if atCapacity}<p>All sequencing job slots are in use.</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <button type="submit" disabled={!ready}>{word("create")}</button>
  {/if}
</form>

<style>
  .ship-skinr-sequence, .fields, .consumables { display: grid; gap: 10px; }
  header { display: flex; gap: 12px; align-items: center; }
  h3, h4, p { margin: 0; }
  label { display: grid; gap: 4px; }
  .fields { grid-template-columns: repeat(auto-fit, minmax(min(170px, 100%), 1fr)); }
  .consumables { padding: 12px; background: #ffffff08; }
  button[type="submit"] { justify-self: start; }
</style>
