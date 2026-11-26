<script lang="ts">
  // Corp Wallet page (goal R50): the corporation's per-division balances
  // (account.GetWalletDivisionsInfo — R50's one new allowlist pair), the read
  // the retail corp-wallet window itself issues. A pure reader of the store; the
  // read shares the loadWallet pull with the personal Wallet tab, and the BFF
  // holds the session + resolves the division names.
  //
  // ⚠ empty vs failed. `corpDivisions === null` means the corp read failed (the
  // reason is in `corpError`) OR has not answered yet; an empty list is the real
  // "this corporation has no wallet divisions" answer. The two are shown
  // differently on purpose (the worldHasNoContracts precedent).
  import { onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { formatWalletCents, formatWholeIsk } from "./isk.ts";
  import { walletShowsCents } from "./walletSettings.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { CorpWalletDivision } from "../store/types.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { canViewCorporateShares } from "../bridge/walletShares.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import WalletShares from "./WalletShares.svelte";
  import WalletJournal from "./WalletJournal.svelte";
  import WalletMarketTransactions from "./WalletMarketTransactions.svelte";
  import { canViewCorporateJournal } from "../bridge/walletJournal.ts";
  import { canViewCorporateMarketTransactions } from "../bridge/marketTransactions.ts";
  import { canReceiveCorporationWealth, corporationWalletTakeKeys } from "../bridge/corporationWealth.ts";

  let { store, flow, embedded = false }: { store: ClientStore; flow: AppFlow; embedded?: boolean } = $props();

  // svelte-ignore state_referenced_locally
  const wallet = store.wallet;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const showCents = $derived(walletShowsCents($station.online?.characterID));
  const sharesAllowed = $derived(canViewCorporateShares($station.online?.corpRole));
  const journalAllowed = $derived(canViewCorporateJournal($station.online?.corpRole));
  const marketAllowed = $derived(canViewCorporateMarketTransactions($station.online?.corpRole) &&
    (journalAllowed || corporationWalletTakeKeys($station.online?.corpRole).length > 0));
  let tab = $state<"divisions" | "shares" | "transactions" | "market">("divisions");
  let marketDivision = $state<number>();
  let marketRevision = $state(0);
  let divisionMenu = $state<number | null>(null);
  const selectedTab = $derived(tab === "market" && marketAllowed ? tab
    : !journalAllowed && marketAllowed ? "market"
    : tab === "market" ? "divisions" : tab);
  const activeKey = $derived($station.online?.corpAccountKey ?? null);
  const divisionReadable = $derived(activeKey !== null && canReceiveCorporationWealth($station.online?.corpRole, activeKey));
  let divisionBalance = $state<number | null>(null);
  let divisionError = $state("");
  let divisionRefresh = $state(0);
  const labels = {
    shares: "UI/Corporations/CorpUIHome/Shares",
    divisions: "UI/Wallet/WalletWindow/TabWalletDivisions",
    owned: "UI/Wallet/WalletWindow/TabOwnedByCorp",
    transactions: "UI/Wallet/WalletWindow/TabTransactions",
    market: "UI/Wallet/WalletWindow/MarketTransactions",
    marketMenu: "UI/Wallet/WalletWindow/MenuViewMarketTransactions",
  };
  $effect(() => { flow.requestWords(Object.values(labels)); });
  function word(label: string, fallback: string): string {
    const value = $words.templates[label];
    return typeof value === "string" && value !== "" ? plainText(value) : fallback;
  }

  let busy = $state(false);
  let error = $state("");

  async function run(action: () => Promise<void> | void): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      if (isSessionLost(cause)) {
        return;
      }
      error =
        panelErrorWords(cause);
    } finally {
      busy = false;
    }
  }

  // The button asks the server again; the window opening takes what is kept (bridge/walletReads.ts).
  function refresh(): void {
    if (selectedTab === "market") {
      marketRevision++;
      return;
    }
    if (embedded && !journalAllowed) {
      divisionRefresh++;
      return;
    }
    void run(async () => {
      if (tab === "shares" && sharesAllowed) await flow.loadWalletShares(true);
      else {
        await flow.loadWallet({ fresh: true });
        if (tab === "transactions" && journalAllowed) await flow.loadCorpWalletJournal();
      }
    });
  }

  onMount(() => {
    if (embedded) tab = "transactions";
    else void run(() => flow.loadWallet());
  });
  $effect(() => {
    void divisionRefresh;
    if (!embedded || journalAllowed || !divisionReadable || activeKey === null) return;
    let current = true;
    divisionBalance = null;
    divisionError = "";
    void flow.corporationWealth(activeKey).then(balance => { if (current) divisionBalance = balance; })
      .catch(cause => { if (current) divisionError = panelErrorWords(cause); });
    return () => { current = false; };
  });

  // The player-authored division name, or a plain "Division N" fallback — never
  // the raw account key / division flag (R7d).
  function divisionLabel(division: CorpWalletDivision): string {
    return division.name ?? `Division ${division.division}`;
  }
  function openMarket(division?: number) {
    marketDivision = division;
    divisionMenu = null;
    tab = "market";
  }
