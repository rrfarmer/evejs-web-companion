<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import { formatInterval, formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { CONTACT_STANDING } from "../bridge/contacts.ts";
  import type { FleetAdvert } from "../bridge/fleetAds.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName, type NameKind } from "../store/names.ts";
  import { showInfo, subjectOfShowInfoLink } from "./showInfo.ts";

  let { advert, store, flow }: { advert: FleetAdvert; store: ClientStore; flow: AppFlow } = $props();
  // svelte-ignore state_referenced_locally
  const { names, words } = store;
  const D = "UI/Fleet/FleetRegistry/AdvertDetails/";
  const PUBLIC = "UI/Agency/Fleetup/Public Access";
  const hasScope = (bit: number) => (advert.inviteScope & bit) !== 0;
  const publicScope = $derived(hasScope(8) ? word(D + "PublicAccessScope", "Public with standings") : hasScope(16) ? word(PUBLIC, "Public Access") : "");
  const groups = $derived([
    { bit: 1, kind: "corporation", id: advert.leader.corpID, type: 2 },
    { bit: 2, kind: "alliance", id: advert.leader.allianceID, type: 16159 },
    { bit: 4, kind: "faction", id: advert.leader.warFactionID, type: 30 },
  ] as const);
  const scopeGroups = $derived(groups.filter(group => hasScope(group.bit) && group.id !== null));
  const fleetAge = $derived.by(() => {
    const created = filetimeToUnixMs(advert.dateCreated);
    return created === null ? "—" : formatInterval(Math.max(0, Date.now() - created) * 10_000);
  });
  const groupThreshold = $derived(threshold(advert.membergroups_minStanding, advert.membergroups_minSecurity));
  const publicThreshold = $derived(threshold(advert.public_minStanding, advert.public_minSecurity));

  $effect(() => {
    const identities = [
      { kind: "character", id: advert.leader.charID }, { kind: "system", id: advert.solarSystemID }, ...scopeGroups,
    ] as const;
    flow.requestNames(identities.flatMap(({ kind, id }) => id === null ? [] : [{ kind, id }]));
    flow.requestWords([D + "PublicAccessScope", PUBLIC, "UI/Standings/Good", "UI/Standings/Excellent", "UI/Common/Unknown"]);
  });

  function word(label: string, fallback: string): string {
    const template = $words.templates[label];
    return typeof template === "string" && template ? plainText(formatTemplate(template, {}, { nameOf: () => "" })) : fallback;
  }

  function threshold(standing: number | null, security: number | null): string {
    const entries: string[] = [];
    if (standing !== null) {
      const name = standing === CONTACT_STANDING.good ? word("UI/Standings/Good", "Good")
        : standing === CONTACT_STANDING.high ? word("UI/Standings/Excellent", "Excellent") : String(standing);
      entries.push(`Minimum Standing: ${name}`);
    }
    if (security !== null) entries.push(`Minimum Security: ${security.toFixed(1)}`);
    return entries.join(" · ");
  }

  function displayName(kind: NameKind, id: number): string {
    return resolvedName($names.resolved, kind, id, word("UI/Common/Unknown", "Unknown"));
  }

  function openInfo(type: number, id: number, event: MouseEvent): void {
    const subject = subjectOfShowInfoLink(`showinfo:${type}//${id}`);
    if (subject) showInfo(subject, { shift: event.shiftKey });
  }
</script>

{#snippet identity(kind: NameKind, type: number, id: number)}
  <button class="evelink showInfo" type="button" onclick={event => openInfo(type, id, event)}>{displayName(kind, id)}</button>
{/snippet}

<dl class="fleet-advert-details">
  <dt>Fleet Boss</dt>
  <dd>{#if advert.leader.charID !== null}{@render identity("character", 1376, advert.leader.charID)}{:else}—{/if}</dd>
  {#if !advert.hideInfo && advert.solarSystemID !== null}
    <dt>Boss Location</dt><dd>{@render identity("system", 5, advert.solarSystemID)}</dd>
  {/if}
  <dt>Fleet Age</dt><dd>{fleetAge}</dd>
  {#if !advert.hideInfo && advert.numMembers > 0}
    <dt>Member Count</dt><dd>{advert.numMembers}</dd>
  {/if}
  <dt>Scope</dt>
  <dd>
    {#each scopeGroups as group (group.bit)}
      {#if group.id !== null}<div>{group.kind === "corporation" ? "Corporation" : group.kind === "alliance" ? "Alliance" : "Militia"} {@render identity(group.kind, group.type, group.id)}</div>{/if}
    {/each}
    {#if groupThreshold}<div>{groupThreshold}</div>{/if}
    {#if publicScope}<div>{publicScope}</div>{#if publicThreshold}<div>{publicThreshold}</div>{/if}{/if}
    {#if scopeGroups.length === 0 && !groupThreshold && !publicScope}—{/if}
  </dd>
</dl>
{#if advert.joinNeedsApproval}<p class="approval">Application to Fleet Requires Approval</p>{/if}
{#if advert.description}<p class="description">{advert.description}</p>{/if}

<style>
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .25rem .75rem; margin: 0; }
  dt { color: var(--color-muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .approval, .description { margin: .5rem 0 0; }
  .description { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
