<script lang="ts" module>
  // settings.char.ui's fleetup_activityPicker, fleetup_distanceFilter, fleetup_newPlayerFriendlyCb and
  // fleetup_selectedFleetID: kept while the page lives.
  const kept = { activity: 0, distance: -1, newPlayerFriendly: false, selected: null as number | null };
</script>

<script lang="ts">
  // agencyNew/ui/contentPages/contentPageFleetUp (FleetupSearchCont, 520 high) and contentPagesUI/fleetupUI:
  // the filters (topCont padded 20 above and below: the activity combo - AllActivity then GetAllFleetActivities sorted by
  // name -, the distance combo 20 to its right - ContentOfAnyDistance (-1), WithinJumps 1, 5, 10, 20 -, the new player
  // friendly checkbox 20 further, its hint) with the Register Fleet Command button on the right (primary); the adverts'
  // scroll (Activity, Fleet Leader, Fleet Name, Time Active, Members, Jumps Away; NoSearchResults when none; the server's
  // order until a header is clicked; the leader's sort his name, time active -dateCreated, members and jumps their
  // values, a private advert's maxInt - 1 and maxInt) with, on its right, the selected advert's description (250 wide;
  // DescriptionForSelectedAd upper-cased; NoDescriptionSet, NoFleetSelected as its hint); the bottom row (40 high, 40
  // above it): FleetNotListedWarning and Create Ad where the pilot bosses an unregistered fleet, and Request to Join on
  // the right where an advert is chosen (disabled with AlreadyInThisFleetHint on the pilot's own).
  // GetFleetAdsToLoad: an advert left out where the activity is not the one chosen, where only new player friendly ones
  // are wanted and it is not, or (a public one) where it is more jumps away than the distance chosen; a private one
  // (hideInfo) shows Private for its jumps and members; one with no route shows _GetNoRouteFoundText.
  // FleetUpFleetEntry: the row's labels CRYO_BLUE when it is chosen or the pilot's own fleet, bold for the pilot's own;
  // banding white 0.05 on every second row; the selection's arrow.
  // RequestToJoinFleet: JoinFleetConfirmationWnd (JoinRequestHeader; Fleet Name, Activity, NumberOfCapsuleers and the
  // advert's in CRYO_BLUE; ConfirmationText with the boss's name; Send Join Request, Cancel), then ApplyToJoinFleet with
  // autoAccept.
  // Not here (later parts): the registration page (group 68, the Register and Create Ad buttons' target), the leader's
  // standing flag and its sort, the row's tooltip and menu, dragging a fleet's link.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { FleetAdvert } from "../bridge/fleetAds.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { SHORT_INTERVAL_WORD_LABELS, shortIntervalWriter } from "../bridge/timeInterval.ts";
  import { resolvedName } from "../store/names.ts";
  import LabelText from "./LabelText.svelte";

  let { store, flow, onShow }: { store: ClientStore; flow: AppFlow; onShow?: (groupID: number) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  const U = "UI/Agency/Fleetup/";
  const nameOf = (kind: "owner" | "type" | "location", id: number) => resolvedName($names.resolved, kind as never, id, "");
  const word = (label: string, args: Record<string, unknown> = {}) => plainText(formatTemplate($words.templates[label] ?? "", args as never, { nameOf: nameOf as never }));
  // evefleet/const fleetActivityNames; GetFleetActivityName: an unknown activity is ACTIVITY_MISC's.
  const ACTIVITIES: Readonly<Record<number, string>> = {
    1: "UI/Agency/ContentGroups/ContentGroupIncursions", 2: "UI/Agency/ContentGroups/ContentGroupFactionalWarfare", 3: "UI/Agency/ContentTypePirateStronghold",
    4: "UI/Agency/ContentGroups/ContentGroupAbyssalDeadspace", 5: "UI/Agency/ContentGroups/ContentGroupCombatAnomalies", 6: "UI/Agency/ContentGroups/ContentGroupEscalations",
    7: "UI/Agency/ContentGroups/ContentGroupResourceHarvesting", 8: "UI/Agency/ContentGroups/ContentGroupExploration", 9: `${U}FreeRoamOption`,
    10: "UI/Corporations/CorporationWindow/Recruitment/PVP", 11: `${U}MiscOption`, 12: `${U}MissionsEpicArcsOption`, 13: "UI/Agency/ContentGroups/ContentGroupESS",
    14: "UI/Inflight/Scanner/HomefrontOperationSite",
  };
  const activityName = (id: number | null) => word(ACTIVITIES[id ?? 11] ?? ACTIVITIES[11]!);
  const HEADERS = [`${U}ActivityHeader`, `${U}FleetLeaderHeader`, `${U}FleetNameHeader`, `${U}TimeActiveHeader`, `${U}MembersHeader`, `${U}JumpsAwayHeader`];
  const MAX_INT = 2147483647;

  type Data = NonNullable<Awaited<ReturnType<AppFlow["agencyFleetUp"]>>>;
  let data = $state<Data | null | undefined>(undefined);
  let activity = $state(kept.activity), distance = $state(kept.distance), newPlayerFriendly = $state(kept.newPlayerFriendly);
  let selected = $state<number | null>(kept.selected);
  let sortBy = $state<number | null>(null), sortDown = $state(false);
  let confirming = $state<FleetAdvert | null>(null), sending = $state(false);
  $effect(() => { kept.activity = activity; kept.distance = distance; kept.newPlayerFriendly = newPlayerFriendly; kept.selected = selected; });
  function load(): void { void flow.agencyFleetUp().then((d) => { data = d; }); }
  $effect(() => { load(); });
  $effect(() => {
    flow.requestWords([...HEADERS, ...Object.values(ACTIVITIES), ...SHORT_INTERVAL_WORD_LABELS, `${U}AllActivity`, `${U}Fleet ActivityFilter`, "UI/Agency/ContentOfAnyDistance",
      `${U}WithinJumps`, `${U}JumpsAwayFilter`, `${U}NewPlayerFriendlyFilter`, `${U}NewPlayerFriendlyFilterHint`, `${U}RegisterFleetCommandBtn`, `${U}RegisterFleetCommandBtnHint`,
      `${U}UpdateFleetAdvertBtn`, `${U}UpdateFleetAdvertBtnHint`, `${U}AlreadyInFleetHint`, `${U}RequestToJoin`, `${U}AlreadyInThisFleetHint`, `${U}DescriptionForSelectedAd`,
      `${U}NoDescriptionSet`, `${U}NoFleetSelected`, `${U}NoSearchResults`, `${U}FleetNotListedWarning`, `${U}CreateAdBtn`, "UI/Generic/Private", "UI/Generic/NoGateToGateRoute",
      "UI/Generic/Unreachable", `${U}JoinRequestHeader`, `${U}NumberOfCapsuleers`, `${U}ConfirmationText`, `${U}SendJoinRequest`, "UI/Commands/Cancel"]);
  });
  $effect(() => { if (data) flow.requestNames(data.ads.filter((a) => a.leader.charID !== null).map((a) => ({ kind: "owner" as const, id: a.leader.charID! }))); });

  const activityOptions = $derived([[0, word(`${U}AllActivity`)] as const, ...Object.keys(ACTIVITIES).map((k) => [Number(k), word(ACTIVITIES[Number(k)]!)] as const)
    .sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()))]);
  const distanceOptions = $derived([[-1, word("UI/Agency/ContentOfAnyDistance")] as const, ...[1, 5, 10, 20].map((n) => [n, word(`${U}WithinJumps`, { jumpCount: n })] as const)]);
  const writeShort = $derived(shortIntervalWriter($words.templates));
  interface Row { readonly ad: FleetAdvert; readonly fleetID: number; readonly cells: readonly string[]; readonly privateJumps: boolean; readonly privateMembers: boolean; readonly sort: readonly (string | number)[] }
  /** GetFleetAdsToLoad. */
  const rows = $derived.by((): Row[] => {
    if (!data) return [];
    const out: Row[] = [];
    for (const ad of data.ads) {
      if (activity && activity !== ad.activityValue) continue;
      if (newPlayerFriendly && !ad.newPlayerFriendly) continue;
      const known = ad.solarSystemID === null ? null : data.jumps[String(ad.solarSystemID)] ?? null;
      let jumps = known ?? MAX_INT, jumpsText = String(jumps), members: number = ad.numMembers, membersText = String(members);
      if (ad.hideInfo) { jumps = MAX_INT - 1; members = MAX_INT; jumpsText = membersText = word("UI/Generic/Private"); }
      else if (distance > 0) { if (jumps > distance) continue; }
      else if (jumps === MAX_INT) jumpsText = word(data.noRoute[String(ad.solarSystemID)] ?? "UI/Generic/Unreachable");
      const leader = ad.leader.charID === null ? "" : nameOf("owner", ad.leader.charID);
      const age = ad.dateCreated === null ? null : data.nowTicks - ad.dateCreated;
      const ageText = age === null ? "" : writeShort(age < 0n ? -age : age, "day", "second") ?? "";
      const name = activityName(ad.activityValue);
      out.push({ ad, fleetID: ad.fleetID!, cells: [name, leader, ad.fleetName, ageText, membersText, jumpsText], privateJumps: ad.hideInfo, privateMembers: ad.hideInfo,
        sort: [name.toLowerCase(), leader.toLowerCase(), ad.fleetName.toLowerCase(), -Number(ad.dateCreated ?? 0n), members, jumps] });
    }
    if (sortBy !== null) {
      const i = sortBy;
      out.sort((a, b) => { const x = a.sort[i]!, y = b.sort[i]!; const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y)); return sortDown ? -c : c; });
    }
    return out;
  });
  const chosen = $derived(rows.find((r) => r.fleetID === selected) ?? null);
  const inFleet = $derived(data?.fleetID ?? null);
  /** UpdateButtons. */
  const register = $derived.by(() => {
    if (inFleet === null) return { label: `${U}RegisterFleetCommandBtn`, hint: `${U}RegisterFleetCommandBtnHint`, enabled: true, createAd: false };
    if (data?.isBoss && !data.registered) return { label: `${U}RegisterFleetCommandBtn`, hint: `${U}AlreadyInFleetHint`, enabled: false, createAd: true };
    if (data?.isBoss && data.registered) return { label: `${U}UpdateFleetAdvertBtn`, hint: `${U}UpdateFleetAdvertBtnHint`, enabled: true, createAd: false };
    return { label: `${U}RegisterFleetCommandBtn`, hint: `${U}AlreadyInFleetHint`, enabled: false, createAd: false };
  });
  function sortOn(i: number): void { if (sortBy === i) sortDown = !sortDown; else { sortBy = i; sortDown = false; } }
  async function send(): Promise<void> {
    const ad = confirming;
    if (!ad?.fleetID) return;
    sending = true;
    try { await flow.applyToJoinFleet(ad.fleetID); } catch { /* the refusal is the flow's to say */ } finally { sending = false; confirming = null; load(); }
  }
