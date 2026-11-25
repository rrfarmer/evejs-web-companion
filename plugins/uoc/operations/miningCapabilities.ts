import type { SavedDefinition } from "./miningStore.ts";
/** Existing executor is narrower than WC74. Return all known mismatches rather than dropping saved controls. */
export function currentExecutorGaps(d: SavedDefinition): string[] {
  const gaps: string[] = [];
  if (!d.members.some((m) => m.role === "MINER")) gaps.push("Choose at least one miner.");
  if (d.members.some((m) => m.routineMode === "CUSTOM" || m.automationID))
    gaps.push(
      "Custom routines require the public PilotSession factory to expose the stock ScriptRunner operation assignment option; that API is not currently exported.",
    );
  if (
    d.area.targetClasses.length !== 1 ||
    !["BELT", "ORE_ANOMALY", "ICE"].includes(d.area.targetClasses[0]!)
  )
    gaps.push("Selected resource family is not supported by the current executor.");
  if (!d.unloadDestination) gaps.push("Choose a verified delivery destination.");
  return gaps;
}
