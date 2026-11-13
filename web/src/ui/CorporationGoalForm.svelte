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
  // Not here yet: the methods' parameters (every one is "any"); Deliver Item, Manufacture Item and Ship Insurance,
  // whose parameters or fields are required, are listed but cannot be made yet.
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
      "UI/Control/Form/IllegalCharacters", "UI/Corporations/Common/CorporateDivisionMasterWallet"]);
  const nameAny = (k: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, k, id, "");
  const word = (label: string, values: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", values as never, { nameOf: nameAny }));
  // goalConst.ALLOWED_CONTRIBUTION_METHOD_TYPES.
  const ALLOWED = ["Manual", "DamageShip", "DeliverItem", "KillNPC", "MineOre", "ManufactureItem", "KillCapsuleer", "CaptureFWComplex", "DefendFWComplex",
    "RemoteRepairShields", "RemoteRepairArmor", "ScanSignature", "SalvageWreck", "EarnLoyaltyPoints", "ShipLoss", "ShipInsurance"];
  const NOT_YET = new Set(["DeliverItem", "ManufactureItem", "ShipInsurance"]);
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
    void flow.certifiedSkillPlans().then((r) => { if (r) careerNames = Object.fromEntries(r.careerPaths.filter((c) => c.nameID !== null).map((c) => [c.careerPathID, c.nameID!])); }, () => {});
  });

  // The form's values, from the original where duplicating (OpenDuplicateGoalFormWindow).
  // svelte-ignore state_referenced_locally
  const o = original;
  let section = $state(1), method = $state<string>(o?.methodID ?? ""), desired = $state(o?.desired ?? 1), limit = $state<number | null>(o?.participationLimit ?? null);
  let hasExpiry = $state(Boolean(o?.due)), expiry = $state(o?.due && o.created ? new Date(Date.now() + (o.due - o.created)).toISOString().slice(0, 16) : new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16));
  let name = $state(o?.name ?? ""), description = $state(o?.description ?? ""), career = $state<number>(o?.careerPath ?? 0), perUnit = $state<number>(o?.amountPerUnit ?? 0);
  let submitting = $state(false), tried = $state(false);
  function chooseMethod(id: string): void { method = id; desired = 1; career = methodCareer(id); perUnit = 0; limit = null; }
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
  const valid = $derived(!methodError && !nameError && !descriptionError && desired >= 1 && (!limit || limit <= desired) && !NOT_YET.has(method));
  const total = $derived((perUnit || 0) * (desired || 0));
  const isk = (v: number) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${word("UI/Common/ISK") || "ISK"}`;
  async function create(): Promise<void> {
    tried = true;
    if (!valid) { section = methodError ? 1 : nameError || descriptionError ? 2 : 1; return; }
    submitting = true;
    try {
      const made = await flow.createCorporationGoal({ name, description, desired, methodID: method, careerPath: career || null, payment: perUnit > 0 ? perUnit : null,
        expiry: hasExpiry ? new Date(expiry).getTime() : null, participationLimit: limit && limit > 0 ? limit : null, capacity });
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
  .gf-total { display: flex; flex-direction: column; align-items: flex-end; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.2); }
  .gf > footer { display: flex; justify-content: flex-end; gap: 6px; padding: 8px; }
</style>
