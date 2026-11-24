// uix.GetTechLevelIconPathAndHint (3698585): a type's meta group's icon (metaGroups.get_icon_id -> GetIconFile) and
// its name as the hint - 16 x 16 at the item entry's top left (GetTechLevelIcon). Tech I has no icon. Read from the
// live client (gridcheck g302).
const META_GROUP_ICONS: Readonly<Record<number, readonly [string, string]>> = {
  2: ["res:/UI/Texture/Icons/73_16_242.png", "Tech II"],
  3: ["res:/UI/Texture/Icons/73_16_245.png", "Storyline"],
  4: ["res:/UI/Texture/Icons/73_16_246.png", "Faction"],
  5: ["res:/UI/Texture/Icons/73_16_248.png", "Officer"],
  6: ["res:/UI/Texture/Icons/73_16_247.png", "Deadspace"],
  14: ["res:/UI/Texture/Icons/73_16_243.png", "Tech III"],
  15: ["res:/UI/Texture/Icons/ItemOverlay/abyssal.png", "Abyssal"],
  17: ["res:/UI/Texture/Icons/ItemOverlay/nes.png", "Premium"],
  19: ["res:/UI/Texture/Icons/ItemOverlay/timeLimited.png", "Limited Time"],
  52: ["res:/UI/Texture/Shared/structureOverlayFaction.png", "Structure Faction"],
  53: ["res:/UI/Texture/Shared/structureOverlayT2.png", "Structure Tech II"],
  54: ["res:/UI/Texture/Shared/structureOverlay.png", "Structure Tech I"],
};

/** The meta group's icon path and name, or null (Tech I, or no meta group). */
export function techLevelIcon(metaGroupID: number | null | undefined): { path: string; hint: string } | null {
  const hit = metaGroupID == null ? undefined : META_GROUP_ICONS[metaGroupID];
  return hit ? { path: hit[0], hint: hit[1] } : null;
}
