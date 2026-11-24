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
/** openFunctions.GetOpenShipHoldMenus' entries in its order: [the page's bay key, label, own words]. */
const OPEN_HOLD_ENTRIES: readonly (readonly [string, string, string])[] = [["cargo", "UI/Commands/OpenCargoHold", "Open Cargohold"], ["drone", "UI/Commands/OpenDroneBay", "Open Drone Bay"], ["fighter", "UI/Commands/OpenFighterBay", "Open Fighter Bay"], ["shipMaintenance", "UI/Commands/OpenShipMaintenanceBay", "Open Ship Maintenance Bay"], ["fleet", "UI/Commands/OpenFleetHangar", "Open Fleet Hangar"], ["fuel", "UI/Commands/OpenFuelBay", "Open Fuel Bay"], ["ore", "UI/Commands/OpenGeneralMiningHold", "Open General Mining Hold"], ["gas", "UI/Commands/OpenGasHold", "Open Gas Hold"], ["mineral", "UI/Commands/OpenMineralHold", "Open Mineral Hold"], ["salvage", "UI/Commands/OpenSalvageHold", "Open Salvage Hold"], ["ship", "UI/Commands/OpenShipHold", "Open Ship Hold"], ["smallShip", "UI/Commands/OpenSmallShipHold", "Open Small Ship Hold"], ["mediumShip", "UI/Commands/OpenMediumShipHold", "Open Medium Ship Hold"], ["largeShip", "UI/Commands/OpenLargeShipHold", "Open Large Ship Hold"], ["industrialShip", "UI/Commands/OpenIndustrialShipHold", "Open Industrial Ship Hold"], ["ammo", "UI/Commands/OpenAmmoHold", "Open Ammo Hold"], ["commandCenter", "UI/Commands/OpenCommandCenterHold", "Open Command Center Hold"], ["planetary", "UI/PI/Common/OpenPlanetaryCommoditiesHold", "Open Planetary Commodities Hold"], ["quafe", "UI/Commands/OpenQuafeBay", "Open Quafe Bay"], ["corpse", "UI/Commands/OpenCorpseBay", "Open Corpse Bay"], ["booster", "UI/Commands/OpenBoosterBay", "Open Booster Bay"], ["subsystem", "UI/Commands/OpenSubsystemBay", "Open Subsystem Bay"], ["mobileDepot", "UI/Commands/OpenMobileDepotHold", "Open Mobile Depot Hold"], ["colony", "UI/Commands/OpenInfrastructureHold", "Open Infrastructure Hold"], ["expedition", "UI/Commands/OpenExpeditionHold", "Open Expedition Hold"]];
import { NewShipHud } from "./newShipHud.ts";
import { hudSetting, hudSettingNow, setHudSetting } from "../store/hudSettings.ts";
import { activeTargetID, activeTargetName } from "./activeTarget.ts";
import { WarpTunnel } from "./warpTunnel.ts";
import { WormholeTransit, WORMHOLE_START_MS, WORMHOLE_MIDDLE_MS, WORMHOLE_CAMERA_RETURN_MS, WORMHOLE_STOP_MS } from "./wormholeTransit.ts";
import { TurretFx, fxGuid } from "./turretFx.ts";
import { impactOverlayOf, IMPACT_ANIMATIONS, type ImpactOverlay } from "../three/impactOverlay.ts";
import { MissileFx } from "./missileFx.ts";
import { ShipFx } from "./shipFx.ts";
import { MiningSurveyWave, miningWaveSounds, miningWaveTargets } from "./miningSurveyWave.ts";
import { iskAndRound, miningBracketReadout, type MiningScanTypeFacts } from "../bridge/miningScanResults.ts";
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
import { commandForKey, combatForModifiers, isCombatCommand, labelOf, shortcutOf, type CombatCommand } from "./shortcutKeys.ts";
import { hideLabelShortcutTooltip, showLabelShortcutTooltip, tooltipDue } from "./labelShortcutTooltip.ts";
// actionConst.CMD_BY_ACTIONID: each Selected Item button's command, whose shortcut its tooltip shows
const CMD_BY_ACTION: Readonly<Record<string, string>> = { info: "CmdShowItemInfo", approach: "CmdApproachItem", align: "CmdAlignToItem", orbit: "CmdOrbitItem",
  keep: "CmdKeepItemAtRange", lock: "CmdLockTargetItem", unlock: "CmdUnlockTargetItem", look: "CmdToggleLookAtItem", track: "CmdToggleCameraTracking",
  dock: "CmdDockOrJumpOrActivateGate", jump: "CmdDockOrJumpOrActivateGate", activateGate: "CmdDockOrJumpOrActivateGate", enterWormhole: "CmdDockOrJumpOrActivateGate",
  warp: "CmdWarpToItem", cargo: "CmdOpenSelectedCargoContainer" };
// (a warp it cannot make comes as UI/Inflight/Submenus/WarpToWithin, which is not in CMD_BY_ACTIONID: no shortcut then)
import { buildTurrets, slotOfFlag, turretModelInfo, turretSetCount, type HullTurretData, type TurretFit, type TurretRig, type TurretSetState } from "../three/turretModel.ts";
import type { DamageRouting, MiningState, SpaceSnapshot, SurveyResult } from "../store/types.ts";
import { healthNotificationSettings, HEALTH_NOTIFICATIONS } from "../store/notifySettings.ts";
import { ALERT_ANIMATION_MS, ALERT_DURATION_MS, CAPACITOR, HULL, activeAlertLevel, capacitorAlerting, capacitorChanged, damageStateChanged, initialShipAlertState, isLevelActive } from "../ui/shipAlert.ts";
import { LocationBanner, DEPLETION_COLORS, DEPLETION_FORMATTED_LABEL, DEPLETION_LABELS, PLANET_TYPE_LABELS, beltOriginalCounts, depletionStatus, dungeonOriginalCounts, locationNameParts, RESOURCE_HARVESTING_ARCHETYPES } from "./locationBanner.ts";
import { alignText, indicationHeader, indicationText, pointText, shipIndication, shipStoppingText, warpProgress, warpText, SHIP_STOPPING_MS } from "../space/actionIndication.ts";
import { TargetBar, type TargetBarEntry } from "./targetBar.ts";
import { TARGET_LOCKED_LABEL, targetLockDurationMs, type TargetLockRadii } from "./targetLock.ts";
import { loadDds } from "../three/ddsTexture.ts";
import { Overview, flagMarkup, typeNames, type OverviewAffiliation } from "./overview.ts";
import { ContextMenu, type ContextEntry } from "./contextMenu.ts";
import { shipLabelMarkup } from "./shipLabels.ts";
import { securityStatusColor, shownSecurity } from "../bridge/systemSecurity.ts";
import { inRangeShown, overviewMisc } from "./overviewMisc.ts";
import { fmtDist as fmtDistance } from "../space/overview.ts";
import { DScanWindow } from "./dscan.ts";
import { SolarSystemMapWindow, MARKER_GROUPS, type MapScanResult } from "./solarSystemMap.ts";
import { Neocom, type NeocomSkillState } from "./neocom.ts";
import { bracketIcon, hasBracketData, loadBrackets } from "./brackets.ts";
import { PROXIMITY_TRAP_RANGES } from "./proximityTraps.ts";
import { probeNumber } from "../bridge/scannerWrites.ts";
import { aggressorFlagHolds, gridBracketWanted, iconAndBackgroundFlags, type BracketOverride, type OverviewRelationships } from "./overviewFilters.ts";
import { panelErrorWords } from "../bridge/refusals.ts";
import { PlayWindow, clientTexture } from "./window.ts";
import { bloomFor, type Bloom } from "../three/bloom.ts";
import { DynamicExposure } from "../three/exposure.ts";
import { CombatMessage } from "./combatMessage.ts";
import { bracketListCompact, bracketListDelay } from "./radialSettings.ts";
import { RadialMenu, RADIAL_CSS, RADIAL_ICON, WARP_RANGES, holdToOpen, radialRanges, type RadialOption } from "./radialMenu.ts";
import { METENOX_BOARD_RANGE, METENOX_DEPOSIT_RANGE, METENOX_MATERIAL_RANGE, METENOX_TYPE_ID } from "../bridge/autoMoonMining.ts";
import { hideMetenoxBeam, updateMetenoxPresentation } from "./metenoxPresentation.ts";
import { JUMP_BRIDGE_GROUP, type JumpBridgeSlim } from "../bridge/jumpBridgePanel.ts";
import { ACTIVATE_GATE_LABEL, IN_WARP_HINT_LABEL, isWarpGate } from "../bridge/gateActivation.ts";
import { ENTER_WORMHOLE_LABEL } from "../bridge/placeChanges.ts";
import { hasJumpPolarization, POLARIZED_LABEL, polarizationTime, type WormholePolarization } from "./wormholePolarization.ts";
import { activateCargoTarget, OPEN_CARGO_ICON, OPEN_CARGO_LABEL, selectedCargo } from "./containerInteraction.ts";
import { isNpcCorporation } from "../bridge/standingsReads.ts";
import { isViewedWreck, markWreckViewed, viewedWrecksFor } from "./viewedWrecks.ts";
import { isActiveComponent, spaceComponents, spaceComponentsNow } from "../space/deployables.ts";

export interface Entity {
  kind: string; itemID: number; typeID: number | null; groupID: number | null; categoryID: number | null; name: string | null;
  radius: number; position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number };
  isSelf: boolean; mode?: string | null; maxVelocity?: number | null; isNpc?: boolean; targetEntityID?: number | null;
  /** A wreck's: the ship type it was (its slim nameID's WreckTypeID). */
  wreckTypeID?: number;
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
  /** The activate space component's isActive (component_activate); absent where the thing has none. */
  componentActive?: boolean;
  /** The ball is free (ball.isFree) and moribund (ball.isMoribund); absent where not. */
  isFree?: boolean;
  isMoribund?: boolean;
}

/** invConst.nonScoopableTypes (3698585): the jettison Cargo Container (23) and two more. */
const NON_SCOOPABLE_TYPES: ReadonlySet<number> = new Set([23, 2263, 41567]);
/** evetypes.GetIsGroupAnchorableByGroup, every group whose anchorable flag is set (3698585). */
const ANCHORABLE_GROUPS: ReadonlySet<number> = new Set([307, 311, 336, 340, 361, 363, 364, 365, 397, 404, 413, 414, 416,
  417, 418, 426, 430, 438, 439, 440, 441, 443, 444, 445, 448, 449, 471, 473, 480, 707, 709, 710, 835, 836, 837, 838, 839,
  1004, 1005, 1025, 1073, 1106, 1149, 1212, 1282, 4736]);
interface ItemAction {
  key: string;
  title: string;
  icon: string;
  disabled?: boolean;
  disabledReason?: string;
  run: () => Promise<void>;
}

/** An anomaly as the space menu lists it: its scan id, strength attribute (its group) and dungeon name. */
export interface AnomalySite { readonly targetID: string; readonly strength: number; readonly dungeonName: string; readonly position?: readonly [number, number, number] | null }
/** settings.char.ui sensorSuiteEnabled: the sensor overlay shown (true by default). */
const SENSOR_OVERLAY_KEY = "evejs-play-sensorSuiteEnabled";

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
/** Where a radial menu was opened from, for its indicator: a bracket (or space), an overview window's entry, or neither. */
type RadialFrom = "bracket" | Overview | HTMLElement | null;
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
    /** tactical.FindMaxRange: the module's range and its falloff (maxRange, falloffDist), the range 0 for none. */
    rangeParts?(m: HudModule): readonly [number, number];
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
    /** The group-all button (GroupAllButton.Refresh): null without groupable weapons; whether CanGroupAll, and the readiness. */
    groupAll?(): { canGroup: boolean; readiness: number } | null;
    /** GroupAll (link) or UngroupAll: LinkAllWeapons / UnlinkAllModules of the ship. */
    setGroupAll?(link: boolean): Promise<void>;
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
  /** The map browser opened on a solar system (MenuService.ShowInMapBrowser). */
  showSystemOnMap?: (solarSystemID: number) => void;
  /** An inventory group's name (evetypes.GetGroupNameByGroup), null while it is not known. */
  groupName?: (groupID: number) => string | null;
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
  /** A character's portrait (photo.GetPortrait at 64, the silhouette where the image server has none). */
  portrait?: (characterID: number) => string;
  /** A character's name (cfg.eveowners), asked for where not yet had; null until it is. */
  pilotName?: (characterID: number) => string | null;
  /** menusvc's "Pilot (<name>)" entry for a ship another pilot flies: its CharacterMenu as a submenu; null for none. */
  pilotMenu?: (characterID: number, affiliation?: { corporationID: number | null; allianceID: number | null }) => ContextEntry | null;
  /** xmppChatSvc.Invite(charID): the Selected Item portrait's chat bubble (CharIcon.OnChatButton). */
  startConversation?: (characterID: number) => void;
  /** stateSvc's selected state changed (an object selected, or none): for the panels that show it (the drone entries). */
  onSelectionChange?: (itemID: number | null) => void;
  overviewNotice?: (text: string) => void;
  overviewAsk?: (dialog: string, fallback: string) => Promise<boolean>;
  overviewSay?: (dialog: string, fallback: string) => void;
  /** cfg.corptickernames / allianceshortnames for a ship label (asked for where not known yet). */
  ownerTickers?: (corporationID: number | null, allianceID: number | null) => { corporation: string | null; alliance: string | null };
  /** A solar system's security status (the star map's), null where not known. */
  systemSecurity?: (solarSystemID: number) => number | null;
  overviewRelationships?: (entities: readonly Entity[]) => OverviewRelationships | undefined;
  /** The overview's Tag, Corporation, Alliance, Faction and Militia words (see Overview's hooks). */
  overviewAffiliation?: (rows: readonly Entity[], columns: ReadonlySet<string>) => ((e: Entity) => OverviewAffiliation) | null;
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
  /** movementFunctions.WarpToMiningPointPoint: a moon's mining point, `range` short of it. */
  warpToMoonMiningPoint?(moonID: number, range: number): Promise<void>;
  dock(itemID: number): Promise<void>;
  /** scanMgr.ConeScan(angle, range, x, y, z): the directional scanner's call, where the page can make it. */
  coneScan?(angle: number, range: number, x: number, y: number, z: number): Promise<unknown>;
  dscanHologramTypes?(ids: readonly number[]): Promise<Record<string, number>>;
  /** The install's words for a label, filled with its arguments; null where they are not had yet. */
  word?(label: string, args?: Readonly<Record<string, string | number>>): string | null;
  /** cfg.evelocations.Prime: the locations' names asked for (config.GetMultiLocationsEx). */
  primeLocations?(itemIDs: readonly number[]): void;
  /** The install's words asked for. */
  requestWords?(labels: readonly string[]): void;
  /** cfg.evelocations.Get(itemID).name where it is known; null until it is. */
  locationName?(itemID: number): string | null;
  /**
   * dungeonTracking.get_current_dungeon and sensorSuite.GetAnomaly(dungeon.instance_id): the anomaly of the dungeon the
   * pilot is in, its name (GetByMessageID(dungeonNameID)) and archetype, with the dungeon and room; null where the pilot
   * is in none, or the system's anomalies have no such site.
   */
  arrivalDungeonSite?(): Promise<{ readonly name: string; readonly systemName: string | null; readonly archetypeID: number | null; readonly dungeonID: number; readonly roomID: number | null } | null>;
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
  /** menusvc.Scoop: flown to within reach, then ship.Scoop(itemID). */
  scoopToCargo?(itemID: number): Promise<void>;
  /** menusvc.RealScoopToFleetHangar: ship.ScoopToFleetHangar(objectID), flown to within reach. */
  scoopToFleetHangar?(itemID: number): Promise<void>;
  /** GetFleetMemberMenu's members: the fleet's in the ballpark, not the pilot, with their names and the watchlist's. */
  fleetMembersHere?(): readonly { readonly charID: number; readonly name: string; readonly watched: boolean }[];
  /** droneFunctions.Assist / Guard on these drones. */
  droneFleetOrder?(kind: "assist" | "guard", charID: number, droneIDs: readonly number[]): void;
  /** Use Fitting Service: the fitting window (CmdOpenFitting). */
  openFitting?(): void;
  /** ShipModuleButton.GetMenu of a fitted module: its ammunition, its own entries (auto reload / repeat, online,
   *  overload, repair), at the pointer. */
  moduleMenu?(moduleID: number, typeID: number, x: number, y: number): void;
  /** eveCommands.CmdLogOff in space: menuFunctions.SafeLogoff, the timer started. */
  safeLogoff?(): void;
  /** Whether a safe logoff runs (celestialChecker.IsLoggingOffSafely). */
  loggingOffSafely?(): boolean;
  /** menuFunctions.SelfDestructShip / AbortSelfDestructShip of the active ship, each confirmed first. */
  selfDestructShip?(shipID: number, capsule: boolean): void;
  abortSelfDestructShip?(shipID: number): void;
  /** menuFunctions.Eject: out of the active ship into a capsule beside it (ConfirmEject first). */
  ejectFromShip?(): void;
  /** menusvc.EnterPOSPassword (playerOwned.EnterShipPassword): the shield harmonic password asked for and set. */
  enterShipPassword?(): void;
  /** menuFunctions.Board of an unpiloted ship in space. */
  boardShip?(shipID: number, typeID: number | null): void;
  /** menuFunctions.SetName of a ship: the ship naming window (prompt_rename_ship) for one's own active ship. */
  renameShip?(shipID: number): void;
  /** menuFunctions.SetName: the name asked (NamePopup) for one's own thing in space, with what it is called now. */
  setName?(itemID: number, current: string): void;
  /** fleetSvc.GetCurrentFleetBroadcasts' things (the overview's Move entries with broadcasts to top). */
  currentBroadcasts?(): ReadonlySet<number>;
  /**
   * fleetSvc.GetCurrentFleetBroadcastOnItem: the broadcast on a thing now (its icon path under ui/texture and the
   * hint, fleetbr.GetBroadcastName), or null.
   */
  currentBroadcastOn?(itemID: number): { icon: string; hint: string } | null;
  /** InSpaceBracket.UpdateFleetTagAndTarget's text: the Target code, " / ", the fleet's target tag; "" for none. */
  fleetTagAndTarget?(itemID: number): string;
  /** The pilot is in a fleet (session.IsPilotFleetMember). */
  inFleet?(): boolean;
  /** The pilot's fleet's ID, or null (Michelle.HaveLootRight's fleet). */
  fleetID?(): number | null;
  /** menuFunctions.AbandonLoot (one) / AbandonAllLoot (all of its group the pilot may loot). */
  abandonLoot?(itemID: number, all: boolean): void;
  /** starmap GetDestinationPath()[0] and GetWaypoints()[0], for the route's colour on its gate or station. */
  routeNext?(): { nextSystemID: number | null; firstWaypoint: number | null };
  /** npcs.client.entitystandings.get_standing_between_npc_and_player: the pilot's standing (with its skill bonus) with the NPC owner's faction. */
  npcStanding?(ownerID: number | null): number;
  /** fleetSvc's broadcasts on a thing in space (Target, HealTarget to the bubble; WarpTo, AlignTo, JumpTo to the system). */
  broadcastOnItem?(name: "Target" | "HealTarget" | "WarpTo" | "AlignTo" | "JumpTo", itemID: number, typeID: number | null): void;
  /** Inventory opened on one of the ship's own holds (the new HUD's cargo indicator), by the bay's key. */
  openShipHold?(key: string): void;
  /** The menu's Set Destination and Add Waypoint (starmap.SetWaypoint), and Save Location... (the bookmark window). */
  setDestination?(itemID: number): void;
  addWaypoint?(itemID: number): void;
  saveLocation?(itemID: number, typeID: number | null): void;
  /** menusvc._DroneMenu's orders for the drones: PerformPrimaryAction (Engage Target / Mine with Drone / Salvage), Return and Orbit, Return to Drone Bay, Scoop to Drone Bay. */
  droneOrder?(kind: "primary" | "orbit" | "bay" | "scoop" | "abandon", droneIDs: readonly number[]): void;
  /** The ship's holds read (fill and capacity), for the new HUD's cargo indicator. */
  loadShipHolds?(): Promise<void>;
  /** ShipCargo().OnDropData: an inventory drag dropped on the HUD's cargo button, moved into the cargo hold. */
  dropOnCargo?(data: DataTransfer): void;
  /** The new HUD safety badge's selector opened at the badge's box, or shut (null). */
  safetySelector?(at: DOMRect | null): void;
  /** crimewatchSvc.GetSafetyLevel: 0 none, 1 partial, 2 full; null where not known. */
  safetyLevel?(): 0 | 1 | 2 | null;
  /** GetBookmarkMenuForNavigation: the Locations entry of the system's bookmarks (none where none, or not read yet). */
  locationsMenu?(): (ContextEntry | null)[];
  /** home_station.get_home_station: the pilot's home station, null while not known (asked then). */
  homeStationID?(): number | null;
  /** _GetAgentMissonsMenu: the Agent Missions entry (none where no mission has a bookmark in the system). */
  missionsMenu?(): (ContextEntry | null)[];
  /** sensorSuite.GetSignatures: the system's signatures, each accurate where a probe result has it at full strength. */
  signatures?(): readonly (AnomalySite & { readonly accurate: boolean })[];
  /** BookmarkHandler / SharedBookmarkHandler: the pilot's bookmarks in the system, each at its thing's place or its own. */
  bookmarkSites?(): readonly { readonly bookmarkID: number; readonly memo: string; readonly note: string; readonly shared: boolean; readonly position: readonly [number, number, number] }[];
  /** menusvc.BookmarkMenu of one of those bookmarks. */
  bookmarkMenu?(bookmarkID: number): (ContextEntry | null)[];
  /** MissionHandler: the journal's mission bookmarks in the system, each by its key, its mission's name and place. */
  missionSites?(): readonly { readonly key: string; readonly name: string; readonly position: readonly [number, number, number] }[];
  /** A mission bookmark's menu (BookmarkMenu's moves), by its key. */
  missionMenu?(key: string): (ContextEntry | null)[];
  /** scanSvc.AlignToPosition: aligned to a point. */
  alignToPoint?(position: readonly [number, number, number]): Promise<void>;
  /** movementFunctions.GoToPoint: the ship sent to a point in the system. */
  goToPoint?(position: readonly [number, number, number]): Promise<void>;
  /** menusvc.AlignToBookmark. */
  alignToBookmark?(bookmarkID: number): Promise<void>;
  /** sensorSuite.GetAnomalies for the system the pilot is in (empty where not read yet: the read is started). */
  anomalies?(): readonly AnomalySite[];
  /** A site warped to by its scan id (menusvc.WarpToScanResult), at the range. */
  warpToSite?(targetID: string, range: number): Promise<void>;
  /** scanSvc.AlignToPosition: the ship aligned to the site's position. */
  alignToSite?(targetID: string): Promise<void>;
  /** The site's position saved as a location (BookmarkLocationPopup). */
  bookmarkSite?(targetID: string, name: string): void;
  /** A link followed from a play window (the overview's History: an overviewPreset link). */
  followLink?(url: string, text: string): void;
  /** The HUD health tooltip's figures for a pool (0 shield, 1 armor, 2 structure). */
  healthFacts?(index: number): { readonly hp: number; readonly max: number; readonly resists: readonly { readonly icon: string | null; readonly percent: number }[] } | null;
  /** HudLayer.IsOverloadAllowed: the character has Thermodynamics at any level (null: not known yet). */
  overloadAllowed?(): boolean | null;
  /**
   * HoldTracker.GetMyHolds (inventoryConst.GetHoldsInType): every hold the flown ship's type has, by its bay key,
   * with its capacity (the ship's bays read), for the cargo indicator's tooltip; null before it is read.
   */
  shipBays?(shipID: number): readonly { readonly key: string; readonly used: number | null; readonly capacity: number | null }[] | null;
  /** A client command run from a HUD button (ToggleProbeScanner, CmdToggleAutopilot, ...), as the page runs its shortcut. */
  runCommand?(cmd: string): void;
  /** autoPilotSvc.GetState: whether the autopilot is on, for the new HUD's autopilot button. */
  autopilotOn?(): boolean;
}


/** The pilot, for the containers' loot rights in glyph (set on each space update). */
let npcStandingOf: ((ownerID: number | null) => number) | null = null;
let routeNext: { nextSystemID: number | null; firstWaypoint: number | null } = { nextSystemID: null, firstWaypoint: null };
let lootWho: { characterID: number | null; corporationID: number | null; fleetID: number | null } = { characterID: null, corporationID: null, fleetID: null };

/** bracketVarious.GROUPS_WITH_LOOTRIGHTS: wreck, cargo container, freight container. */
const GROUPS_WITH_LOOTRIGHTS: ReadonlySet<number> = new Set([186, 12, 649]);

/**
 * GetIconColor of an NPC: without the entity-standings component (no response thresholds on its slim item)
 * ICON_COLOR_NEUTRAL (white); with it, entitystandings._get_icon_color_and_hint_from_entity_standing_response on the
 * pilot's standing with the owner's faction - at or under hostile_response_threshold ICON_COLOR_BAD (1, 0.1, 0.1),
 * no friendly threshold or at or over it ICON_COLOR_GOOD (0, 0.4, 1), else neutral; a non-hostile one attacking the
 * pilot is bad.
 */
function npcHasStandings(e: Entity): boolean {
  const t = e as Entity & { hostileResponseThreshold?: number | null; friendlyResponseThreshold?: number | null };
  return (t.hostileResponseThreshold ?? null) !== null || (t.friendlyResponseThreshold ?? null) !== null;
}
function npcColour(e: Entity): string {
  const t = e as Entity & { hostileResponseThreshold?: number | null; friendlyResponseThreshold?: number | null };
  const hostile = t.hostileResponseThreshold ?? null, friendly = t.friendlyResponseThreshold ?? null;
  if (hostile === null && friendly === null) return "#ffffff";
  const standing = npcStandingOf?.(e.ownerID ?? null) ?? 0;
  const colour = hostile !== null && standing <= hostile ? "rgb(255, 26, 26)" : friendly === null || standing >= friendly ? "rgb(0, 102, 255)" : "#ffffff";
  return colour !== "rgb(255, 26, 26)" && attackingMe.has(e.itemID) ? "rgb(255, 26, 26)" : colour;
}

type LootRights = { ownerID: number | null; corpID: number | null; fleetID: number | null; abandoned: boolean };
const lootRightsField = (e: Entity): LootRights | null => (e as Entity & { lootRights?: LootRights | null }).lootRights ?? null;
/** Michelle.IsAbandoned. */
function abandonedOf(e: Entity): boolean { return lootRightsField(e)?.abandoned === true; }
/** Michelle.HaveLootRight: abandoned, or the pilot, its player corporation or its fleet named. */
function lootRightOf(e: Entity): boolean {
  const rights = lootRightsField(e);
  if (!rights) return false;
  return rights.abandoned || (lootWho.characterID !== null && rights.ownerID === lootWho.characterID)
    || (lootWho.corporationID !== null && !isNpcCorporation(lootWho.corporationID) && (rights.ownerID === lootWho.corporationID || rights.corpID === lootWho.corporationID))
    || (lootWho.fleetID !== null && rights.fleetID === lootWho.fleetID);
}

/** A CSS colour (#rrggbb or rgb(...)) with its channels multiplied. */
function attenuated(colour: string, by: number): string {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  const parts = hex ? hex.slice(1).map((h) => parseInt(h, 16)) : (/rgb\(([^)]+)\)/.exec(colour)?.[1]?.split(",").map((x) => Number(x.trim())) ?? null);
  return parts && parts.length >= 3 ? `rgb(${parts.slice(0, 3).map((v) => Math.round(v * by)).join(", ")})` : colour;
}

/** The ships attacking the pilot (tactical's attackers), for npcColour (set on each space update). */
let attackingMe: ReadonlySet<number> = new Set();

/** A bracket glyph by kind, in the client's spirit: the shape says what it is, the colour whose. */
/** GetIconColor(slimItem, getColorHint=True): the icon's colour and its hint's label (Tooltips/Overview/...), or none. */
export function iconLook(e: Entity): { colour: string; hint: string | null; sort: number } {
  // bracketVarious.GetIconColor: OVERVIEW_NORMAL_COLOR (white) for all but the pilot's own ship (OVERVIEW_OWN_SHIP_COLOR, 0.7),
  // an NPC (its owner's standing's colour, npcColour - ICON_COLOR_BAD (1, 0.1, 0.1) 'Hostile' for the belt rats, read
  // through gridcheck), and a wreck or can: abandoned OVERVIEW_ABANDONED_CONTAINER_COLOR
  // (0.2, 0.5, 1.0), else one the pilot has no loot right to OVERVIEW_FORBIDDEN_CONTAINER_COLOR (1, 1, 0) (read through
  // gridcheck: the page pilot's jetcan yellow in the client's overview)
  const rights = (e as Entity & { lootRights?: { ownerID: number | null; corpID: number | null; fleetID: number | null; abandoned: boolean } | null }).lootRights ?? null;
  const looted = e.groupID !== null && GROUPS_WITH_LOOTRIGHTS.has(e.groupID) && rights
    ? rights.abandoned ? "abandoned"
      : (lootWho.characterID !== null && rights.ownerID === lootWho.characterID)
        || (lootWho.corporationID !== null && !isNpcCorporation(lootWho.corporationID) && (rights.ownerID === lootWho.corporationID || rights.corpID === lootWho.corporationID))
        || (lootWho.fleetID !== null && rights.fleetID === lootWho.fleetID) ? null : "forbidden"
    : null;
  // ... and OVERVIEW_AUTO_PILOT_DESTINATION_COLOR (DESTINATION_YELLOW #FFF0FF45) on the gate to the route's next system and
  // the station or structure that is the first waypoint
  const jumpTo = (e as Entity & { jumpSystemID?: number | null }).jumpSystemID ?? null;
  const onRoute = (e.groupID === 10 && jumpTo !== null && jumpTo === routeNext.nextSystemID)
    || ((e.groupID === 15 || e.categoryID === 65) && e.itemID === routeNext.firstWaypoint);
  // (and its sort value: -1 on route or forbidden, an NPC's standing class 1 hostile / 3 neutral / 5 friendly, else 0)
  if (onRoute) return { colour: "rgb(240, 255, 69)", hint: "Tooltips/Overview/StargateOnRoute", sort: -1 };
  if (e.isNpc) {
    const colour = npcColour(e);
    if (!npcHasStandings(e)) return { colour, hint: null, sort: 0 };
    return colour === "rgb(255, 26, 26)" ? { colour, hint: "Tooltips/Overview/HostileNPC", sort: 1 }
      : colour === "#ffffff" ? { colour, hint: "Tooltips/Overview/NeutralNPC", sort: 3 } : { colour, hint: null, sort: 5 };
  }
  if (e.isSelf) return { colour: "#b3b3b3", hint: null, sort: 0 };
  if (looted === "abandoned") return { colour: "rgb(51, 128, 255)", hint: "Tooltips/Overview/AbandonedContainer", sort: 0 };
  if (looted === "forbidden") return { colour: "rgb(255, 255, 0)", hint: "Tooltips/Overview/RestrictedContainer", sort: -1 };
  return { colour: "#ffffff", hint: null, sort: 0 };
}

