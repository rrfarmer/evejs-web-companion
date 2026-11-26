<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow, MoneyTransfer } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { transferAmount, transferEditedAmount, transferValue, TRANSFER_MIN_ISK, TRANSFER_REASON_MAX } from "../bridge/giveMoney.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import CorpLogo from "./CorpLogo.svelte";
  import { portraitUrl, portraitDefaultPath } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, request, inFront }: { store: ClientStore; flow: AppFlow; request: MoneyTransfer; inFront: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words, images = flow.imageServer, logos = flow.corpLogos, library = flow.corpLogoLibrary, ownerLogos = flow.ownerLogos;
  const prefix = "UI/Wallet/WalletWindow/";
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  const caption = $derived(word(prefix + "TransferMoney", "Transfer Money"));
  // This component is keyed by request.n: native CloseIfOpen/Open creates fresh edits.
  // svelte-ignore state_referenced_locally
  let amount = $state(String(transferAmount("0.1", request.maximum)));
  // svelte-ignore state_referenced_locally
  let destination = $state(request.toAccountKey);
  let reason = $state("");
  let amountInput: HTMLInputElement;
  let windowNode: HTMLElement;
  const from = $derived(plainText(formatTemplate($words.templates[prefix + (request.corporate ? "FromCharacterAcct" : "FromCharacter")] ?? (request.corporate ? "Giver: {[character]charID.name} ({acctName})" : "Giver: {[character]charID.name}"), { charID: request.fromID, acctName: request.divisionName }, { nameOf: () => request.fromName })));
  const to = $derived(plainText(formatTemplate($words.templates[prefix + "ToCharacter"] ?? "Receiver: {[character]charID.name}", { charID: request.toID }, { nameOf: () => request.toName })));
  function portrait(id: number): readonly string[] {
    const url = portraitUrl($images, id, 64);
    return [...(url ? [url] : []), clientTexture(portraitDefaultPath(64))];
  }
  function editAmount(event: Event): void {
    const node = event.currentTarget as HTMLInputElement;
    amount = (event as InputEvent).inputType === "insertFromPaste" ? String(transferAmount(node.value, request.maximum)) : transferEditedAmount(node.value, request.maximum, amount); node.value = amount;
  }
  function amountLeft(): void {
    // Native OnKillFocus380-385 only repairs the lower bound. SetMaxValue
    // alone does not rewrite old text after an account event.
    if (transferValue(amount) <= TRANSFER_MIN_ISK) amount = String(transferAmount(String(TRANSFER_MIN_ISK), request.maximum));
  }
  onMount(() => { if (inFront) { amountInput.focus(); amountInput.select(); } });
</script>

<svelte:window onkeydown={event => { if (inFront && event.key === "Escape" && windowNode?.contains(document.activeElement)) { event.preventDefault(); flow.closeMoneyTransfer(request.n); } }} />
<div class="transfer-shade" class:inactive={!inFront}>
  <div bind:this={windowNode} class="transfer-window" role="dialog" aria-modal="false" tabindex="-1" aria-label={caption} data-dialog="TransferMoney" data-in-front={inFront}>
    {#snippet owner(id: number, name: string, corporation: boolean)}
      <span class="owner-picture">
        {#if corporation && $logos[String(id)] && $library}<CorpLogo library={$library} logo={$logos[String(id)]!} {name} />
        {:else if corporation && $ownerLogos?.corporations[String(id)]}<img src={clientTexture($ownerLogos.corporations[String(id)]!)} width="64" height="64" alt="" />
        {:else}<OwnerPicture {name} urls={corporation ? [] : portrait(id)} size={64} />{/if}
      </span>
    {/snippet}
    <form onsubmit={event => { event.preventDefault(); void flow.confirmMoneyTransfer(request.n, amount, reason, destination); }}>
      <h3>{caption}</h3>
      <div class="owner">
        {@render owner(request.fromID, request.fromName, request.corporate)}<span>{from}</span>
      </div>
      <div class="owner">{@render owner(request.toID, request.toName, request.toCorporation)}<span>{to}</span></div>
      {#if request.accounts.length > 0}
        <label>{word(prefix + "Account", "Account")}
          <select bind:value={destination} disabled={request.busy}>
            {#each request.accounts as account (account.key)}<option value={account.key}>{account.name}</option>{/each}
          </select>
        </label>
      {/if}
      <label>{word(prefix + "ColHeaderAmount", "Amount")}<input bind:this={amountInput} type="text" inputmode="decimal" value={amount} oninput={editAmount} onblur={amountLeft} /></label>
      <label>{word(prefix + "Reason", "Reason")}<input type="text" maxlength={TRANSFER_REASON_MAX} bind:value={reason} /></label>
      {#if request.error}<p class="error">{request.error}</p>{/if}
      <div class="answers"><button type="submit" disabled={request.busy}>{word("UI/Common/Buttons/OK", "OK")}</button><button type="button" onclick={() => flow.closeMoneyTransfer(request.n)}>{word("UI/Common/Buttons/Cancel", "Cancel")}</button></div>
    </form>
  </div>
</div>

<style>
  .transfer-shade { position: fixed; inset: 0; z-index: 45; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .transfer-shade.inactive { display: none; }
  .transfer-window { pointer-events: auto; width: min(340px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow-y: auto; padding: 1rem; box-sizing: border-box; background: #14273a; color: #d6e6f7; border: 1px solid #3c6f9e; }
  form { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
  h3, p { margin: 0; }
  .owner { display: flex; align-items: center; gap: .75rem; min-width: 0; overflow-wrap: anywhere; }
  .owner-picture { width: 64px; height: 64px; flex: 0 0 64px; }
  label { display: flex; flex-direction: column; gap: .25rem; }
  input, select { min-width: 0; width: 100%; box-sizing: border-box; background: #0d1b29; color: inherit; border: 1px solid #3c6f9e; padding: .3rem .4rem; }
  .answers { display: flex; justify-content: flex-end; gap: .5rem; }
  button { border: 1px solid #5b93c7; background: #1b3956; color: inherit; padding: .3rem 1rem; cursor: pointer; }
</style>
