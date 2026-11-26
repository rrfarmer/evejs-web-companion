<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { CONCORD_LP_ISSUER, maximumConcordExchange } from "../bridge/concordLp.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";

  let { store, flow, stationID, issuerID, rate, source, target, close, exchanged }: {
    store: ClientStore;
    flow: AppFlow;
    stationID: number;
    issuerID: number;
    rate: number;
    source: number;
    target: number;
    close: () => void;
    exchanged: () => void;
  } = $props();
  const names = $derived(store.names);
  const words = $derived(store.words);
  const from = $derived(resolvedName($names.resolved, "corporation", CONCORD_LP_ISSUER, "CONCORD"));
  const to = $derived(resolvedName($names.resolved, "corporation", issuerID, "Corporation"));
  const labels = {
    title: ["UI/LPStore/LPExchangeDialogTitle", "Loyalty Point Exchange"],
    message: ["UI/LPStore/ConvertLPMsg", "Convert CONCORD Loyalty Points."],
    quantity: ["UI/LPStore/ExchangePurchaseAmount", "Purchase Amount"],
    current: ["UI/Common/Current", "Current"],
    total: ["UI/Common/Total", "Total"],
    cost: ["UI/Common/Cost", "Cost"],
    remaining: ["UI/Common/Remaining", "Remaining"],
    ok: ["UI/Common/Buttons/OK", "OK"],
    cancel: ["UI/Common/Buttons/Cancel", "Cancel"],
    units: ["UI/LPStore/AmountLP", "LP"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? "") || labels[key][1];
  const format = (key: keyof typeof labels, args: Record<string, string | number>, own: string) => {
    const template = $words.templates[labels[key][0]];
    return template ? plainText(formatTemplate(template, args, { nameOf: () => "" })) : own;
  };
  const units = (value: number) => {
    const lpAmount = value.toLocaleString("en-US");
    return format("units", { lpAmount }, `${lpAmount} LP`);
  };
  let dialog: HTMLDialogElement;
  let entered = $state<number | undefined>(1);
  let busy = $state(false);
  let error = $state("");
  const maximum = $derived(maximumConcordExchange(source, target, rate));
  const amount = $derived(Number.isSafeInteger(entered) ? Math.max(0, entered ?? 0) : 0);
  const cost = $derived(Math.ceil(amount / rate));
  onMount(() => {
    flow.requestWords(Object.values(labels).map(([label]) => label));
    flow.requestNames([{ kind: "corporation", id: CONCORD_LP_ISSUER }, { kind: "corporation", id: issuerID }]);
    dialog.showModal();
  });

  async function confirm() {
    if (busy || amount <= 0 || amount > maximum) return;
    busy = true;
    error = "";
    try {
      await flow.exchangeConcordLp(stationID, issuerID, amount);
      exchanged();
      close();
    } catch (cause) {
      error = panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }
</script>

<dialog class="concord-lp-exchange" bind:this={dialog} aria-label={word("title")}
  oncancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
  <h2>{word("title")}</h2>
  <p>{format("message", { toCorpName: to, exchangeRate: rate, fromCorpName: from }, `1 ${from} LP = ${rate} ${to} LP`)}</p>
  <form onsubmit={(event) => { event.preventDefault(); void confirm(); }}>
    <h3>{to}</h3>
    <label>{word("quantity")} <span><input type="number" min="0" max={maximum} step="1" bind:value={entered} disabled={busy} /> LP</span></label>
    <dl><dt>{word("current")}</dt><dd class="exchange-current">{units(target)}</dd>
      <dt>{word("total")}</dt><dd class="exchange-total">{units(target + amount)}</dd></dl>
    <h3>{from}</h3>
    <dl><dt>{word("cost")}</dt><dd class="exchange-cost">{units(cost)}</dd>
      <dt>{word("remaining")}</dt><dd class="exchange-remaining">{units(source - cost)}</dd></dl>
    {#if error}<p role="alert">{error}</p>{/if}
    <footer>
      <button type="submit" disabled={busy || !amount || amount > maximum}>{word("ok")}</button>
      <button type="button" disabled={busy} onclick={close}>{word("cancel")}</button>
    </footer>
  </form>
</dialog>

<style>
  dialog { width: min(320px, calc(100vw - 32px)); padding: 16px; color: var(--win-fg, #e5e9ec);
    background: var(--win-bg, #161b20); border: 1px solid #535d64; }
  dialog::backdrop { background: rgb(0 0 0 / .42); }
  h2, h3, p, dl, dd { margin: 0; }
  h2 { font-size: 16px; }
  h3, p { margin-block: 12px 6px; }
  label { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  input { width: 9ch; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; margin-top: 5px; }
  dd { text-align: right; }
  footer { display: flex; justify-content: end; gap: 6px; margin-top: 14px; }
</style>
