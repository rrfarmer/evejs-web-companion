// A drone's turret, as the client fits one (eve/client/script/environment/spaceObject/Drone.py FitHardpoints, with
// eveSpaceObject/__init__.py's tables): the drone's group gives its graphics group (droneGroupFromTypeGroup); that
// gives a pair (droneTurretGfxID): a turret graphic by the drone graphic's race, and one for any other; a few types
// have their own (droneTypeGroup: the mining and ice-mining drones). The graphic IDs' files are the SDE's graphics.

/** inventorycommon/const.py group IDs -> eveSpaceObject gfxDroneGroup* (1 fighter-bomber, 2 combat, 4 mining, 5 NPC, 6 salvager). */
const DRONE_GROUP_OF_GROUP = new Map([
  [101, 4], [1159, 6],
  // combat: combat, EWAR, web, unanchoring, repair, scrambling, cap drain, logistic drones, support fighters
  ...[100, 639, 641, 470, 299, 545, 544, 640, 1537].map((g) => [g, 2]),
  // NPC: LCO, rogue, asteroid and deadspace rogue drones, their commanders, mission drones, abyssal, horde-mode entities
  ...[279, 287, 755, 756, 757, 758, 759, 760, 761, 1174, 801, 802, 803, 804, 805, 806, 847, 846, 845, 843, 861, 337, 1997, 5032].map((g) => [g, 5]),
]);
/** droneTurretGfxID_combat, by gfxRace. */
const COMBAT_BY_RACE = { amarr: 11504, gallente: 11506, caldari: 11505, minmatar: 11508, jove: 21058 };
/** droneTurretGfxID_fighterbomber, by gfxRace. */
const BOMBER_BY_RACE = { amarr: 11515, gallente: 11517, caldari: 11516, minmatar: 11518, sansha: 20339 };
/** droneTurretGfxID: per graphics group, (by race, else). */
const TURRET_OF_DRONE_GROUP = { 1: [BOMBER_BY_RACE, 11507], 2: [COMBAT_BY_RACE, 11507], 4: [null, 11521], 5: [COMBAT_BY_RACE, 11507], 6: [null, 20925] };
/** droneTypeGroup: the types with their own turret (11521 mining, 25189 ice mining). */
const TURRET_OF_TYPE = new Map([[3701, 25189], [43694, 11521], [43681, 25189], [41030, 11521], [1202, 11521], [3218, 11521], [43699, 25189], [43700, 25189], [10252, 11521], [10248, 11521], [10246, 11521], [10250, 11521]]);
/** The SDE's graphicFile of each of those graphics. */
const GRAPHIC_FILE = {
  11504: "res:/dx9/model/turret/Drone/CombatDrone_Amarr_T1.red",
  11505: "res:/dx9/model/turret/Drone/CombatDrone_Caldari_T1.red",
  11506: "res:/dx9/model/turret/Drone/CombatDrone_Gallente_T1.red",
  11507: "res:/dx9/model/turret/Drone/CombatDrone_Generic_T1.red",
  11508: "res:/dx9/model/turret/Drone/CombatDrone_Minmatar_T1.red",
  11521: "res:/dx9/model/turret/Drone/MiningDrone_T1.red",
  20925: "res:/dx9/model/turret/drone/salvagedrone_t1.red",
  21058: "res:/dx9/model/turret/jove/l/jove_l_t1.red",
  25189: "res:/dx9/model/turret/Drone/IceMiningDrone_T1.red",
};

/**
 * The turret graphic the client fits on a drone of this type, group and graphic race, or null for a drone it fits
 * none on (a utility drone, a group it does not know) or a graphic whose file is not known here.
 */
export function droneTurret(typeID, groupID, race) {
  const droneGroup = DRONE_GROUP_OF_GROUP.get(Number(groupID));
  if (droneGroup === undefined) return null;
  const pair = TURRET_OF_DRONE_GROUP[droneGroup];
  if (!pair) return null;
  let graphicID = pair[1];
  if (TURRET_OF_TYPE.has(Number(typeID))) graphicID = TURRET_OF_TYPE.get(Number(typeID));
  else if (pair[0] && race) graphicID = pair[0][String(race).toLowerCase()] ?? pair[1];
  const graphicFile = GRAPHIC_FILE[graphicID];
  return graphicFile ? { graphicID, graphicFile } : null;
}
