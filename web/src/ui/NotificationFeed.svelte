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
  // Not on the page yet: dragging the widget, the badge, the popups, the kill report / CCP / calendar entry clicks, an entry's
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
  import { corporationApplicationNotification } from "../bridge/corporationApplications.ts";
  import { focusMail } from "./mailFocus.ts";
  import type { TabID } from "./tabs.ts";
  import { watchNotificationPopups } from "./notificationPopups.ts";
  import type { NoticeInput } from "./notices.ts";
  import { unwrapLong } from "../bridge/wire.ts";

  let { store, flow, onOpen }: { store: ClientStore; flow: AppFlow; onOpen: (id: TabID) => void } = $props();

  /**
   * NotificationCenter.OnEntryClick (SOUND_BUTTON_CLICK, then by the type; notificationconst read from the live client,
   * gridcheck g273), as far as the page has the windows: the corporation applications (16 / 139 / 18 / 17 / 142, as the
   * popups do), the character sheet for a medal (3), an NPC standings change (3001) or a title (6003), the wallet for a
   * corporation bill (10), the Ship Tree for an unlocked ship group (6020); kill reports (140 / 141), the CCP group
   * (170 - 173, 4001, 4002), the server shutdown (180) and the calendar event (1050) do what they do in the client
   * where the page cannot yet - nothing; every other type MailInteractor.SelectByNotificationID, the mail window's
   * notifications on its group.
   */
  function entryClick(row: ActivityNotificationRow): void {
    void playUiEvent("ui_button_soft4_play");
    const typeID = row.typeID ?? 0;
    if (typeID === 16 || corporationApplicationNotification(typeID)) { flow.requestCorporationApplications(); onOpen("corporation"); return; }
    if (typeID === 3 || typeID === 3001 || typeID === 6003) { onOpen("characterSheet"); return; }
    if (typeID === 10) { onOpen("wallet"); return; }
    if (typeID === 6020) { onOpen("shipTree"); return; }
    if ([140, 141, 170, 171, 172, 173, 4001, 4002, 180, 1050].includes(typeID)) return;
    onOpen("mail");
    focusMail({ kind: "notification", notificationID: row.notificationID, typeID });
  }
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

  // NotificationUIService's unread counter (notificationUI.py _CheckAndFillCache / ResetUnreadCounter): the notifications
  // made after the last seen time (and shown at all: every type by default), the time kept per pilot
  // (notificationSettings.SetLastSeenTime - here localStorage); FillWithNotifications after the drawer opens calls the
  // provider, which resets the count to 0 and the time to the newest notification's. The history is read at login for
  // it, again every 30 s while it cannot be had (a read made as the session starts can fail).
  const seenKey = () => `evejs.play.notificationsSeen.${store.character.get().selectedCharacterID ?? 0}`;
  function seenTime(): bigint {
    try { return BigInt(localStorage.getItem(seenKey()) ?? "0"); } catch { return 0n; }
  }
  let seen = $state(seenTime());
  function markSeen(): void {
    const newest = rows.reduce((m, r) => (r.created !== null && r.created > m ? r.created : m), seen);
    seen = newest;
    try { localStorage.setItem(seenKey(), String(newest)); } catch { /* the count comes back next time */ }
  }
  /** Live notifications taken in since the history was read (_InsertNotification: each one counted). */
  let liveCount = $state(0);
  const unread = $derived(rows.filter((r) => r.created !== null && r.created > seen).length + liveCount);

  // The popups (notificationCenter.MakeAndDisplayNormalNotification and StackFader): each live notification and new
  // mail as the page words it (notificationPopups.ts), a NotificationEntry 300 wide (popupEntryWidth) with no time line,
  // its height max(50, 5 + the subject wrapped at 224 + the subtext + 5); stacked up from 5 above the widget with 5
  // between (slotSpacing), at most 3 (GetStackSize), the rest queued and shown as a slot frees, the last queued first
  // (overFlowStack.pop()); on show notify_beep3_play and the entry's Blink; each fades out over 0.5 s once the
  // pointer has been off it for GetFadeTime 5 s (its AutoCloser), or goes at once by its close button. A click does
  // what the history's does. Not ported: the popup settings (all types pop up).
  interface Popup { readonly id: number; readonly title: string; readonly detail: string | null; readonly typeID: number | null;
    readonly action: (() => void) | null; outSince: number | null; fading: boolean; h: number }
  let popups = $state<Popup[]>([]);
  const queued: Popup[] = [];
  let popupSeq = 0;
  function showPopup(p: Popup): void {
    void playUiEvent("notify_beep3_play");
    p.outSince = Date.now();
    popups = [p, ...popups];
  }
  function closePopup(id: number): void {
    popups = popups.filter((p) => p.id !== id);
    const next = queued.pop();
    if (next) showPopup(next);
  }
  function addPopup(input: NoticeInput): void {
    const key = input.key ?? "";
    let typeID: number | null = null;
    if (key.startsWith("notification:")) {
      const id = Number(key.slice(13));
      for (const n of store.live.get().notifications) {
        if (n.method !== "OnNotificationReceived" || !Array.isArray(n.args)) continue;
        const nid = unwrapLong(n.args[0]);
        if (nid !== null && Number(nid) === id) { const t = unwrapLong(n.args[1]); typeID = typeof n.args[1] === "number" ? n.args[1] : t === null ? null : Number(t); }
      }
      // the server's history has it now: read again for the drawer
      void flow.loadActivity().catch(() => {});
    } else {
      liveCount += 1;
    }
    const p: Popup = { id: ++popupSeq, title: input.title, detail: input.detail ?? null, typeID, action: input.action ?? null, outSince: null, fading: false, h: 50 };
    if (popups.length < 3) showPopup(p); else queued.push(p);
  }
  $effect(() => watchNotificationPopups(store, flow, (id) => onOpen(id), addPopup));
  $effect(() => {
    const t = setInterval(() => {
      const at = Date.now();
      for (const p of popups) {
        if (!p.fading && p.outSince !== null && at - p.outSince >= 5000) {
          p.fading = true;
          later(500, () => closePopup(p.id));
        }
      }
      popups = [...popups];
    }, 200);
    return () => clearInterval(t);
  });
  $effect(() => {
    let triedAt = 0;
    const tick = () => {
      const a = store.activity.get();
      if (a.notifications.status !== "ready" && !a.loading && Date.now() - triedAt > 30000) { triedAt = Date.now(); void flow.loadActivity().catch(() => {}); }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
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
    later(250, () => { animating = false; filled = true; markSeen(); liveCount = 0; armAutoClose(); });
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

  // NotificationScrollContainer's Scrollbar (carbonui scrollbar.py, as the in-space windows draw it in play.css): 8 wide
  // over the list's right edge - the entries keep their 290 -, no track, the ScrollHandle a 2 px line inset 3 in white
  // 0.25, THEME_FOCUSDARK 0.6 while the list is hovered, 4 wide in THEME_FOCUS under the mouse; hidden while all fits
  // (the live client, g271: no Scrollbar shown with 3 entries in 346).
  let list: HTMLDivElement | undefined = $state();
  let bar = $state({ show: false, top: 0, height: 0 });
  function updateBar(): void {
    const l = list;
    if (!l) return;
    const over = l.scrollHeight - l.clientHeight;
    if (over <= 1) { if (bar.show) bar = { show: false, top: 0, height: 0 }; return; }
    const height = Math.max(16, (l.clientHeight * l.clientHeight) / l.scrollHeight);
    bar = { show: true, height, top: (l.scrollTop / over) * (l.clientHeight - height) };
  }
  $effect(() => { void rows.length; void filled; queueMicrotask(updateBar); });
  function dragBar(e: PointerEvent): void {
    const l = list;
    if (!l) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const y0 = e.clientY, top0 = l.scrollTop;
    const per = (l.scrollHeight - l.clientHeight) / Math.max(1, l.clientHeight - bar.height);
    const move = (m: PointerEvent) => { l.scrollTop = top0 + (m.clientY - y0) * per; };
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }
</script>

<!-- BadgeContainer (FrameWithPointer badgeStyle, POINT_RIGHT_2): the count bold (EveLabelMedium 0.75) in a box 10 wider
     than it and 20 high, its right edge 2 left of the widget, 6 down its side; newItemsBadgeBase.png (corner 10, offset
     -6) and pointer_right_02.png 24 at (w - 8, -2), both in COLORTYPE_UIHILIGHTGLOW at 0.95; fades 0.25 (the live client,
     gridcheck g274: "3" 18 x 20 at (2492, 1398), "12" 26 x 20 at (2484, 1398), the widget at (2512, 1392)) -->
<div class="nf-badge" class:shown={unread > 0 && !open}>
  <span class="nf-badge-bg" style={`-webkit-mask-box-image: url("${clientTexture("res:/UI/Texture/classes/Notifications/newItemsBadgeBase.png")}") 10 / 10px`}></span>
  <span class="nf-badge-ptr" style={`-webkit-mask-image: url("${clientTexture("res:/UI/Texture/classes/Notifications/pointer_right_02.png")}"); mask-image: url("${clientTexture("res:/UI/Texture/classes/Notifications/pointer_right_02.png")}")`}></span>
  <span class="nf-badge-n">{unread}</span>
</div>
<div class="nf-popups">
  {#each popups as p, i (p.id)}
    {@const icon = p.typeID === null ? null : notificationIconPath(p.typeID)}
    <div class="nf-entry nf-popup" class:fading={p.fading} role="listitem" bind:offsetHeight={p.h}
      style:bottom={`${popups.slice(0, i).reduce((y, q) => y + q.h + 5, 0)}px`}
      style={`border-image-source: url("${clientTexture(p.outSince === null ? "res:/UI/Texture/classes/Notifications/historyBackReadOver.png" : "res:/UI/Texture/classes/Notifications/historyBackReadUp.png")}")`}
      onmouseenter={() => { if (!p.fading) { p.outSince = null; popups = [...popups]; void playUiEvent("ui_button_soft2_play"); } }}
      onmouseleave={() => { p.outSince = Date.now(); popups = [...popups]; }}
      onclick={(e) => { if (!(e.target as HTMLElement).closest(".nf-close")) { void playUiEvent("ui_button_soft4_play"); p.action?.(); } }}>
      <span class="nf-blink" style={`background-image: url("${clientTexture("res:/UI/Texture/classes/Neocom/buttonBlink.png")}")`}></span>
      {#if icon}<img class="nf-icon" alt="" src={clientTexture(icon)} />{/if}
      <div class="nf-wrap">
        <div class="nf-subject">{p.title}</div>
        {#if p.detail}<div class="nf-detail">{p.detail}</div>{/if}
      </div>
      <button class="nf-close" aria-label="Close" onclick={() => closePopup(p.id)}>
        <img alt="" src={clientTexture("res:/UI/Texture/eveicon/system_icons/close_16px.png")} />
      </button>
    </div>
  {/each}
</div>
<div class="nf" class:open bind:this={root}>
  <div class="nf-header" class:shown={open}>{word(HISTORY_CAPTION, "Notification History")}</div>
  <div class="nf-list" bind:this={list} onscroll={updateBar}>
    {#if filled}
      {#each rows as row (row.notificationID)}
        {@const icon = notificationIconPath(row.typeID ?? 0)}
        <div class="nf-entry" role="listitem"
          style={`border-image-source: url("${clientTexture(hovered === row.notificationID ? "res:/UI/Texture/classes/Notifications/historyBackReadOver.png" : "res:/UI/Texture/classes/Notifications/historyBackReadUp.png")}")`}
          onmouseenter={() => { hovered = row.notificationID; void playUiEvent("ui_button_soft2_play"); }}
          onmouseleave={() => { if (hovered === row.notificationID) hovered = null; }}
          onclick={(e) => { if (!(e.target as HTMLElement).closest(".nf-close")) entryClick(row); }}>
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
  {#if bar.show && filled}
    <div class="nf-bar" role="scrollbar" aria-controls="" aria-valuenow={0} style={`top: ${22 + bar.top}px; height: ${bar.height}px`} onpointerdown={dragBar}><i></i></div>
  {/if}
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
  /* PushDisplayedItems: each shown popup moved over 0.5 s (MoveTo, ANIM_SMOOTH) to its slot, the newest at the foot */
  .nf-popups { position: fixed; right: 16px; bottom: 53px; width: 300px; height: 0; z-index: 25; pointer-events: none;
    font: 14px 'EVE Sans Neue', 'Segoe UI', sans-serif; color: rgba(255, 255, 255, 0.75); }
  .nf-entry.nf-popup { position: absolute; left: 0; width: 300px; pointer-events: auto; height: auto; min-height: 50px;
    transition: opacity 0.5s, bottom 0.5s cubic-bezier(0.3333, 0, 0.6667, 1);
    background: var(--win-bg, rgba(14, 16, 18, 0.88)); }
  .nf-entry.nf-popup.fading { opacity: 0; }
  .nf-wrap { position: relative; left: 0; top: 0; margin-left: 55px; padding: 5px 0; width: 224px; }
  .nf-wrap .nf-subject { white-space: normal; }
  .nf-detail { line-height: 18px; }
  /* NotificationEntry.Blink: SpSwoopBlink(buttonBlink.png, rotation 0.75 pi, 0.8 s, once, ANIM_LINEAR) - the sprite
     modulated by swoopGradient.png (a band one texture wide: alpha 0 at its edges, half at 0.24 / 0.76, full 0.44 - 0.55,
     read in the page) turned 135 degrees and slid from -1 to 2: here a 135 deg gradient mask, the band 70.7 % of the
     gradient line wide (one texture width along u + v), its middle from -106 % to 106 % */
  .nf-blink { position: absolute; inset: 0; background-size: 100% 100%; pointer-events: none; --nf-swoop: -106%;
    -webkit-mask-image: linear-gradient(135deg, transparent calc(50% + var(--nf-swoop) - 35%), rgba(0, 0, 0, 0.5) calc(50% + var(--nf-swoop) - 19%), #000 calc(50% + var(--nf-swoop) - 4%), #000 calc(50% + var(--nf-swoop) + 4%), rgba(0, 0, 0, 0.5) calc(50% + var(--nf-swoop) + 19%), transparent calc(50% + var(--nf-swoop) + 35%));
    mask-image: linear-gradient(135deg, transparent calc(50% + var(--nf-swoop) - 35%), rgba(0, 0, 0, 0.5) calc(50% + var(--nf-swoop) - 19%), #000 calc(50% + var(--nf-swoop) - 4%), #000 calc(50% + var(--nf-swoop) + 4%), rgba(0, 0, 0, 0.5) calc(50% + var(--nf-swoop) + 19%), transparent calc(50% + var(--nf-swoop) + 35%));
    animation: nf-swoop 0.8s linear forwards; }
  @keyframes nf-swoop { from { --nf-swoop: -106%; } to { --nf-swoop: 106%; } }
  @property --nf-swoop { syntax: "<percentage>"; inherits: false; initial-value: -106%; }
  .nf-badge { position: fixed; right: 50px; bottom: 22px; height: 20px; z-index: 25; pointer-events: none; opacity: 0; transition: opacity 0.25s;
    font: bold 14px/18px 'EVE Sans Neue', 'Segoe UI', sans-serif; color: rgba(255, 255, 255, 0.75); }
  .nf-badge.shown { opacity: 1; }
  .nf-badge-bg { position: absolute; inset: -6px; background: var(--theme-focus-glow, #ccf3ff); opacity: 0.95; }
  .nf-badge-ptr { position: absolute; right: -16px; top: -2px; width: 24px; height: 24px; background: var(--theme-focus-glow, #ccf3ff); opacity: 0.95;
    -webkit-mask-size: 24px 24px; mask-size: 24px 24px; }
  .nf-badge-n { position: relative; display: block; padding: 1px 5px; }
  .nf-list { position: absolute; left: 5px; right: 5px; top: 22px; bottom: 32px; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
  .nf-bar { position: absolute; left: 287px; width: 8px; cursor: default; }
  .nf-bar i { position: absolute; left: 3px; top: 3px; bottom: 3px; width: 2px; background: rgba(255, 255, 255, 0.25); }
  .nf:has(.nf-list:hover) .nf-bar i { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 60%, transparent); }
  .nf-bar:hover i { left: 2px; width: 4px; background: var(--theme-focus, #58a7bf); }
  .nf-entry { position: relative; height: 50px; cursor: pointer; border-style: solid; border-width: 0; box-sizing: border-box;
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
