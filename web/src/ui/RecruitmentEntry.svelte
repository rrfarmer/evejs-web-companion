<script lang="ts">
  // recruitment/recruitmentEntry.py RecruitmentEntry: the header (54 high) - the expander, the corporation's logo 48
  // at 14, the alliance's beside it (none: the default alliance picture at 0.2, OwnerNotInAnyAlliance), "<b>corp</b>
  // <br>title" (EveLabelLarge, 114 in) - and at the right, in the corporation's own view the expiry (AdExpiresIn, red
  // under a day; AdExpired) with Edit / Remove on hover for a personnel manager, else the match grade (where the
  // server graded) and Apply on hover for another corporation. Clicking the header expands it (one at a time, kept as
  // corporation_recruitmentad_expanded): the description, then two columns - the member count (searching), the play
  // styles and other options, Minimum SP, Friendly Fire; the areas, the languages (sorted), the time zone - each
  // option dim where the search did not ask for it; then the recruiters (GetRecruiters) in up to three columns.
  // (Not here: the war icon - the corporation's wars are not read -, the drag data, Open Ad in New Window; Apply and
  // Edit are shown, not acting.)
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { RecruitmentData } from "../app/api.ts";
  import { DATE_LABELS, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { resolvedName } from "../store/names.ts";
  import { friendlyFireAt, friendlyFireLabel } from "../bridge/ownerInfo.ts";
  import { allianceLogoUrl } from "./ownerImages.ts";
  import { clientTexture } from "./skillGroupIcons.ts";
  import { showInfo } from "./showInfo.ts";
  import CorpLogo from "./CorpLogo.svelte";
  import OwnerPicture from "./OwnerPicture.svelte";
  import {
    timeZoneFromMask, typesInMask, PLAYSTYLE_GROUPS, AREA_OF_OPERATIONS_GROUPID, LANGUAGE_GROUPID, PLAYSTYLE_GROUPID,
    NEWPILOTFRIENDLY_TYPEID, NEWPILOTFOCUSED_TYPEID, ROLEPLAY_TYPEID, type RecruitmentAd,
  } from "../bridge/corpRecruitment.ts";
  /** What the search asked for (GetRecruitmenEntryData's searchMask, otherMask, searchLangMask; the playtime hours). */
  export interface EntrySearch { readonly typeMask: number; readonly otherMask: number; readonly langMask: number; readonly from: number; readonly to: number }
  let { store, flow, ad, data, corpView, search = null, expanded, access = false, onToggle, onDeleted }: {
    store: ClientStore; flow: AppFlow; ad: RecruitmentAd; data: RecruitmentData | null; corpView: boolean; search?: EntrySearch | null;
    expanded: boolean; access?: boolean; onToggle: () => void; onDeleted?: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const words = store.words;
  // svelte-ignore state_referenced_locally
  const names = store.names;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const corpLogos = flow.corpLogos;
  // svelte-ignore state_referenced_locally
  const corpLogoLibrary = flow.corpLogoLibrary;
  // svelte-ignore state_referenced_locally
  const ownerLogos = flow.ownerLogos;
  // svelte-ignore state_referenced_locally
  const imageServer = flow.imageServer;
  const R = "UI/Corporations/CorporationWindow/Recruitment/";
  const ENTRY_WORDS = ["Apply", "AdEdit", "AdRemove", "MatchHint", "AdExpiresIn", "AdExpired", "CorporationMemberCount", "MinimumSPrequirement",
    "TimeZoneToAndFrom2", "TimeZone1", "AdRecruiters"].map((k) => R + k).concat(["UI/Corporations/CorpUIHome/FriendlyFire", "UI/PeopleAndPlaces/OwnerNotInAnyAlliance",
    "UI/Common/Formatting/Percentage", "UI/Corporations/FriendlyFire/Legal", "UI/Corporations/FriendlyFire/Illegal", "UI/Corporations/FriendlyFire/LegalWithChangeTime",
    "UI/Corporations/FriendlyFire/LegalWithChangeTimeTomorrow", "UI/Corporations/FriendlyFire/IllegalWithChangeTime", "UI/Corporations/FriendlyFire/IllegalWithChangeTimeTomorrow",
    DATE_LABELS.ns!, DATE_LABELS.xn!]);
  const fill = (label: string, fallback: string, values: Record<string, unknown> = {}) =>
    plainText(formatTemplate($words.templates[label] ?? fallback, values as never, { nameOf: (kind, id) => resolvedName($names.resolved, kind, id, "") }));
  const corpName = $derived(resolvedName($names.resolved, "owner", ad.corporationID, ""));
  const isNpc = (id: number) => id >= 1_000_000 && id < 2_000_000;
  const playerLogo = $derived(isNpc(ad.corporationID) ? null : ($corpLogos[String(ad.corporationID)] ?? null));
  const npcLogo = $derived($ownerLogos?.corporations[String(ad.corporationID)] ?? null);
  const typeName = (id: number) => { const n = data?.types[String(id)]?.nameID; return n ? plainText($words.templates[`#${n}`] ?? String(id)) : String(id); };
  const groupName = (id: number) => { const n = data?.groups[String(id)]?.nameID; return n ? plainText($words.templates[`#${n}`] ?? String(id)) : String(id); };
  const typesOf = (groupID: number): number[] => data ? Object.entries(data.types).filter(([, t]) => t.groupID === groupID).map(([id]) => Number(id)) : [];
  // ColorIfSearchMatch: MATCHED (0xbf white) where the search asked for it or nothing was searched, else UNMATCHED (0x2f)
  const showMatch = $derived(search !== null);
  const matched = (id: number, mask: number | undefined) => !showMatch || (mask !== undefined && Math.floor(mask / 2 ** id) % 2 === 1);
  const has = (id: number, mask: number) => Math.floor(mask / 2 ** id) % 2 === 1;

  // the right-hand side
  const expiresIn = $derived(ad.expiryDateTimeMs === null ? null : ad.expiryDateTimeMs - Date.now());
  const ticks = (ms: number) => ({ type: "long", value: String(BigInt(Math.max(0, Math.round(ms))) * 10000n) });

  // the expanded parts
  let recruiters = $state<readonly number[] | null>(null);
  let friendlyFire = $state("");
  $effect(() => {
    if (!expanded) return;
    flow.requestCorpLogos([ad.corporationID]);
    if (recruiters === null) void flow.recruitmentAdRecruiters(ad.adID).then((r) => { recruiters = r; }).catch(() => { recruiters = []; });
    if (!friendlyFire) void flow.corporationAggressionAt(ad.corporationID).then(({ settings, readAt }) => {
      if (!settings) return;
      const { legal, changeAt } = friendlyFireAt(settings, readAt);
      const date = (t: bigint, f: "ns" | "xn") => fill(DATE_LABELS[f]!, "", { datetime: { type: "long", value: t.toString() } });
      const tomorrow = changeAt !== null && date(changeAt, "xn") !== date(readAt, "xn");
      friendlyFire = fill(friendlyFireLabel(legal, changeAt, tomorrow), legal ? "Allowed" : "Not allowed", changeAt === null ? {} : { time: date(changeAt, "ns") });
    }).catch(() => {});
  });
  $effect(() => { flow.requestWords(ENTRY_WORDS); flow.requestCorpLogos([ad.corporationID]); flow.loadOwnerLogos(); flow.loadImageServer(); });
  const playStyles = $derived(PLAYSTYLE_GROUPS.flatMap((g) => g.typeIDs.filter((id) => has(id, ad.typeMask))));
  const others = $derived([NEWPILOTFRIENDLY_TYPEID, NEWPILOTFOCUSED_TYPEID, ROLEPLAY_TYPEID].filter((id) => has(id, ad.otherMask)));
  const areas = $derived(typesOf(AREA_OF_OPERATIONS_GROUPID).filter((id) => has(id, ad.typeMask)));
  const langs = $derived(typesOf(LANGUAGE_GROUPID).filter((id) => has(id, ad.langMask)).sort((a, b) => typeName(a).toLowerCase().localeCompare(typeName(b).toLowerCase())));
  const zone = $derived(timeZoneFromMask(ad.hourMask1));
  // GetRightColumnText's time-zone colour: matched where the search's hours hold the ad's, or overlap its start / end
  const zoneMatched = $derived.by(() => {
    if (!search) return true;
    const [f1, t1] = zone, { from, to } = search;
    if ((from <= f1 && to >= t1) || (f1 < from && from < t1)) return true;
    return f1 < to && to < t1;
  });
  let hover = $state(false), deleting = $state(false);
  async function remove(): Promise<void> {
    if (deleting) return;
    deleting = true;
    try { if (await flow.deleteRecruitmentAd(ad.adID)) onDeleted?.(); } finally { deleting = false; }
  }
</script>

<div class="rec-entry" class:expanded role="listitem" onmouseenter={() => (hover = true)} onmouseleave={() => (hover = false)}>
  <div class="rec-head" role="button" tabindex="0" onclick={onToggle} onkeydown={(e) => { if (e.key === "Enter") onToggle(); }}>
    <span class="rec-expander" class:open={expanded}>▸</span>
    <span class="rec-logo">
      {#if playerLogo && $corpLogoLibrary && playerLogo.shapes.some((s) => s !== null)}<CorpLogo library={$corpLogoLibrary} logo={playerLogo} name={corpName} />
      {:else}<OwnerPicture name={corpName} urls={npcLogo ? [clientTexture(npcLogo)] : []} size={48} />{/if}
    </span>
    <span class="rec-logo rec-alliance" class:none={ad.allianceID === null}
      title={ad.allianceID === null ? fill("UI/PeopleAndPlaces/OwnerNotInAnyAlliance", "{corpName} is not in an alliance", { corpName }) : resolvedName($names.resolved, "owner", ad.allianceID, "")}>
      {#if ad.allianceID !== null}{@const url = allianceLogoUrl($imageServer, ad.allianceID)}<OwnerPicture name="" urls={url ? [url] : []} size={48} />
      {:else}<img src={clientTexture("res:/UI/Texture/defaultAlliance.dds")} alt="" width="48" height="48" />{/if}
    </span>
    <span class="rec-name"><b>{corpName}</b><br />{ad.title}</span>
    <span class="rec-right">
      {#if corpView}
        <span class="rec-expiry" class:soon={expiresIn !== null && expiresIn < 86_400_000}>{expiresIn !== null && expiresIn > 0 ? fill(R + "AdExpiresIn", "Expires in {adDuration}", { adDuration: ticks(expiresIn) }) : fill(R + "AdExpired", "Expired")}</span>
        {#if hover && access}
          <span class="rec-buttons">
            <button type="button" disabled title="Not on the play page yet" onclick={(e) => e.stopPropagation()}>{fill(R + "AdEdit", "Edit")}</button>
            <button type="button" disabled={deleting} onclick={(e) => { e.stopPropagation(); void remove(); }}>{fill(R + "AdRemove", "Remove")}</button>
          </span>
        {/if}
      {:else}
        {#if ad.grade !== null}<span class="rec-grade" title={fill(R + "MatchHint", "Match")}>{fill("UI/Common/Formatting/Percentage", "{percentage}%", { percentage: ad.grade })}</span>{/if}
        {#if hover && ad.corporationID !== $station.online?.corporationID}
          <span class="rec-buttons"><button type="button" disabled title="Not on the play page yet" onclick={(e) => e.stopPropagation()}>{fill(R + "Apply", "Apply")}</button></span>
        {/if}
      {/if}
    </span>
  </div>
  {#if expanded}
    <div class="rec-body">
      <div class="rec-columns">
        <div class="rec-col">
          {#if showMatch}<p class="m">{fill(R + "CorporationMemberCount", "Members: {memberCount}", { memberCount: ad.memberCount })}</p>{/if}
          {#if playStyles.length || others.length}
            <p><b class="w">{groupName(PLAYSTYLE_GROUPID)}</b><br />
              {#each [...playStyles.map((id) => ({ id, mask: search?.typeMask })), ...others.map((id) => ({ id, mask: search?.otherMask }))] as o, i (o.id)}{#if i}{", "}{/if}<span class={matched(o.id, o.mask) ? "m" : "u"}>{typeName(o.id)}</span>{/each}</p>
          {/if}
          <p><b class="w">{fill(R + "MinimumSPrequirement", "Minimum SP requirement")}</b><br /><span class="m">{ad.minSP.toLocaleString("en-US")}</span></p>
          <p><b class="w">{fill("UI/Corporations/CorpUIHome/FriendlyFire", "Friendly Fire")}</b><br /><span class="m">{friendlyFire}</span></p>
        </div>
        <div class="rec-col">
          {#if areas.length}<p><b class="w">{groupName(AREA_OF_OPERATIONS_GROUPID)}</b><br />{#each areas as id, i (id)}{#if i}{", "}{/if}<span class={matched(id, search?.typeMask) ? "m" : "u"}>{typeName(id)}</span>{/each}</p>{/if}
          {#if langs.length}<p><b class="w">{groupName(LANGUAGE_GROUPID)}</b><br />{#each langs as id, i (id)}{#if i}{", "}{/if}<span class={matched(id, search?.langMask) ? "m" : "u"}>{typeName(id)}</span>{/each}</p>{/if}
          <p class={zoneMatched ? "m" : "u"}>{fill(R + "TimeZoneToAndFrom2", "{timeZoneText}: {startTime} - {endTime}", { startTime: ticks(zone[0] * 3_600_000), endTime: ticks(zone[1] * 3_600_000), timeZoneText: fill(R + "TimeZone1", "Time zone") })}</p>
        </div>
      </div>
      <div class="rec-desc">{ad.description.trim()}</div>
      {#if recruiters && recruiters.length}
        <div class="rec-recruiters">
          <b>{fill(R + "AdRecruiters", "Recruiters")}</b>
          <div class="rec-grid" style="grid-template-columns: repeat({Math.min(3, recruiters.length)}, 1fr)">
            {#each recruiters as id (id)}
              <button type="button" class="rec-recruiter" onclick={() => showInfo({ kind: "character", characterID: id })}>{resolvedName($names.resolved, "owner", id, String(id))}</button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .rec-entry { border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .rec-head { position: relative; min-height: 54px; display: flex; align-items: center; cursor: pointer; }
  .rec-head:hover { background: rgba(255, 255, 255, 0.05); }
  .rec-expander { width: 14px; font-size: 11px; transition: transform 0.15s; }
  .rec-expander.open { transform: rotate(90deg); }
  .rec-logo { width: 48px; height: 48px; flex: none; display: grid; }
  .rec-logo :global(.corp-logo) { width: 48px; height: 48px; }
  .rec-alliance.none { opacity: 0.2; }
  .rec-name { flex: 1; min-width: 0; padding-left: 18px; font-size: 15px; line-height: 1.25; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .rec-right { align-self: stretch; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; padding: 4px; }
  .rec-grade { font-size: 16px; padding: 2px 6px 0 0; }
  .rec-expiry.soon { color: #ff4040; }
  .rec-buttons { display: flex; gap: 4px; }
  .rec-buttons button { font-size: 11px; padding: 1px 8px; }
  .rec-body { background: rgba(0, 0, 0, 0.2); padding: 4px 4px 8px 18px; }
  .rec-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .rec-col p { margin: 0 0 12px; }
  .rec-desc { white-space: pre-wrap; padding: 4px 8px 16px 0; border-top: 1px solid rgba(0, 0, 0, 0.15); }
  .m { color: rgba(255, 255, 255, 0.75); }
  .u { color: rgba(255, 255, 255, 0.18); }
  .w { color: #fff; }
  .rec-recruiters { padding: 4px 4px 4px 0; }
  .rec-grid { display: grid; gap: 4px; margin-top: 4px; }
  .rec-recruiter { text-align: left; background: none; border: 0; color: rgb(224, 224, 224); padding: 6px 4px; cursor: pointer; }
</style>
