import type { Contract } from "./centerTypes.ts";

export interface FittingChoice {
  readonly id: number;
  readonly name: string;
}

function compareNames(a: FittingChoice, b: FittingChoice): number {
  return a.name.localeCompare(b.name) || a.id - b.id;
}

/** Show only groups and hulls represented in the actual saved fitting library. */
export function fittingGroups(contracts: readonly Contract[]): FittingChoice[] {
  const groups = new Map<number, FittingChoice>();
  for (const fit of contracts) {
    const id = fit.hullGroupName ? (fit.hullGroupID ?? 0) : 0;
    if (!groups.has(id)) groups.set(id, { id, name: fit.hullGroupName || "Unknown ship group" });
  }
  return [...groups.values()].sort(compareNames);
}

export function fittingHulls(
  contracts: readonly Contract[],
  groupID: number | null,
): FittingChoice[] {
  const hulls = new Map<number, FittingChoice>();
  for (const fit of contracts) {
    if (groupID !== null && (fit.hullGroupName ? (fit.hullGroupID ?? 0) : 0) !== groupID) continue;
    if (!hulls.has(fit.shipTypeID))
      hulls.set(fit.shipTypeID, { id: fit.shipTypeID, name: fit.hullName || "Unknown ship" });
  }
  return [...hulls.values()].sort(compareNames);
}

export function filterFittings(
  contracts: readonly Contract[],
  groupID: number | null,
  hullID: number | null,
  query: string,
): Contract[] {
  const text = query.trim().toLocaleLowerCase();
  return contracts
    .filter(
      (fit) =>
        (groupID === null || (fit.hullGroupName ? (fit.hullGroupID ?? 0) : 0) === groupID) &&
        (hullID === null || fit.shipTypeID === hullID) &&
        (!text || fit.name.toLocaleLowerCase().includes(text)),
    )
    .sort(
      (a, b) => a.name.localeCompare(b.name) || a.definition.fittingID - b.definition.fittingID,
    );
}
