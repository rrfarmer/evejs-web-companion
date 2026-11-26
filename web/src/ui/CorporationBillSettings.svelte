<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import { billTypeNameIDs, canPayCorporationBills, type AutomaticBillSettings } from "../bridge/corporationBills.ts";
  import { corporationWalletTakeKeys } from "../bridge/corporationWealth.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";

  let { store, flow, applied, refresh }: {
    store: ClientStore; flow: AppFlow; applied: () => void; refresh: number;
  } = $props();
  const station = $derived(store.station);
  const names = $derived(store.names);
  const words = $derived(store.words);
  const online = $derived($station.online);
  const keys = $derived(corporationWalletTakeKeys(online?.corpRole));
  const mayApply = $derived(canPayCorporationBills(online?.corpRole) && keys.length > 0);
  const divisionLabel = "UI/Wallet/WalletWindow/ColHeaderDivision";
  const masterLabel = "UI/Corporations/Common/CorporateDivisionMasterWallet";
  const applyLabel = "UI/Commands/Apply";
  let settings = $state.raw<readonly AutomaticBillSettings[] | null>(null);
  let divisionNames = $state.raw<Readonly<Record<string, string | null>>>({});
  let error = $state("");
  let dirty = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let generation = 0;
  const corporationID = $derived(online?.corporationID);
  const allianceID = $derived(online?.allianceID);
  const word = (id: string, fallback: string) => plainText($words.templates[id] ?? "") || fallback;
  $effect(() => {
    void refresh; void corporationID; void allianceID;
    const request = ++generation;
    settings = null;
    dirty = false;
    saved = false;
    error = "";
    flow.requestWords([divisionLabel, masterLabel, applyLabel, ...Object.values(billTypeNameIDs).map(id => `#${id}`)]);
    void Promise.all([flow.corporationAutomaticBillSettings(), flow.corporationWalletDivisionNames()]).then(([rows, divisions]) => {
      if (request !== generation) return;
      settings = rows;
      divisionNames = divisions;
      flow.requestNames(rows.map(row => ({kind: "owner", id: row.ownerID})));
    }).catch(cause => { if (request === generation) error = panelErrorWords(cause); });
    return () => { generation++; };
  });
  function edit(owner: number, update: (row: AutomaticBillSettings) => AutomaticBillSettings) {
    settings = settings?.map(row => row.ownerID === owner ? update(row) : row) ?? null;
    dirty = true;
    saved = false;
    error = "";
  }
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!dirty || !mayApply || !settings || saving) return;
    saving = true;
    error = "";
    const request = generation;
    try {
      await flow.saveCorporationAutomaticBillSettings(settings);
      const result = await flow.corporationAutomaticBillSettings();
      if (request !== generation) return;
      settings = result;
      dirty = false;
      saved = true;
      applied();
    } catch (cause) {
      if (request === generation) error = panelErrorWords(cause);
    } finally { saving = false; }
  }
  function divisionName(key: number) {
    return divisionNames[String(key - 999)] ?? (key === 1000 ? word(masterLabel, "Master Wallet") : `Wallet Division ${key - 999}`);
  }
</script>

<form class="bill-automatic-settings" onsubmit={save}>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if settings === null && !error}<p role="status">Reading automatic pay settings…</p>{/if}
  {#each settings ?? [] as row (row.ownerID)}
    <fieldset disabled={!mayApply || saving}>
      <legend>{resolvedName($names.resolved, "owner", row.ownerID, row.ownerID === corporationID ? "Corporation" : "Alliance")}</legend>
      {#each [...row.flags].sort(([a], [b]) => a - b) as [type, checked] (type)}
        <label><input type="checkbox" {checked} onchange={event => {
          const value = event.currentTarget.checked;
          edit(row.ownerID, draft => ({...draft, flags: new Map([...draft.flags, [type, value]])}));
        }} /> {word(`#${billTypeNameIDs[type]}`, "Bill " + type)}</label>
      {/each}
      {#if row.ownerID === corporationID}
        <label>{word(divisionLabel, "Division")}
          <select value={row.division} onchange={event => {
            const division = Number(event.currentTarget.value);
            edit(row.ownerID, draft => ({...draft, division}));
          }}>
            {#if !keys.includes(row.division)}<option value={row.division} disabled>{divisionName(row.division)}</option>{/if}
            {#each keys as key (key)}<option value={key}>{divisionName(key)}</option>{/each}
          </select>
        </label>
      {/if}
    </fieldset>
  {/each}
  {#if mayApply && settings !== null}<button type="submit" disabled={!dirty || saving}>{word(applyLabel, "Apply")}</button>{/if}
  {#if saved}<p role="status">Automatic pay settings saved.</p>{/if}
</form>

<style>
  .bill-automatic-settings, fieldset { display: grid; gap: 0.5rem; justify-items: start; }
  p { margin: 0; }
</style>
