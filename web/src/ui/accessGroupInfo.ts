import { createSignal, readonlySignal } from "../store/signals.ts";

export function parseAccessGroupUrl(url: string): number | null {
  const match = /^accessGroup:(\d+)$/i.exec(url);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

const request = createSignal<{ source: object; groupID: number } | null>(null);
export const accessGroupInfoRequests = readonlySignal(request);

export function showAccessGroupInfo(source: object, groupID: number): void {
  if (Number.isSafeInteger(groupID) && groupID > 0) request.set({ source, groupID });
}
