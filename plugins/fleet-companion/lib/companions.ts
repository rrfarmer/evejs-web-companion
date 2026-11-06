// The one companion of a pilot's session in this tab. A plugin's modules stay loaded for as
// long as the page does, so it goes on flying with the Fleet companions window shut.

import type { Session } from "../../../web/src/plugin-api/index.ts";
import { createCompanionFlow, type CompanionFlow } from "./companionFlow.ts";

const companions = new WeakMap<object, CompanionFlow>();

export function companionFor(session: Pick<Session, "store" | "flow">): CompanionFlow {
  let companion = companions.get(session.flow);
  if (companion === undefined) {
    companion = createCompanionFlow(session.store, session.flow);
    companions.set(session.flow, companion);
  }
  return companion;
}
