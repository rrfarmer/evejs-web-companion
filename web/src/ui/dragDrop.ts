// DRAG AND DROP (goal R78) — what may be dragged, and what a target accepts.
//
// The fitting window and the hangars already had every action they need as
// BUTTONS: pick an item, then press Fit, or tick some rows and press Move to.
// Dragging is faster and it is what a player coming from the retail client
// reaches for first — but it is an accelerator on top of those buttons, never a
// replacement, and nothing here removes one.
//
// ---------------------------------------------------------------------------
// WHY THE RULES LIVE HERE
//
// A drop target that decides what it accepts inside a `dragover` handler can
// only be checked by dragging something onto it, which is not a thing a test can
// do. Worse, `dragover` runs on every mouse move over the target, so a rule
// written there is also the rule that decides whether the cursor shows "you may
// drop this" — get it wrong and the UI promises a drop it will then refuse.
// Deciding as DATA means the cursor and the drop agree by construction.
//
// ---------------------------------------------------------------------------
// ⚠ THE PAYLOAD TRAVELS AS TEXT, AND MUST SURVIVE A HOSTILE ONE
//
// `DataTransfer` carries strings, and a drag can start anywhere — another tab,
// another application, a file. `decodeDrag` therefore treats its input as
// untrusted: anything that is not our own well-formed payload decodes to null,
// and a null is simply "not something we accept". It never throws, because a
// throw inside a `drop` handler leaves the UI in mid-drag with no way out.

import type { InventoryPlace } from "../store/types.ts";

/**
 * The MIME type our payload rides on.
 *
 * A custom type rather than `text/plain` on purpose: during `dragover` a browser
 * exposes only the TYPES of the data being dragged, not its contents, so this is
 * the only way a target can tell "one of ours" from a dragged file or a
 * selection of text BEFORE deciding whether to accept the drop.
 */
export const DRAG_MIME = "application/x-evejs-item";

/** Something being dragged out of an inventory container. */
export interface InventoryDrag {
  readonly kind: "inventoryItem";
  readonly itemID: number;
  readonly typeID: number;
  /** Selected items carried by an inventory drag into the fitting stage. Older drags carry only itemID. */
  readonly itemIDs?: readonly number[];
  /** Where it is being dragged FROM, so a drop onto its own home is a no-op. */
  readonly from: InventoryPlace;
}

/** A module being dragged off the active ship's fitting (fittingSlotController.GetModuleDragData). */
export interface FittedModuleDrag {
  readonly kind: "fittedModule";
  readonly itemID: number;
  readonly typeID: number;
}

/**
 * The charge loaded in a slot of the active ship, dragged off it (fittingSlotController.GetChargeDragNodes: a slot
 * with a charge drags the charge). By the module it is loaded in and the slot's flag, which is what the client's
 * UnloadAmmoToContainer goes by.
 */
export interface FittedChargeDrag {
  readonly kind: "fittedCharge";
  readonly moduleID: number;
  readonly flagID: number;
  readonly typeID: number;
}

export type DragPayload = InventoryDrag | FittedModuleDrag | FittedChargeDrag;

/** Serialise a payload for `dataTransfer.setData`. */
export function encodeDrag(payload: DragPayload): string {
  return JSON.stringify(payload);
}

function isPlace(value: unknown): value is InventoryPlace {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  switch (kind) {
    case "hangar":
    case "cargo":
      return true;
    case "shipBay":
      return typeof (value as { bay?: unknown }).bay === "string";
    case "container":
      return Number.isFinite((value as { itemID?: unknown }).itemID);
    case "corp":
      return Number.isFinite((value as { division?: unknown }).division);
    default:
      return false;
  }
}

/**
 * Read a payload back.
 *
 * ⚠ TOTAL AND NEVER THROWING. The string can come from anywhere — a dragged
 * file, another application, a different version of this app — so every shape
 * that is not exactly ours becomes `null`, which every caller reads as "not
 * something we accept". A throw here would abort a `drop` handler and leave the
 * page stuck mid-drag.
 */
