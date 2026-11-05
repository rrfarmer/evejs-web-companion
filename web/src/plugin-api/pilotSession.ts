// A pilot's session in a plugin's process: the client store and flow the page and
// the hosted bots are made of, flying a pilot core holds for a run (docs/plugins.md,
// "A run"). A module of its own because it loads all of the flow, which is about
// 170 MB of process: a backend that flies nothing never pays for it.
//
// ⚠ NO SELECT, AND NO TOKEN. Core selected the pilot and keeps its token; this flow
// attaches to that session and reaches the BFF only through `run.fetch`, where core
// adds the token. A select would take the pilot out of its fleet each time this
// process restarted.

import { createAppFlow, type AppFlow } from "../app/flow.ts";
import { createHostedEventSource } from "../app/hostedEventSource.ts";
import { setSessionTokenStorage } from "../app/sessionToken.ts";
import { createClientStore, type ClientStore } from "../store/clientStore.ts";
import type { PluginRunContext } from "./backend.ts";

// What the flow puts in its Authorization header until core replaces it.
const TOKEN_HELD_BY_CORE = "held-by-core";

export interface PilotSession {
  readonly store: ClientStore;
  readonly flow: AppFlow;
}

/** The session for a run, attached and with its live stream open. */
export async function createPilotSession(run: Pick<PluginRunContext, "baseUrl" | "fetch" | "held">): Promise<PilotSession> {
  // A process has no sessionStorage. Sessions here never use the global token, but its module reads one on load.
  setSessionTokenStorage(null);
  const store = createClientStore();
  const flow = createAppFlow(store, {
    baseUrl: run.baseUrl,
    fetch: run.fetch,
    perSessionToken: true,
    initialSessionToken: TOKEN_HELD_BY_CORE,
    eventSource: (url: string) => createHostedEventSource(url, { fetch: run.fetch }),
  });
  await flow.attachToHeldPilot(run.held);
  return { store, flow };
}
