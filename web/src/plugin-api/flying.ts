// What a plugin's own loop flies a pilot with: the pure reads, decoders and rules
// core's own bots are made of, beside the calls on `flow.flying` (docs/plugins.md,
// "Flying a pilot"). A block decides one tick at a time and needs far less: see
// ./blocks.ts.
//
// A module of its own, because a plugin that flies nothing has no use for any of it.
//
// Everything here runs in the page and in a plugin's own process alike: no DOM and
// no Node API.

// --- Asking the server, as a pilot's session (`flow.requestOptions()`) --------
export {
  boundDogma,
  fetchTypeDogma,
  getDrones,
  getFlightStatus,
  getShipBays,
  getSpaceSnapshot,
  getTargets,
  loadBoundFleet,
  loadCorpHangar,
  loadFitting,
  loadInventory,
  readChat,
  readEmptiedContainers,
  sendChat,
  type FlightStepResult,
} from "../app/api.ts";
export {
  isSessionLost,
  errorWords,
  type FittedDefenseModules,
  type PilotFlying,
  type RemoteRepModuleIDs,
  type ShipHold,
} from "../app/flow.ts";
export type { Ask } from "../bridge/ask.ts";

// --- What the server's answers mean -------------------------------------------
export { decodeChatChannel } from "../bridge/chat.ts";
export { defense } from "../bridge/dogma/defense.ts";
export { decodeDroneBay, decodeDroneLimits } from "../bridge/drones.ts";
export { isSlotFlag, buildSlots, decodeChargeFits, slotFlagOf } from "../bridge/fitting.ts";
export {
  FLEET_BROADCAST_SCOPE_ALL,
  FLEET_BROADCAST_TTL_MS,
  isFleetBroadcastFresh,
  type FleetBroadcastName,
} from "../bridge/fleetBroadcasts.ts";
export {
  authoritativeFleetMemberCharacterIDs,
  decodeFleetCenter,
  fleetCommanderCharacterIDs,
  fleetCommanderWhereabouts,
  type FleetCenterSnapshot,
} from "../bridge/fleetCenter.ts";
export { canBroadcastInFleet, canTagInFleet } from "../bridge/fleetCommand.ts";
export { decodeFlightStatus } from "../bridge/flight.ts";
export { decodeContainer, decodeInventoryRows } from "../bridge/inventoryShip.ts";
export { scrammedByWarpScrambler, tacklersHolding } from "../bridge/jamNotifications.ts";
export { isTransitionTimeout, isTransportTransient, panelErrorWords } from "../bridge/refusals.ts";
export { repairTargets } from "../bridge/repairQuotes.ts";
export { decodeShipBays } from "../bridge/shipBays.ts";
export { known } from "../bridge/shipStats.ts";
export { decodeSpaceSnapshot, decodeTargetIDs, isSceneBlind } from "../bridge/space.ts";

// --- Doing things: each takes `flow.flying.bridgeDo` ------------------------
export { returnDronesToBay, salvageWithDrones } from "../bridge/boundEntityWrites.ts";
export { applyFitting } from "../bridge/fitModule.ts";
export { acceptFleetInvite, leaveFleet, tagFleetTarget } from "../bridge/fleetWrites.ts";
export { moveItems, officeAt } from "../bridge/inventoryWrites.ts";
export { warpToFleetMember } from "../bridge/movementWrites.ts";
export { undock } from "../bridge/placeChanges.ts";
export { repairItemsAtShop } from "../bridge/repairShop.ts";
export { lockTarget } from "../bridge/targetWrites.ts";

// --- The rules core's bots fly by ---------------------------------------------
export {
  APPROACH_SETTLE_MS,
  AUTOPILOT_WARP_STOPS_SHORT_M,
  MAX_STARGATE_JUMPING_DISTANCE_M,
  STATION_DOCKING_RADIUS_M,
  WARP_EXIT_VARIANCE_M,
  decideCloseIn,
  measureSpace,
  type AutopilotProgress,
  type SpaceMeasurement,
} from "../nav/autopilotLoop.ts";
export {
  evaluateRequirements,
  fromNullableBoolean,
  holdsTheShip,
  type BotRequirement,
  type PluginShipOwner,
  type ShipControllerID,
} from "../nav/botRegistry.ts";
export { combatFit } from "../nav/combatFit.ts";
export {
  MAX_CLOSE_TICKS,
  REACH_HYSTERESIS_M,
  holdNeedsReissue,
  inReach,
  ratReachM,
  wantedHold,
  type HeldOrder,
  type Hold,
  type HoldInputs,
  type HoldReason,
  type RatCombatFacts,
  type WeaponReach,
} from "../nav/combatPosition.ts";
export {
  combatUtilityFit,
  type CombatUtilities,
  type CombatUtility,
  type UtilityFamily,
} from "../nav/combatUtilities.ts";
export { AUTOMATIC_UTILITY_FAMILIES, automaticCombatUtility } from "../nav/combatUtilityPolicy.ts";
export type { CombatWeapon, CombatWeapons } from "../nav/combatWeapons.ts";
export { droneStackSizes, wholeStackLaunch } from "../nav/droneLaunch.ts";
export { splitDroneRoles, type DroneRoleIDs } from "../nav/droneRoles.ts";
export { MAX_DRONE_ROTATIONS } from "../nav/droneRotation.ts";
export {
  EMPTY_JOIN_MEMORY,
  decideFleetJoin,
  type FleetFinderRead,
  type FleetJoinMemory,
  type FleetJoinVerdict,
} from "../nav/fleetJoinWatch.ts";
export { RANGE_HYSTERESIS_M, type BandThreat } from "../nav/kiteBand.ts";
export { lowestHealth } from "../nav/miningBotLoop.ts";
export { isNotActivatableRefusal, type ModuleActivation } from "../nav/moduleActivation.ts";
export {
  decidePropulsionModule,
  type PropulsionInputs,
  type PropulsionModule,
} from "../nav/propulsion.ts";
export type { FleetApplication } from "../nav/scriptConditions.ts";
export { REPAIR_CAP_FLOOR } from "../nav/scriptDecide.ts";
export { fleetTagRank, pickPrimary } from "../nav/targetPriority.ts";
export { canMyShipOrderDrone, hostileRows, isHostile, isTargetedByPlayer } from "../space/overview.ts";
export type { ClientStore } from "../store/clientStore.ts";
export { nameKey, resolvedName, type NameRef } from "../store/names.ts";
export type { ChatMessage, SpaceVector } from "../store/types.ts";

// --- Saying what a run risks --------------------------------------------------
export type { MacroID } from "../bots/botScript.ts";
export { BOT_RISK_CLASSES, type BotRunPolicy } from "../bots/runPolicy.ts";
