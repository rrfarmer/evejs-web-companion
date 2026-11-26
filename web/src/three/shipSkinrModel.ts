import { Mesh, type Object3D } from "three";
import { getShipTreeCatalogue, type ApiOptions } from "../app/api.ts";
import { shipSkinrCoatingID, shipSkinrCoatingMaterials, shipSkinrLayoutSlots } from "../bridge/shipSkinrCoatings.ts";
import type { ShipSkinrApplication } from "../bridge/shipSkinrCollection.ts";
import { shipSkinrBlendMode, shipSkinrPatternPreview, type ShipSkinrBlendMode, type ShipSkinrPatternPreview } from "../bridge/shipSkinrPatterns.ts";
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
export async function appliedShipSkinrModel(typeID: number, skin: ShipSkinrApplication, options?: ApiOptions): Promise<Object3D | null> {
  const [hulls, { SHIP_SKINR_COATINGS }, { SHIP_SKINR_PATTERNS }] = await Promise.all([
    hullCatalogue ??= getShipTreeCatalogue(options).catch(error => { hullCatalogue = undefined; throw error; }),
    import("../bridge/shipSkinrCoatingsData.ts"), import("../bridge/shipSkinrPatternsData.ts"),
  ]);
  const factionID = hulls?.ships.find(row => row.typeID === typeID)?.factionID ?? 0;
  const areas = SHIP_SKINR_COATINGS.areas[factionID] ?? SHIP_SKINR_COATINGS.areas[500003] ?? [];
  const slots = shipSkinrLayoutSlots(skin.layout);
  const coatings = new Map(SHIP_SKINR_COATINGS.components.map(row => [row.id, row]));
  const patterns = new Map(SHIP_SKINR_PATTERNS.components.map(row => [row.id, row]));
  const fitted = new Map([...slots].flatMap(([slot, row]) => {
    const coating = coatings.get(shipSkinrCoatingID(row) ?? 0);
    return coating ? [[slot, coating] as const] : [];
  }));
  return shipSkinrPreviewModel(typeID, shipSkinrCoatingMaterials(areas, fitted),
    shipSkinrPatternPreview(slots, patterns, coatings, areas), shipSkinrBlendMode(skin.layout.pattern_blend_mode), areas[3] ?? undefined);
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
