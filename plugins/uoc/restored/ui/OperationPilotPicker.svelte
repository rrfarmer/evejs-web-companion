<!-- WC74 web/src/ui/OperationPilotPicker.svelte @ 213da333; plugin routing adapted. -->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    listHangarPilotAccount,
    listVerifiedOperationPilots,
    listWorkspaceOperationPilots,
    type VerifiedOperationPilot,
  } from "../app/api.ts";
  import { workspaceAccounts } from "../app/context.ts";

  let {
    onChoose,
    onLoaded,
    disabled = false,
    selectedID = 0,
    chooseLabel = "Pilot",
    canChoose = (pilot: VerifiedOperationPilot) => pilot.availability === "AVAILABLE",
  }: {
    onChoose: (pilot: VerifiedOperationPilot) => void;
    onLoaded?: (pilots: VerifiedOperationPilot[]) => void;
    disabled?: boolean;
    selectedID?: number;
    chooseLabel?: string;
    canChoose?: (pilot: VerifiedOperationPilot) => boolean;
  } = $props();

  let rows = $state.raw<VerifiedOperationPilot[]>([]),
    fetched = $state(false);
  let accounts = $state<string[]>([]);
  let pilotFilter = $state("");
  const filter = $derived(pilotFilter.trim().toLowerCase());
  const sortedPilots = $derived(
    [...rows].sort((a, b) => a.characterName.localeCompare(b.characterName)),
  );
  const visiblePilots = $derived(
    sortedPilots.filter(
      (pilot) =>
        pilot.characterID === selectedID || pilot.characterName.toLowerCase().includes(filter),
    ),
  );
  const selectedValue = $derived(
    rows.some((row) => row.characterID === selectedID) ? String(selectedID) : "",
  );
  const unloadedAccounts = $derived(
    accounts.filter((name) => !rows.some((row) => row.accountName === name)),
  );
  let busy = $state(false),
    error = $state("");
  let generation = 0;
  const labels: Record<VerifiedOperationPilot["availability"], string> = {
    AVAILABLE: "Available",
    ACCOUNT_BUSY: "Account in use",
    WC_SESSION: "Open in Web Companion",
    HOSTED: "Hosted operation",
    CHECKING: "Check in progress",
    RECOVERY: "Recovery required",
    IN_GAME: "In game",
    OTHER_SESSION: "Other session",
    UNKNOWN: "Control unknown",
    UNCHECKED: "Saved pilot",
  };

  onMount(() => {
    void check();
  });
  onDestroy(() => {
    ++generation;
  });

  async function check() {
    if (busy) return;
    const current = ++generation;
    accounts = workspaceAccounts();
    busy = true;
    error = "";
    try {
      const { pilots, errors } = await listWorkspaceOperationPilots();
      if (generation !== current) return;
      rows = pilots;
      error = errors.join(" · ");
      fetched = true;
      onLoaded?.(pilots.filter((pilot) => pilot.availability !== "UNCHECKED"));
    } catch (cause) {
      if (generation === current) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (generation === current) busy = false;
    }
  }
  async function openRoster(account: string, characterID?: number) {
    if (busy || disabled || !account) return;
    const current = ++generation;
    busy = true;
    error = "";
    try {
      const pilots =
        characterID === undefined
          ? await listVerifiedOperationPilots(account)
          : await listHangarPilotAccount(characterID);
      if (generation !== current) return;
      const ids = new Set(pilots.map((pilot) => pilot.characterID));
      const rosterAccount = (pilots[0]?.accountName ?? account).toLowerCase();
      rows = [
        ...rows.filter(
          (row) => row.accountName.toLowerCase() !== rosterAccount && !ids.has(row.characterID),
        ),
        ...pilots,
      ];
      onLoaded?.(pilots);
      if (characterID === undefined) return;
      const selected = pilots.find((row) => row.characterID === characterID);
      if (!selected) throw new Error("The saved pilot is missing from the current account roster.");
      if (!canChoose(selected)) throw new Error(selected.reason);
      onChoose(selected);
    } catch (cause) {
      if (generation === current) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (generation === current) busy = false;
    }
  }

  function canSelect(pilot: VerifiedOperationPilot) {
    return pilot.availability === "UNCHECKED" || canChoose(pilot);
  }

  function pickFromList(event: Event & { currentTarget: HTMLSelectElement }) {
    const select = event.currentTarget;
    const pilot = rows.find((row) => String(row.characterID) === select.value);
    select.value = selectedValue;
    if (!pilot || busy || disabled || !canSelect(pilot) || pilot.characterID === selectedID) return;
    error = "";
    if (pilot.availability === "UNCHECKED") void openRoster(pilot.accountName, pilot.characterID);
    else onChoose(pilot);
  }
</script>

<div class="picker">
  <div class="picker-controls">
    <label
      >{chooseLabel}
      <select
        value={selectedValue}
        disabled={disabled || busy || !visiblePilots.length}
        onchange={pickFromList}
      >
        <option value="">Choose a pilot</option>
        {#each visiblePilots as pilot (pilot.characterID)}
          {@const account =
            pilot.accountName.toLowerCase() === pilot.characterName.toLowerCase()
              ? ""
              : pilot.accountName}
          <option value={String(pilot.characterID)} disabled={!canSelect(pilot)}>
            {[pilot.characterName, account, pilot.shipName, labels[pilot.availability]]
              .filter(Boolean)
              .join(" · ")}
          </option>
        {/each}
      </select>
    </label>
    <label
      >Filter pilots
      <input type="search" bind:value={pilotFilter} disabled={disabled || busy || !rows.length} />
    </label>
    <button type="button" disabled={disabled || busy} onclick={() => void check()}
      >Refresh pilots</button
    >
  </div>
  {#if unloadedAccounts.length}
    <label
      >Read pilots on a saved account
      <select
        value=""
        disabled={disabled || busy}
        onchange={(event) => {
          void openRoster(event.currentTarget.value);
          event.currentTarget.value = "";
        }}
      >
        <option value="">Choose an account</option>
        {#each unloadedAccounts as account (account)}<option value={account}>{account}</option
          >{/each}
      </select>
    </label>
  {/if}
  {#if busy}<p role="status">Checking pilot ownership…</p>{/if}
  {#if !busy && rows.length && !visiblePilots.length}<p role="status">
      No pilots match the filter.
    </p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if fetched && !rows.length && !error}<p>No saved pilots are available in this browser.</p>{/if}
</div>

<style>
  .picker {
    display: grid;
    gap: 0.6rem;
  }
  .picker-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.6rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
  }
  select,
  input {
    width: 100%;
  }
  [role="alert"] {
    color: #ffad86;
  }
  button {
    width: fit-content;
  }
</style>
