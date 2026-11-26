import type { Session } from "./sessions.ts";
import { setSessionToken } from "./sessionToken.ts";

/** A page borrows the signed-in pilots' tokens. It never selects or logs out a pilot. */
export interface PluginPagePilot {
  readonly accountName: string;
  readonly characterID: number;
  readonly token: string;
}

export interface PluginPageProps {
  readonly sessions: readonly PluginPagePilot[];
  readonly activeSession: PluginPagePilot | null;
}

export const emptyPageRoster: PluginPageProps = { sessions: [], activeSession: null };

const prefix = "wc-plugin-page:";
const launchKey = "wc-plugin-page-launch:v1";
const validLink = /^[0-9a-f]{32}$/;
let readRoster = () => emptyPageRoster;
let source: { id: string; channel: BroadcastChannel; close(): void } | undefined;

function pageRoster(sessions: readonly Session[], activeId: string | null): PluginPageProps {
  const pilots: PluginPagePilot[] = [];
  let activeSession: PluginPagePilot | null = null;
  for (const session of sessions) {
    const state = session.store.get();
    const token = session.flow.sessionToken();
    if (!token || !state.session.username || !state.station.online) continue;
    const pilot = { accountName: state.session.username, characterID: state.station.online.characterID, token };
    pilots.push(pilot);
    if (session.id === activeId) activeSession = pilot;
  }
  return { sessions: pilots, activeSession };
}

export function sharePageRoster(sessions: readonly Session[], activeId: string | null): void {
  readRoster = () => pageRoster(sessions, activeId);
  source?.channel.postMessage(readRoster());
}

function isPilot(value: unknown): value is PluginPagePilot {
  if (!value || typeof value !== "object") return false;
  const pilot = value as Partial<PluginPagePilot>;
  return typeof pilot.accountName === "string" && pilot.accountName.trim().length > 0 &&
    typeof pilot.characterID === "number" && Number.isSafeInteger(pilot.characterID) && pilot.characterID > 0 &&
    typeof pilot.token === "string" && pilot.token.trim().length > 0;
}

function validRoster(value: unknown): value is PluginPageProps {
  if (!value || typeof value !== "object") return false;
  const { sessions, activeSession } = value as Partial<PluginPageProps>;
  if (!Array.isArray(sessions)) return false;
  const ids = new Set<number>();
  for (const pilot of sessions) {
    if (!isPilot(pilot) || ids.has(pilot.characterID)) return false;
    ids.add(pilot.characterID);
  }
  return activeSession === null || (isPilot(activeSession) && sessions.some(p =>
    p.characterID === activeSession.characterID && p.accountName === activeSession.accountName && p.token === activeSession.token));
}

// BroadcastChannel has no peer-disconnected event. A browser-owned lock releases even if the
// source process dies. LAN HTTP lacks Web Locks: announce presence there without polling a roster.
const presenceMs = 30_000;
function openSource() {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const channel = new BroadcastChannel(prefix + id);
  let release: () => void;
  const locks = navigator.locks;
  if (locks) {
    const lifetime = new Promise<void>(resolve => { release = resolve; });
    void locks.request(channel.name, () => lifetime).catch(() => {
      if (source?.channel === channel) closePageSource();
    });
  } else {
    const timer = setInterval(() => channel.postMessage("present"), presenceMs);
    release = () => clearInterval(timer);
  }
  channel.onmessage = ({ data }) => { if (data === "read") channel.postMessage(readRoster()); };
  return { id, channel, close() { channel.postMessage("closed"); channel.close(); release(); } };
}

export function closePageSource(): void {
  source?.close();
  source = undefined;
}

export function pageLaunchURL(href: string): string {
  source ??= openSource();
  return href + "#wc-launch=" + source.id;
}

export function launchPluginPage(event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
  const anchor = event.currentTarget as HTMLAnchorElement;
  event.preventDefault();
  window.open(pageLaunchURL(anchor.pathname), "_blank", "noopener");
  return true;
}

export function pageStorage(): Storage | null {
  try { return sessionStorage; } catch { return null; }
}

type LinkStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function pageLink(url: URL, storage: LinkStorage | null, scrub: () => void): string | null {
  const fragment = /^#wc-launch=([0-9a-f]{32})$/.exec(url.hash)?.[1];
  if (fragment) scrub();
  // Delete the initial PR's persisted snapshot without reading its tokens.
  try {
    storage?.removeItem("wc-plugin-page-sessions:v1");
    if (fragment) storage?.setItem(launchKey, fragment);
    const id = fragment ?? storage?.getItem(launchKey);
    return id && validLink.test(id) ? id : null;
  } catch { return fragment ?? null; }
}

export function followPageRoster(id: string | null, update: (context: PluginPageProps) => void): () => void {
  function publish(context: PluginPageProps) {
    setSessionToken(context.activeSession?.token ?? null);
    update(context);
  }
  setSessionToken(null);
  if (!id) {
    update(emptyPageRoster);
    return () => {};
  }
  const channel = new BroadcastChannel(prefix + id);
  const stop = new AbortController();
  // Give a linked page its current pilots on first mount, or an empty roster if the source is silent.
  let expiry = setTimeout(() => publish(emptyPageRoster), 3000);
  let received = false;
  function close() {
    if (stop.signal.aborted) return;
    stop.abort();
    channel.close();
    clearTimeout(expiry);
    publish(emptyPageRoster);
  }

  const locks = navigator.locks;
  if (locks) {
    // Wait for release, without taking the lock away from the owner or checking on a timer.
    void locks.request(channel.name, { mode: "shared", signal: stop.signal }, close).catch(close);
  }
  function renew() {
    clearTimeout(expiry);
    if (locks) return;
    // Allow for throttled timers in a background LAN tab.
    expiry = setTimeout(() => { received = false; publish(emptyPageRoster); }, 3 * presenceMs);
  }
  channel.onmessage = ({ data }) => {
    if (stop.signal.aborted) return;
    if (data === "closed") return close();
    if (data === "present") {
      if (received) renew();
      else channel.postMessage("read");
    } else if (validRoster(data)) {
      received = true;
      renew();
      publish(data);
    }
  };
  channel.onmessageerror = close;
  channel.postMessage("read");
  return close;
}
