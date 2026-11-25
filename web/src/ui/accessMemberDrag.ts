import { LINK_DRAG_TYPE } from "../bridge/skillPlanLink.ts";
import { CHARACTER_TYPES, linkScheme, parseShowInfoUrl } from "../bridge/showInfoLink.ts";
import { CHARACTER_DRAG_MIME, droppedCharacter } from "./characterDrag.ts";
import { itemLinksFromDrop, startItemLinksDrag } from "./linkFollowers.ts";

const CHARACTER = 1373;
const CORPORATION = 2;
const ALLIANCE = 16159;
const ACCESS_MEMBER_DRAG = "application/x-evejs-access-members";

export function accessOwnerLinkType(typeID: number): number | null {
  if (CHARACTER_TYPES.has(typeID)) return CHARACTER;
  return typeID === CORPORATION || typeID === ALLIANCE ? typeID : null;
}

export function startAccessMemberDrag(event: DragEvent,
    members: readonly { id: number; typeID: number; name: string; membershipType?: number }[]): void {
  const copiedRoles: [number, number][] = [];
  startItemLinksDrag(event, members.flatMap(({ id, typeID, name, membershipType }) => {
    const type = accessOwnerLinkType(typeID);
    if (id <= 0 || type === null) return [];
    if (membershipType !== undefined) copiedRoles.push([id, membershipType]);
    return [{ url: `showinfo:${type}//${id}`, text: name }];
  }));
  if (copiedRoles.length) event.dataTransfer?.setData(ACCESS_MEMBER_DRAG, JSON.stringify(copiedRoles));
}

function ownerID(url: string): number | null {
  if (linkScheme(url) !== "showinfo") return null;
  const item = parseShowInfoUrl(url);
  return item?.itemID && item.itemID > 0 && [CHARACTER, CORPORATION, ALLIANCE].includes(item.typeID) ? item.itemID : null;
}

export function hasAccessMemberDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return !!types && (types.includes(CHARACTER_DRAG_MIME) || types.includes(LINK_DRAG_TYPE));
}

export function droppedAccessMembers(event: DragEvent): number[] {
  const character = droppedCharacter(event);
  if (character !== null) return [character];
  const raw = event.dataTransfer?.getData(LINK_DRAG_TYPE);
  if (!raw) return [];
  try {
    const payload: unknown = JSON.parse(raw);
    if (Array.isArray(payload)) {
      return [...new Set(itemLinksFromDrop(payload).flatMap(item => {
        const id = ownerID(item.url);
        return id === null ? [] : [id];
      }))];
    }
    if (payload && typeof payload === "object" && "url" in payload && typeof payload.url === "string") {
      const id = ownerID(payload.url);
      if (id !== null) return [id];
    }
  } catch {
    return [];
  }
  return [];
}

export function accessMembershipsFromDrop(event: DragEvent, copyRoles: boolean): [number, number][] {
  const ids = droppedAccessMembers(event);
  const roles = new Map<number, number>();
  const raw = copyRoles ? event.dataTransfer?.getData(ACCESS_MEMBER_DRAG) : "";
  if (raw) {
    try {
      const pairs: unknown = JSON.parse(raw);
      if (Array.isArray(pairs)) {
        for (const pair of pairs) {
          if (Array.isArray(pair) && pair.length === 2 && Number.isSafeInteger(pair[0]) &&
              Number.isInteger(pair[1]) && pair[1] >= 0 && pair[1] <= 3) roles.set(pair[0], pair[1]);
        }
      }
    } catch {
      // The owner links still carry their IDs without access roles.
    }
  }
  return ids.map(id => [id, roles.get(id) ?? 0]);
}
