<script lang="ts">
  // freelanceprojects project_creation: open_create_project_window - CreateProjectWindow (min 400 wide; small header)
  // with CreateProjectForm (CreateJobFormTitle): four collapsible sections, one open at a time, then the CostSummary.
  // 1 JobDefinitionFormTitle: the contribution method (ContributionMethodInputLabel; the latest definitions by their
  // title, ContributionMethodInputDescription placeholder, required); with one chosen its parameters (the delivery's
  // item type - item types or groups - and its delivery locations, the corporation's offices, up to max_entries; both
  // required), the target (the method's target_description, at least 1; TargetValueInputHint), the three modifiers
  // where the method has them, the end date (SetEndDateTitle; 7 days, 2 weeks, 1, 3, 6 months; at least 15 minutes
  // ahead). 2 AccessAndVisibilityFormTitle: BroadcastingLocations (the offices, their solar systems; up to the creation
  // limits' max_broadcasting_locations_per_project), CharacterAge (MinAge / MaxAge, optional, min never above max),
  // MaxCommittedParticipants (1 to the limit; empty - the limit), RestrictWithACL. 3 Description: Name (5-60, single
  // spaces, no < >), Description (at most 1000), CareerPath (Unclassified and the four; set to the method's first
  // career content tag when the method changes). 4 PaymentFormTitle: PayoutPerUnit (the method's reward_description,
  // PayoutPerUnitHint {divisionName}), RewardLimitPerContributor where a per-participant limit is set.
  // CostSummary: base fee (per day x days, days the end date's distance rounded up, at least 1; BaseFeeHint),
  // broadcasting fee (per day per location x days x locations), rewards (payout x target), the total, the active
  // wallet and its balance (danger where short; then InsufficientFunds stops the submit). Create New: CreateRequest with
  // the expected cost; a failure's message is error_messages.get_create_error_label. Cancel asks
  // CancelFreelanceProjectCreation.
  // Not here: the access list (RestrictWithACL - EveJS refuses an ACL), item groups, methods other than a delivery.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, FreelanceCreation, FreelanceMethod } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow, onClose }: { store: ClientStore; flow: AppFlow; onClose: (made: boolean) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const C = "UI/Corporations/FreelanceProjects/CreateProject/", S = C + "CostSummary/";
  const LABELS = [...["CreateJobFormTitle", "JobDefinitionFormTitle", "ContributionMethodInputLabel", "ContributionMethodInputHint", "ContributionMethodInputDescription",
    "TargetValueInputHint", "TargetValueInputLabel", "SetEndDateTitle", "SetEndDateHint", "AccessAndVisibilityFormTitle", "BroadcastingLocationsTitle", "BroadcastingLocationsHint",
    "BroadcastingLocationsPlaceholder", "CharacterAgeTitle", "CharacterAgeHint", "MinAgeTitle", "MaxAgeTitle", "OptionalPlaceholder", "MaxCommittedParticipantsTitle",
    "MaxCommittedParticipantsHint", "LimitPlaceholder", "NameInputHint", "DescriptionInputHint", "JobDescriptionInputFieldText", "CareerPathInputHint", "PaymentFormTitle",
    "PayoutPerUnitTitle", "PayoutPerUnitHint", "RewardLimitPerContributor", "InsufficientFunds", "CreateNewButton", "MaxContributionsPerParticipantTitle",
    "MaxContributionsPerParticipantHint", "MaxProgressPerContributionTitle", "MaxProgressPerContributionHint", "ContributionMultiplierTitle", "ContributionMultiplierHint"].map((k) => C + k),
    ...["CostSummaryTitle", "BaseFeeTitle", "BaseFeeHint", "BroadcastingFeeTitle", "BroadcastingFeeHint", "RewardsTitle", "RewardsHint", "TotalCostTitle", "ActiveWalletTitle",
      "ActiveWalletBalanceTitle"].map((k) => S + k),
    "UI/Common/Name", "UI/Common/Description", "Character/CareerPaths/CareerPath", "Character/CareerPaths/Unclassified", "UI/Common/Cancel", "UI/Common/ISK",
    "UI/Control/Form/InputRequired", "UI/Control/Form/LengthBetweenRequired", "UI/Control/Form/LengthBelowRequired", "UI/Control/Form/OnlySingleWhitespacesAllowed",
    "UI/Control/Form/IllegalCharacters", "UI/Corporations/Common/CorporateDivisionMasterWallet", "UI/Corporations/Goals/TypeInName",
    ...["Day", "Week", "Month"].map((k) => `/Carbon/UI/Common/WrittenDateTimeQuantity/${k}`)];
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  const msg = (id: number) => (id ? word(`#${id}`) : "");
  // eveformat currency.isk: two places and ISK.
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  let data = $state<FreelanceCreation | null>(null), careerNames = $state<Record<number, number>>({});
  onMount(() => {
    flow.requestWords(LABELS);
    void flow.freelanceCreation().then((d) => {
      data = d;
      flow.requestWords(d.methods.flatMap((m) => [m.title, m.description, m.progressDescription, m.targetDescription, m.rewardDescription,
        ...(m.delivery ? [m.delivery.title, m.delivery.itemTitle, m.delivery.itemDescription, m.delivery.locationTitle, m.delivery.locationDescription] : [])]).filter(Boolean).map((n) => `#${n}`));
    }, () => { data = { methods: [], version: null, baseFeePerDay: null, broadcastFeePerDay: null, limits: null, offices: [], wallet: null }; });
    void flow.certifiedSkillPlans().then((r) => { if (r) { careerNames = Object.fromEntries(r.careerPaths.filter((c) => c.nameID !== null).map((c) => [c.careerPathID, c.nameID!])); flow.requestWords(Object.values(careerNames).map((n) => `#${n}`)); } }, () => {});
  });

  let section = $state(1), tried = $state(false), submitting = $state(false), failure = $state("");
  let methodName = $state(""), target = $state(1), maxContributions = $state<number | null>(null), maxProgress = $state<number | null>(null), multiplier = $state<number | null>(null);
  let itemTypes = $state<{ id: number; name: string }[]>([]), deliveryStations = $state<number[]>([]), broadcastStations = $state<number[]>([]);
  let typeSearch = $state(""), typeFound = $state<readonly { typeID: number; name: string; category: string }[]>([]);
  let expiry = $state(new Date(Date.now() + 7 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  let minAge = $state<number | null>(null), maxAge = $state<number | null>(null), maxCommitted = $state<number | null>(null);
  let name = $state(""), description = $state(""), career = $state(0), payout = $state(0);
  const method = $derived<FreelanceMethod | null>(data?.methods.find((m) => m.name === methodName) ?? null);
  // CONTENT_TAG_TO_CAREER_PATH: the method's first career tag.
  const TAG_CAREERS: Record<string, number> = { career_path_explorer: 4, career_path_industrialist: 5, career_path_enforcer: 6, career_path_soldier_of_fortune: 7 };
  function chooseMethod(name: string): void {
    methodName = name;
    const m = data?.methods.find((x) => x.name === name) ?? null;
    career = m?.contentTags.map((t) => TAG_CAREERS[t]).find((c) => c !== undefined) ?? 0;
    payout = name === "ShipInsurance" ? 1 : 0;
    maxContributions = m?.maxContributions?.default ?? null; maxProgress = m?.maxProgress?.default ?? null;
    multiplier = m?.multiplier?.default !== null && m?.multiplier?.default !== undefined ? Math.round(m.multiplier.default * 100) : null;
    itemTypes = []; deliveryStations = [];
  }
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function findTypes(text: string): void {
    typeSearch = text;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => { typeFound = text.trim().length < 3 ? [] : (await flow.marketTypeMatches(text)).matches.slice(0, 50); }, 250);
  }
  // formFields DateTime presets: SetValueFromNow(days / weeks / months).
  function preset(span: string): void {
    const d = new Date();
    if (span === "7d") d.setDate(d.getDate() + 7); else if (span === "2w") d.setDate(d.getDate() + 14); else d.setMonth(d.getMonth() + Number(span.replace("m", "")));
    expiry = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  const PRESETS: readonly [string, string, number][] = [["7d", "Day", 7], ["2w", "Week", 2], ["1m", "Month", 1], ["3m", "Month", 3], ["6m", "Month", 6]];
  const endTime = $derived(new Date(expiry).getTime());
  // duration_calculator.get_duration_in_days: days rounded up, at least 1; an end under 15 minutes ahead is invalid.
  const endValid = $derived(Number.isFinite(endTime) && endTime - Date.now() >= 15 * 60000);
  const days = $derived(endValid ? Math.max(1, Math.ceil(Math.floor((endTime - Date.now()) / 1000) / 86400)) : 1);
  const broadcastSystems = $derived([...new Set(broadcastStations.map((s) => data?.offices.find((o) => o.stationID === s)?.solarSystemID).filter((x): x is number => typeof x === "number"))]);
  const baseFee = $derived((data?.baseFeePerDay ?? 0) * days);
  const broadcastFee = $derived((data?.broadcastFeePerDay ?? 0) * days * broadcastSystems.length);
  const rewards = $derived(payout * (target || 1));
  const total = $derived(baseFee + broadcastFee + rewards);
  const balance = $derived(data?.wallet?.balance ?? null);
  const short = $derived(balance !== null && total > balance);
  const walletName = $derived(data?.wallet ? (data.wallet.accountKey === 1000 ? word("UI/Corporations/Common/CorporateDivisionMasterWallet") : data.wallet.name ?? "") : "");

  const nameError = $derived.by(() => {
    if (name.length < 5 || name.length > 60) return word("UI/Control/Form/LengthBetweenRequired", { minLength: 5, maxLength: 60, length: name.length });
    if (/[\t\n\r\f\v]+|[ ]{2,}/.test(name)) return word("UI/Control/Form/OnlySingleWhitespacesAllowed");
    const bad = [...new Set([...name].filter((c) => "><".includes(c)))];
    if (bad.length) return word("UI/Control/Form/IllegalCharacters", { characters: bad.join(", ") });
    return "";
  });
  const descriptionError = $derived(description.length > 1000 ? word("UI/Control/Form/LengthBelowRequired", { maxLength: 1000, length: description.length })
    : /[\t\n\r\f\v]+|[ ]{2,}/.test(description) ? word("UI/Control/Form/OnlySingleWhitespacesAllowed") : "");
  const methodError = $derived(!method ? word("UI/Control/Form/InputRequired") : "");
  const deliveryError = $derived(method?.delivery && (!itemTypes.length || !deliveryStations.length) ? word("UI/Control/Form/InputRequired") : "");
  const definitionValid = $derived(!methodError && !deliveryError && target >= 1 && endValid && !method?.otherParameters);
  const valid = $derived(definitionValid && !nameError && !descriptionError && payout >= 0 && !short && Boolean(data?.version));

  async function create(): Promise<void> {
    tried = true; failure = "";
    if (!valid || !method || !data?.version) { section = !definitionValid ? 1 : nameError || descriptionError ? 3 : 4; if (short) failure = word(C + "InsufficientFunds"); return; }
    submitting = true;
    try {
      const error = await flow.createFreelanceProject({ name, description, careerPath: career, target, method: method.name, version: data.version,
        itemTypes: itemTypes.map((t) => t.id), itemGroups: [], deliveryStations, endTime, broadcastSystems, payoutPerUnit: payout,
        expectedCost: { baseFee, broadcastingFee: broadcastFee, rewardDeposit: rewards, totalCost: total },
        maxCommitted: maxCommitted ?? data.limits?.maxCommitted ?? 1000, maxContributions: method.maxContributions ? maxContributions : null,
        maxProgress: method.maxProgress ? maxProgress : null, multiplier: method.multiplier ? multiplier : null, minAge, maxAge });
      if (!error) { onClose(true); return; }
      flow.requestWords([error.label]);
      await new Promise((r) => setTimeout(r, 300));
      failure = word(error.label, error.values) || error.label;
    } finally { submitting = false; }
  }
  async function cancel(): Promise<void> {
    if (!methodName && !name && !description) { onClose(false); return; }
    if (await flow.askClientDialog("CancelFreelanceProjectCreation", "Discard this job?")) onClose(false);
  }
  const intOrNull = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.floor(Number(v)) || 0));
  // The section headers once filled (ProjectDefinitionCollapsibleSection "n X <target description>"; the name).
  const head = (n: number, label: string) => (n === 1 && section !== 1 && definitionValid ? `${target.toLocaleString("en-US")} X ${msg(method?.targetDescription ?? 0)}`
    : n === 3 && section !== 3 && name && !nameError ? name : label);
