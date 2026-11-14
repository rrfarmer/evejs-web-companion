<script lang="ts" module>
  import type { FleetAdvertAdvanced } from "../bridge/fleetWrites.ts";
  /** GetLimitedAdvancedOptionsData: the advanced options without the four sets of entities. */
  type LimitedAdvanced = Omit<FleetAdvertAdvanced, "public_allowedEntities" | "public_disallowedEntities" | "membergroups_allowedEntities" | "membergroups_disallowedEntities">;
  // settings.char.ui fleetAdvert_lastAdvert (_FinializeRegistration: the advert registered, GetData(fullAdvancedOptions
  // =False)) and fleetAdvert_lastAdvertAdvancedOptions (SaveAdvanced), kept while the page lives.
  let lastAdvert: { fleetName: string; description: string; activityValue: number | null; newPlayerFriendly: boolean; inviteScope: number; useAdvanceOptions: boolean; advanced: LimitedAdvanced } | null = null;
  let lastAdvancedOptions: LimitedAdvanced | null = null;
</script>

<script lang="ts">
  // agencyNew/ui/contentPages/contentPageFleetUpRegister (FleetRegister, 22 above) and fleetupUI/fleetRegister:
  // BasicOptionsCont (32 above): on the left (0.46 wide) the fleet's name (18 high letters, 40 high, FleetNameHint,
  // 32 letters with their count, 40 below it), DescriptionForOwnAd and the description (280 high, 250 letters,
  // DescriptionForOwnAdHint); on the right (100 in) the activity (SelectFleetActivity; GetAllFleetActivities sorted
  // by name), 25 below it Hide Fleet, New Player Friendly and Use Advanced Options with their hints, PrivateWarning
  // (40 high, 20 above) where the fleet is hidden, else the advanced options' summary (GetAdvancedText, 10 above, 10
  // in; UsingDefaultsSummary where it would be empty); the buttons at the bottom right: Register Fleet (primary, 40
  // high; UpdateRegistration where the fleet is registered), Advanced, Cancel.
  // LoadData: a pilot in a fleet who is not its boss is shown nothing; else the fleet's advert where it is
  // registered, or the one last registered (fleetAdvert_lastAdvert), or a new one (FleetAdvertCreationObject:
  // INVITE_CLOSED); where it does not use its advanced options, the ones last saved put on it.
  // RegisterFleet: hidden, no advert; else the name required (CustomInfo FleetNameRequired); with the advanced options
  // the advert's scope and options, the contacts at or above each minimum standing let in and (a minimum at or below
  // nought) those below kept out (PopulateAllowedAndBannedEntities over GetContactsAboveAndBelowRelationship: a
  // minimum of None lets every contact in, as Python 2 holds anything above None); without, INVITE_PUBLIC_OPEN and
  // the defaults; CreateAndRegisterFleet; then Fleet Up.
  // AdvancedOptionsCont: on the left (0.5) OpenFleetTo, My Corporation, My Alliance (where the pilot has one), My
  // Militia (where the pilot is in one), the member groups' minimum standing and security (a checkbox 30 in, its
  // slider 60 in, -10 to 10 by tenths, the checkbox "name: value" once dragged), a line (15 either side), Publicly
  // Accessible and its two minimums; on the right (85 in) AdvertJoinLimit (its hint AdvertJoinLimitHint) and its
  // number (1 to 256, 250 first, 30 in), a line, Require Approval, Hide Info, Don't Update On Boss Change; Save and
  // Cancel at the bottom right. UpdateUiElements: a minimum's checkbox only where its scope is ticked, its slider only
  // where that checkbox is too. SaveAdvanced: the scope and options afresh from the boxes (the member groups let in
  // GetAllowedGroupIDs where they have no minimum standing), kept as fleetAdvert_lastAdvertAdvancedOptions, then the
  // basic options with Use Advanced Options ticked.
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { DEFAULT_ADVERT_ADVANCED } from "../bridge/fleetWrites.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";

  let { store, flow, onShow }: { store: ClientStore; flow: AppFlow; onShow?: (groupID: number) => void } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  const U = "UI/Agency/Fleetup/", R = "UI/Fleet/FleetRegistry/";
  const nameOf = (kind: "owner" | "type" | "location", id: number) => resolvedName($names.resolved, kind as never, id, "");
  const markup = (label: string, args: Record<string, unknown> = {}) => formatTemplate($words.templates[label] ?? "", args as never, { nameOf: nameOf as never });
  const word = (label: string, args: Record<string, unknown> = {}) => plainText(markup(label, args));
  const ACTIVITIES: Readonly<Record<number, string>> = {
    1: "UI/Agency/ContentGroups/ContentGroupIncursions", 2: "UI/Agency/ContentGroups/ContentGroupFactionalWarfare", 3: "UI/Agency/ContentTypePirateStronghold",
    4: "UI/Agency/ContentGroups/ContentGroupAbyssalDeadspace", 5: "UI/Agency/ContentGroups/ContentGroupCombatAnomalies", 6: "UI/Agency/ContentGroups/ContentGroupEscalations",
    7: "UI/Agency/ContentGroups/ContentGroupResourceHarvesting", 8: "UI/Agency/ContentGroups/ContentGroupExploration", 9: `${U}FreeRoamOption`,
    10: "UI/Corporations/CorporationWindow/Recruitment/PVP", 11: `${U}MiscOption`, 12: `${U}MissionsEpicArcsOption`, 13: "UI/Agency/ContentGroups/ContentGroupESS",
    14: "UI/Inflight/Scanner/HomefrontOperationSite",
  };
  const INVITE_CORP = 1, INVITE_ALLIANCE = 2, INVITE_MILITIA = 4, INVITE_PUBLIC = 8, INVITE_PUBLIC_OPEN = 16;
  const DEFAULT_JOIN_LIMIT = 250, MAX_MEMBERS_IN_FLEET = 256;
  const options = $derived(Object.keys(ACTIVITIES).map((k) => [Number(k), word(ACTIVITIES[Number(k)]!)] as const).sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase())));
  const online = $derived($station.online);
  const corpID = $derived(online?.corporationID ?? null), allianceID = $derived(online?.allianceID ?? null);
  // (The page's session data has no warfactionid: My Militia is never shown, as for a pilot in no militia.)
  const warFactionID: number | null = null;

  /** The registration controller's currentAd: its scope, whether it uses its advanced options, and those options. */
  interface CurrentAd { inviteScope: number; useAdvanceOptions: boolean; newPlayerFriendly: boolean; advanced: FleetAdvertAdvanced }
  let current = $state<CurrentAd>({ inviteScope: 0, useAdvanceOptions: false, newPlayerFriendly: false, advanced: { ...DEFAULT_ADVERT_ADVANCED } });
  let loaded = $state<Awaited<ReturnType<AppFlow["agencyFleetRegistration"]>> | null>(null);
  let fleetName = $state(""), description = $state(""), activity = $state<number | null>(null), newPlayerFriendly = $state(false), hidden = $state(false), useAdvanced = $state(false), busy = $state(false);
  let view = $state<"basic" | "advanced">("basic");
  $effect(() => {
    void flow.agencyFleetRegistration().then((r) => {
      loaded = r;
      if (r.inFleet && !r.isBoss) return;
      let ad: CurrentAd & { fleetName: string; description: string; activityValue: number | null } = { inviteScope: 0, useAdvanceOptions: false, newPlayerFriendly: false,
        advanced: { ...DEFAULT_ADVERT_ADVANCED }, fleetName: "", description: "", activityValue: null };
      if (r.advert) {
        const a = r.advert;
        ad = { fleetName: a.fleetName, description: a.description, activityValue: a.activityValue, newPlayerFriendly: a.newPlayerFriendly, inviteScope: a.inviteScope, useAdvanceOptions: a.useAdvanceOptions,
          advanced: { public_minStanding: a.public_minStanding, public_minSecurity: a.public_minSecurity, public_allowedEntities: a.public_allowedEntities, public_disallowedEntities: a.public_disallowedEntities,
            membergroups_minStanding: a.membergroups_minStanding, membergroups_minSecurity: a.membergroups_minSecurity, membergroups_allowedEntities: a.membergroups_allowedEntities,
            membergroups_disallowedEntities: a.membergroups_disallowedEntities, joinNeedsApproval: a.joinNeedsApproval, hideInfo: a.hideInfo, updateOnBossChange: a.updateOnBossChange, advertJoinLimit: a.advertJoinLimit } };
      } else if (lastAdvert) {
        ad = { ...lastAdvert, advanced: { ...DEFAULT_ADVERT_ADVANCED, ...lastAdvert.advanced } };
      }
      if (!ad.useAdvanceOptions && lastAdvancedOptions) ad = { ...ad, advanced: { ...ad.advanced, ...lastAdvancedOptions } };
      current = { inviteScope: ad.inviteScope, useAdvanceOptions: ad.useAdvanceOptions, newPlayerFriendly: ad.newPlayerFriendly, advanced: ad.advanced };
      fleetName = ad.fleetName; description = ad.description; activity = ad.activityValue; useAdvanced = ad.useAdvanceOptions; newPlayerFriendly = ad.newPlayerFriendly;
    });
  });
  $effect(() => {
    flow.requestWords([...Object.values(ACTIVITIES), `${U}FleetNameHint`, `${U}DescriptionForOwnAd`, `${U}DescriptionForOwnAdHint`, `${U}SelectFleetActivity`, `${U}HideFleetCb`,
      `${U}HideFleetCbHint`, `${U}NewPlayerFriendlyCb`, `${U}NewPlayerFriendlyCbHint`, `${U}UseAdvancedOptionsCb`, `${U}UseAdvancedOptionsCbHint`, `${U}PrivateWarning`,
      `${U}AdvancedBtn`, `${U}RegisterFleetBn`, `${U}UpdateRegistration`, "UI/Commands/Cancel", `${U}FleetNameRequired`, `${U}UsingDefaultsSummary`, `${U}NoOneHasAccess`,
      `${R}AdvertDetails/CorporationAccessScope`, `${R}AdvertDetails/AllianceAccessScope`, `${R}AdvertDetails/MilitiaAccessScope`, `${R}AdvertDetails/MinimumStandingAndSecurity`,
      `${R}AdvertDetails/MinimumStanding`, `${R}AdvertDetails/MinimumSecurity`, `${U}Public Access`, `${U}ApplicationRequiresApprovalSummary`, `${U}FleetDetailsHiddenSummary`,
      `${U}NewPlayerFriendlySummary`, `${U}AdverNotUpdatedOnBossChangeSummary`, `${U}JoinsLimitedSummary`, `${U}OpenFleetTo`, `${U}MyCorporationCb`, `${U}MyCorporationCbHint`,
      `${U}MyAllianceCb`, `${U}MyAllianceCbHint`, `${U}MyMilitiaCb`, `${U}MyMilitiaCbHint`, `${U}MinimumRequiredStandings`, `${U}MinimumRequiredStandingsHint`,
      `${U}MinimumRequiredSecurityStatus`, `${U}MinimumRequiredSecurityStatusHint`, `${U}PubliclyAccessibleCb`, `${U}PubliclyAccessibleCbHint`, `${R}AdvertJoinLimit`,
      `${R}AdvertJoinLimitHint`, `${R}RequireApproval`, `${R}RequireApprovalHint`, `${R}HideInfo`, `${R}HideInfoHint`, `${U}DontUpdateOnBossChangeCb`, `${U}DontUpdateOnBossChangeCbHint`,
      "UI/Common/Buttons/Save", "FleetInviteWithInappropriateStandings"]);
  });
  $effect(() => { const ids = [corpID, allianceID].filter((x): x is number => x !== null); if (ids.length) flow.requestNames(ids.map((id) => ({ kind: "owner" as const, id }))); });
  // The Combo's first option where the advert names none (Combo.SetValue of a value it has not leaves its first).
  const shownActivity = $derived(activity !== null && ACTIVITIES[activity] ? activity : options[0]?.[0] ?? null);

  /** GetScopeText: the advert's scope, a line each. */
  function scopeText(): string {
    const ad = current, a = ad.advanced, lines: string[] = [];
    if (ad.inviteScope === 0) return markup(`${U}NoOneHasAccess`);
    const strip = (text: string) => text.replace(/<br\s*\/?>/gi, "");
    const owner = (id: number) => ({ type: "long", value: String(id) });
    if (ad.inviteScope & INVITE_CORP && corpID !== null) lines.push(strip(markup(`${R}AdvertDetails/CorporationAccessScope`, { corpName: nameOf("owner", corpID), corpInfo: owner(corpID) })));
    if (ad.inviteScope & INVITE_ALLIANCE && allianceID !== null) lines.push(strip(markup(`${R}AdvertDetails/AllianceAccessScope`, { allianceName: nameOf("owner", allianceID), allianceInfo: owner(allianceID) })));
    const minimums = (standing: number | null, security: number | null) => {
      if (standing !== null) lines.push(security !== null ? markup(`${R}AdvertDetails/MinimumStandingAndSecurity`, { standing, security }) : markup(`${R}AdvertDetails/MinimumStanding`, { standing }));
      else if (security !== null) lines.push(markup(`${R}AdvertDetails/MinimumSecurity`, { security }));
    };
    minimums(a.membergroups_minStanding, a.membergroups_minSecurity);
    if (ad.inviteScope & (INVITE_PUBLIC | INVITE_PUBLIC_OPEN)) {
      if (lines.length) lines.push("");
      lines.push(markup(`${U}Public Access`));
      minimums(a.public_minStanding, a.public_minSecurity);
    }
    if (!lines.length) lines.push("-");
    return lines.join("<br>");
  }
  /** GetOtherOptionText. */
  function otherText(): string {
    const a = current.advanced, out: string[] = [];
    if (a.joinNeedsApproval) out.push(markup(`${U}ApplicationRequiresApprovalSummary`));
    if (a.hideInfo) out.push(markup(`${U}FleetDetailsHiddenSummary`));
    if (current.newPlayerFriendly) out.push(markup(`${U}NewPlayerFriendlySummary`));
    if (!a.updateOnBossChange) out.push(markup(`${U}AdverNotUpdatedOnBossChangeSummary`));
    if (a.advertJoinLimit) out.push(markup(`${U}JoinsLimitedSummary`, { maxThroughJoin: a.advertJoinLimit }));
    return out.join(", ");
  }
  const summary = $derived.by(() => {
    void $words; void $names;
    if (!useAdvanced) return "";
    const text = [scopeText(), otherText()].join("<br><br>");
    return plainText(text) || word(`${U}UsingDefaultsSummary`);
  });

  async function register(): Promise<void> {
    let advert = null, advanced = null;
    if (!hidden) {
      const name = fleetName.trim();
      if (name.length < 1) {
        // raise UserError('CustomInfo', {'info': FleetNameRequired})
        const text = word(`${U}FleetNameRequired`);
        flow.sayDialog("CustomInfo", { type: "dict", entries: [["info", text]] }, text);
        return;
      }
      advert = { fleetName: name, description: description.trim(), activityValue: shownActivity, newPlayerFriendly };
      if (useAdvanced) {
        // PopulateAllowedAndBannedEntities: the pilot's, its corporation's and its alliance's contacts.
        const standings = await flow.contactStandings().catch(() => null);
        const split = (minimum: number | null) => {
          const at: number[] = [], below: number[] = [];
          for (const list of standings ? [standings.personal, standings.corporate, standings.alliance] : []) for (const [id, value] of list) (minimum === null || value >= minimum ? at : below).push(id);
          const atSet = new Set(at);
          return { at: [...atSet], below: [...new Set(below)].filter((id) => !atSet.has(id)) };
        };
        const a = current.advanced, groups = split(a.membergroups_minStanding), pub = split(a.public_minStanding);
        advanced = { inviteScope: current.inviteScope, advanced: { ...a,
          membergroups_allowedEntities: groups.at, membergroups_disallowedEntities: a.membergroups_minStanding === null || a.membergroups_minStanding <= 0 ? groups.below : [],
          public_allowedEntities: pub.at, public_disallowedEntities: a.public_minStanding === null || a.public_minStanding <= 0 ? pub.below : [] } };
      }
    }
    busy = true;
    try {
      if (await flow.agencyRegisterFleet(advert, advanced)) {
        if (advert) {
          const a = advanced?.advanced ?? DEFAULT_ADVERT_ADVANCED;
          lastAdvert = { ...advert, fleetName: advert.fleetName.slice(0, 32), description: advert.description.slice(0, 250), inviteScope: advanced?.inviteScope ?? INVITE_PUBLIC_OPEN,
            useAdvanceOptions: advanced !== null, advanced: limited(a) };
        }
        onShow?.(67);
      }
    } finally { busy = false; }
  }
  function limited(a: FleetAdvertAdvanced): LimitedAdvanced {
    const { public_allowedEntities: _1, public_disallowedEntities: _2, membergroups_allowedEntities: _3, membergroups_disallowedEntities: _4, ...rest } = a;
    return rest;
  }

  // --- AdvancedOptionsCont ---
  interface Minimum { on: boolean; value: number; dragged: boolean }
  let corp = $state(false), alliance = $state(false), militia = $state(false), publicly = $state(false);
  let groupStanding = $state<Minimum>({ on: false, value: 0, dragged: false }), groupSecurity = $state<Minimum>({ on: false, value: 0, dragged: false });
  let publicStanding = $state<Minimum>({ on: false, value: 0, dragged: false }), publicSecurity = $state<Minimum>({ on: false, value: 0, dragged: false });
  let limitOn = $state(false), limit = $state(DEFAULT_JOIN_LIMIT), approval = $state(false), hideDetails = $state(false), noBossUpdate = $state(false);
  const groupChecked = $derived(corp || (allianceID !== null && alliance) || (warFactionID !== null && militia));
  /** ReloadCont and LoadData. */
  function openAdvanced(): void {
    const ad = current, a = ad.advanced;
    corp = Boolean(ad.inviteScope & INVITE_CORP); alliance = Boolean(ad.inviteScope & INVITE_ALLIANCE); militia = Boolean(ad.inviteScope & INVITE_MILITIA);
    const m = (v: number | null): Minimum => ({ on: v !== null, value: v ?? 0, dragged: false });
    groupStanding = m(a.membergroups_minStanding); groupSecurity = m(a.membergroups_minSecurity);
    publicly = Boolean(ad.inviteScope & (INVITE_PUBLIC | INVITE_PUBLIC_OPEN));
    publicStanding = m(a.public_minStanding); publicSecurity = m(a.public_minSecurity);
    limitOn = a.advertJoinLimit !== null; limit = a.advertJoinLimit || DEFAULT_JOIN_LIMIT;
    approval = a.joinNeedsApproval; hideDetails = a.hideInfo; noBossUpdate = !a.updateOnBossChange;
    view = "advanced";
  }
  /** SaveAdvanced. */
  function saveAdvanced(): void {
    let scope = 0;
    const a: { -readonly [K in keyof FleetAdvertAdvanced]: FleetAdvertAdvanced[K] } = { ...DEFAULT_ADVERT_ADVANCED };
    if (corp) scope += INVITE_CORP;
    if (allianceID !== null && alliance) scope += INVITE_ALLIANCE;
    if (warFactionID !== null && militia) scope += INVITE_MILITIA;
    const bad = (v: number) => v < -10 || v > 10;
    if (scope & (INVITE_CORP | INVITE_ALLIANCE | INVITE_MILITIA)) {
      if (groupStanding.on) {
        if (bad(groupStanding.value)) { flow.sayDialog("FleetInviteWithInappropriateStandings", null, "That standing is out of range."); return; }
        a.membergroups_minStanding = groupStanding.value;
      } else {
        // FleetSvc().GetAllowedGroupIDs(adInfo): the corporation, the alliance and the militia the scope opens to.
        a.membergroups_allowedEntities = [scope & INVITE_CORP ? corpID : null, scope & INVITE_ALLIANCE ? allianceID : null, scope & INVITE_MILITIA ? warFactionID : null].filter((x): x is number => x !== null);
      }
      if (groupSecurity.on) a.membergroups_minSecurity = groupSecurity.value;
    }
    if (publicly) {
      scope += INVITE_PUBLIC_OPEN;
      if (publicStanding.on) {
        if (bad(publicStanding.value)) { flow.sayDialog("FleetInviteWithInappropriateStandings", null, "That standing is out of range."); return; }
        a.public_minStanding = publicStanding.value;
      }
      if (publicSecurity.on) a.public_minSecurity = publicSecurity.value;
    }
    if (limitOn) a.advertJoinLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_MEMBERS_IN_FLEET);
    a.joinNeedsApproval = approval; a.hideInfo = hideDetails; a.updateOnBossChange = !noBossUpdate;
    current = { ...current, inviteScope: scope, advanced: a };
    lastAdvancedOptions = limited(a);
    // OnAdvancedSaved: useAdvancedCb.SetChecked(True, False), the basic options again.
    useAdvanced = true;
    view = "basic";
  }
  const sliderLabel = (text: string, m: Minimum) => (m.dragged ? `${word(text)}: ${m.value}` : word(text));
