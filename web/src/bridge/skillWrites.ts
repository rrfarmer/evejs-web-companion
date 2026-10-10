// The skill queue's writes, made by the page itself (the plan's Phase 6b).
//
// The first of the page's writes to leave its route. Until 2026-10-10 the pause
// of training was POST /api/bridge/skills/abort-training, which checked that
// the page had said `confirm` and made one call. A retail client has no such
// route: its queue panel's Pause makes the call
// (skillQueuePanelNew.PauseTraining, where a skill is in training:
// skills.AbortTrain(), which is the handler's AbortTraining()), with no asking
// of the pilot first, and then commits its queue unactivated, which with the
// queue unchanged sends nothing (skillQueueSvc.CommitTransaction 147).
//
// THE CALL, as the client makes it:
//
//   skillHandler.AbortTraining()   skillsvc.py 796: with nothing, on the skill handler's moniker.
//                                  Recorded on Tranquility; the server then says
//                                  OnServerSkillsChanged with the event OnSkillQueuePausedServer.
//
// HOW A WRITE IS MADE BY THE PAGE. By the generic call, as a read is, with two
// things said: that it is a pilot's (`pilot`), and that the page means it
// (`confirm`), which is what a route's confirmation was. The BFF makes it only
// for a write on its list of those the page makes itself
// (src/bridgeCallPolicy.js, PAGE_WRITE_PAIR_KEYS), under the checks every write
// of a held pilot's is under. `api.bridgeDo` is that asking.
//
// THE ROUTE STILL STANDS (src/server.js). Nothing of the page's asks it now.
//
// THE QUEUE SAVED, the second. Until 2026-10-10 every change of the queue was
// POST /api/bridge/skills/queue, which checked each entry's shape, saved, and
// answered the route's sheet. The client's queue service saves a queue with one
// call, on the skill handler (skillQueueSvc.CommitTransaction):
//
//   skillHandler.SaveNewQueue({place: (typeID, toLevel)}, activate=...)
//                                  skillQueueSvc.py 153: the whole queue, each entry by its place from
//                                  nought, and whether it is to be started. Recorded on Tranquility,
//                                  with the queue asked for again after it.
//
// What the service and its panel do around that call (the attributes read to
// reckon a started queue's times, the queue asked for afresh afterwards) is the
// transport's, which keeps what the client's services keep (src/gamePort/pilots.js,
// saveOnHandler). The page then reads its sheet as it reads it at any time.
//
// WHERE THE CALL IS NOT CARRIED, which is the web gateway (its list has skillMgr's
// save, a call of its own, and not the handler's), the call is refused with
// CALL_NOT_ALLOWED and nothing is saved: the flow then asks the route, which
// still stands for that.
//
// WHETHER A SAVE STARTS THE QUEUE is the caller's to say, as it is the client's
// queue service's and its panel's:
//
//   the panel's start button   True (skillQueuePanelNew.StartOrStopTraining, with nothing in training)
//   a change of the queue      True, and False where every training slot of the account is in use by its
//                              other characters (skillQueueSvc.OnClientQueueModified, 389, which every
//                              adding, removing and moving ends in; bridge/trainingSlots.ts reckons it)
//
// (A reading of the panel alone, on 2026-10-10, had a changed queue saved by
// whether a skill is in training. That is the panel's own save, at its closing,
// which finds nothing changed: the service committed each change as it was made.)

// FREE POINTS PUT INTO A SKILL, the third. Until 2026-10-10 it was
// POST /api/bridge/skills/apply-free-points, which checked that the page had
// said `confirm` and made one call with the skill and the points it was sent.
// The client's counterpart is a skill's own menu, "apply skill points"
// (skillQueueSvc.UseFreeSkillPoints, 926), offered where the character has free
// points and the skill is below its fifth level; it asks how many, offering what
// the skill wants for its next level, and then:
//
//   skillHandler.ApplyFreeSkillPoints(skillTypeID, pointsToApply)
//                                  skillsvc.py 886: on the handler, the skill and the points. It answers
//                                  the free points left. Not sent for a skill in training, one not known,
//                                  more points than are held, or none (skillsvc.py 870 to 884).
//
// The page's button is that menu's entry with the amount it offers (what the
// next level wants, or what is held if that is less: bridge/skills.ts,
// freeSkillPointsPlan, which also keeps the button from a skill in training).
// Either transport carries the call. The server judges it again whatever the
// page reckoned, and what it answers is the receipt.

import { failureCode, type Ask } from "./ask.ts";
import type { JsonValue } from "./wire.ts";

/** The queue panel's Pause: the skill in training stops, and the queue stays as it is. Fails as the call fails. */
export async function pauseTraining(act: Ask): Promise<void> {
  await act("skillHandler", "AbortTraining", []);
}

/**
 * Free points put into one skill. Answers what the handler answers, which is the free points left. Fails as the
 * call fails.
 */
export async function applyFreePoints(act: Ask, skillTypeID: number, points: number): Promise<JsonValue> {
  return act("skillHandler", "ApplyFreeSkillPoints", [skillTypeID, points]);
}

/** One place of a queue: a skill, and the level it is to be trained to. */
export interface QueuePlace {
  readonly typeID: number;
  readonly toLevel: number;
}

/**
 * The whole queue saved, in the order given; `activate` says whether the save is to start it. An empty list
 * empties the queue. The server judges the list as a whole and refuses all of it if any part is wrong.
 *
 * Answers whether the save was made: false where the pilot's transport does not carry the call, and then
 * nothing was saved. Fails as the call fails otherwise.
 */
export async function saveQueue(act: Ask, queue: readonly QueuePlace[], activate: boolean): Promise<boolean> {
  try {
    await act("skillHandler", "SaveNewQueue", [{ type: "dict", entries: queue.map((place, at) => [at, [place.typeID, place.toLevel]]) }], { activate });
  } catch (error) {
    if (failureCode(error) === "CALL_NOT_ALLOWED") return false;
    throw error;
  }
  return true;
}
