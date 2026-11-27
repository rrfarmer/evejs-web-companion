"use strict";

// The pilot's skills as the retail client's two skill services keep them
// (eve/client/script/ui/services/skillsvc.py and skillQueueSvc.py).
//
// The client asks its skill handler for each of these once, when something
// first wants it, and keeps the answer:
//
//   GetSkills()                    self.myskills, by type
//   GetAllSkills()                 self.mySkillsIncludingLapsed, by type
//   GetSkillQueueAndFreePoints()   the queue, and the free points where there
//                                  are any (skillQueueSvc.PrimeSkillQueue)
//   GetBoosters()  GetImplants()  GetAttributes()
//   GetSkillHistory(maxresults)    whatever the first asker asked for
//   GetFreeSkillPoints()  GetRespecInfo()
//
// and from then on keeps them right from what the server tells it:
//
//   OnServerSkillsChanged(skillInfos, event, timeStamp)
//   OnServerSkillsRemoved(skillInfos, timeStamp)
//       each skill put into both lists, or taken out of both, unless the one
//       kept is newer; the history forgotten; a queued level that is now
//       trained taken out of the queue. `event` is scattered in the client by
//       its name, and "OnSkillQueuePausedServer" is how a server says the
//       queue has stopped.
//   OnNewSkillQueueSaved(queue)    the queue, replaced
//   OnSkillQueuePausedServer()     no entry of the queue has a start or an end
//   OnFreeSkillPointsChanged(points)
//   OnServerBoostersChanged, OnServerImplantsChanged, OnCloneDestruction,
//   OnJumpCloneTransitionCompleted, OnRespecInfoChanged
//       the boosters, the implants and the attributes are read again, at once
//       (GetCharacterAttributes(True)): `feed` answers "attributes" for whoever
//       can ask
//   OnSkillForcedRefresh           everything the skill service keeps is
//                                  forgotten, its handler with it: "reset"
//
// A skill to be taken out that is not in the list is a KeyError in the client's
// handler: nothing after it in the notice is done, the history is not
// forgotten and the queue is left alone. The same here.
//
// A change that comes before both lists have been read changes nothing here.
// The client reads them at that moment and then makes the change; here they
// are read when they are next wanted, and the server's answer then has it.
//
// The client finds a queued level by a table of positions it makes from its
// queue and does not always make again when the server replaces the queue.
// Here the level is found in the queue as it is kept.
//
// Everything is kept as it came off the wire, so what is read back is in the
// form the server answers in.

const QUEUE_PAUSED = "OnSkillQueuePausedServer";
/** The notices after which the client reads its boosters, implants and attributes again (skillsvc.py). */
const ATTRIBUTES_AGAIN = new Set(["OnServerBoostersChanged", "OnServerImplantsChanged", "OnCloneDestruction", "OnJumpCloneTransitionCompleted", "OnRespecInfoChanged"]);

const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : typeof value === "string" ? value : null);
const number = (value) => (typeof value === "bigint" ? Number(value) : typeof value === "number" && Number.isFinite(value) ? value : null);
const items = (value) => (Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : []);
const isDict = (value) => Boolean(value && value.type === "dict" && Array.isArray(value.entries));
const isKeyVal = (value) => Boolean(value && value.type === "object" && isDict(value.args));

/** A CharacterSkillEntry's own arguments: (typeID, trainedSkillLevel, trainedSkillPoints, skillRank, virtualSkillLevel). Null where it is none. */
const skillFields = (entry) => (entry && Array.isArray(entry.header) && Array.isArray(entry.header[1]) ? entry.header[1] : null);
/** One field of a queue entry (a KeyVal), or undefined. */
const queueField = (entry, name) => (isKeyVal(entry) ? (entry.args.entries.find(([key]) => text(key) === name) ?? [])[1] : undefined);

/**
 * skillQueueSvc.SkillInTraining: the type of the queue's first entry, where that entry has an end. Null with an
 * empty queue, a stopped one, or none. `queue` is the queue as it is read back here: a list of entries.
 */
function skillInTraining(queue) {
  const head = queue && Array.isArray(queue.items) ? queue.items[0] : undefined;
  return queueField(head, "trainingEndTime") ? number(queueField(head, "trainingTypeID")) : null;
}

