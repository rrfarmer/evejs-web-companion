// Which hangar the client docks a ship in (eve/client/script/ui/view/hangarRegistry.py GetHangarType and
// GetHangarModelGraphicID): Jita IV - Moon 4 - Caldari Navy Assembly Plant has its own; an NPC station's is its race's
// (evetypes.GetRaceID of the station's type), Minmatar for any other race. The modular hangars (Upwell structures,
// capital ships, the AIR and Deathless stations) place the ship by other behaviours and are not drawn here yet: null.

/** invC.stationJitaIV4. */
const STATION_JITA_IV_4 = 60003760;
/** JITA_4_4_NORMAL_HANGAR_SIZE.hangarModelGraphicID. */
const JITA_4_4 = 24525;
/** const.raceAmarr / raceCaldari / raceGallente / raceMinmatar -> *_NORMAL_HANGAR_SIZE.hangarModelGraphicID. */
const BY_RACE: Record<number, number> = { 4: 24407, 1: 24408, 8: 24409, 2: 24410 };
const MINMATAR = 24410;
/** const.categoryStructure. */
const CATEGORY_STRUCTURE = 65;

export interface HangarTypeFacts {
  /** The station type's raceID (evetypes.GetRaceID). */
  raceID: number | null;
  /** The station type's categoryID. */
  categoryID: number | null;
}

/**
 * dockCameraSettings: the docking swings a hangar picks from at random by weight, each [weight, yaw0, yaw1, pitch0,
 * pitch1, zoom0, zoom1, fov] (hangarView._ConfigureCameraDockingAnimation -> HangarCamera.SetHangarAnimationParameters).
 * Read from the compiled hangarRegistry.pyc in the client's own Python: the decompiled source prints the constants'
 * places (8, 9, 10...) instead of their values.
 */
export type DockSwing = readonly [number, number, number, number, number, number, number, number];
const DEFAULT_SWINGS: readonly DockSwing[] = [[1, 5.5, 3.534, 1.375, 1.634, 1.2, 2.0, 0.7]];
const JITA_4_4_SWINGS: readonly DockSwing[] = [
  [4, -0.1, -1.23, 1.466, 1.55, 1.2, 4.0, 0.7], [4, 0.05, -2.5, 1.496, 1.57, 1.2, 3.0, 0.7],
  [4, -6.2, -3.6, 1.5, 1.24, 1.2, 2.0, 0.7], [4, 0.05, 1.17, 1.55, 1.4, 1.2, 2.0, 0.7],
  [4, 1.0, 0.16, 1.52, 1.6, 1.2, 3.0, 0.8], [3, 2.55, 3.542, 1.5, 1.0, 1.2, 3.0, 0.7],
  [3, 4.0, 3.142, 1.4, 0.1, 3.0, 15.0, 0.6], [1, 1.0, 0.0, 1.2, 1.633, 3.0, 15.0, 0.7],
];

/** _pickRandomAnim: one swing, chosen with a chance of its weight in the whole. */
export function pickDockSwing(swings: readonly DockSwing[], random = Math.random): DockSwing {
  const total = swings.reduce((n, s) => n + s[0], 0);
  let r = Math.floor(random() * total);
  for (const s of swings) { if (r < s[0]) return s; r -= s[0]; }
  return swings[swings.length - 1]!;
}

/**
 * *_NORMAL_HANGAR_SIZE.hangarType (GetHangarIdentifier: the hangar VFX's HangarType, its drones' race of hover drone):
 * Amarr 1, Caldari 2, Gallente 3, Minmatar 4; Jita 4-4's has none (DEFAULT_HANGAR_DICTIONARY's 0).
 */
const TYPE_BY_MODEL: Record<number, number> = { 24407: 1, 24408: 2, 24409: 3, 24410: 4, 24525: 0 };

/** *_NORMAL_HANGAR_SIZE.sceneGraphicID, by the same choice: the hangar's EveSpaceScene (its light and reflections). */
const SCENE_BY_MODEL: Record<number, number> = { 24407: 20273, 24408: 20271, 24409: 20274, 24410: 20272, 24525: 24526 };

/** The hangar's model and scene graphics for a station, or null where it is one of the hangars not drawn here. */
export function hangarGraphics(stationID: number | null, station: HangarTypeFacts): { model: number; scene: number; swings: readonly DockSwing[]; hangarType: number } | null {
  let model: number;
  if (stationID === STATION_JITA_IV_4) model = JITA_4_4;
  else if (station.categoryID === CATEGORY_STRUCTURE) return null;
  else model = (station.raceID !== null ? BY_RACE[station.raceID] : undefined) ?? MINMATAR;
  return { model, scene: SCENE_BY_MODEL[model]!, swings: model === JITA_4_4 ? JITA_4_4_SWINGS : DEFAULT_SWINGS, hangarType: TYPE_BY_MODEL[model] ?? 0 };
}

/** DefaultHangarShipBehaviour.SHIP_FLOATING_HEIGHT: where the ship floats in a hangar without an anchor point. */
export const SHIP_FLOATING_HEIGHT = 360;
