// WHERE YOU WERE IN THE PLANNER — which saved plan was open, and which of its
// tree nodes you had unfolded. Browser-local on purpose: the plan itself lives
// on the server (app/piPlans.ts) because automation may read it; how you like
// to LOOK at it is this browser's business, and would only clutter that table.
//
// Tree nodes are kept by PlanNode.key — the typeIDs on the path from the target
// — which does not change when the stock under it does, so a plan reopened
// tomorrow unfolds the same branches.

export interface PiPlanView {
  /** The plan open when the window was last used, or null. */
  readonly openID: string | null;
  /** planID -> the tree keys unfolded in it. */
  readonly openNodes: Readonly<Record<string, readonly string[]>>;
}

export const EMPTY_PI_PLAN_VIEW: PiPlanView = Object.freeze({
  openID: null,
  openNodes: Object.freeze({}) as Readonly<Record<string, readonly string[]>>,
});

const STORAGE_VERSION = 1;
const STORAGE_KEY = `evejs-web-pi-plan-view:v${STORAGE_VERSION}`;
/** More keys than a PI chain has nodes; a cap against a runaway store. */
const MAX_KEYS_PER_PLAN = 200;

/** The slice of `Storage` this module needs; tests supply their own. */
export interface PiPlanViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function detectStorage(): PiPlanViewStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: PiPlanViewStorage | null }).localStorage;
    if (candidate && typeof candidate.getItem === "function" && typeof candidate.setItem === "function") {
      return candidate;
    }
  } catch {
    // Some privacy modes throw on touching localStorage — treat as unavailable.
  }
  return null;
}

let storage: PiPlanViewStorage | null = detectStorage();

/** Point this module at a different store (tests). Passing null disables it. */
export function setPiPlanViewStorage(next: PiPlanViewStorage | null): void {
  storage = next;
}

function keyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.length > 0 && !out.includes(entry)) out.push(entry);
    if (out.length >= MAX_KEYS_PER_PLAN) break;
  }
  return out;
}

export function loadPiPlanView(): PiPlanView {
  if (!storage) return EMPTY_PI_PLAN_VIEW;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_PI_PLAN_VIEW;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY_PI_PLAN_VIEW;
    const o = parsed as Record<string, unknown>;
    const openNodes: Record<string, string[]> = {};
    if (o.openNodes && typeof o.openNodes === "object" && !Array.isArray(o.openNodes)) {
      for (const [planID, keys] of Object.entries(o.openNodes as Record<string, unknown>)) {
        const list = keyList(keys);
        if (list.length > 0) openNodes[planID] = list;
      }
    }
    return {
      openID: typeof o.openID === "string" && o.openID.length > 0 ? o.openID : null,
      openNodes,
    };
  } catch {
    return EMPTY_PI_PLAN_VIEW;
  }
}

/** Best-effort: a full or blocked store is never fatal. */
export function savePiPlanView(view: PiPlanView): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
    // A quota or a privacy mode. The window keeps working on the in-memory copy.
  }
}

export function withOpenPlan(view: PiPlanView, planID: string | null): PiPlanView {
  return view.openID === planID ? view : { ...view, openID: planID };
}

/** Record the unfolded tree keys of one plan; an empty list forgets it. */
export function withOpenNodes(view: PiPlanView, planID: string, keys: readonly string[]): PiPlanView {
  const openNodes = { ...view.openNodes };
  const list = keyList(keys);
  if (list.length === 0) delete openNodes[planID];
  else openNodes[planID] = list;
  return { ...view, openNodes };
}

/**
 * Drop whatever belongs to plans that no longer exist — deleted here, or from
 * another browser. Called with the server's list, so it never guesses.
 */
export function prunePiPlanView(view: PiPlanView, planIDs: readonly string[]): PiPlanView {
  const alive = new Set(planIDs);
  const openNodes: Record<string, readonly string[]> = {};
  for (const [planID, keys] of Object.entries(view.openNodes)) {
    if (alive.has(planID)) openNodes[planID] = keys;
  }
  return {
    openID: view.openID !== null && alive.has(view.openID) ? view.openID : null,
    openNodes,
  };
}