function createPilotSkills() {
  /** skillsvc's myskills and mySkillsIncludingLapsed: typeID -> { entry, timeStamp }, or null where not read. */
  let skills = null;
  let allSkills = null;
  /** skillQueueSvc's skillQueue: the entries, or null where not read. */
  let queue = null;
  /** What else is kept, by name, each as it was answered: boosters, implants, attributes, history, freeSkillPoints, respecInfo. */
  const kept = new Map();

  /** skillsvc.Reset: all it keeps. The queue is the queue service's, and stays. */
  function reset() {
    skills = null;
    allSkills = null;
    kept.clear();
  }

  const byType = (answer) => (isDict(answer) ? new Map(answer.entries.map(([typeID, entry]) => [number(typeID), { key: typeID, entry, timeStamp: 0n }])) : null);
  const asAnswered = (list) => ({ type: "dict", entries: [...list.values()].map(({ key, entry }) => [key, entry]) });

  /** skillsvc._UpdateMySkillsAndReturnLevelsTrained. False where the client's handler fails. */
  function update(skillInfos, timeStamp) {
    for (const [typeID, entry] of skillInfos.entries) {
      const type = number(typeID);
      const fields = skillFields(entry);
      // Something that is no skill entry has no points to ask after: the client's handler fails at it.
      if (!fields) return false;
      const [, , points, , virtualLevel] = fields;
      const lapsed = number(points) === null || number(points) < 0;
      if (lapsed && number(virtualLevel) === null) {
        if (!skills.delete(type) || !allSkills.delete(type)) return false;
        continue;
      }
      const current = allSkills.get(type);
      if (current && current.timeStamp > timeStamp) continue;
      // A skill held by its virtual level alone is kept as a copy with no level or points of its own
      // (GetCopyWithNewSkillPoints(None)): a new entry, with nothing but what an entry is made from.
      const held = lapsed ? { ...entry, header: [entry.header[0], [fields[0], null, null, fields[3], fields[4]]] } : entry;
      skills.set(type, { key: typeID, entry: held, timeStamp });
      allSkills.set(type, { key: typeID, entry: held, timeStamp });
    }
    return true;
  }

  /** skillQueueSvc.OnServerSkillsChanged: an entry of the queue for a level that is now the skill's trained level is taken out. */
  function dropTrained(skillInfos) {
    if (!queue) return;
    for (const [typeID, entry] of skillInfos.entries) {
      const type = number(typeID);
      const level = number((skillFields(entry) ?? [])[1]);
      // The client goes on for a skill it does not have at a level of none, which no entry of a queue is for.
      if (!skills.has(type)) continue;
      const at = queue.findIndex((queued) => number(queueField(queued, "trainingTypeID")) === type && number(queueField(queued, "trainingToLevel")) === level);
      if (at !== -1) queue.splice(at, 1);
    }
  }

  /** skillQueueSvc.OnSkillQueuePausedServer. */
  function pause() {
    if (!queue) return;
    queue = queue.map((entry) => (isKeyVal(entry)
      ? { ...entry, args: { ...entry.args, entries: entry.args.entries.map(([key, value]) => (["trainingStartTime", "trainingEndTime"].includes(text(key)) ? [key, null] : [key, value])) } }
      : entry));
  }

  /** OnServerSkillsChanged and OnServerSkillsRemoved, which differ in where the time is and in the event the first names. */
  function skillsChanged(skillInfos, event, timeStamp) {
    if (!skills || !allSkills || !isDict(skillInfos)) return;
    if (!update(skillInfos, typeof timeStamp === "bigint" ? timeStamp : BigInt(Math.trunc(number(timeStamp) ?? 0)))) return;
    kept.delete("history");
    dropTrained(skillInfos);
    if (text(event) === QUEUE_PAUSED) pause();
  }

  /** One notice: null, or what the client then does that only the transport can ("attributes", "reset"). */
  function apply(method, args) {
    if (method === "OnServerSkillsChanged") skillsChanged(args[0], args[1], args[2]);
    else if (method === "OnServerSkillsRemoved") skillsChanged(args[0], null, args[1]);
    else if (method === "OnNewSkillQueueSaved") queue = [...items(args[0])];
    else if (method === QUEUE_PAUSED) pause();
    else if (method === "OnFreeSkillPointsChanged") kept.set("freeSkillPoints", args[0]);
    else if (method === "OnSkillForcedRefresh") {
      reset();
      return "reset";
    } else if (ATTRIBUTES_AGAIN.has(method)) {
      if (method === "OnRespecInfoChanged") kept.delete("respecInfo");
      kept.delete("attributes");
      return "attributes";
    }
    return null;
  }

  return {
    /** A character gone from the session: both services keep nothing. */
    clear() {
      reset();
      queue = null;
    },
    /** What a read answered, to be kept. Something that is not the kind of answer the read gives is not kept. */
    keep(name, answer) {
      if (name === "skills") skills = byType(answer) ?? skills;
      else if (name === "allSkills") allSkills = byType(answer) ?? allSkills;
      else if (name === "queue") {
        // PrimeSkillQueue: (the queue, the free points), and the free points kept only where there are some.
        const [entries, freeSkillPoints] = items(answer);
        if (!entries || !Array.isArray(entries.items)) return;
        queue = [...entries.items];
        if (number(freeSkillPoints) > 0) kept.set("freeSkillPoints", freeSkillPoints);
      } else if (answer !== undefined) kept.set(name, answer);
    },
    /** Whether something is kept: "skills", "allSkills", "queue", or one of the others by its name. */
    has: (name) => (name === "skills" ? skills !== null : name === "allSkills" ? allSkills !== null : name === "queue" ? queue !== null : kept.has(name)),
    /** What is kept, as the read that fills it would answer now; the queue as its entries alone. Undefined with none kept. */
    read(name) {
      if (name === "skills") return skills ? asAnswered(skills) : undefined;
      if (name === "allSkills") return allSkills ? asAnswered(allSkills) : undefined;
      if (name === "queue") return queue ? { type: "list", items: [...queue] } : undefined;
      return kept.get(name);
    },
    /**
     * skillsvc.MyEffectiveSkillLevelsByID().get(typeID, 0): a skill's level in effect, the larger of the level
     * trained and the level lent (CharacterSkillEntry.effectiveSkillLevel). Nought for a skill the pilot has
     * not; null where no skills are kept.
     */
    effectiveLevel(typeID) {
      if (!skills) return null;
      const fields = skills.has(typeID) ? skillFields(skills.get(typeID).entry) : null;
      return fields ? Math.max(number(fields[1]) ?? 0, number(fields[4]) ?? 0) : 0;
    },
    /** The type in training by the queue as it is kept, or null (skillInTraining). */
    inTraining: () => skillInTraining(queue ? { items: queue } : null),
    /** The server pushes a notification: what the transport is then to do, each thing once. */
    feed(notification) {
      const args = Array.isArray(notification.args) ? notification.args : [];
      const events = notification.method === "__MultiEvent"
        ? args.map((event) => [text(items(event)[0]), items(items(event)[1])])
        : [[notification.method, args]];
      return [...new Set(events.map(([method, given]) => apply(method, given)).filter((next) => next !== null))];
    },
  };
}

module.exports = { createPilotSkills, skillInTraining };
