import { unwrapBool, unwrapReal, type JsonValue } from "./wire.ts";

export const JUMP_BRIDGE_GROUP = 1408;
export const JUMP_BRIDGE_ROOT = "UI/Inflight/SpaceComponents/JumpBridge/";
export const JUMP_BRIDGE_INITIATE = "UI/Inflight/InitiateJump";
export interface JumpBridgeSlim {
  readonly targetSystemID: number | null;
  readonly activationState: number | null;
  readonly chargeTag: number | null;
}

export interface JumpBridgeCharge {
  readonly validShipType: boolean;
  readonly chargeGJ: number;
}

/** The 24.02 client constructs JumpBridgeAuthorizedInfo from the validity and charge. */
export function readJumpBridgeCharge(value: JsonValue): JumpBridgeCharge | null {
  if (value === null) return null;
  if (typeof value === "object" && "type" in value && value.type === "objectex1" && Array.isArray(value.header)) {
    const [token, args] = value.header;
    if (token?.type === "token" && token.value === "jumpbridge.common.jump_bridge_authorized_info.JumpBridgeAuthorizedInfo"
        && Array.isArray(args) && args.length === 2) {
      const validShipType = unwrapBool(args[0]);
      const chargeGJ = unwrapReal(args[1]);
      if (validShipType !== null && chargeGJ !== null && Number.isFinite(chargeGJ) && chargeGJ >= 0) {
        return { validShipType, chargeGJ };
      }
    }
  }
  throw new Error("The bridge returned an unreadable charge.");
}

/** zone_modifier_util.py uses inclusive bounds and the distance from the capital to the destination. */
export function jumpBridgeZone(distanceLY: number): number {
  const index = [5, 10, 15, 20].findIndex(limit => distanceLY <= limit);
  return index < 0 ? 5 : index + 1;
}

/** JumpBridgeValuesAccess.current_charge_value, with elapsed simulation time in milliseconds. */
export function rechargedJumpBridgeGJ(charge: number, capacity: number, rechargeMs: number, elapsedMs: number): number {
  if (capacity <= 0) return 0;
  const start = Math.min(charge, capacity);
  if (rechargeMs <= 0 || elapsedMs <= 0) return start;
  const decayed = (Math.sqrt(start / capacity) - 1) * Math.exp(-elapsedMs * 5 / rechargeMs);
  return (1 + decayed) ** 2 * capacity;
}
