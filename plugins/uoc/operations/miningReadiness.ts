import { missingCommandEquipment } from "../miningFleet/support/supportPolicy.ts";
import type { FleetSetup } from "../miningFleet/runtime.ts";
import type { SavedDefinition } from "./miningStore.ts";
import type { FleetInspection } from "./miningBind.ts";
import {
  miningSupplySourceLabel,
  type MiningPreparationProjection,
} from "../restored/mining/miningPreparation.ts";

/** Account-only planning never represents browser input as physical evidence. */
export function pendingMiningReadiness(
  d: SavedDefinition,
  reason: string,
  blocked = false,
): MiningPreparationProjection {
  return {
    state: blocked ? "BLOCKED" : "PENDING",
    reason,
    members: d.members.map((m) => ({
      characterID: m.characterID,
      role: m.role,
      state: "PENDING",
      equipment: m.preparation?.fittingID ? "UNKNOWN" : "AS IS",
      supplies: m.preparation?.fittingID ? "UNKNOWN" : "NOT APPLICABLE",
      targets: [],
      reason: "Native pilot inspection has not run.",
      fittingName: null,
      sourceLabel: miningSupplySourceLabel(d.preparation?.source),
      observedAt: null,
    })),
  };
}

/** Presentation of the exact authorized host inspections already validated by the binder. */
export function inspectedMiningReadiness(
  d: SavedDefinition,
  observations: readonly FleetInspection[],
  setup: FleetSetup,
): MiningPreparationProjection {
  const members = d.members.map((m) => {
    const o = observations.find((x) => x.characterID === m.characterID);
    if (!o) throw Error("A reviewed member inspection is missing.");
    const selected = !!m.preparation?.fittingID,
      p = o.preparation;
    const stale = !!p?.shipID && p.shipID !== o.shipID;
    const observed = stale ? undefined : p;
    const notes: string[] = [];
    if (selected) {
      if (stale)
        notes.push(
          "The current ship changed after fitting inspection. Review evidence for the previous ship was discarded.",
        );
      else if (p?.reason) notes.push(p.reason);
      else if (p?.equipment !== "VERIFIED") notes.push("No fitting comparison could be verified.");
      const source = setup.startupPreparation?.find((row) => row.characterID === m.characterID)
        ?.preparation.source;
      if (
        d.preparation?.replenishSupplies === true &&
        source?.kind === "corp" &&
        source.corporationID === undefined
      )
        notes.push(
          "No shared player corporation was verified for the pilots with selected fittings.",
        );
      const family = d.area.targetClasses[0] === "ICE" ? "ICE" : "ORE",
        role = o.fitHoldQualification?.[family];
      if (m.role === "MINER" && role?.miner === false)
        notes.push(
          "The inspection did not find an online mining module and available hold space for this resource.",
        );
      if (m.role === "HAULER" && role?.hauler === false)
        notes.push("The inspection did not find available hold space for this resource.");
      if (m.role === "DEFENDER" && o.defender?.qualified === false && o.defender.reason)
        notes.push(o.defender.reason);
    }
    if (m.role === "COMMAND") {
      const missing = missingCommandEquipment(setup.supportPolicy, setup.command);
      if (missing.length)
        notes.push(
          "Online support equipment could not be identified for: " + missing.join(", ") + ".",
        );
    }
    return {
      characterID: m.characterID,
      role: m.role,
      state: notes.length ? ("DEGRADED" as const) : ("VERIFIED" as const),
      equipment: selected ? (observed?.equipment ?? "UNKNOWN") : "AS IS",
      supplies: selected ? (observed?.supplies ?? "UNKNOWN") : "NOT APPLICABLE",
      targets: observed?.targets ?? [],
      currentHull: o.shipTypeName ?? null,
      fittingName: observed?.fittingName ?? null,
      sourceLabel: selected
        ? (observed?.sourceLabel ?? miningSupplySourceLabel(d.preparation?.source))
        : "No fitting or top-up selected",
      reason:
        notes.join(" ") ||
        (selected
          ? "Selected fitting inspected."
          : "Uses current equipment without a fitting comparison or top-up."),
      observedAt: o.observedAt,
    };
  });
  return {
    state: members.some((m) => m.state === "DEGRADED") ? "DEGRADED" : "VERIFIED",
    members,
    reason:
      "The pilot, ship and operation scope were inspected. Equipment and optional supply warnings are advisory.",
  };
}
