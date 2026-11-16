<script lang="ts">
  // R107 — ONE pilot's workspace, a pure reader of that pilot's store. Extracted
  // from App.svelte so the multibox App can mount exactly one of these (the
  // ACTIVE pilot) above the character bar while every other pilot's store+flow
  // stay live in memory. The workspace is an always-open desktop:
  //   • the Neocom launcher rail down the left (opens panels as windows),
  //   • a context header (where you are + Dock/Undock),
  //   • the desktop itself — floating, self-contained panel windows,
  //   • a fixed, collapsible top-right dock panel (Overview in space / Station
  //     services when docked), and
  //   • a persistent bottom HUD bar while in space.
  // The open windows + dock-collapse state are remembered per character. Below
  // 720px it swaps to the single-panel MobileWorkspace. All fetch/decode lives
  // in app/flow.ts; the store slices are store-contract signals.
  import Neocom from "./Neocom.svelte";
  import Desktop from "./Desktop.svelte";
  import DockPanel from "./DockPanel.svelte";
  import HudBar from "./HudBar.svelte";
  import WorkspaceHeader from "./WorkspaceHeader.svelte";
  import MobileWorkspace from "./MobileWorkspace.svelte";
  import DockWipe from "./DockWipe.svelte";
  import Toasts from "./Toasts.svelte";
  import NoticeBridge from "./NoticeBridge.svelte";
  import NotificationPopups from "./NotificationPopups.svelte";
  import DroneRecoveryNotice from "./DroneRecoveryNotice.svelte";
  import ServerQuestion from "./ServerQuestion.svelte";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { calendarView } from "./calendarView.ts";
  import { marketDetailsTarget } from "./marketDetails.ts";
  import { skillPlanTemplateTarget } from "./skillPlanTemplate.ts";
  import { shipHoldTarget } from "./shipHold.ts";
  import { windowToggleTarget } from "./windowToggle.ts";
  import { hudSetting } from "../store/hudSettings.ts";
  import { untrack } from "svelte";
  import { assetsSearchTarget } from "./assetsSearch.ts";
  import { contractsSearchTarget } from "./contractsSearch.ts";
  import { typeCompareTarget } from "./typeCompare.ts";
  import { fittingWindowTarget } from "./fittingWindowTarget.ts";
  import TargetsPanel from "./TargetsPanel.svelte";
  import AbyssInfoPanel from "./AbyssInfoPanel.svelte";
  import CustomBotReadout from "./CustomBotReadout.svelte";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { deriveDocked, type TabID } from "./tabs.ts";
  import { isGlobalTab } from "./globalWindow.ts";
  import {
    openWindow,
    focusWindow,
    closeWindow,
    moveWindow,
    resizeWindow,
    toggleMinimize,
    focusedId as computeFocusedId,
    loadLayout,
    saveLayout,
    placeOnDesktop,
    registerPlace,
    DEFAULT_DOCK_WIDTH,
    DEFAULT_TARGETS_POS,
    type RegisteredPlace,
    type WinState,
  } from "./desktop.ts";
  import type { ClientStore } from "../store/clientStore.ts";
  import type { AppFlow } from "../app/flow.ts";
  import type { Session } from "../app/sessions.ts";

  let {
    store,
    flow,
    sessions,
    globalOpenIds,
    onOpenGlobal,
    globalWins,
    onToggleGlobalMinimize,
    openRequest,
    onOpenRequestServed,
    sessionID,
    onInfoHost,
  }: {
    store: ClientStore;
    flow: AppFlow;
    /**
     * EVERY held pilot, not just this workspace's own. A Workspace is otherwise
     * a pure reader of ONE pilot's store (see the R107 note above), and this is
     * the deliberate exception: the Bot Manager has to show what all of them are
     * flying. It is passed straight through to PanelHost, which hands it to that
     * one panel and no other.
     */
    sessions?: readonly Session[];
    /**
     * The global-layer tabs currently on screen, so the rail can light their
     * entries like any other open window. App owns that layer (globalWindow.ts);
     * a workspace only reads it.
     */
    globalOpenIds?: ReadonlySet<TabID>;
    /** Hand a global tab up to App, which owns the layer it opens on. */
    onOpenGlobal?: (id: TabID) => void;
    /**
     * The global windows themselves, passed through to the desktop's window
     * STRIP — never to its surface, which App draws on its own layer. A
     * put-away window's handle belongs in the one strip a player already looks
     * at, not in a second one that exists because the window lives on another
     * layer. See Desktop.svelte's own note.
     */
    globalWins?: readonly WinState[];
    /** Put a global window away, or bring it back. App owns the layer. */
    onToggleGlobalMinimize?: (id: TabID) => void;
    /**
     * A panel App wants opened HERE, as a counter that App bumps.
     *
     * A counter retains repeated requests: the global Bot Manager's Edit button asks for the Bot Builder, and
     * asking a second time for the panel already open must still raise it. This
     * is the one path INTO a workspace from above it, and it is deliberately a
     * prop rather than a registered callback — data flows down, the same shape
     * `dockInventoryPing` already uses.
     */
    openRequest?: { readonly id: TabID; readonly n: number; readonly sessionID: string } | null;
    /** Tell App this workspace has served the request, so it can drop it. */
    onOpenRequestServed?: () => void;
    /** This workspace's own session id, so it can tell whose request is whose. */
    sessionID?: string;
    onInfoHost?: (sessionID: string, host: InfoWindowHost | null) => void;
  } = $props();

  // The store's identity is stable for this component's lifetime (App keys each
  // Workspace by session id, so store/flow never change under a mounted one);
  // capturing the slice signals once is intended.
  // svelte-ignore state_referenced_locally
  const session = store.session;
  // svelte-ignore state_referenced_locally
  const station = store.station;
  // svelte-ignore state_referenced_locally
  const flight = store.flight;

  // Docked vs in space, from the authoritative flag (rule lives in tabs.ts).
  const isDocked = $derived(deriveDocked($flight.status, $station.online));

  // Narrow viewport -> the simplified single-panel mobile UI instead of the
  // floating-window desktop. matchMedia so it flips live at the breakpoint.
  let isMobile = $state(false);
  $effect(() => {
    const mq = window.matchMedia("(max-width: 720px)");
    const update = (): void => { isMobile = mq.matches; };
    update();
    mq.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  });

  // ── the desktop: open windows + the collapsible dock panel ──────────────
  let wins = $state<WinState[]>([]);
  // Each window's place as the client keeps it by its ID (desktop.ts RegisteredPlace): registered as it is moved or
  // resized, and taken when it is opened again.
  let places = $state<Record<string, RegisteredPlace>>({});
  let desktopView = $state<{ surfaceSize(): { readonly w: number; readonly h: number } | null } | null>(null);
  function registerWindowPlace(id: TabID): void {
    const win = wins.find((each) => each.id === id);
    const desktop = desktopView?.surfaceSize() ?? null;
    if (win && desktop) places = registerPlace(places, win, desktop);
  }
  const hudTopAligned = hudSetting("shipuialigntop");
  let dockCollapsed = $state(false);
  let dockWidth = $state(DEFAULT_DOCK_WIDTH);
  /**
   * ⚠ THE PREFERENCE, NOT THE FLAG. The player can ask the docked Station panel
   * to take the whole work area, which HIDES the desktop. That must be
   * impossible in space — a pilot who undocked into a hidden desktop, no HUD
   * and no locked-target panel would have no way back to any of them.
   *
   * So the real flag is DERIVED (`stationExpanded`, below) rather than reset by
   * an effect: undocking cannot leave it stale, because there is no stored
   * state to be stale. The preference itself is remembered, so docking again
   * brings the expanded panel back.
   */
  let expandPreferred = $state(false);
  let targetsX = $state(DEFAULT_TARGETS_POS.x);
  let targetsY = $state(DEFAULT_TARGETS_POS.y);
  const stationExpanded = $derived(isDocked && expandPreferred);
  const openIds = $derived(new Set(wins.map((w) => w.id)));
  const focused = $derived(computeFocusedId(wins));
  const infoTop = (): number => Math.max(0, ...flow.infoWindows.state.get().map(w => w.z));
  const topZ = (): number => Math.max(infoTop(), calendarView(flow).topZ(), ...wins.map(w => w.z));

  // Opening a window GIVES THE WORK AREA BACK. While the Station panel has the
  // whole column the desktop is hidden, so a window opened into it would appear
  // nowhere at all and the rail would look broken. Asking for a panel is asking
  // for the canvas it lives on.
  //
  // ⚠ Deliberately not in `openFromNeocom`: while docked, picking "Inventory &
  // Ship" there folds into the dock panel instead of opening a window, and that
  // pick must not throw the expansion away.
  const open = (id: TabID): void => {
    // ⚠ A GLOBAL TAB NEVER LANDS ON THIS DESKTOP. It opens on App's layer above
    // every workspace, because it outlives the pilot switch that tears this one
    // down (globalWindow.ts). It also must not clear the station expansion:
    // nothing was added to the hidden desktop, so there is nothing to give the
    // work area back for.
    if (isGlobalTab(id)) {
      onOpenGlobal?.(id);
      return;
    }
    expandPreferred = false;
    const registered = places[id];
    const desktop = desktopView?.surfaceSize() ?? null;
    const place = registered ? placeOnDesktop(registered, desktop ?? { w: registered.dw, h: registered.dh }) : null;
    wins = openWindow(wins, id, id === "medalDesigner" ? { w: 465, h: 630 } : undefined, id === "medalDesigner" && place ? { ...place, w: 465, h: 630 } : place);
    const z = topZ() + 1; wins = wins.map(w => w.id === id ? { ...w, z } : w);
  };
  // The Neocom pick, with one de-dupe: while docked, Inventory & Ship IS the
  // permanent dock panel — expand it, snap it to the Ship Inventory tab (the
  // visible response when it was already expanded, e.g. sitting on Station
  // Services), and fold any open inventory window in, instead of putting a
  // second identical copy on screen. In space, and for every other tab, it
  // opens/focuses a window as always.
  let dockInventoryPing = $state(0);
  const openFromNeocom = (id: TabID): void => {
    if (id === "inventory" && isDocked) {
      dockCollapsed = false;
      dockInventoryPing += 1;
      wins = closeWindow(wins, "inventory");
      return;
    }
    open(id);
  };
  // The rail highlights what is on screen. While docked, the expanded dock
  // panel IS the Inventory & Ship content, so its entry lights up like an
  // open window's would (openIds itself only tracks floating windows).
  // The global layer's windows are on screen too, so they light up in the rail
  // exactly like a workspace window — from here the distinction is invisible,
  // which is the point.
  const neocomOpenIds = $derived(
    new Set<TabID>([
      ...openIds,
      ...(globalOpenIds ?? []),
      ...(isDocked && !dockCollapsed ? (["inventory"] as TabID[]) : []),
    ]),
  );
  const focus = (id: TabID): void => { const z = topZ() + 1; wins = focusWindow(wins, id).map(w => w.id === id ? { ...w, z } : w); };
  const close = (id: TabID): void => {
    // The Fitting window's close (fittingWnd.Close, 887 to 905): with a simulation shown, the client's question first
    // (ShouldContinueAfterAskingAboutSwitchingShips: ExitSimulationWarning, where it was changed); on No the window
    // stays; else it closes, and the simulation ends with it.
    if (id === "fitting") {
      void flow.exitSimulation().then((leave) => {
        if (leave) wins = closeWindow(wins, id);
      }).catch(() => {});
      return;
    }
    wins = closeWindow(wins, id);
    if (id === "medalDesigner") flow.closeMedalDesigner();
    // The Industry window's close is an act of its own to the game's client, which then lets go what it kept open
    // for the job the window had. A window put away, or taken off the surface by an undock, is not closed.
    if (id === "industry") void flow.industryWindowClosed();
  };
  const move = (id: TabID, x: number, y: number): void => { wins = moveWindow(wins, id, x, y); registerWindowPlace(id); };
  const resize = (id: TabID, w: number, h: number): void => { wins = resizeWindow(wins, id, w, h); registerWindowPlace(id); };
  const minimize = (id: TabID): void => { const restore = wins.some(w => w.id === id && w.minimized); wins = toggleMinimize(wins, id); if (restore) focus(id); };
  const toggleDock = (): void => { dockCollapsed = !dockCollapsed; };

  // Restore the saved layout when a character comes online (keyed by characterID)
  // and clear it on logout, so a different pilot gets their own desktop. Guarded
  // on the loaded id so it runs once per character.
  let loadedFor = $state<number | null>(null);
  $effect(() => {
    const online = $station.online;
    if (online && loadedFor !== online.characterID) {
      const saved = loadLayout(online.characterID);
      // Member Details opens for a character (memberDetails.OpenMemberDetails); keep its place, not an empty window.
      wins = saved ? saved.wins.filter(win => (win.id !== "memberDetails" || flow.memberDetailsShown.get() !== null) && (win.id !== "medalDesigner" || flow.medalDesignerShown.get() !== null)) : [];
      dockCollapsed = saved ? saved.dockCollapsed : false;
      dockWidth = saved ? saved.dockWidth : DEFAULT_DOCK_WIDTH;
      targetsX = saved ? saved.targetsX : DEFAULT_TARGETS_POS.x;
      targetsY = saved ? saved.targetsY : DEFAULT_TARGETS_POS.y;
      expandPreferred = saved ? saved.stationExpanded : false;
      places = saved?.places ? { ...saved.places } : {};
      loadedFor = online.characterID;
    } else if (!online && loadedFor !== null) {
      wins = [];
      dockCollapsed = false;
      dockWidth = DEFAULT_DOCK_WIDTH;
      targetsX = DEFAULT_TARGETS_POS.x;
      targetsY = DEFAULT_TARGETS_POS.y;
      expandPreferred = false;
      places = {};
      loadedFor = null;
    }
  });

  // Persist on any layout change, debounced so a drag doesn't hammer storage.
  $effect(() => {
    const id = loadedFor;
    const layout = {
      wins: wins.map((w) => ({ ...w })),
      dockCollapsed,
      dockWidth,
      targetsX,
      targetsY,
      stationExpanded: expandPreferred,
      places: { ...places },
    };
    if (id === null) return;
    const handle = setTimeout(() => saveLayout(id, layout), 300);
    return () => clearTimeout(handle);
  });

  // A type's market details asked for from outside the market window (marketDetails.ts: marketutils.ShowMarketDetails,
  // as the skill windows ask for the Skill Injector's): the market window opened, which takes the type and reads its
  // market. It watches the request counter, as the other request effects do, and starts at the count it finds, so
  // that a workspace mounted later does not answer a request made before it.
  // A search of the pilot's things asked for from outside the assets window (assetsSearch.ts: FindInPersonalAssets):
  // the assets window opened, which takes the text and searches; watched as the market's details are, below.
  let servedAssetsSearches = assetsSearchTarget.requests.get();
  const assetsSearchRequests = assetsSearchTarget.requests;
  $effect(() => {
    const count = $assetsSearchRequests;
    if (count === servedAssetsSearches) return;
    servedAssetsSearches = count;
    open("assets");
  });

  // Contracts of a type asked for from outside the contracts window (contractsSearch.ts: contracts.FindRelated): the
  // contracts window opened, which takes the type and searches.
  let servedContractsSearches = contractsSearchTarget.requests.get();
  const contractsSearchRequests = contractsSearchTarget.requests;
  $effect(() => {
    const count = $contractsSearchRequests;
    if (count === servedContractsSearches) return;
    servedContractsSearches = count;
    open("contracts");
  });

  // Types asked to be compared from outside the compare tool (typeCompare.ts: menusvc.CompareType): the tool opened,
  // which takes the types and adds them.
  let servedCompareRequests = typeCompareTarget.requests.get();
  const compareRequests = typeCompareTarget.requests;
  $effect(() => {
    const count = $compareRequests;
    if (count === servedCompareRequests) return;
    servedCompareRequests = count;
    open("compare");
  });

  // The Fitting window asked for from outside it (fittingWindowTarget.ts: the fitting display window's Simulate): opened,
  // or raised where it is open (FittingWindow.Maximize).
  let servedFittingWindowRequests = fittingWindowTarget.requests.get();
  const fittingWindowRequests = fittingWindowTarget.requests;
  $effect(() => {
    const count = $fittingWindowRequests;
    if (count === servedFittingWindowRequests) return;
    servedFittingWindowRequests = count;
    open("fitting");
  });

  // A new skill plan asked for (skillPlanTemplate.ts: CreateSkillPlanButton, cmd.OpenSkillsWindow): the Skills window.
  let servedSkillPlanRequests = skillPlanTemplateTarget.requests.get();
  const skillPlanRequests = skillPlanTemplateTarget.requests;
  $effect(() => {
    const count = $skillPlanRequests;
    if (count === servedSkillPlanRequests) return;
    servedSkillPlanRequests = count;
    open("skills");
  });

  // A hold of the active ship asked for (shipHold.ts: the Fitting window's readouts, cmd.OpenCargoHoldOfActiveShip and
  // its kin): the inventory as the Neocom opens it, the dock panel while docked.
  let servedHoldRequests = shipHoldTarget.requests.get();
  const holdRequests = shipHoldTarget.requests;
  $effect(() => {
    const count = $holdRequests;
    if (count === servedHoldRequests) return;
    servedHoldRequests = count;
    openFromNeocom("inventory");
  });

  // A window toggled from the HUD's utility buttons (windowToggle.ts): closed where it is open, else opened; the
  // inventory as OpenCargoHoldOfActiveShip opens it, on the cargo (shipHold.ts).
  let servedToggleRequests = windowToggleTarget.requests.get();
  const toggleRequests = windowToggleTarget.requests;
  $effect(() => {
    const count = $toggleRequests;
    if (count === servedToggleRequests) return;
    servedToggleRequests = count;
    const id = untrack(() => windowToggleTarget.take());
    if (id === null) return;
    if (untrack(() => wins.some((win) => win.id === id))) {
      wins = closeWindow(wins, id);
      return;
    }
    if (id === "inventory") shipHoldTarget.ask("cargo");
    else open(id);
  });

  let servedMarketRequests = marketDetailsTarget.requests.get();
  const marketRequests = marketDetailsTarget.requests;
  $effect(() => {
    const count = $marketRequests;
    if (count === servedMarketRequests) return;
    servedMarketRequests = count;
    open("market");
  });

  // A panel App asked to be opened on THIS desktop — today, the Bot Builder,
  // requested by the Edit button in the global Bot Manager. Watches the counter
  // and not the id, so a repeated request remains observable: asking
  // twice for the same panel must still raise it, and it may have been closed or
  // buried in between.
  let mobileOpenRequest = $state<{ id: TabID; n: number } | null>(null);
  // A panel App wants opened on THIS workspace — the Bot Manager asking for the
  // Bot Builder, or for the built-in bots panel on a particular pilot.
  //
  // ⚠ IT IS ADDRESSED, NOT MERELY TIMED, and two bugs are the reason why.
  //
  // The request lives in App, above the `{#key active.id}` that remounts a
  // workspace per pilot, so a bare counter is ambiguous in both directions:
  //
  //  • Serving any request whose number we had not seen replayed OLD ones. A
  //    workspace mounted later started at zero, read a counter bumped for some
  //    earlier pilot, and opened that panel too — so opening the Bot Builder and
  //    then switching pilots opened it again on the pilot switched TO, and on
  //    every pilot after that.
  //
  //  • Seeding the mark from the counter AS IT STANDS AT MOUNT fixed that and
  //    broke the opposite case. "Set up this built-in on that pilot" switches
  //    pilots and asks for the panel in ONE tick, so by the time the new
  //    workspace mounts the counter already includes the request meant for it —
  //    which it then read as ancient history and ignored. The pilot switched and
  //    no panel opened.
  //
  // Neither is a timing problem, so neither has a timing fix. The request names
  // the pilot it is for; a workspace serves only its own and says so, and App
  // drops it once served, which is what stops a later remount finding it again.
  // A popup's click opens its panel here (notificationPopups.ts): a window on the desktop, the selection on a phone,
  // its number below nought so it is never one of App's.
  let popupOpens = 0;
  const openFromPopup = (id: TabID): void => {
    if (isMobile) {
      popupOpens += 1;
      mobileOpenRequest = { id, n: -popupOpens };
    } else {
      open(id);
    }
  };
  // Native chat windows open for the pilot whose conversation was accepted/started.
  // svelte-ignore state_referenced_locally
  const conversations = flow.conversations.state;
  let servedChatRequest = 0;
  $effect(() => {
    const request = $conversations.openSerial;
    if (!request || request === servedChatRequest) return;
    servedChatRequest = request; openFromPopup("chat");
  });
  // A can or a wreck opened by Open Cargo (flow.openCargo): the inventory window opened or raised for it, as the
  // client's Inventory.OpenOrShow opens its primary window. Each one asked after this desktop was drawn.
  // svelte-ignore state_referenced_locally
  const cargoShown = flow.cargoShown;
  let servedCargoShown = cargoShown.get()?.n ?? 0;
  $effect(() => {
    const shown = $cargoShown;
    if (shown === null || shown.n === servedCargoShown) return;
    servedCargoShown = shown.n;
    openFromPopup("inventory");
  });
  let servedOpenRequest = 0;
  // memberDetails.OpenMemberDetails: one per pilot; repeat requests raise the same member's window.
  // svelte-ignore state_referenced_locally
  const memberDetailsShown = flow.memberDetailsShown;
  // svelte-ignore state_referenced_locally
  const medalDesignerShown = flow.medalDesignerShown;
  let servedMedalDesigner = 0;
  $effect(() => {
    const request = $medalDesignerShown;
    if (request === null) { untrack(() => { wins = closeWindow(wins, "medalDesigner"); }); return; }
    if (request.n === servedMedalDesigner) return;
    servedMedalDesigner = request.n; openFromPopup("medalDesigner");
  });
  let servedMemberDetails = memberDetailsShown.get()?.n ?? 0;
  $effect(() => {
    const request = $memberDetailsShown;
    if (request === null || request.n === servedMemberDetails) return;
    servedMemberDetails = request.n;
    openFromPopup("memberDetails");
  });
  $effect(() => {
    const request = openRequest;
    if (!request || request.sessionID !== sessionID) return;
    if (request.n === servedOpenRequest) return;
    servedOpenRequest = request.n;
    // ⚠ THE MOBILE WORKSPACE HAS NO WINDOWS TO OPEN INTO. `open()` puts a window
    // on the desktop, which on a phone nothing renders — the request would be
    // silently swallowed. There the panel is a SELECTION, so the request is
    // handed down for MobileWorkspace to apply to its own.
    if (isMobile) {
      mobileOpenRequest = { id: request.id, n: request.n };
    } else {
      open(request.id);
    }
    onOpenRequestServed?.();
  });
  // Read flight status once online so the docked/in-space flag is authoritative
  // (character select does not read it). Subsequent flight steps keep it fresh.
  $effect(() => {
    if ($session.phase === "logged-in" && $station.online !== null && $flight.status === null) {
      void flow.loadFlightStatus().catch(() => {});
    }
  });
