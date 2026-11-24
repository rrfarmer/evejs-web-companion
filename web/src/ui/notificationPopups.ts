// The client's notification popups, in the page's flash (item 81's left parts).
//
// The retail client pops up each notification as it arrives: notificationSvc.OnNotificationReceived (403 to 416)
// formats it (FormatNotifications) and scatters OnNewNotificationReceived, and the notification centre shows it
// (notificationUI.OnNewNotificationReceived, then notificationCenter.MakeAndDisplayNormalNotification, 273 to 291:
// every type pops up unless the player turned it off, its settings' default showPopup True), the popup carrying
// the subject, bold, and the subtext where there is one (notificationEntry.py _CreateNotificationText). Two types
// it keeps back until a clone is activated (delayedNotificationsByID: CloneActivationMsg 15 and 138).
//
// A new mail is told the same way, by the client itself: mailSvc.OnMailSent (1119 to 1153) takes a mail not held
// in and, where it is not read (a mail of the pilot's own to others only is), calls OnNewMailReceived, which pops
// it up where the mail settings let it (MAIL_SHOW_POPUP, default True: 1197 to 1206) through GetMailNotification
// (1212 to 1219) and NewMailFormatter: the subject "UI/Mail/NewMailHeader", the subtext "UI/Mail/From" and the
// sender's name (a mailing list's own mail by the list's name, 1139 to 1140).
//
// Here each lands in the page's flash (notices.ts notify) once its words and names are to hand, or after a few
// seconds with what is had and the page's own word for what is not. Mounted once per workspace, beside the
// NoticeBridge.
//
// A click on one does what the client's does (notificationCenter.GetNotificationAction and OnEntryClick, 304 to
// 410): a new mail opens the mail (mailSvc.OnOpenPopupMail); corporation recipient
// types139/18/17/142 open MY_APPLICATIONS (356-362). Other implemented types open
// the mail window's notifications on their group (MailInteractor.SelectByNotificationID).

import { notificationTitle } from "../bridge/activity.ts";
import { plainText } from "../bridge/clientWords.ts";
import { notificationSubjectWording } from "../bridge/notificationFormats.ts";
import type { Notification } from "../bridge/notifications.ts";
import type { JsonValue } from "../bridge/wire.ts";
import { unwrapLong } from "../bridge/wire.ts";
import type { AppFlow } from "../app/flow.ts";
import type { ClientStore } from "../store/clientStore.ts";
import { resolvedName, type NameRef } from "../store/names.ts";
import type { LiveNotification } from "../store/types.ts";
import { focusMail } from "./mailFocus.ts";
import { corporationApplicationNotification } from "../bridge/corporationApplications.ts";
import { notify, type NoticeInput } from "./notices.ts";
import type { TabID } from "./tabs.ts";

/** delayedNotificationsByID's types (notificationSvc.py 37 to 38): CloneActivationMsg and CloneActivationMsg2. */
const DELAYED_TYPES: ReadonlySet<number> = new Set([15, 138]);
/** const.mailStatusMaskAutomated (appConst.py 1776): a mailing list's own mail. */
const MAIL_STATUS_AUTOMATED = 32;
/** How long a popup waits for its words and names before it shows with what is had. */
const WORDS_WAIT_MS = 4000;
const WORDS = { newMail: "UI/Mail/NewMailHeader", from: "UI/Mail/From" } as const;

type Post = (input: NoticeInput) => unknown;

const numberOf = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const long = unwrapLong(value);
  return long === null ? null : Number(long);
};

