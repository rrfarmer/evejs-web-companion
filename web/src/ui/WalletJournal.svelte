<script lang="ts">
  // The wallet's Transactions tab (transactionsPanel.py; bridge/walletJournal.ts): each line of the pilot's journal for
  // the period chosen, the lines the client derives from an entry among them, by its date, its kind's name, its amount
  // (red less, green more), its balance and its description (FmtWalletEntry), the hint behind a description that has
  // one ("[r] " before it). Its type filter ("All Types" and the kinds the lines are of) and period ("Last 30 days" and
  // the five months before this one), its headers that sort, a hundred to a page. A player's donation has its two
  // parties' menus (Show Info using each owner's actual type).
  //
  // Read as the tab is shown, and again as a period is chosen, from what the account service keeps.
  //
  // Not done: the months' names are the page's own (the client's are label numbers 13 to 24, which the page cannot
  // look up); the description of a project's payout, which the client makes a link.
  import { onMount } from "svelte";
  import { formatTemplate, plainText, templateNameRefs } from "../bridge/clientWords.ts";
  import {
    JOURNAL_LINES_PER_PAGE, entryDescription, entryHint, entryNeeds, journalKindChoices, journalPeriods, ownerNameKind, walletAmount, type JournalLine,
  } from "../bridge/walletJournal.ts";
  import { resolvedName, type NameKind, type NameRef } from "../store/names.ts";
  import { showInfo, subjectOfShowInfoLink } from "./showInfo.ts";
  import { formatWalletCents } from "./isk.ts";
  import { walletShowsCents } from "./walletSettings.ts";
  import type { JsonValue } from "../bridge/wire.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";

  let { store, flow, corporate = false }: { store: ClientStore; flow: AppFlow; corporate?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  const read = corporate ? flow.corpWalletJournal : flow.walletJournal;
  // svelte-ignore state_referenced_locally
  const corpRead = flow.corpWalletJournal;
  // svelte-ignore state_referenced_locally
  const wallet = store.wallet;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const showCents = $derived(walletShowsCents($station.online?.characterID));

  const W = "UI/Wallet/WalletWindow";
  const DIVISION_WORDS = ["CorporateDivisionMasterWallet", "CorporateDivisionWalletSecond", "CorporateDivisionWalletThird", "CorporateDivisionWalletFourth", "CorporateDivisionWalletFifth", "CorporateDivisionWalletSixth", "CorporateDivisionWalletSeventh"].map(name => `UI/Corporations/Common/${name}`);
  const WORDS = {
    date: "UI/Common/Date",
    type: `${W}/ColHeaderType`,
    amount: `${W}/ColHeaderAmount`,
    balance: `${W}/ColHeaderBalance`,
    description: `${W}/ColHeaderDescription`,
    fmtDate: `${W}/FmtWalletDate`,
    isk: "UI/Util/FmtIskNoDecimal",
    allTypes: `${W}/AccountKeyAllTypes`,
    last30: `${W}/Last30Days`,
    none: `${W}/HintNoTransactionsFound`,
    extra: `${W}/HintExtraReference`,
    showing: `${W}/ShowingTransactions`,
    previous: "UI/Common/Previous",
    more: "UI/Common/ViewMore",
  } as const;
  const nameOf = (kind: NameKind, id: number): string => resolvedName($names.resolved, kind, id, "");
  const word = (label: string, own: string): string => {
    const template = $words.templates[label];
    return typeof template === "string" && template !== "" ? plainText(template) : own;
  };
  /** A label's or a message's words filled as the client fills them; null where they are not to hand. */
  const said = (label: string, args: Readonly<Record<string, JsonValue>>): string | null => {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf })) : null;
  };

  const journalMessageID = (entryTypeID: number): number | null => $read.journalMessageIDs?.[String(entryTypeID)] ?? null;
  const ctx = $derived({
    journalMessageID,
    said,
    ownerName: (id: number) => resolvedName($names.resolved, ownerNameKind(id), id, ""),
    locationName: (id: number) => nameOf(id >= 30_000_000 && id < 40_000_000 ? "system" : id >= 60_000_000 && id < 64_000_000 ? "station" : id >= 40_000_000 && id < 50_000_000 ? "planet" : "structure", id),
    typeName: (id: number) => nameOf("type", id),
  });

  // The words and names the lines need, asked for as the lines come.
  $effect(() => {
    const labels = new Set<string>([...Object.values(WORDS), ...(corporate ? DIVISION_WORDS : [])]);
    const refs: NameRef[] = [];
    for (const line of $read.lines) {
      const needs = entryNeeds(line, journalMessageID(line.entryTypeID));
      for (const label of needs.words) labels.add(label);
      refs.push(...needs.refs);
      const kind = $read.kinds.get(line.entryTypeID);
      if (kind?.nameID) labels.add(`#${kind.nameID}`);
    }
    flow.requestWords([...labels]);
    // A message's location tags name their places as the filler asks.
    for (const label of labels) {
      const template = $words.templates[label];
      if (typeof template !== "string" || !label.startsWith("#")) continue;
      for (const line of $read.lines) {
        if (`#${journalMessageID(line.entryTypeID)}` === label) refs.push(...templateNameRefs(template, { arg1: line.referenceID ?? 0 }));
      }
    }
    if (refs.length > 0) flow.requestNames(refs);
  });

  /** GetRefTypeKeyByID(entryTypeID).entryTypeName: the kind's name by its message, or the server's while that is not to hand. */
  function kindName(entryTypeID: number): string {
    const kind = $read.kinds.get(entryTypeID);
    const byMessage = kind?.nameID ? $words.templates[`#${kind.nameID}`] : undefined;
    return typeof byMessage === "string" && byMessage !== "" ? plainText(byMessage) : kind?.name ?? "";
  }
  const isk = (amount: number): string => showCents ? formatWalletCents(amount)
    : said(WORDS.isk, { amount: walletAmount(amount) }) ?? `${walletAmount(amount).toLocaleString("en-US")} ISK`;
  const dateText = (line: JournalLine): string => (line.transactionDate === null ? "" : said(WORDS.fmtDate, { dt: String(line.transactionDate) }) ?? "");
  // transactionsPanel._GetMenuForTransactionScrollEntity uses eveowners.typeID;
  // player corporations share the broad numeric range used by player characters.
  function ownerInfo(ownerID: number): void {
    menuFor = null;
    void flow.ownerEntryInfo(ownerID, (typeID, itemID) => {
      const subject = subjectOfShowInfoLink(`showinfo:${typeID}//${itemID}`);
      if (subject) showInfo(subject);
    }).catch(() => undefined);
  }

  interface Shown {
    readonly line: JournalLine;
    readonly description: string;
    readonly hint: string | null;
  }
  function shownOf(line: JournalLine): Shown {
    const description = entryDescription(line, ctx) ?? "";
    const hint = entryHint(line, ctx) ?? null;
    return { line, hint, description: hint ? said(WORDS.extra, { refText: description }) ?? `[r] ${description}` : description };
  }

  // The filters (IsTransactionVisible) and the period (the date combo).
  let kindChoice = $state(0);
  const periods = journalPeriods(new Date());
  let periodIndex = $state(0);
  const kinds = $derived(journalKindChoices($read.lines, kindName));
  function loadPeriod(): void {
    const period = periods[periodIndex] ?? periods[0]!;
    void (corporate ? flow.loadCorpWalletJournal($corpRead.accountKey, period.year, period.month)
      : flow.loadWalletJournal(period.year, period.month)).catch(() => undefined);
  }
  function choosePeriod(index: number): void {
    periodIndex = index;
    page = 0;
    loadPeriod();
  }
  function chooseAccount(accountKey: number): void {
    page = 0;
    const period = periods[periodIndex] ?? periods[0]!;
    void flow.loadCorpWalletJournal(accountKey, period.year, period.month).catch(() => undefined);
  }
  function divisionName(index: number): string {
    const given = index > 0 ? $wallet.corpDivisions?.find(division => division.key === 1000 + index)?.name : null;
    return given ?? word(DIVISION_WORDS[index]!, index === 0 ? "Master Wallet" : `Wallet Division ${index + 1}`);
  }
  const periodName = (index: number): string => {
    const period = periods[index]!;
    if (period.year === null || period.month === null) return word(WORDS.last30, "Last 30 days");
    return new Date(Date.UTC(period.year, period.month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  };

  // The sort (the headers): the newest first until a header is chosen, the date by (date, sortValue).
  type Column = "date" | "type" | "amount" | "balance" | "description";
  let sortBy = $state<Column>("date");
  let reverse = $state(true);
  function sortOn(column: Column): void {
    if (sortBy === column) reverse = !reverse;
    else {
      sortBy = column;
      reverse = false;
    }
    page = 0;
  }
  const shown = $derived.by(() => {
    const rows = $read.lines.filter((line) => !kindChoice || line.entryTypeID === kindChoice).map(shownOf);
    const keyOf = (row: Shown): readonly (bigint | number | string)[] => {
      switch (sortBy) {
        case "date": return [row.line.transactionDate ?? 0n, row.line.sortValue];
        case "type": return [kindName(row.line.entryTypeID)];
        case "amount": return [row.line.amount];
        case "balance": return [row.line.balance];
        default: return [row.description];
      }
    };
    const order = rows.map((row, index) => ({ row, index, key: keyOf(row) }));
    order.sort((a, b) => {
      for (let i = 0; i < a.key.length; i += 1) {
        const x = a.key[i]!;
        const y = b.key[i]!;
        if (x < y) return reverse ? 1 : -1;
        if (x > y) return reverse ? -1 : 1;
      }
      return a.index - b.index;
    });
    return order.map((entry) => entry.row);
  });
  let page = $state(0);
  const pageCount = $derived(Math.ceil(shown.length / JOURNAL_LINES_PER_PAGE));
  const onPage = $derived(shown.slice(page * JOURNAL_LINES_PER_PAGE, (page + 1) * JOURNAL_LINES_PER_PAGE));

  /** A player's donation's menu: its two parties (_GetMenuForTransactionScrollEntity). */
  let menuFor = $state<number | null>(null);
  const DONATION = 10;

  const HEADERS: readonly { readonly column: Column; readonly label: string; readonly own: string; readonly num?: boolean }[] = [
    { column: "date", label: WORDS.date, own: "Date" },
    { column: "type", label: WORDS.type, own: "Type" },
    { column: "amount", label: WORDS.amount, own: "Amount", num: true },
    { column: "balance", label: WORDS.balance, own: "Balance", num: true },
    { column: "description", label: WORDS.description, own: "Description" },
  ];

  onMount(() => {
    void (corporate ? flow.loadCorpWalletJournal() : flow.loadWalletJournal()).catch(() => undefined);
  });
</script>

<div class="wallet-journal">
  <p class="controls">
    {#if corporate}
      <select value={$corpRead.accountKey} aria-label="Wallet division" onchange={event => chooseAccount(Number(event.currentTarget.value))}>
        {#each DIVISION_WORDS as _label, index}
          <option value={1000 + index}>{divisionName(index)}</option>
        {/each}
      </select>
    {/if}
    <select bind:value={kindChoice} aria-label={word(WORDS.type, "Type")} onchange={() => { page = 0; if (corporate) loadPeriod(); }}>
      <option value={0}>{word(WORDS.allTypes, "All Types")}</option>
      {#each kinds as choice (choice.entryTypeID)}
        <option value={choice.entryTypeID}>{choice.name}</option>
      {/each}
    </select>
    <select value={periodIndex} aria-label={word(WORDS.date, "Date")} onchange={(event) => choosePeriod(Number((event.currentTarget as HTMLSelectElement).value))}>
      {#each periods as _period, index (index)}
        <option value={index}>{periodName(index)}</option>
      {/each}
    </select>
  </p>

  {#if $read.error}
    <p class="error">The read failed: {$read.error}</p>
  {:else if !$read.loaded}
    <p class="empty">Reading…</p>
  {:else if onPage.length === 0}
    <p class="empty">{word(WORDS.none, "No wallet activity yet.")}</p>
  {:else}
    <div class="table-wrap overflow-x-auto">
      <table class="guests reflow">
        <thead>
          <tr>
            {#each HEADERS as header (header.column)}
              <th class={header.num ? "num" : ""} aria-sort={sortBy === header.column ? (reverse ? "descending" : "ascending") : "none"}>
                <button type="button" class="journal-sort" onclick={() => sortOn(header.column)}>
                  {word(header.label, header.own)}{sortBy === header.column ? (reverse ? " ▼" : " ▲") : ""}
                </button>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each onPage as row (row.line.sortValue)}
            <tr title={row.hint ?? undefined}>
              <td data-label={word(WORDS.date, "Date")}>{dateText(row.line)}</td>
              <td data-label={word(WORDS.type, "Type")}>{kindName(row.line.entryTypeID)}</td>
              <td class="num {row.line.amount < 0 ? 'less' : 'more'}" data-label={word(WORDS.amount, "Amount")}>{isk(row.line.amount)}</td>
              <td class="num balance" data-label={word(WORDS.balance, "Balance")}>{isk(row.line.balance)}</td>
              <td data-label={word(WORDS.description, "Description")}>
                {row.description}
                {#if row.line.entryTypeID === DONATION && !row.line.derived}
                  <button type="button" class="minor" aria-label="The donation's menu" aria-expanded={menuFor === row.line.sortValue}
                    onclick={() => (menuFor = menuFor === row.line.sortValue ? null : row.line.sortValue)}>⋯</button>
                  {#if menuFor === row.line.sortValue}
                    <span class="journal-menu">
                      {#each [row.line.ownerID1, row.line.ownerID2] as ownerID, party (party)}
                        {#if ownerID > 0}
                          <button type="button" class="minor" onclick={() => ownerInfo(ownerID)}>{resolvedName($names.resolved, ownerNameKind(ownerID), ownerID, "")}</button>
                        {/if}
                      {/each}
                    </span>
                  {/if}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if pageCount > 1}
      <p class="controls">
        <button type="button" class="minor" disabled={page === 0} onclick={() => (page = Math.max(0, page - 1))}>{word(WORDS.previous, "Back")}</button>
        <button type="button" class="minor" disabled={page >= pageCount - 1} onclick={() => (page = Math.min(pageCount - 1, page + 1))}>{word(WORDS.more, "More")}</button>
        <span>{said(WORDS.showing, { numFirst: page * JOURNAL_LINES_PER_PAGE + 1, numLast: Math.min(shown.length, (page + 1) * JOURNAL_LINES_PER_PAGE), numTotal: shown.length }) ?? `${page * JOURNAL_LINES_PER_PAGE + 1} to ${Math.min(shown.length, (page + 1) * JOURNAL_LINES_PER_PAGE)} of ${shown.length}`}</span>
      </p>
    {/if}
  {/if}
</div>

<style>
  /* The client's colours (transactionsPanel.py 199 to 203): an amount less in its hot red and one more in its success
     green, the balance in white; as the page's own tokens that read in both themes. */
  .wallet-journal .less { color: var(--color-danger); }
  .wallet-journal .more { color: var(--color-good); }
  .wallet-journal .balance { color: var(--color-text-bright); }
  .wallet-journal .journal-menu { display: inline-flex; flex-wrap: wrap; gap: 0.25rem; margin-left: 0.25rem; }
  .wallet-journal .journal-sort { background: none; border: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
</style>
