<script module lang="ts">
  const labels = {
    hint: ["UI/HyperNet/QuickBuyButtonHint", "Buy one random HyperNode for {price} ISK"],
    owned: ["UI/HyperNet/OwnedTickets", "{owned_ticket_count} owned"],
    confirm: ["UI/HyperNet/ConfirmPurchaseButtonLabel", "Confirm"],
    unavailable: ["UI/HyperNet/TicketUnavailableError", "This HyperNode is unavailable."],
    insufficient: ["UI/HyperNet/NotEnoughISKError", "You do not have enough ISK."],
    failed: ["UI/HyperNet/UnknownError", "HyperNet could not confirm the purchase."],
  } as const;
  export const quickBuyWords = Object.values(labels).map(([path]) => path);
</script>

<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { failureCode } from "../bridge/ask.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { HyperNetOffer, HyperNetOfferDetails } from "../bridge/hyperNet.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "./skillGroupIcons.ts";

  let { store, flow, pilot, offer, owned, enabled = true, onUpdate }: {
    store: ClientStore; flow: AppFlow; pilot: number | undefined; offer: HyperNetOffer; owned: number;
    enabled?: boolean; onUpdate: (row: HyperNetOfferDetails, owned: number) => void;
  } = $props();
  const words = $derived(store.words);
  const word = (key: keyof typeof labels, args: Record<string, number | string> = {}) =>
    plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1], args, { nameOf: () => "" }));
  const hint = $derived(owned > 0
    ? word("owned", { owned_ticket_count: owned }) + " · " + word("hint", { price: Number(offer.price) })
    : word("hint", { price: Number(offer.price) }));
  const walletIcon = clientTexture("res:/UI/Texture/Vgs/isk_16.png");
  const ticketsIcon = clientTexture("res:/UI/Texture/classes/HyperNet/tickets_icon.png");

  let armed = $state(false);
  let ready = $state(false);
  let buying = $state(false);
  let error = $state<"unavailable" | "insufficient" | "failed" | null>(null);
  let readyTimer: number | undefined;
  let expiryTimer: number | undefined;
  let current = true;

  function cancel() {
    window.clearTimeout(readyTimer);
    window.clearTimeout(expiryTimer);
    armed = false;
    ready = false;
  }
  $effect(() => {
    if (!enabled || offer.remaining === 0) cancel();
  });
  $effect(() => () => { current = false; cancel(); });

  async function quickBuy() {
    const owner = pilot;
    const id = offer.id;
    if (!owner || !enabled || buying || offer.remaining === 0 || offer.expires <= Date.now()) return;
    const key = `evejs-hypernet-confirm:${owner}`;
    if (!armed) {
      error = null;
      armed = true;
      let learned = false;
      try { learned = localStorage.getItem(key) === "1"; } catch {}
      readyTimer = window.setTimeout(() => { ready = true; }, 400);
      expiryTimer = window.setTimeout(cancel, learned ? 2900 : 9900);
      return;
    }
    if (!ready) return;
    cancel();
    buying = true;
    function apply(row: HyperNetOfferDetails) {
      if (current && pilot === owner) {
        const count = [...row.ticketOwners.values()].filter(ticketOwner => ticketOwner === owner).length;
        onUpdate(row, count);
      }
    }
    try { localStorage.setItem(key, "1"); } catch {}
    try {
      const row = await flow.buyHyperNetNodes(id, 1);
      apply(row);
    } catch (cause) {
      if (!current || pilot !== owner) return;
      const reason = failureCode(cause) === "CALL_REFUSED" && cause instanceof Error ? cause.message : "";
      error = reason === "NotEnoughISKError" ? "insufficient" : reason === "TicketUnavailableError" ? "unavailable" : "failed";
      if (error === "unavailable") {
        try {
          const row = await flow.loadHyperNetOfferDetails(id);
          apply(row);
        } catch {}
      }
    } finally {
      if (current) buying = false;
    }
  }
</script>

<div class="quick-buy">
  <button type="button" class:shown={owned > 0 || armed || buying || error !== null} class:armed
    data-hypernet-quick-buy data-owned={owned} title={hint} aria-label={armed ? word("confirm") : hint}
    aria-pressed={armed} aria-disabled={armed && !ready}
    disabled={!enabled || !pilot || buying || offer.remaining === 0} onclick={() => void quickBuy()}>
    {#if buying}Purchasing…
    {:else if armed}{word("confirm")}
    {:else if owned > 0}<img src={ticketsIcon} alt="" />{owned}
    {:else}<img src={walletIcon} alt="" />{/if}
  </button>
  {#if error}<p role="alert">{word(error)}</p>{/if}
</div>

<style>
  .quick-buy { position: relative; }
  button { display: flex; gap: 4px; align-items: center; min-height: 26px; }
  button:not(.shown):not(:focus-visible) { opacity: 0; pointer-events: none; }
  :global(li:hover) button:not(.shown), :global(li:focus-within) button:not(.shown) { opacity: 1; pointer-events: auto; }
  .armed { border-color: #66cddd; background: #00506666; }
  img { width: 14px; height: 14px; object-fit: contain; }
  p { position: absolute; inset-inline-end: 0; min-width: 145px; z-index: 1; margin: 3px 0;
    background: #171e27; color: #ffbf68; padding: 6px; border: 1px solid #667184; }
</style>
