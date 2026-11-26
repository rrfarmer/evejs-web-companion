<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { MercenaryDensRead } from "../bridge/mercenaryDens.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { openAgencyGroup } from "./agencyRequests.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const words = $derived(store.words);
  const names = $derived(store.names);
  const path = "UI/Sovereignty/MercenaryDen/MyMercenaryDensWindow/";
  const labels = {
    deployed: [path + "DeployedDens", "Deployed Dens"],
    count: [path + "NumMyDensAndMax", "{numMyDens} / {numMax}"],
    empty: [path + "NoDensMessage", "You have no deployed Mercenary Dens."],
    agency: [path + "OpenAgencyButton", "Open Agency"],
    planet: [path + "HeaderPlanet", "Planet"],
    state: [path + "HeaderState", "State"],
    infomorphs: [path + "HeaderInfomorphs", "Infomorph Decryption Keys"],
    mto: [path + "HeaderMTOS", "MTO"],
    name: ["UI/Common/Name", "Name"],
    system: ["UI/Common/SolarSystem", "Solar System"],
    active: ["UI/Sovereignty/MercenaryDen/ConfigurationWindow/StateNameActive", "Active"],
    inactive: ["UI/Sovereignty/MercenaryDen/ConfigurationWindow/StateNameInactive", "Inactive"],
    retry: ["UI/Personalization/PaintTool/ErrorRetry", "Retry"],
    max: [path + "MyMaxDeployable", "My Maximum"],
    fullSkills: [path + "MaxDeployedWithFullSkills", "Maximum with full skills: {numDens}"],
    slot: [path + "EmptySlot", "Empty Slot"],
    slotDescription: [path + "EmptySlotDesc", "Available for deployment"],
  } as const;
  const columns = ["name", "system", "planet", "state", "infomorphs", "mto"] as const;
  const word = (key: keyof typeof labels) => plainText($words.templates[labels[key][0]] ?? labels[key][1]);
  const nameOf = (kind: "type" | "system" | "planet", id: number, fallback: string) =>
    resolvedName($names.resolved, kind, id, fallback);
  const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  let directory = $state.raw<MercenaryDensRead | null>(null);
  let error = $state("");
  let revision = $state(0);
  const count = $derived(directory ? plainText(formatTemplate($words.templates[labels.count[0]] ?? labels.count[1],
    { numMyDens: directory.owned.length, numMax: directory.maximum }, { nameOf: () => "" })) : "");
  const capacityTip = $derived(directory && directory.maximum < directory.absoluteMaximum
    ? plainText(formatTemplate($words.templates[labels.fullSkills[0]] ?? labels.fullSkills[1],
      { numDens: directory.absoluteMaximum }, { nameOf: () => "" }))
    : "");
  $effect(() => {
    void revision;
    let current = true;
    directory = null;
    error = "";
    flow.requestWords(Object.values(labels).map(([key]) => key));
    void flow.loadMyMercenaryDens().then(result => {
      if (current) directory = result;
    }).catch(cause => { if (current) error = panelErrorWords(cause); });
    return () => { current = false; };
  });
</script>

<section class="mercenary-dens" aria-label="My Mercenary Dens">
  {#if error}
    <p role="alert">{error}</p>
    <button type="button" onclick={() => revision++}>{word("retry")}</button>
  {:else if directory === null}
    <p role="status">Loading mercenary dens…</p>
  {:else}
    <header><strong>{word("deployed")}</strong><span title={`${word("max")} ${directory.maximum}${capacityTip ? "\n" + capacityTip : ""}`}>{count}</span></header>
    {#if directory.owned.length === 0}
      <div class="empty">
        <p>{word("empty")}</p>
        <button type="button" onclick={() => openAgencyGroup(85)}>{word("agency")}</button>
      </div>
    {:else}
      <table>
        <thead><tr>{#each columns as key}<th scope="col">{word(key)}</th>{/each}</tr></thead>
        <tbody>
          {#each directory.owned as id (id)}
            {@const row = directory.rows.find(entry => entry.id === id)}
            <tr data-den={id}>
              {#if row}
                {@const system = nameOf("system", row.solarSystemID, String(row.solarSystemID))}
                <td>{system} {nameOf("type", row.typeID, "Mercenary Den")}</td>
                <td>{system}</td>
                <td>{nameOf("planet", row.planetID, "—")}</td>
                <td>{word(row.enabled ? "active" : "inactive")}</td>
                <td>{integer.format(row.infomorphs)}</td>
                <td>{row.activities === null ? "—" : integer.format(row.activities)}</td>
              {:else}
                <td colspan="6">Mercenary Den {id} · Details unavailable</td>
              {/if}
            </tr>
          {/each}
          {#each Array.from({ length: Math.max(0, directory.maximum - directory.owned.length) }) as _}
            <tr class="empty-slot"><td>{word("slot")}</td><td colspan="5">{word("slotDescription")}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</section>

<style>
  section { display: grid; align-content: start; gap: 10px; min-width: 0; overflow: auto; }
  header { display: flex; justify-content: space-between; padding: 8px; background: #ffffff0d; }
  .empty { display: grid; justify-items: center; gap: 8px; text-align: center; }
  p { margin: 0; white-space: pre-line; }
  table { border-collapse: collapse; width: 100%; text-align: left; }
  th, td { padding: 5px 8px; border-bottom: 1px solid #ffffff18; }
  th:nth-last-child(-n+2), td:nth-last-child(-n+2) { text-align: right; }
  .empty-slot { opacity: 0.7; }
  .empty-slot td { text-align: left; }
  button { justify-self: start; }
</style>
