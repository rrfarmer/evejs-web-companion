<script lang="ts">
  // R107 multibox — the whole tab. Several pilots are online at once, each a
  // fully isolated session (its own store + its own per-session-token flow, see
  // app/sessions.ts). This component owns the roster:
  //   • `sessions`  — the ONLINE pilots, one chip each in the character bar,
  //   • `activeId`  — which pilot's cockpit (Workspace) is showing right now,
  //   • `onboarding`— the pilot currently logging in / selecting a character,
  //                   shown full-screen at boot or over the workspace for "Add".
  // Exactly one Workspace is mounted (the active pilot); every other pilot's
  // store+flow stay live in memory and keep refreshing themselves on the BFF, so
  // switching is instant and safe. Login/select and all fetch/decode live
  // elsewhere; this file is pure orchestration.
  import CharacterBar from "./CharacterBar.svelte";
  import FleetInvitation from "./FleetInvitation.svelte";
  import ChatInvitations from "./ChatInvitations.svelte";
  import DuelInvitations from "./DuelInvitations.svelte";
  import DirectTradeWindows from "./DirectTradeWindows.svelte";
  import ClientDialogs from "./ClientDialogs.svelte";
  import InfoWindows from "./InfoWindows.svelte";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { showInfoRequests, setInfoShiftPressed } from "./showInfo.ts";
  import { untrack } from "svelte";
  import { notify } from "./notices.ts";
  import ShipRestrictionsWindow from "./ShipRestrictionsWindow.svelte";
  import AbyssJumpHost from "./AbyssJumpHost.svelte";
  import Onboarding from "./Onboarding.svelte";
  import PilotHangar from "./PilotHangar.svelte";
  import Workspace from "./Workspace.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { countPluginPilots, setPluginPilotCounts } from "./pluginPilotCounts.ts";
  import { createSession, type Session } from "../app/sessions.ts";
  import type { LaunchEntry, LaunchTarget } from "../app/hangarLaunch.ts";
  import { BridgeCallError } from "../bridge/callMethod.ts";
  import { panelErrorWords } from "../bridge/refusals.ts";
  import {
    loadPersistedSessions,
    savePersistedSessions,
    type PersistedSessions,
  } from "../app/persistedSessions.ts";
  import { setSessionToken, clearSessionToken } from "../app/sessionToken.ts";
  import { holdsTheShip } from "../nav/botRegistry.ts";
  import { getHealth, type ApiOptions } from "../app/api.ts";
  import { skipWhileBusy } from "../app/skipWhileBusy.ts";
  import { healthPollIntervalMs, resolveServerStatus } from "../app/serverStatus.ts";
  import type { LiveStreamStatus } from "../store/types.ts";
  import DesktopWindow from "./DesktopWindow.svelte";
  import GlobalPanel from "./GlobalPanel.svelte";
  import { tabLabel, type TabID } from "./tabs.ts";
  // The global layer reuses the desktop's own reducers: a window list behaves
  // the same wherever it floats, and only OPENING differs (placement, and which
  // tabs belong here at all), which is globalWindow.ts's job.
  import {
    closeWindow,
    focusWindow,
    focusedId as focusedWindowId,
    moveWindow,
    resizeWindow,
    toggleMinimize,
    MIN_H,
    MIN_W,
    type WinState,
  } from "./desktop.ts";
  import {
    isGlobalTab,
    loadGlobalWindows,
    BUILDER_TAB,
    openGlobal,
    saveGlobalWindows,
  } from "./globalWindow.ts";
  import { watchIsMobile } from "./viewport.ts";

  // Read the roster retained across a refresh ONCE, before any write effect can
  // clobber it, so a reload can bring the same pilots back online.
  const retained = loadPersistedSessions();
  const hasRetained = retained.pilots.length > 0;

  // The online roster, the active pilot, and the one being added. On a fresh tab
  // the PILOT HANGAR is the landing screen — every pilot this browser knows,
  // grouped by account, with the login behind a modal; when there's a retained
  // roster we restore straight into the cockpit instead.
  //
  // The hangar is not only the boot screen: it stays up over a live cockpit
  // after it launches a batch, so its progress dialog survives the first pilot
  // coming online and its "in client" markers mean something. `onboarding` is
  // still the "Add character" overlay reached from the character bar, which is
  // also where creating a character and stopping a server bot live.
  let sessions = $state<Session[]>([]);
  let activeId = $state<string | null>(null);
  let restoring = $state(hasRetained);
  let hangarOpen = $state(!hasRetained);
  let onboarding = $state<Session | null>(null);

  const active = $derived(sessions.find((s) => s.id === activeId) ?? null);
  let infoHost = $state<{ sessionID: string; host: InfoWindowHost } | null>(null);
  function setInfoHost(sessionID: string, host: InfoWindowHost | null): void {
    if (host) infoHost = { sessionID, host };
    else if (infoHost?.sessionID === sessionID) infoHost = null;
  }
  let servedInfoRequest = showInfoRequests.get()?.n ?? 0;
  $effect(() => showInfoRequests.subscribe(request => {
    if (!request || request.n <= servedInfoRequest) return;
    servedInfoRequest = request.n;
    const pilot = untrack(() => active);
    if (!pilot) return;
    const modal = request.options.modal ?? document.querySelector('[aria-modal="true"]') !== null;
    void pilot.flow.infoWindows.show(request.subject, { ...request.options, modal }).catch(error => {
      if (error?.code !== "SESSION_REQUEST_RETIRED") notify({ kind: "danger", title: "Show Info", detail: error instanceof Error ? error.message : String(error) });
    });
  }));
  $effect(() => {
    const key = (event: KeyboardEvent | MouseEvent): void => setInfoShiftPressed(event.shiftKey);
    const clear = (): void => setInfoShiftPressed(false);
    window.addEventListener("keydown", key, true); window.addEventListener("keyup", key, true);
    window.addEventListener("pointerdown", key, true); window.addEventListener("blur", clear);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("keyup", key, true); window.removeEventListener("pointerdown", key, true); window.removeEventListener("blur", clear); clear(); };
  });

  // Restore-on-refresh: bring each retained pilot back online by re-signing in
  // (any password) and re-selecting — the same tested path as a manual add, so
  // no token is persisted and a since-expired BFF session just re-selects. Done
  // sequentially: the first sign-in warms a cold gateway, and pilots light up in
  // the bar one at a time. A pilot that can't come back (account gone, character
  // taken, server down) is skipped rather than blocking the rest.
  async function restoreSessions(saved: PersistedSessions): Promise<void> {
    for (const pilot of saved.pilots) {
      const session = createSession({ botDrivenCharacterIDs });
      try {
        await session.flow.login(pilot.accountName, "");
        await session.flow.selectCharacter(pilot.characterID);
        sessions = [...sessions, session];
        if (activeId === null || pilot.characterID === saved.activeCharacterID) {
          activeId = session.id;
        }
      } catch {
        try {
          await session.flow.logout();
        } catch {
          // best-effort teardown of a half-restored session
        }
      }
    }
    restoring = false;
    // Nothing came back (e.g. the server was down) — fall through to the hangar,
    // which shows the same pilots and can try them again one at a time.
    if (sessions.length === 0) {
      hangarOpen = true;
    }
  }

  // Kick the restore off once, after mount. `retained` is a plain const, so this
  // effect has no reactive dependencies and never re-runs.
  let restoreStarted = false;
  $effect(() => {
    if (restoreStarted) return;
    restoreStarted = true;
    if (hasRetained) void restoreSessions(retained);
  });

  /**
   * The pilots THIS TAB is flying with a bot, for the fleet companion's
   * supervision gate (docs/fleet-companion-plan.md, decision 5). The companion
   * subtracts these from its fleet roster; whatever is left is a human, and a
   * companion with no human left in its fleet gets safe and drops fleet.
   *
   * ⚠ ONLY THIS COMPONENT CAN ANSWER IT. A human's pilot and a companion's
   * pilot both reach the BFF as an ordinary held bridge session, so nothing on
   * the server can tell them apart — only the roster owner knows which of its
   * sessions has a loop driving it. The flow unions this with the BFF's own
   * running-bot list, which covers the headless ones.
   *
   * ⚠ A PILOT FLOWN BY HAND IS NOT SUBTRACTED, deliberately. A person at the
   * keyboard is exactly the supervision the gate is looking for, so only a
   * session whose ship a loop is actually holding counts as bot-driven.
   */
  function botDrivenCharacterIDs(): readonly number[] {
    const driven: number[] = [];
    for (const session of sessions) {
      const state = session.store.get();
      if (state.bots.runningBotID !== null && state.station.online) {
        driven.push(state.station.online.characterID);
      }
    }
    return driven;
  }

  /**
   * How many pilots are flying as companions right now — the number on the
   * character bar's Companions button.
   *
   * ⚠ IT COUNTS ACROSS SESSIONS, WHICH IS WHY IT IS HERE. No pilot's own store
   * can answer it: each one knows only itself, and the button is on the one
   * piece of chrome that outlives a pilot switch. Subscribing to every session's
   * companion slice is the same thing BotManagerPilotRow does for a background
   * pilot — a store read, not a poll, so an idle squad costs nothing.
   *
   * PAUSED COUNTS, because `holdsTheShip` says it does: a paused companion has
   * not let go of the hull and is one press from flying it again.
   */
  let companionCount = $state(0);
  // The same, for each plugin's launcher: who holds each pilot's ship says it.
  $effect(() => {
    const recount = (): void => setPluginPilotCounts(countPluginPilots(sessions.map((session) => session.store.bots.get().runningBotID)));
    const unsubs = sessions.map((session) => session.store.bots.subscribe(recount));
    recount();
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });
  function recountCompanions(): void {
    let flying = 0;
    for (const session of sessions) {
      if (holdsTheShip(session.store.get().companion.status)) flying += 1;
    }
    companionCount = flying;
  }
  $effect(() => {
    const unsubs = sessions.map((session) =>
      session.store.companion.subscribe(() => recountCompanions()),
    );
    recountCompanions();
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });

  // A pilot finished login+select: promote it from onboarding into the online
  // roster and make it the active cockpit (matches "Add character makes it
  // active", and is the natural landing for the first pilot too).
  function completeOnboarding(): void {
    const s = onboarding;
    if (!s) return;
    sessions = [...sessions, s];
    activeId = s.id;
    onboarding = null;
  }

  // Log another pilot in WITHOUT disturbing the current ones: a fresh isolated
  // session in an overlay. One add at a time.
  function addCharacter(): void {
    if (onboarding) return;
    onboarding = createSession({ botDrivenCharacterIDs });
  }

  // Abandon an in-progress add: tear the pending session down (best-effort, so a
  // partial BFF login does not linger past its TTL) and drop the overlay.
  function cancelOnboarding(): void {
    const s = onboarding;
    onboarding = null;
    if (s) void s.flow.logout().catch(() => {});
  }

  // A pilot chosen in the character bar is a pilot to look at, so the hangar
  // gives way, as goToPilot's does: with it left open over the cockpit a click
  // on a chip changed nothing on screen, the active pilot's least of all.
  function switchTo(id: string): void {
    activeId = id;
    hangarOpen = false;
  }

  // --- the hangar's "bring online" -------------------------------------------
  //
  // The hangar decides WHICH pilots; only this component can create a session,
  // so the doing lives here. It is the restore loop above generalised: sign in
  // (any password), select, keep the session — one pilot at a time, and for the
  // same reason. A browser allows about six connections per origin, and six
  // simultaneous sign-ins fill that pool with sign-ins, so the seventh request
  // of any kind waits behind them. Sequentially, each pilot also LANDS
  // separately, which is what makes the progress dialog honest: a row flips
  // because that pilot is actually in the client, not because a timer fired.
  //
  // A pilot that cannot come online (already flown by a bot, account gone,
  // server down) is reported and skipped. One refusal must not strand the rest
  // of a squad.
  function launchFailureWords(cause: unknown): string {
    if (cause instanceof BridgeCallError) {
      if (cause.code === "UNKNOWN_EVEJS_ACCOUNT") return "account is gone";
      if (cause.code === "CALL_REFUSED") return cause.message;
      return panelErrorWords(cause);
    }
    return "could not connect";
  }

  async function bringOnline(
    targets: readonly LaunchTarget[],
    onProgress: (characterID: number, state: LaunchEntry["state"], note?: string) => void,
  ): Promise<void> {
    for (const target of targets) {
      onProgress(target.characterID, "connecting");
      const session = createSession({ botDrivenCharacterIDs });
      try {
        await session.flow.login(target.accountName, "");
        await session.flow.selectCharacter(target.characterID);
        sessions = [...sessions, session];
        // The first pilot up becomes the cockpit behind the hangar, so "Go to
        // first pilot" has somewhere to land and closing the hangar is not a
        // blank page.
        if (activeId === null) activeId = session.id;
        onProgress(target.characterID, "online");
      } catch (cause) {
        try {
          await session.flow.logout();
        } catch {
          // best-effort teardown of a half-started session
        }
        onProgress(target.characterID, "failed", launchFailureWords(cause));
      }
    }
  }

  /**
   * The session flying one character, or undefined when no slot here holds it.
   * The roster lives here, so every "which pilot is that" lookup resolves here.
   */
  function sessionFor(characterID: number): Session | undefined {
    return sessions.find((s) => s.store.station.get().online?.characterID === characterID);
  }

  /**
   * Show one pilot's cockpit and leave the hangar. Reached from the launch
   * dialog's "go to first pilot" and from clicking a pilot that is already in
   * the client.
   */
  function goToPilot(characterID: number): void {
    const match = sessionFor(characterID);
    if (match) activeId = match.id;
    hangarOpen = false;
  }

  /**
   * The token a call ABOUT one pilot must ride, for the screens that act on
   * pilots other than the active one (the hangar's squad start). NULL when no
   * session here is flying that pilot — the caller then has to find another way
   * to speak as it, and must not fall back to whatever this tab is.
   *
   * ⚠ THE PILOT'S OWN SESSION, NOT THE TAB'S. Under R107 every session
   * authenticates as itself; a call made with no options rides the per-tab
   * cookie, which names one arbitrary pilot. `/api/bots/start` checks the
   * character against the CALLER's account and hands over the CALLER's held
   * session, so the wrong token turns a six-pilot squad start into five
   * "Character does not belong to the supplied account" refusals and one
   * "A web session is flying this character".
   */
  function requestOptionsFor(characterID: number): ApiOptions | null {
    return sessionFor(characterID)?.flow.requestOptions() ?? null;
  }

  /**
   * Let go of a hull the bot host has taken, in this tab's own UI. The server
   * already released it as part of the start; this is the tab catching up, and
   * a failure here does not unmake the bot.
   */
  async function releaseHandedOver(characterID: number): Promise<void> {
    await sessionFor(characterID)?.flow.releaseSession();
  }

  // The characters already live in this tab, so the "Add character" picker can
  // disable a quick-add that would just be refused as "already in use". Kept in
  // sync by the same station subscriptions that drive pruning, below.
  let onlineIDs = $state<Set<number>>(new Set());
  function recomputeOnline(): void {
    const ids = new Set<number>();
    for (const s of sessions) {
      const on = s.store.station.get().online;
      if (on) ids.add(on.characterID);
    }
    onlineIDs = ids;
  }

  // Remove a pilot the instant its store reports offline — release, logout, or a
  // lost session from inside its own workspace. Re-fix the active cockpit, and if
  // the tab is now empty, drop back to a fresh full-screen login.
  function removeSession(id: string): void {
    const remaining = sessions.filter((s) => s.id !== id);
    if (remaining.length === sessions.length) return;
    const gone = sessions.find((s) => s.id === id) ?? null;
    sessions = remaining;
    sayWhyOffline(gone, lastOnline.get(id) ?? null);
    lastOnline.delete(id);
    if (activeId === id) {
      activeId = remaining.length > 0 ? remaining[remaining.length - 1].id : null;
    }
    if (remaining.length === 0 && onboarding === null) {
      hangarOpen = true;
    }
  }

  // Each pilot's character while it was online, to say who went and to ask why (sayWhyOffline). Not state: nothing
  // is drawn from it.
  const lastOnline = new Map<string, { characterID: number; characterName: string }>();

  // A pilot the game server logged off with a reason of its own (another login of its account: one client for each
  // account, as on Tranquility), said as the retail client puts up its connection-lost notice (disconnectNotice.py),
  // until it is put away. A pilot released, logged out or lost for no reason the server gave goes without a word.
  let offlineNotes = $state<{ id: number; text: string }[]>([]);
  let offlineNoteSeq = 0;
  function sayWhyOffline(gone: Session | null, last: { characterID: number; characterName: string } | null): void {
    if (!gone || !last || typeof gone.flow.readClosedByServer !== "function") return;
    gone.flow
      .readClosedByServer(last.characterID)
      .then((closed) => {
        if (!closed) return;
        offlineNoteSeq += 1;
        offlineNotes = [
          ...offlineNotes,
          {
            id: offlineNoteSeq,
            text: `${last.characterName || `Character ${last.characterID}`} was logged off by the game server: ${closed.reason} (${closed.reasonCode}).`,
          },
        ];
      })
      .catch(() => {});
  }

  // Watch every online pilot's station slice; when one goes offline, prune it.
  // Re-subscribes when the roster changes. The signal fires synchronously with
  // the current value on subscribe, which for an online pilot is a no-op, so
  // this never prunes a pilot that is still live.
  $effect(() => {
    const unsubs = sessions.map((s) =>
      s.store.station.subscribe((slice) => {
        if (slice.online !== null) {
          lastOnline.set(s.id, { characterID: slice.online.characterID, characterName: slice.online.characterName });
        }
        if (slice.online === null) removeSession(s.id);
        recomputeOnline();
      }),
    );
    recomputeOnline();
    return () => {
      for (const unsub of unsubs) unsub();
    };
  });

  // Retain the online roster (account + character + which is active, NO token)
  // across a refresh. Fires on roster / active-pilot changes, not on every
  // in-store tick. Skipped while restoring so a transient empty roster can't
  // clobber the one we are still bringing back — and `retained` was already read
  // into a const above, so even a stray write is harmless.
  $effect(() => {
    const roster = sessions;
    const current = activeId;
    if (restoring) return;
    const pilots = roster
      .map((s) => {
        const snapshot = s.store.get();
        return snapshot.station.online && snapshot.session.username
          ? { accountName: snapshot.session.username, characterID: snapshot.station.online.characterID }
          : null;
      })
      .filter((p): p is { accountName: string; characterID: number } => p !== null);
    const activeCharacterID =
      roster.find((s) => s.id === current)?.store.get().station.online?.characterID ?? null;
    savePersistedSessions({ pilots, activeCharacterID });
  });

  // One live push (SSE) connection per TAB, held by the active pilot. Roster
  // sessions are created with livePush OFF (see app/sessions.ts): an open
  // EventSource occupies one of the browser's ~6 per-origin connections for
  // its whole life, so letting every pilot keep one starved the pool and hung
  // the 7th pilot's login/select in the browser queue. Background pilots keep
  // refreshing themselves over ordinary reads (every bridge response carries
  // its notification drain); the switched-to pilot re-attaches here.
  // ⚠ TWO SEPARATE THINGS, DRIVEN FROM ONE CONDITION. Push is about which pilot
  // holds the tab's one EventSource; foreground is about which pilot wins a
  // request lane when they compete. A background pilot's bot keeps working —
  // that is the point of multibox — but the browser's ~6 connections per origin
  // do not multiply with the roster, so its calls yield to the pilot on screen.
  $effect(() => {
    for (const s of sessions) {
      const isActive = s.id === activeId;
      s.flow.setLivePush(isActive);
      s.flow.setForeground(isActive);
    }
  });

  // What the server sends a pilot not in front waits at the BFF for that pilot's next read, and a docked, idle
  // pilot makes none: it heard nothing until it was switched to (seen 2026-10-15, a fleet invitation 54 seconds
  // unheard). The retail client each pilot stands for hears at once, and puts some of it to its pilot (a fleet
  // invitation, FleetInvitation.svelte). So each pilot not in front hears what waits for it every few seconds, by
  // a read that asks the server nothing (flow.hearInBackground), each guarded as every beat here is.
  const BACKGROUND_HEARING_MS = 4000;
  $effect(() => {
    const behind = sessions.filter((s) => s.id !== activeId);
    if (behind.length === 0) return;
    const beats = behind.map((s) => skipWhileBusy(() => s.flow.hearInBackground().catch(() => {})));
    const handle = setInterval(() => {
      for (const beat of beats) void beat();
    }, BACKGROUND_HEARING_MS);
    return () => clearInterval(handle);
  });

  // R107 — mirror the ACTIVE pilot's token into the per-tab global. A few panels
  // still call the API WITHOUT per-session options — the Bot Builder's
  // create/update/list/deleteBotScript and iconCache's admin routes — and those
  // fall back to this global. Multibox otherwise leaves it empty, so before this
  // they rode the leftover login COOKIE (the last pilot added) and saved/read a
  // DIFFERENT account's bot scripts than the one on screen. Pointing the global
  // at the active pilot makes those legacy calls act as the pilot you're looking
  // at. Per-session flows are unaffected — they carry their own token on
  // callOptions and never read the global.
  $effect(() => {
    const token = active?.flow.sessionToken() ?? null;
    if (token) setSessionToken(token);
    else clearSessionToken();
  });

  // Server connection status for the character bar.
  //
  // The ACTIVE pilot's push stream is the primary signal; the /api/health poll
  // is the fallback for when there is no stream (character select) or it is not
  // carrying. See app/serverStatus.ts for why: the poll runs at the lowest
  // priority in a four-lane transport, so under load the page starved its own
  // health ping and reported a healthy server as offline — which is why the
  // companion "disconnected" with two clients as readily as with twelve.
  // Subscribed explicitly rather than with `$store`: which pilot is active
  // changes, so the signal being read changes with it, and there is no signal at
  // all on the character-select screen. `subscribe` returns its unsubscriber,
  // which is exactly what $effect wants for cleanup.
  let liveStatus = $state<LiveStreamStatus>("idle");
  $effect(() => {
    const signal = active?.store.live;
    if (!signal) {
      liveStatus = "idle";
      return;
    }
    return signal.subscribe((value) => {
      liveStatus = value.status;
    });
  });

  // Last health answer: null until one arrives. Kept separate from the rendered
  // status so the stream can override it without destroying it.
  let healthReady = $state<boolean | null>(null);
  const serverStatus = $derived(resolveServerStatus({ live: liveStatus, healthReady }));

  $effect(() => {
    // Re-armed when the stream state changes, so the cadence follows it.
    const intervalMs = healthPollIntervalMs(liveStatus);
    let cancelled = false;
    const ping = async (): Promise<void> => {
      try {
        const { ready } = await getHealth({ priority: "poll" });
        if (!cancelled) healthReady = ready;
      } catch {
        if (!cancelled) healthReady = false;
      }
    };
    // ⚠ GUARDED. This one is mounted for the WHOLE session, so an unguarded
    // beat every ten seconds is the fastest way this client has of filling the
    // browser's connection pool with stalled requests when the server slows —
    // and it is the requests it steals sockets from that visibly fail. See
    // app/skipWhileBusy.ts.
    const beat = skipWhileBusy(ping);
    void beat();
    const handle = setInterval(() => void beat(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  });

  // ── the global window layer ───────────────────────────────────────────────
  //
  // ⚠ IT LIVES HERE, ABOVE THE `{#key active.id}` BELOW, AND THAT IS THE WHOLE
  // FEATURE. A Workspace is remounted on every pilot switch, so anything inside
  // one is torn down with it. The Bot Manager is a view of the ROSTER — every
  // held pilot plus every character with a server bot — and of the account-wide
  // bot library, so it is the one panel for which that teardown is a loss and
  // not a correctness measure: it refetches from scratch, empties its search,
  // closes an open export box, and restarts the roster poll that is a running
  // server bot's only alert delivery. See globalWindow.ts.
  let globalWins = $state<WinState[]>([]);
  let globalLoaded = false;

  // ⚠ NOT MOUNTED ON A PHONE. MobileWorkspace is one panel at a time with no
  // windows at all, so a floating window over it would be the only draggable
  // thing on a screen that has none. There the Bot Manager stays an ordinary
  // panel selection, and switching pilots resets it like everything else — the
  // honest limit of a UI with nowhere to float.
  let isMobile = $state(false);
  $effect(() => watchIsMobile((value) => { isMobile = value; }));

  // Restore where the window was left, once, before any save effect can write
  // over it — the same ordering `retained` above relies on.
  $effect(() => {
    if (globalLoaded) return;
    globalLoaded = true;
    globalWins = loadGlobalWindows();
  });
  $effect(() => {
    const wins = globalWins;
    if (!globalLoaded) return;
    const handle = setTimeout(() => saveGlobalWindows(wins), 300);
    return () => clearTimeout(handle);
  });

  const globalOpenIds = $derived(new Set<TabID>(globalWins.map((win) => win.id)));
  const globalFocusedId = $derived(focusedWindowId(globalWins));
  /**
   * The global windows that are actually drawn.
   *
   * ⚠ THE PUT-AWAY ONES ARE NOT LISTED HERE ANY MORE. This layer used to carry
   * a strip of its own, in the opposite corner from the desktop's — so putting
   * a window away sent its handle to one of two places depending on which
   * window it was, with nothing on screen explaining why. The chips go down to
   * the desktop's one strip now (Desktop.svelte); every window is still listed
   * somewhere, which is the rule that matters.
   */
  const shownGlobalWins = $derived(globalWins.filter((win) => !win.minimized));
  const openGlobalTab = (id: TabID): void => {
    if (!isGlobalTab(id)) return;
    // ⚠ ON A PHONE THERE IS NOWHERE TO FLOAT. The layer is not mounted there at
    // all, so opening one here would light the rail's "open" state on a window
    // nothing draws. MobileWorkspace shows a global tab as an ordinary panel
    // selection instead, which is what the workspace request below asks for.
    //
    // ⚠ UNLESS NOBODY IS IN THE CLIENT. The hangar has no workspace to show a
    // panel in, so there the layer IS mounted on a phone too (see the mount
    // below) and the window floats over the hangar like on a desktop.
    if (isMobile && active) {
      hangarOpen = false;
      requestOpenInWorkspace(id);
      return;
    }
    globalWins = openGlobal(globalWins, id);
  };

  /**
   * A panel the global window asked to be opened on a pilot's workspace — the
   * Bot Manager asking for the Bot Builder, or for the built-in bots panel.
   *
   * ⚠ IT NAMES THE PILOT IT IS FOR. Only one workspace is mounted, and it is
   * remounted per pilot, so an unaddressed request is ambiguous: a workspace
   * cannot tell "asked for before I existed" from "asked for as I was being
   * created". Both cases happen here — see Workspace.svelte's effect for the two
   * bugs that came of guessing — so the request carries a session id, the
   * matching workspace serves it, and it is dropped the moment it is served.
   *
   * The counter is what makes asking TWICE work: the same panel requested again
   * must still be raised, and it may have been closed or buried in between.
   */
  let openRequest = $state<{ id: TabID; n: number; sessionID: string } | null>(null);
  let openRequestCount = 0;
  /**
   * Open `id` on `sessionID`'s workspace, making that pilot active first when it
   * is not already — the panels reached this way read the MOUNTED pilot's store,
   * so opening one for a pilot who is not on screen would show the wrong ship.
   */
  const requestOpenInWorkspace = (id: TabID, sessionID?: string): void => {
    // A global tab would be asking a workspace for something it does not own —
    // unless this is a phone, where the workspace is the only place anything
    // can be shown and `openGlobalTab` has already sent it back here.
    if (isGlobalTab(id) && !isMobile) {
      openGlobalTab(id);
      return;
    }
    const target = sessionID ?? activeId;
    // The Bot Builder floats on the global layer beside the Bot Manager that
    // opens it, rather than on a desktop underneath it (globalWindow.ts
    // `BUILDER_TAB`). A phone with a pilot in has no layer, so it falls through
    // to the workspace there like any other panel.
    if (id === BUILDER_TAB && (!isMobile || target === null)) {
      openBuilder(target);
      return;
    }
    if (target === null) return;
    // The panel opens on a pilot's workspace, which the hangar covers: asking
    // for the Bot Builder from a Bot Manager opened over the hangar must show
    // the builder, not open it somewhere underneath.
    hangarOpen = false;
    if (target !== activeId) switchTo(target);
    openRequestCount += 1;
    openRequest = { id, n: openRequestCount, sessionID: target };
  };
  /**
   * The pilot the floating Bot Builder reads (its ship, holds and fittings), or
   * null for the account-backed builder over the hangar.
   *
   * ⚠ BOUND WHEN THE WINDOW OPENS, NOT FOLLOWING THE ACTIVE PILOT. A builder
   * already open keeps its pilot through a pilot switch and through a second
   * Edit/New (which bots/builderTarget.ts delivers to the builder that is
   * mounted): the player chose that pilot, by opening it or with the builder's
   * own "Data from" picker. It is rebound on open only when that pilot has gone
   * from the roster.
   */
  let builderSessionID = $state<string | null>(null);
  const builderSession = $derived(sessions.find((s) => s.id === builderSessionID) ?? null);
  const openBuilder = (target: string | null): void => {
    const isOpen = globalWins.some((win) => win.id === BUILDER_TAB);
    const pilotGone = builderSessionID !== null && builderSession === null;
    if (!isOpen || pilotGone) builderSessionID = target;
    globalWins = openGlobal(globalWins, BUILDER_TAB);
  };
  // The layer spans the viewport, so a window dragged or sized for a bigger one
  // can end up with its title bar and resize handles past the edge, with nothing
  // on screen to pull it back. Desktop.svelte reconciles its own windows the same
  // way; this is that rule for the one window App owns.
  let globalLayerEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const el = globalLayerEl;
    const wins = globalWins;
    if (!el || wins.length === 0) return;
    const reconcile = (): void => {
      const areaW = el.clientWidth;
      const areaH = el.clientHeight;
      if (areaW <= 0 || areaH <= 0) return;
      let changed = false;
      const next = wins.map((win) => {
        const w = Math.min(win.w, Math.max(MIN_W, areaW));
        const h = Math.min(win.h, Math.max(MIN_H, areaH));
        const x = Math.min(Math.max(0, win.x), Math.max(0, areaW - w));
        const y = Math.min(Math.max(0, win.y), Math.max(0, areaH - h));
        if (w === win.w && h === win.h && x === win.x && y === win.y) return win;
        changed = true;
        return { ...win, x, y, w, h };
      });
      if (changed) {
        globalWins = next;
      }
    };
    reconcile();
    const ro = new ResizeObserver(reconcile);
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

{#if active}
  <ErrorBoundary name="Character bar">
    <CharacterBar
      {sessions}
      {activeId}
      {serverStatus}
      {companionCount}
      {globalOpenIds}
      onSwitch={switchTo}
      onAdd={addCharacter}
      onHangar={() => (hangarOpen = true)}
      onOpenGlobal={openGlobalTab}
    />
  </ErrorBoundary>
  <!-- Remount on switch: each Workspace binds one stable store/flow for its
       whole life, and the in-memory store makes the remount instant. -->
  {#key active.id}
    <!-- The outermost net. Every panel and every piece of chrome has its own
         boundary inside; this one only catches what escapes them all, so one
         pilot's cockpit can never take the character bar down with it. -->
    <ErrorBoundary name="Cockpit">
      <Workspace
        store={active.store}
        flow={active.flow}
        {sessions}
        {globalOpenIds}
        {globalWins}
        onToggleGlobalMinimize={(id) => (globalWins = toggleMinimize(globalWins, id))}
        {openRequest}
        sessionID={active.id}
        onOpenRequestServed={() => (openRequest = null)}
        onOpenGlobal={openGlobalTab}
        onInfoHost={setInfoHost}
      />
    </ErrorBoundary>
  {/key}
  <!-- A fleet invitation is asked of its own pilot whichever pilot is in front (fleetSvc.OnFleetInvite: the
       client's own window for that pilot), so the questions are the tab's, above every pilot's cockpit. -->
  <ErrorBoundary name="Fleet invitations">
    <div class="fleet-invitations">
      {#each sessions as session (session.id)}
        <FleetInvitation {session} inFront={session.id === activeId} />
      {/each}
    </div>
  </ErrorBoundary>
  <!-- A refusal the server names a dialog for, put up as the client puts up a UserError: each pilot's, whichever is in
       front, as the invitations are. -->
  <ErrorBoundary name="Chat invitations"><div class="chat-invitation-stack">{#each sessions as session (session.id)}<ChatInvitations {session} inFront={session.id === activeId} />{/each}</div></ErrorBoundary>
  <ErrorBoundary name="Duel invitations"><div class="duel-invitation-stack">{#each sessions as session (session.id)}<DuelInvitations {session} inFront={session.id === activeId} />{/each}</div></ErrorBoundary>
  <ErrorBoundary name="Direct trades"><div class="trade-window-layer">{#each sessions as session (session.id)}<DirectTradeWindows {session} inFront={session.id === activeId} />{/each}</div></ErrorBoundary>
  <ErrorBoundary name="Client dialogs">
    {#each sessions as session (session.id)}
      <ClientDialogs {session} inFront={session.id === activeId} />
    {/each}
  </ErrorBoundary>
  <ErrorBoundary name="Information windows">
    {#each sessions as session (session.id)}
      <InfoWindows {session} inFront={session.id === activeId} host={infoHost?.sessionID === session.id ? infoHost.host : null} />
    {/each}
  </ErrorBoundary>
  <!-- The Ship Restrictions window an acceleration gate's refusal opens (ShipRestrictionsWindow.svelte), the pilot in
       front's. -->
  <ErrorBoundary name="Ship restrictions">
    {#each sessions as session (session.id)}
      <ShipRestrictionsWindow {session} inFront={session.id === activeId} />
    {/each}
  </ErrorBoundary>
  <!-- A trace's jump window that Activate Gate on an Abyssal trace opens (AbyssJumpHost.svelte), the pilot in front's. -->
  <ErrorBoundary name="Abyssal jump">
    {#each sessions as session (session.id)}
      <AbyssJumpHost {session} inFront={session.id === activeId} />
    {/each}
  </ErrorBoundary>
{:else if restoring}
  <!-- Refresh restore in flight and no cockpit up yet: bringing pilots back. -->
  <h1>EveJS Web</h1>
  <p class="restoring-note">Restoring your pilots…</p>
{/if}

{#if offlineNotes.length > 0}
  <div class="offline-notes" role="status">
    {#each offlineNotes as note (note.id)}
      <div class="offline-note">
        <p>{note.text}</p>
        <button type="button" class="minor" onclick={() => (offlineNotes = offlineNotes.filter((n) => n.id !== note.id))}>
          OK
        </button>
      </div>
    {/each}
  </div>
{/if}

{#if hangarOpen}
  <!-- The Pilot Hangar. It is the landing screen when nothing is online, and it
       stays over a live cockpit after it launches a batch so its progress
       dialog is not torn down by the first pilot arriving. Its own boundary:
       the hangar can fail without taking the cockpit underneath with it. -->
  <ErrorBoundary name="Pilot hangar">
    <PilotHangar
      {onlineIDs}
      {sessionFor}
      onLaunch={bringOnline}
      onShowPilot={goToPilot}
      onClose={active ? () => (hangarOpen = false) : null}
      optionsFor={requestOptionsFor}
      onHandedOver={releaseHandedOver}
      {globalOpenIds}
      {companionCount}
      onOpenGlobal={openGlobalTab}
    />
  </ErrorBoundary>
{/if}

{#if globalWins.length > 0 && (!isMobile || !active)}
  <!-- THE GLOBAL WINDOWS, on their own layer over whichever screen is showing:
       a pilot's workspace, or the Pilot Hangar.

       ⚠ OUTSIDE `{#if active}`, AND AFTER THE HANGAR. These windows are about
       every pilot and open from the hangar's brand strip with nobody in the
       client, so they cannot depend on a pilot being active; and drawn after
       the hangar, they sit over it (`.over-hangar`) rather than under it.

       `pointer-events: none` on the layer and `auto` on the windows is what
       keeps a full-viewport overlay from swallowing every click meant for the
       screen underneath it.

       Each takes the held sessions, never the active pilot's store or flow —
       see GlobalPanel.svelte — so a pilot switch changes nothing under them. -->
  <div class="global-layer" class:over-hangar={hangarOpen || !active} bind:this={globalLayerEl}>
    {#each shownGlobalWins as win (win.id)}
      <ErrorBoundary name={tabLabel(win.id)}>
        <DesktopWindow
          {win}
          title={tabLabel(win.id)}
          focused={win.id === globalFocusedId}
          onFocus={() => (globalWins = focusWindow(globalWins, win.id))}
          onClose={() => (globalWins = closeWindow(globalWins, win.id))}
          onToggleMinimize={() => (globalWins = toggleMinimize(globalWins, win.id))}
          onMove={(x, y) => (globalWins = moveWindow(globalWins, win.id, x, y))}
          onResize={(w, h) => (globalWins = resizeWindow(globalWins, win.id, w, h))}
        >
          <GlobalPanel
            tab={win.id}
            {sessions}
            {builderSession}
            onBuilderPilot={(id) => (builderSessionID = id)}
            onOpen={requestOpenInWorkspace}
            onGoToPilot={(id) => {
              hangarOpen = false;
              switchTo(id);
            }}
          />
        </DesktopWindow>
      </ErrorBoundary>
    {/each}
  </div>
{/if}

{#if onboarding}
  {#if active}
    <!-- Add character: an overlay over the live workspace, which keeps running. -->
    <div class="onboarding-overlay">
      <div class="onboarding-frame">
        <div class="onboarding-frame-head">
          <span class="onboarding-frame-title">Add character</span>
          <button type="button" class="minor" onclick={cancelOnboarding}>Cancel</button>
        </div>
        <Onboarding store={onboarding.store} flow={onboarding.flow} {onlineIDs} onOnline={completeOnboarding} />
      </div>
    </div>
  {:else}
    <!-- No cockpit behind it (the hangar handed us a session that then went
         away): a full-screen login, nothing behind it. -->
    <h1>EveJS Web</h1>
    <Onboarding store={onboarding.store} flow={onboarding.flow} {onlineIDs} onOnline={completeOnboarding} />
  {/if}
{/if}
