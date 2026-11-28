/** An old accepted mission is resolved only by a later native completion
 * command receipt for that exact accepted key. UI phase and wallet deltas do
 * not participate. A live/unknown execution always retains its own custody. */
export function unresolvedCombatRuns(rows: readonly any[], mode: string) {
  return rows.filter((r, i) => {
    if (r.status !== "ENDED") return true;
    if (
      r.receipt?.phase === "DONE" ||
      (mode !== "SECURITY_MISSION" && r.receipt?.phase === "STOPPED")
    )
      return false;
    const key = r.receipt?.identity?.acceptedKey;
    return !(
      mode === "SECURITY_MISSION" &&
      r.receipt?.phase === "COMBAT" &&
      typeof key === "string" &&
      rows
        .slice(0, i)
        .some(
          (next) =>
            next.status === "ENDED" &&
            next.character_id === r.character_id &&
            next.owner === r.owner &&
            next.receipt?.phase === "DONE" &&
            Array.isArray(next.receipt.completed) &&
            next.receipt.completed.some(
              (c: any) =>
                c.identity?.acceptedKey === key &&
                typeof c.commandID === "string" &&
                c.commandID.length > 0,
            ),
        )
    );
  });
}
