import type { Colony, ColonyPin, ExtractorHead } from "../store/types.ts";
import { maxOutputOf, planExtractorRestart, requestExtractorYield } from "./extractorRestart.ts";
import { MAX_HEAD_RADIUS, MIN_HEAD_RADIUS, validExtractorDraft } from "./extractorSurvey.ts";
import type { Ask } from "./ask.ts";
import type { JsonValue } from "./wire.ts";

export const EXTRACTOR_COOLDOWN_MS = 60_000; // EcuPin.PROGRAM_INSTALLATION_COOLDOWN
const ADD_HEAD = 10, REMOVE_HEAD = 11, MOVE_HEAD = 12, INSTALL_PROGRAM = 13, CREATE_ROUTE = 6, REMOVE_ROUTE = 7;

export interface ExtractorEdit {
  readonly pinID: number;
  readonly basis: string;
  readonly heads: readonly ExtractorHead[];
  readonly radius: number;
  /** Undefined keeps the program, null stops it, and a resource ID installs a program. */
  readonly resourceID?: number | null;
  readonly stopped: boolean;
}

/** Ignore simulation counters and compare the editable state that the survey opened with. */
export function extractorBasis(pin: ColonyPin): string {
  const program = pin.program;
  return JSON.stringify([pin.typeID, pin.latitude, pin.longitude, pin.extractor?.headRadius,
    pin.extractor?.heads?.slice().sort(([a], [b]) => a - b), program?.resourceTypeID, program?.installedAtMs, program?.expiresAtMs]);
}

export function extractorHeadCommands(pinID: number, before: readonly ExtractorHead[], after: readonly ExtractorHead[]): JsonValue[][] {
  const existing = new Map(before.map(head => [head[0], head]));
  const present = new Set(after.map(([id]) => id));
  const changes = before.filter(([id]) => !present.has(id)).map(([id]) => [REMOVE_HEAD, [pinID, id]]);
  for (const [id, latitude, longitude] of after) {
    const previous = existing.get(id);
    if (!previous || previous[1] !== latitude || previous[2] !== longitude) {
      changes.push([previous ? MOVE_HEAD : ADD_HEAD, [pinID, id, latitude, longitude]]);
    }
  }
  return changes;
}

/** The server owns the quote and validates the whole command stream as one colony update. */
export async function planExtractorEdits(ask: Ask, colony: Colony, edits: readonly ExtractorEdit[]): Promise<JsonValue[]> {
  const changes: JsonValue[] = [];
  const seen = new Set<number>();
  let nextRouteID = 1;
  for (const edit of edits) {
    const pin = colony.pins.find(candidate => candidate.pinID === edit.pinID && candidate.kind === "extractor-control");
    const previous = pin?.extractor?.heads;
    if (!pin || !previous || extractorBasis(pin) !== edit.basis || seen.has(edit.pinID)) {
      throw new Error("The extractor changed. Cancel the colony edits and reopen its survey.");
    }
    seen.add(edit.pinID);
    const radius = edit.radius;
    const resourceID = edit.resourceID;
    const invalidHeads = (edit.heads.length > 0 || resourceID != null) && !validExtractorDraft(edit.heads, radius);
    if (!Number.isFinite(radius) || radius < MIN_HEAD_RADIUS || radius > MAX_HEAD_RADIUS || invalidHeads) {
      throw new Error("The extraction heads or drill area are invalid.");
    }
    const heads = extractorHeadCommands(pin.pinID, previous, edit.heads);
    if (edit.stopped || resourceID === null) {
      // EveOffline rejects an output route if the source no longer produces its commodity.
      // A stop followed by an install uses the existing routes for the install's redistribution.
      if (resourceID === null) {
        for (const route of colony.routes) {
          if (route.path[0] === pin.pinID) changes.push([REMOVE_ROUTE, [route.routeID]]);
        }
      }
      const installedRadius = Math.max(MIN_HEAD_RADIUS, Math.min(MAX_HEAD_RADIUS, pin.extractor?.headRadius ?? MIN_HEAD_RADIUS));
      changes.push([INSTALL_PROGRAM, [pin.pinID, null, resourceID == null ? radius : installedRadius]]);
    } else if (pin.active !== false) {
      throw new Error("Stop the running program before editing the extractor.");
    }
    changes.push(...heads);
    if (resourceID == null) continue;
    const noise = pin.extractor?.noiseFactor;
    if (noise == null || !colony.resources?.some(resource => resource.typeID === resourceID)) {
      throw new Error("The extractor or resource is unavailable for installation.");
    }
    const quote = await requestExtractorYield(ask, colony.planetID, pin.pinID, resourceID, edit.heads, radius);
    if (!(quote.quantity > 0 && quote.cycleTicks > 0 && quote.cycles > 0)) throw new Error("These heads have no extractable yield.");
    const routeOutput = maxOutputOf(noise, quote.quantity, quote.cycleTicks);
    const program = planExtractorRestart(colony, pin.pinID, resourceID, radius, routeOutput, nextRouteID);
    nextRouteID += program.filter(command => Array.isArray(command) && command[0] === CREATE_ROUTE).length;
    changes.push(...program);
  }
  return changes;
}
