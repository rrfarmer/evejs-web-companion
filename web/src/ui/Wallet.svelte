<script lang="ts">
  // Wallet page (goal R50, extended R54): the character's personal ISK balance
  // (account.GetCashBalance) plus the personal LEDGER — the wallet's activity,
  // which the retail client reads as account.GetTransactions and lists as
  // "Transactions" — ref-types labelled from account.GetEntryTypes. (The client's
  // "Market Transactions" are another read, marketProxy.CharGetTransactions, and
  // are on the Market page here.) A
  // pure reader of the store; the read lives in app/flow.ts (loadWallet) and the
  // BFF holds the session. The Corp Wallet tab reads divisions from the SAME pull.
  //
  // ⚠ R7d: a ledger row shows only WHEN, WHAT (the human ref-type label) and the
  // ISK amount — never a raw refID/ownerID (those are dropped in the decoder) and
  // never the server's free-text description (it embeds typeIDs/systemIDs).
  // ⚠ empty vs failed. `journal` is null while unread OR when the
  // read FAILED (the reason is in the matching *Error); an empty list is the real
  // "no wallet activity yet" answer (worldHasNoContracts precedent).
  import { getContext, onMount } from "svelte";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { formatWalletCents, formatWholeIsk } from "./isk.ts";
  import { setWalletSetting, setWalletShowsCents, walletSetting, walletShowsCents } from "./walletSettings.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { readPlexVaultBalance } from "../bridge/plexVault.ts";
  import { decodePlexWalletNotice, PLEX_WALLET_NOTICE } from "../bridge/plexWalletNotice.ts";
  import WalletMarketTransactions from "./WalletMarketTransactions.svelte";
  import WalletJournal from "./WalletJournal.svelte";
  import WalletOverview from "./WalletOverview.svelte";
  import WalletGiveIsk from "./WalletGiveIsk.svelte";
  import WalletShares from "./WalletShares.svelte";

  let { store, flow, onBuyPlex, onShowOmegaOffers, onShowMultipleTraining, onOpenStore }: {
    store: ClientStore;
    flow: AppFlow;
    onBuyPlex?: () => void;
    onShowOmegaOffers?: () => void;
    onShowMultipleTraining?: () => void;
    onOpenStore?: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const wallet = store.wallet;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const characterID = $derived($station.online?.characterID ?? null);
  const showCents = $derived(walletShowsCents(characterID));
  const balance = $derived(showCents ? formatWalletCents($wallet.cashBalance) : formatWholeIsk($wallet.cashBalance, "truncate"));

  // The personal wallet's tabs (personalISKPanel.py GetMainTabs, 22 to 23), as far as the page has them: Overview
  // (WalletOverview), the first, which the window opens on; Transactions (WalletJournal); Market Transactions
  // (WalletMarketTransactions).
  const TAB_WORDS = {
    overview: "UI/Wallet/WalletWindow/TabOverview",
    transactions: "UI/Wallet/WalletWindow/TabTransactions",
    market: "UI/Wallet/WalletWindow/MarketTransactions",
    shares: "UI/Wallet/WalletWindow/TabShares",
    give: "UI/Wallet/WalletWindow/GiveMoney",
  } as const;
  $effect(() => {
    flow.requestWords(Object.values(TAB_WORDS));
  });
  function tabWord(label: string, own: string): string {
    const template = $words.templates[label];
    return typeof template === "string" && template !== "" ? plainText(template) : own;
  }
  let tab = $state<"overview" | "transactions" | "market" | "shares" | "give">("overview");
  /**
   * On the play page the window as WalletWindow lays it out (walletWnd.py: 900 x 600; its header's tabs My Wallet,
   * [Corporation Wallet,] Settings; personalWalletPanel.py: a WalletTabGroup 76 high - ISK and PLEX a third each,
   * Loyalty Points and EverMarks stacked in the last third (TOTOP_PROP) - each a BaseWalletTab: the icon 56 in a 64
   * column on black at 0.25, the name (EveHeaderMediumBold) and the info mark over a divider, the amount at 17 (PLEX's
   * #FAB400); the ISK panel 16 below: its TabGroup - Overview, Transactions, Market Transactions, Shares,
   * Give ISK).
   */
  const retail = getContext("retailChrome") === true;
  let walletTab = $state<"mine" | "settings">("mine");
  let currency = $state<"isk" | "plex">("isk");
  let plexBalance = $state<bigint | null>(null);
  let plexUnavailable = $state(false);
  const PLEX_DESCRIPTION = "UI/Wallet/WalletWindow/PLEXDescription";
  const PLEX_UNAVAILABLE = "UI/PlexVault/BalanceUnavailable";
  const PLEX_UNAVAILABLE_HINT = "UI/PlexVault/PlexTabUnavailable";
  const BUY_PLEX = "UI/Wallet/WalletWindow/BuyPlex";
  const BUY_PLEX_HINT = "UI/VirtualGoodsStore/Buttons/BuyPlex";
  const SELL_PLEX = "UI/PlexVault/SellPlexForIsk";
  const SELL_PLEX_HINT = "UI/PlexVault/SellPlexForIskDisabledTooltipDescription";
  const flight = $derived(store.flight);
  const canSellPlex = $derived((plexBalance ?? 0n) > 0n &&
    ($flight.status?.docked ?? Boolean($station.online?.stationID ?? $station.online?.structureID)));
  const PLEX_ACTIONS = $derived([
    { label: "UI/PlexVault/AddOmegaTime", fallback: "Add Omega game time", run: onShowOmegaOffers },
    { label: "UI/PlexVault/BuyMultipleTraining", fallback: "Buy extra skill queue", run: onShowMultipleTraining },
    { label: "UI/PlexVault/OpenNES", fallback: "Shop in the NES", run: onOpenStore },
    { label: "UI/PlexVault/BuyPlexForMoney", fallback: "Buy PLEX", run: onBuyPlex },
  ]);
  $effect(() => {
    if (!retail || characterID === null) return;
    const notices = flow.gatewayNotices;
    let previous = notices.get();
    let current = true;
    let revision = 0;
    currency = "isk";
    plexBalance = null;
    plexUnavailable = false;
    const unsubscribe = notices.subscribe(notice => {
      if (notice === previous) return;
      previous = notice;
      if (notice?.typeName !== PLEX_WALLET_NOTICE) return;
      const change = decodePlexWalletNotice(notice.payload);
      if (!change) return;
      revision++;
      plexBalance = BigInt(change.balance);
      plexUnavailable = false;
    });
    const changes = flow.plexVaultChanged;
    let lastChange = changes.get();
    function readBalance(initial: boolean) {
      const request = ++revision;
      void readPlexVaultBalance(flow.requestOptions()).then(cents => {
        if (!current || request !== revision) return;
        plexBalance = cents / 100n;
        plexUnavailable = false;
      }).catch(() => {
        if (!current || request !== revision || !initial) return;
        plexUnavailable = true;
        currency = "isk";
      });
    }
    const stopChanges = changes.subscribe(change => {
      if (change === lastChange) return;
      lastChange = change;
      readBalance(false);
    });
    readBalance(true);
    return () => { current = false; unsubscribe(); stopChanges(); };
  });
  const NOTIFY_ISK = "UI/Wallet/WalletWindow/NotifyAccountChange";
  const NOTIFY_SHARES = "UI/Wallet/WalletWindow/NotifyShareChange";
  const NOTIFY_BILLS = "UI/Wallet/WalletWindow/NotifyBillChange";
  const NOTIFY_PLEX = "UI/Wallet/WalletWindow/NotifyPlexBalanceChange";
  const SHOW_LP_UPDATES = "UI/Wallet/WalletWindow/Configuration/WalletShowLpUpdate";
  const CORP_WALLET = "UI/Wallet/WalletWindow/CorporationWallet";
  const SHOW_CENTS = "UI/Wallet/WalletWindow/WalletShowCents";
  const SHOW_BALANCE_UPDATES = "UI/Wallet/WalletWindow/Configuration/WalletShowBalanceChange";
  const BALANCE_THRESHOLD = "UI/Wallet/WalletWindow/Configuration/WalletBalanceChangeThreshold";
  const balanceUpdatesEnabled = $derived(walletSetting(characterID, "walletShowBalanceUpdates"));
  const balanceThreshold = $derived(walletSetting(characterID, "iskNotifyThreshold"));
  function editBalanceThreshold(input: HTMLInputElement): void {
    if (characterID === null || !/^-?\d*$/.test(input.value) || input.value === "-") return;
    const value = Math.min(Math.abs(Number(input.value)), 2_147_483_647);
    setWalletSetting(characterID, "iskNotifyThreshold", value);
  }
  const RETAIL_WORDS = ["UI/Wallet/WalletWindow/MyWallet", "UI/Common/Settings", "UI/Common/ISK", "UI/Common/PLEX",
    "UI/Journal/JournalWindow/Agents/LoyaltyPoints", "UI/Wallet/WalletWindow/EverMarks", "UI/Wallet/WalletWindow/ISKDescription",
    SHOW_CENTS, SHOW_BALANCE_UPDATES, SHOW_LP_UPDATES, BALANCE_THRESHOLD, NOTIFY_ISK, NOTIFY_SHARES, NOTIFY_BILLS, NOTIFY_PLEX, CORP_WALLET,
    PLEX_DESCRIPTION, PLEX_UNAVAILABLE, PLEX_UNAVAILABLE_HINT, BUY_PLEX, BUY_PLEX_HINT, SELL_PLEX, SELL_PLEX_HINT];
  $effect(() => { if (retail) flow.requestWords([...RETAIL_WORDS, ...PLEX_ACTIONS.map(action => action.label)]); });

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

  // The button asks the server again. The window opening takes what the wallet's services have kept
  // (bridge/walletReads.ts), which the server's own word keeps right, and asks only for what they have not.
  function refresh(): void {
    void run(() => flow.loadWallet({ fresh: true }));
  }

  onMount(() => {
    void run(() => flow.loadWallet());
  });

</script>

<section class="panel">
  <!-- ⚠ REFRESH LIVES IN THE STRIP, NOT AT THE BOTTOM OF THE PAGE. It used
       to be a bare <p><button> after the last section, so this window put its
       one action somewhere no other window puts one — below content of
       unpredictable length, which on a full read meant scrolling past
       everything to reach it. Nothing was added or taken away; the control
       moved to the band every other window keeps its controls in. -->
  {#if retail}
    <nav class="tabs wl-head-tabs">
      <button type="button" class:active={walletTab === "mine"} onclick={() => (walletTab = "mine")}>{tabWord("UI/Wallet/WalletWindow/MyWallet", "My Wallet")}</button>
      <button type="button" class:active={walletTab === "settings"} onclick={() => (walletTab = "settings")}>{tabWord("UI/Common/Settings", "Settings")}</button>
    </nav>
    {#if walletTab === "settings"}
      <div class="wallet-settings">
        <label class="wallet-personal-isk-blink">
          <input type="checkbox" checked={walletSetting(characterID, "notifyAccountChange")} disabled={characterID === null}
            onchange={(event) => { if (characterID !== null) setWalletSetting(characterID, "notifyAccountChange", event.currentTarget.checked); }} />
          {tabWord(NOTIFY_ISK, "Blink Wallet Button on ISK Balance Changes")}
        </label>
        <label class="wallet-personal-share-blink">
          <input type="checkbox" checked={walletSetting(characterID, "notifyShareChange")} disabled={characterID === null}
            onchange={(event) => { if (characterID !== null) setWalletSetting(characterID, "notifyShareChange", event.currentTarget.checked); }} />
          {tabWord(NOTIFY_SHARES, "Blink Wallet Button on Share Changes")}
        </label>
        <label class="wallet-cents">
          <input type="checkbox" checked={showCents} disabled={characterID === null}
            onchange={(event) => { if (characterID !== null) setWalletShowsCents(characterID, event.currentTarget.checked); }} />
          {tabWord(SHOW_CENTS, "Show ISK Cents on Amounts")}
        </label>
        <label class="wallet-balance-updates">
          <input type="checkbox" checked={balanceUpdatesEnabled} disabled={characterID === null}
            onchange={(event) => { if (characterID !== null) setWalletSetting(characterID, "walletShowBalanceUpdates", event.currentTarget.checked); }} />
          {tabWord(SHOW_BALANCE_UPDATES, "Live Balance Updates")}
        </label>
        <label class="wallet-lp-updates">
          <input type="checkbox" checked={walletSetting(characterID, "walletShowLpUpdates")} disabled={characterID === null}
            onchange={(event) => { if (characterID !== null) setWalletSetting(characterID, "walletShowLpUpdates", event.currentTarget.checked); }} />
          {tabWord(SHOW_LP_UPDATES, "Blink Wallet Button on Loyalty Point Changes")}
        </label>
        <label class="wallet-plex-blink">
          <input type="checkbox" checked={walletSetting(characterID, "notifyPlexBalanceChange")} disabled={characterID === null}
            onchange={(event) => { if (characterID !== null) setWalletSetting(characterID, "notifyPlexBalanceChange", event.currentTarget.checked); }} />
          {tabWord(NOTIFY_PLEX, "Blink Wallet Button on PLEX Balance Changes")}
        </label>
        <label class="wallet-balance-threshold">
          {tabWord(BALANCE_THRESHOLD, "Suppress if balance change under:")}
          <input type="text" inputmode="numeric" value={balanceThreshold} disabled={characterID === null}
            oninput={(event) => editBalanceThreshold(event.currentTarget)}
            onblur={(event) => { event.currentTarget.value = String(balanceThreshold); }} />
        </label>
        <h3>{tabWord(CORP_WALLET, "Corporation Wallet")}</h3>
        <label class="wallet-corporation-isk-blink">
          <input type="checkbox" checked={walletSetting(characterID, "notifyAccountChangeCorp")} disabled={characterID === null}
            onchange={(event) => { if (characterID !== null) setWalletSetting(characterID, "notifyAccountChangeCorp", event.currentTarget.checked); }} />
          {tabWord(NOTIFY_ISK, "Blink Wallet Button on ISK Balance Changes")}
        </label>
        <label class="wallet-corporation-bill-blink">
          <input type="checkbox" checked={walletSetting(characterID, "notifyBillChange")} disabled={characterID === null}
            onchange={(event) => { if (characterID !== null) setWalletSetting(characterID, "notifyBillChange", event.currentTarget.checked); }} />
          {tabWord(NOTIFY_BILLS, "Blink Wallet Button on Bill Changes")}
        </label>
        <label class="wallet-corporation-share-blink">
          <input type="checkbox" checked={walletSetting(characterID, "notifyShareChangeCorp")} disabled={characterID === null}
            onchange={(event) => { if (characterID !== null) setWalletSetting(characterID, "notifyShareChangeCorp", event.currentTarget.checked); }} />
          {tabWord(NOTIFY_SHARES, "Blink Wallet Button on Share Changes")}
        </label>
      </div>
    {/if}
    <div class="wl-tabs" hidden={walletTab !== "mine"}>
      <button type="button" class="wl-tab currency-tab" class:sel={currency === "isk"} aria-pressed={currency === "isk"} onclick={() => (currency = "isk")}>
        <span class="ic"><img alt="" src="/client-res/ui/texture/windowicons/wallet.png" /></span>
        <span class="data"><span class="top"><b>{tabWord("UI/Common/ISK", "ISK")}</b><span class="info" title={tabWord("UI/Wallet/WalletWindow/ISKDescription", "")}>i</span></span>
          <span class="amount">{$wallet.loaded ? balance : ""}</span></span>
      </button>
      <div class="wl-tab plex-tab" class:sel={currency === "plex"}>
        <button type="button" class="currency-tab plex-select" aria-pressed={currency === "plex"} disabled={plexBalance === null}
          title={plexUnavailable ? tabWord(PLEX_UNAVAILABLE_HINT, "PLEX wallet currently unavailable. Please try again later.") : tabWord(PLEX_DESCRIPTION, "")}
          onclick={() => (currency = "plex")}>
          <span class="ic"><img alt="" src="/client-res/ui/texture/plex/plex_128_gradient_yellow.png" /></span>
          <span class="data"><span class="top"><b>{tabWord("UI/Common/PLEX", "PLEX")}</b><span class="info">i</span></span>
            <span class="amount plex" aria-live="polite">{plexUnavailable ? tabWord(PLEX_UNAVAILABLE, "Unavailable") : (plexBalance?.toLocaleString("en-US") ?? "…")}</span>
          </span>
        </button>
        {#if onBuyPlex}
          <button type="button" class="plex-plus" aria-label={tabWord(BUY_PLEX_HINT, "Buy PLEX")}
            title={tabWord(BUY_PLEX_HINT, "Buy PLEX")} onclick={onBuyPlex}>{tabWord(BUY_PLEX, "+")}</button>
        {/if}
      </div>
      <div class="wl-stack">
        <div class="wl-tab small"><span class="ic"><img alt="" src="/client-res/ui/texture/windowicons/lpstore_24px.png" /></span>
          <span class="data"><b>{tabWord("UI/Journal/JournalWindow/Agents/LoyaltyPoints", "Loyalty Points")}</b><span class="amount">-</span></span></div>
        <div class="wl-tab small"><span class="ic"><img alt="" src="/client-res/ui/texture/windowicons/evermark_24px.png" /></span>
          <span class="data"><b>{tabWord("UI/Wallet/WalletWindow/EverMarks", "EverMarks")}</b><span class="amount">-</span></span></div>
      </div>
    </div>
  {/if}
  {#if retail && walletTab === "mine" && currency === "plex"}
    <div class="wallet-plex">
      <nav class="tabs" aria-label={tabWord("UI/Common/PLEX", "PLEX")}>
        <button type="button" class="active" aria-pressed="true">{tabWord(TAB_WORDS.overview, "Overview")}</button>
      </nav>
      {#if error}<p role="status">{error}</p>{/if}
      <div class="plex-actions">
        <span title={plexBalance === 0n ? tabWord(SELL_PLEX_HINT, "PLEX Vault is empty") : null}>
          <button type="button" disabled={!canSellPlex || busy} onclick={() => void run(() => flow.openVaultPlexSale())}>
            {tabWord(SELL_PLEX, "Sell PLEX for ISK")}
          </button>
        </span>
        {#each PLEX_ACTIONS as action (action.label)}
          {#if action.run}<button type="button" onclick={action.run}>{tabWord(action.label, action.fallback)}</button>{/if}
        {/each}
      </div>
    </div>
  {/if}
  <div class="wl-mine" hidden={retail && (walletTab !== "mine" || currency !== "isk")}>
  <header class="panel-head">
    <h2 class="panel-title">Wallet</h2>
    <span class="controls">
      <button type="button" disabled={busy} onclick={refresh}>Refresh</button>
    </span>
  </header>

  {#if error}
    <p class="error">Could not read the wallet: {error}</p>
  {/if}
  {#if $wallet.cashError}
    <p class="error">The balance read failed: {$wallet.cashError}</p>
  {/if}

  {#if !$wallet.loaded}
    <p class="empty">Reading your balance…</p>
  {:else}
    <table class="guests">
      <tbody>
        <tr>
          <th scope="row">Balance</th>
          <td class="num">{balance}</td>
        </tr>
      </tbody>
    </table>
  {/if}

  <nav class="tabs">
    <button type="button" class:active={tab === "overview"} onclick={() => (tab = "overview")}>{tabWord(TAB_WORDS.overview, "Overview")}</button>
    <button type="button" class:active={tab === "transactions"} onclick={() => (tab = "transactions")}>{tabWord(TAB_WORDS.transactions, "Transactions")}</button>
    <button type="button" class:active={tab === "market"} onclick={() => (tab = "market")}>{tabWord(TAB_WORDS.market, "Market Transactions")}</button>
    <button type="button" class:active={tab === "shares"} onclick={() => (tab = "shares")}>{tabWord(TAB_WORDS.shares, "Shares")}</button>
    <button type="button" class:active={tab === "give"} onclick={() => (tab = "give")}>{tabWord(TAB_WORDS.give, "Give ISK")}</button>
  </nav>

  {#if tab === "overview"}
    <WalletOverview {store} {flow} />
  {:else if tab === "market"}
    <WalletMarketTransactions {store} {flow} />
  {:else if tab === "shares"}
    <WalletShares {store} {flow} />
  {:else if tab === "give"}
    <WalletGiveIsk {store} {flow} />
  {:else}
    <WalletJournal {store} {flow} />
  {/if}

</div>
</section>

<style>
  .currency-tab { padding: 0; color: inherit; text-align: left; }
  .plex-tab { position: relative; min-width: 0; }
  .plex-select { display: flex; flex: 1; min-width: 0; background: transparent; border: 0; }
  .plex-plus { position: absolute; bottom: 7px; right: 6px; min-width: 20px; height: 20px; padding: 0 3px; }
  .plex-select .amount { padding-right: 30px; font-size: clamp(12px, 2vw, 17px); overflow: hidden; text-overflow: ellipsis; }
  .plex-actions { display: grid; gap: 6px; max-width: 320px; padding-top: 12px; }
  .plex-actions button { min-height: 44px; text-align: left; }
  .plex-actions span > button { width: 100%; }
  .wallet-settings { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .wallet-settings label { display: flex; align-items: center; gap: 8px; }
  .wallet-settings h3 { margin: 12px 0 0; }
  .wallet-balance-threshold input { width: 9em; }
</style>