</script>

<div class="afu">
  <div class="afu-top">
    <label class="afu-combo"><span>{word(`${U}Fleet ActivityFilter`)}</span>
      <select value={activity} onchange={(e) => (activity = Number(e.currentTarget.value))}>{#each activityOptions as [v, t] (v)}<option value={v}>{t}</option>{/each}</select></label>
    <label class="afu-combo"><span>{word(`${U}JumpsAwayFilter`)}</span>
      <select value={distance} onchange={(e) => (distance = Number(e.currentTarget.value))}>{#each distanceOptions as [v, t] (v)}<option value={v}>{t}</option>{/each}</select></label>
    <label class="afu-check" title={word(`${U}NewPlayerFriendlyFilterHint`)}><input type="checkbox" checked={newPlayerFriendly} onchange={(e) => (newPlayerFriendly = e.currentTarget.checked)} />{word(`${U}NewPlayerFriendlyFilter`)}</label>
    <button type="button" class="afu-primary" disabled={!register.enabled} title={word(register.hint)} onclick={() => onShow?.(68)}>{word(register.label)}</button>
  </div>
  <div class="afu-center">
    <div class="afu-scroll">
      <table>
        <thead><tr>{#each HEADERS as h, i (h)}<th onclick={() => sortOn(i)}>{word(h)}{#if sortBy === i}<span class="afu-sort">{sortDown ? "▾" : "▴"}</span>{/if}</th>{/each}</tr></thead>
        <tbody>
          {#each rows as r, n (r.fleetID)}
            <tr class:band={n % 2 === 1} class:on={r.fleetID === selected} class:mine={r.fleetID === inFleet} onclick={() => (selected = r.fleetID)}>
              {#each r.cells as c, i (i)}<td class:priv={(i === 4 && r.privateMembers) || (i === 5 && r.privateJumps)}>{#if i === 0 && r.fleetID === selected}<span class="afu-arrow">▸</span>{/if}{c}</td>{/each}
            </tr>
          {/each}
        </tbody>
      </table>
      {#if data !== undefined && rows.length === 0}<p class="afu-none">{word(`${U}NoSearchResults`)}</p>{/if}
    </div>
    <aside class="afu-desc">
      {#if chosen}
        <h4>{word(`${U}DescriptionForSelectedAd`).toUpperCase()}</h4>
        <div class="afu-desc-text"><LabelText markup={chosen.ad.description || ($words.templates[`${U}NoDescriptionSet`] ?? "")} /></div>
      {:else}<p class="afu-hint">{word(`${U}NoFleetSelected`)}</p>{/if}
    </aside>
  </div>
  <div class="afu-bottom">
    {#if register.createAd}
      <div class="afu-warn"><span>⚠ {word(`${U}FleetNotListedWarning`)}</span><button type="button" onclick={() => onShow?.(68)}>{word(`${U}CreateAdBtn`)}</button></div>
    {/if}
    {#if chosen}
      <button type="button" class="afu-join" disabled={chosen.fleetID === inFleet} title={chosen.fleetID === inFleet ? word(`${U}AlreadyInThisFleetHint`) : ""} onclick={() => (confirming = chosen.ad)}>{word(`${U}RequestToJoin`)}</button>
    {/if}
  </div>
  {#if confirming}
    {@const ad = confirming}
    <div class="afu-modal" role="dialog" aria-modal="true">
      <div class="afu-dialog">
        <h3>{word(`${U}JoinRequestHeader`)}</h3>
        <div class="afu-grid">
          <b>{word(`${U}FleetNameHeader`)}</b><b>{word(`${U}ActivityHeader`)}</b><b>{word(`${U}NumberOfCapsuleers`)}</b>
          <span>{ad.fleetName}</span><span>{activityName(ad.activityValue)}</span><span class:priv={ad.hideInfo}>{ad.hideInfo ? word("UI/Generic/Private") : ad.numMembers}</span>
        </div>
        <p class="afu-confirm">{word(`${U}ConfirmationText`, { charName: ad.leader.charID === null ? "" : nameOf("owner", ad.leader.charID) })}</p>
        <div class="afu-buttons">
          <button type="button" class="afu-primary" disabled={sending} onclick={() => void send()}>{word(`${U}SendJoinRequest`)}</button>
          <button type="button" disabled={sending} onclick={() => (confirming = null)}>{word("UI/Commands/Cancel")}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .afu { position: relative; display: flex; flex-direction: column; height: 100%; max-height: 520px; min-height: 0; font-size: 13px; }
  .afu-top { display: flex; align-items: flex-end; gap: 20px; padding: 20px 0; }
  .afu-combo { display: flex; flex-direction: column; gap: 2px; }
  .afu-combo span { font-size: 11px; opacity: 0.7; }
  .afu-check { display: flex; align-items: center; gap: 6px; padding-bottom: 4px; }
  .afu-primary { margin-left: auto; background: rgb(106 195 236 / 0.25); border: 1px solid rgb(106 195 236 / 0.6); }
  .afu-center { flex: 1; min-height: 0; display: flex; }
  .afu-scroll { flex: 1; min-width: 0; overflow: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 600; font-size: 12px; padding: 4px 14px; cursor: pointer; white-space: nowrap; border-bottom: 1px solid rgb(255 255 255 / 0.15); }
  td { padding: 5px 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  tr.band td { background: rgb(255 255 255 / 0.05); }
  tbody tr { cursor: pointer; }
  tbody tr:hover td { background: rgb(106 195 236 / 0.1); }
  tr.on td { background: rgb(106 195 236 / 0.2); color: #6ac3ec; }
  tr.mine td { color: #6ac3ec; font-weight: 700; }
  td.priv, span.priv { color: rgb(136 136 136 / 0.5); }
  .afu-arrow { margin: 0 4px 0 -10px; font-size: 9px; }
  .afu-sort { margin-left: 4px; font-size: 10px; }
  .afu-none { text-align: center; opacity: 0.6; margin-top: 20px; }
  .afu-desc { width: 250px; flex: none; padding-left: 10px; display: flex; flex-direction: column; min-height: 0; }
  .afu-desc h4 { margin: 0 0 0 20px; font-size: 12px; font-weight: 600; padding: 4px 0; }
  .afu-desc-text { flex: 1; overflow: auto; padding: 6px; }
  .afu-hint { opacity: 0.5; padding: 6px; margin: 0; }
  .afu-bottom { display: flex; align-items: center; height: 40px; margin: 40px 0 37px; }
  .afu-warn { display: flex; align-items: center; gap: 10px; }
  .afu-warn span { color: #f0b030; }
  .afu-join { margin-left: auto; }
  .afu-modal { position: absolute; inset: 0; background: rgb(0 0 0 / 0.5); display: flex; align-items: center; justify-content: center; z-index: 5; }
  .afu-dialog { min-width: 400px; min-height: 300px; box-sizing: border-box; padding: 32px 25px 26px; background: #15191d; border: 1px solid rgb(255 255 255 / 0.15); display: flex; flex-direction: column; }
  .afu-dialog h3 { margin: 0 0 13px 10px; font-size: 18px; font-weight: 400; text-transform: uppercase; }
  .afu-grid { display: grid; grid-template-columns: repeat(3, auto); column-gap: 100px; row-gap: 0; }
  .afu-grid b { padding: 11px 10px; text-transform: uppercase; font-weight: 400; font-size: 14px; }
  .afu-grid span { padding: 9px 10px; color: #6ac3ec; background: rgb(106 195 236 / 0.05); }
  .afu-confirm { margin: 36px 0 0 11px; font-size: 14px; }
  .afu-buttons { margin-top: auto; padding-top: 20px; display: flex; justify-content: flex-end; gap: 10px; }
  .afu-buttons button { min-width: 110px; }
</style>
