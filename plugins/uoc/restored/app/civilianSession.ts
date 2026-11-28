// WC74 @ 213da333; plugin-owned frontend helper.
import type { ServerBot } from "./api.ts";
import { miningMissionTitle } from "../nav/miningMissionCatalog.ts";

export interface CivilianSession {
  control: string;
  workers: string[];
}
type SessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = "uoc:restored:civilian-accounts:v1";
const nameOf = (value: unknown): string | null => {
  const name = typeof value === "string" ? value : (value as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name : null;
};

export function civilianSessionStore(storage: () => SessionStorage | null) {
  let memory: CivilianSession | null = null;
  return {
    load(): CivilianSession | null {
      try {
        const session = storage(),
          value = session?.getItem(key);
        if (!value) return memory;
        const saved = JSON.parse(value);
        const control = nameOf(saved?.control);
        if (!control || !Array.isArray(saved.workers)) return null;
        const workers = saved.workers
          .map(nameOf)
          .filter((name: string | null): name is string => name !== null);
        memory = { control, workers };
        if (
          typeof saved.control !== "string" ||
          saved.workers.some((worker: unknown) => typeof worker !== "string")
        )
          session?.setItem(key, JSON.stringify(memory));
        return memory;
      } catch {
        return memory;
      }
    },
    save(value: CivilianSession | null) {
      memory = value;
      try {
        if (value) storage()?.setItem(key, JSON.stringify(value));
        else storage()?.removeItem(key);
      } catch {
        /* The current tab still has its in-memory scope. */
      }
    },
  };
}
export const civilianSession = civilianSessionStore(() => globalThis.sessionStorage ?? null);
export function civilianScope(control: string, saved: CivilianSession | null) {
  return {
    control,
    workers: saved?.control === control ? saved.workers.filter((worker) => worker !== control) : [],
  };
}

export function civilianWorkerGroups<
  T extends {
    kind: string;
    scriptName: string;
    endedAt: string | null;
    startedAt?: string;
    civilianView?: "CURRENT" | "HISTORY" | "RECOVERY";
    missionIssue?: { state: string } | null;
  },
>(bots: readonly T[]) {
  const groups: Record<"CURRENT" | "HISTORY" | "RECOVERY", T[]> = {
    CURRENT: [],
    HISTORY: [],
    RECOVERY: [],
  };
  for (const bot of bots) {
    if (
      (bot.kind !== "script" && bot.kind !== "plugin") ||
      (!bot.civilianView && !/^Civilian (Mining|Distribution) · /.test(bot.scriptName))
    )
      continue;
    const group =
      bot.civilianView ??
      (bot.missionIssue?.state === "RECOVERY_REQUIRED"
        ? "RECOVERY"
        : bot.endedAt === null
          ? "CURRENT"
          : "HISTORY");
    groups[group].push(bot);
  }
  groups.HISTORY.sort((a, b) =>
    (b.endedAt ?? b.startedAt ?? "").localeCompare(a.endedAt ?? a.startedAt ?? ""),
  );
  return groups;
}

export function civilianMissionName(
  bot: Pick<ServerBot, "scriptName" | "characterID" | "missionProgress" | "lastMissionReward">,
  history: boolean,
): string | null {
  if (bot.missionProgress?.missionName) return bot.missionProgress.missionName;
  const reward = bot.lastMissionReward;
  if (
    !history ||
    !bot.scriptName.startsWith("Civilian Mining · ") ||
    !reward ||
    reward.characterID !== bot.characterID
  )
    return null;
  // Older released runs saved the exact completion key but left the title empty.
  try {
    const key: unknown = JSON.parse(reward.missionKey);
    if (
      Array.isArray(key) &&
      key.length === 4 &&
      key[0] === reward.agentID &&
      Number.isSafeInteger(key[1])
    )
      return miningMissionTitle(key[1]);
  } catch {
    /* Unreadable historical keys do not identify a mission. */
  }
  return null;
}

/** A running or accepted mission belongs to the pilot even when the saved profile changes. */
export function currentCivilianWorker<T extends { bot: ServerBot }>(
  workers: readonly T[],
): T | undefined {
  const byRecency = [...workers].sort((a, b) =>
    (b.bot.endedAt ?? b.bot.startedAt).localeCompare(a.bot.endedAt ?? a.bot.startedAt),
  );
  return (
    byRecency.find((worker) => !worker.bot.endedAt) ??
    byRecency.find((worker) => worker.bot.hasAcceptedMission) ??
    byRecency[0]
  );
}
