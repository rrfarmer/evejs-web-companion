<script lang="ts">
  import { bridgeAsk } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { canUseCorporationWalletCurrency, EVERMARK_ISSUER } from "../bridge/corporationWalletCurrencies.ts";
  import { hasAccessToCorporationWallet } from "../bridge/corporationWealth.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { decodeLpBalances } from "../bridge/rewards.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { WalletLPBalance } from "../store/types.ts";
  import CorpWallet from "./CorpWallet.svelte";
  import WalletDonateEvermarks from "./WalletDonateEvermarks.svelte";
  import WalletDonateLp from "./WalletDonateLp.svelte";
  import WalletLoyalty from "./WalletLoyalty.svelte";

  let { store, flow, characterID }: { store: ClientStore; flow: AppFlow; characterID: number } = $props();
  const station = $derived(store.station);
  const words = $derived(store.words);
  const corporationID = $derived($station.online?.corporationID);
  const role = $derived($station.online?.corpRole);
  const iskAllowed = $derived(hasAccessToCorporationWallet(role));
  const lpAllowed = $derived(canUseCorporationWalletCurrency(role, "loyalty"));
  const emAllowed = $derived(canUseCorporationWalletCurrency(role, "evermarks"));
  const labels = {
    loyalty: "UI/Journal/JournalWindow/Agents/LoyaltyPoints",
    loyaltyCount: "UI/Wallet/WalletWindow/TabLPCorpNumber",
    evermarks: "UI/Wallet/WalletWindow/EvermarkAmount",
    overview: "UI/Wallet/WalletWindow/TabOverview",
    donate: "UI/Wallet/WalletWindow/TabDonate",
    alliance: "UI/Wallet/WalletWindow/TabDonateToAlliance",
  };
  function word(key: keyof typeof labels, fallback: string, args: Record<string, number> = {}) {
    const template = $words.templates[labels[key]];
    return (template && plainText(formatTemplate(template, args, { nameOf: () => "" }))) || fallback;
  }
  $effect(() => { flow.requestWords(Object.values(labels)); });

  type Currency = "isk" | "loyalty" | "evermarks";
  let chosen = $state<Currency>("isk");
  const currency = $derived(
    (chosen === "isk" && iskAllowed) || (chosen === "loyalty" && lpAllowed) || (chosen === "evermarks" && emAllowed)
      ? chosen : iskAllowed ? "isk" : lpAllowed ? "loyalty" : "evermarks"
  );
  let lpTab = $state<"overview" | "donate">("overview");
  let balances = $state.raw<readonly WalletLPBalance[] | null>(null);
  let balanceError = $state("");
  let revision = $state(0);
  function refresh() { revision++; }
  const balanceChanges = $derived(flow.corporationWalletLpChanged);
  const loyalty = $derived(balances?.filter(row => row.issuerCorpID !== EVERMARK_ISSUER) ?? null);
  const evermarks = $derived(balances === null ? null
    : Number(balances.find(row => row.issuerCorpID === EVERMARK_ISSUER)?.loyaltyPoints ?? "0"));

  $effect(() => {
    const scope = corporationID;
    void role;
    balances = null;
    balanceError = "";
    if (scope == null || (!lpAllowed && !emAllowed)) return;
    let active = true;
    let request = 0;
    const ask = bridgeAsk(flow.requestOptions());
    const load = () => {
      const latest = ++request;
      balanceError = "";
      void ask("LPSvc", "GetAllMyCorporationWalletLPBalances", []).then(answer => {
        if (active && latest === request) balances = decodeLpBalances(answer);
      }).catch(cause => {
        if (!active || latest !== request) return;
        balances = null;
        balanceError = panelErrorWords(cause);
      });
    };
    void revision;
    load();
    let previous = balanceChanges.get();
    const unsubscribe = balanceChanges.subscribe(value => {
      if (value === previous) return;
      previous = value;
      load();
    });
    return () => { active = false; unsubscribe(); };
  });
</script>

<div class="corp-wallet-currencies">
  <nav class="tabs" aria-label="Corporation wallet currency">
    <button type="button" disabled={!iskAllowed} aria-pressed={currency === "isk"} class:active={currency === "isk"}
      onclick={() => (chosen = "isk")}>ISK</button>
    <button type="button" disabled={!lpAllowed} aria-pressed={currency === "loyalty"} class:active={currency === "loyalty"}
      onclick={() => (chosen = "loyalty")}>{word("loyalty", "Loyalty Points")}
      {#if lpAllowed && loyalty !== null}<small>{word("loyaltyCount", `${loyalty.length} LP Corporations`, { numLPCorps: loyalty.length })}</small>{/if}
    </button>
    <button type="button" disabled={!emAllowed} aria-pressed={currency === "evermarks"} class:active={currency === "evermarks"}
      onclick={() => (chosen = "evermarks")}>
      {evermarks === null || !emAllowed ? "EverMarks" : word("evermarks", `${evermarks.toLocaleString("en-US")} EverMarks`, { everMarkAmount: evermarks })}
    </button>
  </nav>
  {#if currency === "isk" && iskAllowed}
    <CorpWallet {store} {flow} embedded />
  {:else if currency === "loyalty" && lpAllowed}
    <nav class="tabs" aria-label="Corporation loyalty points">
      <button type="button" class:active={lpTab === "overview"} aria-pressed={lpTab === "overview"}
        onclick={() => (lpTab = "overview")}>{word("overview", "Overview")}</button>
      <button type="button" class:active={lpTab === "donate"} aria-pressed={lpTab === "donate"}
        onclick={() => (lpTab = "donate")}>{word("donate", "Donate")}</button>
    </nav>
    {#if lpTab === "overview"}
      <WalletLoyalty {store} {flow} balances={loyalty} error={balanceError} {refresh} corporate />
    {:else if balanceError}
      <p role="alert">{balanceError}</p>
      <button type="button" onclick={refresh}>Refresh</button>
    {:else}
      <WalletDonateLp {store} {flow} {characterID} balances={loyalty} {refresh} corporate />
    {/if}
  {:else if currency === "evermarks" && emAllowed}
    <nav class="tabs" aria-label="Corporation EverMarks">
      <button type="button" class="active" aria-pressed="true">{word("alliance", "Donate to Alliance")}</button>
    </nav>
    {#if balanceError}
      <p role="alert">{balanceError}</p>
      <button type="button" onclick={refresh}>Refresh</button>
    {:else}
      <WalletDonateEvermarks {store} {flow} issuerID={EVERMARK_ISSUER} balance={evermarks} {refresh} corporate />
    {/if}
  {/if}
</div>

<style>
  .corp-wallet-currencies > .tabs { margin-top: 7px; }
  small { display: block; opacity: .8; }
</style>
