import type { PilotSession } from "../../../web/src/plugin-api/pilotSession.ts";
import { readDictPairs, unwrapLong, type JsonValue } from "../shared/wire.ts";
import {
  agentMission,
  missionLabel,
  referralAgent,
  type JournalRow,
  type MissionJournal,
  type conversation,
} from "../distribution/native.ts";
import { readAfterTimeout } from "../shared/progressDeadline.ts";

/** A missing Request button or a timeout does not identify a conflicting mission. */
export function existingMissionRefusal(words: string) {
  return /\byou (?:already have (?:an? )?(?:outstanding |active |accepted |pending )?(?:mission|offer)|must (?:finish|complete|cancel|quit|decline) (?:your |the )?(?:existing |current |other )?(?:mission|offer))\b/i.test(
    words,
  );
}

export function missionRefusalText(error: unknown): string | null {
  const e = error as { status?: number; message?: string; data?: { error?: string } } | null;
  return e?.status === 409 && e.data?.error === "CALL_REFUSED" && e.message ? e.message : null;
}

export function busyAgentMessage(row: JournalRow) {
  return `This agent is busy with ${missionLabel(row)}. Choose a free agent or resolve this mission manually.`;
}

// EveJS returns the active action flags for a new Accept, and null flags when
// the mission was already accepted. Both replies can show a Complete button.
export function confirmedMissionAccept(reply: NonNullable<ReturnType<typeof conversation>>) {
  return (
    reply.completed === false &&
    reply.actions.some((action) => action.button === 6 || action.button === 7)
  );
}

// EveJS can turn in a referral just by opening the recipient's conversation.
export async function referralTargets(
  journal: MissionJournal,
  briefing: (id: number) => Promise<{ objective: unknown }>,
) {
  const targets = new Map<number, JournalRow>();
  for (const row of journal.active) {
    // The journal can show the issuing agent's generic label for an agent interaction.
    const target = referralAgent((await readAfterTimeout(() => briefing(row.agentID))).objective);
    if (
      target === undefined ||
      (target === null && /(?:TalkToAgent|AgentInteraction)$/.test(row.missionType ?? ""))
    )
      throw Error(`${missionLabel(row)}: native referral destination is unreadable.`);
    if (target !== null) targets.set(target, row);
  }
  return targets;
}
export function referralConflict(row: JournalRow, agentID: number) {
  return `Agent ${agentID} would turn in ${missionLabel(row)} on contact. Choose a different agent or resolve that referral.`;
}

export class DeclineUnavailable extends Error {}

type Dialogue = (
  agentID: number,
  action?: number | null,
) => Promise<NonNullable<ReturnType<typeof conversation>>>;
export async function declineOffer(
  row: JournalRow,
  deps: {
    session: PilotSession;
    journal: () => Promise<MissionJournal>;
    record: (
      agentID: number,
    ) => Promise<{ agentID: number; agentTypeID: number; stationID: number | null }>;
    briefing: (agentID: number) => Promise<JsonValue | undefined>;
    dialogue: Dialogue;
    guard: () => void;
    dispatch: (write: () => Promise<void>) => Promise<void>;
  },
) {
  const { agentID } = row,
    label = missionLabel(row);
  if (row.missionState !== 1) throw new DeclineUnavailable(busyAgentMessage(row));
  const agent = await deps.record(agentID);
  if (agent?.agentID !== agentID || agent.agentTypeID !== 2 || row.important !== false)
    throw new DeclineUnavailable(`${label}: automatic decline is limited to ordinary offers.`);
  const briefing = await deps.briefing(agentID);
  const ticks = unwrapLong(readDictPairs(briefing).find(([key]) => key === "Decline Time")?.[1]);
  if (ticks === null)
    throw new DeclineUnavailable(`${label}: native decline availability is unreadable.`);
  if (ticks > 0n)
    throw new DeclineUnavailable(
      `${label}: native decline timer has ${(ticks + 9_999_999n) / 10_000_000n}s remaining.`,
    );
  const current = agentMission(await readAfterTimeout(deps.journal), agentID);
  if (current?.missionKey !== row.missionKey || current.missionState !== row.missionState)
    throw Error(`${label} changed before decline.`);
  deps.guard();
  const dialogue = await deps.dialogue(agentID, null),
    button = dialogue.actions.find((a) => a.button === 9);
  if (!button)
    throw new DeclineUnavailable(`${label}: the agent did not offer Decline. ${dialogue.says}`);
  try {
    await deps.dispatch(async () => {
      const { store, flow } = deps.session;
      const original = new Set(store.live.get().questions.map((q) => q.id));
      let answered = false;
      const unsubscribe = store.live.subscribe(({ questions }) => {
        if (answered) return;
        const pending = questions.find(
          (q) =>
            !original.has(q.id) &&
            q.kind === "yesNo" &&
            q.service === "agents" &&
            q.method === "YesNo" &&
            q.agentID === agentID &&
            q.suppressID === "AgtDeclineMission",
        );
        if (!pending) return;
        answered = true;
        void flow.answerQuestion(pending.id, true).catch(() => {
          /* The native action result determines settlement. */
        });
      });
      try {
        const result = await deps.dialogue(agentID, button.id);
        const confirmed = result.declined;
        if (confirmed !== true)
          throw Object.assign(Error(result.says || "The native action was not confirmed."), {
            missionActionRefused: confirmed === false,
          });
      } finally {
        unsubscribe();
      }
    });
  } catch (error) {
    if (error instanceof DeclineUnavailable) throw error;
    throw Error(
      `${label}: decline did not settle: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