export function decodeDrag(raw: string | null | undefined): DragPayload | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.kind === "fittedCharge") {
    return Number.isFinite(record.moduleID) && Number.isFinite(record.flagID) && Number.isFinite(record.typeID)
      ? { kind: "fittedCharge", moduleID: Number(record.moduleID), flagID: Number(record.flagID), typeID: Number(record.typeID) }
      : null;
  }
  if (!Number.isFinite(record.itemID) || !Number.isFinite(record.typeID)) {
    return null;
  }
  const itemID = Number(record.itemID);
  const typeID = Number(record.typeID);
  if (record.kind === "fittedModule") {
    return { kind: "fittedModule", itemID, typeID };
  }
  if (record.kind === "inventoryItem" && isPlace(record.from)) {
    const itemIDs = Array.isArray(record.itemIDs) ? record.itemIDs.filter((id): id is number => Number.isSafeInteger(id) && id > 0) : [];
    return { kind: "inventoryItem", itemID, typeID, from: record.from, ...(itemIDs.includes(itemID) ? { itemIDs } : {}) };
  }
  return null;
}

/** Are these the same container? */
export function samePlace(a: InventoryPlace, b: InventoryPlace): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "hangar":
    case "cargo":
      return true;
    case "shipBay":
      return a.bay === (b as typeof a).bay;
    case "container":
      return a.itemID === (b as typeof a).itemID;
    case "corp":
      return a.division === (b as typeof a).division;
  }
}

/**
 * A drop decision. `null` means "accept"; a sentence means refuse and SAY why.
 *
 * The same contract `rowActions` uses for its verbs, and for the same reason: a
 * target that silently ignores a drop leaves a player wondering whether they
 * missed, and one that accepts a drop the server will refuse is worse.
 */
export type DropVerdict = string | null;

/**
 * Can this payload be fitted into a slot? The real ship's slots take a module
 * or a charge off another slot (the fitting slot's OnDropData: grouped or moved,
 * loaded); a simulation's do not, its slots taking what comes from the hangar.
 */
export function dropOnSocketVerdict(payload: DragPayload | null, simulating = false): DropVerdict {
  if (payload === null) {
    return "That is not something you can fit.";
  }
  if (simulating && payload.kind === "fittedModule") {
    return "Take it off the ship first, then fit it to the new slot.";
  }
  if (simulating && payload.kind === "fittedCharge") {
    return "Unload it first, then load it into the other module.";
  }
  return null;
}

/**
 * Can this payload be dropped into a container?
 *
 * `to` is the container under the pointer. A fitted module or charge dropped
 * into one is taken off the ship into it, which the caller performs; an
 * inventory item is a move.
 */
export function dropOnPlaceVerdict(
  payload: DragPayload | null,
  to: InventoryPlace,
): DropVerdict {
  if (payload === null) {
    return "That is not something you can put there.";
  }
  if (payload.kind === "fittedModule" || payload.kind === "fittedCharge") {
    // Each container takes it as its controller does (invControllers BaseInvContainer.AddItems 505 to 517:
    // UnloadModuleToContainer, UnloadAmmoToContainer with its own arguments and flag): the cargo and the ship's other
    // holds, the hangar, a container, the corporation's hangar (its office and its division's flag, the pilot asked
    // first).
    return null;
  }
  if (samePlace(payload.from, to)) {
    // Not an error — just nothing to do. Refusing WITH a reason keeps the
    // cursor honest instead of inviting a drop that would be a no-op.
    return "It is already there.";
  }
  return null;
}

/**
 * Does this drag event carry one of our payloads?
 *
 * Used in `dragover`, where the CONTENTS are unreadable but the types are not.
 * A drag of a file or a text selection answers false and the target simply does
 * not light up.
 */
export function carriesOurPayload(types: readonly string[] | undefined): boolean {
  return Array.isArray(types) ? types.includes(DRAG_MIME) : false;
}
