// Notifications the page makes as the client's services do (skillsvc's skill notifications: OnNewNotificationReceived
// of a Notification of the client's own), for the notification feed. Kept until the feed takes them: one made as the
// pilot enters (OnLogonSkillsTrained comes with the select answer) can come before the feed is on the page.
import type { TabID } from "./tabs.ts";

export interface ClientNotification {
  readonly typeID: number;
  readonly title: string;
  readonly tab?: TabID;
}

const waiting: ClientNotification[] = [];
let taker: ((n: ClientNotification) => void) | null = null;

/** OnNewNotificationReceived of one the page made. */
export function raiseClientNotification(n: ClientNotification): void {
  if (taker) taker(n);
  else waiting.push(n);
}

/** The feed takes them: those waiting at once, the rest as they come. Returns the release. */
export function takeClientNotifications(take: (n: ClientNotification) => void): () => void {
  taker = take;
  for (const n of waiting.splice(0)) take(n);
  return () => { if (taker === take) taker = null; };
}
