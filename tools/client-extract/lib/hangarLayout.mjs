// Low-detail modular hangar placements from SOF layouts. Keep the parent-relative transforms so the browser can
// place a ship at the same transform as its assembled dock.
export function hangarLayout(sof, graphic) {
  const names = graphic.sofLayout;
  if (!names?.some(name => /^upwell_(?:hangar|capitalhangar)/.test(name))) return null;
  const layouts = new Map(sof.data.layout.map(layout => [layout.name, layout]));
  const transforms = (hull, name) => sof.hulls.get(hull)?.locatorSets?.find(set => set.name === name)?.locators ?? [];
  const pose = ({ position, rotation, scaling }) => [position ?? [0, 0, 0], rotation ?? [0, 0, 0, 1], scaling ?? [1, 1, 1]];
  const parts = (hull, layoutNames) => layoutNames.flatMap(layoutName =>
    (layouts.get(layoutName)?.placements ?? []).flatMap(placement => {
      const { descriptor, distributionConditions, locatorSetName, name } = placement;
      if (!descriptor?.hull || distributionConditions?.some(condition =>
        condition.type !== "EveSOFDataHullExtensionPlacementDistributionMapGraphicSettings" || condition.displayFilter !== 0)) return [];
      const children = descriptor.layout ? parts(descriptor.hull, [descriptor.layout]) : [];
      return transforms(hull, locatorSetName).map(locator => ({
        name, hull: descriptor.hull, pose: pose(locator),
        ...(placement.isInstanced !== false && { background: true }),
        ...(children.length ? { children } : {}),
      }));
    }));
  const root = graphic.sofHullName;
  const capital = transforms(root, "ship_placement")[0];
  return { root, parts: parts(root, names), ...(capital ? { capital: pose(capital) } : {}) };
}
