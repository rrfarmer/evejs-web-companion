import type { AchievementDefinition, AchievementProgress } from "../bridge/achievements.ts";
import { createSignal, readonlySignal } from "../store/signals.ts";

export const TRACKED_ACHIEVEMENT_LIMIT = 5;
export const achievementMilestone = (achievement: AchievementDefinition, progress?: AchievementProgress) =>
  (progress?.completed ? undefined : achievement.milestones.find(row => row.target > (progress?.current ?? 0))) ?? achievement.milestones.at(-1);

interface Tracking {
  readonly ids: readonly string[];
  readonly expanded: string | null;
}

type LocalSettings = Pick<Storage, "getItem" | "setItem">;

/** The activity repository's ordered tracked list and the info panel's expanded row are pilot UI settings. */
export function createAchievementTracking(characterID: number | null, storage?: LocalSettings) {
  const key = `evejs.play.${characterID}.trackedAchievements`;
  let initial: Tracking = { ids: [], expanded: null };
  if (characterID) try {
    const raw = JSON.parse(storage?.getItem(key) ?? "null");
    if (Array.isArray(raw?.ids)) {
      const ids = [...new Set<string>(raw.ids.filter((id: unknown) => typeof id === "string"))].slice(0, TRACKED_ACHIEVEMENT_LIMIT);
      initial = { ids, expanded: ids.includes(raw.expanded) ? raw.expanded : null };
    }
  } catch { /* optional storage */ }
  const state = createSignal(initial);
  function save(next: Tracking) {
    try { storage?.setItem(key, JSON.stringify(next)); } catch { /* the session keeps it */ }
    state.set(next);
  }
  return {
    state: readonlySignal(state),
    track(id: string): boolean {
      const { ids } = state.get();
      if (!characterID || ids.length >= TRACKED_ACHIEVEMENT_LIMIT || ids.includes(id)) return false;
      save({ ids: [...ids, id], expanded: id });
      return true;
    },
    untrack(id: string): void {
      const { ids, expanded } = state.get();
      if (ids.includes(id)) save({ ids: ids.filter(item => item !== id), expanded: expanded === id ? null : expanded });
    },
    toggleExpanded(id: string): void {
      const { ids, expanded } = state.get();
      if (ids.includes(id)) save({ ids, expanded: expanded === id ? null : id });
    },
  };
}

const emptyTracking = createAchievementTracking(null);
const pilots = new Map<number, ReturnType<typeof createAchievementTracking>>();
export function achievementTrackingFor(characterID: number | null) {
  if (characterID === null) return emptyTracking;
  let tracking = pilots.get(characterID);
  if (!tracking) {
    let storage: LocalSettings | undefined;
    try { storage = globalThis.localStorage; } catch { /* optional storage */ }
    tracking = createAchievementTracking(characterID, storage);
    pilots.set(characterID, tracking);
  }
  return tracking;
}