</script>

{#snippet minimum(text: string, hint: string, m: Minimum, scopeOn: boolean, set: (next: Minimum) => void)}
  <div class="afa-min">
    <input class="afa-slider" type="range" min="-10" max="10" step="0.1" disabled={!scopeOn || !m.on} value={m.value} oninput={(e) => set({ ...m, value: Math.round(Number(e.currentTarget.value) * 10) / 10, dragged: true })} />
    <label class="afr-check afa-sub" title={word(hint)}><input type="checkbox" disabled={!scopeOn} checked={m.on} onchange={(e) => set({ ...m, on: e.currentTarget.checked })} />{sliderLabel(text, m)}</label>
  </div>
{/snippet}

{#if view === "basic"}
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
    <label class="afr-check" title={word(`${U}UseAdvancedOptionsCbHint`)}><input type="checkbox" disabled={hidden} checked={useAdvanced}
      onchange={(e) => { useAdvanced = e.currentTarget.checked; current = { ...current, useAdvanceOptions: useAdvanced }; }} />{word(`${U}UseAdvancedOptionsCb`)}</label>
    {#if hidden}<p class="afr-warn">⚠ {word(`${U}PrivateWarning`)}</p>
    {:else if summary}<p class="afr-summary">{summary}</p>{/if}
  </div>
  <div class="afr-buttons">
    <button type="button" class="afr-primary" disabled={busy || loaded === null} onclick={() => void register()}>{word(loaded?.registered ? `${U}UpdateRegistration` : `${U}RegisterFleetBn`)}</button>
    <button type="button" onclick={openAdvanced}>{word(`${U}AdvancedBtn`)}</button>
    <button type="button" onclick={() => onShow?.(67)}>{word("UI/Commands/Cancel")}</button>
  </div>
</div>
{:else}
<div class="afr afa">
  <div class="afa-left">
    <p class="afa-head">{word(`${U}OpenFleetTo`)}</p>
    <label class="afr-check" title={word(`${U}MyCorporationCbHint`)}><input type="checkbox" checked={corp} onchange={(e) => (corp = e.currentTarget.checked)} />{word(`${U}MyCorporationCb`)}</label>
    {#if allianceID !== null}<label class="afr-check" title={word(`${U}MyAllianceCbHint`)}><input type="checkbox" checked={alliance} onchange={(e) => (alliance = e.currentTarget.checked)} />{word(`${U}MyAllianceCb`)}</label>{/if}
    {#if warFactionID !== null}<label class="afr-check" title={word(`${U}MyMilitiaCbHint`)}><input type="checkbox" checked={militia} onchange={(e) => (militia = e.currentTarget.checked)} />{word(`${U}MyMilitiaCb`)}</label>{/if}
    {@render minimum(`${U}MinimumRequiredStandings`, `${U}MinimumRequiredStandingsHint`, groupStanding, groupChecked, (n) => (groupStanding = n))}
    {@render minimum(`${U}MinimumRequiredSecurityStatus`, `${U}MinimumRequiredSecurityStatusHint`, groupSecurity, groupChecked, (n) => (groupSecurity = n))}
    <hr />
    <label class="afr-check" title={word(`${U}PubliclyAccessibleCbHint`)}><input type="checkbox" checked={publicly} onchange={(e) => (publicly = e.currentTarget.checked)} />{word(`${U}PubliclyAccessibleCb`)}</label>
    {@render minimum(`${U}MinimumRequiredStandings`, `${U}MinimumRequiredStandingsHint`, publicStanding, publicly, (n) => (publicStanding = n))}
    {@render minimum(`${U}MinimumRequiredSecurityStatus`, `${U}MinimumRequiredSecurityStatusHint`, publicSecurity, publicly, (n) => (publicSecurity = n))}
  </div>
  <div class="afa-right">
    <p class="afa-head">&nbsp;</p>
    <label class="afr-check" title={word(`${R}AdvertJoinLimitHint`, { advertJoinLimit: limit })}><input type="checkbox" checked={limitOn} onchange={(e) => (limitOn = e.currentTarget.checked)} />{word(`${R}AdvertJoinLimit`)}</label>
    <input class="afa-limit" type="number" min="1" max={MAX_MEMBERS_IN_FLEET} value={limit} oninput={(e) => (limit = Number(e.currentTarget.value))} />
    <hr />
    <label class="afr-check" title={word(`${R}RequireApprovalHint`)}><input type="checkbox" checked={approval} onchange={(e) => (approval = e.currentTarget.checked)} />{word(`${R}RequireApproval`)}</label>
    <label class="afr-check" title={word(`${R}HideInfoHint`)}><input type="checkbox" checked={hideDetails} onchange={(e) => (hideDetails = e.currentTarget.checked)} />{word(`${R}HideInfo`)}</label>
    <label class="afr-check" title={word(`${U}DontUpdateOnBossChangeCbHint`)}><input type="checkbox" checked={noBossUpdate} onchange={(e) => (noBossUpdate = e.currentTarget.checked)} />{word(`${U}DontUpdateOnBossChangeCb`)}</label>
  </div>
  <div class="afr-buttons">
    <button type="button" class="afr-primary afa-save" onclick={saveAdvanced}>{word("UI/Common/Buttons/Save")}</button>
    <button type="button" onclick={() => (view = "basic")}>{word("UI/Commands/Cancel")}</button>
  </div>
</div>
{/if}

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
  .afr-summary { margin: 10px 0 0 10px; white-space: pre-line; }
  .afr-buttons { position: absolute; right: 0; bottom: 0; display: flex; gap: 10px; align-items: flex-end; }
  .afr-primary { height: 40px; min-width: 120px; background: rgb(106 195 236 / 0.25); border: 1px solid rgb(106 195 236 / 0.6); }
  .afa-save { height: auto; min-width: 80px; }
  .afa-left { width: 50%; flex: none; display: flex; flex-direction: column; }
  .afa-right { flex: 1; padding: 0 10px 0 85px; display: flex; flex-direction: column; align-items: flex-start; }
  .afa-head { margin: 0 0 4px; }
  .afa-min { display: flex; flex-direction: column-reverse; margin-bottom: 7px; }
  .afa-sub { padding-left: 30px; }
  .afa-slider { margin-left: 60px; width: calc(100% - 80px); }
  .afa-limit { margin-left: 30px; width: 80px; }
  .afa hr { width: 100%; border: none; border-top: 1px solid rgb(255 255 255 / 0.05); margin: 15px 0; }
</style>
