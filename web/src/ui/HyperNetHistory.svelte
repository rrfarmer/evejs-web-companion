<script lang="ts">
  import { onMount } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { HyperNetHistoryOffer, HyperNetParticipation } from "../bridge/hyperNet.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import OwnerPicture from "./OwnerPicture.svelte";
  import { portraitDefaultPath, portraitUrl } from "./ownerImages.ts";
  import { showInfo } from "./showInfo.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { typeIconUrl } from "./typeIcons.ts";

  let { store, flow, pilot }: { store: ClientStore; flow: AppFlow; pilot: number | undefined } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const imageServer = $derived(flow.imageServer);
  const labels = {
    heading: ["UI/HyperNet/PageTitleHistory", "Your HyperNet Relay participation history"],
    empty: ["UI/Common/NoDataAvailable", "No Data Available"],
    expired: ["UI/HyperNet/CardExpired", "Expired"],
    winner: ["UI/HyperNet/CardWinner", "Winner"],
    created: ["UI/HyperNet/CreatedByPlayerHint", "Created by you"],
    joined: ["UI/HyperNet/FilterJoined", "Joined"],
    price: ["UI/HyperNet/TicketPrice", "HyperNode price"],
    count: ["UI/HyperNet/TicketCountLabel", "HyperNode count"],
    retry: ["UI/HyperNet/Refresh", "Refresh"],
    totalCreated: ["UI/HyperNet/Created", "{amount} Created"],
    completed: ["UI/HyperNet/Completed", "{amount} Completed"],
    active: ["UI/HyperNet/Active", "{amount} Active"],
    totalJoined: ["UI/HyperNet/Joined", "{amount} Joined"],
    won: ["UI/HyperNet/Won", "{amount} Won"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const stat = (key: keyof typeof labels, amount: number) =>
    plainText(formatTemplate($words.templates[labels[key][0]] ?? labels[key][1], { amount }, { nameOf: () => "" }));
  let history = $state.raw<readonly HyperNetHistoryOffer[]>([]);
  let participation = $state.raw<HyperNetParticipation | null>(null);
  let participationError = $state("");
  const active = $derived(history.filter(record => record.status < 7));
  const createdActive = $derived(active.filter(record => record.ownerID === pilot).length);
  const joinedActive = $derived(active.filter(record => record.joined).length);
  let loading = $state(true);
  let error = $state("");
  let refresh = $state(0);
  const rank = (record: HyperNetHistoryOffer, owner: number | undefined) =>
    record.status === 7 && record.winnerID === owner ? 0 : record.status < 7 ? 1 : 2;
  const rows = $derived([...history].sort((a, b) => {
    const group = rank(a, pilot);
    const order = group - rank(b, pilot);
    return order || (group < 2
      ? resolvedName($names.resolved, "type", a.typeID, String(a.typeID))
        .localeCompare(resolvedName($names.resolved, "type", b.typeID, String(b.typeID)))
      : (b.ended ?? b.expires) - (a.ended ?? a.expires)) || b.runningID - a.runningID;
  }));

  onMount(() => flow.requestWords(Object.values(labels).map(([path]) => path)));

  $effect(() => {
    const owner = pilot;
    void refresh;
    history = [];
    participation = null;
    participationError = "";
    error = "";
    loading = !!owner;
    if (!owner) return;
    let current = true;
    void flow.loadHyperNetParticipation().then(stats => {
      if (current) participation = stats;
    }, cause => {
      if (current) participationError = panelErrorWords(cause);
    });
    void flow.loadHyperNetHistory().then(records => {
      if (!current) return;
      history = records;
      flow.requestNames(records.flatMap(row => [
        { kind: "type", id: row.typeID },
        { kind: "station", id: row.locationID },
        { kind: "system", id: row.systemID },
        ...(row.winnerID ? [{ kind: "character" as const, id: row.winnerID }] : []),
      ]));
    }, cause => {
      if (current) error = panelErrorWords(cause);
    }).finally(() => {
      if (current) loading = false;
    });
    return () => { current = false; };
  });
</script>

<section class="hypernet-history" aria-label={word("heading")}>
  <h2>{word("heading")}</h2>
  {#if participation && pilot && !loading && !error}
    <div class="participation">
      <OwnerPicture name={resolvedName($names.resolved, "character", pilot, "")}
        urls={[portraitUrl($imageServer, pilot, 128), clientTexture(portraitDefaultPath(128))].filter((url): url is string => url !== null)}
        size={64} />
      <div>
        <p data-history-stat="created">{stat("totalCreated", participation.created)}</p>
        <p data-history-stat="completed">{stat("completed", participation.completed)}</p>
        <p data-history-stat="created-active">{stat("active", createdActive)}</p>
      </div>
      <div>
        <p data-history-stat="joined">{stat("totalJoined", participation.joined)}</p>
        <p data-history-stat="won">{stat("won", participation.won)}</p>
        <p data-history-stat="joined-active">{stat("active", joinedActive)}</p>
      </div>
    </div>
  {:else if participationError && !error}
    <div class="participation">
      <p role="alert">{participationError}</p>
      <button type="button" onclick={() => { refresh++; }}>{word("retry")}</button>
    </div>
  {/if}
  {#if loading}
    <p role="status">Loading HyperNet history…</p>
  {:else if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => { refresh++; }}>{word("retry")}</button>
  {:else if !rows.length}
    <p role="status">{word("empty")}</p>
  {:else}
    <ul>
      {#each rows as row (row.id)}
        <li data-history-id={row.id} data-history-status={row.status}>
          <button class="item" type="button" onclick={() => showInfo({ kind: "type", typeID: row.typeID })}>
            <img src={typeIconUrl(row.typeID)} alt="" />
            {resolvedName($names.resolved, "type", row.typeID, String(row.typeID))}
          </button>
          <span>{row.ownerID === pilot ? word("created") : word("joined")}</span>
          <span>{resolvedName($names.resolved, "system", row.systemID, String(row.systemID))}
            · {resolvedName($names.resolved, "station", row.locationID, String(row.locationID))}</span>
          <dl>
            <dt>{word("price")}</dt><dd>{row.price.toLocaleString()} ISK</dd>
            <dt>{word("count")}</dt><dd>{row.status < 7 ? `${row.remaining}/${row.tickets}` : row.tickets}</dd>
          </dl>
          <span>
            {#if row.status < 7}Active
            {:else if row.winnerID}{word("winner")} · {resolvedName($names.resolved, "character", row.winnerID, String(row.winnerID))}
            {:else}{word("expired")}{/if}
          </span>
          <time datetime={new Date(row.ended ?? row.expires).toISOString()}>
            {new Date(row.ended ?? row.expires).toLocaleString()}
          </time>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .hypernet-history { display: grid; gap: 10px; }
  .participation { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px; padding: 10px; background: #ffffff08; }
  .participation > div { display: grid; gap: 4px; min-width: 90px; }
  .participation p:first-child { font-weight: 600; }
  h2, ul, dl, dd, p { margin: 0; }
  ul { list-style: none; padding: 0; display: grid; gap: 6px; }
  li { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 135px), 1fr)); align-items: center; gap: 8px; padding: 8px; background: #ffffff08; }
  .item { display: flex; align-items: center; gap: 6px; text-align: start; }
  img { width: 32px; height: 32px; object-fit: contain; }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 2px 6px; }
  time { color: #b8c3cc; }
</style>
