<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { MATCH_BY } from "../bridge/searchMatch.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import type { WalletLPBalance } from "../store/types.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import { setWalletSetting, walletSetting } from "./walletSettings.ts";

  let { store, flow, characterID, balances, refresh, corporate = false }: {
    store: ClientStore;
    flow: AppFlow;
    characterID: number;
    balances: readonly WalletLPBalance[] | null;
    refresh: () => void;
    corporate?: boolean;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const logos = $derived(flow.corpLogos);
  const logoLibrary = $derived(flow.corpLogoLibrary);
  const wallet = "UI/Wallet/WalletWindow/";
  const confirmation = wallet + "CorpLPTransactionConfirmation";
  const labels = {
    receiver: [wallet + "TransferTo", "Transfer To"],
    searchHint: [wallet + "SearchForCorpHint", "Search for a corporation"],
    searchBy: ["UI/Common/SearchBy", "Search By"],
    nothing: ["UI/Common/NothingFound", "Nothing found"],
    corporation: ["UI/Common/Corporation", "Corporation"],
    amount: [wallet + "GiveAmount", "Amount"],
    lp: [wallet + "LP", "LP"],
    transfer: ["UI/HangarTransfer/TransferBtn", "Transfer"],
    succeeded: [wallet + "TransferSuccessful", "Transfer Successful"],
  } as const;
  const searchModes = [
    [MATCH_BY.partialTerms, "PartialTerms", "Partial terms"],
    [MATCH_BY.exactTerms, "ExactTerms", "Exact terms"],
    [MATCH_BY.exactPhrase, "ExactPhrase", "Exact phrase"],
    [MATCH_BY.exactPhraseOnly, "OnlyExactPhrase", "Only the exact phrase"],
  ] as const;
  const modePath = "UI/Search/UniversalSearch/";
  $effect(() => {
    flow.requestWords([...Object.values(labels).map(([label]) => label), confirmation,
      ...searchModes.map(([, label]) => modePath + label)]);
  });
  const text = (path: string, fallback: string) => plainText($words.templates[path] ?? "") || fallback;
  const word = (key: keyof typeof labels) => text(labels[key][0], labels[key][1]);
  const issuerSetting = $derived(corporate ? "donateCorpLPIssuer" : "donateCorpLPIssuerPersonal");
  const name = (id: number) => resolvedName($names.resolved, "corporation", id, "");
  const issuers = $derived((balances ?? []).filter(row => Number(row.loyaltyPoints) > 0)
    .map(row => ({ id: row.issuerCorpID, balance: Number(row.loyaltyPoints), name: name(row.issuerCorpID) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id));
  $effect(() => {
    flow.requestNames(issuers.map(row => ({ kind: "corporation", id: row.id })));
  });

  type Recipient = { readonly id: number; readonly name: string };
  let chosen = $state<Recipient | null>(null);
  let found = $state.raw<readonly Recipient[] | null>(null);
  let search = $state("");
  let searchBy = $state(MATCH_BY.partialTerms as number);
  $effect(() => { searchBy = flow.ownersSearchBy(); });
  let searchError = $state("");
  let issuer = $state(0);
  let entered = $state<number | undefined>(0);
  let busy = $state(false);
  let success = $state(false);
  let transferError = $state("");
  const selected = $derived(issuers.find(row => row.id === issuer));
  const amount = $derived(entered ?? 0);
  const canTransfer = $derived(chosen !== null && selected !== undefined &&
    Number.isSafeInteger(amount) && amount > 0 && amount <= selected.balance);

  $effect(() => {
    if (balances === null || issuers.some(row => row.id === issuer)) return;
    const kept = walletSetting(characterID, issuerSetting);
    issuer = issuers.find(row => row.id === kept)?.id ?? issuers[0]?.id ?? 0;
    entered = 0;
  });
  function selectIssuer(id: number) {
    setWalletSetting(characterID, issuerSetting, id);
    entered = Math.min(amount, issuers.find(row => row.id === id)?.balance ?? 0);
    success = false;
    transferError = "";
  }
  function resetRecipient() {
    chosen = null;
    search = "";
    found = null;
  }
  $effect(() => {
    const query = search.replaceAll("*", "").trim();
    const mode = searchBy;
    found = null;
    searchError = "";
    if (query.length < 3 || chosen !== null) return;
    let current = true;
    const timer = setTimeout(() => {
      void flow.searchLpDonationRecipients(query, mode, () => current, corporate).then(rows => {
        if (current) found = rows;
      }).catch(cause => {
        if (current) searchError = panelErrorWords(cause);
      });
    }, 350);
    return () => { current = false; clearTimeout(timer); };
  });
  function choose(row: Recipient) {
    chosen = row;
    flow.requestCorpLogos([row.id]);
    success = false;
    transferError = "";
  }
  async function transfer() {
    if (busy || !canTransfer || !chosen || !selected) return;
    const receiver = chosen, source = selected, value = amount;
    busy = true;
    success = false;
    transferError = "";
    const formatted = value.toLocaleString("en-US");
    const template = $words.templates[confirmation];
    const fallback = `Transfer ${formatted} ${source.name} LP to ${receiver.name}?`;
    const question = template ? plainText(formatTemplate(template, {
      amount: formatted, issuerCorpName: source.name, corpName: receiver.name,
    }, { nameOf: () => "" })) : fallback;
    try {
      const donate = corporate ? flow.donateCorporationLp : flow.donatePersonalLp;
      if (await donate(receiver.id, source.id, value, question)) {
        success = true;
        resetRecipient();
        entered = 0;
        refresh();
      }
    } catch (cause) {
      transferError = panelErrorWords(cause);
      resetRecipient();
      refresh();
    } finally {
      busy = false;
    }
  }
</script>

<section class="wallet-donate-lp" aria-busy={busy}>
  <fieldset disabled={busy}>
    {#if chosen === null}
      <div class="controls">
        <label>{word("receiver")}
          <input maxlength="64" placeholder={word("searchHint")} bind:value={search} />
        </label>
        <label>{word("searchBy")}
          <select bind:value={searchBy} onchange={(event) => flow.keepOwnersSearchBy(Number(event.currentTarget.value))}>
            {#each searchModes as [value, label, fallback] (value)}
              <option {value}>{text(modePath + label, fallback)}</option>
            {/each}
          </select>
        </label>
      </div>
      {#if searchError}
        <p role="alert">{searchError}</p>
      {:else if found?.length === 0}
        <p class="nothing" role="status">{word("nothing")}</p>
      {:else if found}
        <ul>
          {#each found as row (row.id)}
            <li><button class="minor" type="button" onclick={() => choose(row)}>{row.name}</button></li>
          {/each}
        </ul>
      {/if}
    {:else}
      {@const logo = $logos[String(chosen.id)]}
      <div class="recipient">
        {#if logo && $logoLibrary}
          <span class="logo"><CorpLogo library={$logoLibrary} {logo} name="" /></span>
        {/if}
        <strong>{chosen.name}</strong>
        <button class="minor" type="button" aria-label="Change recipient" onclick={resetRecipient}>×</button>
      </div>
    {/if}
    <div class="controls">
      <label>{word("corporation")}
        <select bind:value={issuer} onchange={(event) => selectIssuer(Number(event.currentTarget.value))} disabled={!issuers.length}>
          {#each issuers as row (row.id)}
            <option value={row.id}>{row.name || word("corporation")}</option>
          {/each}
        </select>
      </label>
      <label>{word("amount")}
        <input type="number" min="0" step="1" max={selected?.balance ?? 0} placeholder={word("lp")}
          bind:value={entered} disabled={!selected} onblur={() => {
            if (entered !== undefined && selected) entered = Math.max(0, Math.min(Math.trunc(entered), selected.balance));
          }} />
      </label>
    </div>
    <div class="controls">
      <button type="button" disabled={!canTransfer} onclick={() => void transfer()}>{word("transfer")}</button>
      {#if success}<span class="success" role="status">{word("succeeded")}</span>{/if}
    </div>
    {#if transferError}<p role="alert">{transferError}</p>{/if}
  </fieldset>
</section>

<style>
  fieldset { display: grid; gap: 12px; max-width: 28rem; padding: 12px 0; border: 0; margin: 0; min-width: 0; }
  .controls { flex-wrap: wrap; align-items: end; gap: 8px; }
  label { display: grid; gap: 4px; }
  input[type="number"] { width: 10ch; }
  ul { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; max-height: 12rem; overflow: auto; }
  .recipient { display: flex; align-items: center; gap: 12px; }
  .logo { display: block; width: 40px; height: 40px; }
  .nothing { color: var(--color-warn); }
  .success { color: var(--color-good); }
</style>
