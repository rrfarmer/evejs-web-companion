<script lang="ts">
  import type { AppFlow } from "../app/flow.ts";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import type { CalendarEvent, CalendarReply, EventDetails, EventResponse } from "../bridge/calendar.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import { CALENDAR_GROUPS, CALENDAR_REPLY_CHOICES, CALENDAR_RESPONSES, CALENDAR_RESPONSE_PATH, CALENDAR_TAGS,
    calendarDateTime, calendarReplyChoices, calendarResponses, calendarView, canManageCalendarEvent } from "./calendarView.ts";
  import LabelText from "./LabelText.svelte";
  import { LINK_WORDS, linkFollowerOf } from "./linkFollowers.ts";
  import { showInfo } from "./showInfo.ts";

  let { flow, store, event, close }: { flow: AppFlow; store: ClientStore; event: CalendarEvent; close: () => void } = $props();
  const tabID = $props.id();
  // svelte-ignore state_referenced_locally
  const { names, station, words } = store;
  // svelte-ignore state_referenced_locally
  const model = calendarView(flow);
  const { agenda, replying, deleting } = model;
  // svelte-ignore state_referenced_locally
  const calendarUpdated = flow.calendarUpdated;
  const LABEL = {
    start: "UI/Calendar/EventWindow/StartTime", duration: "UI/Calendar/EventWindow/Duration", type: "UI/Calendar/EventWindow/EventType",
    creator: "UI/Calendar/EventWindow/Creator", status: "UI/Calendar/EventWindow/Status", updated: "UI/Calendar/EventWindow/LastUpdated",
    durationNone: "UI/Calendar/EventWindow/DateNotSpecified", durationHours: "UI/Calendar/EventWindow/DateSpecified",
    description: "UI/Calendar/EventWindow/TabDescription", invitations: "UI/Calendar/EventWindow/TabInvitations",
    noCharacter: "UI/Calendar/EventWindow/NoCharacter", close: "UI/Generic/Close", search: "UI/Common/Search",
    edit: "UI/Calendar/EventWindow/Edit", delete: "UI/Calendar/EventWindow/Delete",
    date: "/Carbon/UI/Common/DateTime/DateLongShort",
  } as const;
  function word(key: string, fallback: string, args: Record<string, number> = {}): string {
    return plainText(formatTemplate($words.templates[key] ?? "", args, { nameOf: () => "" })) || fallback;
  }
  function dateText(filetime: bigint | null): string {
    const timestamp = filetimeToUnixMs(filetime);
    if (timestamp === null) return "—";
    return word(LABEL.date, calendarDateTime(timestamp), { datetime: Number(filetime) });
  }
  function groupName(flag: number): string {
    const group = CALENDAR_GROUPS[flag as keyof typeof CALENDAR_GROUPS];
    return group ? word(`UI/Calendar/CalendarWindow/${group.label}`, group.fallback) : "—";
  }
  const responseOf = (status: number) => CALENDAR_RESPONSES[status] ?? CALENDAR_RESPONSES[3];
  const followerOf = (url: string, text: string) => linkFollowerOf(url, flow, null, key => word(key, LINK_WORDS[key] ?? ""), text);

  $effect(() => {
    flow.requestWords([...Object.values(LABEL), ...Object.keys(LINK_WORDS), ...CALENDAR_REPLY_CHOICES.map(([, key]) => key),
      ...CALENDAR_RESPONSES.map(([key]) => CALENDAR_RESPONSE_PATH + key),
      ...Object.values(CALENDAR_GROUPS).map(group => `UI/Calendar/CalendarWindow/${group.label}`)]);
  });

  let detail = $state<EventDetails | null>(null);
  let detailStatus = $state<"loading" | "ready" | "error">("loading");
  const eventID = $derived(event.eventID);
  const ownerID = $derived(event.ownerID);
  $effect(() => {
    event.dateModified;
    let active = true;
    detail = null;
    detailStatus = "loading";
    void flow.loadCalendarEvent(eventID, ownerID).then(result => {
      if (!active) return;
      detail = result;
      detailStatus = result ? "ready" : "error";
    }, () => { if (active) detailStatus = "error"; });
    return () => { active = false; };
  });
  const creatorID = $derived(detail?.creatorID ?? null);
  const ccp = $derived(event.flag === CALENDAR_TAGS.ccp);
  const creator = $derived(ccp ? groupName(CALENDAR_TAGS.ccp) : resolvedName($names.resolved, "owner", creatorID));
  const currentEvent = $derived($agenda.status === "ready" ? $agenda.data.events.find(row => row.eventID === eventID) ?? event : event);
  const responseStatus = $derived(currentEvent.isDeleted ? 1 : calendarResponses($agenda).get(eventID) ?? 3);
  const response = $derived(responseOf(responseStatus));
  const characterID = $derived($station.online?.characterID ?? null);
  const manage = $derived(canManageCalendarEvent(currentEvent, $station.online, flow.calendarNow()));
  const replies = $derived($agenda.status === "ready" ? calendarReplyChoices(currentEvent, characterID, responseStatus, flow.calendarNow()) : []);
  let replyError = $state<string | null>(null);
  async function deleteEvent(): Promise<void> {
    replyError = null;
    try {
      await model.deleteEvent(currentEvent);
    } catch (error) {
      replyError = error instanceof Error ? error.message : "The Calendar event could not be canceled.";
    }
  }
  async function respond(status: CalendarReply): Promise<void> {
    if (!calendarReplyChoices(currentEvent, characterID, responseStatus, flow.calendarNow()).some(([choice]) => choice === status)) {
      replyError = "This event no longer accepts that reply.";
      return;
    }
    replyError = null;
    try {
      await model.reply(currentEvent, status);
    } catch (error) {
      replyError = error instanceof Error ? error.message : "The Calendar reply could not be saved.";
    }
  }
  const durationHours = $derived(currentEvent.eventDuration === null ? null : Math.trunc(currentEvent.eventDuration / 60));
  const personal = $derived(event.flag === CALENDAR_TAGS.personal);
  const canSeeInvitations = $derived(personal || ((event.flag === CALENDAR_TAGS.corp || event.flag === CALENDAR_TAGS.alliance)
    && !!$station.online?.corporationID && (BigInt($station.online?.corpRole ?? "0") & 36028797018963968n) !== 0n));
  let tab = $state<"description" | "invitations">("description");
  let search = $state("");
  let invitees = $state<readonly EventResponse[]>([]);
  let inviteStatus = $state<"loading" | "ready" | "error">("loading");
  $effect(() => {
    if (tab !== "invitations" || !canSeeInvitations) return;
    $calendarUpdated;
    let active = true;
    inviteStatus = "loading";
    void flow.loadCalendarInvitees(eventID, ownerID).then(result => {
      if (!active) return;
      invitees = result;
      inviteStatus = "ready";
    }, () => { if (active) inviteStatus = "error"; });
    return () => { active = false; };
  });
  const inviteGroups = $derived((personal ? [4, 5, 3, 2] : [4, 5, 2]).map(status => {
    const term = search.trim().toLocaleLowerCase();
    const members = invitees.filter(row => row.status === status).map(({ characterID }) =>
      ({ characterID, name: resolvedName($names.resolved, "character", characterID) }))
      .filter(member => term.length < 2 || member.name.toLocaleLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { response: responseOf(status), status, members };
  }));
</script>

<div class="calendar-event" data-calendar-window={`event-${eventID}`}>
  <h2>{#if currentEvent.importance > 0}<strong class="important">!</strong>{/if}{currentEvent.eventTitle}</h2>
  <div class="event-meta">
  <dl>
    <dt>{word(LABEL.start, "Start Time")}</dt><dd>{dateText(currentEvent.eventDateTime)}</dd>
    <dt>{word(LABEL.type, "Event Type")}</dt><dd>{groupName(event.flag)}</dd>
    <dt>{word(LABEL.duration, "Duration")}</dt><dd>{durationHours === null ? word(LABEL.durationNone, "Not specified") : word(LABEL.durationHours, `${durationHours} hours`, { hours: durationHours })}</dd>
    <dt>{word(LABEL.creator, "Creator")}</dt>
    <dd>
      {#if creatorID !== null && creatorID > 1 && !ccp}
        <button type="button" class="evelink showInfo" onclick={() => showInfo({ kind: "character", characterID: creatorID! })}>{creator}</button>
      {:else}{creator}{/if}
    </dd>
    <dt>{word(LABEL.status, "Status")}</dt><dd class="response"><img src={`/client-res/ui/texture/icons/38_16_${response[2]}.png`} width="16" height="16" alt="" />{word(CALENDAR_RESPONSE_PATH + response[0], response[1])}</dd>
    <dt>{word(LABEL.updated, "Last Updated")}</dt><dd>{dateText(currentEvent.dateModified)}</dd>
  </dl>
  {#if manage}
    <div class="manage">
      <button type="button" disabled={$deleting.has(eventID)} onclick={() => model.openEvent(currentEvent, true)}>{word(LABEL.edit, "Edit")}</button>
      <button type="button" disabled={$deleting.has(eventID)} onclick={deleteEvent}>{word(LABEL.delete, "Delete")}</button>
    </div>
  {/if}
  </div>
  <div class="calendar-event-tabs" role="tablist" aria-label={word(LABEL.type, "Event")}>
    <button type="button" role="tab" id={`${tabID}-description`} aria-controls={`${tabID}-panel`} aria-selected={tab === "description"} onclick={() => (tab = "description")}>{word(LABEL.description, "Description")}</button>
    {#if canSeeInvitations}<button type="button" role="tab" id={`${tabID}-invitations`} aria-controls={`${tabID}-panel`} aria-selected={tab === "invitations"} onclick={() => (tab = "invitations")}>{word(LABEL.invitations, "Invitations")}</button>{/if}
  </div>
  <div class="calendar-event-panel" role="tabpanel" id={`${tabID}-panel`} aria-labelledby={`${tabID}-${tab}`}>
    {#if tab === "description" || !canSeeInvitations}
      {#if detail}<LabelText markup={detail.eventText} {followerOf} />
      {:else}<p role="status">{detailStatus === "error" ? "Event details could not be read." : "Loading…"}</p>{/if}
    {:else if inviteStatus === "ready"}
      <input type="search" bind:value={search} aria-label={word(LABEL.search, "Search")} placeholder={word(LABEL.search, "Search")} />
      {#each inviteGroups as group (group.status)}
        <details>
          <summary><img src={`/client-res/ui/texture/icons/38_16_${group.response[2]}.png`} width="16" height="16" alt="" />{word(CALENDAR_RESPONSE_PATH + group.response[0], group.response[1])} ({group.members.length})</summary>
          {#if group.members.length}
            <ul>{#each group.members as member (member.characterID)}<li><button type="button" class="evelink showInfo" onclick={() => showInfo({ kind: "character", characterID: member.characterID })}>{member.name}</button></li>{/each}</ul>
          {:else}<p>{word(LABEL.noCharacter, "No characters")}</p>{/if}
        </details>
      {/each}
    {:else}
      <p role="status">{inviteStatus === "error" ? "Invitations could not be read." : "Loading…"}</p>
    {/if}
  </div>
  {#if replyError}<p role="alert">{replyError}</p>{/if}
  <footer>
    {#each replies as [status, key, fallback] (status)}
      <button type="button" disabled={$replying.has(eventID)} onclick={() => respond(status)}>{word(key, fallback)}</button>
    {/each}
    <button type="button" onclick={close}>{word(LABEL.close, "Close")}</button>
  </footer>
</div>

<style>
  .calendar-event { display: flex; flex-direction: column; gap: 6px; height: 100%; min-height: 0; padding: 6px 8px; box-sizing: border-box; font-size: 12px; }
  h2 { margin: 0 0 3px; font-size: 19px; font-weight: 400; overflow-wrap: anywhere; }
  .important { color: #e26758; margin-right: 4px; }
  .event-meta { display: flex; gap: 8px; justify-content: space-between; }
  .manage { display: flex; flex-direction: column; gap: 8px; align-self: flex-start; }
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 20px; align-items: center; margin: 0 0 4px; }
  dt { font-weight: 600; }
  dd { margin: 0; min-height: 17px; overflow-wrap: anywhere; }
  .response, summary { display: flex; align-items: center; gap: 5px; }
  summary { cursor: pointer; }
  summary::before { content: "▸"; }
  details[open] summary::before { content: "▾"; }
  .calendar-event-tabs { display: flex; gap: 2px; }
  .calendar-event-tabs button[aria-selected="true"] { border-bottom-color: var(--theme-focus, #58a7bf); }
  .calendar-event-panel { flex: 1; min-height: 0; overflow: auto; border: 1px solid #fff2; padding: 5px; }
  .calendar-event-panel p, ul { margin: 4px 0; }
  input { display: block; margin: 0 0 5px auto; }
  footer { display: flex; justify-content: center; gap: 4px; }
</style>