</script>

<div class="ff-back">
  <div class="ff" role="dialog" aria-label={word(C + "CreateJobFormTitle")}>
    <header><span>{word(C + "CreateJobFormTitle")}</span><button class="ff-x" onclick={() => void cancel()}>✕</button></header>
    {#if !data}<p class="ff-note">…</p>
    {:else}
    <div class="ff-body">
      <section class:open={section === 1}>
        <button class="ff-head" onclick={() => { section = 1; }}>1. {head(1, word(C + "JobDefinitionFormTitle"))}</button>
        {#if section === 1}
          <label class="ff-field" title={word(C + "ContributionMethodInputHint")}>{word(C + "ContributionMethodInputLabel")}
            <select value={methodName} onchange={(e) => chooseMethod(e.currentTarget.value)}>
              <option value="" disabled>{word(C + "ContributionMethodInputDescription")}</option>
              {#each data.methods as m (m.name)}<option value={m.name} title={msg(m.description)}>{msg(m.title) || m.name}</option>{/each}
            </select>{#if tried && methodError}<small class="ff-error">{methodError}</small>{/if}</label>
          {#if method}
            {#if method.delivery}
              {@const d = method.delivery}
              <div class="ff-field ff-indent" title={msg(d.itemDescription)}>{msg(d.itemTitle)}
                <div class="ff-chips">{#each itemTypes as t (t.id)}<span class="ff-chip">{t.name}<button onclick={() => { itemTypes = itemTypes.filter((x) => x.id !== t.id); }}>✕</button></span>{/each}</div>
                <input type="search" placeholder={word("UI/Corporations/Goals/TypeInName")} value={typeSearch} oninput={(e) => findTypes(e.currentTarget.value)} />
                {#if typeFound.length}<div class="ff-found">{#each typeFound as t (t.typeID)}<button onclick={() => { if (!itemTypes.some((x) => x.id === t.typeID) && itemTypes.length < 10) itemTypes = [...itemTypes, { id: t.typeID, name: t.name }]; typeSearch = ""; typeFound = []; }}>{t.name} <small>{t.category}</small></button>{/each}</div>{/if}
              </div>
              <div class="ff-field ff-indent" title={msg(d.locationDescription)}>{msg(d.locationTitle)}
                {#each data.offices as o (o.stationID)}<label class="ff-check"><input type="checkbox" checked={deliveryStations.includes(o.stationID)} disabled={!deliveryStations.includes(o.stationID) && deliveryStations.length >= d.maxLocations}
                  onchange={(e) => { deliveryStations = e.currentTarget.checked ? [...deliveryStations, o.stationID] : deliveryStations.filter((x) => x !== o.stationID); }} />{o.name}</label>{/each}
                {#if tried && deliveryError}<small class="ff-error">{deliveryError}</small>{/if}
              </div>
            {/if}
            {#if method.otherParameters}<p class="ff-note ff-error">{method.name}</p>{/if}
            <label class="ff-field ff-indent" title={word(C + "TargetValueInputHint")}>{msg(method.targetDescription) || word(C + "TargetValueInputLabel")}
              <input type="number" min="1" bind:value={target} /></label>
            {#if method.maxContributions}<label class="ff-field ff-indent" title={word(C + "MaxContributionsPerParticipantHint")}>{word(C + "MaxContributionsPerParticipantTitle")}
              <input type="number" min="1" max={target} placeholder={word(C + "LimitPlaceholder")} value={maxContributions ?? ""} oninput={(e) => { maxContributions = intOrNull(e.currentTarget.value); }} /></label>{/if}
            {#if method.maxProgress}<label class="ff-field ff-indent" title={word(C + "MaxProgressPerContributionHint")}>{word(C + "MaxProgressPerContributionTitle")}
              <input type="number" min="1" placeholder={word(C + "LimitPlaceholder")} value={maxProgress ?? ""} oninput={(e) => { maxProgress = intOrNull(e.currentTarget.value); }} /></label>{/if}
            {#if method.multiplier}<label class="ff-field ff-indent" title={word(C + "ContributionMultiplierHint")}>{word(C + "ContributionMultiplierTitle")}
              <input type="number" min={Math.round(method.multiplier.min * 100)} max={Math.round(method.multiplier.max * 100)} value={multiplier ?? ""} oninput={(e) => { multiplier = intOrNull(e.currentTarget.value); }} /></label>{/if}
            <div class="ff-field ff-indent" title={word(C + "SetEndDateHint")}>{word(C + "SetEndDateTitle")}
              <div class="ff-presets">{#each PRESETS as [key, unit, n] (key)}<button onclick={() => preset(key)}>{word(`/Carbon/UI/Common/WrittenDateTimeQuantity/${unit}`, { units: n })}</button>{/each}</div>
              <input type="datetime-local" bind:value={expiry} />{#if !endValid}<small class="ff-error">≥ 15 min</small>{/if}
            </div>
          {/if}
        {/if}
      </section>
      <section class:open={section === 2}>
        <button class="ff-head" onclick={() => { section = 2; }}>2. {word(C + "AccessAndVisibilityFormTitle")}</button>
        {#if section === 2}
          <div class="ff-field ff-indent" title={word(C + "BroadcastingLocationsHint")}>{word(C + "BroadcastingLocationsTitle")}
            {#if !broadcastStations.length}<small class="ff-dim">{word(C + "BroadcastingLocationsPlaceholder")}</small>{/if}
            {#each data.offices as o (o.stationID)}<label class="ff-check"><input type="checkbox" checked={broadcastStations.includes(o.stationID)} disabled={!o.solarSystemID || (!broadcastStations.includes(o.stationID) && broadcastStations.length >= (data.limits?.maxBroadcastLocations ?? 20))}
              onchange={(e) => { broadcastStations = e.currentTarget.checked ? [...broadcastStations, o.stationID] : broadcastStations.filter((x) => x !== o.stationID); }} />{o.name}</label>{/each}
          </div>
          <div class="ff-field ff-indent" title={word(C + "CharacterAgeHint")}>{word(C + "CharacterAgeTitle")}
            <div class="ff-row">
              <label>{word(C + "MinAgeTitle")}<input type="number" min="0" max={data.limits?.maxAgeDays} placeholder={word(C + "OptionalPlaceholder")} value={minAge ?? ""}
                onchange={(e) => { minAge = intOrNull(e.currentTarget.value); if (minAge !== null && maxAge !== null && minAge > maxAge) minAge = maxAge; }} /></label>
              <label>{word(C + "MaxAgeTitle")}<input type="number" min="0" max={data.limits?.maxAgeDays} placeholder={word(C + "OptionalPlaceholder")} value={maxAge ?? ""}
                onchange={(e) => { maxAge = intOrNull(e.currentTarget.value); if (minAge !== null && maxAge !== null && minAge > maxAge) maxAge = minAge; }} /></label>
            </div>
          </div>
          <label class="ff-field ff-indent" title={word(C + "MaxCommittedParticipantsHint", { absoluteMaximum: (data.limits?.maxCommitted ?? 0).toLocaleString("en-US") })}>{word(C + "MaxCommittedParticipantsTitle")}
            <input type="number" min="1" max={data.limits?.maxCommitted} placeholder={word(C + "LimitPlaceholder")} value={maxCommitted ?? ""}
              onchange={(e) => { const v = intOrNull(e.currentTarget.value); maxCommitted = v === null ? null : Math.min(Math.max(1, v), data?.limits?.maxCommitted ?? v); }} /></label>
        {/if}
      </section>
      <section class:open={section === 3}>
        <button class="ff-head" onclick={() => { section = 3; }}>3. {head(3, word("UI/Common/Description"))}</button>
        {#if section === 3}
          <label class="ff-field" title={word(C + "NameInputHint")}>{word("UI/Common/Name")}<input bind:value={name} maxlength="60" placeholder={word(C + "NameInputHint")} />
            {#if (tried || name) && nameError}<small class="ff-error">{nameError}</small>{/if}</label>
          <label class="ff-field" title={word(C + "DescriptionInputHint")}>{word("UI/Common/Description")}<textarea rows="4" bind:value={description} placeholder={word(C + "JobDescriptionInputFieldText")}></textarea>
            {#if descriptionError}<small class="ff-error">{descriptionError}</small>{/if}</label>
          <label class="ff-field" title={word(C + "CareerPathInputHint")}>{word("Character/CareerPaths/CareerPath")}
            <select bind:value={career}><option value={0}>{word("Character/CareerPaths/Unclassified")}</option>
              {#each [4, 5, 6, 7] as c (c)}<option value={c}>{careerNames[c] ? msg(careerNames[c]) : c}</option>{/each}</select></label>
        {/if}
      </section>
      {#if methodName !== "ShipInsurance"}
        <section class:open={section === 4}>
          <button class="ff-head" onclick={() => { section = 4; }}>4. {word(C + "PaymentFormTitle")}</button>
          {#if section === 4}
            <label class="ff-field ff-indent" title={word(C + "PayoutPerUnitHint", { divisionName: walletName })}>{(method && msg(method.rewardDescription)) || word(C + "PayoutPerUnitTitle")}
              <input type="number" min="0" step="0.01" bind:value={payout} /></label>
            {#if maxContributions}<p class="ff-note ff-indent">{word(C + "RewardLimitPerContributor", { rewardAmount: isk(maxContributions * payout) })}</p>{/if}
          {/if}
        </section>
      {/if}
      <div class="ff-cost">
        <b>{word(S + "CostSummaryTitle")}</b>
        <div class="ff-line" title={word(S + "BaseFeeHint", { base_fee_per_day: isk(data.baseFeePerDay ?? 0), duration: days })}><span>{word(S + "BaseFeeTitle")}</span><span>{isk(baseFee)}</span></div>
        <div class="ff-line" title={word(S + "BroadcastingFeeHint", { broadcasting_fee_per_day_per_location: isk(data.broadcastFeePerDay ?? 0), duration: days, number_of_locations: broadcastSystems.length })}><span>{word(S + "BroadcastingFeeTitle")}</span><span>{isk(broadcastFee)}</span></div>
        <div class="ff-line" title={word(S + "RewardsHint")}><span>{word(S + "RewardsTitle")}</span><span>{isk(rewards)}</span></div>
        <small class="ff-right ff-dim">{word(S + "TotalCostTitle")}</small>
        <div class="ff-total">{isk(total)}</div>
        <div class="ff-line ff-dim"><span>{word(S + "ActiveWalletTitle")}</span><span>{word(S + "ActiveWalletBalanceTitle")}</span></div>
        <div class="ff-line"><span>{walletName}</span><span class:ff-error={short}>{balance === null ? "-" : isk(balance)}</span></div>
      </div>
    </div>
    {/if}
    <footer>{#if failure}<small class="ff-error">{failure}</small>{/if}
      <button disabled={submitting || !data} onclick={() => void create()}>{word(C + "CreateNewButton")}</button><button onclick={() => void cancel()}>{word("UI/Common/Cancel")}</button></footer>
  </div>
</div>

<style>
  .ff-back { position: absolute; inset: 0; z-index: 7; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); }
  .ff { width: 440px; min-width: 400px; max-height: 95%; display: flex; flex-direction: column; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .ff > header { display: flex; justify-content: space-between; padding: 6px 8px; font-weight: bold; }
  .ff-x { all: unset; cursor: pointer; }
  .ff-body { flex: 1; min-height: 0; overflow: auto; padding: 0 8px; display: flex; flex-direction: column; gap: 8px; }
  section { border: 1px solid rgba(255, 255, 255, 0.1); }
  section.open { border-color: rgba(255, 255, 255, 0.25); }
  .ff-head { all: unset; cursor: pointer; display: block; width: 100%; box-sizing: border-box; padding: 8px; font-weight: bold; }
  .ff-field { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; }
  .ff-indent { padding-left: 24px; }
  .ff-check { display: flex; align-items: center; gap: 6px; }
  .ff-row { display: flex; gap: 8px; }
  .ff-row label { flex: 1; display: flex; flex-direction: column; }
  .ff-presets { display: flex; gap: 4px; margin: 4px 0; flex-wrap: wrap; }
  .ff-error { color: #d4534f; }
  .ff-note { padding: 0 8px; opacity: 0.75; }
  .ff-dim { opacity: 0.6; }
  .ff-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .ff-chip { display: inline-flex; gap: 4px; align-items: center; padding: 1px 6px; background: rgba(255, 255, 255, 0.1); border-radius: 10px; }
  .ff-chip button { all: unset; cursor: pointer; opacity: 0.7; }
  .ff-found { max-height: 160px; overflow: auto; display: flex; flex-direction: column; border: 1px solid rgba(255, 255, 255, 0.15); }
  .ff-found button { all: unset; cursor: pointer; padding: 2px 6px; }
  .ff-found button:hover { background: rgba(255, 255, 255, 0.08); }
  .ff-found small { opacity: 0.6; }
  .ff-cost { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; padding: 16px; background: rgba(255, 255, 255, 0.05); }
  .ff-line { display: flex; justify-content: space-between; padding: 0 8px; }
  .ff-right { text-align: right; padding-right: 8px; }
  .ff-total { padding: 8px; text-align: right; font-size: 18px; font-weight: bold; color: #58a6dc; background: rgba(88, 166, 220, 0.12); }
  .ff > footer { display: flex; justify-content: flex-end; align-items: center; gap: 6px; padding: 8px; }
  .ff > footer small { flex: 1; }
</style>