</script>

<!-- Guard: App prunes a pilot the instant its store goes offline, but this
     component can outlive that store update by a tick; render nothing rather
     than let a child dereference a null $station.online. -->
{#if $station.online === null}
  <div class="workspace-shell-empty"></div>
{:else if isMobile}
  <!-- The same transition in both workspaces: the state change is identical, so
       it would be strange for only one of them to acknowledge it. -->
  <DockWipe {isDocked} />
  <NoticeBridge {store} {flow} />
  <NotificationPopups {store} {flow} onOpen={openFromPopup} />
  <DroneRecoveryNotice {flow} />
  <ServerQuestion {store} {flow} />
  <Toasts />
  <MobileWorkspace {store} {flow} {isDocked} {sessions} openRequest={mobileOpenRequest} onInfoHost={host => { if (sessionID) onInfoHost?.(sessionID, host); }} />
{:else}
  <DockWipe {isDocked} />
  <!-- Mounted once for the whole workspace, and once each: the bridge is what
       RAISES a notice (it watches every store slice that records a refusal) and
       the flash is where one APPEARS. Both have to outlive the panel the event
       came from — that is the entire point — so neither can live in a panel. -->
  <NoticeBridge {store} {flow} />
  <NotificationPopups {store} {flow} onOpen={openFromPopup} />
  <DroneRecoveryNotice {flow} />
  <ServerQuestion {store} {flow} />
  <Toasts />
  <!-- The HUD options' Align HUD to Top (shipUI.ToggleAlign): the HUD's row above the view. -->
  <div class="workspace" class:in-space={!isDocked} class:hud-top={$hudTopAligned}>
    <!-- Every piece of always-on chrome gets its own boundary. These are mounted
         for the whole session and refresh on every poll, so before this an error
         in any one of them froze the entire tab (see ErrorBoundary.svelte). -->
    <ErrorBoundary name="Launcher rail">
      <Neocom {store} {flow} {isDocked} openIds={neocomOpenIds} focusedId={focused} onSelect={openFromNeocom} />
    </ErrorBoundary>
    <div class="work">
      <ErrorBoundary name="Workspace header">
        <WorkspaceHeader {store} {flow} {isDocked} />
      </ErrorBoundary>
      <!-- A running bot's readout, always visible while it runs, nothing when idle. -->
      <ErrorBoundary name="Bot readout">
        <CustomBotReadout {store} {flow} />
      </ErrorBoundary>
      <!-- `station-expanded` hides the desktop, so it is bound to the DERIVED
           flag and never to the preference: in space the class cannot be set
           however the preference was left. -->
      <div class="work-main" class:station-expanded={stationExpanded}>
        <ErrorBoundary name="Desktop">
          <Desktop
            bind:this={desktopView}
            {store}
            {flow}
            {sessions}
            {globalWins}
            {onToggleGlobalMinimize}
            {wins}
            {focused}
            {isDocked}
            onFocus={focus}
            onClose={close}
            onToggleMinimize={minimize}
            onMove={move}
            onResize={resize}
            onOpen={open}
            onInfoHost={host => { if (sessionID) onInfoHost?.(sessionID, host); }}
            onRevealInfo={() => { expandPreferred = false; }}
          />
        </ErrorBoundary>
        <DockPanel
          {store}
          {flow}
          {isDocked}
          inventoryPing={dockInventoryPing}
          collapsed={dockCollapsed}
          width={dockWidth}
          expanded={stationExpanded}
          onToggle={toggleDock}
          onToggleExpand={() => (expandPreferred = !expandPreferred)}
          onResize={(w) => (dockWidth = w)}
        />
        {#if !isDocked}
          <!-- The ship HUD is a CELL of the work area now, not a strip under it:
               the radar takes the top-left, the HUD the bottom-left, and the
               dock column spans both. Docked there is neither a radar nor a
               HUD, so the same grid collapses to one row and the desktop keeps
               the whole left side. -->
          <ErrorBoundary name="HUD bar">
            <!-- No `onOpen`: the HUD's nav buttons went, because every one
                 of them is a Neocom rail entry that is on screen anyway. The
                 client's own utility buttons (HudButtons) ask through
                 windowToggle.ts, which this workspace serves. -->
            <HudBar {store} {flow} />
          </ErrorBoundary>
          <ErrorBoundary name="Locked targets">
            <TargetsPanel {store} x={targetsX} y={targetsY} onMove={(nx, ny) => { targetsX = nx; targetsY = ny; }} />
          </ErrorBoundary>
          <ErrorBoundary name="Abyssal Deadspace">
            <AbyssInfoPanel {store} {flow} floating />
          </ErrorBoundary>
        {/if}
      </div>
    </div>
  </div>
{/if}
