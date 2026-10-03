<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { loadKnownCharacters } from "../app/knownCharacters.ts";
  import CharacterCreate from "./CharacterCreate.svelte";
  import NewTrainee from "./NewTrainee.svelte";
  import { loadTrainingSettingsContext, searchTrainingHomes } from "../app/api.ts";
  import type { TrainingSettingsContext, TrainingAuthority } from "../training/settings.ts";
  import { rememberCreatedAccount, type continueNewTrainee } from "../training/newTrainee.ts";
  import { trainingOnboarding, resolveTrainingHome, loadQualification, createCharacter, type CreateCharacterRequest } from "../app/api.ts";
  import { loadTrainingCharacters, reviewTrainingQueue, applyTrainingQueue, reviewSkillAcquisition, acquireFactorySkills, factoryOwnership, type ApiOptions } from "../app/api.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { readFactoryAccount } from "../training/factoryClient.ts";
  import { factoryError as panelErrorWords } from "../training/factory.ts";
  import { formatDuration } from "../bridge/skills.ts";
  import { readTrainingPreferences, saveTrainingPreferences, configSelections, putConfiguration, removeConfiguration, setRole,
    qualificationName, type TrainingPreferences, type TrainingConfiguration } from "../training/configurations.ts";
  import { readFactoryAccounts, rememberFactoryAccount, factoryStatus, factoryStatusLabels,
    readLastQueueApply, rememberQueueApply, type LastQueueApply,
    type PlanMode, type FactoryStatus } from "../training/factory.ts";
  import type { TrainingCharacter, MinerTrainingRead, StageFittingSelection, CorporationSavedFitting, QueueReview, QueueApplyOutcome, TrainingQueue } from "../training/types.ts";
  import MinerQualification from "./MinerQualification.svelte";
  import TrainingEquipmentPlan from "./TrainingEquipmentPlan.svelte";
  import { equipmentState, equipmentSourceKey, readEquipmentSource } from "../training/equipment.ts";
  import { reviewTrainingEquipment, applyTrainingEquipment, recoverTrainingEquipment } from "../app/api.ts";
  import type { TrainingEquipmentSource, TrainingEquipmentReview } from "../training/types.ts";
  import type { ApplyOutcome } from "../provisioning/centerClient.ts";
  import TrainingQueueReview from "./TrainingQueueReview.svelte";
  import SkillAcquisition from "./SkillAcquisition.svelte";
  import type { AcquisitionReview, AcquisitionOutcome, FactoryFunding, FundingPolicy } from "../training/types.ts";

  import TrainingSettingsPanel from "./TrainingSettings.svelte";
  import { defaultTrainingSettings, readTrainingSettings, saveTrainingSettings, type TrainingSettings } from "../training/settings.ts";
  let settings = $state<TrainingSettings>(defaultTrainingSettings());
  let settingsContexts = $state<Record<string, TrainingSettingsContext>>({});
  let settingsErrors = $state<Record<string, string>>({});
  const corporations = $derived([...new Map(Object.values(settingsContexts).flatMap((value) => value.corporations).map((c) => [c.corporationID, c])).values()]);
  const settingsAuthorities = $derived<TrainingAuthority[]>(Object.entries(settingsContexts).flatMap(([account, context]) =>
    context.authorities.map((a) => ({ ...a, account, key: keyOf(account, a.characterID) }))));
  async function readSettingsContext(account: string, options: ApiOptions, ticket: number) {
    settingsContexts = Object.fromEntries(Object.entries(settingsContexts).filter(([name]) => name !== account));
    try { const value = await loadTrainingSettingsContext(options); if (ticket === generation) {
      settingsContexts = { ...settingsContexts, [account]: value }; settingsErrors = { ...settingsErrors, [account]: "" };
    } } catch { if (ticket === generation) settingsErrors = { ...settingsErrors, [account]: `Corporation settings unavailable for ${account}.` }; }
  }
  function settingsOptions() {
    const options = credentials.values().next().value;
    if (!options) throw new Error("Authenticate an account first.");
    return options;
  }
  let homeAccessPilot = $state("");
  const homeAccessPilots = $derived(rows.filter((row) => credentials.has(row.account)).map((row) => ({
    key: row.key, label: `${row.account} · ${row.pilot.name}`,
  })));
  function homeAccess() {
    const row = rows.find((candidate) => candidate.key === homeAccessPilot && credentials.has(candidate.account));
    return row ? { characterID: row.pilot.characterID, options: credentials.get(row.account)! } : null;
  }
  async function searchHomes(query: string) {
    const access = homeAccess();
    return searchTrainingHomes(query, access?.options ?? settingsOptions(), access?.characterID);
  }
  let onboardingReview = $state<{ rowKey: string; value: Record<string, any>; settingsHash: string } | null>(null);
  let onboardingMessage = $state("");
  function saveSettings(value: TrainingSettings) {
    try { saveTrainingSettings(localStorage, value); settings = value; onboardingReview = null;
      rows = rows.map((row) => ({ ...row, acquisition: null })); error = ""; }
    catch (cause) { error = String(cause); }
  }
  async function resolveHome(id: number) {
    const access = homeAccess();
    const options = access?.options ?? credentials.values().next().value;
    if (!options) throw new Error("Authenticate an existing account first.");
    return resolveTrainingHome(id, options, access?.characterID);
  }
  function authorityForSettings() {
    const officer = rows.find((r) => r.key === settings.onboarding.authorityKey);
    const token = officer && credentials.get(officer.account)?.token;
    if (!officer || !token) throw new Error("Authenticate the configured dedicated non-CEO authority first.");
    return { characterID: officer.pilot.characterID, token };
  }
  async function onboard(row: PilotRow, apply = false, automatic = false) {
    if (busy || !settings.onboarding.enabled) return;
    const options = credentials.get(row.account); if (!options) return;
    busy = true;
    try {
      const authority = authorityForSettings();
      if (apply) {
        const review = onboardingReview; onboardingReview = null;
        if (!review || review.rowKey !== row.key || review.settingsHash !== JSON.stringify(readTrainingSettings(localStorage))) throw new Error("ONBOARDING_CHANGED: review settings again.");
        const outcome = await trainingOnboarding("apply", { reviewID: review.value.reviewID, authority, confirm: true }, options);
        const cleanup = (outcome.cleanup || []).map((c: { characterID: number; released: boolean }) =>
          `Pilot ${c.characterID}: ${c.released ? "released" : "release unconfirmed"}`).join("; ");
        onboardingMessage = `${row.pilot.name}: ${outcome.status}. Verified: ${outcome.verified ? "yes" : "no"}. ` +
          `Corporation ${outcome.corporationID ?? "unknown"}; CEO ${outcome.ceoID ?? "unverified"}. ` +
          `${(outcome.steps || []).join(", ")}. ${outcome.code || ""} ${outcome.message || ""} ${cleanup}`;
        const ticket = ++generation; await readAccount(row.account, ticket);
      } else {
        const value = await trainingOnboarding("review", { ...settings.onboarding, characterID: row.pilot.characterID, authority }, options);
        onboardingReview = { rowKey: row.key, value, settingsHash: JSON.stringify(settings) };
        onboardingMessage = "Review corporation, dedicated authority and ordinary rights below. No membership change yet.";
      }
    } catch (cause) { onboardingMessage = panelErrorWords(cause); }
    finally { busy = false; }
    if (automatic && onboardingReview?.rowKey === row.key) await onboard(row, true);
  }
  interface PilotRow {
    key: string; account: string; pilot: TrainingCharacter; prefs: TrainingPreferences;
    selections: Record<string, StageFittingSelection>; result: MinerTrainingRead | null;
    error: string; readAt: number | null;
    review: QueueReview | null; queue: TrainingQueue | null; queueMessage: string; lastApply: LastQueueApply | null;
    acquisitionSettingsHash?: string; acquisition: AcquisitionReview | null; acquisitionFunding: FactoryFunding | null; acquisitionOutcome: AcquisitionOutcome | null; acquisitionMessage: string; owner: string;
    equipmentSource: TrainingEquipmentSource | null; equipmentReview: TrainingEquipmentReview | null;
    equipmentIntent?: string; equipmentOutcome: ApplyOutcome | null; equipmentMessage: string;
  }
  let rows = $state<PilotRow[]>([]);
  let accounts = $state<string[]>([]);
  let accountErrors = $state<Record<string, string>>({});
  let accountInput = $state("");
  let accountPassword = $state("");
  let accountPanel = $state<"NEW" | "EXISTING" | null>(null);
  let creatorInitialName = $state("");
  let busy = $state(false);
  let ready = $state(false);
  let error = $state("");
  let query = $state("");
  let filter = $state<"ALL" | FactoryStatus>("ALL");
  let expanded = $state<string | null>(null);
  let creatingAccount = $state<string | null>(null);
  let newTraineeAccount = $state("");
  const credentials = new Map<string, ApiOptions>(); // Memory only; never gameplay sessions.
  const creatorFlow = (account: string) => ({
    requestOptions: () => credentials.get(account)!,
    createCharacter: (request: CreateCharacterRequest) => createCharacter(request, credentials.get(account)!),
  });
  async function created(account: string, characterID: number | null): Promise<void> {
    creatingAccount = null;
    busy = true;
    const ticket = ++generation;
    await readAccount(account, ticket);
    if (ticket === generation) busy = false;
    const row = rows.find((r) => r.account === account && r.pilot.characterID === characterID);
    if (row && settings.onboarding.enabled) await onboard(row, false, true);
  }
  let generation = 0;
  let observationNow = $state(Date.now());
  const keyOf = (account: string, id: number) => JSON.stringify([account, id]);
  const visible = $derived(rows.filter((row) =>
    `${row.account} ${row.pilot.name}`.toLowerCase().includes(query.toLowerCase()) &&
    (filter === "ALL" || factoryStatus(row.result?.report ?? null, row.prefs.mode, row.error) === filter)));
  function update(key: string, fields: Partial<PilotRow>): void {
    rows = rows.map((row) => row.key === key ? { ...row, ...fields } : row);
  }
  function assertLocalPlan(row: PilotRow): void {
    const prefs = readTrainingPreferences(localStorage, row.account, row.pilot.characterID);
    if (JSON.stringify(prefs) !== JSON.stringify(row.prefs) || prefs.role !== row.prefs.role || prefs.mode !== row.prefs.mode ||
        (prefs.targetStage ?? null) !== (row.result?.report.targetStage ?? null)) throw new Error("PLAN_CHANGED: local target changed; refresh and review again.");
  }
  function makeRow(account: string, pilot: TrainingCharacter): PilotRow {
    let prefs: TrainingPreferences = { version: 2, role: "", mode: "FAST", targetStage: null, roles: {} };
    let selections = {};
    let configError = "";
    try { prefs = readTrainingPreferences(localStorage, account, pilot.characterID); selections = configSelections(prefs.roles[prefs.role] || []); }
    catch { configError = "Browser configuration is unreadable; stored fitting selections have not been overwritten."; }
    let equipmentSource: TrainingEquipmentSource | null = null, equipmentMessage = "";
    try { equipmentSource = readEquipmentSource(localStorage, account, pilot.characterID); }
    catch (cause) { equipmentMessage = String(cause); }
    return { key: keyOf(account, pilot.characterID), account, pilot, prefs, selections, result: null, error: configError, readAt: null,
      review: null, queue: null, queueMessage: "", lastApply: readLastQueueApply(localStorage, account, pilot.characterID),
      acquisition: null, acquisitionFunding: null, acquisitionOutcome: null, acquisitionMessage: "", owner: "UNKNOWN",
      equipmentSource, equipmentReview: null, equipmentOutcome: null, equipmentMessage };
  }
  async function readPilot(row: PilotRow, ticket: number): Promise<void> {
    if (ticket !== generation) return;
    update(row.key, { result: null, readAt: null, review: null, queue: null, acquisition: null, equipmentReview: null });
    if (!row.prefs.role || row.error) return;
    try {
      const options = credentials.get(row.account);
      if (!options) throw new Error("Account authentication is unavailable; refresh the roster.");
      const selections = configSelections(readTrainingPreferences(localStorage, row.account, row.pilot.characterID).roles[row.prefs.role] || []);
      const result = await loadQualification(row.pilot.characterID, row.prefs.role, row.prefs.roles[row.prefs.role] || [], options, row.prefs.targetStage, row.equipmentSource || { kind: "hangar" });
      let owner = "UNKNOWN";
      try { owner = (await factoryOwnership(row.pilot.characterID, options)).owner; } catch { /* unreadable ownership stays unknown */ }
      if (ticket === generation) update(row.key, { result, selections, queue: result.queue ?? null, error: "", readAt: Date.now(), owner });
    } catch (cause) {
      if (ticket === generation) update(row.key, { result: null, error: panelErrorWords(cause), readAt: null });
    }
  }
  async function readAccount(account: string, ticket: number): Promise<void> {
    // Account and pilot reads are serialized; a refresh never competes with an edit.
    settingsContexts = Object.fromEntries(Object.entries(settingsContexts).filter(([name]) => name !== account));
    rows = rows.map((row) => row.account === account ? { ...row, result: null, readAt: null, review: null, queue: null } : row);
    try {
      const roster = await readFactoryAccount(account);
      if (ticket !== generation) return;
      credentials.set(roster.account, roster.requestOptions);
      await readSettingsContext(roster.account, roster.requestOptions, ticket);
      const fresh = roster.characters.map((pilot) => makeRow(roster.account, pilot));
      rows = [...rows.filter((row) => row.account !== account && row.account !== roster.account), ...fresh];
      accounts = [...new Set(accounts.map((name) => name === account ? roster.account : name))];
      accountErrors = { ...accountErrors, [account]: "", [roster.account]: "" };
      if (fresh.length === 0) accountErrors = { ...accountErrors, [roster.account]: "No characters on this account." };
      for (const row of fresh) { if (ticket !== generation) return; await readPilot(row, ticket); }
    } catch (cause) {
      if (ticket !== generation) return;
      const reason = panelErrorWords(cause);
      settingsErrors = { ...settingsErrors, [account]: `Authenticate ${account} to load its corporation settings.` };
      accountErrors = { ...accountErrors, [account]: reason };
      rows = rows.map((row) => row.account === account ? { ...row, result: null, readAt: null, error: reason } : row);
    }
  }
  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    const ticket = ++generation;
    for (const account of accounts) { if (ticket !== generation) return; await readAccount(account, ticket); }
    if (ticket === generation) busy = false;
  }
  async function chooseEquipmentSource(row: PilotRow, kind: string, division = 1): Promise<void> {
    if (busy) return;
    const corporationID = row.result?.corporationID;
    try {
      if (!["hangar", "corp"].includes(kind) || (kind === "corp" && !corporationID)) throw new Error("SOURCE_CHANGED: refresh the target corporation before choosing its item division.");
      const source: TrainingEquipmentSource = kind === "corp" ? { kind: "corp", corporationID: corporationID!, division } : { kind: "hangar" };
      localStorage.setItem(equipmentSourceKey(row.account, row.pilot.characterID), JSON.stringify(source));
      update(row.key, { equipmentSource: source, equipmentReview: null, equipmentMessage: "" });
      busy = true; const ticket = ++generation;
      await readPilot({ ...row, equipmentSource: source }, ticket);
    } catch (cause) { update(row.key, { equipmentMessage: String(cause), equipmentReview: null }); }
    finally { busy = false; }
  }
  const equipmentIntent = (row: PilotRow) => JSON.stringify([row.prefs, row.equipmentSource]);
  async function reviewEquipment(row: PilotRow, configurationID: string): Promise<void> {
    if (busy || !row.equipmentSource) return;
    const options = credentials.get(row.account); if (!options) return;
    busy = true; const ticket = ++generation;
    update(row.key, { equipmentReview: null, equipmentOutcome: null, equipmentMessage: "Reading equipment plan…" });
    try {
      assertLocalPlan(row);
      const review = await reviewTrainingEquipment({ characterID: row.pilot.characterID, role: row.prefs.role,
        configurations: row.prefs.roles[row.prefs.role] || [], targetStage: row.prefs.targetStage, configurationID, source: row.equipmentSource }, options);
      if (ticket === generation) update(row.key, { equipmentReview: review, equipmentIntent: equipmentIntent(row), result: review.fresh,
        readAt: Date.now(), equipmentMessage: "Review only. Provision Equipment is an explicit separate action." });
    } catch (cause) { if (ticket === generation) update(row.key, { equipmentMessage: panelErrorWords(cause) }); }
    finally { if (ticket === generation) busy = false; }
  }
  async function provisionEquipment(row: PilotRow): Promise<void> {
    const accepted = row.equipmentReview?.applyReview, options = credentials.get(row.account);
    if (busy || !accepted?.canApply || !accepted.reviewHash || !options) return;
    busy = true; const ticket = ++generation;
    update(row.key, { equipmentReview: null, result: null, equipmentMessage: "Acquiring free-only control → revalidating → provisioning → verifying → releasing…" });
    try {
      assertLocalPlan(row);
      if (equipmentIntent(row) !== row.equipmentIntent || JSON.stringify(readEquipmentSource(localStorage, row.account, row.pilot.characterID)) !== JSON.stringify(row.equipmentSource)) throw new Error("PLAN_CHANGED: physical source changed; Review again.");
      const outcome = await applyTrainingEquipment(accepted.reviewID, accepted.reviewHash, options);
      if (ticket === generation) update(row.key, { equipmentOutcome: outcome, equipmentMessage: `${outcome.state}: ${outcome.reason || "authoritative equipment Review complete"}. Release: ${outcome.release.state}.` });
      await readPilot({ ...row, error: "" }, ticket);
    } catch (cause) { if (ticket === generation) update(row.key, { equipmentMessage: panelErrorWords(cause) }); }
    finally { if (ticket === generation) busy = false; }
  }
  async function recoverEquipment(row: PilotRow, id: string): Promise<void> {
    const options = credentials.get(row.account); if (busy || !options) return;
    busy = true; const ticket = ++generation;
    try { const outcome = await recoverTrainingEquipment(id, options);
      if (ticket === generation) update(row.key, { equipmentOutcome: outcome, equipmentMessage: `Control reconciliation: ${outcome.state} · ${outcome.release.state}` });
      await readPilot({ ...row, error: "" }, ticket);
    } catch (cause) { if (ticket === generation) update(row.key, { equipmentMessage: panelErrorWords(cause) }); }
    finally { if (ticket === generation) busy = false; }
  }
  async function addAccount(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const name = accountInput.trim();
    if (!name || busy) return;
    busy = true; error = "";
    const ticket = ++generation;
    try {
      const roster = await readFactoryAccount(name, {}, accountPassword);
      if (ticket !== generation) return;
      rememberFactoryAccount(localStorage, roster.account);
      accounts = [...new Set([...accounts, roster.account])];
      credentials.set(roster.account, roster.requestOptions);
      rows = [...rows.filter((row) => row.account !== roster.account), ...roster.characters.map((pilot) => makeRow(roster.account, pilot))];
      accountInput = "";
      await readSettingsContext(roster.account, roster.requestOptions, ticket);
      accountErrors = { ...accountErrors, [roster.account]: roster.characters.length ? "" : "No characters on this account." };
      for (const row of rows.filter((candidate) => candidate.account === roster.account)) await readPilot(row, ticket);
    } catch (cause) { if (ticket === generation) error = panelErrorWords(cause); }
    finally { accountPassword = ""; if (ticket === generation) busy = false; }
  }
  function newAccountReady(result: Awaited<ReturnType<typeof continueNewTrainee>>) {
    accounts = [...new Set([...accounts, result.account])];
    credentials.set(result.account, result.requestOptions);
    rows = [...rows.filter((r) => r.account !== result.account), ...result.characters.map((pilot) => makeRow(result.account, pilot))];
    accountPanel = null; creatorInitialName = result.characterName;
    creatingAccount = result.characters.length === 0 ? result.account : null;
    error = rememberCreatedAccount(localStorage, result.account);
    if (result.characters.length) error += " Recovered account already has characters. Inspect its roster before creating another.";
    void readSettingsContext(result.account, result.requestOptions, generation);
  }
  async function changePreferences(row: PilotRow, prefs: TrainingPreferences): Promise<void> {
    if (busy) return;
    try {
      saveTrainingPreferences(localStorage, row.account, row.pilot.characterID, prefs);
      update(row.key, { prefs, review: null, queueMessage: "", acquisition: null });
      if (prefs.role !== row.prefs.role || prefs.targetStage !== row.prefs.targetStage || JSON.stringify(prefs.roles) !== JSON.stringify(row.prefs.roles)) {
        busy = true;
        const ticket = ++generation;
        const fresh = makeRow(row.account, row.pilot);
        update(row.key, fresh);
        await readPilot(fresh, ticket);
        if (ticket === generation) busy = false;
      }
    } catch (cause) { error = `Local preferences could not be saved: ${String(cause)}`; busy = false; }
  }
  async function saveConfiguration(row: PilotRow, config: TrainingConfiguration): Promise<void> {
    try { await changePreferences(row, putConfiguration(row.prefs, config)); } catch (cause) { error = String(cause); }
  }
  async function configureFit(row: PilotRow, id: string, _fitID: number, fit?: CorporationSavedFitting): Promise<void> {
    const c = row.prefs.roles[row.prefs.role]?.find((entry) => entry.configurationID === id);
    if (!c || !fit || fit.invalid || fit.ownerID !== row.result?.corporationID || fit.shipTypeID !== c.hullTypeID || fit.fittingID !== c.fittingID || !fit.fingerprint || !fit.savedDate) return;
    await saveConfiguration(row, { ...c, acceptedFingerprint: fit.fingerprint, acceptedSavedDate: fit.savedDate });
  }
  async function chooseRole(row: PilotRow, role: string): Promise<void> {
    try { await changePreferences(row, setRole(row.prefs, role)); } catch (cause) { error = String(cause); }
  }
  const queueError = (cause: unknown) => cause instanceof BridgeCallError ? `${cause.code}: ${cause.message}` : String(cause);
  async function reviewAcquisition(row: PilotRow, policy: FundingPolicy, officerKey: string, division: number): Promise<void> {
    const options = credentials.get(row.account);
    if (busy || !row.result || !options || !row.prefs.role) return;
    busy = true;
    update(row.key, { acquisition: null, acquisitionMessage: "Reading live purchase authority; temporary sessions will be released…" });
    try {
      assertLocalPlan(row);
      const preview = row.result.report.previews[row.prefs.mode];
      const selections = configSelections(readTrainingPreferences(localStorage, row.account, row.pilot.characterID).roles[row.prefs.role] || []);
      if (JSON.stringify(selections) !== JSON.stringify(row.selections)) throw new Error("PLAN_CHANGED: refresh the fitting configuration.");
      const officer = rows.find((entry) => entry.key === officerKey);
      const token = officer && credentials.get(officer.account)?.token;
      const funding = policy === "CHARACTER_PLUS_CORPORATION_SHORTFALL" && officerKey !== "SELF" && officer && token ? { characterID: officer.pilot.characterID, token } : null;
      const acquisition = await reviewSkillAcquisition({ characterID: row.pilot.characterID, role: row.prefs.role, configurations: row.prefs.roles[row.prefs.role] || [], mode: row.prefs.mode,
        stage: preview.stage, targetStage: row.prefs.targetStage ?? null, displayedTargets: preview.targets.map(({ typeID, level }) => ({ typeID, level })), selections,
        policy, funding, fundingMode: officerKey === "SELF" ? "SELF" : "AUTHORITY", trainingWallet: settings.trainingWallet, division }, options);
      update(row.key, { acquisition, acquisitionFunding: funding, acquisitionSettingsHash: JSON.stringify(settings), acquisitionMessage: "No money has moved. Confirm the exact review below." });
    } catch (cause) { update(row.key, { acquisitionMessage: queueError(cause) }); }
    finally { busy = false; }
  }
  async function acquireSkills(row: PilotRow): Promise<void> {
    const review = row.acquisition;
    const options = credentials.get(row.account);
    if (busy || !review?.canAcquire || !review.reviewID || !options) return;
    busy = true;
    update(row.key, { acquisition: null, acquisitionMessage: "Acquiring exactly the reviewed skills…", review: null });
    try {
      if (review.mode !== row.prefs.mode || (readTrainingPreferences(localStorage, row.account, row.pilot.characterID).targetStage ?? null) !== (row.result?.report.targetStage ?? null) || JSON.stringify(configSelections(readTrainingPreferences(localStorage, row.account, row.pilot.characterID).roles[row.prefs.role] || [])) !== JSON.stringify(row.selections)) throw new Error("PLAN_CHANGED: review again.");
      assertLocalPlan(row);
      if (row.acquisitionSettingsHash !== JSON.stringify(readTrainingSettings(localStorage))) throw new Error("FUNDING_CHANGED: review settings again.");
      const outcome = await acquireFactorySkills(review.reviewID, row.acquisitionFunding, options);
      update(row.key, { acquisitionOutcome: outcome, acquisitionMessage: outcome.status, result: outcome.fresh,
        queue: outcome.fresh?.queue ?? null, acquisitionFunding: null });
      try { update(row.key, { owner: (await factoryOwnership(row.pilot.characterID, options)).owner }); } catch { update(row.key, { owner: "UNKNOWN" }); }
    } catch (cause) { update(row.key, { acquisitionMessage: `${queueError(cause)} Do not retry blindly; refresh skills and wallet first.` }); }
    finally { busy = false; }
  }
  async function reviewQueue(row: PilotRow): Promise<void> {
    if (busy || !row.result || !row.prefs.role) return;
    const options = credentials.get(row.account);
    if (!options) return;
    busy = true;
    const ticket = ++generation;
    update(row.key, { review: null, queueMessage: "" });
    try {
      assertLocalPlan(row);
      const preview = row.result.report.previews[row.prefs.mode];
      const selections = configSelections(readTrainingPreferences(localStorage, row.account, row.pilot.characterID).roles[row.prefs.role] || []);
      // Changing a local fit in another tab invalidates this displayed preview.
      if (JSON.stringify(selections) !== JSON.stringify(row.selections)) throw new Error("PLAN_CHANGED: fitting configuration changed; refresh first.");
      const review = await reviewTrainingQueue({ characterID: row.pilot.characterID, role: row.prefs.role, configurations: row.prefs.roles[row.prefs.role] || [], mode: row.prefs.mode,
        stage: preview.stage, targetStage: row.prefs.targetStage ?? null, displayedTargets: preview.targets.map(({ typeID, level }) => ({ typeID, level })), selections }, options);
      if (ticket === generation) update(row.key, { review, result: review.fresh, queue: review.queue, readAt: Date.now() });
    } catch (cause) {
      if (ticket === generation) {
        await readPilot({ ...row, error: "" }, ticket);
        update(row.key, { queueMessage: queueError(cause) });
      }
    } finally { if (ticket === generation) busy = false; }
  }
  function recordApply(row: PilotRow, outcome: QueueApplyOutcome): void {
    const { fresh: _fresh, queue: _queue, message: _message, ...record } = outcome;
    update(row.key, { lastApply: record });
    try { rememberQueueApply(localStorage, row.account, row.pilot.characterID, outcome); }
    catch { update(row.key, { queueMessage: `${outcome.message} Local audit record could not be saved.` }); }
  }
  async function applyQueue(row: PilotRow): Promise<void> {
    const reviewed = row.review;
    const options = credentials.get(row.account);
    if (busy || !reviewed?.canApply || !reviewed.reviewID || !options || !row.prefs.role) return;
    busy = true;
    const ticket = ++generation;
    // Disable repeat clicks immediately, even if transport fails.
    update(row.key, { review: null, queueMessage: "Applying reviewed append…" });
    try {
      const selections = configSelections(readTrainingPreferences(localStorage, row.account, row.pilot.characterID).roles[row.prefs.role] || []);
      if (row.prefs.mode !== reviewed.mode || (readTrainingPreferences(localStorage, row.account, row.pilot.characterID).targetStage ?? null) !== (row.result?.report.targetStage ?? null) || JSON.stringify(selections) !== JSON.stringify(row.selections))
        throw new Error("PLAN_CHANGED: local configuration changed; review again.");
      assertLocalPlan(row);
      const outcome = await applyTrainingQueue(reviewed.reviewID, options);
      if (ticket !== generation) return;
      update(row.key, { result: outcome.fresh, queue: outcome.queue, queueMessage: `${outcome.status}${outcome.code ? ` · ${outcome.code}` : ""}: ${outcome.message}`,
        readAt: outcome.queue ? Date.now() : null });
      recordApply(row, outcome);
    } catch (cause) {
      if (ticket !== generation) return;
      const message = queueError(cause);
      const refused = !(cause instanceof BridgeCallError) || (cause.status >= 400 && cause.status < 500);
      recordApply(row, { status: refused ? "REFUSED" : "APPLY_UNVERIFIED", verified: false, mode: reviewed.mode,
        stage: reviewed.stage || "Unknown", at: Date.now(), added: null, attemptedAdditions: reviewed.additions.length,
        code: cause instanceof BridgeCallError ? cause.code : "PLAN_CHANGED", message, fresh: null, queue: null });
      await readPilot({ ...row, error: "" }, ticket);
      if (ticket === generation) update(row.key, { queueMessage: `${refused ? "REFUSED" : "APPLY_UNVERIFIED"}: ${message} No automatic retry. Review again.` });
    } finally { if (ticket === generation) busy = false; }
  }
  onMount(() => {
    document.title = "Pilot Training · EveJS Web";
    const freshnessClock = setInterval(() => observationNow = Date.now(), 1000);
    try { settings = readTrainingSettings(localStorage); } catch (cause) { error = String(cause); }
    const ticket = generation;
    void (async () => {
      const known = loadKnownCharacters();
      rows = known.map((pilot) => makeRow(pilot.accountName, { characterID: pilot.characterID, name: pilot.characterName }));
      try { accounts = [...new Set([...known.map((pilot) => pilot.accountName), ...readFactoryAccounts(localStorage)])]; }
      catch { error = "Saved Pilot Training account list is unreadable."; }
      // Discover normal WC authentication, without creating a cockpit or flow.
      try {
        const current = await loadTrainingCharacters();
        if (ticket !== generation) return;
        accounts = [...new Set([...accounts, current.account])];
      } catch { /* A direct signed-out visit offers existing-account sign-in. */ }
      if (ticket !== generation) return;
      ready = true;
      await refresh();
    })();
    return () => clearInterval(freshnessClock);
  });
  onDestroy(() => { generation++; credentials.clear(); });
