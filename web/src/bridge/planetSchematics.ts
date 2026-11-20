import type { Colony, ColonyPin, ColonyRoute } from "../store/types.ts";
import type { PiRecipeBook, PiSchematic } from "./piRecipes.ts";
import { validateRouteRemovals } from "./planetRouting.ts";
import { planetPinRef, routeEditCommands } from "./planetWrites.ts";
import type { JsonValue } from "./wire.ts";

export interface SchematicEdit {
  readonly pinID: number;
  readonly previousSchematicID: number | null;
  readonly recipe: PiSchematic;
  readonly removedRoutes: readonly ColonyRoute[];
}

export function processorSchematics(pin: ColonyPin, recipes: PiRecipeBook): readonly PiSchematic[] {
  if (pin.kind !== "factory") return [];
  const tierOf = (schematic: PiSchematic) => recipes.commodities.get(schematic.output.typeID)?.tier ?? Infinity;
  return recipes.schematics.filter(schematic => schematic.factoryTypeIDs.includes(pin.typeID))
    .sort((a, b) => tierOf(a) - tierOf(b) || a.name.localeCompare(b.name));
}

/** ColonyData.GetObsoleteRoutesForPin only checks routes starting or ending at the processor. */
export function schematicObsoletesRoute(pinID: number, recipe: PiSchematic, route: {
  readonly path: readonly number[];
  readonly commodityTypeID: number;
}): boolean {
  return (route.path[0] === pinID && route.commodityTypeID !== recipe.output.typeID)
    || (route.path.at(-1) === pinID && !recipe.inputs.some(input => input.typeID === route.commodityTypeID));
}

/** ProcessPin.SetSchematic keeps the compatible inputs up to the new per-cycle demands. */
export function schematicBuffer(pin: ColonyPin, recipe: PiSchematic) {
  const retained: ColonyPin["contents"][number][] = [];
  const discarded: ColonyPin["contents"][number][] = [];
  for (const item of pin.contents) {
    const quantity = Math.min(item.quantity, recipe.inputs.find(input => input.typeID === item.typeID)?.quantity ?? 0);
    if (quantity > 0) retained.push({ ...item, quantity });
    if (quantity < item.quantity) discarded.push({ ...item, quantity: item.quantity - quantity });
  }
  return { retained, discarded };
}

export function applySchematicEdit(colony: Colony, { pinID, recipe }: SchematicEdit): Colony {
  return {
    ...colony,
    pins: colony.pins.map(pin => {
      if (pin.pinID !== pinID) return pin;
      const { retained, discarded } = schematicBuffer(pin, recipe);
      return { ...pin, schematicID: recipe.schematicID, schematicName: recipe.name, contents: retained,
        usedM3: discarded.length ? null : pin.usedM3, active: false };
    }),
    routes: colony.routes.filter(route => !schematicObsoletesRoute(pinID, recipe, route)),
  };
}

export function schematicInstallCommand(pinID: number, schematicID: number): JsonValue {
  return [8, [planetPinRef(pinID), schematicID]];
}

export function planSchematicEdit(colony: Colony, edit: SchematicEdit, recipes: PiRecipeBook) {
  const pin = colony.pins.find(pin => pin.pinID === edit.pinID);
  if (!pin || pin.kind !== "factory" || pin.schematicID !== edit.previousSchematicID) {
    throw new Error("The processor or its installed schematic changed. Review it before installing a schematic.");
  }
  const recipe = recipes.bySchematicID.get(edit.recipe.schematicID);
  if (!recipe?.factoryTypeIDs.includes(pin.typeID)) throw new Error("This processor cannot use the selected schematic.");
  const obsolete = colony.routes.filter(route => schematicObsoletesRoute(pin.pinID, recipe, route));
  if (obsolete.length !== edit.removedRoutes.length) throw new Error("The processor's routes changed. Review which routes will be removed.");
  validateRouteRemovals({ ...colony, routes: obsolete }, edit.removedRoutes);
  // ClientPlanet.OnSchematicInstalled removes obsolete routes before command 8 is added.
  const commands = [...routeEditCommands(obsolete.map(route => route.routeID), []), schematicInstallCommand(pin.pinID, recipe.schematicID)];
  return { colony: applySchematicEdit(colony, { ...edit, recipe }), commands };
}
