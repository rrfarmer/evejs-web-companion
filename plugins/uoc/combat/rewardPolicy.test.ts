import test from "node:test";
import assert from "node:assert/strict";
import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import type { ClientQuestion, QuestionAnswer } from "../../../web/src/store/types.ts";
import { createSignal } from "../../../web/src/store/signals.ts";
import { withSecurityRewardQuestion } from "./rewardPolicy.ts";

const mission = { agentID: 4, contentID: 2925 };
const words = (label: string) => ({ label: "UI/Agents/StandardMission/" + label, parameters: null, text: null });
const question: ClientQuestion = {
  id: "native-choice", kind: "choice", service: "agents", method: "SingleChoiceBox", suppressID: "AgtShare",
  ...mission, title: { label: null, text: "", parameters: null }, body: words("CompleteShareWithFleetMessage"),
  choices: [words("ShareWithFleetYes"), words("ShareWithFleetNo")],
  askedAtMs: 1, expiresAtMs: 10, quantity: null,
};

function fixture() {
  const live = createSignal<{ questions: ClientQuestion[] }>({ questions: [{ ...question, id: "old" }] });
  const answers: [string, QuestionAnswer][] = [];
  const session = { store: { live }, flow: { answerQuestion: async (id: string, answer: QuestionAnswer) => {
    answers.push([id, answer]);
  } } } as unknown as PilotSession;
  return { live, answers, session };
}

for (const [policy, index] of [["KEEP", 1], ["SHARE", 0]] as const) {
  test(`hosted ${policy} answers the exact native choice once`, async () => {
    const { live, answers, session } = fixture();
    let guards = 0;
    const result = await withSecurityRewardQuestion(session, mission, policy, () => { guards++; }, async () => {
      live.set({ questions: [...live.get().questions, question] });
      live.set({ questions: [...live.get().questions] });
      return "native result";
    });
    live.set({ questions: [{ ...question, id: "after-turn-in" }] });
    assert.equal(result, "native result");
    assert.equal(guards, 1);
    assert.deepEqual(answers, [[question.id, { confirmed: true, index }]]);
  });
}

test("solo turn-in needs no answer", async () => {
  const { answers, session } = fixture();
  assert.equal(await withSecurityRewardQuestion(session, mission, "KEEP", () => {}, async () => true), true);
  assert.deepEqual(answers, []);
});

test("wrong mission identity or choice order aborts the call without a native answer", async () => {
  for (const unexpected of [
    { ...question, contentID: 1 },
    { ...question, choices: [...question.choices].reverse() },
    { ...question, suppressID: "OtherDialog" },
  ]) {
    const { live, answers, session } = fixture();
    await assert.rejects(withSecurityRewardQuestion(session, mission, "KEEP", () => {}, async signal => {
      live.set({ questions: [unexpected] });
      signal.throwIfAborted();
    }), /Unexpected native question/);
    assert.deepEqual(answers, []);
  }
});
