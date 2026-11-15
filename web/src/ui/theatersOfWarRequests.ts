import type { TheatersPage } from "../bridge/militiaEnlistment.ts";
import { createSignal, readonlySignal } from "../store/signals.ts";

const request = createSignal<{ readonly page: TheatersPage } | null>(null);
export const theatersOfWarRequests = readonlySignal(request);

export function openTheatersOfWar(page: TheatersPage): void {
  request.set({ page });
}

export function serveTheatersOfWarRequest(served: { readonly page: TheatersPage }): void {
  if (request.get() === served) request.set(null);
}
