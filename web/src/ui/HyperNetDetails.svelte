<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { failureCode } from "../bridge/ask.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { HyperNetOfferDetails } from "../bridge/hyperNet.ts";
  import { formatDuration } from "../bridge/skills.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { showInfo } from "./showInfo.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, id, pilot, now }: {
    store: ClientStore; flow: AppFlow; id: number; pilot: number | undefined; now: number;
  } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const labels = {
    title: ["UI/HyperNet/PageTitleDetails", "Offer details"],
    unavailable: ["UI/HyperNet/NotFoundError", "HyperNet offer unavailable"],
    tickets: ["UI/HyperNet/Tickets", "HyperNodes"],
    price: ["UI/HyperNet/TicketPrice", "HyperNode price"],
    creator: ["UI/HyperNet/CreatedBy", "Created by"],
    location: ["UI/HyperNet/Location", "Location"],
    expires: ["UI/HyperNet/ExpiresIn", "Expires in"],
    expiry: ["UI/HyperNet/ExpirationDate", "Expiration date"],
    completed: ["UI/HyperNet/CompletionDate", "Completion date"],
    estimate: ["UI/HyperNet/MarketEstimate", "Market estimate: {value}"],
    unknown: ["UI/Common/Unknown", "Unknown"],
    available: ["UI/HyperNet/AvailableTickets", "{remaining_ticket_count} available"],
    owned: ["UI/HyperNet/OwnedTickets", "{owned_ticket_count} owned"],
    only: ["UI/HyperNet/ShowOnlyAvailable", "Show only available"],
    expired: ["UI/HyperNet/CardExpired", "Expired"],
    winner: ["UI/HyperNet/CardWinner", "Winner"],
    confirm: ["UI/HyperNet/ConfirmPurchaseButtonLabel", "Confirm"],
    unavailableNode: ["UI/HyperNet/TicketUnavailableError", "This HyperNode is unavailable."],
    insufficientISK: ["UI/HyperNet/NotEnoughISKError", "You do not have enough ISK."],
    purchaseError: ["UI/HyperNet/UnknownError", "HyperNet could not confirm the purchase."],
  } as const;
  const word = (key: keyof typeof labels, args: Record<string, string | number> = {}) =>
    plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1], args, { nameOf: () => "" }));
  $effect(() => flow.requestWords(Object.values(labels).map(([path]) => path)));

  let details = $state.raw<HyperNetOfferDetails | null>(null);
  let estimate = $state<number | null>(null);
  let groupID = $state<number | null>(null);
  let failed = $state(false);
  let onlyAvailable = $state(false);
  let armed = $state<number | null>(null);
  let confirmationReady = $state(false);
  let buying = $state<number | null>(null);
  let purchaseError = $state<{ node: number; label: "unavailableNode" | "insufficientISK" | "purchaseError" } | null>(null);
  let readyTimer: number | undefined;
  let expiryTimer: number | undefined;
  let offerGeneration = 0;
  let refreshOffer: (() => void) | undefined;
  const bought = $derived(details ? [...details.ticketOwners.values()].filter(owner => owner === pilot).length : 0);
  const expired = $derived(details !== null && (details.status === 9 || (details.status < 7 && details.expires <= now)));
  const active = $derived(details?.status === 6 && !expired);
  const shownNodes = $derived(details
    ? Array.from({ length: details.tickets }, (_, number) => ({ number, owner: details!.ticketOwners.get(number) ?? null }))
        .filter(node => !active || !onlyAvailable || node.owner === null)
    : []);
  const pilotName = (characterID: number) => resolvedName($names.resolved, "character", characterID, String(characterID));

  function clearConfirmation() {
    window.clearTimeout(readyTimer);
    window.clearTimeout(expiryTimer);
    armed = null;
    confirmationReady = false;
  }

  function updateOffer(row: HyperNetOfferDetails) {
    // A detail read may have started before a purchase reply. Sold nodes never become available again.
    if (details && (row.status < details.status || row.remaining > details.remaining)) return;
    details = row;
    if (armed !== null && (row.status !== 6 || row.ticketOwners.has(armed))) clearConfirmation();
  }

  async function chooseNode(node: number) {
    if (!details || !active || details.ticketOwners.has(node) || buying !== null || !pilot) return;
    const learnedKey = `evejs-hypernet-confirm:${pilot}`;
    if (armed !== node) {
      clearConfirmation();
      purchaseError = null;
      armed = node;
      let learned = false;
      try { learned = localStorage.getItem(learnedKey) === "1"; } catch {}
      readyTimer = window.setTimeout(() => { confirmationReady = true; }, 400);
      expiryTimer = window.setTimeout(clearConfirmation, learned ? 2900 : 9900);
      return;
    }
    if (!confirmationReady) return;
    clearConfirmation();
    buying = node;
    const generation = offerGeneration;
    try { localStorage.setItem(learnedKey, "1"); } catch {}
    try {
      const row = await flow.buyHyperNetNode(id, node);
      if (generation !== offerGeneration) return;
      updateOffer(row);
    } catch (cause) {
      if (generation !== offerGeneration) return;
      const reason = failureCode(cause) === "CALL_REFUSED" && cause instanceof Error ? cause.message : "";
      purchaseError = { node, label: reason === "TicketUnavailableError" ? "unavailableNode" :
        reason === "NotEnoughISKError" ? "insufficientISK" : "purchaseError" };
    } finally {
      if (generation === offerGeneration) {
        buying = null;
        refreshOffer?.();
      }
    }
  }

  $effect(() => {
    if (!active) clearConfirmation();
  });

  $effect(() => {
    const offerID = id;
    const app = flow;
    details = null;
    estimate = null;
    groupID = null;
    failed = false;
    onlyAvailable = false;
    buying = null;
    purchaseError = null;
    if (!pilot) return;
    let current = true;
    let dirty = false;
    let reading = false;
    let timer: number | undefined;
    let stopWatching: (() => void) | undefined;
    function scheduleRead() {
      dirty = true;
      if (!current || reading || timer !== undefined) return;
      // EveJS can send count, full-row and winner notices for the same sale.
      timer = window.setTimeout(() => {
        timer = undefined;
        void read();
      }, 150);
    }
    async function read() {
      dirty = false;
      reading = true;
      try {
        const row = await app.loadHyperNetOfferDetails(offerID);
        if (!current) return;
        const first = details === null;
        updateOffer(row);
        requestOfferNames(row);
        if (first) {
          readTypeInfo(row);
          if (row.status < 7) stopWatching = app.watchHyperNetOffer(offerID, scheduleRead);
        }
      } catch {
        if (current && details === null) failed = true;
      } finally {
        reading = false;
        if (dirty) scheduleRead();
      }
    }
    function requestOfferNames(row: HyperNetOfferDetails) {
      app.requestNames([
        { kind: "type", id: row.typeID }, { kind: "station", id: row.locationID }, { kind: "system", id: row.systemID },
        ...[...new Set([row.ownerID, ...row.ticketOwners.values(), ...(row.winnerID ? [row.winnerID] : [])])]
          .map(id => ({ kind: "character" as const, id })),
      ]);
    }
    function readTypeInfo(row: HyperNetOfferDetails) {
      void app.typeFacts([row.typeID]).then(facts => {
        const group = facts?.get(row.typeID)?.groupID;
        if (!current || !group) return;
        groupID = group;
        app.requestNames([{ kind: "group", id: group }]);
      }).catch(() => {});
      if (!row.copy) void app.cfgAveragePrices().then(prices => {
        if (current) estimate = prices?.get(row.typeID) ?? null;
      }).catch(() => {});
    }
    refreshOffer = scheduleRead;
    void read();
    return () => {
      current = false;
      ++offerGeneration;
      refreshOffer = undefined;
      clearConfirmation();
      if (timer !== undefined) window.clearTimeout(timer);
      stopWatching?.();
    };
  });