</script>

<main class="factory">
  <header class="factory-head">
    <div><p class="eyebrow">EveJS Web · control plane</p><h1>Pilot Training</h1><p>Corporation fitting qualifications and reviewed training queue append</p></div>
    <nav><a href="/" target="_blank" rel="noopener">Pilot Hangar</a><button type="button" class="minor" disabled={busy || !ready} onclick={refresh}>{busy ? "Reading…" : "Refresh roster"}</button></nav>
  </header>
  <div class="factory-controls">
    <button type="button" disabled={busy || !ready || !!creatingAccount} onclick={() => accountPanel = "NEW"}>+ New trainee</button>
    <button type="button" class="minor" disabled={busy || !ready || !!creatingAccount} onclick={() => accountPanel = accountPanel === "EXISTING" ? null : "EXISTING"}>Use existing account</button>
  </div>
  {#if accountPanel === "NEW"}<NewTrainee externalBusy={busy} onContinue={newAccountReady} onBusy={(value) => busy = value} onCancel={() => accountPanel = null} />{/if}
  <p class="note">Skill qualification does not establish equipment readiness. Qualification and queue reads stay offline. Skill acquisition explicitly opens temporary live sessions for free pilots and releases them afterward.</p>
  <TrainingSettingsPanel {settings} {busy} {corporations} authorities={settingsAuthorities} {homeAccessPilots} bind:homeAccessPilot contextError={Object.values(settingsErrors).filter(Boolean).join(" ")} onSave={saveSettings} onResolve={resolveHome} onSearch={searchHomes} />
  {#if onboardingMessage}<p role="status">{onboardingMessage}</p>{/if}
  {#if onboardingReview}
    <p>Onboarding: pilot {onboardingReview.value.characterID} → corporation {onboardingReview.value.corporationID}; authority {onboardingReview.value.authorityID}; rights {onboardingReview.value.rights}. CEO {onboardingReview.value.ceoID} stays unchanged.</p>
    <button type="button" disabled={busy} onclick={() => { const r = rows.find((r) => r.key === onboardingReview?.rowKey); if (r) void onboard(r, true); }}>Confirm reviewed onboarding / rights</button>
  {/if}
  {#if accountPanel === "EXISTING"}
  <form class="factory-controls" onsubmit={addAccount}>
    <label>Existing account <input aria-label="Existing account" bind:value={accountInput} disabled={busy || !ready} placeholder="Account name" autocomplete="username" /></label>
    <label>Password <input type="password" bind:value={accountPassword} autocomplete="current-password" disabled={busy} /></label>
    <button class="minor" disabled={busy || !ready || !accountInput.trim()}>Sign in / add to roster</button>
    <span class="note">Normal WC authentication; unknown names are refused. No account creation.</span>
  </form>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#each Object.entries(accountErrors).filter(([, message]) => message) as [account, message] (account)}
    <p class="error">{account}: {message}</p>
  {/each}
  {#if creatingAccount}
    <section><h2>Create on account: {creatingAccount}</h2>
      <CharacterCreate initialName={creatorInitialName} flow={creatorFlow(creatingAccount)} onCancel={() => creatingAccount = null}
        onCreated={(id) => { if (creatingAccount) void created(creatingAccount, id); }} />
    </section>
  {:else if accountPanel === "EXISTING"}
    <div class="factory-controls">
      <label>New trainee account <select bind:value={newTraineeAccount} disabled={busy}>
        <option value="">Choose an authenticated account</option>
      {#each accounts.filter((account) => credentials.has(account) && (!accountErrors[account] || accountErrors[account] === "No characters on this account.")) as account}
        <option value={account}>{account}</option>
      {/each}
      </select></label>
      <button class="minor" type="button" disabled={busy || !newTraineeAccount} onclick={() => { creatorInitialName = ""; creatingAccount = newTraineeAccount; }}>Open character creator</button>
      <span class="note">Uses the existing character creator; authoritative free slots are checked before creation.</span>
    </div>
  {/if}
  <div class="factory-controls">
    <label>Search <input aria-label="Search account or character" bind:value={query} placeholder="Account or character" /></label>
    <label>Status <select bind:value={filter}><option value="ALL">All</option>{#each Object.entries(factoryStatusLabels) as [value, label]}<option {value}>{label}</option>{/each}</select></label>
    <span>{visible.length} / {rows.length} pilots</span>
  </div>
  {#if !ready}<p>Loading known accounts…</p>{/if}
  {#if ready && !busy && rows.length === 0}<p>No pilots yet. Create a new trainee or use an existing account above.</p>{/if}
  <div class="factory-roster">
    {#each visible as row (row.key)}
      {@const report = row.result?.report}
      {@const preview = report?.previews[row.prefs.mode]}
      {@const status = factoryStatus(report ?? null, row.prefs.mode, row.error)}
      {@const dutyStage = report?.stages.find(stage => stage.id === (row.prefs.targetStage || report.currentStage || report.nextStage))}
      {@const readiness = equipmentState(dutyStage, observationNow)}
      <article class="factory-card">
        <header><div><p class="eyebrow">Account · {row.account}</p><h2>{row.pilot.name}</h2></div><strong>{factoryStatusLabels[status]}</strong></header>
        <p class="note">Character #{row.pilot.characterID} · Corporation: {row.pilot.corporationName ?? row.pilot.corporationID ?? "Unknown"}</p>
        {#if settings.onboarding.enabled}<button class="minor" disabled={busy} onclick={() => void onboard(row)}>Review corporation onboarding / rights</button>{/if}
        <div class="factory-controls">
          <label>Role <select aria-label={`Role for ${row.pilot.name}`} value={row.prefs.role} disabled={busy} onchange={(event) => void chooseRole(row, event.currentTarget.value)}>
            <option value="">Unassigned</option>{#each [...new Set(["MINER", "HAULER", "GUARD", ...Object.keys(row.prefs.roles)])] as role}<option value={role}>{role}</option>{/each}
          </select></label>
          <label>Custom role <input aria-label={`Custom role for ${row.pilot.name}`} placeholder="ROLE_ID" disabled={busy} onchange={(event) => { if (event.currentTarget.value.trim()) void chooseRole(row, event.currentTarget.value.trim().toUpperCase()); }} /></label>
          <label>Target qualification <select aria-label={`Target qualification for ${row.pilot.name}`} value={row.prefs.targetStage ?? ""} disabled={busy} onchange={(event) => void changePreferences(row, { ...row.prefs, targetStage: event.currentTarget.value || null })}>
            <option value="">Automatic (next / current mastery)</option>
            {#each row.prefs.roles[row.prefs.role] || [] as config}<option value={config.configurationID}>{qualificationName(report, config.configurationID)}</option>{/each}
          </select></label>
          <label>Plan <select aria-label={`Plan for ${row.pilot.name}`} value={row.prefs.mode} disabled={busy} onchange={(event) => void changePreferences(row, { ...row.prefs, mode: event.currentTarget.value as PlanMode })}>
            <option>FAST</option><option disabled={!report || report.previews.BALANCED.disabled}>BALANCED</option><option disabled={!report || report.previews.MASTERY.disabled}>MASTERY</option>
          </select></label>
        </div>
        <dl>
          <div><dt>Highest proven qualification</dt><dd>{report?.currentStage ? qualificationName(report, report.currentStage) : "None proven"}</dd></div>
          <div><dt>Next qualification</dt><dd>{report ? report.nextStage ? qualificationName(report, report.nextStage) : "None" : "Unknown"}</dd></div>
          <div><dt>Queue state</dt><dd>{report?.trainingState ?? "UNKNOWN"}</dd></div>
          <div><dt>Skills · {dutyStage?.fitName || "No target"}</dt><dd>{dutyStage?.skillQualification || "UNKNOWN"}</dd></div>
          <div><dt>Equipment</dt><dd>{readiness.equipment}</dd></div>
          <div><dt>Supplies</dt><dd>{readiness.supplies}</dd></div>
          <div><dt>Overall</dt><dd>{readiness.duty}</dd></div>
          <div><dt>Plan ETA</dt><dd>{!preview ? "UNKNOWN" : preview.eta.kind === "READY" ? "Already trained" : preview.eta.kind === "SERVER_QUEUE" ? `${formatDuration(preview.eta.remainingMs)} · server queue` : "UNKNOWN"}</dd></div>
        </dl>
        {#if !row.prefs.role}<p class="note">Select a role explicitly. FAST supports any valid corporation fitting. Support policies are optional.</p>{/if}
        {#if row.error}<p class="error" role="alert">{row.error}</p>{/if}
        {#if preview?.eta.kind === "UNKNOWN"}<p class="note">{preview.eta.reason}</p>{/if}
        {#if report?.stages.some((stage) => stage.fitting.status !== "READY")}<p class="note">One or more configured fittings need review. This roster status covers all configurations; the selected plan is validated separately.</p>{/if}
        {#if row.readAt}<p class="note">Read at {new Date(row.readAt).toLocaleTimeString()} · refresh to update</p>{/if}
        {#if row.result || row.queue || row.lastApply}
          <button class="minor" type="button" onclick={() => expanded = expanded === row.key ? null : row.key}>{expanded === row.key ? "Hide qualifications" : "Training ships and plan"}</button>
          {#if expanded === row.key}
            <div class="factory-controls">
              <label>Equipment physical source <select aria-label={`Equipment physical source for ${row.pilot.name}`} disabled={busy} value={row.equipmentSource?.kind || ""} onchange={(event) => void chooseEquipmentSource(row, event.currentTarget.value)}>
                {#if !row.equipmentSource}<option value="">Choose source</option>{/if}<option value="hangar">Personal local hangar</option><option value="corp" disabled={!row.result?.corporationID}>Local corporation division</option>
              </select></label>
              {#if row.equipmentSource?.kind === "corp"}<label>Item division <select aria-label={`Equipment item division for ${row.pilot.name}`} disabled={busy} value={row.equipmentSource.division} onchange={(event) => void chooseEquipmentSource(row, "corp", Number(event.currentTarget.value))}>
                {#each [1,2,3,4,5,6,7] as division}<option value={division}>{division}</option>{/each}
              </select></label><span>Corporation {row.equipmentSource.corporationID}; no personal fallback.</span>{/if}
            </div>
            {#if row.result}<MinerQualification result={row.result} selections={row.selections} mode={row.prefs.mode} {busy} now={observationNow}
              onReviewEquipment={(id) => void reviewEquipment(row, id)} equipmentSourceReady={!!row.equipmentSource}
              configurations={row.prefs.roles[row.prefs.role] || []} role={row.prefs.role}
              onSave={(config) => void saveConfiguration(row, config)} onRemove={(id) => void changePreferences(row, removeConfiguration(row.prefs, id))}
              onSelect={(stage, id) => void configureFit(row, stage, id)}
              onAccept={(stage, fit) => void configureFit(row, stage, fit.fittingID, fit)} />{/if}
            <TrainingEquipmentPlan review={row.equipmentReview} outcome={row.equipmentOutcome} message={row.equipmentMessage} {busy}
              onApply={() => void provisionEquipment(row)} onRecover={(id) => void recoverEquipment(row, id)} />
            <p>Session ownership: {row.owner} · Ownership is rechecked before temporary login.</p>
            {#if row.prefs.role}<TrainingQueueReview result={row.result} queue={row.queue} review={row.review}
              mode={row.prefs.mode} {busy} message={row.queueMessage} lastApply={row.lastApply}
              onReview={() => void reviewQueue(row)} onApply={() => void applyQueue(row)} />{/if}
            {#if row.prefs.role && (row.review?.blockers.some((blocker) => blocker.code === "SKILLBOOK_REQUIRED") || row.acquisition || row.acquisitionOutcome || row.acquisitionMessage)}
              <SkillAcquisition review={row.acquisition} outcome={row.acquisitionOutcome} {busy} mode={row.prefs.mode}
                targetName={(id) => row.result ? qualificationName(row.result.report, id) : id}
                stage={row.result?.report.previews[row.prefs.mode].stage ? qualificationName(row.result.report, row.result.report.previews[row.prefs.mode].stage) : null}
                trainingWallet={settings.trainingWallet} message={row.acquisitionMessage}
                officers={rows.filter((entry) => entry.key !== row.key).map((entry) => ({ key: entry.key, label: `${entry.account} · ${entry.pilot.name}` }))}
                onReview={(policy, officer, division) => void reviewAcquisition(row, policy, officer, division)}
                onAcquire={() => void acquireSkills(row)} onChange={() => update(row.key, { acquisition: null })} />
            {/if}
          {/if}
        {/if}
      </article>
    {/each}
  </div>
</main>

<style>
  .factory { max-width: 1400px; margin: auto; padding: 2rem; }
  .factory-head, .factory-card > header, nav, .factory-controls { display: flex; align-items: center; gap: 1rem; justify-content: space-between; flex-wrap: wrap; }
  .factory-head h1 { font-size: 2.3rem; margin: .25rem 0; }
  .eyebrow { font-size: .85rem; opacity: .7; margin: 0; }
  .factory-controls { justify-content: flex-start; margin: 1rem 0; }
  label { display: flex; align-items: center; gap: .5rem; }
  input, select { padding: .45rem; border: 1px solid #455569; border-radius: 4px; background: #16202e; color: #e4edf7; }
  .factory-roster { display: grid; gap: 1rem; }
  .factory-card { padding: 1.25rem; border: 1px solid #364252; border-radius: 8px; background: #121b27; }
  h2 { margin: .25rem 0; }
  dl { display: flex; flex-wrap: wrap; gap: 1rem 2rem; }
  dt { opacity: .65; font-size: .85rem; } dd { margin: .25rem 0; }
  @media (max-width: 650px) { .factory { padding: 1rem; } .factory-head { align-items: flex-start; } }
</style>
