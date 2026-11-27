import type { AppFlow } from "../app/flow.ts";
import { PLEX_TYPE_ID } from "../bridge/plexVault.ts";
import type { InventoryPlace, InventoryState } from "../store/types.ts";
import { carriesOurPayload, decodeDrag, DRAG_MIME } from "./dragDrop.ts";

type DepositSource = "hangar" | "cargo" | Extract<InventoryPlace, { kind: "container" }>;
type ContainerAccess = Pick<AppFlow, "canDepositContainerPlex">;

export function plexDepositSource(place: InventoryPlace, inventory: InventoryState, flow: ContainerAccess): DepositSource | null {
  if (place.kind === "hangar" || place.kind === "cargo") return place.kind;
  if (place.kind === "container" && inventory.container?.itemID === place.itemID && flow.canDepositContainerPlex(place.itemID)) return place;
  return null;
}

export function acceptPlexVaultDrag(event: DragEvent): void {
  if (!event.dataTransfer || !carriesOurPayload(event.dataTransfer.types)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

export function readPlexVaultDrop(event: DragEvent, inventory: InventoryState, flow: ContainerAccess) {
  const payload = decodeDrag(event.dataTransfer?.getData(DRAG_MIME));
  if (payload?.kind !== "inventoryItem") return null;
  event.preventDefault();
  const source = plexDepositSource(payload.from, inventory, flow);
  if (source === null) return null;
  const dragged = new Set([payload.itemID, ...(payload.itemIDs ?? [])]);
  const rows = typeof source === "string" ? inventory[source].rows : inventory.container?.rows ?? [];
  const stacks = rows.filter(row => row.typeID === PLEX_TYPE_ID && dragged.has(row.itemID));
  return stacks.length ? { source, stacks } : null;
}
