<script lang="ts">
  // corp_ui_recruitment.py CorpRecruitment (Administration > Recruitment > Corporation Advertisements): the
  // corporation's ads (corpRecProxy.GetRecruitmentAdsForCorporation), CorpHasNoRecruitmentAdvertisements where it has
  // none; for a personnel manager (HasAccess) the button group - Create Recruitment Ad (corporationMaxRecruitmentAds 3)
  // and Edit Welcome Mail - over the "Membership applications enabled" checkbox. Create opens
  // CorpRecruitmentContainerCreation (PopulateCorpAdvertsEdit): the title (40) and message (1000) at the left; at the
  // right (230) Submit / Cancel and two tabs - Details: the play-style kind (a combo of PVE / PVP / Trade, the other
  // kinds' types dropped), its types (at most 4), New Pilot Friendly / Focused (Focused only with Friendly),
  // Roleplaying, Area of Operations (at most 2), Language (the session's to start), Primary Timezone (at most 8 hours),
  // the duration (1 to 28 days, the price: flat fee 500,000 + 250,000 a day), Minimum SP; Recruiters: the members,
  // filtered, at most six added. (Here: the ads a plain list; the form a box over the panel; the welcome mail and
  // the applications checkbox shown, not acting.)
  import { onMount } from "svelte";
  import RecruitmentEntry from "./RecruitmentEntry.svelte";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { RecruitmentData } from "../app/api.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import {
    buildHourMask, typesMask, typesInMask, timeZoneFromMask, combinedGroupOf, PLAYSTYLE_GROUPS, AREA_OF_OPERATIONS_GROUPID, LANGUAGE_GROUPID,
    NEWPILOTFRIENDLY_TYPEID, NEWPILOTFOCUSED_TYPEID, ROLEPLAY_TYPEID, ENGLISH_TYPEID, MAX_SELECTED_TYPES, MAX_SELECTED_AREAS,
    AD_FLAT_FEE, AD_DAILY_RATE, AD_MAX_DAYS, MAX_CORP_ADS, AD_MAX_TITLE, AD_MAX_MESSAGE, type RecruitmentAd,
  } from "../bridge/corpRecruitment.ts";
  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const R = "UI/Corporations/CorporationWindow/Recruitment/";
  const LABELS = ["CreateRecruitmentAdButtonLabel", "CorpHasNoRecruitmentAdvertisements", "CreateNewAdvert", "AdEditTitle", "AdEditMessage", "AdEditDetails",
    "AdRecruiters", "NewPilotFriendly", "NewPilotFocused", "RoleplayingFocused2", "PrimaryTimeZone", "RecruitmentAdDuration",
    "RecruitmentAdDurationOptionWithPrice", "MinimumSPrequirement", "FilterRecruiterCandidates", "AddRecruiterToAd", "NoRecruiterAssigned",
    "AdRemove", "EditAdvert", "ExtendRecruitmentAdDuration", "NumFiltersSelected", "NoFiltersSelected", "PVE", "PVP", "Trade"].map((k) => R + k)
    .concat(["UI/Corporations/Applications/EditWelcomeMail", "UI/Corporations/CorpDetails/MembershipApplicationEnabled", "UI/Common/Buttons/Submit", "UI/Common/Buttons/Cancel"]);
  const word = (label: string, fallback: string) => plainText($words.templates[label] ?? fallback);
  const fill = (label: string, fallback: string, values: Record<string, string | number>) =>
    plainText(formatTemplate($words.templates[label] ?? fallback, values, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  // HasAccess: const.corpRolePersonnelManager (128) in the session's corprole
  const access = $derived((BigInt($station.online?.corpRole ?? "0") & 128n) === 128n);
  const corpID = $derived($station.online?.corporationID ?? 0);

  // corporation_recruitmentad_expanded: the expanded ad, by the view (the corporation's own or the finder)
  function expandedOf(view: boolean): number | null { try { return (JSON.parse(localStorage.getItem("evejs.play.corpRecruitmentExpanded") ?? "{}") as Record<string, number | null>)[String(view)] ?? null; } catch { return null; } }
  function keepExpanded(view: boolean, adID: number | null): void { try { const all = JSON.parse(localStorage.getItem("evejs.play.corpRecruitmentExpanded") ?? "{}") as Record<string, number | null>; all[String(view)] = adID; localStorage.setItem("evejs.play.corpRecruitmentExpanded", JSON.stringify(all)); } catch { /* not kept */ } }
  let expandedAd = $state<number | null>(expandedOf(true));
  let ads = $state<readonly RecruitmentAd[] | null>(null);
  let data = $state<RecruitmentData | null>(null);
  let error = $state("");
  function loadAds(): void {
    void flow.corporationRecruitmentAds().then((a) => { ads = a; }).catch((e) => { error = e instanceof Error ? e.message : String(e); ads = []; });
  }
  onMount(() => {
    flow.requestWords(LABELS);
    loadAds();
    void flow.recruitmentData().then((d) => {
      data = d;
      if (d) flow.requestWords(Object.values(d.types).flatMap((t) => (t.nameID ? [`#${t.nameID}`] : [])).concat(Object.values(d.groups).flatMap((g) => (g.nameID ? [`#${g.nameID}`] : []))));
    });
  });
  const typesOf = (groupID: number): number[] => data ? Object.entries(data.types).filter(([, t]) => t.groupID === groupID).map(([id]) => Number(id)).sort((a, b) => a - b) : [];
  const typeName = (id: number) => { const n = data?.types[String(id)]?.nameID; return n ? word(`#${n}`, String(id)) : String(id); };
  const groupName = (id: number) => { const n = data?.groups[String(id)]?.nameID; return n ? word(`#${n}`, String(id)) : String(id); };
  const countHint = (n: number) => n > 0 ? fill(R + "NumFiltersSelected", "{num} filters selected", { num: n }) : word(R + "NoFiltersSelected", "No filters selected");

  // the form (a new ad)
  let editing = $state(false), tab = $state<"details" | "recruiters">("details"), open = $state<"style" | "area" | "language" | null>(null);
  let title = $state(""), message = $state(""), kind = $state(0), types = $state<number[]>([]), langs = $state<number[]>([ENGLISH_TYPEID]);
  let friendly = $state(false), focused = $state(false), roleplay = $state(false), from = $state(0), to = $state(24), days = $state(1), minSP = $state(0);
  let members = $state<readonly number[]>([]), filter = $state(""), recruiters = $state<number[]>([]), picked = $state<number | null>(null), sending = $state(false);
  // the ad edited (OpenEditWindow -> PopulateCorpAdvertsEdit(advertData)), and the days it may still be extended by
  // (corporationMaxRecruitmentAdDuration less the days remaining; none - no duration shown)
  let editingAd = $state<RecruitmentAd | null>(null), maxDays = $state(AD_MAX_DAYS);
  function startEdit(ad: RecruitmentAd): void {
    const remaining = Math.max(0, Math.floor(((ad.expiryDateTimeMs ?? Date.now()) - Date.now()) / 86_400_000));
    maxDays = AD_MAX_DAYS - remaining;
    types = typesInMask(ad.typeMask); langs = typesInMask(ad.langMask);
    // GetGroupWithMostSelected; RemoveTypesFromOtherGroups
    const most = [0, 1, 2].map((g) => types.filter((id) => combinedGroupOf(id) === g).length);
    kind = most.indexOf(Math.max(...most));
    types = types.filter((id) => combinedGroupOf(id) === null || combinedGroupOf(id) === kind);
    const other = typesInMask(ad.otherMask);
    friendly = other.includes(NEWPILOTFRIENDLY_TYPEID); focused = friendly && other.includes(NEWPILOTFOCUSED_TYPEID); roleplay = other.includes(ROLEPLAY_TYPEID);
    [from, to] = timeZoneFromMask(ad.hourMask1) as [number, number];
    title = ad.title; message = ad.description; days = 0; minSP = ad.minSP; recruiters = []; tab = "details"; open = null;
    editingAd = ad; editing = true;
    void flow.recruitmentAdRecruiters(ad.adID).then((ids) => { recruiters = [...ids].slice(0, 6); });
    void flow.corporationMemberIDs().then((ids) => { members = ids; flow.requestNames(ids.map((id) => ({ kind: "character" as const, id }))); });
  }
  function startNew(): void {
    // PopulateCorpAdvertsEdit(None): the last ad's masks (corp_recruitment_lastCreate*), else none; the session's language
    const last = (() => { try { return JSON.parse(localStorage.getItem("evejs.play.corpRecruitmentLastAd") ?? "null") as { mask: number; lang: number } | null; } catch { return null; } })();
    types = last ? typesInMask(last.mask) : []; langs = last && last.lang ? typesInMask(last.lang) : [ENGLISH_TYPEID];
    const most = [0, 1, 2].map((g) => types.filter((id) => combinedGroupOf(id) === g).length);
    kind = most.indexOf(Math.max(...most));
    types = types.filter((id) => combinedGroupOf(id) === null || combinedGroupOf(id) === kind);
    title = ""; message = ""; friendly = false; focused = false; roleplay = false; from = 0; to = 24; days = 1; minSP = 0; recruiters = []; tab = "details"; open = null;
    editingAd = null; maxDays = AD_MAX_DAYS;
    editing = true;
    void flow.corporationMemberIDs().then((ids) => { members = ids; flow.requestNames(ids.map((id) => ({ kind: "character" as const, id }))); });
  }
  const playStyles = $derived(types.filter((id) => combinedGroupOf(id) !== null));
  const areas = $derived(types.filter((id) => typesOf(AREA_OF_OPERATIONS_GROUPID).includes(id)));
  function toggle(id: number, isArea: boolean): void {
    if (types.includes(id)) { types = types.filter((t) => t !== id); return; }
    // CheckCanSelectPlaystyleOption / CheckCanSelectAreaOption
    if (!isArea && playStyles.length >= MAX_SELECTED_TYPES) { flow.sayDialog("CannotSelectMorePlaystyles", { type: "dict", entries: [["numMaxOptions", MAX_SELECTED_TYPES]] }, `You can select at most ${MAX_SELECTED_TYPES} play styles.`); return; }
    if (isArea && areas.length >= MAX_SELECTED_AREAS) { flow.sayDialog("CannotSelectMoreAreas", { type: "dict", entries: [["numMaxOptions", MAX_SELECTED_TYPES]] }, `You can select at most ${MAX_SELECTED_AREAS} areas.`); return; }
    types = [...types, id];
  }
  // AdvertPrice: the days at the daily rate, and the flat fee for a new ad
  const price = $derived(days * AD_DAILY_RATE + (editingAd ? 0 : AD_FLAT_FEE));
  const isk = (n: number) => `${n.toLocaleString("en-US")} ISK`;
  const memberName = (id: number) => resolvedName($names.resolved, "character", id, String(id));
  const candidates = $derived(members.filter((id) => !recruiters.includes(id) && memberName(id).toLowerCase().includes(filter.toLowerCase()))
    .slice().sort((a, b) => memberName(a).localeCompare(memberName(b))));
  function addRecruiter(id: number | null): void { if (id !== null && recruiters.length < 6 && !recruiters.includes(id)) recruiters = [...recruiters, id]; }
  async function submit(): Promise<void> {
    if (sending) return;
    sending = true; error = "";
    const otherMask = typesMask([...(friendly ? [NEWPILOTFRIENDLY_TYPEID] : []), ...(friendly && focused ? [NEWPILOTFOCUSED_TYPEID] : []), ...(roleplay ? [ROLEPLAY_TYPEID] : [])]);
    const typeMask = typesMask(types), langMask = typesMask(langs);
    try {
      const form = { days, typeMask, langMask, description: message, recruiters, title, hourMask1: buildHourMask(from, to), minSP, otherMask };
      if (editingAd) {
        if (await flow.updateRecruitmentAd(editingAd.adID, form)) { editing = false; editingAd = null; loadAds(); }
      } else if (await flow.createRecruitmentAd(form)) {
        try { localStorage.setItem("evejs.play.corpRecruitmentLastAd", JSON.stringify({ mask: typeMask, lang: langMask })); } catch { /* not kept */ }
        editing = false; loadAds();
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { sending = false; }
  }
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
</script>

<div class="corp-adverts">
  <div class="ca-scroll">
    {#if error}<p class="error">{error}</p>{/if}
    {#if ads !== null && !ads.length}<p class="ca-note">{fill(R + "CorpHasNoRecruitmentAdvertisements", "{corpName} has no recruitment advertisements", { corpName: resolvedName($names.resolved, "corporation", corpID, "") })}</p>{/if}
    {#each ads ?? [] as ad (ad.adID)}
      <RecruitmentEntry {store} {flow} {ad} {data} corpView={true} {access} expanded={expandedAd === ad.adID}
        onToggle={() => { expandedAd = expandedAd === ad.adID ? null : ad.adID; keepExpanded(true, expandedAd); }} onDeleted={loadAds} onEdit={() => startEdit(ad)} />
    {/each}
  </div>
  {#if access}
    <div class="ca-buttons">
      <button type="button" disabled={(ads?.length ?? 0) >= MAX_CORP_ADS} onclick={startNew}>{word(R + "CreateRecruitmentAdButtonLabel", "Create Recruitment Ad")}</button>
      <button type="button" disabled title="Not on the play page yet">{word("UI/Corporations/Applications/EditWelcomeMail", "Edit Welcome Mail")}</button>
    </div>
    <label class="ca-apps"><input type="checkbox" disabled />{word("UI/Corporations/CorpDetails/MembershipApplicationEnabled", "Membership application enabled")}</label>
  {/if}
  {#if editing}
    <section class="ca-form" aria-label={word(R + "CreateNewAdvert", "Create New Advert")} aria-busy={sending}>
      <div class="ca-main">
        <div class="ca-caption">{editingAd ? fill(R + "EditAdvert", "Edit Advert: {adTitle}", { adTitle: editingAd.title }) : word(R + "CreateNewAdvert", "Create New Advert")}</div>
        <label class="ca-label">{word(R + "AdEditTitle", "Title")}<input bind:value={title} maxlength={AD_MAX_TITLE} /></label>
        <label class="ca-label ca-msg">{word(R + "AdEditMessage", "Message")}<textarea bind:value={message} maxlength={AD_MAX_MESSAGE}></textarea></label>
      </div>
      <div class="ca-side">
        <div class="ca-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "details"} onclick={() => (tab = "details")}>{word(R + "AdEditDetails", "Details")}</button>
          <button type="button" role="tab" aria-selected={tab === "recruiters"} onclick={() => (tab = "recruiters")}>{word(R + "AdRecruiters", "Recruiters")}</button>
        </div>
        {#if tab === "details"}
          <div class="ca-details">
            <div class="ca-head">{groupName(11)}</div>
            <select aria-label="Play style kind" value={kind} onchange={(e) => { kind = Number((e.currentTarget as HTMLSelectElement).value); types = types.filter((id) => combinedGroupOf(id) === null || combinedGroupOf(id) === kind); }}>
              {#each PLAYSTYLE_GROUPS as g, i (g.label)}<option value={i}>{word(g.label, g.label.split("/").pop() ?? "")}</option>{/each}
            </select>
            <button type="button" class="ca-menu" title={playStyles.map(typeName).join(", ")} onclick={() => (open = open === "style" ? null : "style")}>{countHint(playStyles.length)}</button>
            {#if open === "style"}
              <div class="ca-list">{#each PLAYSTYLE_GROUPS[kind]!.typeIDs as id (id)}<label><input type="checkbox" checked={types.includes(id)} onchange={() => toggle(id, false)} />{typeName(id)}</label>{/each}</div>
            {/if}
            <label class="ca-check"><input type="checkbox" bind:checked={friendly} onchange={() => { if (!friendly) focused = false; }} />{word(R + "NewPilotFriendly", "New Pilot Friendly")}</label>
            <label class="ca-check"><input type="checkbox" bind:checked={focused} disabled={!friendly} />{word(R + "NewPilotFocused", "New Pilot Focused")}</label>
            <label class="ca-check"><input type="checkbox" bind:checked={roleplay} />{word(R + "RoleplayingFocused2", "Roleplaying")}</label>
            <div class="ca-head">{groupName(AREA_OF_OPERATIONS_GROUPID)}</div>
            <button type="button" class="ca-menu" onclick={() => (open = open === "area" ? null : "area")}>{countHint(areas.length)}</button>
            {#if open === "area"}
              <div class="ca-list">{#each typesOf(AREA_OF_OPERATIONS_GROUPID) as id (id)}<label><input type="checkbox" checked={types.includes(id)} onchange={() => toggle(id, true)} />{typeName(id)}</label>{/each}</div>
            {/if}
            <div class="ca-head">{groupName(LANGUAGE_GROUPID)}</div>
            <button type="button" class="ca-menu" onclick={() => (open = open === "language" ? null : "language")}>{countHint(langs.length)}</button>
            {#if open === "language"}
              <div class="ca-list">{#each typesOf(LANGUAGE_GROUPID) as id (id)}<label><input type="checkbox" checked={langs.includes(id)} onchange={() => { langs = langs.includes(id) ? langs.filter((l) => l !== id) : [...langs, id]; }} />{typeName(id)}</label>{/each}</div>
            {/if}
            <div class="ca-head">{word(R + "PrimaryTimeZone", "Primary Timezone")}</div>
            <div class="ca-range">
              <select aria-label="From" bind:value={from}>{#each Array.from({ length: 24 }, (_, i) => i) as h (h)}<option value={h}>{hh(h)}</option>{/each}</select>
              <span>–</span>
              <select aria-label="To" bind:value={to}>{#each Array.from({ length: 24 }, (_, i) => i + 1) as h (h)}<option value={h}>{hh(h)}</option>{/each}</select>
            </div>
            {#if maxDays > 0}
              <div class="ca-head">{editingAd ? word(R + "ExtendRecruitmentAdDuration", "Extend Recruitment Ad Duration") : word(R + "RecruitmentAdDuration", "Recruitment Ad Duration")}</div>
              <input type="range" min={editingAd ? 0 : 1} max={maxDays} bind:value={days} aria-label="Days" />
              <div class="ca-hint">{days} {days === 1 ? "day" : "days"} · {isk(price)}</div>
            {/if}
            <div class="ca-head">{word(R + "MinimumSPrequirement", "Minimum SP requirement")}</div>
            <input type="number" min="0" max="600000000" step="1" bind:value={minSP} />
          </div>
        {:else}
          <div class="ca-recruiters">
            <input bind:value={filter} maxlength="10" placeholder={word(R + "FilterRecruiterCandidates", "Filter recruiter candidates")} />
            <div class="ca-members" role="listbox">
              {#each candidates as id (id)}
                <div role="option" tabindex="0" aria-selected={picked === id} class:picked={picked === id} onclick={() => (picked = id)} ondblclick={() => addRecruiter(id)} onkeydown={(e) => { if (e.key === "Enter") addRecruiter(id); }}>{memberName(id)}</div>
              {/each}
            </div>
            <button type="button" onclick={() => addRecruiter(picked)}>{word(R + "AddRecruiterToAd", "Add Recruiter to Ad")}</button>
            {#each Array.from({ length: 6 }, (_, i) => i) as i (i)}
              {@const id = recruiters[i]}
              <div class="ca-slot">{#if id !== undefined}<span>{memberName(id)}</span><button type="button" class="ca-remove" title={word(R + "AdRemove", "Remove")} onclick={() => (recruiters = recruiters.filter((r) => r !== id))}>×</button>{:else}<span class="ca-none">{word(R + "NoRecruiterAssigned", "No recruiter assigned")}</span>{/if}</div>
            {/each}
          </div>
        {/if}
        <div class="ca-form-buttons">
          <button type="button" disabled={sending} onclick={submit}>{word("UI/Common/Buttons/Submit", "Submit")}</button>
          <button type="button" onclick={() => (editing = false)}>{word("UI/Common/Buttons/Cancel", "Cancel")}</button>
        </div>
      </div>
    </section>
  {/if}
</div>

<style>
  .corp-adverts { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 420px; }
  .ca-scroll { flex: 1; overflow: auto; padding: 4px; }
  .ca-note { opacity: 0.7; }
  .ca-buttons { display: flex; gap: 4px; justify-content: center; padding: 4px; }
  .ca-apps { display: flex; gap: 6px; justify-content: center; padding: 8px 0; }
  .ca-form { position: absolute; inset: 0; z-index: 4; display: flex; gap: 4px; padding: 4px; background: #15181b; border: 1px solid rgba(255, 255, 255, 0.15); }
  .ca-main { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .ca-caption { font-weight: bold; }
  .ca-label { display: flex; flex-direction: column; gap: 2px; font-weight: bold; }
  .ca-label input, .ca-label textarea { font-weight: normal; }
  .ca-msg { flex: 1; }
  .ca-msg textarea { flex: 1; min-height: 200px; resize: none; }
  .ca-side { width: 230px; flex: none; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
  .ca-tabs { display: flex; gap: 2px; padding-top: 8px; }
  .ca-tabs button[aria-selected="true"] { font-weight: bold; }
  .ca-details, .ca-recruiters { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 3px; padding: 0 12px 0 4px; }
  .ca-head { font-weight: bold; padding-top: 12px; }
  .ca-menu { text-align: left; background: rgba(0, 0, 0, 0.35); border: 0; color: inherit; padding: 3px 6px; cursor: pointer; }
  .ca-list { display: flex; flex-direction: column; padding: 4px; background: rgba(20, 22, 25, 0.95); border: 1px solid rgba(255, 255, 255, 0.12); }
  .ca-check { display: flex; gap: 6px; align-items: center; }
  .ca-range { display: flex; gap: 6px; align-items: center; }
  .ca-hint { font-size: 11px; opacity: 0.7; padding-left: 8px; }
  .ca-members { flex: 1; min-height: 120px; overflow: auto; border: 1px solid rgba(255, 255, 255, 0.1); }
  .ca-members div { padding: 2px 4px; cursor: default; }
  .ca-members div.picked { background: rgba(255, 255, 255, 0.12); }
  .ca-slot { height: 32px; display: flex; align-items: center; justify-content: space-between; padding: 0 4px; margin-top: 2px; background: rgba(0, 0, 0, 0.25); }
  .ca-none { opacity: 0.5; }
  .ca-remove { background: none; border: 0; color: #e06666; cursor: pointer; }
  .ca-form-buttons { display: flex; gap: 4px; justify-content: center; padding: 4px 0; }
  .error { color: #e06666; }
</style>
