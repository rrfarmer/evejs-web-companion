<script lang="ts">
  import { openDefaultFarmerAccount } from "../app/api.ts";
  import { farmerAccounts, farmerSignInMessage, savedWorkspacePilots } from "../app/context.ts";
  import { onMount, onDestroy } from "svelte";
  import TrainingPilotSkills from "./TrainingPilotSkills.svelte";
  import type { TrainingSheet } from "../training/types.ts";
  import TrainingGoal from "./TrainingGoal.svelte";
  import CenterHeading from "./CenterHeading.svelte";
  import CenterStatus from "./CenterStatus.svelte";
  import {
    readSelectedTrainee,
    rememberSelectedTrainee,
    trainingWorldStorage,
  } from "../training/worldStorage.ts";
  import { readTrainingActiveShip, readTrainingWorld } from "../adapters/training.ts";
  import OperationPilotPicker from "./OperationPilotPicker.svelte";
  import type { VerifiedOperationPilot } from "../app/api.ts";
  import { loadTrainingSettingsContext, readSavedTrainingAuthority } from "../adapters/training.ts";
  import type { TrainingSettingsContext, TrainingAuthority } from "../training/settings.ts";
  import {
    trainingOnboarding,
    verifyTrainingMembership,
    loadTrainingEnrollment,
    type TrainingEnrollment,
  } from "../adapters/training.ts";
  import type { ApiOptions } from "../adapters/training.ts";
  import { readFactoryAccount, readFactoryWorld } from "../training/factoryClient.ts";
  import { factoryError as panelErrorWords, rememberFactoryAccount } from "../training/factory.ts";
  import type { TrainingCharacter } from "../training/types.ts";
  import TrainingSettingsPanel from "./TrainingSettings.svelte";
  import {
    defaultTrainingSettings,
    readTrainingSettings,
    saveTrainingSettings,
    trainingPilotKey,
    trainingPilotRef,
    type TrainingPilotRef,
    type TrainingSettings,
  } from "../training/settings.ts";
  import { resolveTrainingFundingPolicy } from "../../training/funding.ts";
  let worldID = $state<string | null>(null);
  let { onTraineeChange }: { onTraineeChange?: () => void } = $props();
  const trainingStorage = trainingWorldStorage(
    {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
    },
    () => worldID,
  );
  const traineeStorage = trainingWorldStorage(
    {
      getItem: (key) => sessionStorage.getItem(key),
      setItem: (key, value) => sessionStorage.setItem(key, value),
    },
    () => worldID,
  );
  const savedPilots = savedWorkspacePilots();
  let settings = $state<TrainingSettings>(defaultTrainingSettings());
  const configuredFunding = $derived(
    resolveTrainingFundingPolicy(settings.fundingPolicy, settings.automaticFunding),
  );
  function initializeWorld(identity: string | null, ticket: number) {
    if (ticket !== generation) return;
    if (!identity) throw new Error("WC could not verify the current world identity.");
    if (identity === worldID) return;
    worldID = identity;
    settings = readTrainingSettings(trainingStorage);
    rows = [];
    selectedTrainee = null;
    activeShip = null;
    settingsContexts = {};
    settingsError = "";
    credentials.clear();
    accounts = farmerAccounts();
  }
  async function inspectChosenHR(candidate: string) {
    const ref = trainingPilotRef(candidate);
    if (!ref || busy) return;
    busy = true;
    settingsError = "";
    const ticket = ++generation;
    try {
      await readAccount(ref.account, ticket);
      if (ticket !== generation) return;
      const row = findPilot(ref),
        options = row && credentials.get(row.account);
      if (!row || !options)
        throw new Error(
          accountErrors[ref.account] || "The HR pilot is missing from the current account roster.",
        );
      await readSettingsContext(row, options, ticket);
    } catch (cause) {
      if (ticket === generation) settingsError = panelErrorWords(cause);
    } finally {
      if (ticket === generation) busy = false;
    }
  }
  let settingsContexts = $state<Record<string, TrainingSettingsContext>>({});
  let settingsError = $state("");
  const corporations = $derived([
    ...new Map(
      Object.values(settingsContexts)
        .flatMap((value) => value.corporations)
        .map((c) => [c.corporationID, c]),
    ).values(),
  ]);
  const settingsAuthorities = $derived<TrainingAuthority[]>(
    rows.flatMap((row) =>
      (settingsContexts[row.key]?.authorities ?? [])
        .filter(
          (authority) =>
            !row.pilot.corporationID || authority.corporationID === row.pilot.corporationID,
        )
        .map((authority) => ({ ...authority, account: row.account, key: row.key })),
    ),
  );
  const hrCandidates = $derived([
    ...new Map(
      [
        ...savedPilots.map((pilot) => ({
          key: trainingPilotKey(pilot.accountName, pilot.characterID),
          name: pilot.characterName,
          account: pilot.accountName,
        })),
        ...rows.map((row) => ({ key: row.key, name: row.pilot.name, account: row.account })),
      ].map((candidate) => [candidate.key, candidate]),
    ).values(),
  ]);
  async function readSettingsContext(
    row: PilotRow,
    options: ApiOptions,
    ticket: number,
    passive = false,
  ) {
    const { pilot, key } = row;
    try {
      const value = passive
        ? await readSavedTrainingAuthority(options, pilot.characterID)
        : await loadTrainingSettingsContext(options, pilot.characterID, pilot);
      if (ticket !== generation) return;
      const verified = value.authorities.find((a) => a.characterID === pilot.characterID);
      settingsContexts = { ...settingsContexts, [key]: value };
      settingsError = verified?.eligible
        ? ""
        : (verified?.reason ?? `${pilot.name} is not an eligible Corporation HR Pilot.`);
    } catch (cause) {
      if (ticket !== generation) return;
      delete settingsContexts[key];
      settingsError = `${pilot.name}: ${panelErrorWords(cause)}`;
    }
  }
  let onboardingMessage = $state("");
  let onboardingUncertain = $state<Record<string, boolean>>({});
  async function saveSettings(value: TrainingSettings) {
    if (busy || !worldID) return;
    busy = true;
    error = "";
    const scope = worldID,
      ticket = ++generation;
    try {
      const authority = settingsAuthorities.find(
        (a) =>
          a.key === value.onboarding.authorityKey &&
          a.eligible &&
          a.corporationID === value.onboarding.corporationID,
      );
      const changedHR =
        value.onboarding.authorityKey !== settings.onboarding.authorityKey ||
        value.onboarding.corporationID !== settings.onboarding.corporationID ||
        value.onboarding.rights !== settings.onboarding.rights;
      const hrOptions = authority && credentials.get(authority.account);
      if (changedHR && !hrOptions)
        throw new Error("Verify the selected Corporation HR Pilot before saving.");
      const trainee = visible[0];
      const options =
        hrOptions ??
        (trainee && credentials.get(trainee.account)) ??
        (await openDefaultFarmerAccount())?.options;
      if (!options || (await readTrainingWorld(options)).worldID !== scope)
        throw new Error("The current world identity changed. Refresh Training before saving.");
      if (ticket !== generation) return;
      saveTrainingSettings(trainingStorage, value);
      settings = value;
      if (authority) rememberFactoryAccount(trainingStorage, authority.account);
    } catch (cause) {
      if (ticket === generation) error = panelErrorWords(cause);
    } finally {
      if (ticket === generation) busy = false;
    }
  }
  function authorityForSettings() {
    const officer = rows.find(
      (r) =>
        r.key === settings.onboarding.authorityKey &&
        settingsAuthorities.some(
          (a) =>
            a.key === r.key && a.eligible && a.corporationID === settings.onboarding.corporationID,
        ),
    );
    const token = officer && credentials.get(officer.account)?.token;
    if (!officer || !token)
      throw new Error("Choose a verified Corporation HR Pilot with active WC Account access.");
    return { characterID: officer.pilot.characterID, token };
  }
  async function onboard(row: PilotRow) {
    if (busy || onboardingUncertain[row.key]) return;
    const options = credentials.get(row.account);
    if (!options) return;
    if (["PENDING", "BLOCKED"].includes(row.enrollment?.enrollmentState ?? "")) {
      onboardingMessage = "Previous onboarding needs reconciliation.";
      return;
    }
    busy = true;
    onboardingMessage = "";
    try {
      const authority = authorityForSettings();
      if (authority.characterID === row.pilot.characterID)
        throw new Error("Choose a trainee other than the HR pilot.");
      const value = await trainingOnboarding(
        "review",
        {
          ...settings.onboarding,
          enabled: true,
          characterID: row.pilot.characterID,
          currentCorporationID: row.pilot.corporationID,
          authority,
          worldID,
        },
        options,
      );
      const outcome = await trainingOnboarding(
        "apply",
        { reviewID: value.reviewID, authority, worldID, confirm: true },
        options,
      );
      if (!outcome.verified) onboardingUncertain = { ...onboardingUncertain, [row.key]: true };
      onboardingMessage = outcome.verified
        ? row.pilot.name + ": corporation membership and permissions verified."
        : row.pilot.name +
          ": " +
          (outcome.code || outcome.status || "Onboarding outcome is unknown") +
          ". " +
          (outcome.message || "Review the current corporation state before continuing.");
      const ticket = ++generation;
      await readPilot(row, ticket);
    } catch (cause) {
      onboardingUncertain = { ...onboardingUncertain, [row.key]: true };
      onboardingMessage =
        panelErrorWords(cause) + " Read the current corporation state before another attempt.";
    } finally {
      busy = false;
    }
  }
  interface PilotRow {
    key: string;
    account: string;
    pilot: TrainingCharacter;
    enrollment: TrainingEnrollment | null;
  }
  let rows = $state<PilotRow[]>([]);
  let selectedTrainee = $state<string | null>(null);
  let activeShip = $state<Promise<string | null> | null>(null);
  let accounts = $state<string[]>([]);
  let accountErrors = $state<Record<string, string>>({});
  let busy = $state(false);
  let ready = $state(false);
  let error = $state("");

  const credentials = new Map<string, ApiOptions>(); // Memory only; never gameplay sessions.
  let generation = 0;
  function findPilot(ref: TrainingPilotRef): PilotRow | undefined {
    return rows.find(
      (row) =>
        row.pilot.characterID === ref.characterID &&
        row.account.toLowerCase() === ref.account.toLowerCase(),
    );
  }
  const visible = $derived(rows.filter((row) => row.key === selectedTrainee));
  let latestTraining = $state<{ key: string; sheet: TrainingSheet } | null>(null);
  function update(key: string, fields: Partial<PilotRow>): void {
    rows = rows.map((row) => (row.key === key ? { ...row, ...fields } : row));
  }
  function makeRow(account: string, pilot: TrainingCharacter): PilotRow {
    return { key: trainingPilotKey(account, pilot.characterID), account, pilot, enrollment: null };
  }
  function rowReady(row: PilotRow): boolean {
    return (
      row.enrollment?.state === "READY" && row.enrollment.corporationID === row.pilot.corporationID
    );
  }
  function observeActiveShip(row: PilotRow) {
    const options = credentials.get(row.account);
    activeShip = options ? readTrainingActiveShip(row.pilot.characterID, options) : null;
  }
  function selectTrainee(row: PilotRow) {
    if (selectedTrainee && selectedTrainee !== row.key) onTraineeChange?.();
    selectedTrainee = row.key;
    rememberSelectedTrainee(traineeStorage, {
      account: row.account,
      characterID: row.pilot.characterID,
    });
    observeActiveShip(row);
  }
  async function verifyMembership(row: PilotRow) {
    const options = credentials.get(row.account);
    if (busy || !options || !row.pilot.corporationID) return;
    busy = true;
    error = "";
    const ticket = ++generation;
    try {
      await readPilot(row, ticket);
    } catch (cause) {
      if (ticket === generation) error = panelErrorWords(cause);
    } finally {
      if (ticket === generation) busy = false;
    }
  }
  async function readPilot(row: PilotRow, ticket: number): Promise<void> {
    const options = credentials.get(row.account);
    if (!options || ticket !== generation) return;
    try {
      let enrollment = await loadTrainingEnrollment(row.pilot.characterID, options);
      if (ticket !== generation) return;
      if (
        row.pilot.corporationID &&
        row.pilot.corporationID === settings.onboarding.corporationID &&
        enrollment.state !== "READY" &&
        !["PENDING", "BLOCKED"].includes(enrollment.enrollmentState ?? "")
      ) {
        enrollment = await verifyTrainingMembership(
          row.pilot.characterID,
          row.pilot.corporationID,
          options,
        );
      }
      if (ticket === generation)
        update(row.key, {
          enrollment,
          pilot: {
            ...row.pilot,
            corporationID: enrollment.corporationID ?? row.pilot.corporationID,
            corporationName:
              enrollment.corporationName ??
              (enrollment.corporationID === row.pilot.corporationID
                ? row.pilot.corporationName
                : null),
          },
        });
    } catch (cause) {
      if (ticket === generation) error = panelErrorWords(cause);
    }
  }
  async function readAccount(account: string, ticket: number): Promise<void> {
    // Account and pilot reads are serialized; a refresh never competes with an edit.
    try {
      const roster = await readFactoryAccount(account);
      if (ticket !== generation) return;
      if (!worldID) {
        const { worldID: identity } = await readTrainingWorld(roster.requestOptions);
        initializeWorld(identity, ticket);
      }
      if (ticket !== generation) return;
      credentials.set(roster.account, roster.requestOptions);
      const fresh = roster.characters.map((pilot) => makeRow(roster.account, pilot));
      rows = [
        ...rows.filter((row) => row.account !== account && row.account !== roster.account),
        ...fresh,
      ];
      accounts = [
        ...new Set([
          ...accounts.filter((name) => name.toLowerCase() !== account.toLowerCase()),
          roster.account,
        ]),
      ];
      accountErrors = { ...accountErrors, [account]: "", [roster.account]: "" };
      if (fresh.length === 0)
        accountErrors = { ...accountErrors, [roster.account]: "No characters on this account." };
    } catch (cause) {
      if (ticket !== generation) return;
      const reason = panelErrorWords(cause);
      credentials.delete(account);

      accountErrors = { ...accountErrors, [account]: reason };
      // Cached browser character cards are NOT live account authority. Keep the
      // saved account name for manual reconciliation, but do not show a stale
      // character card or offer onboarding for an unverified server account.
      rows = rows.filter((row) => row.account !== account);
    }
  }
  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    const ticket = ++generation;
    try {
      initializeWorld(await readFactoryWorld(), ticket);
      if (ticket !== generation) return;
      const scope = worldID;
      const remembered = readSelectedTrainee(traineeStorage);
      const savedHR = trainingPilotRef(settings.onboarding.authorityKey);
      const requested = [...farmerAccounts(), ...accounts, remembered?.account, savedHR?.account];
      const checked = new Set<string>();
      for (const account of requested) {
        if (!account || checked.has(account.toLowerCase())) continue;
        checked.add(account.toLowerCase());
        await readAccount(account, ticket);
        if (ticket !== generation || scope !== worldID) return;
      }
      if (remembered && !selectedTrainee) {
        const trainee = findPilot(remembered);
        if (trainee) selectTrainee(trainee);
      } else if (visible[0]) {
        observeActiveShip(visible[0]);
      }
      if (savedHR) {
        const hr = findPilot(savedHR),
          options = hr && credentials.get(hr.account);
        if (hr && options) await readSettingsContext(hr, options, ticket, true);
        else
          settingsError =
            accountErrors[savedHR.account] ||
            "The saved HR pilot is missing from the current account roster.";
      }
    } catch (cause) {
      if (ticket === generation) error = panelErrorWords(cause);
    } finally {
      if (ticket === generation) {
        ready = true;
        busy = false;
      }
    }
  }
  async function choosePilot(pilot: VerifiedOperationPilot) {
    if (busy) return;
    busy = true;
    error = "";
    const ticket = ++generation;
    try {
      await readAccount(pilot.accountName, ticket);
      if (ticket !== generation) return;
      const row = findPilot({ account: pilot.accountName, characterID: pilot.characterID });
      if (row) selectTrainee(row);
      else
        error =
          accountErrors[pilot.accountName] ||
          "The pilot is missing from the current training roster.";
    } finally {
      if (ticket === generation) busy = false;
    }
  }
  onMount(() => {
    document.title = "Pilot Training · EveJS Web";
    void refresh();
  });
  onDestroy(() => {
    generation++;
    credentials.clear();
  });
