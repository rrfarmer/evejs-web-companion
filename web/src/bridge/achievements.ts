// The BFF projects these fields from the 24.02 ACHV catalogue; the public
// gateway reports live character progress separately.
export interface AchievementReward {
  readonly id: string;
  readonly kind: "ISK" | "SP" | "item" | "title" | null;
  readonly description: number;
  readonly omega: boolean;
  readonly amount: number | null;
  readonly typeID: number | null;
  readonly titleID: string | null;
}

export interface AchievementMilestone {
  readonly id: string;
  readonly target: number;
  readonly points?: number;
  readonly rewards: readonly AchievementReward[];
}

export interface AchievementCategory {
  readonly id: string;
  readonly parent: string | null;
  readonly name: number;
  readonly description: number;
  readonly icon: string;
  readonly style: string;
  readonly featured: number;
  readonly categories: readonly string[];
  readonly achievements: readonly string[];
  readonly milestones: readonly AchievementMilestone[];
}

export interface AchievementDefinition {
  readonly id: string;
  readonly category: string;
  readonly name: number;
  readonly description: number;
  readonly flavor: number;
  readonly icon: string;
  readonly milestones: readonly AchievementMilestone[];
  readonly releasedAt: number;
  readonly expiresAt: number;
  readonly archived: boolean;
  readonly visibility: number;
  readonly featured: boolean;
}

export interface AchievementCatalogue {
  readonly roots: Readonly<{ career: string; challenges: string; timeLimited?: string; manual?: string }>;
  readonly categories: readonly AchievementCategory[];
  readonly achievements: readonly AchievementDefinition[];
}

export interface AchievementProgress {
  readonly current: number;
  readonly completed: boolean;
}

export interface UnclaimedAchievementReward {
  readonly kind: "achievement" | "category";
  readonly source: string;
  readonly milestone: string;
  readonly rewards: readonly string[];
}
