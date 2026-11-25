import { LINK_DRAG_TYPE } from "../bridge/skillPlanLink.ts";
import { startLinkDrag } from "./linkFollowers.ts";

const ACCESS_GROUP_DRAG_TYPE = "application/x-evejs-access-group";

export function startAccessGroupDrag(event: DragEvent, groupID: number, name: string): void {
  event.dataTransfer?.setData(ACCESS_GROUP_DRAG_TYPE, String(groupID));
  startLinkDrag(event, `accessGroup:${groupID}`, name);
}

export function hasAccessGroupDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.some(type => type === ACCESS_GROUP_DRAG_TYPE || type === LINK_DRAG_TYPE) ?? false;
}

export function droppedAccessGroup(event: DragEvent): number | null {
  const validID = (raw: string): number | null => {
    const id = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const direct = event.dataTransfer?.getData(ACCESS_GROUP_DRAG_TYPE);
  if (direct) return validID(direct);
  const link = event.dataTransfer?.getData(LINK_DRAG_TYPE);
  if (!link) return null;
  try {
    const payload = JSON.parse(link) as { url?: unknown } | null;
    const match = typeof payload?.url === "string" ? /^accessGroup:(\d+)$/i.exec(payload.url) : null;
    return match ? validID(match[1]!) : null;
  } catch {
    return null;
  }
}
