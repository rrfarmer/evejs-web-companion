<script lang="ts">
  // Contracts page (goal R17, Slice B): the public delivery-job board, the
  // player's own contracts, and one contract in full.
  //
  // A pure reader of the store's contracts slice. Every identifier is
  // translated to a name in bridge/contracts.ts or resolved through the shared
  // name cache before it reaches this file. Nothing here shows a contractID, a
  // stationID, a systemID or a characterID (R7d) — a contract is identified by
  // who issued it, where it runs from and to, and what it pays. ISK is
  // formatted from decimal strings by `formatIsk`, never JS numbers, because it
  // exceeds 2^53 in ordinary play.
  //
  // ⚠ THE BOARD IS EXPECTED TO BE EMPTY, AND THE PANEL SAYS SO. EveJS has no
  // NPC/seed contract generator, so nothing exists to find until a player
  // creates a contract. That is a fact about this world, not a failure, and it
  // is stated plainly — and only when the browse actually SUCCEEDED and
  // returned nothing, never when it failed.
  //
  // ⚠ "OFFERED TO YOU" IS A LIST THE OTHER THREE CANNOT HOLD. A contract
  // someone reserved for you is not on the public board (it is not public), not
  // in "waiting" (that is what YOU issued) and not in "taken on" (nobody has
  // taken it yet). It used to be counted in the summary line and shown nowhere,
  // which read as a broken page. Its own tab is the whole fix.
  //
  // The one WRITE here is taking a contract on. It moves ISK and items and
  // cannot be undone, so it asks first, on a screen that says what changes
  // hands, and the button is dead while the write is in flight.
  import { getContext, onMount } from "svelte";
  import {
    CONTRACT_STATUS_OUTSTANDING,
    CONTRACT_TYPE_COURIER,
    CONTRACT_TYPE_ITEM_EXCHANGE,
    contractStatusLabel,
    contractTypeLabel,
    formatIsk,
    formatVolume,
    contractTitle,
    CONTRACT_TITLE_LABELS,
    type ContractSearchEntry,
  } from "../bridge/contracts.ts";
  import { contractsSearchTarget } from "./contractsSearch.ts";
  import type { JsonValue } from "../bridge/wire.ts";
  import { isSessionLost } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ContractRow } from "../store/types.ts";
  import { resolvedName } from "../store/names.ts";
  import PlaceRouteMenu from "./PlaceRouteMenu.svelte";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();

  // svelte-ignore state_referenced_locally
  const contracts = store.contracts;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;

  // A search's row says how far away the contract is and, for a courier, how long its route is, both by the
  // autopilot's route with the pilot's settings (contractsearch.py 1402 to 1419: GetAutopilotJumpCount; the words,
  // contractentry.py 476 to 487 and 740 to 748).
  const JUMP_WORDS = {
    currentStation: "UI/Generic/CurrentStation",
    currentSystem: "UI/Generic/CurrentSystem",
    oneJumpAway: "UI/Contracts/OneJumpAway",
    jumpsAway: "UI/Contracts/ContractEntry/NumJumpsAway",
    noRoute: "UI/Generic/NoGateToGateRoute",
    sameSystem: "UI/Contracts/ContractEntry/SameSystem",
    nextSystem: "UI/Contracts/ContractEntry/NextSystem",
    jumps: "UI/Contracts/ContractEntry/NumJumps",
  } as const;
  function jumpWords(label: string, own: string, args: Record<string, number> = {}): string {
    const template = $words.templates[label];
    return typeof template === "string" ? plainText(formatTemplate(template, args, { nameOf: () => "" })) : own;
  }
  const hereSystem = $derived($flight.status?.solarSystemID ?? null);
  const hereStation = $derived($flight.status?.stationID ?? $flight.status?.structureID ?? null);
  type JumpLine = { readonly text: string; readonly unreachable: boolean };
  const noRouteLine = (): JumpLine => ({ text: jumpWords(JUMP_WORDS.noRoute, "No route").toUpperCase(), unreachable: true });
  /** numJumpsTxt: from where the pilot is to where the contract starts; null where nothing is said, or not known yet. */
  function jumpsAway(row: ContractRow): JumpLine | null {
    if (hereStation !== null && row.startStationID === hereStation) return { text: jumpWords(JUMP_WORDS.currentStation, "Here"), unreachable: false };
    if (hereSystem !== null && row.startSolarSystemID === hereSystem) return { text: jumpWords(JUMP_WORDS.currentSystem, "In this system"), unreachable: false };
    if (hereSystem === null) return null;
    const count = $names.autopilotJumps[`${hereSystem}:${row.startSolarSystemID}`];
    if (count === undefined || count === 0) return null;
    if (count === null) return noRouteLine();
    return count === 1
      ? { text: jumpWords(JUMP_WORDS.oneJumpAway, "1 jump off"), unreachable: false }
      : { text: jumpWords(JUMP_WORDS.jumpsAway, `${count} jumps off`, { numJumps: count }), unreachable: false };
  }
  /** A courier's route length, from where it starts to where it ends; null for any other contract, or not known yet. */
  function routeLength(row: ContractRow): JumpLine | null {
    if (row.type !== CONTRACT_TYPE_COURIER || row.startSolarSystemID <= 0 || row.endSolarSystemID <= 0) return null;
    const count = row.startSolarSystemID === row.endSolarSystemID ? 0 : $names.autopilotJumps[`${row.startSolarSystemID}:${row.endSolarSystemID}`];
    if (count === undefined) return null;
    if (count === null) return noRouteLine();
    if (count === 0) return { text: jumpWords(JUMP_WORDS.sameSystem, "Same system"), unreachable: false };
    return count === 1
      ? { text: jumpWords(JUMP_WORDS.nextSystem, "Next system"), unreachable: false }
      : { text: jumpWords(JUMP_WORDS.jumps, `${count} jumps`, { numJumps: count }), unreachable: false };
  }
  $effect(() => {
    flow.requestWords([...Object.values(JUMP_WORDS), ...Object.values(SEARCH_WORDS), ...CONTRACT_TITLE_LABELS, ...RETAIL_TAB_WORDS]);
  });
  // The counts are asked for again when the autopilot's settings change, which lets them go.
  $effect(() => {
    void $names.autopilotJumps;
    const rows = $contracts.browse;
    if (hereSystem !== null) {
      const starts = [...new Set(rows.map((row) => row.startSolarSystemID).filter((id) => id > 0 && id !== hereSystem))];
      if (starts.length > 0) flow.requestAutopilotJumps(hereSystem, starts);
    }
    for (const row of rows) {
      if (row.type === CONTRACT_TYPE_COURIER && row.startSolarSystemID > 0 && row.endSolarSystemID > 0 && row.startSolarSystemID !== row.endSolarSystemID) {
        flow.requestAutopilotJumps(row.startSolarSystemID, [row.endSolarSystemID]);
      }
    }
  });

  let busy = $state(false);
  let error = $state("");
  // ⚠ THE PANEL OPENS ON WHAT IS WAITING FOR THE PLAYER. A contract somebody
  // reserved for you needs a decision; the public board, in a world with no
  // contract generator, is usually empty. So the DEFAULT tab follows the
  // contracts offered to you — but only until the player picks a tab
  // themselves, after which their choice wins and stops moving under them.
  let chosenTab = $state<"board" | "mine" | "search" | null>(null);
  // The window's Contract Search tab (contractsWnd.py 100: its third; contractsearch.py's results), as far as the page
  // has it: the contracts of a type found by the type menu's Find in Contracts (contracts.FindRelated).
  /**
   * The play page's windows (PlayApp's "retailChrome"): the window's tabs as contractsWnd.ContractsWindow.LoadTabs
   * has them in its header - the start page (its caption, Tooltips/Neocom/Contracts: here the summary and the jobs
   * on offer), My Contracts, Contract Search, in that order.
   */
  const retail = getContext("retailChrome") === true;
  const RETAIL_TAB_WORDS = ["Tooltips/Neocom/Contracts", "UI/Contracts/ContractsWindow/MyContracts"];
  const SEARCH_WORDS = {
    tab: "UI/Contracts/ContractsSearch/ContractSearch",
    contract: "UI/Contracts/ContractsSearch/columnContract",
    location: "UI/Contracts/ContractsSearch/columnLocation",
    price: "UI/Contracts/ContractsSearch/columnPrice",
    issuer: "UI/Contracts/ContractsSearch/columnIssuer",
    nothingFound: "UI/Common/NothingFound",
    auction: "UI/Contracts/Auction",
  } as const;
  let searchedType = $state<number | null>(null);
  let searching = $state(false);
  let searchFound = $state.raw<{ readonly entries: readonly ContractSearchEntry[]; readonly numFound: number } | null>(null);
  function searchType(typeID: number): void {
    chosenTab = "search";
    searchedType = typeID;
    searchFound = null;
    void run(async () => {
      searching = true;
      try {
        searchFound = await flow.findContractsOfType(typeID);
      } finally {
        searching = false;
      }
    });
  }
  // A search asked for from outside (contractsSearch.ts): the Contract Search tab, searching the type.
  // svelte-ignore state_referenced_locally
  const contractsSearchRequests = contractsSearchTarget.requests;
  $effect(() => {
    void $contractsSearchRequests;
    const wanted = contractsSearchTarget.take();
    if (wanted !== null) searchType(wanted);
  });
  /** A label of the client's filled, for a contract's title (GetContractTitle); the page's own words where it has none. */
  function titleWord(label: string, args: Readonly<Record<string, JsonValue>> = {}): string {
    const template = $words.templates[label];
    if (typeof template === "string" && template !== "") {
      return plainText(formatTemplate(template, args, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
    }
    const typeID = Number(args.typeID ?? 0);
    if (label.endsWith("/TypeNameWithQuantity")) return `${itemName(typeID)} x ${String(args.quantity ?? "")}`;
    if (label.endsWith("/TypeName")) return itemName(typeID);
    if (label === "UI/Common/MoreTrail") return "...";
    if (label === "UI/Common/Unknown") return "unknown";
    return "";
  }
  /** ContractEntrySearch.GetContractLabel (499 to 512): the title, and "(auction)" after an auction's. */
  function searchLabel(entry: ContractSearchEntry): string {
    const title = contractTitle(entry.contract, entry.items, titleWord);
    return entry.contract.type === 2 ? `${title} (${titleWord(SEARCH_WORDS.auction).toLowerCase() || "auction"})` : title;
  }
  let chosenMineView = $state<"assigned" | "outstanding" | "accepted" | "expired" | null>(
    null,
  );
  /**
   * Is there anything to SAY on the offered-to-you tab? A row, obviously — but
   * a failed read and a summary count with no rows behind it both belong there
   * too, and landing on the board would hide either one completely.
   */
  const somethingOffered = $derived(
    $contracts.assigned.length > 0 ||
      $contracts.assignedError !== null ||
      ($contracts.summary?.assignedToMe ?? 0) > 0,
  );
  const tab = $derived(chosenTab ?? (somethingOffered ? "mine" : "board"));
  const mineView = $derived(chosenMineView ?? (somethingOffered ? "assigned" : "outstanding"));
  /** True once the player has asked to see the take-it-on confirmation step. */
  let confirmingAccept = $state(false);

  /** Always a NAME, never an id — and never an id-shaped fallback either. */
  function stationName(stationID: number): string {
    return resolvedName($names.resolved, "station", stationID, "an unnamed station");
  }

  function systemName(systemID: number): string {
    return resolvedName($names.resolved, "system", systemID, "an unnamed system");
  }

  function personName(characterID: number): string {
    return resolvedName($names.resolved, "character", characterID, "someone");
  }

  function ownerName(ownerID: number): string {
    return resolvedName($names.resolved, "owner", ownerID, "someone");
  }

  function itemName(typeID: number): string {
    return resolvedName($names.resolved, "type", typeID, "an unnamed item");
  }

  /** A retail FILETIME as a plain date. Never rendered as a number. */
  function dateText(filetime: bigint | null): string {
    if (filetime === null) {
      return "—";
    }
    const unixMs = Number(filetime / 10000n - 11644473600000n);
    if (!Number.isFinite(unixMs) || unixMs <= 0) {
      return "—";
    }
    return new Date(unixMs).toLocaleDateString();
  }

  /** The headings a contract row's menu gives its stations (contractentry.py 76 to 81). */
  const PICK_UP_HEADING = { label: "UI/Contracts/ContractEntry/PickupStation", own: "Collect from" } as const;
  const DROP_OFF_HEADING = { label: "UI/Contracts/ContractEntry/DropOffStation", own: "Deliver to" } as const;

  const mineRows = $derived(
    mineView === "assigned"
      ? $contracts.assigned
      : mineView === "outstanding"
        ? $contracts.outstanding
        : mineView === "accepted"
          ? $contracts.accepted
          : $contracts.expired,
  );

  const mineCount = $derived(
    $contracts.assigned.length +
      $contracts.outstanding.length +
      $contracts.accepted.length +
      $contracts.expired.length,
  );

  /** The contract currently open in full, or null when the pane is closed. */
  const openContractRow = $derived($contracts.detail?.contract ?? null);

  /**
   * Can the open contract be taken on?
   *
   * Decided from WHERE it came from, never from a guess at who this character
   * is: the board holds contracts anyone may take, and the offered-to-you list
   * holds the ones reserved for this character. A contract reached from
   * "waiting" or "taken on" is the player's own business and gets no button.
   * The server guards this too — it refuses a contract you may not accept, and
   * your own unassigned one outright — so this decides only what to OFFER,
   * never what is allowed.
   */
  const canAccept = $derived(
    openContractRow !== null &&
      openContractRow.status === CONTRACT_STATUS_OUTSTANDING &&
      openContractRow.acceptorID === null &&
      [...$contracts.browse, ...$contracts.assigned].some(
        (row) => row.contractID === openContractRow.contractID,
      ),
  );

  /** True while THIS contract's accept is in flight. */
  const acceptingOpen = $derived(
    openContractRow !== null && $contracts.accepting === openContractRow.contractID,
  );

  const justAccepted = $derived(
    openContractRow !== null && $contracts.acceptedContractID === openContractRow.contractID,
  );

  async function run(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = isSessionLost(cause)
        ? "Your session ended. Pick your character again."
        : cause instanceof Error
          ? cause.message
          : String(cause);
    } finally {
      busy = false;
    }
  }

  function open(contractID: number): void {
    confirmingAccept = false;
    void run(() => flow.openContract(contractID));
  }

  /**
   * Take on the contract that is OPEN. It reads the id back off the store
   * rather than closing over one, so the click can never fire against a
   * contract other than the one whose terms are on screen.
   */
  function acceptOpenContract(): void {
    const contractID = $contracts.detail?.contract.contractID ?? 0;
    if (contractID <= 0) {
      return;
    }
    confirmingAccept = false;
    void run(() => flow.acceptContract(contractID));
  }

  onMount(() => {
    void run(() => flow.loadContracts(0));
  });
</script>

<!-- Where a contract runs, in words: its station, and the drop-off where it has one. Each has its route entries under
     the heading the client's row menu gives it (contractentry.py 76 to 81): the pick-up where there is one, the
     drop-off where it is another station. -->
{#snippet routeCell(row: ContractRow, searched = false)}
  <td data-label="Route">
    {stationName(row.startStationID)}
    {#if row.startStationID > 0}<PlaceRouteMenu {store} {flow} placeID={row.startStationID} heading={PICK_UP_HEADING} />{/if}
    {#if row.endStationID > 0}
      → {stationName(row.endStationID)}
      {#if row.endStationID !== row.startStationID}<PlaceRouteMenu {store} {flow} placeID={row.endStationID} heading={DROP_OFF_HEADING} />{/if}
    {/if}
    {#if searched}
      {@const away = jumpsAway(row)}
      {@const length = routeLength(row)}
      {#if away || length}
        <!-- The search's jumps (how far off it starts) and route (how far it goes), the autopilot's way. -->
        <span class="contract-jumps">
          {#if away}<span class:contract-unreachable={away.unreachable}>{away.text}</span>{/if}
          {#if away && length} · {/if}
          {#if length}<span class:contract-unreachable={length.unreachable}>{length.text}</span>{/if}
        </span>
      {/if}
    {/if}
  </td>
{/snippet}

<section class="panel">
  <header class="panel-head">
    <h2 class="panel-title">Contracts</h2>
    <p class="controls">
      <button type="button" class="primary" disabled={busy} onclick={() => void run(() => flow.loadContracts(0))}>
        Refresh
      </button>
    </p>
  </header>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if $contracts.summary && ($contracts.summary.needsAttention > 0 || $contracts.summary.inProgress > 0 || $contracts.summary.assignedToMe > 0)}
    <p class="note">
      {#if $contracts.summary.needsAttention > 0}
        {$contracts.summary.needsAttention} need your attention.
      {/if}
      {#if $contracts.summary.inProgress > 0}
        {$contracts.summary.inProgress} in progress.
      {/if}
      {#if $contracts.summary.assignedToMe > 0}
        {$contracts.summary.assignedToMe} waiting for you.
      {/if}
    </p>
  {/if}

  {#if retail}
  <nav class="tabs con-tabs">
    <button type="button" class:active={tab === "board"} onclick={() => (chosenTab = "board")}>{titleWord("Tooltips/Neocom/Contracts") || "Contracts"}</button>
    <button type="button" class:active={tab === "mine"} onclick={() => (chosenTab = "mine")}>{titleWord("UI/Contracts/ContractsWindow/MyContracts") || "My Contracts"}{mineCount > 0 ? ` (${mineCount})` : ""}</button>
    <button type="button" class:active={tab === "search"} onclick={() => (chosenTab = "search")}>{titleWord(SEARCH_WORDS.tab) || "Contract Search"}</button>
  </nav>
  {:else}
  <nav class="tabs">
    <button type="button" class:active={tab === "board"} onclick={() => (chosenTab = "board")}>
      Jobs on offer
    </button>
    <button type="button" class:active={tab === "search"} onclick={() => (chosenTab = "search")}>
      {titleWord(SEARCH_WORDS.tab) || "Contract search"}
    </button>
    <button type="button" class:active={tab === "mine"} onclick={() => (chosenTab = "mine")}>
      Yours{mineCount > 0 ? ` (${mineCount})` : ""}
    </button>
  </nav>
  {/if}

  {#if tab === "board"}
    {#if !$contracts.loaded}
      <p class="note">Looking for jobs…</p>
    {:else if $contracts.browseError}
      <!-- A FAILED browse. Deliberately worded differently from an empty one:
           "nothing was found" and "nothing could be looked up" are different
           facts and the player must be able to tell them apart. -->
      <p class="error">
        The job board could not be loaded just now, so there may be jobs you
        cannot see. Try again in a moment.
      </p>
    {:else if $contracts.worldHasNoContracts}
      <!-- ⚠ EXPECTED, NOT AN ERROR. Nobody has created a contract in this
           world yet, and there is no system that creates them automatically.
           Said plainly so the empty page reads as a fact, not a fault. -->
      <p class="note">
        There are no public delivery jobs in this world yet. Jobs appear here
        once a player creates one — nothing posts them automatically.
      </p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Issued by</th>
              <th>Route</th>
              <th class="num">Pays</th>
              <th class="num">You must cover</th>
              <th class="num">Cargo</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each $contracts.browse as row (row.contractID)}
              <tr>
                <td data-label="Issued by">{personName(row.issuerID)}</td>
                {@render routeCell(row, true)}
                <td class="num" data-label="Pays">{formatIsk(row.reward)}</td>
                <td class="num" data-label="You must cover">{formatIsk(row.collateral)}</td>
                <td class="num" data-label="Cargo">{formatVolume(row.volume)}</td>
                <td data-label="Expires">{dateText(row.dateExpired)}</td>
                <td data-label="">
                  <div class="row-actions">
                    <button type="button" disabled={busy} onclick={() => open(row.contractID)}>
                      See details
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if $contracts.numFound > $contracts.browse.length}
        <p class="note">
          Showing the first {$contracts.browse.length} of {$contracts.numFound} jobs.
        </p>
      {/if}
    {/if}
  {:else if tab === "search"}
    {#if searchedType === null}
      <p class="note">A type's menu finds its contracts here (Find in Contracts).</p>
    {:else if searching || searchFound === null}
      <p class="note">Looking for contracts of {itemName(searchedType)}…</p>
    {:else if searchFound.entries.length === 0}
      <p class="note">{titleWord(SEARCH_WORDS.nothingFound) || "Nothing found"}</p>
    {:else}
      <!-- ContractEntrySearchItemExchange and ContractEntrySearchAuction (645 to 711): the contract's name, where it is,
           its price (an auction's: the price, with no bids here), who issued it, when it ends. -->
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>{titleWord(SEARCH_WORDS.contract) || "Contract"}</th>
              <th>{titleWord(SEARCH_WORDS.location) || "Where"}</th>
              <th class="num">{titleWord(SEARCH_WORDS.price) || "Price"}</th>
              <th>{titleWord(SEARCH_WORDS.issuer) || "Issued by"}</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each searchFound.entries as entry (entry.contract.contractID)}
              <tr>
                <td data-label="Contract">{searchLabel(entry)}</td>
                <td data-label="Where">{systemName(entry.contract.startSolarSystemID)}</td>
                <td class="num" data-label="Price">{formatIsk(entry.contract.price)}</td>
                <td data-label="Issued by">{entry.contract.forCorp ? ownerName(entry.contract.issuerCorpID) : personName(entry.contract.issuerID)}</td>
                <td data-label="Expires">{dateText(entry.contract.dateExpired)}</td>
                <td data-label="">
                  <div class="row-actions">
                    <button type="button" disabled={busy} onclick={() => open(entry.contract.contractID)}>See details</button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if searchFound.numFound > searchFound.entries.length}
        <p class="note">Showing the first {searchFound.entries.length} of {searchFound.numFound}.</p>
      {/if}
    {/if}
  {:else}
    <nav class="tabs">
      <!-- FIRST, and first on purpose: this is the list the summary line's
           "waiting for you" count refers to, and it is the only one holding a
           contract somebody handed to this character. -->
      <button
        type="button"
        class:active={mineView === "assigned"}
        onclick={() => (chosenMineView = "assigned")}
      >
        Offered to you ({$contracts.assigned.length})
      </button>
      <button
        type="button"
        class:active={mineView === "outstanding"}
        onclick={() => (chosenMineView = "outstanding")}
      >
        Waiting ({$contracts.outstanding.length})
      </button>
      <button
        type="button"
        class:active={mineView === "accepted"}
        onclick={() => (chosenMineView = "accepted")}
      >
        Taken on ({$contracts.accepted.length})
      </button>
      <button
        type="button"
        class:active={mineView === "expired"}
        onclick={() => (chosenMineView = "expired")}
      >
        Expired ({$contracts.expired.length})
      </button>
    </nav>

    {#if $contracts.mineError}
      <p class="error">
        Some of your contracts could not be loaded, so this list may be
        incomplete.
      </p>
    {/if}

    {#if mineView === "assigned" && $contracts.assignedError}
      <p class="error">
        Some of the contracts offered to you could not be loaded, so this list
        may be incomplete.
      </p>
    {/if}

    {#if mineView === "assigned" && $contracts.numAssigned > $contracts.assigned.length && !$contracts.assignedError}
      <p class="note">
        Showing {$contracts.assigned.length} of the {$contracts.numAssigned}
        contracts offered to you.
      </p>
    {/if}

    {#if !$contracts.loaded}
      <p class="note">Looking up your contracts…</p>
    {:else if mineRows.length === 0 && mineView === "assigned" && $contracts.assignedError}
      <!-- ⚠ DELIBERATELY NOTHING. The error above already says the look-up
           broke. Adding "nobody has offered you a contract" underneath it would
           state as fact the very thing that could not be established. -->
    {:else if mineRows.length === 0}
      <p class="note">
        {mineView === "assigned"
          ? "Nobody has offered you a contract."
          : mineView === "outstanding"
            ? "You have no contracts waiting."
            : mineView === "accepted"
              ? "You have not taken on any contracts."
              : "You have no expired contracts."}
      </p>
    {:else}
      <div class="table-wrap overflow-x-auto">
        <table class="guests reflow">
          <thead>
            <tr>
              <th>Kind</th>
              <!-- On the offered-to-you tab, WHO offered it is the first thing
                   worth knowing; on your own contracts you are the issuer, so
                   the column would say your own name in every row. -->
              {#if mineView === "assigned"}
                <th>Issued by</th>
              {/if}
              <th>Route</th>
              <th class="num">Pays</th>
              {#if mineView === "assigned"}
                <th class="num">You must cover</th>
              {/if}
              <th>Status</th>
              <th>{mineView === "assigned" ? "Expires" : "Issued"}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each mineRows as row (row.contractID)}
              <tr>
                <td data-label="Kind">{contractTypeLabel(row.type)}</td>
                {#if mineView === "assigned"}
                  <td data-label="Issued by">{personName(row.issuerID)}</td>
                {/if}
                {@render routeCell(row)}
                <td class="num" data-label="Pays">{formatIsk(row.reward ?? row.price)}</td>
                {#if mineView === "assigned"}
                  <td class="num" data-label="You must cover">{formatIsk(row.collateral)}</td>
                {/if}
                <td data-label="Status">{contractStatusLabel(row.status)}</td>
                {#if mineView === "assigned"}
                  <td data-label="Expires">{dateText(row.dateExpired)}</td>
                {:else}
                  <td data-label="Issued">{dateText(row.dateIssued)}</td>
                {/if}
                <td data-label="">
                  <div class="row-actions">
                    <button type="button" disabled={busy} onclick={() => open(row.contractID)}>
                      See details
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}

  {#if $contracts.detailError}
    <p class="error">{$contracts.detailError}</p>
  {/if}

  {#if $contracts.detail !== null}
    <section class="bulk">
      <h2>{$contracts.detail.contract.title || contractTypeLabel($contracts.detail.contract.type)}</h2>
      <div class="table-wrap overflow-x-auto">
        <table class="guests">
          <tbody>
            <tr>
              <th>Kind</th>
              <td>{contractTypeLabel($contracts.detail.contract.type)}</td>
            </tr>
            <tr>
              <th>Issued by</th>
              <td>{personName($contracts.detail.contract.issuerID)}</td>
            </tr>
            <tr>
              <th>Status</th>
              <td>{contractStatusLabel($contracts.detail.contract.status)}</td>
            </tr>
            <tr>
              <th>Collect from</th>
              <td>
                {stationName($contracts.detail.contract.startStationID)}
                in {systemName($contracts.detail.startSolarSystemID)}
              </td>
            </tr>
            {#if $contracts.detail.contract.endStationID > 0}
              <tr>
                <th>Deliver to</th>
                <td>
                  {stationName($contracts.detail.contract.endStationID)}
                  in {systemName($contracts.detail.endSolarSystemID)}
                </td>
              </tr>
            {/if}
            <tr>
              <th>Pays</th>
              <td class="num">{formatIsk($contracts.detail.contract.reward)}</td>
            </tr>
            <tr>
              <th>You must cover</th>
              <td class="num">{formatIsk($contracts.detail.contract.collateral)}</td>
            </tr>
            <tr>
              <th>Cargo size</th>
              <td class="num">{formatVolume($contracts.detail.contract.volume)}</td>
            </tr>
            <tr>
              <th>Time allowed</th>
              <td>
                {$contracts.detail.contract.numDays > 0
                  ? `${$contracts.detail.contract.numDays} days`
                  : "—"}
              </td>
            </tr>
            {#if $contracts.detail.contract.assigneeID !== null}
              <tr>
                <th>Reserved for</th>
                <td>{ownerName($contracts.detail.contract.assigneeID)}</td>
              </tr>
            {/if}
            {#if $contracts.detail.contract.acceptorID !== null}
              <tr>
                <th>Taken on by</th>
                <td>{ownerName($contracts.detail.contract.acceptorID)}</td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>

      {#if $contracts.detail.contract.description}
        <p class="note">{$contracts.detail.contract.description}</p>
      {/if}

      {#if $contracts.detail.items.length > 0}
        <h3>What is in it</h3>
        <div class="table-wrap overflow-x-auto">
          <table class="guests reflow">
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">How many</th>
                <th>Which way</th>
              </tr>
            </thead>
            <tbody>
              {#each $contracts.detail.items as item, index (`${item.typeID}-${index}`)}
                <tr>
                  <td data-label="Item">{itemName(item.typeID)}</td>
                  <td class="num" data-label="How many">{item.quantity}</td>
                  <!-- inCrate distinguishes what is being handed over from what
                       is being asked for — a gift from a trade. -->
                  <td data-label="Which way">
                    {item.inCrate ? "Being handed over" : "Being asked for"}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p class="note">This contract lists no items.</p>
      {/if}

      {#if $contracts.acceptError}
        <!-- The SERVER'S words. A refusal here is specific and actionable —
             not enough ISK, no room for the cargo, someone got there first —
             and rewording it would throw that away. -->
        <p class="error">{$contracts.acceptError}</p>
      {/if}

      {#if justAccepted}
        <p class="note">
          You have taken this on. It is now in <strong>Taken on</strong> under
          Yours.
        </p>
      {/if}

      {#if canAccept && !justAccepted}
        {#if !confirmingAccept}
          <p class="controls">
            <button
              type="button"
              disabled={busy || acceptingOpen}
              onclick={() => (confirmingAccept = true)}
            >
              Take this on…
            </button>
          </p>
        {:else}
          <!-- The whole point of the second step: what changes hands, in one
               place, before anything moves. -->
          <div class="table-wrap overflow-x-auto">
            <table class="guests">
              <tbody>
                <tr>
                  <th>You are paid</th>
                  <td class="num">{formatIsk($contracts.detail.contract.reward)}</td>
                </tr>
                <tr>
                  <th>You must cover</th>
                  <td class="num">{formatIsk($contracts.detail.contract.collateral)}</td>
                </tr>
                {#if $contracts.detail.contract.type === CONTRACT_TYPE_ITEM_EXCHANGE}
                  <tr>
                    <th>You pay</th>
                    <td class="num">{formatIsk($contracts.detail.contract.price)}</td>
                  </tr>
                {/if}
                <tr>
                  <th>Collect from</th>
                  <td>{stationName($contracts.detail.contract.startStationID)}</td>
                </tr>
                {#if $contracts.detail.contract.endStationID > 0}
                  <tr>
                    <th>Deliver to</th>
                    <td>{stationName($contracts.detail.contract.endStationID)}</td>
                  </tr>
                  <tr>
                    <th>Time allowed</th>
                    <td>
                      {$contracts.detail.contract.numDays > 0
                        ? `${$contracts.detail.contract.numDays} days`
                        : "—"}
                    </td>
                  </tr>
                {/if}
              </tbody>
            </table>
          </div>
          <p class="note">
            Taking this on moves ISK and items straight away and
            <strong>cannot be undone</strong>. The collateral is held until the
            job is finished, and you lose it if it is not.
          </p>
          <p class="controls">
            <button
              type="button"
              class="danger"
              disabled={busy || acceptingOpen}
              onclick={acceptOpenContract}
            >
              {acceptingOpen ? "Taking it on…" : "Yes, take this contract on"}
            </button>
            <button
              type="button"
              class="minor"
              disabled={busy || acceptingOpen}
              onclick={() => (confirmingAccept = false)}
            >
              Never mind
            </button>
          </p>
        {/if}
      {/if}

      <p class="controls">
        <button type="button" class="minor" disabled={busy} onclick={() => flow.closeContract()}>
          Close
        </button>
      </p>
    </section>
  {/if}
</section>
