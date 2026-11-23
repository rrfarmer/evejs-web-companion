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

const empty: PluginPageProps = { sessions: [], activeSession: null };
const key = "wc-plugin-page-sessions:v1";
let roster = () => empty;

export function sharePageRoster(sessions: () => readonly Session[], active: () => string | null): () => void {
  roster = () => {
    const pilots: PluginPagePilot[] = [];
    let activeSession: PluginPagePilot | null = null;
    for (const session of sessions()) {
      const state = session.store.get();
      const token = session.flow.sessionToken();
      if (!token || !state.session.username || !state.station.online) continue;
      const pilot = { accountName: state.session.username, characterID: state.station.online.characterID, token };
      pilots.push(pilot);
      if (session.id === active()) activeSession = pilot;
    }
    return { sessions: pilots, activeSession };
  };
  return () => { roster = () => empty; };
}

// A one-use same-origin channel lets the native noopener link keep its ordinary browser behaviour.
// Only the rendezvous id enters the fragment. A bearer never enters a URL or shared storage.
export function pageLaunchURL(href: string, context = roster()): string {
  if (!context.sessions.length) return href;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const channel = new BroadcastChannel(key + id);
  const timer = setTimeout(() => channel.close(), 30_000);
  channel.onmessage = ({ data }) => {
    if (data !== "read") return;
    channel.postMessage(context);
    clearTimeout(timer);
    channel.close();
  };
  return href + "#wc-launch=" + id;
}

export function launchPluginPage(event: MouseEvent): void {
  const anchor = event.currentTarget as HTMLAnchorElement;
  const href = pageLaunchURL(anchor.pathname);
  event.preventDefault();
  window.open(href, "_blank", "noopener");
}

export function pageStorage(): Storage | null {
  try { return sessionStorage; } catch { return null; }
}

export async function pageContext(url: URL, storage: Pick<Storage, "getItem" | "setItem"> | null, scrub: () => void): Promise<PluginPageProps> {
  const match = /^#wc-launch=([0-9a-f]{32})$/.exec(url.hash);
  let context = empty;
  if (match) {
    scrub();
    const channel = new BroadcastChannel(key + match[1]);
    try {
      context = await new Promise<PluginPageProps>((resolve) => {
        const timer = setTimeout(() => resolve(empty), 3000);
        channel.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
        channel.postMessage("read");
      });
    } finally { channel.close(); }
    try { storage?.setItem(key, JSON.stringify(context)); } catch { /* memory-only tab */ }
  } else {
    try { context = JSON.parse(storage?.getItem(key) ?? "null") ?? empty; } catch { /* fresh tab */ }
  }
  setSessionToken(context.activeSession?.token ?? null);
  return context;
}
