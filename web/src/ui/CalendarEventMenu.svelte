<script lang="ts">
  import { tick } from "svelte";
  import type { AppFlow } from "../app/flow.ts";
  import type { CalendarReply } from "../bridge/calendar.ts";
  import { plainText } from "../bridge/clientWords.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { CALENDAR_REPLY_CHOICES, calendarReplyChoices, calendarResponses, calendarView, type CalendarMenu } from "./calendarView.ts";
  import { notify } from "./notices.ts";
  import { portal } from "./portal.ts";

  let { flow, store, menu }: { flow: AppFlow; store: ClientStore; menu: CalendarMenu } = $props();
  // svelte-ignore state_referenced_locally
  const { station, words } = store;
  // svelte-ignore state_referenced_locally
  const model = calendarView(flow);
  const { agenda, replying } = model;
  const viewEvent = "/Carbon/UI/Calendar/ViewEvent";
  const goToDay = "/Carbon/UI/Calendar/GotoDay";
  const word = (key: string, fallback: string): string => plainText($words.templates[key] ?? "") || fallback;
  const event = $derived($agenda.status === "ready" ?
    $agenda.data.events.find(row => row.eventID === menu.row.event.eventID) ?? menu.row.event : menu.row.event);
  const response = $derived(calendarResponses($agenda).get(event.eventID) ?? menu.row.response);
  const characterID = $derived($station.online?.characterID ?? null);
  const replies = $derived(calendarReplyChoices(event, characterID, response, flow.calendarNow(), true));

  let popup: HTMLDivElement | undefined = $state();
  let x = $state(0), y = $state(0);
  $effect(() => {
    flow.requestWords([viewEvent, goToDay, ...CALENDAR_REPLY_CHOICES.map(([, key]) => key)]);
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
    model.closeEventMenu();
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

  function openEvent(): void {
    const invitation = event;
    dismiss();
    model.openEvent(invitation);
  }

  function jump(): void {
    const day = menu.row.day;
    dismiss(true);
    model.jumpToDay(day);
  }
</script>

<svelte:window onpointerdown={outside} />
<div class="hull-menu calendar-event-menu" role="menu" aria-label={event.eventTitle} tabindex="-1"
  use:portal bind:this={popup} style:left={`${x}px`} style:top={`${y}px`} onkeydown={navigate}>
  <button type="button" role="menuitem" tabindex="-1" onclick={openEvent}>{word(viewEvent, "View Event")}</button>
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
</div>

<style>
  button { border: 0; border-radius: 0; background: transparent; padding: 4px 10px; text-align: left; }
  button:hover, button:focus-visible { background: #ffffff18; }
  hr { width: 100%; margin: 2px 0; border: 0; border-top: 1px solid #ffffff26; }
</style>
