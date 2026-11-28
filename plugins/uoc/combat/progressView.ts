import type { JsonValue, ServerBot } from "../../../web/src/plugin-api/index.ts";
/** Never attach one journal generation to a different server history row. */
export function matchingSecurityProgress(
  bot: Pick<ServerBot, "botID" | "characterID">,
  body: Record<string, JsonValue>,
): Record<string, JsonValue> | null {
  if (
    body.ok !== true ||
    body.runID !== bot.botID ||
    body.characterID !== bot.characterID ||
    !body.readout ||
    typeof body.readout !== "object" ||
    Array.isArray(body.readout)
  )
    return null;
  const readout = body.readout as Record<string, JsonValue>;
  if (
    typeof readout.completedCount !== "number" ||
    !Number.isSafeInteger(readout.completedCount) ||
    readout.completedCount < 0
  )
    return null;
  return readout;
}
export type SecurityHistoryRow = {
  characterID: number;
  runID: string;
  phase: string;
  completedCount: number;
  latestReceipt: JsonValue;
};
export function securityHistoryRows(
  characterID: number,
  body: Record<string, JsonValue>,
): SecurityHistoryRow[] {
  if (body.ok !== true || body.characterID !== characterID || !Array.isArray(body.rows))
    throw Error("Security history does not match the pilot.");
  const ids = new Set<string>();
  return body.rows.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.characterID !== characterID ||
      typeof value.runID !== "string" ||
      !value.runID ||
      ids.has(value.runID) ||
      typeof value.phase !== "string" ||
      typeof value.completedCount !== "number" ||
      !Number.isSafeInteger(value.completedCount) ||
      value.completedCount < 0
    )
      throw Error("Security history is malformed.");
    ids.add(value.runID);
    return {
      characterID,
      runID: value.runID,
      phase: value.phase,
      completedCount: value.completedCount,
      latestReceipt: value.latestReceipt ?? null,
    };
  });
}
