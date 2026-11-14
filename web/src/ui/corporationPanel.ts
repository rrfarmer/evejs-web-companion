// A panel of the Corporation window asked for from outside it (corpui.Show(panel): the window opened on that panel),
// as the Agency's Corp card asks for the recruitment search (CorpContentGroup.CallExternalFunc, CorpPanel.
// RECRUITMENT_SEARCH) and its Factional Warfare guide for the NPC standings (EnlistmentPanel.OpenCorpStandings,
// CorpPanel.NPC_STANDINGS). The window takes the panel as it mounts and while it is open; the one asking opens the
// window itself.

import { createSignal, readonlySignal, type ReadableSignal } from "../store/signals.ts";

/** The window's panels another window asks for (CorporationWindow's own names for them). */
export type CorporationPanelRequest = "recruitSearch" | "npc";

export interface CorporationPanelTarget {
  /** How many times a panel has been asked for. */
  readonly requests: ReadableSignal<number>;
  ask(panel: CorporationPanelRequest): void;
  /** The panel asked for and not yet taken by the window, which takes it; null where there is none. */
  take(): CorporationPanelRequest | null;
}

export function createCorporationPanelTarget(): CorporationPanelTarget {
  const requests = createSignal(0);
  let pending: CorporationPanelRequest | null = null;
  return {
    requests: readonlySignal(requests),
    ask(panel) {
      pending = panel;
      requests.update((count) => count + 1);
    },
    take() {
      const taken = pending;
      pending = null;
      return taken;
    },
  };
}

export const corporationPanelTarget: CorporationPanelTarget = createCorporationPanelTarget();
