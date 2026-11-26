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
  import { canViewCorporateJournal } from "../bridge/walletJournal.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const wallet = store.wallet;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  const showCents = $derived(walletShowsCents($station.online?.characterID));
  const sharesAllowed = $derived(canViewCorporateShares($station.online?.corpRole));
  const journalAllowed = $derived(canViewCorporateJournal($station.online?.corpRole));
  let tab = $state<"divisions" | "shares" | "transactions">("divisions");
  const labels = {
    shares: "UI/Corporations/CorpUIHome/Shares",
    divisions: "UI/Wallet/WalletWindow/TabWalletDivisions",
    owned: "UI/Wallet/WalletWindow/TabOwnedByCorp",
    transactions: "UI/Wallet/WalletWindow/TabTransactions",
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
    void run(async () => {
      if (tab === "shares" && sharesAllowed) await flow.loadWalletShares(true);
      else {
        await flow.loadWallet({ fresh: true });
        if (tab === "transactions" && journalAllowed) await flow.loadCorpWalletJournal();
      }
    });
  }

  onMount(() => {
    void run(() => flow.loadWallet());
  });

  // The player-authored division name, or a plain "Division N" fallback — never
  // the raw account key / division flag (R7d).
  function divisionLabel(division: CorpWalletDivision): string {
    return division.name ?? `Division ${division.division}`;
  }
</script>

<section class="panel">
  <!-- ⚠ REFRESH LIVES IN THE STRIP, NOT AT THE BOTTOM OF THE PAGE. It used
       to be a bare <p><button> after the last section, so this window put its
       one action somewhere no other window puts one — below content of
       unpredictable length, which on a full read meant scrolling past
       everything to reach it. Nothing was added or taken away; the control
       moved to the band every other window keeps its controls in. -->
  <header class="panel-head">
    <h2 class="panel-title">Corp Wallet</h2>
    <span class="controls">
      <button type="button" disabled={busy} onclick={refresh}>Refresh</button>
    </span>
  </header>

  {#if error}
    <p class="error">Could not read the corp wallet: {error}</p>
  {/if}
  {#if $wallet.corpError}
    <p class="error">The corp wallet read failed: {$wallet.corpError}</p>
  {/if}

  <nav class="tabs" aria-label="Corporation wallet">
    {#if journalAllowed}
      <button type="button" class:active={tab === "transactions"} onclick={() => (tab = "transactions")}>{word(labels.transactions, "Transactions")}</button>
    {/if}
    {#if sharesAllowed}
      <button type="button" class:active={tab === "shares"} onclick={() => (tab = "shares")}>{word(labels.shares, "Shares")}</button>
    {/if}
    {#if journalAllowed}
      <button type="button" class:active={tab === "divisions"} onclick={() => (tab = "divisions")}>{word(labels.divisions, "Wallet Divisions")}</button>
    {/if}
  </nav>

  {#if !journalAllowed}
    <p class="empty">Your corporation roles do not allow viewing wallet records.</p>
  {:else if tab === "transactions"}
    <WalletJournal {store} {flow} corporate />
  {:else if tab === "shares" && sharesAllowed}
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
        </tr>
      </thead>
      <tbody>
        {#each $wallet.corpDivisions as division (division.key)}
          <tr>
            <th scope="row">{divisionLabel(division)}</th>
            <!-- corpDivisionsPanel.py 48: FmtWalletCurrency(division.balance), whole ISK with cents off. -->
            <td class="num">{showCents ? formatWalletCents(division.balance) : formatWholeIsk(division.balance, "truncate")}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

</section>
