// What a plugin's bot block is built from: the same small pieces core's own
// blocks use (nav/scriptMacros.ts and its neighbours). A block decides one
// tick at a time from what the bot sees, and returns one action of core's;
// these say "wait", "acting", "done", read and write a block's memory, measure
// distances, judge a warp landed, and fly home.
//
// Pure functions only: a block runs in the page and in its plugin's own
// process alike (src/pluginHost.js), so it may use no DOM and no Node API.

export {
  ACTING,
  LOOT_RANGE_M,
  MAX_BLOCK_ATTEMPTS,
  WAIT,
  boardParkedShip,
  flag,
  nearest,
  num,
  recallBeforeLeaving,
  scriptTravelHome,
  tick,
  warpIssuedMem,
  warpLanded,
  without,
  type ParkedShipChoice,
} from "../nav/scriptMacros.ts";
export {
  STALL_REORDER_WHY,
  STALL_STUCK_REASON,
  STALL_STUCK_WHY,
  STALL_UNSTICK_WHY,
  clearCloseInStall,
  closeInStall,
} from "../nav/closeInStall.ts";
export { measureSpace, type SpaceMeasurement } from "../nav/autopilotLoop.ts";
export { holdsFreeM3 } from "../nav/miningBotLoop.ts";
export { isUnreachable, pilotCannotPay, shipHasNoRoom, shouldSetAside } from "../nav/refusalLedger.ts";
export { dockedAt } from "../nav/dockableLocation.ts";
export { distanceMeters } from "../space/overview.ts";
export type { SpaceEntity, SpaceSnapshot } from "../store/types.ts";
