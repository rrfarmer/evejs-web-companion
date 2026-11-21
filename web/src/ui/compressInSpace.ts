// Compressing ore in space as the 3698585 client's CompressInSpaceController does it (itemcompression/client/ui/
// compress_in_space_controller.py, inSpaceCompression.GetFacilitiesInRange): shared by the inventory window's Compress
// entry and the CmdCompressAllOreInCurrentship command.
//   facility: the pilot's own ship where it runs a compressor (at any range), else a fleet member's ship whose
//     compressor reaches this one (surface distance within the facility's range)
//   CompressItems: each item compressed at it; FailureToCompressSome / FailureToCompressAny where any was not
// (The facility's type lists are not turned into types here: the server refuses an ore its lists do not take, and that
// counts as not compressed.)
import type { ClientStore } from "../store/clientStore.ts";
import type { AppFlow } from "../app/flow.ts";
import { authoritativeFleetMemberCharacterIDs } from "../bridge/fleetCenter.ts";
import { compressionFacilities } from "../space/compression.ts";

let compressible: Promise<ReadonlySet<number>> | null = null;
/** itemcompression.is_compressible_type: the client's compressibleTypes (compressibleTypes.json). */
export function compressibleTypes(): Promise<ReadonlySet<number>> {
  compressible ??= fetch("/client-assets/compressibleTypes.json").then((r) => (r.ok ? r.json() : null))
    .then((j: { pairs?: [number, number][] } | null) => new Set((j?.pairs ?? []).map((p) => p[0])) as ReadonlySet<number>)
    .catch(() => { compressible = null; return new Set<number>(); });
  return compressible;
}

/** HARVESTABLE_ORE_HOLDS: the general mining hold and the asteroid, ice and gas holds (the page's hold keys). */
export const HARVESTABLE_ORE_HOLDS = ["ore", "asteroid", "ice", "gas"] as const;

/** CompressItems for these items, with the client's words where any was not compressed. */
export async function compressItemsInSpace(store: ClientStore, flow: AppFlow, items: readonly { itemID: number }[],
  word: (label: string, own: string) => string): Promise<void> {
  const snap = store.space.get().snapshot;
  const fleet = store.fleet.get();
  const members = new Set(fleet.availability === "ready" && fleet.fleet
    ? authoritativeFleetMemberCharacterIDs({ availability: "ready", fleet: fleet.fleet }) ?? [] : []);
  const me = snap?.ship ?? null;
  const surface = (e: { position: { x: number; y: number; z: number }; radius?: number }) => (me
    ? Math.max(0, Math.hypot(e.position.x - me.position.x, e.position.y - me.position.y, e.position.z - me.position.z) - (e.radius ?? 0) - (me.radius ?? 0))
    : Infinity);
  const facility = compressionFacilities(snap).find((f) => f.itemID === me?.itemID
    || (f.characterID != null && members.has(f.characterID) && surface(f) <= (f.compressionFacility?.rangeMeters ?? 0))) ?? null;
  let some = false, failed = false;
  for (const item of items) {
    if (!facility) { failed = true; continue; }
    try { if (await flow.compressItemAt(item.itemID, facility.itemID)) some = true; else failed = true; } catch { failed = true; }
  }
  if (failed) {
    const text = some
      ? word("UI/Compression/FailureToCompressSome", "Some items could not be compressed.")
      : word("UI/Compression/FailureToCompressAny", "No compression facility in range could compress those items.");
    flow.sayDialog("CustomNotify", { type: "dict", entries: [["notify", text]] }, text);
  }
  await flow.loadMiningHolds().catch(() => {});
}
