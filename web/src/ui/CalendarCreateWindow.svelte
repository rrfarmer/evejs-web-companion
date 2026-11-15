<script lang="ts">
  import { tick } from "svelte";
  import type { CharacterMatch } from "../app/api.ts";
  import type { AppFlow } from "../app/flow.ts";
  import { CALENDAR_DESCRIPTION_LIMIT, CALENDAR_INVITEE_LIMIT, CALENDAR_MONTH_RANGE, CALENDAR_TITLE_LIMIT,
    type CalendarEventScope } from "../bridge/calendar.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { hasChatManagerRole } from "../bridge/mail.ts";
  import { mailMarkupOfTyped } from "../bridge/mailMarkup.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { resolvedName } from "../store/names.ts";
  import CalendarInviteePicker from "./CalendarInviteePicker.svelte";
  import { calendarDate, calendarMonthOffset } from "./calendarSelection.ts";

  let { flow, store, id, startsAt, close }: {
    flow: AppFlow; store: ClientStore; id: string; startsAt: number; close: () => void;
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
    none: "UI/Calendar/EventWindow/NoCharacter", undecided: "UI/Calendar/ResponseTypes/NotResponded",
    create: "UI/Calendar/EventWindow/Create", cancel: "UI/Generic/Cancel", limit: "UI/Calendar/FindInviteesWindow/TooMany",
    required: "dialog:CalendarEventMustSpecifyTitle/body", past: "dialog:CalendarCannotPlanThePast/body",
    future: "dialog:CalendarTooFarIntoFuture/body",
  } as const;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const timeOptions = Array.from({ length: 96 }, (_, quarter) =>
    `${String(Math.floor(quarter / 4)).padStart(2, "0")}:${String(quarter % 4 * 15).padStart(2, "0")}`);
  const durations = Array.from({ length: 24 }, (_, index) => index + 1);
  const word = (key: string, fallback: string, values: Record<string, number> = {}): string =>
    plainText(formatTemplate($words.templates[key] ?? "", values, { nameOf: () => "" })) || fallback;
  $effect(() => { flow.requestWords([...Object.values(FIELD), ...months.map(month => `UI/Common/Months/${month}`)]); });

  const tabID = $props.id();
  let title = $state(""), description = $state("");
  let year = $state(initial.getUTCFullYear()), month = $state(initial.getUTCMonth()), day = $state(initial.getUTCDate());
  let quarterHour = $state(initial.getUTCHours() * 4 + initial.getUTCMinutes() / 15);
  let duration = $state<number | null>(null);
  let important = $state(false);
  let scope = $state<CalendarEventScope>("personal");
  let tab = $state<"description" | "invitations">("description");
  let invitees = $state<readonly CharacterMatch[]>([]);
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
  const descriptionMarkup = $derived(mailMarkupOfTyped(description));
  const currentYear = $derived.by(() => new Date(flow.calendarNow()).getUTCFullYear());
  const dayCount = $derived(new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  const filterText = $derived(filter.trim().toLocaleLowerCase());
  const shownInvitees = $derived(invitees.filter(pilot => filterText.length < 2 || pilot.name.toLocaleLowerCase().includes(filterText))
    .sort((a, b) => a.name.localeCompare(b.name)));

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
      if (pilot.characterID !== $station.online?.characterID) selected.set(pilot.characterID, pilot);
    }
    if (selected.size > CALENDAR_INVITEE_LIMIT) {
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
    if (!choices.includes(scope)) return "Your current roles do not allow this event type.";
    return "";
  }

  async function create(input: SubmitEvent): Promise<void> {
    input.preventDefault();
    if (busy) return;
    const at = Date.UTC(year, month, day, 0, quarterHour * 15);
    error = validation(at);
    if (error) return;
    busy = true;
    try {
      const eventID = await flow.createCalendarEvent({
        scope, startsAt: at, duration, title, description: descriptionMarkup, important,
        inviteeIDs: invitees.map(pilot => pilot.characterID),
      });
      if (eventID !== null) close();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The Calendar event could not be created.";
    } finally {
      busy = false;
    }
  }
