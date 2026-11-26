import { Mesh, type Object3D } from "three";
import { getShipTreeCatalogue, type ApiOptions } from "../app/api.ts";
import { coatingFits, shipSkinrCoatingID, shipSkinrCoatingMaterials, shipSkinrCoatingSlot, shipSkinrLayoutSlots } from "../bridge/shipSkinrCoatings.ts";
import type { ShipSkinrApplication } from "../bridge/shipSkinrCollection.ts";
import type { ShipSkinrDesign } from "../bridge/shipSkinr.ts";
import { SKINR_HULL_RULES } from "../bridge/shipSkinrHullRules.ts";
import { loadShipSkinrProjector, shipSkinrBlendMode, shipSkinrPatternPreview, shipSkinrPatternSlot,
  type ShipSkinrBlendMode, type ShipSkinrPatternPreview } from "../bridge/shipSkinrPatterns.ts";
import type { ShipSkinrSequenceComponent } from "../bridge/shipSkinrSequencing.ts";
import type { JsonValue } from "../bridge/wire.ts";
import { loadSofMaterials, paintedTypeModel, type SofArea } from "./hullModel.ts";

export async function shipSkinrPreviewModel(typeID: number, coatings: readonly (string | null)[],
  patterns: readonly ShipSkinrPatternPreview[], blendMode: ShipSkinrBlendMode, darkhullChannel?: number, cleared = false) {
  const needsMaterials = coatings.some(Boolean) || patterns.some(pattern => pattern.material);
  const materials: Awaited<ReturnType<typeof loadSofMaterials>> = needsMaterials ? await loadSofMaterials() : {};
  const overrides = coatings.map(name => name ? materials[name] ?? null : null);
  if (coatings.some((name, index) => name && !overrides[index])) return null;
  const patternMaterials = patterns.map(pattern => pattern.material ? materials[pattern.material] ?? null : null);
  return paintedTypeModel(typeID, overrides, skinrCoatingArea, patterns.length ? {
    layers: patterns.map(pattern => pattern.layer),
    pmtl1: patternMaterials[0] ?? null, pmtl2: patternMaterials[1] ?? null, blendMode,
  } : undefined, darkhullChannel === undefined ? undefined : { channel: darkhullChannel, cleared });
}

let hullCatalogue: ReturnType<typeof getShipTreeCatalogue> | undefined;
function readHullCatalogue(options?: ApiOptions) {
  return hullCatalogue ??= getShipTreeCatalogue(options).catch(error => { hullCatalogue = undefined; throw error; });
}

export async function shipSkinrPreviewPaint(typeID: number, layout: ShipSkinrDesign["layout"], options?: ApiOptions) {
  const [hulls, { SHIP_SKINR_COATINGS }, { SHIP_SKINR_PATTERNS }] = await Promise.all([
    readHullCatalogue(options),
    import("../bridge/shipSkinrCoatingsData.ts"), import("../bridge/shipSkinrPatternsData.ts"),
  ]);
  const factionID = hulls?.ships.find(row => row.typeID === typeID)?.factionID ?? null;
  const areas = SHIP_SKINR_COATINGS.areas[factionID ?? 0] ?? SHIP_SKINR_COATINGS.areas[500003] ?? [];
  const slots = shipSkinrLayoutSlots(layout);
  const coatings = new Map(SHIP_SKINR_COATINGS.components.map(row => [row.id, row]));
  const patterns = new Map(SHIP_SKINR_PATTERNS.components.map(row => [row.id, row]));
  const fitted = new Map([...slots].flatMap(([slot, row]) => {
    const coating = coatings.get(shipSkinrCoatingID(row) ?? 0);
    return coating ? [[slot, coating] as const] : [];
  }));
  return { factionID, coatings: shipSkinrCoatingMaterials(areas, fitted),
    patterns: shipSkinrPatternPreview(slots, patterns, coatings, areas),
    blendMode: shipSkinrBlendMode(layout.pattern_blend_mode), darkhullChannel: areas[3] ?? undefined };
}

export async function shipSkinrElementPreviewDesign(activeType: number | null, raceID: number, element: ShipSkinrSequenceComponent,
  options?: ApiOptions): Promise<Pick<ShipSkinrDesign, "shipTypeID" | "layout"> | null> {
  const [hulls, { SHIP_SKINR_COATINGS }] = await Promise.all([readHullCatalogue(options), import("../bridge/shipSkinrCoatingsData.ts")]);
  const skinnable = activeType !== null && !SKINR_HULL_RULES.excluded.includes(activeType) &&
    hulls?.ships.some(row => row.typeID === activeType && !row.academy);
  const shipTypeID = skinnable ? activeType : SKINR_HULL_RULES.fallbackByRace[raceID];
  if (!shipTypeID) return null;
  const configuration = SHIP_SKINR_COATINGS.configurations.find(row => row.allHulls || row.hulls.includes(shipTypeID));
  if (!configuration) return null;
  let slots: JsonValue[];
  if (element.kind === "pattern") {
    const { SHIP_SKINR_PATTERNS } = await import("../bridge/shipSkinrPatternsData.ts");
    const pattern = SHIP_SKINR_PATTERNS.components.find(row => row.id === element.id);
    if (!pattern || !configuration.slots.includes(5) || !configuration.slots.includes(6) || pattern.disallowed.includes(5)) return null;
    const projector = await loadShipSkinrProjector(shipTypeID, SHIP_SKINR_PATTERNS.scales);
    if (!projector) return null;
    // The native component showcase fits this green coating in the pattern's material slot.
    slots = [shipSkinrPatternSlot(5, pattern, projector), shipSkinrCoatingSlot(6, 220)];
  } else {
    const coating = SHIP_SKINR_COATINGS.components.find(row => row.id === element.id);
    if (!coating) return null;
    slots = SHIP_SKINR_COATINGS.slots.filter(slot => slot.id <= 4 && configuration.slots.includes(slot.id) && coatingFits(slot, coating))
      .map(slot => shipSkinrCoatingSlot(slot.id, coating.id));
  }
  return slots.length ? { shipTypeID, layout: { ship_type: { sequential: shipTypeID }, slots } } : null;
}

export async function appliedShipSkinrModel(typeID: number, skin: ShipSkinrApplication, options?: ApiOptions): Promise<Object3D | null> {
  const paint = await shipSkinrPreviewPaint(typeID, skin.layout, options);
  return shipSkinrPreviewModel(typeID, paint.coatings, paint.patterns, paint.blendMode, paint.darkhullChannel);
}

function skinrCoatingArea(area: SofArea): boolean {
  const shader = area.shader?.toLowerCase().replace(/^skinned_/, "quad/skinned_") ?? "";
  return area.kind === "opaque" && (["Primary", "SimplePrimary", "Reactor", "Ornament"].includes(area.areaType) ||
    (area.name.includes("area_hull") && ["quad/quaddetailv5.fx", "quad/quadv5.fx", "quad/skinned_quadheatv5.fx",
      "quad/skinned_quaddetailv5.fx"].includes(shader)));
}

export function disposeShipSkinrMaterials(model: Object3D): void {
  model.traverse(object => {
    if (object instanceof Mesh && object.userData.ownMaterial && !Array.isArray(object.material)) object.material.dispose();
  });
}
