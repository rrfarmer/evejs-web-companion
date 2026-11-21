<script lang="ts">
  // The play mode (/fly, branch FarmerThreeJSFun): one pilot, flown by hand, in the 3D view of space drawn from the
  // browser's own Destiny park (web/src/play), with the app's own windows over it. Everything the pilot does goes
  // through the app's session (store + Flow, app/sessions.ts) as it does in the multibox client; nothing here is a
  // bot, and no bot is mounted. Docked, the station's Undock; in space, the SpaceView with its HUD, overview and
  // brackets. The Neocom opens the app's panels (PanelHost) in client-look windows (DesktopWindow).
  import { mount, onDestroy, unmount, untrack } from "svelte";
  import { createSignal } from "../store/signals.ts";
  import JumpBridgePanel from "./JumpBridgePanel.svelte";
  import { autoOpenWatchlist } from "./watchlistSettings.ts";
  import { splitResults, resultRows, SCAN_GROUP, PROBE_RESULT_WORD_LABELS, PROBE_RESULT_LABELS, MIN_WARP_DISTANCE, isAccurate } from "../bridge/probeResults.ts";
  import { romanLevel } from "../bridge/skills.ts";
  import { fmtDist } from "../space/overview.ts";
  import { selectedSites as probeSitesSelected, selectSite as selectProbeSite } from "../app/probeSiteSelection.ts";
  import { addGameLogLine, beginGameLog } from "./gameLog.ts";
  import GameLogActions from "./GameLogActions.svelte";
  import { combatFlag, combatFontSize, damageMessageShown } from "./combatSettings.ts";
  import type { CombatMessageIcon } from "../play/combatMessage.ts";
  import type { ActionMessage } from "../app/flow.ts";
  import { iskWords } from "../bridge/questions.ts";
  import type { Colony, DamageEvent } from "../store/types.ts";
  import { emptyPlanetSurface } from "../bridge/planetDeployment.ts";
  import { get as storeValue } from "svelte/store";
  import { assetsSearchTarget } from "./assetsSearch.ts";
  import { contractsSearchTarget } from "./contractsSearch.ts";
  import { marketDetailsTarget } from "./marketDetails.ts";
  import { typeCompareTarget } from "./typeCompare.ts";
  import { fittingWindowTarget } from "./fittingWindowTarget.ts";
  import { shipHoldTarget } from "./shipHold.ts";
  import { hudSetting, hudSettingNow, setHudSetting, slotOrderOf } from "../store/hudSettings.ts";
  import { createSession, type Session } from "../app/sessions.ts";
  import { setSessionToken, withTokenQuery } from "../app/sessionToken.ts";
  import { bridgeDo, corpTickers, getDscanHologramTypes } from "../app/api.ts";
  import { StarMap } from "../play/starMap.ts";
  import { mountStarMapFilterControls } from "../play/starMapFilterControls.ts";
  import type { StarMapColorMode } from "../bridge/starMapFilters.ts";
  import { sessionPlace } from "../bridge/sessionPlace.ts";
  import { ACADEMY_BUTTON, ACADEMY_TITLE } from "../bridge/academyShips.ts";
  import { SHIP_TREE_CAPTION } from "../bridge/shipTree.ts";
  import { FittingShipScene } from "../play/fittingScene.ts";
  import { setContext } from "svelte";
  // The app panels in this page's windows draw as the client's where they know how (Fitting.svelte's ring).
  setContext("retailChrome", true);
  // ... and the fitting window's ship in the middle of its ring (play/fittingScene.ts), its own scene a window
  setContext("fittingShipScene", (host: HTMLElement) => new FittingShipScene(host));
  import DesktopWindow from "./DesktopWindow.svelte";
  import PanelHost from "./PanelHost.svelte";
  import PlanetMode from "./PlanetMode.svelte";
  import CustomsOffice from "./CustomsOffice.svelte";
  import type { MoonRefinery } from "../bridge/moonMining.ts";
  import { METENOX_TYPE_ID, type AutoMoonMiner, type MoonMaterialBay } from "../bridge/autoMoonMining.ts";
  import PlayInfoPanels from "./PlayInfoPanels.svelte";
  import FlyDronesWindow from "./FlyDronesWindow.svelte";
  import BuffBar from "./BuffBar.svelte";
  import { INDICATION_WORD_LABELS } from "../space/actionIndication.ts";
  import NoticeBridge from "./NoticeBridge.svelte";
  import Toasts from "./Toasts.svelte";
  import ServerQuestion from "./ServerQuestion.svelte";
  import ClientDialogs from "./ClientDialogs.svelte";
  import ScannerWindows from "./ScannerWindows.svelte";
  import { INTEGRATED_MINING_SCANNER } from "../bridge/miningScanResults.ts";
  import FleetInvitation from "./FleetInvitation.svelte";
  import InfoWindows from "./InfoWindows.svelte";
  import CalendarWindows from "./CalendarWindows.svelte";
  import ShipRestrictionsWindow from "./ShipRestrictionsWindow.svelte";
  import HackingWindow from "./HackingWindow.svelte";
  import PlayLobbyTabs from "./PlayLobbyTabs.svelte";
  import SystemMenu from "./SystemMenu.svelte";
  import { commandForKey, COMBAT_WORDS } from "../play/shortcutKeys.ts";
  import { TARGET_LOCKED_LABEL } from "../play/targetLock.ts";
  import type { InfoWindowHost } from "./infoWindowHost.ts";
  import { showInfoRequests } from "./showInfo.ts";
  import { jobBoardRequests } from "./jobBoardRequests.ts";
  import { openTheatersOfWar, theatersOfWarRequests } from "./theatersOfWarRequests.ts";
  import { relevantMilitiaPage } from "../bridge/militiaEnlistment.ts";
  import { agencyRequests } from "./agencyRequests.ts";
  import { skillPlanCareerRequests } from "./skillPlanCareerRequests.ts";
  import { skillPlanTemplateTarget } from "./skillPlanTemplate.ts";
  import { achievementRequest } from "./achievementRequests.ts";
  import { locationSearchRequests } from "./locationSearchRequests.ts";
  import { notify } from "./notices.ts";
  import { miningDroneIDs, orderableDroneIDs, salvageDroneIDs } from "./droneFlight.ts";
  import { playUiEvent } from "../play/uiAudio.ts";
  import { nameKey } from "../store/names.ts";
  import { sendMusicEvent, securitySwitch, combatSwitch } from "../play/music.ts";
  import { gfx, onGfx } from "../play/gfxSettings.ts";
  import ErrorBoundary from "./ErrorBoundary.svelte";
  import { openWindow, closeWindow, focusWindow, moveWindow, resizeWindow, toggleMinimize, type WinState } from "./desktop.ts";
  import { tabLabel, deriveDocked, type TabID } from "./tabs.ts";
  import { formatTemplate, plainText } from "../bridge/clientWords.ts";
  import { DSCAN_WORDS } from "../play/dscan.ts";
  import { LivePark } from "../three/livePark.ts";
  import { SpaceView, type Entity } from "../play/spaceView.ts";
  import type { FlightMiningSurvey } from "../play/miningSurveyWave.ts";
  import MiningOverlayControl from "./MiningOverlayControl.svelte";
  import { OVERVIEW_WORDS, typeNames as typeData } from "../play/overview.ts";
  import type { OverviewRelationships } from "../play/overviewFilters.ts";
  import type { OverviewAffiliation } from "../play/overview.ts";
  import { authoritativeFleetMemberCharacterIDs } from "../bridge/fleetCenter.ts";
  import { hangarGraphics } from "../play/hangarRegistry.ts";
  import { HangarView } from "../play/hangarView.ts";
  import { dirtLevelFromTime } from "../three/hullModel.ts";
  import { Neocom } from "../play/neocom.ts";
  import { clientTexture } from "../play/window.ts";
  import { OPEN_CARGO_LABEL } from "../play/containerInteraction.ts";
  import { ENTER_WORMHOLE_LABEL } from "../bridge/placeChanges.ts";
  import { POLARIZED_LABEL } from "../play/wormholePolarization.ts";
  import { IN_WARP_HINT_LABEL } from "../bridge/gateActivation.ts";
  import type { HudModule } from "../play/shipHud.ts";
  import { CRYSTAL_GROUPS, MODULE_TOOLTIP_LABELS, moduleTooltipRows } from "../play/moduleTooltip.ts";
  import { NewShipHud } from "../play/newShipHud.ts";
  import { activeTargetID, activeTargetName } from "../play/activeTarget.ts";
  import { droneSettingsFor, setDroneSetting } from "./droneSettings.ts";
  import { CARGO_HOLD, SHIP_HOLDS } from "../bridge/shipHolds.ts";
  import DamageAlertSettings from "./DamageAlertSettings.svelte";
  import BookmarkWindow from "./BookmarkWindow.svelte";
  import { combatMovingMode } from "./combatSettings.ts";
  import { shortcutOf } from "../play/shortcutKeys.ts";
  import type { DogmaTypeFacts } from "../bridge/dogma/location.ts";
  import { typeIconUrl } from "./typeIcons.ts";
  import { cycleProgressPercent } from "./moduleRack.ts";

  // Type names for the rack's tooltips (the extractor's typeNames.json, from the SDE).
  let typeNames: Record<string, [string | null, number | null]> = {};
  /** Each module type: whether it has an overload effect (null while it is asked). */
  const overloadable = new Map<number, boolean | null>();
  void fetch("/client-assets/typeNames.json").then((r) => (r.ok ? r.json() : null)).then((n) => { if (n) typeNames = n.types; }).catch(() => {});
  import "../play/play.css";
  import { applyClientTint } from "../play/clientTint.ts";
  import SovReagentBay from "./SovReagentBay.svelte";
  import SovHubWindow from "./SovHubWindow.svelte";
  import type { MySovHub, SovHubDetails, SovHubExtras } from "../app/flow.ts";

  // The app's navy panels in the client's greys, for as long as the play mode is up (play/clientTint.ts).
  $effect(() => applyClientTint(".fly-windows"));

  // The Neocom's buttons (play/neocom.ts) and the app panel each opens.
  const NEOCOM_TABS: Record<string, TabID> = {
    theatersOfWar: "theatersOfWar",
    achievements: "achievements", agency: "finder", jobboard: "jobBoard", mail: "mail", inventory: "inventory", assets: "assets", wallet: "wallet", market: "market",
    fitting: "fitting", map: "travel", charactersheet: "characterSheet", chat: "chat", shipTree: "shipTree",
    // the EVE menu's commands (play/neocom.ts EVE_MENU)
    marketorders: "market", contracts: "contracts", industry: "industry", miningScan: "miningScan", miningLedger: "miningLedger", planets: "planets", locations: "locations",
    contacts: "contacts", fleet: "fleet", corporation: "corporation", structureBrowser: "structureBrowser", compare: "compare", log: "log", notepad: "notepad", calendar: "calendar",
  };

  let session = $state<Session | null>(null);
  let autoMoonMiner = $state.raw<AutoMoonMiner | null>(null);
  let moonMaterialBay = $state.raw<MoonMaterialBay | null>(null);
  let moonMaterialRequest = 0;
  async function showMoonMaterialBay(structureID: number): Promise<void> {
    const pilot = session, request = ++moonMaterialRequest;
    if (!pilot || stage !== "game") return;
    try {
      const result = await pilot.flow.loadMoonMaterialBay(structureID);
      if (session !== pilot || stage !== "game" || request !== moonMaterialRequest) return;
      moonMaterialBay = result;
      open("moonMaterialBay");
    } catch (error) {
      if (session === pilot && stage === "game" && request === moonMaterialRequest && (error as { code?: string })?.code !== "SESSION_REQUEST_RETIRED") {
        notify({ kind: "danger", title: "Moon Material Bay", detail: (error as Error).message });
      }
    }
  }
  let metenoxTransfer = $state.raw<{ structureID: number; shipID: number } | null>(null);
  let metenoxControl = $state.raw<{ miner: AutoMoonMiner; previousShipID: number | null } | null>(null);
  let boardingMetenox = false;
  async function transferToMetenox(structureID: number, shipID: number): Promise<void> {
    metenoxTransfer = { structureID, shipID };
    open("metenoxTransfer");
  }
  async function boardMetenox(structureID: number): Promise<void> {
    const pilot = session;
    if (!pilot || boardingMetenox) return;
    boardingMetenox = true;
    try {
      const result = await pilot.flow.boardMetenox(structureID);
      if (!result || session !== pilot) return;
      metenoxControl = result;
      open("metenoxFuel");
    } finally { boardingMetenox = false; }
  }
  async function leaveMetenox(): Promise<void> {
    if (!session || !metenoxControl) return;
    const { miner, previousShipID } = metenoxControl;
    await session.flow.leaveMetenox(miner.id, previousShipID);
    metenoxControl = null;
    wins = closeWindow(wins, "metenoxFuel");
  }
  let moonDetailsRequest = 0;
  async function showAutoMoonMiner(structureID: number): Promise<void> {
    const pilot = session, request = ++moonDetailsRequest;
    if (!pilot || stage !== "game") return;
    try {
      const result = await pilot.flow.openAutoMoonMiner(structureID);
      if (session !== pilot || stage !== "game" || request !== moonDetailsRequest || !result) return;
      autoMoonMiner = result;
      open("autoMoonMiner");
    } catch (error) {
      if (session === pilot && stage === "game" && request === moonDetailsRequest && (error as { code?: string })?.code !== "SESSION_REQUEST_RETIRED") {
        notify({ kind: "danger", title: "Moon Drill Details", detail: (error as Error).message });
      }
    }
  }
  // A Sov Hub's windows from its space menu: the reagent bay (OpenSovFuelDepositWindow) and the config window
  // (OpenSovHubWindow).
  let reagentBay = $state<{ hubID: number; solarSystemID: number; isStationMgr: boolean } | null>(null);
  let sovHubConfig = $state<{ hub: MySovHub; details: SovHubDetails; extras: SovHubExtras } | null>(null);
  async function openSovHubConfig(hubID: number): Promise<void> {
    const s = session;
    if (!s) return;
    const hub = (await s.flow.mySovHubs())?.find((h) => h.hubID === hubID);
    if (!hub) return;
    const details = await s.flow.sovHubDetails(hub.hubID, hub.solarSystemID);
    const extras = await s.flow.sovHubExtras(hub.hubID, hub.solarSystemID, (details.upgrades ?? []).map((u) => u.typeID));
    sovHubConfig = { hub, details, extras };
  }
  const stationManager = (s: Session) => (BigInt(s.store.station.get().online?.corpRole ?? "0") & 2048n) !== 0n;
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
  const planets = $derived(session?.store.planets);
  const targeting = $derived(session?.store.targeting);
  const fitting = $derived(session?.store.fitting);
  const inventory = $derived(session?.store.inventory);
  const fleet = $derived(session?.store.fleet);
  const memberDetails = $derived(session?.flow.memberDetailsShown);

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
  const dockedStructureID = $derived(docked ? ($flight?.status ? $flight.status.structureID : $station?.online?.structureID) ?? null : null);
  const controllingStructure = $derived(dockedStructureID !== null && $flight?.status?.shipID === dockedStructureID);
  const controllingMetenox = $derived($flight?.status?.shipTypeID === METENOX_TYPE_ID
    && $flight.status.shipID !== null && $flight.status.shipID === $flight.status.structureID);
  $effect(() => {
    const status = $flight?.status;
    if (metenoxTransfer && status && (!status.inSpace || status.shipID !== metenoxTransfer.shipID || status.shipMode === "WARP")) {
      metenoxTransfer = null;
      wins = closeWindow(untrack(() => wins), "metenoxTransfer");
    }
    if (moonMaterialBay && status && (!status.inSpace || status.shipID !== moonMaterialBay.shipID || status.shipMode === "WARP")) {
      moonMaterialBay = null;
      wins = closeWindow(untrack(() => wins), "moonMaterialBay");
    }
    if (metenoxControl && status && status.shipID !== metenoxControl.miner.id) {
      metenoxControl = null;
      wins = closeWindow(untrack(() => wins), "metenoxFuel");
    }
  });
  async function reopenMetenoxFuel(): Promise<void> {
    const pilot = session, id = $flight?.status?.shipID;
    if (!pilot || !id || !controllingMetenox) return;
    try {
      const miner = metenoxControl?.miner ?? await pilot.flow.readMetenoxIdentity(id);
      if (!miner || session !== pilot || $flight?.status?.shipID !== id) return;
      metenoxControl ??= { miner, previousShipID: null };
      open("metenoxFuel");
    } catch (cause) { notify({ kind: "danger", title: "Metenox Fuel Bay", detail: (cause as Error).message }); }
  }
  const refineryCorporationID = $derived($station?.online?.corporationID ?? null);
  const refineryCorpRole = $derived($station?.online?.corpRole ?? null);
  let moonRefinery = $state.raw<MoonRefinery | null>(null);
  let refineryPending = $state(false);
  let refineryError = $state("");
  $effect(() => {
    const pilot = session;
    const structureID = dockedStructureID;
    // Defense permissions may change with the corporation or pilot's roles.
    void refineryCorporationID;
    void refineryCorpRole;
    moonRefinery = null;
    refineryError = "";
    if (!pilot || structureID === null) return;
    let current = true;
    void pilot.flow.loadMoonRefinery(structureID).then(refinery => {
      if (current) moonRefinery = refinery;
    }).catch(reason => {
      if (current) refineryError = (reason as Error).message;
    });
    return () => { current = false; };
  });
  $effect(() => {
    if (!controllingStructure && wins.some(win => win.id === "moonMining")) wins = closeWindow(wins, "moonMining");
  });

  async function changeRefineryControl(take: boolean): Promise<void> {
    const pilot = session;
    const structureID = dockedStructureID;
    if (!pilot || structureID === null || refineryPending) return;
    refineryPending = true;
    refineryError = "";
    try {
      await pilot.flow.changeRefineryControl(structureID, take);
    } catch (reason) {
      if (session === pilot && dockedStructureID === structureID) refineryError = (reason as Error).message;
    } finally {
      refineryPending = false;
    }
  }
  const academyStationID = $derived(sessionPlace($flight?.status ?? null, $station?.online ?? null).stationID);
  const academySystemID = $derived(sessionPlace($flight?.status ?? null, $station?.online ?? null).solarSystemID);
  const academyChanged = $derived(session?.flow.academyChanged);
  const academyWords = $derived(session?.store.words);
  $effect(() => {
    const cues = session?.flow.agencySeasonCue;
    let subscribed = false;
    return cues?.subscribe(cue => {
      if (subscribed && cue) void playUiEvent(cue);
      subscribed = true;
    });
  });
  const academyLabel = $derived(plainText($academyWords?.templates[ACADEMY_BUTTON] ?? "Academy Ship Service"));
  let academyAccess = $state<"hidden" | "locked" | "available">("hidden");
  $effect(() => {
    const s = session;
    const stationID = academyStationID, systemID = academySystemID;
    void $academyChanged;
    if (!s || !docked || stationID === null || systemID === null) {
      academyAccess = "hidden";
      if (s && untrack(() => wins.some(win => win.id === "academyShips"))) wins = closeWindow(untrack(() => wins), "academyShips");
      return;
    }
    let current = true;
    void s.flow.academyAvailability(stationID, systemID).then(access => {
      if (!current) return;
      academyAccess = access;
      if (access !== "available") wins = closeWindow(wins, "academyShips");
    }).catch(() => { if (current) academyAccess = "hidden"; });
    return () => { current = false; };
  });

  // The music as the client's Master Music Graph (805) runs it, one subgraph at a time (exclusive "music_system":
  // the one stopping sends its stop): at login and character selection 806 (music_login_play / _stop), in the hangar
  // 808 (no music), in space 809 (music_eve_dynamic_play / _stop, then the system's security switch, again as the
  // system changes), targeted in space with Use Combat Music on 823 (music_eve_combat_play / _stop and its switch);
  // with Override with Old Jukebox on, after login 810 in their place (music_eve_classic_play / _stop: the classic
  // playlist, docked and in space alike - 805 asks it before the hangar).
  let musicMode = "";
  let musicSystemID: number | null = null;
  let musicSecurity: number | null = null;
  let useCombatMusic = $state(gfx().useCombatMusic);
  let oldJukebox = $state(gfx().useOldJukeboxOverride);
  onDestroy(onGfx((g) => { useCombatMusic = g.useCombatMusic; oldJukebox = g.useOldJukeboxOverride; }));
  const targeted = $derived(($targeting?.lockedByIDs ?? []).length > 0);
  const MUSIC_STOPS: Record<string, string> = { login: "music_login_stop", space: "music_eve_dynamic_stop", combat: "music_eve_combat_stop", classic: "music_eve_classic_stop" };
  function musicSwitches(mode: string) {
    if (musicSecurity === null || musicSystemID === null) return;
    const sw = mode === "combat" ? combatSwitch(musicSecurity) : mode === "space" ? securitySwitch(musicSystemID, musicSecurity) : null;
    if (sw) void sendMusicEvent(sw);
  }
  $effect(() => {
    const mode = stage !== "game" ? "login" : oldJukebox ? "classic" : docked ? "hangar" : targeted && useCombatMusic ? "combat" : "space";
    if (mode === musicMode) return;
    const was = musicMode;
    musicMode = mode;
    if (MUSIC_STOPS[was]) void sendMusicEvent(MUSIC_STOPS[was]!);
    if (mode === "login") void sendMusicEvent("music_login_play");
    else if (mode === "space") void sendMusicEvent("music_eve_dynamic_play");
    else if (mode === "combat") void sendMusicEvent("music_eve_combat_play");
    else if (mode === "classic") void sendMusicEvent("music_eve_classic_play");
    musicSwitches(mode);
  });
  function musicSystem(solarSystemID: number, security: number | null) {
    musicSystemID = solarSystemID;
    musicSecurity = security;
    musicSwitches(musicMode);
  }

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
  let entryWarpHistory: Promise<boolean | null> | null = null;
  let chosenCharacterID = $state<number | null>(null);
  async function enter(characterID: number) {
    if (!session) return;
    leavePlanetMode(false);
    chosenCharacterID = characterID;
    ++moonDetailsRequest;
    ++moonMaterialRequest;
    autoMoonMiner = null;
    moonMaterialBay = null;
    metenoxControl = null;
    metenoxTransfer = null;
    wins = closeWindow(closeWindow(wins, "autoMoonMiner"), "moonMaterialBay");
    wins = closeWindow(closeWindow(wins, "metenoxFuel"), "metenoxTransfer");
    stage = "entering";
    error = "";
    try {
      // The app's own selection: login calls, the lost-drone check, the station panel (flow.pilotSelected).
      await session.flow.selectCharacter(characterID);
      const { online } = session.store.station.get();
      beginGameLog(characterID, online?.characterName ?? "");
      entryWarpHistory = gfx().dynamicCameraMovement && online && !deriveDocked(session.store.flight.get().status, online)
        ? session.flow.hasEverWarped().catch(() => null) : null;
      session.flow.setLivePush(true);
      session.flow.setForeground(true);
      // The rack's data: the fitting (flow.loadFitting) and which modules run (the space read's activeModuleIDs,
      // 1 Hz, the agreed rate: a claim held while the pilot plays, released on leaving).
      void session.flow.loadFitting().catch(() => {});
      // The session's place (the system, docked or in space), as Workspace reads it once online: character select does
      // not read it, and nothing else does until the session changes - the probe results are published by its system
      // (publishProbeResults), and a pilot logged in to space had none until then.
      void session.flow.loadFlightStatus().catch(() => {});
      // the logger's mining and bounty lines (OreMinedNotificationAdapter, BountyNotificationAdapter)
      offActionMessages?.();
      session.flow.requestWords(ACTION_WORDS);
      offActionMessages = session.flow.onActionMessage((m) => void sayActionMessage(m));
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
      void session.flow.loadFleet(true).catch(() => {});
    } catch (err) {
      error = (err as Error).message;
      stage = "select";
    }
  }

  // One window layer for every window of the play mode: the app's (DesktopWindow), its info windows, and the space
  // view's own (overview, selected item, the scanner). The one last clicked or opened goes on top of all of them.
  let windowsEl = $state<HTMLDivElement | null>(null);
  /**
   * The windows' sounds as carbonui makes them (uiconst SOUND_*): Window.CloseByUser SOUND_CLOSE, the collapse
   * SOUND_COLLAPSE, a Button's or Tab's click SOUND_BUTTON_CLICK and hover SOUND_BUTTON_HOVER, a Checkbox
   * SOUND_SETSELECTED / SOUND_SETDESELECTED. A button standing for a control that is no Button in the client and plays
   * its own sounds (data-own-sound: the Career Portal's nodes) gets none of these.
   */
  $effect(() => {
    const el = windowsEl;
    if (!el) return;
    let hovered: Element | null = null;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const box = t?.closest("input[type=checkbox]") as HTMLInputElement | null;
      if (box) { void playUiEvent(box.checked ? "ui_button_soft4_play" : "msg_DiodeDeselect_play"); return; }
      const button = t?.closest("button");
      if (!button || (button as HTMLButtonElement).disabled || button.hasAttribute("data-own-sound")) return;
      if (button.classList.contains("win-close")) void playUiEvent("ui_object_close_play");
      else if (button.classList.contains("win-btn")) void playUiEvent("ui_collapse_play");
      else void playUiEvent("ui_button_soft4_play");
    };
    const onOver = (e: MouseEvent) => {
      const button = (e.target as HTMLElement | null)?.closest("button") ?? null;
      if (button === hovered) return;
      hovered = button;
      if (button && !(button as HTMLButtonElement).disabled && !button.hasAttribute("data-own-sound")) void playUiEvent("ui_button_soft1_play");
    };
    el.addEventListener("click", onClick, true);
    el.addEventListener("mouseover", onOver);
    return () => { el.removeEventListener("click", onClick, true); el.removeEventListener("mouseover", onOver); };
  });
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

  // The job board asked for from elsewhere (open_freelance_project, open_browse_page): its window opened, which takes
  // the request.
  $effect(() => jobBoardRequests.subscribe((request) => { if (request) open("jobBoard"); }));
  // The route panel's search (GetResultsInNewWindow): the search results window, which takes the request.
  $effect(() => locationSearchRequests.subscribe((request) => { if (request) open("locationSearch"); }));
  $effect(() => agencyRequests.subscribe((request) => { if (request) open("finder"); }));
  $effect(() => theatersOfWarRequests.subscribe((request) => { if (request) open("theatersOfWar"); }));
  $effect(() => achievementRequest.subscribe(id => { if (id) open("achievements"); }));
  $effect(() => skillPlanCareerRequests.subscribe((request) => { if (request) open("skills"); }));
  const skillPlanRequests = skillPlanTemplateTarget.requests;
  let servedSkillPlanRequests = skillPlanRequests.get();
  $effect(() => {
    const count = $skillPlanRequests;
    if (count === servedSkillPlanRequests) return;
    servedSkillPlanRequests = count;
    open("skills");
  });

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
  // stationServiceConst's navyoffices entry, for station and structure service IDs respectively.
  const militiaOfficeAvailable = $derived($station?.online?.stationID
    ? $station.station?.serviceIDs?.includes(26) === true
    : $station?.structureServiceIDs?.includes(12) === true);

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
      // in the station's hangar (hangarRegistry: by the station's race, its type's from the client's type data)
      $effect(() => {
        const row = ($characters?.characters ?? []).find((c) => c.characterID === chosenCharacterID);
        const shipTypeID = $flight?.status?.shipTypeID ?? row?.shipTypeID ?? null;
        const st = $station?.station ?? null;
        void typeData().then((names) => {
          const t = st?.stationTypeID != null ? names?.types[String(st.stationTypeID)] : undefined;
          const raceID = (t as unknown as (number | null)[] | undefined)?.[2] ?? null;
          const categoryID = t?.[1] != null ? names?.groups[String(t[1])]?.[1] ?? null : null;
          return hangar.show(shipTypeID, st ? hangarGraphics(st.stationID, { raceID, categoryID }) : null);
        });
      });
      // its dust: the docked ship's dirt time, asked of the server as the client's hangar asks it
      $effect(() => {
        // (the fitting's active ship: the flight is not read while docked)
        const shipID = $fitting?.activeShipID ?? null;
        if (!shipID || !$station?.station) { hangar.setDirt(null); return; }
        void session?.flow.shipDirtTime(shipID).then((t) => hangar.setDirt(t === null ? null : dirtLevelFromTime(t))).catch(() => hangar.setDirt(null));
      });
      // its damage (dogma GetDamageStateEx from the active ship's attributes, kept as OnModuleAttributeChanges tells:
      // shieldCharge / shieldCapacity, 1 - armorDamage / armorHP, 1 - damage / hp), its change a repair's
      $effect(() => {
        const a = $fitting?.shipAttributes;
        const of = (id: number) => (typeof a?.[id] === "number" ? (a[id] as number) : null);
        const [charge, capacity, armorDamage, armorHP, damage, hp] = [of(264), of(263), of(266), of(265), of(3), of(9)];
        if (!$station?.station || hp === null || !(hp > 0)) { hangar.setDamage(null); return; }
        const ratio = (x: number | null, whole: number | null, used: boolean) =>
          whole !== null && whole > 0 && x !== null ? Math.min(1, Math.max(0, used ? 1 - x / whole : x / whole)) : 1;
        hangar.setDamage([ratio(charge, capacity, false), ratio(armorDamage, armorHP, true), ratio(damage, hp, true)]);
      });
      // its fitted turrets (the fitting's high and medium slots: slot = the place in its rack + 1, as
      // TurretSet.GetSlotFromModuleFlagID; the fit is applied only when it changes)
      $effect(() => {
        const slots = $fitting?.slots ?? [];
        hangar.setFit(slots.filter((s) => s.module && (s.family === "high" || s.family === "mid"))
          .map((s) => ({ typeID: s.module!.typeID, slot: s.index + 1, count: 1, moduleID: s.module!.itemID })));
      });
    });
    return () => { stop(); hangar.dispose(); };
  });
  $effect(() => {
    if (!neocomHost) return;
    const neocom = new Neocom(neocomOpen);
    neocomHost.appendChild(neocom.root);
    return () => { neocom.root.remove(); neocom.dispose(); };
  });

  /** The Neocom's width: a window opens right of it, as the eve-cs mirror's windows never sit on its Neocom. */
  const NEOCOM_W = 44;
  /** The sizes the play page opens these windows at (the eve-cs mirror's, page pixels, title bar included). */
  const FLY_SIZES: Partial<Record<TabID, { w: number; h: number }>> = { drones: { w: 288, h: 218 } };
  /**
   * The client's default sizes of the windows the play page opens without a layout of their own: characterSheetWindow
   * 1235 x 768, assetsWindow 550 x 450, locations/window 450 x 450, addressBookWindow 600 x 500, evemail 800 x 600,
   * agencyWnd (AgencyWndNew) 1188 x 694, walletWnd 900 x 600, planetWindow 500 x 500, uilog (logger) 400 x 200.
   */
  const CLIENT_SIZES: Partial<Record<TabID, { w: number; h: number }>> = {
    characterSheet: { w: 1235, h: 768 }, assets: { w: 550, h: 450 }, locations: { w: 450, h: 450 }, contacts: { w: 600, h: 500 },
    mail: { w: 800, h: 600 }, finder: { w: 1188, h: 694 }, wallet: { w: 900, h: 600 }, planets: { w: 500, h: 500 }, log: { w: 400, h: 200 },
    notepad: { w: 400, h: 300 }, calendar: { w: 580, h: 400 }, jobBoard: { w: 720, h: 960 }, paintTool: { w: 1030, h: 650 }, locationSearch: { w: 420, h: 480 }, achievements: { w: 1040, h: 825 },
    fleetComposition: { w: 680, h: 420 }, miningScan: { w: 520, h: 400 }, miningLedger: { w: 850, h: 650 }, moonMining: { w: 570, h: 550 },
    structureBrowser: { w: 810, h: 440 }, autoMoonMiner: { w: 700, h: 515 },
    metenoxTransfer: { w: 400, h: 340 }, metenoxFuel: { w: 435, h: 285 },
    moonMaterialBay: { w: 490, h: 355 },
    memberDetails: { w: 420, h: 480 },
    theatersOfWar: { w: 1600, h: 880 },
    academyShips: { w: 1280, h: 688 },
    shipTree: { w: 1055, h: 720 },
  };
  /** openWindow for the play page: its own sizes, and a new window moved off the Neocom. */
  function openFly(list: readonly WinState[], tab: TabID): WinState[] {
    const had = list.some((w) => w.id === tab);
    const next = openWindow(list, tab, FLY_SIZES[tab], had ? null : flyPlace(tab));
    return had ? next : next.map((w) => (w.id === tab && w.x < NEOCOM_W + 8 ? { ...w, x: w.x + NEOCOM_W } : w));
  }
  /**
   * Where the client puts a window the first time, for those it places itself: the chat at the bottom left of the
   * desktop, 16 px in (chat/client/window.py default_left / default_top), its size by the screen's
   * (chat/client/util.py: 450 / 360 / 260 wide from 1680 / 1200 px, 350 / 320 / 260 high from 1200 / 960 px).
   */
  function flyPlace(tab: TabID): { x: number; y: number; w: number; h: number } | null {
    // the fitting window (fittingWnd.GetWindowWidth / GetFixedWndHeight): the 640 base x GetScaleFactor + 8, the right
    // panel's PANEL_WIDTH_RIGHT 280 (open by default), WND_NORMAL_HEIGHT 676 high; within the desktop
    if (tab === "fitting") {
      const scale = Math.min(1, Math.max(0.75, innerWidth / 1400));
      const W = windowsEl?.clientWidth || innerWidth, H = windowsEl?.clientHeight || innerHeight;
      return { x: NEOCOM_W + 8, y: 8, w: Math.min(W - NEOCOM_W - 16, Math.round(640 * scale) + 8 + 280), h: Math.min(H - 16, 676) };
    }
    // the market (marketbase.RegionalMarket: default 900 x 768, at least 650 x 435), within the desktop
    if (tab === "market") {
      const W = windowsEl?.clientWidth || innerWidth, H = windowsEl?.clientHeight || innerHeight;
      return { x: NEOCOM_W + 8, y: 8, w: Math.max(Math.min(650, W - NEOCOM_W - 16), Math.min(W - NEOCOM_W - 16, 900)), h: Math.max(Math.min(435, H - 16), Math.min(H - 16, 768)) };
    }
    // the contracts window (contractsWnd.ContractsWindow: 630 x 500, SetMinSize 700 x 560), within the desktop
    if (tab === "contracts") {
      const W = windowsEl?.clientWidth || innerWidth, H = windowsEl?.clientHeight || innerHeight;
      return { x: NEOCOM_W + 8, y: 8, w: Math.min(W - NEOCOM_W - 16, 700), h: Math.min(H - 16, 560) };
    }
    // The other windows at the client's own default sizes (their default_width / default_height), within the desktop.
    const size = CLIENT_SIZES[tab];
    if (size) {
      const W = windowsEl?.clientWidth || innerWidth, H = windowsEl?.clientHeight || innerHeight;
      return { x: NEOCOM_W + 8, y: 8, w: Math.min(W - NEOCOM_W - 16, size.w), h: Math.min(H - 16, size.h) };
    }
    // the probe scanner (probeScannerWindow.ProbeScannerWindow: 400 x 400), within the desktop
    if (tab === "scanner") {
      const W = windowsEl?.clientWidth || innerWidth, H = windowsEl?.clientHeight || innerHeight;
      return { x: NEOCOM_W + 8, y: 8, w: Math.min(W - NEOCOM_W - 16, 400), h: Math.min(H - 16, 400) };
    }
    // the corporation window (corporationWindow.CorporationWindow: 800 x 832, at least 700 x 832), within the desktop
    if (tab === "corporation") {
      const W = windowsEl?.clientWidth || innerWidth, H = windowsEl?.clientHeight || innerHeight;
      return { x: NEOCOM_W + 8, y: 8, w: Math.min(W - NEOCOM_W - 16, 800), h: Math.min(H - 16, 832) };
    }
    // the fleet window (fleetwindow.FleetWindow: 500 x 400, at least 270 x 120), within the desktop
    if (tab === "fleet") {
      const W = windowsEl?.clientWidth || innerWidth, H = windowsEl?.clientHeight || innerHeight;
      return { x: NEOCOM_W + 8, y: 8, w: Math.min(W - NEOCOM_W - 16, 500), h: Math.min(H - 16, 400) };
    }
    // the industry window (industryWnd.Industry: 800 high, at least 1004 x 650), within the desktop
    if (tab === "industry") {
      const W = windowsEl?.clientWidth || innerWidth, H = windowsEl?.clientHeight || innerHeight;
      return { x: NEOCOM_W + 8, y: 8, w: Math.min(W - NEOCOM_W - 16, 1004), h: Math.min(H - 16, 800) };
    }
    if (tab !== "chat") return null;
    const W = windowsEl?.clientWidth || innerWidth, H = windowsEl?.clientHeight || innerHeight;
    const w = innerWidth >= 1680 ? 450 : innerWidth >= 1200 ? 360 : 260;
    const h = innerHeight >= 1200 ? 350 : innerHeight >= 960 ? 320 : 260;
    return { x: 16, y: Math.max(0, H - h - 16), w: Math.min(w, W), h };
  }
  function open(tab: TabID) {
    if (tab === "moonMining" && (!moonRefinery || !controllingStructure)) return;
    if (tab === "autoMoonMiner" && !autoMoonMiner) return;
    if (tab === "moonMaterialBay" && !moonMaterialBay) return;
    if (tab === "metenoxTransfer" && !metenoxTransfer || tab === "metenoxFuel" && !metenoxControl) return;
    if (tab === "watchlist" && !session?.store.fleet.get().authoritativeFleetID) return;
    if (tab === "miningScan" && !canOpenMiningScan()) {
      const s = session;
      if (s && !docked) {
        // A hull swap can reach the flight session ahead of the fitting read.
        void s.flow.loadFitting().catch(() => {}).then(() => {
          if (session !== s || docked) return;
          if (canOpenMiningScan()) open("miningScan");
          else miningScannerRequired();
        });
      } else miningScannerRequired();
      return;
    }
    if (tab === "finder" || tab === "theatersOfWar") mapInFront = false;
    wins = openFly(wins, tab);
    raiseApp(tab);
  }
  function canOpenMiningScan() {
    if (docked || !session) return false;
    const fit = session.store.fitting.get();
    const activeShip = session.store.space.get().snapshot?.shipID ?? session.store.flight.get().status?.shipID;
    return fit.activeShipID !== null && fit.activeShipID === activeShip &&
      (fit.shipAttributes?.[INTEGRATED_MINING_SCANNER] ?? 0) > 0;
  }
  function miningScannerRequired() {
    notify({ kind: "info", title: "Mining Scan Results", detail: "Undock in a ship with an integrated mining scanner." });
  }
  $effect(() => {
    if (docked && wins.some(win => win.id === "miningScan")) wins = closeWindow(wins, "miningScan");
  });
  let openedMemberDetails: NonNullable<typeof $memberDetails> | null = null;
  $effect(() => {
    const request = $memberDetails;
    if (stage !== "game" || !request || request === openedMemberDetails) return;
    openedMemberDetails = request;
    untrack(() => open("memberDetails"));
  });
  let lastFleetID: number | null = null;
  $effect(() => {
    const characterID = chosenCharacterID;
    if (stage !== "game" || characterID === null) {
      lastFleetID = null;
      return;
    }
    const fleetID = $fleet?.authoritativeFleetID ?? null;
    if (fleetID === lastFleetID) return;
    const leaving = lastFleetID !== null;
    lastFleetID = fleetID;
    untrack(() => {
      if (leaving) wins = closeWindow(closeWindow(wins, "watchlist"), "fleetComposition");
      if (fleetID !== null && autoOpenWatchlist(characterID)) open("watchlist");
    });
  });
  const itemWindows = [
    [marketDetailsTarget.requests, "market"], [contractsSearchTarget.requests, "contracts"],
    [assetsSearchTarget.requests, "assets"], [typeCompareTarget.requests, "compare"],
    [shipHoldTarget.requests, "inventory"], [fittingWindowTarget.requests, "fitting"],
  ] as const;
  $effect(() => {
    const stop = itemWindows.map(([requests, tab]) => {
      let served = requests.get();
      return requests.subscribe(count => {
        if (count === served) return;
        served = count;
        open(tab);
      });
    });
    return () => stop.forEach(unsubscribe => unsubscribe());
  });
  // Inventory.OpenOrShow applies to docked containers as well as cargo reached in space.
  $effect(() => {
    if (stage !== "game" || !session) return;
    const cargoShown = session.flow.cargoShown;
    let served = cargoShown.get()?.n ?? 0;
    return cargoShown.subscribe(shown => {
      if (shown === null || shown.n === served) return;
      served = shown.n;
      open("inventory");
    });
  });
  /** The Drones window's title with how many are out of how many (the client's "Drones 0/5"). */
  /**
   * The windows' captions as the client's (each window class's default_captionLabelPath), the install's words: the probe
   * scanner (ProbeScannerWindow), the Agency (AgencyWndNew - the play page's Agent Finder is its Missions tab), People &
   * Places (addressBookWindow), Mail (evemail), the Wallet (walletWnd), the Character Sheet, Personal Assets, Locations,
   * the Log. The page's own tab label stands until the words are had.
   */
  const CAPTION_LABELS: Partial<Record<TabID, string>> = {
    scanner: "UI/Inflight/Scanner/ProbeScanner", miningScan: "UI/Inflight/Scanner/MiningScanResults", miningLedger: "UI/Ledger/LedgerWnd", finder: "UI/Agency/Caption", contacts: "UI/PeopleAndPlaces/WindowTitle",
    mail: "Tooltips/Neocom/Mail", wallet: "UI/Wallet/WalletWindow/Wallet", characterSheet: "UI/CharacterSheet/CharacterSheetWindow/CharacterSheetCaption",
    assets: "Tooltips/Neocom/PersonalAssets", locations: "UI/PeopleAndPlaces/Locations", log: "UI/Accessories/Log/Log",
    planets: "UI/InfoWindow/TabNames/PlanetaryProduction", notepad: "UI/Notepad/Notepad", calendar: "UI/Calendar/CalendarWindow/Caption",
    fleetComposition: "UI/Fleet/FleetComposition/FleetComposition",
    memberDetails: "UI/Corporations/EditMemberDialog/EditMemberCaption",
    structureBrowser: "UI/Structures/Browser/StructureBrowser",
    theatersOfWar: "UI/TheatersOfWar/TheatersOfWarCaption",
    academyShips: ACADEMY_TITLE,
    shipTree: SHIP_TREE_CAPTION,
  };
  let captions = $state<Partial<Record<TabID, string>>>({});
  $effect(() => {
    if (!session) return;
    const s = session;
    s.flow.requestWords([...Object.values(CAPTION_LABELS) as string[], ...DSCAN_WORDS, ...COMBAT_WORDS, TARGET_LOCKED_LABEL, ACADEMY_BUTTON]);
    return s.store.words.subscribe((w) => {
      const next: Partial<Record<TabID, string>> = {};
      for (const [tab, label] of Object.entries(CAPTION_LABELS) as [TabID, string][]) {
        const t = w.templates[label];
        if (typeof t === "string" && t !== "") next[tab] = plainText(t);
      }
      captions = next;
    });
  });
  let dronesTitle = $state("Drones");
  $effect(() => {
    if (!session) return;
    const s = session;
    const show = () => {
      const d = s.store.drones.get();
      const out = (d.inSpace ?? []).length, max = d.limits.maxActiveDrones;
      dronesTitle = max === null ? `Drones ${out}` : `Drones ${out}/${max}`;
    };
    return s.store.drones.subscribe(show);
  });

  // The client's combat line in its log (uilog.Logger.AddCombatMessageFromDict / AddCombatMessage): the message by the hit -
  // AttackMiss for quality 0, else AttackHits - and the attack type (+R for otherPlayerWeapons, +RD for otherPlayer,
  // +Banked for a banked shot of one's own), its words filled with the names (the park's), the weapon and the client's
  // colour and font markup; the hit's damage before it, " - weapon" and " - " the hit quality's words
  // (UI/Inflight/HitQuality1 .. 6) after it; logged as combat.
  const COMBAT_KEYS = ["AttackHits", "AttackMiss", "AttackHitsR", "AttackMissR", "AttackHitsRD", "AttackMissRD", "AttackHitsBanked", "AttackMissBanked"];
  function logCombatLine(d: DamageEvent): void {
    const s = session;
    if (!s || d.attackType === undefined) return;
    // godma.OnDamageMessage's gates (damageMessages, damageMessagesNoDamage, damageMessagesEnemy / Mine)
    if (!damageMessageShown(d.direction, d.amount)) return;
    const quality = d.quality ?? 0;
    const key = (quality === 0 ? "AttackMiss" : "AttackHits")
      + (d.attackType === "otherPlayer" ? "RD" : d.attackType === "otherPlayerWeapons" ? "R" : d.banked ? "Banked" : "");
    const words = s.store.words.get().templates;
    const template = words[`dialog:${key}/body`];
    if (typeof template !== "string") { s.flow.requestWords([...COMBAT_KEYS.map((k) => `dialog:${k}/body`), "UI/Inflight/HitQuality1", "UI/Inflight/HitQuality2", "UI/Inflight/HitQuality3", "UI/Inflight/HitQuality4", "UI/Inflight/HitQuality5", "UI/Inflight/HitQuality6"]); return; }
    const entities = s.store.space.get().snapshot?.entities ?? [];
    const own = s.store.space.get().snapshot?.ship ?? null;
    const resolved = s.store.names.get().resolved;
    // uix.GetSlimItemName as the space view has it (its own name, else its type's); 'Some object' where none
    const nameOfItem = (id: number | null) => {
      if (id === null) return "Some object";
      const e = entities.find((x) => x.itemID === id);
      return view?.itemName(id) || e?.name || (e?.typeID ? resolved[nameKey("type", e.typeID)] ?? "" : "") || "Some object";
    };
    const targetID = d.direction === "dealt" ? d.otherPartyID : own?.itemID ?? null;
    const sourceID = d.direction === "taken" ? d.otherPartyID : own?.itemID ?? null;
    const owner = d.ownerID ? resolved[nameKey("owner", d.ownerID)] ?? "" : "";
    if (d.ownerID) s.flow.requestNames([{ kind: "owner", id: d.ownerID }]);
    if (d.weaponTypeID) s.flow.requestNames([{ kind: "type", id: d.weaponTypeID }]);
    const args = { target: nameOfItem(targetID), source: nameOfItem(sourceID), owner, weapon: d.weaponTypeID ?? 0, extraNameText: "",
      // the small font a step below the notification's (max(10, notificationFontSize - 2))
      strongColor: "<color=0xff00ffff>", faintColor: "<color=0x77ffffff>", fontMarkUpStart: `<font size=${Math.max(10, storeValue(combatFontSize) - 2)}>`, fontMarkUpEnd: "</font>" };
    const markup = formatTemplate(template, args as never, { nameOf: (kind, id) => resolved[nameKey(kind, id)] ?? "" }).trim();
    let text = plainText(markup).trim();
    if (d.weaponTypeID) text += ` - ${resolved[nameKey("type", d.weaponTypeID)] ?? ""}`;
    const hq = quality >= 1 && quality <= 6 ? words[`UI/Inflight/HitQuality${quality}`] : undefined;
    if (typeof hq === "string") text += ` - ${plainText(hq)}`;
    if (quality > 0) text = `${Math.round(d.amount)} ${text}`;
    addGameLogLine(text, "combat");
    // the in-space line (logger.Say, msgLimited) where damageMessageShowInspaceNotifications is on: the message, then
    // " - " the weapon (damageMessagesShowWeapon) and " - " the hit quality (damageMessagesShowQuality), the damage
    // before it in damage_html's colour - red for a shot at us, cyan for ours - and a miss's from one attacker once in
    // 10 s. (The ticker / ship type extras need the payload's tickerText / typeName, not read here.)
    if (!combatFlag("damageMessageShowInspaceNotifications")) return;
    let post = "";
    if (d.weaponTypeID && combatFlag("damageMessagesShowWeapon")) post += ` - ${resolved[nameKey("type", d.weaponTypeID)] ?? ""}`;
    if (typeof hq === "string" && combatFlag("damageMessagesShowQuality")) post += ` - ${hq}`;
    view?.combatMessage.add(markup + post, quality, sourceID,
      quality > 0 ? { amount: d.amount, color: d.attackType !== "me" ? "#cc0000" : "#00ffff" } : null);
  }

  // The logger's action messages (uilog.AddMiningMessage / AddBountyMessage, their words from actionLog/client/
  // formatters.py), each said in space and logged (SayMessage: AddActionMessage, AddText by its type):
  //  - mining (OnOreMined), where actionMessagesMining is on: the mined (OreMined, or VariableRewardMined with rewards)
  //    where some was, the wasted (OreWasted for an asteroid's ore, else GroupWasted) and the critical bonus
  //    (MiningCriticalHit, eveicon.crit_success in CRIT_BONUS's colour);
  //  - bounty (OnBountyAddedToPayout), where actionMessagesBounty is on and the payout is above nothing, a second
  //    later: BountyAddedToPayoutMessage1, or ModifiedBountyAddedToPayoutMessage1.
  //  Their markup: the normal font the notification's size, the small two less; FAINT 0x77ffffff, NORMAL 0xffffffff,
  //  the bounty's 0xff00aa00, the mining amount's MiningQuantityColor (YIELD SUCCESS_GREEN #8DC169, WASTE DANGER_RED
  //  #FF454B, CRIT_BONUS DESTINATION_YELLOW #F0FF45), the reward's 0xffaaaa00 / 0xffdddd1c.
  const AL = "UI/Inflight/ActivityLog/";
  // (the bounty's {[numeric]bounty.isk} written by FmtISK: UI/Util/FmtIsk)
  const ACTION_WORDS = [...["OreMined", "VariableRewardMined", "OreWasted", "GroupWasted", "MiningCriticalHit", "BountyAddedToPayoutMessage1", "ModifiedBountyAddedToPayoutMessage1"].map((k) => AL + k),
    "UI/Util/FmtIsk", "UI/Util/FmtIskNoDecimal"];
  const CATEGORY_ASTEROID = 25;
  let offActionMessages: (() => void) | null = null;
  async function sayActionMessage(m: ActionMessage): Promise<void> {
    const s = session;
    const pilotID = chosenCharacterID;
    if (!s) return;
    if (m.kind === "mining" && !combatFlag("actionMessagesMining")) return;
    if (m.kind === "bounty" && (!(m.amount > 0) || !combatFlag("actionMessagesBounty"))) return;
    if (m.kind === "bounty") await new Promise((r) => setTimeout(r, 1000));
    else await s.flow.flying.resolveNamesNow([{ kind: "type", id: m.oreTypeID }, { kind: "typeGroup", id: m.oreTypeID }, { kind: "typeCategory", id: m.oreTypeID }, { kind: "category", id: CATEGORY_ASTEROID }]).catch(() => {});
    if (s !== session || pilotID !== chosenCharacterID || stage !== "game") return;
    const words = s.store.words.get().templates;
    const resolved = s.store.names.get().resolved;
    const size = storeValue(combatFontSize);
    const fonts = { normalFont: `<font size=${size}>`, smallFont: `<font size=${size - 2}>`, faintColor: "<color=0x77ffffff>", normalColor: "<color=0xffffffff>" };
    const say = (key: string, args: Record<string, unknown>, type: string, icons: readonly CombatMessageIcon[] = []) => {
      const template = words[AL + key];
      if (typeof template !== "string") { s.flow.requestWords(ACTION_WORDS); return; }
      const nameOf = (kind: Parameters<typeof nameKey>[0], id: number) => resolved[nameKey(kind, id)] ?? "";
      const markup = formatTemplate(template, { ...fonts, ...args } as never, { nameOf, writeIsk: (amount, places) => iskWords(amount, places, words, nameOf) });
      view?.combatMessage.addAction(markup, icons);
      addGameLogLine(plainText(markup).trim(), type);
    };
    if (m.kind === "bounty") {
      say(m.isModified ? "ModifiedBountyAddedToPayoutMessage1" : "BountyAddedToPayoutMessage1", { bountyPayoutColor: "<color=0xff00aa00>", bounty: m.amount }, "bounty");
      return;
    }
    if (m.mined > 0) {
      if (m.hasRewards) say("VariableRewardMined", { textColor: "<color=0xffaaaa00>", highlightedTextColor: "<color=0xffdddd1c>", amount: m.mined, oreTypeID: m.oreTypeID }, "mining");
      else say("OreMined", { amountMinedColor: "<color=0xff8dc169>", amount: m.mined, oreTypeID: m.oreTypeID }, "mining");
    }
    if (m.wasted) {
      const category = resolved[nameKey("typeCategory", m.oreTypeID)];
      const asteroid = typeof category === "string" && category === resolved[nameKey("category", CATEGORY_ASTEROID)];
      say(asteroid ? "OreWasted" : "GroupWasted", { groupName: resolved[nameKey("typeGroup", m.oreTypeID)] ?? "", amountWasted: m.wasted, amountWastedColor: "<color=0xffff454b>" }, "mining");
    }
    if (m.critBonus) say("MiningCriticalHit", { critColor: "<color=0xfff0ff45>", amount: m.critBonus, oreTypeID: m.oreTypeID }, "mining",
      [{ src: "/client-res/ui/texture/eveicon/category_icons/crit_success_16px.png", color: "#f0ff45" }]);
  }

  // The client's window commands (eveCommands.py) and the windows they open here; their keys are the client's default
  // shortcuts (clientShortcuts.ts, matched by shortcutKeys.ts) - Alt-E People & Places, L Locations, as the client has
  // them. OpenDirectionalScanner (Alt-D) and CmdRefreshDirectionalScan (V) are the space view's own.
  const WINDOW_COMMANDS: Record<string, TabID> = {
    ToggleProbeScanner: "scanner", OpenInventory: "inventory", OpenFitting: "fitting", OpenMail: "mail", OpenMarket: "market",
    OpenWallet: "wallet", OpenCharactersheet: "characterSheet", OpenSkillsWindow: "skills", OpenPeopleAndPlaces: "contacts",
    OpenLocations: "locations", OpenAgencyNew: "finder", OpenJobBoardWindow: "jobBoard", OpenAssets: "assets", OpenIndustry: "industry", OpenLedger: "miningLedger",
    OpenAchievementsWindow: "achievements", OpenFleetWatchlist: "watchlist", OpenStructureBrowser: "structureBrowser",
    ToggleTheatersOfWarWindow: "theatersOfWar", CmdToggleShipTree: "shipTree",
  };
  // The star map (play/starMap.ts): the Neocom's Map button and F10 (the client's OpenMapBrowser shortcut, its map
  // view) open it over the view and close it again; Escape closes it.
  let starMap: StarMap | null = null;
  let mapInFront = $state(false);
  let requestedMapMode: StarMapColorMode = "empire";
  let requestedMapSystem: number | null = null;
  let mapFilters: ReturnType<typeof mountStarMapFilterControls> | null = null;
  /** The system menu (Esc: uicore.cmd.OnEsc's EscapeCommand opens it when nothing else takes the key). */
  let systemMenu = $state(false);
  /** The new HUD's settings menu's NotifySettingsWindow (the ship health alerts). */
  let damageAlertsOpen = $state(false);
  /** The space menu's Save Location...: the bookmark window open for the thing, or none. */
  let spaceBookmark = $state<{ itemID: number; askIfKnown: boolean; typeName: () => string; name: () => string } | null>(null);
  const newHudOn = hudSettingNow("shipHudNew_preview");
  const hudTop = hudSetting("shipuialigntop");
  let mapHost = $state<HTMLDivElement | null>(null);
  let planetModeID = $state<number | null>(null);
  let customsTarget = $state<{ planetID: number; pinID: number | null } | null>(null);
  let customsTrigger: HTMLElement | null = null;
  function openCustoms(planetID: number, pinID: number | null = null) {
    customsTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    customsTarget = { planetID, pinID };
  }
  function closeCustoms() {
    customsTarget = null;
    const trigger = customsTrigger;
    customsTrigger = null;
    if (trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
  }
  async function openCustomsCargo(officeID: number) {
    const pilot = session;
    await pilot.flow.showInventoryContainer(officeID);
    if (session === pilot) open("inventory");
  }
  $effect(() => {
    session;
    if (docked) customsTarget = null;
    return () => { customsTarget = null; customsTrigger = null; };
  });
  let planetSurface = $state.raw<Colony | null>(null);
  let planetModeView: { canLeave: () => boolean; escapeCanLeave: () => boolean } | undefined = $state();
  let planetModeTrigger: HTMLElement | null = null;
  let planetViewRequest = 0;
  const planetInMode = $derived($planets?.colonies?.find(colony => colony.planetID === planetModeID) ?? planetSurface);

  async function showPlanetInMode(planetID: number) {
    const pilot = session;
    if (!pilot || planetModeID === planetID) return;
    if (planetModeView && !planetModeView.canLeave()) return;
    const request = ++planetViewRequest;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const known = $planets?.colonies?.find(colony => colony.planetID === planetID);
    let surface: Colony;
    try {
      surface = known ?? await pilot.flow.readLocalPlanetSurface(planetID);
    } catch (error) {
      if (request === planetViewRequest && session === pilot) {
        notify({ kind: "danger", title: "Planet Mode", detail: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (request !== planetViewRequest || session !== pilot) return;
    if (planetModeID === null) planetModeTrigger = trigger;
    toggleStarMap(false);
    planetSurface = emptyPlanetSurface(surface);
    planetModeID = planetID;
    void playUiEvent("msg_pi_general_opening_play");
    void pilot.flow.loadPlanets().catch(() => {});
  }

  function leavePlanetMode(restoreFocus = true) {
    planetViewRequest++;
    if (planetModeID === null) return;
    planetModeID = null;
    planetSurface = null;
    void playUiEvent("msg_pi_general_closing_play");
    const trigger = planetModeTrigger;
    planetModeTrigger = null;
    if (restoreFocus && trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
  }


  function neocomOpen(id: string) {
    if (id === "map") { toggleStarMap(); return; }
    const tab = NEOCOM_TABS[id];
    if (tab === "shipTree" && wins.some(win => win.id === tab && !win.minimized)) wins = closeWindow(wins, tab);
    else if (tab) open(tab);
  }
  function showSystemOnMap(systemID: number) {
    requestedMapSystem = systemID;
    mapInFront = true;
    toggleStarMap(true);
    starMap?.select(systemID);
  }
  function toggleStarMap(show = !starMap, mode?: StarMapColorMode) {
    if (!show) {
      starMap?.root.dispatchEvent(new Event("star-map-closed"));
      starMap?.dispose();
      starMap = null;
      mapInFront = false;
      requestedMapMode = "empire";
      requestedMapSystem = null;
      mapFilters = null;
      return;
    }
    leavePlanetMode(false);
    if (mode) {
      mapInFront = true;
      requestedMapMode = mode;
      mapFilters?.setMode(mode, true);
    }
    if (starMap || !session || !mapHost) return;
    const s = session;
    const m = new StarMap();
    starMap = m;
    const close = document.createElement("button");
    close.className = "star-map-close";
    close.title = "Close";
    close.textContent = "✕";
    close.onclick = () => toggleStarMap(false);
    m.root.appendChild(close);
    // the map's layout option (its settings' "Abstract layout": VIEWMODE_LAYOUT_SHOW_ABSTRACT_SETTINGS)
    const layout = document.createElement("label");
    layout.className = "star-map-layout";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.onchange = () => void m.setLayout(box.checked);
    // the client's map opens in it (VIEWMODE_LAYOUT_SHOW_ABSTRACT_DEFAULT True)
    box.checked = true;
    layout.append(box, document.createTextNode(" Abstract layout"));
    m.root.appendChild(layout);
    mapHost.appendChild(m.root);
    m.start();
    // the destination path (starmap GetDestinationPath: the pilot's system, then each waypoint's way and the waypoint)
    const route = () => void s.flow.routeWindowWaypoints().then((read) => {
      if (starMap !== m) return;
      const path: number[] = read ? [read.currentSystemID] : [];
      for (const w of read?.waypoints ?? []) {
        const systemID = w.id >= 30_000_000 && w.id <= 39_999_999 ? w.id : w.within.find((x) => x >= 30_000_000 && x <= 39_999_999);
        path.push(...w.between);
        if (systemID !== undefined) path.push(systemID);
      }
      m.setRoute(path);
    }).catch(() => {});
    void s.flow.loadStarMap().then((data) => {
      if (starMap !== m) return;
      const here = sessionPlace(s.store.flight.get().status, s.store.station.get().online).solarSystemID ?? live?.hello?.solarSystemID ?? null;
      m.build(data, here);
      if (requestedMapSystem !== null) m.select(requestedMapSystem);
      void m.setLayout(box.checked);
      route();
      const stop = s.flow.waypoints.subscribe(() => route());
      const filters = mountStarMapFilterControls(m, s);
      mapFilters = filters;
      if (requestedMapMode !== "empire") filters.setMode(requestedMapMode, mapInFront);
      m.root.addEventListener("star-map-closed", () => { stop(); filters.dispose(); }, { once: true });
    }).catch((e) => {
      notify({ kind: "danger", title: "Map", detail: e instanceof Error ? e.message : String(e) });
    });
    (window as unknown as { __starMap: unknown }).__starMap = m;
  }
  onDestroy(() => toggleStarMap(false));

  /**
   * The in-space commands the session runs (in space only): CmdReloadAmmo (Ctrl+R: shipUI.OnReloadAmmo - the rack's
   * Reload All, the modules reloading now left out); CmdDronesEngage (F: droneFunctions.PerformPrimaryAction - the drones
   * the pilot controls at the active target, the first locked) and CmdDronesReturnToBay (Shift+R: entity.CmdReturnBay of
   * every drone). True where the command was one of these.
   */
  function spaceCommand(cmd: string): boolean {
    const s = session;
    if (!s || docked || planetInMode) return false;
    const say = (title: string) => (cause: unknown) => notify({ kind: "danger", title, detail: cause instanceof Error ? cause.message : String(cause) });
    if (cmd === "OpenMiningScanResultsWindow") {
      if (wins.some(win => win.id === "miningScan")) wins = closeWindow(wins, "miningScan");
      else open("miningScan");
      return true;
    }
    if (cmd === "CmdMiningScan") {
      if (canOpenMiningScan()) void flightMiningSurvey.scan().catch(say("Mining Scan"));
      return true;
    }
    if (cmd === "CmdReloadAmmo") {
      const reloading = new Set(Object.keys(s.store.fitting.get().reloads ?? {}).map(Number));
      void s.flow.reloadAll(reloading).catch(say("Reload all"));
      return true;
    }
    // The drone commands (eveCommands.py): each on the drones this ship controls in space (michelle.GetDrones).
    const DRONE_COMMANDS = ["CmdDronesEngage", "CmdDronesReturnToBay", "CmdDronesReturnAndOrbit", "CmdLaunchFavoriteDrones",
      "CmdReconnectToDrones", "CmdToggleAggressivePassive", "CmdToggleDroneFocusFire"];
    if (DRONE_COMMANDS.includes(cmd)) {
      const snap = s.store.space.get().snapshot;
      const characterID = s.store.character.get().selectedCharacterID;
      const word = (label: string, args: Record<string, unknown>, own: string) => {
        const t = s.store.words.get().templates[label];
        return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args as never, { nameOf: () => null } as never)) : own;
      };
      // CmdToggleAggressivePassive / CmdToggleDroneFocusFire: the setting toggled, told to the server (droneSettings.py)
      if (cmd === "CmdToggleAggressivePassive" || cmd === "CmdToggleDroneFocusFire") {
        if (characterID === null) return true;
        const name = cmd === "CmdToggleAggressivePassive" ? "aggressive" : "focusFire";
        const now = setDroneSetting(characterID, name, !droneSettingsFor(characterID)[name]);
        void s.flow.changeDroneSettings(now).catch(say("Drones"));
        return true;
      }
      // CmdLaunchFavoriteDrones: in space, the favourite group's drones in the bay, else every drone in the bay
      if (cmd === "CmdLaunchFavoriteDrones") {
        if (!snap?.ship) return true;
        const bay = (s.store.drones.get().bay ?? []).map((stack) => stack.itemID);
        if (bay.length) void s.flow.launchDrones(bay).catch(say("Drones"));
        return true;
      }
      const inSpace = s.store.drones.get().inSpace;
      // CmdReconnectToDrones (menusvc.ReconnectToDrones): the ship's drones in space that it no longer controls
      if (cmd === "CmdReconnectToDrones") {
        const lost = (inSpace ?? []).filter((d) => !d.controlled).map((d) => d.itemID);
        if (lost.length) void s.flow.reconnectDrones(lost).catch(say("Drones"));
        return true;
      }
      const ids = orderableDroneIDs(inSpace, snap?.entities ?? null, snap?.ship?.itemID ?? null);
      const target = activeTargetID.get();
      if (cmd === "CmdDronesReturnToBay" || cmd === "CmdDronesReturnAndOrbit") {
        if (ids.length === 0) return true;
        const toBay = cmd === "CmdDronesReturnToBay";
        void (toBay ? s.flow.recallDrones(ids) : s.flow.returnDronesAndOrbit(ids)).then(() => {
          // with an active target the client says what the drones were told (the Command notice)
          if (target === null) return;
          const text = toBay ? word("UI/Commands/DronesReturningToDroneBay", {}, "Drones returning to drone bay")
            : word("UI/Commands/DronesReturningAndOrbiting", {}, "Drones returning and orbiting");
          s.flow.sayDialog("Command", { type: "dict", entries: [["command", text]] }, text);
        }).catch(say("Drones"));
        return true;
      }
      droneOrder("primary", ids);
      return true;
    }
    return false;
  }

  /**
   * The drone orders the window's buttons, the keys and the space menu (menusvc._DroneMenu) give, for the drones named:
   * PerformPrimaryAction (combat drones EngageTarget, salvage drones Salvage, mining drones MineRepeatedly, each at the
   * active target; DroneCommandRequiresActiveTarget without one, but a salvage), Return and Orbit, Return to Drone Bay
   * (the Command notice with an active target), Scoop to Drone Bay.
   */
  function droneOrder(kind: "primary" | "orbit" | "bay" | "scoop" | "abandon", ids: readonly number[]): void {
    const s = session;
    if (!s || ids.length === 0) return;
    const say = (title: string) => (cause: unknown) => notify({ kind: "danger", title, detail: cause instanceof Error ? cause.message : String(cause) });
    const word = (label: string, args: Record<string, unknown>, own: string) => {
      const t = s.store.words.get().templates[label];
      return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args as never, { nameOf: () => null } as never)) : own;
    };
    const inSpace = s.store.drones.get().inSpace;
    const target = activeTargetID.get();
    if (kind === "scoop") { void s.flow.scoopDrones(ids).catch(say("Drones")); return; }
    if (kind === "abandon") { void s.flow.abandonDrones(ids).catch(say("Drones")); return; }
    if (kind === "orbit" || kind === "bay") {
      const toBay = kind === "bay";
      void (toBay ? s.flow.recallDrones(ids) : s.flow.returnDronesAndOrbit(ids)).then(() => {
        if (target === null) return;
        const text = toBay ? word("UI/Commands/DronesReturningToDroneBay", {}, "Drones returning to drone bay")
          : word("UI/Commands/DronesReturningAndOrbiting", {}, "Drones returning and orbiting");
        s.flow.sayDialog("Command", { type: "dict", entries: [["command", text]] }, text);
      }).catch(say("Drones"));
      return;
    }
    {
      const groupOf = (typeID: number) => s.store.names.get().resolved[nameKey("typeGroup", typeID)] ?? null;
      const salvage = salvageDroneIDs(ids, inSpace, groupOf);
      const mining = miningDroneIDs(ids, inSpace, groupOf);
      const combat = ids.filter((id) => !salvage.includes(id) && !mining.includes(id));
      void (async () => {
        const needTarget = () => {
          s.flow.sayDialog("DroneCommandRequiresActiveTarget", null, "You need an active target to do that.");
          return false;
        };
        if (combat.length) {
          if (target === null) return needTarget();
          await s.flow.engageDrones(combat, target);
          const name = activeTargetName.get() ?? "";
          const text = word("UI/Inflight/DronesEngaging", { name }, `Drones engaging ${name}`);
          s.flow.sayDialog("CustomNotify", { type: "dict", entries: [["notify", text]] }, text);
        }
        if (salvage.length) await s.flow.salvageDrones(salvage, target);
        if (mining.length) {
          if (target === null) return needTarget();
          await s.flow.mineWithDrones(mining, target);
        }
        return true;
      })().catch(say("Drones"));
    }
  }

  /** A key press as the client's command it is the default shortcut of (the command service's accelerators). */
  function onKey(e: KeyboardEvent) {
    if (stage !== "game") return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const cmd = commandForKey(e);
    if (cmd === null) return;
    if (cmd === "OpenMilitia" || cmd === "OpenFwEnlistment" || cmd === "OpenInsurgencyDashboard" || cmd === "OpenRelevantFWWindow") {
      e.preventDefault();
      openTheatersOfWar(cmd === "OpenMilitia" ? "warfare" : cmd === "OpenFwEnlistment" ? "enlistment" : cmd === "OpenInsurgencyDashboard" ? "insurgencies"
        : relevantMilitiaPage(session?.store.station.get().online?.warFactionID ?? null));
      return;
    }
    // CmdToggleMap (F10): the map; OnEsc: the map closed first, else the system menu (EscapeCommand)
    if (cmd === "CmdToggleMap") { e.preventDefault(); toggleStarMap(); return; }
    if (spaceCommand(cmd)) { e.preventDefault(); return; }
    if (cmd === "OnEsc") {
      e.preventDefault();
      if (starMap) toggleStarMap(false);
      else if (customsTarget) closeCustoms();
      else if (planetInMode) { if (planetModeView?.escapeCanLeave()) leavePlanetMode(); }
      else systemMenu = !systemMenu;
      return;
    }
    const tab = WINDOW_COMMANDS[cmd];
    if (!tab) return;
    e.preventDefault();
    const shown = wins.find((w) => w.id === tab);
    wins = shown ? closeWindow(wins, tab) : openFly(wins, tab);
  }

  // Space: the SpaceView, made when the pilot is in space and let go when docked.
  let spaceHost = $state<HTMLDivElement | null>(null);
  let view: SpaceView | null = null;
  const miningSurveyBusy = createSignal(false);
  const flightMiningSurvey: FlightMiningSurvey = {
    busy: miningSurveyBusy,
    async scan() {
      const pilot = session;
      const space = view;
      if (!pilot || !space || !canOpenMiningScan() || miningSurveyBusy.get()) return;
      miningSurveyBusy.set(true);
      try {
        const results = await pilot.flow.runSurveyScan();
        if (results !== null && view === space && session === pilot) {
          void pilot.flow.loadMiningHolds().catch(() => {});
          await space.playMiningSurvey(results, pilot.flow.requestOptions());
        }
      } finally {
        miningSurveyBusy.set(false);
      }
    },
  };
  function disableMiningOverlay(): void {
    session?.flow.clearSurveyScan();
    view?.clearMiningSurvey();
  }
  setContext("flightSpaceView", () => view);
  setContext("flightMiningSurvey", flightMiningSurvey);
  setContext("flightSimNow", () => live?.simNow() || null);
  $effect(() => {
    if (stage !== "game" || docked || !spaceHost || !session || !live) return;
    const s = session;
    const act = bridgeDo(s.flow.requestOptions());
    const st = s.store.station.get().station;
    const enteringSpace = entryWarpHistory;
    entryWarpHistory = null;
    let overviewScope = "";
    let contactsKey = "";
    let warsKey = "";
    let contacts: OverviewRelationships["contacts"] = null;
    let wars: OverviewRelationships["wars"] = [];
    let lastFleet: ReturnType<typeof s.store.fleet.get>["fleet"] = null;
    let fleetMembers = new Set<number>();
    let disposed = false;

    // Read relationships on demand for tabs with state exclusions. Refresh the held readings on the same
    // contact, fleet and war changes used by their windows.
    /**
     * The overview's text columns (overviewWindow.py 937 to 975): the fleet's tag on a thing (none where the pilot is in
     * no fleet), its corporation's and alliance's tickers in brackets (overviewUtil.GetCorpTickerName /
     * GetAllianceTickerName), the faction of an NPC owner (get_corporation_faction_id) and the militia it is in, by the
     * factions' names. What the columns shown need and the page has not is asked for (each ticker once).
     */
    function overviewAffiliation(rows: readonly Entity[], columns: ReadonlySet<string>): (e: Entity) => OverviewAffiliation {
      const flow = s.flow;
      const isNpcOwner = (id: number | null | undefined): boolean => typeof id === "number" && id > 9999 && id < 90_000_000;
      if (columns.has("CORPORATION") || columns.has("ALLIANCE")) {
        flow.requestOwnerTickers(
          columns.has("CORPORATION") ? rows.flatMap((e) => (e.corporationID ? [e.corporationID] : [])) : [],
          columns.has("ALLIANCE") ? rows.flatMap((e) => (e.allianceID ? [e.allianceID] : [])) : [],
        );
      }
      if (columns.has("FACTION")) flow.loadCorporationFactions();
      const tickers = flow.ownerTickers.get();
      const corpFactions = flow.corporationFactions.get();
      const resolved = s.store.names.get().resolved;
      const fleet = s.store.fleet.get();
      const inFleet = (fleet.fleet?.fleetID ?? null) !== null;
      const npcFaction = (e: Entity): number | null => {
        if (!isNpcOwner(e.ownerID) && !isNpcOwner(e.characterID)) return null;
        const owner = e.ownerID || e.characterID;
        return owner ? corpFactions?.[String(owner)] ?? null : null;
      };
      const wanted = new Set<number>();
      for (const e of rows) {
        const f = columns.has("FACTION") ? npcFaction(e) : null;
        if (f) wanted.add(f);
        if (columns.has("MILITIA") && e.warFactionID) wanted.add(e.warFactionID);
      }
      const missing = [...wanted].filter((id) => resolved[nameKey("faction", id)] === undefined).map((id) => ({ kind: "faction" as const, id }));
      if (missing.length) flow.requestNames(missing);
      const ticker = (v: string | null | undefined) => (typeof v === "string" ? `[${v}]` : null);
      const factionName = (id: number | null | undefined) => (id ? resolved[nameKey("faction", id)] ?? null : null);
      return (e) => ({
        tag: inFleet ? fleet.targetTags?.get(e.itemID) ?? null : "",
        corporation: e.corporationID ? ticker(tickers.corporations[String(e.corporationID)]) : null,
        alliance: e.allianceID ? ticker(tickers.alliances[String(e.allianceID)]) : null,
        faction: factionName(npcFaction(e)),
        militia: factionName(e.warFactionID),
      });
    }

    function overviewRelationships(): OverviewRelationships | undefined {
      const online = s.store.station.get().online;
      if (!online) return;
      const { characterID, corporationID } = online;
      const allianceID = online.allianceID ?? null;
      const fleet = s.store.fleet.get();
      const scope = `${characterID}:${corporationID}:${allianceID}`;
      if (scope !== overviewScope) {
        overviewScope = scope;
        contacts = null;
        wars = [];
        lastFleet = null;
        fleetMembers = new Set();
        if (!fleet.loaded) void s.flow.loadFleet(true).catch(() => {});
      }
      const nextContactsKey = `${scope}:${s.flow.contactStandingsChanged.get()}`;
      if (nextContactsKey !== contactsKey) {
        contactsKey = nextContactsKey;
        void s.flow.contactStandings().then(read => {
          if (!disposed && contactsKey === nextContactsKey) contacts = read;
        }).catch(() => {});
      }
      const nextWarsKey = `${scope}:${s.flow.warsChanged.get()}`;
      const warOwner = allianceID ?? corporationID;
      if (warOwner !== null && nextWarsKey !== warsKey) {
        warsKey = nextWarsKey;
        void s.flow.ownerWars(warOwner).then(read => {
          if (!disposed && warsKey === nextWarsKey) wars = read;
        }).catch(() => {});
      }
      const roster = fleet.availability === "ready" ? fleet.fleet : null;
      if (lastFleet !== roster) {
        lastFleet = roster;
        fleetMembers = new Set(roster ? authoritativeFleetMemberCharacterIDs({ availability: "ready", fleet: roster }) ?? [] : []);
      }
      return {
        corporationID, allianceID, warFactionID: online.warFactionID ?? null, fleetMembers, contacts, wars,
        now: BigInt(Date.now()) * 10000n + 116444736000000000n,
      };
    }

    // droneSvc: what each drone is doing comes from the park's OnDroneStateChange (and OnDroneControlLost), which the
    // server sends through destiny, not as a notification; the Drones window's read is taken again on each, coalesced.
    let droneReread: ReturnType<typeof setTimeout> | null = null;
    live.fxListeners.add((name) => {
      if (!["OnDroneStateChange", "OnDroneActivityChange", "OnDroneControlLost"].includes(name) || droneReread !== null) return;
      droneReread = setTimeout(() => { droneReread = null; void s.flow.loadDrones().catch(() => {}); }, 1000);
    });

    // The new HUD's module tooltip (moduleButtonTooltip.py): the types' static dogma facts (effects, default effect,
    // group) asked once a type, the attributes' icons and names once, and when each running module was switched off
    // (moduleController._stop_requested_at: the cycle it then finishes is its winding down).
    const typeFacts = new Map<number, DogmaTypeFacts | null>();
    const factsOf = (typeID: number): DogmaTypeFacts | null => {
      if (!typeFacts.has(typeID)) {
        typeFacts.set(typeID, null);
        void s.flow.typeDogmaFacts(typeID).then((f) => { typeFacts.set(typeID, f); }, () => { typeFacts.delete(typeID); });
      }
      return typeFacts.get(typeID) ?? null;
    };
    const TIP_ATTRIBUTES = [37, 160, 84, 83, 68, 67, 90, 97, 20, 105, 114, 118, 117, 116];
    const attributeLook = new Map<number, { readonly icon: string | null; readonly nameID: number | null }>();
    void s.flow.attributeDisplay(TIP_ATTRIBUTES).then((found) => {
      for (const [id, d] of found ?? []) attributeLook.set(id, { icon: d.iconFile ? `/client-res/${d.iconFile.replace(/^res:\//i, "").toLowerCase()}` : null, nameID: d.displayNameID });
      s.flow.requestWords([...MODULE_TOOLTIP_LABELS, ...NewShipHud.MENU_LABELS, "UI/Inflight/DronesEngaging", "UI/Commands/DronesReturningToDroneBay", "UI/Commands/DronesReturningAndOrbiting", "UI/Commands/ShowInfo", "UI/Inflight/StopMyShip", "UI/Inflight/StopMyCapsule", "UI/Inflight/Submenus/WarpToWithin", "UI/Inflight/WarpToWithin", "UI/Inflight/Submenus/SetDefaultWarpRange", "UI/Inflight/ApproachObject", "UI/Inflight/OrbitObject", "UI/Inflight/OrbitAtCurrentRange", "UI/Inflight/Submenus/KeepAtRange", "UI/Inflight/KeepAtCurrentRange", "UI/Inflight/AlignTo", "UI/Inflight/DockInStation", "UI/Inflight/Jump", "UI/Inflight/LookAtObject", "UI/Inflight/SetAsCameraInterest", "UI/Drones/EngageTarget", "UI/Drones/MineWithDrone", "UI/Drones/Salvage", "UI/Drones/ReturnDroneAndOrbit", "UI/Drones/ReturnDroneToBay", "UI/Drones/ScoopDroneToBay", "UI/Drones/AbandonDrone", "UI/Inflight/UnlockTarget", "UI/Inflight/LockTarget", "UI/Inflight/AddFirstWaypoint", "UI/Inflight/SetDestination", "UI/Inflight/AddWaypoint", "UI/Inflight/BookmarkLocation", "UI/PI/Common/ViewInPlanetMode", "UI/Overview/AddGroupToOverview", "UI/Overview/RemoveGroupFromOverview", CARGO_HOLD.label, ...SHIP_HOLDS.map((h) => h.label), ...[...attributeLook.values()].flatMap((a) => (a.nameID ? [`#${a.nameID}`] : []))]);
    }).catch(() => {});
    const stopAskedAt = new Map<number, number>();
    const tipWord = (label: string, args: Readonly<Record<string, unknown>>): string | null => {
      const template = s.store.words.get().templates[label];
      return typeof template === "string" ? formatTemplate(template, args as never, { nameOf: (kind: string, id: number) => (kind === "type" ? typeNames[String(id)]?.[0] ?? null : null) } as never) : null;
    };
    const attrOf = (item: { readonly attributes: readonly { readonly attributeID: number; readonly value: unknown }[] } | undefined, id: number): number | null => {
      const v = item?.attributes.find((a) => a.attributeID === id)?.value;
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    /**
     * capacitorFlow.ModuleRatePerSecond and _GetActiveDrain's terms, GJ a second: a module's discharge over its cycle
     * (duration and reactivation delay); a nosferatu's transfer as a gain; a capacitor booster's charge averaged over
     * its load and reload as a gain (only with a charge, and never as a preview: ModuleRatePerSecond answers none).
     */
    function capRateOf(itemID: number, groupID: number | null, preview: boolean): number | null {
      const allInfo = s.store.dogma.get().allInfo;
      const item = allInfo?.ships.find((i) => Number(i.itemID) === itemID);
      if (!item) return null;
      const duration = attrOf(item, 73) ?? 0;
      if (!duration) return null;
      const cycle = duration + (attrOf(item, 669) ?? 0);
      if (groupID === 76) {
        if (preview) return null;
        const charge = allInfo?.ships.find((i) => (i.sublocation || i.categoryID === 8) && i.flagID === item.flagID);
        const bonus = attrOf(charge, 67) ?? 0;
        const volume = attrOf(charge, 161) ?? 0;
        if (!charge || !bonus || !volume) return null;
        const n = Math.trunc((attrOf(item, 38) ?? 0) / volume);
        const reload = attrOf(item, 1795) ?? 0;
        const avg = n > 0 ? (n * bonus) / (n * duration + reload) * duration : 0;
        return -avg / cycle * 1000;
      }
      if (groupID === 68) { const amount = attrOf(item, 90) ?? 0; return amount ? -amount / cycle * 1000 : null; }
      const need = attrOf(item, 6) ?? 0;
      return need ? need / cycle * 1000 : null;
    }

    function moduleTooltip(m: HudModule) {
      const facts = factsOf(m.typeID);
      const allInfo = s.store.dogma.get().allInfo;
      const fitted = s.store.fitting.get();
      const item = allInfo?.ships.find((i) => Number(i.itemID) === m.itemID);
      const slot = fitted.slots.find((sl) => sl.module?.itemID === m.itemID);
      const loaded = slot?.module?.charge ?? null;
      const chargeItem = loaded ? allInfo?.ships.find((i) => i.typeID === loaded.typeID && (i.sublocation || i.categoryID === 8) && i.flagID === item?.flagID) : undefined;
      const banks = s.store.space.get().snapshot?.ship?.weaponBanks ?? {};
      const slaves = (banks[m.itemID] ?? []) as readonly number[];
      // GetModuleShortcut: the slot's CmdActivate<Rack>PowerSlot<n> (a module with a default effect only)
      // GetModuleShortcut: the key of the place the module's flag has in the ship's slot order
      const flag = ({ high: 27, mid: 19, low: 11 } as const)[m.family] + m.index;
      const place = slotOrderOf(fitted.activeShipID).indexOf(flag);
      const rack = ["High", "Medium", "Low"][Math.floor(place / 8)];
      const shortcut = facts && (facts.defaultEffectID ?? null) !== null && place >= 0 && rack ? shortcutOf(`CmdActivate${rack}PowerSlot${(place % 8) + 1}`) || null : null;
      const repair = s.flow.moduleRepairOf(m.itemID);
      return moduleTooltipRows({
        typeID: m.typeID,
        typeName: typeNames[String(m.typeID)]?.[0] ?? m.name ?? "",
        groupID: slot?.module?.groupID ?? facts?.groupID ?? null,
        numInGroup: slaves.length ? slaves.length + 1 : 0,
        shortcut,
        damagePercent: (m.damage ?? 0) * 100,
        repairing: repair !== null,
        charge: loaded ? { typeID: loaded.typeID, groupID: chargeItem?.groupID ?? factsOf(loaded.typeID)?.groupID ?? null, quantity: loaded.quantity, name: typeNames[String(loaded.typeID)]?.[0] ?? "" } : null,
        attr: (id) => attrOf(item, id),
        shipAttr: (id) => { const v = fitted.shipAttributes?.[id]; return typeof v === "number" ? v : null; },
        chargeAttr: (id) => attrOf(chargeItem, id),
        launcher: facts?.effects.includes(40) ?? false,
        turret: facts?.effects.includes(42) ?? false,
        usesMissiles: facts?.effects.includes(101) ?? false,
        pilotAttr: (id) => attrOf(allInfo?.shipModifiedCharAttributes ?? allInfo?.character ?? undefined, id),
        active: m.active,
        attributeIcon: (id) => attributeLook.get(id)?.icon ?? null,
        attributeName: (id) => { const nameID = attributeLook.get(id)?.nameID; const t = nameID ? s.store.words.get().templates[`#${nameID}`] : null; return typeof t === "string" ? plainText(t) : null; },
        typeIcon: (typeID) => typeIconUrl(typeID) ?? null,
      }, tipWord, (meters) => fmtDist(meters));
    }

    const v = new SpaceView(live, {
      gotoDirection: (x, y, z) => act("beyonce", "CmdGotoDirection", [x, y, z]).then(() => undefined),
      setSpeedFraction: (fraction) => act("beyonce", "CmdSetSpeedFraction", [fraction]).then(() => undefined),
      stop: () => s.flow.stopShip(),
      approach: (id) => s.flow.approach(id),
      // The client's default ranges where none is chosen (defaultRangeUtils.DEFAULT_RANGES: orbit and keep at range
      // 1,000 m, warp to 0 m); the radial menu chooses one by how far out it is let go.
      orbit: (id, range) => s.flow.orbit(id, range ?? 1000),
      keepAtRange: (id, range) => s.flow.keepAtRange(id, range ?? 1000),
      alignTo: (id) => s.flow.alignTo(id),
      warpTo: (id, range) => s.flow.warpTo(id, range ?? 0),
      activateGate: (id, typeID) => s.flow.activateGate(id, typeID),
      enterWormhole: (id) => s.flow.enterWormhole(id),
      // menusvc.Dock -> DockStation -> GetCloseAndTryCommand(itemID, RealDock): the client's system navigation (warp,
      // approach) to the station and then CmdDock; flow.dock is the bare CmdDock, which from beyond the docking radius
      // only sets the ship approaching (seen: 5,300 km off Perimeter II - Moon 1, slow-boating at 337 m/s).
      // dockingHeroNotificationService: the docking accepted - its intro and waiting loop (the outro when docked)
      dock: async (id) => {
        await s.flow.dockAt(id);
        if (!s.store.flight.get().actionError) dockingSound("start");
      },
      // directionalScanSvc.DirectionalScan: scanMgr.ConeScan(scanAngle, scanRange, *direction).
      coneScan: (angle, range, x, y, z) => act("scanMgr", "ConeScan", [angle, range, x, y, z]),
      dscanHologramTypes: (ids) => getDscanHologramTypes(ids, s.flow.requestOptions()),
      probes: () => {
        const operations = s.store.scanner.get().operations;
        return operations.status === "ready" ? operations.value.probes : [];
      },
      moveProbes: (moves) => s.flow.moveScannerProbes(moves),
      selectedSites: () => storeValue(probeSitesSelected),
      // MarkerScanResult.GetMenu: scanSvc.GetScanResultMenuWithIgnore, by the rules the scanner's list menu goes by
      resultMenu: (siteID) => {
        const result = s.store.scanner.get().probeResults?.results.find((each) => each.id === siteID);
        if (!result) return [];
        const templates = s.store.words.get().templates;
        const word = (label: string, args: Record<string, string | number> = {}): string | null => {
          const t = templates[label];
          return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args, { nameOf: () => "" })).trim() : null;
        };
        const own = s.store.space.get().snapshot?.ship?.position ?? null;
        const distance = own === null || result.pos === null ? null : Math.hypot(result.pos[0] - own.x, result.pos[1] - own.y, result.pos[2] - own.z);
        const entries: { label: string; run: () => void }[] = [];
        if (isAccurate(result)) {
          if (distance !== null && distance > MIN_WARP_DISTANCE) {
            const within = storeValue(s.flow.warpDistance) || 0;
            entries.push({ label: word(PROBE_RESULT_LABELS.warpToWithinDistance, { distance: fmtDist(within) }) ?? `Warp to Within ${fmtDist(within)}`,
              run: () => { void s.flow.warpToProbeResult(siteID, within).catch(() => {}); } });
          }
          entries.push({ label: word(PROBE_RESULT_LABELS.alignTo) ?? "Align To", run: () => { void s.flow.alignToProbeResult(siteID).catch(() => {}); } });
        }
        entries.push({ label: word(PROBE_RESULT_LABELS.ignoreResult) ?? "Ignore Result", run: () => s.flow.ignoreProbeResults([siteID]) });
        entries.push({ label: word(PROBE_RESULT_LABELS.ignoreOtherResults) ?? "Ignore Other Results", run: () => s.flow.ignoreOtherProbeResults([siteID]) });
        return entries;
      },
      // MarkerScanResult.GetLabelText (id, scanSvc.GetDisplayName, distance) and GetBracketLabelText's difficulty line
      resultLabel: (siteID) => {
        const held = s.store.scanner.get().probeResults;
        const result = held?.results.find((each) => each.id === siteID);
        if (!result) return siteID;
        const templates = s.store.words.get().templates;
        const word = (label: string, args: Record<string, string | number> = {}): string | null => {
          const t = templates[label];
          return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args, { nameOf: () => "" })).trim() : null;
        };
        const resolved = s.store.names.get().resolved;
        const nameOf = (kind: "type" | "group", id: number): string | null => {
          const name = resolved[nameKey(kind, id)];
          return typeof name === "string" && name.trim() !== "" ? name : null;
        };
        // what the name needs, asked for as the scanner's list asks (its type and group, a site's dungeon name)
        const site = result.scanGroupID === SCAN_GROUP.signatures || result.scanGroupID === SCAN_GROUP.anomalies;
        const words = [...PROBE_RESULT_WORD_LABELS, "UI/Inflight/Scanner/ScanningDifficulty", "UI/Inflight/Scanner/DifficultyUnknown", "UI/Agents/AgentEntry/Level"];
        if (site && result.dungeonNameID !== null) words.push(`#${result.dungeonNameID}`);
        s.flow.requestWords(words);
        if (!site) s.flow.requestNames([...(result.typeID !== null ? [{ kind: "type" as const, id: result.typeID }] : []),
          ...(result.groupID !== null ? [{ kind: "group" as const, id: result.groupID }] : [])]);
        const own = s.store.space.get().snapshot?.ship?.position ?? null;
        const [row] = resultRows([result], own === null ? null : [own.x, own.y, own.z], {
          words: (label) => word(label),
          typeName: (typeID) => nameOf("type", typeID),
          groupName: (groupID) => nameOf("group", groupID),
          messageText: (messageID) => word(`#${messageID}`),
        });
        let text = [siteID, row?.name ?? "", row?.distance === null || row?.distance === undefined ? "" : fmtDist(row.distance)].filter((part) => part !== "").join(" ");
        if (result.certainty < 1) {
          const difficulty = result.difficulty === null
            ? word("UI/Inflight/Scanner/DifficultyUnknown") ?? "Unknown"
            : word("UI/Agents/AgentEntry/Level", { level: romanLevel(result.difficulty) }) ?? `Level ${romanLevel(result.difficulty)}`;
          text += "\n" + (word("UI/Inflight/Scanner/ScanningDifficulty", { difficulty }) ?? `Scanning Difficulty: ${difficulty}`);
        }
        return text;
      },
      selectSite: (siteID, multiSelect) => selectProbeSite(siteID, multiSelect),
      // scanHandler.GetResults: the session's system's results less the ignored and the filtered
      scanResults: () => {
        const held = s.store.scanner.get().probeResults;
        if (held === null) return [];
        return splitResults(held.results, new Set(held.ignored.map((result) => result.id)), held.filter).shown;
      },
      primeLocations: (itemIDs) => s.flow.requestNames(itemIDs.map((id) => ({ kind: "evelocation" as const, id }))),
      locationName: (itemID) => {
        const name = s.store.names.get().resolved[nameKey("evelocation", itemID)];
        return typeof name === "string" && name !== "" ? name : null;
      },
      shipAttribute: (attributeID) => {
        const value = s.store.fitting.get().shipAttributes?.[attributeID];
        return typeof value === "number" && Number.isFinite(value) ? value : null;
      },
      word: (label, args) => {
        const t = s.store.words.get().templates[label];
        return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args ?? {}, { nameOf: () => "" })) : null;
      },
      openCargo: (id) => s.flow.openCargo(id),
      openShipHold: (key) => shipHoldTarget.ask(key),
      // the space menu's Set Destination / Add Waypoint (starmap.SetWaypoint) and Save Location... (the bookmark window)
      setDestination: (itemID) => s.flow.setDestination(itemID),
      droneOrder: (kind, ids) => droneOrder(kind, ids),
      addWaypoint: (itemID) => s.flow.addWaypoint(itemID),
      saveLocation: (itemID) => {
        const e = s.store.space.get().snapshot?.entities.find((x) => x.itemID === itemID);
        const name = e?.name ?? (e?.typeID ? typeNames[String(e.typeID)]?.[0] ?? "" : "");
        spaceBookmark = { itemID, askIfKnown: false, typeName: () => (e?.typeID ? typeNames[String(e.typeID)]?.[0] ?? "" : ""), name: () => name };
      },
      loadShipHolds: () => s.flow.loadMiningHolds().catch(() => {}),
      autopilotOn: () => s.flow.autopilotOn.get(),
      runCommand: (cmd) => {
        // LeftSideButtonAutopilot / the new HUD's autopilot button: autoPilot.SetOn, or SetOff where it is on
        if (cmd === "CmdToggleAutopilot") {
          if (s.flow.autopilotOn.get()) s.flow.deactivateAutopilot();
          else void s.flow.activateAutopilot().catch(() => {});
        } else if (cmd === "ToggleNewHud") {
          setHudSetting("shipHudNew_preview", false);
          location.reload();
        } else if (cmd === "OpenDamageAlertSettings") {
          // NotifySettingsWindow.Open: the ship health alerts' settings
          damageAlertsOpen = true;
        } else if (cmd === "EnterMessageMovingMode") {
          // logger.MoveNotifications(True): the combat messages' box to be dragged
          combatMovingMode.set(true);
        } else if (WINDOW_COMMANDS[cmd]) open(WINDOW_COMMANDS[cmd]);
      },
      // The flow says a refused order as the client does and does not throw.
      // menusvc.StargateJump: flown to within 2,500 m of the gate first (GetCloseAndTryCommand), then the jump.
      jump: async (id) => {
        await s.flow.stargateJump(id);
        const refused = s.store.flight.get().actionError;
        if (refused) throw Object.assign(new Error(refused), { said: s.store.flight.get().actionErrorSaid === true });
      },
      lock: (id) => s.flow.lockTarget(id),
      unlock: (id) => s.flow.unlockTarget(id),
      // What is locked comes from the session's targeting slice, kept by the flow's lock events and reads.
      targets: async () => {
        const t = s.store.targeting.get();
        return {
          targetIDs: [...(t.lockedTargetIDs ?? [])],
          targeterIDs: [...((t as { lockedByIDs?: number[] }).lockedByIDs ?? [])],
          acquiringIDs: [...(t.acquiringTargetIDs ?? [])],
        };
      },
    }, { system: st?.solarSystemName ?? "", security: st?.security ?? null }, {
      covered: () => planetInMode !== null,
      onNeocom: neocomOpen,
      flightSnapshot: () => s.store.space.get().snapshot,
      targeting: {
        scanResolution: (shipID) => {
          const fit = s.store.fitting.get();
          const own = s.store.dogma.get().allInfo?.ships.find((item) => Number(item.itemID) === shipID);
          const liveValue = fit.activeShipID === shipID ? fit.shipAttributes?.[564] : null;
          const value = liveValue ?? own?.attributes.find(({ attributeID }) => attributeID === 564)?.value;
          return typeof value === "number" ? value : null;
        },
        typeRadii: (typeID) => s.flow.targetLockRadii(typeID),
      },
      miningSurvey: () => s.store.mining.get(),
      miningScanFacts: typeID => s.flow.miningScanFacts([typeID]),
      onMiningGridExit: () => s.flow.clearSurveyScan(),
      indicationWords: () => s.store.words.get().templates,
      onSystem: musicSystem,
      windowLayer: windowsEl ? windowLayer : undefined,
      undocking: () => performance.now() - undockedAt < 20000,
      entryWarpHistory: enteringSpace ?? undefined,
      recordCameraTask: s.flow.recordCameraTask,
      overviewPilotID: s.store.station.get().online?.characterID,
      mountJumpBridge: (target, gate, initial) => {
        const state = createSignal(initial);
        const panel = mount(JumpBridgePanel, { target, props: { session: s, gate, state, simNow: () => live.simNow() } });
        return { update: next => state.set(next), destroy: () => { void unmount(panel); } };
      },
      jumpBridge: (id) => s.flow.jumpThroughAnsiblex(id),
      openAutoMoonMiner: showAutoMoonMiner,
      openMoonMaterialBay: showMoonMaterialBay,
      boardMetenox,
      transferMetenoxFuel: transferToMetenox,
      wormholePolarization: (id) => s.flow.wormholePolarization(id),
      overviewNotice: (text) => s.flow.sayDialog("CustomNotify", { type: "dict", entries: [["notify", text]] }, text),
      overviewAsk: (dialog, fallback) => s.flow.askClientDialog(dialog, fallback),
      ownerTickers: (corporationID, allianceID) => {
        const npc = (id: number | null) => id !== null && id < 2_000_000;
        s.flow.requestOwnerTickers(corporationID && !npc(corporationID) ? [corporationID] : [], allianceID ? [allianceID] : []);
        const t = s.flow.ownerTickers.get();
        return { corporation: corporationID ? t.corporations[String(corporationID)] ?? null : null, alliance: allianceID ? t.alliances[String(allianceID)] ?? null : null };
      },
      overviewRelationships,
      overviewAffiliation,
      // the reloads the server announced (turret.py OnChargeBeingLoadedToModule: the turrets play Reload)
      reloads: () => s.store.fitting.get().reloads ?? {},
      corpTickers: (corpIDs) => corpTickers(corpIDs, false, s.flow.requestOptions()).then((r) => r.tickers),
      sovHub: {
        deposit: (hubID) => { const sys = s.store.space.get().snapshot?.solarSystemID ?? s.store.station.get().online?.solarSystemID ?? 0; reagentBay = { hubID, solarSystemID: sys, isStationMgr: stationManager(s) }; },
        configure: (hubID) => { void openSovHubConfig(hubID); },
        configurable: (_hubID, corporationID) => corporationID !== null && corporationID === s.store.station.get().online?.corporationID && stationManager(s),
      },
      showInfo: (itemID, typeID) => {
        void s.flow.infoWindows.show({ kind: "spaceObject", itemID, typeID }, {}).catch((error) => {
          if (error?.code !== "SESSION_REQUEST_RETIRED") notify({ kind: "danger", title: "Show Info", detail: error instanceof Error ? error.message : String(error) });
        });
      },
      viewPlanet: showPlanetInMode,
      rack: {
        modules: () => {
          const active = new Set(s.store.space.get().snapshot?.ship?.activeModuleIDs ?? []);
          const overloaded = new Set(s.store.space.get().snapshot?.ship?.overloadedModuleIDs ?? []);
          // each module's damage over its hp, its bank's worst (GetModuleGroupDamage: a master's button stands for the bank)
          const damage = s.store.space.get().snapshot?.ship?.moduleDamage ?? {};
          const banks = s.store.space.get().snapshot?.ship?.weaponBanks ?? {};
          const damageOf = (id: number) => Math.max(damage[id] ?? 0, ...((banks[id] ?? []) as readonly number[]).map((slave) => damage[slave] ?? 0));
          const cycles = s.store.targeting.get().moduleCycles ?? {};
          const now = Date.now();
          const out: HudModule[] = [];
          for (const slot of s.store.fitting.get().slots ?? []) {
            const m = slot.module;
            if (!m || (slot.family !== "high" && slot.family !== "mid" && slot.family !== "low")) continue;
            // The cycle's start and length are the server's effect notice's (OnGodmaShipEffect, riding an OnMultiEvent).
            const cycle = cycles[m.itemID] ?? null;
            const pct = cycleProgressPercent(cycle, now);
            // whether the type has an overload effect (its effects' categories, asked of the BFF once a type)
            if (!overloadable.has(m.typeID)) {
              overloadable.set(m.typeID, null);
              void s.flow.overloadEffectOf(m.typeID).then((id) => overloadable.set(m.typeID, id !== null), () => overloadable.delete(m.typeID));
            }
            // GetUnavailableWindow (UNAVAILABLE_WINDING_DOWN): switched off while running, it finishes the cycle the
            // stop was asked in; the cycles start where the running one was seen to, one length after another.
            const running = active.has(m.itemID);
            factsOf(m.typeID); // asked now, so its tooltip has them when it opens
            if (!running) stopAskedAt.delete(m.itemID);
            const asked = stopAskedAt.get(m.itemID);
            let windingDown: HudModule["windingDown"] = null;
            if (running && asked !== undefined && cycle && cycle.startedAtMs !== null && cycle.durationMs > 0) {
              const cycleStart = cycle.startedAtMs + Math.max(0, Math.floor((asked - cycle.startedAtMs) / cycle.durationMs)) * cycle.durationMs;
              if (now < cycleStart + cycle.durationMs) windingDown = { startedAtMs: cycleStart, durationMs: cycle.durationMs };
            }
            // The slot shows a loaded charge's icon and count (moduleSlot._OnChargeChanged); a crystal's count is not shown.
            const charge = m.charge && m.charge.quantity > 0 ? m.charge : null;
            const typeFact = factsOf(m.typeID);
            const chargeGroup = charge ? factsOf(charge.typeID)?.groupID ?? null : null;
            out.push({ family: slot.family, index: slot.index, itemID: m.itemID, typeID: m.typeID, name: typeNames[String(m.typeID)]?.[0] ?? undefined, online: m.online, active: running, icon: typeIconUrl(charge ? charge.typeID : m.typeID) ?? "", cycle: pct === null ? null : pct / 100,
              overloadable: overloadable.get(m.typeID) ?? null, overloaded: overloaded.has(m.itemID), damage: damageOf(m.itemID),
              repair: s.flow.moduleRepairOf(m.itemID),
              charge: charge ? { typeID: charge.typeID, quantity: charge.quantity, crystal: chargeGroup !== null && CRYSTAL_GROUPS.has(chargeGroup) } : null,
              windingDown,
              reload: (() => { const r = s.store.fitting.get().reloads[m.itemID]; return r && now < r.startedAtMs + r.durationMs ? { startedAtMs: r.startedAtMs, durationMs: r.durationMs } : null; })(),
              // HasActivatibleEffect: a type with no default effect is passive
              passive: typeFact !== null && (typeFact.defaultEffectID ?? null) === null,
              capRate: capRateOf(m.itemID, m.groupID, true) });
          }
          return out;
        },
        capacitor: () => ({
          max: s.store.fitting.get().resources?.capacitor?.total ?? null,
          ratio: s.store.space.get().snapshot?.ship?.capacitorRatio ?? null,
        }),
        targeting: (itemID) => s.flow.rackModuleTargeting(itemID),
        // shipmodulebutton.ActivateEffect uses the active lock for targeted effects.
        use: async (m, targetID, passiveLock) => {
          const running = (s.store.space.get().snapshot?.ship?.activeModuleIDs ?? []).includes(m.itemID);
          if (running && m.windingDown) return; // moduleController: a module winding down takes no click
          if (running) { stopAskedAt.set(m.itemID, Date.now()); await s.flow.deactivateModule(m.itemID, { typeID: m.typeID }); }
          else await s.flow.activateModule(m.itemID, {
            typeID: m.typeID, targetID, effect: passiveLock ? "targetPassively" : undefined,
          });
        },
        heat: () => s.store.space.get().snapshot?.ship?.rackHeat ?? null,
        tooltip: (m) => moduleTooltip(m),
        // tactical.FindMaxRange: the default effect's range attribute (maxRange) and falloff; a launcher's charge's
        // flight time x velocity where the module has no range of its own
        range: (m) => {
          const allInfo = s.store.dogma.get().allInfo;
          const item = allInfo?.ships.find((i) => Number(i.itemID) === m.itemID);
          const optimal = attrOf(item, 54) ?? 0;
          if (optimal > 0) return optimal + (attrOf(item, 158) ?? 0);
          const loaded = s.store.fitting.get().slots.find((sl) => sl.module?.itemID === m.itemID)?.module?.charge ?? null;
          const chargeItem = loaded ? allInfo?.ships.find((i) => i.typeID === loaded.typeID && (i.sublocation || i.categoryID === 8) && i.flagID === item?.flagID) : undefined;
          const flight = attrOf(chargeItem, 281) ?? 0, speed = attrOf(chargeItem, 37) ?? 0;
          return flight > 0 && speed > 0 ? (flight * speed) / 1000 : 0;
        },
        capacitorFlow: () => {
          const f = s.store.fitting.get();
          const capacity = f.shipAttributes?.[482] ?? null;
          const rechargeMs = f.shipAttributes?.[55] ?? null;
          if (!capacity || !rechargeMs) return null;
          // CapacitorSimulator: the peak recharge 2.5 x capacity over recharge time; the fit's need is the peak less its delta
          const peak = 2500 * capacity / rechargeMs;
          const delta = f.stats?.capacitor?.simulator?.delta;
          const need = typeof delta === "number" ? peak - delta : 0;
          const active = new Set(s.store.space.get().snapshot?.ship?.activeModuleIDs ?? []);
          let drain = 0;
          for (const slot of f.slots ?? []) {
            const m = slot.module;
            if (!m || !active.has(m.itemID)) continue;
            drain += capRateOf(m.itemID, m.groupID, false) ?? 0;
          }
          return { peak, maxDrain: need > 0 ? need : peak, drain };
        },
        slotOrder: () => slotOrderOf(s.store.fitting.get().activeShipID),
        // moduleTray.OnSlotDropped: a module of one type dropped on another linked (peeled with Ctrl), else the places swapped
        dropSlot: (to, from, peel) => s.flow.rackChangeSlots(to, from, peel),
        slotCounts: () => {
          const counts = { high: 0, mid: 0, low: 0 };
          for (const slot of s.store.fitting.get().slots ?? []) {
            if (slot.present === false || (slot.family !== "high" && slot.family !== "mid" && slot.family !== "low")) continue;
            counts[slot.family]++;
          }
          return counts;
        },
        overload: {
          module: (itemID, on) => s.flow.setModuleOverload(itemID, on),
          rack: (activationID, on) => s.flow.setRackOverload(activationID, on),
        },
      },
    });
    spaceHost.appendChild(v.root);
    view = v;
    // the combat notification's moving-mode example text (UI/Accessories/Log/ExampleText)
    s.flow.requestWords([
      "UI/Accessories/Log/ExampleText", "UI/Accessories/Log/ExitMessageMovingMode",
      ...INDICATION_WORD_LABELS, ...OVERVIEW_WORDS, OPEN_CARGO_LABEL, ENTER_WORMHOLE_LABEL, POLARIZED_LABEL, IN_WARP_HINT_LABEL, "UI/Inflight/Messages/ShipFullSpeedHeader", "UI/Commands/SpeedChangedTo",
    ]);
    const combatWord = (label: string, own: string) => { const t = s.store.words.get().templates[label]; return typeof t === "string" ? plainText(t) : own; };
    v.combatMessage.exampleText = () => combatWord("UI/Accessories/Log/ExampleText", "Example Text");
    v.combatMessage.exitHint = () => combatWord("UI/Accessories/Log/ExitMessageMovingMode", "Exit Message Moving Mode");
    // The client's drones window comes up in space for a ship with a drone bay.
    void s.flow.loadDrones().then(() => {
      const d = s.store.drones.get();
      if ((d.limits.droneBandwidth ?? 0) > 0 || (d.bay?.length ?? 0) > 0) open("drones");
    }).catch(() => {});
    (window as unknown as { __play: unknown }).__play = { live, view: v, session: s };
    // Damage numbers: each new entry of the damage log (the client's damage notifications) floats up in space.
    let lastDamageID = s.store.targeting.get().damageLog.at(-1)?.id ?? 0;
    const stopDamage = s.store.targeting.subscribe((t) => {
      for (const d of t.damageLog) if (d.id > lastDamageID) { v.showDamage(d); logCombatLine(d); }
      lastDamageID = t.damageLog.at(-1)?.id ?? lastDamageID;
    });
    return () => { disposed = true; stopDamage(); v.dispose(); view = null; };
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
    if (now) { fadeTo(0, 2000, 1); dockingSound("end"); return; }
    fadeTo(1, 0, 1);
    // in space: the black holds until the pilot's ship is in the park (or 4 s at most), then lifts
    const started = performance.now();
    const wait = () => {
      const ship = live?.hello?.shipID ?? null;
      const there = !!live?.park.validState && ship !== null && live.park.ballpark.balls.has(ship);
      if (there || performance.now() - started > 4000) { fadeTo(0, 1000); dockingSound("end"); } else setTimeout(wait, 100);
    };
    setTimeout(wait, 100);
  });

  /**
   * The docking / undocking hero notification's sounds (dockingHeroNotificationService.py): play_intro_sound
   * (docking_overlay_start_play) and play_loop_sound (docking_overlay_waiting_play) as it starts - the docking
   * accepted, the undock begun -, play_outro_sound (docking_overlay_waiting_stop, _end_play, _outro_play) as it ends -
   * in the station, in space. (The notification's own text is not drawn.)
   */
  let dockingSounding = false;
  function dockingSound(phase: "start" | "end") {
    if (phase === "start") {
      if (dockingSounding) return;
      dockingSounding = true;
      void playUiEvent("docking_overlay_start_play");
      void playUiEvent("docking_overlay_waiting_play");
      return;
    }
    if (!dockingSounding) return;
    dockingSounding = false;
    void playUiEvent("docking_overlay_waiting_stop");
    void playUiEvent("docking_overlay_end_play");
    void playUiEvent("docking_overlay_outro_play");
  }

  let undockedAt = -Infinity;
  let undockPending = $state(false);
  async function undock() {
    if (!session || undockPending || controllingStructure || refineryPending) return;
    const pilot = session;
    undockPending = true;
    error = "";
    undockedAt = performance.now();
    fadeTo(1, 500);
    dockingSound("start");
    try {
      await pilot.flow.undock();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      undockPending = false;
      if (session === pilot && pilot.store.flight.get().status?.inSpace !== true) {
        undockedAt = -Infinity;
        fadeTo(0, 300);
        dockingSound("end");
      }
    }
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
  {#if controllingMetenox && docked}
    <div class="station">
      <div class="fly-neocom" bind:this={neocomHost}></div>
      <div class="pw fly-lobby metenox-lobby">
        <div class="pw-head"><span class="pw-caption">Structure Control</span></div>
        <div class="pw-body lobby-body">
          <div class="station-name">{metenoxControl?.miner.name ?? "Metenox Moon Drill"}</div>
          <button class="academy-service" onclick={reopenMetenoxFuel}>Fuel Bay</button>
          <button class="academy-service" onclick={() => open("fitting")}>Fitting</button>
        </div>
      </div>
    </div>
  {:else if docked}
    <!-- Docked: the ship in its hangar, the Neocom, and the client's Station Services window (dockedUI/lobbyWnd.py:
         280 px at the right edge, the station's name over its owner, the Undock button, the station's services). -->
    <div class="station">
      <div class="fly-hangar" class:planet-covered={planetInMode !== null} bind:this={hangarHost}></div>
      <div class="fly-neocom" bind:this={neocomHost}></div>
      <div class="pw fly-lobby" class:planet-covered={planetInMode !== null}>
        <div class="pw-head"><img class="pw-icon" alt="" src={clientTexture("res:/UI/Texture/WindowIcons/docking.png")} /><span class="pw-caption">Station Services</span></div>
        <div class="pw-body lobby-body">
          <div class="station-name">{moonRefinery?.name ?? $station?.station?.stationName ?? "Station"}</div>
          <div class="station-sub">{$station?.station?.solarSystemName ?? ""}{#if typeof $station?.station?.security === "number"}<span class="lobby-sec"> {$station.station.security.toFixed(1)}</span>{/if}</div>
          {#if controllingStructure}
            <div class="refinery-controls">
              {#if moonRefinery}<button class="academy-service" disabled={refineryPending} onclick={() => open("moonMining")}>Moon Mining</button>{/if}
              <button class="academy-service" disabled={refineryPending} onclick={() => changeRefineryControl(false)}>Release Control</button>
            </div>
          {:else}
            <button class="undock" disabled={undockPending || refineryPending} onclick={undock}>Undock</button>
            {#if moonRefinery?.canControl}
              <button class="academy-service" disabled={refineryPending || undockPending} onclick={() => changeRefineryControl(true)}>Take Control</button>
            {/if}
          {/if}
          {#if refineryError}<div class="error lobby-error" role="alert">{refineryError}</div>{/if}
          {#if academyAccess !== "hidden"}
            <button class="academy-service" disabled={academyAccess === "locked"}
              onclick={() => wins.some(win => win.id === "academyShips") ? wins = closeWindow(wins, "academyShips") : open("academyShips")}>
              {academyLabel}
            </button>
          {/if}
          {#if error}<div class="error lobby-error">{error}</div>{/if}
          <div class="lobby-services">
            {#each LOBBY_SERVICES as svc (svc.label)}
              <button class="lobby-svc" title={svc.label} onclick={() => open(svc.tab)}><img alt="" src={clientTexture(`res:/UI/Texture/WindowIcons/${svc.icon}.png`)} /><span>{svc.label}</span></button>
            {/each}
            {#if militiaOfficeAvailable}
              <button class="lobby-svc" title="Militia Office" onclick={() => openTheatersOfWar(relevantMilitiaPage($station?.online?.warFactionID ?? null))}>
                <img alt="" src={clientTexture("res:/UI/Texture/WindowIcons/factionalwarfare.png")} /><span>Militia Office</span>
              </button>
            {/if}
          </div>
          <PlayLobbyTabs {session} onOpenAgents={() => open("agents")} />
        </div>
      </div>
    </div>
  {:else}
    <div class="fly-space" class:planet-covered={planetInMode !== null} bind:this={spaceHost}></div>
    {#if controllingMetenox}
      <button class="metenox-controls" onclick={reopenMetenoxFuel}>Fuel Bay</button>
    {/if}
    {#if !docked && session}
      <MiningOverlayControl store={session.store} survey={flightMiningSurvey}
        openResults={() => open("miningScan")} openLedger={() => open("miningLedger")} disable={disableMiningOverlay} />
    {/if}
    <!-- hudLayer._ConstructKeepers: the new HUD's buff bar centred on the medallion, its foot on the band's top -->
    <div class="fly-buffs" class:new-hud={newHudOn} class:hud-top={$hudTop}><BuffBar store={session.store} flow={session.flow} /></div>
  {/if}
  {#if session && reagentBay}<SovReagentBay store={session.store} flow={session.flow} hubID={reagentBay.hubID} solarSystemID={reagentBay.solarSystemID} isStationMgr={reagentBay.isStationMgr} onClose={() => { reagentBay = null; }} />{/if}
  {#if session && sovHubConfig}
    {@const cfg = sovHubConfig}
    <div class="fly-sovhub"><SovHubWindow store={session.store} flow={session.flow} hub={cfg.hub} details={cfg.details} extras={cfg.extras} rangeTo={(id) => view?.distanceToItem(id) ?? null} onClose={() => { sovHubConfig = null; }} onChanged={() => openSovHubConfig(cfg.hub.hubID)} /></div>
  {/if}
  <!-- the star map's host, over the hangar or space and under the windows -->
  <div class="fly-map" class:foreground={mapInFront} bind:this={mapHost}></div>
  {#if planetInMode}
    {#key planetInMode.planetID}
      <PlanetMode bind:this={planetModeView} colony={planetInMode} store={session.store} flow={session.flow}
        onClose={() => leavePlanetMode()} onAccessCustoms={openCustoms} />
    {/key}
  {/if}

  <!-- The info panels (InfoPanelContainer) at the top of the left side, beside the Neocom, under the windows. -->
  <ErrorBoundary name="Info panels"><PlayInfoPanels store={session.store} flow={session.flow} showAgents={() => open("agents")} openRouteWindow={() => open("routeWindow")} /></ErrorBoundary>

  <!-- The app's windows over space or the station, in front of the 3D view and under nothing else. -->
  <div class="fly-fade" bind:this={fadeEl}></div>

  <div class="fly-windows" class:planet-covered={planetInMode !== null} bind:this={windowsEl}>
    {#each wins as win (win.id)}
      <ErrorBoundary name={tabLabel(win.id)}>
        <DesktopWindow
          {win}
          title={win.id === "drones" ? dronesTitle : captions[win.id] ?? tabLabel(win.id)}
          focused={win.id === focusedId}
          onFocus={() => { wins = focusWindow(wins, win.id); raiseApp(win.id); }}
          onClose={() => (wins = closeWindow(wins, win.id))}
          onToggleMinimize={() => (wins = toggleMinimize(wins, win.id))}
          onMove={(x, y) => (wins = moveWindow(wins, win.id, x, y))}
          onResize={(w, h) => (wins = resizeWindow(wins, win.id, w, h))}
        >
          {#snippet headerActions()}
            {#if win.id === "log"}<GameLogActions store={session.store} flow={session.flow} />{/if}
          {/snippet}
          <!-- (the drones window in the client's layout: FlyDronesWindow; the workspace keeps DronesPanel) -->
          {#if win.id === "drones"}
            <FlyDronesWindow store={session.store} flow={session.flow} />
          {:else}
            <PanelHost store={session.store} flow={session.flow} tab={win.id} onOpen={(t) => open(t)} onClose={() => (wins = closeWindow(wins, win.id))}
              onShowConvoys={() => toggleStarMap(true, "convoys")} onShowSystem={showSystemOnMap} {moonRefinery} {autoMoonMiner}
              onViewPlanet={showPlanetInMode} viewingPlanetID={planetModeID} onAccessCustoms={openCustoms}
              {moonMaterialBay} {metenoxTransfer} {metenoxControl} onLeaveMetenox={leaveMetenox} />
          {/if}
        </DesktopWindow>
      </ErrorBoundary>
    {/each}
  </div>

  {#if customsTarget && session}
    {#key customsTarget}
      <CustomsOffice planetID={customsTarget.planetID} pinID={customsTarget.pinID} store={session.store} flow={session.flow}
        close={closeCustoms} openCargo={openCustomsCargo} />
    {/key}
  {/if}

  <NoticeBridge store={session.store} flow={session.flow} />
  <ErrorBoundary name="Fleet invitation">
    <div class="fleet-invitations fly-invitations"><FleetInvitation {session} inFront={true} /></div>
  </ErrorBoundary>
  <ErrorBoundary name="Server question"><ServerQuestion store={session.store} flow={session.flow} /></ErrorBoundary>
  <ErrorBoundary name="Client dialogs"><ClientDialogs {session} inFront={true} /></ErrorBoundary>
  <ErrorBoundary name="Scanner results"><ScannerWindows {session} inFront={true} /></ErrorBoundary>
  <ErrorBoundary name="Info windows"><InfoWindows {session} inFront={true} host={windowsEl ? infoHost : null} /></ErrorBoundary>
  <ErrorBoundary name="Calendar windows"><CalendarWindows {session} inFront={true} host={windowsEl ? infoHost : null} /></ErrorBoundary>
  <ErrorBoundary name="Ship restrictions"><ShipRestrictionsWindow {session} inFront={true} /></ErrorBoundary>
  <ErrorBoundary name="Hacking"><HackingWindow {session} /></ErrorBoundary>
  <Toasts />
  {#if systemMenu}
    <ErrorBoundary name="System menu"><SystemMenu store={session.store} flow={session.flow} onClose={() => (systemMenu = false)} /></ErrorBoundary>
  {/if}
  {#if spaceBookmark}
    <ErrorBoundary name="Save Location"><BookmarkWindow store={session.store} flow={session.flow} place={spaceBookmark} onDone={() => (spaceBookmark = null)} /></ErrorBoundary>
  {/if}
  {#if damageAlertsOpen}
    <ErrorBoundary name="Ship health alerts"><DamageAlertSettings store={session.store} onClose={() => (damageAlertsOpen = false)} /></ErrorBoundary>
  {/if}
{/if}

<style>
  .fly-space { position: fixed; inset: 0; }
  .fly-hangar.planet-covered, .fly-space.planet-covered :global(.space > :not(.neocom)),
  .fly-windows.planet-covered :global(.space-only-window) { visibility: hidden; }
  .fly-buffs { position: fixed; bottom: 200px; left: 50%; transform: translateX(-50%); pointer-events: none; }
  .fly-buffs :global(.buff-slot) { pointer-events: auto; }
  /* band 1182 wide, 300 right of centre, its medallion 175 in: the medallion 116 left of the screen's centre; 200 + 20 up */
  .fly-buffs.new-hud { bottom: 220px; left: calc(50% - 116px); }
  .fly-buffs.new-hud.hud-top { bottom: auto; top: 220px; }
  .fly-sovhub { position: fixed; inset: 0; z-index: 30; pointer-events: none; }
  .fly-sovhub > :global(*) { pointer-events: auto; }
  .fly-windows { position: fixed; inset: 0; pointer-events: none; z-index: 20; }
  .fly-invitations { --char-bar-h: 0px; }
  .fly-fade { position: fixed; inset: 0; background: #000; pointer-events: none; z-index: 15; opacity: 0; }
  /* the layer's windows take the pointer; the info windows' own full-size layer does not (its windows do) */
  .fly-windows :global(> :not(.info-window-layer, .calendar-window-layer)) { pointer-events: auto; }
  .fly-hangar { position: absolute; inset: 0; }
  .fly-hangar :global(.hangar-view) { position: absolute; inset: 0; }
  .fly-neocom { position: absolute; left: 0; top: 0; bottom: 0; width: 44px; }
  /* The fitting window's ring as the client's (fittingLayout.py, slotAdder.py, slot.py): the 640 base scaled by
     GetScaleFactor (min(1, max(0.75, desktop width / 1400))), each slot 44 x 54 turned by its angle with its module
     frame (moduleFrame.png, padded 8 x 4) under it, a fitted module's icon (48) turned back upright, an empty slot's
     icon turning with it; a missing flag at 0.05. */
  .fly-windows :global(.fit-ring.retail) { width: min(100%, calc(640px * max(0.75, min(1, 100vw / 1400px)))); max-width: none; min-width: 0; aspect-ratio: 1; }
  .fly-windows :global(.fit-ring.retail .fit-base) { position: absolute; inset: 0; pointer-events: none; background: var(--tint);
    -webkit-mask: var(--tex) center / 100% 100% no-repeat; mask: var(--tex) center / 100% 100% no-repeat; }
  /* ShipSceneParent: 550 of the 640 base, in the middle, through circleStencil.dds */
  .fly-windows :global(.fit-ring.retail .fit-ship-scene) { position: absolute; left: 7.03%; top: 7.03%; width: 85.94%; height: 85.94%;
    border-radius: 50%; overflow: hidden; -webkit-mask: radial-gradient(circle closest-side, #000 96%, transparent 100%);
    mask: radial-gradient(circle closest-side, #000 96%, transparent 100%); }
  .fly-windows :global(.fit-ring.retail .fit-hull.has-scene > .type-icon) { display: none; }
  .fly-windows :global(.fit-ring.retail .fit-hull.has-scene) { pointer-events: none; }
  .fly-windows :global(.fit-ring.retail .fit-hull.has-scene .fit-simulate) { pointer-events: auto; }
  .fly-windows :global(.fit-ring.retail .fit-gauges) { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  /* (GaugeCircular's UpdateThread: end moves 3 x the gap a second toward the value) */
  .fly-windows :global(.fit-ring.retail .fit-gauge) { fill: none; stroke-linecap: butt; transition: stroke-dasharray 0.33s ease-out; }
  .fly-windows :global(.fit-ring.retail .fit-gauge.over) { animation: fit-gauge-over 0.5s linear infinite; }
  @keyframes -global-fit-gauge-over { from { opacity: 0.25; } to { opacity: 1; } }
  .fly-windows :global(.fit-ring.retail .fit-socket), .fly-windows :global(.fit-ring.retail .fit-socket-absent) {
    position: absolute; width: var(--slot-w); height: var(--slot-h); transform: translate(-50%, -50%) rotate(var(--turn, 0deg));
    padding: 0; border: none; background: none; overflow: visible; display: flex; align-items: center; justify-content: center; }
  .fly-windows :global(.fit-ring.retail .fit-socket::before), .fly-windows :global(.fit-ring.retail .fit-socket-absent::before) {
    content: ""; position: absolute; inset: -7.4% -18.2%; pointer-events: none;
    background: url('/client-res/ui/texture/classes/fitting/moduleframe.png') center / 100% 100% no-repeat; }
  .fly-windows :global(.fit-ring.retail .fit-socket-absent) { opacity: 0.05; pointer-events: none; }
  /* baseSlot Hilite: the frame at 0.3, 0.5 under the mouse or picked; a simulated module's state hides it for the fill
     (slotActive / slotPassive / slotOverheated, padded as the frame, in fittingScreen's OFFLINE (0.5, 0.5, 0.5, 0.3),
     ONLINE 0.6 grey, ACTIVE (0.55, 0.87, 0.13), OVERHEATED (1, 0.17, 0.15)); an offline module's icon at 0.25
     (UpdateOnlineDisplay, SetStatusDisplayOffline). */
  .fly-windows :global(.fit-ring.retail .fit-socket::before) { opacity: 0.3; }
  .fly-windows :global(.fit-ring.retail .fit-socket:hover::before), .fly-windows :global(.fit-ring.retail .fit-socket.armed::before),
  .fly-windows :global(.fit-ring.retail .fit-socket.drop-target::before) { opacity: 0.5; }
  .fly-windows :global(.fit-ring.retail .fit-socket:is(.sim-offline, .sim-online, .sim-active, .sim-overheated)::before) { display: none; }
  .fly-windows :global(.fit-ring.retail .fit-slot-fill) { position: absolute; inset: -7.4% -18.2%; pointer-events: none; background: var(--fill);
    -webkit-mask: var(--tex) center / 100% 100% no-repeat; mask: var(--tex) center / 100% 100% no-repeat; }
  .fly-windows :global(.fit-ring.retail .sim-offline .fit-slot-fill) { --fill: rgba(128, 128, 128, 0.3); }
  .fly-windows :global(.fit-ring.retail .sim-online .fit-slot-fill) { --fill: rgb(153, 153, 153); }
  .fly-windows :global(.fit-ring.retail .sim-active .fit-slot-fill) { --fill: rgb(140, 222, 33); }
  .fly-windows :global(.fit-ring.retail .sim-overheated .fit-slot-fill) { --fill: rgb(255, 43, 38); }
  .fly-windows :global(.fit-ring.retail .fit-socket.offline .type-icon), .fly-windows :global(.fit-ring.retail .fit-socket.sim-offline .type-icon) { opacity: 0.25; }
  /* the charge indicator: 7 of the slot's 54 high, 2 above its top, its 44 wide the image's left 44 of 64 */
  .fly-windows :global(.fit-ring.retail .fit-charge) { position: absolute; left: 0; right: 0; top: -3.7%; height: 12.96%; overflow: hidden; pointer-events: none; }
  .fly-windows :global(.fit-ring.retail .fit-charge img) { position: absolute; left: 0; width: 145.45%; max-width: none; height: auto; }
  .fly-windows :global(.fit-ring.retail .fit-socket .type-icon), .fly-windows :global(.fit-ring.retail .fit-socket .type-icon-socket) {
    width: 109%; max-width: none; height: auto; aspect-ratio: 1; transform: rotate(calc(-1 * var(--turn, 0deg))); position: relative; }
  .fly-windows :global(.fit-ring.retail .fit-socket img.fit-empty-icon), .fly-windows :global(.fit-ring.retail .fit-socket-absent img) {
    width: 109%; max-width: none; height: auto; aspect-ratio: 1; position: relative; }
  /* The fitting window's stats column as the client's (statsPanel, expandablemenu.ExpandableMenu): PANEL_WIDTH_RIGHT
     280 at the right; each menu's header 20 high, a white 0.05 fill, the expander icon 16 at 4 in (ui_38_16_228,
     _229 once expanded), the label (EveLabelMedium 12) 22 in, the header content at the right, 4 between menus. */
  .fly-windows :global(.fit-window .fit-stats) { flex: 0 0 280px; width: 280px; gap: 4px; align-self: stretch; }
  .fly-windows :global(.fit-window .fit-sec) { border: none; background: none; }
  .fly-windows :global(.fit-window .fit-sec-head) { position: relative; min-height: 20px; padding: 0 6px 0 22px; align-items: center;
    background: rgba(255, 255, 255, 0.05); gap: 6px; }
  .fly-windows :global(.fit-window .fit-sec-head::before) { content: ""; position: absolute; left: 4px; top: calc(50% - 7px); width: 16px; height: 16px;
    opacity: 0.8; background: url('/client-res/ui/texture/icons/38_16_228.png') center / 16px 16px no-repeat; }
  .fly-windows :global(.fit-window .fit-sec[open] > .fit-sec-head::before) { content: ""; background-image: url('/client-res/ui/texture/icons/38_16_229.png'); }
  .fly-windows :global(.fit-window .fit-sec-name) { color: rgba(255, 255, 255, 0.75); font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 12px; }
  .fly-windows :global(.fit-window .fit-sec-headline) { font-size: 12px; color: rgba(255, 255, 255, 0.9); }
  .fly-windows :global(.fit-window .fit-sec-body) { padding: 4px 6px 2px; }
  /* defensePanel.py: the top row 28 high (5 above, 3 in) - the best-repair cell 90 wide (a 20 icon, its label) and
     the resist icons (24, in columns of (280 - 90 - 10) / 4 from 90, centred less 6); a row a layer 32 high, 3 in - its
     20 icon, its label 62 wide, the gauges from 90: four, each a quarter less 3 a side (DamageGaugeContainerFitting),
     16 high 8 down, the type's colour over the colour at saturation 0.2 and alpha 0.2 (Gauge), the value centred
     (EveLabelSmall). */
  .fly-windows :global(.fit-window .fit-def) { padding: 0; }
  .fly-windows :global(.fit-def-top) { position: relative; height: 28px; margin-top: 5px; margin-left: 3px; }
  .fly-windows :global(.fit-def-best) { position: absolute; left: 0; top: 0; width: 90px; height: 28px; display: flex; align-items: center; overflow: hidden; }
  .fly-windows :global(.fit-def-best img) { width: 20px; height: 20px; flex: none; }
  .fly-windows :global(.fit-def-best span) { font-size: 10px; line-height: 1.05; color: rgba(255, 255, 255, 0.75);
    -webkit-mask: linear-gradient(90deg, #000 calc(100% - 15px), transparent); mask: linear-gradient(90deg, #000 calc(100% - 15px), transparent); }
  .fly-windows :global(.fit-def-res-icon) { position: absolute; top: 2px; width: 24px; height: 24px; }
  .fly-windows :global(.fit-def-row) { position: relative; height: 32px; margin-left: 3px; display: flex; align-items: center; }
  .fly-windows :global(.fit-def-row > img) { width: 20px; height: 20px; flex: none; }
  .fly-windows :global(.fit-def-hp) { width: 62px; max-height: 34px; overflow: hidden; line-height: 0.95; color: rgba(255, 255, 255, 0.75); }
  .fly-windows :global(.fit-def-gauges) { position: absolute; left: 87px; right: 0; top: 0; bottom: 0; display: flex; }
  .fly-windows :global(.fit-def-gauge) { position: relative; flex: 1 1 0; margin: 8px 3px 0; height: 16px; overflow: hidden; background: var(--gauge-bg); }
  .fly-windows :global(.fit-def-fill) { position: absolute; left: 0; top: 0; bottom: 0; background: var(--gauge); transition: width 0.6s; }
  .fly-windows :global(.fit-def-val) { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #fff; }
  .fly-windows :global(.fit-def-gauge.dmg-em) { --gauge: rgb(26, 94, 140); --gauge-bg: rgba(112, 129, 140, 0.2); }
  .fly-windows :global(.fit-def-gauge.dmg-thermal) { --gauge: rgb(140, 26, 26); --gauge-bg: rgba(140, 112, 112, 0.2); }
  .fly-windows :global(.fit-def-gauge.dmg-kinetic) { --gauge: rgb(115, 115, 115); --gauge-bg: rgba(115, 115, 115, 0.2); }
  .fly-windows :global(.fit-def-gauge.dmg-explosive) { --gauge: rgb(140, 94, 26); --gauge-bg: rgba(140, 129, 112, 0.2); }
  /* capacitorPanel.py: the power core 30 x 30 at 5, 5; the text (EveLabelMedium) 45 in, centred down; maxHeight 64 */
  .fly-windows :global(.fit-window .fit-cap) { position: relative; min-height: 40px; padding: 0; display: flex; align-items: center; }
  .fly-windows :global(.fit-cap-core) { position: absolute; left: 5px; top: 5px; width: 30px; height: 30px; }
  .fly-windows :global(.fit-cap-col) { position: absolute; left: 50%; top: 50%; height: 30px; }
  .fly-windows :global(.fit-cap-cell) { position: absolute; left: 50%; height: 4px; transform: translateX(-50%); background: var(--cell);
    mix-blend-mode: plus-lighter; -webkit-mask: url('/client-res/ui/texture/classes/shipui/capacitorcell.png') center / 100% 100% no-repeat;
    mask: url('/client-res/ui/texture/classes/shipui/capacitorcell.png') center / 100% 100% no-repeat; }
  .fly-windows :global(.fit-cap-text) { margin-left: 45px; font-size: 12px; line-height: 1.25; color: rgba(255, 255, 255, 0.75); padding: 4px 0; }
  /* attributePanel / basePanel.GetValueParentGrid: two columns of the panel's width / 2; GetValueCont - the icon 20 at
     3, the label (EveLabelMedium) after a 7 + 20 spacer, a cell 26 high at least, 1 down */
  .fly-windows :global(.fit-window .fit-attr-grid) { display: grid; grid-template-columns: 140px 140px; padding: 0; }
  .fly-windows :global(.fit-attr) { position: relative; min-height: 26px; margin-top: 1px; display: flex; align-items: center; }
  .fly-windows :global(.fit-attr img) { position: absolute; left: 3px; top: calc(50% - 10px); width: 20px; height: 20px; }
  .fly-windows :global(.fit-attr span) { margin-left: 27px; font-size: 12px; line-height: 1.2; color: rgba(255, 255, 255, 0.75); }
  /* dronePanel: the active count 7 + 20 in, Manage drones a compact ghost button (cell padding 4) */
  .fly-windows :global(.fit-attr-plain span) { margin-left: 27px; }
  .fly-windows :global(.fit-ghost-button) { margin: 4px; padding: 2px 8px; font-size: 12px; background: none; border: 1px solid rgba(255, 255, 255, 0.25);
    color: rgba(255, 255, 255, 0.85); border-radius: 0; cursor: pointer; }
  .fly-windows :global(.fit-ghost-button:hover:not(:disabled)) { background: rgba(255, 255, 255, 0.1); }
  /* the drone menu's own simulated-bay list stays below the client's grid; the rest of its table is the client's now */
  .fly-windows :global(.fit-sec-body.hidden-by-client > table) { display: none; }
  .fly-windows :global(.fit-price) { margin-top: auto; height: 40px; position: relative; flex: none; }
  .fly-windows :global(.fit-price span) { position: absolute; right: 30px; bottom: 1px; font-size: 16px; color: rgba(255, 255, 255, 0.9); }
  .fly-windows :global(.fit-price img) { position: absolute; right: 4px; bottom: 0; width: 24px; height: 24px; opacity: 0.8; }
  /* fittingWnd's middle as the client lays it (LoadWnd): no slot legend, hint line or resource bars - the gauges are on
     the ring, the CPU and power grid left over bottom right (ConstructPowerAndCpuLabels: LayoutGrid BOTTOMRIGHT 4 in,
     bold headers, 10 between); the name row over the ring's top left (nameAndWarningsCont at 8 down, its info icon
     and link-iconed name, no hull icon); the side panel's tab buttons over the left edge, not beside it */
  .fly-windows :global(.fit-window .fit-stage) { gap: 0; position: relative; flex-wrap: nowrap; }
  .fly-windows :global(.fit-window .fit-center) { position: relative; flex: 1 1 auto; min-width: 0; }
  .fly-windows :global(.fit-window .fit-toolbar) { position: absolute; left: 0; top: 40%; z-index: 2; }
  .fly-windows :global(.fit-window .fit-legend), .fly-windows :global(.fit-window .fit-hint), .fly-windows :global(.fit-window .fit-bars) { display: none; }
  .fly-windows :global(.fit-window .fit-topline) { position: absolute; left: 0; top: 8px; z-index: 2; }
  .fly-windows :global(.fit-window .fit-topline > .type-icon), .fly-windows :global(.fit-window .fit-ship-class) { display: none; }
  .fly-windows :global(.fit-window .fit-ring.retail) { margin: 0 auto; }
  .fly-windows :global(.fit-window .fit-ring-wrap) { position: relative; }
  .fly-windows :global(.fit-cpu-power) { position: absolute; right: 4px; bottom: 0; display: grid; justify-items: end; font-size: 12px;
    color: rgba(255, 255, 255, 0.75); z-index: 2; pointer-events: none; }
  .fly-windows :global(.fit-cpu-power b) { font-weight: 700; color: rgba(255, 255, 255, 0.9); }
  .fly-windows :global(.fit-cpu-power b.gap) { margin-top: 10px; }
  .fly-windows :global(.fit-cpu-power .over) { animation: fit-gauge-over 0.5s linear infinite; }
  /* fittingWnd.ConstructInventoryIcons: cargoDroneCont BOTTOMLEFT 4 in over the ring, 110 wide - the cargo hold
     (CargoCargoSlots, invCtrl.ShipCargo's WindowIcons/ships.png) over the drone (or fighter) bay (dronebay.png), each
     32 high: the icon 32 at 0.8 (1 under the mouse), the use and "/ capacity" right-aligned beside it (top 2 and 14),
     the m3 after; no calibration or fit-value read-out (the price label is the fit's value) */
  .fly-windows :global(.fit-window .fit-readouts) { position: relative; z-index: 2; width: 110px; margin: -70px 0 6px 4px; display: block; }
  .fly-windows :global(.fit-window .fit-readouts > .fit-ro-cal), .fly-windows :global(.fit-window .fit-readouts > .fit-readout-value) { display: none; }
  .fly-windows :global(.fit-window .fit-readouts > div) { position: relative; height: 32px; margin: 0; padding: 0 0 0 32px; border: none; background: none; }
  .fly-windows :global(.fit-window .fit-readouts > div::before) { content: ""; position: absolute; left: 0; top: 0; width: 32px; height: 32px; opacity: 0.8;
    background: url('/client-res/ui/texture/windowicons/ships.png') center / 32px 32px no-repeat; pointer-events: none; }
  .fly-windows :global(.fit-window .fit-readouts > div.fit-ro-bay::before) { background-image: url('/client-res/ui/texture/windowicons/dronebay.png'); }
  .fly-windows :global(.fit-window .fit-readouts > div:hover::before) { opacity: 1; }
  .fly-windows :global(.fit-window .fit-readouts dt) { display: none; }
  .fly-windows :global(.fit-window .fit-readouts dd) { margin: 0; }
  .fly-windows :global(.fit-window .fit-readouts dd button) { margin-left: -32px; padding: 2px 0 0 32px; height: 32px; min-width: 32px; border: none; background: none;
    white-space: pre; text-align: right; font-size: 12px; line-height: 12px; color: rgba(255, 255, 255, 0.75); cursor: pointer; }
  /* marketbase.MarketBase: the left side 180 wide (its tabs, the search row 24 high padded 0 8 8 8, the tree on a
     panel underlay), an 8 divider, the right side's sections */
  .fly-windows :global(.market-layout.retail) { display: grid; grid-template-columns: 180px 8px minmax(0, 1fr); align-items: start; }
  .fly-windows :global(.market-layout.retail > section.panel:first-child) { grid-column: 1; grid-row: 1 / span 40; background: rgba(255, 255, 255, 0.03);
    min-width: 0; overflow: hidden; align-self: stretch; }
  .fly-windows :global(.market-layout.retail > :not(:first-child)) { grid-column: 3; min-width: 0; }
  .fly-windows :global(.mkt-tabbar) { display: flex; align-items: stretch; height: 32px; margin: 0; padding: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .fly-windows :global(.mkt-tabs) { display: flex; }
  .fly-windows :global(.mkt-tabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 0 12px; font-size: 12px;
    text-transform: uppercase; letter-spacing: 0.05em; color: rgba(255, 255, 255, 0.6); cursor: pointer; }
  .fly-windows :global(.mkt-tabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.8); }
  .fly-windows :global(.mkt-ghosts) { display: flex; gap: 4px; margin-left: auto; padding-left: 24px; align-items: flex-end; padding-bottom: 4px; }
  .fly-windows :global(.mkt-ghost) { background: none; border: 1px solid rgba(255, 255, 255, 0.2); padding: 1px 8px; font-size: 12px; color: rgba(255, 255, 255, 0.8); cursor: pointer; }
  .fly-windows :global(.mkt-ghost:hover), .fly-windows :global(.mkt-ghost.active) { background: rgba(255, 255, 255, 0.1); }
  .fly-windows :global(.mkt-wallet) { display: flex; align-items: center; gap: 4px; padding: 0 8px; font-size: 12px; color: rgba(255, 255, 255, 0.6); }
  .fly-windows :global(.mkt-wallet img) { width: 16px; height: 16px; padding: 4px; }
  /* MarketBase.LoadDetails on the play page: the head (the 64 icon, 8 to the text, the name as EveCaptionMedium and
     its info icon), the Market Data / Price History tabs; our own heading and "pick an item" line give way to it */
  .fly-windows :global(.mkt-details > h2), .fly-windows :global(.mkt-details > p.note:first-of-type) { display: none; }
  .fly-windows :global(.mkt-head) { display: flex; align-items: center; min-height: 64px; gap: 8px; margin: 8px 0; }
  .fly-windows :global(.mkt-head-icon .type-icon), .fly-windows :global(.mkt-head-icon .type-icon img) { width: 64px; height: 64px; }
  .fly-windows :global(.mkt-head-text) { display: flex; align-items: center; gap: 8px; }
  .fly-windows :global(.mkt-head-name) { font-size: 20px; color: #fff; }
  .fly-windows :global(.mkt-info) { width: 16px; height: 16px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.6); background: none; color: #fff;
    font: italic 700 10px/14px serif; padding: 0; cursor: pointer; }
  .fly-windows :global(.mkt-dtabs) { display: flex; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 6px; }
  .fly-windows :global(.mkt-dtabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 12px; font-size: 12px;
    text-transform: uppercase; letter-spacing: 0.05em; color: rgba(255, 255, 255, 0.6); cursor: pointer; }
  .fly-windows :global(.mkt-dtabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.8); }
  .fly-windows :global(.mkt-details.detail-marketdata .mkt-history) { display: none; }
  .fly-windows :global(.mkt-details.detail-pricehistory > :not(.mkt-head):not(.mkt-dtabs):not(.mkt-history)) { display: none; }
  /* MarketData's two scrolls: a caption each, the columns' header row, rows 1 apart, numbers to the right, the price
     white (quote.py GetPrice's 0xFFFFFFFF) */
  .fly-windows :global(.mkt-quote-cap) { font-size: 16px; text-transform: none; letter-spacing: 0; color: #fff; margin: 6px 0 4px; }
  .fly-windows :global(.mkt-quote-scroll) { max-height: 220px; overflow: auto; border: 1px solid rgba(255, 255, 255, 0.08); }
  .fly-windows :global(.mkt-quote-scroll table) { width: 100%; border-collapse: collapse; font-size: 12px; }
  .fly-windows :global(.mkt-quote-scroll th) { position: sticky; top: 0; background: #1b1d20; text-align: left; font-weight: 400; color: rgba(255, 255, 255, 0.6);
    padding: 3px 6px; white-space: nowrap; border-bottom: 1px solid rgba(255, 255, 255, 0.12); }
  .fly-windows :global(.mkt-quote-scroll td) { padding: 2px 6px; white-space: nowrap; color: rgba(255, 255, 255, 0.75); border-bottom: 1px solid rgba(255, 255, 255, 0.03); }
  .fly-windows :global(.mkt-quote-scroll .r) { text-align: right; }
  .fly-windows :global(.mkt-quote-scroll td.price) { color: #fff; }
  .fly-windows :global(.mkt-quote-scroll tbody tr) { cursor: pointer; }
  .fly-windows :global(.mkt-quote-scroll tbody tr:hover) { background: rgba(255, 255, 255, 0.06); }
  .fly-windows :global(.mkt-quote-scroll th button) { background: none; border: none; padding: 0; color: inherit; font: inherit; cursor: pointer; }
  .fly-windows :global(.mkt-quote-buttons) { display: flex; justify-content: flex-end; gap: 6px; padding-top: 16px; }
  .fly-windows :global(.mkt-primary) { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; font-size: 12px; color: #fff; cursor: pointer;
    background: rgba(88, 168, 196, 0.35); border: 1px solid rgba(88, 168, 196, 0.8); }
  .fly-windows :global(.mkt-primary img) { width: 16px; height: 16px; }
  /* the page's own Offer to buy / to sell row stays (the client's sell goes from the inventory); the Place Buy Order
     button below the lists is the client's way to the buy draft */
  /* the browse tree's group rows as listgroup.ListGroup's: 20 high, the expander 16 at 4, the icon 16 at 22, the
     label after it; no chevron of our own */
  .fly-windows :global(.market-layout.retail .pick-group) { position: relative; min-height: 20px; padding: 2px 4px 2px 42px; }
  .fly-windows :global(.market-layout.retail .pick-group .pick-chevron) { display: none; }
  .fly-windows :global(.market-layout.retail .mkt-expander) { position: absolute; left: 4px; top: calc(50% - 8px); width: 16px; height: 16px;
    transform: rotate(-90deg); opacity: 0.8; }
  .fly-windows :global(.market-layout.retail .mkt-group-icon) { position: absolute; left: 22px; top: calc(50% - 8px); width: 16px; height: 16px; }
  /* ContractsWindow's header tabs (TabNavigationWindowHeader): the start page, My Contracts, Contract Search */
  .fly-windows :global(.con-tabs) { display: flex; gap: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .fly-windows :global(.con-tabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 14px; font-size: 13px;
    color: rgba(255, 255, 255, 0.6); cursor: pointer; border-radius: 0; }
  .fly-windows :global(.con-tabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.85); background: none; }
  /* StartPagePanel: the caption, then ContractStartPageEntry rows (the 32 icon at 4, header and text 50 in, 8 apart) */
  .fly-windows :global(.con-start-cap) { margin: 8px 0 4px 14px; font-size: 20px; text-transform: none; letter-spacing: 0; color: #fff; }
  .fly-windows :global(.con-start-entry) { position: relative; padding: 8px 0 8px 50px; min-height: 32px; }
  .fly-windows :global(.con-start-entry img) { position: absolute; left: 4px; top: 8px; width: 32px; height: 32px; }
  .fly-windows :global(.con-start-head) { background: none; border: none; padding: 0; font-size: 15px; color: #8fd4ff; cursor: pointer; text-align: left; }
  .fly-windows :global(.con-start-text) { margin: 2px 0 0; font-size: 12px; color: rgba(255, 255, 255, 0.7); }
  /* ContractSearchPanel: the 200 filter column (the toggle, the type field, Search at its foot) and the result scroll */
  .fly-windows :global(.con-search) { display: flex; gap: 8px; min-height: 380px; margin-top: 8px; }
  .fly-windows :global(.con-search-left) { flex: 0 0 200px; display: flex; flex-direction: column; gap: 8px; padding-right: 8px; background: rgba(255, 255, 255, 0.03); }
  .fly-windows :global(.con-toggle) { display: flex; margin: 8px 2px 0; }
  .fly-windows :global(.con-toggle button) { flex: 1; background: none; border: 1px solid rgba(255, 255, 255, 0.2); padding: 3px 0; font-size: 12px; color: rgba(255, 255, 255, 0.7); cursor: pointer; }
  .fly-windows :global(.con-toggle button.active) { background: rgba(255, 255, 255, 0.15); color: #fff; }
  .fly-windows :global(.con-search-left input) { margin: 0 2px; padding: 3px 6px; font-size: 12px; }
  .fly-windows :global(.con-search-fill) { flex: 1; }
  .fly-windows :global(.con-search-btn) { margin: 0 2px 2px; padding: 5px; font-size: 12px; }
  .fly-windows :global(.con-search-right) { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .fly-windows :global(.con-found) { margin: 0 0 4px 4px; font-size: 11px; color: rgba(255, 255, 255, 0.6); }
  .fly-windows :global(.con-scroll) { flex: 1; overflow: auto; border: 1px solid rgba(255, 255, 255, 0.08); }
  .fly-windows :global(.con-scroll table) { width: 100%; border-collapse: collapse; font-size: 12px; }
  .fly-windows :global(.con-scroll th) { position: sticky; top: 0; background: #1b1d20; text-align: left; font-weight: 400; color: rgba(255, 255, 255, 0.6); padding: 3px 6px; white-space: nowrap; }
  .fly-windows :global(.con-scroll td) { padding: 2px 6px; color: rgba(255, 255, 255, 0.8); white-space: nowrap; }
  .fly-windows :global(.con-scroll .r) { text-align: right; }
  .fly-windows :global(.con-scroll .con-none) { text-align: center; color: rgba(255, 255, 255, 0.5); padding: 12px; }
  /* MyContractsPanel: the filter row (a grid of combos, Get Contracts at the right) over the list */
  .fly-windows :global(.con-my-filters) { display: flex; align-items: flex-end; gap: 8px; margin: 8px 0; }
  .fly-windows :global(.con-my-filters label) { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: rgba(255, 255, 255, 0.6); }
  .fly-windows :global(.con-my-filters select) { font-size: 12px; padding: 2px 4px; min-width: 120px; }
  .fly-windows :global(.con-my-filters button) { margin-left: auto; font-size: 12px; padding: 4px 10px; }
  .fly-windows :global(.con-my-list) { min-height: 300px; }
  /* industryWnd's browser tabs: one browser at a time under them; the job's view stays */
  .fly-windows :global(.ind-tabs) { display: flex; height: 26px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin: 6px 0; }
  .fly-windows :global(.ind-tabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 0 12px; font-size: 12px;
    text-transform: uppercase; letter-spacing: 0.04em; color: rgba(255, 255, 255, 0.6); cursor: pointer; }
  .fly-windows :global(.ind-tabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.ind-layout.retail[data-tab="blueprints"] > section:is(.ind-jobs, .ind-facilities)),
  .fly-windows :global(.ind-layout.retail[data-tab="facilities"] > section:is(.ind-jobs, .ind-blueprints)),
  .fly-windows :global(.ind-layout.retail[data-tab="jobs"] > section:is(.ind-blueprints, .ind-facilities)),
  .fly-windows :global(.ind-layout.retail[data-tab="research"] > section:is(.ind-jobs, .ind-blueprints, .ind-facilities)) { display: none; }
  /* BrowserFacilities: the top row (Owner, Activity, a filter) over the scroll; the activities' columns headed by their
     small icons (industryUIConst.ACTIVITY_ICONS_SMALL) */
  .fly-windows :global(.ind-fac-top) { display: flex; gap: 4px; margin-bottom: 4px; }
  .fly-windows :global(.ind-fac-top select) { width: 140px; font-size: 12px; padding: 2px 4px; }
  .fly-windows :global(.ind-fac-top input) { margin-left: auto; width: 160px; font-size: 12px; padding: 2px 6px; }
  .fly-windows :global(.ind-scroll) { max-height: 420px; overflow: auto; border: 1px solid rgba(255, 255, 255, 0.08); }
  .fly-windows :global(.ind-scroll table) { width: 100%; border-collapse: collapse; font-size: 12px; }
  .fly-windows :global(.ind-scroll th) { position: sticky; top: 0; background: #1b1d20; text-align: left; font-weight: 400; color: rgba(255, 255, 255, 0.6);
    padding: 3px 6px; white-space: nowrap; }
  .fly-windows :global(.ind-scroll td) { padding: 2px 6px; color: rgba(255, 255, 255, 0.8); white-space: nowrap; }
  .fly-windows :global(.ind-scroll .r) { text-align: right; }
  .fly-windows :global(.ind-scroll .ic) { text-align: center; width: 24px; }
  .fly-windows :global(.ind-scroll th.ic img) { width: 16px; height: 16px; vertical-align: middle; }
  /* BrowserBlueprints: the facility combo wider (200), the name with its icon, the ME / TE gauges, the activities'
     icon buttons (the blueprint's own lit, the rest at 0.05), a blueprint in a job at 0.15 */
  .fly-windows :global(.ind-fac-top select.wide) { width: 200px; }
  .fly-windows :global(.ind-bp-name) { display: inline-flex; align-items: center; gap: 4px; }
  .fly-windows :global(.ind-bp-name img) { width: 20px; height: 20px; }
  .fly-windows :global(.ind-gauge) { display: inline-block; width: 40px; height: 4px; background: rgba(255, 255, 255, 0.12); vertical-align: middle; }
  .fly-windows :global(.ind-gauge span) { display: block; height: 100%; background: rgba(255, 255, 255, 0.7); }
  .fly-windows :global(.ind-inf) { width: 11px; height: 6px; opacity: 0.8; margin-left: 6px; }
  .fly-windows :global(.ind-acts) { white-space: nowrap; }
  .fly-windows :global(.ind-acts button) { background: none; border: 0; padding: 2px; opacity: 0.05; cursor: default; }
  .fly-windows :global(.ind-acts button.on) { opacity: 1; cursor: pointer; }
  .fly-windows :global(.ind-acts button.on:disabled) { opacity: 0.4; }
  .fly-windows :global(.ind-acts img) { width: 14px; height: 14px; display: block; }
  .fly-windows :global(.ind-scroll tr.ind-busy td) { opacity: 0.15; }
  /* BrowserJobs: the status icon (16), the job's state over a 6-high gauge in the activity's colour
     (COLOR_MANUFACTURING, COLOR_REACTION, COLOR_SCIENCE), the Deliver button filling a ready job's cell, the bottom row */
  .fly-windows :global(.ind-status), .fly-windows :global(.ind-act) { width: 16px; height: 16px; vertical-align: middle; }
  .fly-windows :global(.ind-job-state) { min-width: 90px; }
  .fly-windows :global(.ind-job-gauge) { display: block; height: 6px; margin-top: 1px; background: rgba(255, 255, 255, 0.05); }
  .fly-windows :global(.ind-job-gauge span) { display: block; height: 100%; }
  .fly-windows :global(.ind-job-gauge.mfg span) { background: #ff9900; }
  .fly-windows :global(.ind-job-gauge.rx span) { background: #12e6c9; }
  .fly-windows :global(.ind-job-gauge.sci span) { background: #3372b6; }
  .fly-windows :global(.ind-deliver) { width: 100%; font-size: 12px; padding: 2px 6px; }
  .fly-windows :global(.ind-not-ready) { color: #ff4600; }
  .fly-windows :global(.ind-jobs-bottom) { display: flex; justify-content: flex-end; gap: 4px; margin-top: 4px; }
  .fly-windows :global(.ind-jobs-bottom button) { font-size: 12px; padding: 4px 10px; }
  /* BaseView / BlueprintCenter: the job's view, 418 high, over the browsers */
  .fly-windows :global(.ind-cv) { position: relative; height: 418px; overflow: hidden; }
  .fly-windows :global(.ind-cv-top) { position: absolute; left: 24px; top: 2px; font-size: 13px; color: rgba(255, 255, 255, 0.9); }
  .fly-windows :global(.ind-cv-main) { position: absolute; left: 0; right: 0; top: 18px; height: 400px; }
  .fly-windows :global(.ind-cv-circle) { position: absolute; left: 50%; bottom: 0; width: 400px; height: 400px; margin-left: -200px;
    background: url(/client-res/ui/texture/classes/industry/center/bgcircle.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv-circle .border) { position: absolute; inset: 0; background: var(--job); opacity: 0.3;
    -webkit-mask: url(/client-res/ui/texture/classes/industry/center/bgcircleborder.png) center / 100% 100%;
    mask: url(/client-res/ui/texture/classes/industry/center/bgcircleborder.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv:not(.job) .ind-cv-circle) { opacity: 0.55; }
  /* MaterialGroups: the left half's background stretched between a 10 left edge and its 400 right part, 402 high;
     the groups 400 wide at the left; a Material 45 x 60 */
  .fly-windows :global(.ind-cv-inputs) { position: absolute; left: 4px; top: 0; width: calc(50% - 4px); height: 402px;
    border-style: solid; border-width: 0 400px 0 10px; border-image: var(--bg) 0 400 0 10 fill stretch; box-sizing: border-box; }
  .fly-windows :global(.ind-cv-noitems) { position: absolute; left: -10px; right: -200px; top: 50%; transform: translateY(-50%); text-align: center;
    font-size: 16px; color: rgba(255, 255, 255, 0.9); opacity: 0.9; padding: 0 20px; }
  .fly-windows :global(.ind-cv-group) { position: absolute; left: -10px; width: 400px; }
  .fly-windows :global(.ind-cv-group-icon) { position: absolute; left: 7px; top: 50%; width: 22px; height: 22px; margin-top: -11px; }
  .fly-windows :global(.ind-cv-mat) { position: absolute; width: 45px; height: 60px; box-sizing: border-box;
    background: rgba(20, 22, 25, 0.5); }
  .fly-windows :global(.ind-cv-mat .glow) { position: absolute; inset: 0; background: #3372b6; opacity: 0.5;
    -webkit-mask: url(/client-res/ui/texture/classes/industry/input/bgglow.png) center / 100% 100%; mask: url(/client-res/ui/texture/classes/industry/input/bgglow.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv-mat.short .glow) { background: #ff4600; }
  .fly-windows :global(.ind-cv-mat::before) { content: ""; position: absolute; inset: 0; background: #666666;
    -webkit-mask: url(/client-res/ui/texture/classes/industry/input/bgframe.png) center / 100% 100%; mask: url(/client-res/ui/texture/classes/industry/input/bgframe.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv-mat.short::before) { background: #ff4600; }
  .fly-windows :global(.ind-cv-mat.short::after) { content: ""; position: absolute; inset: 0; background: #ff4600;
    -webkit-mask: url(/client-res/ui/texture/classes/industry/input/bgnotready.png) center / 100% 100%; mask: url(/client-res/ui/texture/classes/industry/input/bgnotready.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv-mat .pic) { position: absolute; left: 6.5px; top: 6px; width: 32px; height: 32px; }
  .fly-windows :global(.ind-cv-mat .pic .type-icon), .fly-windows :global(.ind-cv-mat .pic img) { width: 32px; height: 32px; display: block; }
  .fly-windows :global(.ind-cv-mat .gauge) { position: absolute; left: 0; width: 46px; bottom: 13px; height: 3px; }
  .fly-windows :global(.ind-cv-mat .gauge span) { display: block; height: 100%; background: #3372b6; }
  .fly-windows :global(.ind-cv-mat.short .gauge span) { background: #ff4600; }
  .fly-windows :global(.ind-cv-mat small) { position: absolute; left: 0; right: 0; bottom: 1px; text-align: center; font-size: 10px; color: rgba(255, 255, 255, 0.85); }
  /* OutputCont: the right half's background (bg1Groups turned), the framed boxes 304 x 44, the outcome 327 x 202, the
     duration and cost labels; all faded in with a job */
  .fly-windows :global(.ind-cv-outputs) { position: absolute; left: 50%; right: 6px; top: 0; height: 400px; opacity: 0; transition: opacity 0.6s; }
  .fly-windows :global(.ind-cv-outputs.on) { opacity: 1; }
  .fly-windows :global(.ind-cv-outputs .bgflip) { position: absolute; inset: 0 0 auto 0; height: 402px; transform: rotate(180deg);
    border-style: solid; border-width: 0 400px 0 10px; border-image: url(/client-res/ui/texture/classes/industry/input/bg1groups.png) 0 400 0 10 fill stretch; box-sizing: border-box; }
  .fly-windows :global(.ind-cv-box) { position: absolute; right: 13px; width: 304px; height: 44px; box-sizing: border-box; background: rgba(20, 22, 25, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.12); padding: 3px 8px; }
  .fly-windows :global(.ind-cv-box small) { display: block; font-size: 10px; text-transform: uppercase; opacity: 0.5; }
  .fly-windows :global(.ind-cv-box .name) { display: block; margin-top: 3px; font-size: 11px; max-width: 237px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .fly-windows :global(.ind-cv-box .combo) { display: block; margin-top: 3px; height: 20px; line-height: 20px; font-size: 11px; padding: 0 6px;
    background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .fly-windows :global(.ind-cv-box.fac) { top: 7px; }
  .fly-windows :global(.ind-cv-box.inloc) { top: 50px; }
  .fly-windows :global(.ind-cv-box.outloc) { bottom: 47px; }
  .fly-windows :global(.ind-cv-box .facpic) { position: absolute; right: 1px; top: 0; width: 43px; height: 42px; }
  .fly-windows :global(.ind-cv-box .facpic .type-icon), .fly-windows :global(.ind-cv-box .facpic img) { width: 43px; height: 42px; display: block; }
  .fly-windows :global(.ind-cv-outcome) { position: absolute; right: 0; top: 99px; width: 327px; height: 202px; background: rgba(20, 22, 25, 0.5); overflow: hidden; }
  .fly-windows :global(.ind-cv-outcome > span) { position: absolute; }
  .fly-windows :global(.ind-cv-outcome .pattern) { inset: 0; background: url(/client-res/ui/texture/classes/industry/output/outputcontbg.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv-outcome .pattern::after) { content: ""; position: absolute; inset: 0; background: var(--job);
    -webkit-mask-box-image: url(/client-res/ui/texture/classes/industry/output/bgpattern.png) 12 fill / 12px; mask-border: url(/client-res/ui/texture/classes/industry/output/bgpattern.png) 12 fill / 12px; opacity: 0.6; }
  .fly-windows :global(.ind-cv-outcome .vignette) { inset: 0; background: #141619;
    -webkit-mask: url(/client-res/ui/texture/classes/industry/output/bgvignette.png) center / 100% 100%; mask: url(/client-res/ui/texture/classes/industry/output/bgvignette.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv-outcome .itembg) { left: 63px; top: 5px; width: 201px; height: 192px; background: url(/client-res/ui/texture/classes/industry/output/itembg.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv-outcome .itemcolor) { left: 63px; top: 5px; width: 201px; height: 192px; background: var(--job); opacity: 0.6;
    -webkit-mask: url(/client-res/ui/texture/classes/industry/output/itembgcolor.png) center / 100% 100%; mask: url(/client-res/ui/texture/classes/industry/output/itembgcolor.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv-outcome .cap) { position: absolute; left: 14px; top: 10px; width: 300px; z-index: 1; }
  .fly-windows :global(.ind-cv-outcome .cap b) { display: block; font-size: 13px; font-weight: 400; color: var(--job); text-transform: uppercase; }
  .fly-windows :global(.ind-cv-outcome .cap span) { display: block; font-size: 14px; color: rgba(255, 255, 255, 0.9); }
  .fly-windows :global(.ind-cv-outcome .pic) { left: 131.5px; top: 69px; width: 64px; height: 64px; }
  .fly-windows :global(.ind-cv-outcome .pic .type-icon), .fly-windows :global(.ind-cv-outcome .pic img) { width: 64px; height: 64px; display: block; }
  .fly-windows :global(.ind-cv-outcome .qty) { position: absolute; left: 0; right: 0; top: calc(50% + 42px - 9px); text-align: center; font-size: 15px; }
  .fly-windows :global(.ind-cv-outcome .copyinfo) { position: absolute; left: 13.5px; bottom: 8px; width: 300px; height: 32px; display: flex; justify-content: space-between;
    align-items: center; font-size: 12px; }
  .fly-windows :global(.ind-cv-outcome .copyinfo small) { display: block; font-size: 10px; opacity: 0.5; text-transform: uppercase; text-align: center; }
  .fly-windows :global(.ind-cv-labels) { position: absolute; right: 13px; bottom: 7px; width: 304px; height: 32px; display: flex; gap: 2px; }
  .fly-windows :global(.ind-cv-labels div:first-child) { flex: 0 0 45%; }
  .fly-windows :global(.ind-cv-labels div:last-child) { flex: 1; padding-left: 4px; }
  .fly-windows :global(.ind-cv-labels small) { display: block; font-size: 10px; text-transform: uppercase; opacity: 0.5; }
  .fly-windows :global(.ind-cv-labels span) { display: block; font-size: 15px; }
  /* JobsStrip: 50 high under the view - the summary at the left, the activity toggles in the middle, Start at the right */
  .fly-windows :global(.ind-js) { position: relative; height: 50px; margin: -1px 7px 2px 5px; border: 1px solid rgba(255, 255, 255, 0.12);
    background: linear-gradient(to top, rgba(77, 77, 77, 0.3), rgba(77, 77, 77, 0.05)); }
  .fly-windows :global(.ind-js-summary) { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); display: grid; grid-template-columns: auto auto;
    column-gap: 10px; align-items: baseline; }
  .fly-windows :global(.ind-js-summary small) { font-size: 10px; color: rgba(255, 255, 255, 0.45); }
  .fly-windows :global(.ind-js-summary span) { font-size: 12px; }
  .fly-windows :global(.ind-js-acts) { position: absolute; left: 50%; top: 50%; width: 248px; height: 38px; margin: -19px 0 0 -124px; display: flex; }
  .fly-windows :global(.ind-js-acts button) { flex: 1; display: flex; align-items: center; justify-content: center; background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1); margin-left: -1px; padding: 0; cursor: pointer; }
  .fly-windows :global(.ind-js-acts button:disabled) { cursor: default; }
  .fly-windows :global(.ind-js-acts button:disabled img) { opacity: 0.2; }
  .fly-windows :global(.ind-js-acts button.sel) { background: var(--sel); }
  .fly-windows :global(.ind-js-acts img) { width: 26px; height: 26px; }
  .fly-windows :global(.ind-js-submit) { position: absolute; right: 7px; top: 50%; width: 120px; height: 30px; margin-top: -15px; font-size: 13px;
    color: #fff; background: color-mix(in srgb, var(--job) 50%, transparent); border: 1px solid var(--job); cursor: pointer; }
  .fly-windows :global(.ind-js-submit:disabled) { opacity: 0.45; cursor: default; }
  /* The job's choices: the optional material's place, the panels (OptionalItemTooltipPanel, OutcomeTooltipPanel), the
     Runs per Copy edit, the Facility box in preview mode, the chosen facility's row */
  .fly-windows :global(.ind-cv-mat.optional) { border: 0; padding: 0; cursor: pointer; }
  .fly-windows :global(.ind-cv-mat.optional .glow) { background: #3372b6; opacity: 0.4; }
  .fly-windows :global(.ind-cv-mat.optional.empty .glow) { background: #333333; }
  .fly-windows :global(.ind-cv-mat.optional.empty::after) { content: "+"; position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 20px; color: rgba(255, 255, 255, 0.5); }
  .fly-windows :global(.ind-cv-panel) { position: absolute; top: 40px; z-index: 5; width: 250px; max-height: 240px; overflow: auto; padding: 8px;
    background: rgba(18, 20, 23, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5); }
  .fly-windows :global(.ind-cv-panel.opt) { left: 60px; }
  .fly-windows :global(.ind-cv-panel.out) { right: 40px; }
  .fly-windows :global(.ind-cv-panel p) { margin: 0 0 4px; font-size: 12px; }
  .fly-windows :global(.ind-cv-panel button) { display: flex; align-items: center; gap: 6px; width: 100%; height: 29px; padding: 0 4px; font-size: 12px;
    text-align: left; background: none; border: 0; color: rgba(255, 255, 255, 0.85); cursor: pointer; }
  .fly-windows :global(.ind-cv-panel button:hover) { background: rgba(255, 255, 255, 0.06); }
  .fly-windows :global(.ind-cv-panel button.sel) { background: rgba(51, 114, 182, 0.35); }
  .fly-windows :global(.ind-cv-panel button img) { width: 24px; height: 24px; }
  .fly-windows :global(.ind-cv-outcome .pick) { position: absolute; left: 131.5px; top: 69px; width: 64px; height: 64px; background: none; border: 0; cursor: pointer; z-index: 2; }
  .fly-windows :global(.ind-cv-runs.percopy) { top: 134px; }
  .fly-windows :global(.ind-cv-box.preview) { border-color: #ff4600; cursor: pointer; }
  .fly-windows :global(.ind-cv-box .x) { position: absolute; right: 46px; top: 2px; font-size: 11px; color: #ff3030; }
  .fly-windows :global(.ind-scroll tr.ind-sel td) { background: rgba(51, 114, 182, 0.3); }
  .fly-windows :global(.ind-fac-client .ind-scroll tbody tr) { cursor: pointer; }
  /* FleetWindow: the header's tabs; one panel at a time; PanelFormFleet - its caption and text, Form Fleet and the
     setup combo at the bottom */
  .fly-windows :global(.fl-tabs) { display: flex; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 8px; }
  .fly-windows :global(.fl-tabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 12px; font-size: 13px;
    color: rgba(255, 255, 255, 0.6); cursor: pointer; }
  .fly-windows :global(.fl-tabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.fl-retail .panel-head .panel-title) { display: none; }
  .fly-windows :global(.fl-retail[data-fleet-tab="broadcasts"] > section:not(.fl-keep)),
  .fly-windows :global(.fl-retail[data-fleet-tab="fleet"] > .fl-broadcasts),
  .fly-windows :global(.fl-retail:is([data-fleet-tab="respawn"], [data-fleet-tab="formations"], [data-fleet-tab="advert"], [data-fleet-tab="find"]) > :is(section, .fl-broadcasts)) { display: none; }
  /* PanelFleetFinder: the filter row (three combos, Find Fleets at the right), the check, the scroll, the info under it */
  .fly-windows :global(.fl-finder) { display: flex; flex-direction: column; gap: 4px; }
  .fly-windows :global(.fl-finder-filters) { display: flex; gap: 2px; height: 22px; margin-top: 4px; }
  .fly-windows :global(.fl-finder-filters select) { flex: 0 1 33%; min-width: 0; max-width: 160px; font-size: 12px; padding: 1px 4px; }
  .fly-windows :global(.fl-finder-filters button) { margin-left: auto; flex: none; white-space: nowrap; font-size: 12px; padding: 2px 10px; }
  .fly-windows :global(.fl-finder-check) { font-size: 12px; color: rgba(255, 255, 255, 0.75); padding: 4px 2px; }
  .fly-windows :global(.fl-finder-scroll) { min-height: 160px; max-height: 220px; overflow: auto; border: 1px solid rgba(255, 255, 255, 0.08); }
  .fly-windows :global(.fl-finder-scroll table) { width: 100%; border-collapse: collapse; font-size: 12px; }
  .fly-windows :global(.fl-finder-scroll th) { position: sticky; top: 0; background: #1b1d20; text-align: left; font-weight: 400; color: rgba(255, 255, 255, 0.6); padding: 3px 6px; white-space: nowrap; }
  .fly-windows :global(.fl-finder-scroll td) { padding: 2px 6px; color: rgba(255, 255, 255, 0.85); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
  .fly-windows :global(.fl-finder-scroll tbody tr) { cursor: pointer; }
  .fly-windows :global(.fl-finder-scroll tr.sel td) { background: rgba(255, 255, 255, 0.1); }
  .fly-windows :global(.fl-finder-scroll .priv) { color: rgba(136, 136, 136, 0.5); }
  .fly-windows :global(.fl-finder-scroll .full) { color: #dd0000; }
  .fly-windows :global(.fl-finder-scroll .fl-none) { text-align: center; color: rgba(255, 255, 255, 0.5); padding: 16px; white-space: normal; }
  .fly-windows :global(.fl-finder-info) { padding-top: 4px; }
  .fly-windows :global(.fl-finder-info .top) { display: flex; align-items: center; justify-content: space-between; height: 20px; }
  .fly-windows :global(.fl-finder-info p) { margin: 4px 0 0; font-size: 12px; border: 1px solid rgba(255, 255, 255, 0.1); padding: 4px; }
  /* CorporationWindow: the header's tabs, the SideNavigation 240 wide (its headers and entries) beside the panel */
  .fly-windows :global(.corp-tabs) { display: flex; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 8px; }
  .fly-windows :global(.corp-tabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 12px; font-size: 13px;
    color: rgba(255, 255, 255, 0.6); cursor: pointer; }
  .fly-windows :global(.corp-tabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.corp-retail .corp-window) { grid-template-columns: 240px minmax(0, 1fr); }
  .fly-windows :global(.corp-side) { display: flex; flex-direction: column; border-right: 1px solid rgba(255, 255, 255, 0.08); padding-right: 4px; }
  .fly-windows :global(.corp-side-header) { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(255, 255, 255, 0.45); padding: 10px 8px 4px; }
  .fly-windows :global(.corp-side-entry) { text-align: left; background: none; border: 0; border-left: 2px solid transparent; padding: 6px 10px; font-size: 13px;
    color: rgba(255, 255, 255, 0.75); cursor: pointer; }
  .fly-windows :global(.corp-side-entry:hover) { background: rgba(255, 255, 255, 0.05); }
  .fly-windows :global(.corp-side-entry.active) { background: rgba(255, 255, 255, 0.08); border-left-color: rgba(255, 255, 255, 0.85); color: #fff; }
  /* CorpUIHome: the banner 136 high (the logo 72, the name; a player corporation's CEO at the right), the Details group's
     rows, the button group at the bottom */
  .fly-windows :global(.corp-home) { display: flex; flex-direction: column; min-height: 560px; }
  .fly-windows :global(.corp-home-banner) { position: relative; height: 136px; display: flex; align-items: center; gap: 0; padding-left: 32px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02)); border-radius: 6px; }
  .fly-windows :global(.corp-home-banner.npc) { padding-left: 0; background: none; }
  .fly-windows :global(.corp-home-banner .player-logo) { width: 72px; height: 72px; flex: none; }
  .fly-windows :global(.corp-home-banner .name) { margin-left: 48px; font-size: 20px; color: #fff; }
  .fly-windows :global(.corp-home-banner .ceo) { position: absolute; right: 37px; top: 0; bottom: 0; display: flex; align-items: center; gap: 16px; }
  .fly-windows :global(.corp-home-banner .ceo-text) { display: flex; flex-direction: column; text-align: right; }
  .fly-windows :global(.corp-home-banner .ceo-text small) { font-size: 12px; color: rgba(255, 255, 255, 0.5); }
  .fly-windows :global(.corp-home-banner .ceo-text b) { font-size: 16px; font-weight: 400; color: #fff; }
  .fly-windows :global(.corp-home-banner .ceo-pic img) { border-radius: 50%; }
  .fly-windows :global(.corp-home-details) { flex: 1; margin-top: 16px; }
  .fly-windows :global(.corp-home-details .group) { font-size: 12px; padding: 4px 6px; background: rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.corp-home-details .row) { display: flex; justify-content: space-between; padding: 5px 6px 5px 16px; font-size: 13px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
  .fly-windows :global(.corp-home-details .row span:first-child) { color: rgba(255, 255, 255, 0.55); }
  .fly-windows :global(.corp-home-buttons) { display: flex; justify-content: center; gap: 6px; padding: 8px 0; }
  /* ProbeScannerPalette: the results over the 64-high bottom container - the probe state row (icon 28, count, recover /
     reconnect at the right), the formation buttons 32, the size slider, Analyze 100 wide */
  .fly-windows :global(.ps-window) { display: flex; flex-direction: column; height: 100%; min-height: 300px; }
  .fly-windows :global(.ps-results) { flex: 1; min-height: 0; overflow: auto; }
  .fly-windows :global(.ps-filter) { height: 22px; line-height: 22px; padding-left: 2px; font-size: 13px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
  .fly-windows :global(.ps-none) { text-align: center; color: rgba(255, 255, 255, 0.5); font-size: 12px; margin-top: 24px; }
  /* ScanResultNew: 24 high; the icon 16 in the certainty's colour (GetResultColor); the status bar 2 high at the bottom
     - the base and the change; the warp button 22 in the signal column; the filter row: Scan Results at the left */
  /* The columns as GetColumnsDefaultSize has them (Distance 70, ID 60, Name 100), Group stretched, the signal column 50
     at the right; long text cut; the row's menu on a right-click, its button not drawn, the menu under the row */
  .fly-windows :global(.ps-retail table) { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
  .fly-windows :global(.ps-retail :is(th, td):nth-child(2)) { width: 70px; }
  .fly-windows :global(.ps-retail :is(th, td):nth-child(3)) { width: 60px; }
  .fly-windows :global(.ps-retail :is(th, td):nth-child(4)) { width: 100px; }
  .fly-windows :global(.ps-retail :is(th, td):nth-child(6)) { width: 50px; text-align: right; }
  .fly-windows :global(.ps-retail :is(th, td):nth-child(7)) { width: 0; padding: 0; position: relative; }
  .fly-windows :global(.ps-retail td:nth-child(7) > button) { display: none; }
  .fly-windows :global(.ps-retail td:nth-child(7) > .result-menu) { position: absolute; right: 0; top: 22px; z-index: 3; flex-direction: column;
    background: rgba(18, 20, 23, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); padding: 4px; white-space: nowrap; }
  .fly-windows :global(.ps-retail td) { overflow: hidden; text-overflow: ellipsis; }
  .fly-windows :global(.ps-retail th) { text-align: left; font-weight: 400; color: rgba(255, 255, 255, 0.6); padding: 2px 4px; }
  .fly-windows :global(.ps-row) { height: 24px; background-image: linear-gradient(90deg, color-mix(in srgb, var(--cert) 35%, black) var(--base),
    color-mix(in srgb, var(--cert) 50%, black) var(--base) calc(var(--base) + var(--change)), transparent 0);
    background-size: 100% 2px; background-repeat: no-repeat; background-position: bottom; }
  .fly-windows :global(.ps-row td) { padding: 0 4px; white-space: nowrap; }
  .fly-windows :global(.ps-row) { cursor: default; }
  .fly-windows :global(.ps-row.ps-selected) { background-color: rgba(255, 255, 255, 0.14); }
  .fly-windows :global(.ps-ic) { width: 16px; padding: 0 2px !important; }
  .fly-windows :global(.ps-result-icon) { display: block; width: 16px; height: 16px; background: var(--cert, #fff);
    -webkit-mask: var(--icon) center / 16px 16px no-repeat; mask: var(--icon) center / 16px 16px no-repeat; }
  .fly-windows :global(.ps-warp) { background: none; border: 0; padding: 0; width: 22px; height: 22px; cursor: pointer; }
  .fly-windows :global(.ps-warp img) { width: 22px; height: 22px; display: block; }
  .fly-windows :global(.ps-retail) { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .fly-windows :global(.ps-retail > :is(table, p, .error, .filter-panel)) { flex: 0 0 100%; }
  .fly-windows :global(.ps-retail > .ps-caption) { font-size: 13px; margin-right: auto; padding-left: 2px; }
  .fly-windows :global(.ps-results) { overflow-x: hidden !important; }
  .fly-windows :global(.ps-bottom) { height: 64px; margin-top: 4px; padding: 4px; background: rgba(255, 255, 255, 0.04); border-top: 1px solid rgba(255, 255, 255, 0.08); }
  .fly-windows :global(.ps-state) { display: flex; align-items: center; height: 24px; margin-bottom: 4px; gap: 4px; padding-left: 4px; }
  .fly-windows :global(.ps-probe) { width: 28px; height: 28px; display: inline-flex; }
  .fly-windows :global(.ps-probe img) { width: 28px; height: 28px; }
  .fly-windows :global(.ps-probe.dim) { opacity: 0.3; }
  .fly-windows :global(.ps-count) { font-size: 13px; }
  .fly-windows :global(.ps-count.warn) { color: #f39b2c; }
  .fly-windows :global(.ps-gap) { flex: 1; }
  .fly-windows :global(.ps-icon) { background: none; border: 0; padding: 0; width: 16px; height: 16px; cursor: pointer; }
  .fly-windows :global(.ps-icon:disabled), .fly-windows :global(.ps-form:disabled) { opacity: 0.35; cursor: default; }
  .fly-windows :global(.ps-icon img) { width: 16px; height: 16px; display: block; }
  .fly-windows :global(.ps-footer) { display: flex; align-items: center; gap: 2px; height: 32px; }
  .fly-windows :global(.ps-form) { background: none; border: 0; padding: 0; width: 32px; height: 32px; cursor: pointer; }
  .fly-windows :global(.ps-form img) { width: 32px; height: 32px; display: block; }
  .fly-windows :global(.ps-slider) { flex: 1; display: flex; justify-content: flex-end; padding-left: 8px; }
  .fly-windows :global(.ps-slider input) { width: 100%; max-width: 120px; }
  .fly-windows :global(.ps-analyze) { width: 100px; margin-left: 8px; font-size: 13px; padding: 4px 0; }
  /* A client window says its caption once, in its header: the panels' own title (the companion's) is not drawn here */
  .fly-windows :global(.win .panel-head > .panel-title) { display: none; }
  /* WalletWindow: the header's tabs; the WalletTabGroup 76 high - ISK and PLEX a third each, LP and EverMarks stacked;
     a tab's icon 56 in a 64 column on black at 0.25, its name and info mark over a divider, the amount at 17 */
  .fly-windows :global(.wl-head-tabs) { display: flex; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 8px; }
  .fly-windows :global(.wl-head-tabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 12px; font-size: 13px;
    color: rgba(255, 255, 255, 0.6); cursor: pointer; }
  .fly-windows :global(.wl-head-tabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.wl-tabs) { display: flex; height: 76px; gap: 0; margin-bottom: 16px; }
  .fly-windows :global(.wl-tabs[hidden]), .fly-windows :global(.wl-mine[hidden]) { display: none; }
  .fly-windows :global(.wl-tab) { flex: 0 0 33.333%; display: flex; background: rgba(128, 128, 128, 0.08); border: 1px solid rgba(255, 255, 255, 0.06); box-sizing: border-box; }
  .fly-windows :global(.wl-tab.sel) { background: rgba(128, 128, 128, 0.2); border-color: rgba(255, 255, 255, 0.2); }
  .fly-windows :global(.wl-tab .ic) { flex: 0 0 64px; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.25); margin: 4px; }
  .fly-windows :global(.wl-tab .ic img) { width: 56px; height: 56px; }
  .fly-windows :global(.wl-tab .data) { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .fly-windows :global(.wl-tab .top) { display: flex; align-items: center; justify-content: space-between; height: 32px; padding: 0 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
  .fly-windows :global(.wl-tab .top b) { font-size: 14px; }
  .fly-windows :global(.wl-tab .info) { width: 14px; height: 14px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.4); font-size: 10px;
    line-height: 13px; text-align: center; color: rgba(255, 255, 255, 0.6); }
  .fly-windows :global(.wl-tab .amount) { padding: 6px 6px 0; font-size: 17px; color: #fff; }
  .fly-windows :global(.wl-tab .amount.plex) { color: #fab400; }
  .fly-windows :global(.wl-stack) { flex: 0 0 33.333%; display: flex; flex-direction: column; }
  .fly-windows :global(.wl-tab.small) { flex: 1; align-items: center; }
  .fly-windows :global(.wl-tab.small .ic) { flex: 0 0 28px; height: 28px; margin: 4px; }
  .fly-windows :global(.wl-tab.small .ic img) { width: 24px; height: 24px; }
  .fly-windows :global(.wl-tab.small .data) { flex-direction: row; align-items: center; justify-content: space-between; padding-right: 6px; font-size: 12px; }
  .fly-windows :global(.wl-tab.small .amount) { padding: 0; font-size: 13px; }
  .fly-windows :global(.wl-mine .panel-head) { display: none; }
  .fly-windows :global(.wl-mine > table.guests) { display: none; }
  /* CharacterSheetWindow: the overview 340 wide at the left (the picture behind, the caption, the name over a divider,
     the title-over-value rows, the corporation at the bottom), the panels at the right */
  .fly-windows :global(.cs-retail) { display: flex; gap: 12px; align-items: stretch; min-height: 100%; }
  .fly-windows :global(.cs-retail > :is(.panel-head, h3.name, dl.facts)) { display: none; }
  .fly-windows :global(.cs-retail > .error) { position: absolute; }
  .fly-windows :global(.cs-left) { flex: 0 0 340px; position: relative; display: flex; flex-direction: column; min-height: 560px; padding: 12px;
    box-sizing: border-box; background: linear-gradient(180deg, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.75) 70%), var(--portrait, none) center top / cover no-repeat, #0d0f11; }
  .fly-windows :global(.cs-left .cap) { font-size: 13px; color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.cs-left .info) { margin-top: auto; display: flex; flex-direction: column; gap: 6px; }
  .fly-windows :global(.cs-left .nm) { font-size: 20px; font-weight: 400; color: #fff; }
  .fly-windows :global(.cs-left .div) { height: 1px; background: rgba(255, 255, 255, 0.2); margin: 4px 0; }
  .fly-windows :global(.cs-left .row) { display: flex; flex-direction: column; font-size: 13px; }
  .fly-windows :global(.cs-left .row small) { font-size: 11px; color: rgba(255, 255, 255, 0.5); }
  .fly-windows :global(.cs-left .bottom) { margin-top: 16px; font-size: 12px; color: rgba(255, 255, 255, 0.7); }
  .fly-windows :global(.cs-retail > .cs-main) { flex: 1; min-width: 0; overflow: auto; }
  /* AgencyWndNew: the header's tabs - Agency (home) and the content groups in agencyTabSortOrder */
  .fly-windows :global(.ag-tabs) { display: flex; flex-wrap: wrap; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 8px; }
  .fly-windows :global(.ag-tabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 10px; font-size: 13px;
    color: rgba(255, 255, 255, 0.6); cursor: pointer; }
  .fly-windows :global(.ag-tabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.ag-hidden) { display: none; }
  /* MailWindow: the header's tabs (Compose at the right), the folder tree 200 wide beside the list */
  .fly-windows :global(.mail-head-tabs) { display: flex; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 8px; }
  .fly-windows :global(.mail-head-tabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 12px; font-size: 13px;
    color: rgba(255, 255, 255, 0.6); cursor: pointer; }
  .fly-windows :global(.mail-head-tabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.mail-head-tabs .mail-compose) { margin-left: auto; border: 1px solid rgba(255, 255, 255, 0.2); padding: 4px 12px; color: #fff; }
  .fly-windows :global(.mail-split.on) { display: flex; gap: 4px; }
  .fly-windows :global(.mail-split.on > .mail-folders) { flex: 0 0 200px; display: flex; flex-direction: column; align-items: stretch;
    border-right: 1px solid rgba(255, 255, 255, 0.08); padding-right: 4px; }
  .fly-windows :global(.mail-split.on > .mail-folders button) { text-align: left; }
  .fly-windows :global(.mail-split.on > .mail-right) { flex: 1; min-width: 0; }
  /* addressBookWindow: its tabs (Contacts, Agents, Search) in the header, at the top */
  .fly-windows :global(.ct-retail) { display: flex; flex-direction: column; }
  .fly-windows :global(.ct-retail > nav.tabs) { order: -1; display: flex; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin-bottom: 8px; }
  .fly-windows :global(.ct-retail > nav.tabs button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 12px; font-size: 13px;
    color: rgba(255, 255, 255, 0.6); cursor: pointer; border-radius: 0; }
  .fly-windows :global(.ct-retail > nav.tabs button.active) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.85); background: none; }
  /* locations/window.py: the header's tabs at the top, Add Location / Create Folder / Create Subfolder at the bottom
     right; assetsWindow.py: Personal Assets, Search, Asset Safety as the header's tabs */
  .fly-windows :global(.loc-retail) { display: flex; flex-direction: column; min-height: 100%; }
  .fly-windows :global(.loc-retail > .loc-bottom) { order: 99; margin-top: auto; justify-content: flex-end; display: flex; gap: 8px; padding-top: 8px; }
  .fly-windows :global(.loc-retail.loc-search > :not(.loc-tabs, .loc-search-panel)) { display: none; }
  /* LocationSearchPanel: the search line (32 high, 16 below) with its settings button on the right, then the results */
  .fly-windows :global(.loc-search-line) { position: relative; display: flex; gap: 8px; height: 32px; margin-bottom: 16px; }
  .fly-windows :global(.loc-search-line input) { flex: 1; }
  .fly-windows :global(.loc-search-settings) { all: unset; width: 24px; display: grid; place-items: center; cursor: pointer; opacity: 0.8; }
  .fly-windows :global(.loc-search-settings img) { width: 16px; height: 16px; }
  .fly-windows :global(.loc-search-menu) { position: absolute; right: 0; top: 32px; z-index: 5; display: flex; flex-direction: column; min-width: 180px;
    padding: 4px 0; background: rgba(20, 22, 24, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .fly-windows :global(.loc-search-menu .caption) { padding: 4px 10px 2px; font-size: 11px; color: rgba(255, 255, 255, 0.5); text-transform: uppercase; }
  .fly-windows :global(.loc-search-menu button) { all: unset; padding: 3px 10px 3px 24px; font-size: 12px; cursor: default; position: relative; }
  .fly-windows :global(.loc-search-menu button[aria-checked="true"])::before { content: "●"; position: absolute; left: 9px; font-size: 9px; top: 5px; }
  .fly-windows :global(.loc-search-menu button:hover) { background: rgba(255, 255, 255, 0.1); }
  .fly-windows :global(:is(.loc-tabs, .as-retail > .asset-tabs)) { display: flex; gap: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.1); margin: 0 0 8px; }
  .fly-windows :global(:is(.loc-tabs, .as-retail > .asset-tabs) button) { background: none; border: none; border-bottom: 2px solid transparent; padding: 6px 12px;
    font-size: 13px; color: rgba(255, 255, 255, 0.6); cursor: pointer; border-radius: 0; }
  .fly-windows :global(.loc-tabs button.active), .fly-windows :global(.as-retail > .asset-tabs button[aria-selected="true"]) { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.as-retail) { display: flex; flex-direction: column; }
  .fly-windows :global(.as-retail > .asset-tabs) { order: -1; }
  /* assetsWindow.py's filter row (Combo height, Sort By on the right, 115 wide) and its scroll of LocationGroups */
  .fly-windows :global(.as-retail > .panel-head), .fly-windows :global(.as-retail > p.note) { display: none; }
  .fly-windows :global(.as-filter) { display: flex; gap: 4px; margin-bottom: 6px; }
  .fly-windows :global(.as-filter-gap) { flex: 1; }
  .fly-windows :global(.as-collapse) { align-self: flex-end; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; }
  .fly-windows :global(.as-group.as-sub) { padding-left: 20px; width: calc(100% - 24px); }
  .fly-windows :global(.as-pin) { margin-left: auto; width: 16px; height: 16px; opacity: 0.8; }
  .fly-windows :global(.as-hidden-icon) { width: 16px; height: 16px; opacity: 0.8; }
  .fly-windows :global(.as-count) { opacity: 0.6; }
  .fly-windows :global(.as-filter label) { display: flex; flex-direction: column; font-size: 10px; color: rgba(255, 255, 255, 0.6); width: 115px; }
  .fly-windows :global(.as-scroll) { flex: 1; min-height: 0; overflow: auto; }
  .fly-windows :global(.as-group) { all: unset; cursor: pointer; display: flex; align-items: center; gap: 4px; min-height: 26px; padding: 0 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06); width: calc(100% - 8px); font-size: 12px; }
  .fly-windows :global(.as-group:hover) { background: rgba(255, 255, 255, 0.06); }
  .fly-windows :global(.as-arrow) { width: 10px; opacity: 0.7; }
  .fly-windows :global(.as-item) { display: grid; grid-template-columns: 1fr 90px 100px; gap: 6px; align-items: center; min-height: 22px;
    padding: 0 4px 0 18px; border-bottom: 1px solid rgba(255, 255, 255, 0.03); font-size: 12px; margin: 0; }
  .fly-windows :global(.as-item.as-head) { font-size: 10px; color: rgba(255, 255, 255, 0.6); min-height: 18px; }
  .fly-windows :global(.as-col) { all: unset; cursor: pointer; white-space: nowrap; overflow: hidden; }
  .fly-windows :global(.as-item > span) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fly-windows :global(.as-item .num) { text-align: right; }
  .fly-windows :global(.as-note) { opacity: 0.7; }
  .fly-windows :global(.as-menu) { display: flex; flex-direction: column; margin-left: 24px; width: max-content; background: rgba(12, 14, 16, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.15); }
  .fly-windows :global(.as-menu button) { all: unset; cursor: pointer; padding: 3px 10px; font-size: 12px; }
  .fly-windows :global(.as-menu button:hover) { background: rgba(255, 255, 255, 0.1); }
  .fly-windows :global(.as-retail.as-safety > :not(.asset-tabs, .as-safety-note)) { display: none; }
  /* planetWindow.py ColoniesPanel: its entries (120 high, the icon column as wide, the caption bar on the highlight
     colour, 8 in) and the bottom ButtonGroup */
  .fly-windows :global(.pl-retail > .panel-head) { display: none; }
  .fly-windows :global(.pl-retail) { height: 100%; display: flex; flex-direction: column; }
  .fly-windows :global(.pc) { flex: 1; display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .fly-windows :global(.pc-scroll) { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
  .fly-windows :global(.pc-entry) { all: unset; display: flex; height: 120px; min-height: 120px; background: rgba(255, 255, 255, 0.05); box-sizing: border-box; }
  .fly-windows :global(button.pc-entry) { cursor: pointer; }
  .fly-windows :global(.pc-entry:hover), .fly-windows :global(.pc-entry.pc-selected) { background: rgba(255, 255, 255, 0.1); }
  .fly-windows :global(.pc-icon) { width: 116px; margin: 2px 2px 3px; display: grid; place-items: center; flex: none; }
  .fly-windows :global(.pc-icon img) { width: 98px; height: 98px; }
  .fly-windows :global(.pc-icon img.pc-slot-locked) { width: 68px; height: 68px; }
  .fly-windows :global(.pc-icon.pc-locked) { background: repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.06) 0 4px, transparent 4px 8px); }
  .fly-windows :global(.pc-body) { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .fly-windows :global(.pc-caption) { margin: 2px 0; padding: 4px 8px; background: rgba(255, 255, 255, 0.08); font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fly-windows :global(.pc-text) { padding: 6px 8px 0; font-size: 12px; color: rgba(255, 255, 255, 0.75); }
  .fly-windows :global(.pc-buttons) { display: flex; justify-content: center; gap: 8px; padding-top: 8px; }
  /* The flight Log keeps its actions in the window header and toolbar. */
  .fly-windows :global(.notice-log .panel-head) { display: none; }
  .fly-windows :global(.log-actions) { position: relative; display: flex; margin-bottom: 4px; }
  .fly-windows :global(.log-filter) { all: unset; width: 24px; height: 24px; display: grid; place-items: center; cursor: pointer; opacity: 0.8; }
  .fly-windows :global(.log-filter img) { width: 16px; height: 16px; }
  .fly-windows :global(.log-menu) { position: absolute; left: 0; top: 24px; z-index: 5; display: flex; flex-direction: column; min-width: 180px; padding: 4px 0;
    background: rgba(20, 22, 24, 0.97); border: 1px solid rgba(255, 255, 255, 0.15); }
  .fly-windows :global(.log-menu .caption) { padding: 4px 10px 2px; font-size: 11px; color: rgba(255, 255, 255, 0.5); text-transform: uppercase; }
  .fly-windows :global(.log-menu button) { all: unset; position: relative; padding: 3px 10px 3px 24px; font-size: 12px; cursor: default; }
  .fly-windows :global(.log-menu button[aria-checked="true"])::before { content: "✓"; position: absolute; left: 8px; font-size: 11px; }
  .fly-windows :global(.log-menu button:hover) { background: rgba(255, 255, 255, 0.1); }
  /* the combat settings' submenus: to the right of their entry, a caret on it; an entry whose setting depends on an off
     one greyed (isEnabled) */
  .fly-windows :global(.log-menu .log-sub-wrap) { position: relative; display: flex; flex-direction: column; }
  .fly-windows :global(.log-menu .has-sub)::after { content: "▸"; position: absolute; right: 8px; font-size: 10px; opacity: 0.7; }
  .fly-windows :global(.log-menu .has-sub) { padding-right: 24px; white-space: nowrap; }
  .fly-windows :global(.log-menu .log-sub) { left: 100%; top: -5px; white-space: nowrap; }
  .fly-windows :global(.log-menu button:disabled) { opacity: 0.4; pointer-events: none; }
  .fly-windows :global(.log-menu .sep) { height: 1px; margin: 3px 0; background: rgba(255, 255, 255, 0.12); }
  .fly-windows :global(.log-menu .has-icon img) { position: absolute; left: 4px; top: 3px; width: 16px; height: 16px; }
  .fly-windows :global(.log-menu .destructive) { color: #ff6a5a; }
  .fly-windows :global(.log-table) { width: 100%; border-collapse: collapse; font-size: 12px; }
  .fly-windows :global(.log-table th) { position: sticky; top: 0; background: #1b1d20; text-align: left; font-weight: 400; color: rgba(255, 255, 255, 0.6); padding: 2px 6px; }
  .fly-windows :global(.log-table th button) { background: transparent; border: 0; color: inherit; font: inherit; padding: 0; text-align: left; width: 100%; }
  .fly-windows :global(.log-table th[aria-sort]) { color: var(--color-text-bright); }
  .fly-windows :global(.log-table td) { padding: 1px 6px; vertical-align: top; color: rgba(255, 255, 255, 0.85); }
  .fly-windows :global(.log-table tbody tr) { cursor: default; user-select: none; }
  .fly-windows :global(.log-table tbody tr:hover) { background: rgba(255, 255, 255, 0.06); }
  .fly-windows :global(.log-table tbody tr[aria-selected="true"]) { background: rgba(84, 156, 193, 0.25); }
  .fly-windows :global(.log-table td:first-child), .fly-windows :global(.log-table td:nth-child(2)) { white-space: nowrap; }
  .fly-windows :global(.fl-form) { display: flex; flex-direction: column; min-height: 280px; }
  .fly-windows :global(.fl-form-text) { flex: 1; }
  .fly-windows :global(.fl-form-text h3) { margin: 0 0 4px; font-size: 18px; font-weight: 400; }
  .fly-windows :global(.fl-form-text p) { margin: 0; font-size: 13px; color: rgba(255, 255, 255, 0.75); }
  .fly-windows :global(.fl-form-row) { display: flex; gap: 8px; padding-top: 8px; }
  .fly-windows :global(.fl-form-row select) { min-width: 140px; }
  .fly-windows :global(.ind-cv-center) { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
  .fly-windows :global(.ind-cv-wedges) { position: absolute; left: -75px; top: -75px; width: 150px; height: 150px; }
  .fly-windows :global(.ind-cv-wedges .wedge) { position: absolute; transition: transform 0.7s; }
  .fly-windows :global(.ind-cv-wedges .wedge > span) { position: absolute; inset: 0; background-size: 100% 100%; }
  .fly-windows :global(.ind-cv-wedges .top), .fly-windows :global(.ind-cv-wedges .bottom) { left: 33px; width: 84px; height: 60px; }
  .fly-windows :global(.ind-cv-wedges .left), .fly-windows :global(.ind-cv-wedges .right) { top: 33px; width: 60px; height: 84px; }
  .fly-windows :global(.ind-cv-wedges .top) { top: 0; }
  .fly-windows :global(.ind-cv-wedges .bottom) { bottom: 0; }
  .fly-windows :global(.ind-cv-wedges .left) { left: 0; }
  .fly-windows :global(.ind-cv-wedges .right) { right: 0; }
  .fly-windows :global(.ind-cv.job .ind-cv-wedges .top) { transform: translateY(15px); }
  .fly-windows :global(.ind-cv.job .ind-cv-wedges .bottom) { transform: translateY(-15px); }
  .fly-windows :global(.ind-cv.job .ind-cv-wedges .left) { transform: translateX(15px); }
  .fly-windows :global(.ind-cv.job .ind-cv-wedges .right) { transform: translateX(-15px); }
  .fly-windows :global(.ind-cv-wedges :is(.top, .bottom) .lines) { background-image: url(/client-res/ui/texture/classes/industry/center/wedgetopbottom.png); }
  .fly-windows :global(.ind-cv-wedges :is(.top, .bottom) .dots) { background-image: url(/client-res/ui/texture/classes/industry/center/dotstopbottom.png); opacity: 0.85; }
  .fly-windows :global(.ind-cv-wedges :is(.left, .right) .lines) { background-image: url(/client-res/ui/texture/classes/industry/center/wedgeleftright.png); }
  .fly-windows :global(.ind-cv-wedges :is(.left, .right) .dots) { background-image: url(/client-res/ui/texture/classes/industry/center/dotsleftright.png); opacity: 0.85; }
  .fly-windows :global(.ind-cv-wedges :is(.bottom, .right) :is(.lines, .dots)) { transform: rotate(180deg); }
  .fly-windows :global(.ind-cv-wedges .bg) { background: var(--job); -webkit-mask-size: 100% 100%; mask-size: 100% 100%; }
  .fly-windows :global(.ind-cv-wedges .top .bg) { -webkit-mask-image: url(/client-res/ui/texture/classes/industry/center/bgtop.png); mask-image: url(/client-res/ui/texture/classes/industry/center/bgtop.png); }
  .fly-windows :global(.ind-cv-wedges .bottom .bg) { -webkit-mask-image: url(/client-res/ui/texture/classes/industry/center/bgbottom.png); mask-image: url(/client-res/ui/texture/classes/industry/center/bgbottom.png); }
  .fly-windows :global(.ind-cv-wedges .left .bg) { -webkit-mask-image: url(/client-res/ui/texture/classes/industry/center/bgleft.png); mask-image: url(/client-res/ui/texture/classes/industry/center/bgleft.png); }
  .fly-windows :global(.ind-cv-wedges .right .bg) { -webkit-mask-image: url(/client-res/ui/texture/classes/industry/center/bgright.png); mask-image: url(/client-res/ui/texture/classes/industry/center/bgright.png); }
  .fly-windows :global(.ind-cv-frame75) { position: absolute; left: -37.5px; top: -37.5px; width: 75px; height: 75px; border: 1px solid rgba(255, 255, 255, 0.1); box-sizing: border-box; }
  .fly-windows :global(.ind-cv-frame90) { position: absolute; left: -45px; top: -45px; width: 90px; height: 90px;
    background: #141619; opacity: 0.5; -webkit-mask: url(/client-res/ui/texture/classes/industry/center/bgframe.png) center / 100% 100%;
    mask: url(/client-res/ui/texture/classes/industry/center/bgframe.png) center / 100% 100%; }
  .fly-windows :global(.ind-cv-icon) { position: absolute; left: -32px; top: -32px; width: 64px; height: 64px; }
  .fly-windows :global(.ind-cv-icon .type-icon), .fly-windows :global(.ind-cv-icon img) { width: 64px; height: 64px; display: block; }
  .fly-windows :global(.ind-cv-remaining) { position: absolute; top: -110px; left: -60px; width: 120px; text-align: center; }
  .fly-windows :global(.ind-cv-remaining small), .fly-windows :global(.ind-cv-runs small) { display: block; font-size: 10px; text-transform: uppercase; opacity: 0.5; }
  .fly-windows :global(.ind-cv-remaining span) { font-size: 13px; }
  .fly-windows :global(.ind-cv-runs) { position: absolute; left: -38px; top: 88px; width: 76px; text-align: center; }
  .fly-windows :global(.ind-cv-runs input) { width: 76px; box-sizing: border-box; text-align: center; font-size: 13px; padding: 2px; }
  .fly-windows :global(.ind-cv-mete) { position: absolute; left: 73.5px; width: 79px; height: 30px; box-sizing: border-box;
    background: url(/client-res/ui/texture/classes/industry/center/bgmete.png) center / 100% 23px no-repeat; }
  .fly-windows :global(.ind-cv-mete.me) { top: -40px; }
  .fly-windows :global(.ind-cv-mete.te) { top: 10px; }
  .fly-windows :global(.ind-cv-mete img) { position: absolute; left: 8px; top: 3px; width: 16px; height: 16px; opacity: 0.6; }
  .fly-windows :global(.ind-cv-mete.me img) { width: 17px; height: 17px; }
  .fly-windows :global(.ind-cv-mete b) { position: absolute; right: 8px; top: 4px; font-size: 13px; color: #666666; }
  .fly-windows :global(.ind-cv-mete b.ready) { color: #3372b6; }
  .fly-windows :global(.ind-cv-mete b.negative) { color: #e26758; }
  .fly-windows :global(.ind-cv-mete .gauge) { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: rgba(255, 255, 255, 0.05); pointer-events: none; }
  .fly-windows :global(.ind-cv-mete .gauge span) { display: block; height: 100%; background: #3372b6; }
  .fly-windows :global(.ind-cv-mete .gauge.negative span) { margin-left: auto; background: #e26758; }
  .fly-windows :global(.ind-cv-mete.editing::after) { content: ""; position: absolute; inset: 1px 1px 8px; border: 1px solid #bc574b; pointer-events: none; }
  .fly-windows :global(.ind-cv-mete .ind-cv-mete-open) { position: absolute; inset: 0; padding: 0; border: 0; background: none; cursor: pointer; }
  .fly-windows :global(.ind-cv-mete .ind-cv-mete-open:hover) { background: rgba(255, 255, 255, 0.08); }
  .fly-windows :global(.ind-cv-mete .ind-cv-mete-edit) { position: absolute; top: 5px; right: 10px; width: 50px; height: 20px;
    box-sizing: border-box; padding: 0 3px; font-size: 13px; text-align: right; }
  .fly-windows :global(.ind-cv-mete .ind-cv-mete-reset) { position: absolute; top: 9px; right: 0; width: 12px; height: 12px;
    box-sizing: border-box; padding: 0; border: 0; background: none; color: #e26758; font-size: 14px; line-height: 12px; cursor: pointer; }
  .fly-windows :global(.ind-scroll .ind-none) { text-align: center; color: rgba(255, 255, 255, 0.5); padding: 12px; }
  .fly-map { position: fixed; left: 44px; top: 0; right: 0; bottom: 0; pointer-events: none; z-index: 5; }
  .fly-map.foreground { z-index: 21; }
  .fly-map :global(.star-map) { pointer-events: auto; }
  .fly-map :global(.star-map-location-pulse) {
    position: absolute; left: 50%; top: 50%; translate: -50% -50%; width: 300px; height: 300px;
    opacity: 0; pointer-events: none; background-color: var(--theme-focus-glow, #ccf3ff);
    mask: url('/client-res/ui/texture/classes/hexmap/circlefilled256.png') center / contain no-repeat;
  }
  @media (prefers-reduced-motion: no-preference) {
    /* MarkerMyLocation starts each three-second pulse 600 ms apart after a 4.8-second wait. */
    .fly-map :global(.star-map-location-pulse) {
      --pulse-delay: 4.8s;
      animation: map-location-size 4.8s cubic-bezier(.333, 0, .667, 1) var(--pulse-delay) infinite,
        map-location-opacity 4.8s cubic-bezier(.333, 0, .667, 1) var(--pulse-delay) infinite;
    }
    .fly-map :global(.star-map-location-pulse:nth-child(2)) { --pulse-delay: 5.4s; }
    .fly-map :global(.star-map-location-pulse:nth-child(3)) { --pulse-delay: 6s; }
  }
  @keyframes map-location-size {
    from { scale: 0; }
    62.5%, to { scale: 1; }
  }
  @keyframes map-location-opacity {
    from, 62.5%, to { opacity: 0; }
    31.25% { opacity: .02; }
  }
  .fly-map :global(.star-map-layout) { position: absolute; top: 10px; right: 42px; z-index: 1; color: rgba(255,255,255,0.75); font-size: 11px; }
  .fly-map :global(.star-map-close) { position: absolute; top: 8px; right: 10px; z-index: 1; background: rgba(0,0,0,0.5);
    color: #ccc; border: 1px solid rgba(255,255,255,0.2); width: 22px; height: 22px; cursor: pointer; }
  .fly-map :global(.star-map-filters) { position: absolute; top: 34px; right: 10px; z-index: 1; display: grid;
    gap: 4px; padding: 6px 8px; color: #ddd; background: #111d; border: 1px solid #fff3; font-size: 12px; }
  .fly-map :global(.star-map-filters label) { display: flex; align-items: center; gap: 8px; }
  .fly-map :global(.star-map-filters select),
  .fly-map :global(.star-map-filters button) { color: #eee; border: 1px solid #fff4; background: #232525; font: inherit; }
  .fly-map :global(.star-map-filters [role="status"]:empty) { display: none; }
  .fly-map :global(.star-map-filter-legend span) { margin-right: 8px; }
  .fly-map :global(.star-map-filter-legend span::before) { content: ""; display: inline-block; margin-right: 4px;
    width: 8px; height: 8px; background: #305665; }
  .fly-map :global(.star-map-filter-legend .precise::before) { background: #58a7bf; }
  .fly-map :global(.star-map-activity-markers) { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .fly-map :global(.star-map-activity-marker) { position: absolute; top: 0; left: 0; pointer-events: auto; cursor: pointer;
    border: 1px solid #72a2b5; background: #101d25d9; color: #fff; border-radius: 8px; line-height: 14px;
    min-width: 16px; padding: 0 3px; font-size: 11px; }
  .fly-map :global(.star-map-activity-marker[data-kind="precise"]) { border-color: #58a7bf; background: #264451e8; }
  .fly-map :global(.star-map-activity-marker[data-kind="phased"]) { border-color: #f8faa6; background: #f8faa633; }
  .fly-map :global(.star-map-activity-marker[data-kind="phased"] img) { display: block; width: 16px; height: 16px; }
  .fly-map :global(.star-map-activity-marker[data-kind="convoys"]) { border-color: #956bec; background: #392c56e8; }
  .fly-map :global(.star-map-activity-marker[data-local="true"]) { box-shadow: 0 0 0 1px #fff9; }
  .fly-map :global(.star-map-activity-cluster) {
    --cluster-fill: url("/client-res/ui/texture/classes/mapview/markers/clusterfill.png");
    --cluster-stroke: url("/client-res/ui/texture/classes/mapview/markers/clusterstroke.png");
    position: absolute; top: 0; left: 0; display: grid; place-items: center; isolation: isolate;
    width: 32px; height: 32px; padding: 0; border: 0; background: none; pointer-events: auto; cursor: pointer;
    color: #fff; font-size: 13px; font-weight: 600;
  }
  .fly-map :global(.star-map-activity-cluster[hidden]) { display: none; }
  .fly-map :global(.star-map-activity-cluster[data-level="region"]) {
    --cluster-fill: url("/client-res/ui/texture/classes/mapview/markers/clusterfill_64.png");
    --cluster-stroke: url("/client-res/ui/texture/classes/mapview/markers/clusterstroke_64.png");
    width: 64px; height: 64px; font-size: 16px;
  }
  .fly-map :global(.star-map-activity-cluster::before), .fly-map :global(.star-map-activity-cluster::after) {
    content: ""; position: absolute; inset: 0; pointer-events: none; mask-size: 100% 100%;
  }
  .fly-map :global(.star-map-activity-cluster::before) {
    z-index: -2; background: var(--theme-focus-dark, #305665); mask-image: var(--cluster-fill);
  }
  .fly-map :global(.star-map-activity-cluster::after) {
    z-index: -1; background: var(--theme-focus, #58a7bf); mask-image: var(--cluster-stroke);
  }
  .fly-lobby { left: auto; right: 16px; top: 16px; width: 280px; min-height: 260px; z-index: 5; }
  .fly-lobby.planet-covered { visibility: hidden; }
  .metenox-lobby { min-height: 0; }
  .metenox-lobby .station-name { margin-bottom: 12px; }
  .metenox-controls { position: absolute; top: 160px; right: 16px; z-index: 5; }
  .refinery-controls { display: flex; gap: 8px; flex-wrap: wrap; }
  .lobby-body { padding: 10px 12px 14px; }
  .lobby-body .station-name { position: static; font-size: 18px; color: #f0f1ee; line-height: 1.25; }
  .lobby-body .station-sub { position: static; margin-top: 2px; color: var(--text-dim); font-size: 12px; }
  .lobby-sec { color: #5fd38c; }
  .lobby-body .undock { position: static; display: block; width: 100%; margin: 12px 0 10px; }
  .lobby-error { position: static; margin: 0 0 8px; }
  .academy-service { width: 100%; margin-bottom: 10px; padding: 7px; border: 1px solid #6b939e;
    border-radius: 0 0 8px 8px; background: #13282f; color: #d5eef2; cursor: pointer; }
  .academy-service:hover:enabled { background: #26434b; }
  .academy-service:disabled { opacity: 0.5; cursor: default; }
  .lobby-services { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .lobby-svc { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 2px; background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08); color: #c8ccc8; font: 11px/1.2 var(--font); cursor: pointer; }
  .lobby-svc:hover { background: rgba(255, 255, 255, 0.10); border-color: rgba(255, 255, 255, 0.2); }
  .lobby-svc img { width: 32px; height: 32px; }
  .char-card { padding: 0; text-align: left; color: inherit; font: inherit; }
</style>
