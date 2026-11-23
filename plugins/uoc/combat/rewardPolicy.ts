import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import type { Identity } from "./security.ts";

export type FleetRewardPolicy = "KEEP" | "SHARE";

export function isFleetRewardPolicy(value: unknown): value is FleetRewardPolicy {
  return value === "KEEP" || value === "SHARE";
}

const labels = "UI/Agents/StandardMission/";

/** Answer the native reward choice only while turning in this exact mission. */
export async function withSecurityRewardQuestion<T>(
  session: PilotSession,
  mission: Pick<Identity, "agentID" | "contentID">,
  policy: FleetRewardPolicy,
  assertCurrent: () => void,
  dispatch: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const live = session.store.live;
  const existing = new Set(live.get().questions.map(question => question.id));
  const controller = new AbortController();
  let answeredID: string | null = null;
  let closed = false;
  const stop = live.subscribe(({ questions }) => {
    if (closed || controller.signal.aborted) return;
    for (const question of questions) {
      if (existing.has(question.id) || question.id === answeredID) continue;
      if (answeredID !== null || question.service !== "agents" || question.method !== "SingleChoiceBox" ||
          question.kind !== "choice" || question.suppressID !== "AgtShare" ||
          question.agentID !== mission.agentID || question.contentID !== mission.contentID ||
          question.body.label !== labels + "CompleteShareWithFleetMessage" ||
          question.choices.length !== 2 || question.choices[0]?.label !== labels + "ShareWithFleetYes" ||
          question.choices[1]?.label !== labels + "ShareWithFleetNo") {
        controller.abort(new Error(`Unexpected native question during Security mission turn-in (${question.service}.${question.method}).`));
        return;
      }
      answeredID = question.id;
      try {
        assertCurrent();
        void session.flow.answerQuestion(question.id, { confirmed: true, index: policy === "SHARE" ? 0 : 1 })
          .catch(error => controller.abort(error));
      } catch (error) {
        controller.abort(error);
        return;
      }
    }
  });
  try {
    const result = await dispatch(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    closed = true;
    stop();
  }
}
