// Space, drawn from the browser's own park (LivePark): every ball where the retail client draws it
// (Ballpark.drawn), described by the BFF's own overview projection (projectSpace), around a camera that
// orbits the pilot's ship as the client's does.
//
// FLOATING ORIGIN. EVE's coordinates run to hundreds of billions of metres; a float32 vertex there has
// steps of tens of kilometres. The scene's origin is the pilot's ship every frame: positions are taken
// relative to it in doubles on the CPU and only then handed to the GPU. A logarithmic depth buffer
// covers a hull at 10 m and a planet at 10^10 m in one frame.
//
// HANDEDNESS. EVE's space is left-handed (y up); three.js is right-handed. z is mirrored going in and
// coming out (models are mirrored once, at extraction).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { projectSpace } from "virtual:destiny";
import { LivePark } from "../three/livePark.ts";
import { typeModel, setThrust, setShipSpeed, setControllerVariable, sendControllerEvent, setActivationStrength, setDirtLevel, dirtLevelFromTime } from "../three/hullModel.ts";
import { shiftGpuParticles } from "../three/gpuParticles.ts";
import { useFarBoosters } from "../three/boosterVolumetric.ts";
import { celestialModel, systemCelestials, setPlanetEnvironment, type CelestialItem } from "../three/celestialModel.ts";
import { ShipHud, type HudModule } from "./shipHud.ts";
import { formatTemplate, plainText } from "../bridge/clientWords.ts";
import { CARGO_HOLD, SHIP_HOLDS } from "../bridge/shipHolds.ts";
import { NewShipHud } from "./newShipHud.ts";
import { hudSetting, hudSettingNow } from "../store/hudSettings.ts";
import { activeTargetID, activeTargetName } from "./activeTarget.ts";
import { WarpTunnel } from "./warpTunnel.ts";
import { WormholeTransit, WORMHOLE_START_MS, WORMHOLE_MIDDLE_MS, WORMHOLE_CAMERA_RETURN_MS, WORMHOLE_STOP_MS } from "./wormholeTransit.ts";
import { TurretFx, fxGuid } from "./turretFx.ts";
import { impactOverlayOf, IMPACT_ANIMATIONS, type ImpactOverlay } from "../three/impactOverlay.ts";
import { MissileFx } from "./missileFx.ts";
import { ShipFx } from "./shipFx.ts";
import { MiningSurveyWave, miningWaveSounds, miningWaveTargets } from "./miningSurveyWave.ts";
import { miningBracketReadout, type MiningScanTypeFacts } from "../bridge/miningScanResults.ts";
import { AsteroidModels } from "../three/asteroidModel.ts";
import type { ApiOptions } from "../app/api.ts";
import { DRIFTER_COLLECTION, DrifterCollectionExplosions } from "./drifterCollectionExplosions.ts";
import { isNonInteractableWormhole, nonInteractableWormhole, ordinaryWormhole, playWormholeActivity, updateWormholePose, WormholeAudio, WORMHOLE_COLLAPSE_MS, WORMHOLE_GROUP } from "./nonInteractableWormhole.ts";
import { setEffectShaderQuality, setSmartLightSimulationTime } from "../three/hullChildren.ts";
import { CameraShake } from "./cameraShake.ts";
import { ObservatoryEnvironment } from "./observatoryEnvironment.ts";
import { ObservatoryVortex, OBSERVATORY_VORTEX_TYPE } from "../three/observatoryVortex.ts";
import { SpaceShadowAtlas, type ShadowPlanet } from "../three/spaceShadowAtlas.ts";
import { VortexReflectionProbe, type VortexReflection } from "../three/vortexReflection.ts";
import { CameraTaskGestures, type CameraTaskEvent } from "../bridge/cameraTasks.ts";
import { initialOrbitDistance, isOwnStargateDeparture, MAX_JUMP_CAMERA_COORDINATE, setCameraDistance, setCameraPose, translateCameraPose, validCameraPosition } from "./spaceCameraPose.ts";
import { ENTRY_CAMERA_DURATION_MS, entryCameraFov, spaceEntryCamera, type EntryCameraPath } from "./spaceEntryCamera.ts";
import { explosionCameraFov, spaceExplosionCamera, type ExplosionCameraPath } from "./spaceExplosionCamera.ts";
import { gfx, spaceRendering, lodSettings } from "./gfxSettings.ts";
import { playUiEvent, playWorldEvent, setListener, fxSoundsOf, explosionSoundsOf, pickExplosion, typeSoundsOf, playWorldLoop, effectAudioScale, stopEmitter, type WorldLoop } from "./uiAudio.ts";
import { commandForKey, combatForModifiers, isCombatCommand, labelOf, type CombatCommand } from "./shortcutKeys.ts";
import { buildTurrets, slotOfFlag, turretModelInfo, turretSetCount, type HullTurretData, type TurretFit, type TurretRig, type TurretSetState } from "../three/turretModel.ts";
import type { DamageRouting, MiningState, SpaceSnapshot, SurveyResult } from "../store/types.ts";
import { healthNotificationSettings, HEALTH_NOTIFICATIONS } from "../store/notifySettings.ts";
import { ALERT_ANIMATION_MS, ALERT_DURATION_MS, CAPACITOR, HULL, activeAlertLevel, capacitorAlerting, capacitorChanged, damageStateChanged, initialShipAlertState, isLevelActive } from "../ui/shipAlert.ts";
import { alignText, indicationHeader, indicationText, pointText, shipIndication, shipStoppingText, warpProgress, warpText, SHIP_STOPPING_MS } from "../space/actionIndication.ts";
import { TargetBar, type TargetBarEntry } from "./targetBar.ts";
import { TARGET_LOCKED_LABEL, targetLockDurationMs, type TargetLockRadii } from "./targetLock.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { Overview, typeNames } from "./overview.ts";
import { ContextMenu, type ContextEntry } from "./contextMenu.ts";
import { fmtDist as fmtDistance } from "../space/overview.ts";
import { DScanWindow } from "./dscan.ts";
import { SolarSystemMapWindow, MARKER_GROUPS, type MapScanResult } from "./solarSystemMap.ts";
import { Neocom } from "./neocom.ts";
import { bracketIcon, hasBracketData, loadBrackets } from "./brackets.ts";
import { PROXIMITY_TRAP_RANGES } from "./proximityTraps.ts";
import { probeNumber } from "../bridge/scannerWrites.ts";
import { gridBracketWanted, type BracketOverride, type OverviewRelationships } from "./overviewFilters.ts";
import { panelErrorWords } from "../bridge/refusals.ts";
import { PlayWindow, clientTexture } from "./window.ts";
import { bloomFor, type Bloom } from "../three/bloom.ts";
import { DynamicExposure } from "../three/exposure.ts";
import { CombatMessage } from "./combatMessage.ts";
import { RadialMenu, RADIAL_CSS, RADIAL_ICON, WARP_RANGES, holdToOpen, radialRanges, type RadialOption } from "./radialMenu.ts";
import { METENOX_BOARD_RANGE, METENOX_DEPOSIT_RANGE, METENOX_MATERIAL_RANGE, METENOX_TYPE_ID } from "../bridge/autoMoonMining.ts";
import { hideMetenoxBeam, updateMetenoxPresentation } from "./metenoxPresentation.ts";
import { JUMP_BRIDGE_GROUP, type JumpBridgeSlim } from "../bridge/jumpBridgePanel.ts";
import { ACTIVATE_GATE_LABEL, IN_WARP_HINT_LABEL, isWarpGate } from "../bridge/gateActivation.ts";
import { ENTER_WORMHOLE_LABEL } from "../bridge/placeChanges.ts";
import { hasJumpPolarization, POLARIZED_LABEL, polarizationTime, type WormholePolarization } from "./wormholePolarization.ts";
import { activateCargoTarget, OPEN_CARGO_ICON, OPEN_CARGO_LABEL, selectedCargo } from "./containerInteraction.ts";

export interface Entity {
  kind: string; itemID: number; typeID: number | null; groupID: number | null; categoryID: number | null; name: string | null;
  radius: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number };
  isSelf: boolean; mode?: string | null; maxVelocity?: number | null; isNpc?: boolean; targetEntityID?: number | null;
  /** Its slim item's corporation (spaceProjection), or null. */
  corporationID?: number | null;
  ownerID?: number | null;
  characterID?: number | null;
  allianceID?: number | null;
  warFactionID?: number | null;
  hackingSecurityState?: number;
  dunObjectID?: number | null;
  dunRotation?: readonly [number, number, number];
  poseID?: number | null;
  jumpBridge?: JumpBridgeSlim;
}
interface ItemAction {
  key: string;
  title: string;
  icon: string;
  disabled?: boolean;
  disabledReason?: string;
  run: () => Promise<void>;
}

export interface JumpBridgePanelState {
  readonly bridge: JumpBridgeSlim;
  readonly shipTypeID: number | null;
  readonly near: boolean;
}
interface Snapshot {
  entities: Entity[];
  ship: (Entity & {
    maxVelocity: number | null; speedFraction: number | null;
    shieldRatio?: number | null; armorRatio?: number | null; hullRatio?: number | null; capacitorRatio?: number | null;
  }) | null;
}
type MiningOverlayState = Pick<MiningState, "survey" | "surveyProgress" | "surveyAtMs" | "holds">;

/**
 * `onNeocom`: what a Neocom button opens. `rack`: the module rack's data and use. `windowLayer`: where the view's own
 * windows (overview, selected item, the scanner) and its radial menu go, beside the app's windows so that they stack
 * together, the one last clicked on top; the view's own root when there is none. `showInfo`: the info window for a
 * thing in space (the radial menu's Show Info).
 */
export interface SpaceViewOptions {
  /** A full-frame secondary view owns the canvas and input while flight keeps its live feed. */
  covered?(): boolean;
  openAutoMoonMiner?: (structureID: number) => Promise<void>;
  openMoonMaterialBay?: (structureID: number) => Promise<void>;
  boardMetenox?: (structureID: number) => Promise<void>;
  transferMetenoxFuel?: (structureID: number, shipID: number) => Promise<void>;
  mountJumpBridge?: (host: HTMLElement, gate: Entity, state: JumpBridgePanelState) =>
    { update(state: JumpBridgePanelState): void; destroy(): void };
  jumpBridge?: (itemID: number) => Promise<void>;
  wormholePolarization?: (itemID: number) => Promise<WormholePolarization | null>;
  onNeocom?: (id: string) => void;
  /** The system the view is in, with its security, as its scene is loaded (the music's switch). */
  onSystem?: (solarSystemID: number, security: number | null) => void;
  rack?: {
    modules(): HudModule[];
    use(m: HudModule, targetID: number | null, passiveLock?: boolean): Promise<void>;
    targeting(itemID: number): Promise<"lock" | "passive" | null>;
    capacitor?(): { max: number | null; ratio: number | null };
    /** Each rack's heat over its capacity, 0..1 (the app's space snapshot: ship.rackHeat), or null. */
    heat?(): Readonly<Partial<Record<"high" | "mid" | "low", number>>> | null;
    /** Overloading: a module's (ToggleOverload) and a rack's, by its first module (OverloadRack / StopOverloadRack). */
    overload?: { module(itemID: number, on: boolean): Promise<void>; rack(activationID: number, on: boolean): Promise<void> };
    /** The new HUD's module tooltip rows (moduleButtonTooltip.UpdateToolTips), null where it has none to give. */
    tooltip?(m: HudModule): readonly import("./moduleTooltip.ts").ModuleTooltipRow[] | null;
    /**
     * capacitorFlow: the ship's peak recharge and its fit's whole drain (CapacitorSimulator, GJ a second), and what its
     * running modules drain now (_GetActiveDrain); null where not known.
     */
    capacitorFlow?(): { peak: number; maxDrain: number; drain: number } | null;
    /** The ship's slot order (slotOrder.GetSlotOrder: the 24 flags by place), and a module dropped on a place. */
    slotOrder?(): readonly number[];
    dropSlot?(toFlag: number, fromFlag: number, peel: boolean): Promise<void>;
    /** The ship's slots per rack (present ones), for the new HUD's empty slots. */
    slotCounts?(): { high: number; mid: number; low: number };
  };
  /** The session's snapshot includes the acknowledged align and warp targets. */
  flightSnapshot?: () => SpaceSnapshot | null;
  targeting?: {
    scanResolution(shipID: number): number | null;
    typeRadii(typeID: number): Promise<TargetLockRadii>;
  };
  miningSurvey?: () => MiningOverlayState;
  miningScanFacts?: (typeID: number) => Promise<ReadonlyMap<number, MiningScanTypeFacts>>;
  onMiningGridExit?: () => void;
  indicationWords?: () => Readonly<Record<string, string | null | undefined>>;
  windowLayer?: { element: HTMLElement; raise(el: HTMLElement): void };
  showInfo?: (itemID: number, typeID: number | null) => void;
  viewPlanet?: (planetID: number) => Promise<void>;
  /** Corporations' tickers (cfg.corptickernames: POST /api/corp-tickers), by corporation id; null where none. */
  corpTickers?: (corpIDs: number[]) => Promise<Record<string, string | null>>;
  /** The reloads the server announced for the pilot's modules (OnChargeBeingLoadedToModule), by module item id. */
  reloads?: () => Readonly<Record<number, { startedAtMs: number }>>;
  /** True while the pilot is coming out of a station: the view's first sight of the ship is the undock camera's. */
  undocking?: () => boolean;
  /** Present only when character selection goes directly into space. */
  entryWarpHistory?: Promise<boolean | null>;
  recordCameraTask?: (event: CameraTaskEvent) => void;
  overviewPilotID?: number;
  overviewNotice?: (text: string) => void;
  overviewRelationships?: () => OverviewRelationships | undefined;
  /**
   * A Sov Hub's menu entries (celestialCheckers): Deposit Reagents (OfferOpenSovFuelDepositWindow: an infrastructure hub,
   * the pilot in a ship in space, not warping, within transfer range - 2,500 m surface to surface) and Open Sov Hub
   * Config Window (OfferOpenSovHubConfigWindow: the hub owned by the pilot's corporation and the pilot a station
   * manager). `configurable` says the second's conditions for a hub.
   */
  sovHub?: { deposit(hubID: number): void; configure(hubID: number): void; configurable(hubID: number, corporationID: number | null): boolean };
}

export interface SpaceActions {
  gotoDirection(dx: number, dy: number, dz: number): Promise<void>;
  setSpeedFraction(fraction: number): Promise<void>;
  alignTo(itemID: number): Promise<void>;
  keepAtRange(itemID: number, range?: number): Promise<void>;
  jump(itemID: number): Promise<void>;
  enterWormhole?(itemID: number): Promise<void>;
  activateGate?(itemID: number, typeID: number | null): Promise<void>;
  lock(itemID: number): Promise<void>;
  unlock(itemID: number): Promise<void>;
  /** What is locked, and what has the pilot locked: the BFF's read (GET /api/bridge/targets). */
  targets(): Promise<{ targetIDs: number[]; targeterIDs: number[]; acquiringIDs?: number[] }>;
  stop(): Promise<void>;
  approach(itemID: number): Promise<void>;
  orbit(itemID: number, range?: number): Promise<void>;
  warpTo(itemID: number, range?: number): Promise<void>;
  dock(itemID: number): Promise<void>;
  /** scanMgr.ConeScan(angle, range, x, y, z): the directional scanner's call, where the page can make it. */
  coneScan?(angle: number, range: number, x: number, y: number, z: number): Promise<unknown>;
  dscanHologramTypes?(ids: readonly number[]): Promise<Record<string, number>>;
  /** The install's words for a label, filled with its arguments; null where they are not had yet. */
  word?(label: string, args?: Readonly<Record<string, string | number>>): string | null;
  /** cfg.evelocations.Prime: the locations' names asked for (config.GetMultiLocationsEx). */
  primeLocations?(itemIDs: readonly number[]): void;
  /** cfg.evelocations.Get(itemID).name where it is known; null until it is. */
  locationName?(itemID: number): string | null;
  /** The pilot's active probes as the scanner has them (its operations), or none. */
  probes?(): readonly { readonly probeID: number; readonly pos: readonly [number, number, number]; readonly destination: readonly [number, number, number]; readonly scanRange: number; readonly state?: number; readonly rangeSteps?: readonly number[] | null }[];
  /** The probe scan's results shown in the session's system (the solar system map's UpdateScanResult). */
  scanResults?(): readonly MapScanResult[];
  /** scanSvc.IsSiteSelected's set: the probe results selected. */
  selectedSites?(): ReadonlySet<string>;
  /** scanSvc.SelectSite: a result marker clicked in the solar system map. */
  selectSite?(siteID: string, multiSelect: boolean): void;
  /** A probe result marker's label in the solar system map (GetLabelText, the difficulty line). */
  resultLabel?(siteID: string): string;
  /** A probe result marker's menu in the solar system map (GetScanResultMenuWithIgnore). */
  resultMenu?(siteID: string): readonly { label: string; run: () => void }[];
  /** The solar system map's probe move (RegisterProbeMove): each probe given its destination. */
  moveProbes?(moves: readonly { probeID: number; destination?: [number, number, number]; rangeStep?: number | undefined }[]): Promise<void>;
  /** The active ship's attribute as the client's dogma has it (GetAccurateAttributeValue); null where not had. */
  shipAttribute?(attributeID: number): number | null;
  /** menusvc.OpenCargo on a wreck or a can: flown to within reach, opened, and the inventory window shown on it. */
  openCargo?(itemID: number): Promise<void>;
  /** Inventory opened on one of the ship's own holds (the new HUD's cargo indicator), by the bay's key. */
  openShipHold?(key: string): void;
  /** The menu's Set Destination and Add Waypoint (starmap.SetWaypoint), and Save Location... (the bookmark window). */
  setDestination?(itemID: number): void;
  addWaypoint?(itemID: number): void;
  saveLocation?(itemID: number, typeID: number | null): void;
  /** The ship's holds read (fill and capacity), for the new HUD's cargo indicator. */
  loadShipHolds?(): Promise<void>;
  /** A client command run from a HUD button (ToggleProbeScanner, CmdToggleAutopilot, ...), as the page runs its shortcut. */
  runCommand?(cmd: string): void;
  /** autoPilotSvc.GetState: whether the autopilot is on, for the new HUD's autopilot button. */
  autopilotOn?(): boolean;
}

const KIND_COLOUR: Record<string, string> = {
  ship: "#c9c9c9", drone: "#c9c9c9", station: "#d7dad6", stargate: "#d7dad6", planet: "#9fb3c8", moon: "#9fb3c8", sun: "#ffd27a",
  asteroid: "#a08c74", celestial: "#9fb3c8", wreck: "#8d918c", container: "#8d918c", structure: "#d7dad6", billboard: "#8d918c",
};

/** A bracket glyph by kind, in the client's spirit: the shape says what it is, the colour whose. */
export function glyph(e: Entity): string {
  const c = e.isNpc ? "var(--hostile)" : KIND_COLOUR[e.kind] ?? "#c9c9c9";
  const icon = bracketIcon(e);
  if (icon) return `<span class="glyph bi" style="--icon:url('${icon}');--tint:${c}"></span>`;
  switch (e.kind) {
    case "ship": case "drone": case "fighter":
      return `<svg class="glyph" viewBox="0 0 16 16"><path d="M8 3 L13 12 L3 12 Z" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
    case "station": case "structure":
      return `<svg class="glyph" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" fill="none" stroke="${c}" stroke-width="1.5"/><rect x="6.5" y="6.5" width="3" height="3" fill="${c}"/></svg>`;
    case "stargate":
      return `<svg class="glyph" viewBox="0 0 16 16"><path d="M8 2 L14 8 L8 14 L2 8 Z" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
    case "planet": case "moon": case "sun":
      return `<svg class="glyph" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
    case "asteroid":
      return `<svg class="glyph" viewBox="0 0 16 16"><path d="M4 9 L7 4 L12 6 L12 11 L7 12 Z" fill="none" stroke="${c}" stroke-width="1.3"/></svg>`;
    default:
      return `<svg class="glyph" viewBox="0 0 16 16"><rect x="5" y="5" width="6" height="6" fill="none" stroke="${c}" stroke-width="1.5"/></svg>`;
  }
}

export function distanceWords(m: number): string {
  if (m < 10_000) return `${Math.round(m).toLocaleString()} m`;
  if (m < 149_597_870_700 * 0.1) return `${Math.round(m / 1000).toLocaleString()} km`;
  return `${(m / 149_597_870_700).toFixed(1)} AU`;
}

/** menusvc.GetDefaultActionDistance: the pilot's default warp, orbit and keep-at-range distances (0, 1,000, 1,000 m). */
type DefaultDistanceKind = "WarpTo" | "Orbit" | "KeepAtRange";
const DEFAULT_DISTANCES: Readonly<Record<DefaultDistanceKind, number>> = { WarpTo: 0, Orbit: 1000, KeepAtRange: 1000 };
export function defaultDistance(kind: DefaultDistanceKind): number {
  try {
    const v = Number(localStorage.getItem(`evejs.ui.defaultDistance.${kind}`));
    return localStorage.getItem(`evejs.ui.defaultDistance.${kind}`) !== null && Number.isFinite(v) ? v : DEFAULT_DISTANCES[kind];
  } catch {
    return DEFAULT_DISTANCES[kind];
  }
}
function setDefaultDistance(kind: DefaultDistanceKind, value: number): void {
  try { localStorage.setItem(`evejs.ui.defaultDistance.${kind}`, String(value)); } catch { /* the default lasts the page */ }
}

/** The asteroid beam's end: a ray from the shooter to the rock's centre (damageLocatorOf). */
const surfaceRay = new THREE.Raycaster();

