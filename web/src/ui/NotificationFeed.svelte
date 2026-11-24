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
  import { PlayWindow } from "../play/window.ts";
  import { NOTIFICATION_GROUPS } from "../play/notificationGroups.ts";
  import { portraitUrl, portraitDefaultPath, remoteImageUrl } from "./ownerImages.ts";
  import { notificationArguments } from "../bridge/notificationFormats.ts";
  import { typeIconUrl } from "./typeIcons.ts";
  import { techLevelIcon } from "../play/techLevelIcon.ts";

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
    const own = local.get(row.notificationID);
    if (own) { own.action?.(); return; }
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
  // The client's own notifications (notificationSvc.MakeAndScatterNotification / mailSvc's NewMailFrom): kept in the
  // notification cache with the server's, so in the history too - here each a row of its own (a negative id, its
  // created now) with its subject, subtext and click.
  const local = new Map<number, { subject: string; subtext: string | null; action: (() => void) | null }>();
  let localRows = $state<ActivityNotificationRow[]>([]);
  let localSeq = 0;
  function addLocalRow(typeID: number, subject: string, subtext: string | null, action: (() => void) | null, senderID = 0): void {
    const id = -(++localSeq);
    local.set(id, { subject, subtext, action });
    const created = BigInt(Date.now()) * 10000n + 116444736000000000n;
    localRows = [...localRows, { notificationID: id, senderID, processed: false, created, title: subject, typeID }];
  }
  // NotificationEntry.LoadContent: for notificationDisplaySender's types (read from the live client, g301) the sender
  // over the type's icon at 40 - a character's portrait (photo.GetPortrait at CHAR_PORTRAIT_SIZE 128), a corporation's
  // logo (GetLogoIcon 40), and for a sender that is neither (IsCorporation / IsCharacter) silhouette_64
  const DISPLAY_SENDER = new Set([2, 3, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 50, 66, 69, 70, 71, 72, 73, 74, 85, 86, 87, 88, 89, 90, 92, 128,
    129, 130, 131, 139, 142, 143, 144, 145, 146, 147, 148, 149, 150, 152, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 247, 248, 251, 270, 1004,
    2001, 2002, 3001]);
  const isCorporation = (id: number) => (id >= 1000000 && id < 2000000) || (id >= 98000000 && id < 99000000);
  const isCharacter = (id: number) => (id >= 3000000 && id < 4000000) || (id >= 90000000 && id < 98000000) || (id >= 100000000 && id <= 2147483647);
  // LoadContent: a kill report (KillReportFinalBlow 140 / KillReportVictim 141) adds the victim ship type icon (Icon size
  // SHIP_TYPE_ICON_SIZE 40, TOPRIGHT of the 40 wide left panel - over the type icon), KillMailFinalBlowFormatter
  // .GetVictimShipTypeID: data['victimShipTypeID']. (Its 16 px tech level icon is not ported.)
  // and uix.GetTechLevelIcon(shipTechIcon) - the victim ship's meta group icon, 16 x 16 at the left panel's corner
  const killShipMeta = new Map<number, number | null>();
  let killShipMetaRev = $state(0);
  function killShipTech(row: ActivityNotificationRow): { path: string; hint: string } | null {
    if (row.typeID !== 140 && row.typeID !== 141) return null;
    const t = Number(notificationArguments(asNotification(row)).victimShipTypeID);
    if (!Number.isSafeInteger(t) || t <= 0) return null;
    void killShipMetaRev;
    if (!killShipMeta.has(t)) { killShipMeta.set(t, null); void flow.typeFacts([t]).then((m) => { killShipMeta.set(t, m?.get(t)?.metaGroupID ?? null); killShipMetaRev += 1; }).catch(() => {}); }
    return techLevelIcon(killShipMeta.get(t));
  }
  function killShipIcon(row: ActivityNotificationRow): string | null {
    if (row.typeID !== 140 && row.typeID !== 141) return null;
    const t = Number(notificationArguments(asNotification(row)).victimShipTypeID);
    return Number.isSafeInteger(t) && t > 0 ? typeIconUrl(t) : null;
  }
  function senderPicture(typeID: number | null, senderID: number | null | undefined): string | null {
    if (typeID === null || !DISPLAY_SENDER.has(typeID)) return null;
    const id = Number(senderID ?? 0);
    const server = flow.imageServer.get();
    if (isCharacter(id)) return portraitUrl(server, id, 128) ?? clientTexture(portraitDefaultPath(128));
    if (isCorporation(id)) return remoteImageUrl(server, "Corporation", id, 64, ".png") ?? clientTexture("res:/UI/Texture/silhouette_64.png");
    return clientTexture("res:/UI/Texture/silhouette_64.png");
  }
  function subtextOf(row: ActivityNotificationRow): string | null { return local.get(row.notificationID)?.subtext ?? null; }
  function subjectOf(row: ActivityNotificationRow): string {
    const own = local.get(row.notificationID);
    if (own) return own.subject;
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
  // notificationSettingHandler: popups (GetPopupsEnabled True), sound (GetNotificationSoundEnabled True), the fade
  // delay (GetFadeTime 5) and stack size (GetStackSize 3), the wanted expand directions (left / up), and the history
  // cleared up to a time (ClearHistory: lastHistoryCleanTime = the last seen time; UnClearHistory: 0) - here localStorage
  const SETTINGS_KEY = "evejs.play.notificationSettings";
  interface FeedSettings { popups: boolean; sound: boolean; fade: number; stack: number; h: "left" | "right"; v: "up" | "down"; cleared: string;
    /** Per type, where not the default (showAtAll / showPopup both True): [shown in the history, popped up]. */
    types: Record<string, [boolean, boolean]> }
  const DEFAULT_SETTINGS: FeedSettings = { popups: true, sound: true, fade: 5, stack: 3, h: "left", v: "up", cleared: "0", types: {} };
  let settings = $state<FeedSettings>((() => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") }; } catch { return { ...DEFAULT_SETTINGS }; } })());
  function saveSettings(): void { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* kept this session */ } }
  const clearedAt = $derived(BigInt(settings.cleared || "0"));
  /** GetUnwantedIds (showAtAll False): kept out of the history and the count. */
  const shownAtAll = (typeID: number | null | undefined) => typeID == null || settings.types[String(typeID)]?.[0] !== false;
  /** The type's showPopup. */
  const popsUp = (typeID: number | null | undefined) => typeID == null || settings.types[String(typeID)]?.[1] !== false;

  const rows = $derived.by(() => {
    if ($activity.notifications.status !== "ready") return [...localRows].filter((r) => (r.created ?? 0n) > clearedAt && shownAtAll(r.typeID)).sort((a, b) => Number((b.created ?? 0n) - (a.created ?? 0n)));
    return [...$activity.notifications.value, ...localRows].filter((r) => !closedIDs.has(r.notificationID) && (r.created ?? 0n) > clearedAt && shownAtAll(r.typeID))
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
  interface Popup { readonly id: number; readonly title: string; readonly detail: string | null; readonly typeID: number | null; readonly senderID: number | null;
    readonly action: (() => void) | null; outSince: number | null; fading: boolean; h: number }
  let popups = $state<Popup[]>([]);
  const queued: Popup[] = [];
  let popupSeq = 0;
  function showPopup(p: Popup): void {
    if (settings.sound) void playUiEvent("notify_beep3_play");
    p.outSince = Date.now();
    popups = [p, ...popups];
  }
  function closePopup(id: number): void {
    popups = popups.filter((p) => p.id !== id);
    const next = queued.pop();
    if (next) showPopup(next);
  }
  function addPopup(input: NoticeInput, ownType: number | null = null): void {
    const key = input.key ?? "";
    let typeID: number | null = ownType;
    let senderID: number | null = input.senderID ?? null;
    if (key.startsWith("notification:")) {
      const id = Number(key.slice(13));
      for (const n of store.live.get().notifications) {
        if (n.method !== "OnNotificationReceived" || !Array.isArray(n.args)) continue;
        const nid = unwrapLong(n.args[0]);
        if (nid !== null && Number(nid) === id) {
          const t = unwrapLong(n.args[1]); typeID = typeof n.args[1] === "number" ? n.args[1] : t === null ? null : Number(t);
          const s = unwrapLong(n.args[2]); senderID = typeof n.args[2] === "number" ? n.args[2] : s === null ? null : Number(s);
        }
      }
      // the server's history has it now: read again for the drawer
      void flow.loadActivity().catch(() => {});
    } else {
      // a notice of the page's making (a new mail - NewMailFrom 1004 -, the login mail summary): into the history, and so
      // into the count
      addLocalRow(typeID ?? (key.startsWith("mail:") ? 1004 : 0), input.title, input.detail ?? null, input.action ?? null, senderID ?? 0);
    }
    const p: Popup = { id: ++popupSeq, title: input.title, detail: input.detail ?? null, typeID: typeID ?? (key.startsWith("mail:") ? 1004 : null), senderID, action: input.action ?? null, outSince: null, fading: false, h: 50 };
    // MakeAndDisplayNormalNotification: the type's showPopup and the popups setting (a new mail is NewMailFrom 1004)
    if (!settings.popups || !popsUp(typeID ?? (key.startsWith("mail:") ? 1004 : null))) return;
    if (popups.length < settings.stack) showPopup(p); else queued.push(p);
  }
  $effect(() => watchNotificationPopups(store, flow, (id) => onOpen(id), (input) => addPopup(input)));
  // a notice the page makes of its own with a client type (skillsvc._TriggerSkillNotification: OnNewNotificationReceived
  // of a SKILL_NOTIFICATION_NORMAL 1000 notification) - into the history and the popups as the client's
  onMount(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ typeID: number; title: string; tab?: TabID }>).detail;
      if (!d) return;
      addPopup({ kind: "info", title: d.title, detail: null, key: `local:${d.typeID}:${Date.now()}`, action: d.tab ? () => onOpen(d.tab!) : null }, d.typeID);
    };
    addEventListener("evejs:client-notification", on);
    return () => removeEventListener("evejs:client-notification", on);
  });

  // mailSvc.GetMailPopupOnCharacterLogin: entering with unread mail (characterSelection.__Confirm, GetUnreaddMailCount > 0),
  // 3 s (CheckNewMessages_thread) and 7 s on, notificationSvc.MakeAndScatterNotification(MailSummary 1003,
  // numMails) - MailSummaryFormatter: subject UI/Mail/NewMailHeader, subtext UI/Mail/NewMails(numMails); a popup and
  // a count like any other, its click OpenMail. Once per session, the count from the character selection row.
  const MAIL_HEADER = "UI/Mail/NewMailHeader", NEW_MAILS = "UI/Mail/NewMails";
  onMount(() => {
    flow.requestWords([MAIL_HEADER, NEW_MAILS]);
    let tries = 0;
    const t = setInterval(() => {
      if (++tries < 10) return;
      const c = store.character.get();
      const me = c.characters.find((x) => x.characterID === c.selectedCharacterID);
      if (!me) { if (tries > 40) clearInterval(t); return; }
      clearInterval(t);
      const n = me.unreadMailCount ?? 0;
      if (n < 1) return;
      const title = plainText(word(MAIL_HEADER, "New Mail"));
      const detail = plainText(formatTemplate(word(NEW_MAILS, "You have {numMails} new mails"), { numMails: n }, { nameOf, ...intervalWriters($words.templates) }));
      addPopup({ kind: "info", title, detail, key: "mail-summary", action: () => onOpen("mail") }, 1003);
    }, 1000);
    return () => clearInterval(t);
  });
  $effect(() => {
    const t = setInterval(() => {
      const at = Date.now();
      for (const p of popups) {
        if (!p.fading && p.outSince !== null && at - p.outSince >= settings.fade * 1000) {
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
  /** clickInterruptedByDrag: the click that ends a drag does not open the drawer. */
  let dragEnded = false;
  function onWidgetClick() { if (dragEnded) { dragEnded = false; return; } if (open) closeDrawer(); else openDrawer(); }

  // The widget's place (notificationCenter LoadPositionValues / capWidgetPosition / DragMovable): its distance from the
  // right and the bottom of the screen (GetNotificationBadgeOffset, default (16, 16)), kept 0 .. the screen less 32;
  // the drawer, badge and popups hang from it. ExpandEvaluator / AlignmentTransitioner: it opens up and to the left as
  // wanted, down when the drawer would have under MIN_HISTORY_HEIGHT 100 above it (its height cut to fit either way),
  // right when 300 does not fit to its left.
  const OFFSET_KEY = "evejs.play.notificationFeedOffset";
  function loadOffset(): { x: number; y: number } {
    try { const v = JSON.parse(localStorage.getItem(OFFSET_KEY) ?? "null"); if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return v; } catch { /* default */ }
    return { x: 16, y: 16 };
  }
  let off = $state(loadOffset());
  let vw = $state(typeof window === "undefined" ? 1200 : window.innerWidth);
  let vh = $state(typeof window === "undefined" ? 800 : window.innerHeight);
  $effect(() => { const r = () => { vw = window.innerWidth; vh = window.innerHeight; }; window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); });
  const cx = $derived(Math.min(Math.max(0, off.x), vw - 32));
  const cy = $derived(Math.min(Math.max(0, off.y), vh - 32));
  /** actualX / actualY: the widget's right and bottom edges. */
  const ax = $derived(vw - cx);
  const ay = $derived(vh - cy);
  // the preferred height (GetPreferredHeight, default 400, kept MIN_HISTORY_HEIGHT 100 .. MAX 1000; the resize line
  // sets it 132 .. 1002 and saves it - here localStorage)
  const HEIGHT_KEY = "evejs.play.notificationFeedHeight";
  let prefH = $state((() => { try { const v = Number(localStorage.getItem(HEIGHT_KEY)); return v > 0 ? v : 400; } catch { return 400; } })());
  const upHeight = $derived(Math.min(prefH, vh - cy));
  const downHeight = $derived(prefH - Math.max(0, prefH + ay - vh));

  // _ConstructResizeLine: a 3 high invisible Line on the edge the drawer grows from (TOTOP opening up, TOBOTTOM down),
  // the up-down drag cursor, enabled once the drawer is filled; OnResizerDrag: the pointer's travel added to the
  // height at the press (inverted opening down), the auto-closer paused while it drags
  let resizing = $state(false);

  // OnSettingsClick: NotificationSettingsWindow.ToggleOpenClose - 660 x 400 (minimum the same), settings.png, the
  // caption Notification Settings; read from the live client (gridcheck g277 / g278): the category list on the left
  // (Category Subscriptions, EveLabelLarge, a list 358 wide - not on the page yet), on the right from 382: Pop-ups
  // (EveLabelLarge), Use Pop-up Notifications and Play Sound checkboxes (24 high), the Fade Delay (0 - 10 by 0.5) and
  // Stack Size (1 - 10) rows (EveLabelSmall label 120, value 30, slider 92), the Default H / V Expand combos (label 120,
  // 32 high, 8 apart), History (EveLabelLarge, 8 down) with Restore Notification History and Clear Notification History
  let settingsWin: PlayWindow | null = null;
  function toggleSettings(): void {
    if (settingsWin?.root.isConnected) { settingsWin.root.remove(); settingsWin = null; return; }
    const win = new PlayWindow({ id: "notification-settings", caption: "Notification Settings", icon: clientTexture("res:/UI/Texture/WindowIcons/settings.png"),
      left: Math.round(innerWidth / 2 - 330), top: Math.round(innerHeight / 2 - 200), width: 660, height: 400, minWidth: 660, minHeight: 400, chrome: "default" },
      () => { settingsWin = null; });
    settingsWin = win;
    win.body.classList.add("nf-set");
    const sel = (on: boolean) => (on ? " selected" : "");
    win.body.innerHTML = `<div class="nf-set-left"><div class="nf-set-head"><div class="nf-set-large">Category Subscriptions</div>
        <img class="nf-set-hicon" style="left: 294px" title="History visibility" alt="" src="${clientTexture("res:/UI/Texture/classes/Notifications/settingsVisibleIcon.png")}">
        <img class="nf-set-hicon" style="left: 318px" title="Popup visibility" alt="" src="${clientTexture("res:/UI/Texture/classes/Notifications/settingsPopupIcon.png")}"></div>
        <div class="nf-set-tree"></div></div>
      <div class="nf-set-right">
        <div class="nf-set-large">Pop-ups</div>
        <label class="nf-set-check" style="margin-top: 8px"><input type="checkbox" data-k="popups"${settings.popups ? " checked" : ""}><span>Use Pop-up Notifications</span></label>
        <label class="nf-set-check"><input type="checkbox" data-k="sound"${settings.sound ? " checked" : ""}><span>Play Sound</span></label>
        <div class="nf-set-slider" style="margin-top: 8px"><span>Fade Delay</span><b data-v="fade">${settings.fade}</b><input type="range" min="0" max="10" step="0.5" data-k="fade" value="${settings.fade}"></div>
        <div class="nf-set-slider"><span>Stack Size</span><b data-v="stack">${settings.stack}</b><input type="range" min="1" max="10" step="1" data-k="stack" value="${settings.stack}"></div>
        <label class="nf-set-combo" title="Horizontal expand direction"><span>Default H Expand</span><select data-k="h"><option value="left"${sel(settings.h === "left")}>Left</option><option value="right"${sel(settings.h === "right")}>Right</option></select></label>
        <label class="nf-set-combo" title="Vertical expand direction" style="margin-top: 8px"><span>Default V Expand</span><select data-k="v"><option value="up"${sel(settings.v === "up")}>Up</option><option value="down"${sel(settings.v === "down")}>Down</option></select></label>
        <div class="nf-set-large" style="margin-top: 16px">History</div>
        <button type="button" class="nf-set-btn" data-act="restore">Restore Notification History</button>
        <button type="button" class="nf-set-btn" data-act="clear">Clear Notification History</button>
      </div>`;
    for (const el of win.body.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-k]")) {
      const k = el.dataset.k as keyof FeedSettings;
      const apply = () => {
        if (el instanceof HTMLInputElement && el.type === "checkbox") (settings as unknown as Record<string, unknown>)[k] = el.checked;
        else if (el instanceof HTMLInputElement) { (settings as unknown as Record<string, unknown>)[k] = Number(el.value); const v = win.body.querySelector<HTMLElement>(`[data-v="${k}"]`); if (v) v.textContent = el.value; }
        else (settings as unknown as Record<string, unknown>)[k] = el.value;
        saveSettings();
      };
      el.addEventListener(el instanceof HTMLInputElement && el.type === "range" ? "input" : "change", apply);
    }
    win.body.querySelector("[data-act=clear]")!.addEventListener("click", () => {
      // ClearHistory: hidden up to the last seen time
      settings.cleared = String(seen); saveSettings();
    });
    win.body.querySelector("[data-act=restore]")!.addEventListener("click", () => { settings.cleared = "0"; saveSettings(); });
    // NotificationSettingList: the groups sorted by their words, each a TreeViewSettingsItem (24 high; the expander -
    // arrowDown.png turned a quarter, LED_GREY, padded 4 / 5 in a 16 box at the right of a 24 spacer, turned back over
    // 0.15 s when open; the label 4 past it), collapsed; its types under it sorted likewise, their labels at 36
    // ((1 + level) x LEFTPUSH 8 + 16 + LABEL_PADDING 4); on each row the history and popup checkboxes (24 wide, a 16
    // diode) at 294 and 318 (the live client, g279), their hints Toggle History Visibility / Toggle Popup for
    // Notification; a group's checkbox sets every type under it; a group is checked while all of its types are
    const tree = win.body.querySelector<HTMLElement>(".nf-set-tree")!;
    const setting = (t: number) => settings.types[String(t)] ?? [true, true];
    const setType = (t: number, which: 0 | 1, on: boolean) => {
      const next = [...setting(t)] as [boolean, boolean];
      next[which] = on;
      if (next[0] && next[1]) delete settings.types[String(t)]; else settings.types[String(t)] = next;
    };
    const arrow = clientTexture("res:/UI/Texture/classes/Neocom/arrowDown.png");
    const groups = [...NOTIFICATION_GROUPS].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const drawTree = () => {
      const open = new Set([...tree.querySelectorAll<HTMLElement>(".nf-set-group.open")].map((g) => g.dataset.g));
      tree.innerHTML = groups.map((g) => {
        const kids = [...g.types].sort((a, b) => a[1].toLowerCase().localeCompare(b[1].toLowerCase()));
        const all = (w: 0 | 1) => kids.every(([t]) => setting(t)[w]);
        const isOpen = open.has(String(g.id));
        return `<div class="nf-set-group${isOpen ? " open" : ""}" data-g="${g.id}">
          <div class="nf-set-row"><span class="nf-set-tog"><img alt="" src="${arrow}"></span><span class="nf-set-label" style="left: 28px">${g.name.replace(/</g, "&lt;")}</span>
            <input type="checkbox" class="nf-set-cb" style="left: 298px" title="Toggle History Visibility" data-group="${g.id}" data-w="0"${all(0) ? " checked" : ""}>
            <input type="checkbox" class="nf-set-cb" style="left: 322px" title="Toggle Popup for Notification" data-group="${g.id}" data-w="1"${all(1) ? " checked" : ""}></div>
          <div class="nf-set-kids">${kids.map(([t, label]) => `<div class="nf-set-row"><span class="nf-set-label" style="left: 36px">${label.replace(/</g, "&lt;")}</span>
            <input type="checkbox" class="nf-set-cb" style="left: 298px" title="Toggle History Visibility" data-type="${t}" data-w="0"${setting(t)[0] ? " checked" : ""}>
            <input type="checkbox" class="nf-set-cb" style="left: 322px" title="Toggle Popup for Notification" data-type="${t}" data-w="1"${setting(t)[1] ? " checked" : ""}></div>`).join("")}</div>
        </div>`;
      }).join("");
    };
    drawTree();
    tree.addEventListener("click", (e) => {
      const tog = (e.target as HTMLElement).closest(".nf-set-row");
      if (!tog || (e.target as HTMLElement).closest("input")) return;
      const group = tog.parentElement;
      if (group?.classList.contains("nf-set-group")) group.classList.toggle("open");
    });
    tree.addEventListener("change", (e) => {
      const cb = e.target as HTMLInputElement;
      const w = Number(cb.dataset.w) as 0 | 1;
      if (cb.dataset.group) {
        const g = NOTIFICATION_GROUPS.find((x) => String(x.id) === cb.dataset.group);
        for (const [t] of g?.types ?? []) setType(t, w, cb.checked);
      } else if (cb.dataset.type) setType(Number(cb.dataset.type), w, cb.checked);
      settings.types = { ...settings.types };
      saveSettings();
      drawTree();
    });
    (document.querySelector(".pw")?.parentElement ?? document.body).append(win.root);
  }
  function resizeDown(e: PointerEvent): void {
    if (e.button !== 0 || !filled) return;
    e.preventDefault();
    resizing = true;
    const y0 = e.clientY, h0 = drawerHeight;
    const move = (m: PointerEvent) => {
      const diff = goesUp ? y0 - m.clientY : m.clientY - y0;
      prefH = Math.min(Math.max(h0 + diff, 100 + 32), 1000 + 2);
      queueMicrotask(updateBar);
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      resizing = false;
      outSince = null;
      try { localStorage.setItem(HEIGHT_KEY, String(prefH)); } catch { /* kept for this session */ }
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }
  // AlignmentTransitioner: the wanted direction where it can, the other where not
  const goesUp = $derived(settings.v === "up" ? (upHeight >= 100 || downHeight < 100) : !(downHeight >= 100 || upHeight < 100));
  const goesLeft = $derived(settings.h === "left" ? ax - 300 > 0 : !(ax + 300 < vw));
  const ptr = $derived(clientTexture(goesLeft ? "res:/UI/Texture/classes/Notifications/pointer_right_02.png" : "res:/UI/Texture/classes/Notifications/pointer_left_02.png"));
  const drawerHeight = $derived(goesUp ? upHeight : downHeight);
  const boxStyle = $derived([
    goesLeft ? `right: ${cx}px` : `left: ${ax - 32}px`,
    goesUp ? `bottom: ${cy}px` : `top: ${ay - 32}px`,
    open ? `height: ${drawerHeight}px` : "",
  ].join("; "));
  // _AutoPositionBadgeContainer: 6 down the widget's side, 2 to its left pointing right, or past its right pointing left
  const badgeStyle = $derived(goesLeft ? `right: ${cx + 34}px; top: ${ay - 32 + 6}px` : `left: ${ax + 12}px; top: ${ay - 32 + 6}px`);
  // _AutoPositionStackFader: the stack 300 wide on the widget's right edge (left edge when it opens right), going up from
  // 5 above it or down from 5 under it
  const stackStyle = $derived([
    goesLeft ? `right: ${cx}px` : `left: ${ax - 32}px`,
    goesUp ? `bottom: ${cy + 32 + 5}px` : `top: ${ay + 5}px`,
  ].join("; "));

  // DragMovable: a press held 300 ms with under 5 px of movement starts the drag (not while the drawer is open); the
  // widget grows to 1.25 over 0.25 s (ANIM_SMOOTH) and follows the pointer, back to 1 on release, the place saved
  let dragging = $state(false);
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  function widgetDown(e: PointerEvent): void {
    if (e.button !== 0 || open || animating) return;
    const x0 = e.clientX, y0 = e.clientY;
    let lastX = x0, lastY = y0;
    const track = (m: PointerEvent) => { lastX = m.clientX; lastY = m.clientY; };
    const btn = e.currentTarget as HTMLElement;
    window.addEventListener("pointermove", track, true);
    const cancel = () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = null; window.removeEventListener("pointermove", track, true); window.removeEventListener("pointerup", cancel, true); };
    window.addEventListener("pointerup", cancel, true);
    pressTimer = setTimeout(() => {
      cancel();
      if (Math.abs(x0 - lastX) + Math.abs(y0 - lastY) >= 5) return;
      hideLabelShortcutTooltip();
      dragging = true;
      const start = { x: cx, y: cy };
      const move = (m: PointerEvent) => { off = { x: start.x + (x0 - m.clientX), y: start.y + (y0 - m.clientY) }; };
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        dragging = false;
        dragEnded = true;
        setTimeout(() => { dragEnded = false; }, 0);
        off = { x: cx, y: cy };
        try { localStorage.setItem(OFFSET_KEY, JSON.stringify(off)); } catch { /* the place is kept for this session */ }
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
      void btn;
    }, 300);
  }

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
    watch = setInterval(() => { now = Date.now(); if (!resizing && outSince !== null && Date.now() - outSince >= 1000) closeDrawer(); }, 100);
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
<div class="nf-badge" class:shown={unread > 0 && !open && !dragging} class:right={!goesLeft} style={badgeStyle}>
  <span class="nf-badge-bg" style={`-webkit-mask-box-image: url("${clientTexture("res:/UI/Texture/classes/Notifications/newItemsBadgeBase.png")}") 10 / 10px`}></span>
  <span class="nf-badge-ptr" style={`-webkit-mask-image: url("${ptr}"); mask-image: url("${ptr}")`}></span>
  <span class="nf-badge-n">{unread}</span>
</div>
<div class="nf-popups" class:down={!goesUp} style={stackStyle}>
  {#each popups as p, i (p.id)}
    {@const icon = p.typeID === null ? null : notificationIconPath(p.typeID)}
    {@const face = senderPicture(p.typeID, p.senderID)}
    <div class="nf-entry nf-popup" class:fading={p.fading} role="listitem" bind:offsetHeight={p.h}
      style:bottom={goesUp ? `${popups.slice(0, i).reduce((y, q) => y + q.h + 5, 0)}px` : null}
      style:top={goesUp ? null : `${popups.slice(0, i).reduce((y, q) => y + q.h + 5, 0)}px`}
      style={`border-image-source: url("${clientTexture(p.outSince === null ? "res:/UI/Texture/classes/Notifications/historyBackReadOver.png" : "res:/UI/Texture/classes/Notifications/historyBackReadUp.png")}")`}
      onmouseenter={() => { if (!p.fading) { p.outSince = null; popups = [...popups]; void playUiEvent("ui_button_soft2_play"); } }}
      onmouseleave={() => { p.outSince = Date.now(); popups = [...popups]; }}
      onclick={(e) => { if (!(e.target as HTMLElement).closest(".nf-close")) { void playUiEvent("ui_button_soft4_play"); p.action?.(); } }}>
      <span class="nf-blink" style={`background-image: url("${clientTexture("res:/UI/Texture/classes/Neocom/buttonBlink.png")}")`}></span>
      {#if icon}<img class="nf-icon" alt="" src={clientTexture(icon)} />{/if}
      {#if face}<img class="nf-icon nf-face" alt="" src={face} />{/if}
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
<div class="nf" class:open class:resizing class:dragging class:right={!goesLeft} class:down={!goesUp} bind:this={root} style={boxStyle}>
  {#if filled}<div class="nf-resize" role="separator" aria-orientation="horizontal" onpointerdown={resizeDown}></div>{/if}
  <div class="nf-header" class:shown={open}>{word(HISTORY_CAPTION, "Notification History")}</div>
  <div class="nf-list" bind:this={list} onscroll={updateBar}>
    {#if filled}
      {#each rows as row (row.notificationID)}
        {@const icon = notificationIconPath(row.typeID ?? 0)}
        {@const face = senderPicture(row.typeID ?? null, row.senderID)}
        {@const ship = killShipIcon(row)}
        {@const shipTech = killShipTech(row)}
        <div class="nf-entry" role="listitem"
          style={`border-image-source: url("${clientTexture(hovered === row.notificationID ? "res:/UI/Texture/classes/Notifications/historyBackReadOver.png" : "res:/UI/Texture/classes/Notifications/historyBackReadUp.png")}")`}
          onmouseenter={() => { hovered = row.notificationID; void playUiEvent("ui_button_soft2_play"); }}
          onmouseleave={() => { if (hovered === row.notificationID) hovered = null; }}
          onclick={(e) => { if (!(e.target as HTMLElement).closest(".nf-close")) entryClick(row); }}>
          {#if icon}<img class="nf-icon" alt="" src={clientTexture(icon)} />{/if}
          {#if face}<img class="nf-icon nf-face" alt="" src={face} />{/if}
          {#if ship}<img class="nf-icon nf-ship" alt="" src={ship} />{/if}
          {#if shipTech}<img class="nf-tech" alt="" title={shipTech.hint} src={clientTexture(shipTech.path)} />{/if}
          <div class="nf-text">
            <div class="nf-subject">{subjectOf(row)}</div>
            {#if subtextOf(row)}<div class="nf-subtext">{subtextOf(row)}</div>{/if}
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
    <!-- _ConstructSettingsButton: a ButtonIcon 24 (77_32_30.png), its hint Notification Settings, OnSettingsClick -->
    <button class="nf-settings" class:shown={filled} aria-label="Notification Settings" onclick={toggleSettings}
      onmouseenter={(e) => { const el = e.currentTarget; tooltipDue(el, () => showLabelShortcutTooltip(el, "", "", ["Notification Settings"], "top", true)); }}
      onmouseleave={() => hideLabelShortcutTooltip()}>
      <img alt="" src={clientTexture("res:/UI/Texture/Icons/77_32_30.png")} />
    </button>
    <button class="nf-widget" aria-label="Notification Feed" onclick={onWidgetClick} onpointerdown={widgetDown}
      onmouseenter={(e) => { if (open || dragging) return; const el = e.currentTarget; tooltipDue(el, () => showLabelShortcutTooltip(el, "Notification Feed", "", ["", "Click, hold and drag to reposition notifications feed"], "top", "wrap")); }}
      onmouseleave={() => hideLabelShortcutTooltip()}>
      <img alt="" src={clientTexture("res:/UI/Texture/classes/Notifications/widgetIcon.png")} />
    </button>
  </div>
</div>

<style>
  /* WindowUnderlay: the blurred scene under a 0.1 white frame; the container grows from the widget's right and bottom */
  .nf { position: fixed; width: 32px; height: 32px; z-index: 25; overflow: hidden; box-sizing: border-box;
    background: var(--win-bg, rgba(14, 16, 18, 0.88)); backdrop-filter: var(--win-backdrop, blur(6px)); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
    transition: width 0.25s, height 0.25s, transform 0.25s cubic-bezier(0.3333, 0, 0.6667, 1); font: 14px 'EVE Sans Neue', 'Segoe UI', sans-serif; color: rgba(255, 255, 255, 0.75); }
  .nf.open { width: 300px; height: 400px; }
  .nf.dragging { transform: scale(1.25); }
  .nf-resize { position: absolute; left: 0; right: 0; top: 0; height: 3px; cursor: ns-resize; z-index: 1; }
  .nf.down .nf-resize { top: auto; bottom: 0; }
  .nf.resizing { transition: none; }
  /* _ConstructControlContainer / _ConstructSettingsButton / _ConstructScroll by the alignment: opening right, the widget
     at the left (TOLEFT) and the settings at the right (TORIGHT); opening down, the strip at the top (TOTOP, pulled up
     over the header's 22) and the list under it, 5 from the foot (NOTIFICATION_CENTER_PADDING_H) */
  .nf.right .nf-widget { right: auto; left: 0; }
  .nf.right .nf-settings { left: auto; right: 5px; }
  .nf.down .nf-strip { bottom: auto; top: 0; }
  .nf.down .nf-list { top: 32px; bottom: 5px; }
  .nf-header { position: absolute; left: 0; right: 0; top: 4px; height: 18px; line-height: 18px; text-align: center; font-size: 12px; font-weight: bold;
    white-space: nowrap; opacity: 0; transition: opacity 0.25s; pointer-events: none; }
  .nf-header.shown { opacity: 1; }
  /* PushDisplayedItems: each shown popup moved over 0.5 s (MoveTo, ANIM_SMOOTH) to its slot, the newest at the foot */
  .nf-popups { position: fixed; width: 300px; height: 0; z-index: 25; pointer-events: none;
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
  .nf-badge { position: fixed; height: 20px; z-index: 25; pointer-events: none; opacity: 0; transition: opacity 0.25s;
    font: bold 14px/18px 'EVE Sans Neue', 'Segoe UI', sans-serif; color: rgba(255, 255, 255, 0.75); }
  .nf-badge.shown { opacity: 1; }
  .nf-badge-bg { position: absolute; inset: -6px; background: var(--theme-focus-glow, #ccf3ff); opacity: 0.95; }
  .nf-badge.right .nf-badge-ptr { left: -16px; right: auto; }
  .nf-badge-ptr { position: absolute; right: -16px; top: -2px; width: 24px; height: 24px; background: var(--theme-focus-glow, #ccf3ff); opacity: 0.95;
    -webkit-mask-size: 24px 24px; mask-size: 24px 24px; }
  .nf-badge-n { position: relative; display: block; padding: 1px 5px; }
  .nf-list { position: absolute; left: 5px; right: 5px; top: 22px; bottom: 32px; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
  .nf-bar { position: absolute; left: 287px; width: 8px; cursor: default; }
  .nf-bar i { position: absolute; left: 3px; top: 3px; bottom: 3px; width: 2px; background: rgba(255, 255, 255, 0.25); }
  .nf:has(.nf-list:hover) .nf-bar i { background: color-mix(in srgb, var(--theme-focus-dark, #305665) 60%, transparent); }
  .nf-bar:hover i { left: 2px; width: 4px; background: var(--theme-focus, #58a7bf); }
  /* UpdateNotificationEntryHeight: max(MINENTRYHEIGHT 50, 5 + the subject + the subtext + 5 + the time line + 5) */
  .nf-entry { position: relative; min-height: 50px; cursor: pointer; border-style: solid; border-width: 0; box-sizing: border-box;
    border-image-slice: 6 fill; border-image-width: 6px; border-image-outset: 5px; }
  .nf-icon { position: absolute; left: 5px; top: 5px; width: 40px; height: 40px; }
  .nf-tech { position: absolute; left: 5px; top: 5px; width: 16px; height: 16px; max-width: none; }
  .nf-text { position: relative; margin-left: 55px; padding: 5px 0; width: 224px; }
  .nf-subject { font-weight: bold; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nf-subtext { line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nf-time { margin-top: 5px; font-size: 12px; line-height: 16px; color: rgb(128, 128, 128); }
  .nf-close { position: absolute; right: 2px; top: 2px; width: 16px; height: 16px; padding: 0; margin: 0; border: 0; background: none; cursor: pointer;
    opacity: 0; transition: opacity 0.2s; }
  .nf-close img { display: block; width: 16px; height: 16px; opacity: 0.75; }
  .nf-entry:hover .nf-close { opacity: 1; }
  .nf-strip { position: absolute; left: 0; right: 0; bottom: 0; height: 32px; }
  .nf-settings { position: absolute; left: 5px; top: 4px; width: 24px; height: 24px; padding: 0; margin: 0; border: 0; background: none; cursor: pointer;
    opacity: 0; transition: opacity 0.25s; pointer-events: none; display: block; line-height: 0; min-width: 0; min-height: 0; }
  .nf-settings img { width: 24px; height: 24px; max-width: none; opacity: 0.75; }
  .nf-settings:hover img { opacity: 1; }
  .nf-settings.shown { opacity: 1; pointer-events: auto; }
  :global(.pw-body.nf-set) { position: relative; font: 14px 'EVE Sans Neue', 'Segoe UI', sans-serif; color: rgba(255, 255, 255, 0.75); }
  :global(.nf-set .nf-set-left) { position: absolute; left: 0; top: 0; bottom: 0; width: 358px; display: flex; flex-direction: column; }
  :global(.nf-set .nf-set-head) { position: relative; height: 21px; margin-bottom: 8px; flex: none; }
  :global(.nf-set .nf-set-hicon) { position: absolute; top: 3px; width: 16px; height: 16px; }
  :global(.nf-set .nf-set-tree) { flex: 1; overflow-y: auto; overflow-x: hidden; }
  :global(.nf-set .nf-set-row) { position: relative; height: 24px; width: 342px; cursor: default; }
  :global(.nf-set .nf-set-row:hover) { background: rgba(255, 255, 255, 0.05); }
  :global(.nf-set .nf-set-label) { position: absolute; top: 3px; line-height: 18px; right: 66px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  :global(.nf-set .nf-set-tog) { position: absolute; left: 8px; top: 4px; width: 16px; height: 16px; cursor: pointer; }
  :global(.nf-set .nf-set-tog img) { position: absolute; left: 4px; top: 4px; width: 7px; height: 7px; transform: rotate(90deg); transition: transform 0.15s;
    filter: brightness(0.54); }
  :global(.nf-set .nf-set-group.open .nf-set-tog img) { transform: none; }
  :global(.nf-set .nf-set-kids) { display: none; }
  :global(.nf-set .nf-set-group.open .nf-set-kids) { display: block; }
  :global(.nf-set input.nf-set-cb) { position: absolute; top: 4px; width: 16px; height: 16px; min-height: 0; margin: 0; padding: 0; box-sizing: border-box; }
  :global(.nf-set .nf-set-right) { position: absolute; left: 382px; top: 0; width: 242px; display: flex; flex-direction: column; }
  :global(.nf-set .nf-set-large) { font-size: 16px; line-height: 21px; }
  :global(.nf-set .nf-set-check) { display: flex; align-items: center; gap: 8px; height: 24px; }
  :global(.nf-set .nf-set-check input) { width: 16px; height: 16px; margin: 0; }
  :global(.nf-set .nf-set-slider) { display: grid; grid-template-columns: 120px 30px 92px; align-items: center; height: 24px; font-size: 12px; }
  :global(.nf-set .nf-set-slider b) { font-weight: normal; }
  :global(.nf-set .nf-set-slider input) { width: 92px; margin: 0; }
  :global(.nf-set .nf-set-combo) { display: grid; grid-template-columns: 120px 122px; align-items: center; height: 32px; }
  :global(.nf-set .nf-set-btn) { align-self: center; margin-top: 8px; height: 32px; padding: 0 16px; }
  .nf-widget { position: absolute; right: 0; bottom: 0; width: 32px; height: 32px; padding: 0; margin: 0; border: 0; background: none; cursor: pointer;
    display: block; line-height: 0; min-width: 0; min-height: 0; }
  .nf-widget img { width: 32px; height: 32px; max-width: none; opacity: 0.75; pointer-events: none; }
  .nf-widget:hover img { opacity: 1; }
</style>
