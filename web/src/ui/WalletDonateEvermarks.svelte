<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import CorpLogo from "./CorpLogo.svelte";

  let { store, flow, issuerID, balance, refresh, corporate = false }: {
    store: ClientStore;
    flow: AppFlow;
    issuerID: number;
    balance: number | null;
    refresh: () => void;
    corporate?: boolean;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const logos = $derived(flow.corpLogos);
  const logoLibrary = $derived(flow.corpLogoLibrary);
  const wallet = "UI/Wallet/WalletWindow/";
  const labels = {
    recipient: [wallet + "TransferTo", "Transfer To"],
    choose: [wallet + "EMDonationSelectCorp", "Select Corporation"],
    amount: [wallet + "GiveAmount", "Amount"],
    em: [wallet + "EM", "EM"],
    transfer: ["UI/HangarTransfer/TransferBtn", "Transfer"],
    success: [wallet + "TransferSuccessful", "Transfer Successful"],
    restrictedTitle: [wallet + "AccessRestricted", "Access Restricted"],
    restricted: [wallet + "PersonalEMTabRestricted", "EverMarks donations require membership in a player corporation."],
    corporateRestricted: [wallet + "CorpEMTabRestricted", "Your corporation must be an alliance member for the required number of days."],
    notice: [wallet + "TransferPersonalEMNotice", "You can donate EverMarks to eligible corporations listed here."],
    executorNotice: [wallet + "TransferEMToNonExecCorpNotice", "You can donate EverMarks to eligible alliance member corporations."],
    memberNotice: [wallet + "TransferEMToExecCorpNotice", "You can donate EverMarks to your alliance executor corporation."],
    confirmation: [wallet + "CorpEMTransactionConfirmation", ""],
  } as const;
  function word(key: keyof typeof labels, values: Record<string, string | number> = {}, fallback?: string) {
    const [label, own] = labels[key];
    const template = $words.templates[label];
    return (template ? plainText(formatTemplate(template, values, { nameOf: () => "" })) : "") || fallback || own;
  }
  function corpName(id: number) { return resolvedName($names.resolved, "corporation", id, ""); }
  type Eligibility = Awaited<ReturnType<AppFlow["personalEvermarkDonationEligibility"]>> & { readonly executor?: boolean };
  let eligibility = $state.raw<Eligibility | null>(null);
  let revision = $state(0);
  let error = $state("");
  let chosen = $state(0);
  let input = $state<number | undefined>(0);
  let busy = $state(false);
  let succeeded = $state(false);
  let transferError = $state("");
  const amount = $derived(input ?? 0);
  const canTransfer = $derived(chosen !== 0 && Number.isSafeInteger(amount) && amount > 0 && balance !== null && amount <= balance);
  const recipient = $derived(corpName(chosen));
  const station = $derived(store.station);

  $effect(() => {
    void revision;
    if (corporate) void $station.online?.allianceID;
    let current = true;
    error = "";
    eligibility = null;
    flow.requestWords(Object.values(labels).map(([path]) => path));
    const readEligibility = corporate ? flow.corporationEvermarkDonationEligibility : flow.personalEvermarkDonationEligibility;
    void readEligibility().then(value => {
      if (!current) return;
      eligibility = value;
      chosen = value.recipients.length === 1 ? value.recipients[0]! : 0;
    }).catch(cause => { if (current) error = panelErrorWords(cause); });
    return () => { current = false; };
  });
  $effect(() => { if (chosen) flow.requestCorpLogos([chosen]); });

  function clearRecipient() {
    if (eligibility?.recipients.length !== 1) chosen = 0;
  }
  async function transfer() {
    if (!canTransfer || busy || !recipient) return;
    const value = amount, to = chosen;
    const formatted = value.toLocaleString("en-US");
    const question = word("confirmation", { corpName: recipient, amount: formatted },
      `Transfer ${formatted} EverMarks to ${recipient}?`);
    busy = true;
    succeeded = false;
    transferError = "";
    try {
      const donate = corporate ? flow.donateCorporationLp : flow.donatePersonalLp;
      if (!await donate(to, issuerID, value, question)) return;
      succeeded = true;
      clearRecipient();
      input = 0;
      refresh();
    } catch (cause) {
      transferError = panelErrorWords(cause);
      clearRecipient();
      refresh();
    } finally {
      busy = false;
    }
  }
</script>

<section class="wallet-donate-evermarks" aria-busy={busy || (eligibility === null && !error)}>
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => revision++}>Refresh</button>
  {:else if eligibility === null}
    <p role="status">Reading donation eligibility…</p>
  {:else if eligibility.recipients.length === 0}
    <div class="restricted">
      <h3>{word("restrictedTitle")}</h3>
      <p>{word(corporate ? "corporateRestricted" : "restricted", { numDays: eligibility.minimumDays })}</p>
    </div>
  {:else}
    <div class="donation">
      <fieldset disabled={busy}>
        {#if chosen === 0}
          <label>{word("recipient")}
            <select bind:value={chosen} onchange={() => { succeeded = false; transferError = ""; }}>
              <option value={0} disabled>{word("choose")}</option>
              {#each eligibility.recipients as id (id)}
                <option value={id}>{corpName(id) || "Corporation"}</option>
              {/each}
            </select>
          </label>
        {:else}
          {@const logo = $logos[String(chosen)]}
          <div class="evermark-recipient">
            {#if logo && $logoLibrary}
              <span class="logo"><CorpLogo library={$logoLibrary} {logo} name="" /></span>
            {/if}
            <strong>{recipient || "Corporation"}</strong>
            {#if eligibility.recipients.length > 1}
              <button type="button" class="minor" aria-label="Change recipient" onclick={clearRecipient}>×</button>
            {/if}
          </div>
        {/if}
        <label>{word("amount")}
          <input type="number" min="0" max={balance ?? 0} step="1" placeholder={word("em")}
            bind:value={input} disabled={!balance} onblur={() => {
              if (input !== undefined) input = Math.max(0, Math.min(Math.trunc(input), balance ?? 0));
            }} />
        </label>
        <div class="controls">
          <button type="button" disabled={!canTransfer || !recipient} onclick={() => void transfer()}>{word("transfer")}</button>
          {#if succeeded}<span class="success" role="status">{word("success")}</span>{/if}
        </div>
        {#if transferError}<p role="alert">{transferError}</p>{/if}
      </fieldset>
      <aside>{word(corporate ? (eligibility.executor ? "executorNotice" : "memberNotice") : "notice",
        { numDays: eligibility.minimumDays, numDaysCorp: eligibility.minimumDays, numDaysAlliance: eligibility.minimumDays })}</aside>
    </div>
  {/if}
</section>

<style>
  .wallet-donate-evermarks { padding-block: 16px; }
  .donation { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr)); align-items: start; gap: 16px; }
  fieldset { display: grid; gap: 14px; border: 0; padding: 0; margin: 0; }
  label { display: grid; gap: 4px; justify-items: start; }
  input { max-width: 12ch; }
  .evermark-recipient { display: flex; align-items: center; padding: 6px; gap: 10px; background: rgb(255 255 255 / .05); }
  .logo { display: block; width: 40px; height: 40px; }
  aside { padding: 8px 12px; border-left: 2px solid var(--theme-focus, #91bfd7); background: rgb(255 255 255 / .05);
    white-space: pre-line; }
  .restricted { padding: 28px 8px; text-align: center; }
  .restricted h3, p { margin: 0 0 8px; }
  .success { color: var(--color-good); }
</style>