export class SpaceView {
  readonly root = document.createElement("div");
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  /** Space's bloom (the space scenes' Tr2PPBloomEffect): the sun, engine flames, glow maps, weapons fire, lava. */
  private bloom: Bloom | null = null;
  private readonly observatoryEnvironment = new ObservatoryEnvironment();
  /**
   * Space's dynamic exposure: the space scenes have no post-process of their own, so the client gives them
   * res:/dx9/default/postprocess.black (dynamic exposure at its defaults, tone map method 0).
   */
  private readonly exposure = new DynamicExposure();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 1, 1e13);
  private readonly controls: OrbitControls;
  private readonly brackets = document.createElement("div");
  private readonly bracketEls = new Map<number, HTMLDivElement>();
  private readonly polarization = new Map<number, { timer: WormholePolarization | null }>();
  private readonly jumpBridgePanels = new Map<number, {
    host: HTMLDivElement; signature: string; update(state: JumpBridgePanelState): void; destroy(): void;
  }>();
  private readonly marks = new Map<number, THREE.Object3D>();
  private readonly markModels = new WeakMap<THREE.Object3D, {
    standIn?: THREE.Mesh<THREE.SphereGeometry, THREE.Material>;
    request?: { typeID: number; skinMaterialSetID: number | null };
  }>();
  private readonly wormholeAudio = new Map<number, WormholeAudio>();
  private readonly collapsingWormholes: { mark: THREE.Object3D; audio: WormholeAudio; until: number }[] = [];
  // Empty slots hidden, as the client's default (showEmptySlots off) has them, until the module rack knows the fit.
  // hud/client/rollout.py IsNewHudWanted: the 24.02 new HUD where its preview setting is on, else the classic ship UI.
  private readonly shipHud: ShipHud | NewShipHud = hudSettingNow("shipHudNew_preview") ? new NewShipHud() : new ShipHud({ slots: { hi: 0, med: 0, low: 0 } });
  private readonly targetBar = new TargetBar();
  /** Lock requests awaiting a response, keyed by target ID and local start time. */
  private readonly lockingIDs = new Map<number, number>();
  /** The client's state.activeTarget. Selecting a locked object makes it active. */
  private activeTarget: number | null = null;
  /** Pending locks acknowledged by the targeting flow, with the original start time where known. */
  private acquiringTargets = new Map<number, number>();
  private readonly targetLockRadii = new Map<number, TargetLockRadii | null>();
  private lockWallTime = performance.now();
  private lockSimTime = this.lockWallTime;
  // An entry begins while dogma is being read, then waits for the target's lock.
  private readonly moduleTargetOrders = new Map<number, { mode: "lock" | "passive" | null }>();
  private orderedTarget: number | null = null;
  private targetOrderShip: number | null = null;
  private targetOrderSystem: number | null = null;
  private readonly targetingCursor = document.createElement("div");
  private readonly modeEl: HTMLDivElement;
  private readonly selectedEl: HTMLElement;
  private readonly selectedWin: PlayWindow;
  private locked = new Set<number>();
  private targeters = new Set<number>();
  private readonly feedEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private selected: number | null = null;
  private readonly overview: Overview;
  private starfieldObj!: THREE.Points;
  private readonly sunLight = new THREE.DirectionalLight(0xfff6e8, 3);
  private readonly spaceShadows = new SpaceShadowAtlas(this.renderer);
  /** From the grid toward the system's star. */
  private readonly sunDir = new THREE.Vector3(-1, 0.4, 0.6).normalize();
  private snapshot: Snapshot | null = null;
  private frameCount = 0;
  private stopped = false;
  private readonly warpTunnel = new WarpTunnel();
  private readonly wormholeTransit = new WormholeTransit(this.scene);
  /** Weapons fire, from the park's special effects. */
  private readonly turretFx = new TurretFx();
  /** Missiles in flight (missileFx.ts): their warheads flown to the target's damage locators. */
  readonly missileFx = new MissileFx();
  /** The ShipEffects playing (shipFx.ts): a web's vortex on its target and the like. */
  readonly shipFx = new ShipFx();
  private readonly miningSurvey = new MiningSurveyWave();
  private readonly miningHoldBracket = document.createElement("button");
  private readonly miningVolumes = new Map<number, number | null>();
  private lastMiningShip: number | null = null;
  private miningInWarp = false;
  private readonly asteroidModels = new AsteroidModels();
  private miningSurveyUsesSimClock = false;
  private readonly collectionExplosions = new DrifterCollectionExplosions(this.scene);
  /** The camera's shake (cameraShake.ts): explosions shake it. */
  private readonly shake = new CameraShake();
  /** The Drone Models setting the drones' models were last shown by. */
  private droneModels = true;
  /**
   * A shot landing on a ball with an impact overlay: at the damage locator facing the shooter best (the turret's
   * choice, EveTurretSet.cpp:3252-3330, roughly), its way the shooter's place less the locator's, the turret's size and
   * life (turretFx.ts).
   */
  private readonly onShot = (shooter: number, target: number, size: number, lifeTime: number): void => {
    const impact = this.marks.get(target)?.userData.impact as ImpactOverlay | undefined;
    const from = this.placeOf(shooter, this.lastOrigin);
    if (!impact || !from) return;
    const locator = impact.locatorFacing(from);
    const at = impact.locatorPosition(locator);
    impact.createImpact(locator, size, at ? from.clone().sub(at) : undefined, lifeTime);
  };
  /**
   * The defensive modules' impact animations under way (effects.ImpactEffect: Start and each Repeat set the animation
   * on for the cycle's length, Stop sets it off): by the module, its ship, its name, the cycle and when it next repeats.
   */
  private readonly impactAnimations = new Map<string, { ship: number; name: string; cycle: number; next: number; until: number }>();
  /** How many space objects the LOD quality's visibility threshold left undrawn this frame (for checks). */
  lodCulled = 0;
  /**
   * A named object under a model, looked up once and kept (again every 30 frames, and at once when the turrets are
   * refitted): getObjectByName walks the whole tree, and a station's has thousands of nodes - every frame, for every
   * ball, it cost 0.8 ms of the frame at Jita IV-4.
   */
  private readonly namedCache = new WeakMap<THREE.Object3D, { at: number; found: Map<string, THREE.Object3D | undefined> }>();
  private named(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
    let c = this.namedCache.get(root);
    if (!c || this.frameCount - c.at >= 30) { c = { at: this.frameCount, found: new Map() }; this.namedCache.set(root, c); }
    if (!c.found.has(name)) c.found.set(name, root.getObjectByName(name));
    const o = c.found.get(name);
    // (one taken out of the tree since: looked for again)
    if (o && !o.parent) { c.found.delete(name); return this.named(root, name); }
    return o;
  }
  /** How many space objects were out of the view's frustum this frame (for checks). */
  frustumCulled = 0;
  /** Each model's bounding sphere with its children, in its mark's frame (looked for again every 120 frames: children load late). */
  private readonly modelBounds = new WeakMap<THREE.Object3D, { centre: THREE.Vector3; radius: number; at: number }>();
  /** A model's bounding sphere with children, in the world now (at least its ball's radius about the ball). */
  private boundsOf(model: THREE.Object3D, mark: THREE.Object3D, ballRadius: number): THREE.Sphere {
    let b = this.modelBounds.get(model);
    if (!b || this.frameCount - b.at >= 120) {
      const was = model.visible;
      model.visible = true;
      mark.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      model.visible = was;
      const sphere = box.isEmpty() ? new THREE.Sphere(mark.position.clone(), 0) : box.getBoundingSphere(new THREE.Sphere());
      b = { centre: mark.worldToLocal(sphere.center.clone()), radius: sphere.radius / Math.max(1e-6, Math.abs(mark.getWorldScale(new THREE.Vector3()).x)), at: this.frameCount };
      this.modelBounds.set(model, b);
    }
    const centre = mark.localToWorld(b.centre.clone());
    const r = Math.max(b.radius * Math.abs(mark.getWorldScale(new THREE.Vector3()).x), ballRadius);
    return new THREE.Sphere(b.radius >= ballRadius ? centre : mark.getWorldPosition(new THREE.Vector3()), r);
  }
  /** How many drawn objects' boosters the low detail threshold left undrawn this frame (for checks). */
  lodBoostersHidden = 0;
  /** How many drawn objects' boosters were given their far effect this frame (for checks). */
  lodBoostersFar = 0;
  /** How many child meshes their minScreenSize left undrawn this frame (for checks). */
  lodChildMeshesHidden = 0;
  /**
   * EveChildMesh::UpdateVisibility for an object's size-gated child meshes (hullChildren): each drawn only where its
   * parent's LOD is at least its lowestLodVisible and its sphere's size across (GetPixelSizeAccross: radius / depth x
   * P[0][0] x width; the eye inside it: no limit) / the LOD factor is at least its minScreenSize. The list looked for
   * again every `refresh` frames (children load late; effects come and go). Returns how many it hid.
   */
  private gateChildMeshes(root: THREE.Object3D, parentLod: number, eye: THREE.Vector3, ahead: THREE.Vector3, across: number, lodFactor: number, refresh: number): number {
    let entry = this.sizeGated.get(root);
    if (!entry || this.frameCount - entry.at >= refresh) {
      const list: THREE.Object3D[] = [];
      root.traverse((o) => { if (o.name === "size-gated") list.push(o); });
      entry = { list, at: this.frameCount };
      this.sizeGated.set(root, entry);
    }
    let hidden = 0;
    const centre = new THREE.Vector3(), scale = new THREE.Vector3();
    for (const o of entry.list) {
      const sp = o.userData.sphere as number[];
      o.localToWorld(centre.set(sp[0]!, sp[1]!, sp[2]!));
      // (a mirrored parent gives a negative scale: its size the same)
      const r = sp[3]! * Math.abs(o.getWorldScale(scale).x);
      const rel = centre.sub(eye);
      const size = rel.lengthSq() < r * r ? Infinity : (r / Math.max(1e-5, rel.dot(ahead))) * across;
      const on = parentLod >= ((o.userData.lowestLod as number | undefined) ?? 0) && size / lodFactor >= (o.userData.minScreenSize as number);
      if (!on) hidden++;
      if (o.visible !== on) o.visible = on;
    }
    return hidden;
  }
  /** Each model's child meshes with a minScreenSize (found once its children are built). */
  private readonly sizeGated = new WeakMap<THREE.Object3D, { list: THREE.Object3D[]; at: number }>();
  /** The effects whose sounds are under way, by emitter (OnSpecialFX's guid, ship and module). */
  private readonly fxEmitters = new Set<string>();
  private readonly hearFx = (name: string, args: readonly unknown[]) => {
    if (name === "OnSlimItemChange") {
      const id = Number(args[0]);
      const mark = this.wormholeAudio.has(id) ? this.marks.get(id) : undefined;
      if (mark?.children.length) updateWormholePose(mark, this.live.park.slimItems.get(id), mark.userData.ordinaryWormhole === true);
    }
    this.turretFx.hear(name, args);
    this.shipFx.hear(name, args);
    if (name === "TerminalPlayDestructionEffect") {
      const mark = this.marks.get(Number(args[0]));
      // An unspecified terminal effect defaults to EXPLOSION. Release also calls Explode for EXPLOSION_OVERRIDE.
      const effect = Number(args[1] ?? 3);
      if (effect === 2) this.targetBar.markMiningDepleted(Number(args[0]));
      if (mark?.userData.ordinaryWormhole && (effect === 3 || effect === 1)) mark.userData.wormholeTerminal = this.live.resets;
    }
    // a ball blown up (TerminalPlayDestructionEffect -> spaceObject.Explode): with Ship Explosions on, one of its type's
    // explosion bucket's explosions' sounds, where it was
    if (name === "TerminalPlayDestructionEffect" && gfx().explosionEffectsEnabled) {
      const id = Number(args[0]);
      const entity = this.snapshot?.entities.find((e) => e.itemID === id);
      const typeID = entity?.typeID ?? this.typeOfID.get(id) ?? null;
      if (typeID === DRIFTER_COLLECTION && Number(args[args.length - 1]) === 3) {
        const gone = this.gone.get(id);
        const position = entity?.position ?? (gone && { x: gone.x, y: gone.y, z: -gone.z });
        if (position) {
          const start = this.collectionExplosions.queue(id, position, this.live.simNow());
          if (entity && this.lookAt === id && gfx().dynamicCameraMovement && !this.gateJump) {
            this.beginExplosionCamera(entity, start);
          }
        }
      } else if (typeID) void explosionSoundsOf().then((table) => {
        for (const s of pickExplosion(table, typeID)) {
          window.setTimeout(() => {
            const at = this.placeOf(id, this.lastOrigin);
            if (at) void playWorldEvent(s.event, at, s.scale);
          }, s.time * 1000);
        }
      });
    }
    // an effect started (OnSpecialFX's start flag): its graphic's sounds, at the ship or the target, kept under the
    // effect's emitter (its guid, ship and module); stopped (the flag 0): the effect's emitter goes, and its sounds with
    // it - a looping one (a tracking computer's) would sound on for ever
    if (name === "OnSpecialFX") {
      const guids = fxGuid(args[5]).split(",").map((g) => g.trim()).filter(Boolean);
      const ship = Number(args[0]), target = Number(args[3]);
      const start = Number(args[7]) === 1;
      if (start && guids.includes("effects.WormholeActivity")) {
        const mark = this.marks.get(ship);
        if (mark?.userData.ordinaryWormhole) playWormholeActivity(mark, Number(mark.userData.wormholeTypeID));
      }
      const ownShip = this.live.hello?.shipID ?? null;
      if (!this.gateJump && start && ship === ownShip && target > 0 && guids.includes("effects.JumpOutWormhole")) {
        this.beginJumpCamera(target);
      } else if (!this.gateJump && isOwnStargateDeparture(guids, ship, start, ownShip)) this.beginJumpCamera();
      const emitterOf = (g: string) => `fx:${g}:${ship}:${String(args[1])}`;
      if (!start) {
        for (const g of guids) { this.fxEmitters.delete(emitterOf(g)); stopEmitter(emitterOf(g)); }
      } else {
        for (const g of guids) this.fxEmitters.add(emitterOf(g));
        void fxSoundsOf().then((table) => {
          for (const g of guids) for (const s of table[g] ?? []) {
            const id = s.at === "target" ? target : ship;
            if (!Number.isFinite(id) || id <= 0) continue;
            window.setTimeout(() => {
              // (an effect stopped before its key's time sounds no more)
              if (!this.fxEmitters.has(emitterOf(g))) return;
              const at = this.placeOf(id, this.lastOrigin);
              // the effect's emitter scaled as its class scales it, by the ball it sounds at (effectAudioScale)
              const radius = this.snapshot?.entities.find((e) => e.itemID === id)?.radius ?? null;
              if (at) void effectAudioScale(g, radius).then((scale) => playWorldEvent(s.event, at, scale, emitterOf(g)));
            }, s.time * 1000);
          }
        });
      }
    }
    if (name === "OnWormholeJumpCancel" && this.gateJump?.wormhole && this.gateJump.arrivedAt === null) {
      this.gateJump.arrivedAt = performance.now();
    }
    if (name === "OnSpecialFX") {
      const anim = IMPACT_ANIMATIONS[fxGuid(args[5])];
      if (anim) {
        const ship = Number(args[0]), key = `${ship}:${Number(args[1])}`;
        // GenericEffect: the trigger's duration, else the effect's 10 s
        const duration = Number(args[9]) > 0 ? Number(args[9]) : 10_000, repeat = Number(args[10]);
        const impact = this.marks.get(ship)?.userData.impact as ImpactOverlay | undefined;
        if (Number(args[7]) === 1) {
          impact?.setImpactAnimation(anim, true, duration / 1000);
          const now = performance.now();
          this.impactAnimations.set(key, { ship, name: anim, cycle: duration, next: now + duration, until: now + duration * Math.max(1, Number.isFinite(repeat) && repeat > 0 ? Math.min(repeat, 1000) : 1) });
        } else {
          const a = this.impactAnimations.get(key);
          if (a) impact?.setImpactAnimation(a.name, false, a.cycle / 1000);
          this.impactAnimations.delete(key);
        }
      }
    }
    // OnClientControllerEvent(ballID, targetID, eventName, value): to the ball's model (spaceMgr.OnClientControllerEvent
    // -> spaceObject.SetControllerVariableFromEvent: Activated sets IsTriggered to the value; any other is an event)
    if (name === "OnClientControllerEvent") {
      const [ballID, , rawName, value] = args as [unknown, unknown, unknown, unknown];
      const mark = this.marks.get(Number(ballID));
      // the name comes as the wire decoded it: a string, or a marshal buffer (as a gate's Departure does)
      const eventName = rawName === null || rawName === undefined ? "" : fxGuid(rawName);
      if (!mark || !eventName) return;
      if (eventName === "Activated") setControllerVariable(mark, "IsTriggered", Number(value ?? 0));
      else sendControllerEvent(mark, eventName);
    }
  };
  /**
   * The gate jump, drawn in our own way where the client plays its gate effect (SpaceToSpaceTransition: no fade, the
   * destination's scene swapped in during the effect): the tunnel builds from the pilot's JumpOut effect, flashes
   * as the new system's park comes (the feed's reset), and eases out.
   */
  private gateJump: {
    orderedAt: number;
    arrivedAt: number | null;
    origin: THREE.Vector3 | null;
    returning: { startedAt: number; target: THREE.Vector3 } | null;
    returned: boolean;
    wormhole: { endpoint: number; oldFov: number; aimFrom: THREE.Vector3; stopSimAt: number | null } | null;
  } | null = null;
  private seenResets = 0;
  private seenSystem: number | null = null;
  private readonly flashEl = document.createElement("div");
  private readonly radial = new RadialMenu();
  private readonly contextMenu = new ContextMenu();
  /** Where the view's windows go (SpaceViewOptions.windowLayer). */
  private get layer(): HTMLElement { return this.options.windowLayer?.element ?? this.root; }
  private raiseOnClick(el: HTMLElement): void {
    const raise = this.options.windowLayer?.raise;
    if (raise) el.addEventListener("pointerdown", () => raise(el), true);
  }
  private dscan: DScanWindow | null = null;
  private dscanKey: { code: string; targeted: boolean } | null = null;
  private systemMap: SolarSystemMapWindow | null = null;
  /**
   * A thing's name as the client gives it (uix.GetSlimItemName): its own name where it has one (a pilot's, a
   * station's, a celestial's), else its type's (an NPC hull, a wreck, a container, an asteroid).
   */
  /**
   * uix.GetSlimItemName (424 to 449): a ship or an NPC by its slim's name (its pilot's, else its type's), an asteroid
   * or a harvestable cloud by its type, anything else by its cfg.evelocations name where that is known and not a
   * label ('@'), else its type's. Celestials, stations and stargates carry no name in their slim item.
   */
  private nameOf(e: Entity): string {
    const typeName = e.typeID !== null ? this.names?.types[String(e.typeID)]?.[0] ?? null : null;
    if (e.categoryID === 6 || e.isNpc || e.kind === "ship") return e.name ?? typeName ?? e.kind;
    if (e.categoryID === 25 || e.groupID === 711) return typeName ?? e.name ?? e.kind;
    const located = this.actions.locationName?.(e.itemID) ?? null;
    // eveCfg._GetCelestialNameDataFromLocalRow: a stargate is named by UI/Locations/LocationStargateFormatter,
    // "{[location]destinationSystemID.rawName}" - its destination alone (the server's row says "Stargate (X)").
    if (located && e.groupID === 10) return /^Stargate \((.+)\)$/.exec(located)?.[1] ?? located;
    if (located && located[0] !== "@") return located;
    return e.name ?? typeName ?? e.kind;
  }
  /** The ship whose holds the cargo indicator last asked for. */
  private holdsReadFor: number | null = null;
  /** The items whose cfg.evelocations rows have been asked for (cfg.evelocations.Prime, once each). */
  private readonly locationsPrimed = new Set<number>();
  /** The park's celestials, stations, gates and named items primed in cfg.evelocations, as the client's brackets
   * and overview get their names (GetSlimItemName's cfg.evelocations.Get). */
  private primeEntityLocations(entities: readonly Entity[]): void {
    const wanted: number[] = [];
    for (const e of entities) {
      if (e.categoryID === 6 || e.categoryID === 25 || e.isNpc || e.kind === "ship" || this.locationsPrimed.has(e.itemID)) continue;
      this.locationsPrimed.add(e.itemID);
      wanted.push(e.itemID);
    }
    if (wanted.length > 0) this.actions.primeLocations?.(wanted);
  }
  private names: { types: Record<string, [string | null, number | null]>; groups: Record<string, [string | null, number | null]> } | null = null;
  /** A thing in the park named as the client names it (GetSlimItemName), or null where the park has it not. */
  itemName(itemID: number): string | null {
    const e = this.snapshot?.entities.find((x) => x.itemID === itemID);
    return e ? this.nameOf(e) : null;
  }
  /** Corporation tickers known (null: the corporation has none), and those being asked. */
  private readonly tickers = new Map<number, string | null>();
  private readonly tickersAsked = new Set<number>();
  /**
   * targetInBar.SetTargetLabel: its name (GetSlimItemName), with its corporation's ticker where its slim item has one
   * (UI/Inflight/Target/TargetLabelWithTicker "{target} [{ticker}]"); the ticker asked for once, the plain name until.
   */
  private targetLabelOf(e: Entity): string {
    const name = this.nameOf(e);
    const corp = e.corporationID ?? null;
    if (!corp) return name;
    if (!this.tickers.has(corp) && !this.tickersAsked.has(corp) && this.options.corpTickers) {
      this.tickersAsked.add(corp);
      void this.options.corpTickers([corp]).then((t) => { this.tickers.set(corp, t[String(corp)] ?? null); }).catch(() => {});
    }
    const ticker = this.tickers.get(corp);
    return ticker ? `${name} [${ticker}]` : name;
  }
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  /** CombatKeyUnloadListener: the loaded combat command let go when its key comes up, or the window loses focus. */
  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (this.options.covered?.()) { this.onBlur(); return; }
    if (this.combat && e.code === this.combat.code) this.unloadCombat();
    if (this.dscanKey?.code !== e.code) return;
    const { targeted } = this.dscanKey;
    this.dscanKey = null;
    if (!targeted) void this.dscan?.scan();
  };
  private readonly onBlur = () => { this.unloadCombat(); this.dscanKey = null; };
  /** The modifiers held at the last press of a pointer (a modifier-only combat command is a click with them). */
  private readonly onPointer = (e: PointerEvent) => {
    if (this.options.covered?.()) { this.onBlur(); return; }
    this.clickMods = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, at: performance.now() };
    this.systemMap?.setActive(this.systemMap.window.root.contains(e.target as Node));
  };
  private clickMods = { ctrl: false, shift: false, alt: false, at: 0 };
  /** The combat command loaded (LoadCombatCommand): its name and the key that holds it. */
  private combat: { cmd: CombatCommand; code: string } | null = null;
  /** bracketSettings' display override (bracketConst SHOW_DEFAULT / SHOW_NONE / SHOW_ALL): Alt+Z, Alt+Shift+Z. */
  private bracketOverride: BracketOverride = "default";
  private showSpecialBrackets = false;
  /** Warp.py's sound flags for the ship's own warp: the explosion played (hasExploded), the wind playing (hasWind). */
  private warpSound = { exploded: false, wind: false };
  private shortcutIndication: { header: string; sub: string } | null = null;
  private temporaryIndication: { header: string; sub: string; until: number } | null = null;
  private readonly modeHeader = document.createElement("div");
  private readonly modeSub = document.createElement("div");
  private readonly modeProgress = document.createElement("div");
  private readonly modeProgressFill = document.createElement("div");
  private readonly alertVignette = document.createElement("div");
  private alertShipID: number | null = null;
  private alertState = initialShipAlertState();
  private alertSettings = healthNotificationSettings.get();
  private alertVignetteFlash: Animation | null = null;
  private nextDamageFlash = 0;
  private nextCapFlash = 0;
  private readonly unhold: (() => void)[] = [];
  private lastFrameAt = performance.now();

  /** `onNeocom`: what a Neocom button opens; the app's play mode opens its own windows (PlayApp.svelte). */
  constructor(private readonly live: LivePark, private actions: SpaceActions, private readonly where: { system: string; security: number | null }, private readonly options: SpaceViewOptions = {}) {
    this.root.className = "space";
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.root.appendChild(this.renderer.domElement);
    this.brackets.className = "brackets";
    this.miningHoldBracket.type = "button";
    this.miningHoldBracket.className = "mining-hold-bracket";
    this.miningHoldBracket.hidden = true;
    this.miningHoldBracket.addEventListener("pointerdown", event => event.stopPropagation());
    this.miningHoldBracket.addEventListener("click", event => {
      event.stopPropagation();
      this.options.onNeocom?.("inventory");
    });
    this.brackets.appendChild(this.miningHoldBracket);
    this.root.appendChild(this.brackets);
    this.targetingCursor.className = "targeting-cursor";
    this.targetingCursor.hidden = true;
    this.targetingCursor.setAttribute("aria-hidden", "true");
    this.root.appendChild(this.targetingCursor);
    const moveTargetingCursor = (e: PointerEvent) => {
      this.targetingCursor.style.setProperty("--x", `${e.clientX}px`);
      this.targetingCursor.style.setProperty("--y", `${e.clientY}px`);
    };
    document.addEventListener("pointermove", moveTargetingCursor);
    this.unhold.push(() => document.removeEventListener("pointermove", moveTargetingCursor));
    this.root.insertAdjacentHTML("beforeend", `
      <div class="hud-top-left"><div class="system">${where.system}<span class="sec">${where.security === null ? "" : where.security.toFixed(1)}</span></div><div class="sub"></div></div>
      <div class="ship-mode"></div>
      <div class="toast"></div>
      <div class="feed-status"></div>`);
    this.flashEl.className = "jump-flash";
    this.root.appendChild(this.flashEl);
    this.seenResets = live.resets;
    this.seenSystem = live.hello?.solarSystemID ?? null;
    this.actions = actions;
    this.modeEl = this.root.querySelector(".ship-mode")!;
    this.root.insertBefore(this.shipHud.root, this.modeEl);
    this.shipHud.onStop = () => void this.stopShip();
    this.shipHud.onFullSpeed = () => void this.fullSpeed();
    if (this.shipHud instanceof NewShipHud) {
      this.shipHud.onSetSpeed = (ratio) => void this.setSpeedRatio(ratio);
      this.shipHud.onOpenHold = (key) => this.actions.openShipHold?.(key);
      this.shipHud.tooltipRows = (m) => this.options.rack?.tooltip?.(m) ?? null;
      this.root.classList.add("new-hud-on");
      // _AlignToScreenEdge: the indication goes to the top with the band
      this.offHudTop = hudSetting("shipuialigntop").subscribe((top) => this.root.classList.toggle("new-hud-top", top));
      const hudWords = this.options.indicationWords;
      this.shipHud.word = (label) => { const t = hudWords?.()[label]; return typeof t === "string" && t !== "" ? plainText(t) : null; };
      this.shipHud.wordWith = (label, args) => { const t = hudWords?.()[label]; return typeof t === "string" && t !== "" ? plainText(formatTemplate(t, args as never, { nameOf: () => null } as never)) : null; };
      // the HUD's command buttons: the directional scanner and solar system map are this view's, the rest the page's
      this.shipHud.onCommand = (cmd) => {
        if (cmd === "OpenDirectionalScanner" && this.dscan) this.dscan.toggle();
        else if (cmd === "CmdToggleSolarSystemMap" && this.systemMap) this.systemMap.toggle();
        else this.actions.runCommand?.(cmd);
      };
    }
    this.modeHeader.className = "ship-mode-header";
    this.modeSub.className = "ship-mode-detail";
    this.modeProgress.className = "ship-mode-progress";
    this.modeProgress.append(this.modeProgressFill);
    this.modeEl.append(this.modeHeader, this.modeSub, this.modeProgress);
    this.alertVignette.className = "ship-hud-vignette";
    this.alertVignette.setAttribute("aria-hidden", "true");
    this.root.append(this.alertVignette);
    // (as the eve-cs mirror has it: always on screen, 464 x 135 at the top right, its icon the client's show-info one,
    // "No object selected" while nothing is)
    this.selectedWin = new PlayWindow({ id: "selected-item", caption: "Selected Item", icon: clientTexture("res:/UI/Texture/eveicon/control_icons/show_info_32px.png"), left: innerWidth - 480, top: 15, width: 464, height: 135, closable: false });
    this.selectedWin.body.classList.add("si");
    this.selectedEl = this.selectedWin.root;
    this.root.insertBefore(this.targetBar.root, this.modeEl);
    this.targetBar.onSelect = (id) => this.select(id);
    this.targetBar.onUnlock = (id) => void this.act("Unlock Target", () => this.actions.unlock(id)).then(() => this.refreshTargets());
    this.selectedEl.classList.add("space-only-window");
    this.layer.appendChild(this.selectedEl);
    this.pollTargets();
    this.feedEl = this.root.querySelector(".feed-status")!;
    this.toastEl = this.root.querySelector(".toast")!;

    this.scene.background = new THREE.Color(0x020305);
    this.starfieldObj = this.starfield();
    this.scene.add(this.starfieldObj);
    this.scene.add(new THREE.AmbientLight(0x334455, 0.6));
    // The system's star lights the grid from where it is (aimed each frame at the sun ball, frame()).
    this.sunLight.position.copy(this.sunDir);
    this.scene.add(this.sunLight, this.sunLight.target);
    // SpaceShadowAtlas uses the renderer's depth draws for the sun's cascades.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.add(this.warpTunnel.object, this.turretFx.group, this.missileFx.group, this.shipFx.group);
    this.scene.add(this.miningSurvey.group);
    live.fxListeners.add(this.hearFx);
    this.camera.position.set(-600, 250, 900);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.minDistance = 30;
    this.controls.maxDistance = 1e6;
    this.controls.zoomSpeed = 1.2;
    this.controls.addEventListener("start", () => {
      this.undockCam = null;
      this.trackedObjective = null;
      this.stopEntryCamera();
    });
    if (options.recordCameraTask) this.trackCameraTasks(options.recordCameraTask);
    void options.entryWarpHistory?.then(hasWarped => { this.entryWarped = hasWarped ?? true; });
    this.overview = new Overview({
      select: (id) => this.select(id),
      activate: (id) => this.activateSpaceTarget(id),
      glyph,
      name: (e) => this.nameOf(e),
      pilotID: options.overviewPilotID,
      word: (label) => this.actions.word?.(label) ?? null,
      notice: options.overviewNotice,
    });
    this.overview.window.root.classList.add("space-only-window");
    this.layer.appendChild(this.overview.window.root);
    // The radial menu: held or right-clicked on a bracket, an overview row or an object in space.
    if (!document.getElementById("radial-css")) {
      const style = document.createElement("style");
      style.id = "radial-css";
      style.textContent = RADIAL_CSS;
      document.head.appendChild(style);
    }
    this.radial.root.classList.add("space-only-window");
    this.layer.appendChild(this.radial.root);
    this.radial.root.style.zIndex = "100000";
    for (const el of [this.selectedEl, this.overview.window.root]) this.raiseOnClick(el);
    // a held left button opens the radial menu; a right-click the context menu (menusvc's, as the client's right-click)
    const openRadial = (id: number, x: number, y: number, button: number) => (button === 2 ? this.openContext(id, x, y) : this.openRadial(id, x, y, button));
    const rowID = (_x: number, _y: number, e: Event) => Number((e.target as HTMLElement).closest?.("[data-id]")?.getAttribute("data-id")) || null;
    // The solar system map (CmdToggleSolarSystemMap, F9; the directional scanner's map button), over the park's celestials.
    this.systemMap = new SolarSystemMapWindow({
      celestials: () => (this.snapshot?.entities ?? []).filter((e) => e.groupID !== null && (MARKER_GROUPS.has(e.groupID))),
      ego: () => this.snapshot?.ship?.position ?? null,
      word: (label) => this.actions.word?.(label) ?? null,
      markerName: (itemID) => {
        const entity = this.snapshot?.entities.find((each) => each.itemID === itemID);
        return this.actions.locationName?.(itemID) ?? (entity ? this.nameOf(entity) : "");
      },
      // GetLabelText: GetDisplayText - the location's own name (cfg.evelocations), the type's until it is known - and
      // FmtDist of its distance
      label: (itemID) => {
        const e = this.snapshot?.entities.find((each) => each.itemID === itemID);
        return e ? `${this.actions.locationName?.(itemID) ?? this.nameOf(e)} ${distanceWords(this.distanceTo(e))}` : "";
      },
      primeNames: (itemIDs) => this.actions.primeLocations?.(itemIDs),
      // the probes' places from the park where it has them (live), the scanner's read otherwise
      probes: () => (this.actions.probes?.() ?? []).map((p) => {
        const ball = this.snapshot?.entities.find((e) => e.itemID === p.probeID);
        return ball ? { ...p, pos: [ball.position.x, ball.position.y, ball.position.z] as const } : p;
      }),
      probeLabel: (probeID, distance) => {
        const probeIndex = probeNumber(probeID);
        const name = this.actions.word?.("UI/Inflight/Scanner/ProbeLabel", { probeIndex }) ?? `Probe ${probeIndex}`;
        return distance === null ? name : `${name} ${distanceWords(distance)}`;
      },
      moveProbes: (moves) => this.actions.moveProbes?.(moves),
      scanResults: () => this.actions.scanResults?.() ?? [],
      selectedSites: () => this.actions.selectedSites?.() ?? new Set(),
      selectSite: (siteID, multiSelect) => this.actions.selectSite?.(siteID, multiSelect),
      resultLabel: (siteID) => this.actions.resultLabel?.(siteID) ?? siteID,
      resultMenu: (siteID) => this.actions.resultMenu?.(siteID) ?? [],
      // AlignSpaceCameraToViewVector: the space camera put behind the ship along the direction, at its distance
      aimSpaceCamera: (direction) => this.aimSpaceCamera(direction),
      hologramTypes: this.actions.dscanHologramTypes,
      scanShortcutHeld: () => this.dscanKey !== null,
      scanTowards: (position) => this.scanTowards(position),
      selectCelestial: () => this.dscan?.setCameraMode(false),
      // the scan's shape: the d-scan window's angle and range, the way the space camera looks (GetScanDirection)
      dscanCone: () => {
        if (!this.dscan?.isOpen) return null;
        const state = this.dscan.coneState();
        const d = this.camera.getWorldDirection(new THREE.Vector3());
        return { ...state, direction: { x: d.x, y: d.y, z: -d.z } };
      },
    }, this.layer);
    this.systemMap.window.root.classList.add("space-only-window");
    this.layer.appendChild(this.systemMap.window.root);
    this.raiseOnClick(this.systemMap.window.root);
    // The directional scanner (Alt+D, V), where the page can make the call.
    void typeNames().then((n) => { this.names = n; });
    if (this.actions.coneScan) {
      const coneScan = this.actions.coneScan.bind(this.actions);
      this.dscan = new DScanWindow({
        scan: (angle, range, [x, y, z]) => coneScan(angle, range, x, y, z),
        direction: () => { const d = this.camera.getWorldDirection(new THREE.Vector3()); return [d.x, d.y, -d.z]; },
        known: (id) => {
          const e = this.snapshot?.entities.find((each) => each.itemID === id) ?? null;
          return { name: e?.name ?? null, distance: e ? this.distanceTo(e) : null };
        },
        typeName: (typeID) => this.names?.types[String(typeID)]?.[0] ?? null,
        groupName: (groupID) => this.names?.groups[String(groupID)]?.[0] ?? null,
        word: (label, args) => this.actions.word?.(label, args) ?? null,
        activePreset: () => this.overview?.activePreset() ?? null,
        presets: () => this.overview?.presetList() ?? [],
        maxRangeMetres: () => this.actions.shipAttribute?.(5796) ?? null,
        openMap: () => this.systemMap?.toggle(),
        scanStarted: () => this.systemMap?.scanStarted(),
        scanned: (result) => this.systemMap?.scanEffect(result),
        hoverResult: (typeID) => this.systemMap?.hoverScanResult(typeID),
      }, this.layer);
      this.dscan.window.root.classList.add("space-only-window");
      this.layer.appendChild(this.dscan.window.root);
      this.raiseOnClick(this.dscan.window.root);
    }
    addEventListener("keydown", this.onKey);
    addEventListener("keyup", this.onKeyUp);
    addEventListener("blur", this.onBlur);
    addEventListener("pointerdown", this.onPointer, true);
    this.unhold.push(
      holdToOpen(this.brackets, rowID, openRadial),
      holdToOpen(this.overview.window.body, rowID, openRadial),
      holdToOpen(this.renderer.domElement, (x, y) => this.pickAt(x, y), openRadial),
    );
    // Brackets drawn before the client's tables are here are drawn again with the client's icons.
    void loadBrackets().then(() => { for (const el of this.bracketEls.values()) el.remove(); this.bracketEls.clear(); });
    this.root.appendChild(new Neocom((id) => (this.options.onNeocom ? this.options.onNeocom(id) : this.toast(`${id[0]!.toUpperCase()}${id.slice(1)} is not on the play page yet.`))).root);
    this.renderer.domElement.addEventListener("dblclick", (e) => this.doubleClick(e));
    // ExplosionCameraController yields to the primary camera on a left release,
    // left drag, or wheel input over the scene.
    this.renderer.domElement.addEventListener("pointerup", e => {
      if (e.button === 0) this.endExplosionCamera();
    });
    this.renderer.domElement.addEventListener("pointermove", e => {
      if (e.buttons & 1) this.endExplosionCamera();
    });
    this.renderer.domElement.addEventListener("wheel", e => {
      if (this.endExplosionCamera()) e.stopImmediatePropagation();
    }, { capture: true, passive: true });
    // a click in space: with a combat command loaded, on the object under it (its pick); else the selection cleared
    this.renderer.domElement.addEventListener("click", (e) => {
      const picking = this.dscanKey || this.combat || this.modifierCombat(false) || !this.targetingCursor.hidden;
      const id = picking ? this.pickAt(e.clientX, e.clientY) : null;
      this.select(id);
    });
    addEventListener("resize", () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** The new HUD's top alignment followed (the indication moves with the band). */
  private offHudTop: (() => void) | null = null;

  dispose(): void {
    this.offHudTop?.();
    for (const panel of this.jumpBridgePanels.values()) panel.destroy();
    this.jumpBridgePanels.clear();
    // the ambient sound let go with the view (the ship docked, the session gone)
    void this.ambient?.loop?.then((l) => l.stop());
    this.ambient = null;
    for (const audio of this.wormholeAudio.values()) audio.dispose();
    this.wormholeAudio.clear();
    this.clearWormholeCollapses();
    for (const mark of this.marks.values()) {
      (mark.userData.vortex as ObservatoryVortex | undefined)?.dispose();
      hideMetenoxBeam(mark);
    }
    this.stopped = true;
    this.renderer.setAnimationLoop(null);
    this.spaceShadows.dispose();
    this.reflectionProbe?.dispose();
    this.sceneEnv?.dispose();
    this.bloom?.dispose();
    this.exposure.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.shipHud.dispose();
    this.alertVignetteFlash?.cancel();
    this.targetBar.dispose();
    this.warpTunnel.dispose();
    this.wormholeTransit.dispose();
    this.live.fxListeners.delete(this.hearFx);
    this.turretFx.dispose();
    this.miningSurvey.dispose();
    this.asteroidModels.dispose();
    this.collectionExplosions.clear();
    this.combatMessage.dispose();
    this.systemMap?.dispose();
    for (const off of this.unhold) off();
    // the windows in the shared layer are the view's to take away
    for (const el of [this.selectedEl, this.overview.window.root, this.dscan?.window.root, this.radial.root]) el?.remove();
    removeEventListener("keydown", this.onKey);
    removeEventListener("keyup", this.onKeyUp);
    removeEventListener("blur", this.onBlur);
    removeEventListener("pointerdown", this.onPointer, true);
    this.radial.close();
    this.root.remove();
  }

  private trackCameraTasks(record: (event: CameraTaskEvent) => void): void {
    const canvas = this.renderer.domElement;
    const gestures = new CameraTaskGestures(record);
    const input = new AbortController();
    const listener = { signal: input.signal };
    const active = () => this.controls.enabled && !!this.snapshot?.ship;
    canvas.addEventListener("pointerdown", event => {
      if (event.isTrusted && event.pointerType === "mouse" && event.button === 0 && active()) {
        gestures.beginOrbit(this.controls.getAzimuthalAngle());
      }
    }, listener);
    const release = (event: PointerEvent) => {
      if ((event.buttons & 1) === 0 || event.type === "pointercancel") gestures.endOrbit();
    };
    canvas.ownerDocument.addEventListener("pointerup", release, listener);
    canvas.ownerDocument.addEventListener("pointercancel", release, listener);
    window.addEventListener("blur", () => gestures.endOrbit(), listener);
    const cameraChanged = () => {
      if (active()) gestures.moveOrbit(this.controls.getAzimuthalAngle());
      else gestures.endOrbit();
    };
    this.controls.addEventListener("change", cameraChanged);
    canvas.addEventListener("wheel", event => {
      if (event.isTrusted && active() && this.controls.enableZoom) gestures.zoom(event.deltaY);
    }, { ...listener, passive: true });
    this.unhold.push(() => {
      input.abort();
      this.controls.removeEventListener("change", cameraChanged);
    });
  }

  /**
   * CmdSetShipFullSpeed: a stopped ship starts along its own heading; a ship in motion keeps the current order.
   */
  private async fullSpeed(): Promise<void> {
    const ego = this.snapshot?.ship;
    if (!ego) return;
    await this.act("Full speed", async () => {
      if (ego.mode === "STOP") {
        const holder = this.marks.get(ego.itemID);
        if (!holder) return;
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(holder.quaternion);
        await this.actions.gotoDirection(f.x, f.y, -f.z);
      }
      await this.actions.setSpeedFraction(1);
      const speed = ego.maxVelocity;
      this.showTemporaryIndication(
        this.actions.word?.("UI/Inflight/Messages/ShipFullSpeedHeader") ?? "Full speed",
        speed === null ? "" : this.actions.word?.("UI/Commands/SpeedChangedTo", { speed: speed >= 100 ? Math.trunc(speed) : speed }) ?? `${Math.round(speed)} m/s`,
      );
    });
  }

  /**
   * activeShipController.SetSpeed (the new HUD's speedometer): 0 stops the ship; else a stopped ship starts along its
   * heading (CmdGotoDirection) and the fraction is set (CmdSetSpeedFraction), "Speed changed to {speed}" said.
   */
  private async setSpeedRatio(ratio: number): Promise<void> {
    const ego = this.snapshot?.ship;
    if (!ego || ego.mode === "WARP") return;
    if (ratio <= 0) { await this.stopShip(); return; }
    await this.act("Set speed", async () => {
      if (ego.mode === "STOP") {
        const holder = this.marks.get(ego.itemID);
        if (holder) {
          const f = new THREE.Vector3(0, 0, 1).applyQuaternion(holder.quaternion);
          await this.actions.gotoDirection(f.x, f.y, -f.z);
        }
      }
      await this.actions.setSpeedFraction(Math.min(1, ratio));
      const speed = ego.maxVelocity === null ? null : ego.maxVelocity * Math.min(1, ratio);
      if (speed !== null) this.showTemporaryIndication(this.actions.word?.("UI/Commands/SpeedChangedTo", { speed: speed >= 100 ? Math.trunc(speed) : Math.round(speed * 10) / 10 }) ?? `${Math.round(speed)} m/s`);
    });
  }

  private async stopShip(): Promise<void> {
    await this.act("Stop", async () => {
      await this.actions.stop();
      this.showTemporaryIndication(shipStoppingText(this.options.indicationWords?.() ?? {}));
    });
  }

  private showTemporaryIndication(header: string, sub = ""): void {
    this.temporaryIndication = { header, sub, until: performance.now() + SHIP_STOPPING_MS };
    void playUiEvent("ui_radial_select_play");
  }

  private updateIndication(snapshot: Snapshot | null, now: number): void {
    if (this.temporaryIndication && now >= this.temporaryIndication.until) this.temporaryIndication = null;
    // The park gives the current mode. Only use the session's navigation details for that same manoeuvre.
    const live = snapshot as SpaceSnapshot | null;
    const reported = this.options.flightSnapshot?.() ?? null;
    const ship = live?.ship;
    const details = reported?.ship;
    const flight = live && ship && details && ship.itemID === details.itemID && ship.mode === details.mode && (details.alignTarget || details.warp)
      ? { ...live, ship: { ...ship, alignTarget: ship.alignTarget ?? details.alignTarget, warp: ship.warp ?? details.warp } }
      : live;
    let text = this.shortcutIndication ?? this.temporaryIndication;
    if (!text) {
      const words = this.options.indicationWords?.() ?? {};
      const indication = shipIndication(flight);
      const name = (id: number | null) => {
        const entity = snapshot?.entities.find((row) => row.itemID === id);
        return entity ? this.nameOf(entity) : null;
      };
      if (indication) {
        const { kind } = indication;
        const header = indicationHeader(kind, words);
        if ("followID" in indication) text = indicationText(indication, name(indication.followID) ?? "", words);
        else if ("destinationID" in indication) text = { header, sub: warpText(indication, indication.destinationName ?? name(indication.destinationID), words) };
        else if ("targetID" in indication) text = { header, sub: alignText(indication, name(indication.targetID), words) };
        else text = { header, sub: pointText(indication.kind, words) };
      }
    }
    const header = text?.header ?? "", sub = text?.sub ?? "";
    if (this.modeHeader.textContent !== header) this.modeHeader.textContent = header;
    if (this.modeSub.textContent !== sub) this.modeSub.textContent = sub;
    const progress = !this.shortcutIndication && !this.temporaryIndication ? warpProgress(flight) : null;
    this.modeProgress.hidden = !progress;
    if (progress) this.modeProgressFill.style.transform = `scaleX(${progress})`;
  }

  private updateShipAlerts(ego: Snapshot["ship"], cap: number | null, now: number): void {
    if (this.alertShipID !== (ego?.itemID ?? null)) {
      this.alertShipID = ego?.itemID ?? null;
      this.alertState = initialShipAlertState();
      this.nextDamageFlash = this.nextCapFlash = 0;
      this.alertVignetteFlash?.cancel();
      this.shipHud.cancelAlerts();
    }
    if (!ego) return;
    const settings = healthNotificationSettings.get();
    const shield = ego.shieldRatio, armor = ego.armorRatio, hull = ego.hullRatio;
    if (shield != null && armor != null && hull != null &&
        (shield !== this.alertState.oldDamage[0] || armor !== this.alertState.oldDamage[1] || hull !== this.alertState.oldDamage[2])) {
      this.alertState = damageStateChanged(this.alertState, [shield, armor, hull], now, settings);
    }
    if (cap !== null && cap !== this.alertState.oldDamage[CAPACITOR]) {
      this.alertState = capacitorChanged(this.alertState, cap, now, settings);
    }
    if (settings !== this.alertSettings) {
      const startTimes = [...this.alertState.startTimes];
      HEALTH_NOTIFICATIONS.slice(0, CAPACITOR + 1).forEach(({ name }, level) => {
        if (settings[name] !== this.alertSettings[name]) {
          startTimes[level] = isLevelActive(level, this.alertState.oldDamage[level]!, settings) ? now : null;
        }
      });
      this.alertState = { ...this.alertState, startTimes };
      this.alertSettings = settings;
    }
    const level = now >= this.nextDamageFlash ? activeAlertLevel(this.alertState, now, settings) : null;
    if (level !== null) {
      const duration = ALERT_ANIMATION_MS[level]!;
      this.nextDamageFlash = now + duration;
      this.shipHud.flashDamage(level, duration);
      this.alertVignetteFlash = this.alertVignette.animate([{ opacity: 0 }, { opacity: level === HULL ? 1 : 0.7 }, { opacity: 0 }], {
        duration, easing: "ease-in-out",
      });
      void playUiEvent(["ui_warning_shield", "ui_warning_armor", "ui_warning_hull"][level]!);
    }
    if (now >= this.nextCapFlash && capacitorAlerting(this.alertState, now)) {
      this.nextCapFlash = now + ALERT_DURATION_MS;
      this.shipHud.flashCapacitor(ALERT_DURATION_MS);
      void playUiEvent("ui_warning_capacitor");
    }
  }

  private resize(): void {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h);
    this.bloom?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private starfield(): THREE.Points {
    const n = 4000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      pos.set([r * Math.cos(t), u, r * Math.sin(t)], i * 3);
      const b = 0.35 + Math.random() * 0.65;
      col.set([b, b * (0.9 + Math.random() * 0.1), b * (0.85 + Math.random() * 0.15)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, vertexColors: true, depthWrite: false }));
    // Far beyond anything on grid; the camera never leaves the ship by more than the zoom allows.
    stars.scale.setScalar(1e12);
    stars.frustumCulled = false;
    stars.renderOrder = -1;
    return stars;
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    clearTimeout((this.toastEl as unknown as { t?: number }).t);
    (this.toastEl as unknown as { t?: number }).t = window.setTimeout(() => this.toastEl.classList.remove("show"), 2600);
  }

  private async act(what: string, fn: () => Promise<void>): Promise<void> {
    // A refusal in the words the app gives it (bridge/refusals.ts), as the client puts its own up.
    // One the client has already said in its own way (a dialog) is not said again.
    try { await fn(); } catch (e) { if (!(e as { said?: boolean }).said) this.toast(panelErrorWords(e)); }
  }

  /** The client's double click in space: fly the way the camera looks through the cursor. */
  private doubleClick(e: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const d = ray.ray.direction;
    void this.act("Move", () => this.actions.gotoDirection(d.x, d.y, -d.z));
  }

  private select(itemID: number | null): boolean {
    if (this.dscanKey && itemID !== null) {
      const target = this.snapshot?.entities.find((entity) => entity.itemID === itemID);
      if (target && this.scanTowards(target.position)) return false;
    }
    // ExecuteCombatCommand: a click on an object while a combat command is loaded runs it on the object
    const combat = itemID !== null ? this.combat?.cmd ?? this.modifierCombat() : null;
    if (combat && combat !== "CmdSelectTargetItem" && itemID !== null) { this.runCombat(combat, itemID); return false; }
    this.selected = itemID;
    // overviewWindow.OnScrollSelectionChange and inSpaceBracket.OnClick:
    // a selected object becomes the active target when it is already locked.
    if (itemID !== null && this.locked.has(itemID)) this.activeTarget = itemID;
    for (const [id, el] of this.bracketEls) el.classList.toggle("selected", id === itemID);
    this.overview.setSelected(itemID);
    if (itemID !== null && !this.targetingCursor.hidden) this.chooseModuleTarget(itemID);
    this.renderSelected();
    return true;
  }

  selectObjectiveTarget(itemID: number): boolean {
    if (!this.snapshot?.entities.some((entity) => entity.itemID === itemID)) return false;
    return this.select(itemID);
  }

  async playMiningSurvey(results: readonly SurveyResult[], options: ApiOptions): Promise<void> {
    const snapshot = this.snapshot;
    const ship = snapshot?.ship;
    if (!snapshot || !ship || ship.mode === "WARP" || this.stopped) return;
    const liveDetails = this.options.flightSnapshot?.()?.entities ?? [];
    const valueByID = new Map(liveDetails.map(rock => [rock.itemID, rock.oreValuePerM3]));
    const rocks = snapshot.entities.map(rock => ({ ...rock, oreValuePerM3: valueByID.get(rock.itemID) }));
    const targets = miningWaveTargets(rocks, results, ship.position);
    const sounds = miningWaveSounds(targets.flatMap(rock => rock.typeID === null ? [] : [rock.typeID]), options);
    const peakValue = liveDetails.reduce((peak, rock) => Math.max(peak, rock.oreValuePerM3 ?? 0), 0);
    const simNow = this.live.effectSimNow();
    this.miningSurveyUsesSimClock = simNow !== undefined;
    await this.miningSurvey.start(ship.itemID, ship.position, simNow ?? performance.now(), targets, sounds, peakValue);
  }

  clearMiningSurvey(): void {
    this.miningSurvey.clear();
    this.targetBar.clearMiningDepartures();
  }

  private updateMiningBracket(el: HTMLElement, entity: Entity, survey: MiningOverlayState | undefined): void {
    const row = survey?.survey.find(scan => scan.itemID === entity.itemID);
    const show = this.selected === entity.itemID && (entity.categoryID === 25 || entity.groupID === 711 || !!row);
    el.classList.toggle("mining-selected", show);
    if (!show) return;
    const typeID = row?.yieldTypeID ?? entity.typeID;
    let lines: string[] = [];
    if (row && typeID !== null) {
      if (row.remainingQuantity && !this.miningVolumes.has(typeID) && this.options.miningScanFacts) {
        this.miningVolumes.set(typeID, null);
        void this.options.miningScanFacts(typeID).then(facts => this.miningVolumes.set(typeID, facts.get(typeID)?.unitVolume ?? null))
          .catch(() => {});
      }
      const value = this.options.flightSnapshot?.()?.entities.find(item => item.itemID === entity.itemID)?.oreValuePerM3 ?? null;
      lines = miningBracketReadout(row, this.locked.has(entity.itemID), value, this.miningVolumes.get(typeID) ?? null);
      const hit = survey?.surveyProgress.get(entity.itemID)?.extraction;
      if (hit && hit.criticalQuantity > 0 && Date.now() - hit.atMs < 2600) {
        lines.push(`Critical yield +${hit.criticalQuantity.toLocaleString()}`);
      }
    }
    let details = el.querySelector<HTMLElement>(".mining-details");
    if (!details) {
      details = document.createElement("div");
      details.className = "mining-details";
      el.appendChild(details);
    }
    const text = lines.join("\n");
    if (details.textContent !== text) details.textContent = text;
    details.hidden = !lines.length;
  }

  private updateMiningHold(survey: MiningOverlayState | undefined, ego: Entity | null,
    width: number, height: number): void {
    const badge = this.miningHoldBracket;
    const holds = survey?.holds;
    const hold = holds?.find(hold => hold.present && hold.key === "ore") ?? holds?.find(hold => hold.present && hold.key === "cargo");
    const capacity = hold?.capacity;
    if (!ego || survey?.surveyAtMs == null || !hold || capacity?.used == null || !capacity.capacity || ego.mode === "WARP") {
      badge.hidden = true;
      return;
    }
    const { minDistance, maxDistance } = this.controls;
    const zoom = Math.pow(THREE.MathUtils.clamp((this.controls.getDistance() - minDistance) / Math.max(1, maxDistance - minDistance), 0, 1), 1 / 9);
    const opacity = Math.max(0, 1 - 30 * Math.max(0, zoom - 0.65) ** 2);
    const p = new THREE.Vector3().project(this.camera);
    badge.hidden = opacity === 0 || p.z >= 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1;
    if (badge.hidden) return;
    const text = `${hold.label} ${Math.round(100 * capacity.used / capacity.capacity)}%`;
    if (badge.textContent !== text) badge.textContent = text;
    badge.style.opacity = String(opacity);
    badge.style.transform = `translate(${(p.x + 1) * width / 2 + 36}px, ${(1 - p.y) * height / 2 + 30}px)`;
  }

  trackObjectiveTarget(itemID: number): void {
    if (this.selected === itemID) {
      this.endExplosionCamera();
      this.trackedObjective = itemID;
    }
  }

  highlightObjectiveTarget(itemID: number, on: boolean): void {
    if (on) this.highlightedObjective = itemID;
    else if (this.highlightedObjective === itemID) this.highlightedObjective = null;
  }

  canActivateObjectiveTarget(itemID: number): boolean {
    return !this.combat && !this.dscanKey && this.selected === itemID;
  }

  openObjectiveRadial(itemID: number, x: number, y: number): void {
    this.openRadial(itemID, x, y, 0);
  }

  private activateSpaceTarget(itemID: number): void {
    if (this.combat || this.dscanKey || this.modifierCombat(false)) return;
    const entity = this.snapshot?.entities.find((each) => each.itemID === itemID);
    if (!entity) return;
    const action = activateCargoTarget(entity, this.distanceTo(entity));
    const open = this.actions.openCargo;
    if (action === "open" && open) {
      if (selectedCargo(entity, this.snapshot?.ship?.mode === "WARP") === "enabled") {
        void this.act("Open Cargo", () => open(itemID));
      }
    } else if (action === "align") {
      void this.act("Align To", () => this.actions.alignTo(itemID));
    } else {
      void this.act("Approach", () => this.actions.approach(itemID));
    }
  }

  objectiveTargetMenu(itemID: number): readonly { title: string; run: () => void }[] {
    const entity = this.snapshot?.entities.find((each) => each.itemID === itemID);
    if (!entity) return [];
    const nearby = this.distanceTo(entity) < 150_000;
    const entries = this.actionsFor(entity).filter((entry) => !entry.disabled && (entry.key !== "warp" || !nearby));
    const cargoIndex = entries.findIndex(entry => entry.key === "cargo");
    if (cargoIndex > 0) entries.unshift(...entries.splice(cargoIndex, 1));
    return entries.map(({ title, run }) => ({ title, run: () => { void this.act(title, run).then(() => this.refreshTargets()); } }));
  }

  private aimSpaceCamera(direction: THREE.Vector3): void {
    if (!this.controls.enabled) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    if (setCameraDistance(this.camera.position, this.controls.target, direction.clone().negate(), dist)) this.controls.update();
  }

  /** ScanTowardsItem sends the pilot-to-target vector directly, before the camera turns. */
  private scanTowards(position: Entity["position"]): boolean {
    const ego = this.snapshot?.ship?.position;
    if (!this.dscanKey || !this.dscan || !ego) return false;
    const direction = new THREE.Vector3(position.x - ego.x, position.y - ego.y, position.z - ego.z);
    if (!direction.lengthSq()) return false;
    if (this.dscan.scanning) return true;
    direction.normalize();
    this.dscanKey.targeted = true;
    void this.dscan.scan([direction.x, direction.y, direction.z]);
    direction.z *= -1;
    this.aimSpaceCamera(direction);
    return true;
  }

  private wormholeEntry(e: Entity): ItemAction | null {
    const enter = this.actions.enterWormhole;
    if (!enter || e.groupID !== WORMHOLE_GROUP) return null;
    const disabled = this.snapshot?.ship?.mode === "WARP";
    return {
      key: "enterWormhole",
      title: this.actions.word?.(ENTER_WORMHOLE_LABEL) ?? "Enter Wormhole",
      icon: clientTexture("res:/UI/Texture/eveicon/control_icons/jump_to_32px.png"),
      disabled,
      disabledReason: disabled ? this.actions.word?.(IN_WARP_HINT_LABEL) ?? "You are in warp" : undefined,
      run: () => enter(e.itemID),
    };
  }

  /**
   * The Selected Item window's actions in the client's order (inflight/selectedItemWnd.py GetActions,
   * selectedItemConst.ACTIONS_ALWAYS_VISIBLE read from the compiled module: the decompiled source prints its places):
   * Approach, or Align To for a thing far enough to warp to; Warp To Within; the thing's own (Dock for a station,
   * Jump for a stargate, Open Cargo for a container); then always Orbit, Keep at Range, Lock or Unlock, Look At and Show Info. Set as Camera
   * Interest is not drawn yet.
   */
  private actionsFor(e: Entity): ItemAction[] {
    const id = e.itemID;
    const icon = (name: string) => clientTexture(`res:/UI/Texture/eveicon/control_icons/${name}_32px.png`);
    const far = this.distanceTo(e) >= 150_000;
    const out: ItemAction[] = [
      far
        ? { key: "align", title: "Align To", icon: icon("align_to"), run: () => this.actions.alignTo(id) }
        : { key: "approach", title: "Approach", icon: icon("approach"), run: () => this.actions.approach(id) },
      { key: "warp", title: "Warp To Within 0 m", icon: icon("warp_to"), run: () => this.actions.warpTo(id) },
    ];
    if (this.overview.groupOf(e) === JUMP_BRIDGE_GROUP) {
      const jump = this.options.jumpBridge;
      if (jump && e.jumpBridge?.targetSystemID && e.jumpBridge.activationState === 2) {
        out.push({ key: "jump", title: "Jump Through Jump Gate", icon: icon("jump_to"), run: () => jump(id) });
      }
    } else if (e.kind === "station" || (e.kind === "structure" && e.typeID !== METENOX_TYPE_ID)) {
      out.push({ key: "dock", title: "Dock", icon: icon("dock"), run: () => this.actions.dock(id) });
    }
    if (e.kind === "stargate") out.push({ key: "jump", title: "Jump", icon: icon("jump_to"), run: () => this.actions.jump(id) });
    const wormhole = this.wormholeEntry(e);
    if (wormhole) out.push(wormhole);
    const planet = this.planetViewEntry(e);
    if (planet) out.push(planet);
    const cargo = this.actions.openCargo;
    const cargoState = selectedCargo(e, this.snapshot?.ship?.mode === "WARP");
    if (cargo && cargoState !== "hidden") {
      out.push({ key: "cargo", title: this.actions.word?.(OPEN_CARGO_LABEL) ?? "Open Cargo", icon: clientTexture(OPEN_CARGO_ICON),
        disabled: cargoState === "disabled", run: () => cargo(id) });
    }
    const activateGate = this.actions.activateGate;
    if (activateGate && isWarpGate(e.groupID, e.typeID) && this.snapshot?.ship?.mode !== "WARP") {
      const title = this.actions.word?.(ACTIVATE_GATE_LABEL) ?? "Activate Gate";
      out.push({ key: "activateGate", title, icon: icon("jump_to"), run: () => activateGate(id, e.typeID) });
    }
    out.push(
      { key: "orbit", title: "Orbit", icon: icon("orbit"), run: () => this.actions.orbit(id) },
      { key: "keep", title: "Keep at Range", icon: icon("keep_at_distance"), run: () => this.actions.keepAtRange(id) },
    );
    const lockable = ["ship", "drone", "fighter", "wreck", "container", "asteroid", "structure", "station", "stargate"].includes(e.kind);
    if (lockable) {
      out.push(this.locked.has(id)
        ? { key: "unlock", title: "Unlock Target", icon: icon("target"), run: () => this.actions.unlock(id) }
        : { key: "lock", title: "Lock Target", icon: icon("target"), run: () => this.lockTracked(id) });
    }
    out.push({ key: "look", title: "Look At", icon: icon("look_at"), run: async () => this.focusOn(id) });
    const showInfo = this.options.showInfo;
    if (showInfo) out.push({ key: "info", title: "Show Info", icon: icon("show_info"), run: async () => showInfo(id, e.typeID ?? null) });
    const drill = this.autoMoonMinerEntry(e);
    if (drill) out.push(drill);
    out.push(...this.metenoxEntries(e));
    return out;
  }

  private planetViewEntry(entity: Entity): ItemAction | null {
    const view = this.options.viewPlanet;
    return entity.kind === "planet" && view ? {
      key: "planet", title: this.actions.word?.("UI/PI/Common/ViewInPlanetMode") ?? "View in Planet Mode",
      icon: clientTexture("res:/UI/Texture/icons/77_32_34.png"), run: () => view(entity.itemID),
    } : null;
  }

  private metenoxEntries(entity: Entity): ItemAction[] {
    const ship = this.snapshot?.ship;
    if (entity.typeID !== METENOX_TYPE_ID || !ship || ship.mode === "WARP" || ship.itemID === entity.itemID) return [];
    const distance = this.distanceTo(entity);
    const { boardMetenox, transferMetenoxFuel, openMoonMaterialBay } = this.options;
    const entries: ItemAction[] = [];
    if (boardMetenox && distance <= METENOX_BOARD_RANGE) entries.push({ key: "board-metenox", title: "Board Structure",
      icon: clientTexture("res:/UI/Texture/Icons/44_32_40.png"), run: () => boardMetenox(entity.itemID) });
    if (transferMetenoxFuel && distance < METENOX_DEPOSIT_RANGE) entries.push({ key: "transfer-metenox", title: "Access Hangar Transfer",
      icon: clientTexture("res:/UI/Texture/WindowIcons/items.png"), run: () => transferMetenoxFuel(entity.itemID, ship.itemID) });
    if (openMoonMaterialBay && distance < METENOX_MATERIAL_RANGE) entries.push({ key: "moon-material-bay", title: "Open Moon Material Bay",
      icon: clientTexture("res:/UI/Texture/eveicon/control_icons/retrieve_32px.png"), run: () => openMoonMaterialBay(entity.itemID) });
    return entries;
  }

  private autoMoonMinerEntry(entity: Entity): ItemAction | null {
    const open = this.options.openAutoMoonMiner;
    if (!open || entity.kind !== "structure" || entity.typeID !== METENOX_TYPE_ID || !(Number(entity.ownerID ?? entity.corporationID) > 0)) return null;
    return { key: "moon-drill", title: "Open Moon Drill Details",
      icon: clientTexture("res:/UI/Texture/WindowIcons/moonDrillScheduler.png"), run: () => open(entity.itemID) };
  }

  private renderSelected(): void {
    const e = this.snapshot?.entities.find((x) => x.itemID === this.selected) ?? null;
    const body = this.selectedWin.body;
    if (!e || e.isSelf) {
      if (body.getAttribute("data-sig") !== "none") {
        body.setAttribute("data-sig", "none");
        body.innerHTML = `<div class="si-none">No object selected</div>`;
      }
      return;
    }
    const dist = this.distanceTo(e);
    const cargoLabel = selectedCargo(e, false) === "hidden" ? "" : this.actions.word?.(OPEN_CARGO_LABEL) ?? "Open Cargo";
    const wormholeLabel = e.groupID === WORMHOLE_GROUP ? this.actions.word?.(ENTER_WORMHOLE_LABEL) ?? "Enter Wormhole" : "";
    const metenoxRange = e.typeID === METENOX_TYPE_ID ? `${dist <= METENOX_BOARD_RANGE}:${dist < METENOX_DEPOSIT_RANGE}:${dist < METENOX_MATERIAL_RANGE}` : "";
    const sig = `${e.itemID}:${this.locked.has(e.itemID)}:${dist >= 150_000}:${e.jumpBridge?.activationState ?? ""}:${this.snapshot?.ship?.mode === "WARP"}:${cargoLabel}:${wormholeLabel}:${metenoxRange}`;
    if (body.getAttribute("data-sig") !== sig) {
      body.setAttribute("data-sig", sig);
      // its picture (the client's own, /client-res/type-picture), its name, its type (and Hostile for an NPC), how far
      const typeName = e.typeID !== null ? this.names?.types[String(e.typeID)]?.[0] ?? null : null;
      body.innerHTML = `<div class="si-top"><img class="si-icon" alt=""><div class="si-labels"><div class="si-name"></div><div class="si-type"></div><div class="si-dist"></div></div></div><div class="si-actions"></div>`;
      const pic = body.querySelector(".si-icon") as HTMLImageElement;
      if (e.typeID !== null) pic.src = `/client-res/type-picture/${e.typeID}/64.png`;
      else pic.style.visibility = "hidden";
      pic.onerror = () => { pic.style.visibility = "hidden"; };
      body.querySelector(".si-name")!.textContent = this.nameOf(e);
      const typeEl = body.querySelector(".si-type")!;
      typeEl.textContent = typeName ?? "";
      if (e.isNpc) {
        const hostile = document.createElement("span");
        hostile.className = "si-hostile";
        hostile.textContent = "Hostile";
        typeEl.append(typeName ? " \u00b7 " : "", hostile);
      }
      const row = body.querySelector(".si-actions")!;
      for (const a of this.actionsFor(e)) {
        const b = document.createElement("button");
        b.className = `si-act${a.key === "unlock" ? " on" : ""}`;
        b.title = a.disabledReason ? `${a.title}\n${a.disabledReason}` : a.title;
        b.disabled = a.disabled ?? false;
        b.innerHTML = `<img src="${a.icon}" alt="">`;
        b.addEventListener("click", () => void this.act(a.title, a.run).then(() => this.refreshTargets()));
        row.appendChild(b);
      }
    }
    body.querySelector(".si-dist")!.textContent = distanceWords(dist);
  }

  private lookAt: number | null = null;
  private trackedObjective: number | null = null;
  private highlightedObjective: number | null = null;
  private framedLook: number | null = null;
  private framedFor: number | null = null;
  private entryWarped: boolean | null = null;
  private entryConsumed = false;
  private entryCam: { start: number; path: EntryCameraPath; orbitFov: number; orbitMinDistance: number } | null = null;
  private explosionCam: {
    interest: Entity["position"];
    radius: number;
    eye: THREE.Vector3;
    target: THREE.Vector3;
    orbitFov: number;
    globalStart: number | null;
    awaitingStartUntil: number;
    startedAt: number;
    path?: ExplosionCameraPath;
    returning?: { at: number; pilot: THREE.Vector3 };
  } | null = null;

  private focusOn(id: number | null): void {
    this.endExplosionCamera();
    this.lookAt = id;
  }

  private beginExplosionCamera(entity: Entity, start: Promise<number | null>): void {
    this.stopEntryCamera();
    this.undockCam = null;
    this.trackedObjective = null;
    const p = entity.position, origin = this.lastOrigin;
    const offset = new THREE.Vector3(p.x - origin.x, p.y - origin.y, origin.z - p.z);
    const cam: NonNullable<SpaceView["explosionCam"]> = {
      interest: p,
      radius: entity.radius,
      eye: this.camera.position.clone().sub(offset),
      target: this.controls.target.clone().sub(offset),
      orbitFov: this.camera.fov,
      globalStart: null,
      awaitingStartUntil: performance.now() + 5_000,
      startedAt: 0,
    };
    this.explosionCam = cam;
    this.lookAt = this.framedLook = null;
    this.controls.enabled = false;
    void start.then(globalStart => {
      if (this.explosionCam !== cam) return;
      if (globalStart === null) this.endExplosionCamera();
      else cam.globalStart = globalStart;
    });
  }

  private endExplosionCamera(): boolean {
    if (!this.explosionCam) return false;
    this.camera.fov = this.explosionCam.orbitFov;
    this.camera.updateProjectionMatrix();
    this.explosionCam = null;
    const pilot = this.snapshot?.ship;
    if (pilot) this.frameShip(pilot.radius, true);
    this.controls.enabled = !this.gateJump || this.gateJump.returned;
    return true;
  }

  private stepExplosionCamera(now: number, dt: number, ego: Snapshot["ship"]): boolean {
    const cam = this.explosionCam;
    if (!cam) return false;
    const settings = gfx();
    if (!ego || !settings.dynamicCameraMovement || !settings.explosionEffectsEnabled ||
        (cam.globalStart === null && now >= cam.awaitingStartUntil)) {
      this.endExplosionCamera();
      return false;
    }

    // Keep the cinematic camera fixed to the scene while the pilot moves the
    // Three.js origin. The path itself is centred on the exploding ball.
    const { interest, globalStart } = cam, origin = ego.position;
    const offset = new THREE.Vector3(interest.x - origin.x, interest.y - origin.y, origin.z - interest.z);
    const simNow = this.live.simNow();
    if (!cam.path && globalStart !== null) {
      cam.startedAt = simNow;
      cam.path = spaceExplosionCamera(cam.eye, cam.target, offset.clone().negate(), cam.radius, ego.radius,
        THREE.MathUtils.degToRad(this.camera.fov), globalStart - simNow) ?? undefined;
      if (!cam.path) {
        this.endExplosionCamera();
        return false;
      }
    }
    const elapsed = simNow - cam.startedAt;
    let eye = cam.eye.clone(), target = cam.target.clone();
    let returned = false;
    if (cam.path) {
      eye = cam.path.eyeAt(elapsed);
      if (elapsed >= cam.path.motionMs) {
        cam.returning ??= { at: now, pilot: offset.clone().negate() };
        const returnElapsed = now - cam.returning.at;
        target = cam.path.targetAt(cam.returning.pilot, returnElapsed);
        returned = returnElapsed >= cam.path.returnMs;
      } else {
        target.set(0, 0, 0);
      }
    }
    const valid = setCameraPose(this.camera.position, this.controls.target, eye.add(offset), target.add(offset));
    if (!valid || returned) {
      this.endExplosionCamera();
      return false;
    }
    this.camera.fov = explosionCameraFov(this.camera.fov, dt);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.controls.target);
    return true;
  }

  private stopEntryCamera(): void {
    this.entryConsumed = true;
    if (!this.entryCam) return;
    this.camera.fov = this.entryCam.orbitFov;
    this.controls.minDistance = this.entryCam.orbitMinDistance;
    this.camera.updateProjectionMatrix();
    this.entryCam = null;
  }

  private stepEntryCamera(now: number, systemID: number | null, snapshot: Snapshot | null): void {
    if (this.lookAt !== null || !gfx().dynamicCameraMovement) { this.stopEntryCamera(); return; }
    if (!this.entryConsumed && this.entryWarped !== null && systemID !== null && snapshot?.ship) {
      const ship = snapshot.ship;
      const toView = ({ x, y, z }: Entity["position"]) => new THREE.Vector3(x, y, -z);
      const mark = this.marks.get(ship.itemID);
      // GetBallWaitForModel and GetBallRadius prefer the installed hull's
      // authored bounding sphere to the Destiny ball radius.
      if (mark?.userData.loadingModel) return;
      this.entryConsumed = true;
      const model = mark?.userData.model as THREE.Object3D | undefined;
      const bound = model?.userData.boundingSphere?.[3];
      const radius = typeof bound === "number" && Number.isFinite(bound) && bound > 0 ? bound : ship.radius * 1.1;
      const nearest = (radius + this.camera.near) * 1.5 * Math.max(1, this.camera.aspect / 1.6) + 2;
      const forward = toView(ship.velocity);
      if (!validCameraPosition(forward) || forward.lengthSq() < 1) {
        forward.set(0, 0, 1);
        if (mark) forward.applyQuaternion(mark.quaternion);
      }
      const planets = snapshot.entities.filter(e => e.kind === "planet").map(e => ({ position: toView(e.position), radius: e.radius }));
      const path = spaceEntryCamera(this.entryWarped, systemID, radius, nearest, toView(ship.position), forward, planets);
      if (path) {
        this.entryCam = { start: now, path, orbitFov: this.camera.fov, orbitMinDistance: this.controls.minDistance };
        this.controls.minDistance = nearest;
      }
    }
    const entry = this.entryCam;
    if (!entry) return;
    const elapsed = now - entry.start;
    const target = this.controls.target;
    const eye = entry.path.eyeAt(elapsed).clampLength(this.controls.minDistance, this.controls.maxDistance).add(target);
    if (setCameraPose(this.camera.position, target, eye, target)) {
      const fov = entryCameraFov(eye.distanceTo(target));
      const handoff = THREE.MathUtils.smoothstep(elapsed, ENTRY_CAMERA_DURATION_MS - 600, ENTRY_CAMERA_DURATION_MS);
      this.camera.fov = THREE.MathUtils.lerp(fov, entry.orbitFov, handoff);
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(target);
    }
    if (elapsed >= ENTRY_CAMERA_DURATION_MS) this.stopEntryCamera();
  }

  /**
   * The client's ship orbit camera limits (shipOrbitCamera.py, cameraUtil.py): no nearer than GetBallMaxZoom, (radius
   * + near clip) * 1.5 (* an aspect-ratio factor, taken as 1) + 2; no further than its minZoom, 800 km; and on first
   * looking at the ship, GetInitialLookAtDistance: the root of a * x^2 + b * x + c, a = 1 / 800000^0.95,
   * b = FOV_MIN / 2 (0.55 / 2), c = -max(radius, nearest).
   */
  /**
   * The client's undock camera (ui/camera/undockCamera.py, with its dynamic camera movement on): the eye on the ship's
   * way out, twice its radius ahead, looking back at it as it comes out of the station; then over 30 s it swings a
   * sixth of a turn round and a tenth of a half turn further down, and draws back (zoom 0.48 to 0.65 over the first
   * 24 s), until the pilot takes the camera or it is done.
   */
  private undockCam: { start: number; spherical: THREE.Spherical } | null = null;
  private startUndockCamera(ego: { velocity: { x: number; y: number; z: number }; radius: number }): void {
    const v = new THREE.Vector3(ego.velocity.x, ego.velocity.y, -ego.velocity.z);
    if (!validCameraPosition(v) || v.lengthSq() < 1e-6 || !Number.isFinite(ego.radius)) return;
    const eye = v.normalize().multiplyScalar(2 * Math.max(ego.radius, 10));
    const spherical = new THREE.Spherical().setFromVector3(eye);
    spherical.phi = Math.min(Math.PI - 0.01, spherical.phi + Math.PI / 40);
    this.undockCam = { start: performance.now(), spherical };
  }
  private stepUndockCamera(): void {
    const cam = this.undockCam;
    if (!cam) return;
    const t = (performance.now() - cam.start) / 30000;
    if (t >= 1) { this.undockCam = null; return; }
    const s = cam.spherical;
    const now = new THREE.Spherical(
      s.radius * (1 + (0.65 / 0.48 - 1) * Math.min(1, t / 0.8)),
      Math.min(Math.PI - 0.01, s.phi + (Math.PI / 10) * t),
      s.theta + (Math.PI / 3) * t,
    );
    const eye = this.controls.target.clone().add(new THREE.Vector3().setFromSpherical(now));
    setCameraPose(this.camera.position, this.controls.target, eye, this.controls.target);
  }

  private frameShip(radius: number, keepZoom = false): void {
    if (!Number.isFinite(radius) || radius < 0) return;
    // the farthest the camera goes: 800 km, or ten times what it looks at where that is larger (a planet looked at)
    const farthest = Math.max(800000, radius * 10);
    const nearest = (radius + this.camera.near) * 1.5 + 2;
    const dir = this.camera.position.clone().sub(this.controls.target);
    const validDirection = validCameraPosition(dir) && dir.lengthSq() !== 0;
    const initial = keepZoom && validDirection ? THREE.MathUtils.clamp(dir.length(), nearest, farthest) : initialOrbitDistance(radius, nearest, farthest);
    if (!validDirection) dir.set(-0.5, 0.25, 0.83);
    if (setCameraDistance(this.camera.position, this.controls.target, dir, initial)) {
      this.controls.minDistance = nearest;
      this.controls.maxDistance = farthest;
    }
  }

  private beginJumpCamera(wormholeEndpoint?: number): void {
    this.endExplosionCamera();
    this.stopEntryCamera();
    const eye = this.camera.position, target = this.controls.target;
    // JumpCamera.OnActivated copies the orbit pose only when both points are valid.
    if (!setCameraPose(eye, target, eye, target, MAX_JUMP_CAMERA_COORDINATE)) {
      setCameraPose(eye, target, new THREE.Vector3(-600, 250, 900), new THREE.Vector3());
    }
    const ego = this.snapshot?.ship;
    const now = performance.now();
    this.gateJump = {
      orderedAt: now, arrivedAt: null, returning: null, returned: false,
      origin: ego ? new THREE.Vector3(ego.position.x, ego.position.y, -ego.position.z) : null,
      wormhole: wormholeEndpoint === undefined ? null : {
        endpoint: wormholeEndpoint, oldFov: this.camera.fov, aimFrom: target.clone(), stopSimAt: null,
      },
    };
    if (wormholeEndpoint !== undefined) {
      const slim = this.live.park.slimItems.get(wormholeEndpoint);
      this.wormholeTransit.begin(now, this.reflectionSky, Number(slim?.get("nebulaType") ?? 0), Number(slim?.get("isDestTriglavian") ?? 0) !== 0);
      void playUiEvent("worldobject_wormhole_travel_play");
    }
    this.undockCam = null;
    this.controls.enabled = false;
  }

  private endJumpCamera(): void {
    if (this.gateJump?.wormhole) {
      this.camera.fov = this.gateJump.wormhole.oldFov;
      this.camera.updateProjectionMatrix();
      this.wormholeTransit.clear();
    }
    this.gateJump = null;
    this.controls.enabled = true;
  }

  private clearWormholeCollapses(): void {
    for (const { mark, audio } of this.collapsingWormholes.splice(0)) {
      mark.removeFromParent();
      audio.dispose();
    }
  }

  /** JumpCamera keeps the old view still in space while the ship-relative origin moves. */
  private stepJumpCamera(now: number, ego: Snapshot["ship"], wormholeStopElapsed: number | null): boolean {
    const jump = this.gateJump;
    if (!jump || jump.returned) return false;
    const eye = this.camera.position, target = this.controls.target;
    if (jump.arrivedAt === null && ego) {
      const p = ego.position;
      const origin = new THREE.Vector3(p.x, p.y, -p.z);
      if (validCameraPosition(origin)) {
        if (jump.origin) {
          const shift = jump.origin.clone().sub(origin);
          if (translateCameraPose(eye, target, shift, MAX_JUMP_CAMERA_COORDINATE)) jump.wormhole?.aimFrom.add(shift);
        }
        jump.origin = origin;
      }
      if (jump.wormhole) {
        const aim = this.marks.get(jump.wormhole.endpoint)?.position;
        const ease = THREE.MathUtils.smoothstep(now - jump.orderedAt, 0, WORMHOLE_START_MS);
        if (aim) setCameraPose(eye, target, eye, jump.wormhole.aimFrom.clone().lerp(aim, ease), MAX_JUMP_CAMERA_COORDINATE);
        this.camera.fov = THREE.MathUtils.lerp(jump.wormhole.oldFov, THREE.MathUtils.radToDeg(1), ease);
        this.camera.updateProjectionMatrix();
      }
    } else if (ego) {
      if (jump.wormhole && (wormholeStopElapsed === null || wormholeStopElapsed < WORMHOLE_CAMERA_RETURN_MS)) {
        this.camera.lookAt(target);
        return true;
      }
      // ShipOrbitCamera.OnActivated takes the valid outgoing direction and zoom
      // and moves back to the pilot once its new-system ball is present.
      if (!jump.returning) {
        jump.returning = { startedAt: now, target: target.clone() };
        this.lookAt = this.framedLook = null;
        this.framedFor = ego.itemID;
        this.frameShip(ego.radius, true);
        if (jump.wormhole) {
          this.camera.fov = jump.wormhole.oldFov;
          this.camera.updateProjectionMatrix();
        }
      }
      const elapsed = THREE.MathUtils.clamp((now - jump.returning.startedAt) / 700, 0, 1);
      const nextTarget = jump.returning.target.clone().multiplyScalar(1 - elapsed);
      translateCameraPose(eye, target, nextTarget.sub(target), MAX_JUMP_CAMERA_COORDINATE);
      if (elapsed === 1) {
        jump.returned = true;
        this.controls.enabled = true;
      }
    }
    this.camera.lookAt(target);
    return true;
  }

  private activeLock(): number | null {
    return this.activeTarget !== null && this.locked.has(this.activeTarget) ? this.activeTarget : null;
  }

  private useRackModule(module: HudModule): void {
    const rack = this.options.rack;
    if (!rack) return;
    this.checkModuleTargetSession();
    const current = rack.modules().find((each) => each.itemID === module.itemID);
    if (!current) return;
    if (this.moduleTargetOrders.delete(current.itemID)) {
      this.updateTargetingCursor();
      return;
    }
    const targetID = this.activeLock();
    if (targetID !== null || current.active || !current.online) {
      void this.act(current.name ?? "Module", () => rack.use(current, targetID));
      return;
    }

    const order: { mode: "lock" | "passive" | null } = { mode: null };
    this.moduleTargetOrders.set(current.itemID, order);
    const prepare = async () => {
      const mode = await rack.targeting(current.itemID).catch(() => null);
      this.checkModuleTargetSession();
      if (this.stopped || this.moduleTargetOrders.get(current.itemID) !== order) return;
      const fitted = rack.modules().find((each) => each.itemID === current.itemID);
      if (mode && fitted?.online && !fitted.active && this.activeLock() === null) {
        order.mode = mode;
        this.updateTargetingCursor();
        return;
      }
      this.moduleTargetOrders.delete(current.itemID);
      this.updateTargetingCursor();
      if (fitted) await rack.use(fitted, this.activeLock());
    };
    void this.act(current.name ?? "Module", prepare);
  }

  private checkModuleTargetSession(): void {
    const shipID = this.live.hello?.shipID ?? null;
    const systemID = this.live.hello?.solarSystemID ?? null;
    if (this.targetOrderShip === shipID && this.targetOrderSystem === systemID) return;
    this.targetOrderShip = shipID;
    this.targetOrderSystem = systemID;
    this.moduleTargetOrders.clear();
    this.lockingIDs.clear();
    this.acquiringTargets.clear();
    this.updateTargetingCursor();
  }

  private updateTargetingCursor(): void {
    if (!this.moduleTargetOrders.size) this.orderedTarget = null;
    const waiting = [...this.moduleTargetOrders.values()].some(({ mode }) => mode !== null);
    this.targetingCursor.hidden = !waiting || this.orderedTarget !== null;
  }

  private chooseModuleTarget(itemID: number): void {
    const entity = this.snapshot?.entities.find((each) => each.itemID === itemID);
    // targetMgr.TryLockTarget and inventorycommon.const.nonTargetableGroups.
    if (!entity || entity.isSelf || [7, 8, 9, 885].includes(entity.groupID ?? -1)) return;
    const rack = this.options.rack!;
    const first = [...this.moduleTargetOrders].find(([, order]) => order.mode !== null);
    if (!first) return;
    this.orderedTarget = itemID;
    this.updateTargetingCursor();
    if (this.locked.has(itemID)) return;
    if (first[1].mode === "passive") {
      // LockTargetPassively starts the first module with the target to let its effect create the lock.
      const module = rack.modules().find((each) => each.itemID === first[0]);
      this.moduleTargetOrders.delete(first[0]);
      this.updateTargetingCursor();
      if (module?.online && !module.active) {
        void this.act(module.name ?? "Module", () => this.lockTracked(itemID, () => rack.use(module, itemID, true)));
      }
    } else if (!this.acquiringTargets.has(itemID) && !this.lockingIDs.has(itemID)) {
      void this.act("Lock Target", () => this.lockTracked(itemID));
    }
  }

  private finishModuleTargetOrders(modules: HudModule[]): void {
    const rack = this.options.rack!;
    const targetID = this.orderedTarget ?? this.activeLock();
    const confirmed = targetID !== null && this.locked.has(targetID);
    for (const [id, { mode }] of this.moduleTargetOrders) {
      const module = modules.find((each) => each.itemID === id);
      if (!module?.online || module.active) {
        this.moduleTargetOrders.delete(id);
      } else if (mode && confirmed) {
        this.moduleTargetOrders.delete(id);
        void this.act(module.name ?? "Module", () => rack.use(module, targetID));
      }
    }
    this.updateTargetingCursor();
  }

  private async refreshTargets(): Promise<void> {
    try {
      const t = await this.actions.targets();
      this.locked = new Set(t.targetIDs);
      const now = this.lockNow();
      this.acquiringTargets = new Map((t.acquiringIDs ?? []).map((id) => [
        id, this.lockingIDs.get(id) ?? this.acquiringTargets.get(id) ?? now,
      ]));
      this.targeters = new Set(t.targeterIDs);
      for (const [id, el] of this.bracketEls) { el.classList.toggle("locked", this.locked.has(id)); el.classList.toggle("targeting-me", this.targeters.has(id)); }
      this.renderSelected();
    } catch { /* the next poll tries again */ }
  }

  /** The client is told of locks as they happen; the BFF keeps them and the page reads them once a second. */
  private pollTargets(): void {
    const tick = () => { if (this.stopped) return; void this.refreshTargets().finally(() => setTimeout(tick, 1000)); };
    tick();
  }

  /** The client's in-space combat notification (message.py CombatMessage: the lines at the top of the middle). */
  readonly combatMessage: CombatMessage = new CombatMessage(this.root);
  showDamage(entry: { direction: "dealt" | "taken"; otherPartyID: number | null; amount: number; weaponTypeID?: number | null; quality?: number | null; routing?: DamageRouting }): void {
    // the shot's hit or miss to the turret that fired it, as the client routes the message (turretFx.damageMessage)
    const own = this.snapshot?.ship?.itemID ?? null;
    if (own !== null && entry.routing) this.turretFx.damageMessage(own, entry.routing, entry.weaponTypeID ?? null, entry.quality ?? null);
  }
  /**
   * The balls' impact overlays (impactOverlay.ts): each one's damage state from the park's (michelle's, extrapolated:
   * spaceObject._OnDamageState, a missing value nought; none before the first), then its frame - its holes' debris sent
   * with the ball's velocity, the count by its diameter on the screen in pixels (the client's render priority).
   */
  private stepImpacts(dt: number): void {
    // the defensive modules' repeats (ImpactEffect.Repeat: on again for the cycle), and their end (Stop: off)
    const now = performance.now();
    for (const [key, a] of this.impactAnimations) {
      const impact = this.marks.get(a.ship)?.userData.impact as ImpactOverlay | undefined;
      if (now >= a.until) { impact?.setImpactAnimation(a.name, false, a.cycle / 1000); this.impactAnimations.delete(key); continue; }
      if (now >= a.next) { a.next += a.cycle; impact?.setImpactAnimation(a.name, true, a.cycle / 1000); }
    }
    const byID = new Map((this.snapshot?.entities ?? []).map((e) => [e.itemID, e as Entity & { shieldRatio?: number | null; armorRatio?: number | null; hullRatio?: number | null }]));
    const pixelsPerRadian = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const camAt = this.camera.getWorldPosition(new THREE.Vector3());
    for (const [id, mark] of this.marks) {
      const impact = mark.userData.impact as ImpactOverlay | undefined;
      const e = byID.get(id);
      if (!e) continue;
      if (e.shieldRatio != null || e.armorRatio != null || e.hullRatio != null) {
        // SetImpactDamageState supplies the remaining shield fraction to the native controller.
        setControllerVariable(mark, "ShieldDamage", e.shieldRatio ?? 0);
        impact?.setDamageState(e.shieldRatio ?? 0, e.armorRatio ?? 0, e.hullRatio ?? 0);
      }
      if (!impact) continue;
      const distance = Math.max(1, mark.getWorldPosition(new THREE.Vector3()).distanceTo(camAt));
      impact.update(dt, this.scene, new THREE.Vector3(e.velocity.x, e.velocity.y, -e.velocity.z), (2 * e.radius * pixelsPerRadian) / distance);
      // the lights' flicker below 90 % hull
      setActivationStrength(mark, impact.activationStrength(performance.now() / 1000));
    }
  }
  /**
   * The missile balls (kind "missile") to the missiles' drawing: each ball's place and velocity in three's space, its
   * top speed (the ball's own: the overview's row has none for a missile), its target (the ball's followId) and its slim item's sourceShipID and launchModules (missile.py LoadModel).
   */
  private stepMissiles(origin: { x: number; y: number; z: number }, moved: THREE.Vector3, dt: number): void {
    const park = this.live.park as unknown as { ballpark: { ball(id: number): { followId?: unknown; collisions?: unknown[]; maxVelocity?: unknown } | undefined }; slimItems?: Map<number, Map<string, unknown>> };
    const balls = [];
    for (const e of this.snapshot?.entities ?? []) {
      if (e.kind !== "missile" || !e.typeID) continue;
      const slim = park.slimItems?.get(e.itemID);
      const ball = park.ballpark.ball(e.itemID);
      const follow = Number(ball?.followId ?? 0);
      const src = Number(slim?.get("sourceShipID") ?? 0);
      const mods = slim?.get("launchModules");
      balls.push({
        itemID: e.itemID, typeID: e.typeID, maxVelocity: Number(ball?.maxVelocity ?? 0) || (e.maxVelocity ?? 0), targetID: follow > 0 ? follow : null, sourceShipID: src > 0 ? src : null,
        // its launchers' item ids (a marshal list: its items)
        launchModules: ((Array.isArray(mods) ? mods : (mods as { items?: unknown[] } | undefined)?.items ?? []) as unknown[]).map(Number).filter((x) => x > 0),
        // the tick's collisions (Ballpark::Potential): a missile only ever meets the ball it is aimed at
        collided: follow > 0 && (ball?.collisions ?? []).some((c) => Number(c) === follow),
        position: new THREE.Vector3(e.position.x - origin.x, e.position.y - origin.y, -(e.position.z - origin.z)),
        velocity: new THREE.Vector3(e.velocity.x, e.velocity.y, -e.velocity.z),
      });
    }
    this.missileFx.onShake = (magnitude, at) => { if (gfx().cameraShakeEnabled) this.shake.shake(magnitude, at, this.camera.getWorldPosition(new THREE.Vector3())); };
    if (!balls.length && !this.missileFx.active) return;
    const byID = new Map((this.snapshot?.entities ?? []).map((e) => [e.itemID, e]));
    this.missileFx.update({
      balls, origin, shift: moved, dt, scene: this.scene, sun: this.sunDir, aspect: innerWidth / Math.max(1, innerHeight),
      camera: this.camera, width: this.renderer.domElement.width,
      muzzleOf: (ship, moduleID, shot, target) => this.muzzleOf(ship, moduleID, shot, target, origin),
      target: (id) => {
        const place = this.placeOf(id, origin);
        if (!place) return null;
        return { position: place.clone(), radius: byID.get(id)?.radius ?? this.gone.get(id)?.radius ?? 0, impact: (this.marks.get(id)?.userData.impact as ImpactOverlay | undefined) ?? null };
      },
      velocityOf: (id) => { const e = byID.get(id); return e ? new THREE.Vector3(e.velocity.x, e.velocity.y, -e.velocity.z) : null; },
    });
  }
  /**
   * A ship's turrets (turretModel.ts, turretSet.py FitTurrets): its slim item's modules (itemID, typeID, flagID: the
   * active ship's too - the same list its fitting gives), each a set at its slot; an NPC's hull with none its
   * gfxTurretID's set, one per locator group (the turret route answers a hull type with its gfxTurretID's graphic).
   * Fitted again when the slim item's list changes (OnSlimItemChange); a module with no turret graphic is passed by.
   */
  private fitTurrets(itemID: number, holder: THREE.Object3D): void {
    const model = holder.userData.model as THREE.Object3D | undefined;
    if (!model) return;
    const park = this.live.park as unknown as { slimItems?: Map<number, Map<string, unknown>> };
    const slim = park.slimItems?.get(itemID);
    const raw = slim?.get("modules") as { items?: unknown[] } | unknown[] | undefined;
    const rows = (Array.isArray(raw) ? raw : raw?.items ?? []) as unknown[];
    const modules = rows.map((r) => { const t = (Array.isArray(r) ? r : (r as { items?: unknown[] })?.items ?? []) as unknown[]; return { moduleID: Number(t[0]), typeID: Number(t[1]), flagID: Number(t[2]) }; })
      .filter((m) => m.typeID > 0);
    const signature = modules.map((m) => `${m.typeID}:${m.flagID}`).join(",") || `hull:${Number(slim?.get("typeID") ?? 0)}`;
    if (holder.userData.turretSignature === signature) return;
    holder.userData.turretSignature = signature;
    const data = model.userData as HullTurretData & { faction?: string | null; turretPrimary?: HullTurretData["primary"] };
    const hull: HullTurretData = { turretLocators: data.turretLocators ?? [], primary: data.turretPrimary ?? null };
    if (!hull.turretLocators.length) return;
    void (async () => {
      let fits: TurretFit[] = modules.map((m) => ({ typeID: m.typeID, slot: slotOfFlag(m.flagID), count: 1, moduleID: m.moduleID }));
      if (!fits.length) {
        // FitTurrets for a ship without modules: its type's gfxTurretID, a set for each locator group
        const hullType = Number(slim?.get("typeID") ?? 0);
        const info = hullType ? await turretModelInfo(hullType) : null;
        const count = info ? turretSetCount(hull, info) : 0;
        // (a drone: Drone.py FitHardpoints - the turret its group and race give it, kept as modules[droneID], so its
        // shots, its own OnSpecialFX, fire from it; the turret route answers a drone type with that turret)
        const drone = Number(slim?.get("categoryID") ?? 0) === 18;
        if (count) fits = [{ typeID: hullType, slot: -1, count: drone ? 1 : count, moduleID: drone ? itemID : null }];
      }
      const group = await buildTurrets(hull, fits, data.faction ?? null);
      if (holder.userData.model !== model || holder.userData.turretSignature !== signature) return;
      const old = model.getObjectByName("turrets");
      if (old) model.remove(old);
      if (group) model.add(group);
      this.namedCache.delete(model);
    })().catch((e) => console.warn("turrets", e));
  }
  /**
   * The turrets' aiming: each rig toward the target its module is working on (OnSpecialFX under way, turretFx.aimTarget;
   * an NPC's - its rigs have no module - any of its ship's), the tracking influence fading in and out over a second.
   */
  private stepTurrets(origin: { x: number; y: number; z: number }, dt: number): void {
    const byID = new Map((this.snapshot?.entities ?? []).map((e) => [e.itemID, e]));
    for (const [shipID, mark] of this.marks) {
      const model = mark.userData.model as THREE.Object3D | undefined;
      const group = model ? this.named(model, "turrets") : undefined;
      const sets = group?.userData.sets as { state: TurretSetState; moduleID: number | null }[] | undefined;
      if (!sets?.length) {
        delete mark.userData.activeTurretCount;
        continue;
      }
      let activeTurretCount = 0;
      // turretSet.py: online at fitting (EnterStateIdle); a warp packs them (EnterWarp / ExitWarp); a target being
      // worked on aims them (TakeAim: EnterStateTargeting), none sends them back to idle (StopShooting)
      const warping = byID.get(shipID)?.mode === "WARP";
      // turret.py OnChargeBeingLoadedToModule: the pilot's own ship's modules being loaded play Reload
      const reloads = shipID === this.snapshot?.ship?.itemID ? this.options.reloads?.() ?? null : null;
      for (const { state: set, moduleID } of sets) {
        const target = this.turretFx.aimTarget(shipID, moduleID);
        const reload = moduleID !== null ? reloads?.[moduleID] : undefined;
        if (reload && reload.startedAtMs > ((set as { reloadSeen?: number }).reloadSeen ?? 0)) {
          (set as { reloadSeen?: number }).reloadSeen = reload.startedAtMs;
          if (set.state !== "invalid") set.enterReloading();
        }
        if (set.state === "invalid") set.enterIdle();
        if (warping) set.enterDeactive();
        else if (set.state === "deactive") set.enterIdle();
        else if (set.state === "reloading" && performance.now() < set.reloadUntil) { /* the Reload plays out */ }
        else if (target !== null && (set.state === "idle" || set.state === "reloading")) set.enterTargeting();
        else if (target === null && set.state === "reloading") set.enterIdle();
        else if (target === null && (set.state === "targeting" || set.state === "firing")) set.enterIdle();
        if (set.state === "firing" || set.state === "reloading") activeTurretCount++;
        set.update(dt);
        const at = target !== null ? this.placeOf(target, origin) : null;
        for (const rig of set.rigs) rig.update(at);
      }
      mark.userData.activeTurretCount = activeTurretCount;
    }
  }
  /** A ship's module's turret set fires (a gun's shot, a launcher's missile): EnterStateFiring, by the turret facing the target. */
  private fireTurretSet(shipID: number, moduleID: number, targetID: number | null): number {
    const group = (this.marks.get(shipID)?.userData.model as THREE.Object3D | undefined)?.getObjectByName("turrets");
    const sets = (group?.userData.sets as { state: TurretSetState; moduleID: number | null }[] | undefined) ?? [];
    // the module's set; an NPC's sets (no module: FitTurrets fits them as one TurretSet under the ship's id) all fire
    const own = sets.filter((x) => x.moduleID === moduleID);
    const chosen = own.length ? own : sets.filter((x) => x.moduleID === null);
    if (!chosen.length) return 0;
    const target = targetID !== null ? this.placeOf(targetID, this.lastOrigin) : null;
    let delay = 0;
    for (const { state } of chosen) delay = this.fireSet(state, target);
    return delay;
  }
  /** EnterStateFiring of one set, by its turret whose up axis faces the target best (GetClosestTurretAndLocator). */
  private fireSet(set: TurretSetState, target: THREE.Vector3 | null): number {
    let best: TurretRig | null = null, bestDot = -Infinity;
    for (const r of set.rigs) {
      if (!target) { best ??= r; continue; }
      r.root.updateWorldMatrix(true, false);
      const up = new THREE.Vector3(0, 1, 0).transformDirection(r.root.matrixWorld);
      const d = up.dot(target.clone().sub(new THREE.Vector3().setFromMatrixPosition(r.root.matrixWorld)).normalize());
      if (d > bestDot) { bestDot = d; best = r; }
    }
    return set.enterFiring(best);
  }
  /** A ship's module's type, from its slim item's modules (itemID, typeID, flagID); null where it is not there. */
  private moduleTypeOf(shipID: number, moduleID: number): number | null {
    const park = this.live.park as unknown as { slimItems?: Map<number, Map<string, unknown>> };
    const raw = park.slimItems?.get(shipID)?.get("modules") as { items?: unknown[] } | unknown[] | undefined;
    for (const r of (Array.isArray(raw) ? raw : raw?.items ?? []) as unknown[]) {
      const t = (Array.isArray(r) ? r : (r as { items?: unknown[] })?.items ?? []) as unknown[];
      if (Number(t[0]) === moduleID) return Number(t[1]) || null;
    }
    return null;
  }
  /**
   * A ship's firing bone for a module, in the world (EveTurretSet::GetFiringBoneWorldTransform): of the module's turret
   * rigs (an NPC's: all its rigs, its modules being the ship), the one whose up axis faces the target best
   * (GetClosestTurretAndLocator), its muzzle by the shot cycling through them (m_currentCyclingFiresPos); null where
   * the ship draws no turret for the module.
   */
  private muzzleOf(shipID: number, moduleID: number, shot: number, targetID: number | null, origin: { x: number; y: number; z: number }): THREE.Matrix4 | null {
    const group = (this.marks.get(shipID)?.userData.model as THREE.Object3D | undefined)?.getObjectByName("turrets");
    const all = (group?.userData.rigs as TurretRig[] | undefined) ?? [];
    let rigs = all.filter((r) => r.moduleID === moduleID);
    if (!rigs.length) rigs = all.filter((r) => r.moduleID === null);
    if (!rigs.length) return null;
    const target = targetID !== null ? this.placeOf(targetID, origin) : null;
    let best = rigs[0]!, bestDot = -Infinity;
    for (const r of rigs) {
      r.root.updateWorldMatrix(true, false);
      if (!target) break;
      const at = new THREE.Vector3().setFromMatrixPosition(r.root.matrixWorld);
      const up = new THREE.Vector3(0, 1, 0).transformDirection(r.root.matrixWorld);
      const d = up.dot(target.clone().sub(at).normalize());
      if (d > bestDot) { bestDot = d; best = r; }
    }
    const muzzle = best.muzzles.length ? best.muzzles[shot % best.muzzles.length]! : best.root;
    muzzle.updateWorldMatrix(true, false);
    return muzzle.matrixWorld.clone();
  }
  /** Where a thing is drawn now, or was a moment ago before it went (blown up, out of the park). */
  private placeOf(id: number, origin: { x: number; y: number; z: number }): THREE.Vector3 | null {
    const mark = this.marks.get(id);
    if (mark) return mark.position;
    const g = this.gone.get(id);
    return g ? new THREE.Vector3(g.x - origin.x, g.y - origin.y, g.z + origin.z) : null;
  }
  private lastOrigin = { x: 0, y: 0, z: 0 };
  private readonly gone = new Map<number, { x: number; y: number; z: number; radius: number | null; at: number }>();
  /** The looked-at ship's ambient sound (Ship.CheckAmbientAudio): its ship and its loop. */
  private ambient: { id: number; loop: Promise<WorldLoop> | null } | null = null;
  /** The types of the balls seen (for a ball blown up after it has left the snapshot). */
  private readonly typeOfID = new Map<number, number>();

  /**
   * The client's in-space commands by their default shortcuts (shortcutKeys.ts commandForKey, eveCommands.py):
   * OpenDirectionalScanner (Alt+D) and CmdRefreshDirectionalScan (V); CmdActivate<Rack>PowerSlot1-8 (F1-F8, Alt+F,
   * Ctrl+F: _cmdshipui -> slotsContainer.OnF, the module at that rack and place clicked) and CmdOverload<Rack>PowerSlot
   * (with Shift: OnFKeyOverload, its overload toggled); CmdOverload<Rack>PowerRack (Ctrl+3 / 2 / 1: the rack's overload
   * button); CmdStopShip (Ctrl+Space) and CmdSetShipFullSpeed (Alt+Ctrl+Space).
   */
  private key(e: KeyboardEvent): void {
    if (this.options.covered?.()) return;
    const t = e.target as HTMLElement | null;
    const cmd = commandForKey(e);
    if (cmd === null) return;
    const scanFromSlider = cmd === "CmdRefreshDirectionalScan" && t instanceof HTMLInputElement
      && t.type === "range" && this.dscan?.window.root.contains(t);
    if (!scanFromSlider && t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (isCombatCommand(cmd)) {
      e.preventDefault();
      if (!this.combat && !this.dscanKey) this.loadCombat(cmd, e.code);
      return;
    }
    if (cmd === "OpenDirectionalScanner" && this.dscan) { e.preventDefault(); this.dscan.toggle(); return; }
    if (cmd === "CmdToggleSolarSystemMap" && this.systemMap) { e.preventDefault(); this.systemMap.toggle(); return; }
    if (cmd === "CmdRefreshDirectionalScan" && this.dscan) {
      e.preventDefault();
      if (e.repeat) return;
      if (!this.dscan.isOpen) this.dscan.open();
      else if (!this.combat) this.dscanKey = { code: e.code, targeted: false };
      return;
    }
    // bracketSettings: switch the space-bracket override or restore the tab's preset.
    if (cmd === "CmdToggleShowNoBrackets" || cmd === "CmdToggleShowAllBrackets") {
      e.preventDefault();
      const want = cmd === "CmdToggleShowNoBrackets" ? "none" : "all";
      this.bracketOverride = this.bracketOverride === want ? "default" : want;
      return;
    }
    if (cmd === "CmdToggleShowSpecialBrackets") {
      e.preventDefault();
      this.showSpecialBrackets = !this.showSpecialBrackets;
      return;
    }
    // targetMgr.SelectNext/PrevTarget: the active target moved along the locked targets, wrapping (FindNextTarget;
    // an active target no longer locked: the first)
    if (cmd === "CmdSelectNextTarget" || cmd === "CmdSelectPrevTarget") {
      e.preventDefault();
      const order = [...this.locked];
      if (this.activeTarget === null || order.length === 0) return;
      const at = order.indexOf(this.activeTarget);
      const next = at < 0 ? order[0]! : cmd === "CmdSelectNextTarget" ? order[(at + 1) % order.length]! : order[(at - 1 + order.length) % order.length]!;
      this.activeTarget = next;
      this.select(next);
      return;
    }
    if (cmd === "CmdStopShip") { e.preventDefault(); void this.stopShip(); return; }
    if (cmd === "CmdSetShipFullSpeed") { e.preventDefault(); void this.fullSpeed(); return; }
    const RACKS = { High: "high", Medium: "mid", Low: "low" } as const;
    const rack = /^CmdOverload(High|Medium|Low)PowerRack$/.exec(cmd);
    if (rack) {
      e.preventDefault();
      if (!this.shipHud.toggleRackOverload(({ High: "Hi", Medium: "Med", Low: "Lo" } as const)[rack[1] as "High" | "Medium" | "Low"])) this.toast("Disabled");
      return;
    }
    const slot = /^Cmd(Activate|Overload)(High|Medium|Low)PowerSlot(\d)$/.exec(cmd);
    if (!slot) return;
    e.preventDefault();
    const family = RACKS[slot[2] as "High" | "Medium" | "Low"];
    const index = Number(slot[3]) - 1;
    // hudLayer.OnF (_ActivateModuleAtPosition): the module at that place in the ship's slot order (slotOrder.GetSlotOrder)
    const order = this.options.rack?.slotOrder?.() ?? null;
    const placeFlag = order ? order[({ high: 0, mid: 1, low: 2 } as const)[family] * 8 + index] ?? null : null;
    const FLAG_BASE = { high: 27, mid: 19, low: 11 } as const;
    const m = this.options.rack?.modules().find((each) => (placeFlag !== null ? FLAG_BASE[each.family] + each.index === placeFlag : each.family === family && each.index === index)) ?? null;
    // (an empty slot or a module offline: the client's "Disabled" notice)
    if (!m || !m.online) { this.toast("Disabled"); return; }
    if (slot[1] === "Activate") { if (!e.repeat) this.useRackModule(m); return; }
    const overload = this.options.rack?.overload;
    if (!overload || m.overloadable === false) { this.toast("Disabled"); return; }
    void this.act(m.name ?? "Module", () => overload.module(m.itemID, !m.overloaded));
  }

  /**
   * Ship.LookAtMe -> CheckAmbientAudio: the ship the camera looks at (the pilot's own where it looks at nothing else)
   * has its type's ambient sound (its soundID's Wwise event) playing at it; looking at another ship stops it there
   * (shipsounds_stop) and starts that one's. A non-ship has none.
   */
  private updateAmbient(): void {
    const id = this.lookAt ?? this.snapshot?.ship?.itemID ?? null;
    const e = id === null ? null : this.snapshot?.entities.find((x) => x.itemID === id) ?? (this.snapshot?.ship?.itemID === id ? this.snapshot.ship : null);
    const want = e && (e.kind === "ship" || e.isSelf) ? e.itemID : null;
    if (this.ambient?.id !== want) {
      void this.ambient?.loop?.then((l) => l.stop());
      this.ambient = null;
      if (want !== null && e?.typeID) {
        const typeID = e.typeID;
        const entry = { id: want, loop: null as Promise<WorldLoop> | null };
        this.ambient = entry;
        void typeSoundsOf().then((table) => {
          const event = table[String(typeID)];
          const at = this.placeOf(want, this.lastOrigin);
          if (event && at && this.ambient === entry) entry.loop = playWorldLoop(event, at);
        });
      }
    }
    if (this.ambient?.loop) {
      const at = this.placeOf(this.ambient.id, this.lastOrigin);
      if (at) void this.ambient.loop.then((l) => l.move(at));
    }
  }

  /** A click's modifier-only combat command (Ctrl lock, Ctrl+Shift unlock, Alt look at), for a press just now. */
  private modifierCombat(consume = true): CombatCommand | null {
    if (performance.now() - this.clickMods.at > 1000) return null;
    // (one click, one command: the press's modifiers are used once)
    const cmd = combatForModifiers(this.clickMods);
    if (cmd && consume) this.clickMods = { ...this.clickMods, at: 0 };
    return cmd;
  }

  /**
   * LoadCombatCommand: the command held for the next click, the HUD's shortcut indication saying it (the command's name
   * and UI/Commands/ClickTarget).
   */
  private loadCombat(cmd: CombatCommand, code: string): void {
    this.combat = { cmd, code };
    const label = labelOf(cmd);
    const name = (label ? this.actions.word?.(label) : null) ?? cmd;
    const click = this.actions.word?.("UI/Commands/ClickTarget") ?? "";
    this.temporaryIndication = null;
    this.shortcutIndication = { header: name, sub: click };
  }

  private unloadCombat(): void {
    this.combat = null;
    this.shortcutIndication = null;
  }

  /** The loaded command's function on the object clicked (movementFunctions / the menu's, as the page has them). */
  private runCombat(cmd: CombatCommand, id: number): void {
    const e = this.snapshot?.entities.find((each) => each.itemID === id) ?? null;
    const run = (title: string, fn: () => Promise<void>) => void this.act(title, fn).then(() => this.refreshTargets());
    switch (cmd) {
      case "CmdApproachItem": run("Approach", () => this.actions.approach(id)); break;
      case "CmdOrbitItem": run("Orbit", () => this.actions.orbit(id)); break;
      case "CmdKeepItemAtRange": run("Keep at Range", () => this.actions.keepAtRange(id)); break;
      case "CmdWarpToItem": run("Warp To", () => this.actions.warpTo(id)); break;
      case "CmdAlignToItem": run("Align To", () => this.actions.alignTo(id)); break;
      case "CmdLockTargetItem": run("Lock Target", () => this.lockTracked(id)); break;
      case "CmdUnlockTargetItem": run("Unlock Target", () => this.actions.unlock(id)); break;
      case "CmdDockOrJumpOrActivateGate": {
        if (e?.kind === "station" || e?.kind === "structure") run("Dock", () => this.actions.dock(id));
        else if (e?.kind === "stargate") run("Jump", () => this.actions.jump(id));
        else {
          const wormhole = e && this.wormholeEntry(e);
          if (wormhole && !wormhole.disabled) run(wormhole.title, wormhole.run);
        }
        break;
      }
      case "CmdShowItemInfo": this.options.showInfo?.(id, e?.typeID ?? null); break;
      case "CmdToggleLookAtItem": this.focusOn(this.lookAt === id ? null : id); break;
      case "CmdSelectTargetItem": break;
    }
  }

  /** The object in space under a point of the screen: the nearest mark the ray from the camera meets. */
  private pickAt(x: number, y: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1), this.camera);
    const owner = new Map<THREE.Object3D, number>();
    for (const [id, m] of this.marks) if (!m.userData.nonPickable) owner.set(m, id);
    for (const hit of ray.intersectObjects([...owner.keys()], true)) {
      if ((hit.object as THREE.Mesh).isMesh !== true || hit.object.name === "warpTunnel") continue;
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) { const id = owner.get(o); if (id !== undefined) return id; }
    }
    return null;
  }

  /**
   * An object's radial menu, laid out as spaceRadialMenuFunctions.GetObjectsActions lays it: the type's primary action
   * at the top, then orbit, more, keep at range, lock, approach, show info and warp to, clockwise; for the pilot's own
   * ship, stop, the default orbit, more, the default keep at range, its cargo hold, show info and the default warp.
   */
  private openRadial(id: number, x: number, y: number, button: number): void {
    const e = this.snapshot?.entities.find((each) => each.itemID === id) ?? null;
    if (!e) return;
    this.select(e.isSelf ? this.selected : id);
    const icon = (n: number) => RADIAL_ICON(`res:/UI/Texture/Icons/44_32_${n}.png`);
    const run = (title: string, fn: () => Promise<void>) => () => void this.act(title, fn).then(() => this.refreshTargets());
    const showInfo: RadialOption = this.options.showInfo
      ? { label: "Show Info", icon: icon(24), run: () => this.options.showInfo!(id, e.typeID ?? null) }
      : { label: "Show Info", icon: icon(24), disabled: true };
    const lookAt: RadialOption = { label: "Look At", icon: icon(20), run: () => this.focusOn(id) };
    let options: (RadialOption | null)[];
    if (e.isSelf) {
      options = [
        { label: "Stop Ship", icon: clientTexture("res:/UI/Texture/Icons/44_32_38.png"), run: run("Stop", () => this.actions.stop()) },
        { label: "Set Default Orbit Distance", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/setOrbitDefault.png"), disabled: true },
        { label: "More", icon: "", more: [lookAt] },
        { label: "Set Default Keep at Range Distance", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/setKeepRangeDefault.png"), disabled: true },
        { label: "Open Cargo Hold", icon: icon(35), run: () => this.options.onNeocom?.("inventory") },
        null,
        showInfo,
        { label: "Set Default Warp To Distance", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/setWarpDefault.png"), disabled: true },
      ];
    } else {
      const dist = this.distanceTo(e);
      const drill = this.autoMoonMinerEntry(e);
      const more = [lookAt, ...this.sovHubEntries(e, dist)];
      if (drill) more.push({ label: drill.title, icon: drill.icon, run: run(drill.title, drill.run) });
      for (const entry of this.metenoxEntries(e)) more.push({ label: entry.title, icon: entry.icon, run: run(entry.title, entry.run) });
      const wormhole = this.wormholeEntry(e);
      const planet = this.planetViewEntry(e);
      const primary: RadialOption | null =
        e.kind === "station" || (e.kind === "structure" && e.typeID !== METENOX_TYPE_ID) ? { label: "Dock", icon: icon(9), run: run("Dock", () => this.actions.dock(id)) }
        : e.kind === "stargate" ? { label: "Jump", icon: icon(39), run: run("Jump", () => this.actions.jump(id)) }
        : wormhole ? { label: wormhole.title, icon: icon(39), disabled: wormhole.disabled, run: run(wormhole.title, wormhole.run) }
        : planet ? { label: planet.title, icon: planet.icon, run: run(planet.title, planet.run) }
        // spaceRadialMenuFunctions: a wreck's and a can's first action is Open Cargo (44_32_35)
        : (e.kind === "wreck" || e.kind === "container") && this.actions.openCargo
          ? { label: "Open Cargo", icon: icon(35), run: run("Open Cargo", () => this.actions.openCargo!(id)) }
        : null;
      const lockable = ["ship", "drone", "fighter", "wreck", "container", "asteroid", "structure", "station", "stargate"].includes(e.kind);
      const lock: RadialOption = this.locked.has(id)
        ? { label: "Unlock Target", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/untarget.png"), run: run("Unlock Target", () => this.actions.unlock(id)) }
        : { label: "Lock Target", icon: icon(17), disabled: !lockable, run: run("Lock Target", () => this.lockTracked(id)) };
      options = [
        primary,
        { label: "Orbit", icon: icon(21), ranges: radialRanges(500, 30000), defaultRange: 1000, run: (r) => run("Orbit", () => this.actions.orbit(id, r))() },
        { label: "More", icon: "", more },
        { label: "Keep at Range", icon: icon(22), ranges: radialRanges(500, 30000), defaultRange: 1000, run: (r) => run("Keep at Range", () => this.actions.keepAtRange(id, r))() },
        lock,
        { label: "Approach", icon: icon(23), run: run("Approach", () => this.actions.approach(id)) },
        showInfo,
        // A warp needs the object 150 km away or more (the server refuses a nearer one).
        { label: "Warp To Within", icon: icon(18), ranges: WARP_RANGES, defaultRange: 0, disabled: dist < 150_000, run: (r) => run("Warp To", () => this.actions.warpTo(id, r))() },
      ];
    }
    this.radial.open(x, y, this.nameOf(e), options, button);
  }

  /** A Sov Hub's entries (typeInfrastructureHub 32458): Deposit Reagents within transfer range, the config window for its owner's station manager. */
  private sovHubEntries(e: Entity, dist: number): RadialOption[] {
    const hub = this.options.sovHub;
    if (!hub || e.typeID !== 32458) return [];
    const word = (label: string, fallback: string) => this.actions.word?.(label) ?? fallback;
    const out: RadialOption[] = [];
    if (dist < 2500 && (this.snapshot?.ship as { mode?: string } | undefined)?.mode !== "WARP") out.push({ label: word("UI/Sovereignty/SovHub/ReagentBay/DepositReagents", "Deposit Reagents"), icon: RADIAL_ICON("res:/UI/Texture/Icons/44_32_35.png"), run: () => hub.deposit(e.itemID) });
    if (hub.configurable(e.itemID, e.corporationID ?? null)) out.push({ label: word("UI/Menusvc/OpenSovHubConfigWindow", "Open Sov Hub Config Window"), icon: RADIAL_ICON("res:/UI/Texture/Icons/44_32_7.png"), run: () => hub.configure(e.itemID) });
    return out;
  }

  /** michelle's DistanceBetween(the ship, itemID): surface to surface; null where the ball is not in the snapshot. */
  distanceToItem(itemID: number): number | null {
    const e = this.snapshot?.entities.find((x) => x.itemID === itemID);
    return e ? this.distanceTo(e) : null;
  }

  /** The context menu open on something in space (menusvc.CelestialMenu as a right-click shows it). */
  openContext(id: number, x: number, y: number): void {
    const e = this.snapshot?.entities.find((each) => each.itemID === id) ?? null;
    if (!e) return;
    this.select(e.isSelf ? this.selected : id);
    this.radial.close();
    this.contextMenu.open(x, y, this.contextEntries(e));
  }

  /** What the open context menu says (for checks). */
  get contextText(): string[] { return this.contextMenu.text; }

  /**
   * menusvc._CelestialMenu in the order and on the terms of the 3698585 client (CelestialChecker, measured on its
   * menus through gridcheck): Warp to Within its default ▸ (beyond minWarpDistance 150 km), Approach, Orbit ▸ and Keep at
   * Range ▸ (within maxApproachDistance 10,000 km; not a planet, moon or belt; Keep at Range not for an asteroid,
   * station, gate, container, wreck, cloud or mining drone), Align to (beyond approach range), Dock, Jump, Add as First
   * Waypoint; Look at (not a planet or moon), Track; Unlock Target or Lock Target (within the ship's targeting range,
   * not from a capsule); Show Info; Set Destination, Add Waypoint, Save Location..., View Planetary Industry; and Add/Remove
   * the group to/from the Overview.
   */
  private contextEntries(e: Entity): (ContextEntry | null)[] {
    const word = (label: string, own: string, args?: Readonly<Record<string, string | number>>) => this.actions.word?.(label, args) ?? own;
    const id = e.itemID;
    const run = (title: string, fn: () => Promise<void>) => () => void this.act(title, fn).then(() => this.refreshTargets());
    const I = (name: string) => `res:/UI/Texture/eveicon/control_icons/${name}_16px.png`;
    const showInfo: ContextEntry = { label: word("UI/Commands/ShowInfo", "Show Info"), info: true, run: () => this.options.showInfo?.(id, e.typeID ?? null) };
    if (e.isSelf) {
      return [
        { label: word(e.groupID === 29 ? "UI/Inflight/StopMyCapsule" : "UI/Inflight/StopMyShip", e.groupID === 29 ? "Stop My Capsule" : "Stop My Ship"), run: run("Stop", () => this.actions.stop()) },
        null,
        showInfo,
      ];
    }
    const group = e.groupID ?? null;
    const category = (e as Entity & { categoryID?: number | null }).categoryID ?? null;
    const dist = this.distanceTo(e);
    const warping = this.snapshot?.ship?.mode === "WARP";
    const planetMoonBelt = group === 7 || group === 8 || group === 9;
    const approach = !planetMoonBelt && !warping && dist < 10_000_000;
    const warp = !warping && dist > 150_000;
    const noKeep = category === 25 || [711, 101, 12, 340, 448, 15, 10, 649, 186].includes(group ?? -1);
    const dockable = e.kind === "station" || group === 15 || e.kind === "structure";
    const stargate = e.kind === "stargate" || group === 10;
    const current = fmtDistance(dist);
    // movementFunctions._GetRangeMenu: the ranges, the current distance (OrbitAtCurrentRange / KeepAtCurrentRange), and
    // Set Default (SetDefaultWarpRange) - the same ranges, each made the action's default (defaultRangeUtils)
    const setDefault = (kind: DefaultDistanceKind, values: readonly number[], label: (r: number) => string): ContextEntry => ({
      label: word("UI/Inflight/Submenus/SetDefaultWarpRange", "Set Default"),
      sub: values.map((r) => ({ label: (defaultDistance(kind) === r ? "✓ " : "") + label(r), run: () => setDefaultDistance(kind, r) })),
    });
    const ranges = (kind: DefaultDistanceKind, values: readonly number[], currentLabel: string, fn: (r: number) => void): (ContextEntry | null)[] => [
      ...values.map((r) => ({ label: fmtDistance(r), run: () => fn(r) })),
      { label: word(currentLabel, `Current ${current}`, { currentDistance: current }), run: () => fn(dist) },
      null,
      setDefault(kind, values, (r) => fmtDistance(r)),
    ];
    const orbitRanges = [500, 1000, 2500, 5000, 7500, 10000, 15000, 20000, 25000, 30000];
    const warpRanges = [0, 10000, 20000, 30000, 50000, 70000, 100000];
    const within = (r: number) => word("UI/Inflight/WarpToWithin", `Within ${fmtDistance(r)}`, { distance: fmtDistance(r) });
    const out: (ContextEntry | null)[] = [];
    if (warp) {
      const d = defaultDistance("WarpTo");
      out.push({
        label: `${word("UI/Inflight/Submenus/WarpToWithin", "Warp to Within")} (${fmtDistance(d)})`, icon: I("warp_to"),
        run: run("Warp", () => this.actions.warpTo(id, d)),
        sub: [...warpRanges.map((r) => ({ label: within(r), run: run("Warp", () => this.actions.warpTo(id, r)) })), null, setDefault("WarpTo", warpRanges, within)],
      });
    }
    if (approach) {
      out.push({ label: word("UI/Inflight/ApproachObject", "Approach"), icon: I("approach"), run: run("Approach", () => this.actions.approach(id)) });
      const orbitD = defaultDistance("Orbit"), keepD = defaultDistance("KeepAtRange");
      out.push({ label: `${word("UI/Inflight/OrbitObject", "Orbit")} (${fmtDistance(orbitD)})`, icon: I("orbit"), run: run("Orbit", () => this.actions.orbit(id, orbitD)),
        sub: ranges("Orbit", orbitRanges, "UI/Inflight/OrbitAtCurrentRange", (r) => void this.act("Orbit", () => this.actions.orbit(id, r))) });
      if (!noKeep) out.push({ label: `${word("UI/Inflight/Submenus/KeepAtRange", "Keep at Range")} (${fmtDistance(keepD)})`, icon: I("keep_at_distance"), run: run("Keep at Range", () => this.actions.keepAtRange(id, keepD)),
        sub: ranges("KeepAtRange", orbitRanges, "UI/Inflight/KeepAtCurrentRange", (r) => void this.act("Keep at Range", () => this.actions.keepAtRange(id, r))) });
    } else if (warp) {
      out.push({ label: word("UI/Inflight/AlignTo", "Align to"), icon: I("align_to"), run: run("Align", () => this.actions.alignTo(id)) });
    }
    if (dockable && !warping) out.push({ label: word("UI/Inflight/DockInStation", "Dock"), icon: I("dock"), run: run("Dock", () => this.actions.dock(id)) });
    if (stargate) {
      out.push({ label: word("UI/Inflight/Jump", "Jump"), icon: I("jump_to"), run: run("Jump", () => this.actions.jump(id)) });
    }
    // (the client's menu shows the movement entries, Look at, Track and the lock as one group)
    if (!warping && group !== 7 && group !== 8) out.push({ label: word("UI/Inflight/LookAtObject", "Look at"), run: () => this.focusOn(id) });
    out.push({ label: word("UI/Inflight/SetAsCameraInterest", "Track"), run: () => { this.endExplosionCamera(); this.trackedObjective = id; } });
    if (this.locked.has(id)) out.push({ label: word("UI/Inflight/UnlockTarget", "Unlock Target"), icon: I("target"), run: run("Unlock Target", () => this.actions.unlock(id)) });
    else if (!planetMoonBelt && this.snapshot?.ship?.typeID !== 670) {
      const lockRange = this.actions.shipAttribute?.(76) ?? null;
      if (lockRange === null || dist <= lockRange) out.push({ label: word("UI/Inflight/LockTarget", "Lock Target"), icon: I("target"), run: run("Lock Target", () => this.lockTracked(id)) });
    }
    out.push(null, showInfo, null);
    if (stargate) out.push({ label: word("UI/Inflight/AddFirstWaypoint", "Add as First Waypoint"), run: () => this.actions.addWaypoint?.(id) });
    else if (dockable && this.actions.setDestination) {
      out.push({ label: word("UI/Inflight/SetDestination", "Set Destination"), icon: "res:/UI/Texture/eveicon/system_icons/set_destination_16px.png", run: () => this.actions.setDestination?.(id) });
      out.push({ label: word("UI/Inflight/AddWaypoint", "Add Waypoint"), run: () => this.actions.addWaypoint?.(id) });
    }
    // overviewMenuUtil: a group not shown is offered to the Overview before Save Location...; one shown is taken off at the foot
    const groupName = group !== null ? this.names?.groups[String(group)]?.[0] ?? "" : "";
    const shownInOverview = group !== null && this.overview.groupShown(group);
    if (group !== null && !shownInOverview) out.push({ label: word("UI/Overview/AddGroupToOverview", `Add ${groupName} to Overview`, { groupName }), run: () => this.overview.setGroupShown(group, true) });
    if (this.actions.saveLocation && category !== 11 && category !== 6) out.push({ label: word("UI/Inflight/BookmarkLocation", "Save Location..."), run: () => this.actions.saveLocation?.(id, e.typeID ?? null) });
    if (group === 7 && this.options.viewPlanet) out.push({ label: word("UI/PI/Common/ViewInPlanetMode", "View Planetary Industry"), icon: I("enter_planet_view"), run: () => void this.options.viewPlanet?.(id) });
    if (group !== null && shownInOverview) out.push(null, { label: word("UI/Overview/RemoveGroupFromOverview", `Remove ${groupName} from Overview`, { groupName }), run: () => this.overview.setGroupShown(group, false) });
    return out;
  }

  private distanceTo(e: Entity): number {
    const s = this.snapshot?.ship;
    if (!s) return 0;
    return Math.max(0, Math.hypot(e.position.x - s.position.x, e.position.y - s.position.y, e.position.z - s.position.z) - e.radius - s.radius);
  }

  private sceneFor: number | null = null;
  /** The system's reflection cube, filtered (loadScene). */
  private sceneEnv: THREE.WebGLRenderTarget | null = null;
  private reflectionSky: THREE.Texture | null = null;
  private reflectionProbe: VortexReflectionProbe | null = null;

  private updateReflections(eye: THREE.Vector3, quality: number, sources: VortexReflection[]): void {
    if (this.reflectionSky && sources.length) {
      this.reflectionProbe ??= new VortexReflectionProbe(this.renderer, this.reflectionSky);
      const texture = this.reflectionProbe.update(eye, quality, sources);
      if (texture) {
        this.scene.environment = texture;
        this.scene.environmentRotation.set(0, 0, 0);
      }
    } else if (this.reflectionProbe) {
      this.reflectionProbe.dispose();
      this.reflectionProbe = null;
      this.scene.environment = this.sceneEnv?.texture ?? null;
      this.scene.environmentRotation.set(0, Math.PI, 0);
    }
  }

  /**
   * The system's space scene, as the client draws it: its region's nebula cube map as the background, and the
   * nebula's reflection map for what the hulls reflect (sceneManager.GetResPathForLocation, EveSpaceScene's
   * NebulaMap and envMap1ResPath). The cube maps are EVE's, looked up in a world mirrored in z, and three
   * flips x when it samples a cube texture: together a half turn about y.
   */
  private async loadScene(solarSystemID: number): Promise<void> {
    this.sceneFor = solarSystemID;
    this.reflectionSky = null;
    const info = await (await fetch(`/client-assets/scene/${solarSystemID}`)).json() as { name?: string; security?: number; maps?: Record<string, string> | null };
    if (this.stopped || this.sceneFor !== solarSystemID) return;
    this.options.onSystem?.(solarSystemID, typeof info.security === "number" ? info.security : null);
    if (info.name) {
      this.root.querySelector(".hud-top-left .system")!.innerHTML = `${info.name}<span class="sec">${typeof info.security === "number" ? info.security.toFixed(1) : ""}</span>`;
    }
    const halfTurn = new THREE.Euler(0, Math.PI, 0);
    if (info.maps?.nebula) {
      const nebula = await loadDds(info.maps.nebula);
      if (this.stopped || this.sceneFor !== solarSystemID) return;
      this.scene.background = nebula;
      this.scene.backgroundRotation.copy(halfTurn);
      this.scene.backgroundIntensity = 1.25; // EveSpaceScene.nebulaIntensity
      this.starfieldObj.visible = false;
    }
    if (info.maps?.reflection) {
      const refl = await loadDds(info.maps.reflection);
      if (this.stopped || this.sceneFor !== solarSystemID) return;
      // filtered for rough surfaces here, once (PMREM), not left to three's first draw of a standard material (which
      // converts it in the middle of that draw: hangarView.ts setScene); the planets read the cube itself
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.sceneEnv?.dispose();
      this.sceneEnv = pmrem.fromCubemap(refl as unknown as THREE.CubeTexture);
      pmrem.dispose();
      this.reflectionSky = refl;
      this.scene.environment = this.sceneEnv.texture;
      setPlanetEnvironment(refl);
      this.scene.environmentRotation.copy(halfTurn);
      this.scene.environmentIntensity = 1.55; // EveSpaceScene.reflectionIntensity
    }
  }

  private positionJumpBridge(gate: Entity, ship: Snapshot["ship"], position: THREE.Vector3, width: number, height: number): void {
    const mount = this.options.mountJumpBridge;
    const bridge = gate.jumpBridge;
    if (!mount || !bridge) return;
    let panel = this.jumpBridgePanels.get(gate.itemID);
    const range = this.camera.position.distanceTo(position);
    const anchor = position.clone().project(this.camera);
    if (!ship || ship.mode === "WARP" || range > 600_000 || anchor.z >= 1 || Math.abs(anchor.x) > 1.05 || Math.abs(anchor.y) > 1.05) {
      if (panel) {
        panel.destroy();
        panel.host.remove();
        this.jumpBridgePanels.delete(gate.itemID);
      }
      return;
    }
    const near = range <= 150_000;
    const signature = `${bridge.targetSystemID}:${bridge.activationState}:${bridge.chargeTag}:${ship.typeID}:${near}`;
    const state = { bridge, shipTypeID: ship.typeID, near };
    if (!panel) {
      const host = document.createElement("div");
      host.className = "jump-bridge-bracket";
      this.brackets.appendChild(host);
      panel = { host, signature, ...mount(host, gate, state) };
      this.jumpBridgePanels.set(gate.itemID, panel);
    } else if (panel.signature !== signature) {
      panel.signature = signature;
      panel.update(state);
    }
    const raised = position.clone();
    raised.y += 5_500;
    raised.project(this.camera);
    const projected = raised.z < 1 && Math.abs(raised.x) <= 1 && Math.abs(raised.y) <= 1 ? raised : anchor;
    const x = Math.min(width - 155, Math.max(155, (projected.x + 1) * width / 2));
    const y = Math.min(height - 38, Math.max(235, (1 - projected.y) * height / 2));
    panel.host.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
  }

  private polarizationOf(item: Entity, simNow: number | undefined): WormholePolarization | null {
    const read = this.options.wormholePolarization;
    if (!read || !hasJumpPolarization(item.typeID)) return null;
    const entry = this.polarization.get(item.itemID);
    if (!entry) {
      const pending: { timer: WormholePolarization | null } = { timer: null };
      this.polarization.set(item.itemID, pending);
      void read(item.itemID).then(timer => {
        const simAtReply = this.live.effectSimNow();
        if (this.polarization.get(item.itemID) === pending && timer && (simAtReply === undefined || timer.expiresAt > simAtReply)) {
          pending.timer = timer;
        }
      }).catch(() => {});
      return null;
    }
    if (simNow === undefined || !entry.timer) return null;
    if (entry.timer.expiresAt > simNow) return entry.timer;
    entry.timer = null;
    void playUiEvent("bounty_open_play");
    return null;
  }

  private frame(): void {
    if (this.stopped) return;
    this.frameCount++;
    const systemID = this.live.hello?.solarSystemID ?? null;
    if (systemID && systemID !== this.sceneFor) void this.loadScene(systemID);
    this.live.frame();
    const park = this.live.park;
    let snap: Snapshot | null = null;
    if (park.validState) {
      snap = projectSpace(park, { solarSystemID: null, shipID: this.live.hello?.shipID ?? null, simTime: this.live.simNow() }) as unknown as Snapshot;
    }
    this.snapshot = snap;
    if (snap) this.primeEntityLocations(snap.entities);
    this.checkModuleTargetSession();
    const ego = snap?.ship ?? null;
    const now = performance.now(), dt = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    const inMiningWarp = ego?.mode === "WARP";
    const miningShipChanged = this.lastMiningShip !== null && ego != null && this.lastMiningShip !== ego.itemID;
    if (ego) this.lastMiningShip = ego.itemID;
    const gridReset = this.live.resets !== this.seenResets;
    if (gridReset || miningShipChanged || (inMiningWarp && !this.miningInWarp)) {
      this.clearMiningSurvey();
      this.options.onMiningGridExit?.();
    }
    this.miningInWarp = inMiningWarp;
    // A new park in another system marks the arrival. Observe it before using
    // a new ego position to rebase the old camera.
    if (this.live.resets !== this.seenResets) {
      this.seenResets = this.live.resets;
      this.endExplosionCamera();
      this.collectionExplosions.clear();
      this.clearWormholeCollapses();
      this.polarization.clear();
      if (this.gateJump && systemID !== null && this.seenSystem !== null && systemID !== this.seenSystem) {
        this.gateJump.arrivedAt = now;
      }
    }
    if (systemID !== null) this.seenSystem = systemID;
    // the ship's place is the scene's origin; with no ship (blown up, the capsule not yet in the park) the last one stays
    const origin = ego ? ego.position : this.lastOrigin;
    // the world moved under the GPU particles (they live in our space, which follows the ship): by the origin's move,
    // mirrored into three's handedness
    const moved = new THREE.Vector3(-(origin.x - this.lastOrigin.x), -(origin.y - this.lastOrigin.y), origin.z - this.lastOrigin.z);
    if (moved.lengthSq() > 0) shiftGpuParticles(this.scene, moved);
    this.lastOrigin = { x: origin.x, y: origin.y, z: origin.z };
    const seen = new Set<number>();
    const tmp = new THREE.Vector3();
    const w = innerWidth, h = innerHeight;
    const survey = this.options.miningSurvey?.();
    let sun: { position: THREE.Vector3; radius: number } | null = null;
    const settings = gfx();
    const rendering = spaceRendering(settings);
    const reflectClouds = settings.reflectionQuality >= 3 && settings.shaderQuality >= 2;
    const reflectionSources: VortexReflection[] = [];
    const shadowClouds: THREE.Mesh[] = [];
    const shadowPlanets: ShadowPlanet[] = [];
    const cloudVolumes: ObservatoryVortex[] = [];
    const overviewMask = this.overview.activePreset();
    const bracketMask = this.overview.activeBracketPreset();
    const bracketSimNow = this.live.effectSimNow();
    const relations = overviewMask?.filteredStates.length || bracketMask?.filteredStates.length
      ? this.options.overviewRelationships?.()
      : undefined;
    for (const e of snap?.entities ?? []) {
      seen.add(e.itemID);
      if (e.typeID) this.typeOfID.set(e.itemID, e.typeID);
      // relative to the ship, in doubles, then mirrored into three's handedness
      const rel = tmp.set(e.position.x - origin.x, e.position.y - origin.y, -(e.position.z - origin.z));
      let mark = this.marks.get(e.itemID);
      if (!mark) { mark = this.markFor(e); this.marks.set(e.itemID, mark); this.scene.add(mark); }
      this.updateMarkModel(mark, e);
      if (e.kind === "asteroid") this.asteroidModels.update(mark, e, bracketSimNow ?? now);
      mark.position.copy(rel);
      this.orient(mark, e);
      if (e.typeID === METENOX_TYPE_ID) {
        const slim = park.slimItems.get(e.itemID);
        if (slim) {
          const moonID = Number(slim.get("moonID"));
          const moon = snap?.entities.find(candidate => candidate.itemID === moonID && candidate.kind === "moon");
          updateMetenoxPresentation(mark, slim, e.position, moon, settings.shaderQuality);
        } else hideMetenoxBeam(mark);
      }
      const vortex = mark.userData.vortex as ObservatoryVortex | undefined;
      vortex?.update(e.radius, settings.volumetricQuality, this.renderer, this.sunDir, rendering.shadows);
      if (reflectClouds && e.radius > 0 && vortex?.reflection) reflectionSources.push(vortex.reflection);
      if (e.radius > 0 && vortex?.mesh.visible) {
        if (rendering.shadows) shadowClouds.push(vortex.mesh);
        cloudVolumes.push(vortex);
      }
      // a drone's engines burn always (Drone.py: FitBoosters(alwaysOn=True)); a fighter's do not
      mark.userData.boostersAlwaysOn = e.kind === "drone";
      if (e.maxVelocity || mark.userData.boostersAlwaysOn) setThrust(mark, e.maxVelocity ? Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z) / e.maxVelocity : 0, this.accelOf(mark, e));
      setShipSpeed(mark, Math.hypot(e.velocity.x, e.velocity.y, e.velocity.z), e.maxVelocity ?? 0);
      // the ship's warp (ship.py: EnterWarp / ExitWarp set IsWarping; on load, a ball in warp mode)
      setControllerVariable(mark, "IsWarping", e.mode === "WARP" ? 1 : 0);
      if (e.hackingSecurityState !== undefined) setControllerVariable(mark, "SecurityState", e.hackingSecurityState);
      if (this.wormholeAudio.has(e.itemID)) {
        const effect = mark.children[0];
        if (effect) {
          updateWormholePose(mark, park.slimItems.get(e.itemID), mark.userData.ordinaryWormhole === true);
          setEffectShaderQuality(effect, settings.shaderQuality);
        }
      }
      const polarization = this.polarizationOf(e, bracketSimNow);
      // a ship's turrets fitted again where its slim item's modules changed (looked at now and then)
      if ((e.kind === "ship" || e.kind === "drone") && this.frameCount % 30 === 0) this.fitTurrets(e.itemID, mark);
      if (e.kind === "sun") {
        this.sunDir.copy(rel).normalize();
        sun = { position: mark.position, radius: e.radius };
      } else if (rendering.shadows && (e.kind === "planet" || e.kind === "moon")) {
        shadowPlanets.push({ center: mark.position, radius: e.radius });
      }
      let el = this.bracketEls.get(e.itemID);
      const highlighted = this.highlightedObjective === e.itemID;
      const selectedOrTargeted = highlighted || this.selected === e.itemID || this.activeTarget === e.itemID ||
        this.locked.has(e.itemID) || this.lockingIDs.has(e.itemID) || this.acquiringTargets.has(e.itemID);
      const groupID = this.overview.groupOf(e);
      if (groupID === JUMP_BRIDGE_GROUP) this.positionJumpBridge(e, snap?.ship ?? null, rel, w, h);
      const wanted = gridBracketWanted(e, groupID, bracketMask, overviewMask, {
        override: this.bracketOverride,
        showSpecials: this.showSpecialBrackets,
        selectedOrTargeted,
        hasBracketData: hasBracketData(groupID === e.groupID ? e : { ...e, groupID }),
      }, relations);
      if (!wanted) {
        if (el) {
          el.classList.remove("objective-highlight");
          el.style.display = "none";
        }
        continue;
      }
      const hackingState = e.hackingSecurityState?.toString() ?? "";
      if (!el) {
        el = document.createElement("div");
        el.className = "bracket";
        el.innerHTML = `${glyph(e)}<div class="label"></div>`;
        el.dataset.hackingState = hackingState;
        const id = e.itemID;
        el.dataset.id = String(id);
        el.addEventListener("click", (ev) => { ev.stopPropagation(); this.select(id); });
        el.addEventListener("dblclick", (ev) => { ev.stopPropagation(); this.activateSpaceTarget(id); });
        el.classList.toggle("locked", this.locked.has(id));
        el.classList.toggle("targeting-me", this.targeters.has(id));
        el.classList.toggle("selected", this.selected === id);
        this.brackets.appendChild(el);
        this.bracketEls.set(e.itemID, el);
      } else if (el.dataset.hackingState !== hackingState) {
        el.firstElementChild!.outerHTML = glyph(e);
        el.dataset.hackingState = hackingState;
      }
      el.classList.toggle("objective-highlight", highlighted);
      if (polarization && bracketSimNow !== undefined) {
        const label = el.querySelector<HTMLElement>(".label")!;
        const remaining = polarization.expiresAt - bracketSimNow;
        const text = `${this.actions.word?.(POLARIZED_LABEL) ?? "Polarized"}: ${polarizationTime(remaining)}`;
        if (label.dataset.polarization !== text) label.dataset.polarization = text;
        el.style.setProperty("--polarization-sweep", `${Math.min(1, remaining / polarization.durationMs)}turn`);
        el.classList.add("polarized-wormhole");
      } else if (el.classList.contains("polarized-wormhole")) {
        el.classList.remove("polarized-wormhole");
        el.style.removeProperty("--polarization-sweep");
        delete el.querySelector<HTMLElement>(".label")!.dataset.polarization;
      }
      const p = rel.clone().project(this.camera);
      const onScreen = p.z < 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
      el.style.display = onScreen ? "" : "none";
      if (onScreen) {
        el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`;
        if (this.selected === e.itemID || el.classList.contains("mining-selected")) this.updateMiningBracket(el, e, survey);
        if (this.frameCount % 10 === 0 || highlighted || el.classList.contains("selected")) {
          el.querySelector<HTMLElement>(".label")!.textContent = `${this.nameOf(e)} - ${distanceWords(this.distanceTo(e))}`;
        }
      }
    }
    this.updateMiningHold(survey, ego, w, h);
    for (const [id, el] of this.bracketEls) if (!seen.has(id)) { el.remove(); this.bracketEls.delete(id); }
    for (const id of this.polarization.keys()) if (!seen.has(id)) this.polarization.delete(id);
    for (const [id, panel] of this.jumpBridgePanels) {
      if (seen.has(id)) continue;
      panel.destroy();
      panel.host.remove();
      this.jumpBridgePanels.delete(id);
    }
    if (snap) this.overview.update(snap.entities, (x) => this.distanceTo(x), relations, snap.ship);
    const jump = this.gateJump;
    let wormholeStopElapsed: number | null = null;
    if (jump?.wormhole && jump.arrivedAt !== null && now - jump.orderedAt >= WORMHOLE_MIDDLE_MS) {
      const sim = this.live.effectSimNow() ?? now;
      jump.wormhole.stopSimAt ??= sim;
      wormholeStopElapsed = sim - jump.wormhole.stopSimAt;
    }
    if (!this.stepJumpCamera(now, ego, wormholeStopElapsed) && !this.stepExplosionCamera(now, dt, ego)) {
      if (ego && this.framedFor !== ego.itemID) {
        this.framedFor = ego.itemID;
        this.frameShip(ego.radius);
        if (gfx().dynamicCameraMovement && this.options.undocking?.()) this.startUndockCamera(ego);
      }
      this.stepUndockCamera();
      this.stepEntryCamera(now, systemID, snap);
      // Keep the eye and target together as the looked-at ball moves.
      if (this.lookAt !== null && !seen.has(this.lookAt)) this.lookAt = null;
      const looked = this.lookAt === null ? null : this.marks.get(this.lookAt);
      const want = looked?.position ?? new THREE.Vector3();
      const shift = want.clone().sub(this.controls.target);
      const focused = shift.lengthSq() === 0
        || translateCameraPose(this.camera.position, this.controls.target, shift);
      // Authored landmarks can have a much smaller collision ball than their visual model.
      if (focused && this.lookAt !== this.framedLook) {
        this.framedLook = this.lookAt;
        const model = looked?.userData.model as THREE.Object3D | undefined;
        const visualRadius = looked?.userData.useAuthoredBounds
          ? (model?.userData.boundingSphere as number[] | null | undefined)?.[3] ?? (model?.userData.radius as number | undefined)
          : undefined;
        const size = visualRadius ?? (this.lookAt !== null ? snap?.entities.find((e) => e.itemID === this.lookAt)?.radius ?? null : ego?.radius ?? null);
        if (size !== null) this.frameShip(size);
      }
      if (this.trackedObjective !== null) {
        const tracked = seen.has(this.trackedObjective) ? this.marks.get(this.trackedObjective) : null;
        if (tracked) {
          const direction = tracked.position.clone().sub(this.controls.target);
          if (direction.lengthSq() > 0) this.aimSpaceCamera(direction);
        } else {
          this.trackedObjective = null;
        }
      }
    }
    const collapseTime = this.live.effectSimNow() ?? now;
    for (let i = this.collapsingWormholes.length - 1; i >= 0; i--) {
      const { mark, audio, until } = this.collapsingWormholes[i]!;
      if (collapseTime >= until) {
        mark.removeFromParent();
        audio.dispose();
        this.collapsingWormholes.splice(i, 1);
      } else mark.position.add(moved);
    }
    for (const [id, m] of this.marks) if (!seen.has(id)) {
      // where it went from, for a moment, in the system's own frame (an explosion is drawn where a ball was)
      this.gone.set(id, { x: m.position.x + origin.x, y: m.position.y + origin.y, z: m.position.z - origin.z, radius: m.userData.radius ?? null, at: performance.now() });
      const audio = this.wormholeAudio.get(id);
      if (audio && m.children.length && m.userData.wormholeTerminal === this.live.resets) {
        m.position.add(moved);
        setControllerVariable(m, "WH_State", 0);
        this.collapsingWormholes.push({ mark: m, audio, until: collapseTime + WORMHOLE_COLLAPSE_MS });
      } else {
        if (!this.collectionExplosions.holdModel(id, m)) this.scene.remove(m);
        audio?.dispose();
      }
      this.wormholeAudio.delete(id);
      (m.userData.vortex as ObservatoryVortex | undefined)?.dispose();
      hideMetenoxBeam(m);
      this.marks.delete(id);
    }
    this.collectionExplosions.update(origin, this.live.simNow());
    for (const [id, g] of this.gone) if (performance.now() - g.at > 5000) this.gone.delete(id);

    const cap = this.options.rack?.capacitor?.().ratio ?? ego?.capacitorRatio ?? null;
    this.updateShipAlerts(ego, cap, performance.now());
    this.updateIndication(snap, performance.now());
    if (ego) {
      const speed = Math.hypot(ego.velocity.x, ego.velocity.y, ego.velocity.z);
      this.shipHud.update({
        shieldRatio: ego.shieldRatio ?? null, armorRatio: ego.armorRatio ?? null, hullRatio: ego.hullRatio ?? null,
        // The capacitor from the app's session where there is one (its fitting's capacitor total, the space read's
        // ratio); a ship's own capacitor is not in the park's slim item.
        capacitorRatio: cap,
        capacitorMax: this.options.rack?.capacitor?.().max ?? null,
        speed, maxSpeed: ego.maxVelocity ?? null, warping: ego.mode === "WARP",
        // the ring segments by each pool's max HP (shieldCapacity 263, armorHP 265, hp 9), the wanted speed fraction
        shieldMax: this.actions.shipAttribute?.(263) ?? null, armorMax: this.actions.shipAttribute?.(265) ?? null, hullMax: this.actions.shipAttribute?.(9) ?? null,
        desiredRatio: ego.speedFraction ?? null,
        // the racks' heat (the ship's heatLow / heatMed / heatHi over their capacities, as the BFF's dogma reckons
        // them: the app's space snapshot, not this view's park)
        ...(() => { const h = this.options.rack?.heat?.(); return { heatLow: h?.low, heatMed: h?.mid, heatHi: h?.high }; })(),
      });
      if (this.shipHud instanceof NewShipHud) {
        // the cargo indicator's holds, as the mining read keeps them: read once for each ship flown (the client's
        // HoldTracker reads the ship's holds as it loads), then kept by the item notices
        if (this.holdsReadFor !== ego.itemID) {
          this.holdsReadFor = ego.itemID;
          void this.actions.loadShipHolds?.();
        }
        const holds = this.options.miningSurvey?.()?.holds ?? [];
        // the cargo indicator names each hold as the client does (invControllers.GetNameForFlag: "Mining Hold", "Cargo Hold")
        const holdWords = this.options.indicationWords?.() ?? {};
        const holdName = (key: string, own: string) => {
          const hold = key === CARGO_HOLD.bayKey ? CARGO_HOLD : SHIP_HOLDS.find((x) => x.bayKey === key);
          const t = hold ? holdWords[hold.label] : null;
          return typeof t === "string" && t !== "" ? plainText(t) : own;
        };
        this.shipHud.setHolds(holds.filter((h) => h.present).map((h) => ({ key: h.key, label: holdName(h.key, h.label), used: h.capacity?.used ?? null, capacity: h.capacity?.capacity ?? null })), ego.typeID);
        this.shipHud.setAutopilot(this.actions.autopilotOn?.() ?? false);
      }
    }
    // The warp tunnel, along the ship's way (mirrored into three's handedness as positions are), as strong as the
    // client's binding of the ship's speed makes it.
    const egoSpeed = ego ? Math.hypot(ego.velocity.x, ego.velocity.y, ego.velocity.z) : 0;
    const way = ego && egoSpeed > 0 ? new THREE.Vector3(ego.velocity.x, ego.velocity.y, -ego.velocity.z).divideScalar(egoSpeed) : new THREE.Vector3();
    let share = WarpTunnel.share(ego?.mode === "WARP", egoSpeed);
    // Warp.py: once the warp's speed fraction passes 0.005, ship_warp_explosion_play and ship_warp_wind_play (sent as UI
    // events); at its end ship_warp_wind_stop. (The tunnel's share is that binding of the ship's speed.)
    if (ego?.mode === "WARP") {
      if (!this.warpSound.exploded && share > 0.005) {
        void playUiEvent("ship_warp_explosion_play");
        void playUiEvent("ship_warp_wind_play");
        this.warpSound = { exploded: true, wind: true };
      }
    } else if (this.warpSound.exploded) {
      void playUiEvent("ship_warp_wind_stop");
      this.warpSound = { exploded: false, wind: false };
    }
    let tunnelWay = way;
    let flash = 0;
    if (this.gateJump) {
      const since = now - this.gateJump.orderedAt;
      const after = this.gateJump.arrivedAt === null ? null : now - this.gateJump.arrivedAt;
      if (this.gateJump.wormhole) {
        this.wormholeTransit.update(now, wormholeStopElapsed !== null, settings.shaderQuality, this.sunDir);
        if (wormholeStopElapsed !== null && wormholeStopElapsed >= WORMHOLE_STOP_MS) this.endJumpCamera();
      } else {
        const strength = after === null ? Math.min(1, since / 1500) : Math.max(0, 1 - after / 2000);
        flash = after === null ? 0 : Math.max(0, 0.85 - after / 700);
        if (after !== null && after > 2000) this.endJumpCamera();
        share = Math.max(share, strength);
      }
      if (after === null && since > 20_000) this.endJumpCamera();
    }
    // a ship that is not moving (at a gate, or come out of one) has no way of its own: the camera's, so the tunnel eases out
    if (way.lengthSq() < 0.5) tunnelWay = this.camera.getWorldDirection(new THREE.Vector3());
    this.flashEl.style.opacity = flash.toFixed(3);
    this.warpTunnel.update(this.camera, this.controls.target, tunnelWay, share, dt);
    this.turretFx.setResolution(innerWidth, innerHeight);
    this.turretFx.onShot = this.onShot;
    this.turretFx.onFire = (ship, moduleID, target) => { this.fireTurretSet(ship, moduleID, target); };
    // a firing's sounds, each at its key's time from the effect's start, from the shooter (TurretFX) or the target
    // (TurretImpact) - placed where they are then, in the view's frame
    this.turretFx.onSound ??= (sounds, shooter, target, startAt) => {
      for (const s of sounds) {
        const id = s.at === "target" ? target : shooter;
        if (id === null) continue;
        window.setTimeout(() => {
          const at = this.placeOf(id, this.lastOrigin);
          if (at) void playWorldEvent(s.event, at);
        }, Math.max(0, startAt - performance.now()) + s.time * 1000);
      }
    };
    this.updateAmbient();
    // the listener: the camera
    {
      const fwd = this.camera.getWorldDirection(new THREE.Vector3());
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      setListener(this.camera.position, fwd, up);
    }
    for (const audio of this.wormholeAudio.values()) audio.move();
    this.missileFx.onLaunch = (ship, moduleID, target) => {
      const delay = this.fireTurretSet(ship, moduleID, target);
      // the launcher's firing effect (turretFx.launch): its type from the ship's slim item's modules
      const typeID = this.moduleTypeOf(ship, moduleID);
      if (typeID) this.turretFx.launch(ship, moduleID, typeID, target, delay);
      return delay;
    };
    this.turretFx.damageLocatorOf = (target, from) => {
      const mark = this.marks.get(target);
      const impact = mark?.userData.impact as ImpactOverlay | undefined;
      if (impact) return impact.locatorPosition(impact.locatorFacing(from));
      // An asteroid: the client's SOF rock carries a damage locator set over its surface (55 on a Veldspar
      // rock_01_m, read through gridcheck) and the beam ends on the one facing the shooter
      // (EveTurretTarget::GetImpactPosition, DAMAGE_LOCATOR). The rock drawn here is the page's own, without locators:
      // the point of its surface the shooter's line to its centre meets stands for that locator.
      const rock = mark ? this.asteroidModels.meshOf(mark) : undefined;
      if (!mark || !rock) return null;
      rock.updateWorldMatrix(true, false);
      const centre = new THREE.Vector3().setFromMatrixPosition(rock.matrixWorld);
      const dir = centre.clone().sub(from);
      const dist = dir.length();
      if (!(dist > 0)) return null;
      surfaceRay.set(from, dir.divideScalar(dist));
      surfaceRay.far = dist;
      const hit = surfaceRay.intersectObject(rock, false)[0];
      return hit ? hit.point.clone() : null;
    };
    this.turretFx.muzzleOf = (ship, moduleID, shot, target) => {
      const m = this.muzzleOf(ship, moduleID, shot, target, origin);
      return m ? new THREE.Vector3().setFromMatrixPosition(m) : null;
    };
    this.turretFx.update((id) => this.placeOf(id, origin), now, (id) => this.snapshot?.entities.find((e) => e.itemID === id)?.radius ?? this.gone.get(id)?.radius ?? null, this.camera, this.renderer);
    // the ShipEffects at their balls: the model's bounding sphere radius (GetBoundingSphereRadius: its SOF hull's),
    // else the ball's
    this.shipFx.update((id) => {
      const position = this.placeOf(id, origin);
      if (!position) return null;
      const mark = this.marks.get(id);
      const model = mark?.userData.model as THREE.Object3D | undefined;
      const sphere = model?.userData.boundingSphere as number[] | null | undefined;
      const radius = sphere?.[3] ?? this.snapshot?.entities.find((e) => e.itemID === id)?.radius ?? null;
      // its model's local box (the first level's meshes, in the model's frame), kept; its centre where the model is now
      let box = model?.userData.localBox as { min: THREE.Vector3; max: THREE.Vector3 } | undefined;
      if (model && !box) {
        const b = new THREE.Box3();
        const level = (model as THREE.LOD).levels?.[0]?.object ?? model;
        model.updateWorldMatrix(true, true);
        const toModel = model.matrixWorld.clone().invert();
        level.traverse((o) => {
          const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
          if (!(o as THREE.Mesh).isMesh || !g?.attributes?.position) return;
          if (!g.boundingBox) g.computeBoundingBox();
          b.union(g.boundingBox!.clone().applyMatrix4(toModel.clone().multiply(o.matrixWorld)));
        });
        if (!b.isEmpty()) { box = { min: b.min, max: b.max }; model.userData.localBox = box; }
      }
      const centre = box && model ? box.min.clone().add(box.max).multiplyScalar(0.5).applyMatrix4(model.matrixWorld) : null;
      // (three's scene is shifted by the view's origin as placeOf is: the centre is in the same space)
      return {
        position, radius, quaternion: mark?.quaternion ?? null,
        box: box && centre ? { min: box.min, max: box.max, centre } : null,
        ellipsoid: model && "shapeEllipsoid" in model.userData ? (model.userData.shapeEllipsoid as { center: number[]; radius: number[] } | null) : undefined,
      };
    }, now);
    this.stepMissiles(origin, moved, dt);
    this.stepTurrets(origin, dt);
    this.stepImpacts(dt);
    // The rack: the ship's fitted modules, which are running and how far through their cycles, as the app's session
    // keeps them; often enough for the cycle sweep to move smoothly.
    const rack = this.options.rack;
    if (rack && this.frameCount % 3 === 0) {
      const overload = rack.overload;
      const modules = rack.modules();
      if (this.shipHud instanceof NewShipHud && rack.slotCounts) this.shipHud.setSlotCounts(rack.slotCounts());
      if (this.shipHud instanceof NewShipHud && rack.slotOrder) this.shipHud.setSlotOrder(rack.slotOrder());
      if (this.shipHud instanceof NewShipHud && rack.dropSlot && !this.shipHud.onDropSlot) {
        const drop = rack.dropSlot;
        this.shipHud.onDropSlot = (to, from, peel) => void this.act("Move module", () => drop(to, from, peel));
      }
      if (this.shipHud instanceof NewShipHud && rack.capacitorFlow) this.shipHud.setCapacitorFlow(rack.capacitorFlow());
      if (this.moduleTargetOrders.size) this.finishModuleTargetOrders(modules);
      for (const m of modules) m.waitingForTarget = !!this.moduleTargetOrders.get(m.itemID)?.mode;
      this.shipHud.setModules(modules, (m) => this.useRackModule(m), overload ? {
        module: (m, on) => void this.act(m.name ?? "Module", () => overload.module(m.itemID, on)),
        rack: (id, on) => void this.act(on ? "Overload rack" : "Stop overloading rack", () => overload.rack(id, on)),
      } : undefined);
    }
    if (this.frameCount % 15 === 0) {
      this.renderSelected();
      this.feedEl.textContent = `${this.live.status} · tick ${park.currentTime % 100000} · ${snap?.entities.length ?? 0} on grid · ${this.live.items} updates${this.live.failures.length ? ` · ${this.live.failures.length} failed` : ""}`;
    }
    this.updateTargetBar();
    // target.GetActiveTargetID for the page's windows and shortcuts
    const active = this.activeLock();
    if (activeTargetID.get() !== active) {
      activeTargetID.set(active);
      const e = active !== null ? this.snapshot?.entities.find((x) => x.itemID === active) : undefined;
      activeTargetName.set(e ? this.nameOf(e) : null);
    }
    if (this.controls.enabled) this.controls.update();
    // the shake: the point looked at moved across the view for this frame (the controls look at their target again next)
    const shaken = this.shake.offset(this.camera.position, this.controls.target, dt);
    if (shaken) this.camera.lookAt(this.controls.target.clone().add(shaken));
    // the system menu's settings (gfxSettings.ts): the turrets' and missiles' effects
    this.turretFx.group.visible = settings.turretsEnabled;
    this.missileFx.group.visible = settings.missilesEnabled;
    // fxSequencer: with Effects off the ship effects (not the turrets') are disabled
    this.shipFx.group.visible = settings.effectsEnabled;
    this.miningSurvey.group.visible = settings.effectsEnabled;
    const surveyTime = this.miningSurveyUsesSimClock ? this.live.effectSimNow() : now;
    if (surveyTime !== undefined) this.miningSurvey.update(surveyTime, ego, id => {
      const mark = this.marks.get(id);
      if (!mark) return undefined;
      const rock = this.asteroidModels.meshOf(mark);
      return rock ? { position: mark.position, visibleRadius: rock.scale.x, geometry: rock.geometry, rotation: rock.quaternion }
        : { position: mark.position, visibleRadius: mark.userData.model ? undefined : mark.userData.standInRadius };
    });
    // Drone.py IsDroneModelEnabled: a player's drone without its model (an empty ship holding its turret locator);
    // EveSpaceObject2::UpdateVisibility: a space object whose estimated size across (TriFrustum::GetPixelSizeAccrossEst:
    // its radius / its distance x P[0][0] x the viewport's width) is below the LOD quality's visibility threshold is
    // not drawn (3 / 6 / 15 px; the pilot's own ship, the celestials and the missiles not this way)
    this.droneModels = settings.droneModelsEnabled;
    const threshold = lodSettings(settings).visibility;
    const eye = this.camera.getWorldPosition(new THREE.Vector3());
    const across = (this.camera.projectionMatrix.elements[0] ?? 1) * this.renderer.domElement.width;
    let culled = 0, boostersHidden = 0, boostersFar = 0, childMeshesHidden = 0, outOfView = 0;
    this.camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const lod = lodSettings(settings), ahead = this.camera.getWorldDirection(new THREE.Vector3()), centre = new THREE.Vector3();
    for (const [id, m] of this.marks) {
      const model = m.userData.model as THREE.Object3D | undefined;
      if (!model) continue;
      const radius = Number(m.userData.radius) || 0;
      const bounds = id === ego?.itemID ? null : this.boundsOf(model, m, radius);
      const visualRadius = m.userData.useAuthoredBounds ? bounds?.radius ?? radius : radius;
      const detailCentre = m.userData.useAuthoredBounds ? bounds?.center ?? m.position : m.position;
      const pixels = bounds ? (visualRadius / Math.max(detailCentre.distanceTo(eye), 1e-5)) * across : Infinity;
      // and only where its bounding sphere with children is in the view's frustum (m_isInFrustum: an object behind the
      // camera or off to the side is not drawn at all - its children, effects and lights with it)
      const inView = bounds === null || frustum.intersectsSphere(bounds);
      const shown = inView && pixels >= threshold && (!m.userData.playerDrone || this.droneModels);
      if (!(pixels >= threshold)) culled++;
      else if (!inView) outOfView++;
      if (model.visible !== shown) model.visible = shown;
      // EveBoosterSet2Renderable::UpdateVisibility: the boosters' LOD 2 x their padded sphere's size across
      // (TriFrustum::GetPixelSizeAccross: radius / depth x P[0][0] x the width; the eye inside it: no limit) - drawn
      // above the low detail threshold, their glows with them (flareLodEnabled)
      const boosters = shown ? this.named(model, "boosters") : undefined;
      const s = boosters?.userData.boosterSphere as { x: number; y: number; z: number; r: number } | undefined;
      if (boosters && s) {
        boosters.localToWorld(centre.set(s.x, s.y, s.z));
        const r = s.r * Math.abs(boosters.getWorldScale(new THREE.Vector3()).x);
        const rel = centre.sub(eye);
        const size = rel.lengthSq() < r * r ? Infinity : (r / Math.max(1e-5, rel.dot(ahead))) * across;
        const on = 2 * size > lod.lowDetail;
        if (!on) boostersHidden++;
        if (boosters.visible !== on) boosters.visible = on;
        // and their effect: the high LOD above the medium detail threshold x 1.5, else the far one
        const flames = this.named(boosters, "booster-volumetric");
        if (flames && useFarBoosters(flames, !(2 * size > lod.mediumDetail * 1.5))) boostersFar++;
      }
      // its child meshes with a minScreenSize: each drawn where its sphere's size across (GetPixelSizeAccross) / the
      // LOD factor is at least that (EveChildMesh::UpdateVisibility; their own lowestLodVisible not extracted)
      if (shown) {
        // EveSpaceObject2::UpdateVisibility: its LOD with children by its size across - above the medium detail
        // threshold high (2), above the low one medium (1), else low (0)
        const parentLod = pixels > lod.mediumDetail ? 2 : pixels > lod.lowDetail ? 1 : 0;
        childMeshesHidden += this.gateChildMeshes(model, parentLod, eye, ahead, across, lod.lodFactor, 120);
      }
    }
    // the effects' child meshes too (missiles' explosions, ship effects): EveEffectRoot2 passes its children its LOD -
    // HIGH but where dynamicLOD (41 of 228 effect files; none of their meshes has a lowestLodVisible above low), so
    // only their minScreenSize acts (775 of the 783 meshes under the dynamic ones have one)
    childMeshesHidden += this.gateChildMeshes(this.missileFx.group, 2, eye, ahead, across, lod.lodFactor, 30);
    childMeshesHidden += this.gateChildMeshes(this.shipFx.group, 2, eye, ahead, across, lod.lodFactor, 30);
    this.lodCulled = culled;
    this.frustumCulled = outOfView;
    this.lodBoostersHidden = boostersHidden;
    this.lodBoostersFar = boostersFar;
    this.lodChildMeshesHidden = childMeshesHidden;
    this.missileFx.explosionLimit = settings.lodQuality * 30;
    if (this.options.covered?.()) return;
    this.updateReflections(eye, settings.reflectionQuality, reflectionSources);
    this.sunLight.position.copy(this.sunDir);
    setSmartLightSimulationTime(this.camera, this.live.effectSimNow());
    const ambientOcclusion = settings.shaderQuality === 1 ? 0 : settings.aoQuality;
    this.spaceShadows.render(this.scene, this.camera, this.sunDir, rendering.shadows, shadowClouds, shadowPlanets, sun?.position ?? null, ambientOcclusion);
    this.bloom ??= bloomFor(this.renderer, this.scene, this.camera, {
      exposure: () => this.exposure, toneMap: 0, quality: () => spaceRendering(),
      depthEffects: () => gfx().shaderQuality === 3, shadows: this.spaceShadows,
    });
    const simDt = dt * (this.options.flightSnapshot?.()?.timeDilation ?? 1);
    const environment = this.observatoryEnvironment.sample(ego ? snap?.entities ?? [] : [], origin, eye, simDt, rendering.postProcess, systemID);
    let scattering = false;
    const wantsScattering = (m: THREE.Material) => m.visible && m.userData.cloudFogScattering &&
      (settings.shaderQuality > 1 || m.userData.cloudFogScatteringLow);
    if (cloudVolumes.length) this.scene.traverseVisible((object) => {
      if (scattering) return;
      const material = (object as THREE.Mesh).material;
      scattering = Array.isArray(material) ? material.some(wantsScattering) : !!material && wantsScattering(material);
    });
    const clouds = cloudVolumes.length
      ? { meshes: cloudVolumes.map((vortex) => vortex.cloudOpacityMesh(scattering)), quality: settings.volumetricQuality, scattering }
      : undefined;
    this.bloom.render(environment, sun, clouds);
  }

  /** Show acquisition from the request through confirmation, refusal or cancellation. */
  private async lockTracked(id: number, request = () => this.actions.lock(id)): Promise<void> {
    if (this.lockingIDs.has(id)) return;
    const startedAt = this.lockNow();
    this.lockingIDs.set(id, startedAt);
    try {
      await request();
    } finally {
      await this.refreshTargets();
      if (this.lockingIDs.get(id) === startedAt) this.lockingIDs.delete(id);
    }
  }

  /** The client measures targeting in simulation time. */
  private lockNow(): number {
    const wallTime = performance.now();
    this.lockSimTime += (wallTime - this.lockWallTime) * (this.options.flightSnapshot?.()?.timeDilation ?? 1);
    this.lockWallTime = wallTime;
    return this.lockSimTime;
  }

  private lockTimeFor(entity: Entity | undefined, scanResolution: number | null): number | null {
    const targeting = this.options.targeting;
    if (!targeting || !entity) return null;
    const typeID = entity.typeID;
    if (typeID === null) return targetLockDurationMs(scanResolution, null, entity.radius, null);
    if (!this.targetLockRadii.has(typeID)) {
      this.targetLockRadii.set(typeID, null);
      void targeting.typeRadii(typeID).then(
        (radii) => this.targetLockRadii.set(typeID, radii),
        () => this.targetLockRadii.set(typeID, { signatureRadius: null, typeRadius: null }),
      );
    }
    const radii = this.targetLockRadii.get(typeID);
    return radii ? targetLockDurationMs(scanResolution, radii.signatureRadius, entity.radius, radii.typeRadius) : null;
  }

  /** The target bar from the locked set, in lock order; a target being locked gets its indicator on its bracket. */
  private updateTargetBar(): void {
    const byID = new Map((this.snapshot?.entities ?? []).map((e) => [e.itemID, e]));
    if (this.activeTarget !== null && !this.locked.has(this.activeTarget)) this.activeTarget = null;
    const entries: TargetBarEntry[] = [];
    const survey = this.locked.size ? this.options.miningSurvey?.() : undefined;
    for (const id of this.locked) {
      const e = byID.get(id) as (Entity & { shieldRatio?: number | null; armorRatio?: number | null; hullRatio?: number | null }) | undefined;
      if (!e) continue;
      // targetMgr.OnTargetAdded: with no active target, the new one becomes it
      if (this.activeTarget === null) this.activeTarget = id;
      const miningProgress = survey?.surveyProgress.get(id);
      const remainingQuantity = miningProgress ? survey?.survey.find(row => row.itemID === id)?.remainingQuantity : null;
      const mining = miningProgress && remainingQuantity != null ? { ...miningProgress, remainingQuantity } : undefined;
      entries.push({
        // (targetInBar.SetTargetLabel: uix.GetSlimItemName - its own name, else its type's, as an NPC's)
        itemID: id, typeID: e.typeID, name: this.targetLabelOf(e), distance: this.distanceTo(e),
        shieldRatio: e.shieldRatio ?? null, armorRatio: e.armorRatio ?? null, hullRatio: e.hullRatio ?? null,
        locking: false, active: id === this.activeTarget, mining,
      });
    }
    const pending = this.lockingIDs.size ? new Map([...this.acquiringTargets, ...this.lockingIDs]) : this.acquiringTargets;
    const shipID = this.snapshot?.ship?.itemID;
    const scanResolution = pending.size && shipID != null ? this.options.targeting?.scanResolution(shipID) ?? null : null;
    for (const [id, startedAt] of pending) {
      if (this.locked.has(id)) continue;
      const e = byID.get(id);
      entries.push({
        itemID: id, typeID: e?.typeID ?? null, name: e ? this.targetLabelOf(e) : null, distance: e ? this.distanceTo(e) : 0,
        shieldRatio: null, armorRatio: null, hullRatio: null, locking: true, active: false,
        lockTimeMs: this.lockTimeFor(e, scanResolution),
        lockStartedAt: startedAt,
      });
    }
    const win = this.selectedWin.root.style;
    this.targetBar.setAnchor({ left: parseFloat(win.left) || innerWidth - 480, top: parseFloat(win.top) || 15, width: parseFloat(win.width) || 464 });
    const lockedText = pending.size ? this.actions.word?.(TARGET_LOCKED_LABEL) ?? undefined : undefined;
    this.targetBar.update(entries, this.lockNow(), lockedText, this.snapshot?.ship ? byID : undefined);
    for (const id of pending.keys()) {
      const el = this.bracketEls.get(id), ind = this.targetBar.lockingIndicator(id);
      if (el && ind && ind.parentElement !== el) el.appendChild(ind);
    }
  }

  /**
   * A ball's holder in the scene: a stand-in at once, the type's own model from the client when it has come
   * (hullModel.ts). An EVE hull's nose is +z in its own space, so -z once mirrored: the model is turned half
   * round inside the holder, and the holder's +z is pointed where the ship is going (orient).
   */
  private markFor(e: Entity): THREE.Object3D {
    const holder = new THREE.Group();
    if (e.typeID === DRIFTER_COLLECTION && gfx().explosionEffectsEnabled) this.collectionExplosions.preload();
    // a missile's ball draws nothing of its own: its warheads are drawn by missileFx
    if (e.kind === "missile") { holder.userData = { kind: e.kind, radius: e.radius }; return holder; }
    const ordinary = e.groupID === WORMHOLE_GROUP;
    if (isNonInteractableWormhole(e.typeID) || ordinary) {
      holder.userData = { kind: e.kind, radius: e.radius, nonPickable: !ordinary, ordinaryWormhole: ordinary, wormholeTypeID: e.typeID };
      const audio = new WormholeAudio(e.itemID, holder);
      this.wormholeAudio.set(e.itemID, audio);
      const slim = this.live.park.slimItems.get(e.itemID);
      if (ordinary) this.wormholeTransit.preload(Number(slim?.get("nebulaType") ?? 0));
      const load = isNonInteractableWormhole(e.typeID) ? nonInteractableWormhole(e.typeID, audio.play)
        : ordinaryWormhole(e.typeID ?? 0, Number(slim?.get("nebulaType") ?? 0), audio.play);
      void load.then((effect) => {
        if (!effect || this.stopped || this.marks.get(e.itemID) !== holder) return;
        // SpaceObject.Prepare applies the slim first and the graphic's overrides before starting controllers.
        updateWormholePose(holder, this.live.park.slimItems.get(e.itemID), ordinary);
        for (const [name, value] of Object.entries(effect.overrides)) setControllerVariable(holder, name, value);
        holder.add(effect.object);
      }).catch((error: unknown) => console.warn("Wormhole effect:", error));
      return holder;
    }
    // repository.py uses the non-interactable classes for groups 1975 and 4579.
    if (e.groupID === 1975 || e.groupID === 4579) {
      holder.userData = { kind: e.kind, radius: e.radius, nonPickable: true };
      if (e.typeID === OBSERVATORY_VORTEX_TYPE) {
        void ObservatoryVortex.load(this.sunLight, this.spaceShadows).then((vortex) => {
          if (this.stopped || this.marks.get(e.itemID) !== holder) {
            vortex.dispose();
            return;
          }
          holder.userData.vortex = vortex;
          holder.add(vortex.mesh, vortex.shadow);
        }).catch((error: unknown) => console.warn("Observatory vortex:", error));
      } else if (e.typeID && e.groupID === 1975) {
        void typeModel(e.typeID).then((model) => {
          if (model && !this.stopped && this.marks.get(e.itemID) === holder) {
            holder.userData.smartLightAttachTimeMs = this.live.effectSimNow();
            holder.add(model);
          }
        }).catch(() => { /* An authored non-interactable object can have an empty model. */ });
      }
      return holder;
    }
    if (e.kind === "asteroid") {
      holder.userData = { kind: e.kind, radius: e.radius };
      return holder;
    }
    const big = ["station", "planet", "moon", "sun", "stargate", "structure"].includes(e.kind);
    const colour = e.kind === "sun" ? 0xffd27a : e.kind === "planet" || e.kind === "moon" ? 0x5d6f80 : big ? 0x7d8a94 : 0x6f7a82;
    const standInRadius = Math.max(Math.min(e.radius, big ? e.radius : 60), 5);
    const standIn = new THREE.Mesh(new THREE.SphereGeometry(standInRadius, big ? 48 : 12, big ? 32 : 8),
      e.kind === "sun" ? new THREE.MeshBasicMaterial({ color: colour }) : new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9, transparent: !e.isSelf && !["planet", "moon", "sun"].includes(e.kind), opacity: 0.35 }));
    holder.add(standIn);
    holder.userData = { kind: e.kind, radius: e.radius, standInRadius };
    const triggerRange = e.typeID === null ? undefined : PROXIMITY_TRAP_RANGES.get(e.typeID);
    if (triggerRange !== undefined) setControllerVariable(holder, "Blast_Scale", triggerRange);
    if (["planet", "moon", "sun"].includes(e.kind) && e.typeID) {
      // Each planet and moon from its own preset and height maps (the system's celestials), as the client draws it.
      const systemID = this.live.hello?.solarSystemID ?? null;
      const typeID = e.typeID;
      void (systemID ? systemCelestials(systemID) : Promise.resolve({} as Record<string, CelestialItem>))
        .then((items) => celestialModel(typeID, e.kind, e.radius, items[String(e.itemID)] ?? null, e.itemID)).then((model) => {
        if (!model || !this.marks.has(e.itemID)) return;
        holder.remove(standIn);
        holder.add(model);
      }).catch(() => { /* the stand-in stays */ });
    }
    // spaceObject/repository.py loads SOF models for Large Collidable Objects
    // and Structures. The live projection classifies both as celestials.
    const collidable = e.groupID === 226 || e.groupID === 319;
    holder.userData.useAuthoredBounds = collidable && e.dunObjectID != null;
    const modelled = collidable || !["planet", "moon", "sun", "celestial", "billboard"].includes(e.kind);
    if (modelled) this.markModels.set(holder, { standIn });
    return holder;
  }

  /** The current ship slim chooses the model variant, including updates while its ball stays in the park. */
  private updateMarkModel(holder: THREE.Object3D, e: Entity): void {
    const state = this.markModels.get(holder);
    if (!e.typeID || !state) return;
    const raw = this.live.park.slimItems.get(e.itemID)?.get("skinMaterialSetID");
    const id = typeof raw === "number" || typeof raw === "bigint" ? Number(raw) : 0;
    const skinMaterialSetID = Number.isSafeInteger(id) && id > 0 ? id : null;
    if (state.request?.typeID === e.typeID && state.request.skinMaterialSetID === skinMaterialSetID) return;
    const request = state.request = { typeID: e.typeID, skinMaterialSetID };
    if (e.isSelf && !holder.userData.model) holder.userData.loadingModel = true;
    void typeModel(e.typeID, skinMaterialSetID).then((model) => {
      if (!model || this.stopped || state.request !== request || this.marks.get(e.itemID) !== holder) return;
      if (!holder.userData.useAuthoredBounds) model.rotation.y = Math.PI;
      const previous = holder.userData.model as THREE.Object3D | undefined;
      if (previous) holder.remove(previous);
      if (state.standIn) {
        holder.remove(state.standIn);
        state.standIn.geometry.dispose();
        state.standIn.material.dispose();
        delete state.standIn;
      }
      holder.userData.smartLightAttachTimeMs = this.live.effectSimNow();
      holder.add(model);
      holder.userData.impact = impactOverlayOf(model);
      const dirtTime = this.live.park.slimItems.get(e.itemID)?.get("dirtTime");
      if (typeof dirtTime === "bigint" || typeof dirtTime === "number") setDirtLevel(holder, dirtLevelFromTime(dirtTime));
      holder.userData.spaceObject = true;
      holder.userData.model = model;
      if (holder.userData.useAuthoredBounds && this.lookAt === e.itemID) this.framedLook = null;
      if (e.kind === "drone") { holder.userData.playerDrone = true; model.visible = gfx().droneModelsEnabled; }
      if (e.kind === "ship" || e.kind === "drone") {
        delete holder.userData.turretSignature;
        this.fitTurrets(e.itemID, holder);
      }
    }).catch((error: unknown) => {
      // The previous model or stand-in stays visible; the failure is said, not swallowed.
      console.warn(`Type ${e.typeID} model:`, error);
    }).finally(() => {
      if (state.request === request) holder.userData.loadingModel = false;
    });
  }

  /** Point a moving ship's holder along its velocity, easing the turn as the client's ball does not jump. */
  /**
   * A ball's acceleration (three's world, m/s^2) for its engines: its velocity's change over the time since it last
   * changed, held until the next change (the space feed moves once a second).
   */
  private accelOf(mark: THREE.Object3D, e: Entity): THREE.Vector3 {
    const ud = mark.userData;
    const v = new THREE.Vector3(e.velocity.x, e.velocity.y, -e.velocity.z);
    const now = performance.now() / 1000;
    const last = ud.accelLastVelocity as THREE.Vector3 | undefined;
    if (!last) { ud.accelLastVelocity = v; ud.accelLastTime = now; ud.accel = new THREE.Vector3(); }
    else if (!last.equals(v)) {
      const dt = Math.max(1e-3, now - (ud.accelLastTime as number));
      ud.accel = v.clone().sub(last).divideScalar(dt);
      ud.accelLastVelocity = v;
      ud.accelLastTime = now;
    }
    return ud.accel as THREE.Vector3;
  }

  private orient(holder: THREE.Object3D, e: Entity): void {
    if (!["ship", "drone", "fighter"].includes(e.kind)) {
      if (e.dunRotation) {
        // SetStaticRotation mirrors the world Z axis on entry to the browser scene.
        const [yaw, pitch, roll] = e.dunRotation;
        holder.rotation.set(THREE.MathUtils.degToRad(-pitch), THREE.MathUtils.degToRad(-yaw), THREE.MathUtils.degToRad(roll), "YXZ");
      }
      return;
    }
    const v = new THREE.Vector3(e.velocity.x, e.velocity.y, -e.velocity.z);
    if (v.lengthSq() < 1) return;
    const want = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), v.normalize());
    holder.quaternion.slerp(want, 0.12);
  }
}
