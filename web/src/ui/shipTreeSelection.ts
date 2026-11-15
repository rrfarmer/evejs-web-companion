import type { AppFlow } from "../app/flow.ts";
import { createSignal } from "../store/signals.ts";

// The Academy action can retarget an existing window. Keep that selection with
// the pilot's flow so it does not follow the operator to another cockpit.
const selections = new WeakMap<AppFlow, ReturnType<typeof createSignal<number | null>>>();

export function shipTreeSelection(flow: AppFlow) {
  const existing = selections.get(flow);
  if (existing) return existing;
  const selection = createSignal<number | null>(null);
  selections.set(flow, selection);
  return selection;
}