</script>

<section class="offer-details" data-hypernet-details={id} aria-label={word("title")}>
  <header>
    <h2>{word("title")}</h2>
  </header>
  {#if failed}
    <p role="alert">{word("unavailable")}</p>
  {:else if details}
    {@const offer = details}
    <div class="offer-facts">
      <div class="offer-item">
        <img src={typeIconUrl(offer.typeID)} alt="" />
        <div>
          {#if groupID}<p>{resolvedName($names.resolved, "group", groupID, "")}</p>{/if}
          <button type="button" onclick={() => showInfo({ kind: "type", typeID: offer.typeID, itemID: offer.itemID ?? undefined })}>
            {resolvedName($names.resolved, "type", offer.typeID, String(offer.typeID))}
          </button>
          <p>{word("estimate", { value: estimate === null ? word("unknown") : estimate.toLocaleString() + " ISK" })}</p>
        </div>
      </div>
      <dl>
        <div><dt>{word("tickets")}</dt><dd data-detail-count>{offer.tickets}</dd></div>
        <div><dt>{word("price")}</dt><dd data-detail-price>{offer.price.toLocaleString()} ISK</dd></div>
        <div>
          <dt>{word("location")}</dt>
          <dd data-detail-location>
            <button type="button" onclick={() => showInfo({ kind: "mapLocation", typeID: 5, itemID: offer.systemID })}>
              {resolvedName($names.resolved, "system", offer.systemID, String(offer.systemID))}
            </button>
            <br />
            {resolvedName($names.resolved, "station", offer.locationID, String(offer.locationID))}
          </dd>
        </div>
        <div>
          <dt>{word("creator")}</dt>
          <dd><button data-detail-owner type="button" onclick={() => showInfo({ kind: "character", characterID: offer.ownerID })}>{pilotName(offer.ownerID)}</button></dd>
        </div>
        <div>
          <dt>{word(active ? "expires" : expired ? "expiry" : "completed")}</dt>
          <dd><time datetime={new Date(offer.ended ?? offer.expires).toISOString()}>
            {active ? formatDuration(offer.expires - now) : new Date(offer.ended ?? offer.expires).toLocaleString()}
          </time></dd>
        </div>
      </dl>
    </div>
    {#if expired}
      <p data-expired>{word("expired")}</p>
    {:else if offer.winnerID !== null}
      {@const winner = offer.winnerID}
      <p data-hypernet-winner>{word("winner")} · <button type="button" onclick={() => showInfo({ kind: "character", characterID: winner })}>{pilotName(winner)}</button></p>
    {/if}
    {#if active}
      <div class="ticket-controls">
        <label><input type="checkbox" bind:checked={onlyAvailable} /> {word("only")}</label>
        <p data-detail-available>{word("available", { remaining_ticket_count: offer.remaining })}</p>
        <p data-detail-owned>{word("owned", { owned_ticket_count: bought })}</p>
      </div>
    {/if}
    <ul class="tickets">
      {#each shownNodes as node (node.number)}
        <li class:own={node.owner !== null && node.owner === pilot} class:sold={node.owner !== null}
          class:winning={node.number === offer.winningNumber} data-ticket-number={node.number}>
          <span>#{node.number + 1}</span>
          {#if node.owner !== null}
            {@const owner = node.owner}
            <button type="button" onclick={() => showInfo({ kind: "character", characterID: owner })}>{pilotName(owner)}</button>
          {:else if active}
            <button type="button" class:confirm={armed === node.number} data-buy-node
              aria-pressed={armed === node.number} aria-disabled={armed === node.number && !confirmationReady} disabled={buying !== null}
              onclick={() => void chooseNode(node.number)}>
              {buying === node.number ? "Purchasing…" : armed === node.number ? word("confirm") : `${offer.price.toLocaleString()} ISK`}
            </button>
          {:else}<span>—</span>{/if}
          {#if purchaseError?.node === node.number}<p class="purchase-error" role="alert">{word(purchaseError.label)}</p>{/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p role="status">Loading HyperNet offer…</p>
  {/if}
</section>

<style>
  .offer-details { display: grid; gap: 12px; }
  header, .offer-item, .ticket-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .offer-facts { display: grid; gap: 10px; padding: 10px; background: #ffffff08; }
  .offer-item img { width: 72px; height: 72px; object-fit: contain; }
  .offer-item p, dt { color: #b8c3cc; }
  dl { display: flex; flex-wrap: wrap; gap: 10px 24px; }
  dl, dd, h2, p { margin: 0; }
  .tickets { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; padding: 0; margin: 0; list-style: none; }
  .tickets li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 5px; background: #ffffff10; }
  .tickets .sold { background: #ffffff06; }
  .tickets .confirm { border-color: #66cddd; background: #00506666; }
  .purchase-error { width: 100%; color: #ffbf68; }
  .tickets .own { background: #00506666; }
  .tickets .winning { outline: 1px solid #e0be70; }
  @media (max-width: 650px) { .tickets { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
