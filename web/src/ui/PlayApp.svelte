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
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { openWindow, closeWindow, focusWindow, moveWindow, resizeWindow, toggleMinimize, type WinState } from "./desktop.ts";
  import { tabLabel, deriveDocked, type TabID } from "./tabs.ts";
  import { LivePark } from "../three/livePark.ts";
  import { SpaceView } from "../play/spaceView.ts";
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
  async function enter(characterID: number) {
    if (!session) return;
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
      stage = "game";
      // The client's chat window, with Local, is up from the start.
      open("chat");
    } catch (err) {
      error = (err as Error).message;
      stage = "select";
    }
  }

  function open(tab: TabID) { wins = openWindow(wins, tab); }

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
      jump: (id) => s.flow.jump(id, 0),
      lock: (id) => s.flow.lockTarget(id),
      unlock: (id) => s.flow.unlockTarget(id),
      // What is locked comes from the session's targeting slice, kept by the flow's lock events and reads.
      targets: async () => {
        const t = s.store.targeting.get();
        return { targetIDs: [...(t.lockedTargetIDs ?? [])], targeterIDs: [...((t as { lockedByIDs?: number[] }).lockedByIDs ?? [])] };
      },
    }, { system: st?.solarSystemName ?? "", security: st?.security ?? null }, {
      onNeocom: (id) => { const tab = NEOCOM_TABS[id]; if (tab) open(tab); },
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
    return () => { v.dispose(); view = null; };
  });

  async function undock() {
    if (!session) return;
    error = "";
    try { await session.flow.undock(); } catch (err) { error = (err as Error).message; }
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
    <div class="station">
      <div class="station-name">{$station?.station?.stationName ?? "Station"}</div>
      <div class="station-sub">{$station?.station?.solarSystemName ?? ""}</div>
      <button class="btn undock" onclick={undock}>Undock</button>
      {#if error}<div class="error" style="position:absolute;right:24px;top:80px">{error}</div>{/if}
      <div class="fly-station-neocom">
        {#each Object.entries(NEOCOM_TABS) as [key, tab] (key)}<button class="btn" onclick={() => open(tab)}>{tabLabel(tab)}</button>{/each}
      </div>
    </div>
  {:else}
    <div class="fly-space" bind:this={spaceHost}></div>
  {/if}

  <!-- The app's windows over space or the station, in front of the 3D view and under nothing else. -->
  <div class="fly-windows">
    {#each wins as win (win.id)}
      <ErrorBoundary name={tabLabel(win.id)}>
        <DesktopWindow
          {win}
          title={tabLabel(win.id)}
          focused={win.id === focusedId}
          onFocus={() => (wins = focusWindow(wins, win.id))}
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
  <Toasts />
{/if}

<style>
  .fly-space { position: fixed; inset: 0; }
  .fly-windows { position: fixed; inset: 0; pointer-events: none; z-index: 20; }
  .fly-windows :global(> *) { pointer-events: auto; }
  .fly-station-neocom { position: absolute; left: 24px; bottom: 24px; display: flex; flex-wrap: wrap; gap: 6px; max-width: 60vw; }
  .char-card { padding: 0; text-align: left; color: inherit; font: inherit; }
</style>
