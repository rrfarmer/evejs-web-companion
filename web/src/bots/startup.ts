import type { BotScript, MacroStep, ProgramNode } from "./botScript.ts";
import type { ScriptAction, ScriptMemory } from "../nav/scriptDecide.ts";
import type { ScriptObservation } from "../nav/scriptConditions.ts";

export type StartupState = "NEEDED" | "PENDING" | "COMPLETE" | "BLOCKED";
export interface StartupCheckpoint {
  readonly logicalRunID: string;
  observe(step: MacroStep, observation: ScriptObservation): Promise<StartupState>;
  beforeIssue(step: MacroStep, action: ScriptAction, invocation: number): Promise<void>;
  restoreMemory?(): ScriptMemory | null;
  checkpoint?(memory: ScriptMemory): Promise<void>;
}

/** Only the unambiguous prefix + final loop shape gets Startup semantics. */
export function startupPrefix(doc: BotScript): readonly ProgramNode[] {
  const last = doc.program.at(-1);
  return last?.kind === "loop" && doc.program.slice(0, -1).every(node => node.kind !== "loop")
    ? doc.program.slice(0, -1) : [];
}

export function startupSteps(doc: BotScript): readonly MacroStep[] {
  return startupPrefix(doc).flatMap(node => node.kind === "macro" ? [node] :
    node.kind === "branch" ? [...node.then, ...node.else] : []);
}

// Deliberately small initial adapter set. The interface supports later verified
// inventory actions; putting a macro here never changes its grant/risk policy.
export function startupPostcondition(step: MacroStep, obs: ScriptObservation, startingLocation: number | null): boolean | null {
  const flight = obs.flightStatus;
  if (!flight || typeof flight.docked !== "boolean" || !flight.shipID) return null;
  if (step.macro === "undock") return flight.docked === false;
  if (step.macro === "dock-at-nearest") return flight.docked === true;
  if (step.macro === "travel-to-station") {
    const station = step.args.station;
    if (station?.kind !== "station") return null;
    const target = station.ref.starting ? startingLocation : station.ref.id;
    if (!target || station.ref.slot) return null;
    return flight.docked && (flight.stationID === target || flight.structureID === target);
  }
  return null;
}

export function startupActionSupported(step: MacroStep, action: ScriptAction): boolean {
  return (step.macro === "undock" && action.kind === "undock") ||
    (["dock-at-nearest", "travel-to-station"].includes(step.macro) && action.kind === "dock");
}
