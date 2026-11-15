// A new skill plan asked for from outside the Skills window (skillBtns.CreateSkillPlanButton: cmd.OpenSkillsWindow
// with a skillPlanTemplate): the Skills window opened, its personal plans shown and a new plan begun in the editor
// with the template applied (SkillPlanPanel.OnCreateNewPersonalSkillPlanWithTemplate); or, where the pilot has as many
// personal plans as may be had, the personal plans shown alone.
//
// Watched by the workspace, which opens the Skills window, and by its personal plans panel, which takes the request.
// The workspace watches the request counter, as the market details' request is watched (marketDetails.ts).

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";
import { MAX_PERSONAL_PLANS } from "../bridge/skillPlans.ts";

/** A list of levels, optionally with the Academy fit's hull milestone, or a type's needs. */
export type SkillPlanTemplate =
  | { readonly kind: "list"; readonly requirements: readonly (readonly [number, number])[]; readonly name: string | null; readonly milestoneTypeID?: number }
  | { readonly kind: "type"; readonly typeID: number };

export interface SkillPlanTemplateTarget {
  /** How many times a plan has been asked for. */
  readonly requests: ReadableSignal<number>;
  /** A plan asked for: with a template, or none (the personal plans shown, no plan begun). */
  ask(template: SkillPlanTemplate | null): void;
  /** The request not yet taken by the personal plans panel, which takes it; null where there is none. */
  take(): { readonly template: SkillPlanTemplate | null } | null;
}

export function createSkillPlanTemplateTarget(): SkillPlanTemplateTarget {
  const requests = createSignal(0);
  let pending: { readonly template: SkillPlanTemplate | null } | null = null;
  return {
    requests: readonlySignal(requests),
    ask(template) {
      pending = { template };
      requests.update((count) => count + 1);
    },
    take() {
      const taken = pending;
      pending = null;
      return taken;
    },
  };
}

export const skillPlanTemplateTarget: SkillPlanTemplateTarget = createSkillPlanTemplateTarget();

/** eveicon.skill_plan: the Create Skill Plan button's icon. */
export const SKILL_PLAN_ICON = "res:/UI/Texture/eveicon/system_icons/skill_plan_16px.png";

/**
 * CreateSkillPlanButton: its hint (SkillPlanButtonTooltip, MaximumSkillPlanReached under it where the pilot has as
 * many personal plans as may be had: _CanCreatePlan), and its click: the Skills window with the template, or with the
 * personal plans shown and none (the template let go) where no more may be made. `planCount` is the personal plans'
 * count where read.
 */
export function createSkillPlanButton(
  template: SkillPlanTemplate,
  planCount: number | null,
  word: (label: string, args?: Readonly<Record<string, string | number>>) => string,
): { readonly hint: string; readonly use: () => void } {
  const full = planCount !== null && planCount >= MAX_PERSONAL_PLANS;
  return {
    hint: skillPlanButtonHint(planCount, word),
    use: () => skillPlanTemplateTarget.ask(full ? null : template),
  };
}

export function skillPlanButtonHint(planCount: number | null, word: Parameters<typeof createSkillPlanButton>[2]): string {
  const hint = word("Tooltips/SkillPlanner/SkillPlanButtonTooltip");
  return planCount !== null && planCount >= MAX_PERSONAL_PLANS
    ? `${hint}\n\n${word("UI/SkillPlan/MaximumSkillPlanReached", { numPlans: planCount })}`
    : hint;
}
