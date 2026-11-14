<script lang="ts" module>
  // settings.char.ui fleetAdvert_lastAdvert (_FinializeRegistration): the advert last registered, kept while the page lives.
  let lastAdvert: { fleetName: string; description: string; activityValue: number | null; newPlayerFriendly: boolean } | null = null;
</script>

<script lang="ts">
  // agencyNew/ui/contentPages/contentPageFleetUpRegister (FleetRegister, 22 above) and fleetupUI/fleetRegister's
  // BasicOptionsCont (32 above): on the left (0.46 wide) the fleet's name (18 high letters, 40 high, FleetNameHint,
  // 32 letters with their count, 40 below it), DescriptionForOwnAd and the description (280 high, 250 letters,
  // DescriptionForOwnAdHint); on the right (100 in) the activity (SelectFleetActivity; GetAllFleetActivities sorted
  // by name), 25 below it Hide Fleet, New Player Friendly and Use Advanced Options with their hints, PrivateWarning
  // (40 high, 20 above) where the fleet is hidden; the buttons at the bottom right: Register Fleet (primary, 40 high;
  // UpdateRegistration where the fleet is registered), Advanced, Cancel.
  // LoadData: a pilot in a fleet who is not its boss is shown nothing; else the fleet's advert where it is
  // registered, or the one last registered (fleetAdvert_lastAdvert).
  // UpdateUI: Hide Fleet greys the name, the description (its label 0.1), the activity, New Player Friendly and Use
  // Advanced Options, and shows the warning.
  // RegisterFleet: hidden, no advert; else the name required (CustomInfo FleetNameRequired) and the advert with the
  // public scope (INVITE_PUBLIC_OPEN) and the default advanced options; CreateAndRegisterFleet; then Fleet Up.
  // Not here (the next part): the advanced options (AdvancedOptionsCont, the Advanced button and Use Advanced
  // Options, drawn disabled) and their summary (GetAdvancedText).
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";

  let { store, flow, onShow }: { store: ClientStore; flow: AppFlow; onShow?: (groupID: number) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const U = "UI/Agency/Fleetup/";
  const word = (label: string) => plainText(formatTemplate($words.templates[label] ?? "", {} as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  const ACTIVITIES: Readonly<Record<number, string>> = {
    1: "UI/Agency/ContentGroups/ContentGroupIncursions", 2: "UI/Agency/ContentGroups/ContentGroupFactionalWarfare", 3: "UI/Agency/ContentTypePirateStronghold",
    4: "UI/Agency/ContentGroups/ContentGroupAbyssalDeadspace", 5: "UI/Agency/ContentGroups/ContentGroupCombatAnomalies", 6: "UI/Agency/ContentGroups/ContentGroupEscalations",
    7: "UI/Agency/ContentGroups/ContentGroupResourceHarvesting", 8: "UI/Agency/ContentGroups/ContentGroupExploration", 9: `${U}FreeRoamOption`,
    10: "UI/Corporations/CorporationWindow/Recruitment/PVP", 11: `${U}MiscOption`, 12: `${U}MissionsEpicArcsOption`, 13: "UI/Agency/ContentGroups/ContentGroupESS",
    14: "UI/Inflight/Scanner/HomefrontOperationSite",
  };
  const options = $derived(Object.keys(ACTIVITIES).map((k) => [Number(k), word(ACTIVITIES[Number(k)]!)] as const).sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase())));

  let loaded = $state<Awaited<ReturnType<AppFlow["agencyFleetRegistration"]>> | null>(null);
  let fleetName = $state(""), description = $state(""), activity = $state<number | null>(null), newPlayerFriendly = $state(false), hidden = $state(false), busy = $state(false);
  $effect(() => {
    void flow.agencyFleetRegistration().then((r) => {
      loaded = r;
      if (r.inFleet && !r.isBoss) return;
      const from = r.advert ? { fleetName: r.advert.fleetName, description: r.advert.description, activityValue: r.advert.activityValue, newPlayerFriendly: r.advert.newPlayerFriendly } : lastAdvert;
      if (!from) return;
      fleetName = from.fleetName; description = from.description; activity = from.activityValue; newPlayerFriendly = from.newPlayerFriendly;
    });
  });
  $effect(() => {
    flow.requestWords([...Object.values(ACTIVITIES), `${U}FleetNameHint`, `${U}DescriptionForOwnAd`, `${U}DescriptionForOwnAdHint`, `${U}SelectFleetActivity`, `${U}HideFleetCb`,
      `${U}HideFleetCbHint`, `${U}NewPlayerFriendlyCb`, `${U}NewPlayerFriendlyCbHint`, `${U}UseAdvancedOptionsCb`, `${U}UseAdvancedOptionsCbHint`, `${U}PrivateWarning`,
      `${U}AdvancedBtn`, `${U}RegisterFleetBn`, `${U}UpdateRegistration`, "UI/Commands/Cancel", `${U}FleetNameRequired`]);
  });
  // The Combo's first option where the advert names none (Combo.SetValue of a value it has not leaves its first).
  const shownActivity = $derived(activity !== null && ACTIVITIES[activity] ? activity : options[0]?.[0] ?? null);

  async function register(): Promise<void> {
    let advert = null;
    if (!hidden) {
      const name = fleetName.trim();
      if (name.length < 1) {
        // raise UserError('CustomInfo', {'info': FleetNameRequired})
        const text = word(`${U}FleetNameRequired`);
        flow.sayDialog("CustomInfo", { type: "dict", entries: [["info", text]] }, text);
        return;
      }
      advert = { fleetName: name, description: description.trim(), activityValue: shownActivity, newPlayerFriendly };
    }
    busy = true;
    try {
      if (await flow.agencyRegisterFleet(advert)) {
        if (advert) lastAdvert = { ...advert, fleetName: advert.fleetName.slice(0, 32), description: advert.description.slice(0, 250) };
        onShow?.(67);
      }
    } finally { busy = false; }
  }
</script>

<div class="afr">
  <div class="afr-left">
    <div class="afr-name">
      <input type="text" maxlength="32" placeholder={word(`${U}FleetNameHint`)} disabled={hidden} value={fleetName} oninput={(e) => (fleetName = e.currentTarget.value)} />
      <span class="afr-count">{fleetName.length}/32</span>
    </div>
    <p class="afr-label" class:dim={hidden}>{word(`${U}DescriptionForOwnAd`)}</p>
    <textarea maxlength="250" placeholder={word(`${U}DescriptionForOwnAdHint`)} disabled={hidden} value={description} oninput={(e) => (description = e.currentTarget.value)}></textarea>
  </div>
  <div class="afr-right">
    <label class="afr-combo"><span>{word(`${U}SelectFleetActivity`)}</span>
      <select disabled={hidden} value={shownActivity} onchange={(e) => (activity = Number(e.currentTarget.value))}>{#each options as [v, t] (v)}<option value={v}>{t}</option>{/each}</select></label>
    <label class="afr-check afr-first" title={word(`${U}HideFleetCbHint`)}><input type="checkbox" checked={hidden} onchange={(e) => (hidden = e.currentTarget.checked)} />{word(`${U}HideFleetCb`)}</label>
    <label class="afr-check" title={word(`${U}NewPlayerFriendlyCbHint`)}><input type="checkbox" disabled={hidden} checked={newPlayerFriendly} onchange={(e) => (newPlayerFriendly = e.currentTarget.checked)} />{word(`${U}NewPlayerFriendlyCb`)}</label>
    <label class="afr-check" title={word(`${U}UseAdvancedOptionsCbHint`)}><input type="checkbox" disabled />{word(`${U}UseAdvancedOptionsCb`)}</label>
    {#if hidden}<p class="afr-warn">⚠ {word(`${U}PrivateWarning`)}</p>{/if}
  </div>
  <div class="afr-buttons">
    <button type="button" class="afr-primary" disabled={busy || loaded === null} onclick={() => void register()}>{word(loaded?.registered ? `${U}UpdateRegistration` : `${U}RegisterFleetBn`)}</button>
    <button type="button" disabled>{word(`${U}AdvancedBtn`)}</button>
    <button type="button" onclick={() => onShow?.(67)}>{word("UI/Commands/Cancel")}</button>
  </div>
</div>

<style>
  .afr { position: relative; display: flex; height: 100%; min-height: 420px; padding-top: 54px; box-sizing: border-box; font-size: 13px; }
  .afr-left { width: 46%; flex: none; display: flex; flex-direction: column; }
  .afr-name { position: relative; margin-bottom: 40px; }
  .afr-name input { width: 100%; height: 40px; box-sizing: border-box; font-size: 18px; padding: 0 50px 0 14px; }
  .afr-count { position: absolute; right: 10px; top: 12px; font-size: 11px; opacity: 0.6; }
  .afr-label { margin: 0 0 6px; font-size: 15px; }
  .afr-label.dim { opacity: 0.1; }
  .afr-left textarea { height: 280px; resize: none; box-sizing: border-box; font: inherit; padding: 6px; }
  .afr-right { flex: 1; padding: 0 10px 0 100px; display: flex; flex-direction: column; align-items: flex-start; }
  .afr-combo { display: flex; flex-direction: column; gap: 2px; }
  .afr-combo span { font-size: 11px; opacity: 0.7; }
  .afr-check { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
  .afr-first { margin-top: 25px; }
  .afr-warn { margin: 20px 0 0; min-height: 40px; color: #f0b030; }
  .afr-buttons { position: absolute; right: 0; bottom: 0; display: flex; gap: 10px; align-items: flex-end; }
  .afr-primary { height: 40px; min-width: 120px; background: rgb(106 195 236 / 0.25); border: 1px solid rgb(106 195 236 / 0.6); }
</style>
