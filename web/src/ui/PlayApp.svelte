<script lang="ts">
  // The play mode (/fly, branch FarmerThreeJSFun): one pilot, flown by hand, in the 3D view of space drawn from the
  // browser's own Destiny park (web/src/play), with the app's own windows over it. Everything the pilot does goes
  // through the app's session (store + Flow, app/sessions.ts) as it does in the multibox client; nothing here is a
  // bot, and no bot is mounted. Docked, the station's Undock; in space, the SpaceView with its HUD, overview and
  // brackets. The Neocom opens the app's panels (PanelHost) in client-look windows (DesktopWindow).
  import { onDestroy } from "svelte";
  import { createSession, type Session } from "../app/sessions.ts";
  import { setSessionToken, withTokenQuery } from "../app/sessionToken.ts";
  import { bridgeDo } from "../app/api.ts";
  import DesktopWindow from "./DesktopWindow.svelte";
  import PanelHost from "./PanelHost.svelte";
  import NoticeBridge from "./NoticeBridge.svelte";
  import Toasts from "./Toasts.svelte";
  import ServerQuestion from "./ServerQuestion.svelte";
  import ClientDialogs from "./ClientDialogs.svelte";
  import InfoWindows from "./InfoWindows.svelte";
  import PlayLobbyTabs from "./PlayLobbyTabs.svelte";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { showInfoRequests } from "./showInfo.ts";
  import { notify } from "./notices.ts";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { openWindow, closeWindow, focusWindow, moveWindow, resizeWindow, toggleMinimize, type WinState } from "./desktop.ts";
  import { tabLabel, deriveDocked, type TabID } from "./tabs.ts";
  import { LivePark } from "../three/livePark.ts";
  import { SpaceView } from "../play/spaceView.ts";
  import { HangarView } from "../play/hangarView.ts";
  import { Neocom } from "../play/neocom.ts";
  import { clientTexture } from "../play/window.ts";
  import type { HudModule } from "../play/shipHud.ts";
  import { typeIconUrl } from "./typeIcons.ts";
  import { cycleProgressPercent } from "./moduleRack.ts";

  // Type names for the rack's tooltips (the extractor's typeNames.json, from the SDE).
  let typeNames: Record<string, [string | null, number | null]> = {};
  void fetch("/client-assets/typeNames.json").then((r) => (r.ok ? r.json() : null)).then((n) => { if (n) typeNames = n.types; }).catch(() => {});
  import "../play/play.css";
  import { applyClientTint } from "../play/clientTint.ts";

  // The app's navy panels in the client's greys, for as long as the play mode is up (play/clientTint.ts).
  $effect(() => applyClientTint(".fly-windows"));

  // The Neocom's buttons (play/neocom.ts) and the app panel each opens.
  const NEOCOM_TABS: Record<string, TabID> = {
    agency: "finder", mail: "mail", inventory: "inventory", assets: "assets", wallet: "wallet", market: "market",
    fitting: "fitting", map: "travel", charactersheet: "characterSheet", chat: "chat",
  };

  let session = $state<Session | null>(null);
  let stage = $state<"login" | "select" | "entering" | "game">("login");
  let error = $state("");
  let username = $state("");
  let password = $state("");
  let wins = $state<WinState[]>([]);
  const focusedId = $derived(wins.length ? wins.reduce((a, b) => (b.z > a.z ? b : a)).id : null);

  // The pilot's slices, once there is a session.
  const characters = $derived(session?.store.character);
  const flight = $derived(session?.store.flight);
  const station = $derived(session?.store.station);
  const targeting = $derived(session?.store.targeting);
  const fitting = $derived(session?.store.fitting);
  const inventory = $derived(session?.store.inventory);

  // A refusal the server gave an order (a lock, a module, a move, a fit, an item's move), as the client puts it up:
  // the flow says some in the client's own dialogs (actionErrorSaid); the rest are said here, once each, in space on
  // the view's notice line and docked under the lobby's Undock button.
  const seenRefusals = new Map<string, string | null>();
  $effect(() => {
    const slices: [string, { actionError: string | null; actionErrorSaid?: boolean } | undefined][] = [
      ["targeting", $targeting], ["flight", $flight], ["fitting", $fitting], ["inventory", $inventory],
    ];
    for (const [key, slice] of slices) {
      const message = slice?.actionError ?? null;
      if (message === (seenRefusals.get(key) ?? null)) continue;
      seenRefusals.set(key, message);
      if (!message || slice?.actionErrorSaid === true) continue;
      if (view) view.toast(message); else error = message;
    }
  });
  const docked = $derived(stage === "game" && session ? deriveDocked($flight?.status ?? null, $station?.online ?? null) : true);

  async function signIn(e: Event) {
    e.preventDefault();
    error = "";
    const s = createSession();
    try {
      await s.flow.login(username.trim(), password);
      session = s;
      stage = "select";
    } catch (err) {
      error = (err as Error).message;
    }
  }

  let live: LivePark | null = null;
  let spaceClaimed: Session | null = null;
  let chosenCharacterID = $state<number | null>(null);
  async function enter(characterID: number) {
    if (!session) return;
    chosenCharacterID = characterID;
    stage = "entering";
    error = "";
    try {
      // The app's own selection: login calls, the lost-drone check, the station panel (flow.pilotSelected).
      await session.flow.selectCharacter(characterID);
      session.flow.setLivePush(true);
      session.flow.setForeground(true);
      // The rack's data: the fitting (flow.loadFitting) and which modules run (the space read's activeModuleIDs,
      // 1 Hz, the agreed rate: a claim held while the pilot plays, released on leaving).
      void session.flow.loadFitting().catch(() => {});
      session.flow.startSpacePolling();
      spaceClaimed = session;
      // A few older calls read the tab's token (App.svelte does the same for its pilot in front).
      const token = session.flow.sessionToken();
      if (token) setSessionToken(token);
      live = new LivePark();
      live.connect(withTokenQuery("/api/play/destiny", token));
      (window as unknown as { __session: unknown }).__session = session;
      stage = "game";
      // The client's chat window, with Local, is up from the start.
      open("chat");
    } catch (err) {
      error = (err as Error).message;
      stage = "select";
    }
  }

  // One window layer for every window of the play mode: the app's (DesktopWindow), its info windows, and the space
  // view's own (overview, selected item, the scanner). The one last clicked or opened goes on top of all of them.
  let windowsEl = $state<HTMLDivElement | null>(null);
  function topZ(except?: Element): number {
    let top = 0;
    for (const el of windowsEl?.querySelectorAll(".win, .pw") ?? []) {
      if (el === except) continue;
      const z = Number(getComputedStyle(el).zIndex);
      if (Number.isFinite(z)) top = Math.max(top, z);
    }
    return top;
  }
  /** An app window brought above everything else in the layer. */
  function raiseApp(id: TabID) {
    const top = topZ();
    wins = wins.map((w) => (w.id === id && w.z <= top ? { ...w, z: top + 1 } : w));
  }
  const windowLayer = {
    get element() { return windowsEl!; },
    raise(el: HTMLElement) { el.style.zIndex = String(topZ(el) + 1); },
  };
  const infoHost: InfoWindowHost = {
    get element() { return windowsEl ?? document.body; },
    mobile: false,
    topZ: () => topZ(),
    reveal: () => {},
  };
  // Show Info asked anywhere on the page (a link in a panel, the radial menu) opens in the pilot's info windows, as the
  // app's own does (App.svelte).
  let servedInfoRequest = showInfoRequests.get()?.n ?? 0;
  $effect(() => showInfoRequests.subscribe((request) => {
    if (!request || request.n <= servedInfoRequest || !session) return;
    servedInfoRequest = request.n;
    void session.flow.infoWindows.show(request.subject, request.options).catch((error) => {
      if (error?.code !== "SESSION_REQUEST_RETIRED") notify({ kind: "danger", title: "Show Info", detail: error instanceof Error ? error.message : String(error) });
    });
  }));

  // The lobby's services, each opening the app's window for it (the client's service buttons, serviceBtn.py, with
  // its window icons): those the play mode has a window for.
  const LOBBY_SERVICES: { label: string; icon: string; tab: TabID }[] = [
    { label: "Fitting", icon: "fitting", tab: "fitting" },
    { label: "Market", icon: "market", tab: "market" },
    { label: "Item Hangar", icon: "itemhangar", tab: "inventory" },
    { label: "Industry", icon: "industry", tab: "industry" },
    { label: "Contracts", icon: "contracts", tab: "contracts" },
    { label: "Agents", icon: "agent", tab: "finder" },
  ];

  // The hangar's ship and the Neocom while docked.
  let hangarHost = $state<HTMLDivElement | null>(null);
  let neocomHost = $state<HTMLDivElement | null>(null);
  $effect(() => {
    if (!hangarHost) return;
    const hangar = new HangarView();
    hangarHost.appendChild(hangar.root);
    (window as unknown as { __hangar: unknown }).__hangar = hangar;
    const stop = $effect.root(() => {
      // the ship flown: the flight's word of it, else the character's row (the flight is not read while docked)
      $effect(() => {
        const row = ($characters?.characters ?? []).find((c) => c.characterID === chosenCharacterID);
        void hangar.show($flight?.status?.shipTypeID ?? row?.shipTypeID ?? null);
      });
    });
    return () => { stop(); hangar.dispose(); };
  });
  $effect(() => {
    if (!neocomHost) return;
    const neocom = new Neocom((id) => { const tab = NEOCOM_TABS[id]; if (tab) open(tab); });
    neocomHost.appendChild(neocom.root);
    return () => neocom.root.remove();
  });

  function open(tab: TabID) { wins = openWindow(wins, tab); raiseApp(tab); }

  // The client's keys for its windows (eveCommands.py): Alt and a letter. Alt+D and V (the directional scanner) are
  // the space view's own.
  const ALT_KEYS: Record<string, TabID> = {
    KeyP: "scanner", KeyC: "inventory", KeyF: "fitting", KeyI: "mail", KeyR: "market", KeyW: "wallet",
    KeyA: "characterSheet", KeyX: "skills", KeyE: "locations", KeyM: "finder",
  };
  function onKey(e: KeyboardEvent) {
    if (stage !== "game" || !e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const tab = ALT_KEYS[e.code];
    if (!tab) return;
    e.preventDefault();
    const shown = wins.find((w) => w.id === tab);
    wins = shown ? closeWindow(wins, tab) : openWindow(wins, tab);
  }

  // Space: the SpaceView, made when the pilot is in space and let go when docked.
  let spaceHost = $state<HTMLDivElement | null>(null);
  let view: SpaceView | null = null;
  $effect(() => {
    if (stage !== "game" || docked || !spaceHost || !session || !live) return;
    const s = session;
    const act = bridgeDo(s.flow.requestOptions());
    const st = s.store.station.get().station;
    const v = new SpaceView(live, {
      gotoDirection: (x, y, z) => act("beyonce", "CmdGotoDirection", [x, y, z]).then(() => undefined),
      stop: () => s.flow.stopShip(),
      approach: (id) => s.flow.approach(id),
      // The client's default ranges where none is chosen (defaultRangeUtils.DEFAULT_RANGES: orbit and keep at range
      // 1,000 m, warp to 0 m); the radial menu chooses one by how far out it is let go.
      orbit: (id, range) => s.flow.orbit(id, range ?? 1000),
      keepAtRange: (id, range) => s.flow.keepAtRange(id, range ?? 1000),
      alignTo: (id) => s.flow.alignTo(id),
      warpTo: (id, range) => s.flow.warpTo(id, range ?? 0),
      dock: (id) => s.flow.dock(id),
      // directionalScanSvc.DirectionalScan: scanMgr.ConeScan(scanAngle, scanRange, *direction).
      coneScan: (angle, range, x, y, z) => act("scanMgr", "ConeScan", [angle, range, x, y, z]),
      openCargo: (id) => s.flow.openCargo(id),
      // The flow says a refused order as the client does (its dialog: "You are not within maximum jumping distance")
      // and does not throw; a jump it refused is one the view's gate effect must not wait on.
      jump: async (id) => {
        await s.flow.jump(id, 0);
        const refused = s.store.flight.get().actionError;
        if (refused) throw Object.assign(new Error(refused), { said: s.store.flight.get().actionErrorSaid === true });
      },
      lock: (id) => s.flow.lockTarget(id),
      unlock: (id) => s.flow.unlockTarget(id),
      // What is locked comes from the session's targeting slice, kept by the flow's lock events and reads.
      targets: async () => {
        const t = s.store.targeting.get();
        return { targetIDs: [...(t.lockedTargetIDs ?? [])], targeterIDs: [...((t as { lockedByIDs?: number[] }).lockedByIDs ?? [])] };
      },
    }, { system: st?.solarSystemName ?? "", security: st?.security ?? null }, {
      onNeocom: (id) => { const tab = NEOCOM_TABS[id]; if (tab) open(tab); },
      windowLayer: windowsEl ? windowLayer : undefined,
      undocking: () => performance.now() - undockedAt < 20000,
      showInfo: (itemID, typeID) => {
        void s.flow.infoWindows.show({ kind: "spaceObject", itemID, typeID }, {}).catch((error) => {
          if (error?.code !== "SESSION_REQUEST_RETIRED") notify({ kind: "danger", title: "Show Info", detail: error instanceof Error ? error.message : String(error) });
        });
      },
      rack: {
        modules: () => {
          const active = new Set(s.store.space.get().snapshot?.ship?.activeModuleIDs ?? []);
          const cycles = s.store.targeting.get().moduleCycles ?? {};
          const now = Date.now();
          const out: HudModule[] = [];
          for (const slot of s.store.fitting.get().slots ?? []) {
            const m = slot.module;
            if (!m || (slot.family !== "high" && slot.family !== "mid" && slot.family !== "low")) continue;
            // The cycle's start and length are the server's effect notice's (OnGodmaShipEffect, riding an OnMultiEvent).
            const cycle = cycles[m.itemID] ?? null;
            const pct = cycleProgressPercent(cycle, now);
            out.push({ family: slot.family, index: slot.index, itemID: m.itemID, typeID: m.typeID, name: typeNames[String(m.typeID)]?.[0] ?? undefined, online: m.online, active: active.has(m.itemID), icon: typeIconUrl(m.typeID) ?? "", cycle: pct === null ? null : pct / 100 });
          }
          return out;
        },
        capacitor: () => ({
          max: s.store.fitting.get().resources?.capacitor?.total ?? null,
          ratio: s.store.space.get().snapshot?.ship?.capacitorRatio ?? null,
        }),
        // A click switches the module as the app's rack does (ModuleRack.svelte): on, at the first locked target; off.
        use: async (m) => {
          const running = (s.store.space.get().snapshot?.ship?.activeModuleIDs ?? []).includes(m.itemID);
          if (running) await s.flow.deactivateModule(m.itemID, { typeID: m.typeID });
          else await s.flow.activateModule(m.itemID, { typeID: m.typeID, targetID: s.store.targeting.get().lockedTargetIDs?.[0] });
        },
      },
    });
    spaceHost.appendChild(v.root);
    view = v;
    // The client's drones window comes up in space for a ship with a drone bay.
    void s.flow.loadDrones().then(() => {
      const d = s.store.drones.get();
      if ((d.limits.droneBandwidth ?? 0) > 0 || (d.bay?.length ?? 0) > 0) open("drones");
    }).catch(() => {});
    (window as unknown as { __play: unknown }).__play = { live, view: v, session: s };
    // A wreck or a can opened by Open Cargo: the inventory window opened or raised on it (Inventory.OpenOrShow).
    let servedCargo = s.flow.cargoShown.get()?.n ?? 0;
    const stopCargo = s.flow.cargoShown.subscribe((shown) => {
      if (shown === null || shown.n === servedCargo) return;
      servedCargo = shown.n;
      open("inventory");
    });
    // Damage numbers: each new entry of the damage log (the client's damage notifications) floats up in space.
    let lastDamageID = s.store.targeting.get().damageLog.at(-1)?.id ?? 0;
    const stopDamage = s.store.targeting.subscribe((t) => {
      for (const d of t.damageLog) if (d.id > lastDamageID) v.showDamage(d);
      lastDamageID = t.damageLog.at(-1)?.id ?? lastDamageID;
    });
    return () => { stopCargo(); stopDamage(); v.dispose(); view = null; };
  });

  // The client's view transitions (ui/view/transitions.py, viewStateConfig.py): docking (ToHangarTransition) fades to
  // black in 0.5 s and the station in over 2 s; undocking (StationToSpaceTransition, fadeTimeMS 500, fadeOutTimeMS
  // 1000) fades to black in 0.5 s and space in over 1 s once the ship is there (GetBallWaitForModel).
  let fadeEl = $state<HTMLDivElement | null>(null);
  /** From where the black is now to `opacity` over `ms` (an animation of its own: no frame needs to come between). */
  function fadeTo(opacity: number, ms: number, start?: number) {
    if (!fadeEl) return;
    const from = start ?? (Number(getComputedStyle(fadeEl).opacity) || 0);
    for (const a of fadeEl.getAnimations()) a.cancel();
    fadeEl.animate([{ opacity: from }, { opacity }], { duration: Math.max(1, ms), fill: "forwards", easing: "linear" });
  }
  let wasDocked: boolean | null = null;
  $effect(() => {
    if (stage !== "game") return;
    const now = docked;
    if (wasDocked === null) { wasDocked = now; return; }
    if (now === wasDocked) return;
    wasDocked = now;
    if (now) { fadeTo(0, 2000, 1); return; }
    fadeTo(1, 0, 1);
    // in space: the black holds until the pilot's ship is in the park (or 4 s at most), then lifts
    const started = performance.now();
    const wait = () => {
      const ship = live?.hello?.shipID ?? null;
      const there = !!live?.park.validState && ship !== null && live.park.ballpark.balls.has(ship);
      if (there || performance.now() - started > 4000) fadeTo(0, 1000); else setTimeout(wait, 100);
    };
    setTimeout(wait, 100);
  });

  let undockedAt = -Infinity;
  async function undock() {
    if (!session) return;
    error = "";
    undockedAt = performance.now();
    fadeTo(1, 500);
    try { await session.flow.undock(); } catch (err) { error = (err as Error).message; fadeTo(0, 300); }
  }

  onDestroy(() => { view?.dispose(); live?.close(); spaceClaimed?.flow.stopSpacePolling(); });
</script>

<svelte:window onkeydown={onKey} />

{#if stage === "login"}
  <div class="screen"><form class="login-box" onsubmit={signIn}>
    <h1>EVE</h1>
    <label for="pu">Username</label><input id="pu" bind:value={username} autocomplete="username" />
    <label for="pp">Password</label><input id="pp" type="password" bind:value={password} autocomplete="current-password" />
    <button class="btn primary" type="submit">Log in</button>
    <div class="error">{error}</div>
  </form></div>
{:else if stage === "select" || stage === "entering"}
  <div class="screen">
    <div class="select-title">{stage === "entering" ? "Entering…" : "Select character"}</div>
    <div class="select">
      {#each $characters?.characters ?? [] as c (c.characterID)}
        <button class="char-card" disabled={stage === "entering"} onclick={() => enter(c.characterID)}>
          <img alt="" src={`http://127.0.0.1:26001/Character/${c.characterID}_256.jpg`} />
          <div class="who"><div class="name">{c.characterName}</div><div class="where">{c.shipName ?? ""}</div></div>
        </button>
      {/each}
    </div>
    {#if error}<div class="error" style="position:absolute;bottom:40px">{error}</div>{/if}
  </div>
{:else if session}
  {#if docked}
    <!-- Docked: the ship in its hangar, the Neocom, and the client's Station Services window (dockedUI/lobbyWnd.py:
         280 px at the right edge, the station's name over its owner, the Undock button, the station's services). -->
    <div class="station">
      <div class="fly-hangar" bind:this={hangarHost}></div>
      <div class="fly-neocom" bind:this={neocomHost}></div>
      <div class="pw fly-lobby">
        <div class="pw-head"><img class="pw-icon" alt="" src={clientTexture("res:/UI/Texture/WindowIcons/docking.png")} /><span class="pw-caption">Station Services</span></div>
        <div class="pw-body lobby-body">
          <div class="station-name">{$station?.station?.stationName ?? "Station"}</div>
          <div class="station-sub">{$station?.station?.solarSystemName ?? ""}{#if typeof $station?.station?.security === "number"}<span class="lobby-sec"> {$station.station.security.toFixed(1)}</span>{/if}</div>
          <button class="undock" onclick={undock}>Undock</button>
          {#if error}<div class="error lobby-error">{error}</div>{/if}
          <div class="lobby-services">
            {#each LOBBY_SERVICES as svc (svc.label)}
              <button class="lobby-svc" title={svc.label} onclick={() => open(svc.tab)}><img alt="" src={clientTexture(`res:/UI/Texture/WindowIcons/${svc.icon}.png`)} /><span>{svc.label}</span></button>
            {/each}
          </div>
          <PlayLobbyTabs {session} onOpenAgents={() => open("agents")} />
        </div>
      </div>
    </div>
  {:else}
    <div class="fly-space" bind:this={spaceHost}></div>
  {/if}

  <!-- The app's windows over space or the station, in front of the 3D view and under nothing else. -->
  <div class="fly-fade" bind:this={fadeEl}></div>

  <div class="fly-windows" bind:this={windowsEl}>
    {#each wins as win (win.id)}
      <ErrorBoundary name={tabLabel(win.id)}>
        <DesktopWindow
          {win}
          title={tabLabel(win.id)}
          focused={win.id === focusedId}
          onFocus={() => { wins = focusWindow(wins, win.id); raiseApp(win.id); }}
          onClose={() => (wins = closeWindow(wins, win.id))}
          onToggleMinimize={() => (wins = toggleMinimize(wins, win.id))}
          onMove={(x, y) => (wins = moveWindow(wins, win.id, x, y))}
          onResize={(w, h) => (wins = resizeWindow(wins, win.id, w, h))}
        >
          <PanelHost store={session.store} flow={session.flow} tab={win.id} onOpen={(t) => open(t)} onClose={() => (wins = closeWindow(wins, win.id))} />
        </DesktopWindow>
      </ErrorBoundary>
    {/each}
  </div>

  <NoticeBridge store={session.store} />
  <ErrorBoundary name="Server question"><ServerQuestion store={session.store} flow={session.flow} /></ErrorBoundary>
  <ErrorBoundary name="Client dialogs"><ClientDialogs {session} inFront={true} /></ErrorBoundary>
  <ErrorBoundary name="Info windows"><InfoWindows {session} inFront={true} host={windowsEl ? infoHost : null} /></ErrorBoundary>
  <Toasts />
{/if}

<style>
  .fly-space { position: fixed; inset: 0; }
  .fly-windows { position: fixed; inset: 0; pointer-events: none; z-index: 20; }
  .fly-fade { position: fixed; inset: 0; background: #000; pointer-events: none; z-index: 15; opacity: 0; }
  /* the layer's windows take the pointer; the info windows' own full-size layer does not (its windows do) */
  .fly-windows :global(> :not(.info-window-layer)) { pointer-events: auto; }
  .fly-hangar { position: absolute; inset: 0; }
  .fly-hangar :global(.hangar-view) { position: absolute; inset: 0; }
  .fly-neocom { position: absolute; left: 0; top: 0; bottom: 0; width: 44px; }
  .fly-lobby { left: auto; right: 16px; top: 16px; width: 280px; min-height: 260px; z-index: 5; }
  .lobby-body { padding: 10px 12px 14px; }
  .lobby-body .station-name { position: static; font-size: 18px; color: #f0f1ee; line-height: 1.25; }
  .lobby-body .station-sub { position: static; margin-top: 2px; color: var(--text-dim); font-size: 12px; }
  .lobby-sec { color: #5fd38c; }
  .lobby-body .undock { position: static; display: block; width: 100%; margin: 12px 0 10px; }
  .lobby-error { position: static; margin: 0 0 8px; }
  .lobby-services { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .lobby-svc { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 2px; background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08); color: #c8ccc8; font: 11px/1.2 var(--font); cursor: pointer; }
  .lobby-svc:hover { background: rgba(255, 255, 255, 0.10); border-color: rgba(255, 255, 255, 0.2); }
  .lobby-svc img { width: 32px; height: 32px; }
  .char-card { padding: 0; text-align: left; color: inherit; font: inherit; }
</style>
