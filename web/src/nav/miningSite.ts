import type { ScannedAnomaly } from "./scriptConditions.ts";
import type { MiningHold, SpaceEntity } from "../store/types.ts";
import type { BotScript } from "../bots/botScript.ts";
import { startupSteps } from "../bots/startup.ts";
import type { ScanSite } from "../bridge/boundSmallServices.ts";
import { siteKind } from "../scanner/siteKind.ts";

export type SiteFamily = "ORE_ANOMALY" | "ICE";

/** Preserve scanner identity through the shared script observation boundary.
 * The dictionary key addresses the scanned site; instanceID addresses its
 * current incarnation. The inner fields.siteID may instead name a dungeon. */
export function scriptScannerSites(sites: readonly ScanSite[]): readonly ScannedAnomaly[] {
  const positiveID = (value: unknown): number | null => {
    const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  return sites.flatMap(site => site.targetID === null ? [] : [{
    label: site.targetID,
    kind: siteKind(site.fields["scanStrengthAttribute"], site.fields["archetypeID"]),
    archetypeID: positiveID(site.fields["archetypeID"]),
    siteID: positiveID(site.siteID),
    instanceID: positiveID(site.fields["instanceID"]),
    dungeonNameID: positiveID(site.fields["dungeonNameID"]),
    position: site.position !== null && site.position.length >= 3 && site.position.slice(0, 3).every(Number.isFinite)
      ? { x: site.position[0]!, y: site.position[1]!, z: site.position[2]! } : null,
  }]);
}

export function siteMiningFitRefusal(script: BotScript, ore: readonly number[], ice: readonly number[],
  policy: { readonly requireOre?: boolean } = {}): string | null {
  // A Startup refit changes the hull before any mining step runs, so the ship
  // sitting here at Start says nothing about it. The mining step still refuses
  // at run time if the refitted ship has no harvester for its site.
  if (startupSteps(script).some((step) => step.macro === "refit-ship")) return null;
  function visit(nodes: BotScript["program"]): string | null {
    for (const node of nodes) {
      if (node.kind === "loop") { const reason = visit(node.body); if (reason) return reason; }
      if (node.kind === "branch") { const reason = visit(node.then) ?? visit(node.else); if (reason) return reason; }
      if (node.kind !== "macro" || node.macro !== "mine-at-belt") continue;
      const belt = node.args["belt"];
      if (belt?.kind !== "belt") continue;
      if (belt.belt.mode === "ice-site" && ice.length === 0) return "ICE_MINING_CAPABILITY_REQUIRED: fit an online Ice Harvester; ore modules are not a fallback.";
      if (policy.requireOre !== false && belt.belt.mode === "site" && ore.length === 0) return "ORE_MINING_CAPABILITY_REQUIRED: fit an online ore mining module; Ice/Gas harvesters cannot mine ore.";
    }
    return null;
  }
  return visit(script.program);
}
/** Does any block in the script fly to or mine the scanner's ore or ice sites? Those need the miners split into ore lasers and ice harvesters. */
export function scriptMinesScannerSites(script: BotScript): boolean {
  function visit(nodes: BotScript["program"]): boolean {
    return nodes.some((node) => {
      if (node.kind === "loop") return visit(node.body);
      if (node.kind === "branch") return visit(node.then) || visit(node.else);
      const belt = node.kind === "macro" ? node.args["belt"] : undefined;
      return belt?.kind === "belt" && (belt.belt.mode === "site" || belt.belt.mode === "ice-site");
    });
  }
  return visit(script.program);
}
// Scanner archetypes distinguish Ice from ore even though both use scan strength 211.
export function miningSiteFamily(site: ScannedAnomaly): SiteFamily | null {
  if (site.kind !== "ore") return null;
  return site.archetypeID === 28 ? "ICE" : site.archetypeID === 27 ? "ORE_ANOMALY" : null;
}
export function siteIdentity(site: ScannedAnomaly): string | null {
  if (!Number.isSafeInteger(site.siteID) || (site.siteID ?? 0) <= 0) return null;
  return `site:${site.siteID}:instance:${site.instanceID ?? site.siteID}`;
}
export function siteRockMatches(rock: SpaceEntity, family: SiteFamily): boolean {
  return rock.miningResourceFamily === (family === "ICE" ? "ice" : "ore");
}
// Required Ice Harvesting skill 16281 is static dogma, not a module label.
// High-slot mining-group/online eligibility is checked by the caller first.
export function iceMiningType(attributes: Readonly<Record<number, number>> | undefined): boolean {
  return !!attributes && (attributes[77] ?? 0) > 0 &&
    [182, 183, 184, 1285, 1289, 1290].some(id => attributes[id] === 16281);
}

export function iceHoldFraction(holds: readonly MiningHold[] | null): number | null {
  // Ice goes to the specialised ice hold, otherwise the GENERAL mining hold,
  // never the ore-only asteroid hold. Unreadable is not empty/available.
  const hold = holds?.find(row => row.key === "ice" && row.present) ?? holds?.find(row => row.key === "ore" && row.present);
  const capacity = hold?.capacity;
  return !hold || hold.error !== null || !capacity || capacity.capacity === null || capacity.used === null || capacity.capacity <= 0 ? null : capacity.used / capacity.capacity;
}
