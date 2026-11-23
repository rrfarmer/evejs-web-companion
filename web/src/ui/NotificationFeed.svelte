<script lang="ts">
  // The notification feed (notifications/client/notificationCenter.py): the 32 x 32 widget in the bottom-right corner
  // and the history drawer it opens. Read from the live 3698585 client (gridcheck g268 closed, g271 open):
  //  - closed: a WindowUnderlay with the WidgetIcon ButtonIcon (widgetIcon.png 32 at 0.75), 48 from the right and the
  //    bottom; its tooltip Generic1Column, Notification Feed and the drag note (with AddLabelShortcut's empty row).
  //  - OnWidgetButtonClick: OpenDrawer - the container grows to NOTIFICATION_CENTER_WIDTH 300 by the preferred height
  //    400 over FADE_IN_SECONDS 0.25, upwards and leftwards from the widget (EXPAND_ALIGNMENT up / left: its right and
  //    bottom kept), notify_slide_open_play; the Notification History header fades in (EveLabelSmall bold 0.75, centred,
  //    4 from the top, 18 high); after the animation FillWithNotifications and the settings button (77_32_30.png 24, 5
  //    from the left of the 32 high bottom strip) fade in. CloseDrawer: back to 32 x 32 over 0.25, notify_slide_close_play.
  //  - the scroll list: 5 in from each side, under the header (22) and over the bottom strip (32): 290 x 346.
  //  - NotificationEntry: 50 high (MINENTRYHEIGHT); its frame historyBackReadUp.png (corner 6, offset -5), Over under
  //    the mouse with SOUND_ENTRY_HOVER; the type's icon 40 at (5, 5) (NOTIFICATION_TYPE_TO_TEXTURE); the subject
  //    EveLabelMedium bold at (55, 5), 224 wide; under it, 5 apart, the time since it came (NotificationTimeAgo,
  //    EveLabelSmall in TIMETEXT_COLOR 0.5 grey); a close button (close 16) at the top right, 2 in, faded in under the mouse.
  //  - SetupDrawerAutoCloser: the drawer closes once the pointer has been out of it (10 px around) for a second.
  // Not on the page yet: dragging the widget, the badge, the popups, an entry's click (GetNotificationAction), its
  // portrait / kill ship icon, the settings window, the resize line.
  import { onMount } from "svelte";
  import { filetimeToUnixMs } from "../bridge/activity.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { notificationSubjectWording, notificationWording, type NotificationFormats } from "../bridge/notificationFormats.ts";
  import type { Notification } from "../bridge/notifications.ts";
  import { INTERVAL_WORD_LABELS, intervalWriters } from "../bridge/timeInterval.ts";
  import { resolvedName } from "../store/names.ts";
  import type { ActivityNotificationRow } from "../store/types.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import { clientTexture } from "../play/window.ts";
  import { notificationIconPath } from "../play/notificationIcons.ts";
  import { playUiEvent } from "../play/uiAudio.ts";
  import { tooltipDue, showLabelShortcutTooltip, hideLabelShortcutTooltip } from "../play/labelShortcutTooltip.ts";

  let { store, flow }: { store: ClientStore; flow: AppFlow } = $props();
  const activity = store.activity;
  const words = store.words;
  const names = store.names;

  const HISTORY_CAPTION = "Notifications/NotificationWidget/NotificationHistoryCaption";
  const TIME_AGO = "Notifications/NotificationWidget/NotificationTimeAgo";

  let open = $state(false);
  let animating = $state(false);
  /** The entries shown: after the open animation (FillWithNotifications), gone again as it closes. */
  let filled = $state(false);
  let formats = $state<NotificationFormats | null>(null);
  let closedIDs = $state(new Set<number>());
  let now = $state(Date.now());
  let root: HTMLDivElement | undefined = $state();

  function word(label: string, own: string): string {
    const t = $words.templates[label];
    return typeof t === "string" ? t : own;
  }
  const asNotification = (row: ActivityNotificationRow): Notification => ({
    notificationID: row.notificationID, typeID: row.typeID ?? 0, senderID: row.senderID, receiverID: row.receiverID ?? 0,
    processed: row.processed, created: row.created, data: row.data ?? null,
  });
  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName($names.resolved, kind, id, "");
  function subjectOf(row: ActivityNotificationRow): string {
    const s = formats === null ? null : notificationSubjectWording(asNotification(row), formats, $words.templates, nameOf).subject;
    return s ?? row.title;
  }
  /** NotificationTimeAgo with the time since it came (blue.os wallclock ticks: 10,000 a millisecond). */
  function agoOf(row: ActivityNotificationRow): string {
    const ms = filetimeToUnixMs(row.created);
    if (ms === null) return "";
    const ticks = Math.max(0, now - ms) * 10000;
    return plainText(formatTemplate(word(TIME_AGO, "{[timeinterval]time.writtenForm, to=minute} ago"), { time: ticks }, { nameOf, ...intervalWriters($words.templates) }));
  }
  const rows = $derived.by(() => {
    if ($activity.notifications.status !== "ready") return [];
    return [...$activity.notifications.value].filter((r) => !closedIDs.has(r.notificationID))
      .sort((a, b) => Number((b.created ?? 0n) - (a.created ?? 0n)));
  });
  // the words the subjects take, and the names in them
  $effect(() => {
    const known = formats;
    if (known === null || !filled) return;
    const labels = new Set<string>();
    for (const row of rows) {
      const w = notificationWording(asNotification(row), known, $words.templates, nameOf, "subject");
      for (const l of w.labels) labels.add(l);
      if (w.refs.length > 0) flow.requestNames(w.refs);
    }
    if (labels.size) flow.requestWords([...labels]);
  });

  onMount(() => {
    flow.requestWords([HISTORY_CAPTION, TIME_AGO, ...INTERVAL_WORD_LABELS]);
  });

  let timers: ReturnType<typeof setTimeout>[] = [];
  function later(ms: number, run: () => void) { timers.push(setTimeout(run, ms)); }
  $effect(() => () => { for (const t of timers) clearTimeout(t); });

  function openDrawer() {
    if (animating) return;
    hideLabelShortcutTooltip();
    open = true; animating = true;
    void playUiEvent("notify_slide_open_play");
    now = Date.now();
    if (formats === null) void flow.notificationFormats().then((f) => { formats = f; }).catch(() => {});
    if ($activity.notifications.status !== "ready" && !$activity.loading) void flow.loadActivity().catch(() => {});
    later(250, () => { animating = false; filled = true; armAutoClose(); });
  }
  function closeDrawer() {
    if (animating) return;
    animating = true; filled = false; open = false;
    disarmAutoClose();
    void playUiEvent("notify_slide_close_play");
    later(250, () => { animating = false; });
  }
  function onWidgetClick() { if (open) closeDrawer(); else openDrawer(); }

  // AutoCloser(thresholdInSeconds=1.0, buffer=10): out of the drawer's area for a second closes it
  let outSince: number | null = null;
  let watch: ReturnType<typeof setInterval> | null = null;
  function onMove(e: PointerEvent) {
    if (!root) return;
    const r = root.getBoundingClientRect();
    const inside = e.clientX >= r.left - 10 && e.clientX <= r.right + 10 && e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10;
    outSince = inside ? null : (outSince ?? Date.now());
  }
  function armAutoClose() {
    outSince = null;
    window.addEventListener("pointermove", onMove, true);
    watch = setInterval(() => { now = Date.now(); if (outSince !== null && Date.now() - outSince >= 1000) closeDrawer(); }, 100);
  }
  function disarmAutoClose() {
    window.removeEventListener("pointermove", onMove, true);
    if (watch) clearInterval(watch);
    watch = null;
  }
  $effect(() => () => disarmAutoClose());

  let hovered = $state<number | null>(null);
