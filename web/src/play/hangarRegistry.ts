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

/** *_NORMAL_HANGAR_SIZE.sceneGraphicID, by the same choice: the hangar's EveSpaceScene (its light and reflections). */
const SCENE_BY_MODEL: Record<number, number> = { 24407: 20273, 24408: 20271, 24409: 20274, 24410: 20272, 24525: 24526 };

/** The hangar's model and scene graphics for a station, or null where it is one of the hangars not drawn here. */
export function hangarGraphics(stationID: number | null, station: HangarTypeFacts): { model: number; scene: number } | null {
  let model: number;
  if (stationID === STATION_JITA_IV_4) model = JITA_4_4;
  else if (station.categoryID === CATEGORY_STRUCTURE) return null;
  else model = (station.raceID !== null ? BY_RACE[station.raceID] : undefined) ?? MINMATAR;
  return { model, scene: SCENE_BY_MODEL[model]! };
}

/** DefaultHangarShipBehaviour.SHIP_FLOATING_HEIGHT: where the ship floats in a hangar without an anchor point. */
export const SHIP_FLOATING_HEIGHT = 360;
