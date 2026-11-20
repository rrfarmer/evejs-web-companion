import type { Colony, ColonyPin } from "../store/types.ts";
import { isStorage } from "./colonyRoutes.ts";
import type { PlanetRouteFacts } from "./planetRouting.ts";
import type { PiRecipeBook } from "./piRecipes.ts";

export type TransferCargo = Readonly<Record<number, number>>;

export function canReceiveExpeditedTransfer(pin: ColonyPin): boolean {
  return isStorage(pin) || (pin.kind === "factory" && pin.schematicID !== null);
}

/** Use the full capacity of the smallest link, as BaseColony.ValidateExpeditedTransfer does. */
export function quoteExpeditedTransfer(colony: Colony, recipes: PiRecipeBook, facts: PlanetRouteFacts,
  path: readonly number[], cargo: TransferCargo) {
  const limits = new Map<number, number>();
  const problem = (error: string) => ({ error, limits, bandwidth: 0, volume: 0, cooldownMs: 0 });
  const pins = new Map(colony.pins.map(pin => [pin.pinID, pin]));
  const source = pins.get(path[0]!), dest = pins.get(path.at(-1)!);
  if (!source || !dest || !isStorage(source) || !canReceiveExpeditedTransfer(dest)) {
    return problem("Select a linked storage installation or a configured processor.");
  }
  if (path.length < 2 || new Set(path).size !== path.length || path.some(pinID => !pins.has(pinID))) {
    return problem("The transfer path is no longer available.");
  }
  let bandwidth = Infinity;
  for (let index = 1; index < path.length; index++) {
    const from = path[index - 1], to = path[index];
    const link = colony.links.find(edge => (edge.endpoint1 === from && edge.endpoint2 === to)
      || (edge.endpoint1 === to && edge.endpoint2 === from));
    if (!link) return problem("A link on this path is missing.");
    bandwidth = Math.min(bandwidth, facts.baseLinkBandwidth * 2 ** link.level);
  }
  if (!Number.isFinite(bandwidth) || bandwidth <= 0) return problem("The transfer path has no available link capacity.");
  const storage = isStorage(dest);
  if (storage && (dest.usedM3 === null || dest.capacityM3 === null)) {
    return problem("The destination's storage capacity is unavailable.");
  }
  const room = storage ? Math.max(0, dest.capacityM3! - dest.usedM3!) : 0;
  const inputs = dest.schematicID === null ? [] : recipes.bySchematicID.get(dest.schematicID)?.inputs ?? [];
  const stock = new Map(source.contents.map(item => [item.typeID, item.quantity]));
  let volume = 0;
  for (const [key, quantity] of Object.entries(cargo)) {
    const typeID = Number(key), unit = facts.commodityVolumes[typeID];
    if (String(typeID) !== key || !Number.isSafeInteger(typeID) || typeID < 1 || !Number.isSafeInteger(quantity) || quantity < 1) {
      return problem("Enter whole, positive quantities to transfer.");
    }
    if (unit == null || !Number.isFinite(unit) || unit <= 0) return problem("A commodity's volume is unavailable.");
    volume += quantity * unit;
  }
  for (const [typeID, quantity] of stock) {
    const unit = facts.commodityVolumes[typeID];
    if (unit == null || !Number.isFinite(unit) || unit <= 0) continue;
    const held = dest.contents.find(item => item.typeID === typeID)?.quantity ?? 0;
    const wanted = inputs.find(item => item.typeID === typeID)?.quantity ?? 0;
    const limit = storage ? Math.floor((room - volume + (cargo[typeID] ?? 0) * unit + 1e-9) / unit) : wanted - held;
    limits.set(typeID, Math.max(0, Math.min(quantity, limit)));
  }
  const overCapacity = Object.entries(cargo).some(([key, quantity]) => quantity > (limits.get(Number(key)) ?? 0));
  return { error: overCapacity ? "Check the quantities against source stock and destination capacity." : "",
    limits, bandwidth, volume, cooldownMs: Math.ceil(Math.max(300_000, volume / bandwidth * 3_600_000) * 10_000) / 10_000 };
}

export function expeditedTimeWords(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", seconds % 60 ? `${seconds % 60}s` : ""].filter(Boolean).join(" ") || "0s";
}
