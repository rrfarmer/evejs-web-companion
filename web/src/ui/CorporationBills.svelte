<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { billTypeNameIDs, canPayCorporationBills, type CorporationBill, type CorporationBillsView } from "../bridge/corporationBills.ts";
  import { canReceiveCorporationWealth } from "../bridge/corporationWealth.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import { formatWalletCents, formatWholeIsk } from "./isk.ts";
  import { walletShowsCents } from "./walletSettings.ts";
  import CorporationBillSettings from "./CorporationBillSettings.svelte";

  let { store, flow, refresh }: { store: ClientStore; flow: AppFlow; refresh: number } = $props();
  const station = $derived(store.station);
  const words = $derived(store.words);
  const names = $derived(store.names);
  const changes = $derived(flow.corporationBillsChanged);
  const prefix = "UI/Wallet/WalletWindow/";
  const labels = {
    payable: [prefix + "TabPayable", "Payable"],
    receivable: [prefix + "TabReceivable", "Receivable"],
    automatic: [prefix + "TabAutomaticallyPaid", "Automatically Paid"],
    settings: [prefix + "TabAutomaticPaySettings", "Automatic Pay Settings"],
    pay: [prefix + "PayBill", "Pay Bill"],
    menuPay: [prefix + "MenuPayBill", "Pay Bill"],
    menuPayAll: [prefix + "MenuPayBills", "Pay Bills"],
    type: [prefix + "ColHeaderBillType", "Bill Type"],
    amount: [prefix + "ColHeaderAmount", "Amount"],
    date: ["UI/Common/Date", "Date"],
    debtor: [prefix + "ColHeaderOwedBy", "Owed By"],
    creditor: [prefix + "ColHeaderCreditor", "Creditor"],
    interest: [prefix + "ColHeaderInterest", "Interest"],
    item: [prefix + "ColHeaderItemOrderID", "Item/Order ID"],
    empty: [prefix + "HintNoTransactionsFound", "No transactions found"],
    dateFormat: [prefix + "FmtWalletDate", ""],
    rateFormat: [prefix + "FmtInterest", ""],
    rental: [prefix + "RentalOffice", ""],
    office: [prefix + "Office", "Office"],
    elsewhere: [prefix + "SomeStation", "Some station"],
    unknown: ["UI/Generic/Unknown", "Unknown"],
  } as const;
  const tabs = ["payable", "receivable", "automatic", "settings"] as const;
  const columns = ["type", "amount", "date", "debtor", "creditor", "interest", "item"] as const;
  type Column = typeof columns[number];
  let tab = $state<CorporationBillsView | "settings">("payable");
  let rows = $state.raw<readonly CorporationBill[] | null>(null);
  let error = $state("");
  let revision = $state(0);
  let sortBy = $state<Column>("date");
  let descending = $state(false);
  let checked = $state.raw<ReadonlySet<number>>(new Set());
  let menu = $state<number | null>(null);
  let paying = $state(false);
  let paymentError = $state("");
  const active = $derived($station.online);
  const mayPay = $derived(canPayCorporationBills(active?.corpRole) && active?.corpAccountKey != null &&
    canReceiveCorporationWealth(active.corpRole, active.corpAccountKey));
  function canPay(row: CorporationBill): boolean {
    return mayPay && !row.paid && (row.debtorID === active?.corporationID || row.debtorID === active?.allianceID);
  }
  const selected = $derived((rows ?? []).filter(row => checked.has(row.id) && canPay(row)));
  function choose(id: number, selected: boolean) {
    const next = new Set(checked);
    if (selected) next.add(id);
    else next.delete(id);
    checked = next;
  }
  async function pay() {
    if (!selected.length || paying) return;
    paymentError = "";
    paying = true;
    try { await flow.payCorporationBills(selected); }
    catch (cause) { paymentError = panelErrorWords(cause); }
    finally { paying = false; }
  }
  const showCents = $derived(walletShowsCents($station.online?.characterID));
  $effect(() => {
    flow.requestWords([...Object.values(labels).map(([path]) => path), ...Object.values(billTypeNameIDs).map(id => `#${id}`)]);
  });
  function word(key: keyof typeof labels, args: Record<string, string | number> = {}): string {
    const [path, fallback] = labels[key];
    const template = $words.templates[path];
    return (template && plainText(formatTemplate(template, args, { nameOf: () => "" }))) || fallback;
  }
  const owner = (id: number) => resolvedName($names.resolved, "owner", id, "");
  const location = (id: number) => resolvedName($names.resolved, "station", id, "");
  const typeName = (id: number) => resolvedName($names.resolved, "type", id, "");
  function billType(id: number): string {
    const type = billTypeNameIDs[id];
    return (type && plainText($words.templates[`#${type}`] ?? "")) || word("unknown");
  }
  function item(row: CorporationBill): string {
    if ([4, 5].includes(row.typeID)) return row.externalID > 0 ? owner(row.externalID) : "";
    const at = row.locationID > 0 ? location(row.locationID) : word("elsewhere");
    if (row.typeID === 2) {
      const kind = row.externalID === 26 ? word("office") : typeName(row.externalID) || word("office");
      return word("rental", { whatOffice: kind, location: at }) || [kind, at].filter(Boolean).join(" · ");
    }
    if (row.typeID === 1) return [typeName(row.externalID), at].filter(Boolean).join(" · ");
    if (row.typeID === 3) return [row.externalID > 0 ? row.externalID : word("unknown"), at].filter(Boolean).join(" · ");
    return row.externalID > 0 ? String(row.externalID) : "";
  }
  function sortValue(row: CorporationBill, column: Column): string | number | bigint {
    switch (column) {
      case "type": return billType(row.typeID);
      case "amount": return row.amount;
      case "date": return row.due;
      case "debtor": return owner(row.debtorID);
      case "creditor": return owner(row.creditorID);
      case "interest": return row.interest;
      case "item": return item(row);
    }
  }
  const sorted = $derived([...(rows ?? [])].sort((a, b) => {
    const x = sortValue(a, sortBy), y = sortValue(b, sortBy);
    return (x < y ? -1 : x > y ? 1 : 0) * (descending ? -1 : 1) || a.id - b.id;
  }));
  function sortOn(key: Column) {
    descending = sortBy === key && !descending;
    sortBy = key;
  }
  $effect(() => {
    void revision; void refresh; void $changes; void $station.online?.allianceID;
    let current = true;
    const view = tab;
    if (view === "settings") return;
    checked = new Set();
    menu = null;
    rows = null;
    error = "";
    void flow.corporationBills(view).then(bills => {
      if (!current) return;
      rows = bills;
      const refs: NameRef[] = [];
      for (const row of bills) {
        for (const id of [row.debtorID, row.creditorID]) if (id > 0) refs.push({kind: "owner", id});
        if (row.locationID > 0 && [1, 2, 3].includes(row.typeID)) refs.push({kind: "station", id: row.locationID});
        if (row.externalID > 0 && [1, 2].includes(row.typeID)) refs.push({kind: "type", id: row.externalID});
        if (row.externalID > 0 && [4, 5].includes(row.typeID)) refs.push({kind: "owner", id: row.externalID});
      }
      if (refs.length) flow.requestNames(refs);
    }).catch(cause => { if (current) error = panelErrorWords(cause); });
    return () => { current = false; };
  });