</script>

<section class="panel corp-wallet-panel">
  <!-- ⚠ REFRESH LIVES IN THE STRIP, NOT AT THE BOTTOM OF THE PAGE. It used
       to be a bare <p><button> after the last section, so this window put its
       one action somewhere no other window puts one — below content of
       unpredictable length, which on a full read meant scrolling past
       everything to reach it. Nothing was added or taken away; the control
       moved to the band every other window keeps its controls in. -->
  <header class="panel-head">
    {#if !embedded}<h2 class="panel-title">Corp Wallet</h2>{/if}
    <span class="controls">
      <button type="button" disabled={busy} onclick={refresh}>Refresh</button>
    </span>
  </header>

  {#if error}
    <p class="error">Could not read the corp wallet: {error}</p>
  {/if}
  {#if journalAllowed && $wallet.corpError}
    <p class="error">The corp wallet read failed: {$wallet.corpError}</p>
  {/if}

  {#if journalAllowed || sharesAllowed || marketAllowed}
  <nav class="tabs" aria-label="Corporation wallet">
    {#if journalAllowed}
      <button type="button" class:active={selectedTab === "transactions"} aria-pressed={selectedTab === "transactions"}
        onclick={() => (tab = "transactions")}>{word(labels.transactions, "Transactions")}</button>
    {/if}
    {#if marketAllowed}
      <button type="button" class:active={selectedTab === "market"} aria-pressed={selectedTab === "market"}
        onclick={() => openMarket()}>{word(labels.market, "Market Transactions")}</button>
    {/if}
    {#if sharesAllowed}
      <button type="button" class:active={selectedTab === "shares"} aria-pressed={selectedTab === "shares"}
        onclick={() => (tab = "shares")}>{word(labels.shares, "Shares")}</button>
    {/if}
    {#if journalAllowed}
      <button type="button" class:active={selectedTab === "divisions"} aria-pressed={selectedTab === "divisions"}
        onclick={() => (tab = "divisions")}>{word(labels.divisions, "Divisions")}</button>
    {/if}
  </nav>
  {/if}

  {#if selectedTab === "market" && marketAllowed}
    {#key marketRevision}
      <WalletMarketTransactions {store} {flow} corporate initialDivision={marketDivision} />
    {/key}
  {:else if !journalAllowed && embedded && divisionReadable}
    {#if divisionError}<p role="alert">{divisionError}</p>
    {:else if divisionBalance === null}<p role="status">Reading the active division…</p>
    {:else}<p class="corp-division-balance">{showCents ? formatWalletCents(String(divisionBalance)) : formatWholeIsk(String(divisionBalance), "truncate")}</p>{/if}
  {:else if !journalAllowed}
    <p class="empty">Your corporation roles do not allow viewing wallet records.</p>
  {:else if selectedTab === "transactions"}
    <WalletJournal {store} {flow} corporate />
  {:else if selectedTab === "shares" && sharesAllowed}
    <h3>{word(labels.owned, "Owned by corporation")}</h3>
    <WalletShares {store} {flow} corporate />
  {:else if !$wallet.loaded || ($wallet.corpDivisions === null && $wallet.corpError === null)}
    <p class="empty">Reading your corporation's wallet…</p>
  {:else if $wallet.corpDivisions === null}
    <!-- Failed read: the reason is shown above; do not imply an empty wallet. -->
  {:else if $wallet.corpDivisions.length === 0}
    <p class="empty">This corporation has no wallet divisions.</p>
  {:else}
    <table class="guests">
      <thead>
        <tr>
          <th scope="col">Division</th>
          <th scope="col" class="num">Balance</th>
          {#if marketAllowed}<th scope="col"></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each $wallet.corpDivisions as division (division.key)}
          <tr oncontextmenu={event => { if (marketAllowed) { event.preventDefault(); divisionMenu = division.key; } }}>
            <th scope="row">{divisionLabel(division)}</th>
            <!-- corpDivisionsPanel.py 48: FmtWalletCurrency(division.balance), whole ISK with cents off. -->
            <td class="num">{showCents ? formatWalletCents(division.balance) : formatWholeIsk(division.balance, "truncate")}</td>
            {#if marketAllowed}
              <td>
                <button type="button" class="minor" aria-label={divisionLabel(division) + " actions"} aria-expanded={divisionMenu === division.key}
                  onclick={() => (divisionMenu = divisionMenu === division.key ? null : division.key)}>⋯</button>
                {#if divisionMenu === division.key}
                  <button type="button" class="minor" onclick={() => openMarket(division.key)}>{word(labels.marketMenu, "View Market Transactions")}</button>
                {/if}
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

</section>
