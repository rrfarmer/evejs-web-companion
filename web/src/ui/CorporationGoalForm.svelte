<script lang="ts">
  // corp_goals/forms goalForms.OpenCreateGoalFormWindow / OpenDuplicateGoalFormWindow - GoalFormWindow (NewProject):
  // three collapsible sections, one open at a time. 1 ProjectDefinition: ContributionMethod (ALLOWED_CONTRIBUTION_
  // METHOD_TYPES sorted by title, SelectContributionMethod, required); with one chosen its parameters, the target
  // (the method's target value description, at least 1), LimitPerContributor (optional, at most the target;
  // RequiredContributors {num} = the target over the limit, up), SetEndDate (ExpiredFieldInfo) and the end date
  // (presets 7 days, 2 weeks, 1, 3, 6 months). 2 Description: Name (5 to 60 characters, single spaces, no < >),
  // Description (at most 1000), CareerPath (Unclassified and the four; set to the method's when the method changes).
  // 3 PaymentOptional: ISK per unit (the method's rewarding description, ISKPerUnitOfProgressHint {divisionName}),
  // RewardLimitPerContributor where a limit is set. TotalProjectCost: per unit x target. Create New
  // (CorpGoalsController.create_goal) and Cancel (CancelProjectCreation asked). A section's header once filled: "n X
  // <method>", the name. Duplicate: the original's method, target, career, name, description, ISK per unit, limit
  // and duration.
  // The method's parameters (ParametersForm, contributionMethods' parameters): a location (LocationParameter -
  // formComponent.SolarSystem, or with maxEntries > 1 MultiValueLocationFormComponent: solar systems, constellations,
  // regions), an item type (InventoryTypeParameter - formComponent.EveType), a corporation office
  // (CorporationOfficeParameter - Any and the offices); the parameter's title, its info as the hint, the placeholder
  // TypeInName or the unset description with "(Optional)"; a required one InputRequired.
  // Also: a ship type (ShipTypeParameter - EveType of the Ship category), an ore (MineableOreParameter), a
  // manufacturable item (ManufacturableItemParameter), an owner (OwnerParameter - PlayerOrPlayerOrganization: the
  // owner search; kinds by idCheckers), an empire faction (NpcFactionParameter: Any and the four occupier factions),
  // an FW complex size (archetypes 33-36 by title), a signature type (EXPLORATION_SITE_TYPES in the client's dict
  // order: Combat, Data, Gas, Relic, Ore, Wormhole), on whose behalf (RunJobOnBehalfOfCharacter, the default, or
  // ...Corp), the office's location (Any and the offices' stations).
  // Not here yet: ship classes, ore groups, the LP corporation list and the hacking container type (left at any), the
  // type filters are by category name only (Ship, Asteroid; a manufacturable item is any market type); Ship
  // Insurance cannot be made yet.
  import { onMount } from "svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow, CorporationGoal, CorporationGoals } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  let { store, flow, methods, capacity, original = null, onClose }: {
    store: ClientStore; flow: AppFlow; methods: CorporationGoals["methods"]; capacity: number | null; original?: CorporationGoal | null; onClose: (made: boolean) => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const G = "UI/Corporations/Goals/";
  const LABELS = ["NewProject", "ProjectDefinition", "ContributionMethod", "SelectContributionMethod", "TargetValue", "LimitPerContributor", "LimitPerContributorHint",
    "TypeInOptionalContributionAmount", "RequiredContributors", "SetEndDate", "ExpiredFieldInfo", "PaymentOptional", "ISKPerUnitOfProgress", "ISKPerUnitOfProgressHint",
    "RewardLimitPerContributor", "TotalProjectCost", "CreateNew"].map((k) => G + k)
    .concat(["UI/Common/Description", "UI/Common/Name", "Character/CareerPaths/CareerPath", "Character/CareerPaths/Unclassified", "UI/Common/Cancel", "UI/Common/ISK",
      "UI/Control/Form/InputRequired", "UI/Control/Form/LengthBetweenRequired", "UI/Control/Form/LengthBelowRequired", "UI/Control/Form/OnlySingleWhitespacesAllowed",
      "UI/Control/Form/IllegalCharacters", "UI/Corporations/Common/CorporateDivisionMasterWallet", "UI/Corporations/Goals/TypeInName", "UI/Corporations/Goals/Optional",
      "UI/Corporations/Goals/AnyCorpOffice", "UI/Common/Any", "UI/GameGoalConfig/Parameters/RunJobOnBehalfOfCharacter", "UI/GameGoalConfig/Parameters/RunJobOnBehalfOfCorp",
      "UI/Inflight/Scanner/CombatSite", "UI/Inflight/Scanner/DataSite", "UI/Inflight/Scanner/GasSite", "UI/Inflight/Scanner/RelicSite", "UI/Inflight/Scanner/OreSite",
      "UI/Inflight/Scanner/Wormhole"]);
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  // goalConst.ALLOWED_CONTRIBUTION_METHOD_TYPES.
  const ALLOWED = ["Manual", "DamageShip", "DeliverItem", "KillNPC", "MineOre", "ManufactureItem", "KillCapsuleer", "CaptureFWComplex", "DefendFWComplex",
    "RemoteRepairShields", "RemoteRepairArmor", "ScanSignature", "SalvageWreck", "EarnLoyaltyPoints", "ShipLoss", "ShipInsurance"];
  const NOT_YET = new Set(["ShipInsurance"]);
  type Parameter = { readonly parameterKey: string; readonly parameterType: string; readonly isRequired?: number; readonly maxEntries?: number; readonly title?: string; readonly info?: string };
  const BUILT = new Set(["location", "inventory_type", "corporation_office", "ship_type", "mineable_ore_type", "manufacturable_item_type", "identity",
    "empire_faction", "factional_warfare_complex_type", "signature_type", "on_behalf_of", "corporation_office_location"]);
  // The kinds searched by name, and their category filter.
  const TYPE_SEARCH: Record<string, string | null> = { inventory_type: null, ship_type: "Ship", mineable_ore_type: "Asteroid", manufacturable_item_type: null };
  // probescanning.explorationSites.EXPLORATION_SITE_TYPES, as the client's dict orders its keys (asked of its Python).
  const SIGNATURES: readonly [number, string][] = [[1136, "UI/Inflight/Scanner/CombatSite"], [208, "UI/Inflight/Scanner/DataSite"], [209, "UI/Inflight/Scanner/GasSite"],
    [210, "UI/Inflight/Scanner/RelicSite"], [211, "UI/Inflight/Scanner/OreSite"], [1908, "UI/Inflight/Scanner/Wormhole"]];
  // IsOccupierFWFaction: Caldari, Minmatar, Amarr, Gallente.
  const FW_FACTIONS = [500001, 500002, 500003, 500004];
  let kinds = $state<Record<string, number>>({}), fwComplexes = $state<readonly { id: number; label: string }[]>([]);
  const parametersOf = (id: string): readonly Parameter[] => ((methods[id] as { parameters?: readonly Parameter[] } | undefined)?.parameters ?? []);
  // The values by parameter key: one id, or several where maxEntries > 1.
  let params = $state<Record<string, number[]>>({}), paramNames = $state<Record<number, string>>({});
  let search = $state<Record<string, string>>({}), found = $state<Record<string, readonly { id: number; name: string; sub: string }[]>>({});
  let offices = $state<readonly { officeID: number; stationID: number; name: string }[]>([]);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function findFor(p: Parameter, text: string): void {
    search = { ...search, [p.parameterKey]: text };
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (p.parameterType === "location") {
        const r = await flow.goalLocationMatches(text, (p.maxEntries ?? 1) > 1);
        found = { ...found, [p.parameterKey]: r.map((m) => ({ id: m.id, name: m.kind === "system" && m.security !== null ? `${m.name} ${m.security.toFixed(1)}` : m.name, sub: m.kind })) };
      } else if (p.parameterType in TYPE_SEARCH) {
        const r = text.trim().length < 3 ? { exact: null, matches: [] } : await flow.marketTypeMatches(text);
        const only = TYPE_SEARCH[p.parameterType];
        found = { ...found, [p.parameterKey]: r.matches.filter((m) => !only || m.category === only).slice(0, 50).map((m) => ({ id: m.typeID, name: m.name, sub: m.category })) };
      } else if (p.parameterType === "identity") {
        const r = text.trim().length < 3 ? [] : await flow.lookupPlayerOwners(text);
        // OwnerParameter.get_configuration's kinds: corporation (type 2), alliance (16159), faction (30), else character.
        kinds = { ...kinds, ...Object.fromEntries(r.map((o) => [`${p.parameterKey}:kind:${o.ownerID}`, o.typeID === 2 ? 2 : o.typeID === 16159 ? 3 : o.typeID === 30 ? 4 : 1])) };
        found = { ...found, [p.parameterKey]: r.slice(0, 50).map((o) => ({ id: o.ownerID, name: o.ownerName, sub: o.typeID === 2 ? "Corporation" : o.typeID === 16159 ? "Alliance" : o.typeID === 30 ? "Faction" : "Character" })) };
      }
    }, 250);
  }
  function pickParam(p: Parameter, id: number, label: string): void {
    const several = (p.maxEntries ?? 1) > 1, have = params[p.parameterKey] ?? [];
    params = { ...params, [p.parameterKey]: several ? (have.includes(id) || have.length >= (p.maxEntries ?? 1) ? have : [...have, id]) : [id] };
    paramNames = { ...paramNames, [id]: label };
    search = { ...search, [p.parameterKey]: "" }; found = { ...found, [p.parameterKey]: [] };
  }
  function dropParam(key: string, id: number): void { params = { ...params, [key]: (params[key] ?? []).filter((x) => x !== id) }; }
  const placeholder = (p: Parameter) => `${word("UI/Corporations/Goals/TypeInName")}${p.isRequired ? "" : ` (${word("UI/Corporations/Goals/Optional")})`}`;
  // metadata CONTENT_TAG_TO_CAREER_PATH.
  const TAG_CAREERS: Record<string, number> = { career_path_explorer: 4, career_path_industrialist: 5, career_path_enforcer: 6, career_path_soldier_of_fortune: 7 };
  const methodWord = (id: string, key: "titleID" | "descriptionID" | "targetValueDescriptionID" | "rewardingDescriptionID") => {
    const m = methods[id] as Record<string, unknown> | undefined; const n = m?.[key];
    return typeof n === "number" ? word(`#${n}`) : "";
  };
  const methodCareer = (id: string) => { const tags = (methods[id] as { contentTags?: readonly string[] } | undefined)?.contentTags ?? []; return tags.map((t) => TAG_CAREERS[t]).find((c) => c !== undefined) ?? 0; };
  const options = $derived(ALLOWED.map((id) => ({ id, title: methodWord(id, "titleID") || id })).sort((a, b) => a.title.localeCompare(b.title)));
  let careerNames = $state<Record<number, number>>({});
  onMount(() => {
    flow.requestWords(LABELS);
    flow.requestWords(Object.values(methods).flatMap((m) => Object.entries(m).filter(([k, v]) => k.endsWith("ID") && typeof v === "number").map(([, v]) => `#${v}`)));
    flow.requestWords(Object.values(methods).flatMap((m) => ((m as { parameters?: readonly Parameter[] }).parameters ?? []).flatMap((p) => [p.title, p.info].filter((x): x is string => typeof x === "string"))));
    void flow.corporationOfficeOptions().then((o) => { offices = o; }, () => {});
    void flow.fwComplexOptions().then((o) => { fwComplexes = o; }, () => {});
    flow.requestNames(FW_FACTIONS.map((id) => ({ kind: "owner" as const, id })));
    void flow.certifiedSkillPlans().then((r) => { if (r) careerNames = Object.fromEntries(r.careerPaths.filter((c) => c.nameID !== null).map((c) => [c.careerPathID, c.nameID!])); }, () => {});
  });

  // The form's values, from the original where duplicating (OpenDuplicateGoalFormWindow).
  // svelte-ignore state_referenced_locally
  const o = original;
  let section = $state(1), method = $state<string>(o?.methodID ?? ""), desired = $state(o?.desired ?? 1), limit = $state<number | null>(o?.participationLimit ?? null);
  let hasExpiry = $state(Boolean(o?.due)), expiry = $state(o?.due && o.created ? new Date(Date.now() + (o.due - o.created)).toISOString().slice(0, 16) : new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16));
  let name = $state(o?.name ?? ""), description = $state(o?.description ?? ""), career = $state<number>(o?.careerPath ?? 0), perUnit = $state<number>(o?.amountPerUnit ?? 0);
  let submitting = $state(false), tried = $state(false);
  function chooseMethod(id: string): void { method = id; desired = 1; career = methodCareer(id); perUnit = 0; limit = null; params = {}; }
  function preset(span: string): void {
    const d = new Date();
    if (span === "7d") d.setDate(d.getDate() + 7); else if (span === "2w") d.setDate(d.getDate() + 14); else d.setMonth(d.getMonth() + Number(span.replace("m", "")));
    expiry = d.toISOString().slice(0, 16);
  }
  const nameError = $derived.by(() => {
    if (name.length < 5 || name.length > 60) return word("UI/Control/Form/LengthBetweenRequired", { minLength: 5, maxLength: 60, length: name.length });
    if (/[\t\n\r\f\v]+|[ ]{2,}/.test(name)) return word("UI/Control/Form/OnlySingleWhitespacesAllowed");
    const bad = [...new Set([...name].filter((c) => "><".includes(c)))];
    if (bad.length) return word("UI/Control/Form/IllegalCharacters", { characters: bad.join(", ") });
    return "";
  });
  const descriptionError = $derived(description.length > 1000 ? word("UI/Control/Form/LengthBelowRequired", { maxLength: 1000, length: description.length }) : "");
  const methodError = $derived(!method ? word("UI/Control/Form/InputRequired") : "");
  const missingRequired = $derived(method ? parametersOf(method).some((p) => p.isRequired && BUILT.has(p.parameterType) && p.parameterType !== "on_behalf_of" && !(params[p.parameterKey] ?? []).length) : false);
  const valid = $derived(!methodError && !nameError && !descriptionError && desired >= 1 && (!limit || limit <= desired) && !NOT_YET.has(method) && !missingRequired);
  const total = $derived((perUnit || 0) * (desired || 0));
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  async function create(): Promise<void> {
    tried = true;
    if (!valid) { section = methodError ? 1 : nameError || descriptionError ? 2 : 1; return; }
    submitting = true;
    try {
      const made = await flow.createCorporationGoal({ name, description, desired, methodID: method, careerPath: career || null, payment: perUnit > 0 ? perUnit : null,
        expiry: hasExpiry ? new Date(expiry).getTime() : null, participationLimit: limit && limit > 0 ? limit : null, capacity,
        parameters: { ...kinds, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.length ? v : null])) } });
      if (made) onClose(true);
    } finally { submitting = false; }
  }
  async function cancel(): Promise<void> {
    if (await flow.askClientDialog("CancelProjectCreation", "Discard this project?")) onClose(false);
  }
