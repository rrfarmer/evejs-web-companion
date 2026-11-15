<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { CharacterMatch } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { CALENDAR_DESCRIPTION_LIMIT, CALENDAR_INVITEE_LIMIT, CALENDAR_MONTH_RANGE, CALENDAR_TITLE_LIMIT,
    type CalendarEvent, type CalendarEventDraft, type CalendarEventScope } from "../bridge/calendar.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { hasChatManagerRole } from "../bridge/mail.ts";
  import { mailBodyLines, mailMarkupOfTyped } from "../bridge/mailMarkup.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import CalendarInviteePicker from "./CalendarInviteePicker.svelte";
  import { calendarDate, calendarMonthOffset } from "./calendarSelection.ts";
  import { CALENDAR_RESPONSES, CALENDAR_RESPONSE_PATH, calendarEventScope, canManageCalendarEvent } from "./calendarView.ts";

  let { flow, store, id, startsAt, existing = null, close }: {
    flow: AppFlow; store: ClientStore; id: string; startsAt: number; existing?: CalendarEvent | null; close: () => void;
  } = $props();
  // svelte-ignore state_referenced_locally
  const { station, words, names } = store;
  // svelte-ignore state_referenced_locally
  const initial = new Date(startsAt);
  const FIELD = {
    title: "UI/Calendar/SingleDayWindow/Title", year: "UI/Common/DateWords/Year",
    month: "UI/Common/DateWords/Month", day: "UI/Common/DateWords/Day", time: "UI/Common/DateWords/Time",
    duration: "UI/Calendar/EventWindow/Duration", unspecified: "UI/Calendar/EventWindow/DateNotSpecified",
    hours: "UI/Calendar/EventWindow/DateSpecified", important: "UI/Calendar/EventWindow/Important",
    type: "UI/Calendar/EventWindow/EventType",
    personal: "UI/Calendar/EventWindow/GroupPersonal", corporation: "UI/Calendar/EventWindow/GroupCorporation",
    alliance: "UI/Calendar/EventWindow/GroupAlliance", description: "UI/Calendar/EventWindow/TabDescription",
    invitations: "UI/Calendar/EventWindow/TabInvitations", add: "UI/Calendar/EventWindow/AddInvitee",
    remove: "UI/Calendar/EventWindow/RemoveInvitee", search: "UI/Common/Search",
    none: "UI/Calendar/EventWindow/NoCharacter",
    create: "UI/Calendar/EventWindow/Create", save: "UI/Calendar/EventWindow/Save", cancel: "UI/Generic/Cancel", limit: "UI/Calendar/FindInviteesWindow/TooMany",
    required: "dialog:CalendarEventMustSpecifyTitle/body", past: "dialog:CalendarCannotPlanThePast/body",
    future: "dialog:CalendarTooFarIntoFuture/body",
  } as const;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const timeLabel = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const minuteOfDay = initial.getUTCHours() * 60 + initial.getUTCMinutes();
  const timeOptions = Array.from(new Set([...Array.from({ length: 96 }, (_, quarter) => quarter * 15), minuteOfDay])).sort((a, b) => a - b);
  const durations = Array.from({ length: 24 }, (_, index) => index + 1);
  const word = (key: string, fallback: string, values: Record<string, number> = {}): string =>
    plainText(formatTemplate($words.templates[key] ?? "", values, { nameOf: () => "" })) || fallback;
  $effect(() => { flow.requestWords([...Object.values(FIELD), ...months.map(month => `UI/Common/Months/${month}`),
    ...CALENDAR_RESPONSES.map(([key]) => CALENDAR_RESPONSE_PATH + key)]); });

  const tabID = $props.id();
  // svelte-ignore state_referenced_locally
  const original = existing;
  let title = $state(original?.eventTitle ?? ""), description = $state("");
  let year = $state(initial.getUTCFullYear()), month = $state(initial.getUTCMonth()), day = $state(initial.getUTCDate());
  let minute = $state(minuteOfDay);
  let duration = $state<number | null>(original?.eventDuration ?? null);
  let important = $state((original?.importance ?? 0) > 0);
  let scope = $state<CalendarEventScope>((original && calendarEventScope(original)) ?? "personal");
  let tab = $state<"description" | "invitations">("description");
  type Invitee = CharacterMatch & { status: number };
  let invitees = $state<readonly Invitee[]>([]);
  let savedInvitees: readonly number[] = [];
  let savedTime = original?.eventDateTime ?? null;
  let savedFields: Pick<CalendarEventDraft, "startsAt" | "title" | "description" | "duration" | "important"> | null = null;
  let loadedMarkup: { text: string; markup: string } | null = $state(null);
  let loading = $state(original !== null);
  let unavailable = $state(false);
  let filter = $state("");
  let pickerOpen = $state(false);
  let addButton: HTMLButtonElement | undefined = $state();
  let error = $state("");
  let busy = $state(false);

  const mayCreateForGroup = $derived(hasChatManagerRole($station.online?.corpRole));
  const corporationID = $derived($station.online?.corporationID ?? 0);
  const allianceID = $derived($station.online?.allianceID ?? 0);
  const choices = $derived<CalendarEventScope[]>([
    "personal", ...(mayCreateForGroup && corporationID > 0 ? ["corporation" as const] : []),
    ...(mayCreateForGroup && allianceID > 0 ? ["alliance" as const] : []),
  ]);
  const ownerID = $derived(scope === "corporation" ? corporationID : scope === "alliance" ? allianceID : 0);
  $effect(() => { if (tab === "invitations" && ownerID) flow.requestNames([{ kind: "owner", id: ownerID }]); });
  const groupName = $derived(ownerID ? resolvedName($names.resolved, "owner", ownerID) : "");
  const descriptionMarkup = $derived(description === loadedMarkup?.text ? loadedMarkup.markup : mailMarkupOfTyped(description));
  const currentYear = $derived.by(() => new Date(flow.calendarNow()).getUTCFullYear());
  const dayCount = $derived(new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  const filterText = $derived(filter.trim().toLocaleLowerCase());
  const characterID = $derived($station.online?.characterID ?? null);
  const inviteeGroups = $derived((original ? [4, 5, 3, 2] : [3]).map(status => ({
    status, rows: invitees.filter(pilot => pilot.status === status).map(pilot => ({
      ...pilot, name: pilot.name || resolvedName($names.resolved, "character", pilot.characterID),
    })).filter(pilot => filterText.length < 2 || pilot.name.toLocaleLowerCase().includes(filterText))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })));

  onMount(() => {
    if (!original) return;
    let active = true;
    void Promise.all([
      flow.loadCalendarEvent(original.eventID, original.ownerID),
      scope === "personal" ? flow.loadCalendarInvitees(original.eventID, original.ownerID) : [],
    ]).then(([details, responses]) => {
      if (!active) return;
      if (!details) throw new Error("Event details could not be read.");
      loadedMarkup = { markup: details.eventText, text: mailBodyLines(details.eventText).map(line => line.map(run => run.text).join("")).join("\n") };
      description = loadedMarkup.text;
      invitees = responses.filter(row => row.status >= 2).map(row => ({ ...row, name: "" }));
      savedInvitees = invitees.filter(pilot => pilot.characterID !== characterID).map(row => row.characterID);
      loading = false;
    }).catch(cause => {
      if (!active) return;
      error = cause instanceof Error ? cause.message : "Event details could not be read.";
      unavailable = true;
      loading = false;
    });
    return () => { active = false; };
  });

  function clampDay(nextYear: number, nextMonth: number): void {
    year = nextYear;
    month = nextMonth;
    day = Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  }

  function closePicker(): void {
    pickerOpen = false;
    void tick().then(() => addButton?.focus());
  }

  function addInvitees(pilots: readonly CharacterMatch[]): void {
    const selected = new Map(invitees.map(pilot => [pilot.characterID, pilot]));
    for (const pilot of pilots) {
      if (pilot.characterID !== characterID && !selected.has(pilot.characterID)) selected.set(pilot.characterID, { ...pilot, status: 3 });
    }
    if ([...selected.keys()].filter(id => id !== characterID).length > CALENDAR_INVITEE_LIMIT) {
      error = word(FIELD.limit, `You can invite up to ${CALENDAR_INVITEE_LIMIT} characters.`, { max: CALENDAR_INVITEE_LIMIT });
      return;
    }
    error = "";
    invitees = [...selected.values()];
  }

  function validation(at: number): string {
    const now = flow.calendarNow();
    if (at <= now) return word(FIELD.past, "You cannot plan an event in the past.");
    if (calendarMonthOffset({ y: year, m: month }, calendarDate(new Date(now))) > CALENDAR_MONTH_RANGE) {
      return word(FIELD.future, `You can schedule events up to ${CALENDAR_MONTH_RANGE} months ahead.`, { numMonths: CALENDAR_MONTH_RANGE });
    }
    if (!title.trim()) return word(FIELD.required, "Enter a title for the event.");
    if (descriptionMarkup.length > CALENDAR_DESCRIPTION_LIMIT) return `Keep the description within ${CALENDAR_DESCRIPTION_LIMIT} characters.`;
    if (original && !canManageCalendarEvent({ ...original, eventDateTime: savedTime }, $station.online, now)) return "This event is no longer open for editing.";
    if (!choices.includes(scope)) return "Your current roles do not allow this event type.";
    return "";
  }

  async function save(input: SubmitEvent): Promise<void> {
    input.preventDefault();
    if (busy || loading || unavailable || pickerOpen) return;
    const at = Date.UTC(year, month, day, 0, minute);
    error = validation(at);
    if (error) return;
    busy = true;
    const draft: CalendarEventDraft = {
      scope, startsAt: at, duration, title, description: descriptionMarkup, important,
      inviteeIDs: invitees.filter(pilot => pilot.characterID !== characterID).map(pilot => pilot.characterID),
    };
    try {
      if (original && savedTime !== null) {
        if (!savedFields || draft.startsAt !== savedFields.startsAt || draft.title !== savedFields.title ||
            draft.description !== savedFields.description || draft.duration !== savedFields.duration || draft.important !== savedFields.important) {
          const nextTime = await flow.editCalendarEvent(original.eventID, savedTime, draft);
          if (nextTime === null) return;
          savedTime = nextTime;
          savedFields = draft;
        }
        if (scope === "personal") {
          const added = draft.inviteeIDs.filter(id => !savedInvitees.includes(id));
          const removed = savedInvitees.filter(id => !draft.inviteeIDs.includes(id));
          if (!await flow.updateCalendarParticipants(original.eventID, added, removed)) {
            error = "Event details were saved. Review the invitation changes to continue.";
            return;
          }
        }
        close();
      } else if (await flow.createCalendarEvent(draft) !== null) {
        close();
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "The Calendar event could not be saved.";
      error = savedFields ? `Event details were saved. ${detail}` : detail;
    } finally {
      busy = false;
    }
  }
</script>

<form class="calendar-create" data-calendar-window={id} onsubmit={save} oninput={() => { if (!busy) error = ""; }}>
  <fieldset disabled={busy || pickerOpen || loading || unavailable}>
    <label class="title">{word(FIELD.title, "Title")}
      <input name="calendar-title" maxlength={CALENDAR_TITLE_LIMIT} bind:value={title} />
    </label>
    <div class="date">
      <label>{word(FIELD.year, "Year")}
        <select value={year} onchange={event => clampDay(Number(event.currentTarget.value), month)}>
          {#each [currentYear, currentYear + 1] as value (value)}<option {value}>{value}</option>{/each}
        </select>
      </label>
      <label>{word(FIELD.month, "Month")}
        <select value={month} onchange={event => clampDay(year, Number(event.currentTarget.value))}>
          {#each months as name, index (name)}<option value={index}>{word(`UI/Common/Months/${name}`, name)}</option>{/each}
        </select>
      </label>
      <label>{word(FIELD.day, "Day")}
        <select bind:value={day}>
          {#each Array.from({ length: dayCount }, (_, index) => index + 1) as value (value)}<option {value}>{value}</option>{/each}
        </select>
      </label>
      <label>{word(FIELD.time, "Time")}
        <select bind:value={minute}>
          {#each timeOptions as time (time)}<option value={time}>{timeLabel(time)}</option>{/each}
        </select>
      </label>
      <label>{word(FIELD.duration, "Duration")}
        <select bind:value={duration}>
          <option value={null}>{word(FIELD.unspecified, "Not specified")}</option>
          {#if original?.eventDuration != null && (original.eventDuration % 60 !== 0 || original.eventDuration < 60 || original.eventDuration > 1440)}
            <option value={original.eventDuration}>{original.eventDuration} min</option>
          {/if}
          {#each durations as hours (hours)}
            <option value={hours * 60}>{word(FIELD.hours, hours === 1 ? "1 hour" : `${hours} hours`, { hours })}</option>
          {/each}
        </select>
      </label>
    </div>
    <label class="check"><input type="checkbox" bind:checked={important} /> {word(FIELD.important, "Important")}</label>
    {#if original}
      <div><b>{word(FIELD.type, "Event Type")}</b> {word(FIELD[scope], scope)}</div>
    {:else}
      <div class="event-types" role="group" aria-label={word(FIELD.type, "Event Type")}>
        {#each choices as choice (choice)}
          <label class="check">
            <input type="radio" name={`${tabID}-scope`} value={choice} bind:group={scope} />
            {word(FIELD[choice], choice[0]!.toUpperCase() + choice.slice(1))}
          </label>
        {/each}
      </div>
    {/if}
  </fieldset>
  <div class="calendar-create-tabs" role="tablist" aria-label={word(FIELD.type, "Event")} inert={pickerOpen}>
    <button type="button" role="tab" id={`${tabID}-description`} aria-controls={`${tabID}-panel`}
      aria-selected={tab === "description"} onclick={() => { tab = "description"; pickerOpen = false; }}>{word(FIELD.description, "Description")}</button>
    <button type="button" role="tab" id={`${tabID}-invitations`} aria-controls={`${tabID}-panel`}
      aria-selected={tab === "invitations"} onclick={() => (tab = "invitations")}>{word(FIELD.invitations, "Invitations")}</button>
  </div>
  <div class="create-panel" role="tabpanel" id={`${tabID}-panel`} aria-labelledby={`${tabID}-${tab}`} inert={pickerOpen}>
    {#if loading}
      <p role="status">Loading…</p>
    {:else if tab === "description"}
      <textarea aria-label={word(FIELD.description, "Description")} maxlength={CALENDAR_DESCRIPTION_LIMIT} disabled={busy || unavailable} bind:value={description}></textarea>
      <small class:over-limit={descriptionMarkup.length > CALENDAR_DESCRIPTION_LIMIT}>{descriptionMarkup.length}/{CALENDAR_DESCRIPTION_LIMIT}</small>
    {:else if scope === "personal"}
      <div class="invite-toolbar">
        <button type="button" bind:this={addButton} disabled={busy || unavailable} onclick={() => (pickerOpen = true)}>{word(FIELD.add, "Add Invitee")}</button>
        <input type="search" bind:value={filter} aria-label={word(FIELD.search, "Search")} placeholder={word(FIELD.search, "Search")} />
      </div>
      <div class="invite-list">
        {#each inviteeGroups as group (group.status)}
          {@const [key, fallback, icon] = CALENDAR_RESPONSES[group.status] ?? CALENDAR_RESPONSES[3]}
          <details open={!original}>
            <summary><img src={`/client-res/ui/texture/icons/38_16_${icon}.png`} width="16" height="16" alt="" />{word(CALENDAR_RESPONSE_PATH + key, fallback)} ({group.rows.length})</summary>
            {#each group.rows as pilot (pilot.characterID)}
              <div class="invite-row">
                <span>{pilot.name}</span>
                {#if pilot.characterID !== characterID}
                  <button type="button" disabled={busy} aria-label={`Remove ${pilot.name}`}
                    onclick={() => { invitees = invitees.filter(row => row.characterID !== pilot.characterID); }}>
                    {word(FIELD.remove, "Remove Invitee", { num: 1 })}
                  </button>
                {/if}
              </div>
            {:else}<p>{word(FIELD.none, "No characters")}</p>{/each}
          </details>
        {/each}
      </div>
    {:else}
      <p>{groupName}</p>
    {/if}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  <footer inert={pickerOpen}>
    <button type="submit" disabled={busy || pickerOpen || loading || unavailable}>{original ? word(FIELD.save, "Save") : word(FIELD.create, "Create")}</button>
    <button type="button" disabled={busy} onclick={close}>{word(FIELD.cancel, "Cancel")}</button>
  </footer>
  {#if pickerOpen}<CalendarInviteePicker {flow} {store} added={invitees} add={addInvitees} close={closePicker} />{/if}
</form>

<style>
  .calendar-create { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 6px; padding: 6px 8px; box-sizing: border-box; font-size: 12px; }
  fieldset { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 0; margin: 0; border: 0; }
  .title, .date label { display: flex; flex-direction: column; gap: 3px; }
  .date { display: flex; flex-wrap: wrap; gap: 5px; }
  .date select { max-width: 100%; }
  .check, .event-types { display: flex; align-items: center; gap: 4px; }
  .event-types { flex-wrap: wrap; gap: 4px 12px; }
  .calendar-create-tabs { display: flex; gap: 3px; }
  .calendar-create-tabs button[aria-selected="true"] { border-bottom-color: var(--accent, #8eafc8); background: #ffffff16; }
  .create-panel { position: relative; display: flex; flex-direction: column; gap: 4px; flex: 1; min-height: 70px; padding: 4px; border: 1px solid #ffffff26; }
  textarea { flex: 1; min-height: 0; box-sizing: border-box; resize: none; font: inherit; }
  small { align-self: flex-end; }
  .over-limit, p[role="alert"] { color: #ffad99; }
  .invite-toolbar, .invite-row, summary, footer { display: flex; align-items: center; gap: 4px; }
  .invite-toolbar { justify-content: space-between; flex-wrap: wrap; }
  .invite-toolbar input { max-width: 100%; }
  .invite-list { overflow: auto; }
  summary { cursor: pointer; }
  .invite-row { justify-content: space-between; padding: 2px 4px 2px 20px; }
  p { margin: 3px; }
  footer { justify-content: center; }
</style>
