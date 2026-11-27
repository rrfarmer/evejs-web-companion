<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { FLEET_MAX_SIZE, FLEET_SETUP_NAME_LENGTH, type FleetSetupSource } from "../bridge/fleetSetups.ts";
  import type { ClientStore } from "../store/clientStore.ts";

  let { store, flow, onClose }: { store: ClientStore; flow: AppFlow; onClose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  const { fleet, words } = store;
  const F = "UI/Fleet/FleetWindow/";
  const labels = ["StoreFleetSetupText", "StoreFleetSetupTextWithLastLoaded", "IncludeMotd", "IncludeFreeMoveSetting", "IncludeMaxSize", "IncludeDefaultSquad", "UnnamedSquad"];
  // svelte-ignore state_referenced_locally
  const lastSetup = flow.lastFleetSetup;
  let source = $state<FleetSetupSource | null>(null);
  let name = $state("");
  let nameInput = $state<HTMLInputElement>();
  let motd = $state(false), freeMove = $state(false), maxSize = $state(false), defaultSquad = $state(false);
  let saving = $state(false), error = $state("");

  function word(label: string, fallback: string, args: Record<string, string> = {}): string {
    const text = $words.templates[label];
    return typeof text === "string" && text ? plainText(formatTemplate(text, args, { nameOf: () => "" })) : fallback;
  }

  onMount(() => {
    flow.requestWords([...labels.map(label => F + label), "UI/Common/PleaseTypeSomething", "UI/Common/Buttons/OK", "UI/Common/Buttons/Cancel"]);
    const id = fleet.get().authoritativeFleetID;
    let active = true;
    if (id === null) onClose();
    else void flow.readFleetSetupSource(id).then(async result => {
      if (!active) return;
      if (result === null) { onClose(); return; }
      source = result;
      await tick();
      if (active) nameInput?.focus();
    }).catch(cause => {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
    });
    return () => { active = false; };
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!source || saving) return;
    if (!name.trim()) {
      error = word("UI/Common/PleaseTypeSomething", "Please type something.");
      return;
    }
    error = "";
    saving = true;
    try {
      if (await flow.storeFleetSetup(source.fleetID, name, { motd, freeMove, maxSize, defaultSquad })) onClose();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving = false;
    }
  }
</script>

<form class="fleet-setup-save" onsubmit={save}>
  {#if source}
    {@const loaded = $lastSetup?.fleetID === source.fleetID ? $lastSetup.name : null}
    <label class="setup-name">
      <span>{loaded === null ? word(F + "StoreFleetSetupText", "Enter a name for this fleet setup") :
        word(F + "StoreFleetSetupTextWithLastLoaded", `Last loaded setup: ${loaded}. Enter a name for this fleet setup.`, { oldFleetSetupName: loaded })}</span>
      <input type="text" bind:this={nameInput} bind:value={name} maxlength={FLEET_SETUP_NAME_LENGTH} disabled={saving}
        onkeydown={event => { if (event.key === "Escape" && !saving) onClose(); }} />
    </label>
    <div class="setup-options">
      <label title={plainText(source.motd)}><input type="checkbox" bind:checked={motd} disabled={saving} />{word(F + "IncludeMotd", "Include Message of the Day")}</label>
      <label title={source.freeMove ? "Free-Move is on" : "Free-Move is off"}><input type="checkbox" bind:checked={freeMove} disabled={saving} />{word(F + "IncludeFreeMoveSetting", "Include Free-Move Setting")}</label>
      {#if source.maxSize !== FLEET_MAX_SIZE}
        <label title={String(source.maxSize)}><input type="checkbox" bind:checked={maxSize} disabled={saving} />{word(F + "IncludeMaxSize", "Include Maximum Fleet Size")}</label>
      {/if}
      {#if source.defaultSquad}
        <label title={source.defaultSquad[2] || word(F + "UnnamedSquad", "Unnamed Squad")}><input type="checkbox" bind:checked={defaultSquad} disabled={saving} />{word(F + "IncludeDefaultSquad", "Include Default Squad")}</label>
      {/if}
    </div>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  <div class="setup-actions">
    <button type="submit" disabled={!source || saving}>{word("UI/Common/Buttons/OK", "OK")}</button>
    <button type="button" onclick={onClose} disabled={saving}>{word("UI/Common/Buttons/Cancel", "Cancel")}</button>
  </div>
</form>

<style>
  form { display: grid; gap: .7rem; padding: .6rem .8rem; }
  .setup-name, .setup-options { display: grid; gap: .25rem; }
  .setup-options label { display: flex; align-items: center; gap: .4rem; }
  .setup-actions { display: flex; gap: .4rem; justify-content: flex-end; }
  p { margin: 0; color: var(--color-danger, #f49c95); }
</style>