</script>

<div class="gf-back">
  <div class="gf" role="dialog" aria-label={word(G + "NewProject")}>
    <header><span>{word(G + "NewProject")}</span><button class="gf-x" onclick={() => void cancel()}>✕</button></header>
    <div class="gf-body">
      <section class:open={section === 1}>
        <button class="gf-head" onclick={() => { section = 1; }}>1 · {section !== 1 && method ? `${desired.toLocaleString("en-US")} X ${methodWord(method, "titleID")}` : word(G + "ProjectDefinition")}</button>
        {#if section === 1}
          <label class="gf-field">{word(G + "ContributionMethod")}
            <select value={method} onchange={(e) => chooseMethod(e.currentTarget.value)}>
              <option value="" disabled>{word(G + "SelectContributionMethod")}</option>
              {#each options as m (m.id)}<option value={m.id} title={methodWord(m.id, "descriptionID")}>{m.title}</option>{/each}
            </select>
            {#if tried && methodError}<small class="gf-error">{methodError}</small>{/if}</label>
          {#if method}
            {#if NOT_YET.has(method)}<p class="gf-note">{methodWord(method, "descriptionID")}</p>{/if}
            {#each parametersOf(method) as p (p.parameterKey)}
              {@const chosen = params[p.parameterKey] ?? []}
              <div class="gf-field gf-indent" title={p.info ? word(p.info) : ""}>
                <span>{p.title ? word(p.title) : p.parameterKey}</span>
                {#if p.parameterType === "empire_faction" || p.parameterType === "factional_warfare_complex_type" || p.parameterType === "signature_type" || p.parameterType === "corporation_office_location" || p.parameterType === "on_behalf_of"}
                  {@const choices = p.parameterType === "empire_faction" ? FW_FACTIONS.map((id) => ({ id, label: nameAny("owner", id) || String(id) }))
                    : p.parameterType === "factional_warfare_complex_type" ? fwComplexes.map((c) => ({ id: c.id, label: c.label ? word(c.label) : String(c.id) }))
                    : p.parameterType === "signature_type" ? SIGNATURES.map(([id, l]) => ({ id, label: word(l) }))
                    : p.parameterType === "on_behalf_of" ? [{ id: 1, label: word("UI/GameGoalConfig/Parameters/RunJobOnBehalfOfCharacter") }, { id: 2, label: word("UI/GameGoalConfig/Parameters/RunJobOnBehalfOfCorp") }]
                    : offices.map((o) => ({ id: o.stationID, label: o.name }))}
                  <select value={chosen[0] ? String(chosen[0]) : p.parameterType === "on_behalf_of" ? "1" : ""} onchange={(e) => { const v = Number(e.currentTarget.value); params = { ...params, [p.parameterKey]: v ? [v] : [] }; }}>
                    {#if p.parameterType !== "on_behalf_of" && !p.isRequired}<option value="">{word("UI/Common/Any")}</option>{/if}
                    {#each choices as c (c.id)}<option value={String(c.id)}>{c.label}</option>{/each}
                  </select>
                {:else if p.parameterType === "corporation_office"}
                  <select value={chosen[0] ? String(chosen[0]) : ""} onchange={(e) => { const v = Number(e.currentTarget.value); params = { ...params, [p.parameterKey]: v ? [v] : [] }; }}>
                    {#if !p.isRequired}<option value="">{word("UI/Common/Any")}</option>{/if}
                    {#each offices as o (o.officeID)}<option value={String(o.officeID)}>{o.name}</option>{/each}
                  </select>
                {:else if BUILT.has(p.parameterType)}
                  {#if chosen.length}<span class="gf-chips">{#each chosen as id (id)}<span class="gf-chip">{paramNames[id] ?? id}<button onclick={() => dropParam(p.parameterKey, id)}>✕</button></span>{/each}</span>{/if}
                  {#if chosen.length < (p.maxEntries ?? 1)}
                    <input placeholder={placeholder(p)} value={search[p.parameterKey] ?? ""} oninput={(e) => findFor(p, e.currentTarget.value)} />
                    {#if (found[p.parameterKey] ?? []).length}
                      <div class="gf-found">{#each found[p.parameterKey] ?? [] as m (m.id)}<button onclick={() => pickParam(p, m.id, m.name)}>{m.name} <small>{m.sub}</small></button>{/each}</div>
                    {/if}
                  {/if}
                  {#if tried && p.isRequired && !chosen.length}<small class="gf-error">{word("UI/Control/Form/InputRequired")}</small>{/if}
                {:else}
                  <small class="gf-dim">{word("UI/Common/Any")}</small>
                {/if}
              </div>
            {/each}
            <label class="gf-field gf-indent">{methodWord(method, "targetValueDescriptionID") || word(G + "TargetValue")}<input type="number" min="1" bind:value={desired} /></label>
            <label class="gf-field gf-indent" title={word(G + "LimitPerContributorHint")}>{word(G + "LimitPerContributor")}
              <input type="number" min="1" max={desired} placeholder={word(G + "TypeInOptionalContributionAmount")} value={limit ?? ""} oninput={(e) => { const v = Number(e.currentTarget.value); limit = e.currentTarget.value && v > 0 ? v : null; }} />
              {#if limit}<small>{word(G + "RequiredContributors", { num: Math.ceil(desired / limit) })}</small>{/if}</label>
            <label class="gf-check gf-indent" title={word(G + "ExpiredFieldInfo")}><input type="checkbox" bind:checked={hasExpiry} /> {word(G + "SetEndDate")}</label>
            {#if hasExpiry}
              <div class="gf-field gf-indent"><input type="datetime-local" bind:value={expiry} />
                <span class="gf-presets">{#each ["7d", "2w", "1m", "3m", "6m"] as p (p)}<button onclick={() => preset(p)}>{p}</button>{/each}</span></div>
            {/if}
          {/if}
        {/if}
      </section>
      <section class:open={section === 2}>
        <button class="gf-head" onclick={() => { section = 2; }}>2 · {section !== 2 && name ? name : word("UI/Common/Description")}</button>
        {#if section === 2}
          <label class="gf-field">{word("UI/Common/Name")}<input bind:value={name} maxlength="60" />{#if (tried || name) && nameError}<small class="gf-error">{nameError}</small>{/if}</label>
          <label class="gf-field">{word("UI/Common/Description")}<textarea rows="4" bind:value={description}></textarea>{#if descriptionError}<small class="gf-error">{descriptionError}</small>{/if}</label>
          <label class="gf-field">{word("Character/CareerPaths/CareerPath")}
            <select value={String(career)} onchange={(e) => { career = Number(e.currentTarget.value); }}>
              <option value="0">{word("Character/CareerPaths/Unclassified")}</option>
              {#each [4, 5, 6, 7] as c (c)}<option value={String(c)}>{careerNames[c] ? word(`#${careerNames[c]}`) : c}</option>{/each}
            </select></label>
        {/if}
      </section>
      <section class:open={section === 3}>
        <button class="gf-head" onclick={() => { section = 3; }}>3 · {word(G + "PaymentOptional")}</button>
        {#if section === 3}
          <label class="gf-field" title={word(G + "ISKPerUnitOfProgressHint", { divisionName: word("UI/Corporations/Common/CorporateDivisionMasterWallet") })}>{(method && methodWord(method, "rewardingDescriptionID")) || word(G + "ISKPerUnitOfProgress")}
            <input type="number" min="0" step="0.01" bind:value={perUnit} /></label>
          {#if limit}<p class="gf-note">{word(G + "RewardLimitPerContributor", { rewardAmount: isk((perUnit || 0) * limit) })}</p>{/if}
        {/if}
      </section>
      <div class="gf-total"><small>{word(G + "TotalProjectCost")}</small><b title={isk(total)}>{isk(total)}</b></div>
    </div>
    <footer><button disabled={submitting} onclick={() => void create()}>{word(G + "CreateNew")}</button><button onclick={() => void cancel()}>{word("UI/Common/Cancel")}</button></footer>
  </div>
</div>

<style>
  .gf-back { position: absolute; inset: 0; z-index: 7; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.4); }
  .gf { width: 420px; max-height: 95%; display: flex; flex-direction: column; background: #1b1d21; border: 1px solid rgba(255, 255, 255, 0.15); }
  .gf > header { display: flex; justify-content: space-between; padding: 6px 8px; font-weight: bold; }
  .gf-x { all: unset; cursor: pointer; }
  .gf-body { flex: 1; min-height: 0; overflow: auto; padding: 0 8px; display: flex; flex-direction: column; gap: 8px; }
  section { border: 1px solid rgba(255, 255, 255, 0.1); }
  section.open { border-color: rgba(255, 255, 255, 0.25); }
  .gf-head { all: unset; cursor: pointer; display: block; width: 100%; box-sizing: border-box; padding: 8px; font-weight: bold; }
  .gf-field { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px; }
  .gf-indent { padding-left: 24px; }
  .gf-check { display: flex; align-items: center; gap: 6px; padding: 4px 24px; }
  .gf-presets { display: flex; gap: 4px; margin-top: 4px; }
  .gf-error { color: #d4534f; }
  .gf-note { padding: 0 8px; opacity: 0.75; }
  .gf-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .gf-chip { display: inline-flex; gap: 4px; align-items: center; padding: 1px 6px; background: rgba(255, 255, 255, 0.1); border-radius: 10px; }
  .gf-chip button { all: unset; cursor: pointer; opacity: 0.7; }
  .gf-found { max-height: 160px; overflow: auto; display: flex; flex-direction: column; border: 1px solid rgba(255, 255, 255, 0.15); }
  .gf-found button { all: unset; cursor: pointer; padding: 2px 6px; }
  .gf-found button:hover { background: rgba(255, 255, 255, 0.08); }
  .gf-found small, .gf-dim { opacity: 0.6; }
  .gf-total { display: flex; flex-direction: column; align-items: flex-end; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.2); }
  .gf > footer { display: flex; justify-content: flex-end; gap: 6px; padding: 8px; }
</style>