</script>

<main class="uoc-center">
  <CenterHeading
    title="Pilot Training"
    description="Choose a training goal and monitor the pilot’s skill queue."
  >
    {#snippet actions()}
      <a href="/" target="_blank" rel="noopener">Pilot Hangar</a>
      <button type="button" disabled={busy || !ready} onclick={refresh}
        >{busy ? "Reading…" : "Refresh roster"}</button
      >
    {/snippet}
  </CenterHeading>
  <TrainingSettingsPanel
    {settings}
    {busy}
    {corporations}
    worldReady={!!worldID}
    authorities={settingsAuthorities}
    candidates={hrCandidates}
    onInspect={inspectChosenHR}
    traineeCorporationID={visible[0]?.enrollment?.corporationID ?? null}
    traineeCorporationName={visible[0]?.enrollment?.corporationName ?? null}
    contextError={settingsError}
    onSave={(value) => void saveSettings(value)}
  />
  {#if ready}
    <section class="center-panel" aria-label="Choose a verified trainee">
      <OperationPilotPicker
        disabled={busy}
        selectedID={visible[0]?.pilot.characterID}
        chooseLabel="Trainee"
        canChoose={() => true}
        onChoose={(pilot) => void choosePilot(pilot)}
      />
      {#each Object.entries(accountErrors).filter(([, reason]) => reason) as [name, reason] (name)}
        <p role="alert">{name} · {reason}</p>
      {/each}
    </section>
  {/if}

  {#if onboardingMessage}<p role="status">{onboardingMessage}</p>{/if}
  {#if error}<p class="center-message" role="alert">{error}</p>{/if}
  {#if !ready}<p>Checking the current roster…</p>
  {:else if !rows.length && !busy}<p>Choose a saved pilot to view skills.</p>
  {:else if !selectedTrainee}<p>{rows.length} verified pilots. Choose a pilot to view skills.</p
    >{/if}
  <div class="factory-roster">
    {#each visible as row (row.key)}
      {@const options = credentials.get(row.account)}
      {@const hr = rows.find(
        (candidate) =>
          candidate.key === settings.onboarding.authorityKey &&
          settingsAuthorities.some(
            (a) =>
              a.key === candidate.key &&
              a.eligible &&
              a.corporationID === settings.onboarding.corporationID,
          ),
      )}
      {@const hrToken = hr && credentials.get(hr.account)?.token}
      {@const sameCorporation =
        !!settings.onboarding.corporationID &&
        row.pilot.corporationID === settings.onboarding.corporationID}
      {@const fundingPolicy =
        configuredFunding === "CHARACTER_PLUS_CORPORATION_SHORTFALL" &&
        settings.trainingWallet?.corporationID !== row.pilot.corporationID
          ? "CHARACTER_WALLET_ONLY"
          : configuredFunding}
      {@const knownShip =
        row.pilot.shipName &&
        row.pilot.shipTypeName &&
        row.pilot.shipName !== row.pilot.shipTypeName
          ? `${row.pilot.shipName} · ${row.pilot.shipTypeName}`
          : (row.pilot.shipName ?? row.pilot.shipTypeName)}
      <article class="center-panel">
        <header class="center-actions"
          ><h2>{row.pilot.name}</h2>{#if sameCorporation && rowReady(row)}<CenterStatus
              state="VERIFIED"
              label="Membership verified"
            />{/if}</header
        >
        <p class="eyebrow">{row.account}</p>
        <p>Corporation: {row.pilot.corporationName ?? "Name unavailable"}</p>
        <p
          >Active ship: {#await activeShip}{knownShip ?? "Reading…"}{:then name}{name ??
              knownShip ??
              "Unavailable"}{:catch}{knownShip ?? "Unavailable"}{/await}</p
        >
        {#if !worldID}<p role="status"
            >Current world identity is unavailable. HR and funding settings cannot be saved.</p
          >{/if}
        {#if settings.onboarding.enabled && settings.onboarding.corporationID && !sameCorporation}
          <p>Join the corporation of your HR pilot before corporate training.</p>
          <button
            disabled={busy ||
              onboardingUncertain[row.key] ||
              !hrToken ||
              hr?.pilot.characterID === row.pilot.characterID ||
              ["PENDING", "BLOCKED"].includes(row.enrollment?.enrollmentState ?? "")}
            onclick={() => void onboard(row)}>Join corporation and apply bot permissions</button
          >
        {:else if sameCorporation && !rowReady(row)}
          <button disabled={busy} onclick={() => void verifyMembership(row)}
            >Verify corporation membership</button
          >
        {:else if sameCorporation}
          {#if settings.onboarding.enabled && settings.onboarding.rights === "FULL_ACCESS_EXCEPT_CEO" && hrToken && hr?.pilot.characterID !== row.pilot.characterID}
            <button
              disabled={busy || onboardingUncertain[row.key]}
              onclick={() => void onboard(row)}>Apply bot permissions</button
            >
          {/if}
        {/if}
        {#if options}
          {#key JSON.stringify( [options.token, fundingPolicy, settings.trainingWallet?.corporationID, settings.trainingWallet?.accountKey] )}
            {@const latestSheet = latestTraining?.key === row.key ? latestTraining.sheet : null}
            {@const queueChanged = (sheet: TrainingSheet) => {
              if (selectedTrainee === row.key) latestTraining = { key: row.key, sheet };
            }}
            <TrainingGoal
              characterID={row.pilot.characterID}
              {options}
              {worldID}
              {fundingPolicy}
              trainingWallet={settings.trainingWallet}
              {latestSheet}
              {queueChanged}
            />
            <TrainingPilotSkills
              characterID={row.pilot.characterID}
              {options}
              {fundingPolicy}
              trainingWallet={settings.trainingWallet}
              {latestSheet}
              {queueChanged}
            />
          {/key}
        {:else}<p>{farmerSignInMessage}</p>{/if}
        <a href="/uoc/ship-provisioning/">Open Ship Provisioning</a>
        <details
          ><summary>Advanced pilot details</summary><p
            >Character ID {row.pilot.characterID} · Corporation ID {row.pilot.corporationID ??
              "Unknown"} · control "unknown"</p
          ></details
        >
      </article>
    {/each}
  </div>
</main>

<style>
  .eyebrow {
    font-size: 0.85rem;
    color: var(--center-muted);
    margin: 0;
  }
  .factory-roster {
    display: grid;
    gap: 1rem;
  }
  h2 {
    margin: 0.25rem 0;
  }
</style>