</script>

<form class="calendar-create" data-calendar-window={id} onsubmit={create} oninput={() => { if (!busy) error = ""; }}>
  <fieldset disabled={busy || pickerOpen}>
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
        <select bind:value={quarterHour}>
          {#each timeOptions as time, index (time)}<option value={index}>{time}</option>{/each}
        </select>
      </label>
      <label>{word(FIELD.duration, "Duration")}
        <select bind:value={duration}>
          <option value={null}>{word(FIELD.unspecified, "Not specified")}</option>
          {#each durations as hours (hours)}
            <option value={hours * 60}>{word(FIELD.hours, hours === 1 ? "1 hour" : `${hours} hours`, { hours })}</option>
          {/each}
        </select>
      </label>
    </div>
    <label class="check"><input type="checkbox" bind:checked={important} /> {word(FIELD.important, "Important")}</label>
    <div class="event-types" role="group" aria-label={word(FIELD.type, "Event Type")}>
      {#each choices as choice (choice)}
        <label class="check">
          <input type="radio" name={`${tabID}-scope`} value={choice} bind:group={scope} />
          {word(FIELD[choice], choice[0]!.toUpperCase() + choice.slice(1))}
        </label>
      {/each}
    </div>
  </fieldset>
  <div class="calendar-create-tabs" role="tablist" aria-label={word(FIELD.type, "Event")} inert={pickerOpen}>
    <button type="button" role="tab" id={`${tabID}-description`} aria-controls={`${tabID}-panel`}
      aria-selected={tab === "description"} onclick={() => { tab = "description"; pickerOpen = false; }}>{word(FIELD.description, "Description")}</button>
    <button type="button" role="tab" id={`${tabID}-invitations`} aria-controls={`${tabID}-panel`}
      aria-selected={tab === "invitations"} onclick={() => (tab = "invitations")}>{word(FIELD.invitations, "Invitations")}</button>
  </div>
  <div class="create-panel" role="tabpanel" id={`${tabID}-panel`} aria-labelledby={`${tabID}-${tab}`} inert={pickerOpen}>
    {#if tab === "description"}
      <textarea aria-label={word(FIELD.description, "Description")} maxlength={CALENDAR_DESCRIPTION_LIMIT} disabled={busy} bind:value={description}></textarea>
      <small class:over-limit={descriptionMarkup.length > CALENDAR_DESCRIPTION_LIMIT}>{descriptionMarkup.length}/{CALENDAR_DESCRIPTION_LIMIT}</small>
    {:else if scope === "personal"}
      <div class="invite-toolbar">
        <button type="button" bind:this={addButton} disabled={busy} onclick={() => (pickerOpen = true)}>{word(FIELD.add, "Add Invitee")}</button>
        <input type="search" bind:value={filter} aria-label={word(FIELD.search, "Search")} placeholder={word(FIELD.search, "Search")} />
      </div>
      <div class="invite-list">
        <details open>
          <summary><img src="/client-res/ui/texture/icons/38_16_177.png" width="16" height="16" alt="" />{word(FIELD.undecided, "Not Responded")} ({shownInvitees.length})</summary>
          {#each shownInvitees as pilot (pilot.characterID)}
            <div class="invite-row">
              <span>{pilot.name}</span>
              <button type="button" disabled={busy} aria-label={`Remove ${pilot.name}`}
                onclick={() => { invitees = invitees.filter(row => row.characterID !== pilot.characterID); }}>
                {word(FIELD.remove, "Remove Invitee", { num: 1 })}
              </button>
            </div>
          {:else}<p>{word(FIELD.none, "No characters")}</p>{/each}
        </details>
      </div>
    {:else}
      <p>{groupName}</p>
    {/if}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  <footer inert={pickerOpen}>
    <button type="submit" disabled={busy || pickerOpen}>{word(FIELD.create, "Create")}</button>
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
