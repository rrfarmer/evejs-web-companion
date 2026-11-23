<script lang="ts">
  import { untrack } from "svelte";
  import { resolveTrainingFundingPolicy, type FundingPolicy } from "../../training/funding.ts";
  import type { TrainingSettings, TrainingCorporation, TrainingAuthority } from "../training/settings.ts";
  let { settings, corporations, authorities, busy, traineeCorporationID = null, traineeCorporationName = null, worldReady = false, contextError = "", candidates = [], onInspect, onSave }: {
    settings: TrainingSettings; corporations: readonly TrainingCorporation[]; authorities: readonly TrainingAuthority[];
    busy: boolean; traineeCorporationID?: number | null; traineeCorporationName?: string | null; worldReady?: boolean; contextError?: string; candidates?: readonly {key:string;name:string;account:string}[]; onInspect: (key:string) => void; onSave: (value: TrainingSettings) => void;
  } = $props();
  let authority = $state(untrack(() => settings.onboarding.authorityKey));
  let rights = $state(untrack(() => settings.onboarding.rights));
  const savedFundingPolicy = $derived(resolveTrainingFundingPolicy(settings.fundingPolicy, settings.automaticFunding));
  let fundingPolicy = $state<FundingPolicy>(untrack(() => savedFundingPolicy));
  $effect(() => {
    authority = settings.onboarding.authorityKey;
    rights = settings.onboarding.rights;
    fundingPolicy = savedFundingPolicy;
  });
  const eligible = $derived(authorities.filter((a) => a.eligible));
  const selected = $derived(eligible.find((a) => a.key === authority));
  const corporation = $derived(corporations.find((c) => c.corporationID === selected?.corporationID));
  const fundingCorporationID = $derived(traineeCorporationID ?? settings.trainingWallet?.corporationID ?? selected?.corporationID ?? null);
  const fundingCorporationName = $derived(corporations.find(c => c.corporationID === fundingCorporationID)?.name ??
    (traineeCorporationID === fundingCorporationID ? traineeCorporationName : null));
  const usesCorporation = $derived(fundingPolicy !== "CHARACTER_WALLET_ONLY");
  const fundingHelp: Record<FundingPolicy, string> = {
    CHARACTER_WALLET_ONLY: "Skillbooks are paid from the trainee’s personal wallet.",
    CHARACTER_PLUS_CORPORATION_SHORTFALL: "Use the trainee’s ISK first. The corporation Master Wallet covers any shortfall.",
    CORPORATION_WALLET_ONLY: "The Master Wallet transfers the full book cost to the trainee before EveJS purchases the books.",
  };
  const canSave = $derived(!busy && worldReady && (!usesCorporation || fundingCorporationID !== null) &&
    (authority === settings.onboarding.authorityKey || !!selected) &&
    (!!selected || usesCorporation || fundingPolicy !== savedFundingPolicy));
  function save() {
    if (!canSave) return;
    onSave({ ...settings,
      onboarding: selected ? { enabled: true, corporationID: selected.corporationID, rights, authorityKey: selected.key } : settings.onboarding,
      trainingWallet: usesCorporation && fundingCorporationID !== null ? { corporationID: fundingCorporationID, accountKey: 1000 } : settings.trainingWallet,
      fundingPolicy, automaticFunding: undefined });
  }
</script>
<section class="settings" aria-label="Corporation HR Pilot">
  <h2>Corporation HR Pilot</h2>
  <p>Choose a dedicated Director to onboard trainees and apply their bot permissions.</p>
  <details>
    <summary>Set up an HR pilot in EveJS</summary>
    <ol>
      <li>Create a separate corporation character, such as CorpHR.</li>
      <li>In EveJS, assign Director and the necessary corporation permissions, then log out.</li>
      <li>Select the character here and verify HR permissions. UOC uses the pilot for verification and onboarding on request.</li>
    </ol>
    <p>UOC checks membership, sends invitations and applies the selected bot permissions. Corporate skill funding uses the trainee’s own authority to draw from the Master Wallet.</p>
  </details>
  {#if !worldReady}<p class="notice">Current world identity is unverified. HR settings cannot be saved.</p>{/if}
  {#if contextError}<p class="notice">{contextError}</p>{/if}
  <div class="fields">
    <label>Corporation HR Pilot
      <select value={authority} disabled={busy} onchange={(event) => { authority = event.currentTarget.value; }}>
        <option value="">Choose a saved pilot to verify</option>
        {#if authority && !candidates.some(a => a.key === authority)}<option value={authority}>Saved HR pilot unavailable</option>{/if}
        {#each candidates as actor}<option value={actor.key}>{actor.name} · {actor.account}</option>{/each}
      </select>
    </label>
    {#if authority && !selected && candidates.some(candidate => candidate.key === authority)}
      <button type="button" disabled={busy} onclick={() => onInspect(authority)}>Verify HR permissions</button>
    {/if}
    <p>Corporation <strong>{corporation ? `${corporation.name} (${corporation.corporationID})` : authority ? "Awaiting verified membership" : "Select an HR pilot"}</strong></p>
    <label>Bot permissions
      <select bind:value={rights} disabled={busy}>
        <option value="FULL_ACCESS_EXCEPT_CEO">Full access (except CEO)</option>
        <option value="NONE">Preserve existing permissions</option>
      </select>
    </label>
    {#if rights === "FULL_ACCESS_EXCEPT_CEO"}<p>Applies all supported ordinary permissions. CEO and Director remain protected.</p>{/if}
    <div class="funding">
      <label>Skillbook funding
        <select bind:value={fundingPolicy} disabled={busy} aria-describedby="training-funding-help">
          <option value="CHARACTER_WALLET_ONLY">Pilot wallet only</option>
          <option value="CHARACTER_PLUS_CORPORATION_SHORTFALL">Pilot wallet, then corporation</option>
          <option value="CORPORATION_WALLET_ONLY">Corporation wallet only</option>
        </select>
      </label>
      <p id="training-funding-help">{fundingHelp[fundingPolicy]}</p>
      {#if !usesCorporation}<p>For corporation-paid training, choose Corporation wallet only.</p>{/if}
      {#if usesCorporation}
        <p>Master Wallet (Division 1) · {fundingCorporationName ?? (fundingCorporationID ? `Corporation ${fundingCorporationID}` : "Select a trainee to identify the corporation")}</p>
      {/if}
    </div>
  </div>
  <button type="button" disabled={!canSave} onclick={save}>Save corporation settings</button>
  {#if usesCorporation && fundingCorporationID === null}<p class="notice">Select a trainee with verified corporation membership to use the Master Wallet.</p>{/if}
  <details class="advanced"><summary>Advanced details</summary>
    <p>Corporation {fundingCorporationID ?? "unknown"} · HR {authority || "unconfigured"} · wallet {usesCorporation ? "1000" : "personal"}</p>
  </details>
</section>
<style>
  .settings { margin:1rem 0; border:1px solid #455569; padding:1rem; }
  .fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:1rem; margin:1rem 0; }
  label { display:flex; flex-direction:column; gap:.4rem; }
  .funding { grid-column:1 / -1; }
  .funding select { max-width:24rem; }
  select { background:#16202e; color:#e4edf7; padding:.5rem; border:1px solid #455569; } p { max-width:90ch; }
  button { margin:.4rem .5rem .4rem 0; } .notice { color:#e9c982; } .advanced { margin-top:1rem; }
</style>
