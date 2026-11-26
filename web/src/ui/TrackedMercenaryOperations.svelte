<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { mercenaryDenNotice, type MercenaryDenActivity } from "../bridge/mercenaryDens.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { setMercenaryOperationTracked, trackedJobsChanged, trackedMercenaryOperations } from "./jobTracking.ts";
  import { openMercenaryOperation } from "./jobBoardRequests.ts";

  let { store, flow, onCount }: { store: ClientStore; flow: AppFlow; onCount: (count: number) => void } = $props();
  const station = $derived(store.station);
  const words = $derived(store.words);
  const character = $derived($station.online?.characterID ?? null);
  const tracked = $derived.by(() => {
    void $trackedJobsChanged;
    return trackedMercenaryOperations(character);
  });
  const labels = {
    operation: ["UI/Sovereignty/MercenaryDen/ConfigurationWindow/ActivitiesTitle", "Mercenary Tactical Operations"],
    ready: ["UI/Agency/MercDen/ReadyToStart", "Ready to Start"],
    started: ["UI/Agency/MercDen/InProgress", "In Progress"],
    view: ["UI/Opportunities/ViewOpportunity", "View Opportunity"],
    untrack: ["UI/Common/Untrack", "Untrack"],
  } as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  let operations = $state.raw<readonly MercenaryDenActivity[]>([]);
  let operationsPilot: number | null = null;
  let revision = $state(0);
  const trackedOperations = $derived(operations.filter(row => Object.hasOwn(tracked, row.id))
    .sort((left, right) => tracked[left.id]! - tracked[right.id]!));
  function nameOf(row: MercenaryDenActivity): string {
    const index = operations.filter(operation => operation.denID === row.denID).findIndex(operation => operation.id === row.id);
    return plainText($words.templates[`#${row.nameID}`] ?? "") || `${word("operation")} ${index + 1}`;
  }

  $effect(() => {
    const notices = flow.gatewayNotices;
    let lastSeen = notices.get()?.n;
    return notices.subscribe(notice => {
      if (!notice || notice.n === lastSeen) return;
      lastSeen = notice.n;
      if (mercenaryDenNotice(notice.typeName, notice.payload)?.operations) revision++;
    });
  });
  $effect(() => {
    const pilot = character;
    const ids = Object.keys(tracked);
    void revision;
    if (pilot !== operationsPilot || !ids.length) {
      operations = [];
      operationsPilot = pilot;
    }
    if (!pilot || !ids.length) return;
    flow.requestWords(Object.values(labels).map(([path]) => path));
    let current = true;
    void flow.loadMercenaryOperations().then(rows => {
      if (!current) return;
      const now = Date.now();
      operations = rows.filter(row => !row.expiresAt || row.expiresAt > now);
      for (const id of ids) {
        if (!operations.some(row => row.id === id)) setMercenaryOperationTracked(pilot, id, false);
      }
    }, () => {});
    return () => { current = false; };
  });
  $effect(() => { onCount(trackedOperations.length); });
</script>

{#each trackedOperations as operation (operation.id)}
  <article class="mto-tracker-entry" data-operation={operation.id}>
    <button class="mto-tracker-name" type="button" title={word("view")} onclick={() => openMercenaryOperation(operation.id)}>
      {nameOf(operation)}
    </button>
    <small>{word(operation.started ? "started" : "ready")}</small>
    <button class="mto-tracker-untrack" type="button" onclick={() => setMercenaryOperationTracked(character, operation.id, false)}>
      {word("untrack")}
    </button>
  </article>
{/each}

<style>
  .mto-tracker-entry { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 8px;
    padding: 7px 8px; margin-bottom: 2px; background: rgb(0 0 0 / 0.25); }
  .mto-tracker-name { grid-column: 1 / -1; justify-self: start; max-width: 100%; padding: 0; border: 0;
    background: none; color: inherit; text-align: left; }
  .mto-tracker-name:hover { text-decoration: underline; }
  small { color: #b8c3cc; }
  .mto-tracker-untrack { padding: 2px 5px; }
</style>
