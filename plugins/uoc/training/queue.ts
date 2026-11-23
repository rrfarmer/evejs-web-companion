import type { TrainingQueue, TrainingSheet } from "../restored/training/types.ts";

export type ClearQueue = { clearQueue: { active: boolean; entries: [number, number][] } };

const positive = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0;
const entry = (row: unknown): row is [number, number] =>
  Array.isArray(row) && row.length === 2 && positive(row[0]) && positive(row[1]) && row[1] <= 5;

export function clearQueueSetup(value: unknown): ClearQueue | null {
  const setup = value as ClearQueue | null;
  const expected = setup?.clearQueue;
  if (!setup || !expected || Object.keys(setup).length !== 1 || typeof expected.active !== "boolean" ||
      !Array.isArray(expected.entries) || !expected.entries.length || !expected.entries.every(entry)) return null;
  return { clearQueue: { active: expected.active, entries: expected.entries } };
}

export function queueIdentity(queue: TrainingQueue): ClearQueue["clearQueue"] {
  return { active: queue.active, entries: queue.entries.map(e => [e.typeID, e.toLevel]) };
}

export function skillSheetInspection(value: unknown) {
  const setup = value as { skillSheetOnly?: unknown; skillReview?: unknown } | null;
  if (setup?.skillSheetOnly !== true || Object.keys(setup).some(key => !["skillSheetOnly", "skillReview"].includes(key)) ||
      setup.skillReview !== undefined && setup.skillReview !== "queue" && setup.skillReview !== "purchase") return null;
  return setup;
}

/** The independent skill Review is checked against the pilot held for Apply. */
export function skillReviewKey(
  corporationID: number, targets: readonly {typeID:number;toLevel:number}[],
  sheet: Pick<TrainingSheet, "skills" | "queue">, bookCostCents: number,
): string {
  const learned = new Map(sheet.skills.map(skill => [skill.typeID, skill.level]));
  const levels = new Map<number, number>();
  for (const target of targets) levels.set(target.typeID, Math.max(levels.get(target.typeID) ?? 0, target.toLevel));
  const requirements = [...levels].map(([id, level]) => [id, level, learned.get(id) ?? null]);
  return JSON.stringify([corporationID, requirements, queueIdentity(sheet.queue), sheet.queue.maxEntries, bookCostCents]);
}

/** Save the native empty queue once. A lost response only permits readback. */
export async function clearNativeQueue(
  expected: ClearQueue["clearQueue"],
  read: () => Promise<TrainingSheet>,
  save: () => Promise<TrainingSheet>,
): Promise<TrainingSheet> {
  const before = await read();
  if (!before.queue.entries.length && !before.queue.active) return before;
  if (JSON.stringify(queueIdentity(before.queue)) !== JSON.stringify(expected))
    throw Error("The native queue changed. Refresh it before clearing.");
  let after: TrainingSheet;
  try {
    after = await save();
  } catch (error) {
    const observed = await read().catch(() => null);
    if (!observed || observed.queue.entries.length || observed.queue.active) throw error;
    after = observed;
  }
  if (after.queue.entries.length || after.queue.active)
    throw Error("Native readback did not confirm an empty, stopped queue. Refresh it before another change.");
  return after;
}

export function currentTrainingRequirements<T extends {typeID:number;level:number;currentLevel:number;bookMissing:boolean}>(
  requirements: readonly T[], sheet: TrainingSheet | null,
): readonly (T & { queuedLevel?: number; reviewState?: string })[] {
  if (!sheet) return requirements;
  const learned = new Map(sheet.skills.map(s => [s.typeID, s.level]));
  const queued = new Map<number, number>();
  for (const entry of sheet.queue.entries) queued.set(entry.typeID, Math.max(queued.get(entry.typeID) ?? 0, entry.toLevel));
  const active = sheet.queue.active ? sheet.queue.entries[0] : undefined;
  return requirements.map(r => {
    const currentLevel = learned.get(r.typeID) ?? 0, queuedLevel = queued.get(r.typeID) ?? 0;
    const reviewState = currentLevel >= r.level ? "TRAINED" : queuedLevel < r.level ? "MISSING"
      : active?.typeID === r.typeID && active.toLevel >= r.level ? "TRAINING" : "ALREADY_QUEUED";
    return { ...r, currentLevel, queuedLevel, bookMissing: !learned.has(r.typeID), reviewState };
  });
}

export function trainingQueueProof(sheet: TrainingSheet) {
  return { characterID: sheet.characterID, queue: sheet.queue, trained: sheet.skills.map(s => [s.typeID, s.level]) };
}

/** The hosted report carries native values without repeating keys for each row. */
export function compactTrainingInspection(sheet: Omit<TrainingSheet, "skills" | "queue"> & {
  skills: readonly {typeID:number;level:number;skillPoints?:number}[];
  queue: TrainingQueue & {reckonedEndMs?:number|null};
}) {
  const {entries, ...queue} = sheet.queue;
  return {
    skillRows: sheet.skills.map(s => s.skillPoints === undefined ? [s.typeID, s.level] : [s.typeID, s.level, s.skillPoints]),
    queue: {...queue, rows: entries.map(e => [e.typeID, e.toLevel, e.startTimeMs ?? null, e.endTimeMs ?? null])},
  };
}

export function expandTrainingInspection(report: Record<string, any>) {
  if (!Object.hasOwn(report, "skillRows")) return report; // Cockpit and already-ended hosted reports.
  const skills = report.skillRows, queue = report.queue;
  const date = (v:unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);
  if (!Array.isArray(skills) || !skills.every(s => Array.isArray(s) && (s.length === 2 || s.length === 3) &&
      positive(s[0]) && Number.isInteger(s[1]) && s[1] >= 0 && s[1] <= 5 &&
      (s.length === 2 || (Number.isFinite(s[2]) && s[2] >= 0))) ||
      new Set(skills.map(s => s[0])).size !== skills.length ||
      typeof queue?.active !== "boolean" || !positive(queue.maxEntries) ||
      !Array.isArray(queue.rows) || !queue.rows.every((r:unknown) => Array.isArray(r) && r.length === 4 &&
        entry(r.slice(0, 2)) && date(r[2]) && date(r[3]))) throw Error("The compact native training sheet or queue is unreadable.");
  const {rows, ...state} = queue;
  const {skillRows: _rows, ...readout} = report;
  return {
    ...readout,
    skills: skills.map(([typeID, level, skillPoints]) => ({typeID, level, ...(skillPoints === undefined ? {} : {skillPoints})})),
    queue: {...state, entries: rows.map(([typeID, toLevel, startTimeMs, endTimeMs]: number[]) => ({typeID, toLevel, startTimeMs, endTimeMs}))},
  };
}

export function trainingSheetFromProof(proof: unknown, characterID: number): TrainingSheet | null {
  const r = proof as { characterID: number; queue: TrainingQueue; trained: [number, number][] } | null;
  if (r?.characterID !== characterID || typeof r.queue?.active !== "boolean" ||
      !positive(r.queue.maxEntries) || !Array.isArray(r.queue.entries) ||
      !r.queue.entries.every(e => positive(e?.typeID) && positive(e?.toLevel) && e.toLevel <= 5) ||
      !Array.isArray(r.trained) || !r.trained.every(s => Array.isArray(s) && s.length === 2 &&
        positive(s[0]) && Number.isInteger(s[1]) && s[1] >= 0 && s[1] <= 5)) return null;
  return { characterID, queue: r.queue, skills: r.trained.map(([typeID, level]) => ({ typeID, level })) };
}