export function glyph(e: Entity): string {
  // a viewed wreck dimmed (InSpaceBracket.SetViewState attenuation 0.55; SpaceObjectIcon's SetBrightness 0.55 gives the
  // same on these colours)
  const c = (e.groupID === 186 || e.groupID === 306) && isViewedWreck(e.itemID) ? attenuated(iconLook(e).colour, 0.55) : iconLook(e).colour;
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

/** inSpaceBracket.get_label_text: the name, then a space and FmtDist of the distance when there is one. */
export function labelText(name: string, distance: number): string {
  return distance ? `${name} ${fmtDistance(distance)}` : name;
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
  /** The sensor overlay's layer (uicore.layer.sensorSuite) and its site brackets by scan id. */
  private readonly sensorLayer = document.createElement("div");
  private readonly sensorEls = new Map<string, HTMLDivElement>();
  /** The tactical overlay's compass (its geometry by base radius and active range, its labels' places). */
  private tactical: { key: string; group: THREE.Group; labels: HTMLElement; places: { el: HTMLElement; at: THREE.Vector3 }[]; connectors: THREE.Mesh; velocity: THREE.Mesh; action: THREE.LineSegments; navBracket: HTMLDivElement; anchors: THREE.Mesh } | null = null;
  /**
   * sensorSuite._DoSystemEnterScan's sweep: started as a system's sites first come (systemReadyTime), the camera's view
   * angle in the plane then (GetViewAngleInPlane), each scannable site's delay (GetSiteListOrderedByDelay), the ones
   * whose result has played, and whether the sweep's end has.
   */
  private sweep: { start: number; viewAngle: number; delays: Map<string, number>; played: Set<string>; ended: boolean } | null = null;
  /** The pointer's place on the page (the sensor overlay's mouse tracking), and the site its sound is on. */
  private pointerAt: { x: number; y: number; target: EventTarget | null } | null = null;
  private sensorSoundSite: string | null = null;
  /** A system entered and its sweep not yet begun (the sites not yet read). */
  private sweepDue: { at: number } | null = null;
  private readonly bracketEls = new Map<number, HTMLDivElement>();
  /** bracketMgr.ShowModuleRange's distance while a module is hovered (its brackets within it brighter), else null. */
  private moduleRange: number | null = null;
  /** The frame's overview relationships (for the tactical overlay's aggressor flags). */
  private lastRelations: OverviewRelationships | undefined;
  /** The tactical compass's firing range (optimal, falloff) of the module hovered, null for none. */
  private firingRange: readonly [number, number] | null = null;
  private firingRangeClear: ReturnType<typeof setTimeout> | undefined;
  /** bracketMgr.damageByBracketID: each attacker's damage to the ship by the second (RECORDED_DAMAGE_PERIOD_SECONDS 120 kept). */
  private readonly damageByAttacker = new Map<number, Map<number, number>>();
  private biggestDamageDealers: number[] = [];

  /**
   * bracketMgr.ShowBiggestDamageDealers_thread, once a second: the five that did the most to the ship in the last two
   * minutes (FindBiggestDamageDealers) get damageDealer.png in red on their brackets, 100 / 90 / 80 / 75 / 70 px at
   * 0.25 / 0.2 / 0.15 / 0.12 / 0.08, changing over 0.2 s; one no longer among them loses it.
   */
  private updateDamageDealers(): void {
    const since = Math.floor(Date.now() / 1000) - 120;
    const sums: [number, number][] = [];
    for (const [attacker, byTime] of this.damageByAttacker) {
      for (const t of [...byTime.keys()]) if (t <= since) byTime.delete(t);
      if (!byTime.size) { this.damageByAttacker.delete(attacker); continue; }
      const total = [...byTime.values()].reduce((a, b) => a + b, 0);
      if (total > 0 && this.bracketEls.has(attacker)) sums.push([total, attacker]);
    }
    const shown = overviewMisc().damageIndications;
    const top = shown ? sums.sort((a, b) => b[0] - a[0] || b[1] - a[1]).slice(0, 5).map(([, id]) => id) : [];
    const alphas = [0.25, 0.2, 0.15, 0.12, 0.08], sizes = [100, 90, 80, 75, 70];
    top.forEach((id, i) => {
      const hit = this.bracketEls.get(id)?.querySelector<HTMLElement>(".t-hit");
      if (!hit) return;
      Object.assign(hit.style, { display: "block", opacity: String(alphas[i]), width: `${sizes[i]}px`, height: `${sizes[i]}px`, left: `${-sizes[i]! / 2}px`, top: `${-sizes[i]! / 2}px` });
      hit.dataset.base = String(alphas[i]);
    });
    for (const id of this.biggestDamageDealers) {
      if (top.includes(id)) continue;
      const hit = this.bracketEls.get(id)?.querySelector<HTMLElement>(".t-hit");
      if (hit) hit.style.display = "none";
    }
    this.biggestDamageDealers = top;
  }
  private readonly hairlineSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  private hairlineTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * bracketMgr.ShowHairlinesForModule / TargetingHairlines: where the module runs on a locked target, a line from its
   * slot through the target's bracket to its weapon icon in the target bar (GetHairlinePoints), and the 2.5 px trace
   * (0.5, 0.7, 0.6, 0.5) running along it once in a second (StartAnimation; the other way from the weapon icon), the
   * points kept up every 50 ms (AnimateVectorLine). Not drawn with Display Active Module Links off.
   */
  private showHairlines(moduleID: number, reverse: boolean): void {
    this.stopHairlines();
    if (!overviewMisc().moduleLinks) return;
    const m = this.options.rack?.modules().find((each) => each.itemID === moduleID);
    const targetID = m?.active ? m.targetID ?? null : null;
    if (targetID === null || !this.locked.has(targetID)) return;
    const centre = (el: Element | null | undefined) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width || r.height ? [r.left + r.width / 2, r.top + r.height / 2] as const : null; };
    const line = this.hairlineSvg.querySelector<SVGPolylineElement>(".hl-line")!, trace = this.hairlineSvg.querySelector<SVGPolylineElement>(".hl-trace")!;
    const place = (): boolean => {
      const a = centre(this.shipHud && "slotElement" in this.shipHud ? this.shipHud.slotElement(moduleID) : null), b = centre(this.bracketEls.get(targetID)), c = centre(this.targetBar.weaponElement(moduleID));
      if (!a || !b || !c || this.bracketEls.get(targetID)?.style.display === "none") { this.hairlineSvg.style.display = "none"; return false; }
      const pts = `${a[0]},${a[1]} ${b[0]},${b[1]} ${c[0]},${c[1]}`;
      line.setAttribute("points", pts);
      trace.setAttribute("points", pts);
      this.hairlineSvg.style.display = "block";
      return true;
    };
    if (!place()) return;
    const length = line.getTotalLength();
    trace.style.strokeDasharray = `${length * 0.01} ${length * 2}`;
    trace.animate([{ strokeDashoffset: reverse ? -length * 0.99 : 0 }, { strokeDashoffset: reverse ? 0 : -length * 0.99 }], { duration: 1000, easing: "linear", fill: "forwards" });
    this.hairlineTimer = setInterval(place, 50);
  }

  /** StopShowingHairlines. */
  private stopHairlines(): void {
    if (this.hairlineTimer) clearInterval(this.hairlineTimer);
    this.hairlineTimer = null;
    this.hairlineSvg.style.display = "none";
  }
  private inRangeDue = false;
  /** stateSvc.GetExclState(mouseOver): the one thing under the pointer, a bracket's or an overview row's. */
  private hoveredID: number | null = null;

  /**
   * InSpaceBracket.UpdateFlagAndBackground: the state flag at the icon's left + 9, top + 8 (9 x 9) and the bracket's
   * background (bracketBackground.png in the background colour at half its alpha, fading 0..1 over 0.75 s where it
   * blinks); drawn again only when they change.
   */
  private updateBracketFlags(el: HTMLDivElement, e: Entity, groupID: number | null, relations: OverviewRelationships | undefined): void {
    const flags = iconAndBackgroundFlags(e, groupID, relations);
    const key = `${flags.icon?.flag ?? 0}:${flags.background?.flag ?? 0}`;
    if (el.dataset.flags === key) return;
    el.dataset.flags = key;
    el.querySelector(".bracket-flag")?.remove();
    el.querySelector(".bracket-bg")?.remove();
    if (flags.icon) {
      const f = document.createElement("span");
      f.className = "bracket-flag";
      f.innerHTML = flagMarkup(flags.icon);
      el.append(f);
    }
    const bg = flags.background;
    if (bg) {
      const c = bg.backgroundColor;
      const d = document.createElement("span");
      d.className = `bracket-bg${bg.backgroundBlink ? " blink" : ""}`;
      d.style.background = `rgba(${Math.round(c[0]! * 255)},${Math.round(c[1]! * 255)},${Math.round(c[2]! * 255)},${(c[3] ?? 1) * 0.5})`;
      el.prepend(d);
    }
  }

  /** menusvc.GetFleetMemberMenu: the members' entries for `run`, as the client lays them out. */
  /** overviewUtil.IsFleetMember: in a fleet, the thing's owner one of its members. */
  private isFleetMemberShip(id: number): boolean {
    if (!this.actions.inFleet?.()) return false;
    const owner = this.snapshot?.entities.find((x) => x.itemID === id)?.ownerID ?? null;
    return owner !== null && (this.actions.fleetMembersHere?.() ?? []).some((m) => m.charID === owner);
  }

  private fleetMemberMenu(run: (charID: number) => () => void, word: (label: string, fallback: string) => string): (ContextEntry | null)[] {
    const all = [...(this.actions.fleetMembersHere?.() ?? [])].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
    const entries = (list: typeof all): ContextEntry[] => list.map((m) => ({ label: m.name, run: run(m.charID) }));
    const watched = all.filter((m) => m.watched);
    const head: (ContextEntry | null)[] = watched.length ? [{ label: word("UI/Fleet/WatchList", "Watch List"), sub: entries(watched) }, null] : [];
    if (!all.length) return [{ label: word("UI/Fleet/NoValidOptions", "No Valid Options"), disabled: "" }];
    const chunks: (typeof all)[] = [];
    for (let i = 0; i < all.length; i += 20) chunks.push(all.slice(i, i + 20));
    if (chunks.length === 1) return [...head, ...entries(chunks[0]!)];
    return [...head, ...chunks.map((c) => ({ label: `${c[0]!.name[0]} ... ${c[c.length - 1]!.name[0]}`, sub: entries(c) }))];
  }

  /**
   * CelestialChecker.IsScoopable: never a non-scoopable type; a drone or biomass always, a free structure; nothing
   * dead; a thing with a scoop component once active, if it is the pilot's own; for a freighter's pilot a freight
   * container or a free anchorable that is no container; else a free anchorable, a cargo or freight container. (The
   * fighter case - one not in the pilot's own squadrons - is left out: the page has no fighters.)
   */
  private isScoopable(e: Entity, comps: ReturnType<typeof spaceComponentsNow>): boolean {
    const typeID = e.typeID ?? null;
    if (typeID !== null && NON_SCOOPABLE_TYPES.has(typeID)) return false;
    if (e.isSelf) return false;
    const group = e.groupID ?? null, category = (e as Entity & { categoryID?: number | null }).categoryID ?? null;
    if (group === 14 || category === 18) return true;
    if (category === 65 && e.isFree) return true;
    if (e.isMoribund) return false;
    if (typeID !== null && comps.scoop.has(typeID) && isActiveComponent(comps, typeID, e.componentActive)) {
      return e.ownerID != null && e.ownerID === this.snapshot?.ship?.ownerID;
    }
    const anchorable = group !== null && ANCHORABLE_GROUPS.has(group);
    const shipGroup = this.snapshot?.ship?.groupID ?? null;
    if (shipGroup === 513 || shipGroup === 902) {
      if (group === 649) return true;
      return anchorable && !!e.isFree && group !== 448 && group !== 340 && group !== 12;
    }
    if (anchorable && e.isFree) return true;
    return group === 12 || group === 649;
  }

  /**
   * InSpaceBracket.FleetBroadcast / NearIDFleetBroadcast: the broadcast on the thing as a 16 x 16 BracketSubIcon with
   * its name for a hint, placed by _UpdateFleetBroadcastIcon (on screen, not projected: 2 px left of the bracket and
   * centred on it); gone when the broadcast's 15 s are up or another takes its place.
   */
  private updateBracketBroadcast(el: HTMLDivElement, itemID: number): void {
    // UpdateFleetTagAndTarget: a BracketShadowLabel in bold at the medium size, always shown, right of the bracket by
    // the label margin and its own height above the name (_UpdateFleetTagAndTargetOffset, on screen)
    const tagText = this.actions.fleetTagAndTarget?.(itemID) ?? "";
    if ((el.dataset.fleetTag ?? "") !== tagText) {
      el.dataset.fleetTag = tagText;
      let tag = el.querySelector<HTMLElement>(".bracket-fleet-tag");
      if (!tagText) tag?.remove();
      else {
        if (!tag) { tag = document.createElement("span"); tag.className = "bracket-fleet-tag"; el.append(tag); }
        tag.textContent = tagText;
      }
    }
    const b = this.actions.currentBroadcastOn?.(itemID) ?? null;
    const key = b ? `${b.icon}|${b.hint}` : "";
    if ((el.dataset.bcast ?? "") === key) return;
    el.dataset.bcast = key;
    el.querySelector(".bracket-bcast")?.remove();
    if (!b) return;
    const img = document.createElement("img");
    img.className = "bracket-bcast";
    img.alt = "";
    img.src = `/client-res/ui/texture/${b.icon}`;
    if (b.hint) img.title = b.hint;
    el.append(img);
  }

  /**
   * bracketMgr.GetDisplayNameForBracket then get_label_text: a thing with a corporation that is not an orbital
   * (category 46) by the ship labels (GetDisplayNameWithShipLabels), anything else by its name; the distance after.
   */
  private drawBracketLabel(label: HTMLElement, e: Entity): void {
    const name = this.shipLabelName(e);
    if (name !== null) {
      const dist = this.distanceTo(e);
      const html = name + (dist ? ` ${fmtDistance(dist)}` : "");
      if (label.innerHTML !== html) label.innerHTML = html;
      return;
    }
    label.textContent = labelText(this.nameOf(e), this.distanceTo(e));
  }

  /** GetDisplayNameForBracket's ship-label branch (GetDisplayNameWithShipLabels) as HTML; null where it does not apply. */
  private shipLabelName(e: Entity): string | null {
    const category = (e as Entity & { categoryID?: number | null }).categoryID ?? null;
    const corp = (e as Entity & { corporationID?: number | null }).corporationID ?? null;
    if (!corp || category === 46) return null;
    const alliance = (e as Entity & { allianceID?: number | null }).allianceID ?? null;
    const tickers = this.options.ownerTickers?.(corp, alliance) ?? { corporation: null, alliance: null };
    return shipLabelMarkup({ typeName: (e.typeID ? this.names?.types[String(e.typeID)]?.[0] : null) ?? "", shipName: e.name ?? null,
      displayName: this.nameOf(e), corporationID: corp, allianceID: alliance, corpTicker: tickers.corporation, allianceTicker: tickers.alliance });
  }

  /**
   * InSpaceBracket.CountDown: while locking, the timer's two half rings (76 px at 0.4) sweep away the time left and the
   * label under the reticle reads it to a tenth of a second (FmtAmt showFraction 1); at the end the label says
   * UI/Inflight/Brackets/TargetLocked and blinks with the arrows (BlinkArrowsAndText) until the lock is confirmed.
   */
  private bracketCountdown(id: number, lockTimeMs: number | null, startedAt: number, lockedText: string): void {
    const el = this.bracketEls.get(id);
    if (!el) return;
    const timer = el.querySelector<HTMLElement>(".t-timer"), text = el.querySelector<HTMLElement>(".t-lock-text");
    if (!timer || !text) return;
    if (lockTimeMs === null || lockTimeMs <= 0) { timer.style.removeProperty("--left"); text.textContent = ""; return; }
    const dt = this.lockNow() - startedAt;
    const ratio = Math.max(0, (lockTimeMs - dt) / lockTimeMs);
    timer.style.setProperty("--left", `${(ratio * 360).toFixed(1)}deg`);
    el.classList.toggle("lock-done", dt > lockTimeMs);
    text.textContent = dt > lockTimeMs ? lockedText : ((lockTimeMs - dt) / 1000).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  // PersistentInSpaceBracketTooltip, as a floating bracket's (navigation.PrepareTooltipLoad)
  private overlapTip: HTMLDivElement | null = null;
  private overlapIDs = new Set<number>();
  private overlapOpenTimer: ReturnType<typeof setTimeout> | null = null;
  private overlapCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private overlapDown: ((ev: MouseEvent) => void) | null = null;

  /** InSpaceBracket.LoadTooltipPanel after the Bracket List Delay (tooltipDelayBracket, 50 ms by default); an overlapped bracket keeps it. */
  private overlapEntered(id: number): void {
    if (this.overlapCloseTimer) { clearTimeout(this.overlapCloseTimer); this.overlapCloseTimer = null; }
    if (this.overlapTip && this.overlapIDs.has(id)) return;
    if (this.overlapOpenTimer) clearTimeout(this.overlapOpenTimer);
    this.overlapOpenTimer = setTimeout(() => { this.overlapOpenTimer = null; this.openOverlapTooltip(id); }, bracketListDelay());
  }
  private overlapLeft(): void {
    if (this.overlapOpenTimer) { clearTimeout(this.overlapOpenTimer); this.overlapOpenTimer = null; }
    if (!this.overlapTip) return;
    if (this.overlapCloseTimer) clearTimeout(this.overlapCloseTimer);
    this.overlapCloseTimer = setTimeout(() => this.closeOverlapTooltip(), 250);
  }
  private closeOverlapTooltip(): void {
    if (this.overlapCloseTimer) { clearTimeout(this.overlapCloseTimer); this.overlapCloseTimer = null; }
    for (const id of this.overlapIDs) this.bracketEls.get(id)?.classList.remove("overlap-lit");
    this.overlapIDs.clear();
    this.overlapTip?.remove();
    this.overlapTip = null;
    if (this.overlapDown) { document.removeEventListener("mousedown", this.overlapDown, true); this.overlapDown = null; }
  }

  /**
   * navigation.PrepareTooltipLoad and PersistentInSpaceBracketTooltip as a floating bracket has it (compact:
   * bracketmenu_floating True): bracketVarious.GetOverlaps - the bracket itself, then each other shown bracket whose
   * box meets its box, no asteroid (category 25) nor harvestable cloud (711), 15 at most, by name; one alone, none.
   * The tooltip's panel (opacity 0.8) holds a column of their 16 px icons, rows 26 high (MINENTRYHEIGHT), with the
   * selection circle on the selected; the side panel beside it their names with the distance (FmtDist) and, under
   * it, the tag and target code in bold. A row's hover lights it (0.2) and sets the thing's mouseOver; its click,
   * right-click and held button are the bracket's (the rows carry the bracket's data-id in the brackets' layer); the
   * brackets it lists are drawn brighter (opacity 2.0). A press anywhere else closes it (OnGlobalMouseDown).
   */
  private openOverlapTooltip(id: number | null, siteAnchor: HTMLElement | null = null): void {
    this.closeOverlapTooltip();
    const el = id !== null ? this.bracketEls.get(id) ?? null : siteAnchor;
    if (!el || el.style.display === "none") return;
    const box = el.getBoundingClientRect();
    const entities = new Map((this.snapshot?.entities ?? []).map((e) => [e.itemID, e]));
    const self = id !== null ? entities.get(id) : undefined;
    if (id !== null && !self) return;
    const list: { id: number; el: HTMLElement; e: Entity; name: string }[] = id !== null && self ? [{ id, el, e: self, name: this.nameOf(self) }] : [];
    // sensorSuite.GetOverlappingSites: the overlay's sites under the cursor (within BRACKET_OVERLAP_DISTANCE 8 px of it)
    const at = this.pointerAt;
    const sites = at ? [...this.sensorEls.values()].filter((s) => {
      if (s.style.display === "none" || s.style.pointerEvents === "none") return false;
      const r = s.getBoundingClientRect();
      return Math.abs(r.left + r.width / 2 - at.x) <= 8 && Math.abs(r.top + r.height / 2 - at.y) <= 8;
    }) : [];
    for (const [other, oel] of this.bracketEls) {
      if (other === id || oel.style.display === "none") continue;
      const e = entities.get(other);
      if (!e || (e as Entity & { categoryID?: number | null }).categoryID === 25 || e.groupID === 711) continue;
      const name = this.nameOf(e);
      if (!name) continue;
      const b = oel.getBoundingClientRect();
      if (b.right <= box.left || b.left >= box.right || b.bottom <= box.top || b.top >= box.bottom) continue;
      list.push({ id: other, el: oel, e, name });
      if (list.length === 15) break;
    }
    // a floating bracket alone (with no site) has none
    if (list.length + sites.length <= 1) return;
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const host = this.brackets.getBoundingClientRect();
    // LoadTooltip: compact by Compact Bracket List When Not Snapped (a floating bracket, inside the layer) or When
    // Snapped (at its edge, IsFloating false); not compact a 3-column grid - the icon, the name (BracketShadowLabel,
    // 150 wide, padding 2 2 6 2) with the tag under it, the distance (EveLabelSmall, right, 4 in) - and no side panel
    const floating = box.left > host.left && box.top > host.top && box.right < host.right && box.bottom < host.bottom;
    const compact = bracketListCompact(floating);
    const tip = document.createElement("div");
    tip.className = compact ? "bracket-overlap" : "bracket-overlap wide";
    const icons = document.createElement("div");
    icons.className = "bo-icons";
    const side = document.createElement("div");
    side.className = "bo-side";
    for (const one of list) {
      const icon = document.createElement("div");
      icon.className = "bo-row";
      icon.dataset.id = String(one.id);
      const glyphEl = one.el.querySelector(".glyph")?.cloneNode(true) as HTMLElement | null;
      if (glyphEl) icon.append(glyphEl);
      if (this.selected === one.id) icon.classList.add("bo-selected");
      const label = document.createElement("div");
      label.className = "bo-label";
      label.dataset.id = String(one.id);
      const dist = this.distanceTo(one.e);
      const tag = this.actions.fleetTagAndTarget?.(one.id) ?? "";
      const main = document.createElement("span");
      main.textContent = dist && compact ? `${one.name} ${fmtDistance(dist)}` : one.name;
      label.append(main);
      const distEl = document.createElement("div");
      distEl.className = "bo-dist";
      distEl.dataset.id = String(one.id);
      distEl.textContent = dist ? fmtDistance(dist) : "";
      if (tag) {
        const b = document.createElement("b");
        b.textContent = tag;
        label.append(document.createElement("br"), b);
      }
      const parts = compact ? [icon, label] : [icon, label, distEl];
      for (const part of parts) {
        part.addEventListener("mouseenter", () => { for (const p of parts) p.classList.add("bo-hilite"); void playUiEvent("ui_button_soft2_play"); this.setHovered(one.id); });
        part.addEventListener("mouseleave", () => { for (const p of parts) p.classList.remove("bo-hilite"); if (this.hoveredID === one.id) this.setHovered(null); });
        part.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void playUiEvent("msg_ListEntryClick_play");
          this.select(one.id);
          for (const r of icons.children) r.classList.toggle("bo-selected", (r as HTMLElement).dataset.id === String(one.id));
        });
        part.addEventListener("dblclick", (ev) => { ev.stopPropagation(); this.activateSpaceTarget(one.id); });
      }
      if (compact) { icons.append(icon); side.append(label); } else icons.append(icon, label, distEl);
      this.overlapIDs.add(one.id);
      one.el.classList.add("overlap-lit");
    }
    // SensorOverlaySiteTooltipRow: the site's inner icon (16 px) on its bracket's outer colour at 0.25, its label text
    // (GetBracketLabelText) with its distance (FmtDist, compact); its menu, click and press are the bracket's
    for (const s of sites) {
      const icon = document.createElement("div");
      icon.className = "bo-row bo-site";
      const colour = getComputedStyle(s.querySelector(".ss-outer")!).backgroundColor;
      icon.style.setProperty("--site", colour);
      const img = document.createElement("img");
      img.src = (s.querySelector(".ss-inner") as HTMLImageElement).src;
      img.alt = "";
      icon.append(img);
      const label = document.createElement("div");
      label.className = "bo-label bo-site";
      label.style.setProperty("--site", colour);
      const code = s.querySelector(".ss-code b")?.textContent ?? "";
      const dist = s.querySelector(".ss-code span")?.textContent ?? "";
      label.textContent = dist && compact ? `${code} ${dist}` : code;
      const distEl = document.createElement("div");
      distEl.className = "bo-dist bo-site";
      distEl.style.setProperty("--site", colour);
      distEl.textContent = dist;
      const parts = compact ? [icon, label] : [icon, label, distEl];
      for (const part of parts) {
        part.addEventListener("mouseenter", () => { for (const p of parts) p.classList.add("bo-hilite"); void playUiEvent("ui_button_soft2_play"); });
        part.addEventListener("mouseleave", () => { for (const p of parts) p.classList.remove("bo-hilite"); });
        part.addEventListener("contextmenu", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          s.dispatchEvent(new MouseEvent("contextmenu", { bubbles: false, cancelable: true, clientX: ev.clientX, clientY: ev.clientY }));
        });
        part.addEventListener("dblclick", (ev) => { ev.stopPropagation(); s.dispatchEvent(new MouseEvent("dblclick", { bubbles: false })); });
      }
      if (compact) { icons.append(icon); side.append(label); } else icons.append(icon, label, distEl);
    }
    if (compact) tip.append(icons, side); else tip.append(icons);
    tip.addEventListener("mouseenter", () => { if (this.overlapCloseTimer) { clearTimeout(this.overlapCloseTimer); this.overlapCloseTimer = null; } });
    tip.addEventListener("mouseleave", () => this.overlapLeft());
    // GetTooltipPointer, a compact one in the open: POINT_BOTTOM_2 - the panel over the bracket, centred on it, its
    // pointer down (POINT_TOP_2 under it where the bracket is at the top edge); the side panel to the panel's right, or its
    // left where it would leave the layer (UpdateSideContainer)
    const pointer = document.createElement("img");
    pointer.className = "bo-pointer";
    pointer.alt = "";
    icons.append(pointer);
    this.brackets.append(tip);
    // a name cut at 150 fades out over its last 20 px (TOOLTIPLABELCUTOFFFADELENGTH)
    if (!compact) for (const l of icons.querySelectorAll<HTMLElement>(".bo-label")) l.classList.toggle("cut", l.scrollWidth > l.clientWidth);
    const iw = icons.offsetWidth, ih = icons.offsetHeight, sw = compact ? side.offsetWidth : 0;
    const cx = box.left - host.left + box.width / 2;
    let top = box.top - host.top - 9 - ih;
    const below = top < 0;
    if (below) top = box.bottom - host.top + 9;
    pointer.src = `/client-res/ui/texture/classes/framewithpointer/${below ? "pointer_up_02" : "pointer_down_02"}.png`;
    pointer.classList.toggle("up", below);
    const left = cx - iw / 2;
    const sideLeft = left + iw + sw > host.width;
    tip.classList.toggle("side-left", sideLeft);
    tip.style.left = `${Math.round(sideLeft ? left - sw : left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    this.overlapTip = tip;
    this.overlapDown = (ev: MouseEvent) => {
      const t = ev.target;
      if (t instanceof Element && (tip.contains(t) || t.closest(".eve-context-menu"))) return;
      this.closeOverlapTooltip();
    };
    document.addEventListener("mousedown", this.overlapDown, true);
  }

  /** The safety selector (over the HUD badge) has the pointer, or has lost it. */
  safetySelectorHover(over: boolean): void {
    if (!(this.shipHud instanceof NewShipHud)) return;
    if (over) this.shipHud.safetyHeld(); else this.shipHud.safetyLeft();
  }

  /** stateSvc.SetState(itemID, mouseOver): the bracket shows its label (ShowLabel's mouseOver) and the overview row lights. */
  /** An object's mouseOver state from outside the view (a window's entry: MiningScanEntry.OnMouseEnter / OnMouseExit). */
  hoverObject(id: number | null): void { this.setHovered(id); }

  private setHovered(id: number | null): void {
    if (this.hoveredID === id) return;
    if (this.hoveredID !== null) this.bracketEls.get(this.hoveredID)?.classList.remove("hovered");
    this.hoveredID = id;
    if (id !== null) this.bracketEls.get(id)?.classList.add("hovered");
    this.overview.setHovered(id);
    for (const o of this.extraOverviews) o.setHovered(id);
    // stateSvc's mouseOver flag goes to every listener (OnStateChange): the drone window's entries among them
    dispatchEvent(new CustomEvent("evejs:space-hover", { detail: { itemID: id } }));
  }
  private makeOverview: ((instanceID: number) => Overview) | null = null;
  /** Another overview window: made, put in the layer, its rows held and right-clicked as the first's. */
  private addOverviewWindow(make: (instanceID: number) => Overview, id?: number): Overview {
    const next = id ?? Math.max(0, ...this.extraOverviews.map((o) => o.instanceID), ...this.overview.storedWindowIDs()) + 1;
    const o = make(next);
    o.window.root.classList.add("space-only-window");
    this.layer.appendChild(o.window.root);
    this.raiseOnClick(o.window.root);
    const off = this.holdOverviewRow?.(o.window.body);
    if (off) this.unhold.push(off);
    o.setSelected(this.selected);
    this.extraOverviews.push(o);
    return o;
  }
  private removeOverviewWindow(o: Overview): void {
    o.window.root.remove();
    const i = this.extraOverviews.indexOf(o);
    if (i >= 0) this.extraOverviews.splice(i, 1);
  }
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
  private neocom: Neocom | null = null;
  /** The Neocom's character sheet button portrait (ButtonCharacterIcon). */
  setNeocomPortrait(url: string | null): void { this.neocom?.setPortrait(url); }
  /** The Neocom's skills button gauges (ButtonSkills). */
  setNeocomSkills(state: NeocomSkillState, planRatio: number | null = null): void { this.neocom?.setSkills(state, planRatio); }
  /** The Neocom buttons' window indicators (ButtonIndicator). */
  setNeocomStates(states: ReadonlyMap<string, "open" | "active">): void { this.neocom?.setWindowStates(states); }
  /** neocomSvc.Blink: a Neocom button blinks (its window wants looking at), with an optional hint. */
  neocomBlink(id: string, hint = ""): void { this.neocom?.blink(id, hint); }
  /** A Neocom button's unseen items (its important state for as long as they are there), with their hint. */
  neocomUnseen(id: string, hint: string | null, count?: number): void { this.neocom?.setUnseen(id, hint, count); }
  /** The Skills tooltip's training rows (Neocom.skillTip). */
  neocomSkillTip(read: Neocom["skillTip"]): void { if (this.neocom) this.neocom.skillTip = read; }
  neocomSkillCompleted(): void { this.neocom?.playSkillCompletion(); }
  neocomPlanCompleted(): void { this.neocom?.playPlanCompletion(); }
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
  /** tactical.OnSpecialFX's attackers: each thing an offensive effect on the pilot's ship is under way from, by its
   *  effects' signatures (module, guid, start time, duration) - threatAttackingMe while any is. */
  private readonly attackers = new Map<number, Set<string>>();
  private attackersShipID: number | null = null;
  private readonly feedEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private selected: number | null = null;
  private readonly overview: Overview;
  /** The other overview windows (Move Tab To > New Window), each with its own tabs, fed as the first. */
  private readonly extraOverviews: Overview[] = [];
  private holdOverviewRow: ((el: HTMLElement) => () => void) | null = null;
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
  /** The hold's used volume at the last update, for CircularInventoryGauge.animate_full on an arrival into a full hold. */
  private miningHoldUsed: number | null = null;
  private readonly miningVolumes = new Map<number, number | null>();
  private lastMiningShip: number | null = null;
  private miningInWarp = false;
  /** The thing the current warp is to (warp_signals.on_warp_finished's warpToItemID), kept while the ship warps. */
  private warpToItemID: number | null = null;
  private readonly locationBanner = new LocationBanner();
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
      // (an explosion: the target lost 'Exploding' - anim_death in the target bar)
      if (effect === 3 || effect === 1) this.targetBar.markExploded(Number(args[0]));
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
      // tactical.OnSpecialFX: an offensive effect on the pilot's ship marks its source as attacking while it lasts
      const me = this.snapshot?.ship?.itemID ?? null, shooter = Number(args[0]);
      if (me !== null && Number(args[3]) === me && (args[6] === true || Number(args[6]) === 1)) {
        const key = `${String(args[1])}|${fxGuid(args[5])}|${String(args[11] ?? "")}|${String(args[9] ?? "")}`;
        const data = this.attackers.get(shooter) ?? new Set<string>();
        if (Number(args[7]) === 1 && shooter !== me) data.add(key); else data.delete(key);
        if (data.size) this.attackers.set(shooter, data); else this.attackers.delete(shooter);
        this.bracketEls.get(shooter)?.classList.toggle("attacking-me", this.attackers.has(shooter));
      }
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
  /** uix.GetSlimItemName of a ball in the park (a loot window's caption, invCtrl.BaseCelestialContainer.GetName), or null. */
  slimItemName(itemID: number): string | null {
    const e = this.snapshot?.entities.find((x) => x.itemID === itemID);
    return e ? this.nameOf(e) : null;
  }
  private nameOf(e: Entity): string {
    const typeName = e.typeID !== null ? this.names?.types[String(e.typeID)]?.[0] ?? null : null;
    // uix.GetSlimItemName: a ship with no pilot, or the pilot's own ship not the one flown, is its type; one a character
    // flies is that character's name (the overview's Name, the bracket's, the Selected Item's)
    if ((e.categoryID === 6 || e.kind === "ship") && !e.isNpc) {
      const pilot = e.characterID ?? null;
      if (!pilot || (pilot === this.options.overviewPilotID && !e.isSelf)) return typeName ?? e.name ?? e.kind;
      const name = this.options.pilotName?.(pilot) ?? null;
      if (name) return name;
    }
    if (e.categoryID === 6 || e.isNpc || e.kind === "ship") return e.name ?? typeName ?? e.kind;
    if (e.categoryID === 25 || e.groupID === 711) return typeName ?? e.name ?? e.kind;
    // michelle's cfg.evelocations.Hint of a wreck's nameID, UI/Inflight/WreckNameTypeID: "<the ship's type> Wreck"
    const wreckOf = e.wreckTypeID !== undefined ? this.names?.types[String(e.wreckTypeID)]?.[0] ?? null : null;
    if (wreckOf) return `${wreckOf} Wreck`;
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
  // (when each was asked: one still unnamed 10 s on is asked again - a lookup made as the session starts can fail, and the
  // flow forgets a failed one rather than caching it)
  private readonly locationsPrimed = new Map<number, number>();
  /** The park's celestials, stations, gates and named items primed in cfg.evelocations, as the client's brackets
   * and overview get their names (GetSlimItemName's cfg.evelocations.Get). */
  private primeEntityLocations(entities: readonly Entity[]): void {
    const wanted: number[] = [];
    for (const e of entities) {
      if (e.categoryID === 6 || e.categoryID === 25 || e.isNpc || e.kind === "ship") continue;
      const askedAt = this.locationsPrimed.get(e.itemID);
      if (askedAt !== undefined && (Date.now() - askedAt < 10_000 || this.actions.locationName?.(e.itemID) != null)) continue;
      this.locationsPrimed.set(e.itemID, Date.now());
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
      // (a failed ask let go 10 s on, so the label asks again: one made as the session starts can fail)
      void this.options.corpTickers([corp]).then((t) => { this.tickers.set(corp, t[String(corp)] ?? null); })
        .catch(() => { setTimeout(() => this.tickersAsked.delete(corp), 10_000); });
    }
    const ticker = this.tickers.get(corp);
    return ticker ? `${name} [${ticker}]` : name;
  }
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  /** CombatKeyUnloadListener: the loaded combat command let go when its key comes up, or the window loses focus. */
  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (this.options.covered?.()) { this.onBlur(); return; }
    if (this.combat && e.code === this.combat.code) {
      // OverviewWindow.OnKeyUp (the key's UI_KEYUP goes to the focus first): with the overview focused and a row
      // selected, ExecuteCombatCommand(selected, UI_KEYUP) - the loaded command run on that row, unless it already ran
      // on a click while held (combatCmdCurrentHasExecuted), when the key up only unloads it
      const { cmd, executed } = this.combat;
      const row = executed || cmd === "CmdGetLocationMenuForNavigation" ? null
        : [this.overview, ...this.extraOverviews].map((o) => o.focusedSelection()).find((id) => id !== null) ?? null;
      if (row !== null && cmd !== "CmdSelectTargetItem" && this.snapshot?.entities.some((x) => x.itemID === row)) this.runCombat(cmd, row);
      this.unloadCombat();
    }
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
  private combat: { cmd: CombatCommand; code: string; executed?: boolean } | null = null;
  /** bracketSettings' display override (bracketConst SHOW_DEFAULT / SHOW_NONE / SHOW_ALL): Alt+Z, Alt+Shift+Z. */
  private bracketOverride: BracketOverride = "default";
  private showSpecialBrackets = false;
  /** Warp.py's sound flags for the ship's own warp: the explosion played (hasExploded), the wind playing (hasWind). */
  private warpSound = { exploded: false, wind: false };
  /** CmdAccelerate / CmdDecelerate's CallCombiner (0.3 s). */
  private speedCombiner: ReturnType<typeof setTimeout> | null = null;
  /** The system the space menu's reads were last primed for. */
  private primedSystem: number | null = null;
  private shortcutIndication: { header: string; sub: string } | null = null;
  private temporaryIndication: { header: string; sub: string; until: number } | null = null;
  private readonly modeHeader = document.createElement("div");
  private readonly modeSub = document.createElement("div");
  private readonly modeProgress = document.createElement("div");
  private readonly modeProgressFill = document.createElement("div");
  private readonly alertVignette = document.createElement("div");
  /** ShipAlertContainer.warningLabel (TextHeadline 24, bold, uppercase), 100 px above the HUD's edge. */
  private readonly alertLabel = document.createElement("div");
  /** When the page itself ejected (menuFunctions.Eject: the session change 'eject', which brings no warning). */
  private ejectNotedAt = -Infinity;
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
    // my_ship_bracket.OreHoldBracket's CircularInventoryGauge (32 x 32): its ten cargo_hold_segment sprites over
    // cargo_hold_bg (0.2), and the TextBody label 8 px to its right, shown on a hover
    {
      const tex = (n: string) => `url(${clientTexture(`res:/UI/Texture/Classes/Mining/${n}.png`)})`;
      const layer = (n: string, cls: string) => `<span class="${cls}" style="-webkit-mask-image:${tex(n)};mask-image:${tex(n)}"></span>`;
      this.miningHoldBracket.innerHTML = layer("cargo_hold_bg", "mh-bg") + Array.from({ length: 10 }, (_, i) => layer(`cargo_hold_segment_${i + 1}`, "mh-seg")).join("") + `<span class="mh-label"></span>`;
    }
    // (CircularInventoryGauge has no OnClick or menu of its own: it takes the mouse for its label, nothing more)
    this.miningHoldBracket.addEventListener("pointerdown", event => event.stopPropagation());
    this.miningHoldBracket.addEventListener("click", event => event.stopPropagation());
    // uilib.FindMenuHandler asks the control under the mouse alone: no GetMenu, no menu (nor the browser's)
    this.miningHoldBracket.addEventListener("contextmenu", event => { event.preventDefault(); event.stopPropagation(); });
    this.brackets.appendChild(this.miningHoldBracket);
    this.root.appendChild(this.brackets);
    this.sensorLayer.className = "sensor-overlay";
    this.root.appendChild(this.sensorLayer);
    document.addEventListener("pointermove", (e) => { this.pointerAt = { x: e.clientX, y: e.clientY, target: e.target }; }, { passive: true });
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
      this.shipHud.onDropOnCargo = (data) => this.actions.dropOnCargo?.(data);
      this.shipHud.onSafetySelector = (at) => this.actions.safetySelector?.(at);
      this.shipHud.healthFacts = (index) => this.actions.healthFacts?.(index) ?? null;
      this.shipHud.overloadAllowed = () => this.actions.overloadAllowed?.() ?? null;
      this.shipHud.onRackDisabled = () => this.sayDisabled();
      this.shipHud.tooltipRows = (m) => this.options.rack?.tooltip?.(m) ?? null;
      // ModuleController.ShowRange: bracketMgr.ShowModuleRange(maxRange + falloff) while a module is under the pointer
      this.shipHud.onModuleMenu = (m, x, y) => this.actions.moduleMenu?.(m.itemID, m.typeID, x, y);
      if ("onShipMenu" in this.shipHud) this.shipHud.onShipMenu = (x, y) => { const id = this.snapshot?.ship?.itemID; if (id) dispatchEvent(new CustomEvent("evejs:open-space-menu", { detail: { itemID: id, x, y, tail: [] } })); };
      this.shipHud.onModuleHover = (m) => {
        const [optimal, falloff] = m ? this.options.rack?.rangeParts?.(m) ?? [0, 0] : [0, 0];
        const r = optimal + falloff;
        this.moduleRange = r > 0 ? r : null;
        // tactical.ShowModuleRange / ClearModuleRange (cleared 500 ms after the pointer leaves, unless another is shown):
        // TacticalCompass.SetFiringRange(optimal, falloff) where the optimal is above 0
        clearTimeout(this.firingRangeClear);
        if (m) this.firingRange = optimal > 0 ? [optimal, falloff] : null;
        else this.firingRangeClear = setTimeout(() => { this.firingRange = null; }, 500);
        this.inRangeDue = true;
        // ShowHairlinesForModule after ShowModuleRange (StopShowingModuleRange stops them)
        if (m) this.showHairlines(m.itemID, false); else this.stopHairlines();
      };
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
    this.modeEl.append(this.modeHeader, this.modeSub, this.modeProgress, this.locationBanner.el);
    this.alertVignette.className = "ship-hud-vignette";
    this.alertVignette.setAttribute("aria-hidden", "true");
    this.root.append(this.alertVignette);
    this.alertLabel.className = "ship-alert-label";
    this.alertLabel.setAttribute("aria-hidden", "true");
    Object.assign(this.alertLabel.style, { position: "absolute", left: "50%", transform: "translateX(-50%)", width: "400px", height: "40px", lineHeight: "40px",
      textAlign: "center", font: "bold 24px 'EVE Sans Neue','Segoe UI',sans-serif", textTransform: "uppercase", color: "rgb(255,0,0)", opacity: "0", pointerEvents: "none", zIndex: "5" });
    this.root.append(this.alertLabel);
    // (as the eve-cs mirror has it: always on screen, 464 x 135 at the top right, its icon the client's show-info one,
    // "No object selected" while nothing is)
    // SelectedItemWnd: actionPanelDefaults' place and size (566 wide, 174 high, 16 from the right and the top), no icon
    // its window menu (GetMenuMoreOptions as a pilot has it): Minimize, then Copy (_CopyText: the name with a gate's
    // security, the distance and the security status, a line each)
    this.selectedWin = new PlayWindow({ id: "selected-item", caption: "Selected Item", left: innerWidth - 566 - 16, top: 16, width: 566, height: 174, minWidth: 256, closable: false, chrome: "small",
      menu: (button) => {
        const r = button.getBoundingClientRect();
        const text = [...this.selectedWin.body.querySelectorAll<HTMLElement>(".si-name, .si-dist, .si-sec")].map((el) => el.textContent ?? "").filter(Boolean).join("\n");
        const say = (label: string, own: string) => this.actions.word?.(label) ?? own;
        // the window's actions (CompactModeWindowAction - SelectedItemWnd._on_compact_mode_changed: no caption, the content up
        // into the header), then GetMenuMoreOptions: Minimize, Copy
        const on = this.selectedWin.root.classList.contains("si-compact");
        this.contextMenu.open(r.left, r.bottom, [
          ...this.selectedWin.windowActions(say, {
            label: on ? say("/Carbon/UI/Controls/Window/DisableCompactMode", "Disable compact mode") : say("/Carbon/UI/Controls/Window/EnableCompactMode", "Enable compact mode"),
            icon: on ? "res:/UI/Texture/eveicon/system_icons/uncompact_16px.png" : "res:/UI/Texture/eveicon/system_icons/compact_16px.png",
            run: () => this.setSelectedCompact(!on) }),
          { label: this.actions.word?.("UI/Control/EveWindow/Minimize") ?? "Minimize", icon: "res:/UI/Texture/eveicon/system_icons/minimize_16px.png", run: () => this.selectedWin.minimize() },
          { label: this.actions.word?.("UI/Generic/Copy") ?? "Copy", disabled: text ? null : "Nothing selected", run: () => void navigator.clipboard?.writeText(text).catch(() => {}) },
        ]);
      } });
    this.selectedWin.body.classList.add("si");
    try { if (localStorage.getItem("evejs.ui.selectedItemCompact") === "1") this.setSelectedCompact(true); } catch { /* not compact */ }
    // the space components the menu reads (deployableTypes.json), read before the first right-click
    void spaceComponents();
    // SelectedItemWnd._OnResize -> _UpdateButtonSize: the button size follows the window width
    new ResizeObserver(() => this.sizeSelectedButtons()).observe(this.selectedWin.root);
    this.selectedEl = this.selectedWin.root;
    this.root.insertBefore(this.targetBar.root, this.modeEl);
    this.targetBar.onSelect = (id) => this.select(id);
    // Weapon.ClickWeapon: the module clicked, as its slot would be (switched off)
    this.targetBar.onWeaponClick = (moduleID) => { const m = this.options.rack?.modules().find((each) => each.itemID === moduleID); if (m) void this.useRackModule(m); };
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
    const makeOverview = (instanceID: number) => new Overview({
      instanceID,
      nameHint: (e) => this.shipLabelName(e),
      select: (id) => this.select(id),
      activate: (id) => this.activateSpaceTarget(id),
      glyph,
      // OverviewScrollEntry.LoadIconTooltipPanel's lines after the group: HostileAction or TargetLock, the hacked hint,
      // GetIconColor's hint, and for a harvestable thing mining_util.get_volume_est_price_formatted
      iconSortValue: (e) => iconLook(e).sort,
      iconTooltipLines: (e) => {
        const word = (label: string, own: string, args?: Readonly<Record<string, string | number>>) => this.actions.word?.(label, args) ?? own;
        const threat: string[] = [], icon: string[] = [], out: string[] = [];
        // SpaceObjectIcon.UpdateSpaceObjectIcon's iconHint for a wreck: EmptyWreck or ContainsLoot
        if (e.groupID === 186) {
          const empty = (e as Entity & { isEmpty?: boolean }).isEmpty === true;
          icon.push(empty ? word("Tooltips/Overview/EmptyWreck", "Empty wreck") : word("Tooltips/Overview/ContainsLoot", "Contains loot items"));
        }
        if (this.attackers.has(e.itemID)) threat.push(word("Tooltips/Overview/HostileAction", "Hostile action"));
        else if (this.targeters.has(e.itemID)) threat.push(word("Tooltips/Overview/TargetLock", "Target lock"));
        const hint = iconLook(e).hint;
        if (hint) out.push(word(hint, hint));
        const price = (e.categoryID === 25 || e.groupID === 711) ? this.options.flightSnapshot?.()?.entities.find((x) => x.itemID === e.itemID)?.oreValuePerM3 ?? null : null;
        if (price !== null && price > 0) {
          const isk = iskAndRound(price);
          out.push(word("UI/Shared/EstimatedPricePerSquareMeter", `${isk} / m³`, { iskString: isk }));
        }
        return { threat, icon, after: out };
      },
      targetState: (id) => ({ locked: this.locked.has(id), active: id === this.activeTarget, hostile: this.targeters.has(id), attacking: this.attackers.has(id),
        fleet: this.isFleetMemberShip(id),
        locking: !this.locked.has(id) && (this.lockingIDs.has(id) || this.acquiringTargets.has(id)) }),
      name: (e) => this.nameOf(e),
      pilotID: options.overviewPilotID,
      word: (label, args) => this.actions.word?.(label, args) ?? null,
      requestWords: (labels) => this.actions.requestWords?.(labels),
      notice: options.overviewNotice,
      ask: options.overviewAsk,
      say: options.overviewSay,
      affiliation: (rows, columns) => options.overviewAffiliation?.(rows, columns) ?? null,
      hover: (id) => this.setHovered(id),
      followLink: (url, text) => this.actions.followLink?.(url, text),
      currentBroadcasts: () => this.actions.currentBroadcasts?.() ?? new Set(),
      bracketOverride: () => this.bracketOverride,
      setBracketOverride: (value) => { this.bracketOverride = value; },
      otherWindows: (from) => [this.overview, ...this.extraOverviews].filter((o) => o !== from),
      tabsEdited: (from) => {
        for (const o of [this.overview, ...this.extraOverviews]) if (o !== from) o.reloadTabs();
        for (const o of [...this.extraOverviews]) if (o.tabCount === 0) this.removeOverviewWindow(o);
      },
      // presetSvc.MoveTab: the tab out of its window into another, or a new one; a window left without tabs closes
      moveTab: (from, tab, to) => {
        const target = to === null ? this.addOverviewWindow(makeOverview) : [this.overview, ...this.extraOverviews].find((o) => o.instanceID === to);
        if (!target) return;
        const t = from.takeTab(tab);
        if (!t) return;
        target.receiveTab(t);
        if (from !== this.overview && from.tabCount === 0) this.removeOverviewWindow(from);
      },
    });
    this.makeOverview = makeOverview;
    this.overview = makeOverview(0);
    this.overview.window.root.classList.add("space-only-window");
    this.layer.appendChild(this.overview.window.root);
    this.hairlineSvg.setAttribute("class", "module-hairlines");
    this.hairlineSvg.innerHTML = `<polyline class="hl-line" fill="none"/><polyline class="hl-trace" fill="none"/>`;
    this.layer.appendChild(this.hairlineSvg);
    // Weapon.OnMouseEnterWeapon: the hairline drawn the other way (reverse), from the weapon icon back to the module
    this.targetBar.word = (label, args) => this.actions.word?.(label, args) ?? null;
    this.targetBar.onWeaponHover = (moduleID) => { if (this.shipHud && "highlightModule" in this.shipHud) this.shipHud.highlightModule(moduleID); if (moduleID !== null) this.showHairlines(moduleID, true); else this.stopHairlines(); };
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
    // CmdOpenRadialMenu held: the radial menu at the press, with no delay (radialMenuSvc's noDelay)
    const radialNow = () => this.combat?.cmd === "CmdOpenRadialMenu";
    const openRadialFrom = (from: () => RadialFrom) => (id: number, x: number, y: number, button: number) => (button === 2 ? this.openContext(id, x, y) : this.openRadial(id, x, y, button, from()));
    const openRadial = openRadialFrom(() => null);
    // RadialMenu.UpdateIndicator: the clicked object's ShowRadialMenuIndicator - a bracket's (navigation's, for space,
    // is the bracket's too) or an overview entry's
    const openFromBracket = openRadialFrom(() => "bracket");
    const openFromRow = (el: HTMLElement) => openRadialFrom(() => [this.overview, ...this.extraOverviews].find((o) => o.window.body === el) ?? null);
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
        combatClick: (itemID) => {
          const combat = this.combat?.cmd ?? this.modifierCombat();
          if (combat && combat !== "CmdSelectTargetItem" && this.snapshot?.entities.some((x) => x.itemID === itemID)) this.runCombat(combat, itemID);
        },
        showInfo: (itemID, typeID) => this.options.showInfo?.(itemID, typeID),
        menu: (itemID, _typeID, x, y) => dispatchEvent(new CustomEvent("evejs:open-space-menu", { detail: { itemID, x, y } })),
      }, this.layer);
      this.dscan.window.root.classList.add("space-only-window");
      this.layer.appendChild(this.dscan.window.root);
      this.raiseOnClick(this.dscan.window.root);
    }
    addEventListener("keydown", this.onKey);
    // a panel's MapBtnClicked (the probe scanner's solar system map button): CmdToggleSolarSystemMap
    const toggleMap = () => this.systemMap?.toggle();
    addEventListener("evejs:toggle-solar-system-map", toggleMap);
    this.unhold.push(() => removeEventListener("evejs:toggle-solar-system-map", toggleMap));
    // a window's entry for an object in space (the drones window's DroneInSpaceEntry: TryExpandActionMenu with its itemID)
    // opens that object's own radial menu
    const radialFor = (e: Event) => { const d = (e as CustomEvent<{ itemID: number; x: number; y: number; entry?: HTMLElement | null }>).detail; if (d) this.openRadial(d.itemID, d.x, d.y, 0, d.entry ?? null); };
    addEventListener("evejs:open-space-radial", radialFor);
    // CmdBack / CmdForward (Mouse 4 / Mouse 5, commandSvc: the active window's OnBack / OnForward): to the windows; the
    // browser's own back / forward on those buttons kept from leaving the page
    const mouseCmd = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.type === "mouseup") dispatchEvent(new CustomEvent(e.button === 3 ? "evejs:cmd-back" : "evejs:cmd-forward"));
    };
    addEventListener("mousedown", mouseCmd);
    addEventListener("mouseup", mouseCmd);
    this.unhold.push(() => { removeEventListener("mousedown", mouseCmd); removeEventListener("mouseup", mouseCmd); });
    this.unhold.push(() => removeEventListener("evejs:open-space-radial", radialFor));
    // and its context menu: DroneInSpaceEntry.GetMenu - the window's own entries (Move Drone) with CelestialMenu over the
    // drone, the window's merged into the drone group by menuHierarchy
    const menuFor = (ev: Event) => {
      const d = (ev as CustomEvent<{ itemID: number; itemIDs?: number[]; x: number; y: number; droneExtra?: ContextEntry[]; tail?: (ContextEntry | null)[]; beforeLogoff?: ContextEntry[] }>).detail;
      const e = d ? this.snapshot?.entities.find((x) => x.itemID === d.itemID) : null;
      if (!d || !e) return;
      this.radial.close();
      const ids = (d.itemIDs ?? [d.itemID]).filter((id) => this.snapshot?.entities.some((x) => x.itemID === id));
      // a window's own entries after the object's menu, a group of their own (an inventory tree entry's TreeDataInv and
      // TreeViewEntry.GetMenu: Open in new window, then a line and Close)
      let entries = ids.length > 1 ? this.mergedDroneEntries(e, ids, d.droneExtra ?? []) : this.contextEntries(e, d.droneExtra ?? []);
      // a tree entry's own entries that the client sorts ahead of the ship's destructive ones (the ship's cargo entry's Open
      // in new window, before Log Off Safely / Eject / Self-Destruct), a group of their own
      if (d.beforeLogoff?.length) {
        const LAST = new Set(["UI/Inflight/SafeLogoff", "UI/Inflight/EjectFromShip", "UI/Inflight/SelfDestructShipOrPod", "UI/Inflight/AbortSelfDestruct"]);
        const at = entries.findIndex((x) => x !== null && LAST.has(x.path ?? ""));
        const cut = at < 0 ? entries.length : at > 0 && entries[at - 1] === null ? at - 1 : at;
        entries = [...entries.slice(0, cut), null, ...d.beforeLogoff, ...entries.slice(cut)];
      }
      this.contextMenu.open(d.x, d.y, d.tail?.length ? [...entries, null, ...d.tail] : entries);
    };
    addEventListener("evejs:open-space-menu", menuFor);
    // invWindow.OnTreeViewClick / OnTreeViewMouseEnter / OnTreeViewMouseExit: an inventory tree entry of an object in the
    // ballpark (not the station docked at) sets its selected state on a click and its mouse-over state while under the mouse
    const selectFor = (ev: Event) => { const id = (ev as CustomEvent<{ itemID: number }>).detail.itemID; if (this.snapshot?.ship?.itemID === id || this.snapshot?.entities.some((x) => x.itemID === id)) this.setSelectedState(id); };
    const hoverFor = (ev: Event) => { const d = (ev as CustomEvent<{ itemID: number; on: boolean }>).detail; if (d.on) this.setHovered(d.itemID); else if (this.hoveredID === d.itemID) this.setHovered(null); };
    addEventListener("evejs:select-space-item", selectFor);
    addEventListener("evejs:hover-space-item", hoverFor);
    this.unhold.push(() => { removeEventListener("evejs:select-space-item", selectFor); removeEventListener("evejs:hover-space-item", hoverFor); });
    this.unhold.push(() => removeEventListener("evejs:open-space-menu", menuFor));
    addEventListener("keyup", this.onKeyUp);
    addEventListener("blur", this.onBlur);
    addEventListener("pointerdown", this.onPointer, true);
    this.unhold.push(
      holdToOpen(this.brackets, rowID, openFromBracket, true, radialNow),
      holdToOpen(this.overview.window.body, rowID, openFromRow(this.overview.window.body), true, radialNow),
      holdToOpen(this.renderer.domElement, (x, y) => this.pickAt(x, y), openFromBracket, true, radialNow),
      // TargetInBar.OnTargetMouseDown: a locked target's own radial (TryExpandActionMenu) - not off a weapon icon under it;
      // its right click is its own CelestialMenu
      holdToOpen(this.targetBar.root, (_x, _y, e) => {
        const el = e.target as HTMLElement;
        if (el.closest?.("[data-module]")) return null;
        return Number(el.closest?.<HTMLElement>("[data-item-id]")?.dataset.itemId) || null;
      }, openRadial, false, radialNow),
    );
    this.holdOverviewRow = (el) => holdToOpen(el, rowID, openFromRow(el), true, radialNow);
    // the overview windows the tabs were moved to before, opened again (OverviewWindow per windowInstanceID)
    for (const id of this.overview.storedWindowIDs()) this.addOverviewWindow(this.makeOverview!, id);
    // Brackets drawn before the client's tables are here are drawn again with the client's icons.
    void loadBrackets().then(() => { for (const el of this.bracketEls.values()) el.remove(); this.bracketEls.clear(); });
    this.neocom = new Neocom((id) => (this.options.onNeocom ? this.options.onNeocom(id) : this.toast(`${id[0]!.toUpperCase()}${id.slice(1)} is not on the play page yet.`)));
    this.root.appendChild(this.neocom.root);
    this.renderer.domElement.addEventListener("dblclick", (e) => this.doubleClick(e));
    // a right-click in space (navigation.OnMouseUp, GetMenu): the thing under it (its pick) its CelestialMenu, else the
    // space menu; a right drag is no click
    let rightDown: [number, number] | null = null;
    this.renderer.domElement.addEventListener("pointerdown", (e) => { if (e.button === 2) rightDown = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const from = rightDown;
      rightDown = null;
      if (from && Math.hypot(e.clientX - from[0], e.clientY - from[1]) > 4) return;
      // navigation.GetMenu with CmdGetLocationMenuForNavigation held (IsCombatCommandLoaded): the bookmarks' navigation
      // menu alone (GetBookmarkMenuForNavigation, includeTopLevel False), else NoLocationsFoundForMenu
      if (this.combat?.cmd === "CmdGetLocationMenuForNavigation") {
        const locations = this.actions.locationsMenu?.()[0]?.sub ?? [];
        if (locations.length) { this.radial.close(); this.contextMenu.open(e.clientX, e.clientY, locations); }
        else this.options.overviewSay?.("NoLocationsFoundForMenu", "There are no locations to show.");
        return;
      }
      const id = this.pickAt(e.clientX, e.clientY);
      if (id !== null) this.openContext(id, e.clientX, e.clientY); else this.openSpaceMenu(e.clientX, e.clientY);
    });
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
    // navigation.CheckStartMoveCommand / OnMouseMove / OnMouseExit: the move command started with Approach held and no
    // button down, dropped by a left drag, and on leaving space before its first point
    this.renderer.domElement.addEventListener("pointermove", (e) => {
      this.movePointer = { x: e.clientX, y: e.clientY };
      if (this.combat?.cmd === "CmdApproachItem" && !this.moveCmd && !(e.buttons & 1)) this.startMoveCommand();
      if (this.moveCmd && (e.buttons & 1)) this.abortMoveCommand();
    });
    this.renderer.domElement.addEventListener("pointerleave", () => { if (this.moveCmd && this.moveCmd.state === 0) this.abortMoveCommand(); });
    this.renderer.domElement.addEventListener("click", (e) => {
      // navigation.OnMouseUp: with the move command on, a left click is its next point
      if (this.moveCmd) { this.addMovePoint(); return; }
      const picking = this.dscanKey || this.combat || this.modifierCombat(false) || !this.targetingCursor.hidden;
      const id = picking ? this.pickAt(e.clientX, e.clientY) : null;
      this.select(id);
    });
    addEventListener("resize", () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** SelectedItemWnd in compact mode (its caption hidden, the name row in the header, kept). */
  private setSelectedCompact(on: boolean): void {
    this.selectedWin.root.classList.toggle("si-compact", on);
    // _UpdateMinSize: 200 wide in compact mode, else default_minSize 256
    this.selectedWin.setMinWidth(on ? 200 : 256);
    try { localStorage.setItem("evejs.ui.selectedItemCompact", on ? "1" : "0"); } catch { /* lasts the page */ }
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
    for (const el of [this.selectedEl, this.overview.window.root, ...this.extraOverviews.map((o) => o.window.root), this.dscan?.window.root, this.radial.root]) el?.remove();
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
    // the location banner, a temporary indication, holds the indication while it is up
    const bannerUp = this.locationBanner.active && !this.shortcutIndication;
    const header = bannerUp ? "" : text?.header ?? "", sub = bannerUp ? "" : text?.sub ?? "";
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
      this.alertVignetteFlash = this.alertVignette.animate([{ opacity: 0, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" }, { opacity: level === HULL ? 1 : 0.7, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" }, { opacity: 0 }], {
        // (ANIM_WAVE: a smoothstep to the peak at half the duration and another back - each segment eased, not the whole)
        duration,
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

  /**
   * prompt_player_fsd_dialog('Disabled'): the message is of type audio (cfg.GetMessage, read through gridcheck: no title or
   * text, audio msg_Disabled_play) - the client only plays its sound; the page had put up the word Disabled.
   */
  sayDisabled(): void { void playUiEvent("msg_Disabled_play"); }

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
    this.setSelectedState(itemID);
    return true;
  }

  /** stateSvc.SetState(itemID, selected, 1): the object selected, with no click's combat command or scan run on it. */
  private setSelectedState(itemID: number | null): void {
    this.selected = itemID;
    this.options.onSelectionChange?.(itemID);
    // overviewWindow.OnScrollSelectionChange and inSpaceBracket.OnClick:
    // a selected object becomes the active target when it is already locked.
    if (itemID !== null && this.locked.has(itemID)) this.activeTarget = itemID;
    for (const [id, el] of this.bracketEls) el.classList.toggle("selected", id === itemID);
    this.overview.setSelected(itemID);
    for (const o of this.extraOverviews) o.setSelected(itemID);
    if (itemID !== null && !this.targetingCursor.hidden) this.chooseModuleTarget(itemID);
    this.renderSelected();
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
    // ExpandedBracketAsteroid (read through gridcheck on a selected Veldspar): at the bracket +118, +60, the diagonal callout
    // line (95 x 65 at -100, -46, 0.5), its grid 8 down - the type's name (TextBody 14 white, shadowed, on panel1CornerTopRight
    // at 0.2), then TextDetail 12 lines at 0.75, each "<b>label</b> value" (white, then HIGHLIGHT's e6e6e6): Distance (the
    // surface distance, FmtDist), and with a survey Value, Total value and Quantity
    let details = el.querySelector<HTMLElement>(".mining-details");
    if (!details) {
      details = document.createElement("div");
      details.className = "mining-details";
      details.innerHTML = `<img class="eb-callout" alt="" src="${clientTexture("res:/UI/Texture/classes/Bracket/callout_line_diagonal.png")}"><div class="eb-grid"><div class="eb-name"></div><div class="eb-lines"></div></div>`;
      el.appendChild(details);
    }
    const name = this.nameOf(entity);
    const nameEl = details.querySelector<HTMLElement>(".eb-name")!;
    if (nameEl.textContent !== name) nameEl.textContent = name;
    const escapeHtml = (t: string) => t.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
    const pair = (label: string, value: string) => `<b>${escapeHtml(label)}</b> <span>${escapeHtml(value)}</span>`;
    const rows = [pair(this.actions.word?.("UI/Common/Distance") ?? "Distance", fmtDistance(this.distanceTo(entity), 1))];
    for (const line of lines) {
      // ExpandedBracketAsteroid._show_critical_hit: the crit_success icon (16) and UI/Mining/CriticalHit in
      // MiningQuantityColor.CRIT_BONUS (DESTINATION_YELLOW), blinking in three times, held 2 s, faded over 0.6 s
      const crit = /^Critical yield \+([0-9,]+)$/.exec(line);
      if (crit) {
        const amount = Number(crit[1]!.replace(/,/g, ""));
        const text = this.actions.word?.("UI/Mining/CriticalHit", { amount }) ?? `Critical Success +${amount.toLocaleString()}`;
        rows.push(`<span class="eb-crit"><span class="eb-crit-icon"></span>${escapeHtml(text)}</span>`);
        continue;
      }
      const m = /^(Total Value|Value|Quantity)\s*(.*)$/.exec(line);
      rows.push(m ? pair(m[1]!, m[2]!) : escapeHtml(line));
    }
    const html = rows.map((r) => `<div class="eb-line">${r}</div>`).join("");
    const linesEl = details.querySelector<HTMLElement>(".eb-lines")!;
    if (linesEl.innerHTML !== html) linesEl.innerHTML = html;
    details.hidden = false;
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
    // OreHoldBracket._update_offset: a transform on the ship's model at shapeEllipsoidCenter + (0, 0, -(zoom + 1) x
    // shapeEllipsoidRadius.z) - behind the hull, whose nose is +z in its own space; the model's origin without one
    let model: THREE.Object3D | null = null;
    this.marks.get(ego.itemID)?.traverse((o) => { if (!model && o.userData && "shapeEllipsoid" in o.userData) model = o; });
    const anchor = new THREE.Vector3();
    const ell = (model as THREE.Object3D | null)?.userData.shapeEllipsoid as { center: number[]; radius: number[] } | null | undefined;
    if (model) {
      const m = model as THREE.Object3D;
      if (ell) anchor.set(ell.center[0] ?? 0, ell.center[1] ?? 0, (ell.center[2] ?? 0) - (zoom + 1) * (ell.radius[2] ?? 0));
      m.updateWorldMatrix(true, false);
      m.localToWorld(anchor);
    }
    const p = anchor.project(this.camera);
    // EveProjectBracket: hidden behind the camera (dock off), centred on the projected point otherwise
    badge.hidden = opacity === 0 || p.z >= 1;
    if (badge.hidden) { this.miningHoldUsed = null; return; }
    // update_segments: segment i lit where the ratio passes i / 9, white and the last two WARNING_ORANGE, every one
    // orange when the hold is full; update_label_text: UI/Mining/MiningHoldCapacityPercentage of the hold's name
    // (GetNameForFlag) and int(ratio x 100), orange when full
    const ratio = capacity.used / capacity.capacity;
    const ORANGE = "rgb(243, 144, 88)";
    badge.querySelectorAll<HTMLElement>(".mh-seg").forEach((seg, i) => {
      const lit = ratio > i / 9 || ratio >= 1;
      const colour = ratio >= 1 ? ORANGE : lit ? (i >= 8 ? ORANGE : "#fff") : "transparent";
      if (seg.style.backgroundColor !== colour) seg.style.backgroundColor = colour;
    });
    const holdWords = this.options.indicationWords?.() ?? {};
    const def = hold.key === CARGO_HOLD.bayKey ? CARGO_HOLD : SHIP_HOLDS.find((x) => x.bayKey === hold.key);
    const t = def ? holdWords[def.label] : null;
    const name = typeof t === "string" && t !== "" ? plainText(t) : hold.label;
    const pct = Math.floor(ratio * 100);
    const text = this.actions.word?.("UI/Mining/MiningHoldCapacityPercentage", { hold_name: name, capacity: pct }) ?? `${name} ${pct}%`;
    const label = badge.querySelector<HTMLElement>(".mh-label")!;
    if (label.textContent !== text) label.textContent = text;
    label.style.color = ratio >= 1 ? ORANGE : "";
    // animate_full: an item arriving while the hold is full morphs every segment's glowBrightness 2.0 back to 0.2 over 2 s
    if (ratio >= 1 && this.miningHoldUsed !== null && capacity.used > this.miningHoldUsed) {
      badge.querySelectorAll<HTMLElement>(".mh-seg").forEach((seg) => seg.animate(
        [{ filter: "brightness(2) drop-shadow(0 0 3px currentColor)" }, { filter: "brightness(1) drop-shadow(0 0 0 transparent)" }],
        { duration: 2000, easing: "cubic-bezier(0.3333, 0, 0.6667, 1)" }));
    }
    this.miningHoldUsed = capacity.used;
    badge.style.opacity = String(opacity);
    badge.style.transform = `translate(${Math.round((p.x + 1) * width / 2 - 16)}px, ${Math.round((1 - p.y) * height / 2 - 16)}px)`;
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
    // a drone: Scoop to Drone Bay (selectedItemScoopToDroneBay, ICON_DRONE_RETURN 44_32_1), greyed where the menu has it not (one
    // under the pilot's control, droneCheckers.IsScoopableDrone)
    if (e.categoryID === 18) out.push({ key: "scoop", title: this.actions.word?.("UI/Drones/ScoopDroneToBay") ?? "Scoop to Drone Bay", icon: clientTexture("res:/UI/Texture/icons/44_32_1.png"),
      run: async () => this.actions.droneOrder?.("scoop", [id]) });
    // (the own ship too: its Board Ship button shown disabled, IsYourShip)
    if (e.categoryID === 6 || e.isSelf) out.push({ key: "board", title: this.actions.word?.("UI/Inflight/BoardShip") ?? "Board Ship", icon: icon("board"), run: async () => {} });
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
    // selectedItemConst groupMoon: 'UI/Inflight/WarpToMoonMiningPoint' (ICON_WARP_TO_MOON_MINING_POINT
    // Moonmining/warpToMiningPoint.png) - enabled where the moon menu has the entry (a mining point's beacon in the
    // scene), else shown disabled (_GetDisabledMenuLabel: the label with distance 0)
    if (e.groupID === 8 && this.actions.warpToMoonMiningPoint) {
      const warpPoint = this.actions.warpToMoonMiningPoint;
      out.push({ key: "moonPoint", title: "Warp to Mining Point", icon: clientTexture("res:/UI/Texture/Classes/Moonmining/warpToMiningPoint.png"), run: () => warpPoint(id, defaultDistance("WarpTo")) });
    }
    const cargo = this.actions.openCargo;
    let cargoState = selectedCargo(e, this.snapshot?.ship?.mode === "WARP");
    // a deployable's cargo bay (OfferOpenCargoBay: the cargoBay component active, its owner's or free for all), as the
    // client's Selected Item shows Open Cargo for a Mobile Depot
    if (cargoState === "hidden" && e.typeID !== null) {
      const comps = spaceComponentsNow();
      const bay = comps.cargoBay.get(e.typeID);
      const mine = e.ownerID != null && e.ownerID === this.snapshot?.ship?.ownerID;
      if (bay && isActiveComponent(comps, e.typeID, e.componentActive) && (mine || bay[1])) cargoState = this.snapshot?.ship?.mode === "WARP" ? "disabled" : "enabled";
    }
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
    // ACTIONS_ALWAYS_VISIBLE: Lock Target (Unlock Target, its toggle) always shown, greyed where the menu has neither
    out.push(this.locked.has(id)
      ? { key: "unlock", title: "Unlock Target", icon: icon("target"), run: () => this.actions.unlock(id) }
      : { key: "lock", title: "Lock Target", icon: icon("target"), run: () => this.lockTracked(id) });
    out.push({ key: "look", title: "Look At", icon: icon("look_at"), run: async () => this.focusOn(id) });
    // UI/Inflight/SetAsCameraInterest: the camera tracks it (actionConst: camera_track)
    out.push({ key: "track", title: this.actions.word?.("UI/Inflight/SetAsCameraInterest") ?? "Track", icon: icon("camera_track"),
      run: async () => { this.endExplosionCamera(); this.trackedObjective = id; } });
    const showInfo = this.options.showInfo;
    if (showInfo) out.push({ key: "info", title: "Show Info", icon: icon("show_info"), run: async () => showInfo(id, e.typeID ?? null) });
    const drill = this.autoMoonMinerEntry(e);
    if (drill) out.push(drill);
    out.push(...this.metenoxEntries(e));
    // SelectedItemWnd.ReconstructButtons: a button whose entry the object's menu has not now is drawn disabled
    // (MenuHints/NoReasonGiven where no reason is known)
    const available = this.menuPaths(e);
    const PATH: Record<string, string> = { approach: "UI/Inflight/ApproachObject", align: "UI/Inflight/AlignTo", warp: "UI/Inflight/Submenus/WarpToWithin",
      dock: "UI/Inflight/DockInStation", board: "UI/Inflight/BoardShip", orbit: "UI/Inflight/OrbitObject", keep: "UI/Inflight/Submenus/KeepAtRange", lock: "UI/Inflight/LockTarget",
      unlock: "UI/Inflight/UnlockTarget", look: "UI/Inflight/LookAtObject", track: "UI/Inflight/SetAsCameraInterest", info: "UI/Commands/ShowInfo", scoop: "UI/Drones/ScoopDroneToBay" };
    if (e.kind === "stargate") PATH.jump = "UI/Inflight/Jump";
    PATH.moonPoint = "UI/Inflight/WarpToMoonMiningPoint";
    // the menu's reasonsWhyNotAvailable the checkers give: IsValidForKeepAtRange (CannotKeepInRange with the group's name:
    // an asteroid, a cloud, a mining drone, a container, a station, a stargate, a wreck) and IsWithinTargettingRange
    // (NotInTargetRange: farther than the ship's maxTargetRange)
    const reasons: Record<string, string | undefined> = {};
    const category = (e as Entity & { categoryID?: number | null }).categoryID ?? null;
    if (category === 25 || e.kind === "asteroid" || [711, 101, 12, 340, 448, 15, 10, 649, 186].includes(e.groupID ?? -1)) {
      reasons.keep = this.actions.word?.("UI/Menusvc/MenuHints/CannotKeepInRange", { groupName: this.options.groupName?.(e.groupID ?? 0) || this.names?.groups[String(e.groupID)]?.[0] || "" }) ?? undefined;
    }
    // celestialCheckers.IsInteractive (ShipAlreadyPiloted): a ship with a pilot in it cannot be boarded
    // baseCheckers IsYourShip ('UI/Menusvc/MenuHints/IsYourShip'): the movement entries, Board and Lock on the own ship;
    // celestialCheckers AlreadyLookingAtItem: Look At on the thing the camera already looks at (the own ship by default)
    if (e.isSelf) {
      const mine = this.actions.word?.("UI/Menusvc/MenuHints/IsYourShip") ?? "This is your ship";
      for (const k of ["approach", "align", "board", "orbit", "keep", "lock"]) reasons[k] = mine;
    }
    if ((this.lookAt ?? this.snapshot?.entities.find((x) => x.isSelf)?.itemID) === e.itemID) reasons.look = this.actions.word?.("UI/Menusvc/MenuHints/AlreadyLookingAtItem") ?? "Looking at this item";
    if (e.categoryID === 6 && !e.isSelf && e.characterID) reasons.board = this.actions.word?.("UI/Menusvc/MenuHints/ShipAlreadyPiloted") ?? "There is already a pilot in this ship";
    const lockRange = this.actions.shipAttribute?.(76) ?? null;
    if (lockRange !== null && this.distanceTo(e) >= lockRange) reasons.lock = this.actions.word?.("UI/Menusvc/MenuHints/NotInTargetRange") ?? undefined;
    // IsPlanetMoonAsteroidBelt (BadGroupForAction, 'You can't do that with <group>'): a planet, moon or belt can be neither
    // orbited, kept at range nor locked - its reason before the others
    // celestialCheckers isInApproachRange / isInOrbitRange (NotInApproachRange / NotInOrbitRange: not nearer than
    // maxApproachDistance, 10,000 km) and NotInWarpRange (nearer than the 150 km a warp needs)
    const range = this.distanceTo(e);
    if (range >= 10_000_000) {
      reasons.approach = this.actions.word?.("UI/Menusvc/MenuHints/NotInApproachRange") ?? reasons.approach;
      reasons.orbit = this.actions.word?.("UI/Menusvc/MenuHints/NotInOrbitRange") ?? reasons.orbit;
    }
    // celestialCheckers.GetMiningBeaconPosition (explain_failure_with UI/Moonmining/MoonHasNoMiningPoint): a moon with no
    // mining point's beacon
    if (e.groupID === 8 && !this.snapshot?.entities.some((x) => x.itemID === 1_000_000_000 + e.itemID)) reasons.moonPoint = this.actions.word?.("UI/Moonmining/MoonHasNoMiningPoint") ?? reasons.moonPoint;
    // (no reason on the Warp button: its action name is 'UI/Inflight/Submenus/WarpToWithin', and the menu files
    // NotInWarpRange under 'UI/Inflight/WarpToWithinDistance' - SelectedItemWnd shows NoReasonGiven; read live, g187)
    if ([7, 8, 9].includes(e.groupID ?? -1)) {
      // (GetGroupNameByGroup: the group's own name - from the space view's name table where the page's resolver has none)
      const groupName = this.options.groupName?.(e.groupID ?? 0) || this.names?.groups[String(e.groupID)]?.[0] || "";
      const bad = this.actions.word?.("UI/Menusvc/MenuHints/BadGroupForAction", { groupName }) ?? undefined;
      if (bad) { reasons.approach = bad; reasons.orbit = bad; reasons.keep = bad; reasons.lock = bad; if (!reasons.look) reasons.look = bad; }
    }
    // SelectedItemButton._GetActionLabel: the menu entry's descriptive text (Orbit (1,000 m), Look at); a disabled
    // button's is its label path's alone (_GetDisabledMenuLabel: Warp to Within)
    return out.map((a) => {
      const path = PATH[a.key];
      if (!path) return a;
      const label = available.get(path);
      if (label) return { ...a, title: label };
      // _GetMenuEntryData's TOGGLE_ACTIONS: Look At not offered, the menu's Reset Camera (Look At My Ship) in its place - the
      // own ship's, and the thing the camera already looks at
      const reset = a.key === "look" ? available.get("UI/Inflight/ResetCamera") : undefined;
      if (reset) return { key: a.key, icon: a.icon, title: reset, run: async () => this.focusOn(null) };
      if (a.disabled) return a;
      return { ...a, title: (a.key === "moonPoint" ? this.actions.word?.(path, { distance: fmtDistance(0) }) : this.actions.word?.(path)) ?? a.title, disabled: true, disabledReason: a.disabledReason ?? reasons[a.key] ?? this.actions.word?.("UI/Menusvc/MenuHints/NoReasonGiven") ?? "No reason given" };
    });
  }

  /** The label paths of an object's menu now (its entries and their submenus'). */
  /** The object's menu entries now, by label path, with their texts (the Selected Item's _GetValidActionsByName). */
  private menuPaths(e: Entity): Map<string, string> {
    const out = new Map<string, string>();
    // SelectedItemWnd.GetAllActionsFromMenus: the menu's enabled entries, and one level into the SUB_MENU_ACTIONS
    // submenus only ('UI/Inflight/MoonMiningPoint'), an entry of the top level winning - never another object's
    // entries (a planet's Moons submenu holds each moon's Warp to Within)
    const top = this.contextEntries(e);
    const sub: ContextEntry[] = [];
    for (const x of top) if (x && !x.disabled) {
      if (x.path && !out.has(x.path)) out.set(x.path, x.label);
      if (x.path === "UI/Inflight/MoonMiningPoint") for (const y of x.sub ?? []) if (y) sub.push(y);
    }
    for (const y of sub) if (y.path && !y.disabled && !out.has(y.path)) out.set(y.path, y.label);
    return out;
  }

  private planetViewEntry(entity: Entity): ItemAction | null {
    const view = this.options.viewPlanet;
    return entity.kind === "planet" && view ? {
      key: "planet", title: this.actions.word?.("UI/PI/Common/ViewInPlanetMode") ?? "View in Planet Mode",
      // actionConst ViewInPlanetMode eveicon.enter_planet_view (the live client's button: selectedItemViewInPlanetMode
      // enter_planet_view_32px, g328 - not selectedItemConst ICON_PLANET_VIEW 77_32_34, which the radial keeps)
      icon: clientTexture("res:/UI/Texture/eveicon/control_icons/enter_planet_view_32px.png"), run: () => view(entity.itemID),
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
        // SetNoContentHint(UI/Inflight/ActiveItem/NoObjectSelected): an EveCaptionMedium at (16, 18), 256 wide, SECONDARY
        const hint = this.actions.word?.("UI/Inflight/ActiveItem/NoObjectSelected") ?? "No Object Selected";
        body.innerHTML = `<div class="si-none"></div>`;
        body.querySelector(".si-none")!.textContent = hint;
      }
      return;
    }
    const dist = this.distanceTo(e);
    const cargoLabel = selectedCargo(e, false) === "hidden" ? "" : this.actions.word?.(OPEN_CARGO_LABEL) ?? "Open Cargo";
    const wormholeLabel = e.groupID === WORMHOLE_GROUP ? this.actions.word?.(ENTER_WORMHOLE_LABEL) ?? "Enter Wormhole" : "";
    const metenoxRange = e.typeID === METENOX_TYPE_ID ? `${dist <= METENOX_BOARD_RANGE}:${dist < METENOX_DEPOSIT_RANGE}:${dist < METENOX_MATERIAL_RANGE}` : "";
    const gateSecurity = e.groupID === 10 ? this.options.systemSecurity?.((e as Entity & { jumpSystemID?: number | null }).jumpSystemID ?? 0) ?? null : null;
    const availableNow = [...this.menuPaths(e)].join(",");
    // (the group name too: the buttons' reasons name it - CannotKeepInRange - and the names load after the page)
    const sig = `${this.options.groupName?.(e.groupID ?? 0) ?? ""}:${e.itemID}:${gateSecurity}:${availableNow}:${this.locked.has(e.itemID)}:${dist >= 150_000}:${e.jumpBridge?.activationState ?? ""}:${this.snapshot?.ship?.mode === "WARP"}:${cargoLabel}:${wormholeLabel}:${metenoxRange}`;
    if (body.getAttribute("data-sig") !== sig) {
      body.setAttribute("data-sig", sig);
      // SelectedItemWnd._UpdateSlimItem: its picture, GetSlimItemName with a stargate's destination security after it
      // (_GetJumpExtraText), the surface distance (FmtDist to one place), a pilot's security status (_GetSecurityStatusTex)
      const pilotPortrait = e.characterID && !e.isSelf && !e.isNpc ? this.options.portrait?.(e.characterID) ?? null : null;
      body.innerHTML = `<div class="si-top"><img class="si-icon" alt="">${pilotPortrait ? `<span class="si-char"><img alt="" src="${pilotPortrait}"><img class="si-chat" alt="" src="${clientTexture("res:/UI/Texture/eveicon/system_icons/chat_bubble_16px.png")}"></span>` : ""}<div class="si-labels"><div class="si-name"></div><div class="si-dist"></div><div class="si-sec"></div></div></div><div class="si-actions"></div>`;
      const pic = body.querySelector(".si-icon") as HTMLImageElement;
      if (e.typeID !== null) pic.src = `/client-res/type-picture/${e.typeID}/64.png`;
      else pic.style.visibility = "hidden";
      pic.onerror = () => { pic.style.visibility = "hidden"; };
      // CharIcon: a click is Show Info, a right-click the owner's menu (GetMenuForOwner), the chat bubble Start Conversation
      const charEl = body.querySelector<HTMLElement>(".si-char");
      const pilotID = e.characterID ?? null;
      if (charEl && pilotID) {
        const affiliation = { corporationID: e.corporationID ?? null, allianceID: e.allianceID ?? null };
        const chat = charEl.querySelector<HTMLImageElement>(".si-chat")!;
        chat.title = this.actions.word?.("UI/Chat/StartConversation") ?? "Start Conversation";
        chat.addEventListener("click", (ev) => { ev.stopPropagation(); this.options.startConversation?.(pilotID); });
        charEl.addEventListener("click", () => { this.options.pilotMenu?.(pilotID, affiliation)?.sub?.find((x) => x && "info" in x && x.info)?.run?.(); });
        charEl.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const sub = this.options.pilotMenu?.(pilotID, affiliation)?.sub;
          if (sub) this.contextMenu.open(ev.clientX, ev.clientY, sub);
        });
      }
      const nameEl = body.querySelector(".si-name")!;
      nameEl.textContent = this.nameOf(e);
      const jumpSystem = (e as Entity & { jumpSystemID?: number | null }).jumpSystemID ?? null;
      const security = e.groupID === 10 && jumpSystem !== null ? this.options.systemSecurity?.(jumpSystem) ?? null : null;
      if (security !== null) {
        // eveformat.solar_system_security_status: one place, coloured by its class
        const sec = document.createElement("span");
        sec.style.color = securityStatusColor(shownSecurity(security));
        sec.textContent = shownSecurity(security).toFixed(1);
        nameEl.append(" (", sec, ")");
      }
      const pilotSec = e.characterID ? (e as Entity & { securityStatus?: number | null }).securityStatus ?? 0 : 0;
      body.querySelector(".si-sec")!.textContent = pilotSec ? `${this.actions.word?.("UI/Inflight/ActiveItem/SelectedItemSecurity", { secStatus: pilotSec.toFixed(1) }) ?? `Security Status: ${pilotSec.toFixed(1)}`}` : "";
      const row = body.querySelector(".si-actions")!;
      for (const a of this.actionsFor(e)) {
        const b = document.createElement("button");
        b.className = `si-act${a.key === "unlock" ? " on" : ""}`;
        // SelectedItemButton.LoadTooltipPanel: AddLabelShortcut (the action's descriptive text, its command's shortcut),
        // then the disabled hint; pointed from above (POINT_TOP_2)
        // SelectedItemButton.OnMouseEnter: an enabled button plays SOUND_BUTTON_HOVER (ui_button_soft1_play); a disabled one nothing
        b.addEventListener("mouseenter", () => { if (!a.disabledReason) void playUiEvent("ui_button_soft1_play"); });
        b.addEventListener("mouseenter", () => tooltipDue(b, () => showLabelShortcutTooltip(b, a.title, shortcutOf((a.key === "warp" && a.disabledReason ? "" : CMD_BY_ACTION[a.key]) ?? ""), a.disabledReason ? [a.disabledReason] : [], "top", true)));
        b.addEventListener("mouseleave", hideLabelShortcutTooltip);
        b.setAttribute("aria-label", a.title);
        b.disabled = a.disabled ?? false;
        b.innerHTML = `<img src="${a.icon}" alt="">`;
        b.addEventListener("click", () => void this.act(a.title, a.run).then(() => this.refreshTargets()));
        row.appendChild(b);
      }
      this.sizeSelectedButtons();
    }
    body.querySelector(".si-dist")!.textContent = fmtDistance(dist, 1);
  }

  /**
   * SelectedItemWnd.button_size (3698585): 32 px buttons with 32 px icons where the window is at least
   * get_min_button_container_width - max(the buttons x (32 + BUTTON_PADDING 4), BUTTON_CONTAINER_MIN_WIDTH 270) - wide,
   * else 20 px buttons (BUTTON_ICON_SMALL 16 + 4) with the 16 px icons (ICON_BY_ACTIONID resolved at the icon size).
   */
  private sizeSelectedButtons(): void {
    const row = this.selectedWin.body.querySelector<HTMLElement>(".si-actions");
    if (!row) return;
    const width = this.selectedWin.root.getBoundingClientRect().width;
    const small = width < Math.max(row.children.length * (32 + 4), 270);
    if (row.classList.contains("small") === small && row.dataset.sized) return;
    row.dataset.sized = "1";
    row.classList.toggle("small", small);
    for (const img of row.querySelectorAll<HTMLImageElement>(".si-act img")) img.src = img.src.replace(small ? /_32px\.png$/ : /_16px\.png$/, small ? "_16px.png" : "_32px.png");
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
      for (const [id, el] of this.bracketEls) { el.classList.toggle("locked", this.locked.has(id)); el.classList.toggle("targeting-me", this.targeters.has(id)); el.classList.toggle("attacking-me", this.attackers.has(id)); el.classList.toggle("fleet-member", this.isFleetMemberShip(id)); }
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
    // bracketMgr.OnDamageMessage: what each attacker did to the ship, by the second, and its mark blinked
    if (entry.direction === "taken" && entry.otherPartyID !== null && entry.amount > 0) {
      const second = Math.floor(Date.now() / 1000);
      const byTime = this.damageByAttacker.get(entry.otherPartyID) ?? new Map<number, number>();
      byTime.set(second, (byTime.get(second) ?? 0) + Math.trunc(entry.amount));
      this.damageByAttacker.set(entry.otherPartyID, byTime);
      if (this.biggestDamageDealers.includes(entry.otherPartyID)) {
        const hit = this.bracketEls.get(entry.otherPartyID)?.querySelector<HTMLElement>(".t-hit");
        const base = Number(hit?.dataset.base ?? 0);
        hit?.animate([{ opacity: base + 0.05 }, { opacity: base }], { duration: 750 });
      }
    }
    // TargetInBar.OnDamageMessage: our hit on a locked target blinks its entry (DoBlink)
    if (entry.direction === "dealt" && entry.otherPartyID !== null && entry.amount > 0) this.targetBar.blinkTarget(entry.otherPartyID);
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
    // CmdAccelerate / CmdDecelerate: the ball's speed fraction a tenth up or down (SetSpeedFractionThrottled, a
    // CallCombiner of 0.3 s: the last asked within it is sent); a stopped ship, with no autopilot, first set going along
    // its own heading (CmdGotoDirection)
    if (cmd === "CmdAccelerate" || cmd === "CmdDecelerate") {
      e.preventDefault();
      const ego = this.snapshot?.ship;
      if (!ego) return;
      const up = cmd === "CmdAccelerate";
      if (up && ego.mode === "STOP" && !this.actions.autopilotOn?.()) {
        const holder = this.marks.get(ego.itemID);
        if (holder) {
          const f = new THREE.Vector3(0, 0, 1).applyQuaternion(holder.quaternion);
          void this.act("Accelerate", () => this.actions.gotoDirection(f.x, f.y, -f.z));
        }
      }
      const fraction = Math.max(0, Math.min(1, (ego.speedFraction ?? 0) + (up ? 0.1 : -0.1)));
      if (this.speedCombiner) clearTimeout(this.speedCombiner);
      this.speedCombiner = setTimeout(() => { this.speedCombiner = null; void this.act("Set speed", () => this.actions.setSpeedFraction(fraction)); }, 300);
      return;
    }
    // CmdToggleTacticalOverlay (Ctrl-D): tactical.ToggleOnOff - the overlay shown or hidden (viewTactical)
    if (cmd === "CmdToggleTacticalOverlay") { e.preventDefault(); setHudSetting("viewTactical", !hudSettingNow("viewTactical")); return; }
    // CmdSetOverviewFocus (Alt-Space): uicore.registry.SetFocus of the overview window where it is open
    if (cmd === "CmdSetOverviewFocus") { e.preventDefault(); if (this.overview.window.root.style.display !== "none") this.overview.window.activate(); return; }
    // CmdPrevTab / CmdNextTab (Ctrl-Page Up / Ctrl-Page Down): _GetTabgroup - the first tab group in the active window
    // (uicore.registry.GetActive) - its SelectPrev / SelectNext, round from the last tab to the first; nothing where no tab
    // of it is selected
    if (cmd === "CmdPrevTab" || cmd === "CmdNextTab") {
      const wnd = document.querySelector<HTMLElement>(".pw.pw-active, .fly-windows .win.focused");
      const first = wnd?.querySelector<HTMLElement>(".ov-tab, [role=tab]");
      const tabs = first?.parentElement ? [...first.parentElement.children].filter((t): t is HTMLElement => t instanceof HTMLElement && (t.matches(".ov-tab, [role=tab]")) && t.offsetParent !== null) : [];
      const at = tabs.findIndex((t) => t.classList.contains("active") || t.getAttribute("aria-selected") === "true");
      if (at < 0) return;
      e.preventDefault();
      tabs[(at + (cmd === "CmdNextTab" ? 1 : tabs.length - 1)) % tabs.length]!.click();
      return;
    }
    // CmdToggleSensorOverlay (Ctrl-O): sensorSuite.ToggleOverlay - the overlay shown or hidden (ui_scanner_stop)
    if (cmd === "CmdToggleSensorOverlay") {
      e.preventDefault();
      try { localStorage.setItem(SENSOR_OVERLAY_KEY, String(!this.sensorOverlayOn())); } catch { /* lasts the page */ }
      void playUiEvent("ui_scanner_stop");
      return;
    }
    // CmdUnlockTargetItems: targetMgr.UnlockTargets - every locked target unlocked
    if (cmd === "CmdUnlockTargetItems") {
      e.preventDefault();
      for (const id of [...this.locked]) void this.act("Unlock Target", () => this.actions.unlock(id)).then(() => this.refreshTargets());
      return;
    }
    // CmdCreateBookmark: addressbook.BookmarkCurrentLocation - in space the pilot's ship's spot (BookmarkLocationPopup on
    // the ship: its default name SpotInSolarSystem)
    if (cmd === "CmdCreateBookmark") {
      e.preventDefault();
      const ego = this.snapshot?.ship;
      if (ego) this.actions.saveLocation?.(ego.itemID, ego.typeID ?? null);
      return;
    }
    const RACKS = { High: "high", Medium: "mid", Low: "low" } as const;
    const rack = /^CmdOverload(High|Medium|Low)PowerRack$/.exec(cmd);
    if (rack) {
      e.preventDefault();
      if (!this.shipHud.toggleRackOverload(({ High: "Hi", Medium: "Med", Low: "Lo" } as const)[rack[1] as "High" | "Medium" | "Low"])) this.sayDisabled();
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
    // ModuleTray.ActivateAtPosition: an empty place is Disabled; in overload mode, so is a module with no overload effect;
    // otherwise the slot's PrimaryActivate (an offline module says ClickOffllineModule there, a winding-down one flashes)
    if (!m) { this.sayDisabled(); return; }
    if (slot[1] === "Activate") {
      if (e.repeat) return;
      const hud = this.shipHud instanceof NewShipHud ? this.shipHud : null;
      if (hud?.overloadModeOn && m.overloadable === false) { this.sayDisabled(); return; }
      if (hud?.refuseIfUnavailable(m.itemID)) return;
      this.useRackModule(m);
      return;
    }
    // ToggleOverloadAtPosition: Disabled for an empty place or a module with no overload effect
    const overload = this.options.rack?.overload;
    if (!overload || m.overloadable === false) { this.sayDisabled(); return; }
    // ModuleController.ToggleOverload -> SetOverload: SOUND_MODULE_OVERLOAD on, SOUND_MODULE_OVERLOAD_STOP off
    void playUiEvent(m.overloaded ? "hud_module_overload_stop" : "hud_module_overload_play");
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
    // LoadLightCombatCommand (CmdGetLocationMenuForNavigation): held with no indication
    if (cmd === "CmdGetLocationMenuForNavigation") return;
    // LoadCombatCommand: sm.ScatterEvent('OnFreezeOverviewWindows') - every overview's order held while the key is down
    for (const o of [this.overview, ...this.extraOverviews]) o.setFrozen(true);
    const label = labelOf(cmd);
    const name = (label ? this.actions.word?.(label) : null) ?? cmd;
    const click = this.actions.word?.("UI/Commands/ClickTarget") ?? "";
    this.temporaryIndication = null;
    this.shortcutIndication = { header: name, sub: click };
  }

  private unloadCombat(): void {
    // _CmdApproacItemUnloadCallback: the move command dropped unless its first point is set
    if (this.moveCmd && this.moveCmd.state === 0) this.abortMoveCommand();
    // _UnloadCombatCommand: sm.ScatterEvent('OnUnfreezeOverviewWindows')
    if (this.combat) for (const o of [this.overview, ...this.extraOverviews]) o.setFrozen(false);
    this.combat = null;
    this.shortcutIndication = null;
  }

  /**
   * PositionalControl.StartMoveCommand (navigation.CheckStartMoveCommand: CmdApproachItem held, the pointer over space,
   * no button down): a controlPaths.SinglePointPath from the ship - first the point on the ship's plane under the
   * pointer (PICK_XZ: the pick ray met with the plane; behind the camera or beyond _MAX_PICK_DISTANCE 4,000 km, that
   * far along its direction), a click fixing it; then its height (PICK_Y: the ray met with the upright plane through
   * that direction, the length kept), a second click finishing it (_MoveSelected: GoToPoint); each click
   * msg_ComboEntryEnter_play. Drawn in COLOR_MOVE (0, 0.678, 0.933): the path (STYLE_STRONG 0.5), the range circle
   * through the point (STRONG), the dotted line along the plane and the dotted arc down to it, the faint (0.1) upright
   * line, the distance in km at the middle (ALPHA_SOLID, 20 px).
   */
  private moveCmd: { state: 0 | 1; planar: THREE.Vector3; dest: THREE.Vector3; group: THREE.LineSegments; label: HTMLElement } | null = null;
  private movePointer: { x: number; y: number } | null = null;
  /** When the last move command was given (its PendingMoveIndication lasts 3 s). */
  private pendingMoveAt = -Infinity;

  private startMoveCommand(): void {
    if (this.moveCmd || !this.snapshot?.ship) return;
    const group = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, depthTest: false }));
    group.frustumCulled = false;
    group.renderOrder = 6;
    this.scene.add(group);
    const label = document.createElement("span");
    label.className = "move-command-label";
    this.brackets.append(label);
    this.moveCmd = { state: 0, planar: new THREE.Vector3(), dest: new THREE.Vector3(), group, label };
  }

  private abortMoveCommand(): void {
    if (!this.moveCmd) return;
    this.scene.remove(this.moveCmd.group);
    this.moveCmd.group.geometry.dispose();
    this.moveCmd.label.remove();
    this.moveCmd = null;
  }

  /** PositionalControl.AddPoint: the next point fixed; with the second, the ship sent there. */
  private addMovePoint(): void {
    const m = this.moveCmd;
    if (!m) return;
    void playUiEvent("msg_ComboEntryEnter_play");
    if (m.state === 0) { m.state = 1; return; }
    const ship = this.snapshot?.ship;
    const d = m.dest.clone();
    this.abortMoveCommand();
    if (!ship) return;
    // _ConvertPositionToGlobalSpace: the point plus the ship's place
    const at: [number, number, number] = [ship.position.x + d.x, ship.position.y + d.y, ship.position.z - d.z];
    // tacticalNavigation.IndicateMoveCommand: the pending move shown for 3 s (PendingMoveIndication._DelayedDestroy)
    this.pendingMoveAt = performance.now();
    void this.act("Move", () => this.actions.goToPoint?.(at) ?? Promise.resolve());
  }

  private drawMoveCommand(w: number, h: number): void {
    const m = this.moveCmd;
    if (!m) return;
    if (!this.snapshot?.ship) { this.abortMoveCommand(); return; }
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (this.movePointer && rect.width > 0) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((this.movePointer.x - rect.left) / rect.width) * 2 - 1, -(((this.movePointer.y - rect.top) / rect.height) * 2 - 1)), this.camera);
      const start = ray.ray.origin, dir = ray.ray.direction;
      const MAX = 4_000_000;
      if (m.state === 0 && dir.y !== 0) {
        const t = start.y / -dir.y;
        let pick = start.clone().addScaledVector(dir, t);
        if (t < 0) pick = pick.clone().negate().normalize().multiplyScalar(MAX);
        if (pick.length() > MAX) pick.setLength(MAX);
        m.planar.copy(pick);
        m.dest.copy(pick);
      } else if (m.state === 1) {
        const len = m.planar.length();
        const xz = m.planar.clone().normalize();
        const normal = new THREE.Vector3().crossVectors(xz, new THREE.Vector3(0, 1, 0)).normalize();
        const denom = normal.dot(dir);
        if (Math.abs(denom) > 1e-9 && len > 0) {
          const t = -normal.dot(start) / denom;
          const p = start.clone().addScaledVector(dir, t);
          if (p.lengthSq() > 0) m.dest.copy(p.normalize().multiplyScalar(t < 0 ? -len : len));
        }
      }
    }
    const pts: number[] = [], cols: number[] = [];
    const C = [0, 0.678, 0.933];
    const seg = (a: THREE.Vector3, b: THREE.Vector3, alpha: number) => { pts.push(a.x, a.y, a.z, b.x, b.y, b.z); cols.push(C[0]!, C[1]!, C[2]!, alpha, C[0]!, C[1]!, C[2]!, alpha); };
    const dotted = (a: THREE.Vector3, b: THREE.Vector3) => {
      const n = Math.max(2, Math.min(200, Math.round(a.distanceTo(b) / Math.max(1, b.length() * 0.02))));
      for (let i = 0; i < n; i += 2) seg(a.clone().lerp(b, i / n), a.clone().lerp(b, Math.min(1, (i + 1) / n)), 1);
    };
    const o = new THREE.Vector3();
    const r = m.dest.length();
    // the path, STYLE_STRONG
    seg(o, m.dest, 0.5);
    // the range circle (LINE_CONNECTOR_RANGE_SPHERE) through the point, in the plane
    for (let i = 0; i < 96; i++) {
      const a0 = (i / 96) * Math.PI * 2, a1 = ((i + 1) / 96) * Math.PI * 2;
      seg(new THREE.Vector3(Math.cos(a0) * r, 0, Math.sin(a0) * r), new THREE.Vector3(Math.cos(a1) * r, 0, Math.sin(a1) * r), 0.5);
    }
    // XZPlaneRotationFunction: the point turned down into the plane, its distance kept
    const flat = new THREE.Vector3(m.dest.x, 0, m.dest.z);
    if (flat.lengthSq() === 0) flat.set(1, 0, 0);
    flat.setLength(r);
    dotted(o, flat);
    // the upright line (STYLE_FAINT) from the point in the plane to the destination
    seg(m.planar, m.dest, 0.1);
    // the dotted arc (LINE_CONNECTOR_ANCHOR_SPHERE) from the destination down to the plane
    const from = m.dest.clone().normalize(), to = flat.clone().normalize();
    const steps = Math.max(2, Math.ceil(from.angleTo(to) / 0.05));
    for (let i = 0; i < steps; i += 2) {
      const p0 = from.clone().lerp(to, i / steps).normalize().multiplyScalar(r);
      const p1 = from.clone().lerp(to, Math.min(1, (i + 1) / steps)).normalize().multiplyScalar(r);
      seg(p0, p1, 1);
    }
    m.group.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    m.group.geometry.setAttribute("color", new THREE.Float32BufferAttribute(cols, 4));
    m.group.geometry.computeBoundingSphere();
    // _UpdateDistanceText: int(distance / 1000 + 0.5) at the middle of the path
    m.label.textContent = String(Math.max(0, Math.floor(r / 1000 + 0.5)));
    const v = m.dest.clone().multiplyScalar(0.5).project(this.camera);
    const shown = v.z < 1;
    m.label.style.display = shown ? "" : "none";
    if (shown) m.label.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
  }

  /** The loaded command's function on the object clicked (movementFunctions / the menu's, as the page has them). */
  private runCombat(cmd: CombatCommand, id: number): void {
    // ExecuteCombatCommand: combatCmdCurrentHasExecuted; ExecuteActiveCombatCommand: ui_radial_select_play (not for
    // CmdSelectTargetItem, which never comes here)
    if (this.combat) this.combat.executed = true;
    void playUiEvent("ui_radial_select_play");
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
      // CmdOpenSelectedCargoContainer: menusvc.OpenCargo on the thing clicked
      case "CmdOpenSelectedCargoContainer": run("Open Cargo", () => this.actions.openCargo?.(id) ?? Promise.resolve()); break;
      // CmdGetLocationMenuForNavigation is a right-click's (navigation.GetMenu); a left click does nothing with it
      case "CmdGetLocationMenuForNavigation": break;
      // CmdOpenRadialMenu is the press's (holdToOpen); the click after it does nothing more
      case "CmdOpenRadialMenu": break;
      // targetMgr.ToggleLockTarget: unlocked where it is a target, else locked
      case "CmdToggleTargetItem": if (this.locked.has(id)) run("Unlock Target", () => this.actions.unlock(id)); else run("Lock Target", () => this.lockTracked(id)); break;
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
      // CmdSendBroadcast_Target (X): fleetSvc.SendBroadcast_Target - SendBubbleBroadcast('Target') on the thing clicked
      case "CmdSendBroadcast_Target": this.actions.broadcastOnItem?.("Target", id, e?.typeID ?? null); break;
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
  /** The object the open radial menu marks (RadialMenu.clickedObject's radial menu indicator). */
  private radialMarked: { id: number; from: Exclude<RadialFrom, null> } | null = null;

  private markRadial(mark: { id: number; from: Exclude<RadialFrom, null> } | null): void {
    const old = this.radialMarked;
    if (old?.from === "bracket") this.bracketEls.get(old.id)?.classList.remove("radial-marked");
    else if (old?.from instanceof HTMLElement) old.from.classList.remove("radial-marked-entry");
    else if (old) old.from.setRadialMarked(null);
    this.radialMarked = mark;
    // InSpaceBracket.ShowRadialMenuIndicator: radialMenuSprite, bracketHilite.png 20 x 20 centred under the icon, (0.5, 0.5,
    // 0.5, 0.5); OverviewScrollEntry's: a FillThemeColored COLORTYPE_UIHILIGHT behind the entry
    if (mark?.from === "bracket") this.bracketEls.get(mark.id)?.classList.add("radial-marked");
    // a window list entry (Generic / BaseListEntry, the drones window's DroneEntry): a Fill (1, 1, 1, 0.25) behind it
    else if (mark?.from instanceof HTMLElement) mark.from.classList.add("radial-marked-entry");
    else if (mark) mark.from.setRadialMarked(mark.id);
  }

  private openRadial(id: number, x: number, y: number, button: number, from: RadialFrom = null): void {
    const e = this.snapshot?.entities.find((each) => each.itemID === id) ?? null;
    if (!e) return;
    this.select(e.isSelf ? this.selected : id);
    const icon = (n: number) => RADIAL_ICON(`res:/UI/Texture/Icons/44_32_${n}.png`);
    const run = (title: string, fn: () => Promise<void>) => () => void this.act(title, fn).then(() => this.refreshTargets());
    const showInfo: RadialOption = this.options.showInfo
      ? { label: this.actions.word?.("UI/Commands/ShowInfo") ?? "Show Info", icon: icon(24), run: () => this.options.showInfo!(id, e.typeID ?? null) }
      : { label: this.actions.word?.("UI/Commands/ShowInfo") ?? "Show Info", icon: icon(24), disabled: true };
    const say = (label: string, own: string) => this.actions.word?.(label) ?? own;
    // lookAtOption: Look At (44_32_20), or Reset Camera (resetCamera.png) on the object looked at
    // (the own ship: LookAtObject never offered, ResetCamera in its place)
    const lookAt: RadialOption = this.lookAt === id || e.isSelf
      ? { label: say("UI/Inflight/ResetCamera", "Look At My Ship"), icon: RADIAL_ICON("res:/UI/Texture/classes/RadialMenuActions/resetCamera.png"), run: () => this.focusOn(null) }
      : { label: say("UI/Inflight/LookAtObject", "Look At"), icon: icon(20), run: () => this.focusOn(id) };
    // setInterestOption (44_32_65): the camera tracks it; bookMarkOption (bookmark.png): Save Location
    const setInterest: RadialOption = { label: say("UI/Inflight/SetAsCameraInterest", "Set as Camera Interest"), icon: icon(65), run: () => { this.endExplosionCamera(); this.trackedObjective = id; } };
    const bookmark: RadialOption = { label: say("UI/Inflight/BookmarkLocation", "Save Location..."), icon: RADIAL_ICON("res:/UI/Texture/Icons/bookmark.png"), disabled: !this.actions.saveLocation, run: () => this.actions.saveLocation?.(id, e.typeID ?? null) };
    let options: (RadialOption | null)[];
    if (e.isSelf) {
      options = [
        { label: this.actions.word?.("UI/Inflight/StopMyShip") ?? "Stop Ship", icon: clientTexture("res:/UI/Texture/Icons/44_32_38.png"), run: run("Stop", () => this.actions.stop()) },
        { label: this.actions.word?.("UI/Inflight/SetDefaultOrbitDistanceShort") ?? "Set Default Orbit Distance", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/setOrbitDefault.png"), ranges: radialRanges(500, 100_000), defaultRange: defaultDistance("Orbit"), run: (r) => setDefaultDistance("Orbit", r ?? defaultDistance("Orbit")) },
        // the own ship's second level: secondaryCategoryActions[categoryShip] (Look At, Set Interest) and
        // GetMyShipSpecialCaseSecondLevel - Save Location (menuSvc.Bookmark, alwaysAvailable) in space, not in a structure
        { label: "More", icon: "", more: [lookAt, setInterest, { ...bookmark, disabled: !this.actions.saveLocation }] },
        { label: this.actions.word?.("UI/Inflight/SetDefaultKeepAtRangeDistanceShort") ?? "Set Default Keep at Range Distance", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/setKeepRangeDefault.png"), ranges: radialRanges(50, 100_000), defaultRange: defaultDistance("KeepAtRange"), run: (r) => setDefaultDistance("KeepAtRange", r ?? defaultDistance("KeepAtRange")) },
        { label: this.actions.word?.("UI/Commands/OpenCargoHold") ?? "Open Cargo Hold", icon: icon(35), run: () => this.options.onNeocom?.("inventory") },
        null,
        showInfo,
        { label: this.actions.word?.("UI/Inflight/SetDefaultWarpWithinDistanceShort") ?? "Set Default Warp To Distance", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/setWarpDefault.png"), ranges: WARP_RANGES, defaultRange: defaultDistance("WarpTo"), run: (r) => setDefaultDistance("WarpTo", r ?? defaultDistance("WarpTo")) },
      ];
    } else {
      const dist = this.distanceTo(e);
      const drill = this.autoMoonMinerEntry(e);
      // a drone (spaceRadialMenuFunctions: primaryCategoryActions / primaryGroupActions, secondaryCategoryActions): its
      // order at the top - Mine (44_32_5) for a mining drone, Salvage (44_32_4) a salvage drone, else Engage Target
      // (44_32_11) - and in the more ring Look At, Set Interest, Return and Orbit (44_32_3), Scoop to Cargo Hold, Return to
      // Drone Bay (44_32_1), a gap, Scoop to Drone Bay (scoopDrone.png), each offered as the drone menu offers it
      const droneRadial = (e as Entity & { categoryID?: number | null }).categoryID === 18 || e.kind === "drone" ? this.droneRadial(e, dist, icon, lookAt, setInterest) : null;
      // secondaryCategoryActions: Look At, Save Location and Set as Camera Interest for an asteroid, station, structure,
      // starbase, sovereignty structure, celestial, orbital or deployable; Look At and Set Interest for an entity, ship
      // or fighter
      const category = (e as Entity & { categoryID?: number | null }).categoryID ?? null;
      const placed = category === null ? e.kind !== "ship" && e.kind !== "npc" : [25, 3, 65, 23, 40, 2, 46, 22].includes(category);
      const more: (RadialOption | null)[] = droneRadial ? droneRadial.more : [...(placed ? [lookAt, bookmark, setInterest] : [lookAt, setInterest]), ...this.sovHubEntries(e, dist)];
      // secondaryGroupActions[groupMoon]: two empty slots, then Warp to Moon Mining Point (warp_to_mining_point) - offered
      // (CelestialChecker.OfferWarpToMoonMiningPoint) where the moon has a mining point (its beacon, moonMiningPoint
      // authority's 1,000,000,000 + moonID, in the scene), the ship is not warping and the moon is in warp range
      if (!droneRadial && (e.kind === "moon" || (e as Entity & { groupID?: number | null }).groupID === 8)) {
        const beacon = this.snapshot?.entities.some((x) => x.itemID === 1_000_000_000 + id) ?? false;
        const offered = beacon && !!this.actions.warpToMoonMiningPoint && dist >= 150_000 && this.snapshot?.ship?.mode !== "WARP";
        more.push(null, null, offered
          ? { label: this.actions.word?.("UI/Inflight/WarpToMoonMiningPoint", { distance: fmtDistance(defaultDistance("WarpTo")) }) ?? "Warp to Moon Mining Point", icon: RADIAL_ICON("res:/UI/Texture/eveicon/system_icons/warp_to_mining_point_16px.png"), run: run("Warp", () => this.actions.warpToMoonMiningPoint!(id, defaultDistance("WarpTo"))) }
          : null);
      }
      if (drill) more.push({ label: drill.title, icon: drill.icon, run: run(drill.title, drill.run) });
      for (const entry of this.metenoxEntries(e)) more.push({ label: entry.title, icon: entry.icon, run: run(entry.title, entry.run) });
      const wormhole = this.wormholeEntry(e);
      const planet = this.planetViewEntry(e);
      const primary: RadialOption | null = droneRadial ? droneRadial.primary
        : e.kind === "station" || (e.kind === "structure" && e.typeID !== METENOX_TYPE_ID) ? { label: this.actions.word?.("UI/Inflight/DockInStation") ?? "Dock", icon: icon(9), run: run("Dock", () => this.actions.dock(id)) }
        : e.kind === "stargate" ? { label: this.actions.word?.("UI/Inflight/Jump") ?? "Jump", icon: icon(39), run: run("Jump", () => this.actions.jump(id)) }
        : wormhole ? { label: wormhole.title, icon: icon(39), disabled: wormhole.disabled, run: run(wormhole.title, wormhole.run) }
        : planet ? { label: planet.title, icon: planet.icon, run: run(planet.title, planet.run) }
        // spaceRadialMenuFunctions: a wreck's and a can's first action is Open Cargo (44_32_35)
        : (e.kind === "wreck" || e.kind === "container") && this.actions.openCargo
          ? { label: this.actions.word?.("UI/Commands/OpenCargo") ?? "Open Cargo", icon: icon(35), run: run("Open Cargo", () => this.actions.openCargo!(id)) }
        // primaryCategoryActions[categoryAsteroid]: Set Destination - never offered for a rock (FindRadialMenuOptions'
        // filterList), so an inactive option: a disabled slice with its label and setDestination.png (read live, g187)
        : (e as Entity & { categoryID?: number | null }).categoryID === 25 || e.kind === "asteroid" || e.groupID === 8 || e.groupID === 6 || e.kind === "moon" || e.kind === "sun"
          ? { label: this.actions.word?.("UI/Inflight/SetDestination") ?? "Set Destination", icon: RADIAL_ICON("res:/UI/Texture/classes/RadialMenuActions/setDestination.png"), disabled: true }
        // the other inactive first options (the menu offers them not): a ship's Board Ship (44_32_40), a wreck's or a
        // can's Open Cargo (44_32_35), a planet's View in Planet Mode (77_32_34)
        : e.categoryID === 6 || e.kind === "ship"
          ? { label: this.actions.word?.("UI/Inflight/BoardShip") ?? "Board Ship", icon: icon(40), disabled: true }
        : e.kind === "wreck" || e.kind === "container"
          ? { label: this.actions.word?.("UI/Commands/OpenCargo") ?? "Open Cargo", icon: icon(35), disabled: true }
        : e.kind === "planet"
          ? { label: this.actions.word?.("UI/PI/Common/ViewInPlanetMode") ?? "View in Planet Mode", icon: RADIAL_ICON("res:/UI/Texture/Icons/77_32_34.png"), disabled: true }
        : null;
      const lockable = ["ship", "drone", "fighter", "wreck", "container", "asteroid", "structure", "station", "stargate"].includes(e.kind);
      const lock: RadialOption = this.locked.has(id)
        ? { label: this.actions.word?.("UI/Inflight/UnlockTarget") ?? "Unlock Target", icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/untarget.png"), run: run("Unlock Target", () => this.actions.unlock(id)) }
        // OfferLockTarget: also IsWithinTargettingRange - nearer than the ship's maxTargetRange (attribute 76)
        : { label: this.actions.word?.("UI/Inflight/LockTarget") ?? "Lock Target", icon: icon(17), disabled: !lockable || dist >= (this.actions.shipAttribute?.(76) ?? Infinity), run: run("Lock Target", () => this.lockTracked(id)) };
      options = [
        primary,
        { label: this.actions.word?.("UI/Inflight/OrbitObject") ?? "Orbit", icon: icon(21), ranges: radialRanges(500, 30000), defaultRange: 1000, run: (r) => run("Orbit", () => this.actions.orbit(id, r))() },
        { label: "More", icon: "", more },
        { label: this.actions.word?.("UI/Inflight/Submenus/KeepAtRange") ?? "Keep at Range", icon: icon(22), ranges: radialRanges(500, 30000), defaultRange: 1000, run: (r) => run("Keep at Range", () => this.actions.keepAtRange(id, r))() },
        lock,
        // GetApproachOption: option1 Align To (44_32_59) where the menu offers it - in warp range - else Approach (44_32_23)
        dist >= 150_000
          ? { label: this.actions.word?.("UI/Inflight/AlignTo") ?? "Align to", icon: icon(59), run: run("Align", () => this.actions.alignTo(id)) }
          : { label: this.actions.word?.("UI/Inflight/ApproachObject") ?? "Approach", icon: icon(23), run: run("Approach", () => this.actions.approach(id)) },
        showInfo,
        // A warp needs the object 150 km away or more (the server refuses a nearer one).
        { label: this.actions.word?.("UI/Inflight/Submenus/WarpToWithin") ?? "Warp to Within", icon: icon(18), ranges: WARP_RANGES, defaultRange: 0, disabled: dist < 150_000, run: (r) => run("Warp To", () => this.actions.warpTo(id, r))() },
      ];
    }
    this.markRadial(null);
    // RadialMenu._OnClose: the clicked object's HideRadialMenuIndicator
    this.radial.open(x, y, this.nameOf(e), options, button, () => this.markRadial(null));
    if (from) this.markRadial({ id, from });
  }

  /** A Sov Hub's entries (typeInfrastructureHub 32458): Deposit Reagents within transfer range, the config window for its owner's station manager. */
  /** The radial's drone entries (see openRadial), offered as menusvc._DroneMenu's DroneChecker offers them. */
  private droneRadial(e: Entity, dist: number, icon: (n: number) => string, lookAt: RadialOption, setInterest: RadialOption): { primary: RadialOption; more: (RadialOption | null)[] } {
    const id = e.itemID;
    const ship = this.snapshot?.ship ?? null;
    const ego = this.snapshot?.entities.find((x) => x.isSelf) ?? null;
    const me = (ego as (Entity & { characterID?: number | null }) | null)?.characterID ?? ego?.ownerID ?? null;
    const d = e as Entity & { controllerID?: number | null; droneActivity?: string | null };
    const owned = me !== null && e.ownerID === me;
    const hasState = d.droneActivity !== undefined && d.droneActivity !== null;
    const controlled = hasState && ship !== null && d.controllerID === ship.itemID;
    const group = e.groupID ?? null;
    const mining = group === 101, salvage = group === 1159;
    const order = (kind: "primary" | "orbit" | "bay" | "scoop") => () => this.actions.droneOrder?.(kind, [id]);
    const can = !!this.actions.droneOrder;
    const word = (label: string, own: string) => this.actions.word?.(label) ?? own;
    const primary: RadialOption = mining ? { label: word("UI/Drones/MineWithDrone", "Mine"), icon: icon(5), disabled: !(can && controlled), run: order("primary") }
      : salvage ? { label: word("UI/Drones/Salvage", "Salvage"), icon: icon(4), disabled: !(can && controlled), run: order("primary") }
      : { label: word("UI/Drones/EngageTarget", "Engage Target"), icon: icon(11), disabled: !(can && controlled), run: order("primary") };
    const more: (RadialOption | null)[] = [
      // secondaryCategoryActions[categoryDrone]: lookAtOption, setInterestOption (SetAsCameraInterest, 44_32_65), then the
      // drone's own
      lookAt,
      setInterest,
      { label: word("UI/Drones/ReturnDroneAndOrbit", "Return and Orbit"), icon: icon(3), disabled: !(can && controlled && owned), run: order("orbit") },
      { label: word("UI/Inflight/ScoopToCargoHold", "Scoop to Cargo Hold"), icon: clientTexture("res:/UI/Texture/Icons/scoopcargo.png"), disabled: true },
      { label: word("UI/Drones/ReturnDroneToBay", "Return to Drone Bay"), icon: icon(1), disabled: !(can && hasState && owned), run: order("bay") },
      null,
      { label: word("UI/Drones/ScoopDroneToBay", "Scoop to Drone Bay"), icon: clientTexture("res:/UI/Texture/classes/RadialMenuActions/scoopDrone.png"), disabled: !(can && !(owned && hasState) && dist <= 150_000), run: order("scoop") },
    ];
    return { primary, more };
  }

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

  /**
   * navigation.GetMenu with nothing under the pointer: Look At My Ship (UI/Inflight/ResetCamera), a line, Show Solar
   * System in Map Browser, a line, then the surroundings (navigation.GetSpaceMenu's ListSurroundingsBtn.GetMenu,
   * groupByType): Show Info on the system, then Asteroid Belts, Planets, Stargates, Stations and Structures (each
   * group with things, by its name; Structures split by group past ten), each thing (ExpandTypeMenu: by its
   * celestial and orbit index, then name) warping to it on a click (WarpToItem) with its CelestialMenu under it.
   */
  openSpaceMenu(x: number, y: number): void {
    const word = (label: string, own: string, args?: Readonly<Record<string, string | number>>) => this.actions.word?.(label, args) ?? own;
    const systemID = this.seenSystem;
    const things = this.snapshot?.entities.filter((e) => !e.isSelf) ?? [];
    const iconOf = (e: Entity) => { const p = bracketIcon(e); return p ? p.replace(/^\/client-res\//, "res:/") : null; };
    const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
    const roman = (s: string) => { let n = 0; for (let i = 0; i < s.length; i++) { const v = ROMAN[s[i]!]!, nx = ROMAN[s[i + 1]!] ?? 0; n += v < nx ? -v : v; } return n; };
    // GetSolarsystemItems' celestialIndex and orbitIndex, as the names carry them ("<system> VIII - Asteroid Belt 1")
    const indices = (name: string): [number, number] => {
      const m = /\s([IVXLC]+)(?:\s|$)/.exec(name);
      const o = /(?:Moon|Asteroid Belt)\s+(\d+)/.exec(name);
      return [m ? roman(m[1]!) : 0, o ? Number(o[1]) : 0];
    };
    const PLANET_TYPES: Record<number, [string, string]> = { 2016: ["UI/PI/PlanetType/Barren", "Barren"], 2017: ["UI/PI/PlanetType/Storm", "Storm"], 2015: ["UI/PI/PlanetType/Lava", "Lava"],
      73911: ["UI/PI/PlanetType/Scorched", "Scorched"], 30889: ["UI/PI/PlanetType/Shattered", "Shattered"], 11: ["UI/PI/PlanetType/Temperate", "Temperate"], 12: ["UI/PI/PlanetType/Ice", "Ice"],
      13: ["UI/PI/PlanetType/Gas", "Gas"], 2014: ["UI/PI/PlanetType/Oceanic", "Oceanic"], 2063: ["UI/PI/PlanetType/Plasma", "Plasma"] };
    // _GetEntryName: a planet "<name> (<its type>)", a gate its name and the security of the system it jumps to
    const entryName = (e: Entity): string => {
      const name = this.nameOf(e);
      if (e.groupID === 7) { const t = PLANET_TYPES[e.typeID ?? 0]; return t ? `${name} (${word(t[0], t[1])})` : name; }
      // uix.EditStationName(name, 1): the moon's long form (LocationMoonLong and a space) as its short (LocationMoonShort)
      if (e.groupID === 15) {
        const long = word("UI/Locations/LocationMoonLong", "Moon") + " ", short = word("UI/Locations/LocationMoonShort", "M");
        return name.split(long).join(short).split(long.toLowerCase()).join(short.toLowerCase());
      }
      return name;
    };
    // _GetEntryName's colours: the home station (home_station.is_home_station) in CRYO_BLUE; a gate the security of the
    // system it jumps to in its class's colour (solar_system_security_status)
    const homeStation = this.actions.homeStationID?.() ?? null;
    const colourOf = (e: Entity): Pick<ContextEntry, "color" | "suffix"> => {
      if (e.groupID === 15 && e.itemID === homeStation) return { color: "#58A7BF" };
      if (e.groupID === 10) {
        const to = (e as Entity & { jumpSystemID?: number | null }).jumpSystemID ?? null;
        const sec = to === null ? null : this.options.systemSecurity?.(to) ?? null;
        if (sec !== null) return { suffix: { text: shownSecurity(sec).toFixed(1), color: securityStatusColor(shownSecurity(sec)) } };
      }
      return {};
    };
    const typeMenu = (list: readonly Entity[]): ContextEntry[] => list
      .map((e) => ({ e, name: entryName(e), at: indices(this.nameOf(e)) }))
      .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .map(({ e, name }) => ({ label: name, ...colourOf(e), icon: e.categoryID === 65 ? iconOf(e) : null, run: () => void this.act("Warp To", () => this.actions.warpTo(e.itemID)), sub: this.contextEntries(e) }));
    const GROUPS: [number, string, string][] = [[9, "UI/Common/LocationTypes/AsteroidBelts", "Asteroid Belts"], [7, "UI/Common/LocationTypes/Planets", "Planets"],
      [10, "UI/Common/LocationTypes/Stargates", "Stargates"], [15, "UI/Common/LocationTypes/Stations", "Stations"]];
    const groups: { label: string; list: Entity[]; split: boolean }[] = GROUPS.map(([g, l, own]) => ({ label: word(l, own), list: things.filter((e) => e.groupID === g), split: false }));
    const structures = things.filter((e) => e.categoryID === 65);
    const splitStructures = structures.length > 10;
    if (!splitStructures) groups.push({ label: word("UI/Common/LocationTypes/Structures", "Structures"), list: structures, split: false });
    // as the client draws navigation.GetMenu (read through gridcheck: Look At My Ship | Show Info | Show Solar System in
    // Map Browser | Asteroid Belts .. Anomalies | Locations): its menu data's groups put Show Info before the map
    const menu: (ContextEntry | null)[] = [
      { path: "UI/Inflight/ResetCamera", label: word("UI/Inflight/ResetCamera", "Look At My Ship"), run: () => this.focusOn(null) },
      null,
      { path: "UI/Commands/ShowInfo", label: word("UI/Commands/ShowInfo", "Show Info"), info: true, disabled: systemID === null ? "" : null, run: () => { if (systemID !== null) this.options.showInfo?.(systemID, 5); } },
      null,
      { path: "UI/Inflight/ShowSystemInMapBrowser", label: word("UI/Inflight/ShowSystemInMapBrowser", "Show Solar System in Map Browser"), disabled: systemID === null ? "" : null, run: () => { if (systemID !== null) this.options.showSystemOnMap?.(systemID); } },
      null,
    ];
    for (const g of groups.filter((x) => x.list.length).sort((a, b) => a.label.localeCompare(b.label))) {
      menu.push({ label: g.label, icon: iconOf(g.list[0]!), sub: typeMenu(g.list) });
    }
    if (splitStructures) {
      // ExpandCategoryMenu: the structures by their group's name, each group's things under it
      const byGroup = new Map<number, Entity[]>();
      for (const e of structures) byGroup.set(e.groupID ?? 0, [...(byGroup.get(e.groupID ?? 0) ?? []), e]);
      const sub = [...byGroup.values()].map((list) => ({ label: this.options.groupName?.(list[0]!.groupID ?? 0) ?? list[0]!.kind, icon: iconOf(list[0]!), sub: typeMenu(list) }))
        .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
      menu.push({ label: word("UI/Common/LocationTypes/Structures", "Structures"), icon: iconOf(structures[0]!), sub });
    }
    // sensorSuite.GetAnomalies: Anomalies (AnomalySiteFilterLabel), its sites by scan group (_GetAnomaliesMenu)
    const sites = this.actions.anomalies?.() ?? [];
    if (sites.length) menu.push({ label: word("UI/Inflight/Scanner/AnomalySiteFilterLabel", "Anomalies"), icon: "res:/UI/Texture/Shared/Brackets/combatSite_16.png", sub: this.anomaliesMenu(sites) });
    // bookmarkSvc.GetBookmarkMenuForNavigation: Locations, the system's bookmarks, in a group of their own
    menu.push(null, ...(this.actions.locationsMenu?.() ?? []));
    // _GetAgentMissonsMenu: Agent Missions, the journal's mission bookmarks in the system
    menu.push(...(this.actions.missionsMenu?.() ?? []));
    this.radial.close();
    // (no line first, last or twice)
    this.contextMenu.open(x, y, menu.filter((m, i, all) => m !== null || (i > 0 && i < all.length - 1 && all[i - 1] !== null)));
  }

  /**
   * ListSurroundingsBtn._GetAnomaliesMenu: the sites by scan group (their strength attribute, in order), each group a
   * caption (get_exploration_site_name_label) and its sites by dungeon name, each "<dungeon> (<id>)" with its group's
   * icon (ICONS_BY_SCANGROUP), a click warping to it at nought (WarpToAction) and under it GetScanResultMenuWithoutIgnore:
   * Warp to Within (the default distance, and the ranges), Align to, Save Location... (BookmarkLocation).
   */
  private anomaliesMenu(sites: readonly AnomalySite[]): (ContextEntry | null)[] {
    const word = (label: string, own: string, args?: Readonly<Record<string, string | number>>) => this.actions.word?.(label, args) ?? own;
    const GROUP: Record<number, [string, string, string]> = {
      211: ["UI/Inflight/Scanner/OreSite", "Ore Site", "res:/UI/Texture/Shared/Brackets/ore_site_16.png"],
      209: ["UI/Inflight/Scanner/GasSite", "Gas Site", "res:/UI/Texture/Shared/Brackets/harvestableCloud.png"],
      210: ["UI/Inflight/Scanner/RelicSite", "Relic Site", "res:/UI/Texture/Shared/Brackets/relic_site_16.png"],
      208: ["UI/Inflight/Scanner/DataSite", "Data Site", "res:/UI/Texture/Shared/Brackets/data_site_16.png"],
      1908: ["UI/Inflight/Scanner/Wormhole", "Wormhole", "res:/UI/Texture/Shared/Brackets/wormhole.png"],
      1136: ["UI/Inflight/Scanner/CombatSite", "Combat Site", "res:/UI/Texture/Shared/Brackets/combatSite_16.png"],
    };
    const within = (r: number) => word("UI/Inflight/WarpToWithin", `Within ${fmtDistance(r)}`, { distance: fmtDistance(r) });
    const warp = (label: string, r: number) => () => void this.act("Warp", () => this.actions.warpToSite?.(label, r) ?? Promise.resolve());
    const out: (ContextEntry | null)[] = [];
    const byStrength = new Map<number, AnomalySite[]>();
    for (const s of sites) byStrength.set(s.strength, [...(byStrength.get(s.strength) ?? []), s]);
    for (const strength of [...byStrength.keys()].sort((a, b) => a - b)) {
      const g = GROUP[strength];
      out.push({ label: g ? word(g[0], g[1]) : "", caption: true });
      for (const s of byStrength.get(strength)!.sort((a, b) => a.dungeonName.localeCompare(b.dungeonName))) {
        const d = defaultDistance("WarpTo");
        out.push({
          label: `${s.dungeonName} (${s.targetID})`, icon: g?.[2] ?? null, run: warp(s.targetID, 0),
          sub: [
            // movementFunctions.GetDefaultWarpToLabel: WarpToWithinDistance at the default
            { label: word("UI/Inflight/WarpToWithinDistance", `Warp to Within ${fmtDistance(d)}`, { distance: fmtDistance(d) }), icon: "res:/UI/Texture/eveicon/control_icons/warp_to_16px.png", run: warp(s.targetID, d) },
            { path: "UI/Inflight/Submenus/WarpToWithin", label: word("UI/Inflight/Submenus/WarpToWithin", "Warp to Within"), sub: [0, 10000, 20000, 30000, 50000, 70000, 100000].map((r) => ({ label: within(r), run: warp(s.targetID, r) })) },
            { path: "UI/Inflight/AlignTo", label: word("UI/Inflight/AlignTo", "Align to"), icon: "res:/UI/Texture/eveicon/control_icons/align_to_16px.png", run: () => void this.act("Align", () => this.actions.alignToSite?.(s.targetID) ?? Promise.resolve()) },
            null,
            { path: "UI/Inflight/BookmarkLocation", label: word("UI/Inflight/BookmarkLocation", "Save Location..."), disabled: this.actions.bookmarkSite ? null : "", run: () => this.actions.bookmarkSite?.(s.targetID, `${s.targetID} ${s.dungeonName}`) },
          ],
        });
      }
    }
    return out;
  }

  /** overviewMenuUtil.GetToggleEntry: Add <group> to Overview, or Remove <group> from Overview where it is shown. */
  overviewToggleEntry(group: number): ContextEntry {
    const word = (label: string, own: string, args?: Readonly<Record<string, string | number>>) => this.actions.word?.(label, args) ?? own;
    const groupName = this.names?.groups[String(group)]?.[0] ?? "";
    return this.overview.groupShown(group)
      ? { path: "UI/Overview/RemoveGroupFromOverview", label: word("UI/Overview/RemoveGroupFromOverview", `Remove ${groupName} from Overview`, { groupName }), run: () => this.overview.setGroupShown(group, false) }
      : { path: "UI/Overview/AddGroupToOverview", label: word("UI/Overview/AddGroupToOverview", `Add ${groupName} to Overview`, { groupName }), run: () => this.overview.setGroupShown(group, true) };
  }

  /** menusvc.TryLookAt: the camera on the thing (Look at), where the ballpark has it. */
  lookAtItem(itemID: number): void {
    if (this.snapshot?.entities.some((e) => e.itemID === itemID)) this.focusOn(itemID);
  }

  /**
   * sensorSuite's overlay (24.02): the system's anomalies as SensorSuiteBrackets in space at their places - 16 px, the
   * inner diamond (diamond2, 20 px, INNER_ICON_COLOR white 0.5) and the four outer pieces (bracket_anomaly_1..4, 22 px at
   * OUTER_BRACKET_ORIENTATIONS x 11) in SITE_COLOR_ANOMALY (82, 131, 17); over one, the label at 32 px (codeLabel: its
   * id in bold, its distance FmtDist(d, 1) after it; siteName: its dungeon under them); a double click AlignTo, a right
   * click its menu. CmdToggleSensorOverlay (Ctrl-O) shows or hides it (settings.char.ui sensorSuiteEnabled, on by default).
   */
  private drawSensorOverlay(origin: { x: number; y: number; z: number }, w: number, h: number): void {
    const on = this.sensorOverlayOn() && this.snapshot?.ship !== null && this.snapshot?.ship !== undefined;
    // anomalies (AnomalyBracket) and signatures (SignatureBracket: SITE_COLOR_SIGNATURE, bracket_sig_accurate_N once its
    // signal strength is 1 else bracket_sig_inaccurate_N, the two CircleDots spinners at 0.15 turning 60 s and 40 s)
    // and the pilot's bookmarks in the system (BookmarkBracket: Icons/38_16_150, bracket_bookmark_N in SITE_COLOR_BOOKMARK
    // (41, 181, 191); a shared one SharedBookmarkBracket: sharedBookmarkSensorOverlay, bracket_bookmark_corp_N), the
    // label its memo with its note under it, its menu BookmarkMenu, a double click AlignToBookmark
    // and the journal's mission bookmarks (MissionBracket: SensorSuite/missions, bracket_mission_N in SITE_COLOR_MISSION
    // (0, 255, 255), the label the mission's name, its menu the bookmark's)
    type Kind = "anomaly" | "signature" | "bookmark" | "sharedBookmark" | "mission";
    const sites: (AnomalySite & { kind: Kind; accurate?: boolean; code?: string; bookmarkID?: number })[] = on
      ? [...(this.actions.anomalies?.() ?? []).map((a) => ({ ...a, kind: "anomaly" as const })), ...(this.actions.signatures?.() ?? []).map((g) => ({ ...g, kind: "signature" as const })),
        ...(this.actions.bookmarkSites?.() ?? []).map((b) => ({ targetID: `bm:${b.bookmarkID}`, strength: 0, dungeonName: b.note, position: b.position, code: b.memo, bookmarkID: b.bookmarkID, kind: (b.shared ? "sharedBookmark" : "bookmark") as Kind })),
        ...(this.frameCount % 60 === 0 ? (this.actions.missionsMenu?.(), []) : []),
        ...(this.actions.missionSites?.() ?? []).map((m) => ({ targetID: m.key, strength: 0, dungeonName: m.name, position: m.position, code: m.name, kind: "mission" as Kind }))]
      : [];
    // the sweep (SWEEP_START_GRACE_TIME_SEC 5, SWEEP_CYCLE_TIME_SEC 8): begun as the entered system's first scannable sites
    // are had (within two minutes of entering: the scanner's read comes after the space's), ui_scanner_start
    const now = performance.now();
    const scannable = (k: Kind) => k === "anomaly" || k === "signature";
    if (this.sweepDue && on && sites.some((s) => scannable(s.kind))) {
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.sweep = { start: now, viewAngle: Math.atan2(d.x, -d.z), delays: new Map(), played: new Set(), ended: false };
      this.sweepDue = null;
      void playUiEvent("ui_scanner_start");
    } else if (this.sweepDue && now - this.sweepDue.at > 120_000) this.sweepDue = null;
    const sweep = this.sweep;
    const ego = this.snapshot?.ship?.position ?? null;
    const seen = new Set<string>();
    for (const s of sites) {
      if (!s.position) continue;
      seen.add(s.targetID);
      let el = this.sensorEls.get(s.targetID);
      if (!el) {
        el = document.createElement("div");
        el.className = "sensor-site";
        const tex = (p: string) => clientTexture(p);
        const corners = [[1, -1], [-1, -1], [-1, 1], [1, 1]].map(([x, y]) =>
          `<span class="ss-outer" style="transform:translate(${x! * 11}px,${y! * 11}px)"></span>`).join("");
        const spinners = s.kind === "signature"
          ? `<img class="ss-spin ss-spin-in" src="${tex("res:/UI/Texture/classes/SensorSuite/CircleDots_Inner.png")}" alt=""><img class="ss-spin ss-spin-out" src="${tex("res:/UI/Texture/classes/SensorSuite/CircleDots_Outer.png")}" alt="">`
          : "";
        const inner = s.kind === "bookmark" ? "res:/UI/Texture/Icons/38_16_150.png" : s.kind === "sharedBookmark" ? "res:/UI/Texture/classes/Bookmarks/sharedBookmarkSensorOverlay.png"
          : s.kind === "mission" ? "res:/UI/Texture/classes/SensorSuite/missions.png" : "res:/UI/Texture/classes/SensorSuite/diamond2.png";
        el.innerHTML = `${spinners}<img class="ss-inner" src="${tex(inner)}" alt="">${corners}<div class="ss-label"><div class="ss-code"><b></b><span></span></div><div class="ss-name"></div></div>`;
        el.classList.add(s.kind);
        const id = s.targetID;
        const hoverSound = s.kind === "signature" ? "ui_scanner_state_signature" : s.kind === "anomaly" ? "ui_scanner_state_anomaly" : null;
        el.dataset.sound = hoverSound ?? "";
        // SensorSuiteBracket.LoadTooltipPanel: PrepareTooltipLoad on it (the overlapping brackets' and sites' tooltip)
        el.addEventListener("mouseenter", () => {
          el!.classList.add("hover");
          if (this.overlapCloseTimer) { clearTimeout(this.overlapCloseTimer); this.overlapCloseTimer = null; }
          if (this.overlapOpenTimer) clearTimeout(this.overlapOpenTimer);
          this.overlapOpenTimer = setTimeout(() => { this.overlapOpenTimer = null; this.openOverlapTooltip(null, el!); }, bracketListDelay());
        });
        el.addEventListener("mouseleave", () => this.overlapLeft());
        el.addEventListener("mouseleave", () => el!.classList.remove("hover"));
        const bookmarkID = s.bookmarkID ?? null;
        el.addEventListener("dblclick", (ev) => {
          ev.stopPropagation();
          // SensorSuiteBracket.OnDblClick: AlignTo - scanSvc.AlignToPosition on the site's place (a bookmark's AlignToBookmark)
          if (s.kind === "mission" && s.position) { const at = s.position; void this.act("Align", () => this.actions.alignToPoint?.(at) ?? Promise.resolve()); return; }
          void this.act("Align", () => (bookmarkID !== null ? this.actions.alignToBookmark?.(bookmarkID) : this.actions.alignToSite?.(id)) ?? Promise.resolve());
        });
        // SensorSuiteBracket.OnMouseDown: TryExpandActionMenu with the site - the radial after the left button is held
        // (150 ms without moving 12 px)
        el.addEventListener("pointerdown", (ev) => {
          if (ev.button !== 0) return;
          ev.stopPropagation();
          const x0 = ev.clientX, y0 = ev.clientY;
          const timer = setTimeout(() => { cleanup(); this.openSiteRadial(el!, x0, y0); }, 150);
          const move = (m: PointerEvent) => { if (Math.hypot(m.clientX - x0, m.clientY - y0) > 12) cleanup(); };
          const cleanup = () => { clearTimeout(timer); removeEventListener("pointermove", move); removeEventListener("pointerup", cleanup); };
          addEventListener("pointermove", move);
          addEventListener("pointerup", cleanup);
        });
        el.addEventListener("contextmenu", (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          if (s.kind === "mission") {
            const menu = this.actions.missionMenu?.(id) ?? [];
            if (menu.length) { this.radial.close(); this.contextMenu.open(ev.clientX, ev.clientY, menu); }
            return;
          }
          if (bookmarkID !== null) {
            this.actions.locationsMenu?.();
            const menu = this.actions.bookmarkMenu?.(bookmarkID) ?? [];
            if (menu.length) { this.radial.close(); this.contextMenu.open(ev.clientX, ev.clientY, menu); }
            return;
          }
          const site = (this.actions.anomalies?.() ?? []).find((x) => x.targetID === id);
          const entry = site ? this.anomaliesMenu([site]).find((x): x is ContextEntry => x !== null && !x.caption) : null;
          if (entry?.sub) { this.radial.close(); this.contextMenu.open(ev.clientX, ev.clientY, entry.sub); }
        });
        this.sensorLayer.append(el);
        this.sensorEls.set(id, el);
      }
      // the outer pieces' textures (the anomaly's four, a signature's accurate or inaccurate four)
      const set = s.kind === "anomaly" ? "bracket_anomaly" : s.kind === "bookmark" ? "bracket_bookmark" : s.kind === "sharedBookmark" ? "bracket_bookmark_corp" : s.kind === "mission" ? "bracket_mission" : s.accurate ? "bracket_sig_accurate" : "bracket_sig_inaccurate";
      if (el.dataset.set !== set) {
        el.dataset.set = set;
        el.querySelectorAll<HTMLElement>(".ss-outer").forEach((o, n) => o.style.setProperty("--tex", `url(${clientTexture(`res:/UI/Texture/classes/SensorSuite/${set}_${n + 1}.png`)})`));
      }
      // during the sweep a scannable site shows at its delay (GetLocationFlashCurve: 0 until then, 1 over
      // locatorFadeInTimeSec 0.25), its result sound then (ui_scanner_result_anomaly / _signature), not pickable till the
      // sweep is done; a personal one (IsSiteInstantlyAccessible) at once
      if (sweep && scannable(s.kind) && ego) {
        let delay = sweep.delays.get(s.targetID);
        if (delay === undefined) {
          const angle = (((Math.atan2(-(s.position[2] - ego.z), s.position[0] - ego.x) - sweep.viewAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          delay = 5 + 8 * (angle / (2 * Math.PI));
          sweep.delays.set(s.targetID, delay);
        }
        const t = (now - sweep.start) / 1000;
        el.style.opacity = String(t < delay ? 0 : Math.min(1, (t - delay) / 0.25));
        el.style.pointerEvents = "none";
        if (t >= delay && !sweep.played.has(s.targetID)) {
          sweep.played.add(s.targetID);
          void playUiEvent(s.kind === "anomaly" ? "ui_scanner_result_anomaly" : "ui_scanner_result_signature");
        }
      } else if (el.style.opacity !== "") { el.style.opacity = ""; el.style.pointerEvents = ""; }
      const rel = new THREE.Vector3(s.position[0] - origin.x, s.position[1] - origin.y, -(s.position[2] - origin.z));
      const p = rel.clone().project(this.camera);
      const onScreen = p.z < 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
      el.style.display = onScreen ? "" : "none";
      if (!onScreen) continue;
      el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`;
      if (el.classList.contains("hover") || this.frameCount % 30 === 0) {
        (el.querySelector(".ss-code b") as HTMLElement).textContent = s.code ?? s.targetID;
        (el.querySelector(".ss-code span") as HTMLElement).textContent = fmtDistance(rel.length(), 1);
        (el.querySelector(".ss-name") as HTMLElement).textContent = s.dungeonName;
      }
    }
    for (const [id, el] of this.sensorEls) if (!seen.has(id)) { el.remove(); this.sensorEls.delete(id); }
    // UpdateMouseTracking: over space, the closest pickable site within MAX_MOUSEOVER_RANGE (40 px) of the pointer with a
    // hover sound (anomalies, signatures) - as it becomes the one, its hoverSoundEvent, ui_scanner_state_difficulty_easy
    // and ui_scanner_mouseover; none left, ui_scanner_mouseover_stop (DisableMouseOverSound)
    const at = this.pointerAt;
    const overSpace = at !== null && at.target instanceof Node && (at.target === this.renderer.domElement || this.brackets.contains(at.target) || this.sensorLayer.contains(at.target));
    let closest: { id: string; d: number; sound: string } | null = null;
    if (overSpace && at) {
      for (const [id, el] of this.sensorEls) {
        if (el.style.display === "none" || el.style.pointerEvents === "none" || !el.dataset.sound) continue;
        const r = el.getBoundingClientRect();
        const dx = r.left + r.width / 2 - at.x, dy = r.top + r.height / 2 - at.y;
        const d = dx * dx + dy * dy;
        if (d < 1600 && (!closest || d < closest.d)) closest = { id, d, sound: el.dataset.sound };
      }
    }
    if (closest && closest.id !== this.sensorSoundSite) {
      this.sensorSoundSite = closest.id;
      void playUiEvent(closest.sound);
      void playUiEvent("ui_scanner_state_difficulty_easy");
      void playUiEvent("ui_scanner_mouseover");
    } else if (!closest && this.sensorSoundSite !== null) {
      this.sensorSoundSite = null;
      void playUiEvent("ui_scanner_mouseover_stop");
    }
    // the sweep's end (grace + cycle): ui_scanner_stop, the brackets pickable again, and a second on DoScanEnded's
    // ui_scanner_result_positive (sites found) or _negative
    if (sweep && !sweep.ended && (now - sweep.start) / 1000 >= 13) {
      sweep.ended = true;
      void playUiEvent("ui_scanner_stop");
      const found = sweep.delays.size > 0;
      setTimeout(() => { void playUiEvent(found ? "ui_scanner_result_positive" : "ui_scanner_result_negative"); }, 1000);
      this.sweep = null;
    }
  }

  /** A site bracket's menu (the entries its right click shows). */
  private siteMenuOf(el: HTMLElement): readonly (ContextEntry | null)[] {
    const id = [...this.sensorEls].find(([, x]) => x === el)?.[0] ?? null;
    if (id === null) return [];
    if (el.classList.contains("mission")) return this.actions.missionMenu?.(id) ?? [];
    if (id.startsWith("bm:")) { this.actions.locationsMenu?.(); return this.actions.bookmarkMenu?.(Number(id.slice(3))) ?? []; }
    const site = (this.actions.anomalies?.() ?? []).find((x) => x.targetID === id);
    return (site ? this.anomaliesMenu([site]).find((x): x is ContextEntry => x !== null && !x.caption)?.sub : null) ?? [];
  }

  /**
   * radialMenu for a site (spaceRadialMenuFunctions.GetObjectsActions with siteData): its site actions on top (a station
   * bookmark's Dock, GetBookmarkSiteActions), then GetGeneralActions - Orbit, the second level, Keep at Range, Lock
   * Target, Align to / Approach Location, Show Info, Warp to Within with its ranges - each available only where the
   * site's menu (siteData.GetMenu) has it; its name the site's (fallBackDisplayName)
   */
  private openSiteRadial(el: HTMLElement, x: number, y: number): void {
    const menu = this.siteMenuOf(el).filter((e): e is ContextEntry => e !== null);
    const byPath = (p: string) => menu.find((e) => e.path === p) ?? null;
    const icon = (n: number) => RADIAL_ICON(`res:/UI/Texture/Icons/44_32_${n}.png`);
    const dock = byPath("UI/Inflight/DockInStation");
    const align = byPath("UI/Inflight/AlignTo") ?? byPath("UI/Inflight/ApproachLocationActionGroup");
    const info = byPath("UI/Commands/ShowInfo");
    const warp = byPath("UI/Inflight/Submenus/WarpToWithin");
    const warpRanges = [0, 10_000, 20_000, 30_000, 50_000, 70_000, 100_000];
    const options: (RadialOption | null)[] = [
      dock ? { label: dock.label, icon: icon(9), run: () => dock.run?.() } : null,
      { label: "Orbit", icon: icon(21), disabled: true },
      null,
      { label: "Keep at Range", icon: icon(22), disabled: true },
      { label: "Lock Target", icon: icon(17), disabled: true },
      align ? { label: align.label, icon: icon(23), run: () => align.run?.() } : { label: "Align to", icon: icon(23), disabled: true },
      info ? { label: info.label, icon: icon(24), run: () => info.run?.() } : { label: "Show Info", icon: icon(24), disabled: true },
      warp ? { label: warp.label, icon: icon(18), ranges: WARP_RANGES, defaultRange: 0, run: (r) => {
        const at = warpRanges.indexOf(r ?? 0);
        const pick = at >= 0 ? warp.sub?.filter((x): x is ContextEntry => x !== null)[at] : null;
        (pick ?? warp).run?.();
      } } : { label: "Warp To Within", icon: icon(18), disabled: true },
    ];
    const name = el.querySelector(".ss-code b")?.textContent || el.querySelector(".ss-name")?.textContent || "";
    this.contextMenu.close();
    this.radial.open(x, y, name, options, 0);
  }

  /**
   * The tactical overlay (tactical.ShowTacticalOverlay, settings.user.overview viewTactical, off by default):
   * tacticalCompass.CompassDisc about the ship in the plane - the range circles at _RANGES km beyond the ship's radius
   * (_GetActualDistanceFromKilometers) up to the first past the active range (the ship's targeting range, else 200 km),
   * _MAJOR_RANGES at white 0.33, the rest 0.125, each faded by 0.75 ((R - r) / R)^0.4 + 0.25; the sixteen straight lines
   * (each quarter: strong 0.05 - the second, north, (0.9, 0.6, 0.2, 0.25) - faint 0.015, medium 0.025, faint) from
   * _LINE_FADE_IN_START 2 km in from nothing to _LINE_FADE_IN_END 5 km, then out to R; the targeting range circle
   * (_COLOR_TARGETING_LINE (1, 0.1, 0.025, 0.5)); each circle's km at the four points (_COLOR_LABEL white 0.5).
   * And its connectors (EveTacticalOverlay.UpdateVisibility): each thing the overlay wants (its bracket shown) within
   * the active range and its fade, an arc on the sphere about the ship from it to the plane at its distance, and its
   * anchor; an aggressor's in the attack colour. The hovered module's firing range (tactical.ShowModuleRange).
   */
  private drawTactical(w: number, h: number): void {
    const on = hudSettingNow("viewTactical") && this.snapshot?.ship !== null && this.snapshot?.ship !== undefined;
    if (!on) {
      if (this.tactical) { this.scene.remove(this.tactical.group); this.tactical.labels.remove(); this.tactical = null; }
      return;
    }
    const base = this.snapshot!.ship!.radius ?? 0;
    const targeting = this.actions.shipAttribute?.(76) ?? 0;
    // TacticalCompass.SetTargetingRange: the active range max(150 km, 1.1 x the targeting range)
    const active = Math.max(150_000, targeting * 1.1);
    const firing = this.firingRange;
    const key = `${Math.round(base)}:${Math.round(active)}:${firing ? firing.map(Math.round).join(",") : ""}`;
    if (!this.tactical || this.tactical.key !== key) {
      if (this.tactical) { this.scene.remove(this.tactical.group); this.tactical.labels.remove(); }
      const RANGES = [5, 10, 20, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];
      const MAJOR = [50, 100, 250, 500, 1000];
      const km = (r: number) => r * 1000 + base;
      let R = km(100);
      let maxKm = 100;
      for (const r of RANGES) { R = km(r); maxKm = r; if (R > active + base) break; }
      const group = new THREE.Group();
      group.renderOrder = 5;
      const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
      const circle = (radius: number, rgba: readonly number[]) => {
        const pts: number[] = [], cols: number[] = [];
        for (let i = 0; i <= 128; i++) {
          const a = (i / 128) * Math.PI * 2;
          pts.push(Math.cos(a) * radius, 0, -Math.sin(a) * radius);
          cols.push(rgba[0]!, rgba[1]!, rgba[2]!, rgba[3]!);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 4));
        group.add(new THREE.Line(g, material));
      };
      for (const r of RANGES) {
        const radius = km(r);
        if (radius > R) break;
        const c = MAJOR.includes(r) ? 0.33 : 0.125;
        const a = 0.75 * Math.pow((R - radius) / R, 0.4) + 0.25;
        circle(radius, [1, 1, 1, c * a]);
      }
      const straight = (angle: number, rgba: readonly number[]) => {
        const x = Math.cos(angle), z = -Math.sin(angle);
        const s = 2000 + base, e = 5000 + base;
        const pts = [x * s, 0, z * s, x * e, 0, z * e, x * e, 0, z * e, x * R, 0, z * R];
        const cols = [rgba[0]!, rgba[1]!, rgba[2]!, 0, ...rgba, ...rgba, ...rgba];
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 4));
        group.add(new THREE.LineSegments(g, material));
      };
      const inc = Math.PI / 2, incS = inc / 4;
      for (let i = 0; i < 4; i++) {
        const angle = i * inc;
        straight(angle, i === 1 ? [0.9, 0.6, 0.2, 0.25] : [1, 1, 1, 0.05]);
        straight(angle + incS, [1, 1, 1, 0.015]);
        straight(angle + 2 * incS, [1, 1, 1, 0.025]);
        straight(angle + 3 * incS, [1, 1, 1, 0.015]);
      }
      // gradientcircle.fx on a unit plane in the compass's plane (tacticalDarkDisc.red and tacticalOptimal/FalloffGradient.red):
      // r = 2 |uv - 0.5|; Color0 to Color1 over GradientControls x..y, to Color2 over y..z; FadeControls.w premultiplies;
      // the edge cut beyond FadeControls.z; faded within FadeControls.y of the camera (the scene-depth fade not drawn)
      const gradientDisc = (diameter: number, c0: readonly number[], c1: readonly number[], c2: readonly number[],
        g: readonly number[], f: readonly number[], additive: boolean, order: number) => {
        const v4 = (x: readonly number[]) => new THREE.Vector4(x[0], x[1], x[2], x[3]);
        const m = new THREE.ShaderMaterial({
          uniforms: { c0: { value: v4(c0) }, c1: { value: v4(c1) }, c2: { value: v4(c2) }, g: { value: v4(g) }, f: { value: v4(f) } },
          vertexShader: "varying vec2 vUv; varying float vDepth; void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }",
          fragmentShader: [
            "uniform vec4 c0; uniform vec4 c1; uniform vec4 c2; uniform vec4 g; uniform vec4 f; varying vec2 vUv; varying float vDepth;",
            "void main() {",
            "  float r = 2.0 * length(vUv - 0.5);",
            "  vec4 c = mix(mix(c0, c1, clamp((r - g.x) / (g.y - g.x), 0.0, 1.0)), c2, clamp((r - g.y) / (g.z - g.y), 0.0, 1.0));",
            "  float a = c.a * clamp(vDepth / f.y, 0.0, 1.0);",
            "  vec3 rgb = c.rgb * (f.w * (a - 1.0) + 1.0);",
            "  gl_FragColor = (1.0 - clamp((r - f.z) / (1.0 - f.z), 0.0, 1.0)) * vec4(rgb, a);",
            "}",
          ].join("\n"),
          transparent: true, depthWrite: false, side: THREE.DoubleSide,
          blending: THREE.CustomBlending, blendSrc: additive ? THREE.OneFactor : THREE.SrcAlphaFactor,
          blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
        });
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
        plane.rotation.x = -Math.PI / 2;
        plane.scale.setScalar(diameter);
        plane.renderOrder = order;
        plane.frustumCulled = false;
        group.add(plane);
      };
      // the dark disc: CompassDisc.SetActiveRange scales it to the outer circle's diameter
      gradientDisc(2 * R, [0, 0, 0, 0.1961], [0, 0, 0, 0.1569], [0, 0, 0, 0], [0, 0.5, 1, 0], [1000, 250, 0.999, 0], false, -1);
      if (targeting > 0) circle(targeting + base, [1, 0.1, 0.025, 0.5]);
      // CompassDisc.ShowFiringRange(optimal, falloff + optimal): _COLOR_OPTIMAL (attack 0.66) at the optimal, and
      // _COLOR_FALLOFF (0.33) at optimal + falloff where there is falloff, both beyond the ship's radius
      if (firing) {
        circle(firing[0] + base, [1, 0.1, 0.025, 0.66]);
        if (firing[1] > 0) circle(firing[0] + firing[1] + base, [1, 0.1, 0.025, 0.33]);
        // the optimal and falloff gradients (optimalQuad 2 x optimal, falloffQuad 2 x falloff x 1.1), added
        const RED = [[1, 0, 0, 0], [1, 0, 0, 0.0784], [1, 0, 0, 0], [0.2, 0.4, 1, 0], [1000, 250, 0.999, 1]] as const;
        gradientDisc(2 * (firing[0] + base), RED[0], RED[1], RED[2], RED[3], RED[4], true, 0);
        if (firing[1] > 0) gradientDisc(2 * (firing[0] + firing[1] + base) * 1.1, RED[0], RED[1], RED[2], RED[3], RED[4], true, 0);
      }
      const labels = document.createElement("div");
      labels.className = "tactical-labels";
      const places: { el: HTMLElement; at: THREE.Vector3 }[] = [];
      for (const r of RANGES) {
        if (r > maxKm) break;
        const d = km(r);
        for (const at of [new THREE.Vector3(d, 0, 0), new THREE.Vector3(0, 0, -d), new THREE.Vector3(0, 0, d), new THREE.Vector3(-d, 0, 0)]) {
          const el = document.createElement("span");
          el.textContent = String(r);
          labels.append(el);
          places.push({ el, at });
        }
      }
      this.brackets.append(labels);
      // the connectors: TacticalOverlayConnector.fx's soft white strips, added
      const connectors = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
        vertexShader: "attribute float intensity; varying vec2 vUv; varying float vK; void main() { vUv = uv; vK = intensity; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: "varying vec2 vUv; varying float vK; void main() { float s = clamp(1.0 - 2.0 * abs(vUv.y - 0.5), 0.0, 1.0); gl_FragColor = vec4(vec3(vK * s), 1.0); }",
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      }));
      connectors.frustumCulled = false;
      group.add(connectors);
      // the velocity strips: arrow_tactical.dds (DiffuseMap, u wrapped, v clamped) added
      const arrow = new THREE.TextureLoader().load(clientTexture("res:/UI/inflight/tactical/arrow_tactical.dds"));
      arrow.flipY = false;
      arrow.wrapS = THREE.RepeatWrapping;
      arrow.wrapT = THREE.ClampToEdgeWrapping;
      const velocity = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({
        map: arrow, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      }));
      velocity.frustumCulled = false;
      group.add(velocity);
      // the action display's lines and its navigation point's bracket (NavigationPointBracket: selectioncircle.png, 24 px)
      const action = new THREE.LineSegments(new THREE.BufferGeometry(), material);
      action.frustumCulled = false;
      group.add(action);
      const navBracket = document.createElement("div");
      navBracket.className = "tactical-nav-point";
      const selection = `url(${clientTexture("res:/ui/texture/classes/bracket/selectioncircle.png")}) center / 24px 24px no-repeat`;
      navBracket.style.mask = selection;
      navBracket.style.webkitMask = selection;
      navBracket.style.display = "none";
      labels.append(navBracket);
      // the anchors: anchor.dds, its red channel above the plane and its green below, added
      const anchorMap = new THREE.TextureLoader().load(clientTexture("res:/UI/inflight/tactical/anchor.dds"));
      anchorMap.flipY = false;
      const anchors = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
        uniforms: { map: { value: anchorMap }, diffuse: { value: new THREE.Color(1, 1, 1) } },
        vertexShader: "attribute vec4 tint; varying vec2 vUv; varying vec4 vTint; void main() { vUv = uv; vTint = tint; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader: "uniform sampler2D map; uniform vec3 diffuse; varying vec2 vUv; varying vec4 vTint; void main() { vec4 t = texture2D(map, vUv); gl_FragColor = vec4(mix(t.g, t.r, vTint.a) * vTint.rgb * diffuse, 1.0); }",
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      }));
      anchors.frustumCulled = false;
      group.add(anchors);
      this.scene.add(group);
      this.tactical = { key, group, labels, places, connectors, velocity, action, navBracket, anchors };
    }
    // the connectors, each frame: from the thing (relative to the ship) along the great circle to the plane
    const limit = active + base + Math.max(targeting * 0.25, 50_000);
    const segs: { a: THREE.Vector3; b: THREE.Vector3; ka: number; kb: number }[] = [];
    // the interest range: a hovered module's (SetFiringRange: max(optimal, optimal + falloff)), else the targeting range
    const firingNow = this.firingRange;
    const interest = firingNow ? Math.max(firingNow[0], firingNow[0] + firingNow[1]) : targeting;
    const fadeLength = Math.max(targeting * 0.25, 50_000);
    const vel: { at: THREE.Vector3; v: THREE.Vector3; radius: number; blink: boolean }[] = [];
    const wantedVel = new Map<number, { at: THREE.Vector3; v: THREE.Vector3; radius: number; blink: boolean }>();
    const rates: { at: THREE.Vector3; v: THREE.Vector3; radius: number; blink: boolean; quad: 1 | 2 }[] = [];
    const anchors: { plane: THREE.Vector3; above: boolean; dist: number; radius: number }[] = [];
    // relative to the ship as the brackets are (the scene's origin)
    const origin = this.snapshot?.ship?.position ?? this.lastOrigin;
    for (const e of this.snapshot?.entities ?? []) {
      if (e.isSelf) continue;
      const el = this.bracketEls.get(e.itemID);
      // tactical.WantIt: the things the brackets' preset wants, on the screen or not; and _CheckInterest: any thing in
      // one of _interestStates (targeting, targeted, mouseOver, selected, lookingAt) whatever the preset
      const interesting = this.lockingIDs.has(e.itemID) || this.locked.has(e.itemID) || this.hoveredID === e.itemID ||
        this.selected === e.itemID || this.lookAt === e.itemID;
      if (!interesting && (!el || el.dataset.wanted !== "1")) continue;
      const p = new THREE.Vector3(e.position.x - origin.x, e.position.y - origin.y, -(e.position.z - origin.z));
      const d = p.length();
      if (d > limit || d < 1) continue;
      if (e.categoryID !== 25) wantedVel.set(e.itemID, { at: p, v: new THREE.Vector3(e.velocity.x, e.velocity.y, -e.velocity.z), radius: e.radius, blink: false });
      const flat = new THREE.Vector3(p.x, 0, p.z);
      if (flat.lengthSq() === 0) flat.x = 0.01;
      flat.setLength(d);
      anchors.push({ plane: flat.clone(), above: p.y >= 0, dist: d, radius: e.radius });
      // _aggressorStates (isAggressive): targeting and targeted by me, threatTargetsMe / threatAttackingMe (its target is
      // the ship), and the flags (outlaw, dangerous, at war, bad or horrible standing, militia enemy, allies at war,
      // suspect, criminal, limited engagement, kill right)
      const aggressive = this.locked.has(e.itemID) || this.lockingIDs.has(e.itemID) ||
        (e.targetEntityID != null && e.targetEntityID === this.snapshot?.ship?.itemID) || aggressorFlagHolds(e, e.groupID, this.lastRelations);
      // the connector's intensity (TacticalOverlayConnector.fx): LineParameters x above the plane, y below (0.3, 0.2),
      // faded past the active range (Fadeout), and the interest-reduced (_outsideInterestIntensity 0.35) beyond the
      // interest range from its radius and the ship's; its colour white whatever its aggression (that is velocity quad 1)
      const out = 1 - Math.min(1, Math.max(0, (d - (active + base)) / fadeLength));
      const reduced = interest > 0.0001 && d - e.radius - base > interest ? 1 - 0.35 : 0;
      const k = (p.y >= 0 ? 0.3 : 0.2) * out * (1 - reduced);
      // the thing's other velocity quads: 2 (its distance's change) always, 1 (its approach) where aggressive, blinking
      const ev = new THREE.Vector3(e.velocity.x, e.velocity.y, -e.velocity.z);
      rates.push({ at: p, v: ev, radius: e.radius, blink: false, quad: 2 });
      if (aggressive) rates.push({ at: p, v: ev, radius: e.radius, blink: true, quad: 1 });
      const from = p.clone().normalize(), to = flat.clone().normalize();
      const angle = from.angleTo(to);
      const steps = Math.max(1, Math.ceil(angle / 0.05));
      let prev = p.clone();
      for (let i = 1; i <= steps; i++) {
        const q = new THREE.Vector3().copy(from).lerp(to, i / steps).normalize().multiplyScalar(d);
        segs.push({ a: prev, b: q, ka: k, kb: k });
        prev = q;
      }
      // a thing wider than _minRadiusForRange (150 m): one more segment on the plane from its anchor in by its radius
      // (no nearer than the ship's), 1 to 0.75 of the intensity
      if (e.radius > 150) {
        const inner = flat.clone().setLength(Math.min(d, Math.max(d - Math.floor(e.radius), base)));
        segs.push({ a: flat.clone(), b: inner, ka: k, kb: k * 0.75 });
      }
    }
    const nav = this.drawActionDisplay(origin, 2 * (active + base + Math.max(targeting * 0.25, 50_000)), w, h);
    // RegisterNavBall: the navigation point is one of the overlay's connectors too - its arc down to the plane
    if (nav) {
      const nd = nav.at.length();
      const nf = new THREE.Vector3(nav.at.x, 0, nav.at.z);
      if (nd > 1 && nf.lengthSq() > 0) {
        const out = 1 - Math.min(1, Math.max(0, (nd - (active + base)) / fadeLength));
        const reduced = interest > 0.0001 && nd - base > interest ? 1 - 0.35 : 0;
        const k = (nav.at.y >= 0 ? 0.3 : 0.2) * out * (1 - reduced);
        const from = nav.at.clone().normalize(), to = nf.clone().normalize();
        const steps = Math.max(1, Math.ceil(from.angleTo(to) / 0.05));
        let prev = nav.at.clone();
        for (let i = 1; i <= steps; i++) {
          const q = from.clone().lerp(to, i / steps).normalize().multiplyScalar(nd);
          segs.push({ a: prev, b: q, ka: k, kb: k });
          prev = q;
        }
      }
    }
    // _ShowDirectionTo: the selected thing a straight connector from the ship (STYLE_FAINT: COLOR_GENERIC at ALPHA_LOW 0.1)
    const chosen = this.selected === null ? null : this.snapshot?.entities.find((e) => e.itemID === this.selected && !e.isSelf) ?? null;
    if (chosen) {
      const at = new THREE.Vector3(chosen.position.x - origin.x, chosen.position.y - origin.y, -(chosen.position.z - origin.z));
      segs.push({ a: new THREE.Vector3(), b: at, ka: 0.1, kb: 0.1 });
    }
    this.drawConnectorStrips(segs, h);
    // EveTacticalOverlay's velocity quads (quad 0, TacticalOverlayVelocity.fx with tacticalOverlay.red's parameters):
    // each wanted thing's but an asteroid's (_HIDE_VELOCITY_CATEGORIES), the ship's own, and for the selected thing
    // (_ShowDirectionTo / SetInterest) the ship's velocity at it and its at the ship, both blinking
    const ship = this.snapshot?.ship;
    if (ship) {
      const own = new THREE.Vector3(ship.velocity.x, ship.velocity.y, -ship.velocity.z);
      vel.push({ at: new THREE.Vector3(), v: own, radius: base, blink: false });
      const sel = this.selected === null ? null : wantedVel.get(this.selected) ?? null;
      if (sel) {
        vel.push({ at: sel.at, v: own, radius: sel.radius, blink: true });
        vel.push({ at: new THREE.Vector3(), v: sel.v, radius: base, blink: true });
      }
    }
    for (const x of wantedVel.values()) vel.push(x);
    vel.push(...rates);
    this.drawTacticalVelocity(vel, w, h, ship ? new THREE.Vector3(ship.velocity.x, ship.velocity.y, -ship.velocity.z) : new THREE.Vector3());
    // ActionDisplay.SetMaxMoveRange(TacticalCompass.GetMaxRange()): 2 x (the active range + its fade)
    // a navigation point is a connector of the overlay's too (RegisterNavBall), with its anchor
    if (nav) { const nd = nav.at.length(); const nf = new THREE.Vector3(nav.at.x, 0, nav.at.z); if (nd > 1 && nf.lengthSq() > 0) anchors.push({ plane: nf.setLength(nd), above: nav.at.y >= 0, dist: nd, radius: 0 }); }
    this.drawTacticalAnchors(anchors, active + base, fadeLength, base, interest);
    for (const p of this.tactical.places) {
      const v = p.at.clone().project(this.camera);
      const shown = v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
      p.el.style.display = shown ? "" : "none";
      if (shown) p.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  /**
   * TacticalOverlayVelocity.fx's quad 0 for each velocity: from the thing's surface along its velocity (floor(radius)),
   * as long as its travel in clamp(falloffParams.w |view z|^falloffParams.x, 1, 10) seconds ((0.825, 0.0004, 0.62,
   * 0.0002)); a strip LineParameters.z 14 px wide of arrow_tactical.dds, its head at the tip and its last row along the
   * rest (u across, v from the tip in widths, v clamped); DiffuseColor0 (0, 0.6745, 0.9294) x 0.3 added; faded out
   * above 40 km/s (1 - smoothstep of (speed - 40000) x 0.000017), by the length on the screen less half the width x 0.5,
   * and a blinking one at 0.625 + 0.375 cos(8 t). Quad 1 (an aggressor's approach): from its centre toward the ship
   * (PlanePosition, the origin) by its velocity's part along the line x saturate((cos to the ship - 0.65) x 2.898551),
   * twice the quad 0 time, DiffuseColor1 (1, 0.098, 0.0235) x 0.5, shown from 0.25 px; quad 2 (the relative approach):
   * from its centre along the line by how its distance changes in a second against the ship's velocity (|p + v - root
   * velocity| - |p|) x clamp(0.0002 |view z|^0.62, 1, 5), DiffuseColor2 white x 0.498
   */
  private drawTacticalVelocity(list: { at: THREE.Vector3; v: THREE.Vector3; radius: number; blink: boolean; quad?: 0 | 1 | 2 }[], w: number, h: number, own: THREE.Vector3): void {
    const t = this.tactical!;
    const pos: number[] = [], uv: number[] = [], col: number[] = [], index: number[] = [];
    const cam = this.camera.position;
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const ahead = (p: THREE.Vector3) => p.clone().sub(cam).dot(camDir);
    const pxWorld = (p: THREE.Vector3) => (2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(1e-3, ahead(p))) / h;
    const toPx = (p: THREE.Vector3) => { const q = p.clone().project(this.camera); return new THREE.Vector2(((q.x + 1) / 2) * w, ((1 - q.y) / 2) * h); };
    const WIDTH = 14;
    const pulse = 0.625 + 0.375 * Math.cos(8 * (performance.now() / 1000));
    for (const x of list) {
      const quad = x.quad ?? 0;
      const speed = x.v.length();
      if (quad !== 2 && speed < 1e-3) continue;
      const depth = Math.abs(ahead(x.at));
      const scale = Math.min(10, Math.max(1, 0.0004 * Math.pow(depth, 0.825)));
      const dist = x.at.length();
      const radial = dist > 0 ? x.at.clone().divideScalar(dist) : new THREE.Vector3(1, 0, 0);
      let start: THREE.Vector3, end: THREE.Vector3;
      if (quad === 0) {
        start = x.at.clone().addScaledVector(x.v.clone().divideScalar(speed), Math.floor(x.radius));
        end = start.clone().addScaledVector(x.v, scale);
      } else if (quad === 1) {
        const approach = Math.min(1, Math.max(0, (x.v.clone().divideScalar(speed).dot(radial.clone().negate()) - 0.65) * 2.898551));
        start = x.at.clone();
        end = start.clone().addScaledVector(radial, x.v.dot(radial) * approach * 2 * scale);
      } else {
        const rate = x.at.clone().add(x.v).sub(own).length() - dist;
        start = x.at.clone();
        end = start.clone().addScaledVector(radial, rate * Math.min(5, Math.max(1, 0.0002 * Math.pow(depth, 0.62))));
      }
      if (ahead(start) <= 0 || ahead(end) <= 0) continue;
      const lenPx = toPx(start).distanceTo(toPx(end));
      const s = Math.min(1, Math.max(0, (speed - 40_000) * 0.000017));
      const shortest = quad === 1 ? 0.25 : WIDTH / 2;
      const fade = (1 - s * s * (3 - 2 * s)) * (x.blink ? pulse : 1) * Math.min(1, Math.max(0, (lenPx - shortest) * 0.5));
      const rgb = quad === 0 ? [0, 0.6745 * 0.3, 0.9294 * 0.3] : quad === 1 ? [0.5, 0.098 * 0.5, 0.0235 * 0.5] : [0.498, 0.498, 0.498];
      if (fade <= 0) continue;
      const side = end.clone().sub(start).cross(camDir).normalize();
      const first = pos.length / 3;
      for (const [p, along] of [[start, 0], [end, 1]] as const) {
        const half = (WIDTH / 2) * pxWorld(p);
        for (const [sgn, u] of [[-1, 0], [1, 1]] as const) {
          const q = p.clone().addScaledVector(side, sgn * half);
          pos.push(q.x, q.y, q.z);
          uv.push(u, ((1 - along) * lenPx) / WIDTH);
          col.push(rgb[0]! * fade, rgb[1]! * fade, rgb[2]! * fade);
        }
      }
      index.push(first, first + 1, first + 3, first, first + 3, first + 2);
    }
    const g = t.velocity.geometry;
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(index);
    g.computeBoundingSphere();
  }

  /**
   * tacticalNavigation.ActionDisplay (enabled with the tactical overlay, every 500 ms; here each frame): the ship's
   * movement - going to a point (DSTBALL_GOTO): a NavigationPoint there (its bracket selectioncircle.png 24 px in
   * COLOR_MOVE 0.5, a connector of the overlay's to the plane) and the movement line to it; following (a followId:
   * approach, keep at range): the movement line to the thing; orbiting: the orbit (EveConnector.AddOrbit: the circle of
   * the thing's radius + followRange + the ship's about it, its plane's normal (cos phi1 cos phi2, sin phi2, sin phi1
   * cos phi2), phi1 = 0.001 t, phi2 = (ship id & 65535) + 0.001 t, t the ballpark's seconds) and the line from the ship
   * to it. CreateMovementConnector / CreateOrbitConenctor: COLOR_MOVE at ALPHA_MEDIUM 0.3; the movement line no longer
   * than SetMaxMoveRange's 2 x the compass's range (PointToPoint: cut there, fading to nothing).
   */
  private drawActionDisplay(origin: { x: number; y: number; z: number }, maxMove: number, w: number, h: number): { at: THREE.Vector3 } | null {
    const t = this.tactical!;
    const ship = this.snapshot?.ship;
    const pts: number[] = [], cols: number[] = [];
    const C = [0, 0.678, 0.933];
    const line = (a: THREE.Vector3, b: THREE.Vector3, endAlpha = 0.3) => { pts.push(a.x, a.y, a.z, b.x, b.y, b.z); cols.push(C[0]!, C[1]!, C[2]!, 0.3, C[0]!, C[1]!, C[2]!, endAlpha); };
    const rel = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x - origin.x, p.y - origin.y, -(p.z - origin.z));
    let nav: { at: THREE.Vector3 } | null = null;
    const o = new THREE.Vector3();
    const movement = (to: THREE.Vector3) => {
      const d = to.length();
      if (maxMove > 0 && d > maxMove) line(o, to.clone().setLength(maxMove), 0); else line(o, to);
    };
    if (ship) {
      const park = this.live.park as unknown as { ballpark: { ball(id: number): { followId?: unknown; followRange?: unknown } | undefined } };
      const ball = park?.ballpark?.ball(ship.itemID);
      const followID = Number(ball?.followId ?? 0);
      const follow = followID > 0 ? this.snapshot?.entities.find((e) => e.itemID === followID) ?? null : null;
      const moving = ship as typeof ship & { gotoPoint?: { x: number; y: number; z: number } | null; followRange?: number | null };
      if (ship.mode === "GOTO" && moving.gotoPoint) {
        nav = { at: rel(moving.gotoPoint) };
        movement(nav.at);
        // PendingMoveIndication: a second movement connector to the point, animated (lineConnectorMoving.red: overlay
        // colour (0, 0, 0, 1), animationScale 0.5, animationSpeed -4) - Lines3DSizeClamped.fx multiplies its alpha by
        // OverlayTexMap square.dds (opaque over rows 5 to 10 of 16) at v = (along the line 0..1 + speed x Time) x scale
        const since = performance.now() - this.pendingMoveAt;
        if (since >= 0 && since < 3000) {
          const time = performance.now() / 1000;
          const N = 48;
          for (let i = 0; i < N; i++) {
            const s0 = i / N, s1 = (i + 1) / N, mid = (s0 + s1) / 2;
            const v = (mid - 4 * time) * 0.5;
            const frac = v - Math.floor(v);
            if (frac < 5 / 16 || frac >= 11 / 16) continue;
            const a = nav.at.clone().multiplyScalar(s0), b = nav.at.clone().multiplyScalar(s1);
            pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
            cols.push(C[0]!, C[1]!, C[2]!, 0.3, C[0]!, C[1]!, C[2]!, 0.3);
          }
        }
      } else if (ship.mode === "ORBIT" && follow) {
        const c = rel(follow.position);
        const radius = follow.radius + Number(moving.followRange ?? ball?.followRange ?? 0) + ship.radius;
        const now = Math.floor(Date.now() / 1000);
        const phi1 = now * 0.001, phi2 = (ship.itemID & 65535) + now * 0.001;
        // the client's y-up normal, z turned to three's
        const n = new THREE.Vector3(Math.cos(phi1) * Math.cos(phi2), Math.sin(phi2), -Math.sin(phi1) * Math.cos(phi2)).normalize();
        const up = new THREE.Vector3(0, 1, 0);
        const side = Math.abs(n.dot(up)) < 0.999 ? new THREE.Vector3().crossVectors(up, n).normalize() : new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), n).normalize();
        const front = new THREE.Vector3().crossVectors(side, n).normalize();
        let prev = c.clone().addScaledVector(front, radius);
        for (let i = 1; i <= 96; i++) {
          const a = (i / 96) * Math.PI * 2;
          const p = c.clone().addScaledVector(front, Math.cos(a) * radius).addScaledVector(side, Math.sin(a) * radius);
          line(prev, p);
          prev = p;
        }
        // and the line to the orbit: from the ship to the circle's point nearest it
        const toShip = o.clone().sub(c);
        const inPlane = toShip.addScaledVector(n, -toShip.dot(n));
        if (inPlane.lengthSq() > 0) line(o, c.clone().add(inPlane.setLength(radius)));
      } else if (follow) {
        movement(rel(follow.position));
      }
    }
    const g = t.action.geometry;
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(cols, 4));
    g.computeBoundingSphere();
    // the navigation point's bracket
    const v = nav ? nav.at.clone().project(this.camera) : null;
    const shown = v !== null && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
    t.navBracket.style.display = shown ? "" : "none";
    if (shown && v) t.navBracket.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    return nav;
  }

  /**
   * EveTacticalOverlay's anchors (TacticalOverlayAnchor.fx with tacticalOverlay.red's AnchorParameters (0.875, 0.026),
   * anchor.dds, added): for each connector a quad flat on the plane where its arc ends (the thing's direction in the
   * plane at its distance), AnchorParameters.y |view z|^AnchorParameters.x across; the texture's red channel for a
   * thing above the plane, its green for one below; faded past the active range over its fade (Fadeout: 1 -
   * saturate((d - x z) / ((x + y) z - x z))) and to 1 - (1 - _outsideInterestIntensity 0.35) for a thing farther than
   * the interest range beyond its radius and the ship's (the targeting range, a hovered module's optimal + falloff)
   */
  private drawTacticalAnchors(list: { plane: THREE.Vector3; above: boolean; dist: number; radius: number }[], active: number, fade: number, base: number, interest: number): void {
    const t = this.tactical!;
    const pos: number[] = [], uv: number[] = [], col: number[] = [], index: number[] = [];
    const cam = this.camera.position;
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const CORNERS = [[-0.5, -0.5, 0, 0], [0.5, -0.5, 1, 0], [0.5, 0.5, 1, 1], [-0.5, 0.5, 0, 1]] as const;
    for (const a of list) {
      const out = 1 - Math.min(1, Math.max(0, (a.dist - active) / fade));
      const reduced = interest > 0.0001 && a.dist - a.radius - base > interest ? 1 - 0.35 : 0;
      const k = out * (1 - reduced);
      if (k <= 0) continue;
      const size = 0.026 * Math.pow(Math.abs(a.plane.clone().sub(cam).dot(camDir)), 0.875);
      const first = pos.length / 3;
      for (const [x, z, u, v] of CORNERS) {
        pos.push(a.plane.x + x * size, a.plane.y, a.plane.z + z * size);
        uv.push(u, v);
        col.push(k, k, k, a.above ? 1 : 0);
      }
      index.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
    // TacticalCompass.SetMoveMode: the anchors' DiffuseColor COLOR_MOVE (0, 0.678, 0.933) while the move command is on
    const diffuse = (t.anchors.material as THREE.ShaderMaterial).uniforms.diffuse!.value as THREE.Color;
    if (this.moveCmd) diffuse.setRGB(0, 0.678, 0.933, THREE.LinearSRGBColorSpace); else diffuse.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
    const g = t.anchors.geometry;
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute("tint", new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(index);
    g.computeBoundingSphere();
  }

  /**
   * TacticalOverlayConnector.fx's strips for the connectors' segments: LineParameters.z (4 px) wide, each a soft ridge
   * across (saturate((1 - 2 |v - 0.5|) / LineParameters.w)), white at the segment's intensity, added.
   */
  private drawConnectorStrips(segs: { a: THREE.Vector3; b: THREE.Vector3; ka: number; kb: number }[], h: number): void {
    const t = this.tactical!;
    const pos: number[] = [], uv: number[] = [], ks: number[] = [], index: number[] = [];
    const cam = this.camera.position;
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const ahead = (p: THREE.Vector3) => p.clone().sub(cam).dot(camDir);
    const pxWorld = (p: THREE.Vector3) => (2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(1e-3, ahead(p))) / h;
    const HALF = 2;
    for (const s of segs) {
      if (ahead(s.a) <= 0 && ahead(s.b) <= 0) continue;
      const side = s.b.clone().sub(s.a).cross(camDir);
      if (side.lengthSq() === 0) continue;
      side.normalize();
      const first = pos.length / 3;
      for (const [p, k] of [[s.a, s.ka], [s.b, s.kb]] as const) {
        const half = HALF * pxWorld(p);
        for (const [sgn, v] of [[-1, 0], [1, 1]] as const) {
          const q = p.clone().addScaledVector(side, sgn * half);
          pos.push(q.x, q.y, q.z);
          uv.push(0, v);
          ks.push(k);
        }
      }
      index.push(first, first + 1, first + 3, first, first + 3, first + 2);
    }
    const g = t.connectors.geometry;
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute("intensity", new THREE.Float32BufferAttribute(ks, 1));
    g.setIndex(index);
    g.computeBoundingSphere();
  }

  private sensorOverlayOn(): boolean {
    try { return localStorage.getItem(SENSOR_OVERLAY_KEY) !== "false"; } catch { return true; }
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
  /**
   * MergeMenus over the selected drones' CelestialMenus (read through gridcheck on two of the client's drones): the first's
   * menu without Show Info, each drone order run on them all and counted - "Engage Target (2)", "Return and Orbit (2)",
   * "Return to Drone Bay (2)", "Scoop to Cargo Hold (2)", "Abandon Drone (2)"; the movement, Add to Overview and Move
   * Drone as the first's.
   */
  private mergedDroneEntries(e: Entity, ids: readonly number[], droneExtra: readonly ContextEntry[]): (ContextEntry | null)[] {
    const n = ids.length;
    const order = (kind: "primary" | "orbit" | "bay" | "scoop" | "abandon") => () => this.actions.droneOrder?.(kind, [...ids]);
    const runs: Record<string, () => void> = {
      "UI/Drones/EngageTarget": order("primary"), "UI/Drones/MineWithDrone": order("primary"), "UI/Drones/Salvage": order("primary"),
      "UI/Drones/ReturnDroneAndOrbit": order("orbit"), "UI/Drones/ReturnDroneToBay": order("bay"), "UI/Drones/ScoopDroneToBay": order("scoop"),
      "UI/Drones/AbandonDrone": order("abandon"),
      "UI/Inflight/ScoopToCargoHold": () => { for (const id of ids) void this.act("Scoop", () => this.actions.scoopToCargo!(id)); },
      "UI/Inflight/ScoopToFleetHangar": () => { for (const id of ids) void this.act("Scoop", () => this.actions.scoopToFleetHangar!(id)); },
    };
    const merged = this.contextEntries(e, droneExtra)
      .filter((x) => x === null || x.path !== "UI/Commands/ShowInfo")
      .map((x) => (x && x.path && runs[x.path] ? { ...x, label: `${x.label} (${n})`, run: runs[x.path] } : x));
    return merged.filter((x, i, all) => x !== null || (i > 0 && i < all.length - 1 && all[i - 1] !== null));
  }

  /** An object's own space menu (its CelestialMenu), for another window's menu to open as a submenu; null off the grid. */
  menuEntriesFor(itemID: number): (ContextEntry | null)[] | null {
    const e = this.snapshot?.entities.find((x) => x.itemID === itemID);
    return e ? this.contextEntries(e) : null;
  }

  private contextEntries(e: Entity, droneExtra: readonly ContextEntry[] = []): (ContextEntry | null)[] {
    const word = (label: string, own: string, args?: Readonly<Record<string, string | number>>) => this.actions.word?.(label, args) ?? own;
    const id = e.itemID;
    const run = (title: string, fn: () => Promise<void>) => () => void this.act(title, fn).then(() => this.refreshTargets());
    const I = (name: string) => `res:/UI/Texture/eveicon/control_icons/${name}_16px.png`;
    const showInfo: ContextEntry = { path: "UI/Commands/ShowInfo", label: word("UI/Commands/ShowInfo", "Show Info"), info: true, run: () => this.options.showInfo?.(id, e.typeID ?? null) };
    if (e.isSelf) {
      // openFunctions.GetOpenShipHoldMenus: the active ship (not a capsule) - Open Cargohold (eveicon.inventory), then each
      // hold the ship has in the client's order; read through gridcheck on the client's Porpoise: Open Cargohold, Open
      // Drone Bay, Open Fleet Hangar, Open Fuel Bay, Open General Mining Hold
      const present = new Set<string>([
        ...(this.options.miningSurvey?.()?.holds ?? []).filter((h) => h.present).map((h) => h.key),
        ...(this.actions.shipBays?.(id) ?? []).map((b) => b.key),
      ]);
      const holds: ContextEntry[] = e.groupID === 29 ? [] : OPEN_HOLD_ENTRIES.filter(([key]) => key === "cargo" || present.has(key)).map(([key, label, own]) => ({
        path: label, label: word(label, own), ...(key === "cargo" ? { icon: "res:/UI/Texture/eveicon/system_icons/inventory_16px.png" } : {}),
        run: () => this.actions.openShipHold?.(key),
      }));
      // the rest in menuHierarchy's order (groups read through gridcheck on the client's own-ship menu): Stop My Ship and
      // Activate Autopilot (OfferActivateAutopilot: not on autopilot), Track (OfferSetAsCameraInterest: not already the
      // camera's interest) and Look At My Ship (UI/Inflight/ResetCamera); Show Info; the holds; the group's overview
      // toggle; Reconnect To Lost Drones (a drone-capable ship, not warping)
      const selfGroup = e.groupID ?? null;
      const tail: (ContextEntry | null)[] = [];
      if (selfGroup !== null) tail.push(null, this.overviewToggleEntry(selfGroup));
      if (present.has("drone") && this.snapshot?.ship?.mode !== "WARP") {
        tail.push(null, { path: "UI/Commands/ReconnectToLostDrones", label: word("UI/Commands/ReconnectToLostDrones", "Reconnect To Lost Drones"), run: () => this.actions.runCommand?.("CmdReconnectToDrones") });
      }
      return [
        { label: word(e.groupID === 29 ? "UI/Inflight/StopMyCapsule" : "UI/Inflight/StopMyShip", e.groupID === 29 ? "Stop My Capsule" : "Stop My Ship"), run: run("Stop", () => this.actions.stop()) },
        ...(this.actions.autopilotOn?.() ? [] : [{ path: "UI/Inflight/ActivateAutopilot", label: word("UI/Inflight/ActivateAutopilot", "Activate Autopilot"), run: () => this.actions.runCommand?.("CmdToggleAutopilot") }]),
        // (one group with Track and Look At My Ship: the menu as menuDataFactory.CreateMenuDataWithEntries shows it, read
        // through gridcheck on the client's own ship - no line between Activate Autopilot and Track)
        ...(this.trackedObjective === id ? [] : [{ path: "UI/Inflight/SetAsCameraInterest", label: word("UI/Inflight/SetAsCameraInterest", "Track"), run: () => { this.endExplosionCamera(); this.trackedObjective = id; } }]),
        { path: "UI/Inflight/ResetCamera", label: word("UI/Inflight/ResetCamera", "Look At My Ship"), run: () => this.focusOn(null) },
        null,
        showInfo,
        // OfferEnterStarbasePassword (the active ship, not in a structure): its own group (17, hierarchy 5), after Show Info
        ...(this.actions.enterShipPassword ? [null, { path: "UI/Inflight/POS/EnterStarbasePassword", label: word("UI/Inflight/POS/EnterStarbasePassword", "Enter Starbase Forcefield Password"), run: () => this.actions.enterShipPassword?.() }] : []),
        // OfferPilotMenu (a ship with an owner): "Pilot (<name>)" with one's own CharacterMenu, after Show Info
        ...((): (ContextEntry | null)[] => { const p = e.characterID ? this.options.pilotMenu?.(e.characterID, { corporationID: e.corporationID ?? null, allianceID: e.allianceID ?? null }) ?? null : null; return p ? [null, p] : []; })(),
        // OfferSetName (one's own specific thing; a ship's through the ship naming window), CONFIGGROUP
        ...(this.actions.renameShip ? [null, { path: "UI/Commands/SetName", label: word("UI/Commands/SetName", "Set Name"), run: () => this.actions.renameShip?.(id) }] : []),
        ...(holds.length ? [null, ...holds] : []),
        ...tail,
        // OfferEjectFromShip (the active ship, not a capsule), DESTRUCTIVE: last
        // OfferSafeLogoff (the active ship, not warping, not already logging off), group 17 ahead of Eject: Log Off Safely
        ...(this.actions.safeLogoff && this.snapshot?.ship?.mode !== "WARP" && !this.actions.loggingOffSafely?.()
          ? [null, { path: "UI/Inflight/SafeLogoff", label: word("UI/Inflight/SafeLogoff", "Log Off Safely"), run: () => this.actions.safeLogoff?.() }] : []),
        ...(e.groupID !== 29 && this.actions.ejectFromShip ? [null, { path: "UI/Inflight/EjectFromShip", label: word("UI/Inflight/EjectFromShip", "Eject"), run: () => this.actions.ejectFromShip?.() }] : []),
        // OfferSelfDestructShip (not warping, not counting down: the slim item's selfDestructTime) or, counting down,
        // OfferAbortSelfDestructShip - DESTRUCTIVE, after Eject (_CelestialMenu 1652)
        ...((): ContextEntry[] => {
          const counting = this.live.park.slimItems.get(id)?.get("selfDestructTime") != null;
          if (counting && this.actions.abortSelfDestructShip) return [{ path: "UI/Inflight/AbortSelfDestruct", label: word("UI/Inflight/AbortSelfDestruct", "Abort Self-Destruct"), run: () => this.actions.abortSelfDestructShip?.(id) }];
          if (!counting && this.snapshot?.ship?.mode !== "WARP" && this.actions.selfDestructShip) return [{ path: "UI/Inflight/SelfDestructShipOrPod", label: word("UI/Inflight/SelfDestructShipOrPod", "Self-Destruct..."), run: () => this.actions.selfDestructShip?.(id, e.groupID === 29) }];
          return [];
        })(),
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
    // OfferBoardShip (_CelestialMenu 1603, ahead of Approach): a ship no pilot flies, not the active one, within
    // maxBoardingDistance (6,550 m), the pilot in a ship in space and not warping
    if (category === 6 && !e.characterID && !warping && dist <= 6550 && this.actions.boardShip) {
      out.push({ path: "UI/Inflight/BoardShip", label: word("UI/Inflight/BoardShip", "Board Ship"), run: () => this.actions.boardShip?.(id, e.typeID ?? null) });
    }
    // The drone's own entries (menusvc._DroneMenu) fall in menuUtil's groups as the client sorts them: Engage / Mine /
    // Salvage (ACTIONSGROUP) first; Return and Orbit, Return to Drone Bay, Scoop to Drone Bay (CHANGESGROUP) with the
    // scoops after Show Info and the overview entry; Abandon Drone (DESTRUCTIVEGROUP) last (read off the live client's
    // menu for its own idle Mining Drone I)
    const droneChanges: ContextEntry[] = [...droneExtra];
    const droneFleet: ContextEntry[] = [];
    let droneAbandon: ContextEntry | null = null;
    // CelestialChecker.OfferDroneMenu (menusvc._DroneMenu, DroneChecker's offers)
    if (category === 18 && this.actions.droneOrder) {
      const ship = this.snapshot?.ship ?? null;
      const ego = this.snapshot?.entities.find((x) => x.isSelf) ?? null;
      const me = (ego as (Entity & { characterID?: number | null }) | null)?.characterID ?? ego?.ownerID ?? null;
      const d = e as Entity & { controllerID?: number | null; droneActivity?: string | null };
      const owned = me !== null && e.ownerID === me;
      const hasState = d.droneActivity !== undefined && d.droneActivity !== null;
      const controlled = hasState && ship !== null && d.controllerID === ship.itemID;
      const mining = group === 101, salvage = group === 1159, unanchoring = group === 470;
      const order = (kind: "primary" | "orbit" | "bay" | "scoop" | "abandon") => () => this.actions.droneOrder?.(kind, [id]);
      if (controlled && !mining && !unanchoring && !salvage) out.push({ path: "UI/Drones/EngageTarget", label: word("UI/Drones/EngageTarget", "Engage Target"), run: order("primary") });
      if (controlled && mining) out.push({ path: "UI/Drones/MineWithDrone", label: word("UI/Drones/MineWithDrone", "Mine"), run: order("primary") });
      else if (controlled && salvage) out.push({ path: "UI/Drones/Salvage", label: word("UI/Drones/Salvage", "Salvage"), run: order("primary") });
      if (controlled && owned) droneChanges.push({ path: "UI/Drones/ReturnDroneAndOrbit", label: word("UI/Drones/ReturnDroneAndOrbit", "Return and Orbit"), run: order("orbit") });
      if (hasState && owned) droneChanges.push({ path: "UI/Drones/ReturnDroneToBay", label: word("UI/Drones/ReturnDroneToBay", "Return to Drone Bay"), run: order("bay") });
      // OfferScoopDroneToBay: in space, within minWarpDistance (150 km), and IsScoopableDrone - no drone state in the
      // pilot's michelle (GetDroneState holds the pilot's own drones only: another pilot's drone has none, one's own
      // abandoned or left behind has none; seen on the live client for the page pilot's drone)
      if (!(owned && hasState) && dist <= 150_000) droneChanges.push({ path: "UI/Drones/ScoopDroneToBay", label: word("UI/Drones/ScoopDroneToBay", "Scoop to Drone Bay"), run: order("scoop") });
      // OfferDroneAssist / OfferDroneGuard: one's own drone under the active ship's control, in a fleet - each a
      // submenu of GetFleetMemberMenu (the members in the ballpark save the pilot, by name; the watchlist's first under
      // Watch List; past 20, by letters; none, No Valid Options)
      if (owned && controlled && this.actions.inFleet?.() && this.actions.droneFleetOrder) {
        const members = this.fleetMemberMenu((charID) => () => this.actions.droneFleetOrder?.("assist", charID, [id]), word);
        const guard = this.fleetMemberMenu((charID) => () => this.actions.droneFleetOrder?.("guard", charID, [id]), word);
        droneFleet.push({ path: "UI/Drones/DroneAssist", label: word("UI/Drones/DroneAssist", "Assist"), sub: members });
        droneFleet.push({ path: "UI/Drones/DroneGuard", label: word("UI/Drones/DroneGuard", "Guard"), sub: guard });
      }
      if (owned && hasState) droneAbandon = { path: "UI/Drones/AbandonDrone", label: word("UI/Drones/AbandonDrone", "Abandon Drone"), run: order("abandon") };
      // (the drone's order heads the movement group, as the client's Engage Target: no line after it)
    }
    // Orbit / KeepAtRange / WarpToMenuEntryData.GetTextDescriptive: the entry with its default distance (GetActionTextWithDistance:
    // SelectedItemActionWithDist, "Orbit (1,000 m)" on the client)
    const withDist = (label: string, d: number) => this.actions.word?.("UI/Menusvc/MenuHints/SelectedItemActionWithDist", { actionName: label, distanceString: fmtDistance(d) }) ?? label;
    // CelestialMenu: OfferMoonMiningPointMenu (a moon) -> GetMoonMiningPointMenu before the warp entries: where
    // OfferWarpToMoonMiningPoint (its mining point's beacon in the scene, not warping, in warp range) a Moon Mining
    // Point submenu of _GetWarpOptions - Warp to Mining Point Within <default> and Warp to Within > the seven ranges
    // and Set Default Warp Range (WarpToMenu); else nothing
    if (group === 8 && this.actions.warpToMoonMiningPoint && !warping && (this.distanceTo(e) ?? 0) >= 150_000
      && this.snapshot?.entities.some((x) => x.itemID === 1_000_000_000 + id)) {
      const d = defaultDistance("WarpTo");
      const toPoint = (r: number) => run("Warp", () => this.actions.warpToMoonMiningPoint!(id, r));
      out.push({ path: "UI/Inflight/MoonMiningPoint", label: word("UI/Inflight/MoonMiningPoint", "Moon Mining Point"), sub: [
        { path: "UI/Inflight/WarpToMoonMiningPoint", label: word("UI/Inflight/WarpToMoonMiningPoint", `Warp to Mining Point Within ${fmtDistance(d)}`, { distance: fmtDistance(d) }), run: toPoint(d) },
        { path: "UI/Inflight/Submenus/WarpToWithin", label: word("UI/Inflight/Submenus/WarpToWithin", "Warp to Within"),
          sub: [...warpRanges.map((r) => ({ label: within(r), run: toPoint(r) })), null, setDefault("WarpTo", warpRanges, within)] },
      ] });
    }
    if (warp) {
      const d = defaultDistance("WarpTo");
      out.push({
        path: "UI/Inflight/Submenus/WarpToWithin",
        label: withDist(word("UI/Inflight/Submenus/WarpToWithin", "Warp to Within"), d), icon: I("warp_to"),
        run: run("Warp", () => this.actions.warpTo(id, d)),
        sub: [...warpRanges.map((r) => ({ label: within(r), run: run("Warp", () => this.actions.warpTo(id, r)) })), null, setDefault("WarpTo", warpRanges, within)],
      });
    }
    if (approach) {
      out.push({ path: "UI/Inflight/ApproachObject", label: word("UI/Inflight/ApproachObject", "Approach"), icon: I("approach"), run: run("Approach", () => this.actions.approach(id)) });
      const orbitD = defaultDistance("Orbit"), keepD = defaultDistance("KeepAtRange");
      out.push({ path: "UI/Inflight/OrbitObject", label: withDist(word("UI/Inflight/OrbitObject", "Orbit"), orbitD), icon: I("orbit"), run: run("Orbit", () => this.actions.orbit(id, orbitD)),
        sub: ranges("Orbit", orbitRanges, "UI/Inflight/OrbitAtCurrentRange", (r) => void this.act("Orbit", () => this.actions.orbit(id, r))) });
      if (!noKeep) out.push({ path: "UI/Inflight/Submenus/KeepAtRange", label: withDist(word("UI/Inflight/Submenus/KeepAtRange", "Keep at Range"), keepD), icon: I("keep_at_distance"), run: run("Keep at Range", () => this.actions.keepAtRange(id, keepD)),
        sub: ranges("KeepAtRange", orbitRanges, "UI/Inflight/KeepAtCurrentRange", (r) => void this.act("Keep at Range", () => this.actions.keepAtRange(id, r))) });
    } else if (warp) {
      out.push({ path: "UI/Inflight/AlignTo", label: word("UI/Inflight/AlignTo", "Align to"), icon: I("align_to"), run: run("Align", () => this.actions.alignTo(id)) });
    }
    if (dockable && !warping) out.push({ path: "UI/Inflight/DockInStation", label: word("UI/Inflight/DockInStation", "Dock"), icon: I("dock"), run: run("Dock", () => this.actions.dock(id)) });
    if (stargate) {
      out.push({ path: "UI/Inflight/Jump", label: word("UI/Inflight/Jump", "Jump"), icon: I("jump_to"), run: run("Jump", () => this.actions.jump(id)) });
    }
    // (the client's menu shows the movement entries, Look at, Track and the lock as one group)
    // OfferLookAtObject (not the thing looked at) / OfferResetCamera (isLookingAtMe): Look At My Ship on the thing the
    // camera already looks at
    if (!warping && this.lookAt === id) out.push({ path: "UI/Inflight/ResetCamera", label: word("UI/Inflight/ResetCamera", "Look At My Ship"), run: () => this.focusOn(null) });
    else if (!warping && group !== 7 && group !== 8) out.push({ path: "UI/Inflight/LookAtObject", label: word("UI/Inflight/LookAtObject", "Look at"), run: () => this.focusOn(id) });
    out.push({ path: "UI/Inflight/SetAsCameraInterest", label: word("UI/Inflight/SetAsCameraInterest", "Track"), run: () => { this.endExplosionCamera(); this.trackedObjective = id; } });
    // (OfferCancelLockTarget: a lock being made offers no Lock Target here, its Cancel Locking Attempt at the menu's end)
    const lockingNow = !this.locked.has(id) && (this.lockingIDs.has(id) || this.acquiringTargets.has(id));
    if (this.locked.has(id)) out.push({ path: "UI/Inflight/UnlockTarget", label: word("UI/Inflight/UnlockTarget", "Unlock Target"), icon: I("target"), run: run("Unlock Target", () => this.actions.unlock(id)) });
    else if (!lockingNow && !planetMoonBelt && this.snapshot?.ship?.typeID !== 670) {
      const lockRange = this.actions.shipAttribute?.(76) ?? null;
      if (lockRange === null || dist <= lockRange) out.push({ path: "UI/Inflight/LockTarget", label: word("UI/Inflight/LockTarget", "Lock Target"), icon: I("target"), run: run("Lock Target", () => this.lockTracked(id)) });
    }
    out.push(null, showInfo);
    // _CelestialMenu (2050): a ship with a pilot not the pilot's own, "Pilot (<name>)" with the CharacterMenu after Show Info, a group of its own (read through gridcheck)
    if (e.characterID && !e.isSelf && this.options.pilotMenu) { const pilot = this.options.pilotMenu(e.characterID, { corporationID: e.corporationID ?? null, allianceID: e.allianceID ?? null }); if (pilot) out.push(null, pilot); }
    out.push(null);
    if (stargate) out.push({ path: "UI/Inflight/AddFirstWaypoint", label: word("UI/Inflight/AddFirstWaypoint", "Add as First Waypoint"), run: () => this.actions.addWaypoint?.(id) });
    else if (dockable && this.actions.setDestination) {
      out.push({ path: "UI/Inflight/SetDestination", label: word("UI/Inflight/SetDestination", "Set Destination"), icon: "res:/UI/Texture/eveicon/system_icons/set_destination_16px.png", run: () => this.actions.setDestination?.(id) });
      out.push({ path: "UI/Inflight/AddWaypoint", label: word("UI/Inflight/AddWaypoint", "Add Waypoint"), run: () => this.actions.addWaypoint?.(id) });
    }
    // overviewMenuUtil: a group not shown is offered to the Overview before Save Location...; one shown is taken off at the foot
    const groupName = group !== null ? this.names?.groups[String(group)]?.[0] ?? "" : "";
    const shownInOverview = group !== null && this.overview.groupShown(group);
    if (group !== null && !shownInOverview) out.push({ path: "UI/Overview/AddGroupToOverview", label: word("UI/Overview/AddGroupToOverview", `Add ${groupName} to Overview`, { groupName }), run: () => this.overview.setGroupShown(group, true) });
    // _CelestialMenu's space component entries (3698585): Use Fitting Service where the pilot's ship is within the
    // fitting component's range of its own active one (OfferUseFittingService, IsShipWithinFittingRange), before Save
    // Location...; after it, of one's own active thing Open Cargo (OfferOpenCargoBay: cargoBay, the owner or free for
    // all) and Scoop to Cargo Hold (OfferScoopToCargoHold: a scoop component, IsOwnedByMe)
    const comps = spaceComponentsNow();
    const typeID = e.typeID ?? null;
    const active = isActiveComponent(comps, typeID, e.componentActive);
    const mine = e.ownerID != null && e.ownerID === this.snapshot?.ship?.ownerID;
    const fittingRange = typeID !== null ? comps.fitting.get(typeID) : undefined;
    if (fittingRange !== undefined && mine && active && dist <= fittingRange && this.actions.openFitting) {
      out.push({ path: "UI/Fitting/UseFittingService", label: word("UI/Fitting/UseFittingService", "Use Fitting Service"), run: () => this.actions.openFitting?.() });
    }
    // OfferBookmarkLocation: not an entity, drone, ship or fighter
    if (this.actions.saveLocation && category !== 11 && category !== 6 && category !== 18 && category !== 87) out.push({ path: "UI/Inflight/BookmarkLocation", label: word("UI/Inflight/BookmarkLocation", "Save Location..."), run: () => this.actions.saveLocation?.(id, e.typeID ?? null) });
    // OfferSetName: one's own specific thing (not a drone, fighter or biomass, not a ship: that is the ship naming
    // window), after Save Location...
    if (mine && !e.isSelf && e.kind !== "drone" && e.kind !== "fighter" && category !== 6 && category !== 18 && category !== 87 && this.actions.setName) {
      // (read through gridcheck on a pilot's own Mobile Depot: Save Location..., Set Name, Open Cargo and the scoops each a
      // group of their own, the scoops with the overview group's entry)
      out.push(null);
      out.push({ path: "UI/Commands/SetName", label: word("UI/Commands/SetName", "Set Name"), run: () => this.actions.setName?.(id, e.name ?? "") });
    }
    const bay = typeID !== null ? comps.cargoBay.get(typeID) : undefined;
    // a can or a wreck: Open Cargo in a group of its own after Save Location... (read through gridcheck on a jettisoned can
      // and a wreck: Save Location... | Open Cargo)
    if ((e.kind === "container" || e.kind === "wreck") && !bay && this.actions.openCargo) {
      out.push(null);
      out.push({ path: "UI/Commands/OpenCargo", label: word("UI/Commands/OpenCargo", "Open Cargo"), run: run("Open Cargo", () => this.actions.openCargo!(id)) });
    }
    if (bay && active && (mine || bay[1]) && this.actions.openCargo) {
      out.push(null);
      out.push({ path: "UI/Commands/OpenCargo", label: word("UI/Commands/OpenCargo", "Open Cargo"), run: run("Open Cargo", () => this.actions.openCargo!(id)) });
    }
    // (the drone group under a line of its own, after Add ... to Overview)
    // OfferScoopToCargoHold (IsScoopable) and OfferScoopToFleetHangar (the same, a ship with hasFleetHangars, 911)
    const scoops: ContextEntry[] = [];
    if (this.isScoopable(e, comps) && this.actions.scoopToCargo) {
      scoops.push({ path: "UI/Inflight/ScoopToCargoHold", label: word("UI/Inflight/ScoopToCargoHold", "Scoop to Cargo Hold"), run: run("Scoop", () => this.actions.scoopToCargo!(id)) });
      if ((this.actions.shipAttribute?.(911) ?? 0) > 0 && this.actions.scoopToFleetHangar) {
        scoops.push({ path: "UI/Inflight/ScoopToFleetHangar", label: word("UI/Inflight/ScoopToFleetHangar", "Scoop to Fleet Hangar"), run: run("Scoop", () => this.actions.scoopToFleetHangar!(id)) });
      }
    }
    // a drone's: its drone entries under a line of their own, after Add ... to Overview, and its scoops in that same
    // group, no line between (read through gridcheck on a pilot's own Mining Drone I: Return and Orbit, Return to Drone
    // Bay, Scoop to Cargo Hold, Scoop to Fleet Hangar together)
    if (droneChanges.length) { out.push(null, ...droneChanges, ...scoops); scoops.length = 0; }
    if (group === 7 && this.options.viewPlanet) out.push({ path: "UI/PI/Common/ViewInPlanetMode", label: word("UI/PI/Common/ViewInPlanetMode", "View Planetary Industry"), icon: I("enter_planet_view"), run: () => void this.options.viewPlanet?.(id) });
    if (group === 7) {
      // OfferMoonMenuOptions / GetMoons: "Moons", each "Moon N" (UI/Inflight/Submenus/MoonX by its orbit index) with the
      // moon's own menu, a click on it a warp there; none, PlanetHasNoMoons. The planet's moons are the celestials
      // numbered after it, before the next planet (the static data's order); the index is the name's.
      const ents = this.snapshot?.entities ?? [];
      const nextPlanet = Math.min(...ents.filter((x) => x.groupID === 7 && x.itemID > id).map((x) => x.itemID), Infinity);
      const moons = ents.filter((x) => x.groupID === 8 && x.itemID > id && x.itemID < nextPlanet)
        .map((m) => ({ m, n: Number(/(\d+)\s*$/.exec(this.nameOf(m))?.[1] ?? 0) })).sort((a, b) => a.n - b.n);
      // (Moons and the Customs Office a group of their own after View Planetary Industry: read through gridcheck)
      out.push(null);
      out.push({ path: "UI/Menusvc/MoonsMenuOption", label: word("UI/Menusvc/MoonsMenuOption", "Moons"), icon: null,
        sub: moons.length ? moons.map(({ m, n }) => ({ label: word("UI/Inflight/Submenus/MoonX", `Moon ${n}`, { moonNumber: n }),
          run: run("Warp", () => this.actions.warpTo(m.itemID, defaultDistance("WarpTo"))), sub: this.contextEntries(m) }))
          : [{ label: word("UI/Menusvc/PlanetHasNoMoons", "This planet has no moons"), run: () => {} }] });
      // OfferCustomsOfficeMenu / GetCustomsOfficeMenu: the planet's customs office (EveJS numbers it 1,200,000,000,000
      // past the planet) with its own menu, a click on it a warp there
      const poco = ents.find((x) => x.itemID === 1_200_000_000_000 + id);
      if (poco) out.push({ path: "UI/PI/Common/CustomsOffice", label: word("UI/PI/Common/CustomsOffice", "Customs Office"),
        run: run("Warp", () => this.actions.warpTo(poco.itemID, defaultDistance("WarpTo"))), sub: this.contextEntries(poco) });
    }
    // _CelestialMenu's fleet broadcasts (in the client's listing after the rest): Broadcast: Target (OfferBroadcastTarget:
    // not the pilot's own ship, within maxFleetBroadcastTargetDistance), Warp to and Align to (OfferBroadcastWarpTo: not
    // an entity, drone, ship or fighter), Jump to (a stargate), Repair Target (OfferBroadcastHealTarget)
    const broadcasts: ContextEntry[] = [];
    if (this.actions.inFleet?.() && this.actions.broadcastOnItem) {
      const B = (n: string) => `res:/UI/Texture/classes/Fleet/Broadcast/16/${n}.png`;
      const send = (name: "Target" | "HealTarget" | "WarpTo" | "AlignTo" | "JumpTo") => () => this.actions.broadcastOnItem?.(name, id, e.typeID ?? null);
      const inRange = dist < 10_000_000;
      const noWarpKind = e.kind === "ship" || e.kind === "drone" || e.kind === "npc" || e.kind === "fighter" || category === 11 || category === 6 || category === 18 || category === 87;
      if (!e.isSelf && inRange) broadcasts.push({ path: "UI/Fleet/FleetBroadcast/Commands/BroadcastTarget", label: word("UI/Fleet/FleetBroadcast/Commands/BroadcastTarget", "Broadcast: Target"), icon: B("target"), run: send("Target") });
      if (!noWarpKind) {
        broadcasts.push({ path: "UI/Fleet/FleetBroadcast/Commands/BroadcastWarpTo", label: word("UI/Fleet/FleetBroadcast/Commands/BroadcastWarpTo", "Broadcast: Warp to"), icon: B("warpTo"), run: send("WarpTo") });
        broadcasts.push({ path: "UI/Fleet/FleetBroadcast/Commands/BroadcastAlignTo", label: word("UI/Fleet/FleetBroadcast/Commands/BroadcastAlignTo", "Broadcast: Align to"), icon: B("alignTo"), run: send("AlignTo") });
      }
      if (stargate) broadcasts.push({ path: "UI/Fleet/FleetBroadcast/Commands/BroadcastJumpTo", label: word("UI/Fleet/FleetBroadcast/Commands/BroadcastJumpTo", "Broadcast: Jump to"), icon: B("jumpTo"), run: send("JumpTo") });
      if (inRange) broadcasts.push({ path: "UI/Fleet/FleetBroadcast/Commands/BroadcastHealTarget", label: word("UI/Fleet/FleetBroadcast/Commands/BroadcastHealTarget", "Broadcast: Repair Target"), icon: "res:/UI/Texture/eveicon/system_icons/heal_first_aid_16px.png", run: send("HealTarget") });
    }
    if (scoops.length && !(group !== null && shownInOverview)) out.push(null, ...scoops);
    if (group !== null && shownInOverview) out.push(null, ...scoops, { path: "UI/Overview/RemoveGroupFromOverview", label: word("UI/Overview/RemoveGroupFromOverview", `Remove ${groupName} from Overview`, { groupName }), run: () => this.overview.setGroupShown(group, false) });
    out.push(...droneFleet);
    if (broadcasts.length) out.push(null, ...broadcasts);
    // OfferMarkWreckNotViewed / OfferMarkWreckViewed (wrecksvc), a group of its own after the broadcasts
    if (e.kind === "wreck") {
      const seen = isViewedWreck(id);
      out.push(null, seen
        ? { path: "UI/Inflight/MarkWreckNotViewed", label: word("UI/Inflight/MarkWreckNotViewed", "Mark Wreck as Not Viewed"), run: () => markWreckViewed(id, false) }
        : { path: "UI/Inflight/MarkWreckViewed", label: word("UI/Inflight/MarkWreckViewed", "Mark Wreck as Viewed"), run: () => markWreckViewed(id, true) });
    }
    if (droneAbandon) out.push(null, droneAbandon);
    // OfferAbandonWreck (a wreck the pilot has the loot right to, not abandoned) / OfferAbandonCargo (a cargo container
    // the pilot has the loot right to): the one, and all of its group nearby (read through gridcheck on the client's own
    // wreck: ... Mark Wreck as Viewed | Abandon Wreck, Abandon All Nearby Wrecks)
    if ((e.kind === "wreck" || e.groupID === 12) && this.actions.abandonLoot && lootRightOf(e) && !(e.kind === "wreck" && abandonedOf(e))) {
      const wreck = e.kind === "wreck";
      out.push(null,
        { path: wreck ? "UI/Inflight/AbandonWreack" : "UI/Inflight/AbandonCargo", label: word(wreck ? "UI/Inflight/AbandonWreack" : "UI/Inflight/AbandonCargo", wreck ? "Abandon Wreck" : "Abandon Cargo"), run: () => this.actions.abandonLoot?.(id, false) },
        { path: wreck ? "UI/Inflight/AbandonAllWrecks" : "UI/Inflight/AbandonAllCargo", label: word(wreck ? "UI/Inflight/AbandonAllWrecks" : "UI/Inflight/AbandonAllCargo", wreck ? "Abandon All Nearby Wrecks" : "Abandon All Nearby Cargo"), run: () => this.actions.abandonLoot?.(id, true) });
    }
    // _CelestialMenu: menuEntries += [None], then CancelLockTarget (targetSvc.CancelAddTarget) while the lock is being made
    if (lockingNow) out.push(null, { path: "UI/Inflight/CancelLockTarget", label: word("UI/Inflight/CancelLockTarget", "Cancel Locking Attempt"), run: run("Cancel Locking Attempt", () => this.actions.unlock(id)) });
    // an empty group draws no line: no two lines together, none first or last
    return out.filter((x, i, all) => x !== null || (i > 0 && i < all.length - 1 && all[i - 1] !== null));
  }

  /**
   * LocationArrivalIndicationService.check_indicate_arrival on the warp's end: the thing warped to, else the nearest
   * asteroid belt within 100 km of its surface (get_closest_location_slim_item); a belt, planet, station or solar
   * system shows its banner (locationBanner.ts).
   */
  private async indicateArrival(snap: Snapshot, itemID: number | null): Promise<void> {
    if (await this.indicateArrivalDungeon(snap)) return;
    let e = itemID === null ? null : snap.entities.find((x) => x.itemID === itemID) ?? null;
    if (!e) e = snap.entities.find((x) => x.groupID === 9 && this.distanceTo(x) <= 100_000) ?? null;
    if (!e || ![9, 7, 15, 5].includes(e.groupID ?? -1)) return;
    const word = (label: string, args?: Readonly<Record<string, string | number>>) => this.actions.word?.(label, args) ?? null;
    let text: { text: string; colored?: { from: number; to: number; color: string } } | null = null;
    if (e.groupID === 9) {
      // indicate_arrived_at_asteroid_belt: get_depletion_status_for_belt - the harvestable things here by type (asteroids,
      // harvestable clouds) against the belt's original counts - and get_formatted_depletion_status_text
      const original = await beltOriginalCounts(e.itemID);
      const now = new Map<number, number>();
      for (const x of this.snapshot?.entities ?? snap.entities) {
        if ((x.categoryID === 25 || x.groupID === 711) && x.typeID != null) now.set(x.typeID, (now.get(x.typeID) ?? 0) + 1);
      }
      const status = original ? depletionStatus(now, original) : null;
      const [label, own] = status === null ? [null, "None"] : DEPLETION_LABELS[status];
      const statusText = label ? word(label) ?? own : own;
      const full = word(DEPLETION_FORMATTED_LABEL, { color: "", status: statusText }) ?? `Depletion Status: ${statusText}`;
      const at = full.lastIndexOf(statusText);
      text = { text: full, colored: at < 0 ? undefined : { from: at, to: at + statusText.length, color: status === null ? "#fff" : DEPLETION_COLORS[status] } };
    } else if (e.groupID === 7) {
      const label = PLANET_TYPE_LABELS[e.typeID ?? -1];
      const t = label ? word(label) : null;
      text = t ? { text: t } : null;
    }
    const [title, caption] = locationNameParts(this.nameOf(e));
    this.locationBanner.show(title, caption, text);
  }

  /**
   * _indicate_arrival_dungeon: in a dungeon that is one of the system's anomalies, the system's name over the site's
   * (the title the system's name, the caption the site's), an ore site's (a resource-harvesting archetype's) text its
   * depletion status against the dungeon room's original asteroids (get_depletion_status_for_dungeon), shown 8 s.
   */
  private async indicateArrivalDungeon(snap: Snapshot): Promise<boolean> {
    const site = await this.actions.arrivalDungeonSite?.().catch(() => null);
    if (!site) return false;
    const word = (label: string, args?: Readonly<Record<string, string | number>>) => this.actions.word?.(label, args) ?? null;
    let text: { text: string; colored?: { from: number; to: number; color: string } } | null = null;
    if (site.archetypeID !== null && RESOURCE_HARVESTING_ARCHETYPES.has(site.archetypeID)) {
      const original = await dungeonOriginalCounts(site.dungeonID, site.roomID);
      if (original) {
        const now = new Map<number, number>();
        for (const x of this.snapshot?.entities ?? snap.entities) {
          if ((x.categoryID === 25 || x.groupID === 711) && x.typeID != null) now.set(x.typeID, (now.get(x.typeID) ?? 0) + 1);
        }
        const status = depletionStatus(now, original);
        const [label, own] = DEPLETION_LABELS[status];
        const statusText = word(label) ?? own;
        const full = word(DEPLETION_FORMATTED_LABEL, { color: "", status: statusText }) ?? `Depletion Status: ${statusText}`;
        const at = full.lastIndexOf(statusText);
        text = { text: full, colored: at < 0 ? undefined : { from: at, to: at + statusText.length, color: DEPLETION_COLORS[status] } };
      }
    }
    this.locationBanner.show(site.systemName, site.name, text, 8000);
    return true;
  }

  /**
   * TargetInBar.OnDroneStateChange2: the active ship's drones in combat, engage, mining or salvaging whose drone state
   * targets this one (michelle.GetDroneState: one's own), counted by type - UpdateDroneHint's DroneHintLine "<type>:
   * <count>" each, joined under DroneHintLabel ("Drones").
   */
  private targetDrones(targetID: number): { hint: string } | null {
    const shipID = this.snapshot?.ship?.itemID ?? null;
    if (shipID === null) return null;
    const byType = new Map<number, number>();
    for (const x of this.snapshot?.entities ?? []) {
      const d = x as Entity & { controllerID?: number | null; droneActivity?: string | null; targetEntityID?: number | null };
      if (d.controllerID !== shipID || d.targetEntityID !== targetID || x.typeID == null) continue;
      if (!["fighting", "repairing", "mining", "salvaging"].includes(d.droneActivity ?? "")) continue;
      byType.set(x.typeID, (byType.get(x.typeID) ?? 0) + 1);
    }
    if (byType.size === 0) return null;
    const lines = [...byType].map(([typeID, n]) => `${this.names?.types[String(typeID)]?.[0] ?? typeID}: ${n}`).join("\n");
    const MARK = "@@droneHintLines@@";
    const head = this.actions.word?.("UI/Inflight/Target/DroneHintLabel", { droneHintLines: MARK }) ?? `Drones\n${MARK}`;
    return { hint: head.includes(MARK) ? head.replace(MARK, lines) : `Drones\n${lines}` };
  }

  /** The page's own eject (no CapsuleEjected warning follows it). */
  noteEject(): void { this.ejectNotedAt = performance.now(); }

  private flashCapsuleEjected(): void {
    const text = this.actions.word?.("UI/Inflight/CapsuleEjected") ?? "Capsule Ejected";
    this.alertLabel.textContent = text;
    // CENTERBOTTOM over the HUD (TOBOTTOM, top 100): the label's box 100 px above the HUD's top edge
    const hud = this.shipHud.root.getBoundingClientRect(), view = this.root.getBoundingClientRect();
    const hudTop = hud.height > 0 ? hud.top - view.top : view.height - 200;
    this.alertLabel.style.top = `${Math.round(hudTop - 100 - 40)}px`;
    this.alertLabel.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 2000, fill: "forwards" });
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
    const self = snap?.entities.find((x) => x.isSelf) ?? null;
    routeNext = this.actions.routeNext?.() ?? routeNext;
    npcStandingOf = this.actions.npcStanding ?? null;
    viewedWrecksFor(self?.characterID ?? null);
    attackingMe = new Set(this.attackers.keys());
    lootWho = { characterID: self?.characterID ?? null, corporationID: self?.corporationID ?? null, fleetID: this.actions.fleetID?.() ?? null };
    // tactical.ProcessSessionChange: a new ship ('shipid' in the change) clears every attacker
    const shipNow = snap?.ship?.itemID ?? null;
    if (shipNow !== this.attackersShipID) {
      // ShipAlertController.OnSessionChanged: a new ship that is a capsule (not by an eject or a stored vessel, not in
      // a structure) - on_entering_capsule: ShipAlertContainer.OnEnteringCapsule, UI/Inflight/CapsuleEjected in red,
      // its opacity 1 to 0 over 2 s
      if (this.attackersShipID !== null && shipNow !== null && snap?.ship?.groupID === 29 && performance.now() - this.ejectNotedAt > 15_000) this.flashCapsuleEjected();
      this.attackers.clear();
      this.attackersShipID = shipNow;
    }
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
    // the park's ball has no warp target of its own; the session's flight read says what the warp is to (as the
    // action indication's warp line takes it)
    if (inMiningWarp) {
      this.warpToItemID = (ego as { warp?: { destinationID: number | null } | null } | null)?.warp?.destinationID
        ?? this.options.flightSnapshot?.()?.ship?.warp?.destinationID ?? this.warpToItemID;
    }
    else if (this.miningInWarp && snap) { const id = this.warpToItemID; this.warpToItemID = null; void this.indicateArrival(snap, id); }
    if (gridReset) this.locationBanner.clear();
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
    // a new system: the space menu's reads primed (the bookmarks, the journal, the anomalies), as the client's services hold
    // them before any menu - so a first CmdGetLocationMenuForNavigation finds the bookmarks there
    if (systemID !== null && systemID !== this.primedSystem) {
      this.primedSystem = systemID;
      this.sweep = null;
      this.sweepDue = { at: performance.now() };
      this.actions.locationsMenu?.();
      this.actions.missionsMenu?.();
      this.actions.anomalies?.();
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
    // the relationships the presets' state filters and the state flags (stateSvc.GetIconAndBackgroundFlags) are read from
    const relations = this.options.overviewRelationships?.(snap?.entities ?? []);
    this.lastRelations = relations;
    const misc = overviewMisc();
    if (this.frameCount % 60 === 30) this.updateDamageDealers();
    const inRangeNow = this.inRangeDue;
    this.inRangeDue = false;
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
          el.dataset.wanted = "0";
        }
        continue;
      }
      const hackingState = e.hackingSecurityState?.toString() ?? "";
      if (!el) {
        el = document.createElement("div");
        el.className = "bracket";
        // AsteroidBracket.update_icon_visibility: an asteroid's icon only while it is selected
        if ((e as Entity & { categoryID?: number | null }).categoryID === 25) el.classList.add("asteroid");
        // InSpaceBracket's indicators: Hilite's selectionCircle, TargetedIndicator (outerCircle and the four TargetLines
        // across the screen; its targetingArrows while locking) and ActiveTargetIndicator (the turning spinCorners and
        // selectedTargetedItem), shown by the bracket's classes
        const drawn = glyph(e);
        el.dataset.glyph = drawn;
        el.innerHTML = `${drawn}<div class="label"></div><div class="t-ind"><span class="t-hilite"></span><span class="t-circle"></span>
          <span class="t-line t-top"></span><span class="t-line t-left"></span><span class="t-line t-right"></span><span class="t-line t-bottom"></span>
          <span class="t-hit"></span><span class="t-aggress"></span><span class="t-cantarget"></span><span class="t-locking"></span><span class="t-timer"></span><span class="t-lock-text"></span><span class="t-active-spin"></span><span class="t-active-circle"></span></div>`;
        el.dataset.hackingState = hackingState;
        const id = e.itemID;
        el.dataset.id = String(id);
        // InSpaceBracket.OnClick: PlaySound(SOUND_ENTRY_SELECT), then the selection
        el.addEventListener("click", (ev) => { ev.stopPropagation(); void playUiEvent("msg_ListEntryClick_play"); this.select(id); });
        el.addEventListener("dblclick", (ev) => { ev.stopPropagation(); this.activateSpaceTarget(id); });
        // InSpaceBracket.OnMouseEnter / OnMouseExit: stateSvc's mouseOver, which lights the overview row as well
        // (OnMouseEnter: not with the left button down; PlaySound(SOUND_ENTRY_HOVER) and the mouseOver state)
        el.addEventListener("mouseenter", (ev) => { if (ev.buttons & 1) return; void playUiEvent("ui_button_soft2_play"); this.setHovered(id); this.overlapEntered(id); });
        el.addEventListener("mouseleave", () => { if (this.hoveredID === id) this.setHovered(null); this.overlapLeft(); });
        el.classList.toggle("hovered", this.hoveredID === id);
        el.classList.toggle("locked", this.locked.has(id));
        el.classList.toggle("targeting-me", this.targeters.has(id));
        el.classList.toggle("attacking-me", this.attackers.has(id));
        el.classList.toggle("fleet-member", this.isFleetMemberShip(id));
        el.classList.toggle("selected", this.selected === id);
        this.brackets.appendChild(el);
        this.bracketEls.set(e.itemID, el);
      } else {
        // the glyph drawn again when it changes: the hacking state, or GetIconColor's colour (a can's loot right, the
        // route's gate or station)
        const drawn = glyph(e);
        if (el.dataset.glyph !== drawn) { el.firstElementChild!.outerHTML = drawn; el.dataset.glyph = drawn; }
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
      el.dataset.wanted = "1";
      const p = rel.clone().project(this.camera);
      const onScreen = p.z < 1 && Math.abs(p.x) <= 1.05 && Math.abs(p.y) <= 1.05;
      el.style.display = onScreen ? "" : "none";
      if (onScreen) {
        el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`;
        el.classList.toggle("locked", this.locked.has(e.itemID));
        el.classList.toggle("locking", (this.lockingIDs.has(e.itemID) || this.acquiringTargets.has(e.itemID)) && !this.locked.has(e.itemID));
        if (!el.classList.contains("locking")) el.classList.remove("lock-done");
        el.classList.toggle("active-target", this.activeTarget === e.itemID && this.locked.has(e.itemID));
        if (this.selected === e.itemID || el.classList.contains("mining-selected")) this.updateMiningBracket(el, e, survey);
        if (this.frameCount % 10 === 0 || highlighted || el.classList.contains("selected") || this.hoveredID === e.itemID) {
          this.drawBracketLabel(el.querySelector<HTMLElement>(".label")!, e);
        }
        if (this.frameCount % 10 === 0) { this.updateBracketFlags(el, e, groupID, relations); this.updateBracketBroadcast(el, e.itemID); }
        // bracketMgr.ShowInTargetRange, about once a second: ships, NPCs, drones and fighters within the ship's
        // maxTargetRange show canTarget2 (40 px at 0.15), each category as the Misc panel allows
        if (this.frameCount % 60 === 0 || inRangeNow) {
          const range = this.actions.shipAttribute?.(76) ?? null;
          const category = (e as Entity & { categoryID?: number | null }).categoryID ?? null;
          const dist = this.distanceTo(e);
          const marked = !e.isSelf && range !== null && [6, 11, 18, 87].includes(category ?? -1) && inRangeShown(category, misc) && dist <= range;
          el.classList.toggle("in-range", marked);
          // brighterForRange: within the hovered module's range as well as the targeting range (opacity 1)
          el.classList.toggle("in-module-range", marked && this.moduleRange !== null && dist <= this.moduleRange);
        }
      }
    }
    this.updateMiningHold(survey, ego, w, h);
    for (const [id, el] of this.bracketEls) if (!seen.has(id)) { el.remove(); this.bracketEls.delete(id); }
    this.drawSensorOverlay(origin, w, h);
    this.drawTactical(w, h);
    this.drawMoveCommand(w, h);
    for (const id of this.polarization.keys()) if (!seen.has(id)) this.polarization.delete(id);
    for (const [id, panel] of this.jumpBridgePanels) {
      if (seen.has(id)) continue;
      panel.destroy();
      panel.host.remove();
      this.jumpBridgePanels.delete(id);
    }
    if (snap) for (const o of [this.overview, ...this.extraOverviews]) o.update(snap.entities, (x) => this.distanceTo(x), relations, snap.ship);
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
    // ShipAlertController.OnCapacitorChange hears CapacitorCore.Update's ScatterEvent: the HUD's own charge on its 500 ms pump
    const alertCap = this.shipHud instanceof NewShipHud ? (this.shipHud.capacitorShown ?? cap) : cap;
    this.updateShipAlerts(ego, alertCap, performance.now());
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
        shipID: ego.itemID,
        // the racks' heat (the ship's heatLow / heatMed / heatHi over their capacities, as the BFF's dogma reckons
        // them: the app's space snapshot, not this view's park)
        ...(() => { const h = this.options.rack?.heat?.(); return { heatLow: h?.low, heatMed: h?.mid, heatHi: h?.high }; })(),
      });
      if (this.shipHud instanceof NewShipHud) {
        this.shipHud.setSafetyLevel(this.actions.safetyLevel?.() ?? null);
        // the cargo indicator's holds, as the mining read keeps them: read once for each ship flown (the client's
        // HoldTracker reads the ship's holds as it loads), then kept by the item notices
        if (this.holdsReadFor !== ego.itemID) {
          this.holdsReadFor = ego.itemID;
          void this.actions.loadShipHolds?.();
        }
        // the mining read's holds, and the ship's other bays from its bays read (the tracker holds every one)
        const mined = (this.options.miningSurvey?.()?.holds ?? []).filter((h) => h.present);
        const bays = (this.actions.shipBays?.(ego.itemID) ?? []).filter((b) => !mined.some((h) => h.key === b.key));
        const holds = [...mined, ...bays.map((b) => ({ key: b.key, label: b.key, present: true, capacity: { used: b.used ?? 0, capacity: b.capacity ?? 0 } }))];
        // the cargo indicator names each hold as the client does (invControllers.GetNameForFlag: "Mining Hold", "Cargo Hold")
        const holdWords = this.options.indicationWords?.() ?? {};
        const holdName = (key: string, own: string) => {
          const hold = key === CARGO_HOLD.bayKey ? CARGO_HOLD : SHIP_HOLDS.find((x) => x.bayKey === key);
          const t = hold ? holdWords[hold.label] : null;
          return typeof t === "string" && t !== "" ? plainText(t) : own;
        };
        this.shipHud.setHolds(holds.map((h) => ({ key: h.key, label: holdName(h.key, h.label), used: h.capacity?.used ?? null, capacity: h.capacity?.capacity ?? null })), ego.typeID);
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
      if (this.shipHud instanceof NewShipHud && rack.groupAll) this.shipHud.setGroupAll(rack.groupAll());
      if (this.shipHud instanceof NewShipHud && rack.setGroupAll && !this.shipHud.onGroupAll) {
        const group = rack.setGroupAll;
        this.shipHud.onGroupAll = (link) => void this.act(link ? "Group all weapons" : "Ungroup all weapons", () => group(link));
      }
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
    const rackModules = this.locked.size ? this.options.rack?.modules() ?? [] : [];
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
        // (SetTargetLabel's shipLabel: a ship whose slim item has a corporation, its type's name under the name)
        typeName: e.categoryID === 6 && e.corporationID && e.typeID !== null ? this.names?.types[String(e.typeID)]?.[0] ?? null : null,
        // SetStandingIcon (stateSvc.CheckStates(slim, 'flag')) and, for an NPC entity (category 11), SetBracketIcon
        flagHtml: (() => { const f = iconAndBackgroundFlags(e, this.overview.groupOf(e), this.lastRelations).icon; return f ? flagMarkup(f).replace(/ title="[^"]*"/, "") : null; })(),
        bracket: e.categoryID === 11 ? (() => { const url = bracketIcon(e); return url ? { url, colour: iconLook(e).colour } : null; })() : null,
        shieldRatio: e.shieldRatio ?? null, armorRatio: e.armorRatio ?? null, hullRatio: e.hullRatio ?? null,
        // (has_damage_bar: none on an asteroid, a fighter, a harvestable cloud, an orbital target)
        noDamageBar: e.categoryID === 25 || e.categoryID === 87 || e.groupID === 711 || e.groupID === 1198,
        locking: false, active: id === this.activeTarget, mining,
        weapons: rackModules.filter((m) => m.active && m.targetID === id).map((m) => ({ itemID: m.itemID, typeID: m.typeID })),
        drones: this.targetDrones(id),
      });
    }
    const pending = this.lockingIDs.size ? new Map([...this.acquiringTargets, ...this.lockingIDs]) : this.acquiringTargets;
    const shipID = this.snapshot?.ship?.itemID;
    const scanResolution = pending.size && shipID != null ? this.options.targeting?.scanResolution(shipID) ?? null : null;
    const bracketLockedText = pending.size ? this.actions.word?.(TARGET_LOCKED_LABEL) ?? "Locked" : "Locked";
    for (const [id, startedAt] of pending) {
      if (this.locked.has(id)) continue;
      const e = byID.get(id);
      this.bracketCountdown(id, this.lockTimeFor(e, scanResolution), startedAt, bracketLockedText);
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
