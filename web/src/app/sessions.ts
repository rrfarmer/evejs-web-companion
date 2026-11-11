// R107 multibox — one browser tab, several live pilots. Each pilot is a fully
// isolated SESSION: its own client store (createClientStore builds all-fresh
// signals, so no two sessions share slice state) and its own flow in
// per-session-token mode (so it authenticates as itself and its background
// self-refresh can never ride another pilot's token — see AppFlowOptions
// `perSessionToken` and app/api.ts). This module owns only the *bundling*; which
// session is active and the list ordering are reactive concerns that live in
// App.svelte.

import { createClientStore, type ClientStore } from "../store/clientStore.ts";
import { createAppFlow, type AppFlow, type AppFlowOptions } from "./flow.ts";
import { nextLocalID } from "./localID.ts";

export interface Session {
  /** Stable client-side id for this slot, distinct from the character/account. */
  readonly id: string;
  readonly store: ClientStore;
  readonly flow: AppFlow;
}

/** A unique slot id; the character/account identity lives in the store. */
function nextSessionId(): string {
  return `session-${nextLocalID()}`;
}

/**
 * Build one isolated pilot session and warm its health slice. `checkHealth`
 * runs because each store starts with an "unknown" health status and the login
 * form stays gated until it resolves online — and the ping also warms the
 * gateway against a cold-start read timeout right before the first login. The
 * flow is always per-session-token; that is the whole point of the slot.
 */
export function createSession(options: AppFlowOptions = {}): Session {
  const store = createClientStore();
  // livePush starts OFF: every open EventSource pins one of the browser's ~6
  // per-origin connections for its whole life, so a roster of pilots each
  // holding one starves the pool and the NEXT pilot's login/select hangs in
  // the browser's request queue (seen live at pilot 7). App.svelte turns push
  // on for exactly one session — the active pilot.
  const flow = createAppFlow(store, { livePush: false, ...options, perSessionToken: true, browserPilotRecovery: true, shareRouteSettings: true });
  void flow.checkHealth();
  return { id: nextSessionId(), store, flow };
}
