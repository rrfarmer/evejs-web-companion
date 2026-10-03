import type { BotScript, ProgramNode } from "./botScript.ts";

/** Make an independent standalone copy; caller owns storage and patrol bindings. */
export function modernDefenderCopy(historical: BotScript): BotScript {
  const copy = structuredClone(historical);
  const visit = <T extends ProgramNode>(node: T): T => {
    if (node.kind === "loop") return { ...node, body: node.body.map(visit) };
    if (node.kind === "branch") return { ...node, then: node.then.map(visit), else: node.else.map(visit) };
    return node.kind === "macro" && node.macro === "fight-the-rats"
      ? { ...node, macro: "fight-with-drones", args: {} } : node;
  };
  return { ...copy, name: `${copy.name} — Modern Core`,
    interrupts: [
      { id: "defender-hull-emergency", when: { kind: "hull-below", fraction: 0.3 }, respond: "dock-and-pause" },
      ...copy.interrupts.filter(row => row.when.kind !== "hull-below" &&
        !(row.when.kind === "hostile-on-grid" && row.respond === "launch-drones")),
      // Reuses the historical armor fallback threshold, not a new universal tank doctrine.
      { id: "defender-armor-maintenance", when: { kind: "armor-below", fraction: 0.3 }, respond: "repair" },
    ], program: copy.program.map(visit) };
}