</script>

<section class="corporation-bills">
  <nav class="tabs" aria-label="Bills">
    {#each tabs as view (view)}
      <button type="button" aria-pressed={tab === view} class:active={tab === view} onclick={() => { paymentError = ""; tab = view; }}>{word(view)}</button>
    {/each}
  </nav>
  {#if paymentError}<p role="alert">{paymentError}</p>{/if}
  {#if tab === "settings"}
    <CorporationBillSettings {store} {flow} {refresh} applied={() => revision++} />
  {:else if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => revision++}>Refresh</button>
  {:else if rows === null}
    <p role="status">Reading bills…</p>
  {:else if rows.length === 0}
    <p class="empty">{word("empty")}</p>
  {:else}
    {#if mayPay && rows.some(canPay)}
      <div class="controls"><button type="button" disabled={paying || !selected.length} onclick={() => void pay()}>{word("pay")}</button></div>
    {/if}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead><tr>
          {#each columns as column (column)}
            <th scope="col" aria-sort={sortBy === column ? (descending ? "descending" : "ascending") : "none"}>
              <button class="bill-sort" type="button" onclick={() => sortOn(column)}>{word(column)}</button>
            </th>
          {/each}
        </tr></thead>
        <tbody>
          {#each sorted as row (row.id)}
            <tr data-bill-id={row.id} oncontextmenu={event => {
              if (canPay(row)) { event.preventDefault(); choose(row.id, true); menu = row.id; }
            }}>
              <td data-label={word("type")}>
                {#if canPay(row)}<input type="checkbox" aria-label={billType(row.typeID) + " " + row.id} disabled={paying}
                  checked={checked.has(row.id)} onchange={event => choose(row.id, event.currentTarget.checked)} />{/if}
                {billType(row.typeID)}
                {#if menu === row.id && selected.length > 0}
                  <button type="button" class="minor" disabled={paying} onclick={() => void pay()}>
                    {selected.length === 1 ? word("menuPay") : word("menuPayAll", {numBills: selected.length})}
                  </button>
                {/if}
              </td>
              <td data-label={word("amount")}>{showCents ? formatWalletCents(row.amount) : formatWholeIsk(String(row.amount), "truncate")}</td>
              <td data-label={word("date")}>{row.due > 0n ? word("dateFormat", {dt: String(row.due)}) : ""}</td>
              <td data-label={word("debtor")}>{owner(row.debtorID)}</td>
              <td data-label={word("creditor")}>{owner(row.creditorID)}</td>
              <td data-label={word("interest")}>{word("rateFormat", {interest: row.interest}) || row.interest}</td>
              <td data-label={word("item")}>{item(row)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .corporation-bills { display: grid; gap: 0.5rem; }
  .bill-sort { color: inherit; font: inherit; border: none; padding: 0; background: transparent; cursor: pointer; }
</style>
