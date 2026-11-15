import type { JsonValue } from "./wire.ts";

// academyships/common/const.py and client/exit_block.py. Travel uses its own conversation.
const DECLINE_DIALOGS = {
  DECLINED_REASON_UNDOCK: {
    key: "AcademyShipCannotUndockOutsideExordium",
    fallback: "This Academy Ship is outside Exordium and so cannot undock.\n\nAcademy Ships may only be flown in Exordium. Board a standard ship to undock.",
  },
  DECLINED_REASON_WARP: {
    key: "AcademyShipCannotWarpOutsideExordium",
    fallback: "This Academy Ship is outside Exordium and so cannot warp.\n\nAcademy Ships may only be flown within Exordium.",
  },
  DECLINED_REASON_EJECT: {
    key: "AcademyShipCannotEject",
    fallback: "Ejecting from an Academy Ship while undocked is not permitted. To change ships, please dock in a station first.",
  },
  DECLINED_REASON_DRONE: {
    key: "AcademyDroneNeedsAcademyShip",
    fallback: "Academy drones can only be used by an Academy Ship.",
  },
} as const;

export const ACADEMY_UNDOCK_DIALOG = DECLINE_DIALOGS.DECLINED_REASON_UNDOCK;
export const ACADEMY_TRAVEL_DECLINED = "ACADEMY_SHIP_TRAVEL_DECLINED";

function academyDeclineReason(typeName: string, payload: JsonValue): JsonValue | undefined {
  if (typeName !== "eve_public.academy.ships.api.DeclinedNotice" || !payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return (payload as Readonly<Record<string, JsonValue>>).reason;
}

export function isAcademyTravelDecline(typeName: string, payload: JsonValue): boolean {
  return academyDeclineReason(typeName, payload) === "DECLINED_REASON_TRAVEL";
}

export function academyShipDeclineDialog(typeName: string, payload: JsonValue): { readonly key: string; readonly fallback: string } | null {
  const reason = academyDeclineReason(typeName, payload);
  return typeof reason === "string" && Object.hasOwn(DECLINE_DIALOGS, reason)
    ? DECLINE_DIALOGS[reason as keyof typeof DECLINE_DIALOGS] : null;
}
