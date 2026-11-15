export const SHIP_INFO_FAR_CLIP = 400_000;

/** ShipInfoPreviewSceneContainer._get_zoom_range_for_model and SetZoomRange. */
export function shipInfoZoomRange(radius: number, axes: readonly [number, number, number]): [number, number] {
  const [long, middle, short] = [...axes].sort((a, b) => b - a) as [number, number, number];
  const ratio = (long / Math.max(middle, 0.01) + long / Math.max(short, 0.01)) / 2;
  const [near, far] = ratio >= 1.5 ? [1.6, 3.5] : ratio >= 1.35 ? [1.8, 3.5] : [2.1, 4.5];
  const min = near! * radius;
  return [min, Math.max(min, Math.min(far! * radius, SHIP_INFO_FAR_CLIP - 2 * radius))];
}
