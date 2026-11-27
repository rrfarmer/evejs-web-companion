<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { HyperNetOffer, HyperNetOfferDetails } from "../bridge/hyperNet.ts";
  import { hyperNetLinkLabel } from "../bridge/hyperNetOfferLink.ts";
  import { formatDuration } from "../bridge/skills.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import HyperNetQuickBuy from "./HyperNetQuickBuy.svelte";
  import { startHyperNetOfferDrag } from "./linkFollowers.ts";
  import { showInfo } from "./showInfo.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, pilot, offer, now, owned, enabled = true, similar = false, openDetails, onPurchase }: {
    store: ClientStore; flow: AppFlow; pilot: number | undefined; offer: HyperNetOffer; now: number;
    owned: number; enabled?: boolean; similar?: boolean; openDetails: (id: number) => void;
    onPurchase: (row: HyperNetOfferDetails, owned: number) => void;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const name = $derived(resolvedName($names.resolved, "type", offer.typeID, String(offer.typeID)));
  const labels = {
    details: ["UI/HyperNet/PageTitleDetails", "Offer details"],
    price: ["UI/HyperNet/TicketPrice", "HyperNode price"],
    tickets: ["UI/HyperNet/RemainingTickets", "{remaining_ticket_count}/{ticket_count} HyperNodes"],
  } as const;
  const word = (key: keyof typeof labels) => $words.templates[labels[key][0]] ?? labels[key][1];
  $effect(() => flow.requestWords(Object.values(labels).map(([path]) => path)));
  const ticketCount = $derived(plainText(formatTemplate(word("tickets"),
    { remaining_ticket_count: offer.remaining, ticket_count: offer.tickets }, { nameOf: () => "" })));
</script>

<li data-offer-id={similar ? undefined : offer.id} data-similar-offer-id={similar ? offer.id : undefined}
  data-offer-type={offer.typeID} draggable="true"
  ondragstart={event => startHyperNetOfferDrag(event, offer.id, name, $words.templates[hyperNetLinkLabel])}>
  <button class="item" type="button" onclick={() => showInfo({ kind: "type", typeID: offer.typeID })}>
    <img src={typeIconUrl(offer.typeID)} alt="" />{name}
  </button>
  <dl>
    <dt>{plainText(word("price"))}</dt><dd data-ticket-price>{offer.price.toLocaleString()} ISK</dd>
  </dl>
  <p data-ticket-count>{ticketCount}</p>
  <time datetime={new Date(offer.expires).toISOString()}>{formatDuration(offer.expires - now)}</time>
  <div class="offer-actions">
    <button type="button" data-open-offer onclick={() => openDetails(offer.id)}>{plainText(word("details"))}</button>
    <HyperNetQuickBuy {store} {flow} {pilot} {offer} {owned} {enabled} onUpdate={onPurchase} />
  </div>
</li>

<style>
  li { display: grid; gap: 8px; padding: 8px; background: #ffffff08; }
  .offer-actions { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .item { display: flex; align-items: center; gap: 8px; text-align: start; }
  img { width: 32px; height: 32px; object-fit: contain; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 4px; }
  dl, dd, p { margin: 0; }
  time { color: #b8c3cc; }
</style>