</script>

<div class="nf" class:open bind:this={root}>
  <div class="nf-header" class:shown={open}>{word(HISTORY_CAPTION, "Notification History")}</div>
  <div class="nf-list">
    {#if filled}
      {#each rows as row (row.notificationID)}
        {@const icon = notificationIconPath(row.typeID ?? 0)}
        <div class="nf-entry" role="listitem"
          style={`border-image-source: url("${clientTexture(hovered === row.notificationID ? "res:/UI/Texture/classes/Notifications/historyBackReadOver.png" : "res:/UI/Texture/classes/Notifications/historyBackReadUp.png")}")`}
          onmouseenter={() => { hovered = row.notificationID; void playUiEvent("ui_button_soft2_play"); }}
          onmouseleave={() => { if (hovered === row.notificationID) hovered = null; }}>
          {#if icon}<img class="nf-icon" alt="" src={clientTexture(icon)} />{/if}
          <div class="nf-text">
            <div class="nf-subject">{subjectOf(row)}</div>
            {#if row.created !== null}<div class="nf-time">{agoOf(row)}</div>{/if}
          </div>
          <button class="nf-close" aria-label="Close" onclick={() => { closedIDs = new Set([...closedIDs, row.notificationID]); }}>
            <img alt="" src={clientTexture("res:/UI/Texture/eveicon/system_icons/close_16px.png")} />
          </button>
        </div>
      {/each}
    {/if}
  </div>
  <div class="nf-strip">
    <img class="nf-settings" class:shown={filled} alt="" src={clientTexture("res:/UI/Texture/Icons/77_32_30.png")} />
    <button class="nf-widget" aria-label="Notification Feed" onclick={onWidgetClick}
      onmouseenter={(e) => { if (open) return; const el = e.currentTarget; tooltipDue(el, () => showLabelShortcutTooltip(el, "Notification Feed", "", ["", "Click, hold and drag to reposition notifications feed"], "top", "wrap")); }}
      onmouseleave={() => hideLabelShortcutTooltip()}>
      <img alt="" src={clientTexture("res:/UI/Texture/classes/Notifications/widgetIcon.png")} />
    </button>
  </div>
</div>

<style>
  /* WindowUnderlay: the blurred scene under a 0.1 white frame; the container grows from the widget's right and bottom */
  .nf { position: fixed; right: 16px; bottom: 16px; width: 32px; height: 32px; z-index: 25; overflow: hidden; box-sizing: border-box;
    background: var(--win-bg, rgba(14, 16, 18, 0.88)); backdrop-filter: var(--win-backdrop, blur(6px)); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
    transition: width 0.25s, height 0.25s; font: 14px 'EVE Sans Neue', 'Segoe UI', sans-serif; color: rgba(255, 255, 255, 0.75); }
  .nf.open { width: 300px; height: 400px; }
  .nf-header { position: absolute; left: 0; right: 0; top: 4px; height: 18px; line-height: 18px; text-align: center; font-size: 12px; font-weight: bold;
    white-space: nowrap; opacity: 0; transition: opacity 0.25s; pointer-events: none; }
  .nf-header.shown { opacity: 1; }
  .nf-list { position: absolute; left: 5px; right: 5px; top: 22px; bottom: 32px; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
  /* the list's own scrollbar (NotificationScrollContainer's, over its right edge) is not drawn yet: the wheel scrolls it */
  .nf-entry { position: relative; height: 50px; border-style: solid; border-width: 0; box-sizing: border-box;
    border-image-slice: 6 fill; border-image-width: 6px; border-image-outset: 5px; }
  .nf-icon { position: absolute; left: 5px; top: 5px; width: 40px; height: 40px; }
  .nf-text { position: absolute; left: 55px; top: 5px; width: 224px; }
  .nf-subject { font-weight: bold; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nf-time { margin-top: 5px; font-size: 12px; line-height: 16px; color: rgb(128, 128, 128); }
  .nf-close { position: absolute; right: 2px; top: 2px; width: 16px; height: 16px; padding: 0; margin: 0; border: 0; background: none; cursor: pointer;
    opacity: 0; transition: opacity 0.2s; }
  .nf-close img { display: block; width: 16px; height: 16px; opacity: 0.75; }
  .nf-entry:hover .nf-close { opacity: 1; }
  .nf-strip { position: absolute; left: 0; right: 0; bottom: 0; height: 32px; }
  .nf-settings { position: absolute; left: 5px; top: 4px; width: 24px; height: 24px; opacity: 0; transition: opacity 0.25s; pointer-events: none; }
  .nf-settings.shown { opacity: 0.75; }
  .nf-widget { position: absolute; right: 0; bottom: 0; width: 32px; height: 32px; padding: 0; margin: 0; border: 0; background: none; cursor: pointer;
    display: block; line-height: 0; min-width: 0; min-height: 0; }
  .nf-widget img { width: 32px; height: 32px; max-width: none; opacity: 0.75; pointer-events: none; }
  .nf-widget:hover img { opacity: 1; }
</style>
