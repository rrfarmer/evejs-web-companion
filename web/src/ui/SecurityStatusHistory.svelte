<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { securityStatusReason, type SecurityStatusTransaction } from "../bridge/securityStatusHistory.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import { ContextMenu } from "../play/contextMenu.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameRef } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";
  import { linkFollowerOf } from "./linkFollowers.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const reasonPath = "UI/Generic/FormatStandingTransactions/";
  const scrollPath = "UI/CharacterSheet/CharacterSheetWindow/SecurityStatusScroll/";
  const columns = [
    ["UI/Common/Date", "Date"],
    ["UI/Common/Change", "Change"],
    ["UI/CharacterSheet/CharacterSheetWindow/SecurityStatus", "Security Status"],
    [scrollPath + "Subject", "Subject"],
  ] as const;
  const detailLabel = "UI/Standings/TransactionWindow/Details";
  const detailsLabel = "UI/Common/Details";
  const closeLabel = "UI/Common/Buttons/Close";
  const emptyLabel = scrollPath + "NoSecurityStatusChanges";
  const changeLabel = scrollPath + "Persentage";
  const menu = new ContextMenu();
  const word = (label: string, fallback: string) => $words.templates[label] || fallback;
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, label => word(label, ""), text);
  const context = $derived({ nameOf: (kind: NameRef["kind"], id: number) => resolvedName($names.resolved, kind, id, "") });
  let rows = $state.raw<readonly SecurityStatusTransaction[] | null>(null);
  let selected = $state.raw<SecurityStatusTransaction | null>(null);
  let error = $state("");
  let sortColumn = $state(0);
  let descending = $state(false);
  let modal: HTMLDialogElement | undefined = $state();

  function subject(row: SecurityStatusTransaction) {
    const [suffix, fallback] = securityStatusReason(row.eventTypeID);
    return plainText(word(reasonPath + "subject" + suffix, fallback));
  }
  function body(row: SecurityStatusTransaction) {
    const [suffix, , fallback] = securityStatusReason(row.eventTypeID);
    const owner = row.otherOwnerID === null ? "" : context.nameOf("owner", row.otherOwnerID);
    const label = row.eventTypeID === 380 || row.eventTypeID === 386 ? "ResetBySlashCmd" : suffix;
    return formatTemplate(word(reasonPath + "message" + label, fallback),
      { name: owner, ownerName: owner, locationID: row.locationID, typeID: row.otherTypeID }, context);
  }
  function change(row: SecurityStatusTransaction) {
    if (row.modification === null) return "";
    return plainText(formatTemplate(word(changeLabel, "{[numeric]value, decimalPlaces=4}%"),
      { value: row.modification * 100, decimalPlaces: 4 }, context));
  }
  const ordered = $derived.by(() => {
    const sortKey = (row: SecurityStatusTransaction) =>
      sortColumn === 0 ? row.eventDate : sortColumn === 1 ? row.modification ?? 0 : sortColumn === 2 ? row.newValue : subject(row);
    return [...(rows ?? [])].sort((a, b) => {
      const left = sortKey(a), right = sortKey(b);
      const comparison = typeof left === "string" && typeof right === "string" ? left.localeCompare(right)
        : left < right ? -1 : left > right ? 1 : 0;
      return descending ? -comparison : comparison;
    });
  });

  onMount(() => {
    let active = true;
    flow.requestWords([...columns.map(([label]) => label), detailLabel, detailsLabel, closeLabel, emptyLabel, changeLabel]);
    void flow.securityStatusHistory().then(result => {
      if (!active) return;
      const labels = new Set<string>(), refs: NameRef[] = [];
      for (const row of result) {
        const [suffix] = securityStatusReason(row.eventTypeID);
        if (suffix) {
          labels.add(reasonPath + "subject" + suffix);
          labels.add(reasonPath + "message" + (suffix === "SetBySlashCmd" ? "ResetBySlashCmd" : suffix));
        }
        if (row.otherOwnerID) refs.push({ kind: "owner", id: row.otherOwnerID });
        if (row.otherTypeID) refs.push({ kind: "type", id: row.otherTypeID });
        if (row.locationID) refs.push({ kind: "system", id: row.locationID });
      }
      flow.requestWords([...labels]);
      flow.requestNames(refs);
      rows = result;
    }).catch(cause => { if (active) error = panelErrorWords(cause); });
    return () => { active = false; menu.close(); };
  });

  async function open(row: SecurityStatusTransaction) {
    selected = row;
    await tick();
    if (modal && !modal.open) modal.showModal();
  }
  function contextDetails(event: MouseEvent, row: SecurityStatusTransaction) {
    event.preventDefault();
    menu.open(event.clientX, event.clientY, [{ label: word(detailsLabel, "Details"), run: () => void open(row) }]);
  }
</script>

<section class="security-history" aria-label={word(columns[2][0], columns[2][1])}>
  {#if error}<p role="alert">{error}</p>
  {:else if rows === null}<p role="status">Loading security status history…</p>
  {:else if !rows.length}<p>{word(emptyLabel, "No Security Status Changes Found")}</p>
  {:else}
    <table>
      <thead><tr>{#each columns as [label, fallback], column (label)}
        <th aria-sort={sortColumn === column ? (descending ? "descending" : "ascending") : "none"}>
          <button type="button" onclick={() => {
            descending = sortColumn === column && !descending;
            sortColumn = column;
          }}>{word(label, fallback)}</button>
        </th>
      {/each}</tr></thead>
      <tbody>
        {#each ordered as row}
          <tr data-security-event={row.eventTypeID} title={`${row.newValue.toFixed(4)}\n${subject(row)}`}
            ondblclick={() => void open(row)} oncontextmenu={event => contextDetails(event, row)}>
            <td>{plainText(formatTemplate("{[datetime]datetime}", { datetime: row.eventDate.toString() }, context))}</td>
            <td class="number">{change(row)}</td>
            <td class="number">{row.newValue.toFixed(2)}</td>
            <td><button type="button" onclick={() => void open(row)}>{subject(row)}</button></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

{#if selected}
  <dialog bind:this={modal} aria-label={word(detailLabel, "Transaction Details")} onclose={() => { selected = null; }}>
    <strong>{word(detailLabel, "Transaction Details")}</strong>
    <LabelText markup={body(selected)} {followerOf} />
    <form method="dialog"><button type="submit">{word(closeLabel, "Close")}</button></form>
  </dialog>
{/if}

<style>
  table { width: 100%; border-collapse: collapse; text-align: left; }
  td, th { padding: 0.25rem 0.4rem; border-bottom: 1px solid var(--color-line); }
  th { white-space: nowrap; }
  .number { text-align: right; font-variant-numeric: tabular-nums; }
  table button { background: none; border: 0; padding: 0; text-align: left; color: inherit; }
  table button:hover { text-decoration: underline; }
  dialog { color: var(--color-text); background: var(--color-panel, #181e23); border: 1px solid var(--color-line);
    max-width: min(460px, 90vw); padding: 1rem; }
  dialog strong { display: block; margin-bottom: 0.7rem; }
  form { display: flex; justify-content: flex-end; margin-top: 0.8rem; }
</style>
