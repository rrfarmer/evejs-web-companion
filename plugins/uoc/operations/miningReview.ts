import type { SavedDefinition } from "./miningStore.ts";
import { sameJsonValue } from "../shared/value.ts";
import { fleetStartupPreparation } from "./miningBind.ts";
import { isPlayerCorporation } from "../../../web/src/plugin-api/index.ts";
const pos = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
/** Match immutable operator choices before the native executor validates its own physical setup. */
export function assertMiningReview(d: SavedDefinition, s: any): void {
  if (
    !s ||
    s.operationID !== d.operationID ||
    s.systemID !== d.area.anchorSystemID ||
    !Array.isArray(s.members) ||
    s.members.length !== d.members.length ||
    new Set(s.members.map((m: any) => m.characterID)).size !== s.members.length ||
    new Set(s.members.map((m: any) => m.shipID)).size !== s.members.length ||
    d.members.some(
      (m) =>
        !s.members.some(
          (x: any) => x.characterID === m.characterID && x.role === m.role && pos(x.shipID),
        ),
    )
  )
    throw Error("The inspected roster or selected system differs from the saved operation.");
  const dest = d.unloadDestination;
  if (!dest) throw Error("A delivery destination is required.");
  const id = dest.kind === "structure" ? dest.id : dest.stationID,
    kind = dest.kind === "structure" ? "structure" : "station",
    corp = dest.corporationDivision == null ? null : dest.corporationID,
    division = dest.corporationDivision ?? null;
  if (
    s.destinationID !== id ||
    (s.delivery &&
      (s.delivery.destinationID !== id ||
        s.delivery.kind !== kind ||
        !pos(s.delivery.systemID) ||
        s.delivery.corporationID !== corp ||
        s.delivery.division !== division)) ||
    (!s.delivery &&
      (kind === "structure" ||
        division === null ||
        s.corporationID !== corp ||
        s.division !== division))
  )
    throw Error("The inspected delivery does not match the saved destination.");
  if ((d.unloadPolicy === "SELF_UNLOAD") !== (s.haulMode === "SELF_UNLOAD"))
    throw Error("The unload policy changed since review.");
  const family = d.area.targetClasses[0],
    siteFamily = family === "ICE" ? "ICE" : d.area.anomalyFamily === "MOON" ? "MOON" : "ORE";
  if (
    family === "BELT"
      ? !pos(s.beltID) || typeof s.beltName !== "string" || !s.beltName.trim()
      : !(
          s.siteSearch?.family === siteFamily ||
          (s.site?.siteFamily === siteFamily &&
            s.site?.target?.kind === (family === "ICE" ? "ICE" : "ORE_ANOMALY"))
        )
  )
    throw Error("The inspected resource family differs from the saved area.");
  const p = d.policies?.parking;
  if ((!p && s.parking) || (p?.mode === "STAY_IN_PLACE" && s.parking?.mode !== "STAY_IN_PLACE"))
    throw Error("The Stop policy changed since review.");
  if (p && p.mode !== "STAY_IN_PLACE") {
    const target = p.destination,
      id = target?.kind === "structure" ? target.id : target?.stationID;
    if (
      s.parking?.mode !== p.mode ||
      s.parking.destinationID !== id ||
      s.parking.kind !== (target?.kind === "structure" ? "structure" : "station") ||
      !pos(s.parking.systemID)
    )
      throw Error("The parking destination changed since review.");
    if (
      p.mode === "RETURN_HOME_UNLOAD_DOCK" &&
      (s.parking.corporationID !== (p.corporationDivision == null ? null : p.corporationID) ||
        s.parking.division !== (p.corporationDivision ?? null))
    )
      throw Error("The Stop unload destination corporation changed since review.");
  }
  const resources = d.policies?.resourcePolicy ?? {
    mode: "ANY_ELIGIBLE",
    source: "MANUAL",
    typeIDs: [],
  };
  if (
    !sameJsonValue(
      resources,
      s.resourcePolicy ?? { mode: "ANY_ELIGIBLE", source: "MANUAL", typeIDs: [] },
    )
  )
    throw Error("The ordered resource policy changed since review.");
  if ((d.policies?.travelAssist?.mode ?? undefined) !== s.travelAssist)
    throw Error("The propulsion assist setting changed since review.");
  if (!sameJsonValue(d.oreLogistics, s.oreLogistics))
    throw Error("The remote compression or compressed freight threshold changed since review.");
  if (d.support) {
    const { version, characterID, fleetPolicy, ...policy } = d.support;
    if (
      !s.members.some((m: any) => m.role === "COMMAND" && m.characterID === characterID) ||
      s.fleetPolicy !== fleetPolicy ||
      !sameJsonValue(s.supportPolicy, policy)
    )
      throw Error("The selected COMMAND support policy changed since review.");
  } else if (s.command || s.supportPolicy || s.fleetPolicy)
    throw Error("The reviewed COMMAND configuration is not part of the saved operation.");
  if (
    s.fleetMoves?.some(
      (m: any) =>
        !s.members.some((x: any) => x.characterID === m.characterID && x.shipID === m.shipID) ||
        !pos(m.fromFleetID),
    )
  )
    throw Error("A fleet move does not belong to a selected exact ship.");
  const reviewedSource = Array.isArray(s.startupPreparation)
    ? s.startupPreparation[0]?.preparation?.source
    : null;
  const corporationID =
    reviewedSource?.kind === "corp" && isPlayerCorporation(reviewedSource.corporationID)
      ? reviewedSource.corporationID
      : undefined;
  // Only the missing corporation can be bound by the fleet review. The held pilot rechecks it at the office.
  if (
    s.startupPreparation !== undefined &&
    !sameJsonValue(s.startupPreparation, fleetStartupPreparation(d, corporationID))
  )
    throw Error("The equipment or supply preparation changed since review.");
}