/** Watches the live channel for notifications and new mail and pops each up as the client does. */
export function watchNotificationPopups(store: ClientStore, flow: AppFlow, open: (id: TabID) => void, post: Post = notify): () => void {
  const seen = new WeakSet<object>();
  let first = true;
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const stops = new Set<() => void>();

  const templates = () => store.words.get().templates;
  const nameOf = (kind: Parameters<typeof resolvedName>[1], id: number) => resolvedName(store.names.get().resolved, kind, id, "");

  /** `compute` once its words and names are to hand (asking for them), or with what is had after a while. */
  function whenReady<T>(compute: () => { readonly value: T; readonly ready: boolean }, ask: () => void, done: (value: T) => void): void {
    const now = compute();
    if (now.ready) {
      done(now.value);
      return;
    }
    ask();
    let finished = false;
    let stopWords = () => {};
    let stopNames = () => {};
    const finish = (value: T) => {
      if (finished) return;
      finished = true;
      stopWords();
      stopNames();
      stops.delete(stopAll);
      clearTimeout(timer);
      timers.delete(timer);
      if (!stopped) done(value);
    };
    const check = () => {
      const later = compute();
      if (later.ready) finish(later.value);
    };
    const stopAll = () => {
      finished = true;
      stopWords();
      stopNames();
    };
    const timer = setTimeout(() => finish(compute().value), WORDS_WAIT_MS);
    timers.add(timer);
    stops.add(stopAll);
    // A subscription answers at once; one that finished it there is undone as soon as it is had.
    stopWords = store.words.subscribe(check);
    if (finished) stopWords();
    stopNames = store.names.subscribe(check);
    if (finished) stopNames();
  }

  // notificationSvc.OnNotificationReceived(notificationID, typeID, senderID, created, data={}).
  function popNotification(args: readonly unknown[]): void {
    const notificationID = numberOf(args[0]);
    const typeID = numberOf(args[1]);
    if (notificationID === null || typeID === null || DELAYED_TYPES.has(typeID)) return;
    const created = unwrapLong(args[3]);
    const notification: Notification = {
      notificationID,
      typeID,
      senderID: numberOf(args[2]) ?? 0,
      receiverID: store.station.get().online?.characterID ?? 0,
      processed: false,
      created,
      data: (args[4] ?? null) as JsonValue | null,
    };
    const action = () => {
      if (corporationApplicationNotification(typeID)) {
        if (store.station.get().online?.characterID !== notification.receiverID) return;
        flow.requestCorporationApplications();
        open("corporation");
        return;
      }
      open("mail");
      focusMail({ kind: "notification", notificationID, typeID });
    };
    void flow.notificationFormats().then((formats) => {
      if (stopped) return;
      const fallback = notificationTitle(typeID);
      if (formats === null) {
        post({ kind: "info", title: fallback, key: `notification:${notificationID}`, action });
        return;
      }
      const wording = () => notificationSubjectWording(notification, formats, templates(), nameOf);
      whenReady(
        () => {
          const subject = wording().subject;
          return { value: subject ?? fallback, ready: subject !== null };
        },
        () => {
          const asked = wording();
          if (asked.labels.length > 0) flow.requestWords(asked.labels);
          if (asked.refs.length > 0) flow.requestNames(asked.refs);
        },
        (title) => post({ kind: "info", title, key: `notification:${notificationID}`, action }),
      );
    });
  }

  // mailSvc.OnMailSent(messageID, senderID, sentDate, toCharacterIDs, toListID, toCorpOrAllianceID, title, statusMask).
  function popMail(args: readonly unknown[]): void {
    const messageID = numberOf(args[0]);
    const senderID = numberOf(args[1]);
    if (messageID === null || senderID === null) return;
    const mail = store.mail.get();
    // A mail held already is not taken in again (1122 to 1123), nor told.
    if (mail.messages.some((header) => header.messageID === messageID)) return;
    const me = store.station.get().online?.characterID ?? 0;
    const toCharacterIDs = (Array.isArray(args[3]) ? args[3] : (args[3] as { items?: unknown[] } | null)?.items ?? []).map(numberOf);
    const toListID = numberOf(args[4]);
    const toCorpOrAllianceID = numberOf(args[5]);
    const statusMask = numberOf(args[7]) ?? 0;
    // Read (1124 to 1131): the pilot's own mail that went to no one but others.
    const read = senderID === me && !toCharacterIDs.includes(me) && toCorpOrAllianceID === null && toListID === null;
    if (read) return;
    const listsName = (): string | null => {
      if ((statusMask & MAIL_STATUS_AUTOMATED) === 0 || senderID !== toListID) return null;
      const found = [...(mail.lists ?? []), ...mail.externalLists].find((list) => list.listID === toListID);
      return found?.displayName ?? null;
    };
    const senderRef: NameRef = { kind: "owner", id: senderID };
    whenReady(
      () => {
        const header = templates()[WORDS.newMail];
        const from = templates()[WORDS.from];
        const name = listsName() ?? nameOf("owner", senderID);
        const ready = typeof header === "string" && typeof from === "string" && name !== "";
        const title = typeof header === "string" ? plainText(header) : "New mail";
        const detail = `${typeof from === "string" ? plainText(from) : "From"}: ${name !== "" ? name : "someone"}`;
        return { value: { title, detail }, ready };
      },
      () => {
        flow.requestWords(Object.values(WORDS));
        if (listsName() === null) flow.requestNames([senderRef]);
      },
      ({ title, detail }) => post({
        kind: "info",
        title,
        detail,
        key: `mail:${messageID}`,
        senderID,
        action: () => {
          open("mail");
          focusMail({ kind: "mail", messageID });
        },
      }),
    );
  }

  const unsubscribe = store.live.subscribe((live) => {
    if (first) {
      for (const each of live.notifications) seen.add(each);
      first = false;
      return;
    }
    for (const notification of live.notifications as readonly LiveNotification[]) {
      if (seen.has(notification)) continue;
      seen.add(notification);
      if (notification.method === "OnNotificationReceived") popNotification(notification.args);
      else if (notification.method === "OnMailSent") popMail(notification.args);
    }
  });

  return () => {
    stopped = true;
    unsubscribe();
    for (const stop of stops) stop();
    for (const timer of timers) clearTimeout(timer);
  };
}
