import type { State } from "./security.ts";
/** Core accepts at most 16 KiB; full receipts and diagnostics remain in SQLite. */
export function securityReadout(
  state: State,
  diagnostics: { runID: string; events: readonly any[] },
  parking: unknown = null,
) {
  if (!state || state.runID !== diagnostics.runID || !Array.isArray(state.completed))
    throw new Error("Security readout does not match the current journal.");
  const last = state.completed.at(-1),
    raw = last?.reward as Record<string, unknown> | null | undefined;
  const field = (name: string) => (typeof raw?.[name] === "string" ? (raw[name] as string) : null);
  const reward = raw
    ? {
        confirmedIsk: field("confirmedIsk"),
        withheldIsk: field("withheldIsk"),
        observedCashChange: field("observedCashChange"),
        observedLpChange: field("observedLpChange"),
        observedCorporationLpChange: field("observedCorporationLpChange"),
        iskReason: field("iskReason"),
        lpReason: field("lpReason"),
      }
    : null;
  const event = diagnostics.events.at(-1),
    lastEvent = event
      ? {
          kind: typeof event.kind === "string" ? event.kind : null,
          at: Number.isFinite(event.at) ? event.at : null,
          target: Number.isSafeInteger(event.data?.target) ? event.data.target : null,
        }
      : null;
  const result = {
    completedCount: state.completed.length,
    latestReceipt: last
      ? { missionKey: last.identity.acceptedKey, commandID: last.commandID }
      : null,
    reward,
    parking,
    diagnostics: {
      document: `security-telemetry:${state.characterID}:${state.runID}`,
      eventCount: diagnostics.events.length,
      lastEvent,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 12000)
    throw new Error("Security completion readout is too large; journal custody retained.");
  return result;
}
