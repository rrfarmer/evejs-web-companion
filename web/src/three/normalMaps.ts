/**
 * The line after which the hull's detail and environment normals join the normal map's (hullModel.ts). It is kept by
 * every patch that adds after it, so that a hull with both layers gets both.
 */
export const HULL_NORMAL_MARKER = "mapN.z = 1.0; // quadv5: T x + B y + N, normalised (no z rebuilt from x and y)";

/** Expand the installed BC5 normal's two channels in the tangent frame. */
export function eveNormalMap(shader: string, flipGreen: boolean): string {
  return shader.replace("vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;",
    `vec3 mapN = vec3((texture2D(normalMap, vNormalMapUv).xy + 0.002) * 2.0 - 1.0, 1.0);
     ${flipGreen ? "mapN.y = -mapN.y;" : ""}
     ${HULL_NORMAL_MARKER}`);
}
