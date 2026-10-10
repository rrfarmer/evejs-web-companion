// One call of the server's, as the page's own asking makes it (the plan's Phase 6b).
//
// The client's services ask the server by a service's name and a method's. Where the page does a service's work
// for itself (bridge/walletReads.ts, bridge/standingsReads.ts), it asks the same way, through this: the generic
// call (bridge/callMethod.ts), with a flow's own token, and so on the pilot's socket. `api.bridgeAsk` makes one.

import type { CallKwargs, JsonValue } from "./wire.ts";

/**
 * One call of the server's, by its service and method, answered with its result. Fails as the call fails.
 * `kwargs` are the call's keywords, where the client's call has any.
 *
 * `of` is for a call the client makes on an object of the service's for a thing it names (its
 * Moniker(service, what)): what that thing is, a planet's ID for the planet manager's object for that planet.
 * A call asked of the service by its name has none.
 */
export type Ask = (service: string, method: string, args: readonly JsonValue[], kwargs?: CallKwargs, of?: JsonValue) => Promise<JsonValue>;

/** Why a call failed, in the code its failure carries. */
export function failureCode(reason: unknown): string {
  const code = reason !== null && typeof reason === "object" ? (reason as { code?: unknown }).code : undefined;
  return typeof code === "string" && code !== "" ? code : "READ_FAILED";
}

/**
 * What fails a whole reading, and is not one read's own failure. A route's request failed as a whole when the
 * BFF could not be reached, when the BFF held no pilot for it or the pilot's session was gone, when the web
 * session was not one the BFF knew, and when the flow that asked had moved on to another pilot; only what the
 * server answered one of its calls with was that read's own. The same holds of the calls the page makes itself.
 */
const FAILS_THE_READING: ReadonlySet<string> = new Set([
  // The pilot's session is gone from the server, or the BFF holds none for this web session.
  "SESSION_NOT_FOUND",
  "NO_LIVE_SESSION",
  // The BFF was not reached at all (bridge/callMethod.ts).
  "BRIDGE_NETWORK_ERROR",
  // The flow has another pilot now: what answers the last one's call is nobody's.
  "SESSION_REQUEST_RETIRED",
]);

/** Whether a call's failure is the whole reading's: nothing the other reads answered makes up for it. */
export function failsTheReading(reason: unknown): boolean {
  if (FAILS_THE_READING.has(failureCode(reason))) return true;
  // Not signed in to the BFF at all.
  return reason !== null && typeof reason === "object" && (reason as { status?: unknown }).status === 401;
}
