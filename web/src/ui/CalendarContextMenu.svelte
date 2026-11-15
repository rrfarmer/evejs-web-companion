<script lang="ts">
  import { tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { CalendarReply } from "../bridge/calendar.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { calendarDate, calendarDayStart } from "./calendarSelection.ts";
  import { CALENDAR_REPLY_CHOICES, calendarCaption, calendarReplyChoices, calendarResponses, calendarView, canManageCalendarEvent, type CalendarMenu } from "./calendarView.ts";
  import { notify } from "./notices.ts";
  import { portal } from "./portal.ts";

  let { flow, store, menu }: { flow: AppFlow; store: ClientStore; menu: CalendarMenu } = $props();
  // svelte-ignore state_referenced_locally
  const { station, words } = store;
  // svelte-ignore state_referenced_locally
  const model = calendarView(flow);
  const { agenda, replying, deleting } = model;
  const viewEvent = "/Carbon/UI/Calendar/ViewEvent";
  const editEvent = "/Carbon/UI/Calendar/EditEvent";
  const deleteEvent = "/Carbon/UI/Calendar/DeleteEvent";
  const goToDay = "/Carbon/UI/Calendar/GotoDay";
  const createEvent = "/Carbon/UI/Calendar/CreateNewEvent";
  const viewDay = "/Carbon/UI/Calendar/ViewDay";
  const word = (key: string, fallback: string): string => plainText($words.templates[key] ?? "") || fallback;
  const row = $derived(menu.kind === "event" ? menu.row : null);
  const day = $derived(menu.kind === "day" ? menu.day : null);
  const canCreate = $derived(day !== null && calendarDayStart(day) >= calendarDayStart(calendarDate(new Date(flow.calendarNow()))));
  const event = $derived(row && $agenda.status === "ready" ?
    $agenda.data.events.find(candidate => candidate.eventID === row?.event.eventID) ?? row.event : row?.event ?? null);
  const response = $derived(event ? calendarResponses($agenda).get(event.eventID) ?? row?.response ?? 3 : 3);
  const characterID = $derived($station.online?.characterID ?? null);
  const replies = $derived(event ? calendarReplyChoices(event, characterID, response, flow.calendarNow(), true) : []);
  const manage = $derived(event !== null && canManageCalendarEvent(event, $station.online, flow.calendarNow()));

  let popup: HTMLDivElement | undefined = $state();
  let x = $state(0), y = $state(0);
  $effect(() => {
    flow.requestWords([viewEvent, editEvent, deleteEvent, goToDay, createEvent, viewDay, ...CALENDAR_REPLY_CHOICES.map(([, key]) => key)]);
  });
  $effect(() => {
    const { x: left, y: top } = menu;
    const node = popup;
    if (!node) return;
    const fit = () => {
      x = Math.max(0, Math.min(left, window.innerWidth - node.offsetWidth));
      y = Math.max(0, Math.min(top, window.innerHeight - node.offsetHeight));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    window.addEventListener("resize", fit);
    fit();
    void tick().then(() => node.querySelector("button")?.focus());
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  });

  function dismiss(restoreFocus = false): void {
    const anchor = menu.anchor;
    model.closeMenu();
    if (restoreFocus && anchor.isConnected) anchor.focus();
  }

  function outside(input: PointerEvent): void {
    if (input.target instanceof Node && !popup?.contains(input.target)) dismiss();
  }

  function navigate(input: KeyboardEvent): void {
    if (input.key === "Escape" || input.key === "Tab") {
      if (input.key === "Escape") {
        input.preventDefault();
        input.stopPropagation();
      }
      dismiss(true);
    } else if (input.key === "ArrowDown" || input.key === "ArrowUp") {
      input.preventDefault();
      const items = Array.from(popup?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = input.key === "ArrowDown" ? 1 : -1;
      items[(current + step + items.length) % items.length]?.focus();
    }
  }

  async function respond(status: CalendarReply): Promise<void> {
    const invitation = event;
    if (!invitation) return;
    const choices = calendarReplyChoices(invitation, characterID, response, flow.calendarNow(), true);
    dismiss(true);
    try {
      if (!choices.some(([choice]) => choice === status)) {
        throw new Error("This event no longer accepts that reply.");
      }
      await model.reply(invitation, status);
    } catch (error) {
      notify({ kind: "danger", title: "Calendar", detail: error instanceof Error ? error.message : "The Calendar reply could not be saved." });
    }
  }

  function openEvent(edit = false): void {
    const invitation = event;
    dismiss();
    if (invitation) model.openEvent(invitation, edit);
  }

  async function removeEvent(): Promise<void> {
    const invitation = event;
    dismiss(true);
    if (!invitation) return;
    try {
      await model.deleteEvent(invitation);
    } catch (error) {
      notify({ kind: "danger", title: "Calendar", detail: error instanceof Error ? error.message : "The Calendar event could not be canceled." });
    }
  }

  function jump(): void {
    const day = row?.day;
    dismiss(true);
    if (day) model.jumpToDay(day);
  }

  function openDay(create: boolean, keep: boolean): void {
    const date = day;
    dismiss(true);
    if (!date) return;
    if (create) model.newEvent(date);
    else model.openDay(date, keep);
  }
</script>

<svelte:window onpointerdown={outside} />
<div class="hull-menu calendar-context-menu" role="menu" aria-label={event?.eventTitle ?? (day && calendarCaption(day)) ?? "Calendar"} tabindex="-1"
  use:portal bind:this={popup} style:left={`${x}px`} style:top={`${y}px`} onkeydown={navigate}>
  {#if event && menu.kind === "event"}
    <button type="button" role="menuitem" tabindex="-1" onclick={() => openEvent()}>{word(viewEvent, "View Event")}</button>
    {#if manage}
      <button type="button" role="menuitem" tabindex="-1" disabled={$deleting.has(event.eventID)} onclick={() => openEvent(true)}>{word(editEvent, "Edit Event")}</button>
    {/if}
    {#if replies.length}
      <hr />
      {#each replies as [status, key, fallback] (status)}
        <button type="button" role="menuitem" tabindex="-1" disabled={$replying.has(event.eventID)} onclick={() => respond(status)}>{word(key, fallback)}</button>
      {/each}
    {/if}
    {#if menu.allowJump && !event.isDeleted && response !== 1}
      <hr />
      <button type="button" role="menuitem" tabindex="-1" onclick={jump}>{word(goToDay, "Go to Day")}</button>
    {/if}
    {#if manage}
      <hr />
      <button type="button" role="menuitem" tabindex="-1" disabled={$deleting.has(event.eventID)} onclick={removeEvent}>{word(deleteEvent, "Delete Event")}</button>
    {/if}
  {:else if day}
    {#if canCreate}<button type="button" role="menuitem" tabindex="-1" onclick={() => openDay(true, false)}>{word(createEvent, "Create New Event")}</button>{/if}
    <button type="button" role="menuitem" tabindex="-1" onclick={input => openDay(false, input.shiftKey)}>{word(viewDay, "View Day")}</button>
  {/if}
</div>

<style>
  button { border: 0; border-radius: 0; background: transparent; padding: 4px 10px; text-align: left; }
  button:hover, button:focus-visible { background: #ffffff18; }
  hr { width: 100%; margin: 2px 0; border: 0; border-top: 1px solid #ffffff26; }
</style>
